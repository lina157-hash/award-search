// New transfer bonuses, buy-miles sales and award sales (哩程票特惠) for the site owner (N4a, round 9 #9): the daily run
// compares data/promos.json (refreshed weekly) with the owner's wallet profile — bank point programs and miles programs,
// saved with the passcode — and sends one Telegram message (and mail, if an address was given) per promo that touches
// it, with each bank's last safe transfer day. Ids already announced (or running when the notice was switched on) are
// kept in Redis, so every promo is announced once. Spends no paid quota.
const P6 = require('../public/points6.js');
const { todayTW } = require('./day');

const KEY = 'promo:v1:watch';
const AWARD_HEAD = '新的哩程票特惠碰到你的計畫';
const MAX_SEEN = 300;
const ID = /^[\w-]{1,40}$/;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const md = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
const ids = (v, max = 40) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && ID.test(x)))].slice(0, max) : []);

// `promos` (promos.json list), `sources` (points.json calc.sources), `holds` (holds.json), `notify(html)` (Telegram),
// `sendEmail({ to, subject, html })` or null, `log` for the demo.
function createPromoWatch({ kv, promos = [], sources = [], holds = null, notify = null, sendEmail = null, siteUrl = '', log = null, now = () => Date.now() }) {
  const get = async () => { const v = await kv.get(KEY).catch(() => null); return v && typeof v === 'object' ? v : null; };
  const mine = (rec) => sources.filter((s) => (rec.banks || []).includes(s.id));
  // An award sale: its travel and booking windows, and whether the owner holds those miles or a bank that moves in.
  function awardLine(p, rec, today) {
    const holds = (rec.programs || []).includes(p.program);
    const banks = [...new Set(mine(rec).filter((s) => P6.p6RateInto(s, p.program, today)).map((s) => s.bank))];
    const why = holds ? '・你有這個計畫的哩程' : banks.length ? `・你的 ${banks.join('、')} 點數可以轉入` : '';
    return { p, text: `${p.title}（少 ${p.discountPct}%），${md(p.travelFrom)}–${md(p.travelTo)} 搭乘、${md(p.end)} 前開票${why}` };
  }
  // The lines of one notice: title, bonus, end date, and which of the owner's banks can join by when.
  function lines(list, rec, today) {
    return list.map((p) => {
      if (p.type === 'award') return awardLine(p, rec, today);
      const rows = P6.promoDeadlines(p, mine(rec), holds, today);
      const seen = new Set();
      const banks = rows.filter((r) => !seen.has(r.source.bank) && seen.add(r.source.bank))
        .map((r) => `${r.source.bank}${!r.known ? '（入帳時間不明，早點轉）' : r.days < 0 ? '（已來不及）' : r.byEnd ? '' : `（最晚 ${md(r.date)} 轉）`}`);
      const bonus = p.rebate ? `回饋 ${p.bonusPct}% 點數` : p.bonusPct ? `+${p.bonusPct}%` : '';
      return { p, text: `${p.title}${bonus ? ` ${bonus}` : ''}，到 ${md(p.end)}${p.registration === true ? '・要先登記' : ''}${banks.length ? `・你的 ${banks.join('、')}` : ''}` };
    });
  }
  return {
    // The owner switches the notice on (with the wallet's bank and miles programs) or off. What is already running
    // and touches the wallet counts as seen: only promos that appear later are announced.
    async save(body) {
      if (!body?.on) { await kv.del(KEY); return { ok: true, on: false }; }
      const email = String(body.email || '').trim().toLowerCase();
      if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw Object.assign(new Error('Email 格式錯誤'), { status: 400 });
      const rec = { on: true, email, banks: ids(body.banks), programs: ids(body.programs), savedAt: new Date(now()).toISOString() };
      const old = await get();
      const today = todayTW(now());
      const current = P6.newPromos(promos, mine(rec), rec.programs, [], today).map((p) => p.id);
      rec.seen = [...new Set([...(old?.seen || []), ...promos.filter((p) => p.end < today).map((p) => p.id), ...current])].slice(-MAX_SEEN);
      await kv.set(KEY, rec);
      return { ok: true, on: true, email, current: current.length };
    },
    async status() {
      const rec = await get();
      return rec?.on ? { on: true, email: rec.email || '', banks: rec.banks.length, programs: rec.programs.length, seen: (rec.seen || []).length } : { on: false };
    },
    // The daily part: announce what is new, then remember it. Nothing is marked seen unless a message went out.
    async run({ lock = async () => () => {} } = {}) {
      const rec = await get();
      if (!rec?.on) return { on: false };
      const release = await lock();
      if (!release) return { busy: true };
      try {
        const today = todayTW(now());
        const fresh = P6.newPromos(promos, mine(rec), rec.programs || [], rec.seen || [], today);
        if (!fresh.length) return { on: true, fresh: 0 };
        const items = lines(fresh, rec, today);
        const link = siteUrl ? `${siteUrl}/#points` : '';
        // Award sales get their own heading; transfer bonuses and buy-miles sales keep theirs.
        const award = items.filter((x) => x.p.type === 'award');
        const other = items.filter((x) => x.p.type !== 'award');
        const otherHead = other.every((x) => x.p.type === 'buy') ? '買哩促銷' : '轉點加贈';
        const block = (head, list) => `${head}\n${list.map((x) => `• ${esc(x.text)}`).join('\n')}`;
        const chat = [other.length ? block(`🎁 <b>新的${otherHead}</b>`, other) : '', award.length ? block(`✈️ <b>${AWARD_HEAD}</b>`, award) : ''].filter(Boolean).join('\n\n') + (link ? `\n${esc(link)}` : '');
        const li = (x) => `<li>${esc(x.text)}${x.p.sources?.[0]?.url ? `（<a href="${esc(x.p.sources[0].url)}">活動頁</a>）` : ''}</li>`;
        const html = `<div style="font-family:system-ui,sans-serif;line-height:1.6">${other.length ? `<p>有新的轉點加贈或買哩促銷碰到你「我的點數」裡的銀行或哩程：</p><ul>${other.map(li).join('')}</ul>` : ''}
          ${award.length ? `<p>${AWARD_HEAD}（你有這些計畫的哩程，或有銀行點數可以轉入）：</p><ul>${award.map(li).join('')}</ul>` : ''}
          ${link ? `<p><a href="${esc(link)}">打開點數換算器</a></p>` : ''}<p style="color:#777;font-size:13px">機票搜索雷達・每個活動只通知一次，可在「我的點數」關閉。</p></div>`;
        const subject = `【機票搜索雷達】${other.length ? `新的${otherHead}` : AWARD_HEAD}：${fresh[0].title}${fresh.length > 1 ? ` 等 ${fresh.length} 個` : ''}`;
        const [t, m] = await Promise.allSettled([
          notify ? notify(chat) : false,
          rec.email && sendEmail ? sendEmail({ to: rec.email, subject, html }).then(() => true) : rec.email && log ? (log(`[示範] 寄給 ${rec.email}：${subject}`), true) : false,
        ]);
        const out = { on: true, fresh: fresh.length, telegram: t.status === 'fulfilled' && t.value === true, mailed: m.status === 'fulfilled' && m.value === true };
        if (out.telegram || out.mailed) await kv.set(KEY, { ...rec, seen: [...new Set([...(rec.seen || []), ...fresh.map((p) => p.id)])].slice(-MAX_SEEN) });
        else if (t.status === 'rejected' || m.status === 'rejected' || t.value === false) out.error = t.reason?.message || m.reason?.message || 'Telegram 傳送失敗';
        else out.noChannel = true; // Telegram not linked and no address: tried again tomorrow, not a failure
        return out;
      } finally {
        await release();
      }
    },
  };
}

module.exports = { createPromoWatch };
