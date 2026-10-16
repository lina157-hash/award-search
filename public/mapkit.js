// 距離與地圖 (round 9): 可搭直飛 tags, 級距邊緣提醒 with the other Taiwan airports, 經過 route comparison in 哩程試算,
// 兌換地圖's layers (只看有直飛, distance-band rings, flight-time estimates, a sortable city list) and the band notes of
// 中停／開口組合. Loaded on demand after features.js (loadMapkit), with the nonstop data (features.js nonstopLoad).
// Shared globals: data, AP, nonstopCarriers, nonstopData, chartPrices, amRoutePrices, amPrice, haversineMiles, miKm,
// airlineZh, allianceCarriers, rmap, esc, fmt, CABIN_SHORT… The pure part comes first so tests can run it in a vm.
// Nothing here calls a paid API.

// ---------- which airlines a program and a chart can book ----------
// Short airline names for tags (「可搭直飛：長榮、星宇」); the rest use airlineZh.
const MK_SHORT = { BR: '長榮', CI: '華航', JX: '星宇', AE: '華信', CX: '國泰', JL: '日航', NH: '全日空', SQ: '新航', TG: '泰航', KE: '大韓', OZ: '韓亞', UA: '聯合', DL: '達美', AA: '美航', EK: '阿聯酋', EY: '阿提哈德', QR: '卡達', TK: '土航', MH: '馬航', VN: '越航', KL: '荷航', AF: '法航', LH: '漢莎', BA: '英航', AC: '加航', QF: '澳航', AY: '芬航', MU: '東航', CA: '國航' };
const mkAir = (c) => MK_SHORT[c] || airlineZh(c);
const mkAirs = (list) => list.map(mkAir).join('、');

// The programs.json record for a program or charts.json id (日航寰宇一家 → jal, 長榮 eva → evainfinity…).
function mkProgram(id) {
  const map = data.programs?.idMap || {};
  const pid = Object.keys(map).find((k) => k !== 'note' && map[k]?.charts === id) || (id === 'jal_partner' ? 'jal' : id);
  return data.programs?.programs?.find((p) => p.id === pid) || null;
}
const mkProgName = (p) => SOURCE_NAMES[p.id] || EXTRA_PROGRAM_NAMES[data.programs?.idMap?.[p.id]?.charts] || EXTRA_PROGRAM_NAMES[p.id] || p.name;
// Airlines a program's miles book: its own, its alliance, and every airline in airlines.json that lists it (bookableVia).
function mkBookable(p) {
  const set = new Set([p?.airline, ...(p?.alliance ? allianceCarriers(p.alliance) : [])].filter(Boolean));
  for (const a of data.airlines?.airlines || []) if (p && (a.bookableVia?.includes(p.id) || a.homeProgram === p.id)) set.add(a.code);
  return set;
}
// What each fixed chart prices, from its own wording (長榮航班, 星空聯盟夥伴航班, 寰宇一家…): the program's own
// flights ('own'; 華航's chart also has 華信), its partners ('partners') or both ('all').
const MK_CHART_SCOPE = { eva: 'own', ci: 'own', jal: 'own', jal_partner: 'all', etihad: 'all', ana: 'partners', singapore: 'partners', turkish: 'partners', aeroplan: 'partners', american: 'partners', alaska: 'partners', british: 'partners' };
const MK_OWN_EXTRA = { ci: ['AE'] };
// Airlines a program books whose price that chart does not give (charts.json etihad: 星宇計價未公布).
const MK_CHART_SKIP = { etihad: ['JX'] };
// Asia Miles has two rows: Cathay's own flights ('cx') and one oneworld partner flown alone ('partner').
function mkChartCarriers(id, kind) {
  const p = mkProgram(id === 'asiamiles_est' ? 'asiamiles' : id);
  if (id === 'asiamiles' || id === 'asiamiles_est') {
    if (kind === 'cx') return new Set(['CX']);
    const all = mkBookable(p);
    all.delete('CX');
    return all;
  }
  const own = [p?.airline, ...(MK_OWN_EXTRA[id] || [])].filter(Boolean);
  const scope = MK_CHART_SCOPE[id] || 'all';
  if (scope === 'own') return new Set(own);
  const all = mkBookable(p);
  if (scope === 'partners') for (const c of own) all.delete(c);
  for (const c of MK_CHART_SKIP[id] || []) all.delete(c);
  return all;
}

