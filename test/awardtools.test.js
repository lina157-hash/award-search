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
      if (air.kind === 'distance') {
        assert.ok(ch.bands.at(-1).upTo == null, air.id);
        const ids = ch.fares.map((f) => f.id);
        for (const b of ch.bands) {
          if (typeof b.miles === 'number') continue;
          assert.deepEqual(Object.keys(b.miles), ids, `${air.id} ${ch.from}-${ch.to} band ${b.upTo}`);
          for (const v of Object.values(b.miles)) assert.ok(v > 0, `${air.id} band ${b.upTo}`);
        }
        continue;
      }
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

// ---------- round 7: more airlines in 升等試算 ----------
const KHH = ap('KHH', 'TW');
const fareLabels = (q) => q.charts.map((c) => c.fares.map((f) => f.label));

test('upgrades.json: every airline has a logo code, a picker group, a date and official sources', () => {
  const logos = new Set(fs.readdirSync(path.join(__dirname, '..', 'public', 'logos')).map((f) => f.replace(/\.webp$/, '')));
  for (const air of upg.airlines) {
    assert.match(air.code, /^[A-Z0-9]{2}$/, air.id);
    assert.ok(logos.has(air.code), `${air.id} logo ${air.code}`);
    assert.ok(air.group, air.id);
    assert.match(air.lastVerified, /^\d{4}-\d{2}-\d{2}$/, air.id);
    for (const s of air.sources) assert.match(s.url, /^https:\/\//, air.id);
    if (air.confidence === 'official') assert.ok(air.sources.some((s) => s.official), air.id);
    // The owner's rule: no "call customer service to confirm" items.
    for (const r of air.rules) assert.doesNotMatch(r, /(客服|洽詢).{0,8}(確認|為準)|(確認|為準).{0,8}(客服|洽詢)/, air.id);
    for (const ch of air.charts) for (const r of ch.rows || []) if ('oneWay' in r) assert.equal(r.oneWay, true, `${air.id} ${r.name}`);
  }
  const ids = upg.airlines.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ['jal', 'sq', 'vn', 'qf', 'lh', 'tk']) assert.ok(ids.includes(id), id);
});

test('upgrade picker: airlines grouped by home region in data order', () => {
  const g = T.upgradeGroups(upg);
  assert.deepEqual(g.map((x) => x.name), ['台灣', '日本', '東南亞', '澳洲', '歐洲']);
  assert.deepEqual(g[0].airlines.map((a) => a.id), ['eva', 'ci', 'starlux']);
  assert.deepEqual(g[1].airlines.map((a) => a.id), ['ana', 'jal']);
  // An airline without a group lands in 其他, last.
  const extra = { airlines: [{ id: 'x' }, ...upg.airlines.slice(0, 1)] };
  assert.deepEqual(T.upgradeGroups(extra).map((x) => x.name), ['台灣', '其他']);
});

test('upgrade quotes: JAL by sector to or from Japan', () => {
  const nrt = ap('NRT', 'JP');
  const tpeNrt = quote('jal', TPE, nrt, 'Y-J');
  assert.deepEqual(miles(tpeNrt), [[12000]]);
  assert.deepEqual(tpeNrt.charts[0].fares[0].codes, ['Y', 'B', 'H', 'K']);
  assert.equal(tpeNrt.charts[0].zone, '日本—台北、香港、中國大陸（北京、大連、廣州、上海、天津）');
  assert.deepEqual(miles(quote('jal', nrt, TPE, 'J-F')), [[25000]]);
  assert.deepEqual(miles(quote('jal', nrt, ap('JFK', 'US'), 'Y-W')), [[20000]]);
  assert.deepEqual(miles(quote('jal', ap('HND', 'JP'), ap('LHR', 'GB'), 'Y-J')), [[33000]]);
  // Hawaii is its own row ahead of the rest of the US; premium economy → business costs the business column.
  const hnl = quote('jal', ap('HND', 'JP'), ap('HNL', 'US'), 'W-J');
  assert.deepEqual(miles(hnl), [[25000]]);
  assert.deepEqual(hnl.charts[0].fares[0].codes, ['W', 'R']);
  // Seoul has no first class; a sector that doesn't touch Japan isn't on the chart.
  assert.equal(quote('jal', nrt, ap('ICN', 'KR'), 'J-F').charts.length, 0);
  assert.equal(quote('jal', TPE, ap('BKK', 'TH'), 'Y-J').charts.length, 0);
});

