// Weekday counts in the award-space history (「星期幾比較容易有位」): what one search adds, how looks add up per
// week, the caps, and records stored before the counts existed.
const { test } = require('node:test');
const assert = require('node:assert');
const { createHistory, summarizeWeekdays, mergeDay, mockHistory, dayNum, weekdayOf } = require('../lib/history');
const { memoryKv } = require('../lib/kv');

const row = (o, d, date, source, c, miles = 50000) => ({ date, origin: o, destination: d, source, cabins: { [c]: { available: true, miles, seats: 2 } } });

test('weekdayOf: Monday first', () => {
  assert.equal(weekdayOf(dayNum('2026-10-12')), 0); // a Monday
  assert.equal(weekdayOf(dayNum('2026-10-15')), 3); // Thursday
  assert.equal(weekdayOf(dayNum('2026-10-18')), 6); // Sunday
});

test('summarizeWeekdays: dates with space on any program by weekday, dates looked at from the search range', () => {
  const p = { origin_airport: 'TPE', destination_airport: 'NRT,HND', cabins: 'business', start_date: '2026-10-12', end_date: '2026-10-25' };
  const rows = [
    row('TPE', 'NRT', '2026-10-13', 'aeroplan', 'J'), // Tuesday
    row('TPE', 'NRT', '2026-10-13', 'united', 'J'), // same date, another program: counted once
    row('TPE', 'NRT', '2026-10-20', 'united', 'J'), // the next Tuesday
    row('TPE', 'NRT', '2026-10-17', 'aeroplan', 'Y'), // economy: not what was searched
    row('TPE', 'NRT', '2026-11-30', 'aeroplan', 'J'), // outside the range
    { ...row('TPE', 'NRT', '2026-10-14', 'aeroplan', 'J'), cabins: { J: { available: false } } },
  ];
  const s = summarizeWeekdays(p, rows);
  assert.deepEqual([...s.keys()], ['TPE-NRT', 'TPE-HND']);
  assert.deepEqual(s.get('TPE-NRT'), { J: [[0, 2, 0, 0, 0, 0, 0], [2, 2, 2, 2, 2, 2, 2], 14] });
  assert.deepEqual(s.get('TPE-HND'), { J: [[0, 0, 0, 0, 0, 0, 0], [2, 2, 2, 2, 2, 2, 2], 14] }, 'looked, nothing there');
  // Days before today cannot be flown: the range starts today.
  const later = summarizeWeekdays(p, rows, { today: dayNum('2026-10-19') });
  assert.deepEqual(later.get('TPE-NRT').J, [[0, 1, 0, 0, 0, 0, 0], [1, 1, 1, 1, 1, 1, 1], 7]);
  // No range given: the dates its rows cover. No rows and no range: nothing to say.
  const noRange = summarizeWeekdays({ origin_airport: 'TPE', destination_airport: 'NRT', cabins: 'business' }, rows.slice(0, 3));
  assert.deepEqual(noRange.get('TPE-NRT').J, [[0, 2, 0, 0, 0, 0, 0], [1, 2, 1, 1, 1, 1, 1], 8]);
  assert.equal(summarizeWeekdays({ origin_airport: 'TPE', destination_airport: 'NRT' }, []).size, 0);
  // No cabin given: every cabin.
  assert.deepEqual(Object.keys(summarizeWeekdays({ ...p, cabins: undefined }, rows).get('TPE-NRT')), ['Y', 'W', 'J', 'F']);
});

