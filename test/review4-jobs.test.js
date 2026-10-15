// Review 4 (2026-10-15) fixes in the daily jobs: seat alerts (R1, R2, R5, R6/S4, R7, R11, R12, R13), price watches
// (R2, R4), 今日好康 (R3, R8, R9/S5), Telegram and LINE results, and the store reads of /api/history and /api/cxcal (S2).
const { test } = require('node:test');
const assert = require('node:assert');
const { createAlerts, memoryStore } = require('../lib/alerts');
const { createDeals } = require('../lib/deals');
const { createPriceWatch } = require('../lib/pricewatch');
const { createTelegram, telegramClient } = require('../lib/telegram');
const { createLine } = require('../lib/line');
const { createHistory } = require('../lib/history');
const { createCxcalStore } = require('../lib/cxcal-store');
const { createClient } = require('../lib/seats');
const { memoryKv, takeLock } = require('../lib/kv');

const isoIn = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const seat = (miles) => ({ available: true, miles, seats: 2, airlines: 'BR', direct: true });
const row = (id, cabins, date = isoIn(30)) => ({ id, date, origin: 'TPE', destination: 'NRT', source: 'aeroplan', cabins });
const watch = (extra) => ({ origin: 'TPE', destination: 'NRT', start: isoIn(20), end: isoIn(40), ...extra });
const yesterday = () => new Date(Date.now() - 864e5).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('R1: a watch whose check failed in the first cron run is checked again by the catch-up run', async () => {
  let fail = false;
  let calls = 0;
  const store = memoryStore();
  const al = createAlerts({ store, search: async () => { calls++; if (fail) throw new Error('seats.aero 回應錯誤 (502)'); return [row('a', { J: seat(30000) })]; }, sendEmail: async () => {} });
  await al.add(watch({ cabin: 'J', email: 'me@example.com' }));
  const l = await store.load();
  l[0].lastRun = l[0].lastOk = yesterday(); // the baseline was taken yesterday
  await store.save(l);
  fail = true;
  assert.equal((await al.run({ force: false })).report[0].error, 'seats.aero 回應錯誤 (502)');
  fail = false;
  const before = calls;
  const catchup = await al.run({ force: false });
  assert.equal(calls, before + 1, 'the catch-up checked it');
  assert.equal(catchup.report[0].found, 1);
  assert.equal((await al.run({ force: false })).report[0].skipped, 'done-today', 'done once it worked');
});

test('R1: news whose mail failed is sent again by the catch-up run the same morning', async () => {
  let rows = [row('a', { J: seat(30000) })];
  let mailDown = true;
  const mails = [];
  const store = memoryStore();
  const al = createAlerts({ store, search: async () => rows, sendEmail: async (m) => { if (mailDown) throw new Error('mail down'); mails.push(m); } });
  await al.add(watch({ cabin: 'J', email: 'me@example.com' }));
  const l = await store.load();
  l[0].lastRun = l[0].lastOk = yesterday();
  await store.save(l);
  rows = [...rows, row('b', { J: seat(35000) })];
  assert.equal((await al.run({ force: false })).report[0].retry, true);
  mailDown = false;
  const again = await al.run({ force: false });
  assert.deepEqual([again.report[0].fresh, again.report[0].mailed], [1, true]);
  assert.equal(mails.length, 1);
});

test('R2: Telegram tried and failed (no email) keeps the news for the next run', async () => {
  let rows = [];
  let up = false;
  const sent = [];
  const al = createAlerts({ store: memoryStore(), search: async () => rows, sendEmail: null, notify: async (html) => { if (!up) return false; sent.push(html); return true; } });
  await al.add(watch({ cabin: 'J' }));
  rows = [row('new1', { J: seat(30000) })];
  const r1 = await al.run();
  assert.equal(r1.report[0].retry, true);
  up = true;
  const r2 = await al.run();
  assert.deepEqual([r2.report[0].fresh, r2.report[0].telegram], [1, true]);
  assert.equal(sent.length, 1);
  // Nowhere to send (not linked): nothing to retry, the news is old from now on.
  const quiet = createAlerts({ store: memoryStore(), search: async () => rows, notify: async () => null });
  await quiet.add(watch({ cabin: 'J' }));
  rows = [...rows, row('new2', { J: seat(31000) })];
  assert.equal((await quiet.run()).report[0].retry, undefined);
  assert.equal((await quiet.run()).report[0].fresh, 0);
});

