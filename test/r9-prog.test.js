// Round 9 (r9-prog): Avios moves in 我的點數, award sales, the weekly digest, gcmap links, chart before/after,
// status match and official cash sales. Browser scripts run in a vm sandbox with the real data files.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8'));
const src = (f) => fs.readFileSync(path.join(ROOT, 'public', f), 'utf8');

// The top of features.js (programs, transfer rates, promos, wallet, Avios, reach) with app.js's calcConvert.
function featSandbox({ today = '2026-10-16', promos = read('promos.json') } = {}) {
  const feat = src('features.js');
  const head = feat.slice(0, feat.indexOf('// ---------- booking channels'));
  const calcConvert = src('app.js').match(/function calcConvert\(rate, amount, mode\) \{[\s\S]*?\n\}/)[0];
  const ctx = {
    data: { points: read('points.json'), promos },
    SOURCE_NAMES: read('source-names.json').names,
    fmt: (n) => Number(n).toLocaleString('en-US'),
    esc: (s) => String(s ?? ''),
    isoDate: () => today,
    mmdd: (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`,
    store: { get: (k, d) => d },
    CONFIDENCE_TAG: {},
  };
  vm.createContext(ctx);
  vm.runInContext(`${calcConvert}\n${head}\nthis.api = { reach, reachFor, aviosPath, ratesInto, aviosMoves, aviosNeedHtml, aviosEarnHtml, setWallet: (w) => { wallet = w; } };`, ctx);
  return ctx.api;
}

// ---------- #7 Avios ----------
test('Avios links: Qatar only through BA, every link official with its source', () => {
  const av = read('points.json').calc.avios;
  assert.deepEqual(Object.keys(av.programs).sort(), ['aerlingus', 'british', 'finnair', 'iberia', 'qatar']);
  for (const l of av.links) {
    assert.ok(av.programs[l.a] && av.programs[l.b], `${l.a}-${l.b}`);
    assert.equal(l.confidence, 'official');
    assert.match(l.source.url, /^https:\/\/www\.(qatarairways|finnair|britishairways)\.com\//);
  }
  assert.deepEqual(av.links.filter((l) => [l.a, l.b].includes('qatar')).map((l) => [l.a, l.b]), [['british', 'qatar']]);
  const f = featSandbox();
  assert.deepEqual([...f.aviosPath('qatar', 'finnair')], ['qatar', 'british', 'finnair']);
  assert.deepEqual([...f.aviosPath('british', 'qatar')], ['british', 'qatar']);
  assert.equal(f.aviosPath('qatar', 'qatar'), null);
  assert.equal(f.aviosPath('eva', 'qatar'), null);
});

test('reach: BA Avios and 國泰世華 points count for Qatar and Finnair, marked as a move', () => {
  const f = featSandbox();
  f.setWallet({ banks: { 'cathay-tree': 45000 }, miles: { british: 20000 }, hotels: {} });
  // 國泰世華 450 points = 1,000 BA Avios beats its own 480 points = 1,000 Qatar Avios.
  const q = f.reach('qatar');
  assert.equal(q.own, 0);
  assert.equal(q.banks.length, 1);
  assert.equal(q.banks[0].miles, 100000);
  assert.deepEqual([...q.banks[0].path], ['british', 'qatar']);
  assert.deepEqual(q.moved.map((m) => [m.program, m.miles]), [['british', 20000]]);
  assert.equal(q.total, 120000);
  assert.equal(f.aviosMoves(q).length, 2);
  // Without the moves only the direct 480-point rate is left.
  const plain = f.reach('qatar', { avios: false });
  assert.equal(plain.total, 93000);
  assert.equal(plain.moved.length, 0);
  // Finnair takes no Taiwanese points directly: everything comes through BA.
  const fin = f.reach('finnair');
  assert.equal(fin.total, 120000);
  assert.ok(fin.banks.every((b) => b.path?.at(-1) === 'finnair'));
  assert.match(f.aviosNeedHtml(fin.banks[0].path), /^需先把 Avios 轉到芬航（1:1，<a href="https:\/\/www\.finnair\.com\//);
  // BA itself: the bank's direct rate, no move needed.
  const ba = f.reach('british');
  assert.equal(ba.own, 20000);
  assert.equal(ba.banks[0].path, null);
  assert.equal(f.aviosMoves(ba).length, 0);
  // Programs outside Avios are untouched.
  assert.equal(f.reach('eva').moved.length, 0);
});

test('reach: HSBC points (1:1 into Qatar only) reach BA through Qatar; a family member uses their own balances', () => {
  const f = featSandbox();
  f.setWallet({ banks: { 'hsbc-travel': 10000 }, miles: {}, hotels: {} });
  const ba = f.reach('british');
  assert.equal(ba.total, 10000);
  assert.deepEqual([...ba.banks[0].path], ['qatar', 'british']);
  const member = { miles: { qatar: 5000 }, banks: {} };
  assert.equal(f.reachFor(member, 'british').total, 5000);
  assert.equal(f.reachFor(member, 'british', { avios: false }).total, 0);
  assert.match(f.aviosEarnHtml('qatar'), /你可以用英航 Avios 轉過來（1:1）/);
  assert.match(f.aviosEarnHtml('finnair'), /卡達的 Avios 要先轉到英航再轉過來/);
  assert.match(f.aviosEarnHtml('british'), /卡達、芬航、西班牙國家航空、愛爾蘭航空的 Avios 都能 1:1 轉過來/);
});

test('detour: Avios-aware hotel partners and direct routes', () => {
  const feat = src('features.js');
  assert.match(feat, /function hotelPartner\(hotel, air\) \{[\s\S]*?isAvios\(air\)/);
  assert.match(feat, /function directRoute\(air, sourceId, amount\)/);
  // Accor sends Iberia 1:1 but Qatar only 4:3: the Qatar route goes through Iberia (official rates on both).
  const accor = read('points.json').calc.hotels.toAir.hotels.accor.partners;
  const ib = accor.find((p) => p.to === 'iberia');
  const qr = accor.find((p) => p.to === 'qatar');
  assert.ok(ib.miles / ib.hotelPoints > qr.miles / qr.hotelPoints);
  assert.equal(ib.confidence, 'official');
  // 繞路兌換 shows the chain, 我的點數 the need-to-move mark, the results note under 只看我換得起的.
  assert.match(feat, /aviosChainText\(d\.path, d\.source\.bank\)/);
  assert.match(feat, /class="avios-need"/);
  assert.match(src('app.js'), /state\.affordOnly && typeof aviosAffordHtml === 'function' \? aviosAffordHtml\(\) : ''/);
  assert.match(src('points6.js'), /const p6PersonReach = \(m, key\) => reachFor\(m, key\)\.total;/);
});
