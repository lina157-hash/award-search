// 哪裡都好 (區域探索, the owner's only): every program's cheapest award seat to every destination of a few regions at
// once. seats.aero's cached search takes a comma-separated destination list and answers for all programs in one call,
// so it is one search per region, over the 今日好康 regions (lib/deals.js GROUPS): at most 2 pages (calls) each, never
// more than 10 calls a press. Each region's answer is the cheapest seat per destination, cheapest first.
const { GROUPS, bestByDestination } = require('./deals');

const MAX_CALLS = 10;
const MAX_PAGES = 2;
const CABIN_API = { Y: 'economy', W: 'premium', J: 'business', F: 'first' };
const REGIONS = GROUPS.map(({ id, name, destinations }) => ({ id, name, destinations: destinations.split(',') }));

// Region ids as asked (comma list) → known, distinct regions; throws on an unknown one.
function pickRegions(list) {
  const ids = [...new Set(String(list || '').split(',').map((s) => s.trim()).filter(Boolean))];
  const bad = ids.find((id) => !GROUPS.some((g) => g.id === id));
  if (bad || !ids.length) throw Object.assign(new Error(bad ? `沒有這個區域：${bad}` : '請至少選一個區域'), { status: 400 });
  return ids.map((id) => GROUPS.find((g) => g.id === id));
}
// Pages each region's search may follow so all of them together stay within MAX_CALLS.
const pagesPer = (n) => Math.max(1, Math.min(MAX_PAGES, Math.floor(MAX_CALLS / Math.max(1, n))));

// `search(params, { maxPages })` → { rows (normalized availability), hasMore, calls (seats.aero calls this time; 0 from
// the cache) }. A region that fails says so and the others still come back.
function createAnywhere({ search }) {
  async function run({ origins = ['TPE'], start, end, cabin = 'J', regions }) {
    const groups = pickRegions(Array.isArray(regions) ? regions.join(',') : regions);
    const pages = pagesPer(groups.length);
    // Trip details carry the taxes; asked for short ranges only, as the route search does (a bigger answer).
    const withTaxes = (Date.parse(end) - Date.parse(start)) / 864e5 <= 45;
    const out = await Promise.all(groups.map(async (g) => {
      const params = { origin_airport: origins.join(','), destination_airport: g.destinations, start_date: start, end_date: end, cabins: CABIN_API[cabin], order_by: 'lowest_mileage', take: 1000, ...(withTaxes ? { include_trips: true } : {}) };
      try {
        const r = await search(params, { maxPages: pages });
        return { id: g.id, name: g.name, items: bestByDestination(r.rows || [], cabin, start), truncated: Boolean(r.hasMore), calls: r.calls || 0 };
      } catch (e) {
        return { id: g.id, name: g.name, items: [], error: String(e.message || e).slice(0, 120), calls: e.calls || 0 };
      }
    }));
    return { origins, start, end, cabin, withTaxes, maxCalls: groups.length * pages, calls: out.reduce((n, r) => n + r.calls, 0), regions: out };
  }
  return { run };
}

module.exports = { createAnywhere, pickRegions, pagesPer, REGIONS, MAX_CALLS, MAX_PAGES };