// ---------- 可搭直飛 (#25) ----------
// One priced row from a to b: the airlines on record flying it nonstop that the chart prices (direct) and the ones it
// does not (others). Cathay's row priced through Hong Kong (amCxDist) says so instead. null before the data loads.
function mkDirect(id, kind, a, b, via = '') {
  if (via) return { via };
  const list = nonstopCarriers(a, b);
  if (!list) return null;
  const can = mkChartCarriers(id, kind);
  return { direct: list.filter((c) => can.has(c)), others: list.filter((c) => !can.has(c)) };
}
function mkDirectTag(t) {
  if (!t) return '';
  if (t.via) return `<span class="mk-tag">經${t.via === 'HKG' ? '香港' : esc(t.via)}轉機計價</span>`;
  if (t.direct.length) return `<span class="mk-tag ok">可搭直飛：${esc(mkAirs(t.direct))}</span>`;
  return `<span class="mk-tag" ${t.others.length ? `title="${esc(`直飛的是${mkAirs(t.others)}，這個計畫不能搭`)}"` : ''}>需轉機${t.others.length ? `（直飛的${esc(mkAirs(t.others))}不能搭）` : ''}</span>`;
}

// ---------- 級距邊緣提醒 (#3) ----------
const MK_NEAR = 100; // miles from a band edge worth a line
const MK_FINE = 15; // closer than this, our distance and the airline's may well differ
// Where distance d sits in a band list (charts.json { upTo } or asiamiles.json { max }, ascending, the last may be open):
// just past the band below (over, by how much) or just under the next band (left: miles until it starts). Else null.
function mkEdge(bands, d) {
  if (!bands?.length || !d) return null;
  const top = (b) => b.upTo ?? b.max ?? null;
  const i = bands.findIndex((b) => top(b) == null || d <= top(b));
  if (i < 0) return null;
  const lo = i ? top(bands[i - 1]) : null;
  if (lo != null && d - lo <= MK_NEAR) return { over: d - lo, edge: lo };
  const hi = top(bands[i]);
  if (hi != null && hi + 1 - d <= MK_NEAR) return { left: hi + 1 - d, edge: hi };
  return null;
}
function mkEdgeText(e, d) {
  if (!e) return '';
  const by = e.over ?? e.left;
  const fine = by < MK_FINE ? '（差距很小，以航空公司計算為準）' : '';
  return e.over != null
    ? `${fmt(d)} 哩：剛超過 ${fmt(e.edge)} 哩級距 ${fmt(e.over)} 哩，價格算下一級${fine}`
    : `${fmt(d)} 哩：再 ${fmt(e.left)} 哩就會跳到下一級，轉機繞路要小心${fine}`;
}

// The band a distance falls in, in words: 「2,751–5,000 哩級距（中程）」 or 「7,001 哩以上（最高級距）」.
function mkBandText(bands, d) {
  const top = (b) => b.upTo ?? b.max ?? null;
  const i = (bands || []).findIndex((b) => top(b) == null || d <= top(b));
  if (i < 0) return '';
  const lo = i ? top(bands[i - 1]) + 1 : 1;
  const hi = top(bands[i]);
  return `${hi == null ? `${fmt(lo)} 哩以上（最高級距）` : `${fmt(lo)}–${fmt(hi)} 哩級距`}${bands[i].name && hi != null ? `（${bands[i].name}）` : ''}`;
}

// ---------- the same chart from another Taiwan airport (#3) ----------
const MK_TW = ['TPE', 'TSA', 'KHH', 'RMQ'];
// One-way price of one row's chart (id, kind) from x to y: { miles, dist, via }.
function mkRowPrice(id, kind, x, y, cabin) {
  const dist = haversineMiles(x, y);
  if (id === 'asiamiles') {
    const q = amRoutePrices(x, y, dist, cabin).find((p) => p.kind === kind);
    return q ? { miles: q.miles, dist: q.dist, via: q.via } : null;
  }
  const p = data.charts?.programs?.find((c) => c.id === id);
  if (!p || p.oneWay === false) return null;
  const best = chartPrices(p, x, y, cabin, dist).sort((m, n) => m.miles - n.miles)[0];
  return best ? { miles: best.miles, dist, via: '' } : null;
}
// One-way from or to Taiwan: the other Taiwan airports where the same chart costs less and an airline it prices flies
// the route nonstop on record (Cathay through Hong Kong: its leg to or from Hong Kong). → [{ code, dist, miles, save, to }]
function mkAltAirports(row, a, b, cabin) {
  const home = a.country === 'TW' ? 'a' : b.country === 'TW' ? 'b' : '';
  if (!home || !nonstopData) return [];
  const can = mkChartCarriers(row.key, row.kind);
  const out = [];
  for (const code of MK_TW) {
    const alt = AP.byCode.get(code);
    if (!alt || alt.lat == null || code === a.code || code === b.code) continue;
    const [x, y] = home === 'a' ? [alt, b] : [a, alt];
    const q = mkRowPrice(row.key, row.kind, x, y, cabin);
    if (!q || q.miles >= row.miles) continue;
    const leg = q.via ? (home === 'a' ? [x.code, q.via] : [q.via, y.code]) : [x.code, y.code];
    if (!(nonstopCarriers(...leg) || []).some((c) => can.has(c))) continue;
    out.push({ code, dist: q.dist, miles: q.miles, save: row.miles - q.miles, to: home === 'b' });
  }
  return out.sort((m, n) => m.miles - n.miles);
}
const mkAltText = (x, cabin) => `${x.to ? '改飛' : '從'}${esc(airportCity(x.code))}（${x.code}）${x.to ? '' : '出發'} ${fmt(x.dist)} 哩，${CABIN_SHORT[cabin]}少 ${fmt(x.save)} 哩`;

