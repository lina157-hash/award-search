// 查飯店: hotel award nights (points) from rooms.aero, valued against the cash rate and the user's own points.
// Classic script loaded after app.js and features.js; shares their globals ($, esc, fmt, api, store, wallet, reachHotel…).

const HOTEL_NAMES = { marriott: '萬豪 Bonvoy', hilton: '希爾頓 Honors', ihg: '洲際 IHG', hyatt: '凱悅 World of Hyatt', choice: 'Choice', wyndham: '溫德姆 Wyndham', iprefer: 'I Prefer' };
const HOTEL_SHORT = { marriott: '萬豪', hilton: '希爾頓', ihg: '洲際', hyatt: '凱悅', choice: 'Choice', wyndham: '溫德姆', iprefer: 'I Prefer' };
// Typical value of one point in US cents (The Points Guy, 2026/10). A stay worth 30% more than this is marked as a good use.
const POINT_VALUE_CENTS = { marriott: 0.75, hilton: 0.4, ihg: 0.6, hyatt: 1.7 };
const HOTEL_GOOD = 1.3;
const HOTEL_KEY = 'hotelSearch:v1';
seq.hotels = 0;
const hotelState = { where: '', date: '', flex: 7, nights: 1, programs: ['marriott', 'hilton', 'ihg', 'hyatt'], sort: 'points', affordOnly: false, results: null, params: null };
let hotelDate = null; // the form's date picker

// Chinese city names → the English place name rooms.aero geocodes (multi-airport cities and airports with a Chinese name).
const HOTEL_PLACE_FIX = { 峇里島: 'Bali', 普吉島: 'Phuket', 沖繩那霸: 'Okinawa', 夏威夷: 'Honolulu', 舊金山灣區: 'San Francisco', 長灘島: 'Boracay' };
function hotelPlaces() {
  const out = new Map(Object.entries(HOTEL_PLACE_FIX));
  for (const g of AP.groups) out.set(g.zh, g.en);
  for (const a of AP.list) {
    if (!a.zh || !a.large) continue;
    // 東京成田 → 東京: drop the airport part when the city group already covers it.
    const city = AP.groups.find((g) => g.codes.includes(a.code));
    if (!city && !out.has(a.zh)) out.set(a.zh.replace(/（.*）$/, ''), a.alt && !/-/.test(a.alt) ? a.alt : a.city);
  }
  return out;
}
const placeQuery = (text) => hotelPlaces().get(normQ(text)) || text.trim();
// The other way round for the cards: rooms.aero's English city ("Tokyo") → 東京, when the airport list knows it.
function cityZh(name) {
  if (!name || !AP.loaded) return name || '';
  const fix = Object.entries(HOTEL_PLACE_FIX).find(([, en]) => en === name);
  if (fix) return fix[0];
  const g = AP.groups.find((x) => x.en === name);
  if (g) return g.zh;
  const a = AP.list.find((x) => x.zh && x.large && (x.city === name || x.alt === name));
  return a ? a.zh.replace(/（.*）$/, '') : name;
}
const countryName = (c) => (/^[A-Z]{2}$/.test(c || '') ? regionName(c).zh : c || '');

