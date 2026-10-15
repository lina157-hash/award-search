// 國泰座位日曆（自動）: Cathay-operated seats the route search already loaded, one card per origin→destination pair.
// seats.aero shows Cathay under oneworld partners (Qantas, Alaska, American…) and, on a few routes, Asia Miles itself;
// each row lists the operating airlines per cabin. We sort those rows by day and cabin into the record cxcal.js's
// calendar (CXCAL.cxView) draws, with a one-line summary per cabin and a 「看日曆」 toggle. No extra calls: only the
// results of the current search. Loaded after cxlive.js; uses cxfill.js's helpers (cxPartnerSources, cxHas, cxOnly,
// cxSeatsOk) and app.js's amPrice for the 「約」 Asia Miles price.

// ---------- pure logic (test/cxauto.test.js runs these with the real chart) ----------
const CXA_CABINS = ['Y', 'W', 'J', 'F'];
const CXA_MAX = 3;

// results → [{ key, fc, tc, days: { iso: { c: { Y: cell } } } }] in first-seen order. A cell is the shape cxView reads
// ({ seats } = most seats on one program, 0 when no program says) plus { est, am, progs } for our own day detail:
// est = lowest Asia Miles chart price of an all-Cathay itinerary (0 if none), am = lowest real Asia Miles price (asiamiles
// rows), progs = [{ source, miles, seats, direct, only, airlines }] with Asia Miles first, then the cheapest.
function cxAutoRoutes(results, partners, pax = 0) {
  const srcs = new Set(['asiamiles', ...(partners || [])]);
  const routes = new Map();
  for (const r of results || []) {
    if (r.estimate || !srcs.has(r.source) || !r.date || !r.origin || !r.destination) continue;
    for (const c of CXA_CABINS) {
      const x = r.cabins?.[c];
      if (!x?.available || !cxHas(x) || !cxSeatsOk(x.seats, pax)) continue;
      const key = `${r.origin}>${r.destination}`;
      if (!routes.has(key)) routes.set(key, { key, fc: r.origin, tc: r.destination, days: {} });
      const day = (routes.get(key).days[r.date] ||= { c: {} });
      const cell = (day.c[c] ||= { seats: 0, nonstop: false, est: 0, am: 0, progs: [] });
      const only = cxOnly(x);
      const seats = x.seats > 0 ? x.seats : null;
      cell.progs.push({ source: r.source, miles: x.miles || null, seats, direct: Boolean(x.direct), only, airlines: x.airlines || '' });
      if (seats) cell.seats = Math.max(cell.seats, seats);
      cell.nonstop ||= Boolean(x.direct);
      // Priced on Cathay's own chart only when the whole itinerary is Cathay (same rule as the 國泰補查 badge).
      const est = only && r.distance ? amPrice('cx', r.distance, c, r.origin, r.destination)?.miles || 0 : 0;
      if (est && (!cell.est || est < cell.est)) cell.est = est;
      if (r.source === 'asiamiles' && x.miles && (!cell.am || x.miles < cell.am)) cell.am = x.miles;
    }
  }
  for (const rt of routes.values()) {
    for (const day of Object.values(rt.days)) {
      for (const cell of Object.values(day.c)) cell.progs.sort((a, b) => (b.source === 'asiamiles') - (a.source === 'asiamiles') || (a.miles || Infinity) - (b.miles || Infinity));
    }
  }
  return [...routes.values()];
}

// Per cabin: days with Cathay seats and the lowest price (a real Asia Miles price wins over the chart's 「約」).
// → [{ c, days, am, est }] for the cabins that have any day.
function cxAutoStats(route) {
  const days = Object.values(route.days || {});
  return CXA_CABINS.map((c) => {
    const cells = days.map((d) => d.c[c]).filter(Boolean);
    const low = (k) => Math.min(Infinity, ...cells.map((x) => x[k]).filter(Boolean));
    const am = low('am');
    const est = low('est');
    return { c, days: cells.length, am: am === Infinity ? 0 : am, est: est === Infinity ? 0 : est };
  }).filter((x) => x.days);
}

// Many airport pairs (e.g. TPE,TSA → NRT,HND): the pairs with the most Cathay days first, at most `max` cards.
function cxAutoPick(routes, max = CXA_MAX) {
  const n = (r) => Object.keys(r.days).length;
  const sorted = (routes || []).map((r, i) => [r, i]).sort((a, b) => n(b[0]) - n(a[0]) || a[1] - b[1]).map(([r]) => r);
  return { shown: sorted.slice(0, max), more: Math.max(0, sorted.length - max) };
}

