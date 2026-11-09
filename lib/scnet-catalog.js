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
/** 目录 mtime 复查间隔（DSH 会高频调用 `getModels()`，不做节流就是每请求一次 stat）。 */
const STAT_THROTTLE_MS = 5_000;
/** 网关校验超时。 */
const GATEWAY_TIMEOUT_MS = 8_000;

/**
 * 目录不可用时的兜底模型。
 *
 * 必须带上与平台一致的输入能力：只写 `{ id, priceLabel }` 会让描述符退化成
 * 纯文本（`buildModel` 对「有元数据但没写 input」按纯文本处理），
 * 于是没装客户端的用户会平白丢掉图片能力。
 */
export const BUILTIN_MODEL = Object.freeze({
  id: DEFAULT_MODEL_ID,
  priceLabel: FREE_PRICE_LABEL,
  input: ['text', 'image'],
  reasoning: false,
  thinkingMode: 'levels',
});

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
  /**
   * 只注册免费模型。默认开；关掉后把客户端目录里的**全部**模型都注册出来
   * （计费按平台规则走，插件不做限制也不做提醒）。
   */
  let freeOnly = options.freeOnly !== false;

  /** @type {{ models: any[], source: string, path?: string, modifiedAt?: number, updatedAt: string, gateway?: any, error?: string } | undefined} */
  let snapshot;
  let readAt = 0;
  /** 最近一次 stat 得到的目录 mtime（用于发现客户端刷新了目录）。 */
  let lastMtime;
  let lastStatAt = 0;

  function readFromDisk() {
    const catalog = readClientCatalog({ modelsPath });
    const updatedAt = new Date().toISOString();
    // 目录不存在时也要有 mtime 基线，否则「后来才出现的目录」不会被察觉
    // （`modifiedAt === undefined` 会让 fileChanged 永远为 false）。
    const modifiedAt = catalog?.modifiedAt ?? fileMtime();
    if (explicitIds.length > 0) {
      const byId = new Map((catalog?.models ?? []).map((model) => [model.id.toLowerCase(), model]));
      const models = explicitIds.map((id) => byId.get(id.toLowerCase()) ?? { id, priceLabel: 'unknown' });
      return {
        models,
        source: 'config',
        path: catalog?.path,
        modifiedAt,
        updatedAt,
      };
    }
    // 关闭「只显示免费」：把目录里的全部模型都注册出来。
    if (!freeOnly) {
      const all = Array.isArray(catalog?.models) ? catalog.models : [];
      if (all.length > 0) {
        const preferred = all.filter((m) => m.id.toLowerCase() === DEFAULT_MODEL_ID.toLowerCase());
        const rest = all.filter((m) => m.id.toLowerCase() !== DEFAULT_MODEL_ID.toLowerCase());
        return {
          models: [...preferred, ...rest],
          source: 'client-catalog-all',
          path: catalog.path,
          modifiedAt,
          updatedAt,
        };
      }
      return {
        models: [{ ...BUILTIN_MODEL }],
        source: 'builtin',
        path: catalog?.path,
        modifiedAt,
        updatedAt,
        error: '未找到客户端模型目录（~/.sclaw/agent/models.json），已退回内置 SCNet-Max',
      };
    }
    const free = pickFreeModels(catalog);
    if (free.length > 0) {
      return {
        models: free,
        source: 'client-catalog',
        path: catalog.path,
        modifiedAt,
        updatedAt,
      };
    }
    return {
      models: [{ ...BUILTIN_MODEL }],
      source: catalog ? 'client-catalog-empty' : 'builtin',
      path: catalog?.path,
      modifiedAt,
      updatedAt,
      error: catalog
        ? '客户端模型目录里没有标记为 free 的模型，已退回内置 SCNet-Max'
        : '未找到客户端模型目录（~/.sclaw/agent/models.json），已退回内置 SCNet-Max',
    };
  }

  /**
   * 同步读取（带 TTL 缓存 + stat 节流）。
   *
   * DSH 会频繁调用 `getModels()`；`stat` 本身不贵，但每次请求都打一次系统调用
   * 没有意义，因此目录 mtime 最多每 {@link STAT_THROTTLE_MS} 复查一次。
   */
  function current() {
    const now = Date.now();
    const expired = now - readAt > CATALOG_CACHE_TTL_MS;
    let fileChanged = false;
    if (snapshot !== undefined && now - lastStatAt > STAT_THROTTLE_MS) {
      lastStatAt = now;
      const mtime = fileMtime();
      fileChanged = mtime !== lastMtime;
      lastMtime = mtime;
    }
    if (!snapshot || expired || fileChanged) {
      snapshot = readFromDisk();
      readAt = now;
      lastStatAt = now;
      lastMtime = fileMtime();
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

  /**
   * 强制重新读取，并（可选）用网关校验可用性。
   *
   * `resolveKey` 允许返回 Promise：免客户端模式下缓存的 key 可能已过期，
   * 刷新时现换一个再校验，否则会拿过期 key 去请求网关、误报「校验失败」。
   */
  async function refresh() {
    const fresh = readFromDisk();
    if (verifyWithGateway) {
      let key = '';
      try {
        key = (await resolveKey()) || '';
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
    lastStatAt = readAt;
    lastMtime = fileMtime();
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
    /** 运行时切换「只显示免费模型」（设置页开关用）。 */
    setFreeOnly(next) {
      const value = next !== false;
      if (value === freeOnly) return false;
      freeOnly = value;
      snapshot = undefined; // 丢掉缓存，下次读立刻按新规则重建
      readAt = 0;
      return true;
    },
    /** 当前是否只显示免费模型。 */
    get freeOnly() {
      return freeOnly;
    },
    /** 显式配置的模型 id（为空表示自动发现）。 */
    explicitIds,
  };
}
