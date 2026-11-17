import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createModelCatalog } from '../lib/scnet-catalog.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scnet-catalog-'));
const modelsPath = path.join(dir, 'models.json');
const free = { id: 'SCNet-Max', priceLabel: 'free' };
const paid = { id: 'paid-model', priceLabel: 'none' };
function save(models) {
  fs.writeFileSync(modelsPath, JSON.stringify({ providers: { scnet: { models } } }));
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function ids(catalog) {
  return catalog.models().map((model) => model.id);
}

try {
  // 刷新等待凭据时切回免费模式，旧快照不能把付费模型带回来。
  save([free, paid]);
  const key = deferred();
  const catalog = createModelCatalog({ modelsPath, freeOnly: false, resolveApiKey: () => key.promise });
  const refreshing = catalog.refresh();
  catalog.setFreeOnly(true);
  key.resolve('');
  await refreshing;
  assert.deepEqual(ids(catalog), [free.id]);
  console.log('✓ 刷新期间切换免费开关不会被旧结果覆盖');

  // 两次刷新乱序返回时，只保留后发起的刷新结果。
  save([free, paid]);
  const olderKey = deferred();
  let calls = 0;
  const concurrent = createModelCatalog({ modelsPath, freeOnly: false, resolveApiKey: () => ++calls === 1 ? olderKey.promise : '' });
  const older = concurrent.refresh();
  save([free]);
  await concurrent.refresh();
  olderKey.resolve('');
  await older;
  assert.deepEqual(ids(concurrent), [free.id]);
  console.log('✓ 并发刷新乱序完成不会回滚目录');

  // 网关校验期间本地目录有更新，不能给旧内容记录新的 mtime。
  save([free, paid]);
  const waitingKey = deferred();
  const changing = createModelCatalog({ modelsPath, freeOnly: false, resolveApiKey: () => waitingKey.promise });
  const pending = changing.refresh();
  save([free]);
  const nextTime = new Date(Date.now() + 2000);
  fs.utimesSync(modelsPath, nextTime, nextTime);
  waitingKey.resolve('');
  await pending;
  assert.deepEqual(ids(changing), [free.id]);
  console.log('✓ 刷新期间目录变化不会被错误缓存');

  // 刷新期间同步读状态不应取消有效的网关过滤结果。
  save([free, paid]);
  const originalFetch = globalThis.fetch;
  const gateway = deferred();
  globalThis.fetch = () => gateway.promise;
  try {
    const verified = createModelCatalog({ modelsPath, freeOnly: false, resolveApiKey: () => 'test-key' });
    const checking = verified.refresh();
    assert.deepEqual(ids(verified), [free.id, paid.id]);
    gateway.resolve(new Response(JSON.stringify({ data: [{ id: free.id }] }), { status: 200 }));
    await checking;
    assert.deepEqual(ids(verified), [free.id]);
    assert.equal(verified.snapshot().gateway.ok, true);
    console.log('✓ 同步读状态不会丢弃有效的网关校验结果');
  } finally {
    globalThis.fetch = originalFetch;
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
