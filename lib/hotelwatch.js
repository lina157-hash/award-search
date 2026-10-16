// 飯店點數房提醒 (round 6, N13): a few hotels, or a whole 查飯店 search, with their check-in dates, re-checked by the
// daily run on rooms.aero. The owner hears (email, Telegram, LINE) when a points night opens, or comes in at or under
// their points-per-night ceiling. rooms.aero has its own quota (1,000 calls a UTC day, lib/rooms.js), so this spends no
// seats.aero calls: one call per watch per check, at most MAX_WATCHES watches, and a daily cap for the runs on top.
const crypto = require('node:crypto');
const { AlertError } = require('./alerts');
const { todayTW, validDate } = require('./day');
const { PROGRAMS } = require('./rooms');

const MAX_WATCHES = 5;
// rooms.aero calls a UTC day (its quota's day) for every run together: the morning run, the evening run retrying what
// failed, and the owner's 立即檢查. Saving a watch (its baseline, one call) is an explicit click and is not counted here.
const DAILY_CAP = 15;
const MAX_RANGE_DAYS = 92; // the same limit as 查飯店's own search
const MAX_LINES = 8; // nights or hotels listed in one chat message (the mail lists up to 40)
const HOTEL_ID = /^[\w-]{1,64}$/;
const CHAIN_ZH = { marriott: '萬豪', hilton: '希爾頓', ihg: '洲際', hyatt: '凱悅', choice: 'Choice', wyndham: '溫德姆', iprefer: 'I Prefer' };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n) => Number(n).toLocaleString('en-US');
const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const utcDay = (t) => new Date(t).toISOString().slice(0, 10);
const listOf = (v) => [...new Set((Array.isArray(v) ? v : String(v ?? '').split(/[\s,，、]+/)).map((x) => String(x).trim().toLowerCase()).filter(Boolean))];

// What one rooms.aero answer holds for a watch: one row per check-in date (one hotel, from /availability) or per hotel
// (a search, each at its cheapest night in the range, from /search), at the cheaper of standard room and suite.
function rowsOf(w, body = {}) {
  const cheaper = (list) => list.filter(([, c]) => c?.points > 0).sort((a, b) => a[1].points - b[1].points)[0];
  const rows = [];
  if (w.kind === 'hotel') {
    for (const d of body.dates || []) {
      const best = cheaper([['standard', d.standard], ['suite', d.suite]]);
      if (best && validDate(d.arrival)) rows.push({ key: d.arrival, date: d.arrival, points: best[1].points, room: best[0] });
    }
  } else {
    for (const h of body.hotels || []) {
      const best = cheaper([['standard', h.standard], ['suite', h.suite]]);
      if (best && h.id && validDate(best[1].date)) rows.push({ key: String(h.id), date: best[1].date, points: best[1].points, room: best[0], name: h.name || '', source: h.source || '' });
    }
  }
  return rows.sort((a, b) => a.points - b.points || a.date.localeCompare(b.date));
}
// A stay the owner wants: any points night, or at most `maxPoints` a night (rooms.aero prices the whole stay).
const fits = (w, points) => points > 0 && (!w.maxPoints || points <= w.maxPoints * w.nights);
// News against what the last check saw (`seen`: key → [points, date], every row, fitting or not): a row that fits now
// and was not there last time (it opened), or was there above the ceiling (it dropped under it).
function newsOf(w, rows, seen = {}) {
  const out = [];
  for (const r of rows) {
    if (!fits(w, r.points)) continue;
    const was = seen[r.key];
    if (!was) out.push({ ...r, why: 'open' });
    else if (!fits(w, was[0])) out.push({ ...r, why: 'drop', before: was[0] });
  }
  return out;
}
// The next `seen`: what this check found. A night that disappears is forgotten, so it counts as opening again when it
// comes back. Until their news is out, the fresh rows keep what was known before, so a failed send is tried again.
function nextSeen(rows, fresh, prev = {}) {
  const next = Object.fromEntries(rows.map((r) => [r.key, [r.points, r.date]]));
  for (const r of fresh) {
    if (prev[r.key]) next[r.key] = prev[r.key];
    else delete next[r.key];
  }
  return next;
}

