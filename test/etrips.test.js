// E9 stopover/open-jaw builder, E10 positioning picks, E14 Google Flights bookmarklet parsing.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const GF = require('../public/gflights.js');
const read = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', f), 'utf8'));
const routing = read('routing.json');
const charts = read('charts.json');
const TODAY = '2026-10-14';

// ---------- protobuf builder, the same wire format Google uses in tfs ----------
const varint = (n) => { const out = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 128; out.push(b); } while (n); return out; };
const fv = (f, n) => [...varint(f * 8), ...varint(n)];
const fb = (f, bytes) => [...varint(f * 8 + 2), ...varint(bytes.length), ...bytes];
const fs_ = (f, s) => fb(f, [...Buffer.from(s, 'utf8')]);
const place = (type, s) => [...fv(1, type), ...fs_(2, s)];
const leg = (date, from, to) => fb(3, [...fs_(2, date), ...from.flatMap((x) => fb(13, x)), ...to.flatMap((x) => fb(14, x))]);
const tfsOf = (bytes) => Buffer.from(bytes).toString('base64url');

test('E14: a real one-way tfs (SFO → JFK, economy, 1 adult) parses', () => {
  const p = GF.parseGoogleFlights('https://www.google.com/travel/flights/search?tfs=EAAaHhIKMjAyNi0wNy0xNWoHCAESA1NGT3IHCAESA0pGS0ABSAGYAQI&curr=USD&hl=en', {}, '2026-01-01');
  assert.deepEqual({ o: p.o, d: p.d, s: p.s, r: p.r, c: p.c, n: p.n }, { o: 'SFO', d: 'JFK', s: '2026-07-15', r: '', c: 'Y', n: 1 });
});

test('E14: round trip with airport codes, business, 2 adults (packed passengers) and the usual tail fields', () => {
  const bytes = [...fv(1, 28), ...fv(2, 2), ...leg('2026-12-01', [place(1, 'TPE')], [place(1, 'NRT')]), ...leg('2026-12-08', [place(1, 'NRT')], [place(1, 'TPE')]),
    ...fb(8, [1, 1]), ...fv(9, 3), ...fv(14, 1), ...fb(16, [8, ...varint(2 ** 32)]), ...fv(19, 1)];
  const url = `https://www.google.com/travel/flights/search?tfs=${tfsOf(bytes)}&tfu=EgYIABABGAA&hl=zh-TW&gl=TW&curr=TWD`;
  const p = GF.parseGoogleFlights(url, {}, TODAY);
  assert.deepEqual({ o: p.o, d: p.d, s: p.s, r: p.r, c: p.c, n: p.n }, { o: 'TPE', d: 'NRT', s: '2026-12-01', r: '2026-12-08', c: 'J', n: 2 });
  assert.equal(GF.searchTarget(p, TODAY), '/?o=TPE&d=NRT&s=2026-12-01&e=2026-12-01&c=J&n=2&gfr=2026-12-08#search');
});

test('E14: city ids (台北 → 東京) map to their airports; several origins are kept; unknown ids fall back to page text', () => {
  const city = [...fv(2, 2), ...leg('2026-11-20', [place(3, '/m/0ftkx')], [place(3, '/m/07dfk')]), ...fv(8, 1), ...fv(9, 1), ...fv(19, 2)];
  const a = GF.parseGoogleFlights(`https://www.google.com/travel/flights/search?tfs=${tfsOf(city)}`, {}, TODAY);
  assert.equal(a.o, 'TPE,TSA');
  assert.equal(a.d, 'NRT,HND');
  assert.equal(a.r, '');
  const multi = [...leg('2026-11-20', [place(1, 'TPE'), place(1, 'KHH')], [place(1, 'HKG')]), ...fv(19, 2)];
  assert.equal(GF.parseGoogleFlights(`https://www.google.com/travel/flights?tfs=${tfsOf(multi)}`, {}, TODAY).o, 'TPE,KHH');
  const unknown = [...leg('2026-11-20', [place(3, '/m/0ftkx')], [place(3, '/g/11b6x0qz1q')]), ...fv(19, 2)];
  const u = GF.parseGoogleFlights(`https://www.google.com/travel/flights?tfs=${tfsOf(unknown)}`, { v: ['台北', '札幌', '2026年11月20日'] }, TODAY);
  assert.equal(u.o, 'TPE,TSA');
  assert.equal(u.d, '');
  assert.equal(u.dText, '札幌');
  assert.equal(GF.searchTarget(u, TODAY), '/#gf?gfo=TPE%2CTSA&gfd=%E6%9C%AD%E5%B9%8C&gfs=2026-11-20');
});

