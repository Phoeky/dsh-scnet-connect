/**
 * 用量/诊断文件的路径与 profile 兼容逻辑
 * ------------------------------------------------------------------
 * 单独成模块的原因：这些是纯函数（只碰 fs 与字符串），不依赖 DSH 宿主包，
 * 因此可以离线单测。`lib/index.js` 依赖 `@deepseek-ai/*`，裸 Node 导不进来。
 *
 * 背景（1.3.1 修的一个重要 bug）
 * ------------------------------
 * 1.3.0 用 `process.env.DSH_PROFILE` 判断 profile 名 —— **这是错的**。
 * 该变量由 `dsh-shell-env` 在**每次 shell 调用**（bash/pwsh）时注入，
 * 插件自己的进程里没有它，于是恒为空串，文件名永远不带后缀。
 * 一旦某次运行恰好带了环境变量、另一次没带，两个实例就各写各的文件，
 * 用户看到的就是「Token 用量重启后归零」。
 *
 * 权威来源是 DSH 提供的 `profileContext` 服务（`ctx.get('profileContext')?.name`）。
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * 规范化 profile 名：只保留文件名安全的字符。
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function sanitizeProfileName(raw) {
  return typeof raw === 'string' ? raw.trim().replace(/[^\w.-]/g, '_') : '';
}

/**
 * 解析当前 profile 名。
 *
 * @param {{ name?: unknown } | undefined} profileContext DSH 提供的 profileContext
 * @param {Record<string, string | undefined>} [env] 环境变量（默认 process.env）
 * @returns {string} 已规范化，可能是空串（无 profile 启动）
 */
export function resolveProfileName(profileContext, env = process.env) {
  const fromContext = sanitizeProfileName(profileContext?.name);
  if (fromContext) return fromContext;
  return sanitizeProfileName(env?.DSH_PROFILE);
}

/**
 * Token 用量文件的落盘路径。
 *
 * 带 profile 后缀：同一个 `DSH_HOME` 下跑 desktop / tui 时，两个实例的累计
 * 用量不会互相覆盖。有 profile 时先尝试迁移 1.3.0 留下的无后缀旧文件。
 *
 * @param {string} home `$DSH_HOME`
 * @param {string} profile 当前 profile 名（可能是空串）
 * @param {{info?: (m: string) => void, warn?: (m: string) => void}} [logger]
 * @returns {string}
 */
export function usageFilePath(home, profile, logger = {}) {
  const suffix = profile ? `.${profile}` : '';
  const target = path.join(home, `scnet-connect-usage${suffix}.json`);
  if (!profile) return target;
  return migrateLegacyUsageFile(home, target, profile, logger);
}

/**
 * 把 1.3.0 留下的无后缀用量文件迁移到带 profile 后缀的名字。
 *
 * 规则：
 *   - 目标文件已存在 → 不动（新文件是权威）；
 *   - 旧文件不存在 → 直接用新名字；
 *   - 旧文件带归属 profile 且与当前不符 → 不迁移（避免把 tui 的用量算进 desktop）；
 *   - 否则改名迁移。
 *
 * 任何失败都退回「继续用旧文件」：宁可少迁移，也不能丢数据。
 *
 * @param {string} home `$DSH_HOME`
 * @param {string} target 带后缀的目标路径
 * @param {string} profile 当前 profile 名
 * @param {{info?: (m: string) => void, warn?: (m: string) => void}} [logger]
 * @returns {string} 最终应当使用的路径
 */
export function migrateLegacyUsageFile(home, target, profile, logger = {}) {
  const legacy = path.join(home, 'scnet-connect-usage.json');
  if (legacy === target) return target;
  try {
    if (fs.existsSync(target)) return target; // 新文件已在，别动。
    if (!fs.existsSync(legacy)) return target; // 没有旧文件，直接用新名字。

    // 旧文件记录了归属 profile 时，只有匹配才迁移（旧版写的是空串/缺省）。
    let owner = '';
    try {
      const raw = JSON.parse(fs.readFileSync(legacy, 'utf8'));
      owner = sanitizeProfileName(raw?.profile);
    } catch {
      // 解析不了就当作无归属，允许迁移（内容会在 recorder 里再归一化）。
    }
    if (owner && owner !== profile) return legacy; // 别的 profile 的，继续用它自己的文件。

    fs.renameSync(legacy, target);
    logger.info?.(`已把旧的 token 用量文件迁移到带 profile 后缀的名字：${path.basename(target)}`);
    return target;
  } catch (error) {
    logger.warn?.(
      `token 用量文件迁移失败（继续使用旧文件）：${error instanceof Error ? error.message : String(error)}`,
    );
    return fs.existsSync(legacy) ? legacy : target;
  }
}

/**
 * 诊断快照文件的路径（与用量文件同规则，但不做迁移）。
 *
 * @param {string} home `$DSH_HOME`
 * @param {string} profile 当前 profile 名
 * @returns {string}
 */
export function statusFilePath(home, profile) {
  const suffix = profile ? `.${profile}` : '';
  return path.join(home, `scnet-connect-status${suffix}.json`);
}
