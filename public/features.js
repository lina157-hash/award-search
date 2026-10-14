// Extra tools added on top of app.js (loaded after it and sharing its globals):
// how to book, my points wallet, award release dates, miles-needed estimate, phantom-space warnings,
// daily deals, explore map, trip planner and the premium-product filter.

// ---------- programs: names and which Taiwan bank points transfer in ----------
const EXTRA_PROGRAM_NAMES = { eva: '長榮 無限萬哩遊', ci: '華航 華夏哩程', jal: '日航 JMB', ana: '全日空 ANA', starlux: '星宇 COSMILE' };
const programName = (key) => SOURCE_NAMES[key] || EXTRA_PROGRAM_NAMES[key] || key;
// Program key (seats.aero source, or eva/ci/jal) → the matching rate in data/points.json calc.sources.
const PROGRAM_TRANSFER = {
  asiamiles: { to: 'asiamiles' }, singapore: { to: 'sq' }, eva: { to: 'eva' }, ci: { to: 'ci' },
  aeroplan: { name: '加航' }, flyingblue: { name: '法荷航' }, united: { name: '聯合' }, qatar: { name: '卡達' },
  british: { name: '英航' }, turkish: { name: '土航' }, qantas: { name: '澳航' }, emirates: { name: '阿聯酋' },
  etihad: { name: '阿提哈德' }, lifemiles: { name: 'LifeMiles' }, jal: { name: '日航' },
};
const programKeyOf = (source) => (source === 'asiamiles_est' ? 'asiamiles' : source);

// Best rate from each bank points program into one airline program.
function transferRates(program) {
  const m = PROGRAM_TRANSFER[programKeyOf(program)];
  if (!m || !data.points?.calc) return [];
  const out = [];
  for (const s of data.points.calc.sources) {
    const rates = s.rates.filter((r) => (m.to ? r.to === m.to : r.to === 'other' && r.name === m.name));
    if (!rates.length) continue;
    const best = rates.reduce((a, b) => (b.miles / b.points > a.miles / a.points ? b : a));
    out.push({ source: s, rate: best });
  }
  return out.sort((a, b) => b.rate.miles / b.rate.points - a.rate.miles / a.rate.points);
}
const ratioLabel = (r) => (r.points === r.miles ? '1:1' : `${fmt(r.points)} 點換 ${fmt(r.miles)} 哩`);
const bankLabel = (s) => `${s.bank} ${s.program}${s.variant ? `（${s.variant}）` : ''}`;

// ---------- transfer bonuses and buy-miles sales (data/promos.json, refreshed by a weekly routine) ----------
const PROMO_COL = { singapore: 'sq' };
const promoCol = (p) => PROMO_COL[p.program] || p.program;
const activePromos = () => {
  const today = isoDate(0);
  return (data.promos?.promos || []).filter((p) => p.start <= today && today <= p.end).sort((a, b) => a.end.localeCompare(b.end));
};
// An active transfer bonus from this bank points program into one calculator column, if any.
// A bank-wide offer (bank null) covers every bank except the ones it names; rebates paid in bank points add no miles.
function transferBonus(source, col) {
  return activePromos().find((p) => p.type === 'transfer' && p.bonusPct > 0 && !p.rebate && promoCol(p) === col
    && (p.bank ? p.bank === source.bank : !(p.excludeBanks || []).includes(source.bank))) || null;
}
// Either a flat percentage, or a fixed bonus for each full block of miles (e.g. 800 per 10,000).
const bonusMiles = (miles, promo) => (!promo ? 0 : promo.bonusPer ? Math.floor(miles / promo.bonusPer[0]) * promo.bonusPer[1] : Math.floor((miles * promo.bonusPct) / 100));
const withBonus = (miles, promo) => miles + bonusMiles(miles, promo);
function promosHtml() {
  const list = activePromos();
  if (!data.promos) return '';
  const updated = data.promos.updated ? `資料更新於 ${data.promos.updated}` : '';
  if (!list.length) return `<p class="hint promos-none">🎁 目前沒有整理到進行中的轉點加贈或買哩優惠。${updated}</p>`;
  const row = (p) => `<li><b>${esc(p.title)}</b>${p.bonusPct ? ` <span class="pill">+${p.bonusPct}%</span>` : ''}${p.price ? ` <span class="pill">${esc(p.price)}</span>` : ''}
    <small>${mmdd(p.start)} – ${p.end.slice(0, 4) !== isoDate(0).slice(0, 4) ? `${p.end.slice(0, 4)}/` : ''}${mmdd(p.end)}${p.conditions ? `・${esc(p.conditions)}` : ''}　${CONFIDENCE_TAG[p.confidence] || ''}${(p.sources || []).slice(0, 1).map((x) => `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.label)} ↗</a>`).join('')}</small></li>`;
  const transfer = list.filter((p) => p.type === 'transfer');
  const buy = list.filter((p) => p.type === 'buy');
  return `<details class="promos"><summary>🎁 進行中的優惠 ${list.length} 項 <small>${updated}</small></summary>
    ${transfer.length ? `<h3 class="sub">轉點加贈</h3><ul>${transfer.map(row).join('')}</ul>` : ''}
    ${buy.length ? `<h3 class="sub">買哩促銷</h3><ul>${buy.map(row).join('')}</ul>` : ''}
    <p class="hint">送哩程的加贈已算進下方表格（標示「含加贈」）；回饋銀行點數的只列在這裡。活動多半要先登錄、有名額限制，條件以銀行或航空公司公告為準。</p></details>`;
}

// ---------- my points wallet (this browser only) ----------
const WALLET_KEY = 'wallet:v1';
const WALLET_PROGRAMS = ['eva', 'ci', 'asiamiles', 'singapore', 'jal', 'aeroplan', 'united', 'flyingblue', 'alaska', 'american', 'british', 'qatar', 'turkish', 'lifemiles', 'emirates', 'delta', 'starlux'];
const cleanCount = (v) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? Math.min(n, 1e9) : 0; };
function loadWallet() {
  const w = store.get(WALLET_KEY, {});
  const pick = (o) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).map(([k, v]) => [k, cleanCount(v)]).filter(([k, v]) => /^[\w-]{1,40}$/.test(k) && v));
  return { banks: pick(w.banks), miles: pick(w.miles) };
}
let wallet = { banks: {}, miles: {} };
const walletEmpty = () => !Object.keys(wallet.banks).length && !Object.keys(wallet.miles).length;

// Miles reachable in one program: own balance plus everything each bank balance could transfer in.
function reach(program) {
  const key = programKeyOf(program);
  const own = wallet.miles[key] || 0;
  const banks = [];
  for (const { source, rate } of transferRates(key)) {
    const pts = wallet.banks[source.id];
    if (!pts) continue;
    const got = withBonus(calcConvert(rate, pts, 'p2m').value || 0, rate.to !== 'other' ? transferBonus(source, rate.to) : null);
    if (got) banks.push({ source, rate, points: pts, miles: got });
  }
  return { own, banks, total: own + banks.reduce((n, b) => n + b.miles, 0) };
}

