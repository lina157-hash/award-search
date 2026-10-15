// 機位提醒「修改」: a watch's conditions change in place, keep its id and email, and start over from a new baseline.
const { test } = require('node:test');
const assert = require('node:assert');
const { createAlerts, memoryStore } = require('../lib/alerts');

const isoIn = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const row = (id, origin, destination, miles = 30000, airlines = 'BR') => ({ id, date: isoIn(30), origin, destination, source: 'aeroplan', cabins: { J: { available: true, miles, seats: 2, airlines, direct: true }, Y: { available: true, miles: 15000, seats: 4, airlines, direct: true } } });
const watch = (extra) => ({ origin: 'TPE', destination: 'NRT', start: isoIn(20), end: isoIn(40), cabin: 'J', email: 'me@example.com', ...extra });

function setup() {
  // The search answers for the route asked: TPE→NRT has a, TPE→LAX has b and c.
  const seats = { 'TPE-NRT': [row('a', 'TPE', 'NRT')], 'TPE-LAX': [row('b', 'TPE', 'LAX'), row('c', 'TPE', 'LAX', 70000, 'CI')] };
  const asked = [];
  const mails = [];
  const al = createAlerts({
    store: memoryStore(),
    search: async (p) => { asked.push(p); return seats[`${p.origin_airport}-${p.destination_airport}`] || []; },
    sendEmail: async (m) => mails.push(m),
  });
  return { al, seats, asked, mails };
}

test('alert update: new conditions, same id and email, baseline taken again', async () => {
  const { al, seats, mails } = setup();
  const { alert } = await al.add(watch());
  const out = await al.update(alert.id, { origin: 'tpe', destination: 'lax', start: isoIn(25), end: isoIn(50), cabin: 'j', sources: ['aeroplan'], airlines: 'br, ci', anyLeg: true, email: 'someone-else@example.com' });
  assert.equal(out.alert.id, alert.id);
  assert.equal(out.alert.email, 'me@example.com', 'where it reports to is kept');
  assert.deepEqual([out.alert.origin, out.alert.destination, out.alert.start, out.alert.end, out.alert.cabin], ['TPE', 'LAX', isoIn(25), isoIn(50), 'J']);
  assert.deepEqual(out.alert.sources, ['aeroplan']);
  assert.deepEqual(out.alert.airlines, ['BR', 'CI']);
  assert.equal(out.alert.anyLeg, true);
  assert.equal(out.found, 2);
  assert.equal(out.alert.createdAt, alert.createdAt);
  assert.ok(out.alert.updatedAt);
  assert.equal(out.alert.seen, undefined, 'the baseline stays on the server');
  const list = await al.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].seenCount, 2, 'seats there now are the new baseline');

  // A run right after reports nothing; a seat that shows up later is reported once.
  await al.run();
  assert.equal(mails.length, 0, 'existing seats are not re-notified');
  seats['TPE-LAX'].push(row('d', 'TPE', 'LAX', 60000));
  const r = await al.run();
  assert.equal(r.report[0].fresh, 1);
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /TPE → LAX/);
});

test('alert update: fields left out keep their values, filters can be cleared', async () => {
  const { al } = setup();
  const { alert } = await al.add(watch({ sources: ['aeroplan'], airlines: ['BR'], direct: true, alliance: 'star', pax: 2 }));
  const kept = (await al.update(alert.id, { cabin: 'Y' })).alert;
  assert.deepEqual([kept.origin, kept.destination, kept.cabin, kept.pax, kept.direct, kept.alliance], ['TPE', 'NRT', 'Y', 2, true, 'star']);
  assert.deepEqual(kept.sources, ['aeroplan']);
  const cleared = (await al.update(alert.id, { sources: [], airlines: [], alliance: '', direct: false, anyLeg: false })).alert;
  assert.deepEqual([cleared.sources, cleared.airlines, cleared.alliance, cleared.direct], [[], [], '', false]);
});

test('alert update: same validation as create, unknown id is an error, nothing saved on failure', async () => {
  const { al } = setup();
  const { alert } = await al.add(watch());
  await assert.rejects(al.update(alert.id, { origin: 'TAIPEI' }), /機場代碼格式錯誤/);
  await assert.rejects(al.update(alert.id, { start: isoIn(30), end: isoIn(10) }), /日期格式錯誤/);
  await assert.rejects(al.update(alert.id, { start: isoIn(-20), end: isoIn(-10) }), /日期已經過了/);
  await assert.rejects(al.update(alert.id, { cabin: 'X' }), /艙等/);
  await assert.rejects(al.update(alert.id, { airlines: 'CHINA' }), /航空公司代碼/);
  await assert.rejects(al.update(alert.id, { alliance: 'nope' }), /航空聯盟錯誤/);
  await assert.rejects(al.update('nope', { cabin: 'Y' }), (e) => e.status === 404 && /找不到這個提醒/.test(e.message));
  const [a] = await al.list();
  assert.deepEqual([a.origin, a.destination, a.cabin], ['TPE', 'NRT', 'J']);
});

test('alert update: a watch deleted while it was being re-checked is not put back', async () => {
  let al;
  let removing = false;
  al = createAlerts({ store: memoryStore(), search: async () => { if (removing) await al.remove(id); return []; } });
  const { alert } = await al.add(watch());
  const id = alert.id;
  removing = true;
  await assert.rejects(al.update(id, { cabin: 'Y' }), /找不到這個提醒/);
  assert.equal((await al.list()).length, 0);
});

test('PUT /api/alerts: demo route updates in place, behind the same passcode as creating one', async () => {
  delete process.env.SEATS_AERO_API_KEY;
  delete process.env.CASH_PASSCODE;
  delete process.env.CRON_SECRET;
  const { server } = require('../server');
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const json = (method, body, headers = {}) => ({ method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  try {
    const made = await (await fetch(`${base}/api/alerts`, json('POST', watch({ email: '' })))).json();
    const id = made.alert.id;
    const res = await fetch(`${base}/api/alerts?id=${id}`, json('PUT', { destination: 'KIX', cabin: 'Y' }));
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.deepEqual([out.alert.id, out.alert.destination, out.alert.cabin], [id, 'KIX', 'Y']);
    assert.equal((await fetch(`${base}/api/alerts?id=${id}`, json('PUT', { cabin: 'Q' }))).status, 400);
    assert.equal((await fetch(`${base}/api/alerts?id=nope`, json('PUT', { cabin: 'Y' }))).status, 404);
    process.env.CASH_PASSCODE = 'pw';
    try {
      assert.equal((await fetch(`${base}/api/alerts?id=${id}`, json('PUT', { cabin: 'F' }))).status, 401);
      assert.equal((await fetch(`${base}/api/alerts?id=${id}`, json('PUT', { cabin: 'F' }, { 'x-cash-pass': 'pw' }))).status, 200);
    } finally { delete process.env.CASH_PASSCODE; }
    await fetch(`${base}/api/alerts?id=${id}`, { method: 'DELETE' });
  } finally {
    server.close();
  }
});
