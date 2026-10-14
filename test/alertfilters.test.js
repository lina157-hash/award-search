// Seat alerts keep the search's 只看直飛 and 航空聯盟 filters; watches saved before them report as they always did.
const { test } = require('node:test');
const assert = require('node:assert');
const { createAlerts, memoryStore } = require('../lib/alerts');

const isoIn = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const row = (id, airlines, direct) => ({ id, date: isoIn(30), origin: 'TPE', destination: 'NRT', source: 'aeroplan', cabins: { J: { available: true, miles: 30000, seats: 2, airlines, direct } } });
// BR and NH are Star Alliance, CI is SkyTeam, JL oneworld.
const ROWS = [row('a', 'BR', true), row('b', 'BR', false), row('c', 'CI', true), row('d', 'BR, NH', false), row('e', 'BR, CI', false), row('f', 'NH', true)];
const watch = (extra) => ({ origin: 'TPE', destination: 'NRT', start: isoIn(20), end: isoIn(40), cabin: 'J', email: 'me@example.com', ...extra });

test('alert filters: direct only, alliance only, and both together', async () => {
  const al = createAlerts({ store: memoryStore(), search: async () => ROWS });
  const found = async (extra) => (await al.add(watch(extra))).found;
  assert.equal(await found({}), 6);
  assert.equal(await found({ direct: true }), 3); // a, c, f
  assert.equal(await found({ alliance: 'star' }), 4); // a, b, d, f: every leg a member
  assert.equal(await found({ alliance: 'star', direct: true }), 2); // a, f
  // With airlines too, both apply.
  assert.equal(await found({ alliance: 'star', airlines: 'BR', anyLeg: true }), 3); // a, b, d
});

test('alert filters: stored on the watch, checked, and shown in the mail and Telegram text', async () => {
  let rows = ROWS.slice(0, 1);
  const mails = [];
  const chats = [];
  const al = createAlerts({ store: memoryStore(), search: async () => rows, sendEmail: async (m) => mails.push(m), notify: async (h) => { chats.push(h); return true; }, siteUrl: 'https://x.test' });
  const { alert } = await al.add(watch({ alliance: 'STAR', direct: '1' }));
  assert.deepEqual([alert.alliance, alert.direct], ['star', true]);
  assert.equal((await al.add(watch({ direct: false }))).alert.direct, false);
  await assert.rejects(al.add(watch({ alliance: 'nope' })), /航空聯盟錯誤/);
  rows = ROWS;
  await al.run();
  assert.equal(mails.length, 2);
  const mine = mails.find((m) => /只要直飛/.test(m.html));
  assert.match(mine.html, /星空聯盟/);
  assert.match(mine.html, /al=star&amp;direct=1#search/);
  const chat = chats.find((h) => /只要直飛/.test(h));
  assert.match(chat, /星空聯盟/);
  assert.match(chat, /al=star&amp;direct=1/, 'the Telegram link opens the same filtered search');
});

test('alert filters: watches saved before direct and alliance existed are unaffected', async () => {
  const old = { id: 'x', origin: 'TPE', destination: 'NRT', start: isoIn(20), end: isoIn(40), cabin: 'J', pax: 0, email: '', sources: [], airlines: [], anyLeg: false, seen: {}, lastRun: null };
  const al = createAlerts({ store: memoryStore([old]), search: async () => ROWS });
  assert.equal((await al.run()).report[0].found, ROWS.length);
});
