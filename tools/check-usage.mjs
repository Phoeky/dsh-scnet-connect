#!/usr/bin/env node
// Token 用量记录的离线回归：累加、持久化、零用量忽略、pi-ai 事件透传。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createUsageRecorder, withUsageRecording } from '../lib/scnet-usage.js';

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
  console.log('1. 累加与持久化');
  const recorder = createUsageRecorder({ file, flushDelayMs: 0 });
  recorder.record({ model: 'SCNet-Max', usage: { input: 100, output: 20, totalTokens: 120, cacheRead: 30, cacheWrite: 5 } });
  recorder.record({ model: 'SCNet-Max', usage: { inputTokens: 50, outputTokens: 10 } });
  recorder.record({ model: 'SCNet-Max', usage: { input: 0, output: 0 } });
  const snapshot = recorder.snapshot();
  check('请求数 2', () => assert.equal(snapshot.requests, 2));
  check('输入 150', () => assert.equal(snapshot.inputTokens, 150));
  check('输出 30', () => assert.equal(snapshot.outputTokens, 30));
  check('总 token 180', () => assert.equal(snapshot.totalTokens, 180));
  check('缓存命中 30', () => assert.equal(snapshot.cacheReadTokens, 30));
  check('缓存写入 5', () => assert.equal(snapshot.cacheWriteTokens, 5));
  check('最近一次模型', () => assert.equal(snapshot.last.model, 'SCNet-Max'));

  check('落盘成功', () => assert.equal(recorder.flush(), true));
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  check('文件累计值', () => assert.equal(raw.inputTokens, 150));
  check('文件无 prompt 字段', () => assert.equal('prompt' in raw, false));

  console.log('\n2. 重新加载');
  const reloaded = createUsageRecorder({ file });
  const again = reloaded.snapshot();
  check('请求数保留', () => assert.equal(again.requests, 2));
  check('输出保留', () => assert.equal(again.outputTokens, 30));

  console.log('\n3. 关闭记录');
  const disabledFile = path.join(dir, 'disabled.json');
  const disabled = createUsageRecorder({ file: disabledFile, enabled: false });
  disabled.record({ model: 'x', usage: { input: 1, output: 1 } });
  check('不累加', () => assert.equal(disabled.snapshot().requests, 0));
  disabled.flush();
  check('不写文件', () => assert.equal(fs.existsSync(disabledFile), false));

  console.log('\n4. withUsageRecording 透传事件并记录一次');
  let recorded = null;
  let seen = 0;
  const api = {
    marker: 'api',
    async *stream() {
      if (this.marker !== 'api') throw new Error('this lost');
      yield { type: 'start' };
      yield { type: 'text_delta', delta: 'hi' };
      yield { type: 'done', message: { usage: { input: 3, output: 4, totalTokens: 7 } } };
    },
    async *streamSimple() {
      yield { type: 'error', error: { usage: { input: 2, output: 0, totalTokens: 2 } } };
    },
  };
  const wrapped = withUsageRecording(api, (info) => {
    recorded = info;
  });
  for await (const event of wrapped.stream({ id: 'SCNet-Max' }, {}, {})) {
    seen++;
    assert.ok(event);
  }
  check('事件数量不变', () => assert.equal(seen, 3));
  check('记录到模型', () => assert.equal(recorded.model, 'SCNet-Max'));
  check('记录到输入', () => assert.equal(recorded.usage.input, 3));
  for await (const _ of wrapped.streamSimple({ id: 'SCNet-Max' }, {}, {})) {
    // drain
  }
  check('error usage 也被记录', () => assert.equal(recorded.usage.input, 2));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\n结论：全部通过' : `\n结论：${failures} 项失败`);
process.exitCode = failures === 0 ? 0 : 1;
