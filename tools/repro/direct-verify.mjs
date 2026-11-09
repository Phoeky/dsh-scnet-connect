// Direct, reproducible probe of SCNet's OpenAI-compatible LLM endpoint (scnet-max).
// Reads the client-managed model-service API key + provider config, then exercises:
//   /models, non-stream chat, reasoning_effort grid, streamed SSE, tools, invalid key, concurrency.
// Raw payloads are saved under .research/scnet-probe/ for evidence; secrets are redacted in stdout.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OUT = path.join(process.cwd(), '.research', 'scnet-probe');
fs.mkdirSync(OUT, { recursive: true });

const credDir = path.join(os.homedir(), '.sclaw', 'agent', 'scnet-credentials');
const credFile = fs.readdirSync(credDir).find((f) => f.endsWith('.json'));
const cred = JSON.parse(fs.readFileSync(path.join(credDir, credFile), 'utf8'));
const KEY = cred.scnet.key;
const modelsDoc = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.sclaw', 'agent', 'models.json'), 'utf8'));
const provider = modelsDoc.providers.scnet;
const BASE = provider.baseUrl.replace(/\/+$/, '');
const mask = (s) => String(s).replace(/sk-[A-Za-z0-9+/=_-]+/g, 'sk-<REDACTED>');
const save = (name, data) => {
  const file = path.join(OUT, name);
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  return file;
};
const log = (...a) => console.log(...a);

log(`credential: ~/.sclaw/agent/scnet-credentials/${credFile}`);
log(`key: ${KEY.slice(0, 6)}<REDACTED> len=${KEY.length} decoded=${Buffer.from(KEY.replace(/^sk-/, ''), 'base64').toString()}`);
log(`baseUrl: ${BASE} | api: ${provider.api} | models=${provider.models.length}`);
log(`SCNet-Max: ${JSON.stringify(provider.models.find((m) => m.id === 'SCNet-Max'))}`);

const jfetch = async (url, init) => {
  const t0 = Date.now();
  const res = await fetch(url, init);
  const text = await res.text();
  const ms = Date.now() - t0;
  let json; try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, ms, text, json, headers: Object.fromEntries(res.headers.entries()) };
};

const results = {};

async function stepModels() {
  const r = await jfetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${KEY}` } });
  save('01-models.json', r.text);
  const ids = (r.json?.data ?? []).map((m) => m.id);
  results.models = { status: r.status, ms: r.ms, count: ids.length, ids };
  log(`\n[1] GET /models -> ${r.status} (${r.ms}ms) count=${ids.length}`);
  log('    ids:', ids.join(', ').slice(0, 1500));
  if (r.json?.data?.[0]) log('    sample obj:', mask(JSON.stringify(r.json.data[0])));
}

async function chatOnce(name, body, headers = {}) {
  const r = await jfetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  save(name, r.text);
  const msg = r.json?.choices?.[0]?.message;
  const out = {
    status: r.status,
    ms: r.ms,
    finish: r.json?.choices?.[0]?.finish_reason,
    content: msg?.content,
    reasoning_content: msg?.reasoning_content,
    reasoning: msg?.reasoning,
    tool_calls: msg?.tool_calls,
    usage: r.json?.usage,
    error: r.json?.error,
  };
  log(`\n[${name}] HTTP ${r.status} (${r.ms}ms)`);
  log('   ', mask(JSON.stringify(out)).slice(0, 1200));
  return r;
}

async function stepChat() {
  await chatOnce('02-chat-plain.json', {
    model: 'SCNet-Max',
    messages: [{ role: 'user', content: '用一句话回答：1+1 等于几？' }],
    max_tokens: 128,
  });
}

async function stepEffortGrid() {
  const efforts = ['low', 'medium', 'high', 'max', 'xhigh', 'minimal', 'none'];
  const grid = [];
  for (const effort of efforts) {
    const body = { model: 'SCNet-Max', messages: [{ role: 'user', content: '2的10次方是多少？只输出数字' }], max_tokens: 64, reasoning_effort: effort };
    const r = await jfetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const msg = r.json?.choices?.[0]?.message;
    grid.push({ effort, status: r.status, reasoningLen: (msg?.reasoning_content ?? '').length, content: msg?.content, error: r.json?.error ? mask(JSON.stringify(r.json.error)).slice(0, 300) : undefined });
  }
  save('03-effort-grid.json', grid);
  results.effortGrid = grid;
  log('\n[3] reasoning_effort grid (len(reasoning_content), status):');
  for (const g of grid) log(`    ${g.effort.padEnd(8)} status=${g.status} reasoningChars=${g.reasoningLen} content=${JSON.stringify(g.content)}${g.error ? ' err=' + g.error : ''}`);

  // alternative thinking toggles
  const alts = [
    ['thinking-disabled', { thinking: { type: 'disabled' } }],
    ['thinking-enabled-low', { thinking: { type: 'enabled', budget_tokens: 1024 } }],
    ['enable_thinking-false', { enable_thinking: false }],
    ['reasoning-null', { reasoning: null }],
    ['reasoning-effort-none-only', { reasoning_effort: 'none' }],
  ];
  const altOut = [];
  for (const [name, extra] of alts) {
    const body = { model: 'SCNet-Max', messages: [{ role: 'user', content: '回复OK' }], max_tokens: 32, ...extra };
    const r = await jfetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const msg = r.json?.choices?.[0]?.message;
    altOut.push({ name, extra, status: r.status, reasoningChars: (msg?.reasoning_content ?? '').length, content: msg?.content, error: r.json?.error ? mask(JSON.stringify(r.json.error)).slice(0, 300) : undefined });
  }
  save('04-thinking-variants.json', altOut);
  log('\n[4] alternative thinking params:');
  for (const a of altOut) log(`    ${a.name.padEnd(26)} status=${a.status} reasoningChars=${a.reasoningChars} content=${JSON.stringify(a.content)}${a.error ? ' err=' + a.error : ''}`);
}

async function stepStream() {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ model: 'SCNet-Max', stream: true, messages: [{ role: 'user', content: '数到三，每个数字一行' }], max_tokens: 256 }),
  });
  const ct = res.headers.get('content-type');
  save('05-stream-status.txt', `status=${res.status} content-type=${ct}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let raw = '';
  let events = 0;
  const t0 = Date.now();
  while (events < 120) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += dec.decode(value, { stream: true });
    events = (raw.match(/\ndata: /g) || []).length;
  }
  reader.cancel().catch(() => {});
  save('05-stream-raw.txt', raw);
  const lines = raw.split('\n').filter((l) => l.startsWith('data:'));
  results.stream = { status: res.status, contentType: ct, firstMs: Date.now() - t0, dataLines: lines.length, sample: lines.slice(0, 6), last: lines.slice(-3) };
  log(`\n[5] stream -> status=${res.status} content-type=${ct} data-lines=${lines.length}`);
  for (const l of lines.slice(0, 6)) log('    ' + mask(l).slice(0, 500));
  if (lines.length) log('    ... last: ' + mask(lines[lines.length - 1]).slice(0, 400));
}

