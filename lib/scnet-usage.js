/**
 * Token 用量记录
 * ------------------------------------------------------------------
 * 目标：在不新增 HTTP 路由的前提下，把每个 scnet 模型请求的 token 用量累加到
 * `$DSH_HOME/scnet-connect-usage[.<profile>].json`，并让现有的 `/status`
 * 响应带出快照，设置页直接展示。
 *
 * 数据来源：`llm/stream` waterfall 里的 `usage` chunk（`TokenUsage`）：
 *   inputTokens        —— 未命中缓存的输入 token
 *   cacheReadTokens    —— 缓存命中的输入 token
 *   cacheWriteTokens   —— 写入缓存的输入 token
 *   outputTokens       —— 输出 token
 *   输入总量 = inputTokens + cacheReadTokens + cacheWriteTokens
 *
 * 统计口径：
 *   - `promptTokens` 是输入总量（含缓存命中），`uncachedInputTokens` 只是其中
 *     没有命中缓存的部分；缓存命中率 = cacheReadTokens / promptTokens；
 *   - 只有真的带 token 数的 usage 才计入 `requests`，避免把“请求还没发出去就
 *     失败”的尝试算成一次用量；
 *   - 兼容旧版文件：旧字段 `inputTokens` 表示未命中输入，读取时按
 *     `inputTokens + cacheReadTokens + cacheWriteTokens` 迁移为 `promptTokens`。
 *
 * 写盘策略：记录先落内存，`flushDelayMs` 防抖后原子写盘；插件 dispose 时强制
 * flush。文件不含 prompt / key / Cookie，只有计数和最近一次请求的模型 id。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 当前落盘格式版本；2 = promptTokens/uncachedInputTokens 分离。 */
const USAGE_VERSION = 2;

/** 空计数器。 */
function emptyCounters(now = new Date().toISOString()) {
  return {
    version: USAGE_VERSION,
    since: now,
    updatedAt: now,
    requests: 0,
    promptTokens: 0,
    uncachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    last: undefined,
  };
}

