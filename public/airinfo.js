// Round 9 airline extras, loaded on first use (trips.js airLoad) with data/accrual.json and data/airline-info.json
// (/api/data/airlineinfo, kept as data.airlineInfo):
// - 累積哩程試算: how many miles a cash ticket earns in each program, from each program's official chart for the
//   operating airline and booking class, on our great-circle distance (查現金票 › 已選取的航班, 我的行程's cash legs,
//   點數換算器). Codes left as 「還不知道」 give the range over the whole cabin.
// - The cash fare net of the value of those miles (the visitor's 每哩成本) and how close it brings the 🎯 goal.
// - 「行李與貴賓室」: each operating airline's official baggage and lounge pages, a few quoted official rules and the
//   alliance's lounge rule (航班明細, 我的行程, the profile sheet).
// - 航空公司小檔案: alliance, programs that book it, seats, nonstops from Taiwan, check-in, call centre, where to credit.
// Spends no quota. The pure part is exported for test/r9-airline.test.js.
/* global $, $$, esc, fmt, data, AP, cash, store, wallet, walletEmpty, walletPlan, perMileOf, costOverrides, programName, programKeyOf,
   srcName, airlineZh, airlineLogo, allianceLogo, airportCity, haversineMiles, api, CABIN_LABEL, seatTypeLabel, productList, showTab,
   setPointsView, renderPoints, toast */

