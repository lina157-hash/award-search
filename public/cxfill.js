// 國泰補查: Cathay seats that seats.aero's Asia Miles data misses (it covers mostly a few Hong Kong routes).
// 1) 補查, an action of the 國泰／亞洲萬里通 card (cxcard.js): Cathay seats under partner programs (Qantas, Alaska,
//    American…) on days the Asia Miles column has none. Cathay usually releases the same saver space to partners and its
//    own members, so this is an estimate, labelled as one. No extra calls.
// 2) 經香港轉機, also in the card: on a click only, two CX-only searches (origin→HKG, HKG→destination), paired by date
//    and priced on the Asia Miles chart by total flown distance. Uses 2 seats.aero calls (fewer when the caches answer).
// Loaded after features.js; uses the shared globals (data, state, api, amPrice, srcName, searchQuery, applyShare, AP…).

// ---------- pure logic (the tests run these with the real charts) ----------
const CX_HUB = 'HKG';
const CX_PARTNERS_FALLBACK = ['alaska', 'american', 'qantas'];
const cxCodes = (s) => String(s || '').split(/[,\s]+/).filter(Boolean);
const cxHas = (x) => cxCodes(x?.airlines).includes('CX');
const cxOnly = (x) => { const c = cxCodes(x?.airlines); return c.length > 0 && c.every((a) => a === 'CX'); };
// Seat counts of 0/null mean "unknown" (same rule as the results table).
const cxSeatsOk = (seats, pax) => !pax || !(seats > 0) || seats >= pax;
const cxNextDay = (iso) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };

// Programs other than Asia Miles that sell Cathay seats, from data/airlines.json (bookableVia).
function cxPartnerSources(airlines) {
  const cx = (airlines || []).find((a) => a.code === 'CX');
  return (cx?.bookableVia || CX_PARTNERS_FALLBACK).filter((s) => s !== 'asiamiles');
}

// Days where a partner program shows Cathay seats and Asia Miles shows none (same date, route and cabin).
// → { days, dates, sources (most days first), est: { miles, band, dist, origin, destination } | null } or null.
function cxBadgeInfo(results, cabin, partners, pax = 0) {
  const amDays = new Set();
  const hits = new Map();
  for (const r of results) {
    const x = r.cabins?.[cabin];
    if (!x?.available || r.estimate || !cxSeatsOk(x.seats, pax)) continue;
    const k = `${r.date}|${r.origin}|${r.destination}`;
    if (r.source === 'asiamiles') amDays.add(k);
    else if (partners.includes(r.source) && cxHas(x)) {
      if (!hits.has(k)) hits.set(k, []);
      hits.get(k).push(r);
    }
  }
  const dates = new Set();
  const perSource = new Map();
  let est = null;
  for (const [k, rows] of hits) {
    if (amDays.has(k)) continue;
    dates.add(rows[0].date);
    for (const r of rows) {
      perSource.set(r.source, (perSource.get(r.source) || 0) + 1);
      // Priced on Cathay's own chart only when the whole itinerary is Cathay, by the distance Asia Miles counts
      // (through Hong Kong unless nonstop, app.js amCxDist).
      if (!cxOnly(r.cabins[cabin]) || !r.distance) continue;
      const route = amCxDist(r.origin, r.destination, r.distance, r.cabins[cabin].direct);
      const p = route && amPrice('cx', route.dist, cabin, r.origin, r.destination);
      if (p?.miles && (!est || p.miles < est.miles)) est = { miles: p.miles, band: p.band, dist: route.dist, origin: r.origin, destination: r.destination, ...(route.via ? { via: route.via } : {}) };
    }
  }
  if (!dates.size) return null;
  const sources = [...perSource].sort((a, b) => b[1] - a[1] || partners.indexOf(a[0]) - partners.indexOf(b[0])).map(([s]) => s);
  return { days: dates.size, dates: [...dates].sort(), sources, est };
}

