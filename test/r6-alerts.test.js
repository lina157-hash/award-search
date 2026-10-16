// Round 6, alerts and notifications: 機位提醒 miles cap and price drops (N1), 只要這些航班 (N16), 已開票「便宜了通知我」
// (N7), 今日好康「我的條件通知」 (N2), 一句話 → 機位提醒 (N14) and what /api/config tells visitors (U18).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
delete process.env.SEATS_AERO_API_KEY;
delete process.env.CASH_PASSCODE;
delete process.env.CRON_SECRET;
const { createAlerts, memoryStore, flightNo } = require('../lib/alerts');
const { createBooked, cheapestFor, isNews, feeText } = require('../lib/booked');
const { createDealRules, cleanRule, matches, matchGroups, ruleLabel } = require('../lib/dealrules');
const { createDeals } = require('../lib/deals');
const { memoryKv } = require('../lib/kv');
const { validate: nlValidate, mockParse, normalize } = require('../lib/nlsearch');

const isoIn = (n) => new Date(Date.now() + 864e5 * n + 8 * 3600e3).toISOString().slice(0, 10);
const row = (id, miles, { airlines = 'BR', date = isoIn(30), seats = 2, source = 'united', trips } = {}) => ({ id, date, origin: 'TPE', destination: 'SFO', source, cabins: { J: { available: true, miles, seats, airlines, direct: true } }, ...(trips ? { flightTrips: trips } : {}) });
const watch = (extra) => ({ origin: 'TPE', destination: 'SFO', start: isoIn(20), end: isoIn(40), cabin: 'J', email: 'me@example.com', ...extra });

function setup(rows, opts = {}) {
  const state = { rows, mails: [], chats: [], asked: [], tripCalls: [] };
  const al = createAlerts({
    store: memoryStore(),
    search: async (p) => { state.asked.push(p); return state.rows; },
    sendEmail: async (m) => { if (state.mailFails) throw new Error('down'); state.mails.push(m); },
    notify: async (h) => { state.chats.push(h); return true; },
    siteUrl: 'https://x.test',
    ...opts,
  });
  return { al, state };
}

// ---------- N1 ----------
test('N1: a cap leaves out dearer seats; one that falls under it is news once, with its old price', async () => {
  const { al, state } = setup([row('a', 70000), row('b', 120000)]);
  const { found } = await al.add(watch({ maxMiles: '90,000' }));
  assert.equal(found, 1, 'only seats under the cap count');
  state.rows = [row('a', 70000), row('b', 120000), row('c', 95000)];
  let r = await al.run();
  assert.equal(r.report[0].fresh, 0, 'a new seat over the cap is not news');
  state.rows = [row('a', 70000), row('b', 85000), row('c', 95000)];
  r = await al.run();
  assert.equal(r.report[0].fresh, 1);
  assert.match(state.mails[0].subject, /降價 1 筆/);
  assert.match(state.mails[0].html, /<s[^>]*>120,000<\/s> → <b>85,000<\/b>/);
  assert.match(state.chats[0], /📉 .*<s>120,000<\/s> → <b>85,000<\/b> 哩（少 35,000）/);
  assert.match(state.chats[0], /最多 90,000 哩/);
  r = await al.run();
  assert.equal(r.report[0].fresh, 0, 'the same price is told once');
});

