// Daily deals: once a day, look up the cheapest premium-cabin award seats from Taipei to a few popular regions
// (one seats.aero cached search per region and cabin, sorted cheapest first) and keep the best few per region.
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
const MAX_AGE_MS = 30 * 3600e3;

const iso = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);

// `search(params)` returns normalized availability rows (see lib/seats.js normalizeAvailability).
function createDeals({ store, search, now = () => Date.now() }) {
  let memo = null;

  async function build() {
    const start = iso(1);
    const end = iso(330);
    const groups = [];
    for (const { g, cabin } of PLAN) {
      let rows = [];
      try {
        rows = await search({ origin_airport: ORIGIN, destination_airport: g.destinations, start_date: start, end_date: end, cabins: CABIN_API[cabin], order_by: 'lowest_mileage', take: cabin === 'F' ? 1000 : 500 }); // first class is rare from Taipei, so look further down the list
      } catch (err) {
        groups.push({ id: g.id, name: g.name, cabin, items: [], error: String(err.message || err).slice(0, 120) });
        continue;
      }
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
      groups.push({ id: g.id, name: g.name, cabin, items: [...best.values()].sort((a, b) => a.miles - b.miles).slice(0, PER_GROUP) });
    }
    return { generatedAt: new Date(now()).toISOString(), origin: ORIGIN, groups };
  }

  async function refresh() {
    const deals = await build();
    memo = deals;
    if (store) await store.save(deals);
    return deals;
  }

  // Latest saved deals; builds them once if nothing is saved yet (or the saved copy is very old).
  async function get() {
    if (memo && now() - Date.parse(memo.generatedAt) < MAX_AGE_MS) return memo;
    const saved = store ? await store.load().catch(() => null) : null;
    if (saved && saved.generatedAt && now() - Date.parse(saved.generatedAt) < MAX_AGE_MS) {
      memo = saved;
      return saved;
    }
    return refresh();
  }

  return { get, refresh, plan: PLAN.length };
}

module.exports = { createDeals, GROUPS };
