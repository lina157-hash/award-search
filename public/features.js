// Extra tools added on top of app.js (loaded after it and sharing its globals):
// how to book, my points wallet, award release dates, miles-needed estimate, phantom-space warnings,
// daily deals, explore map, trip planner and the premium-product filter.

// ---------- programs: names and which Taiwan bank points transfer in ----------
const EXTRA_PROGRAM_NAMES = { eva: '長榮 無限萬哩遊', ci: '華航 華夏哩程', jal: '日航 JMB', ana: '全日空 ANA', starlux: '星宇 COSMILE', iberia: '西班牙國家航空 Iberia Club' };
const programName = (key) => SOURCE_NAMES[key] || EXTRA_PROGRAM_NAMES[key] || key;
// Program key (seats.aero source, or eva/ci/jal) → the matching rate in data/points.json calc.sources.
const PROGRAM_TRANSFER = {
  asiamiles: { to: 'asiamiles' }, singapore: { to: 'sq' }, eva: { to: 'eva' }, ci: { to: 'ci' },
  aeroplan: { name: '加航' }, flyingblue: { name: '法荷航' }, united: { name: '聯合' }, qatar: { name: '卡達' },
  british: { name: '英航' }, turkish: { name: '土航' }, qantas: { name: '澳航' }, emirates: { name: '阿聯酋' },
  etihad: { name: '阿提哈德' }, lifemiles: { name: 'LifeMiles' }, jal: { name: '日航' },
};
// 日航寰宇一家 (jal_partner, a chart in charts.json) is paid with JAL miles.
const PROGRAM_KEY = { asiamiles_est: 'asiamiles', jal_partner: 'jal' };
const programKeyOf = (source) => PROGRAM_KEY[source] || source;

// Best rate from each bank points program into one airline program.
function transferRates(program) {
  const m = PROGRAM_TRANSFER[programKeyOf(program)];
  if (!m || !data.points?.calc) return [];
  const out = [];
  for (const s of data.points.calc.sources) {
    // A rate past its validUntil is no longer guaranteed (points6.js): left out until the data is refreshed.
    const rates = s.rates.filter((r) => (m.to ? r.to === m.to : r.to === 'other' && r.name === m.name) && !(typeof calcRateExpired === 'function' && calcRateExpired(s, r)));
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
// A fixed or capped bonus (bonusPct 0) the calculator can't apply: its cap from `cap` ({miles, per}) or the conditions text.
function promoCap(p) {
  if (p.cap?.miles) return { miles: p.cap.miles, per: p.cap.per || '' };
  const m = /每(月|次|人|戶)[^；。]*?上限\s*([\d,]+)\s*[里哩]/.exec(p.conditions || '');
  return m ? { miles: Number(m[2].replace(/,/g, '')), per: m[1] } : null;
}
const capText = (cap) => `${cap.per ? `每${cap.per}` : ''}最多加贈 ${fmt(cap.miles)} 哩`;
// The capped offer from this bank into one calculator column, shown as a note beside the (unchanged) result.
function cappedPromo(source, col) {
  return activePromos().find((p) => p.type === 'transfer' && !p.bonusPct && !p.rebate && promoCap(p) && promoCol(p) === col
    && (p.bank ? p.bank === source.bank : !(p.excludeBanks || []).includes(source.bank))) || null;
}
function promosHtml() {
  const list = activePromos();
  if (!data.promos) return '';
  const updated = data.promos.updated ? `資料更新於 ${data.promos.updated}` : '';
  if (!list.length) return `<p class="hint promos-none">🎁 目前沒有整理到進行中的轉點加贈或買哩優惠。${updated}</p>`;
  const row = (p) => `<li><b>${esc(p.title)}</b>${p.bonusPct ? ` <span class="pill">+${p.bonusPct}%</span>` : promoCap(p) ? ` <span class="pill">${capText(promoCap(p))}</span>` : ''}${p.price ? ` <span class="pill">${esc(p.price)}</span>` : ''}
    <small>${mmdd(p.start)} – ${p.end.slice(0, 4) !== isoDate(0).slice(0, 4) ? `${p.end.slice(0, 4)}/` : ''}${mmdd(p.end)}${p.conditions ? `・${esc(p.conditions)}` : ''}　${CONFIDENCE_TAG[p.confidence] || ''}${(p.sources || []).slice(0, 1).map((x) => `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.label)} ↗</a>`).join('')}</small>${typeof promoRowExtraHtml === 'function' ? promoRowExtraHtml(p) : ''}</li>`;
  const transfer = list.filter((p) => p.type === 'transfer');
  const buy = list.filter((p) => p.type === 'buy');
  const award = list.filter((p) => p.type === 'award');
  return `<details class="promos"><summary>🎁 進行中的優惠 ${list.length} 項 <small>${updated}</small></summary>
    ${transfer.length ? `<h3 class="sub">轉點加贈</h3><ul>${transfer.map(row).join('')}</ul>` : ''}
    ${buy.length ? `<h3 class="sub">買哩促銷</h3><ul>${buy.map(row).join('')}</ul>` : ''}
    ${award.length ? `<h3 class="sub">哩程票特惠</h3><ul>${award.map(awardSaleLi).join('')}</ul>` : ''}
    <p class="hint">送哩程的加贈已算進下方表格（標示「含加贈」）；有上限的加贈（例如每月最多 500 哩）不算進表格，只在格子裡提醒；回饋銀行點數的只列在這裡。活動多半要先登錄、有名額限制，條件以銀行或航空公司公告為準。</p>${typeof promoWatchHtml === 'function' ? promoWatchHtml() : ''}</details>`;
}

// ---------- award sales (promos.json type award, 哩程票特惠) ----------
// A route end matches an airport code, or a 2-letter country code through the airport list.
const saleEnd = (tok, code) => tok === code || (tok.length === 2 && typeof AP === 'object' && AP.byCode.get(code)?.country === tok);
const saleAny = (v, code) => [].concat(v || []).some((t) => saleEnd(t, code));
function saleRouteHit(rt, o, d, cabin) {
  if (rt.cabins && cabin && !rt.cabins.includes(cabin)) return false;
  if (rt.between) return (saleAny(rt.between, o) && saleAny(rt.and, d)) || (saleAny(rt.and, o) && saleAny(rt.between, d));
  return saleAny(rt.from, o) && saleAny(rt.to, d);
}
// The award sale open for booking today that covers one award: program, route, cabin (Y/W/J/F), travel date and, when
// known, the operating airlines (the sales exclude codeshares and partners).
function awardSaleFor({ source, origin, destination, date, cabin, airlines }) {
  const key = programKeyOf(source);
  const codes = String(airlines || '').split(/[,\s]+/).filter(Boolean);
  return activePromos().find((p) => p.type === 'award' && p.program === key && (!date || (p.travelFrom <= date && date <= p.travelTo))
    && (!p.carriers?.length || !codes.length || codes.every((c) => p.carriers.includes(c)))
    && (p.routes || []).some((rt) => saleRouteHit(rt, origin, destination, cabin))) || null;
}
// A sale routed by country (TR) needs the airport list to know which country IST is in; the results wait for it (app.js).
const awardSaleNeedsAirports = (rows) => activePromos().some((p) => p.type === 'award' && rows.some((r) => programKeyOf(r.source) === p.program)
  && (p.routes || []).some((rt) => [rt.from, rt.to, rt.between, rt.and].flat().some((t) => typeof t === 'string' && t.length === 2)));
const saleWindow = (p) => `${mmdd(p.travelFrom)}–${mmdd(p.travelTo)} 搭乘、${mmdd(p.end)} 前開票`;
const saleSrc = (p) => (p.sources || []).slice(0, 1).map((x) => ` <a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.label)} ↗</a>`).join('');
const saleTag = (p) => `<span class="tag sale" title="${esc(`${p.title}：${saleWindow(p)}`)}">🏷 哩程票特惠 −${p.discountPct}%</span>`;
// 點數換算 › 🎁 進行中的優惠.
const awardSaleLi = (p) => `<li><b>${esc(p.title)}</b> <span class="pill">−${p.discountPct}%</span>
  <small>${saleWindow(p)}${p.routeNote ? `・${esc(p.routeNote)}` : ''}${p.conditions ? `・${esc(p.conditions)}` : ''}　${CONFIDENCE_TAG[p.confidence] || ''}${saleSrc(p)}</small></li>`;
// A best-deal card in the results (app.js) and a 今日好康 card.
const miniSaleTag = (d) => { const p = awardSaleFor({ source: d.source, origin: d.origin, destination: d.destination, date: d.date, cabin: dealsState.cabin }); return p ? saleTag(p) : ''; };
const awardSaleTag = (r, c) => { const p = awardSaleFor({ source: r.source, origin: r.origin, destination: r.destination, date: r.date, cabin: c, airlines: r.cabins?.[c]?.airlines }); return p ? saleTag(p) : ''; };
// 🎁 on a result card: a bank transfer bonus into the card's program running today (rebates paid in bank points are
// not miles, so left out); each bank's terms in the title, the full list in 點數換算器 › 🎁.
function transferPromosFor(source) {
  const key = programKeyOf(source);
  const col = PROGRAM_TRANSFER[key]?.to || key;
  return activePromos().filter((p) => p.type === 'transfer' && !p.rebate && promoCol(p) === col);
}
const promoBonusText = (p) => (p.bonusPer ? `每 ${fmt(p.bonusPer[0])} 哩加贈 ${fmt(p.bonusPer[1])} 哩` : p.bonusPct > 0 ? `加贈 ${p.bonusPct}%` : p.title);
const promoBankText = (p) => p.bank || `各銀行${p.excludeBanks?.length ? `（${p.excludeBanks.join('、')}除外）` : ''}`;
function transferBonusTag(r) {
  const list = transferPromosFor(r.source);
  if (!list.length) return '';
  const best = Math.max(0, ...list.map((p) => p.bonusPct || 0));
  const why = list.map((p) => `${promoBankText(p)}：${promoBonusText(p)}（到 ${mmdd(p.end)}）`).join('\n');
  return `<span class="tag xfer-bonus" title="${esc(`轉點進${programName(programKeyOf(r.source))}有加贈\n${why}`)}">🎁 轉點加贈${best ? ` ${best}%` : ''}</span>`;
}
// Above the results: each sale the shown seats fall in, once.
function awardSaleNoticeHtml(rows, c) {
  const hits = new Map();
  for (const r of rows) {
    const p = r.cabins?.[c]?.available && awardSaleFor({ source: r.source, origin: r.origin, destination: r.destination, date: r.date, cabin: c, airlines: r.cabins[c].airlines });
    if (p) hits.set(p.id, { p, n: (hits.get(p.id)?.n || 0) + 1 });
  }
  if (!hits.size) return '';
  return `<div class="sale-note">${[...hits.values()].map(({ p, n }) => `<p>🏷 <b>${esc(p.title)}</b><small>結果裡有 ${n} 筆符合・${saleWindow(p)}${saleSrc(p)}</small></p>`).join('')}
    <p class="hint">特價要在官網開票時才會套用。我推測 seats.aero 顯示的哩數還是原價，實際以官網為準。</p></div>`;
}
// 航班明細: the sale one flight falls in.
function awardSaleTripHtml(t) {
  const segs = t.segments || [];
  const cabin = Object.keys(CABIN_API).find((k) => CABIN_API[k] === t.cabin);
  const p = segs.length && awardSaleFor({ source: t.source, origin: segs[0].from, destination: segs.at(-1).to, date: String(segs[0].departsAt || '').slice(0, 10), cabin, airlines: t.carriers });
  return p ? `<p class="sale-trip">🏷 <b>${esc(p.title)}</b>：這班符合，官網開票約少 ${p.discountPct}%<small>${saleWindow(p)}${p.conditions ? `・${esc(p.conditions)}` : ''}${saleSrc(p)}</small></p>` : '';
}

// ---------- my points wallet (this browser only) ----------
const WALLET_KEY = 'wallet:v1';
const WALLET_PROGRAMS = ['eva', 'ci', 'asiamiles', 'singapore', 'jal', 'aeroplan', 'united', 'flyingblue', 'alaska', 'american', 'british', 'qatar', 'finnair', 'iberia', 'turkish', 'lifemiles', 'etihad', 'emirates', 'delta', 'starlux'];
const cleanCount = (v) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? Math.min(n, 1e9) : 0; };
function loadWallet() {
  const w = store.get(WALLET_KEY, {});
  const pick = (o) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).map(([k, v]) => [k, cleanCount(v)]).filter(([k, v]) => /^[\w-]{1,40}$/.test(k) && v));
  const miles = pick(w.miles);
  // Expiry (or last activity) dates of miles balances, see ewallet.js.
  const expiry = Object.fromEntries(Object.entries(w.expiry && typeof w.expiry === 'object' ? w.expiry : {}).filter(([k, v]) => miles[k] && /^\d{4}-\d{2}-\d{2}$/.test(v)));
  return { banks: pick(w.banks), miles, hotels: pick(w.hotels), expiry };
}
let wallet = { banks: {}, miles: {}, hotels: {}, expiry: {} };
const walletEmpty = () => !Object.keys(wallet.banks).length && !Object.keys(wallet.miles).length && !Object.keys(wallet.hotels).length;
const hotelPrograms = () => data.points?.calc?.hotels?.programs || {};
// Bank programs that only transfer to hotels (e.g. 滙豐卓越理財) are listed after the airline ones.
const walletSources = () => [...(data.points?.calc?.sources || []), ...(data.points?.calc?.hotels?.extraSources || [])];

// A bank → hotel rate in the shape calcConvert expects (its `miles` are hotel points).
const hotelRate = (r) => ({ points: r.points, miles: r.hotelPoints, minPoints: r.minPoints || 0, stepPoints: r.stepPoints || 0, stepMiles: r.stepMiles || 0 });

// Hotel points reachable in one hotel program: own balance plus each bank balance transferred in.
function reachHotel(key) {
  const own = wallet.hotels[key] || 0;
  const banks = [];
  for (const r of data.points?.calc?.hotels?.rates || []) {
    const pts = r.to === key && wallet.banks[r.source] && !(typeof calcRateExpired === 'function' && calcRateExpired(null, r));
    const source = pts && walletSources().find((x) => x.id === r.source);
    if (!source) continue;
    const got = calcConvert(hotelRate(r), pts, 'p2m').value || 0;
    if (got) banks.push({ source, points: pts, miles: got });
  }
  return { own, banks, total: own + banks.reduce((n, b) => n + b.miles, 0) };
}

// ---------- Avios: one currency moved 1:1 between British Airways, Qatar, Finnair, Iberia and Aer Lingus ----------
// data/points.json calc.avios: the programs and the official pairs that link directly (Qatar only with BA).
const aviosData = () => data.points?.calc?.avios || null;
const isAvios = (k) => Boolean(aviosData()?.programs?.[programKeyOf(k)]);
const aviosName = (k) => aviosData()?.programs?.[k] || programName(k);
const aviosShort = (k) => aviosName(k).replace(/\s*Avios$/, '');
// Shortest chain of linked programs, e.g. aviosPath('qatar', 'finnair') → ['qatar', 'british', 'finnair'].
function aviosPath(from, to) {
  const av = aviosData();
  if (!av || from === to || !av.programs[from] || !av.programs[to]) return null;
  const prev = { [from]: null };
  const queue = [from];
  while (queue.length) {
    const k = queue.shift();
    for (const l of av.links) {
      const next = l.a === k ? l.b : l.b === k ? l.a : null;
      if (!next || next in prev) continue;
      prev[next] = k;
      if (next === to) { const path = [to]; for (let x = k; x; x = prev[x]) path.unshift(x); return path; }
      queue.push(next);
    }
  }
  return null;
}
// The official link between two neighbours on a chain (its rule and source).
const aviosLink = (a, b) => aviosData()?.links.find((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a)) || null;
// 「國泰世華 → 英航 Avios → 卡達 Avios」
const aviosChainText = (path, start = '') => [...(start ? [start] : []), ...path.map(aviosName)].join(' → ');
// 「需先把 Avios 轉到卡達（1:1，官網）」, linked to the official page of the last step.
function aviosNeedHtml(path) {
  const to = path.at(-1);
  const src = aviosLink(path.at(-2), to)?.source;
  return `需先把 Avios 轉到${esc(aviosShort(to))}（1:1，${src ? `<a href="${esc(src.url)}" target="_blank" rel="noopener">官網</a>` : '官網'}）`;
}
// Every way bank points reach one program: its own rates, plus rates into the other Avios programs (path = the moves after).
function ratesInto(key) {
  const out = transferRates(key).map((x) => ({ ...x, path: null }));
  for (const sib of Object.keys(aviosData()?.programs || {})) {
    const path = isAvios(key) && sib !== key ? aviosPath(sib, key) : null;
    if (path) out.push(...transferRates(sib).map((x) => ({ ...x, path })));
  }
  return out;
}
const rateMiles = (x, pts) => withBonus(calcConvert(x.rate, pts, 'p2m').value || 0, x.rate.to !== 'other' ? transferBonus(x.source, x.rate.to) : null);