// ---------- flight time (#30) ----------
// Block time from great-circle miles: 500 mph plus half an hour for taxi, climb and descent, to the half hour. A rule of
// thumb (我推測), shown as 約 … 依距離估算; winds and detours move real timetables an hour or more either way.
const mkHours = (mi) => Math.max(1, Math.round((0.5 + mi / 500) * 2) / 2);
const MK_CONNECT_HOURS = 2;
// The quickest way from any origin to any of a city's airports with the airlines in `only` (a Set; null = all):
// nonstop, else one stop at any airport both legs reach. → { stops: 0, hours, carriers, from, to } | { stops: 1, hours,
// via, from, to } | { stops: 2 } (two or more), or null before the data loads.
function mkReach(froms, tos, only = null) {
  if (!nonstopData) return null;
  const ok = (list) => (only ? (list || []).filter((c) => only.has(c)) : list || []);
  let best = null;
  for (const f of froms) {
    for (const t of tos) {
      const list = ok(nonstopCarriers(f.code, t.code));
      const hours = mkHours(haversineMiles(f, t));
      if (list.length && (!best || hours < best.hours)) best = { stops: 0, hours, carriers: list, from: f.code, to: t.code };
    }
  }
  if (best) return best;
  for (const f of froms) {
    for (const [hub, l1] of nonstopData.from.get(f.code) || []) {
      const h = AP.byCode.get(hub);
      if (!ok(l1).length || h?.lat == null) continue;
      for (const t of tos) {
        if (!ok(nonstopData.from.get(hub)?.get(t.code)).length) continue;
        const hours = mkHours(haversineMiles(f, h)) + mkHours(haversineMiles(h, t)) + MK_CONNECT_HOURS;
        if (!best || hours < best.hours) best = { stops: 1, hours, via: hub, from: f.code, to: t.code };
      }
    }
  }
  return best || { stops: 2 };
}
function mkReachText(r) {
  if (!r) return '';
  if (r.stops === 0) return `直飛約 ${r.hours} 小時`;
  if (r.stops === 1) return `需轉機・約 ${r.hours} 小時（經 ${r.via} ${airportCity(r.via).replace(/（.*）$/, '')}）`;
  return '需轉機兩次以上';
}

