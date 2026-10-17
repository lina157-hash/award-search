// 查航班動態 and 這班過去準點率 (我的行程, public/flightstatus.js): one flight's status on one day, and that flight number's
// delay statistics, from AeroDataBox on RapidAPI (the same RAPIDAPI_KEY and monthly units as lib/aerodatabox.js).
// From AeroDataBox's own docs (doc.aerodatabox.com RapidAPI spec, aerodatabox.com/pricing and /data-coverage, read 2026-10-16):
// - GET /flights/number/{number}/{dateLocal}: "Flight Status (single day)", TIER 2 = 2 units. An array of the flights
//   departing or arriving that local day (dateLocalRole defaults to Both); 204 when there are none. Live status only
//   near the day ("typically up to tomorrow"); schedules and history up to 365 days either way on the free Basic plan.
// - GET /flights/{number}/delays: "Flight Delay Statistics by Flight Number", TIER 3 = 6 units. Median delay, delay
//   percentiles and delay brackets at the origin(s) and destination(s), from flights tracked live lately; 204 when none.
// The free plan has 400 units a month. A status is kept 10 minutes, delay statistics two weeks.
const { DirectsError } = require('./aerodatabox');
const { validDate } = require('./day');

const HOST = 'aerodatabox.p.rapidapi.com';
const UNITS = { status: 2, delays: 6 };
const AHEAD_DAYS = 7; // live status starts about a day before; further out it would only be the timetable
const PAST_DAYS = 365; // the Basic plan's history
const FLIGHT_NO = /^([A-Z0-9]{2}|[A-Z]{3})(\d{1,4})([A-Z]?)$/;
// "BR 0032" / "br32" → "BR32"; null when it is not a flight number.
function normFlight(s) {
  const m = FLIGHT_NO.exec(String(s || '').toUpperCase().replace(/\s+/g, ''));
  return m && /[A-Z]/.test(m[1]) ? `${m[1]}${Number(m[2])}${m[3]}` : null;
}
const dayDiff = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5);
// Why a date cannot be asked about (empty when it can): the API's window, and no units spent on a mere timetable.
function dateProblem(date, today) {
  if (!validDate(date)) return '日期格式不對';
  const d = dayDiff(today, date);
  if (d > AHEAD_DAYS) return `航班動態要在出發前 ${AHEAD_DAYS} 天內才查得到（即時動態通常出發前一天才有），這班還有 ${d} 天`;
  if (d < -PAST_DAYS) return '超過一年前的航班查不到';
  return '';
}

