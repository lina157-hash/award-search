// Round 8 audit fixes: 400 errors without 重試 (B1), explore programs checked (B2), map popups merge a city's airports
// (B5), third-party labels on fees, map charts and cabin products (D1–D3), the official charts and fees (D4, D5),
// alliance notes (D7), copy (C1, C3, C4), consistent demo data (B6), cache and security headers (P1, P4), and Asia
// Miles pricing Cathay connections through Hong Kong by both sectors' distances (T&C 2026, cl. 16).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
delete process.env.SEATS_AERO_API_KEY;
const { server } = require('../server');
const { todayTW } = require('../lib/day');
const mock = require('../lib/mock');

const root = path.join(__dirname, '..');
const read = (f) => JSON.parse(fs.readFileSync(path.join(root, 'data', f), 'utf8'));
const pub = (f) => fs.readFileSync(path.join(root, 'public', f), 'utf8');
function grab(file, re) {
  const m = pub(file).match(re);
  assert.ok(m, `${re} in ${file}`);
  return m[0];
}
const plain = (x) => JSON.parse(JSON.stringify(x));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n).toLocaleString('zh-TW');
const airports = require('../public/airports.min.json').airports;
const AP = { byCode: new Map(airports.map(([code, city, , country, , large, zh, , lat, lon]) => [code, { code, city, country, large, zh, lat, lon }])), list: [], groups: [] };

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

// ---------- B1, B2 ----------
test('B1: a 400 shows its message without a 重試 button; other errors keep it', () => {
  const ctx = { esc, reveal: () => {}, $: () => ({ addEventListener() {} }) };
  vm.createContext(ctx);
  vm.runInContext(`${grab('app.js', /function showError\(status, err, retry\) \{[\s\S]*?\n\}/)}\nthis.showError = showError;`, ctx);
  const status = {};
  ctx.showError(status, Object.assign(new Error('這段日期已經過了'), { status: 400 }), () => {});
  assert.match(status.innerHTML, /已經過了/);
  assert.doesNotMatch(status.innerHTML, /重試/);
  ctx.showError(status, Object.assign(new Error('伺服器忙碌'), { status: 503 }), () => {});
  assert.match(status.innerHTML, /重試/);
  ctx.showError(status, new Error('連不上伺服器'), () => {});
  assert.match(status.innerHTML, /重試/, 'offline errors have no status and can be retried');
});

test('B2: explore refuses a program seats.aero does not name, before any call', async () => {
  const day = todayTW();
  for (const p of ['nosuch', 'constructor', 'toString']) {
    const res = await fetch(`${base}/api/explore?program=${p}&start=${day}`);
    assert.equal(res.status, 400, p);
    assert.match((await res.json()).error, /program/);
  }
  assert.equal((await fetch(`${base}/api/explore?program=aeroplan&start=${day}`)).status, 200);
});

// ---------- Asia Miles: Cathay connections through Hong Kong ----------
const amCtx = () => {
  const ctx = { data: { asiamiles: read('asiamiles.json'), alliances: read('alliances.json'), charts: { programs: [] } }, AP, fmt, esc, console };
  vm.createContext(ctx);
  vm.runInContext([
    grab('features.js', /function haversineMiles\(a, b\) \{[\s\S]*?\n\}/),
    grab('app.js', /function allianceCarriers\(id\) \{[\s\S]*?\n\}/),
    grab('app.js', /function amBand\(dist, o, d\) \{[\s\S]*?\n\}/),
    grab('app.js', /function amPrice\(kind, dist, cabin, o, d\) \{[\s\S]*?\n\}/),
    grab('app.js', /const AM_HUB = 'HKG';/),
    grab('app.js', /function amCxDist\([\s\S]*?\n\}/),
    grab('app.js', /const AM_VIA_TEXT = .*;/),
    grab('app.js', /const oneworld = .*;/),
    grab('app.js', /const amCarriers = .*;/),
    grab('app.js', /const amNeedsHub = [\s\S]*?;\n/),
    grab('app.js', /function amFromAvailability\(r, cabin\) \{[\s\S]*?\n\}/),
    grab('features.js', /function amRoutePrices\(a, b, dist, cabin\) \{[\s\S]*?\n\}/),
    grab('features.js', /function rmapPrices\(a, b, cabin, trip, only\) \{[\s\S]*?\n\}/),
    'this.f = { amCxDist, amFromAvailability, amNeedsHub, amRoutePrices, rmapPrices, haversineMiles, AM_VIA_TEXT };',
  ].join('\n'), ctx);
  return ctx.f;
};

