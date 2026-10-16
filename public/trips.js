// 我的行程 round 6: each leg's booking status (規劃中／已保留／候補中／已開票) and its key dates (hold expiry, ticket validity,
// free cancellation, online check-in), reminders through the miles-expiry mail (lib/expiry.js), a whole-trip .ics,
// 貼上確認信 (owner, AI), the separate-ticket connection check, the passport validity check (also in 出發前小提醒),
// where a cash fare's miles can go, and the 規則庫 card on credit-card benefits for award tickets.
// Rules come from data/trips.json and data/holds.json (official pages, cited there). Classic script loaded after
// features.js (plan, savePlan…) and tripinfo.js (countryZh, VISA_TYPE). Leg fields other code may read:
// status ('held' | 'waitlist' | 'ticketed', none = 規劃中; the names points6.js and notify.js read too), holdUntil, ticketedOn, backup, dep, arr, arrDays, pnr, tk.
// Saving a status fires `plan:status` on document ({ leg, index, from, to }). The date math up to 「page」 needs no DOM
// and is exported for test/trips.test.js.
/* global $, $$, esc, fmt, mmdd, dowOf, data, loadMore, loadAirports, AP, AL, isoDate, store, toast, api, cashApi, plan, savePlan, renderPlan, programName, programKeyOf, CABIN_LABEL, countryZh, VISA_TYPE, acct, signedIn, joinedHere, alertCfg, nl, nlOwnerHere, addLegs, ALERT_EMAIL_KEY, PLAN_KEY, cash */

const TRIP_STATUS = { held: '已保留', waitlist: '候補中', ticketed: '已開票' }; // no status = 規劃中
const tpPad = (n) => String(n).padStart(2, '0');
const tpAddDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const tpDays = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);
const tpMd = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
const tpMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const tpDur = (m) => `${Math.floor(m / 60)} 小時${m % 60 ? ` ${m % 60} 分` : ''}`;
// A day past the end of the shorter month lands on its last day (lib/expiry.js does the same).
function tpAddMonths(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last))).toISOString().slice(0, 10);
}
// `hours` before a local departure. Without a time, noon stands in (whole days are exact either way).
function tpBefore(date, time, hours) {
  const iso = new Date(Date.parse(`${date}T${time || '12:00'}:00Z`) - hours * 3600e3).toISOString();
  return { date: iso.slice(0, 10), time: time ? iso.slice(11, 16) : null };
}
const tpCarrier = (flights) => (/^([A-Z0-9]{2})\s?\d/.exec(flights || '') || [])[1] || '';
const US_CC = new Set(['US', 'GU', 'PR', 'MP', 'VI', 'AS']);
// Two legs on one ticket: the same booking reference, or saved together (a cash round trip, 「和上一段同一張票」).
const sameTicket = (a, b) => Boolean((a.pnr && a.pnr === b.pnr) || (a.tk && a.tk === b.tk));
// A held or ticketed leg kept as the fallback for a waitlisted one on the same route within 3 days.
const isBackup = (l, legs) => (l.status === 'held' || l.status === 'ticketed') && legs.some((w) => w !== l && w.status === 'waitlist' && w.from === l.from && w.to === l.to && Math.abs(tpDays(w.date, l.date)) <= 3);

// Key dates of one leg: [{ kind, date, time, label, text, steps, warn, verify, src }]. `steps` (days before the date)
// marks the ones worth a reminder. ctx: { trips, holds, ap(code), keyOf(program) }.
function legKeyDates(l, legs = [], ctx = {}) {
  const T = ctx.trips || {};
  const key = l.k === 'a' && l.program ? (ctx.keyOf || ((x) => x))(l.program) : '';
  const rule = key ? T.tickets?.[key] : null;
  const src = rule?.sources || [];
  const out = [];
  if (l.status === 'held') {
    const h = key ? ctx.holds?.programs?.[key] : null;
    if (l.holdUntil) out.push({ kind: 'hold', date: l.holdUntil, label: '保留到期', text: '期限前要開票，不要的話放掉', steps: [1, 0], warn: true });
    else {
      const how = h?.hold === true ? `通常可保留約 ${h.days ? `${h.days} 天` : '幾天'}${h.how ? `（${h.how}）` : ''}；` : h?.hold === false ? `這個計畫通常不能先保留${h.note ? `（${h.note}）` : ''}；` : '';
      out.push({ kind: 'hold', date: null, label: '保留期限', text: `${how}保留時記下期限填進來，到期前提醒你`, verify: h?.confidence === 'verify' });
    }
  }
  if (l.status === 'waitlist') out.push({ kind: 'wait', date: l.date, label: '候補中', text: l.backup ? `備案：${l.backup}` : '還沒填備案', steps: [14, 3] });
  const backup = isBackup(l, legs);
  if (rule?.cancel && (l.status === 'ticketed' || backup)) {
    const c = rule.cancel;
    const at = tpBefore(l.date, l.dep, c.before || 0);
    out.push({ kind: 'cancel', date: at.date, time: at.time, label: backup ? '備案的取消期限' : c.before ? `起飛前 ${c.before} 小時前可取消` : '起飛前可取消', text: c.text, verify: Boolean(c.verify), steps: backup && c.backup ? [3, 0] : null, src });
  }
  if (l.status === 'ticketed' && rule?.validMonths) {
    const date = l.ticketedOn ? tpAddMonths(l.ticketedOn, rule.validMonths) : null;
    out.push({ kind: 'valid', date, label: '機票效期到', text: rule.validText || `開票日起 ${rule.validMonths} 個月內有效`, warn: Boolean(date && date < l.date), src });
  }
  const ci = l.status === 'ticketed' ? T.checkin?.[tpCarrier(l.flights)] : null;
  if (ci) {
    const us = [l.from, l.to].some((c) => US_CC.has(ctx.ap?.(c)?.country));
    const hours = us && ci.usHours ? ci.usHours : ci.hours;
    const at = tpBefore(l.date, l.dep, hours);
    out.push({ kind: 'checkin', date: at.date, time: at.time, label: '開放線上報到', text: `起飛前 ${hours} 小時開放${us && ci.usHours ? '（美國航線）' : ''}`, steps: [0], src: [{ label: ci.label, url: ci.url }] });
  }
  return out;
}

