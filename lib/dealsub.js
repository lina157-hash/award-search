// 今日好康每日信: signed-in accounts (verified email) subscribe to get 今日好康 by mail once a day, and the owner can
// also have it sent to the site's linked Telegram / LINE chat. Sent by the daily run after the morning refresh (from
// 08:00 Taiwan time), only when there are deals, never twice the same day: a per-day record keeps who already got it,
// so a run cut off by its time limit leaves the rest to the evening run. Reuses the saved deals (no seats.aero calls).
// Every mail carries a one-click unsubscribe link: a signed token (HMAC of the email), no sign-in needed.
const crypto = require('node:crypto');
const { todayTW, addDays, TW_OFFSET_MS } = require('./day');

const P = 'dealsub:v1:';
const SET = `${P}emails`;
const OWNER = `${P}owner`;
const SECRET = `${P}secret`;
const dayKey = (d) => `${P}day:${d}`;
// Free Resend sends about 100 mails a day, shared with alerts, expiry reminders and account mails.
const CAP = 50;
const SEND_FROM_HOUR = 8; // Taiwan time: the morning cron (00:10 UTC) runs at 08:10
const MAX_AGE_MS = 18 * 3600e3; // older deals (both refreshes failed) are not mailed; the next run tries again
const PER_GROUP = 4; // as many as the home page shows per region
const BATCH = 50; // Resend's batch endpoint takes up to 100

class DealSubError extends Error {
  constructor(message, status = 400, code) { super(message); this.status = status; this.code = code; }
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n).toLocaleString('zh-TW');
const normEmail = (e) => String(e || '').trim().toLowerCase();
const CABIN_ZH = { J: '商務艙', F: '頭等艙' };
const WEEK = '日一二三四五六';
const md = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
const mdw = (iso) => `${md(iso)}（${WEEK[new Date(iso + 'T00:00:00Z').getUTCDay()]}）`;
// "a***@gmail.com", for the page that confirms an unsubscribe.
const maskEmail = (e) => { const [u, d] = String(e).split('@'); return `${u.slice(0, 1)}***@${d || ''}`; };

// The deals to send, in the home page's order: business then first, region by region, the cheapest few of each.
function digestGroups(deals) {
  const groups = Array.isArray(deals?.groups) ? deals.groups : [];
  return ['J', 'F'].flatMap((c) => groups.filter((g) => g.cabin === c && Array.isArray(g.items) && g.items.length).map((g) => ({ name: g.name, cabin: c, items: g.items.slice(0, PER_GROUP) })));
}

// The site's search for that seat: the day three days either side (not before today), like the home page's cards.
function searchLink(base, d, cabin, today) {
  const s = addDays(d.date, -3) < today ? today : addDays(d.date, -3);
  return `${base}/?${new URLSearchParams({ o: d.origin, d: d.destination, s, e: addDays(d.date, 3), c: cabin })}#search`;
}

