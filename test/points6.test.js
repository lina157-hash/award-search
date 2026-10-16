// Round 6 點數與錢包 (public/points6.js and the server parts): last safe transfer day and 登記 reminders (N4c/d), new
// promo notices (N4a, lib/promowatch.js), promo history (N4b), family pooling (N17), the wallet's value (N19), the
// redemption ledger (N22), what expiring miles can still buy in the reminder mail (N23), expired transfer rates (U10)
// and the synced keys' cleaning and merging.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
delete process.env.SEATS_AERO_API_KEY;
delete process.env.CASH_PASSCODE;
delete process.env.CRON_SECRET;
delete process.env.RESEND_API_KEY;
const logs = [];
const origLog = console.log;
console.log = (...a) => { logs.push(a.join(' ')); };
const { server } = require('../server');
const P6 = require('../public/points6.js');
const { createExpiry, cleanWallet, mailHtml } = require('../lib/expiry');
const { createPromoWatch } = require('../lib/promowatch');
const { memoryKv } = require('../lib/kv');

const read = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', f), 'utf8'));
const PROMOS = read('promos.json').promos;
const SOURCES = read('points.json').calc.sources;
const HOLDS = read('holds.json');
const PROGRAMS = read('programs.json').programs;
const src = (id) => SOURCES.find((s) => s.id === id);
const CX = PROMOS.find((p) => p.id === 'cx-80th-card-conversion-tw-202610');
const at = (iso) => () => Date.parse(`${iso}T02:00:00Z`); // 10:00 in Taiwan

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => { console.log = origLog; server.close(); });
async function call(p, { method = 'GET', body } = {}) {
  const res = await fetch(base + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json };
}

// ---------- N4c: last safe transfer day ----------
test('safeTransferDate: crediting deadline minus the slowest transfer time, never after the last day', () => {
  const promo = { end: '2026-10-31', creditBy: '2026-11-30' };
  assert.deepEqual(P6.safeTransferDate(promo, { days: [42, 56] }), { date: '2026-10-05', slow: 56, known: true, byEnd: false });
  assert.deepEqual(P6.safeTransferDate(promo, { days: [14, 21] }), { date: '2026-10-31', slow: 21, known: true, byEnd: false }, 'capped at the end');
  assert.equal(P6.safeTransferDate(promo, { instant: true, days: [0, 0] }).date, '2026-10-31');
  assert.deepEqual(P6.safeTransferDate(promo, null), { date: null, slow: null, known: false }, 'unknown transfer time: no date');
  assert.deepEqual(P6.safeTransferDate({ end: '2026-10-31', creditBy: null }, { days: [7, 21] }), { date: '2026-10-31', slow: 21, known: true, byEnd: true }, 'no creditBy: by the last day');
  assert.equal(P6.safeTransferDate({}, null).date, null);
});

test('promoDeadlines: the CX promo for each bank that can join, from holds.json, soonest first', () => {
  assert.equal(CX.creditBy, '2026-11-30');
  const rows = P6.promoDeadlines(CX, ['scb-bonus', 'hncb-bonus', 'ctbc-bonus', 'cathay-tree', 'taishin-point'].map(src), HOLDS, '2026-10-16');
  const by = Object.fromEntries(rows.map((r) => [r.source.id, r]));
  assert.ok(!by['cathay-tree'], '國泰世華 is excluded from this promo');
  assert.equal(by['scb-bonus'].date, '2026-10-05');
  assert.equal(by['scb-bonus'].days, -11, 'already too late');
  assert.equal(by['hncb-bonus'].date, '2026-10-19');
  assert.equal(by['hncb-bonus'].days, 3);
  assert.equal(by['ctbc-bonus'].date, '2026-10-31');
  assert.equal(by['taishin-point'].date, '2026-10-31');
  assert.deepEqual(rows.map((r) => r.date), [...rows.map((r) => r.date)].sort());
  assert.deepEqual(P6.promoDeadlines(CX, [src('ctbc-bonus')], HOLDS, '2026-11-01'), [], 'ended');
  assert.deepEqual(P6.promoDeadlines(PROMOS.find((p) => p.type === 'buy'), SOURCES, HOLDS, '2026-10-16'), [], 'buy-miles sales have no transfer');
});

