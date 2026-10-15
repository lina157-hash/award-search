// Program names by seats.aero source code, loaded from data/source-names.json at start.
let SOURCE_NAMES = {};
const CABIN_LABEL = { Y: '經濟艙', W: '豪華經濟艙', J: '商務艙', F: '頭等艙' };
const CABIN_API = { Y: 'economy', W: 'premium', J: 'business', F: 'first' };
const CABIN_ZH = { economy: '經濟艙', premium: '豪華經濟艙', business: '商務艙', first: '頭等艙' };
const DOW = ['日', '一', '二', '三', '四', '五', '六'];

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (n == null || n === '' || Number.isNaN(Number(n)) ? '—' : Number(n).toLocaleString('zh-TW'));
const kfmt = (n) => (n >= 10000 ? `${(n / 10000).toFixed(n % 10000 ? 1 : 0)}萬` : fmt(n));
const srcName = (s) => SOURCE_NAMES[s] || s;
const dowOf = (iso) => DOW[new Date(iso + 'T00:00:00Z').getUTCDay()];
const mmdd = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
const hhmm = (iso) => (iso || '').slice(11, 16);
const data = {};

// Chinese airline names (data/airline-names.json): by IATA code, and by the English names fare sources write.
const AL = { zh: new Map(), byName: new Map(), defunct: {} };
const alKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
function indexAirlineNames(d) {
  for (const [code, zh, ...en] of d?.airlines || []) {
    if (!AL.zh.has(code)) AL.zh.set(code, zh);
    for (const n of en) if (alKey(n) && !AL.byName.has(alKey(n))) AL.byName.set(alKey(n), code);
  }
  AL.defunct = d?.defunct || {};
}
// 長榮航空 for BR; falls back to airlines.json, then the code itself.
const airlineZh = (code) => AL.zh.get(code) || data.airlines?.airlines.find((a) => a.code === code)?.name || code;
// The code for an English name such as "EVA Air" (cash fares), or '' when unknown.
const airlineCodeOf = (name) => AL.byName.get(alKey(name)) || '';
// 「長榮航空（BR）」, or just the code when there is no Chinese name.
const airlineLabel = (code) => (airlineZh(code) !== code ? `${airlineZh(code)}（${code}）` : code);
// "BR, NH" → 長榮航空、全日空 with each code in a tooltip (compact places: cells, tables, cards).
const carriersHtml = (list) => String(list || '').split(/[,\s]+/).filter(Boolean)
  .map((c) => (airlineZh(c) !== c ? `<span class="al" title="${esc(c)}">${esc(airlineZh(c))}</span>` : esc(c))).join('、');
// The comparison table's compact form: each operating airline as a small logo (name on hover), at most 3 then 「+N」.
const carrierLogosHtml = (list) => {
  const codes = [...new Set(String(list || '').split(/[,\s]+/).filter(Boolean))];
  if (typeof airlineMark !== 'function') return carriersHtml(list);
  const one = (c) => airlineMark(c, esc(airlineZh(c))) || `<span class="mx-al" title="${esc(airlineZh(c))}">${esc(c)}</span>`;
  return codes.length ? `<span class="mx-als" title="${esc(codes.map(airlineZh).join('、'))}">${codes.slice(0, 3).map(one).join('')}${codes.length > 3 ? `<span class="mx-more">+${codes.length - 3}</span>` : ''}</span>` : '';
};
// A fare source's English airline name → Chinese, with the original in a tooltip.
const airlineNameHtml = (name, flight) => {
  const code = airlineCodeOf(name) || (/^[A-Z0-9]{2}\s?\d/.test(flight || '') ? flight.slice(0, 2) : '');
  const zh = code && AL.zh.get(code);
  return zh ? `<span class="al" title="${esc(name || code)}">${esc(zh)}</span>` : esc(name || '');
};

// Release version from this script's own URL (index.html loads it as app.js?v=1.15.0); keys the bundled data request.
const ASSET_V = (() => { try { return new URL(document.currentScript.src).searchParams.get('v') || ''; } catch { return ''; } })();

// x-requested-with tells the server the request comes from this page (another site cannot send it), so a signed-in,
// unlocked account counts only here.
async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, { ...opts, headers: { 'x-requested-with': 'fetch', ...(opts.headers || {}) } });
  } catch (err) {
    // fetch only throws on a network failure ("Failed to fetch"); say it in words people understand.
    throw Object.assign(new Error('連不上伺服器，請檢查網路後再試。'), { code: 'offline', cause: err });
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { code: body.code, status: res.status });
  return body;
}

// Each async view keeps a request counter so a slow older response cannot overwrite a newer one.
const seq = { search: 0, trips: 0, explore: 0, cash: 0, returns: 0, booking: 0, cashMonth: 0 };
const latest = (key) => { const n = ++seq[key]; return () => n === seq[key]; };

// Per-device preferences (recent searches, favourites, the cash passcode). Storage can be unavailable in private mode.
const store = {
  get(key, fallback) { try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ } },
  del(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
};

// "3 小時前" for a timestamp; seats.aero rows carry when they were last refreshed.
function ago(iso) {
  if (!iso) return '';
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (min < 60) return min < 2 ? '剛剛' : `${min} 分鐘前`;
  if (min < 48 * 60) return `${Math.round(min / 60)} 小時前`;
  return `${Math.round(min / 1440)} 天前`;
}
const isStale = (iso) => iso && Date.now() - Date.parse(iso) > 24 * 3600e3;
const taxText = (t) => `${t.symbol || (t.currency ? `${t.currency} ` : '')}${fmt(Math.round(t.amount))}${t.symbol || t.currency ? '' : '（幣別未標）'}`;

// Calendar date in the visitor's own time zone.
function isoDate(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isoDateFrom(iso, offsetDays) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

// A short message at the bottom; `action` ({ label, run }) adds a button and keeps it up longer.
function toast(msg, action) {
  const t = $('#toast');
  t.textContent = msg;
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = action.label;
    b.addEventListener('click', () => { t.hidden = true; action.run(); });
    t.append(b);
  }
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), action ? 6000 : 2200);
}

const skeleton = (n = 4) => `<div class="skeleton">${'<div></div>'.repeat(n)}</div>`;

// ---------- tabs ----------
const TABS = ['search', 'explore', 'map', 'cash', 'hotels', 'points', 'rules'];
// Each tab keeps its own query string, so one tab's search parameters don't leak into another tab's URL.
const tabQuery = {};
const tabSub = {}; // sub-view in the hash, e.g. #points/wallet
let currentTab = 'search';
// Tabs that render or fetch something on first open instead of on every page load.
const tabInit = {};
const tabDone = new Set();
// Run each time a tab is shown (features.js: maps re-measure, 兌換地圖 follows wallet changes).
const tabShown = {};
let dataReady = false;
// Tabs drawn from the second data part (points, charts, rules); they wait for it on first open.
const NEEDS_MORE = { rules: '#rules', points: '#points-page', map: '#map-page', hotels: '#hotels-page' };
function ensureTab(tab) {
  if (!dataReady || tabDone.has(tab) || !tabInit[tab]) return;
  if (NEEDS_MORE[tab] && !moreReady) {
    const host = $(NEEDS_MORE[tab]);
    if (host && !host.children.length) host.innerHTML = skeleton(4);
    loadMore().then(() => ensureTab(tab), () => {
      if (!host) return;
      host.innerHTML = '<div class="status error"><span>資料載入失敗，請檢查網路後再試。</span><button type="button" class="outline retry">重試</button></div>';
      $('.retry', host).addEventListener('click', () => ensureTab(tab));
    });
    return;
  }
  tabDone.add(tab);
  tabInit[tab]();
}
const tabHash = (tab) => (tabSub[tab] ? `${tab}/${tabSub[tab]}` : tab);
function showTab(name) {
  const [tab, sub] = name.split('/');
  if (sub) tabSub[tab] = sub;
  currentTab = tab;
  // One tab stop for the strip; the arrow keys move between tabs (below).
  $$('.tabs button').forEach((b) => { b.setAttribute('aria-selected', String(b.dataset.tab === tab)); b.tabIndex = b.dataset.tab === tab ? 0 : -1; });
  // On phones the tab strip scrolls sideways; keep the open tab in view.
  const tb = $(`.tabs [data-tab="${tab}"]`);
  const strip = tb?.parentElement;
  if (strip && strip.scrollWidth > strip.clientWidth) strip.scrollLeft = Math.max(0, tb.offsetLeft - strip.offsetLeft - 40);
  $$('.panel').forEach((p) => (p.hidden = p.id !== `tab-${tab}`));
  history.replaceState(null, '', `${location.pathname}${tabQuery[tab] || ''}#${tabHash(tab)}`);
  ensureTab(tab);
  tabShown[tab]?.();
}
// Record a tab's query string, and show it in the address bar when that tab is open.
function setTabUrl(tab, query) {
  tabQuery[tab] = query && String(query) ? `?${query}` : '';
  if (currentTab === tab) history.replaceState(null, '', `${location.pathname}${tabQuery[tab]}#${tabHash(tab)}`);
}
const tabParams = (tab) => new URLSearchParams(tabQuery[tab] || '');
$$('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
$('.tabs').addEventListener('keydown', (e) => {
  const list = $$('.tabs button');
  const i = list.indexOf(e.target);
  const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: list.length - 1 }[e.key];
  if (i < 0 || to == null) return;
  e.preventDefault();
  const b = list[(to + list.length) % list.length];
  showTab(b.dataset.tab);
  b.focus();
});
// The hash as the page was opened (account.js reads mail links like #verify=… after showTab has replaced it).
const BOOT_HASH = location.hash;
// Open the linked tab right away (before the data loads) and hand the incoming query to the tab it belongs to.
{
  const q = new URLSearchParams(location.search);
  if (q.get('x')) tabQuery.explore = location.search;
  else if (q.get('o')) tabQuery.search = location.search;
  const h = location.hash.slice(1);
  showTab(TABS.includes(h.split('/')[0]) ? h : 'search');
}
// showTab writes the hash with replaceState, which fires no hashchange; this is for the hash edited by hand, a bookmark
// opened in the same tab, or an in-page #link.
addEventListener('hashchange', () => {
  const h = location.hash.slice(1);
  const [tab, sub] = h.split('/');
  if (!TABS.includes(tab)) return;
  if (tab === 'points') {
    const v = POINTS_VIEWS.includes(sub) ? sub : 'calc';
    const redraw = v !== pointsView.view && tabDone.has('points');
    setPointsView(v);
    showTab('points');
    if (redraw) renderPoints();
    return;
  }
  showTab(h);
});
// The sticky header's height (it differs by width and when the 登入 button appears), for bars that stick below it.
{
  const setHdr = () => document.documentElement.style.setProperty('--hdr-h', `${$('.top').offsetHeight}px`);
  setHdr();
  if (window.ResizeObserver) new ResizeObserver(setHdr).observe($('.top'));
}
// Bring a status line into view when it is off screen (on phones the results start far below the form).
function reveal(el) {
  const r = el.getBoundingClientRect();
  if (r.top < 0 || r.top > innerHeight - 80) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
// Error text plus a 重試 button in a status line.
function showError(status, err, retry) {
  status.className = 'status error';
  status.innerHTML = `<span>${esc(err.message || err)}</span>${retry ? '<button type="button" class="outline retry">重試</button>' : ''}`;
  if (retry) $('.retry', status).addEventListener('click', retry);
  reveal(status);
}
// Disable a submit button while its request runs; returns the function that restores it.
function busy(btn, text) {
  if (!btn) return () => {};
  if (!btn.dataset.label) btn.dataset.label = btn.textContent;
  btn.disabled = true;
  btn.textContent = text;
  return () => { btn.disabled = false; btn.textContent = btn.dataset.label; };
}

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
  const x = r.cabins?.[cabin];
  if (!x?.available) return null;
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
      (a.homeProgram && !a.bookableVia.includes(a.homeProgram) ? '（自家哩程計畫未收錄於 seats.aero，規則見規則庫）' : '')
    : ALLIANCE_HINT[al] || '';
}

// ---------- airport autocomplete ----------
// Full list (3,000+ airports) loads from /airports.min.json; tokens are comma separated, the last one is completed.
const AP = { list: [], byCode: new Map(), groups: [], rank: new Map() };
const COUNTRY_ZH = { TW: '台灣', HK: '香港', MO: '澳門', CN: '中國', KR: '韓國', KP: '北韓', AE: '阿聯酋' };
// The Intl formatters load ICU data, so they are created on first use rather than while the page starts.
const regionName = (() => {
  const make = (lang) => { try { return new Intl.DisplayNames([lang], { type: 'region' }); } catch { return null; } };
  let zh, en;
  const safe = (dn, cc) => { try { return dn?.of(cc) || ''; } catch { return ''; } };
  return (cc) => {
    if (zh === undefined) { zh = make('zh-Hant-TW'); en = make('en'); }
    return { zh: COUNTRY_ZH[cc] || safe(zh, cc) || cc, en: safe(en, cc) };
  };
})();
const normQ = (s) => s.trim().replace(/臺/g, '台');
const splitCodes = (v) => v.split(/\s*[,，、]\s*/);

// The list is 270 KB, so it loads only when an airport field is first used (or a view that needs coordinates opens).
let airportsP = null;
const airportsWaiting = [];
const onAirports = (fn) => (AP.loaded ? fn() : airportsWaiting.push(fn));
const loadAirports = () => (airportsP ||= fetch(`/airports.min.json${ASSET_V ? `?v=${ASSET_V}` : ''}`).then((r) => r.json()).then((body) => {
  AP.groups = body.groups.map((g) => ({ ...g, enL: g.en.toLowerCase() }));
  for (const g of AP.groups) g.codes.forEach((c, i) => AP.rank.set(c, i)); // main airport first on ties
  AP.list = body.airports.map(([code, city, name, country, , large, zh, alt, lat, lon]) => {
    const c = regionName(country);
    const a = { code, city, name, country, large, zh, alt, lat, lon, cn: c.zh, cnL: c.en.toLowerCase(), cityL: city.toLowerCase(), altL: alt.toLowerCase() };
    a.words = `${city} ${alt} ${name}`.toLowerCase().split(/[\s\-/'.]+/).filter(Boolean);
    a.hay = `${city} ${alt} ${name} ${c.en}`.toLowerCase();
    return a;
  });
  for (const a of AP.list) AP.byCode.set(a.code, a);
  AP.loaded = true;
  airportsWaiting.splice(0).forEach((fn) => fn());
}).catch(() => { airportsP = null; }));

function apScore(a, q, ql, qu) {
  if (a.code === qu) return 100;
  let s = 0;
  if (/^[A-Z]{1,2}$/.test(qu) && a.code.startsWith(qu)) s = 70;
  if (a.zh) s = Math.max(s, a.zh === q ? 92 : a.zh.startsWith(q) ? 85 : a.zh.includes(q) ? 75 : 0);
  if (a.cityL === ql || a.altL === ql) s = Math.max(s, 80);
  else if (ql.length >= 2 && (a.cityL.startsWith(ql) || a.altL.startsWith(ql))) s = Math.max(s, 65);
  else if (ql.length >= 2 && a.words.some((w) => w.startsWith(ql))) s = Math.max(s, 50);
  if (a.cn.startsWith(q) || (ql.length >= 3 && a.cnL.startsWith(ql))) s = Math.max(s, 40);
  if (!s && ql.length >= 3 && a.hay.includes(ql)) s = 20;
  return s && s + a.large * 8 + (a.zh ? 3 : 0) + (a.country === 'TW' ? 1 : 0);
}

function apSuggest(raw, limit = 10) {
  const q = normQ(raw);
  if (!q) return [];
  const ql = q.toLowerCase();
  const qu = q.toUpperCase();
  const out = [];
  for (const g of AP.groups) {
    const s = g.zh === q || g.enL === ql ? 99 : g.zh.startsWith(q) || (ql.length >= 2 && g.enL.startsWith(ql)) ? 88 : 0;
    if (s) out.push({ s, group: g });
  }
  for (const a of AP.list) {
    const s = apScore(a, q, ql, qu);
    if (s) out.push({ s, a });
  }
  const tie = (x) => (x.a ? AP.rank.get(x.a.code) ?? 9 : -1);
  return out.sort((x, y) => y.s - x.s || tie(x) - tie(y) || (x.a?.code || '').localeCompare(y.a?.code || '')).slice(0, limit);
}

// Turn what the user typed (codes, Chinese or English names) into IATA codes for the API.
function resolveAirports(value) {
  const codes = [];
  const unknown = [];
  for (const t of splitCodes(value).filter(Boolean)) {
    if (/^[A-Za-z]{3}$/.test(t)) { codes.push(t.toUpperCase()); continue; }
    const best = apSuggest(t, 1)[0];
    if (best) codes.push(...(best.group ? best.group.codes : [best.a.code]));
    else unknown.push(t);
  }
  return { codes: [...new Set(codes)], unknown };
}

// Airport field with chips: each picked airport is a removable chip, so several can be searched at once.
// The hidden input (name=origin / destination) keeps the comma-separated codes the rest of the page reads.
const MAX_AIRPORTS = 10;
function createAirportPicker(form, name) {
  const hidden = form[name];
  const box = $(`.chips-box[data-for=${name}]`, form);
  const q = $('input.chips-q', box);
  const list = document.getElementById(q.getAttribute('aria-controls'));
  const label = q.labels[0].textContent;
  let items = [];
  let active = -1;

  const codes = () => hidden.value.split(',').filter(Boolean);
  const renderChips = () => {
    $('.chips', box).innerHTML = codes().map((c) => {
      const a = AP.byCode.get(c);
      const nm = a ? a.zh || a.city : data.airportNames?.names?.[c] || '';
      return `<span class="chip" title="${esc(a ? `${a.name}（${a.cn}）` : c)}"><b>${esc(c)}</b>${nm ? `<small>${esc(nm)}</small>` : ''}<button type="button" data-rm="${esc(c)}" aria-label="移除 ${esc(c)}">×</button></span>`;
    }).join('');
    q.placeholder = codes().length ? '＋ 加入機場' : '城市、機場或代碼';
  };
  const set = (list) => {
    const uniq = [...new Set(list.map((c) => String(c).trim().toUpperCase()).filter((c) => /^[A-Z]{3}$/.test(c)))];
    if (uniq.length > MAX_AIRPORTS) toast(`${label}最多 ${MAX_AIRPORTS} 個機場`);
    hidden.value = uniq.slice(0, MAX_AIRPORTS).join(',');
    renderChips();
    hidden.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const add = (more) => set([...codes(), ...more]);
  // Turn leftover typed text into chips; returns the parts that matched nothing.
  const commit = () => {
    const { codes: found, unknown } = resolveAirports(q.value);
    if (found.length) add(found);
    q.value = unknown.join(',');
    return unknown;
  };

  const close = () => { list.hidden = true; q.setAttribute('aria-expanded', 'false'); q.removeAttribute('aria-activedescendant'); active = -1; };
  const highlight = (i) => {
    active = i;
    $$('[role=option]', list).forEach((el, j) => el.classList.toggle('active', j === i));
    if (i >= 0) {
      q.setAttribute('aria-activedescendant', `${list.id}-${i}`);
      list.children[i].scrollIntoView({ block: 'nearest' });
    }
  };
  const render = () => {
    const have = new Set(codes());
    items = apSuggest(splitCodes(q.value).at(-1)).filter((it) => (it.group ? it.group.codes.some((c) => !have.has(c)) : !have.has(it.a.code)));
    if (!items.length) return close();
    list.innerHTML = items.map((it, i) => {
      if (it.group) {
        return `<div role="option" id="${list.id}-${i}" class="ac-item" data-i="${i}">
          <span class="ac-code multi">${it.group.codes.join(' ')}</span>
          <span class="ac-main">${esc(it.group.zh)}<small>全部 ${it.group.codes.length} 個機場</small></span>
          <span class="ac-sub">${esc(it.group.en)}</span></div>`;
      }
      const a = it.a;
      return `<div role="option" id="${list.id}-${i}" class="ac-item" data-i="${i}">
        <span class="ac-code">${a.code}</span>
        <span class="ac-main">${esc(a.zh || a.city)}<small>${esc(a.cn)}</small></span>
        <span class="ac-sub">${esc(a.name)}</span></div>`;
    }).join('');
    list.hidden = false;
    q.setAttribute('aria-expanded', 'true');
    highlight(0);
  };
  const choose = (i) => {
    const it = items[i];
    if (!it) return;
    add(it.group ? it.group.codes : [it.a.code]);
    q.value = '';
    close();
    q.focus();
  };

  q.addEventListener('focus', loadAirports, { once: true });
  q.addEventListener('input', () => loadAirports().then(() => {
    // A comma after a name or code (or a space after a 3-letter code) turns what came before it into chips.
    if (/^[A-Za-z]{3}\s+$/.test(q.value)) q.value = `${q.value.trim()},`;
    if (/[,，、]/.test(q.value)) {
      const parts = splitCodes(q.value);
      const tail = parts.pop();
      const { codes: found, unknown } = resolveAirports(parts.join(','));
      if (found.length) add(found);
      q.value = [...unknown, tail].filter(Boolean).join(',');
    }
    render();
  }));
  q.addEventListener('blur', close);
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !q.value && codes().length) { set(codes().slice(0, -1)); return; }
    if (list.hidden) {
      if (e.key === 'Enter' && q.value.trim()) { e.preventDefault(); commit(); }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); highlight((active + 1) % items.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight((active - 1 + items.length) % items.length); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); choose(active); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  list.addEventListener('mousedown', (e) => e.preventDefault());
  list.addEventListener('click', (e) => {
    const el = e.target.closest('[data-i]');
    if (el) choose(Number(el.dataset.i));
  });
  box.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) set(codes().filter((c) => c !== rm.dataset.rm));
    q.focus();
  });

  renderChips();
  onAirports(renderChips);
  return { codes, set, commit, label, focus: () => q.focus() };
}
const pickers = { origin: createAirportPicker($('#search-form'), 'origin'), destination: createAirportPicker($('#search-form'), 'destination') };

