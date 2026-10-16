// Round 6 N13 飯店點數房提醒 (lib/hotelwatch.js): what counts as news (a night that opens, or drops to the ceiling),
// the baseline, the five-watch cap, one rooms.aero call per watch per run and the daily cap, delivery and its retry,
// and the server's endpoint and daily-run part. U12/U13 (查飯店 summary line, the card's newer 每點約) at the end.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
delete process.env.SEATS_AERO_API_KEY;
delete process.env.CASH_PASSCODE;
delete process.env.CRON_SECRET;
const { createHotelWatch, rowsOf, newsOf, nextSeen, fits, MAX_WATCHES, DAILY_CAP } = require('../lib/hotelwatch');
const { memoryStore } = require('../lib/alerts');
const { cronParts } = require('../lib/cronreport');
const { server } = require('../server');

const T0 = Date.parse('2026-10-16T00:10:00Z'); // the morning run: 08:10 in Taiwan
const night = (arrival, points, suite = 0) => ({ arrival, standard: points ? { points } : null, suite: suite ? { points: suite } : null });
const quietly = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };
const hotelInput = (over = {}) => ({ kind: 'hotel', hotelId: 'h1', name: 'Park Hyatt Tokyo', source: 'hyatt', where: 'Tokyo', start: '2026-11-01', end: '2026-11-05', nights: 1, ...over });

// A watch list over a fake rooms.aero: `nights[hotelId]` is what /availability answers, `area` what /search answers.
function setup({ dailyCap, notify = async () => null, sendEmail = async () => {} } = {}) {
  const clock = { t: T0 };
  const fake = { calls: 0, nights: { h1: [night('2026-11-01', 30000), night('2026-11-02', 0)], h2: [], h3: [], h4: [], h5: [], h6: [] }, area: [], fail: false };
  const mails = [];
  const chats = [];
  const hw = createHotelWatch({
    store: memoryStore(null),
    now: () => clock.t,
    dailyCap,
    sendEmail: async (m) => { mails.push(m); return sendEmail(m); },
    notify: async (html) => { chats.push(html); return notify(html); },
    siteUrl: 'https://example.test',
    search: async (q) => {
      fake.calls++;
      if (fake.fail) throw new Error('rooms.aero down');
      return q.kind === 'hotel' ? { dates: fake.nights[q.hotelId] || [] } : { hotels: fake.area };
    },
  });
  return { hw, fake, clock, mails, chats };
}

test('N13: rows are one per check-in date for a hotel, one per hotel for a search, at the cheaper room', () => {
  assert.deepEqual(rowsOf({ kind: 'hotel' }, { dates: [night('2026-11-02', 40000, 35000), night('2026-11-01', 30000), night('2026-11-03', 0)] }).map((r) => [r.key, r.points, r.room]),
    [['2026-11-01', 30000, 'standard'], ['2026-11-02', 35000, 'suite']]);
  const area = rowsOf({ kind: 'area' }, { hotels: [{ id: 'a', name: 'A', source: 'ihg', standard: { points: 50000, date: '2026-11-03' } }, { id: 'b', name: 'B', suite: { points: 70000, date: '2026-11-04' } }, { id: 'c', name: 'C' }] });
  assert.deepEqual(area.map((r) => [r.key, r.points, r.date, r.room]), [['a', 50000, '2026-11-03', 'standard'], ['b', 70000, '2026-11-04', 'suite']]);
});

