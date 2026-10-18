// 來回配對 (round 6): award searches are one way. Under a result, one click searches the way back (B → A, the return
// dates every stay length could need) and pairs the two legs: a small grid of outbound date × stay length holding the
// lowest total miles, and the cheapest combinations, mixing programs freely (out on one program, back on another, each
// its own ticket). The click spends seats.aero calls, which its button says; everything after is worked out here.
// Classic script after flightplus.js, sharing app.js's and features.js's globals. Pure helpers first (the tests
// require() them); the browser wiring after.

// ---------- pure helpers ----------
const PAIR_STAYS = [3, 4, 5, 6, 7, 10, 14];
const PAIR_DEFAULT = [3, 5, 7, 10, 14];
const pairAddDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const pairDays = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);

// The cheapest seat per departure date: Map date → { miles, tax, row }. Rows of one cabin with enough seats for the
// party (an unknown count passes, as on the results page); estimates left out. `twd(taxes)`: the taxes in NT$, or null
// when unknown; it breaks ties between equal miles.
function pairBest(rows, cabin, pax = 1, twd = () => null) {
  const out = new Map();
  for (const r of rows || []) {
    const x = r.cabins?.[cabin];
    if (r.estimate || !x?.available || !(x.miles > 0) || (pax > 1 && x.seats > 0 && x.seats < pax)) continue;
    const tax = x.taxes ? twd(x.taxes) : null;
    const cur = out.get(r.date);
    if (!cur || x.miles < cur.miles || (x.miles === cur.miles && (tax ?? Infinity) < (cur.tax ?? Infinity))) out.set(r.date, { miles: x.miles, tax, row: r });
  }
  return out;
}

// Every outbound date × stay length with a seat back on the day `stay` days later: { date, stay, back, out, ret,
// miles, tax } (tax only when both legs have an NT$ amount). Cheapest first: miles, then taxes, then the earlier date.
function pairCombos(outBest, backBest, stays) {
  const list = [];
  for (const [date, out] of outBest) {
    for (const stay of stays) {
      const back = pairAddDays(date, stay);
      const ret = backBest.get(back);
      if (ret) list.push({ date, stay, back, out, ret, miles: out.miles + ret.miles, tax: out.tax != null && ret.tax != null ? out.tax + ret.tax : null });
    }
  }
  return list.sort((a, b) => a.miles - b.miles || (a.tax ?? Infinity) - (b.tax ?? Infinity) || a.date.localeCompare(b.date) || a.stay - b.stay);
}

// The return search for an outbound range: the first date plus the shortest stay to the last date plus the longest,
// cut to `maxDays` (the site searches at most a year at once).
function pairRange(start, end, stays = PAIR_STAYS, maxDays = 365) {
  const from = pairAddDays(start, Math.min(...stays));
  const to = pairAddDays(end, Math.max(...stays));
  return { start: from, end: pairDays(from, to) > maxDays ? pairAddDays(from, maxDays) : to };
}
// seats.aero calls that search may use: one page per 150 days, as server.js handleSearch.
const pairCalls = (start, end) => 1 + Math.floor(pairDays(start, end) / 150);
// NT$ of a taxes object at today's rates ({ rates: { USD: 31.9, …, TWD: 1 } }), or null.
const pairTwd = (fx) => (t) => {
  const rate = fx?.rates?.[String(t?.currency || '').toUpperCase()];
  return rate && Number.isFinite(t.amount) ? Math.round(t.amount * rate) : null;
};

// ---------- browser ----------
const pair = { n: 0, status: 'idle', rows: null, range: null, err: '', stays: new Set(PAIR_DEFAULT), showStays: false, pick: '', all: false, fx: null };
const PAIR_ROWS = 21; // grid rows shown before 「顯示全部」

function pairState() {
  const c = state.cabin;
  const twd = pairTwd(pair.fx);
  const outBest = pairBest(visibleRows(), c, state.pax || 1, twd);
  const backBest = pairBest(pair.rows, c, state.pax || 1, twd);
  const stays = PAIR_STAYS.filter((n) => pair.stays.has(n));
  return { outBest, backBest, stays, combos: pairCombos(outBest, backBest, stays) };
}
const pairTaxText = (x) => (x.tax != null ? `＋ 稅約 NT$${fmt(x.tax)}` : x.row.cabins[state.cabin]?.taxes ? `＋ 稅 ${esc(taxText(x.row.cabins[state.cabin].taxes))}` : '');
function pairLegHtml(word, x) {
  const r = x.row;
  return `<div class="pair-leg"><span class="pill">${word}</span><span>${dayLabel(r.date)} ${esc(r.origin)} → ${esc(r.destination)}・${esc(srcName(r.source))}</span>
    <span><b>${fmt(x.miles)} 哩</b> <small>${pairTaxText(x)}</small></span><button type="button" class="linklike" data-pair-trip="${esc(r.id)}" data-pair-title="${esc(titleOf(r))}">看航班</button></div>`;
}
// 「10.55萬」: the grid cells keep two decimals so 105,500 and 106,000 don't read the same.
const pairWan = (n) => (n >= 10000 ? `${+(n / 10000).toFixed(2)}萬` : fmt(n));
const pairTotalHtml = (k) => `<b>${fmt(k.miles)} 哩</b>${k.tax != null ? ` <small>＋ 稅約 NT$${fmt(k.tax)}</small>` : ''}`;

