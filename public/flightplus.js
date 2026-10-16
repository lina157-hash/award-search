// Round 6 additions to the route results and the flight details (classic script loaded after award-tools.js, sharing
// the globals of app.js and features.js): 「這班還可以用」 (other programs' fixed charts for the same flight, with the
// Taiwan card points each costs), 哩數水準 (today's price against the route's stored history), 差一點 (flights the
// 「至少 N 位」 filter hid) and 混艙標示 (itineraries flown partly in a lower cabin). Nothing here spends quota except
// 「也看混艙行程」, one seats.aero call, which its button says.
// The pure helpers come first and are also loaded by the tests through require(); the browser wiring is below them.

// ---------- pure helpers ----------
// Which operating airlines each fixed chart in data/charts.json prices. Partner charts leave out the program's own
// airline (priced another way), own-airline charts cover only that airline. `tables`: which of the chart's tables to
// use per airline (matched in the table's label), '*' for the rest. Asia Miles has its own line (amTripLine); dynamic
// programs and round-trip-only charts (jal_partner) have no one-way price to give.
const ALSO_CHARTS = {
  eva: { only: ['BR', 'B7'] },
  ci: { only: ['CI', 'AE'] },
  jal: { only: ['JL'] },
  ana: { alliance: 'star', not: ['NH'] },
  singapore: { alliance: 'star', not: ['SQ'] },
  turkish: { alliance: 'star', not: ['TK'] },
  aeroplan: { alliance: 'star', not: ['AC'] },
  british: { alliance: 'oneworld', not: ['BA'], tables: { CX: '國泰', JL: '日本航空', AA: '美國航空', AS: '阿拉斯加', '*': '一般夥伴' } },
  american: { alliance: 'oneworld', not: ['AA'] },
  alaska: { alliance: 'oneworld', also: ['JX'], not: ['AS', 'HA'] },
};
const segCarrier = (s) => String(s?.flight || '').slice(0, 2).toUpperCase();
const alsoCovers = (rule, carrier, members) => (rule.only ? rule.only.includes(carrier)
  : !(rule.not || []).includes(carrier) && ((members[rule.alliance] || []).includes(carrier) || (rule.also || []).includes(carrier)));

// Chart programs that price every leg of `trip` (its own program left out). `members`: alliance id → airline codes.
function alsoProgramIds(trip, members) {
  const ops = [...new Set((trip?.segments || []).map(segCarrier))];
  if (!ops.length || ops.some((c) => !/^[A-Z0-9]{2}$/.test(c))) return [];
  return Object.keys(ALSO_CHARTS).filter((id) => id !== trip.source && ops.every((c) => alsoCovers(ALSO_CHARTS[id], c, members)));
}

// One program's chart price for the whole trip: { miles, label, note, multi } or null. `price` is features.js
// chartPrices (p, from, to, cabin, dist) → [{ label, miles, note }], `airport(code)` the airport record with country and
// coordinates, `dist(a, b)` the great-circle miles when seats.aero gave no segment distance. A per-segment chart (Avios)
// prices each flight with its airline's table and adds them up; the others price the whole trip on its flown distance.
function alsoEstimate(p, trip, cabin, { price, airport, dist }) {
  const rule = ALSO_CHARTS[p?.id];
  const segs = trip?.segments || [];
  if (!rule || !segs.length) return null;
  const pick = (list, carrier) => {
    if (!list.length) return null;
    if (rule.tables) { const want = rule.tables[carrier] || rule.tables['*']; return list.find((x) => x.label.includes(want)) || null; }
    return list.reduce((a, b) => (b.miles < a.miles ? b : a));
  };
  const ops = [...new Set(segs.map(segCarrier))];
  if (p.perSegment) {
    let miles = 0;
    let one = null;
    for (const s of segs) {
      const a = airport(s.from);
      const b = airport(s.to);
      if (!a || !b) return null;
      one = pick(price(p, a, b, cabin, s.distance || dist(a, b)), segCarrier(s));
      if (!one) return null;
      miles += one.miles;
    }
    return { miles, label: segs.length > 1 ? `${segs.length} 段分開計價` : one.label, note: segs.length > 1 ? '每段依距離計價後相加' : one.note, multi: ops.length > 1, ...(segs.length === 1 ? { bands: one.bands, d: one.d } : {}) };
  }
  const a = airport(segs[0].from);
  const b = airport(segs.at(-1).to);
  if (!a || !b) return null;
  const flown = segs.reduce((n, s) => n + (Number(s.distance) || 0), 0) || dist(a, b);
  const x = pick(price(p, a, b, cabin, flown), ops[0]);
  return x ? { miles: x.miles, label: x.label, note: x.note, multi: ops.length > 1, bands: x.bands, d: x.d } : null;
}

