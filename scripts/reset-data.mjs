#!/usr/bin/env node
/*
 * 清空业务数据，回到干净初始状态（保留登录用户与设置）
 *
 * 做什么：
 *   1. 先 VACUUM INTO 备份（不阻塞、不损坏 WAL）
 *   2. 清空 transactions / receivables / budgets / bills / accounts /
 *      categories / members / merchants / projects
 *   3. VACUUM 收缩文件
 *   4. 重新播种内置分类树（除非 --keep-categories 或 --no-seed）
 *
 * 为什么默认要重新播种：内置 137 个分类是产品自带的基础字典，
 * 不是用户产生的数据。清空后保留它，导入 Excel 时「三餐」这类二级名
 * 才能复用「食品酒水 / 三餐」，而不是另建一堆顶级分类。
 *
 * 用法：
 *   node scripts/reset-data.mjs --yes                  # 清空并重播内置分类
 *   node scripts/reset-data.mjs --yes --no-seed        # 清空后分类也留空
 *   node scripts/reset-data.mjs --dry-run              # 只看会删多少，不动数据
 *   MYLF_DATA_DIR=C:/tmp/x node scripts/reset-data.mjs --yes   # 对别的库执行
 *
 * 安全：不带 --yes 一律只打印计划，不执行。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { db, DB_PATH, DATA_DIR, seedCategoriesIfEmpty } = require('../src/db.js');

const ARGS = process.argv.slice(2);
const YES = ARGS.includes('--yes');
const DRY = ARGS.includes('--dry-run');
const NO_SEED = ARGS.includes('--no-seed') || ARGS.includes('--keep-categories');

const TABLES = [
  'transactions', 'receivables', 'budgets', 'bills',
  'accounts', 'categories', 'members', 'merchants', 'projects',
];

function existingTables() {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  const set = new Set(names);
  return TABLES.filter((t) => set.has(t));
}

function snapshot() {
  const out = {};
  const set = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
  for (const t of TABLES.concat(['users', 'settings'])) {
    out[t] = set.has(t) ? db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c : '（无此表）';
  }
  return out;
}

function main() {
  console.log('目标库: ' + DB_PATH);
  console.log('数据目录: ' + DATA_DIR);

  if (!fs.existsSync(DB_PATH)) {
    console.error('库文件不存在，无需清空：' + DB_PATH);
    process.exit(1);
  }

  const before = snapshot();
  console.log('\n清空前行数:');
  for (const [k, v] of Object.entries(before)) console.log('  ' + k.padEnd(14) + v);

  if (DRY) {
    console.log('\n[--dry-run] 以上为将删除的行数，未做任何改动。');
    console.log('确认无误后加 --yes 执行。');
    return;
  }

  if (!YES) {
    console.log('\n这将删除上表全部业务数据（users / settings 保留）。');
    console.log('请先确认已备份，然后加 --yes 执行：');
    console.log('  node scripts/reset-data.mjs --yes');
    return;
  }

  // 1) 备份
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const bak = path.join(path.dirname(DB_PATH), 'finance-backup-before-reset-' + ts + '.db');
  db.exec(`VACUUM INTO '${bak.replace(/'/g, "''")}'`);
  const bakSize = fs.statSync(bak).size;
  console.log('\n已备份: ' + bak + '  (' + (bakSize / 1024 / 1024).toFixed(2) + ' MB)');

  // 2) 清空（只清实际存在的表，避免旧库没有 bills 之类的新表时整体失败）
  const targets = existingTables();
  db.exec('BEGIN');
  try {
    for (const t of targets) db.exec(`DELETE FROM ${t}`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw new Error('清空失败，已回滚：' + e.message);
  }
  console.log('\n已清空 ' + targets.length + ' 张表：' + targets.join(', '));

  // 3) 收缩
  db.exec('VACUUM');

  // 4) 播种
  let seeded = 0;
  if (!NO_SEED) {
    const r = seedCategoriesIfEmpty('default');
    seeded = r.seeded || 0;
  }

  const after = snapshot();
  console.log('\n清空后行数:');
  for (const [k, v] of Object.entries(after)) console.log('  ' + k.padEnd(14) + v);
  if (seeded) console.log('\n已重新播种内置分类: ' + seeded + ' 个');

  const sizeMb = (fs.statSync(DB_PATH).size / 1024).toFixed(1);
  console.log('库文件大小: ' + sizeMb + ' KB');
  console.log('\n完成。回滚方式：把备份文件复制回 ' + DB_PATH);
}

main();
