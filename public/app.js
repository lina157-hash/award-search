const SOURCE_NAMES = {
  aeroplan: '加航 Aeroplan', united: '聯合 MileagePlus', alaska: '阿拉斯加 Atmos', american: '美航 AAdvantage',
  delta: '達美 SkyMiles', flyingblue: '法荷航 Flying Blue', virginatlantic: '維珍 Flying Club', qantas: '澳航 Frequent Flyer',
  lufthansa: '漢莎 Miles&More', turkish: '土航 Miles&Smiles', singapore: '新航 KrisFlyer', eurobonus: 'SAS EuroBonus',
  ethiopian: '衣索比亞 ShebaMiles', aeromexico: '墨航 Club Premier', etihad: '阿提哈德 Guest', emirates: '阿聯酋 Skywards',
  qatar: '卡達 Privilege Club', velocity: '維珍澳洲 Velocity', smiles: 'GOL Smiles', azul: 'Azul TudoAzul',
  asiamiles: '國泰 亞洲萬里通', asiamiles_est: '亞洲萬里通（估算）', connectmiles: 'Copa ConnectMiles', copa: 'Copa ConnectMiles',
  lifemiles: 'Avianca LifeMiles', british: '英航 Avios', jetblue: 'JetBlue TrueBlue', saudia: '沙烏地 AlFursan', finnair: '芬航 Finnair Plus',
};
const CABIN_LABEL = { Y: '經濟艙', W: '豪華經濟艙', J: '商務艙', F: '頭等艙' };
const CABIN_API = { Y: 'economy', W: 'premium', J: 'business', F: 'first' };
const CABIN_ZH = { economy: '經濟艙', premium: '豪華經濟艙', business: '商務艙', first: '頭等艙' };
const DOW = ['日', '一', '二', '三', '四', '五', '六'];

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (n ? Number(n).toLocaleString('zh-TW') : '—');
const kfmt = (n) => (n >= 10000 ? `${(n / 10000).toFixed(n % 10000 ? 1 : 0)}萬` : fmt(n));
const srcName = (s) => SOURCE_NAMES[s] || s;
const dowOf = (iso) => DOW[new Date(iso + 'T00:00:00Z').getUTCDay()];
const mmdd = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
const hhmm = (iso) => (iso || '').slice(11, 16);
const data = {};

async function api(path) {
  const res = await fetch(path);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function isoDate(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2200);
}

const skeleton = (n = 4) => `<div class="skeleton">${'<div></div>'.repeat(n)}</div>`;

