#!/usr/bin/env node
// Probe SCNet client credential chain, replicating the compiled client's request shape.
// Step 1: POST /acx/llm/api-key/createActivityApiKey with Token: <accessToken> (JWT from config.json)
// Step 2 (fallback, providerCode API010010): team-account lookup + api key query/create
// Prints status + JSON (token values redacted).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const CONFIG = path.join(APPDATA, 'scnet-client', 'config.json');
const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const token = cfg.accessToken;
const base = 'https://www.scnet.cn';
const appVersion = '4.1.0';

const redact = (s) => String(s).replace(/(eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{5,})/g, '<JWT>').replace(/(sk-[A-Za-z0-9]{8,})/g, '<KEY>');

async function call(method, url, body) {
  const headers = {
    'Content-Type': body ? 'application/json' : undefined,
    source: 'Electron',
    version: appVersion,
    Token: token,
    accept: 'application/json, text/plain, */*',
  };
  for (const k of Object.keys(headers)) if (headers[k] === undefined) delete headers[k];
  const res = await fetch(base + url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

const show = (label, r) => {
  const body = typeof r.json === 'string' ? r.json : JSON.stringify(r.json, null, 2);
  console.log(`\n### ${label} -> HTTP ${r.status}\n${redact(body).slice(0, 3000)}`);
  return r;
};

const main = async () => {
  console.log(`config=${CONFIG}\naccessToken=${token.slice(0, 20)}... (${token.length} chars)`);
  // sanity: decode JWT payload exp
  try {
    const p = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    console.log('JWT payload:', JSON.stringify({ sub: p.sub, exp: p.exp, iat: p.iat, exp_iso: p.exp ? new Date(p.exp * 1000).toISOString() : undefined }));
  } catch {}

  const activity = show('createActivityApiKey', await call('POST', '/acx/llm/api-key/createActivityApiKey', {}));
  const code = activity.json?.code ?? activity.json?.error?.code;
  if (code && String(code) !== '0') {
    console.log(`\nproviderCode=${code} msg=${activity.json?.msg ?? activity.json?.message ?? ''}`);
  }
};

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
