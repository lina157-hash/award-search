// Booking-cost helpers on top of app.js and features.js (classic script loaded after features.js, sharing their globals):
// change/cancel fee chips (data/fees.json), award hold vs Taiwan bank transfer time (data/holds.json), sorting results
// by real NT$ cost with the user's own cost per mile (data/milecost.json), and the miles upgrade calculator in
// 點數換算器 (data/upgrades.json). None of it calls a paid API.
// The pure helpers come first and are also loaded by the tests through require(); the browser wiring is below them.

// ---------- pure helpers ----------
const atKey = (program) => (program === 'asiamiles_est' ? 'asiamiles' : program);
// Parenthetical asides make the chip too long; the full text stays in the flight details.
const atShort = (s) => String(s || '').replace(/（[^）]*）/g, '').trim();

// The short change/cancel form for one program, or null.
function feeShort(fees, program) {
  const f = fees?.programs?.[atKey(program)];
  return f && f.change && f.cancel ? { ...f, key: atKey(program) } : null;
}
const feeChipText = (f) => `改 ${atShort(f.change)}・退 ${atShort(f.cancel)}`;

// Bank → program transfer time: the first entry in holds.json that names this bank (and, when it says so, this
// points program or this airline column / other-airline name).
function transferTimeFor(holds, source, rate) {
  return (holds?.transfers || []).find((t) => t.bank === source.bank
    && (!t.sources || t.sources.includes(source.id))
    && ((!t.cols && !t.names) || (t.cols || []).includes(rate.to) || (rate.to === 'other' && (t.names || []).includes(rate.name)))) || null;
}

// Every bank points program that transfers into `program`, with its transfer time. `map` says which calculator
// column ({ to }) or other-airline name ({ name }) the program is (features.js PROGRAM_TRANSFER).
function transferRoutes(holds, calcSources, map, program) {
  const m = map?.[atKey(program)];
  if (!m) return [];
  const out = [];
  for (const s of calcSources || []) {
    const rate = (s.rates || []).find((r) => (m.to ? r.to === m.to : r.to === 'other' && r.name === m.name));
    if (!rate) continue;
    const t = transferTimeFor(holds, s, rate);
    if (t) out.push({ bank: s.bank, id: s.id, time: t });
  }
  return out;
}
const atSpeed = (t) => (t.instant ? -1 : t.days[0]);

// Hold-or-transfer advice for one program. `mine`: the user's bank programs (ids); when some of them transfer in,
// only those count. kind: instant | hold-ok | hold-short | no-hold | unknown | hold-only | none.
function holdAdvice(holds, calcSources, map, program, mine = []) {
  const hold = holds?.programs?.[atKey(program)] || null;
  const all = transferRoutes(holds, calcSources, map, program);
  const own = all.filter((r) => mine.includes(r.id));
  const routes = own.length ? own : all;
  if (!routes.length) return hold?.hold ? { kind: 'hold-only', hold, routes: [] } : { kind: 'none', hold, routes: [] };
  const fastest = routes.reduce((a, b) => (atSpeed(b.time) < atSpeed(a.time) || (atSpeed(b.time) === atSpeed(a.time) && b.time.days[1] < a.time.days[1]) ? b : a));
  const slowest = routes.reduce((x, y) => (y.time.days[1] > x.time.days[1] ? y : x));
  const base = { hold, routes, fastest, slowest, mine: own.length > 0 };
  if (fastest.time.instant) return { kind: 'instant', ...base };
  if (hold?.hold === true) return { kind: hold.days >= fastest.time.days[1] ? 'hold-ok' : 'hold-short', ...base };
  if (hold?.hold === false) return { kind: 'no-hold', ...base };
  return { kind: 'unknown', ...base };
}