// `names.program(source)` and `names.city(code)` turn codes into Chinese names (both optional).
function digestContent(deals, { base = '', today = todayTW(), unsubUrl = '', names = {} } = {}) {
  const prog = (s) => names.program?.(s) || s;
  const city = (c) => names.city?.(c) || '';
  const groups = digestGroups(deals);
  const all = groups.flatMap((g) => g.items.map((d) => ({ ...d, cabin: g.cabin })));
  const best = [...all].sort((a, b) => (a.cabin === b.cabin ? a.miles - b.miles : a.cabin === 'J' ? -1 : 1))[0];
  const subject = `【機票搜索雷達】今日好康 ${mdw(today)}・${best ? `${CABIN_ZH[best.cabin]} ${best.origin}→${best.destination} ${fmt(best.miles)} 哩起` : ''}`;
  const muted = 'color:#6b7280';
  const row = (d, cabin) => {
    const link = searchLink(base, d, cabin, today);
    const meta = [mdw(d.date), prog(d.source), d.direct ? '直飛' : ''].filter(Boolean).join('・');
    return `<tr><td style="padding:10px 0;border-top:1px solid #eceef1"><a href="${esc(link)}" style="color:#111827;text-decoration:none"><b>${esc(d.origin)} → ${esc(d.destination)}</b> <span style="${muted}">${esc(city(d.destination))}</span><br><span style="font-size:13px;${muted}">${esc(meta)}</span></a></td>
      <td style="padding:10px 0 10px 10px;border-top:1px solid #eceef1;text-align:right;white-space:nowrap;vertical-align:top"><a href="${esc(link)}" style="color:#111827;text-decoration:none"><b style="font-size:16px">${fmt(d.miles)}</b> <span style="font-size:13px;${muted}">哩</span><br><span style="font-size:13px;color:#2563eb">查這幾天 ›</span></a></td></tr>`;
  };
  let lastCabin = '';
  const body = groups.map((g) => {
    const head = g.cabin !== lastCabin ? `<h2 style="font-size:17px;margin:22px 0 2px">${CABIN_ZH[g.cabin]}</h2>` : '';
    lastCabin = g.cabin;
    return `${head}<h3 style="font-size:13px;font-weight:600;margin:12px 0 0;${muted}">${esc(g.name)}</h3><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${g.items.map((d) => row(d, g.cabin)).join('')}</table>`;
  }).join('');
  const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>今日好康</title></head>
<body style="margin:0;padding:0;background:#f3f4f6">
<div style="background:#f3f4f6;padding:16px 10px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans TC','PingFang TC','Microsoft JhengHei',sans-serif;line-height:1.5;color:#111827">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;padding:20px 18px">
<div style="font-size:13px;${muted}">機票搜索雷達・${esc(mdw(today))}</div>
<h1 style="font-size:22px;margin:2px 0 6px">今日好康</h1>
<p style="margin:0;font-size:14px;${muted}">台北出發最便宜的獎勵位（每人單程哩程），今天早上整理。座位隨時可能被訂走；點一筆會在網站上查那天前後三天的位子。</p>
${body}
${base ? `<p style="margin:22px 0 0;text-align:center"><a href="${esc(base)}/#search" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:10px;padding:10px 18px;font-weight:600">打開機票搜索雷達</a></p>` : ''}
</div>
<p style="max-width:560px;margin:14px auto 0;font-size:12px;${muted};text-align:center">你訂閱了「今日好康每日信」，每天有好康時寄一次。${unsubUrl ? `<br>不想再收到？<a href="${esc(unsubUrl)}" style="color:#6b7280">取消訂閱</a>（一鍵完成，不用登入）` : ''}</p>
</div></body></html>`;
  const text = [`今日好康 ${mdw(today)}`, '台北出發最便宜的獎勵位（每人單程哩程），座位隨時可能被訂走。', '',
    ...groups.flatMap((g) => [`【${CABIN_ZH[g.cabin]}・${g.name}】`, ...g.items.map((d) => `${d.origin}→${d.destination} ${city(d.destination)} ${fmt(d.miles)} 哩・${mdw(d.date)}・${prog(d.source)}${d.direct ? '・直飛' : ''}\n  ${searchLink(base, d, g.cabin, today)}`), '']),
    ...(unsubUrl ? [`取消訂閱（一鍵完成）：${unsubUrl}`] : [])].join('\n');
  // Telegram (HTML mode, links do not count toward its length limit) and LINE (tags stripped).
  const chat = [`📬 <b>今日好康</b> ${esc(mdw(today))}`, ...groups.map((g) => `\n<b>${CABIN_ZH[g.cabin]}・${esc(g.name)}</b>\n${g.items.map((d) => `<a href="${esc(searchLink(base, d, g.cabin, today))}">${esc(d.origin)}→${esc(d.destination)}</a> ${esc(city(d.destination))} ${fmt(d.miles)} 哩・${esc(md(d.date))}・${esc(prog(d.source))}`).join('\n')}`)].join('\n');
  return { subject, html, text, chat, count: all.length };
}

// `kv` (lib/kv.js); `loadDeals()` the saved 今日好康 (never a new lookup); `sendEmail({ to, subject, html, text, headers })`
// with an optional `sendEmail.batch(list)` (Resend's batch endpoint), or null; `notify` { telegram, line }: (html) → true
// sent / null nowhere to send / false failed (lib/telegram.js, lib/line.js); `accountsOk(emails)` → booleans, whether
// each is still a verified account (deleted or unverified ones are dropped); `names` (see digestContent); `log` for the
// demo; `lock()` → release function or null.
function createDealSub({ kv, loadDeals, sendEmail = null, notify = {}, accountsOk = async (emails) => emails.map(() => true), names = {}, siteUrl = '', cap = CAP, log = null, lock = async () => () => {}, now = () => Date.now() }) {
  const mailOn = Boolean(sendEmail || log);
  let secret = null;
  async function key() {
    if (secret) return secret;
    let s = await kv.get(SECRET);
    if (!s) {
      await kv.set(SECRET, crypto.randomBytes(32).toString('base64url'), { nx: true });
      s = await kv.get(SECRET);
    }
    if (!s) throw new DealSubError('暫時無法處理，請稍後再試', 503);
    secret = s;
    return s;
  }
  const mac = async (email) => crypto.createHmac('sha256', await key()).update(`unsub:${email}`).digest('base64url').slice(0, 24);
  // The unsubscribe token: the email (base64url) and its signature.
  async function token(email) { return `${Buffer.from(email).toString('base64url')}.${await mac(email)}`; }
  async function emailOf(t) {
    const m = /^([\w-]{4,400})\.([\w-]{24})$/.exec(String(t || ''));
    if (!m) return null;
    const email = Buffer.from(m[1], 'base64url').toString('utf8');
    const want = Buffer.from(await mac(email));
    const got = Buffer.from(m[2]);
    return got.length === want.length && crypto.timingSafeEqual(got, want) ? email : null;
  }

  const members = async () => (await kv.smembers(SET)).map(String);
  async function ownerPrefs() {
    const o = await kv.get(OWNER).catch(() => null);
    return { telegram: Boolean(o?.telegram), line: Boolean(o?.line) };
  }

  async function status(email) {
    const list = await members();
    const e = normEmail(email);
    return { cap, mail: mailOn, subscribed: Boolean(e && list.includes(e)), full: list.length >= cap, count: list.length };
  }

  return {
    mailOn,
    cap,
    status,
    token,
    ownerPrefs,
    count: async () => (await members()).length,
    members,
    // An account turns its own subscription on or off. Past the cap, a new subscriber is refused (two at once past the
    // last place: the later one backs out).
    async subscribe(email, on) {
      const e = normEmail(email);
      if (!e) throw new DealSubError('請先登入', 401, 'login-required');
      if (!on) { await kv.srem(SET, e); return status(e); }
      if (!mailOn) throw new DealSubError('網站還沒設定寄信服務，暫時不能用 Email 訂閱', 503, 'no-mail');
      const list = await members();
      if (list.includes(e)) return status(e);
      const full = () => new DealSubError(`名額已滿：網站每天能寄的信有限，目前最多 ${cap} 人訂閱，請之後再試`, 409, 'full');
      if (list.length >= cap) throw full();
      const added = await kv.sadd(SET, e);
      if (added && (await members()).length > cap) { await kv.srem(SET, e); throw full(); }
      return status(e);
    },
    // The link in every mail: no sign-in, just the signed token. Answers which address was taken off (masked).
    async unsubscribe(t) {
      const email = await emailOf(t);
      if (!email) throw new DealSubError('取消訂閱的連結不完整或已損壞，請從最新一封信再點一次', 400, 'token');
      await kv.srem(SET, email);
      return { ok: true, email: maskEmail(email) };
    },
    async setOwner({ telegram, line } = {}) {
      const cur = await ownerPrefs();
      const next = { telegram: telegram === undefined ? cur.telegram : Boolean(telegram), line: line === undefined ? cur.line : Boolean(line) };
      await kv.set(OWNER, next);
      return next;
    },

    // The daily part. `base`: the site's address for the links; `deadline`: start no new mail (or batch) after it.
    async run({ deadline = Infinity, base = siteUrl } = {}) {
      const t = now();
      const today = todayTW(t);
      if (new Date(t + TW_OFFSET_MS).getUTCHours() < SEND_FROM_HOUR) return { skipped: 'early' };
      const release = await lock();
      if (!release) return { busy: true };
      try {
        const mark = (await kv.get(dayKey(today))) || {};
        mark.emails = Array.isArray(mark.emails) ? mark.emails : [];
        if (mark.done) return { done: true, already: true, mailed: mark.emails.length };
        const deals = await loadDeals();
        const content = (unsubUrl) => digestContent(deals, { base, today, unsubUrl, names });
        if (!digestGroups(deals).length) return { skipped: 'no-deals' };
        if (!deals.generatedAt || t - Date.parse(deals.generatedAt) > MAX_AGE_MS) return { skipped: 'stale' };
        const save = () => kv.set(dayKey(today), mark, { ex: 3 * 86400 });
        const report = { mailed: 0, errors: 0 };
        let pending = false;

        // The owner's chats first: one message each.
        const owner = await ownerPrefs();
        for (const ch of ['telegram', 'line']) {
          if (!owner[ch] || mark[ch] || !notify[ch]) continue;
          const r = await notify[ch](content('').chat).catch(() => false);
          if (r === false) { report.errors++; pending = true; continue; }
          mark[ch] = r === true ? 'sent' : 'none'; // none: not linked any more, nothing to try again today
          if (r === true) report[ch] = true;
          await save();
        }

        const todo = (await members()).filter((e) => !mark.emails.includes(e));
        const ok = todo.length ? await accountsOk(todo) : [];
        const gone = todo.filter((_, i) => !ok[i]);
        if (gone.length) { await kv.srem(SET, ...gone); report.dropped = gone.length; }
        const left = todo.filter((_, i) => ok[i]);
        if (left.length && !mailOn) report.noMail = true;
        const mailFor = async (to) => {
          const tk = await token(to);
          const c = content(`${base}/#unsub=${tk}`);
          // RFC 8058: mail apps show their own 「取消訂閱」 button, which posts here.
          const headers = { 'List-Unsubscribe': `<${base}/api/dealsub/unsubscribe?t=${tk}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
          return { to, subject: c.subject, html: c.html, text: c.text, headers, unsub: `${base}/#unsub=${tk}` };
        };
        for (let i = 0; mailOn && i < left.length;) {
          if (now() > deadline) { report.left = left.length - i; pending = true; break; }
          if (sendEmail?.batch) {
            const part = left.slice(i, i + BATCH);
            i += part.length;
            try {
              await sendEmail.batch((await Promise.all(part.map(mailFor))).map(({ unsub, ...mail }) => mail));
              mark.emails.push(...part);
              report.mailed += part.length;
              await save();
            } catch (e) { report.errors++; pending = true; console.error('dealsub batch', e.message); }
            continue;
          }
          const to = left[i++];
          try {
            const m = await mailFor(to);
            const { unsub, ...mail } = m;
            if (sendEmail) await sendEmail(mail); else log(`[示範] 寄給 ${to}：${m.subject} 取消訂閱：${unsub}`);
            mark.emails.push(to);
            report.mailed++;
            await save();
          } catch (e) { report.errors++; pending = true; console.error('dealsub mail', e.message); }
        }
        if (!pending) { mark.done = true; await save(); }
        report.done = !pending;
        return report;
      } finally {
        await release();
      }
    },
  };
}

module.exports = { createDealSub, digestContent, digestGroups, DealSubError, maskEmail, CAP };
