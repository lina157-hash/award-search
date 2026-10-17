// Round 6 extras: 查航班動態／這班過去準點率 in 我的行程 (X1, lib/flightstatus.js + public/flightstatus.js), 買或等 under
// the cash fares' price level (X2, public/cashverdict.js) and 哪裡都好 in 區域探索 (X3, lib/anywhere.js + public/anywhere.js).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
delete process.env.SEATS_AERO_API_KEY;
delete process.env.RAPIDAPI_KEY;
delete process.env.SERPAPI_KEY;
delete process.env.CASH_PASSCODE;
delete process.env.CRON_SECRET;
const fsl = require('../lib/flightstatus');
const { createAnywhere, pickRegions, pagesPer, REGIONS, MAX_CALLS } = require('../lib/anywhere');
const { GROUPS, bestByDestination } = require('../lib/deals');
const { createClient } = require('../lib/seats');
const { memoryKv } = require('../lib/kv');
const page = require('../public/flightstatus.js');
const cv = require('../public/cashverdict.js');
const awp = require('../public/anywhere.js');
const { server } = require('../server');

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => new Promise((r) => server.close(r)));

// ---------- X1: flight status ----------
// A FlightContract as the AeroDataBox spec describes it (times "local+offset" / "utcZ").
const flight = (over = {}) => ({
  number: 'BR 32', status: 'Departed', codeshareStatus: 'IsOperator', isCargo: false, lastUpdatedUtc: '2026-10-16 01:02Z',
  departure: { airport: { iata: 'TPE', icao: 'RCTP', name: 'Taipei Taoyuan', shortName: 'Taoyuan' }, scheduledTime: { utc: '2026-10-16 00:30Z', local: '2026-10-16 08:30+08:00' }, revisedTime: { utc: '2026-10-16 00:52Z', local: '2026-10-16 08:52+08:00' }, terminal: '2', gate: 'C5', checkInDesk: '10-12', quality: ['Basic', 'Live'] },
  arrival: { airport: { iata: 'NRT', name: 'Tokyo Narita' }, scheduledTime: { utc: '2026-10-16 03:45Z', local: '2026-10-16 12:45+09:00' }, predictedTime: { utc: '2026-10-16 03:58Z', local: '2026-10-16 12:58+09:00' }, terminal: '1', quality: ['Basic', 'Live'] },
  aircraft: { reg: 'B-16701', model: 'Boeing 777-300ER' }, airline: { name: 'EVA Air', iata: 'BR' },
  ...over,
});

test('X1: a flight status comes out as times, terminal, gate, status and minutes late', () => {
  const [l] = fsl.normalizeStatus([flight()]);
  assert.equal(l.status, 'Departed');
  assert.equal(l.statusZh, '已起飛');
  assert.deepEqual(l.from.scheduled, { date: '2026-10-16', time: '08:30' });
  assert.deepEqual(l.from.latest, { date: '2026-10-16', time: '08:52' });
  assert.equal(l.from.delayMin, 22);
  assert.equal(l.from.actual, true, 'left: the revised departure is the actual one');
  assert.equal(l.to.actual, false, 'not landed yet: the arrival is an estimate');
  assert.equal(l.to.delayMin, 13);
  assert.equal(l.from.gate, 'C5');
  assert.equal(l.from.terminal, '2');
  assert.equal(l.from.checkIn, '10-12');
  assert.equal(l.from.live, true);
  assert.equal(l.aircraft, 'Boeing 777-300ER');
  // Unknown status words and missing parts do not break it.
  const [odd] = fsl.normalizeStatus([{ number: 'XX1', status: 'Teleported', departure: { airport: { iata: 'TPE' }, quality: ['Basic'] } }]);
  assert.equal(odd.status, 'Unknown');
  assert.equal(odd.from.scheduled, null);
  assert.equal(odd.to.delayMin, null);
  assert.deepEqual(fsl.normalizeStatus(null), []);
});