async function stepTools() {
  const tools = [{
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get current weather for a city',
      parameters: { type: 'object', properties: { city: { type: 'string', description: 'city name' } }, required: ['city'] },
    },
  }];
  await chatOnce('06-tools-nonstream.json', {
    model: 'SCNet-Max',
    messages: [{ role: 'user', content: '杭州现在天气怎么样？请调用工具查询。' }],
    tools,
    tool_choice: 'auto',
    max_tokens: 256,
  });

  // tools + stream
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ model: 'SCNet-Max', stream: true, messages: [{ role: 'user', content: '杭州现在天气怎么样？请调用工具查询。' }], tools, tool_choice: 'auto', max_tokens: 256 }),
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let raw = '';
  let lines = 0;
  while (lines < 200) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += dec.decode(value, { stream: true });
    lines = (raw.match(/\ndata: /g) || []).length;
  }
  reader.cancel().catch(() => {});
  save('07-tools-stream-raw.txt', raw);
  const dl = raw.split('\n').filter((l) => l.startsWith('data:')).filter((l) => !l.includes('[DONE]'));
  log(`\n[7] tools+stream -> status=${res.status} data-lines=${dl.length}`);
  for (const l of dl.slice(0, 10)) log('    ' + mask(l).slice(0, 600));
}

async function stepBadKey() {
  const r = await jfetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: 'Bearer invalid-probe-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'SCNet-Max', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }),
  });
  save('08-bad-key.json', r.text);
  results.badKey = { status: r.status, ms: r.ms, body: mask(r.text).slice(0, 800) };
  log(`\n[8] invalid key -> HTTP ${r.status} (${r.ms}ms) ${mask(r.text).slice(0, 400)}`);
}

async function stepConcurrency() {
  const t0 = Date.now();
  const rs = await Promise.allSettled(Array.from({ length: 4 }, (_, i) => jfetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'SCNet-Max', messages: [{ role: 'user', content: `并发测试${i}: 输出数字${i}` }], max_tokens: 24 }),
  })));
  const summary = rs.map((x) => x.status === 'fulfilled'
    ? { http: x.value.status, ms: x.value.ms, content: x.value.json?.choices?.[0]?.message?.content, err: x.value.json?.error ? mask(JSON.stringify(x.value.json.error)).slice(0, 200) : undefined }
    : { rejected: String(x.reason).slice(0, 200) });
  save('09-concurrency-4.json', { elapsedMs: Date.now() - t0, summary });
  results.concurrency = summary;
  log(`\n[9] 4 parallel requests -> ${Date.now() - t0}ms`);
  for (const s of summary) log('    ' + JSON.stringify(s));
}

const only = process.argv.slice(2);
const steps = { models: stepModels, chat: stepChat, effort: stepEffortGrid, stream: stepStream, tools: stepTools, badkey: stepBadKey, conc: stepConcurrency };
for (const [k, fn] of Object.entries(steps)) {
  if (only.length && !only.includes(k)) continue;
  try { await fn(); } catch (e) { log(`[${k}] FAILED:`, e?.message ?? e); }
}
save('99-summary.json', results);
log(`\nraw outputs saved under ${OUT}`);
