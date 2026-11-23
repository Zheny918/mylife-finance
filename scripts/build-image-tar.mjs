#!/usr/bin/env node
/*
 * 在没有 Docker 的机器上产出「可直接 docker load / 容器平台导入」的镜像归档。
 *
 *   node scripts/build-image-tar.mjs                       # 默认 docker 格式（QNAP 等都能导入）
 *   node scripts/build-image-tar.mjs --gzip                # 额外再出一个 .tar.gz（体积约 1/3）
 *   node scripts/build-image-tar.mjs --format oci           # OCI Image Layout（containerd / podman 用）
 *   node scripts/build-image-tar.mjs --platform linux/arm64 # ARM 群晖/威联通
 *   node scripts/build-image-tar.mjs --registry https://docker.m.daocloud.io --base node:22-alpine
 *
 * 镜像源说明：脚本按 Docker Registry v2 标准鉴权（401 → 换 token → 重试），
 * 所以官方源、国内加速镜像、匿名代理都能用。默认走 docker.m.daocloud.io；
 * 哪个源当天不通就用 --registry 换一个（如 https://docker.1ms.run）。
 *
 * 原理：镜像 = 基础镜像层 + 应用层 + config + manifest。这里从 registry 拉官方
 * node:22-alpine 的层（内容不改一个字节），再把本仓库的 app 文件打成一个新层，
 * 重写 config，按目标格式落盘。
 *
 * 两种格式的区别（很重要，选错对方会报「格式不正确」）：
 *
 *   docker —— Docker Archive（`docker save` 产物，兼容性最好）：
 *     manifest.json                 [{"Config":"<cfg>.json","RepoTags":[...],"Layers":["<id>/layer.tar",...]}]
 *     <cfg-sha>.json                镜像 config
 *     <layer-id>/VERSION            "1.0"
 *     <layer-id>/json               旧式 layer 元数据
 *     <layer-id>/layer.tar          **未压缩** tar
 *     repositories                  tag → 顶层 layer id
 *
 *   oci —— OCI Image Layout（`podman save --format oci` 产物）：
 *     oci-layout / index.json / blobs/sha256/<digest>（层是 gzip 裸 blob）
 *     ⚠ Docker ≤ 24 的 `docker load` 与多数 NAS 的「导入镜像」界面都不认这个格式。
 *
 * 依赖：Node ≥ 22（内置 fetch / zlib / crypto），无 npm 依赖。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const has = (n) => argv.includes(n);

const REGISTRY = opt('--registry', process.env.MYLF_REGISTRY || 'https://docker.m.daocloud.io').replace(/\/+$/, '');
const BASE = opt('--base', 'node:22-alpine');
const PLATFORM = opt('--platform', 'linux/amd64');
const TAG = opt('--tag', `mylife-finance-mcp:${pkg.version}`);
const FORMAT = opt('--format', 'docker');
const MTIME = 1700000000; // 固定时间戳，保证同样输入产出同样文件

if (!['docker', 'oci'].includes(FORMAT)) throw new Error(`--format 只能是 docker 或 oci，收到 ${FORMAT}`);

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ---------------------------------------------------------------- tar 写入

function octal(n, len) {
  return n.toString(8).padStart(len - 1, '0') + '\0';
}

function tarHeader({ name, mode = 0o644, size = 0, type = '0', mtime = MTIME }) {
  const h = Buffer.alloc(512, 0);
  h.write(name, 0, 100, 'utf8');
  h.write(octal(mode, 8), 100, 8, 'ascii');
  h.write(octal(0, 8), 108, 8, 'ascii'); // uid
  h.write(octal(0, 8), 116, 8, 'ascii'); // gid
  h.write(octal(size, 12), 124, 12, 'ascii');
  h.write(octal(mtime, 12), 136, 12, 'ascii');
  h.fill(0x20, 148, 156); // 校验和先填空格
  h.write(type, 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  h.write('root', 265, 32, 'ascii');
  h.write('root', 297, 32, 'ascii');
  h.write(octal(0, 8), 329, 8, 'ascii');
  h.write(octal(0, 8), 337, 8, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return h;
}

const pad512 = (n) => (512 - (n % 512)) % 512;

/** 内存里拼一个 tar（只用于我们自己那个小应用层） */
function tarFromEntries(entries) {
  const parts = [];
  for (const e of entries) {
    const data = e.data || Buffer.alloc(0);
    parts.push(tarHeader({ name: e.name, mode: e.mode, size: data.length, type: e.type }));
    if (data.length) {
      parts.push(data);
      const pad = pad512(data.length);
      if (pad) parts.push(Buffer.alloc(pad, 0));
    }
  }
  parts.push(Buffer.alloc(1024, 0));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- registry

// Registry 鉴权（Docker Registry v2 标准流程）。
// 匿名代理（如老的 dockerproxy.net）直接 200；官方源与多数国内加速镜像会先回
// 401 + `WWW-Authenticate: Bearer realm=...,service=...,scope=...`，
// 要先拿 token 再带 Authorization 重试一次，否则全部请求都会 401。
let regToken = null;
let regTokenKey = '';

async function regFetch(url, init = {}) {
  const withAuth = (useToken) => {
    const headers = { ...(init.headers || {}) };
    if (useToken && regToken) headers.Authorization = `Bearer ${regToken}`;
    return fetch(url, { ...init, headers });
  };

  let res = await withAuth(true);
  if (res.status !== 401) return res;

  const wa = res.headers.get('www-authenticate') || '';
  const realm = (/realm="([^"]+)"/.exec(wa) || [])[1];
  if (!realm) return res;
  const service = (/service="([^"]+)"/.exec(wa) || [])[1] || '';
  const scope = (/scope="([^"]+)"/.exec(wa) || [])[1] || 'repository:library/node:pull';
  const key = `${service}|${scope}`;
  // 同一个 scope 换过一次 token 还是 401，就别再换了（避免死循环）
  if (regToken && regTokenKey === key) return res;

  const tu = new URL(realm);
  if (service) tu.searchParams.set('service', service);
  tu.searchParams.set('scope', scope);
  const tRes = await fetch(tu);
  if (!tRes.ok) return res;
  const tj = await tRes.json().catch(() => ({}));
  regToken = tj.token || tj.access_token || null;
  regTokenKey = key;
  if (!regToken) return res;
  return withAuth(true);
}