// ---------- tabs ----------
function showTab(name) {
  $$('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  $$('.panel').forEach((p) => (p.hidden = p.id !== `tab-${name}`));
  history.replaceState(null, '', `${location.search}#${name}`);
}
$$('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ---------- Asia Miles estimate ----------
// seats.aero has no Asia Miles source. Oneworld seats seen through partner programs are usually
// bookable with Asia Miles too, so we price them with the published-by-media distance chart.
const CABIN_KEY = Object.fromEntries(Object.entries(CABIN_API).map(([k, v]) => [v, k]));

function amBand(dist, o, d) {
  const am = data.asiamiles;
  const band = am.bands.find((b) => b.max == null || dist <= b.max).id;
  return band === 'short' && (am.shortType2Airports.includes(o) || am.shortType2Airports.includes(d)) ? 'short2' : band;
}

// kind: 'cx' (Cathay-operated) or 'partner' (one oneworld partner flown alone).
function amPrice(kind, dist, cabin, o, d) {
  if (!data.asiamiles || !dist) return null;
  const band = amBand(dist, o, d);
  const miles = data.asiamiles.charts[kind][band][cabin];
  return miles ? { miles, kind, band } : null;
}

const oneworld = () => new Set(allianceCarriers('oneworld'));

// Availability-level estimate: route distance is origin→destination, so connections may price higher.
function amFromAvailability(r, cabin) {
  const x = r.cabins[cabin];
  if (!x.available) return null;
  const carriers = x.airlines.split(/,\s*/).filter(Boolean);
  const ow = oneworld();
  // Only when every carrier is oneworld; a mix with non-members can't be booked as a single-carrier award.
  if (!carriers.length || !carriers.every((c) => ow.has(c))) return null;
  return amPrice(carriers.includes('CX') ? 'cx' : 'partner', r.distance, cabin, r.origin, r.destination);
}

// Trip-level estimate: Asia Miles adds sector distances for connections.
function amFromTrip(t) {
  const cabin = CABIN_KEY[t.cabin];
  const ops = [...new Set(t.segments.map((s) => (s.flight || '').slice(0, 2)))];
  const ow = oneworld();
  if (!cabin || !ops.length || !ops.every((c) => ow.has(c))) return null;
  const dist = t.segments.reduce((n, s) => n + (s.distance || 0), 0);
  const o = t.segments[0].from;
  const d = t.segments.at(-1).to;
  if (ops.length === 1) return { ...amPrice(ops[0] === 'CX' ? 'cx' : 'partner', dist, cabin, o, d), dist };
  return { multi: true, dist };
}

function asiaMilesRows(results) {
  // seats.aero carries real Asia Miles data on many routes; only estimate routes it doesn't cover.
  const covered = new Set(results.filter((r) => r.source === 'asiamiles').map((r) => `${r.origin}|${r.destination}`));
  const groups = new Map();
  for (const r of results) {
    if (covered.has(`${r.origin}|${r.destination}`)) continue;
    const k = `${r.date}|${r.origin}|${r.destination}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = [];
  for (const [k, rows] of groups) {
    const cabins = {};
    let any = false;
    for (const c of Object.keys(CABIN_API)) {
      let best = null;
      for (const r of rows) {
        const est = amFromAvailability(r, c);
        if (est && (!best || est.miles < best.est.miles)) best = { est, r };
      }
      cabins[c] = best
        ? { available: true, miles: best.est.miles, seats: null, airlines: best.r.cabins[c].airlines, direct: best.r.cabins[c].direct, refId: best.r.id, refSource: best.r.source, kind: best.est.kind }
        : { available: false, miles: null, seats: null, airlines: '', direct: false };
      any ||= Boolean(best);
    }
    const [date, origin, destination] = k.split('|');
    if (any) out.push({ id: `am-${k}`, date, origin, destination, distance: rows[0].distance, source: 'asiamiles_est', estimate: true, cabins });
  }
  return out;
}

// ---------- search ----------
const state = { results: [], cabin: 'J', hidden: new Set(), day: null };

const ALLIANCE_HINT = {
  oneworld: '寰宇一家的座位會透過亞洲萬里通、阿拉斯加 Atmos、美航 AAdvantage、澳航、卡達等計畫查到；沒有亞洲萬里通資料的航線會另外估算哩數。',
  star: '星空聯盟的座位會透過 Aeroplan、聯合、漢莎、土航等計畫查到；長榮會員通常能看到更多自家座位。',
  skyteam: '天合聯盟的座位會透過 Flying Blue、達美、維珍等計畫查到；華航會員通常能看到更多自家座位。',
};

function allianceCarriers(id) {
  const a = data.alliances.alliances.find((x) => x.id === id);
  return a ? a.members : [];
}

function carrierHint() {
  const code = $('#search-form [name=carrier]').value;
  const a = data.airlines.airlines.find((x) => x.code === code);
  const al = $('#search-form [name=alliance]').value;
  $('#carrier-hint').textContent = a
    ? `${a.name}的座位可透過：${a.bookableVia.map(srcName).join('、')} 查到。` +
      (a.homeProgram && !a.bookableVia.includes(a.homeProgram) ? '（自家里程計畫未收錄於 seats.aero，規則見規則庫）' : '')
    : ALLIANCE_HINT[al] || '';
}

$('#swap').addEventListener('click', () => {
  const f = $('#search-form');
  [f.origin.value, f.destination.value] = [f.destination.value, f.origin.value];
});

$$('.presets button').forEach((b) => b.addEventListener('click', () => {
  const f = $('#search-form');
  f.origin.value = b.dataset.o;
  f.destination.value = b.dataset.d;
  f.alliance.value = b.dataset.al || '';
  f.carrier.value = '';
  carrierHint();
  f.requestSubmit();
}));

$('#search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const share = new URLSearchParams({ o: f.get('origin'), d: f.get('destination'), s: f.get('start'), e: f.get('end'), c: f.get('cabin') || 'J' });
  if (f.get('carrier')) share.set('a', f.get('carrier'));
  else if (f.get('alliance')) share.set('al', f.get('alliance'));
  if (f.get('direct')) share.set('direct', '1');
  history.replaceState(null, '', `?${share}#search`);
  runSearch(share);
});

async function runSearch(share) {
  const params = new URLSearchParams({ origin: share.get('o'), destination: share.get('d'), start: share.get('s'), end: share.get('e') });
  if (share.get('a')) params.set('carriers', share.get('a'));
  else if (share.get('al')) params.set('carriers', allianceCarriers(share.get('al')).join(','));
  if (share.get('direct')) params.set('direct', '1');
  Object.assign(state, { cabin: share.get('c') || 'J', hidden: new Set(), day: null, results: [], start: share.get('s'), end: share.get('e') || share.get('s') });
  const status = $('#search-status');
  status.className = 'status';
  status.textContent = '正在搜尋各里程計畫的獎勵位…';
  $('#search-empty').hidden = true;
  $('#search-results').innerHTML = skeleton();
  try {
    const body = await api(`/api/search?${params}`);
    state.results = [...body.results, ...asiaMilesRows(body.results)];
    status.innerHTML = `<span>找到 <b>${body.results.length}</b> 筆日期與計畫組合${body.mock ? '（示範資料）' : ''}</span>
      <button type="button" class="outline" id="share-btn">🔗 複製分享連結</button>`;
    $('#share-btn').addEventListener('click', copyShare);
    renderSearch();
    status.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    status.className = 'status error';
    status.textContent = err.message;
    $('#search-results').innerHTML = '';
  }
}

async function copyShare() {
  try {
    await navigator.clipboard.writeText(location.href);
    toast('已複製搜尋連結');
  } catch {
    prompt('複製這個連結：', location.href);
  }
}

function visibleRows() {
  return state.results.filter((r) => r.cabins[state.cabin].available && !state.hidden.has(r.source));
}

function renderSearch() {
  const root = $('#search-results');
  const c = state.cabin;
  const rows = visibleRows();
  const allSources = [...new Set(state.results.map((r) => r.source))];

  // lowest per program (ignores the program filter so chips always show a price)
  const bestBySource = {};
  for (const r of state.results) {
    const m = r.cabins[c].available && r.cabins[c].miles;
    if (m && (!bestBySource[r.source] || m < bestBySource[r.source])) bestBySource[r.source] = m;
  }
  const pin = (x) => ['asiamiles', 'asiamiles_est'].indexOf(x) + 1 || 9;
  allSources.sort((a, b) => pin(a) - pin(b) || (bestBySource[a] || Infinity) - (bestBySource[b] || Infinity));
  const realRows = rows.filter((r) => !r.estimate);
  const amRows = rows.filter((r) => r.estimate).sort((a, b) => a.cabins[c].miles - b.cabins[c].miles);
  const amReal = rows.filter((r) => r.source === 'asiamiles').sort((a, b) => a.cabins[c].miles - b.cabins[c].miles);

  const cabinSeg = `<fieldset class="seg" aria-label="切換艙等">${Object.entries(CABIN_LABEL).map(([k, l]) =>
    `<label><input type="radio" name="view-cabin" value="${k}" ${k === c ? 'checked' : ''}><span>${l}</span></label>`).join('')}</fieldset>`;

  if (!rows.length) {
    root.innerHTML = `<div class="section-title">${cabinSeg}</div>
      <div class="empty"><div class="empty-icon" aria-hidden="true">🪑</div><p>這個艙等在所選日期沒有獎勵位，試試其他艙等、日期或目的地。</p></div>`;
    bindCabin(root);
    return;
  }

  const deals = [...realRows].sort((a, b) => a.cabins[c].miles - b.cabins[c].miles).slice(0, 4);
  const dealHtml = deals.map((r, i) => {
    const x = r.cabins[c];
    return `<button type="button" class="deal" data-id="${esc(r.id)}" data-title="${esc(titleOf(r))}">
      ${i === 0 ? '<span class="rank">★ 最低</span>' : ''}
      <div class="route">${esc(r.origin)} → ${esc(r.destination)}</div>
      <div class="miles">${fmt(x.miles)} <small>哩起</small></div>
      <div class="meta">${mmdd(r.date)}（${dowOf(r.date)}）· ${esc(srcName(r.source))}</div>
      <div class="meta">${esc(x.airlines)}${x.direct ? ' · 直飛' : ''}${x.seats ? ` · 剩 ${x.seats} 位` : ''}</div>
    </button>`;
  }).join('');

  const chips = allSources.map((s) => `<button type="button" class="chip ${state.hidden.has(s) ? '' : 'on'}" data-src="${s}">
    ${esc(srcName(s))}${bestBySource[s] ? ` <b>${kfmt(bestBySource[s])}</b>` : ''}</button>`).join('');

  root.innerHTML = `
    <div class="section-title">${cabinSeg}</div>
    ${amReal.length ? `<div class="am-callout">
      <div><b>國泰 亞洲萬里通</b>　最低 <b class="am-miles">${fmt(amReal[0].cabins[c].miles)} 哩</b>（${mmdd(amReal[0].date)} ${esc(amReal[0].origin)} → ${esc(amReal[0].destination)}，${esc(amReal[0].cabins[c].airlines)}），共 ${amReal.length} 個日期／航線有位</div>
      <div class="hint">來自 seats.aero 的亞洲萬里通實際資料。可在下方表格「國泰 亞洲萬里通」欄點選看航班。</div>
    </div>` : ''}
    ${amRows.length ? `<div class="am-callout">
      <div><b>亞洲萬里通估算</b>　國泰／寰宇一家航班最低約 <b class="am-miles">${fmt(amRows[0].cabins[c].miles)} 哩</b>（${mmdd(amRows[0].date)} ${esc(amRows[0].origin)} → ${esc(amRows[0].destination)}，${amRows[0].cabins[c].kind === 'cx' ? '國泰航班' : '夥伴航班'}）</div>
      <div class="hint">依 2026-05-01 起的距離哩數表推算，實際座位與價格請至國泰官網確認；轉機行程依各段距離相加，可能落在更高區間。<a href="#rules" data-goto="rules">看哩數表</a></div>
    </div>` : ''}
    <h2 class="section-title">最划算的選擇 <small>點卡片看航班明細</small></h2>
    <div class="best">${dealHtml}</div>
    <h2 class="section-title">日曆 <small>每天最低里程，顏色越深越便宜；點日期篩選下表</small></h2>
    ${calendarHtml(realRows.length ? realRows : rows)}
    <h2 class="section-title">各計畫比較 <small>點計畫名稱可隱藏／顯示</small></h2>
    <div class="filters">${chips}</div>
    ${matrixHtml(rows, allSources.filter((s) => !state.hidden.has(s)))}`;

  bindCabin(root);
  $$('[data-goto]', root).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); showTab(a.dataset.goto); $('#am-chart')?.scrollIntoView(); }));
  $$('.deal, td.cell[data-id]', root).forEach((el) => el.addEventListener('click', () => openTrips(el.dataset.id, el.dataset.title, state.cabin)));
  $$('.chip[data-src]', root).forEach((b) => b.addEventListener('click', () => {
    state.hidden.has(b.dataset.src) ? state.hidden.delete(b.dataset.src) : state.hidden.add(b.dataset.src);
    renderSearch();
  }));
  $$('.day.has', root).forEach((d) => d.addEventListener('click', () => {
    state.day = state.day === d.dataset.date ? null : d.dataset.date;
    renderSearch();
  }));
  const clear = $('#clear-day', root);
  if (clear) clear.addEventListener('click', () => { state.day = null; renderSearch(); });
}

