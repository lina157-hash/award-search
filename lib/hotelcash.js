// Cash prices for one hotel stay, to set beside the points price.
// Names are matched in English (rooms.aero's language), so the lookups ask for English names.
// 1. SerpApi Google Hotels: every booking site's price, including the hotel's own site ("official"). 1–2 credits.
// 2. Booking.com on RapidAPI (fallback, or on request): Booking.com's own price. 2 requests. DataCrawler's booking-com15
//    is tried first (50 free a month); if the key isn't subscribed to it, Tipsters' booking-com (about 500 a month).
class HotelCashError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

const km = (a, b) => {
  if (![a?.lat, a?.lon, b?.lat, b?.lon].every(Number.isFinite)) return Infinity;
  const r = Math.PI / 180;
  const x = (b.lon - a.lon) * r * Math.cos(((a.lat + b.lat) / 2) * r);
  const y = (b.lat - a.lat) * r;
  return Math.sqrt(x * x + y * y) * 6371;
};
const words = (s) => new Set(String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9一-鿿 ]/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !['hotel', 'the', 'and', 'by', 'resort'].includes(w)));
function nameScore(a, b) {
  const A = words(a); const B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.max(A.size, B.size);
}
// The candidate that is this hotel: close by (under 1.5 km) and similarly named, or a near-exact name.
function pick(list, want, nameOf, posOf) {
  let best = null; let bestScore = 0;
  for (const c of list) {
    const d = km(want, posOf(c));
    const s = nameScore(want.name, nameOf(c)) + (d < 0.3 ? 1 : d < 1.5 ? 0.5 : d === Infinity ? 0 : -1);
    if (s > bestScore) { best = c; bestScore = s; }
  }
  return bestScore >= 0.6 ? best : null;
}

