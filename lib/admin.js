// The owner's account list (帳號管理): who signed up, whether they verified, when they last signed in, how many devices
// are signed in and what each account keeps in sync, plus deleting an account or signing all its devices out.
// Server-side only, behind the owner check in server.js. Passwords are scrypt hashes (lib/accounts.js) and cannot be
// read back by anyone; nothing secret (hashes, session ids, tokens, the unlock hash) is ever put in an answer.
const { getMany } = require('./kv');

const DAY = 86400e3;
const CHUNK = 100;

class AdminError extends Error {
  constructor(message, status = 400, code) { super(message); this.status = status; this.code = code; }
}

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const count = (v) => (Array.isArray(v) ? v.length : 0);
const normEmail = (e) => String(e || '').trim().toLowerCase();

// What an account keeps in sync, as counts (never the data itself).
function syncedOf(d) {
  if (!d || !d.data) return null;
  const data = obj(d.data);
  const w = obj(data['wallet:v1']);
  return {
    at: d.syncedAt || null,
    bytes: Buffer.byteLength(JSON.stringify(data)),
    wallet: ['banks', 'miles', 'hotels'].reduce((n, b) => n + Object.keys(obj(w[b])).length, 0),
    routes: count(data.favSearches),
    recent: count(data.recentSearches),
    trips: count(obj(data['plan:v1']).legs),
  };
}

// `kv` (lib/kv.js), `accounts` (lib/accounts.js createAccounts), `passcode()` the current passcode or '' (to tell which
// accounts entered it), `alertEmails()` the emails seat alerts and price watches report to (one per watch).
function createAdmin({ kv, accounts, passcode = () => '', alertEmails = async () => [], now = () => Date.now() }) {
  const st = accounts.store;
  const FILLED = `${st.INDEX}:filled`;

  // Accounts made before the index existed: found once with SCAN and added to it.
  async function backfill({ force = false } = {}) {
    if (!force && (await kv.get(FILLED))) return { added: 0 };
    const prefix = `${st.P}user:`;
    const emails = (await kv.scan(`${prefix}*`)).map((k) => k.slice(prefix.length)).filter(Boolean);
    const added = emails.length ? await kv.sadd(st.INDEX, ...emails) : 0;
    await kv.set(FILLED, new Date(now()).toISOString());
    return { added };
  }

  async function list() {
    await backfill();
    const emails = await kv.smembers(st.INDEX);
    const pass = passcode();
    const watched = new Map();
    for (const e of await alertEmails().catch(() => [])) {
      const k = normEmail(e);
      if (k) watched.set(k, (watched.get(k) || 0) + 1);
    }
    const out = [];
    const gone = [];
    for (let i = 0; i < emails.length; i += CHUNK) {
      const part = emails.slice(i, i + CHUNK);
      const [users, lists, datas, logins] = await Promise.all([st.userKey, st.listKey, st.dataKey, st.loginKey].map((key) => getMany(kv, part.map(key))));
      for (let j = 0; j < part.length; j++) {
        const u = users[j];
        if (!u) { gone.push(part[j]); continue; }
        const sessions = (Array.isArray(lists[j]) ? lists[j] : []).filter((s) => s && s.exp > now());
        const lastSession = sessions.map((s) => s.at).filter(Boolean).sort().at(-1) || null;
        const synced = syncedOf(datas[j]);
        const alertTo = normEmail(obj(datas[j]?.data).alertEmail);
        out.push({
          email: u.email || part[j],
          createdAt: u.createdAt || null,
          verified: Boolean(u.verified),
          lastLoginAt: (typeof logins[j] === 'string' && logins[j]) || lastSession,
          sessions: sessions.length,
          unlocked: Boolean(pass && u.unlock && (await st.isUnlocked(u, pass).catch(() => false))),
          synced,
          alerts: (watched.get(normEmail(u.email || part[j])) || 0) + (alertTo && alertTo !== normEmail(u.email || part[j]) ? watched.get(alertTo) || 0 : 0),
        });
      }
    }
    // Index entries whose account is gone (deleted before the index kept up): dropped quietly.
    if (gone.length) await kv.srem(st.INDEX, ...gone).catch(() => {});
    out.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || a.email.localeCompare(b.email));
    const weekAgo = now() - 7 * DAY;
    return {
      accounts: out,
      totals: {
        accounts: out.length,
        verified: out.filter((a) => a.verified).length,
        last7: out.filter((a) => Date.parse(a.createdAt) >= weekAgo).length,
      },
    };
  }

  async function existing(email) {
    const e = normEmail(email);
    if (!e || e.length > 254) throw new AdminError('Email 格式錯誤');
    if (!(await kv.get(st.userKey(e)))) throw new AdminError('找不到這個帳號', 404, 'not-found');
    return e;
  }

  return {
    backfill,
    list,
    // Removes the user record, every session, the synced data, the last-login mark and the index entry.
    async remove(email) {
      await st.purge(await existing(email));
      return { ok: true };
    },
    // Signs every device of the account out; the account and its data stay.
    async signOut(email) {
      const e = await existing(email);
      const n = (await st.sessionsOf(e)).length;
      await st.dropSessions(e);
      return { ok: true, signedOut: n };
    },
  };
}

module.exports = { createAdmin, AdminError };