// ---------- date range picker ----------
// Pick departure dates by clicking a range on a calendar, or one date plus ± days (like seats.aero).
// Writes the hidden `start` / `end` inputs that the form submits.
const MAX_AHEAD_DAYS = 365; // seats.aero publishes award space about a year out
const FLEX_DAYS = [0, 1, 3, 7, 10, 14, 28, 60, 120, 150, 180];
const RANGE_PRESETS = [['未來 2 週', 13], ['未來 1 個月', 30], ['未來 3 個月', 91], ['未來半年', 182], ['一年內全部', MAX_AHEAD_DAYS]];
const dayCount = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5) + 1;
const clampIso = (iso, lo, hi) => (iso < lo ? lo : iso > hi ? hi : iso);
const monthAdd = (ym, n) => { const d = new Date(`${ym}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); };
const ymd = (iso) => `${iso.slice(0, 4) !== isoDate(0).slice(0, 4) ? `${iso.slice(0, 4)}/` : ''}${mmdd(iso)}`;
const dayLabel = (iso) => `${ymd(iso)}（${dowOf(iso)}）`;

// opts.single: one date only (cash fares, hotels), written to the hidden input named opts.name inside opts.field;
// opts.min / opts.maxDays narrow the selectable days.
function createDatePicker(form, label, opts = {}) {
  const single = Boolean(opts.single);
  const field = opts.field || $('.dp-field', form);
  const btn = $('.dp-btn', field);
  const startIn = single ? form.elements[opts.name] : form.elements.start;
  const endIn = single ? startIn : form.elements.end;
  // 「指定日期 ± 天數」 first (owner's choice); 「選擇日期範圍」 is for when that does not fit.
  const st = { mode: single ? 'single' : 'flex', flex: 3, center: null, anchor: null, hover: null, month: null };
  const dlg = document.createElement('dialog');
  dlg.className = 'dp';
  dlg.setAttribute('aria-label', `選擇${label}`);
  document.body.append(dlg);
  const uid = `dp-${form.id}${single ? `-${opts.name}` : ''}`;
  const lo = () => (opts.min && opts.min() > isoDate(0) ? opts.min() : isoDate(0));
  const hi = () => isoDate(opts.maxDays || MAX_AHEAD_DAYS);
  const months = () => (matchMedia('(max-width: 640px)').matches ? 1 : 2);

  function flexRange(center = st.center) {
    return [clampIso(isoDateFrom(center, -st.flex), lo(), hi()), clampIso(isoDateFrom(center, st.flex), lo(), hi())];
  }
  // The range to highlight: the pending pick while choosing an end date, else the current value.
  function shown() {
    if (st.mode === 'range' && st.anchor) {
      const h = st.hover || st.anchor;
      return h < st.anchor ? [h, st.anchor] : [st.anchor, h];
    }
    return [startIn.value, endIn.value];
  }
  function summary() {
    const [s, e] = shown();
    if (single) return s ? dayLabel(s) : '點選一天';
    if (!s) return '';
    if (st.mode === 'flex' && st.center) {
      return st.flex ? `${dayLabel(st.center)} 前後 ${st.flex} 天：${ymd(s)} – ${ymd(e)}，共 ${dayCount(s, e)} 天` : `只查 ${dayLabel(st.center)}`;
    }
    if (st.anchor) return `出發 ${dayLabel(st.anchor)}，請再點最後一天（點同一天＝只查這天）`;
    return s === e ? `只查 ${dayLabel(s)}` : `${dayLabel(s)} – ${dayLabel(e)}，共 ${dayCount(s, e)} 天`;
  }
  function updateButton() {
    const s = startIn.value;
    const e = endIn.value;
    let main;
    let sub = '';
    if (st.mode === 'flex' && st.center) {
      main = `${dayLabel(st.center)}${st.flex ? ` ±${st.flex} 天` : ''}`;
      if (st.flex) sub = `${ymd(s)} – ${ymd(e)}`;
    } else if (!s) {
      main = '選擇日期';
    } else {
      main = s === e ? dayLabel(s) : `${dayLabel(s)} – ${dayLabel(e)}`;
      if (s !== e) sub = `${dayCount(s, e)} 天`;
    }
    btn.classList.toggle('empty', !s);
    btn.innerHTML = `<span>${esc(main)}</span>${sub ? `<small>${esc(sub)}</small>` : ''}`;
    btn.setAttribute('aria-label', `${label}：${main}${sub ? `（${sub}）` : ''}，點選修改`);
  }
  function write(s, e) {
    const changed = startIn.value !== s || endIn.value !== e;
    startIn.value = s;
    endIn.value = e;
    updateButton();
    if (changed) startIn.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function monthHtml(ym) {
    const first = new Date(`${ym}-01T00:00:00Z`);
    const cells = DOW.map((d) => `<span class="dp-dow">${d}</span>`);
    for (let i = 0; i < first.getUTCDay(); i++) cells.push('<span></span>');
    const [l, h, t] = [lo(), hi(), isoDate(0)];
    for (const d = new Date(first); d.toISOString().slice(0, 7) === ym; d.setUTCDate(d.getUTCDate() + 1)) {
      const iso = d.toISOString().slice(0, 10);
      const off = iso < l || iso > h;
      cells.push(`<button type="button" class="dp-day${iso === t ? ' today' : ''}" data-date="${iso}" ${off ? 'disabled' : ''}>${d.getUTCDate()}</button>`);
    }
    return `<div class="dp-month"><div class="dp-mtitle">${ym.slice(0, 4)} 年 ${Number(ym.slice(5))} 月</div><div class="dp-grid">${cells.join('')}</div></div>`;
  }
  // Mark the highlighted range on the visible day buttons without re-rendering (keeps focus).
  function paint() {
    const [s, e] = shown();
    for (const b of $$('.dp-day', dlg)) {
      const d = b.dataset.date;
      const inR = s && d >= s && d <= e;
      b.classList.toggle('in', Boolean(inR));
      b.classList.toggle('start', d === s);
      b.classList.toggle('end', d === e);
      b.classList.toggle('center', st.mode === 'flex' && d === st.center);
      b.setAttribute('aria-pressed', String(Boolean(inR)));
    }
    $('.dp-sum', dlg).textContent = summary();
  }
  function render() {
    const n = months();
    const minM = lo().slice(0, 7);
    const maxM = hi().slice(0, 7);
    st.month = clampIso(st.month || minM, minM, monthAdd(maxM, 1 - n) < minM ? minM : monthAdd(maxM, 1 - n));
    const extra = single ? ''
      : st.mode === 'flex'
      ? `<div class="dp-chips" role="group" aria-label="前後天數">${FLEX_DAYS.map((n) => `<button type="button" class="dp-chip${n === st.flex ? ' on' : ''}" data-flex="${n}" aria-pressed="${n === st.flex}">${n ? `±${n} 天` : '只查這天'}</button>`).join('')}</div>
         <p class="dp-hint">先在日曆點一個日期當中心，再選前後要多找幾天。</p>`
      : `<div class="dp-chips" role="group" aria-label="快速選擇">${RANGE_PRESETS.map(([t, n]) => `<button type="button" class="dp-chip" data-preset="${n}">${t}</button>`).join('')}</div>
         <p class="dp-hint">在日曆點出發的第一天，再點最後一天。</p>`;
    dlg.innerHTML = `<div class="dp-in">
      <div class="dp-top">
        ${single ? `<b class="dp-title">${esc(label)}</b>` : `<fieldset class="seg dp-mode" aria-label="選擇方式">
          <label><input type="radio" name="${uid}-mode" value="range" ${st.mode === 'range' ? 'checked' : ''}><span>選擇日期範圍</span></label>
          <label><input type="radio" name="${uid}-mode" value="flex" ${st.mode === 'flex' ? 'checked' : ''}><span>指定日期 ± 天數</span></label>
        </fieldset>`}
        <button type="button" class="dp-x" aria-label="關閉">✕</button>
      </div>
      ${extra}
      <div class="dp-cal">
        <button type="button" class="dp-nav" data-nav="-1" aria-label="上個月" ${st.month <= minM ? 'disabled' : ''}>‹</button>
        <div class="dp-months">${Array.from({ length: n }, (_, i) => monthHtml(monthAdd(st.month, i))).join('')}</div>
        <button type="button" class="dp-nav" data-nav="1" aria-label="下個月" ${monthAdd(st.month, n - 1) >= maxM ? 'disabled' : ''}>›</button>
      </div>
      <div class="dp-foot"><span class="dp-sum" aria-live="polite"></span><button type="button" class="primary small dp-done">完成</button></div>
    </div>`;
    paint();
    place();
  }

  // Drop down under the field, moving up as needed to stay on screen.
  function place() {
    if (!dlg.open) return;
    if (months() === 1) { dlg.style.cssText = ''; return; } // bottom sheet on phones (CSS)
    const r = btn.getBoundingClientRect();
    const w = Math.min(680, innerWidth - 24);
    dlg.style.cssText = `left:${Math.max(12, Math.min(r.left, innerWidth - w - 12))}px;top:${r.bottom + 6}px;width:${w}px`;
    const h = dlg.offsetHeight;
    if (r.bottom + 6 + h > innerHeight - 12) dlg.style.top = `${Math.max(12, innerHeight - 12 - h)}px`;
  }
  function open() {
    st.anchor = null;
    st.hover = null;
    st.month = (st.mode === 'flex' && st.center ? st.center : startIn.value || lo()).slice(0, 7);
    dlg.showModal();
    render();
    ($('.dp-day.start', dlg) || $('.dp-day:not([disabled])', dlg))?.focus();
  }
  function close() {
    if (dlg.open) dlg.close();
  }
  dlg.addEventListener('close', () => {
    // Closing after only the first click of a range abandons it; the previous dates stay.
    st.anchor = null;
    st.hover = null;
    btn.focus();
  });

  btn.addEventListener('click', open);
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) return close(); // backdrop
    const t = e.target.closest('button, input');
    if (!t) return;
    if (t.matches('.dp-x, .dp-done')) return close();
    if (t.name === `${uid}-mode`) {
      st.mode = t.value;
      st.anchor = null;
      if (st.mode === 'flex' && startIn.value) {
        // Centre on the middle of the current range, rounded to a ± option that covers it.
        const s = startIn.value;
        const half = Math.ceil((dayCount(s, endIn.value) - 1) / 2);
        st.center = isoDateFrom(s, half);
        st.flex = FLEX_DAYS.find((n) => n >= half) ?? FLEX_DAYS.at(-1);
        write(...flexRange());
      }
      return render();
    }
    if (t.dataset.nav) {
      st.month = monthAdd(st.month, Number(t.dataset.nav));
      return render();
    }
    if (t.dataset.preset) {
      st.mode = 'range';
      write(lo(), isoDate(Number(t.dataset.preset)));
      return close();
    }
    if (t.dataset.flex) {
      st.flex = Number(t.dataset.flex);
      if (st.center) write(...flexRange());
      $$('.dp-chip', dlg).forEach((c) => { c.classList.toggle('on', c === t); c.setAttribute('aria-pressed', String(c === t)); });
      return paint();
    }
    const d = t.dataset.date;
    if (!d) return;
    if (single) {
      write(d, d);
      return close();
    }
    if (st.mode === 'flex') {
      st.center = d;
      write(...flexRange());
      return paint();
    }
    if (!st.anchor) {
      st.anchor = d;
      st.hover = d;
      return paint();
    }
    const [from, to] = d < st.anchor ? [d, st.anchor] : [st.anchor, d];
    st.anchor = null;
    write(from, to);
    close();
  });
  const hoverDay = (e) => {
    const d = e.target.closest?.('.dp-day:not([disabled])')?.dataset.date;
    if (st.anchor && d && d !== st.hover) { st.hover = d; paint(); }
  };
  dlg.addEventListener('mouseover', hoverDay);
  dlg.addEventListener('focusin', hoverDay);
  addEventListener('resize', () => { if (dlg.open) render(); });
  updateButton();

  return {
    // A range that is one day ± a preset opens as 「指定日期 ± 天數」 (shared links, restored searches); any other as a range.
    set(s, e = s) {
      if (!s) { st.center = null; return write('', ''); } // cleared (a search whose dates have passed)
      if (single || e < s) e = s;
      const half = (dayCount(s, e) - 1) / 2;
      st.center = null;
      if (!single) {
        st.mode = FLEX_DAYS.includes(half) ? 'flex' : 'range';
        if (st.mode === 'flex') { st.center = isoDateFrom(s, half); st.flex = half; }
      }
      write(s, e);
    },
    value: () => startIn.value,
  };
}
const datePickers = { search: createDatePicker($('#search-form'), '出發日期'), explore: createDatePicker($('#explore-form'), '出發日期') };

$('#swap').addEventListener('click', () => {
  const [o, d] = [pickers.origin.codes(), pickers.destination.codes()];
  pickers.origin.set(d);
  pickers.destination.set(o);
});

$$('.presets button').forEach((b) => b.addEventListener('click', () => {
  const f = $('#search-form');
  pickers.origin.set(b.dataset.o.split(','));
  pickers.destination.set(b.dataset.d.split(','));
  f.alliance.value = b.dataset.al || '';
  f.carrier.value = '';
  carrierHint();
  f.requestSubmit();
}));

// Commit typed airport text into chips; returns the first problem (and focuses that field), or ''.
async function checkAirports(form, list) {
  if ($$('.chips-q', form).some((q) => q.value.trim())) await loadAirports();
  for (const p of list) {
    const unknown = p.commit();
    const problem = unknown.length ? `${p.label}找不到「${unknown.join('、')}」，請從下拉選單選擇機場或輸入三碼代號。`
      : p.codes().length ? '' : `請輸入${p.label}。`;
    if (problem) { p.focus(); return problem; }
  }
  return '';
}
// Validation messages go under the field that needs fixing (the caller focuses it first) and that field is scrolled
// into view; with no focused field the message goes to the status line instead. Fixing the form clears it.
function clearFieldErrors(form) {
  $$('.field-err', form).forEach((x) => x.remove());
  $$('[aria-invalid]', form).forEach((x) => x.removeAttribute('aria-invalid'));
}
function formError(status, msg) {
  const el = document.activeElement;
  const form = el?.closest?.('form');
  const field = form && el.closest('.field, .ac-host');
  if (form) clearFieldErrors(form);
  if (!field) {
    status.className = 'status error';
    status.textContent = msg;
    reveal(status);
    return;
  }
  status.className = 'status';
  status.textContent = '';
  field.insertAdjacentHTML('beforeend', `<p class="field-err" role="alert">${esc(msg)}</p>`);
  el.setAttribute('aria-invalid', 'true');
  const clear = () => clearFieldErrors(form);
  form.addEventListener('input', clear, { once: true });
  form.addEventListener('change', clear, { once: true });
  form.addEventListener('submit', clear, { once: true, capture: true });
  const r = field.getBoundingClientRect();
  if (r.top < 70 || r.bottom > innerHeight - 40) field.scrollIntoView({ block: 'center' });
}

$('#search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const status = $('#search-status');
  const problem = await checkAirports(form, [pickers.origin, pickers.destination]);
  if (problem) return formError(status, problem);
  // No date picked (a 熱門航線 button on a first visit, for example): search the next month, like the date presets.
  let autoRange = false;
  if (!form.start.value) {
    datePickers.search.set(isoDate(0), isoDate(30));
    autoRange = true;
  }
  const f = new FormData(form);
  const share = new URLSearchParams({ o: f.get('origin'), d: f.get('destination'), s: f.get('start'), e: f.get('end'), c: f.get('cabin') || 'J' });
  if (f.get('carrier')) share.set('a', f.get('carrier'));
  else if (f.get('alliance')) share.set('al', f.get('alliance'));
  if (f.get('direct')) share.set('direct', '1');
  if (f.get('pax')) share.set('n', f.get('pax'));
  setTabUrl('search', share);
  remember(share);
  runSearch(share, null, autoRange);
});

// Share-link params come from the URL, so default anything missing or invalid before using them.
function normalizeShare(share) {
  if (!/^[YWJF]$/.test(share.get('c') || '')) share.set('c', 'J');
  if (!share.get('e')) share.set('e', share.get('s'));
  if (share.get('n') && !/^[1-9]$/.test(share.get('n'))) share.delete('n');
  const d = clampShareDates(share.get('s'), share.get('e'), searchToday());
  if (d.clamped) { share.clampedFrom ||= share.get('s'); share.set('s', d.s); }
  share.past = d.past;
  return share;
}
// Dates already past (an old favourite, a recent search or a shared link): the search starts today, and a range that
// has wholly passed is not searched at all (it would spend a seats.aero call on flights that have left).
function clampShareDates(s, e, today) {
  e = e || s;
  if (!s || !e) return { s, e, clamped: false, past: false };
  if (e < today) return { s, e, clamped: false, past: true };
  return s < today ? { s: today, e, clamped: true, past: false } : { s, e, clamped: false, past: false };
}
// Today for that check: the earlier of the visitor's day and Taiwan's (the server counts days in Taiwan time).
const searchToday = () => { const tw = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); const here = isoDate(0); return here < tw ? here : tw; };

// Fill the search form from share-link params and optionally run it (used by links, recents and favourites).
function applyShare(share, run = true, pre = null) {
  normalizeShare(share);
  const f = $('#search-form');
  pickers.origin.set(share.get('o').split(','));
  pickers.destination.set(share.get('d').split(','));
  if (share.past) datePickers.search.set('');
  else datePickers.search.set(share.get('s'), share.get('e') || share.get('s'));
  f.alliance.value = share.get('al') || '';
  f.carrier.value = share.get('a') || '';
  f.direct.checked = share.get('direct') === '1';
  f.pax.value = share.get('n') || '';
  const cab = $(`#search-form input[name=cabin][value="${share.get('c') || 'J'}"]`);
  if (cab) cab.checked = true;
  carrierHint();
  if (run) {
    setTabUrl('search', share);
    if (currentTab !== 'search') showTab('search');
    runSearch(share, pre);
  }
}

// ---------- recent searches and favourites (this device only) ----------
const RECENT_KEY = 'recentSearches';
const FAV_KEY = 'favSearches';
const shareKey = (share) => { const p = new URLSearchParams(share); p.sort(); return p.toString(); };
function shareLabel(q) {
  const p = new URLSearchParams(q);
  const s = p.get('s');
  const e = p.get('e') || s;
  return `${p.get('o')} → ${p.get('d')}　${ymd(s)}${e !== s ? ` – ${ymd(e)}` : ''}　${CABIN_LABEL[p.get('c')] || '商務艙'}${p.get('n') ? `　${p.get('n')}+ 位` : ''}`;
}
function remember(share) {
  const key = shareKey(share);
  const list = [key, ...store.get(RECENT_KEY, []).filter((k) => k !== key)].slice(0, 8);
  store.set(RECENT_KEY, list);
  renderMine();
}
const isFav = (share) => store.get(FAV_KEY, []).includes(shareKey(share));
function toggleFav(share) {
  const key = shareKey(share);
  const list = store.get(FAV_KEY, []);
  store.set(FAV_KEY, list.includes(key) ? list.filter((k) => k !== key) : [...list, key].slice(-12));
  renderMine();
  return !list.includes(key);
}
function renderMine() {
  const favs = store.get(FAV_KEY, []);
  const recent = store.get(RECENT_KEY, []).filter((k) => !favs.includes(k));
  const chip = (q, rm) => `<span class="mine-chip"><button type="button" data-q="${esc(q)}">${esc(shareLabel(q))}</button>${rm ? `<button type="button" class="rm" data-rm="${esc(q)}" aria-label="移除">✕</button>` : ''}</span>`;
  $('#mine').innerHTML = (favs.length ? `<div class="presets"><span class="presets-label">★ 我的常用</span>${favs.map((q) => chip(q, true)).join('')}</div>` : '')
    + (recent.length ? `<div class="presets"><span class="presets-label">最近查過</span>${recent.map((q) => chip(q, false)).join('')}<button type="button" class="rm-all" id="recent-clear">清除</button></div>` : '');
  $$('#mine [data-q]').forEach((b) => b.addEventListener('click', () => applyShare(new URLSearchParams(b.dataset.q))));
  $$('#mine [data-rm]').forEach((b) => b.addEventListener('click', () => { toggleFav(new URLSearchParams(b.dataset.rm)); renderSearchFav(); }));
  $('#recent-clear')?.addEventListener('click', () => { store.del(RECENT_KEY); renderMine(); });
}
// ---------- seat alerts (server-side watches, checked daily) ----------
const alertCfg = { store: false, email: false };
const ALERT_EMAIL_KEY = 'alertEmail';
// A watch may cover several cabins, stored as their letters ("YJ").
const alertCabins = (a) => Object.keys(CABIN_LABEL).filter((c) => String(a.cabin || '').includes(c));
const alertSummary = (a) => `${a.origin} → ${a.destination}　${ymd(a.start)}${a.end !== a.start ? ` – ${ymd(a.end)}` : ''}　${alertCabins(a).map((c) => CABIN_LABEL[c]).join('、')}${a.pax ? `　至少 ${a.pax} 位` : ''}`;
const allianceName = (id) => data.alliances?.alliances.find((x) => x.id === id)?.name || '';
const alertFilterText = (a) => [a.sources?.length ? `哩程：${a.sources.map(srcName).join('、')}` : '', a.alliance ? `聯盟：${allianceName(a.alliance) || a.alliance}` : '', a.airlines?.length ? `航空公司：${a.airlines.map((x) => `${airlineZh(x)}（${x}）`).join('、')}${a.anyLeg ? '（含轉機）' : ''}` : '', a.direct ? '只要直飛' : ''].filter(Boolean).join('　');
// The search a watch came from, for its 「查看」 button.
const alertShare = (a) => new URLSearchParams({ o: a.origin, d: a.destination, s: a.start, e: a.end, c: alertCabins(a)[0] || 'J', ...(a.pax ? { n: a.pax } : {}), ...(a.alliance ? { al: a.alliance } : {}), ...(a.direct ? { direct: '1' } : {}) });
// Which programs and airlines a watch reports. Programs: every seats.aero program, the ones in this search first, ticked
// when the result filter hides some. Airlines: the carriers in this search's results, plus codes typed in for ones that
// have no seats yet. Nothing ticked means any. The search's 航空聯盟 and 只看直飛 carry over too.
// `a`: a saved watch being edited (「修改」): its own programs, airlines and switches are ticked instead.
function alertFiltersHtml(share, a = null) {
  const c = state.cabin;
  const inResults = a ? a.sources || [] : [...new Set(state.results.map((r) => r.source))].filter((x) => SOURCE_NAMES[x]);
  // One chip per program: aliases sharing a name (copa / connectmiles) and the estimate-only source are left out.
  const named = new Set(inResults.map(srcName));
  const programs = [...inResults, ...Object.keys(SOURCE_NAMES).filter((x) => !inResults.includes(x) && !x.endsWith('_est') && !named.has(srcName(x)) && named.add(srcName(x)))];
  const pre = a ? new Set(a.sources || []) : state.hidden.size ? new Set(inResults.filter((x) => !state.hidden.has(x))) : new Set();
  const carriers = a ? [] : [...new Set(state.results.flatMap((r) => (cab(r, c)?.available ? r.cabins[c].airlines.split(/,\s*/) : [])).filter((x) => /^[A-Z0-9]{2}$/.test(x)))].sort();
  // An airline filter on the search itself (航空公司 field) carries over.
  const airPre = new Set(a ? a.airlines || [] : String(share.get('a') || '').toUpperCase().split(/[\s,]+/).filter((x) => /^[A-Z0-9]{2}$/.test(x)));
  for (const x of airPre) if (!carriers.includes(x)) carriers.push(x);
  const al = data.alliances.alliances.some((x) => x.id === share.get('al')) ? share.get('al') : '';
  const chip = (name, value, label, on) => `<label class="h-chip"><input type="checkbox" name="${name}" value="${esc(value)}" ${on ? 'checked' : ''}><span>${esc(label)}</span></label>`;
  return `<details class="alert-pick"${pre.size ? ' open' : ''}><summary>只通知這些哩程計畫 <small class="muted">（不選＝全部）</small></summary>
      <div class="h-progs">${programs.map((x) => chip('a-src', x, srcName(x), pre.has(x))).join('')}</div>
    </details>
    <details class="alert-pick"${airPre.size || al ? ' open' : ''}><summary>只通知這些航空公司的航班 <small class="muted">（不選＝全部）</small></summary>
      <label class="field">航空聯盟<select name="alliance"><option value="">全部聯盟</option>${data.alliances.alliances.map((x) => `<option value="${esc(x.id)}" ${x.id === al ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
      ${carriers.length ? `<div class="h-progs">${carriers.map((x) => chip('a-air', x, airlineLabel(x), airPre.has(x))).join('')}</div>` : ''}
      <label class="field">其他航空公司代碼（現在還沒有位子的，例如 CI、BR）<input name="airlinesExtra" placeholder="CI, BR" autocomplete="off" autocapitalize="characters"></label>
      <label class="switch"><input type="checkbox" name="anyLeg" ${a?.anyLeg ? 'checked' : ''}><span class="knob"></span>轉機也通知（只要其中一段是這些航空公司）</label>
      <p class="hint">沒勾的話，整趟都是這些航空公司飛的才通知。</p>
    </details>
    <label class="switch"><input type="checkbox" name="direct" ${share.get('direct') === '1' ? 'checked' : ''}><span class="knob"></span>只通知直飛</label>`;
}
// Cabin chips: tick any number; each cabin's new seats are reported, labelled with the cabin.
const alertCabinChipsHtml = (on) => `<div class="h-progs alert-cabins">${Object.entries(CABIN_LABEL).map(([k, t]) => `<label class="h-chip"><input type="checkbox" name="a-cab" value="${k}" ${on.includes(k) ? 'checked' : ''}><span>${t}</span></label>`).join('')}</div>`;
// What the filter part of an alert form (create dialog or a 「修改」 row) asks for.
function alertFilterValues(f) {
  return {
    cabins: $$('input[name="a-cab"]:checked', f).map((i) => i.value),
    sources: $$('input[name="a-src"]:checked', f).map((i) => i.value),
    airlines: [...new Set([...$$('input[name="a-air"]:checked', f).map((i) => i.value), ...f.airlinesExtra.value.toUpperCase().split(/[\s,，、]+/).filter(Boolean)])],
    anyLeg: f.anyLeg.checked,
    alliance: f.alliance.value,
    direct: f.direct.checked,
  };
}
const PAX_OPTIONS = [['', '不限'], ['2', '至少 2 位'], ['3', '至少 3 位'], ['4', '至少 4 位'], ['5', '至少 5 位']];
// 「修改」: the watch's conditions in a form inside its own row, filled in with what it has now.
function alertEditHtml(a) {
  const opt = (v, t, on) => `<option value="${esc(v)}" ${on ? 'selected' : ''}>${esc(t)}</option>`;
  const lo = isoDate(0);
  return `<form class="alert-edit" data-id="${esc(a.id)}">
    <div class="alert-edit-grid">
      <label class="field">出發地<input name="origin" value="${esc(a.origin)}" autocomplete="off" autocapitalize="characters" required placeholder="TPE"></label>
      <label class="field">目的地<input name="destination" value="${esc(a.destination)}" autocomplete="off" autocapitalize="characters" required placeholder="NRT"></label>
      <label class="field">出發日期（從）<input type="date" name="start" value="${esc(a.start < lo ? lo : a.start)}" min="${lo}" max="${isoDate(MAX_AHEAD_DAYS)}" required></label>
      <label class="field">到<input type="date" name="end" value="${esc(a.end)}" min="${lo}" max="${isoDate(MAX_AHEAD_DAYS)}" required></label>
      <label class="field">座位數<select name="pax">${PAX_OPTIONS.map(([v, t]) => opt(v, t, String(a.pax || '') === v)).join('')}</select></label>
    </div>
    <div class="field"><span>艙等（可複選）</span>${alertCabinChipsHtml(alertCabins(a))}</div>
    ${alertFiltersHtml(new URLSearchParams({ ...(a.alliance ? { al: a.alliance } : {}), ...(a.direct ? { direct: '1' } : {}) }), a)}
    <p class="hint">機場可填多個，用逗號分開（例如 TPE,TSA）。儲存後會重新記下目前已有的座位，之後只通知新出現的；通知方式不變。</p>
    <div class="alert-edit-actions"><button type="button" class="outline" data-edit-cancel>取消</button><button type="submit" class="primary small">儲存修改</button></div>
  </form>`;
}
const ALERT_SETUP = `<p class="hint">機位提醒還沒啟用。網站主人要在 Vercel 做兩件事：① Storage 分頁用 Marketplace 建一個 Upstash Redis（免費方案），它會自動加上連線設定；② 到 resend.com 申請免費金鑰，在 Environment Variables 新增 <code>RESEND_API_KEY</code>。都設好後重新部署。</p>`;
function openAlertDialog() {
  const share = tabParams('search');
  if (!share.get('o')) return toast('請先搜尋一條航線');
  const dlg = $('#alert-dialog');
  const f = $('#alert-form');
  f.email.value = store.get(ALERT_EMAIL_KEY, '');
  f.pax.value = share.get('n') || '';
  $('#alert-filters').innerHTML = `<div class="field"><span>艙等（可複選）</span>${alertCabinChipsHtml([share.get('c') || 'J'])}</div>${alertFiltersHtml(share)}`;
  $('#alert-summary').textContent = alertSummary({ origin: share.get('o'), destination: share.get('d'), start: share.get('s'), end: share.get('e') || share.get('s'), cabin: '' });
  $('#alert-note').innerHTML = alertCfg.store
    ? `每天早上自動檢查一次，有新的獎勵位就${alertCfg.email ? '寄信通知' : '顯示在「機位提醒」裡（網站尚未設定寄信服務）'}；現在已有的座位不會重複通知。`
    : ALERT_SETUP;
  dlg.showModal();
}
$('#alert-cancel').addEventListener('click', () => $('#alert-dialog').close());
$('#alert-dialog').addEventListener('click', (e) => { if (e.target.id === 'alert-dialog') e.target.close(); });
$('#alert-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!alertCfg.store) return;
  const share = tabParams('search');
  const f = e.target;
  const btn = $('button[type=submit]', f);
  btn.disabled = true;
  try {
    store.set(ALERT_EMAIL_KEY, f.email.value.trim());
    const body = await cashApi('/api/alerts', { method: 'POST', body: JSON.stringify({ origin: share.get('o'), destination: share.get('d'), start: share.get('s'), end: share.get('e') || share.get('s'), pax: f.pax.value, email: f.email.value.trim(), ...alertFilterValues(f) }), headers: { 'content-type': 'application/json' } });
    $('#alert-dialog').close();
    toast(`已建立提醒，目前有 ${body.found} 筆有位`);
    $('#alerts-panel').open = true;
    loadAlerts();
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
});
async function loadAlerts() {
  const box = $('#alerts-body');
  if (!alertCfg.store) { box.innerHTML = ALERT_SETUP; $('#alerts-count').textContent = ''; return; }
  box.innerHTML = '<p class="hint">載入中…</p>';
  try {
    const body = await cashApi('/api/alerts');
    const list = body.alerts || [];
    $('#alerts-count').textContent = list.length ? `（${list.length}）` : '';
    box.innerHTML = (list.length ? `<ul class="alert-list">${list.map((a) => `<li>
        <div><b>${esc(alertSummary(a))}</b>${alertFilterText(a) ? `<small>${esc(alertFilterText(a))}</small>` : ''}${a.email ? `<small>→ ${esc(a.email)}</small>` : '<small>只在網站顯示</small>'}</div>
        <div class="hint">${a.lastRun ? `上次檢查 ${ago(a.lastRun)}：有位 ${a.lastFound ?? '—'} 筆${a.lastNew ? `，<b class="new">新增 ${a.lastNew} 筆</b>` : ''}` : '尚未檢查'}${a.lastError ? `　⚠ ${esc(a.lastError)}` : ''}</div>
        <div class="alert-actions"><button type="button" class="outline" data-open="${esc(alertShare(a))}">查看</button><button type="button" class="outline" data-edit="${esc(a.id)}" aria-expanded="false">修改</button><button type="button" class="outline" data-del="${esc(a.id)}">刪除</button></div>
      </li>`).join('')}</ul>` : '<p class="hint">還沒有提醒。搜尋一條航線後，按結果上方的「🔔 有新機位通知我」。</p>')
      + `<div class="alert-foot">${list.length ? '<button type="button" class="outline" id="alerts-run">立即檢查全部</button>' : ''}<span class="hint">每天早上 8 點多（台灣時間）自動檢查${body.email ? '並寄信' : '；尚未設定寄信服務，只會顯示在這裡'}。</span></div>`;
    $$('[data-open]', box).forEach((b) => b.addEventListener('click', () => applyShare(new URLSearchParams(b.dataset.open))));
    $$('[data-edit]', box).forEach((b) => b.addEventListener('click', () => {
      const li = b.closest('li');
      const was = $('.alert-edit', li);
      // One row at a time; a second click on 修改 closes it again.
      $$('.alert-edit', box).forEach((x) => x.remove());
      $$('[data-edit]', box).forEach((x) => x.setAttribute('aria-expanded', 'false'));
      if (was) return;
      li.insertAdjacentHTML('beforeend', alertEditHtml(list.find((x) => x.id === b.dataset.edit)));
      b.setAttribute('aria-expanded', 'true');
      $('.alert-edit [name=origin]', li).focus();
    }));
    box.onclick = (e) => {
      if (!e.target.closest('[data-edit-cancel]')) return;
      e.target.closest('.alert-edit').remove();
      $$('[data-edit]', box).forEach((x) => x.setAttribute('aria-expanded', 'false'));
    };
    box.onsubmit = async (e) => {
      const f = e.target.closest('.alert-edit');
      if (!f) return;
      e.preventDefault();
      const btn = $('button[type=submit]', f);
      btn.disabled = true;
      try {
        const codes = (v) => v.toUpperCase().split(/[\s,，、]+/).filter(Boolean).join(',');
        const r = await cashApi(`/api/alerts?id=${encodeURIComponent(f.dataset.id)}`, { method: 'PUT', body: JSON.stringify({ origin: codes(f.origin.value), destination: codes(f.destination.value), start: f.start.value, end: f.end.value, pax: f.pax.value, ...alertFilterValues(f) }), headers: { 'content-type': 'application/json' } });
        toast(`已更新提醒，目前有 ${r.found} 筆有位，之後只通知新出現的`);
        loadAlerts();
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
      }
    };
    $$('[data-del]', box).forEach((b) => b.addEventListener('click', async () => {
      try { await cashApi(`/api/alerts?id=${encodeURIComponent(b.dataset.del)}`, { method: 'DELETE' }); toast('已刪除提醒'); loadAlerts(); } catch (err) { toast(err.message); }
    }));
    $('#alerts-run')?.addEventListener('click', async () => {
      const b = $('#alerts-run');
      b.disabled = true;
      b.textContent = '檢查中…';
      try {
        const r = await cashApi('/api/alerts/run');
        const fresh = r.report.reduce((n, x) => n + (x.fresh || 0), 0);
        toast(fresh ? `檢查完成，新增 ${fresh} 筆機位` : '檢查完成，沒有新機位');
        loadAlerts();
      } catch (err) { toast(err.message); b.disabled = false; b.textContent = '立即檢查全部'; }
    });
  } catch (err) {
    box.innerHTML = `<p class="status error">${esc(err.message)}</p>`;
  }
}
$('#alerts-panel').addEventListener('toggle', () => { if ($('#alerts-panel').open) loadAlerts(); });

function renderSearchFav() {
  const b = $('#fav-btn');
  if (!b) return;
  const on = isFav(tabParams('search'));
  b.textContent = on ? '★ 已加入常用' : '☆ 加入常用';
  b.classList.toggle('on', on);
}

// /api/search parameters for share-link params (alliances need the loaded data for their members).
function searchQuery(share) {
  const params = new URLSearchParams({ origin: share.get('o'), destination: share.get('d'), start: share.get('s'), end: share.get('e') });
  if (share.get('a')) params.set('carriers', share.get('a'));
  else if (share.get('al')) params.set('carriers', allianceCarriers(share.get('al')).join(','));
  if (share.get('direct')) params.set('direct', '1');
  return params;
}

// `pre` is a search already started for a share link while the page data was still loading.
// `pre` is a search already started for a share link while the page data was still loading;
// `autoRange` says the dates were filled in because none were picked.
async function runSearch(share, pre, autoRange = false) {
  normalizeShare(share);
  const fresh = latest('search');
  if (share.past) {
    // Nothing to search: say so, and the 出發日期 button (now empty) is the next step.
    const status = $('#search-status');
    status.className = 'status';
    status.textContent = `這次的日期（${dayLabel(share.get('s'))} – ${dayLabel(share.get('e'))}）已經過了，沒有搜尋。請點上面的出發日期選新的日期，或直接按「搜尋」查未來 1 個月。`;
    $('#search-results').innerHTML = '';
    $('#search-trip').innerHTML = '';
    $('#search-empty').hidden = true;
    reveal(status);
    return;
  }
  if (share.clampedFrom) toast(`已過的日期不查，改從今天（${dayLabel(share.get('s'))}）開始查`);
  const params = searchQuery(share);
  Object.assign(state, { cabin: share.get('c') || 'J', hidden: new Set(), day: null, allRows: false, showSame: false, results: [], start: share.get('s'), end: share.get('e') || share.get('s'), pax: Number(share.get('n')) || 0, withTaxes: false, product: '', route: `${share.get('o')} → ${share.get('d')}` });
  const status = $('#search-status');
  const range = `${dayLabel(state.start)} – ${dayLabel(state.end)}`;
  const autoNote = autoRange ? `沒有選日期，先查未來 1 個月（${range}），要換日期可以點上面的出發日期。` : '';
  status.className = 'status';
  status.textContent = autoNote || '正在搜尋各哩程計畫的獎勵位…';
  if (autoNote) status.insertAdjacentHTML('beforeend', '<small class="fresh">搜尋中…</small>');
  $('#search-empty').hidden = true;
  $('#search-results').innerHTML = skeleton();
  setHolidays(HOL.search, {});
  $('#search-trip').innerHTML = '';
  if (typeof histShow === 'function') histShow(null);
  document.dispatchEvent(new CustomEvent('search:start'));
  const done = busy($('#search-form button[type=submit]'), '搜尋中…');
  reveal(status);
  try {
    const [body] = await Promise.all([pre || api(`/api/search?${params}`), loadMore()]);
    if (!fresh()) return;
    done();
    state.results = [...body.results, ...asiaMilesRows(body.results)];
    state.withTaxes = Boolean(body.withTaxes);
    const newest = body.results.map((r) => r.updatedAt).filter(Boolean).sort().at(-1);
    status.innerHTML = `<span>${autoRange ? `沒有選日期，先查未來 1 個月（${esc(range)}）：` : ''}找到 <b>${body.results.length}</b> 筆日期與計畫組合${body.mock ? '（示範資料）' : ''}${body.truncated ? '。結果太多，只列出一部分，縮短日期範圍可以看到完整結果' : ''}${newest ? `<small class="fresh" title="seats.aero 快取最後更新的時間；表格中有虛線框的格子超過 3 天沒更新">🕒 資料最新 ${ago(newest)}更新</small>` : ''}</span>
      <span class="status-actions"><button type="button" class="outline" id="fav-btn">☆ 加入常用</button><button type="button" class="outline" id="alert-btn">🔔 新機位通知</button><button type="button" class="outline" id="to-cash">💵 比現金票價</button><button type="button" class="outline" id="share-btn">🔗 分享</button></span>`;
    $('#alert-btn').addEventListener('click', openAlertDialog);
    $('#share-btn').addEventListener('click', copyShare);
    renderSearchFav();
    $('#fav-btn').addEventListener('click', () => { toast(toggleFav(tabParams('search')) ? '已加入常用航線' : '已從常用移除'); renderSearchFav(); });
    $('#to-cash').addEventListener('click', () => toCash(share));
    renderSearch();
    document.dispatchEvent(new CustomEvent('search:done', { detail: { share: share.toString(), body } }));
    loadTripInfo($('#search-trip'), { from: share.get('o'), to: share.get('d'), start: state.start, end: state.end }, { hol: HOL.search, onHolidays: () => { if (fresh() && state.results.length) renderCalendar(); } });
    if (typeof histShow === 'function') histShow(share);
    status.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    if (!fresh()) return;
    done();
    $('#search-results').innerHTML = '';
    showError(status, err, () => runSearch(share));
  }
}

// 比較現金票價: hand the cheapest award on screen (or of the picked day) to the cash tab as a one-way fare for the same people.
// Its own airports are single codes, which RapidAPI can serve; a city group would fall through to SerpApi.
function toCash(share) {
  const c = state.cabin;
  const rows = visibleRows().filter((r) => !r.estimate && (!state.day || r.date === state.day));
  const best = rows.sort((a, b) => a.cabins[c].miles - b.cabins[c].miles)[0];
  const main = (codes) => [codes.split(',').sort((a, b) => (AP.rank.get(a) ?? 9) - (AP.rank.get(b) ?? 9) || codes.indexOf(a) - codes.indexOf(b))[0]];
  cashPickers.origin.set(best ? [best.origin] : main(share.get('o')));
  cashPickers.destination.set(best ? [best.destination] : main(share.get('d')));
  cashDates.depart.set(best ? best.date : state.start);
  cashForm.adults.value = String(state.pax || 1);
  $('#cash-form input[name=trip][value="ow"]').checked = true;
  $('#cash-return').hidden = true;
  setCabin(c);
  cash.pendingFrom = best ? { date: best.date, origin: best.origin, destination: best.destination, cabin: c, miles: best.cabins[c].miles, taxes: best.cabins[c].taxes || null, source: best.source, pax: state.pax || 1 } : null;
  showTab('cash');
  cashForm.requestSubmit();
}

async function copyShare() {
  try {
    await navigator.clipboard.writeText(location.href);
    toast('已複製搜尋連結');
  } catch {
    prompt('複製這個連結：', location.href);
  }
}

// Seat counts of 0/null mean "unknown", so the people filter only drops rows that are known to be short.
const enoughSeats = (seats, pax) => !pax || !(seats > 0) || seats >= pax;
// The server may leave out cabins that have no seats, so every read of a cabin goes through this.
const cab = (r, c) => r.cabins?.[c] || null;
function visibleRows() {
  const c = state.cabin;
  const prod = state.product && state.withTaxes ? productList().find((p) => p.id === state.product) : null;
  return state.results.filter((r) => cab(r, c)?.available && !state.hidden.has(r.source) && enoughSeats(r.cabins[c].seats, state.pax)
    && (!state.affordOnly || walletEmpty() || reach(r.source).total >= r.cabins[c].miles * Math.max(1, state.pax))
    && (!prod || (!r.estimate && productMatches(prod, r.cabins[c].fleet))));
}

// Result filters that need extra data: my points, and a specific premium product (aircraft from the trips).
function resultToolsHtml() {
  const c = state.cabin;
  const carriers = new Set(state.results.flatMap((r) => (cab(r, c)?.available ? r.cabins[c].airlines.split(/,\s*/) : [])));
  const prods = productList().filter((p) => p.cabin === c && carriers.has(p.airline));
  if (state.product && !prods.some((p) => p.id === state.product)) state.product = '';
  const chosen = prods.find((p) => p.id === state.product);
  const prodNote = !chosen ? '' : !state.withTaxes ? '<span class="hint">日期範圍 45 天內才有機型資料，請縮短範圍再用這個篩選。</span>'
    : chosen.caveat ? `<span class="hint">ⓘ ${esc(chosen.caveat)}</span>` : '';
  return `<div class="result-tools">
    <label class="switch"><input type="checkbox" id="afford-only" ${state.affordOnly ? 'checked' : ''}><span class="knob"></span>只看我換得起的</label>
    ${prods.length ? `<label class="field compact">艙位產品<select id="product-filter"><option value="">全部</option>${prods.map((p) => `<option value="${esc(p.id)}" ${state.product === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>` : ''}
    ${prodNote}
    ${resultSortHtml()}
  </div>`;
}

const CABIN_SHORT = { Y: '經濟', W: '豪經', J: '商務', F: '頭等' };
// One cabin choice shared by every form and the results (the last one used carries over between tabs).
const CABIN_KEY_STORE = 'lastCabin';
function setCabin(c, { remember = true } = {}) {
  if (!CABIN_SHORT[c]) return;
  $$('input[name=cabin], input[name=view-cabin]').forEach((i) => { if (i.value === c) i.checked = true; });
  if (remember) store.set(CABIN_KEY_STORE, c);
}
document.addEventListener('change', (e) => {
  if (e.target.name === 'cabin' && e.target.closest('form')) setCabin(e.target.value);
});

// One listener for everything clickable in the results (they are re-rendered often; per-element listeners piled up).
$('#search-results').addEventListener('click', (e) => {
  const t = e.target;
  const goto = t.closest('[data-goto]');
  if (goto) {
    e.preventDefault();
    showTab(goto.dataset.goto);
    const chart = $('#am-chart');
    chart?.closest('details')?.setAttribute('open', '');
    chart?.scrollIntoView();
    return;
  }
  const card = t.closest('.deal, td.cell[data-id]');
  if (card) { openTrips(card.dataset.id, card.dataset.title, state.cabin, card); return; }
  const bulk = t.closest('[data-chips]');
  if (bulk) {
    const all = bulk.dataset.chips === 'all';
    state.hidden = all ? new Set() : new Set(state.results.map((r) => r.source));
    refreshPrograms(`[data-chips=${all ? 'none' : 'all'}]`);
    return;
  }
  const chip = t.closest('.chip[data-src]');
  if (chip) {
    state.hidden.has(chip.dataset.src) ? state.hidden.delete(chip.dataset.src) : state.hidden.add(chip.dataset.src);
    refreshPrograms(`.chip[data-src="${chip.dataset.src}"]`);
    return;
  }
  const day = t.closest('.day.has');
  if (day) { pickDay(state.day === day.dataset.date ? null : day.dataset.date); return; }
  // The first rows are drawn already: add the rest instead of drawing the table again.
  if (t.closest('#all-rows')) { state.allRows = true; fillMatrix(); return; }
  if (t.closest('#show-same')) { state.showSame = true; $('#deals-host').innerHTML = resultParts(visibleRows()).deals; return; }
  if (t.closest('#clear-day')) pickDay(null);
});
// A focused table cell opens its flights with Enter or Space, like a click.
$('#search-results').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('td.cell[data-id]')) { e.preventDefault(); e.target.click(); }
});
$('#search-results').addEventListener('change', (e) => {
  const t = e.target;
  if (t.name === 'view-cabin') {
    state.cabin = t.value;
    state.day = null;
    setCabin(t.value);
    const p = tabParams('search');
    p.set('c', t.value);
    setTabUrl('search', p);
    renderSearch();
  } else if (t.id === 'afford-only') {
    if (t.checked && walletEmpty()) {
      t.checked = false;
      toast('先填入你的點數，才能篩選換得起的機位', { label: '去填點數', run: () => openWallet() });
      return;
    }
    state.affordOnly = t.checked;
    renderSearch();
  } else if (t.id === 'product-filter') {
    state.product = t.value;
    renderSearch();
  }
});
// Day filter: mark the day on the calendar in place and redraw only the table.
function pickDay(iso) {
  state.day = iso;
  $$('#search-results .day.has').forEach((d) => d.classList.toggle('sel', d.dataset.date === iso));
  renderMatrix();
  if (iso) $('#matrix-host')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Up to four cards: the cheapest seat of each program first, so the cards don't all repeat the same price.
function dealPicks(rows, c) {
  const sorted = [...rows].sort((a, b) => a.cabins[c].miles - b.cabins[c].miles);
  const picks = [];
  const seen = new Set();
  for (const r of sorted) {
    if (picks.length === 4) break;
    if (!seen.has(r.source)) { seen.add(r.source); picks.push(r); }
  }
  for (const r of sorted) {
    if (picks.length === 4) break;
    if (!picks.includes(r)) picks.push(r);
  }
  return picks.sort((a, b) => a.cabins[c].miles - b.cabins[c].miles);
}

// The parts of the results page that follow the ticked programs: chips, Asia Miles callouts, best-deal cards, legend.
function resultParts(rows) {
  const c = state.cabin;
  const allSources = [...new Set(state.results.map((r) => r.source))];

  // lowest per program (ignores the program filter so chips always show a price)
  const bestBySource = {};
  for (const r of state.results) {
    const m = cab(r, c)?.available && r.cabins[c].miles;
    if (m && (!bestBySource[r.source] || m < bestBySource[r.source])) bestBySource[r.source] = m;
  }
  const pin = (x) => ['asiamiles', 'asiamiles_est'].indexOf(x) + 1 || 9;
  allSources.sort((a, b) => pin(a) - pin(b) || (bestBySource[a] || Infinity) - (bestBySource[b] || Infinity));
  const realRows = rows.filter((r) => !r.estimate);
  const amRows = rows.filter((r) => r.estimate).sort((a, b) => a.cabins[c].miles - b.cabins[c].miles);
  const amReal = rows.filter((r) => r.source === 'asiamiles').sort((a, b) => a.cabins[c].miles - b.cabins[c].miles);

  // Phantom-space notes once per program (they used to sit on every cell as a tooltip touch screens can't open).
  const ph = phantomByProgram(rows, c);
  const hiddenAll = allSources.every((s) => state.hidden.has(s));
  const chips = allSources.map((s) => `<button type="button" class="chip ${state.hidden.has(s) ? '' : 'on'}" data-src="${s}" aria-pressed="${!state.hidden.has(s)}">
    ${esc(srcName(s))}${bestBySource[s] ? ` <b>${kfmt(bestBySource[s])}</b>` : ''}${ph.has(s) ? ' <span class="ph" title="可能有幻影機位">⚠</span>' : ''}</button>`).join('')
    + (allSources.length > 1 ? `${state.hidden.size ? '<button type="button" class="chip chip-all" data-chips="all">全部勾選</button>' : ''}${hiddenAll ? '' : '<button type="button" class="chip chip-all" data-chips="none">全部取消</button>'}` : '');
  const parts = { allSources, chips, hiddenAll, am: '', deals: '', legend: '' };
  if (!rows.length) return parts;

  // One card per program, headed by the program; a tie at the top is said once instead of starring one card.
  const byCost = costSortOn();
  const picks = costPicks(realRows, c) || dealPicks(realRows, c);
  const lowMiles = Math.min(...picks.map((r) => r.cabins[c].miles));
  const allSame = picks.length > 1 && picks.every((r) => r.cabins[c].miles === lowMiles);
  // Identical prices: one card that says how many programs tie, the others behind a link.
  const folded = allSame && !state.showSame;
  const dealHtml = (folded ? picks.slice(0, 1) : picks).map((r) => {
    const x = r.cabins[c];
    return `<button type="button" class="deal" data-id="${esc(r.id)}" data-title="${esc(titleOf(r))}">
      ${(byCost ? r === picks[0] : !allSame && x.miles === lowMiles) ? '<span class="rank">★ 最低</span>' : folded ? `<span class="rank same">${picks.length} 個計畫同價</span>` : ''}
      <div class="route">${esc(srcName(r.source))}</div>
      <div class="miles">${fmt(x.miles)} <small>哩起</small>${x.taxes ? `<small class="tax">＋ 稅 ${esc(taxText(x.taxes))}</small>` : ''}</div>
      <div class="meta">${dayLabel(r.date)} · ${esc(r.origin)} → ${esc(r.destination)}</div>
      <div class="meta">${carriersHtml(x.airlines)}${x.direct ? ' · 直飛' : ''}${x.seats ? ` · 剩 ${x.seats} 位` : ''}${r.updatedAt ? ` · 🕒 ${ago(r.updatedAt)}` : ''}</div>
      ${costLineHtml(r, c)}${feeChipHtml(r.source)}${valueTag(r, c)}
    </button>`;
  }).join('');

  parts.am = `${amReal.length ? `<div class="am-callout">
      <div><b>國泰 亞洲萬里通</b>　最低 <b class="am-miles">${fmt(amReal[0].cabins[c].miles)} 哩</b>（${mmdd(amReal[0].date)} ${esc(amReal[0].origin)} → ${esc(amReal[0].destination)}，${carriersHtml(amReal[0].cabins[c].airlines)}），共 ${amReal.length} 個日期／航線有位</div>
      <div class="hint">來自 seats.aero 的亞洲萬里通實際資料。可在下方表格「國泰 亞洲萬里通」欄點選看航班。</div>
    </div>` : ''}
    ${amRows.length ? `<div class="am-callout">
      <div><b>亞洲萬里通估算</b>　國泰／寰宇一家航班最低約 <b class="am-miles">${fmt(amRows[0].cabins[c].miles)} 哩</b>（${mmdd(amRows[0].date)} ${esc(amRows[0].origin)} → ${esc(amRows[0].destination)}，${amRows[0].cabins[c].kind === 'cx' ? '國泰航班' : '夥伴航班'}）</div>
      <div class="hint">依 2026-05-01 起的距離哩數表推算，實際座位與價格請至國泰官網確認；轉機行程依各段距離相加，可能落在更高區間。<a href="#rules" data-goto="rules">看哩數表</a></div>
    </div>` : ''}`;
  parts.deals = `<h2 class="section-title">最划算的選擇 <small>${byCost ? '依台幣成本（哩數 × 每哩成本 ＋ 稅金）；' : allSame ? `各計畫最低都是 ${fmt(lowMiles)} 哩，差在稅金和日期；` : '各計畫最低的日期；'}點卡片看航班明細</small></h2>
    <div class="best${folded ? ' folded' : ''}">${dealHtml}</div>
    ${folded ? `<p class="same-more">同價的還有：${picks.slice(1).map((r) => esc(srcName(r.source))).join('、')} <button type="button" class="linklike" id="show-same">看這 ${picks.length - 1} 張卡片</button></p>` : ''}`;
  parts.legend = matrixLegendHtml(rows, c, ph);
  return parts;
}

function renderSearch() {
  const root = $('#search-results');
  const c = state.cabin;
  const rows = visibleRows();
  const p = resultParts(rows);

  const cabinSeg = `<fieldset class="seg" aria-label="切換艙等">${Object.entries(CABIN_SHORT).map(([k, l]) =>
    `<label><input type="radio" name="view-cabin" value="${k}" ${k === c ? 'checked' : ''}><span>${l}</span></label>`).join('')}</fieldset>`;

  const programs = [...new Set(state.results.map((r) => r.source))];
  const release = releaseNoticeHtml(programs, state.start, state.end, state.route || '');
  const matrixTitle = `<h2 class="section-title">各計畫比較 <small>點計畫名稱可隱藏／顯示${state.withTaxes ? '；哩數下方是最低稅金' : '；日期範圍超過 45 天不列稅金，點格子可看'}</small></h2>`;
  if (!rows.length) {
    matrixObs?.disconnect();
    const filtered = state.affordOnly || state.product;
    // Nothing left because programs were unticked: keep the chips so they can be ticked again.
    const byChips = state.hidden.size && state.results.some((r) => state.hidden.has(r.source) && cab(r, c)?.available);
    root.innerHTML = `<div class="section-title">${cabinSeg}</div>${resultToolsHtml()}${release}
      ${byChips ? `${matrixTitle}<div class="filters">${p.chips}</div>` : ''}
      <div class="empty"><div class="empty-icon" aria-hidden="true">🪑</div><p>${byChips && p.hiddenAll ? '已取消勾選所有哩程計畫。點上面的計畫名稱，或按「全部勾選」，就會再顯示結果。' : byChips ? '勾選的計畫在這個艙等沒有獎勵位，點上面的計畫名稱多勾幾個，或按「全部勾選」。' : filtered ? '目前的篩選條件下沒有獎勵位，可以關掉「只看我換得起的」或改選全部艙位產品。' : '這個艙等在所選日期沒有獎勵位，試試其他艙等、日期或目的地。'}</p></div>`;
    return;
  }

  // The parts in display:contents boxes (#am-host, #deals-host, #legend-host) are redrawn alone by refreshPrograms.
  root.innerHTML = `
    <div class="section-title">${cabinSeg}</div>
    ${resultToolsHtml()}
    ${release}
    <div class="res-part" id="am-host">${p.am}</div>
    ${typeof cxBadgeHtml === 'function' ? cxBadgeHtml(c) : ''}
    <div class="res-part" id="deals-host">${p.deals}</div>
    <details class="cal-fold" id="cal-fold"${calOpen ? ' open' : ''}>
      <summary><h2 class="section-title">日曆 <small id="cal-sum"></small></h2></summary>
      <p class="hint cal-how">每天最低哩數（顏色對照下方的便宜／較貴）；點日期篩選下表</p>
      <div id="cal-host"></div>
    </details>
    ${matrixTitle}
    <div class="filters">${p.chips}</div>
    <div class="res-part" id="legend-host">${p.legend}</div>
    <div id="matrix-host"></div>`;
  renderCalendar(rows);
  renderMatrix(rows, p.allSources);
  $('#cal-fold').addEventListener('toggle', (e) => { calOpen = e.target.open; });
}

// A program chip or 全部勾選／全部取消: redraw only what follows the ticked programs (chips, cards, calendar, legend,
// table). The cabin switch, the filters and the 國泰 cards above stay as they are. `focusSel`: the button to keep focus on.
function refreshPrograms(focusSel) {
  const hadFocus = $('#search-results').contains(document.activeElement);
  const rows = visibleRows();
  if (rows.length && $('#matrix-host')) {
    const p = resultParts(rows);
    $('#am-host').innerHTML = p.am;
    $('#deals-host').innerHTML = p.deals;
    $('#search-results .filters').innerHTML = p.chips;
    $('#legend-host').innerHTML = p.legend;
    renderCalendar(rows);
    renderMatrix(rows, p.allSources);
  } else renderSearch();
  if (hadFocus) $(`#search-results ${focusSel}`)?.focus({ preventScroll: true });
}

// The results calendar starts folded (it is tall); opening it is remembered while this page is open.
let calOpen = false;
// Calendar block only (holidays arriving later redraw just this, not the whole result page). Folded, its heading
// still says the lowest price and how many days have seats.
function renderCalendar(rows = visibleRows()) {
  const host = $('#cal-host');
  if (!host) return;
  const real = rows.filter((r) => !r.estimate);
  const use = real.length ? real : rows;
  host.innerHTML = calendarHtml(use);
  const c = state.cabin;
  const miles = use.map((r) => cab(r, c)?.miles).filter(Boolean);
  const days = new Set(use.filter((r) => cab(r, c)?.miles).map((r) => r.date)).size;
  $('#cal-sum').textContent = miles.length ? `最低 ${fmt(Math.min(...miles))} 哩 · ${days} 天有位` : '';
}
function renderMatrix(rows = visibleRows(), sources = [...new Set(state.results.map((r) => r.source))]) {
  const host = $('#matrix-host');
  if (!host) return;
  const shown = $$('#search-results .chip[data-src]').map((b) => b.dataset.src);
  const cols = (shown.length ? shown : sources).filter((s) => !state.hidden.has(s));
  matrixNow = matrixParts(rows, cols);
  host.innerHTML = `${state.day ? `<div class="day-filter">目前只看 <b>${dayLabel(state.day)}</b><button type="button" class="outline" id="clear-day">顯示全部日期</button></div>` : ''}<div class="table-wrap"><table class="mx">${matrixNow.head}<tbody></tbody></table></div>`;
  fillMatrix();
}

// What each cell colour, border and mark means, under the program chips.
function matrixLegendHtml(rows, c, ph) {
  const has = (fn) => rows.some((r) => !r.estimate && fn(r, r.cabins[c]));
  const items = [
    '<span><i class="lg lg-good"></i>有位</span>',
    has((r, x) => x.seats && x.seats <= 1) ? '<span><i class="lg lg-few"></i>只剩 1 位</span>' : '',
    '<span><i class="lg lg-best"></i>最低</span>',
    has((r) => isOld(r.updatedAt)) ? '<span><i class="lg lg-old"></i>超過 3 天沒更新</span>' : '',
    rows.some((r) => r.estimate) ? '<span><i class="lg lg-est"></i>亞萬估算</span>' : '',
    has((r) => mileValueOf(r, c)?.good) ? '<span><i class="gv">好價</i>每哩價值高（比過現金票）</span>' : '',
  ].filter(Boolean).join('');
  const notes = [...ph].map(([s, list]) => `<li><b>${esc(srcName(s))}</b>：${[...list].map(esc).join('；')}</li>`).join('');
  return `<div class="legend m-legend">${items}</div>${ph.size ? `<details class="ph-notes"><summary>⚠ ${ph.size} 個計畫可能有幻影機位（查得到、訂不到）</summary><ul>${notes}</ul></details>` : ''}`;
}
function phantomByProgram(rows, c) {
  const out = new Map();
  for (const r of rows) {
    if (r.estimate) continue;
    for (const p of phantomWarnings(r.source, r.cabins[c].airlines)) {
      if (!out.has(r.source)) out.set(r.source, new Set());
      out.get(r.source).add(p.warning);
    }
  }
  return out;
}

const titleOf = (r) => `${dayLabel(r.date)} ${r.origin} → ${r.destination} · ${srcName(r.source)}`;
// Cells older than this get a dashed border; seats.aero's cache is often a day or two old, so one day would mark nearly everything.
const isOld = (iso) => iso && Date.now() - Date.parse(iso) > 3 * 864e5;

function calendarHtml(rows) {
  const c = state.cabin;
  const lowByDay = {};
  for (const r of rows) {
    const m = cab(r, c)?.miles;
    if (m && (!lowByDay[r.date] || m < lowByDay[r.date])) lowByDay[r.date] = m;
  }
  const { start, end } = state;
  // Shade by rank among the distinct daily prices, so one expensive outlier doesn't flatten the scale.
  const uniq = [...new Set(Object.values(lowByDay))].sort((a, b) => a - b);
  const level = (m) => (uniq.length === 1 ? 4 : 4 - Math.min(3, Math.floor((uniq.indexOf(m) / (uniq.length - 1)) * 4)));
  const hol = HOL.search;

  const dayCell = (iso, text) => {
    const m = lowByDay[iso];
    const mark = holidayMark(hol, iso);
    const note = mark.title ? `\n${mark.title}` : '';
    return m
      ? `<button type="button" class="day has h${level(m)} ${state.day === iso ? 'sel' : ''} ${mark.cls}" data-date="${iso}" title="${iso} 最低 ${fmt(m)} 哩${esc(note)}">${text}<b>${kfmt(m)}</b></button>`
      : `<div class="day ${mark.cls}"${mark.title ? ` title="${esc(mark.title)}"` : ''}>${text}<b>—</b></div>`;
  };
  // Lay days out under weekday headers, padding before the first day.
  const grid = (from, to, text) => {
    const cells = DOW.map((d) => `<div class="dow">${d}</div>`);
    const first = new Date(from + 'T00:00:00Z');
    for (let i = 0; i < first.getUTCDay(); i++) cells.push('<div class="day pad"></div>');
    for (const d = new Date(first); d <= new Date(to + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
      const iso = d.toISOString().slice(0, 10);
      cells.push(dayCell(iso, text(iso)));
    }
    return cells.join('');
  };
  let body;
  if (dayCount(start, end) <= 42) {
    body = `<div class="cal">${grid(start, end, mmdd)}</div>`;
  } else {
    // Long ranges: one small calendar per month, each with its lowest price.
    const blocks = [];
    for (let ym = start.slice(0, 7); ym <= end.slice(0, 7); ym = monthAdd(ym, 1)) {
      const from = ym === start.slice(0, 7) ? start : `${ym}-01`;
      const last = new Date(`${monthAdd(ym, 1)}-01T00:00:00Z`);
      last.setUTCDate(0);
      const to = ym === end.slice(0, 7) ? end : last.toISOString().slice(0, 10);
      const lows = Object.entries(lowByDay).filter(([d]) => d >= from && d <= to).map(([, m]) => m);
      blocks.push(`<div class="cal-month"><div class="cal-mtitle">${ym.slice(0, 4)} 年 ${Number(ym.slice(5))} 月
        <small>${lows.length ? `最低 <b>${kfmt(Math.min(...lows))}</b> 哩 · ${lows.length} 天有位` : '沒有獎勵位'}</small></div>
        <div class="cal mini">${grid(from, to, (iso) => Number(iso.slice(8)))}</div></div>`);
    }
    body = `<div class="cal-months">${blocks.join('')}</div>`;
  }
  return `${body}
    <div class="legend">便宜 <i style="background:var(--heat-4)"></i><i style="background:var(--heat-3)"></i><i style="background:var(--heat-2)"></i><i style="background:var(--heat-1)"></i> 較貴${holidayLegend(hol)}</div>`;
}

const MATRIX_ROWS = 120;
// The table draws its first rows at once and more as they scroll near the screen: drawing all of them took seconds on a
// phone, on every filter tap. Scrolled through, it is the same table as before.
const MATRIX_FIRST = 12;
const MATRIX_BATCH = 30;
let matrixNow = null;
let matrixObs = null;
function fillMatrix() {
  const host = $('#matrix-host');
  const m = matrixNow;
  const tbody = host && $('tbody:not(.mx-sizer)', host);
  if (!m || !tbody) return;
  matrixObs?.disconnect();
  // Long date ranges can have hundreds of rows; show the first ones until asked.
  const keys = state.allRows ? m.allKeys : m.allKeys.slice(0, MATRIX_ROWS);
  $('#all-rows', host)?.remove();
  $('.mx-sizer', host)?.remove();
  if (keys.length > tbody.rows.length + MATRIX_FIRST) tbody.insertAdjacentHTML('afterend', m.sizer(keys));
  const step = (n) => {
    const from = tbody.rows.length;
    tbody.insertAdjacentHTML('beforeend', keys.slice(from, from + n).map(m.row).join(''));
    if (tbody.rows.length < keys.length) {
      if (typeof IntersectionObserver !== 'function') return step(keys.length);
      // The next rows once the last drawn one is within about a screen of view.
      const obs = new IntersectionObserver((ents) => {
        if (!ents.some((x) => x.isIntersecting)) return;
        obs.disconnect();
        if (tbody.isConnected) step(MATRIX_BATCH);
      }, { rootMargin: '0px 0px 900px 0px' });
      obs.observe(tbody.rows[tbody.rows.length - 1]);
      matrixObs = obs;
      return;
    }
    if (keys.length === m.allKeys.length) $('.mx-sizer', host)?.remove();
    else host.insertAdjacentHTML('beforeend', `<button type="button" class="outline more-rows" id="all-rows">顯示全部 ${m.allKeys.length} 列（目前 ${keys.length} 列）</button>`);
  };
  step(tbody.rows.length ? MATRIX_BATCH : MATRIX_FIRST);
}
// The table's header, its row keys (date|origin|destination, in display order) and a function drawing one row.
function matrixParts(rows, sources) {
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
  const allKeys = costSortKeys([...grid.keys()].sort(), grid, c, sources);
  // Priced cells take keyboard focus (Enter or Space opens the flights, like a click).
  const cell = (r) => {
    const x = r && cab(r, c);
    if (!x) return '<td class="cell none">·</td>';
    if (r.estimate) {
      return `<td class="cell est" tabindex="0" data-id="${esc(x.refId)}" data-title="${esc(`${titleOf(r)}（座位來源：${srcName(x.refSource)}）`)}" title="依距離哩數表估算">≈${fmt(x.miles)}<small class="mx-meta">${carrierLogosHtml(x.airlines)}<span>${x.kind === 'cx' ? '國泰表' : '夥伴表'}</span></small></td>`;
    }
    const cls = [x.seats && x.seats <= 1 ? 'few' : 'good', x.miles === low ? 'best-cell' : '', isOld(r.updatedAt) ? 'old' : ''].join(' ');
    const ph = phantomWarnings(r.source, x.airlines);
    return `<td class="cell ${cls}" tabindex="0" data-id="${esc(r.id)}" data-title="${esc(titleOf(r))}" title="${esc([r.updatedAt ? `資料 ${ago(r.updatedAt)}更新` : '', ...ph.map((p) => `⚠️ ${p.warning}`)].filter(Boolean).join('\n'))}">${valueMark(r, c)}${fmt(x.miles)}${x.taxes ? `<i class="tax">＋${esc(taxText(x.taxes))}</i>` : ''}${costCellHtml(r, c)}<small class="mx-meta">${carrierLogosHtml(x.airlines)}${x.direct ? '<span>直飛</span>' : ''}${x.seats ? `<span>${x.seats}位</span>` : ''}</small></td>`;
  };
  const row = (k) => {
    const [date, o, d] = k.split('|');
    return `<tr><td><div class="d">${dayLabel(date)}</div><div class="r">${esc(o)} → ${esc(d)}</div></td>${sources.map((s) => cell(grid.get(k)[s])).join('')}</tr>`;
  };
  const head = `<thead><tr><th>日期／航線</th>${sources.map((s) => `<th>${esc(srcName(s))}${feeHeadHtml(s)}</th>`).join('')}</tr></thead>`;
  // Column widths follow each column's widest cell, also in rows not drawn yet, so the table doesn't shift while it
  // grows: two hidden rows (visibility:collapse still counts for the widths) carry each column's widest airline line
  // and its longest tax or cost line.
  const sizer = (keys) => {
    const cost = costSortOn();
    // Rough text width in em (CJK and full-width 1, digits and Latin about half); only compared within one column.
    const tw = (t) => { let w = 0; for (const ch of String(t)) w += ch > '\u2e7f' ? 1 : /[,.:·\s]/.test(ch) ? 0.3 : 0.6; return w; };
    const metaW = (r, x) => { const n = new Set(String(x.airlines || '').split(/[,\s]+/).filter(Boolean)).size; return Math.min(n, 3) * 1.7 + (n > 3 ? 1.4 : 0) + (r.estimate ? 1 + tw('國泰表') : (x.direct ? 1 + tw('直飛') : 0) + (x.seats ? 1 + tw(`${x.seats}位`) : 0)); };
    const textW = (r, x) => (r.estimate ? 0 : Math.max(x.taxes ? tw(`＋${taxText(x.taxes)}`) : 0, cost ? tw(`≈NT$${fmt(atRowCost(r, c).twd)}`) : 0));
    // The three widest of a column by one measure (estimates can be off by a little, so not just the first).
    const top = (list, w) => list.map((v) => [w(v), v]).filter((p) => p[0] > 0).sort((a, b) => b[0] - a[0]).slice(0, 3).map((p) => p[1]);
    // The first column: every date label and route once, stacked in one hidden cell.
    const dates = new Set(keys.map((k) => k.split('|')[0]));
    const routes = new Set(keys.map((k) => { const [, o, d] = k.split('|'); return `${esc(o)} → ${esc(d)}`; }));
    const head = `<td>${[...dates].map((d) => `<div class="d">${dayLabel(d)}</div>`).join('')}${[...routes].map((r) => `<div class="r">${r}</div>`).join('')}</td>`;
    const picks = sources.map((s) => {
      const rs = keys.map((k) => grid.get(k)[s]).filter((r) => r && cab(r, c));
      return [...top(rs, (r) => metaW(r, cab(r, c))), ...top(rs, (r) => textW(r, cab(r, c)))];
    });
    const n = Math.max(1, ...picks.map((p) => p.length));
    const rowsHtml = Array.from({ length: n }, (_, i) => `<tr>${i ? '<td></td>' : head}${picks.map((p) => cell(p[i])).join('')}</tr>`).join('');
    return `<tbody class="mx-sizer" aria-hidden="true">${rowsHtml}</tbody>`.replace(/ tabindex="0"/g, '');
  };
  return { allKeys, row, head, sizer };
}

// ---------- trip details ----------
// Seat map sites have no public API, so we link out: SeatMaps per aircraft, AeroLOPA per airline fleet.
const AIRCRAFT_NAMES = {
  '77W': 'Boeing 777-300ER', '77L': 'Boeing 777-200LR', '772': 'Boeing 777-200', '773': 'Boeing 777-300', '779': 'Boeing 777-9', '788': 'Boeing 787-8', '789': 'Boeing 787-9', '781': 'Boeing 787-10',
  '744': 'Boeing 747-400', '748': 'Boeing 747-8', '738': 'Boeing 737-800', '739': 'Boeing 737-900', '7M8': 'Boeing 737 MAX 8', '7M9': 'Boeing 737 MAX 9', '763': 'Boeing 767-300', '764': 'Boeing 767-400',
  '359': 'Airbus A350-900', '351': 'Airbus A350-1000', '388': 'Airbus A380', '332': 'Airbus A330-200', '333': 'Airbus A330-300', '339': 'Airbus A330-900neo', '338': 'Airbus A330-800neo',
  '321': 'Airbus A321', '32N': 'Airbus A320neo', '32Q': 'Airbus A321neo', '320': 'Airbus A320', '319': 'Airbus A319', '223': 'Airbus A220-300', '221': 'Airbus A220-100', 'E90': 'Embraer 190', 'E75': 'Embraer 175',
};
const aircraftLabel = (s) => (s.aircraft && s.aircraft !== s.aircraftCode ? s.aircraft : AIRCRAFT_NAMES[String(s.aircraftCode || '').toUpperCase()] || s.aircraft || '');
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
  const acName = aircraftLabel(seg);
  if (slug) {
    const ac = /^(boeing|airbus)\b/i.test(acName) ? `${acName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}/` : '';
    links.push(`<a href="https://seatmaps.com/airlines/${slug}/${ac}" target="_blank" rel="noopener">SeatMaps ↗</a>`);
  }
  if (/^[A-Z0-9]{2}$/.test(code)) links.push(`<a href="https://www.aerolopa.com/${code.toLowerCase()}" target="_blank" rel="noopener">AeroLOPA ↗</a>`);
  return links.length ? `<span class="seatmap">座位圖 ${links.join(' ')}</span>` : '';
}

// 「長榮航空・」 for a segment's flight number (the marketing carrier).
const segAirline = (s) => { const c = (s.flight || '').slice(0, 2).toUpperCase(); return airlineZh(c) !== c ? `<span class="al" title="${esc(c)}">${esc(airlineZh(c))}</span>・` : ''; };
function tripHtml(t, i) {
  // 「NT$8,500」, or 「USD 56」 without a symbol (not both, as 「NT$8,500 TWD」 read).
  const taxes = t.taxes != null ? esc(taxText({ symbol: t.taxesSymbol, currency: t.taxesCurrency, amount: t.taxes / 100 })) : '稅金未提供';
  const dur = t.durationMin ? `${Math.floor(t.durationMin / 60)} 小時 ${t.durationMin % 60} 分` : '';
  return `<div class="trip">
    <div class="trip-top">
      <div><b>${esc(t.flightNumbers)}</b><span class="pill">${esc(CABIN_ZH[t.cabin] || t.cabin)}</span><span class="pill">${t.stops ? `轉機 ${t.stops} 次` : '直飛'}</span>${t.seats ? `<span class="pill">剩 ${t.seats} 位</span>` : ''}</div>
      <div><span class="miles">${fmt(t.miles)} 哩</span> ＋ ${taxes}${i != null ? `<button type="button" class="outline add-plan" data-plan="${i}">＋ 加入我的行程</button>` : ''}</div>
    </div>
    ${phantomHtml(t.source, t.carriers)}
    ${t.segments.map((s) => `<div class="seg-line"><b>${esc(s.flight)}</b><span>${esc(s.from)} ${hhmm(s.departsAt)} → ${esc(s.to)} ${hhmm(s.arrivesAt)}${s.distance ? `　${fmt(s.distance)} 哩` : ''}</span>
      <span></span><span class="ac">${productOfSegment(s).map((p) => `<span class="pill prod">${esc(p.name)}</span>`).join('') || segAirline(s)}✈ ${esc(aircraftLabel(s) || '機型未提供')}${s.aircraftCode && s.aircraftCode !== aircraftLabel(s) ? `（${esc(s.aircraftCode)}）` : ''}${s.fareClass ? `　艙等代碼 ${esc(s.fareClass)}` : ''}　${seatLinks(s)}</span></div>`).join('')}
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
  const fresh = latest('trips');
  $('#trip-title').textContent = title;
  $('#trip-body').innerHTML = skeleton(3);
  dlg.showModal();
  try {
    const [body] = await Promise.all([api(`/api/trips/${encodeURIComponent(id)}`), loadMore()]);
    if (!fresh()) return;
    const want = CABIN_API[cabin];
    const byMiles = (a, b) => a.miles - b.miles || a.stops - b.stops;
    const main = body.trips.filter((t) => !want || t.cabin === want).sort(byMiles);
    const rest = body.trips.filter((t) => want && t.cabin !== want).sort(byMiles);
    const all = [...main, ...rest];
    const pax = $('#tab-search').hidden ? Number(ex.f?.pax) || 1 : state.pax || 1;
    const first = main[0] || rest[0];
    // seats.aero labels some links with the raw program id ("american 官網訂位"); show the program's name instead.
    const src = first?.source || '';
    const linkLabel = (l) => (src && l.label.startsWith(src) ? `${srcName(src)}${l.label.slice(src.length)}` : l.label);
    const links = body.bookingLinks.map((l) => `<a href="${esc(l.link)}" target="_blank" rel="noopener">${esc(linkLabel(l))} ↗</a>`).join('');
    // The flights come first; booking guidance is one tap away.
    $('#trip-body').innerHTML = (main.map((t, i) => tripHtml(t, i)).join('') || '<p class="hint">此艙等沒有航班明細。</p>') +
      (rest.length ? `<details><summary>其他艙等 ${rest.length} 筆</summary>${rest.map((t, i) => tripHtml(t, main.length + i)).join('')}</details>` : '') +
      (main.length && cashCfg.enabled ? `<div class="value-box" id="value-box"><button type="button" class="outline" id="value-btn">💵 和當天現金票比一比，算每哩價值（用 1 次查價）</button></div>` : '') +
      (links ? `<div class="links">${links}</div>` : '') +
      (first ? bookingNotesHtml(first.source, first.miles * pax) + homeProgramHtml(first.carriers) + earnHtml(first.source, first.miles * pax) + howToBookHtml(first.source) : '');
    $('#value-btn')?.addEventListener('click', () => mileValue(main[0]));
    $$('[data-plan]', $('#trip-body')).forEach((b) => b.addEventListener('click', () => addLegs([awardLeg(all[Number(b.dataset.plan)], pax)])));
    if (main[0] && typeof aiHelperMount === 'function') aiHelperMount(main[0], pax, main.length); // public/aihelper.js
  } catch (err) {
    if (!fresh()) return;
    $('#trip-body').innerHTML = `<p class="status error">${esc(err.message)}</p>`;
  }
}
// Is the award worth it? Compare the cheapest cash fare that day with miles + taxes, in TWD per mile.
let fxCache = null;
// One shared request for the exchange rates, however many views ask at once.
let fxLoading = null;
const loadFx = () => (fxCache ? Promise.resolve(fxCache) : (fxLoading ||= api('/api/fx').then((f) => (fxCache = f)).finally(() => { fxLoading = null; })));
async function mileValue(t) {
  const box = $('#value-box');
  box.innerHTML = '<p class="hint">正在查當天現金票價與匯率…</p>';
  try {
    const o = t.segments[0]?.from;
    const d = t.segments.at(-1)?.to;
    const date = (t.departsAt || '').slice(0, 10);
    const cabin = { economy: 'Y', premium: 'W', business: 'J', first: 'F' }[t.cabin] || 'J';
    if (!o || !d || !date) throw new Error('缺少航班資料，無法比較');
    const [fx, body] = await Promise.all([loadFx(), cashApi(`/api/cash?${new URLSearchParams({ origin: o, destination: d, depart: date, cabin, adults: 1 })}`)]);
    if (!body.configured) throw new Error('網站尚未啟用即時票價');
    const fares = body.options.filter((x) => x.price);
    if (!fares.length) throw new Error(body.message || '當天找不到現金票價');
    const cheapest = fares.reduce((a, b) => (a.price <= b.price ? a : b));
    rememberCash(o, d, date, cabin, cheapest.price);
    const cur = (t.taxesCurrency || '').toUpperCase();
    const rate = cur ? fx.rates[cur] : null;
    const taxesTwd = t.taxes != null && rate ? (t.taxes / 100) * rate : 0;
    const saved = cheapest.price - taxesTwd;
    const per = saved / t.miles;
    const verdict = saved <= 0 ? ['bad', '現金票比稅金還便宜，直接買現金票'] : per >= 0.6 ? ['good', '划算，值得換'] : per >= 0.35 ? ['mid', '普通'] : ['bad', '不划算，用現金買比較好'];
    const taxNote = t.taxes == null ? '此計畫未提供稅金，先當 0 計算' : rate ? `稅金約 NT$${fmt(Math.round(taxesTwd))}（${esc(t.taxesSymbol || cur)}${fmt(t.taxes / 100)}，匯率${fx.live ? `為 ${fx.updated}` : '為概估'}）` : cur ? `稅金 ${esc(cur)} ${fmt(t.taxes / 100)} 無法換算，先當 0 計算` : `此計畫的稅金 ${fmt(t.taxes / 100)} 未標幣別，先當 0 計算`;
    box.innerHTML = `<div class="value-result ${verdict[0]}">
      <div class="value-head"><b>每哩約 NT$${per > 0 ? per.toFixed(2) : '0'}</b><span class="pill">${verdict[1]}</span></div>
      <p class="hint">當天最便宜現金票 NT$${fmt(cheapest.price)}（${airlineNameHtml(cheapest.segments[0]?.airline, cheapest.segments[0]?.flightNumber)}${cheapest.segments.length > 1 ? '，轉機' : '，直飛'}，和獎勵票的航空公司、時間可能不同${body.mock ? '；示範資料' : ''}）－ ${taxNote} ＝ 省下 NT$${fmt(Math.round(Math.max(0, saved)))}，除以 ${fmt(t.miles)} 哩。一般常見估值：每哩 NT$0.35 以下不划算、0.6 以上划算，僅供參考。</p>
    </div>`;
  } catch (err) {
    box.innerHTML = `<p class="status error">${esc(err.message)}</p>`;
  }
}
$('#trip-close').addEventListener('click', () => $('#trip-dialog').close());
$('#trip-dialog').addEventListener('click', (e) => { if (e.target.id === 'trip-dialog') e.target.close(); });

// ---------- explore ----------
const PAGE = 200;
const ex = { rows: [], cabin: 'J', sort: { key: 'miles', dir: 1 }, f: {}, shown: PAGE, view: 'table' };
// Until the full airport list loads (on first use of an airport field), the short Chinese name list from the data covers common airports.
const airportCity = (code) => { const a = AP.byCode.get(code); return a ? a.zh || a.city : data.airportNames?.names?.[code] || ''; };

$('#explore-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const params = new URLSearchParams();
  for (const [k, v] of f) if (v) params.set(k, v);
  const fresh = latest('explore');
  setTabUrl('explore', new URLSearchParams({ x: '1', ...Object.fromEntries(params) }));
  const status = $('#explore-status');
  status.className = 'status';
  status.textContent = '正在探索，資料量大時可能需要幾秒…';
  $('#explore-results').innerHTML = skeleton(6);
  const done = busy($('button[type=submit]', e.target), '探索中…');
  reveal(status);
  try {
    const body = await api(`/api/explore?${params}`);
    await loadAirports();
    if (!fresh()) return;
    done();
    Object.assign(ex, { rows: body.results, cabin: body.cabin, f: {}, shown: PAGE, sort: { key: 'miles', dir: 1 }, mock: body.mock, truncated: body.truncated });
    renderExplore();
    status.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    if (!fresh()) return;
    done();
    $('#explore-results').innerHTML = '';
    showError(status, err, () => e.target.requestSubmit());
  }
});

// Restore an explore query from the URL (written on submit) and run it.
function applyExploreShare(share) {
  const f = $('#explore-form');
  for (const k of ['program', 'origin_region', 'destination_region']) if (share.get(k)) f[k].value = share.get(k);
  // Dates already past: from today, or (all past) the form's own default dates and no search until asked.
  const d = clampShareDates(share.get('start'), share.get('end'), searchToday());
  if (d.s && !d.past) datePickers.explore.set(d.s, d.e);
  // The cabin comes from the URL, so only a known letter goes into the selector.
  const c = share.get('cabin');
  const cab = $(`#explore-form input[name=cabin][value="${/^[YWJF]$/.test(c || '') ? c : 'J'}"]`);
  if (cab) cab.checked = true;
  if (d.past) return toast('這個連結的日期已經過了，請選新的日期再按「開始探索」');
  f.requestSubmit();
}

// Rows matching every filter except `skip` (used to count options in each airport picker).
function exploreMatches(skip) {
  const { f } = ex;
  const inSet = (k, v) => k === skip || !f[k]?.size || f[k].has(v);
  return ex.rows.filter((r) =>
    inSet('origin', r.origin) &&
    inSet('destination', r.destination) &&
    (!f.from || r.date >= f.from) &&
    (!f.to || r.date <= f.to) &&
    (!f.maxMiles || r.miles <= f.maxMiles) &&
    (!f.airline || r.airlines.split(/,\s*/).includes(f.airline)) &&
    enoughSeats(r.seats, Number(f.pax) || 0) &&
    (!f.direct || r.direct));
}

function exploreFiltered() {
  const list = exploreMatches();
  const { key, dir } = ex.sort;
  const val = (r) => (key === 'route' ? `${r.origin}${r.destination}` : key === 'direct' ? Number(r.direct) : r[key] ?? '');
  return list.sort((a, b) => (val(a) > val(b) ? dir : val(a) < val(b) ? -dir : a.miles - b.miles));
}

// Multi-select airport filter: a button opens a panel with a search box and a checkbox per airport.
function airportFilterHtml(key, label, codes) {
  return `<div class="field mp" data-mp="${key}">
    <span>${label}</span>
    <button type="button" class="mp-btn" aria-haspopup="true" aria-expanded="false"></button>
    <div class="mp-pop" hidden>
      <input type="search" class="mp-q" placeholder="輸入代號、城市或國家" aria-label="搜尋${label}">
      <div class="mp-actions"><button type="button" data-act="all">全選目前清單</button><button type="button" data-act="none">清除</button></div>
      <div class="mp-opts">${codes.map((c) => {
        const a = AP.byCode.get(c);
        const search = [c, a?.zh, a?.city, a?.alt, a?.cn, a?.cnL, a?.name].filter(Boolean).join(' ').toLowerCase();
        return `<label class="mp-opt" data-s="${esc(search)}"><input type="checkbox" value="${c}"><b>${c}</b><span>${esc(airportCity(c))}${a ? `<small>${esc(a.cn)}</small>` : ''}</span><em></em></label>`;
      }).join('')}</div>
    </div>
  </div>`;
}

function setupAirportFilter(el) {
  const key = el.dataset.mp;
  const btn = $('.mp-btn', el);
  const pop = $('.mp-pop', el);
  const q = $('.mp-q', el);
  const open = (yes) => {
    pop.hidden = !yes;
    btn.setAttribute('aria-expanded', String(yes));
    if (yes) { q.value = ''; filterOpts(); q.focus(); }
  };
  const filterOpts = () => {
    const t = normQ(q.value).toLowerCase();
    $$('.mp-opt', el).forEach((o) => (o.hidden = !!t && !o.dataset.s.includes(t)));
  };
  const changed = () => {
    ex.f[key] = new Set($$('.mp-opt input:checked', el).map((i) => i.value));
    ex.shown = PAGE;
    renderExplore();
  };
  btn.addEventListener('click', () => open(pop.hidden));
  q.addEventListener('input', filterOpts);
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { open(false); btn.focus(); }
    if (e.key === 'Enter') {
      e.preventDefault();
      const first = $$('.mp-opt', el).find((o) => !o.hidden);
      if (first) { first.querySelector('input').checked = !first.querySelector('input').checked; changed(); }
    }
  });
  $$('.mp-opt input', el).forEach((i) => i.addEventListener('change', changed));
  $('.mp-actions', el).addEventListener('click', (e) => {
    const act = e.target.dataset.act;
    if (!act) return;
    $$('.mp-opt', el).forEach((o) => { if (act === 'none' || !o.hidden) o.querySelector('input').checked = act === 'all'; });
    changed();
  });
}
document.addEventListener('click', (e) => {
  for (const el of $$('[data-mp]')) {
    if (el.contains(e.target)) continue;
    $('.mp-pop', el).hidden = true;
    $('.mp-btn', el).setAttribute('aria-expanded', 'false');
  }
});

