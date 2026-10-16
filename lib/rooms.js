// Hotel award (points) availability from rooms.aero, seats.aero's hotel site. Docs: https://developers.seats.aero/reference/rooms-getting-started
// The seats.aero Pro key works here too, with its own quota of 1,000 calls per UTC day; personal, non-commercial use only.
const BASE = 'https://rooms.aero/partnerapi';
// rooms.aero program keys this site shows, biggest chains first.
const PROGRAMS = ['marriott', 'hilton', 'ihg', 'hyatt', 'choice', 'wyndham', 'iprefer'];

class RoomsError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function createRoomsClient({ apiKey, fetchImpl = fetch, onCall = () => {}, timeoutMs = 20000 }) {
  // `until` (optional, the daily run's hotel watches): the time by which the answer must be in. The timeout shrinks to
  // fit, and a call that would get less than a second is not made at all (it fails as a timeout and costs nothing).
  async function get(path, params = {}, { until } = {}) {
    const ms = until ? Math.min(timeoutMs, until - Date.now()) : timeoutMs;
    if (!(ms >= 1000)) throw new RoomsError('飯店點數資料來源（rooms.aero）回應逾時，請稍後再試', 504);
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    onCall();
    let res;
    try {
      res = await fetchImpl(url, { headers: { 'Partner-Authorization': apiKey, accept: 'application/json' }, signal: AbortSignal.timeout(ms) });
    } catch (e) {
      throw new RoomsError(e.name === 'TimeoutError' ? '飯店點數資料來源（rooms.aero）回應逾時，請稍後再試' : '飯店點數資料來源（rooms.aero）連線失敗', 504);
    }
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) throw new RoomsError(`飯店點數資料來源（rooms.aero）不接受這把金鑰：${body.error === 'user_subscription_expired' ? 'seats.aero Pro 已到期' : '帳號可能沒有 API 權限'}`, 401);
    if (res.status === 429) throw new RoomsError('飯店點數今天的查詢額度已用完（每天 1,000 次，台灣時間早上 8 點重置）', 429);
    if (res.status === 404) throw new RoomsError('找不到這筆住宿資料，可能已經過期', 404);
    if (res.status === 400) throw new RoomsError(roomsBadRequest(body), 400);
    if (!res.ok) { console.error('rooms.aero', path, res.status, String(body.message || body.error || '').slice(0, 200)); throw new RoomsError(`飯店點數資料來源回應錯誤 (${res.status})`, 502); }
    return body;
  }
  return {
    search: (p, opts) => get('/search', p, opts),
    availability: (p, opts) => get('/availability', p, opts),
    detail: (id) => get(`/availability/${encodeURIComponent(id)}`),
  };
}

function roomsBadRequest(body) {
  const msg = String(body.message || '');
  if (/too many hotels/i.test(msg)) return '這個範圍的飯店太多了，請只選一兩個飯店集團再查';
  if (/location|geocod/i.test(msg)) return '找不到這個地點，請換個城市名稱（英文也可以）';
  console.error('rooms.aero 400', msg.slice(0, 200));
  return '查詢條件有誤，請調整日期或地點再試';
}

// Cash amounts arrive in minor units of their currency (ISO 4217): cents for USD, but whole yen for JPY and whole won
// for KRW, which have no minor unit, and thousandths for the three-decimal dinars. Dividing everything by 100 would
// make a Tokyo hotel 100 times too cheap.
const ZERO_DECIMAL = ['BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF'];
const THREE_DECIMAL = ['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND'];
const EXPONENT = Object.fromEntries([...ZERO_DECIMAL.map((c) => [c, 0]), ...THREE_DECIMAL.map((c) => [c, 3]), ['CLF', 4], ['UYW', 4]]);
const minorExponent = (currency) => EXPONENT[String(currency || '').toUpperCase()] ?? 2;
const money = (minor, currency) => {
  const cur = String(currency || 'USD').toUpperCase();
  return minor ? { amount: Math.round((minor / 10 ** minorExponent(cur)) * 1000) / 1000, currency: cur } : null;
};

const hotelOf = (h = {}) => ({
  id: h.id,
  source: h.source,
  program: h.program,
  name: h.name,
  brand: h.brand || '',
  category: h.award_category || '',
  address: h.address || '',
  city: h.city || '',
  country: h.country || '',
  lat: h.latitude ?? null,
  lon: h.longitude ?? null,
  image: /^https:\/\//.test(h.image_url || '') ? h.image_url : '',
  url: /^https:\/\//.test(h.url || '') ? h.url : '',
  availabilityPct: h.standard_award_availability_percent ?? null,
  lastChecked: h.last_checked_at || null,
});

function normalizeSearch(body) {
  return {
    hotels: (body.data || []).map((r) => ({
      ...hotelOf(r.hotel),
      standard: r.lowest_award_standard ? { points: r.lowest_award_standard, date: r.standard_date, nights: r.standard_nights, cash: money(r.lowest_cash_standard, r.currency_code) } : null,
      suite: r.lowest_award_suite ? { points: r.lowest_award_suite, date: r.suite_date, nights: r.suite_nights, cash: money(r.lowest_cash_suite, r.currency_code) } : null,
      cpp: r.cpp || 0,
      lastChecked: r.last_checked_at || null,
    })),
    hasMore: Boolean(body.has_more),
  };
}

const roomClass = (a, kind) => (a[`${kind}_award_available`] || a[`${kind}_cash_available`]
  ? { points: a[`${kind}_award_available`] ? a[`${kind}_award_cost`] : null, cash: a[`${kind}_cash_available`] ? money(a[`${kind}_cash_cost`], a.cash_currency_code) : null, cpp: a[`${kind}_cpp`] || 0 }
  : null);

function availabilityOf(a) {
  return {
    id: a.id,
    hotelId: a.hotel_id,
    source: a.source,
    arrival: a.arrival_date,
    departure: a.departure_date,
    nights: a.num_nights,
    standard: roomClass(a, 'standard'),
    suite: roomClass(a, 'suite'),
    booking: a.booking_link && /^https:\/\//.test(a.booking_link.url || '') ? { label: a.booking_link.label || '', url: a.booking_link.url } : null,
    lastChecked: a.last_checked_at || null,
  };
}

function normalizeAvailability(body) {
  const rows = body.data || [];
  return { hotel: rows[0]?.hotel ? hotelOf(rows[0].hotel) : null, dates: rows.map(availabilityOf), hasMore: Boolean(body.has_more) };
}

function normalizeDetail(a) {
  return {
    ...availabilityOf(a),
    hotel: a.hotel ? hotelOf(a.hotel) : null,
    rooms: (a.rooms || []).map((r) => ({
      name: r.name || r.room_code || '',
      description: r.description || '',
      suite: Boolean(r.suite),
      accessible: Boolean(r.accessible),
      points: r.award_cost || null,
      cash: money(r.cash_cost, r.cash_cost_currency),
    })),
  };
}

module.exports = { createRoomsClient, normalizeSearch, normalizeAvailability, normalizeDetail, RoomsError, PROGRAMS, money, minorExponent };
