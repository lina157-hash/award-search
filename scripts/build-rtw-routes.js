#!/usr/bin/env node
// Builds data/rtw-routes.json: which oneworld and Star Alliance airlines fly each airport pair nonstop, for the airline
// menu of 環球票規劃 (public/rtw.js shows only the airlines that fly a leg).
//
// Source: Virtual Radar Server standing data (CC0 1.0, github.com/vradarserver/standing-data): flight callsign →
// airports, collected by plane spotters from ADS-B. It has no dates, so it also keeps some routes that stopped flying,
// cargo and charter flights; the filters below drop most of them (see METHOD). ICAO → IATA airport codes come from
// OurAirports (public domain). Only airports in public/airports.min.json are kept.
//
// Usage:
//   node scripts/build-rtw-routes.js --download <dir>   fetch the files into <dir> (needs direct internet access)
//   node scripts/build-rtw-routes.js <dir> [YYYY-MM-DD] build from <dir> (date = when the files were fetched; default today)
// <dir> holds airlines.csv, ourairports.csv and routes/<ICAO>.csv (one file per operator, the VRS files joined).
const fs = require('node:fs');
const path = require('node:path');

const VRS = 'https://raw.githubusercontent.com/vradarserver/standing-data/main';
const OURAIRPORTS = 'https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/airports.csv';

// Operator (ICAO callsign prefix) → the alliance airline whose flight numbers it flies. Mainline first, then wholly
// owned regional or group airlines that fly only that airline's flights (an operator flying for several airlines, such
// as SkyWest or Republic, can't be told apart by callsign and is left out). Keep in step with data/alliances.json:
// test/rtw-routes.test.js checks every member has an operator here.
const OPERATORS = {
  // oneworld
  AAL: 'AA', ENY: 'AA', PDT: 'AA', JIA: 'AA', // American Eagle: Envoy, Piedmont, PSA (wholly owned)
  ASA: 'AS', QXE: 'AS', // Horizon Air (wholly owned)
  BAW: 'BA', SHT: 'BA', CFE: 'BA', EFW: 'BA', // BA Shuttle callsign, BA CityFlyer, BA Euroflyer
  CPA: 'CX', FIN: 'AY', HAL: 'HA',
  IBE: 'IB', IBS: 'IB', // Iberia Express
  JAL: 'JL', JLJ: 'JL', // J-Air
  MAS: 'MH',
  QFA: 'QF', QLK: 'QF', QJE: 'QF', EAQ: 'QF', NWK: 'QF', // QantasLink operators
  QTR: 'QR', RAM: 'AT', RJA: 'RJ', ALK: 'UL',
  FJI: 'FJ', FJA: 'FJ', // Fiji Link
  OMA: 'WY',
  // Star Alliance
  AEE: 'A3',
  ACA: 'AC', JZA: 'AC', ROU: 'AC', // Air Canada Express (Jazz), Air Canada Rouge
  CCA: 'CA', CCD: 'CA', CNM: 'CA', // Dalian Airlines, Air China Inner Mongolia
  AIC: 'AI',
  ANZ: 'NZ', RLK: 'NZ', NZM: 'NZ', // Air Nelson, Mount Cook (wholly owned)
  ANA: 'NH', AKX: 'NH', // ANA Wings
  AAR: 'OZ', AUA: 'OS', AVA: 'AV', BEL: 'SN', CMP: 'CM', CTN: 'OU', MSR: 'MS', ETH: 'ET', EVA: 'BR', ITY: 'AZ', LOT: 'LO',
  DLH: 'LH', DLA: 'LH', LHX: 'LH', // Air Dolomiti, Lufthansa City Airlines
  CSZ: 'ZH', SIA: 'SQ', SAA: 'SA', SWR: 'LX', TAP: 'TP', THA: 'TG', THY: 'TK', UAL: 'UA',
};
// The regional and group airlines above: their callsigns use high flight numbers, so the number rule below skips them.
const REGIONAL = new Set(['ENY', 'PDT', 'JIA', 'QXE', 'CFE', 'EFW', 'IBS', 'JLJ', 'QLK', 'QJE', 'EAQ', 'NWK', 'FJA', 'JZA', 'ROU', 'CCD', 'CNM', 'RLK', 'NZM', 'AKX', 'DLA', 'LHX']);
// A mainline callsign numbered from this up is mostly a charter, ferry, cargo or extra section (e.g. AA 9xxx, TK 6xxx).
const MAX_FLIGHT_NO = 5000;
// Lower number ranges some airlines use for freighters or charters (seen in the VRS files: CX 2xxx–3xxx fly to cargo
// hubs such as Dubai World Central and Anchorage, ET 2xxx–3xxx to Liège, BR 6xx via Anchorage, BR 1xxx–2xxx are
// charters to small Japanese airports).
const NON_PASSENGER = { CPA: [[2000, 4999]], ETH: [[2000, 4999]], EVA: [[600, 699], [1000, 4999]] };
// Routes that stopped flying but are still in the VRS files, checked by hand: [airline, airport, airport, why].
const STALE = [
  ['MH', 'LAX', 'TPE', '馬航吉隆坡–台北–洛杉磯 2014 年停飛'],
  ['NZ', 'HKG', 'LHR', '紐航奧克蘭–香港–倫敦 2013 年停飛'],
  ['CX', 'DME', 'HKG', '國泰沒有飛莫斯科的客運航班'],
];
const METHOD = [
  '多站的航班（例如 HKG–TPE–NRT）拆成每一段直飛',
  `主線航空公司只用 ${MAX_FLIGHT_NO} 號以下的航班呼號，並排除 VRS 標示的調機、包機號碼`,
  '同一家航空公司兩個方向都有紀錄才算（單向紀錄多半是改降或臨時航班）',
  '同城市的兩個機場之間（例如 NRT–HND）不算',
  '排除貨機和包機常用的航班號碼（國泰、衣索比亞 2000–4999 號，長榮 600–699 和 1000–4999 號）',
  `手動刪掉已知停飛的航線（${STALE.map(([c, a, b]) => `${c} ${a}–${b}`).join('、')}）`,
];

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  text = text.replace(/^﻿/, '');
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
  if (cell || row.length) rows.push([...row, cell]);
  const [head, ...body] = rows;
  // Joined files repeat their header line: skip those.
  return body.filter((r) => r[0] !== head[0]).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

