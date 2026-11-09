/**
 * model descriptor 构造
 * ------------------------------------------------------------------
 * SCNet 的 LLM 网关是标准 OpenAI Chat Completions 兼容端点
 * （`https://api.scnet.cn/api/llm/v1`），因此这里只需要把「模型元数据」
 * 翻译成 pi-ai 的模型描述符，不需要任何协议转换层（shim）。
 *
 * 元数据来源优先级：
 *   1. 插件配置（contextWindow / maxTokens / inputImages / reasoning）
 *   2. SCNet 客户端自己的模型目录 `~/.sclaw/agent/models.json`
 *   3. 内置默认值
 *
 * 客户端对 `scnet-max` 有一条特殊上限（见其主进程代码
 * `if ("scnet-max" === id.toLowerCase()) contextWindow = min(ctx, 262144)`），
 * 插件跟随这条限制，避免声明了实际会被网关拒绝的上下文长度。
 */

/** 免费模型 id（SCNet 网关区分大小写）。 */
export const DEFAULT_MODEL_ID = 'SCNet-Max';

/** SCNet OpenAI 兼容网关根地址。 */
export const DEFAULT_BASE_URL = 'https://api.scnet.cn/api/llm/v1';

/** node 侧无计费概念，全 0。 */
export const NO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/**
 * DSH 的思考等级 → SCNet 网关的 `reasoning_effort` 拼写。
 *
 * 实测 `https://api.scnet.cn/api/llm/v1/chat/completions` 接受
 * none/low/medium/high/xhigh/max，且 `none` 确实让 reasoning token 归零
 * （实测 reasoning_tokens: none=0、max=356），所以 off 映射到 none 是真关闭，
 * 不是摆设。
 */
export const THINKING_LEVEL_MAP = Object.freeze({
  off: 'none',
  minimal: 'low',
  low: 'low',
  medium: 'high',
  high: 'high',
  xhigh: 'max',
  max: 'max',
});

/**
 * 客户端对 SCNet-Max 的有效上限（与客户端主进程一致）。
 * @param {string} modelId
 * @param {number} contextWindow
 * @param {number} maxTokens
 */
function clampForModel(modelId, contextWindow, maxTokens) {
  if (modelId.trim().toLowerCase() !== DEFAULT_MODEL_ID.toLowerCase()) return { contextWindow, maxTokens };
  const ctx = Math.min(contextWindow, 262144);
  return { contextWindow: ctx, maxTokens: Math.min(maxTokens, ctx, 32768) };
}

/**
 * 构造 pi-ai 的模型描述符。
 *
 * @param {{
 *   modelId?: string,
 *   modelName?: string,
 *   baseUrl: string,
 *   meta?: { id?: string, input?: string[], contextWindow?: number, maxTokens?: number, toolCalling?: boolean, priceLabel?: string },
 *   contextWindow?: number,
 *   maxTokens?: number,
 *   inputImages?: boolean,
 *   reasoning?: boolean,
 * }} options
 */
export function buildModel(options) {
  const modelId = (options.modelId || DEFAULT_MODEL_ID).trim() || DEFAULT_MODEL_ID;
  const meta = options.meta;
  const signedContextWindow = options.contextWindow && options.contextWindow > 0 ? options.contextWindow : undefined;
  const signedMaxTokens = options.maxTokens && options.maxTokens > 0 ? options.maxTokens : undefined;
  const contextWindow = signedContextWindow ?? meta?.contextWindow ?? 262144;
  const maxTokens = signedMaxTokens ?? meta?.maxTokens ?? 32768;
  const clamped = clampForModel(modelId, contextWindow, maxTokens);
  const input = options.inputImages === false ? ['text'] : meta?.input?.length ? [...meta.input] : ['text', 'image'];

  return {
    id: modelId,
    name: options.modelName?.trim() || meta?.name || modelId,
    api: 'openai-completions',
    provider: 'scnet',
    baseUrl: options.baseUrl,
    input,
    reasoning: options.reasoning !== false,
    ...(options.reasoning === false ? {} : { thinkingLevelMap: { ...THINKING_LEVEL_MAP } }),
    cost: { ...NO_COST },
    contextWindow: clamped.contextWindow,
    maxTokens: clamped.maxTokens,
    compat: {
      // SCNet 网关是 vLLM/OpenAI 传统拼写：`max_tokens` 而不是 `max_completion_tokens`。
      maxTokensField: 'max_tokens',
      // reasoning_content 由 pi-ai 的 openai-completions 自动解析；这里显式声明
      // OpenAI 风格 reasoning_effort，确保 DSH 选择的思考等级会真正下发。
      supportsReasoningEffort: true,
    },
  };
}

/** 模型标签（模型选择器里显示的名称）。 */
export function modelLabel(meta, modelId) {
  if (meta?.priceLabel === 'free') return `${modelId} · 免费`;
  return meta?.name || modelId;
}
