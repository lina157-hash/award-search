// Daily deals: twice a day (the 00:10 and 13:10 UTC cron runs, about 08:10 and 21:10 Taipei), look up the cheapest premium-cabin award seats from Taipei to a few popular regions
// (one seats.aero cached search per region and cabin, sorted cheapest first) and keep the best few per region.
const { todayTW, addDays } = require('./day');

const GROUPS = [
  { id: 'na', name: '北美', destinations: 'YVR,YYZ,SFO,LAX,SEA,JFK,ORD,IAH,DFW,EWR' },
  { id: 'eu', name: '歐洲', destinations: 'LHR,CDG,AMS,FRA,MUC,VIE,ZRH,IST,MXP,PRG' },
  { id: 'jk', name: '日韓', destinations: 'NRT,HND,KIX,NGO,FUK,CTS,OKA,ICN' },
  { id: 'sea', name: '東南亞', destinations: 'SIN,BKK,KUL,SGN,HAN,MNL,CGK,DPS' },
  { id: 'oc', name: '澳紐', destinations: 'SYD,MEL,BNE,AKL' },
];
const ORIGIN = 'TPE';
// Business for every region; first class only where it is commonly flown from Taipei.
const PLAN = [...GROUPS.map((g) => ({ g, cabin: 'J' })), ...GROUPS.filter((g) => ['na', 'eu', 'jk'].includes(g.id)).map((g) => ({ g, cabin: 'F' }))];
const CABIN_API = { J: 'business', F: 'first' };
const PER_GROUP = 6;
const MAX_AGE_MS = 14 * 3600e3; // older than this (a missed cron run; runs are ~12 h apart): refresh in the background
const RETRY_MS = 2 * 3600e3; // at most one background retry this often, across instances
// A group fetched this recently is left alone by the second cron run the same morning. Kept short: a 20-hour window let
// one afternoon refresh (a visitor-triggered retry) make both morning runs skip, so the deals were a day late.
const FRESH_MS = 6 * 3600e3;
const STALE_MS = 8 * 864e5; // start is tomorrow, so 8 days = a week before today
const groupKey = (g) => `${g.id}:${g.cabin}`;
// Cheapest seat per destination (the earlier day on a tie), then the cheapest destinations first. Also 哪裡都好
// (lib/anywhere.js), over the same regions.
function bestByDestination(rows, cabin, start, { maxAge = 0 } = {}) {
  const best = new Map();
  for (const r of rows) {
    const c = r.cabins[cabin];
    if (!c || !c.available || !c.miles || r.date < start) continue;
    // 今日好康 only (maxAge): a seat seats.aero last saw more than a week ago is likely gone, not a deal of the day.
    if (maxAge && r.updatedAt && Date.parse(start) - Date.parse(r.updatedAt) > maxAge) continue;
    const cur = best.get(r.destination);
    if (!cur || c.miles < cur.miles || (c.miles === cur.miles && r.date < cur.date)) {
      best.set(r.destination, { id: r.id, date: r.date, origin: r.origin, destination: r.destination, source: r.source, miles: c.miles, seats: c.seats, airlines: c.airlines, direct: c.direct, taxes: c.taxes || null, updatedAt: r.updatedAt });
    }
  }
  return [...best.values()].sort((a, b) => a.miles - b.miles);
}

