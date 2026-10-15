// 今日好康每日信 (lib/dealsub.js): subscribing and its checks, the cap, the signed unsubscribe token, the once-a-day send
// (after 08:00 Taiwan time, only with deals, the rest left to the evening run when cut off), the mail itself, and the
// /api/dealsub endpoints.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
delete process.env.SEATS_AERO_API_KEY;
delete process.env.CASH_PASSCODE;
delete process.env.RESEND_API_KEY;
delete process.env.CRON_SECRET;
const logs = [];
const origLog = console.log;
console.log = (...a) => { logs.push(a.join(' ')); };
const { server, dealSub } = require('../server');
const { createDealSub, digestContent, maskEmail } = require('../lib/dealsub');
const { resendMailer } = require('../lib/alerts');
const { memoryKv } = require('../lib/kv');

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => { console.log = origLog; server.close(); });

// 2026-10-15 09:00 Taiwan time (01:00 UTC), just after the morning run.
const MORNING = Date.parse('2026-10-15T01:00:00Z');
const DEALS = {
  generatedAt: '2026-10-15T00:12:00.000Z',
  groups: [
    { id: 'na', name: '北美', cabin: 'J', items: [{ origin: 'TPE', destination: 'YVR', date: '2026-11-03', source: 'aeroplan', miles: 55000, direct: true }, { origin: 'TPE', destination: 'SFO', date: '2026-10-16', source: 'united', miles: 60000 }] },
    { id: 'jk', name: '日韓', cabin: 'J', items: [{ origin: 'TPE', destination: 'NRT', date: '2026-12-01', source: 'alaska', miles: 25000 }] },
    { id: 'eu', name: '歐洲', cabin: 'F', items: [{ origin: 'TPE', destination: 'LHR', date: '2027-01-10', source: 'american', miles: 85000 }] },
    { id: 'oc', name: '澳紐', cabin: 'J', items: [] },
  ],
};

// `tick`: how far the clock moves with each mail sent (to cut a run off at its deadline).
function setup({ t = MORNING, deals = DEALS, cap, batch = false, failBatch = 0, ok = null, notify = {}, tick = 0 } = {}) {
  const clock = { t };
  const kv = memoryKv({ now: () => clock.t });
  const sent = [];
  const batches = [];
  let fails = failBatch;
  const sendEmail = async (m) => { sent.push(m); clock.t += tick; };
  if (batch) sendEmail.batch = async (list) => { if (fails-- > 0) throw new Error('resend down'); batches.push(list); sent.push(...list); };
  const sub = createDealSub({
    kv, loadDeals: async () => deals, sendEmail, notify, cap,
    accountsOk: async (emails) => emails.map((e) => (ok ? ok(e) : true)),
    names: { program: (s) => ({ aeroplan: '加航 Aeroplan' })[s], city: (c) => ({ YVR: '溫哥華' })[c] },
    siteUrl: 'https://radar.example', now: () => clock.t,
  });
  return { sub, kv, sent, batches, clock };
}

test('subscribe and unsubscribe; checks', async () => {
  const { sub } = setup();
  assert.deepEqual(await sub.status('a@x.co'), { cap: 50, mail: true, subscribed: false, full: false, count: 0 });
  assert.equal((await sub.subscribe(' A@X.co ', true)).subscribed, true);
  assert.equal((await sub.status('a@x.co')).subscribed, true);
  assert.equal((await sub.subscribe('a@x.co', true)).count, 1, 'subscribing twice keeps one');
  assert.equal((await sub.subscribe('a@x.co', false)).subscribed, false);
  await assert.rejects(sub.subscribe('', true), { code: 'login-required' });
  const noMail = createDealSub({ kv: memoryKv(), loadDeals: async () => DEALS });
  await assert.rejects(noMail.subscribe('a@x.co', true), { code: 'no-mail', status: 503 });
  assert.equal((await noMail.subscribe('a@x.co', false)).subscribed, false, 'turning it off always works');
});

test('the cap: refused when full, a place frees up on unsubscribe', async () => {
  const { sub } = setup({ cap: 2 });
  await sub.subscribe('a@x.co', true);
  await sub.subscribe('b@x.co', true);
  assert.equal((await sub.status('c@x.co')).full, true);
  await assert.rejects(sub.subscribe('c@x.co', true), (e) => e.code === 'full' && e.status === 409 && /最多 2 人/.test(e.message));
  assert.equal((await sub.subscribe('a@x.co', true)).subscribed, true, 'someone already in stays in');
  await sub.subscribe('a@x.co', false);
  assert.equal((await sub.subscribe('c@x.co', true)).subscribed, true);
  assert.deepEqual((await sub.members()).sort(), ['b@x.co', 'c@x.co']);
});