test('regReminders: one per promo to register, dated on the earliest safe day still ahead, gone once ticked', () => {
  const opts = { promos: PROMOS, sources: SOURCES, holds: HOLDS };
  const items = P6.regReminders({ banks: { 'hncb-bonus': 50000, 'ctbc-bonus': 1 }, reg: {} }, '2026-10-16', opts);
  assert.equal(items.length, 1);
  assert.deepEqual({ ...items[0], url: Boolean(items[0].url) }, { key: `reg:${CX.id}`, kind: 'reg', name: CX.title, date: '2026-10-19', days: 3, banks: ['華南'], url: true });
  assert.deepEqual(P6.regReminders({ banks: ['hncb-bonus'], reg: { [CX.id]: true } }, '2026-10-16', opts), [], 'ticked 已登記');
  assert.deepEqual(P6.regReminders({ banks: ['scb-bonus'] }, '2026-10-16', opts), [], 'every safe day already past');
  assert.deepEqual(P6.regReminders({ banks: ['hncb-bonus'] }, '2026-10-20', opts), [], '華南 safe day passed');
  assert.deepEqual(P6.regReminders({ banks: ['hncb-bonus', 'ctbc-bonus'] }, '2026-10-20', opts).map((x) => [x.date, x.banks.join()]), [['2026-10-31', '中國信託']], 'the next bank still in time');
});

test('newPromos / promoTouches: running promos that touch the wallet and were not announced', () => {
  const mine = [src('ctbc-bonus')];
  const fresh = P6.newPromos(PROMOS, mine, ['emirates'], [], '2026-10-16').map((p) => p.id).sort();
  assert.deepEqual(fresh, ['cx-80th-card-conversion-tw-202610', 'emirates-buy-miles-202610']);
  assert.deepEqual(P6.newPromos(PROMOS, mine, ['emirates'], fresh, '2026-10-16'), [], 'seen');
  assert.ok(!P6.promoTouches(CX, [src('cathay-tree')], [], '2026-10-16'), 'excluded bank');
  assert.ok(P6.promoTouches(PROMOS.find((p) => p.id === 'cub-cube-asiamiles-autumn-202610'), [src('cathay-tree')], [], '2026-10-16'));
});

// ---------- N4b: history ----------
test('promoHistoryStats: ended transfer bonuses for this bank and column in the last 12 months', () => {
  const list = [
    { id: 'a', type: 'transfer', bank: '台新', program: 'asiamiles', bonusPct: 10, end: '2026-08-31' },
    { id: 'a', type: 'transfer', bank: '台新', program: 'asiamiles', bonusPct: 10, end: '2026-08-31' }, // same id in both files
    { id: 'b', type: 'transfer', bank: null, program: 'asiamiles', bonusPer: [10000, 1500], end: '2026-03-31' },
    { id: 'c', type: 'transfer', bank: '台新', program: 'asiamiles', bonusPct: 50, end: '2025-09-01' }, // over a year ago
    { id: 'd', type: 'transfer', bank: null, excludeBanks: ['台新'], program: 'asiamiles', bonusPct: 40, end: '2026-05-01' },
    { id: 'e', type: 'buy', bank: null, program: 'asiamiles', bonusPct: 100, end: '2026-06-01' },
    { id: 'f', type: 'transfer', bank: '台新', program: 'eva', bonusPct: 20, end: '2026-06-01' },
    { id: 'g', type: 'transfer', bank: '台新', program: 'asiamiles', bonusPct: 99, end: '2026-12-31' }, // still running
  ];
  assert.deepEqual(P6.promoHistoryStats(list, { bank: '台新' }, 'asiamiles', '2026-10-16'), { count: 2, maxPct: 15, last: '2026-08-31' });
  assert.deepEqual(P6.promoHistoryStats(list, { bank: '台新' }, 'sq', '2026-10-16'), { count: 0, maxPct: 0, last: null });
  // Once the CX promo ends it counts for every bank but 國泰世華.
  assert.equal(P6.promoHistoryStats(PROMOS, { bank: '中國信託' }, 'asiamiles', '2026-11-05').count, 1);
  assert.equal(P6.promoHistoryStats(PROMOS, { bank: '國泰世華' }, 'asiamiles', '2026-11-05').count, 1, 'its own CUBE promo only');
});

