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
 * 400 里「可能只是瞬时不稳」的参数错误码。
 *
 * 实测证据（2026-11-10，本机真实会话）：
 *   - 一次 agent 请求（prompt ≈494k、`reasoning_effort=max`、36 个工具）在 1ms 内
 *     被回 `400 ... "Invalid request parameters ... code:"10013""`；
 *   - 同一套参数在 5 分钟前、之后的每一步都成功；
 *   - 逐项探测（`max_tokens=131072`、`effort=max/xhigh/none`、大 prompt 直至
 *     ~500k、36 工具、10 次相同大请求重复）**全部 200**，无法复现。
 *
 * 结论：10013 并非总是「参数真错」，也会像 `503 + 10008` 那样被上游当作抖动
 * 的外衣。因此这里只做**一次性**自愈：同一次请求体第一次遇到 10013 时改写成
 * 可重试的 `api_error`，交给 DSH 退避重试；同一请求体第二次仍报 10013 则原样
 * 透传，让真正的参数错误立刻失败，不会拖成 5 次无用重试。
 */export const RETRY_ONCE_INVALID_PARAM_CODE = '10013';

/** 一次性改写的记忆窗口：同一请求体在这个时间窗内只自愈一次。 */
export const INVALID_PARAM_RETRY_WINDOW_MS = 10 * 60 * 1000;
/** 记忆表上限（防止长期运行时无界增长）。 */
export const INVALID_PARAM_MEMORY_LIMIT = 128;

/**
 * 单个 SSE 帧允许积压的最大字节数。
 *
 * 正常情况下帧以 `\n\n` 或 `\r\n\r\n` 结束，buffer 很快就会清空。这个上限是
 * 给「上游用了非标准分隔符」准备的逃生口：宁可把超长内容原样吐出去，也不让
 * 整个回答在内存里无限堆积。
 */
export const MAX_PENDING_FRAME_BYTES = 1024 * 1024;

/**
 * 找 buffer 里最早的 SSE 帧分隔符。
 *
 * @param {string} buffer
 * @returns {{ index: number, length: number } | undefined} `length` 是分隔符本身的长度
 */
function nextBoundary(buffer) {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1 && crlf === -1) return undefined;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

/**
 * 上游在**流中途**中断时，写在 SSE `error` 帧里的 message 特征。
 *
 *   data: {"error":{"message":"The response stream was interrupted.
 *          (request_id: bec198bdb37b73f0-20261110111508406)"}}
 *
 * 为什么会漏掉（与上面 5xx 那类不同，这条**根本到不了**我们的 fetch 包装）：
 *   1. OpenAI SDK 读到该帧 → 抛 `APIError(undefined, data.error)`；
 *   2. pi-ai 的 catch 把 `formatProviderError(normalizeProviderError(error))`
 *      写进 `errorMessage`，得到上面那句原文；
 *   3. DSH 的 `classifyPiAiError` 对这句原文**一条正则都不命中**
 *      （没有状态码、没有 timeout、没有 connection/socket…），落到兜底
 *      `PI_AI_ERROR`——**不在默认可重试集合**里。
 *
 * 对比：如果上游直接掐断连接（不发 error 帧），pi-ai 抛
 *   "Stream ended without finish_reason"
 * 这句命中 `/stream ended (?:before|without)\b/i` → `TRANSPORT` → **会重试**。
 *
 * 也就是说：同一个偶发中断，因为上游多送了一句「友好」的说明，
 * 就从「自动退避重试 5 次」变成「本轮直接失败」。实测该中断确实偶发
 * （6 次同参数重放，单次最长 516s、34373 个事件，均正常收尾），
 * 所以把它归回 `TRANSPORT` 让 DSH 的既有重试策略吸收掉就是正解。
 */
export const INTERRUPTED_STREAM_PATTERN =
  /response stream was interrupted|response stream (?:has )?been interrupted/i;

/**
 * 判断一条错误文本是否是「上游流中途中断」。
 *
 * @param {unknown} message
 * @returns {boolean}
 */
export function isInterruptedStreamMessage(message) {
  return typeof message === 'string' && INTERRUPTED_STREAM_PATTERN.test(message);
}

/**
 * 把中断文案改写成 DSH 归类器认得的 `TRANSPORT` 形状。
 *
 * 只在前面**追加**一句命中 `/stream ended before\b/i` 的说明，原文
 * （含 `request_id`）原样保留在末尾——UI 上照样能复制 request_id 去提工单，
 * 搜索也照样找得到。
 *
 * @param {string} message
 * @returns {string}
 */
export function normalizeInterruptedStreamMessage(message) {
  return `SCNet stream ended before completion (upstream gateway interrupted the response). ${message}`;
}

