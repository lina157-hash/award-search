// Small key-value layer: Upstash Redis over REST when it is configured, otherwise an in-memory stand-in with the same
// few commands (demo mode, tests, self-hosting without Redis). Values are JSON; counters are plain integers.
const crypto = require('node:crypto');

class KvError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

function redisKv({ url, token, fetchImpl = fetch, timeoutMs = 5000 }) {
  async function cmd(...args) {
    let res;
    try {
      res = await fetchImpl(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(args), signal: AbortSignal.timeout(timeoutMs) });
    } catch { throw new KvError('資料庫連線失敗', 504); }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) {
      console.error('redis', args[0], res.status, body.error);
      throw new KvError(`資料庫回應錯誤（${res.status}）`, 502);
    }
    return body.result;
  }
  return {
    cmd,
    async get(key) { const v = await cmd('GET', key); return v == null ? null : JSON.parse(v); },
    // { ex: seconds, nx: true } → true when written (false when NX found the key taken).
    async set(key, value, { ex, nx } = {}) { return (await cmd('SET', key, JSON.stringify(value), ...(ex ? ['EX', Math.ceil(ex)] : []), ...(nx ? ['NX'] : []))) === 'OK'; },
    async del(key) { await cmd('DEL', key); },
    // Counter with an expiry set when it is created, e.g. one per month.
    async incr(key, by = 1, ex) {
      const n = Number(await cmd('INCRBY', key, by));
      if (ex && n === by) await cmd('EXPIRE', key, Math.ceil(ex));
      return n;
    },
  };
}

function memoryKv({ now = () => Date.now() } = {}) {
  const m = new Map();
  const live = (key) => {
    const e = m.get(key);
    if (e && e.exp && e.exp <= now()) { m.delete(key); return undefined; }
    return e;
  };
  return {
    async get(key) { const e = live(key); return e ? JSON.parse(e.v) : null; },
    async set(key, value, { ex, nx } = {}) {
      if (nx && live(key)) return false;
      m.set(key, { v: JSON.stringify(value), exp: ex ? now() + ex * 1000 : 0 });
      return true;
    },
    async del(key) { m.delete(key); },
    async incr(key, by = 1, ex) {
      const e = live(key);
      const n = (e ? Number(JSON.parse(e.v)) : 0) + by;
      m.set(key, { v: String(n), exp: e ? e.exp : ex ? now() + ex * 1000 : 0 });
      return n;
    },
  };
}

// A short lock (SET NX EX). Resolves to a release function, or null when someone else holds it.
// A store error counts as "got it": a broken Redis should not stop the work, only its de-duplication.
async function takeLock(kv, key, seconds) {
  const ok = await kv.set(key, Date.now(), { ex: seconds, nx: true }).catch(() => true);
  return ok ? () => kv.del(key).catch(() => {}) : null;
}

const hashKey = (s) => crypto.createHash('sha1').update(s).digest('base64url').slice(0, 22);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Shared cache for paid lookups: one answer per query across every instance for `ttl` seconds, and a lock so two
// instances asking the same thing at once spend the quota only once (the second waits for the first one's answer).
// Errors are not cached. `key` must describe the query only (never a passcode).
async function sharedCache(kv, key, ttl, fn, { waitMs = 30000, pollMs = 700 } = {}) {
  const k = 'cache:v1:' + hashKey(key);
  const hit = await kv.get(k).catch(() => null);
  if (hit != null) return hit;
  let release = await takeLock(kv, k + ':lock', Math.ceil(waitMs / 1000));
  if (!release) {
    for (const until = Date.now() + waitMs; Date.now() < until;) {
      await sleep(pollMs);
      const v = await kv.get(k).catch(() => null);
      if (v != null) return v;
      // The other instance gave up (an error); ask ourselves.
      if ((await kv.get(k + ':lock').catch(() => null)) == null) break;
    }
    release = () => {};
  }
  try {
    const v = await fn();
    if (v != null) await kv.set(k, v, { ex: ttl }).catch(() => {});
    return v;
  } finally {
    await release();
  }
}

module.exports = { redisKv, memoryKv, takeLock, sharedCache, hashKey, KvError };
