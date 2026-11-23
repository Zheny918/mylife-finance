'use strict';
/*
 * Excel / CSV 导入映射层
 *
 * 设计要点：
 *   1. 表头自动识别：同义列名（中英文）都认，识别不到的必需列会明确报错并回显实际表头
 *   2. 去重按「出现次数」而不是「是否出现过」：
 *      同一文件里同一天两笔 2.85 元公交是真实存在的两笔，
 *      所以库里已有 M 条、文件里有 N 条时只补 N-M 条。
 *      这样重复导入同一文件永远 0 新增，又不会丢掉文件内的真实重复。
 *   3. 主数据（账户/分类/成员/商家/项目）按名称复用，不重复建
 *   4. 返回 mapping（字段 → 列序号），让人能核对「系统把哪一列当成了什么」
 */

const { db, uid, ensure, normalizeDate } = require('./db');

const pad2 = (x) => String(x).padStart(2, '0');

// ---------------------------------------------------------------- 表头识别

/** 表头归一：去空白、标点、全角括号，转小写。「账 户」「账户(元)」都能对上 */
function normHeader(h) {
  return String(h === null || h === undefined ? '' : h)
    .replace(/[\s\u3000]/g, '')
    .replace(/[（）()【】\[\]{}·．.、,，:：;；'"`~!@#$%^&*_+=|\\/<>?！？《》「」]/g, '')
    .toLowerCase();
}

const ALIASES = {
  // 通用
  name: ['名称', '名字', '名称name', 'name', '标题'],
  type: ['类型', '收支类型', '收支', '方向', 'type', 'direction'],

  // 收支明细
  date: ['日期', '交易日期', '记账日期', '发生日期', '时间', '交易时间', 'date', 'transactiondate', 'time'],
  amount: ['金额', '交易金额', '金额元', 'money', 'amount', '数额'],
  expense: ['支出', '支出金额', '支出元', 'expense', 'debit'],
  income: ['收入', '收入金额', '收入元', 'income', 'credit'],
  category: ['分类', '类别', '分类名称', '分类名', 'category', 'categoryname'],
  parentCategory: ['父分类', '上级分类', '一级分类', '大类', 'parent', 'parentcategory'],
  subCategory: ['二级分类', '子分类', '小类', 'subcategory'],
  account: ['账户', '账户名称', '支付账户', '付款账户', '卡号', 'account', 'accountname'],
  toAccount: ['转入账户', '对方账户', '收款账户', 'toaccount'],
  description: ['说明', '备注', '摘要', '描述', '交易说明', '事由', 'description', 'remark', 'note', 'memo'],
  member: ['成员', '人员', '家庭成员', '使用者', 'member'],
  merchant: ['商家', '商户', '店铺', 'merchant', 'shop', 'store'],
  project: ['项目', '所属项目', 'project'],
  tags: ['标签', 'tag', 'tags'],

  // 账户
  balance: ['余额', '当前余额', '期初余额', 'balance'],
  currency: ['币种', '货币', 'currency'],

  // 人员
  phone: ['电话', '手机', '手机号', '联系电话', 'phone', 'mobile'],
  email: ['邮箱', '邮件', 'email', 'mail'],

  // 项目
  startDate: ['开始日期', '起始日期', 'startdate', 'start'],
  endDate: ['结束日期', '截止日期', 'enddate', 'end'],

  // 通用修饰
  icon: ['图标', 'icon'],
  color: ['颜色', 'color'],
  sortOrder: ['排序', '顺序', 'sortorder', 'sort'],
};

/** 别名 → 字段 的反查表 */
const ALIAS_LOOKUP = (() => {
  const m = new Map();
  for (const [field, list] of Object.entries(ALIASES)) {
    for (const a of list) {
      const k = normHeader(a);
      if (k && !m.has(k)) m.set(k, field);
    }
  }
  return m;
})();

/**
 * 在前若干行里找表头行：取匹配到可识别列名最多的那一行。
 * 应对「第一行是大标题、第二行才是列头」以及顶部空行的常见情况。
 */
function findHeaderRow(rows, fields) {
  const allowed = fields ? new Set(fields) : null;
  let best = { index: -1, score: 0 };
  const limit = Math.min(rows.length, 12);
  for (let i = 0; i < limit; i++) {
    const row = rows[i] || [];
    let score = 0;
    for (const c of row) {
      const f = ALIAS_LOOKUP.get(normHeader(c));
      if (f && (!allowed || allowed.has(f))) score++;
    }
    if (score > best.score) best = { index: i, score };
  }
  return best;
}

/** 表头行 → { 字段: 列序号 } */
function buildColumnMap(headerRow, fields) {
  const map = {};
  headerRow.forEach((h, i) => {
    const f = ALIAS_LOOKUP.get(normHeader(h));
    if (!f) return;
    if (fields && !fields.includes(f)) return;
    if (map[f] === undefined) map[f] = i;
  });
  return map;
}

// ---------------------------------------------------------------- 取值工具

function cellText(row, idx) {
  if (idx === undefined || idx === null || idx < 0) return '';
  const v = row[idx];
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

/** 金额解析：容忍千分位、货币符号、全角括号负数（（88）表示 -88） */
function cellNumber(row, idx) {
  let t = cellText(row, idx);
  if (!t) return null;
  let negative = false;
  if (/^[（(].*[）)]$/.test(t)) { negative = true; t = t.slice(1, -1); }
  t = t.replace(/[\s,，¥$€£元圆]/g, '');
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return negative ? -Math.abs(n) : n;
}

function money(n) {
  return Math.round(n * 100) / 100;
}

/** 年月日是否真实存在（排除 2026-13-45、2026-02-30 这类越界值） */
function isRealDate(y, m, d) {
  const yy = Number(y);
  const mm = Number(m);
  const dd = Number(d);
  if (!Number.isInteger(yy) || !Number.isInteger(mm) || !Number.isInteger(dd)) return false;
  if (yy < 1900 || yy > 2200) return false;
  if (mm < 1 || mm > 12) return false;
  if (dd < 1 || dd > 31) return false;
  const dt = new Date(Date.UTC(yy, mm - 1, dd));
  return dt.getUTCFullYear() === yy && dt.getUTCMonth() === mm - 1 && dt.getUTCDate() === dd;
}

/**
 * 日期解析。不直接用 normalizeDate，因为它对 2026/11/01、2026年11月1日 这类
 * 常见写法会原样返回，导致脏数据入库。识别不了就返回 null，让调用方记错误。
 *
 * 歧义说明：03/04/2026 这种两位都对调的写法按「月/日/年」解释（Excel 默认美式）；
 * 若其中一个数大于 12，则按较大的那个是「日」来判断，因此 25/12/2026 能正确识别为 12 月 25 日。
 */
function parseDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') {
    const d = normalizeDate(v);
    return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
  }
  const s = String(v).trim();
  if (!s) return null;

  let m = /^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/.exec(s);
  if (m) return isRealDate(m[1], m[2], m[3]) ? `${m[1]}-${pad2(m[2])}-${pad2(m[3])}` : null;

  m = /^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*月?$/.exec(s);
  if (m) return isRealDate(m[1], m[2], 1) ? `${m[1]}-${pad2(m[2])}-01` : null;

  m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(s);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const month = a > 12 ? b : a;
    const day = a > 12 ? a : b;
    return isRealDate(m[3], month, day) ? `${m[3]}-${pad2(month)}-${pad2(day)}` : null;
  }

  if (/^\d{10,13}$/.test(s)) {
    const d = normalizeDate(Number(s));
    return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
  }
  return null;
}