// ---------- 哩程試算: route comparison (#4) ----------
// Each leg's airlines on record that the chart prices; a leg nobody on the chart flies nonstop is named.
function mkLegsFlyable(id, kind, pts) {
  if (!nonstopData) return null;
  const can = mkChartCarriers(id, kind);
  const legs = pts.slice(1).map((p, i) => ({ from: pts[i].code, to: p.code, list: (nonstopCarriers(pts[i].code, p.code) || []).filter((c) => can.has(c)) }));
  return { legs, missing: legs.filter((l) => !l.list.length) };
}
// The cheapest table of a per-segment chart for one leg: the table of an airline that flies it when the chart has one
// (英航 Avios: 國泰, 日航, 美航／阿拉斯加 tables), otherwise the general partner table.
const MK_TABLE_WORD = { CX: '國泰', JL: '日本航空', AA: '美國航空', AS: '阿拉斯加' };
function mkLegPrice(p, x, y, cabin, dist, carriers) {
  const all = chartPrices(p, x, y, cabin, dist).sort((m, n) => m.miles - n.miles);
  if (!all.length) return null;
  if (!carriers?.length) return all[0];
  const own = (r) => Object.values(MK_TABLE_WORD).some((w) => r.label.includes(w));
  const fits = carriers.map((c) => all.find((r) => (MK_TABLE_WORD[c] ? r.label.includes(MK_TABLE_WORD[c]) : !own(r)))).filter(Boolean);
  return fits.sort((m, n) => m.miles - n.miles)[0] || all[0];
}
// Every program priced on one route (codes in order) by its own rule: Asia Miles and the whole-trip charts (阿拉斯加,
// 阿提哈德, Aeroplan) on the summed distance, per-segment charts (英航 Avios) leg by leg, zone charts by the two ends,
// 日航寰宇一家 on the round-trip total. → { pts, legs: [miles], total, cells: Map(rowKey → { miles, note, fly }) }
function mkRouteQuote(codes, cabin, rt) {
  const pts = codes.map((c) => AP.byCode.get(c));
  if (pts.some((p) => p?.lat == null)) return null;
  const legs = pts.slice(1).map((p, i) => haversineMiles(pts[i], p));
  const total = legs.reduce((s, x) => s + x, 0);
  const [a, b] = [pts[0], pts.at(-1)];
  const direct = pts.length === 2;
  const cells = new Map();
  const put = (key, label, x, fly) => {
    if (!x?.miles) return;
    const old = cells.get(key);
    if (!old || x.miles < old.miles) cells.set(key, { ...x, label, fly });
  };
  // Asia Miles: the nonstop column keeps Cathay through Hong Kong (amRoutePrices); a route with stops sums its legs.
  const am = direct ? amRoutePrices(a, b, total, cabin) : ['cx', 'partner'].map((kind) => ({ ...amPrice(kind, total, cabin, a.code, b.code), dist: total, via: '' }));
  for (const q of am) {
    if (!q?.miles) continue;
    const viaPts = q.via ? [a, AP.byCode.get(q.via), b] : pts;
    put(`asiamiles:${q.kind}`, q.kind === 'cx' ? '國泰航班' : '夥伴航班', { miles: q.miles * (rt ? 2 : 1), d: q.dist, bands: data.asiamiles.bands, note: q.via ? `經香港 ${fmt(q.dist)} 哩` : '' }, mkLegsFlyable('asiamiles', q.kind, viaPts));
  }
  const mid = pts.slice(1, -1);
  for (const p of data.charts?.programs || []) {
    if (!['distance', 'zone', 'regionMatrix', 'routeSpecific'].includes(p.kind) || (p.oneWay === false && !rt)) continue;
    const mult = rt && p.oneWay !== false ? 2 : 1;
    const fly = mkLegsFlyable(p.id, '', pts);
    if (p.perSegment && !direct) {
      const parts = legs.map((d, i) => mkLegPrice(p, pts[i], pts[i + 1], cabin, d, fly?.legs[i].list));
      if (parts.some((x) => !x)) continue;
      put(p.id, '', { miles: parts.reduce((s, x) => s + x.miles, 0) * mult, note: `每段分開計價：${parts.map((x) => fmt(x.miles)).join(' + ')}` }, fly);
      continue;
    }
    const best = (p.perSegment ? [mkLegPrice(p, a, b, cabin, total, fly?.legs[0]?.list)] : chartPrices(p, { ...a, via: mid }, b, cabin, total))
      .filter(Boolean).sort((m, n) => m.miles - n.miles)[0];
    if (best) put(p.id, best.label, { miles: best.miles * mult, bands: best.bands, d: best.d, note: '' }, fly);
  }
  return { codes, pts, legs, total, cells };
}
// Rows (programs) by columns (routes), gcmap-style: each leg's distance, the total, 「比直飛多 7%」, then every program's
// price on each route with its band and whether its airlines fly each leg nonstop on record.
function mkCompareHtml(a, b, vias, cabin, rt) {
  const routes = [[a.code, b.code], ...vias.map((v) => [a.code, ...v, b.code])].map((codes) => mkRouteQuote(codes, cabin, rt)).filter(Boolean);
  if (routes.length < 2) return '';
  const base = routes[0].total;
  const keys = [...new Set(routes.flatMap((r) => [...r.cells.keys()]))];
  const low = (k) => Math.min(...routes.map((r) => r.cells.get(k)?.miles ?? 9e9));
  keys.sort((x, y) => low(x) - low(y));
  const name = (k) => {
    const [id, kind] = k.split(':');
    if (id === 'asiamiles') return { name: programName('asiamiles'), sub: kind === 'cx' ? '國泰航班' : '夥伴航班', conf: 'official' };
    const p = data.charts.programs.find((x) => x.id === id);
    const n = chartProgram(id, p?.name);
    return { name: n.name, sub: n.variant, conf: p?.confidence, perSegment: p?.perSegment };
  };
  const head = routes.map((r, i) => `<th scope="col"><b>${r.codes.map(esc).join(' → ')}</b>
    <small>${r.legs.length > 1 ? r.legs.map((d, j) => `${esc(r.codes[j])}–${esc(r.codes[j + 1])} ${fmt(d)}`).join('<br>') : '直飛'}</small>
    <small>合計 ${miKm(r.total)}</small>${i ? `<small class="mk-more">${r.total > base ? `比直飛多 ${Math.round(((r.total - base) / base) * 100)}%` : '和直飛差不多'}</small>` : ''}</th>`).join('');
  const cell = (k, r) => {
    const x = r.cells.get(k);
    if (!x) return '<td><small>查不到</small></td>';
    const best = x.miles === low(k) && routes.filter((q) => q.cells.get(k)?.miles === x.miles).length < routes.length;
    const e = mkEdge(x.bands, x.d);
    const fly = x.fly && (x.fly.missing.length ? `<span class="mk-tag">${esc(x.fly.missing.map((l) => `${l.from}→${l.to}`).join('、'))} 沒有可搭的直飛</span>` : '<span class="mk-tag ok">每段都有可搭的直飛</span>');
    return `<td class="${best ? 'mk-best' : ''}"><b>${fmt(x.miles)}</b>${x.note ? `<small>${esc(x.note)}</small>` : ''}${e ? `<small class="mk-edge">⚠ ${esc(mkEdgeText(e, x.d))}</small>` : ''}${fly || ''}</td>`;
  };
  return `<div class="table-wrap"><table class="need-table mk-compare"><thead><tr><th scope="col">計畫（${rt ? '來回' : '單程'}）</th>${head}</tr></thead><tbody>
    ${keys.map((k) => { const n = name(k); return `<tr><th scope="row"><b>${esc(n.name)}</b>${n.sub ? `<small>${esc(n.sub)}</small>` : ''}${n.perSegment ? '<small>每段分開計價</small>' : ''}${CONFIDENCE_TAG[n.conf] || ''}</th>${routes.map((r) => cell(k, r)).join('')}</tr>`; }).join('')}
  </tbody></table></div>
  <p class="hint">轉機路線依各計畫自己的規則算：亞洲萬里通、阿拉斯加、阿提哈德、Aeroplan 用各段相加的距離，英航 Avios 每段分開計價，依區域計價的表只看起訖。標底色的是這個計畫最便宜的走法。</p>`;
}

