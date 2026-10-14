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

// `store` keeps { [origin]: { at, routes } } across serverless instances (Redis); `memo` is the per-instance copy.
function createDirects({ apiKey, fetchImpl = fetch, store = null, ttlMs = 14 * 864e5, onQuota = () => {} }) {
  const memo = new Map();
  const pending = new Map();
  let blockedUntil = 0;
  // Visitors asking about the same airport at once share one call.
  function routesFrom(origin) {
    if (!pending.has(origin)) pending.set(origin, load(origin).finally(() => pending.delete(origin)));
    return pending.get(origin);
  }
  async function load(origin) {
    const hit = memo.get(origin);
    if (hit && Date.now() - hit.at < ttlMs) return hit;
    if (store) {
      const saved = await store.load().catch(() => null);
      const s = saved && !Array.isArray(saved) ? saved[origin] : null;
      if (s && Date.now() - s.at < ttlMs) { memo.set(origin, s); return s; }
    }
    if (Date.now() < blockedUntil) throw new DirectsError('直飛資料這個月的免費額度用完了', 429);
    const res = await fetchImpl(`https://${HOST}/airports/iata/${origin}/stats/routes/daily`, { headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': HOST, accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
    const left = res.headers.get('x-ratelimit-api-units-remaining') ?? res.headers.get('x-ratelimit-requests-remaining');
    if (left != null && Number.isFinite(Number(left))) onQuota({ left: Number(left), limit: Number(res.headers.get('x-ratelimit-api-units-limit')) || null });
    if (res.status === 204) return remember({ at: Date.now(), routes: [] });
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
    return remember({ at: Date.now(), routes });
    async function remember(entry) {
      memo.set(origin, entry);
      if (store) {
        const saved = await store.load().catch(() => null);
        const all = saved && !Array.isArray(saved) ? saved : {};
        all[origin] = entry;
        // Keep the store small: drop the oldest airports past 40.
        const keys = Object.keys(all).sort((a, b) => all[b].at - all[a].at);
        for (const k of keys.slice(40)) delete all[k];
        await store.save(all).catch(() => {});
      }
      return entry;
    }
  }
  // Nonstop carriers from any of `from` to any of `to` (a city can have several airports).
  async function between(from, to) {
    const entries = await Promise.all(from.map(routesFrom));
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
