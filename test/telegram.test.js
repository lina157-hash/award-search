// Telegram notifications: linking picks the right chat, alerts and price drops are sent, failures are tolerated.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
delete process.env.SEATS_AERO_API_KEY;
delete process.env.CASH_PASSCODE;
delete process.env.TELEGRAM_BOT_TOKEN;
const { server } = require('../server');
const { telegramClient, createTelegram, pickChat, LINKED_TEXT, TEST_TEXT, TelegramError } = require('../lib/telegram');
const { memoryKv } = require('../lib/kv');
const { memoryStore } = require('../lib/alerts');

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());
const isoIn = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

// A fake Bot API: records calls, answers getUpdates with `updates`, sendMessage with ok (or `fail`).
function fakeBot({ updates = [], fail = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const u = new URL(String(url));
    const method = u.pathname.split('/').pop();
    const body = JSON.parse(opts.body);
    calls.push({ path: u.pathname, method, body });
    if (method === 'getUpdates') return new Response(JSON.stringify({ ok: true, result: body.offset ? [] : updates }));
    if (fail) return new Response(JSON.stringify({ ok: false, description: 'Forbidden: bot was blocked by the user' }), { status: 403 });
    return new Response(JSON.stringify({ ok: true, result: { message_id: calls.length } }));
  };
  return { calls, client: telegramClient({ token: '123:SECRET', fetchImpl }) };
}
const msg = (id, chat, text) => ({ update_id: id, message: { text, chat } });
const me = { id: 42, type: 'private', first_name: 'Lina', last_name: 'C' };
const other = { id: 77, type: 'private', first_name: 'Someone' };
const group = { id: -5, type: 'group', title: 'Trips' };

test('linking picks the newest private chat that sent /start and says hello', async () => {
  assert.equal(pickChat([msg(1, me, '/start'), msg(2, group, '/start'), msg(3, other, 'hi')]).chat.id, 42, '/start wins over a later plain message');
  assert.equal(pickChat([msg(1, other, 'hi'), msg(4, me, 'hello')]).chat.id, 42, 'otherwise the newest private message');
  assert.equal(pickChat([msg(1, group, '/start')]), null);
  const bot = fakeBot({ updates: [msg(10, other, '/start'), msg(11, me, '/start'), msg(12, group, 'x')] });
  const kv = memoryKv();
  const t = createTelegram({ client: bot.client, kv });
  assert.deepEqual(await t.status(), { configured: true, linked: false, name: '', linkedAt: null, tokenOk: true, bot: '' });
  const r = await t.link();
  assert.deepEqual([r.linked, r.name], [true, 'Lina C']);
  const sent = bot.calls.find((c) => c.method === 'sendMessage');
  assert.deepEqual([sent.body.chat_id, sent.body.text], [42, LINKED_TEXT]);
  assert.ok(bot.calls.every((c) => c.path === '/bot123:SECRET/' + c.method));
  assert.equal(bot.calls.at(-1).body.offset, 13, 'old messages are marked read');
  assert.equal((await kv.get('telegram:v1')).chatId, 42);
  // 「傳送測試訊息」 goes to the linked chat.
  assert.deepEqual(await t.test(), { sent: true, name: 'Lina C' });
  assert.deepEqual([bot.calls.at(-1).body.chat_id, bot.calls.at(-1).body.text], [42, TEST_TEXT]);
  await assert.rejects(createTelegram({ client: bot.client, kv: memoryKv() }).test(), (e) => e.code === 'not-linked');
  await assert.rejects(createTelegram({ client: fakeBot({ fail: true }).client, kv }).test(), (e) => e.code === 'blocked');
  // A fresh instance reads the link from the shared store.
  assert.equal((await createTelegram({ client: bot.client, kv }).status()).linked, true);
  await t.unlink();
  assert.equal((await t.status()).linked, false);
  const none = createTelegram({ client: fakeBot().client, kv: memoryKv() });
  await assert.rejects(none.link(), (e) => e.code === 'no-start' && e.status === 404);
  await assert.rejects(createTelegram({ client: null, kv }).link(), (e) => e.code === 'not-configured');
});

