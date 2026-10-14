// Miles expiry reminders (「我的點數」 › 到期日): the daily run mails one reminder 90, 30 and 7 days before a balance
// expires. Who gets one: signed-in accounts whose synced wallet has dates (mailed to the account's email), and the site
// owner's own list saved with the passcode (mailed to the alerts email and sent to the linked Telegram chat).
// Rules (fixed date vs. "N months after the last activity") come from data/expiry.json. Spends no paid quota.
const crypto = require('node:crypto');
const { todayTW, validDate } = require('./day');

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
function mailHtml(due, siteUrl) {
  const rows = due.map((d) => `<li><b>${esc(d.name)}</b>${d.miles ? ` ${fmt(d.miles)} 哩` : ''}：${esc(d.date)} 到期（${whenText(d)}）</li>`).join('');
  return `<div style="font-family:system-ui,sans-serif;line-height:1.6"><p>你在「我的點數」記下的哩程快到期了：</p><ul>${rows}</ul>
    <p>到期前換一張票、轉一點點數進去或累積一筆，都可能讓哩程保住（看各計畫規則）。${siteUrl ? `<a href="${esc(siteUrl)}/#points/wallet">打開我的點數</a>` : ''}</p>
    <p style="color:#777;font-size:13px">機票搜索雷達・到期前 90／30／7 天各提醒一次。不想收到的話，把「我的點數」裡的到期日清掉即可。</p></div>`;
}
const chatHtml = (due) => `⏰ <b>哩程快到期了</b>\n${due.map((d) => `${esc(d.name)}${d.miles ? ` ${fmt(d.miles)} 哩` : ''}：${esc(d.date)}（${whenText(d)}）`).join('\n')}`;

// Keep only what the reminder needs from a wallet: balances and dates of programs that have a date.
function cleanWallet(w) {
  const exp = {};
  const miles = {};
  for (const [k, v] of Object.entries(w?.expiry && typeof w.expiry === 'object' ? w.expiry : {}).slice(0, MAX_ITEMS)) {
    if (!/^[\w-]{1,40}$/.test(k) || !validDate(v)) continue;
    exp[k] = v;
    const n = Math.floor(Number(w.miles?.[k]) || 0);
    if (n > 0) miles[k] = Math.min(n, 1e9);
  }
  return { miles, expiry: exp };
}

// `kv` (lib/kv.js); `rules` (data/expiry.json programs); `loadWallet(email)` → that account's synced wallet:v1 or null;
// `sendEmail({ to, subject, html })` or null; `notify(html)` (Telegram, owner only) or null; `log` for the demo.
function createExpiry({ kv, rules = {}, steps = [90, 30, 7], loadWallet = async () => null, sendEmail = null, notify = null, siteUrl = '', log = null, now = () => Date.now() }) {
  async function index() { const v = await kv.get(INDEX).catch(() => null); return Array.isArray(v) ? v : []; }
  const hasDates = (w) => Object.keys(cleanWallet(w).expiry).length > 0;

  // Mail (or, in the demo, print); true when it went out.
  async function mail(to, due) {
    const subject = `【機票搜索雷達】哩程快到期：${due[0].name}${due.length > 1 ? ` 等 ${due.length} 筆` : ''}（${whenText(due[0])}）`;
    if (sendEmail) { await sendEmail({ to, subject, html: mailHtml(due, siteUrl) }); return true; }
    if (log) { log(`[示範] 寄給 ${to}：${subject}`); return true; }
    return false;
  }

  // Check one wallet and send what is due. The sent record is saved only once something went out, so a failed
  // send is tried again on the next run instead of being lost.
  async function remind(id, wallet, send) {
    const today = todayTW(now());
    const sentKey = `${P}sent:${sha(id)}`;
    const before = prune(await kv.get(sentKey).catch(() => null), today);
    const { due, sent } = dueReminders(walletExpiries(wallet, rules, today), before, steps);
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
      if (!Object.keys(w.expiry).length) { await kv.del(OWNER); return { ok: true, count: 0 }; }
      await kv.set(OWNER, { email: e, wallet: w, savedAt: new Date(now()).toISOString() });
      return { ok: true, count: Object.keys(w.expiry).length, email: e };
    },
    async getOwner() {
      const o = await kv.get(OWNER).catch(() => null);
      return o ? { email: o.email || '', count: Object.keys(o.wallet?.expiry || {}).length, savedAt: o.savedAt || null } : { email: '', count: 0, savedAt: null };
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

module.exports = { createExpiry, addMonths, expiryOf, walletExpiries, dueReminders, cleanWallet, mailHtml };
