// 本週變動 for the site owner (round 9 #21): the first daily run of each week (Monday 08:10 Taiwan time, or the next
// run if that one failed) sends what changed in the data files over the last 7 days and what ends in the next 14 —
// promos started and ended, rule and alliance changes with their official source, bank rates running out — by
// Telegram and, when the owner gave an address for the promo notice, by mail. Built by public/prog9.js, the same
// builder as 規則庫's 最近變動. Spends no paid quota; WEEKLY_DIGEST=off turns it off.
const P9 = require('../public/prog9.js');
const { todayTW } = require('./day');

const KEY = 'weekly:v1:last';

// Monday-based ISO week of a YYYY-MM-DD: '2026-W42'. The week turns on Monday, so this is the day-of-week check.
function isoWeek(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day); // the Thursday of this week decides the year
  const jan1 = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d - jan1) / 864e5 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// `src()` returns the builder's input (data files), `emailOf()` the owner's address or '', `notify(html)` is
// telegram.notify (true sent, null not linked, false failed), `sendEmail({ to, subject, html })` or null.
function createWeekly({ kv, src, notify = null, sendEmail = null, emailOf = async () => '', siteUrl = '', log = null, now = () => Date.now(), off = false }) {
  return {
    async run({ lock = async () => () => {}, force = false } = {}) {
      if (off) return { off: true };
      const today = todayTW(now());
      const week = isoWeek(today);
      const last = await kv.get(KEY).catch(() => null);
      if (!force && last?.week === week) return { already: week };
      const release = await lock();
      if (!release) return { busy: true };
      try {
        const d = P9.weeklyDigest(src(), today, siteUrl);
        const at = new Date(now()).toISOString();
        if (!d) { await kv.set(KEY, { week, at, items: 0 }, { ex: 40 * 86400 }); return { week, items: 0 }; }
        const to = await Promise.resolve(emailOf()).catch(() => '');
        const [t, m] = await Promise.allSettled([
          notify ? notify(d.chat) : null,
          to && sendEmail ? sendEmail({ to, subject: d.subject, html: d.html }).then(() => true) : to && log ? (log(`[示範] 寄給 ${to}：${d.subject}\n${d.text}`), true) : false,
        ]);
        const out = { week, items: d.count, telegram: t.status === 'fulfilled' && t.value === true, mailed: m.status === 'fulfilled' && m.value === true };
        if (out.telegram || out.mailed) await kv.set(KEY, { week, at, items: d.count }, { ex: 40 * 86400 });
        else if (t.status === 'rejected' || m.status === 'rejected' || t.value === false) out.error = t.reason?.message || m.reason?.message || 'Telegram 傳送失敗';
        else {
          out.noChannel = true; // Telegram not linked and no address: tried again on the next run, not a failure
          if (log) log(`[示範] 本週變動\n${d.text}`);
        }
        return out;
      } finally {
        await release();
      }
    },
  };
}

module.exports = { createWeekly, isoWeek, KEY };
