#!/usr/bin/env node
/**
 * 工作台前端请求封装的行为测试（不需要浏览器）
 *
 *   node scripts/test-webapp-frontend.mjs
 *
 * 为什么需要它：`src/*-template.html` 里的 `<script>` 只在真实浏览器执行，
 * 服务端 HTTP 测试（test-webapp-http / test-api-import）永远碰不到它。
 * 1.1.2 就是这样漏掉一个 TypeError：删掉 `headers: { 'x-user-id': ... }`
 * 的初始化，却留下 `opts.headers['Content-Type'] = ...`，结果工作台所有
 * 带 body 的按钮全崩，而 31 项服务端测试照样全绿。
 *
 * 做法：从模板里抠出请求函数源码，在 vm 里用假的 fetch 执行，
 * 断言「不该抛的别抛、该带的头带上、错误信息要透传」。
 *
 * 退出码：0 全过；1 有失败项。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let pass = 0;
const failures = [];
const ok = (name, cond, extra) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`);
  }
};

/** 用大括号配对从源码里抠出一个具名函数（不依赖缩进，也不怕中间有注释） */
function extractFn(src, name) {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const m = re.exec(src);
  if (!m) return null;
  const braceStart = src.indexOf('{', m.index + m[0].length - 1);
  if (braceStart < 0) return null;
  let depth = 0;
  for (let p = braceStart; p < src.length; p++) {
    const ch = src[p];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(m.index, p + 1);
    }
  }
  return null;
}