// Cost per mile for one program: the user's own number, else the data default, else the fallback.
function perMileOf(costs, overrides, program) {
  const k = atKey(program);
  const own = overrides?.[k];
  if (own > 0) return own;
  return costs?.defaults?.[k] ?? costs?.fallback ?? 0.5;
}
// Only sane numbers survive (the value is synced and edited by hand).
function cleanCosts(o) {
  const out = {};
  for (const [k, v] of Object.entries(o && typeof o === 'object' && !Array.isArray(o) ? o : {})) {
    const n = Number(v);
    if (/^[a-z_]{1,30}$/.test(k) && Number.isFinite(n) && n > 0 && n <= 10) out[k] = Math.round(n * 1000) / 1000;
  }
  return out;
}
// Miles × cost per mile + taxes, in NT$. Taxes in a currency with no rate (or none given) count as 0 and say so.
function twdCost(miles, perMile, taxes, rates) {
  const milesTwd = miles * perMile;
  let tax = 0;
  let taxKnown = false;
  if (taxes && taxes.amount != null) {
    const cur = String(taxes.currency || '').toUpperCase();
    const rate = cur === 'TWD' ? 1 : rates?.[cur];
    if (rate) { tax = taxes.amount * rate; taxKnown = true; }
  }
  return { twd: Math.round(milesTwd + tax), milesTwd: Math.round(milesTwd), tax: Math.round(tax), taxKnown };
}

// Upgrade calculator. Areas match on airport first, then country.
function inUpArea(area, ap) {
  if (!area || !ap) return false;
  if (area.excludeAirports?.includes(ap.code)) return false;
  if (area.airports?.includes(ap.code)) return true;
  return (area.countries || []).includes(ap.country);
}
// The from → to pairs one airline prices, in chart order.
function upgradePairs(air) {
  const seen = new Set();
  return (air?.charts || []).map((c) => `${c.from}-${c.to}`).filter((p) => !seen.has(p) && seen.add(p));
}
// Miles and qualifying fares for one route and one upgrade; `dist` (miles) is only used by distance charts.
// Returns { air, charts: [{ label, zone, fares: [{ label, codes, miles }] }] } or null for an unknown airline.
function upgradeQuote(upg, airlineId, a, b, from, to, dist) {
  const air = upg?.airlines?.find((x) => x.id === airlineId);
  if (!air) return null;
  const charts = [];
  for (const ch of air.charts.filter((c) => c.from === from && c.to === to)) {
    if (air.kind === 'distance') {
      const i = ch.bands.findIndex((x) => x.upTo == null || dist <= x.upTo);
      if (i < 0) continue;
      const band = ch.bands[i];
      const lo = i ? ch.bands[i - 1].upTo + 1 : 0;
      const fromJapan = a.country === 'JP';
      charts.push({ label: ch.label, zone: `航段距離 ${lo.toLocaleString('en-US')}${band.upTo == null ? ' 哩以上' : `–${band.upTo.toLocaleString('en-US')} 哩`}`, band: [lo, band.upTo], fromJapan,
        fares: ch.fares.map((f) => ({ label: f.label, codes: fromJapan && f.codesFromJapan ? f.codesFromJapan : f.codes, miles: band.miles })) });
      continue;
    }
    const row = ch.rows.find((r) => {
      const [x, y] = r.between.map((id) => upg.areas[id]);
      return (inUpArea(x, a) && inUpArea(y, b)) || (inUpArea(x, b) && inUpArea(y, a));
    });
    if (!row) continue;
    charts.push({ label: ch.label, zone: row.name, fares: (air.fares?.[from] || []).map((f) => ({ label: f.label, codes: f.codes, miles: row.miles[f.id] ?? null })) });
  }
  return { air, charts };
}

// ---------- browser wiring ----------
function initAwardTools() {
  // The four data files ride in /api/data/all (cached per release), so this is usually served from the browser cache.
  const ready = api(`/api/data/all${ASSET_V ? `?v=${encodeURIComponent(ASSET_V)}` : ''}`)
    .then((all) => { for (const n of ['fees', 'holds', 'milecost', 'upgrades']) data[n] = all[n]; })
    .catch(() => {})
    .then(() => {
      if (state.results?.length && !$('#search-results').hidden) renderSearch();
      if (currentTab === 'points' && pointsView.view === 'upgrade') renderPoints();
    });
  awardTools.ready = ready;
  if (tabSub.points === 'upgrade') pointsView.view = 'upgrade';

  $('#search-results').addEventListener('change', (e) => {
    if (e.target.id !== 'result-sort') return;
    store.set(SORT_KEY, e.target.value);
    if (e.target.value === 'twd' && !fxCache) loadFx().then(() => renderSearch()).catch(() => {});
    renderSearch();
  });
  $('#search-results').addEventListener('click', (e) => {
    if (e.target.closest('#cost-settings')) openCostSettings(e.target.closest('#cost-settings'));
  });
  if (costSortOn()) loadFx().catch(() => {});
}
const awardTools = { ready: null };

