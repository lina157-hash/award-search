// Review 4 (2026-10-15) fixes at the HTTP level: the passcode pause cannot lock out the owner (S1), public reads that
// the CDN keeps cannot be skipped with junk parameters (S2), and 今日好康's manual refresh (S5/R9).
// Its own file (own process): the wrong-passcode storm pauses header checks for the rest of the clock hour.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
delete process.env.SEATS_AERO_API_KEY;
delete process.env.CASH_PASSCODE;
delete process.env.RESEND_API_KEY;
delete process.env.CRON_SECRET;
const logs = [];
const origLog = console.log;
console.log = (...a) => { logs.push(a.join(' ')); };
const { server, passBucket } = require('../server');

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => { console.log = origLog; server.close(); });

const call = async (path, { method = 'GET', body, headers = {} } = {}) => {
  const res = await fetch(base + path, { method, redirect: 'manual', headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, headers: res.headers, json: await res.json().catch(() => ({})) };
};
const isoIn = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

test('S1: IPv6 guesses are counted per /64', () => {
  assert.equal(passBucket('2001:db8:1:2::a'), '2001:db8:1:2::/64');
  assert.equal(passBucket('2001:0db8:0001:0002:ffff:0:0:1'), '2001:db8:1:2::/64');
  assert.equal(passBucket('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(passBucket('::ffff:10.1.2.3'), '10.1.2.3');
  assert.equal(passBucket('10.1.2.3'), '10.1.2.3');
  assert.equal(passBucket(''), 'unknown');
});

test('S1: a flood of wrong passcodes does not lock out the owner', async () => {
  process.env.CASH_PASSCODE = 'sunny';
  try {
    const cash = `/api/cash?origin=TPE&destination=NRT&depart=${isoIn(20)}`;
    // The owner: an account unlocked with the passcode, and the address they used it from.
    const own = { 'x-forwarded-for': '10.50.0.1' };
    const email = 'owner-r4@example.com';
    assert.equal((await call('/api/account/signup', { method: 'POST', body: { email, password: 'correct horse' }, headers: own })).status, 200);
    const token = [...logs].reverse().find((l) => l.includes(email) && l.includes('#verify=')).match(/#verify=([\w-]+)/)[1];
    assert.equal((await call('/api/account/verify', { method: 'POST', body: { token }, headers: own })).status, 200);
    const login = await fetch(base + '/api/account/login', { method: 'POST', headers: { 'content-type': 'application/json', ...own }, body: JSON.stringify({ email, password: 'correct horse' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const phone = { cookie, 'x-forwarded-for': '10.70.0.9' }; // the owner's phone, on another network
    assert.equal((await call('/api/account/unlock', { method: 'POST', body: {}, headers: { ...phone, 'x-cash-pass': 'sunny' } })).json.unlocked, true);
    assert.equal((await call(cash, { headers: { ...own, 'x-cash-pass': 'sunny' } })).status, 200);

    // One IPv6 host trying many addresses of its /64 is one guesser.
    const v6 = [];
    for (let i = 1; i <= 6; i++) v6.push((await call(cash, { headers: { 'x-forwarded-for': `2001:db8:1:2::${i}`, 'x-cash-pass': `nope${i}` } })).status);
    assert.deepEqual(v6, [401, 401, 401, 401, 429, 429]);

    // Wrong guesses from many addresses until everyone's header checks are paused.
    let paused = false;
    for (let i = 0; i < 200 && !paused; i++) {
      const r = await call('/api/hotels/accor/debug', { headers: { 'x-cash-pass': `wrong${i}`, 'x-forwarded-for': `10.60.${Math.floor(i / 5)}.1` } });
      paused = r.status === 429 && /暫停驗證/.test(r.json.error);
    }
    assert.ok(paused, 'the pause kicked in');
    const stranger = await call(cash, { headers: { 'x-forwarded-for': '10.80.0.1', 'x-cash-pass': 'sunny' } });
    assert.equal(stranger.status, 429, 'a new address, even with the right passcode, waits');
    // The page always sends the stored passcode next to the cookie: the unlocked account still gets in, from an
    // address that never entered the passcode too (the phone on a café's network).
    const cafe = { cookie, 'x-forwarded-for': '10.90.0.5' };
    assert.equal((await call(cash, { headers: { ...cafe, 'x-requested-with': 'fetch', 'x-cash-pass': 'sunny' } })).status, 200);
    // Not from the page (another site riding on the cookie): still paused.
    assert.equal((await call(cash, { headers: { ...cafe, 'x-cash-pass': 'sunny' } })).status, 429);
    // The addresses that entered the right passcode before are not paused.
    assert.equal((await call(cash, { headers: { ...phone, 'x-cash-pass': 'sunny' } })).status, 200);
    // The address that entered the right passcode before is not paused.
    assert.equal((await call(cash, { headers: { ...own, 'x-cash-pass': 'sunny' } })).status, 200);
  } finally { delete process.env.CASH_PASSCODE; }
});

test('S2: /api/history and /api/cxcal send junk parameters to their canonical address; /api/cxcal is CDN-cached briefly', async () => {
  const h = await call('/api/history?origin=TPE&destination=NRT&_=1');
  assert.equal(h.status, 301);
  assert.equal(h.headers.get('location'), '/api/history?origin=TPE&destination=NRT');
  const c = await call('/api/cxcal?origin=TPE&destination=NRT&_=1');
  assert.equal(c.status, 301);
  assert.equal(c.headers.get('location'), '/api/cxcal?origin=TPE&destination=NRT');
  const ok = await call('/api/cxcal?origin=TPE&destination=NRT&v=123');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'public, max-age=0, s-maxage=60');
  assert.equal((await call('/api/deals?_=1')).status, 301);
});

test('S5/R9: 立即更新 asks seats.aero afresh and says how many groups it refreshed; ?at= gets that copy', async () => {
  const first = await call('/api/deals');
  assert.equal(first.status, 200);
  const r = await call('/api/deals', { method: 'POST', body: {} });
  assert.equal(r.status, 200);
  assert.equal(r.json.refreshed, r.json.groups.length);
  const at = (g) => Date.parse(g.at);
  assert.ok(r.json.groups.every((g, i) => at(g) > at(first.json.groups[i])), 'not the rows kept in memory from the first build');
  // The hour's turn was used.
  assert.equal((await call('/api/deals', { method: 'POST', body: {} })).status, 400);
  const got = await call(`/api/deals?at=${encodeURIComponent(r.json.generatedAt)}`);
  assert.equal(got.json.generatedAt, r.json.generatedAt);
  assert.match(got.headers.get('cache-control'), /s-maxage=3600/);
  // Asking for a copy newer than any there is: served, but not kept by the CDN under that address.
  const ahead = new Date(Date.now() + 30e3).toISOString();
  assert.equal((await call(`/api/deals?at=${encodeURIComponent(ahead)}`)).headers.get('cache-control'), 'no-store');
});
