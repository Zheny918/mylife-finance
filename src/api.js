'use strict';
/*
 * 工作台 REST API（零依赖，供 src/webapp.js 的 http 服务调用）
 * ★ userId 由调用方（webapp.js）从**服务端凭据**解析后注入，本模块不读任何请求头。
 *   1.1.1 及以前这里取 `x-user-id` 头 / `?userId=`，属于越权根因，已移除。
 */
const T = require('./tools');
const { getDashboardData } = require('./dashboard');
const { readTable } = require('./xlsx-reader');
const { importRows } = require('./importers');

const ACCOUNT_TYPES = ['DEBIT_CARD', 'CREDIT_CARD', 'INVESTMENT', 'CASH', 'E_WALLET', 'OTHER'];

// Excel 导入走 base64 放在 JSON 里，体积会膨胀约 1/3，所以上限放到 24MB（约等于 18MB 原文件）
const MAX_BODY_BYTES = 24 * 1024 * 1024;

function readBody(req, limit) {
  const cap = limit || MAX_BODY_BYTES;
  return new Promise((resolve) => {
    let data = '';
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };

    req.on('data', (c) => {
      data += c;
      if (data.length > cap) { finish({ __tooLarge: true }); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return finish({});
      try { finish(JSON.parse(data)); } catch (e) { finish({}); }
    });
    req.on('error', () => finish({}));
    // destroy 之后不一定会发 error，用 close 兜底避免请求挂起
    req.on('close', () => { if (!settled) finish({}); });
  });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
  res.end(body);
}

