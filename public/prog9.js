// Round 9 (r9-prog) extras, fetched with the tools (TOOL_SCRIPTS):
// - #17 the 「在 Great Circle Mapper 開啟」 link (航班明細, 中停／開口組合, 環球票規劃) and the 規則庫 card 好用的外部工具;
// - #21 規則庫 最近變動, from the same builder as the owner's weekly 本週變動 message (lib/weekly.js);
// - #27 規則庫 會籍匹配 (programs.json statusMatch, official pages only);
// - #28 查現金票's 航空公司官方特賣 fold (promos.json cashSales; filling the form spends nothing);
// - #29 看改版前: old award-chart values next to the new ones (charts.json `was`, asiamiles.json `before`).
// The pure parts at the top also run in Node (server.js requires this file for the weekly digest).

// ---------- pure helpers ----------
const p9Iso = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const p9Md = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
const p9AddDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const p9Esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Legs [{ from, to, surface? }] → gcmap's path: TPE-HKG-LHR, with a comma where the route breaks (an open jaw or a
// surface sector): TPE-HKG-LHR,JFK-TPE. Only 3-letter airport codes.
function gcmapPath(legs) {
  const paths = [];
  let cur = null;
  for (const l of legs || []) {
    const from = String(l?.from || '').toUpperCase();
    const to = String(l?.to || '').toUpperCase();
    if (l?.surface || !/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) { cur = null; continue; }
    if (cur && cur.at(-1) === from) cur.push(to);
    else paths.push((cur = [from, to]));
  }
  return paths.map((p) => p.join('-')).join(',');
}
const gcmapUrl = (legs) => { const p = gcmapPath(legs); return p ? `https://www.gcmap.com/mapui?P=${p}` : ''; };

if (typeof module === 'object' && module.exports) {
  module.exports = { gcmapPath, gcmapUrl };
} else {
  // ---------- browser ----------
  // #17: the link under a route. `legs` [{ from, to, surface? }].
  window.gcmapLinkHtml = (legs, cls = '') => {
    const url = gcmapUrl(legs);
    return url ? `<p class="hint gcmap-line ${cls}"><a href="${esc(url)}" target="_blank" rel="noopener" title="第三方網站：畫出這條航線、算每段大圓距離">🗺 在 Great Circle Mapper 開啟 ↗</a> <span class="tag tp">第三方</span> <small>${esc(gcmapPath(legs))}</small></p>` : '';
  };

  const p9Link = (s) => (s?.url ? ` <a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label || '來源')} ↗</a>` : '');
  const p9Today = () => (typeof twDate === 'function' ? twDate(0) : isoDate(0));

  // #17 好用的外部工具: links only, every one a third party.
  const P9_TOOLS = [
    ['Great Circle Mapper', 'https://www.gcmap.com/', '畫出航線、算每段和全程的大圓距離，看行程落在哪個距離區間（Karl L. Swartz 製作）。'],
    ['FlightConnections', 'https://www.flightconnections.com/', '查一個機場直飛哪些城市、哪些航空在飛，找中停點或轉機點。'],
    ['wheretocredit', 'https://www.wheretocredit.com/', '付費機票依艙等代碼累積到各哩程計畫的比例，決定要累積到哪個計畫。'],
    ['SeatMaps', 'https://seatmaps.com/', '各航空、各機型的座位圖與座椅介紹。'],
    ['AeroLOPA', 'https://www.aerolopa.com/', '依比例畫的座位圖，看得到窗戶和座位的相對位置。'],
    ['CX Planner', 'https://cxplanner.jayliu.net/', '在地圖上規劃國泰的寰宇一家環球票路線，查位要另裝 Unelevated 外掛。'],
    ['Unelevated', 'https://userscripts.jayliu.net/cx.html', '在國泰官網一次查 20 天獎勵位的瀏覽器腳本；作者 2026-06-20 表示國泰改版後暫時不能用，進階功能要付費。'],
  ];
  function toolsHtml() {
    return `<h2 class="section" id="r-tools">好用的外部工具</h2>
      <p class="hint">都是第三方網站，本站只放連結、不抓它們的資料；資料以各航空官網為準。</p>
      <div class="cards tools-cards">${P9_TOOLS.map(([name, url, what]) => `<div class="card tool-card"><h3><a href="${esc(url)}" target="_blank" rel="noopener">${esc(name)} ↗</a> <span class="tag tp">第三方</span></h3><p>${esc(what)}</p></div>`).join('')}</div>`;
  }

  // [html, one-line summary] for renderRulesBody (app.js), in page order; empty ones left out.
  window.prog9Sections = () => [
    [toolsHtml(), `${P9_TOOLS.length} 個第三方工具：距離、航點、累積、座位圖`],
  ].filter(([h]) => h);
}