test('X1: of several legs a day, the one leaving the plan\'s airport on that day', () => {
  const legs = fsl.normalizeStatus([
    flight({ departure: { ...flight().departure, scheduledTime: { utc: '2026-10-15 15:00Z', local: '2026-10-15 23:00+08:00' } } }), // yesterday's, landing today
    flight({ departure: { ...flight().departure, airport: { iata: 'NRT' } } }),
    flight(),
  ]);
  const picked = fsl.pickLegs(legs, { date: '2026-10-16', from: 'TPE' });
  assert.equal(picked.length, 1);
  assert.equal(picked[0].from.iata, 'TPE');
  assert.equal(picked[0].from.scheduled.date, '2026-10-16');
  assert.equal(fsl.pickLegs(legs, { date: '2026-10-16', from: 'KHH' }).length, 2, 'no match on the airport: that day\'s legs');
  assert.equal(fsl.pickLegs(legs, { date: '2026-10-20' }).length, 3, 'none that day: all of them');
});

test('X1: delay statistics: time spans, the share within 15 minutes, the whole-flight figures', () => {
  assert.equal(fsl.spanMin('00:12:00'), 12);
  assert.equal(fsl.spanMin('-00:05:30'), -6);
  assert.equal(fsl.spanMin('01:10:00'), 70);
  assert.equal(fsl.spanMin('1.02:03:00'), 1563);
  assert.equal(fsl.spanMin('soon'), null);
  const pct = [5, 50, 80, 95].map((p) => ({ p, min: { 5: -10, 50: 4, 80: 20, 95: 55 }[p] }));
  const brackets = [{ delayedTo: '00:00:00', num: 40 }, { delayedFrom: '00:00:00', delayedTo: '00:15:00', num: 35 }, { delayedFrom: '00:15:00', delayedTo: '01:00:00', num: 20 }, { delayedFrom: '01:00:00', num: 5 }];
  assert.deepEqual(fsl.onTimeShare(brackets, pct), { pct: 75, approx: false }, 'from the brackets when one ends at 15 minutes');
  assert.deepEqual(fsl.onTimeShare([{ delayedTo: '00:10:00', num: 3 }, { delayedFrom: '00:10:00', num: 1 }], pct), { pct: 50, approx: true }, 'else the highest percentile within 15 minutes');
  assert.deepEqual(fsl.onTimeShare([], [{ p: 5, min: 30 }]), { pct: 5, approx: true, under: true });
  assert.equal(fsl.onTimeShare([], []), null);
  const side = (cls, n, median) => ({ airportIcao: 'RJAA', class: cls, medianDelay: median, numConsideredFlights: n, delayPercentiles: [{ percentile: 80, delay: '00:21:00' }], numFlightsDelayedBrackets: brackets, fromUtc: '2026-07-18T00:00:00Z', toUtc: '2026-10-15T00:00:00Z' });
  const d = fsl.normalizeDelays({ number: 'BR 32', origins: [], destinations: [side('FlightAndHour', 200, '00:30:00'), side('Flight', 80, '00:07:00'), side('Flight', 40, '00:01:00')] }, 'BR32');
  assert.equal(d.found, true);
  assert.equal(d.dep, null);
  assert.equal(d.arr.flights, 80, 'class Flight with the most flights, not one scheduled hour');
  assert.equal(d.arr.median, 7);
  assert.equal(d.arr.p80, 21);
  assert.deepEqual(d.arr.onTime, { pct: 75, approx: false });
  assert.equal(d.arr.from, '2026-07-18');
  assert.equal(fsl.normalizeDelays(null, 'BR32').found, false);
});

test('X1: flight numbers and the date window', () => {
  assert.equal(fsl.normFlight('BR 0032'), 'BR32');
  assert.equal(fsl.normFlight('br32'), 'BR32');
  assert.equal(fsl.normFlight('3K123'), '3K123');
  assert.equal(fsl.normFlight('1234'), null);
  assert.equal(fsl.dateProblem('2026-10-23', '2026-10-16'), '', 'a week ahead is fine');
  assert.match(fsl.dateProblem('2026-10-24', '2026-10-16'), /出發前 7 天內.*還有 8 天/);
  assert.equal(fsl.dateProblem('2025-10-16', '2026-10-16'), '');
  assert.match(fsl.dateProblem('2025-10-15', '2026-10-16'), /超過一年/);
  assert.match(fsl.dateProblem('2026-02-30', '2026-10-16'), /格式/);
});

