// Round 6 我的行程與出發前: key dates, reminders and .ics (public/trips.js), the separate-ticket connection check, the
// passport rule, the leave-day count (public/leave.js), the trip notes in the expiry mail (lib/expiry.js), the
// confirmation-mail reader's checks (lib/ticketparse.js), the plan's new leg fields and the account merge.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const T = require('../public/trips.js');
const { leaveFor, twOff } = require('../public/leave.js');
const { cleanNotes, passportNote, notesFromData, createExpiry, addMonths } = require('../lib/expiry');
const { validateTicket, mockTicket } = require('../lib/ticketparse');
const { memoryKv } = require('../lib/kv');
const { todayTW, addDays } = require('../lib/day');

const trips = require('../data/trips.json');
const holds = require('../data/holds.json');
const AIR = {
  TPE: { country: 'TW', lat: 25.08, lon: 121.23 }, TSA: { country: 'TW', lat: 25.07, lon: 121.55 }, NRT: { country: 'JP', lat: 35.76, lon: 140.39 },
  HND: { country: 'JP', lat: 35.55, lon: 139.78 }, LAX: { country: 'US', lat: 33.94, lon: -118.41 }, BKK: { country: 'TH', lat: 13.69, lon: 100.75 },
  YVR: { country: 'CA', lat: 49.19, lon: -123.18 }, IST: { country: 'TR', lat: 41.26, lon: 28.74 }, CDG: { country: 'FR', lat: 49.01, lon: 2.55 },
};
const ctx = (extra = {}) => ({ trips, holds, today: '2026-10-16', ap: (c) => AIR[c] || null, keyOf: (x) => x, name: (x) => x, ...extra });
const leg = (o) => ({ k: 'a', date: '2026-11-03', from: 'TPE', to: 'NRT', flights: 'BR 198', cabin: 'J', pax: 1, miles: 50000, program: 'eva', ...o });