// ---------- pure: earning ----------
// The distance band of one flight (a band limited to some countries wins over the plain one of the same reach).
function accZone(zones, dist, countries = []) {
  for (let i = 0; i < zones.length; i++) {
    const z = zones[i];
    if (z.max != null && dist > z.max) continue;
    const special = (y) => y.countries && countries.some((c) => y.countries.includes(c));
    if (z.countries && !special(z)) continue;
    if (!z.countries && zones.some((y, j) => j > i && y.max === z.max && special(y))) continue;
    return i;
  }
  return zones.length - 1;
}
// One flight under one program's rule and booking class → { lo, hi, pct } (lo < hi when the class has several fare
// types), or null when the official chart could not be read.
function accSegEarn(rule, cls, seg) {
  if (!rule || rule.pending) return null;
  if (rule.kind === 'zone') {
    const zi = accZone(rule.zones, seg.dist, seg.countries);
    const vals = rule.rows.filter((r) => r.classes.includes(cls)).map((r) => r.miles[zi]);
    return vals.length ? { lo: Math.min(...vals), hi: Math.max(...vals), zone: zi } : { lo: 0, hi: 0, zone: zi };
  }
  let pct = rule.rates?.[cls] || 0;
  const ex = (rule.except || []).find((e) => e.classes.includes(cls) && e.routes.some((r) => r === `${seg.from}-${seg.to}` || r === `${seg.to}-${seg.from}`));
  if (ex) pct = ex.pct;
  // minDist: a floor on the distance before the % (Flying Blue: 500 miles); min: a floor on the miles earned.
  let miles = Math.round((Math.max(seg.dist, rule.minDist || 0) * pct) / 100);
  if (pct > 0 && rule.min && !String(rule.minExcept || '').includes(cls)) miles = Math.max(miles, rule.min);
  return { lo: miles, hi: miles, pct };
}
// Every program the itinerary's airlines credit to, with the miles for the picked booking classes (picks: carrier →
// letter, '' = unknown: the range over that airline's codes in `cabin`). segs: [{ carrier, from, to, dist, countries }].
function accrualRows(A, segs, picks, cabin) {
  const progs = [];
  for (const s of segs) for (const r of A.carriers[s.carrier]?.earn || []) if (!progs.includes(r.program)) progs.push(r.program);
  const rows = progs.map((p) => {
    const row = { program: p, name: A.programs[p]?.name || p, unit: A.programs[p]?.unit || '哩', lo: 0, hi: 0, pcts: [], zone: false, pending: null, missing: [], noCode: [], rules: [] };
    for (const s of segs) {
      const C = A.carriers[s.carrier];
      const rule = C?.earn.find((r) => r.program === p);
      if (!rule) { if (!row.missing.includes(s.carrier)) row.missing.push(s.carrier); continue; }
      if (!row.rules.includes(rule)) row.rules.push(rule);
      if (rule.pending) { row.pending = rule; continue; }
      if (!(s.dist > 0)) continue;
      const pick = picks?.[s.carrier] || '';
      const letters = pick ? [pick] : String(C.cabins?.[cabin] || '').split('').filter(Boolean);
      if (!letters.length) { if (!row.noCode.includes(s.carrier)) row.noCode.push(s.carrier); continue; }
      const each = letters.map((l) => accSegEarn(rule, l, s));
      row.lo += Math.min(...each.map((e) => e.lo));
      row.hi += Math.max(...each.map((e) => e.hi));
      for (const e of each) if (e.pct != null && !row.pcts.includes(e.pct)) row.pcts.push(e.pct);
      if (rule.kind === 'zone') row.zone = true;
    }
    row.pcts.sort((a, b) => a - b);
    return row;
  });
  // Numbers first (most miles on top), then the ones waiting for the official chart.
  return rows.sort((a, b) => Boolean(a.pending) - Boolean(b.pending) || b.hi - a.hi || b.lo - a.lo);
}
// The miles' value at a cost per mile, and the fare net of it (per person).
function accNetFare(row, per, price) {
  const v = [Math.round(row.lo * per), Math.round(row.hi * per)];
  return { valueLo: v[0], valueHi: v[1], netLo: Math.max(0, price - v[1]), netHi: Math.max(0, price - v[0]) };
}
// 「TPE-HKG-LHR」 → ['TPE', 'HKG', 'LHR'], or null.
function accParseRoute(text) {
  const codes = String(text || '').toUpperCase().trim().split(/\s*[-–—>→/\s]\s*/).filter(Boolean);
  return codes.length >= 2 && codes.length <= 6 && codes.every((c) => /^[A-Z]{3}$/.test(c)) ? codes : null;
}
// 'BR 16 / BR 12' and the airports → one carrier per flight (all the first one when the counts differ).
function accLegSegments(flights, airports) {
  const codes = String(flights || '').split(/[,/·]/).map((f) => (/^\s*([A-Z0-9]{2})\s?\d/.exec(f) || [])[1]).filter(Boolean);
  const n = airports.length - 1;
  return Array.from({ length: n }, (_, i) => ({ carrier: codes.length === n ? codes[i] : codes[0] || '', from: airports[i], to: airports[i + 1] }));
}
// Nonstops from Taiwan's airports in data/rtw-routes.json `routes` ({ AIRPORT: 'DEST:CARRIERS …' }, two letters per
// carrier; each pair is kept once, under either airport), sorted by Taiwan airport, then destination.
const AL_TW_AIRPORTS = ['TPE', 'TSA', 'KHH', 'RMQ'];
function alNonstopsFrom(routes, code) {
  const out = [];
  const flies = (cs) => (String(cs || '').match(/.{2}/g) || []).includes(code);
  for (const [a, list] of Object.entries(routes || {})) {
    for (const part of String(list).split(' ')) {
      const [b, cs] = part.split(':');
      if (!b || !flies(cs)) continue;
      if (AL_TW_AIRPORTS.includes(a) && !AL_TW_AIRPORTS.includes(b)) out.push({ from: a, to: b });
      else if (AL_TW_AIRPORTS.includes(b) && !AL_TW_AIRPORTS.includes(a)) out.push({ from: b, to: a });
    }
  }
  const seen = new Set();
  return out.filter((x) => !seen.has(`${x.from}${x.to}`) && seen.add(`${x.from}${x.to}`))
    .sort((x, y) => AL_TW_AIRPORTS.indexOf(x.from) - AL_TW_AIRPORTS.indexOf(y.from) || x.to.localeCompare(y.to));
}
if (typeof module === 'object' && module.exports) module.exports = { accZone, accSegEarn, accrualRows, accNetFare, accParseRoute, accLegSegments, alNonstopsFrom };

