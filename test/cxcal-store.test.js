// 國泰官網實查 store: upload validation and limits, the wanted list, the on-demand queue, the heartbeat, and the
// /api/cxcal routes through the server in demo mode.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
delete process.env.SEATS_AERO_API_KEY;
delete process.env.CASH_PASSCODE;
delete process.env.CRON_SECRET;
const { server } = require('../server');
const { memoryKv } = require('../lib/kv');
const { createCxcalStore, validatePayload, CxcalError, MAX_QUEUE, MAX_WANTED } = require('../lib/cxcal-store');

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());
const call = async (p, { method = 'GET', body, headers = {} } = {}) => {
  const res = await fetch(base + p, { method, headers: { 'x-requested-with': 'fetch', ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};

const payload = (extra = {}) => ({
  v: 1, from: '台北', to: '東京', fc: 'TPE', tc: 'NRT', at: 1760000000000, source: 'runner',
  days: {
    '2026-11-01': { na: 1 },
    '2026-11-03': { lo: 13000, c: { Y: { m: 13000, f: [{ n: 'CX450', d: '07:30', a: '11:45', p: 'TPE-NRT', s: 0, m: 13000, du: '3小時15分' }], t: 1760000000000 }, J: { m: 38000 } } },
    '2026-11-04': { c: { Y: { m: 0 }, J: { na: 1, m: 0 } } },
  },
  ...extra,
});

test('cxcal-store: a runner payload is kept as is; names are trimmed and codes upper-cased', () => {
  const r = validatePayload(payload({ fc: 'tpe ', tc: 'nrt' }));
  assert.deepEqual([r.fc, r.tc, r.from, r.source], ['TPE', 'NRT', '台北', 'runner']);
  assert.deepEqual(r.days['2026-11-03'].c.Y.f[0], { n: 'CX450', d: '07:30', a: '11:45', p: 'TPE-NRT', s: 0, m: 13000, du: '3小時15分' });
  assert.deepEqual(r.days['2026-11-04'], { c: { Y: { m: 0 }, J: { m: 0, na: 1 } } });
  assert.deepEqual(r.days['2026-11-01'], { na: 1 });
});

test('cxcal-store: bad shapes are refused with a reason', () => {
  const bad = (p, re) => assert.throws(() => validatePayload(p), (e) => e instanceof CxcalError && re.test(e.message), re);
  bad(payload({ extra: 1 }), /不認識的欄位/);
  bad(payload({ fc: 'TPEE' }), /機場代碼/);
  bad(payload({ tc: 'TPE' }), /機場代碼/);
  bad(payload({ days: [] }), /days/);
  bad(payload({ days: {} }), /沒有任何日期/);
  bad(payload({ days: { '2026-13-40': {} } }), /格式不對/);
  bad(payload({ days: { '2026-11-03': { foo: 1 } } }), /不認識的欄位/);
  bad(payload({ days: { '2026-11-03': { c: { X: { m: 1 } } } } }), /不認識的欄位/);
  bad(payload({ days: { '2026-11-03': { c: { Y: { m: 1, zzz: 1 } } } } }), /不認識的欄位/);
  bad(payload({ days: { '2026-11-03': { c: { Y: { m: 1, f: 'x' } } } } }), /陣列/);
  bad(payload({ source: 'hacker' }), /source/);
  bad(payload({ cabins: ['Y', 'Q'] }), /cabins/);
  bad(payload({ v: 2 }), /版本/);
  bad({ fc: 'TPE', tc: 'NRT', days: 'x' }, /days/);
  bad([], /格式/);
  // Too many days and too many bytes.
  const many = {};
  for (let i = 0; i < 401; i++) many[new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10)] = { na: 1 };
  bad(payload({ days: many }), /日期太多/);
  const big = {};
  const f = Array.from({ length: 15 }, (_, i) => ({ n: `CX${100 + i}›CX${500 + i}`, d: '08:20', a: '20:20', p: 'TPE-HKG-NRT', s: 1, m: 13000, du: '11小時0分' }));
  for (let i = 0; i < 300; i++) big[new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10)] = { c: { Y: { m: 13000, f }, J: { m: 38000, f }, F: { m: 90000, f } } };
  bad(payload({ days: big }), /資料太大/);
  // Flights are capped at 20 per cabin and day, unknown flight fields refused.
  const r = validatePayload(payload({ days: { '2026-11-03': { c: { Y: { m: 1000, f: Array.from({ length: 25 }, () => ({ n: 'CX1', m: 1000 })) } } } } }));
  assert.equal(r.days['2026-11-03'].c.Y.f.length, 20);
  bad(payload({ days: { '2026-11-03': { c: { Y: { m: 1, f: [{ n: 'CX1', pw: 'x' }] } } } } }), /不認識的欄位/);
});

test('cxcal-store: routes are saved with a TTL, found by code lists, capped at 50', async () => {
  let t = Date.parse('2026-10-15T00:00:00Z');
  const kv = memoryKv({ now: () => t });
  const st = createCxcalStore({ kv, now: () => t });
  const r = await st.save(payload());
  assert.deepEqual([r.ok, r.fc, r.tc, r.days], [true, 'TPE', 'NRT', 3]);
  assert.equal(r.savedAt, '2026-10-15T00:00:00.000Z');
  await st.save(payload({ fc: 'TPE', tc: 'HND' }));
  t += 1000;
  await st.save(payload({ fc: 'TSA', tc: 'HND' }));
  const both = await st.find('TPE,TSA', 'NRT,HND,KIX');
  assert.deepEqual(both.map((x) => `${x.fc}>${x.tc}`), ['TSA>HND', 'TPE>NRT', 'TPE>HND']);
  assert.deepEqual(await st.find('tpe', 'kix'), []);
  assert.deepEqual(await st.find('', 'NRT'), []);
  // After 21 days the record is gone.
  t += 22 * 86400e3;
  assert.deepEqual(await st.find('TPE', 'NRT'), []);
  // 50 routes at most.
  const kv2 = memoryKv();
  const st2 = createCxcalStore({ kv: kv2 });
  const codes = [];
  for (let i = 0; i < 50; i++) codes.push(String.fromCharCode(65 + Math.floor(i / 26)) + String.fromCharCode(65 + (i % 26)) + 'X');
  for (const c of codes) await st2.save(payload({ fc: 'TPE', tc: c }));
  await assert.rejects(st2.save(payload({ fc: 'TPE', tc: 'ZZZ' })), /最多保存 50 條/);
  await st2.save(payload({ fc: 'TPE', tc: codes[0] })); // an existing route can still be refreshed
});

test('cxcal-store: wanted list, queue and heartbeat', async () => {
  let t = Date.parse('2026-10-15T00:00:00Z');
  const kv = memoryKv({ now: () => t });
  const st = createCxcalStore({ kv, now: () => t });
  let list = await st.addWanted({ fc: 'tpe', tc: 'nrt', from: '台北', to: '東京' });
  assert.deepEqual(list, [{ fc: 'TPE', tc: 'NRT', from: '台北', to: '東京', cabins: ['Y', 'J'], pax: 1, addedAt: '2026-10-15T00:00:00.000Z' }]);
  list = await st.addWanted({ fc: 'TPE', tc: 'NRT', from: '台北', to: '東京', cabins: ['J'], pax: 2 });
  assert.equal(list.length, 1);
  assert.deepEqual([list[0].cabins, list[0].pax], [['J'], 2]);
  await assert.rejects(st.addWanted({ fc: 'TPE', tc: 'NRT', cabins: [] }), /cabins/);
  await assert.rejects(st.addWanted({ fc: 'TPE', tc: 'TPE' }), /機場代碼/);
  for (let i = 1; i < MAX_WANTED; i++) await st.addWanted({ fc: 'TPE', tc: 'A' + String(i).padStart(2, '0').replace(/\d/g, (d) => 'BCDEFGHIJK'[+d]) });
  await assert.rejects(st.addWanted({ fc: 'TPE', tc: 'ZZZ' }), /最多 20 條/);
  list = await st.removeWanted({ fc: 'TPE', tc: 'NRT' });
  assert.ok(!list.some((x) => x.tc === 'NRT'));

  // Queue: de-duplicated, at most 5, an hour each, cleared by 'done'.
  await st.enqueue({ fc: 'TPE', tc: 'NRT' });
  await st.enqueue({ fc: 'TPE', tc: 'NRT' });
  assert.equal((await st.queue()).length, 1);
  for (const tc of ['HND', 'KIX', 'HKG', 'LHR']) await st.enqueue({ fc: 'TPE', tc });
  await assert.rejects(st.enqueue({ fc: 'TPE', tc: 'SFO' }), new RegExp(`${MAX_QUEUE} 條`));
  await st.dequeue({ fc: 'TPE', tc: 'NRT' });
  assert.deepEqual((await st.queue()).map((q) => q.tc), ['HND', 'KIX', 'HKG', 'LHR']);
  t += 3601e3;
  assert.deepEqual(await st.queue(), []);

  // Heartbeat: online for 10 minutes, seen forever (well, 400 days).
  let s = await st.status();
  assert.deepEqual([s.seen, s.online, s.status], [false, false, 'offline']);
  await st.heartbeat({ status: 'running', route: 'TPE→NRT', startedAt: new Date(t).toISOString() });
  s = await st.status();
  assert.deepEqual([s.seen, s.online, s.status, s.route, s.queueLength], [true, true, 'running', 'TPE→NRT', 0]);
  await st.heartbeat({ status: 'idle', lastRun: new Date(t).toISOString(), summary: 'TPE→NRT 經濟 42/60 天有位' });
  t += 11 * 60e3;
  s = await st.status();
  assert.deepEqual([s.seen, s.online, s.status, s.route], [true, false, 'offline', '']);
  assert.equal(s.lastRun, '2026-10-15T01:00:01.000Z');
  assert.match(s.lastSummary, /42\/60/);
  await assert.rejects(st.heartbeat({ status: 'dancing' }), /status/);
});

test('cxcal-store: /api/cxcal through the server in demo mode', async () => {
  let r = await call('/api/cxcal?origin=TPE&destination=NRT');
  assert.deepEqual(r.body, { found: false });
  r = await call('/api/cxcal/status');
  assert.equal(r.body.online, false);
  r = await call('/api/cxcal', { method: 'POST', body: payload() });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.days, 3);
  r = await call('/api/cxcal', { method: 'POST', body: payload({ nope: 1 }) });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /不認識的欄位/);
  r = await call('/api/cxcal?origin=TSA,TPE&destination=HND,NRT');
  assert.equal(r.body.found, true);
  assert.equal(r.body.fc, 'TPE');
  assert.equal(r.body.routes.length, 1);
  assert.ok(r.body.savedAt);
  assert.equal(r.body.days['2026-11-03'].c.J.m, 38000);
  r = await call('/api/cxcal?origin=TPE&destination=KIX');
  assert.deepEqual(r.body, { found: false });
  // Wanted list, queue, heartbeat and status.
  r = await call('/api/cxcal/wanted', { method: 'POST', body: { action: 'add', fc: 'TPE', tc: 'NRT', from: '台北', to: '東京' } });
  assert.equal(r.body.routes.length, 1);
  r = await call('/api/cxcal/queue', { method: 'POST', body: { fc: 'TPE', tc: 'NRT' } });
  assert.equal(r.body.queue.length, 1);
  r = await call('/api/cxcal/heartbeat', { method: 'POST', body: { status: 'running', route: 'TPE→NRT' } });
  assert.equal(r.body.ok, true);
  r = await call('/api/cxcal/status');
  assert.deepEqual([r.body.online, r.body.status, r.body.queueLength, r.body.wanted], [true, 'running', 1, 1]);
  r = await call('/api/cxcal/queue', { method: 'POST', body: { action: 'done', fc: 'TPE', tc: 'NRT' } });
  assert.deepEqual(r.body.queue, []);
  r = await call('/api/cxcal/wanted');
  assert.equal(r.body.routes[0].tc, 'NRT');
  r = await call('/api/cxcal/wanted', { method: 'POST', body: { action: 'remove', fc: 'TPE', tc: 'NRT' } });
  assert.deepEqual(r.body.routes, []);
  r = await call('/api/cxcal', { method: 'PUT', body: payload() });
  assert.equal(r.status, 405);
  r = await call('/api/cxcal/nope');
  assert.equal(r.status, 404);
});

