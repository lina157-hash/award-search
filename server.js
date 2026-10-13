// Award search server: serves the frontend and proxies seats.aero so the API key stays server-side.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createClient, normalizeAvailability, normalizeTrips, SeatsAeroError } = require('./lib/seats');
const mock = require('./lib/mock');
const { createCashClient, normalizeCash, CashError } = require('./lib/cash');

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.SEATS_AERO_API_KEY || '';
const MOCK = !API_KEY || process.env.MOCK === '1';
const SERPAPI_KEY = process.env.SERPAPI_KEY || '';
// Cash fares: live with a SerpApi key, demo data when the whole site is in demo mode, otherwise off.
const CASH_MODE = SERPAPI_KEY ? 'live' : MOCK ? 'mock' : 'off';
const CACHE_TTL_MS = (Number(process.env.CACHE_TTL_SECONDS) || 1800) * 1000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILES = ['airlines', 'alliances', 'airports', 'programs', 'glossary', 'asiamiles'];

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
const IATA_LIST = /^[A-Z]{3}(,[A-Z]{3}){0,9}$/;
const CODE_LIST = /^[A-Z0-9]{2}(,[A-Z0-9]{2}){0,29}$/;
const SOURCE_LIST = /^[a-z]+(,[a-z]+){0,29}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
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
  if (days > 60) throw new BadRequest('日期範圍最多 60 天');
  return { start_date: start, end_date: end };
}

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
  const key = 'search:' + JSON.stringify(params);
  const raw = await cached(key, () => (MOCK ? mock.mockSearch(params) : client.search(params)));
  return { mock: MOCK, results: raw.map(normalizeAvailability) };
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
  const { items, hasMore } = await cached(key, () => (MOCK ? { items: mock.mockAvailability(params), hasMore: false } : client.availability(params)));
  // Ship one compact row per result for the requested cabin; the browser filters and sorts.
  const results = items.map(normalizeAvailability).filter((r) => r.cabins[cabin].available).map((r) => {
    const c = r.cabins[cabin];
    return { id: r.id, date: r.date, origin: r.origin, destination: r.destination, source: r.source, distance: r.distance, miles: c.miles, seats: c.seats, airlines: c.airlines, direct: c.direct };
  });
  results.sort((a, b) => a.miles - b.miles);
  return { mock: MOCK, cabin, total: results.length, truncated: hasMore, results };
}

const ALLIANCE_PARAM = { star: 'STAR_ALLIANCE', skyteam: 'SKYTEAM', oneworld: 'ONEWORLD' };
const CABIN_CLASS = { Y: 1, W: 2, J: 3, F: 4 };

async function handleCash(q) {
  if (CASH_MODE === 'off') return { configured: false, options: [] };
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
  };
  if (params.departure_token && !ret) throw new BadRequest('只有來回票才能查回程');
  const raw = await cached('cash:' + JSON.stringify(params), () => (CASH_MODE === 'mock' ? mock.mockCash(params) : cashQuery(params)));
  return { configured: true, mock: CASH_MODE === 'mock', returning: Boolean(params.departure_token), ...normalizeCash(raw) };
}

async function handleTrips(id) {
  if (!/^[\w-]{1,80}$/.test(id)) throw new BadRequest('ID 格式錯誤');
  const raw = await cached('trips:' + id, () => (MOCK ? mock.mockTrips(id) : client.trips(id)));
  return { mock: MOCK, ...normalizeTrips(raw) };
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

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
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
    if (p === '/api/config') {
      return sendJson(res, 200, {
        mock: MOCK, callsToday: usage.calls, dailyLimit: 1000, cash: CASH_MODE,
        // Which deployment is answering, to confirm a redeploy went live.
        commit: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7),
      });
    }
    if (p === '/api/cash') return sendJson(res, 200, await handleCash(q));
    if (p === '/api/search') return sendJson(res, 200, await handleSearch(q));
    if (p === '/api/explore') return sendJson(res, 200, await handleExplore(q));
    if (p.startsWith('/api/trips/')) return sendJson(res, 200, await handleTrips(decodeURIComponent(p.slice(11))));
    const m = p.match(/^\/api\/data\/(\w+)$/);
    if (m && DATA_FILES.includes(m[1])) {
      res.writeHead(200, { 'content-type': MIME['.json'] });
      return fs.createReadStream(path.join(DATA_DIR, m[1] + '.json')).pipe(res);
    }
    if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });
    serveStatic(res, p);
  } catch (e) {
    if (e instanceof BadRequest) return sendJson(res, 400, { error: e.message });
    if (e instanceof SeatsAeroError || e instanceof CashError) return sendJson(res, e.status, { error: e.message });
    console.error(e);
    sendJson(res, 500, { error: '伺服器錯誤' });
  }
}

const server = http.createServer(route);
if (require.main === module) {
  server.listen(PORT, () => console.log(`http://localhost:${PORT}  ${MOCK ? '(示範資料模式：未設定 SEATS_AERO_API_KEY)' : '(使用 seats.aero API)'}`));
}
module.exports = { server, route };
