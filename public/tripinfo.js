// 出發前小提醒: visa, travel warning, weather and holidays for a destination, plus who flies the route nonstop.
// Shared by the award search and the cash tab; also marks holidays on the calendars (see holidayMark).
/* global $, $$, esc, fmt, mmdd, dowOf, AP, api, airportCity */

// Created on first use: the formatter loads ICU data, which is slow on phones while the page starts.
let regionZhDn;
const countryZh = (cc) => { try { regionZhDn ||= new Intl.DisplayNames(['zh-TW'], { type: 'region' }); return regionZhDn.of(cc) || cc; } catch { return cc; } };

// Holidays shown on the calendars: Taiwan days off and make-up workdays, and the destination's public holidays.
// Each view (award search, cash fares) keeps its own map, so one tab's destination never shows on the other's calendar.
const newHolidays = () => ({ tw: new Map(), dest: new Map(), long: new Map(), country: '' });
const HOL = { search: newHolidays(), cash: newHolidays() };
// `merge` adds to what is there (the cash grid keeps its wider range when a day on it is picked).
function setHolidays(hol, info, merge = false) {
  if (!merge || (info.country && hol.country && info.country !== hol.country)) Object.assign(hol, newHolidays());
  for (const d of info.taiwan?.days || []) hol.tw.set(d.date, d);
  for (const h of info.holidays || []) hol.dest.set(h.date, holName(h, info.country));
  for (const l of info.taiwan?.longWeekends || []) {
    for (let d = l.start; d <= l.end; d = isoNext(d)) hol.long.set(d, l);
  }
  hol.country = info.country || hol.country;
}
// Local names read fine in Chinese-script countries; elsewhere the English name is clearer.
const CJK_LOCAL = new Set(['JP', 'CN', 'HK', 'MO']);
const holName = (h, cc) => (CJK_LOCAL.has(cc) && h.local ? h.local : h.name || h.local);
const isoNext = (d) => new Date(Date.parse(d) + 864e5).toISOString().slice(0, 10);
// Extra classes and tooltip text for one calendar day.
function holidayMark(hol, iso) {
  const tw = hol.tw.get(iso);
  const long = hol.long.get(iso);
  const dest = hol.dest.get(iso);
  const cls = [];
  const notes = [];
  if (tw?.workday) { cls.push('hol-work'); notes.push(`台灣補班：${tw.name}`); }
  else if (tw || long) { cls.push('hol-tw'); notes.push(`台灣放假${tw?.name && tw.name !== '放假' ? `：${tw.name}` : ''}${long ? `（${long.name} ${long.days} 天連假）` : ''}`); }
  if (dest) { cls.push('hol-dest'); notes.push(`${countryZh(hol.country)}假日：${dest}`); }
  return { cls: cls.join(' '), title: notes.join('；') };
}
function holidayLegend(hol) {
  const any = hol.tw.size || hol.long.size || hol.dest.size;
  return any ? `<span class="hol-legend"><i class="dot tw"></i>台灣放假${hol.dest.size ? `<i class="dot dest"></i>${esc(countryZh(hol.country))}假日` : ''}${[...hol.tw.values()].some((d) => d.workday) ? '<i class="dot work"></i>補班' : ''}</span>` : '';
}

const VISA_TYPE = { free: ['免簽', 'ok'], arrival: ['落地簽', 'mid'], evisa: ['電子簽證', 'mid'], eta: ['免簽，需先上網申請許可', 'mid'], required: ['需要簽證', 'bad'], home: ['本國', 'ok'] };
const WARN_LEVEL = { gray: ['灰色警示', '提醒注意'], yellow: ['黃色警示', '特別注意旅遊安全並檢討應否前往'], orange: ['橙色警示', '避免非必要旅行'], red: ['紅色警示', '不宜前往，宜儘速離境'] };