// ---------- booking channels, release windows, phantom space (data/booking.json) ----------
const bookingInfo = (program) => data.booking?.programs?.[programKeyOf(program)] || null;

function phantomWarnings(program, airlines) {
  const info = bookingInfo(program);
  if (!info?.phantom?.length) return [];
  const codes = String(airlines || '').split(/[,\s]+/).filter(Boolean);
  return info.phantom.filter((p) => p.airlines.includes('*') || p.airlines.some((a) => codes.includes(a)));
}

function howToBookHtml(program, milesNeeded) {
  const key = programKeyOf(program);
  if (!key) return '';
  const info = bookingInfo(key);
  const rates = transferRates(key);
  const lines = [];
  if (info?.booking) {
    const b = info.booking;
    const where = b.partnerOnline === true ? '官網可線上訂，夥伴航班也可以' : b.partnerOnline === 'partial' ? '官網可線上訂，部分夥伴航班要打電話' : b.ownOnline ? '自家航班可線上訂，夥伴航班要打電話' : '需要打電話訂';
    lines.push(`<li><b>訂位方式</b>　${where}${b.phoneFee ? `；${esc(b.phoneFee)}` : ''}${b.note ? `。${esc(b.note)}` : ''}</li>`);
  }
  // Banks the user holds come first, then the best ratios; only three show until expanded.
  const mine = (r) => (wallet.banks[r.source.id] ? 1 : 0);
  const sorted = [...rates].sort((a, b) => mine(b) - mine(a));
  const rateLi = ({ source, rate }) => `<li>${esc(bankLabel(source))}　<b>${ratioLabel(rate)}</b>${mine({ source }) ? ' <span class="ok-text">你有</span>' : ''}</li>`;
  lines.push(rates.length
    ? `<li><b>台灣可轉入</b><ul class="howto-rates">${sorted.slice(0, 3).map(rateLi).join('')}</ul>${sorted.length > 3 ? `<details class="howto-more"><summary>其他 ${sorted.length - 3} 家</summary><ul class="howto-rates">${sorted.slice(3).map(rateLi).join('')}</ul></details>` : ''}</li>`
    : '<li><b>台灣可轉入</b>　台灣的信用卡點數目前沒有直接轉入這個計畫，要用該計畫自己的哩程。</li>');
  if (!walletEmpty() && milesNeeded) {
    const r = reach(key);
    lines.push(`<li><b>你的點數</b>　${!r.total ? '你填的點數都不能用在這個計畫' : `最多可湊到 ${fmt(r.total)} 哩，${r.total >= milesNeeded ? '<span class="ok-text">夠換這張票</span>' : `還差 ${fmt(milesNeeded - r.total)} 哩`}`}</li>`);
  }
  if (info?.days) lines.push(`<li><b>開票</b>　${esc(info.windowNote || `約 ${info.days} 天前開放`)}</li>`);
  const src = info?.sources?.[0];
  return `<div class="howto"><h3>怎麼用 ${esc(programName(key))} 訂</h3><ul>${lines.join('')}</ul>${src ? `<p class="hint">資料來源：<a href="${esc(src.url)}" target="_blank" rel="noopener">${esc(src.label)} ↗</a>${info.confidence === 'secondary' ? '（第三方整理）' : ''}</p>` : ''}</div>`;
}

const phantomHtml = (program, airlines) => phantomWarnings(program, airlines).map((p) => `<p class="phantom">⚠️ ${esc(p.warning)}</p>`).join('');

// ---------- award release dates ----------
// For each program in the results, the first searched date that is not bookable yet and when it opens.
function releaseNotices(programs, start, end) {
  const today = isoDate(0);
  const out = [];
  for (const p of programs) {
    const info = bookingInfo(p);
    if (!info?.days) continue;
    const lastOpen = isoDateFrom(today, info.days);
    if (end <= lastOpen) continue;
    const first = start > lastOpen ? start : isoDateFrom(lastOpen, 1);
    out.push({ program: programKeyOf(p), days: info.days, first, opens: isoDateFrom(first, -info.days) });
  }
  const seen = new Set();
  return out.filter((n) => !seen.has(n.program) && seen.add(n.program)).sort((a, b) => a.opens.localeCompare(b.opens));
}

function releaseNoticeHtml(programs, start, end, route) {
  const list = releaseNotices(programs, start, end);
  if (!list.length) return '';
  return `<details class="release"><summary>⏳ 有 ${list.length} 個計畫還沒開放你查的部分日期</summary>
    <ul>${list.map((n) => `<li>${esc(programName(n.program))}：約 ${n.days} 天前開放，${mmdd(n.first)} 的座位約 <b>${n.opens.slice(0, 4) !== isoDate(0).slice(0, 4) ? `${n.opens.slice(0, 4)}/` : ''}${mmdd(n.opens)}</b> 開放
      <button type="button" class="linklike" data-ics="${esc(n.program)}|${n.opens}|${n.first}|${esc(route)}">📅 加入行事曆</button></li>`).join('')}</ul>
    <p class="hint">天數依各計畫公告或常見整理，實際開放時間可能差一兩天。</p></details>`;
}

