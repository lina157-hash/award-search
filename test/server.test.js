const { test, before, after } = require('node:test');
const assert = require('node:assert');
delete process.env.SEATS_AERO_API_KEY;
const { server } = require('../server');
const { normalizeAvailability, createClient } = require('../lib/seats');
const { createCashClient, normalizeCash } = require('../lib/cash');

let base;
const isoIn = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

test('search returns normalized demo results', async () => {
  const res = await fetch(`${base}/api/search?origin=TPE&destination=YVR&start=2026-11-01&end=2026-11-03&cabin=J`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.mock, true);
  assert.ok(body.results.length > 0);
  assert.ok(body.results.every((r) => r.origin === 'TPE' && r.destination === 'YVR' && r.cabins.J));
});

test('search rejects bad input', async () => {
  for (const q of ['origin=TP&destination=YVR&start=2026-11-01', 'origin=TPE&destination=YVR&start=2026-11-05&end=2026-11-01', 'origin=TPE&destination=YVR&start=2026-11-01&end=2027-11-03']) {
    assert.equal((await fetch(`${base}/api/search?${q}`)).status, 400, q);
  }
});

test('search accepts a date range of up to a year', async () => {
  const res = await fetch(`${base}/api/search?origin=TPE&destination=YVR&start=2026-11-01&end=2027-11-01`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.truncated, false);
  assert.ok(body.results.some((r) => r.date > '2027-10-01'));
});

test('search includes lowest taxes per cabin for short ranges only', async () => {
  const short = await (await fetch(`${base}/api/search?origin=TPE&destination=YVR&start=2026-11-01&end=2026-11-03`)).json();
  assert.equal(short.withTaxes, true);
  const j = short.results.find((r) => r.cabins.J.available);
  assert.ok(j.cabins.J.taxes.amount > 0);
  assert.equal(j.cabins.J.taxes.currency, 'TWD');
  const long = await (await fetch(`${base}/api/search?origin=TPE&destination=YVR&start=2026-11-01&end=2027-03-01`)).json();
  assert.equal(long.withTaxes, false);
  assert.equal(long.results[0].cabins.J.taxes, null);
});

test('cash lookups require the passcode when one is set', async () => {
  process.env.CASH_PASSCODE = 'sunny';
  try {
    const q = 'origin=TPE&destination=NRT&depart=2026-11-20';
    const locked = await fetch(`${base}/api/cash?${q}`);
    assert.equal(locked.status, 401);
    assert.equal((await locked.json()).code, 'passcode');
    const wrong = await fetch(`${base}/api/cash?${q}`, { headers: { 'x-cash-pass': 'sunny!' } });
    assert.equal(wrong.status, 401);
    const ok = await fetch(`${base}/api/cash?${q}`, { headers: { 'x-cash-pass': 'sunny' } });
    assert.equal(ok.status, 200);
    assert.equal((await (await fetch(`${base}/api/config`)).json()).cashLocked, true);
  } finally {
    delete process.env.CASH_PASSCODE;
  }
  assert.equal((await (await fetch(`${base}/api/config`)).json()).cashLocked, false);
});

test('fx endpoint returns TWD rates', async () => {
  const fx = await (await fetch(`${base}/api/fx`)).json();
  assert.equal(fx.rates.TWD, 1);
  assert.ok(fx.rates.USD > 20 && fx.rates.USD < 45);
});

