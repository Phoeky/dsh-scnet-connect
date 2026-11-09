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
 * 上下文/输出上限以**平台真实能力**为准，而不是客户端主进程里那条旧特判
 * （`if ("scnet-max" === id.toLowerCase()) contextWindow = min(ctx, 262144)`）。
 *
 * 2026-11-09 直连实测（`tools/repro/` 同款调用方式）：
 *   - 输入 ~973k tokens（2,000,000 中文字符）→ HTTP 200，`prompt_tokens: 972977`；
 *   - 输入 ~1.07M tokens（2,200,000 中文字符）→ HTTP 400 `10013`；
 *   → 真实上下文就是 1,048,576（1M），客户端的 262,144 只是它自己保守取值。
 *   - `max_tokens: 131072` 流式请求被接受（客户端目录同样标 131072）。
 * 若沿用 262144，DSH 会在 1/4 处就开始压缩上下文，白白浪费 3/4 的窗口。
 */

/** 客户端目录里标记「免费」的 priceLabel 值。 */
export const FREE_PRICE_LABEL = 'free';

/** 兜底模型 id（客户端目录不可用时使用；SCNet 网关区分大小写）。 */
export const DEFAULT_MODEL_ID = 'SCNet-Max';

/** SCNet OpenAI 兼容网关根地址。 */
export const DEFAULT_BASE_URL = 'https://api.scnet.cn/api/llm/v1';

/**
 * 兜底上下文窗口（1M）。
 *
 * 客户端模型目录不可用时的默认值；与平台实测能力一致（见文件头）。
 * 客户端目录存在时仍以目录里的 `contextWindow` 为准。
 */
export const DEFAULT_CONTEXT_WINDOW = 1_048_576;

/** 兜底最大输出（131072，平台实测接受该值）。 */
export const DEFAULT_MAX_TOKENS = 131_072;

/** node 侧无计费概念，全 0。 */
export const NO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/**
 * DSH 的思考等级 → SCNet 网关的 `reasoning_effort` 拼写。
 *
 * 实测 `https://api.scnet.cn/api/llm/v1/chat/completions` 接受
 * none/low/medium/high/xhigh/max（外加 minimal），且 `none` 确实让 reasoning
 * token 归零（实测 reasoning_tokens: none=0、max=356），所以 off 映射到 none 是
 * 真关闭，不是摆设。除 off 外一律**恒等透传**：DSH 暴露的 7 档与上游 7 档一一对应，
 * 折叠任意一档都会让用户选到的档位与实际思考预算不符。
 */
export const THINKING_LEVEL_MAP = Object.freeze({
  off: 'none',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
});

/**
 * 构造 pi-ai 的模型描述符。
 *
 * @param {{
 *   modelId?: string,
 *   modelName?: string,
 *   baseUrl: string,
 *   meta?: { id?: string, name?: string, input?: string[], contextWindow?: number, maxTokens?: number, toolCalling?: boolean, priceLabel?: string },
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
  const contextWindow = signedContextWindow ?? meta?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const maxTokens = signedMaxTokens ?? meta?.maxTokens ?? DEFAULT_MAX_TOKENS;
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
    contextWindow,
    // 只保证「输出不超过上下文」这一条一致性；不再按模型 id 打 262144/32768 的补丁
    // （那是客户端主进程的保守特判，实测网关支持 1M / 131072，见文件头）。
    maxTokens: Math.min(maxTokens, contextWindow),
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
  if (meta?.priceLabel === FREE_PRICE_LABEL) return `${meta?.name || modelId} · 免费`;
  return meta?.name || modelId;
}