function fakeAdb(responses) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url: String(url), headers: opts.headers });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return { status: r.status || 200, ok: (r.status || 200) < 300, headers: new Map(Object.entries(r.headers || {})), json: async () => r.body };
  };
  return { calls, fetchImpl };
}
test('X1: one click is one call on the documented paths; the answer is kept; units are spent and given back', async () => {
  const spent = [];
  const refunded = [];
  const kv = memoryKv();
  const { calls, fetchImpl } = fakeAdb([{ body: [flight()], headers: { 'x-ratelimit-api-units-remaining': '321' } }, { body: { number: 'BR 32', origins: [], destinations: [] } }, { status: 503 }, new Error('offline')]);
  let quota = null;
  const fs = fsl.createFlightStatus({ apiKey: 'k', fetchImpl, kv, spend: async (n) => { spent.push(n); return true; }, refund: async (n) => { refunded.push(n); }, onQuota: (q) => { quota = q; } });
  const r = await fs.status('BR 32', '2026-10-16', { from: 'TPE', today: '2026-10-16' });
  assert.equal(calls[0].url, 'https://aerodatabox.p.rapidapi.com/flights/number/BR32/2026-10-16?withAircraftImage=false&withLocation=true');
  assert.equal(calls[0].headers['x-rapidapi-key'], 'k');
  assert.equal(calls[0].headers['x-rapidapi-host'], 'aerodatabox.p.rapidapi.com');
  assert.deepEqual(spent, [2]);
  assert.equal(r.found, true);
  assert.equal(r.spent, 2);
  assert.equal(quota.left, 321);
  const again = await fs.status('br32', '2026-10-16', { from: 'TPE', today: '2026-10-16' });
  assert.equal(calls.length, 1, 'within 10 minutes: no second call');
  assert.equal(again.spent, 0);
  assert.ok(await kv.get('fstatus:v4:BR32:2026-10-16'), 'shared with other instances');
  const d = await fs.delays('BR32');
  assert.equal(calls[1].url, 'https://aerodatabox.p.rapidapi.com/flights/BR32/delays');
  assert.deepEqual(spent, [2, 6]);
  assert.equal(d.found, false);
  await assert.rejects(fs.status('BR12', '2026-10-16', { today: '2026-10-16' }), /回應錯誤 \(503\)/);
  await assert.rejects(fs.status('BR16', '2026-10-16', { today: '2026-10-16' }), /連線失敗/);
  assert.deepEqual(refunded, [2, 2], 'a server error or no connection gives the units back');
  // Refused before any call: a day too far ahead, a bad number, the month's units nearly gone.
  await assert.rejects(fs.status('BR32', '2026-11-30', { today: '2026-10-16' }), /出發前 7 天內/);
  await assert.rejects(fs.status('B', '2026-10-16', { today: '2026-10-16' }), /航班號碼格式不對/);
  const broke = fsl.createFlightStatus({ fetchImpl: async () => assert.fail('no call'), spend: async () => false });
  await assert.rejects(broke.status('BR32', '2026-10-16', { today: '2026-10-16' }), /額度快用完/);
});

test('X1: no flight that day (204) is an answer, and a used-up month stops further calls', async () => {
  const { calls, fetchImpl } = fakeAdb([{ status: 204 }, { status: 429, body: { message: 'You have exceeded the MONTHLY quota for API units' } }]);
  const fs = fsl.createFlightStatus({ fetchImpl });
  const r = await fs.status('BR32', '2026-10-16', { today: '2026-10-16' });
  assert.deepEqual([r.found, r.legs], [false, []]);
  await assert.rejects(fs.delays('BR32'), /免費額度用完/);
  await assert.rejects(fs.delays('CI100'), /免費額度用完/);
  assert.equal(calls.length, 2, 'blocked for a day after the monthly quota message');
});