test('promos-history.json: only ended, official promos, ids not repeated in promos.json', () => {
  const h = read('promos-history.json');
  assert.ok(Array.isArray(h.promos) && h.promos.length >= 1);
  const live = new Set(PROMOS.map((p) => p.id));
  for (const p of h.promos) {
    assert.ok(p.end < h.updated, `${p.id} ended`);
    assert.ok(['transfer', 'buy'].includes(p.type), p.id);
    assert.ok(p.sources?.some((s) => s.official && /^https:\/\//.test(s.url)), `${p.id} official source`);
    assert.ok(!live.has(p.id), `${p.id} moved, not copied`);
  }
});

test('promos.json: registration, registerBy and creditBy fields are well formed', () => {
  for (const p of PROMOS) {
    assert.ok([true, false, null, undefined].includes(p.registration), p.id);
    if (p.creditBy != null) assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(p.creditBy) && p.creditBy >= p.end, `${p.id} creditBy`);
    if (p.registerBy != null) assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(p.registerBy) && p.registerBy <= p.end, `${p.id} registerBy`);
  }
});

// ---------- U10: expired rates ----------
test('p6RateExpired / p6RateInto: 台新 rates after 10/31 are left out; a rate date beats the bank date', () => {
  const ts = src('taishin-point');
  const r = ts.rates.find((x) => x.to === 'asiamiles');
  assert.equal(P6.p6RateExpired(ts, r, '2026-10-31'), false);
  assert.equal(P6.p6RateExpired(ts, r, '2026-11-01'), true);
  assert.ok(P6.p6RateInto(ts, 'asiamiles', '2026-10-31'));
  assert.equal(P6.p6RateInto(ts, 'asiamiles', '2026-11-01'), null);
  const fb = src('firstbank-bonus');
  assert.equal(P6.p6RateExpired(fb, fb.rates.find((x) => x.to === 'asiamiles'), '2027-03-01'), true);
  assert.equal(P6.p6RateExpired(fb, fb.rates.find((x) => x.to === 'eva'), '2027-03-01'), false, 'no date on the bank or rate');
  assert.ok(!P6.promoTouches({ type: 'transfer', bank: '台新', program: 'asiamiles' }, [ts], [], '2026-11-01'), 'no notice through an expired rate');
});

test('features.js transferRates skips expired rates; the calculator never picks one as best', () => {
  const feat = fs.readFileSync(path.join(__dirname, '..', 'public', 'features.js'), 'utf8');
  const fn = feat.match(/function transferRates\(program\) \{[\s\S]*?\n\}/)[0];
  const map = feat.match(/const PROGRAM_TRANSFER = (\{[\s\S]*?\n\});/)[1];
  const run = (today) => vm.runInNewContext(`const PROGRAM_TRANSFER = ${map}; const programKeyOf = (k) => k; ${fn}; transferRates('asiamiles').map((x) => x.source.id)`, {
    data: { points: read('points.json') }, calcRateExpired: (s, r) => P6.p6RateExpired(s, r, today),
  });
  assert.ok(run('2026-10-16').includes('taishin-point'));
  assert.ok(!run('2026-11-01').includes('taishin-point'));
  assert.ok(!run('2027-03-01').includes('firstbank-bonus'));
  // P6_TRANSFER stays the same as PROGRAM_TRANSFER, plus 全日空.
  const { ana, ...rest } = P6.P6_TRANSFER;
  assert.deepEqual(JSON.parse(JSON.stringify(rest)), JSON.parse(JSON.stringify(vm.runInNewContext(`(${map})`))));
  assert.deepEqual(ana, { name: '全日空' });
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(app, /if \(r\.to === 'other' \|\| expired\(s, r\)\) continue;/, 'best skips expired rates');
  assert.match(app, /if \(expired\(s, r\)\) continue;/, 'row summary skips expired rates');
});

