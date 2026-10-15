// 國泰座位日曆（自動）: Cathay seats from the loaded route results, by day and cabin, run against the real Asia Miles chart.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', f), 'utf8'));
const asiamiles = read('asiamiles.json');
const airlines = read('airlines.json').airlines;
function grab(file, re) {
  const m = fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8').match(re);
  assert.ok(m, `${re} in ${file}`);
  return m[0];
}
const ctx = { data: { asiamiles }, console };
vm.createContext(ctx);
vm.runInContext([
  grab('features.js', /function haversineMiles\(a, b\) \{[\s\S]*?\n\}/),
  grab('app.js', /function amBand\(dist, o, d\) \{[\s\S]*?\n\}/),
  grab('app.js', /function amPrice\(kind, dist, cabin, o, d\) \{[\s\S]*?\n\}/),
  fs.readFileSync(path.join(__dirname, '..', 'public', 'cxfill.js'), 'utf8'),
  fs.readFileSync(path.join(__dirname, '..', 'public', 'cxauto.js'), 'utf8'),
  'this.cx = { cxPartnerSources, cxAutoRoutes, cxAutoStats, cxAutoPick };',
].join('\n'), ctx);
const { cx } = ctx;
const plain = (x) => JSON.parse(JSON.stringify(x));
const partners = cx.cxPartnerSources(airlines);
const chart = (band, cabin) => asiamiles.charts.cx[band][cabin];

// One seats.aero row; cabins: { J: ['CX', seats, miles], … }.
const row = (date, source, cabins, extra = {}) => ({
  id: `${date}-${source}`, date, source, origin: 'TPE', destination: 'HKG', distance: 500,
  cabins: Object.fromEntries(Object.entries(cabins).map(([c, [al, seats, miles = 20000, direct = true]]) => [c, { available: true, miles, seats, airlines: al, direct }])),
  ...extra,
});

test('aggregation: Cathay seats by day and cabin, from partners and Asia Miles, other programs and carriers left out', () => {
  const results = [
    row('2026-11-01', 'qantas', { J: ['CX', 2, 25000], Y: ['CX', 4, 9000] }),
    row('2026-11-01', 'alaska', { J: ['CX', 3, 20000] }),
    row('2026-11-01', 'asiamiles', { J: ['CX', 1, 23000] }),
    row('2026-11-02', 'american', { J: ['CX, JL', null, 30000, false] }),
    row('2026-11-02', 'qantas', { Y: ['BR', 5] }), // not Cathay
    row('2026-11-03', 'aeroplan', { J: ['CX', 2] }), // not a Cathay partner
    row('2026-11-03', 'asiamiles_est', { J: ['CX', null] }, { estimate: true }), // the page's own estimate rows
    { id: 'x', date: '2026-11-04', source: 'qantas', origin: 'TPE', destination: 'HKG', cabins: { J: { available: false } } },
  ];
  const routes = plain(cx.cxAutoRoutes(results, partners));
  assert.equal(routes.length, 1);
  const r = routes[0];
  assert.deepEqual([r.key, r.fc, r.tc], ['TPE>HKG', 'TPE', 'HKG']);
  assert.deepEqual(Object.keys(r.days).sort(), ['2026-11-01', '2026-11-02']);
  const j1 = r.days['2026-11-01'].c.J;
  assert.equal(j1.seats, 3, 'most seats on one program');
  assert.equal(j1.am, 23000, 'real Asia Miles price');
  assert.deepEqual(j1.progs.map((p) => p.source), ['asiamiles', 'alaska', 'qantas'], 'Asia Miles first, then the cheapest');
  assert.deepEqual(j1.progs[1], { source: 'alaska', miles: 20000, seats: 3, direct: true, only: true, airlines: 'CX' });
  assert.equal(r.days['2026-11-01'].c.Y.seats, 4);
  const j2 = r.days['2026-11-02'].c.J;
  assert.equal(j2.seats, 0, 'unknown seat count');
  assert.equal(j2.nonstop, false);
  assert.equal(r.days['2026-11-02'].c.Y, undefined, 'BR-only economy is not Cathay');
  assert.deepEqual(plain(cx.cxAutoStats(r)), [
    { c: 'Y', days: 1, am: 0, est: chart('ultrashort', 'Y') },
    { c: 'J', days: 2, am: 23000, est: chart('ultrashort', 'J') },
  ]);
  assert.deepEqual(plain(cx.cxAutoRoutes([], partners)), []);
  assert.deepEqual(plain(cx.cxAutoRoutes(null, partners)), []);
});

