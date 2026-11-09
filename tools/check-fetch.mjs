#!/usr/bin/env node
// 验证 createRetryFriendlyFetch：真实 HTTP 形状 + 假 fetch 注入。
import { createRetryFriendlyFetch, withRetryFriendlyFetch } from '../lib/scnet-fetch.js';

const cases = [
  {
    label: '503 + invalid_request_error/10008（应改写）',
    status: 503,
    body: {
      error: {
        message:
          "The model's routing or availability changed while processing the request. Please try again.",
        type: 'invalid_request_error',
        code: '10008',
      },
    },
  },
  {
    label: '400 + invalid_request_error/10013（不该改写）',
    status: 400,
    body: { error: { message: 'Invalid request parameters.', type: 'invalid_request_error', code: '10013' } },
  },
  {
    label: '401（不该改写）',
    status: 401,
    body: { error: { message: 'Authentication Failed', type: 'invalid_request_error', code: '401' } },
  },
  {
    label: '200 正常响应（不该改写）',
    status: 200,
    body: { choices: [{ message: { content: 'ok' } }] },
  },
  {
    label: '503 但非 JSON（不该改写）',
    status: 503,
    raw: '<html>bad gateway</html>',
  },
];

let failures = 0;
for (const item of cases) {
  const fakeFetch = async () =>
    new Response(item.raw ?? JSON.stringify(item.body), {
      status: item.status,
      headers: { 'content-type': 'application/json' },
    });
  const wrapped = createRetryFriendlyFetch({ fetchImpl: fakeFetch });
  const res = await wrapped('https://example.invalid/x', {});
  const text = await res.text();
  let type;
  try {
    type = JSON.parse(text)?.error?.type;
  } catch {
    type = '(non-json)';
  }
  console.log(`${item.label} → status=${res.status} type=${type ?? '-'}`);
  if (item.label.includes('应改写') && type !== 'api_error') {
    console.log('  ✗ 期望改写为 api_error');
    failures += 1;
  }
  if (item.label.includes('不该改写') && type === 'api_error') {
    console.log('  ✗ 不该改写却改写了');
    failures += 1;
  }
}

// withRetryFriendlyFetch 是否真的把 fetch 透传进 stream 的 options
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
  const okStream = seen === injected;
  await wrapped.streamSimple({}, {}, { temperature: 1 });
  const okSimple = seen === injected;
  console.log(`withRetryFriendlyFetch 透传 fetch：stream=${okStream} streamSimple=${okSimple}`);
  if (!okStream || !okSimple) failures += 1;
}

console.log(failures === 0 ? '\n全部通过' : `\n失败 ${failures} 项`);
process.exitCode = failures === 0 ? 0 : 1;