// ---------- 哩程試算 (features.js renderNeed): extras on each row ----------
// rows: features.js rows ({ key, kind, via, miles, bands, d, … }); adds r.extra (tags, band edge, other airports).
function mkNeed(a, b, rows, cabin, rt) {
  for (const r of rows) {
    const bits = [mkDirectTag(mkDirect(r.key, r.kind, a.code, b.code, r.via))];
    const e = mkEdge(r.bands, r.d);
    if (e) bits.push(`<span class="mk-edge">⚠ ${esc(mkEdgeText(e, r.d))}</span>`);
    if (!rt) {
      const alt = mkAltAirports(r, a, b, cabin)[0];
      if (alt) bits.push(`<span class="mk-alt">💡 ${mkAltText(alt, cabin)}</span>`);
    }
    r.extra = bits.filter(Boolean).join('');
  }
  return { foot: mkSourceHtml() };
}
// The nonstop data's source and caveat, wherever nonstop information shows.
function mkSourceHtml() {
  const m = nonstopData?.meta;
  if (!m?.source) return '';
  return `<p class="hint mk-src">直飛資料：<a href="${esc(m.source.url)}" target="_blank" rel="noopener">${esc(m.source.label)}</a>（${esc(m.source.licence)}，${esc(m.source.fetched)} 取得），飛機愛好者整理的航班呼號紀錄，不是時刻表：可能漏掉新航線，也可能留著已停飛航線。</p>`;
}