function bindCabin(root) {
  $$('input[name=view-cabin]', root).forEach((i) => i.addEventListener('change', () => {
    state.cabin = i.value;
    state.day = null;
    const p = new URLSearchParams(location.search);
    p.set('c', i.value);
    history.replaceState(null, '', `?${p}#search`);
    renderSearch();
  }));
}

const titleOf = (r) => `${r.date}（${dowOf(r.date)}）${r.origin} → ${r.destination} · ${srcName(r.source)}`;

function calendarHtml(rows) {
  const c = state.cabin;
  const lowByDay = {};
  for (const r of rows) {
    const m = r.cabins[c].miles;
    if (m && (!lowByDay[r.date] || m < lowByDay[r.date])) lowByDay[r.date] = m;
  }
  const { start, end } = state;
  // Shade by rank among the distinct daily prices, so one expensive outlier doesn't flatten the scale.
  const uniq = [...new Set(Object.values(lowByDay))].sort((a, b) => a - b);
  const level = (m) => (uniq.length === 1 ? 4 : 4 - Math.min(3, Math.floor((uniq.indexOf(m) / (uniq.length - 1)) * 4)));

  const cells = DOW.map((d) => `<div class="dow">${d}</div>`);
  const first = new Date(start + 'T00:00:00Z');
  for (let i = 0; i < first.getUTCDay(); i++) cells.push('<div class="day pad"></div>');
  for (const d = new Date(first); d <= new Date(end + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    const m = lowByDay[iso];
    cells.push(m
      ? `<button type="button" class="day has h${level(m)} ${state.day === iso ? 'sel' : ''}" data-date="${iso}" title="${iso} 最低 ${fmt(m)} 哩">${mmdd(iso)}<b>${kfmt(m)}</b></button>`
      : `<div class="day">${mmdd(iso)}<b>—</b></div>`);
  }
  return `<div class="cal">${cells.join('')}</div>
    <div class="legend">便宜 <i style="background:var(--heat-4)"></i><i style="background:var(--heat-3)"></i><i style="background:var(--heat-2)"></i><i style="background:var(--heat-1)"></i> 較貴
    ${state.day ? `　<button type="button" class="outline" id="clear-day">顯示全部日期（目前只看 ${mmdd(state.day)}）</button>` : ''}</div>`;
}

function matrixHtml(rows, sources) {
  const c = state.cabin;
  const keyOf = (r) => `${r.date}|${r.origin}|${r.destination}`;
  const grid = new Map();
  for (const r of rows) {
    if (state.day && r.date !== state.day) continue;
    if (!grid.has(keyOf(r))) grid.set(keyOf(r), {});
    grid.get(keyOf(r))[r.source] = r;
  }
  let low = Infinity;
  for (const g of grid.values()) for (const r of Object.values(g)) if (!r.estimate) low = Math.min(low, r.cabins[c].miles || Infinity);
  const keys = [...grid.keys()].sort();
  const cell = (r) => {
    const x = r && r.cabins[c];
    if (!x) return '<td class="cell none">·</td>';
    if (r.estimate) {
      return `<td class="cell est" data-id="${esc(x.refId)}" data-title="${esc(`${titleOf(r)}（座位來源：${srcName(x.refSource)}）`)}" title="依距離哩數表估算">≈${fmt(x.miles)}<small>${esc(x.airlines)} · ${x.kind === 'cx' ? '國泰表' : '夥伴表'}</small></td>`;
    }
    const cls = [x.seats && x.seats <= 1 ? 'few' : 'good', x.miles === low ? 'best-cell' : ''].join(' ');
    return `<td class="cell ${cls}" data-id="${esc(r.id)}" data-title="${esc(titleOf(r))}">${fmt(x.miles)}<small>${esc(x.airlines)}${x.direct ? ' · 直飛' : ''}${x.seats ? ` · ${x.seats}位` : ''}</small></td>`;
  };
  return `<div class="table-wrap"><table>
    <thead><tr><th>日期／航線</th>${sources.map((s) => `<th>${esc(srcName(s))}</th>`).join('')}</tr></thead>
    <tbody>${keys.map((k) => {
      const [date, o, d] = k.split('|');
      return `<tr><td><div class="d">${mmdd(date)}（${dowOf(date)}）</div><div class="r">${esc(o)} → ${esc(d)}</div></td>${sources.map((s) => cell(grid.get(k)[s])).join('')}</tr>`;
    }).join('')}</tbody></table></div>`;
}

// ---------- trip details ----------
// Seat map sites have no public API, so we link out: SeatMaps per aircraft, AeroLOPA per airline fleet.
const SEATMAPS_SLUG = {
  CX: 'cx-cathay-pacific', BR: 'br-eva-air', CI: 'ci-china-airlines', AF: 'af-air-france', AC: 'ac-air-canada', KL: 'kl-klm',
  JL: 'jl-jal', NH: 'nh-ana', SQ: 'sq-singapore-airlines', DL: 'dl-delta', BA: 'ba-british-airways', QR: 'qr-qatar-airways',
  TK: 'tk-turkish-airlines', KE: 'ke-korean-air', AA: 'aa-american-airlines', AS: 'as-alaska-airlines', QF: 'qf-qantas',
  LH: 'lh-lufthansa', AY: 'ay-finnair', JX: 'jx-starlux', CA: 'ca-air-china', OZ: 'oz-asiana-airlines', TG: 'tg-thai-airways',
  EK: 'ek-emirates', IB: 'ib-iberia', MH: 'mh-malaysia-airlines', NZ: 'nz-air-new-zealand', LX: 'lx-swiss', OS: 'os-austrian-airlines',
};

function seatLinks(seg) {
  const code = (seg.flight || '').slice(0, 2).toUpperCase();
  const links = [];
  const slug = SEATMAPS_SLUG[code];
  if (slug) {
    const ac = /^(boeing|airbus)\b/i.test(seg.aircraft || '') ? `${seg.aircraft.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}/` : '';
    links.push(`<a href="https://seatmaps.com/airlines/${slug}/${ac}" target="_blank" rel="noopener">SeatMaps ↗</a>`);
  }
  if (/^[A-Z0-9]{2}$/.test(code)) links.push(`<a href="https://www.aerolopa.com/${code.toLowerCase()}" target="_blank" rel="noopener">AeroLOPA ↗</a>`);
  return links.length ? `<span class="seatmap">座位圖 ${links.join(' ')}</span>` : '';
}

function tripHtml(t) {
  const taxes = t.taxes != null ? `${esc(t.taxesSymbol || '')}${fmt(t.taxes / 100)} ${esc(t.taxesCurrency || '')}` : '稅金未提供';
  const dur = t.durationMin ? `${Math.floor(t.durationMin / 60)} 小時 ${t.durationMin % 60} 分` : '';
  return `<div class="trip">
    <div class="trip-top">
      <div><b>${esc(t.flightNumbers)}</b><span class="pill">${esc(CABIN_ZH[t.cabin] || t.cabin)}</span><span class="pill">${t.stops ? `轉機 ${t.stops} 次` : '直飛'}</span>${t.seats ? `<span class="pill">剩 ${t.seats} 位</span>` : ''}</div>
      <div><span class="miles">${fmt(t.miles)} 哩</span> ＋ ${taxes}</div>
    </div>
    ${t.segments.map((s) => `<div class="seg-line"><b>${esc(s.flight)}</b><span>${esc(s.from)} ${hhmm(s.departsAt)} → ${esc(s.to)} ${hhmm(s.arrivesAt)}${s.distance ? `　${fmt(s.distance)} 哩` : ''}</span>
      <span></span><span class="ac">✈ ${esc(s.aircraft || '機型未提供')}${s.aircraftCode ? `（${esc(s.aircraftCode)}）` : ''}${s.fareClass ? `　艙等代碼 ${esc(s.fareClass)}` : ''}　${seatLinks(s)}</span></div>`).join('')}
    ${dur ? `<div class="hint" style="margin-top:6px">總飛行時間 ${dur}</div>` : ''}
    ${amTripLine(t)}
  </div>`;
}

function amTripLine(t) {
  if (t.source === 'asiamiles') return '';
  const am = amFromTrip(t);
  if (!am) return '';
  const dist = am.dist ? `各段合計 ${fmt(am.dist)} 哩` : '';
  if (am.multi) return `<div class="am-line">亞洲萬里通：多家航空公司混搭，需用寰宇一家多航司獎勵另計（${dist}）</div>`;
  if (!am.miles) return '';
  const bandName = (data.asiamiles.bands.find((b) => am.band.startsWith(b.id)) || {}).name || '';
  return `<div class="am-line">亞洲萬里通估算：<b>${fmt(am.miles)} 哩</b>（${am.kind === 'cx' ? '國泰航班' : '夥伴航班'}・${bandName}${am.band === 'short2' ? '第二類' : ''}・${dist}）</div>`;
}

async function openTrips(id, title, cabin) {
  const dlg = $('#trip-dialog');
  $('#trip-title').textContent = title;
  $('#trip-body').innerHTML = skeleton(3);
  dlg.showModal();
  try {
    const body = await api(`/api/trips/${encodeURIComponent(id)}`);
    const links = body.bookingLinks.map((l) => `<a href="${esc(l.link)}" target="_blank" rel="noopener">${esc(l.label)} ↗</a>`).join('');
    const want = CABIN_API[cabin];
    const byMiles = (a, b) => a.miles - b.miles || a.stops - b.stops;
    const main = body.trips.filter((t) => !want || t.cabin === want).sort(byMiles);
    const rest = body.trips.filter((t) => want && t.cabin !== want).sort(byMiles);
    $('#trip-body').innerHTML = (links ? `<div class="links">${links}</div>` : '') +
      (main.map(tripHtml).join('') || '<p class="hint">此艙等沒有航班明細。</p>') +
      (rest.length ? `<details><summary>其他艙等 ${rest.length} 筆</summary>${rest.map(tripHtml).join('')}</details>` : '');
  } catch (err) {
    $('#trip-body').innerHTML = `<p class="status error">${esc(err.message)}</p>`;
  }
}
$('#trip-close').addEventListener('click', () => $('#trip-dialog').close());
$('#trip-dialog').addEventListener('click', (e) => { if (e.target.id === 'trip-dialog') e.target.close(); });

// ---------- explore ----------
const PAGE = 200;
const ex = { rows: [], cabin: 'J', sort: { key: 'miles', dir: 1 }, f: {}, shown: PAGE };
const airportCity = (code) => (data.airports.airports.find((a) => a.code === code) || {}).city || '';

$('#explore-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const params = new URLSearchParams();
  for (const [k, v] of f) if (v) params.set(k, v);
  const status = $('#explore-status');
  status.className = 'status';
  status.textContent = '正在探索，資料量大時可能需要幾秒…';
  $('#explore-results').innerHTML = skeleton(6);
  try {
    const body = await api(`/api/explore?${params}`);
    Object.assign(ex, { rows: body.results, cabin: body.cabin, f: {}, shown: PAGE, sort: { key: 'miles', dir: 1 }, mock: body.mock, truncated: body.truncated });
    renderExplore();
  } catch (err) {
    status.className = 'status error';
    status.textContent = err.message;
    $('#explore-results').innerHTML = '';
  }
});

