// 飛機現在在哪 (查航班動態 in 我的行程): AeroDataBox's position with the status (withLocation=true), Aviationstack as the
// backup when the plane is in the air without one, and the page's distance, progress and wording helpers.
const { test } = require('node:test');
const assert = require('node:assert');
const fsl = require('../lib/flightstatus');
const { createAviationstack } = require('../lib/aviationstack');
const { memoryKv } = require('../lib/kv');
const page = require('../public/flightstatus.js');

const flight = (over = {}) => ({
  number: 'BR 198', status: 'EnRoute', codeshareStatus: 'IsOperator', lastUpdatedUtc: '2026-10-17 03:02Z',
  departure: { airport: { iata: 'TPE' }, scheduledTime: { utc: '2026-10-17 01:30Z', local: '2026-10-17 09:30+08:00' }, quality: ['Basic', 'Live'] },
  arrival: { airport: { iata: 'NRT' }, scheduledTime: { utc: '2026-10-17 04:45Z', local: '2026-10-17 13:45+09:00' }, quality: ['Basic', 'Live'] },
  location: { pressureAltitude: { meter: 11277.6, km: 11.28, mile: 7.01, nm: 6.09, feet: 37000 }, altitude: { feet: 37350 }, groundSpeed: { kt: 480, kmPerHour: 888.96, miPerHour: 552.4, meterPerSecond: 246.9 }, trueTrack: { deg: 52.4, rad: 0.91 }, reportedAtUtc: '2026-10-17 03:00Z', lat: 30.12345, lon: 131.98765 },
  ...over,
});

test('position: a plane in the air keeps its place, height, speed and heading; one on the ground or without one has none', () => {
  const [l] = fsl.normalizeStatus([flight()]);
  assert.deepEqual(l.pos, { lat: 30.123, lon: 131.988, src: 'aerodatabox', altFt: 37000, kmh: 889, track: 52, at: '2026-10-17T03:00:00.000Z' });
  assert.equal(fsl.normalizeStatus([flight({ status: 'Arrived' })])[0].pos, null, 'landed: no map');
  assert.equal(fsl.normalizeStatus([flight({ location: undefined })])[0].pos, null);
  assert.equal(fsl.normalizeStatus([flight({ location: { lat: 'x', lon: 2 } })])[0].pos, null);
  assert.equal(fsl.normalizeStatus([flight({ location: { lat: 95, lon: 2 } })])[0].pos, null, 'not a place on Earth');
  // Units the contract may carry instead: metres and knots.
  const p = fsl.position({ lat: 1, lon: 2, altitude: { meter: 10000 }, groundSpeed: { kt: 500 }, trueTrack: -10 });
  assert.deepEqual([p.altFt, p.kmh, p.track, p.at], [32800, 926, 350, null]);
});

function fakeFetch(responses) {
  const calls = [];
  return { calls, fetchImpl: async (url) => { calls.push(String(url)); const r = responses.shift(); if (r instanceof Error) throw r; return { status: r.status || 200, ok: (r.status || 200) < 300, headers: new Map(), json: async () => r.body }; } };
}
const avBody = (live, over = {}) => ({ data: [{ flight_date: '2026-10-17', departure: { iata: 'TPE' }, flight: { iata: 'BR198' }, live, ...over }] });
const LIVE = { updated: '2026-10-17T03:01:00+00:00', latitude: 31.5, longitude: 133.25, altitude: 11000, direction: 55, speed_horizontal: 870, is_ground: false };

