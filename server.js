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
const { redisKv, memoryKv, takeLock, waitLock, sharedCache, getMany, hashKey, KvError } = require('./lib/kv');
const { todayTW, monthTW, validDate } = require('./lib/day');
const tg = require('./lib/telegram');
const accor = require('./lib/accor');
const { createAccounts, AccountError } = require('./lib/accounts');
const { createAdmin, AdminError } = require('./lib/admin');
const lineLib = require('./lib/line');
const { createHistory } = require('./lib/history');
const { createSearchCache } = require('./lib/searchcache');
const { createExpiry } = require('./lib/expiry');
const { createCxcalStore, CxcalError } = require('./lib/cxcal-store');
const { cronParts, cronSlot } = require('./lib/cronreport');
const { createDealSub, DealSubError } = require('./lib/dealsub');
const { createNlSearch, pickProvider, NlError } = require('./lib/nlsearch');

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = (process.env.SEATS_AERO_API_KEY || '').trim(); // a key pasted into Vercel with a space or line break still works
const MOCK = !API_KEY || process.env.MOCK === '1';
const SERPAPI_KEY = (process.env.SERPAPI_KEY || '').trim();
const RAPIDAPI_KEY = (process.env.RAPIDAPI_KEY || '').trim();
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
const DATA_FILES = ['airlines', 'alliances', 'airports', 'programs', 'glossary', 'asiamiles', 'sourcenames', 'points', 'booking', 'charts', 'products', 'promos', 'airlinenames', 'airportnames', 'expiry', 'buymiles', 'changes', 'fees', 'holds', 'milecost', 'upgrades', 'callcenters'];
// The page loads the bundle in two parts: `core` is what the first screen needs (form menus, airline and airport names);
// `more` (points, charts, rules, booking notes…) is fetched when a search, a flight's details or a tab that uses it opens.
const DATA_PARTS = {
  core: ['airlines', 'alliances', 'airports', 'sourcenames', 'airlinenames', 'airportnames'],
  more: ['programs', 'glossary', 'asiamiles', 'points', 'booking', 'charts', 'products', 'promos', 'expiry', 'buymiles', 'changes', 'fees', 'holds', 'milecost', 'upgrades', 'callcenters'],
};
// Shown in the page footer; bump with `node scripts/bump-version.js`.
const VERSION = require('./data/version.json');

// seats.aero's daily quota resets at 00:00 UTC, so this counter (shown as "calls today") stays on UTC days.
const usage = { day: '', calls: 0 };
function countCall() {
  const today = new Date().toISOString().slice(0, 10);
  if (usage.day !== today) Object.assign(usage, { day: today, calls: 0 });
  usage.calls++;
}
// Every instance's seats.aero calls of the day together (UTC day, like seats.aero's own count): visitors' lookups
// add theirs through spendBudget; the daily jobs and the owner's runs (deals, seat alerts) through countShared, so
// visitors are stopped earlier on a day the jobs needed more.
const seatsAllKey = (day = new Date().toISOString().slice(0, 10)) => `budget:v1:seats:all:${day}`;
const countShared = () => { kv.incr(seatsAllKey(), 1, 2 * 86400).catch(() => {}); };

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

// The jobs' client (deals, seat alerts); visitors' lookups use their own (seatsCalls), counted by the budget.
const client = createClient({ apiKey: API_KEY, onCall: () => { countCall(); countShared(); } });
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
  if (rapid.isRapidToken(params.departure_token) || rapid.isRapidToken(params.booking_token)) {
    if (!rapidQuery) throw new CashError('這個選項來自 RapidAPI，但網站目前沒有設定 RAPIDAPI_KEY，請重新搜尋一次', 400);
    return { ...(await rapidQuery({ ...params, allianceCarriers })), provider: 'rapid' };
  }
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
const shared = (key, ttlSec, fn, opts) => cached(key, () => sharedCache(kv, key, ttlSec, fn, opts), Math.min(ttlSec * 1000, CACHE_TTL_MS));
const lockFor = (name, seconds) => () => takeLock(kv, name, seconds);
// seats.aero / rooms.aero searches: the per-instance cache in front of one shared through Upstash (lib/searchcache.js),
// so every instance and visitor reuses an answer for 30 minutes. Off without Redis and in the demo.
const searchCache = createSearchCache({ kv, enabled: HAS_REDIS && !MOCK, ttl: Number(process.env.SEARCH_CACHE_TTL_SECONDS) || CACHE_TTL_MS / 1000, defer });
const sharedSearch = (key, fn) => cached(key, () => searchCache.wrap(key, fn));

class BadRequest extends Error {}

// Airport → country and coordinates, for the pre-trip notes.
const AIRPORT_FILE = require('./public/airports.min.json');
const AIRPORTS = new Map(AIRPORT_FILE.airports.map(([code, , , country, , , , , lat, lon]) => [code, { country, lat, lon }]));
// A Chinese city name in English, for sources that only know English names (Booking.com's city search):
// the multi-airport groups first (東京 → Tokyo), then a major airport whose Chinese name starts with it (曼谷 → Bangkok).
function cityInEnglish(name) {
  if (!/[\u3400-\u9fff]/.test(name)) return name;
  const g = (AIRPORT_FILE.groups || []).find((x) => x.zh === name);
  if (g) return g.en;
  const hits = AIRPORT_FILE.airports.filter((a) => a[6] && a[6].startsWith(name)).sort((a, b) => (b[5] || 0) - (a[5] || 0));
  return hits.length ? hits[0][7] || hits[0][1] : name;
}
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
// LINE: the owner's own LINE Official Account (Messaging API), linked by a one-time code sent to the bot (lib/line.js).
// Needs Upstash, because the code and the link must reach whichever instance LINE's webhook lands on.
const LINE_TOKEN = (process.env.LINE_CHANNEL_ACCESS_TOKEN || '').trim();
const LINE_SECRET = (process.env.LINE_CHANNEL_SECRET || '').trim();
const LINE_READY = Boolean(LINE_TOKEN && LINE_SECRET && HAS_REDIS);
const LINE_MOCK = !LINE_TOKEN && MOCK;
const line = lineLib.createLine({
  client: LINE_READY ? lineLib.lineClient({ token: LINE_TOKEN }) : LINE_MOCK ? lineLib.mockLineClient() : null,
  kv,
  secret: LINE_SECRET,
  cap: Number(process.env.LINE_MONTHLY_CAP) || 180,
  missing: [!LINE_TOKEN && 'LINE_CHANNEL_ACCESS_TOKEN', !LINE_SECRET && 'LINE_CHANNEL_SECRET', !HAS_REDIS && 'Upstash Redis'].filter(Boolean),
});
// Price drops go to Telegram and LINE side by side: true when either got it, false when one was tried and none got
// it (tried again next time), null when neither is linked. Seat alerts go to Telegram one by one and to LINE as one
// message per run (LINE counts every push against a monthly allowance).
const notifyAll = async (html) => { const rs = await Promise.all([telegram.notify(html), line.notify(html)]); return rs.includes(true) ? true : rs.includes(false) ? false : null; };
// Award-space history from the searches the daily jobs already make (lib/history.js); needs Upstash.
const history = createHistory({ kv, enabled: HAS_REDIS && !MOCK, demo: MOCK });
const alerts = alertStore && createAlerts({
  store: alertStore,
  sendEmail: alertMailer,
  notify: (html) => telegram.notify(html),
  digest: (htmls) => line.notify(htmls.join('\n\n')),
  listLock: () => waitLock(kv, 'award-alerts:v1:lock', 10),
  siteUrl: SITE_URL,
  programNames: SOURCE_NAMES,
  // Cheapest seats first, pages of 1,000 per cabin: one page up to four months, then one more for every 120 days
  // (four for a whole year), fetched only while seats.aero says there is more. `until`: see lib/seats.js.
  pagesFor: (a) => pagesFor({ start_date: a.start, end_date: a.end }, 1, 120),
  perCallMs: 2000, // per seats.aero call, when deciding whether a watch can still start in a run (live calls take 0.1–0.5 s)
  search: (params, { until } = {}) => cached('alert:' + JSON.stringify(params), async () => {
    const p = { ...params, order_by: 'lowest_mileage', take: 1000 };
    const { items } = MOCK ? { items: mock.mockSearch(p) } : await client.search(p, { maxPages: pagesFor(p, 1, 120), until });
    const rows = items.map(normalizeAvailability);
    defer(history.note(p, rows));
    return rows;
  }),
});
// Daily deals from Taipei, refreshed by the daily cron and kept in the same Redis. The demo looks two months ahead
// (its made-up searches are slow over a whole year).
const dealsStore = HAS_REDIS ? redisStore({ url: REDIS_URL, token: REDIS_TOKEN, key: 'award-deals:v1' }) : memoryStore(null);
const deals = createDeals({
  store: dealsStore,
  days: MOCK ? 60 : 330,
  lock: (name, seconds) => takeLock(kv, name, seconds),
  defer,
  // `fresh` (the owner's 立即更新): ask seats.aero now instead of reusing this instance's last 30 minutes.
  search: (params, { fresh = false } = {}) => {
    const key = 'deals:' + JSON.stringify(params);
    if (fresh) uncache(key);
    return cached(key, async () => {
      const { items } = MOCK ? { items: mock.mockSearch(params) } : await client.search(params, { maxPages: 1 });
      const rows = items.map(normalizeAvailability);
      rows.fetchedAt = Date.now();
      defer(history.note(params, rows));
      return rows;
    });
  },
});
// Cash price tracking: same Redis and mailer as the seat alerts; each check spends one search credit, so lib/pricewatch spaces them out and caps them.
const watchStore = CASH_MODE === 'off' ? null : HAS_REDIS ? redisStore({ url: REDIS_URL, token: REDIS_TOKEN, key: 'price-watch:v1' }) : CASH_MODE === 'mock' ? memoryStore(null) : null;
const priceWatch = watchStore && createPriceWatch({
  store: watchStore,
  sendEmail: alertMailer,
  notify: notifyAll,
  listLock: () => waitLock(kv, 'price-watch:v1:lock', 10),
  siteUrl: SITE_URL,
  // Checks run on RapidAPI; the SerpApi reserve only matters when there is no RapidAPI key.
  quota: async () => (CASH_MODE !== 'live' || RAPIDAPI_KEY ? null : serpLeft()),
  search: async (w, { until = Infinity } = {}) => {
    const params = { departure_id: w.origin, arrival_id: w.destination, outbound_date: w.depart, return_date: w.ret || undefined, type: w.ret ? 1 : 2, travel_class: CABIN_CLASS[w.cabin], adults: w.adults, stops: w.stops || undefined };
    if (CASH_MODE === 'mock') return normalizeCash(mock.mockCash(params));
    // Falling back to SerpApi is fine only while it has plenty left for the owner's own searches, and while the run
    // has time left for it (under 15 seconds, the run would be cut off mid-call).
    return normalizeCash(await liveCash(params, { allowSerp: async () => { if (until - Date.now() < 15e3) return false; const left = await serpLeft(); return left == null || left >= RESERVE; } }));
  },
});
async function handleWatch(req, q) {
  if (!priceWatch) return { configured: false, watches: [] };
  if (!cashPasscode() && !manageOpen()) throw noPasscode('降價追蹤');
  if (!(await cashOk(req))) throw passError(req, '需要通關密碼才能管理降價追蹤');
  if (req.method === 'POST') return { configured: true, ...(await priceWatch.add(await readJson(req))) };
  if (req.method === 'DELETE') { await priceWatch.remove(String(q.get('id') || '')); return { ok: true }; }
  return { configured: true, email: Boolean(alertMailer), max: priceWatch.max, ...(await priceWatch.list()) };
}