const TX_TYPE_MAP = {
  支出: 'EXPENSE', expense: 'EXPENSE', out: 'EXPENSE', 付款: 'EXPENSE', 消费: 'EXPENSE', debit: 'EXPENSE',
  收入: 'INCOME', income: 'INCOME', in: 'INCOME', 收款: 'INCOME', credit: 'INCOME',
  转账: 'TRANSFER', transfer: 'TRANSFER', 内部转账: 'TRANSFER',
};

function normalizeTxType(v) {
  const t = String(v === null || v === undefined ? '' : v)
    .trim().toLowerCase()
    .replace(/[（(].*?[）)]/g, '')
    .replace(/\s/g, '');
  if (!t) return null;
  return TX_TYPE_MAP[t] || null;
}

const ACCOUNT_TYPE_MAP = {
  储蓄卡: 'DEBIT_CARD', 借记卡: 'DEBIT_CARD', 银行卡: 'DEBIT_CARD', 银行账户: 'DEBIT_CARD', debit: 'DEBIT_CARD', debitcard: 'DEBIT_CARD',
  信用卡: 'CREDIT_CARD', credit: 'CREDIT_CARD', creditcard: 'CREDIT_CARD',
  投资: 'INVESTMENT', 理财: 'INVESTMENT', 基金: 'INVESTMENT', 股票: 'INVESTMENT', investment: 'INVESTMENT',
  现金: 'CASH', cash: 'CASH',
  电子钱包: 'E_WALLET', 钱包: 'E_WALLET', 支付宝: 'E_WALLET', 微信: 'E_WALLET', 微信支付: 'E_WALLET', ewallett: 'E_WALLET', ewallet: 'E_WALLET',
  其他: 'OTHER', other: 'OTHER',
};

