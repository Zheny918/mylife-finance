#!/usr/bin/env node
/**
 * 镜像归档独立复核（不依赖 Docker）
 *
 *   node scripts/verify-image-archive.mjs                       # 默认 dist 下当前版本的 tar
 *   node scripts/verify-image-archive.mjs <镜像tar> [解包目录]
 *
 * 为什么需要它：本机常常没有可用的 Docker 引擎，`docker load` 跑不了。
 * 但「归档结构合法」和「归档里的代码就是测试过的那份代码」是两件事，
 * build-image-tar.mjs 只保证前者。这个脚本补后者：
 *
 *   1. 外层是合法 Docker Archive（manifest.json / config / 层路径 / repositories）
 *   2. config 的版本标签、Entrypoint、Cmd、端口、卷与期望一致
 *   3. 应用层逐文件与工作区源码 sha256 比对（双向：不多、不少、不改）
 *   4. 把应用层解到磁盘，供 `node app/server-http.js` 实跑验证
 *
 * 退出码：0 全过；1 有失败项。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const TAG = `mylife-finance-mcp:${VERSION}`;

const TAR =
  process.argv[2] || path.join(ROOT, 'dist', `mylife-finance-mcp_${VERSION}-linux-amd64.tar`);
// 默认不落在 dist/，避免解包残留混进交付目录
const DEST = process.argv[3] || path.join(os.tmpdir(), `mylf-unpack-${VERSION}`);

if (!fs.existsSync(TAR)) {
  console.error(`找不到归档：${TAR}`);
  process.exit(1);
}

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const pad512 = (n) => (512 - (n % 512)) % 512;

let pass = 0,
  fail = 0;
const ok = (name, cond, extra) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`);
  }
};

/** 扫 tar 头部，返回条目元数据（不读内容，便于只取小条目） */
function scan(buf) {
  const out = [];
  let pos = 0;
  while (pos + 512 <= buf.length) {
    const h = buf.subarray(pos, pos + 512);
    if (h.every((b) => b === 0)) break;
    const name = h.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const mode = parseInt(h.toString('ascii', 100, 108).replace(/\0.*$/, '').trim(), 8);
    const size = parseInt(h.toString('ascii', 124, 136).replace(/\0.*$/, '').trim(), 8) || 0;
    const type = String.fromCharCode(h[156]);
    out.push({ name, mode, size, type, start: pos + 512 });
    pos += 512 + size + pad512(size);
  }
  return out;
}

console.log(`归档    ${path.relative(ROOT, TAR) || TAR}`);
console.log(`期望    ${TAG}\n`);

const outer = fs.readFileSync(TAR);
const O = scan(outer);
console.log(`外层条目 ${O.length} 个`);

// ---- 1. manifest.json
const manE = O.find((e) => e.name === 'manifest.json');
ok('根目录 manifest.json 存在', !!manE);
if (!manE) {
  console.log('\n没有 manifest.json，这份归档不是 Docker Archive（可能是 OCI Layout），无法继续。');
  process.exit(1);
}
const man = JSON.parse(outer.subarray(manE.start, manE.start + manE.size).toString('utf8'));
const item = man[0];
ok('manifest 是数组且含 Config/Layers', Array.isArray(man) && !!item.Config && Array.isArray(item.Layers));
ok(`RepoTags 含 ${TAG}`, (item.RepoTags || []).includes(TAG), JSON.stringify(item.RepoTags));

// ---- 2. config
const cfgE = O.find((e) => e.name === item.Config);
ok('config 文件存在', !!cfgE, item.Config);
const cfgBuf = outer.subarray(cfgE.start, cfgE.start + cfgE.size);
ok('config 文件名 = 内容 sha256', sha(cfgBuf) === item.Config.replace(/\.json$/, ''));
const cfg = JSON.parse(cfgBuf.toString('utf8'));
ok(
  'config 版本标签与 package.json 一致',
  cfg.config.Labels['org.opencontainers.image.version'] === VERSION,
  cfg.config.Labels['org.opencontainers.image.version']
);
ok('architecture/os = amd64/linux', cfg.architecture === 'amd64' && cfg.os === 'linux', `${cfg.os}/${cfg.architecture}`);
ok('Entrypoint 指向 docker-entrypoint.sh', JSON.stringify(cfg.config.Entrypoint).includes('docker-entrypoint.sh'));
ok('Cmd = node server-http.js', JSON.stringify(cfg.config.Cmd) === JSON.stringify(['node', '--no-warnings', 'server-http.js']));
ok('暴露 3458 且挂 /data', !!cfg.config.ExposedPorts['3458/tcp'] && !!cfg.config.Volumes['/data']);
ok(
  'rootfs diff_ids 数量 = manifest Layers 数量',
  cfg.rootfs.diff_ids.length === item.Layers.length,
  `${cfg.rootfs.diff_ids.length} vs ${item.Layers.length}`
);