// Miles one person could gather in one program: own balance, each bank balance moved in (its best route, Avios moves
// included), and their Avios held in the other Avios programs. `person` is { miles, banks } (the wallet, or a family
// member in points6.js); { avios: false } leaves the Avios moves out.
function reachFor(person, program, { avios = true } = {}) {
  const key = programKeyOf(program);
  const own = person.miles?.[key] || 0;
  const best = new Map();
  for (const x of avios ? ratesInto(key) : transferRates(key).map((r) => ({ ...r, path: null }))) {
    const pts = person.banks?.[x.source.id];
    if (!pts) continue;
    const got = rateMiles(x, pts);
    const cur = best.get(x.source.id);
    if (got && (!cur || got > cur.miles || (got === cur.miles && !x.path))) best.set(x.source.id, { source: x.source, rate: x.rate, points: pts, miles: got, path: x.path });
  }
  const banks = [...best.values()];
  const moved = [];
  if (avios && isAvios(key)) {
    for (const sib of Object.keys(aviosData().programs)) {
      const n = sib !== key && person.miles?.[sib];
      const path = n ? aviosPath(sib, key) : null;
      if (path) moved.push({ program: sib, miles: n, path });
    }
  }
  return { own, banks, moved, total: own + banks.reduce((n, b) => n + b.miles, 0) + moved.reduce((n, m) => n + m.miles, 0) };
}
// Miles reachable in one program from 我的點數.
function reach(program, opts) { return reachFor(wallet, program, opts); }
// What a reach counts only through Avios moves (each with its chain), for 「需先把 Avios 轉到卡達」.
const aviosMoves = (r) => [...r.banks.filter((b) => b.path), ...(r.moved || [])];
// 只看我換得起的: the programs whose seats count as affordable only after moving Avios (BA Avios into Qatar…).
function aviosAffordHtml() {
  if (walletEmpty() || !aviosData()) return '';
  const c = state.cabin;
  const pax = Math.max(1, state.pax || 1);
  const need = new Map();
  for (const r of visibleRows()) {
    const key = programKeyOf(r.source);
    if (need.has(key) || !isAvios(key) || reach(key, { avios: false }).total >= r.cabins[c].miles * pax) continue;
    const moves = aviosMoves(reach(key));
    if (moves.length) need.set(key, moves[0].path);
  }
  return need.size ? `<p class="hint avios-afford">✈ ${[...need].map(([k, path]) => `${esc(programName(k))}：${aviosNeedHtml(path)}`).join('；')}</p>` : '';
}
// 航班明細 › 怎麼湊到這些哩 for an Avios program: which Avios move in, by which chain, and each official condition.
function aviosEarnHtml(key, head = '<h4>Avios 互轉</h4>') {
  const av = aviosData();
  const others = Object.keys(av.programs).filter((k) => k !== key).map((k) => ({ k, path: aviosPath(k, key) })).filter((x) => x.path);
  if (!others.length) return '';
  const direct = others.filter((x) => x.path.length === 2).map((x) => aviosShort(x.k));
  const via = others.filter((x) => x.path.length > 2);
  const lead = key === 'british' ? `${direct.join('、')}的 Avios 都能 1:1 轉過來` : '你可以用英航 Avios 轉過來（1:1）';
  const links = av.links.filter((l) => l.a === key || l.b === key);
  return `${head}<p class="earn-avios">✈ ${esc(lead)}${key !== 'british' && direct.length > 1 ? `；${esc(direct.filter((n) => n !== '英航').join('、'))}的 Avios 也可以` : ''}。${via.length ? `${esc(via.map((x) => aviosShort(x.k)).join('、'))}的 Avios 要先轉到${esc(aviosShort(via[0].path[1]))}再轉過來。` : ''}只能轉進自己的帳戶。</p>
    <ul class="earn-avios-rules">${links.map((l) => { const o = l.a === key ? l.b : l.a; return `<li><b>${esc(aviosShort(o))} ↔ ${esc(aviosShort(key))}</b><small>${esc(l.rule)}。<a href="${esc(l.source.url)}" target="_blank" rel="noopener">${esc(l.source.label)} ↗</a></small></li>`; }).join('')}</ul>`;
}

// ---------- booking channels, release windows, phantom space (data/booking.json) ----------
const bookingInfo = (program) => data.booking?.programs?.[programKeyOf(program)] || null;

function phantomWarnings(program, airlines) {
  const info = bookingInfo(program);
  if (!info?.phantom?.length) return [];
  const codes = String(airlines || '').split(/[,\s]+/).filter(Boolean);
  return info.phantom.filter((p) => p.airlines.includes('*') || p.airlines.some((a) => codes.includes(a)));
}

function howToBookHtml(program) {
  const key = programKeyOf(program);
  if (!key) return '';
  const info = bookingInfo(key);
  const lines = [];
  if (info?.booking) {
    const b = info.booking;
    const where = b.partnerOnline === true ? '官網可線上訂，夥伴航班也可以' : b.partnerOnline === 'partial' ? '官網可線上訂，部分夥伴航班要打電話' : b.ownOnline ? '自家航班可線上訂，夥伴航班要打電話' : '需要打電話訂';
    lines.push(`<li><b>訂位方式</b>　${where}${b.phoneFee ? `；${esc(phoneFeeText(b.phoneFee))}` : ''}${b.note ? `。${esc(b.note)}` : ''}</li>`);
  }
  if (info?.days) lines.push(`<li><b>開票</b>　${esc(info.windowNote || `約 ${info.days} 天前開放`)}</li>`);
  if (lines.length && typeof cardPerkLine === 'function') lines.push(cardPerkLine()); // trips.js
  const src = info?.sources?.[0];
  if (!lines.length) return '';
  return `<details class="howto"><summary>怎麼用 ${esc(programName(key))} 訂</summary><ul>${lines.join('')}</ul>${src ? `<p class="hint">資料來源：<a href="${esc(src.url)}" target="_blank" rel="noopener">${esc(src.label)} ↗</a>${info.confidence === 'secondary' ? '（第三方整理）' : ''}</p>` : ''}</details>`;
}
// The data writes the phone fee as a bare value ("無（2020 年起取消電話訂位費）"); give it a subject so it reads as a sentence.
const phoneFeeText = (fee) => (/^無/.test(fee) ? `電話訂位不收手續費${fee.replace(/^無/, '').replace(/電話訂位費/, '')}` : fee);

const phantomHtml = (program, airlines) => phantomWarnings(program, airlines).map((p) => `<p class="phantom">⚠️ ${esc(p.warning)}</p>`).join('');

// ---------- how to gather the miles for one award (flight details dialog) ----------
// Co-brand cards name their program in Chinese (data/points.json cobrand); match on the program's short name.
const COBRAND_MATCH = { eva: '長榮', ci: '華航', asiamiles: '亞洲萬里通', starlux: '星宇', ana: '全日空', jal: '日航' };
// Cards that stopped earning (`ended`) stay in the 規則庫 table but are not suggested.
const cobrandFor = (key) => (COBRAND_MATCH[key] ? (data.points?.cobrand || []).filter((c) => !c.ended && c.program.includes(COBRAND_MATCH[key])) : []);
// Running offers for one program: transfer bonuses (by calculator column) and buy-miles sales.
// Award sales are left out: they cover set routes, so 航班明細 matches them by route instead (awardSaleTripHtml).
const promosFor = (key) => { const col = PROGRAM_TRANSFER[key]?.to || key; return activePromos().filter((p) => p.type !== 'award' && (p.program === key || promoCol(p) === col)); };
// Hotels whose points move on to this airline program (the 繞路兌換 tool).
const detourHotels = (key) => Object.keys(toAir()?.hotels || {}).filter((h) => hotelPartner(h, key));
const verifyTag = (s) => (s.confidence === 'verify' ? '<span class="tag verify" title="比率還沒有在銀行官方資料核實">待確認</span>' : '');

// One line per offer: the bonus (or its cap when the calculator can't apply it), the end date and the source.
function promoLine(p) {
  const cap = promoCap(p);
  const pill = p.type === 'award' ? `−${p.discountPct}%` : p.bonusPct && !p.rebate ? `+${p.bonusPct}%` : p.rebate ? `回饋 ${p.bonusPct}% 點數` : cap ? capText(cap) : '';
  const src = (p.sources || [])[0];
  return `<li>${pill ? `<span class="pill">${esc(pill)}</span> ` : ''}${esc(p.title)}<small>到 ${mmdd(p.end)}${p.conditions ? `・${esc(p.conditions)}` : ''}${src ? ` <a href="${esc(src.url)}" target="_blank" rel="noopener">${esc(src.label)} ↗</a>` : ''}</small></li>`;
}