test('N13: news is a night that opened, or one that dropped to the per-night ceiling; nothing else', () => {
  const w = { kind: 'hotel', nights: 2, maxPoints: 20000 }; // a 2-night stay: up to 40,000 in all
  assert.equal(fits(w, 40000), true);
  assert.equal(fits(w, 40500), false);
  assert.equal(fits({ nights: 1, maxPoints: 0 }, 1), true, 'no ceiling: any points night');
  const seen = { '2026-11-01': [38000, '2026-11-01'], '2026-11-02': [52000, '2026-11-02'], '2026-11-03': [60000, '2026-11-03'] };
  const rows = [
    { key: '2026-11-01', date: '2026-11-01', points: 36000 }, // fitted before: old news even though cheaper
    { key: '2026-11-02', date: '2026-11-02', points: 40000 }, // was above the ceiling, now at it: dropped
    { key: '2026-11-03', date: '2026-11-03', points: 55000 }, // still above: nothing
    { key: '2026-11-04', date: '2026-11-04', points: 30000 }, // not there before: opened
    { key: '2026-11-05', date: '2026-11-05', points: 90000 }, // opened, but above the ceiling
  ];
  const news = newsOf(w, rows, seen);
  assert.deepEqual(news.map((r) => [r.key, r.why, r.before]), [['2026-11-02', 'drop', 52000], ['2026-11-04', 'open', undefined]]);
  // Until the news is out the fresh rows keep the old state; the rest is what this check saw (a vanished night is forgotten).
  const next = nextSeen(rows, news, seen);
  assert.deepEqual(next['2026-11-02'], [52000, '2026-11-02']);
  assert.equal('2026-11-04' in next, false);
  assert.deepEqual(next['2026-11-05'], [90000, '2026-11-05']);
  assert.equal(newsOf(w, [], next).length, 0);
});

test('N13: saving takes a baseline (one call), a twin is handed back, and five watches is the most', async () => {
  const { hw, fake } = setup();
  const r = await hw.add(hotelInput());
  assert.equal(fake.calls, 1);
  assert.equal(r.found, 1, 'the 11/1 night has points now');
  assert.deepEqual(r.watch.best, { points: 30000, date: '2026-11-01' });
  assert.equal('seen' in r.watch, false, 'the baseline stays on the server');
  const twin = await hw.add(hotelInput());
  assert.equal(twin.duplicate, true);
  assert.equal(fake.calls, 1, 'a twin costs nothing');
  for (const id of ['h2', 'h3', 'h4', 'h5']) await hw.add(hotelInput({ hotelId: id }));
  assert.equal((await hw.list()).watches.length, MAX_WATCHES);
  await assert.rejects(hw.add(hotelInput({ hotelId: 'h6' })), /最多 5 個/);
  assert.equal(fake.calls, 5, 'the sixth is refused before any call');
  await assert.rejects(hw.add(hotelInput({ start: '2026-10-01', end: '2026-10-10' })), /已經過了/);
  await assert.rejects(hw.add(hotelInput({ end: '2027-03-01' })), /3 個月/);
  await assert.rejects(hw.add(hotelInput({ maxPoints: 50 })), /1,000/);
  await assert.rejects(hw.add({ kind: 'area', where: 'Tokyo', programs: ['accor'], start: '2026-11-01', end: '2026-11-02' }), /飯店集團/);
});

