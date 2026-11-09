/**
 * SCNet 客户端登录态读取
 * ------------------------------------------------------------------
 * SCNet 客户端（`计算服务.exe`，Electron）把账号登录态落在用户目录的
 * `config.json` 里，字段是 `accessToken`（一段 HS256 JWT，payload 带
 * `expireTime` 毫秒时间戳）。插件直接复用这份登录态，不要求用户把 token
 * 复制粘贴到 DSH —— 用户只需要在本机 SCNet 客户端里保持登录。
 *
 * 注意：
 *  - 本模块只读文件、不发请求，因此可以便宜地在每个请求前调用一次。
 *  - token 过期时**不会**尝试用账号密码重新登录（客户端自己处理刷新）；
 *    这里只负责把「过期」如实报出来，让上层给出可操作的错误。
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

/** 解码 JWT payload（不做签名校验：我们只是读取客户端自己写下的过期时间）。 */
export function decodeJwtPayload(token) {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload && typeof payload === 'object' ? payload : undefined;
  } catch {
    return undefined;
  }
}

/** 从 JWT payload 里取过期时间（毫秒）；取不到返回 undefined。 */
export function tokenExpiry(token) {
  const payload = decodeJwtPayload(token);
  if (!payload) return undefined;
  const raw = payload.expireTime ?? payload.exp ?? payload.expiresAt;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // SCNet 客户端写的是毫秒时间戳；标准 JWT 的 exp 是秒。
    return raw > 1_000_000_000_000 ? raw : raw * 1000;
  }
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    const value = Number(raw);
    return value > 1_000_000_000_000 ? value : value * 1000;
  }
  return undefined;
}

/**
 * 读取客户端 config.json。
 * @param {string} clientDataDir
 * @returns {{ accessToken?: string, raw: any, configPath: string }}
 */
export function readClientConfig(clientDataDir = defaultClientDataDir()) {
  const configPath = path.join(clientDataDir, 'config.json');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `读不到 SCNet 客户端配置（${configPath}）：${reason}。` +
        '请先安装并登录本机 SCNet 客户端（计算服务），或用 accessToken 配置项手动指定登录态。',
    );
  }
  const accessToken = typeof raw?.accessToken === 'string' && raw.accessToken.length > 0 ? raw.accessToken : undefined;
  return { accessToken, raw, configPath };
}

/**
 * 解析当前可用的 SCNet 登录态。
 *
 * @param {{ clientDataDir?: string, accessToken?: string }} options
 * @returns {{ token: string, expiresAt?: number, expiresInMs?: number, source: 'config' | 'override', configPath?: string }}
 */
export function resolveAccessToken(options = {}) {
  const override = typeof options.accessToken === 'string' ? options.accessToken.trim() : '';
  if (override) {
    return { token: override, expiresAt: tokenExpiry(override), source: 'override' };
  }
  const clientDataDir = options.clientDataDir?.trim() || defaultClientDataDir();
  const { accessToken, configPath } = readClientConfig(clientDataDir);
  if (!accessToken) {
    throw new Error(
      `SCNet 客户端配置里没有 accessToken（${configPath}）。请先在本机 SCNet 客户端里登录账号，` +
        '或用 accessToken 配置项手动指定。',
    );
  }
  const expiresAt = tokenExpiry(accessToken);
  return {
    token: accessToken,
    expiresAt,
    expiresInMs: expiresAt === undefined ? undefined : expiresAt - Date.now(),
    source: 'config',
    configPath,
  };
}

/** 面向用户的 token 状态摘要（不含 token 本身）。 */
export function describeTokenState(options = {}) {
  const resolved = resolveAccessToken(options);
  return {
    source: resolved.source,
    configPath: resolved.configPath,
    expiresAt: resolved.expiresAt,
    expiresInMs: resolved.expiresInMs,
    expired: resolved.expiresInMs !== undefined && resolved.expiresInMs <= 0,
  };
}
