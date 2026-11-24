/**
 * provider 注册失败的诊断
 * ------------------------------------------------------------------
 * 从 `index.js` 抽出来的纯函数，便于离线测试。
 *
 * 背景（issue #1）：DSH 的 `ctx.llm.registerAdapter([id], adapter)` 在路由名
 * 已被别的 provider 占用时会抛 `an adapter for provider "scnet" is already
 * registered`。旧版插件把这个异常当成致命错误直接 `return`，连带跳过了
 * 设置页路由的注册——浏览器请求 `/plugins/dsh-scnet-connect/status` 只拿到
 * HTTP 404，用户完全看不到真正的原因。
 *
 * 这里只负责识别「名字冲突」并把英文异常翻译成可执行的修复步骤；是否中断
 * 启动由调用方决定（现在的做法是不中断，把诊断挂到 `/status` 上）。
 */

/** 路由名冲突的错误文案（不同 DSH 版本措辞略有差异，按子串匹配）。 */
const CONFLICT_PATTERNS = [
  /already registered/i,
  /already been registered/i,
  /already in use/i,
  /already exists/i,
  /duplicate/i,
];

/**
 * 判断异常文案是不是「provider 路由名已被占用」。
 *
 * @param {string} message
 * @returns {boolean}
 */
export function isProviderNameConflict(message) {
  const text = typeof message === 'string' ? message : String(message ?? '');
  return CONFLICT_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * 把注册失败翻译成设置页可以直接渲染的诊断。
 *
 * 非名字冲突返回 `undefined`：调用方会退回到通用错误展示，不臆造修复步骤。
 *
 * @param {string} message 原始异常文案（会原样放进 `error` 字段，供排查）
 * @param {string} providerId 本插件要注册的路由名
 * @returns {{
 *   kind: 'provider-name-conflict',
 *   provider: string,
 *   hint: string,
 *   steps: string[],
 *   error: string,
 * } | undefined}
 */
export function describeRegistrationFailure(message, providerId) {
  if (!isProviderNameConflict(message)) return undefined;
  const provider = typeof providerId === 'string' && providerId ? providerId : 'scnet';
  return {
    kind: 'provider-name-conflict',
    provider,
    hint:
      `路由名 "${provider}" 已被另一个模型 provider 占用，本插件无法注册，` +
      '设置页和模型选择器里都不会出现 SCNet Connect。',
    // 步骤要能直接照着做：插件自己没有权限改别的 bundle 的配置。
    steps: [
      `检查当前 profile 的 cordis.patch.yml（或在 DSH 插件管理器里），把其它 provider 的 ` +
        `${provider} 路由改名，例如 llm-pi-ai 的 providers.${provider} 改成 ${provider}-manual。`,
      `停用其它同样注册 "${provider}" 的插件（例如 dsh-scnet、dsh-connect-scnet-plus）。`,
      '改完后在插件管理器里把 include:scnet-connect 关掉再开启（或重启 DSH），让本插件重新注册。',
    ],
    error: typeof message === 'string' ? message : String(message ?? ''),
  };
}