// One leg's Cathay-only seats by date: Map date → [{ id, source, miles, seats, distance, origin, destination }],
// Asia Miles' own rows first, then the cheapest.
function cxLegDays(results, cabin, pax = 0) {
  const out = new Map();
  for (const r of results) {
    const x = r.cabins?.[cabin];
    if (!x?.available || r.estimate || !cxOnly(x) || !cxSeatsOk(x.seats, pax)) continue;
    if (!out.has(r.date)) out.set(r.date, []);
    out.get(r.date).push({ id: r.id, source: r.source, miles: x.miles, seats: x.seats || null, distance: r.distance || 0, origin: r.origin, destination: r.destination });
  }
  for (const list of out.values()) list.sort((a, b) => (b.source === 'asiamiles') - (a.source === 'asiamiles') || a.miles - b.miles);
  return out;
}

// Leg 2 leaves the same day as leg 1 or the next day (same day preferred). Sorted by date.
function cxPair(leg1, leg2) {
  const out = [];
  for (const date of [...leg1.keys()].sort()) {
    const next = cxNextDay(date);
    const date2 = leg2.has(date) ? date : leg2.has(next) ? next : null;
    if (date2) out.push({ date, date2, next: date2 !== date, a: leg1.get(date), b: leg2.get(date2) });
  }
  return out;
}

// Asia Miles prices a Cathay-only itinerary by the sum of its sector distances; the band's short-haul type 2 depends on
// the journey's two ends. → { miles, band, dist } (miles null when the chart has no price).
function cxStitchPrice(dist1, dist2, cabin, origin, destination) {
  const dist = (dist1 || 0) + (dist2 || 0);
  const p = dist1 && dist2 ? amPrice('cx', dist, cabin, origin, destination) : null;
  return { miles: p?.miles || null, band: p?.band || null, dist };
}

// Offer the Hong Kong stitch when neither end is in or right next to Hong Kong and going through it is not a big detour.
// o, d: share-link airport lists ("TPE,TSA"); apOf(code) → { lat, lon } or null (unknown airports don't block it).
function cxStitchOffer(o, d, apOf) {
  const os = cxCodes(o);
  const ds = cxCodes(d);
  if (!os.length || !ds.length || [...os, ...ds].includes(CX_HUB)) return false;
  const a = apOf(os[0]);
  const b = apOf(ds[0]);
  const h = apOf(CX_HUB);
  if (!a || !b || !h || a.lat == null || b.lat == null) return true;
  const ah = haversineMiles(a, h);
  const hb = haversineMiles(h, b);
  if (ah < 120 || hb < 120) return false;
  return ah + hb <= haversineMiles(a, b) * 2 + 300;
}

