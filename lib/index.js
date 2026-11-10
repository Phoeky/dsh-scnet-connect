/**
 * dsh-scnet-connect（SCNet Connect）—— 把 SCNet 的
 * 免费模型接入 DeepSeek Harness。
 *
 * 设计
 * ----
 * SCNet 客户端的模型网关是标准 OpenAI Chat Completions 兼容端点
 * （`https://api.scnet.cn/api/llm/v1`），因此本插件**不需要** loopback shim，
 * 也不做任何协议转换。插件做四件事：
 *
 *   1. 从本机 SCNet 客户端的数据目录里读取「模型服务 API Key」；
 *   2. 从客户端模型目录里挑出**当前账号可用的全部免费模型**（不再写死 SCNet-Max）；
 *   3. 用 `@deepseek-ai/dsh-llm-pi-ai` 的 `PiAiAdapter` 注册一个 provider
 *      （默认 id `scnet`），每个免费模型一条模型描述符；
 *   4. 每次请求时重新读取凭据文件，客户端轮换 key 后无需重启 DSH。
 *
 * 设置界面
 * --------
 * 宿主（Host）在 `/plugins/dsh-scnet-connect/status` 暴露只读状态、在
 * `/plugins/dsh-scnet-connect/refresh` 暴露「刷新模型」；浏览器侧（`lib/client.js`）
 * 把这两条路由渲染成设置页里的一个 section（账号 / 凭据 / 模型列表 / 刷新按钮）。
 * 路由不含 key 明文，只返回掩码。
 *
 * 与 dsh-connect-trae / dsh-connect-qoder 的关系
 * ----------------------------------------------
 * 思路相同（本机已登录客户端的凭据 → 直接注册成 DSH 模型 provider），但
 * trae/qoder 的上游是非标准协议，需要 bridge + loopback shim；SCNet 是标准
 * OpenAI 兼容端点，所以这里只保留「发现凭据 + 声明模型 + 注册 adapter」这一层。
 */

import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import { createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import z from '@deepseek-ai/schemastery';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { maskKey, readClientAccount, resolveApiKey } from './scnet-credential.js';
import { createModelCatalog } from './scnet-catalog.js';
import { createRetryFriendlyFetch, withRetryFriendlyFetch } from './scnet-fetch.js';
import { createLoginManager } from './scnet-login.js';
import { DEFAULT_BASE_URL, DEFAULT_MODEL_ID, buildModel, modelLabel } from './scnet-models.js';

/** 本插件注册的 provider 路由名（模型选择器里显示为此分组）。 */
export const PROVIDER_ID = 'scnet';
/** 模型选择器里的分组名。 */
export const PROVIDER_NAME = 'SCNet Connect';
/** 浏览器侧设置页使用的 HTTP 路由前缀。 */
export const ROUTE_PREFIX = '/plugins/dsh-scnet-connect';
/** 单条流允许的最大空闲时间。 */
const STREAM_IDLE_TIMEOUT_MS = 300_000;
/** 设置页请求体上限（只会发很小的 JSON；超过按 413 拒绝）。 */
const MAX_JSON_BODY_BYTES = 64 * 1024;
/** 与 pi-ai 约定的图片预算（SCNet 支持图片输入）。 */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
};

export const name = 'dsh-scnet-connect';
/**
 * 只声明 `llm`。
 *
 * `attachments` / `fs` 不放进 inject：它们是**可选**服务，headless/TUI profile
 * 里可能没挂载，声明成必需会让整个插件在那些 profile 里加载失败。
 * 核心的 `llm-pi-ai` 也是同样做法（inject 只有 llm），图片相关服务在
 * `resolveAttachments` 里惰性 `ctx.get()`。
 */
export const inject = ['llm'];

/**
 * 插件配置。
 *
 * 默认值就是「零配置可用」：客户端装好、登录过、发过消息，插件就能用，
 * 并自动注册客户端目录里所有免费模型。
 * 其余字段都只是逃生口（自定义目录 / 覆盖凭据 / 指定模型 / 调上下文预算）。
 */
