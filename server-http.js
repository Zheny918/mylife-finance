'use strict';
/*
 * Finance MCP Server — Streamable HTTP 传输（零依赖，仅 node:http）
 *
 * 规范：MCP Streamable HTTP（2025-03-26）
 *   POST /mcp/:userId   JSON-RPC 2.0（单条或批量），返回 application/json
 *   GET  /health        健康检查（容器探针用，免鉴权）
 *   GET  /mcp/:userId   规范里的 SSE 推送通道，本实现不推送，返回 405
 *   DELETE /mcp/:userId 终止会话，返回 204
 *
 * 同一个端口顺带把「工作台」也挂上（复用 src/webapp.js，与 workbench.js 同一份实现）：
 *   GET  /                 工作台界面（浏览器直接打开）
 *   GET  /dashboard.html   dashboard_build 生成的离线看板快照
 *   GET  /vendor/*         前端依赖
 *   *    /api/*            工作台 REST
 *   GET  /info             服务自述（原来的根路径 JSON，给机器看）
 *
 * 用户隔离：userId 由 URL 路径决定，并【强制覆盖】工具参数里的 userId。
 *   ⇒ 即使模型传错 userId，也不可能读到别人的数据。
 *   ⇒ 每个 Octop 专家/用户配自己的 URL 即完成隔离，无需可信的提示词约束。
 *
 * 环境变量：
 *   MYLF_HTTP_PORT         监听端口，默认 3458
 *   MYLF_HTTP_HOST         监听地址，默认 0.0.0.0（容器内需对外暴露）
 *   MYLF_HTTP_TOKEN        可选，**旧版全局令牌**。仅代表 MYLF_HTTP_TOKEN_USER 一个用户，
 *                          新部署请改用每用户 token（工作台「用户管理」里生成）
 *   MYLF_HTTP_TOKEN_USER   旧令牌绑定的用户名，默认 admin
 *   MYLF_ADMIN_USER        首次启动创建的管理员用户名，默认 admin
 *   MYLF_ADMIN_PASSWORD    首次启动管理员密码；不设则随机生成并写入 DATA_DIR/ADMIN-PASSWORD.txt
 *   MYLF_SESSION_SECRET    会话签名密钥；不设则自动生成到 DATA_DIR/session.key
 *   MYLF_DATA_DIR          数据目录，默认 ~/.mylife-finance
 *   MYLF_PUBLIC_BASE_URL   可选。对外基址（如 http://192.168.130.8:3458），用于把看板路径
 *                          拼成可点击的 URL 返回给模型；不设则只返回相对路径
 */
const http = require('node:http');
const crypto = require('node:crypto');
const tools = require('./src/tools');
const accounts = require('./src/accounts');
const audit = require('./src/audit');
const usage = require('./src/usage');
const { handleWeb } = require('./src/webapp');
const { db, DATA_DIR, uid, seedCategoriesIfEmpty } = require('./src/db');

const PORT = Number(process.env.MYLF_HTTP_PORT) || 3458;
const HOST = process.env.MYLF_HTTP_HOST || '0.0.0.0';
const LEGACY_TOKEN = process.env.MYLF_HTTP_TOKEN || '';
const LEGACY_TOKEN_USER = String(process.env.MYLF_HTTP_TOKEN_USER || 'admin').trim();
const MAX_BODY = 10 * 1024 * 1024;
// 首次访问某个 userId 时自动建租户并播种默认分类树。设 0 关闭（用户需预先存在）。
const AUTO_TENANT = process.env.MYLF_HTTP_AUTO_TENANT !== '0';
// userId 会被用作路径段并写库，限制字符集，避免奇怪键与路径穿越
const USER_ID_RE = /^[A-Za-z0-9._\u4e00-\u9fa5_-]{1,64}$/;
/*
 * 共享实例下不允许模型自建用户：用户维度由部署者通过 URL 决定，
 * 否则任意对话都可能凭空造出一个干净租户，进而绕过配额/审计。
 */
const DENIED_TOOLS = new Set(['user_create']);

const TOOL_DEFS = tools.list
  .filter((t) => !DENIED_TOOLS.has(t.name))
  .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
