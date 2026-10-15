// Award-seat alerts: saved searches that a scheduled run re-checks, emailing whatever is newly available.
// Storage is Upstash Redis over REST (set up from Vercel's Storage tab), email goes through Resend; both optional.
const crypto = require('node:crypto');
const { todayTW, validDate } = require('./day');
const ALLIANCES = new Map(require('../data/alliances.json').alliances.map((a) => [a.id, { name: a.name, members: new Set(a.members || []) }]));

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
    let res;
    try {
      res = await fetchImpl(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(args), signal: AbortSignal.timeout(5000) });
    } catch { throw new AlertError('提醒資料庫連線失敗', 504); }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) {
      console.error('redis store', key, res.status, body.error);
      throw new AlertError(`提醒資料庫回應錯誤（${res.status}）`, 502);
    }
    return body.result;
  }
  return {
    async load() { const v = await cmd('GET', key); return v ? JSON.parse(v) : []; },
    async save(list) { await cmd('SET', key, JSON.stringify(list)); },
  };
}

// Hands out copies, like Redis does, so code that keeps a loaded list around cannot change the stored one by accident.
function memoryStore(initial = []) {
  let json = JSON.stringify(initial);
  return { async load() { return JSON.parse(json); }, async save(next) { json = JSON.stringify(next); } };
}

