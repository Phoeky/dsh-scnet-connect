/**
 * 免客户端登录（零客户端路径）
 * ------------------------------------------------------------------
 * 目标：**不安装、不运行 SCNet 桌面客户端**也能登录并使用模型服务。
 *
 * 登录方式只保留一条：**手机号 + 短信验证码**（`www.scnet.cn` 上的纯 HTTP 接口）。
 * 用户在设置卡片里填手机号、取图形验证码、发送短信、填短信码，插件拿回平台会话
 * Cookie → 换 model-service API Key，并以 0600 权限落到
 * `$DSH_HOME/scnet-session.json`。
 *
 * 为什么只有这一条：
 *   · 账号密码要 RSA 加密后提交，密码必须经过插件进程，收益低于风险；
 *   · 微信扫码接口对非微信客户端恒 402（见 docs/scnet-api.md §9.4），做不了。
 *
 * 状态机（内存）：
 *   idle → pending → authorized | failed
 * `pending` 阶段已发出短信，等待用户回填验证码。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  PENDING_TTL_MS,
  ensureApiKey,
  logout,
  normalizeCookies,
  resolveSession,
  sessionFilePath,
  webLoginUrl,
} from './scnet-platform.js';
import { createWebLogin, mapLoginError, translatePlatformMessage } from './scnet-web-login.js';
import { maskKey } from './scnet-credential.js';

/** 平台会话换来的 key 缓存 6 天；过期或被清空时自动重换。 */
const KEY_TTL_MS = 6 * 24 * 60 * 60 * 1000;

function readSessionFile(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object') return undefined;
    const cookies = normalizeCookies(raw.cookies);
    if (!cookies) return undefined;
    return {
      cookies,
      apiKey: typeof raw.apiKey === 'string' && raw.apiKey.startsWith('sk-') ? raw.apiKey : undefined,
      baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : undefined,
      account: raw.account && typeof raw.account === 'object' ? raw.account : undefined,
      obtainedAt: typeof raw.obtainedAt === 'string' ? raw.obtainedAt : undefined,
      keyedAt: typeof raw.keyedAt === 'string' ? raw.keyedAt : undefined,
      expiresAt: typeof raw.expiresAt === 'string' ? raw.expiresAt : undefined,
      source: 'web',
    };
  } catch {
    return undefined;
  }
}

/**
 * 写会话文件：先写同目录临时文件再 rename，并且**创建时**就按 0600 打开，
 * 避免出现「宽权限 + 有 key」的瞬间。
 */
function writeSessionFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const handle = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(handle, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // Windows 上 chmod 只动只读位；0600 已在 open 时生效。
  }
  fs.renameSync(tmp, file);
}

/** 拿到 key 之后 6 天内不重复向平台要 key。 */
function isStale(session) {
  if (!session?.expiresAt) return false;
  const expires = Date.parse(session.expiresAt);
  if (!Number.isFinite(expires)) return false;
  return expires - Date.now() < 60 * 60 * 1000;
}

/**
 * @param {{ logger?: { info: (m: string) => void, warn: (m: string) => void }, env?: Record<string, string | undefined> }} options
 */
