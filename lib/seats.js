// seats.aero Partner API client. Docs: https://developers.seats.aero/
const BASE = 'https://seats.aero/partnerapi';
const CABINS = ['Y', 'W', 'J', 'F'];

class SeatsAeroError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function createClient({ apiKey, fetchImpl = fetch, onCall = () => {} }) {
  async function request(path, params = {}) {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    onCall(path);
    const res = await fetchImpl(url, {
      headers: { 'Partner-Authorization': apiKey, accept: 'application/json' },
    });
    if (res.status === 429) throw new SeatsAeroError('seats.aero 今日查詢額度已用完', 429);
    if (res.status === 401 || res.status === 403) throw new SeatsAeroError('seats.aero API 金鑰無效或沒有權限', res.status);
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      throw new SeatsAeroError(`seats.aero 回應錯誤 (${res.status})${detail ? `：${detail}` : ''}`, 502);
    }
    return res.json();
  }

  return {
    // Cached Search: follows the cursor up to maxPages and dedupes by ID.
    async search(params, { maxPages = 2 } = {}) {
      const seen = new Map();
      let cursor;
      let skip = 0;
      for (let page = 0; page < maxPages; page++) {
        const body = await request('/search', { ...params, take: 500, cursor, skip: skip || undefined });
        for (const item of body.data || []) seen.set(item.ID, item);
        skip += (body.data || []).length;
        cursor = body.cursor;
        if (!body.hasMore) break;
      }
      return [...seen.values()];
    },
    async availability(params) {
      const body = await request('/availability', { take: 500, ...params });
      return body.data || [];
    },
    async trips(id) {
      return request(`/trips/${encodeURIComponent(id)}`);
    },
  };
}

// Flatten an Availability object into the shape the frontend uses.
function normalizeAvailability(a) {
  const route = a.Route || {};
  const cabins = {};
  for (const c of CABINS) {
    cabins[c] = {
      available: Boolean(a[`${c}Available`]),
      miles: Number(a[`${c}MileageCost`]) || null,
      seats: a[`${c}RemainingSeats`] ?? null,
      airlines: a[`${c}Airlines`] || '',
      direct: Boolean(a[`${c}Direct`]),
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
      segments: (t.AvailabilitySegments || [])
        .sort((x, y) => x.Order - y.Order)
        .map((s) => ({
          flight: s.FlightNumber,
          from: s.OriginAirport,
          to: s.DestinationAirport,
          departsAt: s.DepartsAt,
          arrivesAt: s.ArrivesAt,
          aircraft: s.AircraftName,
          fareClass: s.FareClass,
        })),
    })),
  };
}

module.exports = { createClient, normalizeAvailability, normalizeTrips, SeatsAeroError, CABINS };
