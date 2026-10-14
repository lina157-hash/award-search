// Cash fares from DataCrawler's "Google Flights" API on RapidAPI (google-flights2), the same Google Flights data as SerpApi.
// Unofficial scraper: slower (5–12 s) and it can break, so SerpApi stays as the fallback. Free plan: 150 requests a month.
// Responses are reshaped into SerpApi's google_flights format so lib/cash.js normalizes both the same way.
// Tokens it hands out are prefixed with "r:" so follow-up calls (return flights, booking options) come back here.
const { CashError } = require('./cash');

const HOST = 'google-flights2.p.rapidapi.com';
const BASE = `https://${HOST}/api/v1`;
const TRAVEL_CLASS = { 1: 'ECONOMY', 2: 'PREMIUM_ECONOMY', 3: 'BUSINESS', 4: 'FIRST' };
const CLASS_ZH = { 1: '經濟艙', 2: '豪華經濟艙', 3: '商務艙', 4: '頭等艙' };
const TOKEN_PREFIX = 'r:';
const isRapidToken = (t) => typeof t === 'string' && t.startsWith(TOKEN_PREFIX);

// `kv` (optional, lib/kv.js) remembers across instances that the calendar endpoint rejects round trips.
function createRapidFlights({ apiKey, fetchImpl = fetch, timeoutMs = 25000, onQuota = () => {}, onCall = () => {}, kv = null }) {
  async function get(path, params) {
    const url = new URL(`${BASE}/${path}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    onCall();
    let res;
    try {
      res = await fetchImpl(url, { headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': HOST, accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new CashError(e.name === 'TimeoutError' ? 'RapidAPI 查價逾時' : 'RapidAPI 連線失敗', 504);
    }
    // A missing header is "unknown", not 0: Number(null) would read as "nothing left".
    const rawLeft = res.headers.get('x-ratelimit-requests-remaining');
    const rawLimit = res.headers.get('x-ratelimit-requests-limit');
    const left = rawLeft == null || rawLeft === '' ? null : Number(rawLeft);
    const limit = rawLimit == null || rawLimit === '' || !Number.isFinite(Number(rawLimit)) ? null : Number(rawLimit);
    if (left != null && Number.isFinite(left)) onQuota({ left, limit });
    const body = await res.json().catch(() => ({}));
    const msg = String(body.message || '');
    if (res.status === 429) {
      // Only the monthly quota is "used up"; a per-second rate limit without quota headers is just "too fast".
      if (/quota/i.test(msg) || left === 0) {
        if (left !== 0) onQuota({ left: 0, limit });
        throw Object.assign(new CashError('RapidAPI 這個月的免費額度已用完', 429), { quota: true });
      }
      throw new CashError('RapidAPI 查詢太頻繁，請稍後再試', 429);
    }
    if (res.status === 401 || res.status === 403) throw new CashError(/not subscribed/i.test(msg) ? 'RapidAPI 金鑰還沒訂閱 Google Flights API' : 'RapidAPI 金鑰無效', res.status);
    if (!res.ok) { console.error('rapidapi', path, res.status, msg.slice(0, 200)); throw new CashError(`RapidAPI 回應錯誤 (${res.status})`, 502); }
    // Scrape failures come back as 200 with status false; the upstream wording stays in the server log.
    if (body.status === false) { console.error('rapidapi', path, 'status false', msg.slice(0, 200)); throw new CashError('RapidAPI 這次沒查到，請稍後再試', 502); }
    return body;
  }
  const locale = { currency: 'TWD', language_code: 'en-US', country_code: 'TW' };

  // Same parameter names as the SerpApi call; returns a SerpApi-shaped body.
  async function query(p) {
    if (p.booking_token) {
      const body = await get('getBookingDetails', { booking_token: p.booking_token.slice(TOKEN_PREFIX.length), ...locale });
      return { booking_options: (Array.isArray(body.data) ? body.data : []).map(bookingOption).filter(Boolean), best_flights: [], other_flights: [] };
    }
    if (p.departure_token) {
      const body = await get('getNextFlights', { next_token: p.departure_token.slice(TOKEN_PREFIX.length), ...locale });
      return shape(body, p);
    }
    const body = await get('searchFlights', {
      departure_id: p.departure_id, arrival_id: p.arrival_id, outbound_date: p.outbound_date, return_date: p.return_date,
      travel_class: TRAVEL_CLASS[p.travel_class] || 'ECONOMY', adults: p.adults, search_type: 'best', show_hidden: 1, ...locale,
    });
    return shape(body, p);
  }
  // Lowest fare for each departure day between start and end (Google Flights' date grid), one request for up to about two months.
  // Round trips send trip_type/trip_days; some callers report that the endpoint rejects those, so that falls back to one-way prices.
  // A rejection is remembered for a week (here and in `kv`), so later grids go straight to one-way: 1 request, not 2.
  const ROUND_KEY = 'rapid:calendar-round-unsupported';
  let roundUnsupportedUntil = 0;
  async function roundUnsupported() {
    if (Date.now() < roundUnsupportedUntil) return true;
    if (kv && (await kv.get(ROUND_KEY).catch(() => null))) { roundUnsupportedUntil = Date.now() + 3600e3; return true; }
    return false;
  }
  query.calendar = async (p) => {
    const base = { departure_id: p.departure_id, arrival_id: p.arrival_id, start_date: p.start_date, end_date: p.end_date, travel_class: TRAVEL_CLASS[p.travel_class] || 'ECONOMY', adults: p.adults, currency: 'TWD', country_code: 'TW' };
    let round = Boolean(p.trip_days) && !(await roundUnsupported());
    let body;
    try {
      body = await get('getCalendarPicker', round ? { ...base, trip_type: 'ROUND', trip_days: p.trip_days } : base);
    } catch (e) {
      if (!round || e.quota || [401, 403, 429, 504].includes(e.status)) throw e;
      round = false;
      body = await get('getCalendarPicker', base);
      // One-way worked where the round trip did not: the endpoint does not take round trips.
      roundUnsupportedUntil = Date.now() + 7 * 864e5;
      if (kv) await kv.set(ROUND_KEY, true, { ex: 7 * 86400 }).catch(() => {});
    }
    const days = (Array.isArray(body.data) ? body.data : []).map((d) => ({ date: String(d.departure || d.date || '').slice(0, 10), price: Number.isFinite(d.price) ? d.price : null }))
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date) && d.price);
    return { round, days };
  };
  return query;
}

// "2026-2-15 23:05" → "2026-02-15 23:05", as SerpApi writes it.
const padTime = (t) => String(t || '').replace(/^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})/, (_, y, m, d, h, mi) => `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')} ${h.padStart(2, '0')}:${mi}`);
const minutes = (d) => (typeof d === 'number' ? d : d?.raw ?? null);
const carrierOf = (f) => String(f.flight_number || '').split(/\s+/)[0].toUpperCase();

function option(o, p) {
  const segments = o.flights || [];
  return {
    price: Number.isFinite(o.price) ? o.price : null,
    type: p.return_date ? '來回' : '單程',
    total_duration: minutes(o.duration),
    airline_logo: o.airline_logo || '',
    flights: segments.map((f) => ({
      departure_airport: { id: f.departure_airport?.airport_code, name: f.departure_airport?.airport_name, time: padTime(f.departure_airport?.time) },
      arrival_airport: { id: f.arrival_airport?.airport_code, name: f.arrival_airport?.airport_name, time: padTime(f.arrival_airport?.time) },
      duration: minutes(f.duration),
      airline: f.airline,
      airline_logo: f.airline_logo,
      flight_number: f.flight_number,
      airplane: f.aircraft,
      travel_class: CLASS_ZH[p.travel_class] || '',
      legroom: f.legroom,
      extensions: f.extensions || [],
    })),
    layovers: (o.layovers || []).map((l) => ({ id: l.airport_code, name: l.airport_name, duration: minutes(l.duration) })),
    carbon_emissions: o.carbon_emissions ? { this_flight: o.carbon_emissions.CO2e, typical_for_this_route: o.carbon_emissions.typical_for_this_route, difference_percent: o.carbon_emissions.difference_percent } : undefined,
    departure_token: o.next_token ? TOKEN_PREFIX + o.next_token : undefined,
    booking_token: o.booking_token ? TOKEN_PREFIX + o.booking_token : undefined,
  };
}

// SerpApi filters stops and alliances itself; this API has no such parameters, so filter here.
function keep(o, p, allianceCarriers) {
  const n = (o.flights || []).length - 1;
  if (p.stops === 1 && n > 0) return false;
  if (p.stops === 2 && n > 1) return false;
  if (allianceCarriers && !(o.flights || []).every((f) => allianceCarriers.has(carrierOf(f)))) return false;
  return true;
}

function shape(body, p) {
  const data = body.data || {};
  const it = data.itineraries ?? data;
  const top = Array.isArray(it) ? it : it.topFlights || [];
  const other = Array.isArray(it) ? [] : it.otherFlights || [];
  const alliance = p.allianceCarriers || null;
  const ph = data.priceHistory;
  const range = (list) => (list || []).map((x) => x.value).filter((v) => Number.isFinite(v));
  const typical = range(ph?.summary?.typical);
  const current = ph?.summary?.current;
  return {
    best_flights: top.filter((o) => keep(o, p, alliance)).map((o) => option(o, p)),
    other_flights: other.filter((o) => keep(o, p, alliance)).map((o) => option(o, p)),
    price_insights: ph?.summary ? {
      lowest_price: current,
      price_level: typical.length === 2 && Number.isFinite(current) ? (current < typical[0] ? 'low' : current > typical[1] ? 'high' : 'typical') : undefined,
      typical_price_range: typical.length === 2 ? typical : undefined,
      price_history: (ph.history || []).map((h) => [h.time / 1000, h.value]),
    } : undefined,
  };
}

// A seller; its booking link costs one more request, so the page asks for it only when the button is pressed.
function bookingOption(b) {
  if (!b || !b.partner) return null;
  return { together: { book_with: b.partner, price: Number.isFinite(b.price) ? b.price : null, link_token: b.token ? TOKEN_PREFIX + b.token : null, is_airline: Boolean(b.is_airline) } };
}

// The seller's booking page, from a seller token returned with the booking options.
async function bookingUrl({ apiKey, fetchImpl = fetch }, token) {
  const url = new URL(`${BASE}/getBookingURL`);
  url.searchParams.set('token', token.slice(TOKEN_PREFIX.length));
  const res = await fetchImpl(url, { headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': HOST }, signal: AbortSignal.timeout(25000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.status === false || typeof body.data !== 'string' || !/^https:\/\//.test(body.data)) throw new CashError('拿不到這個賣家的訂票連結，請改用 Google 航班連結', 502);
  return body.data;
}

module.exports = { createRapidFlights, bookingUrl, isRapidToken, padTime };