test('alerts: add takes a baseline, run reports and mails only new seats', async () => {
  const { createAlerts, memoryStore } = require('../lib/alerts');
  const row = (id, date, seats = 2) => ({ id, date, origin: 'TPE', destination: 'YVR', source: 'aeroplan', cabins: { J: { available: true, miles: 75000, seats, airlines: 'AC', direct: true } } });
  let rows = [row('a', '2026-12-01')];
  const mails = [];
  const al = createAlerts({ store: memoryStore(), search: async () => rows, sendEmail: async (m) => mails.push(m), siteUrl: 'https://x.test', programNames: { aeroplan: '加航 Aeroplan' } });
  const added = await al.add({ origin: 'tpe', destination: 'YVR', start: '2026-12-01', end: '2026-12-10', cabin: 'J', pax: 2, email: 'me@example.com' });
  assert.equal(added.found, 1);
  assert.equal((await al.list())[0].seenCount, 1);
  let r = await al.run();
  assert.deepEqual(r.report[0], { id: added.alert.id, found: 1, fresh: 0, mailed: false });
  rows = [row('a', '2026-12-01'), row('b', '2026-12-03'), row('c', '2026-12-04', 1)];
  r = await al.run();
  assert.deepEqual(r.report[0], { id: added.alert.id, found: 2, fresh: 1, mailed: true });
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /新增 1 筆/);
  assert.match(mails[0].html, /加航 Aeroplan/);
  await assert.rejects(al.add({ origin: 'TPE', destination: 'YVR', start: '2020-01-01', cabin: 'J' }), /日期已經過了/);
  await al.remove(added.alert.id);
  assert.equal((await al.list()).length, 0);
});

test('alerts endpoints work in demo mode and honour the passcode', async () => {
  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.equal(cfg.alerts.store, true);
  const res = await fetch(`${base}/api/alerts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ origin: 'TPE', destination: 'YVR', start: '2026-12-01', end: '2026-12-05', cabin: 'J' }) });
  assert.equal(res.status, 200);
  const { alert, found } = await res.json();
  assert.ok(found > 0);
  process.env.CASH_PASSCODE = 'sunny';
  try {
    assert.equal((await fetch(`${base}/api/alerts`)).status, 401);
    const run = await (await fetch(`${base}/api/alerts/run`, { headers: { 'x-cash-pass': 'sunny' } })).json();
    assert.equal(run.checked, 1);
    assert.equal(run.report[0].fresh, 0);
    process.env.CRON_SECRET = 'cron';
    assert.equal((await fetch(`${base}/api/alerts/run`, { headers: { authorization: 'Bearer cron' } })).status, 200);
  } finally {
    delete process.env.CASH_PASSCODE;
    delete process.env.CRON_SECRET;
  }
  assert.equal((await fetch(`${base}/api/alerts?id=${alert.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await (await fetch(`${base}/api/alerts`)).json()).alerts.length, 0);
});

test('trips and data endpoints work', async () => {
  const s = await (await fetch(`${base}/api/search?origin=TPE&destination=CDG&start=2026-11-01`)).json();
  const t = await (await fetch(`${base}/api/trips/${s.results[0].id}`)).json();
  assert.ok(t.trips.length > 0);
  assert.ok(t.trips[0].segments.length > 0);
  for (const n of ['airlines', 'alliances', 'airports', 'programs', 'glossary', 'asiamiles']) {
    assert.equal((await fetch(`${base}/api/data/${n}`)).status, 200);
  }
  assert.equal((await fetch(`${base}/api/data/..%2Fserver`)).status, 404);
});

test('full airport list is served for autocomplete', async () => {
  const res = await fetch(`${base}/airports.min.json`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.airports.length > 3000);
  const byCode = new Map(body.airports.map((r) => [r[0], r]));
  for (const code of ['TPE', 'TSA', 'KHH', 'RMQ', 'MZG', 'KNH', 'HKG', 'NRT', 'HND', 'YVR', 'CDG', 'LHR', 'JFK', 'SYD', 'GRU', 'JNB']) assert.ok(byCode.has(code), code);
  assert.equal(byCode.get('TPE')[6], '台北桃園');
  assert.deepEqual(body.groups.find((g) => g.zh === '東京').codes, ['NRT', 'HND']);
});

