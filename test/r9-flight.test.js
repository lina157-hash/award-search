// Round 9 官方航班資料 (lib/flightdata.js): the parsers of the official files (TDX, 桃園機場 7869, 民航局 9973 and 47492),
// the merged timetable, terminals, 即將開航, the store and the weekly refresh; the airport time zones; the .ics at the
// real flight times (public/trips.js); and the endpoints in the demo.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
delete process.env.SEATS_AERO_API_KEY;
delete process.env.CASH_PASSCODE;
delete process.env.CRON_SECRET;
delete process.env.TDX_CLIENT_ID;
delete process.env.TDX_CLIENT_SECRET;
const F = require('../lib/flightdata');
const M = require('../lib/flightdata-mock');
const T = require('../public/trips.js');
const { memoryKv } = require('../lib/kv');
const { addDays } = require('../lib/day');

const AIR = require('../public/airports.min.json');
const TZ = new Map(AIR.airports.map((r) => [r[0], AIR.tzs[r[10]]]));
const tzOf = (c) => TZ.get(c) || '';
const enc = (s) => new TextEncoder().encode(s);

test('airports.min.json: an IANA zone per airport through a small shared list', () => {
  assert.equal(AIR.fields.at(-1), 'tz');
  assert.ok(Array.isArray(AIR.tzs) && AIR.tzs.length > 100 && AIR.tzs.length < 600);
  assert.equal(tzOf('TPE'), 'Asia/Taipei');
  assert.equal(tzOf('MUC'), 'Europe/Berlin');
  assert.equal(tzOf('YVR'), 'America/Vancouver');
  assert.equal(tzOf('SYD'), 'Australia/Sydney');
  const missing = AIR.airports.filter((r) => !AIR.tzs[r[10]]);
  assert.ok(missing.length <= 5, `airports without a zone: ${missing.map((r) => r[0]).join(',')}`);
  for (const tz of AIR.tzs) assert.doesNotThrow(() => new Intl.DateTimeFormat('en', { timeZone: tz }), tz);
  assert.ok(require('node:fs').statSync(require.resolve('../public/airports.min.json')).size < 300_000);
});

test('small parsers: dates (ROC too), times with +1, flight numbers, weekdays, file encodings', () => {
  assert.equal(F.parseDate('2026/03/28'), '2026-03-28');
  assert.equal(F.parseDate('115/03/28'), '2026-03-28');
  assert.equal(F.parseDate('20260328'), '2026-03-28');
  assert.equal(F.parseDate('2026/02/30'), '');
  assert.deepEqual(F.parseTime('6:35+1'), { t: '06:35', plus: 1 });
  assert.deepEqual(F.parseTime('2350'), { t: '23:50', plus: 0 });
  assert.equal(F.parseTime('25:00'), null);
  assert.equal(F.normFlight('BR', 'BR016'), 'BR16');
  assert.equal(F.normFlight('CI', '0005'), 'CI5');
  assert.equal(F.normFlight('', '123'), '');
  assert.equal(F.parseDays('1030507'), 0b1010101);
  assert.equal(F.parseDays('每日'), 127);
  assert.equal(F.rotate(0b0000001, -1), 0b1000000); // Monday back one day = Sunday
  assert.equal(F.decodeText(enc('﻿航班,起飛')), '航班,起飛');
  assert.throws(() => F.decodeText(new Uint8Array([0x50, 0x4b, 3, 4])), /ZIP/);
  assert.deepEqual(F.parseCsv('a,"b,c",d\r\n\r\n"x ""y""",2,\n'), [['a', 'b,c', 'd'], ['x "y"', '2', '']]);
  // TPE 23:50 → YVR 19:40 the same calendar day (−15 h), and YVR 01:50 → TPE 05:35 two days on.
  assert.equal(F.arrivalDays('TPE', 'YVR', '23:50', '19:40', '2026-11-10', tzOf), 0);
  assert.equal(F.arrivalDays('YVR', 'TPE', '01:50', '05:35', '2026-11-10', tzOf), 1);
  assert.equal(F.arrivalDays('XXX', 'TPE', '01:50', '05:35', '2026-11-10', tzOf), null);
});