function pairRender() {
  const host = $('#pair-host');
  if (!host) return;
  const share = tabParams('search');
  if (!share.get('o') || !share.get('d') || !state.results.length || !state.start) { host.innerHTML = ''; return; }
  const back = `${share.get('d')} → ${share.get('o')}`;
  const range = pair.range || pairRange(state.start, state.end);
  const calls = pairCalls(range.start, range.end);
  const cost = `用 ${calls > 1 ? `最多 ${calls}` : 1} 次查詢`;
  if (pair.status !== 'done') {
    host.innerHTML = `<div class="pair-box">${pair.status === 'loading' ? `<p class="hint">正在查回程 ${esc(back)}…</p>`
      : `<button type="button" class="outline" id="pair-go">${pair.status === 'error' ? '再試一次' : '配對回程'}（${cost}）</button>
        <small class="hint">${pair.status === 'error' ? `<span class="error">${esc(pair.err)}</span>` : `查回程 ${esc(back)}（${mmdd(range.start)}–${mmdd(range.end)}），排出去回加起來最省的組合，可以混用不同計畫`}</small>`}</div>`;
    return;
  }
  const { outBest, backBest, stays, combos } = pairState();
  const cell = new Map(combos.map((k) => [`${k.date}|${k.stay}`, k]));
  const low = combos[0]?.miles;
  const dates = [...outBest.keys()].sort();
  const shown = pair.all ? dates : dates.slice(0, PAIR_ROWS);
  const stayChips = PAIR_STAYS.map((n) => `<label class="h-chip"><input type="checkbox" data-pair-stay="${n}" ${pair.stays.has(n) ? 'checked' : ''}><span>${n} 天</span></label>`).join('');
  const grid = `<div class="table-wrap pair-wrap"><table class="pair-grid"><thead><tr><th>去程＼玩幾天</th>${stays.map((n) => `<th>${n} 天</th>`).join('')}</tr></thead><tbody>
    ${shown.map((d) => `<tr><th>${dayLabel(d)}</th>${stays.map((n) => {
      const k = cell.get(`${d}|${n}`);
      if (!k) return '<td class="p-none">·</td>';
      // Not .best/.good: those names belong to the best-deal cards and the table cells.
      const cls = k.miles === low ? 'p-best' : k.miles <= low * 1.1 ? 'p-good' : '';
      return `<td class="${cls}${pair.pick === `${d}|${n}` ? ' p-sel' : ''}"><button type="button" data-pair-cell="${d}|${n}" title="${esc(`${dayLabel(d)} 去・${dayLabel(k.back)} 回：${fmt(k.miles)} 哩（${srcName(k.out.row.source)} ＋ ${srcName(k.ret.row.source)}）`)}">${pairWan(k.miles)}</button></td>`;
    }).join('')}</tr>`).join('')}
  </tbody></table></div>
  ${dates.length > shown.length ? `<button type="button" class="linklike" id="pair-all">顯示全部 ${dates.length} 個去程日</button>` : ''}`;
  const pick = pair.pick && cell.get(pair.pick);
  const top = combos.slice(0, 6);
  const empty = !backBest.size ? `回程 ${esc(back)} 在 ${mmdd(pair.range.start)}–${mmdd(pair.range.end)} 這個艙等沒有${state.pax > 1 ? `至少 ${state.pax} 位的` : ''}獎勵位。` : !stays.length ? '先勾選至少一個「玩幾天」。' : '勾選的天數配不到回程，多勾幾個「玩幾天」試試。';
  host.innerHTML = `<section class="pair">
    <h2 class="section-title">來回配對 <small>去程 ${esc(share.get('o'))} → ${esc(share.get('d'))}、回程 ${esc(back)}；每人去＋回哩數，${esc(CABIN_SHORT[state.cabin] || '')}艙</small></h2>
    <div class="pair-tools"><button type="button" class="chip" id="pair-stays-btn" aria-expanded="${pair.showStays}">玩幾天：${stays.join('、') || '未選'} 天 ${pair.showStays ? '▴' : '▾'}</button></div>
    ${pair.showStays ? `<div class="h-progs pair-stays">${stayChips}</div>` : ''}
    ${combos.length ? `${grid}
    ${pick ? `<div class="pair-pick">${pairLegHtml('去', pick.out)}${pairLegHtml('回', pick.ret)}<div class="pair-sum">玩 ${pick.stay} 天・共 ${pairTotalHtml(pick)}<button type="button" class="outline" data-pair-add="${pick.date}|${pick.stay}">＋ 加入我的行程</button></div></div>` : '<p class="hint">點格子看那一組的去回程。</p>'}
    <h3 class="sub">最省的組合</h3>
    <ol class="pair-top">${top.map((k) => `<li><div class="pair-line">${pairTotalHtml(k)}<span>${dayLabel(k.date)} 去・${dayLabel(k.back)} 回（玩 ${k.stay} 天）</span></div>
      <div class="pair-line"><small>${esc(srcName(k.out.row.source))} ${fmt(k.out.miles)} ＋ ${esc(srcName(k.ret.row.source))} ${fmt(k.ret.miles)}</small>
      <span class="pair-acts"><button type="button" class="linklike" data-pair-cell="${k.date}|${k.stay}">看去回程</button><button type="button" class="linklike" data-pair-add="${k.date}|${k.stay}">＋ 加入我的行程</button></span></div></li>`).join('')}</ol>` : `<p class="hint">${empty}</p>`}
    <p class="hint">玩 N 天＝去程日之後第 N 天搭回程。去回各開一張票，可以是不同計畫；位數依「至少 N 位」。稅金依今天匯率約略換成台幣${pair.mock ? '（示範資料）' : ''}${pair.truncated ? '；回程結果太多只列出一部分' : ''}。</p>
  </section>`;
}

