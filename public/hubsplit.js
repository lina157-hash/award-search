// 拆兩段查：經樞紐轉機 (round 9): under route results with seats on few days, alliance hubs where the alliance's airlines
// fly both legs nonstop (data/rtw-routes.json for oneworld and Star Alliance, data/skyteam-routes.json for SkyTeam; the
// hubs, each with its official source, in data/split-hubs.json). A hub's button searches origin→hub and hub→destination
// through /api/search (2 seats.aero calls; the server and browser caches answer repeats) and pairs the legs by date like
// cxfill.js's 經香港轉機: the second leg the same day or the next. Two tickets, so the totals are two awards added up.
// Classic script after features.js (nonstopIndex, nonstopKey) and cxfill.js (cxNextDay, cxSeatsOk). Pure helpers first.

// ---------- pure helpers ----------
const SPLIT_SHOWN = 5; // hubs listed before 「再顯示」
const SPLIT_ROWS = 7; // paired days shown before 「再顯示」
const SPLIT_ALLIANCES = ['star', 'oneworld', 'skyteam'];
const SPLIT_AL_NAME = { star: '星空聯盟', oneworld: '寰宇一家', skyteam: '天合聯盟' };

// Days with seats in a cabin, estimates left out (seat counts as on the results page).
function splitSeatDays(results, cabin, pax = 0) {
  const days = new Set();
  for (const r of results || []) {
    const x = r.cabins?.[cabin];
    if (x?.available && !r.estimate && cxSeatsOk(x.seats, pax)) days.add(r.date);
  }
  return days.size;
}
// Few seats: none, or on at most one day in ten of the range.
const splitWanted = (seatDays, days) => seatDays <= Math.floor(days / 10);

// data/split-hubs.json → Map(alliance → Map(airport → [airlines whose hub it is])), airlines still in the alliance only.
function splitHubMap(hubData, alliances) {
  const out = new Map();
  for (const al of alliances || []) {
    const m = new Map();
    for (const a of hubData?.airlines || []) {
      if (!al.members.includes(a.code)) continue;
      for (const h of a.hubs) m.set(h, [...(m.get(h) || []), a.code]);
    }
    out.set(al.id, m);
  }
  return out;
}

// Hubs for a search from `origins` to `dests` (airport lists). hubs: splitHubMap(); members: { star: [...] };
// flies(a, b) → airline codes flying a–b nonstop; only: alliance ids to look at; carrier: the one airline the search is
// limited to, or ''; apOf(code) → { lat, lon } | null; cityOf(code) → the city group key (same-city airports merge).
// A hub stays when the alliance's airlines fly both legs and the detour is at most 40% + 300 miles over the nonstop
// distance. → [{ codes, via: [{ alliance, owners, leg1, leg2 }], dist1, dist2, total, extra }], shortest first.
function splitCandidates({ origins, dests, hubs, members, flies, only = SPLIT_ALLIANCES, carrier = '', apOf, cityOf = (c) => c }) {
  const ends = new Set([...origins, ...dests].map(cityOf));
  const o = apOf(origins[0]);
  const d = apOf(dests[0]);
  if (!o || !d) return [];
  const direct = haversineMiles(o, d);
  const legAir = (from, to, allowed) => {
    const set = new Set();
    for (const a of from) for (const b of to) for (const c of flies(a, b)) if (allowed.includes(c)) set.add(c);
    return [...set].sort();
  };
  const byCity = new Map();
  for (const id of only) {
    const allowed = carrier ? (members[id] || []).filter((c) => c === carrier) : members[id] || [];
    if (!allowed.length) continue;
    for (const [code, owners] of hubs.get(id) || []) {
      if (ends.has(cityOf(code))) continue;
      const leg1 = legAir(origins, [code], allowed);
      const leg2 = legAir([code], dests, allowed);
      if (!leg1.length || !leg2.length) continue;
      const key = cityOf(code);
      if (!byCity.has(key)) byCity.set(key, { codes: [], via: [] });
      const hub = byCity.get(key);
      if (!hub.codes.includes(code)) hub.codes.push(code);
      const v = hub.via.find((x) => x.alliance === id);
      if (v) {
        v.owners = [...new Set([...v.owners, ...owners])];
        v.leg1 = [...new Set([...v.leg1, ...leg1])].sort();
        v.leg2 = [...new Set([...v.leg2, ...leg2])].sort();
      } else hub.via.push({ alliance: id, owners: [...owners], leg1, leg2 });
    }
  }
  const out = [];
  for (const hub of byCity.values()) {
    const h = apOf(hub.codes[0]);
    if (!h) continue;
    const dist1 = haversineMiles(o, h);
    const dist2 = haversineMiles(h, d);
    const total = dist1 + dist2;
    if (dist1 < 100 || dist2 < 100 || total > direct * 1.4 + 300) continue;
    out.push({ ...hub, dist1, dist2, total, extra: direct ? Math.max(0, Math.round((total / direct - 1) * 100)) : 0 });
  }
  return out.sort((a, b) => a.total - b.total || a.codes[0].localeCompare(b.codes[0]));
}

