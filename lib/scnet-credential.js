/**
 * SCNet 客户端登录态 / 模型服务凭据发现
 * ------------------------------------------------------------------
 * 本机 SCNet 客户端（`计算服务.exe`）有两份与模型调用相关的东西：
 *
 *  1. `%APPDATA%\scnet-client\config.json` —— 账号登录态（字段 `accessToken`，
 *     HS256 JWT）。它用于平台 API（api-key 管理、模型服务开通状态等）。
 *  2. `~/.sclaw/agent/scnet-credentials/<hash>.json` —— 客户端创建的「模型服务
 *     API Key」：
 *         { "scnet": { "type": "api_key", "key": "sk-..." } }
 *     这正是客户端调用 `https://api.scnet.cn/api/llm/v1/chat/completions`
 *     时使用的 Bearer 凭据。
 *
 * 插件只读这两份文件，**不修改客户端数据**：用户只要在 SCNet 客户端里保持登录
 * （并在首次使用时正常发过一条消息，让客户端自动创建 model-service key），
 * 插件即可直接复用。
 *
 * 读取是逐请求进行的（文件只有几十字节），这样客户端轮换 key 后插件能自动跟上，
 * 不需要重启 DSH。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** SCNet 客户端默认用户目录（Windows: %APPDATA%\scnet-client）。 */
export function defaultClientDataDir() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'scnet-client');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'scnet-client');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'scnet-client');
}

/** 客户端 agent 数据目录（`~/.sclaw/agent`）。 */
export function defaultAgentDataDir() {
  return path.join(os.homedir(), '.sclaw', 'agent');
}

/** model-service API Key 默认目录。 */
export function defaultCredentialDir() {
  return path.join(defaultAgentDataDir(), 'scnet-credentials');
}

/** 客户端模型目录（`~/.sclaw/agent/models.json`）默认路径。 */
export function defaultModelsPath() {
  return path.join(defaultAgentDataDir(), 'models.json');
}

/**
 * 从一份 scnet-credentials JSON 中取出 API Key。
 * 兼容 `{ scnet: { key } }`（客户端实际格式）与 `{ key }`（手工放置）两种形状。
 */
function keyFromCredentialFile(parsed) {
  if (!parsed || typeof parsed !== 'object') return undefined;
  const direct = parsed.scnet;
  if (direct && typeof direct === 'object' && direct.type === 'api_key' && typeof direct.key === 'string') {
    const key = direct.key.trim();
    return key.length > 0 ? key : undefined;
  }
  if (typeof parsed.key === 'string' && parsed.key.trim().length > 0) return parsed.key.trim();
  for (const value of Object.values(parsed)) {
    if (value && typeof value === 'object' && typeof value.key === 'string' && value.key.trim().startsWith('sk-')) {
      return value.key.trim();
    }
  }
  return undefined;
}

/** 把 apiKey 抹成可出现在日志里的形状。 */
export function maskKey(key) {
  if (typeof key !== 'string' || key.length === 0) return '(empty)';
  if (key.length <= 12) return `${key.slice(0, 3)}…`;
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

/**
 * 读取 model-service API Key。
 *
 * @param {{ credentialDir?: string, apiKey?: string, agentDataDir?: string }} options
 * @returns {{ key: string, source: 'config' | 'client-file', file?: string, modifiedAt?: number }}
 */
export function resolveApiKey(options = {}) {
  const override = typeof options.apiKey === 'string' ? options.apiKey.trim() : '';
  if (override) return { key: override, source: 'config' };

  const credentialDir = options.credentialDir?.trim() || defaultCredentialDir();
  let entries;
  try {
    entries = fs.readdirSync(credentialDir, { withFileTypes: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `找不到 SCNet 模型服务凭据目录（${credentialDir}）：${reason}。` +
        '请先打开 SCNet 客户端并登录，正常发起一次模型对话（客户端会自动创建 model-service API Key），' +
        '或在插件配置里用 apiKey 直接指定。',
    );
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(credentialDir, entry.name);
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const key = keyFromCredentialFile(parsed);
      if (!key) continue;
      const stat = fs.statSync(file);
      candidates.push({ key, file, modifiedAt: stat.mtimeMs });
    } catch {
      // 单份文件损坏不影响其它候选。
    }
  }

  if (candidates.length === 0) {
    throw new Error(
      `SCNet 模型服务凭据不可用（${credentialDir} 里没有可用的 API Key）。` +
        '请打开 SCNet 客户端并登录后正常发起一次模型对话，让客户端自动创建 model-service key；' +
        '或用插件配置 apiKey 指定。',
    );
  }

  candidates.sort((a, b) => b.modifiedAt - a.modifiedAt);
  const chosen = candidates[0];
  return { key: chosen.key, source: 'client-file', file: chosen.file, modifiedAt: chosen.modifiedAt };
}

/**
 * 读取客户端的模型目录，返回 scnet provider 下某个模型的元数据。
 * 目录不存在或没有该模型时返回 undefined（调用方使用内置默认值）。
 *
 * @param {string} modelId
 * @param {{ modelsPath?: string }} [options]
 * @returns {{ id: string, name?: string, input?: string[], contextWindow?: number, maxTokens?: number, toolCalling?: boolean, priceLabel?: string } | undefined}
 */
export function readClientModelMeta(modelId, options = {}) {
  const modelsPath = options.modelsPath?.trim() || defaultModelsPath();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(modelsPath, 'utf8'));
  } catch {
    return undefined;
  }
  const models = parsed?.providers?.scnet?.models;
  if (!Array.isArray(models)) return undefined;
  const target = modelId.trim().toLowerCase();
  const found = models.find((m) => typeof m?.id === 'string' && m.id.trim().toLowerCase() === target);
  if (!found) return undefined;
  const input = Array.isArray(found.input)
    ? [...new Set(found.input.filter((v) => v === 'text' || v === 'image'))]
    : undefined;
  return {
    id: found.id,
    name: typeof found.name === 'string' ? found.name : undefined,
    input: input && input.length > 0 ? input : undefined,
    contextWindow: typeof found.contextWindow === 'number' ? found.contextWindow : undefined,
    maxTokens: typeof found.maxTokens === 'number' ? found.maxTokens : undefined,
    toolCalling: found.toolCalling === true ? true : undefined,
    priceLabel: typeof found.priceLabel === 'string' ? found.priceLabel : undefined,
  };
}

/** 平台登录态（JWT）——只用于诊断/未来的 key 自动续期，不参与模型请求。 */
export function readPlatformAccessToken(clientDataDir = defaultClientDataDir()) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(clientDataDir, 'config.json'), 'utf8'));
    const token = typeof raw?.accessToken === 'string' ? raw.accessToken : undefined;
    if (!token) return undefined;
    const payload = JSON.parse(Buffer.from(token.split('.')[1] || '', 'base64url').toString('utf8'));
    const rawExpiry = payload?.expireTime;
    const numericExpiry =
      typeof rawExpiry === 'number'
        ? rawExpiry
        : typeof rawExpiry === 'string' && /^\d+$/.test(rawExpiry)
          ? Number(rawExpiry)
          : undefined;
    const expiresAt =
      numericExpiry === undefined ? undefined : numericExpiry > 1e12 ? numericExpiry : numericExpiry * 1000;
    return { token, expiresAt };
  } catch {
    return undefined;
  }
}