test('cash fares: demo search, return leg and validation', async () => {
  const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  const body = await (await fetch(`${base}/api/cash?origin=TPE,TSA&destination=NRT&depart=${day(30)}&return=${day(37)}&cabin=J&alliance=star`)).json();
  assert.equal(body.configured, true);
  assert.ok(body.options.length > 0);
  assert.ok(body.options.every((o) => o.price > 0 && o.segments.length && o.departureToken));
  assert.ok(body.insights.lowest > 0);
  const back = await (await fetch(`${base}/api/cash?origin=TPE,TSA&destination=NRT&depart=${day(30)}&return=${day(37)}&cabin=J&token=${body.options[0].departureToken}`)).json();
  assert.equal(back.returning, true);
  assert.equal(back.options[0].segments[0].from.code, 'NRT');
  assert.ok(back.options.every((o) => o.bookingToken && !o.departureToken));
  const book = await (await fetch(`${base}/api/cash?origin=TPE,TSA&destination=NRT&depart=${day(30)}&return=${day(37)}&cabin=J&booking=${back.options[0].bookingToken}`)).json();
  assert.equal(book.booking, true);
  assert.equal(book.selected.length, 2);
  assert.ok(book.bookingOptions.length >= 2 && book.bookingOptions[0].request.url.startsWith('https://'));
  assert.ok(book.bookingOptions.some((b) => b.phone && !b.request));
  assert.equal((await fetch(`${base}/api/cash?origin=TPE&destination=NRT&depart=${day(30)}&return=${day(37)}&token=a&booking=b`)).status, 400);
  for (const q of [`depart=${day(-2)}`, `depart=${day(10)}&return=${day(5)}`, `depart=${day(10)}&alliance=foo`, `depart=${day(10)}&adults=12`, `depart=${day(10)}&token=abc`]) {
    assert.equal((await fetch(`${base}/api/cash?origin=TPE&destination=NRT&${q}`)).status, 400, q);
  }
});