test('N13: the run reports an opened night once, by mail and one chat message, and the cron checks each watch once a day', async () => {
  const { hw, fake, clock, mails, chats } = setup({ notify: async () => true });
  await hw.add(hotelInput({ email: 'me@x.co' }));
  await hw.add({ kind: 'area', where: 'Tokyo', label: '東京', programs: ['hyatt', 'ihg'], start: '2026-11-01', end: '2026-11-05', nights: 1, maxPoints: 20000 });
  fake.calls = 0;
  // The morning cron: both were checked when saved today, so nothing is spent.
  const morning = await hw.run({ force: false });
  assert.equal(fake.calls, 0);
  assert.deepEqual(morning.report.map((x) => x.skipped), ['done-today', 'done-today']);
  // Next day: 11/2 opens at the hotel; in the area one hotel drops under 20,000 and one opens above it.
  clock.t += 864e5;
  fake.nights.h1 = [night('2026-11-01', 30000), night('2026-11-02', 25000, 50000)];
  fake.area = [{ id: 'x', name: 'Hyatt Place', source: 'hyatt', standard: { points: 15000, date: '2026-11-03' } }, { id: 'y', name: 'InterContinental', source: 'ihg', standard: { points: 60000, date: '2026-11-02' } }];
  const day2 = await hw.run({ force: false });
  assert.equal(fake.calls, 2, 'one rooms.aero call per watch');
  assert.deepEqual(day2.report.map((x) => x.fresh), [1, 1]);
  assert.equal(mails.length, 1, 'only the watch with an address is mailed');
  assert.match(mails[0].subject, /Park Hyatt Tokyo 有新的點數房/);
  assert.match(mails[0].html, /2026-11-02/);
  assert.equal(chats.length, 1, 'the run\'s news goes out as one message');
  assert.match(chats[0], /Park Hyatt Tokyo：1 個入住日有新的點數房/);
  assert.match(chats[0], /東京（凱悅、洲際）：1 家飯店有新的點數房[\s\S]*Hyatt Place 11\/3 入住 <b>15,000<\/b> 點・新開出/);
  // Later the same day (the evening run): done today, nothing spent. The day after: no news, nothing sent again.
  assert.deepEqual((await hw.run({ force: false })).report.map((x) => x.skipped), ['done-today', 'done-today']);
  clock.t += 864e5;
  const day3 = await hw.run({ force: false });
  assert.deepEqual(day3.report.map((x) => x.fresh), [0, 0]);
  assert.equal(chats.length, 1);
  // InterContinental drops from 60,000 to 18,000: under the ceiling now.
  clock.t += 864e5;
  fake.area[1].standard.points = 18000;
  const day4 = await hw.run({ force: false });
  assert.match(chats[1], /InterContinental 11\/2 入住 <b>18,000<\/b> 點・原本 60,000 點/);
  assert.equal(day4.report.find((x) => x.fresh).fresh, 1);
  const listed = (await hw.list()).watches.find((w) => w.kind === 'area');
  assert.deepEqual([listed.lastFound, listed.lastNew, listed.best.points], [2, 1, 15000]);
});

test('N13: a send that failed is tried again on the next run; with nowhere to send, the news is kept on the site only', async () => {
  let chatOk = false;
  const { hw, fake, clock, chats } = setup({ notify: async () => chatOk });
  await hw.add(hotelInput());
  clock.t += 864e5;
  fake.nights.h1 = [night('2026-11-01', 30000), night('2026-11-02', 20000)];
  const r1 = await hw.run({ force: false });
  assert.deepEqual([r1.report[0].fresh, r1.report[0].retry], [1, true]);
  // The evening run tries again (the watch is not done today) and the message gets through this time.
  chatOk = true;
  clock.t += 12 * 3600e3;
  const r2 = await hw.run({ force: false });
  assert.deepEqual([r2.report[0].fresh, r2.report[0].retry, chats.length], [1, undefined, 2]);
  clock.t += 864e5;
  assert.equal((await hw.run({ force: false })).report[0].fresh, 0, 'told once');
  // Nowhere to send (no address, no chat linked): marked seen, shown on the site.
  const quiet = setup();
  await quiet.hw.add(hotelInput());
  quiet.clock.t += 864e5;
  quiet.fake.nights.h1.push(night('2026-11-03', 10000));
  assert.equal((await quiet.hw.run({ force: false })).report[0].retry, undefined);
  quiet.clock.t += 864e5;
  assert.equal((await quiet.hw.run({ force: false })).report[0].fresh, 0);
});

