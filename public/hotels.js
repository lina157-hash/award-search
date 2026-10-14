// 查飯店: hotel award nights (points) from rooms.aero, valued against the cash rate and the user's own points.
// Classic script loaded after app.js and features.js; shares their globals ($, esc, fmt, api, store, wallet, reachHotel…).

const HOTEL_NAMES = { marriott: '萬豪 Bonvoy', hilton: '希爾頓 Honors', ihg: '洲際 IHG', hyatt: '凱悅 World of Hyatt', choice: 'Choice', wyndham: '溫德姆 Wyndham', iprefer: 'I Prefer' };
const HOTEL_SHORT = { marriott: '萬豪', hilton: '希爾頓', ihg: '洲際', hyatt: '凱悅', choice: 'Choice', wyndham: '溫德姆', iprefer: 'I Prefer', accor: '雅高', shangrila: '香格里拉' };
// rooms.aero chains; 雅高 is priced from Booking.com cash rates (quota, passcode), 香格里拉 only links to its own site.
const ROOMS_PROGRAMS = ['marriott', 'hilton', 'ihg', 'hyatt'];
// Shangri-La publishes no search URL that takes a city and dates (checked 2026-10), so these are the stable pages.
const SL_REDEEM_URL = 'https://www.shangri-la.com/en/corporate/shangrilacircle/redeem-points/';
const SL_HOTELS_URL = 'https://www.shangri-la.com/en/find-a-hotel/';
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
  const chk = (k, title = '') => `<label class="h-chip"${title ? ` title="${esc(title)}"` : ''}><input type="checkbox" name="h-prog" value="${k}" ${s.programs.includes(k) ? 'checked' : ''}><span>${HOTEL_SHORT[k]}${k === 'accor' ? '<small>用額度</small>' : ''}</span></label>`;
  const extra = [cashCfg.accor ? chk('accor', '用 Booking.com 的房價換算 ALL 點數，每次搜尋約用 2 到 10 次 Booking.com 查價額度（雅高飯店多的城市要翻好幾頁，每頁再多 1 次查中文名稱）（6 小時內同城市同日期不再花）') : '', chk('shangrila', '香格里拉的點數價不公開，會給你官網的連結')].join('');
  return `<form id="hotel-form" class="search-card" autocomplete="off" novalidate>
    <div class="opts-row h-row">
      <label class="field h-where">城市或地區<input name="where" list="h-where-list" placeholder="例如 東京、曼谷、Bali" value="${esc(s.where)}"></label>
      <datalist id="h-where-list"></datalist>
      <div class="field dp-field single h-date"><span>入住日期</span><button type="button" class="dp-btn" aria-haspopup="dialog"></button><input type="hidden" name="date" value="${esc(s.date)}"></div>
      <label class="field h-small">日期彈性<select name="flex">${[[0, '只看這天'], [3, '前後 3 天'], [7, '前後 7 天'], [14, '前後 14 天']].map(([v, l]) => `<option value="${v}" ${s.flex === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="field h-small">住幾晚<select name="nights">${[1, 2, 3, 4, 5].map((n) => `<option value="${n}" ${s.nights === n ? 'selected' : ''}>${n} 晚</option>`).join('')}</select></label>
    </div>
    <div class="opts-row">
      <fieldset class="h-progs" aria-label="飯店集團（可複選）"><legend class="sr-only">飯店集團（可複選）</legend>${ROOMS_PROGRAMS.map((k) => chk(k)).join('')}${extra}</fieldset>
      <button type="submit" class="primary big">搜尋點數房</button>
    </div>
    <p class="hint">萬豪、希爾頓、洲際、凱悅的點數房價來自 rooms.aero。雅高沒有點數房：ALL 點數固定 2,000 點折 €40，${cashCfg.accor ? '勾「雅高」會用 Booking.com 的房價換算成點數（要通關密碼、會用查價額度）' : '可以直接用現金價換算'}。香格里拉的點數價不公開，勾選後會給你官網的連結。</p>
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
  const rooms = programs.filter((k) => ROOMS_PROGRAMS.includes(k));
  const out = $('#hotels-results');
  const fresh = latest('hotels');
  hotelState.results = null;
  status.className = 'status';
  status.textContent = rooms.length ? '搜尋中…' : '';
  out.innerHTML = `<div id="h-rooms-out">${rooms.length ? skeleton(4) : ''}</div><div id="h-accor-out"></div><div id="h-sl-out"></div>`;
  if (programs.includes('shangrila')) $('#h-sl-out').innerHTML = shangrilaHtml();
  const done = busy($('button[type=submit]', f), '搜尋中…');
  reveal(status);
  try {
    await loadAirports(); // Chinese city names → English place names
    const accor = programs.includes('accor') && cashCfg.accor ? searchAccor(fresh) : null;
    if (!rooms.length) {
      await accor;
      if (fresh()) done();
      return;
    }
    const start = flex && isoDateFrom(date, -flex) > isoDate(0) ? isoDateFrom(date, -flex) : flex ? isoDate(0) : date;
    const params = { where: placeQuery(hotelState.where), start, end: isoDateFrom(date, flex), nights: hotelState.nights, programs: rooms.join(',') };
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
    $('#h-rooms-out').innerHTML = '';
    showError(status, e, searchHotels);
  }
}

