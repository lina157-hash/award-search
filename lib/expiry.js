// Miles expiry reminders (「我的點數」 › 到期日): the daily run mails one reminder 90, 30 and 7 days before a balance
// expires. Who gets one: signed-in accounts whose synced wallet has dates (mailed to the account's email), and the site
// owner's own list saved with the passcode (mailed to the alerts email and sent to the linked Telegram chat).
// Rules (fixed date vs. "N months after the last activity") come from data/expiry.json. Spends no paid quota.
// The same run also sends dated notes: 我的行程's key dates (hold expiry, check-in opening…, worked out by the page in
// public/trips.js and saved with the plan as `remind`) and the passport renewal 9 months before it expires.
const crypto = require('node:crypto');
const { todayTW, validDate } = require('./day');

const P = 'expiry:v1:';
const INDEX = `${P}emails`;
const OWNER = `${P}owner`;
const MAX_INDEX = 2000;
const MAX_ITEMS = 40;
const MAX_NOTES = 30;
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
// A note brings its own steps (0 = on the day itself).
function dueReminders(list, sent = {}, steps = [90, 30, 7]) {
  const next = { ...sent };
  const due = [];
  for (const it of list) {
    const order = [...(it.steps || steps)].sort((a, b) => a - b);
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
const isNote = (d) => d.kind === 'note';
const noteWhen = (d) => (d.days === 0 ? '就是今天' : `還有 ${d.days} 天`);
const whenOf = (d) => (isNote(d) ? noteWhen(d) : whenText(d));
function subjectOf(due) {
  const miles = due.filter((d) => !isNote(d));
  const first = miles[0] || due[0];
  return `【機票搜索雷達】${miles.length ? '哩程快到期' : '行程提醒'}：${first.name}${due.length > 1 ? ` 等 ${due.length} 筆` : ''}（${whenOf(first)}）`;
}
function mailHtml(due, siteUrl) {
  const miles = due.filter((d) => !isNote(d));
  const notes = due.filter(isNote);
  const rows = miles.map((d) => `<li><b>${esc(d.name)}</b>${d.miles ? ` ${fmt(d.miles)} 哩` : ''}：${esc(d.date)} 到期（${whenText(d)}）</li>`).join('');
  const noteRows = notes.map((d) => `<li><b>${esc(d.name)}</b>：${esc(d.date)}（${noteWhen(d)}）</li>`).join('');
  return `<div style="font-family:system-ui,sans-serif;line-height:1.6">${miles.length ? `<p>你在「我的點數」記下的哩程快到期了：</p><ul>${rows}</ul>
    <p>到期前換一張票、轉一點點數進去或累積一筆，都可能讓哩程保住（看各計畫規則）。${siteUrl ? `<a href="${esc(siteUrl)}/#points/wallet">打開我的點數</a>` : ''}</p>` : ''}
    ${notes.length ? `<p>你的行程有日期快到了：</p><ul>${noteRows}</ul>${siteUrl ? `<p><a href="${esc(siteUrl)}/#search">打開我的行程</a></p>` : ''}` : ''}
    <p style="color:#777;font-size:13px">機票搜索雷達・${miles.length ? '哩程到期前 90／30／7 天各提醒一次；' : ''}${notes.length ? '行程的保留期限、報到、取消期限與護照換發各提醒一次；' : ''}不想收到的話，把「我的點數」的到期日或「我的行程」的狀態清掉即可。</p></div>`;
}
const chatHtml = (due) => {
  const miles = due.filter((d) => !isNote(d));
  const notes = due.filter(isNote);
  return [
    miles.length ? `⏰ <b>哩程快到期了</b>\n${miles.map((d) => `${esc(d.name)}${d.miles ? ` ${fmt(d.miles)} 哩` : ''}：${esc(d.date)}（${whenText(d)}）`).join('\n')}` : '',
    notes.length ? `🧳 <b>行程提醒</b>\n${notes.map((d) => `${esc(d.name)}：${esc(d.date)}（${noteWhen(d)}）`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
};

// ---------- dated notes: 我的行程 and the passport ----------
// { key, name, date, steps }; the key has no "|" (the sent record uses it as a separator).
function cleanNotes(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const n of list.slice(0, MAX_NOTES)) {
    if (!n || typeof n !== 'object') continue;
    const key = String(n.key ?? '');
    const name = String(n.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!/^[\w:.-]{1,60}$/.test(key) || !name || !validDate(n.date)) continue;
    const steps = [...new Set((Array.isArray(n.steps) ? n.steps : []).map(Number).filter((x) => Number.isInteger(x) && x >= 0 && x <= 400))].slice(0, 4);
    out.push({ key, name, date: n.date, steps: steps.length ? steps : [0] });
  }
  return out;
}
// TripIt-style renewal reminder: once, 9 months before the passport expires (many countries want 6 months left).
function passportNote(p, months = 9) {
  const exp = p && typeof p === 'object' ? p.expiry : null;
  if (!validDate(exp)) return null;
  return { key: 'passport', name: `護照 ${exp} 到期，建議到期前 ${months} 個月換發`, date: exp, steps: [daysBetween(addMonths(exp, -months), exp)] };
}
// Everything besides miles that an account's synced data asks to be reminded of.
function notesFromData(d) {
  const o = d && typeof d === 'object' ? d : {};
  const plan = o['plan:v1'];
  const notes = cleanNotes(plan && typeof plan === 'object' ? plan.remind : null);
  const pp = passportNote(o['passport:v1']);
  return pp ? [...notes, pp] : notes;
}
const noteItems = (notes, today) => cleanNotes(notes).map((n) => ({ ...n, kind: 'note', miles: 0, days: daysBetween(today, n.date) }));

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

// `kv` (lib/kv.js); `rules` (data/expiry.json programs); `loadWallet(email)` → that account's synced wallet:v1 or null,
// or `loadAccount(email)` → { wallet, notes } (notesFromData); `sendEmail({ to, subject, html })` or null;
// `notify(html)` (Telegram, owner only) or null; `log` for the demo.
function createExpiry({ kv, rules = {}, steps = [90, 30, 7], loadWallet = async () => null, loadAccount = null, sendEmail = null, notify = null, siteUrl = '', log = null, now = () => Date.now() }) {
  async function index() { const v = await kv.get(INDEX).catch(() => null); return Array.isArray(v) ? v : []; }
  const hasDates = (w) => Object.keys(cleanWallet(w).expiry).length > 0;
  const hasAny = (w, notes) => hasDates(w) || cleanNotes(notes).length > 0;

  // Mail (or, in the demo, print); true when it went out.
  async function mail(to, due) {
    const subject = subjectOf(due);
    if (sendEmail) { await sendEmail({ to, subject, html: mailHtml(due, siteUrl) }); return true; }
    if (log) { log(`[示範] 寄給 ${to}：${subject}`); return true; }
    return false;
  }

  // Check one wallet and send what is due. The sent record is saved only once something went out, so a failed
  // send is tried again on the next run instead of being lost.
  async function remind(id, wallet, send, notes = []) {
    const today = todayTW(now());
    const sentKey = `${P}sent:${sha(id)}`;
    const before = prune(await kv.get(sentKey).catch(() => null), today);
    const items = [...walletExpiries(wallet, rules, today), ...noteItems(notes, today)].sort((a, b) => a.date.localeCompare(b.date));
    const { due, sent } = dueReminders(items, before, steps);
    if (!due.length) return { due: 0 };
    const out = await send(due);
    if (Object.values(out || {}).some((v) => v === true)) await kv.set(sentKey, sent, { ex: SENT_TTL });
    return { due: due.length, ...out };
  }

  return {
    // After an account saves its data: keep its email in the reminder list while its wallet or notes have any dates.
    async track(email, wallet, notes = []) {
      const list = await index();
      const want = hasAny(wallet, notes);
      if (want === list.includes(email)) return;
      const next = want ? [...list, email].slice(-MAX_INDEX) : list.filter((e) => e !== email);
      await kv.set(INDEX, next);
    },
    // The owner's own list (no account needed): saved with the passcode, mailed to `email` and sent to Telegram.
    // 我的點數 sends `wallet`, 我的行程 sends `notes` and `passport`; each keeps what the other saved.
    async saveOwner({ email, wallet, notes, passport }) {
      const e = String(email || '').trim().toLowerCase();
      if (e && (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))) throw Object.assign(new Error('Email 格式錯誤'), { status: 400 });
      const prev = (await kv.get(OWNER).catch(() => null)) || {};
      const w = wallet !== undefined ? cleanWallet(wallet) : cleanWallet(prev.wallet);
      const n = notes !== undefined ? cleanNotes(notes) : cleanNotes(prev.notes);
      const pp = passport !== undefined ? (passportNote(passport) ? { expiry: passport.expiry } : null) : prev.passport || null;
      const count = wallet !== undefined ? Object.keys(w.expiry).length : n.length + (pp ? 1 : 0);
      if (!Object.keys(w.expiry).length && !n.length && !pp) { await kv.del(OWNER); return { ok: true, count: 0 }; }
      await kv.set(OWNER, { email: e, wallet: w, notes: n, passport: pp, savedAt: new Date(now()).toISOString() });
      return { ok: true, count, email: e };
    },
    async getOwner() {
      const o = await kv.get(OWNER).catch(() => null);
      return o ? { email: o.email || '', count: Object.keys(o.wallet?.expiry || {}).length, notes: cleanNotes(o.notes).length + (o.passport ? 1 : 0), savedAt: o.savedAt || null } : { email: '', count: 0, notes: 0, savedAt: null };
    },
    // The daily part: every tracked account, then the owner's list. Stops starting new ones after `deadline`.
    async run({ deadline = Infinity, lock = async () => () => {} } = {}) {
      const release = await lock();
      if (!release) return { busy: true };
      const report = { accounts: 0, reminded: 0, errors: 0 };
      try {
        const owner = await kv.get(OWNER).catch(() => null);
        if (owner?.wallet || owner?.notes) {
          try {
            const pp = passportNote(owner.passport);
            const r = await remind('owner', owner.wallet, async (due) => {
              const [m, t] = await Promise.allSettled([owner.email ? mail(owner.email, due) : false, notify ? notify(chatHtml(due)) : false]);
              return { mailed: m.status === 'fulfilled' && m.value === true, telegram: t.status === 'fulfilled' && t.value === true };
            }, [...cleanNotes(owner.notes), ...(pp ? [pp] : [])]);
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
            const acc = loadAccount ? await loadAccount(email) : { wallet: await loadWallet(email), notes: [] };
            const w = acc?.wallet;
            const notes = acc?.notes || [];
            if (!hasAny(w, notes)) { gone.push(email); continue; }
            const r = await remind(`acct:${email}`, w, async (due) => ({ mailed: await mail(email, due) }), notes);
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

module.exports = { createExpiry, addMonths, expiryOf, walletExpiries, dueReminders, cleanWallet, mailHtml, cleanNotes, passportNote, notesFromData, subjectOf };