function hotelsHtml() {
  const s = hotelState;
  // Multi-select, so each chain is a toggle chip with a tick rather than a one-of-many segment.
  const chk = (k) => `<label class="h-chip"><input type="checkbox" name="h-prog" value="${k}" ${s.programs.includes(k) ? 'checked' : ''}><span>${HOTEL_SHORT[k]}</span></label>`;
  return `<form id="hotel-form" class="search-card" autocomplete="off" novalidate>
    <div class="opts-row h-row">
      <label class="field h-where">城市或地區<input name="where" list="h-where-list" placeholder="例如 東京、曼谷、Bali" value="${esc(s.where)}"></label>
      <datalist id="h-where-list"></datalist>
      <div class="field dp-field single h-date"><span>入住日期</span><button type="button" class="dp-btn" aria-haspopup="dialog"></button><input type="hidden" name="date" value="${esc(s.date)}"></div>
      <label class="field h-small">日期彈性<select name="flex">${[[0, '只看這天'], [3, '前後 3 天'], [7, '前後 7 天'], [14, '前後 14 天']].map(([v, l]) => `<option value="${v}" ${s.flex === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="field h-small">住幾晚<select name="nights">${[1, 2, 3, 4, 5].map((n) => `<option value="${n}" ${s.nights === n ? 'selected' : ''}>${n} 晚</option>`).join('')}</select></label>
    </div>
    <div class="opts-row">
      <fieldset class="h-progs" aria-label="飯店集團（可複選）"><legend class="sr-only">飯店集團（可複選）</legend>${['marriott', 'hilton', 'ihg', 'hyatt'].map(chk).join('')}</fieldset>
      <button type="submit" class="primary big">搜尋點數房</button>
    </div>
    <p class="hint">資料來自 rooms.aero，涵蓋萬豪、希爾頓、洲際、凱悅等集團的點數房價。雅高和香格里拉沒有點數房價資料：雅高點數價值固定（2,000 點折 €40），可以直接用現金價換算。</p>
  </form>`;
}

function initHotels() {
  const host = $('#hotels-page');
  if (!host) return;
  Object.assign(hotelState, store.get(HOTEL_KEY, {}), { results: null, params: null });
  if (hotelState.date && hotelState.date < isoDate(0)) hotelState.date = '';
  host.innerHTML = hotelsHtml();
  const form = $('#hotel-form');
  hotelDate = createDatePicker(form, '入住日期', { single: true, name: 'date', field: $('.h-date', form) });
  if (hotelState.date) hotelDate.set(hotelState.date);
  onAirports(() => { $('#h-where-list').innerHTML = [...hotelPlaces().keys()].map((k) => `<option value="${esc(k)}"></option>`).join(''); });
  form.where.addEventListener('focus', loadAirports, { once: true });
  form.addEventListener('submit', (e) => { e.preventDefault(); searchHotels(); });
}

async function searchHotels() {
  const f = $('#hotel-form');
  const status = $('#hotels-status');
  const programs = $$('input[name=h-prog]:checked', f).map((i) => i.value);
  // Same messages in the status line as the other tabs (the browser's own bubbles were in its own language).
  if (!f.where.value.trim()) { f.where.focus(); return formError(status, '請輸入城市或地區。'); }
  if (!f.date.value) { $('.h-date .dp-btn', f).focus(); return formError(status, '請選擇入住日期。'); }
  if (!programs.length) return formError(status, '請至少選一個飯店集團。');
  Object.assign(hotelState, { where: f.where.value.trim(), date: f.date.value, flex: Number(f.flex.value), nights: Number(f.nights.value), programs });
  store.set(HOTEL_KEY, { where: hotelState.where, flex: hotelState.flex, nights: hotelState.nights, programs, sort: hotelState.sort });
  const { date, flex } = hotelState;
  const out = $('#hotels-results');
  const fresh = latest('hotels');
  status.className = 'status';
  status.textContent = '搜尋中…';
  out.innerHTML = skeleton(4);
  const done = busy($('button[type=submit]', f), '搜尋中…');
  reveal(status);
  try {
    await loadAirports(); // Chinese city names → English place names
    const start = flex && isoDateFrom(date, -flex) > isoDate(0) ? isoDateFrom(date, -flex) : flex ? isoDate(0) : date;
    const params = { where: placeQuery(hotelState.where), start, end: isoDateFrom(date, flex), nights: hotelState.nights, programs: programs.join(',') };
    const [body] = await Promise.all([api(`/api/hotels/search?${new URLSearchParams(params)}`), loadFx()]);
    if (!fresh()) return;
    done();
    hotelState.results = body;
    hotelState.params = { ...params, date, flex };
    status.textContent = '';
    renderHotels();
    reveal($('#hotels-results'));
  } catch (e) {
    if (!fresh()) return;
    done();
    out.innerHTML = '';
    showError(status, e, searchHotels);
  }
}

// TWD for a cash amount, and the TWD value of one point for a stay.
const toTwd = (m) => (m && fxCache?.rates?.[m.currency] ? Math.round(m.amount * fxCache.rates[m.currency]) : null);
const twdPerPoint = (cash, points) => { const t = toTwd(cash); return t && points ? t / points : null; };
const typicalTwd = (source) => (POINT_VALUE_CENTS[source] && fxCache?.rates?.USD ? (POINT_VALUE_CENTS[source] / 100) * fxCache.rates.USD : null);
function hotelValueHtml(source, cash, points) {
  const v = twdPerPoint(cash, points);
  if (!v) return '';
  const typ = typicalTwd(source);
  const good = typ && v >= typ * HOTEL_GOOD;
  return `<span class="value-tag${good ? ' good' : ''}" title="${typ ? `一般估值每點約 NT$${typ.toFixed(2)}` : ''}">${good ? '☀ 好價 ' : ''}每點約 NT$${v.toFixed(2)}</span>`;
}
// Banks plus own hotel points, through the same totals as 我的點數 (only the programs Taiwanese banks transfer into).
function hotelAffordHtml(source, points) {
  if (walletEmpty() || !points || !hotelPrograms()[source]) return '';
  const r = reachHotel(source);
  if (!r.total) return '<small class="muted">你填的點數不能轉進這個集團</small>';
  return r.total >= points ? `<small class="ok-text">你的點數最多可湊到 ${fmt(r.total)} 點，夠換</small>` : `<small>你的點數最多 ${fmt(r.total)} 點，還差 ${fmt(points - r.total)} 點</small>`;
}
const hotelAfford = (h) => !walletEmpty() && hotelPrograms()[h.source] && h.standard && reachHotel(h.source).total >= h.standard.points;

function renderHotels() {
  const out = $('#hotels-results');
  const body = hotelState.results;
  if (!body) return;
  let list = [...body.hotels].filter((h) => h.standard || h.suite);
  if (hotelState.affordOnly) list = list.filter(hotelAfford);
  if (hotelState.sort === 'value') list.sort((a, b) => (b.cpp || 0) - (a.cpp || 0));
  const p = hotelState.params;
  const n = p.nights;
  const head = `<div class="h-bar">
    <span>${body.mock ? '<b>示範資料</b>・' : ''}找到 ${fmt(list.length)} 家有點數房的飯店${body.hasMore ? '（只列前 100 家）' : ''}${p.flex ? `，每家列出 ${dayLabel(p.date)} 前後 ${p.flex} 天最便宜的一晚` : ''}</span>
    <label class="field compact">排序<select id="h-sort"><option value="points" ${hotelState.sort === 'points' ? 'selected' : ''}>點數最少</option><option value="value" ${hotelState.sort === 'value' ? 'selected' : ''}>每點最值錢</option></select></label>
    ${walletEmpty() ? '' : `<label class="switch"><input type="checkbox" id="h-afford" ${hotelState.affordOnly ? 'checked' : ''}><span class="knob"></span>只看我換得起的</label>`}
  </div>`;
  const card = (h) => {
    const s = h.standard || h.suite;
    const cash = toTwd(s.cash);
    const where = [cityZh(h.city), countryName(h.country)].filter(Boolean).join('，');
    return `<article class="hotel" data-hotel="${esc(h.id)}">
      <div class="hotel-main">
        <div><span class="pill h-${esc(h.source)}">${esc(HOTEL_SHORT[h.source] || h.program)}</span>${h.category ? ` <small>第 ${esc(h.category)} 類</small>` : ''}</div>
        <h3>${esc(h.name)}</h3>
        <small class="muted">${esc(where)}${h.availabilityPct != null ? `・近 90 天約 ${h.availabilityPct}% 的日子有點數房` : ''}</small>
      </div>
      <div class="hotel-price">
        <b>${fmt(s.points)} 點</b><small>${h.standard ? '標準房' : '套房'}・${n} 晚・${p.flex && s.date !== p.date ? '最便宜 ' : ''}${dayLabel(s.date)} 入住</small>
        ${cash ? `<small>同一晚現金約 NT$${fmt(cash)}</small>` : ''}
        ${hotelValueHtml(h.source, s.cash, s.points)}
        ${h.suite && h.standard ? `<small>套房 ${fmt(h.suite.points)} 點（${dayLabel(h.suite.date)}）</small>` : ''}
        ${hotelAffordHtml(h.source, s.points)}
      </div>
      <div class="hotel-actions">
        <button type="button" class="outline" data-h-cal="${esc(h.id)}" aria-expanded="false">看每天點數</button>
        ${cashCfg.enabled ? `<button type="button" class="outline" data-h-cash="${esc(h.id)}" title="${dayLabel(s.date)} 入住 ${n} 晚，查各訂房網站和飯店官網的現金價">💵 現金價比一比</button>` : ''}
        ${h.lastChecked ? `<small class="${isStale(h.lastChecked) ? 'stale' : 'muted'}">${ago(h.lastChecked)}更新</small>` : ''}
      </div>
      <div class="hotel-cash" hidden></div>
      <div class="hotel-cal" hidden></div>
    </article>`;
  };
  out.innerHTML = head + (list.length ? `<div class="hotel-list">${list.map(card).join('')}</div>` : `<p class="hint">${hotelState.affordOnly ? '用你的點數換得起的飯店都沒有空房，關掉「只看我換得起的」看看全部。' : '這段日期沒有找到點數房。可以放寬日期彈性、換晚數，或換個城市。'}</p>`)
    + `<p class="hint">點數價是整段住宿合計；「每點約」是同一晚現金價除以點數，好價代表高於 The Points Guy 估值的 1.3 倍。點數房會變動，訂房前以飯店官網為準。資料約每 1 到 3 週更新一次，太久沒更新的會以灰字標示。</p>`;
  $('#h-sort', out)?.addEventListener('change', (e) => { hotelState.sort = e.target.value; renderHotels(); });
  $('#h-afford', out)?.addEventListener('change', (e) => { hotelState.affordOnly = e.target.checked; renderHotels(); });
}

// One hotel's nights as a 7-column calendar (like the award one); tapping a night shows its details below.
async function openHotelCalendar(id, card) {
  const box = $('.hotel-cal', card);
  const btn = $('[data-h-cal]', card);
  if (!box.hidden && box.innerHTML) { box.hidden = true; btn.setAttribute('aria-expanded', 'false'); return; }
  box.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  box.innerHTML = skeleton(3);
  const p = hotelState.params;
  try {
    const body = await api(`/api/hotels/calendar?${new URLSearchParams({ hotel: id, start: p.start, end: p.end, nights: p.nights })}`);
    const rows = body.dates;
    if (!rows.length) { box.innerHTML = '<p class="hint">這段日期沒有資料。</p>'; return; }
    const source = body.hotel?.source || rows[0].source;
    const byDate = new Map(rows.map((r) => [r.arrival, r]));
    const pts = (r) => r?.standard?.points || r?.suite?.points || 0;
    const uniq = [...new Set(rows.map(pts).filter(Boolean))].sort((a, b) => a - b);
    const level = (v) => (uniq.length === 1 ? 4 : 4 - Math.min(3, Math.floor((uniq.indexOf(v) / (uniq.length - 1)) * 4)));
    const first = rows[0].arrival;
    const last = rows.at(-1).arrival;
    const cells = DOW.map((d) => `<div class="dow">${d}</div>`);
    for (let i = 0; i < new Date(first + 'T00:00:00Z').getUTCDay(); i++) cells.push('<div class="day pad"></div>');
    for (let d = first; d <= last; d = isoDateFrom(d, 1)) {
      const r = byDate.get(d);
      const v = pts(r);
      const good = r && (r.standard?.points ? twdPerPoint(r.standard.cash, r.standard.points) : null) >= (typicalTwd(source) || Infinity) * HOTEL_GOOD;
      cells.push(v
        ? `<button type="button" class="day has h${level(v)}${good ? ' good' : ''}" data-h-day="${d}" aria-pressed="false" title="${dayLabel(d)} ${fmt(v)} 點">${mmdd(d)}<b>${kfmt(v)}</b></button>`
        : `<div class="day">${mmdd(d)}<b>—</b></div>`);
    }
    box.innerHTML = `<div class="cal mini h-cal">${cells.join('')}</div>
      <div class="legend">便宜 <i style="background:var(--heat-4)"></i><i style="background:var(--heat-3)"></i><i style="background:var(--heat-2)"></i><i style="background:var(--heat-1)"></i> 較貴（${p.nights} 晚點數）　<span class="h-good-key">☀ 框＝好價</span></div>
      <div class="h-day-detail"><p class="hint">點一天看標準房、套房、現金價和房型。</p></div>`;
    box.onclick = (e) => {
      const b = e.target.closest('[data-h-day]');
      if (!b) return;
      $$('[data-h-day]', box).forEach((x) => { x.classList.toggle('sel', x === b); x.setAttribute('aria-pressed', String(x === b)); });
      $('.h-day-detail', box).innerHTML = hotelDayHtml(byDate.get(b.dataset.hDay), source, p.nights);
    };
  } catch (e) {
    box.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}
function hotelDayHtml(r, source, nights) {
  const line = (label, c) => `<div><span>${label}</span>${c?.points ? `<b>${fmt(c.points)} 點</b>${hotelValueHtml(source, c.cash, c.points)}` : '<span class="muted">沒有點數房</span>'}</div>`;
  const cash = toTwd(r.standard?.cash);
  return `<div class="h-day">
    <b class="h-day-title">${dayLabel(r.arrival)} 入住 ${nights} 晚</b>
    <div class="h-cash-sum">${line('標準房', r.standard)}${line('套房', r.suite)}<div><span>現金價</span><b>${cash ? `NT$${fmt(cash)}` : '—'}</b></div></div>
    <div class="h-day-actions"><button type="button" class="outline" data-h-rooms="${esc(r.id)}">看房型</button>${r.booking ? `<a class="outline btn" href="${esc(r.booking.url)}" target="_blank" rel="noopener">訂房 ↗</a>` : ''}</div>
    <div class="h-rooms-box" hidden></div>
  </div>`;
}

async function openHotelRooms(id, btn) {
  const box = btn.closest('.h-day').querySelector('.h-rooms-box');
  if (!box.hidden) { box.hidden = true; return; }
  box.hidden = false;
  box.textContent = '載入中…';
  try {
    const body = await api(`/api/hotels/rooms?${new URLSearchParams({ id })}`);
    box.innerHTML = body.rooms.length ? `<ul class="h-rooms">${body.rooms.map((r) => `<li>${esc(r.name)}${r.suite ? ' <span class="pill">套房</span>' : ''}　${r.points ? `<b>${fmt(r.points)} 點</b>` : '沒有點數房'}${toTwd(r.cash) ? `・現金約 NT$${fmt(toTwd(r.cash))}` : ''}</li>`).join('')}</ul>` : '沒有房型資料。';
  } catch (e) {
    box.innerHTML = `<span class="error">${esc(e.message)}</span>`;
  }
}

// Booking may answer with a different property (sold out → alternatives); say so instead of showing it as this hotel.
function otherHotelNote(h, body) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9一-鿿]+/g, ' ').trim();
  if (!body.name || norm(body.name) === norm(h.name)) return '';
  return `<p class="hint warn-hint">⚠ 找到的是「${esc(body.name)}」，名稱和這張卡片不同，可能不是同一家飯店，請點進去確認。</p>`;
}

// Cash prices for the stay on the card: every booking site and the hotel's own site (SerpApi), or Booking.com (RapidAPI).
function hotelCashHtml(h, body) {
  const s = h.standard || h.suite;
  const value = (twd) => hotelValueHtml(h.source, { amount: twd, currency: 'TWD' }, s.points);
  const other = body.provider === 'serpapi'
    ? !cashCfg.calendar ? '' : '<button type="button" class="linklike" data-h-cash-src="booking">改查 Booking.com 價（用 2 次查價）</button>'
    : cashCfg.serp !== false ? '<button type="button" class="linklike" data-h-cash-src="serpapi">查各網站與官網價（用 1–2 次查價）</button>' : '';
  const fell = body.fallback ? `<p class="hint">${esc(body.fallback)}，這次改查 Booking.com。</p>` : '';
  if (!body.found) return `${fell}<p class="hint">${body.provider === 'booking' ? 'Booking.com' : 'Google 飯店'}找不到這家飯店，可能名稱不同。${other}</p>`;
  const nights = s.nights || hotelState.params.nights;
  if (body.provider === 'booking') {
    return `${fell}${otherHotelNote(h, body)}<div class="h-cash-line"><b>Booking.com</b>${body.soldOut || !body.total ? '<span>這幾晚已售完或沒有報價</span>' : `<span><b>NT$${fmt(body.total)}</b>（${nights} 晚含稅總價）${value(body.total)}</span>`}
      ${body.url ? `<a href="${esc(body.url)}" target="_blank" rel="noopener">前往 Booking.com ↗</a>` : ''}</div>
      <p class="hint">${body.mock ? '示範資料。' : ''}${body.bookingLeft != null ? `Booking.com 查價本月還剩 ${fmt(body.bookingLeft)}${body.bookingLimit ? `／${fmt(body.bookingLimit)}` : ''} 次。` : ''}${other}</p>`;
  }
  const official = body.prices.find((p) => p.official);
  const low = body.prices[0];
  return `${fell}${otherHotelNote(h, body)}<div class="h-cash-sum">
      ${low ? `<div><span>最低</span><b>NT$${fmt(low.total)}</b><small>${esc(low.source)}${low.official ? '（官網）' : ''}</small>${value(low.total)}</div>` : ''}
      ${official ? `<div><span>飯店官網</span><b>NT$${fmt(official.total)}</b><small>${official === low ? '官網就是最低價' : `比最低貴 NT$${fmt(official.total - low.total)}`}</small></div>` : '<div><span>飯店官網</span><small>Google 這次沒有列出官網價</small></div>'}
      ${body.typical?.[0] ? `<div><span>平常每晚</span><b>NT$${fmt(body.typical[0])}–${fmt(body.typical[1])}</b></div>` : ''}
    </div>
    ${body.prices.length ? `<div class="table-wrap"><table class="h-cash-table"><thead><tr><th>網站</th><th>每晚</th><th>總價</th><th></th></tr></thead><tbody>
      ${body.prices.map((p) => `<tr${p.official ? ' class="official"' : ''}><td>${esc(p.source)}${p.official ? ' <span class="pill">官網</span>' : ''}${p.freeCancel ? ' <small class="ok-text">可免費取消</small>' : ''}</td>
        <td data-l="每晚">${p.perNight ? `NT$${fmt(p.perNight)}` : '—'}</td><td data-l="總價"><b>${p.total ? `NT$${fmt(p.total)}` : '—'}</b></td>
        <td>${p.link ? `<a href="${esc(p.link)}" target="_blank" rel="noopener">前往 ↗</a>` : ''}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="hint">這幾晚 Google 沒有報價，可能已售完。</p>'}
    <p class="hint">${body.mock ? '示範資料。' : ''}價格含稅、${nights} 晚總價，來自 Google 飯店；用了 ${body.credits || 1} 次查價${body.serpLeft != null ? `，這個來源本月還剩 ${fmt(body.serpLeft)} 次` : ''}。${other}</p>`;
}
async function openHotelCash(id, card, src = 'serpapi', force = false) {
  const box = $('.hotel-cash', card);
  if (!force && !box.hidden && box.innerHTML) { box.hidden = true; return; }
  const h = hotelState.results.hotels.find((x) => x.id === id);
  if (!h) return;
  const s = h.standard || h.suite;
  const nights = s.nights || hotelState.params.nights;
  box.hidden = false;
  box.innerHTML = `<p class="hint">正在查 ${dayLabel(s.date)} 入住 ${nights} 晚的現金價…</p>`;
  const p = new URLSearchParams({ name: h.name, city: h.city || '', checkin: s.date, checkout: isoDateFrom(s.date, nights), adults: '2', src });
  if (h.lat != null && h.lon != null) { p.set('lat', h.lat); p.set('lon', h.lon); }
  try {
    const body = await cashApi(`/api/hotels/cash?${p}`);
    box.innerHTML = hotelCashHtml(h, body);
    $$('[data-h-cash-src]', box).forEach((b) => b.addEventListener('click', () => openHotelCash(id, card, b.dataset.hCashSrc, true)));
    loadCashQuota();
  } catch (e) {
    box.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}

document.addEventListener('click', (e) => {
  const hc = e.target.closest?.('[data-h-cash]');
  if (hc) { openHotelCash(hc.dataset.hCash, hc.closest('.hotel')); return; }
  const cal = e.target.closest?.('[data-h-cal]');
  if (cal) { openHotelCalendar(cal.dataset.hCal, cal.closest('.hotel')); return; }
  const rooms = e.target.closest?.('[data-h-rooms]');
  if (rooms) openHotelRooms(rooms.dataset.hRooms, rooms);
});