/** 只接受非负安全整数。 */
function count(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** 把一份旧的/新的 last 计数规整成当前口径。 */
function normalizeLast(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const at = typeof raw.at === 'string' ? raw.at : undefined;
  if (!at) return undefined;
  const cacheReadTokens = count(raw.cacheReadTokens);
  const cacheWriteTokens = count(raw.cacheWriteTokens);
  const outputTokens = count(raw.outputTokens);
  const promptTokens =
    count(raw.promptTokens) || count(raw.inputTokens) + cacheReadTokens + cacheWriteTokens;
  return {
    at,
    model: typeof raw.model === 'string' && raw.model ? raw.model : undefined,
    promptTokens,
    uncachedInputTokens: count(raw.uncachedInputTokens) || Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens),
    outputTokens,
    totalTokens: count(raw.totalTokens) || promptTokens + outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens: count(raw.reasoningTokens),
  };
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const now = new Date().toISOString();
  const data = emptyCounters(typeof raw.since === 'string' ? raw.since : now);
  data.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : now;

  const cacheReadTokens = count(raw.cacheReadTokens);
  const cacheWriteTokens = count(raw.cacheWriteTokens);
  data.promptTokens =
    count(raw.promptTokens) || count(raw.inputTokens) + cacheReadTokens + cacheWriteTokens;
  data.uncachedInputTokens =
    count(raw.uncachedInputTokens) || Math.max(0, data.promptTokens - cacheReadTokens - cacheWriteTokens);
  data.outputTokens = count(raw.outputTokens);
  data.cacheReadTokens = cacheReadTokens;
  data.cacheWriteTokens = cacheWriteTokens;
  data.reasoningTokens = count(raw.reasoningTokens);
  data.totalTokens = count(raw.totalTokens) || data.promptTokens + data.outputTokens;
  data.requests = count(raw.requests);
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
  /** 内存里有尚未落盘的改动。 */
  let dirty = false;

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
      dirty = false;
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

  /**
   * 进程退出前的最后一道保险。
   *
   * `scheduleFlush` 用了 `unref()`（不希望统计定时器拖住退出），代价是：
   * 如果进程在防抖窗口内退出，那次改动就只在内存里。dispose 正常触发时
   * 会补写，但断电/强杀/宿主崩溃不会走 dispose。
   * 因此挂一个同步的 `exit` 钩子——write() 全程同步，在 exit 里可以安全完成。
   * 用 once 语义注册，避免重复挂载。
   */
  let exitHooked = false;
  function hookExit() {
    if (exitHooked || !enabled || !file) return;
    exitHooked = true;
    try {
      process.once('exit', () => {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        if (dirty) write();
      });
    } catch {
      // 没有 process 或不支持事件（极少见）：忽略。
    }
  }

  return {
    /**
     * 记录一次 harness `TokenUsage`（`llm/stream` 的 usage chunk）。
     *
     * @param {{ model?: string, usage?: any }} info
     */
    record(info = {}) {
      if (!enabled) return;
      const usage = info.usage;
      if (!usage || typeof usage !== 'object') return;
      const uncachedInputTokens = count(usage.inputTokens ?? usage.input);
      const cacheReadTokens = count(usage.cacheReadTokens ?? usage.cacheRead);
      const cacheWriteTokens = count(usage.cacheWriteTokens ?? usage.cacheWrite);
      const outputTokens = count(usage.outputTokens ?? usage.output);
      const reasoningTokens = count(usage.reasoningTokens ?? usage.reasoning);
      // harness 的 inputTokens 是「未命中缓存」的部分；输入总量要把缓存部分加回来。
      const promptTokens =
        count(usage.promptTokens) || uncachedInputTokens + cacheReadTokens + cacheWriteTokens;
      const totalTokens = count(usage.totalTokens) || promptTokens + outputTokens;
      // 没有 token 的 error/空 usage 不计数（例如连接都没建立）。
      if (promptTokens === 0 && outputTokens === 0) return;

      data.requests += 1;
      data.promptTokens += promptTokens;
      data.uncachedInputTokens += uncachedInputTokens;
      data.outputTokens += outputTokens;
      data.totalTokens += totalTokens;
      data.cacheReadTokens += cacheReadTokens;
      data.cacheWriteTokens += cacheWriteTokens;
      data.reasoningTokens += reasoningTokens;
      data.updatedAt = new Date().toISOString();
      data.last = {
        at: data.updatedAt,
        model: typeof info.model === 'string' && info.model ? info.model : undefined,
        promptTokens,
        uncachedInputTokens,
        outputTokens,
        totalTokens,
        cacheReadTokens,
        cacheWriteTokens,
        reasoningTokens,
      };
      dirty = true;
      hookExit();
      scheduleFlush();
    },

    /** 只读快照（给 `/status` 和设置页）。 */
    snapshot() {
      const cacheHitRate = data.promptTokens > 0 ? data.cacheReadTokens / data.promptTokens : 0;
      const last = data.last
        ? {
            ...data.last,
            cacheHitRate:
              data.last.promptTokens > 0 ? data.last.cacheReadTokens / data.last.promptTokens : 0,
          }
        : undefined;
      return {
        enabled,
        since: data.since,
        updatedAt: data.updatedAt,
        requests: data.requests,
        // 旧前端读 inputTokens：这里给输入总量，避免把缓存命中的部分漏掉。
        inputTokens: data.promptTokens,
        promptTokens: data.promptTokens,
        uncachedInputTokens: data.uncachedInputTokens,
        outputTokens: data.outputTokens,
        totalTokens: data.totalTokens,
        cacheReadTokens: data.cacheReadTokens,
        cacheWriteTokens: data.cacheWriteTokens,
        reasoningTokens: data.reasoningTokens,
        cacheHitRate,
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