// A one-event calendar file that reminds on the morning the seats open.
function downloadIcs(program, opens, flightDate, route) {
  const d = opens.replace(/-/g, '');
  const next = isoDateFrom(opens, 1).replace(/-/g, '');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const text = (s) => s.replace(/[\\;,]/g, (c) => `\\${c}`);
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//award-search//release//ZH', 'BEGIN:VEVENT',
    `UID:${program}-${d}-${flightDate}@award-search`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${next}`,
    `SUMMARY:${text(`${programName(program)} 開放 ${flightDate} ${route} 獎勵位`)}`,
    `DESCRIPTION:${text(`${programName(program)} 約今天開放 ${flightDate} 的獎勵機位，可以到機票搜索雷達查詢。`)}`,
    'BEGIN:VALARM', 'TRIGGER:PT9H', 'ACTION:DISPLAY', 'DESCRIPTION:獎勵位今天開放', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  a.download = `award-release-${program}-${opens}.ics`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
document.addEventListener('click', (e) => {
  const b = e.target.closest?.('[data-ics]');
  if (!b) return;
  const [program, opens, flightDate, route] = b.dataset.ics.split('|');
  downloadIcs(program, opens, flightDate, route);
});

function releaseTableHtml() {
  const progs = Object.entries(data.booking?.programs || {}).filter(([, v]) => v.days);
  if (!progs.length) return '';
  progs.sort((a, b) => b[1].days - a[1].days);
  const how = (b) => (!b ? '—' : b.partnerOnline === true ? '線上' : b.partnerOnline === 'partial' ? '線上，部分夥伴要來電' : b.ownOnline ? '自家線上，夥伴來電' : '來電');
  return `<h2 class="section" id="release-dates">開票日：最早幾天前可以訂</h2>
    <p class="hint">獎勵位通常在出發前固定天數開放。查詢日期超過這個天數時，搜尋結果上方會提醒你哪天開放，並可加入行事曆。</p>
    <details class="release-wrap"><summary>看 ${progs.length} 個計畫的天數</summary>
    <div class="table-wrap"><table class="release-table"><thead><tr><th>計畫</th><th>最早</th><th>訂位方式</th><th>來源</th></tr></thead><tbody>
    ${progs.map(([k, v]) => `<tr><td><b>${esc(programName(k))}</b>${v.windowNote ? `<small>${esc(v.windowNote)}</small>` : ''}</td><td class="num">${v.days} 天</td>
      <td>${how(v.booking)}${v.booking?.phoneFee ? `<small>${esc(v.booking.phoneFee)}</small>` : ''}</td>
      <td>${CONFIDENCE_TAG[v.confidence] || ''}${(v.sources || []).slice(0, 1).map((x) => `<small><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.label)} ↗</a></small>`).join('')}</td></tr>`).join('')}
    </tbody></table></div></details>`;
}

// ---------- points tab: converter / my points / miles needed ----------
const pointsView = { view: 'calc' };
function pointsTabsHtml() {
  const v = pointsView.view;
  return `<fieldset class="seg points-seg" aria-label="工具">${[['calc', '點數換算'], ['wallet', '我的點數'], ['need', '哩程試算']].map(([k, l]) =>
    `<label><input type="radio" name="points-view" value="${k}" ${k === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}</fieldset>`;
}
function bindPointsTabs(host) {
  $$('input[name=points-view]', host).forEach((i) => i.addEventListener('change', () => { pointsView.view = i.value; renderPoints(); }));
}

// Only what the user entered is listed; everything else is picked from one dropdown, so the page stays short.
const walletItemName = (kind, id) => {
  if (kind === 'm') return { name: programName(id), sub: '' };
  const s = (data.points?.calc?.sources || []).find((x) => x.id === id);
  return s ? { name: s.bank, sub: `${s.program}${s.variant ? `（${s.variant}）` : ''}` } : null;
};
function walletHtml() {
  const sources = data.points?.calc?.sources || [];
  return `<div class="wallet">
    <p class="hint">填入你手上的點數與哩程，只會存在這台裝置的瀏覽器，不會上傳。填好後，搜尋結果可以開「只看我換得起的」，航班明細也會告訴你夠不夠換。</p>
    <div id="wallet-list"></div>
    <div class="w-add">
      <select id="w-pick" aria-label="選擇點數或哩程"><option value="">選擇信用卡點數或航空哩程</option>
        <optgroup label="信用卡點數">${sources.map((x) => `<option value="b:${esc(x.id)}">${esc(bankLabel(x))}</option>`).join('')}</optgroup>
        <optgroup label="航空哩程">${WALLET_PROGRAMS.map((k) => `<option value="m:${esc(k)}">${esc(programName(k))}</option>`).join('')}</optgroup>
      </select>
      <input type="number" id="w-amt" min="0" step="100" inputmode="numeric" placeholder="數量" aria-label="數量">
      <button type="button" class="primary" id="w-add-btn">加入</button>
    </div>
    <div id="wallet-sum-wrap"><h3 class="sub">合計可換到</h3><div id="wallet-sum"></div></div>
  </div>`;
}
function renderWalletSum() {
  const host = $('#wallet-sum');
  if (!host) return;
  const keys = [...new Set([...WALLET_PROGRAMS, ...Object.keys(PROGRAM_TRANSFER)])];
  const rows = keys.map((k) => ({ k, r: reach(k) })).filter(({ r }) => r.total > 0).sort((a, b) => b.r.total - a.r.total);
  host.innerHTML = rows.length ? `<div class="table-wrap"><table class="wallet-sum"><thead><tr><th>計畫</th><th>最多可湊到</th><th>來源</th></tr></thead><tbody>
    ${rows.map(({ k, r }) => `<tr><td><b>${esc(programName(k))}</b></td><td><b>${fmt(r.total)} 哩</b></td><td><small>${[r.own ? `自有 ${fmt(r.own)}` : '', ...r.banks.map((b) => `${esc(b.source.bank)} ${fmt(b.points)} 點 → ${fmt(b.miles)}`)].filter(Boolean).join('、')}</small></td></tr>`).join('')}
    </tbody></table></div><p class="hint">每一列各自計算：同一筆點數只能轉進一個計畫，不能同時用在兩列。</p>`
    : '<p class="hint">加入點數後，這裡會算出每個航空計畫最多能湊到多少哩。</p>';
}
function renderWalletList() {
  const host = $('#wallet-list');
  if (!host) return;
  const items = [...Object.entries(wallet.banks).map(([id, n]) => ['b', id, n]), ...Object.entries(wallet.miles).map(([id, n]) => ['m', id, n])]
    .map(([kind, id, n]) => ({ kind, id, n, label: walletItemName(kind, id) })).filter((x) => x.label);
  host.innerHTML = items.length ? `${items.map(({ kind, id, n, label }) => `<div class="w-row"><span><b>${esc(label.name)}</b>${label.sub ? `<small>${esc(label.sub)}</small>` : ''}</span>
      <input type="number" min="0" step="100" inputmode="numeric" data-w="${kind}:${esc(id)}" value="${n}" aria-label="${esc(label.name)} 數量">
      <button type="button" class="w-del" data-w-del="${kind}:${esc(id)}" aria-label="移除 ${esc(label.name)}">×</button></div>`).join('')}
    <button type="button" class="outline" id="wallet-clear">清除全部</button>`
    : '<p class="w-empty">還沒有加入任何點數，從下面選一個開始。</p>';
}
function setWallet(ref, value) {
  const [kind, id] = ref.split(':');
  const bucket = kind === 'b' ? wallet.banks : wallet.miles;
  const n = cleanCount(value);
  if (n) bucket[id] = n; else delete bucket[id];
  if (walletEmpty()) store.del(WALLET_KEY); else store.set(WALLET_KEY, wallet);
}
function bindWallet(host) {
  const refresh = () => { renderWalletList(); renderWalletSum(); };
  const add = () => {
    const ref = $('#w-pick', host).value;
    const amt = $('#w-amt', host);
    if (!ref) { $('#w-pick', host).focus(); return; }
    if (!cleanCount(amt.value)) { amt.focus(); return; }
    setWallet(ref, amt.value);
    $('#w-pick', host).value = '';
    amt.value = '';
    refresh();
  };
  $('#w-add-btn', host).addEventListener('click', add);
  $('#w-amt', host).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  host.addEventListener('input', (e) => { if (e.target.dataset.w) { setWallet(e.target.dataset.w, e.target.value); renderWalletSum(); } });
  host.addEventListener('click', (e) => {
    const del = e.target.closest('[data-w-del]');
    if (del) { setWallet(del.dataset.wDel, 0); refresh(); return; }
    if (e.target.id === 'wallet-clear') {
      if (!confirm('清除所有填入的點數與哩程？')) return;
      wallet = { banks: {}, miles: {} };
      store.del(WALLET_KEY);
      refresh();
    }
  });
  refresh();
}

// ---------- miles needed (fixed award charts, no seat search) ----------
const need = { origin: '', destination: '', cabin: 'J' };
function haversineMiles(a, b) {
  const rad = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lon - a.lon) * rad) / 2) ** 2;
  return Math.round(2 * 3958.8 * Math.asin(Math.sqrt(h)));
}
// Airport lists win over country lists (Hawaii, EVA's US-East cities, China Airlines' city tiers…).
function inArea(area, ap) {
  if (area.excludeAirports?.includes(ap.code)) return false;
  if (area.airports?.includes(ap.code) || area.extraAirports?.includes(ap.code)) return true;
  return (area.countries || []).includes(ap.country);
}
function regionOf(regions, ap) {
  const list = Object.entries(regions || {});
  return (list.find(([, r]) => r.airports?.includes(ap.code)) || list.find(([, r]) => inArea(r, ap)))?.[0] || null;
}
const bandFor = (bands, dist) => bands.find((b) => b.upTo == null || dist <= b.upTo);
const bandNote = (dist, band) => `${fmt(dist)} 哩（${band.upTo == null ? '最高級距' : `${fmt(band.upTo)} 哩以內`}）`;
// Alaska picks its chart by where the trip goes; Aeroplan's zones tell us which part of the world each end is in.
function alaskaArea(a, b) {
  const ac = data.charts?.programs?.find((p) => p.id === 'aeroplan');
  const zones = [a, b].map((x) => (ac ? regionOf(ac.regions, x) : null));
  if (zones.includes('PAC')) return 'ASIA_PACIFIC';
  if (zones.includes('ATL')) return 'EMEA';
  return 'AMERICAS';
}
// Price one program's chart for a route; returns [{ label, miles, note }].
function chartPrices(p, from, to, cabin, dist) {
  const out = [];
  if (p.unknownCabins?.includes(cabin)) return out;
  if (p.kind === 'routeSpecific') {
    for (const r of p.routes || []) {
      const hit = (r.from.includes(from.code) && r.to.includes(to.code)) || (r.from.includes(to.code) && r.to.includes(from.code));
      if (hit && r[cabin]) out.push({ label: '自家航班', miles: r[cabin], note: `${r.from.join('/')} ↔ ${r.to.join('/')} 固定價` });
    }
    return out;
  }
  const area = p.id === 'alaska' ? alaskaArea(from, to) : null;
  for (const t of p.tables || []) {
    if (t.appliesWhen && t.appliesWhen !== area) continue;
    let miles = null;
    let note = '';
    if (p.kind === 'distance') {
      const d = p.distanceBasis === 'roundTripTotal' ? dist * 2 : dist;
      const band = bandFor(t.bands, d);
      miles = band ? band[cabin] : null;
      if (band) note = p.oneWay === false ? `來回總價；來回 ${bandNote(d, band)}` : bandNote(d, band);
    } else if (p.kind === 'zone') {
      // Zone charts here are priced from Taiwan.
      const [home, away] = from.country === 'TW' ? [from, to] : to.country === 'TW' ? [to, from] : [];
      if (!home) continue;
      const z = t.zones.find((x) => x.airports?.includes(away.code)) || t.zones.find((x) => inArea(x, away));
      miles = z ? z[cabin] : null;
      if (z) note = `台灣 ↔ ${z.name}${z.note ? `；${z.note}` : ''}`;
    } else if (p.kind === 'regionMatrix') {
      const ra = regionOf(p.regions, from);
      const rb = regionOf(p.regions, to);
      if (!ra || !rb) continue;
      const pair = t.pairs.find((x) => x.from === ra && x.to === rb) || t.pairs.find((x) => x.from === rb && x.to === ra);
      if (!pair) continue;
      const band = pair.bands ? bandFor(pair.bands, dist) : pair;
      miles = band ? band[cabin] : null;
      if (band) note = `${p.regions[ra].name} ↔ ${p.regions[rb].name}${pair.bands ? `・${bandNote(dist, band)}` : ''}`;
    }
    if (miles) out.push({ label: t.label, miles, note });
  }
  return out;
}
function needHtml() {
  return `<form id="need-form" class="need" autocomplete="off">
    <p class="hint">不查座位，只依各計畫公布的固定哩程表，估算單程一個人要多少哩。動態定價的計畫（聯合、達美、法荷航等）沒有固定表，請用航線查詢看實際價格。</p>
    <div class="route-row">
      <div class="field grow ac-host">
        <label for="n-origin">出發地</label>
        <div class="chips-box" data-for="origin"><span class="chips"></span>
          <input id="n-origin" class="chips-q" placeholder="城市、機場或代碼" autocapitalize="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="ac-n-origin"></div>
        <input type="hidden" name="origin" value="${esc(need.origin)}">
        <div class="ac-list" id="ac-n-origin" role="listbox" aria-label="出發地建議" hidden></div>
      </div>
      <div class="field grow ac-host ac-end">
        <label for="n-destination">目的地</label>
        <div class="chips-box" data-for="destination"><span class="chips"></span>
          <input id="n-destination" class="chips-q" placeholder="城市、機場或代碼" autocapitalize="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="ac-n-destination"></div>
        <input type="hidden" name="destination" value="${esc(need.destination)}">
        <div class="ac-list" id="ac-n-destination" role="listbox" aria-label="目的地建議" hidden></div>
      </div>
    </div>
    <div class="opts-row">
      <fieldset class="seg" aria-label="艙等">${Object.entries({ Y: '經濟', W: '豪經', J: '商務', F: '頭等' }).map(([k, l]) => `<label><input type="radio" name="cabin" value="${k}" ${need.cabin === k ? 'checked' : ''}><span>${l}</span></label>`).join('')}</fieldset>
      <button type="submit" class="primary">試算</button>
    </div>
  </form>
  <div id="need-result"></div>`;
}
function bindNeed(host) {
  const form = $('#need-form', host);
  const pk = { origin: createAirportPicker(form, 'origin'), destination: createAirportPicker(form, 'destination') };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    for (const p of Object.values(pk)) {
      const unknown = p.commit();
      if (unknown.length || !p.codes().length) { toast(unknown.length ? `找不到「${unknown.join('、')}」` : `請輸入${p.label}`); p.focus(); return; }
    }
    need.origin = pk.origin.codes()[0];
    need.destination = pk.destination.codes()[0];
    need.cabin = new FormData(form).get('cabin') || 'J';
    renderNeed();
  });
  if (need.origin && need.destination) renderNeed();
}
function renderNeed() {
  const host = $('#need-result');
  const a = AP.byCode.get(need.origin);
  const b = AP.byCode.get(need.destination);
  if (!host || !a || !b || a.lat == null || b.lat == null) return;
  const dist = haversineMiles(a, b);
  const c = need.cabin;
  const rows = [];
  // Asia Miles from the chart the site already carries.
  for (const kind of ['cx', 'partner']) {
    const am = amPrice(kind, dist, c, need.origin, need.destination);
    if (am?.miles) rows.push({ key: 'asiamiles', label: kind === 'cx' ? '國泰航班' : '夥伴航班', miles: am.miles, note: `${fmt(dist)} 哩`, confidence: 'official' });
  }
  for (const p of data.charts?.programs || []) {
    // Round-trip-only charts don't compare with one-way prices, so they stay out of this table.
    if (!['distance', 'zone', 'regionMatrix', 'routeSpecific'].includes(p.kind) || p.oneWay === false) continue;
    // One row per program: its cheapest table, plus the top of the range when partners price differently.
    const prices = chartPrices(p, a, b, c, dist).sort((x, y) => x.miles - y.miles);
    if (!prices.length) continue;
    const [x] = prices;
    const top = prices[prices.length - 1].miles;
    rows.push({ key: p.id, name: p.name, label: x.label, miles: x.miles, note: `${x.note}${top > x.miles ? `；其他航空最高 ${fmt(top)} 哩` : ''}`, confidence: p.confidence, perSegment: p.perSegment, src: p.sources?.[0], pnote: p.note });
  }
  rows.sort((x, y) => x.miles - y.miles);
  const dyn = (data.charts?.programs || []).filter((p) => p.kind === 'dynamic' || (p.kind === 'routeSpecific' && !p.routes?.length)).map((p) => p.name || programName(p.id));
  host.innerHTML = `<h3 class="sub">${esc(need.origin)} ${esc(airportCity(need.origin))} → ${esc(need.destination)} ${esc(airportCity(need.destination))}　${CABIN_LABEL[c]}・直線距離 ${fmt(dist)} 哩</h3>
    ${rows.length ? `<div class="table-wrap"><table class="need-table"><thead><tr><th>計畫</th><th>單程哩數</th><th>依據</th><th>資料</th></tr></thead><tbody>
      ${rows.map((r, i) => `<tr class="${i === 0 ? 'best-row' : ''}"><td><b>${esc(r.name || programName(r.key))}</b><small>${esc(r.label)}</small></td><td><b>${fmt(r.miles)} 哩</b></td>
        <td><small>${esc(r.note)}${r.perSegment ? '；每段航班分開計價，轉機會更貴' : ''}</small></td>
        <td>${CONFIDENCE_TAG[r.confidence] || ''}${r.src ? `<small><a href="${esc(r.src.url)}" target="_blank" rel="noopener">${esc(r.src.label)} ↗</a></small>` : ''}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="hint">這條航線找不到適用的固定哩程表。</p>'}
    <p class="hint">以直線距離或區域估算，最低（Saver）價格；實際轉機路線、旺季與燃油附加費可能讓價格不同。${dyn.length ? `${esc(dyn.join('、'))} 為動態定價，不列入。` : ''}</p>
    <button type="button" class="outline" id="need-search">用航線查詢找實際座位</button>`;
  $('#need-search').addEventListener('click', () => {
    pickers.origin.set([need.origin]);
    pickers.destination.set([need.destination]);
    const cab = $(`#search-form input[name=cabin][value="${c}"]`);
    if (cab) cab.checked = true;
    showTab('search');
    $('#search-form .dp-btn').focus();
    toast('選好出發日期後按「搜尋機位」');
  });
}

// ---------- daily deals (shown on the search page before searching) ----------
const dealsState = { cabin: 'J', body: null };
async function loadDeals() {
  const host = $('#deals');
  if (!host) return;
  try {
    dealsState.body = await api('/api/deals');
    renderDeals();
  } catch {
    host.innerHTML = '';
  }
}
function renderDeals() {
  const host = $('#deals');
  const body = dealsState.body;
  if (!host || !body) return;
  if (!body.groups.some((g) => g.items.length)) { host.innerHTML = ''; return; }
  // Only offer the cabin switch when both cabins found something.
  const cabins = ['J', 'F'].filter((c) => body.groups.some((g) => g.cabin === c && g.items.length));
  if (!cabins.includes(dealsState.cabin)) dealsState.cabin = cabins[0];
  const groups = body.groups.filter((g) => g.cabin === dealsState.cabin && g.items.length);
  host.innerHTML = `<div class="deals-head"><h2 class="section-title">今日好康 <small>台北出發最便宜的獎勵位・${body.generatedAt ? `${ago(body.generatedAt)}整理` : ''}${body.mock ? '（示範資料）' : ''}</small></h2>
    ${cabins.length > 1 ? `<fieldset class="seg" aria-label="艙等">${[['J', '商務'], ['F', '頭等']].map(([k, l]) => `<label><input type="radio" name="deal-cabin" value="${k}" ${dealsState.cabin === k ? 'checked' : ''}><span>${l}</span></label>`).join('')}</fieldset>` : `<span class="hint">${dealsState.cabin === 'F' ? '頭等艙' : '商務艙'}</span>`}</div>
    ${groups.map((g) => `<div class="deal-group"><h3 class="sub">${esc(g.name)}</h3><div class="deal-row">${g.items.slice(0, 4).map((d) => `
      <button type="button" class="deal-mini" data-deal="${esc(d.origin)}|${esc(d.destination)}|${esc(d.date)}">
        <span class="dm-route">${esc(d.origin)} → ${esc(d.destination)} <small>${esc(airportCity(d.destination))}</small></span>
        <span class="dm-miles">${fmt(d.miles)} <small>哩</small></span>
        <span class="dm-meta">${mmdd(d.date)}（${dowOf(d.date)}）· ${esc(srcName(d.source))}${d.direct ? ' · 直飛' : ''}</span>
      </button>`).join('')}</div></div>`).join('') || '<p class="hint">這個艙等今天沒有整理到好康。</p>'}
    <p class="hint">每天早上整理一次，座位可能已被訂走；點卡片會查那一天前後三天。</p>`;
  $$('input[name=deal-cabin]', host).forEach((i) => i.addEventListener('change', () => { dealsState.cabin = i.value; renderDeals(); }));
  $$('[data-deal]', host).forEach((b) => b.addEventListener('click', () => {
    const [o, d, date] = b.dataset.deal.split('|');
    const s = date < isoDateFrom(isoDate(0), 3) ? isoDate(0) : isoDateFrom(date, -3);
    applyShare(new URLSearchParams({ o, d, s, e: isoDateFrom(date, 3), c: dealsState.cabin }));
  }));
}

// ---------- explore map (Leaflet, loaded on first use) ----------
let leafletReady = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve();
  leafletReady ||= new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css';
    document.head.append(css);
    const js = document.createElement('script');
    js.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js';
    js.onload = () => resolve();
    js.onerror = () => { leafletReady = null; reject(new Error('地圖元件載入失敗，請檢查網路後再試')); };
    document.head.append(js);
  });
  return leafletReady;
}
const isDark = () => document.documentElement.dataset.theme === 'dark' || (document.documentElement.dataset.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
let exMap = null;
async function renderExploreMap(rows) {
  const box = $('#ex-table');
  box.innerHTML = '<div id="ex-map" class="ex-map"><p class="hint">地圖載入中…</p></div><p class="hint">圓圈是目的地，數字是最低哩數（千哩）；點圓圈看細節。</p>';
  try {
    await loadLeaflet();
  } catch (err) {
    box.innerHTML = `<p class="status error">${esc(err.message)}</p>`;
    return;
  }
  if (!$('#ex-map')) return;
  $('#ex-map').innerHTML = '';
  if (exMap) { exMap.remove(); exMap = null; }
  const byDest = new Map();
  for (const r of rows) {
    const g = byDest.get(r.destination) || { code: r.destination, min: Infinity, n: 0, best: null };
    g.n++;
    if (r.miles < g.min) { g.min = r.miles; g.best = r; }
    byDest.set(r.destination, g);
  }
  const origins = new Set(rows.map((r) => r.origin));
  const L = window.L;
  exMap = L.map('ex-map', { worldCopyJump: true, scrollWheelZoom: false });
  L.tileLayer(`https://{s}.basemaps.cartocdn.com/${isDark() ? 'dark_all' : 'rastertiles/voyager'}/{z}/{x}/{y}{r}.png`, {
    maxZoom: 12, subdomains: 'abcd',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(exMap);
  const pts = [];
  const mins = [...byDest.values()].map((g) => g.min).sort((a, b) => a - b);
  const tier = (m) => (mins.length < 2 ? 0 : Math.min(3, Math.floor((mins.indexOf(m) / (mins.length - 1)) * 4)));
  for (const code of origins) {
    const a = AP.byCode.get(code);
    if (a?.lat == null) continue;
    L.circleMarker([a.lat, a.lon], { radius: 4, color: '#6b5d50', weight: 1, fillOpacity: 0.6 }).bindTooltip(`${code} 出發`).addTo(exMap);
  }
  for (const g of byDest.values()) {
    const a = AP.byCode.get(g.code);
    if (a?.lat == null) continue;
    pts.push([a.lat, a.lon]);
    const icon = L.divIcon({ className: `map-pin t${tier(g.min)}`, html: `<span>${Math.round(g.min / 1000)}</span>`, iconSize: [34, 34] });
    const m = L.marker([a.lat, a.lon], { icon, title: `${g.code} ${airportCity(g.code)}` }).addTo(exMap);
    m.bindPopup(`<b>${esc(g.code)} ${esc(airportCity(g.code))}</b><br>最低 <b>${fmt(g.min)}</b> 哩・${g.n} 筆<br>${mmdd(g.best.date)} ${esc(g.best.origin)} 出發・${esc(g.best.airlines)}
      <div class="map-actions"><button type="button" data-map-dest="${esc(g.code)}">只看這裡</button><button type="button" data-map-trip="${esc(g.best.id)}" data-title="${esc(titleOf(g.best))}">看最便宜航班</button></div>`);
  }
  if (pts.length) exMap.fitBounds(pts, { padding: [30, 30], maxZoom: 6 });
  else exMap.setView([25, 121], 3);
}
document.addEventListener('click', (e) => {
  const dest = e.target.closest?.('[data-map-dest]');
  if (dest) {
    ex.f.destination = new Set([dest.dataset.mapDest]);
    $$('#ex-filters [data-mp="destination"] .mp-opt input').forEach((i) => (i.checked = i.value === dest.dataset.mapDest));
    ex.view = 'table';
    ex.shown = PAGE;
    renderExplore();
    return;
  }
  const trip = e.target.closest?.('[data-map-trip]');
  if (trip) openTrips(trip.dataset.mapTrip, trip.dataset.title, ex.cabin);
});

// ---------- trip planner (this browser; shareable by link) ----------
const PLAN_KEY = 'plan:v1';
const MAX_LEGS = 12;
// Strictly validate anything that comes from storage or a shared link before rendering it.
function cleanLeg(x) {
  if (!x || typeof x !== 'object') return null;
  const str = (v, re, max) => (typeof v === 'string' && v.length <= max && re.test(v) ? v : null);
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e9 ? v : null);
  const leg = {
    k: x.k === 'c' ? 'c' : x.k === 'a' ? 'a' : null,
    date: str(x.date, /^\d{4}-\d{2}-\d{2}$/, 10),
    from: str(x.from, /^[A-Z]{3}$/, 3),
    to: str(x.to, /^[A-Z]{3}$/, 3),
    flights: str(x.flights ?? '', /^[A-Z0-9 ,/·-]*$/, 60) ?? '',
    cabin: str(x.cabin, /^[YWJF]$/, 1) || 'Y',
    pax: Math.min(9, Math.max(1, Math.floor(num(x.pax) || 1))),
    miles: num(x.miles),
    program: str(x.program ?? '', /^[a-z_]{0,30}$/, 30) || '',
    tax: x.tax && num(x.tax.amount) != null && str(x.tax.cur ?? '', /^[A-Z]{0,3}$/, 3) != null ? { amount: x.tax.amount, cur: x.tax.cur || '' } : null,
    price: num(x.price),
    note: typeof x.note === 'string' ? x.note.slice(0, 30) : '',
  };
  return leg.k && leg.date && leg.from && leg.to ? leg : null;
}
function cleanPlan(p) {
  const legs = Array.isArray(p?.legs) ? p.legs.map(cleanLeg).filter(Boolean).slice(0, MAX_LEGS) : [];
  return { name: typeof p?.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 40) : '我的行程', legs };
}
let plan = { name: '我的行程', legs: [] };
let sharedPlan = null;
function savePlan() { store.set(PLAN_KEY, plan); renderPlan(); }
function addLegs(legs) {
  const clean = legs.map(cleanLeg).filter(Boolean);
  if (plan.legs.length + clean.length > MAX_LEGS) { toast(`行程最多 ${MAX_LEGS} 段`); return; }
  plan.legs.push(...clean);
  plan.legs.sort((a, b) => a.date.localeCompare(b.date));
  savePlan();
  toast('已加入「我的行程」（在航線查詢頁下方）');
}
function awardLeg(t, pax) {
  const cabin = { economy: 'Y', premium: 'W', business: 'J', first: 'F' }[t.cabin] || 'J';
  return { k: 'a', date: (t.departsAt || '').slice(0, 10), from: t.segments[0]?.from, to: t.segments.at(-1)?.to, flights: String(t.flightNumbers || '').toUpperCase().replace(/[^A-Z0-9 ,/·-]/g, '').slice(0, 60), cabin, pax: pax || 1, miles: t.miles, program: t.source, tax: t.taxes != null ? { amount: t.taxes / 100, cur: (t.taxesCurrency || '').toUpperCase().slice(0, 3) } : null };
}
function cashLegs() {
  const r = cash.req;
  const { out, back } = cash.chosen;
  const fl = (o) => o.segments.map((s) => (s.flightNumber || '').toUpperCase()).join(' / ').replace(/[^A-Z0-9 ,/·-]/g, '').slice(0, 60);
  const total = (back || out).price;
  const legs = [{ k: 'c', date: r.depart, from: out.segments[0].from.code, to: out.segments.at(-1).to.code, flights: fl(out), cabin: r.cabin, pax: r.adults, price: total, note: back ? '來回總價' : '' }];
  if (back) legs.push({ k: 'c', date: r.ret, from: back.segments[0].from.code, to: back.segments.at(-1).to.code, flights: fl(back), cabin: r.cabin, pax: r.adults, price: null, note: '含在去程票價' });
  return legs;
}

function planHtml(p, editable) {
  if (!p.legs.length) return '<p class="hint">還沒有航段。在航班明細按「＋ 加入我的行程」，或在買機票選好航班後加入。可以把里程票和現金票混搭，例如去程用哩程、回程買票。</p>';
  const milesBy = {};
  const taxBy = {};
  let cashTotal = 0;
  for (const l of p.legs) {
    if (l.k === 'a' && l.miles) milesBy[l.program] = (milesBy[l.program] || 0) + l.miles * l.pax;
    if (l.k === 'a' && l.tax) taxBy[l.tax.cur || '?'] = (taxBy[l.tax.cur || '?'] || 0) + l.tax.amount * l.pax;
    if (l.k === 'c' && l.price) cashTotal += l.price;
  }
  const rows = p.legs.map((l, i) => `<tr>
    <td>${mmdd(l.date)}（${dowOf(l.date)}）</td><td><b>${esc(l.from)} → ${esc(l.to)}</b><small>${esc(l.flights)}</small></td><td>${CABIN_LABEL[l.cabin]}${l.pax > 1 ? `・${l.pax} 人` : ''}</td>
    <td>${l.k === 'a' ? `<b>${fmt(l.miles * l.pax)} 哩</b><small>${esc(programName(l.program))}${l.tax ? `・稅 ${esc(l.tax.cur)} ${fmt(Math.round(l.tax.amount * l.pax))}` : ''}</small>` : l.price ? `<b>NT$${fmt(l.price)}</b><small>現金票${l.note ? `・${esc(l.note)}` : ''}</small>` : `<small>現金票・${esc(l.note)}</small>`}</td>
    ${editable ? `<td><button type="button" class="linklike" data-leg-rm="${i}" aria-label="移除這段">✕</button></td>` : ''}</tr>`).join('');
  const sum = [
    ...Object.entries(milesBy).map(([k, v]) => `${esc(programName(k))} <b>${fmt(v)} 哩</b>`),
    ...Object.entries(taxBy).map(([c, v]) => `稅金 ${esc(c === '?' ? '' : c)} <b>${fmt(Math.round(v))}</b>`),
    cashTotal ? `現金票 <b>NT$${fmt(cashTotal)}</b>` : '',
  ].filter(Boolean).join('　');
  return `<div class="table-wrap"><table class="plan-table"><tbody>${rows}</tbody></table></div><p class="plan-sum">合計：${sum}</p>`;
}
function renderPlan() {
  const body = $('#plan-body');
  if (!body) return;
  $('#plan-count').textContent = plan.legs.length ? `（${plan.legs.length} 段）` : '';
  body.innerHTML = `${sharedPlan ? `<div class="plan-shared"><b>朋友分享的行程：${esc(sharedPlan.name)}</b>${planHtml(sharedPlan, false)}
      <div class="plan-actions"><button type="button" class="primary small" id="plan-import">存成我的行程</button><button type="button" class="outline" id="plan-dismiss">不用了</button></div></div>` : ''}
    <label class="field plan-name">行程名稱<input id="plan-name" maxlength="40" value="${esc(plan.name)}"></label>
    ${planHtml(plan, true)}
    ${plan.legs.length ? '<div class="plan-actions"><button type="button" class="outline" id="plan-share">🔗 複製行程連結</button><button type="button" class="outline" id="plan-clear">清空</button></div>' : ''}`;
  $('#plan-name').addEventListener('change', (e) => { plan.name = e.target.value.trim().slice(0, 40) || '我的行程'; store.set(PLAN_KEY, plan); });
  $$('[data-leg-rm]', body).forEach((b) => b.addEventListener('click', () => { plan.legs.splice(Number(b.dataset.legRm), 1); savePlan(); }));
  $('#plan-clear')?.addEventListener('click', () => { if (confirm('清空我的行程？')) { plan.legs = []; savePlan(); } });
  $('#plan-share')?.addEventListener('click', async () => {
    const json = JSON.stringify(plan);
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const url = `${location.origin}/?plan=${b64}#search`;
    try { await navigator.clipboard.writeText(url); toast('已複製行程連結'); } catch { prompt('複製這個連結：', url); }
  });
  $('#plan-import')?.addEventListener('click', () => { plan = sharedPlan; sharedPlan = null; savePlan(); toast('已存成我的行程'); });
  $('#plan-dismiss')?.addEventListener('click', () => { sharedPlan = null; renderPlan(); });
}
function readSharedPlan() {
  const raw = new URLSearchParams(location.search).get('plan');
  if (!raw || raw.length > 6000) return;
  try {
    const bin = atob(raw.replace(/-/g, '+').replace(/_/g, '/'));
    const p = cleanPlan(JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))));
    if (p.legs.length) sharedPlan = p;
  } catch { /* ignore a broken link */ }
  history.replaceState(null, '', `${location.pathname}${location.hash}`);
}