function normalizeAccountType(v) {
  const t = String(v === null || v === undefined ? '' : v).trim().toLowerCase().replace(/\s/g, '');
  if (!t) return 'OTHER';
  if (ACCOUNT_TYPE_MAP[t]) return ACCOUNT_TYPE_MAP[t];
  const up = t.toUpperCase();
  if (['DEBIT_CARD', 'CREDIT_CARD', 'INVESTMENT', 'CASH', 'E_WALLET', 'OTHER'].includes(up)) return up;
  return 'OTHER';
}

/** 分类路径拆分：支持「食品酒水/三餐」「食品酒水>三餐」「食品酒水 · 三餐」 */
function splitCategoryPath(s) {
  const t = String(s === null || s === undefined ? '' : s).trim();
  if (!t) return { parent: '', child: '' };
  const parts = t.split(/[\/>＞\\|｜·›»]/).map((x) => x.trim()).filter(Boolean);
  if (parts.length >= 2) return { parent: parts[0], child: parts.slice(1).join('/') };
  return { parent: '', child: parts[0] || '' };
}

// ---------------------------------------------------------------- 主数据落库

function ensureAccount(name, userId, type) {
  if (!name) return null;
  return ensure('accounts', { name }, { type: type || 'OTHER', balance: 0, currency: 'CNY' }, userId).id;
}

/**
 * 确保分类存在；有父名则建两级。
 * 返回 { id, created }，created 是本次真正新建的节点数（父+子最多 2），
 * 这样统计不会被「一次建两个节点只记 1」低估。
 *
 * 分类名在同一账户 + 同一收支类型下唯一（一个二级分类只能属于一个一级分类），
 * 所以只要同名已存在就复用，不管它在哪个父级下：内置树里有「食品酒水 / 三餐」，
 * 表里只写「三餐」时要挂到它下面，而不是新建一个顶级「三餐」；
 * 写了「居家生活 / 三餐」也不再另建 —— 否则用一阵子就攒一堆同名分类，
 * 按名字记账和筛分类都会分不清。
 */