test('N1: 降哩也通知 reports a seen seat 5% cheaper (old and new miles), not a small wiggle, and keeps a failed one', async () => {
  const { al, state } = setup([row('a', 100000), row('b', 60000)]);
  await al.add(watch({ drops: true }));
  state.rows = [row('a', 97000), row('b', 60000)];
  assert.equal((await al.run()).report[0].fresh, 0, '3% is not news');
  state.rows = [row('a', 94000), row('b', 60000)];
  state.mailFails = true;
  state.chats.length = 0;
  const failing = setup([row('a', 100000)], { notify: null });
  await failing.al.add(watch({ drops: true }));
  failing.state.rows = [row('a', 90000)];
  failing.state.mailFails = true;
  const r1 = await failing.al.run();
  assert.equal(r1.report[0].retry, true, 'nothing delivered: tried again');
  failing.state.mailFails = false;
  const r2 = await failing.al.run();
  assert.equal(r2.report[0].fresh, 1, 'the drop is still news the next run');
  assert.match(failing.state.mails[0].html, /100,000.*→ <b>90,000<\/b>/s);
  // Creeping drops add up against the last price told (100k), not yesterday's.
  state.mailFails = false;
  const r = await al.run();
  assert.equal(r.report[0].fresh, 1);
  assert.match(state.chats.at(-1), /<s>100,000<\/s> → <b>94,000<\/b>/);
  state.rows = [row('a', 120000), row('b', 60000)];
  await al.run();
  state.rows = [row('a', 94000), row('b', 60000)];
  assert.equal((await al.run()).report[0].fresh, 0, 'back to the price already told: quiet');
});

test('N1: cap, drops and flights are checked, stored, shown, and count as conditions for the twin check', async () => {
  const { al } = setup([]);
  await assert.rejects(al.add(watch({ maxMiles: 'abc' })), /哩數上限/);
  await assert.rejects(al.add(watch({ maxMiles: 500 })), /哩數上限/);
  await assert.rejects(al.add(watch({ flights: 'BR16, hello' })), /航班號碼/);
  const { alert } = await al.add(watch({ maxMiles: 80000, drops: '1', flights: 'br016 jx12 BR16' }));
  assert.deepEqual([alert.maxMiles, alert.drops, alert.flights], [80000, true, ['BR16', 'JX12']]);
  assert.equal((await al.add(watch({ maxMiles: 80000, drops: true, flights: ['JX12', 'BR16'].reverse() }))).duplicate, true);
  assert.notEqual((await al.add(watch({ maxMiles: 70000, drops: true, flights: 'BR16,JX12' }))).duplicate, true);
  // A watch saved before these fields existed is the twin of the same conditions without them.
  const old = { id: 'old1', origin: 'TPE', destination: 'NRT', start: isoIn(20), end: isoIn(40), cabin: 'J', pax: 0, email: '', sources: [], airlines: [], anyLeg: false, direct: false, alliance: '', seen: {}, lastRun: null };
  const legacy = createAlerts({ store: memoryStore([old]), search: async () => [] });
  assert.equal((await legacy.add({ origin: 'TPE', destination: 'NRT', start: old.start, end: old.end, cabin: 'J' })).duplicate, true);
  // 修改 can clear them.
  const cleared = (await al.update(alert.id, { maxMiles: '', drops: false, flights: '' })).alert;
  assert.deepEqual([cleared.maxMiles, cleared.drops, cleared.flights], [0, false, []]);
  assert.equal(flightNo('ci 0004'), 'CI4');
  assert.equal(flightNo('7C1234'), '7C1234');
  assert.equal(flightNo('1234'), null);
});

// ---------- N16 ----------
const trip = (flights, miles, cabin = 'business', seats = 2) => ({ cabin, flightNumbers: flights, miles, seats });

test('N16: within 45 days the search brings the trips: only the wanted flights, at their own miles, no extra calls', async () => {
  const rows = [
    row('a', 60000, { airlines: 'BR', trips: [trip('BR18', 60000), trip('BR16', 75000)] }),
    row('b', 55000, { airlines: 'BR', trips: [trip('BR12', 55000)] }),
    row('c', 50000, { airlines: 'UA', trips: [trip('UA872', 50000)] }),
    row('d', 65000, { airlines: 'JX, BR', trips: [trip('JX12, BR16', 65000), trip('JX12', 64000, 'economy')] }),
  ];
  let tripCalls = 0;
  const { al, state } = setup(rows, { trips: async () => { tripCalls++; return { trips: [] }; } });
  const { found, sample } = await al.add(watch({ flights: 'BR16' }));
  assert.equal(state.asked[0].include_trips, true, 'a short range asks for the trips');
  assert.equal(found, 2);
  assert.deepEqual(sample.map((x) => [x.id, x.miles, x.flights]), [['d', 65000, 'JX12、BR16'], ['a', 75000, 'BR16']]);
  state.rows = [...rows, row('e', 70000, { trips: [trip('BR16', 70000)] })];
  await al.run();
  assert.match(state.mails[0].html, /<th>航班<\/th>/);
  assert.match(state.mails[0].html, /只要 BR16/);
  assert.equal(tripCalls, 0);
  // A watch without flights does not ask for the trips.
  const plain = setup(rows);
  await plain.al.add(watch());
  assert.equal(plain.state.asked[0].include_trips, undefined);
});