// ---------- N17: family pooling ----------
test('poolRule: only an official pool or transfer rule adds balances up', () => {
  const rule = (id) => P6.poolRule(PROGRAMS.find((p) => p.id === id));
  assert.deepEqual(rule('british'), { type: 'pool', max: 7, min: 0, step: 0, official: true, combine: true });
  assert.equal(rule('dynastyflyer').combine, true);
  assert.equal(rule('flyingblue').combine, false, 'pool but not from an official page yet: 待確認');
  assert.equal(rule('asiamiles').combine, false, 'nominees only: each pays with their own miles');
  assert.equal(P6.poolRule(null).type, null);
  for (const p of PROGRAMS) {
    assert.ok([undefined, null, 'pool', 'transfer', 'nominee', 'none'].includes(p.poolType), p.id);
    if (p.poolOfficial) assert.ok(p.sources?.some((s) => s.official), `${p.id} official source`);
  }
});

test('householdPool: pooled, transferred with a minimum and unit, or person by person', () => {
  const people = [{ name: '我', miles: 30000 }, { name: '太太', miles: 20000 }, { name: '兒子', miles: 5000 }, { name: '空', miles: 0 }];
  const pool = P6.householdPool(people, { type: 'pool', max: 7, combine: true });
  assert.equal(pool.total, 55000);
  assert.equal(pool.usable, 55000);
  assert.equal(pool.seats(27000), 2);
  assert.equal(pool.people.length, 3, 'zero balances left out');
  const small = P6.householdPool(people, { type: 'pool', max: 2, combine: true });
  assert.equal(small.usable, 50000, 'the two biggest join');
  assert.deepEqual(small.left.map((p) => p.name), ['兒子']);
  assert.equal(small.seats(25000), 2);
  assert.equal(small.seats(5000), 11, '10 from the pool + 1 on its own');
  const ci = P6.householdPool([{ miles: 50000 }, { miles: 12500 }, { miles: 8000 }], { type: 'transfer', min: 10000, step: 1000, combine: true });
  assert.equal(ci.usable, 62000, '12,000 moves in steps of 1,000; 8,000 is under the minimum');
  assert.equal(ci.seats(31000), 2);
  const apart = P6.householdPool(people, { type: 'pool', combine: false });
  assert.equal(apart.usable, 30000);
  assert.equal(apart.seats(15000), 3, '2 + 1 + 0, nobody adds up');
  assert.equal(apart.seats(0), 0);
});

// ---------- N19: value ----------
test('walletValue: miles, bank points through their best transfer, hotel points; no value listed apart', () => {
  const v = P6.walletValue({ miles: { eva: 10000 }, banks: { a: 1000, b: 5 }, hotels: { marriott: 10000, x: 1 } }, {
    perMile: (k) => ({ eva: 0.5, asiamiles: 0.6 }[k] || 0.4), bankMiles: (id, n) => (id === 'a' ? { program: 'asiamiles', miles: n * 2 } : null), hotelTwd: (k) => (k === 'marriott' ? 0.25 : 0),
  });
  assert.deepEqual(v, { air: 5000, bank: 1200, hotel: 2500, total: 8700, skipped: ['b', 'x'] });
});

