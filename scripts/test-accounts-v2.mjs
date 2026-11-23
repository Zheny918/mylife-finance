// 账号体系 v2 冒烟：强制改密 / 下线其他设备 / 删号与同名重建 / 接管旧账 / 审计 / 使用痕迹
// 纯 node，零依赖。用法：
//   MYLF_DATA_DIR=... MYLF_HTTP_PORT=3479 MYLF_ADMIN_PASSWORD=AdminPass123 node server-http.js
//   SMOKE_BASE=http://127.0.0.1:3479 SMOKE_ADMIN_PASSWORD=AdminPass123 node scripts/test-accounts-v2.mjs
const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:3479';
const ADMIN_USER = process.env.SMOKE_ADMIN_USER || 'admin';
const ADMIN_PW = process.env.SMOKE_ADMIN_PASSWORD || 'AdminPass123';
const ERIN_PW = 'ErinPass1234';
const ERIN2_PW = 'ErinPass9999';
const DAVE_PW = 'DavePass1234';

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
  return { status: r.status, headers: r.headers, body: await r.text(), cookie: cookieOf(r) };
}

const postJson = (p, body, cookie) =>
  req(p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body || {}),
  });

function parse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

(async () => {
  console.log('BASE =', BASE);

  // ---------- 登录拿管理员会话 ----------
  let admin = '';
  {
    const bad = await postJson('/api/auth/login', { userId: ADMIN_USER, password: 'definitely-wrong' });
    ok('错误密码 → 401（供审计用）', bad.status === 401, bad.status);
    const r = await postJson('/api/auth/login', { userId: ADMIN_USER, password: ADMIN_PW });
    admin = r.cookie;
    ok('管理员登录', r.status === 200 && !!admin, r.status);
  }

  // ---------- 强制改密闸门 ----------
  {
    const r = await postJson('/api/admin/users', { userId: 'erin', password: ERIN_PW, role: 'member', mustChange: true }, admin);
    ok('创建 erin（mustChange=true）', r.status === 200, r.body.slice(0, 120));
  }
  let erin = '';
  {
    const r = await postJson('/api/auth/login', { userId: 'erin', password: ERIN_PW });
    erin = r.cookie;
    const d = parse(r.body);
    ok('登录返回 next=/account?force=1', r.status === 200 && d.next === '/account?force=1', JSON.stringify(d.next));
    ok('登录响应标记 mustChange', d.user && d.user.mustChange === true, r.body.slice(0, 120));
  }
  {
    const r = await req('/', { headers: { cookie: erin } });
    ok('待改密访问 / → 302 /account?force=1', r.status === 302 && r.headers.get('location') === '/account?force=1', r.status + ' ' + r.headers.get('location'));
  }
  {
    const r = await req('/api/summary', { headers: { cookie: erin } });
    const d = parse(r.body);
    ok('待改密调 /api/summary → 403 且带 next', r.status === 403 && d.mustChange === true, r.status + ' ' + r.body.slice(0, 80));
  }
  {
    const r = await req('/api/admin/users', { headers: { cookie: erin } });
    ok('待改密也进不了用户管理', r.status === 403, r.status);
  }
  {
    const r = await req('/account', { headers: { cookie: erin } });
    ok('待改密可以打开 /account', r.status === 200 && r.body.includes('修改密码'), r.status);
  }
  {
    const r = await postJson('/api/auth/password', { currentPassword: ERIN_PW, newPassword: ERIN2_PW }, erin);
    ok('改密成功并换发 cookie', r.status === 200 && !!r.cookie, r.status);
    erin = r.cookie;
  }
  {
    const r = await req('/api/summary', { headers: { cookie: erin } });
    ok('改密后闸门解除（/api/summary 200）', r.status === 200, r.status);
    const me = parse((await req('/api/auth/me', { headers: { cookie: erin } })).body);
    ok('mustChange 已清为 false', me.mustChange === false, String(me.mustChange));
  }

  // ---------- 下线其他设备 ----------
  {
    const second = await postJson('/api/auth/login', { userId: 'erin', password: ERIN2_PW });
    const cookie2 = second.cookie;
    ok('erin 在第二台设备登录成功', second.status === 200 && !!cookie2, second.status);

    const r = await postJson('/api/auth/logout-others', {}, cookie2);
    ok('调用 logout-others 成功并换发 cookie', r.status === 200 && !!r.cookie, r.status);

    const oldOne = await req('/api/meta', { headers: { cookie: erin } });
    ok('第一台设备的会话被踢掉', oldOne.status === 401, oldOne.status);
    const keep = await req('/api/meta', { headers: { cookie: r.cookie } });
    ok('发起操作的那台仍然有效', keep.status === 200, keep.status);
    erin = r.cookie;
  }
  {
    const r = await req('/api/admin/users', { headers: { cookie: erin } });
    ok('成员访问用户管理 → 403（供审计用）', r.status === 403, r.status);
  }
  {
    const r = await postJson('/api/admin/users/erin/token', {}, admin);
    ok('管理员轮换 erin 的 token', r.status === 200 && !!parse(r.body).token, r.body.slice(0, 120));
  }

  // ---------- 删账号：必须显式声明是否清数据 ----------
  {
    const r = await postJson('/api/admin/users', { userId: 'dave', password: DAVE_PW, role: 'member' }, admin);
    ok('创建 dave', r.status === 200, r.body.slice(0, 100));
  }
  let dave = '';
  {
    const r = await postJson('/api/auth/login', { userId: 'dave', password: DAVE_PW });
    dave = r.cookie;
    const m = await postJson('/api/members', { name: '接管测试成员' }, dave);
    ok('dave 记一个成员（作为「旧账」标记）', m.status === 200, m.body.slice(0, 100));
  }
  {
    const r = await req('/api/admin/users/dave', { method: 'DELETE', headers: { cookie: admin } });
    const d = parse(r.body);
    ok('不带 purge 参数 → 400 且回传数据量', r.status === 400 && d.stats && d.stats.total > 0, r.status + ' ' + r.body.slice(0, 120));
  }
  {
    const r = await req('/api/admin/users/dave?purge=0', { method: 'DELETE', headers: { cookie: admin } });
    ok('purge=0 删除成功并留墓碑', r.status === 200 && parse(r.body).retired === true, r.body.slice(0, 120));
  }
  {
    const r = await req('/api/admin/users', { headers: { cookie: admin } });
    const d = parse(r.body);
    ok('已删除用户名出现在 retired 列表', (d.retired || []).some((x) => x.userId === 'dave'), JSON.stringify(d.retired));
    ok('dave 已不在用户列表', !(d.users || []).some((x) => x.userId === 'dave'));
  }
  {
    const r = await postJson('/api/admin/users', { userId: 'dave', password: 'DaveNewPass123' }, admin);
    ok('同名重建被拒绝（防串号）', r.status === 400 && /接管|曾被删除/.test(parse(r.body).error || ''), r.body.slice(0, 160));
  }
  {
    const r = await postJson('/api/admin/users', { userId: 'dave', password: DAVE_PW, reclaim: true }, admin);
    ok('显式 reclaim 后可以重建', r.status === 200 && parse(r.body).reclaimed === true, r.body.slice(0, 140));
  }
  {
    const r = await postJson('/api/auth/login', { userId: 'dave', password: DAVE_PW });
    dave = r.cookie;
    const list = parse((await req('/api/members', { headers: { cookie: dave } })).body);
    const names = (list.members || list.items || list.rows || []).map((x) => x.name);
    ok('接管后能看到原来的账本数据', names.includes('接管测试成员'), JSON.stringify(names).slice(0, 120));
  }

  // ---------- purge=1：连数据一起删，且允许直接重建 ----------
  {
    const r = await req('/api/admin/users/dave?purge=1', { method: 'DELETE', headers: { cookie: admin } });
    const d = parse(r.body);
    ok('purge=1 删除成功', r.status === 200, r.body.slice(0, 140));
    ok('返回各表清理行数', d.purged && d.purged.members >= 1, JSON.stringify(d.purged));
  }
  {
    const r = await postJson('/api/admin/users', { userId: 'dave', password: DAVE_PW }, admin);
    ok('清库后可直接重建同名（不留墓碑）', r.status === 200 && parse(r.body).reclaimed === false, r.body.slice(0, 140));
  }
  {
    const r = await postJson('/api/auth/login', { userId: 'dave', password: DAVE_PW });
    const list = parse((await req('/api/members', { headers: { cookie: r.cookie } })).body);
    const names = (list.members || list.items || list.rows || []).map((x) => x.name);
    ok('重建后是干净账本（看不到旧成员）', !names.includes('接管测试成员'), JSON.stringify(names).slice(0, 120));
  }

  // ---------- 使用痕迹 ----------
  {
    const d = parse((await req('/api/admin/users', { headers: { cookie: admin } })).body);
    const adminRow = (d.users || []).find((u) => u.userId === ADMIN_USER);
    ok('用户列表带最近登录时间', !!(adminRow && adminRow.usage && adminRow.usage.lastLoginAt), JSON.stringify(adminRow && adminRow.usage));
  }

  // ---------- 审计 ----------
  let events = [];
  {
    const r = await req('/api/admin/audit?limit=200', { headers: { cookie: admin } });
    const d = parse(r.body);
    events = d.events || [];
    const evs = events.map((e) => e.ev);
    ok('审计接口可用', r.status === 200 && events.length > 0, r.status + ' n=' + events.length);
    ok('记录了登录成功', evs.includes('login.ok'));
    ok('记录了登录失败', evs.includes('login.fail'));
    ok('记录了创建用户', evs.includes('admin.user.create'));
    ok('记录了删除用户', evs.includes('admin.user.delete'));
    ok('记录了轮换/重置类操作中的至少一种', evs.some((x) => /token.rotate|password.reset/.test(x)), JSON.stringify(evs.slice(0, 12)));
    ok('记录了越权拦截（admin.denied）', evs.includes('admin.denied'), JSON.stringify(evs.slice(0, 12)));
    const leaked = events.some((e) => JSON.stringify(e).match(/\$2[aby]\$|scrypt\$|Bearer\s+[A-Za-z0-9_-]{16}/));
    ok('审计里没有密码哈希 / token 明文', !leaked);
  }
  {
    const r = await req('/api/admin/audit', { headers: { cookie: erin } });
    ok('普通成员看审计 → 403', r.status === 403, r.status);
  }

  // ---------- 最后一道：不能删自己 ----------
  {
    const r = await req('/api/admin/users/' + ADMIN_USER + '?purge=1', { method: 'DELETE', headers: { cookie: admin } });
    ok('不能删除当前登录账号', r.status === 400, r.status);
  }

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试脚本异常：', e && e.stack ? e.stack : e);
  process.exit(2);
});