test('E14: the ?q= text forms, the old #flt= form and page dates', () => {
  const q = (s, page) => GF.parseGoogleFlights(`https://www.google.com/travel/flights?q=${encodeURIComponent(s)}`, page, TODAY);
  let p = q('Flights to NRT from TPE on 2026-12-01 through 2026-12-08');
  assert.deepEqual([p.o, p.d, p.s, p.r], ['TPE', 'NRT', '2026-12-01', '2026-12-08']);
  p = q('Flights from TPE to LHR on 2027-01-05 one way business class');
  assert.deepEqual([p.o, p.d, p.s, p.r, p.c], ['TPE', 'LHR', '2027-01-05', '', 'J']);
  p = q('Flights from Taipei to Tokyo');
  assert.deepEqual([p.o, p.d, p.oText, p.dText], ['', '', 'Taipei', 'Tokyo']);
  p = q('從台北到東京的航班', { v: ['台北', '東京', 'Tue, Dec 1', 'Tue, Dec 8'] });
  assert.deepEqual([p.oText, p.dText, p.s, p.r], ['台北', '東京', '2026-12-01', '2026-12-08']);
  p = GF.parseGoogleFlights('https://www.google.com/flights#flt=TPE.NRT.2026-12-01*NRT.TPE.2026-12-08;c:TWD;e:1;sc:f;sd:1;t:f', {}, TODAY);
  assert.deepEqual([p.o, p.d, p.s, p.r, p.c], ['TPE', 'NRT', '2026-12-01', '2026-12-08', 'F']);
  assert.equal(GF.pageDate('12月1日 週二', TODAY), '2026-12-01');
  assert.equal(GF.pageDate('Jan 5', TODAY), '2027-01-05');
  assert.equal(GF.pageDate('5 Mar 2027', TODAY), '2027-03-05');
  assert.equal(GF.pageDate('Taipei', TODAY), '');
});

