// Data checks for the LifeMiles and Etihad Guest additions (airlines, charts, rules, points, expiry).
const test = require('node:test');
const assert = require('node:assert');

const airlines = require('../data/airlines.json').airlines;
const programs = require('../data/programs.json').programs;
const charts = require('../data/charts.json').programs;
const points = require('../data/points.json');
const expiry = require('../data/expiry.json').programs;
const names = require('../data/source-names.json').names;

test('LifeMiles and Etihad Guest can be picked in 區域探索 (bookableVia) and have names', () => {
  const via = new Set(airlines.flatMap((a) => a.bookableVia));
  for (const s of ['lifemiles', 'etihad']) {
    assert.ok(via.has(s), s);
    assert.ok(names[s], s);
  }
  // LifeMiles books every Star Alliance airline listed.
  for (const a of airlines.filter((x) => x.alliance === 'star')) assert.ok(a.bookableVia.includes('lifemiles'), a.code);
  const ey = airlines.find((a) => a.code === 'EY');
  assert.equal(ey.homeProgram, 'etihad');
  assert.ok(ey.bookableVia.includes('etihad'));
});

test('every airline lists known programs, once each', () => {
  for (const a of airlines) {
    assert.equal(new Set(a.bookableVia).size, a.bookableVia.length, a.code);
    for (const s of a.bookableVia) assert.ok(names[s], `${a.code} → ${s}`);
  }
});

test('rules: both programs carry every field and dated sources', () => {
  const fields = Object.keys(require('../data/programs.json').fields);
  for (const id of ['lifemiles', 'etihad']) {
    const p = programs.find((x) => x.id === id);
    for (const f of [...fields, 'notes', 'officialUrl', 'lastVerified']) assert.ok(p[f], `${id}.${f}`);
    assert.ok(p.sources.length >= 4 && p.sources.some((s) => s.official), id);
    for (const s of p.sources) assert.match(s.url, /^https:\/\//);
  }
});

test('Etihad Guest distance chart: bands rise and cover every distance', () => {
  const p = charts.find((x) => x.id === 'etihad');
  assert.equal(p.kind, 'distance');
  for (const t of p.tables) {
    const bands = t.bands;
    assert.equal(bands[bands.length - 1].upTo, null, t.label);
    for (let i = 1; i < bands.length; i++) {
      if (bands[i].upTo != null) assert.ok(bands[i].upTo > bands[i - 1].upTo, t.label);
      for (const c of ['Y', 'W', 'J', 'F']) {
        if (bands[i][c] == null) continue;
        assert.ok(bands[i][c] >= bands[i - 1][c], `${t.label} ${c} ${bands[i].upTo}`);
      }
    }
  }
});

test('points: Taiwan routes into both programs, direct and through hotels', () => {
  const rateTo = (name) => points.calc.sources.filter((s) => s.rates.some((r) => r.to === 'other' && r.name === name)).map((s) => s.id);
  assert.deepEqual(rateTo('LifeMiles').sort(), ['hsbc-premier', 'hsbc-travel']);
  assert.deepEqual(rateTo('阿提哈德'), ['cathay-tree', 'cathay-tree-world']);
  const hotels = points.calc.hotels.toAir.hotels;
  const into = (to) => Object.keys(hotels).filter((h) => hotels[h].partners.some((p) => p.to === to)).sort();
  assert.deepEqual(into('lifemiles'), ['accor', 'ihg', 'marriott']);
  assert.deepEqual(into('etihad'), ['accor', 'hilton', 'ihg', 'marriott', 'shangrila']);
});

test('expiry rules point at real programs', () => {
  for (const [k, r] of Object.entries(expiry)) {
    assert.ok(programs.some((p) => p.id === r.programId), k);
    if (r.kind === 'activity') assert.ok(r.months > 0, k);
  }
  assert.equal(expiry.lifemiles.months, 12);
  assert.equal(expiry.etihad.months, 18);
});

test('Etihad chart: own-flight prices only on routes touching the UAE, partner prices everywhere', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'features.js'), 'utf8');
  const grab = (re) => src.match(re)[0];
  const ctx = { data: { charts: require('../data/charts.json') }, fmt: (n) => Number(n).toLocaleString('en-US') };
  vm.createContext(ctx);
  vm.runInContext([
    grab(/function inArea\(area, ap\) \{[\s\S]*?\n\}/),
    grab(/function regionOf\(regions, ap\) \{[\s\S]*?\n\}/),
    grab(/const bandFor = .*;/),
    grab(/const bandNote = .*;/),
    grab(/function alaskaArea\(a, b\) \{[\s\S]*?\n\}/),
    grab(/function chartPrices\(p, from, to, cabin, dist\) \{[\s\S]*?\n\}/),
    'this.chartPrices = chartPrices;',
  ].join('\n'), ctx);
  const ey = charts.find((x) => x.id === 'etihad');
  const TPE = { code: 'TPE', country: 'TW' };
  const auh = ctx.chartPrices(ey, TPE, { code: 'AUH', country: 'AE' }, 'J', 4132).map((x) => x.miles).sort((a, b) => a - b);
  assert.deepEqual(auh, [75000, 100000]);
  const yvr = ctx.chartPrices(ey, TPE, { code: 'YVR', country: 'CA' }, 'J', 5960).map((x) => x.miles);
  assert.deepEqual(yvr, [120000]);
});
