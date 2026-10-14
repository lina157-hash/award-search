// Award search server: serves the frontend and proxies seats.aero so the API key stays server-side.
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createClient, normalizeAvailability, normalizeTrips, SeatsAeroError } = require('./lib/seats');
const mock = require('./lib/mock');
const { createCashClient, normalizeCash, CashError } = require('./lib/cash');
const { createAlerts, redisStore, memoryStore, resendMailer, AlertError } = require('./lib/alerts');
const { createPriceWatch, RESERVE } = require('./lib/pricewatch');
const { createDeals } = require('./lib/deals');
const rooms = require('./lib/rooms');
const rapid = require('./lib/rapidflights');

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.SEATS_AERO_API_KEY || '';
const MOCK = !API_KEY || process.env.MOCK === '1';
const SERPAPI_KEY = process.env.SERPAPI_KEY || '';
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '';
// Cash fares: RapidAPI's Google Flights first (150 free a month), SerpApi as the fallback; demo data in demo mode, otherwise off.
const CASH_MODE = SERPAPI_KEY || RAPIDAPI_KEY ? 'live' : MOCK ? 'mock' : 'off';
const REDIS_URL_EARLY = () => process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '';
const REDIS_TOKEN_EARLY = () => process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
const CACHE_TTL_MS = (Number(process.env.CACHE_TTL_SECONDS) || 1800) * 1000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILES = ['airlines', 'alliances', 'airports', 'programs', 'glossary', 'asiamiles', 'sourcenames', 'points', 'booking', 'charts', 'products', 'promos'];
// Shown in the page footer; bump with `node scripts/bump-version.js`.
const VERSION = require('./data/version.json');

const usage = { day: '', calls: 0 };
function countCall() {
  const today = new Date().toISOString().slice(0, 10);
  if (usage.day !== today) Object.assign(usage, { day: today, calls: 0 });
  usage.calls++;
}

