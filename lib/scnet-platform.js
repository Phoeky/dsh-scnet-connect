/**
 * SCNet 平台（www.scnet.cn）会话客户端 —— 免客户端登录的地基
 * ------------------------------------------------------------------
 * 模型调用走 `api.scnet.cn/api/llm/v1`（`Authorization: Bearer sk-…`），
 * 但拿 `sk-` key 必须先有平台登录态。平台登录态不是 `Token: <jwt>` 头，
 * 而是登录时下发的一对 Cookie：`jsessionid` + `Token`（详见 docs/scnet-api.md §9）。
 *
 * 本模块只做四件事，全部基于实测确认的端点：
 *
 *   1. `resolveSession(cookies)`：
 *      `GET  /acx/user/users/current-user-info` —— 会话是否有效、属于谁。
 *   2. `apiKeyFromJwt(jwt)`：把桌面端签发的 JWT 换成会话 Cookie
 *      `POST /ac/api/auth/loginDesktopClientByToken.action`。
 *      这是「免客户端」里**客户端来源**的入口（用户从不装客户端的那台机器上，
 *      也可以用浏览器登录后从平台拿到 JWT 粘进来）。
 *   3. `ensureApiKey(session)`：拿 model-service key ——
 *      `POST /acx/llm/api-key/createActivityApiKey`（活动 Key，客户端也是这么拿的）。
 *   4. `logout(session)`。
 *
 * 安全约束：Cookie / JWT **绝不**写日志、不进诊断快照；落盘只允许在
 * `$DSH_HOME/scnet-session.json`（0600），由调用方负责。
 */

import os from 'node:os';
import path from 'node:path';

import { DEFAULT_BASE_URL } from './scnet-models.js';

/** 平台根地址（CAS 登录页、acx 接口都在这个域）。 */
export const PLATFORM_BASE_URL = 'https://www.scnet.cn';

/** `$DSH_HOME/scnet-session.json`：免客户端会话的落盘位置。 */
export function sessionFilePath(env = process.env) {
  const home = env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh');
  return path.join(home, 'scnet-session.json');
}

/** 平台网页登录页（用户在自己浏览器里打开它完成登录）。 */
export function webLoginUrl() {
  return `${PLATFORM_BASE_URL}/ui/acm/index.html#/login`;
}

/** 一次网页登录表单会话的存活时间（验证码/风控状态）。 */
export const PENDING_TTL_MS = 10 * 60 * 1000;
/** 桌面客户端同款的请求头（平台网关会看 source/version）。 */
const SOURCE_HEADERS = Object.freeze({ 'user-agent': 'scnet-client/4.1.0', source: 'Electron', version: '4.1.0' });
/** 单次平台请求超时。 */
const REQUEST_TIMEOUT_MS = 20_000;

/** 让 fetch 在超时/外部取消时都能及时结束。 */
function withTimeout(signal, ms = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), ms);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/** 从 `Set-Cookie` 头里挑出我们需要的那两个 Cookie。 */
function pickCookies(setCookieHeaders) {
  const wanted = ['jsessionid', 'Token'];
  const picked = {};
  for (const raw of setCookieHeaders) {
    const first = String(raw).split(';')[0];
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (!wanted.some((w) => w.toLowerCase() === name.toLowerCase()) || !value) continue;
    // 删除 Cookie（Max-Age=0 / 值为空）时不要记成有效值。
    if (/max-age\s*=\s*0/i.test(String(raw))) continue;
    picked[wanted.find((w) => w.toLowerCase() === name.toLowerCase())] = value;
  }
  return picked;
}

/** Cookie 对象 → `Cookie` 请求头；也接受调用方直接给字符串。 */
export function cookieHeader(cookies) {
  if (typeof cookies === 'string') return cookies.trim();
  if (!cookies || typeof cookies !== 'object') return '';
  return ['jsessionid', 'Token']
    .map((name) => (typeof cookies[name] === 'string' && cookies[name] ? `${name}=${cookies[name]}` : ''))
    .filter(Boolean)
    .join('; ');
}

