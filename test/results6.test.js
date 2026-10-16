// Round 6, route results and flight details: 來回配對 (N5), 什麼時候放位 lead-time buckets (N9), 哩數水準 (N10),
// 全家湊位 差一點 (N12), 這班還可以用 (N3) and 混艙 (N15).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
delete process.env.SEATS_AERO_API_KEY;
const { server } = require('../server');
const H = require('../lib/history');
const { memoryKv } = require('../lib/kv');
const { normalizeTrips } = require('../lib/seats');
const P = require('../public/pairing.js');
const F = require('../public/flightplus.js');
const AIRPORTS = require('../public/airports.min.json');

const read = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', f), 'utf8'));
let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

const seat = (miles, seats = 2, taxes = null, airlines = 'BR') => ({ available: true, miles, seats, airlines, taxes });
const row = (date, source, miles, { seats = 2, taxes = null, o = 'TPE', d = 'YVR', c = 'J', airlines = 'BR', estimate = false } = {}) =>
  ({ id: `${o}${d}${date}${source}`, date, origin: o, destination: d, source, ...(estimate ? { estimate: true } : {}), cabins: { [c]: seat(miles, seats, taxes, airlines) } });

// ---------- 來回配對 ----------
test('pairing: cheapest seat per date, party size and estimates respected, taxes break ties', () => {
  const twd = P.pairTwd({ rates: { USD: 32, TWD: 1 } });
  const rows = [
    row('2026-11-01', 'aeroplan', 70000, { taxes: { amount: 100, currency: 'USD' } }),
    row('2026-11-01', 'united', 70000, { taxes: { amount: 2000, currency: 'TWD' } }), // same miles, lower NT$ taxes
    row('2026-11-01', 'lifemiles', 60000, { seats: 1 }), // too few for two people
    row('2026-11-02', 'asiamiles_est', 40000, { estimate: true }),
    row('2026-11-02', 'turkish', 55000, { seats: 0 }), // unknown count passes, as on the page
  ];
  const best = P.pairBest(rows, 'J', 2, twd);
  assert.deepEqual([...best.keys()], ['2026-11-01', '2026-11-02']);
  assert.equal(best.get('2026-11-01').row.source, 'united');
  assert.equal(best.get('2026-11-01').tax, 2000);
  assert.equal(best.get('2026-11-02').row.source, 'turkish');
  assert.equal(P.pairBest(rows, 'J', 1, twd).get('2026-11-01').row.source, 'lifemiles', 'one person: the 1-seat flight counts');
  assert.equal(twd({ amount: 10.5, currency: 'usd' }), 336);
  assert.equal(twd({ amount: 10, currency: 'XYZ' }), null);
});

test('pairing: outbound date × stay length, programs mixed, cheapest first; range and calls of the return search', () => {
  const out = P.pairBest([row('2026-11-01', 'aeroplan', 70000), row('2026-11-03', 'united', 60000)], 'J');
  const back = P.pairBest([
    row('2026-11-06', 'lifemiles', 50000, { o: 'YVR', d: 'TPE' }), // 11/1 + 5, 11/3 + 3
    row('2026-11-08', 'alaska', 45000, { o: 'YVR', d: 'TPE' }), // 11/1 + 7, 11/3 + 5
    row('2026-11-20', 'alaska', 30000, { o: 'YVR', d: 'TPE' }), // no stay picked reaches it
  ], 'J');
  const combos = P.pairCombos(out, back, [3, 5, 7]);
  assert.deepEqual(combos.map((k) => [k.date, k.stay, k.back, k.miles, k.out.row.source, k.ret.row.source]), [
    ['2026-11-03', 5, '2026-11-08', 105000, 'united', 'alaska'],
    ['2026-11-03', 3, '2026-11-06', 110000, 'united', 'lifemiles'],
    ['2026-11-01', 7, '2026-11-08', 115000, 'aeroplan', 'alaska'],
    ['2026-11-01', 5, '2026-11-06', 120000, 'aeroplan', 'lifemiles'],
  ]);
  assert.equal(combos[0].tax, null, 'taxes unknown on a leg: no total');
  assert.deepEqual(P.pairCombos(out, back, []), []);
  // Taxes add up only when both legs have an NT$ amount, and order equal miles.
  const tw = (n) => ({ amount: n, currency: 'TWD' });
  const o2 = P.pairBest([row('2026-12-01', 'a', 50000, { taxes: tw(3000) }), row('2026-12-02', 'b', 50000, { taxes: tw(1000) })], 'J', 1, P.pairTwd({ rates: { TWD: 1 } }));
  const b2 = P.pairBest([row('2026-12-08', 'c', 50000, { taxes: tw(500) }), row('2026-12-09', 'c', 50000, { taxes: tw(500) })], 'J', 1, P.pairTwd({ rates: { TWD: 1 } }));
  assert.deepEqual(P.pairCombos(o2, b2, [7]).map((k) => [k.date, k.tax]), [['2026-12-02', 1500], ['2026-12-01', 3500]]);
  // The return search covers every stay of every outbound date, at most a year.
  assert.deepEqual(P.pairRange('2026-11-01', '2026-11-30'), { start: '2026-11-04', end: '2026-12-14' });
  assert.deepEqual(P.pairRange('2026-11-01', '2027-10-31'), { start: '2026-11-04', end: '2027-11-04' });
  assert.equal(P.pairCalls('2026-11-04', '2026-12-14'), 1);
  assert.equal(P.pairCalls('2026-11-04', '2027-11-04'), 3);
  assert.equal(P.pairAddDays('2026-12-30', 3), '2027-01-02');
});