function exploreFiltered() {
  const { f } = ex;
  const list = ex.rows.filter((r) =>
    (!f.origin || r.origin === f.origin) &&
    (!f.destination || r.destination === f.destination) &&
    (!f.from || r.date >= f.from) &&
    (!f.to || r.date <= f.to) &&
    (!f.maxMiles || r.miles <= f.maxMiles) &&
    (!f.airline || r.airlines.split(/,\s*/).includes(f.airline)) &&
    (!f.direct || r.direct));
  const { key, dir } = ex.sort;
  const val = (r) => (key === 'route' ? `${r.origin}${r.destination}` : key === 'direct' ? Number(r.direct) : r[key] ?? '');
  return list.sort((a, b) => (val(a) > val(b) ? dir : val(a) < val(b) ? -dir : a.miles - b.miles));
}

function renderExplore() {
  const status = $('#explore-status');
  const all = ex.rows;
  if (!all.length) {
    status.textContent = '';
    $('#explore-results').innerHTML = '<div class="empty"><div class="empty-icon">🔭</div><p>沒有找到獎勵位，換個區域、日期或艙等試試。</p></div>';
    return;
  }
  const uniq = (fn) => [...new Set(all.flatMap(fn))].filter(Boolean).sort();
  const opt = (v, label, cur) => `<option value="${esc(v)}" ${cur === v ? 'selected' : ''}>${esc(label)}</option>`;
  const ap = (c) => (airportCity(c) ? `${c} ${airportCity(c)}` : c);
  const dates = uniq((r) => [r.date]);

  if (!$('#ex-filters')) {
    $('#explore-results').innerHTML = `
      <div class="search-card ex-filters" id="ex-filters">
        <div class="opts-row">
          <label class="field">出發機場<select data-f="origin"><option value="">全部</option>${uniq((r) => [r.origin]).map((c) => opt(c, ap(c))).join('')}</select></label>
          <label class="field">抵達機場<select data-f="destination"><option value="">全部</option>${uniq((r) => [r.destination]).map((c) => opt(c, ap(c))).join('')}</select></label>
          <label class="field">航空公司<select data-f="airline"><option value="">全部</option>${uniq((r) => r.airlines.split(/,\s*/)).map((c) => opt(c, c)).join('')}</select></label>
        </div>
        <div class="opts-row">
          <label class="field">日期從<input type="date" data-f="from" min="${dates[0]}" max="${dates.at(-1)}"></label>
          <label class="field">日期到<input type="date" data-f="to" min="${dates[0]}" max="${dates.at(-1)}"></label>
          <label class="field">里程上限<input type="number" data-f="maxMiles" min="0" step="5000" placeholder="例：80000"></label>
          <label class="switch"><input type="checkbox" data-f="direct"><span class="knob"></span>只看直飛</label>
          <button type="button" class="outline" id="ex-reset">清除篩選</button>
        </div>
      </div>
      <div id="ex-table"></div>`;
    $$('#ex-filters [data-f]').forEach((el) => el.addEventListener(el.type === 'number' ? 'input' : 'change', () => {
      const k = el.dataset.f;
      ex.f[k] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) || 0 : el.value;
      ex.shown = PAGE;
      renderExplore();
    }));
    $('#ex-reset').addEventListener('click', () => {
      ex.f = {};
      $$('#ex-filters [data-f]').forEach((el) => (el.type === 'checkbox' ? (el.checked = false) : (el.value = '')));
      ex.shown = PAGE;
      renderExplore();
    });
  }

  const rows = exploreFiltered();
  status.className = 'status';
  status.innerHTML = `<span>共 <b>${all.length}</b> 筆${ex.mock ? '（示範資料）' : ''}，篩選後 <b>${rows.length}</b> 筆${ex.truncated ? '。結果超過 5,000 筆，請縮小日期或區域範圍以看到全部' : ''}</span>`;

  const cols = [['date', '日期'], ['route', '航線'], ['miles', '里程'], ['airlines', '航空公司'], ['direct', '直飛'], ['seats', '剩餘座位'], ['distance', '距離（哩）']];
  const arrow = (k) => (ex.sort.key === k ? (ex.sort.dir > 0 ? ' ▲' : ' ▼') : '');
  const shown = rows.slice(0, ex.shown);
  $('#ex-table').innerHTML = `<div class="table-wrap"><table>
    <thead><tr>${cols.map(([k, l]) => `<th class="sortable" data-k="${k}" aria-sort="${ex.sort.key === k ? (ex.sort.dir > 0 ? 'ascending' : 'descending') : 'none'}">${l}${arrow(k)}</th>`).join('')}</tr></thead>
    <tbody>${shown.map((r) => `<tr class="click" data-id="${esc(r.id)}" data-title="${esc(titleOf(r))}">
      <td><span class="d">${mmdd(r.date)}</span>（${dowOf(r.date)}）</td>
      <td><b>${esc(r.origin)}</b> → <b>${esc(r.destination)}</b></td>
      <td><b style="color:var(--accent)">${fmt(r.miles)}</b></td>
      <td>${esc(r.airlines)}</td><td>${r.direct ? '✓' : ''}</td><td>${r.seats || '—'}</td><td>${r.distance ? fmt(r.distance) : '—'}</td></tr>`).join('')}</tbody>
  </table></div>
  ${rows.length > ex.shown ? `<div class="more"><button type="button" class="outline" id="ex-more">再顯示 ${Math.min(PAGE, rows.length - ex.shown)} 筆</button><button type="button" class="outline" id="ex-all">全部顯示（${rows.length} 筆）</button></div>` : ''}`;

  $$('#ex-table th.sortable').forEach((th) => th.addEventListener('click', () => {
    const k = th.dataset.k;
    ex.sort = { key: k, dir: ex.sort.key === k ? -ex.sort.dir : 1 };
    renderExplore();
  }));
  $$('#ex-table tr.click').forEach((tr) => tr.addEventListener('click', () => openTrips(tr.dataset.id, tr.dataset.title, ex.cabin)));
  const more = $('#ex-more');
  if (more) more.addEventListener('click', () => { ex.shown += PAGE; renderExplore(); });
  const allBtn = $('#ex-all');
  if (allBtn) allBtn.addEventListener('click', () => { ex.shown = Infinity; renderExplore(); });
}

