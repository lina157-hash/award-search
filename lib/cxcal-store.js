// 國泰官網實查: the owner's own Cathay (Asia Miles) award calendar, read by the 國泰哩程日曆 bookmarklet (from Cathay's
// page or the Unelevated userscript's results) and uploaded here, so a route search can show real Cathay availability.
// Everything lives under cxcal:v1:* with a TTL; demo mode keeps it in memory. Spends no paid quota.
// Since 「請 AI 助理查官網」 covers more airlines, a record may carry `air` (an id of data/muse-templates.json): Cathay
// keeps the old key cxcal:v1:TPE>NRT (records without `air` are Cathay), the others use cxcal:v1:ci:TPE>NRT.
const { getMany } = require('./kv');

const P = 'cxcal:v1:';
const AIRS = require('../data/muse-templates.json').airlines.map((a) => a.id);
const STATUS = ['p', 'l', 's', 'w']; // 充足, 有限, 稀少, 候補 (plain 有位／無位 carry no st)
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

// One flight as the bookmarklet records it: { n, d, a, p, s, m, x?, du?, q? }; or, from 外掛模式, a chip
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

// One day: { na?: 1, lo?: miles, c?: { Y|W|J|F: { m, na?, f?: [flights], t?, seats?, n?, nonstop?, st? } } }; seats
// (most on one flight), n (flights with this cabin) and nonstop come from 外掛模式, st (p/l/s/w) from the AI
// assistant's 充足／有限／稀少／候補. Unknown fields are refused.
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
      onlyKeys(x, ['m', 'na', 'f', 't', 'seats', 'n', 'nonstop', 'st'], `${where} ${k} 艙`);
      const c = { m: int(x.m, 9_999_999) ?? 0 };
      if (x.na) c.na = 1;
      if (x.seats != null) { c.seats = int(x.seats, 99); if (c.seats == null) bad(`${where} ${k} 艙的座位數要是 0–99`); }
      if (x.n != null) { c.n = int(x.n, 999); if (c.n == null) bad(`${where} ${k} 艙的航班數不對`); }
      if (x.nonstop != null) c.nonstop = Boolean(x.nonstop);
      if (x.f != null) { if (!Array.isArray(x.f)) bad(`${where} ${k} 艙的航班要是陣列`); c.f = x.f.slice(0, MAX_FLIGHTS).map((f) => cleanFlight(f, `${where} ${k} 艙`)); }
      if (x.t != null) c.t = int(x.t, 4e12) ?? 0;
      if (x.st != null) { if (!STATUS.includes(x.st)) bad(`${where} ${k} 艙的狀態只能是 p、l、s、w`); c.st = x.st; }
      o.c[k] = c;
    }
  }
  return o;
}

// The upload body → the stored record, or a CxcalError saying what is wrong.
function validatePayload(body) {
  if (!isObj(body)) bad('內容格式不對');
  onlyKeys(body, ['v', 'from', 'to', 'fc', 'tc', 'at', 'days', 'source', 'cabins', 'pax', 'range', 'air'], '內容');
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
  const source = body.source == null ? 'bookmarklet' : String(body.source);
  if (!SOURCES.includes(source)) bad('source 只能是 bookmarklet、unelevated 或 ai');
  const air = body.air == null ? 'cx' : String(body.air).trim().toLowerCase();
  if (!AIRS.includes(air)) bad(`air 只能是 ${AIRS.join('、')}`);
  if (air !== 'cx' && source !== 'ai') bad('國泰以外的航空只能由 AI 助理（source ai）儲存');
  const out = { v: 1, from: text(body.from, 40), to: text(body.to, 40), fc, tc, at: int(body.at, 4e12) ?? 0, days, source, air };
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

// The PC runner was removed at the owner's request (2026-10-15); records it uploaded are dropped when read.
const SOURCES = ['bookmarklet', 'unelevated', 'ai'];

// The index id and the record key of one airline's route: Cathay keeps its old "TPE>NRT".
const routeId = (air, fc, tc) => `${air && air !== 'cx' ? `${air}:` : ''}${fc}>${tc}`;

function createCxcalStore({ kv, now = () => Date.now() }) {
  const rkey = (air, fc, tc) => P + routeId(air, fc, tc);
  const idx = async () => (await kv.get(P + 'routes').catch(() => null)) || [];

  async function save(body) {
    const rec = validatePayload(body);
    let list = await idx();
    const id = routeId(rec.air, rec.fc, rec.tc);
    if (!list.includes(id)) {
      // Full: first drop the ids whose record has expired.
      if (list.length >= MAX_ROUTES) {
        const live = await Promise.all(list.map((x) => kv.get(P + x).catch(() => null)));
        list = list.filter((_, i) => live[i]);
      }
      if (list.length >= MAX_ROUTES) bad(`最多保存 ${MAX_ROUTES} 條航線，請先刪掉舊的`);
      list.push(id);
    }
    // The index lives as long as its newest record, so find() can trust it for the other airlines.
    await kv.set(P + 'routes', list, { ex: ROUTE_TTL });
    rec.savedAt = new Date(now()).toISOString();
    await kv.set(rkey(rec.air, rec.fc, rec.tc), rec, { ex: ROUTE_TTL });
    return { ok: true, air: rec.air, fc: rec.fc, tc: rec.tc, days: Object.keys(rec.days).length, savedAt: rec.savedAt };
  }

  // Every stored pair among the origin and destination codes given ("TPE,TSA", "NRT,HND"), of any airline, most
  // recent first. Cathay pairs are read directly (older records may predate the index); the other airlines only when
  // the index lists them.
  async function find(origin, destination) {
    const os = [...new Set(String(origin || '').toUpperCase().split(/[,\s]+/).filter(isCode))].slice(0, 6);
    const ds = [...new Set(String(destination || '').toUpperCase().split(/[,\s]+/).filter(isCode))].slice(0, 6);
    if (!os.length || !ds.length) return [];
    const list = new Set(await idx());
    const keys = [];
    for (const o of os) for (const d of ds) for (const a of AIRS) if (a === 'cx' || list.has(routeId(a, o, d))) keys.push(rkey(a, o, d));
    const got = await getMany(kv, keys).catch(() => keys.map(() => null)); // one MGET, not one GET per pair
    await Promise.all(got.map((r, i) => (r && !SOURCES.includes(r.source) ? kv.del(keys[i]).catch(() => {}) : null)));
    return got.filter((r) => r && SOURCES.includes(r.source)).map((r) => (r.air ? r : { ...r, air: 'cx' })).sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
  }

  return { save, find, validatePayload };
}

module.exports = { createCxcalStore, validatePayload, CxcalError, ROUTE_MAX_BYTES, MAX_ROUTES, AIRS };
