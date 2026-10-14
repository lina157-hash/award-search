// 我的點數 extras: miles expiry rules and reminders (lib/expiry.js, the daily run, account sync), and the browser-side
// helpers in public/ewallet.js (transfer plan for a target, buy-miles price, dated-rule countdowns).
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
const { createExpiry, addMonths, expiryOf, walletExpiries, dueReminders, cleanWallet } = require('../lib/expiry');
const { memoryKv } = require('../lib/kv');
const { todayTW, addDays } = require('../lib/day');
const RULES = require('../data/expiry.json').programs;

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => { console.log = origLog; server.close(); });

test('expiry.json: every rule has a known kind, months where needed, and points at a programs.json card', () => {
  const ids = new Set(require('../data/programs.json').programs.map((p) => p.id));
  for (const [k, r] of Object.entries(RULES)) {
    assert.ok(['fixed', 'activity', 'none'].includes(r.kind), k);
    if (r.kind === 'activity') assert.ok(r.months > 0, `${k} months`);
    assert.ok(ids.has(r.programId), `${k} → ${r.programId}`);
    assert.ok(r.name && r.rule, k);
  }
  for (const k of ['eva', 'ci', 'jal', 'ana', 'singapore']) assert.equal(RULES[k].kind, 'fixed', k);
  for (const k of ['asiamiles', 'aeroplan', 'qantas']) assert.deepEqual([RULES[k].kind, RULES[k].months], ['activity', 18], k);
});

test('addMonths clamps to the end of a shorter month; activity programs count from the last activity', () => {
  assert.equal(addMonths('2025-01-31', 1), '2025-02-28');
  assert.equal(addMonths('2024-08-31', 18), '2026-02-28');
  assert.equal(addMonths('2025-06-01', 18), '2026-12-01');
  assert.equal(addMonths('2026-11-15', 2), '2027-01-15');
  assert.equal(expiryOf(RULES.asiamiles, '2025-06-01'), '2026-12-01');
  assert.equal(expiryOf(RULES.eva, '2026-12-31'), '2026-12-31', 'fixed: the date entered is the expiry');
  assert.equal(expiryOf(RULES.united, '2026-12-31'), null, 'never expires');
  assert.equal(expiryOf(undefined, '2027-01-01'), '2027-01-01', 'unknown program: the date as entered');
  assert.equal(expiryOf(RULES.eva, '2026-02-30'), null);
});

test('walletExpiries lists dated balances soonest first; reminders go out once at 90, 30 and 7 days', () => {
  const today = '2026-10-14';
  const w = { miles: { eva: 12000, asiamiles: 8000, united: 3000 }, expiry: { eva: '2026-12-31', asiamiles: '2025-06-01', united: '2026-11-01', bad: 'x' } };
  const list = walletExpiries(w, RULES, today);
  assert.deepEqual(list.map((x) => [x.key, x.date, x.days, x.miles]), [['asiamiles', '2026-12-01', 48, 8000], ['eva', '2026-12-31', 78, 12000]]);
  // Both are inside 90 days: one reminder each, and not again the same day.
  let r = dueReminders(list, {});
  assert.deepEqual(r.due.map((d) => [d.key, d.step]), [['asiamiles', 90], ['eva', 90]]);
  assert.deepEqual(dueReminders(list, r.sent).due, []);
  // 20 days later Asia Miles is at 28 days: the 30-day one; at 7 days, the last one; never one at -1.
  const at = (d) => walletExpiries(w, RULES, d);
  r = dueReminders(at('2026-11-03'), r.sent);
  assert.deepEqual(r.due.map((d) => [d.key, d.step, d.days]), [['asiamiles', 30, 28]]);
  r = dueReminders(at('2026-11-26'), r.sent);
  assert.deepEqual(r.due.map((d) => [d.key, d.step]), [['asiamiles', 7]], 'EVA at 35 days already had its 90-day one');
  r = dueReminders(at('2026-12-02'), r.sent);
  assert.deepEqual(r.due.map((d) => [d.key, d.step]), [['eva', 30]], 'expired Asia Miles is skipped');
  // A new date for the same program is a new reminder cycle.
  const moved = dueReminders(walletExpiries({ ...w, expiry: { ...w.expiry, asiamiles: '2025-06-20' } }, RULES, today), r.sent);
  assert.ok(moved.due.some((d) => d.key === 'asiamiles'));
});