// The fewest Taiwan card points that buy `miles` in `program`, one entry per bank points program, cheapest first:
// [{ source, rate, points }]. `map`: program → calculator column ({ to }) or other-airline name ({ name }), as
// features.js PROGRAM_TRANSFER. Rates past their validUntil (or a bank's whole table past its date) are left out.
// `convert`: app.js calcConvert (minimums and steps).
function alsoBanks(program, miles, { sources, map, convert, today }) {
  const m = map?.[program];
  if (!m || !(miles > 0)) return [];
  const best = new Map();
  for (const s of sources || []) {
    if (s.validUntil && s.validUntil < today) continue;
    for (const rate of s.rates || []) {
      if (!(m.to ? rate.to === m.to : rate.to === 'other' && rate.name === m.name) || (rate.validUntil && rate.validUntil < today)) continue;
      const points = convert(rate, miles, 'm2p').value;
      if (points > 0 && !(best.get(s.id)?.points <= points)) best.set(s.id, { source: s, rate, points });
    }
  }
  return [...best.values()].sort((a, b) => a.points - b.points);
}

// 哩數水準: a price against the program's usual one on this route. `prices`: its daily lowest miles from the stored
// history. Null when fewer than `minDays` days had space (too little to say). `usual` is the lower median (a price
// that was seen). A fixed-chart program at its usual price, or one whose history never moved, reads 固定價; a clear
// step below or above the usual range reads cheap or dear.
function priceLevel(cur, prices, { fixed = false, minDays = 7 } = {}) {
  const xs = (prices || []).filter((n) => n > 0).sort((a, b) => a - b);
  if (!(cur > 0) || xs.length < minDays) return null;
  const at = (q) => xs[Math.round(q * (xs.length - 1))];
  const usual = xs[Math.floor((xs.length - 1) / 2)];
  const base = { usual, n: xs.length };
  if (cur === usual && (fixed || xs[0] === xs.at(-1))) return { level: 'fixed', ...base };
  if (cur < usual && cur <= at(0.25) && cur <= usual * 0.95) return { level: 'cheap', ...base };
  if (cur > usual && cur >= at(0.75) && cur >= usual * 1.05) return { level: 'dear', ...base };
  return { level: 'normal', ...base };
}
const LEVEL_TEXT = { cheap: '比平常便宜', normal: '一般', dear: '偏貴', fixed: '固定價' };
// Programs priced from a published chart (data/charts.json), as opposed to dynamic ones.
const fixedChartIds = (charts) => new Set((charts?.programs || []).filter((p) => ['distance', 'zone', 'regionMatrix'].includes(p.kind) || (p.kind === 'routeSpecific' && p.routes?.length)).map((p) => p.id));

// 什麼時候放位: buckets of days before departure (lib/history.js mergeLead), and one program's line.
const LEAD_TEXT = ['14 天內', '14–60 天', '60–180 天', '180–300 天', '300 天以上'];
// { i, k, n }: the bucket holding at least half of the `n` counted dates, or i = -1 when they are spread out.
function leadMain(b) {
  const n = (b || []).reduce((a, x) => a + x, 0);
  const i = n ? b.indexOf(Math.max(...b)) : -1;
  return i >= 0 && b[i] * 2 >= n ? { i, k: b[i], n } : { i: -1, k: 0, n };
}