// ---------- 兌換地圖 layers (#5, #10, #30) ----------
const MK_ALLIANCES = [['star', '星空聯盟'], ['oneworld', '寰宇一家'], ['skyteam', '天合聯盟']];
// The airlines the 航空公司 filter keeps: an alliance, one airline, or all (null).
function mkOnly(air) {
  if (!air) return null;
  const al = MK_ALLIANCES.find(([id]) => `a:${id}` === air);
  return new Set(al ? allianceCarriers(al[0]) : [air]);
}
// Pins: each city's quickest way there (d.reach), its nonstop airlines from each origin (d.nonstop), and with
// 只看有直飛 only the cities flown nonstop (by the chosen airline or alliance, and the chosen program's airlines).
function mkMapDests(dests) {
  const froms = rmapFroms();
  const only = rmap.direct ? mkOnly(rmap.air) : null;
  const prog = rmap.direct && rmap.program ? new Set(rmap.program === 'asiamiles' ? [...mkChartCarriers('asiamiles', 'cx'), ...mkChartCarriers('asiamiles', 'partner')] : mkChartCarriers(rmap.program)) : null;
  const ok = (c) => (!only || only.has(c)) && (!prog || prog.has(c));
  const out = [];
  for (const d of dests) {
    const tos = d.codes.map((c) => AP.byCode.get(c)).filter((x) => x?.lat != null);
    d.nonstop = froms.map((f) => ({ from: f.code, list: [...new Set(tos.flatMap((t) => nonstopCarriers(f.code, t.code) || []))] })).filter((x) => x.list.length);
    d.reach = mkReach(froms, tos, only);
    d.ring = Boolean(rmap.direct && d.nonstop.some((x) => x.list.some(ok)));
    if (rmap.direct && !d.ring) continue;
    out.push(d);
  }
  mkLastDests = out;
  return out;
}
// The 圖層 row under the form: 只看有直飛 (with an airline or alliance filter), and 距離級距圈 for distance charts.
function mkLayersHtml() {
  const froms = rmapFroms();
  let airs = '';
  if (rmap.direct && nonstopData) {
    const count = new Map();
    for (const f of froms) for (const [, list] of nonstopData.from.get(f.code) || []) for (const c of list) count.set(c, (count.get(c) || 0) + 1);
    const list = [...count].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
    airs = `<label class="field compact mk-air">航空公司<select name="air"><option value="">全部航空公司</option>
      <optgroup label="聯盟">${MK_ALLIANCES.map(([id, n]) => `<option value="a:${id}" ${rmap.air === `a:${id}` ? 'selected' : ''}>${n}</option>`).join('')}</optgroup>
      <optgroup label="航空公司（直飛機場數）">${list.map(([c, n]) => `<option value="${esc(c)}" ${rmap.air === c ? 'selected' : ''}>${esc(airlineZh(c))}（${n}）</option>`).join('')}</optgroup></select></label>`;
  }
  const rings = mkRingBands(rmap.program, rmap.cabin, rmap.trip, froms[0]);
  return `<span class="mk-layers-h">圖層</span>
    <label class="switch"><input type="checkbox" name="direct" ${rmap.direct ? 'checked' : ''}><span class="knob"></span>只看有直飛</label>${airs}
    ${rings?.length ? `<label class="switch"><input type="checkbox" name="rings" ${rmap.rings ? 'checked' : ''}><span class="knob"></span>顯示距離級距圈</label>` : '<small class="mk-layers-tip">選亞洲萬里通、英航等依距離計價的計畫，可以顯示距離級距圈</small>'}`;
}

// Great-circle geometry for rings and arcs: the point `mi` miles from c on bearing `brg` (degrees), longitudes in ±180.
function mkDest(c, brg, mi) {
  const r = Math.PI / 180;
  const d = mi / 3958.8;
  const [t, p1, l1] = [brg * r, c.lat * r, c.lon * r];
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t));
  const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [p2 / r, ((((l2 / r) + 540) % 360) + 360) % 360 - 180];
}
function mkBearing(a, b) {
  const r = Math.PI / 180;
  const [p1, p2, dl] = [a.lat * r, b.lat * r, (b.lon - a.lon) * r];
  return Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) / r;
}
// A line as pieces that never jump across the ±180° edge (the pins sit at their own longitude, so lines do too).
function mkSplit(pts) {
  const parts = [[]];
  pts.forEach((p, i) => { if (i && Math.abs(p[1] - pts[i - 1][1]) > 180) parts.push([]); parts.at(-1).push(p); });
  return parts.filter((x) => x.length > 1);
}
const mkCircle = (c, mi, n = 144) => mkSplit(Array.from({ length: n + 1 }, (_, k) => mkDest(c, (360 * k) / n, mi)));
const mkArc = (a, b, n = 48) => { const brg = mkBearing(a, b); const d = haversineMiles(a, b); return mkSplit(Array.from({ length: n + 1 }, (_, k) => mkDest(a, brg, (d * k) / n))); };

