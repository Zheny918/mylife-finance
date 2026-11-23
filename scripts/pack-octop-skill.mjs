#!/usr/bin/env node
/*
 * 打包 Octop 技能包（ZIP），零依赖：只用 node:zlib + node:crypto。
 *
 * 产物：dist/mylife-finance-skill-<version>.zip
 * 结构：
 *   mylife-finance/
 *   ├── SKILL.md
 *   └── references/tools.md
 *
 * Octop 的规则：包内所有文件位于同一个顶层目录且该目录下有 SKILL.md 时，会剥掉这一层。
 * 所以落地后是 <agent>/skills/mylife-finance/SKILL.md。
 *
 * 用法：node scripts/pack-octop-skill.mjs [--verify-only]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(ROOT, 'octop-skill');
const TOP = 'mylife-finance';
const DIST = path.join(ROOT, 'dist');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const OUT = path.join(DIST, `mylife-finance-skill-${pkg.version}.zip`);

/* ---------- CRC32 ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ---------- 文件收集 ---------- */
function walk(dir, base = '') {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${ent.name}` : ent.name;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(abs, rel));
    else if (ent.isFile()) out.push({ rel, abs });
  }
  return out;
}

// 固定时间戳（2026-01-01 00:00），保证同样输入得到同样字节
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const raw = fs.readFileSync(e.abs);
    const crc = crc32(raw);
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    // 压缩后更大时退回存储，避免负收益
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    locals.push(local, nameBuf, body);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, cd, eocd]);
}

/* ---------- 回读校验 ---------- */
function verifyZip(buf) {
  const eocdPos = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocdPos < 0) throw new Error('找不到 EOCD');
  const total = buf.readUInt16LE(eocdPos + 10);
  const cdSize = buf.readUInt32LE(eocdPos + 12);
  const cdOffset = buf.readUInt32LE(eocdPos + 16);

  const results = [];
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`中央目录签名错 @${p}`);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');

    // 从 local header 定位数据
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error(`本地头签名错: ${name}`);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.slice(dataStart, dataStart + compSize);
    const raw = method === 8 ? zlib.inflateRawSync(comp) : comp;

    if (raw.length !== uncompSize) throw new Error(`${name} 解压大小不符`);
    if (crc32(raw) !== crc) throw new Error(`${name} CRC 校验失败`);

    results.push({ name, size: raw.length });
    p += 46 + nameLen + extraLen + commentLen;
  }

  if (p - cdOffset !== cdSize) throw new Error('中央目录大小不符');
  return results;
}

/* ---------- main ---------- */
function main() {
  const verifyOnly = process.argv.includes('--verify-only');

  if (!verifyOnly) {
    if (!fs.existsSync(SRC_DIR)) throw new Error(`缺少源目录 ${SRC_DIR}`);
    const skillMd = path.join(SRC_DIR, 'SKILL.md');
    if (!fs.existsSync(skillMd)) throw new Error('octop-skill/SKILL.md 不存在');

    const files = walk(SRC_DIR).map((f) => ({ rel: f.rel, abs: f.abs, name: `${TOP}/${f.rel}` }));
    files.sort((a, b) => a.name.localeCompare(b.name));

    const zip = buildZip(files);
    fs.mkdirSync(DIST, { recursive: true });
    fs.writeFileSync(OUT, zip);

    const sha = crypto.createHash('sha256').update(zip).digest('hex');
    console.log(`已生成 ${path.relative(ROOT, OUT)}`);
    console.log(`  大小 ${zip.length} bytes，${files.length} 个文件`);
    console.log(`  sha256 ${sha}`);
    files.forEach((f) => console.log(`  + ${f.name}`));
  }

  if (!fs.existsSync(OUT)) throw new Error(`产物不存在：${OUT}`);
  const buf = fs.readFileSync(OUT);
  const entries = verifyZip(buf);

  console.log('\n回读校验通过：');
  entries.forEach((e) => console.log(`  ✓ ${e.name} (${e.size} bytes)`));

  const hasRootSkill = entries.some((e) => e.name === `${TOP}/SKILL.md`);
  if (!hasRootSkill) throw new Error(`顶层目录 ${TOP}/ 下缺少 SKILL.md，Octop 会拒绝安装`);
  if (entries.length > 2000) throw new Error('条目数超过 Octop 上限 2000');
  const totalUncompressed = entries.reduce((s, e) => s + e.size, 0);
  if (totalUncompressed > 64 * 1024 * 1024) throw new Error('解压后超过 Octop 上限 64 MiB');

  console.log(`\n符合 Octop 技能包规范：根 SKILL.md ✓，条目 ${entries.length}/2000，解压合计 ${totalUncompressed} bytes`);
}

main();