// The airline's own program for each operating carrier, linked to its card in 規則庫.
function homeProgramHtml(carriers) {
  const codes = [...new Set(String(carriers || '').split(/[,\s]+/).filter(Boolean))];
  const parts = codes.map((c) => data.airlines?.airlines.find((a) => a.code === c)).filter((a) => a?.homeProgram).map((a) => {
    const prog = data.programs?.programs.find((p) => p.id === a.homeProgram);
    const name = prog ? prog.name.replace(/[（(].*$/, '').trim() : programName(a.homeProgram);
    return `${esc(airlineZh(a.code))}自家的計畫：${prog ? `<a href="#rules" data-prog-card="${esc(prog.id)}">${esc(name)}</a>` : esc(name)}`;
  });
  return parts.length ? `<p class="hint home-prog">✈ ${parts.join('；')}</p>` : '';
}

// 「怎麼湊到這些哩」: which Taiwan bank points transfer in and how many it takes, running offers, the user's own
// points, co-brand cards and the hotel detour. Folded by default with a one-line summary.
function earnHtml(program, miles) {
  const key = programKeyOf(program);
  if (!key || !(miles > 0)) return '';
  const mine = (x) => (wallet.banks[x.source.id] ? 1 : 0);
  // Each bank once, by its cheapest way in: its own rate, or a sister Avios program's rate and a 1:1 move.
  const byBank = new Map();
  for (const x of ratesInto(key)) {
    const need = calcConvert(x.rate, miles, 'm2p');
    const cur = byBank.get(x.source.id);
    if (!cur || need.value < cur.need.value || (need.value === cur.need.value && !x.path)) byBank.set(x.source.id, { ...x, need });
  }
  const rates = [...byBank.values()].sort((a, b) => mine(b) - mine(a) || a.need.value - b.need.value);
  const banks = new Set(rates.map((x) => x.source.bank));
  const cheapest = rates.reduce((a, b) => (!a || b.need.value < a.need.value ? b : a), null);
  const promos = promosFor(key);
  const cob = cobrandFor(key);
  const hotels = detourHotels(key);
  const r = walletEmpty() ? null : reach(key);
  const goal = (n) => (n >= miles ? '<span class="ok-text">夠換</span>' : `還差 ${fmt(miles - n)} 哩`);

  let sum;
  if (r?.total) {
    const only = r.banks.length === 1 && !r.own ? r.banks[0] : null;
    sum = `${only ? `你的${esc(only.source.bank)}點數` : '你的點數'}可換約 ${fmt(r.total)} 哩，${goal(r.total)}${aviosMoves(r).length ? '・需先轉 Avios' : ''}`;
  } else if (cheapest) sum = `${esc(cheapest.source.bank)} 約 ${fmt(cheapest.need.value)} 點可換${cheapest.path ? `（經${esc(aviosShort(cheapest.path[0]))} Avios）` : ''}・${banks.size} 家銀行可轉`;
  else if (cob.length) sum = `卡點不能直接轉，${cob.length} 張聯名卡可直接累積`;
  else if (hotels.length) sum = '卡點不能直接轉，可經飯店點數繞路';
  else sum = '台灣的卡點不能轉入這個計畫';
  if (promos.some((p) => p.type === 'transfer' && !p.rebate)) sum += '・🎁 有轉點加贈';

  const parts = [];
  if (r) {
    const lines = [];
    if (r.own) lines.push(`<li>你有 ${esc(programName(key))} <b>${fmt(r.own)} 哩</b></li>`);
    for (const b of r.banks) lines.push(`<li>你的${esc(b.source.bank)}點數 ${fmt(b.points)} 點可換約 <b>${fmt(b.miles)} 哩</b>${r.banks.length === 1 && !r.own && !r.moved.length ? `，${goal(b.miles)}` : ''}${b.path ? `<small>${esc(aviosChainText(b.path, b.source.bank))}・${aviosNeedHtml(b.path)}</small>` : ''}</li>`);
    for (const m of r.moved) lines.push(`<li>你的${esc(aviosName(m.program))} <b>${fmt(m.miles)}</b> 可以轉過來<small>${esc(aviosChainText(m.path))}・${aviosNeedHtml(m.path)}</small></li>`);
    if (lines.length > 1) lines.push(`<li>合計約 <b>${fmt(r.total)} 哩</b>，${goal(r.total)}</li>`);
    parts.push(lines.length ? `<ul class="earn-mine">${lines.join('')}</ul>` : '<p class="hint">你在「我的點數」填的點數都不能轉進這個計畫。</p>');
    if (r.total < miles) parts.push(buyMilesHtml(key, miles - r.total));
  }
  if (rates.length) {
    const li = (x) => {
      const bonus = x.rate.to !== 'other' ? transferBonus(x.source, x.rate.to) : null;
      const unit = x.rate.minPoints || x.rate.stepPoints ? `<small>${x.rate.minPoints ? `最低 ${fmt(x.rate.minPoints)} 點` : ''}${x.rate.minPoints && x.rate.stepPoints ? '，' : ''}${x.rate.stepPoints ? `每 ${fmt(x.rate.stepPoints)} 點一單位` : ''}${x.need.note ? `・${esc(x.need.note)}` : ''}</small>` : '';
      return `<li><span><b>${esc(x.source.bank)}</b> <small class="inline">${esc(x.source.program)}${x.source.variant ? `（${esc(x.source.variant)}）` : ''}</small>${mine(x) ? ' <span class="tag ok">你有</span>' : ''}${verifyTag(x.source)}</span>
        <span class="earn-need">${ratioLabel(x.rate)}・需 <b>${fmt(x.need.value)} 點</b>${bonus ? ' <span class="pill">🎁 有加贈</span>' : ''}</span>${unit}${x.path ? `<small>${esc(aviosChainText(x.path, x.source.bank))}（先轉${esc(aviosName(x.path[0]))}，再 1:1 轉過來）</small>` : ''}</li>`;
    };
    parts.push(`<h4>銀行點數轉入 <small>換 ${fmt(miles)} 哩要多少點</small></h4><ul class="earn-rates">${rates.slice(0, 3).map(li).join('')}</ul>
      ${rates.length > 3 ? `<details class="howto-more"><summary>其他 ${rates.length - 3} 家</summary><ul class="earn-rates">${rates.slice(3).map(li).join('')}</ul></details>` : ''}`);
  } else parts.push('<p class="hint">台灣的信用卡點數目前沒有直接轉入這個計畫。</p>');
  if (isAvios(key)) parts.push(aviosEarnHtml(key));
  if (promos.length) parts.push(`<h4>進行中的優惠</h4><ul class="earn-promos">${promos.map(promoLine).join('')}</ul>`);
  if (cob.length) parts.push(`<h4>直接累積的聯名卡</h4><ul class="earn-cob">${cob.map((c) => `<li><b>${esc(c.bank)}</b> ${esc(c.card)}<small>${esc(c.earn)}</small></li>`).join('')}</ul>`);
  if (hotels.length) {
    const names = hotels.map((h) => data.points.calc.hotels.programs[h] || h);
    const rd = r ? reachDetour(key) : null;
    parts.push(`<h4>繞路：先轉飯店點數</h4><p class="earn-detour">${esc(names.slice(0, 3).join('、'))}${names.length > 3 ? ` 等 ${names.length} 家` : ''}的點數可以轉進來，比率通常比直接轉差、也要多等幾天。${rd ? `你的點數經 ${esc(data.points.calc.hotels.programs[rd.hotel])} 繞路最多約 <b>${fmt(rd.miles)} 哩</b>。` : ''}
      <button type="button" class="linklike" data-earn-detour="${esc(key)}" data-miles="${miles}">試算繞路 →</button></p>`);
  }
  parts.push(`<p class="hint">點數換算用的是「點數換算器」的同一份比率（最低點數、轉換單位都算進去，加贈另計）。${walletEmpty() ? '<button type="button" class="linklike" data-earn-wallet>填我的點數</button>，就能看自己的點數夠不夠。' : ''}</p>`);
  return `<details class="earn"><summary><span class="earn-title">怎麼湊到這些哩</span><small class="earn-sum">${sum}</small></summary>
    <div class="earn-body"><p class="earn-goal">要換：${esc(programName(key))}　<b>${fmt(miles)} 哩</b></p>${parts.join('')}</div></details>`;
}

// Jump from the dialog to one program card in 規則庫 (clearing a filter that would hide it).
function openProgramCard(id) {
  $$('dialog[open]').forEach((d) => d.close());
  rulesState.alliance = '';
  rulesState.q = '';
  const first = !tabDone.has('rules');
  showTab('rules');
  if (!first) renderRules();
  const el = document.getElementById(`prog-${id}`);
  if (!el) return;
  // Folded on phones: open the card and its section first.
  for (let d = el; d; d = d.parentElement?.closest('details')) d.open = true;
  window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 76 });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1600);
}
// 試算繞路: 點數換算器 › 繞路兌換 with this program and the miles filled in.
function openDetourFor(key, miles) {
  $$('dialog[open]').forEach((d) => d.close());
  Object.assign(detour, { air: key, mode: 'm2p', amount: miles });
  setPointsView('detour');
  const first = !tabDone.has('points');
  showTab('points');
  if (!first) renderPoints();
  window.scrollTo({ top: 0 });
}
document.addEventListener('click', (e) => {
  const prog = e.target.closest?.('[data-prog-card]');
  if (prog) { e.preventDefault(); openProgramCard(prog.dataset.progCard); return; }
  const dt = e.target.closest?.('[data-earn-detour]');
  if (dt) { openDetourFor(dt.dataset.earnDetour, Number(dt.dataset.miles) || 0); return; }
  if (e.target.closest?.('[data-earn-wallet]')) { $$('dialog[open]').forEach((d) => d.close()); openWallet(); }
});

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
    `DESCRIPTION:${text(`${programName(program)} 約今天開放 ${flightDate} 的獎勵位，可以到機票搜索雷達查詢。`)}`,
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
// The tool shown is part of the address (#points/wallet), so a reload or a link opens the same one.
const POINTS_VIEWS = ['calc', 'wallet', 'detour', 'need', 'upgrade'];
const pointsView = { view: POINTS_VIEWS.includes(tabSub.points) ? tabSub.points : 'calc' };
function pointsTabsHtml() {
  const v = pointsView.view;
  return `<fieldset class="seg points-seg" aria-label="工具">${[['calc', '點數換算'], ['wallet', '我的點數'], ['detour', '繞路兌換'], ['need', '哩程試算'], ['upgrade', '升等試算']].map(([k, l]) =>
    `<label><input type="radio" name="points-view" value="${k}" ${k === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}</fieldset>`;
}
function setPointsView(v) {
  pointsView.view = v;
  if (v === 'calc') delete tabSub.points; else tabSub.points = v;
}
function bindPointsTabs(host) {
  $$('input[name=points-view]', host).forEach((i) => i.addEventListener('change', () => { setPointsView(i.value); showTab('points'); renderPoints(); }));
}
// 「去填點數」 from the results: straight to 點數換算器 › 我的點數, with a way back once something is filled in.
let walletReturn = false;
function openWallet() {
  walletReturn = currentTab === 'search' && state.results.length > 0;
  setPointsView('wallet');
  const first = !tabDone.has('points');
  showTab('points');
  if (!first) renderPoints();
  window.scrollTo({ top: 0 });
  $('#w-pick')?.focus();
}

// Back to the search results with 只看我換得起的 switched on, scrolled to the filter.
function walletBackHtml() {
  return walletReturn && !walletEmpty() ? '<button type="button" class="primary wallet-back" data-wallet-back>← 回到搜尋結果（只看換得起的）</button>' : '';
}
document.addEventListener('click', (e) => {
  if (!e.target.closest?.('[data-wallet-back]')) return;
  walletReturn = false;
  state.affordOnly = true;
  showTab('search');
  renderSearch();
  $('#search-results .result-tools')?.scrollIntoView({ block: 'start' });
});

// Only what the user entered is listed; everything else is picked from one dropdown, so the page stays short.
const walletItemName = (kind, id) => {
  if (kind === 'm') return { name: programName(id), sub: '' };
  if (kind === 'h') return hotelPrograms()[id] ? { name: hotelPrograms()[id], sub: '飯店點數' } : null;
  const s = walletSources().find((x) => x.id === id);
  return s ? { name: s.bank, sub: `${s.program}${s.variant ? `（${s.variant}）` : ''}` } : null;
};
function walletHtml() {
  const sources = walletSources();
  const hotels = Object.entries(hotelPrograms());
  return `<div class="wallet">
    <p class="hint">填入你手上的點數與哩程，${typeof signedIn === 'function' && signedIn() ? '存在這台裝置，並同步到你的帳號' : '存在這台裝置；登入後會同步'}。填好後，搜尋結果可以開「只看我換得起的」，航班明細也會告訴你夠不夠換。</p>
    <div id="wallet-list"></div>
    <div class="w-add">
      <select id="w-pick" aria-label="選擇點數或哩程"><option value="">選擇信用卡點數、航空哩程或飯店點數</option>
        <optgroup label="信用卡點數">${sources.map((x) => `<option value="b:${esc(x.id)}">${esc(bankLabel(x))}</option>`).join('')}</optgroup>
        <optgroup label="航空哩程">${WALLET_PROGRAMS.map((k) => `<option value="m:${esc(k)}">${esc(programName(k))}</option>`).join('')}</optgroup>
        ${hotels.length ? `<optgroup label="飯店點數">${hotels.map(([k, n]) => `<option value="h:${esc(k)}">${esc(n)}</option>`).join('')}</optgroup>` : ''}
      </select>
      <input type="number" id="w-amt" min="0" step="100" inputmode="numeric" placeholder="數量" aria-label="數量">
      <button type="button" class="primary" id="w-add-btn">加入</button>
    </div>
    <div id="wallet-expiry"></div>
    <div id="wallet-goal"></div>
    <div id="wallet-back"></div>
    <div id="wallet-sum-wrap"><h3 class="sub">合計可換到：航空哩程</h3><div id="wallet-sum"></div>
      <div id="wallet-hotel-wrap" hidden><h3 class="sub">合計可換到：飯店點數</h3><div id="wallet-hotel-sum"></div></div>
      <div id="wallet-detour-wrap" hidden><h3 class="sub">經飯店繞路可換到的航空</h3><div id="wallet-detour-sum"></div></div></div>
  </div>`;
}
function renderWalletSum() {
  const host = $('#wallet-sum');
  if (!host) return;
  const back = $('#wallet-back');
  if (back) back.innerHTML = walletBackHtml();
  const keys = [...new Set([...WALLET_PROGRAMS, ...Object.keys(PROGRAM_TRANSFER)])];
  const rows = keys.map((k) => ({ k, r: reach(k) })).filter(({ r }) => r.total > 0).sort((a, b) => b.r.total - a.r.total);
  host.innerHTML = rows.length ? `<div class="table-wrap"><table class="wallet-sum"><thead><tr><th>計畫</th><th>最多可湊到</th><th>來源</th></tr></thead><tbody>
    ${rows.map(({ k, r }) => `<tr><td><b>${esc(programName(k))}</b>${aviosMoves(r).length ? `<small class="avios-need">${aviosNeedHtml(aviosMoves(r)[0].path)}</small>` : ''}</td><td><b>${fmt(r.total)} 哩</b></td><td><small>${[r.own ? `自有 ${fmt(r.own)}` : '',
      ...r.banks.map((b) => `${esc(b.source.bank)} ${fmt(b.points)} 點 → ${fmt(b.miles)}${b.path ? `（${esc(b.path.slice(0, -1).map(aviosName).join(' → '))} → ${esc(aviosShort(k))}）` : ''}`),
      ...r.moved.map((m) => `${esc(aviosName(m.program))} ${fmt(m.miles)}（${m.path.length > 2 ? `經${esc(m.path.slice(1, -1).map(aviosShort).join('、'))} ` : ''}1:1 轉過來）`)].filter(Boolean).join('、')}</small></td></tr>`).join('')}
    </tbody></table></div><p class="hint">每一列各自計算：同一筆點數只能轉進一個計畫，不能同時用在兩列。${rows.some(({ r }) => aviosMoves(r).length) ? '英航、卡達、芬航等計畫的 Avios 可以 1:1 互轉，所以同一筆 Avios 會出現在好幾列，一樣只能用一次。' : ''}</p>`
    : `<p class="hint">${walletEmpty() ? '加入點數後，這裡會算出每個航空計畫最多能湊到多少哩。' : '你填的點數都不能轉進航空計畫。'}</p>`;
  renderWalletHotelSum();
  renderWalletDetourSum();
  renderWalletExtras();
}
// Airlines where pooling everything into one hotel first beats transferring directly (or is the only way in).
function renderWalletDetourSum() {
  const host = $('#wallet-detour-sum');
  if (!host || !toAir()) return;
  const names = data.points.calc.hotels.programs;
  const rows = detourAirlines().map((k) => ({ k, d: reachDetour(k), direct: ratesInto(k).length ? reach(k).total : 0 }))
    // Airlines the site can search come first, so ANA or Alaska is not buried under obscure programs.
    .filter(({ d, direct }) => d && d.miles > direct).sort((a, b) => searchable(b.k) - searchable(a.k) || b.d.miles - a.d.miles);
  host.parentElement.hidden = !rows.length;
  if (!rows.length) { host.innerHTML = ''; return; }
  const row = ({ k, d, direct }) => `<tr><td><b>${esc(airName(k))}</b></td><td><b>${fmt(d.miles)} 哩</b>${d.bonus ? `<small>含加贈 ${fmt(d.bonus)} 哩</small>` : ''}</td>
    <td><small>全部轉進${esc(names[d.hotel])}（${fmt(d.pool.total)} 點），${hotelRatioLabel(d.partner)}</small></td><td><small>${direct ? `直接轉最多 ${fmt(direct)} 哩` : '不能直接轉'}</small></td></tr>`;
  const head = '<thead><tr><th>航空</th><th>最多可湊到</th><th>路線</th><th>對照</th></tr></thead>';
  host.innerHTML = `<div class="table-wrap"><table class="wallet-sum">${head}<tbody>${rows.slice(0, 6).map(row).join('')}</tbody></table></div>
    ${rows.length > 6 ? `<details class="howto-more"><summary>其他 ${rows.length - 6} 家航空</summary><div class="table-wrap"><table class="wallet-sum">${head}<tbody>${rows.slice(6).map(row).join('')}</tbody></table></div></details>` : ''}
    <p class="hint">只列出繞路比直接轉多、或只能繞路的航空。各家銀行的點數先合併轉進同一家飯店再轉航空；比率較差、要等比較久，詳細比較請看「繞路兌換」。</p>`;
}
function renderWalletHotelSum() {
  const host = $('#wallet-hotel-sum');
  if (!host) return;
  const rows = Object.keys(hotelPrograms()).map((k) => ({ k, r: reachHotel(k) })).filter(({ r }) => r.total > 0).sort((a, b) => b.r.total - a.r.total);
  host.parentElement.hidden = !rows.length;
  host.innerHTML = rows.length ? `<div class="table-wrap"><table class="wallet-sum"><thead><tr><th>飯店</th><th>最多可湊到</th><th>來源</th></tr></thead><tbody>
    ${rows.map(({ k, r }) => `<tr><td><b>${esc(hotelPrograms()[k])}</b></td><td><b>${fmt(r.total)} 點</b></td><td><small>${[r.own ? `自有 ${fmt(r.own)}` : '', ...r.banks.map((b) => `${esc(b.source.bank)} ${fmt(b.points)} 點 → ${fmt(b.miles)}`)].filter(Boolean).join('、')}</small></td></tr>`).join('')}
    </tbody></table></div><p class="hint">一樣每一列各自計算，同一筆點數只能轉一次。各家飯店一點的價值差很多，點數多不代表比較划算，可以到「點數換算」把「換成」改為「🏨 飯店點數」看說明。</p>` : '';
}
function renderWalletList() {
  const host = $('#wallet-list');
  if (!host) return;
  const items = [...Object.entries(wallet.banks).map(([id, n]) => ['b', id, n]), ...Object.entries(wallet.miles).map(([id, n]) => ['m', id, n]), ...Object.entries(wallet.hotels).map(([id, n]) => ['h', id, n])]
    .map(([kind, id, n]) => ({ kind, id, n, label: walletItemName(kind, id) })).filter((x) => x.label);
  host.innerHTML = items.length ? `${items.map(({ kind, id, n, label }) => `<div class="w-row"><span><b>${esc(label.name)}</b>${label.sub ? `<small>${esc(label.sub)}</small>` : ''}</span>
      <input type="number" min="0" step="100" inputmode="numeric" data-w="${kind}:${esc(id)}" value="${n}" aria-label="${esc(label.name)} 數量">
      ${kind === 'm' ? expiryInputHtml(id) : ''}<button type="button" class="w-del" data-w-del="${kind}:${esc(id)}" aria-label="移除 ${esc(label.name)}">×</button></div>`).join('')}
    <button type="button" class="outline" id="wallet-clear">清除全部</button>`
    : '<p class="w-empty">還沒有加入任何點數，從下面選一個開始。</p>';
}
function setWallet(ref, value) {
  const [kind, id] = ref.split(':');
  const bucket = kind === 'b' ? wallet.banks : kind === 'h' ? wallet.hotels : wallet.miles;
  const n = cleanCount(value);
  if (n) bucket[id] = n; else delete bucket[id];
  if (kind === 'm' && !n && wallet.expiry) delete wallet.expiry[id];
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
  // On the freshly drawn wallet, not on #points-page (which stays): binding there piled up a listener per redraw.
  const box = $('.wallet', host);
  box.addEventListener('input', (e) => { if (e.target.dataset.w) { setWallet(e.target.dataset.w, e.target.value); renderWalletSum(); } });
  box.addEventListener('click', (e) => {
    const del = e.target.closest('[data-w-del]');
    if (del) { setWallet(del.dataset.wDel, 0); refresh(); return; }
    if (e.target.id === 'wallet-clear') {
      if (!confirm('清除所有填入的點數與哩程？')) return;
      wallet = { banks: {}, miles: {}, hotels: {}, expiry: {} };
      store.del(WALLET_KEY);
      refresh();
    }
  });
  bindWalletExtras(host);
  refresh();
}

// ---------- detour: bank points → hotel program → airline ----------
// Some airlines take no Taiwanese bank points directly, but most hotel programs transfer on to dozens of airlines.
const toAir = () => data.points?.calc?.hotels?.toAir || null;
const airName = (k) => SOURCE_NAMES[k] || EXTRA_PROGRAM_NAMES[k] || toAir()?.airlines?.[k] || k;
// The hotel's partner for one airline. For an Avios program, a sister program the hotel sends more to wins, followed by
// 1:1 moves (Accor → Iberia 1:1 beats Accor → Qatar 4:3): then `via` is that program and `path` the chain.
function hotelPartner(hotel, air) {
  const list = toAir()?.hotels?.[hotel]?.partners || [];
  let best = list.find((p) => p.to === air) || null;
  if (!isAvios(air)) return best;
  for (const p of list) {
    const path = p.to !== air && isAvios(p.to) ? aviosPath(p.to, air) : null;
    if (path && (!best || p.miles / p.hotelPoints > best.miles / best.hotelPoints)) best = { ...p, to: air, via: p.to, path };
  }
  return best;
}
const hotelRatioLabel = (p) => `${fmt(p.hotelPoints)} 點 = ${fmt(p.miles)} 哩${p.via ? `（轉${aviosName(p.via)}，再轉過來）` : ''}`;

// Hotel points → miles: the minimum, the transfer unit, and Marriott's bonus for each 60,000 points sent.
function hotelToAir(hotel, partner, points) {
  const h = toAir().hotels[hotel];
  const min = partner.minPoints || h.minPoints || 0;
  if (points < min) return { short: `飯店點數最低 ${fmt(min)} 點` };
  const step = partner.step || h.increment || 1;
  const usable = Math.floor(points / step) * step;
  const bonus = partner.bonus && h.bonus ? Math.floor(usable / h.bonus.every) * (partner.bonusMiles || h.bonus.miles) : 0;
  const miles = Math.floor((usable * partner.miles) / partner.hotelPoints) + bonus;
  return miles > 0 ? { value: miles, bonus } : { short: '不足 1 哩' };
}

// Every bank → hotel → airline route for one bank points program, best first.
function detourRoutes(air, sourceId, amount) {
  const out = [];
  for (const r of data.points?.calc?.hotels?.rates || []) {
    const partner = r.source === sourceId && hotelPartner(r.to, air);
    if (!partner) continue;
    const hp = calcConvert(hotelRate(r), amount, 'p2m');
    const m = hp.value ? hotelToAir(r.to, partner, hp.value) : hp;
    out.push({ hotel: r.to, rate: r, partner, hotelPoints: hp.value || 0, miles: m.value || 0, bonus: m.bonus || 0, short: m.short || '' });
  }
  return out.sort((a, b) => b.miles - a.miles);
}
// Direct transfer from the same bank program (or through a sister Avios program), for comparison (null when none).
function directRoute(air, sourceId, amount) {
  let best = null;
  for (const x of ratesInto(air)) {
    if (x.source.id !== sourceId) continue;
    const miles = rateMiles(x, amount);
    if (!best || miles > best.miles || (miles === best.miles && !x.path)) best = { miles, path: x.path, source: x.source };
  }
  return best;
}
const directMiles = (air, sourceId, amount) => directRoute(air, sourceId, amount)?.miles || 0;
// 繞路兌換's 直接轉 column: 「直接轉」, or 「經英航 Avios」 with the chain under it (國泰世華 → 英航 Avios → 卡達 Avios).
const directLabel = (d) => (d.path ? `經${esc(aviosShort(d.path[0]))} Avios` : '直接轉');
const directChain = (d) => (d.path ? `<small>${esc(aviosChainText(d.path, d.source.bank))}・${aviosNeedHtml(d.path)}</small>` : '');
// Smallest amount whose result reaches `target` (results only grow with the amount).
function pointsFor(target, fn) {
  let lo = 1, hi = 1e8;
  if (fn(hi) < target) return null;
  while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (fn(mid) >= target) hi = mid; else lo = mid + 1; }
  return lo;
}

// From the wallet: pool every bank balance (plus own hotel points) into one hotel, then send it on to the airline.
function reachDetour(air) {
  let best = null;
  for (const hotel of Object.keys(toAir()?.hotels || {})) {
    const partner = hotelPartner(hotel, air);
    if (!partner) continue;
    const pool = reachHotel(hotel);
    const m = pool.total ? hotelToAir(hotel, partner, pool.total) : {};
    if (m.value && (!best || m.value > best.miles)) best = { hotel, partner, pool, miles: m.value, bonus: m.bonus };
  }
  return best;
}
const searchable = (k) => (SOURCE_NAMES[k] || EXTRA_PROGRAM_NAMES[k] ? 1 : 0);
const detourAirlines = () => Object.keys(toAir()?.airlines || {}).filter((k) => Object.keys(toAir().hotels).some((h) => hotelPartner(h, k)));

const detour = { air: '', mode: 'p2m', amount: 60000 };
const DETOUR_PICKS = ['ana', 'alaska', 'american', 'korean', 'iberia', 'delta'];
function detourHtml() {
  const t = toAir();
  if (!t) return '<p class="hint">飯店轉航空的資料載入失敗，請重新整理。</p>';
  const all = detourAirlines().sort((a, b) => airName(a).localeCompare(airName(b), 'zh-Hant'));
  const direct = (k) => transferRates(k).length > 0;
  const opt = (k) => `<option value="${esc(k)}" ${detour.air === k ? 'selected' : ''}>${esc(airName(k))}</option>`;
  return `<div class="detour">
    <p class="hint">信用卡點數轉不到你要的航空時，可以先轉進飯店集團，再從飯店轉到航空。萬豪可以轉到 30 多家航空，而且每轉 6 萬點另送 5,000 哩。繞路的比率通常比直接轉差，也要多等幾天到幾週，適合補上直接轉不到的航空。</p>
    <div class="calc-bar">
      <label class="field">想換的航空<select id="dt-air"><option value="">選擇航空</option>
        <optgroup label="台灣的卡不能直接轉">${all.filter((k) => !direct(k)).map(opt).join('')}</optgroup>
        <optgroup label="台灣的卡也能直接轉（可以比較）">${all.filter(direct).map(opt).join('')}</optgroup></select></label>
      <label class="field">我想算<select id="dt-mode">${[['p2m', '手上的點數能換多少哩'], ['m2p', '想要的哩程需要多少點'], ['mine', '用「我的點數」計算']].map(([v, l]) => `<option value="${v}" ${detour.mode === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="field"><span id="dt-amount-label">點數</span><input type="number" id="dt-amount" min="0" step="1000" inputmode="numeric" value="${detour.amount}"></label>
    </div>
    <div class="presets"><span class="presets-label">常見</span>${DETOUR_PICKS.filter((k) => all.includes(k)).map((k) => `<button type="button" data-dt-air="${esc(k)}">${esc(airName(k))}</button>`).join('')}</div>
    <div id="dt-out"></div>
  </div>`;
}
function renderDetour() {
  const host = $('#dt-out');
  if (!host) return;
  const { air, mode } = detour;
  const label = $('#dt-amount-label');
  if (label) label.textContent = mode === 'm2p' ? '想換到的哩程' : mode === 'mine' ? '點數（改用「我的點數」）' : '點數（假設每家都有這麼多）';
  const amt = $('#dt-amount');
  if (amt) amt.disabled = mode === 'mine';
  if (!air) { host.innerHTML = '<p class="hint">選一家航空，這裡會列出每家銀行經哪家飯店轉過去最划算。</p>'; return; }
  const sources = walletSources().filter((src) => (mode !== 'mine' || wallet.banks[src.id]) && (data.points.calc.hotels.rates || []).some((r) => r.source === src.id));
  if (mode === 'mine' && !sources.length) { host.innerHTML = '<p class="hint">還沒有填可以轉飯店的銀行點數。請先到「我的點數」加入。</p>' + detourRefHtml(air); return; }
  const amount = detour.amount;
  if (!(amount > 0) && mode !== 'mine') { host.innerHTML = `<p class="hint">請輸入${mode === 'm2p' ? '哩程' : '點數'}。</p>` + detourRefHtml(air); return; }
  const rows = [];
  for (const src of sources) {
    const pts = mode === 'mine' ? wallet.banks[src.id] : amount;
    if (mode === 'm2p') {
      const routes = (data.points.calc.hotels.rates || []).filter((r) => r.source === src.id && hotelPartner(r.to, air)).map((r) => {
        const partner = hotelPartner(r.to, air);
        const need = pointsFor(amount, (x) => { const hp = calcConvert(hotelRate(r), x, 'p2m').value || 0; return hp ? hotelToAir(r.to, partner, hp).value || 0 : 0; });
        return need && { hotel: r.to, partner, need, hotelPoints: calcConvert(hotelRate(r), need, 'p2m').value };
      }).filter(Boolean).sort((a, b) => a.need - b.need);
      if (!routes.length) continue;
      const dRoute = directRoute(air, src.id, amount * 10);
      const dNeed = dRoute ? pointsFor(amount, (x) => directMiles(air, src.id, x)) : null;
      rows.push({ src, sort: routes[0].need, html: `<td><b>${esc(src.bank)}</b><small>${esc(src.program)}${src.variant ? `（${esc(src.variant)}）` : ''}</small></td>
        <td>經 <b>${esc(data.points.calc.hotels.programs[routes[0].hotel])}</b>（${fmt(routes[0].hotelPoints)} 點）${routes[0].partner.via ? `→ ${esc(aviosName(routes[0].partner.via))}` : ''}${routes.length > 1 ? `<small>${routes.slice(1).map((x) => `經${esc(data.points.calc.hotels.programs[x.hotel])}：要 ${fmt(x.need)} 點`).join('、')}</small>` : ''}</td>
        <td><b>${fmt(routes[0].need)} 點</b></td><td>${dNeed ? `${directLabel(dRoute)}要 ${fmt(dNeed)} 點${dNeed <= routes[0].need ? ` <span class="ok-text">${dRoute.path ? '這樣' : '直接轉'}比較省</span>` : ''}${directChain(dRoute)}` : '<small>不能直接轉</small>'}</td>` });
      continue;
    }
    const routes = detourRoutes(air, src.id, pts);
    if (!routes.length) continue;
    const best = routes[0];
    const dRoute = directRoute(air, src.id, pts);
    const direct = dRoute?.miles || 0;
    const hotelName = (k) => esc(data.points.calc.hotels.programs[k]);
    rows.push({ src, sort: best.miles, html: `<td><b>${esc(src.bank)}</b><small>${esc(src.program)}${src.variant ? `（${esc(src.variant)}）` : ''}${mode === 'mine' ? `・${fmt(pts)} 點` : ''}</small></td>
      <td>${best.miles ? `經 <b>${hotelName(best.hotel)}</b>（${fmt(best.hotelPoints)} 點）${best.partner.via ? `→ ${esc(aviosName(best.partner.via))}` : ''}${best.bonus ? ` <span class="pill">含加贈 ${fmt(best.bonus)} 哩</span>` : ''}` : `<small>${esc(best.short)}</small>`}
        ${routes.length > 1 ? `<small>${routes.slice(1).map((x) => `經${hotelName(x.hotel)}：${x.miles ? `${fmt(x.miles)} 哩` : esc(x.short)}`).join('、')}</small>` : ''}</td>
      <td>${best.miles ? `<b>${fmt(best.miles)} 哩</b>` : '—'}</td>
      <td>${direct ? `${directLabel(dRoute)} ${fmt(direct)} 哩${direct >= best.miles ? ` <span class="ok-text">${dRoute.path ? '這樣' : '直接轉'}比較多</span>` : ''}${directChain(dRoute)}` : '<small>不能直接轉</small>'}</td>` });
  }
  rows.sort((a, b) => (mode === 'm2p' ? a.sort - b.sort : b.sort - a.sort));
  host.innerHTML = (rows.length ? `<div class="table-wrap"><table class="wallet-sum detour-table"><thead><tr><th>銀行點數</th><th>路線</th><th>${mode === 'm2p' ? '需要' : '最後拿到'}</th><th>直接轉</th></tr></thead><tbody>
      ${rows.map((r) => `<tr>${r.html}</tr>`).join('')}</tbody></table></div>
      <p class="hint">${mode === 'm2p' ? `要換到 ${fmt(amount)} 哩，` : ''}每一列是一家銀行自己轉的結果；同一家飯店可以把幾家銀行的點數加在一起再轉，「我的點數」會這樣幫你合計。</p>`
    : `<p class="hint">台灣的銀行點數目前沒有路線能經飯店轉到 ${esc(airName(air))}。</p>`) + detourRefHtml(air);
}
// Which hotels transfer to this airline, at what rate, how long it takes, and where the rate comes from.
function detourRefHtml(air) {
  const t = toAir();
  const names = data.points.calc.hotels.programs;
  const list = Object.entries(t.hotels).map(([k, h]) => ({ k, h, p: hotelPartner(k, air) })).filter((x) => x.p);
  if (!list.length) return '';
  const srcs = (h, p) => (h.sources || []).filter((x) => x.official || p.confidence !== 'official').slice(0, 2)
    .map((x) => `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.label)} ↗</a>`).join('　');
  return `<h3 class="sub">飯店轉到 ${esc(airName(air))} 的比率</h3><ul class="detour-ref">
    ${list.map(({ k, h, p }) => `<li><b>${esc(names[k] || k)}</b>　${hotelRatioLabel(p)}${p.bonus && h.bonus ? `，每轉 ${fmt(h.bonus.every)} 點加贈 ${fmt(p.bonusMiles || h.bonus.miles)} 哩` : ''}${p.minPoints || h.minPoints ? `，最低 ${fmt(p.minPoints || h.minPoints)} 點` : ''}
      <small>${p.note ? `${esc(p.note)}・` : ''}入帳 ${esc(h.transferDays || '')}　${CONFIDENCE_TAG[p.confidence] || ''} ${srcs(h, p)}</small></li>`).join('')}
    </ul><p class="hint">${esc(t.note)} 飯店點數轉出後不能退回，建議先確認航空有位子再轉。（整理於 ${esc(t.researched)}）</p>${isAvios(air) ? aviosEarnHtml(air, `<h3 class="sub">${esc(aviosName(air))} 互轉</h3>`) : ''}`;
}
function bindDetour(host) {
  const sync = () => {
    detour.air = $('#dt-air', host).value;
    detour.mode = $('#dt-mode', host).value;
    detour.amount = Math.max(0, Math.floor(Number($('#dt-amount', host).value) || 0));
    renderDetour();
  };
  $('#dt-air', host).addEventListener('change', sync);
  $('#dt-mode', host).addEventListener('change', () => {
    const amt = $('#dt-amount', host);
    if ($('#dt-mode', host).value === 'm2p' && detour.mode !== 'm2p') amt.value = 30000;
    if ($('#dt-mode', host).value === 'p2m' && detour.mode === 'm2p') amt.value = 60000;
    sync();
  });
  $('#dt-amount', host).addEventListener('input', sync);
  $$('[data-dt-air]', host).forEach((b) => b.addEventListener('click', () => { $('#dt-air', host).value = b.dataset.dtAir; sync(); }));
  renderDetour();
}

// ---------- nonstop routes (data/rtw-routes.json, fetched on first use; 環球票規劃 and mapkit.js read it) ----------
// raw.routes holds each pair once, under the code that sorts first: { HKG: 'NRT:CXJLNH TPE:BRCX' } (two-letter codes).
// → { pairs: Map('HKG NRT' → ['CX', 'JL', 'NH']), from: Map('HKG' → Map('NRT' → [...])), source }
const nonstopKey = (a, b) => (a < b ? `${a} ${b}` : `${b} ${a}`);
function nonstopIndex(raw) {
  const pairs = new Map();
  const from = new Map();
  const link = (a, b, list) => { if (!from.has(a)) from.set(a, new Map()); from.get(a).set(b, list); };
  for (const [a, s] of Object.entries(raw?.routes || {})) {
    for (const e of String(s).split(' ')) {
      const [b, codes] = e.split(':');
      const list = codes?.match(/[A-Z0-9]{2}/g);
      if (!/^[A-Z]{3}$/.test(b || '') || !list) continue;
      pairs.set(nonstopKey(a, b), list);
      link(a, b, list);
      link(b, a, list);
    }
  }
  return { pairs, from, source: raw?.source || null };
}
let nonstopData = null; // the index, with meta { note, source } for the attribution line
let nonstopP = null;
// Resolves to the index, or null when it would not load (asked again next time).
const nonstopLoad = () => (nonstopP ||= api('/api/data/rtwroutes').then((raw) => {
  nonstopData = Object.assign(nonstopIndex(raw), { meta: { note: raw.note, source: raw.source } });
  return nonstopData;
}, () => { nonstopP = null; return null; }));
// The airlines on record flying a↔b nonstop: [] when none, null before the data has loaded. Every caller goes through
// this one function, so an official timetable can replace it later.
function nonstopCarriers(a, b) { return nonstopData ? nonstopData.pairs.get(nonstopKey(a, b)) || [] : null; }
// A distance with its kilometres: 「4,528 哩（7,287 公里）」 (statute miles, as the award charts count).
const miKm = (mi) => `${fmt(mi)} 哩（${fmt(Math.round(mi * 1.609344))} 公里）`;
// mapkit.js (可搭直飛 tags, 級距提醒, 經過 comparison, 兌換地圖 layers) and the nonstop data, fetched together on first
// use. Resolves either way; until mapkitDone the pages wait for it once, after that they draw without what failed.
let mapkitP = null;
let mapkitDone = false;
const mapkitIn = () => typeof mkNeed === 'function' && Boolean(nonstopData);
const loadMapkit = () => (mapkitP ||= Promise.all([loadScripts(['mapkit']), nonstopLoad()]).then(() => {
  mapkitDone = true;
  if (!mapkitIn()) mapkitP = null;
}));

// ---------- miles needed (fixed award charts, no seat search) ----------
const need = { origin: '', destination: '', cabin: 'J', trip: 'ow', vias: [] };
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
// Price one program's chart for a route; returns [{ label, miles, note }], plus { bands, d } when a distance band set
// the price (mapkit.js's 級距提醒). from.via may list connection airports (a table that counts a country it touches).
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
    // A home-carrier table that only counts when the route touches its hub country (Etihad flies everything via Abu Dhabi).
    if (t.touchesCountries && ![from, to, ...(from.via || [])].some((ap) => t.touchesCountries.includes(ap.country))) continue;
    let miles = null;
    let note = '';
    let edge = null;
    if (p.kind === 'distance') {
      const d = p.distanceBasis === 'roundTripTotal' ? dist * 2 : dist;
      const band = bandFor(t.bands, d);
      miles = band ? band[cabin] : null;
      if (band) note = p.oneWay === false ? `來回總價；來回 ${bandNote(d, band)}` : bandNote(d, band);
      edge = { bands: t.bands, d };
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
      if (pair.bands) edge = { bands: pair.bands, d: dist };
    }
    if (miles) out.push({ label: t.label, miles, note, ...edge });
  }
  return out;
}
function needHtml() {
  return `<form id="need-form" class="need" autocomplete="off">
    <p class="hint">不查座位，只依各計畫公布的固定哩程表，估算一個人要多少哩。動態定價的計畫（聯合、達美、法荷航等）沒有固定表，請用航線查詢看實際價格。</p>
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
    <label class="field mk-via" ${need.vias.length ? '' : 'hidden'}>經過（選填，和直飛並排比較）<input name="via" value="${esc(need.vias.map((v) => v.join('-')).join(', '))}" placeholder="例如 HKG；多種轉法用逗號隔開：HKG, NRT" autocapitalize="characters" spellcheck="false"></label>
    <div class="opts-row">
      <fieldset class="seg" aria-label="單程或來回">${[['ow', '單程'], ['rt', '來回']].map(([k, l]) => `<label><input type="radio" name="trip" value="${k}" ${need.trip === k ? 'checked' : ''}><span>${l}</span></label>`).join('')}</fieldset>
      <fieldset class="seg" aria-label="艙等">${Object.entries({ Y: '經濟', W: '豪經', J: '商務', F: '頭等' }).map(([k, l]) => `<label><input type="radio" name="cabin" value="${k}" ${need.cabin === k ? 'checked' : ''}><span>${l}</span></label>`).join('')}</fieldset>
      <button type="button" class="linklike" id="need-via-add" ${need.vias.length ? 'hidden' : ''}>＋ 加轉機點比較</button>
      <button type="submit" class="primary">試算</button>
    </div>
  </form>
  <div id="need-result"></div>`;
}
function bindNeed(host) {
  const form = $('#need-form', host);
  const via = form.via;
  const showVia = () => { $('.mk-via', form).hidden = false; $('#need-via-add', form).hidden = true; };
  // 出發地 takes a whole route (TPE-HKG-LHR, or several: TPE-HKG-LHR, TPE-NRT-LHR): its ends fill the fields, the stops
  // between go to 經過, and it is priced at once.
  const onRoute = (routes) => {
    const [first] = routes;
    const same = routes.filter((r) => r[0][0] === first[0][0] && r.at(-1)[0] === first.at(-1)[0]);
    pk.origin.set([first[0][0]]);
    pk.destination.set([first.at(-1)[0]]);
    const mids = same.map((r) => r.slice(1, -1).map((st) => st[0])).filter((m) => m.length);
    via.value = mids.map((m) => m.join('-')).join(', ');
    if (mids.length) showVia();
    if (same.length < routes.length) toast('起訖不同的路線沒有帶入，只比較同一組起訖');
    form.requestSubmit();
    return true;
  };
  const pk = { origin: createAirportPicker(form, 'origin', { onRoute }), destination: createAirportPicker(form, 'destination') };
  $('#need-via-add', form).addEventListener('click', () => { showVia(); via.focus(); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    await loadAirports();
    for (const p of Object.values(pk)) {
      const unknown = p.commit();
      if (unknown.length || !p.codes().length) { toast(unknown.length ? `找不到「${unknown.join('、')}」` : `請輸入${p.label}`); p.focus(); return; }
    }
    // 經過: up to three ways round, each of up to three stops (HKG, NRT, HKG-DOH; names work too).
    const vias = [];
    for (const alt of String(via.value).split(/\s*[,，、;；]\s*/).filter(Boolean).slice(0, 3)) {
      const stops = alt.split(/\s*(?:->|=>|[-→>＞/\s])\s*/).filter(Boolean).slice(0, 3).map((s) => ({ s, code: resolveAirports(s).codes[0] }));
      const bad = stops.filter((x) => !x.code || !AP.byCode.get(x.code));
      if (bad.length) { toast(`找不到「${bad.map((x) => x.s).join('、')}」`); via.focus(); return; }
      if (stops.length) vias.push(stops.map((x) => x.code));
    }
    need.vias = vias;
    need.origin = pk.origin.codes()[0];
    need.destination = pk.destination.codes()[0];
    need.cabin = new FormData(form).get('cabin') || 'J';
    need.trip = new FormData(form).get('trip') === 'rt' ? 'rt' : 'ow';
    renderNeed();
  });
  if (need.origin && need.destination) loadAirports().then(renderNeed);
}
function renderNeed() {
  const host = $('#need-result');
  const a = AP.byCode.get(need.origin);
  const b = AP.byCode.get(need.destination);
  if (!host || !a || !b || a.lat == null || b.lat == null) return;
  // The first time, wait for mapkit.js and the nonstop data (可搭直飛, 級距提醒, 經過); after that draw with what came.
  if (!mapkitIn() && !mapkitDone) { host.innerHTML = skeleton(4); loadMapkit().then(renderNeed); return; }
  const kit = mapkitIn();
  const dist = haversineMiles(a, b);
  const c = need.cabin;
  // Round trip, as on 兌換地圖: two one-ways, except charts that only sell round trips (used as they are, and left out
  // of a one-way table).
  const rt = need.trip === 'rt';
  const rows = [];
  // Asia Miles from the chart the site already carries; Cathay's own flights by the distance Asia Miles counts
  // (through Hong Kong unless nonstop, app.js amCxDist).
  for (const am of amRoutePrices(a, b, dist, c)) {
    rows.push({ key: 'asiamiles', kind: am.kind, via: am.via, bands: data.asiamiles.bands, d: am.dist, label: am.kind === 'cx' ? '國泰航班' : '夥伴航班', miles: am.miles * (rt ? 2 : 1), note: am.via ? `${AM_VIA_TEXT} ${fmt(am.dist)} 哩` : `${fmt(dist)} 哩`, confidence: 'official' });
  }
  for (const p of data.charts?.programs || []) {
    if (!['distance', 'zone', 'regionMatrix', 'routeSpecific'].includes(p.kind) || (p.oneWay === false && !rt)) continue;
    const mult = rt && p.oneWay !== false ? 2 : 1;
    // One row per program: its cheapest table, plus the top of the range when partners price differently.
    const prices = chartPrices(p, a, b, c, dist).map((x) => ({ ...x, miles: x.miles * mult })).sort((x, y) => x.miles - y.miles);
    if (!prices.length) continue;
    const [x] = prices;
    const top = prices[prices.length - 1].miles;
    rows.push({ key: p.id, kind: '', via: '', bands: x.bands, d: x.d, name: p.name, label: x.label, miles: x.miles, note: `${x.note}${top > x.miles ? `；其他航空最高 ${fmt(top)} 哩` : ''}`, confidence: p.confidence, perSegment: p.perSegment, src: p.sources?.[0], pnote: p.note });
  }
  rows.sort((x, y) => x.miles - y.miles);
  const dyn = (data.charts?.programs || []).filter((p) => p.kind === 'dynamic' || (p.kind === 'routeSpecific' && !p.routes?.length)).map((p) => rmapProgramName(p.id));
  // mapkit.js: each row's 可搭直飛 tag, band-edge warning and cheaper Taiwan airport; with 經過, the routes side by side.
  const kitFoot = kit ? mkNeed(a, b, rows, c, rt).foot : '';
  const compare = kit && need.vias.length ? mkCompareHtml(a, b, need.vias, c, rt) : '';
  host.innerHTML = `<h3 class="sub">${esc(need.origin)} ${esc(airportCity(need.origin))} → ${esc(need.destination)} ${esc(airportCity(need.destination))}　${rt ? '來回・' : ''}${CABIN_LABEL[c]}・直線距離 ${miKm(dist)}</h3>
    ${compare ? `<h4 class="mk-h">轉機走法比較</h4>${compare}<h4 class="mk-h">各計畫明細（${esc(need.origin)} → ${esc(need.destination)} 直飛距離）</h4>` : ''}
    ${rows.length ? `<div class="table-wrap"><table class="need-table need-main"><thead><tr><th>計畫</th><th>${rt ? '來回' : '單程'}哩數</th><th>依據</th><th>資料</th></tr></thead><tbody>
      ${rows.map((r, i) => `<tr class="${i === 0 ? 'best-row' : ''}"><td><b>${esc(chartProgram(r.key, r.name).name)}</b><small>${esc(r.label)}</small></td><td><b>${fmt(r.miles)} 哩</b>${shortfallHtml(r.key, r.miles)}</td>
        <td><small>${esc(r.note)}${r.perSegment ? '；每段航班分開計價，轉機會更貴' : ''}</small>${r.extra ? `<span class="mk-bits">${r.extra}</span>` : ''}</td>
        <td>${CONFIDENCE_TAG[r.confidence] || ''}${r.src ? `<small><a href="${esc(r.src.url)}" target="_blank" rel="noopener">${esc(r.src.label)} ↗</a></small>` : ''}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="hint">這條航線找不到適用的固定哩程表。</p>'}
    <p class="hint">${rt ? '來回是兩張單程相加；只賣來回的表照表上的來回價。' : ''}以直線距離或區域估算，最低（Saver）價格；實際轉機路線、旺季與燃油附加費可能讓價格不同。${dyn.length ? `${esc(dyn.join('、'))} 為動態定價，不列入。` : ''}${kit ? '距離是兩地的大圓距離（英里；規則庫「名詞解釋」有說明），和航空公司的計算可能差幾哩。' : ''}</p>
    ${kitFoot}
    <button type="button" class="outline" id="need-search">用航線查詢找實際座位</button>`;
  $('#need-search').addEventListener('click', () => {
    pickers.origin.set([need.origin]);
    pickers.destination.set([need.destination]);
    setCabin(c);
    showTab('search');
    $('#search-form .dp-btn').focus();
    toast('選好出發日期後按「搜尋機位」；不選日期會查未來 1 個月');
  });
}

// ---------- 兌換地圖 tab: where the fixed award charts can take you from one airport (no seat search, no quota) ----------
// direct, air, rings, sort, listOpen: mapkit.js's layers (只看有直飛 by airline or alliance, 距離級距圈, the city list).
const rmap = { origins: ['TPE'], cabin: 'J', trip: 'ow', program: '', budget: 0, mine: false, drawnWallet: '', direct: false, air: '', rings: false, sort: 'miles', listOpen: false };
let rmapMap = null;
// Every program with a fixed chart, one-way prices; 日航寰宇一家 only prices round trips.
const rmapPrograms = () => ['asiamiles', ...(data.charts?.programs || []).filter((p) => ['distance', 'zone', 'regionMatrix', 'routeSpecific'].includes(p.kind) && (p.routes?.length || p.tables?.length)).map((p) => p.id)];
// One name per program across the site: data/source-names.json (or the site's own short names) first. A chart's own
// wording such as 「星盟夥伴」 or 「（星盟夥伴 Saver）」 is the variant, shown small beside the name.
const CHART_VARIANT = /\s*(?:（([^（）]+)）|\s(星盟夥伴|天合聯盟夥伴))$/;
function chartProgram(id, full = '', alt = '') {
  full = String(full || '');
  const m = full.match(CHART_VARIANT);
  const named = (k) => SOURCE_NAMES[k] || EXTRA_PROGRAM_NAMES[k];
  const known = [id, alt].map(named).find(Boolean);
  // A chart paid with another program's miles (日航寰宇一家 → 日航 JMB): that program's name, the chart's wording small.
  const parent = !known && [id, alt].map(programKeyOf).map(named).find(Boolean);
  if (parent) return { name: parent, variant: m ? m[1] || m[2] : full.replace(/^\S+\s+/, '') };
  return { name: known || (m ? full.slice(0, m.index) : full) || id, variant: m ? m[1] || m[2] : '' };
}
const rmapProgramName = (id) => chartProgram(id, data.charts?.programs?.find((p) => p.id === id)?.name).name;
// A chart from a third-party summary (charts.json confidence secondary); Asia Miles' own chart is not in charts.json.
const rmapThirdParty = (id) => data.charts?.programs?.find((p) => p.id === id)?.confidence === 'secondary';
// Asia Miles one-way prices from a to b (airports with coordinates), straight distance `dist`: Cathay's own flights by
// the distance Asia Miles counts (through Hong Kong unless nonstop, app.js amCxDist), one partner flown alone by the
// straight distance (its connections are not known here). → [{ kind, miles, band, dist, via }].
function amRoutePrices(a, b, dist, cabin) {
  const out = [];
  const cx = amCxDist(a.code, b.code, dist, false, (c) => (c === a.code ? a : c === b.code ? b : AP.byCode.get(c)));
  const p = cx && amPrice('cx', cx.dist, cabin, a.code, b.code);
  if (p?.miles) out.push({ ...p, dist: cx.dist, via: cx.via });
  const q = amPrice('partner', dist, cabin, a.code, b.code);
  if (q?.miles) out.push({ ...q, dist, via: '' });
  return out;
}
// Prices for one destination: [{ id, label, miles }], cheapest first. Round trip = two one-ways, except charts that are
// round-trip only, which are used as they are.
function rmapPrices(a, b, cabin, trip, only) {
  const dist = haversineMiles(a, b);
  const rt = trip === 'rt';
  const out = [];
  if (!only || only === 'asiamiles') {
    for (const am of amRoutePrices(a, b, dist, cabin)) {
      out.push({ id: 'asiamiles', label: am.kind === 'cx' ? `國泰航班${am.via ? `・${AM_VIA_TEXT}` : ''}` : '夥伴航班', miles: am.miles * (rt ? 2 : 1) });
    }
  }
  for (const p of data.charts?.programs || []) {
    if (only && p.id !== only) continue;
    if (!['distance', 'zone', 'regionMatrix', 'routeSpecific'].includes(p.kind)) continue;
    if (p.oneWay === false && !rt) continue;
    const mult = rt && p.oneWay !== false ? 2 : 1;
    for (const x of chartPrices(p, a, b, cabin, dist)) out.push({ id: p.id, label: x.label, miles: x.miles * mult });
  }
  // One line per program: its cheapest table.
  const best = new Map();
  for (const x of out.sort((m, n) => m.miles - n.miles)) if (!best.has(x.id)) best.set(x.id, x);
  return { dist, prices: [...best.values()] };
}
const rmapFroms = () => rmap.origins.map((c) => AP.byCode.get(c)).filter((a) => a && a.lat != null);
// Destinations: the big airports that have a Chinese name, one pin per city. Each program is priced to whichever of the
// city's airports is cheapest for it (`to`; on a tie the city's main airport), and with several origins from whichever
// origin is cheapest (`from`). The pin sits on the airport of the cheapest program.
function rmapDestinations() {
  const froms = rmapFroms();
  if (!froms.length) return [];
  const byCity = new Map();
  const groupOf = new Map(AP.groups.flatMap((g) => g.codes.map((c) => [c, g.zh])));
  const codesOf = new Map(AP.groups.map((g) => [g.zh, g.codes]));
  const homeCities = new Set(froms.map((f) => groupOf.get(f.code)).filter(Boolean));
  for (const ap of AP.list) {
    if (!ap.large || !ap.zh || ap.lat == null || froms.some((f) => f.code === ap.code)) continue;
    // Multi-airport cities (東京 = NRT, HND) become one pin.
    const city = groupOf.get(ap.code) || ap.zh.replace(/（.*）$/, '');
    if (homeCities.has(city) || froms.some((f) => haversineMiles(f, ap) < 100)) continue; // an origin's own city
    if (!byCity.has(city)) byCity.set(city, { city, codes: codesOf.get(city) || [ap.code], best: new Map() });
    const c = byCity.get(city);
    const rank = (code) => { const i = c.codes.indexOf(code); return i < 0 ? c.codes.length : i; };
    for (const from of froms) {
      const { dist, prices } = rmapPrices(from, ap, rmap.cabin, rmap.trip, rmap.program);
      for (const x of prices) {
        const old = c.best.get(x.id);
        if (!old || x.miles < old.miles || (x.miles === old.miles && rank(ap.code) < rank(old.to))) c.best.set(x.id, { ...x, from: from.code, to: ap.code, dist });
      }
    }
  }
  const out = [];
  for (const { city, codes, best } of byCity.values()) {
    let shown = [...best.values()].sort((m, n) => m.miles - n.miles);
    if (rmap.mine && !walletEmpty()) shown = shown.filter((x) => reach(x.id).total >= x.miles);
    if (rmap.budget) shown = shown.filter((x) => x.miles <= rmap.budget);
    if (!shown.length) continue;
    // The airports the shown prices go to, the city's main airport first (倫敦 LHR/LGW).
    const tos = [...new Set(shown.map((x) => x.to))].sort((m, n) => (codes.indexOf(m) + 1 || 99) - (codes.indexOf(n) + 1 || 99));
    out.push({ ap: AP.byCode.get(shown[0].to), city, codes, tos, from: shown[0].from, dist: shown[0].dist, prices: shown, min: shown[0].miles });
  }
  return out;
}
function rmapHtml() {
  const progs = rmapPrograms();
  return `<form id="rmap-form" class="search-card" autocomplete="off">
    <div class="rmap-row">
      <div class="field grow ac-host">
        <label for="rm-origin">出發地</label>
        <div class="chips-box" data-for="origin"><span class="chips"></span>
          <input id="rm-origin" class="chips-q" placeholder="城市、機場或代碼" autocapitalize="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="ac-rm-origin"></div>
        <input type="hidden" name="origin" value="${esc(rmap.origins.join(','))}">
        <div class="ac-list" id="ac-rm-origin" role="listbox" aria-label="出發地建議" hidden></div>
      </div>
      <label class="field">計畫<select name="program"><option value="">全部有固定表的計畫</option>${progs.map((id) => `<option value="${esc(id)}" ${rmap.program === id ? 'selected' : ''}>${esc(rmapProgramName(id))}</option>`).join('')}</select></label>
      <label class="field">我有幾哩（選填）<input name="budget" inputmode="numeric" placeholder="例如 30000" value="${rmap.budget || ''}"></label>
    </div>
    <div class="opts-row">
      <fieldset class="seg" aria-label="單程或來回">${[['ow', '單程'], ['rt', '來回']].map(([k, l]) => `<label><input type="radio" name="trip" value="${k}" ${rmap.trip === k ? 'checked' : ''}><span>${l}</span></label>`).join('')}</fieldset>
      <fieldset class="seg" aria-label="艙等">${Object.entries({ Y: '經濟', W: '豪經', J: '商務', F: '頭等' }).map(([k, l]) => `<label><input type="radio" name="cabin" value="${k}" ${rmap.cabin === k ? 'checked' : ''}><span>${l}</span></label>`).join('')}</fieldset>
      <label class="switch" id="rmap-mine" ${walletEmpty() ? 'hidden' : ''}><input type="checkbox" name="mine" ${rmap.mine ? 'checked' : ''}><span class="knob"></span>只看我的點數換得到的</label>
      <button type="submit" class="primary">看地圖</button>
    </div>
  </form>`;
}
function initRmap() {
  const host = $('#map-page');
  if (!host) return;
  host.innerHTML = rmapHtml();
  bindRmap(host);
}
function bindRmap(host) {
  const form = $('#rmap-form', host);
  const pk = createAirportPicker(form, 'origin');
  const read = () => {
    const fd = new FormData(form);
    Object.assign(rmap, { cabin: fd.get('cabin') || 'J', trip: fd.get('trip') || 'ow', program: fd.get('program') || '', budget: cleanCount(String(fd.get('budget') || '').replace(/[,\s]/g, '')), mine: Boolean(fd.get('mine')) });
  };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    await loadAirports();
    const unknown = pk.commit();
    if (unknown.length || !pk.codes().length) { toast(unknown.length ? `找不到「${unknown.join('、')}」` : '請輸入出發地'); pk.focus(); return; }
    rmap.origins = pk.codes();
    read();
    renderRmap();
  });
  // Cabin, trip, program and the wallet switch redraw at once; the miles box waits for 看地圖 / Enter.
  $$('input[name=cabin], input[name=trip], select[name=program], input[name=mine]', form).forEach((i) => i.addEventListener('change', () => { read(); renderRmap(); }));
  loadAirports().then(renderRmap);
}
// The wallet can change while this tab is away (or by account sync): show the switch only when there are points, and
// redraw pins that were filtered by the old balances. Also re-measure the map, which cannot size itself while hidden.
function syncRmap() {
  if (!$('#rmap-form')) return;
  $('#rmap-mine').hidden = walletEmpty();
  if (rmap.mine && JSON.stringify(wallet) !== rmap.drawnWallet) renderRmap();
  else fitMap(rmapMap);
}
async function renderRmap() {
  const out = $('#rmap-out');
  if (!out) return;
  const froms = rmapFroms();
  if (!froms.length) return;
  // The first time, wait for mapkit.js and the nonstop data (the layers row, flight times); after that draw without.
  if (!mapkitIn() && !mapkitDone) { out.innerHTML = skeleton(3); await loadMapkit(); }
  const kit = mapkitIn();
  rmap.drawnWallet = JSON.stringify(wallet);
  const multi = froms.length > 1;
  const dests = kit ? mkMapDests(rmapDestinations()) : rmapDestinations();
  const dyn = (data.charts?.programs || []).filter((p) => p.kind === 'dynamic').map((p) => rmapProgramName(p.id));
  const label = `${froms.map((f) => `${f.code} ${airportCity(f.code)}`).join('、')} 出發・${rmap.trip === 'rt' ? '來回' : '單程'}・${CABIN_LABEL[rmap.cabin]}${rmap.program ? `・${rmapProgramName(rmap.program)}` : ''}`;
  out.innerHTML = `<h3 class="sub">${esc(label)}　${dests.length ? `${fmt(dests.length)} 個城市` : ''}</h3>
    ${kit ? `<div class="rmap-layers" id="rmap-layers">${mkLayersHtml()}</div>` : ''}
    ${dests.length ? '<div id="rmap" class="ex-map rmap"><p class="hint">地圖載入中…</p></div>' : `<p class="hint">${kit && rmap.direct ? '沒有符合「只看有直飛」的城市，換一家航空公司、換計畫或關掉它看看。' : rmap.budget || rmap.mine ? '這個哩數換不到任何城市，放寬條件看看。' : '這個出發地和艙等找不到適用的固定哩程表。'}</p>`}
    <p class="hint">${multi ? '有多個出發地時，每個計畫取最便宜的出發地。' : ''}標的是最低價（Saver），以兩地直線距離或區域估算；實際轉機路線、旺季與燃油附加費可能讓價格不同。長榮、華航、全日空等依區域計價的表只適用台灣出發。${dyn.length ? `${esc(dyn.join('、'))} 是動態定價，不列入。` : ''}</p>
    ${dests.length && dests.some((d) => d.prices.some((x) => rmapThirdParty(x.id))) ? '<p class="hint">標「第三方整理」的哩程表取自第三方整理，未能在計畫官網逐項核對。</p>' : ''}
    ${kit && dests.length ? mkAfterMapHtml(dests) : ''}`;
  if (!dests.length) return;
  // No map (Leaflet would not load, or would not draw): say so with a 重試, and list the same cities instead.
  const noMap = (err) => {
    if (rmapMap) { rmapMap.remove(); rmapMap = null; }
    const box = $('#rmap');
    if (!box) return;
    box.outerHTML = `${mapFailHtml(err)}${rmapListHtml(dests)}`;
    $('#rmap-out [data-map-retry]')?.addEventListener('click', renderRmap);
  };
  try { await loadLeaflet(); } catch (err) { noMap(err); return; }
  const el = $('#rmap');
  if (!el) return;
  el.innerHTML = '';
  if (rmapMap) { rmapMap.remove(); rmapMap = null; }
  try { drawRmap(el, froms, dests, multi); } catch (err) { console.error(err); noMap(new Error('地圖畫不出來，請再試一次')); }
}
function drawRmap(el, froms, dests, multi) {
  const L = window.L;
  rmapMap = L.map(el, { worldCopyJump: true, scrollWheelZoom: false });
  addBaseMap(rmapMap);
  keepMapSized(rmapMap);
  const mins = dests.map((d) => d.min).sort((a, b) => a - b);
  const tier = (m) => (mins.length < 2 ? 0 : Math.min(3, Math.floor((mins.indexOf(m) / (mins.length - 1)) * 4)));
  for (const f of froms) L.circleMarker([f.lat, f.lon], { radius: 7, color: '#fff', weight: 2, fillColor: '#2a9d4b', fillOpacity: 1 }).bindTooltip(`${f.code} 出發`).addTo(rmapMap);
  // Popular places first, then the cheaper ones: they keep their labels when pins crowd.
  const rank = (d) => { const i = RMAP_POPULAR.indexOf(d.city); return i < 0 ? 1000 + d.min / 1000 : i; };
  dests.sort((a, b) => rank(a) - rank(b));
  // On a phone the map is short: fewer rows, and never taller than the map (Leaflet scrolls the rest).
  const narrow = matchMedia('(max-width: 640px)').matches;
  const rows = narrow ? 5 : 8;
  // A phone's card fits beside the zoom buttons (autoPanPaddingTopLeft) with Leaflet's own padding.
  const popW = Math.max(200, Math.min(320, el.clientWidth - 110));
  const marks = [];
  dests.forEach((d, i) => {
    const icon = L.divIcon({ className: `rm-pin t${tier(d.min)}${d.ring ? ' rm-direct' : ''}`, html: `<span class="rm-k">${Math.round(d.min / 1000)}</span><span class="rm-label"><b>${esc(d.city)}</b>${fmt(d.min)} 哩起</span>`, iconSize: null, iconAnchor: [14, 14] });
    const m = L.marker([d.ap.lat, d.ap.lon], { icon, title: `${d.city} ${fmt(d.min)} 哩起${multi ? `（${d.from} 出發）` : ''}`, zIndexOffset: (dests.length - i) * 10 }).addTo(rmapMap);
    d.marker = m;
    marks.push({ m, d, w: 40 + Math.max(d.city.length * 13, fmt(d.min).length * 8 + 30) });
    // Each row names its origin only when the rows came from different ones, and its airport when the city's
    // programs price different airports. A chart from a third-party summary says so (the hint under the map explains).
    const mixed = new Set(d.prices.map((x) => x.from)).size > 1;
    const mixedTo = d.tos.length > 1;
    // Straight distance from the cheapest row's origin, as a range when its rows go to different airports.
    const ds = d.prices.filter((x) => x.from === d.from).map((x) => x.dist);
    const [lo, hi] = [Math.min(...ds), Math.max(...ds)];
    // Built when the card opens (mapkit.js adds flight time, nonstop airlines and band notes).
    const kit = mapkitIn();
    m.bindPopup(() => `<b>${esc(d.city)}</b> <small>${esc(d.tos.join('/'))}・${multi ? `距 ${esc(d.from)} ` : ''}直線 ${hi > lo ? `${fmt(lo)}–${fmt(hi)} 哩` : miKm(lo)}</small>
      <table class="rm-pop">${d.prices.slice(0, rows).map((x) => `<tr><td>${esc(rmapProgramName(x.id))}<small>${esc(x.label)}${mixedTo ? `・${esc(x.to)}` : ''}${mixed ? `・${esc(x.from)} 出發` : ''}${rmapThirdParty(x.id) ? '・第三方整理' : ''}${kit ? mkRowTag(x) : ''}</small></td><td><b>${fmt(x.miles)}</b></td></tr>`).join('')}</table>
      ${d.prices.length > rows ? `<small>還有 ${d.prices.length - rows} 個計畫</small>` : ''}
      ${kit ? mkPopupHtml(d) : ''}
      <div class="map-actions"><button type="button" data-rm-search="${esc(d.codes.join(','))}">到航線查詢找座位</button><button type="button" data-rm-need="${esc(d.ap.code)}" data-rm-from="${esc(d.from)}">看計算依據</button></div>`,
    { minWidth: narrow ? Math.min(220, popW) : 240, maxWidth: narrow ? popW : 320, autoPanPaddingTopLeft: L.point(52, 12), ...(narrow ? { maxHeight: Math.max(200, el.clientHeight - 70) } : {}) });
  });
  // Declutter on every move: in rank order, a pin gets its label when the label has room, only its dot when the dot
  // has room, and hides otherwise (zoom in to see it).
  const declutter = () => {
    const taken = [];
    const free = (r) => !taken.some((t) => r.x < t.x + t.w && t.x < r.x + r.w && r.y < t.y + t.h && t.y < r.y + r.h);
    for (const { m, w } of marks) {
      const el2 = m.getElement();
      if (!el2) continue;
      const p = rmapMap.latLngToContainerPoint(m.getLatLng());
      const full = { x: p.x - 14, y: p.y - 18, w, h: 36 };
      const dot = { x: p.x - 14, y: p.y - 14, w: 28, h: 28 };
      const mode = free(full) ? 'full' : free(dot) ? 'dot' : 'hide';
      el2.classList.toggle('rm-dot', mode === 'dot');
      el2.classList.toggle('rm-hide', mode === 'hide');
      if (mode !== 'hide') taken.push(mode === 'full' ? full : dot);
    }
  };
  rmapMap.on('zoomend moveend', declutter);
  // Start on the origins' part of the world; everything else is a drag or a zoom away.
  const pts = froms.map((f) => [f.lat, f.lon]);
  const fit = multi && el.clientWidth ? rmapMap.getBoundsZoom(L.latLngBounds(pts), false, L.point(80, 80)) : 4;
  rmapMap.setView(multi ? L.latLngBounds(pts).getCenter() : pts[0], Math.min(4, fit));
  declutter();
  if (mapkitIn()) mkDrawLayers(rmapMap, froms, dests);
}
// Places most people fly to from Taiwan; they win the label space.
const RMAP_POPULAR = ['東京', '大阪', '首爾', '曼谷', '香港', '新加坡', '上海', '沖繩那霸', '札幌', '福岡', '名古屋中部', '釜山', '峴港', '胡志明市', '河內', '吉隆坡', '峇里島', '馬尼拉', '宿霧', '北京', '倫敦', '巴黎', '法蘭克福', '阿姆斯特丹', '羅馬', '米蘭', '維也納', '蘇黎世', '伊斯坦堡', '杜拜', '杜哈', '洛杉磯', '舊金山灣區', '紐約', '西雅圖', '溫哥華', '多倫多', '芝加哥', '雪梨', '墨爾本', '布里斯本', '奧克蘭', '關島', '夏威夷', '濟州', '清邁', '普吉島', '雅加達', '德里', '孟買', '開羅', '約翰尼斯堡'];
document.addEventListener('click', (e) => {
  const s = e.target.closest?.('[data-rm-search]');
  if (s) {
    // Straight into a route search for the next month from every chosen origin; the dates can be changed there.
    applyShare(new URLSearchParams({ o: rmap.origins.join(','), d: s.dataset.rmSearch, s: isoDate(1), e: isoDate(30), c: rmap.cabin }));
    return;
  }
  const n = e.target.closest?.('[data-rm-need]');
  if (n) {
    // The basis for the prices in the popup: from the origin they came from, one-way or round trip as on the map.
    Object.assign(need, { origin: n.dataset.rmFrom || rmap.origins[0], destination: n.dataset.rmNeed, cabin: rmap.cabin, trip: rmap.trip, vias: [] });
    setPointsView('need');
    showTab('points');
    renderPoints();
  }
});

