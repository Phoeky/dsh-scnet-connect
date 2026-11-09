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

/** 图形验证码签名的固定盐（来自平台前端 `AY()`）。 */
const CAPTCHA_SALT = '20250207';
/** 随机串字符集（与平台前端一致）。 */
const CAPTCHA_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * 平台登录页给图形验证码算的 `t` / `sn` / `md5Str`（前端 `AY(phone)`）：
 *
 *   const r = Date.now();
 *   const a = 10 位随机串（字符集 0-9a-zA-Z）;
 *   md5Str = MD5(phone + r + a + '20250207')
 *
 * 用户没填图形验证码时，平台前端就把这个 `md5Str` 当 `captcha` 传上去。
 * 之前按「md5(phone+时间戳+随机串)」算，少了固定盐，于是稳定 3002 signature failed。
 */
export function captchaSignature(phone) {
  const normalized = normalizePhone(phone);
  const timestamp = Date.now();
  let randomString = '';
  for (let i = 0; i < 10; i += 1) {
    randomString += CAPTCHA_ALPHABET.charAt(Math.floor(Math.random() * CAPTCHA_ALPHABET.length));
  }
  const md5Str = crypto
    .createHash('md5')
    .update(`${normalized}${timestamp}${randomString}${CAPTCHA_SALT}`)
    .digest('hex');
  return { timestamp, randomString, md5Str };
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
  /** 上一次发码用的手机号（提交时要与之一致）。 */
  let pendingPhone;
  /**
   * 上一条短信码发给的号是否已注册（`sendSmsCode` 写入，`submit` 读取）。
   *
   * `undefined` = 还没发过码，不知道；`true`/`false` = 平台明确告知过。
   */
  let pendingRegistered;

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
   * 返回值里的 `registered` 是**后续分派通道的依据**，不能丢：
   *
   *   code === '1004' → 该手机号已注册 → 提交时走 `/sso/auth/login.action`
   *   code === '0'    → 该手机号未注册 → 提交时走 `/sso/registerByMobilephoneNum.action`
   *
   * 平台前端就是这么做的（`Login-*.js` 里 `T.value="phone"` / `"quick"`）。
   * 早期版本把两者都当「成功」但**没记住区别**，对未注册号仍调登录接口，
   * 平台查无此人 → `401 Username or password is incorrect` —— 用户看到的是
   * 密码错误，实际原因却是「这个手机号没有账号」。
   */
  async function sendSmsCode(phone, captchaCode) {
    if (!isPlausiblePhone(phone)) return { ok: false, reason: 'invalid-phone', message: '手机号格式不对' };
    const mobilephoneNum = normalizePhone(phone);
    const { timestamp, randomString, md5Str } = captchaSignature(mobilephoneNum);

    const res = await webPost(
      jar,
      '/sso/sendRegisterMessageCode.action',
      encodeBody({
        mobilephoneNum,
        // 用户填了图形验证码就用它；没填就用平台那套签名（前端同样这么做）。
        captcha: captchaCode || md5Str,
        t: timestamp,
        sn: randomString,
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
      /** 记住这个号注册没注册，`submit()` 要用它选通道。 */
      pendingRegistered = code === '1004';
      return { ok: true, registered: pendingRegistered, code };
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

    /**
     * 按发码时平台告知的注册状态选通道。
     *
     * 这一步是整套免客户端登录能否覆盖「新用户」的关键：
     *   · 已注册号 → `/sso/auth/login.action`（mode=2 快捷登录）
     *   · 未注册号 → `/sso/registerByMobilephoneNum.action`（注册即登录）
     *
     * 两者拿到的 `data` 都是带 ticket 的跳转地址，后续处理完全一致。
     *
     * `pendingRegistered` 为 `undefined`（没发过码，或用户直接提交）时退回登录
     * 接口：平台对已注册号必然成功；对未注册号会回 401，届时错误信息已由
     * `mapLoginError` + `translatePlatformMessage` 翻成可读中文。
     */
    const viaRegister = pendingRegistered === false;
    const path = viaRegister ? '/sso/registerByMobilephoneNum.action' : '/sso/auth/login.action';

    const fields = viaRegister
      ? {
          mobilephoneNum,
          messageCode: form.smsCode,
          // 注册接口把这几项当必填（缺 createBy 会 400）。
          createBy: 'scnet',
          siteCode: 'sacp',
          invitationCode: '',
          fullName: '',
          institution: '',
          service: serviceUrl(),
          originalUrl: webLoginUrl(),
          sensorsAnonId: '',
        }
      : {
          service: serviceUrl(),
          originalUrl: webLoginUrl(),
          sensorsAnonId: '',
          captcha: form.captcha || '',
          mobilephoneNum,
          messageCode: form.smsCode,
          mode: '2',
        };

    const res = await webPost(jar, path, encodeBody(fields), { signal, timeoutMs: 25_000 });

    if (!res.json) {
      return { ok: false, reason: 'invalid-response', message: `HTTP ${res.status}` };
    }
    if (String(res.json.code) !== '0') {
      return {
        ok: false,
        reason: mapLoginError(String(res.json.code), res.json.msg),
        code: res.json.code,
        message: res.json.msg || (viaRegister ? '注册失败' : '登录失败'),
        /** 便于上层区分「注册通道失败」与「登录通道失败」。 */
        via: viaRegister ? 'register' : 'login',
      };
    }

    // data 是带 ticket 的跳转地址：GET 它，让平台把 Token/jsessionid 下发到本 jar。
    const target = typeof res.json.data === 'string' && res.json.data ? res.json.data : '';
    if (target) {
      const follow = await followTicket(target);
      if (!follow.ok) return follow;
    }
    const cookies = readCookies();
    if (!cookies?.Token) {
      return {
        ok: false,
        reason: 'no-session-cookie',
        message: '平台返回成功，但没有下发会话 Cookie（可能是风控拦截）。',
      };
    }
    // 到此为止这个号一定已经在平台上存在了。
    pendingRegistered = true;
    return { ok: true, cookies, via: viaRegister ? 'register' : 'login' };
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

/**
 * 登录错误码 → 插件判定（平台码表见网页 `Login-*.js` 的 `Ce` 表）。
 *
 * 平台对「短信验证码提交」的 `mode=2` 分支实测只会回 1009 / 1005 / 1004 / 3002；
 * 但**密码**分支（`mode=0`）会回 `401 Username or password is incorrect`。
 * v1.1.1 及更早版本的表里没有 `401`，于是它落到 `default` 被归成 `rejected`，
 * 提示文案直接回退成平台那串英文原文 —— 用户在设置页看到
 * 「Username or password is incorrect」却明明是在用短信登录，正是这个缺口。
 *
 * 因此这里补上 `401`/`1008` 分支，并给 `default` 加英文兜底识别：
 * 不管平台以后新增什么码，都不该把英文原文直接甩给用户。
 */
export function mapLoginError(code, message) {
  const text = String(message || '');
  switch (code) {
    case '401':
      // 平台密码分支的「账号或密码错」。短信登录收到它说明提交没被当成 mode=2，
      // 归到 auth-failed，由上层给出可操作的中文提示。
      return 'auth-failed';
    case '1004':
      // 对登录来说 1004 不是错误；真出现时按「账号问题」提示，不要误导成失败。
      return 'auth-failed';
    case '1005':
      return 'auth-failed';
    case '1008':
      return 'user-not-exist';
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
      if (/username or password/i.test(text)) return 'auth-failed';
      if (/user (not exist|does not exist)|not registered/i.test(text)) return 'user-not-exist';
      if (/expired|过期/i.test(text)) return 'captcha-invalid';
      if (/验证码|captcha/i.test(text)) return 'captcha-invalid';
      return 'rejected';
  }
}

/**
 * 把平台英文原文翻成中文，保证设置页永远不出现英文报错。
 *
 * 平台很多接口的 `msg` 是英文（`Username or password is incorrect`、
 * `Invalid parameters`…），而插件此前只对**已知码**给中文、
 * 未知码直接把原文抛给用户。这里做最后一道兜底。
 *
 * @param {string} message 平台原始 msg
 * @returns {string} 中文提示；无匹配时给出通用文案
 */
export function translatePlatformMessage(message) {
  const text = String(message || '').trim();
  if (!text) return '';
  // 已经是中文就不用再翻。
  if (/[\u4e00-\u9fa5]/.test(text)) return text;
  if (/username or password/i.test(text)) return '平台把这次提交当成了「账号密码登录」，请重新获取短信验证码再试';
  if (/invalid verification code|code has expired/i.test(text)) return '短信验证码不正确或已失效，请重新获取';
  if (/invalid parameters/i.test(text)) return '提交参数不完整，请检查手机号与验证码';
  if (/too often|too frequent|in 60 seconds/i.test(text)) return '发送太频繁，请稍后再试';
  if (/virtual/i.test(text)) return '不支持虚拟号段';
  if (/not exist|not registered/i.test(text)) return '该手机号尚未注册 SCNet 账号';
  if (/too many/i.test(text)) return '尝试次数过多，请稍后再试';
  if (/signature failed/i.test(text)) return '图形验证码签名校验失败，请刷新验证码';
  return '平台拒绝了这次登录请求，请稍后重试';
}
