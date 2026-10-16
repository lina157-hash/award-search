// seats.aero Partner API client. Docs: https://developers.seats.aero/
const BASE = 'https://seats.aero/partnerapi';
const CABINS = ['Y', 'W', 'J', 'F'];

class SeatsAeroError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function createClient({ apiKey, fetchImpl = fetch, onCall = () => {}, timeoutMs = 20000 }) {
  // `until` (optional): the time by which the answer must be in. The call's timeout shrinks to fit, and a call that
  // would get less than a second is not made at all (it fails as a timeout and costs nothing).
  async function request(path, params = {}, { until } = {}) {
    const ms = until ? Math.min(timeoutMs, until - Date.now()) : timeoutMs;
    if (!(ms >= 1000)) throw new SeatsAeroError('seats.aero 回應逾時，請稍後再試或縮短日期範圍', 504);
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    onCall(path);
    let res;
    try {
      res = await fetchImpl(url, { headers: { 'Partner-Authorization': apiKey, accept: 'application/json' }, signal: AbortSignal.timeout(ms) });
    } catch (e) {
      throw new SeatsAeroError(e.name === 'TimeoutError' ? 'seats.aero 回應逾時，請稍後再試或縮短日期範圍' : 'seats.aero 連線失敗', 504);
    }
    if (res.status === 429) throw new SeatsAeroError('seats.aero 今日查詢額度已用完', 429);
    if (res.status === 401 || res.status === 403) throw new SeatsAeroError('seats.aero API 金鑰無效或沒有權限', res.status);
    if (!res.ok) {
      // The upstream body stays in the server log; the browser only gets the status.
      console.error('seats.aero', path, res.status, (await res.text().catch(() => '')).slice(0, 300));
      throw Object.assign(new SeatsAeroError(`seats.aero 回應錯誤 (${res.status})`, 502), { upstream: res.status });
    }
    return res.json();
  }

  return {
    // Cached Search: follows the cursor up to maxPages and dedupes by ID. `until`: see request().
    async search(params, { maxPages = 2, until } = {}) {
      const seen = new Map();
      let cursor;
      let skip = 0;
      let hasMore = false;
      for (let page = 0; page < maxPages; page++) {
        const body = await request('/search', { ...params, take: params.take || 1000, cursor, skip: skip || undefined }, { until });
        for (const item of body.data || []) seen.set(item.ID, item);
        skip += (body.data || []).length;
        cursor = body.cursor;
        hasMore = Boolean(body.hasMore);
        if (!hasMore) break;
      }
      return { items: [...seen.values()], hasMore };
    },
    // Bulk Availability: follows the cursor so explore isn't capped at one page.
    async availability(params, { maxPages = 5 } = {}) {
      const seen = new Map();
      let cursor;
      let skip = 0;
      let hasMore = false;
      for (let page = 0; page < maxPages; page++) {
        const body = await request('/availability', { ...params, take: 1000, cursor, skip: skip || undefined });
        for (const item of body.data || []) seen.set(item.ID, item);
        skip += (body.data || []).length;
        cursor = body.cursor;
        hasMore = Boolean(body.hasMore);
        if (!hasMore) break;
      }
      return { items: [...seen.values()], hasMore };
    },
    // `params`: e.g. { min_cabin_pct: 50 } to include itineraries flown partly in a lower cabin.
    async trips(id, params = {}) {
      return request(`/trips/${encodeURIComponent(id)}`, params);
    },
  };
}

const CABIN_CODE = { economy: 'Y', premium: 'W', business: 'J', first: 'F' };

// Lowest taxes per cabin from the trips included with `include_trips=true` (amounts are in cents).
function taxesByCabin(trips) {
  const out = {};
  for (const t of trips || []) {
    const c = CABIN_CODE[t.Cabin];
    if (!c || t.TotalTaxes == null) continue;
    const amount = Number(t.TotalTaxes) / 100;
    if (!out[c] || amount < out[c].amount) out[c] = { amount, currency: t.TaxesCurrency || '', symbol: t.TaxesCurrencySymbol || '' };
  }
  return out;
}