// ---- 3. 应用层（显式取最后一个 layer，不靠"看起来像"判断）
const appRel = item.Layers[item.Layers.length - 1];
const appE = O.find((e) => e.name === appRel);
ok('应用层条目存在', !!appE, appRel.split('/')[0].slice(0, 12) + '…/layer.tar');
if (!appE) process.exit(1);
const appBuf = outer.subarray(appE.start, appE.start + appE.size);
ok('应用层是未压缩 tar（非 gzip）', !(appBuf[0] === 0x1f && appBuf[1] === 0x8b));
ok(
  '应用层 sha256 = config 最后一个 diff_id',
  sha(appBuf) === cfg.rootfs.diff_ids[cfg.rootfs.diff_ids.length - 1].replace('sha256:', '')
);

const A = scan(appBuf);
const get = (e) => appBuf.subarray(e.start, e.start + e.size);
const files = A.filter((e) => e.type === '0');
console.log(`应用层：${files.length} 个文件 + ${A.length - files.length} 个目录`);

// ---- 4. 双向比对：包内 ↔ 工作区
let compared = 0;
const details = [];
for (const e of files) {
  const rel = e.name.startsWith('app/') ? e.name.slice(4) : e.name;
  const local = e.name.startsWith('app/') ? path.join(ROOT, rel) : path.join(ROOT, 'docker-entrypoint.sh');
  if (!fs.existsSync(local)) {
    details.push(`包内多出: ${e.name}`);
    continue;
  }
  compared++;
  if (sha(fs.readFileSync(local)) !== sha(get(e))) details.push(`内容不一致: ${e.name}`);
}
ok('包内每个文件都与工作区逐字节一致', details.length === 0, `比对 ${compared} 个${details.length ? ' | ' + details.slice(0, 5).join('; ') : ''}`);

// 入口脚本在包内路径是 usr/local/bin/，比对 key 必须用包内路径
const expect = ['package.json', 'server.js', 'server-http.js', 'usr/local/bin/docker-entrypoint.sh'];
for (const f of fs.readdirSync(path.join(ROOT, 'src'))) {
  if (fs.statSync(path.join(ROOT, 'src', f)).isFile()) expect.push('src/' + f);
}
const inPkg = new Set(files.map((e) => (e.name.startsWith('app/') ? e.name.slice(4) : e.name)));
const missing = expect.filter((f) => !inPkg.has(f));
ok('工作区源码无遗漏（含新增文件）', missing.length === 0, missing.length ? '缺: ' + missing.join(', ') : `应含 ${expect.length}，实含 ${files.length}`);

// ---- 5. 版本与权限
const pkgIn = JSON.parse(get(files.find((e) => e.name === 'app/package.json')).toString('utf8'));
ok('包内 package.json version 与工作区一致', pkgIn.version === VERSION, pkgIn.version);
const entryE = files.find((e) => e.name === 'usr/local/bin/docker-entrypoint.sh');
ok('入口脚本 mode=755', !!entryE && entryE.mode === 0o755, entryE ? 'mode=' + entryE.mode.toString(8) : '缺失');

// ---- 6. 不该进镜像的东西
const stray = files.filter((e) => /\.db$|\.log$|node_modules|\.map$|^app\/data\//.test(e.name));
ok('包内无数据库/日志/依赖/运行数据残留', stray.length === 0, stray.map((s) => s.name).join(', '));

// ---- 7. 落盘供实跑
await fsp.rm(DEST, { recursive: true, force: true });
for (const e of A) {
  const p = path.join(DEST, e.name);
  if (e.type === '5') await fsp.mkdir(p, { recursive: true });
  else {
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, get(e));
    if (e.mode & 0o111) await fsp.chmod(p, e.mode).catch(() => {});
  }
}

console.log(`\n已解包到 ${path.relative(ROOT, DEST)}`);
console.log(`实跑：cd ${path.relative(ROOT, DEST)}/app && MYLF_DATA_DIR=<临时目录> MYLF_HTTP_PORT=3491 \\`);
console.log(`      MYLF_ADMIN_USER=admin MYLF_ADMIN_PASSWORD=<密码> node --no-warnings server-http.js`);
console.log(`      SMOKE_BASE=http://127.0.0.1:3491 SMOKE_ADMIN_PASSWORD=<密码> node scripts/test-auth.mjs`);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