// ---------- premium product filter ----------
const productList = () => data.products?.products || [];
function productMatches(prod, fleet) {
  return (fleet || []).some((x) => {
    const [carrier, ac] = x.split(':');
    return carrier === prod.airline && prod.iata.includes(ac);
  });
}
function productOfSegment(seg) {
  const carrier = (seg.flight || '').slice(0, 2).toUpperCase();
  const ac = String(seg.aircraftCode || '').toUpperCase();
  return productList().filter((p) => p.airline === carrier && p.iata.includes(ac));
}

// ---------- wiring ----------
// ---------- good-value marks: cash fares this browser already looked up, no extra quota ----------
// One-way, one-person prices in TWD keyed by route, date and cabin; kept a few days because fares move.
const CASH_SEEN_KEY = 'cashSeen:v1';
const CASH_SEEN_DAYS = 3;
const GOOD_VALUE = 0.6; // NT$ per mile; same line the cash comparison box already uses for 划算
function loadCashSeen() {
  const raw = store.get(CASH_SEEN_KEY, {});
  const cutoff = Date.now() - CASH_SEEN_DAYS * 864e5;
  const today = isoDate(0);
  return Object.fromEntries(Object.entries(raw && typeof raw === 'object' ? raw : {})
    .filter(([k, v]) => /^[A-Z]{3}-[A-Z]{3}\|\d{4}-\d{2}-\d{2}\|[YWJF]$/.test(k) && v && v.price > 0 && v.at > cutoff && k.split('|')[1] >= today));
}
let cashSeen = {};
function rememberCash(from, to, date, cabin, price) {
  if (!from || !to || !date || !CABIN_LABEL[cabin] || !(price > 0)) return;
  const k = `${from}-${to}|${date}|${cabin}`;
  if (cashSeen[k] && cashSeen[k].price <= price && Date.now() - cashSeen[k].at < 864e5) return;
  cashSeen[k] = { price: Math.round(price), at: Date.now() };
  store.set(CASH_SEEN_KEY, cashSeen);
  if (!fxCache) api('/api/fx').then((f) => { fxCache = f; }).catch(() => {});
}
// Remember every one-way fare of a cash search, per actual airport pair, per person.
function rememberCashSearch(r, options) {
  if (r.ret) return;
  for (const o of options) {
    if (!o.price || !o.segments?.length) continue;
    rememberCash(o.segments[0].from.code, o.segments.at(-1).to.code, r.depart, r.cabin, o.price / (r.adults || 1));
  }
}
// What one mile is worth on this award row, when the same day's cash fare is known.
function mileValueOf(r, cabin) {
  const x = r.cabins?.[cabin];
  const seen = cashSeen[`${r.origin}-${r.destination}|${r.date}|${cabin}`];
  if (!x?.miles || !seen) return null;
  const rate = x.taxes?.currency ? fxCache?.rates?.[x.taxes.currency.toUpperCase()] : null;
  const tax = x.taxes && rate ? x.taxes.amount * rate : 0;
  const per = (seen.price - tax) / x.miles;
  return { per, cash: seen.price, good: per >= GOOD_VALUE, taxKnown: !x.taxes || Boolean(rate) };
}
const valueTag = (r, cabin) => {
  const v = mileValueOf(r, cabin);
  if (!v) return '';
  return `<div class="meta value-tag ${v.good ? 'good' : ''}" title="同一天現金票 NT$${fmt(v.cash)}${v.taxKnown ? '' : '，稅金未換算'}">每哩約值 NT$${Math.max(0, v.per).toFixed(2)}${v.good ? '・<b>好價</b>' : ''}</div>`;
};
const valueMark = (r, cabin) => {
  const v = mileValueOf(r, cabin);
  return v?.good ? `<i class="gv" title="每哩約值 NT$${v.per.toFixed(2)}（同一天現金票 NT$${fmt(v.cash)}）">好價</i>` : '';
};

