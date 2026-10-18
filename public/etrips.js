// E9 中停、開口行程組合, E10 外站出發建議, E14 Google 航班快捷 (help card and landing).
// Loaded after features.js; uses the shared globals (api, data, chartPrices, amPrice, haversineMiles, AP, pickers…).
// Nothing here spends quota on its own: seat searches and cash lookups run only from buttons that say what they cost.

// ---------- rules and pricing (pure: the tests run these with stub airports) ----------
let etData = null;
let etDataP = null;
const etLoad = () => (etDataP ||= api('/api/data/routing').then((d) => (etData = d)).catch((e) => { etDataP = null; throw e; }));
const etRule = (id) => etData?.programs?.find((p) => p.id === id) || null;

// Same place for a round trip: the same airport, the same country, or within 150 miles (TPE out, TSA back).
const etSamePlace = (a, b) => a.code === b.code || (a.country && a.country === b.country) || (a.lat != null && b.lat != null && haversineMiles(a, b) < 150);

// Legs [{ from, to }] (IATA codes) → the shape of the trip. apOf(code) gives { code, country, lat, lon }.
function etAnalyze(legs, apOf) {
  const n = legs.length;
  const ap = legs.map((l) => ({ from: apOf(l.from), to: apOf(l.to) }));
  if (!n || ap.some((x) => !x.from || !x.to || x.from.lat == null || x.to.lat == null)) return { error: '有機場代碼查不到' };
  if (legs.some((l) => l.from === l.to)) return { error: '同一段的出發地和目的地相同' };
  const dist = ap.map((x) => haversineMiles(x.from, x.to));
  const origin = ap[0].from;
  const end = ap[n - 1].to;
  const rt = n > 1 && etSamePlace(origin, end);
  // The turnaround of a round trip is the point farthest from where it started.
  let turn = n - 1;
  if (rt) {
    turn = 0;
    for (let i = 1; i < n - 1; i++) if (haversineMiles(origin, ap[i].to) > haversineMiles(origin, ap[turn].to)) turn = i;
  }
  const dirs = rt ? [legs.map((_, i) => i).slice(0, turn + 1), legs.map((_, i) => i).slice(turn + 1)] : [legs.map((_, i) => i)];
  // Every point inside a direction is a stop longer than 24 hours (a plain connection belongs inside one leg's search).
  const stops = dirs.map((d) => d.slice(0, -1).map((i) => legs[i].to));
  const openJaws = [];
  for (let i = 0; i < n - 1; i++) {
    if (legs[i].to !== legs[i + 1].from) openJaws.push({ at: rt && i === turn ? 'turn' : 'mid', a: legs[i].to, b: legs[i + 1].from });
  }
  if (rt && legs[n - 1].to !== legs[0].from) openJaws.push({ at: 'origin', a: legs[0].from, b: legs[n - 1].to });
  return { kind: rt ? 'rt' : 'ow', n, turn, dirs, stops, openJaws, dist, total: dist.reduce((s, x) => s + x, 0), countries: ap.map((x) => x.to.country) };
}

// One chart's lowest price for one stretch: { miles, label, bands, d } or null (bands and d: the distance band that set
// it, for mapkit.js's 級距提醒). Asia Miles prices Cathay's own flights by cxDist (through Hong Kong, amCxDist).
function etChart(chart, a, b, cabin, dist, cxDist = dist) {
  if (!chart) return null;
  if (chart === 'asiamiles') {
    const best = [['cx', cxDist], ['partner', dist]].map(([k, d]) => ({ ...amPrice(k, d, cabin, a.code, b.code), d })).filter((x) => x.miles).sort((x, y) => x.miles - y.miles)[0];
    return best ? { miles: best.miles, label: best.kind === 'cx' ? `國泰航班${best.d > dist ? '・經香港' : ''}` : '夥伴航班', bands: data.asiamiles.bands, d: best.d } : null;
  }
  const p = data.charts?.programs?.find((x) => x.id === chart);
  if (!p) return null;
  const best = chartPrices(p, a, b, cabin, dist).sort((x, y) => x.miles - y.miles)[0];
  return best ? { miles: best.miles, label: best.label, bands: best.bands, d: best.d } : null;
}

const etRoute = (legs, idx) => [legs[idx[0]].from, ...idx.map((i) => legs[i].to)].join('→');

// Fixed-chart price per person: { miles, parts: [{ label, miles, note }] }, miles null when a part has no chart price.
function etPrice(rule, legs, trip, cabin, apOf, split = false) {
  if (!rule || rule.pricing === 'none' || !rule.chart) return null;
  const parts = [];
  const add = (label, idx, extraStops) => {
    const a = apOf(legs[idx[0]].from);
    const b = apOf(legs[idx[idx.length - 1]].to);
    const dist = idx.reduce((s, i) => s + trip.dist[i], 0);
    // Cathay's own flights connect in Hong Kong: each leg not touching it counts through it (app.js amCxDist).
    const cxDist = rule.chart === 'asiamiles' && typeof amCxDist === 'function'
      ? idx.reduce((s, i) => s + (amCxDist(legs[i].from, legs[i].to, trip.dist[i], false, apOf)?.dist ?? trip.dist[i]), 0) : dist;
    const x = etChart(rule.chart, a, b, cabin, dist, cxDist);
    const fee = (extraStops || 0) * (rule.stopoverMiles || 0);
    parts.push({ label, miles: x ? x.miles + fee : null, note: x ? `${x.label}${fee ? `；中停加 ${fmt(fee)}` : ''}` : '固定表查不到這段', bands: x?.bands, d: x?.d });
  };
  if (split || rule.pricing === 'segment') {
    legs.forEach((l, i) => add(`${l.from}→${l.to}`, [i], 0));
  } else if (rule.pricing === 'wholeTrip') {
    if (trip.kind !== 'rt') return null;
    const p = data.charts?.programs?.find((x) => x.id === rule.chart);
    const a = apOf(legs[0].from);
    const b = apOf(legs[trip.turn].to);
    // Round-trip-total charts double the distance they are given, so hand them half the whole trip.
    const best = p ? chartPrices(p, a, b, cabin, Math.round(trip.total / 2)).sort((x, y) => x.miles - y.miles)[0] : null;
    parts.push({ label: `整趟 ${fmt(trip.total)} 哩`, miles: best ? best.miles : null, note: best ? best.label : '固定表查不到', bands: best?.bands, d: best?.d });
  } else {
    trip.dirs.forEach((idx, d) => add(`${trip.kind === 'rt' ? (d ? '回程' : '去程') : '單程'} ${etRoute(legs, idx)}`, idx, trip.stops[d].length));
  }
  const known = parts.every((p) => p.miles != null);
  return { miles: known ? parts.reduce((s, p) => s + p.miles, 0) : null, parts };
}