// `search(query, { until })` asks rooms.aero once: query { kind, hotelId, where, programs, start, end, nights } →
// { dates } (normalizeAvailability) for a hotel, { hotels } (normalizeSearch) for an area. `until`: when it must answer.
// The store holds { watches, usage: { day, used } }. `notify(html)` (optional): Telegram and LINE, true / null / false
// like lib/telegram.js; the run's news goes out as one message (LINE counts every push against a monthly allowance).
// `listLock()` (optional, lib/kv.js waitLock): resolves to a release function, or null when the list stayed busy.
// `perCallMs`: the time allowed for one call; a run does not start a watch that could not answer by `until`.
function createHotelWatch({ store, search, sendEmail = null, notify = null, siteUrl = '', listLock = async () => () => {}, dailyCap = DAILY_CAP, perCallMs = 2500, now: clock = () => Date.now() }) {
  const today = () => todayTW(clock());
  const stamp = () => new Date(clock()).toISOString();
  async function load() {
    const v = (await store.load()) || {};
    const day = utcDay(clock());
    return { watches: Array.isArray(v.watches) ? v.watches : [], usage: v.usage?.day === day ? v.usage : { day, used: 0 } };
  }
  // Read the latest copy, change it, save it, under a short lock; only quick work in between, so a long run never
  // puts back a watch deleted meanwhile or drops one that was added.
  async function mutate(fn) {
    const release = await listLock();
    if (!release) throw new AlertError('飯店提醒清單正在更新，請稍後再試', 409);
    try {
      const d = await load();
      const out = await fn(d);
      await store.save({ watches: d.watches, usage: d.usage });
      return out;
    } finally {
      await release();
    }
  }
  // The check-in dates still ahead: a watch whose window has started is checked from today on.
  const query = (w) => ({ kind: w.kind, hotelId: w.hotelId, where: w.where, programs: w.programs, start: w.start < today() ? today() : w.start, end: w.end, nights: w.nights });
  const check = async (w, opts = {}) => rowsOf(w, await search(query(w), opts));

  const title = (w) => (w.kind === 'hotel' ? w.name : `${w.label || w.where}${w.programs.length && w.programs.length < 4 ? `（${w.programs.map((p) => CHAIN_ZH[p] || p).join('、')}）` : ''}`);
  const when = (w) => `${md(w.start)}${w.end !== w.start ? `–${md(w.end)}` : ''} 入住 ${w.nights} 晚${w.maxPoints ? `，每晚 ${fmt(w.maxPoints)} 點以下` : ''}`;
  const unit = (w) => (w.kind === 'hotel' ? '個入住日' : '家飯店');
  const why = (r) => (r.why === 'drop' ? `原本 ${fmt(r.before)} 點` : '新開出');
  const link = () => `${siteUrl}/#hotels`;
  function chatHtml(w, fresh) {
    const lines = fresh.slice(0, MAX_LINES).map((r) => `${w.kind === 'area' ? `${esc(r.name)} ` : ''}${md(r.date)} 入住 <b>${fmt(r.points)}</b> 點${r.room === 'suite' ? '（套房）' : ''}・${why(r)}`);
    return [`🏨 <b>${esc(title(w))}：${fresh.length} ${unit(w)}有新的點數房</b>`, esc(when(w)), ...lines, ...(fresh.length > MAX_LINES ? [`還有 ${fresh.length - MAX_LINES} 筆`] : []), ...(siteUrl ? [`<a href="${esc(link())}">到查飯店看看</a>`] : [])].join('\n');
  }
  function mailHtml(w, fresh) {
    const area = w.kind === 'area';
    const tr = fresh.slice(0, 40).map((r) => `<tr><td>${r.date}</td>${area ? `<td>${esc(r.name)}</td>` : ''}<td align="right">${fmt(r.points)}${r.room === 'suite' ? '（套房）' : ''}</td><td>${why(r)}</td></tr>`).join('');
    return `<div style="font-family:system-ui,sans-serif;line-height:1.5">
      <h2 style="margin:0 0 8px">${esc(title(w))} 有新的點數房</h2>
      <p>${esc(when(w))}，${fresh.length} ${unit(w)}有新的點數房（點數是 ${w.nights} 晚合計）：</p>
      <table cellpadding="6" style="border-collapse:collapse;border:1px solid #ddd"><tr style="background:#fff4e4"><th>入住日</th>${area ? '<th>飯店</th>' : ''}<th>點數</th><th>說明</th></tr>${tr}</table>
      ${fresh.length > 40 ? `<p>還有 ${fresh.length - 40} 筆未列出。</p>` : ''}
      ${siteUrl ? `<p><a href="${esc(link())}">到機票搜索雷達的「查飯店」查看 ↗</a></p>` : ''}
      <p style="color:#777;font-size:13px">點數房資料來自 rooms.aero 的快取，可能有延遲；訂房前請到飯店官網確認。</p>
    </div>`;
  }

  function validate(input = {}) {
    const text = (v, n) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, n);
    const kind = input.kind === 'area' ? 'area' : 'hotel';
    const w = {
      kind,
      hotelId: kind === 'hotel' ? String(input.hotelId || '') : '',
      name: text(input.name, 120),
      where: text(input.where, 80),
      label: text(input.label, 40),
      source: kind === 'hotel' ? String(input.source || '').toLowerCase() : '',
      programs: kind === 'area' ? listOf(input.programs) : [],
      start: String(input.start || ''),
      end: String(input.end || input.start || ''),
      nights: Number(input.nights || 1),
      maxPoints: Number(input.maxPoints || 0),
      email: String(input.email || '').trim(),
      // Only for the page's 查看 (the search to run again): the form's date and its ± days.
      date: validDate(input.date) ? input.date : '',
      flex: [0, 3, 7, 14].includes(Number(input.flex)) ? Number(input.flex) : 0,
    };
    if (/[<>{}\\]/.test(w.name + w.where + w.label)) throw new AlertError('名稱有不能用的符號');
    if (kind === 'hotel' && (!HOTEL_ID.test(w.hotelId) || !w.name)) throw new AlertError('缺少飯店資料');
    if (kind === 'hotel' && w.source && !PROGRAMS.includes(w.source)) throw new AlertError('飯店集團錯誤');
    if (kind === 'area' && !w.where) throw new AlertError('請輸入城市或地區');
    if (kind === 'area' && (!w.programs.length || !w.programs.every((p) => PROGRAMS.includes(p)))) throw new AlertError('請至少選一個飯店集團');
    if (!validDate(w.start) || !validDate(w.end) || w.end < w.start) throw new AlertError('日期格式錯誤');
    if (w.end < today()) throw new AlertError('入住日期已經過了');
    if ((Date.parse(w.end) - Date.parse(w.start)) / 864e5 > MAX_RANGE_DAYS) throw new AlertError('入住日期範圍最多 3 個月');
    if (!Number.isInteger(w.nights) || w.nights < 1 || w.nights > 5) throw new AlertError('晚數需為 1 到 5');
    if (!Number.isInteger(w.maxPoints) || w.maxPoints < 0 || w.maxPoints > 500000 || (w.maxPoints > 0 && w.maxPoints < 1000)) throw new AlertError('每晚點數上限需為 1,000 到 500,000 點（或留空）');
    if (w.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(w.email)) throw new AlertError('Email 格式錯誤');
    return w;
  }
  // The same watch saved twice would check twice a day and report twice: the conditions that make a watch.
  const SAME = ['kind', 'hotelId', 'where', 'programs', 'start', 'end', 'nights', 'maxPoints', 'email'];
  const same = (a, b) => SAME.every((k) => JSON.stringify(a[k] ?? null) === JSON.stringify(b[k] ?? null));
  const pub = ({ seen, ...w }) => w;
  const bestOf = (w, rows) => { const r = rows.find((x) => fits(w, x.points)); return r ? { points: r.points, date: r.date, ...(r.name ? { name: r.name } : {}) } : null; };
  // The day a watch was last checked with its news out (Taiwan date, like the cron's runs).
  const doneDay = (w) => (w.lastOk ? todayTW(Date.parse(w.lastOk)) : '');

  // The news went out (or had nowhere to go): these rows are old news, and the watch is done for today.
  const markSeen = (a) => mutate((d) => {
    const cur = d.watches.find((x) => x.id === a.id);
    if (cur) {
      for (const r of a.fresh) (cur.seen ||= {})[r.key] = [r.points, r.date];
      cur.lastOk = stamp();
    }
  });

  return {
    max: MAX_WATCHES,
    async list() {
      const { watches, usage } = await load();
      return { watches: watches.map(pub), used: usage.used, cap: dailyCap, max: MAX_WATCHES };
    },
    // Save a watch with a baseline (one rooms.aero call), so later runs report only nights that were not there yet.
    async add(input) {
      const v = validate(input);
      const { watches } = await load();
      const twin = watches.find((x) => same(x, v));
      if (twin) return { watch: pub(twin), found: twin.lastFound ?? 0, duplicate: true };
      if (watches.length >= MAX_WATCHES) throw new AlertError(`最多 ${MAX_WATCHES} 個飯店提醒，請先刪除舊的`);
      const w = { id: crypto.randomUUID().slice(0, 8), ...v, createdAt: stamp() };
      const rows = await check(w);
      w.seen = nextSeen(rows, [], {});
      w.lastRun = w.lastOk = stamp();
      w.lastFound = rows.filter((r) => fits(w, r.points)).length;
      Object.assign(w, { lastNew: 0, lastError: null, best: bestOf(w, rows) });
      await mutate((d) => {
        if (d.watches.length >= MAX_WATCHES) throw new AlertError(`最多 ${MAX_WATCHES} 個飯店提醒，請先刪除舊的`);
        d.watches.push(w);
      });
      return { watch: pub(w), found: w.lastFound };
    },
    async remove(id) {
      await mutate((d) => {
        const next = d.watches.filter((w) => w.id !== id);
        if (next.length === d.watches.length) throw new AlertError('找不到這個提醒', 404);
        d.watches = next;
      });
    },
    // The daily part: check each watch once (oldest check first), report what opened or dropped under the ceiling, drop
    // watches whose dates have passed. `force` false (the cron): skip watches done today. `deadline`: start no new
    // check after it; `until`: every call must have answered by then. Each call is counted before it is made, and the
    // runs of a UTC day stop at `dailyCap` calls. A watch whose check fails is reported and the run goes on.
    async run({ deadline = Infinity, until = Infinity, force = true, lock = async () => () => {} } = {}) {
      const release = await lock();
      if (!release) return { checked: 0, busy: true, report: [] };
      try {
        const report = [];
        const list = await mutate((d) => {
          for (const w of d.watches) if (w.end < today()) report.push({ id: w.id, expired: true });
          d.watches = d.watches.filter((w) => w.end >= today());
          return d.watches;
        });
        const order = [...list].sort((x, y) => String(x.lastRun || '').localeCompare(String(y.lastRun || '')));
        const news = []; // watches with something to tell, for the run's one chat message
        let used = null;
        for (const snap of order) {
          if (!force && doneDay(snap) === today()) { report.push({ id: snap.id, skipped: 'done-today' }); continue; }
          if (clock() > deadline || clock() + perCallMs > until) { report.push({ id: snap.id, skipped: 'time' }); continue; }
          // Count the call before making it, in case the run is cut off mid-call.
          const go = await mutate((d) => {
            if (!d.watches.some((x) => x.id === snap.id)) return 'deleted';
            if (d.usage.used >= dailyCap) return 'cap';
            d.usage.used += 1;
            used = d.usage.used;
            return 'ok';
          });
          if (go === 'deleted') { report.push({ id: snap.id, deleted: true }); continue; }
          if (go === 'cap') { report.push({ id: snap.id, skipped: 'cap' }); continue; }
          let rows;
          try {
            rows = await check(snap, { until });
          } catch (e) {
            await mutate((d) => { const cur = d.watches.find((x) => x.id === snap.id); if (cur) Object.assign(cur, { lastRun: stamp(), lastError: e.message }); }).catch(() => {});
            report.push({ id: snap.id, error: e.message });
            continue;
          }
          const a = await mutate((d) => {
            const cur = d.watches.find((x) => x.id === snap.id);
            if (!cur) return null; // deleted while it was being checked
            const fresh = newsOf(cur, rows, cur.seen);
            cur.seen = nextSeen(rows, fresh, cur.seen);
            const at = stamp();
            Object.assign(cur, { lastRun: at, lastFound: rows.filter((r) => fits(cur, r.points)).length, lastNew: fresh.length, lastError: null, best: bestOf(cur, rows) }, fresh.length ? {} : { lastOk: at });
            return { ...pub(cur), fresh };
          });
          if (!a) { report.push({ id: snap.id, deleted: true }); continue; }
          const out = { id: a.id, found: a.lastFound, fresh: a.fresh.length };
          report.push(out);
          if (!a.fresh.length) continue;
          const mail = await (a.email && sendEmail ? sendEmail({ to: a.email, subject: `【機票搜索雷達】${title(a)} 有新的點數房`, html: mailHtml(a, a.fresh) }).then(() => true, (e) => e) : Promise.resolve(false));
          out.mailed = mail === true;
          if (mail instanceof Error) out.mailError = mail.message;
          news.push({ a, out });
        }
        if (news.length) {
          const chat = notify ? await Promise.resolve().then(() => notify(news.map((n) => chatHtml(n.a, n.a.fresh)).join('\n\n'))).catch(() => false) : null;
          for (const { a, out } of news) {
            if (chat != null) out.chat = chat === true;
            // Told somewhere, or nothing failed (no address, no chat linked): these nights are old news now.
            if (out.mailed || chat === true || (!out.mailError && chat !== false)) await markSeen(a).catch((e) => console.error('hotel watch seen', e.message));
            else out.retry = true;
          }
        }
        return { checked: list.length, ...(used != null ? { used } : {}), cap: dailyCap, report };
      } finally {
        await release();
      }
    },
  };
}

module.exports = { createHotelWatch, rowsOf, newsOf, nextSeen, fits, MAX_WATCHES, DAILY_CAP };
