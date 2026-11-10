/**
 * 设置页 HTTP 小工具
 * ------------------------------------------------------------------
 * 从 `index.js` 抽出来的两个纯 Node 函数，便于离线测试：
 *   - `sendJson`：统一 JSON 响应头，HEAD 只发头；
 *   - `readJsonBody`：限制大小的 JSON 请求体读取。
 *
 * 单独成模块的原因不是“架构好看”，而是这两个函数各有一个容易回归的边界：
 *   - HEAD 响应不能带 body；
 *   - 请求体超限时必须先把 413 写出去，再排空/关闭请求流。先 `req.destroy()`
 *     会让客户端只看到 `UND_ERR_SOCKET`，413 根本收不到。
 */

/** 设置页请求体上限（只会发很小的 JSON；超过按 413 拒绝）。 */
export const MAX_JSON_BODY_BYTES = 64 * 1024;

/**
 * 发一个 JSON 响应。
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {any} body
 * @param {{ head?: boolean }} [options]
 * @returns {boolean} 是否真的写了响应（连接已关闭时返回 false）
 */
export function sendJson(res, status, body, options = {}) {
  if (res.writableEnded || res.destroyed || res.headersSent) return false;
  const payload = `${JSON.stringify(body, null, 2)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  if (options.head) {
    res.end();
    return true;
  }
  res.end(payload);
  return true;
}

/**
 * 读取并限制大小的 JSON 请求体。
 *
 * 超限时返回 `null`（而不是 `{}`）：把「请求体非法/过大」和「请求体是空对象」
 * 区分开，调用方才能回 413。超限后**不立即销毁 socket**，而是摘掉 data 监听、
 * `req.resume()` 排空剩余字节，让 413 能正常送达；排空完成后连接可继续复用。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {{ limit?: number }} [options]
 * @returns {Promise<object | null>} `null` = 请求体超限
 */
export function readJsonBody(req, options = {}) {
  const limit = typeof options.limit === 'number' && options.limit > 0 ? options.limit : MAX_JSON_BODY_BYTES;
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    const cleanup = () => {
      req.off?.('data', onData);
      req.off?.('end', onEnd);
      req.off?.('error', onError);
      req.off?.('aborted', onAborted);
    };
    const finish = (value, { drain = false } = {}) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (drain) req.resume?.();
      resolve(value);
    };
    const onData = (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        finish(null, { drain: true });
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
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
    };
    const onError = () => finish({});
    const onAborted = () => finish({});

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}
