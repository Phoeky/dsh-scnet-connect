/**
 * 免客户端登录 · 网页短信登录（真正零客户端）
 * ------------------------------------------------------------------
 * 用户什么都不装，在插件设置页用**手机号 + 短信验证码**登录 `www.scnet.cn`；
 * 插件把登录结果换成平台会话 Cookie，再换成 model-service API Key。
 *
 * 端点、参数与成功判定全部取自平台自己的登录页
 * （`/ui/acm/assets/Login-*.js` + `index-*.js`），不是猜的：
 *
 *   POST /sso/captcha.action
 *        → `{code:'0', data:'data:image/jpeg;base64,…'}`
 *
 *   POST /sso/sendRegisterMessageCode.action        （发短信）
 *        表单：mobilephoneNum=+86…、captcha（图形验证码答案）、t、sn、createBy、siteCode…
 *        **成功判定：code === '0' 或 code === '1004'**
 *        平台前端原文：`if((c.code==="0"||c.code==="1004")&&(K.value=!0,…))`
 *        `1004` 的语义是「这个手机号已注册」——对**登录**来说它恰恰是好事，
 *        平台会切到「快捷登录」分支。把它当失败是本插件 v0.3.0 的误报。
 *
 *   POST /sso/auth/login.action                     （提交验证码换会话）
 *        表单：mobilephoneNum、messageCode、mode='2'、service、originalUrl、sensorsAnonId
 *        → `{code:'0', data:'<带 ticket 的跳转地址>'}`
 *
 * 图形验证码的 `t` / `sn` 来自平台 `et(phone)`：对 `+86<手机号>` 做 md5 + 时间戳 + 随机串，
 * 实测平台并不强制校验，因此这里带上同样形状的值即可（不带会偶发 3002）。
 *
 * 密码登录与扫码登录都不在插件里提供：
 *   · 密码要 RSA 加密后提交，安全性完全依赖插件进程，收益低于风险；
 *   · 扫码接口对非微信客户端恒 402（见 docs/scnet-api.md §9.4）。
 */

import crypto from 'node:crypto';

import { PLATFORM_BASE_URL } from './scnet-platform.js';

/** 网页登录后平台会把浏览器带到这个地址（与客户端同一套）。 */
const SSO_CALLBACK_PATH = '/ac/api/auth/loginSsoRedirect.action';

/** 登录页地址（用户可在浏览器里自行打开）。 */
export function webLoginUrl() {
  return `${PLATFORM_BASE_URL}/ui/acm/index.html#/login`;
}

/** 登录成功后与会话绑定的 service（必须与提交表单里的一致）。 */
function serviceUrl() {
  return `${PLATFORM_BASE_URL}${SSO_CALLBACK_PATH}`;
}

/** 与平台登录页一致的 UA（平台按 UA 走 PC 流程）。 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 发码接口把「手机号已注册」也当成功（平台前端 `validateCode: ['0','1004']`）。 */
const SMS_OK_CODES = new Set(['0', '1004']);

function encodeBody(fields) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }
  return params.toString();
}

