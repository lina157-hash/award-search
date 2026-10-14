// 查飯店: hotel award nights (points) from rooms.aero, valued against the cash rate and the user's own points.
// Classic script loaded after app.js and features.js; shares their globals ($, esc, fmt, api, store, wallet, reachHotel…).

const HOTEL_NAMES = { marriott: '萬豪 Bonvoy', hilton: '希爾頓 Honors', ihg: '洲際 IHG', hyatt: '凱悅 World of Hyatt', choice: 'Choice', wyndham: '溫德姆 Wyndham', iprefer: 'I Prefer' };
const HOTEL_SHORT = { marriott: '萬豪', hilton: '希爾頓', ihg: '洲際', hyatt: '凱悅', choice: 'Choice', wyndham: '溫德姆', iprefer: 'I Prefer' };
// Typical value of one point in US cents (The Points Guy, 2026/10). A stay worth 30% more than this is marked as a good use.
const POINT_VALUE_CENTS = { marriott: 0.75, hilton: 0.4, ihg: 0.6, hyatt: 1.7 };
const HOTEL_GOOD = 1.3;
const HOTEL_KEY = 'hotelSearch:v1';
const weekday = (iso) => '日一二三四五六'[new Date(iso + 'T00:00:00Z').getUTCDay()];
seq.hotels = 0;
const hotelState = { where: '', date: '', flex: 7, nights: 1, programs: ['marriott', 'hilton', 'ihg', 'hyatt'], sort: 'points', affordOnly: false, results: null, params: null };

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

