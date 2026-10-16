// Demo copies of the official files lib/flightdata.js reads (TDX JSON, 民航局 CSV, 桃園機場 CSV, 民航局 load factor
// CSV), made up from a few routes so the demo runs the same parsers end to end. Flight numbers, times, aircraft,
// terminals and load factors here are invented; the page labels them 示範資料.
const { addDays } = require('./day');
const { URLS, tzOffset } = require('./flightdata');

const AP = new Map(require('../public/airports.min.json').airports.map((r) => [r[0], { lat: r[8], lon: r[9] }]));
const TZ = (() => { const f = require('../public/airports.min.json'); return new Map(f.airports.map((r) => [r[0], f.tzs[r[10]]])); })();
const hash = (s) => { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0; return h; };
function miles(a, b) {
  const A = AP.get(a);
  const B = AP.get(b);
  if (!A || !B) return 1000;
  const r = Math.PI / 180;
  const h = Math.sin(((B.lat - A.lat) * r) / 2) ** 2 + Math.cos(A.lat * r) * Math.cos(B.lat * r) * Math.sin(((B.lon - A.lon) * r) / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.sqrt(h));
}
const pad = (n) => String(n).padStart(2, '0');
const rot = (mask, k) => { const s = ((k % 7) + 7) % 7; return ((mask << s) | (mask >> (7 - s))) & 127; };
const hm = (m) => `${pad(Math.floor((((m % 1440) + 1440) % 1440) / 60))}:${pad((((m % 1440) + 1440) % 1440) % 60)}`;
// The IATA northern winter season around `today` ends on the last Saturday of March.
function seasonEnd(today) {
  const y = Number(today.slice(0, 4)) + (today.slice(5) > '03-25' ? 1 : 0);
  const d = new Date(Date.UTC(y, 2, 31));
  while (d.getUTCDay() !== 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// [Taiwan airport, other airport, airlines, weekly days (127 = daily), note]: note 'ends' = stops before the season
// ends, 'new' = starts later this season, 'resume' = ran before and starts again.
const ROUTES = [
  ['TPE', 'NRT', ['BR', 'CI', 'JX'], 127], ['TPE', 'HND', ['BR', 'CI'], 127], ['TSA', 'HND', ['BR', 'CI', 'JL', 'NH'], 127],
  ['TPE', 'KIX', ['BR', 'CI', 'JX'], 127], ['TPE', 'ICN', ['BR', 'CI', 'KE'], 127], ['TPE', 'HKG', ['BR', 'CI', 'CX', 'JX'], 127],
  ['TPE', 'BKK', ['BR', 'CI', 'TG'], 127], ['TPE', 'SIN', ['BR', 'CI', 'SQ'], 127], ['TPE', 'LAX', ['BR', 'CI', 'JX'], 127],
  ['TPE', 'SFO', ['BR', 'CI', 'UA'], 127], ['TPE', 'YVR', ['BR', 'CI'], 0b1010101], ['TPE', 'SEA', ['BR', 'JX'], 0b0110101],
  ['TPE', 'JFK', ['BR', 'CI'], 127], ['TPE', 'LHR', ['BR', 'CI'], 0b1101011], ['TPE', 'CDG', ['BR'], 0b0101010],
  ['TPE', 'AMS', ['CI'], 0b1010100], ['TPE', 'VIE', ['BR', 'CI'], 0b1001010], ['TPE', 'SYD', ['CI'], 0b1010101], ['TPE', 'BNE', ['BR'], 0b0100101],
  ['TPE', 'MUC', ['BR'], 0b0010101, 'ends'], ['TPE', 'PRG', ['JX'], 0b0101001, 'new'], ['TPE', 'CTS', ['BR'], 0b1010101, 'resume'],
  ['KHH', 'NRT', ['CI', 'BR'], 127], ['KHH', 'HKG', ['CI', 'BR'], 127], ['RMQ', 'HKG', ['CI'], 0b0101010],
];
const AIRCRAFT = (mi) => (mi < 1500 ? ['A321neo', '32Q'] : mi < 3200 ? ['A330-300', '333'] : mi < 6000 ? ['787-10', '781'] : ['777-300ER', '77W']);
const TERMINAL = { BR: '2', CI: '1', JX: '1', CX: '1', KE: '2', TG: '2', SQ: '2', UA: '2', JL: '2', NH: '2' };

// Every flight both ways: { al, fn, o, d, dep, arr, ad, days, from, to, ac, t, cs }.
function flights(today) {
  const end = seasonEnd(today);
  const start = addDays(today, -30);
  const out = [];
  ROUTES.forEach(([tw, far, airlines, days, note], ri) => {
    const mi = miles(tw, far);
    const flown = Math.round(mi / 8.2 + 35); // minutes, roughly
    airlines.forEach((al, ai) => {
      for (const back of [false, true]) {
        const o = back ? far : tw;
        const d = back ? tw : far;
        const n = 10 + (ri * 4 + ai) * 2 + (back ? 1 : 0);
        const depMin = ((hash(`${al}${o}${d}`) % 34) + 14) * 30; // 07:00–23:30
        const off = (tzOffset(TZ.get(d), today) ?? 480) - (tzOffset(TZ.get(o), today) ?? 480);
        const arrAbs = depMin + flown + off;
        const ad = Math.floor(arrAbs / 1440);
        const [acName, acCode] = AIRCRAFT(mi);
        const f = { al, fn: `${al}${n}`, o, d, dep: hm(depMin), arr: hm(arrAbs), ad, days: ai && days !== 127 ? rot(days, ai) : days, from: start, to: end, ac: acName, acCode, t: TERMINAL[al] || '1', cs: al === 'BR' && far === 'NRT' ? ['NH5800'] : al === 'CI' && far === 'NRT' ? ['JL5040'] : [] };
        if (note === 'ends') f.to = addDays(today, 80);
        if (note === 'new') f.from = addDays(today, 45);
        if (note === 'resume') { out.push({ ...f, from: addDays(today, -200), to: addDays(today, -60) }); f.from = addDays(today, 25); }
        out.push(f);
      }
    });
  });
  return out;
}

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const tdxList = (today) => flights(today).map((f) => ({
  AirlineID: f.al, FlightNumber: `${f.al}${String(f.fn.slice(2)).padStart(3, '0')}`, DepartureAirportID: f.o, ArrivalAirportID: f.d,
  DepartureTime: f.dep, ArrivalTime: `${f.arr}${f.ad ? `+${f.ad}` : ''}`, ScheduleStartDate: f.from, ScheduleEndDate: f.to,
  ...Object.fromEntries(DAYS.map((k, i) => [k, Boolean(f.days & (1 << i))])),
  Terminal: f.o === 'TPE' || f.d === 'TPE' ? f.t : '', CodeShare: f.cs.map((c) => ({ AirlineID: c.slice(0, 2), FlightNumber: c.slice(2) })),
  UpdateTime: `${today}T06:00:00+08:00`, VersionID: 1,
}));
const slash = (iso) => iso.replace(/-/g, '/');
const dayDigits = (mask) => [1, 2, 3, 4, 5, 6, 7].map((n) => (mask & (1 << (n - 1)) ? n : 0)).join('');
// 桃園機場 7869: 22 columns by position, the header a row of numbers (as data.gov.tw lists its fields).
function taoyuanCsv(today) {
  const head = Array.from({ length: 22 }, (_, i) => i + 1).join(',');
  const rows = flights(today).filter((f) => f.o === 'TPE' || f.d === 'TPE').map((f) => {
    const out = f.o === 'TPE';
    const days = out ? f.days : rot(f.days, f.ad); // arrivals: TPE's weekdays and dates
    const shift = out ? 0 : f.ad;
    return [out ? 'PD' : 'PA', f.al, f.fn.slice(2).padStart(4, '0'), f.dep, out ? f.d : f.o, f.arr, ...Array(12).fill(''), f.t, dayDigits(days), slash(addDays(f.from, shift)), slash(addDays(f.to, shift))].join(',');
  });
  return [head, ...rows, 'CD,CI,5001,02:00,ANC,10:00,,,,,,,,,,,,,1,1000000,2026/01/01,2027/12/31'].join('\r\n');
}
// 民航局 9973, with column names as a guess of the real file's (the parser finds columns by name).
function caaCsv(today) {
  const head = '航空公司代碼,班次,共用班號,起飛機場,起飛時間,經停站1,經停站1抵達時間,抵達機場,抵達時間,開始日期,結束日期,星期,機型';
  const rows = flights(today).map((f) => [f.al, f.fn, `"${f.cs.join(',')}"`, f.o, f.dep, '', '', f.d, `${f.arr}${f.ad ? `+${f.ad}` : ''}`, slash(f.from), slash(f.to), dayDigits(f.days), f.acCode].join(','));
  return [head, ...rows].join('\r\n');
}
// 民航局 47492: last year's months per route and airline, both directions.
const AL_ZH = { BR: '長榮航空', CI: '中華航空', JX: '星宇航空', CX: '國泰航空', KE: '大韓航空', TG: '泰國航空', SQ: '新加坡航空', UA: '聯合航空', JL: '日本航空', NH: '全日空' };
const AP_ZH = { NRT: '東京(成田)', HND: '東京(羽田)', KIX: '大阪(關西)', ICN: '首爾(仁川)', HKG: '香港', BKK: '曼谷', SIN: '新加坡', LAX: '洛杉磯', SFO: '舊金山', YVR: '溫哥華', SEA: '西雅圖', JFK: '紐約', LHR: '倫敦', CDG: '巴黎', AMS: '阿姆斯特丹', VIE: '維也納', SYD: '雪梨', BNE: '布里斯本', MUC: '慕尼黑', CTS: '札幌', PRG: '布拉格' };
const TW_ZH = { TPE: '桃園', TSA: '松山', KHH: '高雄', RMQ: '台中' };
function loadFactorCsv(today) {
  const y = Number(today.slice(0, 4)) - 1;
  const out = ['年月,機場,航線,航空公司,入出境,架次,座位數,載客人數,載客率'];
  for (const [tw, far, airlines, , note] of ROUTES) {
    if (note === 'new' || !AP_ZH[far]) continue;
    for (const al of airlines) {
      for (let m = 1; m <= 12; m++) {
        const base = 70 + (hash(`${tw}${far}${al}`) % 12) + [6, 2, -4, -2, -6, 3, 10, 12, -3, 2, -5, 8][m - 1];
        for (const dir of ['出境', '入境']) {
          const seats = 300 * 30;
          const lf = Math.max(40, Math.min(99, base + (dir === '入境' ? -2 : 0)));
          out.push([`${y}/${pad(m)}`, TW_ZH[tw], AP_ZH[far], AL_ZH[al] || al, dir, 30, seats, Math.round((seats * lf) / 100), `${lf}%`].join(','));
        }
      }
    }
  }
  return out.join('\r\n');
}

// A fetch that serves these files at the real addresses (and refuses data.gov.tw's API, as an unreachable host would).
function mockFetch(today) {
  const files = new Map([
    [URLS.caaSchedule, () => caaCsv(today)],
    [URLS.taoyuan, () => taoyuanCsv(today)],
    [URLS.caaLoad, () => loadFactorCsv(today)],
  ]);
  return async (url, init = {}) => {
    const u = String(url);
    const reply = (status, body) => ({ ok: status < 400, status, arrayBuffer: async () => new TextEncoder().encode(body).buffer });
    if (u === URLS.tdxToken) return reply(200, JSON.stringify({ access_token: 'demo', expires_in: 86400 }));
    if (u.startsWith(URLS.tdxSchedule)) return reply(200, JSON.stringify(/skip=/.test(u) ? [] : tdxList(today)));
    if (files.has(u)) return reply(200, files.get(u)());
    void init;
    return reply(404, '');
  };
}

module.exports = { mockFetch, flights, tdxList, taoyuanCsv, caaCsv, loadFactorCsv, seasonEnd };
