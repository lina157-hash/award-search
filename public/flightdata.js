// 官方航班資料 (round 9; the server's lib/flightdata.js, refreshed about weekly, no quota). For flights touching Taiwan:
//   - 誰飛直航 in 出發前小提醒 lists the flights (days, times, aircraft) and 桃園機場's terminal per airline;
//   - the award calendar marks days with no nonstop at all (這天沒有直飛班機) and a fold under it lists the route's
//     nonstop timetable, saying when a flight stops early in the season (這條直飛只飛到 3/28);
//   - 今日好康 gets a folded 即將開航 row (看座位, 開航後有位通知我);
//   - 我的行程 shows 桃園機場's terminal on legs from or to TPE;
//   - 「星期幾比較有位」 gets 各月載客率 (民航局, a year behind);
//   - 航班明細 (app.js tripHtml) gets layovers, +1 days and the time difference (ttTripExtras).
// Classic script, loaded with the search scripts (app.js SEARCH_SCRIPTS), the first 航班明細, 出發前小提醒 or 我的行程,
// and on the first screen when there are upcoming routes. Uses app.js globals.
/* global $, $$, esc, api, configP, state, AP, AL, airportCity, airlineZh, renderCalendar, wkRender, openAlertDialog, applyShare, isoDate, isoDateFrom, MAX_AHEAD_DAYS, dealsState, AIRCRAFT_NAMES, tzOffsetMin, tabParams */