// 差一點: flights with space in the cabin but fewer seats than the party, grouped by date, route and airlines (two
// programs showing seats on one flight usually show the same partner seats). A group where some program already has
// enough seats (or an unknown count, which the filter keeps) is not short. Most seats first, then the date.
// → { list: [{ date, origin, destination, airlines, seats, short, programs: [{ source, seats, miles, id }] }], total }
function seatGaps(rows, cabin, pax, { limit = 12 } = {}) {
  if (!(pax > 1)) return { list: [], total: 0 };
  const key = (r) => `${r.date}|${r.origin}|${r.destination}|${r.cabins[cabin].airlines || ''}`;
  const enough = new Set();
  const groups = new Map();
  for (const r of rows || []) {
    const x = r.cabins?.[cabin];
    if (r.estimate || !x?.available || !x.miles) continue;
    if (!(x.seats > 0) || x.seats >= pax) { enough.add(key(r)); continue; }
    const k = key(r);
    const g = groups.get(k) || { date: r.date, origin: r.origin, destination: r.destination, airlines: x.airlines || '', seats: 0, programs: [] };
    g.programs.push({ source: r.source, seats: x.seats, miles: x.miles, id: r.id });
    g.seats = Math.max(g.seats, x.seats);
    groups.set(k, g);
  }
  const all = [...groups.entries()].filter(([k]) => !enough.has(k)).map(([, g]) => ({ ...g, short: pax - g.seats, programs: g.programs.sort((a, b) => b.seats - a.seats || a.miles - b.miles) }))
    .sort((a, b) => b.seats - a.seats || a.date.localeCompare(b.date) || a.programs[0].miles - b.programs[0].miles);
  return { list: all.slice(0, limit), total: all.length };
}

// ---------- browser ----------
// 「這班還可以用」 under a flight in the details: folded; the prices are worked out when it is opened (the airport list
// with countries and coordinates loads then if it has not yet).
const alsoTrips = new Map();
let alsoSeq = 0;
const allianceMembers = () => Object.fromEntries((data.alliances?.alliances || []).map((a) => [a.id, a.members]));
const alsoChart = (id) => data.charts?.programs?.find((p) => p.id === id && p.oneWay !== false) || null;
function alsoFoldHtml(t) {
  if (!data.charts || !data.alliances || !t?.segments?.length) return '';
  const ids = alsoProgramIds(t, allianceMembers()).filter(alsoChart);
  if (!ids.length) return '';
  if (alsoTrips.size > 200) alsoTrips.clear();
  const k = String(++alsoSeq);
  alsoTrips.set(k, t);
  return `<details class="also" data-also="${k}"><summary>🔁 這班還可以用 <small>其他 ${ids.length} 個計畫的固定哩程表估算</small></summary><div class="also-body"><p class="hint">計算中…</p></div></details>`;
}
async function alsoFill(box) {
  const t = alsoTrips.get(box.dataset.also);
  const body = $('.also-body', box);
  if (!t || box.dataset.done) return;
  box.dataset.done = '1';
  // mapkit.js brings 級距邊緣提醒 (mkEdge); the list draws without it if it would not load.
  await Promise.all([loadAirports(), typeof loadMapkit === 'function' ? loadMapkit() : null]);
  const cabin = CABIN_KEY[t.cabin] || 'J';
  const dep = { price: chartPrices, airport: (c) => AP.byCode.get(c) || null, dist: haversineMiles };
  const map = { ...PROGRAM_TRANSFER, ana: { name: '全日空' } };
  const mine = new Set(Object.keys(wallet.banks || {}));
  const rows = alsoProgramIds(t, allianceMembers()).map(alsoChart).filter(Boolean)
    .map((p) => ({ p, est: alsoEstimate(p, t, cabin, dep) })).filter((x) => x.est).sort((a, b) => a.est.miles - b.est.miles);
  if (!rows.length) { body.innerHTML = '<p class="hint">這條航線查不到適用的固定哩程表（有些表只算台灣出發，或這個艙等沒有公布）。</p>'; return; }
  const today = twDate(0);
  body.innerHTML = `<ul class="also-list">${rows.map(({ p, est }) => {
    const diff = t.miles ? est.miles - t.miles : 0;
    const banks = alsoBanks(p.id, est.miles, { sources: data.points?.calc?.sources, map, convert: calcConvert, today });
    const own = banks.find((x) => mine.has(x.source.id));
    const bank = own || banks[0];
    const bankText = bank ? `${own ? '用你的' : '台灣卡點最省：'}${esc(bankLabel(bank.source))} 約 ${fmt(bank.points)} 點（${esc(ratioLabel(bank.rate))}）` : '台灣的卡點不能直接轉入';
    const src = p.sources?.[0];
    const edge = typeof mkEdge === 'function' ? mkEdge(est.bands, est.d) : null;
    return `<li><div class="also-top"><b>${esc(p.name)}</b><span class="also-miles">約 ${fmt(est.miles)} 哩</span>${diff ? `<small class="also-diff ${diff < 0 ? 'less' : ''}">比這張${diff < 0 ? '少' : '多'} ${fmt(Math.abs(diff))}</small>` : '<small class="also-diff">一樣</small>'}</div>
      <small class="also-meta">${esc(est.label)}${est.note ? `・${esc(est.note)}` : ''}${est.multi ? '・多家航空轉機，能不能開同一張票依計畫規定' : ''}</small>
      ${edge ? `<small class="also-meta mk-edge">⚠ ${esc(mkEdgeText(edge, est.d))}</small>` : ''}
      <small class="also-meta">💳 ${bankText}　${CONFIDENCE_TAG[p.confidence] || ''}${src ? ` <a href="${esc(src.url)}" target="_blank" rel="noopener">${esc(src.label)} ↗</a>` : ''}</small></li>`;
  }).join('')}</ul>
  <p class="hint">依各計畫公布的固定哩程表估算單程最低價，不含稅金與燃油附加費。要該計畫看得到夥伴機位才換得到；同一班的夥伴位子通常和 United、Aeroplan 等看到的是同一批（常見情況，不是官方規則），轉點前先在該計畫查到位。</p>`;
}

