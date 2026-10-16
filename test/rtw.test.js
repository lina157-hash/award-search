// 環球票規劃 and 國泰混艙計算 (public/rtw.js): distance bands, the official rule checks, and Asia Miles mixed-cabin pricing.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', f), 'utf8'));
const rtwData = read('rtw.json');
const charts = read('charts.json');
const asiamiles = read('asiamiles.json');
const alliances = read('alliances.json');
function grab(file, re) {
  const m = fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8').match(re);
  assert.ok(m, `${re} in ${file}`);
  return m[0];
}
const ctx = {
  data: { asiamiles, charts, rtw: rtwData }, console,
  CABIN_LABEL: { Y: '經濟艙', W: '豪華經濟艙', J: '商務艙', F: '頭等艙' },
  fmt: (n) => Number(n).toLocaleString('en-US'),
  regionName: (cc) => ({ zh: cc }),
};
vm.createContext(ctx);
vm.runInContext([
  grab('features.js', /function haversineMiles\(a, b\) \{[\s\S]*?\n\}/),
  grab('app.js', /function amBand\(dist, o, d\) \{[\s\S]*?\n\}/),
  fs.readFileSync(path.join(__dirname, '..', 'public', 'rtw.js'), 'utf8'),
  'this.R = { rtwArea, rtwTrip, rtwShape, rtwStays, rtwPrice, rtwChecks, rtwAddMonths, cxMixQuote, rtwCarriers, rtwOpenJaw, rtwMeter, rtwKeyFacts, rtwArc };',
].join('\n'), ctx);
const { R } = ctx;
const plain = (x) => JSON.parse(JSON.stringify(x));

const ap = new Map(require('../public/airports.min.json').airports.map(([code, , , country, , , , , lat, lon]) => [code, { code, country, lat, lon }]));
const apOf = (c) => ap.get(c) || null;
const prog = (id) => rtwData.programs.find((p) => p.id === id);
const members = Object.fromEntries(alliances.alliances.map((a) => [a.id, a.members]));
// codes: 'TPE HKG LHR'; legs: per-leg overrides ({ airline, date, surface }); stays: per-stop 'transfer'.
function plan(codes, legs = [], stays = {}) {
  const stops = codes.split(' ').map((code, i) => ({ code, stay: stays[i] || 'stop' }));
  return { stops, legs: stops.slice(1).map((s, i) => ({ date: '', airline: '', surface: false, ...(legs[i] || {}) })) };
}
const trip = (p) => R.rtwTrip(p, apOf, rtwData.areas);
const checks = (id, p, cabin = 'J') => plain(R.rtwChecks(prog(id), p, trip(p), { cabin, members, cityOf: (c) => c, today: '2026-10-16' }));
const find = (list, re) => list.find((x) => re.test(x.t));
const WEST = 'TPE HKG LHR JFK LAX TPE';
const air = (s) => s.split(' ').map((airline) => ({ airline }));