/**
 * 判断一个上游错误是否应当被归一化成可重试的 `SERVER`（仅 5xx 抖动）。
 *
 * 400 + 10013 的一次性自愈不由这里决定，见 {@link createRetryFriendlyFetch}：
 * 那条路要同时改写状态码与 message 文本，才能真的落到 `SERVER`。
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
 * 把「400 + 10013」改写成 DSH 归类器认得的可重试形状。
 *
 * 只改 body 的 `type` 不够：DSH 的 `classifyPiAiError` 按顺序扫文本，
 * 第一步就命中 `/\b400\b|invalid.?request/i`，而 pi-ai 格式化出的错误文本是
 * `400: {json}`，且原文里有 “Invalid request parameters”。三处都要处理：
 *
 *   1. 状态码 400 → 500（让 `\b5\d\d\b` 分支命中 `SERVER`）；
 *   2. `type` → `api_error`；
 *   3. message 换成不含 “invalid request”/“400” 的文案，但**保留 request_id**，
 *      方便向平台反馈。
 *
 * @param {any} body 原始错误体
 * @param {Response} response 原始响应
 * @returns {Response}
 */
export function normalizeRetryOnceInvalidParam(body, response) {
  const error = body?.error ?? {};
  const requestId = /\(request_id:\s*([^)]+)\)/i.exec(String(error.message ?? ''))?.[1];
  const message =
    'SCNet transient parameter rejection (code 10013); retrying once.' +
    (requestId ? ` request_id: ${requestId}` : '');
  const rewritten = {
    ...body,
    error: { ...error, type: 'api_error', code: error.code ?? RETRY_ONCE_INVALID_PARAM_CODE, message },
  };
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(rewritten), {
    status: 500,
    statusText: 'SCNet transient parameter rejection',
    headers,
  });
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
 * 改写 SSE 里「流中途中断」的错误帧，让归类落到可重试的 `TRANSPORT`。
 *
 * 只在**已收到过内容、且还没见到终止帧**（`[DONE]` 或非空 `finish_reason`）
 * 时改写。终止帧之前就报错的情况（比如配额、鉴权）原样透传，避免把真错误
 * 拖成 5 次无用重试。
 *
 * 实现上是把 `response.body` 包一层 TransformStream：按 `\n\n` / `\r\n\r\n` 切帧、只动
 * `data:` 帧的 JSON 文本，其余字节原样透传。因此对正常流零影响。
 *
 * @param {Response} response 上游 2xx 且 content-type 为 SSE 的响应
 * @param {(info: { message: string, rewritten: string }) => void} [onInterrupt]
 * @returns {Response}
 */
export function withInterruptionAwareBody(response, onInterrupt) {
  const body = response.body;
  if (!body) return response;

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  let sawContent = false;
  let sawTerminal = false;

  const transform = new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      // SSE 规范允许 `\n\n`，实际网关也常见 `\r\n\r\n`。只认前者会让 CRLF 流
      // 整段留在 buffer 里，直到 flush 才一次性吐出——流式变批量，长回答还会
      // 占满内存。这里两种都识别，并保留原始分隔符（正常帧逐字节不变）。
      for (;;) {
        const boundary = nextBoundary(buffer);
        if (boundary === undefined) break;
        const frame = buffer.slice(0, boundary.index);
        const separator = buffer.slice(boundary.index, boundary.index + boundary.length);
        buffer = buffer.slice(boundary.index + boundary.length);
        controller.enqueue(encoder.encode(rewriteFrame(frame) + separator));
      }
      // 非标准流：没有可识别的分隔符且积压过大时先原样吐出，避免 OOM。
      if (buffer.length > MAX_PENDING_FRAME_BYTES) {
        controller.enqueue(encoder.encode(buffer));
        buffer = '';
      }
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer.length > 0) {
        controller.enqueue(encoder.encode(rewriteFrame(buffer)));
        buffer = '';
      }
    },
  });

  // 把上游 body 灌进 transform。用 catch 兜住「调用方提前放弃读取」导致的
  // 取消/中断，别让它变成未处理的 rejection——那会以 unhandledRejection
  // 打爆整个进程。
  body.pipeTo(transform.writable).catch(() => {});

  /**
   * @param {string} frame 一个完整的 SSE 帧（不含结尾的 `\n\n`）
   * @returns {string}
   */
  function rewriteFrame(frame) {
    if (!frame.trim()) return frame;

    // 只看 data 行；event:/id:/retry: 等照旧。
    const lines = frame.split('\n');
    const dataLineIndexes = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('data:')) dataLineIndexes.push(i);
    }
    if (dataLineIndexes.length === 0) return frame;

    const payload = dataLineIndexes
      .map((i) => lines[i].slice(5).trim())
      .join('\n')
      .trim();

    if (payload === '[DONE]') {
      sawTerminal = true;
      return frame;
    }

    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      // 非 JSON 帧：不动，但保守地视为「有内容」，否则中断帧会被当成首帧。
      if (payload) sawContent = true;
      return frame;
    }

    // —— 错误帧 ——
    const error = parsed?.error;
    if (error !== undefined && error !== null) {
      const message = typeof error === 'string' ? error : error.message;
      if (sawContent && !sawTerminal && isInterruptedStreamMessage(message)) {
        const rewritten = normalizeInterruptedStreamMessage(message);
        const next = typeof error === 'string' ? { ...parsed, error: rewritten } : { ...parsed, error: { ...error, message: rewritten } };
        try {
          onInterrupt?.({ message, rewritten });
        } catch {
          // 日志回调失败不影响流。
        }
        lines[dataLineIndexes[0]] = `data: ${JSON.stringify(next)}`;
        // 多行 data 合并成了一行，其余删掉。
        const keep = lines.filter((_, i) => i === dataLineIndexes[0] || !dataLineIndexes.includes(i));
        return keep.join('\n');
      }
      return frame;
    }

    // —— 正常分片 ——
    const choice = parsed?.choices?.[0];
    if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
      sawTerminal = true;
    }
    if (!sawContent) {
      const delta = choice?.delta;
      if (delta && (delta.content || delta.reasoning_content || delta.reasoning || delta.tool_calls)) {
        sawContent = true;
      }
    }
    return frame;
  }

  const headers = new Headers(response.headers);
  // body 已被上面解码/重编码，长度与压缩相关的头必须去掉，否则调用方会解错。
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.delete('transfer-encoding');

  return new Response(transform.readable, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * 构造一个「重试友好」的 fetch。
 *
 * 三处介入，动机都是**别让一次可自愈的抖动变成整轮失败**：
 *
 *   1. 5xx 却自称 `invalid_request_error` 的抖动 → 改写成可重试的 `api_error`；
 *   2. 400 + 10013 的**首次**出现 → 同样改写一次，给上游一次自愈机会，
 *      第二次仍报则原样透传（见 {@link RETRY_ONCE_INVALID_PARAM_CODE}）；
 *   3. 2xx 的 SSE 流中途中断 → 改写 error 帧的 message（见
 *      {@link withInterruptionAwareBody}）。
 *
 * 其它情况（含普通 2xx、非 SSE 的 2xx）原样返回。
 *
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   onNormalize?: (info: { status: number, code?: string, message?: string, invalidParamRetry?: boolean }) => void,
 *   onInterrupt?: (info: { message: string, rewritten: string }) => void,
 *   onRequest?: (info: { url: string, bytes: number, signature: string }) => void,
 *   invalidParamRetry?: boolean,
 *   now?: () => number,
 * }} [options]
 * @returns {typeof fetch}
 */