test('Asia Miles: Cathay between two places other than Hong Kong is priced o→HKG + HKG→d (cl. 16)', () => {
  const f = amCtx();
  // Search rows: seats.aero's distance is the straight origin→destination one.
  const row = (o, d, direct, dist) => ({ origin: o, destination: d, distance: dist, cabins: { J: { available: true, miles: 50000, airlines: 'CX', direct } } });
  const cases = [
    // [o, d, straight miles, J via Hong Kong, band via, J if it were nonstop]
    ['TPE', 'SYD', 4528, 91000, 'long', 60000],
    ['TPE', 'LAX', 6787, 119000, 'ultralong', 91000],
    ['TPE', 'DEL', 2717, 60000, 'medium', 33000],
  ];
  for (const [o, d, dist, j, band, nonstopJ] of cases) {
    const est = plain(f.amFromAvailability(row(o, d, false, dist), 'J'));
    assert.equal(est.miles, j, `${o}→${d}`);
    assert.equal(est.band, band, `${o}→${d}`);
    assert.equal(est.via, 'HKG');
    assert.ok(est.dist > dist, 'two sectors are longer than the straight line');
    // A row seats.aero marks nonstop keeps the straight distance.
    assert.equal(f.amFromAvailability(row(o, d, true, dist), 'J').miles, nonstopJ, `${o}→${d} nonstop`);
    assert.ok(f.amNeedsHub(row(o, d, false, dist)));
  }
  // An end in Hong Kong: one sector, the straight distance.
  for (const [o, d, dist, j] of [['TPE', 'HKG', 500, 16000], ['HKG', 'LHR', 5984, 91000]]) {
    const est = plain(f.amFromAvailability(row(o, d, false, dist), 'J'));
    assert.deepEqual([est.miles, est.via, est.dist], [j, '', dist], `${o}→${d}`);
    assert.ok(!f.amNeedsHub(row(o, d, false, dist)));
  }
  assert.equal(f.amCxDist('TPE', 'SYD', 4528, false, () => null), null, 'no coordinates: no estimate rather than a low one');
  // Other oneworld carriers keep the route distance (their connections are not known from a search row).
  const qf = { origin: 'TPE', destination: 'SYD', distance: 4528, cabins: { J: { available: true, miles: 50000, airlines: 'QF', direct: false } } };
  assert.equal(f.amFromAvailability(qf, 'J').miles, read('asiamiles.json').charts.partner.medium.J);
  assert.ok(!f.amNeedsHub(qf));
});

test('Asia Miles: short-haul type 2 follows the two ends, not Hong Kong (cl. 9); listed nonstops stay straight', () => {
  const f = amCtx();
  // TPE→NRT through Hong Kong is 2,340 miles, still short haul, and type 2 because Tokyo is an end.
  const nrt = { origin: 'TPE', destination: 'NRT', distance: 1355, cabins: { J: { available: true, airlines: 'CX', direct: false } } };
  assert.equal(f.amFromAvailability(nrt, 'J').band, 'short2');
  // A pair in asiamiles.json cxNonstops is priced as flown nonstop.
  const ctx = { data: { asiamiles: { ...read('asiamiles.json'), cxNonstops: [['NRT', 'TPE']] } }, AP };
  vm.createContext(ctx);
  vm.runInContext([grab('features.js', /function haversineMiles\(a, b\) \{[\s\S]*?\n\}/), grab('app.js', /const AM_HUB = 'HKG';/), grab('app.js', /function amCxDist\([\s\S]*?\n\}/), 'this.d = amCxDist;'].join('\n'), ctx);
  assert.deepEqual(plain(ctx.d('TPE', 'NRT', 1355, false)), { dist: 1355, via: '' });
  assert.equal(ctx.d('TPE', 'SYD', 4528, false).via, 'HKG');
});

