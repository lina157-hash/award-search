// Who flies an airport pair nonstop, from AeroDataBox's route statistics on RapidAPI (same RAPIDAPI_KEY).
// One call lists every nonstop route out of an airport with the last 7 days' average flights; it costs 6 of the
// free plan's monthly units (400, some report 600), so each airport's answer is kept for two weeks.
// The free plan is non-commercial and needs a visible "AeroDataBox" link on the page.
const HOST = 'aerodatabox.p.rapidapi.com';
const NAMES = require('../data/airline-names.json').airlines;

class DirectsError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

const squash = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
const BY_NAME = new Map(NAMES.flatMap(([code, zh, ...names]) => names.map((n) => [squash(n), { code, zh }])));
const BY_CODE = new Map(NAMES.map(([code, zh]) => [code, zh]));
function airlineOf(op) {
  const code = /^[A-Z0-9]{2}$/.test(op.iata || '') ? op.iata : BY_NAME.get(squash(op.name))?.code || '';
  return { code, name: op.name || code, zh: BY_CODE.get(code) || BY_NAME.get(squash(op.name))?.zh || '' };
}

// `kv` (lib/kv.js) keeps one entry per origin airport (`directs:v1:TPE`, two weeks) across serverless instances;
// `memo` is the per-instance copy. `legacy` (optional) is the old single-blob store, read once so airports already
// paid for are not fetched again. `canFetch(origin)` → false: that airport may only be served from the cache.
// `spend(units)` → false: the monthly budget is used up, do not call. `refund(units)`: a call that failed (network,
// rate limit, server error) gives its units back.
const UNITS_PER_CALL = 6;
function createDirects({ apiKey, fetchImpl = fetch, kv = null, legacy = null, ttlMs = 14 * 864e5, onQuota = () => {}, spend = async () => true, refund = async () => {} }) {
  const memo = new Map();
  const pending = new Map();
  let blockedUntil = 0;
  let legacyAll;
  // Visitors asking about the same airport at once share one call.
  function routesFrom(origin, { canFetch = () => true } = {}) {
    const allowed = Boolean(canFetch(origin));
    const key = allowed ? origin : `${origin}:cache-only`;
    if (!pending.has(key)) pending.set(key, load(origin, allowed).finally(() => pending.delete(key)));
    return pending.get(key);
  }
  async function cachedEntry(origin) {
    const hit = memo.get(origin);
    if (hit && Date.now() - hit.at < ttlMs) return hit;
    if (kv) {
      const s = await kv.get(`directs:v1:${origin}`).catch(() => null);
      if (s && Date.now() - s.at < ttlMs) { memo.set(origin, s); return s; }
    }
    if (legacy) {
      legacyAll ??= await legacy.load().catch(() => null);
      const s = legacyAll && !Array.isArray(legacyAll) ? legacyAll[origin] : null;
      if (s && Date.now() - s.at < ttlMs) return remember(origin, s);
    }
    return null;
  }
  async function remember(origin, entry) {
    memo.set(origin, entry);
    if (kv) await kv.set(`directs:v1:${origin}`, entry, { ex: Math.max(60, Math.round((entry.at + ttlMs - Date.now()) / 1000)) }).catch(() => {});
    return entry;
  }
  async function load(origin, allowed) {
    const hit = await cachedEntry(origin);
    if (hit) return hit;
    if (!allowed) throw Object.assign(new DirectsError('這個機場的直飛資料要輸入通關密碼才能查', 403), { locked: true });
    if (Date.now() < blockedUntil) throw new DirectsError('直飛資料這個月的免費額度用完了', 429);
    if (!(await spend(UNITS_PER_CALL))) throw new DirectsError('直飛資料這個月的額度快用完了，先暫停查新的機場', 429);
    let res;
    try {
      res = await fetchImpl(`https://${HOST}/airports/iata/${origin}/stats/routes/daily`, { headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': HOST, accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
    } catch {
      await refund(UNITS_PER_CALL);
      throw new DirectsError('直飛資料來源連線失敗', 504);
    }
    // No routes came back, so no units are counted as used.
    if (res.status === 429 || res.status === 401 || res.status === 403 || res.status >= 500) await refund(UNITS_PER_CALL);
    const left = res.headers.get('x-ratelimit-api-units-remaining') ?? res.headers.get('x-ratelimit-requests-remaining');
    if (left != null && Number.isFinite(Number(left))) onQuota({ left: Number(left), limit: Number(res.headers.get('x-ratelimit-api-units-limit')) || null });
    if (res.status === 204) return remember(origin, { at: Date.now(), routes: [] });
    const body = await res.json().catch(() => ({}));
    const msg = String(body.message || '');
    if (res.status === 429) {
      if (/monthly quota/i.test(msg)) blockedUntil = Date.now() + 24 * 3600e3;
      throw new DirectsError(/monthly quota/i.test(msg) ? '直飛資料這個月的免費額度用完了' : '直飛資料查詢太頻繁，請稍後再試', 429);
    }
    if (res.status === 401 || res.status === 403) throw new DirectsError(/not subscribed/i.test(msg) ? 'RapidAPI 金鑰還沒訂閱 AeroDataBox' : 'RapidAPI 金鑰無法使用 AeroDataBox', res.status);
    if (!res.ok) throw new DirectsError(`直飛資料來源回應錯誤 (${res.status})`, 502);
    const routes = (body.routes || []).map((r) => ({
      to: r.destination?.iata || '',
      perDay: Number.isFinite(r.averageDailyFlights) ? r.averageDailyFlights : null,
      airlines: (r.operators || []).map(airlineOf),
    })).filter((r) => /^[A-Z]{3}$/.test(r.to));
    return remember(origin, { at: Date.now(), routes });
  }
  // Nonstop carriers from any of `from` to any of `to` (a city can have several airports).
  async function between(from, to, opts = {}) {
    const entries = await Promise.all(from.map((o) => routesFrom(o, opts)));
    const targets = new Set(to);
    const hits = entries.flatMap((e) => e.routes).filter((r) => targets.has(r.to));
    const entry = { at: Math.min(...entries.map((e) => e.at)) };
    const airlines = new Map();
    for (const r of hits) for (const a of r.airlines) airlines.set(a.code || a.name, a);
    return {
      airlines: [...airlines.values()],
      perDay: hits.length ? Math.round(hits.reduce((n, r) => n + (r.perDay || 0), 0) * 10) / 10 : 0,
      airports: hits.map((r) => r.to),
      updated: new Date(entry.at).toISOString().slice(0, 10),
    };
  }
  return { between, routesFrom };
}

module.exports = { createDirects, DirectsError, airlineOf };
