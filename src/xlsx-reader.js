'use strict';
/*
 * 零依赖 xlsx / csv 读取器
 *
 * 为什么手写：本项目定位零 npm 依赖（连 SQLite 都用 node:sqlite），
 * 引入 SheetJS 会让 MCP 容器与 Octop 侧多一份安装步骤。
 *
 * 只做「读表格」这一件事，取舍如下：
 *   - 只读第一个工作表（xlsx 里多个 sheet 时取表顺序第一个，通常就是用户看的那个）
 *   - 只取单元格的值，不保留样式、公式、批注、图片
 *   - 合并单元格按左上角单元格取值，其余位置为空（Excel 的存储方式本就这样）
 *   - 支持 .xlsx（ZIP+XML）与 .csv（UTF-8，含 BOM，逗号分隔）
 *   - 不支持 .xls（97-2003 二进制格式，是完全不同的文件格式，需要另写解析器）
 *
 * 输出统一为一维行数组，每行是值数组：
 *   [['日期','金额','分类'], ['2026-11-15', 88, '三餐']]
 */

const zlib = require('node:zlib');

// ---------------------------------------------------------------- ZIP 读取

const SIG_EOCD = 0x06054b50; // PK\x05\x06
const SIG_CENTRAL = 0x02014b50; // PK\x01\x02
const SIG_LOCAL = 0x04034b50; // PK\x03\x04

/**
 * 读取 ZIP 中央目录，返回 文件名 -> { method, compSize, localOff }
 * 走中央目录而不是顺序扫本地头，是因为本地头在流式写入时 compSize 可能是 0
 * （实际大小放在数据描述符里），中央目录则总是准确的。
 */
function readZipDirectory(buf) {
  // EOCD 在文件末尾，后面可能跟着最长 65535 字节的注释
  let eocd = -1;
  const minStart = Math.max(0, buf.length - 65557 - 22);
  for (let i = buf.length - 22; i >= minStart; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 xlsx 文件（未找到 ZIP 结尾记录）');

  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff) throw new Error('暂不支持 ZIP64 格式的 xlsx，请用 Excel 另存为 .xlsx 后重试');

  const entries = new Map();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { method, compSize, localOff });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 取出某个条目的解压后内容（Buffer），不存在返回 null */
function readZipEntry(buf, entries, name) {
  const e = entries.get(name);
  if (!e) return null;
  const p = e.localOff;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== SIG_LOCAL) return null;
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + e.compSize);
  if (e.method === 0) return data;
  if (e.method === 8) {
    try { return zlib.inflateRawSync(data); }
    catch (err) { throw new Error('xlsx 内部数据解压失败：' + err.message); }
  }
  throw new Error('不支持的 ZIP 压缩方式（method=' + e.method + '）');
}

// ---------------------------------------------------------------- XML 解析

const ENTITY = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
};

function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    const v = ENTITY[body.toLowerCase()];
    return v === undefined ? m : v;
  });
}

/** 从 '<' 位置找标签结束的 '>'，跳过属性值里的引号内容 */
function findTagEnd(s, lt) {
  let quote = 0;
  for (let i = lt + 1; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (quote) {
      if (ch === quote) quote = 0;
    } else if (ch === 34 || ch === 39) { // " 或 '
      quote = ch;
    } else if (ch === 62) { // >
      return i;
    }
  }
  return -1;
}

function parseAttrs(src) {
  const attrs = {};
  const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(src))) attrs[m[1]] = decodeEntities(m[3] !== undefined ? m[3] : m[4]);
  return attrs;
}

/**
 * 极简 XML → 树。只保留本读取器需要的结构：
 * { name, attrs, children: [], text }
 * 足够应付 xlsx 内部那几个固定文件。
 */
function parseXml(src) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  let i = 0;
  const n = src.length;

  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { top().text += decodeEntities(src.slice(i)); break; }
    if (lt > i) top().text += decodeEntities(src.slice(i, lt));

    if (src.startsWith('<!--', lt)) {
      const e = src.indexOf('-->', lt);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const e = src.indexOf(']]>', lt);
      top().text += src.slice(lt + 9, e < 0 ? n : e);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (src.startsWith('<?', lt)) {
      const e = src.indexOf('?>', lt);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (src.startsWith('<!', lt)) {
      const e = src.indexOf('>', lt);
      i = e < 0 ? n : e + 1;
      continue;
    }

    const gt = findTagEnd(src, lt);
    if (gt < 0) break;
    const raw = src.slice(lt + 1, gt);

    if (raw[0] === '/') {
      const name = raw.slice(1).trim();
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) { stack.length = k; break; }
      }
      i = gt + 1;
      continue;
    }

    const selfClose = raw.endsWith('/');
    const body = selfClose ? raw.slice(0, -1) : raw;
    const sp = body.search(/[\s]/);
    const name = (sp < 0 ? body : body.slice(0, sp)).trim();
    if (!name) { i = gt + 1; continue; }
    const node = { name, attrs: parseAttrs(sp < 0 ? '' : body.slice(sp)), children: [], text: '' };
    top().children.push(node);
    if (!selfClose) stack.push(node);
    i = gt + 1;
  }
  return root;
}