// Flatten an Availability object into the shape the frontend uses.
// Operating carrier + aircraft type pairs per cabin (e.g. "BR:77W"), from the trips included with `include_trips=true`.
// Lets the browser filter for a specific premium product without fetching every trip.
function fleetByCabin(trips) {
  const out = {};
  for (const t of trips || []) {
    const c = CABIN_CODE[t.Cabin];
    if (!c) continue;
    for (const s of t.AvailabilitySegments || []) {
      const carrier = String(s.FlightNumber || '').slice(0, 2).toUpperCase();
      const ac = String(s.AircraftCode || '').toUpperCase();
      if (!/^[A-Z0-9]{2}$/.test(carrier) || !/^[A-Z0-9]{2,4}$/.test(ac)) continue;
      (out[c] ||= new Set()).add(`${carrier}:${ac}`);
    }
  }
  return out;
}

function normalizeAvailability(a) {
  const route = a.Route || {};
  const taxes = taxesByCabin(a.AvailabilityTrips);
  const fleet = fleetByCabin(a.AvailabilityTrips);
  const cabins = {};
  for (const c of CABINS) {
    // A cabin with no seats is only { available: false }: about 40% of a long search, and nothing else is read from it.
    if (!a[`${c}Available`]) { cabins[c] = { available: false }; continue; }
    cabins[c] = {
      available: Boolean(a[`${c}Available`]),
      miles: Number(a[`${c}MileageCost`]) || null,
      seats: a[`${c}RemainingSeats`] ?? null,
      airlines: a[`${c}Airlines`] || '',
      direct: Boolean(a[`${c}Direct`]),
      taxes: taxes[c] || null,
      ...(fleet[c] ? { fleet: [...fleet[c]] } : {}),
    };
  }
  return {
    id: a.ID,
    date: a.Date,
    origin: route.OriginAirport,
    destination: route.DestinationAirport,
    distance: route.Distance ?? null,
    source: a.Source || route.Source,
    cabins,
    updatedAt: a.UpdatedAt,
  };
}

function normalizeTrips(body) {
  return {
    bookingLinks: body.booking_links || [],
    trips: (body.data || []).map((t) => ({
      id: t.ID,
      cabin: t.Cabin,
      miles: t.MileageCost,
      taxes: t.TotalTaxes,
      taxesCurrency: t.TaxesCurrency,
      taxesSymbol: t.TaxesCurrencySymbol,
      seats: t.RemainingSeats,
      stops: t.Stops,
      carriers: t.Carriers,
      flightNumbers: t.FlightNumbers,
      departsAt: t.DepartsAt,
      arrivesAt: t.ArrivesAt,
      durationMin: t.TotalDuration,
      source: t.Source,
      // Share of the distance flown below `cabin` (seats.aero gives it only for mixed-cabin itineraries, and no cabin
      // per segment, so which leg is lower is not known).
      ...(Number(t.MixedCabinPct) > 0 && Number(t.MixedCabinPct) < 100 ? { mixedPct: Math.round(Number(t.MixedCabinPct)) } : {}),
      segments: (t.AvailabilitySegments || [])
        .sort((x, y) => x.Order - y.Order)
        .map((s) => ({
          flight: s.FlightNumber,
          from: s.OriginAirport,
          to: s.DestinationAirport,
          departsAt: s.DepartsAt,
          arrivesAt: s.ArrivesAt,
          aircraft: s.AircraftName,
          aircraftCode: s.AircraftCode,
          fareClass: s.FareClass,
          distance: s.Distance,
        })),
    })),
  };
}

module.exports = { createClient, normalizeAvailability, normalizeTrips, SeatsAeroError, CABINS };