function pairLeg(r) {
  const c = state.cabin;
  const x = r.cabins[c];
  return { k: 'a', date: r.date, from: r.origin, to: r.destination, flights: '', cabin: c, pax: state.pax || 1, miles: x.miles, program: r.source, tax: x.taxes ? { amount: x.taxes.amount, cur: String(x.taxes.currency || '').toUpperCase().slice(0, 3) } : null, note: '來回配對' };
}

async function pairLoad() {
  const share = tabParams('search');
  const back = new URLSearchParams(share);
  back.set('o', share.get('d'));
  back.set('d', share.get('o'));
  const range = pairRange(state.start, state.end);
  const params = searchQuery(back);
  params.set('start', range.start);
  params.set('end', range.end);
  const n = ++pair.n;
  Object.assign(pair, { status: 'loading', range, pick: '', all: false });
  pairRender();
  try {
    const [body, fx] = await Promise.all([api(`/api/search?${params}`), loadFx().catch(() => null)]);
    if (n !== pair.n) return;
    Object.assign(pair, { status: 'done', rows: body.results, fx, truncated: body.truncated, mock: body.mock });
  } catch (err) {
    if (n !== pair.n) return;
    Object.assign(pair, { status: 'error', err: err.message });
  }
  pairRender();
}

function initPairing() {
  // A new search starts over (its button is back; the return answer belonged to the old one).
  document.addEventListener('search:start', () => { pair.n++; Object.assign(pair, { status: 'idle', rows: null, range: null, err: '', pick: '', all: false }); });
  $('#search-results')?.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('#pair-go')) { pairLoad(); return; }
    if (t.closest('#pair-stays-btn')) { pair.showStays = !pair.showStays; pairRender(); $('#pair-stays-btn')?.focus(); return; }
    if (t.closest('#pair-all')) { pair.all = true; pairRender(); return; }
    const cell = t.closest('[data-pair-cell]');
    if (cell) {
      pair.pick = cell.dataset.pairCell;
      pairRender();
      $('#search-results .pair-pick')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }
    const trip = t.closest('[data-pair-trip]');
    if (trip) { openTrips(trip.dataset.pairTrip, trip.dataset.pairTitle, state.cabin); return; }
    const add = t.closest('[data-pair-add]');
    if (add) {
      const k = pairState().combos.find((x) => `${x.date}|${x.stay}` === add.dataset.pairAdd);
      if (k) addLegs([pairLeg(k.out.row), pairLeg(k.ret.row)]);
    }
  });
  $('#search-results')?.addEventListener('change', (e) => {
    const n = Number(e.target.dataset?.pairStay);
    if (!n) return;
    e.target.checked ? pair.stays.add(n) : pair.stays.delete(n);
    pairRender();
    $(`#search-results [data-pair-stay="${n}"]`)?.focus();
  });
}

if (typeof module === 'object' && module.exports) {
  module.exports = { PAIR_STAYS, PAIR_DEFAULT, pairBest, pairCombos, pairRange, pairCalls, pairTwd, pairAddDays };
} else {
  initPairing();
}
