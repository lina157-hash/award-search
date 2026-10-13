const SOURCE_NAMES = {
  aeroplan: '加航 Aeroplan', united: '聯合 MileagePlus', alaska: '阿拉斯加 Atmos', american: '美航 AAdvantage',
  delta: '達美 SkyMiles', flyingblue: '法荷航 Flying Blue', virginatlantic: '維珍 Flying Club', qantas: '澳航 Frequent Flyer',
  lufthansa: '漢莎 Miles&More', turkish: '土航 Miles&Smiles', singapore: '新航 KrisFlyer', eurobonus: 'SAS EuroBonus',
  ethiopian: '衣索比亞 ShebaMiles', aeromexico: '墨航 Club Premier', etihad: '阿提哈德 Guest', emirates: '阿聯酋 Skywards',
  qatar: '卡達 Privilege Club', velocity: '維珍澳洲 Velocity', smiles: 'GOL Smiles', azul: 'Azul TudoAzul',
  connectmiles: 'Copa ConnectMiles', jetblue: 'JetBlue TrueBlue', saudia: '沙烏地 AlFursan', finnair: '芬航 Finnair Plus',
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

// ---------- search ----------
const state = { results: [], cabin: 'J', hidden: new Set(), day: null };

function carrierHint() {
  const code = $('#search-form [name=carrier]').value;
  const a = data.airlines.airlines.find((x) => x.code === code);
  $('#carrier-hint').textContent = a
    ? `${a.name}的座位可透過：${a.bookableVia.map(srcName).join('、')} 查到。` +
      (a.homeProgram && !a.bookableVia.includes(a.homeProgram) ? '（自家里程計畫未收錄於 seats.aero，規則見規則庫）' : '')
    : '';
}

$('#swap').addEventListener('click', () => {
  const f = $('#search-form');
  [f.origin.value, f.destination.value] = [f.destination.value, f.origin.value];
});

$$('.presets button').forEach((b) => b.addEventListener('click', () => {
  const f = $('#search-form');
  f.origin.value = b.dataset.o;
  f.destination.value = b.dataset.d;
  f.requestSubmit();
}));

$('#search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const share = new URLSearchParams({ o: f.get('origin'), d: f.get('destination'), s: f.get('start'), e: f.get('end'), c: f.get('cabin') || 'J' });
  if (f.get('carrier')) share.set('a', f.get('carrier'));
  if (f.get('direct')) share.set('direct', '1');
  history.replaceState(null, '', `?${share}#search`);
  runSearch(share);
});