const TOOL_MAP = tools.map;

let sessionSeq = 0;

/* ---------------- JSON-RPC ---------------- */

// 返回 response 对象；notification 返回 null
function rpcHandle(msg, userId) {
  if (!msg || typeof msg !== 'object') return rpcError(null, -32600, '无效请求');

  // 客户端发来的 response 或 notification（无 id）—— 不产生响应
  if (msg.id === undefined || msg.id === null) {
    return null;
  }

  const id = msg.id;

  try {
    switch (msg.method) {
      case 'initialize': {
        const pv = (msg.params && msg.params.protocolVersion) || '2025-03-26';
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: pv,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'mylife-finance', version: '1.0.0', transport: 'streamable-http' },
          },
        };
      }

      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };

      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: TOOL_DEFS } };

      case 'tools/call': {
        const params = msg.params || {};
        const name = params.name;
        const def = TOOL_MAP[name];

        if (!def) {
          return rpcToolError(id, `未知工具 ${name}`);
        }
        if (DENIED_TOOLS.has(name)) {
          return rpcToolError(id, `工具 ${name} 在共享实例中不可用；用户维度由部署者通过 MCP URL 决定。`);
        }

        const callArgs = { ...(params.arguments || {}) };

        // 关键：无条件覆盖，杜绝模型传错或故意越权
        if (name === 'user_list') {
          const row = db.prepare('SELECT id, name FROM users WHERE name = ?').get(userId);
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ count: row ? 1 : 0, users: row ? [row] : [] }, null, 2),
                },
              ],
            },
          };
        }
        callArgs.userId = userId;

        try {
          const result = def.handler(callArgs);
          return {
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
          };
        } catch (e) {
          return rpcToolError(id, e.message);
        }
      }

      default:
        return rpcError(id, -32601, `方法未实现: ${msg.method}`);
    }
  } catch (e) {
    console.error('[mcp-http] handle error:', e && e.stack ? e.stack : e);
    return rpcError(id, -32000, (e && e.message) || '内部错误');
  }
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function rpcToolError(id, message) {
  return {
    jsonrpc: '2.0',
    id,
    result: { content: [{ type: 'text', text: `Error: ${message}` }], isError: true },
  };
}

/* ---------------- HTTP ---------------- */

function json(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...(extraHeaders || {}),
  });
  res.end(body);
}

function text(res, code, s) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(s);
}

/* ---------------- 鉴权（Bearer / Cookie / ?token=） ---------------- */

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length === 0) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

/*
 * 凭据 → 身份（★ 只认服务端签发的凭据，不认客户端自称）：
 *   1. Authorization: Bearer <每用户 token>  —— MCP 客户端 / curl，绑定唯一 userId
 *   2. mylf_sid 会话 cookie                  —— 浏览器登录工作台后
 *   3. ?token=<每用户 token>                 —— 浏览器首登（webapp 会换发 cookie）
 * 旧的全局面量 MYLF_HTTP_TOKEN 仍可用，但它只代表 MYLF_HTTP_TOKEN_USER 这一个用户。
 */
function bearer(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers['authorization'] || '');
  return m ? m[1].trim() : '';
}

function legacyIdentity(token) {
  if (!LEGACY_TOKEN || !safeEqual(token, LEGACY_TOKEN)) return null;
  const u = accounts.getUser(LEGACY_TOKEN_USER);
  return { userId: LEGACY_TOKEN_USER, role: u ? u.role : 'admin', via: 'legacy-token' };
}

function tokenIdentity(token) {
  const userId = accounts.resolveToken(token);
  if (!userId) return null;
  const u = accounts.getUser(userId);
  if (!u || u.disabled) return null;
  usage.mark(u.userId, 'token', '');
  return { userId: u.userId, role: u.role, via: 'token' };
}

function identify(req, url) {
  const bt = bearer(req);
  if (bt) return tokenIdentity(bt) || legacyIdentity(bt);

  const s = accounts.sessionFromRequest(req);
  if (s) return { userId: s.userId, role: s.role, via: 'session' };

  const q = url.searchParams.get('token');
  if (q) return tokenIdentity(q) || legacyIdentity(q);

  return null;
}

