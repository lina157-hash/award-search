// Shared search cache in Upstash Redis, behind the per-instance cache in server.js: a seats.aero or rooms.aero answer
// fetched by one Vercel instance is reused by every other instance (and visitor) for `ttl` seconds, saving quota.
// Values over `compressOver` bytes are gzipped; anything still over `maxBytes` is not stored (Upstash's request size
// limit). Errors are never cached, and Redis trouble only means a miss. Without Redis it does nothing.
// Hit / miss / skipped counts per UTC day (seats.aero's quota day) are kept for /api/config.
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const { hashKey } = require('./kv');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const PREFIX = 'scache:v1:';
const statKey = (t, kind) => `scache:stats:${new Date(t).toISOString().slice(0, 10)}:${kind}`;

async function encode(value, { compressOver, maxBytes }) {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) <= compressOver) return Buffer.byteLength(json) <= maxBytes ? { j: value } : null;
  const z = (await gzip(json, { level: 6 })).toString('base64');
  return z.length <= maxBytes ? { z } : null;
}
async function decode(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if ('j' in entry) return entry.j;
  if (typeof entry.z === 'string') return JSON.parse((await gunzip(Buffer.from(entry.z, 'base64'))).toString());
  return null;
}

function createSearchCache({ kv, enabled = false, ttl = 1800, maxBytes = 900_000, compressOver = 8_000, now = () => Date.now(), defer = (p) => p }) {
  const local = { hit: 0, miss: 0, skip: 0 };
  const count = (kind) => {
    local[kind]++;
    defer(kv.incr(statKey(now(), kind), 1, 3 * 86400).catch(() => {}));
  };
  // `key` is the server's normalized query key (never anything personal); `fn` asks upstream.
  async function wrap(key, fn) {
    if (!enabled) return fn();
    const k = PREFIX + hashKey(key);
    let hit = null;
    try { hit = await decode(await kv.get(k)); } catch { hit = null; }
    if (hit != null) { count('hit'); return hit; }
    const value = await fn();
    if (value == null) return value;
    const entry = await encode(value, { compressOver, maxBytes }).catch(() => null);
    if (!entry) { count('skip'); return value; }
    count('miss');
    // Stored in the background: the visitor does not wait for Redis.
    defer(kv.set(k, entry, { ex: ttl }).catch(() => {}));
    return value;
  }
  // Today's counts across all instances (counts only, no keys).
  async function stats() {
    if (!enabled) return { enabled: false };
    const t = now();
    const [hit, miss, skip] = await Promise.all(['hit', 'miss', 'skip'].map((x) => kv.get(statKey(t, x)).then((v) => Number(v) || 0).catch(() => null)));
    const shared = hit == null ? null : { hits: hit, misses: miss, skipped: skip, hitRate: hit + miss ? Math.round((hit / (hit + miss)) * 100) : null };
    return { enabled: true, ttl, today: shared, instance: { hits: local.hit, misses: local.miss, skipped: local.skip } };
  }
  return { wrap, stats, enabled };
}

module.exports = { createSearchCache, encode, decode };
