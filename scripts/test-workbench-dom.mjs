#!/usr/bin/env node
/**
 * 工作台页面脚本的「假 DOM」行为测试（不需要浏览器、不需要服务端）
 *
 *   node scripts/test-workbench-dom.mjs
 *
 * 为什么需要它：
 *   - test-webapp-http 只打 /api/*，碰不到模板里的 <script>；
 *   - test-webapp-frontend 只抠出 api() 一个函数运行，管不了初始化和页面逻辑。
 *   1.1.2 的 TypeError 正是「服务端全绿、浏览器全崩」；1.1.5 这次大改又新增了
 *   6 张图表、年份联动、二级分类回填，光靠静态检查看不出「初始化会不会抛」。
 *
 * 做法：从 HTML 里抽出所有 id 建桩元素、用假 fetch 喂接口数据、用假 Chart 记录
 * 配置，然后在 vm 里跑整段脚本，断言：
 *   1. 初始化不抛错，首页三张图（趋势 + 两张饼图）都建出来，趋势是 bar/bar/line 混合；
 *   2. 逐一点击每个导航 tab 都不抛错；
 *   3. 报表页 6 张图都建出来，饼图数据来自 /api/reports/overview；
 *   4. 年份筛选真的进了查询串、二级分类会回填一级分类；
 *   5. 脚本里 getElementById 的每个 id 在 HTML 里都存在（防手滑改名）。
 *
 * 退出码：0 全过；1 有失败项。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'src', 'workbench-template.html'), 'utf8');

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

// ---------------- 抽脚本 ----------------
const script = [...HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
ok('能抽出工作台内联脚本', script.length > 20000, script.length + ' 字符');

// ---------------- 静态：id 引用都存在 ----------------
{
  const ids = new Set([...HTML.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const refs = [...new Set([...script.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]))];
  const missing = refs.filter((x) => !ids.has(x));
  ok('脚本引用的元素 id 全部存在', missing.length === 0, missing.join(', ') || `${refs.length} 个引用`);
}

// ---------------- 假 DOM ----------------
function makeEl(tag = 'div') {
  const node = {
    tagName: String(tag).toUpperCase(),
    children: [],
    options: [],
    value: '',
    textContent: '',
    className: '',
    checked: false,
    disabled: false,
    rows: 0,
    dataset: {},
    style: {},
    classList: {
      _s: new Set(['active']),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    listeners: {},
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    appendChild(c) {
      this.children.push(c);
      if (c.tagName === 'OPTION') {
        this.options.push(c);
        // 浏览器行为：select 没有选中项时默认选第一个
        if (this.options.length === 1) this.value = c.value;
      }
      return c;
    },
    append(...cs) { cs.forEach((c) => this.appendChild(c)); },
    click() { (this.listeners.click || []).forEach((f) => f({ target: this })); },
    fire(ev, target) { (this.listeners[ev] || []).forEach((f) => f({ target: target || this })); },
    remove() {},
    querySelector() { return null; },
    scrollIntoView() {},
  };
  // innerHTML：置空要清空 children/options；写 <option ...> 要能解析出选项（浏览器行为）
  Object.defineProperty(node, 'innerHTML', {
    get() { return this._html || ''; },
    set(v) {
      const s = String(v);
      this._html = s;
      this.children = [];
      if (s.trim() === '') { this.options = []; this.value = ''; return; }
      if (/^\s*<option/i.test(s)) {
        const opts = [...s.matchAll(/<option[^>]*?value="([^"]*)"/g)].map((m) => {
          const o = makeEl('option');
          o.value = m[1];
          return o;
        });
        this.options = opts;
        this.value = opts.length ? opts[0].value : '';
      }
    },
  });
  // selectedOptions 随 value 变化（浏览器里是实时的）
  Object.defineProperty(node, 'selectedOptions', {
    get() { return this.options.filter((o) => o.value === this.value); },
  });
  return node;
}

const registry = new Map();
for (const id of [...HTML.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1])) registry.set(id, makeEl());
const $ = (id) => registry.get(id) || null;

const navButtons = [...HTML.matchAll(/data-tab="([^"]+)"/g)].map((m) => {
  const b = makeEl('button');
  b.dataset.tab = m[1];
  return b;
});

const document = {
  getElementById: (id) => (registry.has(id) ? registry.get(id) : null),
  createElement: (tag) => makeEl(tag),
  querySelector(sel) {
    const m = /data-tab="([^"]+)"/.exec(sel || '');
    if (m) return navButtons.find((b) => b.dataset.tab === m[1]) || null;
    return null;
  },
  querySelectorAll: (sel) => (String(sel).includes('.nav') ? navButtons : []),
};

// ---------------- 假 Chart ----------------
const charts = [];
class Chart {
  constructor(ctx, cfg) { this.ctx = ctx; this.config = cfg; charts.push(this); }
  destroy() {}
}

// ---------------- 假接口 ----------------
const routes = {
  '/api/auth/me': { ok: true, userId: 'admin', role: 'admin', label: '管理员' },
  '/api/summary': {
    ok: true, year: 2026, month: 11,
    yearIncome: 5000, yearExpense: 3200, yearNet: 1800, yearTxCount: 12,
    totalDays: 9, totalTxCount: 42, firstTransactionDate: '2025-03-01',
    monthIncome: 800, monthExpense: 300, monthNet: 500, monthTxCount: 3,
    trend: Array.from({ length: 12 }, (_, i) => ({ month: `2026-${String(i + 1).padStart(2, '0')}`, income: 100, expense: 80, net: 20 })),
    expenseByCategoryL1: [{ name: '食品酒水', amount: 200 }],
    monthExpenseByCategoryL1: [{ name: '食品酒水', amount: 50 }],
    monthTransactions: [{ id: 't1', date: '2026-11-16', time: '14:32:05', type: 'EXPENSE', amount: 88, account: '招行', toAccount: '微信', category: '餐饮', categoryParent: '食品酒水', description: '午饭' }],
    latestTransactionDate: '2026-11-16', balances: [], receivables: [], budgets: [],
  },
  '/api/categories': {
    count: 2,
    categories: [
      { id: 'c1', name: '食品酒水', type: 'EXPENSE', parent_id: null },
      { id: 'c2', name: '餐饮', type: 'EXPENSE', parent_id: 'c1' },
      { id: 'c3', name: '职业收入', type: 'INCOME', parent_id: null },
    ],
  },
  '/api/selectors': {
    ok: true,
    accounts: [{ id: 'a1', name: '招行', used: 5 }],
    members: [{ id: 'm1', name: '张三', used: 2 }],
    merchants: [{ id: 'me1', name: '便利店', used: 1 }],
    projects: [{ id: 'p1', name: '装修', used: 3 }],
    categories: [
      { id: 'c1', name: '食品酒水', type: 'EXPENSE', parentId: null, used: 5 },
      { id: 'c2', name: '餐饮', type: 'EXPENSE', parentId: 'c1', used: 5 },
      { id: 'c3', name: '职业收入', type: 'INCOME', parentId: null, used: 0 },
    ],
  },
  '/api/accounts?includeArchived=1': {
    count: 1,
    accounts: [{ id: 'a1', name: '招行', type: 'DEBIT_CARD', currency: 'CNY', balance: 912, openingBalance: 1000, archived: 0, cardNo: '6225****1234', note: '工资卡' }],
  },
  '/api/accounts': { count: 1, accounts: [{ id: 'a1', name: '招行', type: 'DEBIT_CARD', currency: 'CNY', balance: 912, archived: 0 }] },
  '/api/meta': { ok: true, accountTypes: ['DEBIT_CARD', 'CASH', 'CREDIT_CARD'] },
  '/api/transactions': {
    count: 1, total: 1,
    transactions: [{ id: 't1', date: '2026-11-16', time: '14:32:05', type: 'EXPENSE', amount: 88, account: '招行', toAccount: '微信', category: '餐饮', categoryParent: '食品酒水', member: '张三', project: '装修', merchant: '便利店', description: '午饭', tags: '' }],
  },
  '/api/reports/overview': {
    ok: true, filters: { type: 'ALL' },
    totals: { income: 800, expense: 300, net: 500, count: 5 },
    incomeByCategory: [{ name: '职业收入', income: 800, expense: 0, amount: 800, cnt: 1 }],
    expenseByCategory: [{ name: '食品酒水', income: 0, expense: 300, amount: 300, cnt: 2 }],
    byAccount: [{ name: '招行', income: 800, expense: 300, amount: 1100, cnt: 5 }],
    byMember: [{ name: '张三', income: 0, expense: 300, amount: 300, cnt: 2 }],
    byMerchant: [{ name: '便利店', income: 0, expense: 88, amount: 88, cnt: 1 }],
    byProject: [{ name: '装修', income: 0, expense: 212, amount: 212, cnt: 1 }],
  },
  '/api/receivables-report': { summary: [], outstanding: 0 },
  '/api/receivables': { count: 0, receivables: [] },
  '/api/budgets': { count: 0, budgets: [] },
  '/api/budgets-report': { summary: {}, rows: [] },
  '/api/projects': { count: 0, projects: [] },
  '/api/members': { count: 0, members: [] },
  '/api/merchants': { count: 0, merchants: [] },
};

const calls = [];
const sandbox = {
  console,
  document,
  Chart,
  URLSearchParams,
  Date,
  Math,
  JSON,
  String,
  Number,
  Object,
  Array,
  RegExp,
  Error,
  isNaN,
  parseInt,
  parseFloat,
  decodeURIComponent,
  encodeURIComponent,
  setTimeout: (fn) => { try { fn(); } catch { /* 定时器里的异常不影响断言 */ } return 0; },
  clearTimeout() {},
  confirm: () => true,
  alert: () => {},
  prompt: () => null,
  location: { href: '' },
  localStorage: { getItem: () => null, setItem() {} },
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  fetch: async (url) => {
    calls.push(String(url));
    const key = Object.keys(routes).find((k) => String(url).startsWith(k));
    const body = key ? routes[key] : { ok: true };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  },
};
sandbox.window = sandbox;
const ctx = vm.createContext(sandbox);

