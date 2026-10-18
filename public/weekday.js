// 「星期幾比較有位」 in the route results, under the calendar: per weekday, the share of departure dates with space.
// Two sources: this search's own rows (the cabin and program filters on screen apply), and the weekday counts the
// server keeps from the searches its daily jobs already make (/api/history, already fetched by seathistory.js for the
// heatmap; any program, the cabin on screen). No extra calls. Folded by default; hidden when the sample is too small.
// Classic script; uses the globals of app.js ($, esc, state, visibleRows), seathistory.js (histSeq) and flightdata.js
// (ttLfHtml: 各月載客率 from 民航局, round 9).

const WK_NAMES = ['一', '二', '三', '四', '五', '六', '日'];
const WK_DAY = 864e5;
const wkDayNum = (iso) => Math.round(Date.parse(iso + 'T00:00:00Z') / WK_DAY);
const wkMd = (n) => new Date(n * WK_DAY).toISOString().slice(5, 10).replace('-', '/');
// Monday = 0 … Sunday = 6 (day 0, 1970-01-01, was a Thursday).
const wkOf = (n) => (n + 3) % 7;
// Fewer than three of each weekday says nothing about weekdays.
const WK_MIN_SPAN = 21;
let wkOpen = false;

// This search: departure dates in the range (from today on) and those with space in the rows on screen.
function wkThisSearch() {
  if (!state.start || !state.end) return null;
  const today = wkDayNum(new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10));
  const from = Math.max(wkDayNum(state.start), today);
  const to = wkDayNum(state.end);
  if (!(to >= from)) return null;
  const has = [0, 0, 0, 0, 0, 0, 0];
  const looked = [0, 0, 0, 0, 0, 0, 0];
  for (let d = from; d <= to; d++) looked[wkOf(d)]++;
  for (const d of new Set(visibleRows().filter((r) => !r.estimate).map((r) => wkDayNum(r.date)))) if (d >= from && d <= to) has[wkOf(d)]++;
  return { has, looked, span: to - from + 1, note: `${wkMd(from)}–${wkMd(to)}・${to - from + 1} 個出發日` };
}

// The daily jobs' history for the cabin on screen, added up over the routes of the search.
function wkHistory() {
  const routes = (typeof histSeq === 'object' && histSeq.body?.routes) || [];
  const per = routes.map((r) => r.weekdays?.[state.cabin]).filter(Boolean);
  if (!per.length) return null;
  const has = [0, 0, 0, 0, 0, 0, 0];
  const looked = [0, 0, 0, 0, 0, 0, 0];
  for (const w of per) for (let j = 0; j < 7; j++) { has[j] += w.has[j] || 0; looked[j] += w.looked[j] || 0; }
  const since = per.map((w) => w.since).sort()[0];
  const days = wkDayNum(new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)) - wkDayNum(since) + 1;
  return { has, looked, span: Math.max(...per.map((w) => w.span)), days, mock: Boolean(histSeq.body.mock) };
}

const wkRates = (s) => s.has.map((n, j) => (s.looked[j] ? n / s.looked[j] : 0));
const wkUsable = (s) => s && s.span >= WK_MIN_SPAN && Math.min(...s.looked) >= 3;
const wkLevel = (r) => (r >= 0.75 ? 4 : r >= 0.5 ? 3 : r >= 0.25 ? 2 : r > 0 ? 1 : 0);

// The best weekdays, or how it reads when there is nothing to tell them apart.
function wkVerdict(s) {
  const rates = wkRates(s);
  const max = Math.max(...rates);
  if (!max) return '沒有看到位子';
  if (max - Math.min(...rates) < 0.1) return '每天差不多';
  const best = rates.map((r, j) => [r, j]).filter(([r]) => r >= max - 0.05).sort((a, b) => b[0] - a[0]).slice(0, 3);
  return `${best.sort((a, b) => a[1] - b[1]).map(([, j]) => `週${WK_NAMES[j]}`).join('、')}最常有位`;
}

function wkRow(label, note, s) {
  const rates = wkRates(s);
  const max = Math.max(...rates);
  const spread = max - Math.min(...rates) >= 0.1;
  return `<div class="wk-row">
    <span class="wk-label">${label}<small>${note}</small></span>
    ${rates.map((r, j) => `<span class="wk-cell h${wkLevel(r)}${spread && r && r >= max - 0.05 ? ' top' : ''}" title="週${WK_NAMES[j]}：${s.has[j]}／${s.looked[j]} 個出發日有位">${Math.round(r * 100)}%</span>`).join('')}
  </div>`;
}

// Called at the end of renderSearch (filters changed) and when the history arrives.
function wkRender() {
  $('#wk-fold')?.remove();
  const cal = $('#cal-fold');
  if (!cal) return;
  const mine = wkThisSearch();
  const past = wkHistory();
  const useMine = wkUsable(mine) && mine.has.some(Boolean);
  const usePast = wkUsable(past);
  // 各月載客率 (flightdata.js, 民航局; Taiwan routes only), folded inside.
  const lf = typeof ttLfHtml === 'function' ? ttLfHtml() : '';
  if (!useMine && !usePast && !lf) return;
  const head = useMine ? `這次搜尋：${wkVerdict(mine)}` : usePast ? `過去 ${past.days} 天：${wkVerdict(past)}` : '各月載客率（民航局）';
  const rows = [
    useMine ? wkRow('這次搜尋', esc(mine.note), mine) : `<p class="hint wk-small">這次搜尋${mine && mine.span < WK_MIN_SPAN ? '的日期範圍不到 3 週' : '沒有位子'}，看不出星期幾的差別。</p>`,
    usePast ? wkRow(`過去 ${past.days} 天累積`, `每日排程・所有計畫${past.mock ? '（示範）' : ''}`, past) : '',
  ].join('');
  const heat = $('#search-hist details.hist') ? ' <button type="button" class="linklike" data-wk-hist>看每天的釋位熱度圖</button>' : '';
  const slot = $('#wk-slot'); // inside 更多分析 (index.html)
  (slot || cal).insertAdjacentHTML(slot ? 'beforeend' : 'afterend', `<details class="cal-fold wk-fold" id="wk-fold"${wkOpen ? ' open' : ''}>
    <summary><h2 class="section-title">星期幾比較有位 <small>${esc(head)}</small></h2></summary>
    ${useMine || usePast ? `<div class="wk-grid">
      <div class="wk-row wk-head"><span></span>${WK_NAMES.map((n) => `<span>${n}</span>`).join('')}</div>
      ${rows}
    </div>
    <p class="hint wk-how">有位的出發日 ÷ 查到的出發日，依目前選的艙等${useMine ? '；「這次搜尋」也依勾選的計畫' : ''}。${usePast ? '「過去累積」是每天排程（每日精選、機位提醒）順手記下的，不另外花查詢額度。' : ''}${heat}</p>` : '<p class="hint wk-small">這次搜尋看不出星期幾的差別，先看各月的載客率。</p>'}
    ${lf}
  </details>`);
  $('#wk-fold').addEventListener('toggle', (e) => { wkOpen = e.target.open; });
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('[data-wk-hist]')) return;
  const d = $('#search-hist details.hist');
  if (!d) return;
  d.open = true;
  d.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