function ensureCategoryPath(parentName, childName, type, userId) {
  // 分类名在同一账户 + 同一收支类型下唯一（一个二级分类只能属于一个一级分类）。
  // 所以只要同名已存在就复用，不管它在哪个父级下 —— 否则导入历史表格时
  // 会不断造出「同名不同父级」，既违背规则，也会撞上 categories 的唯一索引。
  if (childName) {
    const found = db.prepare(
      'SELECT id FROM categories WHERE user_id=? AND name=? AND type=? ORDER BY (parent_id IS NULL) LIMIT 1'
    ).get(userId, childName, type);
    if (found) return { id: found.id, created: 0 };
  }

  let parentId = null;
  let created = 0;
  if (parentName) {
    const r = ensure('categories', { name: parentName, type, parent_id: null }, {}, userId);
    parentId = r.id;
    if (r.created) created++;
  }
  if (childName) {
    const r = ensure('categories', { name: childName, type, parent_id: parentId }, {}, userId);
    if (r.created) created++;
    return { id: r.id, created };
  }
  return { id: parentId, created };
}

// ---------------------------------------------------------------- 各实体导入

/** 统计容器 */
function newStats(entity, mapping, headers) {
  return {
    ok: true,
    entity,
    headers: headers || [],
    mapping: mapping || {},
    total: 0,
    created: 0,
    skipped: 0,
    failed: 0,
    errors: [],
    warnings: [],
  };
}

function pushError(stats, rowNo, message) {
  stats.failed++;
  if (stats.errors.length < 20) stats.errors.push({ row: rowNo, message });
}

