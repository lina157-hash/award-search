// LINE notifications: webhook signature, linking by one-time code, the monthly push cap, and the demo routes.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
delete process.env.SEATS_AERO_API_KEY;
delete process.env.CASH_PASSCODE;
delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
delete process.env.LINE_CHANNEL_SECRET;
const { server } = require('../server');
const { lineClient, createLine, verifySignature, htmlToText, LINKED_TEXT, TEST_TEXT, BAD_CODE_TEXT } = require('../lib/line');
const { memoryKv } = require('../lib/kv');

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

const SECRET = 'test-channel-secret';
const sign = (body, secret = SECRET) => crypto.createHmac('sha256', secret).update(body).digest('base64');

// A stand-in for the LINE API client that records what was sent.
function fakeClient({ failPush = null } = {}) {
  const sent = [];
  return {
    sent,
    async botInfo() { return { basicId: '@radar', displayName: 'Radar' }; },
    async profile(id) { return { displayName: `name-${id}` }; },
    async push(to, text) { if (failPush) throw failPush; sent.push({ to, text }); return {}; },
    async reply(replyToken, text) { sent.push({ replyToken, text }); return {}; },
  };
}
const textEv = (userId, text, replyToken = 'r1') => ({ type: 'message', replyToken, source: { type: 'user', userId }, message: { type: 'text', text } });

test('webhook signatures: only the exact body signed with the channel secret passes', () => {
  const body = Buffer.from(JSON.stringify({ destination: 'U1', events: [] }));
  assert.equal(verifySignature(SECRET, body, sign(body)), true);
  assert.equal(verifySignature(SECRET, Buffer.from(body.toString().replace('U1', 'U2')), sign(body)), false, 'tampered body');
  assert.equal(verifySignature(SECRET, body, sign(body, 'other-secret')), false, 'other secret');
  assert.equal(verifySignature(SECRET, body, ''), false);
  assert.equal(verifySignature(SECRET, body, undefined), false);
  assert.equal(verifySignature(SECRET, body, 'abc'), false, 'wrong length');
  assert.equal(verifySignature('', body, sign(body, '')), false, 'no secret configured');
});

test('linking: the one-time code sent from LINE links that user, once; wrong codes and guessing are refused', async () => {
  const kv = memoryKv();
  const client = fakeClient();
  const line = createLine({ client, kv, secret: SECRET });
  assert.equal((await line.status()).linked, false);
  const { code, botId } = await line.startLink();
  assert.match(code, /^\d{6}$/);
  assert.equal(botId, '@radar');
  assert.equal((await line.status()).pending, true);
  // A wrong code, a group message and a sticker change nothing.
  const wrong = code === '000000' ? '111111' : '000000';
  await line.handleEvents([textEv('Uother', wrong), { ...textEv('Ugroup', code), source: { type: 'group', groupId: 'G', userId: 'Ugroup' } }, { type: 'message', source: { type: 'user', userId: 'Ux' }, message: { type: 'sticker' } }]);
  assert.equal((await line.status()).linked, false);
  assert.deepEqual(client.sent.at(-1), { replyToken: 'r1', text: BAD_CODE_TEXT });
  // The right code (spaces allowed) links the sender and is used up.
  const r = await line.handleEvents([textEv('Uowner', `${code.slice(0, 3)} ${code.slice(3)}`, 'r2')]);
  assert.equal(r.linked, true);
  const st = await line.status();
  assert.deepEqual([st.linked, st.name, st.pending], [true, 'name-Uowner', false]);
  assert.deepEqual(client.sent.at(-1), { replyToken: 'r2', text: LINKED_TEXT });
  assert.equal((await kv.get('line:v1')).userId, 'Uowner');
  await line.handleEvents([textEv('Uthief', code)]);
  assert.equal((await kv.get('line:v1')).userId, 'Uowner', 'a used code cannot relink');
  // Guessing: after 10 tries in an hour even the right code is refused.
  const { code: c2 } = await line.startLink();
  for (let i = 0; i < 10; i++) await line.handleEvents([textEv('Uguess', String(i).padStart(6, '0') === c2 ? '999999' : String(i).padStart(6, '0'))]);
  await line.handleEvents([textEv('Uguess', c2)]);
  assert.equal((await kv.get('line:v1')).userId, 'Uowner');
  // Blocking the bot unlinks; unlink clears the pending code too.
  await line.handleEvents([{ type: 'unfollow', source: { type: 'user', userId: 'Uowner' } }]);
  assert.equal((await createLine({ client, kv }).status()).linked, false);
  await line.startLink();
  await line.unlink();
  assert.equal((await line.status()).pending, false);
});

