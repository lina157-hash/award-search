// Fee chips, hold vs bank transfer time, NT$ cost per row and the upgrade calculator (public/award-tools.js + data).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const T = require('../public/award-tools.js');

const read = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', f), 'utf8'));
const fees = read('fees.json');
const holds = read('holds.json');
const costs = read('milecost.json');
const upg = read('upgrades.json');
const calc = read('points.json').calc.sources;
// Same mapping the browser passes (features.js PROGRAM_TRANSFER plus ANA).
const MAP = {
  asiamiles: { to: 'asiamiles' }, singapore: { to: 'sq' }, eva: { to: 'eva' }, ci: { to: 'ci' },
  aeroplan: { name: '加航' }, flyingblue: { name: '法荷航' }, united: { name: '聯合' }, qatar: { name: '卡達' },
  british: { name: '英航' }, turkish: { name: '土航' }, qantas: { name: '澳航' }, emirates: { name: '阿聯酋' },
  etihad: { name: '阿提哈德' }, lifemiles: { name: 'LifeMiles' }, jal: { name: '日航' }, ana: { name: '全日空' },
};

test('fees.json: every program has a short change and cancel text; chips drop the asides', () => {
  for (const [k, f] of Object.entries(fees.programs)) {
    assert.ok(f.change && f.cancel, k);
    assert.ok(['official', 'secondary'].includes(f.confidence), k);
  }
  const am = T.feeShort(fees, 'asiamiles_est');
  assert.equal(am.key, 'asiamiles');
  assert.equal(T.feeChipText(am), '改 US$50・退 US$120');
  assert.equal(T.feeChipText(T.feeShort(fees, 'aeroplan')), '改 CA$75／方向・退 CA$150');
  assert.equal(T.feeShort(fees, 'nosuch'), null);
});

test('holds.json: transfer times name real banks and points programs, and cover every airline column', () => {
  const banks = new Set(calc.map((s) => s.bank));
  const ids = new Set(calc.map((s) => s.id));
  for (const t of holds.transfers) {
    assert.ok(banks.has(t.bank), t.bank);
    for (const id of t.sources || []) assert.ok(ids.has(id), id);
    assert.ok(t.days.length === 2 && t.days[0] <= t.days[1] && t.days[1] <= 90, `${t.bank} ${t.text}`);
    assert.ok(t.text && ['official', 'verify', 'typical'].includes(t.confidence), t.bank);
  }
  for (const s of calc) for (const r of s.rates) {
    if (r.to === 'other') continue;
    assert.ok(T.transferTimeFor(holds, s, r), `${s.id} → ${r.to} has a transfer time`);
  }
  for (const [k, h] of Object.entries(holds.programs)) assert.ok(h.hold === null || typeof h.hold === 'boolean', k);
});

