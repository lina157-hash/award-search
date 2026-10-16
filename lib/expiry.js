// Miles expiry reminders (「我的點數」 › 到期日): the daily run mails one reminder 90, 30 and 7 days before a balance
// expires. Who gets one: signed-in accounts whose synced wallet has dates (mailed to the account's email), and the site
// owner's own list saved with the passcode (mailed to the alerts email and sent to the linked Telegram chat).
// Rules (fixed date vs. "N months after the last activity") come from data/expiry.json. Spends no paid quota.
// The same mail also carries (public/points6.js): vouchers with an expiry or reset date (same 90/30/7 days), what an
// expiring balance can still buy and the program's official ways to keep it, and, 3 days before the last safe
// transfer day, transfer bonuses that need registering and are not ticked 已登記.
const crypto = require('node:crypto');
const { todayTW, validDate, addDays } = require('./day');
const P6 = require('../public/points6.js');

const P = 'expiry:v1:';
const INDEX = `${P}emails`;
const OWNER = `${P}owner`;
const MAX_INDEX = 2000;
const MAX_ITEMS = 40;
const SENT_TTL = 400 * 86400;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('base64url').slice(0, 24);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n).toLocaleString('zh-TW');

// `iso` plus `n` calendar months; a day past the end of the shorter month lands on its last day (01-31 + 1 → 02-28).
function addMonths(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last))).toISOString().slice(0, 10);
}
const daysBetween = (from, to) => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 864e5);

// The expiry date for what the user entered: activity programs store the last activity date, others the expiry itself.
function expiryOf(rule, entered) {
  if (!validDate(entered) || rule?.kind === 'none') return null;
  return rule?.kind === 'activity' && rule.months ? addMonths(entered, rule.months) : entered;
}