let dealsPending = null;
// `at` (the page, after its own 立即更新): that copy or a newer one, past this instance's memory of an older one.
const DEALS_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
async function handleDeals(q) {
  const at = q.get('at');
  if (at && DEALS_AT.test(at) && Date.parse(at) <= Date.now() + 60e3) return { mock: MOCK, ...(await deals.get({ atLeast: at })) };
  // Concurrent first visitors share one read (or the very first build) instead of each spending API calls.
  dealsPending ||= deals.get().finally(() => { dealsPending = null; });
  return { mock: MOCK, ...(await dealsPending) };
}

// 「立即更新」 on 今日好康: the owner (passcode) refreshes every group now, about 8 seats.aero calls, at most once an hour.
// Nothing refreshed (the daily run was updating them, or every group failed): the hour's turn is given back.
async function refreshDealsNow(req) {
  if (!(await runCaller(req))) throw cashPasscode() ? passError(req, '需要通關密碼才能手動更新今日好康') : noPasscode('今日好康手動更新');
  const release = await takeLock(kv, 'deals:manual', 3600);
  if (!release) throw new BadRequest('今日好康一小時內只能手動更新一次，請稍後再試');
  let d;
  try {
    d = await deals.refresh({ deadline: Date.now() + 45_000, fresh: true });
  } catch (e) { await release(); throw e; }
  if (!d.refreshed) await release();
  return { mock: MOCK, ...d };
}