test('R2: Telegram and LINE notify say sent (true), nowhere to send (null) or failed (false)', async () => {
  const bot = (fail) => telegramClient({ token: '1:x', fetchImpl: async () => (fail ? new Response(JSON.stringify({ ok: false }), { status: 502 }) : new Response(JSON.stringify({ ok: true, result: {} }))) });
  const kv = memoryKv();
  await kv.set('telegram:v1', { chatId: 42 });
  assert.equal(await createTelegram({ client: bot(false), kv }).notify('x'), true);
  assert.equal(await createTelegram({ client: bot(true), kv }).notify('x'), false);
  assert.equal(await createTelegram({ client: bot(false), kv: memoryKv() }).notify('x'), null);
  assert.equal(await createTelegram({ client: null, kv }).notify('x'), null);
  const down = { get: async () => { throw new Error('down'); } };
  assert.equal(await createTelegram({ client: bot(false), kv: down }).notify('x'), false, 'the link could not be read');
  const lineDown = { ...down, incr: async () => 1, set: async () => true, del: async () => {} };
  assert.equal(await createLine({ client: { push: async () => ({}) }, kv: lineDown }).notify('x'), false);
});

test('R2: a price drop that Telegram failed to deliver (no email) is told again next time', async () => {
  let clock = Date.now();
  let price = 30000;
  let up = false;
  const sent = [];
  const w = createPriceWatch({ store: memoryStore(null), now: () => clock, search: async () => ({ options: [{ price, segments: [] }] }), notify: async (h) => { if (!up) return false; sent.push(h); return true; } });
  await w.add({ origin: 'TPE', destination: 'NRT', depart: isoIn(5), price: 30000 });
  clock += 864e5;
  price = 26000;
  assert.equal((await w.run()).report[0].retry, true);
  up = true;
  clock += 864e5;
  const r = await w.run();
  assert.deepEqual([r.report[0].dropped, r.report[0].telegram], [true, true]);
  assert.equal(sent.length, 1);
});

test('R4: a failed price check is due again on the next run, twice in a row at most', async () => {
  let t = Date.parse('2026-10-15T00:20:00Z');
  let fail = false;
  let searches = 0;
  const pw = createPriceWatch({ store: memoryStore(null), now: () => t, sendEmail: async () => {}, search: async () => { searches++; if (fail) throw new Error('RapidAPI 查價逾時'); return { options: [{ price: 20000, segments: [] }] }; } });
  await pw.add({ origin: 'TPE', destination: 'NRT', depart: '2027-03-01', cabin: 'Y', email: 'me@example.com' });
  t += 8 * 864e5;
  fail = true;
  assert.equal((await pw.run()).report[0].error, 'RapidAPI 查價逾時');
  t += 3600e3; // the catch-up run an hour later
  assert.equal((await pw.run()).report[0].error, 'RapidAPI 查價逾時', 'retried');
  t += 864e5;
  assert.equal((await pw.run()).report[0].error, 'RapidAPI 查價逾時', 'retried once more');
  t += 864e5;
  assert.equal((await pw.run()).report[0].skipped, 'not-due', 'then it waits its usual gap');
  fail = false;
  t += 7 * 864e5;
  assert.equal((await pw.run()).report[0].price, 20000);
  assert.equal(searches, 5);
});