// ---------- E12: change / cancel fee chip ----------
function feeChipHtml(program) {
  const f = feeShort(data.fees, program);
  return f ? `<div class="fee-chip" title="${esc(`改票：${f.change}；取消：${f.cancel}${f.note ? `；${f.note}` : ''}`)}">${esc(feeChipText(f))}</div>` : '';
}
function feeHeadHtml(program) {
  const f = feeShort(data.fees, program);
  return f ? `<small class="fee-mini" title="${esc(`改票：${f.change}；取消：${f.cancel}`)}">${esc(feeChipText(f))}</small>` : '';
}

// ---------- E2 + E12 in the flight details: fees, and hold the seat or transfer first ----------
const PROGRAM_CARD_ID = { eva: 'evainfinity', ci: 'dynastyflyer' };
function holdLineHtml(program, miles) {
  const key = atKey(program);
  if (!data.holds) return '';
  // Enough miles already in the program itself: nothing to wait for.
  if (miles > 0 && (wallet.miles[key] || 0) >= miles) return '';
  const map = { ...PROGRAM_TRANSFER, ana: { name: '全日空' } };
  const a = holdAdvice(data.holds, data.points?.calc?.sources, map, key, Object.keys(wallet.banks));
  // A space after a Latin-script name reads better before the Chinese that follows («加航 Aeroplan 不能…»).
  const name = esc(programName(key)) + (/[A-Za-z]$/.test(programName(key)) ? ' ' : '');
  const h = a.hold;
  const holdText = h?.hold ? `可${esc(h.how || '')}保留約 ${h.days} 天${h.fee ? `（${esc(h.fee)}）` : ''}` : '';
  const bank = a.fastest ? `${a.mine ? '你的' : ''}${esc(a.fastest.bank)}轉點${esc(a.fastest.time.text)}` : '';
  let cls = 'warn';
  let head;
  let tail = '';
  if (a.kind === 'none') return '';
  if (a.kind === 'hold-only') return `<p class="bk-line"><b>保留座位</b>　${name}${holdText}<small>${h.note ? `${esc(h.note)}；` : ''}台灣的卡點不能直接轉入，哩程要另外湊。</small></p>`;
  else if (a.kind === 'instant') {
    cls = 'ok';
    head = '可以先確認座位再轉點';
    const slow = !a.mine && a.slowest.time.days[1] > 7 ? `；其他銀行最慢${esc(a.slowest.time.text)}，用那些點數就要先轉好` : '';
    tail = `${bank}${slow}。`;
  }
  else if (a.kind === 'hold-ok') { cls = 'ok'; head = '先保留座位再轉點'; tail = `${name}${holdText}，${bank}。`; }
  else if (a.kind === 'hold-short') { head = `${bank}，座位可能先被訂走`; tail = `${name}${holdText}，通常等不到點數入帳。建議先把點數轉好再訂。`; }
  else if (a.kind === 'no-hold') { head = `${bank}，座位可能先被訂走`; tail = `${name}不能保留座位${h.note ? `；${esc(h.note)}` : ''}。建議先把點數轉好再訂。`; }
  else { head = bank; tail = `${name}能否先保留座位未確認${h?.note ? `；${esc(h.note)}` : ''}。轉點前先問客服。`; }
  const guess = a.fastest && a.fastest.time.confidence !== 'official' ? '<span class="tag verify" title="轉點時間未在銀行官方資料核實">轉點時間待確認</span>' : '';
  return `<p class="bk-line ${cls}"><b>${a.kind === 'instant' || a.kind === 'hold-ok' ? '✓' : '⏳'} ${head}</b><small>${tail} ${guess}</small></p>`;
}
function bookingNotesHtml(program, miles) {
  const key = atKey(program);
  const f = feeShort(data.fees, key);
  const hold = holdLineHtml(key, miles);
  if (!f && !hold) return '';
  const card = data.programs?.programs?.find((p) => p.id === (PROGRAM_CARD_ID[key] || key));
  const fee = f ? `<p class="bk-line"><b>改退票</b>　改票 ${esc(f.change)}・取消 ${esc(f.cancel)}<small>${f.note ? `${esc(f.note)}。` : ''}${f.confidence === 'secondary' ? '第三方整理，' : ''}以計畫官網為準。${card ? ` <a href="#rules" data-prog-card="${esc(card.id)}">完整規定</a>` : ''}</small></p>` : '';
  return `<div class="bk-notes">${fee}${hold}</div>`;
}

