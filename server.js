'use strict';
/*
 * Finance MCP Server（stdio 传输，手写 JSON-RPC，零依赖）
 * 协议：每行一个 JSON-RPC 2.0 对象（newline-delimited）。
 * 仅向 stdout 写合法 JSON-RPC；所有日志走 stderr，避免污染协议流。
 */
const tools = require('./src/tools');

const TOOL_DEFS = tools.list.map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema,
}));
const TOOL_MAP = tools.map;

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) {
      try { handle(JSON.parse(line)); } catch (e) { console.error('parse error:', e.message); }
    }
  }
});
process.stdin.on('end', () => { process.stdout.end(() => process.exit(0)); });

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function handle(msg) {
  try {
    if (msg.id !== undefined && msg.method === 'initialize') {
      const pv = msg.params && msg.params.protocolVersion;
      send({
        jsonrpc: '2.0', id: msg.id,
        result: { protocolVersion: pv, capabilities: { tools: {} }, serverInfo: { name: 'mylife-finance', version: '1.0.0' } },
      });
    } else if (msg.method === 'notifications/initialized') {
      // 无需响应
    } else if (msg.id !== undefined && msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOL_DEFS } });
    } else if (msg.id !== undefined && msg.method === 'tools/call') {
      const { name, arguments: args } = msg.params;
      const def = TOOL_MAP[name];
      if (!def) {
        send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `Error: 未知工具 ${name}` }], isError: true } });
        return;
      }
      try {
        const result = def.handler(args || {});
        send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } });
      } catch (e) {
        send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true } });
      }
    } else if (msg.method === 'ping' && msg.id !== undefined) {
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
    } else if (msg.id !== undefined) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `方法未实现: ${msg.method}` } });
    }
  } catch (e) {
    console.error('handle error:', e);
    if (msg.id !== undefined) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: e.message } });
    }
  }
}
