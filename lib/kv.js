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
    // Several keys in one command (Upstash counts commands, not keys); a value that is not JSON reads as null.
    async mget(keys) {
      if (!keys.length) return [];
      const vs = await cmd('MGET', ...keys);
      return keys.map((_, i) => { try { return vs?.[i] == null ? null : JSON.parse(vs[i]); } catch { return null; } });
    },
    // { ex: seconds, nx: true } → true when written (false when NX found the key taken).
    async set(key, value, { ex, nx } = {}) { return (await cmd('SET', key, JSON.stringify(value), ...(ex ? ['EX', Math.ceil(ex)] : []), ...(nx ? ['NX'] : []))) === 'OK'; },
    async del(key) { await cmd('DEL', key); },
    // Read and delete in one step (single-use tokens).
    async getdel(key) { const v = await cmd('GETDEL', key); return v == null ? null : JSON.parse(v); },
    // Counter with an expiry set when it is created, e.g. one per month.
    async incr(key, by = 1, ex) {
      const n = Number(await cmd('INCRBY', key, by));
      if (ex && n === by) await cmd('EXPIRE', key, Math.ceil(ex));
      return n;
    },
    // Sets of plain strings (an index of emails, say).
    async sadd(key, ...members) { return members.length ? Number(await cmd('SADD', key, ...members.map(String))) : 0; },
    async srem(key, ...members) { return members.length ? Number(await cmd('SREM', key, ...members.map(String))) : 0; },
    async smembers(key) { return (await cmd('SMEMBERS', key)) || []; },
    // Every key matching a glob pattern, walked with SCAN (never KEYS, which blocks the server). For rare upkeep
    // only: each step is one command. Stops after `maxSteps` steps, so a huge store cannot hold the function forever.
    async scan(match, { count = 500, maxSteps = 200 } = {}) {
      const out = new Set();
      let cursor = '0';
      for (let i = 0; i < maxSteps; i++) {
        const [next, keys] = (await cmd('SCAN', cursor, 'MATCH', match, 'COUNT', count)) || ['0', []];
        for (const k of keys || []) out.add(k);
        cursor = String(next);
        if (cursor === '0') break;
      }
      return [...out];
    },
  };
}

// Redis glob (* ? and [...]) as a RegExp, for the in-memory SCAN.
const globRe = (glob) => new RegExp(`^${String(glob).replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 's');

function memoryKv({ now = () => Date.now() } = {}) {
  const m = new Map();
  const sets = new Map();
  const live = (key) => {
    const e = m.get(key);
    if (e && e.exp && e.exp <= now()) { m.delete(key); return undefined; }
    return e;
  };
  return {
    async get(key) { const e = live(key); return e ? JSON.parse(e.v) : null; },
    async mget(keys) { return keys.map((k) => { const e = live(k); return e ? JSON.parse(e.v) : null; }); },
    async set(key, value, { ex, nx } = {}) {
      if (nx && live(key)) return false;
      m.set(key, { v: JSON.stringify(value), exp: ex ? now() + ex * 1000 : 0 });
      return true;
    },
    async del(key) { m.delete(key); sets.delete(key); },
    async getdel(key) { const e = live(key); m.delete(key); return e ? JSON.parse(e.v) : null; },
    async incr(key, by = 1, ex) {
      const e = live(key);
      const n = (e ? Number(JSON.parse(e.v)) : 0) + by;
      m.set(key, { v: String(n), exp: e ? e.exp : ex ? now() + ex * 1000 : 0 });
      return n;
    },
    async sadd(key, ...members) {
      const s = sets.get(key) || new Set();
      const before = s.size;
      for (const x of members) s.add(String(x));
      if (s.size) sets.set(key, s);
      return s.size - before;
    },
    async srem(key, ...members) {
      const s = sets.get(key);
      if (!s) return 0;
      let n = 0;
      for (const x of members) n += s.delete(String(x)) ? 1 : 0;
      if (!s.size) sets.delete(key);
      return n;
    },
    async smembers(key) { return [...(sets.get(key) || [])]; },
    async scan(match) {
      const re = globRe(match);
      return [...m.keys(), ...sets.keys()].filter((k) => re.test(k) && (sets.has(k) || live(k)));
    },
  };
}

// A short lock (SET NX EX). Resolves to a release function, or null when someone else holds it.
// A store error counts as "got it": a broken Redis should not stop the work, only its de-duplication.
async function takeLock(kv, key, seconds) {
  const ok = await kv.set(key, Date.now(), { ex: seconds, nx: true }).catch(() => true);
  return ok ? () => kv.del(key).catch(() => {}) : null;
}

// The same lock, waited for: tries again every `pollMs` until `waitMs` has passed (then null). For quick
// read-modify-write steps that two requests may want at the same moment.
async function waitLock(kv, key, seconds, { waitMs = 5000, pollMs = 100 } = {}) {
  for (const until = Date.now() + waitMs; ;) {
    const release = await takeLock(kv, key, seconds);
    if (release || Date.now() >= until) return release;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// Many keys at once: one MGET where the store has it, otherwise one GET each.
const getMany = (kv, keys) => (kv.mget ? kv.mget(keys) : Promise.all(keys.map((k) => kv.get(k))));

const hashKey = (s) => crypto.createHash('sha1').update(s).digest('base64url').slice(0, 22);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Shared cache for paid lookups: one answer per query across every instance for `ttl` seconds, and a lock so two
// instances asking the same thing at once spend the quota only once (the second waits for the first one's answer).
// Errors are not cached. `key` must describe the query only (never a passcode). `lockSec`: how long the lock may
// live; it should outlast the slowest lookup, or a second instance starts the same lookup while the first still runs.
async function sharedCache(kv, key, ttl, fn, { waitMs = 30000, pollMs = 700, lockSec = Math.ceil(waitMs / 1000) } = {}) {
  const k = 'cache:v1:' + hashKey(key);
  const hit = await kv.get(k).catch(() => null);
  if (hit != null) return hit;
  let release = await takeLock(kv, k + ':lock', lockSec);
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

module.exports = { redisKv, memoryKv, takeLock, waitLock, sharedCache, getMany, hashKey, KvError };