// The pure part. rows: [{ Callsign, AirlineCode, AirportCodes }]; icaoToIata: Map; keep: Set of IATA codes to keep;
// cityOf: IATA → city key (same-city pairs dropped); patterns: ICAO → [RegExp] of positioning/charter flight numbers.
// → { 'AAA': { 'BBB': ['CX', 'JL'] } } with each pair once, under the code that sorts first; carriers sorted.
function buildRoutes(rows, { icaoToIata, keep, cityOf = (c) => c, patterns = {}, operators = OPERATORS, regional = REGIONAL, nonPassenger = NON_PASSENGER, stale = STALE }) {
  const seen = new Map(); // 'CX AAA BBB' (directed) → true
  for (const r of rows) {
    const op = r.AirlineCode;
    const carrier = operators[op];
    if (!carrier) continue;
    const no = String(r.Callsign || '').slice(op.length);
    if ((patterns[op] || []).some((re) => re.test(no))) continue;
    if (!regional.has(op) && /^\d+$/.test(no) && Number(no) >= MAX_FLIGHT_NO) continue;
    if (/^\d+$/.test(no) && (nonPassenger[op] || []).some(([lo, hi]) => Number(no) >= lo && Number(no) <= hi)) continue;
    // A flight with stops (HKG-TPE-NRT) is one nonstop leg per pair of neighbours.
    const codes = String(r.AirportCodes || '').split('-').map((c) => icaoToIata.get(c));
    for (let i = 1; i < codes.length; i++) {
      const [a, b] = [codes[i - 1], codes[i]];
      if (!a || !b || a === b || !keep.has(a) || !keep.has(b) || cityOf(a) === cityOf(b)) continue;
      seen.set(`${carrier} ${a} ${b}`, true);
    }
  }
  const gone = new Set(stale.map(([c, a, b]) => `${c} ${[a, b].sort().join(' ')}`));
  const out = {};
  for (const k of seen.keys()) {
    const [c, a, b] = k.split(' ');
    if (a > b || !seen.has(`${c} ${b} ${a}`)) continue; // both directions, each pair once
    if (gone.has(k)) continue;
    ((out[a] ||= {})[b] ||= []).push(c);
  }
  for (const a of Object.keys(out)) for (const b of Object.keys(out[a])) out[a][b].sort();
  return out;
}

// { AAA: { BBB: ['CX','JL'] } } → { AAA: 'BBB:CXJL CCC:BR' } (codes are two characters, so they need no separator).
function packRoutes(routes) {
  return Object.fromEntries(Object.keys(routes).sort().map((a) => [a, Object.keys(routes[a]).sort().map((b) => `${b}:${routes[a][b].join('')}`).join(' ')]));
}

function icaoMap(ourRows) {
  const m = new Map();
  for (const r of ourRows) {
    const iata = (r.iata_code || '').trim();
    if (!/^[A-Z]{3}$/.test(iata)) continue;
    for (const k of ['icao_code', 'gps_code', 'ident']) {
      const v = (r[k] || '').trim();
      if (/^[A-Z0-9]{4}$/.test(v) && !m.has(v)) m.set(v, iata);
    }
  }
  return m;
}

