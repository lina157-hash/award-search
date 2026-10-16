// 「過去 N 天這條航線的釋位紀錄」 under the route search results: a small heatmap per program × cabin, from the daily
// snapshots the server keeps of searches its daily jobs already make (/api/history; costs no seats.aero calls).
// Shown only when the route has history. Classic script; uses the globals of app.js ($, esc, api, fmt, srcName…).

const histSeq = { n: 0 };
const HIST_DAY = 864e5;
const histDayNum = (iso) => Math.round(Date.parse(iso + 'T00:00:00Z') / HIST_DAY);
const histIso = (n) => new Date(n * HIST_DAY).toISOString().slice(0, 10);
// Heat level from the number of departure dates that had space that day.
const histLevel = (n) => (n >= 15 ? 4 : n >= 6 ? 3 : n >= 3 ? 2 : 1);

function histRoute(r, cabin) {
  const obs = r.observed.map(histDayNum);
  if (!obs.length) return '';
  const first = obs[0];
  const last = Math.max(obs.at(-1), ...r.series.map((s) => histDayNum(s.points.at(-1)[0])));
  const looked = new Set(obs);
  const order = { [cabin]: 0 };
  const series = [...r.series].sort((a, b) => (order[a.cabin] ?? 1) - (order[b.cabin] ?? 1) || 'FJWY'.indexOf(a.cabin) - 'FJWY'.indexOf(b.cabin) || b.days - a.days);
  const rows = series.map((s) => {
    const by = new Map(s.points.map(([d, n, m, seats]) => [histDayNum(d), { n, m, seats }]));
    const cells = [];
    for (let d = first; d <= last; d++) {
      const p = by.get(d);
      const day = histIso(d).slice(5).replace('-', '/');
      if (p) cells.push(`<i class="h${histLevel(p.n)}" title="${day}：${p.n} 個出發日有位，最低 ${fmt(p.m)} 哩${p.seats ? `，最多 ${p.seats} 位` : ''}"></i>`);
      else cells.push(looked.has(d) ? `<i class="h0" title="${day}：沒看到位子"></i>` : `<i class="hx" title="${day}：這天沒有檢查"></i>`);
    }
    return `<div class="hist-row${s.cabin === cabin ? '' : ' other'}">
      <span class="hist-name">${esc(srcName(s.source))} <small>${esc(CABIN_SHORT[s.cabin] || s.cabin)}</small></span>
      <span class="hist-strip" style="--n:${last - first + 1}">${cells.join('')}</span>
      <span class="hist-sum"${histUsual(s)}>${s.days}/${obs.length} 天有位・最低 ${fmt(s.minMiles)} 哩</span>
    </div>`;
  }).join('');
  return `<div class="hist-route">
    <p class="hist-title">${esc(r.origin)} → ${esc(r.destination)}</p>
    ${rows || '<p class="hint">這段期間每天檢查都沒看到位子。</p>'}
    <div class="hist-row hist-axis"><span></span><span class="ax"><span>${esc(histIso(first).slice(5).replace('-', '/'))}</span><span>${last >= histDayNum(new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)) ? '今天' : esc(histIso(last).slice(5).replace('-', '/'))}</span></span><span></span></div>
    ${histLeadHtml(r, cabin)}
  </div>`;
}

// 「平常約 X 哩」 (哩數水準) as the summary's tooltip: the lower median of the daily lowest miles, once space was seen
// on 7 days or more (the row has no room for it on screen).
function histUsual(s) {
  const lv = typeof priceLevel === 'function' ? priceLevel(s.minMiles, s.points.map((p) => p[2])) : null;
  return lv ? ` title="平常約 ${fmt(lv.usual)} 哩（有位的 ${lv.n} 天每天最低價的中位數）"` : '';
}

// 什麼時候放位: one line per route for the searched cabin, from the dates first seen with space (lib/history.js
// mergeLead). A program needs 5 such dates before its pattern is shown.
function histLeadHtml(r, cabin) {
  if (!r.lead || typeof leadMain !== 'function') return '';
  const list = r.lead.series.filter((s) => s.cabin === cabin).sort((a, b) => b.n - a.n);
  const enough = list.filter((s) => s.n >= 5).slice(0, 3);
  const total = list.reduce((a, s) => a + s.n, 0);
  const parts = enough.map((s) => {
    const m = leadMain(s.b);
    return `${esc(srcName(s.source))} ${m.i >= 0 ? `多半在出發前 <b>${LEAD_TEXT[m.i]}</b>${m.i === 0 ? '才' : ''}出現（${m.k}/${m.n} 次）` : `出現時間分散（${m.n} 次）`}`;
  });
  const text = parts.length ? parts.join('；') : total ? `還在累積，${esc(CABIN_SHORT[cabin] || '')}艙目前只記到 ${total} 個新出現的出發日，每個計畫至少要 5 個才看得出規律` : `還沒有記到${esc(CABIN_SHORT[cabin] || '')}艙新出現的位子`;
  return `<p class="hist-lead">🕒 什麼時候放位：${text}。<small>自 ${esc(mmdd(r.lead.since))} 起，只算每日排程查過的日期裡「前一次沒位、這次有位」的出發日；排程第一次查就有位的不算。</small></p>`;
}

// `share`: the search's share params (o, d, c), or null to clear when a new search starts.
async function histShow(share) {
  let box = $('#search-hist');
  if (!box) {
    $('#search-trip')?.insertAdjacentHTML('afterend', '<div id="search-hist"></div>');
    box = $('#search-hist');
  }
  if (!box) return;
  const n = ++histSeq.n;
  box.innerHTML = '';
  histSeq.body = null; // also read by weekday.js
  if (!share) return;
  let body;
  try {
    body = await api(`/api/history?${new URLSearchParams({ origin: share.get('o'), destination: share.get('d') })}`);
  } catch { return; }
  if (n !== histSeq.n || !body.routes?.length) return;
  histSeq.body = body;
  if (typeof levelRefresh === 'function') levelRefresh(); // 哩數水準 on the cards and program chips (flightplus.js)
  const cabin = share.get('c') || 'J';
  const days = Math.max(...body.routes.map((r) => (r.observed.length ? histDayNum(r.observed.at(-1)) - histDayNum(r.observed[0]) + 1 : 0)));
  box.innerHTML = `<details class="hist">
    <summary>📈 過去 ${days} 天這條航線的釋位紀錄${body.mock ? '<small>（示範資料）</small>' : ''}</summary>
    <div class="hist-body">
      ${body.routes.map((r) => histRoute(r, cabin)).join('')}
      <p class="hist-legend"><span><i class="h0"></i>沒位</span><span><i class="h1"></i><i class="h2"></i><i class="h3"></i><i class="h4"></i>有位的出發日 少 → 多</span><span><i class="hx"></i>空白：那天沒有檢查</span></p>
      <p class="hint">每天排程（每日精選、機位提醒）查這條航線時順手記下的：那天看到幾個出發日有位、最低幾哩。不另外花查詢額度；只有排程查過的航線才有紀錄。</p>
    </div>
  </details>`;
  if (typeof wkRender === 'function' && $('#cal-fold')) wkRender();
}