function parseImageRef(ref) {
  let repo = ref;
  let tag = 'latest';
  const at = ref.indexOf('@');
  if (at >= 0) return { repo: ref.slice(0, at), ref: ref.slice(at + 1) };
  const colon = ref.lastIndexOf(':');
  if (colon > 0 && !ref.slice(colon + 1).includes('/')) {
    repo = ref.slice(0, colon);
    tag = ref.slice(colon + 1);
  }
  if (!repo.includes('/')) repo = `library/${repo}`;
  return { repo, tag };
}

async function registryGet(pathname, accept) {
  const url = `${REGISTRY}/v2/${pathname}`;
  const res = await regFetch(url, { headers: accept ? { Accept: accept } : {} });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return res;
}

async function downloadTo(url, dest) {
  const res = await regFetch(url);
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  const out = fs.createWriteStream(dest);
  await new Promise((resolve, reject) => {
    res.body.pipeTo(
      new WritableStream({
        write(chunk) {
          return new Promise((r) => (out.write(chunk) ? r() : out.once('drain', r)));
        },
        close() {
          out.end(resolve);
        },
        abort(e) {
          out.destroy();
          reject(e);
        },
      })
    ).catch(reject);
  });
  return fs.statSync(dest).size;
}

// ---------------------------------------------------------------- 层处理

/** 判断文件是否 gzip（读前 2 字节，避免把"名字像 gz"当成依据） */
async function isGzip(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const b = Buffer.alloc(2);
    await fh.read(b, 0, 2, 0);
    return b[0] === 0x1f && b[1] === 0x8b;
  } finally {
    await fh.close();
  }
}

/** 落成**未压缩** tar，同时算 diff_id（= sha256(未压缩 tar)），与 Docker 口径一致 */
async function materializeLayer(src, dest) {
  const gz = await isGzip(src);
  const hash = crypto.createHash('sha256');
  let size = 0;
  const out = fs.createWriteStream(dest);
  const srcStream = fs.createReadStream(src);
  const stream = gz ? srcStream.pipe(zlib.createGunzip()) : srcStream;
  await new Promise((resolve, reject) => {
    stream.on('data', (c) => {
      hash.update(c);
      size += c.length;
      if (!out.write(c)) {
        stream.pause();
        out.once('drain', () => stream.resume());
      }
    });
    stream.on('end', () => out.end(resolve));
    stream.on('error', reject);
    out.on('error', reject);
  });
  return { size, digest: hash.digest('hex'), wasGzip: gz };
}

