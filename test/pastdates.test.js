// F3: dates that have already passed (old favourites, recent searches, shared links) are moved to today in the page,
// a range wholly in the past is not searched, and the server refuses it before any seats.aero call.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
delete process.env.SEATS_AERO_API_KEY;
const { server } = require('../server');
const { todayTW, addDays } = require('../lib/day');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(`${src.match(/function clampShareDates\(s, e, today\) \{[\s\S]*?\n\}/)[0]}\nthis.clamp = clampShareDates;`, ctx);
const clamp = (...a) => ({ ...ctx.clamp(...a) });

test('clampShareDates: future ranges are kept', () => {
  assert.deepEqual(clamp('2026-11-01', '2026-11-10', '2026-10-15'), { s: '2026-11-01', e: '2026-11-10', clamped: false, past: false });
  assert.deepEqual(clamp('2026-10-15', '2026-10-15', '2026-10-15'), { s: '2026-10-15', e: '2026-10-15', clamped: false, past: false });
});

test('clampShareDates: a range that started already starts today', () => {
  assert.deepEqual(clamp('2026-10-10', '2026-10-20', '2026-10-15'), { s: '2026-10-15', e: '2026-10-20', clamped: true, past: false });
  assert.deepEqual(clamp('2026-10-01', '2026-10-15', '2026-10-15'), { s: '2026-10-15', e: '2026-10-15', clamped: true, past: false });
});

test('clampShareDates: a range wholly in the past is not searched', () => {
  assert.deepEqual(clamp('2026-10-01', '2026-10-10', '2026-10-15'), { s: '2026-10-01', e: '2026-10-10', clamped: false, past: true });
  // One day: the end defaults to the start.
  assert.equal(clamp('2026-10-14', '', '2026-10-15').past, true);
  assert.equal(clamp('', '', '2026-10-15').past, false);
});

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

test('search and explore refuse a range that ended before yesterday (Taiwan time)', async () => {
  const today = todayTW();
  for (const u of [
    `/api/search?origin=TPE&destination=NRT&start=${addDays(today, -10)}&end=${addDays(today, -2)}`,
    `/api/search?origin=TPE&destination=NRT&start=${addDays(today, -2)}`,
    `/api/explore?program=aeroplan&start=${addDays(today, -10)}&end=${addDays(today, -2)}`,
  ]) {
    const res = await fetch(base + u);
    assert.equal(res.status, 400, u);
    assert.match((await res.json()).error, /已經過了/);
  }
});

test('a range that is partly past is still searched, and today is fine', async () => {
  const today = todayTW();
  assert.equal((await fetch(`${base}/api/search?origin=TPE&destination=NRT&start=${addDays(today, -3)}&end=${addDays(today, 3)}`)).status, 200);
  assert.equal((await fetch(`${base}/api/search?origin=TPE&destination=NRT&start=${today}`)).status, 200);
});

// B1 (round 8): a visitor west of Taiwan (Americas, or Europe late in the evening) picks their own today, which is
// Taiwan's yesterday; departure days are local to the departure airport, so that is still a valid search.
test("a visitor's local today one day behind Taiwan is still searched", async () => {
  const yesterday = addDays(todayTW(), -1);
  assert.equal((await fetch(`${base}/api/search?origin=YVR&destination=TPE&start=${yesterday}`)).status, 200);
  assert.equal((await fetch(`${base}/api/explore?program=aeroplan&start=${yesterday}&end=${yesterday}`)).status, 200);
});