test('X1: the page reads flight numbers from a leg, words delays, and says when a day is too far', () => {
  assert.deepEqual(page.fstFlights('BR 32 / BR 12'), ['BR32', 'BR12']);
  assert.deepEqual(page.fstFlights('CX451, CX888'), ['CX451', 'CX888']);
  assert.deepEqual(page.fstFlights('JX0800'), ['JX800']);
  assert.deepEqual(page.fstFlights(''), []);
  assert.deepEqual(page.fstFlights('123'), []);
  assert.equal(page.fstDelayText(0), '準時');
  assert.equal(page.fstDelayText(12), '晚 12 分');
  assert.equal(page.fstDelayText(-5), '早 5 分');
  assert.equal(page.fstDelayText(70), '晚 1 小時 10 分');
  assert.equal(page.fstDateNote('2026-10-20', '2026-10-16'), '');
  assert.match(page.fstDateNote('2026-12-01', '2026-10-16'), /還有 46 天/);
  assert.equal(page.fstPunctText('抵達', { onTime: { pct: 77, approx: true }, median: 12, p80: 26 }), '抵達：約 77% 在表定 15 分鐘內到；一半的班次晚 12 分以內；最晚的 1/5 晚 26 分以上');
  assert.equal(page.fstPunctText('出發', { onTime: { pct: 90, approx: false }, median: -3, p80: 9 }), '出發：90% 在表定 15 分鐘內出發；一半的班次提早 3 分以上');
  assert.equal(page.fstTone({ status: 'Canceled', from: {}, to: {} }), 'bad');
  assert.equal(page.fstTone({ status: 'Departed', from: { delayMin: 22 }, to: {} }), 'late');
  assert.equal(page.fstTone({ status: 'Arrived', from: { delayMin: 3 }, to: { delayMin: -4 } }), 'ok');
  assert.deepEqual(page.FST_UNITS, fsl.UNITS, 'the page states the server\'s unit costs');
  assert.equal(page.FST_AHEAD, fsl.AHEAD_DAYS);
});

test('X1: the endpoints answer the demo with made-up data and refuse a far day; the passcode guards them', async () => {
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const r = await (await fetch(`${base}/api/flight-status?flight=BR32&date=${today}&from=TPE&to=NRT`)).json();
  assert.equal(r.mock, true);
  assert.equal(r.found, true);
  assert.equal(r.legs[0].from.iata, 'TPE');
  assert.equal(r.legs[0].to.iata, 'NRT');
  const d = await (await fetch(`${base}/api/flight-delays?flight=BR32`)).json();
  assert.ok(d.arr.onTime.pct > 0);
  const far = await fetch(`${base}/api/flight-status?flight=BR32&date=2099-01-01`);
  assert.equal(far.status, 400);
  assert.match((await far.json()).error, /出發前 7 天內/);
  process.env.CASH_PASSCODE = 'pw';
  try {
    const locked = await fetch(`${base}/api/flight-status?flight=BR32&date=${today}`);
    assert.equal(locked.status, 401);
    assert.equal((await locked.json()).code, 'passcode');
    assert.equal((await fetch(`${base}/api/flight-delays?flight=BR32`, { headers: { 'x-cash-pass': 'pw' } })).status, 200);
  } finally { delete process.env.CASH_PASSCODE; }
});

// ---------- X2: 買或等 ----------
const days = (n, f) => Array.from({ length: n }, (_, i) => [1_790_000_000 + i * 86400, f(i)]);
test('X2: the advice follows Google\'s level and points at 追蹤降價 when the site has it', () => {
  assert.equal(cv.cvVerdict('low').text, '現在買划算。');
  assert.equal(cv.cvVerdict('low').lead, '比平常便宜');
  assert.match(cv.cvVerdict('typical', { watch: true }).text, /選好航班後按「📉 追蹤降價」，降價時通知你/);
  assert.match(cv.cvVerdict('high', { watch: true }).text, /^建議先別急著買，選好航班後按「📉 追蹤降價」/);
  assert.doesNotMatch(cv.cvVerdict('high', { watch: false }).text, /追蹤降價/, 'no price watch on this site: not mentioned');
  assert.equal(cv.cvVerdict(undefined), null);
  const html = cv.cashVerdictHtml({ level: 'high', history: [] }, { watch: true });
  assert.match(html, /比平常貴/);
  assert.match(html, /依 Google 航班的「價格水準」判斷，不是價格預測/);
  assert.equal(cv.cashVerdictHtml({ level: null }), '');
});