// ---------- N22: ledger ----------
test('ledgerFromLeg and ledgerSummary: per year, taxes in NT$, actual value per mile against the cost', () => {
  const leg = { date: '2026-12-01', from: 'TPE', to: 'NRT', flights: 'BR198', cabin: 'J', program: 'eva', miles: 50000, pax: 2, tax: { amount: 1500, cur: 'TWD' } };
  const seen = { 'TPE-NRT|2026-12-01|J': { price: 30000 } };
  const e1 = P6.ledgerFromLeg(leg, '2026-10-16', seen);
  assert.deepEqual(e1, { id: '2026-12-01|TPE|NRT|BR198|eva|J', at: '2026-10-16', date: '2026-12-01', from: 'TPE', to: 'NRT', flights: 'BR198', cabin: 'J', pax: 2, program: 'eva', miles: 100000, tax: { amount: 3000, cur: 'TWD' }, cash: 60000 });
  assert.equal(P6.ledgerFromLeg({ ...leg, program: 'asiamiles_est' }, '2026-10-16', {}).cash, null, 'no cash fare seen: none looked up');
  assert.equal(P6.ledgerFromLeg({ ...leg, program: 'asiamiles_est' }, '2026-10-16').program, 'asiamiles');
  const e2 = { id: 'b', at: '2026-05-01', program: 'asiamiles', miles: 20000, tax: { amount: 100, cur: 'USD' }, cash: 15200 };
  const e3 = { id: 'c', at: '2026-06-01', program: 'asiamiles', miles: 10000, tax: { amount: 5000, cur: 'JPY' }, cash: 9000 };
  const e4 = { id: 'd', at: '2025-12-30', program: 'eva', miles: 30000, tax: null, cash: null };
  const sum = P6.ledgerSummary([e1, e2, e3, e4, { id: 'z', at: 'bad', miles: 1 }], { rates: { USD: 32 }, perMile: (k) => (k === 'eva' ? 0.5 : 0.4) });
  assert.deepEqual(sum.map((s) => s.year), ['2026', '2025']);
  const y = sum[0];
  assert.equal(y.count, 3);
  assert.equal(y.miles, 130000);
  assert.deepEqual(y.byProgram, { eva: 100000, asiamiles: 30000 });
  assert.equal(y.tax, 6200, '3,000 + US$100 × 32');
  assert.equal(y.taxUnknown, 1, 'yen without a rate');
  assert.equal(y.cash, 75200);
  assert.equal(y.cashMiles, 120000);
  assert.equal(y.perMile, Math.round(((60000 - 3000 + 15200 - 3200) / 120000) * 100) / 100);
  assert.equal(y.costPerMile, Math.round(((100000 * 0.5 + 20000 * 0.4) / 120000) * 100) / 100);
  assert.deepEqual({ perMile: sum[1].perMile, costPerMile: sum[1].costPerMile }, { perMile: null, costPerMile: 0.5 }, 'no cash fare: cost of all its miles');
});

// ---------- synced keys ----------
test('cleaners keep only well-formed records', () => {
  assert.deepEqual(P6.cleanVouchers([{ id: 'a1', kind: 'nope', name: '  長榮升等券 ', count: 2.7, expires: '2027-01-31' }, { id: 'bad id', kind: 'stay' }, null, { id: 'b', kind: 'lounge', count: -1, expires: 'soon' }]), [
    { id: 'a1', kind: 'other', name: '長榮升等券', count: 2, expires: '2027-01-31' }, { id: 'b', kind: 'lounge', name: '', count: null, expires: null },
  ]);
  assert.deepEqual(P6.cleanFamily({ members: [{ id: 'm1', name: '', miles: { eva: '5000', x: -1, 'bad key': 3 }, banks: { 'ctbc-bonus': 100 } }, { id: '!!' }] }), { members: [{ id: 'm1', name: '家人', miles: { eva: 5000 }, banks: { 'ctbc-bonus': 100 } }] });
  assert.deepEqual(P6.cleanReg({ ok: true, no: false, 'bad id!': true }), { ok: true });
  assert.equal(P6.cleanLedger([{ id: 'x', at: '2026-10-16', from: 'TPE', to: 'tyo', miles: 1 }, { id: 'y', at: '2026-10-16', from: 'TPE', to: 'NRT', miles: 5, cabin: 'Q', pax: 30 }]).map((e) => `${e.id}${e.cabin}${e.pax}`).join(), 'yY9');
  const tips = P6.cleanTips({ eva: { awards: [1, 2, 3, 4].map((i) => ({ to: 'NRT', toName: '東京', cabin: 'Y', miles: i * 1000 })) }, ci: { awards: [{ to: 'x', cabin: 'Y', miles: 1 }] } });
  assert.deepEqual(Object.keys(tips), ['eva']);
  assert.equal(tips.eva.awards.length, 3);
});