test('E14: broken or empty input never throws and still lands on the search page', () => {
  for (const href of ['https://www.google.com/travel/flights/search?tfs=%%%%', 'https://www.google.com/travel/flights/search?tfs=CBwQAhoe', 'not a url', '', 'https://www.google.com/travel/flights']) {
    const p = GF.parseGoogleFlights(href, { v: [] }, TODAY);
    assert.match(GF.searchTarget(p, TODAY), /^\/(\?.*#search|#gf\?.*)$/, href);
  }
  // A past date is dropped rather than sent to a search that would reject it.
  const old = GF.parseGoogleFlights('https://www.google.com/travel/flights?q=Flights%20to%20NRT%20from%20TPE%20on%202025-01-01', {}, TODAY);
  assert.equal(GF.searchTarget(old, TODAY), '/#gf?gfo=TPE&gfd=NRT');
});

test('E14: the bookmarklet is a small javascript: URL that runs and opens gf.html on this site', () => {
  const code = GF.bookmarkletCode('https://award.example');
  assert.match(code, /^javascript:/);
  assert.ok(code.length < 600, code.length);
  let opened = null;
  const ctx = { document: { querySelectorAll: () => [{ offsetParent: {}, value: '台北', type: 'text' }, { offsetParent: {}, value: 'x', type: 'password' }], title: 'Taipei to Tokyo | Google Flights' },
    location: { href: 'https://www.google.com/travel/flights/search?tfs=abc' }, window: { open: (u) => { opened = u; return {}; } }, encodeURIComponent, JSON };
  ctx.window.open = ctx.window.open.bind(ctx);
  vm.runInNewContext(code.slice('javascript:'.length).replace('window.open', 'window.open'), ctx);
  const u = new URL(opened);
  assert.equal(u.origin + u.pathname, 'https://award.example/gf.html');
  assert.equal(u.searchParams.get('u'), 'https://www.google.com/travel/flights/search?tfs=abc');
  assert.deepEqual(JSON.parse(u.searchParams.get('v')), ['台北']);
});

// ---------- the builder and positioning logic, run against the real charts and airports ----------
function grab(file, re) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
  const m = src.match(re);
  assert.ok(m, `${re} in ${file}`);
  return m[0];
}
const airports = require('../public/airports.min.json').airports;
const AP = new Map(airports.map(([code, , , country, , , , , lat, lon]) => [code, { code, country, lat, lon }]));
const apOf = (c) => AP.get(c) || null;
const ctx = { data: { charts, asiamiles: read('asiamiles.json') }, fmt: (n) => Number(n).toLocaleString('en-US'), console };
vm.createContext(ctx);
vm.runInContext([
  grab('features.js', /function haversineMiles\(a, b\) \{[\s\S]*?\n\}/),
  grab('features.js', /function inArea\(area, ap\) \{[\s\S]*?\n\}/),
  grab('features.js', /function regionOf\(regions, ap\) \{[\s\S]*?\n\}/),
  grab('features.js', /const bandFor = .*;/),
  grab('features.js', /const bandNote = .*;/),
  grab('features.js', /function alaskaArea\(a, b\) \{[\s\S]*?\n\}/),
  grab('features.js', /function chartPrices\(p, from, to, cabin, dist\) \{[\s\S]*?\n\}/),
  grab('app.js', /function amBand\(dist, o, d\) \{[\s\S]*?\n\}/),
  grab('app.js', /function amPrice\(kind, dist, cabin, o, d\) \{[\s\S]*?\n\}/),
  fs.readFileSync(path.join(__dirname, '..', 'public', 'etrips.js'), 'utf8'),
  'this.et = { etAnalyze, etEvaluate, etHubsFor, etBestFromHubs, chartPrices, haversineMiles };',
].join('\n'), ctx);
const { et } = ctx;
const rule = (id) => routing.programs.find((p) => p.id === id);
const L = (...pairs) => pairs.map(([from, to]) => ({ from, to }));
const chartMin = (id, a, b, cabin, dist) => Math.min(...et.chartPrices(charts.programs.find((p) => p.id === id), apOf(a), apOf(b), cabin, dist).map((x) => x.miles));

test('E9: Aeroplan one-way with a Tokyo stopover is one ticket: chart price plus 5,000', () => {
  const legs = L(['TPE', 'NRT'], ['NRT', 'YVR']);
  const r = et.etEvaluate(rule('aeroplan'), legs, 'J', apOf);
  assert.equal(r.trip.kind, 'ow');
  assert.deepEqual(JSON.parse(JSON.stringify(r.trip.stops)), [['NRT']]);
  assert.equal(r.verdict, 'ok');
  const dist = r.trip.dist[0] + r.trip.dist[1];
  assert.equal(r.price.miles, chartMin('aeroplan', 'TPE', 'YVR', 'J', dist) + 5000);
  // Two stops in the same direction are one too many.
  assert.equal(et.etEvaluate(rule('aeroplan'), L(['TPE', 'HKG'], ['HKG', 'NRT'], ['NRT', 'YVR']), 'J', apOf).verdict, 'split');
});

test('E9: programs without one-way stopovers say split and price the legs as separate one-ways', () => {
  const legs = L(['TPE', 'NRT'], ['NRT', 'YVR']);
  for (const id of ['asiamiles', 'american', 'singapore']) {
    const r = et.etEvaluate(rule(id), legs, 'J', apOf);
    assert.equal(r.verdict, 'split', id);
    assert.equal(r.price, null, id);
    assert.ok(r.lines.some((l) => l.ok === false && /中停/.test(l.text)), id);
  }
  const am = et.etEvaluate(rule('american'), legs, 'J', apOf);
  assert.equal(am.splitPrice.parts.length, 2);
  assert.equal(am.splitPrice.miles, chartMin('american', 'TPE', 'NRT', 'J', am.trip.dist[0]) + chartMin('american', 'NRT', 'YVR', 'J', am.trip.dist[1]));
  // Round-trip-only charts don't take a one-way at all.
  assert.equal(et.etEvaluate(rule('jal_partner'), legs, 'J', apOf).verdict, 'no');
});

test('E9: ANA round trip with a Tokyo stopover; turnaround is the farthest point', () => {
  const legs = L(['TPE', 'NRT'], ['NRT', 'HNL'], ['HNL', 'TPE']);
  const r = et.etEvaluate(rule('ana'), legs, 'J', apOf);
  assert.equal(r.trip.kind, 'rt');
  assert.equal(r.trip.turn, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(r.trip.stops)), [['NRT'], []]);
  assert.equal(r.trip.openJaws.length, 0);
  assert.equal(r.verdict, 'ok');
  assert.equal(r.price.parts.length, 2);
  assert.ok(r.price.miles > 0);
  // Asia Miles allows one stopover on a round trip, too; EVA can't stop in Taiwan.
  assert.equal(et.etEvaluate(rule('asiamiles'), legs, 'J', apOf).verdict, 'ok');
  const eva = et.etEvaluate(rule('evainfinity'), L(['NRT', 'TPE'], ['TPE', 'YVR'], ['YVR', 'NRT']), 'J', apOf);
  assert.equal(eva.verdict, 'split');
  assert.ok(eva.lines.some((l) => /不可在 TPE 中停/.test(l.text)));
});