// Refresh button text and per-airport counts after any filter change.
function updateAirportFilters() {
  for (const el of $$('#ex-filters [data-mp]')) {
    const key = el.dataset.mp;
    const sel = [...(ex.f[key] || [])];
    const counts = new Map();
    for (const r of exploreMatches(key)) counts.set(r[key], (counts.get(r[key]) || 0) + 1);
    $$('.mp-opt', el).forEach((o) => {
      const n = counts.get(o.querySelector('input').value) || 0;
      o.querySelector('em').textContent = `${n} 筆`;
      o.classList.toggle('zero', !n);
    });
    const total = $$('.mp-opt', el).length;
    $('.mp-btn', el).textContent = !sel.length ? `全部（${total} 個）`
      : sel.length <= 2 ? sel.map((c) => `${c} ${airportCity(c)}`.trim()).join('、')
      : `${sel.slice(0, 2).join('、')} 等 ${sel.length} 個`;
    $('.mp-btn', el).classList.toggle('on', sel.length > 0);
  }
}

// How many result filters are set (shown on the folded 篩選 button).
const exFilterCount = () => Object.values(ex.f).filter((v) => (v instanceof Set ? v.size : Boolean(v))).length;

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

  if (!$('#ex-filters')) {
    // The dates were picked in the form above, so the filters here skip them; folded until wanted.
    $('#explore-results').innerHTML = `
      <details class="ex-filters" id="ex-filters"><summary>篩選結果 <span id="ex-fcount"></span></summary>
      <div class="search-card">
        <div class="opts-row">
          ${airportFilterHtml('origin', '出發機場', uniq((r) => [r.origin]))}
          ${airportFilterHtml('destination', '抵達機場', uniq((r) => [r.destination]))}
          <label class="field">航空公司<select data-f="airline"><option value="">全部</option>${uniq((r) => r.airlines.split(/,\s*/)).map((c) => opt(c, airlineLabel(c))).join('')}</select></label>
        </div>
        <div class="opts-row">
          <label class="field">哩數上限<input type="number" data-f="maxMiles" min="0" step="5000" placeholder="例：80000"></label>
          <label class="field">人數<select data-f="pax"><option value="">不限</option><option value="2">至少 2 位</option><option value="3">至少 3 位</option><option value="4">至少 4 位</option></select></label>
          <label class="switch"><input type="checkbox" data-f="direct"><span class="knob"></span>只看直飛</label>
          <button type="button" class="outline" id="ex-reset">清除篩選</button>
        </div>
      </div></details>
      <div id="ex-view"></div>
      <div id="ex-table"></div>`;
    $$('#ex-filters [data-f]').forEach((el) => el.addEventListener(el.type === 'number' ? 'input' : 'change', () => {
      const k = el.dataset.f;
      ex.f[k] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) || 0 : el.value;
      ex.shown = PAGE;
      renderExplore();
    }));
    $$('#ex-filters [data-mp]').forEach(setupAirportFilter);
    $('#ex-reset').addEventListener('click', () => {
      ex.f = {};
      $$('#ex-filters [data-f]').forEach((el) => (el.type === 'checkbox' ? (el.checked = false) : (el.value = '')));
      $$('#ex-filters .mp-opt input').forEach((el) => (el.checked = false));
      ex.shown = PAGE;
      renderExplore();
    });
    $('#ex-view').addEventListener('change', (e) => { if (e.target.name === 'ex-view') { ex.view = e.target.value; renderExplore(); } });
  }
  updateAirportFilters();
  const n = exFilterCount();
  $('#ex-fcount').textContent = n ? `（${n}）` : '';

  const rows = exploreFiltered();
  status.className = 'status';
  status.innerHTML = `<span>共 <b>${all.length}</b> 筆${ex.mock ? '（示範資料）' : ''}${rows.length !== all.length ? `，篩選後 <b>${rows.length}</b> 筆` : ''}${ex.truncated ? '。結果超過 5,000 筆，請縮小日期或區域範圍以看到全部' : ''}</span>`;

  $('#ex-view').innerHTML = `<fieldset class="seg" aria-label="顯示方式">${[['table', '表格'], ['map', '地圖']].map(([k, l]) => `<label><input type="radio" name="ex-view" value="${k}" ${ex.view === k ? 'checked' : ''}><span>${l}</span></label>`).join('')}</fieldset>`;
  if (ex.view === 'map') { renderExploreMap(rows); return; }
  if (exMap) { exMap.remove(); exMap = null; }

  const cols = [['date', '日期'], ['route', '航線'], ['miles', '哩數'], ['airlines', '航空公司'], ['direct', '直飛'], ['seats', '剩餘座位'], ['distance', '距離（哩）'], ['updatedAt', '資料更新']];
  const arrow = (k) => (ex.sort.key === k ? (ex.sort.dir > 0 ? ' ▲' : ' ▼') : '');
  // Rows come in pages of 200; drawing all of a year's 2,000+ rows at once froze phones for seconds.
  const shown = rows.slice(0, ex.shown);
  $('#ex-table').innerHTML = `<div class="table-wrap"><table>
    <thead><tr>${cols.map(([k, l]) => `<th class="sortable" data-k="${k}" tabindex="0" aria-sort="${ex.sort.key === k ? (ex.sort.dir > 0 ? 'ascending' : 'descending') : 'none'}">${l}${arrow(k)}</th>`).join('')}</tr></thead>
    <tbody>${shown.map((r) => `<tr class="click" tabindex="0" data-id="${esc(r.id)}" data-title="${esc(titleOf(r))}">
      <td><span class="d">${dayLabel(r.date)}</span></td>
      <td><b>${esc(r.origin)}</b> → <b>${esc(r.destination)}</b></td>
      <td><b class="ex-miles">${fmt(r.miles)}</b></td>
      <td>${carriersHtml(r.airlines)}</td><td>${r.direct ? '✓' : ''}</td><td>${r.seats || '—'}</td><td>${r.distance ? fmt(r.distance) : '—'}</td><td class="${isStale(r.updatedAt) ? 'stale' : ''}">${ago(r.updatedAt) || '—'}</td></tr>`).join('')}</tbody>
  </table></div>
  ${rows.length > ex.shown ? `<div class="more"><button type="button" class="outline" id="ex-more">再顯示 ${Math.min(PAGE, rows.length - ex.shown)} 筆（還有 ${fmt(rows.length - ex.shown)} 筆）</button></div>` : ''}`;
}
// One set of listeners for the explore table (it is redrawn on every sort and filter).
$('#explore-results').addEventListener('click', (e) => {
  const th = e.target.closest('#ex-table th.sortable');
  if (th) {
    const k = th.dataset.k;
    ex.sort = { key: k, dir: ex.sort.key === k ? -ex.sort.dir : 1 };
    renderExplore();
    $(`#ex-table th[data-k="${k}"]`)?.focus();
    return;
  }
  const tr = e.target.closest('#ex-table tr.click');
  if (tr) { openTrips(tr.dataset.id, tr.dataset.title, ex.cabin); return; }
  if (e.target.closest('#ex-more')) { ex.shown += PAGE; renderExplore(); }
});
$('#explore-results').addEventListener('keydown', (e) => {
  // Sort headers and result rows (a row opens its flights, like a click).
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('th.sortable, tr.click')) { e.preventDefault(); e.target.click(); }
});
// ---------- cash fares ----------
// Live prices come from Google Flights through the server (SerpApi); without a key we still offer deep links.
const cashForm = $('#cash-form');
const cashPickers = { origin: createAirportPicker(cashForm, 'origin'), destination: createAirportPicker(cashForm, 'destination') };
const CASH_MAX_DAYS = 335; // the fare sources only quote about 11 months ahead
const cashDates = {
  depart: createDatePicker(cashForm, '出發日期', { single: true, name: 'depart', field: $('#cash-depart'), maxDays: CASH_MAX_DAYS }),
  ret: createDatePicker(cashForm, '回程日期', { single: true, name: 'return', field: $('#cash-return'), maxDays: CASH_MAX_DAYS, min: () => cashForm.depart.value }),
};
// RapidAPI takes one airport per side; several (a city group) go to SerpApi, the smaller monthly pool, so say so up front.
function updateMultiHint() {
  const multi = [cashForm.origin.value, cashForm.destination.value].some((v) => v.includes(','));
  $('#cash-multi').hidden = !(multi && cashCfg.calendar && cashCfg.serp);
}
cashForm.origin.addEventListener('change', updateMultiHint);
cashForm.destination.addEventListener('change', updateMultiHint);

