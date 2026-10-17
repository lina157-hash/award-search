// 飛機現在在哪's first source: OpenSky Network's live positions (REST API, openskynetwork.github.io/opensky-api/rest.html,
// read 2026-10-17). The owner chose it knowing its terms (opensky-network.org/about/terms-of-use: the free licence is for
// non-profit research and education, and automated use needs their written agreement), so it is kept to the owner's
// own clicks: only inside 查航班動態 (the passcode), one lookup per click, kept a minute.
// - GET /api/states/all?icao24=<hex>: the plane by its transponder address (AeroDataBox's aircraft.modeS); without one,
//   every plane in the air (no box: a long flight bends far past its airports' latitudes, and a box that big costs the
//   same 4 credits), matched on the call sign ("EVA198", "CAL061" and "CAL61" alike).
//   Credits: 1–4 by box size (4 for a box over 400 sq° or the whole world); 400 a day without an account, 4,000 with one.
// - A state vector is an array: 0 icao24, 1 callsign, 3 time_position (s), 5 longitude, 6 latitude, 7 baro_altitude (m),
//   8 on_ground, 9 velocity (m/s), 10 true_track (°), 13 geo_altitude (m).
// - With OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET (an API client made on the OpenSky account page): OAuth2 client
//   credentials, a token good for 30 minutes sent as a Bearer header; without them, anonymous.
// - X-Rate-Limit-Remaining: credits left; 429 with X-Rate-Limit-Retry-After-Seconds when they are gone.
const { position } = require('./flightstatus');

const API = 'https://opensky-network.org/api';
// A call sign as one key: "CAL061 " and "CAL61" → "CAL61" (letters, the number without leading zeros, any letter after).
function callKey(v) {
  const m = /^([A-Z]{3})0*(\d{1,4})([A-Z]{0,2})$/.exec(String(v || '').replace(/\s+/g, '').toUpperCase());
  return m ? `${m[1]}${m[2]}${m[3]}` : '';
}
const TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';

function createOpenSky({ clientId = '', clientSecret = '', fetchImpl = fetch, kv = null, now = () => Date.now(), ttlSec = 60 } = {}) {
  let token = null;
  let authFailed = false;
  let blockedUntil = 0;
  let left = null;
  const memo = new Map();
  async function auth(force = false) {
    if (!clientId || !clientSecret) return null;
    if (!force && token && now() < token.until) return token.v;
    const res = await fetchImpl(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }).toString(), signal: AbortSignal.timeout(10000) });
    const body = res.ok ? await res.json().catch(() => null) : null;
    authFailed = !body?.access_token;
    if (authFailed) { token = null; return null; } // asked anonymously instead
    token = { v: body.access_token, until: now() + Math.max(60, (Number(body.expires_in) || 1800) - 60) * 1000 };
    return token.v;
  }
  async function get(path, retry = true) {
    const t = await auth().catch(() => { authFailed = true; return null; });
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
  // { pos, left, by, why }: by 'hex' or 'callsign' (how the plane was looked for); why '' (found), 'unheard' (OpenSky has
  // not heard it lately, or it is on the ground), 'nokey' (nothing to look it up by), 'quota' or 'down'.
  async function lookup({ icao24 = '', callsign = '' } = {}) {
    const hex = /^[0-9a-f]{6}$/i.test(icao24) ? icao24.toLowerCase() : '';
    const cs = callKey(callsign);
    const by = hex ? 'hex' : cs ? 'callsign' : '';
    const out = (x) => ({ left, by, authFailed, ...x });
    if (!by) return out({ pos: null, why: 'nokey' });
    const key = `osky:v2:${hex || cs}`;
    const hit = memo.get(key) || (kv ? await kv.get(key).catch(() => null) : null);
    if (hit && now() - hit.at < ttlSec * 1000) return out({ pos: hit.pos, why: hit.pos ? '' : 'unheard', cached: true });
    if (now() < blockedUntil) return out({ pos: null, why: 'quota' });
    let r;
    try {
      r = await get(hex ? `/states/all?icao24=${hex}` : '/states/all');
    } catch {
      return out({ pos: null, why: 'down' });
    }
    if (r.why) return out({ pos: null, why: r.why });
    const states = (Array.isArray(r.body?.states) ? r.body.states : []).filter((s) => Array.isArray(s) && !s[8] && s[5] != null && s[6] != null);
    const s = hex ? states.find((x) => String(x[0]).toLowerCase() === hex) : states.find((x) => callKey(x[1]) === cs);
    const pos = s ? position({ lat: s[6], lon: s[5], altitude: { meter: s[7] ?? s[13] }, groundSpeed: { meterPerSecond: s[9] }, trueTrack: { deg: s[10] }, reportedAtUtc: s[3] ? new Date(s[3] * 1000).toISOString() : '' }, 'opensky') : null;
    const entry = { at: now(), pos };
    memo.set(key, entry);
    if (memo.size > 200) memo.delete(memo.keys().next().value);
    if (kv) await kv.set(key, entry, { ex: ttlSec }).catch(() => {});
    return out({ pos, why: pos ? '' : 'unheard' });
  }
  return { lookup, signedIn: Boolean(clientId && clientSecret) };
}

module.exports = { createOpenSky, callKey, API, TOKEN_URL };
