// Review 6 (2026-10-16) fixes: history from cut deals pages (#1), price-watch readings in US dollars (#4), the shared
// lock's release (#5), the calendar's currency guess by cabin (#6), the deals background retry (#7), the unsubscribe
// page (#8), the one-sentence search count (#9), the digest's sent marks and its place in the daily run (#11), and the
// cash calendar's date bound (#15).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
delete process.env.SEATS_AERO_API_KEY;
delete process.env.CASH_PASSCODE;
delete process.env.CRON_SECRET;
const { server } = require('../server');
const { createHistory } = require('../lib/history');
const { createPriceWatch } = require('../lib/pricewatch');
const { memoryStore } = require('../lib/alerts');
const { memoryKv, redisKv, takeLock } = require('../lib/kv');
const { calendarTwd, inUsd } = require('../lib/rapidflights');
const { createDeals } = require('../lib/deals');
const { createNlSearch } = require('../lib/nlsearch');
const { createDealSub } = require('../lib/dealsub');
const AIRPORTS = require('../public/airports.min.json');

const isoIn = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const seat = (miles) => ({ available: true, miles, seats: 2, airlines: 'BR', direct: true });
const quietly = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

test('R6.1: a cut deals page keeps the rows it saw, without weekday counts or "looked, nothing there" routes', async () => {
  const t = Date.parse('2026-10-16T01:00:00Z');
  const params = { origin_airport: 'TPE', destination_airport: 'NRT,KIX', start_date: '2026-10-17', end_date: '2027-09-12', cabins: 'business' };
  // The cheapest rows of a page that stopped at its limit: NRT on three dates, nothing for KIX in it.
  const rows = ['2026-11-02', '2026-11-03', '2026-11-09'].map((date, i) => ({ id: 'r' + i, date, origin: 'TPE', destination: 'NRT', source: 'aeroplan', cabins: { J: seat(20000) } }));
  const kv = memoryKv();
  assert.equal(await createHistory({ kv, now: () => t }).note(params, rows, { hasMore: true }), 1);
  const nrt = await kv.get('hist:v1:TPE-NRT');
  assert.deepEqual(nrt.r['aeroplan.J'].map((e) => e.slice(1)), [[3, 20000, 2]], 'the rows seen are kept');
  assert.equal(nrt.w, undefined, 'no weekday counts: the 330 days were not all looked at');
  assert.equal(await kv.get('hist:v1:TPE-KIX'), null, 'KIX may have space past the cut');
  // The same rows from a complete search count as before: both routes, weekday counts over the range.
  const kv2 = memoryKv();
  assert.equal(await createHistory({ kv: kv2, now: () => t }).note(params, rows), 2);
  assert.ok((await kv2.get('hist:v1:TPE-NRT')).w.J);
  assert.deepEqual((await kv2.get('hist:v1:TPE-KIX')).r, {});
});

test('R6.4: a price-watch reading in US dollars sends no 降價 mail and leaves the baseline alone', async () => {
  let t = Date.parse('2026-10-16T01:00:00Z');
  const readings = [[320, 335, 410], [9000, 9400]];
  const sent = [];
  const store = memoryStore(null);
  const pw = createPriceWatch({ store, now: () => t, sendEmail: async (m) => { sent.push(m.subject); }, search: async () => ({ options: readings.shift().map((price) => ({ price, segments: [{ flightNumber: 'BR 198' }] })) }) });
  await pw.add({ origin: 'TPE', destination: 'NRT', depart: '2026-12-20', cabin: 'Y', email: 'a@b.co', price: 10000 });
  t += 8 * 864e5;
  const r1 = await pw.run();
  assert.match(r1.report[0].error, /美金/);
  assert.equal(sent.length, 0, 'no mail about NT$320');
  let w = (await store.load()).watches[0];
  assert.deepEqual([w.notified, w.lastPrice, w.history.length], [10000, 10000, 1], 'baseline and history untouched');
  // The next run (the reading was refused, so it is due again) sees the real drop to NT$9,000.
  t += 864e5;
  const r2 = await pw.run();
  assert.deepEqual([r2.report[0].price, r2.report[0].dropped], [9000, true]);
  assert.deepEqual(sent, ['【機票搜索雷達】TPE → NRT 降到 NT$9,000']);
  // With the day's rate a dollar reading is converted instead.
  const store2 = memoryStore(null);
  const pw2 = createPriceWatch({ store: store2, now: () => t, twdPerUsd: async () => 32, sendEmail: async (m) => { sent.push(m.subject); }, search: async () => ({ options: [{ price: 300, segments: [] }, { price: 350, segments: [] }] }) });
  await pw2.add({ origin: 'TPE', destination: 'NRT', depart: '2026-12-20', cabin: 'Y', email: 'a@b.co', price: 10000 });
  t += 8 * 864e5;
  assert.equal((await pw2.run()).report[0].price, 9600);
  w = (await store2.load()).watches[0];
  assert.deepEqual([w.notified, w.lastPrice], [9600, 9600]);
  assert.equal(sent.at(-1), '【機票搜索雷達】TPE → NRT 降到 NT$9,600');
});