/** 收支明细 */
function importTransactions(rows, opts) {
  const userId = opts.userId || 'default';
  const requiredFields = ['date', 'amount', 'expense', 'income'];
  const head = findHeaderRow(rows, Object.keys(ALIASES));
  if (head.index < 0 || head.score < 2) {
    throw new Error('没认出表头。第一行应包含「日期」「金额」这类列名，实际读到的前几行是：'
      + JSON.stringify(rows.slice(0, 3)));
  }
  const map = buildColumnMap(rows[head.index], Object.keys(ALIASES));
  const stats = newStats('transactions', map, rows[head.index]);

  const hasDate = map.date !== undefined;
  const hasSingleAmount = map.amount !== undefined;
  const hasSplit = map.expense !== undefined || map.income !== undefined;
  if (!hasDate || (!hasSingleAmount && !hasSplit)) {
    const missing = [];
    if (!hasDate) missing.push('日期');
    if (!hasSingleAmount && !hasSplit) missing.push('金额（或「支出」「收入」两列）');
    throw new Error('缺少必需列：' + missing.join('、')
      + '。实际表头：' + JSON.stringify(rows[head.index].map((x) => String(x === null ? '' : x))));
  }
  if (!hasSplit && map.type === undefined) {
    stats.warnings.push('没有「类型」列：金额为正时按支出处理，负数按支出取绝对值。要区分收入请在表里加「类型」列');
  }

  // 预取库里已有四元组的出现次数，用于「限量补入」
  // 金额换算成「分」再拼 key，避免 88.5 与 88.50 的字符串差异；description 统一 COALESCE
  const existing = new Map();
  for (const r of db.prepare(
    "SELECT date, amount, COALESCE(description,'') d, account_id, COUNT(*) c FROM transactions WHERE user_id=? GROUP BY date, amount, COALESCE(description,''), account_id"
  ).all(userId)) {
    existing.set(`${r.date}|${Math.round(r.amount * 100)}|${r.d}|${r.account_id}`, r.c);
  }
  const seen = new Map();

  const insert = db.prepare(
    'INSERT INTO transactions (id,user_id,account_id,to_account_id,category_id,type,amount,description,date,tags,member_id,merchant_id,project_id)'
    + ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
  );

  for (let i = head.index + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    if (row.every((c) => c === null || c === undefined || String(c).trim() === '')) continue; // 空行
    stats.total++;
    const rowNo = i + 1; // Excel 行号（1 基）

    const date = parseDate(cellText(row, map.date));
    if (!date) { pushError(stats, rowNo, '日期无法识别：' + JSON.stringify(cellText(row, map.date))); continue; }

    let amount = null;
    let type = null;
    if (hasSplit) {
      const exp = cellNumber(row, map.expense);
      const inc = cellNumber(row, map.income);
      if (inc) { amount = Math.abs(inc); type = 'INCOME'; }
      else if (exp) { amount = Math.abs(exp); type = 'EXPENSE'; }
    } else {
      const raw = cellNumber(row, map.amount);
      if (raw === null) { pushError(stats, rowNo, '金额无法识别：' + JSON.stringify(cellText(row, map.amount))); continue; }
      const declared = normalizeTxType(cellText(row, map.type));
      if (declared) { type = declared; amount = Math.abs(raw); }
      else { type = 'EXPENSE'; amount = Math.abs(raw); }
    }
    if (amount === null || !(amount >= 0)) { pushError(stats, rowNo, '金额为空或为 0'); continue; }
    amount = money(amount);

    // 账户 / 分类
    const accountName = cellText(row, map.account) || '默认账户';
    const accountId = ensureAccount(accountName, userId);

    let categoryId = null;
    const parentName = cellText(row, map.parentCategory);
    const subName = cellText(row, map.subCategory);
    const flatCat = cellText(row, map.category);
    if (parentName || subName) {
      categoryId = ensureCategoryPath(parentName, subName, type, userId).id;
    } else if (flatCat) {
      const split = splitCategoryPath(flatCat);
      categoryId = ensureCategoryPath(split.parent, split.child, type, userId).id;
    }

    const description = cellText(row, map.description);
    const memberName = cellText(row, map.member);
    const merchantName = cellText(row, map.merchant);
    const projectName = cellText(row, map.project);
    const memberId = memberName ? ensure('members', { name: memberName }, {}, userId).id : null;
    const merchantId = merchantName ? ensure('merchants', { name: merchantName }, {}, userId).id : null;
    const projectId = projectName ? ensure('projects', { name: projectName }, {}, userId).id : null;

    let toAccountId = null;
    const toName = cellText(row, map.toAccount);
    if (toName) { toAccountId = ensureAccount(toName, userId); type = 'TRANSFER'; }

    const tags = cellText(row, map.tags) || null;

    // 限量补入：库里已有 M 条、本文件第 (M+1) 次遇到同一四元组才真正插入
    const key = `${date}|${Math.round(amount * 100)}|${description}|${accountId}`;
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    if (n <= (existing.get(key) || 0)) { stats.skipped++; continue; }

    insert.run(uid(), userId, accountId, toAccountId, categoryId, type, amount, description, date, tags, memberId, merchantId, projectId);
    stats.created++;
  }

  return stats;
}

/** 分类（支持两级） */
function importCategories(rows, opts) {
  const userId = opts.userId || 'default';
  const head = findHeaderRow(rows, Object.keys(ALIASES));
  if (head.index < 0 || head.score < 1) throw new Error('没认出表头，需要「名称」列。实际前几行：' + JSON.stringify(rows.slice(0, 3)));
  const map = buildColumnMap(rows[head.index], Object.keys(ALIASES));
  const stats = newStats('categories', map, rows[head.index]);

  if (map.name === undefined && map.category === undefined) {
    throw new Error('缺少「名称」列。实际表头：' + JSON.stringify(rows[head.index].map((x) => String(x === null ? '' : x))));
  }
  const nameCol = map.name !== undefined ? map.name : map.category;
  if (map.type === undefined) stats.warnings.push('没有「类型」列，全部按「支出」分类导入');

  for (let i = head.index + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    if (row.every((c) => c === null || c === undefined || String(c).trim() === '')) continue;
    stats.total++;
    const rowNo = i + 1;

    const rawName = cellText(row, nameCol);
    if (!rawName) { pushError(stats, rowNo, '名称为空'); continue; }
    const typeText = cellText(row, map.type);
    const type = typeText ? (normalizeTxType(typeText) === 'INCOME' ? 'INCOME' : 'EXPENSE') : 'EXPENSE';

    let parentName = cellText(row, map.parentCategory);
    let childName = rawName;
    if (!parentName) {
      const split = splitCategoryPath(rawName);
      parentName = split.parent;
      childName = split.child;
    }

    const r = ensureCategoryPath(parentName, childName, type, userId);
    if (r.created) { stats.created += r.created; } else { stats.skipped++; }
  }
  return stats;
}