test('TDX: flight numbers, next-day arrivals, weekdays, terminal and codeshares; bad rows dropped', () => {
  const x = { AirlineID: 'BR', FlightNumber: 'BR016', DepartureAirportID: 'TPE', ArrivalAirportID: 'LAX', DepartureTime: '23:40', ArrivalTime: '19:30', ScheduleStartDate: '2026-10-25', ScheduleEndDate: '2027-03-27', Monday: true, Tuesday: false, Wednesday: true, Thursday: false, Friday: true, Saturday: false, Sunday: false, Terminal: '2', CodeShare: [{ AirlineID: 'NH', FlightNumber: '5812' }] };
  const { rows, total } = F.parseTdx([x, { ...x, FlightNumber: 'BR012', ArrivalTime: '06:10+1' }, { ...x, ArrivalAirportID: 'TPE' }, { ...x, DepartureAirportID: 'NRT', ArrivalAirportID: 'LAX' }]);
  assert.equal(total, 4);
  assert.equal(rows.length, 2); // TPE→TPE and a pair outside Taiwan are dropped
  assert.deepEqual({ ...rows[0] }, { fn: 'BR16', o: 'TPE', d: 'LAX', dep: '23:40', arr: '19:30', ad: 0, days: 0b0010101, from: '2026-10-25', to: '2027-03-27', ac: '', t: '2', cs: ['NH5812'] });
  assert.equal(rows[1].ad, 1);
});

test('桃園機場 7869 by position: passenger rows only, arrivals moved to the departure day', () => {
  const head = Array.from({ length: 22 }, (_, i) => i + 1).join(',');
  const row = (kind, al, no, dep, other, arr, term, days, from, to) => [kind, al, no, dep, other, arr, ...Array(12).fill(''), term, days, from, to].join(',');
  const csv = [head,
    row('PD', 'BR', '0016', '23:40', 'LAX', '19:30', '2', '1030507', '2026/10/25', '2027/03/27'),
    // YVR 01:50 (Monday) → TPE 05:35 on Tuesday: 7869 lists TPE's day and dates.
    row('PA', 'BR', '0009', '01:50', 'YVR', '05:35', '2', '0200000', '2026/10/27', '2027/03/23'),
    row('PA', 'CI', '0101', '09:00', 'NRT', '11:45', '1', '1234567', '2026/10/25', '2027/03/27'),
    row('CD', 'CI', '5001', '02:00', 'ANC', '10:00', '1', '1000000', '2026/01/01', '2027/12/31'),
  ].join('\r\n');
  const { rows, total } = F.parseTaoyuan(csv, { tzOf });
  assert.equal(total, 3);
  assert.deepEqual(rows.map((r) => [r.fn, r.o, r.d, r.t, r.ad, r.days, r.from, r.to]), [
    ['BR16', 'TPE', 'LAX', '2', 0, 0b1010101, '2026-10-25', '2027-03-27'],
    ['BR9', 'YVR', 'TPE', '2', 1, 0b0000001, '2026-10-26', '2027-03-22'],
    ['CI101', 'NRT', 'TPE', '1', 0, 127, '2026-10-25', '2027-03-27'],
  ]);
});

