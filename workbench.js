'use strict';
/*
 * 本地财务工作台（零依赖 Node http 服务）—— 单机 / 本地开发入口
 * - 浏览器打开 http://127.0.0.1:3457 使用交互界面（报表/账户/明细/记账/看板）
 * - /api/* 暴露 REST，复用 src/tools.js 与 src/db.js 逻辑（含 userId 隔离）
 * - 与 MCP server.js（stdio，给 AI 用）共享同一 SQLite，互不依赖
 *
 * ★ 这是**本机单用户**入口：不做登录，直接以 MYLF_WB_USER（默认 default）身份运行，
 *   只应绑定回环地址。多人共用 / 对外提供服务请用 server-http.js（必须登录）。
 *
 * 路由实现已抽到 src/webapp.js，Docker 里的 server-http.js 复用同一份逻辑。
 */
const http = require('node:http');
const { handleWeb } = require('./src/webapp');
const { DATA_DIR } = require('./src/db');

const PORT = Number(process.env.MYLF_WB_PORT) || 3457;
const HOST = process.env.MYLF_WB_HOST || '127.0.0.1';
const DEV_USER = String(process.env.MYLF_WB_USER || 'default').trim() || 'default';

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const opts = { localIdentity: { userId: DEV_USER, role: 'admin' } };
    if (await handleWeb(req, res, url, opts)) return;
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found: ' + url.pathname);
  } catch (e) {
    if (res.headersSent) return;
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: e && e.message }));
  }
});

if (HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1') {
  console.warn('');
  console.warn(`⚠ 工作台绑定在 ${HOST}，且本地入口不做登录 —— 同网段任何人都能读写「${DEV_USER}」的账本。`);
  console.warn('  对外提供服务请改用 server-http.js（带账号密码登录）。');
  console.warn('');
}

server.listen(PORT, HOST, () => {
  console.log(`MyLife 财务工作台已启动： http://${HOST}:${PORT}`);
  console.log(`当前身份（本机免登录）： ${DEV_USER}`);
  console.log(`离线看板快照： http://${HOST}:${PORT}/dashboard.html`);
  console.log(`数据目录： ${DATA_DIR}`);
  console.log('按 Ctrl+C 停止。');
});