// A distance chart as rings round the origin: [{ upTo, miles }] for this cabin (round trip doubled, or for 日航寰宇一家
// the round-trip total's band at half its distance), or null when the program does not price by distance alone.
function mkRingBands(id, cabin, trip, from) {
  if (!id || !from) return null;
  const rt = trip === 'rt';
  if (id === 'asiamiles') return data.asiamiles?.bands.filter((b) => b.max != null).map((b) => ({ upTo: b.max, miles: (data.asiamiles.charts.cx[b.id]?.[cabin] || 0) * (rt ? 2 : 1) || null }));
  const p = data.charts?.programs?.find((x) => x.id === id);
  if (p?.kind !== 'distance' || (p.oneWay === false && !rt)) return null;
  const area = id === 'alaska' ? alaskaArea(from, from) : null;
  const t = p.tables.find((x) => (!x.appliesWhen || x.appliesWhen === area) && !x.touchesCountries) || p.tables[0];
  const half = p.distanceBasis === 'roundTripTotal';
  return t.bands.filter((b) => b.upTo != null).map((b) => ({ upTo: half ? b.upTo / 2 : b.upTo, miles: b[cabin] ? b[cabin] * (rt && p.oneWay !== false ? 2 : 1) : null, table: t.label }))
    .filter((b) => b.upTo < 12000);
}

let mkLayer = null;
// Everything 兌換地圖 draws on top of the pins: the band rings and, when a pin's card opens, its great-circle line.
function mkDrawLayers(map, froms, dests) {
  const L = window.L;
  mkLayer = L.layerGroup().addTo(map);
  const from = froms[0];
  const rings = rmap.rings ? mkRingBands(rmap.program, rmap.cabin, rmap.trip, from) : null;
  if (rings?.length) {
    const can = rmap.budget ? rings.filter((r) => r.miles && r.miles <= rmap.budget).at(-1) : null;
    for (const r of rings) {
      const on = r === can;
      L.polyline(mkCircle(from, r.upTo), { className: `mk-ring${on ? ' on' : ''}`, weight: on ? 3 : 1.5, dashArray: on ? null : '6 6', interactive: false }).addTo(mkLayer);
      const at = mkDest(from, 150, r.upTo);
      L.marker(at, { icon: L.divIcon({ className: `mk-ring-label${on ? ' on' : ''}`, html: `≤${fmt(r.upTo)} 哩・${CABIN_SHORT[rmap.cabin]} ${r.miles ? fmt(r.miles) : '—'}`, iconSize: null }), interactive: false, keyboard: false, zIndexOffset: 100000 }).addTo(mkLayer);
    }
  }
  const arc = L.layerGroup().addTo(map);
  map.on('popupopen', (e) => {
    arc.clearLayers();
    const d = dests.find((x) => x.marker === e.popup._source);
    const f = d && AP.byCode.get(d.from);
    if (f && d.ap) L.polyline(mkArc(f, d.ap), { className: 'mk-arc', weight: 2.5, interactive: false }).addTo(arc);
  });
  map.on('popupclose', () => arc.clearLayers());
}
// A 兌換地圖 price row ({ id, label, from, to, dist }) priced again for what the card adds: Asia Miles' kind and Hong
// Kong connection, and the band list and distance that set the price (none for zone and fixed-price charts).
function mkRowInfo(x) {
  const [a, b] = [AP.byCode.get(x.from), AP.byCode.get(x.to)];
  if (!a || !b) return {};
  if (x.id === 'asiamiles') {
    const kind = x.label.startsWith('國泰') ? 'cx' : 'partner';
    const q = amRoutePrices(a, b, x.dist, rmap.cabin).find((p) => p.kind === kind);
    return { kind, via: q?.via || '', bands: data.asiamiles.bands, d: q?.dist };
  }
  const p = data.charts?.programs?.find((c) => c.id === x.id);
  const r = p && chartPrices(p, a, b, rmap.cabin, x.dist).find((y) => y.label === x.label);
  return { kind: '', via: '', bands: r?.bands, d: r?.d };
}
// Inside a pin's card: the flight-time estimate, the nonstop airlines and which programs book them, and a band-edge or
// other-airport line for the cheapest program. Built when the card opens.
function mkPopupHtml(d) {
  const lines = [];
  if (d.reach) lines.push(`<p class="mk-pop">✈ ${esc(mkReachText(d.reach))}<small>依距離估算</small></p>`);
  if (d.nonstop?.length) {
    const all = [...new Set(d.nonstop.flatMap((x) => x.list))];
    const multi = d.nonstop.length > 1 || rmap.origins.length > 1;
    const progs = (data.programs?.programs || []).filter((p) => { const can = mkBookable(p); return all.some((c) => can.has(c)); }).map(mkProgName);
    lines.push(`<p class="mk-pop">直飛：${d.nonstop.map((x) => `${multi ? `${esc(x.from)} ` : ''}${esc(mkAirs(x.list))}`).join('；')}${progs.length ? `<small>可用：${esc(progs.slice(0, 6).join('、'))}${progs.length > 6 ? ` 等 ${progs.length} 個計畫` : ''}</small>` : ''}</p>`);
  }
  const x = d.prices[0];
  const info = x ? mkRowInfo(x) : {};
  const e = mkEdge(info.bands, info.d);
  if (e) lines.push(`<p class="mk-pop warn">⚠ ${esc(rmapProgramName(x.id))}：${esc(mkEdgeText(e, info.d))}</p>`);
  const a = AP.byCode.get(x?.from);
  if (x && a && rmap.trip === 'ow') {
    const alt = mkAltAirports({ key: x.id, kind: info.kind, miles: x.miles }, a, AP.byCode.get(x.to), rmap.cabin)[0];
    if (alt) lines.push(`<p class="mk-pop">💡 ${esc(rmapProgramName(x.id))}${mkAltText(alt, rmap.cabin)}</p>`);
  }
  return lines.join('');
}
// A price row in the card: 「直飛」 when an airline the chart prices flies there nonstop from that row's origin.
function mkRowTag(x) {
  const info = mkRowInfo(x);
  if (info.via) return '';
  const t = mkDirect(x.id, info.kind, x.from, x.to);
  return t?.direct.length ? `・直飛 ${esc(mkAirs(t.direct))}` : '';
}
// Under the map: the ring legend, the data source, and the city list that sorts by miles or flight time.
function mkAfterMapHtml(dests) {
  const rings = rmap.rings && mkRingBands(rmap.program, rmap.cabin, rmap.trip, rmapFroms()[0]);
  const sorted = [...dests].sort(rmap.sort === 'time' ? (m, n) => (m.reach?.hours ?? 99) + (m.reach?.stops === 2 ? 99 : 0) - ((n.reach?.hours ?? 99) + (n.reach?.stops === 2 ? 99 : 0)) || m.min - n.min : (m, n) => m.min - n.min);
  return `${rings?.length ? `<p class="hint mk-legend">虛線圈是${esc(rmapProgramName(rmap.program))}的距離級距（以 ${esc(rmap.origins[0])} 為中心的直線距離${rmap.program === 'asiamiles' ? '，標國泰航班價；國泰經香港轉機時依兩段相加' : ''}${rmap.budget ? '，粗線是「我有幾哩」換得到的最遠一圈' : ''}）。</p>` : ''}
    <p class="hint">✈ 飛行時間依直線距離估算（時速約 800 公里加 30 分鐘起降，轉機另加 2 小時），只是大約；實際以航空公司時刻表為準。</p>
    ${mkSourceHtml()}
    <details class="mk-list" ${rmap.listOpen ? 'open' : ''}><summary>城市列表（${dests.length} 個，可依哩數或飛行時間排序）</summary>
      <fieldset class="seg" aria-label="排序">${[['miles', '哩數少的先'], ['time', '飛行時間短的先']].map(([k, l]) => `<label><input type="radio" name="mk-sort" value="${k}" ${(rmap.sort || 'miles') === k ? 'checked' : ''}><span>${l}</span></label>`).join('')}</fieldset>
      <ol class="mk-cities">${sorted.map((d) => `<li><button type="button" class="linklike" data-mk-pin="${esc(d.city)}">${esc(d.city)}</button>
        <span>${fmt(d.min)} 哩起</span><small>${esc(mkReachText(d.reach))}</small></li>`).join('')}</ol></details>`;
}