const safeEqual = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
// Without a passcode, alerts and price watches (which hold people's emails and spend seats.aero, RapidAPI and mail)
// cannot be managed by anyone, like Telegram, except in the demo, which spends nothing.
const manageOpen = () => MOCK && CASH_MODE !== 'live';
const noPasscode = (what) => Object.assign(new CashError(`要先在 Vercel 設定 CASH_PASSCODE，才能管理${what}`, 401), { code: 'setup' });
// Vercel's cron calls the run endpoint with `Authorization: Bearer $CRON_SECRET`; people use the passcode.
async function alertsAllowed(req) {
  const secret = (process.env.CRON_SECRET || '').trim();
  if (secret && safeEqual(String(req.headers.authorization || ''), `Bearer ${secret}`)) return true;
  if (!cashPasscode()) return manageOpen();
  return cashOk(req);
}
// Who may start the daily run, which spends seats.aero, RapidAPI and mail: the cron (its secret) or the owner (the
// passcode). With neither set, nobody, except in the demo, which spends nothing.
async function runCaller(req) {
  const secret = (process.env.CRON_SECRET || '').trim();
  if (secret && safeEqual(String(req.headers.authorization || ''), `Bearer ${secret}`)) return 'cron';
  if (cashPasscode()) return (await cashOk(req)) ? 'owner' : null;
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

// The daily run (Vercel cron, 00:10 UTC = 08:10 Taiwan, just after seats.aero's quota resets, and again at 13:10 UTC =
// 21:10 Taiwan, which refreshes 今日好康 a second time and retries what the morning missed): deals, then price watches, then seat alerts, in one 60-second function. Each part saves item by item and
// stops starting new items near the time limit, so a cut-off run loses nothing and the catch-up run (or tomorrow's)
// finishes the rest; work already done today is skipped. `?part=expiry,deals,watches,alerts` runs only those parts
// (expiry: the miles expiry reminders, which spend no quota, go first). The budgets say when each part stops starting
// new items; `end` is when every seats.aero or cash lookup must have answered, short of Vercel's 60-second limit, so
// a slow upstream ends in a timeout the run records instead of the function being killed mid-way.
// digest: 今日好康每日信 (lib/dealsub.js), right after the deals, one Resend batch call; what is left goes in the evening run.
const RUN_BUDGET = { expiry: 6e3, deals: 20e3, digest: 26e3, watches: 28e3, alerts: 48e3, end: 54e3 };
// Whether CRON_SECRET is set (never its value), when Vercel's run last got in or was turned away, and when the last
// one finished, how long it took and how many items failed or were left for later.
async function cronStatus() {
  const [last, denied, done] = await Promise.all(['cron:last', 'cron:denied', 'cron:done'].map((k) => kv.get(k).catch(() => null)));
  return { secret: Boolean((process.env.CRON_SECRET || '').trim()), lastRun: last?.at || null, lastDenied: denied?.at || null, lastDone: done?.at || null, lastDoneMs: done?.ms ?? null, lastProblems: done?.problems ?? null };
}
const runProblems = (out) => [out.expiry?.error, out.dealsError, out.digest?.error, out.digest?.errors ? 'digest' : '', out.watches?.error, out.alertsError].filter(Boolean).length
  + [...(out.report || []), ...(out.watches?.report || [])].filter((r) => r.error || r.retry || r.skipped === 'time').length;
async function runDaily(req, q) {
  const who = await runCaller(req);
  // Remembered for /api/config, so the owner can see whether Vercel's daily run gets in (CRON_SECRET set) or is turned away.
  const fromVercel = /vercel-cron/i.test(String(req.headers['user-agent'] || ''));
  if (!who) {
    if (fromVercel) await kv.set('cron:denied', { at: new Date().toISOString(), auth: Boolean(req.headers.authorization) }, { ex: 40 * 86400 }).catch(() => {});
    throw passError(req, '需要通關密碼才能執行檢查');
  }
  if (who === 'cron') await kv.set('cron:last', { at: new Date().toISOString() }, { ex: 40 * 86400 }).catch(() => {});
  const t0 = Date.now();
  const parts = new Set((q.get('part') || 'expiry,deals,digest,watches,alerts').split(','));
  const out = { configured: Boolean(alerts), email: Boolean(alertMailer), by: who };
  if (parts.has('expiry')) out.expiry = await expiry.run({ deadline: t0 + RUN_BUDGET.expiry, lock: lockFor('expiry:run', 60) }).catch((e) => ({ error: e.message }));
  if (parts.has('deals')) {
    try {
      const d = await deals.refresh({ deadline: t0 + RUN_BUDGET.deals, skipFresh: true });
      out.deals = d.groups.reduce((n, g) => n + g.items.length, 0);
      const errs = d.groups.filter((g) => g.error);
      if (errs.length) out.dealsError = `${errs.length} 組更新失敗：${errs[0].error}`;
    } catch (e) { out.dealsError = e.message; }
  }
  if (parts.has('digest') && dealSub) out.digest = await dealSub.run({ deadline: t0 + RUN_BUDGET.digest, base: SITE_URL || siteBase(req) }).catch((e) => ({ error: e.message }));
  if (parts.has('watches') && priceWatch) {
    out.watches = await priceWatch.run({ deadline: t0 + RUN_BUDGET.watches, until: t0 + RUN_BUDGET.end, lock: lockFor('price-watch:run', 120) }).catch((e) => ({ error: e.message }));
  }
  if (parts.has('alerts') && alerts) {
    Object.assign(out, await alerts.run({ deadline: t0 + RUN_BUDGET.alerts, until: t0 + RUN_BUDGET.end, force: who !== 'cron', lock: lockFor('alerts:run', 120) }).catch((e) => ({ alertsError: e.message })));
  }
  if (who === 'cron') {
    // Also kept per slot with how each part went, for the owner's status line (GET /api/cron/status).
    const done = { at: new Date().toISOString(), ms: Date.now() - t0, problems: runProblems(out), parts: cronParts(out) };
    await Promise.all([kv.set('cron:done', done, { ex: 40 * 86400 }), kv.set(`cron:done:${cronSlot(done.at)}`, done, { ex: 3 * 86400 })]).catch(() => {});
  }
  return { checked: 0, report: [], ...out };
}
async function handleAlerts(req, q, sub) {
  if (sub === 'run') return runDaily(req, q);
  if (!alerts) return { configured: false, email: false, alerts: [] };
  if (!(await alertsAllowed(req))) throw cashPasscode() ? passError(req, '需要通關密碼才能管理提醒') : noPasscode('提醒');
  if (req.method === 'POST') return { configured: true, ...(await alerts.add(await readJson(req))) };
  if (req.method === 'PUT') { const b = await readJson(req); return { configured: true, ...(await alerts.update(String(q.get('id') || b.id || ''), b)) }; }
  if (req.method === 'DELETE') { await alerts.remove(String(q.get('id') || '')); return { ok: true }; }
  return { configured: true, email: Boolean(alertMailer), alerts: await alerts.list() };
}

// /api/telegram: GET status, POST /api/telegram/link links the newest chat that sent /start to the bot,
// POST /api/telegram/test sends a test message to the linked chat, DELETE unlinks.
// Linking decides where the owner's alerts go, so it needs the passcode to be set (except in the demo).
async function handleTelegram(req, sub) {
  const ok = cashPasscode() ? await cashOk(req) : TELEGRAM_MOCK;
  if (!ok) throw passError(req, cashPasscode() ? '需要通關密碼才能設定 Telegram' : '要先在 Vercel 設定 CASH_PASSCODE，才能連結 Telegram');
  const mock = TELEGRAM_MOCK ? { mock: true } : {};
  if (sub === 'link') {
    if (req.method !== 'POST') throw new BadRequest('請用 POST');
    return { ...(await telegram.link()), ...mock };
  }
  if (sub === 'test') {
    if (req.method !== 'POST') throw new BadRequest('請用 POST');
    return { ...(await telegram.test()), ...mock };
  }
  if (sub) throw new BadRequest('未知的 Telegram 操作');
  if (req.method === 'DELETE') return { ...(await telegram.unlink()), ...mock };
  if (req.method !== 'GET') throw new BadRequest('請用 GET 或 DELETE');
  return { ...(await telegram.status()), ...mock };
}

// /api/line: GET status, POST /api/line/code shows a one-time link code, POST /api/line/test sends a test message,
// DELETE unlinks; gated like Telegram. POST /api/line/webhook is LINE's own call, checked by its signature instead.
// The demo has POST /api/line/demo, standing in for sending the code from the LINE app.
async function handleLine(req, sub) {
  if (sub === 'webhook') {
    if (req.method !== 'POST') throw new BadRequest('只接受 POST');
    if (!LINE_READY) throw new lineLib.LineError('網站還沒設定 LINE 官方帳號', 503, 'not-configured');
    const raw = await lineLib.readRaw(req);
    if (!line.verify(raw, req.headers['x-line-signature'])) throw new lineLib.LineError('簽章不符', 401, 'signature');
    let body;
    try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { throw new BadRequest('JSON 格式錯誤'); }
    return line.handleEvents(body.events);
  }
  const ok = cashPasscode() ? await cashOk(req) : LINE_MOCK;
  if (!ok) throw Object.assign(new CashError(cashPasscode() ? '需要通關密碼才能設定 LINE' : '要先在 Vercel 設定 CASH_PASSCODE，才能連結 LINE', 401), { code: 'passcode' });
  const mockFlag = LINE_MOCK ? { mock: true } : {};
  if (sub === 'code' && req.method === 'POST') return { ...(await line.startLink()), ...mockFlag };
  if (sub === 'test' && req.method === 'POST') return { ...(await line.test()), ...mockFlag };
  if (sub === 'demo' && req.method === 'POST' && LINE_MOCK) {
    const pending = await kv.get('line:pending').catch(() => null);
    await line.handleEvents([{ type: 'message', source: { type: 'user', userId: 'Udemo' }, message: { type: 'text', text: pending?.code || '000000' } }]);
    return { ...(await line.status()), ...mockFlag };
  }
  if (sub) throw new BadRequest('未知的 LINE 操作');
  if (req.method === 'DELETE') return { ...(await line.unlink()), ...mockFlag };
  return { ...(await line.status()), ...mockFlag };
}

// Optional passcode that gates the cash-fare lookups (each one spends a SerpApi credit). Read per request so tests can set it.
const cashPasscode = () => (process.env.CASH_PASSCODE || '').trim();

// Too many / too fast: a 429 whose message the page shows as it is.
class LimitError extends Error {
  constructor(message, code = 'rate') { super(message); this.status = 429; this.code = code; }
}
// Guessing the passcode: 5 wrong tries per address (the x-cash-pass header on any endpoint, account unlock included),
// then that address waits 15 minutes; the right passcode starts the count again. Everyone's wrong tries together are
// capped per hour as a backstop (the owner hears about it on Telegram). That pause only stops header checks from
// addresses that have not entered the right passcode in the last 30 days, and signed-in accounts that were unlocked
// before keep working from the page (see cashOk), so a flood of wrong guesses cannot lock the owner out.
const PASS_MAX = 5;
const PASS_LOCK_SEC = 900;
const PASS_GLOBAL_MAX = 100;
const PASS_OK_SEC = 30 * 86400;
// The address guesses are counted against: IPv4 as it is, IPv6 by its /64 (one home or one server usually holds a
// whole /64, so counting single IPv6 addresses would hand a guesser millions of fresh ones).
function passBucket(ip) {
  const s = String(ip || '').trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '').toLowerCase();
  const v4 = s.match(/^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) return v4[1];
  if (!s.includes(':')) return s || 'unknown';
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(':') + '::/64';
}
const passKey = (req) => `rl:pass:v1:${hashKey(passBucket(clientIp(req)))}`;
// Addresses that entered the right passcode lately, remembered per instance too, so the owner's every request does
// not write it again.
const passOkSeen = new Map();
function markPassOk(key) {
  if (Date.now() - (passOkSeen.get(key) || 0) < 12 * 3600e3) return;
  passOkSeen.set(key, Date.now());
  if (passOkSeen.size > 1000) passOkSeen.delete(passOkSeen.keys().next().value);
  kv.set(key + ':ok', 1, { ex: PASS_OK_SEC }).catch(() => {});
}
const lockedFor = (until) => `通關密碼錯太多次，請 ${Math.max(1, Math.ceil((until - Date.now()) / 60000))} 分鐘後再試`;
async function passHeaderOk(req, want) {
  const given = String(req.headers['x-cash-pass'] || '');
  if (!given) return false;
  const key = passKey(req);
  const lock = await kv.get(key + ':lock').catch(() => null);
  if (lock) throw new LimitError(lockedFor(lock.until || Date.now() + PASS_LOCK_SEC * 1000));
  const globalKey = `rl:pass:v1:all:${Math.floor(Date.now() / 3600e3)}`;
  if (Number(await kv.get(globalKey).catch(() => 0)) >= PASS_GLOBAL_MAX && !(await kv.get(key + ':ok').catch(() => null))) throw new LimitError('通關密碼暫停驗證中（錯誤的嘗試太多），請過一小時再試');
  // Counted before comparing, so a burst of guesses sent at once cannot all be compared before the count catches up;
  // a few extra are let through for the owner's own requests running side by side.
  const n = await kv.incr(key, 1, PASS_LOCK_SEC).catch(() => 0);
  if (n > PASS_MAX + 3) throw new LimitError(lockedFor(Date.now() + PASS_LOCK_SEC * 1000));
  if (safeEqual(given, want)) {
    await kv.del(key).catch(() => {});
    markPassOk(key);
    return true;
  }
  const all = await kv.incr(globalKey, 1, 3600).catch(() => 0);
  if (all === PASS_GLOBAL_MAX) defer(telegram.notify(`⚠️ 一小時內有 ${all} 次輸錯通關密碼，已暫停用通關密碼驗證到下個整點。`));
  if (n >= PASS_MAX) {
    const until = Date.now() + PASS_LOCK_SEC * 1000;
    await kv.set(key + ':lock', { until }, { ex: PASS_LOCK_SEC }).catch(() => {});
    await kv.del(key).catch(() => {});
    throw new LimitError(lockedFor(until));
  }
  req.passLeft = PASS_MAX - n;
  return false;
}
// The 401 for a missing or wrong passcode; after a wrong one it says how many tries are left.
const passError = (req, msg) => Object.assign(new CashError(req.passLeft != null ? `通關密碼不對，還可以再試 ${req.passLeft} 次` : msg, 401), { code: 'passcode' });

// A request the site's own page made: fetch with the x-requested-with header (another site cannot add it without a
// CORS preflight, which this server never grants), and not marked cross-site by the browser. A link, form or
// image on another site that rides on the session cookie fails this.
function fromPage(req) {
  if (!req.headers['x-requested-with']) return false;
  const site = req.headers['sec-fetch-site'];
  return !site || site === 'same-origin' || site === 'none';
}

