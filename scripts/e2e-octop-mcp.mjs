/*
 * 模拟 Octop（MCP Streamable HTTP 客户端）的完整会话流程。
 * 只打临时数据目录的实例，不碰真实库。
 *
 * ⚠ 本脚本**不幂等**：它会造数据并断言精确条数（如「伪造 userId 只读到 1 条」）。
 *   每跑一次都要用全新的 MYLF_DATA_DIR，否则第二次起会因数据累积而误报失败。
 */
const BASE = process.env.BASE || 'http://127.0.0.1:3458';
const ADMIN_USER = process.env.SMOKE_ADMIN_USER || 'admin';
const ADMIN_PW = process.env.SMOKE_ADMIN_PASSWORD || 'AdminPass123';
let sessionId = null;
let pass = 0;
let fail = 0;
const TOKENS = {}; // userId -> 该用户的 MCP token（e2e 自己创建）

/* 账号体系下的前置：管理员登录 → 为 alice / bob 各建一个用户并拿 token */
async function setupAccounts() {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: ADMIN_USER, password: ADMIN_PW }),
  });
  if (!r.ok) throw new Error(`管理员登录失败 HTTP ${r.status}（设 SMOKE_ADMIN_PASSWORD 或用默认库）`);
  const cookie = (r.headers.getSetCookie ? r.headers.getSetCookie() : [])
    .map((c) => c.split(';')[0])
    .join('; ');

  for (const userId of ['alice', 'bob']) {
    const created = await fetch(`${BASE}/api/admin/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ userId, password: 'E2ePass12345', role: 'member' }),
    });
    if (created.ok) {
      TOKENS[userId] = (await created.json()).token;
      continue;
    }
    // 已存在 → 轮换 token 拿一个新的（旧值不可知）
    const rotated = await fetch(`${BASE}/api/admin/users/${userId}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: '{}',
    });
    if (!rotated.ok) throw new Error(`准备用户 ${userId} 失败 HTTP ${rotated.status}`);
    TOKENS[userId] = (await rotated.json()).token;
  }
}

function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`);
  }
}

async function rpc(user, msg) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2025-03-26',
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  if (TOKENS[user]) headers.Authorization = 'Bearer ' + TOKENS[user];
  const r = await fetch(`${BASE}/mcp/${encodeURIComponent(user)}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(msg),
  });
  const sid = r.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  if (r.status === 202) return { status: 202, body: null };
  const txt = await r.text();
  return { status: r.status, body: txt ? JSON.parse(txt) : null };
}

const call = (user, name, args) =>
  rpc(user, { jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method: 'tools/call', params: { name, arguments: args || {} } });

const payload = (r) => JSON.parse(r.body.result.content[0].text);

(async () => {
  console.log('0) 账号准备');
  await setupAccounts();
  ok('已为 alice / bob 取得独立 token', !!TOKENS.alice && !!TOKENS.bob);

  console.log('1) 握手');

  const init = await rpc('alice', {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'octop-sim', version: '1' } },
  });
  ok('initialize 返回 200', init.status === 200);
  ok('下发 Mcp-Session-Id', !!sessionId, '缺失');
  ok('serverInfo.name 正确', init.body.result.serverInfo.name === 'mylife-finance');
  ok('声明 tools 能力', !!init.body.result.capabilities.tools);

  const noted = await rpc('alice', { jsonrpc: '2.0', method: 'notifications/initialized' });
  ok('notifications/initialized 返回 202', noted.status === 202);

  console.log('2) 工具发现');

  const list = await rpc('alice', { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = list.body.result.tools.map((t) => t.name);
  ok('工具数 43', names.length === 43, `实际 ${names.length}`);
  ok('不含 user_create', !names.includes('user_create'));
  ok('每个工具都有 inputSchema', list.body.result.tools.every((t) => t.inputSchema && t.inputSchema.type === 'object'));
  ok('会话头被回带后仍正常', list.status === 200);

  console.log('3) 记账链路');

  const add = await call('alice', 'tx_add', {
    account: '招行',
    type: 'EXPENSE',
    amount: 88,
    category: '三餐',
    description: '午餐',
    date: '2026-11-15',
  });
  ok('tx_add 成功', !!payload(add).ok);
  ok('日期归一化为 YYYY-MM-DD', payload(add).transaction.date === '2026-11-15');

  const bad = await call('alice', 'tx_add', { account: '招行', type: 'EXPENSE' });
  ok('缺 amount 报错', !!bad.body.result.isError);

  const monthly = await call('alice', 'report_monthly', { year: 2026, month: 11 });
  const m = payload(monthly);
  ok('report_monthly 统计到这笔', Number(m.totalExpense) === 88 || Number(m.expense) === 88, JSON.stringify(m).slice(0, 120));

  console.log('4) 新租户分类');

  const cats = payload(await call('alice', 'category_list', {}));
  const arr = cats.categories || [];
  ok('自动播种 137 个分类', arr.length === 137, `实际 ${arr.length}（记账不应新建分类）`);
  ok('顶级 18 个', arr.filter((c) => !c.parent_id).length === 18, `实际 ${arr.filter((c) => !c.parent_id).length}`);
  ok('二级 119 个', arr.filter((c) => c.parent_id).length === 119, `实际 ${arr.filter((c) => c.parent_id).length}`);

  console.log('5) 用户隔离');

  sessionId = null;
  const bobTx = payload(await call('bob', 'tx_list', {}));
  ok('bob 看不到 alice 的交易', bobTx.count === 0, `实际 ${bobTx.count}`);

  const bobCats = payload(await call('bob', 'category_list', {}));
  ok('bob 有自己的 137 个分类', (bobCats.categories || []).length === 137);

  console.log('6) 越权防护');

  const spoof = payload(await call('alice', 'tx_list', { userId: 'bob' }));
  ok('伪造 userId=bob 仍只读到自己的数据', spoof.count === 1, `实际 ${spoof.count}`);

  const ul = payload(await call('alice', 'user_list', {}));
  ok('user_list 只返回自己', ul.count === 1 && ul.users[0].name === 'alice', JSON.stringify(ul));

  const uc = await call('alice', 'user_create', { name: 'hacker' });
  ok('user_create 被拒绝', !!uc.body.result.isError);

  const cross = await fetch(`${BASE}/mcp/bob`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + TOKENS.alice,
    },
    body: '{"jsonrpc":"2.0","id":7,"method":"tools/list"}',
  });
  ok('拿 alice 的 token 打 /mcp/bob → 403', cross.status === 403, `实际 ${cross.status}`);

  console.log('7) 异常输入');

  const r1 = await fetch(`${BASE}/mcp/${encodeURIComponent('../etc/passwd')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKENS.alice },
    body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
  });
  ok('路径穿越被拒 400', r1.status === 400);

  const r2 = await fetch(`${BASE}/mcp/alice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKENS.alice },
    body: 'not json',
  });
  ok('非法 JSON 返回 400', r2.status === 400);

  const r3 = await fetch(`${BASE}/mcp/alice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKENS.alice },
    body: '{"jsonrpc":"2.0","id":9,"method":"no/such"}',
  });
  const j3 = await r3.json();
  ok('未知方法返回 -32601', j3.error && j3.error.code === -32601);

  const health = await fetch(`${BASE}/health`);
  const hj = await health.json();
  ok('/health 正常', hj.ok === true && hj.toolCount === 43, `toolCount=${hj.toolCount}`);

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})();
