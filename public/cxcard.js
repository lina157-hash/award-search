// 國泰／亞洲萬里通: one card in the route results for everything about Cathay and Asia Miles, instead of four blocks
// that each repeated the Asia Miles numbers. One line per cabin: the lowest Asia Miles price (seats.aero's real Asia
// Miles rows, else the chart's 「約」 from app.js's estimate rows and cxauto's all-Cathay itineraries) and the days with
// Cathay seats. Under the lines, 國泰官網實查 (cxlive.js) when the owner saved some. Then the actions, each opening one
// panel inside the card: 看日曆 (cxauto.js), 補查 (cxfill.js), 經香港轉機 (cxfill.js; its 2 seats.aero calls run only on
// the button inside, which says so) and, for the owner only, 🤖 請 AI 助理查官網 (cxmuse.js). Spends nothing itself.
// Loaded last of app.js's SEARCH_SCRIPTS; renderSearch asks it for the card through cxBadgeHtml.

// ---------- pure logic (test/cxcard.test.js) ----------
const CXC_CABINS = ['Y', 'W', 'J', 'F'];

// results: the page's rows (asiamiles = real, asiamiles_est = the chart estimate); routes: cxAutoRoutes(…).
// → [{ c, price: { miles, real, date, origin, destination, airlines, via? } | null, days }] for the cabins with
// anything. via 'HKG': an estimate priced through Hong Kong (app.js amCxDist).
// The lowest price wins; at the same price a real Asia Miles one. days = dates with Cathay seats on any airport pair.
function cxCardRows(results, routes, pax = 0) {
  return CXC_CABINS.map((c) => {
    let price = null;
    const take = (miles, real, date, origin, destination, airlines, via) => {
      if (miles && (!price || miles < price.miles || (miles === price.miles && real && !price.real))) price = { miles, real, date, origin, destination, airlines: airlines || '', ...(via ? { via } : {}) };
    };
    for (const r of results || []) {
      const x = r.cabins?.[c];
      if (!x?.available || !x.miles) continue;
      if (r.source === 'asiamiles' && !r.estimate && cxSeatsOk(x.seats, pax)) take(x.miles, true, r.date, r.origin, r.destination, x.airlines);
      else if (r.source === 'asiamiles_est') take(x.miles, false, r.date, r.origin, r.destination, x.airlines, x.via);
    }
    const days = new Set();
    for (const rt of routes || []) {
      for (const [iso, day] of Object.entries(rt.days || {})) {
        const cell = day.c?.[c];
        if (!cell) continue;
        days.add(iso);
        if (cell.est) take(cell.est, false, iso, rt.fc, rt.tc, 'CX', cell.estVia);
      }
    }
    return { c, price, days: days.size };
  }).filter((x) => x.price || x.days);
}

