/**
 * dsh-scnet-connect —— 把本机 SCNet 客户端（超算互联网「计算服务」）里的
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
import { DEFAULT_BASE_URL, DEFAULT_MODEL_ID, buildModel, modelLabel } from './scnet-models.js';

/** 本插件注册的 provider 路由名（模型选择器里显示为此分组）。 */
export const PROVIDER_ID = 'scnet';
/** 模型选择器里的分组名。 */
export const PROVIDER_NAME = '超算互联网 SCNet';
/** 浏览器侧设置页使用的 HTTP 路由前缀。 */
export const ROUTE_PREFIX = '/plugins/dsh-scnet-connect';
/** 单条流允许的最大空闲时间。 */
const STREAM_IDLE_TIMEOUT_MS = 300_000;
/** 与 pi-ai 约定的图片预算（SCNet 支持图片输入）。 */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
};

export const name = 'dsh-scnet-connect';
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

/** 给 route handler 用的 JSON 响应。 */
function sendJson(res, status, body) {
  const payload = `${JSON.stringify(body, null, 2)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * @param {any} ctx cordis context
 * @param {any} config 由 Config schema 校验后的配置
 */
export function apply(ctx, config) {
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
  };

  const logger = {
    info: (message) => ctx.logger?.info?.(`scnet-connect: ${message}`),
    warn: (message) => ctx.logger?.warn?.(`scnet-connect: ${message}`),
    error: (message) => ctx.logger?.error?.(`scnet-connect: ${message}`),
  };

  /**
   * 诊断快照：写到 `$DSH_HOME/scnet-connect-status.json`（默认 ~/.dsh）。
   *
   * 目的：DSH 的 host 日志不落盘，用户（和插件作者）需要一种确认「插件是否真的
   * 被装配、provider 是否注册、凭据是否找到、注册了哪些模型」的方式。
   * 该文件不含 key 明文；卸载时会被删掉，避免留下过期的 `registered: true`。
   */
  function statusFilePath() {
    const home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh');
    return path.join(home, 'scnet-connect-status.json');
  }
  function writeStatus(fields) {
    try {
      const file = statusFilePath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        `${JSON.stringify(
          { plugin: 'dsh-scnet-connect', pid: process.pid, updatedAt: new Date().toISOString(), ...fields },
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

  /** 每次请求都重新解析：客户端轮换 key 后自动跟上，无需重启 DSH。 */
  const resolveCurrentApiKey = () =>
    resolveApiKey({ credentialDir: options.credentialDir, apiKey: options.apiKey }).key;

  const catalog = createModelCatalog({
    baseUrl: options.baseUrl,
    modelIds: options.modelIds,
    resolveApiKey: () => {
      try {
        return resolveCurrentApiKey();
      } catch {
        return options.apiKey.trim();
      }
    },
    verifyWithGateway: options.verifyWithGateway,
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
        contextWindow: options.contextWindow,
        maxTokens: options.maxTokens,
        inputImages: options.inputImages,
        reasoning: options.reasoning,
      }),
    );
  };

  const buildProfile = () => {
    const models = buildModels();
    const provider = {
      ...createProvider({
        id: PROVIDER_ID,
        name: PROVIDER_NAME,
        auth: {
          apiKey: {
            name: 'SCNet model-service API key（由 dsh-scnet-connect 从本机客户端读取）',
            async resolve() {
              const key = resolveCurrentApiKey();
              return key ? { auth: { apiKey: key }, source: 'scnet-client' } : undefined;
            },
          },
        },
        models,
        api: openAICompletionsApi(),
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
    resolveApiKey: async () => resolveCurrentApiKey(),
  });

  // ---- 启动自检：把凭据与模型状态写进日志，但不泄露 key --------------------
  let credentialInfo;
  try {
    const resolved = resolveApiKey({ credentialDir: options.credentialDir, apiKey: options.apiKey });
    credentialInfo = {
      source: resolved.source,
      file: resolved.file,
      maskedKey: maskKey(resolved.key),
    };
    logger.info(
      `已发现模型服务凭据（${resolved.source === 'config' ? '来自插件配置' : '来自 SCNet 客户端'}，key=${maskKey(resolved.key)}）`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    credentialInfo = { source: 'unavailable', error: message };
    logger.warn(
      `尚未发现 SCNet 模型服务凭据：${message}。` +
        '模型仍会出现在选择器里，但发送消息会报错，直到凭据可用。',
    );
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
  function buildStatus(registered = Boolean(registration)) {
    const snapshot = catalog.snapshot();
    let credential = credentialInfo;
    if (registered) {
      try {
        const resolved = resolveApiKey({ credentialDir: options.credentialDir, apiKey: options.apiKey });
        credential = { source: resolved.source, file: resolved.file, maskedKey: maskKey(resolved.key) };
      } catch (error) {
        credential = { source: 'unavailable', error: error instanceof Error ? error.message : String(error) };
      }
    }
    const models = buildModels();
    return {
      plugin: 'dsh-scnet-connect',
      updatedAt: new Date().toISOString(),
      registered,
      provider: PROVIDER_ID,
      providerName: PROVIDER_NAME,
      baseUrl: options.baseUrl,
      account: accountInfo(),
      catalog: {
        source: snapshot.source,
        path: snapshot.path,
        modifiedAt: snapshot.modifiedAt ? new Date(snapshot.modifiedAt).toISOString() : undefined,
        explicitModels: catalog.explicitIds,
        gateway: snapshot.gateway,
        error: snapshot.error,
      },
      models: models.map((model) => ({
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        input: model.input,
        reasoning: model.reasoning,
      })),
      credential,
    };
  }

  // ---- 注册 provider -----------------------------------------------------
  try {
    registration = ctx.llm.registerAdapter([PROVIDER_ID], adapter);
    const status = buildStatus(true);
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
  ctx.inject?.(['webServer'], (child) => {
    child.effect(() => {
      let offStatus;
      let offRefresh;
      try {
        offStatus = child.webServer.register({
          kind: 'exact',
          path: `${ROUTE_PREFIX}/status`,
          handler: (req, res) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              sendJson(res, 405, { error: 'method not allowed' });
              return;
            }
            try {
              sendJson(res, 200, buildStatus(true));
            } catch (error) {
              sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
            }
          },
        });

        offRefresh = child.webServer.register({
          kind: 'exact',
          path: `${ROUTE_PREFIX}/refresh`,
          handler: async (req, res) => {
            if (req.method !== 'POST') {
              sendJson(res, 405, { error: 'method not allowed' });
              return;
            }
            try {
              await catalog.refresh();
              rebuild();
              const status = buildStatus(true);
              writeStatus(status);
              logger.info(`模型目录已刷新（${status.models.map((m) => m.id).join('、')}）`);
              sendJson(res, 200, status);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              logger.warn(`刷新模型失败：${message}`);
              sendJson(res, 500, { error: message });
            }
          },
        });
      } catch (error) {
        // 热重载时旧路由可能还没释放；不因为路由冲突影响 provider 本身的注册。
        logger.warn(`设置页路由注册失败：${error instanceof Error ? error.message : String(error)}`);
      }

      return () => {
        try {
          offStatus?.();
        } catch {
          // ignore
        }
        try {
          offRefresh?.();
        } catch {
          // ignore
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
