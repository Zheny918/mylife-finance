// 账号 / 会话 / 越权 防护冒烟（零依赖）
// 用法：先起服务，再 SMOKE_BASE=... SMOKE_ADMIN_PASSWORD=... node scripts/test-auth.mjs
const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:3466';
const ADMIN_USER = process.env.SMOKE_ADMIN_USER || 'admin';
const ADMIN_PW = process.env.SMOKE_ADMIN_PASSWORD || 'AdminPass123';
const ALICE_PW = 'AlicePass123';

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.log('  ✗ ' + name + (extra !== undefined && extra !== '' ? '  → ' + extra : ''));
  }
}

function cookieOf(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of raw) {
    const m = /^mylf_sid=([^;]+)/.exec(c);
    if (m) return 'mylf_sid=' + m[1];
  }
  return null;
}

async function req(path, opts) {
  const o = { ...opts, redirect: 'manual', signal: AbortSignal.timeout(20000) };
  const r = await fetch(BASE + path, o);
  const body = await r.text();
  return { status: r.status, headers: r.headers, body, cookie: cookieOf(r) };
}

function postJson(path, body, cookie) {
  return req(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body || {}),
  });
}

async function mcp(path, token, method, params) {
  const headers = { 'Content-Type': 'application/json', accept: 'application/json, text/event-stream' };
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params || {} }),
    signal: AbortSignal.timeout(20000),
  });
  return { status: r.status, body: await r.text() };
}