test('X2: a clear two-week move is told; noise, flat or short histories are not', () => {
  const up = cv.cvTrend(days(30, (i) => (i < 16 ? 10000 : 10000 + (i - 16) * 80)));
  assert.equal(up.dir, 'up');
  assert.ok(up.pct >= 8 && up.pct <= 12, `+${up.pct}%`);
  assert.equal(cv.cvTrendText(up), `過去兩週在漲（約 +${up.pct}%）`);
  const down = cv.cvTrend(days(20, (i) => 12000 - i * 60));
  assert.equal(down.dir, 'down');
  assert.match(cv.cvTrendText(down), /^過去兩週在跌（約 −\d+%）$/);
  assert.equal(cv.cvTrend(days(30, () => 9000)), null, 'flat');
  assert.equal(cv.cvTrend(days(30, (i) => 9000 + (i % 2 ? 900 : -900))), null, 'up and down');
  assert.equal(cv.cvTrend(days(30, (i) => 10000 + i * 10)), null, 'under 5%');
  assert.equal(cv.cvTrend(days(4, (i) => 10000 + i * 1000)), null, 'too few points');
  assert.equal(cv.cvTrend(days(30, (i) => 10000 + i * 100).map(([t, p]) => [t * 1000, p])).dir, 'up', 'milliseconds work too');
  assert.match(cv.cashVerdictHtml({ level: 'typical', history: days(20, (i) => 12000 - i * 60) }), /過去兩週在跌/);
});

// ---------- X3: 哪裡都好 ----------
const avail = (dest, date, miles, { source = 'aeroplan', origin = 'TPE', cabin = 'J', direct = true } = {}) => ({ id: `${origin}${dest}${date}${source}`, date, origin, destination: dest, source, updatedAt: '2026-10-16T00:00:00Z', cabins: { [cabin]: { available: true, miles, seats: 2, airlines: 'BR', direct, taxes: { amount: 3000, currency: 'TWD', symbol: 'NT$' } } } });

test('X3: the regions are 今日好康\'s, and a press never asks for more than 10 calls', () => {
  assert.deepEqual(REGIONS.map((r) => r.id), GROUPS.map((g) => g.id));
  assert.deepEqual(REGIONS[0].destinations, GROUPS[0].destinations.split(','));
  assert.equal(MAX_CALLS, 10);
  for (let n = 1; n <= 5; n++) assert.ok(n * pagesPer(n) <= 10 && pagesPer(n) <= 2, `${n} regions`);
  assert.equal(pagesPer(5), 2);
  assert.throws(() => pickRegions('na,mars'), /沒有這個區域：mars/);
  assert.throws(() => pickRegions(''), /至少選一個/);
  assert.deepEqual(pickRegions('jk,na,jk').map((g) => g.id), ['jk', 'na']);
});