/** 抓出模板里所有 <script> 块（跳过 src= 引用的外部脚本） */
function scriptBlocks(html) {
  const out = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

/** 在 vm 里执行一段函数源码，返回可调用的函数；fetch 被替换成记录器 */
async function loadFn(fnSrc, extraGlobals = {}) {
  const calls = [];
  const ctx = vm.createContext({
    console,
    BASE: '',
    location: { href: '' },
    document: { getElementById: () => ({ textContent: '', classList: { add() {}, remove() {} } }) },
    URLSearchParams,
    setTimeout,
    fetch: async (url, opts = {}) => {
      calls.push({ url, opts });
      const next = ctx.__nextResponse || { ok: true, status: 200, body: { ok: true } };
      return {
        ok: next.ok,
        status: next.status,
        json: async () => next.body,
        text: async () => JSON.stringify(next.body),
      };
    },
    __nextResponse: null,
    ...extraGlobals,
  });
  const fn = vm.runInContext(`(${fnSrc})`, ctx);
  return { fn, calls, ctx };
}

console.log('=== 工作台前端请求封装 ===');

// ---------------- workbench: api()
{
  const html = fs.readFileSync(path.join(ROOT, 'src/workbench-template.html'), 'utf8');
  const fnSrc = scriptBlocks(html).map((s) => extractFn(s, 'api')).find(Boolean);
  ok('能定位 workbench 的 api() 函数', !!fnSrc);
  if (fnSrc) {
    const { fn, calls, ctx } = await loadFn(fnSrc);

    // 1. GET 不带 body —— 不该抛
    let threw = null;
    try {
      await fn('GET', '/api/summary');
    } catch (e) {
      threw = e;
    }
    ok('GET 不抛错', !threw, threw ? threw.message : '');
    ok('GET 确实发出请求', calls.length === 1 && calls[0].opts.method === 'GET');
    ok('GET 不带 body', calls.length === 1 && calls[0].opts.body === undefined);

    // 2. POST 带 body —— 1.1.2 的崩溃点就在这里
    calls.length = 0;
    threw = null;
    try {
      await fn('POST', '/api/transactions', { amount: 88 });
    } catch (e) {
      threw = e;
    }
    ok(
      'POST 带 body 不抛错（1.1.2 曾在此 TypeError）',
      !threw,
      threw ? `${threw.name}: ${threw.message}` : ''
    );
    const sent = calls[0] || { opts: {} };
    ok('POST 带上 Content-Type: application/json', (sent.opts.headers || {})['Content-Type'] === 'application/json');
    ok('POST body 被 JSON 序列化', sent.opts.body === JSON.stringify({ amount: 88 }));

    // 3. 服务端返回 ok:false 时要把 error 文案透传
    ctx.__nextResponse = { ok: true, status: 200, body: { ok: false, error: '账户下还有交易' } };
    threw = null;
    try {
      await fn('POST', '/api/accounts/1', { name: 'x' });
    } catch (e) {
      threw = e;
    }
    ok('ok:false 时抛错并透传 error 文案', !!threw && threw.message === '账户下还有交易', threw ? threw.message : '未抛错');

    // 4. 非 2xx 且无 error 字段时回落到 HTTP 状态
    ctx.__nextResponse = { ok: false, status: 500, body: {} };
    threw = null;
    try {
      await fn('GET', '/api/x');
    } catch (e) {
      threw = e;
    }
    ok('HTTP 500 时抛 HTTP 500', !!threw && threw.message === 'HTTP 500', threw ? threw.message : '未抛错');
  }
}

// ---------------- account / admin: j()
for (const file of ['account-template.html', 'admin-template.html']) {
  const html = fs.readFileSync(path.join(ROOT, 'src', file), 'utf8');
  const fnSrc = scriptBlocks(html).map((s) => extractFn(s, 'j')).find(Boolean);
  ok(`能定位 ${file} 的 j() 函数`, !!fnSrc);
  if (!fnSrc) continue;
  const { fn, calls, ctx } = await loadFn(fnSrc);

  let threw = null;
  try {
    await fn('POST', '/api/auth/password', { currentPassword: 'a', newPassword: 'b' });
  } catch (e) {
    threw = e;
  }
  ok(`${file} POST 带 body 不抛错`, !threw, threw ? `${threw.name}: ${threw.message}` : '');
  const sent = calls[0] || { opts: {} };
  ok(`${file} 带上 Content-Type`, (sent.opts.headers || {})['Content-Type'] === 'application/json');
  ok(`${file} body 被序列化`, typeof sent.opts.body === 'string' && sent.opts.body.includes('newPassword'));

  // 401 要跳登录页
  ctx.__nextResponse = { ok: false, status: 401, body: {} };
  threw = null;
  try {
    await fn('GET', '/api/auth/me');
  } catch (e) {
    threw = e;
  }
  ok(`${file} 401 时跳 /login`, ctx.location.href === '/login', ctx.location.href || '未跳转');
}

// ---------------- 静态扫描：headers 未初始化就赋值
console.log('\n=== 静态扫描：headers 赋值前必须已初始化 ===');
const templates = ['workbench-template.html', 'login-template.html', 'account-template.html', 'admin-template.html'];
let flagged = 0;
for (const file of templates) {
  const src = fs.readFileSync(path.join(ROOT, 'src', file), 'utf8');
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    // 形如 opts.headers['X'] = ... / init.headers.X = ...
    const m = /(\w+)\.headers\[\s*['"]/.exec(line) || /(\w+)\.headers\.[A-Za-z]/.exec(line);
    if (!m) return;
    const obj = m[1];
    // 在该行之前 25 行内找 `${obj} = { ... headers:` 或 `${obj}.headers = {`
    const from = Math.max(0, i - 25);
    const window = lines.slice(from, i).join('\n');
    const initialized =
      new RegExp(`${obj}\\s*=\\s*\\{[^}]*headers\\s*:`).test(window) ||
      new RegExp(`${obj}\\.headers\\s*=\\s*\\{`).test(window);
    if (!initialized) {
      flagged++;
      console.log(`  ✗ ${file}:${i + 1}  ${obj}.headers 未初始化就赋值 —— ${line.trim().slice(0, 80)}`);
      failures.push(`${file}:${i + 1} headers 未初始化`);
    }
  });
}
ok('没有「headers 未初始化就赋值」的写法', flagged === 0, flagged ? `${flagged} 处` : '');

console.log(`\n结果：${pass} 通过 / ${failures.length} 失败`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(failures.length ? 1 : 0);
