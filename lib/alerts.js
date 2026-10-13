// Award-seat alerts: saved searches that a scheduled run re-checks, emailing whatever is newly available.
// Storage is Upstash Redis over REST (set up from Vercel's Storage tab), email goes through Resend; both optional.
const crypto = require('node:crypto');

const KEY = 'award-alerts:v1';
const MAX_ALERTS = 20;
const MAX_NEW_IN_MAIL = 40;

class AlertError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// Upstash REST: POST a command array, get { result }.
function redisStore({ url, token, key = KEY, fetchImpl = fetch }) {
  async function cmd(...args) {
    const res = await fetchImpl(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(args) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) throw new AlertError(`提醒資料庫回應錯誤：${body.error || res.status}`, 502);
    return body.result;
  }
  return {
    async load() { const v = await cmd('GET', key); return v ? JSON.parse(v) : []; },
    async save(list) { await cmd('SET', key, JSON.stringify(list)); },
  };
}

function memoryStore() {
  let list = [];
  return { async load() { return list; }, async save(next) { list = next; } };
}

// Resend: one HTML email per run that found something new.
function resendMailer({ apiKey, from, fetchImpl = fetch }) {
  return async function send({ to, subject, html }) {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: from || '機票搜索雷達 <onboarding@resend.dev>', to: [to], subject, html }),
    });
    if (!res.ok) throw new AlertError(`寄信失敗：${(await res.text().catch(() => '')).slice(0, 200)}`, 502);
  };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n).toLocaleString('zh-TW');
const CABIN_ZH = { Y: '經濟艙', W: '豪華經濟艙', J: '商務艙', F: '頭等艙' };
// seats.aero's `cabins` filter takes names, not the one-letter codes the alert stores.
const CABIN_API = { Y: 'economy', W: 'premium', J: 'business', F: 'first' };
const today = () => new Date().toISOString().slice(0, 10);