/** 项目 */
function importProjects(rows, opts) {
  const userId = opts.userId || 'default';
  const head = findHeaderRow(rows, Object.keys(ALIASES));
  if (head.index < 0 || head.score < 1) throw new Error('没认出表头，需要「名称」列。实际前几行：' + JSON.stringify(rows.slice(0, 3)));
  const map = buildColumnMap(rows[head.index], Object.keys(ALIASES));
  const stats = newStats('projects', map, rows[head.index]);
  const nameCol = map.name !== undefined ? map.name : map.project;
  if (nameCol === undefined) throw new Error('缺少「名称」列。实际表头：' + JSON.stringify(rows[head.index].map((x) => String(x === null ? '' : x))));

  for (let i = head.index + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    if (row.every((c) => c === null || c === undefined || String(c).trim() === '')) continue;
    stats.total++;
    const rowNo = i + 1;
    const name = cellText(row, nameCol);
    if (!name) { pushError(stats, rowNo, '名称为空'); continue; }

    const extra = {};
    const icon = cellText(row, map.icon);
    const color = cellText(row, map.color);
    const start = parseDate(cellText(row, map.startDate));
    const end = parseDate(cellText(row, map.endDate));
    if (icon) extra.icon = icon;
    if (color) extra.color = color;
    if (start) extra.start_date = start;
    if (end) extra.end_date = end;

    const r = ensure('projects', { name }, extra, userId);
    if (r.created) stats.created++; else stats.skipped++;
  }
  return stats;
}

/** 人员 */
function importMembers(rows, opts) {
  const userId = opts.userId || 'default';
  const head = findHeaderRow(rows, Object.keys(ALIASES));
  if (head.index < 0 || head.score < 1) throw new Error('没认出表头，需要「名称」列。实际前几行：' + JSON.stringify(rows.slice(0, 3)));
  const map = buildColumnMap(rows[head.index], Object.keys(ALIASES));
  const stats = newStats('members', map, rows[head.index]);
  const nameCol = map.name !== undefined ? map.name : map.member;
  if (nameCol === undefined) throw new Error('缺少「名称」列。实际表头：' + JSON.stringify(rows[head.index].map((x) => String(x === null ? '' : x))));

  for (let i = head.index + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    if (row.every((c) => c === null || c === undefined || String(c).trim() === '')) continue;
    stats.total++;
    const rowNo = i + 1;
    const name = cellText(row, nameCol);
    if (!name) { pushError(stats, rowNo, '名称为空'); continue; }

    const extra = {};
    const phone = cellText(row, map.phone);
    const email = cellText(row, map.email);
    const icon = cellText(row, map.icon);
    const color = cellText(row, map.color);
    if (phone) extra.phone = phone;
    if (email) extra.email = email;
    if (icon) extra.icon = icon;
    if (color) extra.color = color;

    const r = ensure('members', { name }, extra, userId);
    if (r.created) stats.created++; else stats.skipped++;
  }
  return stats;
}

