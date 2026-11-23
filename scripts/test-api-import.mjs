#!/usr/bin/env node
/*
 * Excel 导入 API 端到端测试
 *
 * 前置：在临时数据目录上启动工作台（不要用真实库）
 *   MYLF_DATA_DIR=C:/zzytest/_wbtest MYLF_WB_PORT=3471 node workbench.js &
 *   node scripts/test-api-import.mjs http://127.0.0.1:3471
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeXlsx } from './lib/xlsx-writer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.argv[2] || 'http://127.0.0.1:3471';
const UID = 'apitest';

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

async function call(method, pathname, body) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-user-id': UID },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
  return { status: res.status, json, text };
}

async function main() {
  console.log('目标服务: ' + BASE + '  userId=' + UID);

  // 构造测试文件
  const txRows = [
    ['交易日期', '收支类型', '交易金额', '分类名称', '支付账户', '备注', '人员', '商户'],
    ['2026-10-01', '支出', '25.80', '食品酒水/三餐', '微信', '早餐', '李四', '便利店'],
    ['2026-10-02', '收入', '8000', '工资薪酬/工资', '招行', '10月工资', '李四', null],
    ['2026/10/03', '支出', '1,050', '居住/房租', '招行', '房租', null, null],
  ];
  const txBuf = makeXlsx(txRows, { sheetName: '明细' });

  console.log('\n== 正常导入 xlsx ==');
  const r1 = await call('POST', '/api/import/transactions', {
    filename: 'transactions.xlsx',
    data: txBuf.toString('base64'),
  });
  ok('HTTP 200', r1.status === 200, r1.status);
  ok('ok=true', r1.json && r1.json.ok === true, r1.json);
  ok('3 行全部新增', r1.json && r1.json.created === 3, r1.json && r1.json.created);
  ok('无失败', r1.json && r1.json.failed === 0, r1.json && r1.json.errors);
  console.log('  mapping: ' + JSON.stringify(r1.json && r1.json.mapping));

  console.log('\n== 列名识别（别名）==');
  const map = (r1.json && r1.json.mapping) || {};
  ok('「交易日期」→ date', map.date !== undefined, map.date);
  ok('「收支类型」→ type', map.type !== undefined, map.type);
  ok('「交易金额」→ amount', map.amount !== undefined, map.amount);
  ok('「分类名称」→ category', map.category !== undefined, map.category);
  ok('「支付账户」→ account', map.account !== undefined, map.account);
  ok('「备注」→ description', map.description !== undefined, map.description);
  ok('「人员」→ member', map.member !== undefined, map.member);
  ok('「商户」→ merchant', map.merchant !== undefined, map.merchant);

  console.log('\n== 重复导入同一文件 ==');
  const r2 = await call('POST', '/api/import/transactions', {
    filename: 'transactions.xlsx',
    data: txBuf.toString('base64'),
  });
  ok('新增 0', r2.json && r2.json.created === 0, r2.json && r2.json.created);
  ok('跳过 3', r2.json && r2.json.skipped === 3, r2.json && r2.json.skipped);

  console.log('\n== 数据确实落库（/api/transactions）==');
  const list = await call('GET', '/api/transactions?limit=100');
  ok('列表返回 3 笔', list.json && list.json.count === 3, list.json && list.json.count);
  const first = (list.json && list.json.transactions && list.json.transactions[0]) || {};
  ok('带上了账户名', !!first.account, first.account);
  ok('带上了分类名', !!first.category, first.category);

  console.log('\n== 分类导入 ==');
  const catBuf = makeXlsx([
    ['名称', '类型'],
    ['API测试分类A', '支出'],
    ['API测试分类B', '收入'],
  ]);
  const r3 = await call('POST', '/api/import/categories', {
    filename: 'categories.xlsx',
    data: catBuf.toString('base64'),
  });
  ok('导入 2 个分类', r3.json && r3.json.created === 2, r3.json && r3.json.created);

  console.log('\n== 账户导入 ==');
  const accBuf = makeXlsx([
    ['名称', '类型', '余额'],
    ['API测试卡', '储蓄卡', '500'],
  ]);
  const r4 = await call('POST', '/api/import/accounts', {
    filename: 'accounts.xlsx',
    data: accBuf.toString('base64'),
  });
  ok('导入 1 个账户', r4.json && r4.json.created === 1, r4.json && r4.json.created);
  const accList = await call('GET', '/api/accounts');
  const apiCard = (accList.json && accList.json.accounts || []).find((a) => a.name === 'API测试卡');
  ok('账户类型映射为 DEBIT_CARD', apiCard && apiCard.type === 'DEBIT_CARD', apiCard && apiCard.type);

  console.log('\n== CSV 也能导 ==');
  const csv = '日期,金额,账户,说明\n2026-10-09,12.5,微信,CSV行\n';
  const r5 = await call('POST', '/api/import/transactions', {
    filename: 'a.csv',
    data: Buffer.from('\ufeff' + csv, 'utf8').toString('base64'),
  });
  ok('CSV 导入 1 笔', r5.json && r5.json.created === 1, r5.json && r5.json);

  console.log('\n== 错误处理 ==');
  const e1 = await call('POST', '/api/import/transactions', { filename: 'x.xlsx' });
  ok('缺 data → 400', e1.status === 400, e1.status);
  ok('错误信息点明没收到内容', /没有收到文件内容/.test(e1.json && e1.json.error), e1.json);

  const e2 = await call('POST', '/api/import/nosuch', { data: txBuf.toString('base64') });
  ok('非法实体 → 400', e2.status === 400, e2.status);
  ok('错误信息列出可选类型', /不支持的导入类型/.test(e2.json && e2.json.error), e2.json);

  const e3 = await call('POST', '/api/import/transactions', {
    filename: 'bad.xlsx',
    data: Buffer.from('this is not a spreadsheet').toString('base64'),
  });
  ok('非表格文件 → 400', e3.status === 400, e3.status);

  const e4 = await call('POST', '/api/import/transactions', {
    filename: 'nodate.xlsx',
    data: makeXlsx([['说明', '金额'], ['午餐', '88']]).toString('base64'),
  });
  ok('缺日期列 → 400', e4.status === 400, e4.status);
  ok('错误里点名缺「日期」', /日期/.test(e4.json && e4.json.error), e4.json && e4.json.error);

  console.log('\n== 首页统计已反映新数据 ==');
  const sum = await call('GET', '/api/summary');
  ok('本年交易笔数 > 0', sum.json && sum.json.yearTxCount > 0, sum.json && sum.json.yearTxCount);

  console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error('测试异常：' + e.message); process.exit(1); });
