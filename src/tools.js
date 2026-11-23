'use strict';
/*
 * 财务 MCP 工具集：记账 / 主数据 / 报表 / 导入
 * 每个工具：{ name, description, inputSchema, handler }
 * handler 返回普通 JS 对象（由 server.js 序列化为 JSON 文本返回给模型）。
 *
 * 多用户：所有写/读均按 args.userId 隔离，缺省 'default'（本地单用户 / Octop 未注入时）。
 */
const { db, uid, getOrCreate, ensure, getName, normalizeDate, seedCategoriesIfEmpty } = require('./db');
const { buildDashboard, computeBalances } = require('./dashboard');

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

/** 'HH:MM' / 'HH:MM:SS' / 'H:MM' → 'HH:MM:SS'；无法识别返回 null */
function normTime(v) {
  if (v === null || v === undefined || v === '') return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(v).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  const s = Number(m[3] || 0);
  if (h > 23 || mi > 59 || s > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** 本地「现在」的日期与时间（不用 toISOString，避免 UTC 偏移把日期算错） */
function localNow() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`,
  };
}

/**
 * 解析「日期 + 时间」：
 *   - '2026-11-16'            → date=2026-11-16, time=null
 *   - '2026-11-16T14:32:05'   → date=2026-11-16, time=14:32:05
 *   - '2026-11-16 14:32'      → time=14:32:00
 *   - 显式 time 参数优先
 * date 始终只存 YYYY-MM-DD，所有按日/按月/按年的比较都不受影响。
 */
function splitDateTime(v, explicitTime) {
  const now = localNow();
  let date = now.date;
  let time = null;
  if (v !== null && v !== undefined && String(v).trim() !== '') {
    const s = String(v).trim();
    date = normalizeDate(s) || now.date;
    const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}:\d{2}(?::\d{2})?)/.exec(s);
    if (m) time = normTime(m[2]);
  }
  const t = normTime(explicitTime);
  if (t) time = t;
  return { date, time };
}

/**
 * 分类的一级名：交易挂在二级分类时取父级名。
 * 本身就是一级（或没分类）时返回 null —— 前端据此只显示二级那一列，不重复渲染。
 */
function categoryParentName(catId) {
  if (!catId) return null;
  const c = db.prepare('SELECT parent_id FROM categories WHERE id = ?').get(catId);
  if (!c || !c.parent_id) return null;
  return getName('categories', c.parent_id) || null;
}

function txRowToView(r) {
  return {
    id: r.id,
    date: normalizeDate(r.date),
    time: r.time || null,
    type: r.type,
    amount: r.amount,
    description: r.description,
    account: getName('accounts', r.account_id),
    toAccount: getName('accounts', r.to_account_id),
    categoryId: r.category_id || null,
    category: getName('categories', r.category_id),
    categoryParent: categoryParentName(r.category_id),
    member: getName('members', r.member_id),
    merchant: getName('merchants', r.merchant_id),
    project: getName('projects', r.project_id),
    tags: r.tags || '',
  };
}

function getTransaction(id) {
  const r = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
  return r ? txRowToView(r) : null;
}

// ---------- 记账 ----------
function txAdd(args) {
  if (!args.account) throw new Error('account（账户）为必填，例如 "招商银行"');
  if (args.amount === undefined || args.amount === null || isNaN(Number(args.amount))) throw new Error('amount（金额）为必填数字');
  const userId = args.userId || 'default';
  const type = String(args.type || 'EXPENSE').toUpperCase();
  if (!['INCOME', 'EXPENSE', 'TRANSFER'].includes(type)) throw new Error('type 必须是 INCOME / EXPENSE / TRANSFER');
  const accountId = getOrCreate('accounts', { name: args.account }, { type: args.accountType || 'OTHER' }, userId);
  let categoryId = null;
  if (args.category) {
    const catType = type === 'INCOME' ? 'INCOME' : 'EXPENSE';
    categoryId = getOrCreate('categories', { name: args.category, type: catType }, {}, userId);
  }
  let toAccountId = null;
  if (type === 'TRANSFER' && args.toAccount) {
    toAccountId = getOrCreate('accounts', { name: args.toAccount }, { type: args.toAccountType || 'OTHER' }, userId);
  }
  const memberId = args.member ? getOrCreate('members', { name: args.member }, {}, userId) : null;
  const merchantId = args.merchant ? getOrCreate('merchants', { name: args.merchant }, {}, userId) : null;
  const projectId = args.project ? getOrCreate('projects', { name: args.project }, {}, userId) : null;
  const id = uid();
  const { date, time } = splitDateTime(args.date, args.time);
  db.prepare(
    'INSERT INTO transactions (id, user_id, account_id, to_account_id, category_id, type, amount, description, date, tags, member_id, merchant_id, project_id, time) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(id, userId, accountId, toAccountId, categoryId, type, Number(args.amount), args.description || '', date, args.tags || null, memberId, merchantId, projectId, time);
  return { ok: true, transaction: getTransaction(id) };
}

// 按分类名收集 id，并展开其全部子分类（选一级分类即可命中其下二级明细）
function categoryIdsByName(userId, name, type) {
  const rows = type
    ? db.prepare('SELECT id FROM categories WHERE user_id=? AND name=? AND type=?').all(userId, name, type)
    : db.prepare('SELECT id FROM categories WHERE user_id=? AND name=?').all(userId, name);
  if (!rows.length) return [];
  const out = new Set();
  const childStmt = db.prepare('SELECT id FROM categories WHERE parent_id=?');
  const stack = rows.map((r) => r.id);
  while (stack.length) {
    const id = stack.pop();
    if (out.has(id)) continue;
    out.add(id);
    for (const c of childStmt.all(id)) stack.push(c.id);
  }
  return [...out];
}

function txList(args) {
  args = args || {};
  const userId = args.userId || 'default';
  const where = ['t.user_id = ?'];
  const vals = [userId];
  const typeFilter = args.type ? String(args.type).toUpperCase() : null;
  if (typeFilter) { where.push('t.type = ?'); vals.push(typeFilter); }
  if (args.account) { where.push('a.name = ?'); vals.push(args.account); }
  // categoryId 优先：按 id 精确匹配并展开其子树（选一级即命中全部二级）
  if (args.categoryId) {
    const ids = catSubtreeIds(args.categoryId);
    if (!ids.length) where.push('1=0');
    else { where.push(`t.category_id IN (${ids.map(() => '?').join(',')})`); vals.push(...ids); }
  } else if (args.category) {
    const ids = categoryIdsByName(userId, args.category, typeFilter);
    if (!ids.length) where.push('1=0');
    else { where.push(`t.category_id IN (${ids.map(() => '?').join(',')})`); vals.push(...ids); }
  }
  if (args.member) { where.push('m.name = ?'); vals.push(args.member); }
  if (args.merchant) { where.push('me.name = ?'); vals.push(args.merchant); }
  if (args.project) { where.push('p.name = ?'); vals.push(args.project); }
  // 年份：只给年份就能查全年；同时给 from/to 时以 from/to 为准
  const year = Number(args.year);
  let from = args.from;
  let to = args.to;
  if (!from && !to && Number.isInteger(year) && year >= 1900 && year <= 2999) {
    from = `${year}-01-01`;
    to = `${year}-12-31`;
  }
  if (from) { where.push('date(t.date) >= date(?)'); vals.push(from); }
  if (to) { where.push('date(t.date) <= date(?)'); vals.push(to); }
  if (args.tag) { where.push('t.tags LIKE ?'); vals.push('%' + args.tag + '%'); }
  if (args.q) { where.push("IFNULL(t.description,'') LIKE ?"); vals.push('%' + args.q + '%'); }
  const wsql = 'WHERE ' + where.join(' AND ');
  // 分页：page/pageSize 优先（工作台用），否则兼容旧的 limit/offset。
  // pageSize 上限 5000，防止一次拉爆内存；下限 1。
  const reqSize = Number(args.pageSize) > 0 ? Number(args.pageSize) : (Number(args.limit) > 0 ? Number(args.limit) : 50);
  const pageSize = Math.min(5000, Math.max(1, Math.trunc(reqSize)));
  const pageArg = Number(args.page) > 0 ? Math.trunc(Number(args.page)) : 0;
  const offset = pageArg ? (pageArg - 1) * pageSize : Math.max(0, Math.trunc(Number(args.offset) || 0));
  const joins = `FROM transactions t
    LEFT JOIN accounts a ON t.account_id = a.id
    LEFT JOIN categories c ON t.category_id = c.id
    LEFT JOIN members m ON t.member_id = m.id
    LEFT JOIN merchants me ON t.merchant_id = me.id
    LEFT JOIN projects p ON t.project_id = p.id`;
  const sql = `SELECT t.* ${joins} ${wsql} ORDER BY t.date DESC, COALESCE(t.time,'') DESC, t.created_at DESC LIMIT ? OFFSET ?`;
  const rows = db.prepare(sql).all(...vals, pageSize, offset);
  const total = db.prepare(`SELECT COUNT(*) c ${joins} ${wsql}`).get(...vals).c;
  // 全部合计：跨页、按同一套筛选条件求和（转账既不算收入也不算支出，与首页/报表口径一致）
  const agg = db.prepare(`SELECT
      IFNULL(SUM(CASE WHEN t.type='INCOME' THEN t.amount ELSE 0 END),0) income,
      IFNULL(SUM(CASE WHEN t.type='EXPENSE' THEN t.amount ELSE 0 END),0) expense
      ${joins} ${wsql}`).get(...vals);
  const sumIncome = round2(Number(agg.income) || 0);
  const sumExpense = round2(Number(agg.expense) || 0);
  return {
    count: rows.length,
    total,
    page: pageArg || Math.floor(offset / pageSize) + 1,
    pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    sum: { income: sumIncome, expense: sumExpense, net: round2(sumIncome - sumExpense) },
    transactions: rows.map(txRowToView),
  };
}

function txUpdate(args) {
  if (!args.id) throw new Error('id 必填');
  const existing = db.prepare('SELECT * FROM transactions WHERE id = ?').get(args.id);
  if (!existing) throw new Error('未找到交易 ' + args.id);
  const userId = args.userId || 'default';
  const sets = [];
  const vals = [];
  if (args.account) { sets.push('account_id = ?'); vals.push(getOrCreate('accounts', { name: args.account }, { type: args.accountType || 'OTHER' }, userId)); }
  if (args.toAccount !== undefined) { sets.push('to_account_id = ?'); vals.push(args.toAccount ? getOrCreate('accounts', { name: args.toAccount }, { type: args.toAccountType || 'OTHER' }, userId) : null); }
  if (args.category) { const ct = (args.type ? String(args.type).toUpperCase() : existing.type) === 'INCOME' ? 'INCOME' : 'EXPENSE'; sets.push('category_id = ?'); vals.push(getOrCreate('categories', { name: args.category, type: ct }, {}, userId)); }
  if (args.type) { sets.push('type = ?'); vals.push(String(args.type).toUpperCase()); }
  if (args.amount !== undefined) { sets.push('amount = ?'); vals.push(Number(args.amount)); }
  if (args.description !== undefined) { sets.push('description = ?'); vals.push(args.description); }
  if (args.date !== undefined || args.time !== undefined) {
    const dt = splitDateTime(
      args.date !== undefined ? args.date : existing.date,
      args.time !== undefined ? args.time : existing.time
    );
    sets.push('date = ?'); vals.push(dt.date);
    sets.push('time = ?'); vals.push(dt.time);
  }
  if (args.tags !== undefined) { sets.push('tags = ?'); vals.push(args.tags); }
  if (args.member !== undefined) { sets.push('member_id = ?'); vals.push(args.member ? getOrCreate('members', { name: args.member }, {}, userId) : null); }
  if (args.merchant !== undefined) { sets.push('merchant_id = ?'); vals.push(args.merchant ? getOrCreate('merchants', { name: args.merchant }, {}, userId) : null); }
  if (args.project !== undefined) { sets.push('project_id = ?'); vals.push(args.project ? getOrCreate('projects', { name: args.project }, {}, userId) : null); }
  if (!sets.length) return { ok: true, transaction: getTransaction(args.id), note: '无字段变更' };
  vals.push(args.id);
  db.prepare(`UPDATE transactions SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return { ok: true, transaction: getTransaction(args.id) };
}

function txDelete(args) {
  if (!args.id) throw new Error('id 必填');
  db.prepare('DELETE FROM transactions WHERE id = ?').run(args.id);
  return { ok: true, deleted: args.id };
}

// ---------- 主数据 ----------
function accView(r) {
  return {
    id: r.id, name: r.name, type: r.type, balance: r.balance, currency: r.currency,
    archived: r.archived, cardNo: r.card_no || '', note: r.note || '', createdAt: r.created_at,
  };
}

function accountAdd(args) {
  if (!args.name) throw new Error('name 必填');
  const userId = args.userId || 'default';
  const dup = db.prepare('SELECT * FROM accounts WHERE user_id = ? AND name = ?').get(userId, args.name);
  if (dup) return { ok: true, account: accView(dup), note: '已存在（未修改，卡号/备注请用编辑补充）' };
  const id = uid();
  db.prepare('INSERT INTO accounts (id, user_id, name, type, balance, currency, icon, color, card_no, note) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, userId, args.name, args.type || 'OTHER', Number(args.balance) || 0, args.currency || 'CNY',
      args.icon || null, args.color || null, args.cardNo || args.card_no || null, args.note || null);
  return { ok: true, account: accView(db.prepare('SELECT * FROM accounts WHERE id = ?').get(id)) };
}

function accountList(args) {
  args = args || {};
  const userId = args.userId || 'default';
  const rows = db.prepare('SELECT * FROM accounts WHERE user_id = ? AND (archived = 0 OR ? = 1) ORDER BY created_at').all(userId, args.includeArchived ? 1 : 0);
  // balance 给的是「实际余额」（期初 + 流水），openingBalance 才是期初值
  const computed = new Map(computeBalances(userId).map((x) => [x.id, x.balance]));
  return {
    count: rows.length,
    accounts: rows.map((r) => ({
      ...accView(r),
      balance: computed.has(r.id) ? computed.get(r.id) : r.balance,
      openingBalance: r.balance,
    })),
  };
}

/** 账户当前余额 = 期初余额 + 收入 - 支出 + 转入 - 转出 */
function accountComputedBalance(userId, accountId) {
  const a = db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?').get(accountId, userId);
  if (!a) return null;
  const sum = (sql, ...p) => Number(db.prepare(sql).get(...p).s || 0);
  const inc = sum("SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE user_id=? AND type='INCOME' AND account_id=?", userId, accountId);
  const exp = sum("SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE user_id=? AND type='EXPENSE' AND account_id=?", userId, accountId);
  const inTr = sum("SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE user_id=? AND type='TRANSFER' AND to_account_id=?", userId, accountId);
  const outTr = sum("SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE user_id=? AND type='TRANSFER' AND account_id=?", userId, accountId);
  return round2((a.balance || 0) + inc - exp + inTr - outTr);
}

/**
 * 修改账户。传 balance 时默认**换算成一条「余额调整」流水**而不是直接改期初余额，
 * 这样：① 账户显示余额就是用户填的那个数；② 明细里留得下痕迹（谁在什么时候调整的）。
 * adjustBalance:false 时才直接改期初余额（导入期初数据这类场景用）。
 */
function accountUpdate(args) {
  if (!args.id) throw new Error('id 必填');
  const userId = args.userId || 'default';
  const existing = db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?').get(args.id, userId);
  if (!existing) throw new Error('未找到账户 ' + args.id);
  const sets = [];
  const vals = [];
  if (args.name !== undefined) {
    const dup = db.prepare('SELECT id FROM accounts WHERE user_id = ? AND name = ? AND id <> ?').get(userId, args.name, args.id);
    if (dup) throw new Error('该用户下已存在同名账户：' + args.name);
    sets.push('name = ?'); vals.push(args.name);
  }
  if (args.type !== undefined) { sets.push('type = ?'); vals.push(args.type); }
  if (args.currency !== undefined) { sets.push('currency = ?'); vals.push(args.currency); }
  if (args.icon !== undefined) { sets.push('icon = ?'); vals.push(args.icon); }
  if (args.color !== undefined) { sets.push('color = ?'); vals.push(args.color); }
  if (args.archived !== undefined) { sets.push('archived = ?'); vals.push(args.archived ? 1 : 0); }
  if (args.cardNo !== undefined || args.card_no !== undefined) {
    sets.push('card_no = ?'); vals.push(args.cardNo !== undefined ? args.cardNo : args.card_no);
  }
  if (args.note !== undefined) { sets.push('note = ?'); vals.push(args.note); }

  let adjustment = null;
  if (args.balance !== undefined && args.balance !== null && args.balance !== '') {
    const want = Number(args.balance);
    if (!isFinite(want)) throw new Error('balance 必须是数字');
    if (args.adjustBalance === false) {
      sets.push('balance = ?'); vals.push(want);
    } else {
      const cur = accountComputedBalance(userId, args.id);
      const delta = round2(want - Number(cur || 0));
      if (Math.abs(delta) >= 0.01) {
        const isUp = delta > 0;
        const catName = isUp ? '其他收入' : '其他费用';
        const catId = getOrCreate('categories', { name: catName, type: isUp ? 'INCOME' : 'EXPENSE' }, {}, userId);
        const now = localNow();
        const txId = uid();
        const desc = args.adjustNote || `余额调整：${round2(cur)} → ${round2(want)}`;
        db.prepare('INSERT INTO transactions (id,user_id,account_id,category_id,type,amount,description,date,time) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(txId, userId, args.id, catId, isUp ? 'INCOME' : 'EXPENSE', Math.abs(delta), desc, now.date, now.time);
        adjustment = { id: txId, type: isUp ? 'INCOME' : 'EXPENSE', amount: Math.abs(delta), category: catName, description: desc, date: now.date, time: now.time };
      }
    }
  }

  if (!sets.length) {
    return {
      ok: true,
      account: accView(db.prepare('SELECT * FROM accounts WHERE id = ?').get(args.id)),
      adjustment,
      note: adjustment ? '已生成余额调整流水' : '无字段变更',
    };
  }
  vals.push(args.id);
  db.prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return { ok: true, account: accView(db.prepare('SELECT * FROM accounts WHERE id = ?').get(args.id)), adjustment };
}

function accountDelete(args) {
  if (!args.id) throw new Error('id 必填');
  const userId = args.userId || 'default';
  const existing = db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?').get(args.id, userId);
  if (!existing) throw new Error('未找到账户 ' + args.id);
  const used = db.prepare('SELECT COUNT(*) c FROM transactions WHERE (account_id = ? OR to_account_id = ?)').get(args.id, args.id).c;
  if (used > 0) throw new Error('该账户下尚有 ' + used + ' 笔交易，无法删除（可改为归档）。');
  db.prepare('DELETE FROM accounts WHERE id = ?').run(args.id);
  return { ok: true, deleted: args.id };
}

// ---------- 分类名唯一性 ----------
// 同一账户 + 同一收支类型下，分类名全局唯一：一个二级分类只能属于一个一级分类。
// 「食品酒水/三餐」与「居家生活/三餐」不允许并存，否则按名字记账、筛分类都会出现歧义
// （tx_add 只传名字时无从判断该挂哪个父级）。
// 注：catNormName 定义在本文件靠后，function 声明会提升，此处可直接调用。
function catTypeText(t) {
  return String(t).toUpperCase() === 'INCOME' ? '收入' : '支出';
}

// 按归一化名称（全角转半角、去空白、小写）在同一 user+type 内找同名分类
function categoryNameConflict(userId, type, name, excludeId) {
  const norm = catNormName(name);
  if (!norm) return null;
  const rows = db.prepare(
    `SELECT c.id, c.name, c.type, c.parent_id, p.name parent_name
       FROM categories c LEFT JOIN categories p ON c.parent_id = p.id
      WHERE c.user_id = ? AND c.type = ?`
  ).all(userId, String(type).toUpperCase());
  return rows.find((r) => r.id !== excludeId && catNormName(r.name) === norm) || null;
}

function catDisplay(r) {
  return r.parent_id ? `已挂在「${r.parent_name || '未知一级分类'}」下` : '是一级分类';
}

function categoryAdd(args) {
  if (!args.name) throw new Error('name 必填');
  if (!args.type) throw new Error('type 必填（INCOME / EXPENSE）');
  const userId = args.userId || 'default';
  const name = String(args.name).trim();
  if (!name) throw new Error('name 不能只有空白字符');
  const type = String(args.type).toUpperCase();
  if (!['INCOME', 'EXPENSE'].includes(type)) throw new Error('type 必须是 INCOME 或 EXPENSE');
  const parentId = args.parentId || null;

  // 父级必须是「本账户 + 同收支类型」的一级分类：避免出现三级嵌套，也避免跨类型挂载
  if (parentId) {
    const parent = db.prepare('SELECT * FROM categories WHERE id = ? AND user_id = ?').get(parentId, userId);
    if (!parent) throw new Error('父级分类不存在：' + parentId);
    if (parent.parent_id) throw new Error(`父级分类「${parent.name}」本身是二级分类，分类最多两级，不能再往下挂子级。`);
    if (parent.type !== type) {
      throw new Error(`父级分类「${parent.name}」是${catTypeText(parent.type)}分类，与本次新增的${catTypeText(type)}分类不一致。`);
    }
  }

  const conflict = categoryNameConflict(userId, type, name, null);
  if (conflict) {
    // 同父级同名 = 重复提交，直接返回既有分类（导入、重试、双击都友好）
    if ((conflict.parent_id || null) === parentId) {
      return { ok: true, category: db.prepare('SELECT * FROM categories WHERE id = ?').get(conflict.id), note: '已存在同名同父级分类' };
    }
    throw new Error(
      `已存在${catTypeText(type)}分类「${conflict.name}」（${catDisplay(conflict)}）。` +
      `同一个名称只能有一个分类：二级分类名必须全局唯一，不能同时挂在不同一级分类下。` +
      `请换个名字，或先在「分类管理 → 查重合并」里把这两个分类合并。`
    );
  }

  const id = uid();
  try {
    db.prepare('INSERT INTO categories (id, user_id, name, type, parent_id, icon, color) VALUES (?,?,?,?,?,?,?)')
      .run(id, userId, name, type, parentId, args.icon || null, args.color || null);
  } catch (e) {
    // 并发下两个请求可能同时通过上面的检查，靠唯一索引兜住，把英文约束错误翻成人话
    if (/UNIQUE constraint failed/i.test(e.message)) {
      throw new Error(`已存在同名${catTypeText(type)}分类「${name}」，同一个名称只能有一个分类（不能同时挂在不同一级分类下）。`);
    }
    throw e;
  }
  return { ok: true, category: db.prepare('SELECT * FROM categories WHERE id = ?').get(id) };
}

function categoryList(args) {
  args = args || {};
  const userId = args.userId || 'default';
  let sql = 'SELECT c.*, p.name parent_name FROM categories c LEFT JOIN categories p ON c.parent_id = p.id WHERE c.user_id = ?';
  const vals = [userId];
  if (args.type) { sql += ' AND c.type = ?'; vals.push(String(args.type).toUpperCase()); }
  sql += ' ORDER BY c.sort_order, c.name';
  const rows = db.prepare(sql).all(...vals);
  return { count: rows.length, categories: rows };
}

function memberAdd(args) {
  if (!args.name) throw new Error('name 必填');
  const userId = args.userId || 'default';
  const id = getOrCreate('members', { name: args.name }, {}, userId);
  return { ok: true, member: db.prepare('SELECT * FROM members WHERE id = ?').get(id) };
}
function memberList(args) {
  args = args || {};
  const userId = args.userId || 'default';
  const rows = db.prepare('SELECT id, name FROM members WHERE user_id = ? ORDER BY name').all(userId);
  return { count: rows.length, members: rows };
}

function merchantAdd(args) {
  if (!args.name) throw new Error('name 必填');
  const userId = args.userId || 'default';
  const dup = db.prepare('SELECT id FROM merchants WHERE user_id = ? AND name = ?').get(userId, args.name);
  if (dup) return { ok: true, merchant: db.prepare('SELECT * FROM merchants WHERE id = ?').get(dup.id), note: '已存在' };
  const id = uid();
  db.prepare('INSERT INTO merchants (id, user_id, name, category, icon, color) VALUES (?,?,?,?,?,?)')
    .run(id, userId, args.name, args.category || null, args.icon || null, args.color || null);
  return { ok: true, merchant: db.prepare('SELECT * FROM merchants WHERE id = ?').get(id) };
}
function merchantList(args) {
  args = args || {};
  const userId = args.userId || 'default';
  const rows = db.prepare('SELECT id, name, category, icon, color FROM merchants WHERE user_id = ? ORDER BY name').all(userId);
  return { count: rows.length, merchants: rows };
}
function merchantUpdate(args) {
  if (!args.id) throw new Error('id 必填');
  const userId = args.userId || 'default';
  const existing = db.prepare('SELECT * FROM merchants WHERE id = ? AND user_id = ?').get(args.id, userId);
  if (!existing) throw new Error('未找到商家 ' + args.id);
  const sets = []; const vals = [];
  if (args.name !== undefined) {
    const dup = db.prepare('SELECT id FROM merchants WHERE user_id = ? AND name = ? AND id <> ?').get(userId, args.name, args.id);
    if (dup) throw new Error('该用户下已存在同名商家：' + args.name);
    sets.push('name = ?'); vals.push(args.name);
  }
  if (args.category !== undefined) { sets.push('category = ?'); vals.push(args.category || null); }
  if (args.icon !== undefined) { sets.push('icon = ?'); vals.push(args.icon); }
  if (args.color !== undefined) { sets.push('color = ?'); vals.push(args.color); }
  if (!sets.length) return { ok: true, merchant: existing, note: '无字段变更' };
  vals.push(args.id);
  db.prepare(`UPDATE merchants SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return { ok: true, merchant: db.prepare('SELECT * FROM merchants WHERE id = ?').get(args.id) };
}
function merchantDelete(args) {
  if (!args.id) throw new Error('id 必填');
  const userId = args.userId || 'default';
  const existing = db.prepare('SELECT * FROM merchants WHERE id = ? AND user_id = ?').get(args.id, userId);
  if (!existing) throw new Error('未找到商家 ' + args.id);
  const used = db.prepare('SELECT COUNT(*) c FROM transactions WHERE merchant_id = ?').get(args.id).c;
  if (used > 0) throw new Error('该商家下尚有 ' + used + ' 笔交易，无法删除（可先改商家）。');
  db.prepare('DELETE FROM merchants WHERE id = ?').run(args.id);
  return { ok: true, deleted: args.id };
}

function projectList(args) {
  args = args || {};
  const userId = args.userId || 'default';
  const rows = db.prepare('SELECT id, name FROM projects WHERE user_id = ? ORDER BY name').all(userId);
  return { count: rows.length, projects: rows };
}

// ---------- 分类管理（update/delete）----------
function categoryUpdate(args) {
  if (!args.id) throw new Error('id 必填');
  const userId = args.userId || 'default';
  const existing = db.prepare('SELECT * FROM categories WHERE id = ? AND user_id = ?').get(args.id, userId);
  if (!existing) throw new Error('未找到分类 ' + args.id);

  // 先算「改完之后」的最终状态，再统一校验，避免改名 + 改父级 + 改类型组合时漏判
  const nextType = args.type !== undefined ? String(args.type).toUpperCase() : existing.type;
  const nextName = args.name !== undefined ? String(args.name).trim() : existing.name;
  const nextParent = args.parentId !== undefined ? (args.parentId || null) : (existing.parent_id || null);

  if (!nextName) throw new Error('name 不能只有空白字符');
  if (nextParent === args.id) throw new Error('分类不能把自己设为父级。');
  if (nextParent) {
    const parent = db.prepare('SELECT * FROM categories WHERE id = ? AND user_id = ?').get(nextParent, userId);
    if (!parent) throw new Error('父级分类不存在：' + nextParent);
    if (parent.parent_id) throw new Error(`父级分类「${parent.name}」本身是二级分类，分类最多两级，不能再往下挂子级。`);
    if (parent.type !== nextType) {
      throw new Error(`父级分类「${parent.name}」是${catTypeText(parent.type)}分类，与被移动的分类类型不一致。`);
    }
  }

  if (nextName !== existing.name || nextType !== existing.type || nextParent !== (existing.parent_id || null)) {
    const conflict = categoryNameConflict(userId, nextType, nextName, args.id);
    if (conflict) {
      throw new Error(
        `已存在${catTypeText(nextType)}分类「${conflict.name}」（${catDisplay(conflict)}）。` +
        `同一个名称只能有一个分类：二级分类名必须全局唯一，不能同时挂在不同一级分类下。`
      );
    }
  }

  const sets = []; const vals = [];
  if (args.name !== undefined) { sets.push('name = ?'); vals.push(nextName); }
  if (args.type !== undefined) { sets.push('type = ?'); vals.push(nextType); }
  if (args.icon !== undefined) { sets.push('icon = ?'); vals.push(args.icon); }
  if (args.color !== undefined) { sets.push('color = ?'); vals.push(args.color); }
  if (args.parentId !== undefined) { sets.push('parent_id = ?'); vals.push(nextParent); }
  if (args.sortOrder !== undefined) { sets.push('sort_order = ?'); vals.push(args.sortOrder); }
  if (!sets.length) return { ok: true, category: existing, note: '无字段变更' };
  vals.push(args.id);
  try {
    db.prepare(`UPDATE categories SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  } catch (e) {
    if (/UNIQUE constraint failed/i.test(e.message)) {
      throw new Error(`已存在同名${catTypeText(nextType)}分类「${nextName}」，同一个名称只能有一个分类（不能同时挂在不同一级分类下）。`);
    }
    throw e;
  }
  return { ok: true, category: db.prepare('SELECT * FROM categories WHERE id = ?').get(args.id) };
}
function categoryDelete(args) {
  if (!args.id) throw new Error('id 必填');
  const userId = args.userId || 'default';
  const existing = db.prepare('SELECT * FROM categories WHERE id = ? AND user_id = ?').get(args.id, userId);
  if (!existing) throw new Error('未找到分类 ' + args.id);
  const used = db.prepare('SELECT COUNT(*) c FROM transactions WHERE category_id = ?').get(args.id).c;
  if (used > 0) throw new Error('该分类下尚有 ' + used + ' 笔交易，无法删除（可先改分类）。');
  db.prepare('DELETE FROM categories WHERE id = ?').run(args.id);
  return { ok: true, deleted: args.id };
}

// ---------- 分类查重 / 合并 / 去重 ----------
// 分类名归一化：全角转半角、去空白、统一小写，仅用于「判重」，不改动真实名称
function catNormName(s) {
  return String(s || '')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

// 分类 + 交易数 + 子级数 一览（查重与合并共用）
function catStatRows(userId) {
  return db.prepare(`
    SELECT c.id, c.name, c.type, c.parent_id, p.name parent_name, c.icon, c.color,
      (SELECT COUNT(*) FROM transactions t WHERE t.category_id = c.id) AS tx_count,
      (SELECT COUNT(*) FROM categories x WHERE x.parent_id = c.id) AS child_count,
      (SELECT COUNT(*) FROM budgets b WHERE b.category_id = c.id) AS budget_count
    FROM categories c LEFT JOIN categories p ON c.parent_id = p.id
    WHERE c.user_id = ?
    ORDER BY c.type, c.name
  `).all(userId);
}

function catCand(r) {
  return { id: r.id, name: r.name, parent_name: r.parent_name || null, txCount: r.tx_count, childCount: r.child_count, budgetCount: r.budget_count };
}

// 合并候选排序：交易多的优先保留，其次子级多，最后 id 稳定
function catPickKeeper(arr) {
  return [...arr].sort((a, b) => (b.tx_count - a.tx_count) || (b.child_count - a.child_count) || String(a.id).localeCompare(String(b.id)))[0];
}

// 完全重名时优先保留「名字更干净」的那个（无首尾空格），避免留下 `交通 ` 这种脏名
function catPickKeeperExact(arr) {
  const clean = (s) => (String(s) === String(s).trim() ? 1 : 0);
  return [...arr].sort(
    (a, b) =>
      clean(b.name) - clean(a.name) ||
      b.tx_count - a.tx_count ||
      b.child_count - a.child_count ||
      String(a.id).localeCompare(String(b.id))
  )[0];
}

function categoryDuplicates(args) {
  args = args || {};
  const userId = args.userId || 'default';
  const typeFilter = args.type ? String(args.type).toUpperCase() : null;
  let rows = catStatRows(userId);
  if (typeFilter) rows = rows.filter((r) => r.type === typeFilter);

  const groups = [];
  const used = new Set(); // 已归入某组的分类 id，避免同一分类被反复建议

  // ① 完全重名：同类型 + 同父级 + 归一化同名 —— 可直接安全合并
  const exactMap = new Map();
  for (const r of rows) {
    const k = `${r.type}|${r.parent_id || 'root'}|${catNormName(r.name)}`;
    if (!exactMap.has(k)) exactMap.set(k, []);
    exactMap.get(k).push(r);
  }
  for (const arr of exactMap.values()) {
    if (arr.length < 2) continue;
    const keep = catPickKeeperExact(arr);
    arr.forEach((r) => used.add(r.id));
    groups.push({
      reason: 'exact',
      reasonText: '完全重名（同类型同父级）',
      type: keep.type,
      keepId: keep.id,
      keepName: keep.name,
      keepDisplay: keep.parent_name ? `${keep.parent_name} / ${keep.name}` : keep.name,
      mergeIds: arr.filter((r) => r.id !== keep.id).map((r) => r.id),
      candidates: arr.map((r) => ({ ...catCand(r), isKeep: r.id === keep.id, display: r.parent_name ? `${r.parent_name} / ${r.name}` : r.name })),
    });
  }

  // ② 空壳同名 + ③ 纯空壳：只针对「顶级分类」。
  //    理由：拍平导入只会在顶级产生孤立壳子；树内的空叶子（如 休闲娱乐/棋牌）是正常的未使用分类，不算重复。
  const topShells = rows.filter((r) => !r.parent_id && r.tx_count === 0 && r.child_count === 0 && r.budget_count === 0 && !used.has(r.id));
  const unused = [];
  for (const s of topShells) {
    const sn = catNormName(s.name);
    const containers = sn
      ? rows.filter((r) => r.id !== s.id && r.type === s.type && !r.parent_id && catNormName(r.name).includes(sn) && catNormName(r.name) !== sn)
      : [];
    if (!containers.length) { unused.push(s); continue; }
    // 容器优先选「有子级的顶级分类」（说明是主树），再看交易量
    const keep = [...containers].sort(
      (a, b) => (Number(b.child_count > 0) - Number(a.child_count > 0)) || (b.tx_count - a.tx_count) || (b.child_count - a.child_count)
    )[0];
    used.add(s.id);
    groups.push({
      reason: 'shell',
      reasonText: '空壳分类（0 交易 0 子级），名称被更大的顶级分类包含',
      type: s.type,
      keepId: keep.id,
      keepName: keep.name,
      keepDisplay: keep.name,
      mergeIds: [s.id],
      candidates: [{ ...catCand(s), isKeep: false, display: s.name }, { ...catCand(keep), isKeep: true, display: keep.name }],
    });
  }

  // ④ 同名不同父级：可能是历史误建，也可能是正常的两处同名（如「出差费用/交通」与顶级「交通」）—— 仅提示
  const nameMap = new Map();
  for (const r of rows) {
    if (used.has(r.id)) continue;
    const k = `${r.type}|${catNormName(r.name)}`;
    if (!nameMap.has(k)) nameMap.set(k, []);
    nameMap.get(k).push(r);
  }
  for (const arr of nameMap.values()) {
    if (arr.length < 2) continue;
    // 保留「挂在树里的那个」，顶级孤立壳子更容易是废弃项
    const keep = [...arr].sort((a, b) => Number(!!b.parent_id) - Number(!!a.parent_id) || b.tx_count - a.tx_count || b.child_count - a.child_count)[0];
    arr.forEach((r) => used.add(r.id));
    groups.push({
      reason: 'same-name',
      reasonText: '同名但父级不同（需人工判断）',
      type: keep.type,
      keepId: keep.id,
      keepName: keep.name,
      keepDisplay: keep.parent_name ? `${keep.parent_name} / ${keep.name}` : keep.name,
      mergeIds: arr.filter((r) => r.id !== keep.id).map((r) => r.id),
      candidates: arr.map((r) => {
        const inTree = !!r.parent_id;
        return { ...catCand(r), isKeep: r.id === keep.id, display: inTree ? `${r.parent_name} / ${r.name}` : r.name };
      }),
    });
  }

  const unusedList = unused.map((r) => ({ ...catCand(r), type: r.type }));

  return {
    ok: true,
    userId,
    stats: {
      total: rows.length,
      exact: groups.filter((g) => g.reason === 'exact').length,
      sameName: groups.filter((g) => g.reason === 'same-name').length,
      shell: groups.filter((g) => g.reason === 'shell').length,
      unused: unusedList.length,
    },
    groups,
    unused: unusedList,
    hint: 'exact 可直接合并；shell 是历史空壳（建议与容器合并）；same-name 需人工判断；unused 为孤立顶级分类，可合并到任意分类或直接删除。',
  };
}

// 校验并解析合并参数：target 与 sources 都支持 id 或名称
function catResolveTarget(userId, args) {
  if (args.targetId) {
    const r = db.prepare('SELECT * FROM categories WHERE id = ? AND user_id = ?').get(args.targetId, userId);
    if (!r) throw new Error('未找到目标分类 ' + args.targetId);
    return r;
  }
  if (!args.targetName) throw new Error('targetId 或 targetName 必须提供一个');
  const rows = db.prepare('SELECT * FROM categories WHERE user_id = ? AND name = ?').all(userId, args.targetName);
  if (!rows.length) throw new Error('未找到目标分类：' + args.targetName);
  if (rows.length > 1 && !args.type) throw new Error('存在多个同名分类（' + rows.length + ' 个），请改用 targetId 或补充 type：' + args.targetName);
  const typed = args.type ? rows.filter((r) => r.type === String(args.type).toUpperCase()) : rows;
  if (!typed.length) throw new Error('目标分类类型不匹配：' + args.targetName);
  return typed[0];
}

function categoryMerge(args) {
  args = args || {};
  const userId = args.userId || 'default';
  const dryRun = args.dryRun !== undefined ? !!args.dryRun : false;
  const deleteSource = args.deleteSource !== undefined ? !!args.deleteSource : true;

  const target = catResolveTarget(userId, args);

  // 收集来源：sourceIds 优先，其次 sourceNames
  const sources = [];
  if (Array.isArray(args.sourceIds) && args.sourceIds.length) {
    for (const id of args.sourceIds) {
      const r = db.prepare('SELECT * FROM categories WHERE id = ? AND user_id = ?').get(id, userId);
      if (!r) throw new Error('未找到来源分类 ' + id);
      sources.push(r);
    }
  } else if (Array.isArray(args.sourceNames) && args.sourceNames.length) {
    for (const name of args.sourceNames) {
      const rows = db.prepare('SELECT * FROM categories WHERE user_id = ? AND name = ?').all(userId, name);
      if (!rows.length) throw new Error('未找到来源分类：' + name);
      if (rows.length > 1 && !args.type) throw new Error('存在多个同名来源分类，请改用 sourceIds：' + name);
      const typed = args.type ? rows.filter((r) => r.type === String(args.type).toUpperCase()) : rows;
      if (!typed.length) throw new Error('来源分类类型不匹配：' + name);
      sources.push(typed[0]);
    }
  } else {
    throw new Error('sourceIds 或 sourceNames 必须提供一个（至少 1 个）');
  }

  const srcIds = [...new Set(sources.map((s) => s.id))];
  if (srcIds.includes(target.id)) throw new Error('目标分类不能同时作为来源：' + target.name);
  for (const s of sources) {
    if (s.type !== target.type) throw new Error(`类型不一致，无法合并：${s.name}(${s.type}) → ${target.name}(${target.type})。请先改成同一类型。`);
  }
  // 环检测：目标若在某个来源的子树内，合并会形成自环
  const parentStmt = db.prepare('SELECT parent_id FROM categories WHERE id = ?');
  let cursor = target.parent_id;
  while (cursor) {
    if (srcIds.includes(cursor)) throw new Error(`无法合并：目标分类「${target.name}」位于来源分类「${db.prepare('SELECT name FROM categories WHERE id=?').get(cursor).name}」的子树内，会形成循环父子关系。`);
    const row = parentStmt.get(cursor);
    cursor = row ? row.parent_id : null;
  }

  const ph = srcIds.map(() => '?').join(',');
  const movedTx = db.prepare(`SELECT COUNT(*) c FROM transactions WHERE category_id IN (${ph})`).get(...srcIds).c;
  const movedChildren = db.prepare(`SELECT COUNT(*) c FROM categories WHERE parent_id IN (${ph})`).get(...srcIds).c;
  const movedBudgets = db.prepare(`SELECT COUNT(*) c FROM budgets WHERE category_id IN (${ph})`).get(...srcIds).c;

  const plan = {
    ok: true,
    dryRun,
    target: catCand({ ...target, tx_count: db.prepare('SELECT COUNT(*) c FROM transactions WHERE category_id=?').get(target.id).c, child_count: db.prepare('SELECT COUNT(*) c FROM categories WHERE parent_id=?').get(target.id).c, budget_count: db.prepare('SELECT COUNT(*) c FROM budgets WHERE category_id=?').get(target.id).c, parent_name: null }),
    sources: sources.map((s) => ({ id: s.id, name: s.name, type: s.type })),
    moved: { transactions: movedTx, childCategories: movedChildren, budgets: movedBudgets },
    deleteSource,
  };
  if (dryRun) return { ...plan, note: 'dryRun 预览，未写入数据库。' };

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`UPDATE transactions SET category_id = ? WHERE category_id IN (${ph})`).run(target.id, ...srcIds);
    // 来源的子级改为挂在目标下（仅当来源是目标的子级时，子级上提到目标同层，语义最自然）
    db.prepare(`UPDATE categories SET parent_id = ? WHERE parent_id IN (${ph})`).run(target.id, ...srcIds);
    db.prepare(`UPDATE budgets SET category_id = ? WHERE category_id IN (${ph})`).run(target.id, ...srcIds);
    if (deleteSource) db.prepare(`DELETE FROM categories WHERE id IN (${ph})`).run(...srcIds);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { ...plan, ok: true, deleted: deleteSource ? srcIds : [] };
}

function categoryDedupe(args) {
  args = args || {};
  const userId = args.userId || 'default';
  // 批量操作默认只预览，显式传 dryRun:false 才落库
  const dryRun = args.dryRun !== undefined ? !!args.dryRun : true;
  const includeShell = !!args.includeShell;
  const report = categoryDuplicates({ userId, type: args.type });
  const targets = report.groups.filter((g) => g.reason === 'exact' || (includeShell && g.reason === 'shell'));

  const results = [];
  for (const g of targets) {
    try {
      const r = categoryMerge({ userId, targetId: g.keepId, sourceIds: g.mergeIds, deleteSource: true, dryRun });
      results.push({ keepName: g.keepDisplay || g.keepName, reason: g.reason, merged: g.candidates.filter((c) => !c.isKeep).map((c) => c.display || c.name), moved: r.moved, ok: true });
    } catch (e) {
      results.push({ keepName: g.keepName, reason: g.reason, ok: false, error: e.message });
    }
  }
  return {
    ok: true,
    dryRun,
    includeShell,
    groupsHandled: results.length,
    movedTransactions: results.reduce((s, r) => s + (r.moved ? r.moved.transactions : 0), 0),
    results,
    skippedSameName: report.stats.sameName,
    note: dryRun ? 'dryRun 预览，未写入数据库；传 dryRun:false 才会真正合并。' : '已按计划合并。',
  };
}

// ---------- 项目管理（add/update/delete）----------
function projectAdd(args) {
  if (!args.name) throw new Error('name 必填');
  const userId = args.userId || 'default';
  const id = getOrCreate('projects', { name: args.name }, { icon: args.icon || null, color: args.color || null, start_date: args.startDate || null, end_date: args.endDate || null }, userId);
  return { ok: true, project: db.prepare('SELECT * FROM projects WHERE id = ?').get(id) };
}
function projectUpdate(args) {
  if (!args.id) throw new Error('id 必填');
  const userId = args.userId || 'default';
  const existing = db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').get(args.id, userId);
  if (!existing) throw new Error('未找到项目 ' + args.id);
  const sets = []; const vals = [];
  if (args.name !== undefined) {
    const dup = db.prepare('SELECT id FROM projects WHERE user_id = ? AND name = ? AND id <> ?').get(userId, args.name, args.id);
    if (dup) throw new Error('该用户下已存在同名项目：' + args.name);
    sets.push('name = ?'); vals.push(args.name);
  }
  if (args.icon !== undefined) { sets.push('icon = ?'); vals.push(args.icon); }
  if (args.color !== undefined) { sets.push('color = ?'); vals.push(args.color); }
  if (args.startDate !== undefined) { sets.push('start_date = ?'); vals.push(args.startDate || null); }
  if (args.endDate !== undefined) { sets.push('end_date = ?'); vals.push(args.endDate || null); }
  if (!sets.length) return { ok: true, project: existing, note: '无字段变更' };
  vals.push(args.id);
  db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return { ok: true, project: db.prepare('SELECT * FROM projects WHERE id = ?').get(args.id) };
}
function projectDelete(args) {
  if (!args.id) throw new Error('id 必填');
  const userId = args.userId || 'default';
  const existing = db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').get(args.id, userId);
  if (!existing) throw new Error('未找到项目 ' + args.id);
  const used = db.prepare('SELECT COUNT(*) c FROM transactions WHERE project_id = ?').get(args.id).c;
  if (used > 0) throw new Error('该项目下尚有 ' + used + ' 笔交易，无法删除（可先改项目）。');
  db.prepare('DELETE FROM projects WHERE id = ?').run(args.id);
  return { ok: true, deleted: args.id };
}

// ---------- 成员管理（update/delete）----------
function memberUpdate(args) {
  if (!args.id) throw new Error('id 必填');
  const userId = args.userId || 'default';
  const existing = db.prepare('SELECT * FROM members WHERE id = ? AND user_id = ?').get(args.id, userId);
  if (!existing) throw new Error('未找到成员 ' + args.id);
  const sets = []; const vals = [];
  if (args.name !== undefined) {
    const dup = db.prepare('SELECT id FROM members WHERE user_id = ? AND name = ? AND id <> ?').get(userId, args.name, args.id);
    if (dup) throw new Error('该用户下已存在同名成员：' + args.name);
    sets.push('name = ?'); vals.push(args.name);
  }
  if (args.phone !== undefined) { sets.push('phone = ?'); vals.push(args.phone); }
  if (args.email !== undefined) { sets.push('email = ?'); vals.push(args.email); }
  if (args.icon !== undefined) { sets.push('icon = ?'); vals.push(args.icon); }
  if (args.color !== undefined) { sets.push('color = ?'); vals.push(args.color); }
  if (args.isDefault !== undefined) { sets.push('is_default = ?'); vals.push(args.isDefault ? 1 : 0); }
  if (!sets.length) return { ok: true, member: existing, note: '无字段变更' };
  vals.push(args.id);
  db.prepare(`UPDATE members SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return { ok: true, member: db.prepare('SELECT * FROM members WHERE id = ?').get(args.id) };
}
function memberDelete(args) {
  if (!args.id) throw new Error('id 必填');
  const userId = args.userId || 'default';
  const existing = db.prepare('SELECT * FROM members WHERE id = ? AND user_id = ?').get(args.id, userId);
  if (!existing) throw new Error('未找到成员 ' + args.id);
  const used = db.prepare('SELECT COUNT(*) c FROM transactions WHERE member_id = ?').get(args.id).c;
  if (used > 0) throw new Error('该成员下尚有 ' + used + ' 笔交易，无法删除（可先改成员）。');
  db.prepare('DELETE FROM members WHERE id = ?').run(args.id);
  return { ok: true, deleted: args.id };
}

// ---------- 应收应付（add/update/delete/list）----------
function receivableAdd(args) {
  if (!args.counterparty) throw new Error('counterparty（对方）必填');
  if (args.amount === undefined || args.amount === null || isNaN(Number(args.amount))) throw new Error('amount 必填数字');
  const userId = args.userId || 'default';
  const id = uid();
  db.prepare('INSERT INTO receivables (id,user_id,counterparty,amount,received_amount,description,due_date,status,contact_name) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, userId, args.counterparty, Number(args.amount), Number(args.receivedAmount) || 0, args.description || '', args.dueDate || null, args.status || 'PENDING', args.contactName || null);
  return { ok: true, receivable: db.prepare('SELECT * FROM receivables WHERE id = ?').get(id) };
}
function receivableUpdate(args) {
  if (!args.id) throw new Error('id 必填');
  const userId = args.userId || 'default';
  const existing = db.prepare('SELECT * FROM receivables WHERE id = ? AND user_id = ?').get(args.id, userId);
  if (!existing) throw new Error('未找到应收应付 ' + args.id);
  const sets = []; const vals = [];
  if (args.counterparty !== undefined) { sets.push('counterparty = ?'); vals.push(args.counterparty); }
  if (args.amount !== undefined) { sets.push('amount = ?'); vals.push(Number(args.amount)); }
  if (args.receivedAmount !== undefined) { sets.push('received_amount = ?'); vals.push(Number(args.receivedAmount)); }
  if (args.description !== undefined) { sets.push('description = ?'); vals.push(args.description); }
  if (args.dueDate !== undefined) { sets.push('due_date = ?'); vals.push(args.dueDate || null); }
  if (args.status !== undefined) { sets.push('status = ?'); vals.push(args.status); }
  if (args.contactName !== undefined) { sets.push('contact_name = ?'); vals.push(args.contactName || null); }
  if (!sets.length) return { ok: true, receivable: existing, note: '无字段变更' };
  vals.push(args.id);
  db.prepare(`UPDATE receivables SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return { ok: true, receivable: db.prepare('SELECT * FROM receivables WHERE id = ?').get(args.id) };
}
function receivableDelete(args) {
  if (!args.id) throw new Error('id 必填');
  const userId = args.userId || 'default';
  const existing = db.prepare('SELECT * FROM receivables WHERE id = ? AND user_id = ?').get(args.id, userId);
  if (!existing) throw new Error('未找到应收应付 ' + args.id);
  db.prepare('DELETE FROM receivables WHERE id = ?').run(args.id);
  return { ok: true, deleted: args.id };
}
function receivableList(args) {
  args = args || {};
  const userId = args.userId || 'default';
  const rows = db.prepare('SELECT * FROM receivables WHERE user_id = ? ORDER BY due_date').all(userId);
  return { count: rows.length, receivables: rows.map((r) => ({ id: r.id, counterparty: r.counterparty, amount: r.amount, received: r.received_amount, description: r.description, dueDate: r.due_date, status: r.status, contactName: r.contact_name })) };
}

// ---------- 预算（add/update/delete/list）----------
// 预算只挂一级分类：若传入的是二级分类，自动上卷到根分类
function normalizeBudgetCategory(userId, name) {
  if (!name) return null;
  const rows = db.prepare("SELECT * FROM categories WHERE user_id = ? AND name = ? AND type = 'EXPENSE'").all(userId, name);
  if (!rows.length) return getOrCreate('categories', { name, type: 'EXPENSE' }, {}, userId);
  let cur = rows[0];
  let guard = 0;
  while (cur.parent_id && guard++ < 10) {
    const p = db.prepare('SELECT * FROM categories WHERE id = ?').get(cur.parent_id);
    if (!p) break;
    cur = p;
  }
  return cur.id;
}

// 解析年份 / 月份 / 周期 → 归一化后的 { year, month(YYYY-MM|null), period, startDate, endDate }
function normalizeBudgetPeriod(args, existing) {
  const now = new Date();
  const period = String((args.period || (existing && existing.period) || 'YEARLY')).toUpperCase() === 'MONTHLY' ? 'MONTHLY' : 'YEARLY';
  let year = Number(args.year !== undefined ? args.year : (existing && existing.year));
  if (!year || isNaN(year)) year = now.getFullYear();
  let month = args.month !== undefined ? args.month : (existing ? existing.month : null);
  // 允许传 11 / '11' / '2026-11'
  let mm = null;
  if (month !== null && month !== undefined && String(month).trim() !== '') {
    const s = String(month).trim();
    if (/^\d{4}-\d{2}$/.test(s)) mm = Number(s.slice(5, 7));
    else if (/^\d{1,2}$/.test(s)) mm = Number(s);
  }
  if (period === 'YEARLY') {
    return { period, year, month: null, startDate: `${year}-01-01`, endDate: `${year}-12-31` };
  }
  if (!mm || mm < 1 || mm > 12) throw new Error('月预算必须指定月份（1–12）');
  const lastDay = new Date(year, mm, 0).getDate();
  const yyyymm = `${year}-${String(mm).padStart(2, '0')}`;
  return { period, year, month: yyyymm, startDate: `${yyyymm}-01`, endDate: `${yyyymm}-${String(lastDay).padStart(2, '0')}` };
}

function budgetAdd(args) {
  if (args.amount === undefined || args.amount === null || isNaN(Number(args.amount))) throw new Error('amount 必填数字');
  const userId = args.userId || 'default';
  const categoryId = normalizeBudgetCategory(userId, args.category);
  const p = normalizeBudgetPeriod(args, null);
  // 同分类 + 同周期 + 同期间视为同一条预算，重复新增则更新金额，避免产生重复行
  const dup = db.prepare('SELECT * FROM budgets WHERE user_id=? AND IFNULL(category_id,\'\')=IFNULL(?,\'\') AND period=? AND IFNULL(year,0)=? AND IFNULL(month,\'\')=IFNULL(?,\'\')')
    .get(userId, categoryId, p.period, p.year, p.month);
  if (dup) {
    db.prepare('UPDATE budgets SET amount=?, start_date=?, end_date=? WHERE id=?').run(Number(args.amount), p.startDate, p.endDate, dup.id);
    return { ok: true, budget: db.prepare('SELECT * FROM budgets WHERE id = ?').get(dup.id), note: '该期间已有同类预算，已更新金额' };
  }
  const id = uid();
  db.prepare('INSERT INTO budgets (id,user_id,category_id,amount,period,start_date,end_date,month,year) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, userId, categoryId, Number(args.amount), p.period, p.startDate, p.endDate, p.month, p.year);
  return { ok: true, budget: db.prepare('SELECT * FROM budgets WHERE id = ?').get(id) };
}
function budgetUpdate(args) {
  if (!args.id) throw new Error('id 必填');
  const userId = args.userId || 'default';
  const existing = db.prepare('SELECT * FROM budgets WHERE id = ? AND user_id = ?').get(args.id, userId);
  if (!existing) throw new Error('未找到预算 ' + args.id);
  const sets = []; const vals = [];
  if (args.category !== undefined) { const cid = args.category ? normalizeBudgetCategory(userId, args.category) : null; sets.push('category_id = ?'); vals.push(cid); }
  if (args.amount !== undefined) { sets.push('amount = ?'); vals.push(Number(args.amount)); }
  // 周期/年份/月份任一变化都重新推导期间，避免出现「YEARLY 但带 month」这种脏组合
  if (args.period !== undefined || args.year !== undefined || args.month !== undefined) {
    const p = normalizeBudgetPeriod(args, existing);
    sets.push('period = ?'); vals.push(p.period);
    sets.push('year = ?'); vals.push(p.year);
    sets.push('month = ?'); vals.push(p.month);
    sets.push('start_date = ?'); vals.push(p.startDate);
    sets.push('end_date = ?'); vals.push(p.endDate);
  }
  if (!sets.length) return { ok: true, budget: existing, note: '无字段变更' };
  vals.push(args.id);
  db.prepare(`UPDATE budgets SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return { ok: true, budget: db.prepare('SELECT * FROM budgets WHERE id = ?').get(args.id) };
}
function budgetDelete(args) {
  if (!args.id) throw new Error('id 必填');
  const userId = args.userId || 'default';
  const existing = db.prepare('SELECT * FROM budgets WHERE id = ? AND user_id = ?').get(args.id, userId);
  if (!existing) throw new Error('未找到预算 ' + args.id);
  db.prepare('DELETE FROM budgets WHERE id = ?').run(args.id);
  return { ok: true, deleted: args.id };
}
function budgetList(args) {
  args = args || {};
  const userId = args.userId || 'default';
  const rows = db.prepare('SELECT b.*, c.name category FROM budgets b LEFT JOIN categories c ON b.category_id=c.id WHERE b.user_id=? ORDER BY b.year DESC, b.month DESC').all(userId);
  return { count: rows.length, budgets: rows.map((b) => ({ id: b.id, category: b.category, amount: b.amount, period: b.period, month: b.month, year: b.year, startDate: b.start_date, endDate: b.end_date })) };
}

// ---------- 用户（多租户辅助） ----------
function userList() {
  const rows = db.prepare('SELECT id, name, created_at FROM users ORDER BY name').all();
  return { count: rows.length, users: rows };
}
function userCreate(args) {
  if (!args.name) throw new Error('name 必填');
  const row = db.prepare('SELECT id FROM users WHERE name = ?').get(args.name);
  if (row) return { ok: true, user: db.prepare('SELECT * FROM users WHERE id = ?').get(row.id), note: '已存在' };
  const id = uid();
  db.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run(id, args.name);
  seedCategoriesIfEmpty(args.name);
  return { ok: true, user: db.prepare('SELECT * FROM users WHERE id = ?').get(id) };
}

// ---------- 报表 ----------
function reportMonthly(args) {
  const userId = args.userId || 'default';
  const now = new Date();
  const year = Number(args.year) || now.getFullYear();
  const month = Number(args.month) || (now.getMonth() + 1);
  const pad = (m) => String(m).padStart(2, '0');
  const ym = `${year}-${pad(month)}`;
  const from = `${ym}-01`;
  const nx = month === 12 ? `${year + 1}-01-01` : `${year}-${pad(month + 1)}-01`;
  const income = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE user_id=? AND type='INCOME' AND date >= ? AND date < ?").get(userId, from, nx).s;
  const expense = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE user_id=? AND type='EXPENSE' AND date >= ? AND date < ?").get(userId, from, nx).s;
  const byCat = db.prepare("SELECT c.name category, COALESCE(SUM(t.amount),0) amount FROM transactions t LEFT JOIN categories c ON t.category_id=c.id WHERE t.user_id=? AND t.type='EXPENSE' AND t.date >= ? AND t.date < ? GROUP BY c.name ORDER BY amount DESC").all(userId, from, nx);
  const byAccount = db.prepare("SELECT a.name account, COALESCE(SUM(t.amount),0) amount FROM transactions t LEFT JOIN accounts a ON t.account_id=a.id WHERE t.user_id=? AND t.type='EXPENSE' AND t.date >= ? AND t.date < ? GROUP BY a.name ORDER BY amount DESC").all(userId, from, nx);
  return { period: ym, income, expense, net: income - expense, byCategory: byCat, byAccount };
}

function reportByCategory(args) {
  const userId = args.userId || 'default';
  const type = String(args.type || 'EXPENSE').toUpperCase();
  const where = ['t.user_id = ?', 't.type = ?'];
  const vals = [userId, type];
  if (args.from) { where.push('t.date >= ?'); vals.push(args.from); }
  if (args.to) { where.push('t.date <= ?'); vals.push(args.to); }
  const rows = db.prepare(`SELECT c.name category, COALESCE(SUM(t.amount),0) amount, COUNT(*) cnt FROM transactions t LEFT JOIN categories c ON t.category_id=c.id WHERE ${where.join(' AND ')} GROUP BY c.name ORDER BY amount DESC`).all(...vals);
  const total = rows.reduce((s, r) => s + r.amount, 0);
  return { type, total, groups: rows };
}

// 分类子树 id（预算挂在二级分类的交易也要算进来）
function catSubtreeIds(categoryId) {
  if (!categoryId) return [];
  const out = new Set([categoryId]);
  const stack = [categoryId];
  const stmt = db.prepare('SELECT id FROM categories WHERE parent_id = ?');
  while (stack.length) {
    const id = stack.pop();
    for (const c of stmt.all(id)) if (!out.has(c.id)) { out.add(c.id); stack.push(c.id); }
  }
  return [...out];
}

// 期间内某分类子树的实际支出（from 含、to 不含）
function budgetActual(userId, categoryId, from, to) {
  const ids = catSubtreeIds(categoryId);
  if (!ids.length) return 0;
  const ph = ids.map(() => '?').join(',');
  const s = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE user_id=? AND type='EXPENSE' AND date>=? AND date<? AND category_id IN (${ph})`)
    .get(userId, from, to, ...ids).s;
  return Math.round(Number(s) * 100) / 100;
}

function budgetPeriodRange(year, month) {
  if (month) {
    const mm = Number(String(month).slice(5, 7)) || Number(month);
    const from = `${year}-${String(mm).padStart(2, '0')}-01`;
    const to = mm === 12 ? `${year + 1}-01-01` : `${year}-${String(mm + 1).padStart(2, '0')}-01`;
    return [from, to];
  }
  return [`${year}-01-01`, `${year + 1}-01-01`];
}

/*
 * 预算执行报表：按年筛选，可选月份。
 * 同分类若同时存在年预算与月预算，则月预算作为年预算的子行返回（年/月两级）。
 */
function reportBudget(args) {
  args = args || {};
  const userId = args.userId || 'default';
  const now = new Date();
  const year = Number(args.year) || now.getFullYear();
  const monthFilter = args.month && String(args.month) !== 'all' ? Number(args.month) : null;

  const rows = db.prepare(
    'SELECT b.*, c.name category FROM budgets b LEFT JOIN categories c ON b.category_id=c.id WHERE b.user_id=? AND IFNULL(b.year, ?) = ?'
  ).all(userId, year, year);

  const items = rows.map((b) => {
    const isMonthly = String(b.period).toUpperCase() === 'MONTHLY' && !!b.month;
    const bMonth = isMonthly ? Number(String(b.month).slice(5, 7)) : null;
    const [from, to] = budgetPeriodRange(Number(b.year) || year, isMonthly ? bMonth : null);
    const actual = budgetActual(userId, b.category_id, from, to);
    return {
      id: b.id, categoryId: b.category_id, category: b.category || '未分类',
      period: isMonthly ? 'MONTHLY' : 'YEARLY', year: Number(b.year) || year,
      month: isMonthly ? b.month : null, monthNum: bMonth,
      amount: Number(b.amount) || 0, actual,
      remaining: Math.round(((Number(b.amount) || 0) - actual) * 100) / 100,
      ratio: (Number(b.amount) || 0) > 0 ? Math.round((actual / Number(b.amount)) * 1000) / 1000 : null,
      over: actual > (Number(b.amount) || 0),
    };
  });

  let monthly = items.filter((i) => i.period === 'MONTHLY');
  if (monthFilter) monthly = monthly.filter((i) => i.monthNum === monthFilter && i.year === year);
  const yearly = items.filter((i) => i.period === 'YEARLY');

  // 年/月两级：月预算挂到同分类的年预算下
  const byCat = new Map();
  for (const m of monthly) {
    if (!byCat.has(m.categoryId || '')) byCat.set(m.categoryId || '', []);
    byCat.get(m.categoryId || '').push(m);
  }
  const tree = yearly.map((y) => ({ ...y, children: (byCat.get(y.categoryId || '') || []).sort((a, b) => (a.month > b.month ? 1 : -1)) }));
  for (const y of tree) byCat.delete(y.categoryId || '');
  // 只存在月预算、没有年预算的分类 → 平铺展示
  for (const rest of byCat.values()) for (const m of rest) tree.push({ ...m, children: [] });
  tree.sort((a, b) => (b.amount - a.amount) || String(a.category).localeCompare(String(b.category), 'zh'));

  const totalBudget = tree.reduce((s, r) => s + r.amount, 0);
  const totalActual = tree.reduce((s, r) => s + r.actual, 0);
  const summary = {
    budget: Math.round(totalBudget * 100) / 100,
    actual: Math.round(totalActual * 100) / 100,
    remaining: Math.round((totalBudget - totalActual) * 100) / 100,
    ratio: totalBudget > 0 ? Math.round((totalActual / totalBudget) * 1000) / 1000 : null,
    yearlyCount: tree.filter((r) => r.period === 'YEARLY').length,
    monthlyCount: tree.reduce((s, r) => s + r.children.length, 0) + tree.filter((r) => r.period === 'MONTHLY').length,
  };
  return { year, month: monthFilter, summary, rows: tree, budgets: tree };
}

function reportReceivables(args) {
  const userId = args.userId || 'default';
  const summary = db.prepare("SELECT status, COUNT(*) cnt, COALESCE(SUM(amount),0) total, COALESCE(SUM(received_amount),0) received FROM receivables WHERE user_id=? GROUP BY status").all(userId);
  const outstanding = db.prepare("SELECT COALESCE(SUM(amount - received_amount),0) o FROM receivables WHERE user_id=? AND status IN ('PENDING','PARTIAL','OVERDUE')").get(userId).o;
  const items = db.prepare("SELECT * FROM receivables WHERE user_id=? AND status IN ('PENDING','PARTIAL','OVERDUE') ORDER BY due_date").all(userId);
  return { summary, outstanding, items };
}

// ---------- 导入（多库合并扫描，按 userId 隔离）----------
function importFromMylife(args) {
  args = args || {};
  const userId = args.userId || 'default';
  const scope = (args.scope || 'all').toLowerCase();
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const { DatabaseSync } = require('node:sqlite');
  const candidates = [];
  if (args.dbPath) candidates.push(args.dbPath);
  if (process.env.MYLF_MYSQLITE_DB) candidates.push(process.env.MYLF_MYSQLITE_DB);
  candidates.push(path.join(os.homedir(), 'AppData', 'Roaming', 'MyLifeOS', 'data', 'mylife-os.db'));
  candidates.push('C:\\ProgramData\\MyLifeOS\\mylife-os.db');
  const found = candidates.filter((c) => c && fs.existsSync(c));
  if (!found.length) throw new Error('未找到 MyLifeOS 数据库，请用 dbPath 指定，例如 import_from_mylife({dbPath:"C:/ProgramData/MyLifeOS/mylife-os.db"})');
  const agg = { accounts: 0, categories: 0, transactions: 0, members: 0, merchants: 0, projects: 0, receivables: 0, budgets: 0, sources: [], userId, scope };
  for (const srcPath of found) {
    let src;
    try { src = new DatabaseSync(srcPath, { readOnly: true }); }
    catch (e) { agg.sources.push({ path: srcPath, error: e.message }); continue; }
    try {
      const s = importFromDb(src, userId, scope);
      for (const k of Object.keys(agg)) { if (k !== 'sources') agg[k] += s[k]; }
      agg.sources.push({ path: srcPath, ...s });
    } catch (e) {
      agg.sources.push({ path: srcPath, error: e.message });
    } finally { src.close(); }
  }
  return { ok: true, stats: agg };
}

function importFromDb(src, userId, scope) {
  const stats = { accounts: 0, categories: 0, transactions: 0, members: 0, merchants: 0, projects: 0, receivables: 0, budgets: 0 };
  const isCat = scope === 'categories';
  const accMap = {};
  for (const a of src.prepare('SELECT * FROM finance_accounts WHERE deletedAt IS NULL').all()) {
    const r = ensure('accounts', { name: a.name }, { type: a.type, balance: a.balance || 0, currency: a.currency || 'CNY', icon: a.icon, color: a.color }, userId);
    if (r.created) stats.accounts++; accMap[a.id] = a.name;
  }
  // 两级分类：先建父、再建子。srcToOur 建立 MyLifeOS 分类 id → 本库 id 映射，供交易/预算引用。
  const srcCat = src.prepare('SELECT * FROM categories WHERE deletedAt IS NULL').all();
  const srcToOur = {};
  let pending = srcCat.slice();
  let progressed = true;
  while (pending.length && progressed) {
    progressed = false;
    const next = [];
    for (const c of pending) {
      let pid = null;
      if (c.parentId) {
        if (srcToOur[c.parentId]) pid = srcToOur[c.parentId];
        else { next.push(c); continue; }
      }
      const r = ensure('categories', { name: c.name, type: c.type, parent_id: pid }, { icon: c.icon, color: c.color, sort_order: c.sortOrder || 0 }, userId);
      if (r.created) stats.categories++;
      srcToOur[c.id] = r.id;
      progressed = true;
    }
    pending = next;
  }
  const catMap = srcToOur;
  // scope='categories'：仅导入账户（作为期初账户）与分类（作为期初分类），不导交易等流水
  if (isCat) return stats;
  const memMap = {};
  for (const m of src.prepare('SELECT * FROM members WHERE deletedAt IS NULL').all()) { const r = ensure('members', { name: m.name }, {}, userId); if (r.created) stats.members++; memMap[m.id] = m.name; }
  const merMap = {};
  for (const m of src.prepare('SELECT * FROM merchants WHERE deletedAt IS NULL').all()) { const r = ensure('merchants', { name: m.name }, {}, userId); if (r.created) stats.merchants++; merMap[m.id] = m.name; }
  const projMap = {};
  for (const p of src.prepare('SELECT * FROM account_projects WHERE deletedAt IS NULL').all()) { const r = ensure('projects', { name: p.name }, {}, userId); if (r.created) stats.projects++; projMap[p.id] = p.name; }

  const accName = (id) => (id && accMap[id]) ? accMap[id] : null;
  for (const t of src.prepare('SELECT * FROM transactions WHERE deletedAt IS NULL').all()) {
    const an = accName(t.financeAccountId); if (!an) continue;
    const accountId = getOrCreate('accounts', { name: an }, {}, userId);
    const categoryId = (t.categoryId && catMap[t.categoryId]) ? catMap[t.categoryId] : null;
    const toAccountId = (t.toAccountId && accMap[t.toAccountId]) ? getOrCreate('accounts', { name: accMap[t.toAccountId] }, {}, userId) : null;
    const memberId = (t.memberId && memMap[t.memberId]) ? getOrCreate('members', { name: memMap[t.memberId] }, {}, userId) : null;
    const merchantId = (t.merchantId && merMap[t.merchantId]) ? getOrCreate('merchants', { name: merMap[t.merchantId] }, {}, userId) : null;
    const projectId = (t.accountProjectId && projMap[t.accountProjectId]) ? getOrCreate('projects', { name: projMap[t.accountProjectId] }, {}, userId) : null;
    const dup = db.prepare('SELECT id FROM transactions WHERE user_id=? AND date=? AND amount=? AND description=? AND account_id=?').get(userId, t.date, t.amount, t.description || '', accountId);
    if (dup) continue;
    db.prepare('INSERT INTO transactions (id,user_id,account_id,to_account_id,category_id,type,amount,description,date,tags,member_id,merchant_id,project_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(uid(), userId, accountId, toAccountId, categoryId, t.type, t.amount, t.description || '', normalizeDate(t.date), t.tags || null, memberId, merchantId, projectId);
    stats.transactions++;
  }
  for (const r of src.prepare('SELECT * FROM receivables WHERE deletedAt IS NULL').all()) {
    const dup = db.prepare('SELECT id FROM receivables WHERE user_id=? AND counterparty=? AND amount=? AND description=?').get(userId, r.counterparty, r.amount, r.description || '');
    if (dup) continue;
    db.prepare('INSERT INTO receivables (id,user_id,counterparty,amount,received_amount,description,due_date,status,contact_name) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(uid(), userId, r.counterparty, r.amount, r.receivedAmount || 0, r.description || '', r.dueDate || null, r.status, r.contactName || null);
    stats.receivables++;
  }
  for (const b of src.prepare('SELECT * FROM budgets WHERE deletedAt IS NULL').all()) {
    const month = b.month || null;
    const dup = db.prepare('SELECT id FROM budgets WHERE user_id=? AND month=? AND year=?').get(userId, month, b.year || null);
    if (dup) continue;
    const categoryId = (b.categoryId && catMap[b.categoryId]) ? catMap[b.categoryId] : null;
    db.prepare('INSERT INTO budgets (id,user_id,category_id,amount,period,start_date,end_date,month,year) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(uid(), userId, categoryId, b.amount, b.period || 'MONTHLY', b.startDate || null, b.endDate || null, month, b.year || null);
    stats.budgets++;
  }
  return stats;
}

// ---------- 下拉数据（按使用频次排序） ----------
/*
 * 手工记账 / 查询条件里的下拉，最怕「常用项埋在 200 个选项中间」。
 * 这里直接按被引用次数降序返回：用得越多的排越前，同频次按名称。
 */
function selectorLists(args) {
  args = args || {};
  const userId = args.userId || 'default';
  const byName = (a, b) => String(a.name).localeCompare(String(b.name), 'zh');

  const accounts = db.prepare(`
    SELECT a.id, a.name, a.type, a.currency, a.archived,
      (SELECT COUNT(*) FROM transactions t WHERE t.user_id = a.user_id AND (t.account_id = a.id OR t.to_account_id = a.id)) used
    FROM accounts a WHERE a.user_id = ? AND a.archived = 0`).all(userId)
    .map((r) => ({ id: r.id, name: r.name, type: r.type, currency: r.currency, used: r.used }))
    .sort((a, b) => b.used - a.used || byName(a, b));

  const members = db.prepare(`
    SELECT m.id, m.name,
      (SELECT COUNT(*) FROM transactions t WHERE t.member_id = m.id) used
    FROM members m WHERE m.user_id = ?`).all(userId)
    .map((r) => ({ id: r.id, name: r.name, used: r.used }))
    .sort((a, b) => b.used - a.used || byName(a, b));

  const merchants = db.prepare(`
    SELECT me.id, me.name, me.category,
      (SELECT COUNT(*) FROM transactions t WHERE t.merchant_id = me.id) used
    FROM merchants me WHERE me.user_id = ?`).all(userId)
    .map((r) => ({ id: r.id, name: r.name, category: r.category, used: r.used }))
    .sort((a, b) => b.used - a.used || byName(a, b));

  const projects = db.prepare(`
    SELECT p.id, p.name,
      (SELECT COUNT(*) FROM transactions t WHERE t.project_id = p.id) used
    FROM projects p WHERE p.user_id = ?`).all(userId)
    .map((r) => ({ id: r.id, name: r.name, used: r.used }))
    .sort((a, b) => b.used - a.used || byName(a, b));

  // 一级分类的 used 要把子分类的引用一起算上，否则「食品酒水」永远是 0
  const cats = db.prepare(`
    SELECT c.id, c.name, c.type, c.parent_id, p.name parent_name, c.sort_order,
      (SELECT COUNT(*) FROM transactions t WHERE t.category_id = c.id) used
    FROM categories c LEFT JOIN categories p ON c.parent_id = p.id
    WHERE c.user_id = ?`).all(userId);
  const roll = new Map();
  for (const c of cats) roll.set(c.id, c.used);
  for (const c of cats) {
    if (c.parent_id && roll.has(c.parent_id)) roll.set(c.parent_id, roll.get(c.parent_id) + c.used);
  }
  const categories = cats
    .map((c) => ({
      id: c.id, name: c.name, type: c.type, parentId: c.parent_id || null,
      parentName: c.parent_name || null, used: roll.get(c.id) || 0,
    }))
    .sort((a, b) => b.used - a.used || String(a.name).localeCompare(String(b.name), 'zh'));

  return { ok: true, userId, accounts, members, merchants, projects, categories };
}

// ---------- 报表（统一筛选条件，六维度聚合） ----------
/*
 * 与 /api/summary 的区别：summary 固定「本年/本月」口径，本函数接受任意筛选，
 * 一次把六个维度都算出来，前端画六张饼图只需一次请求。
 * 转账不计入收支（转出转入不是花钱也不是赚钱），所以默认排除 TRANSFER。
 */
function reportOverview(args) {
  args = args || {};
  const userId = args.userId || 'default';
  const where = ['t.user_id = ?'];
  const vals = [userId];

  const type = args.type ? String(args.type).toUpperCase() : null;
  if (type === 'INCOME' || type === 'EXPENSE') {
    where.push('t.type = ?'); vals.push(type);
  } else {
    where.push("t.type IN ('INCOME','EXPENSE')");
  }
  if (args.from) { where.push('date(t.date) >= date(?)'); vals.push(args.from); }
  if (args.to) { where.push('date(t.date) <= date(?)'); vals.push(args.to); }
  if (args.account) { where.push('a.name = ?'); vals.push(args.account); }
  if (args.member) { where.push('m.name = ?'); vals.push(args.member); }
  if (args.merchant) { where.push('me.name = ?'); vals.push(args.merchant); }
  if (args.project) { where.push('p.name = ?'); vals.push(args.project); }
  if (args.categoryId) {
    const ids = catSubtreeIds(args.categoryId);
    if (!ids.length) where.push('1=0');
    else { where.push(`t.category_id IN (${ids.map(() => '?').join(',')})`); vals.push(...ids); }
  }
  if (args.q) { where.push("IFNULL(t.description,'') LIKE ?"); vals.push('%' + args.q + '%'); }

  const base = `FROM transactions t
    LEFT JOIN accounts a ON t.account_id = a.id
    LEFT JOIN members m ON t.member_id = m.id
    LEFT JOIN merchants me ON t.merchant_id = me.id
    LEFT JOIN projects p ON t.project_id = p.id`;
  const wsql = where.join(' AND ');

  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN t.type='INCOME' THEN t.amount ELSE 0 END),0) income,
      COALESCE(SUM(CASE WHEN t.type='EXPENSE' THEN t.amount ELSE 0 END),0) expense,
      COUNT(*) cnt
    ${base} WHERE ${wsql}`).get(...vals);
  const income = round2(totals.income);
  const expense = round2(totals.expense);

  // 维度聚合：每项同时给 收入/支出/合计，前端可以按口径切换
  const groupsFor = (expr) => db.prepare(`
      SELECT ${expr} name,
        COALESCE(SUM(CASE WHEN t.type='INCOME' THEN t.amount ELSE 0 END),0) income,
        COALESCE(SUM(CASE WHEN t.type='EXPENSE' THEN t.amount ELSE 0 END),0) expense,
        COUNT(*) cnt
      ${base} WHERE ${wsql} GROUP BY 1`).all(...vals)
    .map((r) => ({ name: r.name || '未指定', income: round2(r.income), expense: round2(r.expense), amount: round2(r.income + r.expense), cnt: r.cnt }))
    .sort((a, b) => b.amount - a.amount);

  // 分类按一级归并：交易挂二级时上卷到根
  const cats = db.prepare('SELECT id, name, parent_id FROM categories WHERE user_id = ?').all(userId);
  const catById = new Map(cats.map((c) => [c.id, c]));
  const rootName = (id) => {
    let cur = catById.get(id);
    let guard = 0;
    while (cur && cur.parent_id && guard++ < 10) cur = catById.get(cur.parent_id);
    return cur ? cur.name : '未分类';
  };
  const catRows = db.prepare(`
      SELECT t.category_id cid, t.type ty,
        COALESCE(SUM(t.amount),0) amount, COUNT(*) cnt
      ${base} WHERE ${wsql} GROUP BY t.category_id, t.type`).all(...vals);
  const catAgg = new Map();
  for (const r of catRows) {
    const key = r.cid ? rootName(r.cid) : '未分类';
    const cur = catAgg.get(key) || { name: key, income: 0, expense: 0, cnt: 0 };
    if (r.ty === 'INCOME') cur.income += Number(r.amount || 0);
    else cur.expense += Number(r.amount || 0);
    cur.cnt += r.cnt;
    catAgg.set(key, cur);
  }
  const catList = [...catAgg.values()].map((c) => ({
    name: c.name, income: round2(c.income), expense: round2(c.expense), amount: round2(c.income + c.expense), cnt: c.cnt,
  }));

  return {
    ok: true,
    userId,
    filters: {
      type: type || 'ALL', from: args.from || null, to: args.to || null,
      account: args.account || null, member: args.member || null, merchant: args.merchant || null,
      project: args.project || null, categoryId: args.categoryId || null, q: args.q || null,
    },
    totals: { income, expense, net: round2(income - expense), count: totals.cnt },
    incomeByCategory: catList.filter((c) => c.income > 0).sort((a, b) => b.income - a.income),
    expenseByCategory: catList.filter((c) => c.expense > 0).sort((a, b) => b.expense - a.expense),
    byAccount: groupsFor("COALESCE(a.name,'未指定')"),
    byMember: groupsFor("COALESCE(m.name,'未指定')"),
    byMerchant: groupsFor("COALESCE(me.name,'未指定')"),
    byProject: groupsFor("COALESCE(p.name,'未指定')"),
  };
}

// ---------- 工具注册表 ----------
const list = [
  {
    name: 'tx_add', description: '记一笔收支或转账。account 必填；category/type/amount 按需。账户、分类、成员、商家、项目不存在时按名自动创建。userId 可选（默认 default）。',
    inputSchema: { type: 'object', properties: {
      userId: { type: 'string', description: '用户隔离键，Octop 由登录用户注入，本地默认 default' },
      account: { type: 'string', description: '账户名，如 "招商银行"' },
      accountType: { type: 'string', description: '账户类型 DEBIT_CARD/CREDIT_CARD/INVESTMENT/CASH/E_WALLET/OTHER' },
      type: { type: 'string', description: 'INCOME / EXPENSE / TRANSFER，默认 EXPENSE' },
      amount: { type: 'number', description: '金额（正数）' },
      category: { type: 'string', description: '分类名，如 "餐饮"' },
      description: { type: 'string' },
      date: { type: 'string', description: '日期 YYYY-MM-DD，也可传 2026-11-16T14:32:05 带时分秒；默认当前时间' },
      time: { type: 'string', description: '时分秒 HH:MM:SS，配合 date 使用' },
      tags: { type: 'string' },
      member: { type: 'string', description: '成员名' },
      merchant: { type: 'string', description: '商家名' },
      project: { type: 'string', description: '财务项目名' },
      toAccount: { type: 'string', description: '转账目标账户（TRANSFER 时）' },
      toAccountType: { type: 'string' },
    }, required: ['account', 'amount'] },
    handler: txAdd,
  },
  {
    name: 'tx_list', description: '查询账目，支持按 type/account/category/member/merchant/project/日期区间/tag 过滤，倒序返回。返回 total（命中总数）、pages、sum（跨页全部合计）与当前页 records。userId 可选。',
    inputSchema: { type: 'object', properties: {
      userId: { type: 'string' }, type: { type: 'string' }, account: { type: 'string' }, category: { type: 'string' },
      categoryId: { type: 'string', description: '按分类 id 过滤，含其全部子分类' },
      member: { type: 'string' }, merchant: { type: 'string' }, project: { type: 'string' },
      from: { type: 'string' }, to: { type: 'string' }, year: { type: 'number', description: '按年查询（只给年份即可）' },
      q: { type: 'string', description: '说明关键词' }, tag: { type: 'string' },
      page: { type: 'number', description: '第几页（从 1 开始），与 pageSize 配合' },
      pageSize: { type: 'number', description: '每页条数，默认 50，上限 5000' },
      limit: { type: 'number', description: '兼容旧参数；没给 page 时生效，默认 50' },
      offset: { type: 'number', description: '兼容旧参数；没给 page 时生效' }, includeArchived: { type: 'boolean' },
    } },
    handler: txList,
  },
  {
    name: 'tx_update', description: '按 id 修改一笔交易。userId 可选。',
    inputSchema: { type: 'object', properties: {
      id: { type: 'string' }, userId: { type: 'string' }, account: { type: 'string' }, toAccount: { type: 'string' },
      category: { type: 'string' }, type: { type: 'string' }, amount: { type: 'number' },
      description: { type: 'string' }, date: { type: 'string' }, tags: { type: 'string' },
      member: { type: 'string' }, merchant: { type: 'string' }, project: { type: 'string' },
    }, required: ['id'] },
    handler: txUpdate,
  },
  {
    name: 'tx_delete', description: '按 id 删除一笔交易。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, userId: { type: 'string' } }, required: ['id'] },
    handler: txDelete,
  },
  {
    name: 'account_add', description: '新增账户。userId 可选。支持卡号（cardNo）与备注（note）。',
    inputSchema: { type: 'object', properties: { userId: { type: 'string' }, name: { type: 'string' }, type: { type: 'string' }, currency: { type: 'string' }, balance: { type: 'number' }, cardNo: { type: 'string' }, note: { type: 'string' }, icon: { type: 'string' }, color: { type: 'string' } }, required: ['name'] },
    handler: accountAdd,
  },
  {
    name: 'account_list', description: '列出账户（按用户隔离）。',
    inputSchema: { type: 'object', properties: { userId: { type: 'string' }, includeArchived: { type: 'boolean' } } },
    handler: accountList,
  },
  {
    name: 'account_update', description: '修改账户（名称/类型/余额/币种/卡号/备注/归档）。传 balance 时默认生成一条「余额调整」流水（收入或支出），使账户余额等于目标值；adjustBalance=false 则直接改期初余额。同一用户下账户名不可重复。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, userId: { type: 'string' }, name: { type: 'string' }, type: { type: 'string' }, balance: { type: 'number' }, currency: { type: 'string' }, cardNo: { type: 'string' }, note: { type: 'string' }, adjustBalance: { type: 'boolean' }, adjustNote: { type: 'string' }, icon: { type: 'string' }, color: { type: 'string' }, archived: { type: 'boolean' } }, required: ['id'] },
    handler: accountUpdate,
  },
  {
    name: 'account_delete', description: '删除账户（仅当该用户下无交易引用时；否则请改用归档）。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, userId: { type: 'string' } }, required: ['id'] },
    handler: accountDelete,
  },
  {
    name: 'category_add', description: '新增分类（INCOME/EXPENSE）。userId 可选。',
    inputSchema: { type: 'object', properties: { userId: { type: 'string' }, name: { type: 'string' }, type: { type: 'string' }, icon: { type: 'string' }, color: { type: 'string' }, parentId: { type: 'string' } }, required: ['name', 'type'] },
    handler: categoryAdd,
  },
  {
    name: 'category_list', description: '列出分类（按用户隔离）。',
    inputSchema: { type: 'object', properties: { userId: { type: 'string' }, type: { type: 'string' } } },
    handler: categoryList,
  },
  {
    name: 'member_add', description: '新增成员。userId 可选。',
    inputSchema: { type: 'object', properties: { userId: { type: 'string' }, name: { type: 'string' } }, required: ['name'] },
    handler: memberAdd,
  },
  {
    name: 'member_list', description: '列出成员（按用户隔离），供下拉联动。',
    inputSchema: { type: 'object', properties: { userId: { type: 'string' } } },
    handler: memberList,
  },
  {
    name: 'merchant_add', description: '新增商家。userId 可选。',
    inputSchema: { type: 'object', properties: { userId: { type: 'string' }, name: { type: 'string' }, category: { type: 'string' }, icon: { type: 'string' }, color: { type: 'string' } }, required: ['name'] },
    handler: merchantAdd,
  },
  {
    name: 'merchant_list', description: '列出商家（按用户隔离），供下拉联动。',
    inputSchema: { type: 'object', properties: { userId: { type: 'string' } } },
    handler: merchantList,
  },
  {
    name: 'merchant_update', description: '修改商家（名称/分类/图标/颜色）。同用户下名称不可重复。userId 可选。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, userId: { type: 'string' }, name: { type: 'string' }, category: { type: 'string' }, icon: { type: 'string' }, color: { type: 'string' } }, required: ['id'] },
    handler: merchantUpdate,
  },
  {
    name: 'merchant_delete', description: '删除商家（仅当无交易引用时）。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, userId: { type: 'string' } }, required: ['id'] },
    handler: merchantDelete,
  },
  {
    name: 'project_list', description: '列出财务项目（按用户隔离），供下拉联动。',
    inputSchema: { type: 'object', properties: { userId: { type: 'string' } } },
    handler: projectList,
  },
  {
    name: 'user_list', description: '列出全部用户（多租户辅助）。',
    inputSchema: { type: 'object', properties: {} },
    handler: userList,
  },
  {
    name: 'user_create', description: '新建用户（用于 Octop 多租户隔离的 userId 维度）。',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    handler: userCreate,
  },
  {
    name: 'report_monthly', description: '某月收支汇总：总收入、总支出、净额、按分类/账户明细。参数 year/month，默认当前月。userId 可选。',
    inputSchema: { type: 'object', properties: { userId: { type: 'string' }, year: { type: 'number' }, month: { type: 'number' } } },
    handler: reportMonthly,
  },
  {
    name: 'report_by_category', description: '按分类汇总金额与笔数。type 默认 EXPENSE，可加 from/to 日期区间。userId 可选。',
    inputSchema: { type: 'object', properties: { userId: { type: 'string' }, type: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' } } },
    handler: reportByCategory,
  },
  {
    name: 'report_budget', description: '预算执行报表：按年（可再按月筛选）返回各分类的预算 / 已用 / 剩余 / 使用率；同分类同时有年预算与月预算时，月预算作为年预算的 children 返回（年/月两级）。month 传 all 表示不限月份。userId 可选。',
    inputSchema: { type: 'object', properties: { userId: { type: 'string' }, year: { type: 'number' }, month: { type: ['number', 'string'], description: '1-12 或 all' } } },
    handler: reportBudget,
  },
  {
    name: 'report_receivables', description: '应收应付汇总：按状态统计与未结清总额、明细列表。userId 可选。',
    inputSchema: { type: 'object', properties: { userId: { type: 'string' } } },
    handler: reportReceivables,
  },
  {
    name: 'report_overview', description: '多维报表：一次返回收入/支出按一级分类、以及账户/成员/商家/项目的收支聚合。支持 type/from/to/account/member/merchant/project/categoryId/q 统一筛选。转账不计入收支。',
    inputSchema: { type: 'object', properties: {
      userId: { type: 'string' }, type: { type: 'string', description: 'INCOME 或 EXPENSE；省略=全部（转账始终不计入）' },
      from: { type: 'string' }, to: { type: 'string' }, account: { type: 'string' }, member: { type: 'string' },
      merchant: { type: 'string' }, project: { type: 'string' }, categoryId: { type: 'string' }, q: { type: 'string' },
    } },
    handler: reportOverview,
  },
  {
    name: 'dashboard_build', description: '生成自包含 HTML 财务看板（内联数据 + Chart.js），返回文件路径与可访问 URL（/dashboard.html）。纯前端筛选/切换图表。userId 可选（决定快照归属）。',
    inputSchema: { type: 'object', properties: { userId: { type: 'string' } } },
    handler: (args) => buildDashboard(args),
  },
  {
    name: 'import_from_mylife', description: '从 MyLifeOS 数据库只读导入历史数据到独立库（不反向写回，避免破坏同步）。dbPath 可选。userId 决定归属用户。scope: all=全量；categories=仅导入账户(期初账户)+分类(期初分类)，用于空库初始化。',
    inputSchema: { type: 'object', properties: { dbPath: { type: 'string', description: 'MyLifeOS 的 SQLite 路径' }, userId: { type: 'string', description: '导入归属用户，默认 default' }, scope: { type: 'string', description: 'all（默认，全量）或 categories（仅期初账户+分类）' } } },
    handler: importFromMylife,
  },
  {
    name: 'category_update', description: '修改分类（名称/类型/图标/颜色/父级）。同用户下 名称+类型 不可重复。userId 可选。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, userId: { type: 'string' }, name: { type: 'string' }, type: { type: 'string' }, icon: { type: 'string' }, color: { type: 'string' }, parentId: { type: 'string' }, sortOrder: { type: 'number' } }, required: ['id'] },
    handler: categoryUpdate,
  },
  {
    name: 'category_delete', description: '删除分类（仅当该用户下无交易引用时）。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, userId: { type: 'string' } }, required: ['id'] },
    handler: categoryDelete,
  },
  {
    name: 'category_duplicates', description: '分类查重（只读）：找出完全重名、空壳（0 交易 0 子级）、同名不同父级的分类，并给出建议保留项。type 可选（INCOME/EXPENSE）。',
    inputSchema: { type: 'object', properties: { userId: { type: 'string' }, type: { type: 'string', enum: ['INCOME', 'EXPENSE'] } } },
    handler: categoryDuplicates,
  },
  {
    name: 'category_merge', description: '合并分类：把若干来源分类的交易/子级/预算迁移到目标分类并删除来源。类型必须一致，且目标不能位于来源子树内。dryRun=true 只预览。',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string' },
        targetId: { type: 'string' }, targetName: { type: 'string' },
        sourceIds: { type: 'array', items: { type: 'string' } },
        sourceNames: { type: 'array', items: { type: 'string' } },
        type: { type: 'string', enum: ['INCOME', 'EXPENSE'] },
        deleteSource: { type: 'boolean' }, dryRun: { type: 'boolean' },
      },
    },
    handler: categoryMerge,
  },
  {
    name: 'category_dedupe', description: '批量去重：自动合并「完全重名」分组（保留交易最多的一个），includeShell=true 时连空壳同名一起合并。默认 dryRun 只预览，需显式传 dryRun:false 才落库。',
    inputSchema: { type: 'object', properties: { userId: { type: 'string' }, type: { type: 'string', enum: ['INCOME', 'EXPENSE'] }, includeShell: { type: 'boolean' }, dryRun: { type: 'boolean' } } },
    handler: categoryDedupe,
  },
  {
    name: 'project_add', description: '新增财务项目。userId 可选。',
    inputSchema: { type: 'object', properties: { userId: { type: 'string' }, name: { type: 'string' }, icon: { type: 'string' }, color: { type: 'string' }, startDate: { type: 'string' }, endDate: { type: 'string' } }, required: ['name'] },
    handler: projectAdd,
  },
  {
    name: 'project_update', description: '修改财务项目。userId 可选。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, userId: { type: 'string' }, name: { type: 'string' }, icon: { type: 'string' }, color: { type: 'string' }, startDate: { type: 'string' }, endDate: { type: 'string' } }, required: ['id'] },
    handler: projectUpdate,
  },
  {
    name: 'project_delete', description: '删除财务项目（仅当无交易引用时）。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, userId: { type: 'string' } }, required: ['id'] },
    handler: projectDelete,
  },
  {
    name: 'member_update', description: '修改成员（姓名/电话/邮箱/图标/颜色/默认）。同用户下姓名不可重复。userId 可选。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, userId: { type: 'string' }, name: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' }, icon: { type: 'string' }, color: { type: 'string' }, isDefault: { type: 'boolean' } }, required: ['id'] },
    handler: memberUpdate,
  },
  {
    name: 'member_delete', description: '删除成员（仅当无交易引用时）。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, userId: { type: 'string' } }, required: ['id'] },
    handler: memberDelete,
  },
  {
    name: 'receivable_add', description: '新增应收应付。counterparty 与 amount 必填。userId 可选。',
    inputSchema: { type: 'object', properties: { userId: { type: 'string' }, counterparty: { type: 'string' }, amount: { type: 'number' }, receivedAmount: { type: 'number' }, description: { type: 'string' }, dueDate: { type: 'string' }, status: { type: 'string' }, contactName: { type: 'string' } }, required: ['counterparty', 'amount'] },
    handler: receivableAdd,
  },
  {
    name: 'receivable_update', description: '修改应收应付。userId 可选。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, userId: { type: 'string' }, counterparty: { type: 'string' }, amount: { type: 'number' }, receivedAmount: { type: 'number' }, description: { type: 'string' }, dueDate: { type: 'string' }, status: { type: 'string' }, contactName: { type: 'string' } }, required: ['id'] },
    handler: receivableUpdate,
  },
  {
    name: 'receivable_delete', description: '删除应收应付。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, userId: { type: 'string' } }, required: ['id'] },
    handler: receivableDelete,
  },
  {
    name: 'receivable_list', description: '列出全部应收应付（按用户隔离），供工作台管理。',
    inputSchema: { type: 'object', properties: { userId: { type: 'string' } } },
    handler: receivableList,
  },
  {
    name: 'budget_add', description: '新增预算。amount 必填；category 传一级分类（传二级会自动上卷到其一级）；period=YEARLY（默认，按月预算则传 MONTHLY 并给 month）。同分类同期间重复新增会更新金额。userId 可选。',
    inputSchema: { type: 'object', properties: { userId: { type: 'string' }, category: { type: 'string' }, amount: { type: 'number' }, period: { type: 'string', enum: ['YEARLY', 'MONTHLY'] }, month: { type: ['number', 'string'], description: '月预算的月份 1-12 或 YYYY-MM' }, year: { type: 'number' } }, required: ['amount'] },
    handler: budgetAdd,
  },
  {
    name: 'budget_update', description: '修改预算。userId 可选。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, userId: { type: 'string' }, category: { type: 'string' }, amount: { type: 'number' }, period: { type: 'string' }, month: { type: 'string' }, year: { type: 'number' }, startDate: { type: 'string' }, endDate: { type: 'string' } }, required: ['id'] },
    handler: budgetUpdate,
  },
  {
    name: 'budget_delete', description: '删除预算。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, userId: { type: 'string' } }, required: ['id'] },
    handler: budgetDelete,
  },
  {
    name: 'budget_list', description: '列出全部预算（按用户隔离），供工作台管理。',
    inputSchema: { type: 'object', properties: { userId: { type: 'string' } } },
    handler: budgetList,
  },
];

const map = {};
for (const t of list) map[t.name] = t;

module.exports = {
  list, map,
  txAdd, txList, txUpdate, txDelete,
  accountAdd, accountList, accountUpdate, accountDelete,
  categoryAdd, categoryList, categoryUpdate, categoryDelete,
  categoryDuplicates, categoryMerge, categoryDedupe,
  memberAdd, memberList, memberUpdate, memberDelete,
  merchantAdd, merchantList, merchantUpdate, merchantDelete,
  projectAdd, projectList, projectUpdate, projectDelete,
  receivableAdd, receivableUpdate, receivableDelete, receivableList,
  budgetAdd, budgetUpdate, budgetDelete, budgetList,
  userList, userCreate,
  reportMonthly, reportByCategory, reportBudget, reportReceivables, reportOverview,
  selectorLists, accountComputedBalance,
  importFromMylife, txRowToView, getTransaction,
};