// ---------- rules ----------
const CONFIDENCE_TAG = {
  official: '<span class="tag ok">官方資料</span>',
  secondary: '<span class="tag verify">第三方整理</span>',
  verify: '<span class="tag verify">待核實</span>',
};
const ALLIANCE_SHORT = { oneworld: '寰宇一家', star: '星空聯盟', skyteam: '天合聯盟' };
const rulesState = { alliance: '', q: '' };

function renderRules() {
  const { alliances, programs, glossary, airlines } = data;
  const airlineName = Object.fromEntries(airlines.airlines.map((a) => [a.code, a.name]));
  const allianceCards = alliances.alliances.map((a) => `
    <div class="card"><h3 class="alliance-head"><span class="dot ${a.id}"></span>${esc(a.name)}</h3><p>${esc(a.summary)}</p>
    <p class="hint">成員：${a.members.map((m) => esc(airlineName[m] ? `${airlineName[m]}` : m)).join('、')}</p>
    <p><a href="${esc(a.url)}" target="_blank" rel="noopener">官方成員名單 ↗</a></p></div>`).join('');

  $('#rules').innerHTML = `
    <h2 class="section">航空聯盟</h2><div class="cards">${allianceCards}</div>
    ${amChartHtml()}
    <h2 class="section">里程計畫規則</h2>
    <p class="hint">${esc(programs.disclaimer)}（最後整理：${esc(programs.lastReviewed)}）</p>
    <div class="rules-bar">
      <div class="filters" id="alliance-filter">
        <button type="button" class="chip on" data-a="">全部</button>
        ${Object.entries(ALLIANCE_SHORT).map(([k, v]) => `<button type="button" class="chip" data-a="${k}"><span class="dot ${k}"></span> ${v}</button>`).join('')}
      </div>
      <input type="search" id="rules-q" placeholder="搜尋規則，例如：中停、燃油、效期">
    </div>
    <div class="cards" id="program-cards"></div>
    ${glossary.sections.map((s) => `<h2 class="section">${esc(s.title)}</h2><div class="cards">${s.items.map((i) => `<div class="card"><h3>${esc(i.term)}</h3><p>${esc(i.desc)}</p></div>`).join('')}</div>`).join('')}`;

  $$('#alliance-filter .chip').forEach((b) => b.addEventListener('click', () => {
    rulesState.alliance = b.dataset.a;
    $$('#alliance-filter .chip').forEach((x) => x.classList.toggle('on', x === b));
    renderProgramCards();
  }));
  $('#rules-q').addEventListener('input', (e) => { rulesState.q = e.target.value.trim(); renderProgramCards(); });
  renderProgramCards();
}

