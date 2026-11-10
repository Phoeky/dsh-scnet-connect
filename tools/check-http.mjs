#!/usr/bin/env node
// 设置页 HTTP 小工具的离线回归：
//   1. 正常 JSON / 非法 JSON / 空 body；
//   2. 超过上限时必须真的收到 413，而不是先 destroy 导致的 UND_ERR_SOCKET；
//   3. HEAD 只发头、不发 body。

import assert from 'node:assert/strict';
import http from 'node:http';

import { MAX_JSON_BODY_BYTES, readJsonBody, sendJson } from '../lib/scnet-http.js';

const server = http.createServer(async (req, res) => {
  const body = await readJsonBody(req);
  if (body === null) {
    sendJson(res, 413, { error: '请求体过大' });
    return;
  }
  sendJson(res, 200, { body }, { head: req.method === 'HEAD' });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

let failures = 0;
async function check(label, fn) {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failures++;
    console.log(`  ✗ ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

try {
  console.log('1. 正常 JSON');
  const ok = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ freeOnly: false }),
  });
  await check('状态 200', () => assert.equal(ok.status, 200));
  const okBody = await ok.json();
  await check('字段保留', () => assert.equal(okBody.body.freeOnly, false));

  console.log('\n2. 空 body / 非法 JSON');
  const empty = await fetch(url, { method: 'POST' });
  await check('空 body 状态 200', () => assert.equal(empty.status, 200));
  await check('空 body 解析为 {}', async () => assert.deepEqual((await empty.json()).body, {}));

  const bad = await fetch(url, { method: 'POST', body: '{not json' });
  await check('非法 JSON 状态 200', () => assert.equal(bad.status, 200));
  await check('非法 JSON 解析为 {}', async () => assert.deepEqual((await bad.json()).body, {}));

  console.log('\n3. 超过上限：必须收到 413');
  const big = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'x'.repeat(MAX_JSON_BODY_BYTES + 1024),
  });
  await check('状态 413', () => assert.equal(big.status, 413));
  const bigBody = await big.json();
  await check('错误文案', () => assert.equal(bigBody.error, '请求体过大'));

  const after = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ after: true }),
  });
  await check('413 之后的请求仍正常', () => assert.equal(after.status, 200));
  await check('413 之后 body 未串包', async () => assert.deepEqual((await after.json()).body, { after: true }));

  console.log('\n4. HEAD：有 content-length、无 body');
  const head = await fetch(url, { method: 'HEAD' });
  await check('状态 200', () => assert.equal(head.status, 200));
  await check('content-length > 0', () => assert.ok(Number(head.headers.get('content-length')) > 0));
  await check('body 为空', async () => assert.equal(await head.text(), ''));
} finally {
  server.close();
}

console.log(failures === 0 ? '\n结论：全部通过' : `\n结论：${failures} 项失败`);
process.exitCode = failures === 0 ? 0 : 1;