test('R5: a watch whose worst case cannot finish by `until` is not started; `until` reaches the search', async () => {
  const seen = [];
  const al = createAlerts({ store: memoryStore(), search: async (p, o) => { seen.push(o?.until); return []; }, pagesFor: () => 2, perCallMs: 100 });
  await al.add(watch({ cabins: ['Y', 'J'] }));
  seen.length = 0;
  const r = await al.run({ until: Date.now() + 300 }); // 2 cabins × 2 pages × 100 ms = 400 ms
  assert.equal(r.report[0].skipped, 'time');
  assert.equal(seen.length, 0);
  const until = Date.now() + 5000;
  await al.run({ until });
  assert.deepEqual(seen, [until, until]);
});

test('R5: seats.aero calls shrink their timeout to `until`, and none is made with less than a second left', async () => {
  let fetched = 0;
  let signal;
  const c = createClient({ apiKey: 'k', fetchImpl: async (url, opts) => { fetched++; signal = opts.signal; return new Response(JSON.stringify({ data: [], hasMore: false })); } });
  await assert.rejects(c.search({ origin_airport: 'TPE' }, { until: Date.now() + 500 }), (e) => e.status === 504);
  assert.equal(fetched, 0);
  await c.search({ origin_airport: 'TPE' }, { until: Date.now() + 1500 });
  assert.equal(fetched, 1);
  await sleep(1600);
  assert.equal(signal.aborted, true, 'the call would have been cut at `until`');
});

test('R6/S4: a watch edited while the run checks it is skipped, not reported as all new', async () => {
  const store = memoryStore();
  const search = async (p) => { if (slow) await sleep(100); return p.cabins === 'business' ? [row('a1', { J: seat(60000) }), row('a2', { J: seat(60000) })] : [row('b1', { Y: seat(20000) })]; };
  let slow = false;
  const sent = [];
  const al = createAlerts({ store, search, notify: async (h) => { sent.push(h); return true; } });
  const { alert } = await al.add(watch({ cabin: 'J' }));
  slow = true;
  const run = al.run();
  await sleep(30); // the run is inside check() with the J-only conditions
  slow = false;
  await al.update(alert.id, { cabins: ['J', 'Y'] });
  const out = await run;
  assert.equal(out.report[0].skipped, 'edited');
  assert.equal(sent.length, 0);
  assert.deepEqual(Object.keys((await store.load())[0].seen).sort(), ['a1:J', 'a2:J', 'b1:Y']);
});

test('R7: one store error during the run is reported for that watch and the run goes on', async () => {
  const inner = memoryStore();
  let saves = 0;
  let failAt = Infinity;
  const store = { load: () => inner.load(), save: async (l) => { saves++; if (saves === failAt) throw new Error('提醒資料庫回應錯誤（502）'); return inner.save(l); } };
  let calls = 0;
  const al = createAlerts({ store, search: async () => { calls++; return [row('x', { J: seat(30000) })]; }, sendEmail: async () => {} });
  for (const d of ['NRT', 'HND', 'KIX']) await al.add(watch({ cabin: 'J', destination: d }));
  saves = 0;
  calls = 0;
  failAt = 3; // 1: the expiry sweep, 2: the first watch's result, 3: the second's
  const r = await al.run();
  assert.equal(calls, 3, 'all three were checked');
  assert.deepEqual(r.report.map((x) => (x.error ? 'error' : x.found)), [1, 'error', 1]);
});

test('R11: the link opens the best cabin among the news', async () => {
  let rows = [];
  const mails = [];
  const al = createAlerts({ store: memoryStore(), search: async (p) => rows.filter((r) => (p.cabins === 'business' ? r.cabins.J : r.cabins.Y)), sendEmail: async (m) => mails.push(m), siteUrl: 'https://x.test' });
  await al.add(watch({ cabins: ['Y', 'J'], email: 'me@example.com' }));
  rows = [row('y1', { Y: seat(20000) }, isoIn(21)), row('j1', { J: seat(60000) }, isoIn(25))];
  await al.run();
  assert.match(mails[0].html, /c=J/);
  assert.doesNotMatch(mails[0].html, /c=Y/);
});

