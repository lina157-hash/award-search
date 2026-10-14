// Cash prices for one hotel stay, to set beside the points price.
// Names are matched in English (rooms.aero's language), so the lookups ask for English names.
// 1. SerpApi Google Hotels: every booking site's price, including the hotel's own site ("official"). 1–2 credits.
// 2. Booking.com on RapidAPI (fallback, or on request): Booking.com's own price. 2 requests. Things4u's booking-com18
//    (530 free a month) first; DataCrawler's booking-com15 (20 a month) if the key is not subscribed to that one.
const { hashKey } = require('./kv');
const { toTraditional } = require('./s2t');

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
    if (body.error && !/hasn't returned any results/i.test(body.error)) {
      console.error('serpapi hotels', String(body.error).slice(0, 200));
      throw new HotelCashError('SerpApi 這次沒查到，請稍後再試', 502);
    }
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

// `kv` (optional, lib/kv.js): which Booking.com id a hotel name maps to is kept for 30 days, so a hotel looked up
// before costs one request (the price) instead of two.
const DEST_TTL = 30 * 86400;
const MISS_TTL = 86400;
// A city Booking.com did not recognise is retried after an hour (the owner may fix the spelling in the code or data).
const CITY_MISS_TTL = 3600;
// Hotels per result page on Things4u's stays/search.
const PAGE_SIZE = 20;
function bookingHotels({ apiKey, fetchImpl = fetch, onQuota = () => {}, kv = null }) {
  // The owner subscribed to Things4u's booking-com18 (530 free a month); DataCrawler's booking-com15 (20) is the spare.
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
    if (!res.ok) { console.error('booking', path, res.status, msg.slice(0, 200)); throw new HotelCashError(`Booking.com 資料來源回應錯誤 (${res.status})`, 502); }
    if (body.status === false) { console.error('booking', path, msg.slice(0, 200)); throw new HotelCashError('Booking.com 這次沒查到，請稍後再試', 502); }
    return body;
  }
  const deepLink = (id, w) => `https://www.booking.com/searchresults.zh-tw.html?dest_id=${encodeURIComponent(id)}&dest_type=hotel&checkin=${w.checkin}&checkout=${w.checkout}&group_adults=${w.adults}&no_rooms=1&group_children=0&selected_currency=TWD`;

  // The hotel's Booking.com id from its name (and position), remembered in `kv`. Returns { hit, requests }.
  async function findDest(which, w, lookup, parts = [w.name, w.city || '', w.lat ?? '', w.lon ?? ''], missTtl = MISS_TTL) {
    const key = `booking:dest:v1:${which}:${hashKey(parts.join('|'))}`;
    const saved = kv ? await kv.get(key).catch(() => null) : null;
    if (saved) return { hit: saved.none ? null : saved, requests: 0 };
    const hit = await lookup();
    if (kv) await kv.set(key, hit ? { dest_id: hit.dest_id, name: hit.name } : { none: true }, { ex: hit ? DEST_TTL : missTtl }).catch(() => {});
    return { hit: hit ? { dest_id: hit.dest_id, name: hit.name } : null, requests: 1 };
  }
  // DataCrawler: searchDestination (find the hotel) → getHotelDetails (price and page).
  async function datacrawler(w) {
    const H = 'booking-com15.p.rapidapi.com';
    const { hit, requests } = await findDest('dc', w, async () => {
      const dest = await get(H, '/api/v1/hotels/searchDestination', { query: w.name });
      return pick((dest.data || []).filter((d) => d.dest_type === 'hotel' || d.search_type === 'hotel'), w, (d) => d.name, (d) => ({ lat: d.latitude, lon: d.longitude }));
    });
    if (!hit) return { found: false, requests };
    const det = await get(H, '/api/v1/hotels/getHotelDetails', { hotel_id: hit.dest_id, arrival_date: w.checkin, departure_date: w.checkout, adults: w.adults, room_qty: 1, units: 'metric', languagecode: 'zh-tw', currency_code: 'TWD' });
    const d = det.data || {};
    const pb = d.composite_price_breakdown || d.product_price_breakdown || {};
    const amount = pb.all_inclusive_amount || pb.gross_amount;
    return { found: true, requests: requests + 1, name: d.hotel_name || hit.name, soldOut: Boolean(d.soldout), total: amount?.value ?? null, currency: amount?.currency || d.currency_code || 'TWD', url: safeLink(d.url) || deepLink(hit.dest_id, w) };
  }
  // Things4u (booking-com18): auto-complete (find the hotel) → stays/detail (price and page). Its auto-complete ids
  // are base64 JSON ({"dest_id":"…","dest_type":"hotel",…}); stays/detail wants the numeric hotel id inside.
  const T4 = 'booking-com18.p.rapidapi.com';
  const t4Place = (d) => {
    let inner = {};
    try { inner = JSON.parse(Buffer.from(String(d.id || ''), 'base64').toString('utf8')) || {}; } catch { /* not base64 JSON */ }
    return { id: d.id, destId: String(d.dest_id ?? inner.dest_id ?? ''), type: String(d.dest_type || d.type || inner.dest_type || '').toLowerCase(), name: d.name || d.label || inner.city_name || '', lat: Number(d.latitude ?? d.lat), lon: Number(d.longitude ?? d.lng ?? d.lon) };
  };
  async function things4u(w) {
    const { hit, requests } = await findDest('t4', w, async () => {
      const ac = await get(T4, '/stays/auto-complete', { query: w.name, languageCode: 'en-us' });
      const list = (Array.isArray(ac.data) ? ac.data : []).map(t4Place).filter((d) => d.type === 'hotel' && d.destId);
      const best = pick(list, w, (d) => d.name, (d) => ({ lat: d.lat, lon: d.lon }));
      return best && { dest_id: best.destId, name: best.name };
    });
    if (!hit) return { found: false, requests };
    const det = await get(T4, '/stays/detail', { hotelId: hit.dest_id, checkinDate: w.checkin, checkoutDate: w.checkout, adults: w.adults, rooms: 1, units: 'metric', languageCode: 'en-us', currencyCode: 'TWD' });
    const d = det.data || {};
    const pb = d.composite_price_breakdown || d.product_price_breakdown || {};
    const amount = pb.all_inclusive_amount || pb.gross_amount;
    return { found: true, requests: requests + 1, name: d.hotel_name || hit.name, soldOut: Boolean(d.soldout) || !amount, total: amount?.value ?? null, currency: amount?.currency || d.currency_code || 'TWD', url: safeLink(d.url) || deepLink(hit.dest_id, w) };
  }
  // Every hotel Booking.com lists in a city for a stay, at most `maxRequests` requests: the city's id (kept 30 days,
  // usually free) and one or two result pages. Rows: { id, name, total, currency, url, stars, lat, lon, soldOut }.
  const cityLink = (id, w) => `https://www.booking.com/searchresults.zh-tw.html?dest_id=${encodeURIComponent(id)}&dest_type=city&checkin=${w.checkin}&checkout=${w.checkout}&group_adults=${w.adults}&no_rooms=1&group_children=0&selected_currency=TWD`;
  const hotelLink = (id, w) => deepLink(id, w);
  // The city entry: nearest to the given position when there is one, else Booking's first suggestion.
  function pickCity(list, w) {
    if (!list.length) return null;
    if (!Number.isFinite(w.lat) || !Number.isFinite(w.lon)) return list[0];
    return [...list].sort((a, b) => km(w, { lat: Number(a.latitude), lon: Number(a.longitude) }) - km(w, { lat: Number(b.latitude), lon: Number(b.longitude) }))[0];
  }
  const cityKey = (w) => ['city', String(w.city).toLowerCase(), w.lat ?? '', w.lon ?? ''];
  // Booking.com's filter options for a city search ("Brands": Novotel, ibis…), the ones `wanted(title)` accepts, as
  // filter ids ("chaincode::1053") to pass back to the search. Kept 30 days per city, so a repeat search in the same
  // city costs only the result page. Read loosely: any object with a "kind::value" id and a title, name or value.text.
  // Brand ids matched in any city so far (the same id in every city; a city's own list shows only its biggest
  // brands), so a brand seen in Bangkok is also asked for in Tokyo. Kept 180 days.
  const KNOWN_KEY = 'booking:brandids:v1';
  async function brandFilter(which, destId, wanted, fetchFilters, debug, fallbackIds = []) {
    const key = `booking:filter:v1:${which}:${destId}`;
    const knownEntry = (kv ? await kv.get(KNOWN_KEY).catch(() => null) : null) || {};
    const known = knownEntry.ids || [];
    const all = (cityIds) => [...new Set([...cityIds, ...known, ...fallbackIds])];
    const saved = kv ? await kv.get(key).catch(() => null) : null;
    if (saved) { const ids = all(saved.ids || []); debug.filters = { cached: true, ids: ids.length }; return { ids, requests: 0 }; }
    let body;
    try { body = await fetchFilters(); } catch (e) { if (e.status === 429 || e.unsubscribed) throw e; debug.filters = { error: e.message }; return { ids: all([]), requests: 1 }; }
    const options = [];
    (function walk(x, depth) {
      if (!x || typeof x !== 'object' || depth > 8) return;
      if (Array.isArray(x)) { for (const v of x) walk(v, depth + 1); return; }
      const id = [x.genericId, x.generic_id, x.id, x.filter_id].find((v) => typeof v === 'string' && /^[a-z_]+::[\w-]+$/i.test(v));
      // Booking's GraphQL options keep the label in value.text (or title.text).
      const title = [x.title, x.name, x.label, x.value?.text, x.title?.text, x.label?.text].find((v) => typeof v === 'string');
      if (id && title) options.push({ id, title });
      for (const v of Object.values(x)) if (v && typeof v === 'object') walk(v, depth + 1);
    })(body, 0);
    const ids = [...new Set(options.filter((o) => !/^(class|review_score|price|distance|facility|hotelfacility|roomfacility|mealplan|free_cancellation|popular|reviewscorebuckets|ht_id|property_type|district|landmark|uf|di)::/i.test(o.id) && wanted(o.title)).map((o) => o.id))];
    debug.filters = { options: options.length, kinds: [...new Set(options.map((o) => o.id.split('::')[0]))].slice(0, 20), matched: options.filter((o) => ids.includes(o.id)).map((o) => `${o.title}=${o.id}`).slice(0, 30), known: known.length };
    // An answer we could not read: its outline (no prices or personal data) for /api/hotels/accor/debug.
    if (!options.length) debug.filters.shape = JSON.stringify(body, (k, v) => (Array.isArray(v) ? v.slice(0, 2) : v)).slice(0, 1500);
    if (kv && options.length) await kv.set(key, { ids }, { ex: DEST_TTL }).catch(() => {});
    const fresh = options.filter((o) => ids.includes(o.id) && !known.includes(o.id));
    if (kv && fresh.length) await kv.set(KNOWN_KEY, { ids: [...known, ...fresh.map((o) => o.id)].slice(-80), titles: [...(knownEntry.titles || []), ...fresh.map((o) => o.title)].slice(-80) }, { ex: 180 * 86400 }).catch(() => {});
    return { ids: all(ids), requests: 1 };
  }
  // Brands a city's own filter list leaves out (it shows only the biggest few) are learnt from cities where they
  // are big: while Pullman or Sofitel is still unknown, a search also reads one of these cities' brand lists
  // (two requests, once per city).
  const TEACHERS = ['Paris', 'Sydney', 'Singapore', 'Dubai', 'Jakarta', 'Melbourne', 'Istanbul', 'Shanghai'];
  const MUST_KNOW = [/pullman/i, /sofitel/i];
  async function teachBrands(w, wanted, debug) {
    if (!kv) return 0;
    const known = (await kv.get(KNOWN_KEY).catch(() => null)) || {};
    if (MUST_KNOW.every((re) => (known.titles || []).some((t) => re.test(t)))) return 0;
    const tried = (await kv.get('booking:brandteach:v1').catch(() => null))?.tried || [];
    const city = TEACHERS.find((c) => !tried.includes(c));
    if (!city) return 0;
    await kv.set('booking:brandteach:v1', { tried: [...tried, city] }, { ex: 180 * 86400 }).catch(() => {});
    const t = { city, lat: null, lon: null };
    const lesson = { city };
    try {
      const { hit, requests } = await findDest('t4-city', t, async () => {
        const ac = await get(T4, '/stays/auto-complete', { query: city, languageCode: 'en-us' });
        const c = (Array.isArray(ac.data) ? ac.data : []).map(t4Place).find((d) => d.type === 'city');
        return c && { dest_id: c.id, name: c.name };
      }, cityKey(t), CITY_MISS_TTL);
      if (!hit) { debug.teach = { ...lesson, found: false }; return requests; }
      const f = await brandFilter('t4', hit.dest_id, wanted, () => get(T4, '/stays/get-filters', { locationId: hit.dest_id, checkinDate: w.checkin, checkoutDate: w.checkout, adults: w.adults, rooms: 1, units: 'metric', languageCode: 'en-us', currencyCode: 'TWD' }), lesson);
      debug.teach = lesson;
      return requests + f.requests;
    } catch (e) {
      if (e.status === 429) throw e;
      debug.teach = { ...lesson, error: e.message };
      return 0;
    }
  }
  async function things4uCity(w, maxRequests, wanted, knownIds = [], zhNames = false) {
    const debug = { provider: 'things4u', query: w.city, pages: [] };
    const { hit, requests } = await findDest('t4-city', w, async () => {
      const ac = await get(T4, '/stays/auto-complete', { query: w.city, languageCode: 'en-us' });
      const list = (Array.isArray(ac.data) ? ac.data : []).map(t4Place);
      debug.locations = list.slice(0, 6).map((d) => `${d.type}:${d.name}`);
      const city = pickCity(list.filter((d) => d.type === 'city').map((d) => ({ ...d, latitude: d.lat, longitude: d.lon })), w);
      return city && { dest_id: city.id, name: city.name };
    }, cityKey(w), CITY_MISS_TTL);
    debug.city = hit ? hit.name : null;
    if (!hit) return { found: false, requests, hotels: [], debug };
    const base = { locationId: hit.dest_id, checkinDate: w.checkin, checkoutDate: w.checkout };
    let used = requests;
    let ids = [];
    if (wanted) {
      const f = await brandFilter('t4', hit.dest_id, wanted, () => get(T4, '/stays/get-filters', { ...base, adults: w.adults, rooms: 1, units: 'metric', languageCode: 'en-us', currencyCode: 'TWD' }), debug, knownIds);
      used += f.requests; ids = f.ids;
      if (ids.length || used >= maxRequests) maxRequests = used + 1;
    }
    // With a brand filter every page is wanted, so pages are read until a short one (at most 5, about 100 hotels),
    // sorted by price so the Chinese pages line up with the English ones.
    const filtered = ids.length > 0;
    if (filtered) maxRequests = used + 5;
    const query = (page, languageCode) => get(T4, '/stays/search', { ...base, adults: w.adults, rooms: 1, page, sortBy: filtered ? 'price' : 'popularity', categoriesFilter: ids.join(',') || undefined, units: 'metric', languageCode, currencyCode: 'TWD' });
    const rowsOf = (res) => (Array.isArray(res.data) ? res.data : res.data?.hotels || []).map((h) => h.property || h);
    const hotels = [];
    const seen = new Set();
    const zhNamesById = new Map();
    for (let page = 1; used < maxRequests; page++) {
      const rows = rowsOf(await query(page, 'en-us'));
      used++;
      const first = rows[0] || {};
      debug.pages.push({ count: rows.length, keys: Object.keys(first).slice(0, 25), price: rows.length ? JSON.stringify(first.priceBreakdown || first.price || null).slice(0, 300) : undefined, sample: rows.slice(0, 10).map((p) => p.name) });
      for (const p of rows) {
        const id = String(p.id ?? p.hotel_id ?? '');
        if (seen.has(id)) continue;
        seen.add(id);
        const gross = p.priceBreakdown?.grossPrice || p.priceBreakdown?.allInclusivePrice;
        hotels.push({ id, name: p.name || '', total: gross?.value ?? null, currency: gross?.currency || 'TWD', url: hotelLink(id, w), stars: Number(p.propertyClass || p.accuratePropertyClass || p.qualityClass) || null, lat: Number(p.latitude) || null, lon: Number(p.longitude) || null, soldOut: Boolean(p.isSoldout || p.isSoldOut || p.soldout) });
      }
      // Chinese names: the same page in Traditional Chinese (one more request), matched by hotel id.
      if (zhNames && rows.length) {
        try {
          for (const p of rowsOf(await query(page, 'zh-tw'))) zhNamesById.set(String(p.id ?? p.hotel_id ?? ''), p.name);
          used++;
        } catch (e) { if (e.status === 429) throw e; debug.zhError = e.message; }
      }
      if (rows.length < PAGE_SIZE) break;
    }
    for (const h of hotels) {
      const zh = zhNamesById.get(h.id);
      if (zh && zh !== h.name && /[\u3400-\u9fff]/.test(zh)) h.nameZh = toTraditional(zh);
    }
    debug.total = hotels.length;
    debug.zhNames = hotels.filter((h) => h.nameZh).length;
    if (wanted) used += await teachBrands(w, wanted, debug);
    const destId = t4Place({ id: hit.dest_id }).destId;
    return { found: true, requests: used, city: hit.name, url: destId ? cityLink(destId, w) : '', hotels, debug };
  }
  async function datacrawlerCity(w, maxRequests, wanted, knownIds = [], zhNames = false) {
    const H = 'booking-com15.p.rapidapi.com';
    const debug = { provider: 'datacrawler', query: w.city, pages: [] };
    const { hit, requests } = await findDest('dc-city', w, async () => {
      const dest = await get(H, '/api/v1/hotels/searchDestination', { query: w.city });
      debug.locations = (dest.data || []).slice(0, 6).map((d) => `${d.dest_type || d.search_type}:${d.name}`);
      return pickCity((dest.data || []).filter((d) => d.dest_type === 'city' || d.search_type === 'city'), w);
    }, cityKey(w), CITY_MISS_TTL);
    debug.city = hit ? `${hit.name} (${hit.dest_id})` : null;
    if (!hit) return { found: false, requests, hotels: [], debug };
    const base = { dest_id: hit.dest_id, search_type: 'CITY', arrival_date: w.checkin, departure_date: w.checkout, adults: w.adults, room_qty: 1 };
    let used = requests;
    let ids = [];
    if (wanted) {
      const f = await brandFilter('dc', hit.dest_id, wanted, () => get(H, '/api/v1/hotels/getFilter', base), debug, knownIds);
      used += f.requests; ids = f.ids;
      if (ids.length || used >= maxRequests) maxRequests = used + 1;
    }
    const hotels = [];
    for (let page = 1; used < maxRequests; page++) {
      const res = await get(H, '/api/v1/hotels/searchHotels', { ...base, page_number: page, units: 'metric', languagecode: 'en-us', currency_code: 'TWD', categories_filter: ids.join(',') || undefined });
      used++;
      const rows = res.data?.hotels || [];
      debug.pages.push({ count: rows.length, keys: rows.length ? undefined : Object.keys(res.data || res || {}).slice(0, 8), sample: rows.slice(0, 10).map((h) => h.property?.name) });
      for (const h of rows) {
        const p = h.property || {};
        const gross = p.priceBreakdown?.grossPrice;
        hotels.push({ id: String(h.hotel_id ?? p.id ?? ''), name: p.name || '', total: gross?.value ?? null, currency: gross?.currency || 'TWD', url: hotelLink(h.hotel_id ?? p.id, w), stars: Number(p.propertyClass || p.accuratePropertyClass) || null, lat: Number(p.latitude) || null, lon: Number(p.longitude) || null, soldOut: Boolean(p.isSoldOut || p.soldout) });
      }
      if (!rows.length) break;
    }
    return { found: true, requests: used, city: hit.name, url: cityLink(hit.dest_id, w), hotels, debug };
  }
  // Whichever API the key is subscribed to: Things4u (the bigger free quota) first, DataCrawler when Things4u says
  // the key is not subscribed. That answer is remembered for 10 minutes only, so subscribing later takes effect
  // without a redeploy.
  let primaryOffUntil = 0;
  async function either(tip, dc, ...args) {
    const order = Date.now() < primaryOffUntil ? [dc, tip] : [tip, dc];
    for (const [i, fn] of order.entries()) {
      try {
        const r = await fn(...args);
        if (fn === tip) primaryOffUntil = 0;
        return { provider: 'booking', ...r };
      } catch (e) {
        if (e.unsubscribed && fn === tip) primaryOffUntil = Date.now() + 600_000;
        if (!e.unsubscribed || i === order.length - 1) throw e.unsubscribed ? new HotelCashError('RapidAPI 金鑰沒有訂閱 Booking.com API（Things4u 或 DataCrawler 版）', 403) : e;
      }
    }
  }
  const lookup = (w) => either(things4u, datacrawler, w);
  // A city's hotels (see things4uCity); `maxRequests` caps the requests of one search (2 by default). With `brands`
  // (a test on Booking.com's brand filter titles) only those brands are asked for: one filter request per city (kept
  // 30 days) and one result page, so the hotels are not lost among the city's most popular ones.
  // `brandIds`: brand filter ids known from earlier searches, used when a city's own filter list has none.
  // `zhNames`: also each hotel's Traditional Chinese name (`nameZh`), one more request (Things4u only).
  lookup.city = (w, { maxRequests = 2, brands = null, brandIds = [], zhNames = false } = {}) => either(things4uCity, datacrawlerCity, w, maxRequests, brands, brandIds, zhNames);
  return lookup;
}

module.exports = { serpHotels, bookingHotels, HotelCashError, nameScore, km };
