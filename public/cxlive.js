// 國泰官網實查: the owner's own Cathay (Asia Miles) award calendar, saved from the 國泰哩程日曆 bookmarklet and kept on
// the server (lib/cxcal-store.js). When a route search renders, one call to our own /api/cxcal shows a block in the
// 國泰／亞洲萬里通 card with each cabin's lowest miles and open days and a 「看日曆」 toggle (the cxcal calendar). Calendars of
// the other airlines saved by 「請 AI 助理查官網」 (cxmuse.js) show the same way as 「<航空>官網實查」, one card per
// airline and route, named from cxmuse.js's templates (museTemplates) and coloured by its museTint. Spends no paid
// quota: everything here is our own server. Loaded after cxcal.js (CXCAL.cxView).
if (typeof document !== 'undefined' && document.getElementById('search-results') && typeof CXCAL === 'object') {
  const CN = { Y: '經濟', W: '豪華經濟', J: '商務', F: '頭等' };
  const TTL = 5 * 60e3;
  const codes = (s) => [...new Set(String(s || '').toUpperCase().split(/[,\s]+/).filter((c) => /^[A-Z]{3}$/.test(c)))];
  // A card per airline and route: Cathay keeps the old "TPE>NRT", the others "ci:TPE>NRT".
  const key = (r) => `${r.air && r.air !== 'cx' ? `${r.air}:` : ''}${r.fc}>${r.tc}`;
  let tpls = [];
  const tplOf = (air) => tpls.find((a) => a.id === (air || 'cx'));
  const cache = new Map(); // "TPE,TSA|NRT" → { at, body }
  const st = { share: null, body: null, cal: new Set(), seq: 0, view: new Map() };
  const host = () => document.getElementById('cx-live');
  const hasPass = () => Boolean(store.get('cashPass', '')) || !cashCfg.locked;
  const nameOf = (c) => (typeof airportCity === 'function' ? airportCity(c) : '') || '';
  const SRC = { unelevated: '來自國泰查票外掛（你自己的瀏覽器）', bookmarklet: '來自你的書籤', ai: '來自你的 AI 助理' };

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

  function cardHtml(r) {
    const k = key(r);
    const { total, cabins } = stats(r);
    const cx = !r.air || r.air === 'cx';
    const t = tplOf(r.air);
    const name = cx ? '國泰' : t?.label || t?.name || String(r.air).toUpperCase();
    const waits = cx ? 0 : Object.keys(r.days || {}).filter((d) => d >= isoDate(0) && Object.values(r.days[d].c || {}).some((x) => x.st === 'w')).length;
    const LB = { Y: '經', W: '豪', J: '商', F: '頭' };
    const parts = cabins.map((x) => (x.seats && !x.min
      ? `<span class="cx-seat" title="${esc(`${CN[x.c]}：單日最多 ${x.seats >= 9 ? '9 位以上' : `${x.seats} 位`}`)}"><b>${LB[x.c]}</b> ${x.c}${x.seats}</span>${x.est ? `約 <b>${fmt(x.est)}</b> 哩起` : CN[x.c]}（${x.open}/${total} 天有位）`
      : `${CN[x.c]}${x.min ? `最低 <b>${fmt(x.min)}</b> 哩` : ''}（${x.open}/${total} 天有位${x.min || !cx ? '' : '，哩數要點進日期才看得到'}）`));
    if (waits) parts.push(`候補 ${waits} 天`);
    const when = r.savedAt ? ago(r.savedAt) : '';
    const old = r.savedAt && Date.now() - Date.parse(r.savedAt) > 2 * 86400e3;
    const un = r.source === 'unelevated';
    const from = un ? nameOf(r.fc) || r.fc : r.from || r.fc;
    const to = un ? nameOf(r.tc) || r.tc : r.to || r.tc;
    return `<section class="cx-live-card" data-route="${esc(k)}">
      <div class="cx-live-head"><span class="cx-tag">${esc(name)}${/[A-Za-z]$/.test(name) ? ' ' : ''}官網實查</span><b>${esc(from)} → ${esc(to)}</b><small>${esc(r.fc)}→${esc(r.tc)}</small>${when ? `<span class="hint">${SRC[r.source] || SRC.bookmarklet}・${esc(when)}${old ? '（有點舊了）' : ''}</span>` : ''}</div>
      <p class="cx-live-sum">${parts.length ? parts.join('、') : '沒有讀到任何艙等的資料'}</p>
      <div class="cx-live-actions"><button type="button" class="linklike" data-cx-cal="${esc(k)}">${st.cal.has(k) ? '收起日曆' : '看日曆'}</button></div>
      <div class="cxp cx-live-cal" ${st.cal.has(k) ? '' : 'hidden'}></div>${st.cal.has(k) && r.source === 'ai' && typeof museHasLevels === 'function' && museHasLevels(r) ? museLegendHtml(r) : ''}
      <p class="hint cx-live-note">${cx ? '來自站長自己在國泰官網（亞洲萬里通）的查詢結果，不是即時資料，機位隨時會變；開票前請到國泰官網確認。' : `來自站長的 AI 助理在${esc(t?.site || '航空公司官網')}查到的結果，不是即時資料，機位隨時會變；開票前請到官網確認。`}${cabins.some((x) => x.est) ? '「約」是依亞洲萬里通國泰航班獎勵表與飛行距離估算，每人單程，未含稅金與附加費；9 表示 9 位以上。' : ''}</p>
    </section>`;
  }

  function html() {
    return st.share ? (st.body?.routes || []).map(cardHtml).join('') : '';
  }

  function draw() {
    const el = host();
    if (!el) { if (html()) window.cxCardRedraw?.(); return; }
    el.innerHTML = html();
    ensureCss();
    for (const sec of el.querySelectorAll('.cx-live-card')) {
      const k = sec.dataset.route;
      if (!st.cal.has(k)) continue;
      const r = (st.body?.routes || []).find((x) => key(x) === k);
      const box = sec.querySelector('.cx-live-cal');
      if (!r || !box) continue;
      const ks = Object.keys(r.days).filter((d) => r.days[d].c).sort();
      const vs = { ym: '', sel: ks[0] || '', est: window.cxEst };
      st.view.set(k, vs);
      CXCAL.cxView(box, r, vs);
      tint(box, r, vs);
    }
  }
  // The AI assistant's days: status colours and its words for the chosen day (cxmuse.js).
  const tint = (box, r, vs) => { if (r.source === 'ai' && typeof museTint === 'function') museTint(box, r, vs); };

  // The 國泰／亞洲萬里通 card (cxcard.js) holds the #cx-live box under its cabin lines and asks for it on every render
  // (cabin switches re-render); with no card on the page yet (nothing else to say), the card is drawn for this.
  window.cxLivePart = { html, after: () => draw() };

  async function fetchRoutes(share) {
    const o = share.get('o');
    const d = share.get('d');
    const k = `${o}|${d}`;
    const hit = cache.get(k);
    if (hit && Date.now() - hit.at < TTL) return hit.body;
    // After a save on this page, `v` asks past the CDN's one-minute copy.
    const body = await api(`/api/cxcal?origin=${encodeURIComponent(o)}&destination=${encodeURIComponent(d)}${savedAt ? `&v=${savedAt}` : ''}`);
    cache.set(k, { at: Date.now(), body });
    return body;
  }
  let savedAt = 0;
  const saved = () => { cache.clear(); savedAt = Date.now(); };
  document.addEventListener('cxcal:saved', saved); // cxmuse.js saved a route
  document.addEventListener('search:start', () => { st.seq++; st.share = null; st.body = null; st.cal.clear(); });
  onSearchDone(async (e) => {
    const n = ++st.seq;
    st.share = new URLSearchParams(e.detail.share);
    if (!codes(st.share.get('o')).length || !codes(st.share.get('d')).length) return;
    try {
      const body = await fetchRoutes(st.share);
      if (n !== st.seq) return;
      if ((body.routes || []).some((r) => r.air && r.air !== 'cx') && !tpls.length && typeof museTemplates === 'function') tpls = await museTemplates().catch(() => []);
      if (n !== st.seq) return;
      st.body = body;
      draw();
      if (usesSeats(body.routes) && !(data.asiamiles && AP.loaded)) window.cxEstReady().then(() => { if (n === st.seq) draw(); }, () => {});
    } catch { /* the card is optional */ }
  });

  const results = document.getElementById('search-results');
  results.addEventListener('click', (e) => {
    const cal = e.target.closest('[data-cx-cal]');
    if (cal) { const k = cal.dataset.cxCal; if (st.cal.has(k)) st.cal.delete(k); else st.cal.add(k); draw(); return; }
    // A day or a month arrow: cxView has already redrawn the calendar (the clicked button is detached).
    const path = e.composedPath();
    const sec = path.find((el) => el.classList?.contains('cx-live-card') && el.dataset.route);
    if (sec && path.some((el) => el.classList?.contains('cx-live-cal'))) {
      const r = (st.body?.routes || []).find((x) => key(x) === sec.dataset.route);
      if (r) tint(sec.querySelector('.cx-live-cal'), r, st.view.get(sec.dataset.route));
    }
  });

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
        saved();
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
        saved();
        toast(`已儲存 ${r.fc}→${r.tc}（${r.days} 天）`);
      } catch (err) { toast(err.message); }
      done();
    });
    hintEl.append(' ', b);
  };
}