function amChartHtml() {
  const am = data.asiamiles;
  if (!am) return '';
  const head = `<tr><th>距離區間（單程）</th>${Object.values(CABIN_LABEL).map((l) => `<th>${l}</th>`).join('')}</tr>`;
  const rows = (chart) => am.bands.flatMap((b, i) => {
    const lo = i ? am.bands[i - 1].max + 1 : 1;
    const range = b.max ? `${fmt(lo)}–${fmt(b.max)} 哩` : `${fmt(lo)} 哩以上`;
    const keys = b.id === 'short' ? [['short', '第一類'], ['short2', '第二類']] : [[b.id, '']];
    return keys.map(([k, sub]) => `<tr><td><b>${b.name}${sub ? `（${sub}）` : ''}</b><div class="r">${range}</div></td>${Object.keys(CABIN_LABEL).map((c) => `<td>${fmt(chart[k][c])}</td>`).join('')}</tr>`);
  }).join('');
  const table = (chart) => `<div><h3 class="sub">${esc(chart.name)}</h3><div class="table-wrap"><table><thead>${head}</thead><tbody>${rows(chart)}</tbody></table></div></div>`;
  return `<h2 class="section" id="am-chart">亞洲萬里通哩數表（${esc(am.effective)} 起，單程標準獎勵）</h2>
    <p class="hint">${esc(am.note)} ${esc(am.shortType2Note)}</p>
    <div class="am-tables">${table(am.charts.cx)}${table(am.charts.partner)}</div>
    <p class="hint">尚待確認：${am.uncertain.map((u) => esc(u.replace(/。$/, ''))).join('；')}</p>
    <p class="hint">來源：${am.sources.map((x) => `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.label)}</a>${x.official ? '（官方）' : ''}`).join('、')}</p>`;
}