/** Docker 旧式层 id = ChainID：首层等于 diff_id，之后 sha256(前一个 chainId + " " + diffId) */
function computeChainIds(diffIds) {
  const ids = [];
  let prev = null;
  for (const d of diffIds) {
    const id = prev ? sha256(Buffer.from(`${prev} ${d}`)) : d;
    ids.push(id);
    prev = id;
  }
  return ids;
}

// ---------------------------------------------------------------- 应用层

const APP_FILES = [
  ['package.json', 'app/package.json', 0o644],
  ['server.js', 'app/server.js', 0o644],
  ['server-http.js', 'app/server-http.js', 0o644],
  ['docker-entrypoint.sh', 'usr/local/bin/docker-entrypoint.sh', 0o755],
];

function collectSrcFiles(dir = 'src', acc = []) {
  for (const name of fs.readdirSync(path.join(ROOT, dir)).sort()) {
    const rel = `${dir}/${name}`;
    const st = fs.statSync(path.join(ROOT, rel));
    if (st.isDirectory()) collectSrcFiles(rel, acc);
    else acc.push([rel, `app/${rel}`, 0o644]);
  }
  return acc;
}

function buildAppLayer() {
  const files = APP_FILES.concat(collectSrcFiles());
  for (const [src] of files) {
    if (!fs.existsSync(path.join(ROOT, src))) throw new Error(`缺少文件：${src}`);
  }
  const dirs = new Set();
  for (const [, dest] of files) {
    const segs = dest.split('/');
    for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join('/'));
  }
  dirs.add('data');
  const entries = [];
  for (const d of [...dirs].sort()) entries.push({ name: `${d}/`, mode: 0o755, type: '5' });
  for (const [src, dest, mode] of files.sort((a, b) => a[1].localeCompare(b[1]))) {
    entries.push({ name: dest, mode, type: '0', data: fs.readFileSync(path.join(ROOT, src)) });
  }
  const tar = tarFromEntries(entries);
  return { tar, files: files.map((f) => f[1]) };
}

// ---------------------------------------------------------------- 外层 tar 写入

function createTarWriter(outFile) {
  const ws = fs.createWriteStream(outFile);
  const write = (buf) => new Promise((res, rej) => ws.write(buf, (e) => (e ? rej(e) : res())));
  return {
    /** 小文件：内存里直接写 */
    async file(name, buf, mode = 0o644) {
      await write(tarHeader({ name, mode, size: buf.length }));
      if (buf.length) await write(buf);
      const pad = pad512(buf.length);
      if (pad) await write(Buffer.alloc(pad, 0));
    },
    /** 大文件：从磁盘流式写，避免把整层读进内存 */
    async fileFromDisk(name, file, size, mode = 0o644) {
      await write(tarHeader({ name, mode, size }));
      const rs = fs.createReadStream(file, { highWaterMark: 1 << 20 });
      for await (const chunk of rs) await write(chunk);
      const pad = pad512(size);
      if (pad) await write(Buffer.alloc(pad, 0));
    },
    async close() {
      await write(Buffer.alloc(1024, 0));
      await new Promise((r) => ws.end(r));
    },
  };
}

// ---------------------------------------------------------------- 归档校验

/** 扫一遍 tar 只取元数据（名字/大小/偏移），供按需流式读取 */
async function scanTar(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size: total } = await fh.stat();
    const hb = Buffer.alloc(512);
    const entries = [];
    let pos = 0;
    while (pos + 512 <= total) {
      await fh.read(hb, 0, 512, pos);
      if (hb.every((b) => b === 0)) break;
      const name = hb.toString('utf8', 0, 100).replace(/\0.*$/, '');
      const size = parseInt(hb.toString('ascii', 124, 136).replace(/\0.*$/, '').trim(), 8) || 0;
      const mode = parseInt(hb.toString('ascii', 100, 108).replace(/\0.*$/, '').trim(), 8);
      const type = String.fromCharCode(hb[156]);
      entries.push({ name, size, mode, type, start: pos + 512 });
      pos += 512 + size + pad512(size);
    }
    return { entries, total };
  } finally {
    await fh.close();
  }
}