test('民航局 9973: columns found by name in Chinese or English, ROC dates, weekday columns; an unknown layout throws', () => {
  const zh = ['航空公司代碼,班次,共用班號,起飛機場,起飛時間,抵達機場,抵達時間,開始日期,結束日期,星期,機型',
    'BR,BR016,"NH5812,UA7700",TPE,23:40,LAX,19:30,115/10/25,116/03/27,135,77W',
    'CI,CI0005,,TPE,23:55,LAX,19:45,2026/10/25,2027/03/27,1234567,359'].join('\n');
  const a = F.parseCaaSchedule(zh, { tzOf });
  assert.deepEqual(a.rows.map((r) => [r.fn, r.o, r.d, r.days, r.from, r.to, r.ac, r.cs.join(' ')]), [
    ['BR16', 'TPE', 'LAX', 0b0010101, '2026-10-25', '2027-03-27', '77W', 'NH5812 UA7700'],
    ['CI5', 'TPE', 'LAX', 127, '2026-10-25', '2027-03-27', '359', ''],
  ]);
  const en = ['Airline,Flight No,Departure Airport,Departure Time,Arrival Airport,Arrival Time,Start Date,End Date,Mon,Tue,Wed,Thu,Fri,Sat,Sun',
    'JX,JX002,TPE,23:40,LAX,19:15,2026/10/25,2027/03/27,V,,V,,V,,V'].join('\n');
  const b = F.parseCaaSchedule(en, { tzOf });
  assert.deepEqual(b.rows.map((r) => [r.fn, r.days, r.ad]), [['JX2', 0b1010101, 0]]);
  assert.throws(() => F.parseCaaSchedule('甲,乙,丙\n1,2,3'), /找不到欄位/);
});

test('民航局 47492 load factor: per route, airline and month, the latest year; the Taiwan end from the title above', () => {
  const names = [['東京成田', 'NRT'], ['成田', 'NRT'], ['東京', 'TYO'], ['香港', 'HKG']];
  const al = { BR: '長榮航空', CI: '中華航空' };
  const csv = ['年月,機場,航線,航空公司,入出境,架次,座位數,載客人數,載客率',
    '2024/12,桃園,東京(成田),長榮航空,出境,30,9000,8000,88.9%',
    '2025/01,桃園,東京(成田),長榮航空,出境,30,9000,7200,80%',
    '2025/01,桃園,東京(成田),長榮航空,入境,30,9000,6300,70%',
    '2025/02,桃園,香港,中華航空,出境,30,9000,4500,50%',
    '2025/02,不明,香港,某某航空,出境,30,9000,4500,50%',
    '合計,,,,,,,,'].join('\n');
  const r = F.parseLoadFactor(csv, { airportNames: names, airlineZh: al });
  assert.equal(r.year, 2025);
  assert.equal(r.monthly, true);
  assert.equal(r.routes['TPE-NRT'].BR[0], 75); // (7200 + 6300) / 18000
  assert.equal(r.routes['TPE-NRT'].BR[11], null); // 2024 is dropped
  assert.equal(r.routes['TPE-HKG'].CI[1], 50);
  assert.equal(r.unknown.length, 1);
  // A whole-year table under a title naming the airport, with the rate only.
  const titled = ['表 3 臺灣桃園國際機場 2025 年', '航線,航空公司,載客率', '香港,中華航空,81.5%', '東京成田,長榮航空,0.77'].join('\n');
  const t = F.parseLoadFactor(titled, { airportNames: names, airlineZh: al });
  assert.deepEqual(t.routes, { 'TPE-HKG': { CI: [82] }, 'TPE-NRT': { BR: [77] } });
  assert.throws(() => F.parseLoadFactor('a,b\n1,2', {}), /找不到欄位/);
});

