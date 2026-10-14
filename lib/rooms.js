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

function createRoomsClient({ apiKey, fetchImpl = fetch, onCall = () => {} }) {
  async function get(path, params = {}) {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    onCall();
    const res = await fetchImpl(url, { headers: { 'Partner-Authorization': apiKey, accept: 'application/json' } });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) throw new RoomsError(`飯店點數資料來源（rooms.aero）不接受這把金鑰：${body.error === 'user_subscription_expired' ? 'seats.aero Pro 已到期' : '帳號可能沒有 API 權限'}`, 401);
    if (res.status === 429) throw new RoomsError('飯店點數今天的查詢額度已用完（每天 1,000 次，台灣時間早上 8 點重置）', 429);
    if (res.status === 404) throw new RoomsError('找不到這筆住宿資料，可能已經過期', 404);
    if (res.status === 400) throw new RoomsError(roomsBadRequest(body), 400);
    if (!res.ok) throw new RoomsError(`飯店點數資料來源回應錯誤 (${res.status})`, 502);
    return body;
  }
  return {
    search: (p) => get('/search', p),
    availability: (p) => get('/availability', p),
    detail: (id) => get(`/availability/${encodeURIComponent(id)}`),
  };
}

function roomsBadRequest(body) {
  const msg = String(body.message || '');
  if (/too many hotels/i.test(msg)) return '這個範圍的飯店太多了，請只選一兩個飯店集團再查';
  if (/location|geocod/i.test(msg)) return '找不到這個地點，請換個城市名稱（英文也可以）';
  return `查詢條件有誤${msg ? `：${msg.slice(0, 160)}` : ''}`;
}

// Cash amounts arrive in minor units (cents) of their currency.
const money = (minor, currency) => (minor ? { amount: minor / 100, currency: currency || 'USD' } : null);

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

module.exports = { createRoomsClient, normalizeSearch, normalizeAvailability, normalizeDetail, RoomsError, PROGRAMS };
