// Award-space history per route: compact daily snapshots taken from searches the daily jobs (deals, seat alerts)
// already make, so it costs no extra seats.aero calls. For each day a route was looked at, and each program × cabin
// seen on it: how many departure dates had space, the lowest miles and the most seats on one flight.
// One Redis key per route (hist:v1:TPE-NRT) holding at most `days` days and `maxBytes` of JSON, with a TTL so routes
// nobody fetches any more disappear; an index (hist:v1:routes) caps the number of routes.
const { todayTW } = require('./day');
const { getMany } = require('./kv');

const PREFIX = 'hist:v1:';
const INDEX = PREFIX + 'routes';
const CABIN_LETTER = { economy: 'Y', premium: 'W', business: 'J', first: 'F' };
const DAY_MS = 864e5;
// Days are stored as numbers (days since 1970-01-01, Taiwan calendar), which keeps the JSON small.
const dayNum = (iso) => Math.round(Date.parse(iso + 'T00:00:00Z') / DAY_MS);
const isoOf = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
const codes = (s) => String(s || '').split(',').map((x) => x.trim().toUpperCase()).filter((x) => /^[A-Z]{3}$/.test(x));
const routeId = (o, d) => `${o}-${d}`;

// Summaries of one search's rows: Map route → Map "source.cabin" → [n, minMiles, maxSeats]. Every origin × destination
// pair asked about is included (an empty map means "looked, nothing there").
function summarize(params, rows, { maxPairs = 100 } = {}) {
  const cabin = CABIN_LETTER[params.cabins] || null;
  const cabins = cabin ? [cabin] : ['Y', 'W', 'J', 'F'];
  const out = new Map();
  for (const o of codes(params.origin_airport)) for (const d of codes(params.destination_airport)) if (out.size < maxPairs) out.set(routeId(o, d), new Map());
  const dates = new Map();
  for (const r of rows || []) {
    const per = out.get(routeId(r.origin, r.destination));
    if (!per || !r.source || !/^[a-z_]{2,30}$/.test(r.source)) continue;
    for (const c of cabins) {
      const x = r.cabins?.[c];
      if (!x?.available || !x.miles) continue;
      const k = `${r.source}.${c}`;
      const cur = per.get(k) || [0, Infinity, 0];
      const dk = `${routeId(r.origin, r.destination)}|${k}`;
      if (!dates.has(dk)) dates.set(dk, new Set());
      const ds = dates.get(dk);
      if (!ds.has(r.date)) { ds.add(r.date); cur[0]++; }
      cur[1] = Math.min(cur[1], x.miles);
      cur[2] = Math.max(cur[2], Number(x.seats) || 0);
      per.set(k, cur);
    }
  }
  return out;
}

// Put today's summary into a stored route record and trim it to the last `days` days and `maxBytes`.
// Record: { obs: [day, …] (days looked at), r: { "source.cabin": [[day, n, miles, seats], …] } }.
// Two looks on the same day merge (more dates, lower miles, more seats win).
function mergeDay(rec, day, per, { days = 120, maxBytes = 12000, maxSeries = 30 } = {}) {
  const out = { obs: [...new Set([...(rec?.obs || []), day])].sort((a, b) => a - b), r: { ...(rec?.r || {}) } };
  for (const [k, [n, m, s]] of per) {
    const list = (out.r[k] || []).filter((e) => e[0] !== day);
    const old = (rec?.r?.[k] || []).find((e) => e[0] === day);
    list.push(old ? [day, Math.max(old[1], n), Math.min(old[2], m), Math.max(old[3], s)] : [day, n, m, s]);
    out.r[k] = list.sort((a, b) => a[0] - b[0]);
  }
  const trimFrom = (from) => {
    out.obs = out.obs.filter((d) => d >= from);
    for (const k of Object.keys(out.r)) {
      out.r[k] = out.r[k].filter((e) => e[0] >= from);
      if (!out.r[k].length) delete out.r[k];
    }
  };
  trimFrom(day - days + 1);
  // Too many programs: keep the ones with space on the most days.
  const keys = Object.keys(out.r);
  if (keys.length > maxSeries) for (const k of keys.sort((a, b) => out.r[b].length - out.r[a].length).slice(maxSeries)) delete out.r[k];
  // Too big: drop the oldest days until it fits.
  while (JSON.stringify(out).length > maxBytes && out.obs.length > 1) trimFrom(out.obs[1]);
  return out;
}

