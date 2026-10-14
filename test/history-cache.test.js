// Award-space history snapshots (bounded) and the shared Upstash search cache.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
delete process.env.SEATS_AERO_API_KEY;
const { server } = require('../server');
const { createHistory, summarize, mergeDay, dayNum } = require('../lib/history');
const { createSearchCache, decode } = require('../lib/searchcache');
const { memoryKv } = require('../lib/kv');

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

const row = (o, d, date, source, c, miles, seats = 2) => ({ id: `${o}${d}${date}${source}`, date, origin: o, destination: d, source, cabins: { J: { available: false }, Y: { available: false }, [c]: { available: true, miles, seats } } });

test('summarize: one entry per route asked, distinct dates, lowest miles, most seats, only the searched cabin', () => {
  const rows = [
    row('TPE', 'NRT', '2099-01-01', 'aeroplan', 'J', 40000, 1),
    row('TPE', 'NRT', '2099-01-01', 'aeroplan', 'J', 35000, 4), // same date again (another flight)
    row('TPE', 'NRT', '2099-01-02', 'aeroplan', 'J', 45000, 2),
    row('TPE', 'NRT', '2099-01-02', 'united', 'Y', 20000, 9), // economy: not what was searched
    row('TPE', 'LAX', '2099-01-02', 'united', 'J', 70000, 1), // a route not asked about
  ];
  const s = summarize({ origin_airport: 'TPE', destination_airport: 'NRT,HND', cabins: 'business' }, rows);
  assert.deepEqual([...s.keys()], ['TPE-NRT', 'TPE-HND']);
  assert.deepEqual([...s.get('TPE-NRT')], [['aeroplan.J', [2, 35000, 4]]]);
  assert.equal(s.get('TPE-HND').size, 0, 'looked at, nothing there');
});

test('mergeDay keeps at most `days` days and `maxBytes`, and merges two looks on one day', () => {
  let rec = null;
  for (let d = 1000; d < 1300; d++) rec = mergeDay(rec, d, new Map([['aeroplan.J', [d % 5, 30000 + d, 2]], ['united.J', [1, 70000, 1]]]), { days: 120 });
  assert.equal(rec.obs.length, 120);
  assert.equal(rec.obs[0], 1300 - 120);
  assert.ok(rec.r['aeroplan.J'].every((e) => e[0] >= 1180));
  // Same day again: more dates, lower miles and more seats win.
  rec = mergeDay(rec, 1299, new Map([['aeroplan.J', [9, 1000, 1]]]));
  assert.deepEqual(rec.r['aeroplan.J'].at(-1), [1299, 9, 1000, 2]);
  assert.equal(rec.obs.filter((d) => d === 1299).length, 1);
  // Byte cap: the oldest days go first.
  const small = mergeDay(rec, 1300, new Map(), { days: 120, maxBytes: 800 });
  assert.ok(JSON.stringify(small).length <= 800);
  assert.equal(small.obs.at(-1), 1300);
  // Series cap: the programs with space on the most days stay.
  const many = new Map(Array.from({ length: 40 }, (_, i) => [`p${i}.J`, [1, 1000, 1]]));
  assert.equal(Object.keys(mergeDay(null, 5, many, { maxSeries: 30 }).r).length, 30);
});

test('history: notes from the daily searches build a per-route record; routes are capped; off without Redis', async () => {
  let t = Date.parse('2026-10-01T04:00:00Z');
  const kv = memoryKv();
  const h = createHistory({ kv, now: () => t, maxRoutes: 3 });
  const p = { origin_airport: 'TPE', destination_airport: 'NRT', cabins: 'business' };
  assert.equal(await h.note(p, [row('TPE', 'NRT', '2099-01-01', 'aeroplan', 'J', 40000)]), 1);
  t += 864e5;
  await h.note(p, []); // looked, nothing there
  t += 864e5;
  await h.note(p, [row('TPE', 'NRT', '2099-01-05', 'aeroplan', 'J', 38000, 3), row('TPE', 'NRT', '2099-01-06', 'aeroplan', 'J', 42000, 1)]);
  const { routes } = await h.get('TPE', 'NRT,HND');
  assert.equal(routes.length, 1);
  assert.deepEqual(routes[0].observed, ['2026-10-01', '2026-10-02', '2026-10-03']);
  assert.deepEqual(routes[0].series, [{ source: 'aeroplan', cabin: 'J', days: 2, minMiles: 38000, points: [['2026-10-01', 1, 40000, 2], ['2026-10-03', 2, 38000, 3]] }]);
  // A fifth route pushes out the least recently looked-at one.
  for (const d of ['LAX', 'SFO', 'SEA']) { t += 864e5; await h.note({ ...p, destination_airport: d }, []); }
  assert.equal(await kv.get('hist:v1:TPE-NRT'), null);
  assert.deepEqual(Object.keys(await kv.get('hist:v1:routes')).sort(), ['TPE-LAX', 'TPE-SEA', 'TPE-SFO']);
  // Disabled: nothing written, nothing read.
  const off = createHistory({ kv: memoryKv(), enabled: false });
  assert.equal(await off.note(p, [row('TPE', 'NRT', '2099-01-01', 'aeroplan', 'J', 1)]), 0);
  assert.deepEqual(await off.get('TPE', 'NRT'), { routes: [] });
  // A broken store never breaks the job.
  const broken = createHistory({ kv: { get: async () => { throw new Error('down'); }, set: async () => { throw new Error('down'); }, del: async () => {} } });
  assert.equal(await broken.note(p, []), 0);
  assert.equal(dayNum('1970-01-02'), 1);
});

