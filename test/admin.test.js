// 帳號管理: the set and SCAN helpers of both stores, the account index and its one-time backfill, the owner-only gate
// of /api/admin/accounts, the listing (no secrets), deleting an account and signing all its devices out.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
delete process.env.SEATS_AERO_API_KEY;
delete process.env.CASH_PASSCODE;
delete process.env.RESEND_API_KEY;
delete process.env.CRON_SECRET;
const logs = [];
const origLog = console.log;
console.log = (...a) => { logs.push(a.join(' ')); };
const { server } = require('../server');
const { createAccounts, hashPassword } = require('../lib/accounts');
const { createAdmin } = require('../lib/admin');
const { memoryKv, redisKv } = require('../lib/kv');

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => { console.log = origLog; server.close(); });

let ipN = 0;
const client = () => {
  let cookie = '';
  const ip = `10.9.0.${++ipN}`;
  return {
    async call(path, { method = 'GET', body, headers = {} } = {}) {
      const res = await fetch(base + path, { method, headers: { 'x-forwarded-for': ip, 'x-requested-with': 'fetch', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
      const set = res.headers.get('set-cookie');
      if (set) cookie = /Max-Age=0/.test(set) ? '' : set.split(';')[0];
      return { status: res.status, json: await res.json().catch(() => ({})), text: '' };
    },
  };
};
const linkFor = (email) => {
  const line = [...logs].reverse().find((l) => l.includes(email) && l.includes('#verify='));
  return line && line.match(/#verify=([\w-]+)/)[1];
};
async function signedIn(c, email, password = 'correct horse') {
  assert.equal((await c.call('/api/account/signup', { method: 'POST', body: { email, password } })).status, 200);
  assert.equal((await c.call('/api/account/verify', { method: 'POST', body: { token: linkFor(email) } })).status, 200);
  assert.equal((await c.call('/api/account/login', { method: 'POST', body: { email, password } })).status, 200);
}
const withPass = async (pass, fn) => {
  process.env.CASH_PASSCODE = pass;
  try { await fn(); } finally { delete process.env.CASH_PASSCODE; }
};

test('memory store: sets and SCAN', async () => {
  let t = 1000;
  const kv = memoryKv({ now: () => t });
  assert.equal(await kv.sadd('s', 'a', 'b', 'a'), 2);
  assert.equal(await kv.sadd('s', 'b', 'c'), 1);
  assert.deepEqual((await kv.smembers('s')).sort(), ['a', 'b', 'c']);
  assert.equal(await kv.srem('s', 'a', 'zz'), 1);
  assert.deepEqual((await kv.smembers('nope')), []);
  await kv.set('acct:v1:user:x@y.co', {});
  await kv.set('acct:v1:user:gone@y.co', {}, { ex: 1 });
  await kv.set('acct:v1:sess:abc', {});
  await kv.sadd('acct:v1:index', 'x@y.co');
  t += 5000; // the short-lived key has expired
  assert.deepEqual(await kv.scan('acct:v1:user:*'), ['acct:v1:user:x@y.co']);
  assert.deepEqual((await kv.scan('acct:v1:*')).sort(), ['acct:v1:index', 'acct:v1:sess:abc', 'acct:v1:user:x@y.co']);
  assert.deepEqual(await kv.scan('acct:v1:user:?@y.co'), ['acct:v1:user:x@y.co']);
  await kv.del('s');
  assert.deepEqual(await kv.smembers('s'), []);
});

test('Redis store: SCAN follows the cursor to the end; set commands', async () => {
  const sent = [];
  const pages = { 0: ['7', ['acct:v1:user:a@b.co', 'acct:v1:user:c@d.co']], 7: ['0', ['acct:v1:user:a@b.co', 'acct:v1:user:e@f.co']] };
  const fetchImpl = async (_url, { body }) => {
    const args = JSON.parse(body);
    sent.push(args);
    const result = args[0] === 'SCAN' ? pages[args[1]] : args[0] === 'SMEMBERS' ? ['a@b.co'] : 1;
    return { ok: true, json: async () => ({ result }) };
  };
  const kv = redisKv({ url: 'https://redis.example', token: 't', fetchImpl });
  assert.deepEqual(await kv.scan('acct:v1:user:*', { count: 100 }), ['acct:v1:user:a@b.co', 'acct:v1:user:c@d.co', 'acct:v1:user:e@f.co']);
  assert.deepEqual(sent.slice(0, 2), [['SCAN', '0', 'MATCH', 'acct:v1:user:*', 'COUNT', 100], ['SCAN', '7', 'MATCH', 'acct:v1:user:*', 'COUNT', 100]]);
  assert.equal(await kv.sadd('i', 'a@b.co', 'c@d.co'), 1);
  assert.deepEqual(sent.at(-1), ['SADD', 'i', 'a@b.co', 'c@d.co']);
  assert.equal(await kv.sadd('i'), 0, 'nothing to add sends nothing');
  assert.deepEqual(await kv.smembers('i'), ['a@b.co']);
  await kv.srem('i', 'a@b.co');
  assert.deepEqual(sent.at(-1), ['SREM', 'i', 'a@b.co']);
  // A store that never ends its SCAN cannot hold the function: bounded steps.
  const loop = redisKv({ url: 'u', token: 't', fetchImpl: async () => ({ ok: true, json: async () => ({ result: ['5', ['k']] }) }) });
  assert.deepEqual(await loop.scan('*', { maxSteps: 3 }), ['k']);
});

test('the index: kept on signup and delete, backfilled once from accounts made before it', async () => {
  let t = Date.parse('2026-10-15T00:00:00Z');
  const kv = memoryKv({ now: () => t });
  const accounts = createAccounts({ kv, now: () => t });
  // Two accounts from before the index existed.
  await kv.set('acct:v1:user:old@a.co', { email: 'old@a.co', hash: await hashPassword('12345678'), verified: true, createdAt: '2026-01-02T00:00:00.000Z' });
  await kv.set('acct:v1:user:older@a.co', { email: 'older@a.co', hash: await hashPassword('12345678'), verified: false, createdAt: '2025-12-01T00:00:00.000Z' });
  await accounts.signup({ email: 'New@A.co', password: '12345678' }, { ip: '1.1.1.1', base: 'http://x' });
  assert.deepEqual(await kv.smembers('acct:v1:index'), ['new@a.co']);
  const admin = createAdmin({ kv, accounts, now: () => t });
  assert.deepEqual(await admin.backfill(), { added: 2 });
  assert.deepEqual((await kv.smembers('acct:v1:index')).sort(), ['new@a.co', 'old@a.co', 'older@a.co']);
  // Once only: a later account made outside signup is not picked up by a second, cheaper call.
  await kv.set('acct:v1:user:sneaky@a.co', { email: 'sneaky@a.co' });
  assert.deepEqual(await admin.backfill(), { added: 0 });
  assert.equal((await admin.list()).totals.accounts, 3);
  assert.deepEqual(await admin.backfill({ force: true }), { added: 1 });
  // An index entry whose account is gone is dropped when listed.
  await kv.del('acct:v1:user:sneaky@a.co');
  assert.equal((await admin.list()).totals.accounts, 3);
  assert.ok(!(await kv.smembers('acct:v1:index')).includes('sneaky@a.co'));
  // Deleting one's own account takes it out of the index.
  const login = await accounts.login({ email: 'old@a.co', password: '12345678' }, { ip: '1.1.1.2' });
  await accounts.remove(await accounts.session(login.sid), { password: '12345678' }, { ip: '1.1.1.2' });
  assert.ok(!(await kv.smembers('acct:v1:index')).includes('old@a.co'));
  assert.equal(await kv.get('acct:v1:login:old@a.co'), null);
});

test('the listing: counts and dates, never a hash, session or token', async () => {
  let t = Date.parse('2026-10-15T08:00:00Z');
  const kv = memoryKv({ now: () => t });
  const accounts = createAccounts({ kv, now: () => t });
  await accounts.signup({ email: 'lina@a.co', password: 'correct horse' }, { ip: '2.2.2.1', base: 'http://x' });
  await accounts.signup({ email: 'ken@a.co', password: 'correct horse' }, { ip: '2.2.2.2', base: 'http://x' });
  await kv.set('acct:v1:user:early@a.co', { email: 'early@a.co', hash: await hashPassword('12345678'), verified: false, createdAt: '2026-09-01T00:00:00.000Z' });
  t += 3600e3;
  const a = await accounts.login({ email: 'lina@a.co', password: 'correct horse', remember: true }, { ip: '2.2.2.1', ua: 'phone' });
  await accounts.login({ email: 'lina@a.co', password: 'correct horse' }, { ip: '2.2.2.1', ua: 'laptop' });
  const sess = await accounts.session(a.sid);
  await accounts.markUnlocked(sess, 'sunny');
  await accounts.putData(sess, { rev: 0, data: { 'wallet:v1': { miles: { cx: 50000, br: 2000 }, banks: { ctbc: 1 } }, favSearches: ['o=TPE&d=NRT', 'o=TPE&d=LHR'], recentSearches: ['o=TPE&d=HND'], 'plan:v1': { legs: [{}, {}, {}] }, alertEmail: 'Lina+alerts@a.co' } });
  const admin = createAdmin({ kv, accounts, passcode: () => 'sunny', now: () => t, alertEmails: async () => ['lina@a.co', 'lina+alerts@a.co', 'other@x.co', 'LINA@a.co'] });
  const out = await admin.list();
  assert.deepEqual(out.totals, { accounts: 3, verified: 2, last7: 2 });
  const lina = out.accounts.find((x) => x.email === 'lina@a.co');
  assert.deepEqual(Object.keys(lina).sort(), ['alerts', 'createdAt', 'email', 'lastLoginAt', 'sessions', 'synced', 'unlocked', 'verified']);
  assert.equal(lina.verified, true);
  assert.equal(lina.sessions, 2);
  assert.equal(lina.unlocked, true);
  assert.equal(lina.lastLoginAt, new Date(t).toISOString());
  assert.equal(lina.alerts, 3, 'alerts to the account email and to its notification email');
  assert.deepEqual({ ...lina.synced, bytes: lina.synced.bytes > 0 }, { at: new Date(t).toISOString(), bytes: true, wallet: 3, routes: 2, recent: 1, trips: 3 });
  const early = out.accounts.find((x) => x.email === 'early@a.co');
  assert.deepEqual([early.verified, early.lastLoginAt, early.sessions, early.synced, early.unlocked], [false, null, 0, null, false]);
  assert.equal(out.accounts.at(-1).email, 'early@a.co', 'newest first');
  // A changed passcode: no longer counts as unlocked.
  assert.equal((await createAdmin({ kv, accounts, passcode: () => 'rainy', now: () => t }).list()).accounts.find((x) => x.email === 'lina@a.co').unlocked, false);
  const text = JSON.stringify(out);
  for (const bad of ['scrypt', '"hash"', 'unlock"', a.sid, 'verifyNonce', 'phone', 'laptop', '"h"']) assert.ok(!text.includes(bad), `leaks ${bad}`);
});

test('delete and sign-out remove exactly what they say', async () => {
  const t = Date.parse('2026-10-15T08:00:00Z');
  const kv = memoryKv({ now: () => t });
  const accounts = createAccounts({ kv, now: () => t });
  await accounts.signup({ email: 'a@a.co', password: '12345678' }, { ip: '3.3.3.1', base: 'http://x' });
  const s1 = await accounts.login({ email: 'a@a.co', password: '12345678' }, { ip: '3.3.3.1' });
  const s2 = await accounts.login({ email: 'a@a.co', password: '12345678' }, { ip: '3.3.3.1' });
  await accounts.putData(await accounts.session(s1.sid), { rev: 0, data: { favSearches: ['o=TPE&d=NRT'] } });
  const admin = createAdmin({ kv, accounts, now: () => t });
  assert.deepEqual(await admin.signOut('A@a.co'), { ok: true, signedOut: 2 });
  assert.equal(await accounts.session(s1.sid), null);
  assert.equal(await accounts.session(s2.sid), null);
  assert.ok(await kv.get('acct:v1:user:a@a.co'), 'the account stays');
  assert.ok(await kv.get('acct:v1:data:a@a.co'), 'and its data');
  const s3 = await accounts.login({ email: 'a@a.co', password: '12345678' }, { ip: '3.3.3.1' });
  assert.deepEqual(await admin.remove('a@a.co'), { ok: true });
  assert.equal(await accounts.session(s3.sid), null);
  assert.deepEqual(await kv.scan('acct:v1:*'), [], 'nothing of the account is left');
  await assert.rejects(admin.remove('a@a.co'), { status: 404 });
  await assert.rejects(admin.signOut(''), { status: 400 });
});

test('/api/admin/accounts: owner only (the passcode), from the page; normal users never get in', async () => {
  const user = client();
  await signedIn(user, 'visitor@example.com');
  const anon = client();
  await withPass('sunny', async () => {
    assert.equal((await anon.call('/api/admin/accounts')).status, 401);
    const asUser = await user.call('/api/admin/accounts');
    assert.equal(asUser.status, 401);
    assert.equal(asUser.json.accounts, undefined);
    assert.equal((await client().call('/api/admin/accounts', { headers: { 'x-cash-pass': 'guess' } })).status, 401);
    assert.equal((await user.call('/api/admin/accounts/delete', { method: 'POST', body: { email: 'visitor@example.com' } })).status, 401);
    assert.equal((await user.call('/api/admin/accounts/signout', { method: 'POST', body: { email: 'visitor@example.com' } })).status, 401);
    assert.equal((await user.call('/api/account')).json.loggedIn, true, 'still there');
    // The cron's secret is not the owner.
    process.env.CRON_SECRET = 'cron-test';
    try { assert.equal((await anon.call('/api/admin/accounts', { headers: { authorization: 'Bearer cron-test' } })).status, 403); } finally { delete process.env.CRON_SECRET; }

    const owner = client();
    const pass = { 'x-cash-pass': 'sunny' };
    const list = await owner.call('/api/admin/accounts', { headers: pass });
    assert.equal(list.status, 200);
    const v = list.json.accounts.find((x) => x.email === 'visitor@example.com');
    assert.deepEqual([v.verified, v.sessions], [true, 1]);
    assert.ok(list.json.totals.accounts >= 1);
    assert.ok(!JSON.stringify(list.json).includes('scrypt'));
    // Changes need JSON from the page itself.
    const form = await fetch(`${base}/api/admin/accounts/delete`, { method: 'POST', headers: { ...pass, 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=visitor@example.com' });
    assert.equal(form.status, 403);
    assert.equal((await owner.call('/api/admin/accounts', { method: 'DELETE', headers: pass })).status, 405);

    assert.deepEqual((await owner.call('/api/admin/accounts/signout', { method: 'POST', body: { email: 'visitor@example.com' }, headers: pass })).json, { ok: true, signedOut: 1 });
    assert.equal((await user.call('/api/account')).json.loggedIn, false, 'signed out everywhere');
    assert.equal((await owner.call('/api/admin/accounts/delete', { method: 'POST', body: { email: 'visitor@example.com' }, headers: pass })).status, 200);
    assert.equal((await owner.call('/api/admin/accounts/delete', { method: 'POST', body: { email: 'visitor@example.com' }, headers: pass })).status, 404);
    assert.ok(!(await owner.call('/api/admin/accounts', { headers: pass })).json.accounts.some((x) => x.email === 'visitor@example.com'));
    assert.equal((await user.call('/api/account/login', { method: 'POST', body: { email: 'visitor@example.com', password: 'correct horse' } })).status, 401, 'the account is gone');
  });
});

test('/api/admin/accounts: a signed-in account unlocked with the passcode gets in from the page', async () => {
  const owner = client();
  await signedIn(owner, 'owner@example.com');
  await withPass('sunny', async () => {
    assert.equal((await owner.call('/api/account/unlock', { method: 'POST', body: {}, headers: { 'x-cash-pass': 'sunny' } })).json.unlocked, true);
    const r = await owner.call('/api/admin/accounts');
    assert.equal(r.status, 200);
    assert.equal(r.json.accounts.find((x) => x.email === 'owner@example.com').unlocked, true);
    // Without the page's header (a link or form from another site riding on the cookie): no.
    assert.equal((await owner.call('/api/admin/accounts', { headers: { 'x-requested-with': '' } })).status, 401);
  });
});

test('/api/admin/accounts: the in-memory demo without a passcode is open (demo accounts only)', async () => {
  const r = await client().call('/api/admin/accounts');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.accounts));
});
