// Cash fares from Google Flights via SerpApi's google_flights engine. Docs: https://serpapi.com/google-flights-api
// The key stays server-side (env SERPAPI_KEY); each uncached search uses one SerpApi credit.
const BASE = 'https://serpapi.com/search.json';

class CashError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function createCashClient({ apiKey, fetchImpl = fetch, onCall = () => {} }) {
  return async function query(params) {
    const url = new URL(BASE);
    for (const [k, v] of Object.entries({ engine: 'google_flights', hl: 'zh-TW', gl: 'tw', currency: 'TWD', ...params, api_key: apiKey })) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    onCall();
    const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) throw new CashError('現金票資料來源（SerpApi）金鑰無效', res.status);
    if (res.status === 429) throw new CashError('現金票查詢額度已用完，請稍後再試', 429);
    if (!res.ok) throw new CashError(`現金票資料來源回應錯誤 (${res.status})${body.error ? `：${String(body.error).slice(0, 200)}` : ''}`, 502);
    // "No results" comes back as 200 with an error message.
    if (body.error && !body.best_flights && !body.other_flights) return { ...body, best_flights: [], other_flights: [] };
    return body;
  };
}

const airport = (a = {}) => ({ code: a.id, name: a.name, time: a.time });

function normalizeOption(o, best) {
  return {
    best,
    price: o.price ?? null,
    type: o.type || '',
    totalDuration: o.total_duration,
    logo: o.airline_logo || o.flights?.[0]?.airline_logo || '',
    segments: (o.flights || []).map((f) => ({
      from: airport(f.departure_airport),
      to: airport(f.arrival_airport),
      duration: f.duration,
      airline: f.airline,
      logo: f.airline_logo,
      flightNumber: f.flight_number,
      airplane: f.airplane,
      travelClass: f.travel_class,
      legroom: f.legroom,
      overnight: Boolean(f.overnight),
      oftenDelayed: Boolean(f.often_delayed_by_over_30_min),
      extensions: f.extensions || [],
    })),
    layovers: (o.layovers || []).map((l) => ({ code: l.id, name: l.name, duration: l.duration, overnight: Boolean(l.overnight) })),
    emissions: o.carbon_emissions ? { thisFlight: o.carbon_emissions.this_flight, typical: o.carbon_emissions.typical_for_this_route, diffPct: o.carbon_emissions.difference_percent } : null,
    departureToken: o.departure_token || null,
  };
}

function normalizeCash(body) {
  const pi = body.price_insights;
  return {
    options: [...(body.best_flights || []).map((o) => normalizeOption(o, true)), ...(body.other_flights || []).map((o) => normalizeOption(o, false))],
    insights: pi ? { lowest: pi.lowest_price, level: pi.price_level, range: pi.typical_price_range || null, history: pi.price_history || [] } : null,
    googleUrl: body.search_metadata?.google_flights_url || '',
    message: body.error || '',
  };
}

module.exports = { createCashClient, normalizeCash, CashError };
