// 國泰官網實查: the owner's own Cathay (Asia Miles) award calendar, read by the 國泰哩程日曆 bookmarklet (from Cathay's
// page or the Unelevated userscript's results) and uploaded here, so a route search can show real Cathay availability.
// Everything lives under cxcal:v1:* with a TTL; demo mode keeps it in memory. Spends no paid quota.
const P = 'cxcal:v1:';
const ROUTE_TTL = 21 * 86400;
const ROUTE_MAX_BYTES = 64 * 1024;
const MAX_ROUTES = 50;
const MAX_DAYS = 400;
const MAX_FLIGHTS = 20;
const CABINS = ['Y', 'W', 'J', 'F'];

class CxcalError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; this.code = 'cxcal'; }
}
const bad = (m) => { throw new CxcalError(m); };
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);
const code = (s) => String(s || '').trim().toUpperCase();
const isCode = (s) => /^[A-Z]{3}$/.test(s);
const text = (s, n) => String(s ?? '').replace(/[<>]/g, '').trim().slice(0, n);
const int = (v, max) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= 0 && n <= max ? n : null; };
const onlyKeys = (o, allowed, where) => { for (const k of Object.keys(o)) if (!allowed.includes(k)) bad(`${where}有不認識的欄位「${text(k, 20)}」`); };

// Seats per cabin as 外掛模式 reads them from the Unelevated userscript's chips: { J: 3, Y: 9 } (9 = 9 or more).
function cleanSeats(q, where) {
  if (!isObj(q)) bad(`${where}的座位數格式不對`);
  onlyKeys(q, CABINS, `${where} 座位數`);
  const o = {};
  for (const c of CABINS) if (q[c] != null) { const n = int(q[c], 99); if (n == null) bad(`${where}的座位數要是 0–99`); o[c] = n; }
  return o;
}

// One flight as the bookmarklet or runner records it: { n, d, a, p, s, m, x?, du?, q? }; or, from 外掛模式, a chip
// { n, p, s, q: { J: 3, Y: 9 } } without times or miles (kept that small so 20 days fit the size cap).
function cleanFlight(f, where) {
  if (!isObj(f)) bad(`${where}的航班格式不對`);
  onlyKeys(f, ['n', 'd', 'a', 'p', 's', 'm', 'x', 'du', 'q', 'mc'], where);
  if (isObj(f.q)) {
    if (f.d != null || f.a != null || f.m != null) bad(`${where}的航班格式不對`);
    return { n: text(f.n, 40), p: text(f.p, 40), s: int(f.s, 9) ?? 0, q: cleanSeats(f.q, where) };
  }
  const o = { n: text(f.n, 40), d: text(f.d, 8), a: text(f.a, 8), p: text(f.p, 40), s: int(f.s, 9) ?? 0, m: int(f.m, 9_999_999) ?? 0 };
  if (f.x != null) o.x = text(f.x, 4);
  if (f.du != null) o.du = text(f.du, 20);
  if (f.q != null) o.q = int(f.q, 99) ?? 0;
  return o;
}

// One day: { na?: 1, lo?: miles, c?: { Y|W|J|F: { m, na?, f?: [flights], t?, seats?, n?, nonstop? } } }; seats (most
// on one flight), n (flights with this cabin) and nonstop come from 外掛模式. Unknown fields are refused.
function cleanDay(d, where) {
  if (!isObj(d)) bad(`${where}的資料格式不對`);
  onlyKeys(d, ['na', 'lo', 'c'], where);
  const o = {};
  if (d.na) o.na = 1;
  if (d.lo != null) { const lo = int(d.lo, 9_999_999); if (lo) o.lo = lo; }
  if (d.c != null) {
    if (!isObj(d.c)) bad(`${where}的艙等格式不對`);
    onlyKeys(d.c, CABINS, where + ' 艙等');
    o.c = {};
    for (const k of Object.keys(d.c)) {
      const x = d.c[k];
      if (!isObj(x)) bad(`${where} ${k} 艙的格式不對`);
      onlyKeys(x, ['m', 'na', 'f', 't', 'seats', 'n', 'nonstop'], `${where} ${k} 艙`);
      const c = { m: int(x.m, 9_999_999) ?? 0 };
      if (x.na) c.na = 1;
      if (x.seats != null) { c.seats = int(x.seats, 99); if (c.seats == null) bad(`${where} ${k} 艙的座位數要是 0–99`); }
      if (x.n != null) { c.n = int(x.n, 999); if (c.n == null) bad(`${where} ${k} 艙的航班數不對`); }
      if (x.nonstop != null) c.nonstop = Boolean(x.nonstop);
      if (x.f != null) { if (!Array.isArray(x.f)) bad(`${where} ${k} 艙的航班要是陣列`); c.f = x.f.slice(0, MAX_FLIGHTS).map((f) => cleanFlight(f, `${where} ${k} 艙`)); }
      if (x.t != null) c.t = int(x.t, 4e12) ?? 0;
      o.c[k] = c;
    }
  }
  return o;
}