const nights = (a, b) => Math.max(1, Math.round((Date.parse(b) - Date.parse(a)) / 864e5));
// Google wraps booking links in its own redirect; that is fine to open, but only https links are passed on.
const safeLink = (u) => (/^https:\/\//.test(u || '') ? u : '');

function serpHotels({ apiKey, fetchImpl = fetch, onCall = () => {} }) {
  async function call(params) {
    const url = new URL('https://serpapi.com/search.json');
    for (const [k, v] of Object.entries({ engine: 'google_hotels', currency: 'TWD', gl: 'tw', hl: 'en', ...params, api_key: apiKey })) if (v != null && v !== '') url.searchParams.set(k, String(v));
    onCall();
    let res;
    try { res = await fetchImpl(url, { signal: AbortSignal.timeout(25000) }); } catch { throw new HotelCashError('SerpApi 連線失敗', 504); }
    const body = await res.json().catch(() => ({}));
    if (res.status === 429) throw new HotelCashError('SerpApi 額度用完或查詢太頻繁', 429);
    if (res.status === 401 || res.status === 403) throw new HotelCashError('SerpApi 金鑰無效', res.status);
    if (!res.ok) throw new HotelCashError(`SerpApi 回應錯誤 (${res.status})`, 502);
    if (body.error && !/hasn't returned any results/i.test(body.error)) throw new HotelCashError(`SerpApi：${String(body.error).slice(0, 120)}`, 502);
    return body;
  }
  return async function lookup(want) {
    const base = { q: [want.name, want.city].filter(Boolean).join(' '), check_in_date: want.checkin, check_out_date: want.checkout, adults: want.adults };
    let credits = 1;
    let prop = await call(base);
    if (Array.isArray(prop.properties)) {
      const hit = pick(prop.properties.filter((p) => p.type !== 'vacation rental'), want, (p) => p.name, (p) => ({ lat: p.gps_coordinates?.latitude, lon: p.gps_coordinates?.longitude }));
      if (!hit) return { found: false, credits };
      prop = hit;
    } else if (!prop.property_token && !prop.name) {
      return { found: false, credits };
    }
    if (!prop.prices && !prop.featured_prices && prop.property_token) {
      prop = await call({ ...base, property_token: prop.property_token });
      credits++;
    }
    const n = nights(want.checkin, want.checkout);
    const seen = new Set();
    const prices = [...(prop.featured_prices || []), ...(prop.prices || [])].filter((p) => p.source && !seen.has(p.source) && seen.add(p.source)).map((p) => {
      const total = p.total_rate?.extracted_lowest ?? (p.rate_per_night?.extracted_lowest != null ? p.rate_per_night.extracted_lowest * n : null);
      return {
        source: p.source,
        official: Boolean(p.official),
        logo: safeLink(p.logo),
        link: safeLink(p.link),
        perNight: p.rate_per_night?.extracted_lowest ?? (total ? Math.round(total / n) : null),
        total,
        freeCancel: Boolean(p.free_cancellation || p.rooms?.some((r) => r.rates?.some((x) => x.free_cancellation))),
      };
    }).filter((p) => p.total || p.perNight).sort((a, b) => (a.total || a.perNight * n) - (b.total || b.perNight * n));
    return {
      found: true,
      credits,
      provider: 'serpapi',
      name: prop.name || want.name,
      site: safeLink(prop.link),
      lowest: prop.total_rate?.extracted_lowest ?? (prices[0]?.total || null),
      typical: prop.typical_price_range ? [prop.typical_price_range.extracted_lowest, prop.typical_price_range.extracted_highest] : null,
      prices,
    };
  };
}

function bookingHotels({ apiKey, fetchImpl = fetch, onQuota = () => {} }) {
  let flavour = 'datacrawler';
  async function get(host, path, params) {
    const url = new URL(`https://${host}${path}`);
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, String(v));
    let res;
    try { res = await fetchImpl(url, { headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': host, accept: 'application/json' }, signal: AbortSignal.timeout(25000) }); } catch { throw new HotelCashError('Booking.com 資料來源連線失敗', 504); }
    const left = res.headers.get('x-ratelimit-requests-remaining');
    if (left != null && Number.isFinite(Number(left))) onQuota({ left: Number(left), limit: Number(res.headers.get('x-ratelimit-requests-limit')) || null });
    const body = await res.json().catch(() => ({}));
    const msg = String(body.message || '');
    if (res.status === 403 && /not subscribed/i.test(msg)) throw Object.assign(new HotelCashError('RapidAPI 金鑰沒有訂閱這個 Booking.com API', 403), { unsubscribed: true });
    if (res.status === 429) throw new HotelCashError(/monthly quota/i.test(msg) ? 'Booking.com API 這個月的免費額度用完了' : 'Booking.com API 查詢太頻繁，請稍後再試', 429);
    if (res.status === 401 || res.status === 403) throw new HotelCashError('RapidAPI 金鑰無法使用 Booking.com API', res.status);
    if (!res.ok) throw new HotelCashError(`Booking.com 資料來源回應錯誤 (${res.status})`, 502);
    if (body.status === false) throw new HotelCashError(`Booking.com 查詢失敗${msg ? `：${msg.slice(0, 120)}` : ''}`, 502);
    return body;
  }
  const deepLink = (id, w) => `https://www.booking.com/searchresults.zh-tw.html?dest_id=${encodeURIComponent(id)}&dest_type=hotel&checkin=${w.checkin}&checkout=${w.checkout}&group_adults=${w.adults}&no_rooms=1&group_children=0&selected_currency=TWD`;

  // DataCrawler: searchDestination (find the hotel) → getHotelDetails (price and page).
  async function datacrawler(w) {
    const H = 'booking-com15.p.rapidapi.com';
    const dest = await get(H, '/api/v1/hotels/searchDestination', { query: w.name });
    const hit = pick((dest.data || []).filter((d) => d.dest_type === 'hotel' || d.search_type === 'hotel'), w, (d) => d.name, (d) => ({ lat: d.latitude, lon: d.longitude }));
    if (!hit) return { found: false, requests: 1 };
    const det = await get(H, '/api/v1/hotels/getHotelDetails', { hotel_id: hit.dest_id, arrival_date: w.checkin, departure_date: w.checkout, adults: w.adults, room_qty: 1, units: 'metric', languagecode: 'zh-tw', currency_code: 'TWD' });
    const d = det.data || {};
    const pb = d.composite_price_breakdown || d.product_price_breakdown || {};
    const amount = pb.all_inclusive_amount || pb.gross_amount;
    return { found: true, requests: 2, name: d.hotel_name || hit.name, soldOut: Boolean(d.soldout), total: amount?.value ?? null, currency: amount?.currency || d.currency_code || 'TWD', url: safeLink(d.url) || deepLink(hit.dest_id, w) };
  }
  // Tipsters: locations (find the hotel) → search by that hotel id.
  async function tipsters(w) {
    const H = 'booking-com.p.rapidapi.com';
    const locs = await get(H, '/v1/hotels/locations', { name: w.name, locale: 'en-gb' });
    const hit = pick((Array.isArray(locs) ? locs : []).filter((d) => d.dest_type === 'hotel'), w, (d) => d.name, (d) => ({ lat: d.latitude, lon: d.longitude }));
    if (!hit) return { found: false, requests: 1 };
    const res = await get(H, '/v1/hotels/search', { dest_id: hit.dest_id, dest_type: 'hotel', checkin_date: w.checkin, checkout_date: w.checkout, adults_number: w.adults, room_number: 1, locale: 'zh-tw', filter_by_currency: 'TWD', order_by: 'popularity', units: 'metric' });
    const r = (res.result || []).find((x) => String(x.hotel_id) === String(hit.dest_id)) || (res.result || [])[0];
    if (!r) return { found: true, requests: 2, name: hit.name, soldOut: true, total: null, currency: 'TWD', url: deepLink(hit.dest_id, w) };
    const gross = r.composite_price_breakdown?.all_inclusive_amount || r.composite_price_breakdown?.gross_amount || r.price_breakdown?.all_inclusive_price && { value: r.price_breakdown.all_inclusive_price, currency: r.price_breakdown.currency };
    return { found: true, requests: 2, name: r.hotel_name || hit.name, soldOut: Boolean(r.soldout), total: gross?.value ?? r.min_total_price ?? null, currency: gross?.currency || r.currencycode || 'TWD', url: safeLink(r.url) || deepLink(hit.dest_id, w) };
  }
  return async function lookup(w) {
    if (flavour === 'datacrawler') {
      try { return { provider: 'booking', ...(await datacrawler(w)) }; } catch (e) {
        if (!e.unsubscribed) throw e;
        flavour = 'tipsters';
      }
    }
    try { return { provider: 'booking', ...(await tipsters(w)) }; } catch (e) {
      if (e.unsubscribed) { flavour = 'datacrawler'; throw new HotelCashError('RapidAPI 金鑰沒有訂閱 Booking.com API（DataCrawler 或 Tipsters 版）', 403); }
      throw e;
    }
  };
}

module.exports = { serpHotels, bookingHotels, HotelCashError, nameScore, km };
