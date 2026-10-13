const { test, before, after } = require('node:test');
const assert = require('node:assert');
delete process.env.SEATS_AERO_API_KEY;
const { server } = require('../server');
const { normalizeAvailability, createClient } = require('../lib/seats');

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
  for (const n of ['airlines', 'alliances', 'airports', 'programs', 'glossary']) {
    assert.equal((await fetch(`${base}/api/data/${n}`)).status, 200);
  }
  assert.equal((await fetch(`${base}/api/data/..%2Fserver`)).status, 404);
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