test('cleanWallet keeps only dated programs with valid dates', () => {
  assert.deepEqual(cleanWallet({ miles: { eva: 5000, ci: 100 }, banks: { x: 1 }, expiry: { eva: '2027-01-31', ci: '2027-13-01', 'bad key!': '2027-01-01' } }), { miles: { eva: 5000 }, expiry: { eva: '2027-01-31' } });
  assert.deepEqual(cleanWallet(null), { miles: {}, expiry: {} });
});

test('createExpiry: tracked accounts and the owner list are reminded once per step; empty wallets leave the list', async () => {
  const kv = memoryKv();
  const today = todayTW();
  const wallets = {
    'a@x.co': { miles: { eva: 10000 }, expiry: { eva: addDays(today, 25) } },
    'b@x.co': { miles: { jal: 20000 }, expiry: { jal: addDays(today, 400) } },
  };
  const mails = [];
  const chats = [];
  const ex = createExpiry({ kv, rules: RULES, loadWallet: async (e) => wallets[e] || null, sendEmail: async (m) => mails.push(m), notify: async (h) => { chats.push(h); return true; } });
  await ex.track('a@x.co', wallets['a@x.co']);
  await ex.track('b@x.co', wallets['b@x.co']);
  await ex.track('c@x.co', { miles: { eva: 1 } }); // no dates: not tracked
  assert.deepEqual(await kv.get('expiry:v1:emails'), ['a@x.co', 'b@x.co']);
  await assert.rejects(ex.saveOwner({ email: 'nope', wallet: {} }), /Email/);
  assert.deepEqual(await ex.saveOwner({ email: 'Me@X.co', wallet: { miles: { asiamiles: 9000 }, expiry: { asiamiles: addMonths(addDays(today, 5), -18) } } }), { ok: true, count: 1, email: 'me@x.co' });
  let r = await ex.run();
  assert.equal(r.reminded, 2);
  assert.deepEqual(mails.map((m) => m.to).sort(), ['a@x.co', 'me@x.co']);
  assert.match(mails.find((m) => m.to === 'a@x.co').subject, /哩程快到期：長榮 無限萬哩遊（還剩 25 天）/);
  assert.match(mails.find((m) => m.to === 'a@x.co').html, /10,000 哩/);
  assert.equal(chats.length, 1, 'Telegram only for the owner list');
  assert.match(chats[0], /國泰 亞洲萬里通 9,000 哩/);
  r = await ex.run();
  assert.equal(r.reminded, 0, 'nothing twice');
  assert.equal(mails.length, 2);
  // Dates cleared on the account: dropped from the list at the next run.
  wallets['b@x.co'] = { miles: { jal: 20000 } };
  await ex.run();
  assert.deepEqual(await kv.get('expiry:v1:emails'), ['a@x.co']);
  await ex.track('a@x.co', { miles: {} });
  assert.deepEqual(await kv.get('expiry:v1:emails'), []);
  assert.deepEqual(await ex.saveOwner({ email: '', wallet: {} }), { ok: true, count: 0 });
  assert.equal((await ex.getOwner()).count, 0);
});