// ---------- page ----------
if (typeof document !== 'undefined' && document.getElementById('search-results')) {
  const CN = { Y: '經濟', W: '豪華經濟', J: '商務', F: '頭等' };
  const cc = { open: '' }; // the open panel: '', 'cal', 'fill', 'hkg' or 'ai'
  // Owner: the passcode on this device or an account unlocked with it (as 今日好康's 立即更新 and 帳號管理).
  const ownerHere = () => Boolean(store.get(PASS_KEY, '') || (typeof acct === 'object' && acct.status?.unlocked) || !cashCfg.locked);
  const parts = () => ({ auto: window.cxAutoPart, fill: window.cxFillPart, hkg: window.cxHkgPart, muse: window.cxMusePart, live: window.cxLivePart });

  function actions(c) {
    const p = parts();
    const out = [];
    if (p.auto?.keys().length) out.push(['cal', '看日曆']);
    const fill = p.fill?.info(c);
    if (fill) out.push(['fill', `補查 ${fill.days} 天`]);
    if (p.hkg?.offered()) out.push(['hkg', '經香港轉機']);
    if (p.muse?.available() && ownerHere()) out.push(['ai', '🤖 請 AI 助理查官網']);
    return out;
  }
  function panelHtml(k, c) {
    const p = parts();
    if (k === 'cal') return p.auto?.html() || '';
    if (k === 'fill') return p.fill?.html(c) || '';
    if (k === 'hkg') return p.hkg?.offered() ? `<div id="cxc-hkg">${p.hkg.html()}</div>` : '';
    if (k === 'ai') return ownerHere() ? p.muse?.html() || '' : '';
    return '';
  }

  // 「商務  約 58,000 哩起  國泰有位 6/15 天  11/20 TPE→HKG・國泰」: the price is a real Asia Miles one unless 「約」.
  // On phones the where-and-when shows on the chosen cabin's line only.
  function rowHtml(x, cur, total) {
    const pr = x.price;
    return `<li class="cxc-row${x.c === cur ? ' cur' : ''}"><span class="cxc-cab">${CN[x.c]}</span>`
      + `<span class="cxc-p">${pr ? `${pr.real ? '' : '約 '}<b>${fmt(pr.miles)}</b> 哩起` : ''}</span>`
      + `<span class="cxc-d">${x.days ? `國泰有位 <b>${x.days}</b>/${total} 天` : ''}</span>`
      + `${pr ? `<small class="cxc-w">${mmdd(pr.date)} ${esc(pr.origin)}→${esc(pr.destination)}${pr.airlines ? `・${carriersHtml(pr.airlines)}` : ''}${pr.real ? '・實際有位' : ''}${pr.via ? `・${AM_VIA_TEXT}` : ''}</small>` : ''}</li>`;
  }

  function cardHtml(c) {
    const p = parts();
    const rows = cxCardRows(state.results, p.auto?.routes() || [], state.pax);
    const live = p.live?.html() || '';
    const acts = actions(c);
    if (!rows.length && !live && !acts.length) return '';
    if (!acts.some(([k]) => k === cc.open)) cc.open = '';
    const panel = cc.open ? panelHtml(cc.open, c) : '';
    if (!panel) cc.open = '';
    const total = p.auto?.total() || (state.start && state.end ? dayCount(state.start, state.end) : 0);
    return `<section class="cxc" id="cxc-card" aria-label="國泰／亞洲萬里通">
      <div class="cxc-head"><b>國泰／亞洲萬里通</b>${rows.length ? '<small>每人單程、未含稅；「約」依<a href="#rules" data-goto="rules">哩數表</a>估算，以國泰官網為準</small>' : live ? '' : '<small class="cxc-none">這次的日期沒有查到國泰航班或亞洲萬里通的座位</small>'}</div>
      ${rows.length ? `<ul class="cxc-rows">${rows.map((x) => rowHtml(x, c, total)).join('')}</ul>` : ''}
      <div id="cx-live">${live}</div>
      ${acts.length ? `<div class="cxc-acts">${acts.map(([k, label]) => `<button type="button" class="cxc-act${k === 'ai' ? ' cxc-ai' : ''}" data-cxc="${k}" aria-expanded="${k === cc.open}" aria-controls="cxc-panel">${esc(label)}</button>`).join('')}</div>` : ''}
      <div class="cxc-panel" id="cxc-panel"${panel ? '' : ' hidden'}>${panel}</div>
    </section>`;
  }

  // What needs the card on the page: the open calendars (cxlive's, and cxauto's in the 看日曆 panel), the AI panel's.
  function afterPanel(panel) {
    const p = parts();
    if (!panel) return;
    if (cc.open === 'cal') p.auto?.after(panel);
    else if (cc.open === 'ai') p.muse?.after(panel);
  }
  function after(card) {
    if (!card) return;
    parts().live?.after();
    afterPanel(card.querySelector('.cxc-panel'));
  }

  // Hook from renderSearch (it draws the card where the Asia Miles callouts were).
  window.cxBadgeHtml = (c) => {
    const h = cardHtml(c);
    if (h) queueMicrotask(() => after(document.getElementById('cxc-card')));
    return h;
  };
  // Something arrived later (官網實查, the 經香港轉機 offer) or the passcode changed: draw the card again in place.
  window.cxCardRedraw = () => {
    const old = document.getElementById('cxc-card');
    if (!old && !document.getElementById('am-host')) return; // no results on the page
    const focus = old?.contains(document.activeElement) ? document.activeElement.closest('[data-cxc]')?.dataset.cxc : '';
    const h = cardHtml(state.cabin);
    if (old) { if (h) old.outerHTML = h; else old.remove(); } else if (h) document.getElementById('am-host').insertAdjacentHTML('afterend', h);
    const card = document.getElementById('cxc-card');
    after(card);
    if (focus) card?.querySelector(`[data-cxc="${focus}"]`)?.focus({ preventScroll: true });
  };

  document.addEventListener('search:start', () => { cc.open = ''; });
  // Open `k`'s panel in the card ('' closes it), with each action's aria-expanded to match.
  function showPanel(card, k) {
    cc.open = k;
    const panel = card.querySelector('.cxc-panel');
    const html = cc.open ? panelHtml(cc.open, state.cabin) : '';
    if (!html) cc.open = '';
    for (const x of card.querySelectorAll('[data-cxc]')) x.setAttribute('aria-expanded', String(x.dataset.cxc === cc.open));
    panel.innerHTML = html;
    panel.hidden = !html;
    afterPanel(panel);
  }
  document.getElementById('search-results').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cxc]');
    if (!b) return;
    showPanel(b.closest('#cxc-card'), cc.open === b.dataset.cxc ? '' : b.dataset.cxc);
  });
  // Escape inside the card closes the open panel and puts focus back on the button that opened it.
  document.getElementById('search-results').addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || !cc.open) return;
    const card = e.target.closest?.('#cxc-card');
    if (!card) return;
    const btn = card.querySelector(`[data-cxc="${cc.open}"]`);
    e.preventDefault();
    showPanel(card, '');
    btn?.focus();
  });
}

if (typeof module === 'object' && module.exports) module.exports = { cxCardRows };