test('N13: the runs of a day stop at the daily cap; a run near its time limit starts nothing; failures and past stays', async () => {
  const { hw, fake, clock } = setup({ dailyCap: 3 });
  for (const id of ['h1', 'h2']) await hw.add(hotelInput({ hotelId: id }));
  fake.calls = 0;
  const forced = await hw.run(); // the owner's 立即檢查
  assert.equal(fake.calls, 2, 'one call per watch per run');
  assert.equal(forced.used, 2);
  const again = await hw.run();
  assert.equal(fake.calls, 3, 'the cap stops the second watch');
  assert.deepEqual(again.report.map((x) => x.skipped || 'checked'), ['checked', 'cap']);
  // A new UTC day starts the count again (rooms.aero's quota day).
  clock.t += 864e5;
  fake.calls = 0;
  const late = await hw.run({ until: Date.now() + 1000 });
  assert.equal(fake.calls, 0, 'no call that could not answer in time');
  assert.deepEqual(late.report.map((x) => x.skipped), ['time', 'time']);
  fake.fail = true;
  const failed = await quietly(() => hw.run());
  assert.match(failed.report[0].error, /down/);
  assert.match((await hw.list()).watches[0].lastError, /down/);
  // After the stays' dates the watches go.
  clock.t = Date.parse('2026-11-06T01:00:00Z');
  const gone = await hw.run();
  assert.deepEqual(gone.report.map((x) => x.expired), [true, true]);
  assert.equal((await hw.list()).watches.length, 0);
  assert.equal(DAILY_CAP, 15);
});

test('N13: a watch whose window has begun is checked from today, never for past nights', async () => {
  const seen = [];
  const hw = createHotelWatch({ store: memoryStore(null), now: () => Date.parse('2026-11-03T02:00:00Z'), search: async (q) => { seen.push([q.start, q.end]); return { dates: [] }; } });
  await hw.add(hotelInput({ start: '2026-11-01', end: '2026-11-08' }));
  assert.deepEqual(seen, [['2026-11-03', '2026-11-08']]);
});

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());
const isoIn = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

