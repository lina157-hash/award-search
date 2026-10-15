// 國泰官網實查 store: upload validation and limits, and /api/cxcal through the server in demo mode.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
delete process.env.SEATS_AERO_API_KEY;
delete process.env.CASH_PASSCODE;
delete process.env.CRON_SECRET;
const { server } = require('../server');
const { memoryKv } = require('../lib/kv');
const { createCxcalStore, validatePayload, CxcalError } = require('../lib/cxcal-store');

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());
const call = async (p, { method = 'GET', body, headers = {} } = {}) => {
  const res = await fetch(base + p, { method, headers: { 'x-requested-with': 'fetch', ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};

const payload = (extra = {}) => ({
  v: 1, from: '台北', to: '東京', fc: 'TPE', tc: 'NRT', at: 1760000000000, source: 'bookmarklet',
  days: {
    '2026-11-01': { na: 1 },
    '2026-11-03': { lo: 13000, c: { Y: { m: 13000, f: [{ n: 'CX450', d: '07:30', a: '11:45', p: 'TPE-NRT', s: 0, m: 13000, du: '3小時15分' }], t: 1760000000000 }, J: { m: 38000 } } },
    '2026-11-04': { c: { Y: { m: 0 }, J: { na: 1, m: 0 } } },
  },
  ...extra,
});

test('cxcal-store: a bookmarklet payload is kept as is; names are trimmed and codes upper-cased', () => {
  const r = validatePayload(payload({ fc: 'tpe ', tc: 'nrt' }));
  assert.deepEqual([r.fc, r.tc, r.from, r.source], ['TPE', 'NRT', '台北', 'bookmarklet']);
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

test('cxcal-store: /api/cxcal through the server in demo mode', async () => {
  let r = await call('/api/cxcal?origin=TPE&destination=NRT');
  assert.deepEqual(r.body, { found: false });
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
  r = await call('/api/cxcal', { method: 'PUT', body: payload() });
  assert.equal(r.status, 405);
  // The runner's endpoints are gone.
  for (const sub of ['wanted', 'queue', 'heartbeat', 'status']) assert.equal((await call('/api/cxcal/' + sub)).status, 404);
});

test('cxcal-store: with a passcode set, writes need it and reads stay public', async () => {
  process.env.CASH_PASSCODE = 'cxtest';
  try {
    let r = await call('/api/cxcal', { method: 'POST', body: payload({ fc: 'TPE', tc: 'HKG' }) });
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 'passcode');
    r = await call('/api/cxcal', { method: 'POST', body: payload({ fc: 'TPE', tc: 'HKG' }), headers: { 'x-cash-pass': 'cxtest' } });
    assert.equal(r.status, 200);
    r = await call('/api/cxcal?origin=TPE&destination=HKG');
    assert.equal(r.body.found, true);
  } finally { delete process.env.CASH_PASSCODE; }
});

test('cxcal-store: the site loads the card script', () => {
  // Loaded on the first search, after cxcal.js (app.js SEARCH_SCRIPTS).
  const list = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8').match(/const SEARCH_SCRIPTS = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
  assert.ok(list.indexOf('cxcal') >= 0 && list.indexOf('cxlive') > list.indexOf('cxcal'));
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'tools', 'cathay-runner')), 'the runner was removed at the owner\'s request (2026-10-15)');
});

test('cxcal-store: records left by the removed PC runner are refused, hidden and deleted', async () => {
  assert.throws(() => validatePayload(payload({ source: 'runner' })), CxcalError);
  assert.equal(validatePayload(payload({ source: undefined })).source, 'bookmarklet');
  const kv = memoryKv();
  const st = createCxcalStore({ kv });
  await kv.set('cxcal:v1:TPE>NRT', { ...payload(), source: 'runner', air: 'cx' });
  assert.deepEqual(await st.find('TPE', 'NRT'), []);
  assert.equal(await kv.get('cxcal:v1:TPE>NRT'), null);
  await st.save(payload());
  assert.equal((await st.find('TPE', 'NRT'))[0].source, 'bookmarklet');
});
