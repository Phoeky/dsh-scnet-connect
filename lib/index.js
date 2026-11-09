/**
 * dsh-scnet-connect —— 把本机 SCNet 客户端（超算互联网「计算服务」）的免费模型
 * SCNet-Max 接入 DeepSeek Harness。
 *
 * 设计
 * ----
 * SCNet 客户端的模型网关是标准 OpenAI Chat Completions 兼容端点
 * （`https://api.scnet.cn/api/llm/v1`），因此本插件**不需要** loopback shim，
 * 也不做任何协议转换。插件做三件事：
 *
 *   1. 从本机 SCNet 客户端的数据目录里读取「模型服务 API Key」；
 *   2. 用 `@deepseek-ai/dsh-llm-pi-ai` 的 `PiAiAdapter` 注册一个 provider
 *      （默认 id `scnet`），模型是 `SCNet-Max`；
 *   3. 每次请求时重新读取凭据文件，客户端轮换 key 后无需重启 DSH。
 *
 * 与 dsh-connect-trae / dsh-connect-qoder 的关系
 * ----------------------------------------------
 * 思路相同（本机已登录客户端的凭据 → 直接注册成 DSH 模型 provider），但
 * trae/qoder 的上游是非标准协议，需要 bridge + loopback shim；SCNet 是标准
 * OpenAI 兼容端点，所以这里只保留「发现凭据 + 声明模型 + 注册 adapter」这一层。
 *
 * 为什么不用 `cordis.patch.yml` 覆盖 `llm-pi-ai.providers`
 * ----------------------------------------------------
 * profile 补丁语义是「整块覆盖 config」，insert 同名 entry 会冲突；在别人的
 * `llm-pi-ai` 行上覆盖会波及用户已有的全部自定义 provider。因此插件在自己的
 * entry 里通过 `ctx.llm.registerAdapter` 动态注册，与现有 provider 互不干扰。
 */

import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import { createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import z from '@deepseek-ai/schemastery';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  maskKey,
  readClientModelMeta,
  readPlatformAccessToken,
  resolveApiKey,
} from './scnet-credential.js';
import { DEFAULT_BASE_URL, DEFAULT_MODEL_ID, buildModel, modelLabel } from './scnet-models.js';

/** 本插件注册的 provider 路由名（模型选择器里显示为此分组）。 */
export const PROVIDER_ID = 'scnet';
/** 模型选择器里的分组名。 */
export const PROVIDER_NAME = '超算互联网 SCNet';
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
 * 默认值就是「零配置可用」：客户端装好、登录过、发过消息，插件就能用。
 * 所有字段都只是逃生口（自定义目录 / 覆盖凭据 / 换模型 / 调上下文预算）。
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
  modelId: z
    .string()
    .default(DEFAULT_MODEL_ID)
    .description('模型 id（SCNet 网关区分大小写；默认免费模型 SCNet-Max）'),
  modelName: z
    .string()
    .default('')
    .description('模型在 DSH 选择器里的显示名（留空则用客户端目录里的名字）'),
  contextWindow: z
    .number()
    .default(0)
    .description('覆盖上下文窗口（0 = 跟随 SCNet 客户端目录 / 内置默认值）'),
  maxTokens: z
    .number()
    .default(0)
    .description('覆盖最大输出 token（0 = 跟随 SCNet 客户端目录 / 内置默认值）'),
  inputImages: z
    .boolean()
    .default(true)
    .description('是否向 DSH 声明该模型接受图片输入'),
  reasoning: z
    .boolean()
    .default(true)
    .description('是否声明该模型支持思考等级（SCNet-Max 会返回 reasoning_content）'),
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

/**
 * @param {any} ctx cordis context
 * @param {any} config 由 Config schema 校验后的配置
 */
export function apply(ctx, config) {
  const options = {
    credentialDir: typeof config?.credentialDir === 'string' ? config.credentialDir : '',
    apiKey: typeof config?.apiKey === 'string' ? config.apiKey : '',
    baseUrl: (typeof config?.baseUrl === 'string' && config.baseUrl.trim()) || DEFAULT_BASE_URL,
    modelId: (typeof config?.modelId === 'string' && config.modelId.trim()) || DEFAULT_MODEL_ID,
    modelName: typeof config?.modelName === 'string' ? config.modelName : '',
    contextWindow: typeof config?.contextWindow === 'number' ? config.contextWindow : 0,
    maxTokens: typeof config?.maxTokens === 'number' ? config.maxTokens : 0,
    inputImages: config?.inputImages !== false,
    reasoning: config?.reasoning !== false,
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
   * 被装配、provider 是否注册、凭据是否找到」的方式。该文件不含 key 明文。
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
        `${JSON.stringify({ plugin: 'dsh-scnet-connect', updatedAt: new Date().toISOString(), ...fields }, null, 2)}\n`,
        'utf8',
      );
    } catch {
      // 诊断文件写失败不影响插件工作。
    }
  }

  /** 每次请求都重新解析：客户端轮换 key 后自动跟上，无需重启 DSH。 */
  const resolveCurrentApiKey = () => resolveApiKey({ credentialDir: options.credentialDir, apiKey: options.apiKey }).key;

  const buildModels = () => {
    const meta = readClientModelMeta(options.modelId);
    const descriptor = buildModel({
      modelId: options.modelId,
      modelName: options.modelName || modelLabel(meta, options.modelId),
      baseUrl: options.baseUrl,
      meta,
      contextWindow: options.contextWindow,
      maxTokens: options.maxTokens,
      inputImages: options.inputImages,
      reasoning: options.reasoning,
    });
    return [descriptor];
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
      // 模型目录可能随配置/客户端目录更新，每次读取都重建。
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
  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    resolveApiKey: async () => resolveCurrentApiKey(),
  });
  /** 让 DSH 重新读取模型列表（配置变化时用）。 */
  adapter.__rebuild = () => {
    profiles = buildProfile();
  };

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
  try {
    const jwt = readPlatformAccessToken();
    if (jwt?.expiresAt) {
      const leftDays = Math.floor((jwt.expiresAt - Date.now()) / 86_400_000);
      logger.info(`SCNet 平台登录态有效期约 ${leftDays} 天（仅用于诊断，模型请求用 model-service key）`);
    }
  } catch {
    // 诊断信息可有可无。
  }

  // ---- 注册 provider -----------------------------------------------------
  let registration;
  try {
    registration = ctx.llm.registerAdapter([PROVIDER_ID], adapter);
    const models = buildModels();
    logger.info(
      `已注册 provider "${PROVIDER_ID}"（${PROVIDER_NAME}），模型：${models
        .map((m) => `${m.id}（ctx ${m.contextWindow} / max ${m.maxTokens}）`)
        .join('、')}`,
    );
    writeStatus({
      registered: true,
      provider: PROVIDER_ID,
      providerName: PROVIDER_NAME,
      baseUrl: options.baseUrl,
      models: models.map((model) => ({
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        input: model.input,
        reasoning: model.reasoning,
      })),
      credential: credentialInfo,
    });
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

  ctx.effect?.(() => () => {
    try {
      registration?.();
    } catch {
      // 卸载时 registration 可能已经不在了，忽略。
    }
  });

  ctx.on?.('dispose', () => logger.info('插件已卸载'));
}

export { DEFAULT_BASE_URL, DEFAULT_MODEL_ID };