test('cash client sends SerpApi params and maps errors', async () => {
  let seen;
  const ok = createCashClient({ apiKey: 'k', fetchImpl: async (url) => { seen = new URL(url); return { ok: true, status: 200, json: async () => ({ best_flights: [{ price: 100, flights: [{ departure_airport: { id: 'TPE' }, arrival_airport: { id: 'NRT' } }] }] }) }; } });
  const out = normalizeCash(await ok({ departure_id: 'TPE', arrival_id: 'NRT', type: 2 }));
  assert.equal(seen.searchParams.get('engine'), 'google_flights');
  assert.equal(seen.searchParams.get('api_key'), 'k');
  assert.equal(seen.searchParams.get('currency'), 'TWD');
  assert.equal(out.options[0].segments[0].to.code, 'NRT');
  const bad = createCashClient({ apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
  await assert.rejects(bad({}), /金鑰無效/);
});

test('static path traversal is blocked', async () => {
  const res = await fetch(`${base}/..%2fserver.js`);
  assert.notEqual(await res.text().then((t) => t.includes('SEATS_AERO_API_KEY')), true);
});

test('client sends key header and follows cursor', async () => {
  const calls = [];
  const pages = [
    { data: [{ ID: 'a' }, { ID: 'b' }], hasMore: true, cursor: 123 },
    { data: [{ ID: 'b' }, { ID: 'c' }], hasMore: false, cursor: 123 },
  ];
  const fetchImpl = async (url, opts) => { calls.push({ url: String(url), key: opts.headers['Partner-Authorization'] }); return { ok: true, status: 200, json: async () => pages[calls.length - 1] }; };
  const out = await createClient({ apiKey: 'k', fetchImpl }).search({ origin_airport: 'TPE', destination_airport: 'YVR' });
  assert.deepEqual(out.items.map((x) => x.ID), ['a', 'b', 'c']);
  assert.equal(out.hasMore, false);
  assert.equal(calls[0].key, 'k');
  assert.match(calls[1].url, /cursor=123/);
  assert.match(calls[1].url, /skip=2/);
});

test('config carries a version, an update date and a history', async () => {
  const body = await (await fetch(`${base}/api/config`)).json();
  assert.match(body.version, /^\d+\.\d+\.\d+$/);
  assert.match(body.updated, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Array.isArray(body.history) && body.history.length > 0 && body.history[0].version === body.version);
  const file = require('../data/version.json');
  assert.ok(file.history.every((h) => /^\d+\.\d+\.\d+$/.test(h.version) && /^\d{4}-\d{2}-\d{2}$/.test(h.date) && h.note));
});

test('alerts ask seats.aero for the cabin name, not the stored code', async () => {
  const { createAlerts, memoryStore } = require('../lib/alerts');
  const seen = [];
  const alerts = createAlerts({ store: memoryStore(), search: async (params) => { seen.push(params); return []; } });
  await alerts.add({ origin: 'TPE', destination: 'NRT', start: '2099-01-01', end: '2099-01-05', cabin: 'J' });
  assert.equal(seen[0].cabins, 'business');
  await alerts.run();
  assert.equal(seen[1].cabins, 'business');
});

test('bad input is a 400, not a 500', async () => {
  assert.equal((await fetch(`${base}/api/trips/%E0%A4%A`)).status, 400);
  process.env.CASH_PASSCODE = 'pw';
  try {
    for (const body of ['null', '[1]', '"x"']) {
      const res = await fetch(`${base}/api/alerts`, { method: 'POST', headers: { 'x-cash-pass': 'pw', 'content-type': 'application/json' }, body });
      assert.equal(res.status, 400, body);
    }
  } finally {
    delete process.env.CASH_PASSCODE;
  }
});

test('normalizeAvailability maps cabin fields', () => {
  const n = normalizeAvailability({ ID: 'x', Date: '2026-11-01', Source: 'aeroplan', Route: { OriginAirport: 'TPE', DestinationAirport: 'YVR', Distance: 6000 }, JAvailable: true, JMileageCost: '75000', JRemainingSeats: 2, JAirlines: 'BR', JDirect: true });
  assert.deepEqual(n.cabins.J, { available: true, miles: 75000, seats: 2, airlines: 'BR', direct: true, taxes: null });
  assert.equal(n.cabins.Y.available, false);
});

test('vercel adapter rewrites path back', async () => {
  const handler = require('../api/index');
  const out = await new Promise((resolve) => {
    const req = { method: 'GET', url: '/api/index?__path=search&origin=TPE&destination=YVR&start=2026-11-01' };
    const res = { writeHead(status) { this.status = status; }, end(b) { resolve({ status: this.status, body: JSON.parse(b) }); } };
    handler(req, res);
  });
  assert.equal(out.status, 200);
  assert.ok(out.body.results.length > 0);
});

test('deals keep the cheapest seat per destination and reuse the saved copy', async () => {
  const { createDeals } = require('../lib/deals');
  const { memoryStore } = require('../lib/alerts');
  let calls = 0;
  const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  const row = (dest, date, miles, available = true) => ({ id: `${dest}${date}`, origin: 'TPE', destination: dest, date, source: 'aeroplan', updatedAt: '', cabins: { J: { available, miles, seats: 2, airlines: 'BR', direct: true }, F: null } });
  const search = async (p) => {
    calls += 1;
    assert.equal(p.order_by, 'lowest_mileage');
    return p.destination_airport.includes('YVR') ? [row('YVR', day(10), 80000), row('YVR', day(5), 70000), row('SFO', day(7), 90000), row('LAX', day(8), 50000, false)] : [];
  };
  const deals = createDeals({ store: memoryStore(), search });
  const d = await deals.get();
  assert.equal(calls, deals.plan);
  const na = d.groups.find((g) => g.id === 'na' && g.cabin === 'J');
  assert.deepEqual(na.items.map((i) => [i.destination, i.miles]), [['YVR', 70000], ['SFO', 90000]]);
  await deals.get();
  assert.equal(calls, deals.plan, 'second get is served from memory');
});

test('deals endpoint answers in demo mode', async () => {
  const res = await fetch(`${base}/api/deals`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.groups) && body.groups.some((g) => g.items.length));
});

test('feature data files are served and well formed', async () => {
  const products = await (await fetch(`${base}/api/data/products`)).json();
  assert.ok(products.products.every((p) => p.id && p.name && p.airline && p.cabin && p.iata.length));
  const booking = await (await fetch(`${base}/api/data/booking`)).json();
  for (const [k, p] of Object.entries(booking.programs)) {
    if (p.days != null) assert.ok(Number.isInteger(p.days) && p.days > 0 && p.days <= 366, k);
  }
  assert.equal((await fetch(`${base}/api/data/charts`)).status, 200);
  // Hotel → airline transfers: every partner names a known airline and a positive ratio.
  const points = await (await fetch(`${base}/api/data/points`)).json();
  const toAir = points.calc.hotels.toAir;
  for (const [hotel, h] of Object.entries(toAir.hotels)) {
    assert.ok(points.calc.hotels.programs[hotel], hotel);
    for (const p of h.partners) {
      assert.ok(toAir.airlines[p.to], `${hotel} → ${p.to}`);
      assert.ok(p.hotelPoints > 0 && p.miles > 0, `${hotel} → ${p.to}`);
    }
  }
});

test('price watch mails only after a real drop and tracks the picked flights', async () => {
  const { createPriceWatch } = require('../lib/pricewatch');
  const { memoryStore } = require('../lib/alerts');
  const day = new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10);
  let clock = Date.now();
  let calls = 0;
  let prices = { BR12: 30000, CI4: 28000 };
  const opt = (fn) => ({ price: prices[fn], segments: [{ flightNumber: fn.replace(/(\d)/, ' $1') }] });
  const mails = [];
  const w = createPriceWatch({ store: memoryStore(), now: () => clock, search: async () => { calls += 1; return { options: Object.keys(prices).map(opt) }; }, sendEmail: async (m) => mails.push(m) });
  const { watch } = await w.add({ origin: 'TPE', destination: 'NRT', depart: day, cabin: 'Y', flights: 'BR12', email: 'a@b.co', price: 30000, lowest: 28000 });
  assert.equal(calls, 0, 'starting a watch reuses the fare already on screen');
  assert.equal(watch.lastPrice, 30000);
  await w.run();
  assert.equal(calls, 0, 'not due again on the same day');
  const tomorrow = () => { clock += 864e5; };
  tomorrow();
  prices = { BR12: 29950, CI4: 20000 }; // picked flight barely moved: no mail
  let r = await w.run();
  assert.equal(calls, 1);
  assert.equal(r.report[0].mailed, false);
  tomorrow();
  prices = { BR12: 27000, CI4: 20000 };
  r = await w.run();
  assert.equal(r.report[0].mailed, true);
  assert.match(mails[0].subject, /27,000/);
  tomorrow();
  await w.run(); // same price again: nothing new to say
  assert.equal(mails.length, 1);
  await assert.rejects(w.add({ origin: 'TPE', destination: 'NRT', depart: '2020-01-01' }), /已經過了/);
});