test('rtw.json: every rule and chart cites a dated official page; charts rise and the JAL chart is the one in charts.json', () => {
  assert.equal(rtwData.lastReviewed.length, 10);
  for (const p of rtwData.programs) {
    assert.ok(p.sources.length && p.sources.every((s) => s.official && /^https:\/\//.test(s.url) && /^\d{4}-\d{2}-\d{2}$/.test(s.checked)), p.id);
    assert.ok(p.cabins.every((c) => ['Y', 'W', 'J', 'F'].includes(c)), p.id);
    assert.ok(['distance', 'fixed', 'pending'].includes(p.price.kind), p.id);
    assert.ok(p.summary.length && p.howToBook && ['oneworld', 'star'].includes(p.alliance), p.id);
    const bands = p.price.bands || charts.programs.find((x) => x.id === p.price.chartRef)?.tables[0].bands;
    if (p.price.kind === 'distance') {
      assert.ok(bands?.length, `${p.id} has a chart`);
      bands.forEach((b, i) => { if (i) for (const c of p.cabins) assert.ok(b.upTo > bands[i - 1].upTo && b[c] >= bands[i - 1][c], `${p.id} band ${i} ${c}`); });
      assert.equal(bands.at(-1).upTo, p.price.max, `${p.id}: the top band ends at the cap`);
    }
    if (p.price.kind === 'fixed') for (const c of p.cabins) assert.ok(p.price[c] > 0, `${p.id} ${c}`);
    if (p.price.kind === 'pending') assert.ok(/^https:\/\//.test(p.price.chartUrl) && p.price.why);
  }
  // The JAL chart is the official page already in charts.json, not a copy.
  assert.equal(prog('jal_ow').price.chartRef, 'jal_partner');
  assert.equal(charts.programs.find((x) => x.id === 'jal_partner').sources[0].url, 'https://www.jal.co.jp/jp/en/jalmile/use/partner_air/oneworld/miles.html');
  for (const e of [...rtwData.ended, ...rtwData.cashFares]) assert.ok(/^https:\/\//.test(e.url), e.name);
  assert.ok(rtwData.ended.some((e) => /ANA/.test(e.name) && /2025-06-23/.test(e.text)), 'ANA stopped issuing on 23 Jun 2025');
  const m = rtwData.cxMixed;
  assert.match(m.source.url, /^https:\/\/www\.cathaypacific\.com\/.+terms-and-conditions-2026-EN\.pdf$/);
  assert.match(m.source.quote, /rounded down to the nearest hundred/);
});

test('areas: Americas 1, Europe/Africa/Middle East 2, Asia/Pacific 3; Russia splits at the Urals; Hawaii is America', () => {
  const area = (c) => R.rtwArea(rtwData.areas, apOf(c));
  assert.deepEqual(['TPE', 'NRT', 'SYD', 'DEL', 'LHR', 'DOH', 'IST', 'CAI', 'JFK', 'HNL', 'GRU', 'SVO', 'VVO', 'GUM'].map(area), [3, 3, 3, 3, 2, 2, 2, 2, 1, 1, 1, 2, 3, 3]);
  assert.equal(R.rtwArea(rtwData.areas, null), 0);
});

test('shape: westbound and eastbound loops cross each ocean once; a there-and-back trip crosses none; a U-turn is mixed', () => {
  const w = plain(R.rtwShape(trip(plan(WEST))));
  assert.deepEqual([w.pacific, w.atlantic, w.dir], [1, 1, 'west']);
  const e = plain(R.rtwShape(trip(plan('TPE NRT LAX JFK LHR FRA BKK TPE'))));
  assert.deepEqual([e.pacific, e.atlantic, e.dir], [1, 1, 'east']);
  assert.deepEqual(plain(R.rtwShape(trip(plan('TPE LHR TPE')))).dir, 'mixed');
  assert.equal(plain(R.rtwShape(trip(plan('TPE HKG')))).dir, '');
});

test('distance bands: JAL counts flown miles only, Qantas adds the surface leg; the cap and missing cabins are reported', () => {
  const t = trip(plan(WEST));
  assert.equal(t.flown, 19183);
  const jal = plain(R.rtwPrice(prog('jal_ow'), t, 'J', charts));
  assert.deepEqual([jal.miles, jal.band.lo, jal.band.hi], [120000, 14001, 20000]);
  const qf = plain(R.rtwPrice(prog('qantas_ow'), t, 'J', charts));
  assert.deepEqual([qf.miles, qf.band.lo, qf.band.hi, qf.unit], [278400, 16801, 19200, '點']);
  // London → Paris by train: JAL drops it, Qantas counts it and moves up a zone (19,183 + ~214 > 19,200).
  const s = trip(plan('TPE HKG LHR CDG JFK LAX TPE', [{}, {}, { surface: true }]));
  assert.ok(s.surface > 100 && s.flown < s.total);
  assert.equal(R.rtwPrice(prog('jal_ow'), s, 'J', charts).dist, s.flown);
  const qs = plain(R.rtwPrice(prog('qantas_ow'), s, 'J', charts));
  assert.equal(qs.dist, s.total);
  assert.equal(qs.miles, 318000, `zone 10 for ${s.total}`);
  // Exactly on a boundary stays in the lower band.
  const fake = (flown) => ({ flown, surface: 0, total: flown });
  assert.equal(R.rtwPrice(prog('jal_ow'), fake(4000), 'Y', charts).miles, 25000);
  assert.equal(R.rtwPrice(prog('jal_ow'), fake(4001), 'Y', charts).miles, 40000);
  assert.ok(R.rtwPrice(prog('qantas_ow'), fake(35001), 'J', charts).over);
  assert.ok(R.rtwPrice(prog('jal_ow'), fake(9000), 'W', charts).noCabin, 'JAL has no premium economy column');
  assert.equal(R.rtwPrice(prog('mm_world'), t, 'F', charts).miles, 540000);
  assert.ok(R.rtwPrice(prog('tap_rtw'), t, 'F', charts).noCabin);
  // Asia Miles: Cathay's own 「寰宇一家」聯盟成員獎勵換算表 (13 zones, checked against the official page 2026-10-16).
  const am = plain(R.rtwPrice(prog('asiamiles_ow'), t, 'J', charts));
  assert.deepEqual([am.miles, am.band.lo, am.band.hi, am.back], [230000, 18001, 20000, 0]);
  const amp = prog('asiamiles_ow').price;
  assert.ok(!amp.secondary, 'no longer an estimate');
  assert.equal(amp.bands.length, 13);
  assert.deepEqual(['Y', 'J', 'F'].map((c) => [amp.bands[0][c], amp.bands.at(-1)[c]]), [[30000, 160000], [60000, 280000], [75000, 380000]]);
  assert.ok(prog('asiamiles_ow').sources.some((s) => s.official && s.url === amp.chartUrl));
  // Qantas prices a one-way trip as if it flew home: TPE → … → SYD adds SYD → TPE.
  const oneWay = trip(plan('TPE HKG LHR JFK LAX SYD'));
  const qo = plain(R.rtwPrice(prog('qantas_ow'), oneWay, 'J', charts));
  assert.ok(qo.back > 4000 && qo.dist === oneWay.total + qo.back, JSON.stringify(qo));
  assert.equal(R.rtwPrice(prog('jal_ow'), oneWay, 'J', charts).back, 0, 'JAL prices what is flown');
});

test('rule checks: crossings, direction, return country, segment and stopover limits', () => {
  const ok = checks('tap_rtw', plan(WEST));
  assert.ok(ok.every((x) => x.s !== 'bad'), JSON.stringify(ok));
  assert.equal(find(ok, /跨太平洋/).s, 'ok');
  assert.equal(find(ok, /全程往西/).s, 'ok');
  // Not around the world, and ending in another country.
  const no = checks('tap_rtw', plan('TPE LHR JFK'));
  assert.equal(find(no, /跨太平洋 0 次/).s, 'bad');
  assert.equal(find(no, /回到出發的國家/).s, 'bad');
  // A U-turn changes direction.
  assert.equal(find(checks('tap_rtw', plan('TPE LAX TPE LHR TPE')), /方向有改變/).s, 'bad');
  // Miles & More: 11 flights is one too many; 8 stopovers one too many.
  const long = plan('TPE HKG BKK DEL DOH IST FRA LHR JFK ORD LAX TPE');
  const mm = checks('mm_world', long);
  assert.equal(find(mm, /航班 11 段/).s, 'bad');
  assert.equal(find(mm, /停留 10 次/).s, 'bad');
  // Transfers don't count as stopovers.
  const tr = checks('mm_world', plan(WEST, [], { 1: 'transfer', 2: 'transfer' }));
  assert.equal(find(tr, /停留 2 次/).s, 'ok');
  // JAL: a surface leg counts as a stopover and only one is allowed.
  const j = checks('jal_ow', plan('TPE HKG LHR CDG JFK BOS LAX TPE', [{}, {}, { surface: true }, {}, { surface: true }]));
  assert.equal(find(j, /開口 2 次/).s, 'bad');
  assert.match(find(j, /^停留/).t, /開口算 1 次停留/);
  // Going home in the middle and leaving again.
  assert.equal(find(checks('jal_ow', plan('TPE HKG TPE LAX TPE')), /出發了 2 次/).s, 'bad');
  assert.equal(find(checks('qantas_ow', plan(WEST)), /沒有中途回到出發國家/).s, 'ok');
  // Asia Miles: no stopover in the origin/destination city, and at most two transfers.
  const am = checks('asiamiles_ow', plan('TPE HKG TPE LHR JFK LAX TPE', [], { 1: 'transfer', 3: 'transfer', 4: 'transfer' }));
  assert.equal(find(am, /不能在這裡停留/).s, 'bad');
  assert.equal(find(am, /轉機 3 次/).s, 'bad');
  // Per-city limits: two stopovers in Hong Kong.
  assert.match(find(checks('qantas_ow', plan('TPE HKG LHR HKG SYD TPE')), /停留超過 1 次/).t, /HKG/);
  // No premium economy on the Asia Miles multi-carrier award.
  assert.equal(find(checks('asiamiles_ow', plan(WEST), 'W'), /沒有豪華經濟艙/).s, 'bad');
});

test('rule checks: airlines per program (Cathay needs three carriers, Qantas two besides QF, Star only for TAP)', () => {
  assert.equal(find(checks('asiamiles_ow', plan(WEST)), /航空公司代碼/).s, 'na', 'blank airline codes skip the check');
  assert.equal(find(checks('asiamiles_ow', plan(WEST, air('CX CX BA BA CX'))), /至少要 3 家/).s, 'bad');
  assert.equal(find(checks('asiamiles_ow', plan(WEST, air('CX CX BA AA CX'))), /至少要 3 家/).s, 'ok');
  assert.equal(find(checks('asiamiles_ow', plan(WEST, air('JL JL BA AA JL'))), /至少要 2 家/).s, 'ok');
  assert.equal(find(checks('qantas_ow', plan(WEST, air('QF QF BA QF QF'))), /QF 以外搭了 1 家/).s, 'bad');
  assert.match(find(checks('jal_ow', plan(WEST, air('CX BR BA AA CX'))), /BR 不在/).t, /可搭的航空公司/);
  assert.equal(find(checks('tap_rtw', plan(WEST, air('BR TK LH UA BR'))), /每段都是可搭/).s, 'ok');
  assert.equal(find(checks('tap_rtw', plan(WEST, air('BR TK CX UA BR'))), /CX 不在/).s, 'bad');
});

test('rule checks: validity window and the Miles & More 10-day minimum, from the leg dates', () => {
  const dates = (...d) => d.map((date) => ({ date }));
  assert.equal(find(checks('jal_ow', plan(WEST)), /填上每段日期/).s, 'na');
  const fine = checks('jal_ow', plan(WEST, dates('2027-03-01', '2027-03-08', '2027-03-20', '2027-03-25', '2027-04-02')));
  assert.match(find(fine, /效期/).t, /2028-03-01 前飛完/);
  assert.equal(find(fine, /效期/).s, 'ok');
  assert.equal(find(checks('jal_ow', plan(WEST, dates('2027-03-01', '', '', '', '2028-03-02'))), /效期/).s, 'bad');
  // TAP counts from the ticket's issue date: the plan says how early it may be issued.
  assert.match(find(checks('tap_rtw', plan(WEST, dates('2027-03-01', '', '', '', '2027-12-20'))), /效期/).t, /要在 2026-12-20 之後開票/);
  assert.match(find(checks('tap_rtw', plan(WEST, dates('2027-03-01', '', '', '', '2027-06-30'))), /效期/).t, /現在開票就來得及/);
  assert.equal(find(checks('tap_rtw', plan(WEST, dates('2027-03-01', '', '', '', '2028-03-02'))), /效期/).s, 'bad');
  // Miles & More counts from the first to the last long-haul (between-area) flight; TPE→HKG doesn't count.
  assert.equal(find(checks('mm_world', plan(WEST, dates('2027-02-20', '2027-03-01', '', '', '2027-03-06'))), /相隔 5 天/).s, 'bad');
  assert.equal(find(checks('mm_world', plan(WEST, dates('', '2027-03-01', '', '', '2027-03-11'))), /相隔 10 天/).s, 'ok');
  assert.equal(find(checks('mm_world', plan(WEST, dates('2027-03-01', '', '', '', ''))), /至少相隔 10 天/).s, 'na');
  // Its validity wording differs between the T&C and the product page: the stricter one is used and the gap is shown.
  const mmv = checks('mm_world', plan(WEST, dates('', '2027-03-01', '', '', '2027-03-11')));
  assert.equal(find(mmv, /^效期自開票日起/).s, 'ok');
  assert.equal(find(mmv, /產品頁寫/).s, 'warn');
  assert.equal(find(checks('mm_world', plan(WEST, dates('2027-03-05', '2027-03-01'))), /沒有照順序/).s, 'warn');
  assert.equal(R.rtwAddMonths('2027-01-31', 1), '2027-02-28');
  assert.equal(R.rtwAddMonths('2028-02-29', 12), '2029-02-28');
  assert.equal(R.rtwAddMonths('2027-06-30', -12), '2026-06-30');
});

test('mixed cabin: each leg\'s cabin price in the whole trip\'s zone, prorated by distance, rounded down to the hundred', () => {
  const legs = (codes, cabins) => codes.split(' ').slice(1).map((to, i, all) => {
    const from = codes.split(' ')[i];
    const a = apOf(from); const b = apOf(to);
    return { from, to, cabin: cabins[i], dist: vm.runInContext(`haversineMiles(${JSON.stringify(a)}, ${JSON.stringify(b)})`, ctx) };
  });
  // The worked example: TPE→HKG business + HKG→LHR first on Cathay, 500 + 5,984 = 6,484 miles (長程).
  const q = plain(R.cxMixQuote(asiamiles, 'cx', legs('TPE HKG LHR', ['J', 'F']), 'TPE', 'LHR'));
  const long = asiamiles.charts.cx.long;
  assert.deepEqual([q.total, q.band], [6484, 'long']);
  const raw = (long.J * 500 + long.F * 5984) / 6484;
  assert.equal(q.miles, Math.floor(raw / 100) * 100);
  assert.equal(q.miles, 122300);
  assert.deepEqual([q.top, q.topMiles], ['F', long.F]);
  assert.ok(q.miles < long.F && q.miles > long.J);
  // Same cabin throughout is just the chart price.
  assert.equal(R.cxMixQuote(asiamiles, 'cx', legs('TPE HKG LHR', ['J', 'J']), 'TPE', 'LHR').miles, long.J);
  // Japan at one end: the short-haul type-2 zone prices both legs.
  const jp = plain(R.cxMixQuote(asiamiles, 'cx', legs('HKG TPE NRT', ['Y', 'J']), 'HKG', 'NRT'));
  assert.equal(jp.band, 'short2');
  const s2 = asiamiles.charts.cx.short2;
  assert.equal(jp.miles, Math.floor((s2.Y * jp.rows[0].dist + s2.J * jp.rows[1].dist) / jp.total / 100) * 100);
  // Partner chart, and a cabin the zone doesn't sell.
  const pq = plain(R.cxMixQuote(asiamiles, 'partner', legs('TPE HKG LHR', ['Y', 'J']), 'TPE', 'LHR'));
  assert.ok(pq.miles > asiamiles.charts.partner.long.Y && pq.miles < asiamiles.charts.partner.long.J);
  const noF = { ...asiamiles, charts: { ...asiamiles.charts, cx: { ...asiamiles.charts.cx, long: { ...long, F: null } } } };
  assert.deepEqual(plain(R.cxMixQuote(noF, 'cx', legs('TPE HKG LHR', ['J', 'F']), 'TPE', 'LHR')).missing, ['F']);
  assert.equal(R.cxMixQuote(asiamiles, 'cx', [{ from: 'TPE', to: 'XXX', dist: 0, cabin: 'J' }], 'TPE', 'XXX'), null);
});

test('each program\'s example itinerary passes all of its own rules', () => {
  for (const p of rtwData.programs) {
    const ex = p.example;
    assert.ok(ex && ex.stops.length === ex.airlines.length + 1, p.id);
    const pl = plan(ex.stops.join(' '), ex.airlines.map((airline, i) => ({ airline, surface: ex.stays?.[i] === 'open' })), Object.fromEntries((ex.stays || []).map((x, i) => [i, x]).filter(([, x]) => x === 'transfer')));
    const bad = checks(p.id, pl, p.cabins.includes('J') ? 'J' : p.cabins[0]).filter((x) => x.s === 'bad');
    assert.deepEqual(bad, [], p.id);
    assert.ok(R.rtwPrice(p, trip(pl), 'J', charts) !== null, p.id);
  }
});

test('the planner offers each program\'s own airlines, open-jaw rule and key facts', () => {
  assert.deepEqual(plain(R.rtwCarriers(prog('jal_ow'), members)), prog('jal_ow').rules.carriers.list);
  assert.deepEqual(plain(R.rtwCarriers(prog('tap_rtw'), members)), members.star);
  assert.ok(R.rtwCarriers(prog('asiamiles_ow'), members).includes('CX'));
  assert.deepEqual(plain(R.rtwOpenJaw(prog('jal_ow'))), { max: 1, stopover: true, inDistance: false, unstated: false });
  assert.equal(R.rtwOpenJaw(prog('mm_world')).unstated, true);
  assert.equal(R.rtwOpenJaw(prog('qantas_ow')).inDistance, true);
  assert.equal(R.rtwOpenJaw({ rules: { maxSurface: 0 }, price: {} }), null);
  assert.equal(R.rtwKeyFacts(prog('mm_world'))[0], '固定價');
  assert.match(R.rtwKeyFacts(prog('jal_ow'))[0], /依總距離計價・50,000 哩內/);
  assert.ok(R.rtwKeyFacts(prog('mm_world')).includes('要跨太平洋和大西洋'));
});

test('distance meter: the band the trip is in and how far the next one starts', () => {
  const t = trip(plan('TPE HKG LHR'));
  const m = plain(R.rtwMeter(prog('jal_ow'), t, 'J', charts));
  assert.equal(m.max, 50000);
  assert.equal(m.bands.at(-1).upTo, 50000);
  if (m.idx > 0) assert.ok(m.d > m.bands[m.idx - 1].upTo);
  assert.ok(m.d <= m.bands[m.idx].upTo);
  assert.equal(m.left, m.bands[m.idx].upTo + 1 - m.d);
  assert.equal(m.next.miles, m.bands[m.idx + 1].miles);
  assert.equal(R.rtwMeter(prog('mm_world'), t, 'J', charts), null, 'fixed price: no meter');
});

test('map arcs: a great circle with longitudes carried across the date line', () => {
  const tpe = apOf('TPE');
  const lax = apOf('LAX');
  const arc = plain(R.rtwArc(tpe, lax));
  assert.equal(arc.length, 33);
  assert.ok(Math.abs(arc[0][1] - tpe.lon) < 1e-6);
  assert.ok(Math.abs(arc.at(-1)[1] - (lax.lon + 360)) < 1e-6, 'eastward over the Pacific: LAX at -118 + 360');
  assert.ok(arc.every((p, i) => !i || Math.abs(p[1] - arc[i - 1][1]) < 30), 'no jump');
  assert.ok(Math.max(...arc.map((p) => p[0])) > Math.max(tpe.lat, lax.lat), 'bends north');
  const same = plain(R.rtwArc(tpe, tpe));
  assert.equal(same.length, 2);
});

test('open-jaw rules per program: Asia Miles counts a 開口 like a stopover, JAL limits its length, Miles & More is unstated', () => {
  const open = (codes, at) => plan(codes, Object.fromEntries([[at, { surface: true }]]));
  // Asia Miles: a city may be a stopover or an open jaw once, and never at the ends.
  const twice = checks('asiamiles_ow', open('TPE HKG LHR CDG JFK LAX HKG TPE', 2));
  assert.equal(find(twice, /開口 1 次，上限 2 次/).s, 'ok');
  assert.equal(find(twice, /HKG 停留或開口超過 1 次/).s, 'bad');
  assert.equal(find(checks('asiamiles_ow', open('TPE HKG LHR JFK LAX TPE KHH', 5)), /TPE 是出發地或目的地/).s, 'bad');
  // Ending away from home is not in the T&C, so it's a warning, not a rule.
  assert.equal(find(checks('asiamiles_ow', plan('TPE HKG LHR JFK LAX KHH')), /終點 KHH 和起點 TPE 不同城市/).s, 'warn');
  assert.equal(find(checks('asiamiles_ow', plan('TPE HKG LHR JFK LAX HKG')), /最後沒有回到出發的國家/).s, 'warn');
  assert.ok(!find(checks('asiamiles_ow', plan(WEST)), /終點|最後沒有回到/), 'a closed loop gets no warning');
  // JAL: Hong Kong → Singapore overland (~1,600 mi) is longer than Taipei → Hong Kong (~500 mi).
  const far = checks('jal_ow', open('TPE HKG SIN LHR JFK TPE', 1));
  assert.match(find(far, /日航不接受這樣的開口/).t, /HKG→SIN/);
  assert.ok(!find(checks('jal_ow', open('TPE NRT LHR MAD JFK TPE', 2)), /日航不接受/), 'London → Madrid is shorter than Taipei → London');
  // Miles & More and TAP don't say: allowed in the planner, with a warning.
  const mm = checks('mm_world', open('TPE MUC FRA JFK SFO TPE', 1));
  assert.equal(find(mm, /官方規則沒寫中途可不可以開口/).s, 'warn');
  assert.ok(mm.every((x) => x.s !== 'bad'), JSON.stringify(mm));
  assert.ok(!find(checks('mm_world', plan(WEST)), /官方規則沒寫/), 'no warning without an open jaw');
});