// /mcp/<userId> 或 /mcp?user=<userId> 或 /mcp
function resolveUserId(url) {
  const path = url.pathname;
  const m = /^\/mcp\/([^/]+)\/?$/.exec(path);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return '';
    }
  }
  const q = url.searchParams.get('user');
  if (q) return q;
  return 'default';
}

/*
 * 按需开通租户：新 userId 第一次使用时建 users 行并播种默认分类树。
 * 否则每个新用户进 Octop 看到的是空分类树，记账要手敲分类。
 */
const tenantCache = new Set();
function ensureTenant(userId) {
  if (!AUTO_TENANT) return;
  if (tenantCache.has(userId)) return;
  try {
    const row = db.prepare('SELECT id FROM users WHERE name = ?').get(userId);
    if (!row) {
      db.prepare('INSERT OR IGNORE INTO users (id, name) VALUES (?, ?)').run(uid(), userId);
      seedCategoriesIfEmpty(userId);
      console.log(`[mcp-http] 新租户已开通: ${userId}`);
    }
    tenantCache.add(userId);
  } catch (e) {
    console.error('[mcp-http] ensureTenant 失败:', e && e.message);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体超过 10 MiB 上限'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return text(res, 400, 'bad url');
  }

  // 健康检查不需要鉴权，供容器探针使用
  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/healthz')) {
    let categoryRows = 0;
    try {
      categoryRows = db.prepare('SELECT COUNT(*) c FROM categories').get().c;
    } catch {
      categoryRows = -1;
    }
    return json(res, 200, {
      ok: true,
      transport: 'streamable-http',
      toolCount: TOOL_DEFS.length,
      dataDir: DATA_DIR,
      categories: categoryRows,
    });
  }

  const me = identify(req, url);
  const isMcpPath = /^\/mcp(\/|$)/.test(url.pathname);

  // 无论从 MCP 还是工作台进来，第一次见到某人都给他开通租户（播种内置分类树）。
  // 只放在 MCP 分支里的话，只用工作台的用户会看到空分类树。
  if (me) ensureTenant(me.userId);

  // 工作台 / 登录页 / REST 由 webapp 自行鉴权（它需要给未登录者返回登录页而不是裸 401）
  if (!isMcpPath) {
    if (req.method === 'GET' && url.pathname === '/info') {
      if (!me) return text(res, 401, 'unauthorized（/info 需要凭据）');
      return json(res, 200, {
        name: 'mylife-finance MCP server',
        transport: 'streamable-http',
        endpoint: 'POST /mcp/<userId>',
        health: 'GET /health',
        workbench: 'GET /',
        login: 'GET /login',
        dashboard: 'GET /dashboard.html',
        api: '/api/*',
        you: { userId: me.userId, role: me.role, via: me.via },
        note: 'userId 取自 URL 路径，且必须与凭据所属用户一致，否则 403。',
      });
    }
    if (await handleWeb(req, res, url, { legacyToken: LEGACY_TOKEN, legacyTokenUser: LEGACY_TOKEN_USER })) return;
    return text(res, 404, 'not found');
  }

  if (!me) {
    // 带了凭据却过不了 = token 写错/已轮换/账号被停用，值得留痕；完全没带的不记，否则日志会被探针刷满
    if (bearer(req) || url.searchParams.get('token')) {
      audit.log('mcp.bad_token', { req, detail: { path: url.pathname } });
    }
    return text(
      res,
      401,
      [
        'unauthorized',
        '',
        `浏览器打开工作台： http://<主机>:${PORT}/login   用自己的用户名密码登录`,
        'MCP 客户端：     Authorization: Bearer <该用户自己的 token>',
        '                 （在「工作台 → 用户管理」里生成；新部署不要再共用旧版全局令牌）',
      ].join('\n')
    );
  }

  const userId = resolveUserId(url);
  if (!USER_ID_RE.test(userId)) {
    return text(res, 400, `非法 userId（仅允许字母数字 . _ - 与中文，1-64 位）：${userId.slice(0, 40)}`);
  }

  // ★ 授权校验：凭据属于谁，就只能访问谁。这是本版本补上的洞
  if (userId !== me.userId) {
    audit.log('mcp.forbidden', {
      req,
      userId: me.userId,
      detail: { urlUser: userId, path: url.pathname },
    });
    return text(
      res,
      403,
      [
        `forbidden：你的凭据属于「${me.userId}」，不能访问 /mcp/${userId}`,
        '',
        '· Octop 连接器：URL 里的用户名必须与该连接器 Headers 里 token 所属的用户一致',
        '· 若还在用旧版全局令牌 MYLF_HTTP_TOKEN：它只代表 MYLF_HTTP_TOKEN_USER（默认 admin）这一人，',
        '  请在工作台「用户管理」为每个人生成独立 token，或设置 MYLF_HTTP_TOKEN_USER 指向正确用户名',
      ].join('\n')
    );
  }

  ensureTenant(userId);

  if (req.method === 'POST') {
    let raw;
    try {
      raw = await readBody(req);
    } catch (e) {
      return text(res, 413, e.message);
    }

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return json(res, 400, rpcError(null, -32700, 'JSON 解析失败'));
    }

    const batch = Array.isArray(payload);
    const msgs = batch ? payload : [payload];

    const out = [];
    for (const m of msgs) {
      const r = rpcHandle(m, userId);
      if (r) out.push(r);
    }

    const headers = {};
    // 有 initialize 时下发会话 id；客户端会原样回带，本实现不校验以保持兼容
    if (msgs.some((m) => m && m.method === 'initialize')) {
      headers['Mcp-Session-Id'] = `mf-${Date.now().toString(36)}-${++sessionSeq}`;
    }

    // 全是 notification / response ⇒ 202 无 body（规范要求）
    if (out.length === 0) {
      res.writeHead(202, headers);
      return res.end();
    }

    return json(res, 200, batch ? out : out[0], headers);
  }

  if (req.method === 'GET') {
    // 规范允许服务端不提供 SSE 推送通道
    res.writeHead(405, { Allow: 'POST, DELETE' });
    return res.end('本实现不提供服务端 SSE 推送通道，请使用 POST。');
  }

  if (req.method === 'DELETE') {
    res.writeHead(204);
    return res.end();
  }

  res.writeHead(405, { Allow: 'GET, POST, DELETE' });
  return res.end();
});

