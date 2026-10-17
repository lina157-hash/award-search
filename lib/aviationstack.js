// 飛機現在在哪's backup source: Aviationstack (aviationstack.com/pricing, read 2026-10-17: the Free plan has 100
// requests a month, HTTPS, non-commercial use). Asked only inside a 查航班動態 click, and only when AeroDataBox has the
// flight in the air but sent no position. Needs AVIATIONSTACK_API_KEY in Vercel; without it nothing here runs.
// GET /v1/flights?access_key=…&flight_iata=BR32 → { data: [{ flight_date, departure: { iata }, live: { updated,
// latitude, longitude, altitude (m), direction (°), speed_horizontal (km/h), is_ground } }] }; live is often null.
// Errors come back as { error: { code, message } }, usage_limit_reached when the month's requests are gone.
const { position } = require('./flightstatus');

function createAviationstack({ apiKey, fetchImpl = fetch, kv = null, now = () => Date.now(), month = () => new Date(now()).toISOString().slice(0, 7), monthly = 100, reserve = 5, ttlSec = 600 } = {}) {
  const memo = new Map();
  let blockedUntil = 0;
  const countKey = () => `avstack:req:${month()}`;
  async function used() { return kv ? Number(await kv.get(countKey()).catch(() => 0)) || 0 : 0; }
  // { pos, spent, left, limit }: pos null when there is none; spent 1 when a request went out.
  async function lookup(flight, date, from = '') {
    const key = `fpos:v1:${flight}:${date}:${from}`;
    const hit = memo.get(key) || (kv ? await kv.get(key).catch(() => null) : null);
    if (hit && now() - hit.at < ttlSec * 1000) return { pos: hit.pos, spent: 0, left: Math.max(0, monthly - (await used())), limit: monthly };
    if (now() < blockedUntil) return { pos: null, spent: 0, left: 0, limit: monthly, why: 'quota' };
    if (kv) {
      const n = await kv.incr(countKey(), 1, 40 * 86400).catch(() => null);
      if (n != null && n > monthly - reserve) { await kv.incr(countKey(), -1).catch(() => {}); return { pos: null, spent: 0, left: Math.max(0, monthly - n + 1), limit: monthly, why: 'quota' }; }
    }
    const refund = () => (kv ? kv.incr(countKey(), -1).catch(() => {}) : null);
    let body = null;
    try {
      const res = await fetchImpl(`https://api.aviationstack.com/v1/flights?${new URLSearchParams({ access_key: apiKey, flight_iata: flight })}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
      if (res.status >= 500) { await refund(); return { pos: null, spent: 0, left: null, limit: monthly, why: 'down' }; }
      body = await res.json().catch(() => null);
    } catch {
      await refund();
      return { pos: null, spent: 0, left: null, limit: monthly, why: 'down' };
    }
    if (body?.error) {
      if (/usage_limit|limit_reached/i.test(String(body.error.code || ''))) blockedUntil = now() + 24 * 3600e3;
      return { pos: null, spent: 1, left: Math.max(0, monthly - (await used())), limit: monthly, why: 'error' };
    }
    const rows = (Array.isArray(body?.data) ? body.data : []).filter((f) => f?.live && !f.live.is_ground);
    const best = rows.find((f) => f.flight_date === date && (!from || f.departure?.iata === from)) || rows.find((f) => f.flight_date === date) || null;
    const l = best?.live;
    const pos = l ? position({ lat: l.latitude, lon: l.longitude, altitude: { meter: l.altitude }, groundSpeed: { kmPerHour: l.speed_horizontal }, trueTrack: { deg: l.direction }, reportedAtUtc: l.updated }, 'aviationstack') : null;
    const entry = { at: now(), pos };
    memo.set(key, entry);
    if (memo.size > 200) memo.delete(memo.keys().next().value);
    if (kv) await kv.set(key, entry, { ex: ttlSec }).catch(() => {});
    return { pos, spent: 1, left: Math.max(0, monthly - (await used())), limit: monthly };
  }
  return { lookup };
}

module.exports = { createAviationstack };
