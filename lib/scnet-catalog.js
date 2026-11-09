/**
 * 免费模型发现
 * ------------------------------------------------------------------
 * 需求：不要写死 `SCNet-Max`，而是把「当前账号可用的全部免费模型」都注册进 DSH。
 *
 * 数据来源（按可靠性排序）：
 *   1. `~/.sclaw/agent/models.json` → `providers.scnet.models`：客户端从平台模型
 *      目录生成、随客户端刷新落盘，**唯一带 `priceLabel` 的本地来源**。
 *      免费 = `priceLabel === "free"`（客户端 UI 文案「限时免费」）。
 *   2. `GET {baseUrl}/models`：网关实时列表，只有 id、没有价格，因此仅用于
 *      「这个模型现在还能不能用」的校验，不能用来判断免费与否。
 *   3. 内置兜底：目录缺失时退回 `SCNet-Max`，保证插件仍能注册出模型。
 *
 * 目录读取结果做 60s 内存缓存：DSH 会频繁调用 `getModels()`，而每次解析
 * 28KB JSON 没必要；「刷新模型」按钮会强制绕过缓存。
 */

import fs from 'node:fs';

import { defaultModelsPath, readClientCatalog } from './scnet-credential.js';
import { DEFAULT_BASE_URL, DEFAULT_MODEL_ID, FREE_PRICE_LABEL } from './scnet-models.js';

/** 目录缓存有效期。 */
export const CATALOG_CACHE_TTL_MS = 60_000;
/** 网关校验超时。 */
const GATEWAY_TIMEOUT_MS = 8_000;

/**
 * 从客户端目录里挑出免费模型。
 *
 * 排序：默认模型（SCNet-Max）优先，其余保持客户端目录顺序——客户端目录本身
 * 是按平台推荐顺序排的，打乱反而更难找。
 *
 * @param {{ models: any[] } | undefined} catalog
 * @returns {{ id: string, name?: string, input?: string[], contextWindow?: number, maxTokens?: number, toolCalling?: boolean, priceLabel?: string }[]}
 */
export function pickFreeModels(catalog) {
  const all = Array.isArray(catalog?.models) ? catalog.models : [];
  const free = all.filter((model) => model?.priceLabel === FREE_PRICE_LABEL);
  if (free.length === 0) return [];
  const preferred = free.filter((model) => model.id.toLowerCase() === DEFAULT_MODEL_ID.toLowerCase());
  const rest = free.filter((model) => model.id.toLowerCase() !== DEFAULT_MODEL_ID.toLowerCase());
  return [...preferred, ...rest];
}

/**
 * 查询网关实时模型列表（`GET /models`）。
 *
 * 失败不抛异常：网络不通 / 代理拦截 / 401 都只是「无法校验」，不影响本地目录
 * 提供的模型列表，调用方据此决定是否过滤。
 *
 * @param {{ baseUrl?: string, apiKey?: string, timeoutMs?: number }} options
 * @returns {Promise<{ ok: true, ids: string[] } | { ok: false, error: string }>}
 */