test('Aviationstack backup: asked only for a plane in the air with no position, counted against 100 a month, kept 10 minutes', async () => {
  const kv = memoryKv();
  const av = fakeFetch([{ body: avBody(LIVE) }]);
  const backup = createAviationstack({ apiKey: 'secret', fetchImpl: av.fetchImpl, kv, month: () => '2026-10' });
  const adb = fakeFetch([{ body: [flight({ location: undefined })] }, { body: [flight({ number: 'CI 100' })] }]);
  const fs = fsl.createFlightStatus({ apiKey: 'k', fetchImpl: adb.fetchImpl, kv, backup });
  const r = await fs.status('BR198', '2026-10-17', { from: 'TPE', today: '2026-10-17' });
  assert.match(adb.calls[0], /withLocation=true/);
  assert.equal(av.calls.length, 1);
  assert.match(av.calls[0], /^https:\/\/api\.aviationstack\.com\/v1\/flights\?access_key=secret&flight_iata=BR198$/);
  assert.deepEqual(r.legs[0].pos, { lat: 31.5, lon: 133.25, src: 'aviationstack', altFt: 36100, kmh: 870, track: 55, at: '2026-10-17T03:01:00.000Z' });
  assert.deepEqual(r.backup, { spent: 1, left: 99, limit: 100 });
  const again = await fs.status('BR198', '2026-10-17', { from: 'TPE', today: '2026-10-17' });
  assert.equal(av.calls.length, 1, 'kept: no second request');
  assert.equal(again.backup.spent, 0);
  // AeroDataBox had the position: Aviationstack is not asked.
  const r2 = await fs.status('CI100', '2026-10-17', { from: 'TPE', today: '2026-10-17' });
  assert.equal(r2.legs[0].pos.src, 'aerodatabox');
  assert.equal(r2.backup, undefined);
  assert.equal(av.calls.length, 1);
});

test('Aviationstack backup: no live data, an error answer, a dead line and a used-up month all leave the map out', async () => {
  const kv = memoryKv();
  const av = fakeFetch([{ body: avBody(null) }, { body: { error: { code: 'usage_limit_reached', message: 'x' } } }, new Error('offline'), { status: 503 }]);
  let t = Date.parse('2026-10-17T03:00:00Z');
  const b = createAviationstack({ apiKey: 'k', fetchImpl: av.fetchImpl, kv, now: () => t, month: () => '2026-10' });
  assert.equal((await b.lookup('BR198', '2026-10-17', 'TPE')).pos, null);
  assert.equal((await b.lookup('BR16', '2026-10-17', 'TPE')).why, 'error');
  assert.equal((await b.lookup('BR12', '2026-10-17', 'TPE')).why, 'quota', 'blocked for a day after usage_limit_reached');
  t += 25 * 3600e3;
  assert.equal((await b.lookup('BR12', '2026-10-17', 'TPE')).why, 'down');
  assert.equal((await b.lookup('BR18', '2026-10-17', 'TPE')).why, 'down');
  assert.equal(Number(await kv.get('avstack:req:2026-10')), 2, 'no connection and a server error are given back');
  await kv.set('avstack:req:2026-10', 95);
  const r = await b.lookup('BR20', '2026-10-17', 'TPE');
  assert.equal(r.why, 'quota', 'five kept back for the owner');
  assert.equal(av.calls.length, 4);
  // Another day's flight with the same number, or one on the ground, is not this plane.
  const other = fakeFetch([{ body: { data: [{ flight_date: '2026-10-16', departure: { iata: 'TPE' }, live: LIVE }, { flight_date: '2026-10-17', departure: { iata: 'TPE' }, live: { ...LIVE, is_ground: true } }] } }]);
  const b2 = createAviationstack({ apiKey: 'k', fetchImpl: other.fetchImpl });
  assert.equal((await b2.lookup('BR198', '2026-10-17', 'TPE')).pos, null);
});

test('the demo: a flight in the air has a position between its airports', () => {
  const dep = Date.parse('2026-10-17T00:00:00Z');
  const body = fsl.mockStatusBody('BR198', '2026-10-17', { from: 'TPE', to: 'NRT', now: dep + 12 * 3600e3 });
  const [l] = fsl.normalizeStatus(body);
  if (l.status === 'EnRoute') {
    assert.ok(l.pos.lat > 25 && l.pos.lat < 36 && l.pos.lon > 121 && l.pos.lon < 141);
  } else assert.equal(l.pos, null);
});

