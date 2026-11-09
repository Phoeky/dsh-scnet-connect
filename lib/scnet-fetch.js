/**
 * 上游错误归一化
 * ------------------------------------------------------------------
 * 目的：让 SCNet 的「瞬时路由抖动」能被 DSH 的重试策略接住。
 *
 * 问题形状
 * --------
 * SCNet 网关在推理实例被回收/切换时会返回：
 *
 *   HTTP 503
 *   {"error":{"message":"The model's routing or availability changed while
 *    processing the request. Please try again.","type":"invalid_request_error",
 *    "code":"10008"}}
 *
 * 即：**状态码是 5xx，但响应体里的 `type` 写的是 `invalid_request_error`**。
 *
 * DSH 侧的错误归类（`dsh-llm-pi-ai` 的 `classifyPiAiError`）按正则顺序扫描
 * 错误文本，`invalid.?request` 那条规则排在 `5xx → SERVER` **前面**：
 *
 *   /\b400\b|invalid.?request/i  → INVALID_REQUEST   ← 先命中
 *   /\b5\d\d\b/                  → SERVER            ← 永远轮不到
 *
 * 而 `INVALID_REQUEST` 不在默认可重试集合
 * （`[EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]`）里，
 * 于是 DSH 把一次本可自愈的抖动判成本轮失败，一次都不重试。
 *
 * 做法
 * ----
 * 在 provider 的 fetch 上包一层：**只**针对「状态码 >= 500 且 body.type 是
 * `invalid_request_error`」的响应，把 `type` 改写成 `api_error`（保持状态码与
 * message 不变），让归类落到 `SERVER`，交给 DSH 的指数退避重试。
 *
 * 刻意**不**碰的：
 *   - 真正的 400（如 `10013` 参数非法）——那确实不该重试；
 *   - 401/403/402/429 —— 各自有明确语义，改写会误导上层；
 *   - 2xx 响应 —— 原样透传，连 body 都不读，不影响流式。
 */

/** 会被改写的上游错误码（`code` 字段是字符串）。 */
export const RETRYABLE_UPSTREAM_CODES = Object.freeze(['10008', '10009']);

/**
 * 判断一个上游错误是否应当被归一化成可重试的 `SERVER`。
 *
 * @param {number} status HTTP 状态码
 * @param {any} body 已解析的响应体（可能不是 JSON）
 * @returns {boolean}
 */
export function shouldNormalizeUpstreamError(status, body) {
  if (!(status >= 500)) return false;
  const error = body?.error;
  if (!error || typeof error !== 'object') return false;
  // 只处理「5xx 却自称 invalid_request」这种自相矛盾的形状。
  if (error.type !== 'invalid_request_error') return false;
  // 有 code 时只认已知的抖动码，避免把未知的 5xx 也一并改写。
  if (typeof error.code === 'string' && error.code.length > 0) {
    return RETRYABLE_UPSTREAM_CODES.includes(error.code);
  }
  return true;
}

/**
 * 把错误体改写成 `api_error`（其余字段原样保留）。
 *
 * 保留原始 `code` 与 `message`，只是把 `type` 换成 DSH 归类器认得的服务端错误，
 * 这样错误信息在 UI 上仍然可读、可搜。
 *
 * @param {any} body
 * @returns {any}
 */
export function normalizeUpstreamErrorBody(body) {
  return {
    ...body,
    error: { ...body.error, type: 'api_error' },
  };
}

/**
 * 构造一个「重试友好」的 fetch。
 *
 * 只在非 2xx 且命中 {@link shouldNormalizeUpstreamError} 时介入；其它情况原样
 * 返回原始 Response（不读取 body，流式响应不受影响）。
 *
 * @param {{ fetchImpl?: typeof fetch, onNormalize?: (info: { status: number, code?: string, message?: string }) => void }} [options]
 * @returns {typeof fetch}
 */
export function createRetryFriendlyFetch(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('dsh-scnet-connect: no fetch implementation available');
  }
  return async function retryFriendlyFetch(input, init) {
    const response = await fetchImpl(input, init);
    if (response.ok) return response;

    let raw;
    try {
      raw = await response.clone().text();
    } catch {
      return response;
    }

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      // 不是 JSON（例如 HTML 网关错误页）：保持原样，交给上层按状态码处理。
      return response;
    }

    if (!shouldNormalizeUpstreamError(response.status, body)) return response;

    const rewritten = normalizeUpstreamErrorBody(body);
    try {
      options.onNormalize?.({
        status: response.status,
        code: typeof body?.error?.code === 'string' ? body.error.code : undefined,
        message: typeof body?.error?.message === 'string' ? body.error.message : undefined,
      });
    } catch {
      // 日志回调失败不影响请求。
    }

    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.set('content-type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify(rewritten), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

/**
 * 用「重试友好」的 fetch 包一层 pi-ai 的 api 实现。
 *
 * pi-ai 的 `openai-completions` 会把 `options.fetch` 直接交给 OpenAI SDK
 * （`createClient(..., fetch, ...)`），因此在这里注入即可覆盖整条请求链，
 * 不需要改 DSH 或 pi-ai 本身。
 *
 * @param {{ stream: Function, streamSimple: Function }} api `openAICompletionsApi()` 的返回值
 * @param {typeof fetch} fetchImpl
 * @returns {{ stream: Function, streamSimple: Function }}
 */
export function withRetryFriendlyFetch(api, fetchImpl) {
  const withFetch = (options) => ({ ...options, fetch: fetchImpl });
  return {
    ...api,
    stream: (model, context, options) => api.stream(model, context, withFetch(options)),
    streamSimple: (model, context, options) => api.streamSimple(model, context, withFetch(options)),
  };
}
