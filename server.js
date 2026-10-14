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
const { createTravelInfo } = require('./lib/travelinfo');
const { createDirects, DirectsError } = require('./lib/aerodatabox');
const hotelCash = require('./lib/hotelcash');
const { redisKv, memoryKv, takeLock, sharedCache, KvError } = require('./lib/kv');
const { todayTW, monthTW, validDate } = require('./lib/day');
const tg = require('./lib/telegram');

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.SEATS_AERO_API_KEY || '';
const MOCK = !API_KEY || process.env.MOCK === '1';
const SERPAPI_KEY = process.env.SERPAPI_KEY || '';
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '';
// Cash fares: RapidAPI's Google Flights first (150 free a month), SerpApi as the fallback; demo data in demo mode, otherwise off.
const CASH_MODE = SERPAPI_KEY || RAPIDAPI_KEY ? 'live' : MOCK ? 'mock' : 'off';
// Upstash Redis (Vercel Storage tab) keeps alerts, watches, deals and the shared caches; without it they live in memory.
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '';
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
const HAS_REDIS = Boolean(REDIS_URL && REDIS_TOKEN);
const kv = HAS_REDIS ? redisKv({ url: REDIS_URL, token: REDIS_TOKEN }) : memoryKv();
const CACHE_TTL_MS = (Number(process.env.CACHE_TTL_SECONDS) || 1800) * 1000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILES = ['airlines', 'alliances', 'airports', 'programs', 'glossary', 'asiamiles', 'sourcenames', 'points', 'booking', 'charts', 'products', 'promos'];
// Shown in the page footer; bump with `node scripts/bump-version.js`.
const VERSION = require('./data/version.json');

// seats.aero's daily quota resets at 00:00 UTC, so this counter (shown as "calls today") stays on UTC days.
const usage = { day: '', calls: 0 };
function countCall() {
  const today = new Date().toISOString().slice(0, 10);
  if (usage.day !== today) Object.assign(usage, { day: today, calls: 0 });
  usage.calls++;
}

// Keeps background work alive after the response on Vercel (the hook @vercel/functions' waitUntil uses); elsewhere it simply runs.
function defer(p) {
  const safe = Promise.resolve(p).catch((e) => console.error('background', e.message));
  globalThis[Symbol.for('@vercel/request-context')]?.get?.()?.waitUntil?.(safe);
  return safe;
}

// SerpApi credits this site spent this month (Taiwan calendar month), counted in Redis so every instance sees them all.
const serpKey = (kind) => `serp:used:${monthTW()}${kind ? `:${kind}` : ''}`;
function countSerp(kind) {
  kv.incr(serpKey(), 1, 40 * 86400).catch(() => {});
  kv.incr(serpKey(kind), 1, 40 * 86400).catch(() => {});
}
const serpUsed = async (kind) => Number(await kv.get(serpKey(kind)).catch(() => 0)) || 0;

