const { test, before, after } = require('node:test');
const assert = require('node:assert');
delete process.env.SEATS_AERO_API_KEY;
const { server } = require('../server');
const { normalizeAvailability, createClient } = require('../lib/seats');
const { createCashClient, normalizeCash } = require('../lib/cash');

let base;
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
  for (const q of ['origin=TP&destination=YVR&start=2026-11-01', 'origin=TPE&destination=YVR&start=2026-11-05&end=2026-11-01', 'origin=TPE&destination=YVR&start=2026-11-01&end=2027-03-01']) {
    assert.equal((await fetch(`${base}/api/search?${q}`)).status, 400, q);
  }
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
  assert.deepEqual(out.map((x) => x.ID), ['a', 'b', 'c']);
  assert.equal(calls[0].key, 'k');
  assert.match(calls[1].url, /cursor=123/);
  assert.match(calls[1].url, /skip=2/);
});

test('normalizeAvailability maps cabin fields', () => {
  const n = normalizeAvailability({ ID: 'x', Date: '2026-11-01', Source: 'aeroplan', Route: { OriginAirport: 'TPE', DestinationAirport: 'YVR', Distance: 6000 }, JAvailable: true, JMileageCost: '75000', JRemainingSeats: 2, JAirlines: 'BR', JDirect: true });
  assert.deepEqual(n.cabins.J, { available: true, miles: 75000, seats: 2, airlines: 'BR', direct: true });
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