const NOTE_NAME = { hold: '保留到期，記得開票或放掉', wait: '還在候補，記得決定要不要用備案', cancel: '備案的取消期限', checkin: '開放線上報到' };
// The reminders the daily run mails (lib/expiry.js cleanNotes checks them again): future dates only, at most 30.
function tripNotes(p, ctx = {}) {
  const today = ctx.today || '0000-00-00';
  const out = [];
  const legs = p?.legs || [];
  for (const l of legs) {
    for (const d of legKeyDates(l, legs, ctx)) {
      if (!d.steps || !d.date || d.date < today) continue;
      const fl = (l.flights || '').split(/[,/·]/)[0].replace(/\s+/g, '');
      out.push({ key: `${d.kind}-${l.from}${l.to}-${l.date}`, name: `${fl ? `${fl} ` : ''}${l.from}→${l.to}（${tpMd(l.date)}）${NOTE_NAME[d.kind]}${d.time && d.kind === 'checkin' ? ` ${d.time} 起` : ''}`.slice(0, 80), date: d.date, steps: d.steps });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date)).slice(0, 30);
}

// The whole trip as an .ics: one all-day event per leg (times in the title: the airports' time zones aren't known
// here) and one per dated key date, those with a reminder ringing at 9:00 that day.
function tripIcs(p, ctx = {}) {
  const stamp = ctx.stamp || `${(ctx.today || '2026-01-01').replace(/-/g, '')}T000000Z`;
  const txt = (s) => String(s).replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\r?\n/g, '\\n');
  const enc = new TextEncoder();
  // Lines longer than 75 octets continue on the next line after one space (RFC 5545 3.1).
  const fold = (line) => {
    const out = [];
    let cur = '';
    let n = 0;
    for (const ch of line) {
      const b = enc.encode(ch).length;
      if (n + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; n = 0; }
      cur += ch;
      n += b;
    }
    out.push(cur);
    return out.join('\r\n ');
  };
  const day = (d) => d.replace(/-/g, '');
  const ev = (uid, date, summary, desc, alarm) => ['BEGIN:VEVENT', `UID:${uid}@award-search`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${day(date)}`, `DTEND;VALUE=DATE:${day(tpAddDays(date, 1))}`,
    `SUMMARY:${txt(summary)}`, ...(desc ? [`DESCRIPTION:${txt(desc)}`] : []),
    ...(alarm ? ['BEGIN:VALARM', 'TRIGGER:PT9H', 'ACTION:DISPLAY', `DESCRIPTION:${txt(summary)}`, 'END:VALARM'] : []), 'END:VEVENT'];
  const legs = p?.legs || [];
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//award-search//trip//ZH', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${txt(p?.name || '我的行程')}`];
  legs.forEach((l, i) => {
    const time = l.dep ? ` ${l.dep}${l.arr ? `–${l.arr}${l.arrDays ? `(+${l.arrDays})` : ''}` : ''}` : '';
    const what = l.k === 'a' ? `${l.miles ? `${(l.miles * (l.pax || 1)).toLocaleString('en-US')} 哩` : '哩程票'}${l.program && ctx.name ? `・${ctx.name(l.program)}` : ''}` : `現金票${l.price ? `・NT$${l.price.toLocaleString('en-US')}` : ''}`;
    const desc = [TRIP_STATUS[l.status] || '規劃中', l.status === 'held' && l.holdUntil ? `保留到 ${l.holdUntil}` : '', l.ticketedOn ? `開票日 ${l.ticketedOn}` : '', l.backup ? `備案：${l.backup}` : '', what, l.pnr ? `訂位代號 ${l.pnr}` : '', '時間為當地時間'].filter(Boolean).join('\n');
    lines.push(...ev(`leg-${i}-${l.from}${l.to}-${day(l.date)}`, l.date, `✈ ${l.flights ? `${l.flights} ` : ''}${l.from}→${l.to}${time}`, desc, false));
    for (const d of legKeyDates(l, legs, ctx)) {
      if (!d.date || d.kind === 'wait' || (d.kind === 'cancel' && !d.steps)) continue; // the cancel rule only matters for a backup
      lines.push(...ev(`${d.kind}-${l.from}${l.to}-${day(l.date)}`, d.date, `${d.label}${d.time ? ` ${d.time}` : ''}：${l.from}→${l.to}（${tpMd(l.date)}）`, d.text || '', Boolean(d.steps)));
    }
  });
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