// ---------- E3: sort by real NT$ cost ----------
const SORT_KEY = 'resultSort';
const COST_KEY = 'mileCost:v1';
const costSortOn = () => store.get(SORT_KEY, '') === 'twd';
const costOverrides = () => cleanCosts(store.get(COST_KEY, {}));
function atRowCost(r, c, own = costOverrides()) {
  const x = r.cabins[c];
  return twdCost(x.miles, perMileOf(data.milecost, own, r.source), x.taxes, fxCache?.rates);
}
function resultSortHtml() {
  const on = costSortOn();
  return `<label class="field compact">排序<select id="result-sort"><option value="">日期／哩數</option><option value="twd" ${on ? 'selected' : ''}>依台幣成本</option></select></label>
    ${on ? '<button type="button" class="linklike cost-link" id="cost-settings" aria-haspopup="dialog">每哩成本</button>' : ''}`;
}
// Best-deal cards by cost: the cheapest of each program first, at most four.
function costPicks(rows, c) {
  if (!costSortOn()) return null;
  const own = costOverrides();
  const sorted = rows.map((r) => ({ r, k: atRowCost(r, c, own).twd })).sort((a, b) => a.k - b.k).map((x) => x.r);
  const picks = [];
  const seen = new Set();
  for (const r of sorted) if (picks.length < 4 && !seen.has(r.source)) { seen.add(r.source); picks.push(r); }
  for (const r of sorted) if (picks.length < 4 && !picks.includes(r)) picks.push(r);
  return picks.sort((a, b) => sorted.indexOf(a) - sorted.indexOf(b));
}
function costLineHtml(r, c) {
  if (!costSortOn()) return '';
  const k = atRowCost(r, c);
  const per = perMileOf(data.milecost, costOverrides(), r.source);
  return `<div class="cost-line">≈ NT$${fmt(k.twd)}<small>每哩 NT$${per}${k.taxKnown ? '，含稅金' : r.cabins[c].taxes ? '，稅金未換算' : '，未含稅金'}</small></div>`;
}
function costCellHtml(r, c) {
  return costSortOn() && !r.estimate ? `<i class="cost">≈NT$${fmt(atRowCost(r, c).twd)}</i>` : '';
}
// Table rows (date × route) ordered by their cheapest cost among the shown programs.
function costSortKeys(keys, grid, c, sources) {
  if (!costSortOn()) return keys;
  const own = costOverrides();
  const best = new Map(keys.map((k) => {
    const costs = Object.values(grid.get(k)).filter((r) => !r.estimate && sources.includes(r.source) && cab(r, c)).map((r) => atRowCost(r, c, own).twd);
    return [k, costs.length ? Math.min(...costs) : Infinity];
  }));
  return [...keys].sort((a, b) => best.get(a) - best.get(b));
}

