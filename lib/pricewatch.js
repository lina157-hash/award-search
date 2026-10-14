// Cash-fare price tracking: a few saved Google Flights searches that the daily run re-prices, emailing when the fare drops.
// Every check spends one search credit (RapidAPI first, SerpApi only as a fallback), so checks are spaced out by how far away
// the trip is, capped per month, and never allowed to eat into the SerpApi credits the owner keeps for their own searches.
const crypto = require('node:crypto');
const { AlertError } = require('./alerts');
const { todayTW, validDate } = require('./day');

const MAX_WATCHES = 3;
const MONTHLY_CAP = 30; // credits per calendar month for all watches together
const RESERVE = 150; // stop checking when the SerpApi account has fewer searches left than this
// Days between checks, by days left until departure.
const intervalDays = (daysOut) => (daysOut > 60 ? 7 : daysOut > 14 ? 3 : 1);
const MAX_HISTORY = 60;
const CABIN_ZH = { Y: '經濟艙', W: '豪華經濟艙', J: '商務艙', F: '頭等艙' };
// Ignore wobbles: a drop counts when it is at least this much below the last price we told the owner about.
const MIN_DROP_TWD = 100;
const MIN_DROP_PCT = 0.01;

const fmt = (n) => Number(n).toLocaleString('en-US');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const flightKey = (o) => (o.segments || []).map((s) => (s.flightNumber || '').replace(/\s/g, '')).join('+');