function findAll(node, name, out) {
  out = out || [];
  for (const c of node.children) {
    if (c.name === name) out.push(c);
    findAll(c, name, out);
  }
  return out;
}

function firstChild(node, name) {
  for (const c of node.children) if (c.name === name) return c;
  return null;
}

/** 该节点下所有 <t> 的文本拼接（富文本 <r><t>…</t></r> 会有多个） */
function collectT(node) {
  const ts = findAll(node, 't');
  if (!ts.length) return node.text || '';
  return ts.map((t) => t.text || '').join('');
}

// ---------------------------------------------------------------- 值转换

/** 'A' → 0, 'Z' → 25, 'AA' → 26 */
function colToIndex(letters) {
  let n = 0;
  for (let i = 0; i < letters.length; i++) {
    n = n * 26 + (letters.charCodeAt(i) - 64);
  }
  return n - 1;
}

/** Excel 日期序列号 → 'YYYY-MM-DD'（epoch 1899-12-30，按 UTC 取值避免时区漂移） */
function serialToDay(serial) {
  const ms = Math.round((serial - 25569) * 86400000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  return y + '-' + mo + '-' + da;
}

/** 内置日期/时间格式的 numFmtId 区间（ECMA-376 标准表） */
const DATE_FMT_IDS = new Set();
for (let i = 14; i <= 22; i++) DATE_FMT_IDS.add(i);
for (let i = 45; i <= 47; i++) DATE_FMT_IDS.add(i);
for (let i = 27; i <= 36; i++) DATE_FMT_IDS.add(i); // 部分区域设置下的日期格式

function isDateFormatCode(code) {
  if (!code) return false;
  // 去掉引号内的字面量与转义字符，避免「"年"」被误判
  const cleaned = code.replace(/"[^"]*"/g, '').replace(/\\./g, '');
  return /[yd]/i.test(cleaned) || /h.*m|m.*s/i.test(cleaned);
}

/**
 * 解析 styles.xml，得到「单元格样式索引 → 是否日期格式」
 * 单元格的 s 属性指向 cellXfs 里的下标。
 */
function buildStyleFlags(stylesBuf) {
  const flags = [];
  if (!stylesBuf) return flags;
  const root = parseXml(stylesBuf.toString('utf8'));

  const customFmt = new Map();
  for (const nf of findAll(root, 'numFmt')) {
    const id = Number(nf.attrs.numFmtId);
    if (Number.isFinite(id)) customFmt.set(id, nf.attrs.formatCode || '');
  }

  for (const cellXfs of findAll(root, 'cellXfs')) {
    for (const xf of findAll(cellXfs, 'xf')) {
      const id = Number(xf.attrs.numFmtId || 0);
      const dateLike = DATE_FMT_IDS.has(id) || isDateFormatCode(customFmt.get(id));
      flags.push(dateLike);
    }
  }
  return flags;
}

function buildSharedStrings(sstBuf) {
  if (!sstBuf) return [];
  const root = parseXml(sstBuf.toString('utf8'));
  return findAll(root, 'si').map((si) => collectT(si));
}

/** 找到第一个工作表在 ZIP 里的路径 */
function resolveFirstSheetPath(entries, workbookBuf, relsBuf) {
  if (workbookBuf && relsBuf) {
    try {
      const wb = parseXml(workbookBuf.toString('utf8'));
      const sheet = findAll(wb, 'sheet')[0];
      const rid = sheet && (sheet.attrs['r:id'] || sheet.attrs.id);
      if (rid) {
        const rels = parseXml(relsBuf.toString('utf8'));
        for (const rel of findAll(rels, 'Relationship')) {
          if (rel.attrs.Id !== rid) continue;
          let target = (rel.attrs.Target || '').replace(/^\/+/, '');
          if (!target.startsWith('xl/')) target = 'xl/' + target;
          if (entries.has(target)) return target;
        }
      }
    } catch (e) { /* 落到下面的兜底 */ }
  }
  // 兜底：按文件名里的数字顺序取第一个 sheet
  const sheets = [...entries.keys()]
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]));
  return sheets[0] || null;
}