test('N16: further out, only new candidate rows are looked up, at most 5 calls a run, and a miss is not looked up again', async () => {
  const far = (id, miles, airlines = 'BR') => row(id, miles, { airlines, date: isoIn(100) });
  const rows = Array.from({ length: 8 }, (_, i) => far(`r${i}`, 60000 + i * 1000)).concat([far('ua', 50000, 'UA')]);
  const asked = [];
  const tripsFor = { r0: [trip('BR16', 70000)], r3: [trip('BR16', 66000)] };
  const { al, state } = setup(rows, { trips: async (id) => { asked.push(id); return { trips: tripsFor[id] || [trip('BR18', 1)] }; } });
  const w = watch({ start: isoIn(60), end: isoIn(160), flights: 'BR16' });
  const { found } = await al.add(w);
  assert.equal(found, 0, 'no lookups when the watch is created');
  assert.equal(state.asked[0].include_trips, undefined, 'a long range does not ask for the trips');
  let r = await al.run();
  assert.equal(asked.length, 5, 'capped per run');
  assert.ok(!asked.includes('ua'), 'rows not flown by BR are never looked up');
  assert.equal(r.report[0].fresh, 2);
  assert.match(state.chats[0], /BR16/);
  r = await al.run();
  assert.deepEqual(asked.slice(5), ['r5', 'r6', 'r7'], 'the next run looks up only the rows not looked up yet');
  assert.equal(r.report[0].fresh, 0);
  await al.run();
  assert.equal(asked.length, 8, 'nothing new: no calls');
  // A row that changed is a new candidate again.
  state.rows = rows.map((x) => (x.id === 'r1' ? far('r1', 58000) : x));
  await al.run();
  assert.deepEqual(asked.slice(8), ['r1']);
});

// ---------- N7 ----------
const fees = { united: { change: '免費', cancel: '免費', confidence: 'secondary' }, aeroplan: { change: 'CA$75', cancel: 'CA$150', confidence: 'official' } };
const avail = (source, miles, trips) => ({ id: `x-${source}`, date: isoIn(30), origin: 'TPE', destination: 'SFO', source, cabins: { J: { available: true, miles, seats: 2, airlines: 'BR' } }, flightTrips: trips });

test('N7: the cheapest seat for the booked leg is the same program, day and cabin, and the same flights when known', () => {
  const leg = { date: isoIn(30), from: 'TPE', to: 'SFO', cabin: 'J', program: 'united', miles: 88000, flights: ['BR18'] };
  const rows = [avail('united', 60000, [trip('BR12', 60000), trip('BR18', 70000), trip('BR18', 65000, 'economy')]), avail('aeroplan', 50000, [trip('BR18', 50000)])];
  assert.deepEqual(cheapestFor(leg, rows), { miles: 70000, seats: 2, flights: 'BR18' });
  assert.equal(cheapestFor({ ...leg, flights: [] }, rows).miles, 60000);
  assert.equal(cheapestFor({ ...leg, flights: ['BR99'] }, rows), null);
  assert.equal(isNews(leg, { miles: 87500 }), false, 'under 1,000 miles saved');
  assert.equal(isNews(leg, { miles: 70000 }), true);
  assert.equal(isNews({ ...leg, toldMiles: 70000 }, { miles: 70000 }), false, 'told once');
  assert.equal(isNews({ ...leg, toldMiles: 70000 }, { miles: 65000 }), true, 'a new low is news');
  assert.match(feeText(fees, 'aeroplan'), /^取消退哩：CA\$150；改票：CA\$75$/);
  assert.match(feeText(fees, 'united'), /第三方整理/);
  assert.match(feeText(fees, 'nope'), /待確認/);
});

