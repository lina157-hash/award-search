// 國泰補查: the partner-space badge and the Hong Kong two-leg stitch, run against the real Asia Miles chart.
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
// The airport list, for Cathay trips priced through Hong Kong (app.js amCxDist reads AP).
const AP = { byCode: new Map(require('../public/airports.min.json').airports.map(([code, , , country, , , , , lat, lon]) => [code, { code, country, lat, lon }])) };
const ctx = { data: { asiamiles }, AP, console };
vm.createContext(ctx);
vm.runInContext([
  grab('features.js', /function haversineMiles\(a, b\) \{[\s\S]*?\n\}/),
  grab('app.js', /function amBand\(dist, o, d\) \{[\s\S]*?\n\}/),
  grab('app.js', /function amPrice\(kind, dist, cabin, o, d\) \{[\s\S]*?\n\}/),
  grab('app.js', /const AM_HUB = 'HKG';/),
  grab('app.js', /function amCxDist\([\s\S]*?\n\}/),
  fs.readFileSync(path.join(__dirname, '..', 'public', 'cxfill.js'), 'utf8'),
  'this.cx = { cxPartnerSources, cxBadgeInfo, cxLegDays, cxPair, cxStitchPrice, cxStitchOffer };',
].join('\n'), ctx);
const { cx } = ctx;
const plain = (x) => JSON.parse(JSON.stringify(x));
const cxChart = (band, cabin) => asiamiles.charts.cx[band][cabin];

const ap = new Map(require('../public/airports.min.json').airports.map(([code, , , country, , , , , lat, lon]) => [code, { code, country, lat, lon }]));
const apOf = (c) => ap.get(c) || null;

const row = (date, source, airlines, extra = {}) => ({
  id: `${date}-${source}`, date, source, origin: 'TPE', destination: 'HKG', distance: 500,
  cabins: { J: { available: true, miles: 21000, seats: 2, airlines, direct: true } }, ...extra,
});

test('partners come from airlines.json and leave Asia Miles out', () => {
  const p = cx.cxPartnerSources(airlines);
  assert.ok(p.includes('qantas') && p.includes('alaska') && p.includes('american'));
  assert.ok(!p.includes('asiamiles'));
  assert.deepEqual(plain(cx.cxPartnerSources(null)), ['alaska', 'american', 'qantas']);
});

test('badge: CX under partner programs on days without Asia Miles seats, priced on the Cathay chart', () => {
  const partners = cx.cxPartnerSources(airlines);
  const results = [
    row('2026-11-01', 'qantas', 'CX'),
    row('2026-11-01', 'alaska', 'CX'),
    row('2026-11-02', 'qantas', 'CX'),
    row('2026-11-03', 'qantas', 'CX'),
    row('2026-11-03', 'asiamiles', 'CX'), // Asia Miles already shows this day: not counted
    row('2026-11-04', 'aeroplan', 'CX'), // not a Cathay partner in the site's data
    row('2026-11-05', 'united', 'BR'),
    row('2026-11-06', 'qantas', 'CX', { cabins: { J: { available: false, miles: 0, seats: 0, airlines: '' } } }),
  ];
  const b = cx.cxBadgeInfo(results, 'J', partners);
  assert.equal(b.days, 2);
  assert.deepEqual(plain(b.dates), ['2026-11-01', '2026-11-02']);
  assert.deepEqual(plain(b.sources), ['qantas', 'alaska']);
  // TPE–HKG 500 miles is ultra-short haul.
  assert.equal(b.est.miles, cxChart('ultrashort', 'J'));
  assert.equal(b.est.band, 'ultrashort');
  // Asia Miles seats on every day → no badge; no CX at all → no badge.
  assert.equal(cx.cxBadgeInfo([row('2026-11-01', 'qantas', 'CX'), row('2026-11-01', 'asiamiles', 'CX')], 'J', partners), null);
  assert.equal(cx.cxBadgeInfo([row('2026-11-05', 'united', 'BR')], 'J', partners), null);
});

test('badge: a mixed itinerary still counts as Cathay space but gets no chart price; pax filters known-short rows', () => {
  const partners = cx.cxPartnerSources(airlines);
  const b = cx.cxBadgeInfo([row('2026-11-01', 'alaska', 'CX, BA', { distance: 6000 })], 'J', partners);
  assert.equal(b.days, 1);
  assert.equal(b.est, null);
  const one = row('2026-11-01', 'qantas', 'CX');
  one.cabins.J.seats = 1;
  assert.equal(cx.cxBadgeInfo([one], 'J', partners, 2), null);
  one.cabins.J.seats = 0; // unknown count is kept
  assert.equal(cx.cxBadgeInfo([one], 'J', partners, 2).days, 1);
});

