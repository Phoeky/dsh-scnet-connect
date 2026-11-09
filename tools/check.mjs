#!/usr/bin/env node
/**
 * dsh-scnet-connect 自检脚本（不依赖 DSH 运行时，可单独跑）
 *
 * 用法：
 *   node tools/check.mjs            # 静态检查：模块可加载、凭据可发现、模型元数据
 *   node tools/check.mjs --live     # 额外向上游发一次最小请求（会消耗一次免费额度）
 *
 * 输出不会包含 API Key 明文。
 */

import { DEFAULT_BASE_URL, DEFAULT_MODEL_ID, buildModel, modelLabel } from '../lib/scnet-models.js';
import {
  maskKey,
  readClientModelMeta,
  readPlatformAccessToken,
  resolveApiKey,
} from '../lib/scnet-credential.js';

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

console.log('[1/4] 模型描述符');
const meta = readClientModelMeta(DEFAULT_MODEL_ID);
const model = buildModel({
  modelId: DEFAULT_MODEL_ID,
  modelName: modelLabel(meta, DEFAULT_MODEL_ID),
  baseUrl: DEFAULT_BASE_URL,
  meta,
});
ok(`model=${model.id} name=${model.name}`);
ok(
  `api=${model.api} baseUrl=${model.baseUrl} ctx=${model.contextWindow} max=${model.maxTokens} input=${model.input.join('+')} reasoning=${model.reasoning}`,
);
if (model.contextWindow !== 262144 || model.maxTokens !== 32768) {
  warn('SCNet-Max 的上下文/输出上限与客户端的 262144/32768 特判不一致（配置覆盖过？）');
}

console.log('');
console.log('[2/4] 模型服务凭据');
let apiKey;
try {
  const resolved = resolveApiKey({});
  apiKey = resolved.key;
  ok(`来源=${resolved.source} key=${maskKey(resolved.key)}`);
  if (resolved.file) ok(`文件=${resolved.file}`);
} catch (error) {
  failures += 1;
  fail(error instanceof Error ? error.message : String(error));
}

console.log('');
console.log('[3/4] 平台登录态（诊断用）');
const jwt = readPlatformAccessToken();
if (jwt?.expiresAt) {
  const leftDays = Math.round((jwt.expiresAt - Date.now()) / 86_400_000);
  ok(`accessToken 有效（约剩 ${leftDays} 天）`);
} else {
  warn('未找到平台登录态（不影响模型调用，只影响诊断）');
}

console.log('');
console.log('[4/4] 上游连通性');
if (!live) {
  warn('跳过真实请求（加 --live 才会发）');
} else if (!apiKey) {
  failures += 1;
  fail('没有可用凭据，无法测试上游');
} else {
  try {
    const res = await fetch(`${DEFAULT_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`GET /models -> HTTP ${res.status}`);
    const payload = await res.json();
    const ids = (payload?.data || []).map((item) => item.id);
    ok(`GET /models 成功，共 ${ids.length} 个模型${ids.includes(DEFAULT_MODEL_ID) ? `，包含 ${DEFAULT_MODEL_ID}` : ''}`);
    if (!ids.includes(DEFAULT_MODEL_ID)) warn(`目录里没有 ${DEFAULT_MODEL_ID}，模型可能已下线/改名`);
  } catch (error) {
    failures += 1;
    fail(`上游连通性失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log('');
if (failures > 0) {
  console.log(`自检失败：${failures} 项`);
  process.exitCode = 1;
} else {
  console.log('自检通过。');
}