test('page: distance, how far along, the great circle across 180°, and the words', () => {
  const TPE = { lat: 25.08, lon: 121.23 };
  const NRT = { lat: 35.76, lon: 140.39 };
  const LAX = { lat: 33.94, lon: -118.41 };
  assert.ok(Math.abs(page.fstKm(TPE, NRT) - 2180) < 30);
  const half = { lat: 30.6, lon: 130.5 };
  const p = page.fstProgress(half, TPE, NRT);
  assert.ok(p.pct > 40 && p.pct < 60);
  assert.equal(p.leftKm % 10, 0);
  assert.equal(page.fstProgress(half, null, NRT), null);
  const arc = page.fstArc(TPE, LAX);
  assert.equal(arc.length, 25);
  assert.ok(arc.every((x, i) => !i || Math.abs(x[1] - arc[i - 1][1]) < 30), 'no jump at 180°');
  assert.ok(Math.abs(arc.at(-1)[1] - (360 - 118.41)) < 0.01, 'LAX is reached going east');
  assert.ok(Math.max(...arc.map((x) => x[0])) > 40, 'the great circle bends north');
  assert.equal(page.fstWhereText({ lat: 30, lon: 131 }, { pct: 62, leftKm: 1050 }, '東京'), '已飛約 62%，離東京還有約 1,050 公里');
  assert.equal(page.fstWhereText({ lat: -33.9, lon: -70.8 }, null, 'X'), '南緯 33.9°、西經 70.8°');
  assert.equal(page.fstPosFacts({ altFt: 37000, kmh: 889, at: '2026-10-17T03:00:00Z' }, Date.parse('2026-10-17T03:04:00Z')), '高度約 37,000 英尺（11,300 公尺）・地速約 889 公里／時・4 分鐘前的位置');
  assert.equal(page.fstPosFacts({ altFt: null, kmh: null, at: null }), '');
  assert.equal(page.fstFr24('BR 198'), 'https://www.flightradar24.com/data/flights/br198');
});

const { createOpenSky, callKey, TOKEN_URL } = require('../lib/opensky');
function fakeSky(responses) {
  const calls = [];
  return { calls, fetchImpl: async (url, opts = {}) => { calls.push({ url: String(url), opts }); const r = responses.shift(); if (r instanceof Error) throw r; return { status: r.status || 200, ok: (r.status || 200) < 300, headers: new Map(Object.entries(r.headers || {})), json: async () => r.body }; } };
}
// icao24, callsign, origin_country, time_position, last_contact, lon, lat, baro_altitude, on_ground, velocity, true_track
const STATE = ['8991a6', 'EVA198  ', 'Taiwan', 1792206000, 1792206005, 133.5, 31.75, 11277.6, false, 246.9, 52.4, 0, null, 11400, '1234', false, 0];

test('OpenSky: the plane by its transponder address, signed in with the client credentials, kept a minute', async () => {
  const sky = fakeSky([{ body: { access_token: 'tok', expires_in: 1800 } }, { body: { time: 1, states: [STATE] }, headers: { 'x-rate-limit-remaining': '3996' } }]);
  let t = Date.parse('2026-10-17T03:00:10Z');
  const o = createOpenSky({ clientId: 'id', clientSecret: 'sec', fetchImpl: sky.fetchImpl, now: () => t });
  const r = await o.lookup({ icao24: '8991A6', callsign: 'EVA198' });
  assert.equal(sky.calls[0].url, TOKEN_URL);
  assert.match(sky.calls[0].opts.body, /grant_type=client_credentials&client_id=id&client_secret=sec/);
  assert.equal(sky.calls[1].url, 'https://opensky-network.org/api/states/all?icao24=8991a6');
  assert.equal(sky.calls[1].opts.headers.authorization, 'Bearer tok');
  assert.deepEqual(r.pos, { lat: 31.75, lon: 133.5, src: 'opensky', altFt: 37000, kmh: 889, track: 52, at: '2026-10-17T03:00:00.000Z' });
  assert.equal(r.left, 3996);
  t += 30e3;
  assert.equal((await o.lookup({ icao24: '8991a6' })).cached, true);
  assert.equal(sky.calls.length, 2);
});

test('OpenSky: anonymous by call sign across every plane in the air; on the ground, 429, nothing to look it up by', async () => {
  const sky = fakeSky([{ body: { states: [['aaaaaa', 'CAL100', '', 1, 1, 130, 30, 1000, false, 200, 10], [...STATE.slice(0, 1), 'CAL061  ', ...STATE.slice(2)]] } }, { body: { states: [[...STATE.slice(0, 8), true, ...STATE.slice(9)]] } }, { status: 429, headers: { 'x-rate-limit-retry-after-seconds': '600' } }]);
  const o = createOpenSky({ fetchImpl: sky.fetchImpl });
  const r = await o.lookup({ callsign: 'CAL61' });
  assert.equal(sky.calls[0].url, 'https://opensky-network.org/api/states/all', 'no box: a long flight bends far past its airports');
  assert.equal(sky.calls[0].opts.headers.authorization, undefined, 'anonymous');
  assert.deepEqual([r.pos.lat, r.by, r.why], [31.75, 'callsign', ''], 'CAL061 is CAL61');
  const g = await o.lookup({ icao24: '8991a6' });
  assert.deepEqual([g.pos, g.by, g.why], [null, 'hex', 'unheard'], 'on the ground: no position');
  assert.equal((await o.lookup({ icao24: '123abc' })).why, 'quota');
  assert.equal((await o.lookup({ icao24: '456def' })).why, 'quota', 'waits out the retry time');
  assert.equal(sky.calls.length, 3);
  assert.equal((await o.lookup({})).why, 'nokey');
  assert.deepEqual(['CAL061 ', 'cal61', 'EVA198', 'BR198', ''].map(callKey), ['CAL61', 'CAL61', 'EVA198', '', '']);
});