async function runSearch(share) {
  const params = new URLSearchParams({ origin: share.get('o'), destination: share.get('d'), start: share.get('s'), end: share.get('e') });
  if (share.get('a')) params.set('carriers', share.get('a'));
  if (share.get('direct')) params.set('direct', '1');
  Object.assign(state, { cabin: share.get('c') || 'J', hidden: new Set(), day: null, results: [], start: share.get('s'), end: share.get('e') || share.get('s') });
  const status = $('#search-status');
  status.className = 'status';
  status.textContent = '正在搜尋各里程計畫的獎勵位…';
  $('#search-empty').hidden = true;
  $('#search-results').innerHTML = skeleton();
  try {
    const body = await api(`/api/search?${params}`);
    state.results = body.results;
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
  allSources.sort((a, b) => (bestBySource[a] || Infinity) - (bestBySource[b] || Infinity));

  const cabinSeg = `<fieldset class="seg" aria-label="切換艙等">${Object.entries(CABIN_LABEL).map(([k, l]) =>
    `<label><input type="radio" name="view-cabin" value="${k}" ${k === c ? 'checked' : ''}><span>${l}</span></label>`).join('')}</fieldset>`;

  if (!rows.length) {
    root.innerHTML = `<div class="section-title">${cabinSeg}</div>
      <div class="empty"><div class="empty-icon" aria-hidden="true">🪑</div><p>這個艙等在所選日期沒有獎勵位，試試其他艙等、日期或目的地。</p></div>`;
    bindCabin(root);
    return;
  }

  const deals = [...rows].sort((a, b) => a.cabins[c].miles - b.cabins[c].miles).slice(0, 4);
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
    <h2 class="section-title">最划算的選擇 <small>點卡片看航班明細</small></h2>
    <div class="best">${dealHtml}</div>
    <h2 class="section-title">日曆 <small>每天最低里程，顏色越深越便宜；點日期篩選下表</small></h2>
    ${calendarHtml(rows)}
    <h2 class="section-title">各計畫比較 <small>點計畫名稱可隱藏／顯示</small></h2>
    <div class="filters">${chips}</div>
    ${matrixHtml(rows, allSources.filter((s) => !state.hidden.has(s)))}`;

  bindCabin(root);
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
  for (const g of grid.values()) for (const r of Object.values(g)) low = Math.min(low, r.cabins[c].miles || Infinity);
  const keys = [...grid.keys()].sort();
  const cell = (r) => {
    const x = r && r.cabins[c];
    if (!x) return '<td class="cell none">·</td>';
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
function tripHtml(t) {
  const taxes = t.taxes != null ? `${esc(t.taxesSymbol || '')}${fmt(t.taxes / 100)} ${esc(t.taxesCurrency || '')}` : '稅金未提供';
  const dur = t.durationMin ? `${Math.floor(t.durationMin / 60)} 小時 ${t.durationMin % 60} 分` : '';
  return `<div class="trip">
    <div class="trip-top">
      <div><b>${esc(t.flightNumbers)}</b><span class="pill">${esc(CABIN_ZH[t.cabin] || t.cabin)}</span><span class="pill">${t.stops ? `轉機 ${t.stops} 次` : '直飛'}</span>${t.seats ? `<span class="pill">剩 ${t.seats} 位</span>` : ''}</div>
      <div><span class="miles">${fmt(t.miles)} 哩</span> ＋ ${taxes}</div>
    </div>
    ${t.segments.map((s) => `<div class="seg-line"><b>${esc(s.flight)}</b><span>${esc(s.from)} ${hhmm(s.departsAt)} → ${esc(s.to)} ${hhmm(s.arrivesAt)}　${esc(s.aircraft || '')}${s.fareClass ? `　艙等代碼 ${esc(s.fareClass)}` : ''}</span></div>`).join('')}
    ${dur ? `<div class="hint" style="margin-top:6px">總飛行時間 ${dur}</div>` : ''}
  </div>`;
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
$('#explore-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const params = new URLSearchParams();
  for (const [k, v] of f) if (v) params.set(k, v);
  const cabin = f.get('cabin');
  const status = $('#explore-status');
  status.className = 'status';
  status.textContent = '正在探索…';
  $('#explore-results').innerHTML = skeleton(6);
  try {
    const body = await api(`/api/explore?${params}`);
    const rows = body.results.filter((r) => r.cabins[cabin].available).sort((a, b) => a.cabins[cabin].miles - b.cabins[cabin].miles);
    status.innerHTML = `<span>找到 <b>${body.total ?? rows.length}</b> 筆${body.mock ? '（示範資料）' : ''}，依里程由低到高排序${rows.length < (body.total || 0) ? `，顯示前 ${rows.length} 筆` : ''}。</span>`;
    $('#explore-results').innerHTML = rows.length ? `<div class="table-wrap"><table>
      <thead><tr><th>日期</th><th>航線</th><th>里程</th><th>航空公司</th><th>直飛</th><th>剩餘座位</th></tr></thead>
      <tbody>${rows.map((r) => { const c = r.cabins[cabin]; return `<tr class="click" data-id="${esc(r.id)}" data-title="${esc(titleOf(r))}">
        <td><span class="d">${mmdd(r.date)}</span>（${dowOf(r.date)}）</td><td><b>${esc(r.origin)}</b> → <b>${esc(r.destination)}</b></td>
        <td><b style="color:var(--accent)">${fmt(c.miles)}</b></td><td>${esc(c.airlines)}</td><td>${c.direct ? '✓' : ''}</td><td>${c.seats || '—'}</td></tr>`; }).join('')}</tbody>
    </table></div>` : '<div class="empty"><div class="empty-icon">🔭</div><p>沒有找到獎勵位，換個區域或日期試試。</p></div>';
    $$('#explore-results tr.click').forEach((tr) => tr.addEventListener('click', () => openTrips(tr.dataset.id, tr.dataset.title, cabin)));
  } catch (err) {
    status.className = 'status error';
    status.textContent = err.message;
    $('#explore-results').innerHTML = '';
  }
});

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
  const [config, ...files] = await Promise.all(['/api/config', ...['airlines', 'alliances', 'airports', 'programs', 'glossary'].map((n) => `/api/data/${n}`)].map(api));
  [data.airlines, data.alliances, data.airports, data.programs, data.glossary] = files;
  $('#mock-banner').hidden = !config.mock;

  $('#airport-list').innerHTML = data.airports.airports.map((a) => `<option value="${a.code}">${esc(a.city)}</option>`).join('');
  const carrierSel = $('#search-form [name=carrier]');
  carrierSel.insertAdjacentHTML('beforeend', data.airlines.airlines.map((a) => `<option value="${a.code}">${esc(a.name)}（${a.code}）</option>`).join(''));
  carrierSel.addEventListener('change', carrierHint);

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
