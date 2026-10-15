// 機位提醒可複選艙等: one watch covers several cabins and reports each cabin's new seats, labelled with the cabin.
const { test } = require('node:test');
const assert = require('node:assert');
const { createAlerts, memoryStore } = require('../lib/alerts');

const isoIn = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const row = (id, cabins) => ({ id, date: isoIn(30), origin: 'TPE', destination: 'PVG', source: 'aeroplan', cabins });
const seat = (miles) => ({ available: true, miles, seats: 2, airlines: 'BR', direct: true });

function setup(seats) {
  const asked = [];
  const mails = [];
  const al = createAlerts({ store: memoryStore(), search: async (p) => { asked.push(p.cabins); return seats(); }, sendEmail: async (m) => mails.push(m) });
  return { al, asked, mails };
}
const watch = (extra) => ({ origin: 'TPE', destination: 'PVG', start: isoIn(20), end: isoIn(40), email: 'me@example.com', ...extra });

test('alert cabins: several cabins are stored in a fixed order, one search each', async () => {
  let list = [row('a', { Y: seat(15000), J: seat(30000), F: { available: false } })];
  const { al, asked } = setup(() => list);
  const { alert, found } = await al.add(watch({ cabins: ['J', 'Y'] }));
  assert.equal(alert.cabin, 'YJ');
  assert.deepEqual(asked, ['economy', 'business']);
  assert.equal(found, 2, 'economy and business seats on the same flight count separately');
  const u = await al.update(alert.id, { cabin: 'Y,J,F' });
  assert.equal(u.alert.cabin, 'YJF');
  await assert.rejects(al.update(alert.id, { cabins: [] }), /至少選一個艙等/);
  await assert.rejects(al.add(watch({ cabin: 'X' })), /至少選一個艙等/);
});

test('alert cabins: a new seat in one cabin is reported once, with its cabin named', async () => {
  let list = [row('a', { Y: seat(15000), J: { available: false } })];
  const { al, mails } = setup(() => list);
  await al.add(watch({ cabins: ['Y', 'J'] }));
  list = [row('a', { Y: seat(15000), J: seat(30000) })];
  const r = await al.run();
  assert.equal(r.report[0].fresh, 1, 'only the business seat is new');
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /經濟艙、商務艙 新增 1 筆/);
  assert.match(mails[0].html, /<td>商務艙<\/td>/);
});

test('alert cabins: a one-cabin watch from before keeps its baseline keys', async () => {
  const list = [row('a', { J: seat(30000) })];
  const { al, mails } = setup(() => list);
  await al.add(watch({ cabin: 'J' }));
  await al.run();
  assert.equal(mails.length, 0);
  const [a] = await al.list();
  assert.equal(a.cabin, 'J');
  assert.equal(a.seenCount, 1);
});