function visaHtml(v, cc) {
  if (cc === 'TW') return '';
  if (!v) return `<li><span class="ti-k">🛂 簽證</span><span>沒有 ${esc(countryZh(cc))} 的資料，請到<a href="https://www.boca.gov.tw/sp-foof-countrylp-01-1.html" target="_blank" rel="noopener">領事事務局</a>查詢。</span></li>`;
  const [label, tone] = VISA_TYPE[v.type] || [v.type, ''];
  return `<li><span class="ti-k">🛂 簽證</span><span><b class="ti-tag ${tone}">${esc(label)}${v.days ? ` ${v.days} 天` : ''}</b>${v.note ? ` ${esc(v.note)}` : ''}</span></li>`;
}
function warningHtml(w) {
  if (!w) return '';
  const [label, meaning] = WARN_LEVEL[w.level] || [w.level, ''];
  return `<li><span class="ti-k">⚠️ 旅遊警示</span><span><b class="ti-tag warn-${esc(w.level)}">${esc(label)}</b> ${esc(meaning)}${w.note ? `。${esc(w.note)}` : ''}</span></li>`;
}
function weatherHtml(w, err) {
  if (!w) return err ? '<li><span class="ti-k">🌤️ 天氣</span><span class="hint">天氣資料暫時拿不到</span></li>' : '';
  if (w.kind === 'forecast') {
    if (!w.days.length) return '';
    return `<li class="ti-wide"><span class="ti-k">🌤️ 天氣預報</span><div class="ti-days">${w.days.map((d) => `<div class="ti-day" title="${esc(d.text)}"><small>${mmdd(d.date)}（${dowOf(d.date)}）</small><span class="ti-ico" aria-hidden="true">${d.icon}</span><b>${d.max ?? '–'}°</b><small>${d.min ?? '–'}°${d.rain != null ? `・☔${d.rain}%` : ''}</small></div>`).join('')}</div></li>`;
  }
  return `<li><span class="ti-k">🌤️ 天氣</span><span>${w.month} 月平均：高溫 <b>${w.max}°C</b>、低溫 <b>${w.min}°C</b>${w.rainyDays != null ? `，一個月約 <b>${w.rainyDays}</b> 天下雨` : ''}<small class="hint">（近 3 年同月平均，出發前 16 天內會改成天氣預報）</small></span></li>`;
}
function holidaysHtml(info) {
  const out = [];
  const long = info.taiwan?.longWeekends || [];
  const work = (info.taiwan?.days || []).filter((d) => d.workday);
  const range = (a, b) => (a === b ? mmdd(a) : `${mmdd(a)}–${mmdd(b)}`);
  if (long.length) {
    const shown = long.slice(0, 4).map((l) => `${range(l.start, l.end)} ${esc(l.name)} <b>${l.days}</b> 天`).join('、');
    out.push(`<li><span class="ti-k">🇹🇼 台灣連假</span><span>${shown}${long.length > 4 ? `，還有 ${long.length - 4} 個` : ''}<small class="hint">（連假前後機位和房價通常比較貴）</small></span></li>`);
  } else if (info.taiwan) {
    out.push('<li><span class="ti-k">🇹🇼 台灣連假</span><span>這段期間沒有連假，通常比較好訂。</span></li>');
  }
  if (work.length) out.push(`<li><span class="ti-k">🗓️ 補班</span><span>${work.map((d) => `${mmdd(d.date)}（${dowOf(d.date)}）`).join('、')}</span></li>`);
  const hol = info.holidays || [];
  if (info.country && info.country !== 'TW' && info.holidays) {
    out.push(`<li><span class="ti-k">🎌 ${esc(countryZh(info.country))}假日</span><span>${hol.length
      ? hol.slice(0, 6).map((h) => `${mmdd(h.date)} ${esc(holName(h, info.country))}`).join('、') + (hol.length > 6 ? `，共 ${hol.length} 天` : '')
      : '這段期間沒有國定假日'}</span></li>`);
  }
  return out.join('');
}
// The one-line version shown while the notes are folded: 免簽 90 天・11 月 9–18°C・無連假.
function tripSummary(info) {
  const out = [];
  const v = info.visa;
  if (info.country && info.country !== 'TW' && v) out.push(`${(VISA_TYPE[v.type] || [v.type])[0]}${v.days ? ` ${v.days} 天` : ''}`);
  if (info.warning && info.warning.level !== 'gray') out.push((WARN_LEVEL[info.warning.level] || [info.warning.level])[0]);
  const w = info.weather;
  if (w?.kind === 'forecast' && w.days.length) {
    const lo = Math.min(...w.days.map((d) => d.min ?? Infinity));
    const hi = Math.max(...w.days.map((d) => d.max ?? -Infinity));
    if (Number.isFinite(lo) && Number.isFinite(hi)) out.push(`${lo}–${hi}°C`);
  } else if (w?.month) out.push(`${w.month} 月 ${w.min}–${w.max}°C`);
  if (info.taiwan) out.push((info.taiwan.longWeekends || []).length ? `${info.taiwan.longWeekends.length} 個連假` : '無連假');
  return out.join('・');
}

