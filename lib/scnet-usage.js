/**
 * Token 用量记录
 * ------------------------------------------------------------------
 * 目标：在不新增 HTTP 路由的前提下，把每次模型请求的 token 用量累加到
 * `$DSH_HOME/scnet-connect-usage[.<profile>].json`，并让现有的 `/status`
 * 响应带出快照，设置页直接展示。
 *
 * 统计口径：
 *   - `inputTokens` / `outputTokens` / `totalTokens` 来自 pi-ai 的 terminal event
 *     （`done` 或 `error` 里的 `message.usage` / `error.usage`）；
 *   - `cacheReadTokens` 是缓存命中（读缓存）的输入 token；
 *     `cacheWriteTokens` 是写入缓存的 token。SCNet 当前不返回这两个字段时，
 *     它们会保持 0，不会伪造“命中”；
 *   - 只有真的带 token 数的 terminal event 才计入 `requests`，避免把“请求还没
 *     发出去就失败”的尝试算成一次用量。
 *
 * 写盘策略：记录先落内存，`flushDelayMs` 防抖后原子写盘；插件 dispose 时强制
 * flush。文件不含 prompt / key / Cookie，只有计数和最近一次请求的模型 id。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 空计数器。 */
function emptyCounters(now = new Date().toISOString()) {
  return {
    version: 1,
    since: now,
    updatedAt: now,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    last: undefined,
  };
}

/** 只接受非负安全整数。 */
function count(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function normalizeLast(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const at = typeof raw.at === 'string' ? raw.at : undefined;
  if (!at) return undefined;
  return {
    at,
    model: typeof raw.model === 'string' && raw.model ? raw.model : undefined,
    inputTokens: count(raw.inputTokens),
    outputTokens: count(raw.outputTokens),
    totalTokens: count(raw.totalTokens),
    cacheReadTokens: count(raw.cacheReadTokens),
    cacheWriteTokens: count(raw.cacheWriteTokens),
  };
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const now = new Date().toISOString();
  const data = emptyCounters(typeof raw.since === 'string' ? raw.since : now);
  data.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : now;
  for (const key of ['requests', 'inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
    data[key] = count(raw[key]);
  }
  data.last = normalizeLast(raw.last);
  return data;
}

/**
 * @param {{
 *   file?: string,
 *   enabled?: boolean,
 *   flushDelayMs?: number,
 *   logger?: { warn?: (message: string) => void },
 * }} [options]
 */
export function createUsageRecorder(options = {}) {
  const file = typeof options.file === 'string' && options.file ? options.file : '';
  const enabled = options.enabled !== false;
  const flushDelayMs = Number.isFinite(options.flushDelayMs) ? Math.max(0, options.flushDelayMs) : 1500;
  const logger = options.logger ?? {};
  let data = enabled ? load() : emptyCounters();
  let timer;
  let warned = false;

  function load() {
    if (!file) return emptyCounters();
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return normalize(parsed) ?? emptyCounters();
    } catch {
      // 文件不存在/损坏：从空计数开始，不阻塞插件。
      return emptyCounters();
    }
  }

  function write() {
    if (!enabled || !file) return false;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      try {
        fs.chmodSync(tmp, 0o600);
      } catch {
        // Windows 上 chmod 只动只读位；文件本身没有凭据。
      }
      fs.renameSync(tmp, file);
      return true;
    } catch (error) {
      if (!warned) {
        warned = true;
        logger.warn?.(`token 用量写盘失败：${error instanceof Error ? error.message : String(error)}`);
      }
      return false;
    }
  }

  function scheduleFlush() {
    if (!enabled || !file || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      write();
    }, flushDelayMs);
    // 不要让一个统计定时器拖住 DSH 进程退出。
    timer.unref?.();
  }

  return {
    /** 记录一次 terminal usage。 */
    record(info = {}) {
      if (!enabled) return;
      const usage = info.usage;
      if (!usage || typeof usage !== 'object') return;
      const input = count(usage.input ?? usage.inputTokens);
      const output = count(usage.output ?? usage.outputTokens);
      const total = count(usage.totalTokens) || input + output;
      const cacheRead = count(usage.cacheRead ?? usage.cacheReadTokens);
      const cacheWrite = count(usage.cacheWrite ?? usage.cacheWriteTokens);
      // 没有 token 的 error 事件不计数（例如连接都没建立）。
      if (input === 0 && output === 0 && total === 0 && cacheRead === 0 && cacheWrite === 0) return;

      data.requests += 1;
      data.inputTokens += input;
      data.outputTokens += output;
      data.totalTokens += total;
      data.cacheReadTokens += cacheRead;
      data.cacheWriteTokens += cacheWrite;
      data.updatedAt = new Date().toISOString();
      data.last = {
        at: data.updatedAt,
        model: typeof info.model === 'string' && info.model ? info.model : undefined,
        inputTokens: input,
        outputTokens: output,
        totalTokens: total,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
      };
      scheduleFlush();
    },

    /** 只读快照（给 `/status` 和设置页）。 */
    snapshot() {
      const last = data.last ? { ...data.last } : undefined;
      return {
        enabled,
        since: data.since,
        updatedAt: data.updatedAt,
        requests: data.requests,
        inputTokens: data.inputTokens,
        outputTokens: data.outputTokens,
        totalTokens: data.totalTokens,
        cacheReadTokens: data.cacheReadTokens,
        cacheWriteTokens: data.cacheWriteTokens,
        last,
      };
    },

    /** 立即落盘（dispose / 测试用）。 */
    flush() {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      return write();
    },

    /** 清理定时器并落盘。 */
    dispose() {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      write();
    },

    filePath() {
      return file;
    },
  };
}

/**
 * 用 usage 记录器包一层 pi-ai API。
 *
 * pi-ai 的 `stream` / `streamSimple` 返回异步事件流：正常结束时最后一个事件是
 * `done`，失败时是 `error`。两者的 usage 都是**累计值**，所以每个请求只记录
 * 一次，不会按 token 事件重复累加。
 *
 * 记录失败绝不能影响推理流：异常在这里吞掉，事件原样透传。
 *
 * @template {{ stream: Function, streamSimple: Function }} T
 * @param {T} api
 * @param {(info: { model?: string, usage: any }) => void} record
 * @returns {T}
 */
export function withUsageRecording(api, record) {
  if (typeof record !== 'function') return api;
  const wrap = (fn) => {
    if (typeof fn !== 'function') return fn;
    return (model, context, options) => {
      // 保留 `this`：pi-ai 的 API 实现可能是对象方法，直接解构调用会丢上下文。
      const events = fn.call(api, model, context, options);
      return (async function* recorded() {
        for await (const event of events) {
          try {
            if (event?.type === 'done') {
              record({ model: model?.id, usage: event.message?.usage });
            } else if (event?.type === 'error') {
              record({ model: model?.id, usage: event.error?.usage });
            }
          } catch {
            // 统计失败不影响流。
          }
          yield event;
        }
      })();
    };
  };
  return {
    ...api,
    stream: wrap(api.stream),
    streamSimple: wrap(api.streamSimple),
  };
}