test('R6.5: a lock is released only by its holder', async () => {
  let t = Date.parse('2026-10-16T01:00:00Z');
  const kv = memoryKv({ now: () => t });
  const first = await takeLock(kv, 'L', 30);
  t += 31e3; // the first holder outlived its lock (a slow lookup)
  const second = await takeLock(kv, 'L', 70);
  assert.ok(first && second);
  await first(); // the first holder finishes late
  assert.equal(await takeLock(kv, 'L', 70), null, 'the second holder still has it');
  await second();
  assert.ok(await takeLock(kv, 'L', 70), 'its own holder lets it go');
  // A store without delIf (a test stand-in): read, compare, delete.
  const { delIf, ...bare } = memoryKv({ now: () => t });
  const a = await takeLock(bare, 'L', 30);
  t += 31e3;
  const b = await takeLock(bare, 'L', 70);
  await a();
  assert.equal(await takeLock(bare, 'L', 70), null);
  await b();
  assert.ok(await takeLock(bare, 'L', 70));
  // Upstash: one EVAL that deletes only while the key holds the lock's own token.
  const cmds = [];
  const redis = redisKv({ url: 'https://redis.test', token: 'x', fetchImpl: async (u, o) => { cmds.push(JSON.parse(o.body)); return new Response(JSON.stringify({ result: cmds.at(-1)[0] === 'SET' ? 'OK' : 1 })); } });
  await (await takeLock(redis, 'L', 70))();
  assert.deepEqual(cmds[0].slice(0, 2), ['SET', 'L']);
  assert.equal(cmds[1][0], 'EVAL');
  assert.deepEqual(cmds[1].slice(2), [1, 'L', cmds[0][2]]);
});

test('R6.6: without a reference fare the currency guess goes by cabin', () => {
  const grid = (prices) => ({ round: false, currency: 'auto', days: prices.map((price, i) => ({ date: `2026-11-${String(i + 1).padStart(2, '0')}`, price })) });
  // A cheap NT$ economy month (short low-cost routes) stays NT$.
  const cheapY = grid([1580, 1650, 1720, 1900, 2300]);
  assert.deepEqual(calendarTwd(cheapY, 32, 0, 1), { ...cheapY, currency: 'TWD' });
  // A US-dollar business month (TPE-LHR around US$3,000) is converted; the flat economy floor took it for NT$.
  const usdJ = grid([2800, 3050, 3100, 3300, 3900]);
  const j = calendarTwd(usdJ, 32, 0, 3);
  assert.deepEqual(j.fx, { from: 'USD', rate: 32 });
  assert.equal(j.days[2].price, 99200);
  assert.equal(calendarTwd(usdJ, 32, 0).fx, undefined);
  // The floors: premium economy 3,000, business 8,000, first 15,000.
  assert.deepEqual([inUsd([2900], 0, 32, 2), inUsd([3100], 0, 32, 2), inUsd([9000], 0, 32, 3), inUsd([14000], 0, 32, 4), inUsd([16000], 0, 32, 4)], [true, false, false, true, false]);
  // A reference fare still decides first.
  assert.equal(inUsd([3100], 95000, 32, 1), true);
});