// ---------- 雅高 ALL: Booking.com cash rates turned into points (GET /api/hotels/accor, passcode, ≤2 Booking requests) ----------
async function searchAccor(fresh) {
  const box = $('#h-accor-out');
  const { where, date, nights } = hotelState;
  const head = `<h2 class="section">雅高 ALL <small>${esc(where)}・${dayLabel(date)} 入住 ${nights} 晚・2 人</small></h2>`;
  box.innerHTML = `${head}<p class="hint">正在查 Booking.com 上的雅高飯店…</p>${skeleton(2)}`;
  try {
    const q = new URLSearchParams({ city: placeQuery(where), checkin: date, checkout: isoDateFrom(date, nights), adults: '2' });
    const [body] = await Promise.all([cashApi(`/api/hotels/accor?${q}`), loadFx()]);
    if (!fresh()) return;
    box.innerHTML = head + accorHtml(body, nights);
    loadCashQuota();
  } catch (e) {
    if (!fresh()) return;
    const msg = e.code === 'passcode' || /通關密碼/.test(e.message) ? '需要通關密碼才能查雅高飯店（會用 Booking.com 查價額度）。' : e.message;
    box.innerHTML = `${head}<p class="status error"><span>${esc(msg)}</span><button type="button" class="outline" data-accor-retry>重試</button></p>`;
    $('[data-accor-retry]', box).addEventListener('click', () => searchAccor(fresh));
  }
}
function accorHtml(body, nights) {
  const rule = body.rule || {};
  const list = body.hotels || [];
  const ptsLine = (h) => {
    if (!h.points) return '';
    const left = h.usablePoints < h.points && h.cashLeftTwd > 0
      ? `<small>${h.usablePoints ? `一次最多折 ${fmt(h.usablePoints)} 點，剩 NT$${fmt(h.cashLeftTwd)} 刷卡` : `不到最低 ${fmt(rule.minPoints || 1000)} 點，不能用點數折`}</small>` : '';
    return `<small class="h-pts">約 <b>${fmt(h.points)} 點</b>（ALL 每 2,000 點折 €40）</small>${left}${hotelAffordHtml('accor', h.usablePoints || h.points)}`;
  };
  const card = (h) => `<article class="hotel h-accor${h.soldOut ? ' sold-out' : ''}">
      <div class="hotel-main">
        <div><span class="pill h-accor">雅高</span> <small class="inline">${esc(h.brand)}${h.brandZh ? ` ${esc(h.brandZh)}` : ''}</small>${h.stars ? ` <small class="inline stars" title="${h.stars} 星">${'★'.repeat(Math.round(h.stars))}</small>` : ''}</div>
        <h3>${esc(h.name)}</h3>${h.nameZh ? `<small class="h-zh">${esc(h.nameZh)}</small>` : ''}
      </div>
      <div class="hotel-price">
        ${h.soldOut ? '<b class="muted">這幾晚已售完</b><small>或 Booking.com 沒有報價</small>' : `<b>NT$${fmt(h.total)}</b><small>${nights} 晚含稅總價</small>${ptsLine(h)}`}
      </div>
      <div class="hotel-actions">${h.url ? `<a class="outline btn" href="${esc(h.url)}" target="_blank" rel="noopener">Booking.com ↗</a>` : ''}</div>
    </article>`;
  const quota = `${body.mock ? '示範資料。' : ''}${body.cached ? '剛有人查過同一個城市和日期，這次沒有用到額度。' : body.requests ? `用了 ${body.requests} 次 Booking.com 查價。` : ''}${body.bookingLeft != null ? `本月 Booking.com 剩 ${fmt(body.bookingLeft)} 次。` : ''}`;
  const src = [rule.source && `<a href="${esc(rule.source)}" target="_blank" rel="noopener">ALL 會員條款 ↗</a>`, rule.sourceOnline && `<a href="${esc(rule.sourceOnline)}" target="_blank" rel="noopener">線上折抵說明 ↗</a>`].filter(Boolean).join('　');
  return (!body.found || !list.length
    ? `<p class="hint">${!body.found
      ? `Booking.com 認不出「${esc(hotelState.where)}」這個城市，換個寫法（例如英文）試試。`
      : body.scanned
        ? `Booking.com 的「${esc(body.city || hotelState.where)}」最熱門的 ${body.scanned} 家飯店裡，沒有雅高旗下的飯店。`
        : `Booking.com 這次沒有回傳「${esc(body.city || hotelState.where)}」的飯店，可能這幾晚沒有空房或資料來源暫時有問題。`}${body.cityUrl ? ` <a href="${esc(body.cityUrl)}" target="_blank" rel="noopener">在 Booking.com 看這個城市 ↗</a>` : ''}</p>`
    : `<p class="hint">Booking.com 上的雅高飯店${body.more ? `太多了，只列最便宜的 ${list.length} 家` : `共 ${list.length} 家`}，便宜的在前。雅高沒有點數房，點數是用房價換算的${body.pointValueTwd ? `，每點約 NT$${body.pointValueTwd}` : ''}。</p>
      <div class="hotel-list">${list.map(card).join('')}</div>`)
    + `${rule.text ? `<p class="hint h-rule">📘 ${esc(rule.text)} ${src}</p>` : ''}<p class="hint">${quota}</p>`;
}

