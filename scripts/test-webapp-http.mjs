// 工作台 HTTP 面冒烟（账号体系版）：登录/会话/越权/静态资源/看板/MCP 链接
// 纯 node，零依赖；失败即抛，退出码非 0
// 用法：SMOKE_BASE=http://127.0.0.1:3468 SMOKE_ADMIN_PASSWORD=... node scripts/test-webapp-http.mjs
//
// 其中「dashboard_build 返回可点击 URL」两项要求实例启动时设了 MYLF_PUBLIC_BASE_URL。
// 若你的实例用的是别的基址，把同值传给 SMOKE_PUBLIC_BASE，别去改断言里的字面量。
const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:3461';
const PUBLIC_BASE = (process.env.SMOKE_PUBLIC_BASE || 'http://192.168.130.8:3458').replace(/\/+$/, '');
const ADMIN_USER = process.env.SMOKE_ADMIN_USER || 'admin';
const ADMIN_PW = process.env.SMOKE_ADMIN_PASSWORD || 'AdminPass123';
const USER = 'smoke_user';
const USER_PW = 'SmokePass1234';

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
  const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of list) {
    if (/^mylf_sid=/.test(c)) return c.split(';')[0];
  }
  return '';
}

async function req(path, opts) {
  const r = await fetch(BASE + path, { redirect: 'manual', ...opts, signal: AbortSignal.timeout(20000) });
  return { ok: r.ok, status: r.status, headers: r.headers, body: await r.text(), cookie: cookieOf(r) };
}

const postJson = (p, body, cookie) =>
  req(p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body || {}),
  });

