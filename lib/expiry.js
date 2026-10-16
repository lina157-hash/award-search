// Miles expiry reminders (「我的點數」 › 到期日): the daily run mails one reminder 90, 30 and 7 days before a balance
// expires. Who gets one: signed-in accounts whose synced wallet has dates (mailed to the account's email), and the site
// owner's own list saved with the passcode (mailed to the alerts email and sent to the linked Telegram chat).
// Rules (fixed date vs. "N months after the last activity") come from data/expiry.json. Spends no paid quota.
// The same mail also carries (public/points6.js): vouchers with an expiry or reset date (same 90/30/7 days), what an
// expiring balance can still buy and the program's official ways to keep it, and, 3 days before the last safe
// transfer day, transfer bonuses that need registering and are not ticked 已登記.
// The same run also sends dated notes: 我的行程's key dates (hold expiry, check-in opening…, worked out by the page in
// public/trips.js and saved with the plan as `remind`) and the passport renewal 9 months before it expires. One mail
// (and one chat message) holds every kind that is due, each in its own section.
const crypto = require('node:crypto');
const { todayTW, validDate, addDays } = require('./day');
const P6 = require('../public/points6.js');

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
// The kinds one mail can hold, in the order the subject picks its lead: miles (and vouchers, soonest first, as the
// wallet sorts them), then 登記, then trip notes. `short` names the others the subject only counts.
const KINDS = [
  { is: (d) => !d.kind || d.kind === 'voucher', short: '哩程／票券' },
  { is: (d) => d.kind === 'reg', short: '轉點登記' },
  { is: isNote, short: '行程提醒' },
];
const md = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
// One subject for any mix: the lead item with its own wording, "等 N 筆" for more of its kind, then the other kinds
// counted ("另有行程提醒 2 筆"), so a mail with miles and a trip note never reads as miles only.
function subjectOf(due) {
  const groups = KINDS.map((k) => due.filter(k.is));
  const at = groups.findIndex((g) => g.length);
  if (at < 0) return '【機票搜索雷達】提醒';
  const same = groups[at];
  const d = same[0];
  const more = same.length > 1 ? ` 等 ${same.length} 筆` : '';
  const lead = d.kind === 'reg' ? `轉點加贈要登記：${d.name}${more}（最晚 ${md(d.date)} 轉出）`
    : isNote(d) ? `行程提醒：${d.name}${more}（${noteWhen(d)}）`
      : `${d.kind === 'voucher' ? '票券' : '哩程'}快到期：${d.name}${more}（${whenText(d)}）`;
  const others = groups.map((g, i) => (i !== at && g.length ? `${KINDS[i].short} ${g.length} 筆` : '')).filter(Boolean);
  return `【機票搜索雷達】${lead}${others.length ? `，另有${others.join('、')}` : ''}`;
}
const CABIN = { Y: '經濟艙', W: '豪華經濟艙', J: '商務艙', F: '頭等艙' };
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
  const notes = due.filter(isNote);
  const wallet = miles.length + vouchers.length + regs.length > 0;
  const parts = [];
  if (miles.length) parts.push(`<p>你在「我的點數」記下的哩程快到期了：</p><ul>${miles.map((d) => `<li><b>${esc(d.name)}</b>${d.miles ? ` ${fmt(d.miles)} 哩` : ''}：${esc(d.date)} 到期（${whenText(d)}）${help(d)}</li>`).join('')}</ul>`);
  if (vouchers.length) parts.push(`<p>這些票券或權益快到期（或要重置）了：</p><ul>${vouchers.map((d) => `<li><b>${esc(d.name)}</b>${d.count ? `（剩 ${fmt(d.count)}）` : ''}：${esc(d.date)}（${whenText(d)}）</li>`).join('')}</ul>`);
  if (regs.length) parts.push(`<p>這些轉點加贈要先登記，你還沒勾「我已登記」：</p><ul>${regs.map((d) => `<li><b>${esc(d.name)}</b>：${esc((d.banks || []).join('、'))} 最晚 ${md(d.date)} 要轉出（${d.days === 0 ? '就是今天' : `還剩 ${d.days} 天`}）${d.url ? `，<a href="${esc(d.url)}">活動頁</a>` : ''}</li>`).join('')}</ul>`);
  if (miles.length) parts.push('<p>到期前換一張票、轉一點點數進去或累積一筆，都可能讓哩程保住（看各計畫規則）。</p>');
  if (wallet && siteUrl) parts.push(`<p><a href="${esc(siteUrl)}/#points/wallet">打開我的點數</a></p>`);
  if (notes.length) parts.push(`<p>你的行程有日期快到了：</p><ul>${notes.map((d) => `<li><b>${esc(d.name)}</b>：${esc(d.date)}（${noteWhen(d)}）</li>`).join('')}</ul>${siteUrl ? `<p><a href="${esc(siteUrl)}/#search">打開我的行程</a></p>` : ''}`);
  // The footer says when each kind comes and how to stop it, only for the kinds in this mail.
  const when = [miles.length || vouchers.length ? '到期前 90／30／7 天各提醒一次' : '', regs.length ? '登記提醒在最晚轉點日前 3 天' : '',
    notes.length ? '行程的保留期限、報到、取消期限與護照換發各提醒一次' : ''].filter(Boolean);
  const stop = [wallet ? `把「我的點數」裡的到期日清掉${regs.length ? '，或勾「我已登記」' : ''}` : '', notes.length ? '把「我的行程」的狀態或護照效期清掉' : ''].filter(Boolean);
  return `<div style="font-family:system-ui,sans-serif;line-height:1.6">${parts.join('\n    ')}
    <p style="color:#777;font-size:13px">機票搜索雷達・${when.join('；')}。不想收到的話，${stop.join('，或')}即可。</p></div>`;
}
// The chat message: the wallet part (miles, vouchers, 登記) as before, then the trip notes in their own section.
function chatHtml(due) {
  const wallet = due.filter((d) => !isNote(d));
  const notes = due.filter(isNote);
  const line = (d) => (d.kind === 'reg' ? `🎁 ${esc(d.name)}：要先登記，${esc((d.banks || []).join('、'))} 最晚 ${md(d.date)} 轉出`
    : `${esc(d.name)}${d.miles ? ` ${fmt(d.miles)} 哩` : d.count ? `（剩 ${fmt(d.count)}）` : ''}：${esc(d.date)}（${whenText(d)}）${d.tips?.length ? `\n　還能換：${d.tips.map((a) => `台北→${esc(a.toName || a.to)} ${CABIN[a.cabin] || ''} ${fmt(a.miles)} 哩`).join('、')}` : ''}`);
  return [
    wallet.length ? `⏰ <b>${wallet.some((d) => !d.kind) ? '哩程快到期了' : wallet[0].kind === 'reg' ? '轉點加贈要登記' : '票券快到期了'}</b>\n${wallet.map(line).join('\n')}` : '',
    notes.length ? `🧳 <b>行程提醒</b>\n${notes.map((d) => `${esc(d.name)}：${esc(d.date)}（${noteWhen(d)}）`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}
// Vouchers with a date, as reminder items next to the miles ({ key: v:<id>, kind: 'voucher', … }).
function voucherExpiries(wallet, today = todayTW()) {
  return P6.cleanVouchers(wallet?.vouchers).filter((v) => v.expires).map((v) => ({
    key: `v:${v.id}`, kind: 'voucher', name: v.name || P6_KIND[v.kind], count: v.count, date: v.expires, days: daysBetween(today, v.expires),
  }));
}
const P6_KIND = { upgrade: '升等券', stay: '住宿券', lounge: '貴賓室', transfer: '機場接送', other: '票券' };

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
// Everything besides the wallet that an account's synced data asks to be reminded of.
function notesFromData(d) {
  const o = d && typeof d === 'object' ? d : {};
  const plan = o['plan:v1'];
  const notes = cleanNotes(plan && typeof plan === 'object' ? plan.remind : null);
  const pp = passportNote(o['passport:v1']);
  return pp ? [...notes, pp] : notes;
}
const noteItems = (notes, today) => cleanNotes(notes).map((n) => ({ ...n, kind: 'note', miles: 0, days: daysBetween(today, n.date) }));

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
const hasAny = (w, notes) => hasDates(w) || cleanNotes(notes).length > 0;

// `kv` (lib/kv.js); `rules` (data/expiry.json programs); `loadWallet(email)` → that account's synced wallet:v1 (with
// vouchers, reg and tips from points6.js) or null, or `loadAccount(email)` → { wallet, notes } (notes: notesFromData);
// `sendEmail({ to, subject, html })` or null; `notify(html)` (Telegram, owner only) or null; `log` for the demo.
// `ways` { key: [official ways to keep miles] } (programs.json); `regItems(wallet, today)` → the 登記 reminders due for
// that wallet (points6.js regReminders), each sent once 3 days ahead.
function createExpiry({ kv, rules = {}, steps = [90, 30, 7], loadWallet = async () => null, loadAccount = null, sendEmail = null, notify = null, siteUrl = '', log = null, now = () => Date.now(), ways = {}, regItems = null }) {
  async function index() { const v = await kv.get(INDEX).catch(() => null); return Array.isArray(v) ? v : []; }

  // Mail (or, in the demo, print); true when it went out.
  async function mail(to, due) {
    const subject = subjectOf(due);
    if (sendEmail) { await sendEmail({ to, subject, html: mailHtml(due, siteUrl, todayTW(now())) }); return true; }
    if (log) { log(`[示範] 寄給 ${to}：${subject}`); return true; }
    return false;
  }

  // Check one wallet and its notes, and send what is due. The sent record is saved only once something went out, so
  // a failed send is tried again on the next run instead of being lost.
  async function remind(id, wallet, send, notes = []) {
    const today = todayTW(now());
    const sentKey = `${P}sent:${sha(id)}`;
    const before = prune(await kv.get(sentKey).catch(() => null), today);
    const c = cleanWallet(wallet);
    const dated = [...walletExpiries(c, rules, today), ...voucherExpiries(c, today), ...noteItems(notes, today)].sort((a, b) => a.date.localeCompare(b.date));
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
    // After an account saves its data: keep its email in the reminder list while its wallet or notes have any dates.
    async track(email, wallet, notes = []) {
      const list = await index();
      const want = hasAny(wallet, notes);
      if (want === list.includes(email)) return;
      const next = want ? [...list, email].slice(-MAX_INDEX) : list.filter((e) => e !== email);
      await kv.set(INDEX, next);
    },
    // The owner's own list (no account needed): saved with the passcode, mailed to `email` and sent to Telegram.
    // 我的點數 sends `wallet`, 我的行程 sends `notes` and `passport`; each keeps what the other saved. `count` is what
    // the sender saved (wallet dates, or notes plus the passport).
    async saveOwner({ email, wallet, notes, passport }) {
      const e = String(email || '').trim().toLowerCase();
      if (e && (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))) throw Object.assign(new Error('Email 格式錯誤'), { status: 400 });
      const prev = (await kv.get(OWNER).catch(() => null)) || {};
      const w = cleanWallet(wallet !== undefined ? wallet : prev.wallet);
      const n = cleanNotes(notes !== undefined ? notes : prev.notes);
      const pp = passport !== undefined ? (passportNote(passport) ? { expiry: passport.expiry } : null) : prev.passport || null;
      if (!hasDates(w) && !n.length && !pp) { await kv.del(OWNER); return { ok: true, count: 0 }; }
      await kv.set(OWNER, { email: e, wallet: w, notes: n, passport: pp, savedAt: new Date(now()).toISOString() });
      return { ok: true, count: wallet !== undefined ? remindCount(w) : n.length + (pp ? 1 : 0), email: e };
    },
    async getOwner() {
      const o = await kv.get(OWNER).catch(() => null);
      return o ? { email: o.email || '', count: remindCount(cleanWallet(o.wallet)), notes: cleanNotes(o.notes).length + (o.passport ? 1 : 0), savedAt: o.savedAt || null }
        : { email: '', count: 0, notes: 0, savedAt: null };
    },
    // The daily part: every tracked account, then the owner's list. Stops starting new ones after `deadline`.
    async run({ deadline = Infinity, lock = async () => () => {} } = {}) {
      const release = await lock();
      if (!release) return { busy: true };
      const report = { accounts: 0, reminded: 0, errors: 0 };
      try {
        const owner = await kv.get(OWNER).catch(() => null);
        if (owner?.wallet || owner?.notes || owner?.passport) {
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

module.exports = { createExpiry, addMonths, expiryOf, walletExpiries, voucherExpiries, dueReminders, cleanWallet, mailHtml, chatHtml, cleanNotes, passportNote, notesFromData, subjectOf };