test('merges: removed on either side stays removed, the changed side wins, first sync keeps both', () => {
  const B = [{ id: 'a', n: 1 }, { id: 'b', n: 1 }];
  const L = [{ id: 'a', n: 2 }]; // edited a, removed b
  const R = [{ id: 'a', n: 1 }, { id: 'b', n: 1 }, { id: 'c', n: 1 }]; // added c
  assert.deepEqual(P6.p6MergeList(L, R, B, true), [{ id: 'a', n: 2 }, { id: 'c', n: 1 }]);
  assert.deepEqual(P6.p6MergeList([{ id: 'a', n: 9 }, { id: 'd' }], [{ id: 'a', n: 1 }], null, false), [{ id: 'a', n: 1 }, { id: 'd' }], 'no base: the account wins, the device adds');
  assert.deepEqual(P6.p6MergeMap({}, { x: true, y: true }, { x: true }, true), { y: true }, 'unticked here, ticked there');
  assert.deepEqual(P6.p6MergeMap({ z: true }, { x: true }, null, false), { z: true, x: true });
  assert.deepEqual(P6.P6_MERGE['walletFamily:v1']({ members: L }, { members: R }, { members: B }, true).members.map((m) => m.id), ['a', 'c']);
  const acct = fs.readFileSync(path.join(__dirname, '..', 'public', 'account.js'), 'utf8');
  assert.match(acct, /\.\.\.\(typeof P6_SYNC_KEYS !== 'undefined' \? P6_SYNC_KEYS : \[\]\)/);
  assert.deepEqual(P6.P6_SYNC_KEYS, ['walletFamily:v1', 'walletVouchers:v1', 'promoReg:v1', 'awardLedger:v1', 'expiryTips:v1']);
});

// ---------- N23 + N19 + N4d: the reminder mail ----------
test('expiry reminders: voucher dates, 登記 3 days ahead, and what expiring miles can buy with the official ways', async () => {
  const kv = memoryKv();
  const mails = [];
  const chats = [];
  const today = '2026-10-16';
  const ex = createExpiry({
    kv, rules: read('expiry.json').programs, now: at(today), siteUrl: 'https://example.test',
    sendEmail: async (m) => { mails.push(m); }, notify: async (h) => { chats.push(h); return true; },
    ways: { ci: ['有活動也不會延長，36 個月固定到期'] }, regItems: (w, d) => P6.regReminders(w, d, { promos: PROMOS, sources: SOURCES, holds: HOLDS }),
  });
  const wallet = {
    banks: { 'hncb-bonus': 50000 }, miles: { ci: 30000 }, expiry: { ci: '2026-10-22' },
    vouchers: [{ id: 'v1', kind: 'upgrade', name: '長榮升等券', count: 2, expires: '2026-11-10' }, { id: 'v2', kind: 'lounge', count: 3 }],
    reg: {}, tips: { ci: { awards: [{ to: 'HKG', toName: '香港', cabin: 'Y', miles: 10000 }] } },
  };
  const c = cleanWallet(wallet);
  assert.deepEqual(c.banks, ['hncb-bonus']);
  assert.equal(c.vouchers.length, 2);
  assert.deepEqual(await ex.saveOwner({ email: 'me@example.com', wallet }), { ok: true, count: 2, email: 'me@example.com' }, 'one miles date + one dated voucher');
  const r = await ex.run();
  assert.equal(r.reminded, 1);
  assert.equal(mails.length, 1);
  const html = mails[0].html;
  assert.match(mails[0].subject, /哩程快到期：華航 華夏哩程/);
  assert.match(html, /台北 → 香港 經濟艙單程 10,000 哩/);
  assert.match(html, /查座位<\/a>（用 1 次查詢）/);
  assert.match(html, /o=TPE&amp;d=HKG&amp;s=2026-10-17&amp;e=2026-11-15&amp;c=Y/);
  assert.match(html, /官方的延長方式：有活動也不會延長/);
  assert.match(html, /長榮升等券.*剩 2.*2026-11-10/);
  assert.match(html, /要先登記.*華南 最晚 10\/19 要轉出（還剩 3 天）/);
  assert.match(chats[0], /轉點加贈|華南/);
  assert.equal((await ex.run()).reminded, 0, 'each step once');
  // Ticked 已登記: no 登記 reminder; a wallet with only bank points is still kept for them.
  const ex2 = createExpiry({ kv: memoryKv(), rules: {}, now: at(today), sendEmail: async (m) => { mails.push(m); }, regItems: (w, d) => P6.regReminders(w, d, { promos: PROMOS, sources: SOURCES, holds: HOLDS }) });
  assert.equal((await ex2.saveOwner({ email: 'me@example.com', wallet: { banks: { 'hncb-bonus': 1 }, reg: { [CX.id]: true } } })).ok, true);
  const before = mails.length;
  assert.equal((await ex2.run()).reminded, 0);
  assert.equal(mails.length, before);
  // Escaping in the mail.
  assert.doesNotMatch(mailHtml([{ key: 'v:x', kind: 'voucher', name: '<b>x</b>', date: '2026-11-01', days: 3 }], ''), /<b>x<\/b>/);
});