// 混艙: seats.aero gives only the share of the distance flown below the trip's cabin, not which leg.
function mixedHtml(t) {
  if (!(t?.mixedPct > 0)) return '';
  const name = CABIN_ZH[t.cabin] || '這個艙等';
  return `<p class="mixed-line">⚠️ 混艙：約 ${t.mixedPct}% 的飛行距離坐比${esc(name)}低的艙等；${esc(name)}約佔 ${100 - t.mixedPct}%（seats.aero 沒有標出是哪一段）。</p>`;
}
// 「也看混艙行程」 at the end of the flights: seats.aero leaves mixed-cabin itineraries out unless asked (one call).
function mixedMount(id, cabin) {
  const body = $('#trip-body');
  if (!body || !id || !['premium', 'business', 'first'].includes(CABIN_API[cabin]) || String(id).startsWith('am-')) return;
  const after = $$('#trip-body > .trip, #trip-body > .ai-box, #trip-body > details:not(.also)').at(-1);
  if (!after) return;
  const box = document.createElement('div');
  box.className = 'mixed-box';
  box.innerHTML = `<button type="button" class="linklike">也看混艙行程（部分航段坐較低艙等，用 1 次查詢）</button>`;
  after.after(box);
  // Still the same dialog when the answer comes (app.js counts the dialog's openings in seq.trips).
  const n = seq.trips;
  const fresh = () => n === seq.trips;
  $('button', box).addEventListener('click', async () => {
    box.innerHTML = '<p class="hint">正在查混艙行程…</p>';
    try {
      const res = await api(`/api/trips/${encodeURIComponent(id)}?mixed=1`);
      if (!fresh()) return;
      const want = CABIN_API[cabin];
      const list = res.trips.filter((t) => t.mixedPct > 0 && t.cabin === want).sort((a, b) => a.miles - b.miles);
      box.innerHTML = list.length ? `<h3 class="sub">混艙行程 ${list.length} 筆</h3>${list.map((t) => tripHtml(t, null)).join('')}` : '<p class="hint">這天沒有混艙行程（至少一半距離坐這個艙等的）。</p>';
    } catch (err) {
      if (fresh()) box.innerHTML = `<p class="status error">${esc(err.message)}</p>`;
    }
  });
}