// The site owner can gate live fare lookups behind a passcode (each one spends a SerpApi credit).
const PASS_KEY = 'cashPass';
const cashCfg = { locked: false, enabled: true };
function askPass(message) {
  const dlg = $('#pass-dialog');
  const input = $('#pass-input');
  $('#pass-msg').textContent = message || '即時查價會用到網站的付費額度，所以要輸入站長給的通關密碼（不是帳號的登入密碼）。輸入一次後這台裝置會記住。';
  input.value = '';
  return new Promise((resolve) => {
    const done = () => { dlg.removeEventListener('close', done); resolve(dlg.returnValue === 'ok' && input.value ? input.value : null); dlg.returnValue = ''; };
    dlg.addEventListener('close', done);
    dlg.showModal();
    input.focus();
  });
}
$('#pass-cancel').addEventListener('click', () => $('#pass-dialog').close(''));
function updateLockHint() {
  const el = $('#cash-lock');
  el.hidden = !cashCfg.locked;
  if (!cashCfg.locked) return;
  el.innerHTML = store.get(PASS_KEY, '')
    ? '🔓 這台裝置已記住通關密碼。<button type="button" class="linklike" id="pass-forget">清除密碼</button>'
    : '🔒 即時查價會用付費額度，需要通關密碼（不是登入密碼），按「搜尋票價」時會請你輸入。';
  $('#pass-forget')?.addEventListener('click', () => { store.del(PASS_KEY); updateLockHint(); toast('已清除通關密碼'); });
}
// Fetch a cash-fare endpoint, asking for the passcode when the server wants one.
async function cashApi(path, opts = {}) {
  let wrong = '';
  for (let tries = 0; ; tries++) {
    let pass = store.get(PASS_KEY, '');
    if (cashCfg.locked && !pass) {
      pass = await askPass(tries ? wrong || '密碼不對，請再試一次。' : '');
      if (pass == null) throw new Error('需要通關密碼才能查即時票價');
      store.set(PASS_KEY, pass);
    }
    try {
      const body = await api(path, { ...opts, headers: { ...(opts.headers || {}), ...(pass ? { 'x-cash-pass': pass } : {}) } });
      updateLockHint();
      return body;
    } catch (err) {
      if (err.code !== 'passcode' || tries >= 3) throw err;
      // 「通關密碼不對，還可以再試 N 次」 from the server, shown in the passcode prompt.
      wrong = /還可以再試/.test(err.message) ? `${err.message}。` : '';
      cashCfg.locked = true;
      store.del(PASS_KEY);
      updateLockHint();
    }
  }
}
const cash = { options: [], sort: 'best', directOnly: false, req: null, outbound: null, returns: null, chosen: null, booking: null, bookingBusy: false, bookingErr: '' };
const LEVEL = { low: ['偏低', 'good'], typical: ['一般', ''], high: ['偏高', 'bad'] };
const SKY_CABIN = { Y: 'economy', W: 'premiumeconomy', J: 'business', F: 'first' };
const GF_CABIN = { W: 'premium economy', J: 'business', F: 'first' };
const dur = (m) => (m ? `${Math.floor(m / 60)} 小時${m % 60 ? ` ${m % 60} 分` : ''}` : '');
const money = (n) => (n ? `NT$${fmt(n)}` : '價格未提供');

