// Optional accounts (email + password) that carry a person's own settings between devices. Nothing on the site needs
// one. Stored in the same Redis (lib/kv.js); passwords hashed with scrypt and a per-user salt; sessions are random
// 32-byte ids kept only as hashes; verify and reset links are single-use tokens, also kept as hashes.
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { takeLock } = require('./kv');

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const P = 'acct:v1:';
const DAY = 86400;
const SESSION_LONG = 30 * DAY;
const SESSION_SHORT = DAY;
const VERIFY_TTL = DAY;
const RESET_TTL = 30 * 60;
const MAX_DATA_BYTES = 200_000;
// Verify and reset mails per UTC day for the whole site, so strangers cannot use up the mail quota the alerts need.
const MAIL_CAP = 30;
const MAX_DATA_KEYS = 40;
// Never synced: the passcode stays on the device it was typed on.
const DATA_DENY = new Set(['cashPass']);
const DATA_KEY = /^[A-Za-z][\w:.-]{0,39}$/;

class AccountError extends Error {
  constructor(message, status = 400, code) { super(message); this.status = status; this.code = code; }
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('base64url');
const token = () => crypto.randomBytes(32).toString('base64url');
const normEmail = (e) => String(e || '').trim().toLowerCase();
const validEmail = (e) => e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

async function hashPassword(pw, salt = crypto.randomBytes(16)) {
  const key = await scrypt(String(pw).normalize('NFKC'), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}
async function verifyPassword(pw, stored) {
  const [kind, N, r, p, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !hash) return false;
  const want = Buffer.from(hash, 'base64url');
  const got = await scrypt(String(pw).normalize('NFKC'), Buffer.from(salt, 'base64url'), want.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
// Compared against when the email is unknown, so a wrong email takes as long as a wrong password.
let dummyHash;
const dummy = async () => (dummyHash ||= await hashPassword('not-a-real-password'));

function checkPassword(pw) {
  const s = String(pw ?? '');
  if (s.length < 8) throw new AccountError('密碼至少要 8 個字元', 400, 'weak');
  if (s.length > 200) throw new AccountError('密碼太長', 400, 'weak');
  return s;
}

// `kv` (lib/kv.js), `sendMail({ to, subject, html })` or null, `log` for the demo (links printed instead of mailed).
// `defer(promise)` (optional): sends mail after the answer, so the answer takes as long whether or not a mail goes out.
function createAccounts({ kv, sendMail = null, log = null, now = () => Date.now(), defer = null, mailCap = MAIL_CAP }) {
  const mailOn = Boolean(sendMail || log);
  const userKey = (email) => `${P}user:${email}`;
  const sessKey = (h) => `${P}sess:${h}`;
  const listKey = (email) => `${P}sessions:${email}`;
  const dataKey = (email) => `${P}data:${email}`;
  // When the account last signed in (its own key, so a login never rewrites the user record).
  const loginKey = (email) => `${P}login:${email}`;
  // Every account's email, for the owner's account list (lib/admin.js); kept on signup and delete.
  const INDEX = `${P}index`;
  const indexAdd = (e) => (kv.sadd ? kv.sadd(INDEX, e).catch((err) => console.error('account index', err.message)) : null);

  // Attempts per window, per IP and per email; past `max` the request is refused for the rest of the window.
  async function limit(kind, id, max, windowSec = 900) {
    if (!id) return;
    const n = await kv.incr(`rl:v1:${kind}:${sha(id).slice(0, 16)}:${Math.floor(now() / 1000 / windowSec)}`, 1, windowSec).catch(() => 0);
    if (n > max) throw new AccountError('嘗試太多次，請 15 分鐘後再試', 429, 'rate');
  }
  // Failures only (wrong passwords): checked before, counted after, so the owner's own successful logins never add up.
  const failKey = (kind, id, windowSec = 900) => `rl:v1:${kind}:${sha(id).slice(0, 16)}:${Math.floor(now() / 1000 / windowSec)}`;
  async function failLimit(kind, id, max) {
    if (id && Number(await kv.get(failKey(kind, id)).catch(() => 0)) >= max) throw new AccountError('嘗試太多次，請 15 分鐘後再試', 429, 'rate');
  }
  const failed = (kind, id) => (id ? kv.incr(failKey(kind, id), 1, 900).catch(() => 0) : 0);

  const mailDayKey = () => `${P}mails:${new Date(now()).toISOString().slice(0, 10)}`;
  // Checked before anything depends on whether the email has an account, so the refusal says nothing about it.
  async function mailRoom() {
    if (!mailOn) return;
    if (Number(await kv.get(mailDayKey()).catch(() => 0)) >= mailCap) throw new AccountError('今天網站寄出的信已經太多了，請明天再試', 429, 'mail-cap');
  }
  async function mail(to, subject, html, link) {
    if ((await kv.incr(mailDayKey(), 1, 2 * DAY).catch(() => 0)) > mailCap) { console.error('account mail: daily cap reached'); return; }
    if (sendMail) {
      const job = sendMail({ to, subject, html });
      if (!defer) return job;
      defer(job);
      return;
    }
    if (log) log(`[示範] 寄給 ${to}：${subject} ${link}`);
  }
  const wrap = (body) => `<div style="font-family:system-ui,sans-serif;line-height:1.6">${body}<p style="color:#777;font-size:13px">機票搜索雷達</p></div>`;

  // The link carries the nonce of the signup that sent it: a later signup (a new password) makes older links useless.
  async function sendVerify(email, base, nonce) {
    const t = token();
    await kv.set(`${P}verify:${sha(t)}`, { email, nonce }, { ex: VERIFY_TTL });
    const link = `${base}/#verify=${t}`;
    await mail(email, '機票搜索雷達：請驗證你的 Email', wrap(`<p>點下面的連結完成註冊（24 小時內有效）：</p><p><a href="${link}">驗證 Email</a></p><p>如果不是你註冊的，請忽略這封信。</p>`), link);
  }

  async function sessionsOf(email) {
    const list = (await kv.get(listKey(email)).catch(() => null)) || [];
    return list.filter((s) => s.exp > now());
  }
  async function dropSessions(email, keepHash = null) {
    const list = await sessionsOf(email);
    for (const s of list) if (s.h !== keepHash) await kv.del(sessKey(s.h)).catch(() => {});
    const keep = list.filter((s) => s.h === keepHash);
    if (keep.length) await kv.set(listKey(email), keep, { ex: SESSION_LONG }); else await kv.del(listKey(email));
  }

  // Unlock: the passcode, hashed with this account's own salt, so a changed passcode no longer counts.
  const unlockMemo = new Map();
  async function isUnlocked(user, passcode) {
    if (!user?.unlock || !passcode) return false;
    const k = `${user.email}|${user.unlock}|${sha(passcode)}`;
    const hit = unlockMemo.get(k);
    if (hit && hit.until > now()) return hit.ok;
    const ok = await verifyPassword(passcode, user.unlock);
    unlockMemo.set(k, { ok, until: now() + 600e3 });
    if (unlockMemo.size > 500) unlockMemo.delete(unlockMemo.keys().next().value);
    return ok;
  }

  // Everything an account has: its sessions, synced data, last login, the user record and its place in the index.
  async function purge(email) {
    await dropSessions(email);
    await kv.del(dataKey(email));
    await kv.del(loginKey(email)).catch(() => {});
    await kv.del(userKey(email));
    if (kv.srem) await kv.srem(INDEX, email).catch(() => {});
  }

  return {
    mailOn,
    // For the owner's account list (lib/admin.js) only; nothing here is ever sent to a browser as it is.
    store: { P, INDEX, userKey, listKey, dataKey, loginKey, sessionsOf, dropSessions, purge, isUnlocked },
    hashPassword,
    verifyPassword,
    // Always the same answer, whether or not the email already has an account.
    async signup({ email, password }, { ip, base }) {
      const e = normEmail(email);
      if (!validEmail(e)) throw new AccountError('Email 格式錯誤');
      const pw = checkPassword(password);
      await limit('signup-ip', ip, 10);
      await limit('signup-email', e, 5);
      await mailRoom();
      // Hashed on every path, so an existing email answers no faster than a new one.
      const hash = await hashPassword(pw);
      const nonce = token().slice(0, 16);
      const existing = await kv.get(userKey(e));
      if (existing) {
        // Not verified yet: the newest signup's password is the one a verify link activates (older links stop
        // working), so someone who signed up with another person's email cannot keep their own password on it.
        if (!existing.verified && mailOn) {
          Object.assign(existing, { hash, verifyNonce: nonce });
          await kv.set(userKey(e), existing);
          await sendVerify(e, base, nonce);
        }
        return { ok: true, verifyNeeded: mailOn };
      }
      // Without a way to send mail, there is nothing to verify with: the account starts verified.
      const user = { email: e, hash, verified: !mailOn, createdAt: new Date(now()).toISOString(), ...(mailOn ? { verifyNonce: nonce } : {}) };
      if (!(await kv.set(userKey(e), user, { nx: true }))) return { ok: true, verifyNeeded: mailOn };
      await indexAdd(e);
      if (mailOn) await sendVerify(e, base, nonce);
      return { ok: true, verifyNeeded: mailOn };
    },
    async verify({ token: t }, { ip }) {
      await limit('verify-ip', ip, 20);
      const hit = t ? await kv.getdel(`${P}verify:${sha(t)}`) : null;
      const user = hit && (await kv.get(userKey(hit.email)));
      if (!user || (!user.verified && (user.verifyNonce || null) !== (hit.nonce || null))) throw new AccountError('驗證連結無效或已過期，請重新註冊一次來重寄', 400, 'token');
      if (!user.verified) {
        const { verifyNonce, ...rest } = user;
        await kv.set(userKey(user.email), { ...rest, verified: true, passwordAt: new Date(now()).toISOString() });
      }
      return { ok: true, email: user.email };
    },
    async login({ email, password, remember }, { ip, ua }) {
      const e = normEmail(email);
      await limit('login-ip', ip, 10);
      // Per email, only wrong passwords count, from every address together; generous, as the per-IP limit does the
      // real work and a stranger should not be able to lock the owner out easily.
      await failLimit('login-email', e, 20);
      const user = validEmail(e) ? await kv.get(userKey(e)) : null;
      const ok = await verifyPassword(String(password ?? ''), user?.hash || (await dummy()));
      if (!user || !ok) {
        await failed('login-email', e);
        throw new AccountError('Email 或密碼不正確', 401, 'login');
      }
      if (!user.verified) throw new AccountError('請先到信箱點驗證連結（沒收到可以再註冊一次，會重寄）', 403, 'unverified');
      const sid = token();
      const h = sha(sid);
      const ttl = remember ? SESSION_LONG : SESSION_SHORT;
      await kv.set(sessKey(h), { email: e, at: new Date(now()).toISOString() }, { ex: ttl });
      const list = [...(await sessionsOf(e)), { h, exp: now() + ttl * 1000, ua: String(ua || '').slice(0, 80), at: new Date(now()).toISOString() }].slice(-20);
      await kv.set(listKey(e), list, { ex: SESSION_LONG });
      await kv.set(loginKey(e), new Date(now()).toISOString()).catch(() => {});
      return { sid, maxAge: remember ? SESSION_LONG : null, email: e };
    },
    // The session behind a cookie value: { h, email, user } or null.
    async session(sid) {
      if (!sid || sid.length > 100) return null;
      const h = sha(sid);
      const s = await kv.get(sessKey(h)).catch(() => null);
      if (!s) return null;
      const user = await kv.get(userKey(s.email)).catch(() => null);
      if (!user) return null;
      // Signed in before the password last changed (reset, change, a re-verified signup): no longer valid, whether
      // or not the session is still on the account's list.
      if (user.passwordAt && !(Date.parse(s.at) >= Date.parse(user.passwordAt))) {
        await kv.del(sessKey(h)).catch(() => {});
        return null;
      }
      return { h, email: s.email, user };
    },
    async logout(sess) {
      if (!sess) return;
      await kv.del(sessKey(sess.h));
      const list = (await sessionsOf(sess.email)).filter((s) => s.h !== sess.h);
      if (list.length) await kv.set(listKey(sess.email), list, { ex: SESSION_LONG }); else await kv.del(listKey(sess.email));
    },
    async status(sess, passcode) {
      if (!sess) return { loggedIn: false };
      const d = await kv.get(dataKey(sess.email)).catch(() => null);
      return {
        loggedIn: true, email: sess.email, name: sess.email.split('@')[0], verified: Boolean(sess.user.verified),
        unlocked: await isUnlocked(sess.user, passcode), devices: (await sessionsOf(sess.email)).length, syncedAt: d?.syncedAt || null,
      };
    },
    // Always the same answer; a link goes out only when the account exists.
    async forgot({ email }, { ip, base }) {
      const e = normEmail(email);
      await limit('forgot-ip', ip, 10);
      await limit('forgot-email', e, 5);
      await mailRoom();
      const user = validEmail(e) ? await kv.get(userKey(e)) : null;
      if (user && mailOn) {
        const t = token();
        await kv.set(`${P}reset:${sha(t)}`, { email: e }, { ex: RESET_TTL });
        const link = `${base}/#reset=${t}`;
        await mail(e, '機票搜索雷達：重設密碼', wrap(`<p>點下面的連結設定新密碼（30 分鐘內有效，只能用一次）：</p><p><a href="${link}">重設密碼</a></p><p>如果不是你申請的，請忽略這封信，密碼不會改變。</p>`), link);
      }
      return { ok: true };
    },
    // A new password from a reset link; every session is signed out.
    async reset({ token: t, password }, { ip }) {
      const pw = checkPassword(password);
      await limit('reset-ip', ip, 20);
      const hit = t ? await kv.getdel(`${P}reset:${sha(t)}`) : null;
      const user = hit && (await kv.get(userKey(hit.email)));
      if (!user) throw new AccountError('重設連結無效、已用過或已過期，請重新申請', 400, 'token');
      Object.assign(user, { hash: await hashPassword(pw), verified: true, passwordAt: new Date(now()).toISOString() });
      await kv.set(userKey(user.email), user);
      await dropSessions(user.email);
      return { ok: true };
    },
    // Change the password; other devices are signed out, this one stays.
    async changePassword(sess, { old, new: next }, { ip }) {
      await limit('password-ip', ip, 10);
      const pw = checkPassword(next);
      if (!(await verifyPassword(String(old ?? ''), sess.user.hash))) throw new AccountError('目前的密碼不正確', 401, 'login');
      const at = new Date(now()).toISOString();
      Object.assign(sess.user, { hash: await hashPassword(pw), passwordAt: at });
      // This device stays signed in: its session counts as started with the new password.
      const mine = (await sessionsOf(sess.email)).find((x) => x.h === sess.h);
      const left = mine ? Math.ceil((mine.exp - now()) / 1000) : SESSION_SHORT;
      await kv.set(sessKey(sess.h), { email: sess.email, at }, { ex: Math.max(60, left) });
      await kv.set(userKey(sess.email), sess.user);
      await dropSessions(sess.email, sess.h);
      return { ok: true };
    },
    async remove(sess, { password }, { ip }) {
      await limit('delete-ip', ip, 10);
      if (!(await verifyPassword(String(password ?? ''), sess.user.hash))) throw new AccountError('密碼不正確', 401, 'login');
      await purge(sess.email);
      return { ok: true };
    },
    async getData(sess) {
      const d = await kv.get(dataKey(sess.email));
      return { data: d?.data || {}, rev: d?.rev || 0, syncedAt: d?.syncedAt || null };
    },
    // Saves only on top of the revision the client last saw; otherwise 409 with the current copy to merge.
    async putData(sess, { data, rev }) {
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new AccountError('資料格式錯誤');
      const keys = Object.keys(data);
      if (keys.length > MAX_DATA_KEYS) throw new AccountError('資料項目太多');
      const bad = keys.filter((k) => !DATA_KEY.test(k) || DATA_DENY.has(k));
      if (bad.length) throw new AccountError(`不能同步的項目：${bad.slice(0, 3).join('、')}`);
      const size = Buffer.byteLength(JSON.stringify(data));
      if (size > MAX_DATA_BYTES) throw new AccountError('資料太大，無法同步', 413);
      const release = await takeLock(kv, `${P}datalock:${sess.email}`, 10);
      if (!release) throw Object.assign(new AccountError('另一台裝置正在同步，請稍後再試', 409, 'busy'));
      try {
        const cur = await kv.get(dataKey(sess.email));
        const curRev = cur?.rev || 0;
        if (Number(rev) !== curRev) throw Object.assign(new AccountError('其他裝置已經更新過，請合併後再存', 409, 'conflict'), { current: { data: cur?.data || {}, rev: curRev, syncedAt: cur?.syncedAt || null } });
        const next = { data, rev: curRev + 1, syncedAt: new Date(now()).toISOString() };
        await kv.set(dataKey(sess.email), next);
        return { rev: next.rev, syncedAt: next.syncedAt };
      } finally {
        await release();
      }
    },
    isUnlocked,
    // The right passcode was entered on this account's session: remember that (as a salted hash, never the passcode).
    async markUnlocked(sess, passcode) {
      if (await isUnlocked(sess.user, passcode)) return;
      sess.user.unlock = await hashPassword(passcode);
      await kv.set(userKey(sess.email), sess.user);
    },
  };
}

module.exports = { createAccounts, AccountError, hashPassword, verifyPassword };