export const Config = z.object({
  credentialDir: z
    .string()
    .default('')
    .description('SCNet model-service 凭据目录（默认 ~/.sclaw/agent/scnet-credentials）'),
  apiKey: z
    .string()
    .default('')
    .description('直接指定 model-service API Key（留空则自动读取本机 SCNet 客户端凭据）'),
  baseUrl: z
    .string()
    .default(DEFAULT_BASE_URL)
    .description('SCNet OpenAI 兼容网关根地址'),
  modelIds: z
    .string()
    .default('')
    .description('要注册的模型 id，逗号分隔（留空 = 自动注册客户端目录里所有免费模型）'),
  modelId: z
    .string()
    .default('')
    .description('[已弃用] 等价于只有一个元素的 modelIds；留空表示自动发现'),
  modelName: z
    .string()
    .default('')
    .description('模型显示名（仅在只注册一个模型时生效；留空则用客户端目录里的名字）'),
  contextWindow: z
    .number()
    .default(0)
    .description('覆盖上下文窗口（0 = 跟随 SCNet 客户端目录 / 内置默认值；对全部模型生效）'),
  maxTokens: z
    .number()
    .default(0)
    .description('覆盖最大输出 token（0 = 跟随客户端目录 / 内置默认值；对全部模型生效）'),
  inputImages: z
    .boolean()
    .default(true)
    .description('是否向 DSH 声明这些模型接受图片输入'),
  reasoning: z
    .boolean()
    .default(true)
    .description('是否声明这些模型支持思考等级（SCNet 模型会返回 reasoning_content）'),
  verifyWithGateway: z
    .boolean()
    .default(true)
    .description('刷新模型时用网关 GET /models 校验可用性（关闭后只读本地客户端目录）'),
  retryOnTransientErrors: z
    .boolean()
    .default(true)
    .description(
      '把 SCNet「5xx 但响应体标成 invalid_request」的瞬时抖动改写成可重试的服务端错误，交给 DSH 退避重试（关闭后这类 503 会直接失败）',
    ),
  freeOnly: z
    .boolean()
    .default(true)
    .description(
      '只注册免费模型（priceLabel=free）。默认开启；关闭后会把客户端目录里的全部模型都注册出来，计费按平台规则走',
    ),
  credentialSource: z
    .union([z.const('auto'), z.const('client'), z.const('login')])
    .default('auto')
    .description(
      '凭据来源：client = 只读 SCNet 客户端凭据；login = 只用设置页的免客户端登录；auto = 先客户端、再免客户端',
    ),
});

/**
 * 「没有凭据生命周期」的空认证面。
 *
 * `PiAiAdapterOptions.auth` 必填；不给的话 pi-ai 会自己探测环境变量，可能
 * 凭空造出一个凭据。本插件的凭据完全来自 SCNet 客户端文件，这里显式堵住。
 */
const INERT_AUTH = {
  credentials: {
    async read() {
      return undefined;
    },
    async list() {
      return [];
    },
    async modify() {
      throw new Error('dsh-scnet-connect: the scnet route has no pi-ai credential lifecycle');
    },
    async delete() {
      return undefined;
    },
  },
  authContext: {
    async env() {
      return undefined;
    },
    async fileExists() {
      return false;
    },
  },
};