test('Asia Miles: 兌換地圖 and 哩程試算 price Cathay through Hong Kong and say so', () => {
  const f = amCtx();
  const ap = (c) => AP.byCode.get(c);
  const chart = read('asiamiles.json').charts;
  // 哩程試算 lists both lines: Cathay by the two sectors, one partner flown alone by the straight distance.
  const both = (o, d) => plain(f.amRoutePrices(ap(o), ap(d), f.haversineMiles(ap(o), ap(d)), 'J')).map((x) => [x.kind, x.miles, x.via]);
  assert.deepEqual(both('TPE', 'SYD'), [['cx', 91000, 'HKG'], ['partner', chart.partner.medium.J, '']]);
  assert.deepEqual(both('TPE', 'LAX'), [['cx', 119000, 'HKG'], ['partner', chart.partner.long.J, '']]);
  assert.deepEqual(both('TPE', 'DEL'), [['cx', 60000, 'HKG'], ['partner', chart.partner.short2.J, '']]);
  assert.deepEqual(both('TPE', 'HKG'), [['cx', 16000, ''], ['partner', chart.partner.ultrashort.J, '']]);
  assert.deepEqual(both('HKG', 'LHR'), [['cx', 91000, ''], ['partner', chart.partner.long.J, '']]);
  // 兌換地圖 shows each program's cheapest line, naming the Hong Kong connection when that is the one.
  const am = (o, d, trip = 'ow') => plain(f.rmapPrices(ap(o), ap(d), 'J', trip, 'asiamiles').prices);
  assert.deepEqual(am('TPE', 'SIN'), [{ id: 'asiamiles', label: `國泰航班・${f.AM_VIA_TEXT}`, miles: 27000 }]);
  assert.deepEqual(am('TPE', 'HKG'), [{ id: 'asiamiles', label: '國泰航班', miles: 16000 }]);
  assert.deepEqual(am('TPE', 'SYD'), [{ id: 'asiamiles', label: '夥伴航班', miles: chart.partner.medium.J }], 'no longer Cathay at 60,000');
  assert.deepEqual(am('TPE', 'SIN', 'rt'), [{ id: 'asiamiles', label: `國泰航班・${f.AM_VIA_TEXT}`, miles: 54000 }]);
});

// ---------- B5, D2: 兌換地圖 ----------
test('B5: a multi-airport city prices each program to its own cheapest airport; D2 marks third-party charts', () => {
  const lon = ['LHR', 'LGW', 'TPE'].map((c) => AP.byCode.get(c));
  const charts = { programs: [
    { id: 'aa', kind: 'distance', confidence: 'secondary', tables: [{ label: '夥伴', bands: [{ upTo: 6080, Y: 1, W: 1, J: 50000, F: 1 }, { upTo: null, Y: 1, W: 1, J: 70000, F: 1 }] }] },
    { id: 'bb', kind: 'routeSpecific', confidence: 'official', routes: [{ from: ['TPE'], to: ['LGW'], J: 40000 }] },
  ] };
  const ctx = {
    data: { asiamiles: read('asiamiles.json'), charts }, fmt, esc, console,
    AP: { ...AP, list: lon, groups: [{ zh: '倫敦', codes: ['LHR', 'LGW', 'STN'] }] },
    rmap: { origins: ['TPE'], cabin: 'J', trip: 'ow', program: '', budget: 0, mine: false }, walletEmpty: () => true,
  };
  vm.createContext(ctx);
  vm.runInContext([
    grab('features.js', /function haversineMiles\(a, b\) \{[\s\S]*?\n\}/),
    grab('features.js', /function inArea\(area, ap\) \{[\s\S]*?\n\}/),
    grab('features.js', /function regionOf\(regions, ap\) \{[\s\S]*?\n\}/),
    grab('features.js', /const bandFor = .*;/),
    grab('features.js', /const bandNote = .*;/),
    grab('features.js', /function chartPrices\(p, from, to, cabin, dist\) \{[\s\S]*?\n\}/),
    grab('app.js', /function amBand\(dist, o, d\) \{[\s\S]*?\n\}/),
    grab('app.js', /function amPrice\(kind, dist, cabin, o, d\) \{[\s\S]*?\n\}/),
    grab('app.js', /const AM_HUB = 'HKG';/),
    grab('app.js', /function amCxDist\([\s\S]*?\n\}/),
    grab('app.js', /const AM_VIA_TEXT = .*;/),
    grab('features.js', /function amRoutePrices\(a, b, dist, cabin\) \{[\s\S]*?\n\}/),
    grab('features.js', /function rmapPrices\(a, b, cabin, trip, only\) \{[\s\S]*?\n\}/),
    grab('features.js', /const rmapFroms = .*;/),
    grab('features.js', /function rmapDestinations\(\) \{[\s\S]*?\n\}/),
    grab('features.js', /const rmapThirdParty = .*;/),
    'this.f = { rmapDestinations, rmapThirdParty };',
  ].join('\n'), ctx);
  const dests = ctx.f.rmapDestinations();
  assert.equal(dests.length, 1, 'one pin for 倫敦');
  const d = dests[0];
  assert.equal(d.city, '倫敦');
  assert.deepEqual(plain(d.tos), ['LHR', 'LGW'], 'the main airport first');
  assert.equal(d.ap.code, 'LGW', 'the pin sits on the cheapest program’s airport');
  const by = Object.fromEntries(d.prices.map((x) => [x.id, [x.to, x.miles]]));
  assert.deepEqual(by.bb, ['LGW', 40000]);
  assert.deepEqual(by.aa, ['LHR', 50000], 'not LGW’s 70,000 just because LGW has the cheapest program');
  assert.deepEqual(by.asiamiles, ['LHR', 91000], 'a tie goes to the main airport');
  assert.equal(ctx.f.rmapThirdParty('aa'), true);
  assert.equal(ctx.f.rmapThirdParty('bb'), false);
  assert.equal(ctx.f.rmapThirdParty('asiamiles'), false);
  // The page: popups add 「・第三方整理」 and the map gets one line about it; Leaflet popups keep clear of the zoom control.
  const src = pub('features.js');
  assert.match(src, /rmapThirdParty\(x\.id\) \? '・第三方整理' : ''/);
  assert.equal((src.match(/autoPanPaddingTopLeft: L\.point\(52, 12\)/g) || []).length, 2, '兌換地圖 and 區域探索');
});