const TT = { cfg: null, search: null, routes: new Map(), lf: new Map(), term: null, termP: null, upcoming: null };
// Taiwan's airports with scheduled international or cross-strait flights.
const TT_TW = new Set(['TPE', 'TSA', 'KHH', 'RMQ', 'TNN', 'CYI', 'HUN', 'TTT', 'MZG', 'KNH']);
const TT_WD = ['一', '二', '三', '四', '五', '六', '日'];
const ttCfg = () => (TT.cfg ||= (typeof configP !== 'undefined' ? configP : Promise.resolve({})).then((c) => c?.flightdata || {}));
const ttCodes = (v) => String(v || '').toUpperCase().split(/[\s,，、]+/).filter((c) => /^[A-Z]{3}$/.test(c)).slice(0, 4);
const ttTouches = (from, to) => [...from, ...to].some((c) => TT_TW.has(c));
const ttMd = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
const ttDow = (iso) => (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7;
const ttToday = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
// 每天, or 週一三五.
const ttDays = (mask) => (mask === 127 ? '每天' : `週${TT_WD.filter((_, i) => mask & (1 << i)).join('')}`);
const ttBits = (mask) => { let n = 0; for (let m = mask; m; m >>= 1) n += m & 1; return n; };
// Does this flight leave on `iso` (its departure date)?
const ttOn = (f, iso) => iso >= f.from && iso <= f.to && Boolean(f.days & (1 << ttDow(iso)));
// 長榮, 華航, 星宇 for the tight places.
const ttAl = (code) => { if (code === 'CI') return '華航'; const z = typeof airlineZh === 'function' ? airlineZh(code) : code; const s = z.replace(/航空$/, ''); return s.length >= 2 ? s : z; };
// 787-10 for 781, A350-900 for 359; a name as written otherwise.
function ttAc(ac) {
  if (!ac) return '';
  const n = (typeof AIRCRAFT_NAMES === 'object' && AIRCRAFT_NAMES[String(ac).toUpperCase()]) || ac;
  return n.replace(/^(Boeing|Airbus|Embraer)\s+/, '');
}
const ttSrc = (b) => (b.sources || [b.source]).filter(Boolean).map((s) => s.name).join('、');
const ttTime = (f) => `${esc(f.dep)}→${esc(f.arr)}${f.ad ? `<sup>${f.ad > 0 ? '+' : ''}${f.ad}</sup>` : ''}`;
// Stops before the season the file covers ends (more than a week early): a seasonal or ending flight.
const ttEndsEarly = (f, horizon) => horizon && f.to < isoDateFrom(horizon, -7);

function ttRoute(from, to) {
  const key = `${from.join(',')}>${to.join(',')}`;
  if (!TT.routes.has(key)) TT.routes.set(key, api(`/api/flightdata/route?${new URLSearchParams({ from: from.join(','), to: to.join(',') })}`).catch(() => ({ configured: false })));
  return TT.routes.get(key);
}
function ttLf(from, to) {
  const key = `${from.join(',')}>${to.join(',')}`;
  if (!TT.lf.has(key)) TT.lf.set(key, api(`/api/flightdata/lf?${new URLSearchParams({ from: from.join(','), to: to.join(',') })}`).catch(() => ({ configured: false })));
  return TT.lf.get(key);
}

// One flight on a line: 「BR16 每天 23:50→19:40+1（787-10），至 3/28」.
function ttFlightHtml(f, horizon, { pair = false } = {}) {
  const ends = ttEndsEarly(f, horizon) ? `，<b>只飛到 ${ttMd(f.to)}</b>` : '';
  const starts = f.from > ttToday() ? `，<b>${ttMd(f.from)} 起</b>` : '';
  return `<li><b title="${esc(airlineZh(f.al))}">${esc(f.fn)}</b> ${esc(ttAl(f.al))}・${ttDays(f.days)} ${ttTime(f)}${f.ac ? `（${esc(ttAc(f.ac))}）` : ''}${pair ? ` <small>${esc(f.o)}→${esc(f.d)}</small>` : ''}${starts}${ends}${f.cs?.length ? `<small class="hint">　共用班號 ${esc(f.cs.slice(0, 3).join('、'))}</small>` : ''}</li>`;
}
// Earliest departure first, one airline's flights together.
const ttSort = (list) => [...list].sort((a, b) => a.o.localeCompare(b.o) || a.d.localeCompare(b.d) || a.dep.localeCompare(b.dep) || a.fn.localeCompare(b.fn));
// The same flight number with several periods (a schedule change) shows once per period; drop exact repeats.
const ttUniq = (list) => [...new Map(list.map((f) => [`${f.fn}|${f.o}|${f.d}|${f.dep}|${f.days}|${f.from}`, f])).values()];

// ---------- 出發前小提醒：誰飛直航 and 桃園航廈 ----------
// Fills the line from the timetable; false when it does not cover this pair (the caller asks AeroDataBox then).
async function ttDirectsFill(li, fromV, toV) {
  const from = ttCodes(fromV);
  const to = ttCodes(toV);
  if (!from.length || !to.length || !ttTouches(from, to)) return false;
  const b = await ttRoute(from, to);
  if (!b.configured || !b.covered) return false;
  const span = li.lastElementChild;
  const list = ttSort(ttUniq(b.flights));
  const shown = list.slice(0, 6);
  const pair = new Set(list.map((f) => `${f.o}${f.d}`)).size > 1;
  span.className = 'tt-directs';
  span.innerHTML = list.length
    ? `<ul class="tt-list">${shown.map((f) => ttFlightHtml(f, b.horizon, { pair })).join('')}</ul>${list.length > shown.length ? `<details class="tt-more"><summary>還有 ${list.length - shown.length} 班</summary><ul class="tt-list">${list.slice(6).map((f) => ttFlightHtml(f, b.horizon, { pair })).join('')}</ul></details>` : ''}`
      + `<small class="hint">官方定期班表${b.mock ? '（示範資料）' : ''}，班表公布到 ${esc(ttMd(b.horizon))}；資料來源：${esc(ttSrc(b))}（${esc(b.updated)} 更新）</small>`
    : `官方班表沒有直飛，要轉機。<small class="hint">資料來源：${esc(ttSrc(b))}（${esc(b.updated)} 更新）${b.mock ? '（示範資料）' : ''}</small>`;
  // 桃園航廈 for the airlines flying it nonstop from or to TPE.
  if (list.length && (from.includes('TPE') || to.includes('TPE'))) {
    const T = await ttLoadTerminals();
    const als = [...new Set(list.filter((f) => f.o === 'TPE' || f.d === 'TPE').map((f) => f.al))];
    const rows = T ? als.map((al) => [al, ttTerminalOf(T, list.find((f) => f.al === al && (f.o === 'TPE' || f.d === 'TPE')).fn)]).filter(([, t]) => t) : [];
    if (rows.length && li.isConnected) {
      li.insertAdjacentHTML('afterend', `<li class="ti-term"><span class="ti-k">🛫 桃園航廈</span><span>${rows.map(([al, t]) => `${esc(ttAl(al))}：第 ${esc(t)} 航廈`).join('・')}<small class="hint">（資料來源：${esc(T.source?.name || '桃園國際機場')}，每週更新${T.mock ? '；示範資料' : ''}）</small></span></li>`);
    }
  }
  return true;
}

// ---------- 桃園機場航廈 ----------
function ttLoadTerminals() {
  TT.termP ||= api('/api/flightdata/terminals').then((b) => (TT.term = b.configured ? b : null)).catch(() => null);
  return TT.termP;
}
// BR16 → '2': the flight's own terminal when it differs from its airline's, else the airline's.
function ttTerminalOf(T, fn) {
  const m = /^([A-Z0-9]{2})\s*0*(\d{1,4})([A-Z]?)$/.exec(String(fn || '').toUpperCase().replace(/\s+/g, ''));
  if (!m) return '';
  return T.flights?.[`${m[1]}${Number(m[2])}${m[3]}`] || T.airlines?.[m[1]] || '';
}
// 我的行程: { dir: '出發' | '抵達', t: '2', src, updated } for a leg leaving or landing at TPE.
function ttLegTerminal(l) {
  const T = TT.term;
  if (!T || (l.from !== 'TPE' && l.to !== 'TPE')) return null;
  const fls = String(l.flights || '').split(/[,/·、]/).map((s) => s.trim()).filter(Boolean);
  const fn = l.from === 'TPE' ? fls[0] : fls.at(-1);
  const t = ttTerminalOf(T, fn);
  return t ? { dir: l.from === 'TPE' ? '出發' : '抵達', t, src: T.source?.name || '桃園國際機場', updated: T.updated } : null;
}

// ---------- the award search: calendar marks and the timetable fold ----------
document.addEventListener('search:start', () => { TT.search = null; });
document.addEventListener('search:done', (e) => { ttSearchDone(new URLSearchParams(e.detail?.share || '')).catch(() => {}); });
async function ttSearchDone(share) {
  const from = ttCodes(share.get('o'));
  const to = ttCodes(share.get('d'));
  const key = share.toString();
  TT.search = { key, from, to, body: null, lf: null };
  if (!from.length || !to.length || !ttTouches(from, to)) return;
  const cfg = await ttCfg();
  const [body, lf] = await Promise.all([cfg.timetable ? ttRoute(from, to) : null, cfg.lf ? ttLf(from, to) : null]);
  if (TT.search?.key !== key) return;
  TT.search.body = body?.configured && body.covered ? body : null;
  TT.search.lf = lf?.configured && Object.keys(lf.routes || {}).length ? lf : null;
  if (TT.search.body && $('#cal-host') && typeof renderCalendar === 'function') renderCalendar();
  if (typeof wkRender === 'function') wkRender();
  ttRender();
}
// app.js calendarHtml: a faint mark on days no nonstop leaves (within the published season, on routes that have one).
function ttDayMark(iso) {
  const b = TT.search?.body;
  if (!b || !b.flights.length || iso > b.horizon || iso < ttToday()) return null;
  return b.flights.some((f) => ttOn(f, iso)) ? null : { cls: 'no-direct', title: '這天沒有直飛班機（官方班表）' };
}
function ttLegend() {
  const b = TT.search?.body;
  if (!b || !b.flights.length || !state.start || !state.end) return '';
  for (let d = state.start; d <= state.end; d = isoDateFrom(d, 1)) if (ttDayMark(d)) return '<span class="hol-legend tt-legend"><i class="dot nd"></i>沒有直飛</span>';
  return '';
}
// The fold under the calendar (and the weekdays): 這條航線的直飛班表. Redrawn by app.js renderSearch.
function ttRender() {
  $('#tt-fold')?.remove();
  const b = TT.search?.body;
  const anchor = $('#wk-fold') || $('#cal-fold') || $('#search-results .empty');
  if (!b || !anchor) return;
  const list = ttSort(ttUniq(b.flights));
  const al = [...new Set(list.map((f) => f.al))].map(ttAl);
  // Flights a week in the searched dates (or now): each flight counted on its days.
  const at = state.start && state.start > ttToday() ? state.start : ttToday();
  const weekly = list.filter((f) => f.from <= isoDateFrom(at, 6) && f.to >= at).reduce((n, f) => n + ttBits(f.days), 0);
  const ends = list.filter((f) => ttEndsEarly(f, b.horizon));
  const later = list.filter((f) => f.from > (state.end || ttToday()));
  const pair = new Set(list.map((f) => `${f.o}${f.d}`)).size > 1;
  const sum = list.length
    ? `${al.join('、')}${weekly ? `・每週 ${weekly} 班` : ''}${ends.length ? `・${ends.slice(0, 2).map((f) => `${esc(f.fn)} 這條直飛只飛到 ${ttMd(f.to)}`).join('、')}` : ''}${later.length && !ends.length ? `・${esc(later[0].fn)} ${ttMd(later[0].from)} 起` : ''}`
    : '官方班表沒有直飛，要轉機';
  const slot = $('#cal-fold') && $('#tt-slot'); // with results it goes in 更多分析 (index.html)
  (slot || anchor).insertAdjacentHTML(slot ? 'beforeend' : 'afterend', `<details class="cal-fold tt-fold" id="tt-fold"${TT.open ? ' open' : ''}>
    <summary><h2 class="section-title">這條航線的直飛班表 <small>${sum}</small></h2></summary>
    ${list.length ? `<ul class="tt-list">${list.map((f) => ttFlightHtml(f, b.horizon, { pair })).join('')}</ul>` : '<p class="hint">要轉機的行程不在這份班表裡。</p>'}
    <p class="hint">官方定期班表，時間為當地時間；臨時加班、取消或換機型不會列出。班表公布到 ${esc(ttMd(b.horizon))}，之後的日期不標「沒有直飛」。資料來源：${esc(ttSrc(b))}（${esc(b.updated)} 更新）${b.mock ? '（示範資料）' : ''}。</p>
  </details>`);
  $('#tt-fold').addEventListener('toggle', (e) => { TT.open = e.target.open; });
}

// ---------- 星期幾比較有位：各月載客率 (weekday.js) ----------
function ttLfHtml() {
  const L = TT.search?.lf;
  if (!L) return '';
  const lvl = (v) => (v == null ? '' : v >= 90 ? 'l4' : v >= 80 ? 'l3' : v >= 70 ? 'l2' : 'l1');
  const pairs = Object.entries(L.routes);
  const rows = pairs.flatMap(([route, als]) => Object.entries(als).map(([al, vals]) => ({ route, al, vals })));
  if (!rows.length) return '';
  const label = (r) => `${esc(ttAl(r.al))}${pairs.length > 1 ? `<small>${esc(r.route.replace(/^TW-/, '全台–').replace('-', '–'))}</small>` : ''}`;
  // Months with a number: 民航局's monthly file holds one month, so a lone month is a list, not a grid of dashes.
  const months = L.monthly ? [...new Set(rows.flatMap((r) => r.vals.map((v, i) => (v == null ? 0 : i + 1))))].filter(Boolean).sort((a, b) => a - b) : [];
  const nation = pairs.some(([route]) => route.startsWith('TW-'));
  const body = months.length === 1
    ? `<ul class="tt-list">${rows.map((r) => `<li>${label(r)}：${months[0]} 月 <b>${r.vals[months[0] - 1] ?? '–'}%</b></li>`).join('')}</ul>`
    : L.monthly
    ? `<div class="lf-grid"><div class="lf-row lf-head"><span></span>${Array.from({ length: 12 }, (_, i) => `<span>${i + 1}</span>`).join('')}</div>
      ${rows.map((r) => `<div class="lf-row"><span class="lf-label">${label(r)}</span>${r.vals.map((v, i) => `<span class="lf-cell ${lvl(v)}" title="${i + 1} 月：${v == null ? '沒有資料' : `${v}%`}">${v == null ? '–' : v}</span>`).join('')}</div>`).join('')}</div>`
    : `<ul class="tt-list">${rows.map((r) => `<li>${label(r)}：全年 <b>${r.vals[0]}%</b></li>`).join('')}</ul>`;
  return `<details class="lf-fold"><summary>各月載客率（民航局，${L.year} 年）</summary>
    ${body}
    <p class="hint">數字是載客率 %（載客人數 ÷ 座位數，去程回程合計），顏色越濃越滿。我推測載客率高的月份獎勵位比較少（僅供參考）。${nation ? '民航局這份只分航點和航空公司，所以是全台各機場飛這個航點的合計。' : ''}這是 ${L.year} 年${months.length && months.length < 12 ? ` ${months.join('、')} 月` : ''}的統計，會比現在晚幾個月。資料來源：${esc(L.source?.name || '交通部民用航空局')}${L.mock ? '（示範資料）' : ''}。</p>
  </details>`;
}

// ---------- 今日好康：即將開航 (features.js renderDeals calls this after drawing) ----------
const TT_KIND = { new: '新航線', resume: '復航', soon: '即將開航' };
async function ttUpcomingMount(host) {
  if (!host) return;
  const cfg = await ttCfg();
  if (!cfg.upcoming) return;
  TT.upcoming ||= api('/api/flightdata/upcoming').catch(() => null);
  const b = await TT.upcoming;
  if (!b?.configured || !host.isConnected || !$('.deals-head', host)) return;
  const max = isoDate(MAX_AHEAD_DAYS);
  const list = b.routes.filter((r) => r.first > ttToday()).slice(0, 5);
  $('.tt-upcoming', host)?.remove();
  if (!list.length) return;
  const city = (c) => (typeof airportCity === 'function' && airportCity(c)) || c;
  const first = list[0];
  host.insertAdjacentHTML('beforeend', `<details class="tt-upcoming">
    <summary>✈️ 即將開航：${esc(first.airlines.map(ttAl).join('、'))} ${esc(city(first.o))}–${esc(city(first.d))} ${ttMd(first.first)} 起${list.length > 1 ? `（還有 ${list.length - 1} 條）` : ''}</summary>
    <ul>${list.map((r) => `<li><span class="tag">${TT_KIND[r.kind] || '即將開航'}</span> <b>${esc(r.airlines.map(ttAl).join('、'))}</b> ${esc(city(r.o))} → ${esc(city(r.d))}（${esc(r.o)}–${esc(r.d)}）<b>${ttMd(r.first)}</b> 起
      <span class="tt-acts"><button type="button" class="linkish" data-tt-look="${esc(r.o)}|${esc(r.d)}|${esc(r.first)}">看座位</button>${r.first <= max ? `<button type="button" class="linkish" data-tt-alert="${esc(r.o)}|${esc(r.d)}|${esc(r.first)}">🔔 開航後有位通知我</button>` : ''}</span></li>`).join('')}</ul>
    <p class="hint">從官方定期班表找出還沒開始飛的直飛航線${b.mock ? '（示範資料）' : ''}；資料來源：${esc(ttSrc(b))}（${esc(b.updated)} 更新）。開航日以航空公司公告為準。</p>
  </details>`);
}
document.addEventListener('click', (e) => {
  const t = e.target.closest?.('[data-tt-look],[data-tt-alert]');
  if (!t) return;
  const [o, d, first] = (t.dataset.ttLook || t.dataset.ttAlert).split('|');
  const end = isoDateFrom(first, 30) > isoDate(MAX_AHEAD_DAYS) ? isoDate(MAX_AHEAD_DAYS) : isoDateFrom(first, 30);
  const share = new URLSearchParams({ o, d, s: first, e: end, c: (typeof dealsState === 'object' && dealsState.cabin) || 'J' });
  if (t.dataset.ttLook) applyShare(share);
  else if (typeof openAlertDialog === 'function') openAlertDialog({ share, note: `已填好開航後 30 天（${ttMd(first)}–${ttMd(end)}），確認後按「建立提醒」才會建立。` });
});

// ---------- 航班明細 (app.js tripHtml): layovers, +1 days, time difference ----------
// t: a seats.aero trip (segment times are local wall times written with a Z). Returns { plus: [days after the
// trip's departure date, per segment arrival], conns: [html between segments], tz: '時差 −8 小時' or '' }.
function ttTripExtras(t) {
  const segs = t?.segments || [];
  if (!segs.length) return null;
  const day0 = String(segs[0].departsAt || '').slice(0, 10);
  const dd = (iso) => Math.round((Date.parse(String(iso).slice(0, 10)) - Date.parse(day0)) / 864e5);
  const plus = segs.map((s) => (s.arrivesAt && day0 ? dd(s.arrivesAt) : 0));
  const dep = segs.map((s) => (s.departsAt && day0 ? dd(s.departsAt) : 0));
  const hm = (m) => `${Math.floor(m / 60) ? `${Math.floor(m / 60)} 小時` : ''}${m % 60 ? ` ${m % 60} 分` : ''}`.trim();
  const conns = segs.slice(1).map((s, i) => {
    const a = segs[i];
    if (!a.arrivesAt || !s.departsAt) return '';
    const gap = Math.round((Date.parse(s.departsAt) - Date.parse(a.arrivesAt)) / 60000);
    if (!(gap >= 0)) return '';
    const where = (typeof airportCity === 'function' && airportCity(a.to)) || a.to;
    const night = gap >= 240 && (String(s.departsAt).slice(0, 10) !== String(a.arrivesAt).slice(0, 10) || gap >= 720);
    const flags = [night ? '<span class="tag warn">過夜轉機</span>' : '', gap < 60 ? '<span class="tag bad">轉機時間很短</span>' : '', a.to !== s.from ? `<span class="tag warn">要從 ${esc(a.to)} 換到 ${esc(s.from)} 機場</span>` : ''].join('');
    return `<div class="seg-conn">🔁 在${esc(where)}轉機 <b>${hm(gap) || '0 分'}</b>${flags}</div>`;
  });
  let tz = '';
  const A = AP.byCode?.get(segs[0].from);
  const B = AP.byCode?.get(segs.at(-1).to);
  if (A?.tz && B?.tz && typeof tzOffsetMin === 'function') {
    const at = Date.parse(segs[0].departsAt) || Date.now();
    const d = (tzOffsetMin(B.tz, at) ?? 0) - (tzOffsetMin(A.tz, at) ?? 0);
    const h = Math.abs(d) % 60 ? `${Math.floor(Math.abs(d) / 60)} 小時 ${Math.abs(d) % 60} 分` : `${Math.abs(d) / 60} 小時`;
    tz = d ? `<span title="${esc(airportCity(segs.at(-1).to) || segs.at(-1).to)}比${esc(airportCity(segs[0].from) || segs[0].from)}${d < 0 ? '慢' : '快'} ${h}">時差 ${d < 0 ? '−' : '+'}${h}</span>` : '沒有時差';
  }
  return { plus, dep, conns, tz };
}

// Redraw 今日好康's row and the search parts when this script arrives after they were drawn.
if ($('#deals .deals-head')) ttUpcomingMount($('#deals'));
if (typeof state === 'object' && state.results?.length && typeof tabParams === 'function') {
  // A search finished before this script loaded (a shared link): pick it up.
  const sh = tabParams('search');
  if (sh.get('o')) ttSearchDone(sh).catch(() => {});
}