// Signed-in accounts that entered the passcode once count as unlocked from then on (see lib/accounts.js), next to the
// x-cash-pass header. The header on a signed-in request is what marks the account. The cookie alone counts only on
// requests from the page itself, so another site cannot make a signed-in browser spend the quota. While header checks
// are paused (too many wrong guesses), such an account still gets in from the page, although the page keeps sending
// its stored passcode. Worked out once per request.
function cashOk(req) {
  req.cashOkP ||= (async () => {
    const want = cashPasscode();
    if (!want) return true;
    const sess = await sessionOf(req);
    let headerOk;
    try {
      headerOk = await passHeaderOk(req, want);
    } catch (e) {
      if (e instanceof LimitError && sess && fromPage(req) && (await accounts.isUnlocked(sess.user, want).catch(() => false))) return true;
      throw e;
    }
    if (headerOk) {
      if (sess) await accounts.markUnlocked(sess, want).catch((e) => console.error('unlock', e.message));
      return true;
    }
    return sess && fromPage(req) ? accounts.isUnlocked(sess.user, want) : false;
  })();
  return req.cashOkP;
}

// Accounts (optional): email + password, to carry one's own settings between devices. Needs Redis (in-memory in the
// demo); verify and reset mails go through Resend, and the demo prints the links to the server log instead.
const ACCOUNTS_ON = HAS_REDIS || MOCK;
const accounts = ACCOUNTS_ON ? createAccounts({ kv, sendMail: alertMailer, log: MOCK && !alertMailer ? (m) => console.log(m) : null, defer, mailCap: Number(process.env.ACCOUNT_MAILS_PER_DAY) || undefined }) : null;
// Only the sid cookie is read. Other cookies on the same host (analytics, a hand-written one with a stray %) are none
// of this site's business and must not break sign-in; the sid itself is base64url and needs no decoding.
function sidOf(req) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === 'sid') return part.slice(i + 1).trim();
  }
  return '';
}
function sessionOf(req) {
  if (!accounts) return Promise.resolve(null);
  req.sessionPromise ||= accounts.session(sidOf(req)).catch(() => null);
  return req.sessionPromise;
}
// Miles expiry reminders (lib/expiry.js): accounts with dates in their synced wallet, plus the owner's own list.
const expiry = createExpiry({
  kv, rules: require('./data/expiry.json').programs, steps: require('./data/expiry.json').reminderDays,
  loadWallet: async (email) => (accounts ? (await accounts.getData({ email })).data['wallet:v1'] : null),
  sendEmail: alertMailer, notify: (html) => telegram.notify(html), siteUrl: SITE_URL, log: MOCK && !alertMailer ? (m) => console.log(m) : null,
});
async function handleExpiry(req) {
  if (!(await alertsAllowed(req))) throw Object.assign(new CashError('需要通關密碼才能設定到期提醒', 401), { code: 'passcode' });
  if (req.method !== 'POST') return expiry.getOwner();
  const body = await readJson(req, 20_000);
  try { return await expiry.saveOwner(body); } catch (e) { throw new BadRequest(e.message); }
}
// 國泰官網實查 (lib/cxcal-store.js): the owner's own award calendars (Cathay from the bookmarklet, any airline of
// data/muse-templates.json from the AI assistant). Reading is public; writing takes the passcode. The airline templates
// of 「請 AI 助理查官網」 (cxmuse.js) are served on their own at /api/data/musetemplates, fetched when the tool opens.
const cxcalStore = createCxcalStore({ kv });
async function handleCxcal(req, q) {
  const m = req.method;
  if (m === 'GET') {
    const routes = await cxcalStore.find(q.get('origin'), q.get('destination'));
    return routes.length ? { found: true, ...routes[0], routes } : { found: false };
  }
  if (!(await alertsAllowed(req))) throw cashPasscode() ? passError(req, '需要通關密碼才能儲存國泰日曆') : noPasscode('國泰日曆');
  if (m !== 'POST') throw new BadRequest('method not allowed');
  return cxcalStore.save(await readJson(req, 70_000));
}
const sidCookie = (sid, maxAge) => `sid=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax${maxAge != null ? `; Max-Age=${maxAge}` : ''}`;
const clientIp = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '';
const siteBase = (req) => SITE_URL || `${String(req.headers['x-forwarded-proto'] || 'http').split(',')[0]}://${req.headers['x-forwarded-host'] || req.headers.host}`;
// State-changing account requests: JSON only (a cross-site form cannot send it without a CORS preflight) and, when
// the browser says where it comes from, from this site.
function sameSite(req) {
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return false;
  const origin = req.headers.origin;
  if (origin) {
    let host;
    try { host = new URL(origin).host; } catch { return false; }
    const own = [req.headers['x-forwarded-host'], req.headers.host, SITE_URL ? new URL(SITE_URL).host : ''].filter(Boolean);
    return own.includes(host);
  }
  const site = req.headers['sec-fetch-site'];
  return !site || site === 'same-origin' || site === 'none';
}
async function handleAccount(req, res, sub) {
  if (!accounts) return sendJson(res, 200, { configured: false, loggedIn: false });
  const m = req.method;
  if (m !== 'GET' && !sameSite(req)) return sendJson(res, 403, { error: '請從網站本身操作', code: 'origin' });
  const ctx = { ip: clientIp(req), ua: req.headers['user-agent'], base: siteBase(req) };
  const sess = await sessionOf(req);
  const need = () => { if (!sess) throw new AccountError('請先登入', 401, 'login-required'); return sess; };
  const body = m === 'POST' || m === 'PUT' || m === 'DELETE' ? await readJson(req, sub === 'data' ? 260_000 : 10_000) : {};
  const pass = cashPasscode();
  const status = async (s) => ({ configured: true, emailEnabled: accounts.mailOn, ...(await accounts.status(s, pass)) });
  if (sub === '' && m === 'GET') return sendJson(res, 200, await status(sess));
  if (sub === '' && m === 'DELETE') {
    await accounts.remove(need(), body, ctx);
    return sendJson(res, 200, { ok: true }, null, { 'set-cookie': sidCookie('', 0) });
  }
  if (sub === 'data' && m === 'GET') return sendJson(res, 200, await accounts.getData(need()));
  if (sub === 'data' && m === 'PUT') {
    const saved = await accounts.putData(need(), body);
    await expiry.track(sess.email, body.data?.['wallet:v1']).catch((e) => console.error('expiry track', e.message));
    return sendJson(res, 200, saved);
  }
  if (m !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  if (sub === 'signup') return sendJson(res, 200, await accounts.signup(body, ctx));
  if (sub === 'verify') return sendJson(res, 200, await accounts.verify(body, ctx));
  if (sub === 'forgot') return sendJson(res, 200, await accounts.forgot(body, ctx));
  if (sub === 'reset') return sendJson(res, 200, await accounts.reset(body, ctx), null, { 'set-cookie': sidCookie('', 0) });
  if (sub === 'login') {
    if (sess) await accounts.logout(sess).catch(() => {});
    const r = await accounts.login(body, ctx);
    const fresh = await accounts.session(r.sid);
    return sendJson(res, 200, { ok: true, ...(await status(fresh)) }, null, { 'set-cookie': sidCookie(r.sid, r.maxAge) });
  }
  if (sub === 'logout') {
    await accounts.logout(sess);
    return sendJson(res, 200, { ok: true, loggedIn: false }, null, { 'set-cookie': sidCookie('', 0) });
  }
  if (sub === 'password') return sendJson(res, 200, await accounts.changePassword(need(), body, ctx));
  if (sub === 'unlock') {
    need();
    if (!pass) return sendJson(res, 200, { unlocked: true });
    if (!(await cashOk(req))) throw passError(req, '通關密碼不對');
    return sendJson(res, 200, await status(await accounts.session(sidOf(req))));
  }
  return sendJson(res, 404, { error: 'not found' });
}

// 帳號管理 (lib/admin.js): the owner only, by the passcode as everywhere else. Without a passcode only the demo without
// Redis gets in, as its accounts live in this process's memory and are nobody's real data.
const admin = accounts && createAdmin({
  kv, accounts, passcode: cashPasscode,
  alertEmails: async () => [...(alerts ? (await alerts.list()).map((a) => a.email) : []), ...(priceWatch ? (await priceWatch.list()).watches.map((w) => w.email) : [])],
  digestEmails: async () => (dealSub ? dealSub.members() : []),
});
async function handleAdmin(req, res, sub) {
  if (!admin) return sendJson(res, 404, { error: '這個網站沒有開啟帳號功能', code: 'off' });
  const m = req.method;
  if (m !== 'GET' && !sameSite(req)) return sendJson(res, 403, { error: '請從網站本身操作', code: 'origin' });
  const who = await runCaller(req);
  if (who === 'cron') return sendJson(res, 403, { error: '只有站長可以管理帳號', code: 'owner-only' });
  if (who !== 'owner' || (!cashPasscode() && HAS_REDIS)) throw cashPasscode() ? passError(req, '只有站長（輸入通關密碼）可以管理帳號') : noPasscode('帳號');
  if (sub === '' && m === 'GET') return sendJson(res, 200, await admin.list());
  if (m !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  const { email } = await readJson(req);
  if (sub === 'delete') return sendJson(res, 200, await admin.remove(email));
  if (sub === 'signout') return sendJson(res, 200, await admin.signOut(email));
  return sendJson(res, 404, { error: 'not found' });
}

// 今日好康每日信 (lib/dealsub.js): verified accounts subscribe by email; the owner may add the linked Telegram / LINE.
const AIRPORT_ZH = require('./data/airport-names-zh.json').names;
const dealSub = ACCOUNTS_ON ? createDealSub({
  kv,
  loadDeals: () => dealsStore.load(),
  sendEmail: alertMailer,
  log: MOCK && !alertMailer ? (m) => console.log(m) : null,
  notify: { telegram: (html) => telegram.notify(html), line: (html) => line.notify(html) },
  accountsOk: async (emails) => (await getMany(kv, emails.map(accounts.store.userKey))).map((u) => Boolean(u?.verified)),
  names: { program: (s) => SOURCE_NAMES[s], city: (c) => AIRPORT_ZH[c] },
  siteUrl: SITE_URL,
  cap: Number(process.env.DEALS_DIGEST_MAX) || undefined,
  lock: lockFor('dealsub:run', 60),
}) : null;
// GET: this visitor's subscription (and, for the owner, the count and the Telegram / LINE choices); POST: subscribe or
// not (signed in); POST /owner: the owner's chats; /unsubscribe: the mail's one-click link (signed token, no sign-in),
// POSTed by the page (JSON) or by the mail app (RFC 8058 form post, token in the address).
async function handleDealSub(req, res, sub, q) {
  if (!dealSub) return sendJson(res, 200, { configured: false });
  const m = req.method;
  if (sub === 'unsubscribe') {
    // A plain visit (a mail app that opens the address): the page asks first, so link scanners unsubscribe nobody.
    if (m === 'GET') {
      res.writeHead(302, { location: `/#unsub=${encodeURIComponent(q.get('t') || '')}`, 'cache-control': 'no-store' });
      return res.end();
    }
    const json = /^application\/json\b/i.test(String(req.headers['content-type'] || ''));
    const body = json ? await readJson(req) : (await lineLib.readRaw(req, 2000), {});
    return sendJson(res, 200, await dealSub.unsubscribe(q.get('t') || body.t));
  }
  if (m !== 'GET' && !sameSite(req)) return sendJson(res, 403, { error: '請從網站本身操作', code: 'origin' });
  const sess = await sessionOf(req);
  if (m === 'POST' && sub === 'owner') {
    const who = await runCaller(req);
    if (who !== 'owner') throw cashPasscode() ? passError(req, '只有站長（輸入通關密碼）可以設定') : noPasscode('今日好康通知');
    await dealSub.setOwner(await readJson(req));
  } else if (m === 'POST') {
    if (!sess) throw new DealSubError('請先登入', 401, 'login-required');
    if (!sess.user.verified) throw new DealSubError('Email 還沒驗證，請先到信箱點驗證連結', 403, 'unverified');
    await dealSub.subscribe(sess.email, Boolean((await readJson(req)).on));
  } else if (m !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
  const st = await dealSub.status(sess?.email);
  const owner = (await runCaller(req).catch(() => null)) === 'owner';
  const out = { configured: true, signedIn: Boolean(sess), email: sess?.email || '', mail: st.mail, cap: st.cap, full: st.full, subscribed: st.subscribed };
  if (owner) {
    const [prefs, t, l] = await Promise.all([dealSub.ownerPrefs(), telegram.status().catch(() => ({})), line.status().catch(() => ({}))]);
    out.owner = { count: st.count, telegram: { configured: telegram.configured, linked: Boolean(t.linked), name: t.name || '', on: prefs.telegram }, line: { configured: Boolean(l.configured), linked: Boolean(l.linked), on: prefs.line } };
  }
  return sendJson(res, 200, out);
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

// `future`: award searches refuse a range that has wholly passed (it would spend a seats.aero call on departed flights).
function dateRange(q, { future = false } = {}) {
  const start = param(q, 'start', DATE, { required: true });
  const end = param(q, 'end', DATE) || start;
  const days = (new Date(end) - new Date(start)) / 864e5;
  if (days < 0) throw new BadRequest('結束日期不可早於開始日期');
  if (future && end < todayTW()) throw new BadRequest('這段日期已經過了（以台灣時間計），請選今天以後的日期');
  // seats.aero publishes award space about a year out, so a search may cover all of it.
  if (days > MAX_RANGE_DAYS) throw new BadRequest('日期範圍最多一年');
  return { start_date: start, end_date: end };
}

// Longer date ranges return more rows, so allow more result pages (each page is one API call): `base` pages plus one
// for every `per` days.
const pagesFor = (p, base, per = 90) => base + Math.floor((new Date(p.end_date) - new Date(p.start_date)) / 864e5 / per);

// Daily budgets for visitors' seats.aero and rooms.aero calls (each has 1,000 per UTC day), so one visitor or script
// cannot use up the day for everyone, and the morning cron (deals, alerts) always has calls left. Only cache misses
// count. Per address, and for everyone together; the owner (unlocked with the passcode) has no per-address cap and
// is never stopped by the shared one, but still counts toward it, and so do the seats.aero calls of the daily jobs and
// of the owner's alert runs (countShared), so visitors are stopped sooner on a day those needed many.
const BUDGET = {
  seats: { ip: Number(process.env.SEATS_DAILY_PER_IP) || 150, all: Number(process.env.SEATS_DAILY_VISITORS) || 700 },
  rooms: { ip: Number(process.env.ROOMS_DAILY_PER_IP) || 150, all: Number(process.env.ROOMS_DAILY_VISITORS) || 700 },
};
// Takes `units` (the most calls the lookup may make) up front; resolves to `refund(n)` for the calls not made.
async function spendBudget(req, kind, units) {
  if (MOCK || !req) return () => {};
  const day = new Date().toISOString().slice(0, 10);
  const allKey = `budget:v1:${kind}:all:${day}`;
  const ipKey = `budget:v1:${kind}:ip:${hashKey(clientIp(req) || 'unknown')}:${day}`;
  const owner = Boolean(cashPasscode()) && (await cashOk(req).catch(() => false));
  const all = await kv.incr(allKey, units, 2 * 86400).catch(() => null);
  const mine = owner ? null : await kv.incr(ipKey, units, 2 * 86400).catch(() => null);
  const refund = (n) => {
    if (!(n > 0)) return;
    kv.incr(allKey, -n).catch(() => {});
    if (mine != null) kv.incr(ipKey, -n).catch(() => {});
  };
  const left = kind === 'rooms' ? '飯店點數' : '獎勵機位';
  if (!owner && all != null && all > BUDGET[kind].all) { refund(units); throw new LimitError(`網站今天的${left}查詢額度快用完了，請明天早上 8 點（台灣時間）後再試`, 'budget'); }
  if (mine != null && mine > BUDGET[kind].ip) { refund(units); throw new LimitError(`你今天的${left}查詢次數已經很多了，請明天早上 8 點（台灣時間）後再試`, 'budget'); }
  return refund;
}
// seats.aero calls of one lookup, counted on their own so the unused part of the budget goes back.
function seatsCalls() {
  let n = 0;
  return { client: createClient({ apiKey: API_KEY, onCall: () => { countCall(); n++; } }), used: () => n };
}
async function budgeted(req, kind, maxUnits, fn) {
  const refund = await spendBudget(req, kind, maxUnits);
  const calls = seatsCalls();
  try { return await fn(calls.client); } finally { refund(maxUnits - (kind === 'seats' ? calls.used() : maxUnits)); }
}

async function handleSearch(q, req) {
  const params = {
    origin_airport: param(q, 'origin', IATA_LIST, { required: true, upper: true }),
    destination_airport: param(q, 'destination', IATA_LIST, { required: true, upper: true }),
    ...dateRange(q, { future: true }),
    carriers: param(q, 'carriers', CODE_LIST, { upper: true }),
    sources: param(q, 'sources', SOURCE_LIST),
    only_direct_flights: q.get('direct') === '1' ? true : undefined,
  };
  const cabin = param(q, 'cabin', /^[YWJF]$/, { upper: true });
  if (cabin) params.cabins = CABIN_NAMES[cabin];
  // Trip details carry the taxes; include them for ranges short enough that the bigger payload stays quick.
  if ((new Date(params.end_date) - new Date(params.start_date)) / 864e5 <= 45) params.include_trips = true;
  // Pages of 1,000: one call up to five months, three for a whole year.
  const out = await sharedSearch('search:' + JSON.stringify(params), async () => {
    const pages = pagesFor(params, 1, 150);
    const { items, hasMore } = MOCK ? { items: mock.mockSearch(params), hasMore: false } : await budgeted(req, 'seats', pages, (c) => c.search({ ...params, take: 1000 }, { maxPages: pages }));
    return { truncated: hasMore, results: items.map(normalizeAvailability) };
  });
  return { mock: MOCK, truncated: out.truncated, withTaxes: Boolean(params.include_trips), results: out.results };
}

async function handleExplore(q, req) {
  const params = {
    // `program`, not `source`: Vercel's rewrite drops a `source` query param.
    source: param(q, 'program', /^[a-z]+$/) || param(q, 'source', /^[a-z]+$/, { required: true }),
    ...dateRange(q, { future: true }),
    origin_region: q.get('origin_region') || undefined,
    destination_region: q.get('destination_region') || undefined,
  };
  for (const r of [params.origin_region, params.destination_region]) {
    if (r && !REGIONS.has(r)) throw new BadRequest('區域參數錯誤');
  }
  const cabin = param(q, 'cabin', /^[YWJF]$/, { upper: true }) || 'J';
  params.cabin = CABIN_NAMES[cabin];
  // Ship one compact row per result for the requested cabin; the browser filters and sorts.
  return sharedSearch('explore:' + JSON.stringify(params), async () => {
    const pages = pagesFor(params, 3);
    const { items, hasMore } = MOCK ? { items: mock.mockAvailability(params), hasMore: false } : await budgeted(req, 'seats', pages, (c) => c.availability(params, { maxPages: pages }));
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
  if (!(await cashOk(req))) throw passError(req, '需要通關密碼才能查即時票價');
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
  const raw = await shared('cash2:' + JSON.stringify(params), 1800, async () => { spent = true; return CASH_MODE === 'mock' ? mock.mockCash(params) : liveCash(params); });
  return { configured: true, mock: CASH_MODE === 'mock', cached: !spent, returning: Boolean(params.departure_token), booking: Boolean(params.booking_token), provider: raw.provider || 'mock', fallback: raw.fallback || '', ...normalizeCash(raw) };
}

// Who flies nonstop (AeroDataBox). Each origin airport costs 6 of ~400 monthly units, then stays cached for two weeks
// in Redis. Anyone may ask about Taiwan's airports and a few hubs; other origins need the passcode unless cached.
// A monthly unit counter stops new lookups while 40 units are left.
const DIRECTS_OPEN = new Set(['TPE', 'TSA', 'KHH', 'RMQ', 'TNN', 'HKG', 'NRT', 'HND', 'KIX', 'ICN', 'BKK', 'SIN']);
const DIRECTS_UNITS = Number(process.env.DIRECTS_MONTHLY_UNITS) || 400;
const DIRECTS_RESERVE = 40;
const directsQuota = { left: null, limit: null };
const directsKey = () => `directs:units:${monthTW()}`;
async function spendDirectsUnits(n) {
  if (directsQuota.left != null && directsQuota.left - n < DIRECTS_RESERVE) return false;
  const key = directsKey();
  const used = await kv.incr(key, n, 40 * 86400).catch(() => null);
  if (used != null && DIRECTS_UNITS - used < DIRECTS_RESERVE) { await kv.incr(key, -n).catch(() => {}); return false; }
  return true;
}
const directs = RAPIDAPI_KEY && createDirects({
  apiKey: RAPIDAPI_KEY,
  kv,
  legacy: HAS_REDIS ? redisStore({ url: REDIS_URL, token: REDIS_TOKEN, key: 'directs:v1' }) : null,
  spend: spendDirectsUnits,
  refund: (n) => kv.incr(directsKey(), -n).catch(() => {}),
  onQuota: (q) => Object.assign(directsQuota, q),
});
async function handleDirects(q, req) {
  const from = param(q, 'from', /^[A-Z]{3}(,[A-Z]{3}){0,2}$/, { required: true, upper: true }).split(',');
  const to = param(q, 'to', IATA_LIST, { required: true, upper: true }).split(',');
  const open = from.every((o) => DIRECTS_OPEN.has(o));
  if (MOCK && !directs) return { body: { configured: true, mock: true, ...mock.mockDirects(from, to) }, open };
  if (!directs) return { body: { configured: false }, open };
  const unlocked = await cashOk(req);
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
  if (!(await cashOk(req))) throw passError(req, '需要通關密碼才能查即時票價');
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
  const body = await shared('cashcal3:' + JSON.stringify(params), 3600, () => { spent = true; return rapidQuery.calendar(params); });
  return { configured: true, provider: 'rapid', cached: !spent, ...rapid.calendarTwd(body, (await handleFx()).rates.USD) };
}

// A RapidAPI seller's booking page (one more request), fetched when the user presses its button.
async function handleCashLink(q, req) {
  if (!(await cashOk(req))) throw passError(req, '需要通關密碼');
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
async function handleHotels(sub, q, req) {
  const call = (fn) => budgeted(req, 'rooms', 1, fn);
  if (sub === 'search') {
    const where = (q.get('where') || '').trim().replace(/\s+/g, ' ');
    if (!where || where.length > 80 || /[<>{}\\]/.test(where)) throw new BadRequest('請輸入城市或地區');
    const params = { location: where, ...dateRange(q), nights: nightsParam(q), source: hotelPrograms(q), take: 100 };
    if ((Date.parse(params.end_date) - Date.parse(params.start_date)) / 864e5 > 92) throw new BadRequest('入住日期範圍最多 3 個月');
    return sharedSearch('rooms:s:' + JSON.stringify(params), async () => ({ mock: MOCK, ...rooms.normalizeSearch(MOCK ? mock.mockRoomsSearch(params) : await call(() => roomsClient.search(params))) }));
  }
  if (sub === 'calendar') {
    const params = { hotel_id: param(q, 'hotel', HOTEL_ID, { required: true }), ...dateRange(q), nights: nightsParam(q), rate_type: 'any', take: 500 };
    return sharedSearch('rooms:c:' + JSON.stringify(params), async () => ({ mock: MOCK, ...rooms.normalizeAvailability(MOCK ? mock.mockRoomsAvailability(params) : await call(() => roomsClient.availability(params))) }));
  }
  if (sub === 'rooms') {
    const id = param(q, 'id', HOTEL_ID, { required: true });
    return sharedSearch('rooms:r:' + id, async () => ({ mock: MOCK, ...rooms.normalizeDetail(MOCK ? mock.mockRoomsDetail(id) : await call(() => roomsClient.detail(id))) }));
  }
  throw new BadRequest('未知的飯店查詢');
}

// One hotel's cash prices for the stay a points price was shown for. Spends paid lookups, so it sits behind the passcode.
// src=serpapi: every booking site incl. the hotel's own (1–2 SerpApi credits); src=booking: Booking.com via RapidAPI (2 requests,
// 1 for a hotel looked up before). SerpApi failing or missing falls back to Booking.com. Answers are shared for 30 minutes.
const serpHotelLookup = SERPAPI_KEY && hotelCash.serpHotels({ apiKey: SERPAPI_KEY, onCall: () => countSerp('hotels') });
// Booking.com requests left this month, as its last answer said; kept in Redis too, so every instance knows it.
const bookingQuota = { left: null, limit: null };
const BOOKING_QUOTA_KEY = 'booking-quota:v1';
const bookingLookup = RAPIDAPI_KEY && hotelCash.bookingHotels({
  apiKey: RAPIDAPI_KEY,
  kv,
  onQuota: (q) => {
    if (q.left === bookingQuota.left) return;
    Object.assign(bookingQuota, q);
    kv.set(BOOKING_QUOTA_KEY, q, { ex: 40 * 86400 }).catch(() => {});
  },
});
// Below this many requests left, the Accor city search (many requests) stops, keeping the rest for hotel cash prices.
const BOOKING_RESERVE = 60;
async function bookingLeft() {
  if (bookingQuota.left == null) Object.assign(bookingQuota, (await kv.get(BOOKING_QUOTA_KEY).catch(() => null)) || {});
  return bookingQuota.left;
}
async function handleHotelCash(q, req) {
  if (!(await cashOk(req))) throw passError(req, '需要通關密碼才能查飯店現金價');
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

// Accor hotels in a city, priced in ALL points (lib/accor.js): one Booking.com city search, Accor brands kept, the price
// turned into points. Never SerpApi. Requests per search: the city id and the city's brand list (each kept 30 days),
// then up to 5 result pages, each with its Chinese-name twin unless the names are known (kept 90 days), and now and
// then 2 more to learn brand ids from another city: about 5 to 12 for a new city, fewer on a repeat (the answer tells
// how many). Paging stops near the reserve. Answers are shared for 6 hours (an empty one for 30 minutes). Behind the
// passcode because it spends the Booking.com quota.
async function handleAccor(q, req) {
  if (!(await cashOk(req))) throw passError(req, '需要通關密碼才能查雅高飯店');
  const city = (q.get('city') || '').trim().replace(/\s+/g, ' ');
  if (!city || city.length > 60 || /[<>{}\\]/.test(city)) throw new BadRequest('請輸入城市');
  const checkin = param(q, 'checkin', DATE, { required: true });
  const checkout = param(q, 'checkout', DATE, { required: true });
  const nights = (Date.parse(checkout) - Date.parse(checkin)) / 864e5;
  if (nights < 1 || nights > 14) throw new BadRequest('住宿晚數需為 1 到 14 晚');
  if (checkin < todayTW()) throw new BadRequest('入住日期不可早於今天');
  const adults = Number(q.get('adults') || 2);
  if (!Number.isInteger(adults) || adults < 1 || adults > 6) throw new BadRequest('人數需為 1 到 6');
  const lat = Number(q.get('lat')); const lon = Number(q.get('lon'));
  const want = { city: cityInEnglish(city), checkin, checkout, adults, lat: q.get('lat') && Number.isFinite(lat) ? Math.round(lat * 100) / 100 : null, lon: q.get('lon') && Number.isFinite(lon) ? Math.round(lon * 100) / 100 : null };
  // Chosen brands only (「只查這些品牌」): their Booking.com brand ids, without reading the city's brand list.
  const only = [...new Set(String(q.get('brands') || '').split(',').map((b) => b.trim()).filter((b) => accor.BOOKING_BRAND_IDS[b]))].sort();
  if (only.length) want.brands = only;
  const answer = async (search) => accor.accorAnswer(search, { eurRate: (await handleFx()).rates.EUR || FX_FALLBACK.EUR, nights });
  if (MOCK && !RAPIDAPI_KEY) {
    const demo = mock.mockCityHotels(want);
    if (only.length) demo.hotels = demo.hotels.filter((h) => only.includes(accor.brandOf(h.name)));
    return { mock: true, cached: false, ...(await answer(demo)), brandsOnly: only, brandsSearchable: Object.keys(accor.BOOKING_BRAND_IDS), bookingLeft: 512, bookingLimit: 530 };
  }
  if (!bookingLookup) throw new hotelCash.HotelCashError('雅高飯店價格要用 RapidAPI 的 Booking.com API，網站還沒設定 RAPIDAPI_KEY', 503);
  let spent = false;
  const key = 'accor:v8:' + JSON.stringify(want);
  const lowQuota = () => bookingQuota.left != null && bookingQuota.left <= BOOKING_RESERVE;
  const body = await shared(key, 6 * 3600, async () => {
    const left = await bookingLeft();
    if (left != null && left <= BOOKING_RESERVE) throw new hotelCash.HotelCashError(`Booking.com 這個月只剩 ${left} 次查詢，先留給飯店現金價，雅高查詢暫停到下個月`, 429);
    spent = true;
    const search = await bookingLookup.city(want, { brands: accor.isAccorTitle, brandIds: accor.BOOKING_CHAINS, mustIds: accor.BOOKING_MUST, zhNames: true, onlyIds: only.flatMap((b) => accor.BOOKING_BRAND_IDS[b]), stopPaging: lowQuota });
    // The last search's outline (city match, how many hotels, a few names; no prices or personal data) for /api/hotels/accor/debug.
    await kv.set('accor:debug', { at: new Date().toISOString(), asked: city, query: want.city, nights, ...(search.debug || {}) }, { ex: 7 * 86400 }).catch(() => {});
    const { debug, ...rest } = search;
    if (only.length) rest.hotels = (rest.hotels || []).filter((h) => only.includes(accor.brandOf(h.name)));
    return answer(rest);
  }, { waitMs: 55000, lockSec: 120 });
  // An empty answer is kept for 30 minutes only, so a retry later asks Booking.com again without each click paying.
  if (spent && !body.hotels.length) await kv.set('cache:v1:' + hashKey(key), body, { ex: 1800 }).catch(() => {});
  return { ...body, brandsOnly: only, brandsSearchable: Object.keys(accor.BOOKING_BRAND_IDS), cached: !spent, bookingLeft: bookingQuota.left, bookingLimit: bookingQuota.limit };
}

// seats.aero availability ids are short letters-and-digits strings. An id seats.aero does not know is remembered for
// a day, so made-up ids cost one call each at most.
const TRIP_ID = MOCK ? /^[\w-]{1,80}$/ : /^[A-Za-z0-9_-]{8,64}$/;
async function handleTrips(id, req) {
  if (!TRIP_ID.test(id)) throw new BadRequest('ID 格式錯誤');
  return sharedSearch('trips:' + id, async () => {
    if (MOCK) return { mock: true, ...normalizeTrips(mock.mockTrips(id)) };
    const missKey = 'trips:miss:v1:' + hashKey(id);
    if (await kv.get(missKey).catch(() => null)) throw new SeatsAeroError('找不到這筆行程，可能已經過期', 404);
    try {
      return { mock: false, ...normalizeTrips(await budgeted(req, 'seats', 1, (c) => c.trips(id))) };
    } catch (e) {
      if ([400, 404, 422].includes(e.upstream)) {
        await kv.set(missKey, 1, { ex: 86400 }).catch(() => {});
        throw new SeatsAeroError('找不到這筆行程，可能已經過期', 404);
      }
      throw e;
    }
  });
}

// Public lookups the CDN keeps by full URL: an address with parameters the endpoint does not read (or one twice) is
// sent to the same address without them, so junk like `&_=123` cannot skip the CDN and cost a seats.aero call.
const KNOWN_PARAMS = {
  '/api/search': ['origin', 'destination', 'start', 'end', 'carriers', 'sources', 'direct', 'cabin'],
  '/api/explore': ['program', 'source', 'start', 'end', 'origin_region', 'destination_region', 'cabin'],
  '/api/hotels/search': ['where', 'start', 'end', 'nights', 'programs'],
  '/api/hotels/calendar': ['hotel', 'start', 'end', 'nights'],
  '/api/hotels/rooms': ['id'],
  '/api/history': ['origin', 'destination'],
  '/api/deals': ['at'],
  // `v`: the page asks past the CDN's copy right after it saved a calendar.
  '/api/cxcal': ['origin', 'destination', 'v'],
};
function canonicalUrl(p, q) {
  const known = p.startsWith('/api/trips/') ? [] : KNOWN_PARAMS[p];
  if (!known) return null;
  const keys = [...q.keys()];
  if (keys.every((k) => known.includes(k)) && new Set(keys).size === keys.length) return null;
  const out = new URLSearchParams();
  for (const k of known) if (q.has(k)) out.set(k, q.get(k));
  return `${p}${[...out].length ? `?${out}` : ''}`;
}

// 一句話搜尋 (lib/nlsearch.js): a small model (OpenAI GPT-6 Luna or Claude Haiku) turns one sentence into the search
// form's conditions. Only with OPENAI_API_KEY or ANTHROPIC_API_KEY (NL_PROVIDER picks when both are set; the demo uses
// a rule-based stand-in); without either the endpoint is a 404 and the box never shows.
// Owner only (the passcode, like the cash fares), NL_DAILY_LIMIT calls a Taiwan day, the same sentence cached a day.
const NL = pickProvider(process.env, MOCK);
const nlSearch = createNlSearch({
  mode: NL.mode,
  provider: NL.provider || undefined,
  apiKey: NL.apiKey,
  kv,
  today: () => todayTW(),
  taiwan: (start, end) => travelInfo.taiwan(start, end),
  airportCodes: new Set(AIRPORTS.keys()),
  groups: AIRPORT_FILE.groups || [],
  airports: AIRPORT_FILE.airports,
  // One entry per program name (copa / connectmiles share one), without the estimate-only source.
  programs: Object.entries(SOURCE_NAMES).filter(([id, name], i, all) => !id.endsWith('_est') && all.findIndex(([, n]) => n === name) === i).map(([id, name]) => ({ id, name })),
  regions: require('./data/airports.json').regions,
  limit: Number(process.env.NL_DAILY_LIMIT) || 100,
  timeoutMs: 15000,
});
async function handleNl(req) {
  if (!fromPage(req)) throw new NlError('請從網站頁面使用一句話搜尋', 403);
  if ((await runCaller(req)) !== 'owner') {
    throw cashPasscode() ? passError(req, '需要通關密碼才能使用一句話搜尋') : Object.assign(new CashError('要先在 Vercel 設定 CASH_PASSCODE，才能使用一句話搜尋', 401), { code: 'setup' });
  }
  const body = await readJson(req, 2000);
  return nlSearch.parse(body.text);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' };

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
function sendJson(res, status, body, cache, extra = {}) {
  res.writeHead(status, { 'content-type': MIME['.json'], 'cache-control': status === 200 && cache ? cache : 'no-store', ...extra });
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
const DATA_FILE_NAMES = { sourcenames: 'source-names', airlinenames: 'airline-names', airportnames: 'airport-names-zh' };
const dataFile = (name) => path.join(DATA_DIR, (DATA_FILE_NAMES[name] || name) + '.json');
const DATA = Object.fromEntries(DATA_FILES.map((n) => {
  const body = fs.readFileSync(dataFile(n));
  return [n, { body, etag: etagOf(body) }];
}));
const dataBundle = (names) => {
  const body = JSON.stringify(Object.fromEntries(names.map((n) => [n, JSON.parse(DATA[n].body)])));
  return { body, etag: etagOf(body) };
};
const DATA_BUNDLES = { all: dataBundle(DATA_FILES), core: dataBundle(DATA_PARTS.core), more: dataBundle(DATA_PARTS.more) };
// Stopover/open-jaw rules and positioning hubs (etrips.js), fetched only when those tools open, so not in a bundle.
const ROUTING_BODY = fs.readFileSync(path.join(DATA_DIR, 'routing.json'));
const ROUTING = { body: ROUTING_BODY, etag: etagOf(ROUTING_BODY) };
const MUSE_TPL_BODY = fs.readFileSync(path.join(DATA_DIR, 'muse-templates.json')); // cxmuse.js's airline templates
const MUSE_TPL = { body: MUSE_TPL_BODY, etag: etagOf(MUSE_TPL_BODY) };

function staticPolicy(rel, q) {
  if (rel.endsWith('.html')) return 'no-cache';
  if (rel === '/airports.min.json' || /^\/icon-[\w-]+\.png$/.test(rel) || /^\/logos\/\w+\.webp$/.test(rel)) return 'public, max-age=86400, stale-while-revalidate=604800';
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
    // The owner's status line: how today's runs went and every instance's seats.aero calls. Not for visitors.
    if (p === '/api/cron/status') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
      if ((await runCaller(req)) !== 'owner') return sendJson(res, 403, { error: '只有站長看得到排程狀態', code: 'owner-only' });
      const [morning, evening] = await Promise.all(['morning', 'evening'].map((k) => kv.get(`cron:done:${k}`).catch(() => null)));
      return sendJson(res, 200, { ...(await cronStatus()), runs: [morning, evening].filter(Boolean).sort((a, b) => a.at.localeCompare(b.at)), callsTodayAll: Number(await kv.get(seatsAllKey()).catch(() => 0)) || 0, dailyLimit: 1000 });
    }
    if (p === '/api/alerts' || p === '/api/alerts/run') {
      if (!['GET', 'POST', 'PUT', 'DELETE'].includes(req.method)) return sendJson(res, 405, { error: 'method not allowed' });
      return sendJson(res, 200, await handleAlerts(req, q, p.endsWith('/run') ? 'run' : ''));
    }
    const am = p.match(/^\/api\/account(?:\/(signup|verify|login|logout|forgot|reset|password|unlock|data))?$/);
    if (am) {
      if (!['GET', 'POST', 'PUT', 'DELETE'].includes(req.method)) return sendJson(res, 405, { error: 'method not allowed' });
      return await handleAccount(req, res, am[1] || '');
    }
    const dsm = p.match(/^\/api\/dealsub(?:\/(owner|unsubscribe))?$/);
    if (dsm) {
      if (!['GET', 'POST'].includes(req.method)) return sendJson(res, 405, { error: 'method not allowed' });
      return await handleDealSub(req, res, dsm[1] || '', q);
    }
    const adm = p.match(/^\/api\/admin\/accounts(?:\/(delete|signout))?$/);
    if (adm) {
      if (!['GET', 'POST'].includes(req.method)) return sendJson(res, 405, { error: 'method not allowed' });
      return await handleAdmin(req, res, adm[1] || '');
    }
    if (p === '/api/telegram' || p === '/api/telegram/link' || p === '/api/telegram/test') {
      if (!['GET', 'POST', 'DELETE'].includes(req.method)) return sendJson(res, 405, { error: 'method not allowed' });
      return sendJson(res, 200, await handleTelegram(req, p.endsWith('/link') ? 'link' : p.endsWith('/test') ? 'test' : ''));
    }
    const lm = p.match(/^\/api\/line(?:\/(code|test|demo|webhook))?$/);
    if (lm) {
      if (!['GET', 'POST', 'DELETE'].includes(req.method)) return sendJson(res, 405, { error: 'method not allowed' });
      return sendJson(res, 200, await handleLine(req, lm[1] || ''));
    }
    if (p === '/api/expiry') {
      if (!['GET', 'POST'].includes(req.method)) return sendJson(res, 405, { error: 'method not allowed' });
      return sendJson(res, 200, await handleExpiry(req));
    }
    if (p === '/api/cxcal') {
      if (!['GET', 'POST'].includes(req.method)) return sendJson(res, 405, { error: 'method not allowed' });
      const cc = req.method === 'GET' && canonicalUrl(p, q);
      if (cc) {
        res.writeHead(301, { location: cc, 'cache-control': 'public, max-age=3600, s-maxage=86400' });
        return res.end();
      }
      // Reading is public and the same for everyone, so the CDN may keep it for a minute.
      return sendJson(res, 200, await handleCxcal(req, q), req.method === 'GET' ? CACHE.short : null);
    }
    if (p === '/api/deals' && req.method === 'POST') return sendJson(res, 200, await refreshDealsNow(req));
    if (p === '/api/nl') {
      if (!nlSearch.enabled) return sendJson(res, 404, { error: 'not found' });
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
      return sendJson(res, 200, await handleNl(req));
    }
    if (p === '/api/watch') {
      if (!['GET', 'POST', 'DELETE'].includes(req.method)) return sendJson(res, 405, { error: 'method not allowed' });
      return sendJson(res, 200, await handleWatch(req, q));
    }
    // HEAD only where the answer is a fixed file: the data files and the static site.
    const headOk = p.startsWith('/api/data/') || !p.startsWith('/api/');
    if (req.method !== 'GET' && !(req.method === 'HEAD' && headOk)) return sendJson(res, 405, { error: 'method not allowed' });
    const canon = req.method === 'GET' && canonicalUrl(p, q);
    if (canon) {
      res.writeHead(301, { location: canon, 'cache-control': 'public, max-age=3600, s-maxage=86400' });
      return res.end();
    }
    if (p === '/api/config') {
      return sendJson(res, 200, {
        // callsToday: this instance's seats.aero calls; callsTodayAll: every instance's (visitors' lookups and the daily jobs).
        mock: MOCK, callsToday: usage.calls, callsTodayAll: Number(await kv.get(seatsAllKey()).catch(() => 0)) || 0, dailyLimit: 1000, cash: CASH_MODE, cashSources: { rapid: Boolean(RAPIDAPI_KEY), serpapi: Boolean(SERPAPI_KEY) }, cashLocked: Boolean(cashPasscode()),
        alerts: { store: Boolean(alerts), email: Boolean(alertMailer) }, watch: Boolean(priceWatch),
        nl: nlSearch.enabled,
        accounts: Boolean(accounts), accountEmail: Boolean(accounts?.mailOn && alertMailer),
        line: await line.status().then((s) => ({ configured: s.configured, linked: s.linked, ...(s.missing ? { missing: s.missing } : {}), ...(s.configured ? { tokenOk: s.tokenOk } : {}) })).catch(() => ({ configured: line.configured })),
        searchCache: await searchCache.stats(),
        telegram: { configured: telegram.configured, linked: (await telegram.status().catch(() => ({}))).linked === true, tokenOk: telegram.configured ? (await telegram.bot()).tokenOk : null },
        cron: await cronStatus(),
        hotels: { callsToday: roomsUsage.day === new Date().toISOString().slice(0, 10) ? roomsUsage.calls : 0, dailyLimit: 1000, accor: Boolean(RAPIDAPI_KEY) || MOCK },
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
    if (p === '/api/hotels/accor') return sendJson(res, 200, await handleAccor(q, req));
    if (p === '/api/hotels/accor/debug') {
      if (!(await cashOk(req))) throw passError(req, '需要通關密碼');
      return sendJson(res, 200, (await kv.get('accor:debug').catch(() => null)) || {});
    }
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
    if (hm) return sendJson(res, 200, await handleHotels(hm[1], q, req), CACHE.search);
    if (p === '/api/fx') {
      const fx = await handleFx();
      return sendJson(res, 200, fx, fx.live ? CACHE.fx : CACHE.short);
    }
    if (p === '/api/deals') {
      const d = await handleDeals(q);
      // Asked for a copy at least as new as `at` and this is older: not kept by the CDN under that address.
      const older = q.has('at') && String(d.generatedAt || '') < q.get('at');
      return sendJson(res, 200, d, older ? null : d.groups?.length ? CACHE.deals : CACHE.short);
    }
    if (p === '/api/history') {
      const h = await history.get(param(q, 'origin', IATA_LIST, { required: true, upper: true }), param(q, 'destination', IATA_LIST, { required: true, upper: true }));
      return sendJson(res, 200, h, CACHE.deals);
    }
    if (p === '/api/search') return sendJson(res, 200, await handleSearch(q, req), CACHE.search);
    if (p === '/api/explore') return sendJson(res, 200, await handleExplore(q, req), CACHE.search);
    if (p.startsWith('/api/trips/')) {
      let id;
      try { id = decodeURIComponent(p.slice(11)); } catch { throw new BadRequest('網址編碼錯誤'); }
      return sendJson(res, 200, await handleTrips(id, req), CACHE.search);
    }
    const dm = p.match(/^\/api\/data\/(all|core|more)$/);
    if (dm) {
      return sendBody(req, res, { ...DATA_BUNDLES[dm[1]], type: MIME['.json'], cache: q.get('v') === VERSION.version ? CACHE.immutable : CACHE.data });
    }
    if (p === '/api/data/routing') return sendBody(req, res, { ...ROUTING, type: MIME['.json'], cache: CACHE.data });
    if (p === '/api/data/musetemplates') return sendBody(req, res, { ...MUSE_TPL, type: MIME['.json'], cache: CACHE.data });
    const m = p.match(/^\/api\/data\/(\w+)$/);
    if (m && DATA_FILES.includes(m[1])) return sendBody(req, res, { ...DATA[m[1]], type: MIME['.json'], cache: CACHE.data });
    if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });
    serveStatic(req, res, url);
  } catch (e) {
    if (e instanceof BadRequest) return sendJson(res, 400, { error: e.message });
    if (e instanceof AccountError && e.current) return sendJson(res, e.status, { error: e.message, code: e.code, ...e.current });
    if (e instanceof LimitError || e instanceof CxcalError || e instanceof SeatsAeroError || e instanceof CashError || e instanceof AlertError || e instanceof rooms.RoomsError || e instanceof DirectsError || e instanceof hotelCash.HotelCashError || e instanceof KvError || e instanceof tg.TelegramError || e instanceof lineLib.LineError || e instanceof AccountError || e instanceof AdminError || e instanceof DealSubError || e instanceof NlError) return sendJson(res, e.status, { error: e.message, code: e.code });
    console.error(e);
    sendJson(res, 500, { error: '伺服器錯誤' });
  }
}

const server = http.createServer(route);
if (require.main === module) {
  server.listen(PORT, () => console.log(`http://localhost:${PORT}  ${MOCK ? '(示範資料模式：未設定 SEATS_AERO_API_KEY)' : '(使用 seats.aero API)'}`));
}
module.exports = { server, route, cached, passBucket, dealSub, VERSION_STRING: VERSION.version };