// 哩數水準 on the 最划算的選擇 cards: needs the route's history (seathistory.js, /api/history), which arrives after
// the results; levelRefresh redraws the cards then.
function levelOf(r, c) {
  const body = typeof histSeq === 'object' ? histSeq.body : null;
  const route = body?.routes?.find((x) => x.origin === r.origin && x.destination === r.destination);
  const s = route?.series?.find((x) => x.source === r.source && x.cabin === c);
  return s && !r.estimate ? priceLevel(r.cabins?.[c]?.miles, s.points.map((p) => p[2]), { fixed: fixedChartIds(data.charts).has(r.source) }) : null;
}
function levelTagHtml(r, c) {
  const lv = levelOf(r, c);
  if (!lv) return '';
  const why = `過去有位的 ${lv.n} 天，每天最低價的中位數約 ${fmt(lv.usual)} 哩${histSeq.body?.mock ? '（示範資料）' : ''}`;
  return `<div class="lvl lvl-${lv.level}" title="${esc(why)}"><b>${LEVEL_TEXT[lv.level]}</b>${lv.level === 'fixed' ? '' : `<small>平常約 ${fmt(lv.usual)} 哩</small>`}</div>`;
}
// On a program chip of 各計畫比較: its cheapest seat in this search against its usual price; 一般 left unsaid.
const LEVEL_SHORT = { cheap: '便宜', dear: '偏貴', fixed: '固定價' };
function levelChipHtml(source) {
  const c = state.cabin;
  const best = state.results.filter((r) => r.source === source && !r.estimate && r.cabins?.[c]?.available && r.cabins[c].miles).sort((a, b) => a.cabins[c].miles - b.cabins[c].miles)[0];
  const lv = best && levelOf(best, c);
  return lv && LEVEL_SHORT[lv.level] ? ` <small class="lvl-chip lvl-${lv.level}" title="${esc(`${LEVEL_TEXT[lv.level]}：平常約 ${fmt(lv.usual)} 哩`)}">${LEVEL_SHORT[lv.level]}</small>` : '';
}
// The route's history arrived: redraw what shows the levels (the chips, cards and the rest that follow the programs).
function levelRefresh() {
  if (state.results.length && $('#matrix-host') && typeof refreshPrograms === 'function') refreshPrograms('#none');
}

// 差一點 (全家湊位提示): folded under the best-deal cards, or in place of the empty result, when 「至少 N 位」 hid
// flights that have fewer seats.
let gapOpen = false;
// `open`: start unfolded (nothing else is left to show).
function gapHtml(open = false) {
  const pax = state.pax;
  const { list, total } = seatGaps(state.results, state.cabin, pax);
  if (!list.length) return '';
  const lines = list.map((g) => `<li><button type="button" class="linklike" data-gap="${esc(g.programs[0].id)}" data-gap-title="${esc(`${dayLabel(g.date)} ${g.origin} → ${g.destination} · ${srcName(g.programs[0].source)}`)}">${dayLabel(g.date)}</button><small>差 ${g.short} 位</small>
    <span>${esc(g.origin)} → ${esc(g.destination)}　${g.airlines ? `${carriersHtml(g.airlines)}：` : ''}${g.programs.map((p) => `${esc(srcName(p.source))} ${p.seats} 位`).join('、')}</span></li>`).join('');
  return `<details class="gap-fold" id="gap-fold"${gapOpen || open ? ' open' : ''}><summary>👪 差一點：${total} 班只差幾位 <small>「至少 ${pax} 位」藏起來的</small></summary>
    <ul class="gap-list">${lines}</ul>
    ${total > list.length ? `<p class="hint">只列位子最多的 ${list.length} 班。</p>` : ''}
    <p class="hint">湊位小提醒：先訂到手的位數，另外幾位可以查航空公司自家的哩程計畫（自家會員常看得到夥伴計畫看不到的位子，點日期看航班明細裡的「請 AI 助理查官網」），或排候補。同一班在兩個夥伴計畫各看到 2 位，通常是同一批夥伴座位，不能加起來算 4 位（這是常見情況，不是官方規則）。</p>
  </details>`;
}
function initFlightPlus() {
  $('#search-results')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-gap]');
    if (b) openTrips(b.dataset.gap, b.dataset.gapTitle, state.cabin);
  });
  // <details> toggle events don't bubble; listening in the capture phase catches every fold.
  document.addEventListener('toggle', (e) => {
    if (e.target.id === 'gap-fold') gapOpen = e.target.open;
    else if (e.target.matches?.('details.also') && e.target.open) alsoFill(e.target);
  }, true);
}

// Node (the tests) gets the pure helpers; the browser starts the wiring.
if (typeof module === 'object' && module.exports) {
  module.exports = { ALSO_CHARTS, alsoProgramIds, alsoEstimate, alsoBanks, priceLevel, fixedChartIds, leadMain, LEAD_TEXT, seatGaps };
} else {
  initFlightPlus();
}
