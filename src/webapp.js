'use strict';
/*
 * 工作台 Web 界面（静态页 + REST），被两个入口复用，避免逻辑分叉：
 *   workbench.js     本地开发/单机，绑定 127.0.0.1:3457，默认信任单一本地用户
 *   server-http.js   Docker / 远程，挂在与 MCP 同一个端口（默认 3458），必须登录
 *
 * ★ 身份规则（安全边界，改之前先读）
 *   1. **userId 只来自服务端凭据**：会话 cookie（HMAC 签名）或每用户 MCP token。
 *      客户端传来的 x-user-id / ?userId= 一律忽略 —— 这是 1.1.1 及以前的越权根因。
 *   2. 未登录时：`/api/*` 返回 401 JSON，页面 302 到 `/login`。
 *   3. `/admin` 与 `/api/admin/*` 要求 role=admin。
 *
 * 提供的路径：
 *   GET  /login             登录页（已登录则跳回 /）
 *   POST /api/auth/login    用户名 + 密码 → 会话 cookie
 *   POST /api/auth/logout   退出
 *   POST /api/auth/logout-others  踢掉自己在其他设备上的会话（当前设备保留）
 *   GET  /api/auth/me       当前身份
 *   POST /api/auth/password 改自己的密码
 *   GET  /account           我的账号（改密）
 *   GET  /admin             用户管理（管理员）
 *   *    /api/admin/*       用户管理接口（管理员）
 *   GET  /                  工作台界面
 *   GET  /vendor/*          前端依赖
 *   GET  /dashboard.html    当前用户自己的看板快照
 *   *    /api/*             工作台 REST（userId 由本模块注入）
 *
 * ★ 强制改密：mustChange=true 的账号（初始化随机密码 / 管理员重置后的临时密码）
 *   在改密之前只能访问 /account 与 /api/auth/*，其余请求一律 302 到 /account。
 *   否则「待改密」只是个装饰，容器卷里那份 ADMIN-PASSWORD.txt 就能长期当凭据用。
 *
 * handleWeb 返回 true 表示已处理（含 404），false 表示不归它管、交回上层。
 */
const fs = require('node:fs');
const path = require('node:path');
const accounts = require('./accounts');
const audit = require('./audit');
const usage = require('./usage');
const { handleApi } = require('./api');
const { DATA_DIR, purgeUserData, tenantDataCount } = require('./db');
const { DASHBOARD_DIR, dashboardPath } = require('./dashboard');
const T = require('./tools');

const TEMPLATE = path.join(__dirname, 'workbench-template.html');
const LOGIN_TPL = path.join(__dirname, 'login-template.html');
const ACCOUNT_TPL = path.join(__dirname, 'account-template.html');
const ADMIN_TPL = path.join(__dirname, 'admin-template.html');
const VENDOR_DIR = path.join(__dirname, 'vendor');
const DASHBOARD_NAME = 'finance-dashboard.html';

const MIME = {
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const MAX_JSON = 1024 * 1024;

/* ---------------------------------------------------------------- 基础响应 */

// 拼接后必须仍在 base 目录内，挡住 ../ 与绝对路径
function inside(base, rel) {
  if (typeof rel !== 'string' || rel === '') return null;
  const p = path.normalize(path.join(base, rel));
  const prefix = path.normalize(base + path.sep);
  return p.startsWith(prefix) ? p : null;
}

function sendFile(req, res, file, type) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': st.size,
    'Cache-Control': 'no-store',
  });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  fs.createReadStream(file).pipe(res);
  return true;
}

function text(res, code, body, extra) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...(extra || {}) });
  res.end(body);
  return true;
}

function json(res, code, obj, extra) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...(extra || {}),
  });
  res.end(body);
  return true;
}

function redirect(res, to, extra) {
  res.writeHead(302, { Location: to, 'Cache-Control': 'no-store', ...(extra || {}) });
  res.end();
  return true;
}