test('push cap: counted per month, the last allowed message says so, then nothing more is sent', async () => {
  let t = Date.parse('2026-10-14T04:00:00Z');
  const kv = memoryKv();
  const client = fakeClient();
  const line = createLine({ client, kv, cap: 3, now: () => t });
  await assert.rejects(createLine({ client, kv: memoryKv() }).test(), (e) => e.code === 'not-linked');
  await kv.set('line:v1', { userId: 'U1', name: 'me' });
  assert.equal((await line.test()).used, 1);
  assert.equal(client.sent.at(-1).text, TEST_TEXT);
  assert.equal(await line.notify('🔔 <b>TPE → NRT</b> 新增 &amp; <a href="https://x.test/?a=1&amp;b=2">打開這個搜尋</a>'), true);
  assert.equal(client.sent.at(-1).text, '🔔 TPE → NRT 新增 & 打開這個搜尋：https://x.test/?a=1&b=2');
  assert.equal(await line.notify('third'), true);
  assert.match(client.sent.at(-1).text, /^third\n\n（本月 LINE 通知已達網站設定的上限 3 則/);
  assert.equal(await line.notify('fourth'), false, 'over the cap: not sent');
  await assert.rejects(line.test(), (e) => e.code === 'cap' && e.status === 429);
  assert.equal(client.sent.length, 3);
  const st = await line.status();
  assert.deepEqual([st.used, st.cap, st.capped], [3, 3, true]);
  // A new (Taiwan) month starts over.
  t = Date.parse('2026-10-31T16:30:00Z');
  assert.equal(await line.notify('november'), true);
  assert.equal((await line.status()).used, 1);
  // A failed push gives its slot back; LINE's own monthly limit stops the rest of the month.
  const failing = createLine({ client: fakeClient({ failPush: Object.assign(new Error('x'), { code: 'blocked' }) }), kv, cap: 3, now: () => t });
  assert.equal(await failing.notify('a'), false);
  assert.equal((await line.status()).used, 1);
  const limited = createLine({ client: fakeClient({ failPush: Object.assign(new Error('x'), { code: 'limit' }) }), kv, cap: 3, now: () => t });
  assert.equal(await limited.notify('a'), false);
  assert.equal((await line.status()).capped, true);
  // Not set up or not linked: false, never thrown.
  assert.equal(await createLine({ client: null, kv }).notify('x'), false);
  assert.equal(await createLine({ client, kv: memoryKv() }).notify('x'), false);
});

test('htmlToText turns the Telegram HTML into plain text', () => {
  assert.equal(htmlToText('<b>A&lt;B</b> &quot;x&quot; &#39;y&#39;'), 'A<B "x" \'y\'');
  assert.equal(htmlToText('<a href="https://a.test/x">看</a>'), '看：https://a.test/x');
});

test('the LINE API client sends the token as a bearer header and maps errors', async () => {
  const calls = [];
  const ok = lineClient({ token: 'TOKEN', fetchImpl: async (url, opts) => { calls.push({ url: String(url), opts }); return new Response('{}'); } });
  await ok.push('U1', 'hi');
  assert.equal(calls[0].url, 'https://api.line.me/v2/bot/message/push');
  assert.equal(calls[0].opts.headers.authorization, 'Bearer TOKEN');
  assert.deepEqual(JSON.parse(calls[0].opts.body), { to: 'U1', messages: [{ type: 'text', text: 'hi' }] });
  const bad = (status) => lineClient({ token: 'T', fetchImpl: async () => new Response(JSON.stringify({ message: 'nope' }), { status }) });
  await assert.rejects(bad(401).botInfo(), (e) => e.code === 'token');
  await assert.rejects(bad(429).push('U', 'x'), (e) => e.code === 'limit');
});

test('routes: the webhook needs real setup; the demo links through a stand-in', async () => {
  let r = await fetch(`${base}/api/line/webhook`, { method: 'POST', body: '{"events":[]}', headers: { 'x-line-signature': 'x' } });
  assert.equal(r.status, 503);
  r = await fetch(`${base}/api/config`);
  assert.equal((await r.json()).line.configured, true, 'the demo has a stand-in account');
  const code = await (await fetch(`${base}/api/line/code`, { method: 'POST' })).json();
  assert.match(code.code, /^\d{6}$/);
  const linked = await (await fetch(`${base}/api/line/demo`, { method: 'POST' })).json();
  assert.deepEqual([linked.linked, linked.mock], [true, true]);
  const sent = await (await fetch(`${base}/api/line/test`, { method: 'POST' })).json();
  assert.equal(sent.sent, true);
  assert.equal((await (await fetch(`${base}/api/line`, { method: 'DELETE' })).json()).linked, false);
  // With a passcode set, the panel's routes need it.
  process.env.CASH_PASSCODE = 'pw-for-test';
  try {
    assert.equal((await fetch(`${base}/api/line`)).status, 401);
    assert.equal((await fetch(`${base}/api/line`, { headers: { 'x-cash-pass': 'pw-for-test' } })).status, 200);
  } finally { delete process.env.CASH_PASSCODE; }
});