test('OpenSky: a sign-in that fails is said, and the lookup goes on anonymously', async () => {
  const sky = fakeSky([{ status: 401, body: { error: 'invalid_client' } }, { body: { states: [STATE] } }]);
  const o = createOpenSky({ clientId: 'id', clientSecret: 'bad', fetchImpl: sky.fetchImpl });
  const r = await o.lookup({ icao24: '8991a6' });
  assert.equal(r.authFailed, true);
  assert.equal(r.pos.src, 'opensky');
  assert.equal(sky.calls[1].opts.headers.authorization, undefined);
  assert.match(page.fstLiveWhy({ why: '', authFailed: true }), /帳號登入失敗/);
  assert.match(page.fstLiveWhy({ why: 'unheard', by: 'hex' }), /^OpenSky 用飛機的識別碼查過，最近沒收到/);
  assert.match(page.fstLiveWhy({ why: 'nokey' }), /沒給這架飛機的識別碼和呼號/);
  assert.equal(page.fstLiveWhy(null), '');
});

test('a flight without a call sign is looked for as the airline\'s ICAO code and its number', async () => {
  const adb = fakeFetch([{ body: [flight({ number: 'CI 61', airline: { name: 'China Airlines', iata: 'CI', icao: 'CAL' }, aircraft: { reg: 'B-18003' }, location: undefined })] }]);
  const live = { asked: [], lookup: async (q) => { live.asked.push(q); return { pos: null, left: 3990, by: 'callsign', why: 'unheard' }; } };
  const fs = fsl.createFlightStatus({ apiKey: 'k', fetchImpl: adb.fetchImpl, live });
  const r = await fs.status('CI61', '2026-10-17', { from: 'TPE', today: '2026-10-17' });
  assert.deepEqual(live.asked[0], { icao24: '', callsign: 'CAL61' });
  assert.deepEqual(r.live, { left: 3990, why: 'unheard', by: 'callsign', authFailed: false });
  assert.equal(r.legs[0].pos, null);
});

test('OpenSky first, then AeroDataBox\'s own position, then Aviationstack; the lookup keys stay on the server', async () => {
  const adb = fakeFetch([{ body: [flight({ aircraft: { modeS: '8991A6', reg: 'B-16701' }, callSign: 'EVA198' })] }, { body: [flight({ number: 'BR 12', aircraft: { modeS: '899000' } })] }]);
  const live = { asked: [], lookup: async (q) => { live.asked.push(q); return q.icao24 === '8991a6' ? { pos: { lat: 32, lon: 134, src: 'opensky', altFt: 37000, kmh: 880, track: 50, at: null }, left: 3990 } : { pos: null, left: 3990 }; } };
  const fs = fsl.createFlightStatus({ apiKey: 'k', fetchImpl: adb.fetchImpl, live });
  const r = await fs.status('BR198', '2026-10-17', { from: 'TPE', today: '2026-10-17' });
  assert.equal(r.legs[0].pos.src, 'opensky');
  assert.deepEqual(r.live, { left: 3990, why: '', by: '', authFailed: false });
  assert.equal(live.asked[0].callsign, 'EVA198');
  assert.ok(!('hex' in r.legs[0]) && !('ends' in r.legs[0]) && !('callsign' in r.legs[0]));
  const r2 = await fs.status('BR12', '2026-10-17', { from: 'TPE', today: '2026-10-17' });
  assert.equal(r2.legs[0].pos.src, 'aerodatabox', 'OpenSky had nothing: AeroDataBox\'s own');
});