/** 只保留允许的形状；不在这里补任何过期时间（平台 Cookie 是会话级/长效）。 */
export function normalizeCookies(input) {
  if (!input || typeof input !== 'object') return undefined;
  const out = {};
  for (const name of ['jsessionid', 'Token']) {
    const value = input[name];
    if (typeof value === 'string' && value.trim() && value.length < 4096) out[name] = value.trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 平台统一返回 `{ code: '0', msg, data }`；兼容网关直接返回业务对象的情况。 */
function unwrap(body) {
  if (body && typeof body === 'object' && !Array.isArray(body) && 'code' in body) {
    const code = String(body.code);
    if (code !== '0') {
      const error = new Error(body.msg || body.message || `SCNet 平台返回 code=${code}`);
      error.providerCode = code;
      throw error;
    }
    return body.data;
  }
  return body;
}

async function platformRequest(path, { method = 'GET', cookies, body, signal, timeoutMs } = {}) {
  const cookie = cookieHeader(cookies);
  const timer = withTimeout(signal, timeoutMs);
  try {
    const headers = { ...SOURCE_HEADERS, accept: 'application/json, text/plain, */*' };
    if (cookie) headers.cookie = cookie;
    let payload;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const response = await fetch(`${PLATFORM_BASE_URL}${path}`, {
      method,
      headers,
      body: payload,
      signal: timer.signal,
      redirect: 'manual',
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    const setCookie = response.headers.getSetCookie?.() ?? [];
    return {
      status: response.status,
      body: parsed,
      text,
      cookies: pickCookies(setCookie),
    };
  } finally {
    timer.clear();
  }
}

/**
 * 现在的会话是谁？会话无效时返回 `{ ok: false, reason }`，从不抛网络错误以外的东西。
 *
 * @param {{ cookies?: any, signal?: AbortSignal }} options
 */
export async function resolveSession(options = {}) {
  const cookies = normalizeCookies(options.cookies);
  if (!cookies) return { ok: false, reason: 'missing-cookies' };
  try {
    const result = await platformRequest('/acx/user/users/current-user-info?includeToken=true&refresh=true', {
      cookies,
      signal: options.signal,
    });
    if (result.status === 401) return { ok: false, reason: 'expired' };
    if (result.status !== 200 || !result.body) return { ok: false, reason: `http-${result.status}` };
    const data = unwrap(result.body);
    const userId = data?.id !== undefined && data?.id !== null ? String(data.id) : '';
    if (!userId) return { ok: false, reason: 'invalid-response' };
    return {
      ok: true,
      user: {
        userId,
        userName: typeof data.userName === 'string' ? data.userName : undefined,
        mobile: typeof data.mobilephoneNum === 'string' ? maskPhone(data.mobilephoneNum) : undefined,
        institution: typeof data.institution === 'string' && data.institution.trim() ? data.institution.trim() : undefined,
      },
      // 平台可能在这条响应里续期 Cookie；能续就续，续不了就沿用旧的。
      cookies: { ...cookies, ...result.cookies },
    };
  } catch (error) {
    return { ok: false, reason: 'network', error: error instanceof Error ? error.message : String(error) };
  }
}

/** 138****1234（平台本身也可能已脱敏）。 */
export function maskPhone(value) {
  if (typeof value !== 'string') return undefined;
  const digits = value.replace(/\s+/g, '');
  if (/^\d{11}$/.test(digits)) return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
  if (/\*{2,}/.test(digits)) return digits;
  return undefined;
}

/**
 * 桌面 JWT → 平台会话 Cookie。
 *
 * 端点与请求形状都是客户端主进程在用的那个；注意它要求
 * `application/x-www-form-urlencoded`（JSON 会被当成「参数缺失」）。
 *
 * @param {{ jwt: string, signal?: AbortSignal }} options
 * @returns {Promise<{ ok: true, cookies: object } | { ok: false, reason: string, message?: string }>}
 */
export async function exchangeJwt(options = {}) {
  const jwt = typeof options.jwt === 'string' ? options.jwt.trim() : '';
  if (!jwt) return { ok: false, reason: 'missing-jwt' };
  const timer = withTimeout(options.signal);
  try {
    const response = await fetch(`${PLATFORM_BASE_URL}/ac/api/auth/loginDesktopClientByToken.action`, {
      method: 'POST',
      headers: {
        ...SOURCE_HEADERS,
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        accept: 'application/json',
      },
      body: `desktopToken=${encodeURIComponent(jwt)}&sensors_anon_id=&type=tokenLogin`,
      signal: timer.signal,
      redirect: 'manual',
    });
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    const cookies = pickCookies(response.headers.getSetCookie?.() ?? []);
    if (body && String(body.code) !== '0') {
      return { ok: false, reason: 'rejected', message: body.msg || body.message || `code=${body.code}` };
    }
    if (response.status !== 200 || !normalizeCookies(cookies)) {
      return { ok: false, reason: `http-${response.status}` };
    }
    return { ok: true, cookies };
  } catch (error) {
    return { ok: false, reason: 'network', message: error instanceof Error ? error.message : String(error) };
  } finally {
    timer.clear();
  }
}

/**
 * 用会话换 model-service API Key。
 *
 * 走「活动 Key」端点（客户端刷新凭据时优先用它）：同一账号拿到的 key 与客户端
 * 落盘的是同一个，不会每次刷新都新建 key。
 *
 * @param {{ cookies: any, signal?: AbortSignal }} options
 * @returns {Promise<{ ok: true, key: string, baseUrl?: string } | { ok: false, reason: string, message?: string }>}
 */
export async function ensureApiKey(options = {}) {
  const cookies = normalizeCookies(options.cookies);
  if (!cookies) return { ok: false, reason: 'missing-cookies' };
  try {
    const result = await platformRequest('/acx/llm/api-key/createActivityApiKey', {
      method: 'POST',
      cookies,
      body: {},
      signal: options.signal,
    });
    if (result.status === 401) return { ok: false, reason: 'expired' };
    if (result.status !== 200 || !result.body) {
      const msg = result.body?.msg || result.body?.message || `HTTP ${result.status}`;
      return { ok: false, reason: 'rejected', message: msg };
    }
    const data = unwrap(result.body);
    const key = typeof data === 'string' ? data : data?.apiKey;
    if (typeof key !== 'string' || !key.startsWith('sk-')) {
      return { ok: false, reason: 'invalid-response', message: '平台没有返回 sk- 开头的模型服务 Key' };
    }
    return {
      ok: true,
      key,
      baseUrl: typeof data?.baseUrl === 'string' && data.baseUrl.trim() ? data.baseUrl.trim() : DEFAULT_BASE_URL,
    };
  } catch (error) {
    return {
      ok: false,
      reason: error?.providerCode ? 'rejected' : 'network',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 让平台侧会话失效（尽力而为，失败不影响本地清理）。 */
export async function logout(options = {}) {
  const cookies = normalizeCookies(options.cookies);
  if (!cookies) return { ok: true };
  try {
    await platformRequest('/acx/user/users/logout', { cookies, signal: options.signal, timeoutMs: 8_000 });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/**
 * 从平台网页登录地址里取出桌面 JWT。
 *
 * 用户没有客户端时最常见的「浏览器登录」结果是页面重定向到
 * `loginDesktopClientByTokenRedirect.action?desktopToken=<jwt>`。
 * 用户把地址栏整条粘回来，我们只在这里取值，不做任何自动跳转。
 *
 * @param {string} input
 * @returns {string | undefined}
 */
export function extractJwtFromInput(input) {
  const text = typeof input === 'string' ? input.trim() : '';
  if (!text) return undefined;
  const jwtPattern = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;
  if (jwtPattern.test(text)) {
    // 可能是裸 JWT，也可能在 URL 里（两种都只看 JWT 本身）。
    return jwtPattern.exec(text)?.[0];
  }
  // 允许用户整个粘 `desktopToken=...` 或 URL 编码过的值。
  const m = /desktopToken=([^&\s#]+)/.exec(text);
  if (m) {
    const decoded = decodeURIComponent(m[1]);
    const inner = jwtPattern.exec(decoded);
    if (inner) return inner[0];
  }
  try {
    const url = new URL(text);
    const raw = url.searchParams.get('desktopToken') ?? url.searchParams.get('token');
    if (raw && jwtPattern.test(raw)) return jwtPattern.exec(raw)[0];
  } catch {
    // 不是 URL：上面的模式已经覆盖了裸值的情况。
  }
  return undefined;
}