test('R6.7: the background retry refreshes only the failed groups, and every group past MAX_AGE', async () => {
  let t = Date.parse('2026-10-15T00:20:00Z');
  let failF = true;
  const asked = [];
  const bg = [];
  const locks = new Map();
  const lock = async (name, sec) => { if ((locks.get(name) || 0) > t) return null; locks.set(name, t + sec * 1000); return async () => locks.delete(name); };
  const d = createDeals({ store: memoryStore(null), now: () => t, lock, days: 60, defer: (p) => { bg.push(p); return p; }, search: async (p) => {
    const dest = p.destination_airport.split(',')[0];
    asked.push(`${dest}:${p.cabins}`);
    if (failF && dest === 'LHR' && p.cabins === 'first') throw new Error('seats.aero 回應錯誤 (500)');
    return [{ id: 'x' + asked.length, date: '2026-12-01', origin: 'TPE', destination: dest, source: 'aeroplan', cabins: { J: seat(60000), F: seat(90000) } }];
  } });
  await quietly(() => d.refresh({ skipFresh: true }));
  assert.equal(asked.length, 8);
  failF = false;
  t += 7 * 3600e3; // past the 6-hour window of the cron's catch-up, well inside MAX_AGE (14 h)
  asked.length = 0;
  await d.get();
  await Promise.all(bg);
  assert.deepEqual(asked, ['LHR:first'], 'a page view retried the failed group only');
  t += 15 * 3600e3; // no cron since: the copy is past MAX_AGE
  asked.length = 0;
  bg.length = 0;
  await d.get();
  await Promise.all(bg);
  assert.equal(asked.length, 8);
});

test('R6.8: the unsubscribe page shows the address and posts only on the button', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'dealsub.js'), 'utf8');
  const ctx = { atob, TextDecoder };
  vm.createContext(ctx);
  vm.runInContext(`${src.match(/function dsubTokenEmail\(t\) \{[\s\S]*?\n\}/)[0]}\nthis.f = dsubTokenEmail;`, ctx);
  const sub = createDealSub({ kv: memoryKv(), loadDeals: async () => ({}) });
  assert.equal(ctx.f(await sub.token('lyh.test@example.com')), 'l***@example.com');
  assert.equal(ctx.f('%%%.abc'), '');
  // The POST sits in the button's click handler, not in the code that runs on load.
  const fn = src.match(/function dsubUnsubLink\(hash\) \{[\s\S]*?\n\}/)[0];
  const click = fn.indexOf("addEventListener('click', async");
  assert.ok(click > 0 && fn.indexOf("api('/api/dealsub/unsubscribe'") > click);
  assert.match(fn, /取消訂閱<\/button>/);
});

test('R6.9: a failed model call gives the day\'s count back; without Redis the limit still holds', async () => {
  const names = require('../data/source-names.json').names;
  const programs = Object.entries(names).filter(([id]) => !id.endsWith('_est')).map(([id, name]) => ({ id, name }));
  const EMPTY = { origin: [], destination: ['KIX'], region: null, date_start: null, date_end: null, holiday: null, holiday_year: null, return_start: null, return_end: null, cabin: null, alliance: null, programs: [], passengers: null, direct_only: null };
  let fail = true;
  let calls = 0;
  const client = { messages: { async create() { calls++; if (fail) throw new Error('upstream 529'); return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(EMPTY) }] }; } } };
  const mk = (kv) => createNlSearch({ mode: 'live', client, kv, today: () => '2026-10-15', airportCodes: new Set(AIRPORTS.airports.map((a) => a[0])), groups: AIRPORTS.groups, programs, limit: 2 });
  const kv = memoryKv();
  const s = mk(kv);
  await quietly(async () => {
    await assert.rejects(s.parse('一月去大阪'), (e) => e.status === 502);
    await assert.rejects(s.parse('二月去大阪'), (e) => e.status === 502);
  });
  assert.deepEqual(await s.usage(), { used: 0, limit: 2 }, 'both tries given back');
  fail = false;
  assert.equal((await s.parse('三月去大阪')).used, 1);
  // Redis down: this instance counts on its own, with the same limit.
  const down = { get: async () => { throw new Error('down'); }, set: async () => { throw new Error('down'); }, incr: async () => { throw new Error('down'); } };
  const d = mk(down);
  calls = 0;
  assert.equal((await d.parse('四月去大阪')).used, 1);
  assert.equal((await d.parse('五月去大阪')).used, 2);
  await assert.rejects(d.parse('六月去大阪'), (e) => e.status === 429 && e.code === 'nl-limit');
  assert.equal(calls, 2);
  assert.deepEqual(await d.usage(), { used: 2, limit: 2 });
  // A failure is given back there too.
  const e = mk(down);
  fail = true;
  await quietly(() => assert.rejects(e.parse('七月去大阪')));
  fail = false;
  await e.parse('八月去大阪');
  assert.equal((await e.parse('九月去大阪')).used, 2);
});

