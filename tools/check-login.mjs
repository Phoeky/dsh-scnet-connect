#!/usr/bin/env node
// 免客户端登录的离线回归（不访问 www.scnet.cn，用全局 fetch 桩）：
//   1. 发短信/图形验证码网络异常 → 中文错误，不甩英文 500；
//   2. 未注册手机号走注册通道，成功结果保留 via=register（设置页自动注册提示依赖它）；
//   3. 登录提交抛网络异常 → phase=failed，不留在 pending。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createLoginManager } from '../lib/scnet-login.js';

const dirs = [];
function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scnet-login-'));
  dirs.push(dir);
  return dir;
}

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
  });
}

const realFetch = globalThis.fetch;
let mode = 'normal';
let smsCodeReturned = '0';

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (mode === 'throw-captcha' && url.includes('/sso/captcha.action')) {
    throw new TypeError('fetch failed');
  }
  if (mode === 'throw-sms' && url.includes('/sso/sendRegisterMessageCode.action')) {
    throw new TypeError('fetch failed');
  }
  if (mode === 'throw-submit' && (url.includes('/sso/auth/login.action') || url.includes('/sso/registerByMobilephoneNum.action'))) {
    throw new TypeError('fetch failed');
  }

  if (url.includes('/sso/captcha.action')) {
    return json({ code: '0', data: 'data:image/png;base64,AAAA' });
  }
  if (url.includes('/sso/sendRegisterMessageCode.action')) {
    return json({ code: smsCodeReturned });
  }
  if (url.includes('/sso/registerByMobilephoneNum.action') || url.includes('/sso/auth/login.action')) {
    return json({ code: '0', data: '/ac/api/auth/loginSsoRedirect.action?ticket=t1' });
  }
  if (url.includes('/ac/api/auth/loginSsoRedirect.action')) {
    const headers = new Headers();
    headers.append('set-cookie', 'jsessionid=js-test; Path=/');
    headers.append('set-cookie', 'Token=tok-test; Path=/');
    return new Response('', { status: 200, headers });
  }
  if (url.includes('/acx/user/users/current-user-info')) {
    return json({ code: '0', data: { id: 7, userName: 'tester', mobilephoneNum: '138****1234' } });
  }
  if (url.includes('/acx/llm/api-key/createActivityApiKey')) {
    return json({ code: '0', data: { apiKey: 'sk-test-1234567890', baseUrl: 'https://api.scnet.cn/api/llm/v1' } });
  }
  if (url.includes('/acx/user/users/logout')) {
    return json({ code: '0' });
  }
  return json({ code: '0', data: {} });
};

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}: ${actual}${ok ? '' : `  (期望 ${expected})`}`);
}

try {
  console.log('1. 图形验证码网络异常');
  {
    const home = tempHome();
    const login = createLoginManager({ env: { DSH_HOME: home } });
    mode = 'throw-captcha';
    const result = await login.captcha();
    check('ok=false', result.ok, false);
    check('reason=network', result.reason, 'network');
    check('提示是中文', /网络连接异常/.test(result.message), true);
  }

  console.log('\n2. 发短信网络异常');
  {
    const home = tempHome();
    const login = createLoginManager({ env: { DSH_HOME: home } });
    mode = 'throw-sms';
    const result = await login.sendSmsCode('13812345678', 'abcd');
    check('ok=false', result.ok, false);
    check('reason=network', result.reason, 'network');
    check('提示是中文', /网络连接异常/.test(result.message), true);
  }

  console.log('\n3. 未注册号走注册通道，via 保留');
  {
    const home = tempHome();
    const login = createLoginManager({ env: { DSH_HOME: home } });
    mode = 'normal';
    smsCodeReturned = '0'; // 0 = 该号未注册
    const sms = await login.sendSmsCode('13812345678', 'abcd');
    check('发码成功', sms.ok, true);
    check('registered=false', sms.registered, false);
    const result = await login.loginWithSms({ phone: '13812345678', smsCode: '123456' });
    check('登录成功', result.ok, true);
    check('via=register', result.via, 'register');
    check('phase=authorized', result.phase, 'authorized');
    const file = login.sessionFilePath();
    check('会话文件已写', fs.existsSync(file), true);
    const session = JSON.parse(fs.readFileSync(file, 'utf8'));
    check('会话含 sk- key', typeof session.apiKey === 'string' && session.apiKey.startsWith('sk-'), true);
  }

  console.log('\n4. 登录提交网络异常不留在 pending');
  {
    const home = tempHome();
    const login = createLoginManager({ env: { DSH_HOME: home } });
    mode = 'throw-submit';
    smsCodeReturned = '1004'; // 已注册，走 login 接口
    await login.sendSmsCode('13812345678', 'abcd');
    const result = await login.loginWithSms({ phone: '13812345678', smsCode: '123456' });
    check('ok=false', result.ok, false);
    check('phase=failed', result.phase, 'failed');
    check('提示是中文', /网络连接异常/.test(result.error), true);
    check('pending 已清空', result.pending, undefined);
  }
} finally {
  globalThis.fetch = realFetch;
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\n结论：全部通过' : `\n结论：${failures} 项失败`);
process.exitCode = failures === 0 ? 0 : 1;