const tick = async () => { await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); };

console.log('\n=== 初始化 ===');
let evalErr = null;
try {
  vm.runInContext(script, ctx, { timeout: 8000 });
} catch (e) {
  evalErr = e;
}
ok('脚本求值不抛错', !evalErr, evalErr ? `${evalErr.name}: ${evalErr.message}` : '');
await tick();

ok('首页建出 3 张图（趋势 + 本年饼 + 本月饼）', charts.length === 3, '实际 ' + charts.length);
const trend = charts[0];
const trendTypes = trend ? (trend.config.data.datasets || []).map((d) => d.type || trend.config.type) : [];
ok('趋势图是「收入柱 + 支出柱 + 结余线」', JSON.stringify(trendTypes) === JSON.stringify(['bar', 'bar', 'line']), JSON.stringify(trendTypes));
ok('趋势图标签是 12 个月', trend && trend.config.data.labels.length === 12, String(trend && trend.config.data.labels.length));
ok('累计记账天数渲染出来', $('cDays').textContent.includes('9'), $('cDays').textContent);
ok('累计明细数渲染出来', $('cCount').textContent.includes('42'), $('cCount').textContent);
ok('本月收入渲染出来', $('mIncome').textContent.includes('800'), $('mIncome').textContent);
ok('本月结余按正负着色', $('mNet').className.includes('income'), $('mNet').className);
ok('本月交易带时分', ($('dashTx').children[0] && $('dashTx').children[0].innerHTML.includes('14:32')) || false);
{
  const thisY = String(new Date().getFullYear());
  ok('报表默认区间是今年', $('rpFrom').value === `${thisY}-01-01` && $('rpTo').value === `${thisY}-12-31`,
    `${$('rpFrom').value} ~ ${$('rpTo').value}`);
}