export async function fetchGatewayModels(options = {}) {
  const baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const apiKey = options.apiKey;
  if (!apiKey) return { ok: false, error: 'no api key' };
  const timeoutMs = options.timeoutMs ?? GATEWAY_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    const body = await response.json();
    const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
    const ids = rows
      .map((row) => (typeof row === 'string' ? row : row?.id))
      .filter((id) => typeof id === 'string' && id.trim().length > 0);
    if (ids.length === 0) return { ok: false, error: 'empty model list' };
    return { ok: true, ids };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {{
 *   modelsPath?: string,
 *   baseUrl?: string,
 *   modelIds?: string[],
 *   resolveApiKey?: () => string,
 *   verifyWithGateway?: boolean,
 * }} options
 */
export function createModelCatalog(options = {}) {
  const modelsPath = options.modelsPath;
  const baseUrl = options.baseUrl || DEFAULT_BASE_URL;
  const explicitIds = Array.isArray(options.modelIds) ? options.modelIds.filter(Boolean) : [];
  const resolveKey = typeof options.resolveApiKey === 'function' ? options.resolveApiKey : () => '';
  const verifyWithGateway = options.verifyWithGateway !== false;

  /** @type {{ models: any[], source: string, path?: string, modifiedAt?: number, updatedAt: string, gateway?: any, error?: string } | undefined} */
  let snapshot;
  let readAt = 0;

  function readFromDisk() {
    const catalog = readClientCatalog({ modelsPath });
    const updatedAt = new Date().toISOString();
    if (explicitIds.length > 0) {
      const byId = new Map((catalog?.models ?? []).map((model) => [model.id.toLowerCase(), model]));
      const models = explicitIds.map((id) => byId.get(id.toLowerCase()) ?? { id, priceLabel: 'unknown' });
      return {
        models,
        source: 'config',
        path: catalog?.path,
        modifiedAt: catalog?.modifiedAt,
        updatedAt,
      };
    }
    const free = pickFreeModels(catalog);
    if (free.length > 0) {
      return {
        models: free,
        source: 'client-catalog',
        path: catalog.path,
        modifiedAt: catalog.modifiedAt,
        updatedAt,
      };
    }
    return {
      models: [{ id: DEFAULT_MODEL_ID, priceLabel: FREE_PRICE_LABEL }],
      source: catalog ? 'client-catalog-empty' : 'builtin',
      path: catalog?.path,
      modifiedAt: catalog?.modifiedAt,
      updatedAt,
      error: catalog
        ? '客户端模型目录里没有标记为 free 的模型，已退回内置 SCNet-Max'
        : '未找到客户端模型目录（~/.sclaw/agent/models.json），已退回内置 SCNet-Max',
    };
  }

  /** 同步读取（带 TTL 缓存）。 */
  function current() {
    const now = Date.now();
    const expired = now - readAt > CATALOG_CACHE_TTL_MS;
    const fileChanged = snapshot?.modifiedAt !== undefined && fileMtime() !== snapshot.modifiedAt;
    if (!snapshot || expired || fileChanged) {
      snapshot = readFromDisk();
      readAt = now;
    }
    return snapshot;
  }

  function fileMtime() {
    try {
      return fs.statSync(modelsPath || defaultModelsPath()).mtimeMs;
    } catch {
      return undefined;
    }
  }

  /** 强制重新读取，并（可选）用网关校验可用性。 */
  async function refresh() {
    const fresh = readFromDisk();
    if (verifyWithGateway) {
      let key = '';
      try {
        key = resolveKey() || '';
      } catch {
        key = '';
      }
      if (!key) {
        fresh.gateway = { ok: false, error: 'no api key' };
      } else {
        const result = await fetchGatewayModels({ baseUrl, apiKey: key });
        if (result.ok) {
          const live = new Set(result.ids.map((id) => id.toLowerCase()));
          const kept = fresh.models.filter((model) => live.has(model.id.toLowerCase()));
          const missing = fresh.models.filter((model) => !live.has(model.id.toLowerCase())).map((model) => model.id);
          fresh.gateway = { ok: true, count: result.ids.length, missing };
          // 全部对不上时保留本地结果：多半是网关口径变了，不该把选择器清空。
          if (kept.length > 0) fresh.models = kept;
        } else {
          fresh.gateway = { ok: false, error: result.error };
        }
      }
    }
    snapshot = fresh;
    readAt = Date.now();
    return snapshot;
  }

  return {
    /** 当前生效的模型元数据（同步）。 */
    models() {
      return current().models;
    },
    /** 当前快照（同步）。 */
    snapshot() {
      return current();
    },
    /** 强制刷新（异步，含网关校验）。 */
    refresh,
    /** 显式配置的模型 id（为空表示自动发现）。 */
    explicitIds,
  };
}
