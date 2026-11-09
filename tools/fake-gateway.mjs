#!/usr/bin/env node
// 假 SCNet 网关：前 N 次 chat 请求返回真实的 503/10008 形状，之后返回正常 SSE。
// 每次请求都把计数写进 .review/fake-gateway-hits.json，供外层断言。
//
// 用法：node tools/fake-gateway.mjs [端口] [前N次失败]
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const PORT = Number(process.argv[2] ?? 45871);
const FAIL_TIMES = Number(process.argv[3] ?? 2);
const HITS_FILE = path.resolve('.review/fake-gateway-hits.json');

const SSE_OK = [
  'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"SCNet-Max","choices":[{"index":0,"delta":{"role":"assistant","content":"收到"}}]}',
  '',
  'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"SCNet-Max","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  '',
  'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"SCNet-Max","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}',
  '',
  'data: [DONE]',
  '',
].join('\n');

let chatHits = 0;
const log = [];

function writeHits() {
  try {
    fs.mkdirSync(path.dirname(HITS_FILE), { recursive: true });
    fs.writeFileSync(HITS_FILE, JSON.stringify({ chatHits, log }, null, 2), 'utf8');
  } catch {}
}

const server = http.createServer((req, res) => {
  if (req.url?.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'SCNet-Max', object: 'model' }] }));
    return;
  }
  if (req.url?.includes('/chat/completions')) {
    chatHits += 1;
    const hit = chatHits;
    if (hit <= FAIL_TIMES) {
      const body = JSON.stringify({
        error: {
          message:
            "The model's routing or availability changed while processing the request. Please try again.",
          type: 'invalid_request_error',
          code: '10008',
        },
      });
      log.push({ hit, status: 503 });
      writeHits();
      res.writeHead(503, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      console.log(`  [server] #${hit} → 503 (10008)`);
      return;
    }
    log.push({ hit, status: 200 });
    writeHits();
    console.log(`  [server] #${hit} → 200 SSE`);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.end(SSE_OK);
    return;
  }
  res.writeHead(404).end();
});

writeHits();
server.listen(PORT, '127.0.0.1', () => {
  console.log(`假网关已监听 127.0.0.1:${PORT}，前 ${FAIL_TIMES} 次 chat 请求返回 503/10008`);
});