test('hold advice: HSBC and 國泰世華 app transfers are instant (not to CI or Asia Miles), and CI is unknown', () => {
  // HSBC 旅人卡 posts instantly in the app, except China Airlines, KrisFlyer, JAL and Hainan.
  const hsbc = calc.find((s) => s.id === 'hsbc-travel');
  assert.equal(T.transferTimeFor(holds, hsbc, { to: 'eva' }).instant, true);
  assert.equal(T.transferTimeFor(holds, hsbc, { to: 'ci' }).instant, undefined);
  assert.equal(T.transferTimeFor(holds, hsbc, { to: 'other', name: '日航' }).text, '7 至 21 個工作天');
  assert.equal(T.holdAdvice(holds, calc, MAP, 'eva').kind, 'instant');
  // 國泰世華 小樹點 post instantly in the CUBE App except to 華航 and 亞洲萬里通 (3–14 working days); Asia Miles holds 3 days.
  const mine = T.holdAdvice(holds, calc, MAP, 'eva', ['cathay-tree']);
  assert.equal(mine.kind, 'instant');
  assert.equal(mine.mine, true);
  const am = T.holdAdvice(holds, calc, MAP, 'asiamiles', ['cathay-tree']);
  assert.equal(am.kind, 'hold-short');
  assert.equal(am.fastest.time.text, '約 3 至 14 個工作天');
  // Wallet banks that can't reach the program don't narrow the choice.
  assert.equal(T.holdAdvice(holds, calc, MAP, 'eva', ['hncb-bonus-theone']).mine, false);
  const ci = T.holdAdvice(holds, calc, MAP, 'ci');
  assert.equal(ci.kind, 'unknown');
  assert.equal(ci.fastest.bank, '國泰世華', 'CUBE: 3 to 14 working days beats 星展 5');
  // Aeroplan can't be held: HSBC and 國泰世華 points move in instantly in the app.
  assert.equal(T.holdAdvice(holds, calc, MAP, 'aeroplan').kind, 'instant');
  assert.equal(T.holdAdvice(holds, calc, MAP, 'aeroplan', ['cathay-tree']).kind, 'instant');
  assert.equal(T.holdAdvice(holds, calc, MAP, 'aeroplan', ['dbs-flight']).kind, 'instant', 'a wallet bank that cannot reach the program does not narrow the choice');
  assert.equal(T.holdAdvice(holds, calc, MAP, 'singapore', ['ctbc-bonus']).kind, 'hold-short');
  assert.equal(T.holdAdvice(holds, calc, MAP, 'united', ['hsbc-premier']).kind, 'instant');
  assert.equal(T.holdAdvice(holds, calc, MAP, 'alaska').kind, 'none');
  assert.equal(T.holdAdvice(holds, calc, MAP, 'lufthansa').kind, 'hold-only');
});

test('NT$ cost: miles × cost per mile + taxes converted at the day rate', () => {
  assert.equal(T.perMileOf(costs, {}, 'eva'), costs.defaults.eva);
  assert.equal(T.perMileOf(costs, { eva: 0.32 }, 'eva'), 0.32);
  assert.equal(T.perMileOf(costs, {}, 'asiamiles_est'), costs.defaults.asiamiles);
  assert.equal(T.perMileOf(costs, {}, 'ethiopian'), costs.fallback);
  assert.deepEqual(T.cleanCosts({ eva: '0.35', ci: -1, x: 'a', 'Bad-Key': 1, big: 99, aeroplan: 0.4567 }), { eva: 0.35, aeroplan: 0.457 });
  assert.deepEqual(T.cleanCosts(null), {});
  assert.deepEqual(T.twdCost(70000, 0.4, { amount: 3958, currency: 'TWD' }), { twd: 31958, milesTwd: 28000, tax: 3958, taxKnown: true });
  assert.deepEqual(T.twdCost(60000, 0.5, { amount: 100, currency: 'usd' }, { USD: 32 }), { twd: 33200, milesTwd: 30000, tax: 3200, taxKnown: true });
  assert.equal(T.twdCost(60000, 0.5, { amount: 100, currency: 'XYZ' }, { USD: 32 }).taxKnown, false);
  assert.equal(T.twdCost(60000, 0.5, null).twd, 30000);
  // A cheaper-per-mile program can beat a lower mileage number.
  const a = T.twdCost(50000, 0.6, { amount: 600, currency: 'TWD' }).twd;
  const b = T.twdCost(60000, 0.4, { amount: 1200, currency: 'TWD' }).twd;
  assert.ok(b < a);
});

const ap = (code, country) => ({ code, country });
const TPE = ap('TPE', 'TW');
const quote = (air, a, b, pair, dist = 0) => T.upgradeQuote(upg, air, a, b, ...pair.split('-'), dist);
const miles = (q) => q.charts.map((c) => c.fares.map((f) => f.miles));

test('upgrades.json: every row names known areas and fares', () => {
  for (const air of upg.airlines) {
    assert.ok(air.sources?.length && air.confidence, air.id);
    for (const ch of air.charts) {
      if (air.kind === 'distance') { assert.ok(ch.bands.at(-1).upTo == null, air.id); continue; }
      const fareIds = (air.fares[ch.from] || []).map((f) => f.id);
      assert.ok(fareIds.length, `${air.id} fares for ${ch.from}`);
      for (const r of ch.rows) {
        for (const id of r.between) assert.ok(upg.areas[id], `${air.id} area ${id}`);
        for (const k of Object.keys(r.miles)) assert.ok(fareIds.includes(k), `${air.id} ${r.name} ${k}`);
      }
    }
  }
});

