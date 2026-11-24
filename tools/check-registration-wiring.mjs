#!/usr/bin/env node
// 源码级契约检查：issue #1 的根因是「注册失败就提前 return」，导致设置页路由
// 根本没挂上、浏览器只拿到 404。行为单测覆盖不到 `apply()`（它依赖 DSH 运行时），
// 这里用最小代价盯住三条不变量，防止有人再把 return 加回去：
//
//   1. 注册 provider 的 catch 块里不能有裸 return；
//   2. 设置页路由（ctx.inject(['webServer'])）必须在注册块之后、无条件执行；
//   3. 状态读取不能再硬编码 registered=true。

import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');

const registerStart = source.indexOf('// ---- 注册 provider');
const statusStart = source.indexOf('// ---- 设置页数据面');
assert.ok(registerStart > 0, '找不到「注册 provider」段落');
assert.ok(statusStart > registerStart, '设置页数据面必须在注册 provider 之后');

const registerBlock = source.slice(registerStart, statusStart);
const statusBlock = source.slice(statusStart);

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

console.log('1. 注册失败不再中断启动');
check('注册块包含 catch', () => assert.match(registerBlock, /\} catch \(error\) \{/));
check('注册块没有裸 return（提前中断）', () => assert.doesNotMatch(registerBlock, /^\s*return;$/m));
check('catch 里仍写诊断快照', () => assert.match(registerBlock, /writeStatus\(await buildStatus\(\)\)/));

console.log('\n2. 设置页路由无条件注册');
check('ctx.inject 在注册块之后', () => assert.match(statusBlock, /ctx\.inject\?\.\(\['webServer'\]/));
check('路由注册不依赖 registration 变量', () => assert.doesNotMatch(statusBlock, /if \(registration\)/));

console.log('\n3. 状态按真实注册结果输出');
check('不再硬编码 buildStatus(true)', () => assert.doesNotMatch(source, /buildStatus\(true\)/));
check('/status 使用默认注册状态', () => assert.match(source, /\/status',[\s\S]{0,300}buildStatus\(\)/));
check('状态包含 error 字段', () => assert.match(source, /error: registrationError \?\? undefined/));
check('状态包含 conflict 字段', () => assert.match(source, /conflict: registrationConflict \?\? undefined/));

console.log(failures === 0 ? '\n结论：全部通过' : `\n结论：${failures} 项失败`);
process.exitCode = failures === 0 ? 0 : 1;
