// LINE notifications through the owner's own LINE Official Account (Messaging API push messages; LINE Notify ended
// in 2025-03). Env: LINE_CHANNEL_ACCESS_TOKEN (long-lived channel access token) and LINE_CHANNEL_SECRET (signs the
// webhook). Neither is ever logged or returned.
// Linking: the site shows a one-time 6-digit code, the owner adds the bot as a friend and sends the code; LINE calls
// /api/line/webhook (signed with X-Line-Signature), and the sender's userId is remembered (Redis key line:v1).
// The free plan has a monthly cap on push messages (Taiwan 輕用量: 200), so pushes are counted per month in Redis and
// stop at `cap` (default 180, leaving room for the test button and the console). Replies to the webhook are free.
const crypto = require('node:crypto');
const { monthTW } = require('./day');

const KEY = 'line:v1';
const PENDING = 'line:pending';
const CODE_TTL = 600;
const usedKey = (t) => `line:push:${monthTW(t)}`;

class LineError extends Error {
  constructor(message, status = 502, code) { super(message); this.status = status; this.code = code; }
}

// X-Line-Signature: base64 HMAC-SHA256 of the raw request body, keyed with the channel secret.
function verifySignature(secret, rawBody, signature) {
  if (!secret || !signature || typeof signature !== 'string') return false;
  const want = crypto.createHmac('sha256', secret).update(rawBody).digest();
  let got;
  try { got = Buffer.from(signature, 'base64'); } catch { return false; }
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function lineClient({ token, fetchImpl = fetch, timeoutMs = 10000 }) {
  async function call(method, path, body) {
    let res;
    try {
      res = await fetchImpl(`https://api.line.me${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new LineError(e.name === 'TimeoutError' ? 'LINE 回應逾時' : 'LINE 連線失敗', 504);
    }
    const out = await res.json().catch(() => ({}));
    if (res.ok) return out;
    console.error('line', path.split('/').slice(0, 4).join('/'), res.status, String(out.message || '').slice(0, 200));
    if (res.status === 401) throw new LineError('LINE 不接受網站設定的 LINE_CHANNEL_ACCESS_TOKEN，請到 LINE Developers 重新發行後更新到 Vercel', 502, 'token');
    if (res.status === 429) throw new LineError('LINE 官方帳號本月的訊息額度已用完', 502, 'limit');
    if (res.status === 403) throw new LineError('LINE 拒絕傳送（可能被封鎖或沒有加好友）', 502, 'blocked');
    throw new LineError(`LINE 回應錯誤（${res.status}）`, 502);
  }
  const text = (t) => [{ type: 'text', text: String(t).slice(0, 4900) }];
  return {
    push: (to, t) => call('POST', '/v2/bot/message/push', { to, messages: text(t) }),
    reply: (replyToken, t) => call('POST', '/v2/bot/message/reply', { replyToken, messages: text(t) }),
    profile: (userId) => call('GET', `/v2/bot/profile/${encodeURIComponent(userId)}`),
    botInfo: () => call('GET', '/v2/bot/info'),
  };
}

// The alert and price-drop messages are Telegram HTML (<b>, <a href>); LINE takes plain text, links written out.
function htmlToText(html) {
  return String(html ?? '')
    .replace(/<a\s+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => `${label}：${href}`)
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|#39);/g, (m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]);
}

const LINKED_TEXT = '✅ 機票搜索雷達已連結，之後的機位提醒和降價通知會傳到這裡。';
const TEST_TEXT = '✅ 機票搜索雷達測試訊息：LINE 通知運作正常，機位提醒和降價通知會傳到這裡。';
const FOLLOW_TEXT = '你好！這是機票搜索雷達的通知帳號。請把網站「LINE 通知」裡顯示的 6 位數連結碼傳到這裡，就能收到機位提醒和降價通知。';
const BAD_CODE_TEXT = '這個連結碼不對或已經過期（10 分鐘內有效）。請回網站重新產生一組連結碼再傳一次。';
// A LINE text message holds at most 5,000 characters; room is kept for the cap note.
const MAX_TEXT = 4800;
const capText = (cap) => `\n\n（本月 LINE 通知已達網站設定的上限 ${cap} 則，下個月 1 日前不會再傳 LINE；Email 和 Telegram 照常。）`;

// `client` (lineClient or the demo stand-in, or null when not set up) and `kv` (lib/kv.js).
function createLine({ client, kv, secret = '', cap = 180, now = () => Date.now(), missing = [] }) {
  let memo = null;
  let memoAt = 0;
  // `strict`: a store error is thrown instead of reading as "not linked" (notify must tell a failure from no link).
  async function linked({ strict = false } = {}) {
    if (memo && now() - memoAt < 60e3) return memo.userId ? memo : null;
    let v;
    try { v = await kv.get(KEY); } catch (e) { if (strict) throw e; v = null; }
    memo = v || {};
    memoAt = now();
    return v && v.userId ? v : null;
  }
  async function save(entry) {
    if (entry) await kv.set(KEY, entry); else await kv.del(KEY);
    memo = entry || {};
    memoAt = now();
  }
  const used = async () => Number(await kv.get(usedKey(now())).catch(() => 0)) || 0;
  // The bot's LINE ID (for the add-friend link), checked at most once an hour.
  let me = null;
  let meAt = 0;
  async function bot() {
    if (!client?.botInfo) return { tokenOk: null, botId: '', botName: '' };
    if (me && now() - meAt < (me.tokenOk ? 3600e3 : 60e3)) return me;
    try {
      const r = await client.botInfo();
      me = { tokenOk: true, botId: r?.basicId || '', botName: r?.displayName || '' };
    } catch (e) {
      me = { tokenOk: e.code === 'token' ? false : null, botId: '', botName: '' };
    }
    meAt = now();
    return me;
  }
  const need = () => { if (!client) throw new LineError('網站還沒設定 LINE 官方帳號', 503, 'not-configured'); };

  // One counted push. Taken from the month's allowance first (so two instances cannot both send the last one), given
  // back when LINE refuses. LINE's own "monthly limit reached" fills the counter, so nothing more is tried this month.
  async function push(userId, text) {
    const key = usedKey(now());
    const n = await kv.incr(key, 1, 40 * 86400);
    if (n > cap) {
      await kv.incr(key, -1).catch(() => {});
      throw new LineError(`本月 LINE 通知已達上限 ${cap} 則，下個月 1 日恢復`, 429, 'cap');
    }
    try {
      await client.push(userId, n === cap ? text + capText(cap) : text);
    } catch (e) {
      if (e.code === 'limit') await kv.set(key, cap, { ex: 40 * 86400 }).catch(() => {});
      else await kv.incr(key, -1).catch(() => {});
      throw e;
    }
    return n;
  }

  async function linkFrom(userId, replyToken) {
    let name = '';
    try { name = (await client.profile(userId))?.displayName || ''; } catch { /* the name is only for show */ }
    const entry = { userId, name, linkedAt: new Date(now()).toISOString() };
    await save(entry);
    if (replyToken) await client.reply(replyToken, LINKED_TEXT).catch((e) => console.error('line reply', e.message));
    return entry;
  }

  // Webhook events (already verified). Only a user's own chat counts; group and room messages are ignored.
  async function handleEvents(events) {
    let didLink = false;
    for (const ev of Array.isArray(events) ? events : []) {
      const userId = ev?.source?.type === 'user' ? ev.source.userId : '';
      if (!userId || typeof userId !== 'string') continue;
      if (ev.type === 'follow' && ev.replyToken) {
        await client.reply(ev.replyToken, FOLLOW_TEXT).catch(() => {});
      } else if (ev.type === 'unfollow') {
        // Blocked by the linked user: pushes would fail anyway.
        const l = await linked();
        if (l && l.userId === userId) await save(null);
      } else if (ev.type === 'message' && ev.message?.type === 'text') {
        const digits = String(ev.message.text || '').replace(/[\s-]/g, '');
        if (!/^\d{6}$/.test(digits)) continue;
        // Wrong guesses are limited per sender, so the code cannot be found by trying.
        const tryKey = `line:try:${crypto.createHash('sha1').update(userId).digest('hex').slice(0, 16)}`;
        const tries = Number(await kv.get(tryKey).catch(() => 0)) || 0;
        const pending = tries < 10 ? await kv.get(PENDING).catch(() => null) : null;
        if (pending?.code && pending.code === digits && (await kv.getdel(PENDING).catch(() => null))?.code === digits) {
          await linkFrom(userId, ev.replyToken);
          didLink = true;
        } else {
          await kv.incr(tryKey, 1, 3600).catch(() => {});
          if (ev.replyToken) await client.reply(ev.replyToken, BAD_CODE_TEXT).catch(() => {});
        }
      }
    }
    return { ok: true, linked: didLink };
  }

  return {
    configured: Boolean(client),
    cap,
    bot,
    verify: (rawBody, signature) => verifySignature(secret, rawBody, signature),
    handleEvents,
    async status() {
      if (!client) return { configured: false, linked: false, missing };
      const [l, n, b, p] = await Promise.all([linked(), used(), bot(), kv.get(PENDING).catch(() => null)]);
      return { configured: true, linked: Boolean(l), name: l?.name || '', linkedAt: l?.linkedAt || null, used: n, cap, month: monthTW(now()), capped: n >= cap, pending: Boolean(p?.code), ...b };
    },
    // A fresh 6-digit code, valid for 10 minutes; a newer code replaces the older one.
    async startLink() {
      need();
      const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
      await kv.set(PENDING, { code, at: now() }, { ex: CODE_TTL });
      const b = await bot();
      return { code, expiresAt: new Date(now() + CODE_TTL * 1000).toISOString(), ...b };
    },
    async unlink() {
      await save(null);
      await kv.del(PENDING).catch(() => {});
      return { configured: Boolean(client), linked: false, name: '', linkedAt: null };
    },
    // The 「傳送測試訊息」 button: one push (it counts toward the month), errors shown to the owner.
    async test() {
      need();
      const l = await linked();
      if (!l) throw new LineError('還沒連結 LINE', 409, 'not-linked');
      const n = await push(l.userId, TEST_TEXT);
      return { sent: true, name: l.name || '', used: n, cap };
    },
    // Best effort, like Telegram: true when sent; null when there is nowhere to send (not set up, not linked, or the
    // month's allowance used up), so nothing to try again; false when the push was tried and failed (logged, never
    // thrown). Text longer than LINE takes is cut, pointing to the site for the rest.
    async notify(html) {
      if (!client) return null;
      try {
        const l = await linked({ strict: true });
        if (!l) return null;
        let text = htmlToText(html);
        if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT - 40).replace(/\n[^\n]*$/, '') + '\n…（訊息太長，其餘請到網站查看）';
        await push(l.userId, text);
        return true;
      } catch (e) {
        console.error('line notify', e.message);
        return e.code === 'cap' || e.code === 'limit' ? null : false;
      }
    },
  };
}

// A stand-in bot for the demo: a made-up official account that "sends" into a list.
function mockLineClient() {
  const sent = [];
  return {
    sent,
    async botInfo() { return { basicId: '@demo-radar', displayName: '機票搜索雷達（示範）' }; },
    async profile() { return { displayName: '示範帳號' }; },
    async push(to, text) { sent.push({ to, text }); return {}; },
    async reply(replyToken, text) { sent.push({ replyToken, text }); return {}; },
  };
}

// The raw request body as a Buffer (the signature covers the exact bytes), up to `limit`.
function readRaw(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > limit) { over = true; chunks.length = 0; reject(new LineError('內容太長', 413)); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

module.exports = { lineClient, createLine, mockLineClient, verifySignature, htmlToText, readRaw, LineError, LINKED_TEXT, TEST_TEXT, BAD_CODE_TEXT };