/**
 * 读 xlsx，返回二维数组。
 * @param {Buffer} buf 原始文件字节
 * @returns {{ rows: Array<Array<string|number|null>>, sheetName: string }}
 */
function readXlsx(buf) {
  const entries = readZipDirectory(buf);
  const sheetPath = resolveFirstSheetPath(
    entries,
    readZipEntry(buf, entries, 'xl/workbook.xml'),
    readZipEntry(buf, entries, 'xl/_rels/workbook.xml.rels'),
  );
  if (!sheetPath) throw new Error('xlsx 里找不到工作表');

  const sheetBuf = readZipEntry(buf, entries, sheetPath);
  if (!sheetBuf) throw new Error('工作表内容读取失败：' + sheetPath);

  const shared = buildSharedStrings(readZipEntry(buf, entries, 'xl/sharedStrings.xml'));
  const styleFlags = buildStyleFlags(readZipEntry(buf, entries, 'xl/styles.xml'));

  const root = parseXml(sheetBuf.toString('utf8'));
  const sheetData = findAll(root, 'sheetData')[0];
  if (!sheetData) return { rows: [], sheetName: '' };

  const rows = [];
  let maxWidth = 0;

  for (const rowNode of sheetData.children) {
    if (rowNode.name !== 'row') continue;
    const rAttr = Number(rowNode.attrs.r);
    const rowIndex = Number.isFinite(rAttr) && rAttr > 0 ? rAttr - 1 : rows.length;
    const cells = [];

    for (const c of rowNode.children) {
      if (c.name !== 'c') continue;
      const ref = c.attrs.r || '';
      const letters = (ref.match(/^[A-Z]+/i) || [''])[0].toUpperCase();
      const ci = letters ? colToIndex(letters) : cells.length;
      const t = c.attrs.t || '';
      const sRaw = c.attrs.s;
      const styleIndex = sRaw === undefined ? -1 : Number(sRaw);

      let value = null;
      const vNode = firstChild(c, 'v');
      const rawV = vNode ? (vNode.text || '') : '';

      if (t === 's') {
        const idx = Number(rawV);
        value = Number.isFinite(idx) ? (shared[idx] !== undefined ? shared[idx] : '') : '';
      } else if (t === 'inlineStr') {
        const isNode = firstChild(c, 'is');
        value = isNode ? collectT(isNode) : rawV;
      } else if (t === 'str') {
        value = rawV;
      } else if (t === 'b') {
        value = rawV === '1' ? 'TRUE' : 'FALSE';
      } else if (t === 'e') {
        value = null; // 公式错误值，按空处理
      } else if (rawV !== '') {
        const num = Number(rawV);
        if (Number.isFinite(num)) {
          value = styleIndex >= 0 && styleFlags[styleIndex] ? serialToDay(num) : num;
          if (value === null) value = num;
        } else {
          value = rawV;
        }
      }

      // 空单元格也占位，保证列对齐
      while (cells.length < ci) cells.push(null);
      cells[ci] = value === '' ? null : value;
      if (cells.length > maxWidth) maxWidth = cells.length;
    }

    rows[rowIndex] = cells;
  }

  // 补齐空洞并统一宽度
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || [];
    while (r.length < maxWidth) r.push(null);
    out.push(r);
  }
  return { rows: out, sheetName: '' };
}

// ---------------------------------------------------------------- CSV

/** 解析 CSV 文本（支持引号包裹、引号内换行、双引号转义） */
function parseCsv(text) {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // 去 BOM
  const rows = [];
  let row = [];
  let field = '';
  let inQuote = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuote) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuote = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuote = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') { continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  return rows.map((r) => r.map((v) => {
    const t = v.trim();
    return t === '' ? null : t;
  }));
}

// ---------------------------------------------------------------- 统一入口

/**
 * 按文件内容自动识别格式并读成二维数组。
 * 通过文件头魔数判断，不依赖扩展名（用户改过扩展名也能读）。
 */
function readTable(buffer) {
  if (!buffer || !buffer.length) throw new Error('文件内容为空');
  const head = buffer.subarray(0, 4);
  const isZip = head[0] === 0x50 && head[1] === 0x4b;

  if (isZip) {
    const res = readXlsx(buffer);
    return res.rows;
  }

  // Excel 97-2003 的 OLE 复合文档头 D0 CF 11 E0
  if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) {
    throw new Error('不支持旧版 .xls，请在 Excel 里另存为 .xlsx 后再上传');
  }

  const text = buffer.toString('utf8');
  if (text.indexOf('\u0000') >= 0) {
    throw new Error('无法识别的文件格式，请上传 .xlsx 或 .csv');
  }
  return parseCsv(text);
}

module.exports = { readTable, readXlsx, parseCsv, serialToDay, colToIndex, parseXml };
