#!/usr/bin/env node
// Builds data/skyteam-routes.json: which SkyTeam airlines fly each airport pair nonstop, for 拆兩段查
// (public/hubsplit.js). data/rtw-routes.json covers oneworld and Star Alliance only. Only pairs with a SkyTeam hub of
// data/split-hubs.json at one end are kept (that is all 拆兩段查 asks), so rebuild after adding a SkyTeam hub there.
//
// Same source, filters and output format as scripts/build-rtw-routes.js, whose parts it reuses: Virtual Radar Server
// standing data (CC0 1.0) for callsign → airports, OurAirports (public domain) for ICAO → IATA.
//
// Usage:
//   node scripts/build-skyteam-routes.js --download <dir>   fetch the files into <dir> (needs direct internet access)
//   node scripts/build-skyteam-routes.js <dir> [YYYY-MM-DD] build from <dir> (date = when the files were fetched)
const fs = require('node:fs');
const path = require('node:path');
const B = require('./build-rtw-routes.js');

const VRS = 'https://raw.githubusercontent.com/vradarserver/standing-data/main';
const OURAIRPORTS = 'https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/airports.csv';

// Operator (ICAO callsign prefix) → the SkyTeam airline whose flight numbers it flies; wholly owned regionals after
// the mainline. Keep in step with data/alliances.json (test/r9-hubsplit.test.js checks every member has one).
const OPERATORS = {
  ARG: 'AR', AMX: 'AM', SLI: 'AM', // Aeroméxico Connect
  AEA: 'UX', AFR: 'AF', CAL: 'CI', CES: 'MU',
  DAL: 'DL', EDV: 'DL', // Endeavor Air (wholly owned)
  GIA: 'GA', KQA: 'KQ',
  KLM: 'KL', KLC: 'KL', // KLM Cityhopper
  KAL: 'KE', MEA: 'ME', SVA: 'SV', ROT: 'RO', HVN: 'VN', VIR: 'VS', CXA: 'MF', SAS: 'SK',
};
const REGIONAL = new Set(['SLI', 'EDV', 'KLC']);
// Korean Air's 2xx–5xx are freighters (seen in the VRS files: via Anchorage, Navoi, Liège). China Airlines' and Air
// France's freighters are numbered 5000 and up, which the shared number rule already drops.
const NON_PASSENGER = { KAL: [[200, 599]] };
const METHOD = [
  '只收一端是天合聯盟樞紐（data/split-hubs.json）的航段',
  '多站的航班拆成每一段直飛；同一家航空公司兩個方向都有紀錄才算',
  `主線航空公司只用 ${B.MAX_FLIGHT_NO} 號以下的航班呼號，並排除 VRS 標示的調機、包機號碼`,
  '同城市的兩個機場之間不算',
  '排除貨機常用的航班號碼（大韓航空 200–599 號）',
];

async function download(dir) {
  fs.mkdirSync(path.join(dir, 'routes'), { recursive: true });
  const get = async (url) => { const r = await fetch(url); return r.ok ? r.text() : null; };
  fs.writeFileSync(path.join(dir, 'airlines.csv'), await get(`${VRS}/airlines/schema-01/airlines.csv`));
  fs.writeFileSync(path.join(dir, 'ourairports.csv'), await get(OURAIRPORTS));
  for (const op of Object.keys(OPERATORS)) {
    const base = `${VRS}/routes/schema-01/${op[0]}/${op}`;
    let text = await get(`${base}-all.csv`);
    if (text == null) text = (await Promise.all([...'0123456789'].map((d) => get(`${base}-${d}.csv`)))).filter(Boolean).join('\n');
    fs.writeFileSync(path.join(dir, 'routes', `${op}.csv`), text || '');
    console.log(`${op}: ${text ? text.split('\n').length : 0} lines`);
  }
}

// Pairs of `routes` ({ AAA: { BBB: [...] } }) with an airport of `hubs` at one end.
function hubPairs(routes, hubs) {
  const out = {};
  for (const [a, m] of Object.entries(routes)) {
    for (const [b, list] of Object.entries(m)) if (hubs.has(a) || hubs.has(b)) (out[a] ||= {})[b] = list;
  }
  return out;
}

