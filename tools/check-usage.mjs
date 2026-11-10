#!/usr/bin/env node
// Token 用量记录的离线回归：
//   - harness `TokenUsage` 口径（inputTokens 是未命中部分，缓存命中单列）
//   - 输入总量 = 未命中 + 命中 + 写入；缓存命中率 = 命中 / 输入总量
//   - 旧版文件迁移、关闭记录、零用量忽略、多次 usage 只取最终值

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createUsageRecorder } from '../lib/scnet-usage.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scnet-usage-'));
const file = path.join(dir, 'usage.json');
let failures = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failures++;
    console.log(`  ✗ ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

try {
  console.log('1. harness TokenUsage 口径');
  const recorder = createUsageRecorder({ file, flushDelayMs: 0 });
  // 一次调用：prompt 1000，其中缓存命中 800；输出 50。
  recorder.record({
    model: 'SCNet-Max',
    usage: { inputTokens: 200, outputTokens: 50, cacheReadTokens: 800, cacheWriteTokens: 0, totalTokens: 1050 },
  });
  let snap = recorder.snapshot();
  check('输入总量含缓存 1000', () => assert.equal(snap.promptTokens, 1000));
  check('未命中部分 200', () => assert.equal(snap.uncachedInputTokens, 200));
  check('输出 50', () => assert.equal(snap.outputTokens, 50));
  check('缓存命中率 0.8', () => assert.equal(snap.cacheHitRate, 0.8));
  check('旧字段 inputTokens 也是输入总量', () => assert.equal(snap.inputTokens, 1000));
  check('最近一次命中率 0.8', () => assert.equal(snap.last.cacheHitRate, 0.8));

  recorder.record({ model: 'SCNet-Max', usage: { inputTokens: 100, outputTokens: 10 } });
  snap = recorder.snapshot();
  check('两次累计输入 1100', () => assert.equal(snap.promptTokens, 1100));
  check('两次累计命中率 800/1100', () => assert.ok(Math.abs(snap.cacheHitRate - 800 / 1100) < 1e-9));

  console.log('\n2. 零用量与关闭记录');
  const before = snap.requests;
  recorder.record({ model: 'SCNet-Max', usage: { inputTokens: 0, outputTokens: 0 } });
  check('零用量不计数', () => assert.equal(recorder.snapshot().requests, before));

  const disabled = createUsageRecorder({ file: path.join(dir, 'off.json'), enabled: false });
  disabled.record({ model: 'x', usage: { inputTokens: 5, outputTokens: 5 } });
  check('关闭后不累加', () => assert.equal(disabled.snapshot().requests, 0));

  console.log('\n3. 落盘与重载');
  check('落盘成功', () => assert.equal(recorder.flush(), true));
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  check('文件 version=2', () => assert.equal(raw.version, 2));
  check('文件 promptTokens', () => assert.equal(raw.promptTokens, 1100));
  const reloaded = createUsageRecorder({ file });
  check('重载后命中率一致', () => assert.ok(Math.abs(reloaded.snapshot().cacheHitRate - 800 / 1100) < 1e-9));

  console.log('\n4. 旧版文件迁移（inputTokens 是未命中部分）');
  const legacyFile = path.join(dir, 'legacy.json');
  fs.writeFileSync(
    legacyFile,
    JSON.stringify({
      version: 1,
      since: '2026-11-10T00:00:00.000Z',
      updatedAt: '2026-11-10T01:00:00.000Z',
      requests: 10,
      inputTokens: 23723,
      outputTokens: 3614,
      totalTokens: 1769161,
      cacheReadTokens: 1741824,
      cacheWriteTokens: 0,
      last: { at: '2026-11-10T01:00:00.000Z', model: 'SCNet-Max', inputTokens: 854, outputTokens: 389, cacheReadTokens: 13824 },
    }),
  );
  const migrated = createUsageRecorder({ file: legacyFile }).snapshot();
  check('迁移后输入总量 1765547', () => assert.equal(migrated.promptTokens, 23723 + 1741824));
  check('迁移后请求数保留', () => assert.equal(migrated.requests, 10));
  check('迁移后命中率≈98.7%', () => assert.ok(Math.abs(migrated.cacheHitRate - 1741824 / (23723 + 1741824)) < 1e-9));
  check('最近一次也迁移', () => assert.equal(migrated.last.promptTokens, 854 + 13824));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\n结论：全部通过' : `\n结论：${failures} 项失败`);
process.exitCode = failures === 0 ? 0 : 1;
