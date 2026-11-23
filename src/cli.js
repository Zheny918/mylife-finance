#!/usr/bin/env node
'use strict';
/*
 * 用户管理 CLI（容器内 / 本机都能用）
 *
 *   node src/cli.js list
 *   node src/cli.js add alice --label 老婆 [--role admin] [--password xxx] [--reclaim]
 *   node src/cli.js passwd alice [--password xxx]
 *   node src/cli.js token alice            # 轮换 MCP token，打印新值（只此一次）
 *   node src/cli.js disable alice          # 停用（已登录会话立即失效）
 *   node src/cli.js enable alice
 *   node src/cli.js del alice              # 只删账号，账本数据保留（并留墓碑，禁止同名重建）
 *   node src/cli.js del alice --purge      # 连账本数据一起删（不可恢复）
 *
 * 放在 src/ 下是为了随镜像一起分发：docker exec mylife-finance-mcp node src/cli.js list
 */
const crypto = require('node:crypto');
const accounts = require('./accounts');
const usageStore = require('./usage');
const { purgeUserData } = require('./db');
const T = require('./tools');

function usage() {
  console.log(
    [
      '用法：node src/cli.js <命令> [参数]',
      '',
      '  list                          列出所有用户',
      '  add <userId> [--label x] [--role admin|member] [--password x] [--reclaim]',
      '  passwd <userId> [--password x] 重置密码（不给则随机生成并打印）',
      '  token <userId>                轮换 MCP token 并打印新值',
      '  disable <userId> / enable <userId>',
      '  del <userId> [--purge]        删账号；默认保留账本，--purge 连账本一起删',
    ].join('\n')
  );
}

function flag(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? fallback : v;
}

function positionals() {
  const out = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      i += 1; // 跳过值
      continue;
    }
    out.push(a);
  }
  return out;
}

function genPassword() {
  // 去掉容易混淆的 0/O/1/l/I，读起来不费劲
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(12);
  let s = '';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s;
}

function mcpUrl(userId) {
  const base = process.env.MYLF_PUBLIC_BASE_URL || '';
  return base ? `${base.replace(/\/+$/, '')}/mcp/${userId}` : `/mcp/${userId}`;
}

function main() {
  const cmd = positionals()[0];
  const userId = positionals()[1];
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return 0;
  }

  if (cmd === 'list') {
    const users = accounts.listUsers();
    const use = usageStore.all();
    if (!users.length) {
      console.log('（还没有用户。运行 node src/cli.js add <名字> 创建）');
      return 0;
    }
    const pad = (s, n) => String(s).padEnd(n, ' ');
    const short = (t) => (t ? String(t).slice(0, 16).replace('T', ' ') : '—');
    console.log(pad('用户名', 18) + pad('角色', 8) + pad('状态', 8) + pad('token', 8) + pad('最近登录', 18) + '备注');
    for (const u of users) {
      const s = use[u.userId] || {};
      console.log(
        pad(u.userId, 18) +
          pad(u.role === 'admin' ? '管理员' : '成员', 8) +
          pad(u.disabled ? '停用' : '正常', 8) +
          pad(u.hasToken ? '已配' : '无', 8) +
          pad(short(s.lastLoginAt), 18) +
          (u.label || '')
      );
    }
    const retired = accounts.listRetired();
    if (retired.length) {
      console.log('\n已删除但数据仍在（同名重建需 add --reclaim）：' + retired.map((r) => r.userId).join(', '));
    }
    return 0;
  }

  if (!userId) {
    console.error('缺少 <userId>');
    usage();
    return 2;
  }

  try {
    if (cmd === 'add') {
      const password = flag('password') || genPassword();
      const { user, token, reclaimed } = accounts.createUser({
        userId,
        label: flag('label', ''),
        password,
        role: flag('role', 'member'),
        mustChange: !flag('password'),
        reclaim: process.argv.includes('--reclaim'),
      });
      try {
        T.userCreate({ name: user.userId });
      } catch (e) {
        console.warn('（账本初始化提示：' + e.message + '）');
      }
      console.log(`已创建用户：${user.userId}（${user.role === 'admin' ? '管理员' : '成员'}）`);
      if (reclaimed) console.log('⚠ 该用户名曾被删除，已按 --reclaim 接管其原有账本数据。');
      console.log(`登录密码：${password}${flag('password') ? '' : '   ← 随机生成，请转告本人后删除这条输出'}`);
      console.log(`MCP token：${token}   ← 只显示这一次`);
      console.log(`Octop 连接器 URL：${mcpUrl(user.userId)}`);
      console.log(`浏览器登录：${(process.env.MYLF_PUBLIC_BASE_URL || 'http://<主机>:3458').replace(/\/+$/, '')}/login`);
      return 0;
    }

    if (cmd === 'passwd') {
      const password = flag('password') || genPassword();
      const user = accounts.setPassword(userId, password, { mustChange: !flag('password') });
      console.log(`已重置 ${user.userId} 的密码：${password}`);
      console.log('该用户在所有设备上的旧会话已失效。');
      return 0;
    }

    if (cmd === 'token') {
      const { token } = accounts.rotateToken(userId);
      console.log(`已轮换 ${userId} 的 MCP token：`);
      console.log(token);
      console.log('旧 token 立即失效，记得同步更新 Octop 连接器的 Headers。');
      return 0;
    }

    if (cmd === 'disable' || cmd === 'enable') {
      const user = accounts.setDisabled(userId, cmd === 'disable');
      console.log(`${user.userId} 已${user.disabled ? '停用' : '启用'}`);
      return 0;
    }

    if (cmd === 'del') {
      const purge = process.argv.includes('--purge');
      const pre = accounts.canDelete(userId);
      if (!pre.ok) throw new Error(pre.error);
      let counts = null;
      if (purge) counts = purgeUserData(userId);
      accounts.deleteUser(userId, { forget: purge });
      usageStore.forget(userId);
      if (purge) {
        console.log(`已删除账号 ${userId}，并清空其账本：${JSON.stringify(counts)}`);
        console.log('数据不可恢复。该用户名可以重新创建。');
      } else {
        console.log(`已删除账号 ${userId}。账本数据仍保留在库里。`);
        console.log('为避免同名新人接管旧账，该用户名已被标记为「已删除」；确属同一人时用 add --reclaim 接管。');
      }
      return 0;
    }
  } catch (e) {
    console.error('失败：' + e.message);
    return 1;
  }

  console.error('未知命令：' + cmd);
  usage();
  return 2;
}

process.exitCode = main();