// ---------- cash price tracking (server-side, checked every morning) ----------
const watchCfg = { on: false };
const watchSummary = (w) => `${w.origin} → ${w.destination}　${mmdd(w.depart)}${w.ret ? ` – ${mmdd(w.ret)} 來回` : ' 單程'}　${CABIN_LABEL[w.cabin]}${w.adults > 1 ? `　${w.adults} 人` : ''}`;
function watchFormHtml() {
  return `<form class="watch-form" id="watch-form">
    <p class="hint">比現在便宜就寄信通知你。為了省查價額度，出發前 60 天以上每週查 1 次、15 到 60 天每 3 天、最後 14 天才每天查；所有追蹤每月合計最多用 30 次，帳號剩不到 150 次時自動暫停。開始追蹤不會另外用額度。</p>
    <div class="w-add"><input type="email" name="email" placeholder="通知信箱（可留空，只在網站顯示）" autocomplete="email" value="${esc(store.get(ALERT_EMAIL_KEY, ''))}">
    <button type="submit" class="primary">開始追蹤</button><button type="button" class="outline" id="watch-cancel">取消</button></div>
  </form>`;
}
function bindWatchButton(box) {
  const btn = $('#cash-watch', box);
  if (!btn) return;
  btn.addEventListener('click', () => {
    const host = $('#watch-slot', box);
    host.innerHTML = watchFormHtml();
    const f = $('#watch-form', host);
    $('#watch-cancel', f).addEventListener('click', () => { host.innerHTML = ''; });
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const r = cash.req;
      const sub = $('button[type=submit]', f);
      sub.disabled = true;
      try {
        const email = f.email.value.trim();
        store.set(ALERT_EMAIL_KEY, email);
        const body = await cashApi('/api/watch', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ origin: r.origin, destination: r.destination, depart: r.depart, ret: r.ret, cabin: r.cabin, adults: r.adults, stops: r.stops, flights: cash.chosen.out.segments.map((x) => (x.flightNumber || '').replace(/\s/g, '')).join('+'), email,
            // The fare on screen becomes the starting price, so starting a watch costs no lookup. For a round trip that is the
            // outbound list's "from" price, which is what each later check measures too.
            price: cash.chosen.out.price || null, lowest: Math.min(...cash.options.map((o) => o.price).filter(Boolean), 1e9) }) });
        host.innerHTML = `<p class="status">📉 已開始追蹤，目前 ${money(body.watch.lastPrice)}。${email ? '降價會寄信到你的信箱' : '降價時會顯示在「降價追蹤」'}。</p>`;
        loadWatches();
      } catch (err) {
        toast(err.message);
        sub.disabled = false;
      }
    });
  });
}
async function loadWatches() {
  const panel = $('#watch-panel');
  const box = $('#watch-body');
  if (!panel || !box) return;
  panel.hidden = !watchCfg.on;
  if (!watchCfg.on || !panel.open) return;
  box.innerHTML = '<p class="hint">載入中…</p>';
  try {
    const body = await cashApi('/api/watch');
    const list = body.watches || [];
    $('#watch-count').textContent = list.length ? `（${list.length}）` : '';
    box.innerHTML = list.length ? `<ul class="alert-list">${list.map((w) => {
      const diff = w.lastPrice && w.startPrice ? w.lastPrice - w.startPrice : 0;
      return `<li>
        <div><b>${esc(watchSummary(w))}</b>${w.email ? `<small>→ ${esc(w.email)}</small>` : '<small>只在網站顯示</small>'}</div>
        <div class="hint">${w.flights ? `追蹤 ${esc(w.flights.replace(/\+/g, '、'))}` : '追蹤最便宜票價'}・${w.everyDays === 1 ? '每天' : `每 ${w.everyDays} 天`}查一次${w.paused ? `・<b class="warn">${w.paused === 'cap' ? '本月追蹤額度用完，下個月繼續' : 'SerpApi 額度快用完，暫停中'}</b>` : ''}：現在 <b>${money(w.lastPrice)}</b>${diff ? `（比開始時${diff < 0 ? `<b class="new">便宜 NT$${fmt(-diff)}</b>` : `貴 NT$${fmt(diff)}`}）` : ''}${w.lastLowest && w.lastLowest < (w.lastPrice || Infinity) ? `；同天最低 ${money(w.lastLowest)}` : ''}${w.pickedGone ? '；原航班已查不到，改看最低價' : ''}　${w.lastRun ? `${ago(w.lastRun)}檢查` : ''}${w.lastError ? `　⚠ ${esc(w.lastError)}` : ''}</div>
        <div class="alert-actions">${sparkline((w.history || []).map(([d, p]) => [d, p]))}<button type="button" class="outline" data-wdel="${esc(w.id)}">停止追蹤</button></div>
      </li>`;
    }).join('')}</ul><p class="hint">本月追蹤已用 ${body.used || 0} / ${body.cap} 次查價額度。</p>` : '<p class="hint">還沒有追蹤。在買機票選好航班後，按「📉 追蹤降價」。</p>';
    $$('[data-wdel]', box).forEach((b) => b.addEventListener('click', async () => {
      try { await cashApi(`/api/watch?id=${encodeURIComponent(b.dataset.wdel)}`, { method: 'DELETE' }); toast('已停止追蹤'); loadWatches(); } catch (err) { toast(err.message); }
    }));
  } catch (err) {
    box.innerHTML = `<p class="status error">${esc(err.message)}</p>`;
  }
}

function initFeatures() {
  wallet = loadWallet();
  cashSeen = loadCashSeen();
  if (Object.keys(cashSeen).length && !fxCache) api('/api/fx').then((f) => { fxCache = f; }).catch(() => {});
  $('#watch-panel')?.addEventListener('toggle', loadWatches);
  plan = cleanPlan(store.get(PLAN_KEY, null));
  readSharedPlan();
  renderPlan();
  if (sharedPlan) { $('#plan-panel').open = true; }
  loadDeals();
}