// Can this program book the trip as one award? { verdict: ok | check | split | no, lines: [{ ok, text }] }.
function etCheck(rule, legs, trip, cabin, price) {
  const lines = [];
  const fail = (text) => lines.push({ ok: false, text });
  const pass = (text) => lines.push({ ok: true, text });
  const info = (text) => lines.push({ ok: null, text });
  if (rule.roundTripOnly && trip.kind !== 'rt') {
    fail('只收來回（整趟）票，單程行程不適用');
    return { verdict: 'no', lines };
  }
  const nStops = trip.stops.reduce((s, x) => s + x.length, 0);
  const cap = trip.kind === 'rt' ? rule.stopovers.roundTrip : rule.stopovers.oneWay;
  const where = trip.stops.flat().join('、');
  if (!nStops) pass('沒有中停');
  else if (cap >= 99) pass(`中停 ${nStops} 次（${where}）：每段分開計價，不限次數`);
  else if (nStops > cap) fail(`中停 ${nStops} 次（${where}）：${trip.kind === 'rt' ? '來回' : '單程'}票${cap ? `最多 ${cap} 次` : '不可中停'}`);
  else if (rule.stopovers.perDirection != null && trip.stops.some((s) => s.length > rule.stopovers.perDirection)) fail(`同一個方向中停超過 ${rule.stopovers.perDirection} 次`);
  else pass(`中停 ${nStops} 次（${where}）：${trip.kind === 'rt' ? '來回' : '單程'}票最多 ${cap} 次${rule.stopoverMiles ? `，每次加 ${fmt(rule.stopoverMiles)} 哩` : ''}`);
  if (nStops && rule.noStopoverCountries?.length) {
    const bad = trip.stops.flat().filter((c, i) => rule.noStopoverCountries.includes(trip.countries[legs.findIndex((l) => l.to === c)]));
    if (bad.length) fail(`不可在 ${bad.join('、')} 中停`);
  }
  if (nStops && rule.stopoverMinMiles?.[cabin] && price?.miles != null && price.miles < rule.stopoverMinMiles[cabin]) {
    fail(`整趟要達 ${fmt(rule.stopoverMinMiles[cabin])} 哩才可中停（估價 ${fmt(price.miles)}）`);
  }
  const oj = trip.openJaws;
  const ojText = (x) => `${x.a} ↔ ${x.b}`;
  if (!oj.length) pass(trip.kind === 'rt' ? '沒有開口，回到原出發地' : '沒有地面段');
  else if (rule.openJaws >= 99 || rule.pricing === 'segment') pass(`開口 ${oj.map(ojText).join('、')}：分段計價，可以自由組合`);
  else if (trip.kind !== 'rt') fail(`單程中間有地面段（${oj.map(ojText).join('、')}），要拆成兩張票`);
  else if (oj.length > rule.openJaws) fail(`開口 ${oj.length} 個（${oj.map(ojText).join('、')}）：最多 ${rule.openJaws} 個`);
  else pass(`開口 ${oj.length} 個（${oj.map(ojText).join('、')}）：可以`);
  if (rule.maxLegs && legs.length > rule.maxLegs) fail(`全程最多 ${rule.maxLegs} 段`);
  if (rule.needsPhone && nStops) info('要打電話開票');
  const failed = lines.some((l) => l.ok === false);
  return { verdict: failed ? 'split' : rule.unsure && (nStops || oj.length) ? 'check' : 'ok', lines };
}

// Everything for one program: the check, the one-ticket price, and the price as separate one-ways when it can't be one.
function etEvaluate(rule, legs, cabin, apOf) {
  const trip = etAnalyze(legs, apOf);
  if (trip.error) return { error: trip.error };
  const price = etPrice(rule, legs, trip, cabin, apOf);
  const check = etCheck(rule, legs, trip, cabin, price);
  const splitPrice = check.verdict === 'split' && rule.pricing !== 'wholeTrip' ? etPrice(rule, legs, trip, cabin, apOf, true) : null;
  return { trip, price: check.verdict === 'split' || check.verdict === 'no' ? null : price, splitPrice, ...check };
}

// Positioning: hubs to check for a search from home (Taiwan) to somewhere, leaving out hubs that are an end of it.
function etHubsFor(share, cfg) {
  if (!cfg) return [];
  const o = String(share.get('o') || '').split(',');
  const d = String(share.get('d') || '').split(',');
  if (!o.some((c) => cfg.home.includes(c))) return [];
  return cfg.hubs.filter((h) => !h.codes.some((c) => o.includes(c) || d.includes(c)));
}