/** 商家 */
function importMerchants(rows, opts) {
  const userId = opts.userId || 'default';
  const head = findHeaderRow(rows, Object.keys(ALIASES));
  if (head.index < 0 || head.score < 1) throw new Error('没认出表头，需要「名称」列。实际前几行：' + JSON.stringify(rows.slice(0, 3)));
  const map = buildColumnMap(rows[head.index], Object.keys(ALIASES));
  const stats = newStats('merchants', map, rows[head.index]);
  const nameCol = map.name !== undefined ? map.name : map.merchant;
  if (nameCol === undefined) throw new Error('缺少「名称」列。实际表头：' + JSON.stringify(rows[head.index].map((x) => String(x === null ? '' : x))));

  for (let i = head.index + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    if (row.every((c) => c === null || c === undefined || String(c).trim() === '')) continue;
    stats.total++;
    const rowNo = i + 1;
    const name = cellText(row, nameCol);
    if (!name) { pushError(stats, rowNo, '名称为空'); continue; }

    const extra = {};
    const cat = cellText(row, map.category);
    const icon = cellText(row, map.icon);
    const color = cellText(row, map.color);
    if (cat) extra.category = cat;
    if (icon) extra.icon = icon;
    if (color) extra.color = color;

    const r = ensure('merchants', { name }, extra, userId);
    if (r.created) stats.created++; else stats.skipped++;
  }
  return stats;
}

/** 账户 */
function importAccounts(rows, opts) {
  const userId = opts.userId || 'default';
  const head = findHeaderRow(rows, Object.keys(ALIASES));
  if (head.index < 0 || head.score < 1) throw new Error('没认出表头，需要「名称」列。实际前几行：' + JSON.stringify(rows.slice(0, 3)));
  const map = buildColumnMap(rows[head.index], Object.keys(ALIASES));
  const stats = newStats('accounts', map, rows[head.index]);
  const nameCol = map.name !== undefined ? map.name : map.account;
  if (nameCol === undefined) throw new Error('缺少「名称」列。实际表头：' + JSON.stringify(rows[head.index].map((x) => String(x === null ? '' : x))));

  for (let i = head.index + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    if (row.every((c) => c === null || c === undefined || String(c).trim() === '')) continue;
    stats.total++;
    const rowNo = i + 1;
    const name = cellText(row, nameCol);
    if (!name) { pushError(stats, rowNo, '名称为空'); continue; }

    const extra = {
      type: normalizeAccountType(cellText(row, map.type)),
      balance: cellNumber(row, map.balance) || 0,
      currency: cellText(row, map.currency) || 'CNY',
    };
    const icon = cellText(row, map.icon);
    const color = cellText(row, map.color);
    if (icon) extra.icon = icon;
    if (color) extra.color = color;

    const r = ensure('accounts', { name }, extra, userId);
    if (r.created) stats.created++; else stats.skipped++;
  }
  return stats;
}

// ---------------------------------------------------------------- 出口

const IMPORTERS = {
  transactions: importTransactions,
  categories: importCategories,
  projects: importProjects,
  members: importMembers,
  merchants: importMerchants,
  accounts: importAccounts,
};

const ENTITY_LABELS = {
  transactions: '收支明细',
  categories: '分类',
  projects: '项目',
  members: '人员',
  merchants: '商家',
  accounts: '账户',
};

/**
 * 统一入口
 * @param {string} entity transactions|categories|projects|members|merchants|accounts
 * @param {Array<Array>} rows xlsx-reader 读出的二维数组
 * @param {{userId?:string, dryRun?:boolean}} opts
 */
function importRows(entity, rows, opts) {
  const fn = IMPORTERS[entity];
  if (!fn) throw new Error('不支持的导入类型：' + entity + '（可选：' + Object.keys(IMPORTERS).join(' / ') + '）');
  if (!Array.isArray(rows) || !rows.length) throw new Error('表格是空的，没有可导入的行');
  return fn(rows, opts || {});
}

module.exports = {
  importRows,
  IMPORTERS,
  ENTITY_LABELS,
  // 供测试与前端模板下载复用
  normHeader,
  parseDate,
  splitCategoryPath,
  normalizeAccountType,
  findHeaderRow,
  buildColumnMap,
  ALIASES,
};