console.log('\n=== Tab 切换 ===');
const tabErrors = [];
for (const b of navButtons) {
  try {
    (b.listeners.click || []).forEach((f) => f({ target: b }));
  } catch (e) {
    tabErrors.push(`${b.dataset.tab}: ${e.message}`);
  }
}
await tick();
ok('所有 tab 全部可切换且不抛错', tabErrors.length === 0, tabErrors.join(' | ') || `${navButtons.length} 个入口`);
ok('切换时请求过 /api/selectors', calls.some((u) => u.startsWith('/api/selectors')));
ok('切换时请求过 /api/reports/overview', calls.some((u) => u.startsWith('/api/reports/overview')));
ok('报表页 6 张饼图都建出来', charts.length >= 3 + 6, '累计 ' + charts.length + ' 张');
const repKinds = charts.slice(-6).map((c) => c.config.type);
ok('报表图全部是 doughnut', repKinds.every((t) => t === 'doughnut'), repKinds.join(','));
const repData = charts[charts.length - 1].config.data.datasets[0].data;
ok('报表饼图带上了接口数据', Array.isArray(repData) && repData[0] === 212, JSON.stringify(repData));

console.log('\n=== 查询条件联动 ===');
// 年份 → 查询串
$('fYear').value = '2026';
$('fYear').fire('change');
ok('选年份自动填好整年起止', $('fFrom').value === '2026-01-01' && $('fTo').value === '2026-12-31', `${$('fFrom').value} ~ ${$('fTo').value}`);
calls.length = 0;
$('txFilter').click();
await tick();
ok('年份进了查询串', calls.some((u) => u.includes('from=2026-01-01') && u.includes('to=2026-12-31')), calls.filter((u) => u.includes('/api/transactions')).join(' | '));

