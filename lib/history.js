// Award-space history per route: compact daily snapshots taken from searches the daily jobs (deals, seat alerts)
// already make, so it costs no extra seats.aero calls. For each day a route was looked at, and each program × cabin
// seen on it: how many departure dates had space, the lowest miles and the most seats on one flight.
// Also, per cabin and calendar week, which weekdays the departure dates with space fell on (any program), so the page
// can say which weekdays usually have space on the route.
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
// Weekday of a day number, Monday = 0 … Sunday = 6 (day 0, 1970-01-01, was a Thursday).
const weekdayOf = (n) => (n + 3) % 7;
// Week number, weeks starting on Monday, and the first day of a week.
const weekOf = (n) => Math.floor((n + 3) / 7);
const weekStart = (w) => w * 7 - 3;
const isoDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && Number.isFinite(Date.parse(s + 'T00:00:00Z'));

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

// Per route asked and cabin searched: [has, looked, span] — departure dates with space on any program by weekday
// (Monday first), departure dates looked at by weekday (the search's date range from `today` on, or the dates seen in
// its rows when it gave none), and how many dates that range spans.
function summarizeWeekdays(params, rows, { today, maxPairs = 100, maxSpan = 400 } = {}) {
  const cabin = CABIN_LETTER[params.cabins] || null;
  const cabins = cabin ? [cabin] : ['Y', 'W', 'J', 'F'];
  const out = new Map();
  const routes = [];
  for (const o of codes(params.origin_airport)) for (const d of codes(params.destination_airport)) if (routes.length < maxPairs) routes.push(routeId(o, d));
  const seen = (rows || []).filter((r) => isoDay(r.date)).map((r) => dayNum(r.date));
  let from = isoDay(params.start_date) ? dayNum(params.start_date) : Math.min(...seen);
  const to = Math.min(isoDay(params.end_date) ? dayNum(params.end_date) : Math.max(...seen), Number.isFinite(from) ? from + maxSpan - 1 : Infinity);
  if (Number.isFinite(today)) from = Math.max(from, today);
  if (!routes.length || !Number.isFinite(from) || !Number.isFinite(to) || to < from) return out;
  const looked = [0, 0, 0, 0, 0, 0, 0];
  for (let d = from; d <= to; d++) looked[weekdayOf(d)]++;
  const has = new Map(routes.map((r) => [r, Object.fromEntries(cabins.map((c) => [c, new Set()]))]));
  for (const r of rows || []) {
    const per = has.get(routeId(r.origin, r.destination));
    if (!per || !isoDay(r.date) || !r.source || !/^[a-z_]{2,30}$/.test(r.source)) continue;
    const d = dayNum(r.date);
    if (d < from || d > to) continue;
    for (const c of cabins) if (r.cabins?.[c]?.available && r.cabins[c].miles) per[c].add(d);
  }
  for (const [route, per] of has) {
    const o = {};
    for (const c of cabins) {
      const n = [0, 0, 0, 0, 0, 0, 0];
      for (const d of per[c]) n[weekdayOf(d)]++;
      o[c] = [n, [...looked], to - from + 1];
    }
    out.set(route, o);
  }
  return out;
}

