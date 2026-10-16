// 已開票「便宜了通知我」: award legs the owner already ticketed, toggled on in 我的行程. The daily run checks each one
// once: the same day, route, program and cabin (and the same flights when the leg has their numbers), in one one-day
// search that includes the trips, so a leg costs one seats.aero call a day and the flight check nothing more. When it
// is cheaper than the miles paid, the owner hears once per new low: the saving, and that program's cancel / redeposit
// and change fees from data/fees.json (what the official page says, or 待確認). At most MAX legs.
const crypto = require('node:crypto');
const { todayTW, validDate } = require('./day');
const { AlertError, flightNo, tripFlights } = require('./alerts');

const MAX = 5;
const MIN_SAVE = 1000; // per person: a smaller saving is not worth a cancel fee or the time
const CABIN_ZH = { Y: '經濟艙', W: '豪華經濟艙', J: '商務艙', F: '頭等艙' };
const CABIN_API = { Y: 'economy', W: 'premium', J: 'business', F: 'first' };
const TRIP_CABIN = { economy: 'Y', premium: 'W', business: 'J', first: 'F' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n).toLocaleString('zh-TW');
const md = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;

// The cheapest seats on the booked leg today: the row of that program on that day (`r.date`), in that cabin; with
// flight numbers, only trips that fly every one of them (the same itinerary). Null when none.
function cheapestFor(leg, rows) {
  let best = null;
  const want = leg.flights || [];
  for (const r of rows || []) {
    if (r.source !== leg.program || r.date !== leg.date || r.origin !== leg.from || r.destination !== leg.to) continue;
    const c = r.cabins?.[leg.cabin];
    if (!c?.available || !c.miles) continue;
    if (!want.length) {
      if (!best || c.miles < best.miles) best = { miles: c.miles, seats: c.seats ?? null, flights: '' };
      continue;
    }
    for (const t of r.flightTrips || []) {
      if ((TRIP_CABIN[t.cabin] || t.cabin) !== leg.cabin || !(Number(t.miles) > 0)) continue;
      const fl = tripFlights(t);
      if (!want.every((f) => fl.includes(f))) continue;
      if (!best || Number(t.miles) < best.miles) best = { miles: Number(t.miles), seats: t.seats ?? null, flights: fl.join('、') };
    }
  }
  return best;
}

// News for a leg: cheaper than paid by at least MIN_SAVE a person, and cheaper than the last price told.
const isNews = (leg, now) => Boolean(now) && now.miles <= leg.miles - MIN_SAVE && now.miles < (leg.toldMiles ?? Infinity);

// `fees`: data/fees.json programs. A fee the data does not have reads 待確認.
function feeText(fees, program) {
  const f = fees?.[program];
  if (!f) return '取消／改票費：待確認（看規則庫）';
  const who = f.confidence === 'official' ? '' : '（第三方整理，以官網為準）';
  return `取消退哩：${f.cancel || '待確認'}；改票：${f.change || '待確認'}${f.note ? `（${f.note}）` : ''}${who}`;
}

