// Daily deals: once a day, look up the cheapest premium-cabin award seats from Taipei to a few popular regions
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
const MAX_AGE_MS = 30 * 3600e3; // older than this (a missed cron run): refresh in the background
const RETRY_MS = 2 * 3600e3; // at most one background retry this often, across instances
const FRESH_MS = 20 * 3600e3; // a group fetched this recently is left alone by a second run the same day
const groupKey = (g) => `${g.id}:${g.cabin}`;

// `search(params)` returns normalized availability rows (see lib/seats.js normalizeAvailability).
// `lock(name, seconds)` (Redis SET NX) resolves to a release function, or null when another instance holds it.
// `defer(promise)` keeps a background refresh alive after the response (Vercel's waitUntil). `days`: how far ahead.
function createDeals({ store, search, now = () => Date.now(), lock = async () => () => {}, defer = (p) => p.catch(() => {}), days = 330 }) {
  let memo = null;
  let memoAt = 0;

  async function fetchGroup({ g, cabin }, start, end) {
    const rows = await search({ origin_airport: ORIGIN, destination_airport: g.destinations, start_date: start, end_date: end, cabins: CABIN_API[cabin], order_by: 'lowest_mileage', take: cabin === 'F' ? 1000 : 500 }); // first class is rare from Taipei, so look further down the list
    // Cheapest seat per destination, then the cheapest destinations first.
    const best = new Map();
    for (const r of rows) {
      const c = r.cabins[cabin];
      if (!c || !c.available || !c.miles || r.date < start) continue;
      const cur = best.get(r.destination);
      if (!cur || c.miles < cur.miles || (c.miles === cur.miles && r.date < cur.date)) {
        best.set(r.destination, { id: r.id, date: r.date, origin: r.origin, destination: r.destination, source: r.source, miles: c.miles, seats: c.seats, airlines: c.airlines, direct: c.direct, taxes: c.taxes || null, updatedAt: r.updatedAt });
      }
    }
    return { id: g.id, name: g.name, cabin, at: new Date(now()).toISOString(), items: [...best.values()].sort((a, b) => a.miles - b.miles).slice(0, PER_GROUP) };
  }

  const snapshot = (groups) => ({ generatedAt: new Date(now()).toISOString(), origin: ORIGIN, groups: groups.map((x) => ({ ...x })) });
  async function keep(d) {
    memo = d;
    memoAt = now();
    if (store) await store.save(d).catch((e) => console.error('deals save', e.message));
  }

  // Re-fetch the groups. A group that fails keeps its last good items (marked stale), each finished group is saved
  // right away (a run cut off by the time limit keeps what it did), and nothing is saved when every group failed.
  // `skipFresh`: leave groups fetched in the last 20 hours alone. `deadline`: start no new group after it.
  async function refresh({ deadline = Infinity, skipFresh = false } = {}) {
    const saved = memo || (store ? await store.load().catch(() => null) : null);
    const prev = saved && Array.isArray(saved.groups) ? saved : null;
    const old = new Map((prev?.groups || []).map((x) => [groupKey(x), x]));
    const today = todayTW(now());
    const start = addDays(today, 1);
    const end = addDays(today, days);
    const groups = PLAN.map(({ g, cabin }) => old.get(groupKey({ id: g.id, cabin })) || { id: g.id, name: g.name, cabin, items: [] });
    let ok = 0;
    let failed = 0;
    for (const [i, p] of PLAN.entries()) {
      const cur = groups[i];
      if (skipFresh && !cur.error && cur.at && now() - Date.parse(cur.at) < FRESH_MS) continue;
      if (now() > deadline) break;
      try {
        groups[i] = await fetchGroup(p, start, end);
        ok++;
        await keep(snapshot(groups));
      } catch (err) {
        console.error('deals', p.g.id, p.cabin, err.message);
        const { at, ...rest } = cur;
        groups[i] = { ...rest, ...(at ? { at } : {}), error: String(err.message || err).slice(0, 120), ...(cur.items.length ? { stale: true } : {}) };
        failed++;
      }
    }
    if (failed && !ok) {
      // Every group failed (quota used up, seats.aero down): keep serving the old copy unchanged.
      return { ...(prev || snapshot([])), groups: groups.map((x) => ({ ...x })), failed: true };
    }
    if (failed) await keep({ ...memo, groups: groups.map((x) => ({ ...x })) });
    return ok || failed ? memo : prev || snapshot(groups);
  }

  // A retry in the background, at most every two hours across instances; visitors never wait for it.
  async function retryLater() {
    if (!(await lock('deals:retry', RETRY_MS / 1000))) return;
    defer(refresh({ skipFresh: true }));
  }

  // Latest saved deals, served as they are, however old. Only when nothing was ever saved are they built while the
  // visitor waits; an old or partly failed copy is refreshed in the background.
  async function get() {
    let d = memo && now() - memoAt < 10 * 60e3 ? memo : null;
    if (!d) {
      const saved = store ? await store.load().catch(() => null) : null;
      if (saved && Array.isArray(saved.groups)) { memo = saved; memoAt = now(); d = saved; }
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

module.exports = { createDeals, GROUPS };