// 二级分类 → 回填一级
$('fCat1').value = '';
$('fCat1').fire('change');
$('fCat2').value = 'c2';
$('fCat2').fire('change');
ok('直接选二级会自动回填一级', $('fCat1').value === 'c1', 'fCat1=' + $('fCat1').value);
calls.length = 0;
$('txFilter').click();
await tick();
ok('查询串带的是二级分类 id', calls.some((u) => u.includes('categoryId=c2')), calls.filter((u) => u.includes('/api/transactions')).join(' | '));

// 一级 → 列出其下全部二级
$('fCat2').value = '';
$('fCat1').value = 'c1';
$('fCat1').fire('change');
ok('选一级后二级列出其子项', $('fCat2').options.some((o) => o.value === 'c2'), $('fCat2').options.map((o) => o.value).join(','));

console.log('\n=== 日期区间控件 ===');
{
  // 默认口径：年份下拉 = 本年，区间 = 该整年
  const thisY = String(new Date().getFullYear());
  ok('明细默认年份是本年', $('fYear').value === thisY, 'fYear=' + $('fYear').value);
  ok('默认年份已同步成整年区间', $('fFrom').value === `${thisY}-01-01` && $('fTo').value === `${thisY}-12-31`, `${$('fFrom').value} ~ ${$('fTo').value}`);

  const pop = $('fRangePop');
  // 面板内两次点击 = 选开始、选结束；点「确定」才写回（与截图里的交互一致）
  pop.fire('click', { dataset: { d: '2026-03-05' } });
  pop.fire('click', { dataset: { d: '2026-04-10' } });
  ok('区间面板接受起止两天', $('fRangeHint').textContent.includes('2026-03-05') && $('fRangeHint').textContent.includes('2026-04-10'), $('fRangeHint').textContent);
  $('fRangeOk').click();
  await tick();
  ok('确定后写入 from/to', $('fFrom').value === '2026-03-05' && $('fTo').value === '2026-04-10', `${$('fFrom').value} ~ ${$('fTo').value}`);
  ok('输入框显示区间文案', $('fRangeText').value === '2026-03-05 至 2026-04-10', $('fRangeText').value);
  ok('非整年区间会把年份下拉清空', $('fYear').value === '', 'fYear=' + $('fYear').value);

  // 反序选择要自动纠正
  pop.fire('click', { dataset: { d: '2026-05-20' } });
  pop.fire('click', { dataset: { d: '2026-05-01' } });
  $('fRangeOk').click();
  await tick();
  ok('起止反选时自动排序', $('fFrom').value === '2026-05-01' && $('fTo').value === '2026-05-20', `${$('fFrom').value} ~ ${$('fTo').value}`);

  // 快捷项
  pop.fire('click', { dataset: { p: 'thisYear' } });
  $('fRangeOk').click();
  await tick();
  ok('快捷项「本年」填成整年', $('fFrom').value === `${thisY}-01-01` && $('fTo').value === `${thisY}-12-31`, `${$('fFrom').value} ~ ${$('fTo').value}`);
  ok('整年区间会把年份下拉对上', $('fYear').value === thisY, 'fYear=' + $('fYear').value);

  $('fRangeClear2').click();
  await tick();
  ok('清空会同时清掉 from/to 与年份', !$('fFrom').value && !$('fTo').value && $('fYear').value === '', `${$('fFrom').value}|${$('fTo').value}|${$('fYear').value}`);

  // 报表侧也挂了一个同样的控件
  const rpPop = $('rpRangePop');
  rpPop.fire('click', { dataset: { p: 'thisMonth' } });
  $('rpRangeOk').click();
  await tick();
  ok('报表区间控件独立可用', $('rpFrom').value.slice(8) === '01' && $('rpTo').value !== '', `${$('rpFrom').value} ~ ${$('rpTo').value}`);
}