function main(dir, fetched) {
  const root = path.join(__dirname, '..');
  const read = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
  const members = read('data/alliances.json').alliances.find((a) => a.id === 'skyteam').members;
  const carriers = [...members].sort();
  const operators = Object.fromEntries(Object.entries(OPERATORS).filter(([, c]) => carriers.includes(c)));
  const hubs = new Set(read('data/split-hubs.json').airlines.filter((a) => members.includes(a.code)).flatMap((a) => a.hubs));
  const ap = read('public/airports.min.json');
  const keep = new Set(ap.airports.map((r) => r[0]));
  const group = new Map(ap.groups.flatMap((g) => g.codes.map((c) => [c, g.en])));
  const patterns = {};
  for (const r of B.parseCsv(fs.readFileSync(path.join(dir, 'airlines.csv'), 'utf8'))) {
    if (!operators[r.ICAO]) continue;
    const res = [r.PositioningFlightPattern, r.CharterFlightPattern].filter(Boolean).map((p) => new RegExp(/^\^/.test(p) ? p : `^${p}$`));
    if (res.length) patterns[r.ICAO] = res;
  }
  const rows = Object.keys(operators).flatMap((op) => {
    const f = path.join(dir, 'routes', `${op}.csv`);
    return fs.existsSync(f) ? B.parseCsv(fs.readFileSync(f, 'utf8')) : [];
  });
  const routes = hubPairs(B.buildRoutes(rows, {
    icaoToIata: B.icaoMap(B.parseCsv(fs.readFileSync(path.join(dir, 'ourairports.csv'), 'utf8'))),
    keep, cityOf: (c) => group.get(c) || c, patterns, operators, regional: REGIONAL, nonPassenger: NON_PASSENGER, stale: [],
  }), hubs);
  const pairs = Object.values(routes).reduce((n, x) => n + Object.keys(x).length, 0);
  const out = {
    note: '天合聯盟樞紐和其他機場之間有哪些天合聯盟航空公司直飛（兩個方向都有紀錄才算）。資料來自飛機愛好者以 ADS-B 收集的航班呼號航線，不是航空公司的時刻表：可能漏掉新航線，也可能留著已停飛、季節性或貨運的航線。',
    source: { label: 'Virtual Radar Server standing data（航班呼號航線）', url: 'https://github.com/vradarserver/standing-data', licence: 'CC0 1.0', fetched },
    airportCodes: { label: 'OurAirports（ICAO 轉 IATA 機場代碼）', url: 'https://ourairports.com/data/', licence: 'Public domain', fetched },
    method: METHOD,
    carriers,
    hubs: [...hubs].sort(),
    pairs,
    routes: B.packRoutes(routes),
  };
  const file = path.join(root, 'data', 'skyteam-routes.json');
  fs.writeFileSync(file, `${JSON.stringify(out, null, 0).replace(/,"(?=[A-Z]{3}":)/g, ',\n"')}\n`);
  const missing = carriers.filter((c) => !Object.values(routes).some((x) => Object.values(x).some((l) => l.includes(c))));
  console.log(`wrote ${pairs} airport pairs (${fs.statSync(file).size} bytes) to ${path.relative(process.cwd(), file)}${missing.length ? `; no routes for ${missing.join(', ')}` : ''}`);
}

if (require.main === module) {
  const [a, b] = process.argv.slice(2);
  if (a === '--download' && b) download(b).catch((e) => { console.error(e); process.exit(1); });
  else if (a && fs.existsSync(a)) main(a, b || new Date().toISOString().slice(0, 10));
  else {
    console.error('usage: node scripts/build-skyteam-routes.js --download <dir>   then   node scripts/build-skyteam-routes.js <dir> [YYYY-MM-DD]');
    process.exit(1);
  }
}

module.exports = { OPERATORS, REGIONAL, NON_PASSENGER, hubPairs };