test('the merged timetable: codeshare copies and ended periods dropped, periods joined; terminals; 即將開航 kinds', () => {
  const r = (o) => ({ fn: 'BR16', o: 'TPE', d: 'LAX', dep: '23:40', arr: '19:30', ad: 0, days: 127, from: '2026-10-25', to: '2026-12-31', ac: '', t: '2', cs: [], ...o });
  const rows = F.mergeRows([
    r({ cs: ['NH5812'] }), r({ from: '2027-01-01', to: '2027-03-27', ac: '77W' }), r({ fn: 'NH5812', t: '' }),
    r({ fn: 'BR12', to: '2026-10-01' }), r({ fn: 'CI5', t: '1' }),
  ], '2026-10-16');
  assert.deepEqual(rows.map((x) => [x.fn, x.from, x.to, x.ac]), [['BR16', '2026-10-25', '2027-03-27', '77W'], ['CI5', '2026-10-25', '2026-12-31', '']]);
  assert.deepEqual(F.addAircraft([{ fn: 'CI5', o: 'TPE', d: 'LAX', ac: '' }], [{ fn: 'CI5', o: 'TPE', d: 'LAX', ac: '359' }, { fn: 'CI5', o: 'TPE', d: 'LAX', ac: '359' }, { fn: 'CI5', o: 'TPE', d: 'LAX', ac: '333' }])[0].ac, '359');

  const term = F.buildTerminals([r({ fn: 'BR16' }), r({ fn: 'BR12' }), r({ fn: 'BR198', t: '1' }), r({ fn: 'CI5', t: '1' }), r({ fn: 'CI7', o: 'KHH', t: '2' })]);
  assert.deepEqual(term, { airlines: { BR: '2', CI: '1' }, flights: { BR198: '1' } });

  const today = '2026-10-16';
  const future = [r({ fn: 'BR90', d: 'MUC', from: '2026-11-20', to: '2027-03-27' }), r({ fn: 'JX1', d: 'PRG', from: '2026-12-01', to: '2027-03-27' }), r({ fn: 'BR2', d: 'CTS', from: '2026-11-01', to: '2027-03-27' }), r({ fn: 'BR1', d: 'NRT', from: '2026-10-01' })];
  const ended = [r({ fn: 'BR2', d: 'CTS', from: '2026-03-29', to: '2026-08-31' })];
  const seenNew = { since: addDays(today, -400), pairs: { 'TPE-MUC': '2026-05-01' } };
  const up = F.upcomingRoutes([...future, ...ended], F.mergeRows(future, today), seenNew, today);
  assert.deepEqual(up.map((x) => [x.d, x.kind, x.first]), [['CTS', 'resume', '2026-11-01'], ['MUC', 'resume', '2026-11-20'], ['PRG', 'new', '2026-12-01']]);
  const young = F.upcomingRoutes(future, F.mergeRows(future, today), { since: today, pairs: {} }, today);
  assert.equal(young.find((x) => x.d === 'PRG').kind, 'soon'); // too little history to call it new
});

const day = (iso) => Date.parse(`${iso}T04:00:00Z`); // noon in Taiwan

test('refresh with the demo files: TDX when keyed, the timetable per route, terminals, load factor, upcoming', async () => {
  const today = '2026-10-16';
  const kv = memoryKv();
  const fd = F.createFlightData({ kv, fetchImpl: M.mockFetch(today), tzOf, mock: true, now: () => day(today), airportNames: [['溫哥華', 'YVR'], ['東京成田', 'NRT'], ['成田', 'NRT'], ['慕尼黑', 'MUC']], airlineZh: { BR: '長榮航空', CI: '中華航空', JX: '星宇航空' } });
  assert.equal(await fd.due(), true);
  const out = await fd.refresh();
  assert.deepEqual(out.changed, ['timetable', 'terminals', 'lf']);
  assert.deepEqual(out.timetable.sources, ['tdx']);
  assert.equal(await fd.due(), false);
  const yvr = await fd.route(['TPE'], ['YVR']);
  assert.equal(yvr.configured, true);
  assert.equal(yvr.covered, true);
  assert.deepEqual(yvr.flights.map((f) => f.al).sort(), ['BR', 'CI']);
  assert.ok(yvr.flights.every((f) => f.ac === '787-10' || f.ac === '781' || f.ac)); // aircraft from the CAA file
  assert.equal(yvr.horizon, M.seasonEnd(today));
  // Codeshare copies are not separate flights.
  const nrt = await fd.route(['TPE'], ['NRT']);
  assert.ok(!nrt.flights.some((f) => /^(NH|JL)/.test(f.fn)));
  assert.deepEqual(nrt.flights.find((f) => f.al === 'BR').cs, ['NH5800']);
  assert.deepEqual(await fd.nonstopCarriers('TPE', 'MUC'), ['BR']);
  assert.deepEqual(await fd.nonstopCarriers('TPE', 'GRU'), []); // covered: Taiwan has no nonstop there
  assert.equal(await fd.nonstopCarriers('NRT', 'JFK'), null); // not Taiwan's to say
  const term = await fd.terminals();
  assert.equal(term.airlines.BR, '2');
  assert.equal(term.airlines.CI, '1');
  const up = await fd.upcoming();
  assert.deepEqual(up.routes.map((r) => [r.d, r.kind]), [['CTS', 'resume'], ['PRG', 'soon']]);
  const lf = await fd.loadFactor(['TPE'], ['NRT']);
  assert.equal(lf.year, 2025);
  assert.equal(lf.routes['TPE-NRT'].BR.length, 12);
  assert.deepEqual(await fd.flags(), { timetable: true, terminals: true, lf: true, upcoming: 2, mock: true });
});