// ---------- 香格里拉 Circle: points prices are not public, so only a way to the official site ----------
function shangrilaHtml() {
  const { where, date, nights } = hotelState;
  const r = !walletEmpty() && hotelPrograms().shangrila ? reachHotel('shangrila') : null;
  return `<h2 class="section">香格里拉 Circle</h2>
    <article class="hotel h-sl">
      <div class="hotel-main">
        <div><span class="pill h-shangrila">香格里拉</span></div>
        <h3>點數房價沒有公開</h3>
        <small class="muted">香格里拉 Circle 的點數價要登入會員、在官網選好飯店和日期才看得到，也沒有可以直接帶入城市和日期的公開網址，所以這裡沒辦法替你查。到官網登入後，搜尋 <b>${esc(where)}</b>、${dayLabel(date)} 入住 ${nights} 晚就能看到。</small>
        ${r?.total ? `<small class="ok-text">你的點數最多可湊到 ${fmt(r.total)} 點香格里拉 Circle 點數</small>` : ''}
      </div>
      <div class="hotel-actions">
        <a class="outline btn primary-link" href="${SL_REDEEM_URL}" target="_blank" rel="noopener">到香格里拉官網查點數價 ↗</a>
        <a href="${SL_HOTELS_URL}" target="_blank" rel="noopener">香格里拉所有飯店 ↗</a>
      </div>
    </article>`;
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
  const out = $('#h-rooms-out');
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
  if (!out) return;
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
      <p class="hint">${body.mock ? '示範資料。' : ''}${body.cached ? '剛查過，這次沒有用到額度。' : ''}${body.bookingLeft != null ? `Booking.com 查價本月還剩 ${fmt(body.bookingLeft)}${body.bookingLimit ? `／${fmt(body.bookingLimit)}` : ''} 次。` : ''}${other}</p>`;
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
    <p class="hint">${body.mock ? '示範資料。' : ''}價格含稅、${nights} 晚總價，來自 Google 飯店；${body.cached ? '剛查過，這次沒有用到額度' : `用了 ${body.credits || 1} 次查價`}${body.serpLeft != null ? `，這個來源本月還剩 ${fmt(body.serpLeft)} 次` : ''}。${other}</p>`;
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
