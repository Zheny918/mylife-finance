#!/usr/bin/env node
/*
 * 生成六类导入的示例 xlsx（含表头 + 示例行），供用户参照列名。
 * 用法：node scripts/make-import-templates.mjs
 * 产物：fixtures/导入示例-*.xlsx
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeXlsx } from './lib/xlsx-writer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'fixtures');

const TEMPLATES = {
  '收支明细': {
    sheet: '收支明细',
    rows: [
      ['日期', '类型', '金额', '分类', '账户', '转入账户', '说明', '成员', '商家', '项目', '标签'],
      ['2026-11-01', '支出', 88.5, '食品酒水/三餐', '招商银行', '', '午餐', '我', '全家', '日常', '#餐饮'],
      ['2026-11-02', '收入', 12000, '工资薪酬/工资', '招商银行', '', '11月工资', '我', '', '', ''],
      ['2026-11-03', '支出', 2.85, '交通/公交地铁', '微信', '', '公交', '', '', '', ''],
      ['2026-11-04', '转账', 500, '', '招商银行', '微信', '转到微信', '', '', '', ''],
    ],
    notes: [
      '必填：日期、金额（或「支出」「收入」两列拆开写）',
      '类型可写 支出/收入/转账，也可留空（留空按支出处理）',
      '分类建议写「一级/二级」，只写二级名时会自动挂到已有的一级下',
      '转账时填「转入账户」，该行会自动按转账处理',
    ],
  },
  '分类': {
    sheet: '分类',
    rows: [
      ['名称', '类型', '父分类'],
      ['餐饮', '支出', ''],
      ['早餐', '支出', '餐饮'],
      ['工资', '收入', ''],
      ['年终奖', '收入', '工资'],
    ],
    notes: ['必填：名称；类型写 支出/收入（留空按支出）', '父分类留空表示一级分类'],
  },
  '账户': {
    sheet: '账户',
    rows: [
      ['名称', '类型', '余额', '币种'],
      ['招商银行', '储蓄卡', 12000.5, 'CNY'],
      ['招行信用卡', '信用卡', 0, 'CNY'],
      ['微信', '电子钱包', 300, 'CNY'],
      ['现金', '现金', 500, 'CNY'],
      ['基金账户', '投资', 20000, 'CNY'],
    ],
    notes: ['必填：名称', '类型可写 储蓄卡/信用卡/现金/投资/电子钱包/其他，也接受英文枚举'],
  },
  '项目': {
    sheet: '项目',
    rows: [
      ['名称', '开始日期', '结束日期'],
      ['日常', '2026-01-01', '2026-12-31'],
      ['装修', '2026-03-01', '2026-06-30'],
    ],
    notes: ['必填：名称', '日期留空表示不限'],
  },
  '人员': {
    sheet: '人员',
    rows: [
      ['名称', '电话', '邮箱'],
      ['我', '13800000000', 'me@example.com'],
      ['家人', '', ''],
    ],
    notes: ['必填：名称；电话和邮箱可留空'],
  },
  '商家': {
    sheet: '商家',
    rows: [
      ['名称', '分类'],
      ['全家', '便利店'],
      ['星巴克', '咖啡'],
    ],
    notes: ['必填：名称；分类是自由文本，不会自动连到收支分类'],
  },
};

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  for (const [name, tpl] of Object.entries(TEMPLATES)) {
    const buf = makeXlsx(tpl.rows, { sheetName: tpl.sheet });
    const file = path.join(OUT, '导入示例-' + name + '.xlsx');
    fs.writeFileSync(file, buf);
    console.log('已生成 ' + path.relative(ROOT, file) + '  (' + buf.length + ' bytes)');
    tpl.notes.forEach((n) => console.log('    · ' + n));
  }
}

main();
