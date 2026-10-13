const SOURCE_NAMES = {
  aeroplan: '加航 Aeroplan', united: '聯合 MileagePlus', alaska: '阿拉斯加 Atmos', american: '美航 AAdvantage',
  delta: '達美 SkyMiles', flyingblue: '法荷航 Flying Blue', virginatlantic: '維珍 Flying Club', qantas: '澳航 Frequent Flyer',
  lufthansa: '漢莎 Miles&More', turkish: '土航 Miles&Smiles', singapore: '新航 KrisFlyer', eurobonus: 'SAS EuroBonus',
  ethiopian: '衣索比亞 ShebaMiles', aeromexico: '墨航 Club Premier', etihad: '阿提哈德 Guest', emirates: '阿聯酋 Skywards',
  qatar: '卡達 Privilege Club', velocity: '維珍澳洲 Velocity', smiles: 'GOL Smiles', azul: 'Azul TudoAzul',
  connectmiles: 'Copa ConnectMiles', jetblue: 'JetBlue TrueBlue', saudia: '沙烏地 AlFursan', finnair: '芬航 Finnair Plus',
};
const CABIN_LABEL = { Y: '經濟艙', W: '豪華經濟', J: '商務艙', F: '頭等艙' };
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (n ? Number(n).toLocaleString('zh-TW') : '—');
const srcName = (s) => SOURCE_NAMES[s] || s;
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

// ---------- tabs ----------
function showTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('.panel').forEach((p) => (p.hidden = p.id !== `tab-${name}`));
  history.replaceState(null, '', `#${name}`);
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ---------- search ----------
let lastResults = [];
let viewCabin = 'J';

function carrierHint() {
  const code = $('#search-form [name=carrier]').value;
  const a = data.airlines.airlines.find((x) => x.code === code);
  $('#carrier-hint').textContent = a
    ? `${a.name}的座位可在這些計畫查到：${a.bookableVia.map(srcName).join('、')}。` +
      (a.homeProgram && !a.bookableVia.includes(a.homeProgram) ? ' 自家計畫未收錄於 seats.aero，詳見規則庫。' : '')
    : '';
}

$('#search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const params = new URLSearchParams({ origin: f.get('origin'), destination: f.get('destination'), start: f.get('start'), end: f.get('end') });
  if (f.get('carrier')) params.set('carriers', f.get('carrier'));
  if (f.get('cabin')) params.set('cabin', f.get('cabin'));
  if (f.get('direct')) params.set('direct', '1');
  viewCabin = f.get('cabin') || 'J';
  const status = $('#search-status');
  status.className = 'status';
  status.textContent = '查詢中…';
  $('#search-results').innerHTML = '';
  try {
    const body = await api(`/api/search?${params}`);
    lastResults = body.results;
    status.textContent = `找到 ${body.results.length} 筆可用日期與計畫組合${body.mock ? '（示範資料）' : ''}。`;
    renderSearch();
  } catch (err) {
    status.className = 'status error';
    status.textContent = err.message;
  }
});

function renderSearch() {
  const root = $('#search-results');
  const rows = lastResults.filter((r) => r.cabins[viewCabin].available);
  const sources = [...new Set(lastResults.map((r) => r.source))].sort();

  const best = {};
  for (const r of rows) {
    const m = r.cabins[viewCabin].miles;
    if (m && (!best[r.source] || m < best[r.source])) best[r.source] = m;
  }
  const chips = Object.entries(best).sort((a, b) => a[1] - b[1])
    .map(([s, m]) => `<span class="chip">${esc(srcName(s))} 最低 <b>${fmt(m)}</b></span>`).join('');

  // date × route rows, program columns
  const keyOf = (r) => `${r.date} ${r.origin}→${r.destination}`;
  const grid = new Map();
  for (const r of lastResults) {
    if (!grid.has(keyOf(r))) grid.set(keyOf(r), {});
    grid.get(keyOf(r))[r.source] = r;
  }
  const keys = [...grid.keys()].sort();
  const toggle = Object.entries(CABIN_LABEL)
    .map(([c, l]) => `<button type="button" data-cabin="${c}" class="${c === viewCabin ? 'on' : ''}">${l}</button>`).join('');

  root.innerHTML = `
    <div class="cabin-toggle">${toggle}</div>
    <div class="chips">${chips || '<span class="hint">此艙等沒有可用座位，試試其他艙等或日期。</span>'}</div>
    <div class="table-wrap"><table>
      <thead><tr><th>日期 / 航線</th>${sources.map((s) => `<th>${esc(srcName(s))}</th>`).join('')}</tr></thead>
      <tbody>${keys.map((k) => `<tr><td>${esc(k)}</td>${sources.map((s) => cell(grid.get(k)[s])).join('')}</tr>`).join('')}</tbody>
    </table></div>`;
  root.querySelectorAll('.cabin-toggle button').forEach((b) => b.addEventListener('click', () => { viewCabin = b.dataset.cabin; renderSearch(); }));
  root.querySelectorAll('td.cell[data-id]').forEach((td) => td.addEventListener('click', () => openTrips(td.dataset.id, td.dataset.title, viewCabin)));
}