test('N13: /api/hotel-watch in the demo, the daily run\'s hotels part after the seat alerts, and the passcode', async () => {
  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.equal(cfg.hotels.watch, true);
  const post = (body, headers = {}) => fetch(`${base}/api/hotel-watch`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const add = await post({ kind: 'area', where: 'Tokyo', label: '東京', programs: ['hyatt', 'marriott'], start: isoIn(20), end: isoIn(26), nights: 1 });
  assert.equal(add.status, 200);
  const made = await add.json();
  assert.equal(made.watch.kind, 'area');
  assert.ok(made.found > 0, 'the demo has points nights');
  const list = await (await fetch(`${base}/api/hotel-watch`)).json();
  assert.deepEqual([list.configured, list.watches.length, list.max, list.cap], [true, 1, 5, 15]);
  // Naming the part, as 立即檢查 does, checks it again (the cron skips a watch checked today: see above).
  const all = await (await fetch(`${base}/api/alerts/run?part=alerts,hotels,digest`)).json();
  const keys = Object.keys(all);
  assert.ok(keys.includes('hotels') && keys.indexOf('hotels') < keys.indexOf('digest'), 'the run fills its answer in the order the parts ran: hotels before the digest');
  assert.deepEqual([all.hotels.report[0].fresh, all.hotels.used], [0, 1]);
  const plain = await (await fetch(`${base}/api/alerts/run?part=expiry`)).json();
  assert.equal(plain.hotels, undefined, 'only the parts asked for');
  const del = await fetch(`${base}/api/hotel-watch?id=${made.watch.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal((await post({ kind: 'hotel', hotelId: 'x y', name: 'A', start: isoIn(20) })).status, 400);
  const prev = process.env.CASH_PASSCODE;
  process.env.CASH_PASSCODE = 'pw';
  try {
    assert.equal((await fetch(`${base}/api/hotel-watch`)).status, 401);
    const ok = await fetch(`${base}/api/hotel-watch`, { headers: { 'x-cash-pass': 'pw' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
  } finally {
    if (prev == null) delete process.env.CASH_PASSCODE; else process.env.CASH_PASSCODE = prev;
  }
});

test('N13: the owner\'s status line names the hotels part only when there was something to check', () => {
  assert.deepEqual(cronParts({ hotels: { checked: 0, report: [] } }), {});
  assert.deepEqual(cronParts({ hotels: { checked: 2, report: [{ id: 'a', fresh: 1 }, { id: 'b', skipped: 'time' }] } }), { hotels: 'some' });
  assert.deepEqual(cronParts({ hotels: { error: 'kv' } }), { hotels: 'fail' });
});

test('U12/U13: 查飯店 sums up points hotels and 雅高 above the results; the card follows the newer cash price', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'hotels.js'), 'utf8');
  const vm = require('node:vm');
  const grab = (re) => src.match(re)[0];
  const el = { hidden: true, innerHTML: '' };
  const ctx = { $: (s) => (s === '#h-summary' ? el : null), fmt: (n) => Number(n).toLocaleString('en-US'), esc: (s) => String(s), hotelState: {}, fxCache: { rates: { TWD: 1, USD: 32 } }, POINT_VALUE_CENTS: { hyatt: 1.7 }, HOTEL_GOOD: 1.3 };
  vm.createContext(ctx);
  vm.runInContext([grab(/function hotelSummary\(\) \{[\s\S]*?\n\}/), grab(/const toTwd = .*\n/), grab(/const twdPerPoint = .*\n/), grab(/const typicalTwd = .*\n/), grab(/function hotelValueHtml\([\s\S]*?\n\}/), grab(/function otherHotelNote\([\s\S]*?\n\}/), grab(/function cardCashHtml\(h\) \{[\s\S]*?\n\}/), grab(/function cashNowOf\(h, body\) \{[\s\S]*?\n\}/), 'this.f = { hotelSummary, cardCashHtml, cashNowOf };'].join('\n'), ctx);
  ctx.hotelState.counts = { rooms: 14, accor: null };
  ctx.f.hotelSummary();
  assert.equal(el.hidden, false);
  assert.match(el.innerHTML, /點數房 14 家・雅高查詢中…/);
  ctx.hotelState.counts.accor = 6;
  ctx.f.hotelSummary();
  assert.match(el.innerHTML, /點數房 14 家・雅高 6 家<\/span><button[^>]*data-h-jump>（跳到雅高 ↓）/);
  ctx.hotelState.counts = null;
  ctx.f.hotelSummary();
  assert.equal(el.hidden, true, 'not shown without 雅高');
  // The card: rooms.aero's cash first; after 現金價比一比, the lowest price found, with its source and the same 每點約.
  const h = { source: 'hyatt', name: 'Hyatt Place Tokyo', standard: { points: 8000, cash: { amount: 183, currency: 'USD' } } };
  assert.match(ctx.f.cardCashHtml(h), /同一晚現金約 NT\$5,856[\s\S]*每點約 NT\$0\.73/);
  const serp = { provider: 'serpapi', found: true, name: 'Hyatt Place Tokyo', prices: [{ source: 'Agoda', total: 11116 }, { source: '官方網站', official: true, total: 11460 }] };
  h.cashNow = ctx.f.cashNowOf(h, serp);
  const card = ctx.f.cardCashHtml(h);
  assert.match(card, /現金最低 NT\$11,116（剛查・Agoda）/);
  assert.match(card, /每點約 NT\$1\.39/);
  assert.match(card, /title="rooms\.aero 記錄的同一晚現金約 NT\$5,856"/);
  assert.doesNotMatch(card, /0\.73/);
  assert.deepEqual({ ...ctx.f.cashNowOf(h, { provider: 'booking', found: true, name: 'Hyatt Place Tokyo', total: 9000 }) }, { total: 9000, label: 'Booking.com', lowest: false });
  assert.equal(ctx.f.cashNowOf(h, { provider: 'booking', found: true, name: 'Some Other Inn', total: 9000 }), null, 'maybe another property: the card keeps its number');
  assert.equal(ctx.f.cashNowOf(h, { provider: 'booking', found: true, name: 'Hyatt Place Tokyo', soldOut: true }), null);
});