const tpMiles = (a, b) => {
  const r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.sqrt(h));
};
// Separate tickets that connect: two legs in a row, the second leaving the airport (or a nearby one) the first lands at
// within a day, on different tickets. Then the second airline won't wait or rebook when the first is late, and the bags
// come off at the connection. Returns [{ i, gap (minutes or null), intl, country, lines: [{ level, text }] }].
function tripConnections(legs, ctx = {}) {
  const ap = ctx.ap || (() => null);
  const cc = (c) => ap(c)?.country || '';
  const out = [];
  for (let i = 0; i + 1 < legs.length; i++) {
    const a = legs[i];
    const b = legs[i + 1];
    if (sameTicket(a, b)) continue;
    const A = ap(a.to);
    const B = ap(b.from);
    const sameAp = a.to === b.from;
    if (!sameAp && !(A?.lat != null && B?.lat != null && tpMiles(A, B) < 100)) continue;
    const dayGap = tpDays(tpAddDays(a.date, a.arrDays || 0), b.date);
    const gap = a.arr && b.dep ? dayGap * 1440 + tpMin(b.dep) - tpMin(a.arr) : null;
    if (gap != null ? gap >= 1440 : dayGap !== 0) continue; // a stopover, or the next day with no times to tell
    const intl = cc(a.from) !== cc(a.to) || cc(b.from) !== cc(b.to);
    const country = cc(b.from);
    const lines = [];
    if (gap != null && gap < 0) lines.push({ level: 'bad', text: '下一段在這段抵達前就起飛了，請檢查日期和時間' });
    else if (gap != null && intl && gap < 180) lines.push({ level: 'bad', text: `分開開票只留 ${tpDur(gap)}轉機，國際線建議至少 3 小時：前一段延誤時，下一段的航空公司不會等你，也不會免費幫你改票` });
    else if (gap != null) lines.push({ level: 'ok', text: `分開開票，轉機 ${tpDur(gap)}` });
    else lines.push({ level: 'warn', text: '分開開票、同一天轉機：填上這段的抵達時間和下一段的起飛時間，就能檢查轉機時間夠不夠' });
    if (!sameAp) lines.push({ level: 'warn', text: `要從 ${a.to} 換到 ${b.from} 機場，路上的時間要另外留` });
    lines.push({ level: 'info', text: '兩張票的行李通常不能直掛：要先入境、領行李，再到下一家航空公司重新報到托運' });
    if (country && country !== 'TW') {
      const v = ctx.visa?.(country);
      const name = ctx.countryName ? ctx.countryName(country) : country;
      const say = { free: ['ok', `入境${name}免簽${v?.days ? ` ${v.days} 天` : ''}`], arrival: ['warn', `入境${name}要辦落地簽`], evisa: ['warn', `入境${name}要先辦電子簽證`], eta: ['warn', `入境${name}要先上網申請入境許可`], required: ['bad', `入境${name}需要簽證：沒有簽證就不能出關領行李、重新報到`] }[v?.type];
      if (say) lines.push({ level: say[0], text: `${say[1]}${v.note ? `（${v.note}）` : ''}` });
      else if (v === null) lines.push({ level: 'warn', text: `${name}的入境規定待確認，請到領事事務局查` });
    }
    out.push({ i, gap, intl, country, lines });
  }
  return out;
}

// One country's passport rule (data/trips.json passport.countries) in words.
function passportRuleText(r) {
  if (!r) return '';
  const base = !r.months ? '護照效期要涵蓋停留期間' : r.from === 'entry' ? `入境時護照要還有 ${r.months} 個月以上效期` : `${r.schengen ? '離開申根區' : '離境'}時護照要還有 ${r.months} 個月以上效期`;
  return `${base}${r.plusDays ? `，且停留期滿後還要剩 ${r.plusDays} 天` : ''}`;
}
// Is the passport good for this stay? rule: { months, from: 'entry' | 'exit', plusDays } or null (not known).
// level: 'bad' (expires during the trip or before the date the country asks for), 'ok', 'unknown' (no rule; only the
// stay itself is checked). renew: inside the 9 months before expiry when the trip starts (or today).
function passportCheck({ expiry, rule = null, entry, exit, today, renewMonths = 9 } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry || '') || !entry) return null;
  const end = exit && exit > entry ? exit : entry;
  let need = end;
  if (rule) {
    need = tpAddMonths(rule.from === 'entry' ? entry : end, rule.months || 0);
    if (rule.plusDays) { const p = tpAddDays(end, rule.plusDays); if (p > need) need = p; }
    if (need < end) need = end;
  }
  const renewDue = tpAddMonths(expiry, -renewMonths);
  const level = expiry < need ? 'bad' : rule ? 'ok' : 'unknown';
  return { expiry, need, level, during: expiry < end, renewDue, renew: (today || entry) >= renewDue || entry >= renewDue, oneWay: end === entry };
}
// The countries a plan stays in (not Taiwan): when it arrives and when the next leg leaves that country.
function planCountries(legs, ctx = {}) {
  const cc = (c) => ctx.ap?.(c)?.country || '';
  const out = new Map();
  legs.forEach((l, i) => {
    const c = cc(l.to);
    if (!c || c === 'TW') return;
    const entry = tpAddDays(l.date, l.arrDays || 0);
    const next = legs.slice(i + 1).find((x) => cc(x.from) === c && cc(x.to) !== c);
    const exit = next?.date || entry;
    const prev = out.get(c);
    out.set(c, { country: c, entry: prev && prev.entry < entry ? prev.entry : entry, exit: prev && prev.exit > exit ? prev.exit : exit });
  });
  return [...out.values()];
}

if (typeof module === 'object' && module.exports) {
  module.exports = { TRIP_STATUS, tpAddMonths, tpBefore, sameTicket, legKeyDates, tripNotes, tripIcs, tripConnections, passportRuleText, passportCheck, planCountries };
}

