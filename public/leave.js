// 連假請假效率: 「請 N 天休 M 天」 for a trip of the chosen length leaving on a given day, from Taiwan's office calendar
// (行政院人事行政總處, the same /api/trip-info Taiwan days the calendars mark). Behind a switch on the award results and
// 今日好康: chips on the days, and a filter 「不用請假／請 ≤2 天」. Spends no quota. Classic script after features.js.
/* global $, $$, esc, api, store, state, renderSearch, renderCalendar, renderDeals, dealsState, isoDate */

// The trip is `days` calendar days from `start`; the leave is its working days. The time off runs on over the days
// off right before and after it (a Saturday before a Sunday departure counts too). isOff(iso) → true on days off.
function leaveFor(start, days, isOff) {
  const add = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
  const end = add(start, days - 1);
  let leave = 0;
  for (let d = start; d <= end; d = add(d, 1)) if (!isOff(d)) leave++;
  let from = start;
  let to = end;
  for (let i = 0; i < 30 && isOff(add(from, -1)); i++) from = add(from, -1);
  for (let i = 0; i < 30 && isOff(add(to, 1)); i++) to = add(to, 1);
  return { leave, total: Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1, from, to };
}
// Taiwan days ({ date, off, workday }) → isOff; weekends are off unless they are make-up workdays.
function twOff(days) {
  const m = new Map(days.map((d) => [d.date, d.off]));
  return (iso) => (m.has(iso) ? m.get(iso) : [0, 6].includes(new Date(`${iso}T00:00:00Z`).getUTCDay()));
}
if (typeof module === 'object' && module.exports) module.exports = { leaveFor, twOff };

const LEAVE_KEY = 'leave:v1';
const LV = { years: new Map(), days: [], want: new Set(), failed: new Set(), isOff: null };
const leaveCfg = () => { const c = store.get(LEAVE_KEY, null) || {}; return { on: Boolean(c.on), days: Math.min(14, Math.max(2, Number(c.days) || 5)), max: c.max === 0 || c.max === 2 ? c.max : null }; };
// A year whose calendar isn't out yet (no holidays at all in it) is not guessed from weekends alone.
const leaveKnown = (iso) => LV.years.get(iso.slice(0, 4)) === true;
function leaveOf(iso) {
  const c = leaveCfg();
  if (!c.on || !leaveKnown(iso) || !leaveKnown(new Date(Date.parse(`${iso}T00:00:00Z`) + (c.days + 15) * 864e5).toISOString().slice(0, 4))) return null;
  return leaveFor(iso, c.days, (LV.isOff ||= twOff(LV.days)));
}
// Whole calendar years, one request each (the CDN keeps them); the views redraw when one arrives.
function leaveLoad(from, to) {
  const c = leaveCfg();
  if (!c.on || !from) return;
  const last = new Date(Date.parse(`${to || from}T00:00:00Z`) + (c.days + 16) * 864e5).toISOString().slice(0, 4);
  for (let y = Number(from.slice(0, 4)) - (from.slice(5, 7) === '01' ? 1 : 0); y <= Number(last); y++) {
    if (LV.years.has(String(y)) || LV.want.has(y) || LV.failed.has(y)) continue; // a failed year waits for a reload
    LV.want.add(y);
    api(`/api/trip-info?${new URLSearchParams({ to: 'TPE', start: `${y}-01-01`, end: `${y}-12-31`, only: 'holidays' })}`).then((info) => {
      const days = info.taiwan?.days;
      if (!days) { LV.failed.add(y); return; }
      LV.days.push(...days);
      LV.isOff = null;
      LV.years.set(String(y), days.length > 0);
    }).catch(() => LV.failed.add(y)).finally(() => { LV.want.delete(y); leaveRedraw(); });
  }
}
function leaveRedraw() {
  if ($('#search-results .leave-tools')) { if (leaveCfg().max != null) renderSearch(); else { renderCalendar(); leaveStatus(); } }
  if ($('#deals .leave-tools')) renderDeals();
}
const leaveStatus = () => $$('.leave-tools .leave-note').forEach((el) => { el.textContent = leaveNote(); });
function leaveNote() {
  if (LV.want.size) return '讀取台灣行事曆中…';
  if (LV.failed.size && !LV.days.length) return '台灣行事曆暫時拿不到，稍後再試';
  const out = [...LV.years].filter(([, ok]) => !ok).map(([y]) => y);
  return `依行政院人事行政總處行事曆，含前後的週末、連假${out.length ? `；${out.join('、')} 年的行事曆還沒公布，那些日期不標也不篩選` : ''}`;
}

// The filter: rows whose day is unknown stay in.
function leaveOk(iso) {
  const c = leaveCfg();
  if (!c.on || c.max == null) return true;
  const l = leaveOf(iso);
  return !l || l.leave <= c.max;
}
const leaveFiltering = () => { const c = leaveCfg(); return c.on && c.max != null; };
function leaveChip(iso) {
  const l = leaveOf(iso);
  if (!l) return '';
  return `<span class="lv-chip${l.leave === 0 ? ' free' : l.total >= l.leave * 3 ? ' good' : ''}" title="出發玩 ${leaveCfg().days} 天：請 ${l.leave} 天假，連休 ${l.total} 天（${l.from.slice(5).replace('-', '/')}–${l.to.slice(5).replace('-', '/')}）">${l.leave ? `請${l.leave}休${l.total}` : `免請假休${l.total}`}</span>`;
}
// The switch, then (when on) the trip length and the filter. `where`: 'search' | 'deals'.
function leaveToolsHtml(where = 'search') {
  const c = leaveCfg();
  if (c.on) {
    if (where === 'search' && state.start) leaveLoad(state.start, state.end);
    if (where === 'deals') { const ds = (dealsState.body?.groups || []).flatMap((g) => g.items.map((d) => d.date)).sort(); if (ds.length) leaveLoad(ds[0], ds.at(-1)); }
  }
  return `<span class="leave-tools" data-where="${where}">
    <label class="switch"><input type="checkbox" data-leave="on" ${c.on ? 'checked' : ''}><span class="knob"></span>請假效率</label>
    ${c.on ? `<label class="field compact">玩<select data-leave="days" aria-label="玩幾天">${[3, 4, 5, 6, 7, 8, 9, 10, 12, 14].map((n) => `<option value="${n}" ${n === c.days ? 'selected' : ''}>${n} 天</option>`).join('')}</select></label>
    <label class="field compact">只看<select data-leave="max" aria-label="請假天數篩選"><option value="">全部日期</option><option value="0" ${c.max === 0 ? 'selected' : ''}>不用請假</option><option value="2" ${c.max === 2 ? 'selected' : ''}>請 ≤2 天</option></select></label>
    <small class="hint leave-note">${esc(leaveNote())}</small>` : ''}
  </span>`;
}
if (typeof document !== 'undefined') document.addEventListener('change', (e) => {
  const t = e.target.closest?.('[data-leave]');
  if (!t) return;
  const c = leaveCfg();
  const k = t.dataset.leave;
  const next = { ...c, [k]: k === 'on' ? t.checked : k === 'days' ? Number(t.value) : t.value === '' ? null : Number(t.value) };
  if (k === 'on' && !t.checked) next.max = null; // off means every day shows again
  store.set(LEAVE_KEY, next);
  const where = t.closest('.leave-tools')?.dataset.where;
  if (where === 'deals') renderDeals();
  if (state.results?.length) renderSearch();
  if (where === 'search' && $(`#search-results [data-leave="${k}"]`)) $(`#search-results [data-leave="${k}"]`).focus({ preventScroll: true });
});