test('price watch spaces checks by trip distance, caps the month and keeps a reserve', async () => {
  const { createPriceWatch, intervalDays } = require('../lib/pricewatch');
  const { memoryStore } = require('../lib/alerts');
  assert.deepEqual([intervalDays(90), intervalDays(30), intervalDays(5)], [7, 3, 1]);
  const far = new Date(Date.now() + 100 * 864e5).toISOString().slice(0, 10);
  let clock = Date.now();
  let calls = 0;
  let left = 500;
  const w = createPriceWatch({ store: memoryStore(), monthlyCap: 2, now: () => clock, quota: async () => left, search: async () => { calls += 1; return { options: [{ price: 50000, segments: [] }] }; } });
  await w.add({ origin: 'TPE', destination: 'LHR', depart: far, cabin: 'J', price: 50000 });
  clock += 3 * 864e5;
  await w.run();
  assert.equal(calls, 0, 'a trip 100 days out is checked weekly');
  clock += 5 * 864e5;
  await w.run();
  assert.equal(calls, 1);
  left = 100; // account is running low
  clock += 8 * 864e5;
  let r = await w.run();
  assert.equal(r.report[0].skipped, 'reserve');
  left = 500;
  await w.run();
  assert.equal(calls, 2);
  clock += 8 * 864e5;
  r = await w.run();
  if (new Date(clock).toISOString().slice(0, 7) === new Date(clock - 16 * 864e5).toISOString().slice(0, 7)) assert.equal(r.report[0].skipped, 'cap');
});