// ---------- page ----------
const PASSPORT_KEY = 'passport:v1';
const TRIP_REMIND_KEY = 'tripRemind:v1';
const tp = { edit: -1, paste: false, pasteRes: null, busy: false, visa: new Map(), visaWant: new Set(), loading: false };
const tpCtx = () => ({
  trips: data.trips || {}, holds: data.holds || {}, today: isoDate(0), keyOf: programKeyOf, name: programName,
  ap: (c) => AP.byCode.get(c) || null, countryName: countryZh, visa: (cc) => (tp.visa.has(cc) ? tp.visa.get(cc) : undefined),
});
const tpPassport = () => { const p = store.get(PASSPORT_KEY, null); return p && /^\d{4}-\d{2}-\d{2}$/.test(p.expiry || '') ? p : null; };
const tpStatus = (l) => (TRIP_STATUS[l.status] ? l.status : 'plan');
// The rules, the airport list and the transit countries' entry rules load on first need; the plan redraws once they're in.
function tpEnsure() {
  if ((data.trips && AP.loaded) || tp.loading || tp.tried) return;
  tp.loading = true;
  const done = () => { tp.loading = false; tp.tried = true; tripRemindSync(); renderPlan(); }; // one try per page view
  Promise.all([loadMore(), loadAirports()]).then(done, done);
}
function tpWantVisa(cc) {
  if (!cc || cc === 'TW' || tp.visa.has(cc) || tp.visaWant.has(cc)) return;
  tp.visaWant.add(cc);
  const code = AP.list.find((a) => a.country === cc && a.large)?.code || AP.list.find((a) => a.country === cc)?.code;
  if (!code) { tp.visa.set(cc, null); return; }
  const d = isoDate(0);
  api(`/api/trip-info?${new URLSearchParams({ to: code, start: d, end: d, only: 'holidays' })}`)
    .then((info) => tp.visa.set(cc, info.visa || null)).catch(() => tp.visa.set(cc, null)).finally(() => { tp.visaWant.delete(cc); renderPlan(); });
}

