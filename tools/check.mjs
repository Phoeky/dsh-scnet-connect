#!/usr/bin/env node
/**
 * dsh-scnet-connect 自检脚本（不依赖 DSH 运行时，可单独跑）
 *
 * 用法：
 *   node tools/check.mjs            # 静态检查：凭据来源、模型目录、账号、登录态
 *   node tools/check.mjs --live     # 额外向上游发一次 GET /models（不消耗 token）
 *
 * 输出不会包含 API Key / Cookie 明文。
 */

import fs from 'node:fs';

import { DEFAULT_BASE_URL, buildModel, modelLabel } from '../lib/scnet-models.js';
import {
  maskKey,
  readClientAccount,
  readClientCatalog,
  resolveApiKey,
} from '../lib/scnet-credential.js';
import { fetchGatewayModels, pickFreeModels } from '../lib/scnet-catalog.js';
import { sessionFilePath } from '../lib/scnet-platform.js';

const live = process.argv.includes('--live');

function ok(message) {
  console.log(`  ✓ ${message}`);
}
function warn(message) {
  console.log(`  ! ${message}`);
}
function fail(message) {
  console.log(`  ✗ ${message}`);
}

let failures = 0;

console.log('dsh-scnet-connect 自检');
console.log('');

// ---- [1/5] 凭据来源 --------------------------------------------------------
console.log('[1/5] 凭据来源');
let apiKey;
let source;
try {
  const resolved = resolveApiKey({});
  apiKey = resolved.key;
  source = resolved.source;
  ok(`生效来源=${resolved.source} key=${maskKey(resolved.key)}`);
  if (resolved.file) ok(`文件=${resolved.file}`);
} catch (error) {
  // 没有客户端凭据不等于自检失败：免客户端登录模式下这是正常状态。
  warn(`客户端凭据不可用：${error instanceof Error ? error.message : String(error)}`);
}

// 免客户端登录的会话文件（只读状态，不验证、不联网）。
const sessionPath = sessionFilePath({ DSH_HOME: process.env.DSH_HOME });
if (fs.existsSync(sessionPath)) {
  try {
    const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    const keyed = typeof session.apiKey === 'string' && session.apiKey.length > 0;
    const leftDays = session.expiresAt
      ? Math.round((Date.parse(session.expiresAt) - Date.now()) / 86_400_000)
      : undefined;
    ok(
      `免客户端会话=${sessionPath}（来源 ${session.source ?? '?'}${session.account?.userName ? `，账号 ${session.account.userName}` : ''}）`,
    );
    ok(`会话里的 key=${keyed ? maskKey(session.apiKey) : '未缓存（下次请求会自动换）'}`);
    if (leftDays !== undefined) {
      ok(leftDays >= 0 ? `缓存 key 约剩 ${leftDays} 天（过期会自动重换）` : '缓存 key 已过期（下次请求会自动重换）');
    }
  } catch (error) {
    warn(`免客户端会话文件无法解析：${error instanceof Error ? error.message : String(error)}`);
  }
} else {
  warn(`没有免客户端会话（${sessionPath}）；用客户端凭据时这是正常的`);
}
if (!apiKey) {
  warn('当前没有任何本地 key：需要客户端凭据，或在设置页用「免客户端登录」登录一次');
}

// ---- [2/5] 客户端模型目录 --------------------------------------------------
console.log('');
console.log('[2/5] 客户端模型目录');
const catalog = readClientCatalog({});
const free = pickFreeModels(catalog);
if (catalog) {
  ok(`目录=${catalog.path}`);
  ok(`共 ${catalog.models.length} 个模型，其中免费 ${free.length} 个`);
  if (catalog.modifiedAt) ok(`目录更新于 ${new Date(catalog.modifiedAt).toLocaleString()}`);
  if (free.length > 0) ok(`免费模型：${free.map((m) => m.id).join('、')}`);
  else warn('目录里没有 priceLabel=free 的模型（插件会退回内置 SCNet-Max）');
} else {
  warn('未找到客户端模型目录（~/.sclaw/agent/models.json）；插件会退回内置 SCNet-Max');
}

// ---- [3/5] 模型描述符 ------------------------------------------------------
console.log('');
console.log('[3/5] 模型描述符');
const models = free.length > 0 ? free : [{ id: 'SCNet-Max', priceLabel: 'free' }];
for (const meta of models) {
  const model = buildModel({
    modelId: meta.id,
    modelName: modelLabel(meta, meta.id),
    baseUrl: DEFAULT_BASE_URL,
    meta,
  });
  ok(
    `${model.id} → 名称「${model.name}」ctx=${model.contextWindow} max=${model.maxTokens} input=${model.input.join('+')} reasoning=${model.reasoning}`,
  );
}

// ---- [4/5] 账号 ------------------------------------------------------------
console.log('');
console.log('[4/5] SCNet 账号');
const account = readClientAccount();
if (account?.userName || account?.userId) {
  ok(
    `客户端账号=${account.userName ?? '-'}${account.userId ? `（ID ${account.userId}）` : ''}${account.mobile ? ` 手机=${account.mobile}` : ''}`,
  );
  if (account.tokenExpiresAt) {
    const leftDays = Math.round((Date.parse(account.tokenExpiresAt) - Date.now()) / 86_400_000);
    ok(`平台登录态约剩 ${leftDays} 天`);
  }
} else {
  warn('未找到客户端账号信息（%APPDATA%\\scnet-client\\config.json）');
}

// ---- [5/5] 上游连通性 ------------------------------------------------------
console.log('');
console.log('[5/5] 上游连通性');
if (!live) {
  warn('跳过真实请求（加 --live 才会发）');
} else if (!apiKey) {
  failures += 1;
  fail('没有可用凭据，无法测试上游');
} else {
  const result = await fetchGatewayModels({ baseUrl: DEFAULT_BASE_URL, apiKey });
  if (result.ok) {
    ok(`GET /models 成功，共 ${result.ids.length} 个模型`);
    const liveIds = new Set(result.ids.map((id) => id.toLowerCase()));
    const missing = models.filter((m) => !liveIds.has(m.id.toLowerCase())).map((m) => m.id);
    if (missing.length > 0) warn(`以下本地免费模型不在网关列表里：${missing.join('、')}`);
  } else {
    failures += 1;
    fail(`上游连通性失败：${result.error}`);
  }
}

console.log('');
if (failures > 0) {
  console.log(`自检失败：${failures} 项`);
  process.exitCode = 1;
} else {
  console.log(`自检通过（凭据来源：${source ?? '无'}）。`);
}
