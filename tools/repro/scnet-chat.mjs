#!/usr/bin/env node
// 最小可复现示例：直连 SCNet 免费模型 SCNet-Max（无需客户端运行）。
// 用法：node tools/repro/scnet-chat.mjs [--stream] [提示词]
// 依赖：本机已登录过 SCNet 客户端（~/.sclaw/agent/scnet-credentials/*.json 中有 sk- key）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const credDir = path.join(os.homedir(), '.sclaw', 'agent', 'scnet-credentials');
const credFile = fs.readdirSync(credDir).find((f) => f.endsWith('.json'));
const key = JSON.parse(fs.readFileSync(path.join(credDir, credFile), 'utf8'))?.scnet?.key;
if (!key?.startsWith('sk-')) throw new Error('找不到 SCNet 模型凭据，请先启动并登录 SCNet 客户端');

const modelsDoc = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.sclaw', 'agent', 'models.json'), 'utf8'));
const BASE = (modelsDoc?.providers?.scnet?.baseUrl || 'https://api.scnet.cn/api/llm/v1').replace(/\/+$/, '');

const args = process.argv.slice(2);
const stream = args.includes('--stream');
const prompt = args.filter((a) => a !== '--stream').join(' ') || '用一句话介绍你自己';

const body = {
  model: 'SCNet-Max',
  messages: [{ role: 'user', content: prompt }],
  max_tokens: 512,
  stream,
  // 可选：none = 关闭思考；minimal/low/medium/high/xhigh/max = 思考强度
  // reasoning_effort: 'none',
};

const res = await fetch(`${BASE}/chat/completions`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    ...(stream ? { accept: 'text/event-stream' } : {}),
  },
  body: JSON.stringify(body),
});
if (!res.ok) {
  console.error(`HTTP ${res.status}:`, await res.text());
  process.exit(1);
}

if (!stream) {
  const json = await res.json();
  const msg = json.choices?.[0]?.message ?? {};
  if (msg.reasoning_content) console.log('[reasoning]\n' + msg.reasoning_content + '\n');
  console.log(msg.content ?? '');
  console.log('\n[usage]', JSON.stringify(json.usage));
} else {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let usage;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') break;
      try {
        const chunk = JSON.parse(data);
        const d = chunk.choices?.[0]?.delta ?? {};
        if (d.reasoning_content) process.stdout.write(d.reasoning_content);
        if (d.content) process.stdout.write(d.content);
        if (chunk.usage) usage = chunk.usage;
      } catch {}
    }
  }
  process.stdout.write('\n');
  if (usage) console.log('[usage]', JSON.stringify(usage));
}