function renderProgramCards() {
  const { programs } = data;
  const fieldRows = Object.entries(programs.fields);
  const q = rulesState.q;
  const list = programs.programs.filter((p) => (!rulesState.alliance || p.alliance === rulesState.alliance) &&
    (!q || JSON.stringify(p).includes(q) || fieldRows.some(([, label]) => label.includes(q))));
  const mark = (text) => (q ? esc(text).split(esc(q)).join(`<mark>${esc(q)}</mark>`) : esc(text));
  $('#program-cards').innerHTML = list.map((p) => `
    <div class="card">
      <h3><span class="dot ${p.alliance}"></span>${esc(p.name)} ${CONFIDENCE_TAG[p.confidence] || ''}${p.seatsAeroSource ? '<span class="tag">可查座位</span>' : ''}</h3>
      <dl>${fieldRows.map(([k, label]) => `<dt>${esc(label)}</dt><dd>${mark(p[k])}</dd>`).join('')}</dl>
      <p class="hint">${mark(p.notes)}</p>
      <div class="src">來源（${esc(p.lastVerified || '')} 查核）：${(p.sources || []).map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a>`).join('、')}
      ・<a href="${esc(p.officialUrl)}" target="_blank" rel="noopener">官方網站 ↗</a></div>
    </div>`).join('') || '<p class="hint">沒有符合的計畫。</p>';
}

// ---------- init ----------
(async function init() {
  const [config, ...files] = await Promise.all(['/api/config', ...['airlines', 'alliances', 'airports', 'programs', 'glossary', 'asiamiles'].map((n) => `/api/data/${n}`)].map(api));
  [data.airlines, data.alliances, data.airports, data.programs, data.glossary, data.asiamiles] = files;
  $('#mock-banner').hidden = !config.mock;

  $('#airport-list').innerHTML = data.airports.airports.map((a) => `<option value="${a.code}">${esc(a.city)}</option>`).join('');
  const carrierSel = $('#search-form [name=carrier]');
  carrierSel.insertAdjacentHTML('beforeend', data.airlines.airlines.map((a) => `<option value="${a.code}">${esc(a.name)}（${a.code}）</option>`).join(''));
  carrierSel.addEventListener('change', () => {
    const a = data.airlines.airlines.find((x) => x.code === carrierSel.value);
    if (a) $('#search-form').alliance.value = a.alliance;
    carrierHint();
  });
  $('#search-form').alliance.addEventListener('change', (e) => {
    const a = data.airlines.airlines.find((x) => x.code === carrierSel.value);
    if (a && e.target.value && a.alliance !== e.target.value) carrierSel.value = '';
    carrierHint();
  });

  const sources = [...new Set(data.airlines.airlines.flatMap((a) => a.bookableVia))].sort((a, b) => srcName(a).localeCompare(srcName(b), 'zh-Hant'));
  $('#explore-form [name=program]').innerHTML = sources.map((s) => `<option value="${s}" ${s === 'aeroplan' ? 'selected' : ''}>${esc(srcName(s))}</option>`).join('');
  const regionOpts = '<option value="">全部區域</option>' + data.airports.regions.map((r) => `<option value="${r}">${esc(data.airports.regionNames[r])}</option>`).join('');
  $('#explore-form [name=origin_region]').innerHTML = regionOpts;
  $('#explore-form [name=destination_region]').innerHTML = regionOpts;
  $('#explore-form [name=origin_region]').value = 'Asia';
  $('#explore-form [name=destination_region]').value = 'North America';

  for (const form of ['#search-form', '#explore-form']) {
    $(`${form} [name=start]`).value = isoDate(30);
    $(`${form} [name=end]`).value = isoDate(44);
  }
  renderRules();

  // Restore a shared search from the URL and run it.
  const share = new URLSearchParams(location.search);
  if (share.get('o') && share.get('d') && share.get('s')) {
    const f = $('#search-form');
    f.origin.value = share.get('o');
    f.destination.value = share.get('d');
    f.start.value = share.get('s');
    f.end.value = share.get('e') || share.get('s');
    f.alliance.value = share.get('al') || '';
    f.carrier.value = share.get('a') || '';
    f.direct.checked = share.get('direct') === '1';
    const cab = $(`#search-form input[name=cabin][value="${share.get('c') || 'J'}"]`);
    if (cab) cab.checked = true;
    carrierHint();
    runSearch(share);
  }
  showTab(['search', 'explore', 'rules'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'search');
})().catch((err) => {
  $('#search-status').className = 'status error';
  $('#search-status').textContent = `初始化失敗：${err.message}`;
});