test('upgrade quotes: EVA, China Airlines, Starlux by zone and ANA by distance', () => {
  // EVA TPE–LAX economy → business: flights with and without premium economy both price it.
  const lax = quote('eva', TPE, ap('LAX', 'US'), 'Y-J');
  assert.deepEqual(miles(lax), [[50000, 60000], [50000, 60000]]);
  assert.deepEqual(lax.charts[0].fares.map((f) => f.codes.join('')), ['BY', 'QHM']);
  // US East is its own, dearer row and has no no-premium-economy price.
  assert.deepEqual(miles(quote('eva', ap('JFK', 'US'), TPE, 'Y-J')), [[58500, 70000]]);
  assert.deepEqual(miles(quote('eva', TPE, ap('LAX', 'US'), 'Y-W')), [[18500, 25000]]);
  assert.deepEqual(miles(quote('eva', TPE, ap('NRT', 'JP'), 'Y-J')), [[12000, 15000]]);
  assert.deepEqual(upgradePairsOf('eva'), ['Y-W', 'W-J', 'Y-J']);
  // China Airlines: Hong Kong and Delhi before the rest of Asia; the standard fare can't upgrade to North America.
  assert.deepEqual(miles(quote('ci', TPE, ap('HKG', 'HK'), 'Y-J')), [[10000, 13000]]);
  assert.deepEqual(miles(quote('ci', TPE, ap('DEL', 'IN'), 'Y-J')), [[20000, 25000]]);
  assert.deepEqual(miles(quote('ci', TPE, ap('BKK', 'TH'), 'Y-J')), [[15000, 20000]]);
  assert.deepEqual(miles(quote('ci', TPE, ap('LAX', 'US'), 'Y-J')), [[60000, null]]);
  assert.deepEqual(miles(quote('ci', TPE, ap('JFK', 'US'), 'Y-W')), [[22000, 28000]]);
  assert.deepEqual(miles(quote('ci', ap('SYD', 'AU'), ap('AKL', 'NZ'), 'W-J')), [[8000, 12000]]);
  // Starlux: two-cabin Asia only for economy → business; long haul only from premium economy up.
  assert.deepEqual(miles(quote('starlux', TPE, ap('NRT', 'JP'), 'Y-J')), [[18000]]);
  assert.equal(quote('starlux', TPE, ap('LAX', 'US'), 'Y-J').charts.length, 0);
  assert.deepEqual(miles(quote('starlux', TPE, ap('LAX', 'US'), 'W-J')), [[45000]]);
  // ANA: by sector distance; eligible economy classes depend on starting in Japan.
  const nrtJfk = quote('ana', ap('NRT', 'JP'), ap('JFK', 'US'), 'Y-J', 6700);
  assert.deepEqual(miles(nrtJfk), [[28000]]);
  assert.deepEqual(nrtJfk.charts[0].fares[0].codes, ['Y', 'B', 'M', 'U']);
  assert.equal(nrtJfk.charts[0].zone, '航段距離 5,501 哩以上');
  const tpeNrt = quote('ana', TPE, ap('NRT', 'JP'), 'Y-J', 1330);
  assert.deepEqual(tpeNrt.charts[0].fares[0].codes, ['Y', 'B', 'M', 'U', 'H']);
  assert.deepEqual(miles(tpeNrt), [[12000]]);
  assert.deepEqual(miles(quote('ana', TPE, ap('NRT', 'JP'), 'J-F', 2000)), [[20000]]);
  assert.deepEqual(miles(quote('ana', TPE, ap('NRT', 'JP'), 'J-F', 2001)), [[30000]]);
  assert.equal(T.upgradeQuote(upg, 'nosuch', TPE, TPE, 'Y', 'J', 0), null);
});
const upgradePairsOf = (id) => T.upgradePairs(upg.airlines.find((a) => a.id === id));