// Cost-per-mile settings: one small popover listing the programs in the current results.
let costDlg = null;
function openCostSettings(anchor) {
  if (!costDlg) {
    costDlg = document.createElement('dialog');
    costDlg.className = 'cost-pop';
    costDlg.setAttribute('aria-labelledby', 'cost-pop-title');
    document.body.appendChild(costDlg);
    costDlg.addEventListener('click', (e) => {
      if (e.target === costDlg || e.target.closest('[data-cost-close]')) { costDlg.close(); return; }
      if (e.target.closest('[data-cost-reset]')) { store.del(COST_KEY); paintCostSettings(); renderSearch(); }
    });
    let t = 0;
    costDlg.addEventListener('input', (e) => {
      const k = e.target.dataset.cost;
      if (!k) return;
      const own = costOverrides();
      const n = Number(e.target.value);
      if (e.target.value === '' || !(n > 0)) delete own[k]; else own[k] = n;
      const clean = cleanCosts(own);
      if (Object.keys(clean).length) store.set(COST_KEY, clean); else store.del(COST_KEY);
      clearTimeout(t);
      t = setTimeout(renderSearch, 250);
    });
  }
  paintCostSettings();
  costDlg.showModal();
  const r = anchor.getBoundingClientRect();
  const w = Math.min(340, innerWidth - 24);
  costDlg.style.cssText = `left:${Math.max(12, Math.min(r.left, innerWidth - w - 12))}px;top:${r.bottom + 6}px;width:${w}px`;
  const h = costDlg.offsetHeight;
  if (r.bottom + 6 + h > innerHeight - 12) costDlg.style.top = `${Math.max(12, innerHeight - 12 - h)}px`;
  $('input', costDlg)?.focus();
}
function paintCostSettings() {
  const own = costOverrides();
  const keys = [...new Set(state.results.filter((r) => !r.estimate).map((r) => atKey(r.source)))]
    .sort((a, b) => programName(a).localeCompare(programName(b), 'zh-Hant'));
  costDlg.innerHTML = `<div class="cost-head"><h2 id="cost-pop-title">每哩成本 <small>NT$／哩</small></h2><button type="button" class="ghost" data-cost-close aria-label="關閉">✕</button></div>
    <p class="hint">你拿到 1 哩大約花多少錢。空白就用預設值；台幣成本 ＝ 哩數 × 每哩成本 ＋ 稅金。</p>
    <div class="cost-rows">${keys.map((k) => `<label><span>${esc(programName(k))}</span><input type="number" inputmode="decimal" min="0" max="10" step="0.05" data-cost="${esc(k)}" value="${own[k] ?? ''}" placeholder="${perMileOf(data.milecost, {}, k)}"></label>`).join('')}</div>
    <div class="cost-foot"><small>${typeof signedIn === 'function' && signedIn() ? '存在這台裝置，並同步到你的帳號。' : '存在這台裝置；登入後會同步。'}</small><button type="button" class="linklike" data-cost-reset>恢復預設</button></div>`;
}

