// 國泰官網實查: the owner's own Cathay (Asia Miles) award calendar, swept by tools/cathay-runner on their computer and
// kept on the server (lib/cxcal-store.js). When a route search renders, one call to our own /api/cxcal shows a card
// above the 國泰補查 badge with each cabin's lowest miles and open days, a 「看日曆」 toggle (the cxcal calendar), and
// buttons that manage the runner from the site: 加入國泰定時查詢 (the wanted list) and 請腳本現在查這條 (the on-demand
// queue, watched until the data arrives). A collapsed 國泰定時查詢 panel next to 機位提醒 lists the routes and whether
// the runner is online. Spends no paid quota: everything here is our own server. Loaded after cxcal.js (CXCAL.cxView).
if (typeof document !== 'undefined' && document.getElementById('search-results') && typeof CXCAL === 'object') {
  const CN = { Y: '經濟', W: '豪華經濟', J: '商務', F: '頭等' };
  const TTL = 5 * 60e3;
  const POLL_MS = 30e3;
  const POLL_MAX = 10 * 60e3;
  const codes = (s) => [...new Set(String(s || '').toUpperCase().split(/[,\s]+/).filter((c) => /^[A-Z]{3}$/.test(c)))];
  const key = (o, d) => `${o}>${d}`;
  const cache = new Map(); // "TPE,TSA|NRT" → { at, body }
  const st = { share: null, body: null, status: null, wanted: null, cal: new Set(), queued: new Map(), seq: 0 };
  const host = () => document.getElementById('cx-live');
  const hasPass = () => Boolean(store.get('cashPass', '')) || !cashCfg.locked;
  // Rows to show: the stored routes, else the searched pairs (so the buttons have a route to act on).
  const pairs = () => {
    if (!st.share) return [];
    const os = codes(st.share.get('o'));
    const ds = codes(st.share.get('d'));
    const out = [];
    for (const o of os) for (const d of ds) out.push({ fc: o, tc: d });
    return out.slice(0, 4);
  };
  const nameOf = (c) => (typeof airportCity === 'function' ? airportCity(c) : '') || '';
  const SRC = { unelevated: '來自國泰查票外掛（你自己的瀏覽器）', bookmarklet: '來自你的書籤', runner: '來自你的腳本' };

  // 外掛模式 (cxcal.js) records seats but no miles: the Asia Miles price of a Cathay itinerary ("TPE-HKG-NRT") on the
  // chart by summed sector distance, or 0 while the chart or the airport list (loaded on demand: cxEstReady) is missing.
  // Shown as 「約」.
  const estMemo = new Map();
  window.cxEst = function cxEst(c, p) {
    const k = `${c}|${p}`;
    if (estMemo.has(k)) return estMemo.get(k);
    const a = String(p || '').split('-');
    let dist = 0;
    for (let i = 1; i < a.length; i++) {
      const x = AP.byCode.get(a[i - 1]);
      const y = AP.byCode.get(a[i]);
      if (!x || !y || x.lat == null || y.lat == null) return 0;
      dist += haversineMiles(x, y);
    }
    const miles = (a.length > 1 && amPrice('cx', dist, c, a[0], a.at(-1))?.miles) || 0;
    if (data.asiamiles && AP.loaded) estMemo.set(k, miles);
    return miles;
  };
  window.cxEstReady = () => Promise.all([data.asiamiles || loadMore(), AP.loaded || loadAirports()]);
  const usesSeats = (routes) => (routes || []).some((r) => Object.values(r.days || {}).some((d) => Object.values(d.c || {}).some((x) => x.seats)));

  const ensureCss = () => {
    if (document.getElementById('cx-css')) return;
    const s = document.createElement('style');
    s.id = 'cx-css';
    s.textContent = CXCAL.cxCss();
    document.head.append(s);
  };

  // Per-cabin stats of a stored route: days in its swept range (else from today) with seats, and the lowest miles.
  function stats(r) {
    const today = isoDate(0);
    const from = r.range?.from || today;
    const to = r.range?.to || '9999';
    const ds = Object.keys(r.days || {}).filter((d) => d >= from && d <= to && d >= today).sort();
    const cabins = r.cabins?.length ? r.cabins : 'YWJF'.split('').filter((c) => ds.some((d) => r.days[d].c?.[c]));
    return { total: ds.length, cabins: cabins.map((c) => {
      const seen = ds.filter((d) => r.days[d].c?.[c]);
      const open = seen.filter((d) => !r.days[d].c[c].na && r.days[d].c[c].seats !== 0);
      const ms = open.map((d) => r.days[d].c[c].m).filter(Boolean);
      // Seat counts without miles (外掛模式): the most seats on one day and the 「約」 price of the cheapest itinerary.
      const seats = Math.max(0, ...open.map((d) => r.days[d].c[c].seats || 0));
      let est = 0;
      if (seats && !ms.length) {
        const paths = new Set(open.flatMap((d) => (r.days[d].c[c].f || []).map((f) => f.p)));
        if (!paths.size) paths.add(`${r.fc}-${r.tc}`);
        const es = [...paths].map((p) => window.cxEst(c, p)).filter(Boolean);
        est = es.length ? Math.min(...es) : 0;
      }
      return { c, seen: seen.length, open: open.length, min: ms.length ? Math.min(...ms) : 0, seats, est };
    }).filter((x) => x.seen) };
  }

  const wantedHas = (fc, tc) => Boolean(st.wanted?.some((w) => w.fc === fc && w.tc === tc));
  function buttonsHtml(fc, tc, label) {
    const s = st.status;
    const q = st.queued.get(key(fc, tc));
    const tag = label ? `<span class="cx-live-pair">${esc(fc)}→${esc(tc)}</span>` : '';
    const want = st.wanted ? (wantedHas(fc, tc) ? '已在清單，移除' : '加入國泰定時查詢') : '加入國泰定時查詢';
    let run;
    if (q?.done) run = '<span class="hint">腳本查好了</span>';
    else if (q) run = `<span class="hint cx-live-wait">已排入，腳本${s?.status === 'running' && s.route === `${fc}→${tc}` ? '正在查' : '收到後就會查'}…</span>`;
    else if (s?.status === 'needs-user' && s.route === `${fc}→${tc}`) run = '<span class="hint">腳本在等你在電腦上手動搜尋這條</span>';
    else if (s && !s.online) run = `<button type="button" class="outline" disabled title="${esc(s.lastSeen ? `最後上線 ${ago(s.lastSeen)}` : '腳本還沒連線過')}">腳本離線（電腦沒開或腳本沒在執行）</button>`;
    else run = `<button type="button" class="outline" data-cx-queue="${esc(key(fc, tc))}">請腳本現在查這條（約 5 分鐘）</button>`;
    return `<span class="cx-live-btns">${tag}<button type="button" class="outline" data-cx-want="${esc(key(fc, tc))}">${want}</button>${run}</span>`;
  }

  function cardHtml(r) {
    const k = key(r.fc, r.tc);
    const { total, cabins } = stats(r);
    const LB = { Y: '經', W: '豪', J: '商', F: '頭' };
    const parts = cabins.map((x) => (x.seats && !x.min
      ? `<span class="cx-seat" title="${esc(`${CN[x.c]}：單日最多 ${x.seats >= 9 ? '9 位以上' : `${x.seats} 位`}`)}"><b>${LB[x.c]}</b> ${x.c}${x.seats}</span>${x.est ? `約 <b>${fmt(x.est)}</b> 哩起` : CN[x.c]}（${x.open}/${total} 天有位）`
      : `${CN[x.c]}${x.min ? `最低 <b>${fmt(x.min)}</b> 哩` : ''}（${x.open}/${total} 天有位${x.min ? '' : '，哩數要點進日期才看得到'}）`));
    const when = r.savedAt ? ago(r.savedAt) : '';
    const old = r.savedAt && Date.now() - Date.parse(r.savedAt) > 2 * 86400e3;
    const un = r.source === 'unelevated';
    const from = un ? nameOf(r.fc) || r.fc : r.from || r.fc;
    const to = un ? nameOf(r.tc) || r.tc : r.to || r.tc;
    return `<section class="cx-live-card" data-route="${esc(k)}">
      <div class="cx-live-head"><span class="cx-tag">國泰官網實查</span><b>${esc(from)} → ${esc(to)}</b><small>${esc(r.fc)}→${esc(r.tc)}</small>${when ? `<span class="hint">${SRC[r.source] || SRC.runner}・${esc(when)}${old ? '（有點舊了）' : ''}</span>` : ''}</div>
      <p class="cx-live-sum">${parts.length ? parts.join('、') : '沒有讀到任何艙等的資料'}</p>
      <div class="cx-live-actions"><button type="button" class="linklike" data-cx-cal="${esc(k)}">${st.cal.has(k) ? '收起日曆' : '看日曆'}</button>${buttonsHtml(r.fc, r.tc, false)}</div>
      <div class="cxp cx-live-cal" ${st.cal.has(k) ? '' : 'hidden'}></div>
      <p class="hint cx-live-note">來自站長自己在國泰官網（亞洲萬里通）的查詢結果，不是即時資料，機位隨時會變；開票前請到國泰官網確認。${cabins.some((x) => x.est) ? '「約」是依亞洲萬里通國泰航班獎勵表與飛行距離估算，每人單程，未含稅金與附加費；9 表示 9 位以上。' : ''}</p>
    </section>`;
  }

  function html() {
    if (!st.share) return '';
    const routes = st.body?.routes || [];
    if (routes.length) {
      const seen = new Set(routes.map((r) => key(r.fc, r.tc)));
      const rest = pairs().filter((p) => !seen.has(key(p.fc, p.tc)));
      return routes.map(cardHtml).join('') + (rest.length && (st.status?.seen || hasPass()) ? `<div class="cx-live-line"><span class="hint">其他機場還沒有資料：</span>${rest.map((p) => buttonsHtml(p.fc, p.tc, true)).join('')}</div>` : '');
    }
    // Nothing stored: offer the runner's buttons only to someone who uses it (the runner has been seen, routes are
    // listed, or the passcode is on this device).
    if (!st.body || !(st.status?.seen || st.status?.wanted || hasPass())) return '';
    const ps = pairs();
    return `<div class="cx-live-line"><span class="cx-tag">國泰官網實查</span><span class="hint">還沒有這條航線的資料。</span>${ps.map((p) => buttonsHtml(p.fc, p.tc, ps.length > 1)).join('')}</div>`;
  }

  function draw() {
    const el = host();
    if (!el) return;
    el.innerHTML = html();
    ensureCss();
    for (const sec of el.querySelectorAll('.cx-live-card')) {
      const k = sec.dataset.route;
      if (!st.cal.has(k)) continue;
      const r = (st.body?.routes || []).find((x) => key(x.fc, x.tc) === k);
      const box = sec.querySelector('.cx-live-cal');
      if (r && box) { const ks = Object.keys(r.days).filter((d) => r.days[d].c).sort(); CXCAL.cxView(box, r, { ym: '', sel: ks[0] || '', est: window.cxEst }); }
    }
  }

  // Hook: renderSearch asks cxfill's cxBadgeHtml for the badge; we put our card right above it, and redraw it from
  // state on every render (cabin switches re-render).
  const badge = window.cxBadgeHtml;
  window.cxBadgeHtml = (c) => `<div id="cx-live">${html()}</div>${typeof badge === 'function' ? badge(c) : ''}`;

  async function fetchStatus() {
    try { st.status = await api('/api/cxcal/status'); } catch { st.status = null; }
    return st.status;
  }
  async function fetchRoutes(share) {
    const o = share.get('o');
    const d = share.get('d');
    const k = `${o}|${d}`;
    const hit = cache.get(k);
    if (hit && Date.now() - hit.at < TTL) return hit.body;
    const body = await api(`/api/cxcal?origin=${encodeURIComponent(o)}&destination=${encodeURIComponent(d)}`);
    cache.set(k, { at: Date.now(), body });
    return body;
  }
  async function fetchWanted() {
    if (!hasPass()) return null;
    try { st.wanted = (await cashApi('/api/cxcal/wanted')).routes || []; } catch { st.wanted = null; }
    return st.wanted;
  }

  document.addEventListener('search:start', () => { st.seq++; st.share = null; st.body = null; st.cal.clear(); });
  document.addEventListener('search:done', async (e) => {
    const n = ++st.seq;
    st.share = new URLSearchParams(e.detail.share);
    if (!codes(st.share.get('o')).length || !codes(st.share.get('d')).length) return;
    try {
      const [body] = await Promise.all([fetchRoutes(st.share), st.status ? null : fetchStatus()]);
      if (n !== st.seq) return;
      st.body = body;
      draw();
      if (usesSeats(body.routes) && !(data.asiamiles && AP.loaded)) window.cxEstReady().then(() => { if (n === st.seq) draw(); }, () => {});
      if (html() && st.wanted == null && hasPass()) { await fetchWanted(); if (n === st.seq) draw(); }
    } catch { /* the card is optional */ }
  });

  // ---------- buttons ----------
  const results = document.getElementById('search-results');
  results.addEventListener('click', async (e) => {
    const cal = e.target.closest('[data-cx-cal]');
    if (cal) { const k = cal.dataset.cxCal; if (st.cal.has(k)) st.cal.delete(k); else st.cal.add(k); draw(); return; }
    const want = e.target.closest('[data-cx-want]');
    if (want) { await toggleWanted(...want.dataset.cxWant.split('>'), want); return; }
    const run = e.target.closest('[data-cx-queue]');
    if (run) await enqueue(...run.dataset.cxQueue.split('>'), run);
  });

  async function toggleWanted(fc, tc, btn) {
    const done = busy(btn, '…');
    try {
      if (st.wanted == null) await fetchWanted();
      const remove = wantedHas(fc, tc);
      const body = await cashApi('/api/cxcal/wanted', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: remove ? 'remove' : 'add', fc, tc, from: nameOf(fc), to: nameOf(tc), cabins: ['Y', 'J'], pax: Math.min(9, Math.max(1, Number(st.share?.get('n')) || 1)) }) });
      st.wanted = body.routes || [];
      toast(remove ? `已從國泰定時查詢清單移除 ${fc}→${tc}` : `已加入國泰定時查詢：${fc}→${tc}（腳本每天會查一次）`);
      panelShow();
      if (panel.open) loadPanel();
    } catch (err) { toast(err.message); }
    done();
    draw();
  }

  async function enqueue(fc, tc, btn) {
    const done = busy(btn, '排入中…');
    const k = key(fc, tc);
    try {
      await cashApi('/api/cxcal/queue', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fc, tc }) });
      st.queued.set(k, { at: Date.now(), done: false });
      toast('已排入，腳本收到後會開始查（約 5 分鐘）');
      draw();
      watchQueue(fc, tc);
    } catch (err) { toast(err.message); done(); }
  }

  // Until the runner's upload lands (or 10 minutes pass): refresh the status and the route every 30 s.
  async function watchQueue(fc, tc) {
    const k = key(fc, tc);
    const q = st.queued.get(k);
    const share = st.share;
    while (q && !q.done && Date.now() - q.at < POLL_MAX) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (st.share !== share) return;
      await fetchStatus();
      try {
        const body = await api(`/api/cxcal?origin=${fc}&destination=${tc}`);
        const r = body.found && (body.routes || []).find((x) => x.fc === fc && x.tc === tc);
        if (r && Date.parse(r.savedAt) >= q.at - 60e3) {
          q.done = true;
          cache.clear();
          st.body = await fetchRoutes(share);
          toast(`腳本查好了：${fc}→${tc}`);
        }
      } catch { /* keep polling */ }
      if (!q.done && st.status && !st.status.online) toast('腳本看起來離線了，排入的查詢要等它回來才會跑');
      draw();
    }
    if (q && !q.done) { st.queued.delete(k); draw(); }
  }

  // ---------- 國泰定時查詢 panel, next to 機位提醒 ----------
  const anchor = document.getElementById('alerts-panel');
  anchor.insertAdjacentHTML('afterend', `<details class="alerts-panel" id="cxw-panel" hidden>
    <summary>🛫 國泰定時查詢 <span id="cxw-count"></span></summary>
    <div id="cxw-body" class="alerts-body"><p class="hint">載入中…</p></div>
  </details>`);
  const panel = document.getElementById('cxw-panel');
  const panelShow = () => { panel.hidden = false; };
  panel.addEventListener('toggle', () => { if (panel.open) loadPanel(); });

  const statusText = (s) => {
    if (!s) return '腳本狀態讀不到';
    if (!s.seen) return '腳本還沒連線過：請在自己的電腦安裝並執行 tools/cathay-runner（見 README）。';
    const online = s.online ? (s.status === 'running' ? `線上，正在查 ${s.route}` : s.status === 'needs-user' ? `線上，等你在電腦上手動搜尋 ${s.route}` : s.status === 'login' ? '線上，等你在電腦上登入國泰' : s.status === 'blocked' ? '線上，但國泰擋住了（已停下來）' : '線上，閒置') : `離線（最後上線 ${ago(s.lastSeen)}）`;
    return `腳本：${online}${s.lastRun ? `・上次查完 ${ago(s.lastRun)}` : ''}${s.queueLength ? `・排隊中 ${s.queueLength} 條` : ''}`;
  };
  async function loadPanel() {
    const box = document.getElementById('cxw-body');
    box.innerHTML = '<p class="hint">載入中…</p>';
    const [s] = await Promise.all([fetchStatus(), fetchWanted()]);
    const list = st.wanted || [];
    document.getElementById('cxw-count').textContent = list.length ? `（${list.length}）` : '';
    box.innerHTML = `<p class="cxw-status${s?.online ? ' on' : ''}">${esc(statusText(s))}</p>${s?.lastSummary ? `<p class="hint">${esc(s.lastSummary)}</p>` : ''}
      ${st.wanted == null ? '<p class="hint">要看或改清單需要通關密碼：按下面的「重新載入」輸入。</p>' : list.length ? `<ul class="alert-list cxw-list">${list.map((w) => `<li><div><b>${esc(w.from || w.fc)} → ${esc(w.to || w.tc)}</b><small>${esc(w.fc)}→${esc(w.tc)}・${(w.cabins || []).map((c) => CN[c]).join('、')}・${w.pax || 1} 位</small></div>
        <div class="alert-actions"><button type="button" class="outline" data-cxw-open="${esc(w.fc)}|${esc(w.tc)}">查看</button><button type="button" class="outline" data-cxw-del="${esc(w.fc)}|${esc(w.tc)}">移除</button></div></li>`).join('')}</ul>` : '<p class="hint">清單是空的。搜尋一條航線後，在結果上方按「加入國泰定時查詢」。</p>'}
      <div class="alert-foot"><button type="button" class="outline" id="cxw-reload">重新載入</button><span class="hint">腳本在你自己的電腦上每天查一輪清單裡的航線（最多 3 條，60 天），結果會顯示在該航線的查詢結果上方。</span></div>`;
    box.querySelector('#cxw-reload').addEventListener('click', () => { st.wanted = null; if (cashCfg.locked && !store.get('cashPass', '')) cashCfg.locked = true; loadPanel(); });
    for (const b of box.querySelectorAll('[data-cxw-open]')) b.addEventListener('click', () => { const [o, d] = b.dataset.cxwOpen.split('|'); const p = new URLSearchParams({ o, d, c: 'Y' }); applyShare(p); });
    for (const b of box.querySelectorAll('[data-cxw-del]')) b.addEventListener('click', async () => {
      const [fc, tc] = b.dataset.cxwDel.split('|');
      try { st.wanted = (await cashApi('/api/cxcal/wanted', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'remove', fc, tc }) })).routes || []; toast('已移除'); loadPanel(); draw(); } catch (err) { toast(err.message); }
    });
  }
  // The panel appears only for someone who uses the runner (seen, routes listed, or the passcode on this device).
  fetchStatus().then((s) => { if (s?.seen || s?.wanted || hasPass()) panelShow(); });

  // The bookmarklet's export landing (cxcal.js): save the calendar to the server too, so the route search shows it.
  // A v2 export (外掛模式) holds several routes: each is posted on its own. A route over the server's 64 KB cap keeps
  // fewer flights per cabin (the seat counts stay).
  const fitRoute = (body) => {
    for (const cap of [20, 10, 5, 2, 0]) {
      const days = {};
      for (const [k, v] of Object.entries(body.days)) {
        if (!v.c) { days[k] = v; continue; }
        days[k] = { ...v, c: Object.fromEntries(Object.entries(v.c).map(([c, x]) => [c, x.f ? { ...x, f: x.f.slice(0, cap) } : x])) };
      }
      const out = { ...body, days };
      if (new TextEncoder().encode(JSON.stringify(out)).length < 60000) return out;
    }
    return body;
  };
  window.cxLiveSave = function cxLiveSave(hintEl, d) {
    if (d?.routes) {
      if (!hintEl || !hasPass()) return;
      const list = d.routes.filter((r) => r.fc && r.tc);
      if (!list.length) return;
      hintEl.querySelector('#cx-save')?.remove();
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'outline';
      b.id = 'cx-save';
      b.textContent = `儲存到網站（${list.length} 條航線，查這些航線時顯示）`;
      b.addEventListener('click', async () => {
        const done = busy(b, '儲存中…');
        const ok = [];
        const bad = [];
        for (const r of list) {
          try {
            const body = fitRoute({ v: 1, from: nameOf(r.fc) || r.from, to: nameOf(r.tc) || r.to, fc: r.fc, tc: r.tc, at: d.at || Date.now(), days: r.days, source: d.source === 'unelevated' ? 'unelevated' : 'bookmarklet' });
            const x = await cashApi('/api/cxcal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
            ok.push(`${x.fc}→${x.tc}（${x.days} 天）`);
          } catch (err) { bad.push(`${r.fc}→${r.tc}：${err.message}`); }
        }
        cache.clear();
        toast([ok.length ? `已儲存 ${ok.join('、')}` : '', bad.join('；')].filter(Boolean).join('；'));
        done();
      });
      hintEl.append(' ', b);
      return;
    }
    if (!hintEl || !d?.fc || !d?.tc || !hasPass()) return;
    hintEl.querySelector('#cx-save')?.remove();
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'outline';
    b.id = 'cx-save';
    b.textContent = '儲存到網站（查這條航線時顯示）';
    b.addEventListener('click', async () => {
      const done = busy(b, '儲存中…');
      try {
        const r = await cashApi('/api/cxcal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ v: 1, from: d.from, to: d.to, fc: d.fc, tc: d.tc, at: d.at || Date.now(), days: d.days, source: 'bookmarklet' }) });
        cache.clear();
        toast(`已儲存 ${r.fc}→${r.tc}（${r.days} 天）`);
      } catch (err) { toast(err.message); }
      done();
    });
    hintEl.append(' ', b);
  };
}