// `search(params)` returns normalized availability rows (see lib/seats.js normalizeAvailability).
// `lock(name, seconds)` (Redis SET NX) resolves to a release function, or null when another instance holds it.
// `defer(promise)` keeps a background refresh alive after the response (Vercel's waitUntil). `days`: how far ahead.
// `onFetched(groups)` (optional, lib/dealrules.js): after a refresh, every row each fetched group's search returned
// ([{ id, name, cabin, start, rows }]), for matching the owner's rules without another search.
function createDeals({ store, search, now = () => Date.now(), lock = async () => () => {}, defer = (p) => p.catch(() => {}), days = 330, onFetched = null }) {
  let memo = null;
  let memoAt = 0;

  // `fresh`: ask seats.aero now, not a recent answer kept in memory. A group is stamped with when its rows were
  // fetched (`rows.fetchedAt`, when the search says), not when it was assembled.
  async function fetchGroup({ g, cabin }, start, end, { fresh = false, got = null } = {}) {
    const rows = await search({ origin_airport: ORIGIN, destination_airport: g.destinations, start_date: start, end_date: end, cabins: CABIN_API[cabin], order_by: 'lowest_mileage', take: cabin === 'F' ? 1000 : 500 }, { fresh }); // first class is rare from Taipei, so look further down the list
    got?.push({ id: g.id, name: g.name, cabin, start, rows });
    return { id: g.id, name: g.name, cabin, at: new Date(rows.fetchedAt || now()).toISOString(), items: bestByDestination(rows, cabin, start, { maxAge: STALE_MS }).slice(0, PER_GROUP) };
  }

  const snapshot = (groups) => ({ generatedAt: new Date(now()).toISOString(), origin: ORIGIN, groups: groups.map((x) => ({ ...x })) });
  async function keep(d) {
    memo = d;
    memoAt = now();
    if (store) await store.save(d).catch((e) => console.error('deals save', e.message));
  }

  // Re-fetch the groups. A group that fails keeps its last good items (marked stale), each finished group is saved
  // right away (a run cut off by the time limit keeps what it did), and nothing is saved when every group failed.
  // `skipFresh`: leave groups fetched in the last 6 hours alone. `retry` (the background retry): only groups that
  // failed or are older than MAX_AGE_MS. `deadline`: start no new group after it.
  // One refresh at a time across instances (the cron and a visitor-triggered retry would otherwise both spend calls).
  // `fresh`: see fetchGroup. The answer says how many groups were `refreshed` and how many `failedGroups`.
  async function refresh(opts = {}) {
    const release = await lock('deals:refresh', 120);
    if (!release) {
      const saved = await latest();
      return { ...(saved || snapshot([])), busy: true, refreshed: 0 };
    }
    try { return await refreshNow(opts); } finally { await release(); }
  }
  // The saved copy, which another instance may have written since this one's memo; the memo when the store fails.
  async function latest() {
    const saved = store ? await store.load().catch(() => undefined) : undefined;
    if (saved && Array.isArray(saved.groups)) { memo = saved; memoAt = now(); return saved; }
    return saved === undefined && memo ? memo : null;
  }
  async function refreshNow({ deadline = Infinity, skipFresh = false, retry = false, fresh = false } = {}) {
    const prev = await latest();
    const old = new Map((prev?.groups || []).map((x) => [groupKey(x), x]));
    const today = todayTW(now());
    const start = addDays(today, 1);
    const end = addDays(today, days);
    const groups = PLAN.map(({ g, cabin }) => old.get(groupKey({ id: g.id, cabin })) || { id: g.id, name: g.name, cabin, items: [] });
    let ok = 0;
    let failed = 0;
    const got = [];
    for (const [i, p] of PLAN.entries()) {
      const cur = groups[i];
      if (skipFresh && !cur.error && cur.at && now() - Date.parse(cur.at) < FRESH_MS) continue;
      if (retry && !cur.error && cur.at && now() - Date.parse(cur.at) < MAX_AGE_MS) continue;
      if (now() > deadline) break;
      try {
        groups[i] = await fetchGroup(p, start, end, { fresh, got });
        ok++;
        await keep(snapshot(groups));
      } catch (err) {
        console.error('deals', p.g.id, p.cabin, err.message);
        const { at, ...rest } = cur;
        groups[i] = { ...rest, ...(at ? { at } : {}), error: String(err.message || err).slice(0, 120), ...(cur.items.length ? { stale: true } : {}) };
        failed++;
      }
    }
    if (onFetched && got.length) await Promise.resolve().then(() => onFetched(got)).catch((e) => console.error('deals onFetched', e.message));
    if (failed && !ok) {
      // Every group failed (quota used up, seats.aero down): keep serving the old copy unchanged.
      return { ...(prev || snapshot([])), groups: groups.map((x) => ({ ...x })), failed: true, refreshed: 0, failedGroups: failed };
    }
    if (failed) await keep({ ...memo, groups: groups.map((x) => ({ ...x })) });
    return { ...(ok || failed ? memo : prev || snapshot(groups)), refreshed: ok, failedGroups: failed };
  }

  // A retry in the background, at most every two hours across instances; visitors never wait for it. A page view
  // starts it, so it spends seats.aero calls only on what needs them: the failed groups and any past MAX_AGE_MS.
  async function retryLater() {
    if (!(await lock('deals:retry', RETRY_MS / 1000))) return;
    defer(refresh({ retry: true }));
  }

  // Latest saved deals, served as they are, however old. Only when nothing was ever saved are they built while the
  // visitor waits; an old or partly failed copy is refreshed in the background. When the store cannot be read, this
  // instance's copy is served however old (and the store is asked again in 10 minutes) instead of being rebuilt.
  // `atLeast` (an ISO time, from the page after a manual refresh): a copy older than that is read again from the
  // store, at most every 30 seconds per instance.
  let forcedAt = 0;
  async function get({ atLeast } = {}) {
    let d = memo && now() - memoAt < 10 * 60e3 ? memo : null;
    if (d && atLeast && String(d.generatedAt || '') < atLeast && now() - forcedAt > 30e3) { forcedAt = now(); d = null; }
    if (!d) {
      const saved = store ? await store.load().catch(() => undefined) : null;
      if (saved && Array.isArray(saved.groups)) { memo = saved; memoAt = now(); d = saved; }
      else if (saved === undefined && memo) { memoAt = now(); d = memo; }
    }
    if (!d) {
      const release = await lock('deals:build', 120);
      if (!release) return { generatedAt: null, origin: ORIGIN, groups: [], building: true };
      try { return await refresh(); } finally { await release(); }
    }
    if (now() - Date.parse(d.generatedAt) > MAX_AGE_MS || d.groups.some((x) => x.error)) await retryLater().catch(() => {});
    return d;
  }

  return { get, refresh, plan: PLAN.length };
}

module.exports = { createDeals, GROUPS, bestByDestination };