test('refresh without a TDX key: 桃園機場 for TPE and 民航局 for the rest; a broken file is refused, the rest kept', async () => {
  const today = '2026-10-16';
  const base = M.mockFetch(today);
  let tdxCalls = 0;
  const fetchImpl = async (url, init) => {
    if (String(url).startsWith('https://tdx.')) tdxCalls++;
    if (url === F.URLS.caaLoad) return { ok: true, status: 200, arrayBuffer: async () => enc('沒有,欄位\n1,2').buffer };
    return base(url, init);
  };
  const kv = memoryKv();
  const fd = F.createFlightData({ kv, fetchImpl, env: {}, tzOf, now: () => day(today) });
  assert.equal(fd.tdxOn, false);
  const out = await fd.refresh();
  assert.equal(tdxCalls, 0);
  assert.deepEqual(out.timetable.sources, ['ty', 'caa']);
  assert.deepEqual(out.changed, ['timetable', 'terminals']);
  assert.equal(out.sources.lf.ok, false);
  assert.equal(out.sources.tdx.off, true);
  const khh = await fd.route(['KHH'], ['NRT']);
  assert.ok(khh.flights.length >= 2, 'KHH flights from the CAA file');
  const tpe = await fd.route(['TPE'], ['YVR']);
  assert.ok(tpe.flights.every((f) => f.t), 'TPE flights from 桃園機場, with terminals');
  // TPE arrivals come back to the departure day: BR's YVR→TPE days match the TDX copy of the same flight.
  const back = (await fd.route(['YVR'], ['TPE'])).flights.find((f) => f.al === 'BR');
  const tdxBack = M.flights(today).find((f) => f.o === 'YVR' && f.d === 'TPE' && f.al === 'BR');
  assert.equal(back.days, tdxBack.days);
  assert.equal(back.from, tdxBack.from);

  // A file that mostly fails to parse is not used: the timetable stays as it was.
  const bad = F.createFlightData({ kv, fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => enc('航空公司代碼,班次,起飛機場,抵達機場\nBR,BR1,TPE,NRT\n').buffer }), env: {}, tzOf, now: () => day(today) + 864e5 });
  const out2 = await bad.refresh();
  assert.deepEqual(out2.changed, []);
  assert.equal(out2.sources.caa.ok, false);
  assert.equal((await bad.route(['TPE'], ['YVR'])).flights.length, tpe.flights.length);
});

test('due(): at most once a day, weekly, or on a Monday after a day; the status never shows the key', async () => {
  const kv = memoryKv();
  let t = Date.parse('2026-10-14T04:00:00Z'); // a Wednesday
  const env = { TDX_CLIENT_ID: 'demo-id-123', TDX_CLIENT_SECRET: 'demo-secret-456' };
  const fd = F.createFlightData({ kv, fetchImpl: M.mockFetch('2026-10-14'), env, tzOf, now: () => t });
  assert.equal(fd.tdxOn, true);
  await fd.refresh();
  t += 21 * 3600e3; // Thursday
  // A file that failed (the demo's load factor here) is tried again the next day; once every file reads, weekly.
  assert.ok(Object.values((await kv.get(F.KEY.meta)).sources).some((x) => !x.ok && !x.off));
  assert.equal(await fd.due(), true);
  const meta = await kv.get(F.KEY.meta);
  for (const x of Object.values(meta.sources)) x.ok = true;
  await kv.set(F.KEY.meta, meta);
  await fd.status(); // re-reads the stored meta
  assert.equal(await fd.due(), false);
  t = Date.parse('2026-10-19T04:00:00Z'); // the next Monday
  assert.equal(await fd.due(), true);
  t = Date.parse('2026-10-20T04:00:00Z'); // Tuesday, the data 6 days old
  await kv.set(F.KEY.tried, Date.parse('2026-10-19T04:00:00Z'));
  assert.equal(await fd.due(), false);
  t = Date.parse('2026-10-21T05:00:00Z'); // a week old
  assert.equal(await fd.due(), true);
  const s = JSON.stringify(await fd.status());
  assert.ok(!s.includes('demo-id-123') && !s.includes('demo-secret-456'));
  assert.match(s, /"tdxKey":true/);
  // Without the passcode: what each source did, nothing else.
  const pub = await fd.publicStatus();
  const ps = JSON.stringify(pub);
  assert.ok(!ps.includes('demo-id-123') && !ps.includes('demo-secret-456') && !ps.includes('http'));
  assert.equal(pub.tdxKey, true);
  assert.ok(pub.sources.tdx.ok && pub.sources.lf);
  assert.ok(!('ms' in pub.sources.tdx) && !('url' in pub.sources.tdx));
});