function tripInfoHtml(info, q) {
  const cc = info.country;
  const city = airportCity(info.airport) || info.airport;
  const sum = tripSummary(info);
  return `<details class="trip-info">
    <summary><b>🧳 出發前小提醒｜${esc(city)}${cc && cc !== 'TW' ? `（${esc(countryZh(cc))}）` : ''}</b>${sum ? `<span class="ti-sum">${esc(sum)}</span>` : ''}</summary>
    <ul class="ti-list">
      ${q.from ? `<li class="ti-directs" data-from="${esc(q.from)}" data-to="${esc(q.to)}"><span class="ti-k">✈️ 誰飛直航</span><span class="hint">查詢中…</span></li>` : ''}
      ${visaHtml(info.visa, cc)}
      ${warningHtml(info.warning)}
      ${weatherHtml(info.weather, info.errors?.weather)}
      ${holidaysHtml(info)}
    </ul>
    <details class="ti-src"><summary>ⓘ 資料來源</summary><p>簽證整理自${esc(info.sources?.visa?.name || '外交部領事事務局')}${info.sources?.visa?.asOf ? `（${esc(info.sources.visa.asOf)}）` : ''}，出發前請再到<a href="https://www.boca.gov.tw/" target="_blank" rel="noopener">領事事務局</a>確認；旅遊警示來自<a href="https://www.boca.gov.tw/sp-trwa-list-1.html" target="_blank" rel="noopener">外交部</a>${info.sources?.warning?.asOf ? `（${esc(info.sources.warning.asOf)}）` : ''}；天氣 <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a>；台灣行事曆來自行政院人事行政總處（政府資料開放平臺）；各國假日 Nager.Date<span class="ti-src-ad" hidden>；直飛航班資料 <a href="https://aerodatabox.com/" target="_blank" rel="noopener">AeroDataBox</a></span>。</p></details>
  </details>`;
}

// Fill `box` with the notes for a trip. opts.hol is the view's holiday map, opts.merge keeps marks already in it,
// and opts.onHolidays runs once the map is ready, to redraw that view's calendar.
const tripSeq = new Map();
async function loadTripInfo(box, q, opts = {}) {
  if (!box) return;
  const to = (q.to || '').split(',')[0];
  const from = (q.from || '').split(',')[0];
  const n = (tripSeq.get(box) || 0) + 1;
  tripSeq.set(box, n);
  if (!/^[A-Z]{3}$/.test(to) || !q.start) { box.innerHTML = ''; return; }
  box.innerHTML = '<div class="trip-info loading">🧳 正在整理出發前小提醒…</div>';
  try {
    const p = new URLSearchParams({ to, start: q.start, end: q.end || q.start });
    const info = await api(`/api/trip-info?${p}`);
    if (tripSeq.get(box) !== n) return;
    box.innerHTML = tripInfoHtml(info, { ...q, to, from });
    if (opts.hol) setHolidays(opts.hol, info, opts.merge);
    if (opts.onHolidays) opts.onHolidays();
    // Who flies it nonstop is looked up only when the notes are opened (it can spend AeroDataBox units).
    const directs = $('.ti-directs', box);
    if (directs && from && from !== to) {
      $('details.trip-info', box).addEventListener('toggle', () => loadDirects(directs, q.from, q.to), { once: true });
    } else directs?.remove();
  } catch {
    if (tripSeq.get(box) === n) box.innerHTML = '';
  }
}

// Holidays only (for a wider calendar than the trip itself); returns the info, or null when it can't be had.
async function fetchHolidays(to, start, end) {
  try {
    return await api(`/api/trip-info?${new URLSearchParams({ to: to.split(',')[0], start, end, only: 'holidays' })}`);
  } catch { return null; }
}

// Which airlines fly this pair nonstop, from AeroDataBox's route statistics (cached server-side for two weeks).
async function loadDirects(li, from, to) {
  if (!li) return;
  const span = li.lastElementChild;
  try {
    const body = await api(`/api/directs?${new URLSearchParams({ from: from.split(',').slice(0, 3).join(','), to })}`);
    if (!body.configured) { li.remove(); return; }
    li.closest('.trip-info')?.querySelector('.ti-src-ad')?.removeAttribute('hidden');
    if (!body.airlines.length) {
      span.className = '';
      span.textContent = '最近一週沒有直飛航班，要轉機。';
      return;
    }
    span.className = 'ti-air';
    span.innerHTML = body.airlines.map((a) => `<span class="pill" title="${esc(a.name)}${a.code ? `（${esc(a.code)}）` : ''}">${esc(a.zh || a.name)}</span>`).join('')
      + `<small class="hint">${body.perDay ? `合計每天約 ${body.perDay} 班` : ''}${body.mock ? '（示範資料）' : `，依最近 7 天實際航班統計（${esc(body.updated)} 更新）`}</small>`;
  } catch (err) {
    span.className = 'hint';
    span.textContent = err.message || '直飛資料暫時拿不到';
  }
}
