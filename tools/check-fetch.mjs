#!/usr/bin/env node
// 验证 createRetryFriendlyFetch：真实 HTTP 形状 + 假 fetch 注入。
// 重点覆盖 400/10013 的「一次性自愈」：同一请求体只改写一次，第二次原样失败。
import {
  createRetryFriendlyFetch,
  sanitizePiContext,
  shouldNormalizeUpstreamError,
  withRetryFriendlyFetch,
} from '../lib/scnet-fetch.js';

// —— 复刻自 dsh-llm-pi-ai/lib/index.js 的 classifyPiAiError（含正则顺序）——
function classifyPiAiError(message) {
  if (/\b(?:401|403)\b/.test(message)) return 'AUTH';
  if (/\b429\b|rate.?limit/i.test(message)) return 'RATE_LIMIT';
  if (/\b413\b|payload too large|request body too large/i.test(message)) return 'INVALID_REQUEST';
  if (/\b400\b|invalid.?request/i.test(message)) return 'INVALID_REQUEST';
  if (/\b5\d\d\b/.test(message)) return 'SERVER';
  if (/\btime(?:d)?\s*out\b|timeout/i.test(message)) return 'TIMEOUT';
  if (/stream ended (?:before|without)\b/i.test(message)) return 'TRANSPORT';
  return 'PI_AI_ERROR';
}

let failures = 0;
function expect(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (期望 ${JSON.stringify(expected)})`}`);
  if (!ok) failures += 1;
}

const jsonResponse = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

console.log('1. 5xx 抖动仍然改写');
{
  const body = { error: { message: 'routing changed', type: 'invalid_request_error', code: '10008' } };
  const wrapped = createRetryFriendlyFetch({ fetchImpl: async () => jsonResponse(503, body) });
  const res = await wrapped('https://example.invalid/x', { body: '{"a":1}' });
  const parsed = await res.json();
  expect('状态保留 503', res.status, 503);
  expect('type=api_error', parsed.error.type, 'api_error');
  expect('归类 SERVER', classifyPiAiError(`503: ${JSON.stringify(parsed)}`), 'SERVER');
}

console.log('\n2. 400/10013 第一次：改写为可重试');
{
  const body = {
    error: {
      message: 'Invalid request parameters. (request_id: 4a941908b455b68c-20261110154156187)',
      type: 'invalid_request_error',
      param: null,
      code: '10013',
    },
  };
  const wrapped = createRetryFriendlyFetch({ fetchImpl: async () => jsonResponse(400, body) });
  const res = await wrapped('https://example.invalid/x', { body: '{"model":"SCNet-Max","n":1}' });
  expect('状态 400 → 500', res.status, 500);
  const parsed = await res.json();
  expect('type=api_error', parsed.error.type, 'api_error');
  expect('code 保留 10013', parsed.error.code, '10013');
  const formatted = `500: ${JSON.stringify(parsed)}`;
  expect('归类 SERVER（可重试）', classifyPiAiError(formatted), 'SERVER');
  expect('保留 request_id', formatted.includes('4a941908b455b68c-20261110154156187'), true);
  expect('不再含 "Invalid request"', /invalid.?request/i.test(formatted), false);
}

console.log('\n3. 同一请求体第二次 10013：原样透传（真参数错误立刻失败）');
{
  const body = {
    error: { message: 'Invalid request parameters. (request_id: abc)', type: 'invalid_request_error', code: '10013' },
  };
  const wrapped = createRetryFriendlyFetch({ fetchImpl: async () => jsonResponse(400, body) });
  const init = { body: '{"model":"SCNet-Max","n":2}' };
  const first = await wrapped('https://example.invalid/x', init);
  expect('第一次改写 500', first.status, 500);
  const second = await wrapped('https://example.invalid/x', init);
  expect('第二次保持 400', second.status, 400);
  const parsed = await second.json();
  expect('第二次 type 原样', parsed.error.type, 'invalid_request_error');
  // 不同请求体（新的一次调用）仍然给一次自愈机会。
  const third = await wrapped('https://example.invalid/x', { body: '{"model":"SCNet-Max","n":3}' });
  expect('不同 body 重新自愈', third.status, 500);
}

console.log('\n4. 其它状态码不被改写');
for (const [label, status, body] of [
  ['401', 401, { error: { message: 'Authentication Failed', type: 'invalid_request_error', code: '401' } }],
  ['400 但非 10013', 400, { error: { message: 'bad', type: 'invalid_request_error', code: '10006' } }],
  ['200 正常', 200, { choices: [] }],
]) {
  const wrapped = createRetryFriendlyFetch({ fetchImpl: async () => jsonResponse(status, body) });
  const res = await wrapped('https://example.invalid/x', { body: '{"model":"x"}' });
  expect(`${label} 不改写`, res.status, status);
}

console.log('\n5. 非 JSON 与空 body');
{
  const wrapped = createRetryFriendlyFetch({
    fetchImpl: async () => new Response('<html>bad gateway</html>', { status: 503 }),
  });
  const res = await wrapped('https://example.invalid/x', {});
  expect('非 JSON 原样', res.status, 503);
}
{
  const body = { error: { message: 'Invalid request parameters.', type: 'invalid_request_error', code: '10013' } };
  const wrapped = createRetryFriendlyFetch({ fetchImpl: async () => jsonResponse(400, body) });
  const res = await wrapped('https://example.invalid/x', {});
  expect('无请求体时不自愈', res.status, 400);
}

