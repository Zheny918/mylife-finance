'use strict';
/*
 * 账号 / 会话 / 每用户 MCP token —— 零依赖（node:crypto + JSON 文件）
 *
 * 设计要点（改之前先读）：
 * 1. 身份只认服务端签发的凭据，**不认任何客户端自称**。
 *    - 浏览器：HttpOnly 会话 cookie（HMAC-SHA256 签名，payload 里带 userId 与过期时间）
 *    - MCP 客户端：Bearer token，落库为 sha256，且**绑定唯一 userId**
 * 2. 存储用 DATA_DIR/users.json，请求时读文件 ⇒ 加人/改密/停用**不需要重启容器**。
 * 3. 密码 scrypt（N=16384,r=8,p=1），存 `scrypt$N$r$p$salt$hash`；比对用 timingSafeEqual。
 * 4. 每用户一个独立 MCP token，明文只在创建/轮换时返回一次，库内只存 sha256。
 * 5. 最后一个管理员不允许停用或删除，避免把自己锁在门外。
 * 6. ★ 删账号留「墓碑」（retired）。业务数据按 user_id 存在 SQLite 里，删掉账号并不会
 *    带走账本；如果允许同名直接重建，新账号会在第一次 ensureTenant 时**接管前一个人的
 *    全部账单** —— 这是一个真实的串号风险。所以默认拒绝复用已删除的用户名，
 *    只有显式 reclaim（确认是同一人）或「连数据一起删」（purge，清库后不留墓碑）才放行。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DATA_DIR } = require('./db');

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SECRET_FILE = path.join(DATA_DIR, 'session.key');
const ADMIN_PW_FILE = path.join(DATA_DIR, 'ADMIN-PASSWORD.txt');

const SESSION_COOKIE = 'mylf_sid';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const USER_ID_RE = /^[A-Za-z0-9._\u4e00-\u9fa5_-]{1,64}$/;
// 用户名会作为 URL 路径段与看板文件名，只允许这些字符（与 server-http 保持一致）
const MIN_PASSWORD = 8;

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

/* ---------------------------------------------------------------- 基础工具 */

function sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(pw, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${dk.toString('base64')}`;
}

function verifyPassword(pw, stored) {
  if (typeof stored !== 'string' || typeof pw !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!N || !r || !p) return false;
  let salt;
  let want;
  try {
    salt = Buffer.from(parts[4], 'base64');
    want = Buffer.from(parts[5], 'base64');
  } catch {
    return false;
  }
  let got;
  try {
    got = crypto.scryptSync(pw, salt, want.length, { N, r, p });
  } catch {
    return false;
  }
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function randomToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function nowIso() {
  return new Date().toISOString();
}

/* ---------------------------------------------------------------- 存储 */

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  try {
    const raw = fs.readFileSync(USERS_FILE, 'utf8');
    const d = JSON.parse(raw);
    if (!d || typeof d !== 'object' || !d.users || typeof d.users !== 'object') {
      return { version: 2, users: {}, retired: {} };
    }
    if (!d.retired || typeof d.retired !== 'object') d.retired = {};
    return d;
  } catch {
    return { version: 2, users: {}, retired: {} };
  }
}

function save(data) {
  ensureDir();
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, USERS_FILE);
  try {
    fs.chmodSync(USERS_FILE, 0o600);
  } catch {
    /* Windows 上 chmod 语义有限，失败不影响功能 */
  }
}

function publicUser(u) {
  return {
    userId: u.userId,
    label: u.label || '',
    role: u.role === 'admin' ? 'admin' : 'member',
    disabled: !!u.disabled,
    mustChange: !!u.mustChange,
    createdAt: u.createdAt || null,
    updatedAt: u.updatedAt || null,
    hasToken: !!u.tokenHash,
  };
}

function listUsers() {
  const d = load();
  return Object.values(d.users)
    .map(publicUser)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

function getUserRecord(userId) {
  const d = load();
  return d.users[userId] || null;
}

function getUser(userId) {
  const u = getUserRecord(userId);
  return u ? publicUser(u) : null;
}

function assertUserId(userId) {
  if (typeof userId !== 'string' || !USER_ID_RE.test(userId)) {
    throw new Error('用户名不合法（仅允许字母数字 . _ - 与中文，1-64 位）');
  }
}

function assertPassword(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) {
    throw new Error(`密码至少 ${MIN_PASSWORD} 位`);
  }
}

function countAdmins(d) {
  return Object.values(d.users).filter((u) => u.role === 'admin' && !u.disabled).length;
}

/* ---------------------------------------------------------------- 用户增删改 */

/** 返回 { user, token }，token 明文只在这里出现一次 */
function createUser(opts) {
  const o = opts || {};
  const userId = String(o.userId || '').trim();
  assertUserId(userId);
  assertPassword(o.password);

  const d = load();
  if (d.users[userId]) throw new Error(`用户已存在：${userId}`);

  // ★ 已删除的用户名：其账本数据仍在库里，直接重建 = 新人接管旧账。
  const grave = d.retired[userId];
  if (grave && !o.reclaim) {
    throw new Error(
      `用户名「${userId}」曾被删除（${String(grave.at || '').slice(0, 10)}），其账本数据仍保留在库中。` +
        '为避免新人看到旧账，默认不允许复用。若确属同一人，请勾选「接管旧账」；否则换一个用户名。'
    );
  }

  const token = randomToken();
  const rec = {
    userId,
    label: String(o.label || '').slice(0, 64),
    role: o.role === 'admin' ? 'admin' : 'member',
    passwordHash: hashPassword(o.password),
    tokenHash: sha256(token),
    disabled: false,
    mustChange: !!o.mustChange,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  d.users[userId] = rec;
  if (grave) delete d.retired[userId];
  save(d);
  return { user: publicUser(rec), token, reclaimed: !!grave };
}

function setPassword(userId, password, opts) {
  const o = opts || {};
  assertPassword(password);
  const d = load();
  const u = d.users[userId];
  if (!u) throw new Error(`用户不存在：${userId}`);
  u.passwordHash = hashPassword(password);
  u.mustChange = !!o.mustChange;
  u.updatedAt = nowIso();
  // 改密后旧会话仍然有效（会话签名不含密码版本），这里主动作废：写入 pwVersion
  u.pwVersion = (u.pwVersion || 0) + 1;
  save(d);
  return publicUser(u);
}

function setRole(userId, role) {
  const d = load();
  const u = d.users[userId];
  if (!u) throw new Error(`用户不存在：${userId}`);
  const next = role === 'admin' ? 'admin' : 'member';
  if (u.role === 'admin' && next !== 'admin' && countAdmins(d) <= 1) {
    throw new Error('这是最后一个管理员，不能降级');
  }
  u.role = next;
  u.updatedAt = nowIso();
  save(d);
  return publicUser(u);
}

function setDisabled(userId, disabled) {
  const d = load();
  const u = d.users[userId];
  if (!u) throw new Error(`用户不存在：${userId}`);
  if (disabled && u.role === 'admin' && countAdmins(d) <= 1) {
    throw new Error('这是最后一个管理员，不能停用');
  }
  u.disabled = !!disabled;
  u.updatedAt = nowIso();
  save(d);
  return publicUser(u);
}

/**
 * 删除前预检。与 deleteUser 用同一套规则，但**无副作用** ——
 * 让调用方可以在「清空数据」这种不可逆动作之前就先确认账号确实删得掉。
 */
function canDelete(userId) {
  const d = load();
  const u = d.users[userId];
  if (!u) return { ok: false, error: `用户不存在：${userId}` };
  if (u.role === 'admin' && countAdmins(d) <= 1) {
    return { ok: false, error: '这是最后一个管理员，不能删除' };
  }
  return { ok: true };
}

/**
 * 删账号。默认留墓碑（retired），防止同名重建接管旧账。
 * @param {object} opts { forget: true } —— 账本数据已被清空，无需墓碑
 * @returns {{ userId: string, retired: boolean }}
 */
function deleteUser(userId, opts) {
  const o = opts || {};
  const d = load();
  const u = d.users[userId];
  if (!u) throw new Error(`用户不存在：${userId}`);
  if (u.role === 'admin' && countAdmins(d) <= 1) {
    throw new Error('这是最后一个管理员，不能删除');
  }
  delete d.users[userId];
  if (o.forget) {
    delete d.retired[userId];
  } else {
    d.retired[userId] = { at: nowIso(), label: u.label || '', role: u.role };
  }
  save(d);
  return { userId, retired: !o.forget };
}

/** 让该用户在所有设备上的会话立即失效（不改密码）。调用方负责给当前设备换发新 cookie */
function bumpSessions(userId) {
  const d = load();
  const u = d.users[userId];
  if (!u) throw new Error(`用户不存在：${userId}`);
  u.pwVersion = (u.pwVersion || 0) + 1;
  u.updatedAt = nowIso();
  save(d);
  return publicUser(u);
}

/** 已删除但账本数据仍在的用户名（管理页用来提示「这个不能直接重建」） */
function listRetired() {
  const d = load();
  return Object.keys(d.retired)
    .sort()
    .map((k) => ({ userId: k, at: d.retired[k].at || null, label: d.retired[k].label || '' }));
}

function isRetired(userId) {
  const d = load();
  return !!d.retired[String(userId || '')];
}

/** 轮换 MCP token，返回新明文（只此一次）。旧 token 立即失效 */
function rotateToken(userId) {
  const d = load();
  const u = d.users[userId];
  if (!u) throw new Error(`用户不存在：${userId}`);
  const token = randomToken();
  u.tokenHash = sha256(token);
  u.updatedAt = nowIso();
  save(d);
  return { user: publicUser(u), token };
}

/* ---------------------------------------------------------------- 凭据校验 */

/** 密码登录：成功返回 publicUser，失败 null */
function authenticate(userId, password) {
  const u = getUserRecord(userId);
  if (!u || u.disabled) return null;
  if (!verifyPassword(String(password || ''), u.passwordHash)) return null;
  return publicUser(u);
}

/** Bearer token → userId；找不到/已停用返回 null */
function resolveToken(token) {
  if (typeof token !== 'string' || token.length < 16) return null;
  const want = Buffer.from(sha256(token), 'hex');
  const d = load();
  for (const u of Object.values(d.users)) {
    if (!u.tokenHash || u.disabled) continue;
    let got;
    try {
      got = Buffer.from(u.tokenHash, 'hex');
    } catch {
      continue;
    }
    if (got.length === want.length && crypto.timingSafeEqual(got, want)) return u.userId;
  }
  return null;
}

/* ---------------------------------------------------------------- 会话 */

let cachedSecret = null;

function sessionSecret() {
  const fromEnv = process.env.MYLF_SESSION_SECRET;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  if (cachedSecret) return cachedSecret;
  try {
    const s = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    if (s.length >= 16) {
      cachedSecret = s;
      return s;
    }
  } catch {
    /* 首次运行，下面生成 */
  }
  const s = crypto.randomBytes(32).toString('hex');
  ensureDir();
  try {
    fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 });
  } catch {
    /* 写不进去也继续用内存里的，只是重启后会话失效 */
  }
  cachedSecret = s;
  return s;
}

function sign(payload) {
  return crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
}

function issueSession(userOrId) {
  const userId = typeof userOrId === 'string' ? userOrId : userOrId && userOrId.userId;
  if (!userId) throw new Error('issueSession 需要 userId');
  // pwVersion 只在库内：改密后旧会话立即失效（对外不下发该字段）
  const rec = getUserRecord(userId);
  const v = rec ? Number(rec.pwVersion || 0) : 0;
  const payload = Buffer.from(
    JSON.stringify({ u: userId, v, exp: Date.now() + SESSION_TTL_MS })
  ).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function readSession(value) {
  if (typeof value !== 'string' || value.indexOf('.') < 0) return null;
  const i = value.lastIndexOf('.');
  const payload = value.slice(0, i);
  const sig = value.slice(i + 1);
  const want = Buffer.from(sign(payload), 'utf8');
  const got = Buffer.from(sig, 'utf8');
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;

  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!data || typeof data.u !== 'string' || typeof data.exp !== 'number') return null;
  if (data.exp < Date.now()) return null;

  const u = getUserRecord(data.u);
  if (!u || u.disabled) return null;
  // 改密后旧会话作废
  if (Number(data.v || 0) !== Number(u.pwVersion || 0)) return null;
  return publicUser(u);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    const v = part.slice(i + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function sessionFromRequest(req) {
  const cookies = parseCookies(req.headers && req.headers.cookie);
  return readSession(cookies[SESSION_COOKIE]);
}

/*
 * Cookie 属性。服务默认是明文 HTTP（3458），此时不能带 Secure —— 带了浏览器直接不收，
 * 表现为「登录成功但一刷新又退回登录页」。若你在前面挂了 HTTPS 反代
 * （例如 mylife-https 那套 8443 → 3458），请设 MYLF_COOKIE_SECURE=1 把 Secure 补上。
 */
function cookieFlags() {
  const secure = /^(1|true|yes|on)$/i.test(String(process.env.MYLF_COOKIE_SECURE || ''));
  return `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

function sessionCookie(userOrId) {
  return `${SESSION_COOKIE}=${encodeURIComponent(issueSession(userOrId))}; ${cookieFlags()}; Max-Age=${Math.floor(
    SESSION_TTL_MS / 1000
  )}`;
}

function clearCookie() {
  return `${SESSION_COOKIE}=; ${cookieFlags()}; Max-Age=0`;
}

/* ---------------------------------------------------------------- 首次引导 */

/**
 * 库内没有任何用户时创建管理员。
 * 优先读 MYLF_ADMIN_USER / MYLF_ADMIN_PASSWORD；未给密码则随机生成并落到
 * DATA_DIR/ADMIN-PASSWORD.txt（含强制改密标记）。
 * 返回 null 表示已有用户、无需引导。
 */
function ensureBootstrap() {
  const d = load();
  if (Object.keys(d.users).length > 0) return null;

  const userId = String(process.env.MYLF_ADMIN_USER || 'admin').trim();
  const given = process.env.MYLF_ADMIN_PASSWORD || '';
  const password = given || crypto.randomBytes(9).toString('base64url');
  const { user } = createUser({
    userId,
    label: '管理员',
    password,
    role: 'admin',
    mustChange: !given,
  });

  if (!given) {
    ensureDir();
    const content = [
      'MyLife 财务工作台 · 初始管理员凭据',
      `用户名: ${userId}`,
      `密码:   ${password}`,
      '',
      '首次登录后请立即修改密码，并删除本文件。',
      `生成时间: ${nowIso()}`,
      '',
    ].join('\n');
    try {
      fs.writeFileSync(ADMIN_PW_FILE, content, { mode: 0o600 });
    } catch {
      /* 写不了文件就把密码留在日志里 */
    }
  }

  return { userId: user.userId, password, generated: !given, file: given ? null : ADMIN_PW_FILE };
}

module.exports = {
  // 路径（CLI / 文档用）
  USERS_FILE,
  SECRET_FILE,
  ADMIN_PW_FILE,
  SESSION_COOKIE,
  MIN_PASSWORD,
  USER_ID_RE,
  // 用户
  listUsers,
  getUser,
  createUser,
  setPassword,
  setRole,
  setDisabled,
  deleteUser,
  canDelete,
  bumpSessions,
  listRetired,
  isRetired,
  rotateToken,
  authenticate,
  resolveToken,
  ensureBootstrap,
  // 会话
  sessionFromRequest,
  sessionCookie,
  clearCookie,
  readSession,
  issueSession,
  parseCookies,
  hashPassword,
  verifyPassword,
};