// `search(params, { until })`: the daily jobs' cached search (server.js alertSearch). `notify(html)`: Telegram and
// LINE side by side (true sent, null nowhere, false failed). `fees`: data/fees.json programs.
function createBooked({ store, search, sendEmail = null, notify = null, fees = {}, programNames = {}, siteUrl = '', listLock = async () => () => {}, today = () => todayTW(), max = MAX, perCallMs = 2000 }) {
  const name = (s) => programNames[s] || s;
  const key = (l) => [l.date, l.from, l.to, l.program, l.cabin, (l.flights || []).join('+')].join('|');

  function validate(input) {
    const up = (v) => String(v || '').toUpperCase().trim();
    const leg = {
      date: String(input.date || ''),
      from: up(input.from),
      to: up(input.to),
      cabin: up(input.cabin),
      program: String(input.program || '').toLowerCase(),
      miles: Math.round(Number(input.miles) || 0),
      pax: Math.min(9, Math.max(1, Math.floor(Number(input.pax) || 1))),
      // What 我的行程 wrote down ("BR16, BR52"); anything that is not a flight number is left out.
      flights: [...new Set(String(input.flights || '').split(/[\s,/·+、]+/).map(flightNo).filter(Boolean))].slice(0, 6),
      email: String(input.email || '').trim(),
    };
    if (!validDate(leg.date)) throw new AlertError('日期格式錯誤');
    if (leg.date < today()) throw new AlertError('這段已經飛過了');
    if (!/^[A-Z]{3}$/.test(leg.from) || !/^[A-Z]{3}$/.test(leg.to)) throw new AlertError('機場代碼格式錯誤');
    if (!CABIN_ZH[leg.cabin]) throw new AlertError('艙等錯誤');
    if (!/^[a-z_]{2,30}$/.test(leg.program)) throw new AlertError('要有哩程計畫才能比價');
    if (!(leg.miles >= 1000 && leg.miles <= 2e6)) throw new AlertError('要有付了幾哩才能比價');
    if (leg.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(leg.email)) throw new AlertError('Email 格式錯誤');
    return leg;
  }

  async function mutate(fn) {
    const release = await listLock();
    if (!release) throw new AlertError('清單正在更新，請稍後再試', 409);
    try {
      const list = (await store.load()) || [];
      const out = await fn(list);
      await store.save(out.list ?? list);
      return out.result;
    } finally {
      await release();
    }
  }

  function message(leg, now) {
    const save = leg.miles - now.miles;
    const fl = leg.flights.length ? leg.flights.join('、') : now.flights;
    const link = `${siteUrl}/?${new URLSearchParams({ o: leg.from, d: leg.to, s: leg.date, e: leg.date, c: leg.cabin })}#search`;
    const head = `${md(leg.date)} ${leg.from}→${leg.to} ${CABIN_ZH[leg.cabin]}（${name(leg.program)}${fl ? `，${fl}` : ''}）`;
    const saving = `現在 ${fmt(now.miles)} 哩，你付了 ${fmt(leg.miles)} 哩：每人少 ${fmt(save)} 哩${leg.pax > 1 ? `，${leg.pax} 人共少 ${fmt(save * leg.pax)} 哩` : ''}`;
    const fee = feeText(fees, leg.program);
    const tip = '先確認新的位子訂得到，再取消原本的票。';
    const chat = [`💸 <b>已開票的機票便宜了</b>`, esc(head), `<b>${esc(saving)}</b>`, esc(fee), esc(tip), ...(siteUrl ? [`<a href="${esc(link)}">打開這一天的搜尋</a>`] : [])].join('\n');
    const html = `<div style="font-family:system-ui,sans-serif;line-height:1.6">
      <h2 style="margin:0 0 8px">已開票的機票便宜了</h2>
      <p>${esc(head)}</p><p><b>${esc(saving)}</b></p><p>${esc(fee)}</p><p>${esc(tip)}</p>
      ${siteUrl ? `<p><a href="${esc(link)}">在機票搜索雷達打開這一天的搜尋 ↗</a></p>` : ''}
      <p style="color:#777;font-size:13px">座位資料來自 seats.aero 快取，改票或退票前請到航空公司官網確認。</p></div>`;
    return { chat, html, subject: `【機票搜索雷達】已開票的 ${leg.from} → ${leg.to} ${md(leg.date)} 便宜了 ${fmt(save)} 哩` };
  }

  // One leg: search, compare, and when it is news, tell. Saved as soon as it is done; a message that failed leaves
  // `toldMiles` as it was, so the next run tries again.
  async function runOne(snap, { until }) {
    let now;
    try {
      const rows = await search({ origin_airport: snap.from, destination_airport: snap.to, start_date: snap.date, end_date: snap.date, cabins: CABIN_API[snap.cabin], include_trips: true }, { until });
      now = cheapestFor(snap, rows);
    } catch (e) {
      await mutate((list) => { const l = list.find((x) => x.id === snap.id); if (l) Object.assign(l, { lastRun: new Date().toISOString(), lastError: e.message }); return {}; });
      return { id: snap.id, error: e.message };
    }
    const out = { id: snap.id, miles: now?.miles ?? null };
    let told = false;
    let failed = false;
    if (isNews(snap, now)) {
      const m = message(snap, now);
      const [mail, chat] = await Promise.allSettled([
        snap.email && sendEmail ? sendEmail({ to: snap.email, subject: m.subject, html: m.html }).then(() => true) : null,
        notify ? notify(m.chat) : null,
      ]);
      told = (mail.status === 'fulfilled' && mail.value === true) || (chat.status === 'fulfilled' && chat.value === true);
      failed = mail.status === 'rejected' || (chat.status === 'fulfilled' && chat.value === false) || chat.status === 'rejected';
      Object.assign(out, { cheaper: true, told });
      if (!told && failed) out.retry = true;
    }
    await mutate((list) => {
      const l = list.find((x) => x.id === snap.id);
      if (!l) return {};
      const at = new Date().toISOString();
      Object.assign(l, { lastRun: at, lastMiles: now?.miles ?? null, lastSeats: now?.seats ?? null, lastError: null });
      // Told, or nowhere to tell (no mail address, nothing linked): this price is now known, and the leg is done for
      // today. A message that failed everywhere is tried again by the evening run.
      if (out.cheaper && (told || !failed)) l.toldMiles = now.miles;
      if (!out.retry) l.lastOk = at;
      return {};
    });
    return out;
  }

  return {
    max,
    async list() {
      const t = today();
      return ((await store.load()) || []).filter((l) => l.date >= t);
    },
    // The same leg twice is one watch; past MAX the owner is asked to turn one off first. No search here: the first
    // check is the next daily run.
    async add(input) {
      const v = validate(input);
      return mutate((list) => {
        const t = today();
        const live = list.filter((l) => l.date >= t);
        const twin = live.find((l) => key(l) === key(v));
        if (twin) return { list: live, result: { leg: twin, duplicate: true } };
        if (live.length >= max) throw new AlertError(`已開票追蹤最多 ${max} 段，請先關掉一段`);
        const leg = { id: crypto.randomUUID().slice(0, 8), ...v, createdAt: new Date().toISOString(), lastRun: null };
        return { list: [...live, leg], result: { leg } };
      });
    },
    async remove(id) {
      await mutate((list) => {
        const next = list.filter((l) => l.id !== id);
        if (next.length === list.length) throw new AlertError('找不到這段', 404);
        return { list: next };
      });
    },
    // The daily part: legs already flown are dropped, the rest checked oldest first, none started after `deadline`
    // or when its call could not answer by `until`. `force` false (the cron): a leg checked today is left alone, so
    // the evening run spends nothing on it.
    async run({ deadline = Infinity, until = Infinity, force = true, lock = async () => () => {} } = {}) {
      const release = await lock();
      if (!release) return { busy: true, checked: 0, report: [] };
      try {
        const t = today();
        const all = await mutate((list) => { const keep = list.filter((l) => l.date >= t); return { list: keep, result: keep }; });
        const report = [];
        for (const snap of [...all].sort((x, y) => String(x.lastRun || '').localeCompare(String(y.lastRun || '')))) {
          if (!force && snap.lastOk && todayTW(Date.parse(snap.lastOk)) === t) { report.push({ id: snap.id, skipped: 'done-today' }); continue; }
          if (Date.now() > deadline || Date.now() + perCallMs > until) { report.push({ id: snap.id, skipped: 'time' }); continue; }
          try { report.push(await runOne(snap, { until })); } catch (e) { report.push({ id: snap.id, error: e.message }); }
        }
        return { checked: all.length, report };
      } finally {
        await release();
      }
    },
  };
}

module.exports = { createBooked, cheapestFor, isNews, feeText, MAX, MIN_SAVE };