test('R6.11: sent marks that cannot be saved are retried once, then the day is done here instead of mailed again', async () => {
  const clock = { t: Date.parse('2026-10-15T01:00:00Z') };
  const deals = { generatedAt: '2026-10-15T00:12:00.000Z', groups: [{ id: 'jk', name: '日韓', cabin: 'J', items: [{ origin: 'TPE', destination: 'NRT', date: '2026-12-01', source: 'alaska', miles: 25000 }] }] };
  const mk = (failSets) => {
    const mem = memoryKv({ now: () => clock.t });
    const fails = { left: failSets };
    // Writes of the day's marks fail `failSets` times; everything else works.
    const kv = { ...mem, set: async (k, v, o) => { if (k.startsWith('dealsub:v1:day:') && fails.left-- > 0) throw new Error('redis down'); return mem.set(k, v, o); } };
    const sent = [];
    const sendEmail = async (m) => { sent.push(m.to); };
    sendEmail.batch = async (list) => { sent.push(...list.map((m) => m.to)); };
    return { kv, sent, sub: createDealSub({ kv, loadDeals: async () => deals, sendEmail, now: () => clock.t }) };
  };
  // One failed write: tried again at once, nothing lost, nothing sent twice.
  const one = mk(1);
  await one.sub.subscribe('a@x.co', true);
  await one.sub.subscribe('b@x.co', true);
  const r1 = await quietly(() => one.sub.run());
  assert.deepEqual([r1.mailed, r1.errors, r1.done, r1.unsaved], [2, 0, true, undefined]);
  assert.equal((await one.kv.get('dealsub:v1:day:2026-10-15')).done, true);
  // The store keeps failing: the mail went out once, the day is done on this instance, the evening run sends nothing.
  const down = mk(99);
  await down.sub.subscribe('a@x.co', true);
  await down.sub.subscribe('b@x.co', true);
  const r2 = await quietly(() => down.sub.run());
  assert.deepEqual([r2.mailed, r2.errors, r2.unsaved], [2, 0, true], 'a failed save is not a failed send');
  clock.t = Date.parse('2026-10-15T13:10:00Z');
  const evening = await down.sub.run();
  assert.equal(evening.already, true);
  assert.deepEqual(down.sent.sort(), ['a@x.co', 'b@x.co'], 'each once');
});

test('R6.11: the daily run sends the deals digest after the price watches and seat alerts', async () => {
  const r = await (await fetch(`${base}/api/alerts/run?part=watches,alerts,digest`)).json();
  const keys = Object.keys(r);
  assert.ok(keys.includes('watches') && keys.includes('digest'));
  assert.ok(keys.indexOf('watches') < keys.indexOf('digest'), 'the run fills its answer in the order the parts ran');
});

test('R6.15: the cash month grid refuses an end past the fares\' horizon (335 days)', async () => {
  const q = (start, end) => fetch(`${base}/api/cash/calendar?origin=TPE&destination=NRT&start=${start}&end=${end}`);
  const far = await q(isoIn(300), isoIn(340));
  assert.equal(far.status, 400);
  assert.match((await far.json()).error, /11 個月/);
  assert.equal((await q(isoIn(280), isoIn(330))).status, 200);
  // The page counts its cash dates from the Taiwan date too, whatever the visitor's time zone.
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const grab = (re) => src.match(re)[0];
  const ctx = { CASH_MAX_DAYS: 335, Date }; // this process's clock, so a shifted one reaches the page code too
  vm.createContext(ctx);
  vm.runInContext([grab(/function isoDateFrom\(iso, offsetDays\) \{[\s\S]*?\n\}/), grab(/const twDate = .*\n/), grab(/function cashMonthRange\(r\) \{[\s\S]*?\n\}/), 'this.f = { twDate, cashMonthRange };'].join('\n'), ctx);
  const { todayTW, addDays } = require('../lib/day');
  assert.equal(ctx.f.twDate(0), todayTW());
  assert.deepEqual({ ...ctx.f.cashMonthRange({ depart: addDays(todayTW(), 5) }) }, { start: addDays(todayTW(), 1), end: addDays(todayTW(), 60) });
  assert.equal(ctx.f.cashMonthRange({ depart: addDays(todayTW(), 330) }).end, addDays(todayTW(), 335));
});
