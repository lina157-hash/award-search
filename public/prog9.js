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

const P9_KIND = { start: ['開始', 'ok'], end: ['結束', ''], rule: ['規則', 'until'], alliance: ['聯盟', 'soon'], rate: ['比率', 'until soon'] };
const p9Src1 = (p) => (p.sources || []).find((s) => s?.url) || (p.source?.url ? p.source : null);
const p9PromoWhat = (p) => (p.type === 'award' ? '哩程票特惠' : p.type === 'buy' ? '買哩促銷' : '轉點加贈');

// What changed in the data files: `past` = dated within the last `back` days (newest first), `next` = within the next
// `ahead` days (soonest first). src: { promos, history, log, changes, alliances, transfers, airlineName? }.
// Items: { date, kind: start|end|rule|alliance|rate, title, note, source }.
function recentChanges(src, today, { back = 30, ahead = 30 } = {}) {
  const from = p9AddDays(today, -back);
  const to = p9AddDays(today, ahead);
  const past = [];
  const next = [];
  const seen = new Set();
  const put = (x) => {
    const id = `${x.kind}|${x.date}|${x.title}`;
    if (seen.has(id)) return;
    seen.add(id);
    // A bank rate or a promo's last day that is today is still ahead; anything else dated today has happened.
    const ahead = x.date > today || (x.date === today && (x.kind === 'rate' || x.kind === 'end'));
    if (!ahead && x.date >= from) past.push(x);
    else if (ahead && x.date <= to) next.push(x);
  };
  for (const p of [...(src.promos || []), ...(src.history || [])]) {
    if (!p9Iso(p.start) || !p9Iso(p.end)) continue;
    const what = p9PromoWhat(p);
    if (p.start >= from && p.start <= today) put({ date: p.start, kind: 'start', title: p.title, note: `${what}・到 ${p9Md(p.end)}`, source: p9Src1(p) });
    if (p.end < today && p.end >= from) put({ date: p.end, kind: 'end', title: p.title, note: `${what}已結束`, source: p9Src1(p) });
    else if (p.end >= today && p.start <= today) put({ date: p.end, kind: 'end', title: p.title, note: p.type === 'award' ? '最後開票日' : p.type === 'buy' ? '最後一天' : '最後轉點日', source: p9Src1(p) });
  }
  for (const c of src.log || []) if (p9Iso(c.date) && c.date <= today) put({ date: c.date, kind: c.kind === 'alliance' ? 'alliance' : 'rule', title: c.title, note: c.advice || '', source: c.source || null });
  for (const c of src.changes || []) if (p9Iso(c.date) && c.date > today) put({ date: c.date, kind: 'rule', title: c.title, note: c.advice || '', source: c.source || null, pct: c.pct });
  const VERB = { joined: '加入', left: '退出', leaving: '退出', upcoming: '加入' };
  for (const a of src.alliances || []) {
    const al = String(a.name || '').replace(/\s+[A-Za-z].*$/, '');
    for (const n of a.memberNotes || []) {
      if (!p9Iso(n.date) || !VERB[n.status]) continue;
      const name = src.airlineName ? src.airlineName(n.code) : n.code;
      put({ date: n.date, kind: 'alliance', title: `${name}${VERB[n.status]}${al}`, note: '', source: [].concat(n.source || [])[0] || null });
    }
  }
  // One line per bank and date: 「台新 轉華航 華夏哩程、長榮…的比率保證期限」.
  const rates = new Map();
  for (const t of src.transfers || []) {
    const d = [t.validUntil, ...(Array.isArray(t.rates) ? t.rates.map((r) => r.validUntil) : [])].filter(p9Iso).sort()[0];
    if (!d) continue;
    const k = `${t.bank}|${d}`;
    const r = rates.get(k) || { date: d, bank: t.bank, to: [], source: t.source || null };
    for (const n of [].concat(t.toName || [])) if (n && !r.to.includes(n)) r.to.push(n);
    rates.set(k, r);
  }
  for (const r of rates.values()) {
    put({ date: r.date, kind: 'rate', title: `${r.bank} 轉${r.to.join('、') || '哩程'}的比率保證期限`, note: r.date < today ? '期限已過，比率可能已調整' : '之後比率可能調整，要用目前的比率請在這天前轉點', source: r.source });
  }
  past.sort((a, b) => b.date.localeCompare(a.date));
  next.sort((a, b) => a.date.localeCompare(b.date));
  return { past, next };
}