// ---------- page ----------
// Both show inside the 「國泰／亞洲萬里通」 card (cxcard.js): 補查 and 經香港轉機 are two of its actions.
if (typeof document !== 'undefined' && document.getElementById('search-results')) {
  // A page the site's own data links to (data/programs.json officialUrl); the redeem button is on it.
  const cxUrl = () => data.programs?.programs?.find((p) => p.id === 'asiamiles')?.officialUrl || 'https://www.cathaypacific.com/cx/zh_TW/membership/asia-miles.html';
  const cxShort = (s) => srcName(s).split(' ')[0];
  const cxBandName = (band) => (data.asiamiles?.bands.find((b) => band && band.startsWith(b.id)) || {}).name || '';
  const apOf = (code) => AP.byCode.get(code) || null;

  // 補查: the card's action says how many days; its panel holds the explanation and the 只看國泰航班 search.
  window.cxFillPart = {
    info: (c) => cxBadgeInfo(state.results, c, cxPartnerSources(data.airlines?.airlines), state.pax),
    html(c) {
      const info = this.info(c);
      if (!info) return '';
      const share = tabParams('search');
      const names = info.sources.slice(0, 2).map(cxShort).join('、') + (info.sources.length > 2 ? '等' : '');
      const shown = info.dates.slice(0, 10).map(mmdd).join('、') + (info.dates.length > 10 ? ` 等 ${info.dates.length} 天` : '');
      const onlyCx = (share.get('a') || '').toUpperCase() === 'CX';
      return `<div class="cx-more">
        <p><b>${CABIN_LABEL[c]}國泰有位 ${info.days} 天</b>（亞洲萬里通欄沒有位的日子，由${esc(names)}欄推估）：${shown}</p>
        <p>國泰通常把同樣的獎勵位同時開給夥伴計畫和自家會員，所以${esc(info.sources.map(srcName).join('、'))} 查得到的國泰座位，亞洲萬里通多半也訂得到；這是推估，不保證有位，請到國泰官網確認。</p>
        ${info.est ? `<p class="hint">這幾天約 ${fmt(info.est.miles)} 哩：國泰航班標準獎勵表，${esc(info.est.origin)}–${esc(info.est.destination)} ${info.est.via ? `${AM_VIA_TEXT} ` : ''}${fmt(info.est.dist)} 哩（${esc(cxBandName(info.est.band))}），每人單程，未含稅金與附加費。</p>` : '<p class="hint">這幾天的座位含其他航空的航段，亞洲萬里通哩數無法用國泰航班表估算。</p>'}
        <div class="cx-actions"><a class="cx-link" href="${esc(cxUrl())}" target="_blank" rel="noopener">到國泰官網查飛行獎勵 ↗</a>${onlyCx ? '' : '<button type="button" class="outline" data-cx-only>只看國泰航班・重新搜尋（用 1 次查詢）</button>'}</div>
      </div>`;
    },
  };
  const results = $('#search-results');
  results.addEventListener('click', (e) => {
    if (!e.target.closest('[data-cx-only]')) return;
    const share = tabParams('search');
    share.set('a', 'CX');
    share.delete('al');
    applyShare(share);
  });

  // ---------- 經香港轉機 (the card's action opens it; the two searches run only on the button inside) ----------
  const st = { share: null, legs: null, busy: false, all: false };
  const legCache = new Map(); // same URLs as normal searches, so the server and browser caches answer repeats
  let stSeq = 0;
  const legShare = (share, o, d) => {
    const s = new URLSearchParams(share);
    s.set('o', o);
    s.set('d', d);
    s.set('a', 'CX');
    s.delete('al');
    s.delete('direct');
    return normalizeShare(s);
  };

  window.cxHkgPart = { offered: () => Boolean(st.share), html: () => stitchHtml() };
  document.addEventListener('search:start', () => { stSeq++; Object.assign(st, { share: null, legs: null, busy: false, all: false }); });
  document.addEventListener('search:done', (e) => {
    const share = new URLSearchParams(e.detail.share);
    if (!cxStitchOffer(share.get('o'), share.get('d'), apOf)) return;
    st.share = share;
    window.cxCardRedraw?.();
  });
  results.addEventListener('click', (e) => {
    if (e.target.closest('#cx-run')) run();
    else if (e.target.closest('#cx-all')) { st.all = true; render(); }
  });

  async function run() {
    if (st.busy || !st.share) return;
    const share = st.share;
    const n = stSeq;
    st.busy = true;
    render();
    const urls = [legShare(share, share.get('o'), CX_HUB), legShare(share, CX_HUB, share.get('d'))].map((s) => `/api/search?${searchQuery(s)}`);
    try {
      const legs = await Promise.all(urls.map((url) => {
        if (!legCache.has(url)) legCache.set(url, api(url).catch((err) => { legCache.delete(url); throw err; }));
        return legCache.get(url);
      }));
      if (n !== stSeq) return;
      st.legs = legs.map((b) => b.results || []);
    } catch (err) {
      if (n !== stSeq) return;
      toast(err.message || '查詢失敗，請稍後再試');
    }
    st.busy = false;
    render();
  }

  const legCell = (list, prefix = '') => {
    const best = list[0];
    const more = list.slice(1).map((x) => cxShort(x.source));
    return `${prefix}${esc(srcName(best.source))} <b>${fmt(best.miles)}</b>${best.seats ? `・${best.seats} 位` : ''}${more.length ? `<small>另有 ${esc([...new Set(more)].join('、'))}</small>` : ''}`;
  };

  // Redraw the open panel in place (the card redraws it from stitchHtml() on a cabin switch: all cabins came back).
  function render() {
    const el = document.getElementById('cxc-hkg');
    if (el) el.innerHTML = stitchHtml();
  }
  function stitchHtml() {
    if (!st.share) return '';
    const o = st.share.get('o');
    const d = st.share.get('d');
    const route = (x) => esc(cxCodes(x).join('/'));
    if (!st.legs) {
      const days = dayCount(st.share.get('s'), st.share.get('e') || st.share.get('s'));
      return `<div class="pos-box cx-box">
        <button type="button" class="outline" id="cx-run" ${st.busy ? 'disabled' : ''}>${st.busy ? '查詢中…' : '✈ 查經香港轉機的國泰座位（用 2 次查詢）'}</button>
        <span class="hint">分開查 ${route(o)}→HKG 和 HKG→${route(d)} 的國泰航班，再依日期配對${days > 150 ? '；日期範圍很長時每段可能多用 1 次' : ''}</span></div>`;
    }
    const c = state.cabin;
    const pax = state.pax;
    const [l1, l2] = st.legs.map((rows) => cxLegDays(rows, c, pax));
    const pairs = cxPair(l1, l2);
    const head = `<p class="cx-head"><b>經香港轉機的國泰座位</b> <small>${route(o)} → 香港 → ${route(d)}，${CABIN_LABEL[c]}；第二段限當天或隔天出發</small></p>`;
    if (!pairs.length) {
      const why = !l1.size && !l2.size ? '兩段都沒有找到國泰座位'
        : !l1.size ? `${route(o)}→香港沒有國泰座位（香港→${route(d)} 有 ${l2.size} 天）`
          : !l2.size ? `香港→${route(d)} 沒有國泰座位（${route(o)}→香港 有 ${l1.size} 天）`
            : '兩段都有國泰座位，但日期接不上（第二段要在當天或隔天）';
      return `<section class="cx-out">${head}<p class="cx-empty">這段日期${why}。可以在上面切換艙等（不用再查）、拉長日期範圍，或過幾天再查。</p></section>`;
    }
    const prices = pairs.map((p) => cxStitchPrice(p.a[0].distance, p.b[0].distance, c, p.a[0].origin, p.b[0].destination));
    const vals = prices.map((p) => p.miles).filter(Boolean);
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const p0 = prices[0];
    const total = vals.length
      ? `<p class="cx-total">亞洲萬里通整趟估計 <b>${lo === hi ? fmt(lo) : `${fmt(lo)}–${fmt(hi)}`} 哩</b><small>每人單程，國泰航班標準獎勵表依兩段距離相加：${fmt(pairs[0].a[0].distance)}＋${fmt(pairs[0].b[0].distance)}＝${fmt(p0.dist)} 哩（${esc(cxBandName(p0.band))}），未含稅金與附加費</small></p>`
      : '<p class="cx-total">亞洲萬里通哩數無法估計（缺少航段距離）。</p>';
    const shown = st.all ? pairs : pairs.slice(0, 10);
    return `<section class="cx-out">${head}${total}
      <div class="table-wrap"><table class="need-table cx-table"><thead><tr><th>出發</th><th>${route(o)}→HKG</th><th>HKG→${route(d)}</th></tr></thead><tbody>
        ${shown.map((p) => `<tr><td>${mmdd(p.date)}<small>週${dowOf(p.date)}</small></td><td>${legCell(p.a)}</td><td>${legCell(p.b, p.next ? `<span class="cx-next">隔天 ${mmdd(p.date2)}</span>` : '')}</td></tr>`).join('')}
      </tbody></table></div>
      ${pairs.length > shown.length ? `<button type="button" class="linklike" id="cx-all">再顯示 ${pairs.length - shown.length} 天</button>` : ''}
      <p class="hint cx-note">估計：只配對了日期，沒有檢查實際轉機時間，兩段航班不一定接得上；座位來自夥伴計畫的是推估亞洲萬里通也有位。訂位前請到<a href="${esc(cxUrl())}" target="_blank" rel="noopener">國泰官網</a>或打電話確認，並訂成同一張票。</p>
    </section>`;
  }
}

if (typeof module === 'object' && module.exports) module.exports = { cxPartnerSources, cxBadgeInfo, cxLegDays, cxPair, cxStitchPrice, cxStitchOffer };