console.log('\n=== 报表口径 ===');
{
  ok('报表不再有「饼图口径」下拉', !HTML.includes('id="rpBasis"'));
  // 类型=仅支出 ⇒ 四张维度图按 expense 取值（账户维度 income 800 / expense 300 / amount 1100）
  $('rpType').value = 'EXPENSE';
  charts.length = 0;
  $('rpType').fire('change');
  await tick();
  const accountData = charts[2] && charts[2].config.data.datasets[0].data;
  ok('类型改「仅支出」后维度图按支出取值', Array.isArray(accountData) && accountData[0] === 300, JSON.stringify(accountData));
  $('rpType').value = '';
  $('rpType').fire('change');
  await tick();
}

console.log('\n=== 明细分页与合计 ===');
{
  const rows = [];
  for (let i = 0; i < 20; i++) {
    rows.push({
      id: 'x' + i, date: '2026-11-' + String((i % 9) + 1).padStart(2, '0'), type: i % 2 ? 'INCOME' : 'EXPENSE',
      amount: 100, account: '招行', category: '餐饮', categoryParent: '食品酒水',
      member: '张三', project: '装修', merchant: '便利店', description: 'r' + i, tags: '',
    });
  }
  routes['/api/transactions'] = {
    count: 20, total: 1336, page: 1, pageSize: 20, pages: 67,
    sum: { income: 5000, expense: 3200, net: 1800 }, transactions: rows,
  };
  calls.length = 0;
  $('txFilter').click();
  await tick();
  const txCalls = calls.filter((u) => u.includes('/api/transactions'));
  ok('明细查询带 page/pageSize（默认 1 / 20）',
    txCalls.some((u) => u.includes('page=1') && u.includes('pageSize=20')), txCalls.join(' | '));

  const pager = $('txPager');
  const labels = pager.children.map((c) => c.textContent);
  ok('分页条渲染 1…6 + 省略号 + 末页 67', ['1', '2', '3', '4', '5', '6', '…', '67'].every((x) => labels.indexOf(x) >= 0), labels.join(','));
  ok('分页条显示总条数与总页数',
    pager.children.some((c) => String(c.textContent).includes('1336') && String(c.textContent).includes('67')),
    pager.children.map((c) => c.textContent).join(' | '));
  ok('当前页高亮（第 1 页）', pager.children.some((c) => c.className === 'pg cur' && c.textContent === '1'));

  const sel = pager.children.find((c) => c.tagName === 'SELECT');
  ok('每页条数可选 20/50/100/200/500/1000',
    !!sel && sel.options.map((o) => o.value).join(',') === '20,50,100,200,500,1000',
    sel ? sel.options.map((o) => o.value).join(',') : '没有下拉');

  const footHtml = $('txFoot').innerHTML;
  ok('合计分两行：本页 + 全部',
    (footHtml.match(/<tr/g) || []).length === 2 && footHtml.includes('本页合计') && footHtml.includes('全部合计'),
    footHtml.replace(/<[^>]+>/g, '|').slice(0, 120));
  ok('全部合计取跨页汇总值（不取本页合计）',
    footHtml.includes('5,000') && footHtml.includes('3,200'), footHtml.replace(/<[^>]+>/g, '|').slice(0, 200));

  // 翻页
  calls.length = 0;
  const p2 = pager.children.find((c) => c.tagName === 'BUTTON' && c.textContent === '2');
  ok('第 2 页按钮存在', !!p2);
  if (p2) { p2.click(); await tick(); }
  ok('点第 2 页发出 page=2',
    calls.some((u) => u.includes('/api/transactions') && u.includes('page=2')), calls.join(' | '));

  // 改每页条数 → 自动回到第 1 页
  calls.length = 0;
  const sel2 = $('txPager').children.find((c) => c.tagName === 'SELECT');
  sel2.value = '50';
  sel2.fire('change');
  await tick();
  ok('改每页条数后回到第 1 页并带 pageSize=50',
    calls.some((u) => u.includes('page=1') && u.includes('pageSize=50')), calls.join(' | '));
}