test('server: a synced wallet with dates gets a reminder from the daily run; the owner list needs no account', async () => {
  let cookie = '';
  const call = async (p, { method = 'GET', body } = {}) => {
    const res = await fetch(base + p, { method, headers: { 'x-forwarded-for': '10.9.9.9', ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const email = 'expiry-test@example.com';
  assert.equal((await call('/api/account/signup', { method: 'POST', body: { email, password: 'correct horse' } })).status, 200);
  const line = [...logs].reverse().find((l) => l.includes(email) && l.includes('#verify='));
  if (line) assert.equal((await call('/api/account/verify', { method: 'POST', body: { token: line.match(/#verify=([\w-]+)/)[1] } })).status, 200);
  assert.equal((await call('/api/account/login', { method: 'POST', body: { email, password: 'correct horse' } })).status, 200);
  const wallet = { banks: {}, miles: { ci: 30000 }, hotels: {}, expiry: { ci: addDays(todayTW(), 6) } };
  assert.equal((await call('/api/account/data', { method: 'PUT', body: { data: { 'wallet:v1': wallet }, rev: 0 } })).status, 200);
  const run = await call('/api/alerts/run?part=expiry');
  assert.equal(run.status, 200);
  assert.ok(run.json.expiry.reminded >= 1, JSON.stringify(run.json.expiry));
  assert.ok(logs.some((l) => l.includes(email) && l.includes('哩程快到期：華航 華夏哩程（還剩 6 天）')), 'demo prints the mail');
  // Owner list (no passcode set here, like the seat alerts).
  const saved = await call('/api/expiry', { method: 'POST', body: { email: 'owner@example.com', wallet: { miles: { eva: 1000 }, expiry: { eva: addDays(todayTW(), 100) } } } });
  assert.deepEqual(saved.json, { ok: true, count: 1, email: 'owner@example.com' });
  assert.equal((await call('/api/expiry')).json.count, 1);
  assert.equal((await call('/api/expiry', { method: 'POST', body: { email: 'bad', wallet: {} } })).status, 400);
});

test('account sync merges expiry dates per program like balances', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'account.js'), 'utf8');
  assert.match(src, /for \(const bucket of \['banks', 'miles', 'hotels', 'expiry'\]\)/);
  const feat = fs.readFileSync(path.join(__dirname, '..', 'public', 'features.js'), 'utf8');
  assert.match(feat, /return \{ banks: pick\(w\.banks\), miles, hotels: pick\(w\.hotels\), expiry \};/);
});

// ---------- public/ewallet.js in a sandbox ----------
const read = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', f), 'utf8'));
function sandbox(today = '2026-10-14', bare = false) {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const calcConvert = app.match(/function calcConvert\(rate, amount, mode\) \{[\s\S]*?\n\}/)[0];
  const ctx = {
    data: bare ? {} : { points: read('points.json'), promos: read('promos.json'), alliances: read('alliances.json'), expiry: read('expiry.json'), buymiles: read('buymiles.json'), changes: read('changes.json') },
    fmt: (n) => Number(n).toLocaleString('en-US'),
    esc: (s) => String(s ?? ''),
    mmdd: (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`,
    isoDate: () => today,
    programKeyOf: (s) => s,
    programName: (k) => k,
    airlineZh: (c) => ({ OZ: '韓亞航空' }[c] || c),
  };
  vm.createContext(ctx);
  vm.runInContext(`${calcConvert}\n${fs.readFileSync(path.join(__dirname, '..', 'public', 'ewallet.js'), 'utf8')}\nthis.api = { planTransfers, ewPointsFor, parseBuyPrice, buyPriceFor, buyCost, untilTag, upcomingChanges, programChangeTag, expiryOfEntry, walletExpiryList, calcConvert };`, ctx);
  return ctx.api;
}

test('planTransfers: fewest points, minimums and units respected, each balance used once', () => {
  const { planTransfers, calcConvert } = sandbox();
  const conv = (rate) => (x) => calcConvert(rate, x, 'p2m').value || 0;
  // A: 1:1, min 3,000, 500 per unit. B: 2 points per mile, 1,000 per unit. C: 1:1, min 10,000.
  const A = { label: 'A', balance: 20000, fn: conv({ points: 1, miles: 1, minPoints: 3000, stepPoints: 500 }) };
  const B = { label: 'B', balance: 30000, fn: conv({ points: 2, miles: 1, stepPoints: 1000 }) };
  const C = { label: 'C', balance: 12000, fn: conv({ points: 1, miles: 1, minPoints: 10000 }) };
  let p = planTransfers(25000, [{ id: 'a', choices: [A] }, { id: 'b', choices: [B] }, { id: 'c', choices: [C] }]);
  assert.equal(p.ok, true);
  // A and C at 1:1 cover it with 25,000 points; B would cost twice as much.
  assert.equal(p.points, 25000);
  assert.deepEqual(p.steps.map((s) => s.label).sort(), ['A', 'C']);
  assert.ok(p.steps.every((s) => s.points <= s.balance));
  assert.ok(p.miles >= 25000);
  // A partial top-up below C's 10,000 minimum is not allowed: 21,000 = A 20,000 + C 10,000 (min) or A 11,000 + C 10,000.
  p = planTransfers(21000, [{ id: 'a', choices: [A] }, { id: 'c', choices: [C] }]);
  assert.equal(p.points, 21000);
  const c = p.steps.find((s) => s.label === 'C');
  assert.ok(!c || c.points >= 10000);
  // Units: 2,100 miles from A alone needs its 3,000 minimum.
  assert.equal(planTransfers(2100, [{ id: 'a', choices: [A] }]).points, 3000);
  // One balance, two ways in (direct or a worse detour): only one is used.
  const detour = { label: 'A', via: 'H', balance: 20000, fn: (x) => Math.floor(x / 2) };
  p = planTransfers(30000, [{ id: 'a', choices: [A, detour] }, { id: 'c', choices: [C] }]);
  assert.equal(p.ok, true);
  assert.equal(p.steps.filter((s) => s.label === 'A').length, 1);
  // Not enough: the most each balance can give.
  p = planTransfers(100000, [{ id: 'a', choices: [A, detour] }, { id: 'b', choices: [B] }]);
  assert.equal(p.ok, false);
  assert.equal(p.miles, 35000);
  assert.deepEqual(planTransfers(5000, []).ok, false);
  assert.deepEqual(planTransfers(0, []).ok, true);
});

test('buy price: a sale with a stated price first, else the usual price; cost per shortfall', () => {
  const { parseBuyPrice, buyPriceFor, buyCost } = sandbox('2026-10-14');
  assert.deepEqual({ ...parseBuyPrice('US$18.8/千哩') }, { currency: 'USD', perThousand: 18.8 });
  assert.equal(parseBuyPrice('最高加贈 100%'), null);
  const alaska = buyPriceFor('alaska');
  assert.equal(alaska.perThousand, 18.8);
  assert.equal(alaska.promo.id, 'alaska-atmos-buy-points-202610');
  assert.equal(buyCost('alaska', 12000).amount, 225.6);
  // After the sale ends, the usual price.
  assert.equal(sandbox('2026-11-01').buyPriceFor('alaska').perThousand, 37.6);
  // A sale without a price keeps the usual price and names the sale.
  const em = buyPriceFor('emirates');
  assert.equal(em.perThousand, 30);
  assert.equal(em.sale.id, 'emirates-buy-miles-202610');
  assert.equal(buyPriceFor('ci'), null, 'no price known');
  for (const [k, v] of Object.entries(read('buymiles.json').programs)) assert.ok(v.perThousand > 0 && /^[A-Z]{3}$/.test(v.currency), k);
});

test('countdowns: validUntil on a bank or its rates, promos ending soon, leaving alliance members, changes.json', () => {
  const { untilTag, upcomingChanges, programChangeTag } = sandbox('2026-10-14');
  assert.equal(untilTag({}), '');
  assert.equal(untilTag({ validUntil: 'soon' }), '', 'a malformed date is ignored');
  assert.match(untilTag({ validUntil: '2026-10-31' }), /還剩 17 天/);
  assert.match(untilTag({ rates: [{ validUntil: '2026-12-31' }, { validUntil: '2026-10-31' }] }), /還剩 17 天/);
  assert.match(untilTag({ validUntil: '2027-03-01' }), /到 2027\/3\/1/);
  assert.match(untilTag({ validUntil: '2026-10-01' }), /期限已過/);
  const list = upcomingChanges('2026-10-14');
  assert.ok(list.every((x, i) => i === 0 || list[i - 1].date <= x.date), 'sorted');
  assert.ok(list.some((x) => x.kind === 'alliance' && x.date === '2026-12-16' && /韓亞航空退出星空聯盟/.test(x.title)));
  assert.ok(list.some((x) => x.kind === 'change' && x.date === '2027-06-01'));
  assert.ok(list.filter((x) => x.kind === 'promo').every((x) => x.days <= 14));
  assert.ok(!list.some((x) => x.days < 0));
  assert.match(programChangeTag('emirates'), /2027\/6\/1 起有變更/);
  assert.equal(programChangeTag('eva'), '');
  // Missing files are fine.
  const bare = sandbox('2026-10-14', true);
  assert.deepEqual([...bare.upcomingChanges('2026-10-14')], []);
  assert.equal(bare.programChangeTag('emirates'), '');
  assert.equal(bare.buyPriceFor('alaska'), null);
});