function cashLinks(r, googleUrl) {
  const o = r.origin.split(',')[0];
  const d = r.destination.split(',')[0];
  const q = `Flights to ${d} from ${o} on ${r.depart}${r.ret ? ` through ${r.ret}` : ' one way'}${GF_CABIN[r.cabin] ? ` ${GF_CABIN[r.cabin]} class` : ''}${r.adults > 1 ? ` for ${r.adults} adults` : ''}`;
  const gf = googleUrl || `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}&hl=zh-TW&curr=TWD`;
  const ymd = (s) => s.slice(2).replace(/-/g, '');
  const sky = `https://www.skyscanner.com.tw/transport/flights/${o.toLowerCase()}/${d.toLowerCase()}/${ymd(r.depart)}/${r.ret ? `${ymd(r.ret)}/` : ''}?adultsv2=${r.adults}&cabinclass=${SKY_CABIN[r.cabin]}&rtn=${r.ret ? 1 : 0}`;
  return `<div class="cash-links">
    <a class="outline btn" href="${esc(gf)}" target="_blank" rel="noopener">在 Google 航班開啟 ↗</a>
    <a class="outline btn" href="${esc(sky)}" target="_blank" rel="noopener">Skyscanner ↗</a>
    <button type="button" class="outline" id="cash-to-award">用哩程查這條航線</button>
  </div>`;
}