// The owner's weekly 本週變動: the last 7 days (today included) and the next 14. Null when there is nothing to say.
// Returns { count, chat (Telegram HTML), text (plain), subject, html (mail) }.
function weeklyDigest(src, today, siteUrl = '') {
  const { past } = recentChanges(src, today, { back: 6, ahead: 0 });
  const { next: ahead } = recentChanges(src, today, { back: 0, ahead: 14 });
  if (!past.length && !ahead.length) return null;
  const tag = (x) => `【${P9_KIND[x.kind][0]}】`;
  const line = (x, withDate) => `${withDate ? `${p9Md(x.date)} ` : ''}${tag(x)}${x.title}${x.note ? `（${x.note}）` : ''}`;
  const head = `本週變動（${p9Md(p9AddDays(today, -6))}–${p9Md(today)}）`;
  const link = siteUrl ? `${siteUrl}/#rules` : '';
  const block = (h, list, d) => (list.length ? `${h}\n${list.map((x) => `• ${line(x, d)}`).join('\n')}` : '');
  const chat = [`🗓 <b>${p9Esc(head)}</b>`,
    past.length ? `<b>過去 7 天</b>\n${past.map((x) => `• ${p9Esc(line(x, false))}`).join('\n')}` : '',
    ahead.length ? `<b>接下來 14 天</b>\n${ahead.map((x) => `• ${p9Esc(line(x, true))}`).join('\n')}` : '',
    link ? p9Esc(link) : ''].filter(Boolean).join('\n\n');
  const text = [head, block('過去 7 天', past, false), block('接下來 14 天', ahead, true), link].filter(Boolean).join('\n\n');
  const li = (x, d) => `<li>${p9Esc(line(x, d))}${x.source?.url ? `（<a href="${p9Esc(x.source.url)}">${p9Esc(x.source.label || '來源')}</a>）` : ''}</li>`;
  const html = `<div style="font-family:system-ui,sans-serif;line-height:1.6"><h2 style="font-size:18px">${p9Esc(head)}</h2>
    ${past.length ? `<p><b>過去 7 天</b></p><ul>${past.map((x) => li(x, false)).join('')}</ul>` : ''}
    ${ahead.length ? `<p><b>接下來 14 天</b></p><ul>${ahead.map((x) => li(x, true)).join('')}</ul>` : ''}
    ${link ? `<p><a href="${p9Esc(link)}">打開規則庫「最近變動」</a></p>` : ''}<p style="color:#777;font-size:13px">機票搜索雷達・每週一次，內容來自網站的資料檔與官方來源。</p></div>`;
  const count = past.length + ahead.length;
  return { count, chat, text, html, subject: `【機票搜索雷達】本週變動 ${count} 項：${(past[0] || ahead[0]).title}` };
}