// The cheapest award per hub and program, for the cabin and party size of the search; cheapest first, at most
// `perHub` programs from one hub so a single cheap hub doesn't fill the list.
function etBestFromHubs(byHub, cabin, pax, perHub = 2) {
  const best = new Map();
  for (const [hubId, rows] of Object.entries(byHub)) {
    for (const r of rows || []) {
      const x = r.cabins?.[cabin];
      if (!x?.available || !x.miles || (pax && x.seats > 0 && x.seats < pax)) continue;
      const k = `${hubId}|${r.source}`;
      if (!best.has(k) || best.get(k).cabins[cabin].miles > x.miles) best.set(k, { ...r, hub: hubId });
    }
  }
  const count = {};
  return [...best.values()].sort((a, b) => a.cabins[cabin].miles - b.cabins[cabin].miles).filter((r) => (count[r.hub] = (count[r.hub] || 0) + 1) <= perHub);
}

if (typeof document !== 'undefined' && document.getElementById('search-form')) {
  // ---------- E9: 中停／開口組合 (a panel beside 我的行程) ----------
  const COMBO_KEY = 'combo:v1';
  const comboClean = (x) => {
    const code = (v) => (typeof v === 'string' && /^[A-Z]{3}$/.test(v) ? v : '');
    const legs = Array.isArray(x?.legs) ? x.legs.slice(0, 4).map((l) => ({ from: code(l?.from), to: code(l?.to), date: typeof l?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(l.date) ? l.date : '' })) : [];
    while (legs.length < 2) legs.push({ from: '', to: '', date: '' });
    return { legs, program: typeof x?.program === 'string' ? x.program.slice(0, 30) : 'aeroplan', cabin: /^[YWJF]$/.test(x?.cabin) ? x.cabin : 'J' };
  };
  // Starts blank (two empty legs); the examples fill it in one tap.
  const combo = comboClean(store.get(COMBO_KEY, null) || { legs: [], program: 'aeroplan', cabin: 'J' });
  const comboSave = () => store.set(COMBO_KEY, combo);

  // index.html has the panel already (this script loads after the page, with the search scripts).
  if (!$('#combo-panel')) $('#plan-panel').insertAdjacentHTML('afterend', `<details class="alerts-panel" id="combo-panel">
      <summary>🧭 中停／開口組合</summary><div id="combo-body" class="alerts-body"><p class="hint">載入中…</p></div></details>`);
  const comboPanel = $('#combo-panel');
  const comboOpen = () => {
    if (!comboPanel.open) return;
    // mapkit.js (級距提醒, band names) comes along; it resolves either way.
    Promise.all([etLoad(), loadAirports(), loadMore(), loadMapkit()]).then(renderCombo).catch((e) => { $('#combo-body').innerHTML = `<p class="status error">${esc(e.message)}</p>`; });
  };
  comboPanel.addEventListener('toggle', comboOpen);
  if (comboPanel.open) setTimeout(comboOpen); // opened before this script arrived

  const comboAp = (code) => AP.byCode.get(code) || null;
  const verdictShort = { ok: '✓ 可以', check: '△ 要確認', split: '✕ 要拆票', no: '✕ 不適用' };
  const verdictText = { ok: ['✓ 可以開成一張票', 'ok'], check: ['△ 可能可以，請電話確認', 'check'], split: ['✕ 不能開成一張票，要拆票', 'bad'], no: ['✕ 這個計畫不適用', 'bad'] };
  const sourcesHtml = (rule) => (rule.sources || []).map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)} ↗</a>`).join('　');
  // The site's one name for each program (features.js chartProgram); 「星盟夥伴 Saver」 and the like go beside it, small.
  const etName = (r) => chartProgram(r.id, r.name, r.chart);
  const etVariant = (r, wrap) => (etName(r).variant ? wrap(esc(etName(r).variant)) : '');

  // Four leg rows are built once with the site's airport and date pickers (each date picker adds a dialog to the page,
  // so they are never rebuilt); renderCombo shows the rows in use and copies the legs into them.
  const comboUi = { built: false, legs: [] };
  function buildCombo() {
    const body = $('#combo-body');
    const programs = etData.programs;
    const apField = (i, k, label) => `<div class="field grow ac-host"><label for="cb-${k}-${i}">${label}</label>
      <div class="chips-box" data-for="${k}"><span class="chips"></span><input id="cb-${k}-${i}" class="chips-q" placeholder="城市或代碼" autocapitalize="off" spellcheck="false" enterkeyhint="done"
        role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="ac-cb-${k}-${i}"></div>
      <input type="hidden" name="${k}" value=""><div class="ac-list" id="ac-cb-${k}-${i}" role="listbox" aria-label="${label}建議" hidden></div></div>`;
    body.innerHTML = `<p class="hint">把想停留的城市拆成 2–4 段，看一個計畫能不能開成一張票、依固定哩程表大約要幾哩。估價不查座位、不用額度；按某一段的「找座位」才會查詢一次。</p>
      <p class="hint">這是一般獎勵機票加中停或開口；想停很多站、繞地球一圈，請用 <a href="#rtw">🌏 環球票規劃</a>。</p>
      <div class="combo-ex"><span class="hint">範例</span>${(etData.examples || []).map((x, i) => `<button type="button" class="linklike" data-cex="${i}">${esc(x.label)}</button>`).join('')}</div>
      <ol class="combo-legs">${[0, 1, 2, 3].map((i) => `<li class="combo-leg-row" hidden><form class="combo-leg" id="combo-leg-${i}" data-leg="${i}" autocomplete="off">
        ${apField(i, 'from', `第 ${i + 1} 段出發`)}${apField(i, 'to', `第 ${i + 1} 段抵達`)}
        <div class="field dp-field single"><span>日期（選填）</span><button type="button" class="dp-btn" aria-haspopup="dialog"></button><input type="hidden" name="date"></div>
        <div class="combo-leg-acts"><button type="button" class="outline" data-seek="${i}" title="用航線查詢找這一段的獎勵位（日期前後 3 天；沒填日期查未來 1 個月），和一般搜尋一樣用 1 次 seats.aero 查詢">找座位（用 1 次查詢）</button>
        <button type="button" class="linklike" data-crm="${i}" aria-label="移除第 ${i + 1} 段">✕</button></div>
      </form></li>`).join('')}</ol>
      <div class="combo-opts">
        <button type="button" class="outline" id="combo-add">＋ 加一段</button>
        <button type="button" class="outline" id="combo-clear">清空</button>
        <label class="field compact">哩程計畫<select id="combo-prog">${programs.map((p) => `<option value="${esc(p.id)}">${esc(etName(p).name)}${etVariant(p, (v) => `（${v}）`)}</option>`).join('')}</select></label>
        <fieldset class="seg" aria-label="艙等">${Object.entries(CABIN_SHORT).map(([k, l]) => `<label><input type="radio" name="combo-cabin" value="${k}"><span>${l}</span></label>`).join('')}</fieldset>
      </div>
      <div id="combo-out" aria-live="polite"></div>`;
    comboUi.legs = [0, 1, 2, 3].map((i) => {
      const form = $(`#combo-leg-${i}`);
      return { form, from: createAirportPicker(form, 'from'), to: createAirportPicker(form, 'to'), date: createDatePicker(form, `第 ${i + 1} 段日期`, { single: true, name: 'date', field: $('.dp-field', form) }) };
    });
    comboUi.built = true;
  }
  // Copy the legs into the rows without firing their change events back into the legs.
  let comboSyncing = false;
  function renderCombo() {
    const programs = etData.programs;
    if (!programs.some((p) => p.id === combo.program)) combo.program = programs[0].id;
    if (!comboUi.built) buildCombo();
    comboSyncing = true;
    comboUi.legs.forEach((u, i) => {
      const l = combo.legs[i];
      u.form.parentElement.hidden = !l;
      if (!l) return;
      if (u.from.codes().join() !== l.from) u.from.set(l.from ? [l.from] : []);
      if (u.to.codes().join() !== l.to) u.to.set(l.to ? [l.to] : []);
      if (u.date.value() !== l.date) u.date.set(l.date);
      $('[data-crm]', u.form).hidden = combo.legs.length <= 2;
    });
    comboSyncing = false;
    $('#combo-add').hidden = combo.legs.length >= 4;
    $('#combo-prog').value = combo.program;
    $$('input[name=combo-cabin]', $('#combo-body')).forEach((r) => { r.checked = r.value === combo.cabin; });
    renderComboOut();
  }

  function renderComboOut() {
    const out = $('#combo-out');
    if (!out) return;
    if (comboMap) { comboMap.remove(); comboMap = null; }
    const legs = combo.legs;
    // Nothing to judge until every leg has both ends: the result stays hidden (one quiet line once something is typed).
    if (legs.some((l) => !l.from || !l.to)) { out.innerHTML = legs.some((l) => l.from || l.to) ? '<p class="hint">每一段都填好出發地和目的地，就會算出結果。</p>' : ''; return; }
    const rule = etRule(combo.program);
    const c = combo.cabin;
    const ev = etEvaluate(rule, legs, c, comboAp);
    if (ev.error) { out.innerHTML = `<p class="status error">${esc(ev.error)}</p>`; return; }
    const [vt, vc] = verdictText[ev.verdict];
    const shape = ev.trip.kind === 'rt' ? `來回・折返點 ${esc(legs[ev.trip.turn].to)} ${esc(airportCity(legs[ev.trip.turn].to))}` : '單程';
    // A part priced just over a distance band, or just under the next one, says so (mapkit.js).
    const edgeHtml = (x) => { const e = typeof mkEdge === 'function' && x.miles != null && mkEdge(x.bands, x.d); return e ? `<span class="mk-edge">⚠ ${esc(x.label)}：${esc(mkEdgeText(e, x.d))}</span>` : ''; };
    const priceHtml = (p, title) => (p ? `<p class="combo-price">${title}：${p.miles != null ? `<b>${fmt(p.miles)} 哩</b>／人・${CABIN_LABEL[c]}` : '<b>部分航段查不到固定價</b>'}<small>${p.parts.map((x) => `${esc(x.label)} ${x.miles != null ? `${fmt(x.miles)} 哩` : '—'}・${esc(x.note)}`).join('；')}</small>${p.parts.map(edgeHtml).join('')}</p>` : '');
    // Every program side by side, the ones that work first, cheapest first.
    const all = etData.programs.map((r) => ({ r, e: etEvaluate(r, legs, c, comboAp) })).filter((x) => !x.e.error);
    const rank = { ok: 0, check: 1, split: 2, no: 3 };
    all.sort((a, b) => rank[a.e.verdict] - rank[b.e.verdict] || (a.e.price?.miles ?? a.e.splitPrice?.miles ?? 9e9) - (b.e.price?.miles ?? b.e.splitPrice?.miles ?? 9e9));
    out.innerHTML = `<div class="combo-verdict ${vc}"><b>${vt}</b><span>${esc(etName(rule).name)}${etVariant(rule, (v) => `（${v}）`)}・${shape}・直線距離合計 ${miKm(ev.trip.total)}</span></div>
      ${typeof gcmapLinkHtml === 'function' ? gcmapLinkHtml(legs) : ''}
      <ul class="combo-checks">${ev.lines.map((l) => `<li class="${l.ok === false ? 'bad' : l.ok ? 'ok' : ''}">${l.ok === false ? '✕' : l.ok ? '✓' : 'ⓘ'} ${esc(l.text)}</li>`).join('')}</ul>
      ${rule.pricing === 'none' ? '<p class="combo-price">浮動定價，沒有固定表可估；請按各段「找座位」看實際哩數。</p>' : ''}
      ${priceHtml(ev.price, '固定表估價')}${priceHtml(ev.splitPrice, '拆成單程票估價')}
      ${comboMapHtml(legs, ev)}
      ${rule.chartNote ? `<p class="hint">${esc(rule.chartNote)}</p>` : ''}
      ${rule.conditions?.length ? `<p class="hint">其他條件：${esc(rule.conditions.join('；'))}</p>` : ''}
      <p class="hint combo-src">${CONFIDENCE_TAG[rule.confidence] || ''}來源：${sourcesHtml(rule)}</p>
      <details class="combo-all"><summary>其他計畫比較</summary><div class="table-wrap"><table class="need-table"><thead><tr><th>計畫</th><th>一張票？</th><th>估價（每人）</th></tr></thead><tbody>
        ${all.map(({ r, e }) => `<tr class="${r.id === combo.program ? 'best-row' : ''}"><td><button type="button" class="linklike" data-cprog="${esc(r.id)}">${esc(etName(r).name)}</button>${etVariant(r, (v) => `<small>${v}</small>`)}</td><td>${verdictShort[e.verdict]}</td>
          <td>${e.price?.miles != null ? `<b>${fmt(e.price.miles)} 哩</b>` : e.splitPrice?.miles != null ? `${fmt(e.splitPrice.miles)} 哩<small>拆票</small>` : '<small>浮動或查不到</small>'}</td></tr>`).join('')}
      </tbody></table></div></details>
      <p class="hint">依直線距離與公布的最低（Saver）價估算，實際價格以航空公司為準；稅金與燃油費另計。每一段請另外確認有位子。</p>`;
    if (comboMapOpen) comboMapDraw(legs, ev.trip);
  }

  // 在地圖上看 (closed until opened, and kept open across redraws): the legs on a map with 環球票規劃's drawing (rtw.js
  // rtwDrawRoute; an open jaw is a dashed line), each leg's distance, and the distance each priced part counts.
  let comboMap = null;
  let comboMapOpen = false;
  // The stops in order with the gaps between legs (and back to the origin) as legs not flown.
  function comboPath(legs, trip) {
    const pts = [];
    const surface = [];
    legs.forEach((l, i) => {
      if (!i || legs[i - 1].to !== l.from) { if (i) surface.push(true); pts.push(l.from); }
      surface.push(false);
      pts.push(l.to);
    });
    if (trip.openJaws.some((x) => x.at === 'origin')) { surface.push(true); pts.push(legs[0].from); }
    return { pts: pts.map((code) => ({ code, ap: comboAp(code) })), surface };
  }
  function comboMapHtml(legs, ev) {
    const gap = (a, b) => { const [x, y] = [comboAp(a), comboAp(b)]; return x && y ? `<li class="oj">開口 ${esc(a)} ↔ ${esc(b)}（地面段，自行前往）${miKm(haversineMiles(x, y))}</li>` : ''; };
    const rows = legs.map((l, i) => `<li><b>第 ${i + 1} 段 ${esc(l.from)} → ${esc(l.to)}</b>　${miKm(ev.trip.dist[i])}</li>${legs[i + 1] && legs[i + 1].from !== l.to ? gap(l.to, legs[i + 1].from) : ''}`).join('');
    const back = ev.trip.openJaws.find((x) => x.at === 'origin');
    const p = ev.price || ev.splitPrice;
    const bands = typeof mkBandText === 'function' ? (p?.parts || []).filter((x) => x.bands && x.d && x.miles != null) : [];
    return `<details class="combo-map" id="combo-map" ${comboMapOpen ? 'open' : ''}><summary>在地圖上看・每段距離</summary>
      <div class="ex-map combo-map-box" id="combo-map-box"><p class="hint">地圖載入中…</p></div>
      <ul class="combo-dists">${rows}${back ? gap(back.b, back.a) : ''}</ul>
      ${bands.length ? `<p class="hint">計價距離：${bands.map((x) => `${esc(x.label)} ${fmt(x.d)} 哩，落在 ${esc(mkBandText(x.bands, x.d))}`).join('；')}。</p>` : ''}
      <p class="hint">距離是兩地的大圓距離（英里），和航空公司的計算可能差幾哩${ev.trip.openJaws.length ? '；虛線是開口，要自己安排交通' : ''}。</p></details>`;
  }
  function comboMapDraw(legs, trip) {
    const box = $('#combo-map-box');
    if (!box || comboMap || typeof rtwDrawRoute !== 'function') return;
    loadLeaflet().then(() => {
      if (comboMap || !box.isConnected) return;
      const L = window.L;
      box.innerHTML = '';
      comboMap = L.map(box, { scrollWheelZoom: false, zoomSnap: 0.25, landCopies: [-360, 360] });
      addBaseMap(comboMap);
      keepMapSized(comboMap);
      const { pts, surface } = comboPath(legs, trip);
      const all = rtwDrawRoute(L, L.layerGroup().addTo(comboMap), pts, (i) => surface[i], airportCity);
      comboMap.fitBounds(L.latLngBounds(all), { padding: [28, 28], maxZoom: 5 });
    }, (err) => { box.innerHTML = `<p class="hint">${esc(err.message)}</p>`; });
  }

  const comboBody = $('#combo-body');
  comboBody.addEventListener('submit', (e) => e.preventDefault()); // Enter in an airport box picks, never reloads
  comboBody.addEventListener('toggle', (e) => {
    if (e.target.id !== 'combo-map') return;
    comboMapOpen = e.target.open;
    if (comboMapOpen) comboMapDraw(combo.legs, etAnalyze(combo.legs, comboAp));
  }, true);
  comboBody.addEventListener('change', (e) => {
    const t = e.target;
    const legForm = t.closest('.combo-leg');
    if (legForm && ['from', 'to'].includes(t.name)) {
      if (comboSyncing) return;
      const i = Number(legForm.dataset.leg);
      const u = comboUi.legs[i];
      const codes = u[t.name].codes();
      // One airport per end: a second pick replaces the first.
      if (codes.length > 1) { u[t.name].set([codes.at(-1)]); return; }
      const code = codes[0] || '';
      combo.legs[i][t.name] = code;
      // The next leg usually starts where this one ends.
      const next = combo.legs[i + 1];
      if (t.name === 'to' && code && next && !next.from) { next.from = code; comboSyncing = true; comboUi.legs[i + 1].from.set([code]); comboSyncing = false; }
      comboSave();
      renderComboOut();
    } else if (legForm && t.name === 'date') {
      if (comboSyncing) return;
      combo.legs[Number(legForm.dataset.leg)].date = /^\d{4}-\d{2}-\d{2}$/.test(t.value) ? t.value : '';
      comboSave();
    } else if (t.id === 'combo-prog') {
      combo.program = t.value;
      comboSave();
      renderComboOut();
    } else if (t.name === 'combo-cabin') {
      combo.cabin = t.value;
      comboSave();
      renderComboOut();
    }
  });
  comboBody.addEventListener('click', (e) => {
    const t = e.target;
    const ex = t.closest('[data-cex]');
    if (ex) {
      const x = etData.examples[Number(ex.dataset.cex)];
      Object.assign(combo, comboClean({ legs: x.legs.map(([from, to]) => ({ from, to })), program: x.program, cabin: x.cabin }));
      comboSave();
      renderCombo();
      return;
    }
    if (t.closest('#combo-add')) {
      const last = combo.legs.at(-1);
      combo.legs.push({ from: last.to || '', to: '', date: '' });
      comboSave();
      renderCombo();
      return;
    }
    if (t.closest('#combo-clear')) {
      Object.assign(combo, comboClean({ legs: [], program: combo.program, cabin: combo.cabin }));
      comboSave();
      renderCombo();
      return;
    }
    const rm = t.closest('[data-crm]');
    if (rm) { combo.legs.splice(Number(rm.dataset.crm), 1); comboSave(); renderCombo(); return; }
    const prog = t.closest('[data-cprog]');
    if (prog) { combo.program = prog.dataset.cprog; comboSave(); renderCombo(); return; }
    const seek = t.closest('[data-seek]');
    if (seek) {
      const l = combo.legs[Number(seek.dataset.seek)];
      if (!l.from || !l.to) { toast('先填好這一段的出發地和目的地'); return; }
      const today = isoDate(0);
      const s = l.date ? clampIso(isoDateFrom(l.date, -3), today, isoDate(MAX_AHEAD_DAYS)) : today;
      const end = l.date ? clampIso(isoDateFrom(l.date, 3), today, isoDate(MAX_AHEAD_DAYS)) : isoDate(30);
      applyShare(new URLSearchParams({ o: l.from, d: l.to, s, e: end, c: combo.cabin }));
    }
  });

  // ---------- E10: 外站出發建議 (under the route search results, only on a click) ----------
  if (!$('#search-pos')) $('#search-results').insertAdjacentHTML('afterend', '<div id="search-pos"></div>'); // index.html has it in 更多分析
  const pos = { share: null, hubs: [], byHub: null, cash: {}, busy: false, home: [] };
  const posCache = new Map(); // same URL as a normal search, so the server and browser caches answer repeats
  const posHub = (id) => pos.hubs.find((h) => h.id === id);
  let posSeq = 0;
  document.addEventListener('search:start', () => { posSeq++; $('#search-pos').innerHTML = ''; pos.share = null; });
  document.addEventListener('search:done', async (e) => {
    const share = new URLSearchParams(e.detail.share);
    const n = posSeq;
    try { await etLoad(); } catch { return; }
    const hubs = etHubsFor(share, etData.positioning);
    if (!hubs.length || n !== posSeq) return;
    Object.assign(pos, { share, hubs, byHub: null, cash: {}, busy: false });
    renderPos();
  });

  function posHomeBest() {
    const c = pos.share.get('c') || 'J';
    const rows = state.results.filter((r) => !r.estimate && r.cabins?.[c]?.available).sort((a, b) => a.cabins[c].miles - b.cabins[c].miles);
    return rows[0] ? rows[0].cabins[c].miles : null;
  }
  const taxTwd = (t) => {
    if (!t?.amount) return 0;
    const rate = t.currency ? fxCache?.rates?.[t.currency.toUpperCase()] : null;
    return rate ? Math.round(t.amount * rate) : null;
  };

  function renderPos() {
    const box = $('#search-pos');
    if (!pos.share) { box.innerHTML = ''; return; }
    const cfg = etData.positioning;
    const names = pos.hubs.map((h) => h.name).join('、');
    const n = pos.hubs.length;
    const longRange = dayCount(pos.share.get('s'), pos.share.get('e') || pos.share.get('s')) > 150;
    if (!pos.byHub) {
      box.innerHTML = `<div class="pos-box">
        <button type="button" class="outline" id="pos-run" ${pos.busy ? 'disabled' : ''}>${pos.busy ? '查詢中…' : `看看從外站出發：查 ${n} 個外站（用 ${n} 次查詢）`}</button>
        <span class="hint">同樣的目的地和日期，改從${esc(names)}出發${longRange ? '；日期範圍很長時每站可能多用 1 次' : ''}</span></div>`;
      $('#pos-run').addEventListener('click', runPos);
      return;
    }
    const c = pos.share.get('c') || 'J';
    const pax = Number(pos.share.get('n')) || 0;
    const rows = etBestFromHubs(pos.byHub, c, pax);
    const home = posHomeBest();
    const people = Math.max(1, pax);
    const none = pos.hubs.filter((h) => !rows.some((r) => r.hub === h.id)).map((h) => h.name);
    box.innerHTML = `<section class="pos-out">
      <h2 class="section-title">從外站出發 <small>${esc(cfg.note)}${home ? `台灣出發最低 ${fmt(home)} 哩。` : '台灣出發這次沒有位子。'}</small></h2>
      ${rows.length ? `<div class="table-wrap"><table class="need-table pos-table"><thead><tr><th>外站</th><th>哩程票（每人）</th><th>${esc(cfg.cashFromName)}飛過去（每人）</th><th>估計合計（每人）</th><th></th></tr></thead><tbody>
        ${rows.map((r) => {
          const x = r.cabins[c];
          const hub = posHub(r.hub);
          const cashKey = `${r.hub}|${r.date}`;
          const cash = pos.cash[cashKey];
          const tax = taxTwd(x.taxes);
          const total = cash?.price && tax != null ? `${fmt(x.miles)} 哩 ＋ <b>NT$${fmt(tax + cash.price)}</b><small>稅金${x.taxes ? ` NT$${fmt(tax)}` : '未列'} ＋ 機票 NT$${fmt(cash.price)}</small>`
            : `${fmt(x.miles)} 哩${x.taxes ? ` ＋ 稅 ${tax != null ? `NT$${fmt(tax)}` : esc(taxText(x.taxes))}` : ''}<small>＋ ${esc(cfg.cashFromName)}→${esc(hub.name)}機票（未查）</small>`;
          const cashCell = cash?.price ? `<b>NT$${fmt(cash.price)}</b><small>${esc(cash.note)}</small>`
            : cash?.error ? `<small class="warn">${esc(cash.error)}</small>`
            : cashCfg.enabled ? `<button type="button" class="outline small-btn" data-pcash="${esc(cashKey)}" ${cash?.busy ? 'disabled' : ''}>${cash?.busy ? '查詢中…' : '查現金票（用 1 次查價）'}</button>` : '<small>現金票查詢未開放</small>';
          return `<tr><td><b>${esc(hub.name)}</b><small>${esc(r.origin)} → ${esc(r.destination)}・${dayLabel(r.date)}</small></td>
            <td><b>${fmt(x.miles)} 哩</b><small>${esc(srcName(r.source))}・${carriersHtml(x.airlines)}${x.direct ? '・直飛' : ''}${x.seats ? `・剩 ${x.seats} 位` : ''}</small></td>
            <td>${cashCell}</td><td>${total}</td>
            <td><button type="button" class="linklike" data-pgo="${esc(r.hub)}">看全部</button></td></tr>`;
        }).join('')}</tbody></table></div>` : `<p class="hint">${esc(names)}出發也沒有這個艙等的獎勵位。</p>`}
      ${rows.length && none.length ? `<p class="hint">${esc(none.join('、'))}出發沒有這個艙等的獎勵位。</p>` : ''}
      <details class="pos-tips"><summary>外站出發要注意</summary><ul>${[...cfg.tips, ...pos.hubs.map((h) => `${h.name}：${h.note}`)].map((t) => `<li>${esc(t)}</li>`).join('')}</ul></details>
      <p class="hint">每個外站最多列 2 個計畫。現金票為${esc(cfg.cashFromName)}（${esc(cfg.cashFrom)}）出發、同一天、${CABIN_LABEL[cfg.cashCabin]}單程最低價，${people > 1 ? `已除以 ${people} 人；` : ''}每查一次用 1 次現金票額度（需通關密碼）。稅金依當天匯率換算。</p>
    </section>`;
  }

  async function runPos() {
    if (pos.busy) return;
    const share = pos.share;
    pos.busy = true;
    renderPos();
    const byHub = {};
    let failed = 0;
    await Promise.all(pos.hubs.map(async (h) => {
      const s = new URLSearchParams(share);
      s.set('o', h.codes.join(','));
      const url = `/api/search?${searchQuery(normalizeShare(s))}`;
      if (!posCache.has(url)) posCache.set(url, api(url).catch((err) => { posCache.delete(url); throw err; }));
      try { byHub[h.id] = (await posCache.get(url)).results; } catch { failed++; byHub[h.id] = []; }
    }));
    if (pos.share !== share) return;
    pos.busy = false;
    pos.byHub = byHub;
    if (failed) toast(`有 ${failed} 個外站查詢失敗，可以稍後再試`);
    loadFx().then(renderPos).catch(() => {});
    renderPos();
  }

  $('#search-pos').addEventListener('click', async (e) => {
    const go = e.target.closest('[data-pgo]');
    if (go) {
      const s = new URLSearchParams(pos.share);
      s.set('o', posHub(go.dataset.pgo).codes.join(','));
      applyShare(s);
      return;
    }
    const b = e.target.closest('[data-pcash]');
    if (!b) return;
    const key = b.dataset.pcash;
    const [hubId, date] = key.split('|');
    const hub = posHub(hubId);
    const cfg = etData.positioning;
    const adults = Math.max(1, Number(pos.share.get('n')) || 1);
    pos.cash[key] = { busy: true };
    renderPos();
    try {
      const q = new URLSearchParams({ origin: cfg.cashFrom, destination: hub.codes.join(','), depart: date, cabin: cfg.cashCabin, adults: String(adults) });
      const body = await cashApi(`/api/cash?${q}`);
      const best = (body.options || []).filter((o) => o.price > 0).sort((x, y) => x.price - y.price)[0];
      pos.cash[key] = best ? { price: Math.round(best.price / adults), note: `${best.segments?.map((s) => s.flightNumber).filter(Boolean).join('、') || ''}${best.segments?.length > 1 ? '・轉機' : ''}${body.cached ? '・剛查過，沒用到額度' : ''}` }
        : { error: body.configured === false ? '現金票查詢未設定' : '查不到這天的現金票' };
      if (best) rememberCash(cfg.cashFrom, best.segments?.at(-1)?.to?.code || hub.codes[0], date, cfg.cashCabin, best.price / adults);
    } catch (err) {
      pos.cash[key] = { error: err.message };
    }
    renderPos();
  });

  // ---------- E14: Google 航班快捷 (help card at the end of 規則庫, and the landing from gf.html) ----------
  // Under the 書籤小工具 heading (index.html #bm-tools), or after the rules on a page without it.
  const bm = $('#bm-list');
  if (bm) $('#bm-tools').hidden = false;
  (bm || $('#rules')).insertAdjacentHTML(bm ? 'beforeend' : 'afterend', `<details class="card gf-card" id="gf-card">
    <summary><b>Google 航班快捷</b><small>在 Google 航班看到想飛的航線，一鍵帶到這裡查哩程票</small></summary>
    <div id="gf-body"><p class="hint">載入中…</p></div></details>`);
  $('#gf-card').addEventListener('toggle', () => {
    if (!$('#gf-card').open || window.GF) return renderGf();
    const s = document.createElement('script');
    s.src = `/gflights.js${ASSET_V ? `?v=${ASSET_V}` : ''}`;
    s.onload = renderGf;
    document.head.append(s);
  });
  function renderGf() {
    if (!window.GF || $('#gf-link')) return;
    const code = GF.bookmarkletCode(location.origin);
    $('#gf-body').innerHTML = `<p class="hint">這是一個「書籤小工具」：在 Google 航班的搜尋結果頁點它，會讀出出發地、目的地、日期和艙等，開新分頁用航線查詢查一次獎勵位（和一般搜尋一樣，不會自動多查）。讀不到的部分會留給你補。</p>
      <p class="gf-drag"><a class="outline btn primary-link" id="gf-link" href="${esc(code)}">✈ 查哩程票</a><span class="hint">← 電腦上把這個按鈕拖到書籤列</span></p>
      <div class="gf-how">
        <div><b>電腦版 Chrome／Edge</b><ol><li>按 Ctrl＋Shift＋B（Mac：⌘＋Shift＋B）打開書籤列。</li><li>把上面的「✈ 查哩程票」拖到書籤列。</li><li>在 Google 航班搜尋結果頁，點書籤列的「✈ 查哩程票」。</li></ol></div>
        <div><b>手機（iPhone Safari／Android Chrome）</b><ol><li>按下面的按鈕複製書籤程式碼。</li><li>隨便把一個網頁加入書籤，再編輯這個書籤：名稱改成「查哩程票」，網址整段換成剛複製的程式碼。</li><li>在 Google 航班頁面：iPhone 從書籤打開它；Android 在網址列輸入「查哩程票」，點選書籤那一項。</li></ol>
          <button type="button" class="outline" id="gf-copy">複製書籤程式碼</button></div>
      </div>`;
    $('#gf-link').addEventListener('click', (ev) => { ev.preventDefault(); toast('請把它拖到書籤列，在 Google 航班的頁面再點'); });
    $('#gf-copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(code); toast('已複製書籤程式碼'); } catch { prompt('複製這段程式碼：', code); }
    });
  }

  // Landing from gf.html. A complete parse arrives as an ordinary search link (run by app.js); its return date rides along
  // as gfr and becomes a 查回程 offer. A partial one (#gf?…) fills the search form with what was read.
  {
    const ret = tabParams('search').get('gfr');
    const q = new URLSearchParams(BOOT_HASH.startsWith('#gf?') ? BOOT_HASH.slice(4) : '');
    if (ret && tabParams('search').get('o')) {
      const sp = tabParams('search');
      sp.delete('gfr');
      setTabUrl('search', sp);
      const back = /^\d{4}-\d{2}-\d{2}$/.test(ret) ? ret : '';
      const onFirst = () => {
        document.removeEventListener('search:done', onFirst);
        if (!back) return;
        toast(`已從 Google 航班帶入去程；回程 ${mmdd(back)} 要查嗎？（用 1 次查詢）`, { label: '查回程', run: () => {
          const s = tabParams('search');
          applyShare(new URLSearchParams({ o: s.get('d'), d: s.get('o'), s: back, e: back, c: s.get('c') || 'J', ...(s.get('n') ? { n: s.get('n') } : {}) }));
        } });
      };
      document.addEventListener('search:done', onFirst);
    } else if (BOOT_HASH.startsWith('#gf?')) {
      const fill = () => {
        if (!dataReady) { setTimeout(fill, 150); return; }
        loadAirports().then(() => {
          const put = (picker, input, v) => {
            if (!v) return;
            if (/^[A-Z]{3}(,[A-Z]{3})*$/.test(v)) picker.set(v.split(','));
            else { $(input).value = v.slice(0, 40); picker.commit(); } // a name we can match becomes a chip; the rest stays typed
          };
          put(pickers.origin, '#f-origin', q.get('gfo'));
          put(pickers.destination, '#f-destination', q.get('gfd'));
          const s = q.get('gfs');
          if (/^\d{4}-\d{2}-\d{2}$/.test(s || '') && s >= isoDate(0)) datePickers.search.set(s, s);
          if (/^[YWJF]$/.test(q.get('gfc') || '')) setCabin(q.get('gfc'));
          showTab('search');
          const missing = [!q.get('gfo') && '出發地', !q.get('gfd') && '目的地', !s && '日期'].filter(Boolean);
          toast(missing.length ? `已從 Google 航班帶入，讀不到${missing.join('、')}，補上後按「搜尋機位」` : '已從 Google 航班帶入，確認後按「搜尋機位」');
        });
      };
      fill();
    }
  }
}

if (typeof module === 'object' && module.exports) module.exports = { etAnalyze, etPrice, etCheck, etEvaluate, etHubsFor, etBestFromHubs };