test('mergeDay: weekday counts add up per calendar week and are trimmed with the days', () => {
  const wk = (has, span = 14) => ({ J: [has, [2, 2, 2, 2, 2, 2, 2], span] });
  const mon = dayNum('2026-10-12');
  let rec = mergeDay(null, mon, new Map(), { wk: wk([1, 2, 0, 0, 0, 0, 0]) });
  rec = mergeDay(rec, mon + 3, new Map(), { wk: wk([0, 1, 0, 0, 0, 0, 1], 30) }); // same week
  rec = mergeDay(rec, mon + 7, new Map(), { wk: wk([1, 1, 1, 1, 1, 1, 1]) }); // next week
  assert.deepEqual(rec.w.J, [
    [Math.floor((mon + 3) / 7), [1, 3, 0, 0, 0, 0, 1], [4, 4, 4, 4, 4, 4, 4], 30],
    [Math.floor((mon + 10) / 7), [1, 1, 1, 1, 1, 1, 1], [2, 2, 2, 2, 2, 2, 2], 14],
  ]);
  // A week leaves once its last day is outside the window.
  const trimmed = mergeDay(rec, mon + 13, new Map(), { days: 7 });
  assert.equal(trimmed.w.J.length, 1);
  assert.equal(mergeDay(rec, mon + 20, new Map(), { days: 7 }).w.J, undefined);
  // The byte cap still holds with weekday counts in the record.
  let big = null;
  for (let d = 1000; d < 1200; d++) big = mergeDay(big, d, new Map([['aeroplan.J', [3, 50000, 2]]]), { wk: { J: [[9, 9, 9, 9, 9, 9, 9], [47, 47, 47, 47, 47, 47, 47], 330], Y: [[40, 40, 40, 40, 40, 40, 40], [47, 47, 47, 47, 47, 47, 47], 330] } });
  assert.ok(JSON.stringify(big).length <= 12000);
  assert.equal(big.obs.at(-1), 1199);
  assert.ok(big.w.J.at(-1)[1][0] > 9, 'the current week keeps adding up');
});

test('mergeDay: records stored before weekday counts stay as they were and gain them from the next look', () => {
  const old = { obs: [20000, 20001], r: { 'aeroplan.J': [[20000, 3, 60000, 2], [20001, 1, 55000, 1]] } };
  const same = mergeDay(old, 20002, new Map([['aeroplan.J', [2, 58000, 2]]]));
  assert.equal(same.w, undefined, 'no weekday counts given: none invented');
  assert.deepEqual(same.r['aeroplan.J'].slice(0, 2), old.r['aeroplan.J']);
  const now = mergeDay(old, 20002, new Map(), { wk: { J: [[1, 0, 0, 0, 0, 0, 0], [3, 3, 3, 3, 3, 3, 3], 21] } });
  assert.deepEqual(now.w.J, [[Math.floor(20005 / 7), [1, 0, 0, 0, 0, 0, 0], [3, 3, 3, 3, 3, 3, 3], 21]]);
  assert.deepEqual(now.r, old.r);
});

test('history: notes carry weekday counts to the page; old records show without them', async () => {
  let t = Date.parse('2026-10-12T04:00:00Z'); // Monday in Taiwan
  const kv = memoryKv();
  const h = createHistory({ kv, now: () => t });
  const p = { origin_airport: 'TPE', destination_airport: 'NRT', cabins: 'business', start_date: '2026-10-12', end_date: '2026-11-08' };
  await h.note(p, [row('TPE', 'NRT', '2026-10-14', 'aeroplan', 'J'), row('TPE', 'NRT', '2026-10-21', 'united', 'J')]);
  t += 864e5;
  await h.note(p, [row('TPE', 'NRT', '2026-10-14', 'aeroplan', 'J')]); // range now starts on the 13th
  const { routes } = await h.get('TPE', 'NRT');
  assert.deepEqual(routes[0].weekdays, { J: { has: [0, 0, 3, 0, 0, 0, 0], looked: [7, 8, 8, 8, 8, 8, 8], span: 28, since: '2026-10-12' } });
  // A record written before the counts existed: the heatmap data as before, no weekdays.
  await kv.set('hist:v1:TPE-HND', { obs: [dayNum('2026-10-12')], r: { 'aeroplan.J': [[dayNum('2026-10-12'), 2, 60000, 1]] } });
  const old = (await h.get('TPE', 'HND')).routes[0];
  assert.equal(old.weekdays, undefined);
  assert.equal(old.series[0].days, 1);
  // The demo's made-up history has them too.
  const demo = createHistory({ kv: memoryKv(), enabled: false, demo: true, now: () => t });
  const d = (await demo.get('TPE', 'YVR')).routes[0].weekdays;
  assert.ok(d.J && d.Y);
  assert.ok(d.J.has.every((n, i) => n <= d.J.looked[i]));
  assert.ok(d.J.span >= 21);
  assert.ok(mockHistory('TPE', 'YVR').w.J.length > 5);
});