test('stitch: legs keep Cathay-only rows, Asia Miles first, and pair the same day or the next day', () => {
  const leg1 = cx.cxLegDays([
    row('2026-11-01', 'qantas', 'CX', { cabins: { J: { available: true, miles: 21000, seats: 2, airlines: 'CX' } } }),
    row('2026-11-01', 'alaska', 'CX', { cabins: { J: { available: true, miles: 17500, seats: 1, airlines: 'CX' } } }),
    row('2026-11-02', 'qantas', 'CX'),
    row('2026-11-03', 'qantas', 'CX, BR'),
    row('2026-11-05', 'qantas', 'CX'),
    row('2026-11-09', 'qantas', 'CX'),
  ], 'J');
  assert.deepEqual([...leg1.keys()].sort(), ['2026-11-01', '2026-11-02', '2026-11-05', '2026-11-09']);
  assert.deepEqual(leg1.get('2026-11-01').map((x) => x.source), ['alaska', 'qantas']);
  const hk = (date, source) => row(date, source, 'CX', { origin: 'HKG', destination: 'LHR', distance: 5985 });
  const leg2 = cx.cxLegDays([hk('2026-11-01', 'qantas'), hk('2026-11-01', 'asiamiles'), hk('2026-11-02', 'american'), hk('2026-11-06', 'qantas')], 'J');
  assert.deepEqual(leg2.get('2026-11-01').map((x) => x.source), ['asiamiles', 'qantas']);
  const pairs = cx.cxPair(leg1, leg2);
  assert.deepEqual(pairs.map((p) => [p.date, p.date2, p.next]), [
    ['2026-11-01', '2026-11-01', false],
    ['2026-11-02', '2026-11-02', false], // same day wins over the next day
    ['2026-11-05', '2026-11-06', true],
  ]);
  assert.deepEqual(cx.cxPair(leg1, new Map()), []);
});

test('stitch price: total flown distance picks the band (TPE–HKG–LHR is long haul, not the TPE–LHR direct distance)', () => {
  const p = cx.cxStitchPrice(500, 5985, 'J', 'TPE', 'LHR');
  assert.equal(p.dist, 6485);
  assert.equal(p.band, 'long');
  assert.equal(p.miles, cxChart('long', 'J'));
  // Japan at one end makes a short-haul journey type 2.
  const j = cx.cxStitchPrice(500, 1800, 'Y', 'TPE', 'NRT');
  assert.equal(j.band, 'short2');
  assert.equal(j.miles, cxChart('short2', 'Y'));
  assert.equal(cx.cxStitchPrice(500, 0, 'J', 'TPE', 'LHR').miles, null);
});

test('stitch offer: not when either end is (near) Hong Kong or the detour is silly', () => {
  assert.equal(cx.cxStitchOffer('TPE', 'LHR', apOf), true);
  assert.equal(cx.cxStitchOffer('LHR', 'TPE', apOf), true);
  assert.equal(cx.cxStitchOffer('TPE,TSA', 'NRT', apOf), true);
  assert.equal(cx.cxStitchOffer('TPE', 'HKG', apOf), false);
  assert.equal(cx.cxStitchOffer('HKG', 'LHR', apOf), false);
  assert.equal(cx.cxStitchOffer('TPE', 'MFM', apOf), false);
  assert.equal(cx.cxStitchOffer('SFO', 'JFK', apOf), false);
  assert.equal(cx.cxStitchOffer('TPE', 'KHH', apOf), false);
  assert.equal(cx.cxStitchOffer('', 'LHR', apOf), false);
  assert.equal(cx.cxStitchOffer('TPE', 'LHR', () => null), true);
});

test('demo data: Cathay out of Taipei only under partner programs, real distances, none on TPE–LHR', () => {
  const mock = require('../lib/mock.js');
  const q = (o, d, carriers) => mock.mockSearch({ origin_airport: o, destination_airport: d, start_date: '2026-11-01', end_date: '2026-11-30', carriers });
  const tpeHkg = q('TPE', 'HKG');
  assert.ok(!tpeHkg.some((r) => r.Source === 'asiamiles'));
  assert.ok(tpeHkg.some((r) => r.Source === 'qantas' && r.JAirlines === 'CX'));
  assert.ok(Math.abs(tpeHkg[0].Route.Distance - 500) < 30);
  assert.ok(!q('TPE', 'LHR').some((r) => /CX/.test(r.JAirlines + r.YAirlines)));
  assert.ok(q('HKG', 'LHR', 'CX').some((r) => r.JAvailable && r.JAirlines === 'CX'));
});