test('trips.json: every rule is cited from an official page; passport rules have the fields the check reads', () => {
  for (const [k, c] of Object.entries(trips.checkin)) {
    assert.ok(c.hours > 0 && /^https:\/\//.test(c.url) && c.quote, k);
  }
  for (const [k, t] of Object.entries(trips.tickets)) {
    assert.ok(t.sources?.length && t.sources.every((s) => /^https:\/\//.test(s.url) && /官方/.test(s.label)), k);
    if (t.cancel) assert.ok(Number.isFinite(t.cancel.before) && t.cancel.text, `${k} cancel`);
  }
  for (const [cc, r] of Object.entries(trips.passport.countries)) {
    assert.ok(Number.isInteger(r.months) && ['entry', 'exit'].includes(r.from) && r.quote, cc);
    assert.match(r.url, /^https:\/\/www\.boca\.gov\.tw\//, cc);
  }
  assert.equal(trips.passport.renewMonths, 9);
  assert.ok(trips.cardPerks.cards.every((c) => /^https:\/\/www\.kgibank\.com\.tw\//.test(c.url) && c.quotes.length));
});

test('legKeyDates: hold expiry, ticket validity, check-in opening (US routes use the US hours)', () => {
  const held = T.legKeyDates(leg({ status: 'held', holdUntil: '2026-10-20' }), [], ctx());
  assert.deepEqual(held.map((d) => [d.kind, d.date, d.steps]), [['hold', '2026-10-20', [1, 0]]]);
  // No date entered: the hold rule from data/holds.json, no reminder.
  const hint = T.legKeyDates(leg({ status: 'held' }), [], ctx())[0];
  assert.equal(hint.date, null);
  assert.match(hint.text, /通常可保留約 1 天/);
  const ticket = T.legKeyDates(leg({ status: 'ticketed', ticketedOn: '2026-10-10', dep: '08:50', arr: '13:15' }), [], ctx());
  const by = Object.fromEntries(ticket.map((d) => [d.kind, d]));
  assert.equal(by.valid.date, '2027-10-10');
  assert.equal(by.valid.warn, false);
  assert.deepEqual([by.checkin.date, by.checkin.time, by.checkin.steps], ['2026-11-01', '08:50', [0]]);
  assert.equal(by.cancel.steps, null, 'a ticket that is not a backup gets no cancel reminder');
  // China Airlines to Los Angeles: 24 hours, not 48.
  const us = T.legKeyDates(leg({ to: 'LAX', flights: 'CI 6', program: 'ci', status: 'ticketed', dep: '23:40' }), [], ctx()).find((d) => d.kind === 'checkin');
  assert.deepEqual([us.date, us.time], ['2026-11-02', '23:40']);
  // No departure time: whole days are still exact, the time is left out.
  const noTime = T.legKeyDates(leg({ status: 'ticketed' }), [], ctx()).find((d) => d.kind === 'checkin');
  assert.deepEqual([noTime.date, noTime.time], ['2026-11-01', null]);
  // Planning (no status): nothing to remind.
  assert.deepEqual(T.legKeyDates(leg({}), [], ctx()), []);
});

test('legKeyDates: a held or ticketed backup for a waitlisted leg gets its cancel deadline as a reminder', () => {
  const wait = leg({ program: 'united', flights: 'UA 32', status: 'waitlist', backup: 'BR198 已開票' });
  const backup = leg({ program: 'aeroplan', flights: 'NH 802', status: 'ticketed', dep: '09:30' });
  const legs = [wait, backup];
  const c = T.legKeyDates(backup, legs, ctx()).find((d) => d.kind === 'cancel');
  assert.equal(c.label, '備案的取消期限');
  assert.deepEqual([c.date, c.time, c.steps], ['2026-11-03', '07:30', [3, 0]]); // Aeroplan: up to 2 hours before
  const w = T.legKeyDates(wait, legs, ctx()).find((d) => d.kind === 'wait');
  assert.deepEqual([w.date, w.steps, w.text], ['2026-11-03', [14, 3], '備案：BR198 已開票']);
  // British Airways: 24 hours before, so the day before when the flight leaves in the morning.
  const ba = T.legKeyDates(leg({ program: 'british', status: 'held', dep: '10:00' }), [wait, leg({ program: 'british', status: 'held', dep: '10:00' })], ctx()).find((d) => d.kind === 'cancel');
  assert.deepEqual([ba.date, ba.time], ['2026-11-02', '10:00']);
});

test('tripNotes: future dates with reminders only, keys the mail run accepts, soonest first', () => {
  const plan = { legs: [
    leg({ status: 'ticketed', ticketedOn: '2026-10-10', dep: '08:50' }),
    leg({ date: '2026-12-20', from: 'NRT', to: 'TPE', flights: 'JX 801', program: 'starlux', status: 'held', holdUntil: '2026-10-20' }),
    leg({ date: '2026-10-17', status: 'held', holdUntil: '2026-10-15' }), // already past: left out
  ] };
  const notes = T.tripNotes(plan, ctx());
  assert.deepEqual(notes.map((n) => [n.key, n.date, n.steps]), [
    ['hold-NRTTPE-2026-12-20', '2026-10-20', [1, 0]],
    ['checkin-TPENRT-2026-11-03', '2026-11-01', [0]],
  ]);
  assert.equal(notes[1].name, 'BR198 TPE→NRT（11/3）開放線上報到 08:50 起');
  assert.deepEqual(cleanNotes(notes), notes, 'lib/expiry.js keeps them as they are');
});

test('tripIcs: one event per leg and per dated key date, folded lines, escaped text, a 9:00 alarm on reminders', () => {
  const plan = { name: '東京, 商務；來回', legs: [leg({ status: 'ticketed', ticketedOn: '2026-10-10', dep: '08:50', arr: '13:15', pnr: 'ABC123', backup: '' })] };
  const ics = T.tripIcs(plan, ctx({ stamp: '20261016T000000Z' }));
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  assert.equal(ics.split('BEGIN:VEVENT').length - 1, 3); // the flight, check-in, validity (the cancel rule only for a backup)
  assert.match(ics, /X-WR-CALNAME:東京\\, 商務\\；來回|X-WR-CALNAME:東京\\, 商務；來回/);
  assert.match(ics, /DTSTART;VALUE=DATE:20261103\r\nDTEND;VALUE=DATE:20261104/);
  assert.match(ics, /SUMMARY:✈ BR 198 TPE→NRT 08:50–13:15/);
  assert.match(ics.replace(/\r\n /g, ''), /訂位代號 ABC123/);
  assert.match(ics, /SUMMARY:開放線上報到 08:50：TPE→NRT（11\/3）\r\n(?:DESCRIPTION:[^\r]*\r\n(?: [^\r]*\r\n)*)?BEGIN:VALARM\r\nTRIGGER:PT9H/);
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, `too long: ${line}`);
});

test('tripConnections: separate tickets under 3 hours abroad, same-ticket legs skipped, other airport, bags and the transit visa', () => {
  const a = leg({ dep: '08:50', arr: '13:15', pnr: 'AAA111' });
  const b = leg({ from: 'NRT', to: 'LAX', flights: 'ZG 24', program: '', k: 'c', dep: '15:00', pnr: 'BBB222' });
  let r = T.tripConnections([a, b], ctx({ visa: () => ({ type: 'free', days: 90 }), countryName: () => '日本' }));
  assert.equal(r.length, 1);
  assert.equal(r[0].gap, 105);
  assert.equal(r[0].lines[0].level, 'bad');
  assert.match(r[0].lines[0].text, /只留 1 小時 45 分轉機，國際線建議至少 3 小時/);
  assert.ok(r[0].lines.some((l) => /重新報到托運/.test(l.text)));
  assert.ok(r[0].lines.some((l) => l.level === 'ok' && /入境日本免簽 90 天/.test(l.text)));
  // Enough time: fine, still the bags line.
  r = T.tripConnections([a, { ...b, dep: '17:30' }], ctx());
  assert.deepEqual([r[0].gap, r[0].lines[0].level, r[0].lines[0].text], [255, 'ok', '分開開票，轉機 4 小時 15 分']);
  // One booking: nothing to check.
  assert.deepEqual(T.tripConnections([a, { ...b, pnr: 'AAA111' }], ctx()), []);
  assert.deepEqual(T.tripConnections([{ ...a, pnr: '', tk: 'x1y2' }, { ...b, pnr: '', tk: 'x1y2' }], ctx()), []);
  // Landing at Narita, leaving from Haneda: a line about the other airport.
  r = T.tripConnections([a, { ...b, from: 'HND', dep: '19:00' }], ctx());
  assert.ok(r[0].lines.some((l) => l.level === 'warn' && /NRT 換到 HND/.test(l.text)));
  // The same day without times: asks for them. The next day without times: a stopover, nothing said.
  r = T.tripConnections([{ ...a, arr: undefined }, b], ctx());
  assert.equal(r[0].lines[0].level, 'warn');
  assert.deepEqual(T.tripConnections([{ ...a, arr: undefined }, { ...b, date: '2026-11-04', dep: undefined }], ctx()), []);
  // Overnight arrival (+1) and an early next-day departure count across midnight.
  r = T.tripConnections([leg({ to: 'LAX', arr: '06:00', arrDays: 1, dep: '19:00' }), leg({ date: '2026-11-04', from: 'LAX', to: 'YVR', dep: '08:00', flights: 'AC 1' })], ctx({ visa: () => ({ type: 'eta' }), countryName: () => '美國' }));
  assert.equal(r[0].gap, 120);
  assert.ok(r[0].lines.some((l) => l.level === 'warn' && /入境美國要先上網申請入境許可/.test(l.text)));
  // A visa is needed: said plainly. Unknown country rules: 待確認.
  r = T.tripConnections([a, b], ctx({ visa: () => ({ type: 'required' }), countryName: () => '日本' }));
  assert.ok(r[0].lines.some((l) => l.level === 'bad' && /需要簽證/.test(l.text)));
  r = T.tripConnections([a, b], ctx({ visa: () => null, countryName: () => '日本' }));
  assert.ok(r[0].lines.some((l) => /待確認/.test(l.text)));
  // A domestic connection at home: no visa line.
  r = T.tripConnections([leg({ from: 'NRT', to: 'TPE', arr: '12:00' }), leg({ from: 'TPE', to: 'BKK', dep: '13:00', flights: 'TG 635' })], ctx({ visa: () => ({ type: 'free' }) }));
  assert.ok(!r[0].lines.some((l) => /免簽|簽證|許可|待確認/.test(l.text)));
});

test('passportCheck: months from entry or exit, Turkey\'s extra days, unknown rules, the 9-month renewal', () => {
  const P = trips.passport.countries;
  const th = { rule: P.TH, entry: '2026-12-01', exit: '2026-12-08', today: '2026-10-16' };
  assert.equal(T.passportCheck({ ...th, expiry: '2027-05-31' }).level, 'bad');
  const ok = T.passportCheck({ ...th, expiry: '2027-06-01' });
  assert.deepEqual([ok.level, ok.need, ok.renew, ok.renewDue], ['ok', '2027-06-01', true, '2026-09-01']);
  // Japan: valid through the stay is enough.
  assert.equal(T.passportCheck({ rule: P.JP, entry: '2026-12-01', exit: '2026-12-08', expiry: '2026-12-08' }).level, 'ok');
  assert.equal(T.passportCheck({ rule: P.JP, entry: '2026-12-01', exit: '2026-12-08', expiry: '2026-12-07' }).level, 'bad');
  // Schengen (France): 3 months after leaving.
  assert.equal(T.passportCheck({ rule: P.FR, entry: '2026-12-01', exit: '2026-12-20', expiry: '2027-03-19' }).need, '2027-03-20');
  // Turkey: 6 months from entry, and 60 days after the stay ends, whichever is later.
  assert.equal(T.passportCheck({ rule: P.TR, entry: '2026-12-01', exit: '2026-12-10', expiry: '2028-01-01' }).need, '2027-06-01');
  assert.equal(T.passportCheck({ rule: { months: 0, from: 'entry', plusDays: 60 }, entry: '2026-12-01', exit: '2026-12-10', expiry: '2028-01-01' }).need, '2027-02-08');
  // No rule on file: only the stay itself is checked, and it says so.
  const unk = T.passportCheck({ rule: null, entry: '2026-12-01', exit: '2026-12-08', expiry: '2027-01-01', today: '2026-10-16' });
  assert.deepEqual([unk.level, unk.during], ['unknown', false]);
  assert.equal(T.passportCheck({ rule: null, entry: '2026-12-01', exit: '2026-12-08', expiry: '2026-12-05' }).during, true);
  assert.equal(T.passportCheck({ expiry: 'soon', entry: '2026-12-01' }), null);
  assert.equal(T.passportRuleText(P.TH), '入境時護照要還有 6 個月以上效期');
  assert.equal(T.passportRuleText(P.FR), '離開申根區時護照要還有 3 個月以上效期');
  assert.equal(T.passportRuleText(P.JP), '護照效期要涵蓋停留期間');
  // A plan's stays: arrival and the next leg leaving that country.
  const stays = T.planCountries([leg({ to: 'BKK' }), leg({ date: '2026-11-08', from: 'BKK', to: 'TPE' })], ctx());
  assert.deepEqual(stays, [{ country: 'TH', entry: '2026-11-03', exit: '2026-11-08' }]);
});

test('leaveFor: 請 N 天休 M 天 from the Taiwan calendar, weekends and make-up workdays included', () => {
  // 2026-10-09 (Fri) is a day off before 國慶日 on Saturday; 2026-09-26 (Sat) is a make-up workday in this sample.
  const isOff = twOff([{ date: '2026-10-09', off: true }, { date: '2026-09-26', off: false, workday: true }]);
  assert.equal(isOff('2026-10-10'), true); // a plain Saturday
  assert.equal(isOff('2026-09-26'), false);
  assert.deepEqual(leaveFor('2026-10-08', 2, isOff), { leave: 1, total: 4, from: '2026-10-08', to: '2026-10-11' });
  assert.deepEqual(leaveFor('2026-10-09', 3, isOff), { leave: 0, total: 3, from: '2026-10-09', to: '2026-10-11' });
  // Wednesday to Tuesday (7 days): Wed, Thu, Mon, Tue at work; Fri is off.
  assert.deepEqual(leaveFor('2026-10-07', 7, isOff), { leave: 4, total: 7, from: '2026-10-07', to: '2026-10-13' });
  // Leaving on a Sunday: the Saturday before counts as time off too.
  assert.deepEqual(leaveFor('2026-10-18', 3, isOff), { leave: 2, total: 4, from: '2026-10-17', to: '2026-10-20' });
  // The make-up Saturday breaks the weekend.
  assert.deepEqual(leaveFor('2026-09-27', 1, isOff), { leave: 0, total: 1, from: '2026-09-27', to: '2026-09-27' });
});

test('expiry notes: cleaned, the passport renewal 9 months ahead, the owner list keeps wallet and trip notes, the run mails them', async () => {
  assert.deepEqual(cleanNotes([{ key: 'a|b', name: 'x', date: '2026-11-01' }, { key: 'ok', name: '  ', date: '2026-11-01' }, { key: 'ok', name: 'n', date: 'bad' }, { key: 'k', name: 'n', date: '2026-11-01', steps: [500, -1, 2] }]),
    [{ key: 'k', name: 'n', date: '2026-11-01', steps: [2] }]);
  const pp = passportNote({ expiry: '2027-12-31' });
  assert.deepEqual([pp.key, pp.date, pp.steps], ['passport', '2027-12-31', [Math.round((Date.parse('2027-12-31') - Date.parse(addMonths('2027-12-31', -9))) / 864e5)]]);
  assert.equal(passportNote({ expiry: 'x' }), null);
  assert.equal(notesFromData({ 'plan:v1': { legs: [], remind: [{ key: 'checkin-TPENRT-2026-11-03', name: 'n', date: '2026-11-01', steps: [0] }] }, 'passport:v1': { expiry: '2027-12-31' } }).length, 2);

  const kv = memoryKv();
  const today = todayTW();
  const mails = [];
  const chats = [];
  const accountData = { 'plan:v1': { remind: [{ key: 'hold-NRTTPE-2026-12-20', name: 'JX801 NRT→TPE 保留到期', date: addDays(today, 1), steps: [1, 0] }] } };
  const ex = createExpiry({ kv, rules: {}, loadAccount: async () => ({ wallet: null, notes: notesFromData(accountData) }), sendEmail: async (m) => mails.push(m), notify: async (h) => { chats.push(h); return true; } });
  await ex.track('t@x.co', null, notesFromData(accountData));
  assert.deepEqual(await kv.get('expiry:v1:emails'), ['t@x.co'], 'notes alone keep an account on the list');
  // Owner: the wallet saved from 我的點數, then notes from 我的行程; neither wipes the other.
  await ex.saveOwner({ email: 'me@x.co', wallet: { miles: { eva: 1000 }, expiry: { eva: addDays(today, 200) } } });
  const r = await ex.saveOwner({ email: 'me@x.co', notes: [{ key: 'checkin-TPENRT-x', name: 'BR198 開放線上報到', date: today, steps: [0] }], passport: { expiry: addDays(today, 100) } });
  assert.deepEqual(r, { ok: true, count: 2, email: 'me@x.co' });
  assert.deepEqual(await ex.getOwner().then((o) => [o.count, o.notes]), [1, 2]);
  const run = await ex.run();
  assert.equal(run.reminded, 2);
  const mine = mails.find((m) => m.to === 'me@x.co');
  assert.match(mine.subject, /行程提醒：BR198 開放線上報到 等 2 筆（就是今天）/);
  assert.match(mine.html, /護照 .* 到期，建議到期前 9 個月換發/);
  assert.match(mails.find((m) => m.to === 't@x.co').subject, /行程提醒：JX801 NRT→TPE 保留到期（還有 1 天）/);
  assert.match(chats[0], /🧳 <b>行程提醒<\/b>/);
  assert.equal((await ex.run()).reminded, 0, 'once per step');
  // Clearing everything removes the owner list.
  assert.deepEqual(await ex.saveOwner({ email: '', wallet: {}, notes: [], passport: null }), { ok: true, count: 0 });
});

test('ticketparse: legs checked field by field; the demo reader finds flights, times, the booking reference', () => {
  const opts = { today: '2026-10-16', airportOk: (c) => Boolean(AIR[c]), programIds: ['eva', 'ci'] };
  const out = validateTicket({ award: true, program: 'eva', miles_per_person: 50000, ticketed_on: '2026-10-10', passengers: 2, legs: [
    { date: '2026-11-03', from: 'tpe', to: 'NRT', flight: 'BR 198', dep: '08:50', arr: '13:15', arr_day_offset: 0, cabin: 'J', pnr: 'abc123' },
    { date: '2026-11-10', from: 'NRT', to: 'XXX', flight: 'BR197', dep: '14:00' },
    { date: '2020-01-01', from: 'NRT', to: 'TPE', flight: 'BR197' },
  ] }, opts);
  assert.deepEqual(out.dropped, ['第 2 段（抵達機場）', '第 3 段（日期）']);
  assert.deepEqual(out.legs, [{ k: 'a', date: '2026-11-03', from: 'TPE', to: 'NRT', flights: 'BR 198', cabin: 'J', pax: 2, miles: 50000, program: 'eva', price: null, note: '', dep: '08:50', arr: '13:15', arrDays: 0, pnr: 'ABC123', status: 'ticketed', ticketedOn: '2026-10-10' }]);
  const raw = mockTicket('長榮航空 酬賓機票\n訂位代號 XYZ789\nBR 198 2026/11/03 TPE 08:50 NRT 13:15 商務艙\nBR 197 11月10日 NRT 14:30 TPE 17:20', '2026-10-16');
  assert.deepEqual(raw.legs.map((l) => [l.flight, l.date, l.from, l.to, l.dep, l.arr, l.pnr]), [['BR198', '2026-11-03', 'TPE', 'NRT', '08:50', '13:15', 'XYZ789'], ['BR197', '2026-11-10', 'NRT', 'TPE', '14:30', '17:20', 'XYZ789']]);
  assert.equal(raw.program, 'eva');
});

// features.js cleanLeg / cleanPlan in a sandbox: the new fields survive, bad ones are dropped, old plans are unchanged.
function planSandbox() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'features.js'), 'utf8');
  const code = src.slice(src.indexOf('const MAX_LEGS'), src.indexOf('let plan = '));
  const c = {};
  vm.createContext(c);
  vm.runInContext(`${code}\nthis.cleanLeg = cleanLeg; this.cleanPlan = cleanPlan;`, c);
  return c;
}
test('plan legs keep status, times and the booking reference; the reminders list is validated', () => {
  const { cleanLeg, cleanPlan } = planSandbox();
  const base = { k: 'a', date: '2026-11-03', from: 'TPE', to: 'NRT', flights: 'BR 198', cabin: 'J', pax: 1, miles: 50000, program: 'eva' };
  assert.deepEqual(Object.keys(cleanLeg(base)), ['k', 'date', 'from', 'to', 'flights', 'cabin', 'pax', 'miles', 'program', 'tax', 'price', 'note'], 'an old leg gains no fields');
  const l = cleanLeg({ ...base, status: 'ticketed', ticketedOn: '2026-10-10', holdUntil: 'soon', dep: '08:50', arr: '25:00', arrDays: 1, pnr: 'ABC123', tk: 'x1y2', backup: ' BR 198 '.repeat(10) });
  assert.deepEqual([l.status, l.ticketedOn, l.holdUntil, l.dep, l.arr, l.arrDays, l.pnr, l.tk, l.backup.length], ['ticketed', '2026-10-10', undefined, '08:50', undefined, 1, 'ABC123', 'x1y2', 40]);
  assert.equal(cleanLeg({ ...base, status: 'booked', pnr: '<b>' }).status, undefined);
  const p = cleanPlan({ legs: [base], remind: [{ key: 'checkin-TPENRT-2026-11-03', name: 'x', date: '2026-11-01', steps: [0, 1.5] }, { key: 'a|b', name: 'x', date: '2026-11-01', steps: [0] }] });
  assert.deepEqual(p.remind, [{ key: 'checkin-TPENRT-2026-11-03', name: 'x', date: '2026-11-01', steps: [0] }]);
  assert.equal('remind' in cleanPlan({ legs: [base] }), false);
});

// account.js plan merge: a leg changed on this device since the last sync keeps its status over the account's copy.
test('account merge keeps the 訂位進度 edited on this device', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'account.js'), 'utf8');
  const helpers = src.slice(src.indexOf('const stable ='), src.indexOf('// Storage writes made by this file'));
  const merge = src.slice(src.indexOf('// ---------- merging two copies'), src.indexOf('// ---------- this device'));
  const c = {};
  vm.createContext(c);
  vm.runInContext(`${src.match(/const SYNC_KEYS = .*;/)[0]}\n${helpers}\n${merge}\nthis.mergeAll = mergeAll;`, c);
  const base = { k: 'a', date: '2026-11-03', from: 'TPE', to: 'NRT', flights: 'BR 198', cabin: 'J', pax: 1, miles: 50000, program: 'eva' };
  const b = { 'plan:v1': { name: 'x', legs: [base] }, 'passport:v1': { expiry: '2027-01-01' } };
  const local = { 'plan:v1': { name: 'x', legs: [{ ...base, status: 'ticketed', ticketedOn: '2026-10-16' }] }, 'passport:v1': { expiry: '2027-01-01' } };
  const remote = { 'plan:v1': { name: 'y', legs: [base, { ...base, date: '2026-11-10', from: 'NRT', to: 'TPE' }] }, 'passport:v1': { expiry: '2028-05-01' } };
  const out = c.mergeAll(local, remote, b);
  assert.equal(out['plan:v1'].legs.length, 2);
  assert.equal(out['plan:v1'].legs[0].status, 'ticketed');
  assert.deepEqual(out['passport:v1'], { expiry: '2028-05-01' });
});
