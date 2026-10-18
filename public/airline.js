// Round 9: airlines. Seat types by airline and aircraft code from the airlines' own cabin pages (data/seats.json):
// a 「平躺」／「斜躺」 tag beside the aircraft in 航班明細 and on the route results' cards, and the 「只看平躺商務」
// filter; plus the entry points of public/airinfo.js (loaded on first use by trips.js airLoad): the airline profile
// sheet (航空公司小檔案, any [data-al] button), 航班明細's 「行李與貴賓室」 fold and 點數換算器's 累積哩程試算 fold.
// Classic script in TOOL_SCRIPTS, after ewallet.js. Spends no quota. The pure part is exported for test/r9-airline.test.js.
/* global $, esc, data, state, renderSearch, renderPoints, airLoad, alSheetOpen, alBagFill, accToolFill, productList, toast */

const SEAT_TYPE_ZH = { flat: '平躺', recliner: '斜躺', mixed: '平躺或斜躺' };
// The official entry for an operating carrier's business cabin on one aircraft code, or null.
function seatTypeOf(seats, carrier, ac) {
  const c = String(carrier || '').toUpperCase();
  const a = String(ac || '').toUpperCase();
  return (seats?.airlines?.[c]?.J || []).find((s) => s.ac.includes(a)) || null;
}
// 「平躺・直通走道」, 「平躺・反魚骨」, 「斜躺」…
function seatTypeLabel(s) {
  if (!s) return '';
  const base = SEAT_TYPE_ZH[s.type] || '';
  return s.type === 'flat' && s.aisle ? `${base}・直通走道` : s.type === 'flat' && s.layout ? `${base}・${s.layout}` : base;
}
// One 'BR:77W' of a result's fleet → its kind. A premium product of products.json (flagship lie-flat seats, a
// third-party summary) counts as flat when the airline's own pages say nothing; `third` marks it.
function fleetEntryKind(seats, products, entry) {
  const [carrier, ac] = String(entry).split(':');
  const s = seatTypeOf(seats, carrier, ac);
  if (s) return { kind: s.type, third: false };
  if ((products || []).some((p) => p.cabin === 'J' && p.airline === carrier && p.iata.includes(ac))) return { kind: 'flat', third: true };
  return { kind: 'unknown', third: false };
}
// A result row's fleet (every carrier:aircraft its business trips use) → flat (all of them), recliner (all), mixed
// (both, all known), some (some recliner, some unknown) or unknown.
function fleetSeat(seats, products, fleet) {
  const list = (fleet || []).map((e) => fleetEntryKind(seats, products, e));
  if (!list.length) return { kind: 'unknown', third: false };
  const has = (k) => list.some((x) => x.kind === k);
  const third = list.some((x) => x.third);
  if (list.every((x) => x.kind === 'flat')) return { kind: 'flat', third };
  if (list.every((x) => x.kind === 'recliner')) return { kind: 'recliner', third };
  if (!has('unknown')) return { kind: 'mixed', third };
  return { kind: has('recliner') || has('mixed') ? 'some' : 'unknown', third };
}
if (typeof module === 'object' && module.exports) module.exports = { seatTypeOf, seatTypeLabel, fleetEntryKind, fleetSeat, SEAT_TYPE_ZH };

const SEAT_TYPE_NOTE = '依航空公司官網的座椅說明；機型代碼分不出新舊座椅，以訂位時的座位圖為準';
// 航班明細: a tag beside the aircraft, linking to the official page it comes from (business trips only).
function seatTagHtml(seg, tripCabin) {
  if (tripCabin !== 'business' || !data.seats) return '';
  const c = String(seg.flight || '').slice(0, 2).toUpperCase();
  const s = seatTypeOf(data.seats, c, seg.aircraftCode);
  if (!s) return '';
  const src = data.seats.airlines[c].sources?.[s.src];
  const title = `${s.note ? `${s.note}。` : ''}官網原文：${s.quote}（${SEAT_TYPE_NOTE}）`;
  return ` <a class="pill seat-tag ${esc(s.type)}" href="${esc(src?.url || '')}" target="_blank" rel="noopener" title="${esc(title)}">${esc(seatTypeLabel(s))}</a>`;
}
// The route results' cards (business): 「平躺」 when every aircraft is lie-flat, 「斜躺」 or 「含斜躺」 otherwise.
function fleetTagHtml(fleet, cabin) {
  if (cabin !== 'J' || !fleet?.length || !data.seats) return '';
  const f = fleetSeat(data.seats, productList(), fleet);
  const label = { flat: '平躺', recliner: '斜躺', mixed: '含斜躺', some: '含斜躺' }[f.kind];
  if (!label) return '';
  return ` · <span class="seat-tag ${f.kind === 'flat' ? 'flat' : 'recliner'}" title="${esc(`${SEAT_TYPE_NOTE}${f.third ? '；* 部分機型依第三方整理的艙位產品' : ''}`)}">${label}${f.third ? '<sup class="mk-3p" aria-hidden="true">*</sup>' : ''}</span>`;
}

