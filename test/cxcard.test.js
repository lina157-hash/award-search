// 國泰／亞洲萬里通 card (public/cxcard.js): one line per cabin from the real Asia Miles rows, the chart estimates and the
// Cathay days of cxauto, run against the real chart; the owner-only AI tool; phones fold the program chips.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', f), 'utf8'));
const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const asiamiles = read('asiamiles.json');
const airlines = read('airlines.json').airlines;
function grab(file, re) {
  const m = src(file).match(re);
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
  src('cxfill.js'),
  src('cxauto.js'),
  src('cxcard.js'),
  'this.cx = { cxPartnerSources, cxAutoRoutes, cxCardRows };',
].join('\n'), ctx);
const { cx } = ctx;
const plain = (x) => JSON.parse(JSON.stringify(x));
const partners = cx.cxPartnerSources(airlines);

// One row; cabins: { J: [airlines, seats, miles] }.
const row = (date, source, cabins, extra = {}) => ({
  id: `${date}-${source}`, date, source, origin: 'TPE', destination: 'NRT', distance: 1330,
  cabins: Object.fromEntries(Object.entries(cabins).map(([c, [al, seats, miles = 20000]]) => [c, { available: true, miles, seats, airlines: al, direct: true }])),
  ...extra,
});
const rows = (results, pax = 0) => plain(cx.cxCardRows(results, cx.cxAutoRoutes(results, partners, pax), pax));

test('one line per cabin: the lowest Asia Miles price (real or 「約」), where it is, and the Cathay days', () => {
  const results = [
    row('2026-11-01', 'asiamiles', { J: ['JL', 2, 45000] }), // real Asia Miles, on a partner
    row('2026-11-02', 'qantas', { J: ['CX', 2, 60000], Y: ['CX', 4, 9000] }), // Cathay under a partner: days and the chart's 「約」
    row('2026-11-03', 'alaska', { J: ['CX', 1, 50000] }),
    row('2026-11-04', 'asiamiles_est', { W: ['JL', null, 31000] }, { estimate: true }), // app.js's estimate rows
    row('2026-11-05', 'aeroplan', { F: ['CX', 2, 90000] }), // not a Cathay partner: nothing
  ];
  const chartJ = asiamiles.charts.cx.short2.J;
  const chartY = asiamiles.charts.cx.short2.Y;
  const out = rows(results);
  assert.deepEqual(out.map((x) => x.c), ['Y', 'W', 'J']);
  const [y, w, j] = out;
  assert.deepEqual(y, { c: 'Y', price: { miles: chartY, real: false, date: '2026-11-02', origin: 'TPE', destination: 'NRT', airlines: 'CX' }, days: 1 });
  assert.deepEqual(w, { c: 'W', price: { miles: 31000, real: false, date: '2026-11-04', origin: 'TPE', destination: 'NRT', airlines: 'JL' }, days: 0 });
  assert.equal(j.days, 2, 'Cathay days from the partners (the JL-only Asia Miles day is not one)');
  // The cheaper of the real 45,000 and the chart's 「約」 wins.
  assert.equal(j.price.miles, Math.min(45000, chartJ));
  assert.equal(j.price.real, 45000 <= chartJ);
});

test('at the same price the real Asia Miles one is shown; the days add up over airport pairs', () => {
  const chartJ = asiamiles.charts.cx.short2.J;
  const results = [
    row('2026-11-01', 'qantas', { J: ['CX', 2] }),
    row('2026-11-01', 'asiamiles', { J: ['CX', 2, chartJ] }, { origin: 'TSA', destination: 'HND' }),
    row('2026-11-02', 'qantas', { J: ['CX', 2] }, { origin: 'TSA', destination: 'HND' }),
  ];
  const [j] = rows(results);
  assert.equal(j.price.miles, chartJ);
  assert.equal(j.price.real, true);
  assert.equal(j.price.origin, 'TSA');
  assert.equal(j.days, 2, '11/01 on both pairs counts once');
});

test('seat counts below the party are left out, unknown ones stay; nothing at all gives no lines', () => {
  const results = [row('2026-11-01', 'asiamiles', { J: ['CX', 1, 40000] }), row('2026-11-02', 'qantas', { J: ['CX', null] })];
  assert.equal(rows(results, 2)[0].price.real, false, 'the 1-seat Asia Miles row is too small for 2');
  assert.equal(rows(results, 2)[0].days, 1);
  assert.deepEqual(rows([]), []);
  assert.deepEqual(plain(cx.cxCardRows(null, null)), []);
});

test('the card is the only hook; 請 AI 助理查官網 is one of its actions and only where the passcode is', () => {
  const list = JSON.parse(src('app.js').match(/const SEARCH_SCRIPTS = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
  assert.equal(list.at(-1), 'cxcard', 'loaded last: it reads the other scripts\' parts');
  for (const f of ['cxfill.js', 'cxlive.js', 'cxauto.js', 'cxmuse.js']) assert.doesNotMatch(src(f), /window\.cxBadgeHtml\s*=/, f);
  const card = src('cxcard.js');
  // cxcal.js's 規則庫 card is #cx-card: ours must not share an id with it (a redraw would replace that card).
  for (const id of ['cxc-card', 'cxc-panel', 'cxc-hkg']) {
    const others = fs.readdirSync(path.join(__dirname, '..', 'public')).filter((f) => /\.(js|html)$/.test(f) && f !== 'cxcard.js' && f !== 'cxfill.js' && f !== 'cxauto.js').filter((f) => src(f).includes(`id="${id}"`));
    assert.deepEqual(others, [], id);
  }
  assert.match(card, /id="cxc-card"/);
  assert.match(card, /if \(p\.muse\?\.available\(\) && ownerHere\(\)\) out\.push\(\['ai', '🤖 請 AI 助理查官網'\]\)/);
  assert.match(card, /if \(k === 'ai'\) return ownerHere\(\)/);
  assert.match(card, /const ownerHere = \(\) => Boolean\(store\.get\(PASS_KEY, ''\) \|\| \(typeof acct === 'object' && acct\.status\?\.unlocked\) \|\| !cashCfg\.locked\)/);
  // 經香港轉機 spends seats.aero calls only from the button inside its panel, which says so.
  assert.match(src('cxfill.js'), /id="cx-run"[^`]*（用 2 次查詢）/);
  assert.doesNotMatch(src('cxfill.js'), /search:done[^}]*run\(\)/);
});

test('phones: the program chips fold behind 「計畫 (N) ▾」', () => {
  const c = { state: { hidden: new Set() } };
  vm.createContext(c);
  vm.runInContext(`let progOpen = false;\n${grab('app.js', /function progToggleHtml\(sources\) \{[\s\S]*?\n\}/)}\nthis.f = progToggleHtml; this.open = (v) => { progOpen = v; };`, c);
  const all = ['asiamiles', 'aeroplan', 'alaska'];
  assert.match(c.f(all), /aria-expanded="false"[^>]*>計畫 \(3\) ▾</);
  c.state.hidden.add('alaska');
  c.open(true);
  assert.match(c.f(all), /aria-expanded="true"[^>]*>計畫 \(2\/3\) ▴</);
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(css, /\.prog-toggle \{ display: none; \}/, 'desktop: no toggle');
  assert.match(css, /@media \(max-width: 600px\) \{[^}]*\{[^}]*\}[\s\S]*?\.prog-chips:not\(\.open\) \{ display: none; \}/);
});
