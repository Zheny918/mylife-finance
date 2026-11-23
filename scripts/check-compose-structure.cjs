// 结构检查（纯 JS 行扫描，非完整 YAML 解析器；PyYAML 在本机不可用）
const fs = require('fs');
const f = process.argv[2] || 'docker-compose.qnap-octop-mcp.yml';
const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
const bad = [];
const top = [], services = [], networksTop = [];
let inServices = false, inTopNet = false, curSvc = null;

lines.forEach((l, i) => {
  const n = i + 1;
  if (l.includes('\t')) bad.push('第' + n + '行含制表符');
  if (/\s+$/.test(l)) bad.push('第' + n + '行有行尾空格');
  if (!l.trim() || l.trim().startsWith('#')) return;
  const ind = l.match(/^ */)[0].length;
  if (ind % 2 !== 0) bad.push('第' + n + '行缩进 ' + ind + ' 非偶数');
  if (ind === 0) {
    const m = l.match(/^([A-Za-z_][\w-]*):/);
    if (!m) bad.push('第' + n + '行顶层不是映射键: ' + l);
    else top.push(m[1]);
    inServices = !!m && m[1] === 'services';
    inTopNet = !!m && m[1] === 'networks';
    return;
  }
  if (inServices && ind === 2) {
    const m = l.match(/^ {2}([A-Za-z_][\w.-]*):\s*$/);
    if (m) { curSvc = m[1]; services.push(m[1]); }
    else bad.push('第' + n + '行 service 段不是合法键: ' + l);
    return;
  }
  if (inServices && curSvc && ind === 4) {
    const m = l.match(/^ {4}([A-Za-z_][\w.-]*):/);
    if (!m) bad.push('第' + n + '行 service 属性不是合法键: ' + l);
    return;
  }
  if (inTopNet && ind === 2) {
    const m = l.match(/^ {2}([A-Za-z_][\w.-]*):/);
    if (!m) bad.push('第' + n + '行 networks 段不是合法键: ' + l);
    else networksTop.push(m[1]);
  }
});

console.log('顶层键:', top.join(', '));
console.log('services:', services.join(', '));
console.log('顶层 networks:', networksTop.join(', '));
console.log(bad.length ? '问题:\n  ' + bad.join('\n  ') : '缩进/制表符/键名 结构 OK');

// 纯内容断言前先剥掉注释与空行，避免注释里的关键词造成误判
const code = lines.filter((l) => l.trim() && !l.trim().startsWith('#')).join(String.fromCharCode(10));
const joinNl = (arr) => arr.join(String.fromCharCode(10));
const checks = [
  ['version 3.8 存在', /^version:\s*"3\.8"$/m.test(code)],
  ['MCP 带 .internal 别名', /- mylife-finance-mcp\.internal$/m.test(code)],
  ['octop 接入 mylife_net（列表形式）', /- mylife_net$/m.test(code)],
  ['MCP 接入 mylife_net（映射形式）', new RegExp(joinNl(['^    networks:$', '^      mylife_net:$']), 'm').test(code)],
  ['mylife_net 由本文件声明（非 external）', new RegExp(joinNl(['^networks:$', '^  mylife_net:$']), 'm').test(code)],
  ['不含 external 依赖', !/external:\s*true/.test(code)],
  ['MCP 数据目录挂到 /data', /:\/data$/m.test(code)],
  ['MYLF_DATA_DIR 与挂载一致', /MYLF_DATA_DIR:\s*\/data/.test(code)],
  ['若引用命名卷则顶层有声明', (() => {
    const usesNamed = /-\s*mylife-finance-data:\/data/.test(code);
    const declared = new RegExp(joinNl(['^volumes:$', '^  mylife-finance-data:$']), 'm').test(code);
    return !usesNamed || declared;
  })()],
];
for (const [name, ok] of checks) console.log((ok ? '  ✓ ' : '  ✗ ') + name);