// Resend: one HTML email per run that found something new. `text` (a plain-text copy) and `headers` (List-Unsubscribe)
// are passed along when given; `send.batch(list)` sends up to 100 mails in one call (今日好康每日信, lib/dealsub.js).
function resendMailer({ apiKey, from, fetchImpl = fetch }) {
  const sender = from || '機票搜索雷達 <onboarding@resend.dev>';
  const mail = ({ to, subject, html, text, headers }) => ({ from: sender, to: [to], subject, html, ...(text ? { text } : {}), ...(headers ? { headers } : {}) });
  async function post(path, body) {
    const res = await fetchImpl(`https://api.resend.com${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error('resend', res.status, (await res.text().catch(() => '')).slice(0, 300));
      throw new AlertError(`寄信失敗（${res.status}）`, 502);
    }
  }
  const send = (m) => post('/emails', mail(m));
  send.batch = (list) => post('/emails/batch', list.map(mail));
  return send;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n).toLocaleString('zh-TW');
const CABIN_ZH = { Y: '經濟艙', W: '豪華經濟艙', J: '商務艙', F: '頭等艙' };
// seats.aero's `cabins` filter takes names, not the one-letter codes the alert stores.
const CABIN_API = { Y: 'economy', W: 'premium', J: 'business', F: 'first' };
// A watch may cover several cabins: stored as their letters in this order ("YJ"); older watches hold one letter.
const CABIN_ORDER = 'YWJF';
const cabinsOf = (a) => [...CABIN_ORDER].filter((c) => String(a.cabin || '').includes(c));
const cabinZh = (a) => cabinsOf(a).map((c) => CABIN_ZH[c]).join('、');
const today = () => todayTW();

// `notify(html)` (optional, lib/telegram.js): a short Telegram message next to the email; resolves true when sent,
// null when there is nowhere to send it, false when sending failed (the news is then kept for the next run).
// `digest(htmls)` (optional, LINE): the run's news in one message after the run, so a monthly push allowance is spent
// once per run, not once per watch; resolves like `notify`.
// A list given as an array or as "a, b c" text, without blanks or repeats.
const listOf = (v) => [...new Set((Array.isArray(v) ? v : String(v ?? '').split(/[\s,，、]+/)).map((x) => String(x).trim()).filter(Boolean))];

// `listLock()` (optional, lib/kv.js waitLock): resolves to a release function, or null when the list stayed busy.
// `pagesFor(a)`: the most result pages one search of the watch may take (each page is one seats.aero call), and
// `perCallMs` the time allowed for one call: a run does not start a watch whose worst case cannot finish by `until`.
function createAlerts({ store, search, sendEmail, siteUrl = '', programNames = {}, notify = null, digest = null, listLock = async () => () => {}, pagesFor = () => 1, perCallMs = 2500 }) {
  const name = (s) => programNames[s] || s;

  // What a watch currently matches: one row per date × route × program, keyed by seats.aero's availability ID.
  // One search per cabin (each sorted cheapest first for that cabin). A one-cabin watch keys its rows by the bare
  // availability ID as it always did; a several-cabin watch adds the cabin, so each cabin is reported on its own.
  // `until`: the time by which every call must have answered (passed on to `search`).
  async function check(a, { until } = {}) {
    const cabins = cabinsOf(a);
    const rows = [];
    for (const cb of cabins) {
      const results = await search({ origin_airport: a.origin, destination_airport: a.destination, start_date: a.start, end_date: a.end, cabins: CABIN_API[cb] }, { until });
      for (const r of results) {
        const c = r.cabins[cb];
        if (!c?.available || !c.miles) continue;
        if (a.pax && c.seats > 0 && c.seats < a.pax) continue;
        if (!wanted(a, r.source, c.airlines, c.direct)) continue;
        rows.push({ id: cabins.length > 1 ? `${r.id}:${cb}` : r.id, cabin: cb, date: r.date, origin: r.origin, destination: r.destination, source: r.source, miles: c.miles, seats: c.seats, airlines: c.airlines, direct: c.direct });
      }
    }
    rows.sort((x, y) => x.date.localeCompare(y.date) || CABIN_ORDER.indexOf(x.cabin) - CABIN_ORDER.indexOf(y.cabin) || x.miles - y.miles);
    return rows;
  }

  // Only the chosen programs, and only flights where every operating airline is one of the chosen ones, or with
  // `anyLeg` (connections welcome) where at least one is. Empty lists mean any. `direct`: nonstop only. `alliance`:
  // every operating airline a member of that alliance (data/alliances.json). Watches saved before these two existed
  // have neither, so they report what they always did.
  const wanted = (a, source, airlines, direct) => {
    if (a.sources?.length && !a.sources.includes(source)) return false;
    if (a.direct && !direct) return false;
    const legs = String(airlines || '').split(/,\s*/).filter(Boolean);
    const al = a.alliance && ALLIANCES.get(a.alliance);
    if (al && !(legs.length > 0 && legs.every((x) => al.members.has(x)))) return false;
    if (!a.airlines?.length) return true;
    return a.anyLeg ? legs.some((x) => a.airlines.includes(x)) : legs.length > 0 && legs.every((x) => a.airlines.includes(x));
  };
  const filterText = (a) => [a.sources?.length ? `只看 ${a.sources.map(name).join('、')}` : '', a.alliance && ALLIANCES.has(a.alliance) ? ALLIANCES.get(a.alliance).name : '', a.airlines?.length ? `航空公司 ${a.airlines.join('、')}${a.anyLeg ? '（含轉機）' : ''}` : '', a.direct ? '只要直飛' : ''].filter(Boolean).join('，');
  // The link opens the best cabin among the news (a Y+J watch that found business seats opens business).
  const topCabin = (a, fresh = []) => [...CABIN_ORDER].reverse().find((c) => fresh.some((r) => r.cabin === c)) || cabinsOf(a)[0] || 'J';
  const searchLink = (a, cabin = cabinsOf(a)[0] || 'J') => `${siteUrl}/?${new URLSearchParams({ o: a.origin, d: a.destination, s: a.start, e: a.end, c: cabin, ...(a.pax ? { n: a.pax } : {}), ...(a.alliance ? { al: a.alliance } : {}), ...(a.direct ? { direct: '1' } : {}) })}#search`;
  // Telegram: the same news in a few lines (Telegram HTML takes <b> and <a>).
  function chatHtml(a, fresh) {
    const many = cabinsOf(a).length > 1;
    const lines = fresh.slice(0, 8).map((r) => `${r.date.slice(5)} ${many ? `${CABIN_ZH[r.cabin]} ` : ''}${esc(r.origin)}→${esc(r.destination)} ${esc(name(r.source))} <b>${fmt(r.miles)}</b> 哩 ${esc(r.airlines)}${r.direct ? ' 直飛' : ''}${r.seats ? ` ${r.seats} 位` : ''}`);
    return [`🔔 <b>${esc(a.origin)} → ${esc(a.destination)} ${cabinZh(a)} 新增 ${fresh.length} 筆獎勵機位</b>`, ...(filterText(a) ? [esc(filterText(a))] : []), ...lines, ...(fresh.length > 8 ? [`還有 ${fresh.length - 8} 筆`] : []), ...(siteUrl ? [`<a href="${esc(searchLink(a, topCabin(a, fresh)))}">打開這個搜尋</a>`] : [])].join('\n');
  }

  function mailHtml(a, fresh) {
    const link = searchLink(a, topCabin(a, fresh));
    const many = cabinsOf(a).length > 1;
    const tr = fresh.slice(0, MAX_NEW_IN_MAIL).map((r) => `<tr><td>${r.date}</td>${many ? `<td>${CABIN_ZH[r.cabin]}</td>` : ''}<td>${esc(r.origin)} → ${esc(r.destination)}</td><td>${esc(name(r.source))}</td><td align="right">${fmt(r.miles)}</td><td>${esc(r.airlines)}${r.direct ? '（直飛）' : ''}</td><td align="right">${r.seats || '—'}</td></tr>`).join('');
    return `<div style="font-family:system-ui,sans-serif;line-height:1.5">
      <h2 style="margin:0 0 8px">${esc(a.origin)} → ${esc(a.destination)} ${cabinZh(a)} 有新的獎勵機位</h2>
      <p>${a.start} 到 ${a.end}${a.pax ? `，至少 ${a.pax} 位` : ''}${filterText(a) ? `，${esc(filterText(a))}` : ''}，新出現 ${fresh.length} 筆：</p>
      <table cellpadding="6" style="border-collapse:collapse;border:1px solid #ddd"><tr style="background:#fff4e4"><th>日期</th>${many ? '<th>艙等</th>' : ''}<th>航線</th><th>計畫</th><th>里程</th><th>航空公司</th><th>座位</th></tr>${tr}</table>
      ${fresh.length > MAX_NEW_IN_MAIL ? `<p>還有 ${fresh.length - MAX_NEW_IN_MAIL} 筆未列出。</p>` : ''}
      <p><a href="${esc(link)}">在機票搜索雷達打開這個搜尋 ↗</a></p>
      <p style="color:#777;font-size:13px">座位資料來自 seats.aero 快取，開票前請到航空公司官網確認。</p>
    </div>`;
  }

  function validate(input) {
    const code = /^[A-Z]{3}(,[A-Z]{3}){0,9}$/;
    const a = {
      origin: String(input.origin || '').toUpperCase().replace(/\s/g, ''),
      destination: String(input.destination || '').toUpperCase().replace(/\s/g, ''),
      start: String(input.start || ''),
      end: String(input.end || input.start || ''),
      // `cabins` (["Y","J"]) or `cabin` ("J", "YJ" or "Y,J").
      cabin: [...CABIN_ORDER].filter((c) => (Array.isArray(input.cabins) ? input.cabins.join('') : String(input.cabins ?? input.cabin ?? 'J')).toUpperCase().includes(c)).join(''),
      pax: Math.min(9, Math.max(0, Number(input.pax) || 0)),
      email: String(input.email || '').trim(),
      sources: listOf(input.sources).map((x) => x.toLowerCase()),
      airlines: listOf(input.airlines).map((x) => x.toUpperCase()),
      anyLeg: Boolean(input.anyLeg),
      direct: input.direct === true || input.direct === 1 || input.direct === '1' || input.direct === 'true',
      alliance: String(input.alliance || '').toLowerCase(),
    };
    if (a.alliance && !ALLIANCES.has(a.alliance)) throw new AlertError('航空聯盟錯誤');
    if (a.sources.length > 40 || !a.sources.every((x) => /^[a-z_]{2,30}$/.test(x))) throw new AlertError('哩程計畫格式錯誤');
    if (a.airlines.length > 20 || !a.airlines.every((x) => /^[A-Z0-9]{2}$/.test(x))) throw new AlertError('航空公司代碼要是兩碼，例如 CI');
    if (!code.test(a.origin) || !code.test(a.destination)) throw new AlertError('機場代碼格式錯誤');
    if (!validDate(a.start) || !validDate(a.end) || a.end < a.start) throw new AlertError('日期格式錯誤');
    if (a.end < today()) throw new AlertError('日期已經過了');
    if ((new Date(a.end) - new Date(a.start)) / 864e5 > 366) throw new AlertError('日期範圍最多一年');
    if (!a.cabin) throw new AlertError('請至少選一個艙等');
    if (a.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email)) throw new AlertError('Email 格式錯誤');
    return a;
  }

  // Read the latest list, change it, save it, under a short lock. Only quick work happens in between, so a long run
  // never puts back a watch that was deleted meanwhile or drops one that was added, and two edits never overwrite each other.
  async function mutate(fn) {
    const release = await listLock();
    if (!release) throw new AlertError('提醒清單正在更新，請稍後再試', 409);
    try {
      const list = await store.load();
      const out = await fn(list);
      await store.save(out.list ?? list);
      return out.result;
    } finally {
      await release();
    }
  }
  // The day a watch was last checked with its news delivered (`lastOk`); `lastRun` is the last attempt, failed or
  // not. Watches saved before `lastOk` existed go by `lastRun`.
  const doneDay = (a) => { const t = 'lastOk' in a ? a.lastOk : a.lastRun; return t ? todayTW(Date.parse(t)) : ''; };
  // Changed by an edit (which takes a new baseline) after `snap` was read.
  const edited = (cur, snap) => cur.updatedAt !== snap.updatedAt || cur.cabin !== snap.cabin;
  // Seen seats: availability ID → [miles, date] (older entries hold the miles only). A seat whose date has passed is
  // forgotten, so the list does not grow for as long as the watch lives.
  const remember = (seen, r) => { seen[r.id] = [r.miles, r.date]; };
  function prune(seen) {
    const t = today();
    for (const [k, v] of Object.entries(seen)) if (Array.isArray(v) && v[1] < t) delete seen[k];
  }

  return {
    async list() {
      return (await store.load()).map(({ seen, ...a }) => ({ ...a, seenCount: Object.keys(seen || {}).length }));
    },
    // Save a watch and take a baseline, so later runs only report seats that were not there yet.
    async add(input) {
      const a = { id: crypto.randomUUID().slice(0, 8), ...validate(input), createdAt: new Date().toISOString(), seen: {}, lastRun: null, lastNew: 0 };
      if ((await store.load()).length >= MAX_ALERTS) throw new AlertError(`最多 ${MAX_ALERTS} 個提醒，請先刪除舊的`);
      const rows = await check(a);
      for (const r of rows) remember(a.seen, r);
      a.lastRun = a.lastOk = new Date().toISOString();
      a.lastFound = rows.length;
      await mutate((list) => {
        if (list.length >= MAX_ALERTS) throw new AlertError(`最多 ${MAX_ALERTS} 個提醒，請先刪除舊的`);
        list.push(a);
        return {};
      });
      const { seen, ...pub } = a;
      return { alert: pub, found: rows.length, sample: rows.slice(0, 5) };
    },
    // Change a watch's conditions in place. The id and where it reports to (email; Telegram and LINE are site-wide)
    // stay; the baseline is taken again, so it behaves like a new watch: seats there now are not reported, only later ones.
    async update(id, input = {}) {
      const cur = (await store.load()).find((x) => x.id === id);
      if (!cur) throw new AlertError('找不到這個提醒', 404);
      const { seen, ...was } = cur;
      const a = { ...was, ...validate({ ...was, ...input, email: cur.email }), id, updatedAt: new Date().toISOString(), seen: {}, lastNew: 0, lastError: null };
      const rows = await check(a);
      for (const r of rows) remember(a.seen, r);
      a.lastRun = a.lastOk = new Date().toISOString();
      a.lastFound = rows.length;
      await mutate((list) => {
        const i = list.findIndex((x) => x.id === id);
        if (i < 0) throw new AlertError('找不到這個提醒', 404); // deleted meanwhile
        list[i] = a;
        return {};
      });
      const { seen: s2, ...pub } = a;
      return { alert: pub, found: rows.length, sample: rows.slice(0, 5) };
    },
    async remove(id) {
      await mutate((list) => {
        const next = list.filter((a) => a.id !== id);
        if (next.length === list.length) throw new AlertError('找不到這個提醒', 404);
        return { list: next };
      });
    },
    // Re-check every watch; email the owner about newly available seats, drop watches whose dates have passed.
    // Each watch is saved as soon as it is checked; new seats are marked seen once the news went out (or when there
    // is nowhere to send it), so a mail or message that failed is tried again on the next run, the same morning's
    // catch-up run included. `deadline`: start nothing new after it (the rest waits for the next run, oldest first).
    // `until`: every seats.aero call must have answered by then, and a watch whose worst case would not fit is left
    // for the next run. `force` false (the cron): skip watches done today. A watch whose check or save fails is
    // reported and the run goes on with the next one.
    async run({ deadline = Infinity, until = Infinity, force = true, lock = async () => () => {} } = {}) {
      const release = await lock();
      if (!release) return { checked: 0, busy: true, report: [] };
      try {
        const report = [];
        const all = await mutate((list) => {
          const keep = list.filter((a) => a.end >= today());
          for (const a of list) if (a.end < today()) report.push({ id: a.id, expired: true });
          return { list: keep, result: keep };
        });
        const order = [...all].sort((x, y) => String(x.lastRun || '').localeCompare(String(y.lastRun || '')));
        const chats = []; // the run's news, for the digest
        const pending = []; // news that neither the mail nor Telegram delivered: the digest decides
        for (const snap of order) {
          if (!force && doneDay(snap) === today()) { report.push({ id: snap.id, skipped: 'done-today' }); continue; }
          if (Date.now() > deadline) { report.push({ id: snap.id, skipped: 'time' }); continue; }
          if (Date.now() + cabinsOf(snap).length * pagesFor(snap) * perCallMs > until) { report.push({ id: snap.id, skipped: 'time' }); continue; }
          try {
            report.push(await runOne(snap, { until, chats, pending }));
          } catch (e) {
            console.error('alerts run', snap.id, e.message);
            report.push({ id: snap.id, error: e.message });
          }
        }
        const out = { checked: all.length, report };
        if (digest && chats.length) {
          const sent = await Promise.resolve().then(() => digest(chats)).catch(() => false);
          out.digest = sent;
          for (const p of pending) {
            if (sent === true || (sent == null && !p.failed)) await markSeen(p.a).catch((e) => console.error('alerts seen', e.message));
            else p.out.retry = true;
          }
        }
        return out;
      } finally {
        await release();
      }
    },
  };

  // The news went out (or had nowhere to go): these seats are old news, and the watch is done for today.
  function markSeen(a) {
    return mutate((list) => {
      const cur = list.find((x) => x.id === a.id);
      if (cur && !edited(cur, a)) {
        for (const r of a.fresh) remember((cur.seen ||= {}), r);
        cur.lastOk = new Date().toISOString();
      }
      return {};
    });
  }

  async function runOne(snap, { until, chats, pending }) {
    let rows;
    try {
      rows = await check(snap, { until });
    } catch (e) {
      await mutate((list) => {
        const a = list.find((x) => x.id === snap.id);
        if (a && !edited(a, snap)) Object.assign(a, { lastRun: new Date().toISOString(), lastError: e.message });
        return {};
      });
      return { id: snap.id, error: e.message };
    }
    const a = await mutate((list) => {
      const cur = list.find((x) => x.id === snap.id);
      if (!cur) return {}; // deleted while it was being checked
      // Edited while it was being checked: these rows answer the old conditions; the next run checks the new ones.
      if (edited(cur, snap)) return { result: { edited: true } };
      cur.seen ||= {};
      prune(cur.seen);
      const fresh = rows.filter((r) => !(r.id in cur.seen));
      for (const r of rows) if (r.id in cur.seen) remember(cur.seen, r);
      const at = new Date().toISOString();
      Object.assign(cur, { lastRun: at, lastFound: rows.length, lastNew: fresh.length, lastError: null }, fresh.length ? {} : { lastOk: at });
      return { result: { ...cur, fresh } };
    });
    if (!a) return { id: snap.id, deleted: true };
    if (a.edited) return { id: snap.id, skipped: 'edited' };
    // Email and Telegram go out side by side; neither one's failure holds up or repeats the other.
    const [mail, chat] = await Promise.allSettled([
      a.fresh.length && a.email && sendEmail ? sendEmail({ to: a.email, subject: `【機票搜索雷達】${a.origin} → ${a.destination} ${cabinZh(a)} 新增 ${a.fresh.length} 筆獎勵機位`, html: mailHtml(a, a.fresh) }).then(() => true) : false,
      a.fresh.length && notify ? notify(chatHtml(a, a.fresh)) : null,
    ]);
    const mailed = mail.status === 'fulfilled' && mail.value === true;
    const telegram = chat.status === 'fulfilled' && chat.value === true;
    const failed = mail.status === 'rejected' || chat.status === 'rejected' || chat.value === false;
    const out = { id: a.id, found: rows.length, fresh: a.fresh.length, mailed, ...(notify && a.fresh.length ? { telegram } : {}), ...(mail.status === 'rejected' ? { mailError: mail.reason.message } : {}) };
    if (!a.fresh.length) return out;
    if (digest) chats.push(chatHtml(a, a.fresh));
    if (!mailed && !telegram && digest) { pending.push({ a, out, failed }); return out; }
    // Delivered somewhere, or nothing failed (no mail address, Telegram not linked): these seats are now old news.
    if (!mailed && !telegram && failed) out.retry = true;
    else await markSeen(a).catch((e) => console.error('alerts seen', e.message));
    return out;
  }
}

module.exports = { createAlerts, redisStore, memoryStore, resendMailer, AlertError };