// ---------- D1, D3, D5 ----------
test('D1/D5: third-party fee chips carry a * and say so in the tooltip; EVA partner awards follow the official page', () => {
  const ctx = { data: { fees: read('fees.json') }, esc };
  vm.createContext(ctx);
  vm.runInContext([
    grab('award-tools.js', /const atKey = .*;/),
    grab('award-tools.js', /const atShort = .*;/),
    grab('award-tools.js', /function feeShort\(fees, program\) \{[\s\S]*?\n\}/),
    grab('award-tools.js', /const feeChipText = .*;/),
    grab('award-tools.js', /const fee3p = .*;/),
    grab('award-tools.js', /const FEE_3P_MARK = .*;/),
    grab('award-tools.js', /function feeChipHtml\(program\) \{[\s\S]*?\n\}/),
    grab('award-tools.js', /function feeHeadHtml\(program\) \{[\s\S]*?\n\}/),
    grab('award-tools.js', /const feeAny3p = .*;/),
    'this.f = { feeChipHtml, feeHeadHtml, feeAny3p, feeShort, feeChipText };',
  ].join('\n'), ctx);
  const { f } = ctx;
  for (const html of [f.feeChipHtml('united'), f.feeHeadHtml('united')]) {
    assert.match(html, /<sup class="mk-3p" aria-hidden="true">\*<\/sup>/);
    assert.match(html, /title="[^"]*第三方整理/);
  }
  for (const html of [f.feeChipHtml('aeroplan'), f.feeHeadHtml('asiamiles_est')]) {
    assert.doesNotMatch(html, /mk-3p|第三方整理/);
  }
  const fees = read('fees.json');
  assert.equal(f.feeAny3p(fees, ['aeroplan', 'asiamiles_est']), false);
  assert.equal(f.feeAny3p(fees, ['aeroplan', 'united']), true);
  const eva = fees.programs.eva;
  assert.equal(eva.confidence, 'official');
  assert.match(eva.source.url, /^https:\/\/www\.evaair\.com\/.*star-alliance/);
  assert.equal(f.feeChipText(f.feeShort(fees, 'eva')), '改 US$50・退 官網免費／其他 US$50');
  assert.match(eva.note, /第三方整理/, 'the own-flight part that is not on the official page says where it comes from');
  assert.match(pub('app.js'), /FEE_3P_NOTE/, 'one line explains the *');
});