function readJson(req) {
  return new Promise((resolve) => {
    let data = '';
    let settled = false;
    const finish = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    req.on('data', (c) => {
      data += c;
      if (data.length > MAX_JSON) {
        finish({});
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return finish({});
      try {
        finish(JSON.parse(data));
      } catch {
        finish({});
      }
    });
    req.on('error', () => finish({}));
    req.on('close', () => finish({}));
  });
}

/* ---------------------------------------------------------------- 登录限速 */

// 同一「用户名 + IP」10 分钟内失败 5 次，锁 60 秒。单进程内存，够用且不引依赖。
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const FAIL_LIMIT = 5;
const FAIL_LOCK_MS = 60 * 1000;
const fails = new Map();

function failKey(req, userId) {
  const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
  return `${userId}|${ip}`;
}

function isLocked(key) {
  const e = fails.get(key);
  if (!e) return false;
  if (e.until && e.until > Date.now()) return true;
  if (Date.now() - e.first > FAIL_WINDOW_MS) {
    fails.delete(key);
    return false;
  }
  return false;
}

function noteFail(key) {
  const now = Date.now();
  const e = fails.get(key);
  if (!e || now - e.first > FAIL_WINDOW_MS) {
    fails.set(key, { first: now, n: 1, until: 0 });
    return;
  }
  e.n += 1;
  if (e.n >= FAIL_LIMIT) e.until = now + FAIL_LOCK_MS;
}

function clearFail(key) {
  fails.delete(key);
}

/* ---------------------------------------------------------------- 身份 */

function legacyUserId(token, opts) {
  if (!opts || !opts.legacyToken || typeof token !== 'string') return null;
  const a = Buffer.from(String(token));
  const b = Buffer.from(String(opts.legacyToken));
  if (a.length !== b.length) return null;
  try {
    return require('node:crypto').timingSafeEqual(a, b) ? opts.legacyTokenUser || 'admin' : null;
  } catch {
    return null;
  }
}

function resolveIdentity(req, url, opts) {
  // 本地单机入口：workbench.js 直接注入身份（绑定 127.0.0.1，无登录）
  if (opts && opts.localIdentity) {
    return { userId: opts.localIdentity.userId, role: opts.localIdentity.role || 'admin', via: 'local' };
  }
  const s = accounts.sessionFromRequest(req);
  if (s) return { userId: s.userId, role: s.role, via: 'session', mustChange: s.mustChange };

  const q = url.searchParams.get('token');
  if (q) {
    const userId = accounts.resolveToken(q) || legacyUserId(q, opts);
    if (userId) {
      const u = accounts.getUser(userId);
      if (u && !u.disabled) return { userId: u.userId, role: u.role, via: 'token', mustChange: u.mustChange };
    }
  }
  return null;
}

/* ---------------------------------------------------------------- 用户管理接口 */

function createTenant(userId) {
  try {
    T.userCreate({ name: userId });
  } catch (e) {
    // 账本已存在不算错误；其它异常记下来但不阻断账号创建
    console.error('[webapp] 建租户失败:', e && e.message);
  }
}

async function handleAdmin(req, res, url, me) {
  const p = url.pathname;

  if (me.role !== 'admin') {
    audit.log('admin.denied', { req, userId: me.userId, detail: { method: req.method, path: p } });
    return json(res, 403, { ok: false, error: '只有管理员可以管理用户' });
  }

  if (p === '/api/admin/users' && req.method === 'GET' && url.searchParams.get('stats')) {
    return json(res, 200, { ok: true, stats: tenantDataCount(url.searchParams.get('stats')) });
  }

  if (p === '/api/admin/users' && req.method === 'GET') {
    // 把「最近登录 / token 最近使用」并进来 —— 这两项存在 usage.json，不在凭据文件里
    const use = usage.all();
    const users = accounts.listUsers().map((u) => ({ ...u, usage: use[u.userId] || null }));
    return json(res, 200, { ok: true, users, retired: accounts.listRetired() });
  }

  if (p === '/api/admin/audit' && req.method === 'GET') {
    const n = Number(url.searchParams.get('limit')) || 50;
    return json(res, 200, { ok: true, events: audit.tail(n) });
  }

  if (p === '/api/admin/users' && req.method === 'POST') {
    const body = await readJson(req);
    try {
      const { user, token, reclaimed } = accounts.createUser({
        userId: body.userId,
        label: body.label,
        password: body.password,
        role: body.role,
        mustChange: !!body.mustChange,
        reclaim: !!body.reclaim,
      });
      createTenant(user.userId);
      audit.log('admin.user.create', {
        req,
        userId: me.userId,
        detail: { target: user.userId, role: user.role, reclaimed: !!reclaimed },
      });
      return json(res, 200, { ok: true, user, token, reclaimed: !!reclaimed });
    } catch (e) {
      return json(res, 400, { ok: false, error: e.message });
    }
  }

  const m = /^\/api\/admin\/users\/([^/]+)(?:\/(password|token|disabled))?$/.exec(p);
  if (!m) return json(res, 404, { ok: false, error: '未找到接口: ' + req.method + ' ' + p });

  let userId;
  try {
    userId = decodeURIComponent(m[1]);
  } catch {
    return json(res, 400, { ok: false, error: '用户名编码错误' });
  }
  const action = m[2];

  try {
    if (req.method === 'POST' && action === 'password') {
      const body = await readJson(req);
      const user = accounts.setPassword(userId, body.password, { mustChange: !!body.mustChange });
      audit.log('admin.password.reset', { req, userId: me.userId, detail: { target: userId } });
      return json(res, 200, { ok: true, user });
    }
    if (req.method === 'POST' && action === 'token') {
      const { user, token } = accounts.rotateToken(userId);
      audit.log('admin.token.rotate', { req, userId: me.userId, detail: { target: userId } });
      return json(res, 200, { ok: true, user, token });
    }
    if (req.method === 'POST' && action === 'disabled') {
      const body = await readJson(req);
      const user = accounts.setDisabled(userId, !!body.disabled);
      audit.log('admin.user.disabled', {
        req,
        userId: me.userId,
        detail: { target: userId, disabled: !!body.disabled },
      });
      return json(res, 200, { ok: true, user });
    }
    if (req.method === 'DELETE' && !action) {
      if (userId === me.userId) {
        return json(res, 400, { ok: false, error: '不能删除当前登录的账号' });
      }
      if (!url.searchParams.has('purge')) {
        return json(res, 400, {
          ok: false,
          error: '请明确指定 purge=0（只删账号，保留账本）或 purge=1（连账本一起删）',
          stats: tenantDataCount(userId),
        });
      }
      const purge = /^(1|true|yes)$/i.test(String(url.searchParams.get('purge') || ''));
      const pre = accounts.canDelete(userId);
      if (!pre.ok) return json(res, 400, { ok: false, error: pre.error });

      // 先清数据（事务，失败则账号未动），再删账号。顺序不能反：
      // 反过来的话「清数据失败」会留下一个删不掉的空壳账号。
      let counts = null;
      if (purge) counts = purgeUserData(userId);
      const del = accounts.deleteUser(userId, { forget: purge });
      usage.forget(userId);
      try {
        fs.rmSync(path.join(DASHBOARD_DIR, userId + '.html'), { force: true });
      } catch {
        /* 看板文件删不掉不影响账号删除 */
      }
      audit.log('admin.user.delete', {
        req,
        userId: me.userId,
        detail: { target: userId, purge, counts },
      });
      return json(res, 200, { ok: true, ...del, purged: counts });
    }
  } catch (e) {
    return json(res, 400, { ok: false, error: e.message });
  }
  return json(res, 405, { ok: false, error: '不支持的方法: ' + req.method });
}

/* ---------------------------------------------------------------- 自助接口 */

async function handleAuth(req, res, url, me, opts) {
  const p = url.pathname;

  if (p === '/api/auth/login' && req.method === 'POST') {
    const body = await readJson(req);
    const userId = String(body.userId || '').trim();
    const password = String(body.password || '');
    if (!userId || !password) return json(res, 400, { ok: false, error: '用户名和密码都不能为空' });

    const key = failKey(req, userId);
    if (isLocked(key)) {
      audit.log('login.locked', { req, userId, detail: { reason: 'too_many_attempts' } });
      return json(res, 429, { ok: false, error: '尝试次数过多，请 1 分钟后再试' });
    }
    const user = accounts.authenticate(userId, password);
    if (!user) {
      noteFail(key);
      audit.log('login.fail', { req, userId });
      return json(res, 401, { ok: false, error: '用户名或密码不正确' });
    }
    clearFail(key);
    usage.mark(user.userId, 'login', audit.clientIp(req));
    audit.log('login.ok', { req, userId: user.userId, detail: { mustChange: !!user.mustChange } });
    return json(
      res,
      200,
      { ok: true, user, next: user.mustChange ? '/account?force=1' : '/' },
      { 'Set-Cookie': accounts.sessionCookie(user.userId) }
    );
  }

  if (p === '/api/auth/logout' && req.method === 'POST') {
    if (me) audit.log('logout', { req, userId: me.userId });
    return json(res, 200, { ok: true }, { 'Set-Cookie': accounts.clearCookie() });
  }

  // 以下都需要已登录
  if (!me) return json(res, 401, { ok: false, error: '未登录' });

  if (p === '/api/auth/me' && req.method === 'GET') {
    const u = accounts.getUser(me.userId);
    if (!u) return json(res, 401, { ok: false, error: '账号不存在' });
    return json(res, 200, { ok: true, ...u, via: me.via });
  }

  if (p === '/api/auth/password' && req.method === 'POST') {
    const body = await readJson(req);
    const ok = accounts.authenticate(me.userId, String(body.currentPassword || ''));
    if (!ok) {
      audit.log('password.change.fail', { req, userId: me.userId, detail: { reason: 'wrong_current' } });
      return json(res, 400, { ok: false, error: '当前密码不正确' });
    }
    const user = accounts.setPassword(me.userId, body.newPassword, { mustChange: false });
    audit.log('password.change', { req, userId: me.userId });
    // 改密会作废旧会话，这里换发一个新的
    return json(res, 200, { ok: true, user }, { 'Set-Cookie': accounts.sessionCookie(user.userId) });
  }

  // 踢掉自己在其他设备上的会话，当前这台保留（换发带新 pwVersion 的 cookie）
  if (p === '/api/auth/logout-others' && req.method === 'POST') {
    const user = accounts.bumpSessions(me.userId);
    audit.log('sessions.revoke_others', { req, userId: me.userId });
    return json(res, 200, { ok: true, user }, { 'Set-Cookie': accounts.sessionCookie(user.userId) });
  }

  return json(res, 404, { ok: false, error: '未找到接口: ' + req.method + ' ' + p });
}

/* ---------------------------------------------------------------- 主入口 */

async function handleWeb(req, res, url, opts) {
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return true;
  }

  if (p === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return true;
  }

  const me = resolveIdentity(req, url, opts);
  if (me && me.via === 'token') usage.mark(me.userId, 'token');

  // `?token=` 首登：换发会话 cookie，并把 token 从地址栏去掉
  if (me && me.via === 'token' && req.method === 'GET' && url.searchParams.has('token')) {
    const to = p + (url.search || '').replace(/([?&])token=[^&]*&?/, '$1').replace(/[?&]$/, '');
    const dest = me.mustChange ? '/account?force=1' : to || '/';
    audit.log('login.via_token', { req, userId: me.userId });
    return redirect(res, dest, { 'Set-Cookie': accounts.sessionCookie(me.userId) });
  }

  // ---- 强制改密闸门：只放行改密页、登出与 auth 接口
  //      没有这道闸，ADMIN-PASSWORD.txt 里的初始密码就能被当成长期凭据用。
  if (me && me.mustChange) {
    const allowed = p === '/account' || p === '/logout' || p.startsWith('/api/auth/') || p.startsWith('/vendor/');
    if (!allowed) {
      if (p.startsWith('/api/')) {
        return json(res, 403, { ok: false, error: '首次登录需要先修改密码', mustChange: true, next: '/account?force=1' });
      }
      return redirect(res, '/account?force=1');
    }
  }

  // ---- 自助与管理（由本模块处理，不走 api.js）
  if (p.startsWith('/api/auth/')) {
    await handleAuth(req, res, url, me, opts);
    return true;
  }
  if (p.startsWith('/api/admin/')) {
    if (!me) return json(res, 401, { ok: false, error: '未登录' });
    await handleAdmin(req, res, url, me);
    return true;
  }

  // ---- 工作台 REST：userId 由服务端注入
  if (p.startsWith('/api/')) {
    if (!me) return json(res, 401, { ok: false, error: '未登录', login: '/login' });
    await handleApi(req, res, url, me);
    return true;
  }

  // ---- 页面
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  if (p === '/login') {
    if (me) return redirect(res, '/');
    if (sendFile(req, res, LOGIN_TPL, 'text/html; charset=utf-8')) return true;
    return text(res, 500, '登录页模板缺失：' + LOGIN_TPL);
  }

  if (p === '/' || p === '/index.html' || p === '/workbench' || p === '/workbench.html') {
    if (!me) return redirect(res, '/login');
    if (sendFile(req, res, TEMPLATE, 'text/html; charset=utf-8')) return true;
    return text(res, 500, '工作台模板缺失：' + TEMPLATE);
  }

  if (p === '/account') {
    if (!me) return redirect(res, '/login');
    if (sendFile(req, res, ACCOUNT_TPL, 'text/html; charset=utf-8')) return true;
    return text(res, 500, '账号页模板缺失：' + ACCOUNT_TPL);
  }

  if (p === '/admin') {
    if (!me) return redirect(res, '/login');
    if (me.role !== 'admin') return text(res, 403, '只有管理员可以访问用户管理页。');
    if (sendFile(req, res, ADMIN_TPL, 'text/html; charset=utf-8')) return true;
    return text(res, 500, '管理页模板缺失：' + ADMIN_TPL);
  }

  if (p === '/logout') {
    if (me) audit.log('logout', { req, userId: me.userId });
    return redirect(res, '/login', { 'Set-Cookie': accounts.clearCookie() });
  }

  if (p.startsWith('/vendor/')) {
    let rel;
    try {
      rel = decodeURIComponent(p.slice('/vendor/'.length));
    } catch {
      return text(res, 400, 'bad path');
    }
    const file = inside(VENDOR_DIR, rel);
    if (file && sendFile(req, res, file, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream')) {
      return true;
    }
    return text(res, 404, 'Not found: ' + p);
  }

  if (p === '/dashboard.html') {
    if (!me) return redirect(res, '/login');
    const file = inside(DASHBOARD_DIR, me.userId + '.html');
    if (file && sendFile(req, res, file, 'text/html; charset=utf-8')) return true;
    return text(res, 404, '你的看板还没生成。在 Octop 里说「生成看板」，或调用 dashboard_build 工具后再刷新本页。');
  }

  return false;
}

module.exports = { handleWeb, dashboardPath, DASHBOARD_DIR, DASHBOARD_NAME, MIME };