test('upgrade quotes: Singapore Airlines by origin and destination zone, Saver and Advantage', () => {
  const sin = ap('SIN', 'SG');
  const yj = quote('sq', TPE, sin, 'Y-J');
  assert.deepEqual(miles(yj), [[27500, 48500, 20000, 34500]]);
  assert.deepEqual(yj.charts[0].fares.map((f) => f.codes.join('')), ['MHW', 'MHW', 'YBE', 'YBE']);
  // Premium economy upgrades are Saver only: the Advantage fares aren't listed at all.
  const yw = quote('sq', sin, TPE, 'Y-W');
  assert.deepEqual(miles(yw), [[16000, 9500]]);
  assert.deepEqual(fareLabels(yw), [['經濟艙 Standard（Saver 升等）', '經濟艙 Flexi（Saver 升等）']]);
  assert.deepEqual(miles(quote('sq', sin, ap('LHR', 'GB'), 'J-F')), [[82000, 172500]]);
  assert.deepEqual(miles(quote('sq', sin, ap('SFO', 'US'), 'W-J')), [[71000, 109500, 56000, 89000]]);
  assert.deepEqual(miles(quote('sq', KHH, ap('SYD', 'AU'), 'Y-J')), [[67500, 106000, 55500, 87000]]);
  // Perth is its own zone; cells the official chart leaves to the call centre are not shown.
  assert.deepEqual(miles(quote('sq', sin, ap('PER', 'AU'), 'Y-J')), [[34000, 69000, 28500, 57500]]);
  assert.equal(quote('sq', sin, ap('PER', 'AU'), 'Y-W').charts.length, 0);
  assert.equal(quote('sq', TPE, ap('NRT', 'JP'), 'Y-J').charts.length, 0);
  assert.equal(quote('sq', TPE, ap('LHR', 'GB'), 'Y-J').charts.length, 0);
});

test('upgrade quotes: Vietnam Airlines regular and peak, one-way rows by direction', () => {
  const sgn = ap('SGN', 'VN');
  const yj = quote('vn', TPE, sgn, 'Y-J');
  assert.deepEqual(yj.charts.map((c) => c.label), ['一般期間', '旺季']);
  assert.deepEqual(miles(yj), [[50000, 54000, 58000], [52000, 56000, 60000]]);
  assert.deepEqual(yj.charts[0].fares.map((f) => f.codes.join('')), ['YBM', 'SHKL', 'QNR']);
  assert.deepEqual(miles(quote('vn', ap('HAN', 'VN'), ap('HKG', 'HK'), 'Y-J')), [[52000, 56000, 60000], [54000, 58000, 62000]]);
  // Malaysia, India and Europe price each direction separately.
  assert.deepEqual(miles(quote('vn', sgn, ap('KUL', 'MY'), 'Y-J')), [[16000, 20000, 24000], [16000, 20000, 24000]]);
  assert.deepEqual(miles(quote('vn', ap('KUL', 'MY'), sgn, 'Y-J')), [[18000, 22000, 26000], [18000, 22000, 26000]]);
  assert.deepEqual(miles(quote('vn', ap('LHR', 'GB'), ap('HAN', 'VN'), 'W-J')), [[100000], [110000]]);
  assert.deepEqual(miles(quote('vn', ap('HAN', 'VN'), ap('LHR', 'GB'), 'W-J')), [[93000], [103000]]);
  // Premium economy: only Flex and Classic, only where the route has it.
  const nrtYW = quote('vn', ap('HAN', 'VN'), ap('NRT', 'JP'), 'Y-W');
  assert.deepEqual(miles(nrtYW), [[25000, 30000], [30000, 35000]]);
  assert.deepEqual(fareLabels(nrtYW)[0], ['經濟艙 Flex', '經濟艙 Classic']);
  assert.equal(quote('vn', TPE, sgn, 'Y-W').charts.length, 0);
  assert.equal(quote('vn', TPE, ap('NRT', 'JP'), 'Y-J').charts.length, 0);
});