// ---------- 什麼時候放位 ----------
test('lead time: buckets of days before departure', () => {
  assert.deepEqual([0, 13, 14, 59, 60, 179, 180, 299, 300, 400].map(H.leadBucket), [0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
  const set = new Set([500, 501, 507, 899]);
  assert.deepEqual([...H.unpackDays(H.packDays(set, 500, 400))].sort((a, b) => a - b), [500, 501, 507, 899]);
  assert.equal(H.packDays(new Set([100]), 200, 400), null, 'days before the base are dropped');
  assert.deepEqual(F.leadMain([8, 2, 1, 1, 0]), { i: 0, k: 8, n: 12 });
  assert.deepEqual(F.leadMain([2, 2, 1, 1, 0]), { i: -1, k: 0, n: 6 });
});

test('lead time: a date counts once, only when a complete look of the last week saw it without space', () => {
  const today = H.dayNum('2026-10-16');
  const iso = (n) => H.isoOf(today + n);
  const params = (days) => ({ origin_airport: 'TPE', destination_airport: 'YVR', cabins: 'business', start_date: iso(1), end_date: iso(days) });
  const look1 = H.seenDays(params(60), [row(iso(10), 'aeroplan', 70000), row(iso(70), 'aeroplan', 70000)], { today });
  assert.deepEqual(look1.look, { cabins: ['J'], from: today + 1, to: today + 60 });
  assert.deepEqual([...look1.seen.get('TPE-YVR').get('aeroplan.J')], [today + 10, today + 70]);
  // First look: only remembered.
  let lead = H.mergeLead(null, today, look1.seen.get('TPE-YVR'), look1.look);
  assert.deepEqual(lead.b, {});
  // Next day: 11 days out is new (had no space yesterday), 70 days out was already known, 80 days out was outside
  // yesterday's range, and the known 10-day date is not counted again.
  const look2 = H.seenDays(params(90), [row(iso(10), 'aeroplan', 70000), row(iso(11), 'aeroplan', 70000), row(iso(45), 'united', 80000), row(iso(70), 'aeroplan', 70000), row(iso(80), 'aeroplan', 70000)], { today: today + 1 });
  lead = H.mergeLead(lead, today + 1, look2.seen.get('TPE-YVR'), look2.look);
  assert.deepEqual(lead.b, { 'aeroplan.J': [1, 0, 0, 0, 0], 'united.J': [0, 1, 0, 0, 0] });
  // A cut page (no look) still finds new dates against the earlier complete looks, but does not become one.
  const cut = H.seenDays(params(90), [row(iso(85), 'aeroplan', 70000)], { today: today + 2 });
  lead = H.mergeLead(lead, today + 2, cut.seen.get('TPE-YVR'), null);
  assert.deepEqual(lead.b['aeroplan.J'], [1, 0, 1, 0, 0]);
  assert.equal(lead.k.J[0][0], today + 1, 'the last complete look stays the comparison');
  // Looks older than a week no longer count; past days fall out of the known set.
  const late = H.mergeLead(lead, today + 30, new Map([['aeroplan.J', new Set([today + 40])]]), null);
  assert.deepEqual(late.k, {});
  assert.deepEqual(late.b['aeroplan.J'], [1, 0, 1, 0, 0]);
  assert.ok([...H.unpackDays(late.f['aeroplan.J'])].every((d) => d >= today + 30));
  // A search narrowed to some programs or airlines can't say a date had no space anywhere.
  assert.equal(H.seenDays({ ...params(60), sources: 'aeroplan' }, [], { today }).look, null);
  assert.equal(H.seenDays({ ...params(60), carriers: 'BR' }, [], { today }).look, null);
  assert.equal(H.seenDays({ origin_airport: 'TPE', destination_airport: 'YVR' }, [], { today }).look, null, 'no range given');
});

test('lead time: series and byte caps; stored with the route history and shown by /api/history', async () => {
  const today = 20000;
  const many = new Map(Array.from({ length: 40 }, (_, i) => [`p${i}.J`, new Set(Array.from({ length: 50 }, (_, j) => today + 1 + j * 7))]));
  const capped = H.mergeLead(null, today, many, { cabins: ['J'], from: today + 1, to: today + 400 });
  assert.ok(Object.keys(capped.f).length <= 30);
  assert.ok(JSON.stringify(capped).length <= 4000);
  // Through note(): two days of the daily job, then the page's view.
  let t = Date.parse('2026-10-16T04:00:00Z');
  const kv = memoryKv();
  const h = H.createHistory({ kv, now: () => t });
  const p = { origin_airport: 'TPE', destination_airport: 'YVR', cabins: 'business', start_date: '2026-10-17', end_date: '2027-01-31' };
  await h.note(p, [row('2026-12-01', 'aeroplan', 70000)]);
  t += 864e5;
  await h.note({ ...p, start_date: '2026-10-18' }, [row('2026-12-01', 'aeroplan', 70000), row('2026-10-25', 'aeroplan', 70000), row('2026-12-24', 'united', 80000)]);
  const { routes } = await h.get('TPE', 'YVR');
  assert.equal(routes[0].lead.since, '2026-10-16');
  assert.deepEqual(routes[0].lead.series, [{ source: 'aeroplan', cabin: 'J', b: [1, 0, 0, 0, 0], n: 1 }, { source: 'united', cabin: 'J', b: [0, 0, 1, 0, 0], n: 1 }]);
  // A page cut at its limit records no new comparison point.
  t += 864e5;
  await h.note({ ...p, start_date: '2026-10-19' }, [row('2026-11-30', 'aeroplan', 70000)], { hasMore: true });
  const rec = await kv.get('hist:v1:TPE-YVR');
  assert.equal(rec.lead.k.J[0][0], H.dayNum('2026-10-17'));
  assert.ok(JSON.stringify(rec).length <= 16000);
  // The demo shows made-up counts.
  const body = await (await fetch(`${base}/api/history?origin=TPE&destination=YVR`)).json();
  assert.ok(body.routes[0].lead.series.some((s) => s.cabin === 'J' && s.n >= 5));
});

// ---------- 哩數水準 ----------
test('price level: cheap, usual, dear and fixed against the daily lowest miles; nothing when history is thin', () => {
  const hist = [60000, 70000, 70000, 70000, 75000, 80000, 90000, 70000];
  assert.equal(F.priceLevel(70000, hist.slice(0, 6)), null, 'six days with space say too little');
  assert.equal(F.priceLevel(null, hist), null);
  assert.deepEqual(F.priceLevel(55000, hist), { level: 'cheap', usual: 70000, n: 8 });
  assert.equal(F.priceLevel(70000, hist).level, 'normal');
  assert.equal(F.priceLevel(67000, hist).level, 'normal', 'within 5% of the usual price');
  assert.equal(F.priceLevel(90000, hist).level, 'dear');
  assert.equal(F.priceLevel(70000, hist, { fixed: true }).level, 'fixed', 'a fixed chart at its usual price');
  assert.equal(F.priceLevel(90000, hist, { fixed: true }).level, 'dear', 'a fixed chart above it (its own dynamic seats)');
  assert.equal(F.priceLevel(87500, Array(9).fill(87500)).level, 'fixed', 'history that never moved');
  assert.equal(F.priceLevel(75000, Array(9).fill(87500)).level, 'cheap');
  // Fixed-chart programs come from charts.json.
  const fixed = F.fixedChartIds(read('charts.json'));
  for (const id of ['aeroplan', 'alaska', 'british', 'singapore', 'turkish']) assert.ok(fixed.has(id), id);
  for (const id of ['united', 'delta', 'flyingblue', 'lifemiles', 'virginatlantic']) assert.ok(!fixed.has(id), id);
  // The server's usual price for 今日好康 cards: the lower median, from 7 days with space.
  const pts = (list) => list.map((m, i) => [100 + i, 1, m, 2]);
  assert.equal(H.usualMiles(pts([1, 2, 3, 4, 5, 6])), null);
  assert.equal(H.usualMiles(pts([80000, 60000, 70000, 70000, 90000, 75000, 65000, 72000])), 70000);
  assert.equal(H.usualMiles(pts([1, 1, 1, 9, 9, 9, 9, 9]), { from: 102 }), null, 'only days from `from` on');
});

test('price level: the deals carry 「平常約」 from the route history; thin routes none', async () => {
  let t = Date.parse('2026-10-16T04:00:00Z');
  const kv = memoryKv();
  const h = H.createHistory({ kv, now: () => t });
  const p = { origin_airport: 'TPE', destination_airport: 'NRT,LHR', cabins: 'business' };
  for (let i = 0; i < 8; i++) {
    await h.note(p, [row('2027-01-01', 'aeroplan', [70000, 75000][i % 2], { d: 'NRT' }), ...(i < 3 ? [row('2027-01-02', 'united', 90000, { d: 'LHR' })] : [])]);
    t += 864e5;
  }
  const u = await h.usual([{ origin: 'TPE', destination: 'NRT', source: 'aeroplan', cabin: 'J' }, { origin: 'TPE', destination: 'LHR', source: 'united', cabin: 'J' }, { origin: 'TPE', destination: 'SYD', source: 'qantas', cabin: 'J' }]);
  assert.deepEqual(u, [70000, null, null]);
  const body = await (await fetch(`${base}/api/deals`)).json();
  const items = body.groups.flatMap((g) => g.items);
  assert.ok(items.some((x) => x.usual > 0), 'the demo history gives some deals a usual price');
  assert.ok(items.every((x) => x.usual == null || Number.isInteger(x.usual)));
});

// ---------- 差一點 ----------
test('seat gaps: flights the party-size filter hid, grouped per flight; none when another program has enough', () => {
  const rows = [
    row('2026-11-01', 'aeroplan', 70000, { seats: 2, airlines: 'BR' }),
    row('2026-11-01', 'united', 80000, { seats: 3, airlines: 'BR' }), // same BR flight: one line, most seats first
    row('2026-11-02', 'lifemiles', 60000, { seats: 1, airlines: 'NH' }),
    row('2026-11-02', 'aeroplan', 70000, { seats: 2, airlines: 'BR' }),
    row('2026-11-02', 'turkish', 65000, { seats: 4, airlines: 'BR' }), // enough on that flight: BR 11/2 is not short
    row('2026-11-03', 'alaska', 50000, { seats: 0, airlines: 'JX' }), // unknown count: shown on the page already
    row('2026-11-04', 'asiamiles_est', 40000, { seats: 1, estimate: true }),
  ];
  const g = F.seatGaps(rows, 'J', 4);
  assert.equal(g.total, 2);
  assert.deepEqual(g.list.map((x) => [x.date, x.airlines, x.seats, x.short, x.programs.map((p) => p.source)]), [
    ['2026-11-01', 'BR', 3, 1, ['united', 'aeroplan']],
    ['2026-11-02', 'NH', 1, 3, ['lifemiles']],
  ]);
  assert.deepEqual(F.seatGaps(rows, 'J', 1), { list: [], total: 0 }, 'one person: nothing is hidden');
  assert.deepEqual(F.seatGaps(rows, 'Y', 4), { list: [], total: 0 });
  assert.equal(F.seatGaps(rows, 'J', 4, { limit: 1 }).list.length, 1);
});

// ---------- 這班還可以用 ----------
function chartTools() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'features.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const grab = (s, re) => { const m = s.match(re); assert.ok(m, String(re)); return m[0]; };
  const ctx = { data: { charts: read('charts.json') }, fmt: (n) => Number(n).toLocaleString('en-US') };
  vm.createContext(ctx);
  vm.runInContext([
    grab(src, /function haversineMiles\(a, b\) \{[\s\S]*?\n\}/), grab(src, /function inArea\(area, ap\) \{[\s\S]*?\n\}/),
    grab(src, /function regionOf\(regions, ap\) \{[\s\S]*?\n\}/), grab(src, /const bandFor = .*;/), grab(src, /const bandNote = .*;/),
    grab(src, /function alaskaArea\(a, b\) \{[\s\S]*?\n\}/), grab(src, /function chartPrices\(p, from, to, cabin, dist\) \{[\s\S]*?\n\}/),
    grab(app, /function calcConvert\(rate, amount, mode\) \{[\s\S]*?\n\}/),
    'this.tools = { chartPrices, haversineMiles, calcConvert };',
  ].join('\n'), ctx);
  return ctx.tools;
}
const AP = new Map(AIRPORTS.airports.map(([code, , , country, , , , , lat, lon]) => [code, { code, country, lat, lon }]));
const seg = (flight, from, to, distance) => ({ flight, from, to, distance });

test('also: which charts price the flight — partner charts of its alliance, own-airline charts, never its own program', () => {
  const members = Object.fromEntries(read('alliances.json').alliances.map((a) => [a.id, a.members]));
  const ids = (segs, source = 'united') => F.alsoProgramIds({ source, segments: segs }, members).sort();
  assert.deepEqual(ids([seg('BR10', 'TPE', 'YVR')]), ['aeroplan', 'ana', 'eva', 'singapore', 'turkish']);
  assert.deepEqual(ids([seg('BR10', 'TPE', 'YVR')], 'aeroplan'), ['ana', 'eva', 'singapore', 'turkish'], 'the trip\'s own program left out');
  assert.deepEqual(ids([seg('BR10', 'TPE', 'SFO'), seg('UA1', 'SFO', 'IAH')]), ['aeroplan', 'ana', 'singapore', 'turkish'], 'EVA miles do not cover United');
  assert.deepEqual(ids([seg('CX400', 'TPE', 'HKG')], 'alaska'), ['american', 'british']);
  assert.deepEqual(ids([seg('JX12', 'TPE', 'SFO')], 'alaska'), []);
  assert.deepEqual(ids([seg('JX12', 'TPE', 'SFO')], 'etihad'), ['alaska']);
  assert.deepEqual(ids([seg('CI4', 'TPE', 'SFO')], 'delta'), ['ci']);
  assert.deepEqual(ids([seg('AA1', 'JFK', 'LAX')], 'qantas'), ['alaska', 'british'], 'AAdvantage\'s partner chart does not price its own flights');
  assert.deepEqual(ids([seg('XX1', 'TPE', 'NRT')]), []);
});

test('also: the chart price for the whole trip, Avios per flight with each airline\'s table, and the card points it costs', () => {
  const T = chartTools();
  const charts = read('charts.json').programs;
  const p = (id) => charts.find((x) => x.id === id);
  const dep = { price: T.chartPrices, airport: (c) => AP.get(c) || null, dist: T.haversineMiles };
  // EVA's own chart from Taiwan: TPE–YVR business is the 美洲（其他） zone.
  const br = { source: 'aeroplan', cabin: 'business', miles: 87500, segments: [seg('BR10', 'TPE', 'YVR', 6359)] };
  const eva = p('eva').tables[0].zones.find((z) => z.name === '美洲（其他）').J;
  assert.equal(F.alsoEstimate(p('eva'), br, 'J', dep).miles, eva);
  assert.ok(F.alsoEstimate(p('singapore'), br, 'J', dep).miles > 0);
  // Avios: TPE–HKG on Cathay uses the Cathay table; two flights add up.
  const band = (label, d) => p('british').tables.find((t) => t.label.includes(label)).bands.find((b) => b.upTo == null || d <= b.upTo).J;
  const cx = { source: 'alaska', cabin: 'business', segments: [seg('CX400', 'TPE', 'HKG', 500)] };
  assert.equal(F.alsoEstimate(p('british'), cx, 'J', dep).miles, band('國泰', 500));
  const two = { source: 'alaska', cabin: 'business', segments: [seg('CX400', 'TPE', 'HKG', 500), seg('JL1', 'HKG', 'NRT', 1800)] };
  const est = F.alsoEstimate(p('british'), two, 'J', dep);
  assert.equal(est.miles, band('國泰', 500) + band('日本', 1800));
  assert.equal(est.multi, true);
  assert.equal(F.alsoEstimate(p('british'), cx, 'F', dep), null, 'a cabin the chart does not price');
  assert.equal(F.alsoEstimate(p('eva'), { source: 'x', segments: [seg('BR1', 'ZZZ', 'YVR')] }, 'J', dep), null, 'unknown airport');
  // Card points: one line per bank points program, fewest first; rates past their date left out.
  const map = { eva: { to: 'eva' }, singapore: { to: 'sq' }, ana: { name: '全日空' } };
  const sources = read('points.json').calc.sources;
  const banks = F.alsoBanks('eva', 75000, { sources, map, convert: T.calcConvert, today: '2026-10-16' });
  assert.ok(banks.length > 3);
  assert.ok(banks.every((b, i) => i === 0 || banks[i - 1].points <= b.points));
  assert.equal(new Set(banks.map((b) => b.source.id)).size, banks.length);
  const later = F.alsoBanks('eva', 75000, { sources, map, convert: T.calcConvert, today: '2099-01-01' });
  assert.ok(later.length < banks.length, 'expired tables drop out');
  assert.deepEqual(F.alsoBanks('alaska', 75000, { sources, map, convert: T.calcConvert, today: '2026-10-16' }), [], 'no Taiwan card transfers in');
  const fake = [{ id: 'x', bank: 'X', program: 'P', rates: [{ to: 'eva', points: 2, miles: 1, stepMiles: 1000 }, { to: 'eva', points: 3, miles: 1 }] }];
  assert.deepEqual(F.alsoBanks('eva', 10500, { sources: fake, map, convert: T.calcConvert, today: '2026-10-16' }).map((b) => b.points), [22000], 'the better rate of a bank, rounded up to its steps');
});

// ---------- 混艙 ----------
test('mixed cabin: the share flown below the cabin is kept; the details can ask for mixed itineraries', async () => {
  const t = normalizeTrips({ data: [{ ID: 'a', Cabin: 'business', MixedCabinPct: 18.4, AvailabilitySegments: [] }, { ID: 'b', Cabin: 'business', AvailabilitySegments: [] }, { ID: 'c', Cabin: 'business', MixedCabinPct: 0, AvailabilitySegments: [] }] }).trips;
  assert.deepEqual(t.map((x) => x.mixedPct), [18, undefined, undefined]);
  const plain = await (await fetch(`${base}/api/trips/mock-TPEYVR-2026-11-01-aeroplan`)).json();
  assert.ok(plain.trips.every((x) => !x.mixedPct));
  const r = await fetch(`${base}/api/trips/mock-TPEYVR-2026-11-01-aeroplan?mixed=1`, { redirect: 'manual' });
  assert.equal(r.status, 200, 'the mixed flag is a known parameter (not redirected away)');
  const mixed = (await r.json()).trips.filter((x) => x.mixedPct);
  assert.equal(mixed.length, 1);
  assert.equal(mixed[0].cabin, 'business');
  assert.equal(mixed[0].segments.length, 2);
});

test('round 6 results scripts load after the scripts they use', () => {
  // They come with the search scripts (app.js loadSearchScripts), which load after the tools (award-tools.js) and,
  // like every lazy script, after the page's own scripts (features.js); the route results wait for them.
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const search = JSON.parse(app.match(/const SEARCH_SCRIPTS = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
  assert.match(app, /const loadSearchScripts = \(\) => loadScripts\(\[\.\.\.TOOL_SCRIPTS, \.\.\.SEARCH_SCRIPTS\]\);/);
  for (const f of ['flightplus', 'pairing']) assert.ok(search.includes(f) && search.indexOf(f) < search.indexOf('seathistory'), f);
  assert.ok(search.indexOf('pairing') > search.indexOf('flightplus'));
});