if (typeof module === 'object' && module.exports) {
  module.exports = { gcmapPath, gcmapUrl, recentChanges, weeklyDigest };
} else {
  // ---------- browser ----------
  // #17: the link under a route. `legs` [{ from, to, surface? }].
  window.gcmapLinkHtml = (legs, cls = '') => {
    const url = gcmapUrl(legs);
    return url ? `<p class="hint gcmap-line ${cls}"><a href="${esc(url)}" target="_blank" rel="noopener" title="第三方網站：畫出這條航線、算每段大圓距離">🗺 在 Great Circle Mapper 開啟 ↗</a> <span class="tag tp">第三方</span> <small>${esc(gcmapPath(legs))}</small></p>` : '';
  };

  const p9Link = (s) => (s?.url ? ` <a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label || '來源')} ↗</a>` : '');
  const p9Today = () => (typeof twDate === 'function' ? twDate(0) : isoDate(0));

  // #21 最近變動.
  const p9Changes = (opts) => recentChanges({
    promos: data.promos?.promos, history: data.promoHistory?.promos, log: data.changes?.log, changes: data.changes?.changes,
    alliances: data.alliances?.alliances, transfers: data.points?.transfers, airlineName: airlineZh,
  }, p9Today(), opts);
  const p9Li = (x) => {
    const [label, cls] = P9_KIND[x.kind];
    return `<li><span class="tag ${cls}">${label}</span> <b>${esc(x.title)}</b><small>${p9Md(x.date)}${x.note ? `・${esc(x.note)}` : ''}${p9Link(x.source)}</small></li>`;
  };
  function recentHtml() {
    const { past, next } = p9Changes();
    const rates = next.filter((x) => x.kind === 'rate');
    return `<h2 class="section" id="r-recent">最近變動</h2>
      <p class="hint">過去 30 天網站資料裡的變動：優惠開始與結束、規則改變（附官方來源）、聯盟成員異動、轉點比率到期。</p>
      <div class="promos recent-box"><ul>${past.map(p9Li).join('') || '<li>過去 30 天沒有記錄到變動。</li>'}</ul></div>
      ${rates.length ? `<h3 class="sub">接下來 30 天到期的轉點比率</h3><div class="promos recent-box"><ul>${rates.map(p9Li).join('')}</ul></div>` : ''}`;
  }
  function recentSum() {
    const { past, next } = p9Changes();
    const n = (k) => past.filter((x) => x.kind === k).length;
    const parts = [[n('start'), '個優惠開始'], [n('end'), '個結束'], [n('rule') + n('alliance'), '項規則或聯盟異動']].filter(([c]) => c).map(([c, t]) => `${c} ${t}`);
    const rates = next.filter((x) => x.kind === 'rate').length;
    return `過去 30 天：${parts.join('、') || '沒有變動'}${rates ? `・${rates} 家銀行比率快到期` : ''}`;
  }

  // #27 會籍匹配.
  function statusHtml() {
    const sm = data.programs?.statusMatch;
    if (!sm?.offers?.length) return '';
    const today = p9Today();
    const live = sm.offers.filter((o) => !o.ends || o.ends >= today);
    if (!live.length) return '';
    const card = (o) => `<details class="card sm-card"><summary>${airlineLogo(o.airline, 'md')}<span class="card-head"><h3>${esc(o.program)}：${esc(o.title)}</h3>
        <small class="card-sum">${o.ends ? `報名到 ${esc(o.ends)}` : '沒有寫截止日'}・${esc(o.gives)}</small></span></summary>
      <dl><dt>拿到什麼</dt><dd>${esc(o.gives)}</dd><dt>條件</dt><dd><ul>${o.needs.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></dd>
        <dt>保級</dt><dd>${esc(o.keep)}</dd><dt>限制</dt><dd><ul>${o.limits.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></dd>
        <dt>截止</dt><dd>${esc(o.endsNote || o.ends || '')}</dd></dl>
      ${o.matrix?.length ? `<details class="sub-fold"><summary><h4>可以匹配的計畫與等級</h4><small>${o.matrix.length} 個</small></summary><div class="table-wrap"><table><thead><tr><th>你現在的計畫</th><th>換 Gold</th><th>換 Silver</th></tr></thead>
        <tbody>${o.matrix.map(([p, g, s]) => `<tr><td>${esc(p)}</td><td>${esc(g)}</td><td>${esc(s)}</td></tr>`).join('')}</tbody></table></div></details>` : ''}
      <div class="src">${CONFIDENCE_TAG[o.confidence] || ''} 來源（${esc(o.checked)} 查核）：${p9Link(o.source)}</div></details>`;
    return `<h2 class="section" id="r-status">會籍匹配</h2>
      <p class="hint">航空公司官網公開的會籍匹配：用你在別家的會籍換這家的同級會籍。只收官方計畫頁（${esc(sm.lastReviewed)} 查核），申請前請再看一次官網條款。</p><div class="cards">${live.map(card).join('')}</div>`;
  }

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
    [recentHtml(), recentSum()],
    [statusHtml(), `${(data.programs?.statusMatch?.offers || []).filter((o) => !o.ends || o.ends >= p9Today()).length} 個官方會籍匹配：條件與截止日`],
    [toolsHtml(), `${P9_TOOLS.length} 個第三方工具：距離、航點、累積、座位圖`],
  ].filter(([h]) => h);
}