function cell(r) {
  const c = r && r.cabins[viewCabin];
  if (!c || !c.available) return '<td class="cell none">—</td>';
  const cls = c.seats && c.seats <= 1 ? 'few' : 'good';
  const seats = c.seats ? ` · ${c.seats} 位` : '';
  const title = `${r.date} ${r.origin}→${r.destination} · ${srcName(r.source)}`;
  return `<td class="cell ${cls}" data-id="${esc(r.id)}" data-title="${esc(title)}">${fmt(c.miles)}<small>${esc(c.airlines)}${c.direct ? ' 直飛' : ''}${seats}</small></td>`;
}

const CABIN_API = { Y: 'economy', W: 'premium', J: 'business', F: 'first' };

function tripHtml(t) {
  return `
      <div class="trip">
        <div><b>${esc(t.flightNumbers)}</b> · ${esc(t.cabin)} · ${fmt(t.miles)} 哩 + ${esc(t.taxesSymbol || '')}${t.taxes != null ? fmt(t.taxes / 100) : '—'} ${esc(t.taxesCurrency || '')} · 剩 ${t.seats ?? '?'} 位 · ${t.stops ? `${t.stops} 次轉機` : '直飛'}</div>
        ${t.segments.map((s) => `<div class="seg">${esc(s.flight)} ${esc(s.from)} ${esc((s.departsAt || '').slice(11, 16))} → ${esc(s.to)} ${esc((s.arrivesAt || '').slice(11, 16))} · ${esc(s.aircraft || '')} · 艙等代碼 ${esc(s.fareClass || '—')}</div>`).join('')}
      </div>`;
}

async function openTrips(id, title, cabin) {
  const dlg = $('#trip-dialog');
  $('#trip-title').textContent = title;
  $('#trip-body').innerHTML = '<p class="status">載入航班中…</p>';
  dlg.showModal();
  try {
    const body = await api(`/api/trips/${encodeURIComponent(id)}`);
    const links = body.bookingLinks.map((l) => `<a href="${esc(l.link)}" target="_blank" rel="noopener">${esc(l.label)}</a>`).join(' · ');
    const want = CABIN_API[cabin];
    const byMiles = (a, b) => a.miles - b.miles || a.stops - b.stops;
    const main = body.trips.filter((t) => !want || t.cabin === want).sort(byMiles);
    const rest = body.trips.filter((t) => want && t.cabin !== want).sort(byMiles);
    $('#trip-body').innerHTML = (links ? `<p>${links}</p>` : '') +
      (main.map(tripHtml).join('') || '<p class="hint">此艙等沒有航班明細。</p>') +
      (rest.length ? `<details><summary class="hint">其他艙等 ${rest.length} 筆</summary>${rest.map(tripHtml).join('')}</details>` : '');
  } catch (err) {
    $('#trip-body').innerHTML = `<p class="status error">${esc(err.message)}</p>`;
  }
}
$('#trip-close').addEventListener('click', () => $('#trip-dialog').close());

