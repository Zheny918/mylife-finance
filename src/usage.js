'use strict';
/*
 * 使用痕迹（lastLoginAt / lastTokenAt / lastIp）—— 和凭据分文件存放
 *
 * 为什么不塞进 users.json：
 *   MCP token 每次工具调用都会「被使用」，而 users.json 是 read-modify-write 整个覆盖。
 *   把高频写混进凭据文件，既会放大并发写丢数据的面，又会在一次坏写里连带弄坏密码哈希。
 *   所以凭据归 users.json（低频、必须可靠），使用痕迹归 usage.json（高频、丢了不致命）。
 *
 * 节流：内存累加，最多 30s 落一次盘；进程退出时 flush。
 */
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('./db');

const USAGE_FILE = path.join(DATA_DIR, 'usage.json');
const FLUSH_MS = 30 * 1000;

let cache = null;
let dirty = false;
let timer = null;

function nowIso() {
  return new Date().toISOString();
}

function load() {
  if (cache) return cache;
  try {
    const d = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
    cache = d && typeof d === 'object' && d.users && typeof d.users === 'object' ? d : { version: 1, users: {} };
  } catch {
    cache = { version: 1, users: {} };
  }
  return cache;
}

function flush() {
  if (!dirty || !cache) return;
  dirty = false;
  const tmp = USAGE_FILE + '.tmp';
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, USAGE_FILE);
  } catch {
    dirty = true; // 下次再试
  }
}

function schedule() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    flush();
  }, FLUSH_MS);
  if (timer.unref) timer.unref();
}

function entry(userId) {
  const d = load();
  if (!d.users[userId]) d.users[userId] = {};
  return d.users[userId];
}

/**
 * @param {string} userId
 * @param {'login'|'token'|'web'} field login = 密码登录成功；token = MCP token 被使用；web = 浏览器带会话访问
 * @param {string} ip
 */
function mark(userId, field, ip) {
  if (!userId) return;
  try {
    const e = entry(String(userId));
    const t = nowIso();
    if (field === 'login') e.lastLoginAt = t;
    else if (field === 'token') e.lastTokenAt = t;
    else e.lastWebAt = t;
    if (ip) e.lastIp = String(ip).slice(0, 48);
    dirty = true;
    if (field === 'login') flush();
    else schedule();
  } catch {
    /* 痕迹记录失败不影响鉴权 */
  }
}

function get(userId) {
  return load().users[String(userId)] || {};
}

function all() {
  const copy = {};
  for (const k of Object.keys(load().users)) copy[k] = { ...load().users[k] };
  return copy;
}

/** 删除账号时一并清掉痕迹，避免同名重建后「最近登录」还挂着前一个人的时间 */
function forget(userId) {
  const d = load();
  if (d.users[userId]) {
    delete d.users[userId];
    dirty = true;
    flush();
  }
}

for (const sig of ['SIGINT', 'SIGTERM', 'beforeExit']) {
  process.on(sig, () => {
    try {
      flush();
    } catch {
      /* ignore */
    }
  });
}

module.exports = { mark, get, all, forget, flush, USAGE_FILE };
