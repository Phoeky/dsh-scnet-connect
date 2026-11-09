// 直连验证：用 SCNet 客户端本地保存的 model-service API Key 调用免费模型 SCNet-Max。
// 只读客户端凭据，不写任何东西。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'scnet-client');
const credDir = path.join(os.homedir(), '.sclaw', 'agent', 'scnet-credentials');
const credFile = fs.readdirSync(credDir).find((f) => f.endsWith('.json'));
const cred = JSON.parse(fs.readFileSync(path.join(credDir, credFile), 'utf8'));
const key = cred?.scnet?.key;
console.log('credential file:', credFile, '| key prefix:', key ? key.slice(0, 8) + '…' : 'MISSING');

const models = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.sclaw', 'agent', 'models.json'), 'utf8'));
const provider = models.providers.scnet;
console.log('baseUrl:', provider.baseUrl, '| api:', provider.api);
const model = provider.models.find((m) => m.id.toLowerCase() === 'scnet-max');
console.log('model:', model && { id: model.id, free: model.priceLabel, ctx: model.contextWindow, max: model.maxTokens });

const base = provider.baseUrl.replace(/\/+$/, '');

async function getModels() {
  const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` } });
  const text = await res.text();
  console.log('\nGET /models ->', res.status, text.slice(0, 800));
}

async function chat(stream) {
  const body = {
    model: 'SCNet-Max',
    stream: !!stream,
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: '用一句话回答：1+1 等于几？' },
    ],
    max_tokens: 64,
  };
  const started = Date.now();
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  console.log(`\nPOST /chat/completions (stream=${!!stream}) ->`, res.status, res.headers.get('content-type'), `${Date.now() - started}ms`);
  if (!res.ok) {
    console.log(await res.text());
    return;
  }
  if (!stream) {
    const json = await res.json();
    console.log(JSON.stringify(json).slice(0, 1200));
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let acc = '';
  let n = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    acc += decoder.decode(value, { stream: true });
    n++;
    if (acc.length > 4000) break;
  }
  console.log('first SSE ~', acc.slice(0, 1500).replace(/\n/g, '\\n'));
}

try {
  await getModels();
} catch (e) {
  console.log('GET /models failed:', e.message);
}
try {
  await chat(false);
} catch (e) {
  console.log('chat failed:', e.message);
}
try {
  await chat(true);
} catch (e) {
  console.log('chat stream failed:', e.message);
}