test('X3: one search per region over its destinations; the cheapest seat per destination, cheapest first', async () => {
  const asked = [];
  const rows = {
    na: [avail('SFO', '2026-11-03', 70000), avail('SFO', '2026-11-01', 70000, { source: 'united' }), avail('LAX', '2026-11-05', 55000), avail('SFO', '2026-11-02', 90000), avail('SEA', '2026-10-30', 30000)],
    jk: [avail('NRT', '2026-11-04', 25000, { origin: 'KHH' }), avail('HND', '2026-11-04', 30000), avail('NRT', '2026-11-04', 28000, { cabin: 'F' })],
  };
  const any = createAnywhere({
    search: async (p, { maxPages }) => {
      asked.push({ p, maxPages });
      const g = GROUPS.find((x) => x.destinations === p.destination_airport);
      if (g.id === 'eu') throw new Error('seats.aero 回應錯誤 (502)');
      return { rows: rows[g.id] || [], hasMore: g.id === 'na', calls: maxPages };
    },
  });
  const r = await any.run({ origins: ['TPE', 'KHH'], start: '2026-11-01', end: '2026-11-20', cabin: 'J', regions: 'na,jk,eu' });
  assert.equal(asked.length, 3);
  assert.deepEqual(asked.map((a) => a.p.destination_airport), ['na', 'jk', 'eu'].map((id) => GROUPS.find((g) => g.id === id).destinations));
  assert.ok(asked.every((a) => a.p.origin_airport === 'TPE,KHH' && a.p.cabins === 'business' && a.p.order_by === 'lowest_mileage' && a.p.include_trips && a.maxPages === 2));
  assert.equal(r.maxCalls, 6);
  assert.equal(r.calls, 4, 'the failed region made none');
  const [na, jk, eu] = r.regions;
  assert.deepEqual(na.items.map((x) => [x.destination, x.miles, x.date, x.source]), [['LAX', 55000, '2026-11-05', 'aeroplan'], ['SFO', 70000, '2026-11-01', 'united']], 'before the start date left out; a tie goes to the earlier day');
  assert.equal(na.truncated, true);
  assert.deepEqual(jk.items.map((x) => [x.destination, x.miles, x.origin]), [['NRT', 25000, 'KHH'], ['HND', 30000, 'TPE']], 'from either airport; another cabin ignored');
  assert.deepEqual(jk.items[0].taxes, { amount: 3000, currency: 'TWD', symbol: 'NT$' });
  assert.match(eu.error, /502/);
  assert.deepEqual(eu.items, []);
  // A long range asks without trip details (taxes), as the route search does.
  await any.run({ start: '2026-11-01', end: '2027-03-01', cabin: 'F', regions: ['oc'] });
  assert.equal(asked.at(-1).p.include_trips, undefined);
  assert.equal(asked.at(-1).p.origin_airport, 'TPE');
  assert.equal(asked.at(-1).p.cabins, 'first');
  assert.equal(bestByDestination([avail('SYD', '2026-11-01', 1000)], 'J', '2026-11-02').length, 0);
});

test('X3: with seats.aero always saying there is more, all five regions together stop at 10 calls', async () => {
  let n = 0;
  const client = createClient({ apiKey: 'k', fetchImpl: async () => { n++; return { ok: true, status: 200, json: async () => ({ data: [], hasMore: true, cursor: 1 }) }; } });
  const any = createAnywhere({ search: async (p, { maxPages }) => { const r = await client.search(p, { maxPages }); return { rows: r.items, hasMore: r.hasMore, calls: maxPages }; } });
  const r = await any.run({ start: '2026-11-01', end: '2026-11-20', regions: GROUPS.map((g) => g.id) });
  assert.equal(n, 10);
  assert.equal(r.calls, 10);
  assert.ok(r.regions.every((g) => g.truncated));
});

test('X3: the page\'s button and airports', () => {
  assert.equal(awp.awButtonText(3), '開始查（用約 3 次查詢）');
  assert.match(awp.awButtonText(3).match(/（用[^）]*）/)[0], /^（用約? \S+ 次(查詢|查價)）$/, 'the quota wording rule (r6ui U7)');
  assert.equal(awp.awButtonText(0), '開始查（先選區域）');
  assert.deepEqual(awp.awOrigins(' tpe, khh '), ['TPE', 'KHH']);
  assert.deepEqual(awp.awOrigins('TPE TPE'), ['TPE']);
  assert.equal(awp.awOrigins('TPE,KHH,TSA,RMQ'), null);
  assert.equal(awp.awOrigins('Taipei'), null);
  assert.equal(awp.awOrigins(''), null);
});

