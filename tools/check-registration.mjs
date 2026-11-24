#!/usr/bin/env node
// provider 注册失败诊断的离线回归：
//   1. 名字冲突要识别出来，并给出 provider / 修复步骤 / 原始错误；
//   2. 措辞变体（大小写、already exists）同样命中；
//   3. 非冲突异常不臆造修复步骤，返回 undefined；
//   4. 空值/非字符串输入不抛异常。

import assert from 'node:assert/strict';

import { describeRegistrationFailure, isProviderNameConflict } from '../lib/scnet-registration.js';

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

console.log('1. 标准冲突文案');
const real =
  'an adapter for provider "scnet" is already registered';
check('识别为冲突', () => assert.equal(isProviderNameConflict(real), true));
const diagnosis = describeRegistrationFailure(real, 'scnet');
check('返回诊断对象', () => assert.equal(typeof diagnosis, 'object'));
check('kind', () => assert.equal(diagnosis.kind, 'provider-name-conflict'));
check('provider 来自参数', () => assert.equal(diagnosis.provider, 'scnet'));
check('hint 指向被占用的路由名', () => assert.match(diagnosis.hint, /"scnet"/));
check('至少三步修复建议', () => assert.ok(diagnosis.steps.length >= 3));
check('建议里给出改名示例', () => assert.match(diagnosis.steps.join(' '), /scnet-manual/));
check('保留原始错误', () => assert.equal(diagnosis.error, real));

console.log('\n2. 措辞变体');
for (const message of [
  'An adapter for provider "scnet" has already been registered',
  'provider route scnet already exists',
  'duplicate provider id: scnet',
]) {
  check(`命中：${message}`, () => assert.equal(isProviderNameConflict(message), true));
}

console.log('\n3. 非冲突异常');
const other = 'Cannot read properties of undefined (reading \'models\')';
check('不识别为冲突', () => assert.equal(isProviderNameConflict(other), false));
check('返回 undefined', () => assert.equal(describeRegistrationFailure(other, 'scnet'), undefined));

console.log('\n4. 边界输入');
check('空串不抛', () => assert.equal(isProviderNameConflict(''), false));
check('undefined 不抛', () => assert.equal(isProviderNameConflict(undefined), false));
check('数字不抛', () => assert.equal(isProviderNameConflict(42), false));
check('空 providerId 回退到 scnet', () =>
  assert.equal(describeRegistrationFailure(real, '').provider, 'scnet'),
);

console.log(failures === 0 ? '\n结论：全部通过' : `\n结论：${failures} 项失败`);
process.exitCode = failures === 0 ? 0 : 1;
