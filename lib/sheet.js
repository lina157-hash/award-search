// Spreadsheet files as rows of text, for government statistics published as XLSX or ODS instead of CSV (民航局's
// 載客率 file, lib/flightdata.js). No package: a ZIP reader over Node's zlib and a plain scan of the sheet XML.
// Every sheet in order, one after another (a title row between tables is kept as a row). Cell values only — no
// formulas, styles or merged-cell spreading.
const zlib = require('zlib');

const isZip = (b) => b && b[0] === 0x50 && b[1] === 0x4b;

// { name: Buffer } for the entries `want(name)` keeps.
function unzip(buf, want = () => true) {
  const b = Buffer.from(buf.buffer ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) : buf);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('ZIP 檔不完整');
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  const out = {};
  for (let n = 0; n < count; n++) {
    if (b.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP 目錄讀不懂');
    const method = b.readUInt16LE(p + 10);
    const size = b.readUInt32LE(p + 20);
    const nameLen = b.readUInt16LE(p + 28);
    const extra = b.readUInt16LE(p + 30);
    const comment = b.readUInt16LE(p + 32);
    const local = b.readUInt32LE(p + 42);
    const name = b.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extra + comment;
    if (!want(name)) continue;
    const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    const data = b.subarray(start, start + size);
    out[name] = method === 0 ? data : method === 8 ? zlib.inflateRawSync(data) : null;
    if (!out[name]) throw new Error(`ZIP 壓縮方式 ${method} 不支援`);
  }
  return out;
}

const unxml = (s) => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d))).replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, '&');
const colIndex = (ref) => { let n = 0; for (const ch of /^[A-Z]+/.exec(ref)?.[0] || '') n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };

function xlsxRows(files) {
  const shared = [];
  const ss = files['xl/sharedStrings.xml']?.toString('utf8') || '';
  for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(unxml((m[1].match(/<t[^>]*>[\s\S]*?<\/t>/g) || []).join('')));
  const sheets = Object.keys(files).filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort((a, b) => Number(/(\d+)\.xml$/.exec(a)[1]) - Number(/(\d+)\.xml$/.exec(b)[1]));
  const rows = [];
  for (const k of sheets) {
    const xml = files[k].toString('utf8');
    for (const r of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const row = [];
      for (const c of r[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const at = c[1];
        const ref = /r="([A-Z]+)\d+"/.exec(at)?.[1];
        const t = /t="([^"]+)"/.exec(at)?.[1];
        const body = c[2] || '';
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        const val = t === 's' ? shared[Number(v)] ?? '' : t === 'inlineStr' ? unxml(/<is>([\s\S]*?)<\/is>/.exec(body)?.[1] || '') : unxml(v ?? '');
        row[ref ? colIndex(ref) : row.length] = val;
      }
      rows.push(Array.from(row, (x) => (x ?? '').trim()));
    }
  }
  return rows;
}

function odsRows(files) {
  const xml = files['content.xml']?.toString('utf8') || '';
  const rows = [];
  for (const r of xml.matchAll(/<table:table-row([^>]*?)(?:\/>|>([\s\S]*?)<\/table:table-row>)/g)) {
    const row = [];
    for (const c of (r[2] || '').matchAll(/<table:(?:covered-)?table-cell([^>]*?)(?:\/>|>([\s\S]*?)<\/table:(?:covered-)?table-cell>)/g)) {
      const rep = Number(/table:number-columns-repeated="(\d+)"/.exec(c[1])?.[1] || 1);
      const text = (c[2] || '').match(/<text:p[^>]*>[\s\S]*?<\/text:p>|<text:p[^>]*\/>/g)?.map(unxml).join(' ') || '';
      const val = text || /office:value="([^"]*)"/.exec(c[1])?.[1] || '';
      // An empty cell repeated to the sheet's edge (thousands) counts once.
      for (let i = 0; i < (val ? Math.min(rep, 200) : Math.min(rep, 1)); i++) row.push(val.trim());
    }
    if (row.some(Boolean)) rows.push(row);
  }
  return rows;
}

// rows: [[cell text]], blank rows dropped. Throws on a ZIP that is neither XLSX nor ODS.
function readSheet(buf) {
  if (!isZip(buf)) throw new Error('不是 XLSX／ODS 檔');
  const files = unzip(buf, (n) => n === 'content.xml' || n === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  const rows = files['content.xml'] ? odsRows(files) : xlsxRows(files);
  if (!files['content.xml'] && !Object.keys(files).some((k) => k.startsWith('xl/worksheets/'))) throw new Error('ZIP 裡沒有試算表');
  return rows.filter((r) => r.some(Boolean));
}

module.exports = { readSheet, isZip, unzip };