// One leg's seats by date: Map date → [{ id, source, miles, seats, origin, destination, airlines, direct }], cheapest first.
function splitLegDays(results, cabin, pax = 0) {
  const out = new Map();
  for (const r of results || []) {
    const x = r.cabins?.[cabin];
    if (!x?.available || r.estimate || !(x.miles > 0) || !cxSeatsOk(x.seats, pax)) continue;
    if (!out.has(r.date)) out.set(r.date, []);
    out.get(r.date).push({ id: r.id, source: r.source, miles: x.miles, seats: x.seats || null, origin: r.origin, destination: r.destination, airlines: x.airlines || '', direct: Boolean(x.direct) });
  }
  for (const list of out.values()) list.sort((a, b) => a.miles - b.miles || a.source.localeCompare(b.source));
  return out;
}

// The cheapest two tickets from two lists (same program only when `source` is set): connecting at the same airport
// when any pair does, else at another airport of the hub city (swap). → { a, b, miles, swap } | null
function splitBest(as, bs, source = '') {
  let best = null;
  for (const a of as) {
    if (source && a.source !== source) continue;
    for (const b of bs) {
      if (source && b.source !== source) continue;
      const swap = a.destination !== b.origin;
      const miles = a.miles + b.miles;
      if (!best || (best.swap && !swap) || (best.swap === swap && miles < best.miles)) best = { a, b, miles, swap };
    }
  }
  return best;
}

// Leg 2 the same day as leg 1 or the next (same day first), sorted by date: [{ date, date2, next, a, b, miles, swap, la, lb }]
// with la / lb the day's whole lists (for 「另有」).
function splitPairs(leg1, leg2) {
  const out = [];
  for (const date of [...leg1.keys()].sort()) {
    for (const date2 of [date, cxNextDay(date)]) {
      const best = leg2.has(date2) && splitBest(leg1.get(date), leg2.get(date2));
      if (best) { out.push({ date, date2, next: date2 !== date, ...best, la: leg1.get(date), lb: leg2.get(date2) }); break; }
    }
  }
  return out;
}

// Per program, the cheapest paired days with both tickets on it (it may book them as one ticket; its own rules decide):
// [{ source, date, date2, next, a, b, miles, swap }], cheapest first.
function splitByProgram(leg1, leg2) {
  const best = new Map();
  for (const date of [...leg1.keys()].sort()) {
    for (const date2 of [date, cxNextDay(date)]) {
      if (!leg2.has(date2)) continue;
      const sources = new Set(leg1.get(date).map((x) => x.source));
      for (const s of sources) {
        const b = splitBest(leg1.get(date), leg2.get(date2), s);
        const cur = best.get(s);
        if (b && (!cur || (cur.swap && !b.swap) || (cur.swap === b.swap && b.miles < cur.miles))) best.set(s, { source: s, date, date2, next: date2 !== date, ...b });
      }
    }
  }
  return [...best.values()].sort((x, y) => x.miles - y.miles || x.source.localeCompare(y.source));
}

// seats.aero calls of the two searches: one page per 150 days each, as server.js handleSearch.
const splitCalls = (start, end) => 2 * (1 + Math.floor(Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 864e5) / 150));
const splitCostText = (n) => (n > 2 ? `最多用 ${n} 次查詢` : '用 2 次查詢');