function createAlerts({ store, search, sendEmail, siteUrl = '', programNames = {} }) {
  const name = (s) => programNames[s] || s;

  // What a watch currently matches: one row per date × route × program, keyed by seats.aero's availability ID.
  async function check(a) {
    const results = await search({ origin_airport: a.origin, destination_airport: a.destination, start_date: a.start, end_date: a.end, cabins: CABIN_API[a.cabin] });
    const rows = [];
    for (const r of results) {
      const c = r.cabins[a.cabin];
      if (!c?.available || !c.miles) continue;
      if (a.pax && c.seats > 0 && c.seats < a.pax) continue;
      rows.push({ id: r.id, date: r.date, origin: r.origin, destination: r.destination, source: r.source, miles: c.miles, seats: c.seats, airlines: c.airlines, direct: c.direct });
    }
    rows.sort((x, y) => x.date.localeCompare(y.date) || x.miles - y.miles);
    return rows;
  }

  function mailHtml(a, fresh) {
    const link = `${siteUrl}/?${new URLSearchParams({ o: a.origin, d: a.destination, s: a.start, e: a.end, c: a.cabin, ...(a.pax ? { n: a.pax } : {}) })}#search`;
    const tr = fresh.slice(0, MAX_NEW_IN_MAIL).map((r) => `<tr><td>${r.date}</td><td>${esc(r.origin)} → ${esc(r.destination)}</td><td>${esc(name(r.source))}</td><td align="right">${fmt(r.miles)}</td><td>${esc(r.airlines)}${r.direct ? '（直飛）' : ''}</td><td align="right">${r.seats || '—'}</td></tr>`).join('');
    return `<div style="font-family:system-ui,sans-serif;line-height:1.5">
      <h2 style="margin:0 0 8px">${esc(a.origin)} → ${esc(a.destination)} ${CABIN_ZH[a.cabin]} 有新的獎勵機位</h2>
      <p>${a.start} 到 ${a.end}${a.pax ? `，至少 ${a.pax} 位` : ''}，新出現 ${fresh.length} 筆：</p>
      <table cellpadding="6" style="border-collapse:collapse;border:1px solid #ddd"><tr style="background:#fff4e4"><th>日期</th><th>航線</th><th>計畫</th><th>里程</th><th>航空公司</th><th>座位</th></tr>${tr}</table>
      ${fresh.length > MAX_NEW_IN_MAIL ? `<p>還有 ${fresh.length - MAX_NEW_IN_MAIL} 筆未列出。</p>` : ''}
      <p><a href="${esc(link)}">在機票搜索雷達打開這個搜尋 ↗</a></p>
      <p style="color:#777;font-size:13px">座位資料來自 seats.aero 快取，開票前請到航空公司官網確認。</p>
    </div>`;
  }

  function validate(input) {
    const code = /^[A-Z]{3}(,[A-Z]{3}){0,9}$/;
    const date = /^\d{4}-\d{2}-\d{2}$/;
    const a = {
      origin: String(input.origin || '').toUpperCase().replace(/\s/g, ''),
      destination: String(input.destination || '').toUpperCase().replace(/\s/g, ''),
      start: String(input.start || ''),
      end: String(input.end || input.start || ''),
      cabin: String(input.cabin || 'J').toUpperCase(),
      pax: Math.min(9, Math.max(0, Number(input.pax) || 0)),
      email: String(input.email || '').trim(),
    };
    if (!code.test(a.origin) || !code.test(a.destination)) throw new AlertError('機場代碼格式錯誤');
    if (!date.test(a.start) || !date.test(a.end) || a.end < a.start) throw new AlertError('日期格式錯誤');
    if (a.end < today()) throw new AlertError('日期已經過了');
    if ((new Date(a.end) - new Date(a.start)) / 864e5 > 366) throw new AlertError('日期範圍最多一年');
    if (!CABIN_ZH[a.cabin]) throw new AlertError('艙等錯誤');
    if (a.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email)) throw new AlertError('Email 格式錯誤');
    return a;
  }

  return {
    async list() {
      return (await store.load()).map(({ seen, ...a }) => ({ ...a, seenCount: Object.keys(seen || {}).length }));
    },
    // Save a watch and take a baseline, so later runs only report seats that were not there yet.
    async add(input) {
      const list = await store.load();
      if (list.length >= MAX_ALERTS) throw new AlertError(`最多 ${MAX_ALERTS} 個提醒，請先刪除舊的`);
      const a = { id: crypto.randomUUID().slice(0, 8), ...validate(input), createdAt: new Date().toISOString(), seen: {}, lastRun: null, lastNew: 0 };
      const rows = await check(a);
      for (const r of rows) a.seen[r.id] = r.miles;
      a.lastRun = new Date().toISOString();
      a.lastFound = rows.length;
      list.push(a);
      await store.save(list);
      const { seen, ...pub } = a;
      return { alert: pub, found: rows.length, sample: rows.slice(0, 5) };
    },
    async remove(id) {
      const list = await store.load();
      const next = list.filter((a) => a.id !== id);
      if (next.length === list.length) throw new AlertError('找不到這個提醒', 404);
      await store.save(next);
    },
    // Re-check every watch; email the owner about newly available seats, drop watches whose dates have passed.
    async run() {
      const list = await store.load();
      const report = [];
      const keep = [];
      for (const a of list) {
        if (a.end < today()) { report.push({ id: a.id, expired: true }); continue; }
        keep.push(a);
        try {
          const rows = await check(a);
          const fresh = rows.filter((r) => !(r.id in a.seen));
          for (const r of rows) a.seen[r.id] = r.miles;
          a.lastRun = new Date().toISOString();
          a.lastFound = rows.length;
          a.lastNew = fresh.length;
          a.lastError = null;
          let mailed = false;
          if (fresh.length && a.email && sendEmail) {
            await sendEmail({ to: a.email, subject: `【機票搜索雷達】${a.origin} → ${a.destination} ${CABIN_ZH[a.cabin]} 新增 ${fresh.length} 筆獎勵機位`, html: mailHtml(a, fresh) });
            mailed = true;
          }
          report.push({ id: a.id, found: rows.length, fresh: fresh.length, mailed });
        } catch (e) {
          a.lastRun = new Date().toISOString();
          a.lastError = e.message;
          report.push({ id: a.id, error: e.message });
        }
      }
      await store.save(keep);
      return { checked: keep.length, report };
    },
  };
}

module.exports = { createAlerts, redisStore, memoryStore, resendMailer, AlertError };
