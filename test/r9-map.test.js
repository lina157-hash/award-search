// Round 9 距離與地圖 (public/mapkit.js with features.js and app.js helpers): pasted gcmap-style routes, 級距邊緣提醒,
// the other Taiwan airports, 可搭直飛 tags, the 經過 comparison, 兌換地圖's rings and flight-time estimates, and the
// route generator's new freighter rules.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const B = require('../scripts/build-rtw-routes.js');

const read = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', f), 'utf8'));
const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
function grab(file, re) {
  const m = src(file).match(re);
  assert.ok(m, `${re} in ${file}`);
  return m[0];
}
const apRows = require('../public/airports.min.json').airports;
const byCode = new Map(apRows.map(([code, , , country, , , , , lat, lon]) => [code, { code, country, lat, lon }]));
const fmt = (n) => Number(n).toLocaleString('en-US');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// A context with the real data and the real route file, or `routes` (a stub nonstop table) in its place.
function kit(routes = read('rtw-routes.json')) {
  const ctx = {
    data: { charts: read('charts.json'), asiamiles: read('asiamiles.json'), programs: read('programs.json'), airlines: read('airlines.json'), alliances: read('alliances.json') },
    AP: { byCode }, fmt, esc, console,
    SOURCE_NAMES: {}, EXTRA_PROGRAM_NAMES: {}, CABIN_SHORT: { Y: '經濟', W: '豪經', J: '商務', F: '頭等' },
    airlineZh: (c) => c, airportCity: (c) => c, programName: (k) => k, CONFIDENCE_TAG: {},
    chartProgram: (id, name) => ({ name: name || id, variant: '' }),
    rmap: { origins: ['TPE'], cabin: 'J', trip: 'ow', program: '', budget: 0, direct: false, air: '' },
  };
  vm.createContext(ctx);
  vm.runInContext([
    grab('features.js', /function haversineMiles\(a, b\) \{[\s\S]*?\n\}/),
    grab('features.js', /function inArea\(area, ap\) \{[\s\S]*?\n\}/),
    grab('features.js', /function regionOf\(regions, ap\) \{[\s\S]*?\n\}/),
    grab('features.js', /const bandFor = .*;/),
    grab('features.js', /const bandNote = .*;/),
    grab('features.js', /function alaskaArea\(a, b\) \{[\s\S]*?\n\}/),
    grab('features.js', /function chartPrices\(p, from, to, cabin, dist\) \{[\s\S]*?\n\}/),
    grab('features.js', /function amRoutePrices\(a, b, dist, cabin\) \{[\s\S]*?\n\}/),
    grab('features.js', /const nonstopKey = [^\n]*/),
    grab('features.js', /function nonstopIndex\(raw\) \{[\s\S]*?\n\}/),
    grab('features.js', /function nonstopCarriers\(a, b\) \{[^\n]*/),
    grab('features.js', /const miKm = [^\n]*/),
    grab('app.js', /function allianceCarriers\(id\) \{[\s\S]*?\n\}/),
    grab('app.js', /function amBand\(dist, o, d\) \{[\s\S]*?\n\}/),
    grab('app.js', /function amPrice\(kind, dist, cabin, o, d\) \{[\s\S]*?\n\}/),
    grab('app.js', /const AM_HUB = [^\n]*/),
    grab('app.js', /function amCxDist\([\s\S]*?\n\}/),
    grab('app.js', /function parseRouteText\(v\) \{[\s\S]*?\n\}/),
    'const AM_VIA_TEXT = "經香港";',
    'let nonstopData = null;',
    src('mapkit.js'),
    'this.K = { parseRouteText, nonstopIndex, chartPrices, mkEdge, mkEdgeText, mkBandText, mkChartCarriers, mkDirect, mkDirectTag, mkAltAirports, mkReach, mkReachText, mkHours, mkRouteQuote, mkCompareHtml, mkRingBands, mkCircle, mkArc, mkSplit, miKm, haversineMiles, setNonstop: (raw) => { nonstopData = Object.assign(nonstopIndex(raw), { meta: { source: raw.source } }); } };',
  ].join('\n'), ctx);
  ctx.K.setNonstop(routes);
  return ctx.K;
}
const K = kit();
const ap = (c) => byCode.get(c);
const plain = (x) => JSON.parse(JSON.stringify(x));

// ---------- #22 pasted routes ----------
test('#22: gcmap-style routes parse into stops; plain lists and single codes are not routes', () => {
  const p = (s) => plain(K.parseRouteText(s));
  assert.deepEqual(p('TPE-YVR'), { routes: [[['TPE'], ['YVR']]], spaced: false });
  assert.deepEqual(p('tpe yvr'), { routes: [[['TPE'], ['YVR']]], spaced: true });
  assert.deepEqual(p('TPE→YVR,YYZ'), { routes: [[['TPE'], ['YVR', 'YYZ']]], spaced: false });
  assert.deepEqual(p('TPE-YVR/YYZ'), { routes: [[['TPE'], ['YVR', 'YYZ']]], spaced: false });
  assert.deepEqual(p('TPE-HKG-LHR, TPE-LHR'), { routes: [[['TPE'], ['HKG'], ['LHR']], [['TPE'], ['LHR']]], spaced: false });
  assert.deepEqual(p('tpe > hkg -> lhr'), { routes: [[['TPE'], ['HKG'], ['LHR']]], spaced: false });
  assert.deepEqual(p('台北-東京'), { routes: [[['台北'], ['東京']]], spaced: false });
  for (const s of ['TPE', 'HKG, NRT', 'TPE TSA KHH', '', '-TPE', 'TPE-']) assert.equal(K.parseRouteText(s), null, s);
});

// ---------- #3 band edges ----------
test('#3: a distance just over a band edge or just under the next one gets a line; close calls defer to the airline', () => {
  const am = read('asiamiles.json').bands;
  assert.deepEqual(plain(K.mkEdge(am, 808)), { over: 58, edge: 750 }); // TPE→FUK, 58 over ultra-short
  assert.deepEqual(plain(K.mkEdge(am, 2740)), { left: 11, edge: 2750 });
  assert.equal(K.mkEdge(am, 1500), null);
  assert.equal(K.mkEdge(am, 9000), null, 'the open top band has no next one');
  assert.equal(K.mkEdgeText(K.mkEdge(am, 808), 808), '808 哩：剛超過 750 哩級距 58 哩，價格算下一級');
  assert.match(K.mkEdgeText(K.mkEdge(am, 2740), 2740), /^2,740 哩：再 11 哩就會跳到下一級，轉機繞路要小心（差距很小，以航空公司計算為準）$/);
  const ba = read('charts.json').programs.find((p) => p.id === 'british').tables[0].bands;
  assert.deepEqual(plain(K.mkEdge(ba, ba[0].upTo + 17)), { over: 17, edge: ba[0].upTo });
  assert.equal(K.mkBandText(am, 3000), '2,751–5,000 哩級距（中程）');
  assert.equal(K.mkBandText(am, 9000), '7,501 哩以上（最高級距）');
});

test('#3: another Taiwan airport is offered only when the same chart costs less and a flight it prices goes there nonstop', () => {
  // Stub tables: KHH–MNL flown by Cathay (on the Avios chart), TSA–MNL only by China Airlines (not on it).
  const k = kit({ routes: { KHH: 'MNL:CX', MNL: 'TSA:CI' } });
  const ba = read('charts.json').programs.find((p) => p.id === 'british');
  const cheapest = (a, b) => Math.min(...k.chartPrices(ba, ap(a), ap(b), 'J', k.haversineMiles(ap(a), ap(b))).map((x) => x.miles));
  const row = { key: 'british', kind: '', miles: cheapest('TPE', 'MNL') };
  const alt = plain(k.mkAltAirports(row, ap('TPE'), ap('MNL'), 'J'));
  assert.equal(alt.length, 1);
  assert.equal(alt[0].code, 'KHH');
  assert.equal(alt[0].miles, cheapest('KHH', 'MNL'));
  assert.equal(alt[0].save, row.miles - alt[0].miles);
  assert.ok(alt[0].save > 0 && alt[0].dist < k.haversineMiles(ap('TPE'), ap('MNL')));
  // The other way: flying home to Kaohsiung instead.
  const back = plain(k.mkAltAirports({ ...row, miles: cheapest('MNL', 'TPE') }, ap('MNL'), ap('TPE'), 'J'));
  assert.deepEqual([back[0].code, back[0].to], ['KHH', true]);
  // Without a nonstop the chart prices there is nothing to offer, and a trip not touching Taiwan gets none.
  assert.deepEqual(plain(kit({ routes: { MNL: 'TSA:CI' } }).mkAltAirports(row, ap('TPE'), ap('MNL'), 'J')), []);
  assert.deepEqual(plain(k.mkAltAirports(row, ap('HKG'), ap('MNL'), 'J')), []);
});

// ---------- #25 可搭直飛 ----------
test('#25: each chart books its own airlines: own flights, partners, or both; Cathay keeps its Hong Kong pricing', () => {
  const set = (id, kind) => [...K.mkChartCarriers(id, kind)].sort();
  assert.deepEqual(set('eva'), ['BR']);
  assert.deepEqual(set('ci'), ['AE', 'CI']);
  assert.deepEqual(set('asiamiles', 'cx'), ['CX']);
  assert.ok(!set('asiamiles', 'partner').includes('CX') && set('asiamiles', 'partner').includes('JL'));
  assert.ok(set('ana').includes('BR') && !set('ana').includes('NH'), 'ANA partner chart: not ANA itself');
  assert.ok(set('british').includes('CX') && !set('british').includes('BA'));
  assert.ok(set('alaska').includes('JX') && !set('etihad').includes('JX'), 'Etihad has not published Starlux prices');
  assert.deepEqual(plain(K.mkDirect('eva', '', 'TPE', 'LHR')), { direct: ['BR'], others: ['CI'] });
  const ba = plain(K.mkDirect('british', '', 'TPE', 'LHR'));
  assert.deepEqual(ba.direct, []);
  assert.deepEqual(ba.others.sort(), ['BR', 'CI']);
  assert.match(K.mkDirectTag(ba), /需轉機（直飛的(長榮、華航|華航、長榮)不能搭）/);
  assert.match(K.mkDirectTag(K.mkDirect('asiamiles', 'cx', 'TPE', 'LHR', 'HKG')), /經香港轉機計價/);
  assert.match(K.mkDirectTag(K.mkDirect('eva', '', 'TPE', 'LHR')), /可搭直飛：長榮/);
});

// ---------- #30 flight time ----------
test('#30: flight time by distance, nonstop first, else one stop through a hub both legs reach', () => {
  assert.equal(K.mkHours(6079), 12.5);
  assert.equal(K.mkHours(150), 1);
  const r = plain(K.mkReach([ap('TPE')], [ap('LHR')]));
  assert.equal(r.stops, 0);
  assert.ok(r.carriers.includes('BR'));
  assert.equal(K.mkReachText(r), '直飛約 12.5 小時');
  // Cathay only: through Hong Kong.
  const cx = plain(K.mkReach([ap('TPE')], [ap('LHR')], new Set(['CX'])));
  assert.equal(cx.stops, 1);
  assert.equal(cx.via, 'HKG');
  assert.equal(cx.hours, K.mkHours(K.haversineMiles(ap('TPE'), ap('HKG'))) + K.mkHours(K.haversineMiles(ap('HKG'), ap('LHR'))) + 2);
  assert.equal(plain(K.mkReach([ap('TPE')], [ap('LHR')], new Set(['ZZ']))).stops, 2);
});

// ---------- #4 經過 comparison ----------
test('#4: a connection is priced by each program\'s own rule', () => {
  const direct = K.mkRouteQuote(['TPE', 'LHR'], 'J', false);
  const hkg = K.mkRouteQuote(['TPE', 'HKG', 'LHR'], 'J', false);
  const d = (a, b) => K.haversineMiles(ap(a), ap(b));
  assert.equal(hkg.total, d('TPE', 'HKG') + d('HKG', 'LHR'));
  assert.deepEqual(plain(hkg.legs), [d('TPE', 'HKG'), d('HKG', 'LHR')]);
  // Avios: each segment on its own, and dearer than the nonstop.
  const ba = hkg.cells.get('british');
  assert.match(ba.note, /^每段分開計價：[\d,]+ \+ [\d,]+$/);
  assert.ok(ba.miles > direct.cells.get('british').miles);
  // Asia Miles on Cathay: the nonstop column already goes through Hong Kong, so the two match.
  assert.equal(direct.cells.get('asiamiles:cx').miles, hkg.cells.get('asiamiles:cx').miles);
  assert.equal(direct.cells.get('asiamiles:cx').d, hkg.total);
  // Zone charts look only at the ends.
  assert.equal(hkg.cells.get('eva').miles, direct.cells.get('eva').miles);
  // Round trip: one-ways doubled; 日航寰宇一家 only then.
  assert.ok(!direct.cells.has('jal_partner'));
  const rt = K.mkRouteQuote(['TPE', 'LHR'], 'J', true);
  assert.equal(rt.cells.get('eva').miles, direct.cells.get('eva').miles * 2);
  assert.ok(rt.cells.has('jal_partner'));
  const html = K.mkCompareHtml(ap('TPE'), ap('LHR'), [['HKG']], 'J', false);
  assert.match(html, /比直飛多 7%/);
  assert.match(html, /合計 6,079 哩（9,783 公里）/);
});

// ---------- #10 rings ----------
test('#10: band rings for distance charts only, at each band edge with the cabin price', () => {
  const am = plain(K.mkRingBands('asiamiles', 'J', 'ow', ap('TPE')));
  const chart = read('asiamiles.json');
  assert.deepEqual(am.map((r) => r.upTo), [750, 2750, 5000, 7500]);
  assert.equal(am[0].miles, chart.charts.cx.ultrashort.J);
  assert.equal(plain(K.mkRingBands('asiamiles', 'J', 'rt', ap('TPE')))[0].miles, chart.charts.cx.ultrashort.J * 2);
  assert.equal(K.mkRingBands('eva', 'J', 'ow', ap('TPE')), null, 'zone chart: no rings');
  assert.equal(K.mkRingBands('jal_partner', 'J', 'ow', ap('TPE')), null, 'round trip only');
  const jal = plain(K.mkRingBands('jal_partner', 'J', 'rt', ap('TPE')));
  const t = read('charts.json').programs.find((p) => p.id === 'jal_partner').tables[0].bands;
  assert.equal(jal[0].upTo, t[0].upTo / 2, 'round-trip total: the ring sits at half');
  // Geometry: a ring never jumps across the date line, and an arc ends where it should.
  const ring = K.mkCircle(ap('TPE'), 7500);
  for (const part of ring) for (let i = 1; i < part.length; i++) assert.ok(Math.abs(part[i][1] - part[i - 1][1]) < 180);
  const arc = K.mkArc(ap('TPE'), ap('LAX')).flat();
  const end = arc.at(-1);
  assert.ok(Math.abs(end[0] - ap('LAX').lat) < 0.05 && Math.abs(end[1] - ap('LAX').lon) < 0.05);
});

// ---------- the route file: new carriers and freighter rules ----------
test('route data: freighter flight numbers and cargo-only airports drop out', () => {
  const icao = new Map([['RCTP', 'TPE'], ['OMDB', 'DXB'], ['OMDW', 'DWC'], ['EGLL', 'LHR'], ['RKSI', 'ICN'], ['PANC', 'ANC']]);
  const keep = new Set(['TPE', 'DXB', 'DWC', 'LHR', 'ICN', 'ANC']);
  const row = (Callsign, AirlineCode, AirportCodes) => ({ Callsign, AirlineCode, AirportCodes });
  const out = plain(B.buildRoutes([
    row('UAE366', 'UAE', 'RCTP-OMDB'), row('UAE367', 'UAE', 'OMDB-RCTP'), // passenger: kept
    row('UAE9800', 'UAE', 'OMDW-EGLL'), row('UAE9801', 'UAE', 'EGLL-OMDW'), // Dubai World Central: cargo only
    row('KAL277', 'KAL', 'RKSI-PANC'), row('KAL278', 'KAL', 'PANC-RKSI'), // KE 2xx freighters
    row('CAL5', 'CAL', 'RCTP-EGLL'), row('CAL6', 'CAL', 'EGLL-RCTP'), // China Airlines: now in
  ], { icaoToIata: icao, keep }));
  assert.deepEqual(out, { DXB: { TPE: ['EK'] }, LHR: { TPE: ['CI'] } });
  assert.ok(B.NON_PASSENGER.KAL && B.NON_PASSENGER_AIRPORTS.UAE.includes('DWC'));
  for (const c of ['CI', 'JX', 'EK', 'EY']) assert.ok(Object.values(B.OPERATORS).includes(c), c);
});

test('route data: the file carries the new carriers and the CC0 source', () => {
  const ix = K.nonstopIndex(read('rtw-routes.json'));
  assert.ok(ix.pairs.get('DXB TPE').includes('EK'));
  assert.ok(ix.pairs.get('AUH TPE').includes('EY'));
  assert.ok(ix.pairs.get('NRT TPE').includes('JX'));
  assert.ok(ix.pairs.get('LHR TPE').includes('CI'));
  assert.equal(ix.source.licence, 'CC0 1.0');
  assert.ok(fs.statSync(path.join(__dirname, '..', 'data', 'rtw-routes.json')).size < 120000, 'kept small');
});