export function createRetryFriendlyFetch(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('dsh-scnet-connect: no fetch implementation available');
  }
  const invalidParamRetry = options.invalidParamRetry !== false;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  /** 已自愈过一次的请求体签名 → 时间戳。 */
  const healed = new Map();

  /** 同一个请求体只自愈一次；返回本次是否允许改写。 */
  function allowInvalidParamRetry(signature) {
    if (!invalidParamRetry || !signature) return false;
    const at = now();
    for (const [key, time] of healed) {
      if (at - time > INVALID_PARAM_RETRY_WINDOW_MS) healed.delete(key);
    }
    if (healed.has(signature)) return false;
    healed.set(signature, at);
    while (healed.size > INVALID_PARAM_MEMORY_LIMIT) {
      const oldest = healed.keys().next().value;
      if (oldest === undefined) break;
      healed.delete(oldest);
    }
    return true;
  }

  return async function retryFriendlyFetch(input, init) {
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input?.url ?? '');
    // 签名只用于「同一个请求体只改一次」：FNV-1a 足够，不保存内容本身。
    const signature = signatureOf(url, bodyText);
    try {
      options.onRequest?.({ url, bytes: bodyText.length, signature });
    } catch {
      // 观测回调失败不影响请求。
    }

    const response = await fetchImpl(input, init);
    if (response.ok) {
      // 只包 SSE；普通 JSON 响应不碰。
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('text/event-stream')) return response;
      return withInterruptionAwareBody(response, options.onInterrupt);
    }

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

    const isInvalidParam = response.status === 400 && String(body?.error?.code ?? '') === RETRY_ONCE_INVALID_PARAM_CODE;
    const invalidParamRetryable = isInvalidParam && allowInvalidParamRetry(signature);
    if (invalidParamRetryable) {
      try {
        options.onNormalize?.({
          status: response.status,
          code: RETRY_ONCE_INVALID_PARAM_CODE,
          message: typeof body?.error?.message === 'string' ? body.error.message : undefined,
          invalidParamRetry: true,
        });
      } catch {
        // 日志回调失败不影响请求。
      }
      return normalizeRetryOnceInvalidParam(body, response);
    }

    if (!shouldNormalizeUpstreamError(response.status, body)) return response;

    const rewritten = normalizeUpstreamErrorBody(body);
    try {
      options.onNormalize?.({
        status: response.status,
        code: typeof body?.error?.code === 'string' ? body.error.code : undefined,
        message: typeof body?.error?.message === 'string' ? body.error.message : undefined,
        invalidParamRetry: invalidParamRetryable,
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

/** FNV-1a 32 位；只用于给「同一个请求体」做键。 */
function signatureOf(url, body) {
  if (!body) return '';
  let hash = 0x811c9dc5;
  const text = `${url}\u0000${body}`;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
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
