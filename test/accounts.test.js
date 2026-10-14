// Optional accounts: password hashing, the cookie session, limits, single-use reset links, sync revisions and the
// passcode unlock that follows the account.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
delete process.env.SEATS_AERO_API_KEY;
delete process.env.CASH_PASSCODE;
delete process.env.RESEND_API_KEY;
const logs = [];
const origLog = console.log;
console.log = (...a) => { logs.push(a.join(' ')); };
const { server } = require('../server');
const { createAccounts, hashPassword, verifyPassword } = require('../lib/accounts');
const { memoryKv } = require('../lib/kv');

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => { console.log = origLog; server.close(); });

let ipN = 0;
// Each test pretends to come from its own address, so the per-IP limits of one test do not spill into another.
const client = () => {
  let cookie = '';
  const ip = `10.0.0.${++ipN}`;
  return {
    get cookie() { return cookie; },
    async call(path, { method = 'GET', body, headers = {} } = {}) {
      const res = await fetch(base + path, { method, headers: { 'x-forwarded-for': ip, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
      const set = res.headers.get('set-cookie');
      if (set) cookie = /Max-Age=0/.test(set) ? '' : set.split(';')[0];
      return { status: res.status, headers: res.headers, set, json: await res.json().catch(() => ({})) };
    },
  };
};
const linkFor = (email, kind) => {
  const line = [...logs].reverse().find((l) => l.includes(email) && l.includes(`#${kind}=`));
  return line && line.match(new RegExp(`#${kind}=([\\w-]+)`))[1];
};
async function signedUp(c, email, password = 'correct horse') {
  assert.equal((await c.call('/api/account/signup', { method: 'POST', body: { email, password } })).status, 200);
  assert.equal((await c.call('/api/account/verify', { method: 'POST', body: { token: linkFor(email, 'verify') } })).status, 200);
}

test('passwords are scrypt-hashed with their own salt and checked in constant time', async () => {
  const a = await hashPassword('hunter2hunter2');
  const b = await hashPassword('hunter2hunter2');
  assert.notEqual(a, b, 'a fresh salt each time');
  assert.match(a, /^scrypt\$16384\$8\$1\$/);
  assert.ok(!a.includes('hunter2'));
  assert.equal(await verifyPassword('hunter2hunter2', a), true);
  assert.equal(await verifyPassword('hunter2hunter3', a), false);
  assert.equal(await verifyPassword('x', 'garbage'), false);
});

test('signup, verify, login with a cookie, status, logout', async () => {
  const c = client();
  const email = 'Lina@Example.com';
  const s = await c.call('/api/account/signup', { method: 'POST', body: { email, password: 'correct horse' } });
  assert.deepEqual(s.json, { ok: true, verifyNeeded: true });
  assert.equal(s.headers.get('cache-control'), 'no-store');
  assert.equal((await c.call('/api/account/signup', { method: 'POST', body: { email: 'x@y.co', password: 'short' } })).status, 400);
  // Not verified yet.
  assert.equal((await c.call('/api/account/login', { method: 'POST', body: { email, password: 'correct horse' } })).json.code, 'unverified');
  const t = linkFor('lina@example.com', 'verify');
  assert.ok(t, 'the demo prints the link');
  assert.equal((await c.call('/api/account/verify', { method: 'POST', body: { token: t } })).json.email, 'lina@example.com');
  assert.equal((await c.call('/api/account/verify', { method: 'POST', body: { token: t } })).status, 400, 'single use');
  const bad = await c.call('/api/account/login', { method: 'POST', body: { email, password: 'wrong horse' } });
  const none = await c.call('/api/account/login', { method: 'POST', body: { email: 'nobody@example.com', password: 'wrong horse' } });
  assert.deepEqual([bad.status, none.status, bad.json.error], [401, 401, none.json.error], 'same answer whether or not the email exists');
  const ok = await c.call('/api/account/login', { method: 'POST', body: { email: ' LINA@example.com ', password: 'correct horse', remember: true } });
  assert.equal(ok.status, 200);
  assert.match(ok.set, /^sid=[\w-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000$/);
  assert.deepEqual([ok.json.loggedIn, ok.json.email, ok.json.verified, ok.json.unlocked, ok.json.devices], [true, 'lina@example.com', true, false, 1]);
  const me = await c.call('/api/account');
  assert.equal(me.json.loggedIn, true);
  // A session-only login has no Max-Age.
  const c2 = client();
  assert.doesNotMatch((await c2.call('/api/account/login', { method: 'POST', body: { email, password: 'correct horse' } })).set, /Max-Age/);
  assert.equal((await c2.call('/api/account')).json.devices, 2);
  assert.match((await c.call('/api/account/logout', { method: 'POST', body: {} })).set, /Max-Age=0/);
  assert.equal((await c.call('/api/account')).json.loggedIn, false);
  assert.equal((await client().call('/api/account')).json.loggedIn, false);
});

test('state changes need JSON from this site', async () => {
  const c = client();
  const form = await fetch(`${base}/api/account/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=a&password=b' });
  assert.equal(form.status, 403);
  const cross = await c.call('/api/account/login', { method: 'POST', body: { email: 'a@b.co', password: 'xxxxxxxx' }, headers: { origin: 'https://evil.example' } });
  assert.equal(cross.status, 403);
  const same = await c.call('/api/account/login', { method: 'POST', body: { email: 'a@b.co', password: 'xxxxxxxx' }, headers: { origin: base } });
  assert.equal(same.status, 401);
});

test('login, signup and forgot are rate limited per address and per email', async () => {
  const c = client();
  let last;
  for (let i = 0; i < 11; i++) last = await c.call('/api/account/login', { method: 'POST', body: { email: `who${i}@example.com`, password: 'nope nope' } });
  assert.equal(last.status, 429);
  assert.equal(last.json.code, 'rate');
  // Per email, from many addresses: wrong passwords only, 20 per 15 minutes.
  const statuses = [];
  for (let i = 0; i < 21; i++) statuses.push((await client().call('/api/account/login', { method: 'POST', body: { email: 'target@example.com', password: 'nope nope' } })).status);
  assert.equal(statuses.at(-1), 429);
  const f = [];
  for (let i = 0; i < 6; i++) f.push((await client().call('/api/account/forgot', { method: 'POST', body: { email: 'target2@example.com' } })).status);
  assert.deepEqual(f, [200, 200, 200, 200, 200, 429]);
});

test('password reset: generic answer, single-use link, other sessions signed out', async () => {
  const c = client();
  const email = 'reset@example.com';
  await signedUp(c, email);
  await c.call('/api/account/login', { method: 'POST', body: { email, password: 'correct horse', remember: true } });
  assert.deepEqual((await client().call('/api/account/forgot', { method: 'POST', body: { email: 'ghost@example.com' } })).json, { ok: true });
  assert.ok(!linkFor('ghost@example.com', 'reset'), 'no mail for an unknown email');
  assert.deepEqual((await client().call('/api/account/forgot', { method: 'POST', body: { email } })).json, { ok: true });
  const t = linkFor(email, 'reset');
  const r = client();
  assert.equal((await r.call('/api/account/reset', { method: 'POST', body: { token: t, password: 'battery staple' } })).status, 200);
  assert.equal((await r.call('/api/account/reset', { method: 'POST', body: { token: t, password: 'another one!' } })).status, 400, 'a reset link works once');
  assert.equal((await c.call('/api/account')).json.loggedIn, false, 'the old session is gone');
  assert.equal((await r.call('/api/account/login', { method: 'POST', body: { email, password: 'correct horse' } })).status, 401);
  assert.equal((await r.call('/api/account/login', { method: 'POST', body: { email, password: 'battery staple' } })).status, 200);
  // Change the password: this device stays signed in, others are signed out.
  const other = client();
  await other.call('/api/account/login', { method: 'POST', body: { email, password: 'battery staple' } });
  assert.equal((await r.call('/api/account/password', { method: 'POST', body: { old: 'wrong', new: 'new password 1' } })).status, 401);
  assert.equal((await r.call('/api/account/password', { method: 'POST', body: { old: 'battery staple', new: 'new password 1' } })).status, 200);
  assert.equal((await r.call('/api/account')).json.loggedIn, true);
  assert.equal((await other.call('/api/account')).json.loggedIn, false);
  // Delete the account (password needed).
  assert.equal((await r.call('/api/account', { method: 'DELETE', body: { password: 'nope' } })).status, 401);
  assert.equal((await r.call('/api/account', { method: 'DELETE', body: { password: 'new password 1' } })).status, 200);
  assert.equal((await r.call('/api/account/login', { method: 'POST', body: { email, password: 'new password 1' } })).status, 401);
});

test('sync: one blob per account, saved only on the revision the device last saw', async () => {
  const a = client();
  const b = client();
  const email = 'sync@example.com';
  await signedUp(a, email);
  for (const c of [a, b]) await c.call('/api/account/login', { method: 'POST', body: { email, password: 'correct horse' } });
  assert.equal((await client().call('/api/account/data')).status, 401);
  assert.deepEqual((await a.call('/api/account/data')).json, { data: {}, rev: 0, syncedAt: null });
  const put = await a.call('/api/account/data', { method: 'PUT', body: { rev: 0, data: { 'wallet:v1': { cathay: 12000 }, favSearches: ['TPE-NRT'] } } });
  assert.equal(put.json.rev, 1);
  const stale = await b.call('/api/account/data', { method: 'PUT', body: { rev: 0, data: { 'plan:v1': { name: 'x' } } } });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, 'conflict');
  assert.deepEqual([stale.json.rev, stale.json.data.favSearches], [1, ['TPE-NRT']], 'the current copy comes back to merge');
  assert.equal((await b.call('/api/account/data', { method: 'PUT', body: { rev: 1, data: { ...stale.json.data, 'plan:v1': { name: 'x' } } } })).json.rev, 2);
  assert.ok((await a.call('/api/account')).json.syncedAt);
  for (const data of [{ cashPass: 'pw' }, { 'bad key!': 1 }, [1, 2]]) assert.equal((await a.call('/api/account/data', { method: 'PUT', body: { rev: 2, data } })).status, 400, JSON.stringify(data));
  assert.equal((await a.call('/api/account/data', { method: 'PUT', body: { rev: 2, data: { big: 'x'.repeat(210_000) } } })).status, 413);
});

test('a passcode entered once while signed in unlocks the account on every device, not the passcode itself', async () => {
  const a = client();
  const b = client();
  const email = 'owner@example.com';
  await signedUp(a, email);
  for (const c of [a, b]) await c.call('/api/account/login', { method: 'POST', body: { email, password: 'correct horse' } });
  const cash = `/api/cash?origin=TPE&destination=NRT&depart=${new Date(Date.now() + 20 * 864e5).toISOString().slice(0, 10)}`;
  process.env.CASH_PASSCODE = 'sunny';
  try {
    assert.equal((await b.call(cash)).status, 401);
    assert.equal((await a.call('/api/account/unlock', { method: 'POST', body: {}, headers: { 'x-cash-pass': 'wrong' } })).status, 401);
    const un = await a.call('/api/account/unlock', { method: 'POST', body: {}, headers: { 'x-cash-pass': 'sunny' } });
    assert.equal(un.json.unlocked, true);
    const page = { headers: { 'x-requested-with': 'fetch' } };
    assert.equal((await b.call(cash, page)).status, 200, 'the other device passes without the header');
    assert.equal((await b.call('/api/account')).json.unlocked, true);
    assert.equal((await client().call(cash, page)).status, 401, 'signed-out visitors still need it');
    process.env.CASH_PASSCODE = 'rainy';
    assert.equal((await b.call(cash, page)).status, 401, 'a new passcode needs entering again');
  } finally { delete process.env.CASH_PASSCODE; }
  // The unlock is kept as a salted scrypt hash, not the passcode.
  const kv = memoryKv();
  const acc = createAccounts({ kv, log: () => {} });
  await kv.set('acct:v1:user:x@y.co', { email: 'x@y.co', hash: await hashPassword('12345678'), verified: true });
  const { sid } = await acc.login({ email: 'x@y.co', password: '12345678' }, { ip: '1' });
  await acc.markUnlocked(await acc.session(sid), 'sunny');
  const stored = JSON.stringify(await kv.get('acct:v1:user:x@y.co'));
  assert.ok(!stored.includes('sunny'));
  assert.match(stored, /"unlock":"scrypt\$/);
});

test('config reports accounts; public answers stay cacheable with a cookie', async () => {
  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.equal(cfg.accounts, true);
  const c = client();
  await signedUp(c, 'cache@example.com');
  await c.call('/api/account/login', { method: 'POST', body: { email: 'cache@example.com', password: 'correct horse' } });
  const r = await c.call('/api/fx');
  assert.match(r.headers.get('cache-control'), /public/);
  assert.equal(r.headers.get('vary'), null);
  assert.equal((await c.call('/api/account')).headers.get('cache-control'), 'no-store');
});

test('A1: a second signup for an unverified email replaces the password, and only the newest link verifies', async () => {
  const email = 'victim@example.com';
  const attacker = client();
  await attacker.call('/api/account/signup', { method: 'POST', body: { email, password: 'attacker pw 1' } });
  const old = linkFor(email, 'verify');
  const victim = client();
  const s = await victim.call('/api/account/signup', { method: 'POST', body: { email, password: 'victim pw 123' } });
  assert.deepEqual(s.json, { ok: true, verifyNeeded: true }, 'the same answer as a new signup');
  const fresh = linkFor(email, 'verify');
  assert.notEqual(old, fresh);
  assert.equal((await attacker.call('/api/account/verify', { method: 'POST', body: { token: old } })).status, 400, 'the older link no longer works');
  assert.equal((await victim.call('/api/account/verify', { method: 'POST', body: { token: fresh } })).status, 200);
  assert.equal((await attacker.call('/api/account/login', { method: 'POST', body: { email, password: 'attacker pw 1' } })).status, 401);
  assert.equal((await victim.call('/api/account/login', { method: 'POST', body: { email, password: 'victim pw 123' } })).status, 200);
  // A verified account is left alone by a later signup.
  await client().call('/api/account/signup', { method: 'POST', body: { email, password: 'attacker pw 2' } });
  assert.equal((await client().call('/api/account/login', { method: 'POST', body: { email, password: 'victim pw 123' } })).status, 200);
});

test('A2: a password change ends sessions that fell off the device list too', async () => {
  const kv = memoryKv();
  let clock = Date.parse('2026-10-01T00:00:00Z');
  const acc = createAccounts({ kv, log: () => {}, now: () => clock });
  await kv.set('acct:v1:user:a@b.co', { email: 'a@b.co', hash: await hashPassword('12345678'), verified: true });
  const first = (await acc.login({ email: 'a@b.co', password: '12345678', remember: true }, { ip: 'ip0' })).sid;
  for (let i = 1; i <= 21; i++) { clock += 1000; await acc.login({ email: 'a@b.co', password: '12345678', remember: true }, { ip: `ip${i}` }); }
  clock += 1000;
  const mine = await acc.login({ email: 'a@b.co', password: '12345678' }, { ip: 'me' });
  assert.ok(await acc.session(first), 'still valid before the change');
  clock += 1000;
  await acc.changePassword(await acc.session(mine.sid), { old: '12345678', new: 'abcdefgh' }, { ip: 'me' });
  assert.equal(await acc.session(first), null, 'off the 20-entry list, but older than the new password');
  assert.ok(await acc.session(mine.sid), 'the device that changed it stays signed in');
  clock += 1000;
  assert.ok(await acc.session((await acc.login({ email: 'a@b.co', password: 'abcdefgh' }, { ip: 'x' })).sid));
});

test('A6/A10: account mails are capped per day; an existing email takes the same path through hashing', async () => {
  const kv = memoryKv();
  const sent = [];
  const acc = createAccounts({ kv, sendMail: async (m) => { sent.push(m.to); }, mailCap: 2 });
  for (const e of ['a@x.co', 'b@x.co']) assert.deepEqual(await acc.signup({ email: e, password: '12345678' }, { ip: e, base: 'https://x' }), { ok: true, verifyNeeded: true });
  await assert.rejects(acc.signup({ email: 'c@x.co', password: '12345678' }, { ip: 'c', base: 'https://x' }), (e) => e.status === 429);
  await assert.rejects(acc.forgot({ email: 'nobody@x.co' }, { ip: 'd', base: 'https://x' }), (e) => e.status === 429, 'refused the same way whether or not the account exists');
  assert.deepEqual(sent, ['a@x.co', 'b@x.co']);
});

test('A9: a malformed unrelated cookie does not break sign-in', async () => {
  const c = client();
  await signedUp(c, 'cookie@example.com');
  await c.call('/api/account/login', { method: 'POST', body: { email: 'cookie@example.com', password: 'correct horse' } });
  const r = await c.call('/api/account', { headers: { cookie: `promo=50%; ${c.cookie}; x=%E0%A4%A` } });
  assert.equal(r.status, 200);
  assert.equal(r.json.loggedIn, true);
});

test('A3: five wrong passcodes from one address lock it out for 15 minutes; the right one resets the count', async () => {
  const cash = `/api/cash?origin=TPE&destination=NRT&depart=${new Date(Date.now() + 20 * 864e5).toISOString().slice(0, 10)}`;
  process.env.CASH_PASSCODE = 'sunny';
  try {
    const c = client();
    await signedUp(c, 'guess@example.com');
    await c.call('/api/account/login', { method: 'POST', body: { email: 'guess@example.com', password: 'correct horse' } });
    const wrong = () => c.call(cash, { headers: { 'x-cash-pass': 'guess' } });
    const first = await wrong();
    assert.deepEqual([first.status, first.json.code, first.json.error], [401, 'passcode', '通關密碼不對，還可以再試 4 次']);
    await wrong();
    // The right passcode starts the count again.
    assert.equal((await c.call(cash, { headers: { 'x-cash-pass': 'sunny' } })).status, 200);
    const tries = [];
    for (let i = 0; i < 4; i++) tries.push(await wrong());
    tries.push(await c.call('/api/account/unlock', { method: 'POST', body: {}, headers: { 'x-cash-pass': 'guess' } }));
    assert.deepEqual(tries.map((t) => t.status), [401, 401, 401, 401, 429]);
    assert.equal(tries[3].json.error, '通關密碼不對，還可以再試 1 次');
    assert.match(tries[4].json.error, /請 15 分鐘後再試/);
    // Locked: even the right passcode is not checked, and account unlock counts the same.
    assert.equal((await c.call(cash, { headers: { 'x-cash-pass': 'sunny' } })).status, 429);
    assert.equal((await c.call('/api/account/unlock', { method: 'POST', body: {}, headers: { 'x-cash-pass': 'sunny' } })).status, 429);
    // Another address is not affected.
    assert.equal((await client().call(cash, { headers: { 'x-cash-pass': 'sunny' } })).status, 200);
  } finally { delete process.env.CASH_PASSCODE; }
});

test('A4: an unlocked session counts only on requests from the page itself', async () => {
  const c = client();
  await signedUp(c, 'csrf@example.com');
  await c.call('/api/account/login', { method: 'POST', body: { email: 'csrf@example.com', password: 'correct horse' } });
  const cash = `/api/cash?origin=TPE&destination=NRT&depart=${new Date(Date.now() + 25 * 864e5).toISOString().slice(0, 10)}`;
  process.env.CASH_PASSCODE = 'sunny';
  try {
    assert.equal((await c.call('/api/account/unlock', { method: 'POST', body: {}, headers: { 'x-cash-pass': 'sunny' } })).json.unlocked, true);
    // A link or form on another site: the cookie alone.
    assert.equal((await c.call(cash)).status, 401);
    assert.equal((await c.call('/api/alerts/run', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 401);
    assert.equal((await c.call(cash, { headers: { 'x-requested-with': 'fetch', 'sec-fetch-site': 'cross-site' } })).status, 401);
    // The page's own fetch.
    assert.equal((await c.call(cash, { headers: { 'x-requested-with': 'fetch', 'sec-fetch-site': 'same-origin' } })).status, 200);
    assert.equal((await c.call('/api/alerts/run', { headers: { 'x-requested-with': 'fetch' } })).status, 200);
  } finally { delete process.env.CASH_PASSCODE; }
});