if (typeof document !== 'undefined') {
  // The city list: sort, keep open across redraws, and a city's name opens its card on the map.
  // The layers row and the list's sort redraw the map, then give the focus back to the control that changed.
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.name === 'mk-sort') Object.assign(rmap, { sort: t.value, listOpen: true });
    else if (!t.closest?.('#rmap-layers')) return;
    else if (t.name === 'direct') rmap.direct = t.checked;
    else if (t.name === 'rings') rmap.rings = t.checked;
    else if (t.name === 'air') rmap.air = t.value;
    else return;
    Promise.resolve(renderRmap()).then(() => $(`#rmap-out [name="${t.name}"]${t.type === 'radio' ? `[value="${t.value}"]` : ''}`)?.focus({ preventScroll: true }));
  });
  document.addEventListener('toggle', (e) => { if (e.target.classList?.contains('mk-list')) rmap.listOpen = e.target.open; }, true);
  document.addEventListener('click', (e) => {
    const b = e.target.closest?.('[data-mk-pin]');
    if (!b || !rmapMap) return;
    const d = mkLastDests.find((x) => x.city === b.dataset.mkPin);
    if (!d?.marker) return;
    $('#rmap')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    rmapMap.setView(d.marker.getLatLng(), Math.max(rmapMap.getZoom(), 4));
    d.marker.openPopup();
  });
}
let mkLastDests = [];