test('alerts and price drops are sent to the linked chat; a Telegram failure does not touch the email', async () => {
  const { createAlerts } = require('../lib/alerts');
  const { createPriceWatch } = require('../lib/pricewatch');
  const bot = fakeBot({ updates: [msg(1, me, '/start')] });
  const t = createTelegram({ client: bot.client, kv: memoryKv() });
  await t.link();
  const row = (id) => ({ id, date: '2099-01-02', origin: 'TPE', destination: 'NRT', source: 'aeroplan', cabins: { J: { available: true, miles: 30000, seats: 2, airlines: 'BR', direct: true } } });
  let rows = [row('a')];
  const mails = [];
  const al = createAlerts({ store: memoryStore(), search: async () => rows, sendEmail: async (m) => mails.push(m), siteUrl: 'https://x.test', notify: (h) => t.notify(h) });
  await al.add({ origin: 'TPE', destination: 'NRT', start: '2099-01-01', end: '2099-01-05', cabin: 'J', email: 'a@b.co' });
  rows = [row('a'), row('b')];
  const r = await al.run();
  assert.deepEqual([r.report[0].mailed, r.report[0].telegram], [true, true]);
  const text = bot.calls.filter((c) => c.method === 'sendMessage').at(-1).body;
  assert.equal(text.parse_mode, 'HTML');
  assert.match(text.text, /TPE → NRT 商務艙 新增 1 筆/);
  assert.match(text.text, /<a href="https:\/\/x\.test\/\?o=TPE/);
  // Nothing new: nothing sent.
  const before = bot.calls.length;
  await al.run();
  assert.equal(bot.calls.length, before);

  // Price drop, with the bot failing: the mail still goes out once, the drop is recorded once.
  const broken = fakeBot({ updates: [msg(1, me, '/start')] });
  const kv = memoryKv();
  await createTelegram({ client: broken.client, kv }).link();
  const failing = createTelegram({ client: fakeBot({ fail: true }).client, kv });
  let clock = Date.now();
  let price = 30000;
  const wmails = [];
  const w = createPriceWatch({ store: memoryStore(null), now: () => clock, search: async () => ({ options: [{ price, segments: [] }] }), sendEmail: async (m) => wmails.push(m), notify: (h) => failing.notify(h) });
  await w.add({ origin: 'TPE', destination: 'NRT', depart: isoIn(5), email: 'a@b.co', price: 30000 });
  clock += 864e5;
  price = 26000;
  const wr = await w.run();
  assert.deepEqual([wr.report[0].dropped, wr.report[0].mailed, wr.report[0].telegram], [true, true, false]);
  clock += 864e5;
  await w.run();
  assert.equal(wmails.length, 1, 'no second mail after the Telegram failure');
  // A drop with no email on the watch still reaches Telegram when it works.
  const ok = createTelegram({ client: broken.client, kv });
  const w2 = createPriceWatch({ store: memoryStore(null), now: () => clock, search: async () => ({ options: [{ price: 9000, segments: [] }] }), notify: (h) => ok.notify(h) });
  await w2.add({ origin: 'TPE', destination: 'KIX', depart: isoIn(5), price: 12000 });
  clock += 864e5;
  assert.equal((await w2.run()).report[0].telegram, true);
  assert.match(broken.calls.at(-1).body.text, /降到 NT\$9,000/);
});

test('telegram endpoints: demo bot, passcode gate, config flags', async () => {
  let cfg = await (await fetch(`${base}/api/config`)).json();
  assert.deepEqual(cfg.telegram, { configured: true, linked: false, tokenOk: true });
  const linked = await (await fetch(`${base}/api/telegram/link`, { method: 'POST' })).json();
  assert.deepEqual([linked.linked, linked.name, linked.mock], [true, '示範帳號', true]);
  const st = await (await fetch(`${base}/api/telegram`)).json();
  assert.equal(st.linked, true);
  assert.equal((await fetch(`${base}/api/telegram/link`)).status, 400, 'link is a POST');
  assert.equal((await (await fetch(`${base}/api/telegram/test`, { method: 'POST' })).json()).sent, true);
  process.env.CASH_PASSCODE = 'pw';
  try {
    assert.equal((await fetch(`${base}/api/telegram`)).status, 401);
    assert.equal((await fetch(`${base}/api/telegram`, { headers: { 'x-cash-pass': 'pw' } })).status, 200);
  } finally { delete process.env.CASH_PASSCODE; }
  const del = await fetch(`${base}/api/telegram`, { method: 'DELETE' });
  assert.equal((await del.json()).linked, false);
  assert.equal(del.headers.get('cache-control'), 'no-store');
});

test('status reports a token Telegram refuses, and the bot name when it works', async () => {
  const refused = { getMe: async () => { throw new TelegramError('x', 502, 'token'); }, getUpdates: async () => [], sendMessage: async () => ({}) };
  assert.deepEqual(await createTelegram({ client: refused, kv: memoryKv() }).bot(), { tokenOk: false, bot: '' });
  const ok = { getMe: async () => ({ username: 'my_radar_bot' }), getUpdates: async () => [], sendMessage: async () => ({}) };
  const st = await createTelegram({ client: ok, kv: memoryKv() }).status();
  assert.deepEqual([st.tokenOk, st.bot], [true, 'my_radar_bot']);
});