/** `a,b, c` → `['a','b','c']`。 */
function parseModelIds(...values) {
  const ids = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    for (const part of value.split(',')) {
      const id = part.trim();
      if (id && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

/**
 * 给 route handler 用的 JSON 响应。
 *
 * `head` 为真时只发头、不发体：HEAD 请求带 body 既违反语义，也会让
 * `content-length` 与实际传输长度对不上（抓包工具会报协议错误）。
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {any} body
 * @param {{ head?: boolean }} [options]
 */
function sendJson(res, status, body, options = {}) {
  const payload = `${JSON.stringify(body, null, 2)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  if (options.head) {
    res.end();
    return;
  }
  res.end(payload);
}

/** 本插件的 `$DSH_HOME`（与 DSH 自身一致：环境变量优先，否则 ~/.dsh）。 */
function dshHome() {
  return process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh');
}

/**
 * 当前 profile 名（诊断文件名用它区分实例）。
 *
 * `DSH_PROFILE` 由 DSH 启动器注入；拿不到时退回空串，文件名保持旧形状。
 */
function dshProfileName() {
  const raw = process.env.DSH_PROFILE?.trim() || '';
  return raw.replace(/[^\w.-]/g, '_');
}

/**
 * @param {any} ctx cordis context
 * @param {any} config 由 Config schema 校验后的配置
 */
export async function apply(ctx, config) {
  const options = {
    credentialDir: typeof config?.credentialDir === 'string' ? config.credentialDir : '',
    apiKey: typeof config?.apiKey === 'string' ? config.apiKey : '',
    baseUrl: (typeof config?.baseUrl === 'string' && config.baseUrl.trim()) || DEFAULT_BASE_URL,
    modelIds: parseModelIds(config?.modelIds, config?.modelId),
    modelName: typeof config?.modelName === 'string' ? config.modelName : '',
    contextWindow: typeof config?.contextWindow === 'number' ? config.contextWindow : 0,
    maxTokens: typeof config?.maxTokens === 'number' ? config.maxTokens : 0,
    inputImages: config?.inputImages !== false,
    reasoning: config?.reasoning !== false,
    verifyWithGateway: config?.verifyWithGateway !== false,
    retryOnTransientErrors: config?.retryOnTransientErrors !== false,
    freeOnly: config?.freeOnly !== false,
  };

  /**
   * 设置页可写的偏好（**持久化**）。
   *
   * 目前只有「只显示免费模型」。这个开关是运行时切换的，但用户按过一次之后
   * 期望它一直生效；只放内存的话重启 DSH 就悄悄回到配置默认值，
   * 用户看到的现象是「我关掉的开关自己回来了」。
   *
   * 优先级：设置页写入的偏好 > 配置文件里的 `freeOnly` > 内置默认（true）。
   * 想回到配置文件的值，删掉 `$DSH_HOME/scnet-connect-preferences.json` 即可。
   */
  const preferencesFile = () => path.join(dshHome(), 'scnet-connect-preferences.json');
  function readPreferences() {
    try {
      const raw = JSON.parse(fs.readFileSync(preferencesFile(), 'utf8'));
      return raw && typeof raw === 'object' ? raw : {};
    } catch {
      return {};
    }
  }
  function writePreferences(patch) {
    try {
      const file = preferencesFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const next = { ...readPreferences(), ...patch, updatedAt: new Date().toISOString() };
      fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    } catch {
      // 写不了不影响本次运行；只是重启后会丢这次切换。
    }
  }
  const storedPreferences = readPreferences();
  /** 生效的「只注册免费模型」：设置页写过的值优先于配置文件。 */
  const initialFreeOnly =
    typeof storedPreferences.freeOnly === 'boolean' ? storedPreferences.freeOnly : options.freeOnly;

  /**
   * 「用户主动停用」开关（**持久化**）。
   *
   * 设置页点「退出登录」后置为 true：此后**任何来源**都不再供 key
   * （包括客户端凭据）。否则 auto 模式会在退出后静默回落到客户端凭据，
   * 用户看到的现象就是「退出登录了、模型还能用」——那等于退出没生效。
   *
   * 必须落盘：只在内存里的话，重启 DSH / 换个进程就又活了，
   * 「退出登录」变成一次性的假动作。
   */
  const suspendedFile = () => path.join(dshHome(), 'scnet-connect-suspended.json');
  function readSuspended() {
    try {
      const raw = JSON.parse(fs.readFileSync(suspendedFile(), 'utf8'));
      return raw?.suspended === true;
    } catch {
      return false;
    }
  }
  function writeSuspended(next) {
    try {
      const file = suspendedFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        `${JSON.stringify({ suspended: Boolean(next), updatedAt: new Date().toISOString() }, null, 2)}\n`,
        'utf8',
      );
    } catch {
      // 写不了也不影响本次运行；只是重启后会丢状态。
    }
  }
  let suspended = readSuspended();

  const logger = {
    info: (message) => ctx.logger?.info?.(`scnet-connect: ${message}`),
    warn: (message) => ctx.logger?.warn?.(`scnet-connect: ${message}`),
    error: (message) => ctx.logger?.error?.(`scnet-connect: ${message}`),
  };

  /**
   * 诊断快照：写到 `$DSH_HOME/scnet-connect-status[.<profile>].json`。
   *
   * 目的：DSH 的 host 日志不落盘，用户（和插件作者）需要一种确认「插件是否真的
   * 被装配、provider 是否注册、凭据是否找到、注册了哪些模型」的方式。
   * 该文件不含 key 明文；卸载时会被标记为未注册，避免留下过期的 `registered: true`。
   *
   * 文件名带 profile：同一 `DSH_HOME` 下同时跑 desktop 与 tui 时，
   * 两个实例不会互相覆盖对方刚写的快照（`DSH_PROFILE` 拿不到时退回旧文件名）。
   */
  function statusFilePath() {
    const profile = dshProfileName();
    const suffix = profile ? `.${profile}` : '';
    return path.join(dshHome(), `scnet-connect-status${suffix}.json`);
  }
  function writeStatus(fields) {
    try {
      const file = statusFilePath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        `${JSON.stringify(
          {
            plugin: 'dsh-scnet-connect',
            pid: process.pid,
            profile: dshProfileName() || undefined,
            updatedAt: new Date().toISOString(),
            ...fields,
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
    } catch {
      // 诊断文件写失败不影响插件工作。
    }
  }
  /**
   * 卸载/退出时把「自己写的那份」快照标记为未注册。
   *
   * 不能直接删文件：headless 一次性运行在进程退出时也会走 dispose，删掉就没法事后
   * 排障；也不能无条件覆盖：同一 DSH_HOME 下另一个 profile 的实例可能刚写过新快照。
   * 因此只在文件里的 pid 是本进程时才改写，卸载后留下的是一份诚实的
   * `registered: false`，不会像以前那样永远显示「插件已注册」。
   */
  function markStatusDisposed() {
    try {
      const file = statusFilePath();
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw?.pid !== process.pid) return;
      fs.writeFileSync(
        file,
        `${JSON.stringify({ ...raw, registered: false, disposedAt: new Date().toISOString() }, null, 2)}\n`,
        'utf8',
      );
    } catch {
      // 文件不存在/不可读：没有需要标记的快照。
    }
  }

  /**
   * 凭据来源选择：
   *   client —— 只读本机 SCNet 客户端凭据（老行为）
   *   login  —— 只用设置页的免客户端登录（`$DSH_HOME/scnet-session.json`）
   *   auto   —— 先客户端、客户端不可用时再免客户端登录
   */
  const credentialSource = ['auto', 'client', 'login'].includes(config?.credentialSource)
    ? config.credentialSource
    : 'auto';

  /** 免客户端登录：会话文件 + 平台 API Key（内存缓存 6 天）。 */
  const login = createLoginManager({ logger, env: process.env });

  /**
   * 统一凭据解析：返回 `{ key, source, file?, error? }`，**从不抛异常**。
   *
   * source 取值：
   *   `client-file` —— 客户端凭据文件
   *   `config`      —— 插件配置里的 apiKey
   *   `login`       —— 免客户端登录（设置页）
   *   `unavailable` —— 都拿不到（附 error 供状态页展示）
   */
  async function resolveCredential() {
    if (suspended) {
      return {
        key: '',
        source: 'unavailable',
        error: '已退出登录（本插件已停用）。在设置页重新登录，或点「恢复使用」后再试。',
      };
    }

    const clientError = () => {
      try {
        const resolved = resolveApiKey({ credentialDir: options.credentialDir, apiKey: options.apiKey });
        return { key: resolved.key, source: resolved.source, file: resolved.file };
      } catch (error) {
        return { key: '', source: 'unavailable', error: error instanceof Error ? error.message : String(error) };
      }
    };

    if (credentialSource === 'login') {
      const key = await login.ensureKey();
      if (key) return { key, source: 'login' };
      return {
        key: '',
        source: 'unavailable',
        error: login.snapshot().error || '还没有完成免客户端登录：请在设置页登录，或把凭据来源改为「自动/客户端」。',
        login: login.snapshot(),
      };
    }

    if (credentialSource === 'client') return clientError();

    // auto：客户端优先，其次免客户端登录。
    const fromClient = clientError();
    if (fromClient.key) return { ...fromClient, clientError: undefined };
    if (login.hasSession()) {
      const key = await login.ensureKey();
      if (key) return { key, source: 'login', clientError: fromClient.error };
    }
    return fromClient;
  }

  /**
   * 模型目录用的 key：客户端凭据优先，其次登录会话（必要时现换，可能打一次平台）。
   *
   * 网关校验只是「锦上添花」，拿不到 key 时目录退回本地/内置，不影响使用。
   * 这里允许 `await`：登录缓存的 key 过期时，`/refresh`（用户主动动作）应当
   * 换一个新 key 再校验，否则会拿过期 key 去请求网关、误报「校验失败」。
   */
  const catalogApiKey = async () => {
    if (suspended) return '';
    try {
      const resolved = resolveApiKey({ credentialDir: options.credentialDir, apiKey: options.apiKey });
      if (resolved.key && credentialSource !== 'login') return resolved.key;
    } catch {
      // 客户端不可用：继续看登录会话。
    }
    if (login.hasSession()) {
      try {
        const key = await login.ensureKey();
        if (key) return key;
      } catch {
        // 换 key 失败：退回缓存值（可能已过期），让网关校验如实失败。
      }
    }
    return login.currentKey() || options.apiKey.trim();
  };

  const catalog = createModelCatalog({
    baseUrl: options.baseUrl,
    modelIds: options.modelIds,
    resolveApiKey: catalogApiKey,
    verifyWithGateway: options.verifyWithGateway,
    freeOnly: initialFreeOnly,
  });

  const buildModels = () => {
    const entries = catalog.models();
    return entries.map((meta) =>
      buildModel({
        modelId: meta.id,
        // 只有一个模型时才允许用 modelName 覆盖（多个模型共用一个显示名没有意义）。
        modelName:
          entries.length === 1 && options.modelName
            ? options.modelName
            : modelLabel(meta, meta.id),
        baseUrl: options.baseUrl,
        meta,
        // provider 名从常量来，避免描述符里再写一份字面量。
        provider: PROVIDER_ID,
        contextWindow: options.contextWindow,
        maxTokens: options.maxTokens,
        inputImages: options.inputImages,
        reasoning: options.reasoning,
      }),
    );
  };

  /**
   * 上游「瞬时抖动」的归一化 fetch（见 `lib/scnet-fetch.js`）。
   *
   * 两类都归到 DSH 认得的可重试 code，交给它既有的退避重试吸收：
   *
   *  1. 5xx 却自称 `invalid_request_error`（code 10008/10009）——
   *     会被判成 `INVALID_REQUEST`（不可重试），改写成 `api_error` 落到 `SERVER`；
   *  2. SSE 流中途 `{"error":{"message":"The response stream was interrupted…"}}`
   *     ——原文一条分类正则都不命中，落到兜底 `PI_AI_ERROR`（不可重试），
   *     追加一句 `stream ended before …` 落到 `TRANSPORT`。
   */
  const retryFriendlyFetch = createRetryFriendlyFetch({
    onNormalize: ({ status, code, message }) => {
      logger.warn(
        `上游返回 ${status}（code=${code ?? '-'}），已按可重试的服务端错误处理：${message ?? ''}`.trim(),
      );
    },
    onInterrupt: ({ message }) => {
      logger.warn(`上游在流中途中断响应，已按可重试的传输错误处理：${message}`);
    },
  });

  const buildProfile = () => {
    const models = buildModels();
    const provider = {
      ...createProvider({
        id: PROVIDER_ID,
        name: PROVIDER_NAME,
        auth: {
          apiKey: {
            name: 'SCNet model-service API key（客户端凭据或设置页免客户端登录）',
            /**
             * 这里**必须**返回一个对象，不能返回 `undefined`。
             *
             * DSH 的 `resolveProviderAuth` 把本方法的返回值当作最终结果
             * （`readCredential` 之后直接 `return resolveApiKey(...)`），
             * 返回 `undefined` 会让 `applyAuth` 抛
             * `Provider is not configured: scnet` —— 那句话会被误读成
             * 「插件没配好」，掩盖真正的原因（没凭据）。
             *
             * 因此拿不到 key 时返回不带 `apiKey` 的 auth，让错误落在协议层：
             * pi-ai 的 openai-completions 会报缺少 Authorization，
             * 我们的启动日志/设置页同时给出「去登录」的指引。
             */
            async resolve() {
              const resolved = await resolveCredential();
              if (!resolved.key && resolved.error) {
                // 带上真实原因（例如「平台会话已过期，请重新登录」），
                // 否则用户只会看到一句无从下手的「No API key」。
                logger.warn(`本轮请求没有可用凭据：${resolved.error}`);
              }
              return {
                auth: resolved.key ? { apiKey: resolved.key } : {},
                source: resolved.source === 'login' ? 'scnet-login' : 'scnet-client',
              };
            },
          },
        },
        models,
        api: options.retryOnTransientErrors
          ? withRetryFriendlyFetch(openAICompletionsApi(), retryFriendlyFetch)
          : openAICompletionsApi(),
      }),
      // 模型目录可能随客户端目录更新，每次读取都重建。
      getModels: () => buildModels(),
    };

    return new Map([
      [
        PROVIDER_ID,
        {
          provider: PROVIDER_ID,
          displayName: PROVIDER_NAME,
          streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
          retryPolicy: resolveRetryPolicy(undefined, 'dsh-scnet-connect retryPolicy'),
          configuredMaxTokens: new Map(),
          modelErrors: new Map(),
          ...REQUEST_IMAGE_BUDGETS,
          piProvider: provider,
        },
      ],
    ]);
  };

  let profiles = buildProfile();

  /** 重新读取模型目录并替换 provider 的模型表（「刷新模型」用）。 */
  const rebuild = () => {
    profiles = buildProfile();
    return profiles;
  };

  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    resolveApiKey: async () => (await resolveCredential()).key || undefined,
    // ---- 图片输入 ----------------------------------------------------------
    //
    // 不给这两个钩子，`PiAiAdapter` 会在请求里含图片时直接抛
    //   「pi-ai image input requires the durable attachment service」
    // —— 用户看到的就是这句话，图片根本发不出去。
    //
    // 契约（见 @deepseek-ai/dsh-llm 的 resolveImageAttachmentAccess）：
    //   resolveAttachments()      → 附件服务本身（提供 imageHostPath 等）
    //   resolveImageAccess(a,ref) → { readonlyPath } | undefined
    // 两个都用 `ctx.get()` 惰性取：headless/TUI 下没有这些服务时返回
    // undefined，adapter 会退回「无持久化附件」的明确报错，而不是崩掉。
    resolveAttachments: () => ctx.get?.('attachments'),
    resolveImageAccess: (attachments, ref) => {
      // 这里不 import 核心的 resolveImageAttachmentAccess：那是运行时内部函数，
      // 不是稳定公开 API。按同样的语义就地实现，少一个跨包耦合点。
      const hostPath = attachments?.imageHostPath?.(ref);
      if (hostPath === undefined) return undefined;
      const readonlyPath = ctx.get?.('fs')?.processPathFromHostPath?.(hostPath);
      return readonlyPath === undefined ? undefined : { readonlyPath };
    },
  });

  // ---- 启动自检：把凭据与模型状态写进日志，但不泄露 key --------------------
  // 启动时只读本地（客户端文件 / 已缓存的登录 key），不打网络；
  // 免客户端模式下的首次换 key 推迟到「第一次请求」或设置页点登录时。
  let credentialInfo = describeClientCredential();
  if (credentialInfo.source === 'unavailable') {
    logger.warn(
      `尚未发现 SCNet 客户端凭据：${credentialInfo.error}。` +
        (credentialSource === 'client'
          ? '当前凭据来源被限定为「客户端」，发送消息会报错，直到客户端登录。'
          : '可以在设置页用「免客户端登录」登录 SCNet，或安装并登录 SCNet 客户端。'),
    );
  } else {
    logger.info(
      `已发现模型服务凭据（${credentialInfo.source === 'config' ? '来自插件配置' : '来自 SCNet 客户端'}，key=${credentialInfo.maskedKey}）`,
    );
  }

  /** 只读本地客户端凭据，永远不抛异常。 */
  function describeClientCredential() {
    try {
      const resolved = resolveApiKey({ credentialDir: options.credentialDir, apiKey: options.apiKey });
      return { source: resolved.source, file: resolved.file, maskedKey: maskKey(resolved.key) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { source: 'unavailable', error: message };
    }
  }

  /** 当前生效的凭据（异步：免客户端模式可能要换 key）。 */
  async function describeCredential() {
    const resolved = await resolveCredential();
    if (!resolved.key) {
      return {
        source: 'unavailable',
        error: resolved.error,
        ...(resolved.clientError ? { clientError: resolved.clientError } : {}),
      };
    }
    return {
      source: resolved.source,
      file: resolved.file,
      maskedKey: maskKey(resolved.key),
      ...(resolved.clientError ? { clientError: resolved.clientError } : {}),
    };
  }

  /** 账号信息（只读、已脱敏，供设置页显示）。 */
  function accountInfo() {
    try {
      return readClientAccount() ?? null;
    } catch {
      return null;
    }
  }

  /** 一处生成完整状态，启动写盘与 HTTP 路由共用。 */
  let registration;
  async function buildStatus(registered = Boolean(registration)) {
    const snapshot = catalog.snapshot();
    const credential = registered ? await describeCredential() : credentialInfo;
    const models = buildModels();
    const loginState = login.snapshot();
    // 账号来源要显式标注：客户端账号带 loggedIn，登录账号没有。
    // 不标的话设置页会把「免客户端登录已登录」显示成「未检测到登录态」。
    const clientAccount = accountInfo();
    const account = clientAccount
      ? { ...clientAccount, source: 'client' }
      : loginState.account
        ? { ...loginState.account, source: 'login' }
        : null;
    return {
      plugin: 'dsh-scnet-connect',
      updatedAt: new Date().toISOString(),
      registered,
      profile: dshProfileName() || undefined,
      provider: PROVIDER_ID,
      providerName: PROVIDER_NAME,
      baseUrl: options.baseUrl,
      credentialSource,
      suspended,
      account,
      login: {
        phase: loginState.phase,
        source: loginState.source,
        account: loginState.account,
        maskedKey: loginState.maskedKey,
        keyedAt: loginState.keyedAt,
        expiresAt: loginState.expiresAt,
        lastValidatedAt: loginState.lastValidatedAt,
        pending: loginState.pending,
        error: loginState.error,
        // 平台原始失败信息（码 + 原文）。界面只用中文提示，这里是排查依据：
        // 「短信登录却回 Username or password is incorrect」这类问题，
        // 没有原始码就只能靠猜。
        lastFailure: loginState.lastFailure,
        loginPageUrl: loginState.loginPageUrl,
        sessionFile: login.sessionFilePath(),
        // 现读，不沿用启动时的快照：用户中途装了客户端也要如实反映。
        hasClientCredential: describeClientCredential().source !== 'unavailable',
      },
      catalog: {
        source: snapshot.source,
        path: snapshot.path,
        modifiedAt: snapshot.modifiedAt ? new Date(snapshot.modifiedAt).toISOString() : undefined,
        explicitModels: catalog.explicitIds,
        freeOnly: catalog.freeOnly,
        gateway: snapshot.gateway,
        error: snapshot.error,
      },
      models: models.map((model) => {
        // `buildModel()` 是给 provider 用的描述符，不带价格/工具能力字段；
        // 它们来自 catalog 元数据，必须在这里补，否则设置页会把
        // 免费的 SCNet-Max 标成「计费」、把不支持工具的模型标成可用。
        const meta = snapshot.models.find(
          (entry) => entry.id.toLowerCase() === model.id.toLowerCase(),
        );
        return {
          id: model.id,
          name: model.name,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          input: model.input,
          reasoning: model.reasoning,
          priceLabel: meta?.priceLabel,
          toolCalling: meta?.toolCalling,
        };
      }),
      credential,
    };
  }

  // ---- 注册 provider -----------------------------------------------------
  try {
    registration = ctx.llm.registerAdapter([PROVIDER_ID], adapter);
    const status = await buildStatus(true);
    logger.info(
      `已注册 provider "${PROVIDER_ID}"（${PROVIDER_NAME}），模型：${status.models
        .map((m) => `${m.id}（ctx ${m.contextWindow} / max ${m.maxTokens}）`)
        .join('、')}`,
    );
    writeStatus(status);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`注册 provider 失败：${message}`);
    writeStatus({
      registered: false,
      provider: PROVIDER_ID,
      baseUrl: options.baseUrl,
      error: message,
      credential: credentialInfo,
    });
    return;
  }

  // ---- 设置页数据面：只读状态 + 刷新模型 ----------------------------------
  // `webServer` 只有 GUI/Web profile 才有，headless/TUI 下 ctx.inject 不会触发。
  // ---- 设置页数据面 ------------------------------------------------------
  // 路由一律返回 JSON；密文（key、Cookie）永远不出现在响应里。
  //
  //   GET  /status              只读快照（含免客户端登录状态）
  //   POST /refresh             刷新模型目录
  //   POST /login/captcha       取一张图形验证码（data URL）
  //   POST /login/sms           发送手机验证码
  //   POST /login/submit        提交短信验证码完成登录
  //   POST /logout              退出免客户端登录
  //   POST /validate            探一次平台会话是否还有效
  ctx.inject?.(['webServer'], (child) => {
    child.effect(() => {
      const disposers = [];

      /** 注册一条 POST-only JSON 路由，统一错误处理。 */
      function route(path, handler, { methods = ['POST'] } = {}) {
        return child.webServer.register({
          kind: 'exact',
          path: `${ROUTE_PREFIX}${path}`,
          handler: async (req, res) => {
            if (!methods.includes(req.method)) {
              sendJson(res, 405, { error: 'method not allowed' });
              return;
            }
            try {
              await handler(req, res);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              logger.warn(`${path} 处理失败：${message}`);
              sendJson(res, 500, { error: message });
            }
          },
        });
      }

      /**
       * 读取并限制大小的 JSON 请求体（设置页只会发很小的对象）。
       *
       * 超限时返回 `null`（而不是 `{}`）：把「请求体非法」和「请求体是空对象」
       * 区分开，否则一个 1MB 的请求会被当成 `{}` 继续执行，违反调用方意图。
       *
       * @returns {Promise<object | null>} `null` = 请求体超限
       */
      function readJsonBody(req) {
        return new Promise((resolve) => {
          const chunks = [];
          let size = 0;
          let settled = false;
          const finish = (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
          };
          req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_JSON_BODY_BYTES) {
              finish(null);
              req.destroy();
              return;
            }
            chunks.push(chunk);
          });
          req.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8').trim();
            if (!text) {
              finish({});
              return;
            }
            try {
              const parsed = JSON.parse(text);
              finish(parsed && typeof parsed === 'object' ? parsed : {});
            } catch {
              finish({});
            }
          });
          req.on('error', () => finish({}));
        });
      }

      /** 登录动作结束后统一回一套「状态 + 动作结果」。 */
      const loginResponse = (action) => async (res) => {
        const status = await buildStatus(true);
        writeStatus(status);
        // 登录状态变了，模型目录的网关校验也可能要重来。
        sendJson(res, 200, { ...action, status });
      };

      try {
        disposers.push(
          route(
            '/status',
            async (req, res) => {
              sendJson(res, 200, await buildStatus(true), { head: req.method === 'HEAD' });
            },
            { methods: ['GET', 'HEAD'] },
          ),
        );

        disposers.push(
          route('/refresh', async (req, res) => {
            await catalog.refresh();
            rebuild();
            const status = await buildStatus(true);
            writeStatus(status);
            logger.info(`模型目录已刷新（${status.models.map((m) => m.id).join('、')}）`);
            sendJson(res, 200, status);
          }),
        );

        // 运行时切换「只显示免费模型」：不需要改配置、不需要重启，且会记住。
        disposers.push(
          route('/catalog/free-only', async (req, res) => {
            const body = await readJsonBody(req);
            if (body === null) {
              sendJson(res, 413, { error: '请求体过大' });
              return;
            }
            const next = body.freeOnly !== false;
            catalog.setFreeOnly(next);
            writePreferences({ freeOnly: next });
            await catalog.refresh();
            rebuild();
            const status = await buildStatus(true);
            writeStatus(status);
            logger.info(`只显示免费模型：${next ? '开' : '关'}（${status.models.length} 个模型）`);
            sendJson(res, 200, { ok: true, status });
          }),
        );

        disposers.push(
          route('/login/captcha', async (req, res) => {
            const result = await login.captcha();
            sendJson(res, result.ok ? 200 : 502, result);
          }),
        );

        disposers.push(
          route('/login/sms', async (req, res) => {
            const body = await readJsonBody(req);
            if (body === null) {
              sendJson(res, 413, { error: '请求体过大' });
              return;
            }
            const result = await login.sendSmsCode(body.phone, body.captcha);
            sendJson(res, result.ok ? 200 : 400, result);
          }),
        );

        disposers.push(
          route('/login/submit', async (req, res) => {
            const body = await readJsonBody(req);
            if (body === null) {
              sendJson(res, 413, { error: '请求体过大' });
              return;
            }
            const result = await login.loginWithSms({
              phone: typeof body.phone === 'string' ? body.phone : undefined,
              smsCode: typeof body.smsCode === 'string' ? body.smsCode : undefined,
              captcha: typeof body.captcha === 'string' ? body.captcha : undefined,
            });
            if (result.ok) {
              // 登录成功即恢复供 key。
              suspended = false;
              writeSuspended(false);
              await catalog.refresh();
              rebuild();
            }
            await loginResponse(
              // `via` 会把「这次是登录还是顺手注册了新账号」带到设置页。
              result.ok ? { ok: true, via: result.via } : { ok: false, error: result.error },
            )(res);
          }),
        );

        disposers.push(
          route('/logout', async (req, res) => {
            await login.signOut();
            // 退出后连客户端凭据也一起停用，否则 auto 模式会静默回落到它，
            // 用户看到的就是「退出登录了模型还能用」。
            suspended = true;
            writeSuspended(true);
            rebuild();
            const status = await buildStatus(true);
            writeStatus(status);
            logger.info('已退出登录：本插件暂停供 key（客户端凭据也一并停用）');
            sendJson(res, 200, { ok: true, status });
          }),
        );

        // 恢复使用：重新允许按配置的来源供 key（登录会话已清空时就是客户端凭据）。
        disposers.push(
          route('/resume', async (req, res) => {
            suspended = false;
            writeSuspended(false);
            rebuild();
            const status = await buildStatus(true);
            writeStatus(status);
            logger.info('已恢复使用');
            sendJson(res, 200, { ok: true, status });
          }),
        );

        disposers.push(
          route('/validate', async (req, res) => {
            const result = await login.validate();
            const status = await buildStatus(true);
            writeStatus(status);
            sendJson(res, 200, { ...result, status });
          }),
        );
      } catch (error) {
        // 热重载时旧路由可能还没释放；不因为路由冲突影响 provider 本身的注册。
        logger.warn(`设置页路由注册失败：${error instanceof Error ? error.message : String(error)}`);
      }

      return () => {
        for (const off of disposers) {
          try {
            off?.();
          } catch {
            // ignore
          }
        }
      };
    });
  });

  ctx.effect?.(() => () => {
    try {
      registration?.();
    } catch {
      // 卸载时 registration 可能已经不在了，忽略。
    }
    // 卸载/退出后不要留下「registered: true」的陈旧诊断快照（否则按它为据排障会误导）。
    markStatusDisposed();
  });

  ctx.on?.('dispose', () => logger.info('插件已卸载'));
}

export { DEFAULT_BASE_URL, DEFAULT_MODEL_ID };