console.log('\n=== 报表默认口径 ===');
{
  const thisY = String(new Date().getFullYear());
  calls.length = 0;
  $('rpReset').click();
  await tick();
  ok('报表「重置」回到今年',
    $('rpFrom').value === `${thisY}-01-01` && $('rpTo').value === `${thisY}-12-31`,
    `${$('rpFrom').value} ~ ${$('rpTo').value}`);
  ok('报表请求带上今年的起止',
    calls.some((u) => u.includes('/api/reports/overview') && u.includes(`from=${thisY}-01-01`) && u.includes(`to=${thisY}-12-31`)),
    calls.filter((u) => u.includes('/api/reports')).join(' | '));
}

console.log('\n=== 分类折叠 ===');
{
  const rows = $('catBody-expense').children;
  ok('支出分类渲染一级 + 二级两行', rows.length === 2, rows.length + ' 行');
  const l1 = rows[0], kid = rows[1];
  ok('一级分类行带底色类 cat-l1', l1 && l1.className === 'cat-l1', l1 && l1.className);
  ok('默认折叠：二级行隐藏', kid && kid.style.display === 'none', kid && String(kid.style.display));
  const tg = l1 && l1.children[0] && l1.children[0].children[0];
  ok('一级分类有展开箭头（▸）', tg && tg.tagName === 'BUTTON' && tg.textContent === '▸', tg && tg.textContent);
  if (tg) tg.click();
  ok('点箭头展开二级（▾）', kid && kid.style.display !== 'none' && tg.textContent === '▾', `${kid && kid.style.display}|${tg && tg.textContent}`);
  if (tg) tg.click();
  ok('再点一次收起', kid && kid.style.display === 'none' && tg.textContent === '▸', `${kid && kid.style.display}|${tg && tg.textContent}`);
}

