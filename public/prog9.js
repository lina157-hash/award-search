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

// 「88,000 → 91,000」 as a signed whole percent: +3%, -4%, 0%.
const p9Pct = (now, was) => { const p = Math.round(((now - was) / was) * 100); return `${p > 0 ? '+' : ''}${p}%`; };

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
  module.exports = { gcmapPath, gcmapUrl, p9Pct, recentChanges, weeklyDigest };
} else {
  // ---------- browser ----------
  // #17: the link under a route. `legs` [{ from, to, surface? }].
  window.gcmapLinkHtml = (legs, cls = '') => {
    const url = gcmapUrl(legs);
    return url ? `<p class="hint gcmap-line ${cls}"><a href="${esc(url)}" target="_blank" rel="noopener" title="第三方網站：畫出這條航線、算每段大圓距離">🗺 在 Great Circle Mapper 開啟 ↗</a> <span class="tag tp">第三方</span> <small>${esc(gcmapPath(legs))}</small></p>` : '';
  };

  const p9Link = (s) => (s?.url ? ` <a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label || '來源')} ↗</a>` : '');
  const p9Today = () => (typeof twDate === 'function' ? twDate(0) : isoDate(0));

  // #29: 「（原 88,000，+3%）」 after a chart value; shown only while 看改版前 is on.
  window.beforeCell = (now, was) => (now > 0 && was > 0 && now !== was ? `<small class="was">（原 ${fmt(was)}，${p9Pct(now, was)}）</small>` : '');
  window.beforeToggleHtml = (b) => `<p class="before-bar"><label class="before-toggle"><input type="checkbox" data-before> 看改版前</label>
    <small>${esc(b.effective)} 改版${b.confidence === 'secondary' ? '・<span class="tag verify">第三方整理</span><sup class="mk-3p" aria-hidden="true">*</sup>' : '・<span class="tag ok">官方資料</span>'}${(b.sources || [b.source]).filter(Boolean).map(p9Link).join('')}</small></p>`;
  document.addEventListener('change', (e) => {
    const box = e.target.closest?.('input[data-before]');
    if (!box) return;
    box.closest('.before-host, .rules-sec')?.classList.toggle('show-before', box.checked);
  });

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

  // #29 哩程表改版前後: every charts.json table with old values, plus a pointer to the Asia Miles table's toggle.
  function beforeHtml() {
    const progs = (data.charts?.programs || []).filter((p) => p.before && p.tables?.some((t) => t.pairs?.some((pr) => pr.bands.some((b) => b.was))));
    const am = data.asiamiles?.before;
    if (!progs.length && !am) return '';
    const region = (p, id) => esc(String(p.regions?.[id]?.name || id).replace(/（.*$/, ''));
    const cabins = ['Y', 'W', 'J', 'F'];
    const tables = progs.map((p) => p.tables.map((t) => t.pairs.filter((pr) => pr.bands.some((b) => b.was)).map((pr) => {
      const cols = cabins.filter((c) => pr.bands.some((b) => b[c] != null));
      const rows = pr.bands.map((b, i) => {
        const lo = i ? pr.bands[i - 1].upTo + 1 : 0;
        const range = b.upTo == null ? `${fmt(lo)} 哩以上` : `${fmt(lo)}–${fmt(b.upTo)} 哩`;
        return `<tr><td>${range}</td>${cols.map((c) => `<td>${b[c] == null ? '—' : fmt(b[c])}${beforeCell(b[c], b.was?.[c])}</td>`).join('')}</tr>`;
      }).join('');
      return `<div><h4>${region(p, pr.from)} ↔ ${region(p, pr.to)}</h4><div class="table-wrap"><table><thead><tr><th>單程距離</th>${cols.map((c) => `<th>${CABIN_LABEL[c]}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div></div>`;
    }).join('')).join('')).join('');
    const head = progs.map((p) => {
      const cells = p.tables.flatMap((t) => t.pairs.flatMap((pr) => pr.bands.flatMap((b) => Object.entries(b.was || {}).map(([c, w]) => [b[c], w]))));
      const up = cells.filter(([n, w]) => n > w).length;
      const down = cells.filter(([n, w]) => n < w).length;
      return `<li><b>${esc(p.name)}</b>：${esc(p.before.effective)} 起，${cells.length} 格有調整（漲 ${up} 格、降 ${down} 格）<small>${esc(p.before.note || '')}${p9Link(p.before.source)}</small></li>`;
    }).join('');
    const amLi = am ? `<li><b>亞洲萬里通</b>：${esc(am.effective)} 起，國泰航班 ${Object.values(am.cx || {}).reduce((n, x) => n + Object.keys(x).length, 0)} 格有公告的舊值 <span class="tag verify">第三方整理</span><sup class="mk-3p" aria-hidden="true">*</sup>
      <small>在上面「亞洲萬里通哩數表」打開「看改版前」對照。${esc(am.note || '')}</small></li>` : '';
    const firstBefore = progs[0]?.before;
    return `<h2 class="section" id="r-before">哩程表改版前後</h2>
      <p class="hint">固定哩程表改版時，新舊哩數並排對照；只收官方公告逐格列出的舊值。</p>
      <div class="promos recent-box"><ul>${head}${amLi}</ul></div>
      ${tables ? `<div class="before-host">${firstBefore ? beforeToggleHtml(firstBefore) : ''}${progs.map((p) => `<h3 class="sub">${esc(p.name)}・${esc(p.tables[0]?.label || '')}</h3>`).join('')}<div class="before-tables">${tables}</div></div>` : ''}`;
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
    ['Roame', 'https://roame.travel/', '依地區或整個國家查一段日期的獎勵位（SkyView），也查飯店點數；以美國的計畫為主，沒有亞洲萬里通、長榮、華航。免費版範圍有限。'],
    ['point.me', 'https://www.point.me/', '即時查 30 多個計畫，附轉點和訂位步驟；免費版有限制，完整功能要付年費。'],
    ['PointsYeah', 'https://www.pointsyeah.com/', '即時查獎勵位，免費版一次查四個出發日；也有探索、提醒和飯店點數。'],
    ['AwardTool', 'https://www.awardtool.com/', '即時查單程和來回，一個欄位可以放同城市的多個機場；免費查詢次數有限。'],
    ['AwardFares', 'https://awardfares.com/', '一次查最多六個機場或城市，有時間軸檢視和各計畫開放日指南；免費版只看得到部分結果。'],
    ['ExpertFlyer', 'https://www.expertflyer.com/', '查每班機各訂位代碼還剩幾位、升等艙位、座位圖和座位提醒；大多功能要付費。'],
  ];
  function toolsHtml() {
    return `<h2 class="section" id="r-tools">好用的外部工具</h2>
      <p class="hint">都是第三方網站，本站只放連結、不抓它們的資料；資料以各航空官網為準。</p>
      <div class="cards tools-cards">${P9_TOOLS.map(([name, url, what]) => `<div class="card tool-card"><h3><a href="${esc(url)}" target="_blank" rel="noopener">${esc(name)} ↗</a> <span class="tag tp">第三方</span></h3><p>${esc(what)}</p></div>`).join('')}</div>`;
  }

  // [html, one-line summary] for renderRulesBody (app.js), in page order; empty ones left out.
  window.prog9Sections = () => [
    [recentHtml(), recentSum()],
    [beforeHtml(), '加航、亞萬固定哩程表新舊哩數對照'],
    [statusHtml(), `${(data.programs?.statusMatch?.offers || []).filter((o) => !o.ends || o.ends >= p9Today()).length} 個官方會籍匹配：條件與截止日`],
    [toolsHtml(), `${P9_TOOLS.length} 個第三方工具：距離、航點、累積、座位圖`],
  ].filter(([h]) => h);

  // #28 查現金票: the carriers' own fare sales (promos.json cashSales). 「用這個日期查」 fills the form and stops;
  // the search (and its quota) waits for the visitor's 「搜尋票價」.
  let p9Sales = null;
  async function cashSalesMount() {
    const host = document.getElementById('cash-sales');
    if (!host || host.dataset.ready) return;
    host.dataset.ready = '1';
    const promos = data.promos || await api('/api/data/promos').catch(() => null);
    if (!promos) { delete host.dataset.ready; return; }
    const today = p9Today();
    p9Sales = (promos.cashSales || []).filter((s) => p9Iso(s.end) && s.end >= today && (!s.travelTo || s.travelTo > today));
    const pages = promos.cashSalePages || [];
    if (!p9Sales.length && !pages.length) return;
    $('summary small', host).textContent = p9Sales.length ? `${p9Sales.length} 檔進行中` : '各家官網特賣頁';
    $('.cash-sales-body', host).innerHTML = p9Sales.length ? p9Sales.map(saleCard).join('') + pagesHtml(pages, '其他航空的官方特賣頁') : `<p class="hint">目前沒有整理到進行中的官方特賣，可以到各家官網看：</p>${pagesHtml(pages)}`;
    host.hidden = false;
  }
  const pagesHtml = (pages, head = '') => (pages.length ? `${head ? `<p class="hint">${head}：</p>` : ''}<ul class="sale-pages">${pages.map((p) => `<li>${airlineLogo(p.airline, 'sm')}<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.label)} ↗</a></li>`).join('')}</ul>` : '');
  function saleCard(s, i) {
    const dests = [].concat(s.to || []);
    const trip = s.trip === 'ow' ? '單程' : '來回';
    return `<div class="cash-sale">${airlineLogo(s.airline, 'sm')}<div><b>${esc(s.title)}</b>${s.demo ? ' <span class="tag">示範資料</span>' : ''}
      <small>${p9Md(s.start)}–${p9Md(s.end)} 開賣・${s.travelFrom ? `${p9Md(s.travelFrom)}–${p9Md(s.travelTo)} 出發` : '出發日見官網'}・${trip}${s.price ? `・${esc(s.price)}` : ''}${p9Link(s.source)}</small>
      <div class="sale-go">${dests.map((d) => `<button type="button" class="chip" data-sale="${i}" data-to="${esc(d)}">${esc([].concat(s.from || [])[0] || '')} → ${esc(d)} ${esc(typeof airportCity === 'function' ? airportCity(d) : '')}</button>`).join('')}
      <small>點目的地會用這個日期填好表單，不會自動查價</small></div></div></div>`;
  }
  // The first travel day still ahead (tomorrow at the earliest); a return a week later, inside the travel window.
  function saleFill(s, to) {
    const today = p9Today();
    const first = p9AddDays(today, 1);
    const dep = s.travelFrom && s.travelFrom > first ? s.travelFrom : first;
    const rt = s.trip !== 'ow';
    const ret = rt ? [p9AddDays(dep, 7), s.travelTo].filter(Boolean).sort()[0] : '';
    cashPickers.origin.set([].concat(s.from || []).slice(0, 1));
    cashPickers.destination.set([to]);
    const radio = $(`#cash-form input[name=trip][value="${rt ? 'rt' : 'ow'}"]`);
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
    if (s.cabin) { const c = $(`#cash-form input[name=cabin][value="${s.cabin}"]`); if (c) c.checked = true; }
    cashDates.depart.set(dep);
    if (rt) cashDates.ret.set(ret < dep ? dep : ret);
    $('#cash-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
    toast(`已填好 ${p9Md(dep)}${rt ? `–${p9Md(ret < dep ? dep : ret)}` : ''}，日期可以再改；按「搜尋票價」才會查價（會用到查價額度）`);
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest?.('#cash-sales [data-sale]');
    const s = b && p9Sales?.[Number(b.dataset.sale)];
    if (s) saleFill(s, b.dataset.to);
  });
  window.cashSalesMount = cashSalesMount;
}