test('cxcal-store: with a passcode set, writes need it and reads stay public', async () => {
  process.env.CASH_PASSCODE = 'cxtest';
  try {
    let r = await call('/api/cxcal', { method: 'POST', body: payload({ fc: 'TPE', tc: 'HKG' }) });
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 'passcode');
    r = await call('/api/cxcal', { method: 'POST', body: payload({ fc: 'TPE', tc: 'HKG' }), headers: { 'x-cash-pass': 'cxtest' } });
    assert.equal(r.status, 200);
    r = await call('/api/cxcal/wanted');
    assert.equal(r.status, 401);
    r = await call('/api/cxcal/heartbeat', { method: 'POST', body: { status: 'idle' } });
    assert.equal(r.status, 401);
    r = await call('/api/cxcal?origin=TPE&destination=HKG');
    assert.equal(r.body.found, true);
    r = await call('/api/cxcal/status');
    assert.equal(r.status, 200);
  } finally { delete process.env.CASH_PASSCODE; }
});

test('cxcal-store: the runner ships the same page functions as public/cxcal.js (node tools/cathay-runner/build.js)', () => {
  const { build } = require('../tools/cathay-runner/build.js');
  const shipped = fs.readFileSync(path.join(__dirname, '..', 'tools', 'cathay-runner', 'cxcal-page.js'), 'utf8');
  assert.equal(shipped, build(), 'tools/cathay-runner/cxcal-page.js is out of date: run node tools/cathay-runner/build.js');
  assert.match(shipped, /function parseCathayText\(/);
  assert.match(shipped, /function cxHints\(/);
  assert.match(shipped, /function cxDiag\(/);
  // The runner's own config never carries a Cathay password and the tool never types one.
  const run = fs.readFileSync(path.join(__dirname, '..', 'tools', 'cathay-runner', 'run.js'), 'utf8');
  assert.ok(!/\.(fill|type|pressSequentially|insertText)\([^)]*(pass|密碼)|getBy(Label|Placeholder|Role)\([^)]*(密碼|password)/i.test(run), 'run.js never fills a password field');
  assert.ok(!/cookies\(\)|storageState/.test(run), 'run.js never reads cookies out of the profile');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /<script src="\/cxlive\.js\?v=[\w.-]+"><\/script>/);
});