server.listen(PORT, HOST, () => {
  console.log(`[mcp-http] listening on http://${HOST}:${PORT}`);
  console.log(`[mcp-http] endpoint: POST /mcp/<userId>  (tools=${TOOL_DEFS.length})`);
  console.log(`[mcp-http] workbench: GET /   login: GET /login   dashboard: GET /dashboard.html`);
  console.log(`[mcp-http] dataDir: ${DATA_DIR}`);

  // 首次启动：没有账号就建一个管理员（密码写到 ADMIN-PASSWORD.txt，并强制首登改密）
  let boot = null;
  try {
    boot = accounts.ensureBootstrap();
  } catch (e) {
    console.error('[mcp-http] 初始化管理员失败:', e && e.message);
  }
  if (boot) {
    console.log(`[mcp-http] 已创建管理员「${boot.userId}」`);
    if (boot.generated) {
      console.log(`[mcp-http] 初始密码已写入 ${boot.file}`);
      console.log(`[mcp-http] 登录地址： http://<主机>:${PORT}/login`);
    } else {
      console.log('[mcp-http] 管理员密码来自 MYLF_ADMIN_PASSWORD');
    }
  }

  const users = accounts.listUsers();
  console.log(`[mcp-http] 账号 ${users.length} 个：${users.map((u) => u.userId).join(', ') || '（空）'}`);
  if (LEGACY_TOKEN) {
    const ok = users.some((u) => u.userId === LEGACY_TOKEN_USER);
    console.warn(
      `[mcp-http] ⚠ 正在使用旧版全局令牌 MYLF_HTTP_TOKEN，它只代表「${LEGACY_TOKEN_USER}」${
        ok ? '' : '（该账号不存在，请先用工作台创建）'
      }`
    );
    console.warn('[mcp-http]   建议改为每用户 token：工作台 → 用户管理 → 创建/轮换 token');
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[mcp-http] ${sig} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