test('upgrade quotes: Qantas by sector distance with a price per fare', () => {
  const syd = ap('SYD', 'AU');
  const sin = ap('SIN', 'SG');
  const yj = quote('qf', syd, sin, 'Y-J', 3910);
  assert.deepEqual(miles(yj), [[70600, 65400, 35900]]);
  assert.equal(yj.charts[0].zone, '航段距離 3,601–4,800 哩');
  assert.equal(yj.charts[0].fromJapan, null);
  assert.deepEqual(yj.charts[0].fares.map((f) => f.codes.join('')), ['', 'GKLMSV', 'BHY']);
  assert.deepEqual(miles(quote('qf', syd, ap('MEL', 'AU'), 'Y-W', 600)), [[9600, 7200, 2300]]);
  assert.deepEqual(miles(quote('qf', syd, ap('MEL', 'AU'), 'Y-W', 601)), [[14300, 11300, 3500]]);
  assert.deepEqual(miles(quote('qf', syd, ap('HND', 'JP'), 'W-J', 4840)), [[52300, 43100, 39200, 35300]]);
  const far = quote('qf', syd, ap('DFW', 'US'), 'J-F', 8580);
  assert.deepEqual(miles(far), [[110400, 81700, 73600, 65400]]);
  assert.deepEqual(miles(quote('qf', ap('PER', 'AU'), ap('LHR', 'GB'), 'J-F', 9010)), [[110400, 81700, 73600, 65400]]);
  assert.equal(quote('qf', syd, ap('JFK', 'US'), 'J-F', 9950).charts[0].zone, '航段距離 9,601 哩以上');
  // ANA still says which side of Japan the trip starts on.
  assert.equal(quote('ana', TPE, ap('NRT', 'JP'), 'Y-J', 1330).charts[0].fromJapan, false);
});

test('upgrade quotes: Lufthansa group (Miles & More) by booking class', () => {
  const fra = ap('FRA', 'DE');
  assert.deepEqual(miles(quote('lh', fra, TPE, 'Y-J')), [[50000, 65000, 85000]]);
  assert.deepEqual(miles(quote('lh', TPE, fra, 'W-J')), [[30000, 35000, 50000]]);
  assert.deepEqual(miles(quote('lh', fra, TPE, 'J-F')), [[65000, 85000]]);
  assert.deepEqual(miles(quote('lh', fra, ap('JFK', 'US'), 'Y-W')), [[20000, 30000, 45000]]);
  // Within one region: Europe (Turkey counts) has K/L/T, the Far East doesn't.
  assert.deepEqual(miles(quote('lh', ap('IST', 'TR'), ap('MUC', 'DE'), 'Y-J')), [[10000, 15000, 20000]]);
  assert.deepEqual(miles(quote('lh', TPE, ap('NRT', 'JP'), 'Y-J')), [[10000, 15000, null]]);
  // Partner rows: South-East Asia–Far East, North America–Far East.
  assert.deepEqual(miles(quote('lh', ap('BKK', 'TH'), TPE, 'Y-J')), [[30000, 45000, null]]);
  assert.deepEqual(miles(quote('lh', TPE, ap('SFO', 'US'), 'Y-J')), [[40000, 55000, null]]);
  assert.deepEqual(miles(quote('lh', TPE, ap('SFO', 'US'), 'J-F')), [[55000, null]]);
  // The Canary Islands count as Africa, Hawaii is its own region.
  assert.deepEqual(miles(quote('lh', ap('LPA', 'ES'), fra, 'Y-J')), [[30000, 35000, 45000]]);
  assert.deepEqual(miles(quote('lh', ap('HNL', 'US'), ap('LAX', 'US'), 'Y-J')), [[10000, 15000, null]]);
  assert.deepEqual(upgradePairsOf('lh'), ['Y-W', 'Y-J', 'W-J', 'J-F']);
});

test('upgrade quotes: Turkish Airlines from Türkiye to each region', () => {
  const ist = ap('IST', 'TR');
  const tpe = quote('tk', TPE, ist, 'Y-J');
  assert.deepEqual(miles(tpe), [[90000, 65000]]);
  assert.deepEqual(fareLabels(tpe), [['經濟艙 EcoFly', '其他經濟艙方案']]);
  assert.deepEqual(miles(quote('tk', ist, ap('LHR', 'GB'), 'Y-J')), [[27500, 25000]]);
  assert.deepEqual(miles(quote('tk', ap('ATH', 'GR'), ist, 'Y-J')), [[22000, 20000]]);
  assert.deepEqual(miles(quote('tk', ap('ESB', 'TR'), ist, 'Y-J')), [[12000, 10000]]);
  assert.deepEqual(miles(quote('tk', ist, ap('SYD', 'AU'), 'Y-J')), [[110000, 100000]]);
  assert.deepEqual(miles(quote('tk', ist, ap('ECN', 'CY'), 'Y-J')), [[22000, 20000]]);
  assert.equal(quote('tk', TPE, ap('LHR', 'GB'), 'Y-J').charts.length, 0);
  assert.deepEqual(upgradePairsOf('tk'), ['Y-J']);
});
