#!/usr/bin/env node
'use strict';
/**
 * Docker 镜像构建 + 端到端验收（零依赖，只用 Node 内置模块）
 *
 *   node scripts/docker-build-verify.mjs              # 构建 + 全量验收 + 自动清理
 *   node scripts/docker-build-verify.mjs --no-build   # 跳过构建，验已有镜像
 *   node scripts/docker-build-verify.mjs --keep       # 验收后保留容器，方便手动上手摸
 *   node scripts/docker-build-verify.mjs --port 3499  # 换宿主端口（默认 3499）
 *   node scripts/docker-build-verify.mjs --tag a:b    # 换镜像标签
 *
 * 为什么要这个脚本：docker build 成功只说明镜像能构建，不代表能跑。
 * 这里额外验：健康检查、MCP 握手、工具清单、真实写入、多用户隔离、
 * 数据卷持久化（重启后数据还在）、镜像内 Node 版本闸门。
 *
 * 退出码：0 全过；1 有失败项。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const opt = (n, def) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};

const VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const TAG = opt('--tag', `mylife-finance-mcp:${VERSION}`);
const PORT = Number(opt('--port', '3499'));
const STAMP = Date.now().toString(36);
const CNAME = `mylf-verify-${STAMP}`;
const VOLUME = `${CNAME}-data`;
const BASE = `http://127.0.0.1:${PORT}`;
const DO_BUILD = !has('--no-build');
const KEEP = has('--keep');

let pass = 0;
const failures = [];
let daemonOk = false;

function ok(msg, extra) {
  pass++;
  console.log(`  [ OK ] ${msg}${extra ? `  ${extra}` : ''}`);
}
function bad(msg, extra) {
  failures.push(msg);
  console.log(`  [FAIL] ${msg}${extra ? `  ${extra}` : ''}`);
}
function check(cond, msg, extra) {
  if (cond) ok(msg, extra); else bad(msg, extra);
  return cond;
}
function section(t) {
  console.log(`\n=== ${t} ===`);
}

/** 同步执行，捕获输出；失败抛错 */
function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: opts.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    timeout: opts.timeout || 600000,
  });
}

/** 同步执行，不抛错，返回 { ok, out } */
function tryRun(cmd, args, opts = {}) {
  try {
    return { ok: true, out: String(run(cmd, args, opts) || '').trim() };
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`.trim() || e.message;
    return { ok: false, out: out.trim() };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(user, body, opts = {}) {
  // opts.raw：user 已是编码好的路径片段（测非法 userId 时要传字面量 %2F）
  const seg = opts.raw ? user : encodeURIComponent(user);
  const res = await fetch(`${BASE}/mcp/${seg}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应由调用方按 text 判断 */
  }
  return { status: res.status, headers: res.headers, json, text };
}

async function callTool(user, name, args = {}) {
  const r = await rpc(user, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  if (!r.json || !r.json.result) throw new Error(`tools/call ${name} 无 result（HTTP ${r.status}）: ${r.text.slice(0, 200)}`);
  if (r.json.result.isError) throw new Error(`${name} 返回 isError: ${r.json.result.content?.[0]?.text}`);
  const raw = r.json.result.content?.[0]?.text ?? '';
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function waitHealth(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return { ok: true, body: await res.json() };
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = e.message;
    }
    await sleep(500);
  }
  return { ok: false, last };
}

function dockerLogs(name) {
  const r = tryRun('docker', ['logs', '--tail', '40', name], { timeout: 15000 });
  return r.ok ? r.out : r.out;
}

function cleanup() {
  if (!daemonOk) {
    console.log('\n守护进程不可用，跳过清理（本就没创建任何容器）。');
    return;
  }
  if (KEEP) {
    console.log(`\n--keep：容器 ${CNAME} 与数据卷 ${VOLUME} 已保留。`);
    console.log(`  访问：${BASE}/health    清理：docker rm -f ${CNAME} && docker volume rm ${VOLUME}`);
    return;
  }
  tryRun('docker', ['rm', '-f', CNAME], { timeout: 30000 });
  tryRun('docker', ['volume', 'rm', '-f', VOLUME], { timeout: 30000 });
  console.log('\n已清理测试容器与数据卷。');
}

