#!/usr/bin/env node
/*
 * 导入映射层测试
 *
 * 必须用临时数据目录运行，避免碰到真实账本：
 *   MYLF_DATA_DIR=C:/zzytest/_imptest node scripts/test-importers.mjs
 *
 * 覆盖：日期多格式、千分位、全角括号负数、分类路径拆分、
 *       重复导入幂等、文件内真实重复保留、账户类型中文映射、缺列报错
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { makeXlsx } from './lib/xlsx-writer.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { readTable } = require('../src/xlsx-reader.js');
const { importRows } = require('../src/importers.js');
const { db, DATA_DIR } = require('../src/db.js');

// 安全阀：绝不能在真实库上跑
if (!process.env.MYLF_DATA_DIR) {
  console.error('拒绝运行：请设置 MYLF_DATA_DIR 指向临时目录，例如');
  console.error('  MYLF_DATA_DIR=C:/zzytest/_imptest node scripts/test-importers.mjs');
  process.exit(1);
}
const REAL_DB = path.join(process.env.USERPROFILE || '', '.mylife-finance', 'finance.db');
if (path.resolve(DATA_DIR).toLowerCase().includes('mylife-finance')) {
  console.error('拒绝运行：DATA_DIR 指向了真实数据目录 ' + DATA_DIR);
  process.exit(1);
}

const UID = 't1';
let pass = 0;
let fail = 0;

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

function count(table, where = '', ...params) {
  const sql = `SELECT COUNT(*) c FROM ${table} WHERE user_id=?${where ? ' AND ' + where : ''}`;
  return db.prepare(sql).get(UID, ...params).c;
}

function findRow(table, name) {
  return db.prepare(`SELECT * FROM ${table} WHERE user_id=? AND name=?`).get(UID, name);
}

function section(title) {
  console.log('\n== ' + title + ' ==');
}

function main() {
  console.log('临时数据目录: ' + DATA_DIR);
  console.log('库文件: ' + path.relative(ROOT, path.join(DATA_DIR, 'finance.db')));

  // ---------------------------------------------------------------- 收支明细
  section('收支明细：xlsx 全链路（含日期多格式 / 千分位 / 全角括号负数 / 分类路径）');
  const txRows = [
    ['日期', '类型', '金额', '分类', '账户', '说明', '成员', '商家', '项目', '标签'],
    ['2026-11-01', '支出', '88.50', '食品酒水/三餐', '招行', '午餐', '张三', '全家', '日常', '#餐'],
    ['2026/11/02', '收入', '1200', '工资薪酬/工资', '招行', '11月工资', '张三', null, null, null],
    ['2026年11月3日', '支出', '1,200.5', '交通/打车', '招行', '打车', null, null, null, null],
    ['2026-11-04', '支出', '（50）', '食品酒水/三餐', '招行', '全角括号负数', null, null, null, null],
  ];
  const txXlsx = makeXlsx(txRows, { sheetName: '收支明细' });
  fs.mkdirSync(path.join(ROOT, 'fixtures'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'fixtures', 'transactions.xlsx'), txXlsx);

  const txParsed = readTable(txXlsx);
  const r1 = importRows('transactions', txParsed, { userId: UID });
  console.log('  结果: ' + JSON.stringify({ total: r1.total, created: r1.created, skipped: r1.skipped, failed: r1.failed }));
  ok('4 行全部导入', r1.created === 4, r1.created);
  ok('无失败行', r1.failed === 0, r1.errors);
  ok('库内交易数 = 4', count('transactions') === 4, count('transactions'));

  const t1 = db.prepare("SELECT * FROM transactions WHERE user_id=? AND description='午餐'").get(UID);
  ok('金额 88.5 正确', t1 && t1.amount === 88.5, t1 && t1.amount);
  ok('日期归一为 2026-11-01', t1 && t1.date === '2026-11-01', t1 && t1.date);
  ok('类型 EXPENSE', t1 && t1.type === 'EXPENSE', t1 && t1.type);

  const t2 = db.prepare("SELECT * FROM transactions WHERE user_id=? AND description='11月工资'").get(UID);
  ok('斜杠日期 2026/11/02 归一', t2 && t2.date === '2026-11-02', t2 && t2.date);
  ok('收入类型 INCOME', t2 && t2.type === 'INCOME', t2 && t2.type);

  const t3 = db.prepare("SELECT * FROM transactions WHERE user_id=? AND description='打车'").get(UID);
  ok('中文日期 2026年11月3日 归一', t3 && t3.date === '2026-11-03', t3 && t3.date);
  ok('千分位 1,200.5 解析正确', t3 && t3.amount === 1200.5, t3 && t3.amount);

  const t4 = db.prepare("SELECT * FROM transactions WHERE user_id=? AND description='全角括号负数'").get(UID);
  ok('全角括号（50）取绝对值 50', t4 && t4.amount === 50, t4 && t4.amount);

  // 分类路径拆分：食品酒水/三餐 → 两级
  const parent = db.prepare("SELECT * FROM categories WHERE user_id=? AND name='食品酒水'").get(UID);
  const child = db.prepare("SELECT * FROM categories WHERE user_id=? AND name='三餐'").get(UID);
  ok('斜杠分类自动建父级「食品酒水」', !!parent);
  ok('子分类「三餐」挂在父级下', child && parent && child.parent_id === parent.id, child && child.parent_id);

  // 主数据联动
  ok('账户「招行」已建', !!findRow('accounts', '招行'));
  const member = findRow('members', '张三');
  ok('成员「张三」已建', !!member);
  ok('商家「全家」已建', !!findRow('merchants', '全家'));
  ok('项目「日常」已建', !!findRow('projects', '日常'));
  ok('交易带上了成员外键', t1 && member && t1.member_id === member.id);

  // ---------------------------------------------------------------- 幂等
  section('重复导入同一文件：应 0 新增');
  const r2 = importRows('transactions', txParsed, { userId: UID });
  console.log('  结果: ' + JSON.stringify({ created: r2.created, skipped: r2.skipped }));
  ok('新增 0', r2.created === 0, r2.created);
  ok('跳过 4', r2.skipped === 4, r2.skipped);
  ok('库内仍是 4 笔', count('transactions') === 4, count('transactions'));

  section('文件内出现两条完全相同的交易：应保留 2 笔');
  const dupRows = [
    ['日期', '金额', '账户', '说明'],
    ['2026-11-09', '2.85', '公交卡', '公交地铁'],
    ['2026-11-09', '2.85', '公交卡', '公交地铁'],
  ];
  const r3 = importRows('transactions', dupRows, { userId: UID });
  ok('首次导入 2 笔都保留', r3.created === 2, r3.created);
  const r3b = importRows('transactions', dupRows, { userId: UID });
  ok('再次导入 0 新增', r3b.created === 0, r3b.created);
  ok('再次导入跳过 2', r3b.skipped === 2, r3b.skipped);

  section('表头不在第一行（首行是大标题）也能认出来');
  const titleRows = [
    ['我的账本导出'],
    ['日期', '金额', '账户', '说明'],
    ['2026-11-05', '10', '招行', '带标题行'],
  ];
  const r4 = importRows('transactions', titleRows, { userId: UID });
  ok('识别到第 2 行为表头并导入 1 笔', r4.created === 1, r4.created);

  section('只有「支出/收入」两列、没有单一金额列');
  const splitRows = [
    ['日期', '支出', '收入', '账户', '说明'],
    ['2026-11-06', '30', null, '招行', '双列支出'],
    ['2026-11-06', null, '500', '招行', '双列收入'],
  ];
  const r5 = importRows('transactions', splitRows, { userId: UID });
  ok('双列导入 2 笔', r5.created === 2, r5.created);
  const inc = db.prepare("SELECT type FROM transactions WHERE user_id=? AND description='双列收入'").get(UID);
  ok('收入列识别为 INCOME', inc && inc.type === 'INCOME', inc && inc.type);

  section('无类型列且金额为正：按支出处理并给出警告');
  const inferRows = [
    ['日期', '金额', '账户', '说明'],
    ['2026-11-07', '66', '招行', '无类型列'],
  ];
  const r6 = importRows('transactions', inferRows, { userId: UID });
  ok('导入 1 笔', r6.created === 1, r6.created);
  ok('返回了警告', r6.warnings.length > 0, r6.warnings);
  const inf = db.prepare("SELECT type FROM transactions WHERE user_id=? AND description='无类型列'").get(UID);
  ok('类型推断为 EXPENSE', inf && inf.type === 'EXPENSE', inf && inf.type);

  section('非法日期应计入失败而不是静默写脏数据');
  const badRows = [
    ['日期', '金额', '账户', '说明'],
    ['不是日期', '10', '招行', '坏行'],
    ['2026-13-45', '10', '招行', '越界日期'],
  ];
  const r7 = importRows('transactions', badRows, { userId: UID });
  ok('2 行都失败', r7.failed === 2, r7.failed);
  ok('失败明细带行号', r7.errors.length === 2 && r7.errors[0].row === 2, r7.errors);

  section('只写二级分类名时复用已有分类，不新建顶级');
  const catCountBefore = db.prepare('SELECT COUNT(*) c FROM categories WHERE user_id=?').get(UID).c;
  const r8 = importRows('transactions', [
    ['日期', '金额', '账户', '分类', '说明'],
    ['2026-11-11', '20', '招行', '三餐', '只写二级名'],
  ], { userId: UID });
  ok('导入 1 笔', r8.created === 1, r8.created);
  const catCountAfter = db.prepare('SELECT COUNT(*) c FROM categories WHERE user_id=?').get(UID).c;
  ok('分类总数没变（没有新建顶级「三餐」）', catCountAfter === catCountBefore, { before: catCountBefore, after: catCountAfter });
  const reuse = db.prepare(
    "SELECT c.name, p.name pname FROM categories c LEFT JOIN categories p ON p.id=c.parent_id WHERE c.id=(SELECT category_id FROM transactions WHERE user_id=? AND description='只写二级名')"
  ).get(UID);
  ok('仍挂在「食品酒水」下', reuse && reuse.pname === '食品酒水', reuse);

  section('缺必需列应明确报错并回显实际表头');
  let errMsg = '';
  try {
    importRows('transactions', [['说明', '金额'], ['午餐', '88']], { userId: UID });
  } catch (e) { errMsg = e.message; }
  ok('抛出缺列错误', /缺少必需列/.test(errMsg), errMsg);
  ok('错误里点名「日期」', /日期/.test(errMsg), errMsg);
  ok('错误里回显实际表头', /说明/.test(errMsg), errMsg);

  // ---------------------------------------------------------------- 分类
  section('分类导入（两级 + 收入/支出分开）');
  const catRows = [
    ['名称', '类型', '父分类'],
    ['测试子分类A', '支出', '测试父分类X'],
    ['测试独立分类', '收入', ''],
    ['测试子分类B', '支出', '测试父分类X'],
  ];
  const c1 = importRows('categories', catRows, { userId: UID });
  console.log('  结果: ' + JSON.stringify({ created: c1.created, skipped: c1.skipped }));
  ok('新建 4 个节点（父X + 子A + 独立 + 子B）', c1.created === 4, c1.created);
  const cParent = db.prepare("SELECT * FROM categories WHERE user_id=? AND name='测试父分类X'").get(UID);
  const cChildA = db.prepare("SELECT * FROM categories WHERE user_id=? AND name='测试子分类A'").get(UID);
  const cIndep = db.prepare("SELECT * FROM categories WHERE user_id=? AND name='测试独立分类'").get(UID);
  ok('父分类类型为 EXPENSE', cParent && cParent.type === 'EXPENSE', cParent && cParent.type);
  ok('子分类挂在父下', cChildA && cParent && cChildA.parent_id === cParent.id);
  ok('独立分类为顶级', cIndep && cIndep.parent_id === null, cIndep && cIndep.parent_id);
  ok('独立分类类型 INCOME', cIndep && cIndep.type === 'INCOME', cIndep && cIndep.type);

  const c2 = importRows('categories', catRows, { userId: UID });
  ok('重复导入分类 0 新增', c2.created === 0, c2.created);

  // 同名不同父级：名字必须唯一，导入时归一到已存在的那个，不能又造一条
  section('导入时同名分类归一（一个二级分类只能属于一个一级分类）');
  const dupCatRows = [
    ['名称', '类型', '父分类'],
    ['测试子分类A', '支出', '另一个父分类Y'],
  ];
  const c3 = importRows('categories', dupCatRows, { userId: UID });
  console.log('  结果: ' + JSON.stringify({ created: c3.created, skipped: c3.skipped }));
  const dupSame = db.prepare("SELECT * FROM categories WHERE user_id=? AND name='测试子分类A'").all(UID);
  ok('同名二级仍只有一条（没有按新父级另建）', dupSame.length === 1, '实际 ' + dupSame.length);
  ok('仍挂在原来的父分类下', dupSame[0] && dupSame[0].parent_id === cParent.id);
  ok('新父级没有被空建出来（子分类先命中，直接复用）',
    db.prepare("SELECT COUNT(*) c FROM categories WHERE user_id=? AND name='另一个父分类Y'").get(UID).c === 0,
    c3.created);

  // ---------------------------------------------------------------- 账户
  section('账户导入（中文类型映射 + 余额 + 币种）');
  const accRows = [
    ['名称', '类型', '余额', '币种'],
    ['测试储蓄卡', '储蓄卡', '1000.50', 'CNY'],
    ['测试信用卡', '信用卡', '-500', 'CNY'],
    ['测试钱包', '支付宝', '0', 'CNY'],
    ['测试投资', '理财', '20000', 'CNY'],
  ];
  const a1 = importRows('accounts', accRows, { userId: UID });
  ok('导入 4 个账户', a1.created === 4, a1.created);
  ok('储蓄卡 → DEBIT_CARD', (findRow('accounts', '测试储蓄卡') || {}).type === 'DEBIT_CARD', (findRow('accounts', '测试储蓄卡') || {}).type);
  ok('信用卡 → CREDIT_CARD', (findRow('accounts', '测试信用卡') || {}).type === 'CREDIT_CARD');
  ok('支付宝 → E_WALLET', (findRow('accounts', '测试钱包') || {}).type === 'E_WALLET');
  ok('理财 → INVESTMENT', (findRow('accounts', '测试投资') || {}).type === 'INVESTMENT');
  ok('余额 1000.5', (findRow('accounts', '测试储蓄卡') || {}).balance === 1000.5, (findRow('accounts', '测试储蓄卡') || {}).balance);
  const a2 = importRows('accounts', accRows, { userId: UID });
  ok('重复导入 0 新增', a2.created === 0, a2.created);

  // ---------------------------------------------------------------- 成员 / 商家 / 项目
  section('人员 / 商家 / 项目');
  const m1 = importRows('members', [['名称', '电话', '邮箱'], ['测试成员', '13800000000', 'a@b.c']], { userId: UID });
  ok('人员导入 1', m1.created === 1, m1.created);
  ok('电话已写入', (findRow('members', '测试成员') || {}).phone === '13800000000');

  const s1 = importRows('merchants', [['名称', '分类'], ['测试商家', '餐饮']], { userId: UID });
  ok('商家导入 1', s1.created === 1, s1.created);
  ok('商家分类已写入', (findRow('merchants', '测试商家') || {}).category === '餐饮');

  const p1 = importRows('projects', [['名称', '开始日期', '结束日期'], ['测试项目', '2026-01-01', '2026-12-31']], { userId: UID });
  ok('项目导入 1', p1.created === 1, p1.created);
  ok('开始日期已写入', (findRow('projects', '测试项目') || {}).start_date === '2026-01-01');
  ok('结束日期已写入', (findRow('projects', '测试项目') || {}).end_date === '2026-12-31');

  // ---------------------------------------------------------------- 隔离
  section('用户隔离：另一个 userId 看不到这些数据');
  ok('t2 交易数 0', db.prepare("SELECT COUNT(*) c FROM transactions WHERE user_id='t2'").get().c === 0);
  const other = importRows('transactions', txRows, { userId: 't2' });
  ok('t2 导入自己的 4 行（首行为表头）', other.created === 4, other.created);
  ok('t1 交易数未变', count('transactions') === 4 + 2 + 1 + 2 + 1 + 1, count('transactions'));

  // ---------------------------------------------------------------- 汇总
  console.log('\n== 最终库内统计 ==');
  for (const t of ['transactions', 'accounts', 'categories', 'members', 'merchants', 'projects']) {
    console.log('  ' + t.padEnd(14) + db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c);
  }

  console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
  if (fail) process.exit(1);
}

main();