// The upload body → the stored record, or a CxcalError saying what is wrong.
function validatePayload(body) {
  if (!isObj(body)) bad('內容格式不對');
  onlyKeys(body, ['v', 'from', 'to', 'fc', 'tc', 'at', 'days', 'source', 'cabins', 'pax', 'range'], '內容');
  if (body.v != null && Number(body.v) !== 1) bad('不支援的版本');
  const fc = code(body.fc);
  const tc = code(body.tc);
  if (!isCode(fc) || !isCode(tc) || fc === tc) bad('機場代碼要是 3 個英文字母（fc、tc）');
  if (!isObj(body.days)) bad('days 要是以日期為鍵的物件');
  const keys = Object.keys(body.days);
  if (!keys.length) bad('沒有任何日期');
  if (keys.length > MAX_DAYS) bad(`日期太多（最多 ${MAX_DAYS} 天）`);
  const days = {};
  for (const k of keys.sort()) {
    if (!isDate(k)) bad(`日期「${text(k, 12)}」格式不對`);
    const d = cleanDay(body.days[k], k);
    if (Object.keys(d).length) days[k] = d;
  }
  const source = body.source == null ? 'runner' : String(body.source);
  if (!['runner', 'bookmarklet', 'unelevated'].includes(source)) bad('source 只能是 runner、bookmarklet 或 unelevated');
  const out = { v: 1, from: text(body.from, 40), to: text(body.to, 40), fc, tc, at: int(body.at, 4e12) ?? 0, days, source };
  if (body.cabins != null) {
    if (!Array.isArray(body.cabins) || body.cabins.some((c) => !CABINS.includes(c))) bad('cabins 只能是 Y、W、J、F');
    out.cabins = [...new Set(body.cabins)];
  }
  if (body.pax != null) out.pax = int(body.pax, 9) || 1;
  if (body.range != null) {
    if (!isObj(body.range) || !isDate(String(body.range.from)) || !isDate(String(body.range.to))) bad('range 要有 from、to 兩個日期');
    out.range = { from: body.range.from, to: body.range.to };
  }
  const size = Buffer.byteLength(JSON.stringify(out));
  if (size > ROUTE_MAX_BYTES) bad(`資料太大（${Math.round(size / 1024)} KB，上限 ${ROUTE_MAX_BYTES / 1024} KB）`);
  return out;
}

function createCxcalStore({ kv, now = () => Date.now() }) {
  const rkey = (fc, tc) => `${P}${fc}>${tc}`;
  const idx = async () => (await kv.get(P + 'routes').catch(() => null)) || [];

  async function save(body) {
    const rec = validatePayload(body);
    const key = rkey(rec.fc, rec.tc);
    const list = await idx();
    const id = `${rec.fc}>${rec.tc}`;
    if (!list.includes(id)) {
      if (list.length >= MAX_ROUTES) bad(`最多保存 ${MAX_ROUTES} 條航線，請先刪掉舊的`);
      list.push(id);
      await kv.set(P + 'routes', list, { ex: ROUTE_TTL });
    }
    rec.savedAt = new Date(now()).toISOString();
    await kv.set(key, rec, { ex: ROUTE_TTL });
    return { ok: true, fc: rec.fc, tc: rec.tc, days: Object.keys(rec.days).length, savedAt: rec.savedAt };
  }

  // Every stored pair among the origin and destination codes given ("TPE,TSA", "NRT,HND"), most recent first.
  async function find(origin, destination) {
    const os = [...new Set(String(origin || '').toUpperCase().split(/[,\s]+/).filter(isCode))].slice(0, 6);
    const ds = [...new Set(String(destination || '').toUpperCase().split(/[,\s]+/).filter(isCode))].slice(0, 6);
    const out = [];
    for (const o of os) for (const d of ds) {
      const r = await kv.get(rkey(o, d)).catch(() => null);
      if (r) out.push(r);
    }
    return out.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
  }

  return { save, find, validatePayload };
}

module.exports = { createCxcalStore, validatePayload, CxcalError, ROUTE_MAX_BYTES, MAX_ROUTES };