// `search(watch)` returns normalized cash results ({ options: [{ price, segments }] }) for the watch's query.
// `quota()` (optional) resolves to the SerpApi searches left this month, or null when unknown.
// The store holds { watches, usage: { month, used } }.
// `notify(html)` (optional, lib/telegram.js): a short Telegram message next to the email.
// `listLock()` (optional, lib/kv.js waitLock): resolves to a release function, or null when the list stayed busy.
function createPriceWatch({ store, search, sendEmail, siteUrl = '', notify = null, listLock = async () => () => {}, quota = async () => null, monthlyCap = MONTHLY_CAP, reserve = RESERVE, now: clock = () => Date.now() }) {
  const today = () => todayTW(clock());
  const month = () => today().slice(0, 7);
  const daysUntil = (date) => Math.round((Date.parse(date) - Date.parse(today())) / 864e5);
  async function load() {
    const v = await store.load();
    const data = Array.isArray(v) ? { watches: v } : v || {};
    const usage = data.usage?.month === month() ? data.usage : { month: month(), used: 0 };
    return { watches: data.watches || [], usage };
  }
  const save = (watches, usage) => store.save({ watches, usage });
  // Read the latest copy, change it, save it, under a short lock; only quick work in between, so adds and deletes
  // made during a run stay and two edits never overwrite each other.
  async function mutate(fn) {
    const release = await listLock();
    if (!release) throw new AlertError('降價追蹤清單正在更新，請稍後再試', 409);
    try {
      const d = await load();
      const out = await fn(d);
      await save(d.watches, d.usage);
      return out;
    } finally {
      await release();
    }
  }
  // Due when the gap for this trip's distance has passed; a few hours of slack keeps a daily cron on schedule.
  const due = (w) => !w.lastChecked || clock() - Date.parse(w.lastChecked) >= intervalDays(daysUntil(w.depart)) * 864e5 - 6 * 3600e3;

  // Cheapest fare overall, and the price of the flights the owner picked when they are still on sale.
  async function price(w) {
    const body = await search(w);
    const fares = (body.options || []).filter((o) => o.price);
    if (!fares.length) return { lowest: null, picked: null };
    const lowest = fares.reduce((a, b) => (a.price <= b.price ? a : b));
    const picked = w.flights ? fares.find((o) => flightKey(o) === w.flights) : null;
    return { lowest: lowest.price, lowestFlights: flightKey(lowest), picked: picked ? picked.price : null };
  }

  function summary(w) {
    return `${w.origin} → ${w.destination} ${w.depart}${w.ret ? ` – ${w.ret} 來回` : ' 單程'} ${CABIN_ZH[w.cabin]}${w.adults > 1 ? ` ${w.adults} 人` : ''}`;
  }

  function mailHtml(w, now, before) {
    const link = `${siteUrl}/#cash`;
    return `<div style="font-family:system-ui,sans-serif;line-height:1.5">
      <h2 style="margin:0 0 8px">${esc(summary(w))} 降價了</h2>
      <p>${w.flights ? '你追蹤的航班' : '最便宜的票價'}現在 <b style="font-size:1.2em">NT$${fmt(now)}</b>，比上次通知的 NT$${fmt(before)} 便宜 NT$${fmt(before - now)}。</p>
      ${w.flights && w.lastLowest && w.lastLowest < now ? `<p>同一天最便宜的是 NT$${fmt(w.lastLowest)}（不同航班）。</p>` : ''}
      <p><a href="${esc(link)}">到機票搜索雷達的「查現金票」查看 ↗</a></p>
      <p style="color:#777;font-size:13px">票價來自 Google 航班，每天早上檢查一次；訂票前請以航空公司或旅行社網站為準。</p>
    </div>`;
  }

  function chatHtml(w, now, before) {
    return [`📉 <b>${esc(summary(w))} 降到 NT$${fmt(now)}</b>`, `${w.flights ? '你追蹤的航班' : '最便宜的票價'}比上次通知的 NT$${fmt(before)} 便宜 NT$${fmt(before - now)}。`, ...(siteUrl ? [`<a href="${esc(`${siteUrl}/#cash`)}">到「查現金票」查看</a>`] : [])].join('\n');
  }

  function validate(input) {
    const code = /^[A-Z]{3}(,[A-Z]{3}){0,6}$/;
    const w = {
      origin: String(input.origin || '').toUpperCase().replace(/\s/g, ''),
      destination: String(input.destination || '').toUpperCase().replace(/\s/g, ''),
      depart: String(input.depart || ''),
      ret: String(input.ret || ''),
      cabin: String(input.cabin || 'Y').toUpperCase(),
      adults: Number(input.adults || 1),
      stops: Number(input.stops || 0),
      flights: String(input.flights || '').replace(/[^\w+]/g, '').slice(0, 80),
      email: String(input.email || '').trim(),
    };
    if (!code.test(w.origin) || !code.test(w.destination)) throw new AlertError('機場代碼格式錯誤');
    if (!validDate(w.depart) || (w.ret && !validDate(w.ret))) throw new AlertError('日期格式錯誤');
    if (w.depart < today()) throw new AlertError('出發日期已經過了');
    if (w.ret && w.ret < w.depart) throw new AlertError('回程日期不可早於出發日期');
    if (!CABIN_ZH[w.cabin]) throw new AlertError('艙等錯誤');
    if (!Number.isInteger(w.adults) || w.adults < 1 || w.adults > 9) throw new AlertError('人數需為 1 到 9');
    if (![0, 1, 2, 3].includes(w.stops)) throw new AlertError('轉機參數錯誤');
    if (w.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(w.email)) throw new AlertError('Email 格式錯誤');
    return w;
  }

  const pub = ({ notified, ...w }) => w;

  return {
    max: MAX_WATCHES,
    async list() {
      const { watches, usage } = await load();
      return { watches: watches.map((w) => ({ ...pub(w), everyDays: intervalDays(daysUntil(w.depart)) })), used: usage.used, cap: monthlyCap };
    },
    // Save a watch and price it once, so the first email only goes out after a real drop.
    async add(input) {
      const w = { id: crypto.randomUUID().slice(0, 8), ...validate(input), createdAt: new Date(clock()).toISOString() };
      if ((await load()).watches.length >= MAX_WATCHES) throw new AlertError(`最多同時追蹤 ${MAX_WATCHES} 組票價，請先刪除舊的`);
      // The browser just showed this fare, so start from it instead of spending a credit to look it up again.
      const shown = Number(input.price);
      const seen = Number.isInteger(shown) && shown > 0 && shown < 1e8 ? shown : null;
      let now = seen;
      let lowest = Number.isInteger(Number(input.lowest)) && input.lowest > 0 && input.lowest < 1e8 ? Number(input.lowest) : seen;
      let spent = 0;
      if (now == null) {
        const p = await price(w);
        spent = 1;
        // The picked flights, or nothing yet when they are not on sale: the first price seen later becomes the baseline.
        now = w.flights ? p.picked : p.lowest;
        lowest = p.lowest;
      }
      w.lastChecked = new Date(clock()).toISOString();
      Object.assign(w, { lastRun: seen == null ? w.lastChecked : null, lastPrice: now, lastLowest: lowest, startPrice: now, notified: now, history: now ? [[today(), now]] : [] });
      await mutate((d) => {
        d.usage.used += spent;
        if (d.watches.length >= MAX_WATCHES) throw new AlertError(`最多同時追蹤 ${MAX_WATCHES} 組票價，請先刪除舊的`);
        d.watches.push(w);
      });
      return { watch: pub(w) };
    },
    async remove(id) {
      await mutate((d) => {
        const next = d.watches.filter((w) => w.id !== id);
        if (next.length === d.watches.length) throw new AlertError('找不到這個追蹤', 404);
        d.watches = next;
      });
    },
    // Re-price every watch that is due; email when it fell below the last price the owner heard about. Past trips are
    // dropped. Each watch is saved right after its check, so a run that hits the time limit loses no work; the new low
    // becomes the reference only once the news went out, so a mail that failed is tried again on the next check. `deadline`: start no new check after it.
    async run({ deadline = Infinity, lock = async () => () => {} } = {}) {
      const release = await lock();
      if (!release) return { checked: 0, busy: true, report: [] };
      try {
        const report = [];
        // A trip that leaves today (Taiwan time) is past helping; drop it with the old ones.
        const { watches: list, usage } = await mutate((d) => {
          for (const w of d.watches) if (w.depart <= today()) report.push({ id: w.id, expired: true });
          d.watches = d.watches.filter((w) => w.depart > today());
          return d;
        });
        let used = usage.used;
        // Only ask SerpApi how many searches are left when something is actually due (the account lookup is free).
        let left;
        const touch = (id, fn) => mutate((d) => { const x = d.watches.find((y) => y.id === id); return x ? fn(x, d) : null; });
        for (const snap of list) {
          if (!due(snap)) { report.push({ id: snap.id, skipped: 'not-due' }); continue; }
          if (clock() > deadline) { report.push({ id: snap.id, skipped: 'time' }); continue; }
          if (used >= monthlyCap) { await touch(snap.id, (x) => { x.paused = 'cap'; return true; }); report.push({ id: snap.id, skipped: 'cap' }); continue; }
          if (left === undefined) left = await quota().catch(() => null);
          if (left != null && left < reserve) { await touch(snap.id, (x) => { x.paused = 'reserve'; return true; }); report.push({ id: snap.id, skipped: 'reserve', left }); continue; }
          // Count the credit and the check time before spending it, in case the run is cut off mid-call.
          const ok = await touch(snap.id, (x, d) => { x.paused = null; x.lastChecked = new Date(clock()).toISOString(); d.usage.used += 1; used = d.usage.used; return true; });
          if (!ok) { report.push({ id: snap.id, deleted: true }); continue; }
          if (left != null) left -= 1;
          let p;
          try {
            p = await price(snap);
          } catch (e) {
            await touch(snap.id, (x) => { x.lastRun = new Date(clock()).toISOString(); x.lastError = e.message; return true; });
            report.push({ id: snap.id, error: e.message });
            continue;
          }
          const r = await touch(snap.id, (w) => {
            w.lastRun = new Date(clock()).toISOString();
            w.lastError = null;
            w.lastLowest = p.lowest;
            w.pickedGone = Boolean(w.flights && p.picked == null);
            // With picked flights, only their own price counts: when they are missing (sold out, not in this answer),
            // another airline's cheaper fare is not a drop and must not move the reference price.
            const now = w.flights ? p.picked : p.lowest;
            if (now == null) return { price: null, ...(w.pickedGone ? { pickedGone: true, lowest: p.lowest } : {}) };
            w.lastPrice = now;
            w.history = [...(w.history || []).filter(([d]) => d !== today()), [today(), now]].slice(-MAX_HISTORY);
            const ref = w.notified ?? w.startPrice;
            // First price ever seen (the flights were not on sale when the watch started): that is the baseline.
            if (ref == null) { w.notified = now; w.lastDrop = 0; return { price: now, dropped: false }; }
            const dropped = ref - now >= Math.max(MIN_DROP_TWD, ref * MIN_DROP_PCT);
            w.lastDrop = dropped ? ref - now : 0;
            return { price: now, dropped, ref, watch: { ...w } };
          });
          if (!r) { report.push({ id: snap.id, deleted: true }); continue; }
          const { ref, watch, ...out } = r;
          // Email and Telegram go out side by side, neither blocking the other.
          const [mail, chat] = await Promise.allSettled([
            out.dropped && watch.email && sendEmail ? sendEmail({ to: watch.email, subject: `【機票搜索雷達】${watch.origin} → ${watch.destination} 降到 NT$${fmt(out.price)}`, html: mailHtml(watch, out.price, ref) }).then(() => true) : false,
            out.dropped && notify ? notify(chatHtml(watch, out.price, ref)) : false,
          ]);
          if (mail.status === 'rejected') out.mailError = mail.reason.message;
          if (out.dropped && notify) out.telegram = chat.status === 'fulfilled' && chat.value === true;
          if (out.dropped) {
            const sent = (mail.status === 'fulfilled' && mail.value === true) || (chat.status === 'fulfilled' && chat.value === true);
            // Remember the new low (so the next mail needs another drop) once it was told, or when nothing failed.
            if (sent || (mail.status !== 'rejected' && chat.status !== 'rejected')) {
              await touch(snap.id, (w) => { if (w.notified == null || out.price < w.notified) w.notified = out.price; return true; }).catch((e) => console.error('watch notified', e.message));
            } else out.retry = true;
          }
          report.push({ id: snap.id, ...out, ...(out.price != null ? { mailed: mail.status === 'fulfilled' && mail.value === true } : {}) });
        }
        return { checked: list.length, used, cap: monthlyCap, report };
      } finally {
        await release();
      }
    },
  };
}

module.exports = { createPriceWatch, flightKey, intervalDays, MAX_WATCHES, MONTHLY_CAP, RESERVE };