test('R12: LINE gets one message per run with every watch\'s news; it decides only for news not delivered elsewhere', async () => {
  let rows = [];
  const digests = [];
  let lineResult = true;
  const al = createAlerts({ store: memoryStore(), search: async () => rows, notify: async () => null, digest: async (h) => { digests.push(h); return lineResult; } });
  await al.add(watch({ cabin: 'J' }));
  await al.add(watch({ cabin: 'J', destination: 'KIX' }));
  rows = [row('a', { J: seat(30000) })];
  lineResult = false;
  const r1 = await al.run();
  assert.equal(digests.length, 1, 'one LINE message for the run');
  assert.equal(digests[0].length, 2, 'with both watches\' news');
  assert.ok(r1.report.every((x) => x.retry), 'LINE failed and nothing else had it: tried again next run');
  lineResult = true;
  const r2 = await al.run();
  assert.deepEqual(r2.report.map((x) => [x.fresh, x.retry]), [[1, undefined], [1, undefined]]);
  assert.equal((await al.run()).report[0].fresh, 0);
  // Long digests are cut to what LINE takes.
  const kv = memoryKv();
  const pushed = [];
  await kv.set('line:v1', { userId: 'U1' });
  const line = createLine({ client: { push: async (to, text) => { pushed.push(text); return {}; } }, kv });
  assert.equal(await line.notify(Array.from({ length: 300 }, (_, i) => `第 ${i} 行 TPE→NRT 30,000 哩`).join('\n')), true);
  assert.ok(pushed[0].length <= 5000);
  assert.match(pushed[0], /其餘請到網站查看/);
});

test('R13: seen seats whose date has passed are forgotten; older miles-only entries stay', async () => {
  const store = memoryStore();
  let rows = [row('a', { J: seat(30000) })];
  const al = createAlerts({ store, search: async () => rows });
  await al.add(watch({ cabin: 'J' }));
  const l = await store.load();
  Object.assign(l[0].seen, { gone: [30000, isoIn(-2)], legacy: 31000 });
  await store.save(l);
  await al.run();
  const seen = (await store.load())[0].seen;
  assert.deepEqual(Object.keys(seen).sort(), ['a', 'legacy']);
  assert.deepEqual(seen.a, [30000, rows[0].date]);
});

// Two Vercel instances share one store, each with its own memory.
function dealsWorld() {
  let t = Date.parse('2026-10-14T00:20:00Z');
  const store = memoryStore(null);
  const locks = new Map();
  const lock = async (name, sec) => { if ((locks.get(name) || 0) > t) return null; locks.set(name, t + sec * 1000); return async () => locks.delete(name); };
  let calls = 0;
  const opts = [];
  const mk = () => createDeals({ store, now: () => t, lock, defer: (p) => p, days: 60, search: async (p, o) => { calls++; opts.push(o); return [{ id: 'x' + calls, date: '2026-12-01', origin: 'TPE', destination: p.destination_airport.split(',')[0], source: 'aeroplan', cabins: { J: seat(60000 + calls), F: seat(90000 + calls) } }]; } });
  return { set: (iso) => { t = Date.parse(iso); }, store, mk, calls: () => calls, opts, locks };
}

test('R3: the catch-up run on another instance reads the saved copy, not its own old memory', async () => {
  const w = dealsWorld();
  const A = w.mk();
  const B = w.mk();
  await A.refresh({ skipFresh: true });
  w.set('2026-10-15T00:05:00Z');
  await B.get(); // B remembers yesterday's copy
  w.set('2026-10-15T00:30:00Z');
  await A.refresh({ skipFresh: true });
  const c1 = w.calls();
  w.set('2026-10-15T01:40:00Z');
  await B.refresh({ skipFresh: true });
  assert.equal(w.calls() - c1, 0, 'every group is 70 minutes old');
  // A cut-off refresh on B keeps A's newer groups.
  let n = 0;
  await B.refresh({ deadline: { valueOf: () => (n++ < 2 ? Infinity : 0) } });
  assert.ok((await w.store.load()).groups.every((g) => g.at.startsWith('2026-10-15')));
});