(async () => {
  console.log('BASE =', BASE);

  // 1) /health 免鉴权
  {
    const r = await req('/health');
    let j = {};
    try { j = JSON.parse(r.body); } catch {}
    ok('/health 200 且 ok:true', r.status === 200 && j.ok === true, r.status + ' ' + r.body.slice(0, 80));
    ok('/health 报告 toolCount', typeof j.toolCount === 'number' && j.toolCount > 0, String(j.toolCount));
  }

  // 2) 未登录：页面跳登录页，接口 401
  {
    const r = await req('/');
    ok('未登录访问 / → 302 /login', r.status === 302 && r.headers.get('location') === '/login', r.status);
    const a = await req('/api/summary');
    ok('未登录 /api/summary → 401', a.status === 401, a.status);
    const l = await req('/login');
    ok('/login 可直接打开', l.status === 200 && l.body.includes('id="f"'), l.status);
  }

  // 3) 登录
  let cookie = '';
  {
    const bad = await postJson('/api/auth/login', { userId: ADMIN_USER, password: 'nope' });
    ok('错误密码 → 401', bad.status === 401, bad.status);
    const r = await postJson('/api/auth/login', { userId: ADMIN_USER, password: ADMIN_PW });
    cookie = r.cookie;
    const sc = (r.headers.getSetCookie() || []).join(';');
    ok('管理员登录 200', r.status === 200, r.status);
    ok('下发 mylf_sid Cookie', /mylf_sid=/.test(sc), sc.slice(0, 60));
    ok('Cookie 带 HttpOnly', /HttpOnly/i.test(sc), sc.slice(0, 80));
  }

  // 4) 用 Cookie 访问 /api/summary
  {
    const r = await req('/api/summary', { headers: { cookie } });
    let j = {};
    try { j = JSON.parse(r.body); } catch {}
    ok('/api/summary 200', r.status === 200, String(r.status) + ' ' + r.body.slice(0, 80));
    ok('/api/summary 有年度字段', j.yearIncome !== undefined && j.yearExpense !== undefined, JSON.stringify(Object.keys(j)).slice(0, 100));
  }

  // 5) 伪造身份无效
  {
    const r = await req('/api/meta', { headers: { cookie, 'x-user-id': USER } });
    let j = {};
    try { j = JSON.parse(r.body); } catch {}
    ok('伪造 x-user-id 无效（仍是 admin）', j.userId === ADMIN_USER, String(j.userId));
  }

  // 6) 静态资源与穿越
  {
    const r = await req('/vendor/chart.umd.js', { headers: { cookie } });
    ok('/vendor/chart.umd.js 200', r.status === 200 && r.body.length > 10000, r.status + ' len=' + r.body.length);
    const t = await req('/vendor/../server-http.js', { headers: { cookie } });
    ok('/vendor/../ 被拒（非 200）', t.status !== 200, String(t.status));
  }

  // 7) 建一个普通用户并拿它的 token
  let token = '';
  {
    let r = await postJson('/api/admin/users', { userId: USER, password: USER_PW, role: 'member' }, cookie);
    if (r.ok) {
      token = JSON.parse(r.body).token;
    } else {
      await postJson('/api/admin/users/' + USER + '/password', { password: USER_PW }, cookie);
      r = await postJson('/api/admin/users/' + USER + '/token', {}, cookie);
      if (r.ok) token = JSON.parse(r.body).token;
    }
    ok('已为冒烟用户准备 MCP token', !!token, String(r.status));
  }

  // 8) /info 需要凭据
  {
    const r1 = await req('/info');
    ok('/info 无凭据 → 401', r1.status === 401, String(r1.status));
    const r2 = await req('/info', { headers: { authorization: 'Bearer ' + token } });
    let j = {};
    try { j = JSON.parse(r2.body); } catch {}
    ok('/info Bearer → 200 且有 workbench 字段', r2.status === 200 && !!j.workbench, r2.status + ' ' + r2.body.slice(0, 80));
    ok('/info 回显凭据所属用户', j.you && j.you.userId === USER, JSON.stringify(j.you));
  }

  // 9) MCP: dashboard_build 返回可点击 url
  {
    const r = await req('/mcp/' + USER, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer ' + token },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'dashboard_build', arguments: {} } }),
    });
    let payload = null;
    try { payload = JSON.parse(r.body); } catch {}
    const inner = payload && payload.result && payload.result.content && payload.result.content[0] && payload.result.content[0].text;
    let d = {};
    try { d = JSON.parse(inner); } catch {}
    ok('dashboard_build 调用 200', r.status === 200, String(r.status) + ' ' + r.body.slice(0, 80));
    ok('返回 url 且无重复斜杠', typeof d.url === 'string' && d.url === PUBLIC_BASE + '/dashboard.html', String(d.url) + `（期望 ${PUBLIC_BASE}/dashboard.html；实例需以 MYLF_PUBLIC_BASE_URL=${PUBLIC_BASE} 启动）`);
    ok('返回 relativeUrl', d.relativeUrl === '/dashboard.html', String(d.relativeUrl));
    ok('返回容器内 path（按用户分文件）', typeof d.path === 'string' && d.path.includes('dashboards') && d.path.includes(USER), String(d.path));
    ok('不返回 hint（已设基址）', d.hint === undefined, d.hint ? String(d.hint).slice(0, 80) + '（实例没设 MYLF_PUBLIC_BASE_URL）' : undefined);
  }

  // 10) 该用户自己的看板可访问，且是自包含 HTML
  {
    const login = await postJson('/api/auth/login', { userId: USER, password: USER_PW });
    const uc = login.cookie;
    ok('普通用户可登录', login.status === 200 && !!uc, login.status);
    const r = await req('/dashboard.html', { headers: { cookie: uc } });
    ok('/dashboard.html 200', r.status === 200, String(r.status) + ' ' + r.body.slice(0, 60));
    ok('看板内联了 Chart.js', r.body.includes('Chart') && r.body.length > 200000, 'len=' + r.body.length);
    const other = await req('/dashboard.html', { headers: { cookie } });
    ok('别人（admin）看不到这份看板 → 404', other.status === 404, String(other.status));
  }

  // 11) ?token= 首登与非法 token
  {
    const r = await req('/?token=' + encodeURIComponent(token));
    ok('?token= → 302 且下发会话 Cookie', r.status === 302 && !!r.cookie, r.status + ' cookie=' + !!r.cookie);
    ok('跳转后地址不含 token', !String(r.headers.get('location') || '').includes('token='), r.headers.get('location'));
    const bad = await req('/?token=wrong');
    ok('错误 token → 302 /login', bad.status === 302 && bad.headers.get('location') === '/login', bad.status + ' ' + bad.headers.get('location'));
  }

  // 12) 未知路径
  {
    const r = await req('/nope-does-not-exist', { headers: { cookie } });
    ok('未知路径 → 404', r.status === 404, String(r.status));
  }

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('冒烟脚本异常：', e && e.stack ? e.stack : e);
  process.exit(2);
});