console.log('\n6. shouldNormalizeUpstreamError 边界');
expect('503+10008', shouldNormalizeUpstreamError(503, { error: { type: 'invalid_request_error', code: '10008' } }), true);
expect('503+未知码', shouldNormalizeUpstreamError(503, { error: { type: 'invalid_request_error', code: '99999' } }), false);
expect('400 永不走 5xx 分支', shouldNormalizeUpstreamError(400, { error: { type: 'invalid_request_error', code: '10008' } }), false);

console.log('\n7. withRetryFriendlyFetch 透传 fetch');
{
  let seen;
  const api = {
    stream: async (model, context, options) => {
      seen = options?.fetch;
      return 'stream-ok';
    },
    streamSimple: async (model, context, options) => {
      seen = options?.fetch;
      return 'simple-ok';
    },
  };
  const injected = async () => new Response('{}');
  const wrapped = withRetryFriendlyFetch(api, injected);
  await wrapped.stream({}, {}, undefined);
  expect('stream 注入', seen === injected, true);
  await wrapped.streamSimple({}, {}, { temperature: 1 });
  expect('streamSimple 注入', seen === injected, true);
}

console.log('\n8. 数字错误码与重建响应头回归');
expect('503+数字未知码不改写', shouldNormalizeUpstreamError(503, { error: { type: 'invalid_request_error', code: 99999 } }), false);
expect('503+数字已知码可改写', shouldNormalizeUpstreamError(503, { error: { type: 'invalid_request_error', code: 10008 } }), true);
for (const status of [400, 503]) {
  const code = status === 400 ? '10013' : '10008';
  const wrapped = createRetryFriendlyFetch({
    fetchImpl: async () => new Response(JSON.stringify({ error: { type: 'invalid_request_error', code } }), {
      status,
      headers: { 'content-encoding': 'gzip', 'transfer-encoding': 'chunked', 'content-length': '123', 'x-request-id': 'local-regression' },
    }),
  });
  const res = await wrapped('https://example.invalid/x', { body: '{"regression":true}' });
  for (const header of ['content-encoding', 'transfer-encoding', 'content-length']) {
    expect(`状态 ${status} 删除 ${header}`, res.headers.get(header), null);
  }
  expect('保留追踪头', res.headers.get('x-request-id'), 'local-regression');
  expect('响应体仍是 JSON', (await res.json()).error.type, 'api_error');
}

console.log('\n9. sanitizePiContext：修 pi-ai 的 sections undefined.length 崩溃');
{
  // 线上事故（2026-11-17）：system 消息 sections 里值为 undefined 时，
  // pi-ai utils/text.js:17 的 parts.filter(p => p.length) 会抛
  // "Cannot read properties of undefined (reading 'length')"。
  // 这里只验证净化本身；真实崩溃链已用解包出来的 pi-ai 单独验证过。

  const poisoned = {
    systemPrompt: 'sp',
    messages: [
      {
        role: 'system',
        content: [{ type: 'text', text: 'p' }],
        sections: { good: 'ok', broken: undefined, removed: null, numeric: 7 },
        timestamp: 0,
        toolsAdded: [{ name: 'pwsh' }],
      },
      { role: 'user', content: [{ type: 'text', text: 'x' }], timestamp: 1 },
    ],
    tools: [],
  };

  const cleaned = sanitizePiContext(poisoned);
  expect('只保留字符串 section', JSON.stringify(cleaned.messages[0].sections), '{"good":"ok"}');
  expect('其它字段保留', cleaned.messages[0].toolsAdded.length, 1);
  expect('user 消息不受影响', cleaned.messages[1].content[0].text, 'x');
  expect('systemPrompt 保留', cleaned.systemPrompt, 'sp');

  // 纯函数：原对象不被改写
  expect('原对象 sections 键未变', Object.keys(poisoned.messages[0].sections).length, 4);
  expect('原对象仍含 undefined', poisoned.messages[0].sections.broken, undefined);

  // 全部合法时原样返回同一引用（零开销）
  const healthy = {
    messages: [{ role: 'system', content: [{ type: 'text', text: 'p' }], sections: { a: 'x' } }],
  };
  expect('无需清洗时返回同一引用', sanitizePiContext(healthy) === healthy, true);

  // sections 清空后整个字段被移除（等价于「没有 section」）
  const allBad = {
    messages: [{ role: 'system', content: [{ type: 'text', text: 'p' }], sections: { a: undefined } }],
  };
  const cleanedAllBad = sanitizePiContext(allBad);
  expect('全非法时移除 sections 字段', 'sections' in cleanedAllBad.messages[0], false);

  // 边界输入不抛
  for (const weird of [undefined, null, {}, { messages: null }, { messages: 'x' }]) {
    expect('边界输入不抛', (() => { try { sanitizePiContext(weird); return true; } catch { return false; } })(), true);
  }
  // 非 system 角色即使带 sections 也不动
  const userWithSections = { messages: [{ role: 'user', content: 'x', sections: { a: undefined } }] };
  expect('非 system 角色不改', sanitizePiContext(userWithSections) === userWithSections, true);

  // 包装器确实把净化后的 context 交给 pi-ai
  let received;
  const api = {
    stream: async (model, context) => { received = context; return 's'; },
    streamSimple: async (model, context) => { received = context; return 's'; },
  };
  const wrapped = withRetryFriendlyFetch(api, async () => new Response('{}'));
  await wrapped.streamSimple({}, poisoned, {});
  expect('streamSimple 收到净化后的 sections', JSON.stringify(received.messages[0].sections), '{"good":"ok"}');
  await wrapped.stream({}, poisoned, {});
  expect('stream 收到净化后的 sections', JSON.stringify(received.messages[0].sections), '{"good":"ok"}');
}

console.log(failures === 0 ? '\n全部通过' : `\n失败 ${failures} 项`);
process.exitCode = failures === 0 ? 0 : 1;