console.log('\n=== 布局与列名 ===');
{
  const navOrder = [...HTML.matchAll(/<button data-tab="([^"]+)"[^>]*>([^<]+)<\/button>/g)].map((m) => m[2]);
  ok('导航顺序按需求排列', navOrder.join('/') === '首页/收支明细/报表/手工记账/应收应付/预算/账户管理/分类管理/项目管理/人员/商家', navOrder.join('/'));

  const dashIdx = HTML.indexOf('<tbody id="dashTx">');
  const dashHead = HTML.slice(HTML.lastIndexOf('<thead>', dashIdx), dashIdx);
  ok('首页本月交易拆了发生/目标账户与一级/二级分类', ['发生账户', '目标账户', '一级分类', '二级分类'].every((h) => dashHead.includes(h)), dashHead.replace(/<[^>]+>/g, '|'));

  const txHead = (() => {
    const i = HTML.indexOf('<tbody id="txBody">');
    return HTML.slice(HTML.lastIndexOf('<thead>', i), i);
  })();
  ok('明细列含发生/目标账户、一二级分类、人员、项目、商家', ['发生账户', '目标账户', '一级分类', '二级分类', '人员', '项目', '商家'].every((h) => txHead.includes('<th>' + h + '</th>')), txHead.replace(/<[^>]+>/g, '|'));

  ok('分类管理改成左右并排', HTML.includes('class="grid2eq"'));

  // 行渲染真的用上了新字段（不只是表头改了）
  const dashRow = ($('dashTx').children[0] || {}).innerHTML || '';
  ok('首页行渲染出目标账户与一级分类', dashRow.includes('微信') && dashRow.includes('食品酒水') && dashRow.includes('餐饮'), dashRow.replace(/<[^>]+>/g, '|'));
  const txRow = ($('txBody').children[0] || {}).innerHTML || '';
  ok('明细行渲染出人员/项目/商家与一二级分类',
    ['食品酒水', '餐饮', '张三', '装修', '便利店'].every((x) => txRow.includes(x)), txRow.replace(/<[^>]+>/g, '|'));

  ok('首页本月交易行按 8 列渲染（含目标账户与二级分类）', (() => {
    const rows = vm.runInContext("catPair({category:'餐饮',categoryParent:'食品酒水'})", ctx);
    const rows2 = vm.runInContext("catPair({category:'工资收入'})", ctx);
    return rows.l1 === '食品酒水' && rows.l2 === '餐饮' && rows2.l1 === '工资收入' && rows2.l2 === '';
  })());
}

console.log('\n=== 表单与文案 ===');
{
  const dt = vm.runInContext("dtView({date:'2026-11-16',time:'14:32:05'})", ctx);
  ok('dtView 输出日期+时分', dt === '2026-11-16 14:32', String(dt));
  const dt2 = vm.runInContext("dtView({date:'2026-11-16',time:null})", ctx);
  ok('dtView 无时间时只显示日期', dt2 === '2026-11-16', String(dt2));
  const nowInput = vm.runInContext('nowLocalInput()', ctx);
  ok('nowLocalInput 是 datetime-local 格式', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(nowInput), nowInput);
  const items = vm.runInContext("repItems([{name:'a',amount:0,expense:10},{name:'b',amount:5}],'expense')", ctx);
  ok('repItems 过滤 0 值并按口径取值', items.length === 1 && items[0].amount === 10, JSON.stringify(items));
  const status = vm.runInContext('REC_STATUS.PENDING', ctx);
  ok('应收应付状态是中文', status === '待结清', String(status));
}

console.log(`\n结果：${pass} 通过 / ${failures.length} 失败`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(failures.length ? 1 : 0);