// 路由表：[method, RegExp, handler]
// handler(ctx) 返回 { status, body } 或直接返回数据对象（默认 200）。
const routes = [
  ['GET', /^\/api\/meta$/, (ctx) => ({ userId: ctx.userId, role: ctx.role, accountTypes: ACCOUNT_TYPES })],

  ['GET', /^\/api\/summary$/, (ctx) => getDashboardData(ctx.userId, { year: ctx.query.year, month: ctx.query.month })],

  // 下拉数据：按使用频次排序（常用项排前面）
  ['GET', /^\/api\/selectors$/, (ctx) => T.selectorLists({ userId: ctx.userId })],

  // 报表：统一筛选，六维度一次返回
  ['GET', /^\/api\/reports\/overview$/, (ctx) => T.reportOverview(ctx.query)],

  ['GET', /^\/api\/transactions$/, (ctx) => T.txList(ctx.query)],
  ['POST', /^\/api\/transactions$/, (ctx) => T.txAdd(ctx.body)],
  ['PUT', /^\/api\/transactions\/([\w-]+)$/, (ctx) => T.txUpdate({ ...ctx.body, id: ctx.params[1] })],
  ['DELETE', /^\/api\/transactions\/([\w-]+)$/, (ctx) => T.txDelete({ id: ctx.params[1], userId: ctx.userId })],

  ['GET', /^\/api\/accounts$/, (ctx) => T.accountList(ctx.query)],
  ['POST', /^\/api\/accounts$/, (ctx) => T.accountAdd(ctx.body)],
  ['PUT', /^\/api\/accounts\/([\w-]+)$/, (ctx) => T.accountUpdate({ ...ctx.body, id: ctx.params[1] })],
  ['DELETE', /^\/api\/accounts\/([\w-]+)$/, (ctx) => T.accountDelete({ id: ctx.params[1], userId: ctx.userId })],

  ['GET', /^\/api\/categories$/, (ctx) => T.categoryList(ctx.query)],
  ['POST', /^\/api\/categories$/, (ctx) => T.categoryAdd(ctx.body)],
  ['GET', /^\/api\/categories\/duplicates$/, (ctx) => T.categoryDuplicates({ ...ctx.query, userId: ctx.userId })],
  ['POST', /^\/api\/categories\/merge$/, (ctx) => T.categoryMerge({ ...ctx.body, userId: ctx.userId })],
  ['POST', /^\/api\/categories\/dedupe$/, (ctx) => T.categoryDedupe({ ...ctx.body, userId: ctx.userId })],
  ['PUT', /^\/api\/categories\/([\w-]+)$/, (ctx) => T.categoryUpdate({ ...ctx.body, id: ctx.params[1] })],
  ['DELETE', /^\/api\/categories\/([\w-]+)$/, (ctx) => T.categoryDelete({ id: ctx.params[1], userId: ctx.userId })],

  ['GET', /^\/api\/members$/, (ctx) => T.memberList(ctx.query)],
  ['POST', /^\/api\/members$/, (ctx) => T.memberAdd(ctx.body)],
  ['PUT', /^\/api\/members\/([\w-]+)$/, (ctx) => T.memberUpdate({ ...ctx.body, id: ctx.params[1] })],
  ['DELETE', /^\/api\/members\/([\w-]+)$/, (ctx) => T.memberDelete({ id: ctx.params[1], userId: ctx.userId })],

  ['GET', /^\/api\/merchants$/, (ctx) => T.merchantList(ctx.query)],
  ['POST', /^\/api\/merchants$/, (ctx) => T.merchantAdd(ctx.body)],
  ['PUT', /^\/api\/merchants\/([\w-]+)$/, (ctx) => T.merchantUpdate({ ...ctx.body, id: ctx.params[1] })],
  ['DELETE', /^\/api\/merchants\/([\w-]+)$/, (ctx) => T.merchantDelete({ id: ctx.params[1], userId: ctx.userId })],

  ['GET', /^\/api\/projects$/, (ctx) => T.projectList(ctx.query)],
  ['POST', /^\/api\/projects$/, (ctx) => T.projectAdd(ctx.body)],
  ['PUT', /^\/api\/projects\/([\w-]+)$/, (ctx) => T.projectUpdate({ ...ctx.body, id: ctx.params[1] })],
  ['DELETE', /^\/api\/projects\/([\w-]+)$/, (ctx) => T.projectDelete({ id: ctx.params[1], userId: ctx.userId })],

  ['GET', /^\/api\/receivables$/, (ctx) => T.receivableList(ctx.query)],
  ['POST', /^\/api\/receivables$/, (ctx) => T.receivableAdd(ctx.body)],
  ['PUT', /^\/api\/receivables\/([\w-]+)$/, (ctx) => T.receivableUpdate({ ...ctx.body, id: ctx.params[1] })],
  ['DELETE', /^\/api\/receivables\/([\w-]+)$/, (ctx) => T.receivableDelete({ id: ctx.params[1], userId: ctx.userId })],
  ['GET', /^\/api\/receivables-report$/, (ctx) => T.reportReceivables(ctx.query)],

  ['GET', /^\/api\/budgets$/, (ctx) => T.budgetList(ctx.query)],
  ['POST', /^\/api\/budgets$/, (ctx) => T.budgetAdd(ctx.body)],
  ['PUT', /^\/api\/budgets\/([\w-]+)$/, (ctx) => T.budgetUpdate({ ...ctx.body, id: ctx.params[1] })],
  ['DELETE', /^\/api\/budgets\/([\w-]+)$/, (ctx) => T.budgetDelete({ id: ctx.params[1], userId: ctx.userId })],
  ['GET', /^\/api\/budgets-report$/, (ctx) => T.reportBudget(ctx.query)],

  ['POST', /^\/api\/import$/, (ctx) => T.importFromMylife(ctx.body)],

  // Excel / CSV 导入：body = { filename, data: base64 }
  ['POST', /^\/api\/import\/([a-z]+)$/, (ctx) => {
    const entity = ctx.params[1];
    if (ctx.body && ctx.body.__tooLarge) throw new Error('文件太大，超过 18MB，请拆分后再导入');
    const raw = String(ctx.body.data || '').replace(/^data:[^,]*,/, '');
    if (!raw) throw new Error('没有收到文件内容');
    const buf = Buffer.from(raw, 'base64');
    if (!buf.length) throw new Error('文件内容解码失败，请重新选择文件');
    const rows = readTable(buf);
    return importRows(entity, rows, { userId: ctx.userId });
  }],
];

async function handleApi(req, res, url, identity) {
  if (req.method === 'OPTIONS') { send(res, 204, {}); return; }

  // 身份只来自调用方解析出的凭据；没有就拒绝
  const userId = identity && identity.userId;
  if (!userId) { send(res, 401, { ok: false, error: '未登录' }); return; }
  const role = identity.role || 'member';

  const query = Object.fromEntries(url.searchParams.entries());
  let body = {};
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
    body = await readBody(req);
  }
  // 把 userId 注入参数与 body，供工具层统一隔离
  query.userId = userId;
  if (typeof body === 'object' && body !== null) body.userId = userId;

  for (const [method, re, handler] of routes) {
    if (req.method !== method) continue;
    const m = url.pathname.match(re);
    if (!m) continue;
    try {
      const ctx = { userId, role, query, body, params: m };
      const result = await handler(ctx);
      if (result && typeof result.status === 'number') send(res, result.status, result.body);
      else send(res, 200, result);
    } catch (e) {
      send(res, 400, { ok: false, error: e.message });
    }
    return;
  }
  send(res, 404, { ok: false, error: '未找到接口: ' + req.method + ' ' + url.pathname });
}

module.exports = { handleApi, ACCOUNT_TYPES };