const client = createClient({ apiKey: API_KEY, onCall: countCall });
const cashQuery = createCashClient({ apiKey: SERPAPI_KEY, onCall: () => countSerp('flights') });
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
const quotaStore = HAS_REDIS ? redisStore({ url: REDIS_URL, token: REDIS_TOKEN, key: 'cash-quota:v1' }) : null;
const cashQuota = { rapid: null, serp: null };
const rapidQuery = RAPIDAPI_KEY && rapid.createRapidFlights({
  apiKey: RAPIDAPI_KEY,
  kv,
  onQuota: ({ left, limit }) => {
    cashQuota.rapid = { left, limit, at: new Date().toISOString() };
    quotaStore?.save({ rapid: cashQuota.rapid }).catch(() => {});
  },
});
// SerpApi's account endpoint is free and reports the searches left this month; asked at most every 10 minutes per
// instance. In between, credits spent since (by any instance, from the Redis counter) are taken off.
async function serpLeft() {
  if (!SERPAPI_KEY) return null;
  const usedNow = await serpUsed();
  const estimate = () => (cashQuota.serp?.left == null ? null : Math.max(0, cashQuota.serp.left - Math.max(0, usedNow - (cashQuota.serp.usedAt ?? usedNow))));
  if (cashQuota.serp && Date.now() - Date.parse(cashQuota.serp.at) < 600e3) return estimate();
  try {
    const res = await fetch(`https://serpapi.com/account.json?api_key=${encodeURIComponent(SERPAPI_KEY)}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return estimate();
    const a = await res.json();
    const left = Number.isFinite(a.total_searches_left) ? a.total_searches_left : Number.isFinite(a.plan_searches_left) ? a.plan_searches_left : null;
    cashQuota.serp = { left, limit: Number.isFinite(a.searches_per_month) ? a.searches_per_month : null, at: new Date().toISOString(), usedAt: usedNow };
    return left;
  } catch { return estimate(); }
}
const ALLIANCE_CARRIERS = Object.fromEntries(require('./data/alliances.json').alliances.map((a) => [a.id, new Set(a.members || a.carriers || [])]));
// One live cash lookup. Tokens go back to whoever issued them; a new search tries RapidAPI first (single airports only,
// it takes no city lists) and falls back to SerpApi when RapidAPI fails or runs out, if `allowSerp` agrees.
async function liveCash(params, { allowSerp = async () => true } = {}) {
  // RapidAPI has no alliance filter, so it is applied here, on the outbound list and on the return leg alike.
  const inc = params.include_airlines;
  const allianceCarriers = !inc ? null : ALLIANCE_KEY[inc] ? ALLIANCE_CARRIERS[ALLIANCE_KEY[inc]] : new Set(inc.split(','));
  if (rapid.isRapidToken(params.departure_token) || rapid.isRapidToken(params.booking_token)) return { ...(await rapidQuery({ ...params, allianceCarriers })), provider: 'rapid' };
  if (params.departure_token || params.booking_token) return { ...(await cashQuery(params)), provider: 'serpapi' };
  let fallback = '';
  const single = /^[A-Z]{3}$/.test(params.departure_id) && /^[A-Z]{3}$/.test(params.arrival_id);
  if (rapidQuery && single) {
    try {
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

// Per-instance cache of finished answers (normalized, not the raw upstream bodies). It holds the Promise, so identical
// requests arriving together share one upstream call, and it is capped by size as well as count.
const cache = new Map();
const CACHE_MAX_BYTES = 64 * 2 ** 20;
let cacheBytes = 0;
function uncache(key) {
  const e = cache.get(key);
  if (e) { cacheBytes -= e.bytes; cache.delete(key); }
}
function cached(key, fn, ttlMs = CACHE_TTL_MS) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.promise;
  uncache(key);
  const entry = { promise: Promise.resolve().then(fn), expires: Date.now() + ttlMs, bytes: 0 };
  cache.set(key, entry);
  entry.promise.then((v) => {
    if (cache.get(key) !== entry) return;
    entry.bytes = (JSON.stringify(v) || '').length;
    cacheBytes += entry.bytes;
    while ((cacheBytes > CACHE_MAX_BYTES || cache.size > 500) && cache.size > 1) uncache(cache.keys().next().value);
  }, () => { if (cache.get(key) === entry) cache.delete(key); });
  return entry.promise;
}
// Paid lookups: the per-instance cache in front of one shared through Redis (see lib/kv.js sharedCache), so a refresh
// on another instance or a double click costs no quota. `key` describes the query only, never the passcode.
const shared = (key, ttlSec, fn) => cached(key, () => sharedCache(kv, key, ttlSec, fn), Math.min(ttlSec * 1000, CACHE_TTL_MS));
const lockFor = (name, seconds) => () => takeLock(kv, name, seconds);

class BadRequest extends Error {}

// Airport → country and coordinates, for the pre-trip notes.
const AIRPORTS = new Map(require('./public/airports.min.json').airports.map(([code, , , country, , , , , lat, lon]) => [code, { country, lat, lon }]));
const VISA = require('./data/visa.json');
const WARNINGS = require('./data/warnings.json');
const travelInfo = createTravelInfo({ visa: VISA.countries, warnings: WARNINGS.countries });
async function handleTripInfo(q) {
  const to = param(q, 'to', /^[A-Z]{3}$/, { required: true, upper: true });
  const { start_date: start, end_date: end } = dateRange(q);
  const place = AIRPORTS.get(to);
  if (!place) throw new BadRequest('找不到這個機場');
  const info = await travelInfo.forTrip(place, start, end, { withWeather: q.get('only') !== 'holidays' });
  return { airport: to, ...info, sources: { visa: { name: VISA.source, url: VISA.sourceUrl, asOf: VISA.asOf }, warning: { name: WARNINGS.source, url: WARNINGS.sourceUrl, asOf: WARNINGS.asOf } } };
}

// Seat alerts: Upstash Redis keeps the watches, Resend sends the mail. Demo mode keeps them in memory.
const alertStore = HAS_REDIS ? redisStore({ url: REDIS_URL, token: REDIS_TOKEN }) : MOCK ? memoryStore() : null;
const alertMailer = process.env.RESEND_API_KEY ? resendMailer({ apiKey: process.env.RESEND_API_KEY, from: process.env.ALERT_FROM }) : null;
const SITE_URL = process.env.SITE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '');
const SOURCE_NAMES = require('./data/source-names.json').names;
// Telegram: the owner's own bot (TELEGRAM_BOT_TOKEN from @BotFather), linked to their chat from the site. The demo
// without a token gets a stand-in bot so the linking flow can be tried.
const TELEGRAM_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const telegram = tg.createTelegram({ client: TELEGRAM_TOKEN ? tg.telegramClient({ token: TELEGRAM_TOKEN }) : MOCK ? tg.mockTelegramClient() : null, kv });
const TELEGRAM_MOCK = !TELEGRAM_TOKEN && MOCK;
const alerts = alertStore && createAlerts({
  store: alertStore,
  sendEmail: alertMailer,
  notify: (html) => telegram.notify(html),
  siteUrl: SITE_URL,
  programNames: SOURCE_NAMES,
  // Cheapest seats first, one page of 1,000 (two for ranges over four months): what an alert mail lists anyway.
  search: (params) => cached('alert:' + JSON.stringify(params), async () => {
    const p = { ...params, order_by: 'lowest_mileage', take: 1000 };
    const { items } = MOCK ? { items: mock.mockSearch(p) } : await client.search(p, { maxPages: pagesFor(p, 1, 120) });
    return items.map(normalizeAvailability);
  }),
});
// Daily deals from Taipei, refreshed by the daily cron and kept in the same Redis. The demo looks two months ahead
// (its made-up searches are slow over a whole year).
const deals = createDeals({
  store: HAS_REDIS ? redisStore({ url: REDIS_URL, token: REDIS_TOKEN, key: 'award-deals:v1' }) : memoryStore(null),
  days: MOCK ? 60 : 330,
  lock: (name, seconds) => takeLock(kv, name, seconds),
  defer,
  search: (params) => cached('deals:' + JSON.stringify(params), async () => {
    const { items } = MOCK ? { items: mock.mockSearch(params) } : await client.search(params, { maxPages: 1 });
    return items.map(normalizeAvailability);
  }),
});
// Cash price tracking: same Redis and mailer as the seat alerts; each check spends one search credit, so lib/pricewatch spaces them out and caps them.
const watchStore = CASH_MODE === 'off' ? null : HAS_REDIS ? redisStore({ url: REDIS_URL, token: REDIS_TOKEN, key: 'price-watch:v1' }) : CASH_MODE === 'mock' ? memoryStore(null) : null;
const priceWatch = watchStore && createPriceWatch({
  store: watchStore,
  sendEmail: alertMailer,
  notify: (html) => telegram.notify(html),
  siteUrl: SITE_URL,
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
  // Concurrent first visitors share one read (or the very first build) instead of each spending API calls.
  dealsPending ||= deals.get().finally(() => { dealsPending = null; });
  return { mock: MOCK, ...(await dealsPending) };
}

const safeEqual = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
// Vercel's cron calls the run endpoint with `Authorization: Bearer $CRON_SECRET`; people use the passcode (when one is set).
function alertsAllowed(req) {
  const secret = (process.env.CRON_SECRET || '').trim();
  if (secret && safeEqual(String(req.headers.authorization || ''), `Bearer ${secret}`)) return true;
  return cashUnlocked(req);
}
// Who may start the daily run, which spends seats.aero, RapidAPI and mail: the cron (its secret) or the owner (the
// passcode). With neither set, nobody, except in the demo, which spends nothing.
function runCaller(req) {
  const secret = (process.env.CRON_SECRET || '').trim();
  if (secret && safeEqual(String(req.headers.authorization || ''), `Bearer ${secret}`)) return 'cron';
  if (cashPasscode()) return cashUnlocked(req) ? 'owner' : null;
  return MOCK && CASH_MODE !== 'live' && !secret ? 'owner' : null;
}
function readJson(req, limit = 10_000) {
  return new Promise((resolve, reject) => {
    let data = '';
    let over = false;
    req.on('data', (chunk) => {
      // Past the limit, the rest of the body is read and thrown away instead of being kept in memory.
      if (over) return;
      data += chunk;
      if (data.length > limit) { over = true; data = ''; reject(new BadRequest('內容太長')); }
    });
    req.on('end', () => {
      if (over) return;
      let body;
      try { body = data ? JSON.parse(data) : {}; } catch { return reject(new BadRequest('JSON 格式錯誤')); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return reject(new BadRequest('JSON 格式錯誤'));
      resolve(body);
    });
    req.on('error', reject);
  });
}

// The daily run (Vercel cron, 00:10 UTC = 08:10 Taiwan, just after seats.aero's quota resets, plus a catch-up an hour
// later): deals, then price watches, then seat alerts, in one 60-second function. Each part saves item by item and
// stops starting new items near the time limit, so a cut-off run loses nothing and the catch-up run (or tomorrow's)
// finishes the rest; work already done today is skipped. `?part=deals,watches,alerts` runs only those parts.
const RUN_BUDGET = { deals: 20e3, watches: 28e3, alerts: 48e3 };
async function runDaily(req, q) {
  const who = runCaller(req);
  if (!who) throw Object.assign(new CashError('需要通關密碼才能執行檢查', 401), { code: 'passcode' });
  const t0 = Date.now();
  const parts = new Set((q.get('part') || 'deals,watches,alerts').split(','));
  const out = { configured: Boolean(alerts), email: Boolean(alertMailer), by: who };
  if (parts.has('deals')) {
    try {
      const d = await deals.refresh({ deadline: t0 + RUN_BUDGET.deals, skipFresh: true });
      out.deals = d.groups.reduce((n, g) => n + g.items.length, 0);
      const errs = d.groups.filter((g) => g.error);
      if (errs.length) out.dealsError = `${errs.length} 組更新失敗：${errs[0].error}`;
    } catch (e) { out.dealsError = e.message; }
  }
  if (parts.has('watches') && priceWatch) {
    out.watches = await priceWatch.run({ deadline: t0 + RUN_BUDGET.watches, lock: lockFor('price-watch:run', 120) }).catch((e) => ({ error: e.message }));
  }
  if (parts.has('alerts') && alerts) Object.assign(out, await alerts.run({ deadline: t0 + RUN_BUDGET.alerts, force: who !== 'cron', lock: lockFor('alerts:run', 120) }));
  return { checked: 0, report: [], ...out };
}
async function handleAlerts(req, q, sub) {
  if (sub === 'run') return runDaily(req, q);
  if (!alerts) return { configured: false, email: false, alerts: [] };
  if (!alertsAllowed(req)) throw Object.assign(new CashError('需要通關密碼才能管理提醒', 401), { code: 'passcode' });
  if (req.method === 'POST') return { configured: true, ...(await alerts.add(await readJson(req))) };
  if (req.method === 'DELETE') { await alerts.remove(String(q.get('id') || '')); return { ok: true }; }
  return { configured: true, email: Boolean(alertMailer), alerts: await alerts.list() };
}

// /api/telegram: GET status, POST /api/telegram/link links the newest chat that sent /start to the bot, DELETE unlinks.
// Linking decides where the owner's alerts go, so it needs the passcode to be set (except in the demo).
async function handleTelegram(req, sub) {
  const ok = cashPasscode() ? cashUnlocked(req) : TELEGRAM_MOCK;
  if (!ok) throw Object.assign(new CashError(cashPasscode() ? '需要通關密碼才能設定 Telegram' : '要先在 Vercel 設定 CASH_PASSCODE，才能連結 Telegram', 401), { code: 'passcode' });
  const mock = TELEGRAM_MOCK ? { mock: true } : {};
  if (sub === 'link') {
    if (req.method !== 'POST') throw new BadRequest('請用 POST');
    return { ...(await telegram.link()), ...mock };
  }
  if (sub) throw new BadRequest('未知的 Telegram 操作');
  if (req.method === 'DELETE') return { ...(await telegram.unlink()), ...mock };
  if (req.method !== 'GET') throw new BadRequest('請用 GET 或 DELETE');
  return { ...(await telegram.status()), ...mock };
}

// Optional passcode that gates the cash-fare lookups (each one spends a SerpApi credit). Read per request so tests can set it.
const cashPasscode = () => (process.env.CASH_PASSCODE || '').trim();
function cashUnlocked(req) {
  const want = cashPasscode();
  if (!want) return true;
  return safeEqual(String(req.headers['x-cash-pass'] || ''), want);
}

// TWD per unit of each currency, for converting award taxes. Refreshed daily from a free rate feed; the table is the fallback.
const FX_FALLBACK = { USD: 31.96, CAD: 22.42, EUR: 35.81, GBP: 42.3, JPY: 0.202, HKD: 4.07, AUD: 22.32, SGD: 24.96, KRW: 0.0225, CNY: 4.45, NZD: 19.3, CHF: 39.5, THB: 0.95, MYR: 7.4, INR: 0.36, BRL: 5.9, MXN: 1.72, AED: 8.7, QAR: 8.78, TRY: 0.78, SEK: 3.3, DKK: 4.8, NOK: 3.1, TWD: 1 };
let fxCache = { expires: 0, body: null };
let fxPending = null;
async function loadFx() {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(5000) });
    const j = res.ok ? await res.json() : {};
    if (j.result === 'success' && j.rates?.TWD) {
      const rates = {};
      for (const [cur, perUsd] of Object.entries(j.rates)) if (perUsd > 0) rates[cur] = Math.round((j.rates.TWD / perUsd) * 1e4) / 1e4;
      const body = { rates, updated: new Date(j.time_last_update_unix * 1000).toISOString().slice(0, 10), live: true, provider: 'exchangerate-api.com' };
      fxCache = { expires: Date.now() + 24 * 3600e3, body };
      return body;
    }
  } catch { /* fall through */ }
  // The feed failed: keep the last live rates if this instance has them, else the table, and try again in 10 minutes.
  const body = fxCache.body?.live ? fxCache.body : { rates: FX_FALLBACK, updated: '2026-10-12', live: false };
  fxCache = { expires: Date.now() + 600e3, body };
  return body;
}
async function handleFx() {
  if (fxCache.expires > Date.now()) return fxCache.body;
  fxPending ||= loadFx().finally(() => { fxPending = null; });
  return fxPending;
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
  // 2026-13-45 matches the pattern but is no day at all; it must not reach a paid API.
  if (re === DATE && !validDate(v)) throw new BadRequest(`參數 ${name} 不是有效的日期`);
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

// Longer date ranges return more rows, so allow more result pages (each page is one API call): `base` pages plus one
// for every `per` days.
const pagesFor = (p, base, per = 90) => base + Math.floor((new Date(p.end_date) - new Date(p.start_date)) / 864e5 / per);

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
  if ((new Date(params.end_date) - new Date(params.start_date)) / 864e5 <= 45) params.include_trips = true;
  // Pages of 1,000: one call up to five months, three for a whole year.
  const out = await cached('search:' + JSON.stringify(params), async () => {
    const { items, hasMore } = MOCK ? { items: mock.mockSearch(params), hasMore: false } : await client.search({ ...params, take: 1000 }, { maxPages: pagesFor(params, 1, 150) });
    return { truncated: hasMore, results: items.map(normalizeAvailability) };
  });
  return { mock: MOCK, truncated: out.truncated, withTaxes: Boolean(params.include_trips), results: out.results };
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
  // Ship one compact row per result for the requested cabin; the browser filters and sorts.
  return cached('explore:' + JSON.stringify(params), async () => {
    const { items, hasMore } = MOCK ? { items: mock.mockAvailability(params), hasMore: false } : await client.availability(params, { maxPages: pagesFor(params, 3) });
    const results = items.map(normalizeAvailability).filter((r) => r.cabins[cabin].available).map((r) => {
      const c = r.cabins[cabin];
      return { id: r.id, date: r.date, origin: r.origin, destination: r.destination, source: r.source, distance: r.distance, miles: c.miles, seats: c.seats, airlines: c.airlines, direct: c.direct, updatedAt: r.updatedAt };
    });
    results.sort((a, b) => a.miles - b.miles);
    return { mock: MOCK, cabin, total: results.length, truncated: hasMore, results };
  });
}

const ALLIANCE_PARAM = { star: 'STAR_ALLIANCE', skyteam: 'SKYTEAM', oneworld: 'ONEWORLD' };
const ALLIANCE_KEY = Object.fromEntries(Object.entries(ALLIANCE_PARAM).map(([k, v]) => [v, k]));
const CABIN_CLASS = { Y: 1, W: 2, J: 3, F: 4 };

async function handleCash(q, req) {
  if (CASH_MODE === 'off') return { configured: false, options: [] };
  if (!cashUnlocked(req)) throw Object.assign(new CashError('需要通關密碼才能查即時票價', 401), { code: 'passcode' });
  const depart = param(q, 'depart', DATE, { required: true });
  const ret = param(q, 'return', DATE);
  const today = todayTW();
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
  let spent = false;
  const raw = await shared('cash:' + JSON.stringify(params), 1800, async () => { spent = true; return CASH_MODE === 'mock' ? mock.mockCash(params) : liveCash(params); });
  return { configured: true, mock: CASH_MODE === 'mock', cached: !spent, returning: Boolean(params.departure_token), booking: Boolean(params.booking_token), provider: raw.provider || 'mock', fallback: raw.fallback || '', ...normalizeCash(raw) };
}

// Who flies nonstop (AeroDataBox). Each origin airport costs 6 of ~400 monthly units, then stays cached for two weeks
// in Redis. Anyone may ask about Taiwan's airports and a few hubs; other origins need the passcode unless cached.
// A monthly unit counter stops new lookups while 40 units are left.
const DIRECTS_OPEN = new Set(['TPE', 'TSA', 'KHH', 'RMQ', 'TNN', 'HKG', 'NRT', 'HND', 'KIX', 'ICN', 'BKK', 'SIN']);
const DIRECTS_UNITS = Number(process.env.DIRECTS_MONTHLY_UNITS) || 400;
const DIRECTS_RESERVE = 40;
const directsQuota = { left: null, limit: null };
async function spendDirectsUnits(n) {
  if (directsQuota.left != null && directsQuota.left - n < DIRECTS_RESERVE) return false;
  const key = `directs:units:${monthTW()}`;
  const used = await kv.incr(key, n, 40 * 86400).catch(() => null);
  if (used != null && DIRECTS_UNITS - used < DIRECTS_RESERVE) { await kv.incr(key, -n).catch(() => {}); return false; }
  return true;
}
const directs = RAPIDAPI_KEY && createDirects({
  apiKey: RAPIDAPI_KEY,
  kv,
  legacy: HAS_REDIS ? redisStore({ url: REDIS_URL, token: REDIS_TOKEN, key: 'directs:v1' }) : null,
  spend: spendDirectsUnits,
  onQuota: (q) => Object.assign(directsQuota, q),
});
async function handleDirects(q, req) {
  const from = param(q, 'from', /^[A-Z]{3}(,[A-Z]{3}){0,2}$/, { required: true, upper: true }).split(',');
  const to = param(q, 'to', IATA_LIST, { required: true, upper: true }).split(',');
  const open = from.every((o) => DIRECTS_OPEN.has(o));
  if (MOCK && !directs) return { body: { configured: true, mock: true, ...mock.mockDirects(from, to) }, open };
  if (!directs) return { body: { configured: false }, open };
  const unlocked = cashUnlocked(req);
  try {
    return { body: { configured: true, ...(await directs.between(from, to, { canFetch: (o) => DIRECTS_OPEN.has(o) || unlocked })), quota: directsQuota.left }, open };
  } catch (e) {
    // Not a list airport and not cached: the line is simply left out for visitors.
    if (e.locked) return { body: { configured: false, locked: true }, open: false };
    throw e;
  }
}

// Google Flights' lowest fare per departure day (RapidAPI, one request per call), for the month view in the cash tab.
async function handleCashCalendar(q, req) {
  if (CASH_MODE === 'off') return { configured: false, days: [] };
  if (!cashUnlocked(req)) throw Object.assign(new CashError('需要通關密碼才能查即時票價', 401), { code: 'passcode' });
  const { start_date: start, end_date: end } = dateRange(q);
  if (start < todayTW()) throw new BadRequest('開始日期不可早於今天');
  if ((Date.parse(end) - Date.parse(start)) / 864e5 > 61) throw new BadRequest('一次最多查 2 個月');
  const tripDays = Number(q.get('trip_days') || 0);
  if (!Number.isInteger(tripDays) || tripDays < 0 || tripDays > 60) throw new BadRequest('天數參數錯誤');
  const adults = Number(q.get('adults') || 1);
  if (!Number.isInteger(adults) || adults < 1 || adults > 9) throw new BadRequest('人數需為 1 到 9');
  const params = {
    departure_id: param(q, 'origin', /^[A-Z]{3}$/, { required: true, upper: true }),
    arrival_id: param(q, 'destination', /^[A-Z]{3}$/, { required: true, upper: true }),
    start_date: start, end_date: end, trip_days: tripDays || undefined,
    travel_class: CABIN_CLASS[param(q, 'cabin', /^[YWJF]$/, { upper: true }) || 'Y'], adults,
  };
  if (CASH_MODE === 'mock') return { configured: true, mock: true, ...mock.mockCashCalendar(params) };
  if (!rapidQuery) throw new CashError('整月價格要用 RapidAPI 的 Google Flights API，網站還沒設定 RAPIDAPI_KEY', 503);
  let spent = false;
  const body = await shared('cashcal:' + JSON.stringify(params), 3600, () => { spent = true; return rapidQuery.calendar(params); });
  return { configured: true, provider: 'rapid', cached: !spent, ...body };
}

// A RapidAPI seller's booking page (one more request), fetched when the user presses its button.
async function handleCashLink(q, req) {
  if (!cashUnlocked(req)) throw Object.assign(new CashError('需要通關密碼', 401), { code: 'passcode' });
  const token = param(q, 'token', /^r:[\w\-+/=.:]{1,4000}$/, { required: true });
  if (CASH_MODE === 'mock') return { url: 'https://www.google.com/travel/flights' };
  if (!rapidQuery) throw new CashError('沒有設定 RapidAPI', 503);
  return { url: await shared('cashlink:' + token, 1800, () => rapid.bookingUrl({ apiKey: RAPIDAPI_KEY }, token)) };
}

// Searches left this month on each cash source, for the note under the cash search form.
async function handleCashQuota() {
  if (CASH_MODE === 'mock') return { rapid: { left: 142, limit: 150 }, serpapi: { left: 231, limit: 250, used: await serpUsed() }, mock: true };
  if (!cashQuota.rapid && quotaStore) cashQuota.rapid = (await quotaStore.load().catch(() => ({})))?.rapid || null;
  const serp = await serpLeft();
  return {
    rapid: RAPIDAPI_KEY ? { left: cashQuota.rapid?.left ?? null, limit: cashQuota.rapid?.limit ?? 150, at: cashQuota.rapid?.at || null } : null,
    // `used`: credits this site spent this calendar month (Taiwan time), by flights and hotels.
    serpapi: SERPAPI_KEY ? { left: serp, limit: cashQuota.serp?.limit ?? 250, used: await serpUsed(), usedBy: { flights: await serpUsed('flights'), hotels: await serpUsed('hotels') } } : null,
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
    return cached('rooms:s:' + JSON.stringify(params), async () => ({ mock: MOCK, ...rooms.normalizeSearch(MOCK ? mock.mockRoomsSearch(params) : await roomsClient.search(params)) }));
  }
  if (sub === 'calendar') {
    const params = { hotel_id: param(q, 'hotel', HOTEL_ID, { required: true }), ...dateRange(q), nights: nightsParam(q), rate_type: 'any', take: 500 };
    return cached('rooms:c:' + JSON.stringify(params), async () => ({ mock: MOCK, ...rooms.normalizeAvailability(MOCK ? mock.mockRoomsAvailability(params) : await roomsClient.availability(params)) }));
  }
  if (sub === 'rooms') {
    const id = param(q, 'id', HOTEL_ID, { required: true });
    return cached('rooms:r:' + id, async () => ({ mock: MOCK, ...rooms.normalizeDetail(MOCK ? mock.mockRoomsDetail(id) : await roomsClient.detail(id)) }));
  }
  throw new BadRequest('未知的飯店查詢');
}

// One hotel's cash prices for the stay a points price was shown for. Spends paid lookups, so it sits behind the passcode.
// src=serpapi: every booking site incl. the hotel's own (1–2 SerpApi credits); src=booking: Booking.com via RapidAPI (2 requests,
// 1 for a hotel looked up before). SerpApi failing or missing falls back to Booking.com. Answers are shared for 30 minutes.
const serpHotelLookup = SERPAPI_KEY && hotelCash.serpHotels({ apiKey: SERPAPI_KEY, onCall: () => countSerp('hotels') });
const bookingQuota = { left: null, limit: null };
const bookingLookup = RAPIDAPI_KEY && hotelCash.bookingHotels({ apiKey: RAPIDAPI_KEY, kv, onQuota: (q) => Object.assign(bookingQuota, q) });
async function handleHotelCash(q, req) {
  if (!cashUnlocked(req)) throw Object.assign(new CashError('需要通關密碼才能查飯店現金價', 401), { code: 'passcode' });
  const name = (q.get('name') || '').trim().replace(/\s+/g, ' ');
  if (!name || name.length > 120 || /[<>{}\\]/.test(name)) throw new BadRequest('缺少飯店名稱');
  const city = (q.get('city') || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  const checkin = param(q, 'checkin', DATE, { required: true });
  const checkout = param(q, 'checkout', DATE, { required: true });
  const n = (Date.parse(checkout) - Date.parse(checkin)) / 864e5;
  if (n < 1 || n > 14) throw new BadRequest('住宿晚數需為 1 到 14 晚');
  if (checkin < todayTW()) throw new BadRequest('入住日期不可早於今天');
  const adults = Number(q.get('adults') || 2);
  if (!Number.isInteger(adults) || adults < 1 || adults > 6) throw new BadRequest('人數需為 1 到 6');
  const lat = Number(q.get('lat')); const lon = Number(q.get('lon'));
  const want = { name, city: /[<>{}]/.test(city) ? '' : city, checkin, checkout, adults, lat: Number.isFinite(lat) && q.get('lat') ? lat : null, lon: Number.isFinite(lon) && q.get('lon') ? lon : null };
  const src = q.get('src') === 'booking' ? 'booking' : 'serpapi';
  if (MOCK && !SERPAPI_KEY && !RAPIDAPI_KEY) return { mock: true, ...mock.mockHotelCash(want, src) };
  let fallback = '';
  let spent = false;
  if (src === 'serpapi' && serpHotelLookup) {
    try {
      const body = await shared('hcash:serpapi:' + JSON.stringify(want), 1800, () => { spent = true; return serpHotelLookup(want); });
      return { ...body, cached: !spent, serpLeft: await serpLeft() };
    } catch (e) {
      if (!(e instanceof hotelCash.HotelCashError) || !bookingLookup) throw e;
      fallback = e.message;
    }
  } else if (src === 'serpapi') fallback = '沒有設定 SerpApi';
  if (!bookingLookup) throw new hotelCash.HotelCashError('沒有設定飯店現金價的資料來源', 503);
  spent = false;
  const body = await shared('hcash:booking:' + JSON.stringify(want), 1800, () => { spent = true; return bookingLookup(want); });
  // Booking.com may answer in another currency; convert with the same daily rates as the award taxes.
  let total = body.total;
  if (total && body.currency && body.currency !== 'TWD') {
    const rate = (await handleFx()).rates[body.currency];
    total = rate ? total * rate : null;
  }
  return { ...body, cached: !spent, total: total ? Math.round(total) : null, currency: 'TWD', fallback, bookingLeft: bookingQuota.left, bookingLimit: bookingQuota.limit };
}

async function handleTrips(id) {
  if (!/^[\w-]{1,80}$/.test(id)) throw new BadRequest('ID 格式錯誤');
  return cached('trips:' + id, async () => ({ mock: MOCK, ...normalizeTrips(MOCK ? mock.mockTrips(id) : await client.trips(id)) }));
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

// Cache policies. Public answers may sit in Vercel's CDN (s-maxage), keyed by the full URL, so a repeated search costs
// no function call and no seats.aero call from any instance. Never for anything behind the passcode: the CDN key does
// not include the x-cash-pass header, so a cached answer would be handed to people without it.
const CACHE = {
  search: 'public, max-age=60, s-maxage=1800, stale-while-revalidate=600',
  tripInfo: 'public, max-age=600, s-maxage=21600, stale-while-revalidate=3600',
  directs: 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400',
  fx: 'public, max-age=600, s-maxage=3600, stale-while-revalidate=3600',
  deals: 'public, max-age=300, s-maxage=3600, stale-while-revalidate=3600',
  short: 'public, max-age=0, s-maxage=60',
  data: 'public, max-age=300, s-maxage=3600',
  immutable: 'public, max-age=31536000, immutable',
};

// Errors are never cached.
function sendJson(res, status, body, cache) {
  res.writeHead(status, { 'content-type': MIME['.json'], 'cache-control': status === 200 && cache ? cache : 'no-store' });
  res.end(JSON.stringify(body));
}

// A fixed body with a validator: answers If-None-Match with 304, and HEAD with headers only.
const etagOf = (buf) => `"${crypto.createHash('sha1').update(buf).digest('base64url').slice(0, 20)}"`;
function sendBody(req, res, { body, type, etag, cache, modified }) {
  const headers = { 'cache-control': cache, etag, ...(modified ? { 'last-modified': modified } : {}) };
  const inm = String(req.headers['if-none-match'] || '');
  const strip = (t) => t.trim().replace(/^W\//, '');
  if (inm && inm.split(',').some((t) => t.trim() === '*' || strip(t) === strip(etag))) {
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, { ...headers, 'content-type': type, 'content-length': Buffer.byteLength(body) });
  res.end(req.method === 'HEAD' ? undefined : body);
}

// The data files, read once: one by one at /api/data/<name>, or all together at /api/data/all (one request at start-up
// instead of twelve). /api/data/all?v=<current version> never changes, so the browser may keep it for good.
const dataFile = (name) => path.join(DATA_DIR, (name === 'sourcenames' ? 'source-names' : name) + '.json');
const DATA = Object.fromEntries(DATA_FILES.map((n) => {
  const body = fs.readFileSync(dataFile(n));
  return [n, { body, etag: etagOf(body) }];
}));
const DATA_ALL_BODY = JSON.stringify(Object.fromEntries(DATA_FILES.map((n) => [n, JSON.parse(DATA[n].body)])));
const DATA_ALL = { body: DATA_ALL_BODY, etag: etagOf(DATA_ALL_BODY) };

function staticPolicy(rel, q) {
  if (rel.endsWith('.html')) return 'no-cache';
  if (rel === '/airports.min.json' || /^\/icon-[\w-]+\.png$/.test(rel)) return 'public, max-age=86400, stale-while-revalidate=604800';
  // Script and style URLs carry ?v=<version> when the page links them that way; otherwise revalidate (cheap with the ETag).
  if (/\.(js|css)$/.test(rel)) return q.has('v') ? CACHE.immutable : 'public, max-age=0, must-revalidate';
  return 'public, max-age=3600';
}
function serveStatic(req, res, url) {
  const pathname = url.pathname;
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: 'forbidden' });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      // SPA fallback for unknown paths without an extension.
      if (!path.extname(pathname)) return serveStatic(req, res, new URL('/', url));
      return sendJson(res, 404, { error: 'not found' });
    }
    fs.readFile(file, (err2, buf) => {
      if (err2) return sendJson(res, 404, { error: 'not found' });
      sendBody(req, res, { body: buf, type: MIME[path.extname(file)] || 'application/octet-stream', etag: `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`, cache: staticPolicy(rel, url.searchParams), modified: st.mtime.toUTCString() });
    });
  });
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const q = url.searchParams;
  const p = url.pathname;
  try {
    // /api/cron/daily is the same run under a second name, for the catch-up cron entry.
    if (p === '/api/cron/daily') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
      return sendJson(res, 200, await runDaily(req, q));
    }
    if (p === '/api/alerts' || p === '/api/alerts/run') {
      if (!['GET', 'POST', 'DELETE'].includes(req.method)) return sendJson(res, 405, { error: 'method not allowed' });
      return sendJson(res, 200, await handleAlerts(req, q, p.endsWith('/run') ? 'run' : ''));
    }
    if (p === '/api/telegram' || p === '/api/telegram/link') {
      if (!['GET', 'POST', 'DELETE'].includes(req.method)) return sendJson(res, 405, { error: 'method not allowed' });
      return sendJson(res, 200, await handleTelegram(req, p.endsWith('/link') ? 'link' : ''));
    }
    if (p === '/api/watch') {
      if (!['GET', 'POST', 'DELETE'].includes(req.method)) return sendJson(res, 405, { error: 'method not allowed' });
      return sendJson(res, 200, await handleWatch(req, q));
    }
    // HEAD only where the answer is a fixed file: the data files and the static site.
    const headOk = p.startsWith('/api/data/') || !p.startsWith('/api/');
    if (req.method !== 'GET' && !(req.method === 'HEAD' && headOk)) return sendJson(res, 405, { error: 'method not allowed' });
    if (p === '/api/config') {
      return sendJson(res, 200, {
        mock: MOCK, callsToday: usage.calls, dailyLimit: 1000, cash: CASH_MODE, cashSources: { rapid: Boolean(RAPIDAPI_KEY), serpapi: Boolean(SERPAPI_KEY) }, cashLocked: Boolean(cashPasscode()),
        alerts: { store: Boolean(alerts), email: Boolean(alertMailer) }, watch: Boolean(priceWatch),
        telegram: { configured: telegram.configured, linked: (await telegram.status().catch(() => ({}))).linked === true },
        hotels: { callsToday: roomsUsage.day === new Date().toISOString().slice(0, 10) ? roomsUsage.calls : 0, dailyLimit: 1000 },
        // Which deployment is answering, to confirm a redeploy went live.
        commit: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7),
        repo: process.env.VERCEL_GIT_REPO_OWNER && process.env.VERCEL_GIT_REPO_SLUG ? `https://github.com/${process.env.VERCEL_GIT_REPO_OWNER}/${process.env.VERCEL_GIT_REPO_SLUG}` : '',
        version: VERSION.version, updated: VERSION.updated, history: (VERSION.history || []).slice(0, 10),
      }, CACHE.short);
    }
    // Behind the passcode (or personal): never cached by the CDN.
    if (p === '/api/cash') return sendJson(res, 200, await handleCash(q, req));
    if (p === '/api/cash/calendar') return sendJson(res, 200, await handleCashCalendar(q, req));
    if (p === '/api/cash/link') return sendJson(res, 200, await handleCashLink(q, req));
    if (p === '/api/cash/quota') return sendJson(res, 200, await handleCashQuota());
    if (p === '/api/hotels/cash') return sendJson(res, 200, await handleHotelCash(q, req));
    // Public.
    if (p === '/api/directs') {
      const { body, open } = await handleDirects(q, req);
      return sendJson(res, 200, body, open && body.configured ? CACHE.directs : null);
    }
    if (p === '/api/trip-info') {
      const info = await handleTripInfo(q);
      return sendJson(res, 200, info, info.errors && Object.keys(info.errors).length ? CACHE.short : CACHE.tripInfo);
    }
    const hm = p.match(/^\/api\/hotels\/(search|calendar|rooms)$/);
    if (hm) return sendJson(res, 200, await handleHotels(hm[1], q), CACHE.search);
    if (p === '/api/fx') {
      const fx = await handleFx();
      return sendJson(res, 200, fx, fx.live ? CACHE.fx : CACHE.short);
    }
    if (p === '/api/deals') {
      const d = await handleDeals();
      return sendJson(res, 200, d, d.groups?.length ? CACHE.deals : CACHE.short);
    }
    if (p === '/api/search') return sendJson(res, 200, await handleSearch(q), CACHE.search);
    if (p === '/api/explore') return sendJson(res, 200, await handleExplore(q), CACHE.search);
    if (p.startsWith('/api/trips/')) {
      let id;
      try { id = decodeURIComponent(p.slice(11)); } catch { throw new BadRequest('網址編碼錯誤'); }
      return sendJson(res, 200, await handleTrips(id), CACHE.search);
    }
    if (p === '/api/data/all') {
      return sendBody(req, res, { ...DATA_ALL, type: MIME['.json'], cache: q.get('v') === VERSION.version ? CACHE.immutable : CACHE.data });
    }
    const m = p.match(/^\/api\/data\/(\w+)$/);
    if (m && DATA_FILES.includes(m[1])) return sendBody(req, res, { ...DATA[m[1]], type: MIME['.json'], cache: CACHE.data });
    if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });
    serveStatic(req, res, url);
  } catch (e) {
    if (e instanceof BadRequest) return sendJson(res, 400, { error: e.message });
    if (e instanceof SeatsAeroError || e instanceof CashError || e instanceof AlertError || e instanceof rooms.RoomsError || e instanceof DirectsError || e instanceof hotelCash.HotelCashError || e instanceof KvError || e instanceof tg.TelegramError) return sendJson(res, e.status, { error: e.message, code: e.code });
    console.error(e);
    sendJson(res, 500, { error: '伺服器錯誤' });
  }
}

const server = http.createServer(route);
if (require.main === module) {
  server.listen(PORT, () => console.log(`http://localhost:${PORT}  ${MOCK ? '(示範資料模式：未設定 SEATS_AERO_API_KEY)' : '(使用 seats.aero API)'}`));
}
module.exports = { server, route, cached, VERSION_STRING: VERSION.version };
