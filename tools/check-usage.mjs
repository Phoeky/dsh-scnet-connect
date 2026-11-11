#!/usr/bin/env node
// Token 用量记录的离线回归：
//   - harness `TokenUsage` 口径（inputTokens 是未命中部分，缓存命中单列）
//   - 输入总量 = 未命中 + 命中 + 写入；缓存命中率 = 命中 / 输入总量
//   - 旧版文件迁移、关闭记录、零用量忽略、多次 usage 只取最终值
//   - profile 文件名与 1.3.0 无后缀旧文件的迁移（1.3.1 修复的重启归零）
//   - 流在 finally 里计数：中断/报错也记录已产生的用量

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createUsageRecorder } from '../lib/scnet-usage.js';
import { migrateLegacyUsageFile, resolveProfileName, usageFilePath } from '../lib/scnet-usage-path.js';

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

  // ---------------------------------------------------------------
  // 5. profile 文件名（1.3.1 修复：重启后用量归零）
  // ---------------------------------------------------------------
  console.log('\n5. profile 文件名');

  // 5.0 名的解析优先级：profileContext 权威，环境变量兜底
  check('profileContext 优先于环境变量', () =>
    assert.equal(resolveProfileName({ name: 'desktop' }, { DSH_PROFILE: 'tui' }), 'desktop'));
  check('无 profileContext 时用环境变量', () =>
    assert.equal(resolveProfileName(undefined, { DSH_PROFILE: 'tui' }), 'tui'));
  check('两者都没有 → 空串（无 profile 启动）', () =>
    assert.equal(resolveProfileName(undefined, {}), ''));
  check('profileContext 名字为空串时退回环境变量', () =>
    assert.equal(resolveProfileName({ name: '  ' }, { DSH_PROFILE: 'tui' }), 'tui'));
  check('非法字符被清理', () => assert.equal(resolveProfileName({ name: 'a/b:c' }, {}), 'a_b_c'));
  check('1.3.0 的 bug 复现：只有环境变量时曾恒为空', () => {
    // 旧实现只读 process.env.DSH_PROFILE；插件进程内没有它。
    // 新实现拿到 profileContext 后不再依赖环境变量。
    assert.equal(resolveProfileName({ name: 'desktop' }, {}), 'desktop');
  });

  check('无 profile 时不带后缀', () =>
    assert.equal(usageFilePath(dir, ''), path.join(dir, 'scnet-connect-usage.json')));
  check('有 profile 时带后缀', () =>
    assert.equal(usageFilePath(dir, 'desktop'), path.join(dir, 'scnet-connect-usage.desktop.json')));

  // 5a. 旧的无后缀文件应被迁移到带后缀
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scnet-home-a-'));
    const legacy = path.join(home, 'scnet-connect-usage.json');
    fs.writeFileSync(legacy, JSON.stringify({ version: 2, requests: 42, promptTokens: 1234 }));
    const logs = [];
    const resolved = usageFilePath(home, 'desktop', { info: (m) => logs.push(m) });
    check('迁移后路径带后缀', () => assert.equal(resolved, path.join(home, 'scnet-connect-usage.desktop.json')));
    check('旧文件已不存在（被改名）', () => assert.equal(fs.existsSync(legacy), false));
    check('新文件存在且有数据', () =>
      assert.equal(JSON.parse(fs.readFileSync(resolved, 'utf8')).requests, 42));
    check('迁移打了日志', () => assert.equal(logs.length, 1));
    // 迁移后 recorder 能读回来——这正是「重启不归零」的直接证据
    check('迁移后 recorder 读回 42 次', () =>
      assert.equal(createUsageRecorder({ file: resolved }).snapshot().requests, 42));
    fs.rmSync(home, { recursive: true, force: true });
  }

  // 5b. 目标文件已存在时不覆盖
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scnet-home-b-'));
    const target = path.join(home, 'scnet-connect-usage.desktop.json');
    fs.writeFileSync(path.join(home, 'scnet-connect-usage.json'), JSON.stringify({ requests: 1 }));
    fs.writeFileSync(target, JSON.stringify({ requests: 99 }));
    const resolved = usageFilePath(home, 'desktop', {});
    check('新文件优先，不被旧文件覆盖', () =>
      assert.equal(JSON.parse(fs.readFileSync(resolved, 'utf8')).requests, 99));
    check('旧文件原样留在原地', () =>
      assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'scnet-connect-usage.json'), 'utf8')).requests, 1));
    fs.rmSync(home, { recursive: true, force: true });
  }

  // 5c. 旧文件属于别的 profile 时不迁移
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scnet-home-c-'));
    const legacy = path.join(home, 'scnet-connect-usage.json');
    fs.writeFileSync(legacy, JSON.stringify({ requests: 7, profile: 'tui' }));
    const resolved = usageFilePath(home, 'desktop', {});
    check('别的 profile 的旧文件不迁移', () => assert.equal(resolved, legacy));
    check('该文件仍在', () => assert.equal(fs.existsSync(legacy), true));
    fs.rmSync(home, { recursive: true, force: true });
  }

  // 5d. 没有旧文件时直接用新名字
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scnet-home-d-'));
    const resolved = usageFilePath(home, 'desktop', {});
    check('无旧文件用新名字', () => assert.equal(resolved, path.join(home, 'scnet-connect-usage.desktop.json')));
    check('没有凭空创建文件', () => assert.equal(fs.existsSync(resolved), false));
    fs.rmSync(home, { recursive: true, force: true });
  }

  // 5e. 旧文件损坏时也要能迁移（不因解析失败而丢数据）
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scnet-home-e-'));
    const legacy = path.join(home, 'scnet-connect-usage.json');
    fs.writeFileSync(legacy, '{ 这不是 JSON');
    const resolved = usageFilePath(home, 'desktop', {});
    check('损坏的旧文件也迁移', () =>
      assert.equal(resolved, path.join(home, 'scnet-connect-usage.desktop.json')));
    check('损坏内容保留（可人工抢救）', () => assert.equal(fs.readFileSync(resolved, 'utf8'), '{ 这不是 JSON'));
    fs.rmSync(home, { recursive: true, force: true });
  }

  // 5f. 直接调用 migrateLegacyUsageFile：同一路径时不动作
  {
    const same = path.join(dir, 'scnet-connect-usage.json');
    check('目标与旧文件同名时原样返回', () => assert.equal(migrateLegacyUsageFile(dir, same, 'x', {}), same));
  }

  // ---------------------------------------------------------------
  // 6. 流中断也计数（recordUsage 用 finally）
  // ---------------------------------------------------------------
  console.log('\n6. 流中断仍记录用量');

  // 复刻插件里的包装逻辑（index.js 中的 llm/stream 钩子）
  function wrapStream(iterable, recorder, model) {
    return (async function* recordUsage() {
      let last;
      try {
        for await (const chunk of iterable) {
          if (chunk && chunk.type === 'usage' && chunk.usage) last = chunk.usage;
          yield chunk;
        }
      } finally {
        if (last) recorder.record({ model, usage: last });
      }
    })();
  }

  const usageChunk = {
    type: 'usage',
    usage: { inputTokens: 300, outputTokens: 40, cacheReadTokens: 700 },
  };

  // 6a. 正常结束
  {
    const r = createUsageRecorder({ file: path.join(dir, 'ok.json'), flushDelayMs: 0 });
    async function* normal() {
      yield { type: 'text-delta', text: 'hi' };
      yield usageChunk;
    }
    for await (const _ of wrapStream(normal(), r, 'SCNet-Max')) void _;
    check('正常结束计数 1 次', () => assert.equal(r.snapshot().requests, 1));
    check('正常结束输入 1000', () => assert.equal(r.snapshot().promptTokens, 1000));
  }

  // 6b. 消费方中途抛错（模拟上游中断/用户停止）
  {
    const r = createUsageRecorder({ file: path.join(dir, 'abort.json'), flushDelayMs: 0 });
    async function* interrupted() {
      yield usageChunk;
      throw new Error('The response stream was interrupted.');
    }
    let threw = false;
    try {
      for await (const _ of wrapStream(interrupted(), r, 'SCNet-Max')) void _;
    } catch {
      threw = true;
    }
    check('异常确实抛出（不影响原语义）', () => assert.equal(threw, true));
    check('中断后仍计数 1 次', () => assert.equal(r.snapshot().requests, 1));
    check('中断后仍记输出 40', () => assert.equal(r.snapshot().outputTokens, 40));
  }

  // 6c. 消费方提前 return（for await 里 break）
  {
    const r = createUsageRecorder({ file: path.join(dir, 'break.json'), flushDelayMs: 0 });
    async function* many() {
      yield usageChunk;
      yield { type: 'text-delta', text: 'a' };
      yield { type: 'text-delta', text: 'b' };
    }
    for await (const chunk of wrapStream(many(), r, 'SCNet-Max')) {
      if (chunk.type === 'text-delta') break;
    }
    check('提前 break 后仍计数 1 次', () => assert.equal(r.snapshot().requests, 1));
  }

  // 6d. 全程没有 usage chunk 时不记账
  {
    const r = createUsageRecorder({ file: path.join(dir, 'nousage.json'), flushDelayMs: 0 });
    async function* none() {
      yield { type: 'text-delta', text: 'x' };
      throw new Error('boom');
    }
    try {
      for await (const _ of wrapStream(none(), r, 'SCNet-Max')) void _;
    } catch {
      // 预期
    }
    check('无 usage 时不产生记录', () => assert.equal(r.snapshot().requests, 0));
  }

  // ---------------------------------------------------------------
  // 7. 落盘时机：dirty 才会在 exit 补写
  // ---------------------------------------------------------------
  console.log('\n7. dispose 落盘');

  {
    const exitFile = path.join(dir, 'exit.json');
    const r = createUsageRecorder({ file: exitFile, flushDelayMs: 60_000 });
    r.record({ model: 'SCNet-Max', usage: { inputTokens: 10, outputTokens: 5 } });
    check('防抖窗口内尚未落盘', () => assert.equal(fs.existsSync(exitFile), false));
    r.dispose();
    check('dispose 后已落盘', () => assert.equal(fs.existsSync(exitFile), true));
    check('落盘内容正确', () =>
      assert.equal(JSON.parse(fs.readFileSync(exitFile, 'utf8')).requests, 1));
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\n结论：全部通过' : `\n结论：${failures} 项失败`);
process.exitCode = failures === 0 ? 0 : 1;
