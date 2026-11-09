#!/usr/bin/env node
// 用 DSH 真实的 classifyPiAiError 逻辑，对比「改写前 / 改写后」的错误文本归类。
// 该函数在 app.asar 里是闭包内私有，这里按原样复刻（含正则顺序），
// 只用来验证归类结果，不参与插件运行。

import { createRetryFriendlyFetch } from '../lib/scnet-fetch.js';

// —— 复刻自 dsh-llm-pi-ai/lib/index.js 的 classifyPiAiError ——
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

const original = {
  error: {
    message: "The model's routing or availability changed while processing the request. Please try again.",
    type: 'invalid_request_error',
    code: '10008',
  },
};

// pi-ai 的 formatProviderError 在 body 与 message 不同时输出 `<status>: <body>`，
// message 已含 body 时直接输出 message。两种都试一遍。
const before = `503: ${JSON.stringify(original)}`;
const beforeBare = original.error.message;

console.log('改写前（现状）');
for (const [label, text] of [['含 body', before], ['仅 message', beforeBare]]) {
  const code = classifyPiAiError(text);
  console.log(`  ${label}: code=${code} 可重试=${RETRYABLE.includes(code)}`);
}

const fakeFetch = async () =>
  new Response(JSON.stringify(original), { status: 503, headers: { 'content-type': 'application/json' } });
const wrapped = createRetryFriendlyFetch({ fetchImpl: fakeFetch });
const res = await wrapped('https://example.invalid/x', {});
const rewrittenText = await res.text();
const rewritten = JSON.parse(rewrittenText);

const after = `503: ${rewrittenText}`;
const afterBare = rewritten.error.message;

console.log('\n改写后');
for (const [label, text] of [['含 body', after], ['仅 message', afterBare]]) {
  const code = classifyPiAiError(text);
  console.log(`  ${label}: code=${code} 可重试=${RETRYABLE.includes(code)}`);
}

const ok = !RETRYABLE.includes(classifyPiAiError(before)) && RETRYABLE.includes(classifyPiAiError(after));
console.log(ok ? '\n结论：改写确实把不可重试变成可重试（SERVER）' : '\n结论：改写无效，需换方案');
process.exitCode = ok ? 0 : 1;