// ---------- N4a: new promo notices ----------
test('promo watch: what runs when switched on counts as seen; a new promo is sent once; no channel retries', async () => {
  const kv = memoryKv();
  const promos = PROMOS.map((p) => ({ ...p }));
  const sent = [];
  let tg = true;
  const w = createPromoWatch({ kv, promos, sources: SOURCES, holds: HOLDS, notify: async (h) => { sent.push(h); return tg; }, now: at('2026-10-16'), siteUrl: 'https://example.test' });
  assert.deepEqual(await w.status(), { on: false });
  assert.deepEqual(await w.run(), { on: false });
  await assert.rejects(w.save({ on: true, email: 'nope' }), /Email/);
  const s = await w.save({ on: true, banks: ['ctbc-bonus', 'bad id!'], programs: ['emirates'] });
  assert.deepEqual(s, { ok: true, on: true, email: '', current: 2 });
  assert.deepEqual(await w.run(), { on: true, fresh: 0 });
  promos.push({ id: 'ctbc-test-202610', type: 'transfer', bank: '中國信託', program: 'asiamiles', title: '中信測試加贈', bonusPct: 10, start: '2026-10-15', end: '2026-11-15', creditBy: '2026-11-30', registration: true });
  promos.push({ id: 'other-bank-202610', type: 'transfer', bank: '玉山', program: 'eva', title: '玉山加贈', bonusPct: 10, start: '2026-10-15', end: '2026-11-15' });
  tg = null; // Telegram not linked, no mail address
  const nc = await w.run();
  assert.equal(nc.noChannel, true);
  assert.equal(nc.error, undefined);
  tg = false;
  assert.equal((await w.run()).error, 'Telegram 傳送失敗');
  tg = true;
  const ok = await w.run();
  assert.deepEqual({ fresh: ok.fresh, telegram: ok.telegram }, { fresh: 1, telegram: true });
  assert.match(sent.at(-1), /中信測試加贈 \+10%，到 11\/15・要先登記・你的 中國信託（最晚 11\/9 轉）/);
  assert.doesNotMatch(sent.at(-1), /玉山/);
  assert.deepEqual(await w.run(), { on: true, fresh: 0 }, 'sent once');
  assert.equal((await w.status()).seen, 3);
  assert.deepEqual(await w.save({ on: false }), { ok: true, on: false });
  assert.deepEqual(await w.status(), { on: false });
});

test('/api/promo-watch and the daily run part', async () => {
  const on = await call('/api/promo-watch', { method: 'POST', body: { on: true, email: 'owner@example.com', banks: ['ctbc-bonus'], programs: ['eva'] } });
  assert.equal(on.status, 200);
  assert.equal(on.json.on, true);
  assert.equal((await call('/api/promo-watch')).json.on, true);
  assert.equal((await call('/api/promo-watch', { method: 'POST', body: { on: true, email: 'bad' } })).status, 400);
  const run = await call('/api/alerts/run?part=promos');
  assert.equal(run.status, 200);
  assert.ok(run.json.promos && !run.json.promos.error, JSON.stringify(run.json.promos));
  assert.equal((await call('/api/promo-watch', { method: 'POST', body: { on: false } })).json.on, false);
  assert.equal((await call('/api/promo-watch', { method: 'DELETE' })).status, 405);
});

test('expiryWays in programs.json come with an official source; promohistory ships in the more bundle', () => {
  for (const p of PROGRAMS.filter((x) => x.expiryWays)) {
    assert.ok(p.expiryWays.length && p.expiryWays.every((s) => typeof s === 'string' && s.length < 120), p.id);
    assert.ok(p.sources?.some((s) => s.official), `${p.id} official source`);
  }
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(app, /const DATA_MORE = \[[^\]]*'promohistory'/);
  assert.match(app, /const DATA_OPTIONAL = \[[^\]]*'promohistory'/);
});
