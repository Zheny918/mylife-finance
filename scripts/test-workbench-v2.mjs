#!/usr/bin/env node
/**
 * 工作台 v1.1.5 新增能力的接口验收
 *
 *   SMOKE_BASE=http://127.0.0.1:3510 SMOKE_ADMIN_PASSWORD=... node scripts/test-workbench-v2.mjs
 *
 * 覆盖：
 *   1. 账户卡号 / 备注、余额调整（自动生成「其他费用/其他收入」流水）
 *   2. 记账时分秒、按年查询、按一级分类 id 查询（含子分类）、说明关键词
 *   3. /api/selectors 按使用频次排序（一级分类 used 含子级）
 *   4. /api/reports/overview 六维度聚合、分类上卷、类型/关键词筛选、转账不计入收支
 *   5. /api/summary 的累计口径与本月口径字段
 *
 * 自造数据（带时间戳后缀）并只按自己造的数据断言，可在同一个库上重复运行。
 * 退出码：0 全过；1 有失败项。
 */
const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:3510';
const ADMIN_USER = process.env.SMOKE_ADMIN_USER || 'admin';
const ADMIN_PW = process.env.SMOKE_ADMIN_PASSWORD || 'AdminPass123';

let pass = 0;
const failures = [];
const ok = (name, cond, extra) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`);
  }
};

const cookieOf = (res) => {
  const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const c = list.find((x) => /^mylf_sid=/.test(x));
  return c ? c.split(';')[0] : '';
};

let cookie = '';
async function req(p, opts = {}) {
  const r = await fetch(BASE + p, {
    redirect: 'manual',
    ...opts,
    headers: { ...(cookie ? { cookie } : {}), ...(opts.headers || {}) },
    signal: AbortSignal.timeout(20000),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 保持 null */ }
  return { status: r.status, body: text, json, cookie: cookieOf(r) };
}
const post = (p, body) => req(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
const put = (p, body) => req(p, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });

(async () => {
  console.log('BASE =', BASE);
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/health'); if (r.ok) break; } catch { /* 等服务起来 */ }
    await new Promise((r) => setTimeout(r, 250));
  }

  const login = await post('/api/auth/login', { userId: ADMIN_USER, password: ADMIN_PW });
  cookie = login.cookie;
  ok('登录成功', login.status === 200 && !!cookie, String(login.status));
  if (!cookie) {
    console.log('\n无法登录，后续跳过');
    process.exit(1);
  }

  const tag = 'v2' + Date.now().toString(36);
  const accName = '账户-' + tag;
  const acc2Name = '账户B-' + tag;
  const member = '成员-' + tag;
  const merchant = '商家-' + tag;
  const project = '项目-' + tag;

  const cats = (await req('/api/categories')).json.categories || [];
  ok('内置分类树已播种（空库首访自动开通）', cats.length > 100, cats.length + ' 个分类');

  // 自建一对一级/二级分类，避免依赖既有数据（分类名带时间戳，可重复运行）
  const catL1Name = '测试一级-' + tag;
  const catL2Name = '测试二级-' + tag;
  const incCatName = '测试收入-' + tag;
  const c1 = await post('/api/categories', { name: catL1Name, type: 'EXPENSE' });
  const c2 = await post('/api/categories', { name: catL2Name, type: 'EXPENSE', parentId: c1.json.category.id });
  const ci = await post('/api/categories', { name: incCatName, type: 'INCOME' });
  ok('可建一级/二级分类', c1.status === 200 && c2.status === 200 && c2.json.category.parent_id === c1.json.category.id, JSON.stringify({ l1: c1.json.category && c1.json.category.id, l2: c2.json.category && c2.json.category.parent_id }));
  ok('可建收入分类', ci.status === 200, String(ci.status));
  const l1 = c1.json.category;
  const l2 = c2.json.category;

  // ---------- 1.5 分类名唯一性：一个二级分类只能属于一个一级分类 ----------
  console.log('\n=== 分类名唯一 ===');
  const l1b = await post('/api/categories', { name: '测试一级B-' + tag, type: 'EXPENSE' });
  ok('可建第二个一级分类（撞名对照组）', l1b.status === 200 && l1b.json.category.parent_id === null, String(l1b.status));

  const sameAgain = await post('/api/categories', { name: catL2Name, type: 'EXPENSE', parentId: l1.id });
  ok('同父级同名 → 幂等返回既有分类，不新建',
    sameAgain.status === 200 && sameAgain.json.category.id === l2.id,
    JSON.stringify({ status: sameAgain.status, id: sameAgain.json.category && sameAgain.json.category.id }));

  const crossParent = await post('/api/categories', { name: catL2Name, type: 'EXPENSE', parentId: l1b.json.category.id });
  ok('同名二级挂到另一个一级分类下 → 被拦截',
    crossParent.status === 400 && /只能有一个|同名/.test(crossParent.json.error || ''),
    `${crossParent.status} ${crossParent.json.error}`);

  const asRoot = await post('/api/categories', { name: catL2Name, type: 'EXPENSE' });
  ok('一级分类与已有二级同名 → 被拦截', asRoot.status === 400, `${asRoot.status} ${asRoot.json.error}`);

  const padded = await post('/api/categories', { name: '  ' + catL2Name + '  ', type: 'EXPENSE', parentId: l1b.json.category.id });
  ok('首尾带空格也算同名 → 被拦截', padded.status === 400, `${padded.status} ${padded.json.error}`);

  const otherType = await post('/api/categories', { name: catL2Name, type: 'INCOME' });
  ok('不同收支类型可以同名（互不干扰）', otherType.status === 200, String(otherType.status));

  const nested = await post('/api/categories', { name: '测试三级-' + tag, type: 'EXPENSE', parentId: l2.id });
  ok('二级分类下不能再挂子级（最多两级）',
    nested.status === 400 && /两级/.test(nested.json.error || ''),
    `${nested.status} ${nested.json.error}`);

  const ghost = await post('/api/categories', { name: '测试幽灵-' + tag, type: 'EXPENSE', parentId: 'no-such-id' });
  ok('父级不存在 → 被拦截', ghost.status === 400 && /不存在/.test(ghost.json.error || ''), `${ghost.status} ${ghost.json.error}`);

  const renameHit = await put('/api/categories/' + otherType.json.category.id, { name: catL2Name, type: 'EXPENSE' });
  ok('改名撞上已有同名 → 被拦截', renameHit.status === 400, `${renameHit.status} ${renameHit.json.error}`);

  const renameOk = await put('/api/categories/' + otherType.json.category.id, { name: '测试改名OK-' + tag });
  ok('改名不撞车 → 正常通过', renameOk.status === 200 && renameOk.json.category.name === '测试改名OK-' + tag, String(renameOk.status));

  const catCountAfter = ((await req('/api/categories')).json.categories || []).length;
  // 本节之前建了 3 个（一级/二级/收入），本节又建了 2 个（第二个一级 + 跨类型同名）；
  // 其余 6 次请求都被拦下，一条都不该落库
  ok('被拦截的请求没有偷偷写进库（分类总数 +5）',
    catCountAfter === cats.length + 5,
    `${cats.length} → ${catCountAfter}`);

  // ---------- 1. 账户：卡号 / 备注 ----------
  console.log('\n=== 账户 ===');
  const a1 = await post('/api/accounts', {
    name: accName, type: 'DEBIT_CARD', currency: 'CNY', balance: 1000,
    cardNo: '6225****1234', note: '工资卡',
  });
  ok('新增账户带卡号与备注', a1.status === 200 && a1.json.account.cardNo === '6225****1234' && a1.json.account.note === '工资卡', JSON.stringify(a1.json.account));
  const a2 = await post('/api/accounts', { name: acc2Name, type: 'CASH', currency: 'CNY', balance: 0 });
  ok('第二个账户已建（用于转账/排序对照）', a2.status === 200, String(a2.status));

  // ---------- 2. 记账：时分秒 ----------
  console.log('\n=== 记账 ===');
  const t1 = await post('/api/transactions', {
    account: accName, amount: 88, type: 'EXPENSE', category: catL2Name,
    date: '2026-03-05T09:15:30', description: '午饭-' + tag, member, merchant, project,
  });
  ok('记账存下时分秒', t1.status === 200 && t1.json.transaction.time === '09:15:30' && t1.json.transaction.date === '2026-03-05', JSON.stringify(t1.json.transaction));
  ok('交易视图带一级分类名（二级交易上卷）',
    t1.json.transaction.categoryParent === catL1Name && t1.json.transaction.category === catL2Name,
    JSON.stringify({ l1: t1.json.transaction.categoryParent, l2: t1.json.transaction.category }));
  const t2 = await post('/api/transactions', {
    account: accName, amount: 500, type: 'INCOME', category: incCatName,
    date: '2026-03-06T20:00:00', description: '工资-' + tag, member, merchant, project,
  });
  ok('收入记账成功', t2.status === 200 && t2.json.transaction.type === 'INCOME', String(t2.status));
  const t3 = await post('/api/transactions', {
    account: acc2Name, amount: 12, type: 'EXPENSE', category: catL2Name,
    date: '2025-12-31', description: '跨年-' + tag,
  });
  ok('跨年记账成功（无时分秒）', t3.status === 200 && t3.json.transaction.time === null, JSON.stringify(t3.json.transaction));

  // 年份 / 一级分类 / 关键词
  const yearQ = await req('/api/transactions?year=2026&account=' + encodeURIComponent(accName));
  ok('按年查询只回 2026 的两笔', yearQ.json.total === 2, 'total=' + (yearQ.json && yearQ.json.total));
  const yearQ2 = await req('/api/transactions?year=2025&account=' + encodeURIComponent(acc2Name));
  ok('按年查询能查到 2025 那笔', yearQ2.json.total === 1, 'total=' + (yearQ2.json && yearQ2.json.total));
  const catQ = await req('/api/transactions?categoryId=' + encodeURIComponent(l1.id) + '&account=' + encodeURIComponent(accName));
  ok('按一级分类 id 命中其二级交易', catQ.json.total === 1 && catQ.json.transactions[0].amount === 88, 'total=' + (catQ.json && catQ.json.total));
  const qQ = await req('/api/transactions?q=' + encodeURIComponent('工资-' + tag));
  ok('按说明关键词查询', qQ.json.total === 1 && qQ.json.transactions[0].type === 'INCOME', 'total=' + (qQ.json && qQ.json.total));
  ok('列表带 total（不受 limit 影响）', typeof yearQ.json.total === 'number' && yearQ.json.total >= yearQ.json.count, `${yearQ.json.total}/${yearQ.json.count}`);

  // ---------- 2.1 分页（page / pageSize / sum） ----------
  console.log('\n=== 明细分页 ===');
  const pageAcc = '分页账户-' + tag;
  const pageAmounts = [10, 20, 30, 40, 50, 60, 70]; // 支出 10+30+50+70=160，收入 20+40+60=120
  for (let i = 0; i < pageAmounts.length; i++) {
    await post('/api/transactions', {
      account: pageAcc,
      type: i % 2 ? 'INCOME' : 'EXPENSE',
      amount: pageAmounts[i],
      date: `2026-05-${String(i + 1).padStart(2, '0')}`,
      description: '分页-' + tag,
    });
  }
  const pageBase = '/api/transactions?account=' + encodeURIComponent(pageAcc);
  const p1 = await req(`${pageBase}&page=1&pageSize=3`);
  ok('第 1 页只回 3 条', p1.json.count === 3 && p1.json.transactions.length === 3, `count=${p1.json.count}`);
  ok('total / pages / page / pageSize 都对',
    p1.json.total === 7 && p1.json.pages === 3 && p1.json.page === 1 && p1.json.pageSize === 3,
    JSON.stringify({ total: p1.json.total, pages: p1.json.pages, page: p1.json.page, pageSize: p1.json.pageSize }));
  ok('sum 是跨页全部合计（支出 160 / 收入 120 / 净 -40）',
    p1.json.sum && p1.json.sum.expense === 160 && p1.json.sum.income === 120 && p1.json.sum.net === -40,
    JSON.stringify(p1.json.sum));

  const p3 = await req(`${pageBase}&page=3&pageSize=3`);
  ok('末页只剩 1 条', p3.json.count === 1 && p3.json.page === 3, `count=${p3.json.count} page=${p3.json.page}`);
  ok('sum 与页码无关（末页仍是全量合计）',
    p3.json.sum && p3.json.sum.expense === 160 && p3.json.sum.income === 120, JSON.stringify(p3.json.sum));

  const pAll = await req(`${pageBase}&page=1&pageSize=1000`);
  ok('pageSize=1000 一次拿全（1 页 7 条）', pAll.json.count === 7 && pAll.json.pages === 1, `${pAll.json.count}/${pAll.json.pages}`);

  const pCompat = await req(`${pageBase}&limit=2&offset=4`);
  ok('旧参数 limit/offset 仍可用（page 由 offset 反推）',
    pCompat.json.count === 2 && pCompat.json.page === 3, JSON.stringify({ count: pCompat.json.count, page: pCompat.json.page }));

  const pOver = await req(`${pageBase}&page=9&pageSize=3`);
  ok('页码越界返回空列表但 total 不变（前端据此回末页）',
    pOver.json.count === 0 && pOver.json.total === 7, `count=${pOver.json.count} total=${pOver.json.total}`);
  ok('越界页的 sum 仍是全量',
    pOver.json.sum && pOver.json.sum.expense === 160, JSON.stringify(pOver.json.sum));

  // ---------- 3. 余额调整 ----------
  console.log('\n=== 余额调整 ===');
  const list1 = (await req('/api/accounts?includeArchived=1')).json.accounts.find((x) => x.name === accName);
  ok('账户余额是「期初 + 流水」', Number(list1.balance) === 1412, 'balance=' + list1.balance);
  ok('同时保留期初余额字段', Number(list1.openingBalance) === 1000, 'opening=' + list1.openingBalance);

  const up = await put('/api/accounts/' + list1.id, { balance: 2000 });
  ok('余额上调生成收入调整流水', up.json.adjustment && up.json.adjustment.type === 'INCOME' && up.json.adjustment.amount === 588, JSON.stringify(up.json.adjustment));
  ok('调整流水备注为余额调整', up.json.adjustment && /余额调整/.test(up.json.adjustment.description), up.json.adjustment && up.json.adjustment.description);
  const afterUp = (await req('/api/accounts?includeArchived=1')).json.accounts.find((x) => x.name === accName);
  ok('上调后余额等于目标值', Number(afterUp.balance) === 2000, 'balance=' + afterUp.balance);

  const down = await put('/api/accounts/' + list1.id, { balance: 1500 });
  ok('余额下调生成「其他费用」支出流水', down.json.adjustment && down.json.adjustment.type === 'EXPENSE' && down.json.adjustment.category === '其他费用' && down.json.adjustment.amount === 500, JSON.stringify(down.json.adjustment));
  const afterDown = (await req('/api/accounts?includeArchived=1')).json.accounts.find((x) => x.name === accName);
  ok('下调后余额等于目标值', Number(afterDown.balance) === 1500, 'balance=' + afterDown.balance);

  const direct = await put('/api/accounts/' + list1.id, { balance: 3000, adjustBalance: false });
  const afterDirect = (await req('/api/accounts?includeArchived=1')).json.accounts.find((x) => x.name === accName);
  ok('adjustBalance:false 直接改期初、不生成流水', direct.json.adjustment === null && Number(afterDirect.openingBalance) === 3000, JSON.stringify({ adj: direct.json.adjustment, opening: afterDirect.openingBalance }));

  const renamed = await put('/api/accounts/' + list1.id, { name: accName + '-改', cardNo: '6225****9999', note: '改过', currency: 'USD' });
  ok('可改名称/卡号/备注/币种', renamed.json.account.name === accName + '-改' && renamed.json.account.cardNo === '6225****9999' && renamed.json.account.note === '改过' && renamed.json.account.currency === 'USD', JSON.stringify(renamed.json.account));

  // ---------- 4. 选择器排序 ----------
  console.log('\n=== 下拉排序 ===');
  const sel = (await req('/api/selectors')).json;
  ok('/api/selectors 返回五类数据', ['accounts', 'members', 'merchants', 'projects', 'categories'].every((k) => Array.isArray(sel[k])), Object.keys(sel).join(','));
  const accTop = sel.accounts.findIndex((x) => x.name === accName + '-改');
  const accBottom = sel.accounts.findIndex((x) => x.name === acc2Name);
  ok('常用账户排在前面', accTop < accBottom, `${accTop} < ${accBottom}`);
  const l1Sel = sel.categories.find((c) => c.id === l1.id);
  ok('一级分类 used 含子级用量', l1Sel && l1Sel.used >= 1, l1Sel ? String(l1Sel.used) : '未找到');
  ok('分类带 parentId 便于前端联动', sel.categories.every((c) => c.parentId === null || typeof c.parentId === 'string'));

  // ---------- 5. 报表 ----------
  console.log('\n=== 报表 ===');
  const rep = await req('/api/reports/overview?member=' + encodeURIComponent(member));
  const rj = rep.json || {};
  ok('按成员筛选：收入 500 / 支出 88', rj.totals && rj.totals.income === 500 && rj.totals.expense === 88, JSON.stringify(rj.totals));
  ok('结余 = 收入 - 支出', rj.totals && rj.totals.net === 412, JSON.stringify(rj.totals));
  ok('收入按一级分类', (rj.incomeByCategory || []).some((x) => x.name === incCatName && x.income === 500), JSON.stringify(rj.incomeByCategory));
  ok('支出二级上卷到一级', (rj.expenseByCategory || []).some((x) => x.name === catL1Name && x.expense === 88), JSON.stringify(rj.expenseByCategory));
  ok('账户维度带收入与支出两列', (rj.byAccount || []).some((x) => x.income === 500 && x.expense === 88), JSON.stringify(rj.byAccount));
  ok('商家维度命中自造商家', (rj.byMerchant || []).some((x) => x.name === merchant), JSON.stringify(rj.byMerchant));
  ok('项目维度命中自造项目', (rj.byProject || []).some((x) => x.name === project), JSON.stringify(rj.byProject));

  const repType = await req('/api/reports/overview?member=' + encodeURIComponent(member) + '&type=EXPENSE');
  ok('类型筛选只算支出', repType.json.totals.income === 0 && repType.json.totals.expense === 88, JSON.stringify(repType.json.totals));
  ok('类型筛选下收入分类为空', (repType.json.incomeByCategory || []).length === 0);

  const repQ = await req('/api/reports/overview?q=' + encodeURIComponent('午饭-' + tag));
  ok('备注关键词筛选', repQ.json.totals.count === 1 && repQ.json.totals.expense === 88, JSON.stringify(repQ.json.totals));
  const repDate = await req('/api/reports/overview?from=2026-03-06&to=2026-03-06&member=' + encodeURIComponent(member));
  ok('日期区间筛选', repDate.json.totals.count === 1 && repDate.json.totals.income === 500, JSON.stringify(repDate.json.totals));

  // 转账不计入收支
  const tr = await post('/api/transactions', {
    type: 'TRANSFER', account: accName + '-改', toAccount: acc2Name, amount: 100,
    date: '2026-03-07T10:00:00', description: '转账-' + tag,
  });
  ok('转账记账成功', tr.status === 200 && tr.json.transaction.type === 'TRANSFER', String(tr.status));
  const repTr = await req('/api/reports/overview?q=' + encodeURIComponent('转账-' + tag));
  ok('转账不计入收支统计', repTr.json.totals.count === 0 && repTr.json.totals.income === 0, JSON.stringify(repTr.json.totals));
  const transferList = await req('/api/transactions?type=TRANSFER&q=' + encodeURIComponent('转账-' + tag));
  ok('转账仍能在明细里查到', transferList.json.total === 1, 'total=' + (transferList.json && transferList.json.total));

  // ---------- 6. 首页口径 ----------
  console.log('\n=== 首页 ===');
  // 首页「本月交易」走 dashboard.js 的 TX_SELECT，和 tx_list 是两条路径，得单独验一遍
  const todayStr = (() => {
    const d = new Date(); const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  })();
  await post('/api/transactions', { account: accName, amount: 7, type: 'EXPENSE', category: catL2Name, date: todayStr, description: '本月-' + tag });
  const sum = await req('/api/summary');
  const sj = sum.json || {};
  ok('有累计记账天数与明细数', typeof sj.totalDays === 'number' && typeof sj.totalTxCount === 'number', `${sj.totalDays} 天 / ${sj.totalTxCount} 笔`);
  ok('累计天数与明细数口径不同（天数 ≤ 笔数）', sj.totalDays <= sj.totalTxCount, `${sj.totalDays} <= ${sj.totalTxCount}`);
  ok('有本月收入/支出/结余', [sj.monthIncome, sj.monthExpense, sj.monthNet].every((x) => typeof x === 'number'), JSON.stringify({ i: sj.monthIncome, e: sj.monthExpense, n: sj.monthNet }));
  ok('本月结余 = 收入 - 支出', Math.abs(sj.monthNet - (sj.monthIncome - sj.monthExpense)) < 0.01);
  ok('有本月分类饼图数据', Array.isArray(sj.monthExpenseByCategoryL1));
  ok('趋势每月带 income/expense/net', (sj.trend || []).length === 12 && sj.trend.every((t) => typeof t.net === 'number'), JSON.stringify(sj.trend[2]));
  const mt = (sj.monthTransactions || []).find((t) => t.description === '本月-' + tag);
  ok('首页本月交易带一级分类名与目标账户字段',
    !!mt && mt.categoryParent === catL1Name && mt.category === catL2Name && 'toAccount' in mt,
    JSON.stringify(mt || null));

  console.log(`\n结果：${pass} 通过 / ${failures.length} 失败`);
  if (failures.length) {
    console.log('失败项：');
    for (const f of failures) console.log('  - ' + f);
  }
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e && e.stack ? e.stack : e);
  process.exit(2);
});