// ---------- the calculator ----------
const accData = () => data.airlineInfo?.accrual;
const accCarrierOf = (f) => (/^([A-Z0-9]{2})\s?\d/.exec(String(f || '').toUpperCase().trim()) || [])[1] || '';
const accMi = (lo, hi) => (lo === hi ? fmt(lo) : `${fmt(lo)}–${fmt(hi)}`);
const alExtLink = (s, text) => (s?.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(text || s.label)} ↗</a>` : '');
// Distances and countries from the airport list (trips.js airLoad loads it first).
function accSegsOf(list) {
  return list.filter((s) => s.carrier && s.from && s.to).map((s) => {
    const a = AP.byCode.get(s.from);
    const b = AP.byCode.get(s.to);
    return { ...s, dist: a && b ? haversineMiles(a, b) : null, countries: [a?.country, b?.country].filter(Boolean) };
  });
}
const accPerOf = (p) => (typeof perMileOf === 'function' ? perMileOf(data.milecost, typeof costOverrides === 'function' ? costOverrides() : {}, p) : data.milecost?.defaults?.[p] ?? data.milecost?.fallback ?? 0.5);
// 我的點數 › 🎯: the goal and what the visitor can already reach for it (own miles plus transfers).
function accGoalOf() {
  const g = store.get('walletGoal:v1', null);
  if (!g || !(g.miles > 0) || !g.key) return null;
  const have = typeof walletPlan === 'function' && !(typeof walletEmpty === 'function' && walletEmpty()) ? walletPlan(g.key, g.miles).total : wallet?.miles?.[g.key] || 0;
  return { key: g.key, miles: g.miles, have };
}

function accPctText(row) {
  if (row.zone) return '依距離區間';
  if (!row.pcts.length) return '';
  return row.pcts.length === 1 ? `${row.pcts[0]}%` : `${row.pcts[0]}%–${row.pcts.at(-1)}%`;
}
function accRowHtml(row, st, id) {
  const rule = row.rules[0];
  const notes = row.rules.flatMap((r) => [r.note, ...(r.notes || [])]).filter(Boolean);
  const src = row.rules.map((r) => alExtLink(r.source, '官方')).join(' ');
  if (row.pending) {
    return `<li class="acc-row pend"><span class="acc-name">${esc(row.name)}</span><span class="acc-pct"></span><span class="acc-m"><span class="tag verify">官方資料待補</span></span><span class="acc-src">${src}</span>${row.pending.note ? `<small class="acc-note">${esc(row.pending.note)}</small>` : ''}</li>`;
  }
  const zero = row.hi === 0 && !row.noCode.length;
  const pick = st.net && row.hi > 0 ? `<input type="radio" name="acc-sel-${id}" value="${esc(row.program)}" ${st.sel === row.program ? 'checked' : ''} aria-label="用${esc(row.name)}算實際價格">` : '';
  const partial = [row.missing.length ? `只算 ${row.missing.length ? st.segs.filter((s) => !row.missing.includes(s.carrier)).map((s) => s.carrier).filter((c, i, a) => a.indexOf(c) === i).join('、') : ''} 的航段；${row.missing.join('、')} 的比例沒有整理` : '', row.noCode.length ? `${row.noCode.join('、')} 的航段要選艙等代碼` : ''].filter(Boolean).join('；');
  return `<li class="acc-row${zero ? ' zero' : ''}"><label class="acc-name">${pick}${esc(row.name)}</label><span class="acc-pct">${esc(accPctText(row))}</span><span class="acc-m">${zero ? '不累積' : `<b>${accMi(row.lo, row.hi)}</b> ${esc(row.unit)}`}</span><span class="acc-src" title="${esc(notes.join('\n'))}">${src}</span>${partial ? `<small class="acc-note">${esc(partial)}</small>` : ''}${rule && !rule.pending && notes.length ? `<small class="acc-note">${esc(notes[0])}</small>` : ''}</li>`;
}
function accPickHtml(st) {
  const A = accData();
  const carriers = [...new Set(st.segs.map((s) => s.carrier))];
  return carriers.map((c) => {
    const cab = A.carriers[c]?.cabins;
    const name = `${airlineZh(c)}（${c}）`;
    if (!cab) return `<p class="hint acc-nocab">${esc(name)}：官方累積表讀不到，下面只有官方頁連結。</p>`;
    const order = ['F', 'J', 'W', 'Y'].filter((k) => cab[k]);
    const sel = st.picks[c] || '';
    return `<label class="field compact acc-pick">${esc(name)} 訂位艙等代碼<select data-acc-pick="${esc(c)}">
      <option value="">還不知道（看整個${esc(CABIN_LABEL[st.cabin] || '艙等')}的範圍）</option>
      ${order.map((k) => `<optgroup label="${esc(CABIN_LABEL[k])}">${cab[k].split('').map((l) => `<option value="${l}" ${sel === l ? 'selected' : ''}>${l}</option>`).join('')}</optgroup>`).join('')}</select></label>`;
  }).join('');
}
// The cash fare net of the miles' value, and the 🎯 goal (查現金票 only: it knows the price).
function accNetHtml(rows, st) {
  if (!st.net || !(st.price > 0)) return '';
  const earning = rows.filter((r) => !r.pending && r.hi > 0);
  if (!earning.length) return '';
  st.sel = accPickSel(st, earning);
  const row = earning.find((r) => r.program === st.sel);
  const per = accPerOf(row.program);
  const each = st.price / Math.max(1, st.pax);
  const n = accNetFare(row, per, each);
  const g = accGoalOf();
  let goal = '';
  if (g && programKeyOf(g.key) === row.program) {
    const gapLo = g.miles - g.have - row.hi;
    const gapHi = g.miles - g.have - row.lo;
    goal = `<p class="acc-goal">🎯 ${gapHi <= 0 ? `飛完就湊到你的目標（${esc(programName(g.key))} ${fmt(g.miles)} 哩）` : `飛完離你的目標（我的點數 › 🎯 ${esc(programName(g.key))} ${fmt(g.miles)} 哩）還差 <b>${accMi(Math.max(0, gapLo), gapHi)}</b> 哩`}</p>`;
  } else if (g && earning.some((r) => r.program === programKeyOf(g.key))) {
    goal = `<p class="hint">你的 🎯 目標是 ${esc(programName(g.key))}：選它的那一列，看飛完還差多少。</p>`;
  }
  return `<div class="acc-net"><p>累積到 <b>${esc(row.name)}</b> 約 ${accMi(row.lo, row.hi)} ${esc(row.unit)}，約值 NT$${accMi(n.valueLo, n.valueHi)}（每${row.unit === '哩' ? '哩' : esc(row.unit)}成本 NT$${per}）→ 實際約 <b>NT$${accMi(n.netLo, n.netHi)}</b>${st.pax > 1 ? '（每人）' : ''}</p>
    ${goal}<p class="hint">每哩成本用你在結果頁「每哩成本」填的數字（沒填用網站預設）；點上面別的計畫可以換一個算。</p></div>`;
}
// The program the net fare is worked out with: the visitor's pick, else the 🎯 goal's program, else the most miles.
function accPickSel(st, earning) {
  if (earning.some((r) => r.program === st.sel)) return st.sel;
  const g = accGoalOf();
  return (earning.find((r) => g && r.program === programKeyOf(g.key)) || earning[0]).program;
}
function accCalcHtml(st, id) {
  const A = accData();
  const rows = accrualRows(A, st.segs, st.picks, st.cabin);
  // The row priced below is ticked in the list, so settle it first.
  const earning = rows.filter((r) => !r.pending && r.hi > 0);
  if (st.net && earning.length) st.sel = accPickSel(st, earning);
  const legs = st.segs.map((s) => `${esc(s.from)} → ${esc(s.to)} ${s.dist ? `${fmt(s.dist)} 哩` : '距離不明'}`).join('・');
  const wtc = String(A.wheretocredit || '');
  const known = [...new Set(st.segs.map((s) => s.carrier))].filter((c) => !A.carriers[c]);
  const links = known.map((c) => (data.trips?.accrual?.[c] ? alExtLink(data.trips.accrual[c]) : '')).filter(Boolean).join('　');
  return `<div class="acc-picks">${accPickHtml(st)}</div>
    <p class="hint acc-legs">${legs}（大圓距離）</p>
    ${rows.length ? `<ul class="acc-rows">${rows.map((r) => accRowHtml(r, st, id)).join('')}</ul>` : `<p class="hint">${known.map((c) => esc(airlineZh(c))).join('、')}的累積比例還沒整理。</p>`}
    ${accNetHtml(rows, st)}
    ${links ? `<p class="hint">${links}</p>` : ''}
    <p class="hint">依各計畫官網的累積表和我們算的大圓距離估算；航空公司多半用 IATA 的 TPM 距離，可能差幾哩。表上沒有的代碼不累積，促銷票、獎勵票另有規定；會員等級加成沒算進去。${wtc ? `也可以比較 <a href="${esc(wtc)}${esc(st.segs[0]?.carrier || '')}" target="_blank" rel="noopener">wheretocredit.com ↗</a><sup class="mk-3p" aria-hidden="true">*</sup>（第三方整理，以官網為準）。` : ''}</p>`;
}
// The headline on 已選取的航班's fold: the most miles, and the fare net of their value.
function accSummary(st) {
  const rows = accrualRows(accData(), st.segs, st.picks, st.cabin).filter((r) => !r.pending && r.hi > 0);
  if (!rows.length) return '';
  const top = rows[0];
  const sel = rows.find((r) => r.program === accPickSel(st, rows));
  const n = st.net && st.price > 0 ? accNetFare(sel, accPerOf(sel.program), st.price / Math.max(1, st.pax)) : null;
  const net = n ? `・${sel === top ? '' : `累積到${sel.name}，`}扣掉哩程價值實際約 NT$${accMi(n.netLo, n.netHi)}${st.pax > 1 ? '／人' : ''}` : '';
  return `最多約 ${accMi(top.lo, top.hi)} ${top.unit}（${top.name}）${net}`;
}
let accSeqNo = 0;
// Draws a calculator into `box` and redraws it on each pick. fold: the cash tab's closed 🎯 fold around it.
function accMount(box, st, fold) {
  const id = (box.dataset.accId ||= String(++accSeqNo));
  box._acc = st;
  const draw = () => {
    const open = $('details', box)?.open || false;
    box.innerHTML = fold
      ? `<details class="tp-accrual acc-fold"${open ? ' open' : ''}><summary>🎯 這張票的哩程可以累積到哪裡<small>${esc(accSummary(st))}</small></summary><div class="acc-calc">${accCalcHtml(st, id)}</div></details>`
      : `<div class="acc-calc">${accCalcHtml(st, id)}</div>`;
  };
  if (!box.dataset.accBound) {
    box.dataset.accBound = '1';
    box.addEventListener('change', (e) => {
      const s = box._acc;
      const t = e.target;
      if (t.dataset.accPick != null) s.picks[t.dataset.accPick] = t.value;
      else if (t.name === `acc-sel-${id}`) s.sel = t.value;
      else return;
      const focus = t.dataset.accPick;
      box._draw();
      if (focus) $(`[data-acc-pick="${focus}"]`, box)?.focus();
    });
  }
  box._draw = draw;
  draw();
}
// 查現金票 › 已選取的航班 (trips.js accrualMount).
function accrualCalcMount(box, fares) {
  const r = cash.req;
  const list = fares.filter(Boolean).flatMap((o) => o.segments.map((s) => ({ carrier: accCarrierOf(s.flightNumber), from: s.from.code, to: s.to.code })));
  const segs = accSegsOf(list);
  if (!segs.length) { box.innerHTML = ''; return; }
  const key = segs.map((s) => `${s.carrier}${s.from}${s.to}`).join('|');
  const old = box._acc && box._acc.key === key ? box._acc : null;
  accMount(box, { key, segs, cabin: r.cabin, picks: old?.picks || {}, sel: old?.sel || '', price: (fares[1] || fares[0]).price, pax: r.adults || 1, net: true }, true);
}
// 我的行程: a leg's fold (trips.js tpAirFill): the miles of a cash leg, and the baggage and lounge links.
function alLegFill(body, l) {
  const airports = [l.from, ...String(l.via || '').split(',').filter(Boolean), l.to];
  const segs = accSegsOf(accLegSegments(l.flights, airports));
  const carriers = [...new Set(segs.map((s) => s.carrier))];
  body.innerHTML = `${l.k === 'c' && segs.length ? `<h4 class="acc-h">累積哩程</h4><div class="tp-air-acc"></div>${l.via ? '' : (l.flights || '').split(/[,/·]/).length > 1 ? '<p class="hint">轉機點沒有記下來，只算起訖點的距離（轉機的實際距離較長）。重新從查現金票加入可以算得更準。</p>' : ''}` : ''}
    <h4 class="acc-h">行李與貴賓室</h4><div class="tp-air-bag">${alBagHtml(carriers.map((c) => ({ c, cabin: l.cabin })))}</div>`;
  const acc = $('.tp-air-acc', body);
  if (acc) accMount(acc, { segs, cabin: l.cabin, picks: {}, sel: '', net: false }, false);
}
// 點數換算器 › 累積哩程試算 (airline.js opens the fold).
function accToolFill(body) {
  const A = accData();
  const carriers = Object.keys(A.carriers);
  body.innerHTML = `<p class="hint">選航空公司，填航線（機場代碼用 - 連起來，轉機就多寫一站，例如 TPE-HKG-LHR），看這張現金票的哩程累積到各計畫有多少。</p>
    <form class="acc-form" autocomplete="off">
      <label class="field">航空公司<select name="c">${carriers.map((c) => `<option value="${c}">${esc(airlineZh(c))}（${c}）</option>`).join('')}</select></label>
      <label class="field">航線<input name="route" placeholder="例如 TPE-NRT" autocapitalize="characters" spellcheck="false"></label>
      <label class="field">艙等<select name="cabin">${['Y', 'W', 'J', 'F'].map((k) => `<option value="${k}" ${k === 'J' ? 'selected' : ''}>${esc(CABIN_LABEL[k])}</option>`).join('')}</select></label>
    </form><div class="acc-out"></div>`;
  const f = $('.acc-form', body);
  const out = $('.acc-out', body);
  const run = () => {
    const codes = accParseRoute(f.route.value);
    if (!codes) { out.innerHTML = f.route.value.trim() ? '<p class="hint">航線請用機場代碼，例如 TPE-NRT 或 TPE-HKG-LHR。</p>' : ''; return; }
    const unknown = codes.filter((c) => !AP.byCode.get(c));
    if (unknown.length) { out.innerHTML = `<p class="hint">找不到機場代碼：${esc(unknown.join('、'))}</p>`; return; }
    const segs = accSegsOf(codes.slice(1).map((to, i) => ({ carrier: f.c.value, from: codes[i], to })));
    const old = out._acc;
    accMount(out, { segs, cabin: f.cabin.value, picks: old && old.segs[0]?.carrier === f.c.value ? old.picks : {}, sel: '', net: false }, false);
  };
  f.addEventListener('input', run);
  f.addEventListener('change', run);
  f.addEventListener('submit', (e) => { e.preventDefault(); run(); });
}

// ---------- 行李與貴賓室 ----------
const alAllianceOf = (c) => (data.alliances?.alliances || []).find((a) => a.members.includes(c)) || null;
// pairs: [{ c: operating airline, cabin }]. sheet: drawn inside the profile sheet (no 小檔案 buttons).
function alBagHtml(pairs, sheet = false) {
  const I = data.airlineInfo?.info;
  if (!I || !pairs.length) return '';
  const carriers = [...new Set(pairs.map((p) => p.c))];
  const rows = carriers.map((c) => {
    const a = I.airlines[c] || {};
    const cabins = [...new Set(pairs.filter((p) => p.c === c).map((p) => CABIN_LABEL[p.cabin]).filter(Boolean))].join('、');
    const links = [a.baggage && alExtLink(a.baggage), a.lounge && alExtLink(a.lounge)].filter(Boolean).join('　');
    const rules = (a.rules || []).map((r) => `<li>${esc(r.text)}<small>官網原文：「${esc(r.quote)}」${r.url ? ` ${alExtLink({ url: r.url }, '來源')}` : ''}</small></li>`).join('');
    return `<li class="alb-row"><div class="alb-head">${airlineLogo(c, 'sm')}<b>${esc(airlineZh(c))}</b>${cabins && !sheet ? `<span class="hint">實際營運・${esc(cabins)}</span>` : ''}${sheet ? '' : `<button type="button" class="linklike" data-al="${esc(c)}">小檔案</button>`}</div>
      <div class="alb-links">${links || '<span class="hint">這家的官方行李、貴賓室頁還沒整理，先看下面的聯盟規定或航空公司官網。</span>'}</div>${rules ? `<ul class="alb-rules">${rules}</ul>` : ''}</li>`;
  }).join('');
  const als = [...new Set(carriers.map((c) => alAllianceOf(c)?.id).filter(Boolean))];
  const alHtml = als.map((id) => {
    const x = I.alliances[id];
    if (!x) return '';
    const name = (data.alliances.alliances.find((a) => a.id === id) || {}).name || id;
    return `<div class="alb-al">${allianceLogo(id, 'xs')}<b>${esc(name)} 的貴賓室</b><ul>${x.rules.map((r) => `<li>${esc(r.text)}<small>官網原文：「${esc(r.quote)}」</small></li>`).join('')}</ul><p class="src">${alExtLink(x.lounge)}</p></div>`;
  }).join('');
  const gen = carriers.length > 1 || !sheet ? (I.general || []).map((g) => `<p class="hint alb-gen">🧳 ${esc(g.text)}（${alExtLink(g)}）</p>`).join('') : '';
  return `<ul class="alb">${rows}</ul>${alHtml}${gen}`;
}
function alBagFill(el, pairs) { el.innerHTML = alBagHtml(pairs) || '<p class="hint">沒有可以顯示的航空公司資料。</p>'; }

// ---------- 航空公司小檔案 ----------
const alHomeKey = (id) => data.programs?.idMap?.[id]?.booking || id;
let alRoutesP = null;
const alLoadRoutes = () => (alRoutesP ||= api('/api/data/rtwroutes').catch((err) => { alRoutesP = null; throw err; }));
function alSheetSeats(c) {
  const S = data.seats?.airlines?.[c];
  const prods = productList().filter((p) => p.airline === c);
  const off = (S?.J || []).map((s) => `<li><b>${esc(s.ac.join('、'))}</b>　<span class="pill seat-tag ${esc(s.type)}">${esc(seatTypeLabel(s))}</span>${s.note ? ` <small>${esc(s.note)}</small>` : ''} ${alExtLink(S.sources?.[s.src], '官方')}</li>`).join('');
  const p3 = prods.map((p) => `<li>${esc(p.name)}<sup class="mk-3p" aria-hidden="true">*</sup>${p.caveat ? ` <small>${esc(p.caveat)}</small>` : ''}</li>`).join('');
  if (!off && !p3 && !S?.pending) return '<p class="hint">座椅資料還沒整理。</p>';
  return `${off ? `<ul class="als-list">${off}</ul>` : ''}${S?.pending ? `<p class="hint">官方資料待補：${esc(S.pending)}</p>` : ''}${p3 ? `<p class="hint">艙位產品（第三方整理，機型與座椅可能更換）：</p><ul class="als-list">${p3}</ul>` : ''}`;
}
function alSheetAccrual(c) {
  const A = accData();
  const C = A.carriers[c];
  const tl = data.trips?.accrual?.[c];
  if (!C) return `<p class="hint">累積比例還沒整理。${tl ? alExtLink(tl) : ''}${A.wheretocredit ? `　<a href="${esc(A.wheretocredit)}${esc(c)}" target="_blank" rel="noopener">wheretocredit.com ↗</a><sup class="mk-3p" aria-hidden="true">*</sup>（第三方）` : ''}</p>`;
  const span = (r, k) => {
    const v = String(C.cabins?.[k] || '').split('').filter(Boolean).map((l) => r.rates?.[l] || 0);
    return v.length ? (Math.min(...v) === Math.max(...v) ? `${v[0]}%` : `${Math.min(...v)}–${Math.max(...v)}%`) : '';
  };
  const items = C.earn.map((r) => {
    const name = A.programs[r.program]?.name || r.program;
    if (r.pending) return `<li><b>${esc(name)}</b>　<span class="tag verify">官方資料待補</span> ${alExtLink(r.source, '官方')}</li>`;
    const what = r.kind === 'zone' ? '依距離區間給固定哩數' : ['Y', 'J'].map((k) => (span(r, k) ? `${CABIN_LABEL[k].replace('艙', '')} ${span(r, k)}` : '')).filter(Boolean).join('、');
    return `<li><b>${esc(name)}</b>　${esc(what)} ${alExtLink(r.source, '官方')}</li>`;
  }).join('');
  return `<ul class="als-list">${items}</ul><p class="hint">要算一張票：<button type="button" class="linklike" data-acc-go="${esc(c)}">點數換算器 › 累積哩程試算</button>，或在查現金票選好航班後看「🎯 這張票的哩程可以累積到哪裡」。</p>`;
}
function alSheetHtml(c) {
  const al = alAllianceOf(c);
  const meta = (data.airlines?.airlines || []).find((a) => a.code === c);
  const ownProg = meta?.homeProgram || (data.programs?.programs || []).find((p) => p.airline === c)?.id || '';
  const home = ownProg ? alHomeKey(ownProg) : '';
  const via = [...new Set([home, ...(meta?.bookableVia || [])].filter(Boolean))];
  const progs = via.map((k) => `<span class="pill${k === home ? ' home' : ''}">${esc(k === home ? programName(k) : srcName(k))}${k === home ? '・自家' : ''}</span>`).join('');
  const ci = data.trips?.checkin?.[c];
  const cc = home ? data.callcenters?.programs?.[home] : null;
  const sec = (title, body) => `<section class="als"><h3>${title}</h3>${body}</section>`;
  return [
    sec('聯盟', al ? `<p>${allianceLogo(al.id, 'xs')} ${esc(al.name)}</p>` : '<p>沒有加入航空聯盟。</p>'),
    sec('可以用哪些計畫換', progs ? `<p class="als-progs">${progs}</p><p class="hint">seats.aero 有收錄、通常換得到這家座位的計畫${al ? `；同聯盟其他計畫多半也能換，以各計畫為準` : ''}。</p>` : `<p class="hint">還沒整理${al ? `；${esc(al.name)} 的計畫多半能換，以各計畫為準` : ''}。</p>`),
    sec('商務艙座椅', alSheetSeats(c)),
    sec('從台灣直飛', '<div class="als-ns"><p class="hint">載入中…</p></div>'),
    ci ? sec('線上報到', `<p>起飛前 ${ci.hours} 小時開放${ci.usHours ? `（美國航線 ${ci.usHours} 小時）` : ''}　${alExtLink({ url: ci.url }, '官方')}</p>`) : '',
    cc?.phones?.length ? sec('客服電話', `<ul class="als-list">${cc.phones.map((p) => `<li><a href="tel:${esc(p.number.replace(/[^\d+]/g, ''))}">${esc(p.number)}</a> <small>${esc(p.label)}</small></li>`).join('')}</ul><p class="hint">${esc(cc.en)}・${alExtLink({ url: cc.source }, '官方來源')}（${esc(cc.asOf)}）</p>`)
      : cc?.contactUrl ? sec('客服', `<p>${alExtLink({ url: cc.contactUrl }, `${cc.en}：聯絡我們（官方）`)}</p>`) : '',
    sec('現金票累積到哪裡', alSheetAccrual(c)),
    sec('行李與貴賓室', alBagHtml([{ c, cabin: 'J' }], true)),
  ].join('');
}
async function alSheetNonstops(c, host) {
  if (!host) return;
  try {
    // Another dataset (the official timetable) may take over: nonstopsFromTaiwan(code) → [{ from, to }].
    const own = typeof nonstopsFromTaiwan === 'function' ? await nonstopsFromTaiwan(c) : null;
    const list = own || alNonstopsFrom((await alLoadRoutes()).routes, c);
    if (!host.isConnected) return;
    if (!list.length) {
      host.innerHTML = `<p class="hint">${alAllianceOf(c)?.id === 'skyteam' || !alAllianceOf(c) ? '直飛航線資料目前只整理了寰宇一家和星空聯盟的航空公司。' : '沒有找到從台灣直飛的航線。'}</p>`;
      return;
    }
    const by = {};
    for (const x of list) (by[x.from] ||= []).push(x.to);
    host.innerHTML = `${Object.entries(by).map(([o, ds]) => `<p><b>${esc(airportCity(o) || o)}</b>：${ds.map((d) => `${esc(airportCity(d) || d)}<small> ${esc(d)}</small>`).join('、')}</p>`).join('')}
      <p class="hint">${own ? '' : '依 ADS-B 收集的航班呼號航線整理（不是航空公司時刻表），可能漏掉新航線或留著停飛的航線；目前只整理寰宇一家和星空聯盟。'}</p>`;
  } catch {
    if (host.isConnected) host.innerHTML = '<p class="hint">直飛資料載入失敗。</p>';
  }
}
function alSheetOpen(code) {
  const c = String(code || '').toUpperCase();
  if (!/^[A-Z0-9]{2}$/.test(c)) return;
  let dlg = $('#al-dialog');
  if (!dlg) {
    document.body.insertAdjacentHTML('beforeend', '<dialog id="al-dialog" class="al-dlg" aria-labelledby="al-title"><div class="dialog-head"><h2 id="al-title"></h2><button type="button" class="ghost" id="al-close" aria-label="關閉">✕</button></div><div id="al-body"></div></dialog>');
    dlg = $('#al-dialog');
    $('#al-close').addEventListener('click', () => dlg.close());
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) { dlg.close(); return; }
      const go = e.target.closest('[data-acc-go]');
      if (!go) return;
      // To 點數換算器 with the calculator open on this airline.
      dlg.close();
      $('#trip-dialog')?.open && $('#trip-dialog').close();
      setPointsView('calc');
      showTab('points');
      renderPoints();
      const d = $('#acc-tool');
      if (!d) return;
      d.open = true;
      d.scrollIntoView({ behavior: 'smooth', block: 'start' });
      const pick = () => { const s = $('.acc-form select[name=c]', d); if (s) { s.value = go.dataset.accGo; $('.acc-form input[name=route]', d)?.focus(); } };
      setTimeout(pick, 50);
    });
  }
  $('#al-title').innerHTML = `${airlineLogo(c, 'md')}<span>${esc(airlineZh(c))}<small> ${esc(c)}・航空公司小檔案</small></span>`;
  $('#al-body').innerHTML = alSheetHtml(c);
  if (!dlg.open) dlg.showModal();
  $('#al-body').scrollTop = 0;
  alSheetNonstops(c, $('.als-ns', dlg));
}