// ---------- daily deals (shown on the search page before searching) ----------
const dealsState = { cabin: 'J', body: null, busy: false, timer: 0 };
// 立即更新 can run once an hour; after this device's own update the button waits, saying until when.
const DEALS_WAIT_KEY = 'dealsManualAt';
const hhmmLocal = (t) => new Date(t).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
function dealsRefreshHtml() {
  // Shown as soon as the passcode is entered and gone after 清除密碼 (app.js lockChanged redraws this).
  if (!store.get('cashPass', '') && cashCfg.locked) return '';
  if (dealsState.busy) return ' <button type="button" class="linkish" disabled>更新中…（約半分鐘）</button>';
  const until = Number(store.get(DEALS_WAIT_KEY, 0)) + 3600e3;
  clearTimeout(dealsState.timer);
  if (Date.now() < until) {
    dealsState.timer = setTimeout(renderDeals, until - Date.now() + 1000);
    return ` <span>已手動更新，${hhmmLocal(until)} 後可再更新</span>`;
  }
  return ' <button type="button" class="linkish" id="deals-refresh" title="每小時可以更新一次">立即更新（用約 8 次查詢）</button>';
}
async function loadDeals() {
  const host = $('#deals');
  if (!host) return;
  try {
    // For two hours after this browser's 立即更新, ask for that copy or newer (past the CDN's older one).
    const at = store.get('dealsAt', '');
    dealsState.body = await api(`/api/deals${at && Date.now() - Date.parse(at) < 2 * 3600e3 ? `?at=${encodeURIComponent(at)}` : ''}`);
    renderDeals();
    if (!AP.loaded) onAirports(renderDeals); // city names under the codes
  } catch {
    host.innerHTML = '';
  }
  host.removeAttribute('aria-busy'); // drops the reserved height (index.html), see styles.css
}
function renderDeals() {
  const host = $('#deals');
  const body = dealsState.body;
  if (!host || !body) return;
  if (!body.groups.some((g) => g.items.length)) { host.innerHTML = ''; return; }
  // Only offer the cabin switch when both cabins found something.
  const cabins = ['J', 'F'].filter((c) => body.groups.some((g) => g.cabin === c && g.items.length));
  if (!cabins.includes(dealsState.cabin)) dealsState.cabin = cabins[0];
  // leave.js: 請假效率 chips and its 不用請假／請 ≤2 天 filter.
  const lvOk = (d) => typeof leaveOk !== 'function' || leaveOk(d.date);
  const groups = body.groups.filter((g) => g.cabin === dealsState.cabin && g.items.filter(lvOk).length);
  host.innerHTML = `<div class="deals-head"><h2 class="section-title">今日好康 <small>台北出發最便宜的獎勵位・${body.generatedAt ? `${ago(body.generatedAt)}整理` : ''}${body.mock ? '（示範資料）' : ''}</small></h2>
    ${cabins.length > 1 ? `<fieldset class="seg" aria-label="艙等">${[['J', '商務'], ['F', '頭等']].map(([k, l]) => `<label><input type="radio" name="deal-cabin" value="${k}" ${dealsState.cabin === k ? 'checked' : ''}><span>${l}</span></label>`).join('')}</fieldset>` : `<span class="hint">${dealsState.cabin === 'F' ? '頭等艙' : '商務艙'}</span>`}${typeof leaveToolsHtml === 'function' ? leaveToolsHtml('deals') : ''}</div>
    ${groups.map((g) => `<div class="deal-group"><h3 class="sub">${esc(g.name)}</h3><div class="deal-row">${g.items.filter(lvOk).slice(0, 4).map((d) => `
      <button type="button" class="deal-mini" data-deal="${esc(d.origin)}|${esc(d.destination)}|${esc(d.date)}">
        <span class="dm-route">${esc(d.origin)} → ${esc(d.destination)} <small>${esc(airportCity(d.destination))}</small></span>
        <span class="dm-miles">${fmt(d.miles)} <small>哩</small>${d.direct ? '<small class="dm-direct">直飛</small>' : ''}</span>
        <span class="dm-meta">${dayLabel(d.date)} · ${esc(srcName(d.source))}</span>${typeof leaveChip === 'function' ? leaveChip(d.date) : ''}${d.seat ? `<span class="dm-seat" title="${esc(d.seat.note)}">${esc(d.seat.label)}</span>` : ''}${data.promos ? miniSaleTag(d) : ''}
        ${d.usual ? `<span class="dm-usual${d.miles < d.usual ? ' low' : ''}" title="這條航線這個計畫過去有位的日子，每天最低價的中位數（每日排程記下的，少於 7 天不顯示）">平常約 ${fmt(d.usual)} 哩${d.miles < d.usual ? `・少 ${kfmt(d.usual - d.miles)}` : ''}</span>` : ''}
      </button>`).join('')}</div></div>`).join('') || `<p class="hint">${typeof leaveFiltering === 'function' && leaveFiltering() ? '符合請假天數的好康今天沒有，可以放寬「只看」。' : '這個艙等今天沒有整理到好康。'}</p>`}
    <p class="hint">每 12 小時整理一次（早上 8 點多、晚上 9 點多），座位可能已被訂走；點卡片會查那一天前後三天。${dealsRefreshHtml()}</p>`;
  $$('input[name=deal-cabin]', host).forEach((i) => i.addEventListener('change', () => { dealsState.cabin = i.value; renderDeals(); }));
  $('#deals-refresh', host)?.addEventListener('click', async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    b.textContent = '更新中…（約半分鐘）';
    dealsState.busy = true;
    try {
      const d = await cashApi('/api/deals', { pass: '今日好康的立即更新', method: 'POST' });
      dealsState.busy = false;
      dealsState.body = d;
      if (d.refreshed && d.generatedAt) store.set('dealsAt', d.generatedAt);
      if (d.refreshed) store.set(DEALS_WAIT_KEY, Date.now());
      renderDeals();
      // Say what actually happened; when nothing was updated, the hour's turn was not used.
      const why = d.groups?.find((g) => g.error)?.error;
      toast(d.busy ? '另一個更新正在進行，這次沒有更新，請過幾分鐘再試' : !d.refreshed ? `今日好康沒有更新${why ? `（${why}）` : ''}，這次不算，可以稍後再試` : d.failedGroups ? `已更新 ${d.refreshed} 組，${d.failedGroups} 組沒更新成功，先保留舊資料` : '今日好康已更新');
    } catch (err) {
      dealsState.busy = false;
      toast(err.message);
      renderDeals();
    }
  });
  $$('[data-deal]', host).forEach((b) => b.addEventListener('click', () => {
    const [o, d, date] = b.dataset.deal.split('|');
    const s = date < isoDateFrom(isoDate(0), 3) ? isoDate(0) : isoDateFrom(date, -3);
    applyShare(new URLSearchParams({ o, d, s, e: isoDateFrom(date, 3), c: dealsState.cabin }));
  }));
  if (typeof dealSubMount === 'function') dealSubMount(host); // 📬 每天寄給我 (dealsub.js)
  if (typeof dealRulesMount === 'function') dealRulesMount(host); // 🎯 我的條件 (dealrules.js)
  if (typeof ttUpcomingMount === 'function') ttUpcomingMount(host); // 即將開航 (flightdata.js)
}