// Status pill in the date column; on the owner's own plan it opens the editor.
function tripPill(l, i, editable) {
  const s = tpStatus(l);
  const label = s === 'plan' ? '規劃中' : TRIP_STATUS[s];
  return editable ? `<button type="button" class="tp-pill s-${s}" data-tp-edit="${i}" aria-label="訂位進度：${label}，按一下修改">${label} ✎</button>` : `<span class="tp-pill s-${s}">${label}</span>`;
}
const tpTime = (l) => (l.dep ? `・${esc(l.dep)}${l.arr ? `–${esc(l.arr)}${l.arrDays ? `<sup>+${l.arrDays}</sup>` : ''}` : ''}` : '');
const tpWhen = (d, today) => {
  if (!d.date) return '';
  const n = tpDays(today, d.date);
  return `${d.date.slice(0, 4) !== today.slice(0, 4) ? `${d.date.slice(0, 4)}/` : ''}${mmdd(d.date)}${d.time ? ` ${esc(d.time)}` : ''}${n >= 0 && n <= 60 ? `（${n ? `還有 ${n} 天` : '今天'}）` : n < 0 ? '（已過）' : ''}`;
};
// Under each leg: its key dates, the connection to the next leg when they are separate tickets, and the editor.
function tripRowHtml(p, i, editable) {
  const l = p.legs[i];
  const ctx = tpCtx();
  const dates = legKeyDates(l, p.legs, ctx);
  const conn = AP.loaded ? tripConnections(p.legs, ctx).find((c) => c.i === i) : null;
  if (conn?.country) tpWantVisa(conn.country);
  const chip = (d) => (d.kind === 'wait' ? `<span class="tp-date"><b>備案</b> ${esc(l.backup || '還沒填')}</span>`
    : (d.date && (d.kind !== 'cancel' || d.steps)) || d.kind === 'hold' ? `<span class="tp-date${d.warn ? ' warn' : ''}"><b>${esc(d.label)}</b> ${d.date ? tpWhen(d, ctx.today) : '還沒填'}${d.verify && d.date ? ' <span class="tag verify">待確認</span>' : ''}</span>` : '');
  const chips = dates.map(chip).join('');
  const srcs = [...new Map(dates.flatMap((d) => d.src || []).map((s) => [s.url, s])).values()];
  const more = dates.filter((d) => d.text);
  const info = more.length ? `<details class="tp-more"><summary>ⓘ 規定與來源</summary><ul>${more.map((d) => `<li><b>${esc(d.label)}</b>：${esc(d.text)}${d.verify ? '（官方資料待確認）' : ''}</li>`).join('')}</ul>${srcs.length ? `<p class="hint">${srcs.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)} ↗</a>`).join('　')}（${esc(ctx.trips.lastReviewed || '')} 查核）</p>` : ''}</details>` : '';
  const connHtml = conn ? `<ul class="tp-conn" aria-label="和下一段的轉機">${conn.lines.map((x) => `<li class="${x.level}">${{ bad: '⚠️', warn: '⚠️', ok: '✓', info: '🧳' }[x.level]} ${esc(x.text)}</li>`).join('')}</ul>` : '';
  const ed = editable && tp.edit === i ? tpEditorHtml(l, i) : '';
  if (!chips && !info && !connHtml && !ed && !(l.pnr && editable)) return '';
  return `<tr class="tp-sub"><td colspan="${editable ? 5 : 4}">${chips || (l.pnr && editable) ? `<div class="tp-dates">${chips}${l.pnr && editable ? `<span class="tp-date"><b>訂位代號</b> ${esc(l.pnr)}</span>` : ''}</div>` : ''}${info}${connHtml}${ed}</td></tr>`;
}
function tpEditorHtml(l, i) {
  const s = tpStatus(l);
  const opt = (v, t) => `<option value="${v}" ${s === v ? 'selected' : ''}>${t}</option>`;
  const prev = i > 0 ? plan.legs[i - 1] : null;
  return `<form class="tp-edit" data-tp-form="${i}">
    <label class="field">訂位進度<select name="status">${opt('plan', '規劃中')}${opt('held', '已保留')}${opt('waitlist', '候補中（有備案）')}${opt('ticketed', '已開票')}</select></label>
    <label class="field" data-show="held">保留到<input type="date" name="holdUntil" value="${esc(l.holdUntil || '')}"></label>
    <label class="field" data-show="waitlist">備案<input name="backup" maxlength="40" placeholder="例如：同天 CI 100 已保留" value="${esc(l.backup || '')}"></label>
    <label class="field" data-show="ticketed">開票日<input type="date" name="ticketedOn" value="${esc(l.ticketedOn || '')}"></label>
    <label class="field">起飛<input type="time" name="dep" value="${esc(l.dep || '')}"></label>
    <label class="field">抵達<input type="time" name="arr" value="${esc(l.arr || '')}"></label>
    <label class="field">抵達日<select name="arrDays"><option value="0">當天</option><option value="1" ${l.arrDays === 1 ? 'selected' : ''}>隔天 +1</option><option value="2" ${l.arrDays === 2 ? 'selected' : ''}>+2 天</option></select></label>
    <label class="field">訂位代號<input name="pnr" maxlength="8" autocapitalize="characters" placeholder="選填" value="${esc(l.pnr || '')}"></label>
    ${prev ? `<label class="check"><input type="checkbox" name="joined" ${sameTicket(prev, l) ? 'checked' : ''}> 和上一段（${esc(prev.from)} → ${esc(prev.to)}）是同一張票</label>` : ''}
    <p class="hint">時間填當地時間。訂位代號只存在這台裝置（登入時同步到你的帳號），複製的行程連結不會帶出去。</p>
    <div class="plan-actions"><button type="submit" class="primary small">儲存</button><button type="button" class="outline" data-tp-cancel>取消</button></div>
  </form>`;
}
function tpSyncEditor(form) {
  const s = form.status.value;
  $$('[data-show]', form).forEach((el) => { el.hidden = el.dataset.show !== s; });
}
function tpSaveLeg(form) {
  const i = Number(form.dataset.tpForm);
  const l = plan.legs[i];
  if (!l) return;
  const f = (n) => (form[n]?.value || '').trim();
  const s = f('status');
  const was = l.status;
  for (const k of ['status', 'holdUntil', 'ticketedOn', 'backup', 'dep', 'arr', 'arrDays', 'pnr']) delete l[k];
  if (TRIP_STATUS[s]) l.status = s;
  if (s === 'held' && f('holdUntil')) l.holdUntil = f('holdUntil');
  if (s === 'waitlist' && f('backup')) l.backup = f('backup').slice(0, 40);
  if (s === 'ticketed') l.ticketedOn = f('ticketedOn') || isoDate(0);
  if (f('dep')) l.dep = f('dep');
  if (f('arr')) l.arr = f('arr');
  if (Number(f('arrDays'))) l.arrDays = Number(f('arrDays'));
  if (/^[A-Z0-9]{5,8}$/.test(f('pnr').toUpperCase())) l.pnr = f('pnr').toUpperCase();
  const prev = plan.legs[i - 1];
  if (form.joined) {
    if (form.joined.checked) { prev.tk ||= Math.random().toString(36).slice(2, 8); l.tk = prev.tk; } else if (l.tk && l.tk === prev?.tk) delete l.tk;
  }
  tp.edit = -1;
  savePlan();
  if (was !== l.status) document.dispatchEvent(new CustomEvent('plan:status', { detail: { leg: { ...l }, index: i, from: was || null, to: l.status || null } }));
  toast(`已更新：${TRIP_STATUS[l.status] || '規劃中'}`);
}

// Below the legs: passport, reminders and the actions (.ics, 貼上確認信).
function tripPlanExtras(p) {
  if (!p.legs.length) return '';
  // The rules (data more) and the 270 KB airport list load once the panel is open or a leg has a status.
  if ($('#plan-panel')?.open || p.legs.some((l) => l.status)) tpEnsure();
  return `${tpPlanPassport(p)}${tpRemindHtml(p)}`;
}
function tripActionsHtml(p) {
  const paste = typeof nl !== 'undefined' && nl.on && nlOwnerHere();
  return `${p.legs.length ? '<button type="button" class="outline" data-tp-ics>📅 匯出行事曆（.ics）</button>' : ''}${paste ? '<button type="button" class="outline" data-tp-paste>📋 貼上確認信（用 AI 讀）</button>' : ''}`;
}
function tpPasteHtml() {
  if (!tp.paste) return '';
  const r = tp.pasteRes;
  const rows = r?.legs?.length ? `<ul class="tp-paste-legs">${r.legs.map((l) => `<li><b>${mmdd(l.date)}（${dowOf(l.date)}）${esc(l.from)} → ${esc(l.to)}</b> ${esc(l.flights)}${tpTime(l)}${l.pnr ? `・${esc(l.pnr)}` : ''}<small>${l.k === 'a' ? `哩程票${l.program ? `・${esc(programName(l.program))}` : ''}` : '現金票'}・${CABIN_LABEL[l.cabin]}${l.status ? '・已開票' : ''}</small></li>`).join('')}</ul>` : '';
  return `<form class="tp-paste" id="tp-paste">
    <p class="hint">把航空公司寄來的電子機票或訂位確認信貼在這裡，按「讀出航段」後會<b>把這段文字送到 AI</b>（和一句話搜尋同一個模型）列出航班，每天最多 20 次，網站不會存下內容。請先刪掉護照號碼、生日這類個資。</p>
    <textarea name="text" rows="6" maxlength="6000" placeholder="例如：訂位代號 ABC123　BR 198　2026/11/03　TPE 08:50 → NRT 13:15"></textarea>
    <div class="plan-actions"><button type="submit" class="primary small" ${tp.busy ? 'disabled' : ''}>${tp.busy ? '讀取中…' : '讀出航段（用 1 次 AI）'}</button><button type="button" class="outline" data-tp-paste-close>關閉</button></div>
    ${r?.err ? `<p class="status error">${esc(r.err)}</p>` : ''}
    ${r && !r.err ? (rows ? `<p>讀到 ${r.legs.length} 段${r.mock ? '（示範資料）' : ''}，確認沒錯再加入：</p>${rows}${r.dropped?.length ? `<p class="hint">沒讀懂、沒加入的：${esc(r.dropped.join('、'))}</p>` : ''}<div class="plan-actions"><button type="button" class="primary small" data-tp-paste-add>加入我的行程</button></div>` : '<p class="hint">沒有讀到航班，請只貼航班那一段再試一次。</p>') : ''}
  </form>`;
}

function tpPlanPassport(p) {
  if (!data.trips?.passport || !AP.loaded) return '';
  const stays = planCountries(p.legs, tpCtx());
  if (!stays.length) return '';
  const pp = tpPassport();
  if (!pp) return `<p class="tp-pp hint">🛂 ${tpPassportFormHtml(null, '填護照到期日，幫你檢查這趟的護照效期')}</p>`;
  const R = data.trips.passport;
  const res = stays.map((s) => ({ ...s, rule: R.countries[s.country] || null, c: passportCheck({ expiry: pp.expiry, rule: R.countries[s.country] || null, entry: s.entry, exit: s.exit, today: isoDate(0), renewMonths: R.renewMonths }) }));
  const bad = res.filter((x) => x.c?.level === 'bad');
  const renew = res.some((x) => x.c?.renew);
  const names = (list) => list.map((x) => esc(countryZh(x.country))).join('、');
  return `<p class="tp-pp ${bad.length ? 'bad' : ''}">🛂 護照 ${esc(pp.expiry)} 到期：${bad.length ? `<b>${names(bad)}要求的效期不夠</b>（要到 ${esc(bad[0].c.need)} 以後），請先換發護照` : `${names(res)}的效期要求都夠${res.some((x) => !x.rule) ? '（部分國家的規定待確認，見出發前小提醒）' : ''}`}${renew && !bad.length ? `；已進入建議換發期（到期前 ${R.renewMonths} 個月）` : ''} ${tpPassportFormHtml(pp, '改')}</p>`;
}
const tpPassportFormHtml = (pp, label) => `<button type="button" class="linklike" data-pp-edit>${label}</button><span class="pp-form" hidden><input type="date" aria-label="護照到期日" value="${esc(pp?.expiry || '')}"> <button type="button" class="primary small" data-pp-save>儲存</button>${pp ? ' <button type="button" class="linklike" data-pp-clear>清除</button>' : ''}<small class="hint">只存在這台裝置，登入帳號時同步到你的帳號</small></span>`;

// 出發前小提醒's passport line (tripinfo.js). q: { start, end } of the search; the rules come with the page's second data part.
function passportLiHtml(cc, q) {
  if (!cc || cc === 'TW' || !q?.start) return '';
  const attrs = `data-cc="${esc(cc)}" data-in="${esc(q.start)}" data-out="${esc(q.end || q.start)}"`;
  if (!data.trips?.passport) { loadMore().then(() => $$('li.ti-passport').forEach(tpFillPassport)).catch(() => {}); return `<li class="ti-passport" ${attrs}></li>`; }
  return `<li class="ti-passport" ${attrs}>${tpPassportLi(cc, q.start, q.end || q.start)}</li>`;
}
function tpFillPassport(li) { if (data.trips?.passport) li.innerHTML = tpPassportLi(li.dataset.cc, li.dataset.in, li.dataset.out); }
function tpPassportLi(cc, entry, exit) {
  const R = data.trips?.passport;
  if (!R) return '';
  const rule = R.countries[cc] || null;
  const name = esc(countryZh(cc));
  const ruleTxt = rule ? `${name}：${esc(passportRuleText(rule))}` : `${name}：${R.unstated.includes(cc) ? '領事事務局的頁面沒有寫護照效期要求' : '還沒查到護照效期要求'}，待確認；保險起見最好還有 6 個月以上`;
  const url = rule?.url || R.listUrl;
  const pp = tpPassport();
  const c = pp ? passportCheck({ expiry: pp.expiry, rule, entry, exit, today: isoDate(0), renewMonths: R.renewMonths }) : null;
  const res = !c ? '' : c.level === 'bad' ? `<b class="ti-tag bad">效期不夠</b> 你的護照 ${esc(pp.expiry)} 到期，${c.during ? '旅途中就會過期' : `${name}要求要到 ${esc(c.need)} 以後`}，請先換發。`
    : `<b class="ti-tag ${c.level === 'ok' ? 'ok' : 'mid'}">${c.level === 'ok' ? '效期夠' : '涵蓋旅程'}</b> 你的護照 ${esc(pp.expiry)} 到期${c.level === 'ok' ? `，${c.oneWay && rule?.from === 'exit' ? `離境日越晚要求越晚（${esc(c.need)} 是用入境日算的）` : `要求到 ${esc(c.need)} 以後`}` : ''}。`;
  const renew = c?.renew && c.level !== 'bad' ? ` 已進入建議換發期（到期前 ${R.renewMonths} 個月，${esc(c.renewDue)} 起）。` : '';
  return `<span class="ti-k">📘 護照效期</span><span>${ruleTxt}（<a href="${esc(url)}" target="_blank" rel="noopener">領事事務局 ↗</a>，${esc(R.asOf)} 查核）<br>${res}${renew} ${tpPassportFormHtml(pp, pp ? '改護照到期日' : '填護照到期日，幫你檢查')}</span>`;
}
function tpSavePassport(v) {
  if (v) store.set(PASSPORT_KEY, { expiry: v }); else store.del(PASSPORT_KEY);
  $$('li.ti-passport').forEach(tpFillPassport);
  renderPlan();
  toast(v ? '已儲存護照到期日' : '已清除護照到期日');
}

// Reminders: signed in, the synced plan carries them (plan.remind) to the daily mail; the owner can save them with
// the passcode like the miles expiry list; otherwise the .ics is the way.
function tpRemindHtml(p) {
  const notes = p.remind || [];
  const n = notes.length;
  const pp = tpPassport();
  if (!n && !pp) return p.legs.some((l) => l.status) ? '' : '<p class="hint tp-tip">💡 按每段日期下的「規劃中 ✎」標成已保留、候補中或已開票，會列出保留期限、報到、取消期限，並在日期前提醒你。</p>';
  const what = `${n ? `${n} 個行程日期（保留到期、報到、備案取消期限）` : ''}${n && pp ? '和' : ''}${pp ? '護照換發' : ''}`;
  if (typeof signedIn === 'function' && signedIn()) {
    if (!acct.emailEnabled) return '';
    if (typeof joinedHere === 'function' && !joinedHere()) return `<p class="hint">🔔 這台裝置的資料存進帳號後，${what}到了會寄 Email 提醒你。</p>`;
    return `<p class="hint">📧 ${what}到了會寄 Email 到 ${esc(acct.status.email)}（每天早上檢查）。</p>`;
  }
  if (!alertCfg.store) return typeof acct !== 'undefined' && acct.configured ? `<p class="hint">🔔 登入帳號後，${what}到了會寄 Email 提醒你；也可以匯出行事曆。</p>` : '';
  const saved = store.get(TRIP_REMIND_KEY, null);
  if (saved && saved.sig === tpSig(p)) return `<p class="hint">🔔 已設定：${what}到了會提醒你${saved.email ? `（寄到 ${esc(saved.email)}，也傳到已連結的 Telegram）` : '（傳到已連結的 Telegram）'}。<button type="button" class="linklike" data-tp-remind>修改</button></p>`;
  return `<p class="hint">🔔 ${saved ? '日期有變更，' : ''}<button type="button" class="linklike" data-tp-remind>${saved ? '更新提醒' : `${what}到了用 Email／Telegram 提醒我`}</button></p>
    <form class="exp-remind-form tp-remind-form" hidden><input type="email" name="email" placeholder="Email（可留空，只傳 Telegram）" value="${esc(saved?.email ?? store.get(ALERT_EMAIL_KEY, ''))}" autocomplete="email" aria-label="提醒寄到的 Email"><button type="submit" class="primary small">儲存提醒</button></form>`;
}
const tpSig = (p) => JSON.stringify([p.remind || [], tpPassport()?.expiry || '']);
async function tpSaveRemind(form) {
  const email = form.email.value.trim();
  const btn = $('button[type=submit]', form);
  btn.disabled = true;
  try {
    const r = await cashApi('/api/expiry', { pass: '行程提醒', method: 'POST', body: JSON.stringify({ email, notes: plan.remind || [], passport: tpPassport() }), headers: { 'content-type': 'application/json' } });
    store.set(TRIP_REMIND_KEY, { email: r.email ?? email, sig: tpSig(plan) });
    if (email) store.set(ALERT_EMAIL_KEY, email);
    toast('已設定行程提醒');
    renderPlan();
  } catch (err) { toast(err.message); btn.disabled = false; }
}

// Recompute the dated reminders saved with the plan (synced to the account, read by the daily run).
function tripRemindUpdate(p) {
  if (!data.trips) { tpEnsure(); return false; }
  const notes = tripNotes(p, tpCtx());
  const same = JSON.stringify(notes) === JSON.stringify(p.remind || []);
  if (notes.length) p.remind = notes; else delete p.remind;
  return !same;
}
// After the account merged a plan in from another device.
function tripRemindSync() { if (data.trips && tripRemindUpdate(plan)) store.set(PLAN_KEY, plan); }

function tpDownloadIcs() {
  const text = tripIcs(plan, { ...tpCtx(), stamp: `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z` });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/calendar' }));
  a.download = `trip-${plan.legs[0]?.date || 'plan'}.ics`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
async function tpPaste(form) {
  const text = form.text.value.trim();
  if (!text) { tp.pasteRes = { err: '請先貼上確認信的內容' }; renderPlan(); return; }
  tp.busy = true;
  renderPlan();
  try {
    tp.pasteRes = await cashApi('/api/nl/ticket', { pass: '貼上確認信', method: 'POST', body: JSON.stringify({ text }), headers: { 'content-type': 'application/json' } });
  } catch (err) { tp.pasteRes = { err: err.message }; }
  tp.busy = false;
  renderPlan();
  const ta = $('#tp-paste textarea');
  if (ta) ta.value = text;
}

// One listener for everything the plan panel and 出發前小提醒 draw (they redraw often). Not under node (the tests).
const tpOn = typeof document === 'undefined' ? () => {} : (...a) => document.addEventListener(...a);
tpOn('click', (e) => {
  const t = e.target.closest?.('[data-tp-edit],[data-tp-cancel],[data-tp-ics],[data-tp-paste],[data-tp-paste-close],[data-tp-paste-add],[data-tp-remind],[data-pp-edit],[data-pp-save],[data-pp-clear]');
  if (!t) return;
  const d = t.dataset;
  if (d.tpEdit != null) { tp.edit = tp.edit === Number(d.tpEdit) ? -1 : Number(d.tpEdit); renderPlan(); tpEnsure(); const f = $('.tp-edit'); if (f) { tpSyncEditor(f); f.status.focus(); } }
  else if (d.tpCancel != null) { tp.edit = -1; renderPlan(); }
  else if (d.tpIcs != null) tpDownloadIcs();
  else if (d.tpPaste != null) { tp.paste = true; tp.pasteRes = null; renderPlan(); $('#tp-paste textarea')?.focus(); }
  else if (d.tpPasteClose != null) { tp.paste = false; tp.pasteRes = null; renderPlan(); }
  else if (d.tpPasteAdd != null) { const legs = tp.pasteRes?.legs || []; tp.paste = false; tp.pasteRes = null; addLegs(legs); }
  else if (d.tpRemind != null) { const f = t.closest('p').nextElementSibling; if (f) { f.hidden = !f.hidden; f.email?.focus(); } }
  else if (d.ppEdit != null) { const f = t.nextElementSibling; f.hidden = !f.hidden; $('input', f)?.focus(); }
  else if (d.ppSave != null) { const v = $('input', t.parentElement).value; if (/^\d{4}-\d{2}-\d{2}$/.test(v)) tpSavePassport(v); else toast('請選護照到期日'); }
  else if (d.ppClear != null) tpSavePassport('');
});
tpOn('change', (e) => { const f = e.target.closest?.('.tp-edit'); if (f && e.target.name === 'status') tpSyncEditor(f); });
tpOn('submit', (e) => {
  const f = e.target;
  if (f.matches?.('.tp-edit')) { e.preventDefault(); tpSaveLeg(f); }
  else if (f.id === 'tp-paste') { e.preventDefault(); if (!tp.busy) tpPaste(f); }
  else if (f.matches?.('.tp-remind-form')) { e.preventDefault(); tpSaveRemind(f); }
});
// Opening 我的行程 loads what the dates need, and shows 貼上確認信 once the one-sentence search is known to be on.
tpOn('toggle', (e) => { if (e.target.id === 'plan-panel' && e.target.open) { tpEnsure(); renderPlan(); } }, true);

// ---------- 現金票累積到哪裡 (the cash tab's 已選取的航班) ----------
function accrualHtml(fares) {
  const T = data.trips?.accrual;
  if (!T) return '';
  const codes = [...new Set(fares.filter(Boolean).flatMap((o) => o.segments.map((s) => tpCarrier(String(s.flightNumber || '').toUpperCase()))).filter(Boolean))];
  if (!codes.length) return '';
  const name = (c) => (typeof AL !== 'undefined' && AL.zh.get(c)) || c;
  const wtc = String(T.wheretocredit || 'https://wheretocredit.com/en/');
  return `<details class="tp-accrual"><summary>🎯 這張票的哩程可以累積到哪裡</summary>
    <ul>${codes.map((c) => `<li><b>${esc(name(c))}</b>（${esc(c)}）：${T[c] ? `<a href="${esc(T[c].url)}" target="_blank" rel="noopener">${esc(T[c].label)} ↗</a>・` : ''}<a href="${esc(`${wtc}${c}`)}" target="_blank" rel="noopener">wheretocredit.com 比較可累積的計畫 ↗</a></li>`).join('')}</ul>
    <p class="hint">能累積幾成要看艙等代碼（訂位艙等的英文字母），開票後在行程單上找得到。共用班號的航班依實際營運的航空公司規定。wheretocredit.com 是第三方整理，以航空公司官網為準。</p>
  </details>`;
}
function accrualMount(box, fares) {
  if (!box) return;
  if (data.trips) { box.innerHTML = accrualHtml(fares); return; }
  loadMore().then(() => { if (box.isConnected) box.innerHTML = accrualHtml(fares); }).catch(() => {});
}

// ---------- 規則庫：哩程票的信用卡權益 ----------
function cardPerksHtml() {
  const P = data.trips?.cardPerks;
  if (!P?.cards?.length) return '';
  return `<h2 class="section" id="r-cardperks">哩程票的信用卡權益</h2>
    <p class="hint">${esc(P.summary)}</p>
    <div class="cards">${P.cards.map((c) => `<details class="card prog-card"><summary><span class="card-head"><h3>${esc(c.bank)}・${esc(c.scope)}</h3></span><span class="tag ${c.coversAward ? 'ok' : 'warn'}">${c.coversAward ? '哩程票也保' : '只付稅金的哩程票不保'}</span></summary>
      <ul>${c.quotes.map((q) => `<li>「${esc(q)}」</li>`).join('')}</ul>
      <p class="src">${esc(c.period)}・<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.label)} ↗</a>（${esc(c.checked)} 查核）</p></details>`).join('')}</div>
    <p class="hint">其他銀行還沒整理；各卡的機場貴賓室、旅平險條件不同，請看你那張卡官網上的條款。</p>`;
}
// One line for 怎麼用 X 訂 (features.js howToBookHtml).
const cardPerkLine = () => (data.trips?.cardPerks ? '<li><b>刷卡付稅金</b>　只刷稅金的哩程票，信用卡附的旅平險、不便險可能不保（例如凱基銀行條款寫明不保），出發前看你的卡片條款；詳見規則庫「哩程票的信用卡權益」</li>' : '');