async function download(dir) {
  fs.mkdirSync(path.join(dir, 'routes'), { recursive: true });
  const get = async (url) => { const r = await fetch(url); return r.ok ? r.text() : null; };
  fs.writeFileSync(path.join(dir, 'airlines.csv'), await get(`${VRS}/airlines/schema-01/airlines.csv`));
  fs.writeFileSync(path.join(dir, 'ourairports.csv'), await get(OURAIRPORTS));
  for (const op of Object.keys(OPERATORS)) {
    const base = `${VRS}/routes/schema-01/${op[0]}/${op}`;
    let text = await get(`${base}-all.csv`);
    // Big airlines are split by the first digit of the flight number.
    if (text == null) text = (await Promise.all([...'0123456789'].map((d) => get(`${base}-${d}.csv`)))).filter(Boolean).join('\n');
    fs.writeFileSync(path.join(dir, 'routes', `${op}.csv`), text || '');
    console.log(`${op}: ${text ? text.split('\n').length : 0} lines`);
  }
}

function main(dir, fetched) {
  const root = path.join(__dirname, '..');
  const alliances = JSON.parse(fs.readFileSync(path.join(root, 'data', 'alliances.json'), 'utf8')).alliances;
  const carriers = [...new Set(alliances.filter((a) => a.id === 'oneworld' || a.id === 'star').flatMap((a) => a.members))].sort();
  const operators = Object.fromEntries(Object.entries(OPERATORS).filter(([, c]) => carriers.includes(c)));
  const ap = JSON.parse(fs.readFileSync(path.join(root, 'public', 'airports.min.json'), 'utf8'));
  const keep = new Set(ap.airports.map((r) => r[0]));
  const group = new Map(ap.groups.flatMap((g) => g.codes.map((c) => [c, g.en])));
  const airlines = parseCsv(fs.readFileSync(path.join(dir, 'airlines.csv'), 'utf8'));
  const patterns = {};
  for (const r of airlines) {
    if (!operators[r.ICAO]) continue;
    const res = [r.PositioningFlightPattern, r.CharterFlightPattern].filter(Boolean).map((p) => new RegExp(/^\^/.test(p) ? p : `^${p}$`));
    if (res.length) patterns[r.ICAO] = res;
  }
  const rows = Object.keys(operators).flatMap((op) => {
    const f = path.join(dir, 'routes', `${op}.csv`);
    return fs.existsSync(f) ? parseCsv(fs.readFileSync(f, 'utf8')) : [];
  });
  const routes = buildRoutes(rows, {
    icaoToIata: icaoMap(parseCsv(fs.readFileSync(path.join(dir, 'ourairports.csv'), 'utf8'))),
    keep, cityOf: (c) => group.get(c) || c, patterns, operators,
  });
  const pairs = Object.values(routes).reduce((n, x) => n + Object.keys(x).length, 0);
  const out = {
    note: '每個機場之間有哪些寰宇一家、星空聯盟航空公司直飛（兩個方向都有紀錄才算）。資料來自飛機愛好者以 ADS-B 收集的航班呼號航線，不是航空公司的時刻表：可能漏掉新航線，也可能留著已停飛、季節性或貨運的航線。',
    source: { label: 'Virtual Radar Server standing data（航班呼號航線）', url: 'https://github.com/vradarserver/standing-data', licence: 'CC0 1.0', fetched },
    airportCodes: { label: 'OurAirports（ICAO 轉 IATA 機場代碼）', url: 'https://ourairports.com/data/', licence: 'Public domain', fetched },
    method: METHOD,
    carriers,
    pairs,
    routes: packRoutes(routes),
  };
  const file = path.join(root, 'data', 'rtw-routes.json');
  fs.writeFileSync(file, `${JSON.stringify(out, null, 0).replace(/,"(?=[A-Z]{3}":)/g, ',\n"')}\n`);
  const missing = carriers.filter((c) => !Object.values(routes).some((x) => Object.values(x).some((l) => l.includes(c))));
  console.log(`wrote ${pairs} airport pairs (${fs.statSync(file).size} bytes) to ${path.relative(process.cwd(), file)}${missing.length ? `; no routes for ${missing.join(', ')}` : ''}`);
}

if (require.main === module) {
  const [a, b] = process.argv.slice(2);
  if (a === '--download' && b) download(b).catch((e) => { console.error(e); process.exit(1); });
  else if (a && fs.existsSync(a)) main(a, b || new Date().toISOString().slice(0, 10));
  else {
    console.error('usage: node scripts/build-rtw-routes.js --download <dir>   then   node scripts/build-rtw-routes.js <dir> [YYYY-MM-DD]');
    process.exit(1);
  }
}

module.exports = { OPERATORS, REGIONAL, MAX_FLIGHT_NO, NON_PASSENGER, STALE, parseCsv, buildRoutes, packRoutes, icaoMap };
