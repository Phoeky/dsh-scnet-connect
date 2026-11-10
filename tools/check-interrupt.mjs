#!/usr/bin/env node
// 验证「上游流中途中断」这类错误被改写成可重试的 TRANSPORT。
//
// 用 DSH 真实的 classifyPiAiError 逻辑（含正则顺序，复刻自 app.asar），
// 跑三条路径：
//   1. 原文（现状）—— 落兜底 PI_AI_ERROR，不可重试；
//   2. 走 createRetryFriendlyFetch 的 SSE 改写 —— 落 TRANSPORT，可重试；
//   3. 终止帧之后的错误、无内容的错误 —— 不该被改写（防止把真错误拖成重试）。

import {
  createRetryFriendlyFetch,
  isInterruptedStreamMessage,
  normalizeInterruptedStreamMessage,
} from '../lib/scnet-fetch.js';

// —— 复刻自 dsh-llm-pi-ai/lib/index.js 的 classifyPiAiError（含正则顺序）——
function isQuotaExceededError(message) {
  return /insufficient.?quota|quota.?exceeded|exceeded your current quota|billing/i.test(message);
}
function classifyPiAiError(message) {
  if (/\b(?:401|403)\b/.test(message)) return 'AUTH';
  if (isQuotaExceededError(message)) return 'QUOTA';
  if (/\b429\b|rate.?limit/i.test(message)) return 'RATE_LIMIT';
  if (/\b413\b|failed to buffer the request body:\s*length limit exceeded|payload too large|request body too large/i.test(message)) return 'INVALID_REQUEST';
  if (/\b400\b|invalid.?request/i.test(message)) return 'INVALID_REQUEST';
  if (/\b5\d\d\b/.test(message)) return 'SERVER';
  if (/\btime(?:d)?\s*out\b|timeout/i.test(message)) return 'TIMEOUT';
  if (/stream ended (?:before|without)\b/i.test(message)) return 'TRANSPORT';
  return 'PI_AI_ERROR';
}

const RETRYABLE = ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'];