test('D3: cabin products are marked third-party in the data, on the pill and once under the flights', () => {
  assert.equal(read('products.json').confidence, 'secondary');
  const app = pub('app.js');
  assert.match(app, /class="pill prod" title="\$\{PROD_3P_TITLE\}">\$\{esc\(p\.name\)\}<sup class="mk-3p"/);
  assert.match(app, /prod-3p-note">\$\{PROD_3P_NOTE\}/);
  assert.match(app, /ⓘ 產品資料為第三方整理/);
  assert.match(pub('features.js'), /const PROD_3P_NOTE = '\* 艙位產品依機型推測，為第三方整理/);
});

// ---------- D4, D7, C1, C4 ----------
test('D4: Turkish partner chart matches the official page (regions too); Virgin Atlantic is dynamic per its own page', () => {
  const charts = read('charts.json').programs;
  const tk = charts.find((p) => p.id === 'turkish');
  assert.equal(tk.confidence, 'official');
  assert.ok(tk.sources[0].official && /turkishairlines\.com/.test(tk.sources[0].url));
  const fe = Object.fromEntries(tk.tables[0].pairs.map((p) => [p.to, [p.Y, p.J, p.F]]));
  // The Far East row and column of the official Star Alliance chart (one-way, 2026-10-16).
  assert.deepEqual(fe, {
    FE: [35000, 50000, 65000], TR: [35000, 65000, 100000], EU1: [45000, 85000, 130000], EU2: [50000, 90000, 135000],
    CAS: [55000, 100000, 150000], ME: [53000, 93000, 140000], NAF: [55000, 105000, 160000], CAF: [60000, 125000, 190000],
    SAF: [70000, 140000, 210000], NAM: [75000, 130000, 195000], SAM: [85000, 140000, 210000], OCE: [95000, 205000, 290000],
  });
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext([grab('features.js', /function inArea\(area, ap\) \{[\s\S]*?\n\}/), grab('features.js', /function regionOf\(regions, ap\) \{[\s\S]*?\n\}/), 'this.regionOf = regionOf;'].join('\n'), ctx);
  const at = (code, country) => ctx.regionOf(tk.regions, { code, country });
  assert.equal(at('ECN', 'CY'), 'EU1', 'Northern Cyprus is Europe 1');
  assert.equal(at('LCA', 'CY'), null, 'the rest of Cyprus is not in the official list');
  assert.equal(at('BJM', 'BI'), 'CAF');
  assert.equal(at('LAD', 'AO'), 'SAF');
  assert.equal(at('MPN', 'FK'), null);
  assert.equal(at('CAY', 'GF'), null);
  const va = charts.find((p) => p.id === 'virginatlantic');
  assert.equal(va.kind, 'dynamic');
  assert.ok(va.sources.length && va.sources.every((s) => s.official && /virginatlantic\.com/.test(s.url)));
});

test('D7/C1/C4: alliance notes follow official releases; 哩程 in visible data text; spacing in promo titles', () => {
  const star = read('alliances.json').alliances.find((a) => a.id === 'star');
  const oz = star.memberNotes.find((n) => n.code === 'OZ');
  const az = star.memberNotes.find((n) => n.code === 'AZ');
  assert.match(oz.note, /2026-10-16 起出發的韓亞航班不再累積星盟哩程/);
  const azSources = [].concat(az.source);
  assert.ok(azSources.length >= 1 && azSources.every((s) => !/loyaltylobby/.test(s.url)));
  assert.doesNotMatch(JSON.stringify(read('alliances.json').alliances.map((a) => [a.summary, a.memberNotes])), /里程/);
  const programs = read('programs.json').programs;
  const lm = programs.find((p) => p.id === 'lifemiles');
  assert.doesNotMatch(`${lm.expiry}${lm.pooling}`, /里程/);
  assert.ok(JSON.stringify(programs).includes('華航哩程轉讓（官方）'));
  assert.ok([...read('promos.json').promos, ...read('promos-history.json').promos].some((p) => p.title === '阿聯酋 Skywards 買哩最高加贈 30%'));
  // Several sources on one note are all linked.
  assert.match(pub('app.js'), /\[\]\.concat\(n\.source \|\| \[\]\)/);
});

// ---------- C3 ----------
test('C3: 我的行程 writes Taiwan-dollar taxes as NT$, like the trip dialog', () => {
  const ctx = { esc, fmt };
  vm.createContext(ctx);
  vm.runInContext(`${grab('features.js', /const planMoney = .*;/)}\nthis.planMoney = planMoney;`, ctx);
  assert.equal(ctx.planMoney('TWD', 8500), 'NT$8,500');
  assert.equal(ctx.planMoney('USD', 56.4), 'USD 56');
  assert.equal(ctx.planMoney('', 12), '12');
});

// ---------- B6 ----------
test('B6: demo cash insights agree with their range; demo explore keeps to the regions asked', () => {
  const day = '2026-12-01';
  for (const [o, d] of [['TPE', 'NRT'], ['TPE', 'LAX'], ['TPE', 'CDG'], ['TPE', 'SIN'], ['KHH', 'HKG'], ['TPE', 'SYD']]) {
    const pi = mock.mockCash({ departure_id: o, arrival_id: d, outbound_date: day, type: 2 }).price_insights;
    if (!pi) continue;
    const [lo, hi] = pi.typical_price_range;
    const want = pi.lowest_price < lo ? 'low' : pi.lowest_price > hi ? 'high' : 'typical';
    assert.equal(pi.price_level, want, `${o}→${d}`);
  }
  const rows = mock.mockAvailability({ source: 'aeroplan', start_date: day, end_date: day, origin_region: 'Asia', destination_region: 'North America' });
  assert.ok(rows.length);
  const cont = new Map(airports.map((r) => [r[0], r[4]]));
  for (const r of rows) assert.deepEqual([cont.get(r.Route.OriginAirport), cont.get(r.Route.DestinationAirport)], ['AS', 'NA']);
  // The Cathay demo route that connects in Hong Kong is never nonstop.
  const syd = mock.mockSearch({ origin_airport: 'TPE', destination_airport: 'SYD', start_date: day, end_date: '2026-12-10' });
  assert.ok(syd.length);
  for (const it of syd) for (const c of ['Y', 'W', 'J', 'F']) assert.equal(it[`${c}Direct`], false);
});

// ---------- P1, P4 ----------
test('P1/P4: versioned scripts and styles are cached for good, others briefly; security headers on every path', () => {
  const v = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  const js = v.headers.filter((h) => h.source === '/(.*)\\.(js|css)');
  const cache = (h) => h.headers.find((x) => x.key === 'Cache-Control').value;
  const versioned = js.find((h) => h.has?.some((x) => x.type === 'query' && x.key === 'v'));
  const plainRule = js.find((h) => h.missing?.some((x) => x.type === 'query' && x.key === 'v'));
  assert.equal(cache(versioned), 'public, max-age=31536000, immutable');
  assert.equal(cache(plainRule), 'public, max-age=300, stale-while-revalidate=86400');
  const all = v.headers.find((h) => h.source === '/(.*)');
  assert.deepEqual(Object.fromEntries(all.headers.map((h) => [h.key, h.value])), {
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Content-Security-Policy': "frame-ancestors 'self'",
  });
  // That is safe only while every script and stylesheet the page links carries the release in ?v=, which
  // scripts/bump-version.js rewrites on every release.
  const html = pub('index.html');
  const version = read('version.json').version;
  const refs = [...html.matchAll(/(?:src|href)="(\/[^"]+\.(?:js|css)[^"]*)"/g)].map((m) => m[1]);
  assert.ok(refs.length > 10);
  for (const r of refs) assert.ok(r.endsWith(`?v=${version}`), r);
  const bump = fs.readFileSync(path.join(root, 'scripts', 'bump-version.js'), 'utf8').match(/html\.replace\((\/.*\/g), /)[1];
  const re = vm.runInNewContext(bump);
  const next = html.replace(re, '$1?v=9.9.9');
  for (const r of [...next.matchAll(/(?:src|href)="(\/[^"]+\.(?:js|css)[^"]*)"/g)].map((m) => m[1])) assert.ok(r.endsWith('?v=9.9.9'), r);
  // Scripts loaded later take the same ?v= from app.js's own URL.
  assert.match(pub('app.js'), /el\.src = `\/\$\{name\}\.js\$\{ASSET_V \? `\?v=\$\{ASSET_V\}` : ''\}`/);
});