// { key, name, miles, entered, date, days } for every dated balance in a wallet ({ miles, expiry }), soonest first.
function walletExpiries(wallet, rules = {}, today = todayTW()) {
  const exp = wallet && typeof wallet.expiry === 'object' && wallet.expiry ? wallet.expiry : {};
  const miles = wallet && typeof wallet.miles === 'object' && wallet.miles ? wallet.miles : {};
  const out = [];
  for (const [key, entered] of Object.entries(exp).slice(0, MAX_ITEMS)) {
    if (!/^[\w-]{1,40}$/.test(key)) continue;
    const date = expiryOf(rules[key], entered);
    if (!date) continue;
    out.push({ key, name: rules[key]?.name || key, miles: Math.max(0, Math.floor(Number(miles[key]) || 0)), entered, date, days: daysBetween(today, date) });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// Which balances are due a reminder today. One mail per step (90/30/7 days): a balance entered at 20 days gets the
// 30-day one now and the 7-day one later; a missed day is caught up the next run. `sent` is { "key|date|step": 1 }.
function dueReminders(list, sent = {}, steps = [90, 30, 7]) {
  const next = { ...sent };
  const due = [];
  const order = [...steps].sort((a, b) => a - b);
  for (const it of list) {
    if (it.days < 0) continue;
    const step = order.find((s) => it.days <= s);
    if (step == null) continue;
    const id = (s) => `${it.key}|${it.date}|${s}`;
    if (!next[id(step)]) due.push({ ...it, step });
    for (const s of order) if (s >= it.days) next[id(s)] = 1;
  }
  return { due, sent: next };
}
// Forget entries for dates already past, so the record stays small.
const prune = (sent, today) => Object.fromEntries(Object.entries(sent || {}).filter(([k]) => (k.split('|')[1] || '') >= today));

const whenText = (d) => (d.days === 0 ? '今天到期' : `還剩 ${d.days} 天`);
const CABIN = { Y: '經濟艙', W: '豪華經濟艙', J: '商務艙', F: '頭等艙' };
const md = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
// A search link for one suggestion: the next 30 days from tomorrow (opening it spends one seats.aero search).
const searchUrl = (siteUrl, a, today) => `${siteUrl}/?${new URLSearchParams({ o: 'TPE', d: a.to, s: addDays(today, 1), e: addDays(today, 30), c: a.cabin })}#search`;
function mailHtml(due, siteUrl, today = todayTW()) {
  const miles = due.filter((d) => !d.kind);
  const vouchers = due.filter((d) => d.kind === 'voucher');
  const regs = due.filter((d) => d.kind === 'reg');
  const help = (d) => {
    const tips = (d.tips || []).map((a) => `<li>台北 → ${esc(a.toName || a.to)} ${CABIN[a.cabin] || ''}單程 ${fmt(a.miles)} 哩${siteUrl ? `　<a href="${esc(searchUrl(siteUrl, a, today))}">查座位</a>（用 1 次查詢）` : ''}</li>`).join('');
    return `${tips ? `<br><small>這些哩數還能換（固定哩程表估算，有沒有位子要另外查）：</small><ul style="margin:2px 0">${tips}</ul>` : ''}${d.ways?.length ? `<small>官方的延長方式：${d.ways.map(esc).join('；')}。</small>` : ''}`;
  };
  const parts = [];
  if (miles.length) parts.push(`<p>你在「我的點數」記下的哩程快到期了：</p><ul>${miles.map((d) => `<li><b>${esc(d.name)}</b>${d.miles ? ` ${fmt(d.miles)} 哩` : ''}：${esc(d.date)} 到期（${whenText(d)}）${help(d)}</li>`).join('')}</ul>`);
  if (vouchers.length) parts.push(`<p>這些票券或權益快到期（或要重置）了：</p><ul>${vouchers.map((d) => `<li><b>${esc(d.name)}</b>${d.count ? `（剩 ${fmt(d.count)}）` : ''}：${esc(d.date)}（${whenText(d)}）</li>`).join('')}</ul>`);
  if (regs.length) parts.push(`<p>這些轉點加贈要先登記，你還沒勾「我已登記」：</p><ul>${regs.map((d) => `<li><b>${esc(d.name)}</b>：${esc((d.banks || []).join('、'))} 最晚 ${md(d.date)} 要轉出（${d.days === 0 ? '就是今天' : `還剩 ${d.days} 天`}）${d.url ? `，<a href="${esc(d.url)}">活動頁</a>` : ''}</li>`).join('')}</ul>`);
  return `<div style="font-family:system-ui,sans-serif;line-height:1.6">${parts.join('')}
    ${miles.length ? '<p>到期前換一張票、轉一點點數進去或累積一筆，都可能讓哩程保住（看各計畫規則）。</p>' : ''}${siteUrl ? `<p><a href="${esc(siteUrl)}/#points/wallet">打開我的點數</a></p>` : ''}
    <p style="color:#777;font-size:13px">機票搜索雷達・到期前 90／30／7 天各提醒一次${regs.length ? '；登記提醒在最晚轉點日前 3 天' : ''}。不想收到的話，把「我的點數」裡的到期日清掉${regs.length ? '，或勾「我已登記」' : ''}即可。</p></div>`;
}
function chatHtml(due) {
  const line = (d) => (d.kind === 'reg' ? `🎁 ${esc(d.name)}：要先登記，${esc((d.banks || []).join('、'))} 最晚 ${md(d.date)} 轉出`
    : `${esc(d.name)}${d.miles ? ` ${fmt(d.miles)} 哩` : d.count ? `（剩 ${fmt(d.count)}）` : ''}：${esc(d.date)}（${whenText(d)}）${d.tips?.length ? `\n　還能換：${d.tips.map((a) => `台北→${esc(a.toName || a.to)} ${CABIN[a.cabin] || ''} ${fmt(a.miles)} 哩`).join('、')}` : ''}`);
  return `⏰ <b>${due.some((d) => !d.kind) ? '哩程快到期了' : due[0].kind === 'reg' ? '轉點加贈要登記' : '票券快到期了'}</b>\n${due.map(line).join('\n')}`;
}
// Vouchers with a date, as reminder items next to the miles ({ key: v:<id>, kind: 'voucher', … }).
function voucherExpiries(wallet, today = todayTW()) {
  return P6.cleanVouchers(wallet?.vouchers).filter((v) => v.expires).map((v) => ({
    key: `v:${v.id}`, kind: 'voucher', name: v.name || P6_KIND[v.kind], count: v.count, date: v.expires, days: daysBetween(today, v.expires),
  }));
}
const P6_KIND = { upgrade: '升等券', stay: '住宿券', lounge: '貴賓室', transfer: '機場接送', other: '票券' };

// Keep only what the reminder needs from a wallet: balances and dates of programs that have a date, plus (points6.js)
// the bank programs (ids, for 登記 reminders), vouchers, 已登記 ticks and what expiring balances can still buy.
function cleanWallet(w) {
  const exp = {};
  const miles = {};
  for (const [k, v] of Object.entries(w?.expiry && typeof w.expiry === 'object' ? w.expiry : {}).slice(0, MAX_ITEMS)) {
    if (!/^[\w-]{1,40}$/.test(k) || !validDate(v)) continue;
    exp[k] = v;
    const n = Math.floor(Number(w.miles?.[k]) || 0);
    if (n > 0) miles[k] = Math.min(n, 1e9);
  }
  const bankIds = Array.isArray(w?.banks) ? w.banks : Object.keys(w?.banks && typeof w.banks === 'object' ? w.banks : {});
  const banks = bankIds.filter((k) => typeof k === 'string' && /^[\w-]{1,40}$/.test(k)).slice(0, MAX_ITEMS);
  return { miles, expiry: exp, banks, vouchers: P6.cleanVouchers(w?.vouchers), reg: P6.cleanReg(w?.reg), tips: P6.cleanTips(w?.tips) };
}
// Anything the daily run could remind about: a miles date, a dated voucher, or bank points (for 登記 reminders).
const hasDates = (w) => { const c = cleanWallet(w); return Object.keys(c.expiry).length > 0 || c.vouchers.some((v) => v.expires) || c.banks.length > 0; };
const remindCount = (c) => Object.keys(c.expiry).length + c.vouchers.filter((v) => v.expires).length;

// `kv` (lib/kv.js); `rules` (data/expiry.json programs); `loadWallet(email)` → that account's synced wallet:v1 (with
// vouchers, reg and tips from points6.js) or null; `sendEmail({ to, subject, html })` or null; `notify(html)`
// (Telegram, owner only) or null; `log` for the demo. `ways` { key: [official ways to keep miles] } (programs.json);
// `regItems(wallet, today)` → the 登記 reminders due for that wallet (points6.js regReminders), each sent once 3 days ahead.
function createExpiry({ kv, rules = {}, steps = [90, 30, 7], loadWallet = async () => null, sendEmail = null, notify = null, siteUrl = '', log = null, now = () => Date.now(), ways = {}, regItems = null }) {
  async function index() { const v = await kv.get(INDEX).catch(() => null); return Array.isArray(v) ? v : []; }

  // Mail (or, in the demo, print); true when it went out.
  async function mail(to, due) {
    const d = due[0];
    const what = d.kind === 'reg' ? `轉點加贈要登記：${d.name}（最晚 ${md(d.date)} 轉出）` : `${d.kind === 'voucher' ? '票券' : '哩程'}快到期：${d.name}${due.length > 1 ? ` 等 ${due.length} 筆` : ''}（${whenText(d)}）`;
    const subject = `【機票搜索雷達】${what}`;
    if (sendEmail) { await sendEmail({ to, subject, html: mailHtml(due, siteUrl, todayTW(now())) }); return true; }
    if (log) { log(`[示範] 寄給 ${to}：${subject}`); return true; }
    return false;
  }

  // Check one wallet and send what is due. The sent record is saved only once something went out, so a failed
  // send is tried again on the next run instead of being lost.
  async function remind(id, wallet, send) {
    const today = todayTW(now());
    const sentKey = `${P}sent:${sha(id)}`;
    const before = prune(await kv.get(sentKey).catch(() => null), today);
    const c = cleanWallet(wallet);
    const dated = [...walletExpiries(c, rules, today), ...voucherExpiries(c, today)].sort((a, b) => a.date.localeCompare(b.date));
    const first = dueReminders(dated, before, steps);
    const regs = regItems ? dueReminders(regItems(c, today), first.sent, [3]) : { due: [], sent: first.sent };
    const due = [...first.due, ...regs.due].map((d) => (d.kind ? d : { ...d, tips: c.tips[d.key]?.awards || [], ways: ways[d.key] || [] }));
    const { sent } = regs;
    if (!due.length) return { due: 0 };
    const out = await send(due);
    if (Object.values(out || {}).some((v) => v === true)) await kv.set(sentKey, sent, { ex: SENT_TTL });
    return { due: due.length, ...out };
  }

  return {
    // After an account saves its data: keep its email in the reminder list while its wallet has any dates.
    async track(email, wallet) {
      const list = await index();
      const want = hasDates(wallet);
      if (want === list.includes(email)) return;
      const next = want ? [...list, email].slice(-MAX_INDEX) : list.filter((e) => e !== email);
      await kv.set(INDEX, next);
    },
    // The owner's own list (no account needed): saved with the passcode, mailed to `email` and sent to Telegram.
    async saveOwner({ email, wallet }) {
      const e = String(email || '').trim().toLowerCase();
      if (e && (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))) throw Object.assign(new Error('Email 格式錯誤'), { status: 400 });
      const w = cleanWallet(wallet);
      if (!hasDates(w)) { await kv.del(OWNER); return { ok: true, count: 0 }; }
      await kv.set(OWNER, { email: e, wallet: w, savedAt: new Date(now()).toISOString() });
      return { ok: true, count: remindCount(w), email: e };
    },
    async getOwner() {
      const o = await kv.get(OWNER).catch(() => null);
      return o ? { email: o.email || '', count: remindCount(cleanWallet(o.wallet)), savedAt: o.savedAt || null } : { email: '', count: 0, savedAt: null };
    },
    // The daily part: every tracked account, then the owner's list. Stops starting new ones after `deadline`.
    async run({ deadline = Infinity, lock = async () => () => {} } = {}) {
      const release = await lock();
      if (!release) return { busy: true };
      const report = { accounts: 0, reminded: 0, errors: 0 };
      try {
        const owner = await kv.get(OWNER).catch(() => null);
        if (owner?.wallet) {
          try {
            const r = await remind('owner', owner.wallet, async (due) => {
              const [m, t] = await Promise.allSettled([owner.email ? mail(owner.email, due) : false, notify ? notify(chatHtml(due)) : false]);
              return { mailed: m.status === 'fulfilled' && m.value === true, telegram: t.status === 'fulfilled' && t.value === true };
            });
            if (r.due) report.reminded++;
            report.owner = r;
          } catch (e) { report.errors++; report.ownerError = e.message; }
        }
        const emails = await index();
        const gone = [];
        for (const email of emails) {
          if (now() > deadline) { report.skipped = (report.skipped || 0) + 1; continue; }
          report.accounts++;
          try {
            const w = await loadWallet(email);
            if (!hasDates(w)) { gone.push(email); continue; }
            const r = await remind(`acct:${email}`, w, async (due) => ({ mailed: await mail(email, due) }));
            if (r.due) report.reminded++;
          } catch (e) { report.errors++; console.error('expiry', e.message); }
        }
        if (gone.length) await kv.set(INDEX, (await index()).filter((e) => !gone.includes(e))).catch(() => {});
        return report;
      } finally {
        await release();
      }
    },
  };
}

module.exports = { createExpiry, addMonths, expiryOf, walletExpiries, voucherExpiries, dueReminders, cleanWallet, mailHtml, chatHtml };