// 失败会话里那条真实错误（seq 40 的 turn/end，见下方注释）。
const REAL = 'The response stream was interrupted. (request_id: bec198bdb37b73f0-20261110111508406)';

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}: ${actual}${ok ? '' : `  (期望 ${expected})`}`);
}

// ---------------------------------------------------------------- 1. 原文
console.log('1. 现状：上游原文直接进分类器');
check('归类', classifyPiAiError(REAL), 'PI_AI_ERROR');
console.log(`  可重试=${RETRYABLE.includes(classifyPiAiError(REAL))} → 本轮直接失败，一次都不重试`);

// ------------------------------------------------- 2. 改写后的文本本身
console.log('\n2. 改写后的文本');
const rewritten = normalizeInterruptedStreamMessage(REAL);
console.log(`  ${rewritten}`);
check('归类', classifyPiAiError(rewritten), 'TRANSPORT');
console.log(`  可重试=${RETRYABLE.includes(classifyPiAiError(rewritten))} → 交给 DSH 退避重试（最多 5 次）`);
check('原文 request_id 仍在', rewritten.includes('bec198bdb37b73f0-20261110111508406'), true);

// ------------------------------------- 3. 走真实 fetch 包装，端到端
console.log('\n3. 端到端：SSE 流中途被上游塞入 error 帧');

const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;

function sseResponse(frames) {
  const body = new ReadableStream({
    start(controller) {
      // 故意把帧切碎，验证跨 chunk 的缓冲。
      const text = frames.join('');
      const enc = new TextEncoder();
      for (let i = 0; i < text.length; i += 37) {
        controller.enqueue(enc.encode(text.slice(i, i + 37)));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const contentFrames = [
  sse({ id: 'bec198bdb37b73f0-20261110111508406', choices: [{ delta: { reasoning_content: '让我想想' } }] }),
  sse({ choices: [{ delta: { content: '草稿' } }] }),
];
const errorFrame = sse({
  error: {
    message: REAL,
    type: 'server_error',
    code: null,
  },
});

const wrapped = createRetryFriendlyFetch({
  fetchImpl: async () => sseResponse([...contentFrames, errorFrame]),
  onInterrupt: ({ message }) => console.log(`  [onInterrupt] 捕获：${message}`),
});

const res = await wrapped('https://example.invalid/v1/chat/completions', {});
check('content-type 保留', res.headers.get('content-type'), 'text/event-stream');
const out = await res.text();
check('保留 reasoning 帧', out.includes('"reasoning_content":"让我想想"'), true);
check('保留 content 帧', out.includes('"content":"草稿"'), true);

const errPayload = out
  .split('\n\n')
  .filter(Boolean)
  .map((f) => f.replace(/^data: /, ''))
  .map((t) => JSON.parse(t))
  .find((o) => o.error);
console.log(`  改写后 error.message = ${errPayload.error.message}`);
check('错误帧 message 归类', classifyPiAiError(errPayload.error.message), 'TRANSPORT');
check('错误帧 type 保留', errPayload.error.type, 'server_error');

// --------------------------------- 4. 不该改写的两种情况
console.log('\n4. 不该改写的情况（避免把真错误拖成重试）');

// 4a. 终止帧之后的错误
{
  const w = createRetryFriendlyFetch({
    fetchImpl: async () =>
      sseResponse([
        ...contentFrames,
        sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
        'data: [DONE]\n\n',
        errorFrame,
      ]),
  });
  const text = await (await w('https://example.invalid/x', {})).text();
  const last = text.split('\n\n').filter(Boolean).pop().replace(/^data: /, '');
  check('终止后错误不改写', JSON.parse(last).error.message, REAL);
}

// 4b. 还没收到任何内容就报错
{
  const w = createRetryFriendlyFetch({ fetchImpl: async () => sseResponse([errorFrame]) });
  const text = await (await w('https://example.invalid/x', {})).text();
  const first = text.split('\n\n').filter(Boolean)[0].replace(/^data: /, '');
  check('首帧错误不改写', JSON.parse(first).error.message, REAL);
}

// 4c. 完全无关的错误帧
{
  const other = sse({ error: { message: 'Upstream is overloaded, please retry later', type: 'api_error' } });
  const w = createRetryFriendlyFetch({ fetchImpl: async () => sseResponse([...contentFrames, other]) });
  const text = await (await w('https://example.invalid/x', {})).text();
  const last = text.split('\n\n').filter(Boolean).pop().replace(/^data: /, '');
  check('无关错误不改写', JSON.parse(last).error.message, 'Upstream is overloaded, please retry later');
}

// 4d. 非 SSE 的 2xx 不包 body
{
  const w = createRetryFriendlyFetch({
    fetchImpl: async () =>
      new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  const r = await w('https://example.invalid/x', {});
  check('非 SSE 原样返回', await r.text(), '{"ok":true}');
}

// --------------------------------- 5. 特征函数边界
console.log('\n5. isInterruptedStreamMessage 边界');
check('真实文案', isInterruptedStreamMessage(REAL), true);
check('被动语态', isInterruptedStreamMessage('The response stream has been interrupted.'), true);
check('无关文案', isInterruptedStreamMessage('Rate limit reached'), false);
check('非字符串', isInterruptedStreamMessage(undefined), false);

// --------------------------- 6. 字节级一致性（正常流零影响）
console.log('\n6. 正常流逐字节一致（任意切块）');

const normalSSE = [
  sse({ id: 'abc-20261110', choices: [{ delta: { role: 'assistant' } }] }),
  sse({ choices: [{ delta: { reasoning_content: '先拆解问题' } }] }),
  sse({ choices: [{ delta: { reasoning_content: '，再落到实现。' } }] }),
  sse({ choices: [{ delta: { content: '递归是' } }] }),
  sse({ choices: [{ delta: { content: '函数调用自身。' } }] }),
  sse({
    choices: [
      {
        delta: {},
        finish_reason: 'stop',
      },
    ],
  }),
  sse({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 } }),
  'data: [DONE]\n\n',
].join('');

function chunkedResponse(text, size) {
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function drainBytes(response) {
  const reader = response.body.getReader();
  const parts = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return new TextDecoder().decode(out);
}

for (const size of [1, 3, 7, 64, 4096]) {
  let interrupted = 0;
  const wrapped = createRetryFriendlyFetch({
    fetchImpl: async () => chunkedResponse(normalSSE, size),
    onInterrupt: () => {
      interrupted++;
    },
  });
  const out = await drainBytes(await wrapped('https://example.invalid/x', {}));
  check(`切块 ${size} 字节逐字节一致`, out === normalSSE, true);
  check(`切块 ${size} 字节无误改写`, interrupted, 0);
}

// --------------------------- 7. 提前取消不产生未处理拒绝
console.log('\n7. 提前取消读取');
{
  let unhandled = null;
  const onUnhandled = (e) => {
    unhandled = e;
  };
  process.on('unhandledRejection', onUnhandled);

  const wrapped = createRetryFriendlyFetch({
    fetchImpl: async () => chunkedResponse(normalSSE, 16),
  });
  const res = await wrapped('https://example.invalid/x', {});
  const reader = res.body.getReader();
  await reader.read();
  await reader.cancel('test-cancel');

  // 给上游 pipeTo 的 rejection 一个冒头的机会。
  await new Promise((r) => setTimeout(r, 300));
  process.off('unhandledRejection', onUnhandled);
  check('无 unhandledRejection', unhandled, null);
}

// --------------------------- 8. CRLF 流（U2 回归）
console.log('\n8. CRLF 分隔的 SSE');
{
  const crlf = (o) => `data: ${JSON.stringify(o)}\r\n\r\n`;
  const frames = [
    crlf({ choices: [{ delta: { content: '第一段' } }] }),
    crlf({ choices: [{ delta: { content: '第二段' } }] }),
    crlf({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
  ];

  // 8a. 正常 CRLF 流逐字节一致（任意切块）。
  for (const size of [1, 7, 64]) {
    const wrapped = createRetryFriendlyFetch({
      fetchImpl: async () => chunkedResponse(frames.join(''), size),
    });
    const out = await drainBytes(await wrapped('https://example.invalid/x', {}));
    check(`CRLF 切块 ${size} 字节逐字节一致`, out === frames.join(''), true);
  }

  // 8b. CRLF 流中途的 error 帧也要被改写。
  const error = crlf({ error: { message: REAL, type: 'server_error', code: null } });
  const wrapped = createRetryFriendlyFetch({
    fetchImpl: async () => chunkedResponse(frames[0] + error, 5),
  });
  const out = await drainBytes(await wrapped('https://example.invalid/x', {}));
  check('CRLF error 帧已改写', out.includes('SCNet stream ended before completion'), true);
  check('CRLF request_id 仍保留', out.includes('bec198bdb37b73f0-20261110111508406'), true);

  // 8c. 第一帧必须在流结束前就能读到（证明没有整段缓冲）。
  let closed = false;
  const slow = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frames[0]));
        setTimeout(() => {
          try {
            controller.enqueue(new TextEncoder().encode(frames.slice(1).join('')));
            controller.close();
            closed = true;
          } catch {
            // 读取端可能已经取消；这不是被测行为。
          }
        }, 50);
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
  const streamWrapped = createRetryFriendlyFetch({ fetchImpl: async () => slow });
  const reader = (await streamWrapped('https://example.invalid/x', {})).body.getReader();
  const first = await reader.read();
  check('CRLF 首帧未被整段缓冲', closed, false);
  check('CRLF 首帧内容可读', new TextDecoder().decode(first.value).includes('第一段'), true);
  await reader.cancel('test-done');
}

console.log(
  failures === 0
    ? '\n结论：全部通过——流中途中断已从「不可重试」变成「可重试」，且未误伤真实错误'
    : `\n结论：${failures} 项失败`,
);
process.exitCode = failures === 0 ? 0 : 1;
