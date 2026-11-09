// 探测 reasoning_effort 的合法取值 + stream 下 tool_calls 的 SSE 形态。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const credDir = path.join(os.homedir(), '.sclaw', 'agent', 'scnet-credentials');
const key = JSON.parse(
  fs.readFileSync(path.join(credDir, fs.readdirSync(credDir).find((f) => f.endsWith('.json'))), 'utf8'),
).scnet.key;
const base = 'https://api.scnet.cn/api/llm/v1';

for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'SCNet-Max',
      stream: false,
      max_tokens: 8,
      reasoning_effort: effort,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
  const text = await res.text();
  console.log(`effort=${effort} -> ${res.status} ${text.slice(0, 160).replace(/\n/g, ' ')}`);
}

// streaming tool call
const tool = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get weather',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
};
const res = await fetch(`${base}/chat/completions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'SCNet-Max',
    stream: true,
    max_tokens: 128,
    tools: [tool],
    tool_choice: 'auto',
    messages: [{ role: 'user', content: '杭州天气？调用 get_weather' }],
  }),
});
console.log('\nstream tools ->', res.status, res.headers.get('content-type'));
const reader = res.body.getReader();
const dec = new TextDecoder();
let acc = '';
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  acc += dec.decode(value, { stream: true });
  if (acc.includes('data: [DONE]')) break;
}
console.log(acc.slice(0, 4000));