async function readEntry(file, entry) {
  const fh = await fsp.open(file, 'r');
  try {
    const b = Buffer.alloc(entry.size);
    if (entry.size) await fh.read(b, 0, entry.size, entry.start);
    return b;
  } finally {
    await fh.close();
  }
}

async function hashEntry(file, entry) {
  const fh = await fsp.open(file, 'r');
  try {
    const h = crypto.createHash('sha256');
    const CH = 4 << 20;
    const buf = Buffer.alloc(Math.min(CH, Math.max(entry.size, 1)));
    let off = 0;
    while (off < entry.size) {
      const n = Math.min(buf.length, entry.size - off);
      const { bytesRead } = await fh.read(buf, 0, n, entry.start + off);
      if (!bytesRead) break;
      h.update(buf.subarray(0, bytesRead));
      off += bytesRead;
    }
    return h.digest('hex');
  } finally {
    await fh.close();
  }
}

/** 对磁盘上的整个文件算 sha256（流式，不整份读进内存） */
async function hashFile(file) {
  const h = crypto.createHash('sha256');
  const rs = fs.createReadStream(file, { highWaterMark: 1 << 20 });
  for await (const chunk of rs) h.update(chunk);
  return h.digest('hex');
}

// ---------------------------------------------------------------- 主流程
async function main() {
  const { repo, tag } = parseImageRef(BASE);
  console.log(`基础镜像  ${repo}:${tag}  (${PLATFORM})`);
  console.log(`仓库      ${REGISTRY}`);
  console.log(`产物标签  ${TAG}`);
  console.log(`归档格式  ${FORMAT === 'docker' ? 'docker（Docker Archive，docker save 兼容）' : 'oci（OCI Image Layout）'}\n`);

  // 1) 解析 manifest（可能是 index / manifest list，需要按平台挑）
  console.log('[1/7] 解析基础镜像清单');
  const idxRes = await registryGet(
    `${repo}/manifests/${tag}`,
    'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'
  );
  let manifest = await idxRes.json();
  if (Array.isArray(manifest.manifests)) {
    const [wantOs, wantArch] = PLATFORM.split('/');
    const pick = manifest.manifests.find(
      (m) => m.platform && m.platform.os === wantOs && m.platform.architecture === wantArch
    );
    if (!pick) throw new Error(`基础镜像没有 ${PLATFORM} 平台`);
    console.log(`      多平台清单，选中 ${pick.digest.slice(0, 19)}…`);
    const mRes = await registryGet(
      `${repo}/manifests/${pick.digest}`,
      'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'
    );
    manifest = await mRes.json();
  }
  console.log(`      层数 ${manifest.layers.length}，config ${manifest.config.digest.slice(0, 19)}…`);

  // 2) config
  console.log('[2/7] 下载 config');
  const cfgRes = await registryGet(`${repo}/blobs/${manifest.config.digest}`);
  const baseCfg = await cfgRes.json();
  const baseDiffIds = baseCfg.rootfs.diff_ids;
  console.log(`      architecture=${baseCfg.architecture} os=${baseCfg.os} diff_ids=${baseDiffIds.length}`);
  if (baseCfg.architecture !== PLATFORM.split('/')[1] || baseCfg.os !== PLATFORM.split('/')[0]) {
    throw new Error(`config 平台 ${baseCfg.os}/${baseCfg.architecture} 与请求的 ${PLATFORM} 不符`);
  }

  // 3) 基础层。docker 格式直接落成未压缩 layer.tar；oci 格式保留 gzip blob 原样。
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mylf-img-'));
  const layers = [];
  console.log(`[3/7] 下载基础层 → ${tmp}`);
  let total = 0;
  for (let i = 0; i < manifest.layers.length; i++) {
    const L = manifest.layers[i];
    const raw = path.join(tmp, `raw-${i}`);
    const t0 = Date.now();
    const size = await downloadTo(`${REGISTRY}/v2/${repo}/blobs/${L.digest}`, raw);
    const digest = sha256(fs.readFileSync(raw));
    if (`sha256:${digest}` !== L.digest) throw new Error(`层 ${i + 1} 校验失败：期望 ${L.digest} 实得 sha256:${digest}`);
    total += size;

    if (FORMAT === 'docker') {
      const plain = path.join(tmp, `layer-${i}.tar`);
      const m = await materializeLayer(raw, plain);
      // diff_id 是"未压缩内容"的 sha256，registry 的 config 里就存着它 —— 用它反证解压无损
      const wantDiff = (baseDiffIds[i] || '').replace('sha256:', '');
      if (wantDiff && m.digest !== wantDiff) {
        throw new Error(`层 ${i + 1} 解压后 diff_id 不符：config=${wantDiff.slice(0, 19)}… 实得 ${m.digest.slice(0, 19)}…`);
      }
      fs.rmSync(raw, { force: true });
      layers.push({ file: plain, size: m.size, diffId: m.digest, blobSize: size, mediaType: L.mediaType });
      console.log(
        `      层${i + 1} ${(size / 1048576).toFixed(1)}MB → 未压缩 ${(m.size / 1048576).toFixed(1)}MB  ` +
          `${((Date.now() - t0) / 1000).toFixed(1)}s  ✓ digest ✓ diff_id`
      );
    } else {
      layers.push({ file: raw, size, diffId: baseDiffIds[i].replace('sha256:', ''), blobSize: size, mediaType: L.mediaType });
      console.log(`      层${i + 1} ${(size / 1048576).toFixed(1)}MB  ${((Date.now() - t0) / 1000).toFixed(1)}s  ✓ digest`);
    }
  }
  console.log(`      基础层合计 ${(total / 1048576).toFixed(1)}MB（registry 口径）`);

  // 4) 应用层
  console.log('[4/7] 生成应用层');
  const app = buildAppLayer();
  const appDiff = sha256(app.tar);
  const appMediaType = 'application/vnd.oci.image.layer.v1.tar+gzip';
  let appLayerFile;
  let appSize;
  if (FORMAT === 'docker') {
    appLayerFile = path.join(tmp, 'layer-app.tar');
    fs.writeFileSync(appLayerFile, app.tar);
    appSize = app.tar.length;
  } else {
    const gz = zlib.gzipSync(app.tar, { level: 9 });
    appLayerFile = path.join(tmp, 'layer-app.tar.gz');
    fs.writeFileSync(appLayerFile, gz);
    appSize = gz.length;
  }
  layers.push({
    file: appLayerFile,
    size: appSize,
    diffId: appDiff,
    blobSize: appSize,
    mediaType: appMediaType,
    isApp: true,
  });
  console.log(
    `      ${app.files.length} 个文件，tar ${(app.tar.length / 1024).toFixed(0)}KB` +
      `${FORMAT === 'docker' ? '' : ` → gz ${(appSize / 1024).toFixed(0)}KB`}`
  );

  // 5) config
  console.log('[5/7] 组装 config');
  const created = new Date().toISOString();
  const cfg = {
    created,
    architecture: baseCfg.architecture,
    os: baseCfg.os,
    config: {
      ...baseCfg.config,
      Env: [
        ...(baseCfg.config.Env || []),
        'NODE_ENV=production',
        'MYLF_DATA_DIR=/data',
        'MYLF_HTTP_PORT=3458',
        'MYLF_HTTP_HOST=0.0.0.0',
      ],
      WorkingDir: '/app',
      Entrypoint: ['/usr/local/bin/docker-entrypoint.sh'],
      Cmd: ['node', '--no-warnings', 'server-http.js'],
      ExposedPorts: { '3458/tcp': {} },
      Volumes: { '/data': {} },
      Healthcheck: {
        Test: [
          'CMD',
          'node',
          '-e',
          "fetch('http://127.0.0.1:'+(process.env.MYLF_HTTP_PORT||3458)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
        ],
        Interval: 30000000000,
        Timeout: 5000000000,
        StartPeriod: 10000000000,
        Retries: 3,
      },
      Labels: {
        ...(baseCfg.config.Labels || {}),
        'org.opencontainers.image.title': 'mylife-finance-mcp',
        'org.opencontainers.image.version': pkg.version,
        'org.opencontainers.image.description': pkg.description,
      },
    },
    rootfs: { type: 'layers', diff_ids: layers.map((l) => `sha256:${l.diffId}`) },
    history: [
      ...(baseCfg.history || []),
      { created, created_by: `COPY app/ /app/  (${app.files.length} files)`, comment: `mylife-finance-mcp ${pkg.version}` },
    ],
  };
  const cfgBuf = Buffer.from(JSON.stringify(cfg));
  const cfgDigest = sha256(cfgBuf);
  const chainIds = computeChainIds(layers.map((l) => l.diffId));
  console.log(`      config sha256:${cfgDigest.slice(0, 19)}…  diff_ids ${cfg.rootfs.diff_ids.length} 个`);

  // 6) 写归档
  const outDir = path.join(ROOT, 'dist');
  fs.mkdirSync(outDir, { recursive: true });
  const safeName = TAG.replace(/[^A-Za-z0-9._-]+/g, '_').replace(':', '-');
  const suffix = FORMAT === 'docker' ? '' : '-oci';
  const outFile = path.join(outDir, `${safeName}-${PLATFORM.replace('/', '-')}${suffix}.tar`);

  const w = createTarWriter(outFile);
  const repoPath = TAG.includes('/') ? TAG.slice(0, TAG.lastIndexOf(':')) : TAG.split(':')[0];
  const repoTag = TAG.slice(TAG.lastIndexOf(':') + 1);
  // OCI 模式下层 blob 以 gzip 内容的 sha256 命名，先各算一次，避免重复读盘
  const blobDigests = FORMAT === 'oci' ? await Promise.all(layers.map((l) => hashFile(l.file))) : null;

  if (FORMAT === 'docker') {
    console.log('[6/7] 写入 Docker Archive');
    // 顺序对齐真 docker save：先层目录、再 config、最后 manifest.json / repositories
    for (let i = 0; i < layers.length; i++) {
      const l = layers[i];
      const dir = chainIds[i];
      const legacy = {
        id: dir,
        ...(i > 0 ? { parent: chainIds[i - 1] } : {}),
        created,
        os: cfg.os,
        architecture: cfg.architecture,
      };
      await w.file(`${dir}/VERSION`, Buffer.from('1.0'));
      await w.file(`${dir}/json`, Buffer.from(JSON.stringify(legacy)));
      await w.fileFromDisk(`${dir}/layer.tar`, l.file, l.size);
      console.log(`      ${dir.slice(0, 12)}…/layer.tar  ${(l.size / 1048576).toFixed(1)}MB`);
    }
    await w.file(`${cfgDigest}.json`, cfgBuf);
    await w.file(
      'manifest.json',
      Buffer.from(
        JSON.stringify([
          {
            Config: `${cfgDigest}.json`,
            RepoTags: [TAG],
            Layers: chainIds.map((id) => `${id}/layer.tar`),
          },
        ])
      )
    );
    await w.file(
      'repositories',
      Buffer.from(JSON.stringify({ [repoPath]: { [repoTag]: chainIds[chainIds.length - 1] } }))
    );
  } else {
    console.log('[6/7] 写入 OCI Image Layout');
    const newManifest = {
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: `sha256:${cfgDigest}`, size: cfgBuf.length },
      layers: layers.map((l, i) => ({ mediaType: l.mediaType, digest: `sha256:${blobDigests[i]}`, size: l.size })),
    };
    const manBuf = Buffer.from(JSON.stringify(newManifest));
    const manDigest = sha256(manBuf);
    const index = {
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.index.v1+json',
      manifests: [
        {
          mediaType: 'application/vnd.oci.image.manifest.v1+json',
          digest: `sha256:${manDigest}`,
          size: manBuf.length,
          platform: { architecture: cfg.architecture, os: cfg.os },
          annotations: {
            'org.opencontainers.image.ref.name': TAG,
            'io.containerd.image.name': TAG.includes('/') ? TAG : `docker.io/${TAG}`,
          },
        },
      ],
    };
    await w.file('oci-layout', Buffer.from('{"imageLayoutVersion":"1.0.0"}'));
    await w.file('index.json', Buffer.from(JSON.stringify(index)));
    await w.file(`blobs/sha256/${cfgDigest}`, cfgBuf);
    await w.file(`blobs/sha256/${manDigest}`, manBuf);
    for (let i = 0; i < layers.length; i++) {
      await w.fileFromDisk(`blobs/sha256/${blobDigests[i]}`, layers[i].file, layers[i].size);
    }
  }
  await w.close();

  const outSize = fs.statSync(outFile).size;
  console.log(`      产物 ${path.relative(ROOT, outFile)}  ${(outSize / 1048576).toFixed(1)}MB`);

  // 7) 校验：重读归档并按目标格式的硬性要求逐项检查
  console.log('\n=== 结构校验 ===');
  const { entries } = await scanTar(outFile);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const problems = [];

  if (FORMAT === 'docker') {
    const manEntry = byName.get('manifest.json');
    if (!manEntry) throw new Error('缺少根目录 manifest.json —— 这正是对方报「格式不正确」的直接原因');
    const man = JSON.parse((await readEntry(outFile, manEntry)).toString('utf8'));
    if (!Array.isArray(man) || !man[0] || !man[0].Config || !Array.isArray(man[0].Layers)) {
      throw new Error('manifest.json 结构不符合 docker save 规范');
    }
    const item = man[0];
    if (!item.RepoTags || !item.RepoTags.includes(TAG)) problems.push(`RepoTags 未含 ${TAG}`);
    if (item.Layers.length !== cfg.rootfs.diff_ids.length) problems.push('manifest 层数与 config diff_ids 不一致');

    // config
    const cfgEntry = byName.get(item.Config);
    if (!cfgEntry) throw new Error(`manifest 指向的 config ${item.Config} 不存在`);
    const cfgRead = JSON.parse((await readEntry(outFile, cfgEntry)).toString('utf8'));
    const cfgHashOk = (await hashEntry(outFile, cfgEntry)) === cfgDigest;
    if (!cfgHashOk) problems.push('config 文件名与内容 sha256 不一致');
    if (cfgRead.rootfs.diff_ids.length !== layers.length) problems.push('config diff_ids 数量异常');
    console.log(`  manifest.json 存在，RepoTags=${JSON.stringify(item.RepoTags)}，Layers ${item.Layers.length} 条`);
    console.log(`  config ${item.Config.slice(0, 12)}… sha256 ${cfgHashOk ? '匹配' : '不匹配'}，arch=${cfgRead.architecture} os=${cfgRead.os}`);

    // 逐层：路径形如 <id>/layer.tar、有 VERSION、内容是未压缩 tar、sha256 == diff_id
    for (let i = 0; i < item.Layers.length; i++) {
      const p = item.Layers[i];
      if (!/^[0-9a-f]{64}\/layer\.tar$/.test(p)) problems.push(`层路径不合 docker save 规范：${p}`);
      const e = byName.get(p);
      if (!e) {
        problems.push(`层文件缺失：${p}`);
        continue;
      }
      const ver = byName.get(`${p.split('/')[0]}/VERSION`);
      if (!ver || (await readEntry(outFile, ver)).toString().trim() !== '1.0') problems.push(`层 ${p} 的 VERSION 缺失或不为 1.0`);
      const got = await hashEntry(outFile, e);
      const want = cfgRead.rootfs.diff_ids[i].replace('sha256:', '');
      if (got !== want) problems.push(`层 ${i + 1} content sha256 与 diff_id 不符`);
      const head = await (async () => {
        const fh = await fsp.open(outFile, 'r');
        try {
          const b = Buffer.alloc(2);
          await fh.read(b, 0, 2, e.start);
          return b;
        } finally {
          await fh.close();
        }
      })();
      if (head[0] === 0x1f && head[1] === 0x8b) problems.push(`层 ${i + 1} 是 gzip，docker save 要求未压缩 layer.tar`);
      console.log(`  层${i + 1} ${p.slice(0, 12)}…/layer.tar ${(e.size / 1048576).toFixed(1)}MB 未压缩 ✓  diff_id ✓`);
    }

    // repositories
    const repoEntry = byName.get('repositories');
    if (!repoEntry) problems.push('缺少 repositories');
    else {
      const r = JSON.parse((await readEntry(outFile, repoEntry)).toString('utf8'));
      if (r[repoPath]?.[repoTag] !== chainIds[chainIds.length - 1]) problems.push('repositories 指向的顶层 layer id 不一致');
    }
    const stray = entries.filter((e) => e.name.startsWith('blobs/') || e.name === 'index.json' || e.name === 'oci-layout');
    if (stray.length) problems.push(`混入了 OCI 专有条目：${stray.map((s) => s.name).join(', ')}`);
  } else {
    const idxEntry = byName.get('index.json');
    if (!idxEntry) throw new Error('缺少 index.json');
    const idx = JSON.parse((await readEntry(outFile, idxEntry)).toString('utf8'));
    let blobs = 0;
    for (const e of entries.filter((x) => x.name.startsWith('blobs/sha256/'))) {
      const want = e.name.slice('blobs/sha256/'.length);
      if ((await hashEntry(outFile, e)) !== want) problems.push(`blob 校验失败：${e.name}`);
      blobs++;
    }
    console.log(`  index.json manifests ${idx.manifests.length} 条，blob 校验通过 ${blobs} 个`);
  }

  // 应用层内容复核（两种格式都要过）。路径显式推导，不靠"最后一个 blob"这类顺序假设。
  const appLayerEntryName =
    FORMAT === 'docker'
      ? `${chainIds[chainIds.length - 1]}/layer.tar`
      : `blobs/sha256/${blobDigests[blobDigests.length - 1]}`;
  const appEntry = byName.get(appLayerEntryName);
  if (!appEntry) throw new Error(`应用层条目未按预期出现：${appLayerEntryName}`);
  const appRaw = await readEntry(outFile, appEntry);
  const appPlain = appRaw[0] === 0x1f && appRaw[1] === 0x8b ? zlib.gunzipSync(appRaw) : appRaw;
  const appNames = [];
  let q = 0;
  while (q + 512 <= appPlain.length) {
    const h = appPlain.subarray(q, q + 512);
    if (h.every((b) => b === 0)) break;
    const name = h.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const size = parseInt(h.toString('ascii', 124, 136).replace(/\0.*$/, '').trim(), 8) || 0;
    const mode = parseInt(h.toString('ascii', 100, 108).replace(/\0.*$/, '').trim(), 8);
    appNames.push({ name, size, mode });
    q += 512 + size + pad512(size);
  }
  const entrySh = appNames.find((x) => x.name === 'usr/local/bin/docker-entrypoint.sh');
  const hasServer = appNames.some((x) => x.name === 'app/server-http.js');
  if (!entrySh) problems.push('应用层缺少 /usr/local/bin/docker-entrypoint.sh');
  else if (entrySh.mode !== 0o755) problems.push(`入口脚本 mode=${entrySh.mode.toString(8)}，应为 755`);
  if (!hasServer) problems.push('应用层缺少 app/server-http.js');
  console.log(`  应用层 ${appNames.length} 条，入口脚本 mode=${entrySh ? entrySh.mode.toString(8) : '缺失'}，server-http.js ${hasServer ? '在' : '缺失'}`);

  await fsp.rm(tmp, { recursive: true, force: true });

  if (problems.length) {
    console.log('\n❌ 校验未通过：');
    for (const p of problems) console.log(`   - ${p}`);
    process.exit(1);
  }
  console.log('\n✅ 全部校验通过（未压缩层 · diff_id 逐层匹配 · manifest/repositories 一致）');

  // 附加：gzip 包。内容仍是 Docker Archive，只是外层压缩；docker load 与
  // Container Station 都能直接吃 .tar.gz，体积约为 tar 的 1/3，网页上传更稳。
  let gzFile = null;
  if (has('--gzip')) {
    gzFile = `${outFile}.gz`;
    await pipeline(fs.createReadStream(outFile), zlib.createGzip({ level: 6 }), fs.createWriteStream(gzFile));
    const fh = await fsp.open(gzFile, 'r');
    try {
      const { size: gzSize } = await fh.stat();
      const head = Buffer.alloc(2);
      await fh.read(head, 0, 2, 0);
      const tail = Buffer.alloc(4);
      await fh.read(tail, 0, 4, gzSize - 4);
      const isize = tail.readUInt32LE(0);
      const expect = fs.statSync(outFile).size >>> 0;
      const gzipOk = head[0] === 0x1f && head[1] === 0x8b && isize === expect;
      console.log(`\n[附加] ${path.basename(gzFile)}  ${(gzSize / 1048576).toFixed(1)}MB  gzip 头 ${gzipOk ? '✓' : '✗'} ISIZE ${isize} ${gzipOk ? '= tar 长度' : `≠ ${expect}`}`);
      if (!gzipOk) throw new Error('gzip 包校验失败');
    } finally {
      await fh.close();
    }
  }

  console.log(`\n目标机器上执行：docker load -i ${path.basename(gzFile || outFile)}`);
  console.log(`然后：docker run -d --name mylife-finance-mcp -p 3458:3458 -v mylife-finance-data:/data ${TAG}`);
  console.log(`\nNAS「导入镜像」若是按 CPU 架构挑选，务必确认目标机架构与此包一致：${PLATFORM}`);
}

main().catch((e) => {
  console.error('\n失败：' + (e && e.message ? e.message : e));
  if (process.env.MYLF_DEBUG) console.error(e);
  process.exit(1);
});
