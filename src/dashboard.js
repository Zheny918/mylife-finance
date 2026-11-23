'use strict';
/*
 * 看板数据层 + 离线快照生成。
 * 统计口径：**当前自然年**（1/1 – 12/31），不再做全量累计。
 *  - 总收入 / 总支出 / 净结余 = 本年合计
 *  - 趋势 = 本年 1..12 月
 *  - 支出分类占比 = 本年支出按**一级分类**归并（交易挂二级时上卷到根）
 *  - 最近交易 = 当月
 */
const fs = require('fs');
const path = require('path');
const { db, DATA_DIR } = require('./db');

// 看板快照按用户分文件：多人共用一套服务时，谁生成的就归谁，不会互相覆盖
const DASHBOARD_DIR = path.join(DATA_DIR, 'dashboards');

function dashboardPath(userId) {
  const safe = String(userId || 'default').replace(/[\\/:*?"<>|]/g, '_');
  return path.join(DASHBOARD_DIR, `${safe}.html`);
}

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const pad2 = (n) => String(n).padStart(2, '0');

function yearBounds(year) {
  return [`${year}-01-01`, `${year + 1}-01-01`];
}
function monthBounds(year, month) {
  const from = `${year}-${pad2(month)}-01`;
  const to = month === 12 ? `${year + 1}-01-01` : `${year}-${pad2(month + 1)}-01`;
  return [from, to];
}

function computeBalances(userId) {
  const accounts = db.prepare('SELECT * FROM accounts WHERE user_id = ?').all(userId);
  return accounts.map((a) => {
    const inc = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE user_id=? AND type='INCOME' AND account_id=?").get(userId, a.id).s;
    const exp = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE user_id=? AND type='EXPENSE' AND account_id=?").get(userId, a.id).s;
    const inTr = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE user_id=? AND type='TRANSFER' AND to_account_id=?").get(userId, a.id).s;
    const outTr = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE user_id=? AND type='TRANSFER' AND account_id=?").get(userId, a.id).s;
    const bal = (a.balance || 0) + inc - exp + inTr - outTr;
    return { id: a.id, name: a.name, type: a.type, currency: a.currency, archived: !!a.archived, balance: round2(bal) };
  });
}

// 本年 1..12 月收支（含当月结余，供「柱状 + 结余折线」混合图）
function computeTrend(userId, year) {
  const months = [];
  for (let m = 1; m <= 12; m++) months.push(`${year}-${pad2(m)}`);
  return months.map((ym) => {
    const [from, to] = monthBounds(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)));
    const inc = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE user_id=? AND type='INCOME' AND date>=? AND date<?").get(userId, from, to).s;
    const exp = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE user_id=? AND type='EXPENSE' AND date>=? AND date<?").get(userId, from, to).s;
    return { month: ym, income: round2(inc), expense: round2(exp), net: round2(inc - exp) };
  });
}

function computeTotalsRange(userId, from, to) {
  const income = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE user_id=? AND type='INCOME' AND date>=? AND date<?").get(userId, from, to).s;
  const expense = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE user_id=? AND type='EXPENSE' AND date>=? AND date<?").get(userId, from, to).s;
  const count = db.prepare('SELECT COUNT(*) c FROM transactions WHERE user_id=? AND date>=? AND date<?').get(userId, from, to).c;
  return { income: round2(income), expense: round2(expense), net: round2(income - expense), count };
}

function computeYearTotals(userId, year) {
  const [from, to] = yearBounds(year);
  return computeTotalsRange(userId, from, to);
}

// 累计：记账天数（有记录的不同日期数）与明细笔数
function computeLifetimeStats(userId) {
  const days = db.prepare('SELECT COUNT(DISTINCT date) d FROM transactions WHERE user_id=?').get(userId).d;
  const count = db.prepare('SELECT COUNT(*) c FROM transactions WHERE user_id=?').get(userId).c;
  return { days: Number(days || 0), count: Number(count || 0), firstDate: db.prepare('SELECT MIN(date) d FROM transactions WHERE user_id=?').get(userId).d || null };
}

// 期间内支出按一级分类归并（交易挂二级时上卷到根分类）
function expenseByL1Range(userId, from, to) {
  const cats = db.prepare('SELECT id, name, parent_id FROM categories WHERE user_id = ?').all(userId);
  const byId = new Map(cats.map((c) => [c.id, c]));
  const rootName = (id) => {
    let cur = byId.get(id);
    let guard = 0;
    while (cur && cur.parent_id && guard++ < 10) cur = byId.get(cur.parent_id);
    return cur ? cur.name : '未分类';
  };
  const rows = db.prepare(
    "SELECT category_id, COALESCE(SUM(amount),0) amount FROM transactions WHERE user_id=? AND type='EXPENSE' AND date>=? AND date<? GROUP BY category_id"
  ).all(userId, from, to);
  const agg = new Map();
  for (const r of rows) {
    const key = r.category_id ? rootName(r.category_id) : '未分类';
    agg.set(key, (agg.get(key) || 0) + Number(r.amount || 0));
  }
  return [...agg.entries()]
    .map(([name, amount]) => ({ name, amount: round2(amount) }))
    .sort((a, b) => b.amount - a.amount);
}

// 本年支出按一级分类归并（交易挂二级时上卷到根分类）
function computeExpenseByL1(userId, year) {
  const [from, to] = yearBounds(year);
  return expenseByL1Range(userId, from, to);
}

