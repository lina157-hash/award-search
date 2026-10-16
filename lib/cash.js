// Cash fares from Google Flights via SerpApi's google_flights engine. Docs: https://serpapi.com/google-flights-api
// The key stays server-side (env SERPAPI_KEY); each uncached search uses one SerpApi credit.
const BASE = 'https://serpapi.com/search.json';

class CashError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function createCashClient({ apiKey, fetchImpl = fetch, onCall = () => {}, timeoutMs = 25000 }) {
  return async function query(params) {
    const url = new URL(BASE);
    for (const [k, v] of Object.entries({ engine: 'google_flights', hl: 'zh-tw', gl: 'tw', currency: 'TWD', ...params, api_key: apiKey })) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    onCall();
    let res;
    try {
      res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new CashError(e.name === 'TimeoutError' ? '現金票資料來源（SerpApi）回應逾時' : '現金票資料來源（SerpApi）連線失敗', 504);
    }
    const body = await res.json().catch(() => ({}));
    // SerpApi's own wording stays in the server log; the browser gets a fixed message.
    if (!res.ok) console.error('serpapi flights', res.status, String(body.error || '').slice(0, 200));
    if (res.status === 401 || res.status === 403) throw new CashError('現金票資料來源（SerpApi）金鑰無效', res.status);
    if (res.status === 429) throw new CashError('現金票查詢額度已用完，請稍後再試', 429);
    if (!res.ok) throw new CashError(`現金票資料來源回應錯誤 (${res.status})`, 502);
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
    bookingToken: o.booking_token || null,
  };
}

// One way to book the chosen flights (Google's "booking options"): a seller, a price and either a form to submit or a phone number.
function bookingOption(b) {
  if (!b) return null;
  const req = b.booking_request && /^https:\/\//.test(b.booking_request.url || '') ? { url: b.booking_request.url, postData: b.booking_request.post_data || '' } : null;
  return {
    bookWith: b.book_with || '',
    title: b.option_title || '',
    marketedAs: b.marketed_as || [],
    price: b.price ?? null,
    baggage: b.baggage_prices || [],
    extensions: b.extensions || [],
    request: req,
    phone: b.booking_phone || '',
    phoneFee: b.estimated_phone_service_fee ?? null,
    // RapidAPI sellers: the booking page is fetched on demand with this token.
    linkToken: b.link_token || null,
    isAirline: Boolean(b.is_airline),
  };
}

function normalizeCash(body) {
  const pi = body.price_insights;
  return {
    options: [...(body.best_flights || []).map((o) => normalizeOption(o, true)), ...(body.other_flights || []).map((o) => normalizeOption(o, false))],
    insights: pi ? { lowest: pi.lowest_price, level: pi.price_level, range: pi.typical_price_range || null, history: pi.price_history || [] } : null,
    googleUrl: body.search_metadata?.google_flights_url || '',
    message: body.error || '',
    // Present only on a booking_token lookup.
    selected: (body.selected_flights || []).map((o) => normalizeOption(o, false)),
    // RapidAPI: what came back when no seller could be read (key names only), shown to the owner.
    bookingShape: body.booking_shape || '',
    bookingOptions: (body.booking_options || []).map((b) => (b.together
      ? { separate: false, ...bookingOption(b.together) }
      : { separate: true, departing: bookingOption(b.departing), returning: bookingOption(b.returning) })),
  };
}

module.exports = { createCashClient, normalizeCash, CashError };