test('R8: with the store down, an instance serves its own copy instead of rebuilding every 10 minutes', async () => {
  let t = Date.parse('2026-10-15T03:00:00Z');
  let calls = 0;
  const down = { get: async () => { throw new Error('down'); }, set: async () => { throw new Error('down'); }, del: async () => { throw new Error('down'); } };
  const store = { load: async () => { throw new Error('down'); }, save: async () => { throw new Error('down'); } };
  const d = createDeals({ store, now: () => t, lock: (n, s) => takeLock(down, n, s), defer: (p) => p, days: 60, search: async (p) => { calls++; return [{ id: 'x' + calls, date: '2026-12-01', origin: 'TPE', destination: p.destination_airport.split(',')[0], source: 'aeroplan', cabins: { J: seat(60000), F: { available: false } } }]; } });
  const per = [];
  for (let i = 0; i < 6; i++) { const c = calls; await d.get(); per.push(calls - c); t += 11 * 60e3; }
  assert.deepEqual(per, [8, 0, 0, 0, 0, 0]);
});

test('R9/S5: a manual refresh asks seats.aero afresh, says what it refreshed, and a busy or failed one refreshed nothing', async () => {
  const w = dealsWorld();
  const A = w.mk();
  const r = await A.refresh({ fresh: true });
  assert.deepEqual([r.refreshed, r.failedGroups], [8, 0]);
  assert.ok(w.opts.every((o) => o.fresh === true));
  // Busy: another refresh holds the lock.
  w.locks.set('deals:refresh', Date.parse('2026-10-15T00:00:00Z'));
  const busy = await A.refresh({ fresh: true });
  assert.deepEqual([busy.busy, busy.refreshed], [true, 0]);
  assert.equal(busy.groups.length, 8, 'the saved copy is shown');
  w.locks.clear();
  // Every group failed.
  const F = createDeals({ store: memoryStore(null), defer: (p) => p, days: 60, search: async () => { throw new Error('seats.aero 今日查詢額度已用完'); } });
  const f = await F.refresh({ fresh: true });
  assert.deepEqual([f.failed, f.refreshed], [true, 0]);
  // A group is stamped with when its rows were fetched.
  const at = Date.parse('2026-10-14T23:50:00Z');
  const S = createDeals({ store: memoryStore(null), defer: (p) => p, days: 60, search: async () => Object.assign([], { fetchedAt: at }) });
  assert.equal((await S.refresh()).groups[0].at, new Date(at).toISOString());
});

test('R9/S5: get({ atLeast }) reads the store again when this instance remembers an older copy', async () => {
  const w = dealsWorld();
  const A = w.mk();
  const B = w.mk();
  await A.refresh({});
  await B.get();
  w.set('2026-10-14T00:25:00Z');
  const fresh = await A.refresh({});
  assert.notEqual((await B.get()).generatedAt, fresh.generatedAt, 'within 10 minutes B serves its memory');
  assert.equal((await B.get({ atLeast: fresh.generatedAt })).generatedAt, fresh.generatedAt);
});

test('S2: /api/history and /api/cxcal read their routes with one store command', async () => {
  const counting = () => {
    const kv = memoryKv();
    const n = { get: 0, mget: 0, keys: 0 };
    return { n, kv: { ...kv, get: (k) => { n.get++; return kv.get(k); }, mget: (ks) => { n.mget++; n.keys += ks.length; return kv.mget(ks); }, set: kv.set, del: kv.del } };
  };
  const ten = 'AAA,BBB,CCC,DDD,EEE,FFF,GGG,HHH,III,JJJ';
  const h = counting();
  await h.kv.set('hist:v1:AAA-BBB', { obs: [20000], r: {} });
  const hist = createHistory({ kv: h.kv });
  await hist.get(ten, ten);
  assert.deepEqual([h.n.get, h.n.mget], [0, 1]);
  assert.ok(h.n.keys <= 25);
  const c = counting();
  const cx = createCxcalStore({ kv: c.kv });
  await cx.find(ten, ten);
  assert.deepEqual([c.n.get, c.n.mget], [1, 1], 'the index and one MGET');
});