// Put today's summary into a stored route record and trim it to the last `days` days and `maxBytes`.
// Record: { obs: [day, …] (days looked at), r: { "source.cabin": [[day, n, miles, seats], …] } }.
// Two looks on the same day merge (more dates, lower miles, more seats win).
// `wk` (from summarizeWeekdays) adds to w: { cabin: [[week, has[7], looked[7], span], …] }: each look's weekday counts
// summed per calendar week, so the rate is over every look in the period. Records from before w existed simply lack it.
function mergeDay(rec, day, per, { days = 120, maxBytes = 12000, maxSeries = 30, wk = null } = {}) {
  const out = { obs: [...new Set([...(rec?.obs || []), day])].sort((a, b) => a - b), r: { ...(rec?.r || {}) } };
  if (rec?.w || (wk && Object.keys(wk).length)) out.w = { ...(rec?.w || {}) };
  const week = weekOf(day);
  for (const [c, [has, looked, span]] of Object.entries(wk || {})) {
    const list = [...(out.w[c] || [])];
    const i = list.findIndex((e) => e[0] === week);
    if (i >= 0) list[i] = [week, list[i][1].map((x, j) => x + has[j]), list[i][2].map((x, j) => x + looked[j]), Math.max(list[i][3], span)];
    else list.push([week, has, looked, span]);
    out.w[c] = list.sort((a, b) => a[0] - b[0]);
  }
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
    for (const c of Object.keys(out.w || {})) {
      out.w[c] = out.w[c].filter((e) => weekStart(e[0]) + 6 >= from);
      if (!out.w[c].length) delete out.w[c];
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
  // `hasMore`: the search stopped at its page limit (cheapest rows first), so a date or route missing from the rows
  // may well have space. Only the rows seen are kept then: no weekday counts and no "looked, nothing there" routes.
  async function note(params, rows, { hasMore = false } = {}) {
    if (!enabled) return 0;
    try {
      const per = summarize(params, rows);
      if (hasMore) for (const [route, s] of per) if (!s.size) per.delete(route);
      if (!per.size) return 0;
      const day = dayNum(todayTW(now()));
      const wk = hasMore ? new Map() : summarizeWeekdays(params, rows, { today: day });
      const index = (await kv.get(INDEX).catch(() => null)) || {};
      for (const [route, s] of per) {
        const rec = await kv.get(PREFIX + route).catch(() => null);
        await kv.set(PREFIX + route, mergeDay(rec, day, s, { days, maxBytes, wk: wk.get(route) }), { ex: ttl });
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
    // Per cabin, summed over the period: has[7] / looked[7] (Monday first), the widest date range one look covered
    // (`span`) and the first day the counts include (`since`).
    const weekdays = {};
    for (const [c, list] of Object.entries(rec.w || {})) {
      const pts = list.filter((e) => weekStart(e[0]) + 6 >= from);
      if (!pts.length) continue;
      const has = [0, 0, 0, 0, 0, 0, 0];
      const looked = [0, 0, 0, 0, 0, 0, 0];
      for (const e of pts) for (let j = 0; j < 7; j++) { has[j] += e[1][j] || 0; looked[j] += e[2][j] || 0; }
      weekdays[c] = { has, looked, span: Math.max(...pts.map((e) => e[3] || 0)), since: isoOf(Math.max(weekStart(pts[0][0]), from, obs[0] ?? from)) };
    }
    return { origin, destination, observed: obs.map(isoOf), series, ...(Object.keys(weekdays).length ? { weekdays } : {}) };
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
  const w = {};
  // Weekday leanings (Monday first) for the made-up weekday counts: a 60-day range looked at each run.
  const lean = { J: [0.3, 0.5, 0.55, 0.35, 0.25, 0.15, 0.3], Y: [0.6, 0.75, 0.8, 0.65, 0.5, 0.4, 0.55] };
  for (let d = today - days + 1; d <= today; d++) {
    if (rnd() < 0.08) continue; // a missed daily run
    obs.push(d);
    for (const [c, p] of Object.entries(lean)) {
      const has = [0, 0, 0, 0, 0, 0, 0];
      const looked = [0, 0, 0, 0, 0, 0, 0];
      for (let x = d + 1; x <= d + 60; x++) { looked[weekdayOf(x)]++; if (rnd() < p[weekdayOf(x)]) has[weekdayOf(x)]++; }
      const list = (w[c] ||= []);
      const e = list.at(-1)?.[0] === weekOf(d) ? list.at(-1) : (list.push([weekOf(d), [0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0], 60]), list.at(-1));
      for (let j = 0; j < 7; j++) { e[1][j] += has[j]; e[2][j] += looked[j]; }
    }
    for (const [src, cab, base] of progs) {
      const p = cab === 'Y' ? 0.75 : src === 'alaska' ? 0.2 : 0.45;
      if (rnd() > p) continue;
      (r[`${src}.${cab}`] ||= []).push([d, 1 + Math.floor(rnd() * (cab === 'Y' ? 20 : 6)), base + Math.floor(rnd() * 3) * 5000, 1 + Math.floor(rnd() * 4)]);
    }
  }
  return { obs, r, w };
}

module.exports = { createHistory, summarize, summarizeWeekdays, mergeDay, mockHistory, dayNum, isoOf, weekdayOf };