/** 简易 Cookie 罐：登录流程必须复用同一个 jsessionid。 */
function createJar() {
  const store = new Map();
  return {
    absorb(response) {
      for (const raw of response.headers.getSetCookie?.() ?? []) {
        const [pair] = String(raw).split(';');
        const eq = pair.indexOf('=');
        if (eq <= 0) continue;
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        if (!value) store.delete(name);
        else store.set(name, value);
      }
    },
    header() {
      return [...store.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    get(name) {
      return store.get(name);
    },
    clear() {
      store.clear();
    },
  };
}

async function webPost(jar, path, body, { signal, timeoutMs = 20_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  try {
    const res = await fetch(`${PLATFORM_BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'user-agent': UA,
        referer: webLoginUrl(),
        origin: PLATFORM_BASE_URL,
        accept: 'application/json, text/plain, */*',
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        ...(jar.header() ? { cookie: jar.header() } : {}),
      },
      body,
      signal: controller.signal,
      redirect: 'manual',
    });
    jar.absorb(res);
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text, jar };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 平台登录页给图形验证码算的 `t` / `sn`（`et(phone)`）。
 * 实测不是强校验，但缺了会偶发 `3002 signature failed`，所以照抄形状。
 */
export function captchaSignature(phone) {
  const normalized = normalizePhone(phone);
  const t = Date.now();
  const sn = crypto.randomBytes(8).toString('hex');
  const md5Str = crypto.createHash('md5').update(`${normalized}${t}${sn}`).digest('hex');
  return { t, sn, md5Str };
}

/** `+86` + 11 位；已经是国际格式就原样保留。 */
export function normalizePhone(phone) {
  const raw = String(phone || '').replace(/[\s-]/g, '');
  const digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.length === 11) return `+86${digits}`;
  return digits;
}

/** 手机号基本形状校验（只挡明显错误，具体以平台为准）。 */
function isPlausiblePhone(phone) {
  const normalized = normalizePhone(phone);
  return /^\+?\d{6,15}$/.test(normalized);
}

/**
 * 一次网页登录会话：抓验证码 → 发短信 → 提交验证码换 Cookie。
 */
export function createWebLogin(options = {}) {
  const jar = createJar();
  const signal = options.signal;
  let lastTicket;
  /** 上一次发码用的手机号（提交时要与之一致）。 */
  let pendingPhone;

  /** 抓一张图形验证码（平台在短信登录/风控时要求）。 */
  async function captcha() {
    const res = await webPost(jar, '/sso/captcha.action', '', { signal });
    if (res.status !== 200 || !res.json || String(res.json.code) !== '0') {
      return { ok: false, reason: 'captcha-unavailable', message: res.json?.msg || `HTTP ${res.status}` };
    }
    const data = typeof res.json.data === 'string' ? res.json.data : '';
    if (!data.startsWith('data:image/')) return { ok: false, reason: 'captcha-unavailable' };
    return { ok: true, image: data };
  }

  /**
   * 发送手机验证码。
   *
   * `1004`（手机号已注册）是**成功**，不是失败 —— 见文件头注释。
   */
  async function sendSmsCode(phone, captchaCode) {
    if (!isPlausiblePhone(phone)) return { ok: false, reason: 'invalid-phone', message: '手机号格式不对' };
    const mobilephoneNum = normalizePhone(phone);
    const { t, sn, md5Str } = captchaSignature(mobilephoneNum);

    const res = await webPost(
      jar,
      '/sso/sendRegisterMessageCode.action',
      encodeBody({
        mobilephoneNum,
        captcha: captchaCode || md5Str,
        t,
        sn,
        createBy: 'scnet',
        siteCode: 'sacp',
        service: serviceUrl(),
        originalUrl: webLoginUrl(),
        sensorsAnonId: '',
      }),
      { signal },
    );

    const code = res.json ? String(res.json.code) : '';
    if (res.json && SMS_OK_CODES.has(code)) {
      pendingPhone = mobilephoneNum;
      // 1004 = 该手机号已注册 → 平台会走「快捷登录」，对登录来说完全正常。
      return { ok: true, registered: code === '1004', code };
    }
    return {
      ok: false,
      reason: mapSmsError(code, res.json?.msg),
      code,
      message: res.json?.msg || `HTTP ${res.status}`,
    };
  }

  /**
   * 提交短信验证码完成登录。
   *
   * @param {{ phone?: string, smsCode?: string, captcha?: string }} form
   */
  async function submit(form = {}) {
    const mobilephoneNum = normalizePhone(form.phone || pendingPhone);
    if (!isPlausiblePhone(mobilephoneNum)) {
      return { ok: false, reason: 'invalid-phone', message: '请填写手机号' };
    }
    if (!form.smsCode) {
      return { ok: false, reason: 'invalid-params', message: '请填写短信验证码' };
    }

    const res = await webPost(
      jar,
      '/sso/auth/login.action',
      encodeBody({
        service: serviceUrl(),
        originalUrl: webLoginUrl(),
        sensorsAnonId: '',
        captcha: form.captcha || '',
        mobilephoneNum,
        messageCode: form.smsCode,
        mode: '2',
      }),
      { signal, timeoutMs: 25_000 },
    );

    if (!res.json) {
      return { ok: false, reason: 'invalid-response', message: `HTTP ${res.status}` };
    }
    if (String(res.json.code) !== '0') {
      return {
        ok: false,
        reason: mapLoginError(String(res.json.code), res.json.msg),
        code: res.json.code,
        message: res.json.msg || '登录失败',
      };
    }

    // data 是带 ticket 的跳转地址：GET 它，让平台把 Token/jsessionid 下发到本 jar。
    const target = typeof res.json.data === 'string' && res.json.data ? res.json.data : '';
    if (target) {
      lastTicket = target;
      const follow = await followTicket(target);
      if (!follow.ok) return follow;
    }
    const cookies = readCookies();
    if (!cookies?.Token) {
      return {
        ok: false,
        reason: 'no-session-cookie',
        message: '平台返回登录成功，但没有下发会话 Cookie（可能是风控拦截）。',
      };
    }
    return { ok: true, cookies };
  }

  /** 跟随 ticket 跳转，收集平台下发的会话 Cookie。 */
  async function followTicket(target) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), 20_000);
    try {
      const url = target.startsWith('http')
        ? target
        : `${PLATFORM_BASE_URL}${target.startsWith('/') ? '' : '/'}${target}`;
      const res = await fetch(url, {
        headers: { 'user-agent': UA, ...(jar.header() ? { cookie: jar.header() } : {}) },
        redirect: 'manual',
        signal: controller.signal,
      });
      jar.absorb(res);
      const location = res.headers.get('location');
      if (location && res.status >= 300 && res.status < 400) {
        const next = location.startsWith('http')
          ? location
          : `${PLATFORM_BASE_URL}${location.startsWith('/') ? '' : '/'}${location}`;
        if (next.startsWith(PLATFORM_BASE_URL)) {
          const res2 = await fetch(next, {
            headers: { 'user-agent': UA, ...(jar.header() ? { cookie: jar.header() } : {}) },
            redirect: 'manual',
            signal: controller.signal,
          });
          jar.absorb(res2);
        }
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: 'network', message: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
    }
  }

  function readCookies() {
    const jsessionid = jar.get('jsessionid');
    const Token = jar.get('Token');
    if (!jsessionid && !Token) return undefined;
    return { ...(jsessionid ? { jsessionid } : {}), ...(Token ? { Token } : {}) };
  }

  return {
    captcha,
    sendSmsCode,
    submit,
    cookies: readCookies,
    reset: () => {
      jar.clear();
      pendingPhone = undefined;
    },
    lastRedirect: () => lastTicket,
  };
}

/** 发码错误码 → 插件判定（文案取自平台登录页字典）。 */
export function mapSmsError(code, message) {
  const text = String(message || '');
  switch (code) {
    case '1005':
      return 'too-frequent';
    case '1009':
      return 'captcha-invalid';
    case '3002':
      return 'captcha-invalid';
    case '1010':
      return 'virtual-number';
    case '429':
      return 'too-many-attempts';
    default:
      if (/频繁|too frequent|too often/i.test(text)) return 'too-frequent';
      if (/虚拟|virtual/i.test(text)) return 'virtual-number';
      if (/验证码|captcha/i.test(text)) return 'captcha-invalid';
      return 'rejected';
  }
}

/** 登录错误码 → 插件判定（平台码表见网页 `Login-*.js`）。 */
export function mapLoginError(code, message) {
  const text = String(message || '');
  switch (code) {
    case '1004':
      // 对登录来说 1004 不是错误；真出现时按「账号问题」提示，不要误导成失败。
      return 'auth-failed';
    case '1005':
      return 'auth-failed';
    case '1009':
    case '3002':
      return 'captcha-invalid';
    case '1006':
      return 'invalid-params';
    case '1001':
      return 'server-busy';
    case '429':
      return 'too-many-attempts';
    default:
      if (/too many|频繁|次数/i.test(text)) return 'too-many-attempts';
      if (/验证码|captcha/i.test(text)) return 'captcha-invalid';
      return 'rejected';
  }
}

/**
 * 把网页登录结果（Cookie 罐）转成 `scnet-login.js` 需要的会话。
 *
 * @param {{ cookies: object }} result
 */
export function sessionFromWebLogin(result) {
  return result?.cookies ?? undefined;
}