test('unsubscribe token: signed, one click, no sign-in', async () => {
  const { sub } = setup();
  await sub.subscribe('lina@gmail.com', true);
  await sub.subscribe('ken@gmail.com', true);
  const t = await sub.token('lina@gmail.com');
  assert.match(t, /^[\w-]+\.[\w-]{24}$/);
  assert.equal(t, await sub.token('lina@gmail.com'), 'stable');
  // Another email with lina's signature, a changed signature, garbage: all refused.
  const forged = `${Buffer.from('ken@gmail.com').toString('base64url')}.${t.split('.')[1]}`;
  for (const bad of [forged, t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A'), 'nope', '', null]) await assert.rejects(sub.unsubscribe(bad), { code: 'token' });
  assert.deepEqual(await sub.unsubscribe(t), { ok: true, email: 'l***@gmail.com' });
  assert.deepEqual(await sub.members(), ['ken@gmail.com']);
  assert.deepEqual(await sub.unsubscribe(t), { ok: true, email: 'l***@gmail.com' }, 'clicking again is fine');
  assert.equal(maskEmail('x@y.co'), 'x***@y.co');
});

test('once a day: after 08:00 Taiwan time, only with fresh deals, never twice', async () => {
  const early = setup({ t: Date.parse('2026-10-14T23:30:00Z') }); // 07:30 Taiwan time
  await early.sub.subscribe('a@x.co', true);
  assert.deepEqual(await early.sub.run(), { skipped: 'early' });
  assert.equal(early.sent.length, 0);

  const none = setup({ deals: { generatedAt: DEALS.generatedAt, groups: [{ name: '北美', cabin: 'J', items: [] }] } });
  await none.sub.subscribe('a@x.co', true);
  assert.deepEqual(await none.sub.run(), { skipped: 'no-deals' });
  const stale = setup({ deals: { ...DEALS, generatedAt: '2026-10-14T00:12:00.000Z' } });
  await stale.sub.subscribe('a@x.co', true);
  assert.deepEqual(await stale.sub.run(), { skipped: 'stale' });

  const { sub, sent, clock } = setup();
  await sub.subscribe('a@x.co', true);
  await sub.subscribe('b@x.co', true);
  const r = await sub.run();
  assert.equal(r.mailed, 2);
  assert.equal(r.done, true);
  assert.deepEqual(sent.map((m) => m.to).sort(), ['a@x.co', 'b@x.co']);
  // The evening run (21:10 Taiwan time) the same day sends nothing.
  clock.t = Date.parse('2026-10-15T13:10:00Z');
  assert.equal((await sub.run()).already, true);
  assert.equal(sent.length, 2);
});

test('a cut-off run leaves the rest to the evening run; the next day sends again', async () => {
  let deals = DEALS;
  const { sub, sent, clock, kv } = setup({ tick: 1000 });
  for (const e of ['a@x.co', 'b@x.co', 'c@x.co']) await sub.subscribe(e, true);
  const none = await sub.run({ deadline: clock.t - 1 });
  assert.equal(sent.length, 0, 'nothing started past the deadline');
  assert.deepEqual([none.left, none.done], [3, false]);
  const one = await sub.run({ deadline: clock.t + 500 }); // the first mail moves the clock past it
  assert.deepEqual([one.mailed, one.left, one.done], [1, 2, false]);
  clock.t = Date.parse('2026-10-15T13:10:00Z');
  const evening = await sub.run();
  assert.deepEqual([evening.mailed, evening.done], [2, true]);
  assert.deepEqual(sent.map((m) => m.to).sort(), ['a@x.co', 'b@x.co', 'c@x.co'], 'everyone exactly once');
  assert.ok(await kv.get('dealsub:v1:day:2026-10-15'));
  // Next morning, with the deals refreshed overnight: everyone again.
  clock.t = Date.parse('2026-10-16T00:20:00Z');
  deals = { ...DEALS, generatedAt: '2026-10-16T00:12:00.000Z' };
  const next = createDealSub({ kv, loadDeals: async () => deals, sendEmail: async (m) => { sent.push(m); }, now: () => clock.t });
  assert.equal((await next.run()).mailed, 3);
  assert.equal(sent.length, 6);
});

test('batch sending, retried after a failure; gone accounts dropped', async () => {
  const { sub, sent, batches, clock } = setup({ batch: true, failBatch: 1, ok: (e) => e !== 'gone@x.co' });
  for (const e of ['a@x.co', 'b@x.co', 'gone@x.co']) await sub.subscribe(e, true);
  const r1 = await sub.run();
  assert.equal(r1.errors, 1);
  assert.equal(r1.dropped, 1);
  assert.equal(r1.done, false);
  assert.equal(sent.length, 0);
  assert.deepEqual((await sub.members()).sort(), ['a@x.co', 'b@x.co']);
  clock.t += 12 * 3600e3;
  const r2 = await sub.run();
  assert.equal(r2.mailed, 2);
  assert.equal(batches.length, 1, 'one call for everyone');
  assert.ok(batches[0].every((m) => m.headers['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click' && m.text && m.html));
  assert.equal((await sub.run()).already, true);
});

test("the owner's Telegram and LINE: once a day, only when switched on", async () => {
  const got = { telegram: [], line: [] };
  let tgOk = false;
  const notify = { telegram: async (h) => { got.telegram.push(h); return tgOk; }, line: async (h) => { got.line.push(h); return null; } };
  const { sub, clock } = setup({ notify });
  assert.deepEqual(await sub.ownerPrefs(), { telegram: false, line: false });
  let r = await sub.run();
  assert.equal(got.telegram.length + got.line.length, 0, 'off by default');
  assert.equal(r.done, true);
  clock.t += 86400e3;
  const s2 = setup({ t: clock.t, deals: { ...DEALS, generatedAt: new Date(clock.t - 3600e3).toISOString() }, notify });
  await s2.sub.setOwner({ telegram: true, line: true });
  assert.deepEqual(await s2.sub.setOwner({ line: false }), { telegram: true, line: false });
  await s2.sub.setOwner({ line: true });
  r = await s2.sub.run();
  assert.equal(r.errors, 1, 'Telegram failed: tried again later');
  assert.equal(r.done, false);
  tgOk = true;
  s2.clock.t += 3600e3;
  r = await s2.sub.run();
  assert.equal(r.telegram, true);
  assert.equal(r.done, true);
  assert.equal(got.line.length, 1, 'LINE not linked (null): not asked again');
  assert.equal(got.telegram.length, 2);
  assert.match(got.telegram[1], /今日好康/);
  assert.match(got.telegram[1], /<a href="https:\/\/radar\.example\/\?o=TPE&amp;d=YVR/);
});

test('the mail: deals as on the home page, links, plain-text copy, unsubscribe', () => {
  const c = digestContent(DEALS, { base: 'https://radar.example', today: '2026-10-15', unsubUrl: 'https://radar.example/#unsub=abc.def', names: { program: (s) => ({ aeroplan: '加航 Aeroplan' })[s], city: (x) => ({ YVR: '溫哥華' })[x] } });
  assert.equal(c.count, 4);
  assert.match(c.subject, /今日好康 10\/15（四）/);
  assert.match(c.subject, /商務艙 TPE→NRT 25,000 哩起/);
  assert.match(c.html, /TPE → YVR/);
  assert.match(c.html, /溫哥華/);
  assert.match(c.html, /55,000/);
  assert.match(c.html, /加航 Aeroplan/);
  assert.match(c.html, /頭等艙/);
  // The day three days either side, not before today.
  assert.match(c.html, /o=TPE&amp;d=YVR&amp;s=2026-10-31&amp;e=2026-11-06&amp;c=J#search/);
  assert.match(c.html, /o=TPE&amp;d=SFO&amp;s=2026-10-15&amp;e=2026-10-19&amp;c=J/);
  assert.match(c.html, /o=TPE&amp;d=LHR&amp;s=2027-01-07&amp;e=2027-01-13&amp;c=F/);
  assert.match(c.html, /href="https:\/\/radar\.example\/#unsub=abc\.def"[^>]*>取消訂閱/);
  assert.match(c.text, /【商務艙・北美】/);
  assert.match(c.text, /TPE→YVR 溫哥華 55,000 哩/);
  assert.match(c.text, /取消訂閱（一鍵完成）：https:\/\/radar\.example\/#unsub=abc\.def/);
  assert.doesNotMatch(c.html, /澳紐/, 'empty regions left out');
});

test('Resend helper passes text and List-Unsubscribe, and batches', async () => {
  const calls = [];
  const send = resendMailer({ apiKey: 'k', from: 'R <r@x.co>', fetchImpl: async (url, o) => { calls.push({ url, body: JSON.parse(o.body) }); return { ok: true }; } });
  await send({ to: 'a@x.co', subject: 's', html: '<b>h</b>' });
  assert.deepEqual(calls[0].body, { from: 'R <r@x.co>', to: ['a@x.co'], subject: 's', html: '<b>h</b>' });
  await send.batch([{ to: 'a@x.co', subject: 's', html: 'h', text: 't', headers: { 'List-Unsubscribe': '<u>' } }, { to: 'b@x.co', subject: 's', html: 'h' }]);
  assert.equal(calls[1].url, 'https://api.resend.com/emails/batch');
  assert.equal(calls[1].body.length, 2);
  assert.deepEqual(calls[1].body[0].headers, { 'List-Unsubscribe': '<u>' });
  assert.equal(calls[1].body[0].text, 't');
});

// ---------- endpoints ----------
let ipN = 0;
const client = () => {
  let cookie = '';
  const ip = `10.7.0.${++ipN}`;
  return {
    async call(path, { method = 'GET', body, headers = {}, raw } = {}) {
      const res = await fetch(base + path, { method, redirect: 'manual', headers: { 'x-forwarded-for': ip, 'x-requested-with': 'fetch', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers }, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
      const set = res.headers.get('set-cookie');
      if (set) cookie = /Max-Age=0/.test(set) ? '' : set.split(';')[0];
      return { status: res.status, location: res.headers.get('location'), json: await res.json().catch(() => ({})) };
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

test('/api/dealsub: signed out, subscribe, owner part, unsubscribe link', async () => {
  const anon = client();
  const st = await anon.call('/api/dealsub');
  assert.equal(st.status, 200);
  assert.equal(st.json.configured, true);
  assert.equal(st.json.signedIn, false);
  assert.equal((await anon.call('/api/dealsub', { method: 'POST', body: { on: true } })).json.code, 'login-required');

  const c = client();
  await signedIn(c, 'sub@a.co');
  // Not JSON from the page: refused.
  assert.equal((await c.call('/api/dealsub', { method: 'POST', raw: 'on=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 403);
  const on = await c.call('/api/dealsub', { method: 'POST', body: { on: true } });
  assert.equal(on.status, 200);
  assert.equal(on.json.subscribed, true);
  assert.equal(on.json.email, 'sub@a.co');
  // The demo without a passcode counts everyone as the owner (as for 立即更新): the count and the chats.
  assert.equal(on.json.owner.count, 1);
  assert.equal(typeof on.json.owner.telegram.linked, 'boolean');
  const own = await c.call('/api/dealsub/owner', { method: 'POST', body: { telegram: true } });
  assert.equal(own.json.owner.telegram.on, true);

  // With a passcode: no owner part without it, and /owner refused.
  process.env.CASH_PASSCODE = 'sunny';
  try {
    assert.equal((await c.call('/api/dealsub')).json.owner, undefined);
    assert.equal((await c.call('/api/dealsub/owner', { method: 'POST', body: { telegram: false } })).status, 401);
    assert.equal((await c.call('/api/dealsub', { headers: { 'x-cash-pass': 'sunny' } })).json.owner.count, 1);
  } finally { delete process.env.CASH_PASSCODE; }

  // The unsubscribe link: a plain visit goes to the page, which posts the token; the mail app's one-click post works too.
  const tok = await dealSub.token('sub@a.co');
  const visit = await anon.call(`/api/dealsub/unsubscribe?t=${tok}`);
  assert.equal(visit.status, 302);
  assert.equal(visit.location, `/#unsub=${tok}`);
  const bad = await anon.call('/api/dealsub/unsubscribe', { method: 'POST', body: { t: tok.slice(0, -2) + (tok.endsWith('xx') ? 'yy' : 'xx') } });
  assert.equal(bad.status, 400);
  const done = await anon.call('/api/dealsub/unsubscribe', { method: 'POST', body: { t: tok } });
  assert.deepEqual(done.json, { ok: true, email: 's***@a.co' });
  assert.equal((await c.call('/api/dealsub')).json.subscribed, false);
  await c.call('/api/dealsub', { method: 'POST', body: { on: true } });
  const oneClick = await anon.call(`/api/dealsub/unsubscribe?t=${tok}`, { method: 'POST', raw: 'List-Unsubscribe=One-Click', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(oneClick.status, 200);
  assert.equal((await c.call('/api/dealsub')).json.subscribed, false);
});

test('the daily run has a digest part (skipped before 08:00 Taiwan time, never an error)', async () => {
  const r = await client().call('/api/alerts/run?part=digest');
  assert.equal(r.status, 200);
  assert.equal(typeof r.json.digest, 'object');
  assert.equal(r.json.digest.error, undefined);
  const hour = new Date(Date.now() + 8 * 3600e3).getUTCHours();
  if (hour < 8) assert.deepEqual(r.json.digest, { skipped: 'early' });
});
