// Cash-fare price tracking: a few saved Google Flights searches that the daily run re-prices, emailing when the fare drops.
// Every check spends one SerpApi credit, so checks are spaced out by how far away the trip is, capped per month,
// and skipped altogether when the SerpApi account is running low, leaving the credits for the owner's own searches.
const crypto = require('node:crypto');
const { AlertError } = require('./alerts');

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
function createPriceWatch({ store, search, sendEmail, siteUrl = '', quota = async () => null, monthlyCap = MONTHLY_CAP, reserve = RESERVE, now: clock = () => Date.now() }) {
  const today = () => new Date(clock()).toISOString().slice(0, 10);
  const month = () => today().slice(0, 7);
  const daysUntil = (date) => Math.round((Date.parse(date) - Date.parse(today())) / 864e5);
  async function load() {
    const v = await store.load();
    const data = Array.isArray(v) ? { watches: v } : v || {};
    const usage = data.usage?.month === month() ? data.usage : { month: month(), used: 0 };
    return { watches: data.watches || [], usage };
  }
  const save = (watches, usage) => store.save({ watches, usage });
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

  function validate(input) {
    const code = /^[A-Z]{3}(,[A-Z]{3}){0,6}$/;
    const date = /^\d{4}-\d{2}-\d{2}$/;
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
    if (!date.test(w.depart) || (w.ret && !date.test(w.ret))) throw new AlertError('日期格式錯誤');
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
      const { watches: list, usage } = await load();
      if (list.length >= MAX_WATCHES) throw new AlertError(`最多同時追蹤 ${MAX_WATCHES} 組票價，請先刪除舊的`);
      const w = { id: crypto.randomUUID().slice(0, 8), ...validate(input), createdAt: new Date(clock()).toISOString() };
      // The browser just showed this fare, so start from it instead of spending a credit to look it up again.
      const shown = Number(input.price);
      const seen = Number.isInteger(shown) && shown > 0 && shown < 1e8 ? shown : null;
      let now = seen;
      let lowest = Number.isInteger(Number(input.lowest)) && input.lowest > 0 && input.lowest < 1e8 ? Number(input.lowest) : seen;
      if (now == null) {
        const p = await price(w);
        usage.used += 1;
        now = p.picked ?? p.lowest;
        lowest = p.lowest;
      }
      w.lastChecked = new Date(clock()).toISOString();
      Object.assign(w, { lastRun: seen == null ? w.lastChecked : null, lastPrice: now, lastLowest: lowest, startPrice: now, notified: now, history: now ? [[today(), now]] : [] });
      list.push(w);
      await save(list, usage);
      return { watch: pub(w) };
    },
    async remove(id) {
      const { watches: list, usage } = await load();
      const next = list.filter((w) => w.id !== id);
      if (next.length === list.length) throw new AlertError('找不到這個追蹤', 404);
      await save(next, usage);
    },
    // Re-price every watch; email when it fell below the last price the owner heard about. Past trips are dropped.
    async run() {
      const { watches: list, usage } = await load();
      const report = [];
      const keep = [];
      // Only ask SerpApi how many searches are left when something is actually due (the account lookup is free).
      let left;
      for (const w of list) {
        if (w.depart < today()) { report.push({ id: w.id, expired: true }); continue; }
        keep.push(w);
        if (!due(w)) { report.push({ id: w.id, skipped: 'not-due' }); continue; }
        if (usage.used >= monthlyCap) { w.paused = 'cap'; report.push({ id: w.id, skipped: 'cap' }); continue; }
        if (left === undefined) left = await quota().catch(() => null);
        if (left != null && left < reserve) { w.paused = 'reserve'; report.push({ id: w.id, skipped: 'reserve', left }); continue; }
        w.paused = null;
        try {
          usage.used += 1;
          if (left != null) left -= 1;
          w.lastChecked = new Date(clock()).toISOString();
          const p = await price(w);
          const now = p.picked ?? p.lowest;
          w.lastRun = new Date(clock()).toISOString();
          w.lastError = null;
          w.lastLowest = p.lowest;
          w.pickedGone = Boolean(w.flights && p.picked == null);
          if (now == null) { report.push({ id: w.id, price: null }); continue; }
          w.lastPrice = now;
          w.history = [...(w.history || []).filter(([d]) => d !== today()), [today(), now]].slice(-MAX_HISTORY);
          const ref = w.notified ?? w.startPrice ?? now;
          const dropped = ref - now >= Math.max(MIN_DROP_TWD, ref * MIN_DROP_PCT);
          let mailed = false;
          if (dropped && w.email && sendEmail) {
            await sendEmail({ to: w.email, subject: `【機票搜索雷達】${w.origin} → ${w.destination} 降到 NT$${fmt(now)}`, html: mailHtml(w, now, ref) });
            mailed = true;
          }
          // Remember the new low so the next mail needs another drop; a rise resets nothing.
          if (dropped) w.notified = now;
          w.lastDrop = dropped ? ref - now : 0;
          report.push({ id: w.id, price: now, dropped, mailed });
        } catch (e) {
          w.lastRun = new Date(clock()).toISOString();
          w.lastError = e.message;
          report.push({ id: w.id, error: e.message });
        }
      }
      await save(keep, usage);
      return { checked: keep.length, used: usage.used, cap: monthlyCap, report };
    },
  };
}

module.exports = { createPriceWatch, flightKey, intervalDays, MAX_WATCHES, MONTHLY_CAP, RESERVE };