test('/api/history: demo history for the route; bad codes refused', async () => {
  const r = await fetch(`${base}/api/history?origin=TPE&destination=YVR`);
  const body = await r.json();
  assert.equal(body.mock, true);
  assert.equal(body.routes[0].origin, 'TPE');
  assert.ok(body.routes[0].series.length > 0);
  assert.equal((await fetch(`${base}/api/history?origin=TP&destination=YVR`)).status, 400);
  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.deepEqual(cfg.searchCache, { enabled: false }, 'no Redis in tests: the shared cache is off');
});

test('search cache: off is a pass-through; on, a second instance reuses the answer', async () => {
  let calls = 0;
  const fn = async () => { calls++; return { results: [1, 2, 3] }; };
  const off = createSearchCache({ kv: { get: () => assert.fail('no Redis use when off') }, enabled: false });
  await off.wrap('search:a', fn);
  await off.wrap('search:a', fn);
  assert.equal(calls, 2);
  assert.deepEqual(await off.stats(), { enabled: false });

  const kv = memoryKv();
  const a = createSearchCache({ kv, enabled: true, ttl: 60 });
  const b = createSearchCache({ kv, enabled: true, ttl: 60 });
  calls = 0;
  assert.deepEqual(await a.wrap('search:x', fn), { results: [1, 2, 3] });
  assert.deepEqual(await b.wrap('search:x', fn), { results: [1, 2, 3] });
  assert.equal(calls, 1, 'the second instance did not ask upstream');
  const st = await b.stats();
  assert.deepEqual(st.today, { hits: 1, misses: 1, skipped: 0, hitRate: 50 });
  assert.deepEqual(st.instance, { hits: 1, misses: 0, skipped: 0 });
});

test('search cache: big answers are compressed, too-big ones skipped, errors and nulls never stored', async () => {
  const kv = memoryKv();
  const big = { results: Array.from({ length: 3000 }, (_, i) => ({ id: `row-${i}`, date: '2099-01-01', miles: 30000 + (i % 7) * 5000 })) };
  const c = createSearchCache({ kv, enabled: true, compressOver: 1000, maxBytes: 60_000 });
  await c.wrap('search:big', async () => big);
  const keys = [];
  const kv2 = { ...kv, set: async (k, v, o) => { keys.push(v); return kv.set(k, v, o); } };
  const c2 = createSearchCache({ kv: kv2, enabled: true, compressOver: 1000, maxBytes: 60_000 });
  await c2.wrap('search:big2', async () => big);
  assert.ok(typeof keys[0].z === 'string' && keys[0].z.length < JSON.stringify(big).length / 4, 'gzipped');
  assert.deepEqual(await decode(keys[0]), big);
  let calls = 0;
  assert.deepEqual(await c.wrap('search:big', async () => { calls++; return null; }), big);
  assert.equal(calls, 0);
  // Over the size cap even compressed: answered but not stored.
  const tiny = createSearchCache({ kv, enabled: true, compressOver: 10, maxBytes: 50 });
  await tiny.wrap('search:huge', async () => big);
  assert.equal((await tiny.stats()).instance.skipped, 1);
  assert.equal(await tiny.wrap('search:huge', async () => 'fresh'), 'fresh');
  // Errors propagate and are not cached; null is not cached; a Redis failure is just a miss.
  await assert.rejects(c.wrap('search:err', async () => { throw new Error('quota'); }), /quota/);
  assert.equal(await c.wrap('search:err', async () => 'ok'), 'ok');
  assert.equal(await c.wrap('search:null', async () => null), null);
  assert.equal(await c.wrap('search:null', async () => 'now'), 'now');
  const down = createSearchCache({ kv: { get: async () => { throw new Error('down'); }, set: async () => { throw new Error('down'); }, incr: async () => { throw new Error('down'); } }, enabled: true });
  assert.equal(await down.wrap('search:d', async () => 'live'), 'live');
});