// ---------- page ----------
if (typeof document !== 'undefined' && document.getElementById('search-results')) {
  $('#search-results').insertAdjacentHTML('afterend', '<div id="search-split"></div>');
  const host = $('#search-split');
  // Per search: the share it ran with, the hubs (null until worked out), and each run hub's legs by its first code.
  const sp = { share: null, cands: null, open: false, all: false, runs: new Map(), visa: new Map() };
  const legCache = new Map(); // same URLs as normal searches, so the caches answer repeats
  let seq = 0;
  let base = null; // { hubs, members, flies, sources, routeMeta }
  let baseP = null;

  const loadBase = () => (baseP ||= Promise.all([api('/api/data/splithubs'), api('/api/data/rtwroutes'), loadAirports()]).then(([sh, rr]) => {
    const rtw = nonstopIndex(rr);
    const sky = nonstopIndex(sh.skyteam);
    const alliances = data.alliances?.alliances || [];
    base = {
      hubs: splitHubMap(sh.hubs, alliances),
      members: Object.fromEntries(alliances.map((a) => [a.id, a.members])),
      flies: (a, b) => [...(rtw.pairs.get(nonstopKey(a, b)) || []), ...(sky.pairs.get(nonstopKey(a, b)) || [])],
      hubData: sh.hubs,
      routeMeta: [rr, sh.skyteam].map((x) => ({ source: x.source, note: x.note })),
    };
  }).catch((err) => { baseP = null; throw err; }));

  const codesOf = (s) => String(s || '').toUpperCase().split(/[,\s]+/).filter(Boolean);
  const groupOf = new Map();
  const cityOf = (c) => {
    if (!groupOf.size) for (const g of AP.groups) for (const x of g.codes) groupOf.set(x, g.zh);
    return groupOf.get(c) || c;
  };
  const apOf = (c) => AP.byCode.get(c) || null;
  const hubName = (codes) => { const g = cityOf(codes[0]); return g !== codes[0] ? g : airportCity(codes[0]) || codes[0]; };
  const route = (codes) => esc(codes.join('/'));

  document.addEventListener('search:start', () => {
    seq++;
    Object.assign(sp, { share: null, cands: null, all: false });
    sp.runs.clear();
    host.innerHTML = '';
  });

  // Called by app.js renderSearch (a new search, a cabin switch, a filter): show the fold while seats are few, or once a
  // hub was searched.
  window.splitRender = function splitRender() {
    const share = tabParams('search');
    if (!share.get('o') || !share.get('d') || !state.start) { host.innerHTML = ''; return; }
    const wanted = sp.runs.size > 0 || splitWanted(splitSeatDays(state.results, state.cabin, state.pax), dayCount(state.start, state.end));
    if (!wanted) { host.innerHTML = ''; return; }
    if (!sp.share) sp.share = share;
    if (sp.cands) { draw(); return; }
    const n = seq;
    loadBase().then(() => {
      if (n !== seq) return;
      const al = sp.share.get('al');
      sp.cands = splitCandidates({
        origins: codesOf(sp.share.get('o')), dests: codesOf(sp.share.get('d')), hubs: base.hubs, members: base.members, flies: base.flies,
        only: al ? [al] : SPLIT_ALLIANCES, carrier: (sp.share.get('a') || '').toUpperCase(), apOf, cityOf,
      });
      draw();
    }).catch(() => {});
  };

  const legShare = (share, o, d) => {
    const s = new URLSearchParams(share);
    s.set('o', o);
    s.set('d', d);
    s.delete('direct');
    return normalizeShare(s);
  };

  async function run(key) {
    const hub = sp.cands?.find((h) => h.codes[0] === key);
    const cur = sp.runs.get(key);
    if (!hub || cur?.busy || cur?.legs) return;
    const share = sp.share;
    const n = seq;
    sp.runs.set(key, { busy: true });
    draw();
    const hubCodes = hub.codes.join(',');
    const urls = [legShare(share, share.get('o'), hubCodes), legShare(share, hubCodes, share.get('d'))].map((s) => `/api/search?${searchQuery(s)}`);
    try {
      const legs = await Promise.all(urls.map((url) => {
        if (!legCache.has(url)) legCache.set(url, api(url).catch((err) => { legCache.delete(url); throw err; }));
        return legCache.get(url);
      }));
      if (n !== seq) return;
      sp.runs.set(key, { legs: legs.map((b) => b.results || []), mock: legs.some((b) => b.mock), truncated: legs.some((b) => b.truncated) });
    } catch (err) {
      if (n !== seq) return;
      sp.runs.set(key, { err: err.message || '查詢失敗，請稍後再試' });
    }
    draw();
    const cc = apOf(hub.codes[0])?.country;
    if (cc && cc !== 'TW' && !sp.visa.has(cc)) {
      sp.visa.set(cc, null);
      // The visa line for a night at the hub (tripinfo.js; free, no quota).
      fetchHolidays(hub.codes[0], state.start, state.end).then((info) => {
        if (!info) { sp.visa.delete(cc); return; }
        sp.visa.set(cc, { visa: info.visa, src: info.sources?.visa });
        if (n === seq) draw();
      });
    }
  }

  function addPair(key, i) {
    const r = sp.runs.get(key);
    const p = r?.pairs?.[i];
    if (!p) return;
    const c = state.cabin;
    const leg = (x, date) => ({ k: 'a', date, from: x.origin, to: x.destination, flights: '', cabin: c, pax: state.pax || 1, miles: x.miles, program: x.source, tax: null, note: '拆兩段查' });
    addLegs([leg(p.a, p.date), leg(p.b, p.date2)]);
  }

  host.addEventListener('click', (e) => {
    const t = e.target;
    const go = t.closest('[data-split-run]');
    if (go) { run(go.dataset.splitRun); return; }
    if (t.closest('#split-all')) { sp.all = true; draw(); return; }
    const more = t.closest('[data-split-more]');
    if (more) { const r = sp.runs.get(more.dataset.splitMore); if (r) { r.all = true; draw(); } return; }
    const trip = t.closest('[data-split-trip]');
    if (trip) { openTrips(trip.dataset.splitTrip, trip.dataset.splitTitle, state.cabin); return; }
    const add = t.closest('[data-split-add]');
    if (add) { const [key, i] = add.dataset.splitAdd.split('|'); addPair(key, Number(i)); }
  });
  host.addEventListener('toggle', (e) => { if (e.target.id === 'split-fold') sp.open = e.target.open; }, true);

  const airNames = (list) => list.map((c) => esc(airlineZh(c))).join('、');
  function hubHead(h) {
    const o = codesOf(sp.share.get('o'));
    const d = codesOf(sp.share.get('d'));
    const via = h.via.map((v) => `<span class="split-al">${esc(SPLIT_AL_NAME[v.alliance])}・${airNames(v.owners)}樞紐</span>`).join('');
    const leg1 = [...new Set(h.via.flatMap((v) => v.leg1))];
    const leg2 = [...new Set(h.via.flatMap((v) => v.leg2))];
    const r = sp.runs.get(h.codes[0]);
    const calls = splitCalls(sp.share.get('s'), sp.share.get('e') || sp.share.get('s'));
    const label = `查 ${route(o)}→${route(h.codes)}＋${route(h.codes)}→${route(d)}`;
    const btn = r?.legs ? `<span class="split-done">✓ 已查兩段（最多用了 ${calls} 次查詢）</span>`
      : `<button type="button" class="outline" data-split-run="${esc(h.codes[0])}" ${r?.busy ? 'disabled' : ''}>${r?.busy ? '查詢中…' : `${label}（${splitCostText(calls)}）`}</button>`;
    const cxNote = h.codes.includes('HKG') && window.cxHkgPart?.offered?.() ? '<small>只看國泰、算成一張亞洲萬里通票：見上方國泰卡的「經香港轉機」</small>' : '';
    return `<div class="split-hub-head"><div class="split-hub-name"><b>經${esc(hubName(h.codes))} ${route(h.codes)}</b>${via}
      <small>${route(o)}→${route(h.codes)}：${airNames(leg1)}直飛・${route(h.codes)}→${route(d)}：${airNames(leg2)}直飛・${h.extra > 2 ? `繞路約 ${h.extra}%` : '幾乎不繞路'}</small>${cxNote}</div>
      <div class="split-act">${btn}${r?.err ? `<small class="error">${esc(r.err)}</small>` : ''}</div></div>`;
  }

  // `airports`: name the leg's airports (a city with several, where the row's own matter).
  const legCell = (x, list, airports, dateNote = '') => {
    const more = [...new Set(list.filter((y) => y !== x).map((y) => srcName(y.source).split(' ')[0]))];
    const bits = [airports ? `${esc(x.origin)}→${esc(x.destination)}` : '', x.airlines ? carriersHtml(x.airlines) : '', x.direct ? '直飛' : ''].filter(Boolean).join('・');
    return `${dateNote}${esc(srcName(x.source))} <b>${fmt(x.miles)}</b>${x.seats ? `・${x.seats} 位` : ''}<small>${bits}${more.length ? `<span class="split-also">${bits ? '・' : ''}另有 ${esc(more.slice(0, 3).join('、'))}${more.length > 3 ? '等' : ''}</span>` : ''}</small>`;
  };

  function hubOut(h) {
    const key = h.codes[0];
    const r = sp.runs.get(key);
    if (!r?.legs) return '';
    const c = state.cabin;
    const o = route(codesOf(sp.share.get('o')));
    const d = route(codesOf(sp.share.get('d')));
    const hc = route(h.codes);
    const city = esc(hubName(h.codes));
    const [l1, l2] = r.legs.map((rows) => splitLegDays(rows, c, state.pax));
    const pairs = splitPairs(l1, l2);
    r.pairs = pairs;
    const pax = state.pax > 1 ? `至少 ${state.pax} 位、` : '';
    const head = `<p class="cx-head"><b>${o} → ${city} → ${d}</b> <small>${CABIN_LABEL[c]}、${pax}第二段限當天或隔天出發${r.mock ? '（示範資料）' : ''}${r.truncated ? '；結果太多，只列出一部分' : ''}</small></p>`;
    if (!pairs.length) {
      const why = !l1.size && !l2.size ? '兩段都沒有找到獎勵位'
        : !l1.size ? `${o}→${hc} 沒有獎勵位（${hc}→${d} 有 ${l2.size} 天）`
          : !l2.size ? `${hc}→${d} 沒有獎勵位（${o}→${hc} 有 ${l1.size} 天）`
            : '兩段都有獎勵位，但日期接不上（第二段要在當天或隔天）';
      return `<section class="split-out">${head}<p class="cx-empty">這段日期${why}。可以切換上面的艙等（不用再查）、試別的轉機點，或拉長日期範圍。</p></section>`;
    }
    const low = pairs.reduce((m, p) => (p.miles < m.miles ? p : m), pairs[0]);
    const progs = splitByProgram(l1, l2).slice(0, 4);
    const shown = r.all ? pairs : pairs.slice(0, SPLIT_ROWS);
    const nights = pairs.some((p) => p.next);
    const multi1 = h.codes.length > 1 || codesOf(sp.share.get('o')).length > 1;
    const multi2 = h.codes.length > 1 || codesOf(sp.share.get('d')).length > 1;
    const v = sp.visa.get(apOf(key)?.country);
    const visaLabel = v?.visa && typeof VISA_TYPE === 'object' ? `${(VISA_TYPE[v.visa.type] || [v.visa.type])[0]}${v.visa.days ? ` ${v.visa.days} 天` : ''}` : '';
    const country = typeof countryZh === 'function' ? countryZh(apOf(key)?.country || '') : '';
    return `<section class="split-out">${head}
      <p class="cx-total">兩張票合計最低 <b>${fmt(low.miles)} 哩</b><small>每人單程、未含稅金：${mmdd(low.date)} ${esc(srcName(low.a.source))} ${fmt(low.a.miles)}＋${low.next ? '隔天 ' : ''}${mmdd(low.date2)} ${esc(srcName(low.b.source))} ${fmt(low.b.miles)}</small></p>
      ${progs.length ? `<p class="split-progs"><span>同一計畫兩段都有位：</span>${progs.map((p) => `<span class="split-prog">${esc(srcName(p.source))} <b>${fmt(p.miles)}</b><small>${fmt(p.a.miles)}＋${fmt(p.b.miles)}・${mmdd(p.date)}${p.next ? `→${mmdd(p.date2)}` : ''}</small></span>`).join('')}</p>
      <p class="hint">同一個計畫兩段都有位時，可以到該計畫官網試著訂成同一張轉機票；能不能合成一張、要多少哩依該計畫規則。</p>` : ''}
      <div class="table-wrap"><table class="need-table cx-table split-table"><thead><tr><th>出發</th><th>${o}→${hc}</th><th>${hc}→${d}</th><th>合計（每人）</th></tr></thead><tbody>
        ${shown.map((p, i) => `<tr><td>${mmdd(p.date)}<small>週${dowOf(p.date)}</small></td>
          <td data-l="${o}→${hc}">${legCell(p.a, p.la, multi1)}<button type="button" class="linklike" data-split-trip="${esc(p.a.id)}" data-split-title="${esc(`${dayLabel(p.date)} ${p.a.origin} → ${p.a.destination} · ${srcName(p.a.source)}`)}">看航班</button></td>
          <td data-l="${hc}→${d}">${legCell(p.b, p.lb, multi2, p.next ? `<span class="cx-next">隔天 ${mmdd(p.date2)}</span>` : '')}${p.swap ? `<span class="cx-next">換機場 ${esc(p.a.destination)}→${esc(p.b.origin)}</span>` : ''}<button type="button" class="linklike" data-split-trip="${esc(p.b.id)}" data-split-title="${esc(`${dayLabel(p.date2)} ${p.b.origin} → ${p.b.destination} · ${srcName(p.b.source)}`)}">看航班</button></td>
          <td><b>${fmt(p.miles)}</b><small>${p.next ? `在${city}過夜` : '當天轉機'}</small><button type="button" class="linklike" data-split-add="${esc(key)}|${i}">＋ 加入我的行程</button></td></tr>`).join('')}
      </tbody></table></div>
      ${pairs.length > shown.length ? `<button type="button" class="linklike" data-split-more="${esc(key)}">再顯示 ${pairs.length - shown.length} 天</button>` : ''}
      <ul class="hint split-notes">
        <li>當天轉機：先點「看航班」確認第一段抵達、第二段起飛的時間。兩張票可能要入境、領行李再重新報到，請自己留足轉機時間。</li>
        ${nights ? `<li>隔天出發要在${city}過夜${country && country !== apOf(key)?.country ? `、入境${esc(country)}` : ''}${visaLabel ? `：台灣護照${esc(visaLabel)}${v.visa.note ? `（${esc(v.visa.note)}）` : ''}，依${esc(v.src?.name || '外交部領事事務局')}整理，出發前請再到<a href="https://www.boca.gov.tw/" target="_blank" rel="noopener">領事事務局</a>確認` : '，要能入境當地'}。</li>` : ''}
        ${pairs.some((p) => p.swap) ? '<li>標「換機場」的組合要在同一個城市換到另一個機場搭第二段。</li>' : ''}
      </ul>
    </section>`;
  }

  function draw() {
    const cands = sp.cands;
    if (!sp.share || !cands?.length) { host.innerHTML = ''; return; }
    const shown = sp.all ? cands : cands.slice(0, SPLIT_SHOWN);
    const calls = splitCalls(sp.share.get('s'), sp.share.get('e') || sp.share.get('s'));
    const few = splitWanted(splitSeatDays(state.results, state.cabin, state.pax), dayCount(state.start, state.end));
    const srcs = [...new Map(base.hubData.airlines.map((a) => [a.source.url, a.source])).values()];
    host.innerHTML = `<details class="cal-fold split-fold" id="split-fold"${sp.open ? ' open' : ''}>
      <summary><h2 class="section-title">拆兩段查：經樞紐轉機 <small>${cands.length} 個轉機點・按了才查</small></h2></summary>
      <p class="hint">${few ? `這段${esc(CABIN_LABEL[state.cabin])}的獎勵位少。` : ''}可以拆成兩張票：先飛到聯盟航空公司的樞紐，再從樞紐飛目的地。seats.aero 依起訖點分開收錄座位，拆開查有時會找到整段查不到的位子。下面的轉機點兩段都有同聯盟航空公司直飛；每按一個轉機點${splitCostText(calls)}（每段 1 次${calls > 2 ? '，日期範圍很長時每段可能多用 1 次' : ''}），不按不查。</p>
      <p class="split-warn">⚠ 兩張票，前段延誤不保護；轉機時間請自己留足。</p>
      <ul class="split-hubs">${shown.map((h) => `<li class="split-hub">${hubHead(h)}${hubOut(h)}</li>`).join('')}</ul>
      ${cands.length > shown.length ? `<button type="button" class="linklike" id="split-all">再顯示 ${cands.length - shown.length} 個轉機點</button>` : ''}
      <details class="split-src"><summary>ⓘ 資料來源與限制</summary>
        <p>樞紐：各航空公司或聯盟官方頁面寫明的樞紐（${srcs.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a>`).join('、')}）。</p>
        <p>直飛紀錄：${base.routeMeta.map((m) => `<a href="${esc(m.source.url)}" target="_blank" rel="noopener">${esc(m.source.label)}</a>（${esc(m.source.licence)}，${esc(m.source.fetched)} 取得）`).filter((x, i, a) => a.indexOf(x) === i).join('、')}，第三方整理*：${esc(base.routeMeta[0].note)}</p>
        <p>查詢：每段和一般搜尋一樣用 1 次 seats.aero 查詢；30 分鐘內查過的航段由網站快取回答，不再用額度。切換艙等、看更多日期都不會再查。哩數是兩張票各自的價格相加。</p>
      </details>
    </details>`;
  }
}

if (typeof module === 'object' && module.exports) {
  module.exports = { splitSeatDays, splitWanted, splitHubMap, splitCandidates, splitLegDays, splitBest, splitPairs, splitByProgram, splitCalls, splitCostText };
}