function sparkline(history) {
  if (!history || history.length < 2) return '';
  const ps = history.map((h) => h[1]);
  const min = Math.min(...ps);
  const max = Math.max(...ps);
  const pts = ps.map((p, i) => `${(i / (ps.length - 1)) * 160},${max === min ? 20 : 38 - ((p - min) / (max - min)) * 36}`).join(' ');
  return `<svg class="spark" viewBox="0 0 160 40" preserveAspectRatio="none" role="img" aria-label="近期價格走勢"><polyline points="${pts}" /></svg>`;
}

function fareTimes(o) {
  const first = o.segments[0];
  const last = o.segments.at(-1);
  if (!first) return '';
  const days = Math.round((new Date(last.to.time.slice(0, 10)) - new Date(first.from.time.slice(0, 10))) / 864e5);
  return `<div class="fare-time"><b>${esc(first.from.time.slice(11, 16))} – ${esc(last.to.time.slice(11, 16))}</b>${days > 0 ? `<sup>+${days}</sup>` : ''}
    <span>${esc(first.from.code)} → ${esc(last.to.code)}</span></div>`;
}

// "東京成田" for a code when the airport list has a Chinese name, else the English name the fare source sent.
const apName = (code, fallback) => airportCity(code) || fallback || '';
// "11/1（日）18:03" from a fare source's "2026-11-01 18:03".
const whenLabel = (t) => `${dayLabel(t.slice(0, 10))} ${t.slice(11, 16)}`;

function fareHtml(o, i, mode) {
  const airlines = [...new Map(o.segments.map((s) => [s.airline, airlineNameHtml(s.airline, s.flightNumber)])).values()].join('、');
  const stops = o.layovers.length ? `轉機 ${o.layovers.length} 次・${o.layovers.map((l) => `${esc(l.code)} ${dur(l.duration)}`).join('、')}` : '直飛';
  const action = mode === 'out' && o.departureToken ? `<button type="button" class="primary small" data-ret="${i}">選這班去程，看回程</button>`
    : mode === 'out' && o.bookingToken ? `<button type="button" class="primary small" data-pick="${i}">選這班</button>`
      : mode === 'ret' ? `<button type="button" class="primary small" data-pick="${i}">選這班回程</button>` : '';
  const final = mode === 'final';
  return `<div class="fare${o.best ? ' fare-best' : ''}${final ? ' fare-final' : ''}" data-i="${i}">
    <div class="fare-main" role="button" tabindex="0" aria-expanded="${final}">
      <div class="fare-logo">${o.logo ? `<img src="${esc(o.logo)}" alt="" loading="lazy">` : '✈'}</div>
      ${fareTimes(o)}
      <div class="fare-dur"><b>${dur(o.totalDuration)}</b><span>${airlines}</span></div>
      <div class="fare-stops ${o.layovers.length ? '' : 'direct'}">${stops}</div>
      ${final ? '' : `<div class="fare-price"><b>${money(o.price)}</b><span>${esc(o.type || '')}${cash.req.adults > 1 ? `・${cash.req.adults} 人總價` : ''}</span></div>`}
    </div>
    <div class="fare-detail" ${final ? '' : 'hidden'}>
      ${o.segments.map((s, j) => `
        <div class="seg-line"><b>${esc(s.flightNumber)}</b><span>${esc(whenLabel(s.from.time))} ${esc(s.from.code)} ${esc(apName(s.from.code, s.from.name))} → ${esc(s.to.time.slice(11, 16))} ${esc(s.to.code)} ${esc(apName(s.to.code, s.to.name))}・${dur(s.duration)}</span>
          <span></span><span class="ac">${airlineNameHtml(s.airline, s.flightNumber)}・✈ ${esc(s.airplane || '機型未提供')}${s.travelClass ? `・${esc(s.travelClass)}` : ''}${s.legroom ? `・腿部空間 ${esc(s.legroom)}` : ''}${s.oftenDelayed ? '・<span class="warn">常延誤 30 分以上</span>' : ''}　${seatLinks({ flight: (s.flightNumber || '').replace(/\s/g, ''), aircraft: s.airplane })}</span></div>
        ${o.layovers[j] ? `<div class="layover">在 ${esc(apName(o.layovers[j].code, o.layovers[j].name || o.layovers[j].code))} 轉機 ${dur(o.layovers[j].duration)}${o.layovers[j].overnight ? '（過夜）' : ''}</div>` : ''}`).join('')}
      ${o.emissions ? `<div class="hint">碳排放約 ${fmt(Math.round(o.emissions.thisFlight / 1000))} 公斤，${o.emissions.diffPct > 0 ? `比一般高 ${o.emissions.diffPct}%` : o.emissions.diffPct < 0 ? `比一般低 ${-o.emissions.diffPct}%` : '與一般相當'}</div>` : ''}
    </div>
    ${action}
  </div>`;
}

function sortedFares(list) {
  const firstDep = (o) => o.segments[0]?.from.time || '';
  const by = { best: () => 0, price: (a, b) => (a.price || 1e12) - (b.price || 1e12), depart: (a, b) => firstDep(a).localeCompare(firstDep(b)), duration: (a, b) => a.totalDuration - b.totalDuration };
  return list.map((o, i) => ({ o, i })).filter(({ o }) => !cash.directOnly || !o.layovers.length).sort((x, y) => by[cash.sort](x.o, y.o) || x.i - y.i);
}

// Coming from an award search: the award next to the cash fare, as NT$ saved per mile.
async function renderCashFrom() {
  const host = $('#cash-from');
  const a = cash.from;
  const r = cash.req;
  if (!a || !r || cash.off) { host.innerHTML = ''; return; }
  const fares = (cash.options || []).filter((o) => o.price);
  const cheapest = fares.length ? Math.min(...fares.map((o) => o.price)) : null;
  const back = '<button type="button" class="linklike" id="cash-from-back">← 回到哩程票結果</button>';
  const award = `${dayLabel(a.date)} ${esc(a.origin)} → ${esc(a.destination)} ${CABIN_LABEL[a.cabin]}：${esc(srcName(a.source))} <b>${fmt(a.miles * a.pax)} 哩</b>${a.taxes ? `＋稅 ${esc(taxText({ ...a.taxes, amount: a.taxes.amount * a.pax }))}` : ''}`;
  let verdict = '';
  if (cheapest) {
    const fx = await loadFx().catch(() => null);
    if (cash.from !== a) return;
    const rate = a.taxes?.currency ? fx?.rates?.[a.taxes.currency.toUpperCase()] : null;
    const tax = a.taxes && rate ? a.taxes.amount * a.pax * rate : 0;
    const per = (cheapest - tax) / (a.miles * a.pax);
    const word = per >= 0.6 ? ['good', '換哩程划算'] : per >= 0.35 ? ['mid', '普通'] : ['bad', '買現金票比較好'];
    verdict = `<span>→ 這天最便宜現金票 <b>NT$${fmt(cheapest)}</b>，每哩約 <b class="${word[0]}">NT$${Math.max(0, per).toFixed(2)}</b>（${word[1]}${a.taxes && !rate ? '，稅金未換算' : ''}）</span>`;
  }
  host.innerHTML = `<div class="from-bar"><span>💺 哩程票 ${award}</span>${verdict}${back}</div>`;
  $('#cash-from-back').addEventListener('click', () => showTab('search'));
}