// ---------- explore ----------
$('#explore-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const params = new URLSearchParams();
  for (const [k, v] of f) if (v) params.set(k, v);
  const cabin = f.get('cabin');
  const status = $('#explore-status');
  status.className = 'status';
  status.textContent = '探索中…';
  $('#explore-results').innerHTML = '';
  try {
    const body = await api(`/api/explore?${params}`);
    const rows = body.results.filter((r) => r.cabins[cabin].available).sort((a, b) => a.cabins[cabin].miles - b.cabins[cabin].miles);
    status.textContent = `找到 ${rows.length} 筆${body.mock ? '（示範資料）' : ''}，依里程由低到高排序。`;
    $('#explore-results').innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>日期</th><th>航線</th><th>里程</th><th>航空公司</th><th>直飛</th><th>剩餘座位</th></tr></thead>
      <tbody>${rows.slice(0, 300).map((r) => { const c = r.cabins[cabin]; return `<tr class="click" data-id="${esc(r.id)}" data-title="${esc(`${r.date} ${r.origin}→${r.destination} · ${srcName(r.source)}`)}">
        <td>${esc(r.date)}</td><td>${esc(r.origin)} → ${esc(r.destination)}</td><td>${fmt(c.miles)}</td><td>${esc(c.airlines)}</td><td>${c.direct ? '是' : ''}</td><td>${c.seats || '—'}</td></tr>`; }).join('')}</tbody>
    </table></div>`;
    document.querySelectorAll('#explore-results tr.click').forEach((tr) => tr.addEventListener('click', () => openTrips(tr.dataset.id, tr.dataset.title, cabin)));
  } catch (err) {
    status.className = 'status error';
    status.textContent = err.message;
  }
});

// ---------- rules ----------
function renderRules() {
  const { alliances, programs, glossary, airlines } = data;
  const airlineName = Object.fromEntries(airlines.airlines.map((a) => [a.code, a.name]));
  const allianceCards = alliances.alliances.map((a) => `
    <div class="card"><h3>${esc(a.name)}</h3><p>${esc(a.summary)}</p>
    <p class="hint">成員代碼：${a.members.map((m) => esc(airlineName[m] ? `${m} ${airlineName[m]}` : m)).join('、')}</p>
    <a href="${esc(a.url)}" target="_blank" rel="noopener">官方成員名單</a></div>`).join('');
  const fieldRows = Object.entries(programs.fields);
  const programCards = programs.programs.map((p) => `
    <div class="card"><h3>${esc(p.name)}${p.confidence === 'verify' ? '<span class="tag verify">待核實</span>' : ''}${p.seatsAeroSource ? '<span class="tag">seats.aero 有收錄</span>' : ''}</h3>
    <dl>${fieldRows.map(([k, label]) => `<dt>${esc(label)}</dt><dd>${esc(p[k])}</dd>`).join('')}</dl>
    <p class="hint">${esc(p.notes)}</p><a href="${esc(p.officialUrl)}" target="_blank" rel="noopener">官方網站</a></div>`).join('');
  const gloss = glossary.sections.map((s) => `
    <h2 class="section">${esc(s.title)}</h2><div class="cards">${s.items.map((i) => `<div class="card"><h3>${esc(i.term)}</h3><p>${esc(i.desc)}</p></div>`).join('')}</div>`).join('');
  $('#rules').innerHTML = `
    <p class="hint">${esc(programs.disclaimer)}（最後整理：${esc(programs.lastReviewed)}）</p>
    <h2 class="section">航空聯盟</h2><div class="cards">${allianceCards}</div>
    <h2 class="section">里程計畫規則</h2><div class="cards">${programCards}</div>
    ${gloss}`;
}

// ---------- init ----------
(async function init() {
  const [config, ...files] = await Promise.all(['/api/config', ...['airlines', 'alliances', 'airports', 'programs', 'glossary'].map((n) => `/api/data/${n}`)].map(api));
  [data.airlines, data.alliances, data.airports, data.programs, data.glossary] = files;
  $('#mock-banner').hidden = !config.mock;

  $('#airport-list').innerHTML = data.airports.airports.map((a) => `<option value="${a.code}">${esc(a.city)}</option>`).join('');
  const carrierSel = $('#search-form [name=carrier]');
  carrierSel.insertAdjacentHTML('beforeend', data.airlines.airlines.map((a) => `<option value="${a.code}">${esc(a.name)} (${a.code})</option>`).join(''));
  carrierSel.addEventListener('change', carrierHint);

  const sources = [...new Set(data.airlines.airlines.flatMap((a) => a.bookableVia))].sort();
  $('#explore-form [name=program]').innerHTML = sources.map((s) => `<option value="${s}">${esc(srcName(s))}</option>`).join('');
  const regionOpts = '<option value="">全部</option>' + data.airports.regions.map((r) => `<option value="${r}">${esc(data.airports.regionNames[r])}</option>`).join('');
  $('#explore-form [name=origin_region]').innerHTML = regionOpts;
  $('#explore-form [name=destination_region]').innerHTML = regionOpts;
  $('#explore-form [name=origin_region]').value = 'Asia';
  $('#explore-form [name=destination_region]').value = 'North America';

  for (const form of ['#search-form', '#explore-form']) {
    $(`${form} [name=start]`).value = isoDate(30);
    $(`${form} [name=end]`).value = isoDate(44);
  }
  renderRules();
  showTab(['search', 'explore', 'rules'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'search');
})().catch((err) => {
  $('#search-status').className = 'status error';
  $('#search-status').textContent = `初始化失敗：${err.message}`;
});
