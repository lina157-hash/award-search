// Telegram notifications through the owner's own bot (Bot API: https://core.telegram.org/bots/api), next to the email.
// The token (env TELEGRAM_BOT_TOKEN, from @BotFather) goes into the request URL only; it is never logged or returned.
// Linking needs no chat id from the owner: they send /start to the bot, press the link button, and the newest private
// chat that wrote to the bot is the one remembered (in Redis, key telegram:v1).
const KEY = 'telegram:v1';

class TelegramError extends Error {
  constructor(message, status = 502, code) { super(message); this.status = status; this.code = code; }
}

function telegramClient({ token, fetchImpl = fetch, timeoutMs = 10000 }) {
  async function call(method, params = {}) {
    let res;
    try {
      res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new TelegramError(e.name === 'TimeoutError' ? 'Telegram 回應逾時' : 'Telegram 連線失敗', 504);
    }
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.ok) return body.result;
    console.error('telegram', method, res.status, String(body.description || '').slice(0, 200));
    if (res.status === 401 || res.status === 404) throw new TelegramError('Telegram 機器人金鑰無效，請到 @BotFather 確認 TELEGRAM_BOT_TOKEN', 502, 'token');
    if (res.status === 409) throw new TelegramError('這個機器人設定了 webhook，無法用這個方式連結；請先移除 webhook', 502, 'webhook');
    if (res.status === 403) throw new TelegramError('機器人被封鎖了，請在 Telegram 解除封鎖後再連結', 502, 'blocked');
    throw new TelegramError(`Telegram 回應錯誤（${res.status}）`, 502);
  }
  return {
    // Plain text, or HTML (<b>, <a href>) with `html: true`; link previews off to keep it compact.
    sendMessage: (chatId, text, { html = false } = {}) => call('sendMessage', { chat_id: chatId, text, ...(html ? { parse_mode: 'HTML' } : {}), link_preview_options: { is_disabled: true } }),
    getUpdates: (params = {}) => call('getUpdates', { limit: 100, allowed_updates: ['message'], ...params }),
    getMe: () => call('getMe'),
  };
}

// For Telegram's HTML mode: only &, < and > need escaping (plus quotes inside attributes).
const escHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const nameOf = (chat) => [chat.first_name, chat.last_name].filter(Boolean).join(' ') || (chat.username ? `@${chat.username}` : String(chat.id));

// The newest private chat that sent /start; failing that, the newest private chat that sent anything.
function pickChat(updates) {
  const msgs = (updates || []).map((u) => ({ id: u.update_id, m: u.message })).filter((x) => x.m?.chat?.type === 'private').sort((a, b) => b.id - a.id);
  const hit = msgs.find((x) => /^\/start\b/.test(x.m.text || '')) || msgs[0];
  return hit ? { chat: hit.m.chat, updateId: hit.id, lastId: Math.max(...updates.map((u) => u.update_id)) } : null;
}

// `client` (telegramClient, or null when no token) and `kv` (lib/kv.js) for the linked chat.
const LINKED_TEXT = '機票搜索雷達已連結，之後的機位提醒和降價通知會傳到這裡。';
const TEST_TEXT = '✅ 機票搜索雷達測試訊息：Telegram 通知運作正常，機位提醒和降價通知會傳到這裡。';
function createTelegram({ client, kv, now = () => Date.now() }) {
  let memo = null;
  let memoAt = 0;
  // `strict`: a store error is thrown instead of reading as "not linked" (notify must tell a failure from no chat).
  async function linked({ strict = false } = {}) {
    if (memo && now() - memoAt < 60e3) return memo.chatId ? memo : null;
    let v;
    try { v = await kv.get(KEY); } catch (e) { if (strict) throw e; v = null; }
    memo = v || {};
    memoAt = now();
    return v && v.chatId ? v : null;
  }
  // Which bot the token belongs to (so the page can link straight to it), checked at most once an hour.
  // `tokenOk` false means Telegram refused the token; null means Telegram could not be reached.
  let me = null;
  let meAt = 0;
  async function bot() {
    if (!client?.getMe) return { tokenOk: null, bot: '' };
    if (me && now() - meAt < (me.tokenOk ? 3600e3 : 60e3)) return me;
    try {
      const r = await client.getMe();
      me = { tokenOk: true, bot: r?.username || '' };
    } catch (e) {
      me = { tokenOk: e.code === 'token' ? false : null, bot: '' };
    }
    meAt = now();
    return me;
  }
  return {
    configured: Boolean(client),
    bot,
    async status() {
      const l = client ? await linked() : null;
      return { configured: Boolean(client), linked: Boolean(l), name: l?.name || '', linkedAt: l?.linkedAt || null, ...(client ? await bot() : {}) };
    },
    async link() {
      if (!client) throw new TelegramError('網站還沒設定 TELEGRAM_BOT_TOKEN', 503, 'not-configured');
      const hit = pickChat(await client.getUpdates());
      if (!hit) throw new TelegramError('還沒收到你的訊息：請先在 Telegram 打開你的機器人、按「開始」（傳送 /start），再按一次連結', 404, 'no-start');
      // The welcome message doubles as the test: a chat we cannot write to is not linked.
      await client.sendMessage(hit.chat.id, LINKED_TEXT);
      const entry = { chatId: hit.chat.id, name: nameOf(hit.chat), linkedAt: new Date(now()).toISOString() };
      await kv.set(KEY, entry);
      memo = entry;
      memoAt = now();
      // Mark the messages read, so a later link only looks at new ones.
      await client.getUpdates({ offset: hit.lastId + 1, limit: 1 }).catch(() => {});
      return { configured: true, linked: true, name: entry.name, linkedAt: entry.linkedAt };
    },
    async unlink() {
      await kv.del(KEY);
      memo = {};
      memoAt = now();
      return { configured: Boolean(client), linked: false, name: '', linkedAt: null };
    },
    // The 「傳送測試訊息」 button: one message to the linked chat, errors shown to the owner.
    async test() {
      if (!client) throw new TelegramError('網站還沒設定 TELEGRAM_BOT_TOKEN', 503, 'not-configured');
      const l = await linked();
      if (!l) throw new TelegramError('還沒連結 Telegram', 409, 'not-linked');
      await client.sendMessage(l.chatId, TEST_TEXT);
      return { sent: true, name: l.name || '' };
    },
    // Best effort, never thrown: true when sent; null when there is nowhere to send (no bot, no linked chat), so
    // there is nothing to try again; false when sending was tried and failed (Telegram down, or the link could not
    // be read), so the caller keeps the news for the next run.
    async notify(html) {
      if (!client) return null;
      try {
        const l = await linked({ strict: true });
        if (!l) return null;
        await client.sendMessage(l.chatId, html, { html: true });
        return true;
      } catch (e) {
        console.error('telegram notify', e.message);
        return false;
      }
    },
  };
}

// A stand-in bot for the demo: links to a made-up account and "sends" into a list.
function mockTelegramClient() {
  const sent = [];
  return {
    sent,
    async getUpdates() { return [{ update_id: 1, message: { text: '/start', chat: { id: 1, type: 'private', first_name: '示範帳號' } } }]; },
    async getMe() { return { username: 'demo_radar_bot' }; },
    async sendMessage(chatId, text) { sent.push({ chatId, text }); return { message_id: sent.length }; },
  };
}

module.exports = { telegramClient, createTelegram, mockTelegramClient, pickChat, escHtml, TelegramError, LINKED_TEXT, TEST_TEXT };