test('the timetable is stored in pieces with a stamp; old pieces go', async () => {
  const kv = memoryKv();
  const big = { x: 'a'.repeat(1_500_000) };
  await F.putBig(kv, 'k', big, 60);
  const head = await kv.get('k');
  assert.equal(head.pieces, 3);
  assert.deepEqual(await F.getBig(kv, 'k'), big);
  await new Promise((r) => setTimeout(r, 5));
  await F.putBig(kv, 'k', { y: 1 }, 60);
  assert.equal(await kv.get(`k:${head.stamp}:0`), null);
  assert.deepEqual(await F.getBig(kv, 'k'), { y: 1 });
});

test('trips.js time zones: offsets, the clock changes, and the .ics at the real flight times', () => {
  assert.equal(T.tzOffsetMin('Asia/Taipei', Date.UTC(2026, 6, 1)), 480);
  assert.equal(T.tzOffsetMin('Europe/Berlin', Date.UTC(2026, 6, 1)), 120);
  assert.equal(T.tzOffsetMin('America/Vancouver', Date.UTC(2026, 11, 1)), -480);
  const ch = T.tzChanges('Europe/Berlin', Date.UTC(2026, 9, 1), 200);
  assert.deepEqual(ch.map((c) => [new Date(c.at).toISOString(), c.from, c.to]), [['2026-10-25T01:00:00.000Z', 120, 60], ['2027-03-28T01:00:00.000Z', 60, 120]]);
  assert.deepEqual(T.tzChanges('Asia/Taipei', Date.UTC(2026, 0, 1), 400), []);
  assert.equal(T.tzInstant('America/Vancouver', '2026-11-01', '01:30'), Date.UTC(2026, 10, 1, 8, 30)); // the first 01:30 (PDT)
  assert.equal(T.tzInstant('Asia/Taipei', '2026-11-02', '23:50'), Date.UTC(2026, 10, 2, 15, 50));

  const ap = (c) => ({ TPE: { country: 'TW', tz: 'Asia/Taipei' }, YVR: { country: 'CA', tz: 'America/Vancouver' }, NRT: { country: 'JP' } }[c] || null);
  const plan = { name: '溫哥華', legs: [
    { k: 'a', date: '2026-11-02', from: 'TPE', to: 'YVR', flights: 'BR 10', dep: '23:50', arr: '19:40', cabin: 'J', pax: 1, miles: 75000, program: 'eva' },
    { k: 'a', date: '2026-11-20', from: 'YVR', to: 'TPE', flights: 'BR 9', dep: '01:50', arr: '05:35', arrDays: 1, cabin: 'J', pax: 1, miles: 75000, program: 'eva' },
    { k: 'a', date: '2026-12-01', from: 'TPE', to: 'NRT', flights: 'BR 198', dep: '08:50', arr: '13:15', cabin: 'Y', pax: 1, miles: 20000, program: 'eva' },
    { k: 'a', date: '2026-12-05', from: 'NRT', to: 'TPE', flights: 'BR 197', cabin: 'Y', pax: 1, miles: 20000, program: 'eva' },
  ] };
  const ics = T.tripIcs(plan, { trips: {}, holds: {}, today: '2026-10-16', ap, keyOf: (x) => x, name: (x) => x, stamp: '20261016T000000Z' }).replace(/\r\n /g, '');
  assert.match(ics, /DTSTART;TZID=Asia\/Taipei:20261102T235000\r\nDTEND;TZID=America\/Vancouver:20261102T194000\r\n/);
  assert.match(ics, /DTSTART;TZID=America\/Vancouver:20261120T015000\r\nDTEND;TZID=Asia\/Taipei:20261121T053500\r\n/);
  assert.match(ics, /TRIGGER:-PT3H/);
  // NRT has no zone here: the leg starts at its real time and has no end; a leg without a time stays all-day.
  assert.match(ics, /DTSTART;TZID=Asia\/Taipei:20261201T085000\r\nSUMMARY:✈ BR 198 TPE→NRT\r\n/);
  assert.match(ics, /DTSTART;VALUE=DATE:20261205\r\nDTEND;VALUE=DATE:20261206\r\nSUMMARY:✈ BR 197 NRT→TPE\r\n/);
  // One VTIMEZONE per zone, before the events; Vancouver's with the 11/1 change back to standard time.
  assert.equal(ics.split('BEGIN:VTIMEZONE').length - 1, 2);
  assert.ok(ics.indexOf('END:VTIMEZONE') < ics.indexOf('BEGIN:VEVENT'));
  assert.match(ics, /TZID:America\/Vancouver\r\nBEGIN:DAYLIGHT\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:-0700\r\nTZOFFSETTO:-0700\r\nEND:DAYLIGHT\r\nBEGIN:STANDARD\r\nDTSTART:20261101T020000\r\nTZOFFSETFROM:-0700\r\nTZOFFSETTO:-0800\r\nEND:STANDARD/);
  assert.match(ics, /TZID:Asia\/Taipei\r\nBEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:\+0800\r\nTZOFFSETTO:\+0800\r\nEND:STANDARD\r\nEND:VTIMEZONE/);
});

