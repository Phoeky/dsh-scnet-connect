#!/usr/bin/env node
// Reproduce SCNet client's model credential acquisition + direct scnet-max chat call.
// Chain (from app.asar dist-electron/main/index.js):
//   1) desktopToken (client config.json accessToken) -> POST /ac/api/auth/loginDesktopClientByToken.action
//      -> Set-Cookie (Token=...; etc)  [client module "fV"/"XH", login flow]
//   2) cookie+Token -> POST /acx/llm/api-key/createActivityApiKey {} -> activity apiKey
//      fallback: API010010 -> /acx/user/users/cluster-user-detail + /acx/llm/api-key/query|detail|create
//   3) Authorization: Bearer <apiKey> -> POST https://api.scnet.cn/api/llm/v1/chat/completions
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const cfg = JSON.parse(fs.readFileSync(path.join(APPDATA, 'scnet-client', 'config.json'), 'utf8'));
const desktopToken = cfg.accessToken;
const BASE = 'https://www.scnet.cn';
const APP_VERSION = '4.1.0';
const redact = (s) => String(s)
  .replace(/(eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{5,})/g, '<JWT>')
  .replace(/("apiKey"\s*:\s*")[^"]+(")/g, '$1<API_KEY>$2')
  .replace(/\b(sk-[A-Za-z0-9_-]{8,})/g, '<API_KEY>');
const baseHeaders = () => ({ accept: 'application/json, text/plain, */*', source: 'Electron', version: APP_VERSION });

function cookieHeaderFromJar(jar) {
  // mimic client: Cookie = [myCookie(no Token), acToken("Token=...")].filter(Boolean).join("; ")
  const parts = [...jar.values()];
  const acToken = parts.find((c) => c.startsWith('Token=')) || '';
  const myCookie = parts.filter((c) => !c.startsWith('Token=')).join('; ');
  return [myCookie, acToken].filter(Boolean).join('; ');
}
function absorbSetCookie(jar, headers) {
  const raw = headers.getSetCookie ? headers.getSetCookie() : [];
  for (const sc of raw) {
    const first = sc.split(';')[0].trim();
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    jar.set(name, first);
  }
  return jar;
}
async function req(method, url, { body, headers = {}, jar } = {}) {
  const h = { ...baseHeaders(), ...headers };
  if (jar) { const c = cookieHeaderFromJar(jar); if (c) h.Cookie = c; }
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, headers: res.headers };
}
const show = (label, r) => {
  const body = typeof r.json === 'string' ? r.json : JSON.stringify(r.json, null, 2);
  console.log(`\n### ${label} -> HTTP ${r.status}\n${redact(body).slice(0, 4000)}`);
  return r;
};
const codeOf = (j) => (j && typeof j === 'object' ? String(j.code ?? j.error?.code ?? '') : '');

async function main() {
  const jar = new Map();
  // 1) token login
  const login = await req('POST', `${BASE}/ac/api/auth/loginDesktopClientByToken.action`,
    { body: { desktopToken, sensors_anon_id: crypto.randomUUID() }, jar });
  absorbSetCookie(jar, login.headers);
  show('loginDesktopClientByToken', login);
  console.log('cookies in jar:', [...jar.keys()].join(', ') || '(none)');
  if (login.status !== 200 || codeOf(login.json) && codeOf(login.json) !== '0') {
    console.log('\n[stop] token login failed; cannot proceed without a valid SCNet session cookie');
    return;
  }

  // 2) activity api key
  const act = await req('POST', `${BASE}/acx/llm/api-key/createActivityApiKey`, { body: {}, jar });
  show('createActivityApiKey', act);
  let apiKey = extractKey(act.json);
  if (!apiKey && codeOf(act.json) === 'API010010') {
    console.log('\n[info] activity key unavailable (API010010) -> fallback: team account + per-member key');
    const account = await resolveAccount(jar);
    if (account) apiKey = await memberKey(jar, account);
  }
  if (!apiKey) { console.log('\n[stop] no api key'); return; }
  console.log(`\napiKey acquired: ${apiKey.slice(0, 4)}***${apiKey.slice(-4)} (len ${apiKey.length})`);
  fs.writeFileSync(path.join(process.cwd(), '.research', 'scnet-apikey.json'),
    JSON.stringify({ acquiredAt: new Date().toISOString(), apiKey }, null, 2));

  // 3) model list via console model endpoint
  const models = await req('GET', `${BASE}/acx/llm/api/console/model`, { jar });
  show('console model list', models);

  // 4) chat completion (non-stream then stream)
  const llmBase = 'https://api.scnet.cn/api/llm/v1/';
  const chatBody = {
    model: 'SCNet-Max',
    messages: [{ role: 'user', content: '只回复两个字：你好' }],
    stream: false,
    max_tokens: 64,
  };
  const chat = await fetch(`${llmBase}chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(chatBody),
    signal: AbortSignal.timeout(120000),
  });
  const chatText = await chat.text();
  console.log(`\n### chat/completions (model=SCNet-Max) -> HTTP ${chat.status}\n${redact(chatText).slice(0, 4000)}`);

  // 5) streaming SSE sample
  const sres = await fetch(`${llmBase}chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ model: 'SCNet-Max', messages: [{ role: 'user', content: '数到三，只输出数字' }], stream: true, max_tokens: 32 }),
    signal: AbortSignal.timeout(120000),
  });
  console.log(`\n### chat/completions stream -> HTTP ${sres.status} content-type=${sres.headers.get('content-type')}`);
  if (sres.ok) {
    const reader = sres.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let n = 0;
    while (n < 8) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        console.log('SSE:', redact(line.trim()).slice(0, 800));
        if (++n >= 8) break;
      }
    }
    reader.cancel().catch(() => {});
  }
}

function extractKey(j) {
  const walk = (v) => {
    if (typeof v === 'string') return '';
    if (!v || typeof v !== 'object') return '';
    for (const k of ['apiKey', 'apikey', 'key', 'secret', 'token']) if (typeof v[k] === 'string' && v[k].trim()) return v[k].trim();
    for (const k of ['data', 'result', 'records']) { const r = walk(v[k]); if (r) return r; }
    return '';
  };
  return walk(j);
}

async function resolveAccount(jar) {
  const r = await req('GET', `${BASE}/acx/user/users/cluster-user-detail`, { jar });
  show('cluster-user-detail', r);
  const list = Array.isArray(r.json) ? r.json : Array.isArray(r.json?.data) ? r.json.data : [];
  const member = list.find((x) => String(x.memberType || '').toLowerCase() === 'member');
  if (!member) { console.log('[stop] no member-type account'); return null; }
  const accountId = String(member.accountId || '');
  const groupId = String(member.groupId || '');
  const createUser = String(member.userId || '');
  const status = String(member.accountDetail?.status || '').toLowerCase();
  console.log(`account: accountId=${accountId} groupId=${groupId} createUser=${createUser} status=${status}`);
  if (!accountId || !groupId || !createUser || status !== 'normal') return null;
  return { accountId, groupId, createUser };
}

async function memberKey(jar, account) {
  const { accountId, groupId, createUser } = account;
  const name = `scnet-client-member-${createUser}`;
  let page = 1;
  const all = [];
  for (; page <= 100; page++) {
    const q = await req('POST', `${BASE}/acx/llm/api-key/query`, { body: { createUser, accountId, groupId, serviceType: 'model', page, size: 100 }, jar });
    if (page === 1) show('api-key/query', q);
    const rows = Array.isArray(q.json) ? q.json : Array.isArray(q.json?.records) ? q.json.records : [];
    all.push(...rows);
    if (rows.length < 100) break;
  }
  const found = all.find((x) => String(x.apiKeyName) === name && String(x.accountId) === accountId && String(x.createUser) === createUser && String(x.keyStatus) === '100' && x.id);
  if (found) {
    const d = await req('GET', `${BASE}/acx/llm/api-key/detail?id=${encodeURIComponent(found.id)}`, { jar });
    show('api-key/detail', d);
    return extractKey(d.json);
  }
  const c = await req('POST', `${BASE}/acx/llm/api-key/create`, {
    body: { createUser, apiKeyName: name, serviceTypes: ['model'], accessibleModelScope: 'ALL', groupId, accountId }, jar,
  });
  show('api-key/create', c);
  return extractKey(c.json);
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
