// Fixes from the 2026-10-14 audit: watch/alert races and false drops, deals that survive a failed refresh, the directs
// cache and budget, date checks, quota reading, Taiwan time, cache headers, the data bundle and the cron's credentials.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
delete process.env.SEATS_AERO_API_KEY;
delete process.env.CASH_PASSCODE;
delete process.env.CRON_SECRET;
const { server } = require('../server');
const { memoryStore } = require('../lib/alerts');
const { memoryKv, sharedCache } = require('../lib/kv');
const { todayTW, validDate } = require('../lib/day');

let base;
const isoIn = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());
const withEnv = async (env, fn) => {
  const old = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try { return await fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

test('B1: a picked flight that is missing is not a drop and does not move the reference price', async () => {
  const { createPriceWatch } = require('../lib/pricewatch');
  const day = isoIn(10);
  let clock = Date.now();
  let prices = { BR198: 30000, MM620: 18000 };
  const opt = (fn) => ({ price: prices[fn], segments: [{ flightNumber: fn.replace(/(\d)/, ' $1') }] });
  const mails = [];
  const w = createPriceWatch({ store: memoryStore(null), now: () => clock, search: async () => ({ options: Object.keys(prices).map(opt) }), sendEmail: async (m) => mails.push(m) });
  const { watch } = await w.add({ origin: 'TPE', destination: 'NRT', depart: day, cabin: 'Y', flights: 'BR198', email: 'a@b.co', price: 30000, lowest: 18000 });
  clock += 864e5;
  prices = { MM620: 18000 }; // BR198 sold out or not in this answer
  let r = await w.run();
  assert.deepEqual(r.report[0], { id: watch.id, price: null, pickedGone: true, lowest: 18000 });
  assert.equal(mails.length, 0, 'no "你追蹤的航班降價了" for another airline');
  let list = (await w.list()).watches[0];
  assert.equal(list.lastPrice, 30000);
  assert.equal(list.pickedGone, true);
  clock += 864e5;
  prices = { BR198: 25000, MM620: 18000 }; // back, and NT$5,000 cheaper: a real drop
  r = await w.run();
  assert.equal(r.report[0].dropped, true);
  assert.equal(r.report[0].mailed, true);
  assert.match(mails[0].subject, /25,000/);
  list = (await w.list()).watches[0];
  assert.equal(list.pickedGone, false);
});

test('B1: a watch started while its flights were not on sale takes the first seen price as the baseline', async () => {
  const { createPriceWatch } = require('../lib/pricewatch');
  let clock = Date.now();
  let prices = { CI100: 18000 };
  const mails = [];
  const w = createPriceWatch({ store: memoryStore(null), now: () => clock, search: async () => ({ options: Object.entries(prices).map(([fn, price]) => ({ price, segments: [{ flightNumber: fn }] })) }), sendEmail: async (m) => mails.push(m) });
  const { watch } = await w.add({ origin: 'TPE', destination: 'NRT', depart: isoIn(5), cabin: 'Y', flights: 'BR198', email: 'a@b.co' });
  assert.equal(watch.lastPrice, null);
  clock += 864e5;
  prices = { BR198: 30000, CI100: 18000 };
  let r = await w.run();
  assert.deepEqual([r.report[0].price, r.report[0].dropped, mails.length], [30000, false, 0]);
  clock += 864e5;
  prices = { BR198: 27000 };
  r = await w.run();
  assert.equal(r.report[0].mailed, true);
});

test('B2: watches added or deleted while a run is checking are kept as they are', async () => {
  const { createPriceWatch } = require('../lib/pricewatch');
  let clock = Date.now();
  const gate = deferred();
  const started = deferred();
  let first = true;
  const w = createPriceWatch({ store: memoryStore(null), now: () => clock, search: async () => {
    if (first) { first = false; started.resolve(); await gate.promise; }
    return { options: [{ price: 9000, segments: [] }] };
  } });
  const a = (await w.add({ origin: 'TPE', destination: 'NRT', depart: isoIn(5), price: 10000 })).watch;
  const b = (await w.add({ origin: 'TPE', destination: 'BKK', depart: isoIn(5), price: 10000 })).watch;
  clock += 864e5;
  const run = w.run();
  await started.promise;
  await w.remove(b.id); // deleted while A is being checked
  const c = (await w.add({ origin: 'TPE', destination: 'KIX', depart: isoIn(5), price: 10000 })).watch;
  gate.resolve();
  const r = await run;
  const ids = (await w.list()).watches.map((x) => x.id);
  assert.deepEqual(ids.sort(), [a.id, c.id].sort());
  assert.ok(r.report.some((x) => x.id === b.id && x.deleted));
  assert.equal((await w.list()).watches.find((x) => x.id === a.id).lastPrice, 9000, 'the checked watch got its new price');
});

test('B2: seat alerts merge by id too, mark seen only once mailed and skip what the cron already did today', async () => {
  const { createAlerts } = require('../lib/alerts');
  const row = (id) => ({ id, date: '2099-01-02', origin: 'TPE', destination: 'NRT', source: 'aeroplan', cabins: { J: { available: true, miles: 30000, seats: 2, airlines: 'BR', direct: true } } });
  let rows = [row('a')];
  const gate = deferred();
  const started = deferred();
  let hold = false;
  const mails = [];
  const store = memoryStore();
  let mailDown = true;
  const al = createAlerts({ store, search: async () => { if (hold) { hold = false; started.resolve(); await gate.promise; } return rows; }, sendEmail: async (m) => { mails.push(m); if (mailDown) throw new Error('mail down'); } });
  const x = (await al.add({ origin: 'TPE', destination: 'NRT', start: '2099-01-01', end: '2099-01-05', cabin: 'J', email: 'a@b.co' })).alert;
  const y = (await al.add({ origin: 'TPE', destination: 'NRT', start: '2099-02-01', end: '2099-02-05', cabin: 'J' })).alert;
  rows = [row('a'), row('b')];
  hold = true;
  const run = al.run();
  await started.promise;
  await al.remove(y.id);
  const z = (await al.add({ origin: 'TPE', destination: 'KIX', start: '2099-03-01', end: '2099-03-05', cabin: 'J' })).alert;
  gate.resolve();
  const r = await run;
  assert.deepEqual((await al.list()).map((a) => a.id).sort(), [x.id, z.id].sort());
  const rx = r.report.find((e) => e.id === x.id);
  assert.deepEqual([rx.fresh, rx.mailed, rx.mailError, rx.retry], [1, false, 'mail down', true]);
  // The mail failed, so 'b' is still news on the next run; once it is mailed it is seen.
  mailDown = false;
  const again = (await al.run()).report.find((e) => e.id === x.id);
  assert.deepEqual([again.fresh, again.mailed, again.retry], [1, true, undefined]);
  assert.equal((await al.run()).report.find((e) => e.id === x.id).fresh, 0);
  const cron = await al.run({ force: false });
  assert.ok(cron.report.every((e) => e.skipped === 'done-today'), 'the cron skips watches checked today');
  // Two runs at once: the second one waits its turn instead of mailing twice.
  const busy = await al.run({ lock: async () => null });
  assert.equal(busy.busy, true);
});

test('B4: a failed refresh keeps the last good deals; a refresh where everything fails saves nothing', async () => {
  const { createDeals } = require('../lib/deals');
  const store = memoryStore(null);
  const row = (dest, miles) => ({ id: dest + miles, origin: 'TPE', destination: dest, date: isoIn(30), source: 'aeroplan', updatedAt: '', cabins: { J: { available: true, miles }, F: { available: true, miles: miles * 2 } } });
  let fail = () => false;
  let calls = 0;
  let clock = Date.now();
  const search = async (p) => { calls++; if (fail(p)) throw new Error('seats.aero 今日查詢額度已用完'); return [row(p.destination_airport.split(',')[0], 50000)]; };
  const deals = createDeals({ store, search, now: () => clock, days: 30 });
  const good = await deals.refresh();
  assert.equal(good.groups.filter((g) => g.items.length).length, deals.plan);
  clock += 864e5;
  fail = (p) => p.destination_airport.startsWith('YVR'); // one region fails
  const part = await deals.refresh();
  const na = part.groups.find((g) => g.id === 'na' && g.cabin === 'J');
  assert.equal(na.items.length, 1, 'kept the previous items');
  assert.ok(na.stale && na.error);
  assert.ok(!part.groups.find((g) => g.id === 'eu' && g.cabin === 'J').error);
  const savedBefore = JSON.stringify(await store.load());
  fail = () => true;
  const all = await deals.refresh();
  assert.equal(all.failed, true);
  assert.equal(JSON.stringify(await store.load()), savedBefore, 'nothing saved when every group failed');
  assert.ok(all.groups.every((g) => g.items.length === 1), 'still serving the old items');
  // Groups fetched in the last 20 hours are not fetched again by a second run.
  fail = () => false;
  calls = 0;
  await deals.refresh({ skipFresh: true });
  assert.equal(calls, 2, 'only the groups whose last saved fetch failed (North America J and F)');
  calls = 0;
  await deals.refresh({ skipFresh: true });
  assert.equal(calls, 0);
});

test('B4/P10: visitors get the saved deals at once, an old copy is refreshed in the background', async () => {
  const { createDeals } = require('../lib/deals');
  const old = { generatedAt: new Date(Date.now() - 3 * 864e5).toISOString(), origin: 'TPE', groups: [{ id: 'na', name: '北美', cabin: 'J', items: [{ destination: 'YVR', miles: 1 }] }] };
  let calls = 0;
  const bg = [];
  const gate = deferred();
  const deals = createDeals({ store: memoryStore(old), search: async () => { calls++; await gate.promise; return []; }, defer: (p) => bg.push(p), lock: async () => () => {} });
  const d = await deals.get();
  assert.equal(d.generatedAt, old.generatedAt);
  assert.ok(calls <= 1, 'answered while seats.aero is still busy');
  assert.equal(bg.length, 1);
  gate.resolve();
  await bg[0];
  assert.ok(calls > 0);
});

test('B5/P11: directs keep one entry per airport, so parallel lookups all survive', async () => {
  const { createDirects } = require('../lib/aerodatabox');
  const kv = memoryKv();
  let calls = 0;
  const fetchImpl = async (url) => {
    calls++;
    const from = String(url).match(/iata\/(\w{3})\//)[1];
    await new Promise((r) => setTimeout(r, 5));
    return new Response(JSON.stringify({ routes: [{ destination: { iata: 'NRT' }, averageDailyFlights: from === 'TPE' ? 9 : 2, operators: [{ name: 'EVA Air' }] }] }));
  };
  const d = createDirects({ apiKey: 'k', fetchImpl, kv });
  await d.between(['TPE', 'TSA', 'KHH'], ['NRT']);
  assert.equal(calls, 3);
  for (const o of ['TPE', 'TSA', 'KHH']) assert.ok(await kv.get(`directs:v1:${o}`), o);
  const fresh = createDirects({ apiKey: 'k', fetchImpl, kv });
  assert.equal((await fresh.between(['TPE', 'TSA', 'KHH'], ['NRT'])).perDay, 13);
  assert.equal(calls, 3, 'a new instance spends nothing');
  // Airports saved in the old single-blob store are moved over instead of being bought again.
  const legacy = memoryStore({ RMQ: { at: Date.now(), routes: [{ to: 'NRT', perDay: 1, airlines: [] }] } });
  const moved = createDirects({ apiKey: 'k', fetchImpl, kv, legacy });
  assert.equal((await moved.between(['RMQ'], ['NRT'])).perDay, 1);
  assert.equal(calls, 3);
  assert.ok(await kv.get('directs:v1:RMQ'));
});

test('B6: directs only buys airports it may, and stops at the monthly reserve', async () => {
  const { createDirects } = require('../lib/aerodatabox');
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response(JSON.stringify({ routes: [] })); };
  let budget = 12;
  const spend = async (n) => { if (budget - n < 0) return false; budget -= n; return true; };
  const d = createDirects({ apiKey: 'k', fetchImpl, kv: memoryKv(), spend });
  const open = new Set(['TPE', 'TSA', 'KHH']);
  await assert.rejects(d.between(['LAX'], ['NRT'], { canFetch: (o) => open.has(o) }), (e) => e.locked === true);
  assert.equal(calls, 0);
  await d.between(['TPE', 'TSA'], ['NRT'], { canFetch: (o) => open.has(o) });
  assert.equal(calls, 2);
  await assert.rejects(d.between(['KHH'], ['NRT'], { canFetch: () => true }), /額度快用完/);
  assert.equal(calls, 2);
  // Once cached, any airport is served, passcode or not.
  assert.deepEqual((await d.between(['TPE'], ['NRT'], { canFetch: () => false })).airlines, []);
});

test('B7: impossible dates are a 400 before any upstream call', async () => {
  assert.equal(validDate('2026-02-28'), true);
  for (const s of ['2026-13-45', '2027-02-31', '2026-02-29', '2026-1-01']) assert.equal(validDate(s), false, s);
  for (const u of [
    '/api/search?origin=TPE&destination=NRT&start=2026-13-45',
    '/api/search?origin=TPE&destination=NRT&start=2026-11-01&end=2027-02-31',
    '/api/hotels/cash?name=X&checkin=2026-13-01&checkout=2026-13-05',
    '/api/cash?origin=TPE&destination=NRT&depart=2026-12-32',
    '/api/cash/calendar?origin=TPE&destination=NRT&start=2026-11-31',
    '/api/trip-info?to=NRT&start=2026-04-31',
  ]) assert.equal((await fetch(base + u)).status, 400, u);
  const { createAlerts } = require('../lib/alerts');
  await assert.rejects(createAlerts({ store: memoryStore(), search: async () => [] }).add({ origin: 'TPE', destination: 'NRT', start: '2099-02-30' }), /日期格式錯誤/);
});

test('B8: a RapidAPI 429 without quota headers is "too fast", not "quota used up"', async () => {
  const { createRapidFlights } = require('../lib/rapidflights');
  const seen = [];
  const q = createRapidFlights({ apiKey: 'k', onQuota: (x) => seen.push(x), fetchImpl: async () => new Response(JSON.stringify({ message: 'Too many requests' }), { status: 429 }) });
  await assert.rejects(q({ departure_id: 'TPE', arrival_id: 'NRT', outbound_date: '2026-11-01', travel_class: 1, adults: 1 }), (e) => e.status === 429 && !e.quota && /太頻繁/.test(e.message));
  assert.deepEqual(seen, []);
  const zero = createRapidFlights({ apiKey: 'k', onQuota: (x) => seen.push(x), fetchImpl: async () => new Response('{}', { status: 429, headers: { 'x-ratelimit-requests-remaining': '0', 'x-ratelimit-requests-limit': '150' } }) });
  await assert.rejects(zero({ departure_id: 'TPE', arrival_id: 'NRT', outbound_date: '2026-11-01', travel_class: 1, adults: 1 }), (e) => e.quota === true);
  assert.deepEqual(seen, [{ left: 0, limit: 150 }]);
});

test('B11: "today" is Taiwan time; a trip leaving today is no longer checked', async () => {
  assert.equal(todayTW(Date.parse('2026-12-20T23:00:00Z')), '2026-12-21');
  assert.equal(todayTW(Date.parse('2026-12-20T15:59:00Z')), '2026-12-20');
  const { createPriceWatch } = require('../lib/pricewatch');
  // Added on 12/18, Taiwan time; checked by the cron at 07:00 on 12/21 (23:00 UTC on 12/20).
  let clock = Date.parse('2026-12-18T02:00:00Z');
  let calls = 0;
  const w = createPriceWatch({ store: memoryStore(null), now: () => clock, search: async () => { calls++; return { options: [{ price: 1000, segments: [] }] }; } });
  await w.add({ origin: 'TPE', destination: 'NRT', depart: '2026-12-20', price: 5000 });
  clock = Date.parse('2026-12-20T23:00:00Z');
  const r = await w.run();
  assert.equal(calls, 0, 'no credit spent on a flight that already left');
  assert.equal(r.report[0].expired, true);
});

test('B13: a calendar that rejects round trips is asked one-way from then on', async () => {
  const { createRapidFlights } = require('../lib/rapidflights');
  const kv = memoryKv();
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(String(url));
    if (/trip_type=ROUND/.test(String(url))) return new Response(JSON.stringify({ status: false, message: 'Something went wrong' }));
    return new Response(JSON.stringify({ status: true, data: [{ departure: '2026-11-01', price: 9000 }] }));
  };
  const p = { departure_id: 'TPE', arrival_id: 'NRT', start_date: '2026-11-01', end_date: '2026-11-30', trip_days: 5, travel_class: 1, adults: 1 };
  await createRapidFlights({ apiKey: 'k', fetchImpl, kv }).calendar(p);
  assert.equal(seen.length, 2);
  // Another instance learns it from the shared store.
  const other = await createRapidFlights({ apiKey: 'k', fetchImpl, kv }).calendar(p);
  assert.equal(seen.length, 3);
  assert.doesNotMatch(seen[2], /ROUND/);
  assert.equal(other.round, false);
});

test('B15/B18: Booking.com never shows another hotel\'s price, and remembers hotel ids', async () => {
  const { bookingHotels } = require('../lib/hotelcash');
  const paths = [];
  let detail = { hotel_name: 'Tokyo Marriott Hotel', soldout: 1 };
  const kv = memoryKv();
  const lookup = bookingHotels({ apiKey: 'r', kv, fetchImpl: async (url) => {
    const u = new URL(String(url));
    paths.push(u.pathname);
    if (u.pathname === '/stays/auto-complete') return Response.json({ status: true, data: [{ id: Buffer.from(JSON.stringify({ dest_id: '123', dest_type: 'hotel' })).toString('base64'), name: 'Tokyo Marriott Hotel', latitude: 35.6205, longitude: 139.7372 }] });
    assert.equal(u.searchParams.get('hotelId'), '123');
    return Response.json({ status: true, data: detail });
  } });
  const want = { name: 'Tokyo Marriott Hotel', checkin: '2026-11-01', checkout: '2026-11-03', adults: 2, lat: 35.6206, lon: 139.7373 };
  const sold = await lookup(want);
  assert.deepEqual([sold.found, sold.soldOut, sold.total, sold.name], [true, true, null, 'Tokyo Marriott Hotel']);
  detail = { hotel_name: 'Tokyo Marriott Hotel', composite_price_breakdown: { gross_amount: { value: 21000, currency: 'TWD' } } };
  const ok = await lookup(want);
  assert.deepEqual([ok.total, ok.currency, ok.requests], [21000, 'TWD', 1], 'the id came from the cache');
  assert.deepEqual(paths, ['/stays/auto-complete', '/stays/detail', '/stays/detail']);
});

test('B17: rooms.aero minor units follow each currency\'s ISO 4217 exponent', () => {
  const { money, minorExponent } = require('../lib/rooms');
  assert.deepEqual(money(12345, 'USD'), { amount: 123.45, currency: 'USD' });
  assert.deepEqual(money(1850000, 'JPY'), { amount: 1850000, currency: 'JPY' });
  assert.deepEqual(money(250000, 'krw'), { amount: 250000, currency: 'KRW' });
  assert.deepEqual(money(3500000, 'VND'), { amount: 3500000, currency: 'VND' });
  assert.deepEqual(money(45250, 'KWD'), { amount: 45.25, currency: 'KWD' });
  assert.equal(money(0, 'USD'), null);
  assert.deepEqual([minorExponent('TWD'), minorExponent('IDR'), minorExponent('EUR'), minorExponent('')], [2, 2, 2, 2]);
  const { normalizeSearch } = require('../lib/rooms');
  const s = normalizeSearch({ data: [{ hotel: { id: 'h' }, lowest_award_standard: 50000, lowest_cash_standard: 3200000, currency_code: 'JPY' }] });
  assert.equal(s.hotels[0].standard.cash.amount, 3200000);
});

test('B16: an oversized body is refused without keeping it', async () => {
  const res = await fetch(`${base}/api/alerts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ origin: 'TPE', pad: 'x'.repeat(200_000) }) });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /內容太長/);
});

test('cron run needs CRON_SECRET or the passcode, even without a passcode set', async () => {
  // Demo mode with nothing configured: allowed (it spends nothing).
  assert.equal((await fetch(`${base}/api/alerts/run?part=alerts`)).status, 200);
  await withEnv({ CRON_SECRET: 'tick' }, async () => {
    assert.equal((await fetch(`${base}/api/alerts/run`)).status, 401, 'no passcode set is not an open door');
    assert.equal((await fetch(`${base}/api/alerts/run`, { headers: { authorization: 'Bearer tock' } })).status, 401);
    const ok = await fetch(`${base}/api/alerts/run`, { headers: { authorization: 'Bearer tick' } });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.by, 'cron');
    assert.ok(Array.isArray(body.report));
    assert.equal(ok.headers.get('cache-control'), 'no-store');
  });
  await withEnv({ CASH_PASSCODE: 'pw' }, async () => {
    assert.equal((await fetch(`${base}/api/alerts/run`)).status, 401);
    const r = await fetch(`${base}/api/alerts/run?part=alerts`, { headers: { 'x-cash-pass': 'pw' } });
    assert.equal((await r.json()).by, 'owner');
  });
});

test('cache headers: public answers go to the CDN, passcode-gated ones never do', async () => {
  const cc = async (u, opts) => (await fetch(base + u, opts)).headers.get('cache-control');
  for (const u of [`/api/search?origin=TPE&destination=NRT&start=${isoIn(10)}`, `/api/explore?program=aeroplan&start=${isoIn(10)}`, '/api/fx', '/api/deals', `/api/directs?from=TPE&to=NRT`]) {
    assert.match(await cc(u), /public.*s-maxage=\d+/, u);
  }
  await withEnv({ CASH_PASSCODE: 'pw' }, async () => {
    const h = { headers: { 'x-cash-pass': 'pw' } };
    for (const u of [`/api/cash?origin=TPE&destination=NRT&depart=${isoIn(20)}`, `/api/cash/calendar?origin=TPE&destination=NRT&start=${isoIn(10)}&end=${isoIn(20)}`, '/api/cash/quota', `/api/hotels/cash?name=Tokyo%20Marriott&checkin=${isoIn(20)}&checkout=${isoIn(22)}`, '/api/watch', '/api/alerts']) {
      assert.equal(await cc(u, h), 'no-store', u);
    }
  });
  assert.equal(await cc('/api/search?origin=TP&destination=NRT&start=2026-11-01'), 'no-store', 'errors are not cached');
});

test('P01/P09: the in-instance cache shares in-flight calls; the shared cache spends a paid lookup once', async () => {
  const { cached } = require('../server');
  let n = 0;
  const slow = () => new Promise((r) => setTimeout(() => r(++n), 20));
  const [a, b] = await Promise.all([cached('t:coalesce', slow), cached('t:coalesce', slow)]);
  assert.deepEqual([a, b, n], [1, 1, 1]);
  await assert.rejects(cached('t:err', async () => { throw new Error('x'); }));
  assert.equal(await cached('t:err', async () => 'ok'), 'ok', 'a failure is not kept');
  const kv = memoryKv();
  let spent = 0;
  const lookup = () => new Promise((r) => setTimeout(() => r({ price: ++spent }), 30));
  // Two instances (no shared in-memory cache) asking the same thing at once.
  const [x, y] = await Promise.all([sharedCache(kv, 'cash:{"q":1}', 60, lookup, { pollMs: 10 }), sharedCache(kv, 'cash:{"q":1}', 60, lookup, { pollMs: 10 })]);
  assert.deepEqual([x, y, spent], [{ price: 1 }, { price: 1 }, 1]);
  assert.deepEqual(await sharedCache(kv, 'cash:{"q":1}', 60, lookup), { price: 1 });
  assert.equal(spent, 1);
});

test('P02: /api/data/all bundles exactly the data files, cacheable for good per version', async () => {
  const names = ['airlines', 'alliances', 'airports', 'programs', 'glossary', 'asiamiles', 'sourcenames', 'points', 'booking', 'charts', 'products', 'promos', 'airlinenames', 'airportnames', 'expiry', 'buymiles', 'changes', 'fees', 'holds', 'milecost', 'upgrades', 'callcenters'];
  const res = await fetch(`${base}/api/data/all`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=300, s-maxage=3600');
  const all = await res.json();
  assert.deepEqual(Object.keys(all), names);
  for (const n of ['airlines', 'sourcenames', 'promos', 'airlinenames']) assert.deepEqual(all[n], await (await fetch(`${base}/api/data/${n}`)).json(), n);
  const v = require('../data/version.json').version;
  const imm = await fetch(`${base}/api/data/all?v=${v}`);
  assert.equal(imm.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal((await fetch(`${base}/api/data/all?v=0.0.1`)).headers.get('cache-control'), 'public, max-age=300, s-maxage=3600');
  const etag = res.headers.get('etag');
  assert.ok(etag);
  assert.equal((await fetch(`${base}/api/data/all`, { headers: { 'if-none-match': etag } })).status, 304);
  const head = await fetch(`${base}/api/data/airlines`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.ok(Number(head.headers.get('content-length')) > 100);
  assert.equal((await fetch(`${base}/api/search`, { method: 'HEAD' })).status, 405);
});

test('C10: the data comes in two bundles, core (first screen) and more, that together make up all', async () => {
  const v = require('../data/version.json').version;
  const all = await (await fetch(`${base}/api/data/all`)).json();
  const core = await fetch(`${base}/api/data/core?v=${v}`);
  assert.equal(core.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  const coreBody = await core.json();
  const more = await (await fetch(`${base}/api/data/more`)).json();
  assert.deepEqual(Object.keys(coreBody), ['airlines', 'alliances', 'airports', 'sourcenames', 'airlinenames', 'airportnames']);
  assert.deepEqual([...Object.keys(coreBody), ...Object.keys(more)].sort(), Object.keys(all).sort(), 'no file missing or in both');
  for (const n of Object.keys(more)) assert.deepEqual(more[n], all[n], n);
  assert.ok(coreBody.airportnames.names.TPE, 'Chinese airport names for chips and cards before the full list loads');
  // The first screen's bundle stays small (the whole bundle is about 200 KB).
  assert.ok(JSON.stringify(coreBody).length < 40_000, `core is ${JSON.stringify(coreBody).length} bytes`);
  assert.equal((await fetch(`${base}/api/data/core`)).headers.get('cache-control'), 'public, max-age=300, s-maxage=3600');
});

test('C10: index.html preloads the core bundle at the same version as its scripts', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const versions = new Set([...html.matchAll(/\?v=([\w.-]+)/g)].map((m) => m[1]));
  assert.equal(versions.size, 1, `one version in every ?v= (${[...versions]})`);
  assert.match(html, /<link rel="preload" as="fetch" href="\/api\/data\/core\?v=[\w.-]+" crossorigin>/);
  assert.doesNotMatch(html, /wght@[\d;]*500/, 'the web font loads two weights');
});

test('P02: static files carry validators and a cache policy, and answer HEAD', async () => {
  const js = await fetch(`${base}/app.js`);
  assert.equal(js.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
  const etag = js.headers.get('etag');
  assert.ok(etag && js.headers.get('last-modified'));
  assert.equal((await fetch(`${base}/app.js`, { headers: { 'if-none-match': etag } })).status, 304);
  assert.equal((await fetch(`${base}/app.js?v=1.15.0`)).headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.match((await fetch(`${base}/airports.min.json`, { method: 'HEAD' })).headers.get('cache-control'), /max-age=86400, stale-while-revalidate=604800/);
  assert.match((await fetch(`${base}/icon-192.png`)).headers.get('cache-control'), /max-age=86400/);
  assert.equal((await fetch(`${base}/`)).headers.get('cache-control'), 'no-cache');
  assert.equal((await fetch(`${base}/some/page`)).headers.get('content-type'), 'text/html; charset=utf-8');
});

test('P06: a search only carries details for cabins that have seats', async () => {
  const body = await (await fetch(`${base}/api/search?origin=TPE&destination=YVR&start=2026-11-01&end=2026-11-20`)).json();
  const all = body.results.flatMap((r) => Object.values(r.cabins));
  assert.ok(all.some((c) => !c.available));
  assert.ok(all.filter((c) => !c.available).every((c) => Object.keys(c).length === 1));
  assert.ok(body.results.every((r) => ['Y', 'W', 'J', 'F'].every((k) => r.cabins[k])), 'every cabin key is still there');
});

test('P08: SerpApi credits are counted for the quota line', async () => {
  const q = await (await fetch(`${base}/api/cash/quota`)).json();
  assert.equal(typeof q.serpapi.used, 'number');
});