// ---------- the endpoints in the demo ----------
const { server } = require('../server');
let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());
const get = async (p, init) => { const res = await fetch(base + p, init); return { status: res.status, json: await res.json().catch(() => ({})), cache: res.headers.get('cache-control') }; };

test('demo endpoints: route, terminals, upcoming, load factor, config flags; refresh is POST only', async () => {
  const cfg = await get('/api/config');
  assert.equal(cfg.json.flightdata.timetable, true);
  assert.equal(cfg.json.flightdata.mock, true);
  const r = await get('/api/flightdata/route?from=TPE&to=YVR');
  assert.equal(r.status, 200);
  assert.equal(r.json.mock, true);
  assert.ok(r.json.flights.length >= 2);
  assert.match(r.cache, /max-age=600/);
  assert.equal((await get('/api/flightdata/route?from=TP&to=YVR')).status, 400);
  assert.equal((await get('/api/flightdata/terminals')).json.airlines.BR, '2');
  assert.ok((await get('/api/flightdata/upcoming')).json.routes.length >= 1);
  assert.ok((await get('/api/flightdata/lf?from=TPE&to=NRT')).json.routes['TPE-NRT']);
  const s = await get('/api/flightdata/status');
  assert.equal(s.status, 200); // the demo has no passcode: the owner
  assert.equal(s.json.tdxKey, false);
  assert.equal((await get('/api/flightdata/refresh')).status, 405);
  const pr = await get('/api/flightdata/refresh', { method: 'POST' });
  assert.equal(pr.status, 200);
});

test('a file that cannot be read shows its first lines on the status page', () => {
  assert.throws(() => F.parseCaaSchedule('甲,乙\n1,2\n'), /找不到欄位名稱（航班、起訖機場）｜開頭：甲\|乙｜1\|2/);
  const ty = F.parseTaoyuan('kind,a,b\nPD,X,Y\n');
  assert.equal(ty.sample, 'PD|X|Y');
});