export function createLoginManager(options = {}) {
  const file = sessionFilePath(options.env);
  const logger = options.logger ?? { info() {}, warn() {} };
  let session = readSessionFile(file);
  /** 当前正在进行的网页登录表单会话。 */
  let webLogin;
  let pending;
  // 有 Cookie 但没有 key 的会话（例如上次换 Key 失败）不能算「已登录」：
  // 否则设置页会显示「已登录」却没有任何可用 Key。等 ensureKey 成功后再转 authorized。
  let phase = session ? (session.apiKey ? 'authorized' : 'failed') : 'idle';
  let lastError =
    session && !session.apiKey
      ? '登录会话已存在，但还没有换取模型 Key；请点「检查登录」或重新登录一次。'
      : undefined;
  /**
   * 最近一次登录失败的原始码与原文（诊断用）。
   *
   * 界面只显示中文提示；但「平台到底回了什么」是排查这类
   * 「明明是短信登录却收到密码错误」问题的唯一线索，必须留下来。
   */
  let lastFailure;
  let inflight;
  let lastValidatedAt = 0;
  /**
   * 会话代次。每次登录/退出都 +1，在飞的异步换 key 用它判断
   * 「我出发时的那个会话还算不算数」——避免退出后把会话又写回来。
   */
  let epoch = 0;

  if (session) {
    logger.info(`已加载免客户端会话（短信登录，key=${session.apiKey ? maskKey(session.apiKey) : '未获取'}）`);
  }

  function snapshot() {
    return {
      phase,
      source: session?.source,
      account: session?.account,
      maskedKey: session?.apiKey ? maskKey(session.apiKey) : undefined,
      obtainedAt: session?.obtainedAt,
      keyedAt: session?.keyedAt,
      expiresAt: session?.expiresAt,
      lastValidatedAt: lastValidatedAt ? new Date(lastValidatedAt).toISOString() : undefined,
      pending: pending ? { startedAt: pending.startedAt, expiresAt: pending.expiresAt } : undefined,
      error: lastError,
      /** 原始失败信息（码 + 平台原文），供诊断；不含任何凭据。 */
      lastFailure,
      loginPageUrl: webLoginUrl(),
    };
  }

  function persist(next) {
    session = next;
    writeSessionFile(file, next);
    phase = 'authorized';
    lastError = undefined;
    webLogin = undefined;
    pending = undefined;
  }

  /**
   * 带代次检查的落盘：如果落盘前会话已被「退出登录」或新一轮登录换掉，
   * 就丢弃这次结果（否则会把已清掉的会话文件重新写回来）。
   *
   * @returns {boolean} 是否真的写入了
   */
  function persistIfCurrent(next, startedAtEpoch) {
    if (startedAtEpoch !== epoch) return false;
    persist(next);
    return true;
  }

  function fail(reason) {
    phase = 'failed';
    lastError = reason;
    return { ok: false, error: reason, ...snapshot() };
  }

  /**
   * 会话到手后立刻换 API Key。失败时保留会话（用户不必重新登录）。
   *
   * @param {'register' | 'login'} [via] 这条会话是「自动注册」还是「登录」拿到的
   */
  async function finishAuthorization(raw, signal, via) {
    const startedAt = epoch;
    // 带上 accountId：新账号首次换 key 会回「模型服务尚未开通」，
    // ensureApiKey 需要用它在平台侧开通服务后重试。
    const accountId = raw.account?.id ?? raw.account?.accountId ?? raw.account?.userId;
    const keyed = await ensureApiKey({ cookies: raw.cookies, accountId, signal });
    // 换 key 期间用户又点了退出/重新登录：这次结果不再代表当前意图。
    if (startedAt !== epoch) return { ok: false, error: '登录已被取消', ...snapshot() };
    if (!keyed.ok) {
      persist({ ...raw, apiKey: undefined });
      phase = 'failed';
      lastError = keyed.reason === 'expired' ? '登录已过期，请重新登录' : keyed.message || '平台未返回模型服务 Key';
      return { ok: false, error: lastError, ...snapshot() };
    }
    const now = new Date();
    persist({
      ...raw,
      apiKey: keyed.key,
      baseUrl: keyed.baseUrl,
      keyedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + KEY_TTL_MS).toISOString(),
    });
    lastValidatedAt = now.getTime();
    logger.info(
      `免客户端登录完成：${raw.account?.userName || raw.account?.userId || '未知账号'}（${
        via === 'register' ? '短信登录 · 已自动注册新账号' : '短信登录'
      }，key=${maskKey(keyed.key)}）`,
    );
    // `via` 必须带出去：设置页用它区分「普通登录」和「这次顺带注册了新账号」，
    // 否则自动注册提示永远不会出现。
    return { ok: true, ...(via ? { via } : {}), ...snapshot() };
  }

  /** 把任意会话来源收敛成「验证身份 → 换 key」。 */
  async function authorizeFromCookies(cookies, source, signal, via) {
    const verified = await resolveSession({ cookies, signal });
    if (!verified.ok) {
      return fail(
        verified.reason === 'expired'
          ? '平台会话立即失效了，请重新登录'
          : `平台会话校验失败（${verified.reason}）`,
      );
    }
    return finishAuthorization(
      {
        cookies: verified.cookies,
        account: verified.user,
        obtainedAt: new Date().toISOString(),
        source,
      },
      signal,
      via,
    );
  }

  return {
    snapshot,
    sessionFilePath: () => file,

    /** 当前可用的 key（可能来自缓存）。 */
    currentKey() {
      return session?.apiKey;
    },

    /** 会话是否存在（决定「客户端 / 免客户端」自动来源时用）。 */
    hasSession() {
      return Boolean(session);
    },

    /** 需要时现取 key：给 provider 的 `resolve()` 用。 */
    async ensureKey(signal) {
      if (!session) return undefined;
      if (session.apiKey && phase === 'authorized' && !isStale(session)) return session.apiKey;
      if (inflight) return inflight;
      const startedAt = epoch;
      inflight = (async () => {
        const verified = await resolveSession({ cookies: session.cookies, signal });
        // 退出/重登之后到达的结果一律丢弃。
        if (startedAt !== epoch) return undefined;
        if (!verified.ok) {
          phase = verified.reason === 'expired' ? 'expired' : 'failed';
          lastError = verified.reason === 'expired' ? '平台会话已过期，请重新登录' : `平台会话不可用（${verified.reason}）`;
          return undefined;
        }
        lastValidatedAt = Date.now();
        const renewId =
          verified.user?.id ?? verified.user?.accountId ?? session.account?.id ?? session.account?.accountId;
        const keyed = await ensureApiKey({ cookies: verified.cookies, accountId: renewId, signal });
        if (startedAt !== epoch) return undefined;
        if (!keyed.ok) {
          phase = 'failed';
          lastError = keyed.message || '获取模型服务 Key 失败';
          return undefined;
        }
        const wrote = persistIfCurrent(
          {
            ...session,
            cookies: verified.cookies,
            apiKey: keyed.key,
            baseUrl: keyed.baseUrl,
            keyedAt: new Date().toISOString(),
            account: { ...(session.account ?? {}), ...(verified.user ?? {}) },
            expiresAt: new Date(Date.now() + KEY_TTL_MS).toISOString(),
          },
          startedAt,
        );
        // 会话已被换掉：不要把它交回去，否则调用方会拿着一个「已退出」的 key。
        return wrote ? keyed.key : undefined;
      })()
        .catch(() => undefined)
        .finally(() => {
          inflight = undefined;
        });
      return inflight;
    },

    /** 图形验证码（短信登录/风控时用）。返回 data URL，不落盘。 */
    async captcha() {
      try {
        if (!webLogin) webLogin = createWebLogin();
        const result = await webLogin.captcha();
        // 平台/网络层可能回英文或 HTTP 状态码；设置页不该出现英文原文。
        return result && result.ok === false && result.message
          ? { ...result, message: translatePlatformMessage(result.message) || result.message }
          : result;
      } catch (error) {
        logger.warn(`获取图形验证码失败：${error instanceof Error ? error.message : String(error)}`);
        return { ok: false, reason: 'network', message: '获取图形验证码失败：网络连接异常，请稍后重试' };
      }
    },

    /** 发送短信验证码。 */
    async sendSmsCode(phone, captchaCode) {
      try {
        if (!webLogin) webLogin = createWebLogin();
        const result = await webLogin.sendSmsCode(phone, captchaCode);
        return result && result.ok === false && result.message
          ? { ...result, message: translatePlatformMessage(result.message) || result.message }
          : result;
      } catch (error) {
        logger.warn(`发送短信验证码失败：${error instanceof Error ? error.message : String(error)}`);
        return { ok: false, reason: 'network', message: '发送短信验证码失败：网络连接异常，请稍后重试' };
      }
    },

    /**
     * 提交短信验证码完成登录。
     *
     * @param {{ phone?: string, smsCode?: string, captcha?: string, signal?: AbortSignal }} form
     */
    async loginWithSms(form = {}) {
      if (!webLogin) webLogin = createWebLogin();
      phase = 'pending';
      lastError = undefined;
      pending = { startedAt: Date.now(), expiresAt: new Date(Date.now() + PENDING_TTL_MS).toISOString() };
      try {
        const result = await webLogin.submit({
          phone: form.phone,
          smsCode: form.smsCode,
          captcha: form.captcha,
        });
        if (!result.ok) {
          const mapped = result.code ? mapLoginError(String(result.code), result.message) : result.reason;
          const message =
            mapped === 'captcha-invalid'
              ? '短信验证码不正确或已失效，请重新获取'
              : mapped === 'auth-failed'
                ? translatePlatformMessage(result.message) || '手机号或验证码不正确'
                : mapped === 'user-not-exist'
                  ? '该手机号尚未注册 SCNet 账号，请先在平台注册'
                  : mapped === 'invalid-params'
                    ? '参数不完整，请检查手机号/验证码'
                    : mapped === 'too-many-attempts'
                      ? '尝试次数过多，请稍后再试'
                      : mapped === 'server-busy'
                        ? '平台繁忙，请稍后重试'
                        // 兜底也要说人话：平台原文多是英文，不能直接甩给用户。
                        : translatePlatformMessage(result.message) || '登录失败';
          // 记下原始码与原文，供状态文件/诊断用（界面只显示上面的中文）。
          lastFailure = {
            code: result.code !== undefined ? String(result.code) : undefined,
            rawMessage: result.message,
            reason: result.reason,
            at: new Date().toISOString(),
          };
          // 验证码/风控状态可能需要重开表单。
          if (mapped === 'too-many-attempts' || mapped === 'captcha-invalid') webLogin = undefined;
          pending = undefined;
          return fail(message);
        }
        return await authorizeFromCookies(result.cookies, 'web', form.signal, result.via);
      } catch (error) {
        // 网络层异常（fetch 抛错、落盘失败）不能冒到路由变成英文 500，
        // 也不能把 phase 永远留在 pending —— 用户会一直看到「登录中…」。
        logger.warn(`短信登录请求异常：${error instanceof Error ? error.message : String(error)}`);
        pending = undefined;
        return fail('登录失败：网络连接异常，请检查网络后重试');
      }
    },

    /** 平台会话是否还活着。 */
    async validate(signal) {
      if (!session) return { ok: false, reason: 'no-session', ...snapshot() };
      try {
        const verified = await resolveSession({ cookies: session.cookies, signal });
        if (!verified.ok) {
          phase = verified.reason === 'expired' ? 'expired' : 'failed';
          lastError = verified.reason === 'expired' ? '平台会话已过期，请重新登录' : `平台会话不可用（${verified.reason}）`;
          return { ok: false, reason: verified.reason, ...snapshot() };
        }
        lastValidatedAt = Date.now();
        persist({ ...session, cookies: verified.cookies, account: { ...(session.account ?? {}), ...verified.user } });
        return { ok: true, ...snapshot() };
      } catch (error) {
        logger.warn(`检查登录失败：${error instanceof Error ? error.message : String(error)}`);
        phase = 'failed';
        lastError = '检查登录失败：网络连接异常，请稍后重试';
        return { ok: false, error: lastError, ...snapshot() };
      }
    },

    /**
     * 退出：清本地 + 尽力通知平台。
     *
     * 两点必须做对：
     *   1. 作废正在飞的 `ensureKey()`。它可能正卡在平台上换 key，退出后如果让它
     *      跑完 `persist()`，会话文件会被重新写回来 —— 那就成了「退出不掉」。
     *   2. 明确告知调用方「登录会话已清空」而不是「key 已失效」。`sk-` 是账号级
     *      凭据、和桌面客户端共用，平台没有吊销接口，本地也删不掉客户端的那份。
     */
    async signOut() {
      const cookies = session?.cookies;
      // 让所有在飞的换 key 结果作废（epoch 一变，persist 前的检查就会丢弃）。
      epoch += 1;
      inflight = undefined;
      session = undefined;
      webLogin = undefined;
      pending = undefined;
      phase = 'idle';
      lastError = undefined;
      lastValidatedAt = 0;
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // 删不掉也不影响内存态。
      }
      if (cookies) await logout({ cookies });
      logger.info('已退出免客户端登录（本地会话已清除）');
      return snapshot();
    },
  };
}