test('E9: open jaws are counted at the turnaround and at the origin', () => {
  const legs = L(['TPE', 'SIN'], ['SIN', 'SYD'], ['MEL', 'TPE']);
  const r = et.etEvaluate(rule('singapore'), legs, 'J', apOf);
  assert.equal(r.trip.kind, 'rt');
  assert.equal(legs[r.trip.turn].to, 'SYD');
  assert.deepEqual(JSON.parse(JSON.stringify(r.trip.openJaws)), [{ at: 'turn', a: 'SYD', b: 'MEL' }]);
  assert.equal(r.verdict, 'ok');
  // Back to Kaohsiung: the same country still makes a round trip, now with two open jaws (one too many for KrisFlyer).
  const two = et.etEvaluate(rule('singapore'), L(['TPE', 'SIN'], ['SIN', 'SYD'], ['MEL', 'KHH']), 'J', apOf);
  assert.equal(two.trip.kind, 'rt');
  assert.equal(two.trip.openJaws.length, 2);
  assert.equal(two.verdict, 'split');
  // Per-segment pricing (Avios) takes any shape.
  assert.equal(et.etEvaluate(rule('british'), legs, 'Y', apOf).verdict, 'ok');
});

test('E9: Turkish needs a minimum award size before it allows a stopover; bad codes are reported', () => {
  const legs = L(['TPE', 'HKG'], ['HKG', 'MNL'], ['MNL', 'TPE']);
  const ok = et.etEvaluate(rule('turkish'), legs, 'Y', apOf);
  assert.ok(ok.price.miles >= rule('turkish').stopoverMinMiles.Y);
  assert.equal(ok.verdict, 'ok');
  assert.ok(ok.lines.some((l) => l.ok === null && /電話/.test(l.text)));
  const short = et.etEvaluate({ ...rule('turkish'), stopoverMinMiles: { Y: ok.price.miles + 1 } }, legs, 'Y', apOf);
  assert.equal(short.verdict, 'split');
  assert.ok(short.lines.some((l) => /才可中停/.test(l.text)));
  assert.match(et.etEvaluate(rule('aeroplan'), L(['TPE', 'XXQ']), 'J', apOf).error, /查不到/);
});

test('E9: routing.json is consistent with the charts, the airports and itself', () => {
  const chartIds = new Set(['asiamiles', ...charts.programs.map((p) => p.id)]);
  for (const p of routing.programs) {
    assert.ok(['direction', 'segment', 'wholeTrip', 'none'].includes(p.pricing), p.id);
    if (p.pricing !== 'none') assert.ok(chartIds.has(p.chart), `${p.id} chart ${p.chart}`);
    assert.ok(Number.isInteger(p.stopovers.oneWay) && Number.isInteger(p.stopovers.roundTrip) && Number.isInteger(p.openJaws), p.id);
    assert.ok(p.sources.length && p.sources.every((s) => /^https:\/\//.test(s.url) && s.label), p.id);
  }
  for (const x of routing.examples) {
    const r = et.etEvaluate(rule(x.program), x.legs.map(([from, to]) => ({ from, to })), x.cabin, apOf);
    assert.equal(r.verdict, 'ok', x.label);
    assert.ok(r.price.miles > 0, x.label);
  }
  for (const h of routing.positioning.hubs) for (const c of h.codes) assert.ok(AP.has(c), c);
});

test('E10: hubs for a search from Taiwan, minus the ends of the search; cheapest per hub and program', () => {
  const cfg = routing.positioning;
  const ids = (s) => et.etHubsFor(new URLSearchParams(s), cfg).map((h) => h.id);
  assert.deepEqual(ids('o=TPE&d=YVR'), ['HKG', 'TYO', 'ICN', 'MNL', 'BKK']);
  assert.deepEqual(ids('o=TPE,TSA&d=HND'), ['HKG', 'ICN', 'MNL', 'BKK']);
  assert.deepEqual(ids('o=HKG&d=YVR'), []);
  const row = (origin, source, miles, seats, date = '2026-12-01') => ({ origin, destination: 'YVR', date, source, cabins: { J: { available: true, miles, seats } } });
  const best = et.etBestFromHubs({ HKG: [row('HKG', 'aeroplan', 80000, 2), row('HKG', 'aeroplan', 70000, 1), row('HKG', 'alaska', 75000, 0), row('HKG', 'united', 90000, 4)], TYO: [row('NRT', 'aeroplan', 60000, 4)] }, 'J', 2);
  assert.deepEqual(best.map((r) => [r.hub, r.source, r.cabins.J.miles]), [['TYO', 'aeroplan', 60000], ['HKG', 'alaska', 75000], ['HKG', 'aeroplan', 80000]]);
});

// ---------- the data endpoint ----------
let base;
let server;
before(() => new Promise((r) => { delete process.env.SEATS_AERO_API_KEY; ({ server } = require('../server')); server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); }); }));
after(() => server.close());

test('E9/E10: /api/data/routing serves the rules on demand, outside the start-up bundle', async () => {
  const res = await fetch(`${base}/api/data/routing`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), routing);
  assert.ok(!('routing' in (await (await fetch(`${base}/api/data/all`)).json())));
  const gf = await fetch(`${base}/gf.html`);
  assert.equal(gf.status, 200);
  assert.match(await gf.text(), /gflights\.js/);
});