// ---------- explore map (Leaflet, loaded on first use) ----------
// Leaflet 1.9.4 is served from this site (public/leaflet/: the unchanged upstream files and their BSD licence), so an
// ad blocker or a network that blocks cdnjs no longer leaves an empty map box.
const LEAFLET_URL = '/leaflet/leaflet';
let leafletReady = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve();
  leafletReady ||= new Promise((resolve, reject) => {
    // Both the script and its stylesheet: a map drawn before the CSS arrives has its tiles out of place.
    let left = 2;
    const done = () => { if (!--left) resolve(); };
    const js = document.createElement('script');
    const fail = () => { leafletReady = null; js.remove(); reject(new Error('地圖元件載入失敗，請檢查網路後再試')); };
    if ($('link[data-leaflet]')) left = 1; // a 重試: the stylesheet is already in
    else {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = `${LEAFLET_URL}.css?v=1.9.4`;
      css.dataset.leaflet = '';
      css.onload = done;
      css.onerror = done; // markers still work without it
      document.head.append(css);
    }
    js.src = `${LEAFLET_URL}.js?v=1.9.4`;
    js.onload = done;
    js.onerror = fail;
    document.head.append(js);
  });
  return leafletReady;
}
// A map that cannot draw: the reason and a 重試 button.
const mapFailHtml = (err) => `<div class="status error map-fail"><span>${esc(err.message || err)}</span><button type="button" class="outline retry" data-map-retry>重試</button></div>`;
// 兌換地圖 without a map: every city, cheapest first, with its lowest price and a way into 航線查詢.
function rmapListHtml(dests) {
  const rows = [...dests].sort((a, b) => a.min - b.min || a.city.localeCompare(b.city, 'zh-Hant'));
  return `<p class="hint rmap-list-cap" id="rmap-list-cap">先用清單看：${fmt(rows.length)} 個城市，最低哩數由少到多</p>
    <div class="table-wrap rmap-list"><table class="need-table" aria-labelledby="rmap-list-cap">
    <thead><tr><th>城市</th><th>最低哩數</th><th>計畫</th><th><span class="sr-only">查座位</span></th></tr></thead><tbody>
    ${rows.map((d) => `<tr><td><b>${esc(d.city)}</b><small>${esc(d.tos.join('/'))}</small></td><td><b>${fmt(d.min)}</b> 哩</td><td><small>${esc(rmapProgramName(d.prices[0].id))}</small></td>
      <td><button type="button" class="linklike" data-rm-search="${esc(d.codes.join(','))}">到航線查詢</button></td></tr>`).join('')}
    </tbody></table></div>`;
}
// Map background: CARTO tiles; if they will not load (blocked network, an ad blocker, CARTO down), OpenStreetMap's own
// tiles; if those fail too, a plain outline of the continents shipped with the site (Natural Earth, public domain).
// CARTO now serves an "API KEY REQUIRED" watermark tile without a key, so it is no longer used.
const BASEMAPS = [
  () => ({ url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', cls: 'map-osm', attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }),
];
let landJson = null;
// Natural Earth closes a few shapes along ±180° (Chukotka, Fiji, Wrangel Island), which Leaflet draws as bands across
// the whole map: their bits just west of -160° move to the other side (+360°). Antarctica, round the pole, stays.
function landAcross(g) {
  for (const f of g.features || []) {
    const geo = f.geometry;
    const polys = geo?.type === 'Polygon' ? [geo.coordinates] : geo?.type === 'MultiPolygon' ? geo.coordinates : [];
    for (const ring of polys.flat()) {
      const xs = ring.map((p) => p[0]);
      if (Math.max(...xs) - Math.min(...xs) < 300 || Math.max(...ring.map((p) => p[1])) < -60) continue;
      for (const p of ring) if (p[0] < -160) p[0] += 360;
    }
  }
  return g;
}
function addBaseMap(map, i = 0) {
  const L = window.L;
  if (i >= BASEMAPS.length) {
    map.getContainer().classList.add('map-plain');
    (landJson ||= fetch('/land.json').then((r) => r.json()).then(landAcross)).then((g) => {
      if (!map.getContainer().isConnected) return;
      L.geoJSON(g, { interactive: false, style: { className: 'map-land', weight: 0.8, fillOpacity: 1 } }).addTo(map).bringToBack();
      // A map whose lines run past ±180° (環球票規劃) asks for the land again on those sides: map.options.landCopies.
      for (const off of map.options.landCopies || []) {
        L.geoJSON(g, { interactive: false, coordsToLatLng: (c) => L.latLng(c[1], c[0] + off), style: { className: 'map-land', weight: 0.8, fillOpacity: 1 } }).addTo(map).bringToBack();
      }
      map.attributionControl.addAttribution('Natural Earth');
    }).catch(() => { landJson = null; });
    return;
  }
  const b = BASEMAPS[i]();
  const layer = L.tileLayer(b.url, { maxZoom: 12, attribution: b.attribution }).addTo(map);
  if (b.cls) map.getContainer().classList.add(b.cls);
  let loaded = 0;
  let failed = 0;
  layer.on('tileload', () => { loaded++; });
  layer.on('tileerror', () => {
    if (loaded || ++failed < 4) return;
    map.removeLayer(layer);
    if (b.cls) map.getContainer().classList.remove(b.cls);
    addBaseMap(map, i + 1);
  });
}
// Leaflet measures its box only on window resizes, and a map in a hidden tab measures 0 × 0 and keeps that: re-measure
// when the tab is shown (tabShown) and whenever the box itself changes size while it is on screen.
function fitMap(map) {
  const el = map?.getContainer();
  if (el?.isConnected && el.clientWidth && el.clientHeight) map.invalidateSize();
}
function keepMapSized(map) {
  if (!window.ResizeObserver) return;
  const ro = new ResizeObserver(() => fitMap(map));
  ro.observe(map.getContainer());
  map.on('unload', () => ro.disconnect());
}
tabShown.map = () => syncRmap();
tabShown.explore = () => fitMap(exMap);
const isDark = () => document.documentElement.dataset.theme === 'dark' || (document.documentElement.dataset.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
let exMap = null;
async function renderExploreMap(rows) {
  const box = $('#ex-table');
  box.innerHTML = '<div id="ex-map" class="ex-map"><p class="hint">地圖載入中…</p></div><p class="hint">圓圈是目的地，數字是最低哩數（千哩）；點圓圈看細節。</p>';
  try {
    await loadLeaflet();
  } catch (err) {
    box.innerHTML = `${mapFailHtml(err)}<p class="hint">也可以改按上面的「表格」看同樣的結果。</p>`;
    $('[data-map-retry]', box).addEventListener('click', () => renderExploreMap(rows));
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
  addBaseMap(exMap);
  keepMapSized(exMap);
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
    m.bindPopup(`<b>${esc(g.code)} ${esc(airportCity(g.code))}</b><br>最低 <b>${fmt(g.min)}</b> 哩・${g.n} 筆<br>${mmdd(g.best.date)} ${esc(g.best.origin)} 出發・${carriersHtml(g.best.airlines)}
      <div class="map-actions"><button type="button" data-map-dest="${esc(g.code)}">只看這裡</button><button type="button" data-map-trip="${esc(g.best.id)}" data-title="${esc(titleOf(g.best))}">看最便宜航班</button></div>`, { autoPanPaddingTopLeft: L.point(52, 12) });
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
  // Booking progress and times (trips.js); left out when absent, so older plans and their sync ids stay the same.
  const day = (v) => str(v, /^\d{4}-\d{2}-\d{2}$/, 10);
  const hm = (v) => str(v, /^([01]\d|2[0-3]):[0-5]\d$/, 5);
  const extra = { status: ['held', 'waitlist', 'ticketed'].includes(x.status) ? x.status : null, holdUntil: day(x.holdUntil), ticketedOn: day(x.ticketedOn),
    backup: typeof x.backup === 'string' && x.backup.trim() ? x.backup.trim().slice(0, 40) : null, dep: hm(x.dep), arr: hm(x.arr), arrDays: [1, 2].includes(x.arrDays) ? x.arrDays : null,
    pnr: str(x.pnr, /^[A-Z0-9]{5,8}$/, 8), tk: str(x.tk, /^[a-z0-9]{4,8}$/, 8), via: str(x.via, /^[A-Z]{3}(,[A-Z]{3}){0,3}$/, 15) };
  for (const [k, v] of Object.entries(extra)) if (v) leg[k] = v;
  return leg.k && leg.date && leg.from && leg.to ? leg : null;
}
function cleanPlan(p) {
  const legs = Array.isArray(p?.legs) ? p.legs.map(cleanLeg).filter(Boolean).slice(0, MAX_LEGS) : [];
  // The dated reminders trips.js works out (保留到期、報到…), read by the daily mail run.
  const remind = (Array.isArray(p?.remind) ? p.remind : []).filter((n) => n && /^[\w:.-]{1,60}$/.test(n.key) && typeof n.name === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(n.date) && Array.isArray(n.steps))
    .slice(0, 30).map((n) => ({ key: n.key, name: n.name.slice(0, 80), date: n.date, steps: n.steps.filter((x) => Number.isInteger(x) && x >= 0 && x <= 400).slice(0, 4) }));
  return { name: typeof p?.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 40) : '我的行程', legs, ...(remind.length ? { remind } : {}) };
}
let plan = { name: '我的行程', legs: [] };
let sharedPlan = null;
function savePlan() { if (typeof tripRemindUpdate === 'function') tripRemindUpdate(plan); store.set(PLAN_KEY, plan); renderPlan(); }
function addLegs(legs) {
  const clean = legs.map(cleanLeg).filter(Boolean);
  if (plan.legs.length + clean.length > MAX_LEGS) { toast(`行程最多 ${MAX_LEGS} 段`); return; }
  plan.legs.push(...clean);
  plan.legs.sort((a, b) => (a.date + (a.dep || '')).localeCompare(b.date + (b.dep || '')));
  savePlan();
  // 查看 opens the plan, which lives under the 航線查詢 form (from 查現金票 it is on another tab).
  toast('已加入「我的行程」', { label: '查看', run: () => { showTab('search'); const el = $('#plan-panel'); el.hidden = false; el.open = true; requestAnimationFrame(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' })); } });
}
function awardLeg(t, pax) {
  const cabin = { economy: 'Y', premium: 'W', business: 'J', first: 'F' }[t.cabin] || 'J';
  // seats.aero times are local to each airport (written with a "Z" that isn't UTC).
  const dep = String(t.departsAt || '');
  const arr = String(t.arrivesAt || '');
  const arrDays = arr && dep ? Math.round((Date.parse(arr.slice(0, 10)) - Date.parse(dep.slice(0, 10))) / 864e5) : 0;
  return { k: 'a', date: dep.slice(0, 10), from: t.segments[0]?.from, to: t.segments.at(-1)?.to, flights: String(t.flightNumbers || '').toUpperCase().replace(/[^A-Z0-9 ,/·-]/g, '').slice(0, 60), cabin, pax: pax || 1, miles: t.miles, program: t.source, tax: t.taxes != null ? { amount: t.taxes / 100, cur: (t.taxesCurrency || '').toUpperCase().slice(0, 3) } : null,
    dep: dep.slice(11, 16), arr: arr.slice(11, 16), arrDays };
}
function cashLegs() {
  const r = cash.req;
  const { out, back } = cash.chosen;
  const fl = (o) => o.segments.map((s) => (s.flightNumber || '').toUpperCase()).join(' / ').replace(/[^A-Z0-9 ,/·-]/g, '').slice(0, 60);
  const total = (back || out).price;
  // Local times "YYYY-MM-DD HH:MM"; a round trip is one ticket (tk), so its two legs never count as a separate-ticket connection.
  const times = (o) => { const a = o.segments[0].from.time || ''; const b = o.segments.at(-1).to.time || ''; return { dep: a.slice(11, 16), arr: b.slice(11, 16), arrDays: a && b ? Math.round((Date.parse(b.slice(0, 10)) - Date.parse(a.slice(0, 10))) / 864e5) : 0 }; };
  const tk = back ? Math.random().toString(36).slice(2, 8) : undefined;
  const via = (o) => o.segments.slice(1).map((s) => s.from.code).join(',') || undefined; // connecting airports
  const legs = [{ k: 'c', date: r.depart, from: out.segments[0].from.code, to: out.segments.at(-1).to.code, flights: fl(out), cabin: r.cabin, pax: r.adults, price: total, note: back ? '來回總價' : '', ...times(out), tk, via: via(out) }];
  if (back) legs.push({ k: 'c', date: r.ret, from: back.segments[0].from.code, to: back.segments.at(-1).to.code, flights: fl(back), cabin: r.cabin, pax: r.adults, price: null, note: '含在去程票價', ...times(back), tk, via: via(back) });
  return legs;
}

// A tax amount as the trip dialog writes it: NT$ for Taiwan dollars, the currency code before other amounts.
const planMoney = (cur, n) => (cur === 'TWD' ? `NT$${fmt(Math.round(n))}` : `${esc(cur || '')} ${fmt(Math.round(n))}`.trim());
function planHtml(p, editable) {
  if (!p.legs.length) return '<p class="hint">還沒有航段。在航班明細按「＋ 加入我的行程」，或在查現金票選好航班後加入。可以把哩程票和現金票混搭，例如去程用哩程、回程買票。</p>';
  const milesBy = {};
  const taxBy = {};
  let cashTotal = 0;
  for (const l of p.legs) {
    if (l.k === 'a' && l.miles) milesBy[l.program] = (milesBy[l.program] || 0) + l.miles * l.pax;
    if (l.k === 'a' && l.tax) taxBy[l.tax.cur || '?'] = (taxBy[l.tax.cur || '?'] || 0) + l.tax.amount * l.pax;
    if (l.k === 'c' && l.price) cashTotal += l.price;
  }
  const trips = typeof tripRowHtml === 'function'; // trips.js: status, key dates, connection check
  const rows = p.legs.map((l, i) => `<tr>
    <td>${mmdd(l.date)}（${dowOf(l.date)}）${trips ? tripPill(l, i, editable) : ''}</td><td><b>${esc(l.from)} → ${esc(l.to)}</b><small>${esc(l.flights)}${trips ? tpTime(l) : ''}</small></td><td>${CABIN_LABEL[l.cabin]}${l.pax > 1 ? `・${l.pax} 人` : ''}</td>
    <td>${l.k === 'a' ? `<b>${fmt(l.miles * l.pax)} 哩</b><small>${esc(programName(l.program))}${l.tax ? `・稅 ${planMoney(l.tax.cur, l.tax.amount * l.pax)}` : ''}</small>${editable && typeof bookedToggleHtml === 'function' ? bookedToggleHtml(l, i) : ''}` : l.price ? `<b>NT$${fmt(l.price)}</b><small>現金票${l.note ? `・${esc(l.note)}` : ''}</small>` : `<small>現金票・${esc(l.note)}</small>`}</td>
    ${editable ? `<td><button type="button" class="linklike" data-leg-rm="${i}" aria-label="移除這段">✕</button></td>` : ''}</tr>${trips ? tripRowHtml(p, i, editable) : ''}`).join('');
  const sum = [
    ...Object.entries(milesBy).map(([k, v]) => `${esc(programName(k))} <b>${fmt(v)} 哩</b>`),
    ...Object.entries(taxBy).map(([c, v]) => `稅金 ${c === 'TWD' ? `<b>${planMoney(c, v)}</b>` : `${esc(c === '?' ? '' : c)} <b>${fmt(Math.round(v))}</b>`}`),
    cashTotal ? `現金票 <b>NT$${fmt(cashTotal)}</b>` : '',
  ].filter(Boolean).join('　');
  return `<div class="table-wrap"><table class="plan-table"><tbody>${rows}</tbody></table></div><p class="plan-sum">合計：${sum}</p>${editable ? `<div class="plan-extras">${typeof bookedFootHtml === 'function' ? bookedFootHtml() : ''}${typeof tripPlanExtras === 'function' ? tripPlanExtras(p) : ''}</div>` : ''}`;
}
function renderPlan() {
  const body = $('#plan-body');
  if (!body) return;
  // An empty 我的行程 stays out of the way until a leg is added (the account menu can still open it).
  const panel = $('#plan-panel');
  if (panel) panel.hidden = !plan.legs.length && !sharedPlan && !panel.open;
  $('#plan-count').textContent = plan.legs.length ? `（${plan.legs.length} 段）` : '';
  body.innerHTML = `${sharedPlan ? `<div class="plan-shared"><b>朋友分享的行程：${esc(sharedPlan.name)}</b>${planHtml(sharedPlan, false)}
      <div class="plan-actions"><button type="button" class="primary small" id="plan-import">存成我的行程</button><button type="button" class="outline" id="plan-dismiss">不用了</button></div></div>` : ''}
    <label class="field plan-name">行程名稱<input id="plan-name" maxlength="40" value="${esc(plan.name)}"></label>
    ${planHtml(plan, true)}
    ${plan.legs.length ? `<div class="plan-actions"><button type="button" class="outline" id="plan-share">🔗 複製行程連結</button>${typeof tripActionsHtml === 'function' ? tripActionsHtml(plan) : ''}<button type="button" class="outline" id="plan-clear">清空</button></div>`
    : typeof tripActionsHtml === 'function' && tripActionsHtml(plan) ? `<div class="plan-actions">${tripActionsHtml(plan)}</div>` : ''}
    ${typeof tpPasteHtml === 'function' ? tpPasteHtml() : ''}`;
  $('#plan-name').addEventListener('change', (e) => { plan.name = e.target.value.trim().slice(0, 40) || '我的行程'; store.set(PLAN_KEY, plan); });
  if (typeof bookedBind === 'function') bookedBind(body); // 已開票，便宜了通知我 (notify.js)
  $$('[data-leg-rm]', body).forEach((b) => b.addEventListener('click', () => { plan.legs.splice(Number(b.dataset.legRm), 1); if (typeof tp === 'object') tp.edit = -1; savePlan(); }));
  $('#plan-clear')?.addEventListener('click', () => { if (confirm('清空我的行程？')) { plan.legs = []; savePlan(); } });
  $('#plan-share')?.addEventListener('click', async () => {
    // Booking references and reminders stay on this device; the friend gets the flights and their status.
    const json = JSON.stringify({ name: plan.name, legs: plan.legs.map(({ pnr, ...l }) => l) });
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const url = `${location.origin}/?plan=${b64}#search`;
    try { await navigator.clipboard.writeText(url); toast('已複製行程連結'); } catch { prompt('複製這個連結：', url); }
  });
  $('#plan-import')?.addEventListener('click', () => { plan = sharedPlan; sharedPlan = null; savePlan(); toast('已存成我的行程'); });
  $('#plan-dismiss')?.addEventListener('click', () => { sharedPlan = null; renderPlan(); });
  if (typeof fstBind === 'function') fstBind(body); // 查航班動態／這班過去準點率 (flightstatus.js)
  else if ($('#plan-panel')?.open && $('.plan-table tr', body)) loadScripts(['flightstatus']); // binds #plan-body when it arrives
  planFold(body);
}
// 我的行程's extras (航班動態的用量, 已開票追蹤, 護照, 提醒, and points6.js's 兌換紀錄) sit under one 「更多」 fold at the
// end, so the legs, the total and the buttons read first. A passport that is not valid long enough stays in view.
let planMoreOpen = false;
const PLAN_MORE_PARTS = [['.bk-foot', '已開票追蹤'], ['.tp-pp', '護照'], ['[data-tp-remind], .tp-remind-form, .tp-tip', '提醒'], ['.p6-ledger-plan', '兌換紀錄']];
function planMoreHost(body) {
  let d = $('#plan-more', body);
  if (!d) {
    body.insertAdjacentHTML('beforeend', `<details class="plan-more" id="plan-more"${planMoreOpen ? ' open' : ''}><summary>更多</summary><div class="plan-more-body"></div></details>`);
    d = $('#plan-more', body);
    d.addEventListener('toggle', () => { planMoreOpen = d.open; });
  }
  // Named after what is inside once the caller has put its part in.
  queueMicrotask(() => {
    const parts = PLAN_MORE_PARTS.filter(([sel]) => $(sel, d)).map(([, name]) => name);
    $('summary', d).textContent = parts.length ? `更多：${parts.join('、')}` : '更多';
  });
  return $('.plan-more-body', d);
}
function planFold(body) {
  const extras = $('.plan-extras', body);
  const items = [$('.fst-note', body), ...(extras ? [...extras.children] : [])].filter((e) => e && !e.matches('.tp-pp.bad'));
  if (items.length) planMoreHost(body).append(...items);
  if (extras && !extras.children.length) extras.remove();
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
// Cabin products are a third-party summary (products.json confidence): the pill carries a small * and a tooltip, and
// one line under the flights explains it (PROD_3P_NOTE).
const PROD_3P_TITLE = '第三方整理，機型與座椅可能更換';
const PROD_3P_NOTE = '* 艙位產品依機型推測，為第三方整理，座椅可能更換';
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
  loadFx().catch(() => {});
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
    <div class="hint watch-note">價格比現在低就通知你；越接近出發查得越勤，每月最多 30 次，開始追蹤不另外花額度。<details class="info-i"><summary aria-label="怎麼查、用哪個額度">ⓘ</summary><p>出發前 60 天以上每週查 1 次、15 到 60 天每 3 天查 1 次、最後 14 天每天查。所有追蹤每月合計最多用 30 次查價，用的是 RapidAPI 的額度，SerpApi 留給你自己查；RapidAPI 出錯時才借用 SerpApi，SerpApi 剩不到 150 次就不借。</p></details></div>
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
        const body = await cashApi('/api/watch', { pass: '降價追蹤', method: 'POST', headers: { 'content-type': 'application/json' },
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
  if (passNeeded()) {
    box.innerHTML = lockNoteHtml('降價追蹤');
    $('[data-unlock]', box).addEventListener('click', () => unlockFor('降價追蹤', loadWatches));
    return;
  }
  box.innerHTML = '<p class="hint">載入中…</p>';
  try {
    const body = await cashApi('/api/watch', { pass: '降價追蹤' });
    const list = body.watches || [];
    $('#watch-count').textContent = list.length ? `（${list.length}）` : '';
    box.innerHTML = list.length ? `<ul class="alert-list">${list.map((w) => {
      const diff = w.lastPrice && w.startPrice ? w.lastPrice - w.startPrice : 0;
      return `<li>
        <div><b>${esc(watchSummary(w))}</b>${w.email ? `<small>→ ${esc(w.email)}</small>` : '<small>只在網站顯示</small>'}</div>
        <div class="hint">${w.flights ? `追蹤 ${esc(w.flights.replace(/\+/g, '、'))}` : '追蹤最便宜票價'}・${w.everyDays === 1 ? '每天' : `每 ${w.everyDays} 天`}查一次${w.paused ? `・<b class="warn">${w.paused === 'cap' ? '本月追蹤額度用完，下個月繼續' : 'SerpApi 額度快用完，暫停中'}</b>` : ''}：現在 <b>${money(w.lastPrice)}</b>${diff ? `（比開始時${diff < 0 ? `<b class="new">便宜 NT$${fmt(-diff)}</b>` : `貴 NT$${fmt(diff)}`}）` : ''}${w.lastLowest && w.lastLowest < (w.lastPrice || Infinity) ? `；同天最低 ${money(w.lastLowest)}` : ''}${w.pickedGone ? '；原航班已查不到，改看最低價' : ''}　${w.lastRun ? `${ago(w.lastRun)}檢查` : ''}${w.lastError ? `　⚠ ${esc(w.lastError)}` : ''}</div>
        <div class="alert-actions">${sparkline((w.history || []).map(([d, p]) => [d, p]))}<button type="button" class="outline" data-wdel="${esc(w.id)}">停止追蹤</button></div>
      </li>`;
    }).join('')}</ul><p class="hint">本月追蹤已用 ${body.used || 0} / ${body.cap} 次查價額度。</p>` : '<p class="hint">還沒有追蹤。在查現金票選好航班後，按「📉 追蹤降價」。</p>';
    if (typeof notifyLineHtml === 'function') box.insertAdjacentHTML('beforeend', notifyLineHtml()); // 通知狀態 (notify.js)
    $$('[data-wdel]', box).forEach((b) => b.addEventListener('click', async () => {
      try { await cashApi(`/api/watch?id=${encodeURIComponent(b.dataset.wdel)}`, { pass: '降價追蹤', method: 'DELETE' }); toast('已停止追蹤'); loadWatches(); } catch (err) { toast(err.message); }
    }));
  } catch (err) {
    box.innerHTML = `<p class="status error">${esc(err.message)}</p>`;
  }
}

function initFeatures() {
  wallet = loadWallet();
  cashSeen = loadCashSeen();
  if (Object.keys(cashSeen).length) loadFx().catch(() => {});
  $('#watch-panel')?.addEventListener('toggle', loadWatches);
  plan = cleanPlan(store.get(PLAN_KEY, null));
  readSharedPlan();
  renderPlan();
  if (sharedPlan) { $('#plan-panel').open = true; }
  loadDeals();
}
