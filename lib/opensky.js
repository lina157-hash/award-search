// 飛機現在在哪's first source: OpenSky Network's live positions (REST API, openskynetwork.github.io/opensky-api/rest.html,
// read 2026-10-17). The owner chose it knowing its terms (opensky-network.org/about/terms-of-use: the free licence is for
// non-profit research and education, and automated use needs their written agreement), so it is kept to the owner's
// own clicks: only inside 查航班動態 (the passcode), one lookup per click, kept a minute.
// - GET /api/states/all?icao24=<hex>: the plane by its transponder address (AeroDataBox's aircraft.modeS); without one,
//   ?lamin&lomin&lamax&lomax round the two airports, matched on the call sign (AeroDataBox's callSign, "EVA198").
//   Credits: 1–4 by box size (4 for a box over 400 sq° or the whole world); 400 a day without an account, 4,000 with one.
// - A state vector is an array: 0 icao24, 1 callsign, 3 time_position (s), 5 longitude, 6 latitude, 7 baro_altitude (m),
//   8 on_ground, 9 velocity (m/s), 10 true_track (°), 13 geo_altitude (m).
// - With OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET (an API client made on the OpenSky account page): OAuth2 client
//   credentials, a token good for 30 minutes sent as a Bearer header; without them, anonymous.
// - X-Rate-Limit-Remaining: credits left; 429 with X-Rate-Limit-Retry-After-Seconds when they are gone.
const { position } = require('./flightstatus');

const API = 'https://opensky-network.org/api';
const TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';

function createOpenSky({ clientId = '', clientSecret = '', fetchImpl = fetch, kv = null, now = () => Date.now(), ttlSec = 60 } = {}) {
  let token = null;
  let blockedUntil = 0;
  let left = null;
  const memo = new Map();
  async function auth(force = false) {
    if (!clientId || !clientSecret) return null;
    if (!force && token && now() < token.until) return token.v;
    const res = await fetchImpl(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }).toString(), signal: AbortSignal.timeout(10000) });
    const body = res.ok ? await res.json().catch(() => null) : null;
    if (!body?.access_token) { token = null; return null; }
    token = { v: body.access_token, until: now() + Math.max(60, (Number(body.expires_in) || 1800) - 60) * 1000 };
    return token.v;
  }
  async function get(path, retry = true) {
    const t = await auth();
    const res = await fetchImpl(`${API}${path}`, { headers: { accept: 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, signal: AbortSignal.timeout(12000) });
    const rem = res.headers.get('x-rate-limit-remaining');
    if (rem != null && Number.isFinite(Number(rem))) left = Number(rem);
    if (res.status === 401 && t && retry) { await auth(true); return get(path, false); }
    if (res.status === 429) {
      blockedUntil = now() + (Number(res.headers.get('x-rate-limit-retry-after-seconds')) || 3600) * 1000;
      left = 0;
      return { why: 'quota' };
    }
    if (!res.ok) return { why: 'down' };
    return { body: await res.json().catch(() => null) };
  }
  // The box round both airports, a few degrees wider; none across 180° (no box can say that) or without both ends.
  function boxOf(a, b) {
    if (!a || !b || Math.abs(a.lon - b.lon) > 180) return null;
    const pad = 3;
    return { lamin: Math.max(-90, Math.min(a.lat, b.lat) - pad), lamax: Math.min(90, Math.max(a.lat, b.lat) + pad), lomin: Math.max(-180, Math.min(a.lon, b.lon) - pad), lomax: Math.min(180, Math.max(a.lon, b.lon) + pad) };
  }
  // { pos, left, why }: pos null when OpenSky has not heard the plane lately (or it is on the ground).
  async function lookup({ icao24 = '', callsign = '', from = null, to = null } = {}) {
    const hex = /^[0-9a-f]{6}$/i.test(icao24) ? icao24.toLowerCase() : '';
    const cs = String(callsign || '').replace(/\s+/g, '').toUpperCase();
    const box = hex ? null : boxOf(from, to);
    if (!hex && !(cs && box)) return { pos: null, left, why: 'nokey' };
    const key = `osky:v1:${hex || `${cs}:${Object.values(box).map((x) => x.toFixed(1)).join(',')}`}`;
    const hit = memo.get(key) || (kv ? await kv.get(key).catch(() => null) : null);
    if (hit && now() - hit.at < ttlSec * 1000) return { pos: hit.pos, left, cached: true };
    if (now() < blockedUntil) return { pos: null, left: 0, why: 'quota' };
    let r;
    try {
      r = await get(hex ? `/states/all?icao24=${hex}` : `/states/all?${new URLSearchParams(Object.fromEntries(Object.entries(box).map(([k, v]) => [k, v.toFixed(2)])))}`);
    } catch {
      return { pos: null, left, why: 'down' };
    }
    if (r.why) return { pos: null, left, why: r.why };
    const states = (Array.isArray(r.body?.states) ? r.body.states : []).filter((s) => Array.isArray(s) && !s[8] && s[5] != null && s[6] != null);
    const s = hex ? states.find((x) => String(x[0]).toLowerCase() === hex) : states.find((x) => String(x[1] || '').trim().toUpperCase() === cs);
    const pos = s ? position({ lat: s[6], lon: s[5], altitude: { meter: s[7] ?? s[13] }, groundSpeed: { meterPerSecond: s[9] }, trueTrack: { deg: s[10] }, reportedAtUtc: s[3] ? new Date(s[3] * 1000).toISOString() : '' }, 'opensky') : null;
    const entry = { at: now(), pos };
    memo.set(key, entry);
    if (memo.size > 200) memo.delete(memo.keys().next().value);
    if (kv) await kv.set(key, entry, { ex: ttlSec }).catch(() => {});
    return { pos, left };
  }
  return { lookup, boxOf, signedIn: Boolean(clientId && clientSecret) };
}

module.exports = { createOpenSky, API, TOKEN_URL };