(async () => {
  console.log('BASE =', BASE);

  // ---------- 未登录 ----------
  {
    const r = await req('/health');
    ok('/health 免鉴权 200', r.status === 200 && r.body.includes('"ok":true'), r.status);
  }
  {
    const r = await req('/');
    ok('未登录访问 / → 302 /login', r.status === 302 && r.headers.get('location') === '/login', r.status + ' ' + r.headers.get('location'));
  }
  {
    const r = await req('/login');
    ok('/login 可直接打开 200', r.status === 200 && r.body.includes('id="f"'), r.status);
  }
  {
    const r = await req('/api/summary');
    ok('未登录 /api/summary → 401', r.status === 401, r.status);
  }
  {
    const r = await req('/admin');
    ok('未登录 /admin → 302 /login', r.status === 302, r.status);
  }
  {
    const r = await researchSafe('/mcp/admin');
    ok('未登录 /mcp/admin → 401', r.status === 401, r.status);
  }

  // ---------- 登录 ----------
  let adminCookie = null;
  {
    const r = await postJson('/api/auth/login', { userId: ADMIN_USER, password: 'wrong-pass' });
    ok('错误密码 → 401', r.status === 401 && !r.cookie, r.status);
  }
  {
    const r = await postJson('/api/auth/login', { userId: ADMIN_USER, password: ADMIN_PW });
    adminCookie = r.cookie;
    ok('管理员登录成功并下发 HttpOnly cookie', r.status === 200 && !!adminCookie, r.status);
    const raw = (r.headers.getSetCookie() || []).join(';');
    ok('cookie 带 HttpOnly + SameSite=Lax', /HttpOnly/i.test(raw) && /SameSite=Lax/i.test(raw), raw.slice(0, 80));
  }
  {
    const r = await req('/api/auth/me', { headers: { cookie: adminCookie } });
    const me = JSON.parse(r.body || '{}');
    ok('/api/auth/me 返回身份', r.status === 200 && me.userId === ADMIN_USER && me.role === 'admin', r.body.slice(0, 80));
  }
  {
    const r = await req('/api/summary', { headers: { cookie: adminCookie } });
    ok('登录后 /api/summary 200', r.status === 200, r.status);
  }
  {
    const r = await req('/admin', { headers: { cookie: adminCookie } });
    ok('管理员可打开 /admin', r.status === 200 && r.body.includes('用户管理'), r.status);
  }
  {
    const r = await req('/login', { headers: { cookie: adminCookie } });
    ok('已登录访问 /login → 302 /', r.status === 302 && r.headers.get('location') === '/', r.status);
  }

  // ---------- 建成员 ----------
  let aliceToken = null;
  {
    const r = await postJson('/api/admin/users', { userId: 'alice', label: '老婆', password: ALICE_PW, role: 'member' }, adminCookie);
    const d = JSON.parse(r.body || '{}');
    aliceToken = d.token;
    ok('管理员创建 alice 成功并拿到 token', r.status === 200 && d.ok && !!aliceToken, r.body.slice(0, 120));
  }
  {
    const r = await postJson('/api/admin/users', { userId: 'alice', password: 'Whatever123' }, adminCookie);
    ok('重复创建同名用户 → 400', r.status === 400, r.status);
  }
  {
    const r = await postJson('/api/admin/users', { userId: 'bad name!', password: 'Whatever123' }, adminCookie);
    ok('非法用户名 → 400', r.status === 400, r.status);
  }
  {
    const r = await postJson('/api/admin/users', { userId: 'shortpw', password: '123' }, adminCookie);
    ok('密码过短 → 400', r.status === 400, r.status);
  }

  // ---------- 成员权限 ----------
  let aliceCookie = null;
  {
    const r = await postJson('/api/auth/login', { userId: 'alice', password: ALICE_PW });
    aliceCookie = r.cookie;
    ok('alice 登录成功', r.status === 200 && !!aliceCookie, r.status);
  }
  {
    const r = await req('/admin', { headers: { cookie: aliceCookie } });
    ok('成员打开 /admin → 403', r.status === 403, r.status);
  }
  {
    const r = await req('/api/admin/users', { headers: { cookie: aliceCookie } });
    ok('成员调 /api/admin/users → 403', r.status === 403, r.status);
  }
  {
    const r = await postJson('/api/admin/users', { userId: 'sneaky', password: 'Whatever123' }, aliceCookie);
    ok('成员不能创建用户', r.status === 403, r.status);
  }

  // ---------- 伪造身份无效（本轮核心回归）----------
  {
    const r = await req('/api/meta', { headers: { cookie: aliceCookie, 'x-user-id': 'admin', 'x-userid': 'admin' } });
    const d = JSON.parse(r.body || '{}');
    ok('伪造 x-user-id: admin 无效，仍是 alice', r.status === 200 && d.userId === 'alice', r.body.slice(0, 90));
  }
  {
    const r = await req('/api/meta?userId=admin', { headers: { cookie: aliceCookie } });
    const d = JSON.parse(r.body || '{}');
    ok('伪造 ?userId=admin 无效', r.status === 200 && d.userId === 'alice', r.body.slice(0, 90));
  }

  // ---------- MCP 授权 ----------
  {
    const r = await mcp('/mcp/alice', aliceToken, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'auth-test', version: '1' },
    });
    ok('alice 的 token 访问 /mcp/alice → 200', r.status === 200, r.status + ' ' + r.body.slice(0, 80));
  }
  {
    const r = await mcp('/mcp/admin', aliceToken, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'auth-test', version: '1' },
    });
    ok('alice 的 token 访问 /mcp/admin → 403（越权被拦）', r.status === 403, r.status);
  }
  {
    const r = await mcp('/mcp/alice', 'not-a-real-token-xxxxxxxxxxxxx', 'initialize', {});
    ok('无效 token → 401', r.status === 401, r.status);
  }
  {
    const r = await mcp('/mcp/alice', null, 'initialize', {});
    ok('无 token → 401', r.status === 401, r.status);
  }

  // ---------- ?token= 首登 ----------
  {
    const r = await req('/?token=' + encodeURIComponent(aliceToken));
    ok('?token= → 302 且回写会话 cookie', r.status === 302 && !!r.cookie, r.status + ' cookie=' + !!r.cookie);
    ok('?token= 跳转后地址不含 token', !String(r.headers.get('location') || '').includes('token='), r.headers.get('location'));
  }
  {
    const r = await req('/?token=bogus-token-value');
    ok('?token= 无效 → 302 /login（不泄露细节）', r.status === 302 && r.headers.get('location') === '/login', r.status + ' ' + r.headers.get('location'));
  }

  // ---------- 看板按用户分文件 ----------
  {
    const r = await mcp('/mcp/alice', aliceToken, 'tools/call', { name: 'dashboard_build', arguments: {} });
    ok('dashboard_build 成功', r.status === 200 && r.body.includes('relativeUrl'), r.body.slice(0, 90));
  }
  {
    const r = await req('/dashboard.html', { headers: { cookie: aliceCookie } });
    ok('alice 能看到自己的看板', r.status === 200 && r.body.includes('chart'), r.status);
  }
  {
    const r = await req('/dashboard.html', { headers: { cookie: adminCookie } });
    ok('admin 看不到 alice 的看板（404 = 各自独立）', r.status === 404, r.status);
  }

  // ---------- 改密 ----------
  {
    const r = await postJson('/api/auth/password', { currentPassword: 'wrong', newPassword: 'NewAlicePass123' }, aliceCookie);
    ok('旧密码错误 → 400', r.status === 400, r.status);
  }
  {
    const r = await postJson('/api/auth/password', { currentPassword: ALICE_PW, newPassword: 'NewAlicePass123' }, aliceCookie);
    ok('改密成功并换发新 cookie', r.status === 200 && !!r.cookie, r.status);
    const old = await req('/api/meta', { headers: { cookie: aliceCookie } });
    ok('改密后旧会话立即失效', old.status === 401, old.status);
    aliceCookie = r.cookie;
  }

  // ---------- 停用 ----------
  {
    const r = await postJson('/api/admin/users/alice/disabled', { disabled: true }, adminCookie);
    ok('管理员停用 alice', r.status === 200, r.status);
    const login = await postJson('/api/auth/login', { userId: 'alice', password: 'NewAlicePass123' });
    ok('停用后无法登录', login.status === 401, login.status);
    const api = await req('/api/meta', { headers: { cookie: aliceCookie } });
    ok('停用后旧会话失效', api.status === 401, api.status);
    const tk = await mcp('/mcp/alice', aliceToken, 'initialize', {});
    ok('停用后 token 也失效', tk.status === 401, tk.status);
    await postJson('/api/admin/users/alice/disabled', { disabled: false }, adminCookie);
  }

  // ---------- 轮换 token ----------
  {
    const r = await postJson('/api/admin/users/alice/token', {}, adminCookie);
    const d = JSON.parse(r.body || '{}');
    ok('轮换 token 返回新值', r.status === 200 && !!d.token && d.token !== aliceToken, r.status);
    const old = await mcp('/mcp/alice', aliceToken, 'initialize', {});
    ok('旧 token 立即失效', old.status === 401, old.status);
    const fresh = await mcp('/mcp/alice', d.token, 'initialize', {});
    ok('新 token 可用', fresh.status === 200, fresh.status);
    aliceToken = d.token;
  }

  // ---------- 最后一个管理员保护 ----------
  {
    const r = await postJson('/api/admin/users/admin/disabled', { disabled: true }, adminCookie);
    ok('不能停用最后一个管理员', r.status === 400, r.status);
  }
  {
    const r = await req('/api/admin/users/admin', { method: 'DELETE', headers: { cookie: adminCookie } });
    ok('不能删除自己', r.status === 400, r.status);
  }

  // ---------- 登出 ----------
  {
    const r = await postJson('/api/auth/logout', {}, adminCookie);
    ok('登出清 cookie', r.status === 200 && /mylf_sid=;/.test((r.headers.getSetCookie() || []).join(';')), r.status);
  }

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();

// 上面用到的一个小工具：不带 token 请求 /mcp
async function researchSafe(path) {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10000) });
  return { status: r.status, body: await r.text() };
}
