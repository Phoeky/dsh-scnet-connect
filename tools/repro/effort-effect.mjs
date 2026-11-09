// reasoning_effort 是否真的改变推理长度：none vs low vs max 对比 reasoning_tokens。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const credDir = path.join(os.homedir(), '.sclaw', 'agent', 'scnet-credentials');
const key = JSON.parse(
  fs.readFileSync(path.join(credDir, fs.readdirSync(credDir).find((f) => f.endsWith('.json'))), 'utf8'),
).scnet.key;
const base = 'https://api.scnet.cn/api/llm/v1';

for (const effort of ['none', 'low', 'high', 'max']) {
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'SCNet-Max',
      stream: false,
      max_tokens: 512,
      reasoning_effort: effort,
      messages: [{ role: 'user', content: '9.11 和 9.9 哪个大？为什么？请简短回答。' }],
    }),
  });
  const json = await res.json();
  const u = json.usage || {};
  console.log(
    `effort=${effort} status=${res.status} reasoning_tokens=${u.completion_tokens_details?.reasoning_tokens} output=${u.completion_tokens} content=${JSON.stringify(json.choices?.[0]?.message?.content || '').slice(0, 80)}`,
  );
}
