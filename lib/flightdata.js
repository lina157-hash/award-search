// Official flight data for routes touching Taiwan (round 9), fetched about once a week by the daily cron and kept
// compact in the key-value store (lib/kv.js). No quota: every source is free government open data.
//   - Timetable (誰飛直航 with days, times and aircraft; 這天沒有直飛班機 on the calendar; 即將開航):
//     交通部 TDX「國際航空定期時刻表」 /v2/Air/GeneralSchedule/International (data.gov.tw 9973) when TDX_CLIENT_ID and
//     TDX_CLIENT_SECRET are set (a free TDX member key); otherwise 民航局's own CSV of the same dataset plus
//     桃園機場「定期航班」 (data.gov.tw 7869, weekly). The CAA CSV also gives aircraft types, which TDX lacks.
//   - 桃園機場航廈 per airline and flight: 7869's 航廈別 column (or TDX's Terminal).
//   - Load factor per month, route and airline: 民航局 data.gov.tw 47492 (a year behind, updated each January).
// Licence of all three: 政府資料開放授權條款第 1 版 (credit the agency). The CSV layouts were not readable from the
// build container; the parsers find columns by their names (7869's are documented by position), check every row and
// reject a source whose rows mostly fail, so a changed file shows nothing rather than wrong times.
const { todayTW, addDays, validDate } = require('./day');

const URLS = {
  tdxToken: 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token',
  tdxSchedule: 'https://tdx.transportdata.tw/api/basic/v2/Air/GeneralSchedule/International',
  // data.gov.tw's dataset API names the current file; the known file address is the fallback.
  dataset: (id) => `https://data.gov.tw/api/v2/rest/dataset/${id}`,
  caaSchedule: 'https://www.caa.gov.tw/FileAtt.ashx?lang=1&id=16679', // data.gov.tw 9973
  taoyuan: 'https://odp.taoyuan-airport.com/dataset/2022110903?format=csv', // data.gov.tw 7869
  caaLoad: 'https://www.caa.gov.tw/FileAtt.ashx?lang=1&id=30680', // data.gov.tw 47492
};
const SOURCE = {
  tdx: { name: '交通部 TDX', url: 'https://tdx.transportdata.tw/' },
  caa: { name: '交通部民用航空局', url: 'https://data.gov.tw/dataset/9973' },
  ty: { name: '桃園國際機場', url: 'https://data.gov.tw/dataset/7869' },
  lf: { name: '交通部民用航空局', url: 'https://data.gov.tw/dataset/47492' },
};
// Airports in Taiwan with scheduled international or cross-strait flights (and the smaller ones, harmlessly).
const TW = new Set(['TPE', 'TSA', 'KHH', 'RMQ', 'TNN', 'CYI', 'HUN', 'TTT', 'MZG', 'KNH', 'LZN', 'MFK', 'GNI', 'KYD', 'CMJ', 'WOT']);
const KEY = { meta: 'tt:v1:meta', rows: 'tt:v1:rows', term: 'tt:v1:term', fresh: 'tt:v1:new', seen: 'tt:v1:seen', lf: 'tt:v1:lf', tried: 'tt:v1:tried' };
const DAY = 864e5;

