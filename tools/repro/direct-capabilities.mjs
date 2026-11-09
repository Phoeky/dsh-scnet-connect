// 验证 SCNet-Max 的 OpenAI 兼容能力边界：reasoning_effort、工具调用、图片输入、错误码。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const credDir = path.join(os.homedir(), '.sclaw', 'agent', 'scnet-credentials');
const credFile = fs.readdirSync(credDir).find((f) => f.endsWith('.json'));
const key = JSON.parse(fs.readFileSync(path.join(credDir, credFile), 'utf8')).scnet.key;
const base = 'https://api.scnet.cn/api/llm/v1';

async function post(label, body) {
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'SCNet-Max', stream: false, max_tokens: 256, ...body }),
  });
  const text = await res.text();
  console.log(`\n===== ${label} -> ${res.status} =====`);
  console.log(text.slice(0, 1200));
}

const tool = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get weather for a city',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
};

try {
  await post('reasoning_effort=high', {
    reasoning_effort: 'high',
    messages: [{ role: 'user', content: '只说一个字：好' }],
  });
} catch (e) {
  console.log('reasoning_effort failed', e.message);
}

try {
  await post('tools', {
    tools: [tool],
    tool_choice: 'auto',
    messages: [{ role: 'user', content: '杭州天气怎么样？请调用 get_weather 工具。' }],
  });
} catch (e) {
  console.log('tools failed', e.message);
}

try {
  const img = fs.readFileSync(path.join(process.cwd(), 'tools', 'repro', 'pixel.png'));
  await post('image', {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '这张图片是什么颜色？只回答颜色。' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${img.toString('base64')}` } },
        ],
      },
    ],
  });
} catch (e) {
  console.log('image failed', e.message);
}

try {
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: 'Bearer sk-invalid-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'SCNet-Max', messages: [{ role: 'user', content: 'hi' }] }),
  });
  console.log('\n===== invalid key ->', res.status, '=====');
  console.log((await res.text()).slice(0, 800));
} catch (e) {
  console.log('invalid key failed', e.message);
}