// ---------- E7: miles upgrade calculator (點數換算器 › 升等試算) ----------
const upgState = { air: 'eva', pair: 'Y-J', origin: 'TPE', destination: '' };
const UPG_CABIN = { Y: '經濟艙', W: '豪華經濟艙', J: '商務艙', F: '頭等艙' };
const upgPairLabel = (p) => { const [f, t] = p.split('-'); return `${UPG_CABIN[f]} → ${UPG_CABIN[t]}`; };
function upgradeHtml() {
  const U = data.upgrades;
  if (!U) { awardTools.ready?.then(() => { if (pointsView.view === 'upgrade' && data.upgrades) renderPoints(); }); return '<p class="hint">升等資料載入中…</p>'; }
  const air = U.airlines.find((a) => a.id === upgState.air) || U.airlines[0];
  upgState.air = air.id;
  const pairs = upgradePairs(air);
  if (!pairs.includes(upgState.pair)) upgState.pair = pairs.includes('Y-J') ? 'Y-J' : pairs[0];
  return `<form id="upg-form" class="need upg" autocomplete="off">
    <p class="hint">已經買好現金票，想用哩程升等？選航空公司、航線和艙等，看每段單程要多少哩、哪些票價艙等可以升。不查座位、不花額度。</p>
    <div class="opts-row">
      <label class="field">航空公司<select id="upg-air">${U.airlines.map((a) => `<option value="${esc(a.id)}" ${a.id === air.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>
      <label class="field">升等<select id="upg-pair">${pairs.map((p) => `<option value="${p}" ${p === upgState.pair ? 'selected' : ''}>${upgPairLabel(p)}</option>`).join('')}</select></label>
    </div>
    <div class="route-row">
      <div class="field grow ac-host">
        <label for="u-origin">出發地</label>
        <div class="chips-box" data-for="origin"><span class="chips"></span>
          <input id="u-origin" class="chips-q" placeholder="城市、機場或代碼" autocapitalize="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="ac-u-origin"></div>
        <input type="hidden" name="origin" value="${esc(upgState.origin)}">
        <div class="ac-list" id="ac-u-origin" role="listbox" aria-label="出發地建議" hidden></div>
      </div>
      <div class="field grow ac-host ac-end">
        <label for="u-destination">目的地</label>
        <div class="chips-box" data-for="destination"><span class="chips"></span>
          <input id="u-destination" class="chips-q" placeholder="城市、機場或代碼" autocapitalize="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="ac-u-destination"></div>
        <input type="hidden" name="destination" value="${esc(upgState.destination)}">
        <div class="ac-list" id="ac-u-destination" role="listbox" aria-label="目的地建議" hidden></div>
      </div>
    </div>
    <div class="opts-row"><button type="submit" class="primary">試算</button></div>
  </form>
  <div id="upg-result"></div>`;
}
function bindUpgrade(host) {
  const form = $('#upg-form', host);
  if (!form) return;
  const pk = { origin: createAirportPicker(form, 'origin'), destination: createAirportPicker(form, 'destination') };
  $('#upg-air', form).addEventListener('change', (e) => { upgState.air = e.target.value; renderPoints(); });
  $('#upg-pair', form).addEventListener('change', (e) => { upgState.pair = e.target.value; renderUpgrade(); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    await loadAirports();
    for (const p of Object.values(pk)) {
      const unknown = p.commit();
      if (unknown.length || !p.codes().length) { toast(unknown.length ? `找不到「${unknown.join('、')}」` : `請輸入${p.label}`); p.focus(); return; }
    }
    upgState.origin = pk.origin.codes()[0];
    upgState.destination = pk.destination.codes()[0];
    renderUpgrade();
  });
  if (upgState.origin && upgState.destination) loadAirports().then(renderUpgrade);
}
function renderUpgrade() {
  const host = $('#upg-result');
  const a = AP.byCode.get(upgState.origin);
  const b = AP.byCode.get(upgState.destination);
  if (!host || !a || !b || !data.upgrades) return;
  const [from, to] = upgState.pair.split('-');
  const dist = a.lat != null && b.lat != null ? haversineMiles(a, b) : 0;
  const q = upgradeQuote(data.upgrades, upgState.air, a, b, from, to, dist);
  if (!q) return;
  const { air } = q;
  const codes = (f) => (f.codes.length ? f.codes.join('、') : '—');
  const table = (ch) => `<div class="upg-card">
    <div class="upg-zone"><b>${esc(ch.zone)}</b>${ch.label ? `<span class="pill">${esc(ch.label)}</span>` : ''}${ch.fromJapan != null ? `<small>${ch.fromJapan ? '日本出發' : '日本以外出發'}的可升等艙等</small>` : ''}</div>
    <div class="table-wrap"><table class="upg-table"><thead><tr><th>你的機票</th><th>可升等的艙等代碼</th><th>每段單程</th></tr></thead><tbody>
      ${ch.fares.map((f) => `<tr><td>${esc(f.label)}</td><td>${esc(codes(f))}</td><td>${f.miles ? `<b>${fmt(f.miles)} 哩</b>` : '<span class="muted">不適用</span>'}</td></tr>`).join('')}
    </tbody></table></div></div>`;
  const not = air.notEligible?.[from] || air.notEligible?.['*'];
  const src = (air.sources || []).map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)} ↗</a>`).join('　');
  const other = upgradePairs(air).filter((p) => p !== upgState.pair && upgradeQuote(data.upgrades, air.id, a, b, ...p.split('-'), dist).charts.length);
  host.innerHTML = `<h3 class="sub">${esc(air.name)}　${esc(upgState.origin)} ${esc(airportCity(upgState.origin))} → ${esc(upgState.destination)} ${esc(airportCity(upgState.destination))}　${upgPairLabel(upgState.pair)}</h3>
    ${q.charts.length ? q.charts.map(table).join('') : `<p class="hint">這條航線沒有${esc(air.name)}的${upgPairLabel(upgState.pair)}升等價格（航線不在表上，或這條線沒有這個艙等）。${other.length ? `可以試試：${other.map((p) => `<button type="button" class="linklike" data-upg-pair="${p}">${upgPairLabel(p)}</button>`).join('、')}` : ''}</p>`}
    ${q.charts.length && not ? `<p class="hint">✕ ${esc(not)}</p>` : ''}
    <ul class="upg-rules">${(air.rules || []).map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
    <p class="hint upg-src">${CONFIDENCE_TAG[air.confidence] || ''} ${esc(air.program)}・整理於 ${esc(air.lastVerified || data.upgrades.lastReviewed || '')}<br>${src}</p>`;
  $$('[data-upg-pair]', host).forEach((btn) => btn.addEventListener('click', () => { upgState.pair = btn.dataset.upgPair; $('#upg-pair').value = upgState.pair; renderUpgrade(); }));
}

// Node (the tests) gets the pure helpers; the browser starts the wiring once every declaration above exists.
if (typeof module === 'object' && module.exports) {
  module.exports = { feeShort, feeChipText, transferTimeFor, transferRoutes, holdAdvice, perMileOf, cleanCosts, twdCost, inUpArea, upgradePairs, upgradeQuote };
} else {
  initAwardTools();
}
