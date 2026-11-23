'use strict';
/*
 * 独立财务库数据层（零依赖，使用 Node 内置 node:sqlite）
 * 与 MyLifeOS 主程序解耦：本库不接入 local-first 同步引擎，
 * 只通过 import_from_mylife 工具单向、只读地从 MyLifeOS 导入历史数据。
 *
 * 多用户隔离：所有业务表带 user_id（默认 'default'）。Octop 侧由登录用户身份
 * 注入 userId（经 MCP 工具参数或工作台 x-user-id 头）；本地单用户恒为 'default'。
 */
const { DatabaseSync } = require('node:sqlite');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = process.env.MYLF_DATA_DIR || path.join(os.homedir(), '.mylife-finance');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'finance.db');

const db = new DatabaseSync(DB_PATH);
// WAL 支持 MCP 服务与工作台服务（两个进程）并发读写；busy_timeout 避免瞬时锁冲突。
db.exec('PRAGMA journal_mode=WAL');
db.exec('PRAGMA busy_timeout=5000');

function uid() { return crypto.randomUUID(); }

function hasColumn(table, col) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    return cols.some((c) => c.name === col);
  } catch (e) { return false; }
}

// ---------- 最新 schema ----------
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY, v TEXT
);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'OTHER',
  balance REAL DEFAULT 0, currency TEXT DEFAULT 'CNY',
  icon TEXT, color TEXT, archived INTEGER DEFAULT 0,
  card_no TEXT, note TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, name)
);
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL, type TEXT NOT NULL, parent_id TEXT, icon TEXT, color TEXT,
  sort_order INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, name, type, parent_id)
);
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL, phone TEXT, email TEXT, is_default INTEGER DEFAULT 0,
  icon TEXT, color TEXT, created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, name)
);
CREATE TABLE IF NOT EXISTS merchants (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL, category TEXT, icon TEXT, color TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, name)
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL, icon TEXT, color TEXT, start_date TEXT, end_date TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, name)
);
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT 'default',
  account_id TEXT, to_account_id TEXT, category_id TEXT, type TEXT NOT NULL,
  amount REAL NOT NULL, description TEXT DEFAULT '', date TEXT NOT NULL,
  tags TEXT, member_id TEXT, merchant_id TEXT, project_id TEXT,
  time TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