// 只看平躺商務: rows whose business trips are all on lie-flat seats; needs the aircraft (date ranges up to 45 days).
const flatFiltering = () => Boolean(state.flatOnly && state.cabin === 'J' && state.withTaxes);
function flatOk(r, c) {
  if (!state.flatOnly || c !== 'J' || !state.withTaxes) return true;
  return !r.estimate && fleetSeat(data.seats, productList(), r.cabins[c].fleet).kind === 'flat';
}
function flatToolsHtml() {
  if (state.cabin !== 'J' || !data.seats) return '';
  let note = '';
  if (state.flatOnly && !state.withTaxes) note = '<span class="hint">日期範圍 45 天內才有機型資料，請縮短範圍再用這個篩選。</span>';
  else if (state.flatOnly) {
    const n = { recliner: 0, mixed: 0, some: 0, unknown: 0 };
    for (const r of state.results) {
      const x = r.cabins?.J;
      if (!x?.available || state.hidden.has(r.source)) continue;
      const k = r.estimate ? 'unknown' : fleetSeat(data.seats, productList(), x.fleet).kind;
      if (k in n) n[k]++;
    }
    const parts = [n.recliner ? `斜躺 ${n.recliner} 筆` : '', n.mixed + n.some ? `平躺斜躺都有 ${n.mixed + n.some} 筆` : '', n.unknown ? `座椅資料不明 ${n.unknown} 筆` : ''].filter(Boolean);
    note = `<span class="hint">${parts.length ? `已隱藏${parts.join('、')}。` : ''}依航空公司官網的座椅資料（部分依第三方整理的艙位產品，標 *）。</span>`;
  }
  return `<label class="switch" title="${esc(SEAT_TYPE_NOTE)}"><input type="checkbox" id="flat-only" ${state.flatOnly ? 'checked' : ''}><span class="knob"></span>只看平躺商務</label>${note}`;
}

// 航班明細: 「行李與貴賓室」 for the operating airlines and cabins of the flights shown, filled when opened.
const AL_TRIP_CABIN = { economy: 'Y', premium: 'W', business: 'J', first: 'F' };
function alTripMount(body, trips) {
  if (!body || !trips?.length) return;
  const pairs = [];
  for (const t of trips) {
    for (const s of t.segments || []) {
      const c = String(s.flight || '').slice(0, 2).toUpperCase();
      const cabin = AL_TRIP_CABIN[t.cabin] || 'J';
      if (/^[A-Z0-9]{2}$/.test(c) && !pairs.some((p) => p.c === c && p.cabin === cabin)) pairs.push({ c, cabin });
    }
  }
  if (!pairs.length) return;
  body.insertAdjacentHTML('beforeend', '<details class="al-fold" id="al-trip-fold"><summary>行李與貴賓室 <small>依實際營運的航空公司和艙等</small></summary><div class="al-fold-body"><p class="hint">載入中…</p></div></details>');
  const d = $('#al-trip-fold', body);
  d.addEventListener('toggle', () => {
    if (!d.open || d.dataset.done) return;
    airLoad().then(() => { d.dataset.done = '1'; alBagFill($('.al-fold-body', d), pairs); }, () => { $('.al-fold-body', d).innerHTML = '<p class="hint">載入失敗，請檢查網路後再打開一次。</p>'; });
  });
}

// 點數換算器 › 點數換算: 累積哩程試算 behind a closed fold (the calculator and its data load when it opens).
function accrualToolHtml() {
  return '<details class="acc-tool" id="acc-tool"><summary>買現金票能累積多少哩？<small>累積哩程試算：長榮、華航、星宇、國泰的票累積到各計畫</small></summary><div class="acc-tool-body"><p class="hint">載入中…</p></div></details>';
}

if (typeof document !== 'undefined') {
  // Any [data-al] (航班明細's airline name, 規則庫's alliance members, the 行李與貴賓室 rows) opens 航空公司小檔案.
  document.addEventListener('click', (e) => {
    const b = e.target.closest?.('[data-al]');
    if (!b) return;
    e.preventDefault();
    const code = b.dataset.al;
    airLoad().then(() => alSheetOpen(code), () => toast('航空公司資料載入失敗，請檢查網路後再試'));
  });
  document.addEventListener('change', (e) => {
    if (e.target.id !== 'flat-only') return;
    state.flatOnly = e.target.checked;
    renderSearch();
  });
  document.addEventListener('toggle', (e) => {
    const d = e.target;
    if (d.id !== 'acc-tool' || !d.open || d.dataset.done) return;
    const body = $('.acc-tool-body', d);
    airLoad().then(() => { d.dataset.done = '1'; accToolFill(body); }, () => { body.innerHTML = '<p class="hint">載入失敗，請檢查網路後再打開一次。</p>'; });
  }, true);
  // 點數換算器 drawn in the moment before this script ran (tools are loaded together) gets the fold now.
  if ($('#tab-points') && !$('#tab-points').hidden && $('#calc') && !$('#acc-tool') && typeof renderPoints === 'function') renderPoints();
}