function hotelsHtml() {
  const s = hotelState;
  const chk = (k) => `<label><input type="checkbox" name="h-prog" value="${k}" ${s.programs.includes(k) ? 'checked' : ''}><span>${HOTEL_SHORT[k]}</span></label>`;
  return `<form id="hotel-form" class="search-card" autocomplete="off">
    <div class="opts-row">
      <label class="field grow">城市或地區<input name="where" list="h-where-list" placeholder="例如 東京、曼谷、Bali" value="${esc(s.where)}" required></label>
      <datalist id="h-where-list"></datalist>
      <label class="field">入住日期<input type="date" name="date" value="${esc(s.date)}" required></label>
      <label class="field">日期彈性<select name="flex">${[[0, '只看這天'], [3, '前後 3 天'], [7, '前後 7 天'], [14, '前後 14 天']].map(([v, l]) => `<option value="${v}" ${s.flex === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="field">住幾晚<select name="nights">${[1, 2, 3, 4, 5].map((n) => `<option value="${n}" ${s.nights === n ? 'selected' : ''}>${n} 晚</option>`).join('')}</select></label>
    </div>
    <div class="opts-row">
      <fieldset class="seg h-progs" aria-label="飯店集團">${['marriott', 'hilton', 'ihg', 'hyatt'].map(chk).join('')}</fieldset>
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
  airportsReady.then(() => { $('#h-where-list').innerHTML = [...hotelPlaces().keys()].map((k) => `<option value="${esc(k)}"></option>`).join(''); });
  $('#hotel-form').addEventListener('submit', (e) => { e.preventDefault(); searchHotels(); });
}

async function searchHotels() {
  const f = $('#hotel-form');
  const programs = $$('input[name=h-prog]:checked', f).map((i) => i.value);
  if (!programs.length) { toast('請至少選一個飯店集團'); return; }
  Object.assign(hotelState, { where: f.where.value.trim(), date: f.date.value, flex: Number(f.flex.value), nights: Number(f.nights.value), programs });
  store.set(HOTEL_KEY, { where: hotelState.where, flex: hotelState.flex, nights: hotelState.nights, programs, sort: hotelState.sort });
  const { date, flex } = hotelState;
  const start = flex && isoDateFrom(date, -flex) > isoDate(0) ? isoDateFrom(date, -flex) : flex ? isoDate(0) : date;
  const params = { where: placeQuery(hotelState.where), start, end: isoDateFrom(date, flex), nights: hotelState.nights, programs: programs.join(',') };
  const status = $('#hotels-status');
  const out = $('#hotels-results');
  const fresh = latest('hotels');
  status.textContent = '搜尋中…';
  out.innerHTML = skeleton(4);
  try {
    const [body] = await Promise.all([api(`/api/hotels/search?${new URLSearchParams(params)}`), fxCache || api('/api/fx').then((x) => (fxCache = x))]);
    if (!fresh()) return;
    hotelState.results = body;
    hotelState.params = params;
    status.textContent = '';
    renderHotels();
  } catch (e) {
    if (!fresh()) return;
    status.textContent = '';
    out.innerHTML = `<p class="error">${esc(e.message)}</p>`;
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
  const n = hotelState.params.nights;
  const head = `<div class="h-bar">
    <span>${body.mock ? '<b>示範資料</b>・' : ''}找到 ${fmt(list.length)} 家有點數房的飯店${body.hasMore ? '（只列前 100 家）' : ''}</span>
    <label class="field compact">排序<select id="h-sort"><option value="points" ${hotelState.sort === 'points' ? 'selected' : ''}>點數最少</option><option value="value" ${hotelState.sort === 'value' ? 'selected' : ''}>每點最值錢</option></select></label>
    ${walletEmpty() ? '' : `<label class="switch"><input type="checkbox" id="h-afford" ${hotelState.affordOnly ? 'checked' : ''}><span class="knob"></span>只看我換得起的</label>`}
  </div>`;
  const card = (h) => {
    const s = h.standard || h.suite;
    const cash = toTwd(s.cash);
    return `<article class="hotel" data-hotel="${esc(h.id)}">
      <div class="hotel-main">
        <div><span class="pill h-${esc(h.source)}">${esc(HOTEL_SHORT[h.source] || h.program)}</span>${h.category ? ` <small>第 ${esc(h.category)} 類</small>` : ''}</div>
        <h3>${esc(h.name)}</h3>
        <small class="muted">${esc([h.city, h.country].filter(Boolean).join('，'))}${h.availabilityPct != null ? `・近 90 天約 ${h.availabilityPct}% 的日子有點數房` : ''}</small>
      </div>
      <div class="hotel-price">
        <b>${fmt(s.points)} 點</b><small>${h.standard ? '標準房' : '套房'}・${n} 晚・${mmdd(s.date)} 入住</small>
        ${cash ? `<small>同一晚現金約 NT$${fmt(cash)}</small>` : ''}
        ${hotelValueHtml(h.source, s.cash, s.points)}
        ${h.suite && h.standard ? `<small>套房 ${fmt(h.suite.points)} 點（${mmdd(h.suite.date)}）</small>` : ''}
        ${hotelAffordHtml(h.source, s.points)}
      </div>
      <div class="hotel-actions">
        <button type="button" class="outline" data-h-cal="${esc(h.id)}">看每天點數</button>
        ${cashCfg.enabled ? `<button type="button" class="outline" data-h-cash="${esc(h.id)}" title="${mmdd(s.date)} 入住 ${n} 晚，查各訂房網站和飯店官網的現金價">💵 現金價比一比</button>` : ''}
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

// One hotel's calendar around the searched dates, then room types for one stay on demand.
async function openHotelCalendar(id, card) {
  const box = $('.hotel-cal', card);
  if (!box.hidden && box.innerHTML) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = skeleton(3);
  const p = hotelState.params;
  try {
    const body = await api(`/api/hotels/calendar?${new URLSearchParams({ hotel: id, start: p.start, end: p.end, nights: p.nights })}`);
    const rows = body.dates;
    if (!rows.length) { box.innerHTML = '<p class="hint">這段日期沒有資料。</p>'; return; }
    const source = body.hotel?.source || rows[0].source;
    const cell = (c) => (c?.points ? `<b>${fmt(c.points)} 點</b>${hotelValueHtml(source, c.cash, c.points)}` : '<span class="muted">—</span>');
    box.innerHTML = `<div class="table-wrap"><table class="hotel-days"><thead><tr><th>入住</th><th>標準房</th><th>套房</th><th>現金價</th><th></th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${mmdd(r.arrival)}<small>週${weekday(r.arrival)}</small></td>
        <td data-l="標準房">${cell(r.standard)}</td><td data-l="套房">${cell(r.suite)}</td><td data-l="現金價">${toTwd(r.standard?.cash) ? `NT$${fmt(toTwd(r.standard.cash))}` : '—'}</td>
        <td><button type="button" class="linklike" data-h-rooms="${esc(r.id)}">房型</button>${r.booking ? ` <a href="${esc(r.booking.url)}" target="_blank" rel="noopener">訂房 ↗</a>` : ''}</td></tr>
        <tr class="h-rooms-row" hidden><td colspan="5"></td></tr>`).join('')}
      </tbody></table></div>`;
  } catch (e) {
    box.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}

async function openHotelRooms(id, btn) {
  const row = btn.closest('tr').nextElementSibling;
  const td = row.firstElementChild;
  if (!row.hidden) { row.hidden = true; return; }
  row.hidden = false;
  td.textContent = '載入中…';
  try {
    const body = await api(`/api/hotels/rooms?${new URLSearchParams({ id })}`);
    td.innerHTML = body.rooms.length ? `<ul class="h-rooms">${body.rooms.map((r) => `<li>${esc(r.name)}${r.suite ? ' <span class="pill">套房</span>' : ''}　${r.points ? `<b>${fmt(r.points)} 點</b>` : '沒有點數房'}${toTwd(r.cash) ? `・現金約 NT$${fmt(toTwd(r.cash))}` : ''}</li>`).join('')}</ul>` : '沒有房型資料。';
  } catch (e) {
    td.innerHTML = `<span class="error">${esc(e.message)}</span>`;
  }
}

// Cash prices for the stay on the card: every booking site and the hotel's own site (SerpApi), or Booking.com (RapidAPI).
function hotelCashHtml(h, body) {
  const s = h.standard || h.suite;
  const value = (twd) => hotelValueHtml(h.source, { amount: twd, currency: 'TWD' }, s.points);
  const other = body.provider === 'serpapi'
    ? !cashCfg.calendar ? '' : '<button type="button" class="linklike" data-h-cash-src="booking">改查 Booking.com 價（RapidAPI，用 2 次）</button>'
    : cashCfg.serp !== false ? '<button type="button" class="linklike" data-h-cash-src="serpapi">查各網站與官網價（SerpApi，用 1–2 次）</button>' : '';
  const fell = body.fallback ? `<p class="hint">${esc(body.fallback)}，這次改查 Booking.com。</p>` : '';
  if (!body.found) return `${fell}<p class="hint">${body.provider === 'booking' ? 'Booking.com' : 'Google 飯店'}找不到這家飯店，可能名稱不同。${other}</p>`;
  if (body.provider === 'booking') {
    return `${fell}<div class="h-cash-line"><b>Booking.com</b>${body.soldOut || !body.total ? '<span>這幾晚已售完或沒有報價</span>' : `<span><b>NT$${fmt(body.total)}</b>（${s.nights || hotelState.params.nights} 晚含稅總價）${value(body.total)}</span>`}
      ${body.url ? `<a href="${esc(body.url)}" target="_blank" rel="noopener">前往 Booking.com ↗</a>` : ''}</div>
      <p class="hint">${body.mock ? '示範資料。' : ''}${body.bookingLeft != null ? `Booking.com API 本月剩 ${fmt(body.bookingLeft)}${body.bookingLimit ? `／${fmt(body.bookingLimit)}` : ''} 次。` : ''}${other}</p>`;
  }
  const official = body.prices.find((p) => p.official);
  const low = body.prices[0];
  return `${fell}<div class="h-cash-sum">
      ${low ? `<div><span>最低</span><b>NT$${fmt(low.total)}</b><small>${esc(low.source)}${low.official ? '（官網）' : ''}</small>${value(low.total)}</div>` : ''}
      ${official ? `<div><span>飯店官網</span><b>NT$${fmt(official.total)}</b><small>${official === low ? '官網就是最低價' : `比最低貴 NT$${fmt(official.total - low.total)}`}</small></div>` : '<div><span>飯店官網</span><small>Google 這次沒有列出官網價</small></div>'}
      ${body.typical?.[0] ? `<div><span>平常每晚</span><b>NT$${fmt(body.typical[0])}–${fmt(body.typical[1])}</b></div>` : ''}
    </div>
    ${body.prices.length ? `<div class="table-wrap"><table class="h-cash-table"><thead><tr><th>網站</th><th>每晚</th><th>總價</th><th></th></tr></thead><tbody>
      ${body.prices.map((p) => `<tr${p.official ? ' class="official"' : ''}><td>${esc(p.source)}${p.official ? ' <span class="pill">官網</span>' : ''}${p.freeCancel ? ' <small class="ok-text">可免費取消</small>' : ''}</td>
        <td data-l="每晚">${p.perNight ? `NT$${fmt(p.perNight)}` : '—'}</td><td data-l="總價"><b>${p.total ? `NT$${fmt(p.total)}` : '—'}</b></td>
        <td>${p.link ? `<a href="${esc(p.link)}" target="_blank" rel="noopener">前往 ↗</a>` : ''}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="hint">這幾晚 Google 沒有報價，可能已售完。</p>'}
    <p class="hint">${body.mock ? '示範資料。' : ''}價格含稅、${s.nights || hotelState.params.nights} 晚總價，來自 Google 飯店；用了 ${body.credits || 1} 次 SerpApi 額度${body.serpLeft != null ? `，本月剩 ${fmt(body.serpLeft)} 次` : ''}。${other}</p>`;
}
async function openHotelCash(id, card, src = 'serpapi', force = false) {
  const box = $('.hotel-cash', card);
  if (!force && !box.hidden && box.innerHTML) { box.hidden = true; return; }
  const h = hotelState.results.hotels.find((x) => x.id === id);
  if (!h) return;
  const s = h.standard || h.suite;
  const nights = s.nights || hotelState.params.nights;
  box.hidden = false;
  box.innerHTML = `<p class="hint">正在查 ${mmdd(s.date)} 入住 ${nights} 晚的現金價…</p>`;
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
