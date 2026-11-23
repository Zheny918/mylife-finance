#!/usr/bin/env node
/*
 * 生成测试用 xlsx，并顺带断言 xlsx-reader 的解析结果。
 *
 * 为什么需要它：本机既没有 npm 依赖也没有 Excel，无法拿到真实 xlsx 做验证。
 * 自己按 ECMA-376 最小结构拼一份，能覆盖：
 *   共享字符串 / 富文本多 run / 日期序列号 / 数字 / inlineStr / 布尔 / 空单元格 / XML 转义
 *
 * 用法：node scripts/make-test-xlsx.mjs
 * 产物：fixtures/parser-test.xlsx
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { makeXlsx } from './lib/xlsx-writer.mjs';

const require = createRequire(import.meta.url);
const { readTable } = require('../src/xlsx-reader.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'fixtures');

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

function main() {
  fs.mkdirSync(FIXTURES, { recursive: true });

  const rows = [
    ['日期', '金额', '分类', '说明', '备注段落'],
    [{ date: [2026, 11, 1] }, 88.5, '三餐', '午餐&饮料', 'A<B>C'],
    [{ date: [2026, 12, 31] }, 1200, '工资', { inline: 'inline 值' }, null],
    ['2026-11-15', -50, '退款', '含"引号"与\'单引号\'', null],
    [{ date: [2026, 1, 1] }, 0.01, '极小额', { bool: true }, ''],
  ];

  const buf = makeXlsx(rows, { sheetName: '收支明细' });
  const outFile = path.join(FIXTURES, 'parser-test.xlsx');
  fs.writeFileSync(outFile, buf);
  console.log(`已生成 ${path.relative(ROOT, outFile)}（${buf.length} bytes）\n`);

  const parsed = readTable(buf);

  console.log('解析结果：');
  parsed.forEach((r, i) => console.log(`  [${i}] ${JSON.stringify(r)}`));
  console.log();

  console.log('断言：');
  ok('行数 = 5', parsed.length === 5, parsed.length);
  ok('表头正确', JSON.stringify(parsed[0]) === JSON.stringify(['日期', '金额', '分类', '说明', '备注段落']), parsed[0]);
  ok('日期序列号转成 YYYY-MM-DD（2026-11-01）', parsed[1][0] === '2026-11-01', parsed[1][0]);
  ok('小数金额保留精度 88.5', parsed[1][1] === 88.5, parsed[1][1]);
  ok('中文共享字符串', parsed[1][2] === '三餐', parsed[1][2]);
  ok('XML 转义 & 还原', parsed[1][3] === '午餐&饮料', parsed[1][3]);
  ok('XML 转义 < > 还原', parsed[1][4] === 'A<B>C', parsed[1][4]);
  ok('跨年日期 2026-12-31', parsed[2][0] === '2026-12-31', parsed[2][0]);
  ok('整数金额 1200', parsed[2][1] === 1200, parsed[2][1]);
  ok('inlineStr 单元格', parsed[2][3] === 'inline 值', parsed[2][3]);
  ok('缺列时补 null 对齐', parsed[2][4] === null, parsed[2][4]);
  ok('文本日期原样保留', parsed[3][0] === '2026-11-15', parsed[3][0]);
  ok('负数金额', parsed[3][1] === -50, parsed[3][1]);
  ok('引号转义', parsed[3][3] === '含"引号"与\'单引号\'', parsed[3][3]);
  ok('布尔值转文本', parsed[4][3] === 'TRUE', parsed[4][3]);
  ok('空字符串归一为 null', parsed[4][4] === null, parsed[4][4]);
  ok('富文本多 run 拼接', parsed[4][2] === '极小额', parsed[4][2]);

  const csv = '日期,金额,分类\n2026-11-01,88.5,三餐\n2026-11-02,"1,200","含,逗号"\n';
  const csvRows = readTable(Buffer.from('\ufeff' + csv, 'utf8'));
  console.log();
  console.log('CSV 解析：' + JSON.stringify(csvRows));
  ok('CSV 行数 = 3', csvRows.length === 3, csvRows.length);
  ok('CSV 引号内逗号不断列', csvRows[2][1] === '1,200', csvRows[2][1]);
  ok('CSV BOM 已剥离', csvRows[0][0] === '日期', csvRows[0][0]);

  console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
  if (fail) process.exit(1);
}

main();