CREATE TABLE IF NOT EXISTS budgets (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT 'default',
  category_id TEXT, amount REAL NOT NULL, period TEXT DEFAULT 'MONTHLY',
  start_date TEXT, end_date TEXT, month TEXT, year INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS receivables (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT 'default',
  counterparty TEXT NOT NULL, amount REAL NOT NULL, received_amount REAL DEFAULT 0,
  description TEXT, due_date TEXT, status TEXT DEFAULT 'PENDING', contact_name TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

// ---------- 旧库迁移：补 user_id，并把 UNIQUE 约束纳入 user_id ----------
function migrate() {
  // 无 UNIQUE 的表：直接加列（默认 'default'）
  for (const t of ['transactions', 'budgets', 'receivables']) {
    if (!hasColumn(t, 'user_id')) {
      db.exec(`ALTER TABLE ${t} ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default'`);
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id)');
  const rebuild = (name, createSql, selectSql) => {
    if (hasColumn(name, 'user_id')) return;
    db.exec(`ALTER TABLE ${name} RENAME TO ${name}_old`);
    db.exec(createSql);
    db.exec(`INSERT OR IGNORE INTO ${name} ${selectSql} FROM ${name}_old`);
    db.exec(`DROP TABLE ${name}_old`);
  };
  rebuild('accounts',
    `CREATE TABLE accounts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT 'default', name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'OTHER', balance REAL DEFAULT 0, currency TEXT DEFAULT 'CNY', icon TEXT, color TEXT, archived INTEGER DEFAULT 0, card_no TEXT, note TEXT, created_at TEXT DEFAULT (datetime('now')), UNIQUE(user_id, name))`,
    `(id,user_id,name,type,balance,currency,icon,color,archived,created_at) SELECT id,'default',name,type,balance,currency,icon,color,archived,created_at`);
  rebuild('categories',
    `CREATE TABLE categories (id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT 'default', name TEXT NOT NULL, type TEXT NOT NULL, parent_id TEXT, icon TEXT, color TEXT, sort_order INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), UNIQUE(user_id, name, type, parent_id))`,
    `(id,user_id,name,type,parent_id,icon,color,sort_order,created_at) SELECT id,'default',name,type,parent_id,icon,color,sort_order,created_at`);
  rebuild('members',
    `CREATE TABLE members (id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT 'default', name TEXT NOT NULL, phone TEXT, email TEXT, is_default INTEGER DEFAULT 0, icon TEXT, color TEXT, created_at TEXT DEFAULT (datetime('now')), UNIQUE(user_id, name))`,
    `(id,user_id,name,phone,email,is_default,icon,color,created_at) SELECT id,'default',name,phone,email,is_default,icon,color,created_at`);
  rebuild('merchants',
    `CREATE TABLE merchants (id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT 'default', name TEXT NOT NULL, category TEXT, icon TEXT, color TEXT, created_at TEXT DEFAULT (datetime('now')), UNIQUE(user_id, name))`,
    `(id,user_id,name,category,icon,color,created_at) SELECT id,'default',name,category,icon,color,created_at`);
  rebuild('projects',
    `CREATE TABLE projects (id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT 'default', name TEXT NOT NULL, icon TEXT, color TEXT, start_date TEXT, end_date TEXT, created_at TEXT DEFAULT (datetime('now')), UNIQUE(user_id, name))`,
    `(id,user_id,name,icon,color,start_date,end_date,created_at) SELECT id,'default',name,icon,color,start_date,end_date,created_at`);
}
migrate();

// ---------- 增量列迁移 ----------
// CREATE TABLE IF NOT EXISTS 对已存在的表完全不管，新加的列必须显式 ALTER。
function addColumn(table, col, ddl) {
  if (hasColumn(table, col)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
  return true;
}
// 1.2.0：账户卡号 / 备注；交易时间（时分秒，date 仍只存日期）
addColumn('accounts', 'card_no', 'TEXT');
addColumn('accounts', 'note', 'TEXT');
addColumn('transactions', 'time', 'TEXT');
db.exec('CREATE INDEX IF NOT EXISTS idx_tx_date_user ON transactions(user_id, date)');

// 1.2.2：同一账户 + 同一收支类型下分类名唯一 —— 一个二级分类只能属于一个一级分类。
// 应用层 categoryAdd / categoryUpdate 会先拦一道并给出人话提示；这里再加数据库兜底，
// 防止将来有绕过 tools.js 的写入路径（导入、脚本、第三方直接开库）。
// 老库若已存在同名不同父级的历史数据（正是被拦的那种），唯一索引建不上；
// 此时不阻断启动，只提示用 category_duplicates → category_merge 清理，清完重启即自动补上。
(function ensureCategoryNameUnique() {
  try {
    const dup = db.prepare(
      'SELECT type, name, COUNT(*) c FROM categories GROUP BY user_id, type, name HAVING c > 1 LIMIT 1'
    ).get();
    if (dup) {
      console.warn(
        `[db] 检测到同名分类（${dup.type} / ${dup.name} ×${dup.c}），本次不建唯一索引；` +
        '请用 category_duplicates 查出、category_merge 合并后重启，索引会自动补上。'
      );
      return;
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_categories_user_type_name ON categories(user_id, type, name)');
  } catch (e) {
    console.warn('[db] 分类唯一索引创建失败：' + e.message);
  }
})();

// 本地单用户兜底：保证 'default' 用户存在
(function ensureDefaultUser() {
  const row = db.prepare("SELECT id FROM users WHERE name = 'default'").get();
  if (!row) db.prepare("INSERT INTO users (id, name) VALUES (?, 'default')").run(uid());
})();

// ---------- 日期归一化（统一存 YYYY-MM-DD，兼容历史 epoch 毫秒） ----------
function msToDay(n) {
  if (!isFinite(n)) return null;
  let ms = n;
  if (Math.abs(ms) < 1e11) ms = ms * 1000; // 秒 → 毫秒
  const d = new Date(ms);
  if (isNaN(d.getTime())) return null;
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
// 接受：Date / 秒/毫秒时间戳 / epoch 数字字符串 / ISO 字符串 → 'YYYY-MM-DD'（无法识别则原样返回）
function normalizeDate(v) {
  if (v === null || v === undefined || v === '') return v;
  if (v instanceof Date) return msToDay(v.getTime());
  if (typeof v === 'number') return msToDay(v);
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^\d{10,}(\.\d+)?$/.test(s)) return msToDay(Number(s));
  return s;
}

// 一次性迁移：把历史 epoch 毫秒文本日期转为 YYYY-MM-DD（幂等）
(function migrateDateFormats() {
  try {
    const rows = db.prepare(
      "SELECT id, date FROM transactions WHERE date IS NOT NULL AND date NOT LIKE '%-%' AND date GLOB '[0-9]*'"
    ).all();
    if (!rows.length) return;
    const upd = db.prepare('UPDATE transactions SET date = ? WHERE id = ?');
    let changed = 0;
    for (const r of rows) {
      const nd = normalizeDate(r.date);
      if (nd && nd !== r.date) { upd.run(nd, r.id); changed++; }
    }
    if (changed) console.error(`[mylife-finance] normalized ${changed} transaction dates to YYYY-MM-DD`);
  } catch (e) {
    console.error('[mylife-finance] date migrate skipped:', e.message);
  }
})();

// ---------- 内置初始分类（两级树，安装即用，无需从 MyLifeOS 导入） ----------
/*
 * 内置期初分类树：14 个支出顶级 + 4 个收入顶级，共 137 个分类。
 * 取自 MyLifeOS 实际在用的分类体系（已合并历史空壳），让新装用户直接有完整两级分类，
 * 不必再「从 MyLifeOS 导入期初分类」。
 */
const DEFAULT_CATEGORY_TREE = {
  EXPENSE: {
    '食品酒水': ['柴米油盐', '伙食费', '零食', '买菜', '三餐', '水果', '外出美食', '饮料酒水'],
    '居家生活': ['电费', '电视', '房租', '家电家具', '家居饰品', '快递费', '燃气费', '首付与房贷', '水费', '维修', '物业'],
    '交流通讯': ['宽带费用', '手机充值', '座机费'],
    '出差费用': ['交通', '聚会娱乐', '其他消费', '住宿'],
    '行车交通': ['充电费', '打车', '高铁飞机', '公交地铁', '加油费', '汽车', '汽车保险', '汽车保养', '汽车用品', '首付与车贷', '停车费', '违章罚款', '维修费', '自行车'],
    '购物消费': ['办公用品', '超市购物', '宠物支出', '厨房用品', '电子数码', '家用纺织', '美容美发', '美妆护肤', '日常用品', '洗护用品', '衣裤鞋帽', '运动器械', '珠宝首饰'],
    '教育费用': ['个人培训费', '书报杂志', '子女课外补习费', '子女学费'],
    '金融保险': ['按揭还款', '利息支出', '赔偿罚款', '人身保险', '社会保险', '投资亏损', '信用卡支出', '银行手续'],
    '人情送礼': ['白事', '红包', '婚嫁', '满月', '乔迁', '请客吃饭', '升学', '寿辰', '孝敬长辈'],
    '其他费用': ['烂账损失', '意外丢失'],
    '休闲娱乐': ['彩票', '电影', '聚会', '其他娱乐', '棋牌', '网游', '温泉洗浴', '演唱会话剧', '运动', 'K歌'],
    '医疗费用': ['护理费', '药费', '治疗费', '住院费'],
    '装修费用': ['家具家电', '装修材料', '装修其他', '装修人工', '装修装饰'],
    '其他支出': [],
  },
  INCOME: {
    '职业收入': ['报销收入', '分红收入', '工资收入', '加班收入', '兼职收入', '奖金收入'],
    '其他收入': ['创作', '个税退税', '购物退款', '礼金收入', '利息收入', '抢红包', '意外来钱', '中奖收入', '资助'],
    '经营投资': ['经营所得', '理财收入'],
    '人情收礼': ['白事收礼', '婚嫁收礼', '满月收礼', '乔迁收礼', '升学收礼', '寿辰收礼', '所收红包'],
  },
};
// 仅当该用户尚无任何分类时，写入内置初始分类；已有分类（如已导入）则跳过，不打扰。
function seedCategoriesIfEmpty(userId) {
  userId = userId || 'default';
  const cnt = db.prepare('SELECT COUNT(*) c FROM categories WHERE user_id = ?').get(userId).c;
  if (cnt > 0) return { seeded: 0 };
  let created = 0;
  for (const type of ['EXPENSE', 'INCOME']) {
    for (const parent of Object.keys(DEFAULT_CATEGORY_TREE[type])) {
      const p = ensure('categories', { name: parent, type, parent_id: null }, {}, userId);
      if (p.created) created++;
      for (const ch of DEFAULT_CATEGORY_TREE[type][parent]) {
        const c = ensure('categories', { name: ch, type, parent_id: p.id }, {}, userId);
        if (c.created) created++;
      }
    }
  }
  return { seeded: created };
}
seedCategoriesIfEmpty('default');

// WHERE 构造：值为 null 时用 IS NULL（SQLite 中 NULL = NULL 不成立），其余用 = ?
function buildWhere(match, userId) {
  const where = [];
  const vals = [];
  for (const k of Object.keys(match)) {
    if (match[k] === null || match[k] === undefined) where.push(`${k} IS NULL`);
    else { where.push(`${k} = ?`); vals.push(match[k]); }
  }
  where.push('user_id = ?'); vals.push(userId);
  return { sql: where.join(' AND '), vals };
}

// ---------- 通用存取（均按 user_id 隔离） ----------
// match: {col: val} 作为 WHERE 与创建列；extra: 额外创建列；userId: 隔离键。
function getOrCreate(table, match, extra, userId) {
  userId = userId || 'default';
  const { sql, vals } = buildWhere(match, userId);
  const row = db.prepare(`SELECT id FROM ${table} WHERE ${sql}`).get(...vals);
  if (row) return row.id;
  const id = uid();
  const cols = [...Object.keys(match), 'user_id', 'id'];
  const newVals = [...Object.values(match), userId, id];
  if (extra) {
    for (const k of Object.keys(extra)) { cols.push(k); newVals.push(extra[k]); }
  }
  const ph = cols.map(() => '?').join(',');
  db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${ph})`).run(...newVals);
  return id;
}

// 同 getOrCreate，但返回 { id, created }，便于调用方精确计数（避免跨库重复计入）。
function ensure(table, match, extra, userId) {
  userId = userId || 'default';
  const { sql, vals } = buildWhere(match, userId);
  const row = db.prepare(`SELECT id FROM ${table} WHERE ${sql}`).get(...vals);
  if (row) return { id: row.id, created: false };
  const id = uid();
  const cols = [...Object.keys(match), 'user_id', 'id'];
  const newVals = [...Object.values(match), userId, id];
  if (extra) {
    for (const k of Object.keys(extra)) { cols.push(k); newVals.push(extra[k]); }
  }
  const ph = cols.map(() => '?').join(',');
  db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${ph})`).run(...newVals);
  return { id, created: true };
}

function getName(table, id) {
  if (!id) return null;
  const row = db.prepare(`SELECT name FROM ${table} WHERE id = ?`).get(id);
  return row ? row.name : null;
}

const BUSINESS_TABLES = [
  'transactions',
  'budgets',
  'receivables',
  'accounts',
  'categories',
  'members',
  'merchants',
  'projects',
];

/**
 * 彻底清空某个租户的全部业务数据（删账号时「连数据一起删」用）。
 * 表之间没有外键约束，删序无关；整体一个事务，失败回滚。
 * @returns {object} 各表删除行数
 */
function purgeUserData(userId) {
  const id = String(userId || '');
  if (!id) throw new Error('缺少 userId');
  if (id === 'default') throw new Error("拒绝清空内置租户 'default'");
  const counts = {};
  db.exec('BEGIN');
  try {
    for (const t of BUSINESS_TABLES) {
      const r = db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(id);
      counts[t] = Number(r.changes || 0);
    }
    const ru = db.prepare('DELETE FROM users WHERE name = ?').run(id);
    counts.users = Number(ru.changes || 0);
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 回滚失败就原样抛原始错误 */
    }
    throw e;
  }
  return counts;
}

/** 该租户名下还有多少业务行（管理页删账号前提示用） */
function tenantDataCount(userId) {
  const id = String(userId || '');
  const out = {};
  let total = 0;
  for (const t of BUSINESS_TABLES) {
    try {
      const c = Number(db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE user_id = ?`).get(id).c || 0);
      out[t] = c;
      total += c;
    } catch {
      out[t] = -1;
    }
  }
  out.total = total;
  return out;
}

module.exports = {
  db,
  DATA_DIR,
  DB_PATH,
  uid,
  getOrCreate,
  ensure,
  getName,
  normalizeDate,
  seedCategoriesIfEmpty,
  purgeUserData,
  tenantDataCount,
};