function renderCash() {
  const box = $('#cash-results');
  const r = cash.req;
  if (cash.off) {
    box.innerHTML = `<div class="search-card cash-off"><p>即時現金票價尚未啟用，網站需要設定 SerpApi 金鑰（Google 航班資料來源）。現在可以先用下面的按鈕，帶著你填的條件到 Google 航班或 Skyscanner 查詢。</p>${cashLinks(r)}</div>`;
    bindCashLinks();
    return;
  }
  if (cash.chosen) return renderChosen(box);
  const ins = cash.insights;
  const level = ins && LEVEL[ins.level];
  const showing = cash.returns || cash.options;
  const rows = sortedFares(showing);
  const best = rows.filter(({ o }) => o.best);
  const other = rows.filter(({ o }) => !o.best);
  const mode = cash.returns ? 'ret' : 'out';
  box.innerHTML = `
    ${ins && !cash.returns ? `<div class="insight">
      <div><span>目前最低</span><b>${money(ins.lowest)}</b></div>
      ${level ? `<div><span>價格水準</span><b class="${level[1]}">${level[0]}</b></div>` : ''}
      ${ins.range ? `<div><span>一般價格區間</span><b>${money(ins.range[0])} – ${fmt(ins.range[1])}</b></div>` : ''}
      ${sparkline(ins.history)}
    </div>` : ''}
    ${!cash.returns ? '<div id="cash-month-host"></div>' : ''}
    ${cash.returns ? `<div class="picked"><span>已選去程</span>${fareHtml(cash.outbound, -1, 'picked')}<button type="button" class="outline" id="cash-back">← 重新選去程</button></div><h2 class="section">選擇回程（顯示的是來回總價）</h2>` : ''}
    <div class="cash-tools">
      <label class="field">排序<select id="cash-sort">
        ${[['best', 'Google 推薦'], ['price', '價格最低'], ['depart', '出發時間'], ['duration', '飛行時間最短']].map(([v, l]) => `<option value="${v}" ${cash.sort === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select></label>
      ${r.stops === '1' ? '' : `<label class="switch"><input type="checkbox" id="cash-direct" ${cash.directOnly ? 'checked' : ''}><span class="knob"></span>只看直飛</label>`}
      ${cashLinks(r, cash.googleUrl)}
    </div>
    ${!rows.length ? '<div class="empty"><div class="empty-icon">🔎</div><p>沒有符合條件的航班，換個日期或放寬轉機條件試試。</p></div>' : ''}
    ${best.length && cash.sort === 'best' ? `<h2 class="section">最佳航班</h2>${best.map(({ o, i }) => fareHtml(o, i, mode)).join('')}` : ''}
    ${(cash.sort === 'best' ? other : rows).length ? `${cash.sort === 'best' && best.length ? '<h2 class="section">其他航班</h2>' : ''}${(cash.sort === 'best' ? other : rows).map(({ o, i }) => fareHtml(o, i, mode)).join('')}` : ''}`;

  bindFareToggles(box);
  $('#cash-sort').addEventListener('change', (e) => { cash.sort = e.target.value; renderCash(); });
  // The form's 轉機 setting asked the fare source; this switch only filters what came back. They stay in step.
  $('#cash-direct')?.addEventListener('change', (e) => {
    cash.directOnly = e.target.checked;
    cashForm.stops.value = e.target.checked ? '1' : r.stops;
    renderCash();
  });
  $$('[data-ret]', box).forEach((b) => b.addEventListener('click', () => loadReturns(cash.options[Number(b.dataset.ret)])));
  $$('[data-pick]', box).forEach((b) => b.addEventListener('click', () => choose(showing[Number(b.dataset.pick)])));
  $('#cash-back')?.addEventListener('click', () => { cash.returns = null; cash.outbound = null; renderCash(); });
  renderCashMonth();
  bindCashLinks();
}
function bindFareToggles(box) {
  $$('.fare-main', box).forEach((el) => {
    const toggle = () => {
      const d = el.nextElementSibling;
      d.hidden = !d.hidden;
      el.setAttribute('aria-expanded', String(!d.hidden));
    };
    el.addEventListener('click', toggle);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  });
}

// ---------- 整月價格 (lowest fare per departure day) ----------
const cashMonthOk = (r) => cashCfg.calendar && /^[A-Z]{3}$/.test(r.origin) && /^[A-Z]{3}$/.test(r.destination);
// About three weeks before the trip to five after, never past the last day the fare sources quote.
function cashMonthRange(r) {
  const tomorrow = isoDate(1);
  const start = [isoDateFrom(r.depart, -21), tomorrow].sort().at(-1);
  return { start, end: [isoDateFrom(start, 59), isoDate(CASH_MAX_DAYS)].sort()[0] };
}
// Fits a price into a small calendar cell: 9,200 → 9.2千, 12,400 → 1.24萬.
const shortTwd = (p) => (p >= 1e5 ? `${Math.round(p / 1e4)}萬` : p >= 9950 && p < 1e4 ? '1萬' : p >= 1e4 ? `${+(p / 1e4).toFixed(2)}萬` : p >= 1e3 ? `${+(p / 1e3).toFixed(1)}千` : String(p));
const tripDays = (r) => (r.ret ? Math.round((Date.parse(r.ret) - Date.parse(r.depart)) / 864e5) : 0);
// Month grid block only, so holidays arriving later don't redraw the fare list.
function renderCashMonth() {
  const host = $('#cash-month-host');
  if (!host) return;
  host.innerHTML = cashMonthHtml();
  $('#cash-month-btn', host)?.addEventListener('click', loadCashMonth);
  $$('[data-mdate]', host).forEach((b) => b.addEventListener('click', () => {
    const r = cash.req;
    const shift = tripDays(r);
    cashDates.depart.set(b.dataset.mdate);
    if (r.ret) cashDates.ret.set(isoDateFrom(b.dataset.mdate, shift));
    // The new search covers the same weeks, so the grid and its holiday marks stay.
    cash.keepMonth = cash.month;
    cashForm.requestSubmit();
  }));
}
function cashMonthHtml() {
  const r = cash.req;
  if (!r || !cashMonthOk(r)) return '';
  const m = cash.month;
  if (!m) {
    return `<div class="cash-month"><button type="button" class="outline" id="cash-month-btn">📅 看前後幾週每天的最低價（會用掉 1 次查價）</button></div>`;
  }
  if (m.busy) return '<div class="cash-month"><p class="hint">正在查詢每天的最低價…</p></div>';
  if (m.err) return `<div class="cash-month"><p class="status error">${esc(m.err)}</p></div>`;
  if (!m.days.length) return '<div class="cash-month"><p class="hint">這段期間查不到每日價格，請直接換日期搜尋。</p></div>';
  const price = new Map(m.days.map((d) => [d.date, d.price]));
  const uniq = [...new Set(m.days.map((d) => d.price))].sort((a, b) => a - b);
  const level = (p) => (uniq.length === 1 ? 4 : 4 - Math.min(3, Math.floor((uniq.indexOf(p) / (uniq.length - 1)) * 4)));
  const low = uniq[0];
  const last = isoDate(CASH_MAX_DAYS);
  const cell = (iso) => {
    const p = price.get(iso);
    const hol = holidayMark(HOL.cash, iso);
    const note = `${iso}（${dowOf(iso)}）${p ? ` 最低 NT$${fmt(p)}` : ''}${hol.title ? `\n${hol.title}` : ''}`;
    return p && iso <= last
      ? `<button type="button" class="day has h${level(p)} ${iso === r.depart ? 'sel' : ''} ${p === low ? 'low' : ''} ${hol.cls}" data-mdate="${iso}" title="${esc(note)}">${Number(iso.slice(8))}<b>${shortTwd(p)}</b></button>`
      : `<div class="day ${hol.cls}" title="${esc(note)}">${Number(iso.slice(8))}<b>—</b></div>`;
  };
  const months = [];
  for (let ym = m.start.slice(0, 7); ym <= m.end.slice(0, 7); ym = monthAdd(ym, 1)) {
    const lastDay = new Date(`${monthAdd(ym, 1)}-01T00:00:00Z`);
    lastDay.setUTCDate(0);
    const from = ym === m.start.slice(0, 7) ? m.start : `${ym}-01`;
    const to = ym === m.end.slice(0, 7) ? m.end : lastDay.toISOString().slice(0, 10);
    const cells = DOW.map((d) => `<div class="dow">${d}</div>`);
    for (let i = 0; i < new Date(from + 'T00:00:00Z').getUTCDay(); i++) cells.push('<div class="day pad"></div>');
    for (let d = from; d <= to; d = isoDateFrom(d, 1)) cells.push(cell(d));
    const lows = m.days.filter((d) => d.date >= from && d.date <= to).map((d) => d.price);
    months.push(`<div class="cal-month"><div class="cal-mtitle">${ym.slice(0, 4)} 年 ${Number(ym.slice(5))} 月${lows.length ? `<small>最低 <b>NT$${fmt(Math.min(...lows))}</b></small>` : ''}</div><div class="cal mini">${cells.join('')}</div></div>`);
  }
  const cheapest = m.days.filter((d) => d.price === low).map((d) => dayLabel(d.date)).slice(0, 3).join('、');
  return `<div class="cash-month">
    <h2 class="section">每天最低價 <small>${m.round ? `來回、玩 ${tripDays(r)} 天的總價` : '單程價格'}${r.adults > 1 ? `，${r.adults} 人總價` : ''}；點日期用那天重新搜尋（再用 1 次查價）</small></h2>
    <p class="hint">最便宜：${cheapest} NT$${fmt(low)}${m.roundFailed ? '。來回的每日價格查不到，先顯示單程價格。' : ''}${m.mock ? '（示範資料）' : ''}${m.cached ? '（剛查過，這次沒有用到額度）' : ''}</p>
    <div class="cal-months">${months.join('')}</div>
    <div class="legend">便宜 <i style="background:var(--heat-4)"></i><i style="background:var(--heat-3)"></i><i style="background:var(--heat-2)"></i><i style="background:var(--heat-1)"></i> 較貴${holidayLegend(HOL.cash)}</div>
  </div>`;
}
async function loadCashMonth() {
  const r = cash.req;
  const n = ++seq.cashMonth;
  const { start, end } = cashMonthRange(r);
  cash.month = { busy: true, start, end, days: [] };
  renderCashMonth();
  try {
    const p = new URLSearchParams({ origin: r.origin, destination: r.destination, start, end, cabin: r.cabin, adults: String(r.adults) });
    if (r.ret) p.set('trip_days', String(tripDays(r)));
    const body = await cashApi(`/api/cash/calendar?${p}`);
    if (n !== seq.cashMonth) return;
    cash.month = { start, end, days: body.days || [], round: body.round, roundFailed: Boolean(r.ret) && !body.round, mock: body.mock, cached: Boolean(body.cached) };
    loadCashQuota();
    // Mark holidays across the whole grid, not just the trip dates; a newer search or grid drops this answer.
    fetchHolidays(r.destination, start, end).then((info) => {
      if (!info || n !== seq.cashMonth) return;
      setHolidays(HOL.cash, info, true);
      renderCashMonth();
    });
  } catch (err) {
    if (n !== seq.cashMonth) return;
    cash.month = { start, end, days: [], err: err.message };
  }
  renderCashMonth();
}

// The traveller picked the last leg: show both legs together, the total, and how to book.
function choose(o) {
  seq.booking++;
  Object.assign(cash, { chosen: { out: cash.returns ? cash.outbound : o, back: cash.returns ? o : null }, booking: null, bookingBusy: false, bookingErr: '' });
  const status = $('#cash-status');
  status.className = 'status';
  status.textContent = cash.returns ? '去程和回程都選好了，請確認下方的航班。' : '已選好航班，請確認下方的航班。';
  renderCash();
  status.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderChosen(box) {
  const r = cash.req;
  const { out, back } = cash.chosen;
  const total = (back || out).price;
  const per = total && r.adults > 1 ? Math.round(total / r.adults) : 0;
  box.innerHTML = `<div class="chosen">
    <h2 class="section">已選取的航班</h2>
    <div class="chosen-leg"><span class="leg-label">去程・${esc(dayLabel(r.depart))}</span>${fareHtml(out, -1, 'final')}</div>
    ${back ? `<div class="chosen-leg"><span class="leg-label">回程・${esc(dayLabel(r.ret))}</span>${fareHtml(back, -1, 'final')}</div>` : ''}
    <div class="chosen-total">
      <div><span>${back ? '來回' : '單程'}總價${r.adults > 1 ? `・${r.adults} 位成人` : ''}${CABIN_LABEL[r.cabin] ? `・${CABIN_LABEL[r.cabin]}` : ''}</span><b>${money(total)}</b>${per ? `<small>每人約 ${money(per)}</small>` : ''}</div>
      <div class="chosen-actions">
        <button type="button" class="outline" id="cash-plan">＋ 加入我的行程</button>
        ${watchCfg.on ? '<button type="button" class="outline" id="cash-watch">📉 追蹤降價</button>' : ''}
        ${back ? '<button type="button" class="outline" id="cash-reback">重新選回程</button>' : ''}
        <button type="button" class="outline" id="cash-back">重新選去程</button>
      </div>
    </div>
    <div id="watch-slot"></div>
    <div class="booking" id="cash-booking"></div>
    ${cashLinks(r, cash.googleUrl)}
  </div>`;
  bindFareToggles(box);
  $('#cash-plan').addEventListener('click', () => addLegs(cashLegs()));
  bindWatchButton(box);
  $('#cash-reback')?.addEventListener('click', () => { seq.booking++; cash.chosen = null; cash.booking = null; renderCash(); });
  $('#cash-back').addEventListener('click', () => { seq.booking++; Object.assign(cash, { chosen: null, booking: null, returns: null, outbound: null }); renderCash(); });
  renderBooking();
  bindCashLinks();
}

function bookingRowHtml(b, label) {
  if (!b) return '';
  const extras = [...b.baggage, ...b.extensions].map((x) => `<small>${esc(x)}</small>`).join('');
  let go = '';
  if (b.request && b.request.postData) {
    const fields = [...new URLSearchParams(b.request.postData)].map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
    go = `<form method="post" action="${esc(b.request.url)}" target="_blank" rel="noopener">${fields}<button type="submit" class="primary small">前往訂票 ↗</button></form>`;
  } else if (b.request) {
    go = `<a class="primary btn small" href="${esc(b.request.url)}" target="_blank" rel="noopener">前往訂票 ↗</a>`;
  } else if (b.linkToken) {
    go = `<button type="button" class="primary small" data-book-link="${esc(b.linkToken)}">前往訂票 ↗</button>`;
  } else if (b.phone) {
    go = `<a class="outline btn small" href="tel:${esc(b.phone.replace(/\s/g, ''))}">電話訂票 ${esc(b.phone)}</a>`;
  }
  return `<div class="book-opt">
    <div>${label ? `<small class="leg-tag">${label}</small>` : ''}<b>${esc(b.bookWith || '未知賣家')}</b>${b.isAirline ? ' <span class="pill">航空公司官網</span>' : ''}${b.title ? `<small>${esc(b.title)}</small>` : ''}${extras}</div>
    <div class="book-price"><b>${money(b.price)}</b>${go}</div>
  </div>`;
}

function renderBooking() {
  const host = $('#cash-booking');
  if (!host) return;
  const final = cash.chosen.back || cash.chosen.out;
  if (cash.bookingBusy) {
    host.innerHTML = '<p class="hint">正在向 Google 航班查詢預訂選項…</p>';
    return;
  }
  if (cash.booking) {
    const list = cash.booking;
    host.innerHTML = `<h3 class="sub">預訂選項</h3>
      ${list.length ? list.map((b) => (b.separate ? `${bookingRowHtml(b.departing, '去程')}${bookingRowHtml(b.returning, '回程')}` : bookingRowHtml(b))).join('') : '<p class="hint">Google 航班沒有提供這組航班的預訂選項，請用下面的連結到 Google 航班或 Skyscanner 訂票。</p>'}
      ${list.length ? `<p class="hint">價格與行李規定以賣家網站為準，按「前往訂票」會開新分頁。${list.some((b) => b.linkToken) ? '按下去才會取得訂票連結，每按一家用掉 1 次查價。' : ''}</p>` : ''}`;
    $$('[data-book-link]', host).forEach((b) => b.addEventListener('click', () => openBookingLink(b)));
    return;
  }
  host.innerHTML = `${cash.bookingErr ? `<p class="status error">${esc(cash.bookingErr)}</p>` : ''}
    ${final.bookingToken ? `<button type="button" class="primary" id="cash-book">查預訂選項（航空公司官網、旅行社價格）</button><p class="hint">會用掉 1 次查價${cash.provider === 'rapid' ? '，之後每開一家賣家的訂票連結再用 1 次' : ''}。也可以直接用下面的連結到 Google 航班訂票。</p>` : ''}`;
  $('#cash-book')?.addEventListener('click', loadBooking);
}

// RapidAPI sellers: open the tab right away (popup blockers allow it only inside the click), then point it at the link.
async function openBookingLink(btn) {
  const w = window.open('about:blank', '_blank');
  if (w) w.opener = null;
  btn.disabled = true;
  btn.textContent = '取得連結中…';
  try {
    const { url } = await cashApi(`/api/cash/link?${new URLSearchParams({ token: btn.dataset.bookLink })}`);
    if (w) w.location.href = url; else location.href = url;
    btn.textContent = '已開啟 ↗';
    loadCashQuota();
  } catch (err) {
    w?.close();
    btn.disabled = false;
    btn.textContent = '前往訂票 ↗';
    toast(err.message);
  }
}

async function loadBooking() {
  const final = cash.chosen.back || cash.chosen.out;
  const fresh = latest('booking');
  cash.bookingBusy = true;
  cash.bookingErr = '';
  renderBooking();
  try {
    const body = await cashApi(`/api/cash?${cashParams(cash.req, null, final.bookingToken)}`);
    if (!fresh()) return;
    cash.booking = body.bookingOptions || [];
  } catch (err) {
    if (!fresh()) return;
    cash.bookingErr = err.message;
  }
  cash.bookingBusy = false;
  renderBooking();
}

function bindCashLinks() {
  $('#cash-to-award')?.addEventListener('click', () => {
    const r = cash.req;
    pickers.origin.set(r.origin.split(','));
    pickers.destination.set(r.destination.split(','));
    datePickers.search.set(r.depart);
    setCabin(r.cabin);
    showTab('search');
    $('#search-form').requestSubmit();
  });
}

function cashParams(r, token, booking) {
  const p = new URLSearchParams({ origin: r.origin, destination: r.destination, depart: r.depart, cabin: r.cabin, adults: String(r.adults), stops: r.stops });
  if (r.ret) p.set('return', r.ret);
  if (r.alliance) p.set('alliance', r.alliance);
  if (token) p.set('token', token);
  if (booking) p.set('booking', booking);
  return p;
}

async function loadReturns(outbound) {
  const status = $('#cash-status');
  const fresh = latest('returns');
  status.className = 'status';
  status.textContent = '正在查詢回程航班…';
  try {
    const body = await cashApi(`/api/cash?${cashParams(cash.req, outbound.departureToken)}`);
    if (!fresh()) return;
    Object.assign(cash, { outbound, returns: body.options, chosen: null, booking: null, googleUrl: body.googleUrl || cash.googleUrl, sort: 'best' });
    status.textContent = `找到 ${body.options.length} 個回程選項${body.mock ? '（示範資料）' : ''}${cachedNote(body)}`;
    renderCash();
    status.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    if (!fresh()) return;
    showError(status, err, () => loadReturns(outbound));
  }
}

cashForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = $('#cash-status');
  const problem = await checkAirports(cashForm, [cashPickers.origin, cashPickers.destination]);
  if (problem) return formError(status, problem);
  const f = new FormData(cashForm);
  const rt = f.get('trip') === 'rt';
  const r = { origin: f.get('origin'), destination: f.get('destination'), depart: f.get('depart'), ret: rt ? f.get('return') : '', cabin: f.get('cabin') || 'Y', adults: Number(f.get('adults')) || 1, stops: f.get('stops') || '0', alliance: f.get('alliance') || '' };
  // No date: fill in a month from now (like 航線查詢) but let the visitor confirm first, since each search uses paid quota.
  if (!r.depart) {
    cashDates.depart.set(isoDate(30));
    if (rt && !r.ret) cashDates.ret.set(isoDate(37));
    $('#cash-depart .dp-btn').focus();
    return formError(status, `沒有選日期，先幫你填了 ${dayLabel(isoDate(30))} 出發${rt && !r.ret ? `、${dayLabel(isoDate(37))} 回程` : ''}；確認後再按一次「搜尋票價」。`);
  }
  if (rt && !r.ret) {
    cashDates.ret.set(isoDateFrom(r.depart, 7));
    $('#cash-return .dp-btn').focus();
    return formError(status, `沒有選回程日期，先幫你填了 ${dayLabel(isoDateFrom(r.depart, 7))}（一週後）；確認後再按一次，或改選「單程」。`);
  }
  // A day picked on the month grid keeps that grid (same weeks) and its holiday marks.
  const keep = cash.keepMonth && cash.req && cash.req.origin === r.origin && cash.req.destination === r.destination ? cash.keepMonth : null;
  const from = cash.pendingFrom || null;
  Object.assign(cash, { req: r, options: [], returns: null, outbound: null, chosen: null, booking: null, bookingBusy: false, bookingErr: '', insights: null, googleUrl: '', off: false, sort: 'best', directOnly: r.stops === '1', month: keep, keepMonth: null, pendingFrom: null, from });
  const fresh = latest('cash');
  if (!keep) {
    seq.cashMonth++;
    setHolidays(HOL.cash, {});
  }
  renderCashFrom();
  loadTripInfo($('#cash-trip'), { from: r.origin, to: r.destination, start: r.depart, end: r.ret || r.depart }, { hol: HOL.cash, merge: Boolean(keep), onHolidays: () => { if (fresh() && cash.month?.days) renderCashMonth(); } });
  seq.booking++;
  seq.returns++; // any pending return-leg lookup belongs to the previous search
  status.className = 'status';
  status.textContent = '正在查詢 Google 航班票價…';
  $('#cash-results').innerHTML = skeleton(5);
  const done = busy($('button[type=submit]', cashForm), '查詢中…');
  reveal(status);
  try {
    const body = await cashApi(`/api/cash?${cashParams(r)}`);
    if (!fresh()) return;
    done();
    if (!body.configured) {
      cash.off = true;
      status.textContent = '';
    } else {
      Object.assign(cash, { options: body.options, insights: body.insights, googleUrl: body.googleUrl, provider: body.provider, fallback: body.fallback || '' });
      rememberCashSearch(r, body.options);
      status.textContent = (body.options.length
        ? `找到 ${body.options.length} 個航班選項${body.mock ? '（示範資料）' : ''}${rt ? '，價格為來回總價，選去程後可看回程' : `，單程 ${r.adults} 人總價，選一班後可看預訂選項`}`
        : body.message || '沒有找到航班') + (body.fallback ? `（${body.fallback}，這次改用備用來源）` : '') + cachedNote(body);
      loadCashQuota();
    }
    renderCash();
    renderCashFrom();
    status.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    if (!fresh()) return;
    done();
    $('#cash-results').innerHTML = '';
    showError(status, err, () => cashForm.requestSubmit());
  }
});

const PROVIDER_NAME = { rapid: 'RapidAPI', serpapi: 'SerpApi' };
// A shared answer someone fetched a moment ago costs nothing; say so instead of counting it.
const cachedNote = (body) => (body?.cached ? '・剛查過，這次沒有用到額度' : '');

// Lookups left this month, as one number; which source has how many sits behind the ⓘ for the owner.
async function loadCashQuota() {
  const el = $('#cash-quota');
  if (!el || !cashCfg.enabled) return;
  try {
    const q = await api('/api/cash/quota');
    const srcs = [['RapidAPI', q.rapid], ['SerpApi', q.serpapi]].filter(([, x]) => x);
    if (!srcs.length) { el.hidden = true; return; }
    const left = srcs.reduce((n, [, x]) => n + (x.left ?? x.limit ?? 0), 0);
    const part = ([name, x]) => (x.left == null ? `${name} 還沒有查詢紀錄${x.limit ? `（每月 ${fmt(x.limit)} 次）` : ''}` : `${name} 剩 ${fmt(x.left)}${x.limit ? `／${fmt(x.limit)}` : ''} 次`);
    const last = PROVIDER_NAME[cash.provider] ? `上一次查詢用的是 ${PROVIDER_NAME[cash.provider]}。` : '';
    el.innerHTML = `📊 本月還能查 <b>${fmt(left)}</b> 次${q.mock ? '（示範數字）' : ''}
      <details class="info-i"><summary aria-label="查價額度明細">ⓘ</summary><p>${srcs.map(part).join('・')}。${q.rapid && q.serpapi ? '會先用 RapidAPI，用完、出錯或一次查多個機場時才用 SerpApi。' : ''}${last}</p></details>`;
    el.hidden = false;
  } catch { el.hidden = true; }
}

$$('#cash-form input[name=trip]').forEach((el) => el.addEventListener('change', () => {
  const rt = $('#cash-form input[name=trip]:checked').value === 'rt';
  $('#cash-return').hidden = !rt;
}));
$('#cash-swap').addEventListener('click', () => {
  const [o, d] = [cashPickers.origin.codes(), cashPickers.destination.codes()];
  cashPickers.origin.set(d);
  cashPickers.destination.set(o);
});
cashForm.depart.addEventListener('change', () => {
  if (cashForm.return.value && cashForm.return.value < cashForm.depart.value) cashDates.ret.set(cashForm.depart.value);
});

// ---------- rules ----------
const CONFIDENCE_TAG = {
  official: '<span class="tag ok">官方資料</span>',
  secondary: '<span class="tag verify">第三方整理</span>',
  verify: '<span class="tag verify">待核實</span>',
};
const ALLIANCE_SHORT = { oneworld: '寰宇一家', star: '星空聯盟', skyteam: '天合聯盟' };
const rulesState = { alliance: '', q: '' };

// The search box and chapter links sit at the top; the search covers every section, not just the program cards.
// [anchor, label, short label for phones]
const RULES_CHAPTERS = [['r-alliances', '航空聯盟', '聯盟'], ['am-chart', '亞萬哩數表', '亞萬表'], ['r-programs', '計畫規則', '計畫'], ['release-dates', '開票日', '開票'], ['points-rules', '信用卡轉點', '轉點'], ['r-glossary', '名詞解釋', '名詞']];
// Every chapter and every card starts folded to one line (a heading and a short summary), so the page reads as a short
// index; the search, the chapter chips and 「全部展開」 open what they point at. The chapter chips stay on screen.
// A section whose html starts with its <h2>: the heading and `sum` (one line, html) become the summary of a <details>.
function rulesSection(html, cls = '', sum = '') {
  const m = /^\s*(<h2[\s\S]*?<\/h2>)([\s\S]*)$/.exec(html);
  if (!m) return html ? `<section class="rules-sec ${cls}">${html}</section>` : '';
  return `<details class="rules-sec rules-fold ${cls}" ${rulesState.q ? 'open' : ''}><summary>${m[1]}${sum ? `<small class="sec-sum">${sum}</small>` : ''}</summary><div class="sec-body">${m[2]}</div></details>`;
}
function syncRulesAll() {
  const b = $('#rules-all');
  if (b) b.textContent = $$('#rules-body details').some((d) => !d.open) ? '全部展開' : '全部收合';
}
function renderRules() {
  $('#rules').innerHTML = `<div class="rules-top">
      <label class="rules-search"><span>搜尋規則庫</span><input type="search" id="rules-q" placeholder="例如：中停、燃油、效期、稅金" value="${esc(rulesState.q)}"></label>
      <div class="rules-tools"><p class="hint" id="rules-count" aria-live="polite"></p><button type="button" class="rules-all" id="rules-all">全部展開</button></div>
    </div>
    <nav class="rules-nav" aria-label="規則庫章節">${RULES_CHAPTERS.map(([id, t, s]) => `<button type="button" data-jump="${id}"><span class="tl">${t}</span><span class="ts" aria-hidden="true">${s}</span></button>`).join('')}</nav>
    <div id="rules-body"></div>`;
  let timer;
  $('#rules-q').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { rulesState.q = e.target.value.trim(); renderRulesBody(); }, 150);
  });
  $('.rules-nav').addEventListener('click', (e) => {
    const id = e.target.closest('[data-jump]')?.dataset.jump;
    const el = id && document.getElementById(id);
    if (!el) return;
    el.closest('details')?.setAttribute('open', '');
    // Below the sticky header and chapter chips.
    const offset = $('.top').offsetHeight + $('.rules-nav').offsetHeight + 12;
    window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - offset, behavior: 'smooth' });
  });
  // 全部展開 opens every chapter and card; once everything is open it reads 全部收合.
  $('#rules-all').addEventListener('click', () => {
    const all = $$('#rules-body details');
    const open = all.some((d) => !d.open);
    all.forEach((d) => (d.open = open));
    syncRulesAll();
  });
  $('#rules-body').addEventListener('toggle', syncRulesAll, true);
  renderRulesBody();
}

// Dated membership changes under each alliance card (joined, leaving on a date, about to join, being watched).
const MEMBER_STATUS = { joined: ['已加入', 'ok'], leaving: ['即將退出', 'warn'], left: ['已退出', 'warn'], upcoming: ['即將加入', 'soon'], watch: ['觀察中', ''] };
// The notes also carry upkeep reminders for whoever edits the data (「退出後請從 members 移除 OZ」); visitors get the news only.
const memberNoteText = (t) => String(t || '').replace(/^(即將加入|觀察中)：/, '').replace(/[，,]?\s*尚未列入 members/g, '').replace(/[^。]*members[^。]*。/g, '').trim();
function memberNotesHtml(notes) {
  if (!notes?.length) return '';
  return `<ul class="member-notes">${notes.map((n) => {
    const [label, cls] = MEMBER_STATUS[n.status] || [n.status || '', ''];
    return `<li><span class="tag ${cls}">${esc(label)}${n.date ? ` ${esc(n.date)}` : ''}</span> ${airlineLogo(n.code, 'sm')}<b>${esc(airlineZh(n.code))}</b>
      <small>${esc(memberNoteText(n.note))}${n.source?.url ? ` <a href="${esc(n.source.url)}" target="_blank" rel="noopener">${esc(n.source.label || '來源')} ↗</a>` : ''}</small></li>`;
  }).join('')}</ul>`;
}

function renderRulesBody() {
  const { alliances, programs, glossary } = data;
  const q = rulesState.q;
  // Each alliance folds to its logo, name and member count; open, it shows every member with its logo.
  const allianceCards = alliances.alliances.map((a) => `
    <details class="card al-card" id="al-${esc(a.id)}" ${q ? 'open' : ''}>
      <summary>${allianceLogo(a.id, 'lg')}<span class="card-head"><h3>${esc(a.name)}</h3>
        <small class="card-sum">${a.members.length} 家成員${a.memberNotes?.length ? `・${a.memberNotes.length} 則近期異動` : ''}</small></span></summary>
      <p>${esc(a.summary)}</p>
      <ul class="member-grid" aria-label="成員">${a.members.map((m) => `<li title="${esc(m)}">${airlineLogo(m, 'sm')}<span>${esc(airlineZh(m))}</span></li>`).join('')}</ul>
      ${memberNotesHtml(a.memberNotes)}
      <p class="src"><a href="${esc(a.url)}" target="_blank" rel="noopener">官方成員名單 ↗</a></p>
    </details>`).join('');
  const pts = data.points;
  const terms = glossary.sections.flatMap((s) => s.items.map((i) => i.term.replace(/\s*[（(].*$/, '')));

  $('#rules-body').innerHTML = [
    rulesSection(`<h2 class="section" id="r-alliances">航空聯盟</h2><div class="cards">${allianceCards}</div>
      <p class="hint logo-credit">標誌僅供辨識，商標屬各航空公司與聯盟（<a href="/logos/CREDITS.txt" target="_blank" rel="noopener">來源與授權</a>）。</p>`, '',
      `<span class="al-logos">${ALLIANCE_LOGOS.map((id) => allianceLogo(id, 'xs')).join('')}</span>三大聯盟的成員與近期異動`),
    rulesSection(amChartHtml(), '', '國泰與夥伴航空的單程獎勵哩數，依飛行距離分區'),
    rulesSection(`<h2 class="section" id="r-programs">哩程計畫規則</h2>
    <p class="hint">${esc(programs.disclaimer)}（最後整理：${esc(programs.lastReviewed)}）</p>
    <div class="filters" id="alliance-filter">
      <button type="button" class="chip ${rulesState.alliance ? '' : 'on'}" data-a="">全部</button>
      ${Object.entries(ALLIANCE_SHORT).map(([k, v]) => `<button type="button" class="chip ${rulesState.alliance === k ? 'on' : ''}" data-a="${k}">${allianceLogo(k, 'xs')}${v}</button>`).join('')}
      <button type="button" class="chip ${rulesState.alliance === 'none' ? 'on' : ''}" data-a="none" title="星宇、阿聯酋等沒有加入聯盟的航空">非聯盟</button>
    </div>
    <div class="cards" id="program-cards"></div>`, 'rules-programs', `${programs.programs.length} 個哩程計畫：計價、中停、燃油附加費、效期`),
    rulesSection(releaseTableHtml(), '', '各計畫最早在出發前幾天開放訂位'),
    rulesSection(pointsHtml(), '', pts ? `${pts.transfers.length} 條銀行點數轉哩程管道、${pts.cobrand.length} 張聯名卡` : ''),
    rulesSection(`<h2 class="section" id="r-glossary">名詞解釋</h2>${glossary.sections.map((s) => `<details class="sub-fold" ${q ? 'open' : ''}><summary><h3 class="sub">${esc(s.title)}</h3><small>${s.items.length} 個</small></summary>
      <div class="cards">${s.items.map((i) => `<div class="card"><h3>${esc(i.term)}</h3><p>${esc(i.desc)}</p></div>`).join('')}</div></details>`).join('')}`,
    '', `${terms.length} 個常見名詞，例如${terms.slice(0, 3).map(esc).join('、')}`),
  ].join('');
  // The section itself folds now, so its table opens with it instead of needing a second tap.
  $$('#rules-body .release-wrap').forEach((d) => (d.open = true));

  $$('#alliance-filter .chip').forEach((b) => b.addEventListener('click', () => {
    rulesState.alliance = b.dataset.a;
    $$('#alliance-filter .chip').forEach((x) => x.classList.toggle('on', x === b));
    renderProgramCards();
  }));
  renderProgramCards();
  bindPoints();
  bindTabLinks($('#rules'));
  filterRules();
}

// With a query: hide cards and table rows that don't mention it, hide sections left empty, and highlight the matches.
function filterRules() {
  const q = rulesState.q;
  const body = $('#rules-body');
  let hits = $$('#program-cards .card').length;
  for (const sec of $$('.rules-sec:not(.rules-programs)', body)) {
    const items = $$('.card, tbody tr, .promos li', sec);
    let n = 0;
    for (const it of items) {
      const ok = !q || it.textContent.includes(q);
      it.hidden = !ok;
      if (ok) n++;
      if (ok && q) markText(it, q);
    }
    // Glossary groups: hide a group whose cards are all hidden.
    for (const g of $$('details.sub-fold', sec)) g.hidden = Boolean(q) && $$('.card', g).every((c) => c.hidden);
    sec.hidden = Boolean(q) && !n && items.length > 0;
    if (q && n) $$('details', sec).forEach((d) => (d.open = true));
    if (q) hits += n;
  }
  $('.rules-programs', body).hidden = Boolean(q) && !$$('#program-cards .card').length;
  if (q) $$('details.rules-fold', body).forEach((d) => (d.open = true));
  $('#rules-count').textContent = q ? (hits ? `找到 ${hits} 筆含「${q}」的規則` : `沒有找到「${q}」，換個說法試試，例如「中停」「燃油」「效期」。`) : '';
}
// Wrap each occurrence of q in the element's text nodes with <mark>.
function markText(root, q) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) if (walker.currentNode.nodeValue.includes(q) && !walker.currentNode.parentElement.closest('mark')) nodes.push(walker.currentNode);
  for (const t of nodes) {
    const parts = t.nodeValue.split(q);
    const frag = document.createDocumentFragment();
    parts.forEach((p, i) => {
      if (i) { const m = document.createElement('mark'); m.textContent = q; frag.append(m); }
      if (p) frag.append(p);
    });
    t.replaceWith(frag);
  }
}

// Links that switch tab and optionally jump to a section on it.
function bindTabLinks(root) {
  $$('[data-tab-link]', root).forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    showTab(a.dataset.tabLink);
    const target = a.dataset.anchor && document.getElementById(a.dataset.anchor);
    target?.closest('details')?.setAttribute('open', '');
    if (target) window.scrollTo({ top: target.getBoundingClientRect().top + window.scrollY - 76 });
    else window.scrollTo({ top: 0 });
  }));
}

// ---------- 點數換算器 tab ----------
function renderPoints() {
  const host = $('#points-page');
  if (!host) return;
  const pts = data.points;
  const calc = pts && calcHtml(pts);
  if (!calc) { host.innerHTML = '<p class="hint">點數資料載入失敗，請重新整理。</p>'; return; }
  const view = pointsView.view;
  host.innerHTML = pointsTabsHtml() + (view === 'wallet' ? walletHtml() : view === 'need' ? needHtml() : view === 'detour' ? detourHtml() : view === 'upgrade' ? upgradeHtml()
    : `${calc}<p class="hint tab-link-hint">各銀行轉點的完整規則、入帳時間、來源，以及直接累積哩程的聯名卡，請看 <a href="#rules" data-tab-link="rules" data-anchor="points-rules">規則庫的「台灣信用卡點數轉哩程」</a>。</p>`);
  bindPointsTabs(host);
  if (view === 'wallet') bindWallet(host);
  else if (view === 'need') bindNeed(host);
  else if (view === 'detour') bindDetour(host);
  else if (view === 'upgrade') bindUpgrade(host);
  else bindCalc();
  bindTabLinks(host);
}

// Taiwan bank points that convert into airline miles, plus co-brand cards that earn miles directly.
function pointsHtml() {
  const pts = data.points;
  if (!pts || (!pts.transfers.length && !pts.cobrand.length)) return '';
  const src = (r) => (r.source ? `<a href="${esc(r.source.url)}" target="_blank" rel="noopener">${esc(r.source.label || '來源')} ↗</a>` : '');
  const tag = (r) => CONFIDENCE_TAG[r.confidence] || '';
  const keys = Object.entries(pts.programKeys || {});
  const transferRows = pts.transfers.map((r) => `<tr data-to="${esc((r.to || []).join(','))}">
      <td><b>${esc(r.bank)}</b><small>${esc(r.program)}</small></td><td data-l="轉到">${esc(r.toName)}</td><td data-l="比率"><b>${esc(r.ratio)}</b>${untilTag(r)}${r.min ? `<small>最低 ${esc(r.min)}</small>` : ''}${r.fee ? `<small>${esc(r.fee)}</small>` : ''}</td>
      <td data-l="說明">${r.notes ? esc(r.notes) : ''}</td><td data-l="來源">${tag(r)}<small>${src(r)}${r.date ? ` ${esc(r.date)}` : ''}</small></td></tr>`).join('');
  const cobrandRows = pts.cobrand.map((r) => `<tr>
      <td><b>${esc(r.bank)}</b><small>${esc(r.card)}</small></td><td data-l="累積到">${esc(r.program)}</td><td data-l="累積率"><b>${esc(r.earn)}</b></td><td data-l="說明">${r.notes ? esc(r.notes) : ''}</td><td data-l="來源">${tag(r)}<small>${src(r)}${r.date ? ` ${esc(r.date)}` : ''}</small></td></tr>`).join('');
  return `<h2 class="section" id="points-rules">台灣信用卡點數轉哩程</h2>
    <p class="hint">${esc(pts.disclaimer)}（最後整理：${esc(pts.lastReviewed)}）</p>
    ${pts.calc?.sources?.length ? '<p class="hint tab-link-hint">想直接算手上的點數能換多少哩？用「<a href="#points" data-tab-link="points">點數換算器</a>」分頁。</p>' : ''}
    ${pts.transfers.length ? `<div class="filters points-filter"><button type="button" class="chip on" data-p="">全部計畫</button>${keys.map(([k, label]) => `<button type="button" class="chip" data-p="${esc(k)}">${esc(label)}</button>`).join('')}</div>
    <div class="table-wrap points-table"><table id="points-table"><thead><tr><th>銀行／點數</th><th>轉到</th><th>比率</th><th>說明</th><th>來源</th></tr></thead><tbody>${transferRows}</tbody></table></div>
    <p class="hint" id="points-empty" hidden>這個計畫目前沒有整理到的轉點管道。</p>` : ''}
    ${pts.cobrand.length ? `<h3 class="sub">直接累積哩程的聯名卡</h3><div class="table-wrap points-table"><table><thead><tr><th>銀行／卡片</th><th>累積到</th><th>累積率</th><th>說明</th><th>來源</th></tr></thead><tbody>${cobrandRows}</tbody></table></div>` : ''}`;
}
// Dynamic conversion table: one row per bank points program, one column per airline program.
const CALC_COLS = [['eva', '長榮'], ['asiamiles', '亞洲萬里通'], ['ci', '華航'], ['sq', '新航'], ['other', '其他計畫']];
const CALC_PRESETS = [5000, 10000, 30000, 50000, 100000];
const calcState = { mode: 'p2m', amount: 10000, bank: '', detail: false, kind: 'air' };
// Hotel transfers reuse the same table: each hotel program is a column and its rate's `miles` holds hotel points.
function calcView(pts) {
  const h = pts.calc?.hotels;
  if (calcState.kind !== 'hotel' || !h?.rates?.length) return { kind: 'air', cols: CALC_COLS, sources: pts.calc.sources, unit: '哩', what: '哩程' };
  const counts = {};
  for (const r of h.rates) counts[r.to] = (counts[r.to] || 0) + 1;
  const cols = Object.keys(h.programs).filter((k) => counts[k]).sort((a, b) => counts[b] - counts[a]).map((k) => [k, h.programs[k]]);
  const all = [...pts.calc.sources, ...(h.extraSources || [])];
  // A bank's airline-rate date does not cover its hotel rates; hotel rates carry their own validUntil.
  const sources = all.map((src) => ({ ...src, note: '', validUntil: null, rates: h.rates.filter((r) => r.source === src.id).map((r) => ({ to: r.to, points: r.points, miles: r.hotelPoints, minPoints: r.minPoints || 0, stepPoints: r.stepPoints || 0, stepMiles: r.stepMiles || 0, secondary: r.confidence !== 'official', note: r.note, validUntil: r.validUntil })) }))
    .filter((src) => src.rates.length);
  return { kind: 'hotel', cols, sources, unit: '點', what: '飯店點數' };
}

// Hotel points differ a lot in value, so hotel mode always says so; the airline note stays behind the detail switch.
function calcNoteHtml() {
  const c = data.points.calc;
  if (calcView(data.points).kind === 'hotel') {
    const src = c.hotels.valueSource;
    return `${esc(c.hotels.note)}${src ? ` <a href="${esc(src.url)}" target="_blank" rel="noopener">${esc(src.label)} ↗</a>` : ''} 底色標示的是同一家飯店最划算的銀行。`;
  }
  return `${calcState.detail ? esc(c.note || '') : ''} 底色標示的是該計畫最划算的來源。`.trim();
}
function calcHtml(pts) {
  const sources = pts.calc?.sources || [];
  if (!sources.length) return '';
  const view = calcView(pts);
  const banks = [...new Set(view.sources.map((s) => s.bank))];
  if (calcState.bank && !banks.includes(calcState.bank)) calcState.bank = '';
  const hotel = view.kind === 'hotel';
  return `<div class="calc" id="calc">
    <div class="calc-bar">
      ${pts.calc.hotels?.rates?.length ? `<label class="field">換成<select id="calc-kind">${[['air', '✈ 航空哩程'], ['hotel', '🏨 飯店點數']].map(([k, l]) => `<option value="${k}" ${calcState.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>` : ''}
      <label class="field">我想算<select id="calc-mode">${[['p2m', hotel ? '手上的點數能換多少飯店點數' : '手上的點數能換多少哩'], ['m2p', hotel ? '想要的飯店點數需要多少點' : '想要的哩程需要多少點'], ['mine', '用「我的點數」各自計算']].map(([v, l]) => `<option value="${v}" ${calcState.mode === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="field"><span id="calc-amount-label">點數（假設每家都有這麼多）</span><input type="number" id="calc-amount" min="0" step="100" value="${calcState.amount}" inputmode="numeric"></label>
      <label class="field">銀行<select id="calc-bank"><option value="">全部銀行</option>${banks.map((b) => `<option value="${esc(b)}" ${calcState.bank === b ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select></label>
    </div>
    <div class="calc-options">
      <div class="presets calc-presets"><span class="presets-label">快速填入</span>${CALC_PRESETS.map((n) => `<button type="button" data-n="${n}">${fmt(n)}</button>`).join('')}</div>
      <label class="switch"><input type="checkbox" id="calc-detail" ${calcState.detail ? 'checked' : ''}><span class="knob"></span>顯示比率與備註</label>
    </div>
    ${hotel ? '' : promosHtml() + upcomingHtml()}
    <div class="table-wrap calc-table${calcState.detail ? '' : ' simple'}"><table id="calc-table"></table></div>
    <p class="hint" id="calc-note"></p>
  </div>`;
}

// Apply one bank rate to an amount: points → miles, or miles → points needed, honouring minimums and units.
function calcConvert(rate, amount, mode) {
  // Integer arithmetic (multiply before divide) so 18,600 × 1,000 ÷ 620 comes out as exactly 30,000.
  const toMiles = (pts) => Math.floor((pts * rate.miles) / rate.points);
  const toPoints = (miles) => Math.ceil((miles * rate.points) / rate.miles);
  if (mode === 'p2m') {
    let usable = amount;
    if (rate.stepPoints) usable = Math.floor(usable / rate.stepPoints) * rate.stepPoints;
    if (rate.minPoints && usable < rate.minPoints) return { short: `最低 ${fmt(rate.minPoints)} 點` };
    let miles = toMiles(usable);
    if (rate.stepMiles) miles = Math.floor(miles / rate.stepMiles) * rate.stepMiles;
    const floor = Math.max(rate.minMiles || 0, rate.stepMiles || 0);
    if (floor && miles < floor) return { short: `最低 ${fmt(floor)} 哩，約需 ${fmt(toPoints(floor))} 點` };
    if (miles <= 0) return { short: '不足 1 哩' };
    const used = toPoints(miles);
    return { value: miles, note: used < amount && amount - used >= 100 ? `用掉 ${fmt(used)} 點` : '' };
  }
  let miles = amount;
  if (rate.stepMiles) miles = Math.ceil(miles / rate.stepMiles) * rate.stepMiles;
  if (rate.minMiles) miles = Math.max(miles, rate.minMiles);
  let points = toPoints(miles);
  if (rate.stepPoints) points = Math.ceil(points / rate.stepPoints) * rate.stepPoints;
  if (rate.minPoints) points = Math.max(points, rate.minPoints);
  const got = toMiles(points);
  return { value: points, note: got !== amount ? `實得 ${fmt(got)} 哩` : '' };
}

function renderCalc() {
  const table = $('#calc-table');
  if (!table) return;
  const pts = data.points;
  const { amount: typed, bank, detail } = calcState;
  const mine = calcState.mode === 'mine';
  const mode = mine ? 'p2m' : calcState.mode;
  const view = calcView(pts);
  const CALC_COLS = view.cols;
  const unit = mode === 'p2m' ? view.unit : '點';
  const ratioText = (r) => `${fmt(r.points)} 點 = ${fmt(r.miles)} ${view.unit}`;
  // In "my points" mode each bank row converts its own balance from the wallet.
  const sources = view.sources.filter((s) => (!bank || s.bank === bank) && (!mine || wallet.banks[s.id]));
  const amountOf = (s) => (mine ? wallet.banks[s.id] || 0 : typed);
  const amount = mine ? (sources.length ? 1 : 0) : typed;
  if (mine && !sources.length) {
    table.innerHTML = `<tbody><tr><td class="none">還沒有填點數。請先到上方「我的點數」填入各銀行的點數。</td></tr></tbody>`;
    return;
  }
  if (!(amount > 0)) {
    table.innerHTML = `<thead><tr><th>請輸入${mode === 'p2m' ? '點數' : view.what}</th>${CALC_COLS.map(([, label]) => `<th>${label}</th>`).join('')}</tr></thead><tbody><tr><td colspan="${CALC_COLS.length + 1}" class="none">輸入數字後，這裡會列出每家銀行能換到的${view.what}。</td></tr></tbody>`;
    return;
  }
  // Best value per airline column: most miles, or fewest points needed.
  const best = {};
  // Active transfer bonuses only change the points-to-miles direction.
  const bonusOf = (s, col) => (mode === 'p2m' && view.kind === 'air' ? transferBonus(s, col) : null);
  const convert = (s, r) => {
    const out = calcConvert(r, amountOf(s), mode);
    const extra = out.value ? bonusMiles(out.value, bonusOf(s, r.to)) : 0;
    return extra ? { ...out, value: out.value + extra, extra } : out;
  };
  for (const s of sources) for (const r of s.rates) {
    if (r.to === 'other') continue;
    const v = convert(s, r).value;
    if (!v) continue;
    if (best[r.to] == null || (mode === 'p2m' ? v > best[r.to] : v < best[r.to])) best[r.to] = v;
  }
  const cell = (s, col) => {
    const rates = s.rates.filter((r) => r.to === col);
    if (!rates.length) return '<td class="none">—</td>';
    if (col !== 'other') {
      const r = rates[0];
      const out = convert(s, r);
      if (!out.value) return `<td class="short"><span>${esc(out.short)}</span>${detail ? `<small>${ratioText(r)}</small>` : ''}</td>`;
      const tags = detail && r.secondary ? '<small class="warn">第三方比率</small>' : '';
      const extra = detail ? `<small>${ratioText(r)}</small>${out.note ? `<small>${esc(out.note)}</small>` : ''}${r.note ? `<small>${esc(r.note)}</small>` : ''}${tags}` : '';
      const capped = view.kind === 'air' && cappedPromo(s, col);
      return `<td class="${out.value === best[col] && sources.length > 1 ? 'best' : ''}"><b>${mode === 'm2p' ? '需 ' : ''}${fmt(out.value)} ${unit}</b>${out.extra ? `<small class="bonus">🎁 含加贈 ${fmt(out.extra)} 哩</small>` : ''}${capped ? `<small class="bonus" title="${esc(capped.title)}">🎁 ${capText(promoCap(capped))}（未算進）</small>` : ''}${extra}</td>`;
    }
    // Other programs: group identical rates so 12 airlines at 1:1 take one line.
    const groups = new Map();
    for (const r of rates) {
      const k = [r.points, r.miles, r.minPoints, r.stepPoints, r.minMiles, r.stepMiles].join('/');
      if (!groups.has(k)) groups.set(k, { rate: r, names: [] });
      groups.get(k).names.push(r.name);
    }
    const lines = [...groups.values()].map(({ rate, names }) => {
      const out = calcConvert(rate, amountOf(s), mode);
      const label = names.length > 3 && !detail ? `${names.slice(0, 3).join('、')}等 ${names.length} 家` : names.join('、');
      return `<div><b>${out.value ? `${mode === 'm2p' ? '需 ' : ''}${fmt(out.value)} ${unit}` : esc(out.short)}</b><small title="${esc(names.join('、'))}">${esc(label)}${detail ? `，${ratioText(rate)}` : ''}</small></div>`;
    });
    return `<td class="others">${lines.join('')}</td>`;
  };
  const rows = sources.map((s) => `<tr><th scope="row"><b>${esc(s.bank)}</b><small>${esc(s.program)}${s.variant ? `（${esc(s.variant)}）` : ''}</small>${mine ? `<small>我有 ${fmt(amountOf(s))} 點</small>` : ''}${verifyTag(s)}${untilTag(s)}${detail && s.note ? `<small class="note">${esc(s.note)}</small>` : ''}</th>${CALC_COLS.map(([col, label]) => cell(s, col).replace('<td', `<td data-l="${esc(label)}"`)).join('')}</tr>`);
  table.innerHTML = `<thead><tr><th>${mine ? '我的點數可換' : mode === 'p2m' ? `${fmt(amount)} 點可換` : `換 ${fmt(amount)} ${view.unit}需要`}</th>${CALC_COLS.map(([, label]) => `<th>${label}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody>`;
}

function bindCalc() {
  const modeEl = $('#calc-mode');
  if (!modeEl) return;
  const amountEl = $('#calc-amount');
  const sync = () => {
    calcState.mode = modeEl.value;
    calcState.amount = Math.max(0, Math.floor(Number(amountEl.value) || 0));
    calcState.bank = $('#calc-bank').value;
    calcState.detail = $('#calc-detail').checked;
    $('#calc-amount-label').textContent = calcState.mode === 'm2p' ? `想換到的${calcView(data.points).what}` : calcState.mode === 'mine' ? '點數（改用「我的點數」）' : '點數（假設每家都有這麼多）';
    amountEl.disabled = calcState.mode === 'mine';
    $('.calc-table').classList.toggle('simple', !calcState.detail);
    $('#calc-note').innerHTML = calcNoteHtml();
    renderCalc();
  };
  modeEl.addEventListener('change', sync);
  amountEl.addEventListener('input', sync);
  $('#calc-bank').addEventListener('change', sync);
  $('#calc-detail').addEventListener('change', sync);
  $('#calc-kind')?.addEventListener('change', (e) => { calcState.kind = e.target.value; renderPoints(); });
  $$('.calc-presets button').forEach((b) => b.addEventListener('click', () => { if (calcState.mode === 'mine') modeEl.value = 'p2m'; amountEl.value = b.dataset.n; sync(); }));
  sync();
}

function bindPoints() {
  $$('.points-filter .chip').forEach((b) => b.addEventListener('click', () => {
    $$('.points-filter .chip').forEach((x) => x.classList.toggle('on', x === b));
    const p = b.dataset.p;
    let shown = 0;
    $$('#points-table tbody tr').forEach((tr) => {
      const hide = Boolean(p) && !tr.dataset.to.split(',').includes(p);
      tr.hidden = hide;
      if (!hide) shown++;
    });
    const empty = $('#points-empty');
    if (empty) empty.hidden = shown > 0;
  }));
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
  const al = rulesState.alliance;
  const list = programs.programs.filter((p) => (!al || (al === 'none' ? !p.alliance : p.alliance === al)) &&
    (!q || JSON.stringify(p).includes(q) || fieldRows.some(([, label]) => label.includes(q))));
  const mark = (text) => (q ? esc(text).split(esc(q)).join(`<mark>${esc(q)}</mark>`) : esc(text));
  // With a query, each card keeps only the fields that mention it (「中停」 shows every program's 中停 rule, nothing else).
  const fieldsOf = (p) => (q ? fieldRows.filter(([k, label]) => label.includes(q) || String(p[k] ?? '').includes(q)) : fieldRows);
  // Each card folds to the airline's logo, the program name and one line: its alliance and the first sentence of its
  // pricing rule. The data-quality and seats tags sit with the sources inside.
  const open = q ? 'open' : '';
  $('#program-cards').innerHTML = list.map((p) => `
    <details class="card prog-card" id="prog-${esc(p.id)}" ${open}>
      <summary>${airlineLogo(p.airline, 'md')}<span class="card-head"><h3>${esc(p.name)}${programChangeTag(p.id)}</h3>
      <small class="prog-sum">${esc(ALLIANCE_SHORT[p.alliance] || '非聯盟')}・${esc(String(p.pricing || '').split('。')[0])}</small></span></summary>
      ${fieldsOf(p).length ? `<dl>${fieldsOf(p).map(([k, label]) => `<dt>${mark(label)}</dt><dd>${mark(p[k])}</dd>`).join('')}</dl>` : ''}
      ${!q || String(p.notes || '').includes(q) ? `<p class="hint">${mark(p.notes)}</p>` : ''}
      <div class="src">${CONFIDENCE_TAG[p.confidence] || ''}${p.seatsAeroSource ? ' <span class="tag">可查座位</span>' : ''}
      來源（${esc(p.lastVerified || '')} 查核）：${(p.sources || []).map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a>`).join('、')}
      ・<a href="${esc(p.officialUrl)}" target="_blank" rel="noopener">官方網站 ↗</a></div>
    </details>`).join('') || '<p class="hint">沒有符合的計畫。</p>';
  syncRulesAll();
}

// ---------- footer version line ----------
function renderVersion(config) {
  if (!config.version) return;
  $('#ver-no').textContent = `v${config.version}`;
  $('#ver-date').textContent = config.updated || '—';
  if (config.commit) {
    const a = $('#ver-commit');
    a.textContent = config.commit;
    if (config.repo) a.href = `${config.repo}/commit/${config.commit}`; else a.removeAttribute('href');
    $('#ver-commit-wrap').hidden = false;
  }
  const history = config.history || [];
  // `user` is the plain-language line for visitors; `note` keeps the technical wording (older entries have only that).
  $('#ver-list').innerHTML = history.map((h) => `<li><b>v${esc(h.version)}</b> <span class="d">${esc(h.date)}</span> ${esc(h.user || h.note)}</li>`).join('');
  $('#ver-history').hidden = !history.length;
  $('#version-line').hidden = false;
}

// ---------- init ----------
// The data comes in two bundles, each cached per release (?v=): `core` for the first screen (index.html preloads it)
// and `more` (points, charts, rules, booking notes) once a search, a flight's details or a tab that needs it opens.
const DATA_CORE = ['airlines', 'alliances', 'airports', 'sourcenames', 'airlinenames', 'airportnames'];
const DATA_MORE = ['programs', 'glossary', 'asiamiles', 'points', 'booking', 'charts', 'products', 'promos', 'expiry', 'buymiles', 'changes', 'fees', 'holds', 'milecost', 'upgrades', 'callcenters'];
const DATA_KEY = { sourcenames: 'sourceNames', airlinenames: 'airlineNames', airportnames: 'airportNames' };
// Niceties the page works without: Chinese airline and airport names (codes show as they are), expiry rules,
// buy-miles prices, dated rule changes, and the fee, hold, cost-per-mile and upgrade notes.
const DATA_OPTIONAL = ['airlinenames', 'airportnames', 'expiry', 'buymiles', 'changes', 'fees', 'holds', 'milecost', 'upgrades', 'callcenters'];
async function loadPart(part, names) {
  try {
    const all = await api(`/api/data/${part}${ASSET_V ? `?v=${encodeURIComponent(ASSET_V)}` : ''}`);
    if (names.every((n) => all[n] || DATA_OPTIONAL.includes(n))) return all;
  } catch { /* fall back below */ }
  // The per-file endpoints, for a server without the bundles.
  const files = await Promise.all(names.map((n) => (DATA_OPTIONAL.includes(n) ? api(`/api/data/${n}`).catch(() => null) : api(`/api/data/${n}`))));
  return Object.fromEntries(names.map((n, i) => [n, files[i]]));
}
const putData = (all, names) => { for (const n of names) data[DATA_KEY[n] || n] = all[n]; };
let moreP = null;
let moreReady = false;
function loadMore() {
  moreP ||= loadPart('more', DATA_MORE).then((all) => { putData(all, DATA_MORE); moreReady = true; }).catch((err) => { moreP = null; throw err; });
  return moreP;
}
// Start on the first sign of a search (a tap or focus on the search page), so the results don't wait for it.
const warmMore = () => { loadMore().catch(() => {}); };
for (const ev of ['pointerdown', 'focusin']) $('#tab-search').addEventListener(ev, warmMore, { once: true });

tabInit.rules = () => renderRules();
tabInit.points = () => renderPoints();
tabInit.map = () => initRmap();
tabInit.hotels = () => initHotels();
tabInit.cash = () => loadCashQuota();

(async function init() {
  // A shared search link starts its search now, alongside the page data, instead of after it.
  const share = new URLSearchParams(location.search);
  const isShare = share.get('o') && share.get('d') && share.get('s');
  let pre = null;
  if (isShare && !share.get('al') && !normalizeShare(new URLSearchParams(share)).past) {
    pre = api(`/api/search?${searchQuery(normalizeShare(new URLSearchParams(share)))}`);
    pre.catch(() => {}); // handled when awaited
    $('#search-status').textContent = '正在搜尋各哩程計畫的獎勵位…';
  }
  // A link that opens results or a tab drawn from the second part fetches it alongside the first.
  if (isShare || NEEDS_MORE[currentTab]) warmMore();
  const [config, core] = await Promise.all([api('/api/config'), loadPart('core', DATA_CORE)]);
  putData(core, DATA_CORE);
  SOURCE_NAMES = data.sourceNames.names;
  indexAirlineNames(data.airlineNames);
  $('#mock-banner').hidden = !config.mock;
  renderVersion(config);
  cashCfg.locked = Boolean(config.cashLocked);
  cashCfg.enabled = config.cash !== 'off';
  cashCfg.calendar = config.cash === 'mock' || Boolean(config.cashSources?.rapid);
  cashCfg.serp = config.cash === 'mock' || Boolean(config.cashSources?.serpapi);
  cashCfg.accor = Boolean(config.hotels?.accor);
  watchCfg.on = Boolean(config.watch);
  loadWatches();
  Object.assign(alertCfg, config.alerts || {});
  $('#alerts-count').textContent = alertCfg.store ? '' : '（未啟用）';
  updateLockHint();
  renderMine();
  setCabin(store.get(CABIN_KEY_STORE, ''), { remember: false });

  const carrierSel = $('#search-form [name=carrier]');
  carrierSel.insertAdjacentHTML('beforeend', data.airlines.airlines.filter((a) => !AL.defunct[a.code]).map((a) => `<option value="${a.code}">${esc(a.name)}（${a.code}）</option>`).join(''));
  carrierSel.addEventListener('change', () => {
    const a = data.airlines.airlines.find((x) => x.code === carrierSel.value);
    if (a) $('#search-form').alliance.value = a.alliance || '';
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

  // Search and cash forms start blank (owner's choice); only region explore gets a default window.
  datePickers.explore.set(isoDate(30), isoDate(44));
  initFeatures();
  // Hidden tabs (rules, points, hotels) and the cash quota are set up when first opened.
  dataReady = true;
  ensureTab(currentTab);

  // Restore a shared search from the URL and run it.
  if (share.get('x') && share.get('program')) applyExploreShare(tabParams('explore'));
  else if (isShare) applyShare(tabParams('search'), true, pre);
})().catch((err) => {
  showError($('#search-status'), new Error(`初始化失敗：${err.message}`), () => location.reload());
});