async function main() {
  console.log(`镜像标签：${TAG}\n测试容器：${CNAME}  端口：127.0.0.1:${PORT}`);

  // 1. 守护进程（连不上命名管道时 CLI 会一直干等，必须给短超时）
  section('1. 守护进程');
  const ver = tryRun('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 15000 });
  if (!check(ver.ok && ver.out, 'Docker 守护进程可连接', ver.ok ? `Server ${ver.out}` : ver.out.slice(0, 200))) {
    console.log('\n守护进程不可用，后续步骤无法进行。');
    console.log('Windows 上请先确认 Docker Desktop 已启动且托盘图标变绿：');
    console.log('  docker desktop status');
    console.log('  docker version --format "{{.Server.Version}}"');
    return false;
  }
  daemonOk = true;
  tryRun('docker', ['rm', '-f', CNAME]);
  tryRun('docker', ['volume', 'rm', '-f', VOLUME]);

  // 2. 构建
  section('2. 构建镜像');
  if (DO_BUILD) {
    const t0 = Date.now();
    try {
      run('docker', ['build', '-t', TAG, '.'], { inherit: true });
      ok(`构建成功，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (e) {
      bad('构建失败', '见上方构建日志');
      return false;
    }
  } else {
    console.log('  --no-build：跳过构建');
  }
  const insp = tryRun('docker', ['image', 'inspect', TAG, '--format', '{{.Id}} {{.Size}}']);
  check(insp.ok, '镜像存在', insp.ok ? insp.out : insp.out.slice(0, 160));

  // 3. 镜像内 Node 版本闸门（entrypoint 会校验，这里确认基础镜像真的达标）
  section('3. 镜像内运行时');
  const nodeV = tryRun('docker', ['run', '--rm', '--entrypoint', 'node', TAG, '-v']);
  check(nodeV.ok && /^v(2[2-9]|[3-9]\d)\./.test(nodeV.out), '镜像内 Node ≥ 22', nodeV.out || nodeV.out);
  const entry = tryRun('docker', ['run', '--rm', '--entrypoint', 'node', TAG, '-e', "require('node:sqlite');console.log('sqlite-ok')"]);
  check(entry.ok && entry.out.includes('sqlite-ok'), 'node:sqlite 可加载', entry.out.slice(0, 120));

  // 4. 启动容器
  section('4. 启动容器');
  const runRes = tryRun('docker', [
    'run', '-d', '--name', CNAME,
    '-e', 'MYLF_DATA_DIR=/data',
    '-e', 'MYLF_HTTP_PORT=3458',
    '-v', `${VOLUME}:/data`,
    '-p', `127.0.0.1:${PORT}:3458`,
    TAG,
  ]);
  if (!check(runRes.ok, 'docker run 成功', runRes.ok ? runRes.out.slice(0, 12) : runRes.out.slice(0, 300))) return false;

  const h = await waitHealth();
  if (!check(h.ok, '健康检查通过（90s 内）', h.ok ? JSON.stringify(h.body) : `未就绪：${h.last}`)) {
    console.log('\n--- 容器日志 ---\n' + dockerLogs(CNAME));
    return false;
  }
  check(h.body && h.body.ok === true, 'health 返回 ok=true');
  check(h.body && h.body.transport === 'streamable-http', '传输为 streamable-http', h.body && h.body.transport);
  check(h.body && h.body.toolCount === 43, '工具数 43（不含 user_create）', h.body && `toolCount=${h.body.toolCount}`);

  // 5. MCP 协议握手
  section('5. MCP 协议');
  const init = await rpc('alice', {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'docker-verify', version: '0' } },
  });
  check(init.status === 200 && init.json && init.json.result, 'initialize 成功', `HTTP ${init.status}`);
  check(String(init.headers.get('mcp-session-id') || '').length > 0, '下发 Mcp-Session-Id', init.headers.get('mcp-session-id') || '(空)');

  const list = await rpc('alice', { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = (list.json && list.json.result && list.json.result.tools || []).map((t) => t.name);
  check(names.length === 43 && names.length === (h.body && h.body.toolCount), 'tools/list 43 个且与 health 一致', `实际 ${names.length}`);
  check(!names.includes('user_create'), 'user_create 已从清单移除');

  const notif = await rpc('alice', { jsonrpc: '2.0', method: 'notifications/initialized' });
  check(notif.status === 202, '通知类请求返回 202', `HTTP ${notif.status}`);

  // 6. 业务写入与隔离
  section('6. 写入与隔离');
  try {
    const added = await callTool('alice', 'tx_add', {
      type: 'EXPENSE', amount: 88.5, category: '三餐', account: '招行', date: '2026-11-15', description: 'docker-verify',
    });
    check(added && added.ok === true, 'tx_add 写入成功', added && added.transaction && `${added.transaction.date} ${added.transaction.category}`);
  } catch (e) {
    bad('tx_add 写入失败', e.message);
  }

  const cats = await callTool('alice', 'category_list', {});
  const catArr = (cats && cats.categories) || [];
  check(catArr.length === 137, '新租户自动播种 137 个分类', `实际 ${catArr.length}`);
  check(catArr.filter((c) => !c.parent_id).length === 18, '顶级分类 18 个', `实际 ${catArr.filter((c) => !c.parent_id).length}`);

  const bob = await callTool('bob', 'tx_list', {});
  check(bob && bob.count === 0, 'bob 看不到 alice 的数据', `bob count=${bob && bob.count}`);

  try {
    const attack = await callTool('alice', 'tx_add', {
      type: 'EXPENSE', amount: 1, category: '三餐', account: '越权', description: 'attack', userId: 'bob',
    });
    check(attack && attack.ok === true, '越权写入被接受但落回 alice');
  } catch (e) {
    bad('越权写入测试异常', e.message);
  }
  const bobAfter = await callTool('bob', 'tx_list', {});
  check(bobAfter && bobAfter.count === 0, '伪造 userId=bob 未串数据', `bob count=${bobAfter && bobAfter.count}`);
  const aliceAll = await callTool('alice', 'tx_list', { limit: 50 });
  check(aliceAll && aliceAll.count === 2, '两笔都落在 alice 名下', `alice count=${aliceAll && aliceAll.count}`);

  let rejected = false;
  try {
    const r = await callTool('alice', 'user_create', { name: 'hacker' });
    rejected = !!(r && r.error);
  } catch {
    rejected = true;
  }
  check(rejected, 'user_create 被拒绝');

  const badUser = await rpc('a%2Fb', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { raw: true });
  check(badUser.status === 400, '非法 userId（含斜杠）返回 400', `HTTP ${badUser.status}`);

  // 7. 数据卷持久化（重启后数据仍在）
  section('7. 数据持久化');
  const restart = tryRun('docker', ['restart', CNAME]);
  check(restart.ok, 'docker restart 成功', restart.ok ? '' : restart.out.slice(0, 200));
  const h2 = await waitHealth(60000);
  if (check(h2.ok, '重启后健康检查恢复')) {
    const again = await callTool('alice', 'tx_list', { limit: 50 });
    check(again && again.count === 2, '重启后数据仍在（/data 卷生效）', `alice count=${again && again.count}`);
  } else {
    bad('重启后无法访问', dockerLogs(CNAME).slice(0, 400));
  }

  return true;
}

main()
  .then((done) => {
    console.log('\n' + '='.repeat(56));
    if (failures.length === 0 && done !== false) {
      console.log(`全部通过：${pass} 项`);
      cleanup();
      process.exit(0);
    }
    if (failures.length) {
      console.log(`通过 ${pass} 项，失败 ${failures.length} 项：`);
      failures.forEach((f) => console.log(`  - ${f}`));
    }
    cleanup();
    process.exit(1);
  })
  .catch((e) => {
    console.error('\n脚本异常：' + (e && e.stack ? e.stack : e));
    cleanup();
    process.exit(1);
  });