const client = createClient({ apiKey: API_KEY, onCall: countCall });
const cashUsage = { day: '', calls: 0 };
const cashQuery = createCashClient({
  apiKey: SERPAPI_KEY,
  onCall: () => {
    const today = new Date().toISOString().slice(0, 10);
    if (cashUsage.day !== today) Object.assign(cashUsage, { day: today, calls: 0 });
    cashUsage.calls++;
  },
});
// Hotel award availability (rooms.aero) takes the same seats.aero Pro key, with its own 1,000 calls per UTC day.
const roomsUsage = { day: '', calls: 0 };
const roomsClient = rooms.createRoomsClient({
  apiKey: API_KEY,
  onCall: () => {
    const today = new Date().toISOString().slice(0, 10);
    if (roomsUsage.day !== today) Object.assign(roomsUsage, { day: today, calls: 0 });
    roomsUsage.calls++;
  },
});
// What is left of each provider's monthly quota, as last reported. RapidAPI says so in every response's headers;
// it is kept in Redis too, because each serverless instance only sees its own calls.
const quotaStore = REDIS_URL_EARLY() ? redisStore({ url: REDIS_URL_EARLY(), token: REDIS_TOKEN_EARLY(), key: 'cash-quota:v1' }) : null;
const cashQuota = { rapid: null, serp: null };
const rapidQuery = RAPIDAPI_KEY && rapid.createRapidFlights({
  apiKey: RAPIDAPI_KEY,
  onQuota: ({ left, limit }) => {
    cashQuota.rapid = { left, limit, at: new Date().toISOString() };
    quotaStore?.save({ rapid: cashQuota.rapid }).catch(() => {});
  },
});
// SerpApi's account endpoint is free and reports the searches left this month; asked at most every 10 minutes.
async function serpLeft() {
  if (!SERPAPI_KEY) return null;
  if (cashQuota.serp && Date.now() - Date.parse(cashQuota.serp.at) < 600e3) return cashQuota.serp.left;
  try {
    const res = await fetch(`https://serpapi.com/account.json?api_key=${encodeURIComponent(SERPAPI_KEY)}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return cashQuota.serp?.left ?? null;
    const a = await res.json();
    const left = Number.isFinite(a.total_searches_left) ? a.total_searches_left : Number.isFinite(a.plan_searches_left) ? a.plan_searches_left : null;
    cashQuota.serp = { left, limit: Number.isFinite(a.searches_per_month) ? a.searches_per_month : null, at: new Date().toISOString() };
    return left;
  } catch { return cashQuota.serp?.left ?? null; }
}
const ALLIANCE_CARRIERS = Object.fromEntries(require('./data/alliances.json').alliances.map((a) => [a.id, new Set(a.members || a.carriers || [])]));
// One live cash lookup. Tokens go back to whoever issued them; a new search tries RapidAPI first (single airports only,
// it takes no city lists) and falls back to SerpApi when RapidAPI fails or runs out, if `allowSerp` agrees.
async function liveCash(params, { allowSerp = async () => true } = {}) {
  if (rapid.isRapidToken(params.departure_token) || rapid.isRapidToken(params.booking_token)) return { ...(await rapidQuery(params)), provider: 'rapid' };
  if (params.departure_token || params.booking_token) return { ...(await cashQuery(params)), provider: 'serpapi' };
  let fallback = '';
  const single = /^[A-Z]{3}$/.test(params.departure_id) && /^[A-Z]{3}$/.test(params.arrival_id);
  if (rapidQuery && single) {
    try {
      const inc = params.include_airlines;
      const allianceCarriers = !inc ? null : ALLIANCE_KEY[inc] ? ALLIANCE_CARRIERS[ALLIANCE_KEY[inc]] : new Set(inc.split(','));
      return { ...(await rapidQuery({ ...params, allianceCarriers })), provider: 'rapid' };
    } catch (e) {
      if (!(e instanceof CashError) || !SERPAPI_KEY) throw e;
      fallback = e.message;
    }
  } else if (rapidQuery) fallback = '多個機場一起查，RapidAPI 不支援';
  if (!SERPAPI_KEY) throw new CashError('沒有設定現金票資料來源', 503);
  if (!(await allowSerp())) throw new CashError(`${fallback || 'RapidAPI 無法使用'}，SerpApi 額度要留給手動查詢，這次先跳過`, 503);
  return { ...(await cashQuery(params)), provider: 'serpapi', fallback };
}
const cache = new Map();
async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await fn();
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return value;
}

class BadRequest extends Error {}

// Seat alerts: Upstash Redis (Vercel Storage tab) keeps the watches, Resend sends the mail. Demo mode keeps them in memory.
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '';
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
const alertStore = REDIS_URL && REDIS_TOKEN ? redisStore({ url: REDIS_URL, token: REDIS_TOKEN }) : MOCK ? memoryStore() : null;
const alertMailer = process.env.RESEND_API_KEY ? resendMailer({ apiKey: process.env.RESEND_API_KEY, from: process.env.ALERT_FROM }) : null;
const SOURCE_NAMES = require('./data/source-names.json').names;
const alerts = alertStore && createAlerts({
  store: alertStore,
  sendEmail: alertMailer,
  siteUrl: process.env.SITE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : ''),
  programNames: SOURCE_NAMES,
  search: async (params) => {
    const { items } = await cached('alert:' + JSON.stringify(params), () => (MOCK ? { items: mock.mockSearch(params), hasMore: false } : client.search(params, { maxPages: pagesFor(params, 2) })));
    return items.map(normalizeAvailability);
  },
});
// Daily deals from Taipei, refreshed by the same daily cron as the alerts and kept in the same Redis.
const deals = createDeals({
  store: REDIS_URL && REDIS_TOKEN ? redisStore({ url: REDIS_URL, token: REDIS_TOKEN, key: 'award-deals:v1' }) : memoryStore(),
  search: async (params) => {
    const { items } = await cached('deals:' + JSON.stringify(params), () => (MOCK ? { items: mock.mockSearch(params), hasMore: false } : client.search(params, { maxPages: 1 })));
    return items.map(normalizeAvailability);
  },
});
// Cash price tracking: same Redis and mailer as the seat alerts; each check spends one SerpApi credit, so lib/pricewatch spaces them out and caps them.
const watchStore = CASH_MODE === 'off' ? null : REDIS_URL && REDIS_TOKEN ? redisStore({ url: REDIS_URL, token: REDIS_TOKEN, key: 'price-watch:v1' }) : CASH_MODE === 'mock' ? memoryStore() : null;
const priceWatch = watchStore && createPriceWatch({
  store: watchStore,
  sendEmail: alertMailer,
  siteUrl: process.env.SITE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : ''),
  // Checks run on RapidAPI; the SerpApi reserve only matters when there is no RapidAPI key.
  quota: async () => (CASH_MODE !== 'live' || RAPIDAPI_KEY ? null : serpLeft()),
  search: async (w) => {
    const params = { departure_id: w.origin, arrival_id: w.destination, outbound_date: w.depart, return_date: w.ret || undefined, type: w.ret ? 1 : 2, travel_class: CABIN_CLASS[w.cabin], adults: w.adults, stops: w.stops || undefined };
    if (CASH_MODE === 'mock') return normalizeCash(mock.mockCash(params));
    // Falling back to SerpApi is fine only while it has plenty left for the owner's own searches.
    return normalizeCash(await liveCash(params, { allowSerp: async () => { const left = await serpLeft(); return left == null || left >= RESERVE; } }));
  },
});
async function handleWatch(req, q) {
  if (!priceWatch) return { configured: false, watches: [] };
  if (!cashUnlocked(req)) throw Object.assign(new CashError('需要通關密碼才能管理降價追蹤', 401), { code: 'passcode' });
  if (req.method === 'POST') return { configured: true, ...(await priceWatch.add(await readJson(req))) };
  if (req.method === 'DELETE') { await priceWatch.remove(String(q.get('id') || '')); return { ok: true }; }
  return { configured: true, email: Boolean(alertMailer), max: priceWatch.max, ...(await priceWatch.list()) };
}

let dealsPending = null;
async function handleDeals() {
  // Concurrent first visitors share one build instead of each spending API calls.
  dealsPending ||= deals.get().finally(() => { dealsPending = null; });
  return { mock: MOCK, ...(await dealsPending) };
}

// Vercel's cron calls the run endpoint with the CRON_SECRET; people use the passcode (when one is set).
function alertsAllowed(req) {
  const secret = (process.env.CRON_SECRET || '').trim();
  if (secret && req.headers.authorization === `Bearer ${secret}`) return true;
  return cashUnlocked(req);
}
function readJson(req, limit = 10_000) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; if (data.length > limit) reject(new BadRequest('內容太長')); });
    req.on('end', () => {
      let body;
      try { body = data ? JSON.parse(data) : {}; } catch { return reject(new BadRequest('JSON 格式錯誤')); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return reject(new BadRequest('JSON 格式錯誤'));
      resolve(body);
    });
    req.on('error', reject);
  });
}
async function handleAlerts(req, q, sub) {
  if (sub === 'run' && !alertsAllowed(req)) throw Object.assign(new CashError('需要通關密碼才能管理提醒', 401), { code: 'passcode' });
  // The daily cron also refreshes the deals list; a failure there must not stop the alert run.
  const dealsRun = sub === 'run' ? await deals.refresh().then((d) => ({ deals: d.groups.reduce((n, g) => n + g.items.length, 0) }), (e) => ({ dealsError: e.message })) : {};
  if (sub === 'run' && priceWatch) Object.assign(dealsRun, await priceWatch.run().then((w) => ({ watches: w }), (e) => ({ watchError: e.message })));
  if (!alerts) return { configured: false, email: false, alerts: [], ...dealsRun };
  if (!alertsAllowed(req)) throw Object.assign(new CashError('需要通關密碼才能管理提醒', 401), { code: 'passcode' });
  if (sub === 'run') return { configured: true, ...dealsRun, ...(await alerts.run()) };
  if (req.method === 'POST') return { configured: true, ...(await alerts.add(await readJson(req))) };
  if (req.method === 'DELETE') { await alerts.remove(String(q.get('id') || '')); return { ok: true }; }
  return { configured: true, email: Boolean(alertMailer), alerts: await alerts.list() };
}

// Optional passcode that gates the cash-fare lookups (each one spends a SerpApi credit). Read per request so tests can set it.
const cashPasscode = () => (process.env.CASH_PASSCODE || '').trim();
function cashUnlocked(req) {
  const want = cashPasscode();
  if (!want) return true;
  const got = String(req.headers['x-cash-pass'] || '');
  return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

// TWD per unit of each currency, for converting award taxes. Refreshed daily from a free rate feed; the table is the fallback.
const FX_FALLBACK = { USD: 31.96, CAD: 22.42, EUR: 35.81, GBP: 42.3, JPY: 0.202, HKD: 4.07, AUD: 22.32, SGD: 24.96, KRW: 0.0225, CNY: 4.45, NZD: 19.3, CHF: 39.5, THB: 0.95, MYR: 7.4, INR: 0.36, BRL: 5.9, MXN: 1.72, AED: 8.7, QAR: 8.78, TRY: 0.78, SEK: 3.3, DKK: 4.8, NOK: 3.1, TWD: 1 };
let fxCache = { expires: 0, body: null };
async function handleFx() {
  if (fxCache.expires > Date.now()) return fxCache.body;
  let body = { rates: FX_FALLBACK, updated: '2026-10-12', live: false };
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(5000) });
    const j = await res.json();
    if (j.result === 'success' && j.rates?.TWD) {
      const rates = {};
      for (const [cur, perUsd] of Object.entries(j.rates)) if (perUsd > 0) rates[cur] = Math.round((j.rates.TWD / perUsd) * 1e4) / 1e4;
      body = { rates, updated: new Date(j.time_last_update_unix * 1000).toISOString().slice(0, 10), live: true, provider: 'exchangerate-api.com' };
    }
  } catch { /* keep the fallback table */ }
  fxCache = { expires: Date.now() + 24 * 3600e3, body };
  return body;
}
const IATA_LIST = /^[A-Z]{3}(,[A-Z]{3}){0,9}$/;
const CODE_LIST = /^[A-Z0-9]{2}(,[A-Z0-9]{2}){0,29}$/;
const SOURCE_LIST = /^[a-z]+(,[a-z]+){0,29}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 366;
const CABIN_NAMES = { Y: 'economy', W: 'premium', J: 'business', F: 'first' };
const REGIONS = new Set(require('./data/airports.json').regions);

function param(q, name, re, { required = false, upper = false } = {}) {
  let v = (q.get(name) || '').trim().replace(/\s+/g, '');
  if (upper) v = v.toUpperCase();
  if (!v) {
    if (required) throw new BadRequest(`缺少參數 ${name}`);
    return undefined;
  }
  if (re && !re.test(v)) throw new BadRequest(`參數 ${name} 格式錯誤`);
  return v;
}

function dateRange(q) {
  const start = param(q, 'start', DATE, { required: true });
  const end = param(q, 'end', DATE) || start;
  const days = (new Date(end) - new Date(start)) / 864e5;
  if (days < 0) throw new BadRequest('結束日期不可早於開始日期');
  // seats.aero publishes award space about a year out, so a search may cover all of it.
  if (days > MAX_RANGE_DAYS) throw new BadRequest('日期範圍最多一年');
  return { start_date: start, end_date: end };
}

// Longer date ranges return more rows, so allow more result pages (each page is one API call).
const pagesFor = (p, base) => base + Math.floor((new Date(p.end_date) - new Date(p.start_date)) / 864e5 / 90);

async function handleSearch(q) {
  const params = {
    origin_airport: param(q, 'origin', IATA_LIST, { required: true, upper: true }),
    destination_airport: param(q, 'destination', IATA_LIST, { required: true, upper: true }),
    ...dateRange(q),
    carriers: param(q, 'carriers', CODE_LIST, { upper: true }),
    sources: param(q, 'sources', SOURCE_LIST),
    only_direct_flights: q.get('direct') === '1' ? true : undefined,
  };
  const cabin = param(q, 'cabin', /^[YWJF]$/, { upper: true });
  if (cabin) params.cabins = CABIN_NAMES[cabin];
  // Trip details carry the taxes; include them for ranges short enough that the bigger payload stays quick.
  if (pagesFor(params, 0) === 0 && (new Date(params.end_date) - new Date(params.start_date)) / 864e5 <= 45) params.include_trips = true;
  const key = 'search:' + JSON.stringify(params);
  const { items, hasMore } = await cached(key, () => (MOCK ? { items: mock.mockSearch(params), hasMore: false } : client.search(params, { maxPages: pagesFor(params, 2) })));
  return { mock: MOCK, truncated: hasMore, withTaxes: Boolean(params.include_trips), results: items.map(normalizeAvailability) };
}

async function handleExplore(q) {
  const params = {
    // `program`, not `source`: Vercel's rewrite drops a `source` query param.
    source: param(q, 'program', /^[a-z]+$/) || param(q, 'source', /^[a-z]+$/, { required: true }),
    ...dateRange(q),
    origin_region: q.get('origin_region') || undefined,
    destination_region: q.get('destination_region') || undefined,
  };
  for (const r of [params.origin_region, params.destination_region]) {
    if (r && !REGIONS.has(r)) throw new BadRequest('區域參數錯誤');
  }
  const cabin = param(q, 'cabin', /^[YWJF]$/, { upper: true }) || 'J';
  params.cabin = CABIN_NAMES[cabin];
  const key = 'explore:' + JSON.stringify(params);
  const { items, hasMore } = await cached(key, () => (MOCK ? { items: mock.mockAvailability(params), hasMore: false } : client.availability(params, { maxPages: pagesFor(params, 5) })));
  // Ship one compact row per result for the requested cabin; the browser filters and sorts.
  const results = items.map(normalizeAvailability).filter((r) => r.cabins[cabin].available).map((r) => {
    const c = r.cabins[cabin];
    return { id: r.id, date: r.date, origin: r.origin, destination: r.destination, source: r.source, distance: r.distance, miles: c.miles, seats: c.seats, airlines: c.airlines, direct: c.direct, updatedAt: r.updatedAt };
  });
  results.sort((a, b) => a.miles - b.miles);
  return { mock: MOCK, cabin, total: results.length, truncated: hasMore, results };
}

const ALLIANCE_PARAM = { star: 'STAR_ALLIANCE', skyteam: 'SKYTEAM', oneworld: 'ONEWORLD' };
const ALLIANCE_KEY = Object.fromEntries(Object.entries(ALLIANCE_PARAM).map(([k, v]) => [v, k]));
const CABIN_CLASS = { Y: 1, W: 2, J: 3, F: 4 };

async function handleCash(q, req) {
  if (CASH_MODE === 'off') return { configured: false, options: [] };
  if (!cashUnlocked(req)) throw Object.assign(new CashError('需要通關密碼才能查即時票價', 401), { code: 'passcode' });
  const depart = param(q, 'depart', DATE, { required: true });
  const ret = param(q, 'return', DATE);
  const today = new Date().toISOString().slice(0, 10);
  if (depart < today) throw new BadRequest('出發日期不可早於今天');
  if ((new Date(depart) - new Date(today)) / 864e5 > 335) throw new BadRequest('出發日期最多只能查到約 11 個月後');
  if (ret && ret < depart) throw new BadRequest('回程日期不可早於出發日期');
  const alliance = q.get('alliance');
  if (alliance && !ALLIANCE_PARAM[alliance]) throw new BadRequest('聯盟參數錯誤');
  const adults = Number(q.get('adults') || 1);
  if (!Number.isInteger(adults) || adults < 1 || adults > 9) throw new BadRequest('人數需為 1 到 9');
  const stops = Number(q.get('stops') || 0);
  if (![0, 1, 2, 3].includes(stops)) throw new BadRequest('轉機參數錯誤');
  const params = {
    departure_id: param(q, 'origin', IATA_LIST, { required: true, upper: true }),
    arrival_id: param(q, 'destination', IATA_LIST, { required: true, upper: true }),
    outbound_date: depart,
    return_date: ret,
    type: ret ? 1 : 2,
    travel_class: CABIN_CLASS[param(q, 'cabin', /^[YWJF]$/, { upper: true }) || 'Y'],
    adults,
    stops: stops || undefined,
    include_airlines: param(q, 'carriers', CODE_LIST, { upper: true }) || ALLIANCE_PARAM[alliance],
    departure_token: param(q, 'token', /^[\w\-+/=.:]{1,4000}$/),
    booking_token: param(q, 'booking', /^[\w\-+/=.:]{1,4000}$/),
  };
  if (params.departure_token && !ret) throw new BadRequest('只有來回票才能查回程');
  if (params.departure_token && params.booking_token) throw new BadRequest('回程查詢和預訂選項不能同時查');
  const raw = await cached('cash:' + JSON.stringify(params), () => (CASH_MODE === 'mock' ? mock.mockCash(params) : liveCash(params)));
  return { configured: true, mock: CASH_MODE === 'mock', returning: Boolean(params.departure_token), booking: Boolean(params.booking_token), provider: raw.provider || 'mock', fallback: raw.fallback || '', ...normalizeCash(raw) };
}

// A RapidAPI seller's booking page (one more request), fetched when the user presses its button.
async function handleCashLink(q, req) {
  if (!cashUnlocked(req)) throw Object.assign(new CashError('需要通關密碼', 401), { code: 'passcode' });
  const token = param(q, 'token', /^r:[\w\-+/=.:]{1,4000}$/, { required: true });
  if (CASH_MODE === 'mock') return { url: 'https://www.google.com/travel/flights' };
  if (!rapidQuery) throw new CashError('沒有設定 RapidAPI', 503);
  return { url: await cached('cashlink:' + token, () => rapid.bookingUrl({ apiKey: RAPIDAPI_KEY }, token)) };
}

// Searches left this month on each cash source, for the note under the cash search form.
async function handleCashQuota() {
  if (CASH_MODE === 'mock') return { rapid: { left: 142, limit: 150 }, serpapi: { left: 231, limit: 250 }, mock: true };
  if (!cashQuota.rapid && quotaStore) cashQuota.rapid = (await quotaStore.load().catch(() => ({})))?.rapid || null;
  const serp = await serpLeft();
  return {
    rapid: RAPIDAPI_KEY ? { left: cashQuota.rapid?.left ?? null, limit: cashQuota.rapid?.limit ?? 150, at: cashQuota.rapid?.at || null } : null,
    serpapi: SERPAPI_KEY ? { left: serp, limit: cashQuota.serp?.limit ?? 250 } : null,
  };
}

const HOTEL_ID = /^[\w-]{1,64}$/;
function nightsParam(q) {
  const n = Number(q.get('nights') || 1);
  if (!Number.isInteger(n) || n < 1 || n > 5) throw new BadRequest('晚數需為 1 到 5');
  return n;
}
function hotelPrograms(q) {
  const list = (param(q, 'programs', SOURCE_LIST) || '').split(',').filter((x) => rooms.PROGRAMS.includes(x));
  return list.length ? list.join(',') : undefined;
}
// /api/hotels/search (an area), /calendar (one hotel's dates), /rooms (room types of one stay). Cached like the award searches.
async function handleHotels(sub, q) {
  if (sub === 'search') {
    const where = (q.get('where') || '').trim().replace(/\s+/g, ' ');
    if (!where || where.length > 80 || /[<>{}\\]/.test(where)) throw new BadRequest('請輸入城市或地區');
    const params = { location: where, ...dateRange(q), nights: nightsParam(q), source: hotelPrograms(q), take: 100 };
    if ((Date.parse(params.end_date) - Date.parse(params.start_date)) / 864e5 > 92) throw new BadRequest('入住日期範圍最多 3 個月');
    const raw = await cached('rooms:s:' + JSON.stringify(params), () => (MOCK ? mock.mockRoomsSearch(params) : roomsClient.search(params)));
    return { mock: MOCK, ...rooms.normalizeSearch(raw) };
  }
  if (sub === 'calendar') {
    const params = { hotel_id: param(q, 'hotel', HOTEL_ID, { required: true }), ...dateRange(q), nights: nightsParam(q), rate_type: 'any', take: 500 };
    const raw = await cached('rooms:c:' + JSON.stringify(params), () => (MOCK ? mock.mockRoomsAvailability(params) : roomsClient.availability(params)));
    return { mock: MOCK, ...rooms.normalizeAvailability(raw) };
  }
  if (sub === 'rooms') {
    const id = param(q, 'id', HOTEL_ID, { required: true });
    const raw = await cached('rooms:r:' + id, () => (MOCK ? mock.mockRoomsDetail(id) : roomsClient.detail(id)));
    return { mock: MOCK, ...rooms.normalizeDetail(raw) };
  }
  throw new BadRequest('未知的飯店查詢');
}

async function handleTrips(id) {
  if (!/^[\w-]{1,80}$/.test(id)) throw new BadRequest('ID 格式錯誤');
  const raw = await cached('trips:' + id, () => (MOCK ? mock.mockTrips(id) : client.trips(id)));
  return { mock: MOCK, ...normalizeTrips(raw) };
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function serveStatic(res, pathname) {
  const file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) {
      // SPA fallback for unknown paths without an extension.
      if (!path.extname(pathname)) return serveStatic(res, '/');
      return sendJson(res, 404, { error: 'not found' });
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const q = url.searchParams;
  const p = url.pathname;
  try {
    if (p === '/api/alerts' || p === '/api/alerts/run') {
      if (!['GET', 'POST', 'DELETE'].includes(req.method)) return sendJson(res, 405, { error: 'method not allowed' });
      return sendJson(res, 200, await handleAlerts(req, q, p.endsWith('/run') ? 'run' : ''));
    }
    if (p === '/api/watch') {
      if (!['GET', 'POST', 'DELETE'].includes(req.method)) return sendJson(res, 405, { error: 'method not allowed' });
      return sendJson(res, 200, await handleWatch(req, q));
    }
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
    if (p === '/api/config') {
      return sendJson(res, 200, {
        mock: MOCK, callsToday: usage.calls, dailyLimit: 1000, cash: CASH_MODE, cashSources: { rapid: Boolean(RAPIDAPI_KEY), serpapi: Boolean(SERPAPI_KEY) }, cashLocked: Boolean(cashPasscode()),
        alerts: { store: Boolean(alerts), email: Boolean(alertMailer) }, watch: Boolean(priceWatch),
        hotels: { callsToday: roomsUsage.day === new Date().toISOString().slice(0, 10) ? roomsUsage.calls : 0, dailyLimit: 1000 },
        // Which deployment is answering, to confirm a redeploy went live.
        commit: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7),
        repo: process.env.VERCEL_GIT_REPO_OWNER && process.env.VERCEL_GIT_REPO_SLUG ? `https://github.com/${process.env.VERCEL_GIT_REPO_OWNER}/${process.env.VERCEL_GIT_REPO_SLUG}` : '',
        version: VERSION.version, updated: VERSION.updated, history: (VERSION.history || []).slice(0, 10),
      });
    }
    if (p === '/api/cash') return sendJson(res, 200, await handleCash(q, req));
    if (p === '/api/cash/link') return sendJson(res, 200, await handleCashLink(q, req));
    if (p === '/api/cash/quota') return sendJson(res, 200, await handleCashQuota());
    const hm = p.match(/^\/api\/hotels\/(search|calendar|rooms)$/);
    if (hm) return sendJson(res, 200, await handleHotels(hm[1], q));
    if (p === '/api/fx') return sendJson(res, 200, await handleFx());
    if (p === '/api/deals') return sendJson(res, 200, await handleDeals());
    if (p === '/api/search') return sendJson(res, 200, await handleSearch(q));
    if (p === '/api/explore') return sendJson(res, 200, await handleExplore(q));
    if (p.startsWith('/api/trips/')) {
      let id;
      try { id = decodeURIComponent(p.slice(11)); } catch { throw new BadRequest('網址編碼錯誤'); }
      return sendJson(res, 200, await handleTrips(id));
    }
    const m = p.match(/^\/api\/data\/(\w+)$/);
    if (m && DATA_FILES.includes(m[1])) {
      res.writeHead(200, { 'content-type': MIME['.json'] });
      return fs.createReadStream(path.join(DATA_DIR, (m[1] === 'sourcenames' ? 'source-names' : m[1]) + '.json')).pipe(res);
    }
    if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });
    serveStatic(res, p);
  } catch (e) {
    if (e instanceof BadRequest) return sendJson(res, 400, { error: e.message });
    if (e instanceof SeatsAeroError || e instanceof CashError || e instanceof AlertError || e instanceof rooms.RoomsError) return sendJson(res, e.status, { error: e.message, code: e.code });
    console.error(e);
    sendJson(res, 500, { error: '伺服器錯誤' });
  }
}

const server = http.createServer(route);
if (require.main === module) {
  server.listen(PORT, () => console.log(`http://localhost:${PORT}  ${MOCK ? '(示範資料模式：未設定 SEATS_AERO_API_KEY)' : '(使用 seats.aero API)'}`));
}
module.exports = { server, route };