test('N7: daily check — one search per leg, told once with saving and fees, at most 5 legs, the cron skips legs done today', async () => {
  let rows = [avail('united', 70000, [trip('BR18', 70000)])];
  const searches = [];
  const chats = [];
  let failing = false;
  const bk = createBooked({ store: memoryStore([]), search: async (p) => { searches.push(p); return rows; }, notify: async (h) => { if (failing) return false; chats.push(h); return true; }, fees, programNames: { united: '聯合' }, siteUrl: 'https://x.test' });
  const leg = { date: isoIn(30), from: 'tpe', to: 'sfo', cabin: 'J', program: 'united', miles: 88000, pax: 2, flights: 'BR18 ' };
  const { leg: saved } = await bk.add(leg);
  assert.deepEqual(saved.flights, ['BR18']);
  assert.equal((await bk.add(leg)).duplicate, true);
  await assert.rejects(bk.add({ ...leg, date: isoIn(-1) }), /飛過/);
  await assert.rejects(bk.add({ ...leg, program: '' }), /哩程計畫/);
  failing = true;
  let r = await bk.run();
  assert.equal(r.report[0].retry, true, 'not delivered: kept for the next run');
  failing = false;
  r = await bk.run();
  assert.deepEqual([r.report[0].miles, r.report[0].told], [70000, true]);
  assert.equal(searches.length, 2);
  assert.deepEqual([searches[0].start_date, searches[0].end_date, searches[0].include_trips, searches[0].cabins], [isoIn(30), isoIn(30), true, 'business']);
  assert.match(chats[0], /現在 70,000 哩，你付了 88,000 哩：每人少 18,000 哩，2 人共少 36,000 哩/);
  assert.match(chats[0], /取消退哩：免費；改票：免費/);
  assert.match(chats[0], /聯合，BR18/);
  r = await bk.run();
  assert.equal(r.report[0].told, undefined, 'the same price is not told again');
  assert.equal((await bk.run({ force: false })).report[0].skipped, 'done-today', 'the evening cron spends nothing on it');
  for (let i = 1; i <= 4; i++) await bk.add({ ...leg, date: isoIn(30 + i) });
  await assert.rejects(bk.add({ ...leg, date: isoIn(40) }), /最多 5 段/);
  rows = [];
  const listed = await bk.list();
  assert.equal(listed.length, 5);
  await bk.remove(listed[1].id);
  assert.equal((await bk.list()).length, 4);
});

// ---------- N2 ----------
const dealRow = (id, miles, airlines, extra = {}) => ({ id, date: isoIn(40), origin: 'TPE', destination: 'CDG', source: 'aeroplan', cabins: { J: { available: true, miles, seats: 2, airlines, direct: false } }, ...extra });

