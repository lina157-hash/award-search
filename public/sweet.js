// 台灣出發甜蜜點榜 (兌換地圖 tab): from 台北 or 高雄, per cabin, the cheapest places to reach on the fixed award charts,
// by miles or by NT$ (miles × the cost per mile of data/milecost.json, or the visitor's own 每哩成本). Built on the map's
// own pricing (features.js rmapDestinations), so it never searches seats and spends no quota. Each row opens the city on
// the map or a route search for the next month. Classic script after features.js and award-tools.js.
/* global $, esc, fmt, data, AP, rmap, rmapMap, rmapDestinations, rmapProgramName, initRmap, tabInit, loadAirports, applyShare, isoDate, perMileOf, costOverrides, programKeyOf, airportCity, CABIN_LABEL, store */

const SWEET_KEY = 'sweet:v1';
const SWEET_ORIGINS = { TPE: '台北', KHH: '高雄' };
const sweetCfg = () => { const c = store.get(SWEET_KEY, null) || {}; return { from: SWEET_ORIGINS[c.from] ? c.from : 'TPE', cabin: /^[YWJF]$/.test(c.cabin || '') ? c.cabin : 'J', by: c.by === 'twd' ? 'twd' : 'miles' }; };
function sweetArea(ap) {
  const c = ap.country;
  if (c === 'JP' || c === 'KR') return '日韓';
  if (['HK', 'MO', 'CN', 'MN'].includes(c)) return '港澳・中國';
  if (['TH', 'VN', 'SG', 'MY', 'ID', 'PH', 'KH', 'MM', 'LA', 'BN', 'TL'].includes(c)) return '東南亞';
  // The Pacific islands (Tahiti, Fiji…) are Oceania; Hawaii stays with the US.
  if ((ap.lat < -8 && ap.lon > 100) || ap.lon > 150 || (ap.lon < -130 && ap.lat < 30 && c !== 'US') || ['GU', 'MP', 'PW'].includes(c)) return '大洋洲・關島';
  if (ap.lon < -25) return '美洲';
  if (ap.lat > 35 && ap.lon > -25 && ap.lon < 45) return '歐洲';
  return '南亞・中東・非洲';
}
const SWEET_AREAS = ['日韓', '港澳・中國', '東南亞', '大洋洲・關島', '南亞・中東・非洲', '歐洲', '美洲'];
// The map's destinations for one origin and cabin (one-way, no budget), each with its cheapest program by NT$ too.
function sweetRows(from, cabin) {
  const keep = { ...rmap };
  Object.assign(rmap, { origins: [from], cabin, trip: 'ow', program: '', budget: 0, mine: false });
  let dests;
  try { dests = rmapDestinations(); } finally { Object.assign(rmap, keep); }
  // award-tools.js may load later than this tab (lazily): its 每哩成本 when there, the data's defaults otherwise.
  const own = typeof costOverrides === 'function' ? costOverrides() : {};
  const per = (id) => (typeof perMileOf === 'function' ? perMileOf(data.milecost, own, programKeyOf(id)) : data.milecost?.defaults?.[programKeyOf(id)] ?? data.milecost?.fallback ?? 0.5);
  // Abroad only: 台北 ↔ 高雄 is not a sweet spot.
  return dests.filter((d) => d.ap.country !== 'TW').map((d) => {
    const priced = d.prices.map((x) => ({ ...x, twd: Math.round(x.miles * per(x.id)) }));
    const cheap = [...priced].sort((a, b) => a.twd - b.twd)[0];
    return { ...d, area: sweetArea(d.ap), best: priced[0], cheap };
  });
}
function sweetHtml() {
  const c = sweetCfg();
  if (!AP.loaded || !data.charts) return '<p class="hint">載入中…</p>';
  const rows = sweetRows(c.from, c.cabin);
  const key = (r) => (c.by === 'twd' ? r.cheap.twd : r.best.miles);
  const pick = (r) => (c.by === 'twd' ? r.cheap : r.best);
  const seg = (name, list, on) => `<fieldset class="seg" aria-label="${name}">${list.map(([k, l]) => `<label><input type="radio" name="sw-${name}" value="${k}" ${on === k ? 'checked' : ''}><span>${l}</span></label>`).join('')}</fieldset>`;
  const groups = SWEET_AREAS.map((a) => [a, rows.filter((r) => r.area === a).sort((x, y) => key(x) - key(y)).slice(0, 3)]).filter(([, l]) => l.length);
  return `<div class="opts-row sweet-opts">${seg('出發', Object.entries(SWEET_ORIGINS).map(([k, v]) => [k, `${v} ${k}`]), c.from)}${seg('艙等', Object.entries({ Y: '經濟', W: '豪經', J: '商務', F: '頭等' }), c.cabin)}${seg('排序', [['miles', '哩數最少'], ['twd', '台幣最省']], c.by)}</div>
    ${groups.length ? `<div class="sweet-groups">${groups.map(([a, list]) => `<div class="sweet-group"><h3 class="sub">${esc(a)}</h3><ol>${list.map((r) => { const x = pick(r); return `<li>
      <span class="sw-city"><b>${esc(r.city)}</b> <small>${esc(r.ap.code)}・直線 ${fmt(r.dist)} 哩</small></span>
      <span class="sw-price"><b>${fmt(x.miles)} 哩</b><small>${esc(rmapProgramName(x.id))}${x.label ? `・${esc(x.label)}` : ''}・約 NT$${fmt(x.twd)}</small></span>
      <span class="sw-go"><button type="button" class="linklike" data-sw-map="${esc(r.ap.code)}">地圖</button><button type="button" class="linklike" data-sw-search="${esc(r.codes.join(','))}">找座位</button></span></li>`; }).join('')}</ol></div>`).join('')}</div>` : '<p class="hint">這個艙等找不到適用的固定哩程表。</p>'}
    <p class="hint">單程、${CABIN_LABEL[c.cabin]}最低（Saver）價，依兩地直線距離或區域估算；台幣是哩數乘上每哩成本的預設值（可在搜尋結果的「每哩成本」改成你自己的），不含稅金和燃油附加費。動態定價的計畫不列入。</p>`;
}
function renderSweet() {
  const body = $('#sweet-body');
  if (body) body.innerHTML = sweetHtml();
}
function mountSweet() {
  if ($('#sweet')) return;
  const out = $('#rmap-out')?.parentElement;
  if (!out) return;
  out.insertAdjacentHTML('afterend', `<div class="wrap"><details class="sweet" id="sweet"><summary><h2 class="section-title">🍯 台灣出發甜蜜點榜 <small>固定表估價，有沒有位子要另外查</small></h2></summary><div id="sweet-body"></div></details></div>`);
  const box = $('#sweet');
  box.addEventListener('toggle', () => { if (box.open) loadAirports().then(renderSweet); });
  box.addEventListener('change', (e) => {
    const t = e.target;
    const c = sweetCfg();
    if (t.name === 'sw-出發') c.from = t.value;
    else if (t.name === 'sw-艙等') c.cabin = t.value;
    else if (t.name === 'sw-排序') c.by = t.value;
    else return;
    store.set(SWEET_KEY, c);
    renderSweet();
    $(`#sweet input[name="${t.name}"][value="${t.value}"]`)?.focus();
  });
  box.addEventListener('click', (e) => {
    const s = e.target.closest('[data-sw-search]');
    const c = sweetCfg();
    if (s) { applyShare(new URLSearchParams({ o: c.from, d: s.dataset.swSearch, s: isoDate(1), e: isoDate(30), c: c.cabin })); return; }
    const m = e.target.closest('[data-sw-map]');
    if (!m) return;
    // The map above, redrawn from this origin and cabin (the form too), with the city's popup open once it is drawn.
    Object.assign(rmap, { origins: [c.from], cabin: c.cabin, trip: 'ow', program: '', budget: 0, mine: false, direct: false });
    const before = rmapMap;
    initRmap();
    $('#rmap-out').scrollIntoView({ behavior: 'smooth', block: 'start' });
    const ap = AP.byCode.get(m.dataset.swMap);
    let tries = 0;
    const wait = setInterval(() => {
      if (rmapMap === before && ++tries < 60) return;
      clearInterval(wait);
      if (!ap || !rmapMap || rmapMap === before) return;
      rmapMap.eachLayer((l) => {
        const p = l.getPopup?.() && l.getLatLng?.();
        if (p && Math.abs(p.lat - ap.lat) < 1e-6 && Math.abs(p.lng - ap.lon) < 1e-6) { rmapMap.setView(p, Math.max(rmapMap.getZoom(), 4)); l.openPopup(); }
      });
    }, 100);
  });
}
// The map tab is set up on first open (app.js tabInit): add the list under the map.
if (typeof tabInit === 'object') {
  const base = tabInit.map;
  tabInit.map = () => { base(); mountSweet(); };
}