// ---------- page ----------
if (typeof document !== 'undefined' && document.getElementById('search-results') && typeof CXCAL === 'object') {
  const CN = { Y: '經濟', W: '豪華經濟', J: '商務', F: '頭等' };
  const LB = { Y: '經', W: '豪', J: '商', F: '頭' };
  const st = { cal: new Set(), view: new Map() }; // open calendars, and each calendar's { ym, sel }
  let memo = { res: null, pax: null, routes: [] };
  const nameOf = (c) => (typeof airportCity === 'function' ? airportCity(c) : '') || c;
  const routesNow = () => {
    if (memo.res !== state.results || memo.pax !== state.pax) {
      memo = { res: state.results, pax: state.pax, routes: cxAutoRoutes(state.results, cxPartnerSources(data.airlines?.airlines), state.pax) };
    }
    return memo.routes;
  };
  // Days in the searched range ("18/30 天"), else the days the results cover.
  const totalDays = () => (state.start && state.end ? dayCount(state.start, state.end) : new Set(state.results.map((r) => r.date)).size);
  // The lower of a real Asia Miles price and the chart's 「約」 (an all-Cathay itinerary may price below a mixed one).
  const price = (x, b = (n) => `<b>${fmt(n)}</b>`) => (x.am && (!x.est || x.am <= x.est) ? `亞洲萬里通 ${b(x.am)} 哩起` : x.est ? `約 ${b(x.est)} 哩起` : '');

  const ensureCss = () => {
    if (document.getElementById('cx-css')) return;
    const s = document.createElement('style');
    s.id = 'cx-css';
    s.textContent = CXCAL.cxCss();
    document.head.append(s);
  };

  // The note is said once, on the last card.
  function cardHtml(r, i, list) {
    const total = totalDays();
    const stats = cxAutoStats(r);
    const sum = stats.map((x, i) => `<span class="cx-auto-c">${CN[x.c]} <b>${x.days}</b>/${total} 天${i ? '' : '有國泰位'}${price(x) ? `・${price(x)}` : ''}</span>`).join('；');
    const progs = [...new Set(Object.values(r.days).flatMap((d) => Object.values(d.c).flatMap((x) => x.progs.map((p) => p.source))))];
    const open = st.cal.has(r.key);
    return `<section class="cx-live-card cx-auto-card" data-cxa="${esc(r.key)}">
      <div class="cx-live-head"><span class="cx-tag">國泰座位日曆</span><b>${esc(nameOf(r.fc))} → ${esc(nameOf(r.tc))}</b><small>${esc(r.fc)}→${esc(r.tc)}</small><span class="hint">由${esc(progs.map((s) => (s === 'asiamiles' ? '亞洲萬里通' : srcName(s).split(' ')[0])).join('、'))}的資料自動整理</span></div>
      <p class="cx-live-sum">${sum}</p>
      <div class="cx-live-actions"><button type="button" class="linklike" data-cxa-cal="${esc(r.key)}" aria-expanded="${open}">${open ? '收起日曆' : '看日曆'}</button></div>
      <div class="cxp cx-live-cal" ${open ? '' : 'hidden'}></div>
      ${i < list.length - 1 ? '' : `<p class="hint cx-live-note">來自 seats.aero 上夥伴計畫查到的國泰航班：有位的日期通常也能用亞洲萬里通訂到，沒有位的日期國泰官網仍可能有位。只涵蓋這次查詢的日期；「約」依亞洲萬里通國泰航班獎勵表與距離估算，每人單程，未含稅金與附加費。</p>`}
    </section>`;
  }

  function cardsHtml() {
    const { shown, more } = cxAutoPick(routesNow());
    if (!shown.length) return '';
    return `<div id="cx-auto">${shown.map(cardHtml).join('')}${more ? `<p class="hint cx-auto-more">另有 ${more} 組機場也有國泰位，縮小出發或抵達機場就能看到。</p>` : ''}</div>`;
  }

  // cxView draws the grid; cells show seats per cabin (「商J2」) or 「有位」. Two touch-ups after each draw: a cabin no
  // program gives a seat count for, on a day another cabin has one, and the chosen day's detail (programs, their own
  // miles, the 「約」 Asia Miles price), which cxView would word for Cathay's own page.
  function touchUp(box, r, vs) {
    for (const b of box.querySelectorAll('.cx-d')) {
      const iso = `${vs.ym}-${String(b.querySelector('i')?.textContent || '').padStart(2, '0')}`;
      const day = r.days[iso];
      if (!day) continue;
      const cs = CXA_CABINS.filter((c) => day.c[c]);
      if (cs.some((c) => day.c[c].seats)) {
        for (const c of cs.filter((k) => !day.c[k].seats)) b.insertAdjacentHTML('beforeend', `<span class="cx-m"><b>${LB[c]}</b>有位</span>`);
      }
      b.title = cs.map((c) => `${CN[c]} ${day.c[c].seats ? `${day.c[c].seats} 位` : '有位'}`).join('、');
    }
    const det = box.querySelector('.cx-det');
    if (!det || !vs.sel) return;
    const day = r.days[vs.sel];
    const head = det.querySelector('.cx-dh')?.outerHTML || '';
    if (!day) {
      const inRange = (!state.start || vs.sel >= state.start) && (!state.end || vs.sel <= state.end);
      det.innerHTML = `${head}<p class="cx-mut">${inRange ? '這天夥伴計畫沒有查到國泰座位；國泰官網仍可能有位。' : '這天不在這次查詢的日期範圍內。'}</p>`;
      return;
    }
    det.innerHTML = head + CXA_CABINS.slice().reverse().filter((c) => day.c[c]).map((c) => {
      const x = day.c[c];
      const line = [x.seats ? `最多 ${x.seats} 位` : '', x.nonstop ? '有直飛' : '', price(x, fmt)].filter(Boolean).join('・');
      return `<div class="cx-ch">${CABIN_LABEL[c]}${line ? `・${line}` : ''}</div>${x.progs.map((p) => `<div class="cx-f"><span>${esc(srcName(p.source))}</span><b>${p.miles ? `${fmt(p.miles)} 哩` : ''}</b><small>${[p.direct ? '直飛' : '轉機', p.seats ? `剩 ${p.seats} 位` : '', p.only ? '' : `含其他航空：${esc(p.airlines)}`].filter(Boolean).join('・')}</small></div>`).join('')}`;
    }).join('');
  }

  function drawCal(sec) {
    const k = sec.dataset.cxa;
    const box = sec.querySelector('.cx-live-cal');
    const r = routesNow().find((x) => x.key === k);
    if (!box || !r || !st.cal.has(k)) return;
    ensureCss();
    if (!st.view.has(k)) st.view.set(k, { ym: '', sel: Object.keys(r.days).sort()[0] || '' });
    const vs = st.view.get(k);
    CXCAL.cxView(box, r, vs);
    touchUp(box, r, vs);
  }
  const drawOpen = () => { for (const sec of document.querySelectorAll('#cx-auto .cx-auto-card')) drawCal(sec); };

  // Hook: renderSearch asks for cxBadgeHtml (cxfill's badge, wrapped by cxlive's card). Our cards go after cxlive's
  // 國泰官網實查 card and before the one-line 國泰補查 badge; open calendars are drawn once the page holds them.
  const prev = window.cxBadgeHtml;
  window.cxBadgeHtml = (c) => {
    const s = typeof prev === 'function' ? prev(c) : '';
    const mine = cardsHtml();
    if (mine && st.cal.size) queueMicrotask(drawOpen);
    const i = s.indexOf('<details class="cx-badge"');
    return i < 0 ? s + mine : s.slice(0, i) + mine + s.slice(i);
  };

  document.addEventListener('search:start', () => { st.cal.clear(); st.view.clear(); });
  document.getElementById('search-results').addEventListener('click', (e) => {
    const t = e.target.closest('[data-cxa-cal]');
    if (t) {
      const k = t.dataset.cxaCal;
      const sec = t.closest('.cx-auto-card');
      const open = !st.cal.has(k);
      if (open) st.cal.add(k); else st.cal.delete(k);
      t.textContent = open ? '收起日曆' : '看日曆';
      t.setAttribute('aria-expanded', String(open));
      sec.querySelector('.cx-live-cal').hidden = !open;
      if (open) drawCal(sec);
      return;
    }
    // A click on a day or a month arrow: cxView has already redrawn the calendar (its own handler runs first).
    // The clicked button is already detached, so the card comes from the event's path.
    const path = e.composedPath();
    const sec = path.find((el) => el.classList?.contains('cx-auto-card'));
    if (sec && path.some((el) => el.classList?.contains('cx-live-cal'))) {
      const r = routesNow().find((x) => x.key === sec.dataset.cxa);
      if (r) touchUp(sec.querySelector('.cx-live-cal'), r, st.view.get(r.key));
    }
  });
}

if (typeof module === 'object' && module.exports) module.exports = { cxAutoRoutes, cxAutoStats, cxAutoPick };