// `demo`: routes without real history get made-up history (demo mode only).
function createHistory({ kv, enabled = true, demo = false, now = () => Date.now(), days = 120, maxRoutes = 200, maxBytes = 12000 }) {
  const ttl = (days + 10) * 86400;
  // Record what one search returned. Never throws: history is a by-product and must not break the job.
  async function note(params, rows) {
    if (!enabled) return 0;
    try {
      const per = summarize(params, rows);
      if (!per.size) return 0;
      const day = dayNum(todayTW(now()));
      const index = (await kv.get(INDEX).catch(() => null)) || {};
      for (const [route, s] of per) {
        const rec = await kv.get(PREFIX + route).catch(() => null);
        await kv.set(PREFIX + route, mergeDay(rec, day, s, { days, maxBytes }), { ex: ttl });
        index[route] = day;
      }
      // Over the cap: forget the routes looked at least recently.
      const all = Object.entries(index).filter(([, d]) => d > day - days).sort((a, b) => b[1] - a[1]);
      for (const [route] of all.slice(maxRoutes)) await kv.del(PREFIX + route).catch(() => {});
      await kv.set(INDEX, Object.fromEntries(all.slice(0, maxRoutes)), { ex: ttl });
      return per.size;
    } catch (e) {
      console.error('history', e.message);
      return 0;
    }
  }

  // For the search page: the routes among `origins` × `destinations` that have history (at most 4). At most 5 × 5
  // pairs (a city group or two, which is what the page sends), read in one MGET, so a request with long code lists
  // costs one store command, not one per pair.
  async function get(origins, destinations) {
    if (!enabled && !demo) return { routes: [] };
    const today = dayNum(todayTW(now()));
    const pairs = [];
    for (const o of [...new Set(codes(origins))].slice(0, 5)) for (const d of [...new Set(codes(destinations))].slice(0, 5)) pairs.push([o, d]);
    const recs = enabled && pairs.length ? await getMany(kv, pairs.map(([o, d]) => PREFIX + routeId(o, d))).catch(() => []) : [];
    const routes = [];
    for (const [i, [o, d]] of pairs.entries()) {
      if (routes.length >= 4) break;
      const rec = recs[i] || (demo ? mockHistory(o, d, { now: now() }) : null);
      if (rec?.obs?.length) routes.push(view(o, d, rec, today));
    }
    return { routes, ...(demo ? { mock: true } : {}) };
  }

  // Dates written out for the page, oldest first.
  function view(origin, destination, rec, today) {
    const from = today - days + 1;
    const obs = rec.obs.filter((x) => x >= from);
    const series = Object.entries(rec.r || {}).map(([k, list]) => {
      const [source, cabin] = k.split('.');
      const pts = list.filter((e) => e[0] >= from);
      return { source, cabin, days: pts.length, minMiles: Math.min(...pts.map((e) => e[2])), points: pts.map(([d, n, m, s]) => [isoOf(d), n, m, s]) };
    }).filter((s) => s.points.length);
    return { origin, destination, observed: obs.map(isoOf), series };
  }

  return { note, get, view, enabled };
}

// Made-up history for the demo, so the heatmap can be seen without the daily jobs having run.
function mockHistory(origin, destination, { now = Date.now(), days = 75 } = {}) {
  let seed = [...origin + destination].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) >>> 0;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const today = dayNum(todayTW(now));
  const progs = [['aeroplan', 'J', 60000], ['united', 'J', 70000], ['alaska', 'J', 55000], ['aeroplan', 'Y', 25000]];
  const obs = [];
  const r = {};
  for (let d = today - days + 1; d <= today; d++) {
    if (rnd() < 0.08) continue; // a missed daily run
    obs.push(d);
    for (const [src, cab, base] of progs) {
      const p = cab === 'Y' ? 0.75 : src === 'alaska' ? 0.2 : 0.45;
      if (rnd() > p) continue;
      (r[`${src}.${cab}`] ||= []).push([d, 1 + Math.floor(rnd() * (cab === 'Y' ? 20 : 6)), base + Math.floor(rnd() * 3) * 5000, 1 + Math.floor(rnd() * 4)]);
    }
  }
  return { obs, r };
}

module.exports = { createHistory, summarize, mergeDay, mockHistory, dayNum, isoOf };