test('N2: rules are checked and matched on region, cabin, miles, operating airlines, seats and dates', () => {
  assert.throws(() => cleanRule({}), /至少設一個條件/);
  assert.throws(() => cleanRule({ region: 'mars' }), /地區/);
  assert.throws(() => cleanRule({ cabin: 'Y' }), /商務艙和頭等艙/);
  assert.throws(() => cleanRule({ maxMiles: 'abc' }), /哩數上限/);
  assert.throws(() => cleanRule({ airlines: 'EVA' }), /兩碼/);
  const r = cleanRule({ region: 'eu', cabin: 'j', maxMiles: '80,000', airlines: 'br, jx', minSeats: 2 });
  assert.equal(ruleLabel(r), '歐洲・商務艙・80,000 哩內・BR／JX 自家飛・至少 2 位');
  const at = (row, region = 'eu', cabin = 'J') => matches(r, { region, cabin, row, start: isoIn(1) });
  assert.equal(at(dealRow('a', 75000, 'BR')), true);
  assert.equal(at(dealRow('a', 75000, 'BR, JX')), true);
  assert.equal(at(dealRow('a', 75000, 'BR, TK')), false, 'every leg flown by the chosen airlines');
  assert.equal(at(dealRow('a', 85000, 'BR')), false);
  assert.equal(at(dealRow('a', 75000, 'BR'), 'na'), false);
  assert.equal(at(dealRow('a', 75000, 'BR', { cabins: { J: { available: true, miles: 75000, seats: 1, airlines: 'BR' } } })), false, 'too few seats');
  assert.equal(at(dealRow('a', 75000, 'BR', { cabins: { J: { available: true, miles: 75000, seats: null, airlines: 'BR' } } })), true, 'unknown seats pass, as in seat alerts');
  const dated = cleanRule({ from: isoIn(50), to: isoIn(60) });
  assert.equal(matches(dated, { region: 'eu', cabin: 'J', row: dealRow('a', 1, 'BR') }), false);
  assert.equal(matches(dated, { region: 'eu', cabin: 'J', row: dealRow('a', 1, 'BR', { date: isoIn(55) }) }), true);
});

test('N2: matched against every row the refresh fetched (not the cheapest kept per city), sent once, highlighted', async () => {
  // CDG's cheapest is on TK, so 今日好康 keeps that one; the BR row behind it is still a match.
  const rows = [dealRow('tk', 50000, 'TK'), dealRow('br', 75000, 'BR'), dealRow('br-dear', 99000, 'BR')];
  rows.fetchedAt = Date.now();
  const kv = memoryKv();
  const chats = [];
  let down = false;
  const rules = createDealRules({ kv, notify: { telegram: async (h) => { if (down) return false; chats.push(h); return true; }, line: async () => { throw new Error('should be off'); } }, names: { program: () => '加航', city: () => '巴黎' }, siteUrl: 'https://x.test' });
  await rules.saveRule({ region: 'eu', cabin: 'J', maxMiles: 80000, airlines: 'BR' });
  const searches = [];
  const deals = createDeals({ store: null, days: 60, search: async (p) => { searches.push(p); return p.destination_airport.includes('CDG') && p.cabins === 'business' ? rows : Object.assign([], { fetchedAt: Date.now() }); }, onFetched: (g) => rules.onFetched(g) });
  down = true;
  let d = await deals.refresh();
  assert.equal(d.groups.find((g) => g.id === 'eu' && g.cabin === 'J').items[0].id, 'tk', 'the home page keeps the cheapest');
  assert.equal(chats.length, 0);
  down = false;
  d = await deals.refresh();
  assert.equal(chats.length, 1, 'a failed send is tried again on the next refresh');
  assert.match(chats[0], /今日好康有 1 筆符合你的條件/);
  assert.match(chats[0], /TPE→CDG 巴黎 商務艙 75,000 哩・加航・BR/);
  await deals.refresh();
  assert.equal(chats.length, 1, 'a match is sent once');
  const v = await rules.view();
  assert.deepEqual(v.hits.map((h) => [h.key, h.rules.length]), [['br:J', 1]]);
  assert.equal(searches.length, 24, 'three refreshes of 8 groups each: the rules add no search');
  assert.deepEqual(matchGroups([cleanRule({ airlines: 'TK' })], [{ id: 'eu', cabin: 'J', rows, start: isoIn(1) }]).map((h) => h.key), ['tk:J']);
  await assert.rejects(rules.setChannels({ email: 'nope' }), /Email/);
  assert.equal((await rules.setChannels({ line: true })).line, true);
});