const STATUS_ZH = { Unknown: '狀態不明', Expected: '預定', EnRoute: '飛行中', CheckIn: '報到中', Boarding: '登機中', GateClosed: '登機門已關', Departed: '已起飛', Delayed: '延誤', Approaching: '即將降落', Arrived: '已抵達', Canceled: '已取消', Diverted: '轉降他地', CanceledUncertain: '可能取消' };
const AIRBORNE = new Set(['Departed', 'EnRoute', 'Approaching', 'Arrived', 'Diverted']);
const FLYING = new Set(['Departed', 'EnRoute', 'Approaching', 'Diverted']); // in the air now: where the plane is matters
// AeroDataBox writes times as "2026-10-16 08:30+08:00" (local) and "2026-10-16 00:30Z" (UTC).
function when(t) {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(String(t?.local || ''));
  if (!m) return null;
  const utc = Date.parse(String(t.utc || '').replace(' ', 'T'));
  return { date: m[1], time: m[2], utc: Number.isFinite(utc) ? utc : null };
}
const str = (v, max = 40) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : '');
// One end of a flight. `latest`: the revised (estimated or actual), predicted or runway time, whichever came;
// `actual` once the flight has left (departure) or landed (arrival).
function movement(m, end, status) {
  const sched = when(m?.scheduledTime);
  const latest = when(m?.revisedTime) || when(m?.predictedTime) || when(m?.runwayTime);
  const delay = sched?.utc != null && latest?.utc != null ? Math.round((latest.utc - sched.utc) / 60000) : null;
  return {
    iata: str(m?.airport?.iata, 4), name: str(m?.airport?.shortName || m?.airport?.municipalityName || m?.airport?.name),
    scheduled: sched && { date: sched.date, time: sched.time }, latest: latest && { date: latest.date, time: latest.time },
    actual: Boolean(latest) && (end === 'dep' ? AIRBORNE.has(status) : status === 'Arrived'),
    delayMin: delay, terminal: str(m?.terminal, 10), gate: str(m?.gate, 10), checkIn: str(m?.checkInDesk, 20), belt: str(m?.baggageBelt, 10),
    live: Array.isArray(m?.quality) && m.quality.includes('Live'),
  };
}
// The aircraft's last reported position (withLocation=true; FlightLocationContract: lat, lon, pressureAltitude and
// altitude as Distance {feet, meter…}, groundSpeed as Speed {kmPerHour, kt…}, trueTrack as Azimuth {deg},
// reportedAtUtc). null when there is none (on the ground, or no receiver heard it) or it is not a place on Earth.
const numOf = (v, ...keys) => {
  if (v != null && typeof v !== 'object') return Number.isFinite(Number(v)) ? Number(v) : null;
  for (const [k, f] of keys) if (v && v[k] != null && Number.isFinite(Number(v[k]))) return Number(v[k]) * f;
  return null;
};
function position(loc, src = 'aerodatabox') {
  const lat = Number(loc?.lat);
  const lon = Number(loc?.lon);
  if (loc?.lat == null || loc?.lon == null || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const ft = numOf(loc.pressureAltitude, ['feet', 1], ['meter', 3.28084]) ?? numOf(loc.altitude, ['feet', 1], ['meter', 3.28084]);
  const kmh = numOf(loc.groundSpeed, ['kmPerHour', 1], ['kt', 1.852], ['meterPerSecond', 3.6]);
  const track = numOf(loc.trueTrack, ['deg', 1]);
  const at = Date.parse(String(loc.reportedAtUtc || '').replace(' ', 'T'));
  return {
    lat: Math.round(lat * 1000) / 1000, lon: Math.round(lon * 1000) / 1000, src,
    altFt: ft != null && ft >= 0 && ft < 70000 ? Math.round(ft / 100) * 100 : null,
    kmh: kmh != null && kmh >= 0 && kmh < 1500 ? Math.round(kmh) : null,
    track: track != null ? Math.round(((track % 360) + 360) % 360) : null,
    at: Number.isFinite(at) ? new Date(at).toISOString() : null,
  };
}
// The API's array of FlightContract → the legs the page shows.
function normalizeStatus(list) {
  return (Array.isArray(list) ? list : []).filter((f) => f && typeof f === 'object' && (f.departure || f.arrival)).slice(0, 6).map((f) => {
    const status = STATUS_ZH[f.status] ? f.status : 'Unknown';
    return {
      number: str(f.number, 12), status, statusZh: STATUS_ZH[status], airline: str(f.airline?.name), aircraft: str(f.aircraft?.model), reg: str(f.aircraft?.reg, 12),
      codeshare: f.codeshareStatus === 'IsCodeshared', updated: str(f.lastUpdatedUtc, 30), from: movement(f.departure, 'dep', status), to: movement(f.arrival, 'arr', status),
      pos: FLYING.has(status) ? position(f.location) : null,
      // For OpenSky (lib/opensky.js): the transponder address and the call sign.
      hex: /^[0-9a-f]{6}$/i.test(f.aircraft?.modeS || '') ? f.aircraft.modeS.toLowerCase() : '',
      // The call sign AeroDataBox sent, else the airline's ICAO code and the flight's number (CI 61 → CAL61), as most fly it.
      callsign: str(f.callSign, 10) || (/^[A-Z]{3}$/.test(f.airline?.icao || '') && /(\d{1,4})[A-Z]?$/.test(String(f.number || '')) ? `${f.airline.icao}${Number(/(\d{1,4})[A-Z]?$/.exec(f.number)[1])}` : ''),
    };
  });
}
// A flight number can fly several legs a day (TPE → NRT → HNL), and dateLocalRole=Both also lists yesterday's
// overnight one landing today: the leg leaving `from` on `date` first, then any leaving on `date`, else all of them.
function pickLegs(legs, { date, from } = {}) {
  const day = legs.filter((l) => l.from.scheduled?.date === date);
  const here = day.filter((l) => from && l.from.iata === from);
  return here.length ? here : day.length ? day : legs;
}

// "[-][d.]hh:mm:ss" (a .NET time span) → whole minutes; null when unreadable.
function spanMin(s) {
  const m = /^(-)?(?:(\d+)\.)?(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const min = Number(m[2] || 0) * 1440 + Number(m[3]) * 60 + Number(m[4]) + Number(m[5] || 0) / 60;
  return (m[1] ? -Math.round(min) : Math.round(min)) || 0;
}
const ON_TIME_MIN = 15; // the usual on-time line: within 15 minutes of the timetable
// Share of flights at most 15 minutes late: from the brackets when one ends at exactly 15 minutes, else from the
// percentiles (the highest one still within 15 minutes, so 「約」).
function onTimeShare(brackets, pct) {
  const bs = (Array.isArray(brackets) ? brackets : []).map((b) => ({ to: spanMin(b?.delayedTo), num: Number(b?.num) || 0 }));
  const total = bs.reduce((n, b) => n + b.num, 0);
  if (total > 0 && bs.some((b) => b.to === ON_TIME_MIN)) return { pct: Math.round((bs.filter((b) => b.to != null && b.to <= ON_TIME_MIN).reduce((n, b) => n + b.num, 0) / total) * 100), approx: false };
  if (!pct.length) return null;
  const under = pct.filter((p) => p.min <= ON_TIME_MIN);
  return under.length ? { pct: under.at(-1).p, approx: true } : { pct: pct[0].p, approx: true, under: true };
}
function delayStat(x) {
  const pct = (Array.isArray(x.delayPercentiles) ? x.delayPercentiles : []).map((p) => ({ p: Number(p?.percentile), min: spanMin(p?.delay) }))
    .filter((p) => Number.isFinite(p.p) && p.min != null).sort((a, b) => a.p - b.p);
  return {
    airport: str(x.airportIcao, 4), flights: Number(x.numConsideredFlights) || 0, median: spanMin(x.medianDelay),
    onTime: onTimeShare(x.numFlightsDelayedBrackets, pct), p80: pct.find((p) => p.p === 80)?.min ?? null,
    from: str(x.fromUtc, 10), to: str(x.toUtc, 10),
  };
}
// FlightLegDelayContract → departure (origins) and arrival (destinations) statistics: the whole-flight figures
// (class Flight, not one scheduled hour) with the most flights behind them.
function normalizeDelays(body, flight) {
  const pick = (list) => {
    const xs = (Array.isArray(list) ? list : []).filter((x) => x && Number(x.numConsideredFlights) > 0);
    const whole = xs.filter((x) => x.class === 'Flight' || x.class === 0);
    const best = (whole.length ? whole : xs).sort((a, b) => b.numConsideredFlights - a.numConsideredFlights)[0];
    return best ? delayStat(best) : null;
  };
  const dep = pick(body?.origins);
  const arr = pick(body?.destinations);
  return { flight: str(body?.number, 12) || flight, found: Boolean(dep || arr), dep, arr };
}

// Made-up answers in the API's own shapes, for the demo (no key): they go through the same normalizers.
const hash = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const pad = (n) => String(n).padStart(2, '0');
function mockStatusBody(flight, date, { from = 'TPE', to = 'NRT', now = Date.now() } = {}) {
  const h = hash(flight + date);
  const dep = Date.parse(`${date}T${pad(6 + (h % 14))}:${pad(((h >>> 4) % 4) * 15)}:00+08:00`);
  const arr = dep + (2 + ((h >>> 6) % 10)) * 3600e3 + ((h >>> 3) % 4) * 15 * 60e3;
  const late = [0, 5, 15, 35, 70][(h >>> 9) % 5] * 60e3;
  const t = (ms) => { const l = new Date(ms + 8 * 3600e3).toISOString(); return { utc: `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')}Z`, local: `${l.slice(0, 10)} ${l.slice(11, 16)}+08:00` }; };
  const near = Math.abs(dep - now) < 30 * 3600e3;
  const status = now > arr + late ? 'Arrived' : now > dep + late ? 'EnRoute' : now > dep - 40 * 60e3 ? 'Boarding' : late >= 15 * 60e3 && near ? 'Delayed' : 'Expected';
  const quality = near || now > dep ? ['Basic', 'Live'] : ['Basic'];
  const live = quality.includes('Live');
  return [{
    number: flight.replace(/^([A-Z0-9]{2})/, '$1 '), status, codeshareStatus: 'IsOperator', isCargo: false, lastUpdatedUtc: `${new Date(now - 4 * 60e3).toISOString().slice(0, 16).replace('T', ' ')}Z`,
    departure: { airport: { iata: from, name: from, shortName: from }, scheduledTime: t(dep), ...(live ? { revisedTime: t(dep + late) } : {}), ...(status === 'EnRoute' || status === 'Arrived' ? { runwayTime: t(dep + late + 14 * 60e3) } : {}), terminal: String(1 + (h % 2)), gate: live ? `${'ABCD'[h % 4]}${1 + ((h >>> 2) % 12)}` : undefined, checkInDesk: live ? `${10 + (h % 8)}` : undefined, quality },
    arrival: { airport: { iata: to, name: to, shortName: to }, scheduledTime: t(arr), ...(live ? { revisedTime: t(arr + late * 0.6) } : {}), terminal: String(1 + ((h >>> 1) % 2)), baggageBelt: status === 'Arrived' ? String(1 + (h % 9)) : undefined, quality },
    ...(status === 'EnRoute' ? { location: mockLocation(from, to, (now - dep - late) / (arr - dep), now) } : {}),
    airline: { name: { BR: 'EVA Air', CI: 'China Airlines', JX: 'Starlux', CX: 'Cathay Pacific', JL: 'Japan Airlines', NH: 'ANA' }[flight.slice(0, 2)] || flight.slice(0, 2) },
    aircraft: { model: ['Boeing 777-300ER', 'Airbus A350-900', 'Boeing 787-10', 'Airbus A321neo'][h % 4], reg: `B-${16700 + (h % 90)}` },
  }];
}
// The demo's plane: on the straight line between the two airports, the share of the way the clock says.
const MOCK_AP = { TPE: [25.08, 121.23], TSA: [25.07, 121.55], KHH: [22.58, 120.35], NRT: [35.76, 140.39], HND: [35.55, 139.78], KIX: [34.43, 135.23], ICN: [37.46, 126.44], HKG: [22.31, 113.91], SIN: [1.36, 103.99], BKK: [13.69, 100.75], LAX: [33.94, -118.41], SFO: [37.62, -122.38] };
function mockLocation(from, to, share, now = Date.now()) {
  const [a, b] = [MOCK_AP[from], MOCK_AP[to]];
  if (!a || !b) return undefined;
  const k = Math.min(0.95, Math.max(0.05, share));
  const track = (Math.atan2((b[1] - a[1]) * Math.cos((a[0] * Math.PI) / 180), b[0] - a[0]) * 180) / Math.PI;
  return { lat: a[0] + (b[0] - a[0]) * k, lon: a[1] + (b[1] - a[1]) * k, pressureAltitude: { feet: 36000, meter: 10973 }, groundSpeed: { kt: 470, kmPerHour: 870 }, trueTrack: { deg: (track + 360) % 360 }, reportedAtUtc: new Date(now - 2 * 60e3).toISOString().slice(0, 16).replace('T', ' ') + 'Z' };
}
function mockDelaysBody(flight, { now = Date.now() } = {}) {
  const h = hash(flight);
  const side = (icao, shift) => {
    const pct = Array.from({ length: 19 }, (_, i) => (i + 1) * 5).map((p) => ({ percentile: p, delay: span(Math.round(-12 + shift + p * (0.35 + (h % 5) / 10) + (p > 80 ? (p - 80) * 2 : 0))) }));
    const n = 60 + (h % 40);
    const cuts = [[null, '-00:15:00', 0.18], ['-00:15:00', '00:00:00', 0.32], ['00:00:00', '00:15:00', 0.28], ['00:15:00', '00:30:00', 0.12], ['00:30:00', '01:00:00', 0.07], ['01:00:00', null, 0.03]];
    return { airportIcao: icao, class: 'Flight', medianDelay: pct[9].delay, delayPercentiles: pct, numConsideredFlights: n, numFlightsDelayedBrackets: cuts.map(([a, b, f]) => ({ delayedFrom: a, delayedTo: b, num: Math.round(n * f) })), fromUtc: new Date(now - 90 * 864e5).toISOString(), toUtc: new Date(now - 864e5).toISOString() };
  };
  return { number: flight, origins: [side('RCTP', h % 6)], destinations: [side('RJAA', (h >>> 3) % 8 - 4)] };
}
function span(min) {
  const a = Math.abs(min);
  return `${min < 0 ? '-' : ''}${pad(Math.floor(a / 60))}:${pad(a % 60)}:00`;
}

// `kv` (lib/kv.js) shares answers across instances; `spend(units)` → false: the month's units are (nearly) used up;
// `refund(units)`: a call that got nothing (network, rate limit, server error); `onQuota({ left, limit })` from the
// response headers. `mock`: made-up answers, nothing spent.
// 飛機現在在哪 for a leg in the air: `live` (lib/opensky.js) first, its position fresher than AeroDataBox's; then the
// position AeroDataBox sent; then `backup` (lib/aviationstack.js) when neither has one.
function createFlightStatus({ apiKey = '', fetchImpl = fetch, kv = null, mock = false, live = null, backup = null, now = () => Date.now(), spend = async () => true, refund = async () => {}, onQuota = () => {}, statusTtlSec = 600, delayTtlSec = 14 * 86400 } = {}) {
  const memo = new Map();
  const pending = new Map();
  let blockedUntil = 0;
  async function upstream(path, units) {
    if (now() < blockedUntil) throw new DirectsError('AeroDataBox 這個月的免費額度用完了', 429);
    if (!(await spend(units))) throw new DirectsError('AeroDataBox 這個月的額度快用完了，先暫停查詢', 429);
    let res;
    try {
      res = await fetchImpl(`https://${HOST}${path}`, { headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': HOST, accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    } catch {
      await refund(units);
      throw new DirectsError('航班資料來源連線失敗，請稍後再試', 504);
    }
    if (res.status === 429 || res.status === 401 || res.status === 403 || res.status >= 500) await refund(units);
    const left = res.headers.get('x-ratelimit-api-units-remaining') ?? res.headers.get('x-ratelimit-requests-remaining');
    if (left != null && Number.isFinite(Number(left))) onQuota({ left: Number(left), limit: Number(res.headers.get('x-ratelimit-api-units-limit')) || null });
    if (res.status === 204 || res.status === 404) return null;
    const body = await res.json().catch(() => null);
    const msg = String(body?.message || '');
    if (res.status === 429) {
      if (/monthly quota/i.test(msg)) blockedUntil = now() + 24 * 3600e3;
      throw new DirectsError(/monthly quota/i.test(msg) ? 'AeroDataBox 這個月的免費額度用完了' : '查詢太頻繁，請稍後再試', 429);
    }
    if (res.status === 401 || res.status === 403) throw new DirectsError(/not subscribed/i.test(msg) ? 'RapidAPI 金鑰還沒訂閱 AeroDataBox' : 'RapidAPI 金鑰無法使用 AeroDataBox', res.status);
    if (res.status === 400) throw new DirectsError('AeroDataBox 不接受這個航班號碼或日期', 400);
    if (!res.ok) throw new DirectsError(`航班資料來源回應錯誤 (${res.status})`, 502);
    return body;
  }
  // The cached answer, or one lookup shared by everyone asking the same at once. `fresh`: false when it came from
  // the cache (no units spent this time).
  async function once(key, ttlSec, fn) {
    const hit = memo.get(key);
    if (hit && now() - hit.at < ttlSec * 1000) return { ...hit, fresh: false };
    if (!pending.has(key)) {
      pending.set(key, (async () => {
        const saved = kv ? await kv.get(key).catch(() => null) : null;
        if (saved && now() - saved.at < ttlSec * 1000) { memo.set(key, saved); return { ...saved, fresh: false }; }
        const entry = { at: now(), v: await fn() };
        memo.set(key, entry);
        if (memo.size > 300) memo.delete(memo.keys().next().value);
        if (kv) await kv.set(key, entry, { ex: ttlSec }).catch(() => {});
        return { ...entry, fresh: true };
      })().finally(() => pending.delete(key)));
    }
    return pending.get(key);
  }
  // `from`/`to`: the leg's airports, to pick the right leg (and to make the demo's answer fit it).
  async function status(flightIn, date, { from = '', to = '', today } = {}) {
    const flight = normFlight(flightIn);
    if (!flight) throw new DirectsError('航班號碼格式不對（例如 BR32）', 400);
    const why = dateProblem(date, today);
    if (why) throw new DirectsError(why, 400);
    const r = await once(`fstatus:v3:${flight}:${date}`, statusTtlSec, async () => normalizeStatus(mock ? mockStatusBody(flight, date, { from: from || undefined, to: to || undefined, now: now() }) : await upstream(`/flights/number/${flight}/${date}?withAircraftImage=false&withLocation=true`, UNITS.status)));
    let legs = pickLegs(r.v, { date, from });
    let posBackup = null;
    let posLive = null;
    const air = legs.find((l) => FLYING.has(l.status));
    const put = (pos) => { legs = legs.map((l) => (l === air ? { ...l, pos } : l)); };
    if (live && air) {
      posLive = await live.lookup({ icao24: air.hex, callsign: air.callsign }).catch(() => null);
      if (posLive?.pos) put(posLive.pos);
    }
    const lost = legs.find((l) => FLYING.has(l.status) && !l.pos);
    if (backup && lost) {
      posBackup = await backup.lookup(flight, date, lost.from.iata).catch(() => null);
      if (posBackup?.pos) legs = legs.map((l) => (l === lost ? { ...l, pos: posBackup.pos } : l));
    }
    // The page needs none of the lookup keys.
    legs = legs.map(({ hex, callsign, ...l }) => l);
    return {
      flight, date, found: legs.length > 0, legs, at: new Date(r.at).toISOString(), spent: r.fresh && !mock ? UNITS.status : 0,
      ...(posLive ? { live: { left: posLive.left ?? null, why: posLive.why || '', by: posLive.by || '', authFailed: Boolean(posLive.authFailed) } } : {}),
      ...(posBackup ? { backup: { spent: posBackup.spent, left: posBackup.left, limit: posBackup.limit } } : {}),
    };
  }
  async function delays(flightIn) {
    const flight = normFlight(flightIn);
    if (!flight) throw new DirectsError('航班號碼格式不對（例如 BR32）', 400);
    const r = await once(`fdelay:v1:${flight}`, delayTtlSec, async () => normalizeDelays(mock ? mockDelaysBody(flight, { now: now() }) : await upstream(`/flights/${flight}/delays`, UNITS.delays), flight));
    return { ...r.v, flight, at: new Date(r.at).toISOString(), spent: r.fresh && !mock ? UNITS.delays : 0 };
  }
  return { status, delays, mock };
}

module.exports = { createFlightStatus, normalizeStatus, position, FLYING, normalizeDelays, pickLegs, spanMin, onTimeShare, normFlight, dateProblem, mockStatusBody, mockDelaysBody, UNITS, AHEAD_DAYS, PAST_DAYS };