test('pax filter: a known seat count below the party drops the row; unknown counts stay (like the badge)', () => {
  const results = [
    row('2026-11-01', 'qantas', { J: ['CX', 1] }),
    row('2026-11-02', 'qantas', { J: ['CX', 2] }),
    row('2026-11-03', 'alaska', { J: ['CX', null] }),
    row('2026-11-04', 'alaska', { J: ['CX', 0] }),
  ];
  const days = (pax) => Object.keys(cx.cxAutoRoutes(results, partners, pax)[0]?.days || {}).sort();
  assert.deepEqual(days(0), ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04']);
  assert.deepEqual(days(2), ['2026-11-02', '2026-11-03', '2026-11-04']);
  assert.deepEqual(days(3), ['2026-11-03', '2026-11-04']);
});

test('estimate: Cathay chart by distance only for all-Cathay itineraries, the lowest per cell', () => {
  const tpeNrt = { origin: 'TPE', destination: 'NRT', distance: 1330 };
  const results = [
    row('2026-11-01', 'qantas', { J: ['CX', 2] }, tpeNrt),
    row('2026-11-01', 'alaska', { J: ['CX, JL', 2] }, { ...tpeNrt, distance: 400 }), // mixed: no chart price
    row('2026-11-02', 'american', { J: ['CX, JL', 2] }, tpeNrt),
    row('2026-11-03', 'qantas', { J: ['CX', 2] }, { ...tpeNrt, distance: null }), // no distance
  ];
  const r = cx.cxAutoRoutes(results, partners)[0];
  const want = chart('short2', 'J'); // 1,330 miles, short haul to Japan (type 2)
  assert.ok(want > 0 && want !== chart('short', 'J'));
  assert.equal(r.days['2026-11-01'].c.J.est, want);
  assert.equal(r.days['2026-11-01'].c.J.progs.find((p) => p.source === 'alaska').only, false);
  assert.equal(r.days['2026-11-02'].c.J.est, 0);
  assert.equal(r.days['2026-11-03'].c.J.est, 0);
  assert.deepEqual(plain(cx.cxAutoStats(r)), [{ c: 'J', days: 3, am: 0, est: want }]);
});

test('several airport pairs: one route each, the most Cathay days first, capped with a count of the rest', () => {
  const at = (o, d) => ({ origin: o, destination: d });
  const results = [
    row('2026-11-01', 'qantas', { J: ['CX', 2] }, at('TSA', 'HND')),
    row('2026-11-01', 'qantas', { J: ['CX', 2] }, at('TPE', 'NRT')),
    row('2026-11-02', 'qantas', { J: ['CX', 2] }, at('TPE', 'NRT')),
    row('2026-11-03', 'qantas', { J: ['CX', 2] }, at('TPE', 'NRT')),
    row('2026-11-01', 'alaska', { Y: ['CX', 2] }, at('TPE', 'HND')),
    row('2026-11-02', 'alaska', { Y: ['CX', 2] }, at('TPE', 'HND')),
    row('2026-11-01', 'american', { F: ['CX', 1] }, at('KHH', 'NRT')),
  ];
  const routes = cx.cxAutoRoutes(results, partners);
  assert.deepEqual(routes.map((r) => r.key), ['TSA>HND', 'TPE>NRT', 'TPE>HND', 'KHH>NRT']);
  const pick = cx.cxAutoPick(routes);
  assert.deepEqual(pick.shown.map((r) => r.key), ['TPE>NRT', 'TPE>HND', 'TSA>HND'], 'most days first, ties keep their order');
  assert.equal(pick.more, 1);
  const two = cx.cxAutoPick(routes, 2);
  assert.equal(two.shown.length, 2);
  assert.equal(two.more, 2);
  assert.deepEqual(plain(cx.cxAutoPick([])), { shown: [], more: 0 });
});

test('the page loads cxauto.js after cxlive.js', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const a = html.indexOf('/cxlive.js');
  const b = html.indexOf('/cxauto.js');
  assert.ok(a > 0 && b > a);
});