const TX_SELECT = `SELECT t.*, a.name an, c.name cn, pc.name pcn, m.name mn, me.name men, p.name pn, ta.name tan
  FROM transactions t
  LEFT JOIN accounts a ON t.account_id=a.id
  LEFT JOIN categories c ON t.category_id=c.id
  LEFT JOIN categories pc ON c.parent_id=pc.id
  LEFT JOIN members m ON t.member_id=m.id
  LEFT JOIN merchants me ON t.merchant_id=me.id
  LEFT JOIN projects p ON t.project_id=p.id
  LEFT JOIN accounts ta ON t.to_account_id=ta.id`;

function mapTxRow(r) {
  return {
    id: r.id,
    date: (r.date || '').slice(0, 10),
    time: r.time || null,
    type: r.type,
    amount: r.amount,
    account: r.an, toAccount: r.tan,
    categoryId: r.category_id, category: r.cn, categoryParent: r.pcn || null,
    member: r.mn, merchant: r.men, project: r.pn,
    description: r.description, tags: r.tags,
  };
}

function monthTransactions(userId, year, month, limit) {
  const [from, to] = monthBounds(year, month);
  const rows = db.prepare(`${TX_SELECT} WHERE t.user_id=? AND t.date>=? AND t.date<? ORDER BY t.date DESC, t.created_at DESC`).all(userId, from, to);
  return (limit ? rows.slice(0, limit) : rows).map(mapTxRow);
}

function latestTransactionDate(userId) {
  const row = db.prepare('SELECT MAX(date) d FROM transactions WHERE user_id=?').get(userId);
  return row && row.d ? String(row.d).slice(0, 10) : null;
}

function receivablesOf(userId) {
  return db.prepare('SELECT * FROM receivables WHERE user_id=? ORDER BY due_date').all(userId).map((r) => ({
    counterparty: r.counterparty, amount: r.amount, received: r.received_amount, status: r.status,
    due: (r.due_date || '').slice(0, 10), description: r.description,
  }));
}

function budgetsOf(userId) {
  return db.prepare('SELECT b.*, c.name category FROM budgets b LEFT JOIN categories c ON b.category_id=c.id WHERE b.user_id=?').all(userId).map((b) => ({
    category: b.category, amount: b.amount, period: b.period, month: b.month, year: b.year,
  }));
}

// 供工作台 /api/summary 复用（实时、按年）
function getDashboardData(userId, opts) {
  opts = opts || {};
  const now = new Date();
  const year = Number(opts.year) || now.getFullYear();
  const month = Number(opts.month) || now.getMonth() + 1;
  const totals = computeYearTotals(userId, year);
  const [mFrom, mTo] = monthBounds(year, month);
  const monthTotals = computeTotalsRange(userId, mFrom, mTo);
  const life = computeLifetimeStats(userId);
  return {
    userId,
    generatedAt: new Date().toISOString(),
    year,
    month,
    yearIncome: totals.income,
    yearExpense: totals.expense,
    yearNet: totals.net,
    yearTxCount: totals.count,
    // 累计口径（全量，不受年份影响）
    totalDays: life.days,
    totalTxCount: life.count,
    firstTransactionDate: life.firstDate,
    // 本月口径
    monthIncome: monthTotals.income,
    monthExpense: monthTotals.expense,
    monthNet: monthTotals.net,
    monthTxCount: monthTotals.count,
    monthExpenseByCategoryL1: expenseByL1Range(userId, mFrom, mTo),
    trend: computeTrend(userId, year),
    expenseByCategoryL1: computeExpenseByL1(userId, year),
    monthTransactions: monthTransactions(userId, year, month, 200),
    latestTransactionDate: latestTransactionDate(userId),
    balances: computeBalances(userId),
    receivables: receivablesOf(userId),
    budgets: budgetsOf(userId),
  };
}

// 对外基址（可选）：容器里文件路径对调用方（Octop / 浏览器）没有意义，得给可访问的 URL
const PUBLIC_BASE = String(process.env.MYLF_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');

function buildDashboard(args) {
  args = args || {};
  const userId = args.userId || 'default';
  const data = getDashboardData(userId, { year: args.year, month: args.month });
  data.transactions = monthTransactions(userId, data.year, data.month); // 兼容旧快照字段
  const tplPath = path.join(__dirname, 'dashboard-template.html');
  let tpl = fs.readFileSync(tplPath, 'utf8');
  const chartSrc = fs.readFileSync(path.join(__dirname, 'vendor', 'chart.umd.js'), 'utf8');
  tpl = tpl.replace('/*__CHARTJS__*/', () => chartSrc);
  tpl = tpl.replace('/*__DATA__*/', () => JSON.stringify(data));
  const outPath = dashboardPath(userId);
  fs.mkdirSync(DASHBOARD_DIR, { recursive: true });
  fs.writeFileSync(outPath, tpl, 'utf8');

  const relativeUrl = '/dashboard.html';
  const result = {
    ok: true,
    path: outPath,
    relativeUrl,
    url: PUBLIC_BASE ? PUBLIC_BASE + relativeUrl : null,
    userId,
    year: data.year,
    transactionCount: data.monthTransactions.length,
  };
  if (!PUBLIC_BASE) {
    result.hint =
      '未设置 MYLF_PUBLIC_BASE_URL，只能返回容器内路径与相对路径。' +
      '容器部署时请把它设成对外可访问的基址（如 http://192.168.130.8:3458），' +
      '否则 Octop / 浏览器都打不开这个文件；设置后本字段会变成可点击的完整 URL。';
  }
  return result;
}

module.exports = { buildDashboard, getDashboardData, computeBalances, computeTrend, computeYearTotals, computeTotalsRange, computeLifetimeStats, computeExpenseByL1, expenseByL1Range, monthTransactions, latestTransactionDate, yearBounds, monthBounds, DASHBOARD_DIR, dashboardPath };