// ---------- small parsers ----------
// UTF-8 (with or without BOM) or Big5, which older government CSVs use. Binary spreadsheets are refused.
function decodeText(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (b[0] === 0x50 && b[1] === 0x4b) throw new Error('檔案是 ZIP／XLSX，不是 CSV');
  if (b[0] === 0xd0 && b[1] === 0xcf) throw new Error('檔案是 XLS，不是 CSV');
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder('utf-8').decode(b.subarray(3));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { /* not UTF-8 */ }
  try { return new TextDecoder('big5').decode(b); } catch { return new TextDecoder('utf-8').decode(b); }
}
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') cell += text[++i];
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) rows.push([...row, cell.replace(/\r$/, '')]);
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some(Boolean));
}
const normHead = (s) => String(s || '').replace(/^﻿/, '').replace(/[\s_()（）]/g, '').replace(/臺/g, '台').toLowerCase();
// 2026/03/28, 2026-03-28, 20260328 or ROC 115/03/28 → 2026-03-28.
function parseDate(s) {
  const t = String(s || '').trim();
  let m = /^(\d{2,4})[/.-](\d{1,2})[/.-](\d{1,2})/.exec(t) || /^(\d{4})(\d{2})(\d{2})$/.exec(t);
  if (!m) return '';
  let y = Number(m[1]);
  if (y < 1000) y += 1911;
  const iso = `${y}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  return validDate(iso) ? iso : '';
}
// 23:50, 2350, 6:35+1 (TDX marks the next day with +1) → { t: '23:50', plus: 1 }.
function parseTime(s) {
  const m = /^(\d{1,2}):?(\d{2})(?::\d{2})?\s*(?:\(?([+-]\d)\)?)?$/.exec(String(s || '').trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return { t: `${m[1].padStart(2, '0')}:${m[2]}`, plus: m[3] ? Number(m[3]) : 0 };
}
// BR016, BR 16, 0016 (with the airline apart) → BR16.
function normFlight(al, no) {
  const a = String(al || '').trim().toUpperCase();
  let n = String(no || '').trim().toUpperCase().replace(/\s+/g, '');
  if (a && n.startsWith(a)) n = n.slice(a.length);
  const m = /^0*(\d{1,4})([A-Z]?)$/.exec(n);
  return /^[A-Z0-9]{2}$/.test(a) && m ? `${a}${Number(m[1])}${m[2]}` : '';
}
const IATA = /^[A-Z]{3}$/;
// Weekdays as a bit mask, Monday = bit 0 … Sunday = bit 6.
const ALL_DAYS = 127;
const dowMon0 = (iso) => (new Date(iso + 'T00:00:00Z').getUTCDay() + 6) % 7;
const rotate = (mask, k) => { const s = ((k % 7) + 7) % 7; return ((mask << s) | (mask >> (7 - s))) & ALL_DAYS; };
// '1030507', '1,3,5', '135' or '每日': digits 1–7 present are the days flown.
function parseDays(s) {
  const t = String(s || '');
  if (/每日|daily/i.test(t)) return ALL_DAYS;
  let mask = 0;
  for (const ch of t) if (ch >= '1' && ch <= '7') mask |= 1 << (Number(ch) - 1);
  return mask;
}
const truthy = (v) => v === true || /^(true|y|yes|1|v|✓|○|o|x|\*)$/i.test(String(v ?? '').trim());

// UTC offset (minutes) of an IANA zone on a date, via Intl (no zone data bundled).
const dtfCache = new Map();
function tzOffset(tz, iso) {
  if (!tz) return null;
  try {
    let f = dtfCache.get(tz);
    if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }); dtfCache.set(tz, f); }
    const at = Date.parse(`${iso}T12:00:00Z`);
    const p = Object.fromEntries(f.formatToParts(new Date(at)).map((x) => [x.type, x.value]));
    return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute) - at) / 60000);
  } catch { return null; }
}
const mins = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
// Days between the local departure and the local arrival (−1…2) that give a believable flight time (20 min–20 h),
// or null when the zones are unknown.
function arrivalDays(o, d, dep, arr, iso, tzOf) {
  const a = tzOffset(tzOf(o), iso);
  const b = tzOffset(tzOf(d), iso);
  if (a == null || b == null) return null;
  for (const k of [0, 1, -1, 2]) {
    const flown = mins(arr) - b + k * 1440 - (mins(dep) - a);
    if (flown >= 20 && flown <= 1200) return k;
  }
  return null;
}

// ---------- sources ----------
// A normalized row: { fn, o, d, dep, arr, ad (arrival day offset or null), days (mask), from, to, ac, t (TPE terminal), cs: [] }.
function checkRow(r) {
  return r.fn && IATA.test(r.o) && IATA.test(r.d) && r.o !== r.d && (TW.has(r.o) || TW.has(r.d)) && r.from && r.to && r.to >= r.from && r.days > 0 && r.dep && r.arr;
}

// TDX GeneralFlightSchedule: AirlineID, FlightNumber (with the airline, 2-digit numbers padded), Departure/ArrivalAirportID,
// Departure/ArrivalTime ('HH:mm', '+1' for the next day), ScheduleStart/EndDate, Monday…Sunday, Terminal, CodeShare.
const DAY_KEYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
function parseTdx(list) {
  const rows = [];
  let total = 0;
  for (const x of Array.isArray(list) ? list : []) {
    total++;
    const dep = parseTime(x.DepartureTime);
    const arr = parseTime(x.ArrivalTime);
    const r = {
      fn: normFlight(x.AirlineID, x.FlightNumber), o: String(x.DepartureAirportID || '').toUpperCase(), d: String(x.ArrivalAirportID || '').toUpperCase(),
      dep: dep?.t, arr: arr?.t, ad: arr ? arr.plus - (dep?.plus || 0) : null,
      days: DAY_KEYS.reduce((m, k, i) => (x[k] === true || truthy(x[k]) ? m | (1 << i) : m), 0),
      from: parseDate(x.ScheduleStartDate), to: parseDate(x.ScheduleEndDate), ac: '',
      t: /^[1-3]$/.test(String(x.Terminal || '').replace(/\D/g, '')) ? String(x.Terminal).replace(/\D/g, '') : '',
      cs: (Array.isArray(x.CodeShare) ? x.CodeShare : []).map((c) => normFlight(c.AirlineID, c.FlightNumber)).filter(Boolean),
    };
    if (checkRow(r)) rows.push(r);
  }
  return { rows, total };
}

// 桃園機場 7869, by position (data.gov.tw's field notes): 1 PA/PD/CA/CD, 2 airline, 3 flight, 4 scheduled departure,
// 5 the other airport, 6 scheduled arrival, 7–18 unused, 19 terminal (1/2), 20 weekdays at TPE ('1030507'),
// 21–22 valid from/to (yyyy/mm/dd). Passenger rows only. An arrival's weekdays and dates are TPE's; they are moved
// to the departure day when the zones say the flight left the day before.
function parseTaoyuan(text, { tzOf = () => '' } = {}) {
  const lines = parseCsv(text);
  const rows = [];
  let total = 0;
  let sample = null;
  for (const c of lines) {
    const kind = String(c[0] || '').toUpperCase();
    if (!/^(PA|PD|CA|CD)$/.test(kind)) continue; // a header row, or something else
    if (kind[0] === 'C') continue;
    total++;
    sample ||= c;
    const dep = parseTime(c[3]);
    const arr = parseTime(c[5]);
    const other = String(c[4] || '').toUpperCase();
    const out = kind === 'PD';
    const r = {
      fn: normFlight(c[1], c[2]), o: out ? 'TPE' : other, d: out ? other : 'TPE', dep: dep?.t, arr: arr?.t, ad: null,
      days: parseDays(c[19]), from: parseDate(c[20]), to: parseDate(c[21]), ac: '', t: /^[12]$/.test(c[18] || '') ? c[18] : '', cs: [],
    };
    if (r.dep && r.arr && IATA.test(r.o) && IATA.test(r.d)) {
      r.ad = arrivalDays(r.o, r.d, r.dep, r.arr, r.from || todayTW(), tzOf);
      if (!out && r.ad) {
        r.days = rotate(r.days, -r.ad);
        r.from = r.from && addDays(r.from, -r.ad);
        r.to = r.to && addDays(r.to, -r.ad);
      }
    }
    if (checkRow(r)) rows.push(r);
  }
  return { rows, total, head: preview(lines[0]), sample: preview(sample) };
}

// Columns found by name, for the CSVs whose header was not readable from here (民航局 9973 and 47492).
function findCols(head, spec) {
  const h = head.map(normHead);
  const out = {};
  for (const [k, re, not] of spec) {
    const i = h.findIndex((x, j) => re.test(x) && !(not && not.test(x)) && !Object.values(out).includes(j));
    if (i >= 0) out[k] = i;
  }
  return out;
}
// A row as text for the status page when a file cannot be read (its columns and first row show what changed).
const preview = (cells) => (cells || []).map((x) => String(x ?? '').trim()).join('|').slice(0, 300);
const SKIP = /經停|中停|轉機|transit|via|次要|備用|2$|3$|4$|5$/;
const SCHED_COLS = [
  ['al', /^航空公司(代碼|代號|iata)?$|^airline(id|code)?$|^航空$/],
  ['fn', /班(機)?號|班次|flight(no|number)?$/, /共用|codeshare/],
  ['cs', /共用|codeshare/],
  ['o', /^(起飛|出發|起點|起程)(機場|航站|站)?(代碼|代號)?$|^departureairport|^起站$|^起點$/, SKIP],
  ['dep', /^(起飛|出發|離站|預定起飛)時間$|^departuretime$|^起飛$/, SKIP],
  ['d', /^(抵達|到達|目的|終點|迄)(機場|航站|站|地)?(代碼|代號)?$|^arrivalairport|^迄站$|^到站$/, SKIP],
  ['arr', /^(抵達|到達|預定抵達)時間$|^arrivaltime$|^抵達$/, SKIP],
  ['from', /開始|起始|生效|起日|起期|startdate|^start$|^from$/, /時間|time/],
  ['to', /結束|終止|截止|失效|迄日|止日|迄期|enddate|^end$|^to$/, /時間|time/],
  ['days', /星期|班期|週別|weekday|^days?$|^dow$/],
  ['ac', /^(主要)?機型1?$|^aircraft(type)?1?$|^機種$/, SKIP],
];
const WEEK_COLS = [['w0', /^(星期|週)?(一|1|mon)/], ['w1', /^(星期|週)?(二|2|tue)/], ['w2', /^(星期|週)?(三|3|wed)/], ['w3', /^(星期|週)?(四|4|thu)/], ['w4', /^(星期|週)?(五|5|fri)/], ['w5', /^(星期|週)?(六|6|sat)/], ['w6', /^(星期|週)?(日|天|7|sun)/]];
function parseCaaSchedule(text, { tzOf = () => '' } = {}) {
  const lines = parseCsv(text);
  const hi = lines.findIndex((r) => { const c = findCols(r, SCHED_COLS); return c.fn != null && c.o != null && c.d != null; });
  if (hi < 0) throw new Error(`找不到欄位名稱（航班、起訖機場）｜開頭：${preview(lines[0])}｜${preview(lines[1])}`);
  const head = lines[hi];
  const c = findCols(head, SCHED_COLS);
  const w = c.days == null ? findCols(head, WEEK_COLS) : {};
  const rows = [];
  let total = 0;
  for (const x of lines.slice(hi + 1)) {
    total++;
    const al = c.al != null ? x[c.al] : '';
    const dep = parseTime(x[c.dep]);
    const arr = parseTime(x[c.arr]);
    const days = c.days != null ? parseDays(x[c.days]) : WEEK_COLS.reduce((m, [k], i) => (w[k] != null && truthy(x[w[k]]) ? m | (1 << i) : m), 0);
    const r = {
      fn: normFlight(al || String(x[c.fn] || '').slice(0, 2), x[c.fn]), o: String(x[c.o] || '').toUpperCase(), d: String(x[c.d] || '').toUpperCase(),
      dep: dep?.t, arr: arr?.t, ad: arr?.plus || null, days, from: parseDate(x[c.from]), to: parseDate(x[c.to]),
      ac: c.ac != null ? String(x[c.ac] || '').slice(0, 12) : '', t: '',
      cs: c.cs != null ? String(x[c.cs] || '').split(/[\s,;/、|]+/).map((s) => normFlight(s.slice(0, 2), s)).filter(Boolean) : [],
    };
    if (r.dep && r.arr && !arr.plus && IATA.test(r.o) && IATA.test(r.d)) r.ad = arrivalDays(r.o, r.d, r.dep, r.arr, r.from || todayTW(), tzOf);
    if (checkRow(r)) rows.push(r);
  }
  return { rows, total, columns: Object.keys(c), head: preview(head), sample: preview(lines[hi + 1]) };
}

// ---------- the merged timetable ----------
// Drops rows that ended before `today`, codeshare copies of an operated flight, and exact repeats; joins periods of
// the same flight that follow on with the same days and times.
function mergeRows(rows, today) {
  const operated = new Map();
  for (const r of rows) for (const cs of r.cs) operated.set(`${cs}|${r.o}|${r.d}`, r.fn);
  const keep = rows.filter((r) => r.to >= today && !(operated.get(`${r.fn}|${r.o}|${r.d}`) && operated.get(`${r.fn}|${r.o}|${r.d}`) !== r.fn));
  const groups = new Map();
  for (const r of keep) {
    const k = [r.fn, r.o, r.d, r.dep, r.arr, r.ad, r.days].join('|');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = [];
  for (const list of groups.values()) {
    list.sort((a, b) => a.from.localeCompare(b.from));
    let cur = null;
    for (const r of list) {
      if (cur && r.from <= addDays(cur.to, 1)) {
        if (r.to > cur.to) cur.to = r.to;
        cur.cs = [...new Set([...cur.cs, ...r.cs])];
        cur.ac ||= r.ac;
        cur.t ||= r.t;
      } else { cur = { ...r, cs: [...r.cs] }; out.push(cur); }
    }
  }
  return out.sort((a, b) => a.o.localeCompare(b.o) || a.d.localeCompare(b.d) || a.dep.localeCompare(b.dep) || a.fn.localeCompare(b.fn) || a.from.localeCompare(b.from));
}
// Aircraft types from another source, by flight and route (the most common one).
function addAircraft(rows, extra) {
  const by = new Map();
  for (const r of extra) {
    if (!r.ac) continue;
    const k = `${r.fn}|${r.o}|${r.d}`;
    const m = by.get(k) || new Map();
    m.set(r.ac, (m.get(r.ac) || 0) + 1);
    by.set(k, m);
  }
  for (const r of rows) {
    const m = !r.ac && by.get(`${r.fn}|${r.o}|${r.d}`);
    if (m) r.ac = [...m].sort((a, b) => b[1] - a[1])[0][0];
  }
  return rows;
}
// TPE terminals: per airline (the one most of its flights use) and the flights that differ from it.
function buildTerminals(rows) {
  const per = new Map();
  const fl = new Map();
  for (const r of rows) {
    if (!r.t || (r.o !== 'TPE' && r.d !== 'TPE')) continue;
    const al = r.fn.slice(0, 2);
    const m = per.get(al) || new Map();
    m.set(r.t, (m.get(r.t) || 0) + 1);
    per.set(al, m);
    fl.set(r.fn, r.t);
  }
  const airlines = Object.fromEntries([...per].map(([al, m]) => [al, [...m].sort((a, b) => b[1] - a[1])[0][0]]));
  const flights = Object.fromEntries([...fl].filter(([fn, t]) => airlines[fn.slice(0, 2)] !== t));
  return { airlines, flights };
}
// Routes from Taiwan whose first flight is still ahead: { o, d, first, airlines, kind: 'new' | 'resume' | 'soon' }.
// 'resume': the same pair ran before (an ended period in this file, or seen by an earlier refresh); 'new': a year of
// refreshes never saw it; 'soon': too little history to tell. seen: { since, pairs: { 'TPE-NRT': lastSeen } }.
function upcomingRoutes(allRows, rows, seen, today, { horizonDays = 180 } = {}) {
  const pairs = new Map();
  for (const r of rows) {
    if (!TW.has(r.o) || TW.has(r.d)) continue;
    const k = `${r.o}-${r.d}`;
    const p = pairs.get(k) || { o: r.o, d: r.d, first: '9999', active: false, airlines: new Set() };
    if (r.from <= today) p.active = true;
    if (r.from < p.first) p.first = r.from;
    p.airlines.add(r.fn.slice(0, 2));
    pairs.set(k, p);
  }
  const ended = new Set(allRows.filter((r) => r.to < today && r.to >= addDays(today, -400)).map((r) => `${r.o}-${r.d}`));
  const known = Boolean(seen?.since && seen.since <= addDays(today, -365));
  return [...pairs.entries()].filter(([, p]) => !p.active && p.first <= addDays(today, horizonDays))
    .map(([k, p]) => ({ o: p.o, d: p.d, first: p.first, airlines: [...p.airlines].sort(), kind: ended.has(k) || seen?.pairs?.[k] ? 'resume' : known ? 'new' : 'soon' }))
    .sort((a, b) => a.first.localeCompare(b.first));
}

// ---------- load factor (民航局 47492) ----------
const TW_NAMES = [['桃園', 'TPE'], ['松山', 'TSA'], ['台北', 'TSA'], ['高雄', 'KHH'], ['小港', 'KHH'], ['台中', 'RMQ'], ['清泉崗', 'RMQ'], ['台南', 'TNN'], ['金門', 'KNH'], ['澎湖', 'MZG'], ['馬公', 'MZG'], ['花蓮', 'HUN'], ['台東', 'TTT'], ['嘉義', 'CYI']];
const LF_COLS = [
  ['ym', /^(年月|統計年月|期間|資料年月|月份|年度月份)$/],
  ['y', /^(年|年度|統計年|西元年)$/],
  ['m', /^(月|統計月)$/],
  ['ap', /^(機場|航空站|起站|國內機場)(別|名稱)?$/],
  ['route', /航線|航點|起訖|目的地|^航段$/, /代碼|數$/],
  ['al', /^航空公司(別|名稱)?$|^公司$/],
  ['dir', /入出境|進出|方向|^出入境$/],
  ['seats', /座位數|座位$|可售座位/, /率$/],
  ['pax', /載客人數|旅客人數|^人數$|^載客數$/, /率$/],
  ['lf', /載客率/],
];
const zhNorm = (s) => String(s || '').replace(/臺/g, '台').replace(/[\s()（）［］[\]－—–\-→/、]+/g, '').replace(/國際機場|機場|航空站/g, '');
// airportNames: [[Chinese name, code]] (airport names and city groups); airlineZh: { code: Chinese name }.
function parseLoadFactor(text, { airportNames = [], airlineZh = {} } = {}) {
  const lines = parseCsv(text);
  const isHead = (r) => { const c = findCols(r, LF_COLS); return c.route != null && c.al != null && (c.lf != null || (c.seats != null && c.pax != null)); };
  const hi = lines.findIndex(isHead);
  if (hi < 0) throw new Error(`找不到欄位名稱（航線、航空公司、載客率）｜開頭：${preview(lines[0])}｜${preview(lines[1])}｜${preview(lines[2])}`);
  const c = findCols(lines[hi], LF_COLS);
  // Chinese names → codes, longest first so 東京成田 wins over 東京.
  const apNames = airportNames.map(([zh, code]) => [zhNorm(zh), code]).filter(([n]) => n.length >= 2).sort((a, b) => b[0].length - a[0].length);
  const alNames = Object.entries(airlineZh).map(([code, zh]) => [zhNorm(zh).replace(/航空(公司)?$/, ''), code]).filter(([n]) => n.length >= 2).sort((a, b) => b[0].length - a[0].length);
  const codeOfAirport = (s) => {
    const t = String(s || '');
    const m = /\b([A-Z]{3})\b/.exec(t.toUpperCase());
    if (m) return m[1];
    const n = zhNorm(t);
    return apNames.find(([name]) => n.includes(name))?.[1] || '';
  };
  const twOf = (s) => { const n = zhNorm(s); return TW_NAMES.find(([name]) => n.includes(name))?.[1] || ''; };
  const codeOfAirline = (s) => {
    const t = String(s || '').trim();
    if (/^[A-Z0-9]{2}$/.test(t.toUpperCase())) return t.toUpperCase();
    const m = /\(([A-Z0-9]{2})\)/.exec(t.toUpperCase());
    if (m) return m[1];
    const n = zhNorm(t).replace(/股份有限公司|有限公司|公司/g, '').replace(/航空$/, '');
    return n.length >= 2 ? alNames.find(([name]) => n.includes(name) || name.includes(n))?.[1] || '' : '';
  };
  const SPLIT = /[-－—–→~～]/;
  const acc = new Map();
  let total = 0;
  let used = 0;
  const unknown = new Set();
  let year = 0;
  // A title line naming a Taiwan airport (表36-1 臺灣桃園國際機場…) sets the Taiwan end for the rows under it.
  let ctxTw = '';
  for (const [i, x] of lines.entries()) {
    const filled = x.filter(Boolean);
    if (filled.length <= 2 && /機場|航空站/.test(filled.join('')) && twOf(filled.join(''))) { ctxTw = twOf(filled.join('')); continue; }
    if (i <= hi || isHead(x)) continue;
    if (!x[c.route] || !x[c.al] || /合計|總計|小計|total/i.test(`${x[c.route]}${x[c.al]}`)) continue;
    total++;
    let y = 0;
    let mo = 0;
    if (c.ym != null) {
      const s = String(x[c.ym]);
      const m = /^(\d{2,4})\D*(\d{1,2})/.exec(s.replace(/年/, '/')) || /^(\d{4})(\d{2})$/.exec(s);
      if (m) { y = Number(m[1]) < 1000 ? Number(m[1]) + 1911 : Number(m[1]); mo = Number(m[2]); }
    } else if (c.y != null) {
      y = Number(String(x[c.y]).replace(/\D/g, ''));
      if (y && y < 1000) y += 1911;
      mo = c.m != null ? Number(String(x[c.m]).replace(/\D/g, '')) : 0;
    }
    if (!(mo >= 1 && mo <= 12)) mo = 0; // a whole-year file: one value
    const route = String(x[c.route]);
    const parts = route.split(SPLIT).filter(Boolean);
    // The Taiwan end: the airport column, the route's own text (桃園-東京成田) or the title above the rows.
    const tw = (c.ap != null && twOf(x[c.ap])) || (parts.length > 1 && twOf(parts[0])) || ctxTw;
    const foreign = codeOfAirport(parts.length > 1 ? parts.filter((s) => !TW_NAMES.some(([n]) => zhNorm(s).startsWith(n))).pop() || '' : route);
    const al = codeOfAirline(x[c.al]);
    if (!tw || !foreign || TW.has(foreign) || !al) { unknown.add(`${route}/${x[c.al]}`); continue; }
    const num = (v) => Number(String(v ?? '').replace(/[,%\s]/g, ''));
    const seats = c.seats != null ? num(x[c.seats]) : NaN;
    const pax = c.pax != null ? num(x[c.pax]) : NaN;
    let lf = c.lf != null ? num(x[c.lf]) : NaN;
    if (lf > 0 && lf <= 1.2) lf *= 100;
    if (!(seats > 0 && pax >= 0 && pax <= seats * 1.2) && !(lf >= 0 && lf <= 120)) continue;
    used++;
    if (y > year) year = y;
    const k = `${tw}-${foreign}|${al}|${y}|${mo}`;
    const a = acc.get(k) || { seats: 0, pax: 0, lfSum: 0, n: 0 };
    if (seats > 0 && pax >= 0) { a.seats += seats; a.pax += pax; } else { a.lfSum += lf; a.n++; }
    acc.set(k, a);
  }
  if (!used) throw new Error('沒有讀到可用的載客率資料');
  // Keep the latest year only: { 'TPE-NRT': { BR: [12 values, null when missing] or [one value] } }.
  const routes = {};
  let monthly = false;
  for (const [k, a] of acc) {
    const [route, al, y, mo] = k.split('|');
    if (Number(y) !== year) continue;
    const v = a.seats ? Math.round((a.pax / a.seats) * 100) : Math.round(a.lfSum / a.n);
    routes[route] ||= {};
    if (Number(mo)) { monthly = true; (routes[route][al] ||= Array(12).fill(null))[Number(mo) - 1] = v; } else routes[route][al] = [v];
  }
  return { year, monthly, routes, total, used, unknown: [...unknown].slice(0, 30) };
}

// ---------- the store and the refresh ----------
// The timetable is stored per route, { 'TPE-NRT': [[fn, dep, arr, ad, days, from, to, ac, t, cs]] }, in pieces
// under 700 KB (Upstash's request limit is 1 MB).
const PIECE = 700_000;
// Pieces carry the write's stamp, so a reader never mixes an old head with new pieces; the old ones are deleted after.
async function putBig(kv, key, value, ex) {
  const s = JSON.stringify(value);
  const n = Math.max(1, Math.ceil(s.length / PIECE));
  const stamp = Date.now().toString(36);
  const old = await kv.get(key).catch(() => null);
  for (let i = 0; i < n; i++) await kv.set(`${key}:${stamp}:${i}`, s.slice(i * PIECE, (i + 1) * PIECE), { ex });
  await kv.set(key, { pieces: n, stamp }, { ex });
  if (old?.stamp && old.stamp !== stamp) for (let i = 0; i < old.pieces; i++) await kv.del(`${key}:${old.stamp}:${i}`).catch(() => {});
  return s.length;
}
async function getBig(kv, key) {
  const head = await kv.get(key);
  if (!head?.pieces || !head.stamp) return null;
  const keys = Array.from({ length: head.pieces }, (_, i) => `${key}:${head.stamp}:${i}`);
  const parts = kv.mget ? await kv.mget(keys) : await Promise.all(keys.map((k) => kv.get(k)));
  if (parts.some((p) => typeof p !== 'string')) return null;
  return JSON.parse(parts.join(''));
}
const packRoutes = (rows) => {
  const out = {};
  for (const r of rows) (out[`${r.o}-${r.d}`] ||= []).push([r.fn, r.dep, r.arr, r.ad, r.days, r.from, r.to, r.ac || '', r.t || '', r.cs.join(' ')]);
  return out;
};
const unpack = (o, d, x) => ({ fn: x[0], al: x[0].slice(0, 2), o, d, dep: x[1], arr: x[2], ad: x[3], days: x[4], from: x[5], to: x[6], ac: x[7], t: x[8], cs: x[9] ? x[9].split(' ') : [] });

// fetchImpl: the network (tests and the demo pass fixtures). tzOf(code) → IANA zone. airportNames ([[zh, code]]) and
// airlineZh ({ code: zh }): for the load-factor file, which names places and airlines in Chinese. mock: the demo (its data says so on screen).
function createFlightData({ kv, fetchImpl = fetch, env = process.env, tzOf = () => '', airportNames = [], airlineZh = {}, mock = false, now = () => Date.now(), log = () => {} } = {}) {
  const tdxId = String(env.TDX_CLIENT_ID || '').trim();
  const tdxSecret = String(env.TDX_CLIENT_SECRET || '').trim();
  const tdxOn = Boolean(tdxId && tdxSecret) || mock;
  // Per-instance copies for 10 minutes: the small entries (meta, terminals, upcoming, load factor) and, apart, the
  // timetable itself (a few hundred KB), read only by the route lookups.
  let memo = null;
  let rowsMemo = null;
  const MEMO_MS = 10 * 60e3;
  async function load(force = false) {
    if (!force && memo && now() - memo.loaded < MEMO_MS) return memo;
    const keys = [KEY.meta, KEY.term, KEY.fresh, KEY.lf];
    const [meta, term, fresh, lf] = await (kv.mget ? kv.mget(keys) : Promise.all(keys.map((k) => kv.get(k)))).catch(() => [null, null, null, null]);
    memo = { loaded: now(), meta, term, fresh, lf };
    return memo;
  }
  async function loadRows(force = false) {
    const { meta } = await load(force);
    if (!meta?.rows) return { meta, routes: null };
    if (force || !rowsMemo || rowsMemo.at !== meta.at || now() - rowsMemo.loaded >= MEMO_MS) {
      rowsMemo = { loaded: now(), at: meta.at, routes: await getBig(kv, KEY.rows).catch(() => null) };
    }
    return { meta, routes: rowsMemo.routes };
  }

  async function getBuf(url, ms, init = {}) {
    const res = await fetchImpl(url, { ...init, headers: { 'accept-encoding': 'br, gzip', ...(init.headers || {}) }, signal: AbortSignal.timeout(ms) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
  // A data.gov.tw file: the known address first; when it fails (moved, or no longer readable), the address the
  // dataset's API names now. `parse(text)` throws on a file it cannot read.
  async function govFile(id, known, ms, parse) {
    try { return { ...parse(decodeText(await getBuf(known, ms()))), url: known }; } catch (first) {
      let url = '';
      try {
        const j = JSON.parse(decodeText(await getBuf(URLS.dataset(id), Math.min(ms(), 8000))));
        url = (j?.result?.distribution || []).find((x) => /csv/i.test(x.resourceFormat || '') && /^https:\/\//.test(x.resourceDownloadUrl || ''))?.resourceDownloadUrl || '';
      } catch { /* no API answer */ }
      if (!url || url === known) throw first;
      return { ...parse(decodeText(await getBuf(url, ms()))), url };
    }
  }
  async function fetchTdx(ms) {
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: tdxId, client_secret: tdxSecret });
    const tok = JSON.parse(decodeText(await getBuf(URLS.tdxToken, Math.min(ms, 10000), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body })));
    if (!tok.access_token) throw new Error('TDX 金鑰無效');
    const all = [];
    for (let skip = 0; skip < 40000; skip += 10000) {
      const url = `${URLS.tdxSchedule}?%24format=JSON&%24top=10000${skip ? `&%24skip=${skip}` : ''}`;
      const page = JSON.parse(decodeText(await getBuf(url, ms, { headers: { authorization: `Bearer ${tok.access_token}`, accept: 'application/json' } })));
      if (!Array.isArray(page)) throw new Error('TDX 回應格式不同');
      all.push(...page);
      if (page.length < 10000) break;
    }
    return all;
  }

  // One refresh: every source at once, each on its own; what fails keeps the previous data of that kind.
  // `until`: when the caller must be done (the daily run's own limit).
  async function refresh({ until = now() + 40e3 } = {}) {
    const today = todayTW(now());
    const ms = () => Math.max(1000, Math.min(25000, until - now()));
    const diag = { at: new Date(now()).toISOString(), sources: {} };
    await kv.set(KEY.tried, now(), { ex: 3 * 86400 }).catch(() => {});
    const run = async (name, fn) => {
      const t0 = now();
      try { const v = await fn(); diag.sources[name] = { ok: true, ms: now() - t0, ...v.diag }; return v; } catch (e) { diag.sources[name] = { ok: false, ms: now() - t0, error: String(e.message || e).slice(0, 900) }; return null; }
    };
    const accept = (p, what) => {
      if (p.rows.length < 20 || p.rows.length < p.total * 0.5) {
        throw new Error(`${what}：${p.total} 列只有 ${p.rows.length} 列看得懂，先不用${p.columns ? `｜找到的欄位：${p.columns.join(',')}` : ''}${p.head ? `｜欄位列：${p.head}` : ''}${p.sample ? `｜第一列：${p.sample}` : ''}`);
      }
      return { ...p, diag: { rows: p.rows.length, total: p.total, ...(p.columns ? { columns: p.columns.join(',') } : {}), ...(p.url ? { url: p.url } : {}) } };
    };
    const [tdx, caa, ty, lf] = await Promise.all([
      tdxOn ? run('tdx', async () => accept(parseTdx(await fetchTdx(ms())), 'TDX')) : null,
      run('caa', async () => accept(await govFile('9973', URLS.caaSchedule, ms, (t) => accept(parseCaaSchedule(t, { tzOf }), '民航局班表')), '民航局班表')),
      run('ty', async () => accept(await govFile('7869', URLS.taoyuan, ms, (t) => accept(parseTaoyuan(t, { tzOf }), '桃園機場班表')), '桃園機場班表')),
      run('lf', async () => {
        const p = await govFile('47492', URLS.caaLoad, ms, (t) => parseLoadFactor(t, { airportNames, airlineZh }));
        return { ...p, diag: { rows: p.used, total: p.total, year: p.year, monthly: p.monthly, unknown: p.unknown.slice(0, 8), url: p.url } };
      }),
    ]);
    if (!tdxOn) diag.sources.tdx = { ok: false, off: true };
    const prev = await load(true);
    const ex = 45 * 86400;
    // Flights: TDX when it answered; otherwise 桃園機場 for TPE and the CAA file for the other airports.
    let all = null;
    let used = [];
    if (tdx) { all = tdx.rows; used = ['tdx']; } else if (caa || ty) {
      all = [...(ty ? ty.rows : []), ...(caa ? caa.rows.filter((r) => !ty || (r.o !== 'TPE' && r.d !== 'TPE')) : [])];
      used = [...(ty ? ['ty'] : []), ...(caa ? ['caa'] : [])];
    }
    const out = { ...diag, changed: [] };
    if (all) {
      const rows = mergeRows(all, today);
      if (caa) addAircraft(rows, caa.rows);
      const covered = [...new Set(rows.flatMap((r) => [r.o, r.d]).filter((c) => TW.has(c)))].sort();
      const horizon = rows.reduce((m, r) => (r.to > m ? r.to : m), '');
      const seen = (await kv.get(KEY.seen).catch(() => null)) || { since: today, pairs: {} };
      const fresh = upcomingRoutes(all, rows, seen, today);
      for (const r of rows) if (r.from <= today && TW.has(r.o)) seen.pairs[`${r.o}-${r.d}`] = today;
      await putBig(kv, KEY.rows, packRoutes(rows), ex);
      await Promise.all([kv.set(KEY.fresh, { at: diag.at, routes: fresh }, { ex }), kv.set(KEY.seen, seen, { ex: 400 * 86400 })]);
      out.timetable = { rows: rows.length, routes: Object.keys(packRoutes(rows)).length, covered, horizon, sources: used, upcoming: fresh.length };
      out.changed.push('timetable');
    }
    // Terminals: 桃園機場's own column first, else TDX's.
    const termRows = ty?.rows?.some((r) => r.t) ? ty.rows : tdx?.rows?.some((r) => r.t) ? tdx.rows : null;
    if (termRows) {
      const term = buildTerminals(termRows.filter((r) => r.to >= today));
      await kv.set(KEY.term, { at: diag.at, source: termRows === ty?.rows ? 'ty' : 'tdx', ...term }, { ex });
      out.changed.push('terminals');
    }
    if (lf) {
      await kv.set(KEY.lf, { at: diag.at, year: lf.year, monthly: lf.monthly, routes: lf.routes }, { ex: 400 * 86400 });
      out.changed.push('lf');
    }
    const meta = {
      ...(prev.meta || {}),
      tried: diag.at,
      sources: { ...(prev.meta?.sources || {}), ...diag.sources },
      ...(out.timetable ? { at: diag.at, rows: out.timetable.rows, covered: out.timetable.covered, horizon: out.timetable.horizon, used: out.timetable.sources } : {}),
      mock,
    };
    await kv.set(KEY.meta, meta, { ex });
    await loadRows(true);
    log(`flightdata: ${JSON.stringify({ changed: out.changed, sources: Object.fromEntries(Object.entries(diag.sources).map(([k, v]) => [k, v.ok ? v.rows ?? 'ok' : v.error || 'off'])) })}`);
    return out;
  }

  // Due once a day at most: when nothing is stored, when it is a week old, or on Mondays (Taiwan) after a day.
  async function due() {
    const tried = Number(await kv.get(KEY.tried).catch(() => 0)) || 0;
    if (now() - tried < 20 * 3600e3) return false;
    const m = (await load()).meta;
    const age = m?.at ? now() - Date.parse(m.at) : Infinity;
    const monday = new Date(now() + 8 * 3600e3).getUTCDay() === 1;
    // A government file that could not be read last time is tried again the next day (they cost nothing).
    const failed = Object.values(m?.sources || {}).some((x) => x && !x.ok && !x.off);
    return age >= 7 * DAY || (monday && age >= DAY) || failed;
  }

  const sourcesOf = (m) => (m?.used || []).map((k) => SOURCE[k]).filter(Boolean);
  // Every flight between any of `from` and any of `to` that has not ended. covered: whether the official data speaks
  // for this pair at all (one end is a Taiwan airport it includes), so "no flights" means no nonstop.
  async function route(from, to) {
    const { meta, routes } = await loadRows();
    if (!meta?.rows || !routes) return { configured: false };
    const today = todayTW(now());
    const covered = from.some((c) => meta.covered?.includes(c)) || to.some((c) => meta.covered?.includes(c));
    const flights = [];
    for (const o of from) for (const d of to) for (const x of routes[`${o}-${d}`] || []) if (x[6] >= today) flights.push(unpack(o, d, x));
    return { configured: true, covered, flights, horizon: meta.horizon, updated: meta.at.slice(0, 10), sources: sourcesOf(meta), mock: Boolean(meta.mock) };
  }
  // Carriers flying a pair nonstop on the timetable (for other features: 兌換地圖, RTW menus), or null when the
  // official data does not cover the pair.
  async function nonstopCarriers(a, b) {
    const r = await route([a], [b]);
    if (!r.configured || !r.covered) return null;
    return [...new Set(r.flights.map((f) => f.al))].sort();
  }
  async function terminals() {
    const { term } = await load();
    return term ? { configured: true, airlines: term.airlines, flights: term.flights, updated: term.at.slice(0, 10), source: SOURCE[term.source] || SOURCE.ty, mock } : { configured: false };
  }
  async function upcoming() {
    const { fresh, meta } = await load();
    const today = todayTW(now());
    const routes = (fresh?.routes || []).filter((r) => r.first > today);
    return fresh ? { configured: true, routes, updated: fresh.at.slice(0, 10), sources: sourcesOf(meta), mock } : { configured: false };
  }
  async function loadFactor(from, to) {
    const { lf } = await load();
    if (!lf) return { configured: false };
    const pairs = {};
    for (const o of from) for (const d of to) {
      for (const [k, v] of [[`${o}-${d}`, lf.routes[`${o}-${d}`]], [`${d}-${o}`, lf.routes[`${d}-${o}`]]]) if (v) pairs[k] = v;
    }
    return { configured: true, year: lf.year, monthly: lf.monthly, routes: pairs, updated: lf.at.slice(0, 10), source: SOURCE.lf, mock };
  }
  // On/off for /api/config (the page loads the timetable script only when there is something to show).
  async function flags() {
    const m = await load().catch(() => null);
    if (!m) return {};
    const today = todayTW(now());
    return { timetable: Boolean(m.meta?.rows), terminals: Boolean(m.term), lf: Boolean(m.lf), upcoming: (m.fresh?.routes || []).filter((r) => r.first > today).length, mock };
  }
  // The owner's view: when each source last answered and how many rows it gave (no secrets).
  async function status() {
    const { meta } = await load(true);
    return { tdxKey: Boolean(tdxId && tdxSecret), meta: meta || null, urls: { ...URLS, dataset: undefined } };
  }
  // The same for anyone opening the address (no passcode): which source answered, row counts, columns and the error
  // text of the last run; no file addresses, timings or key.
  async function publicStatus() {
    const { meta } = await load(true);
    const keep = ['ok', 'off', 'rows', 'total', 'columns', 'year', 'unknown', 'error'];
    const sources = Object.fromEntries(Object.entries(meta?.sources || {}).map(([k, v]) => [k, Object.fromEntries(keep.filter((f) => v?.[f] != null).map((f) => [f, v[f]]))]));
    return { tdxKey: Boolean(tdxId && tdxSecret), at: meta?.at || null, tried: meta?.tried || null, used: meta?.used || [], covered: meta?.covered || [], horizon: meta?.horizon || null, sources };
  }
  return { refresh, due, route, nonstopCarriers, terminals, upcoming, loadFactor, flags, status, publicStatus, tdxOn };
}

module.exports = {
  createFlightData, parseTdx, parseTaoyuan, parseCaaSchedule, parseLoadFactor, mergeRows, addAircraft, buildTerminals, upcomingRoutes,
  decodeText, parseCsv, parseDate, parseTime, parseDays, normFlight, tzOffset, arrivalDays, rotate, putBig, getBig, URLS, SOURCE, TW, KEY,
};