// ---------- N14 ----------
test('N14: a sentence that asks to be told is an alert, with its cap and flights checked', () => {
  const ctx = { today: '2026-10-16', airportOk: (c) => /^[A-Z]{3}$/.test(c), programIds: ['united'], regions: ['Europe'] };
  const raw = mockParse(normalize('長榮BR16 十二月台北到舊金山商務艙 8萬哩內 有位通知我'), '2026-10-16');
  assert.deepEqual([raw.intent, raw.max_miles, raw.flights], ['alert', 80000, ['BR16']]);
  const v = nlValidate({ ...raw, destination: ['SFO'] }, ctx);
  assert.deepEqual([v.intent, v.maxMiles, v.flights, v.cabin], ['alert', 80000, ['BR16'], 'J']);
  assert.equal(mockParse('台北到東京商務', '2026-10-16').intent, 'search');
  const bad = nlValidate({ destination: ['SFO'], intent: 'buy', max_miles: 12, flights: ['BR16', 'hello'] }, ctx);
  assert.deepEqual([bad.intent, bad.maxMiles, bad.flights], ['search', null, ['BR16']]);
  assert.ok(bad.dropped.includes('哩數上限') && bad.dropped.includes('航班號碼'));
});

// ---------- server: U18 and the owner-only routes ----------
const { server } = require('../server');
let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

test('U18: /api/config says on or off only; the names of missing settings are the owner\'s', async () => {
  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.equal(cfg.cron, undefined);
  assert.equal(cfg.line.missing, undefined);
  assert.deepEqual(Object.keys(cfg.searchCache), ['enabled']);
  assert.deepEqual([cfg.booked, cfg.dealRules], [true, true]);
  for (const v of [cfg.telegram.configured, cfg.telegram.linked, cfg.line.configured, cfg.line.linked]) assert.equal(typeof v, 'boolean');
  assert.ok(!/LINE_CHANNEL|RESEND_API_KEY|CRON_SECRET|lastRun/.test(JSON.stringify(cfg)));
  process.env.CASH_PASSCODE = 'pw18';
  try {
    assert.equal((await fetch(`${base}/api/cron/status`)).status, 403);
    const st = await (await fetch(`${base}/api/cron/status`, { headers: { 'x-cash-pass': 'pw18' } })).json();
    assert.ok(st.setup.missing.includes('RESEND_API_KEY'));
    assert.equal(st.setup.searchCache.enabled, false);
  } finally { delete process.env.CASH_PASSCODE; }
});

test('/api/booked and /api/dealrules are the owner\'s, like seat alerts', async () => {
  const page = { 'content-type': 'application/json', 'x-requested-with': 'fetch' };
  process.env.CASH_PASSCODE = 'pw7';
  try {
    assert.equal((await fetch(`${base}/api/booked`)).status, 401);
    assert.equal((await fetch(`${base}/api/dealrules`)).status, 401);
    const own = { ...page, 'x-cash-pass': 'pw7' };
    const add = await fetch(`${base}/api/booked`, { method: 'POST', headers: own, body: JSON.stringify({ date: isoIn(30), from: 'TPE', to: 'YVR', cabin: 'J', program: 'aeroplan', miles: 120000 }) });
    assert.equal(add.status, 200);
    const list = await (await fetch(`${base}/api/booked`, { headers: own })).json();
    assert.deepEqual([list.max, list.legs.length], [5, 1]);
    const rule = await (await fetch(`${base}/api/dealrules`, { method: 'POST', headers: own, body: JSON.stringify({ region: 'eu', airlines: 'BR' }) })).json();
    assert.equal(rule.rules.length, 1);
    assert.equal((await fetch(`${base}/api/dealrules`, { method: 'POST', headers: own, body: '{}' })).status, 400);
    const ch = await (await fetch(`${base}/api/dealrules/channels`, { method: 'POST', headers: own, body: JSON.stringify({ telegram: false }) })).json();
    assert.equal(ch.telegram, false);
    const del = await (await fetch(`${base}/api/dealrules?id=${rule.rules[0].id}`, { method: 'DELETE', headers: own })).json();
    assert.equal(del.rules.length, 0);
  } finally { delete process.env.CASH_PASSCODE; }
});