test('price watch endpoint works in demo mode', async () => {
  const day = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  const add = await fetch(`${base}/api/watch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ origin: 'TPE', destination: 'NRT', depart: day, cabin: 'J' }) });
  assert.equal(add.status, 200);
  const { watch } = await add.json();
  assert.ok(watch.lastPrice > 0);
  const list = await (await fetch(`${base}/api/watch`)).json();
  assert.ok(list.watches.some((x) => x.id === watch.id));
  assert.equal((await fetch(`${base}/api/watch?id=${watch.id}`, { method: 'DELETE' })).status, 200);
});

test('RapidAPI Google Flights results are reshaped like SerpApi and filtered locally', async () => {
  const { createRapidFlights, isRapidToken } = require('../lib/rapidflights');
  const seg = (from, to, fn, t1, t2) => ({ departure_airport: { airport_name: from, airport_code: from, time: t1 }, arrival_airport: { airport_name: to, airport_code: to, time: t2 }, duration: { raw: 120, text: '2 hr' }, airline: 'X', flight_number: fn, aircraft: 'Airbus A350', legroom: '31 in', extensions: [] });
  const sample = { status: true, message: 'Success', data: { itineraries: {
    topFlights: [{ duration: { raw: 180 }, flights: [seg('TPE', 'NRT', 'BR 198', '2026-11-1 8:05', '2026-11-1 12:20')], price: 9800, stops: 0, next_token: 'abc=' }],
    otherFlights: [
      { duration: { raw: 400 }, flights: [seg('TPE', 'HKG', 'CX 451', '2026-11-1 7:00', '2026-11-1 9:00'), seg('HKG', 'NRT', 'CX 500', '2026-11-1 11:00', '2026-11-1 16:00')], layovers: [{ airport_code: 'HKG', airport_name: 'Hong Kong', duration: 120 }], price: 'unavailable', stops: 0, next_token: 'def=' },
    ] }, priceHistory: { summary: { current: 9800, typical: [{ operation: '>=', value: 9000 }, { operation: '&&', value: null }, { operation: '<=', value: 12000 }] }, history: [{ time: 1e12, value: 9900 }, { time: 1.0001e12, value: 9800 }] } } };
  const seen = [];
  let quota;
  const q = createRapidFlights({ apiKey: 'k', onQuota: (x) => { quota = x; }, fetchImpl: async (url, opts) => {
    seen.push({ url: String(url), host: opts.headers['x-rapidapi-host'] });
    return new Response(JSON.stringify(sample), { status: 200, headers: { 'x-ratelimit-requests-remaining': '149', 'x-ratelimit-requests-limit': '150' } });
  } });
  const raw = await q({ departure_id: 'TPE', arrival_id: 'NRT', outbound_date: '2026-11-01', return_date: '2026-11-05', travel_class: 3, adults: 1 });
  assert.match(seen[0].url, /searchFlights\?.*travel_class=BUSINESS.*currency=TWD/);
  assert.deepEqual(quota, { left: 149, limit: 150 });
  const n = normalizeCash(raw);
  assert.equal(n.options.length, 2);
  assert.equal(n.options[0].segments[0].from.time, '2026-11-01 08:05');
  assert.equal(n.options[0].segments[0].flightNumber, 'BR 198');
  assert.ok(isRapidToken(n.options[0].departureToken));
  assert.equal(n.options[1].price, null, '"unavailable" becomes no price');
  assert.equal(n.insights.level, 'typical');
  // Direct-only is filtered here because this API has no stops parameter.
  const direct = normalizeCash(await q({ departure_id: 'TPE', arrival_id: 'NRT', outbound_date: '2026-11-01', travel_class: 1, adults: 1, stops: 1 }));
  assert.equal(direct.options.length, 1);
  // The return-leg call goes back with the original token, without our prefix.
  await q({ departure_token: n.options[0].departureToken, return_date: '2026-11-05' });
  assert.match(seen.at(-1).url, /getNextFlights\?next_token=abc%3D/);
});

test('RapidAPI quota exhaustion is reported as such', async () => {
  const { createRapidFlights } = require('../lib/rapidflights');
  const q = createRapidFlights({ apiKey: 'k', fetchImpl: async () => new Response(JSON.stringify({ message: 'You have exceeded the MONTHLY quota for requests on your current plan, BASIC.' }), { status: 429, headers: { 'x-ratelimit-requests-remaining': '0' } }) });
  await assert.rejects(q({ departure_id: 'TPE', arrival_id: 'NRT', outbound_date: '2026-11-01', travel_class: 1, adults: 1 }), (e) => e.quota === true && e.status === 429);
});

test('hotel award search, calendar and rooms work in demo mode', async () => {
  const s = await (await fetch(`${base}/api/hotels/search?where=Tokyo&start=2026-11-01&end=2026-11-10&nights=2&programs=marriott,hilton`)).json();
  assert.ok(s.hotels.length > 0);
  assert.ok(s.hotels.every((h) => ['marriott', 'hilton'].includes(h.source) && h.standard.points > 0 && h.standard.nights === 2));
  const c = await (await fetch(`${base}/api/hotels/calendar?hotel=${s.hotels[0].id}&start=2026-11-01&end=2026-11-03&nights=2`)).json();
  assert.equal(c.dates.length, 3);
  const r = await (await fetch(`${base}/api/hotels/rooms?id=${encodeURIComponent(c.dates[0].id)}`)).json();
  assert.ok(r.rooms.length > 0);
  assert.equal((await fetch(`${base}/api/hotels/search?where=&start=2026-11-01`)).status, 400);
  assert.equal((await fetch(`${base}/api/hotels/search?where=Tokyo&start=2026-11-01&nights=9`)).status, 400);
  const quota = await (await fetch(`${base}/api/cash/quota`)).json();
  assert.ok(quota.rapid && quota.serpapi);
});

test('trip notes: forecast, climate averages, Taiwan long weekends and destination holidays', async () => {
  const { createTravelInfo } = require('../lib/travelinfo');
  const urls = [];
  const days = (a, b) => { const out = []; for (let d = a; d <= b; d = new Date(Date.parse(d) + 864e5).toISOString().slice(0, 10)) out.push(d); return out; };
  const fetchImpl = async (url) => {
    const u = new URL(String(url));
    urls.push(u.host);
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status });
    if (u.host === 'api.open-meteo.com') { const t = days(u.searchParams.get('start_date'), u.searchParams.get('end_date')); return json({ daily: { time: t, weather_code: t.map(() => 61), temperature_2m_max: t.map(() => 20.4), temperature_2m_min: t.map(() => 11.6), precipitation_probability_max: t.map(() => 70) } }); }
    if (u.host === 'archive-api.open-meteo.com') { const t = days(u.searchParams.get('start_date'), u.searchParams.get('end_date')); return json({ daily: { time: t, temperature_2m_max: t.map(() => 15), temperature_2m_min: t.map(() => 5), precipitation_sum: t.map((_, i) => (i % 3 ? 0 : 2)) } }); }
    if (u.host === 'cdn.jsdelivr.net') {
      const y = Number(u.pathname.match(/(\d{4})/)[1]);
      return json(days(`${y}-01-01`, `${y}-12-31`).map((d) => {
        const wk = [0, 6].includes(new Date(d).getUTCDay());
        const name = { [`${y}-10-09`]: '補假', [`${y}-10-10`]: '國慶日', [`${y}-06-20`]: '' }[d] ?? '';
        return { date: d.replace(/-/g, ''), isHoliday: (wk && d !== `${y}-06-20`) || Boolean(name), description: d === `${y}-06-20` ? '補行上班' : name };
      }));
    }
    if (u.host === 'nagerholidays.com') return json({}, 503);
    if (u.host === 'date.nager.at') return json([{ date: '2026-11-03', localName: '文化の日', name: 'Culture Day', counties: null, types: ['Public'] }, { date: '2026-11-04', name: 'Regional', counties: ['JP-01'], types: ['Public'] }]);
    throw new Error('unexpected ' + u);
  };
  const ti = createTravelInfo({ fetchImpl, today: () => '2026-10-01', visa: { JP: { type: 'free', days: 90 } } });
  const near = await ti.forTrip({ country: 'JP', lat: 35.7, lon: 140.4 }, '2026-10-05', '2026-10-12');
  assert.equal(near.weather.kind, 'forecast');
  assert.equal(near.weather.days.length, 7, 'forecast is capped at a week of the trip');
  assert.deepEqual([near.weather.days[0].icon, near.weather.days[0].max, near.weather.days[0].min], ['🌧️', 20, 12]);
  assert.deepEqual(near.taiwan.longWeekends.map((l) => [l.start, l.end, l.days, l.name]), [['2026-10-09', '2026-10-11', 3, '國慶日']]);
  assert.equal(near.visa.days, 90);
  const far = await ti.forTrip({ country: 'JP', lat: 35.7, lon: 140.4 }, '2026-11-01', '2026-11-30');
  assert.equal(far.weather.kind, 'climate');
  assert.deepEqual([far.weather.max, far.weather.min, far.weather.rainyDays, far.weather.years], [15, 5, 10, [2025, 2024, 2023]]);
  assert.deepEqual(far.holidays, [{ date: '2026-11-03', name: 'Culture Day', local: '文化の日' }], 'regional holidays are dropped, v3 host is the fallback');
  const summer = await ti.taiwan('2026-06-15', '2026-06-25');
  assert.deepEqual(summer.days, [{ date: '2026-06-20', name: '補行上班', off: false, workday: true }]);
  // A broken source only blanks its own part.
  const broken = createTravelInfo({ fetchImpl: async () => { throw new Error('down'); }, today: () => '2026-10-01' });
  const b = await broken.forTrip({ country: 'JP', lat: 1, lon: 1 }, '2026-11-01', '2026-11-02');
  assert.equal(b.weather, null);
  assert.ok(b.errors.weather && b.errors.taiwan);
});

test('cash month calendar: demo grid, validation and RapidAPI round-trip fallback', async () => {
  const ok = await (await fetch(`${base}/api/cash/calendar?origin=TPE&destination=NRT&start=${isoIn(10)}&end=${isoIn(40)}&trip_days=5`)).json();
  assert.equal(ok.days.length, 31);
  assert.ok(ok.round && ok.days.every((d) => d.price > 0));
  assert.equal((await fetch(`${base}/api/cash/calendar?origin=TPE&destination=NRT&start=${isoIn(10)}&end=${isoIn(100)}`)).status, 400);
  assert.equal((await fetch(`${base}/api/cash/calendar?origin=TPE,TSA&destination=NRT&start=${isoIn(10)}`)).status, 400);
  const { createRapidFlights } = require('../lib/rapidflights');
  const seen = [];
  const q = createRapidFlights({ apiKey: 'k', fetchImpl: async (url) => {
    seen.push(String(url));
    if (/trip_type=ROUND/.test(String(url))) return new Response(JSON.stringify({ status: false, message: 'Something went wrong' }));
    return new Response(JSON.stringify({ status: true, data: [{ departure: '2026-11-01', price: 9000 }, { departure: '2026-11-02', price: 'unavailable' }] }));
  } });
  const cal = await q.calendar({ departure_id: 'TPE', arrival_id: 'NRT', start_date: '2026-11-01', end_date: '2026-11-30', trip_days: 5, travel_class: 1, adults: 1 });
  assert.deepEqual(cal, { round: false, days: [{ date: '2026-11-01', price: 9000 }] });
  assert.equal(seen.length, 2);
  assert.match(seen[1], /getCalendarPicker\?.*start_date=2026-11-01/);
  assert.doesNotMatch(seen[1], /outbound_date|trip_type/);
});

test('trip-info endpoint validates the airport', async () => {
  assert.equal((await fetch(`${base}/api/trip-info?to=XXX&start=2026-11-01`)).status, 400);
  assert.equal((await fetch(`${base}/api/trip-info?to=NRT`)).status, 400);
});