test('X3: the endpoint is the owner\'s, from the page; the region list is not', async () => {
  const q = 'regions=na,jk&start=2099-01-01&end=2099-01-10';
  assert.equal((await fetch(`${base}/api/anywhere?${q}`)).status, 400, 'not from the page');
  const regions = await (await fetch(`${base}/api/anywhere/regions`)).json();
  assert.deepEqual(regions.regions.map((r) => r.name), ['北美', '歐洲', '日韓', '東南亞', '澳紐']);
  const start = new Date(Date.now() + 8 * 3600e3 + 20 * 864e5).toISOString().slice(0, 10);
  const end = new Date(Date.now() + 8 * 3600e3 + 30 * 864e5).toISOString().slice(0, 10);
  const r = await (await fetch(`${base}/api/anywhere?regions=jk,oc&start=${start}&end=${end}&cabin=J`, { headers: { 'x-requested-with': 'fetch' } })).json();
  assert.equal(r.mock, true);
  assert.deepEqual(r.regions.map((g) => g.id), ['jk', 'oc']);
  assert.ok(r.regions[0].items.length > 0);
  for (const g of r.regions) for (let i = 1; i < g.items.length; i++) assert.ok(g.items[i - 1].miles <= g.items[i].miles, 'cheapest first');
  const bad = await fetch(`${base}/api/anywhere?regions=na,xx&start=${start}&end=${end}`, { headers: { 'x-requested-with': 'fetch' } });
  assert.equal(bad.status, 400);
  process.env.CASH_PASSCODE = 'pw';
  try {
    const locked = await fetch(`${base}/api/anywhere?regions=jk&start=${start}&end=${end}`, { headers: { 'x-requested-with': 'fetch' } });
    assert.equal(locked.status, 401);
    assert.equal((await fetch(`${base}/api/anywhere?regions=jk&start=${start}&end=${end}`, { headers: { 'x-requested-with': 'fetch', 'x-cash-pass': 'pw' } })).status, 200);
  } finally { delete process.env.CASH_PASSCODE; }
});

test('styles.css closes every block it opens (a merge that drops a brace hides all later rules on wide screens)', () => {
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  let depth = 0;
  for (const ch of css) {
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; assert.ok(depth >= 0, 'a } with no {'); }
  }
  assert.equal(depth, 0);
  assert.match(css, /\.fst-box \{/);
  assert.match(css, /\.cash-verdict \{/);
  assert.match(css, /\.aw-regions \{/);
});

test('哪裡都好: only the ticked programs, asked of seats.aero itself, with the same calls as all programs', async () => {
  const asked = [];
  const any = createAnywhere({
    search: async (p, { maxPages }) => {
      asked.push(p);
      return { rows: [avail('LAX', '2026-11-05', 55000), avail('SFO', '2026-11-03', 80000, { source: 'united' }), avail('SEA', '2026-11-04', 60000, { source: 'alaska' })], calls: maxPages };
    },
  });
  const r = await any.run({ start: '2026-11-01', end: '2026-11-20', regions: ['na'], programs: ['united', 'alaska'] });
  assert.equal(asked[0].sources, 'united,alaska');
  assert.deepEqual(r.programs, ['united', 'alaska']);
  assert.deepEqual(r.regions[0].items.map((x) => [x.destination, x.source]), [['SEA', 'alaska'], ['SFO', 'united']], 'a program not ticked is left out even if seats.aero sends it');
  assert.equal(r.maxCalls, 2);
  const all = await any.run({ start: '2026-11-01', end: '2026-11-20', regions: ['na'] });
  assert.equal(asked[1].sources, undefined);
  assert.equal(all.programs, null);
  assert.equal(all.regions[0].items.length, 3);
});

test('哪裡都好: the programs list puts your own miles first, then card-point transfers, then the rest', () => {
  const names = { united: '聯合 MileagePlus', aeroplan: '加航 Aeroplan', asiamiles: '亞洲萬里通', asiamiles_est: '亞洲萬里通（估算）', alaska: '阿拉斯加 Atmos' };
  const r = { asiamiles: { own: 120000, total: 150000 }, alaska: { own: 30000, total: 30000 }, united: { own: 0, total: 40000 } };
  const list = awp.awProgramList(names, (id) => r[id] || { own: 0, total: 0 });
  assert.deepEqual(list.map((p) => [p.id, p.own, p.total]), [['asiamiles', 120000, 150000], ['alaska', 30000, 30000], ['united', 0, 40000], ['aeroplan', 0, 0]], 'the site\'s own estimate is not a seats.aero program');
  assert.deepEqual(awp.awProgramList({ connectmiles: 'Copa ConnectMiles', copa: 'Copa ConnectMiles' }, () => ({})).map((p) => p.id), ['connectmiles,copa'], 'one row for one name');
});
