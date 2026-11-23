'use strict';
/*
 * 审计日志（NDJSON，一行一条事件）—— 零依赖、尽力而为
 *
 * 为什么要有：多用户共用一个 NAS 时，出了问题（"谁把我账删了""谁在半夜登我号"）
 * 光看 users.json 是查不出来的。这里只记「谁、什么时候、从哪个 IP、做了什么」，
 * 不记密码、不记 token 明文、不记业务数据。
 *
 * 设计要点：
 * 1. 单文件 audit.log，超过 1MB 滚动到 audit.log.1（只留一代，避免占满容器卷）。
 * 2. 写失败一律吞掉 —— 审计不能反过来把服务搞挂。
 * 3. detail 只保留标量，且长度截断；键名像密码/token 的一律打码。
 */
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('./db');

const AUDIT_FILE = path.join(DATA_DIR, 'audit.log');
const MAX_BYTES = 1024 * 1024;
const MAX_DETAIL = 200;
const SECRET_KEY = /pass|pwd|token|secret|cookie|authorization/i;

function scalar(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  return String(v).slice(0, MAX_DETAIL);
}

function scrub(detail) {
  if (!detail || typeof detail !== 'object') return null;
  const out = {};
  for (const k of Object.keys(detail)) {
    if (SECRET_KEY.test(k)) {
      out[k] = '***';
      continue;
    }
    const v = detail[k];
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      out[k] = v.slice(0, 10).map(scalar);
      continue;
    }
    if (v && typeof v === 'object') continue;
    out[k] = scalar(v);
  }
  return Object.keys(out).length ? out : null;
}

function rotateIfNeeded(nextLen) {
  try {
    const st = fs.statSync(AUDIT_FILE);
    if (st.size + nextLen <= MAX_BYTES) return;
    const old = AUDIT_FILE + '.1';
    try {
      fs.rmSync(old, { force: true });
    } catch {
      /* Windows 上偶尔删不掉，忽略 */
    }
    fs.renameSync(AUDIT_FILE, old);
  } catch {
    /* 文件不存在 = 首次写，无需滚动 */
  }
}

function clientIp(req) {
  // 容器里 remoteAddress 往往是 docker 网关地址；若前置了反代，X-Forwarded-For 才有意义。
  // 只取第一段，且不做信任判断 —— 审计是给人看的线索，不是授权依据。
  const xff = (req && req.headers && req.headers['x-forwarded-for']) || '';
  if (xff) {
    const first = String(xff).split(',')[0].trim();
    if (first) return first.slice(0, 48);
  }
  return ((req && req.socket && req.socket.remoteAddress) || 'unknown').slice(0, 48);
}

/**
 * 记一条事件。
 * @param {string} event 形如 'login.ok' / 'login.fail' / 'admin.user.create'
 * @param {object} o { req, userId, detail }
 */
function log(event, o) {
  const opt = o || {};
  const rec = {
    t: new Date().toISOString(),
    ev: String(event || '').slice(0, 48),
    userId: opt.userId === undefined || opt.userId === null ? null : String(opt.userId).slice(0, 64),
    ip: opt.req ? clientIp(opt.req) : opt.ip ? String(opt.ip).slice(0, 48) : null,
  };
  const d = scrub(opt.detail);
  if (d) rec.detail = d;

  const line = JSON.stringify(rec) + '\n';
  try {
    rotateIfNeeded(Buffer.byteLength(line));
    fs.appendFileSync(AUDIT_FILE, line, { mode: 0o600 });
  } catch {
    /* 审计失败不影响主流程 */
  }
  return rec;
}

/**
 * 最近 n 条（新的在前）。文件被滚动时只能看到当前这一代，可接受。
 */
function tail(n) {
  const limit = Math.max(1, Math.min(500, Number(n) || 50));
  let raw = '';
  try {
    raw = fs.readFileSync(AUDIT_FILE, 'utf8');
  } catch {
    return [];
  }
  const lines = raw.split('\n');
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const s = lines[i].trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      /* 断电写坏的行直接跳过 */
    }
  }
  return out;
}

function clear() {
  try {
    fs.rmSync(AUDIT_FILE, { force: true });
    fs.rmSync(AUDIT_FILE + '.1', { force: true });
  } catch {
    return false;
  }
  return true;
}

module.exports = { log, tail, clear, clientIp, AUDIT_FILE };
