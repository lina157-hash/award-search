// 點數與錢包, round 6: last safe transfer day, 「我已登記」 and new-promo notices for transfer bonuses (N4), family totals
// that follow each program's pooling rule (N17), the wallet's NT$ value and a voucher list (N19), the redemption ledger
// with a yearly review (N22), what expiring miles can still buy (N23), and the calculator's rate dates (U9/U10) and
// one-line-per-bank phone layout (U11). Classic script loaded after hotels.js, sharing the globals of app.js,
// features.js, award-tools.js and ewallet.js; account.js (loaded after) syncs its keys. None of it calls a paid API.
// The pure helpers come first; the server (lib/expiry.js, lib/promowatch.js) and the tests load them with require().

// ---------- pure helpers ----------
const P6_DAY = 864e5;
const p6Iso = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && Number.isFinite(Date.parse(`${s}T00:00:00Z`));
const p6Days = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / P6_DAY);
const p6AddDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * P6_DAY).toISOString().slice(0, 10);
const p6Min = (...dates) => dates.filter(p6Iso).sort()[0] || null;
// The server and the tests get the hold/transfer-time helper from award-tools.js; the browser already has it.
const p6Tools = typeof module === 'object' && module.exports ? require('./award-tools.js') : null;
// award-tools.js loads after the page (app.js loadTools); before it is in, the time is unknown (待確認).
const p6TimeFor = (holds, source, rate) => {
  const fn = p6Tools ? p6Tools.transferTimeFor : typeof transferTimeFor === 'function' ? transferTimeFor : null;
  return fn ? fn(holds, source, rate) : null;
};

// Program key → the calculator column ({ to }) or other-airline name ({ name }) its bank rates use. The same as
// features.js PROGRAM_TRANSFER plus ANA (a test keeps them equal), here so the server can match banks too.
const P6_TRANSFER = {
  asiamiles: { to: 'asiamiles' }, singapore: { to: 'sq' }, eva: { to: 'eva' }, ci: { to: 'ci' },
  aeroplan: { name: '加航' }, flyingblue: { name: '法荷航' }, united: { name: '聯合' }, qatar: { name: '卡達' },
  british: { name: '英航' }, turkish: { name: '土航' }, qantas: { name: '澳航' }, emirates: { name: '阿聯酋' },
  etihad: { name: '阿提哈德' }, lifemiles: { name: 'LifeMiles' }, jal: { name: '日航' }, ana: { name: '全日空' },
};
const P6_PROGRAM_KEY = { asiamiles_est: 'asiamiles', jal_partner: 'jal' };
const p6ColOf = (program) => P6_TRANSFER[program]?.to || program;

// U10: a rate past its validUntil (the rate's own date, else its bank's) is no longer guaranteed.
function p6RateExpired(source, rate, today) {
  const d = rate?.validUntil || source?.validUntil;
  return p6Iso(d) && d < today;
}
// The best rate still in date from one bank points program into a program key, or null.
function p6RateInto(source, program, today) {
  const m = P6_TRANSFER[P6_PROGRAM_KEY[program] || program];
  if (!m) return null;
  const rates = (source?.rates || []).filter((r) => (m.to ? r.to === m.to : r.to === 'other' && r.name === m.name) && !p6RateExpired(source, r, today));
  return rates.length ? rates.reduce((a, b) => (b.miles / b.points > a.miles / a.points ? b : a)) : null;
}
// A bank-wide offer (bank null) covers every bank except the ones it names (as features.js transferBonus).
const p6BankIn = (promo, bank) => (promo.bank ? promo.bank === bank : !(promo.excludeBanks || []).includes(bank));
const p6Active = (p, today) => Boolean(p?.start && p.end && p.start <= today && today <= p.end);

// ---------- N4: transfer bonuses ----------
// The last day to start a transfer that still counts: the promo's crediting deadline (creditBy) minus the bank's
// slowest transfer time (holds.json), never after the promo's last day. Without creditBy the transfer only has to be
// made by the last day. { date, slow, known, byEnd }; date null when the bank's transfer time is unknown.
function safeTransferDate(promo, time) {
  if (!promo?.end) return { date: null, slow: null, known: false };
  const slow = time ? (time.instant ? 0 : time.days[1]) : null;
  if (!p6Iso(promo.creditBy)) return { date: promo.end, slow, known: true, byEnd: true };
  if (slow == null) return { date: null, slow: null, known: false };
  return { date: p6Min(promo.end, p6AddDays(promo.creditBy, -slow)), slow, known: true, byEnd: false };
}
// One active transfer promo × the given bank programs: every one that can take part, with its last safe day,
// soonest first ({ source, rate, time, date, slow, known, byEnd, days }).
function promoDeadlines(promo, sources, holds, today) {
  if (promo?.type !== 'transfer' || !p6Active(promo, today)) return [];
  const out = [];
  for (const s of sources || []) {
    if (!p6BankIn(promo, s.bank)) continue;
    const rate = p6RateInto(s, promo.program, today);
    if (!rate) continue;
    const time = p6TimeFor(holds, s, rate);
    const safe = safeTransferDate(promo, time);
    out.push({ source: s, rate, time, ...safe, days: safe.date ? p6Days(today, safe.date) : null });
  }
  return out.sort((a, b) => String(a.date || '9').localeCompare(String(b.date || '9')));
}
// Does a promo touch this wallet? A transfer bonus when one of its banks can take part, a buy-miles sale when it
// holds miles in that program, an award sale (哩程票特惠) when it holds those miles or a bank that transfers in.
function promoTouches(promo, sources, programs, today) {
  const holds = (programs || []).includes(P6_PROGRAM_KEY[promo.program] || promo.program);
  if (promo.type === 'buy') return holds;
  return (promo.type === 'award' && holds) || (sources || []).some((s) => p6BankIn(promo, s.bank) && p6RateInto(s, promo.program, today));
}
// N4a: running promos that touch the wallet and were not announced yet (seen: ids already announced or there before).
function newPromos(promos, sources, programs, seen, today) {
  const old = new Set(seen || []);
  return (promos || []).filter((p) => p?.id && !old.has(p.id) && p6Active(p, today) && promoTouches(p, sources, programs, today));
}
// N4b: ended transfer bonuses from this bank into one calculator column during the last 12 months.
const p6Pct = (p) => (p.bonusPct > 0 ? p.bonusPct : p.bonusPer ? (p.bonusPer[1] / p.bonusPer[0]) * 100 : 0);
function promoHistoryStats(list, source, col, today) {
  const from = p6AddDays(today, -365);
  const seen = new Set();
  const hits = (list || []).filter((p) => p?.type === 'transfer' && p.end < today && p.end >= from && p6ColOf(p.program) === col
    && p6BankIn(p, source.bank) && !seen.has(p.id) && seen.add(p.id));
  const pct = hits.map(p6Pct).filter((x) => x > 0);
  return { count: hits.length, maxPct: pct.length ? Math.round(Math.max(...pct) * 10) / 10 : 0, last: hits.map((p) => p.end).sort().at(-1) || null };
}
// N4d: one reminder per promo that needs registering, that the wallet's banks can join and that is not ticked
// 已登記: dated on the earliest last safe day still ahead (or the last day to register, if earlier).
function regReminders(w, today, { promos = [], sources = [], holds = null } = {}) {
  const banks = Array.isArray(w?.banks) ? w.banks : Object.keys(w?.banks || {});
  const mine = sources.filter((s) => banks.includes(s.id));
  const reg = w?.reg || {};
  const out = [];
  for (const p of promos) {
    if (p.registration !== true || reg[p.id] || !p6Active(p, today)) continue;
    const rows = promoDeadlines(p, mine, holds, today).filter((r) => r.date && r.date >= today);
    if (!rows.length) continue;
    const date = p6Min(rows[0].date, p.registerBy);
    out.push({ key: `reg:${p.id}`, kind: 'reg', name: p.title, date, days: p6Days(today, date), banks: [...new Set(rows.filter((r) => r.date === rows[0].date).map((r) => r.source.bank))], url: p.sources?.[0]?.url || '' });
  }
  return out;
}

// ---------- N17: family totals ----------
// A program's family rule (programs.json). Only an officially sourced pool or transfer rule adds balances up;
// everything else is counted person by person (each can still book with their own miles).
function poolRule(rec) {
  const type = ['pool', 'transfer', 'nominee', 'none'].includes(rec?.poolType) ? rec.poolType : null;
  const official = rec?.poolOfficial === true;
  return { type, max: rec?.poolMax || null, min: rec?.poolMin || 0, step: rec?.poolStep || 0, official, combine: official && (type === 'pool' || type === 'transfer') };
}
// people: [{ name, miles }], each person's miles in this program (own balance plus their own bank points moved in:
// bank points can only go to the cardholder's account). usable: the most one account can pay with; seats(n): how
// many tickets of n miles the household can book.
function householdPool(people, rule) {
  const list = (people || []).filter((p) => p.miles > 0).sort((a, b) => b.miles - a.miles);
  const total = list.reduce((n, p) => n + p.miles, 0);
  const each = (arr, n) => arr.reduce((k, p) => k + Math.floor(p.miles / n), 0);
  if (!rule?.combine || list.length < 2) return { combine: Boolean(rule?.combine), total, usable: list[0]?.miles || 0, people: list, seats: (n) => (n > 0 ? each(list, n) : 0) };
  if (rule.type === 'pool') {
    // A family account holds at most `max` people; the biggest balances join it, the rest book on their own.
    const inside = rule.max ? list.slice(0, rule.max) : list;
    const rest = list.slice(inside.length);
    const usable = inside.reduce((n, p) => n + p.miles, 0);
    return { combine: true, total, usable, people: list, left: rest, seats: (n) => (n > 0 ? Math.floor(usable / n) + each(rest, n) : 0) };
  }
  // transfer: everyone else moves what the minimum and the unit allow into the biggest account.
  const move = (m) => { const x = rule.step ? Math.floor(m / rule.step) * rule.step : m; return x >= (rule.min || 0) ? x : 0; };
  const [head, ...others] = list;
  const usable = head.miles + others.reduce((n, p) => n + move(p.miles), 0);
  return { combine: true, total, usable, people: list, seats: (n) => (n > 0 ? Math.floor(usable / n) : 0) };
}

// ---------- N19: what the wallet is worth ----------
// Miles at the cost per mile, bank points through their best airline transfer, hotel points at the usual value per
// point; balances with no value (no airline transfer, no hotel estimate) are listed in `skipped`.
function walletValue(w, { perMile, bankMiles, hotelTwd }) {
  let air = 0;
  let bank = 0;
  let hotel = 0;
  const skipped = [];
  for (const [k, n] of Object.entries(w?.miles || {})) air += n * perMile(k);
  for (const [id, n] of Object.entries(w?.banks || {})) { const b = bankMiles(id, n); if (b?.miles) bank += b.miles * perMile(b.program); else skipped.push(id); }
  for (const [k, n] of Object.entries(w?.hotels || {})) { const v = hotelTwd(k); if (v) hotel += n * v; else skipped.push(k); }
  return { air: Math.round(air), bank: Math.round(bank), hotel: Math.round(hotel), total: Math.round(air + bank + hotel), skipped };
}

// ---------- N22: redemption ledger ----------
const ledgerId = (l) => [l.date, l.from, l.to, l.flights || '', P6_PROGRAM_KEY[l.program] || l.program || '', l.cabin].join('|');
// A 我的行程 award leg as a ledger entry, with the same day's cash fare when this browser already saw it (never looked up).
function ledgerFromLeg(leg, today, cashSeen = {}) {
  const pax = leg.pax || 1;
  const seen = cashSeen?.[`${leg.from}-${leg.to}|${leg.date}|${leg.cabin}`];
  return {
    id: ledgerId(leg), at: today, date: leg.date, from: leg.from, to: leg.to, flights: leg.flights || '', cabin: leg.cabin, pax,
    program: P6_PROGRAM_KEY[leg.program] || leg.program || '', miles: Math.round((leg.miles || 0) * pax),
    tax: leg.tax ? { amount: Math.round(leg.tax.amount * pax * 100) / 100, cur: leg.tax.cur || '' } : null,
    cash: seen?.price > 0 ? Math.round(seen.price * pax) : null,
  };
}
// Per year of ticketing: miles per program, taxes in NT$ (unknown currencies counted apart), the cash fares the
// awards replaced, and what a mile actually saved — (cash − taxes) ÷ miles over entries with a cash fare and known
// taxes — next to the cost per mile of those same miles. Newest year first.
function ledgerSummary(entries, { rates = {}, perMile = () => 0.5 } = {}) {
  const years = new Map();
  for (const e of entries || []) {
    const year = String(e.at || e.date || '').slice(0, 4);
    if (!/^\d{4}$/.test(year) || !(e.miles > 0)) continue;
    const s = years.get(year) || { year, count: 0, miles: 0, byProgram: {}, tax: 0, taxUnknown: 0, cash: 0, cashMiles: 0, cashNet: 0, cost: 0, costAll: 0 };
    s.count++;
    s.miles += e.miles;
    s.byProgram[e.program] = (s.byProgram[e.program] || 0) + e.miles;
    s.costAll += e.miles * perMile(e.program);
    const cur = String(e.tax?.cur || '').toUpperCase();
    const rate = !e.tax ? 0 : cur === 'TWD' ? 1 : rates[cur] || 0;
    const tax = !e.tax ? 0 : rate ? e.tax.amount * rate : null;
    if (tax == null) s.taxUnknown++; else s.tax += tax;
    if (e.cash > 0 && tax != null) { s.cash += e.cash; s.cashMiles += e.miles; s.cashNet += e.cash - tax; s.cost += e.miles * perMile(e.program); }
    years.set(year, s);
  }
  return [...years.values()].sort((a, b) => b.year.localeCompare(a.year)).map((s) => ({
    year: s.year, count: s.count, miles: s.miles, byProgram: s.byProgram, tax: Math.round(s.tax), taxUnknown: s.taxUnknown, cash: Math.round(s.cash), cashMiles: s.cashMiles,
    perMile: s.cashMiles ? Math.round((s.cashNet / s.cashMiles) * 100) / 100 : null,
    costPerMile: Math.round(((s.cashMiles ? s.cost / s.cashMiles : s.costAll / s.miles) || 0) * 100) / 100,
  }));
}

// ---------- synced data: cleaning and merging ----------
const P6_SYNC = { family: 'walletFamily:v1', vouchers: 'walletVouchers:v1', reg: 'promoReg:v1', ledger: 'awardLedger:v1', tips: 'expiryTips:v1' };
const P6_SYNC_KEYS = Object.values(P6_SYNC);
const P6_VOUCHER_KINDS = { upgrade: ['⬆️', '升等券'], stay: ['🏨', '住宿券'], lounge: ['🛋️', '貴賓室'], transfer: ['🚗', '機場接送'], other: ['🎫', '其他'] };
const p6IdOk = (v) => typeof v === 'string' && /^[\w-]{1,40}$/.test(v);
const p6Obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const p6Counts = (o) => Object.fromEntries(Object.entries(p6Obj(o)).map(([k, v]) => [k, Math.floor(Number(v))])
  .filter(([k, v]) => p6IdOk(k) && Number.isFinite(v) && v > 0).slice(0, 40).map(([k, v]) => [k, Math.min(v, 1e9)]));
function cleanVouchers(v) {
  return (Array.isArray(v) ? v : []).map((x) => (x && typeof x === 'object' && /^[\w-]{1,24}$/.test(x.id) ? {
    id: x.id,
    kind: P6_VOUCHER_KINDS[x.kind] ? x.kind : 'other',
    name: typeof x.name === 'string' ? x.name.trim().slice(0, 40) : '',
    count: Number(x.count) > 0 ? Math.min(999, Math.floor(Number(x.count))) : null,
    expires: p6Iso(x.expires) ? x.expires : null,
  } : null)).filter(Boolean).slice(0, 40);
}
function cleanFamily(f) {
  const members = (Array.isArray(f?.members) ? f.members : []).map((m) => (m && typeof m === 'object' && /^[\w-]{1,24}$/.test(m.id)
    ? { id: m.id, name: String(m.name || '').trim().slice(0, 12) || '家人', miles: p6Counts(m.miles), banks: p6Counts(m.banks) } : null)).filter(Boolean).slice(0, 8);
  return { members };
}
const cleanReg = (o) => Object.fromEntries(Object.entries(p6Obj(o)).filter(([k, v]) => p6IdOk(k) && v === true).slice(0, 60));
function cleanLedger(v) {
  const str = (s, re) => (typeof s === 'string' && re.test(s) ? s : '');
  const num = (n) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 && n < 1e9 ? n : null);
  return (Array.isArray(v) ? v : []).map((e) => {
    if (!e || typeof e !== 'object' || typeof e.id !== 'string' || e.id.length > 120) return null;
    const x = {
      id: e.id, at: str(e.at, /^\d{4}-\d{2}-\d{2}$/), date: str(e.date, /^\d{4}-\d{2}-\d{2}$/), from: str(e.from, /^[A-Z]{3}$/), to: str(e.to, /^[A-Z]{3}$/),
      flights: str(e.flights, /^[A-Z0-9 ,/·-]{0,60}$/), cabin: str(e.cabin, /^[YWJF]$/) || 'Y', pax: Math.min(9, Math.max(1, Math.floor(num(e.pax) || 1))),
      program: str(e.program, /^[a-z_]{1,30}$/), miles: Math.round(num(e.miles) || 0),
      tax: e.tax && num(e.tax.amount) != null ? { amount: e.tax.amount, cur: str(e.tax.cur, /^[A-Z]{0,3}$/) } : null,
      cash: num(e.cash) || null,
    };
    return x.at && x.from && x.to && x.miles > 0 ? x : null;
  }).filter(Boolean).slice(-200);
}
// The cheapest awards a balance can still buy (N23), kept per program so the reminder mail can list them.
function cleanTips(o) {
  const out = {};
  for (const [k, t] of Object.entries(p6Obj(o)).slice(0, 40)) {
    if (!p6IdOk(k)) continue;
    const awards = (Array.isArray(t?.awards) ? t.awards : []).filter((a) => /^[A-Z]{3}$/.test(a?.to) && /^[YWJF]$/.test(a.cabin) && a.miles > 0 && a.miles < 1e7)
      .slice(0, 3).map((a) => ({ to: a.to, toName: String(a.toName || '').slice(0, 20), cabin: a.cabin, miles: Math.round(a.miles) }));
    if (awards.length) out[k] = { awards };
  }
  return out;
}
// Account sync (account.js MERGE) for lists of records with an id: with a base, a record removed on either side stays
// removed and the side that changed a record wins; without one, the account's copy wins and the device adds the rest.
const p6Stable = (v) => (Array.isArray(v) ? `[${v.map(p6Stable).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${p6Stable(v[k])}`).join(',')}}` : JSON.stringify(v ?? null));
function p6MergeList(l, r, b, hasBase, max = 200) {
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object' && typeof x.id === 'string') : []);
  const [L, R, B] = [l, r, b].map((x) => new Map(arr(x).map((y) => [y.id, y])));
  const out = [];
  for (const id of new Set([...R.keys(), ...L.keys()])) {
    const x = L.get(id);
    const y = R.get(id);
    const z = B.get(id);
    if (hasBase && z && (!x || !y)) continue;
    out.push(!x ? y : !y ? x : hasBase && z && p6Stable(x) !== p6Stable(z) ? x : y);
  }
  return out.slice(-max);
}
// Per key, like the wallet's balances: the side that changed it since the base, else the account's value.
function p6MergeMap(l, r, b, hasBase) {
  const [L, R, B] = [l, r, b].map(p6Obj);
  const out = {};
  for (const k of new Set([...Object.keys(L), ...Object.keys(R), ...Object.keys(B)])) {
    const v = hasBase ? (L[k] !== B[k] ? L[k] : R[k]) : R[k] ?? L[k];
    if (v) out[k] = v;
  }
  return out;
}
const P6_MERGE = {
  'walletFamily:v1': (l, r, b, hasBase) => ({ members: p6MergeList(l?.members, r?.members, b?.members, hasBase, 8) }),
  'walletVouchers:v1': (l, r, b, hasBase) => p6MergeList(l, r, b, hasBase, 40),
  'awardLedger:v1': (l, r, b, hasBase) => p6MergeList(l, r, b, hasBase, 200),
  'promoReg:v1': p6MergeMap,
};


// ---------- browser: shared bits ----------
const p6Today = () => isoDate(0);
// ewallet.js and award-tools.js load after the page (app.js loadTools): 我的行程 can draw before they are in.
const p6Md = (iso) => (typeof ewYmd === 'function' ? ewYmd(iso, p6Today()) : mmdd(iso));
const p6Left = (days) => (typeof ewLeft === 'function' ? ewLeft(days) : `還剩 ${days} 天`);
const p6Load = {
  family: () => cleanFamily(store.get(P6_SYNC.family, null)),
  vouchers: () => cleanVouchers(store.get(P6_SYNC.vouchers, [])),
  reg: () => cleanReg(store.get(P6_SYNC.reg, {})),
  ledger: () => cleanLedger(store.get(P6_SYNC.ledger, [])),
};
function p6Put(key, value, empty) {
  if (empty) store.del(key); else store.set(key, value);
  p6MaybeResync();
}
const p6NewId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const p6WalletSources = () => walletSources().filter((s) => wallet.banks[s.id]);
const p6PerMile = (k) => (typeof perMileOf === 'function' ? perMileOf(data.milecost, typeof costOverrides === 'function' ? costOverrides() : {}, k) : null);
// <details> the user opened stay open when the wallet redraws (it redraws on every number typed).
const p6Opened = new Set();
const p6OpenAttr = (k) => (p6Opened.has(k) ? ' open' : '');
let p6FxAsked = false;
const p6NeedFx = () => { if (!fxCache && !p6FxAsked) { p6FxAsked = true; loadFx().then(() => renderWallet6(true)).catch(() => {}); } };
const P6_PROG_ID = { eva: 'evainfinity', ci: 'dynastyflyer' };
const p6ProgramRec = (key) => data.programs?.programs?.find((p) => p.id === (P6_PROG_ID[programKeyOf(key)] || programKeyOf(key))) || null;

// ---------- 點數換算: rate dates (U10), bonus history (N4b), one line per bank on phones (U11) ----------
const calcRateExpired = (s, r) => p6RateExpired(s, r, p6Today());
// Ended promos: the history file plus any that ended but are still listed in promos.json.
const p6PromoHistory = () => [...(data.promoHistory?.promos || []), ...(data.promos?.promos || [])];
function promoHistoryLine(s, col) {
  const h = promoHistoryStats(p6PromoHistory(), s, col, p6Today());
  return h.count ? `<small class="hist6" title="最近一次到 ${esc(h.last)}">過去 12 個月加贈 ${h.count} 次${h.maxPct ? `、最高 +${h.maxPct}%` : ''}</small>` : '';
}
const p6Phone = () => typeof matchMedia === 'function' && matchMedia('(max-width: 600px)').matches;
// On phones the converter starts with the banks in 我的點數; a bank the user picks in the menu stays.
function calcBankDefault(state) {
  const mine = Object.keys(wallet.banks).length > 0;
  if (!state.bankPicked && mine && p6Phone() && !state.bank) state.bank = '__mine';
  if (state.bank === '__mine' && !mine) state.bank = '';
}
const p6CalcOpen = new Set();
const calcRowOpen = (id) => p6CalcOpen.has(id);
// The row's best result in one line; phones show only this until the row is tapped.
function calcRowSummaryHtml(best, id) {
  const what = best ? `<span>${best.m2p ? '最省' : '最多'}：${esc(best.label)} <b>${best.m2p ? '需 ' : ''}${fmt(best.value)} ${esc(best.unit)}</b></span>` : '<span>看各計畫</span>';
  return `<button type="button" class="calc-sum6" data-calc-row="${esc(id)}" aria-expanded="${calcRowOpen(id)}">${what}<i aria-hidden="true">▾</i></button>`;
}

// ---------- N4: last safe transfer day, 我已登記, new-promo notices ----------
// One line per bank: a bank's several point programs share one transfer time.
function p6DeadlineRows(p) {
  const seen = new Set();
  return promoDeadlines(p, p6WalletSources(), data.holds, p6Today()).filter((r) => { const k = `${r.source.bank}|${r.date}`; return !seen.has(k) && seen.add(k); });
}
function p6DeadlineLi(p, r) {
  const t = r.time;
  const bank = esc(r.source.bank);
  const credit = p.creditBy ? `${p6Md(p.creditBy)} 前入帳才算` : '';
  const how = t ? (t.instant ? '可即時入帳' : `入帳${/^\d/.test(t.text) ? ' ' : ''}${esc(t.text)}`) : '';
  const verify = t && t.confidence !== 'official' ? '・入帳天數待確認' : '';
  if (!r.known) return `<li><span><b>${bank}</b> 入帳時間不明，越早轉越好</span><small>${credit}</small></li>`;
  if (r.days < 0) return `<li class="late"><span><b>${bank}</b> 已來不及</span><small>${how}${credit ? `，${credit}` : ''}${verify}</small></li>`;
  return `<li><span><b>${bank}</b> 最晚 ${p6Md(r.date)} 轉 <span class="tag until${r.days <= 7 ? ' soon' : ''}">${p6Left(r.days)}</span></span><small>${r.byEnd ? '活動期間內轉出即可' : `${how}，${credit}${verify}`}</small></li>`;
}
// Where the 3-day reminder goes, or '' when this device has none set up.
function p6RemindWho() {
  if (typeof signedIn === 'function' && signedIn()) return acct.emailEnabled ? '會寄 Email 提醒你' : '';
  return typeof EXP_REMIND_KEY !== 'undefined' && store.get(EXP_REMIND_KEY, null) ? '會用 Email／Telegram 提醒你' : '';
}
function p6RegHtml(p) {
  const on = Boolean(p6Load.reg()[p.id]);
  const url = p.sources?.[0]?.url;
  const who = p6RemindWho();
  const later = who ? `；沒勾的話，最晚轉點日前 3 天${who}` : typeof acct !== 'undefined' && acct.configured ? '；登入帳號後，沒勾的會在最晚轉點日前 3 天寄提醒' : '';
  return `<div class="p6-reg${on ? ' done' : ''}" data-p6-reg-box="${esc(p.id)}"><label><input type="checkbox" data-p6-reg="${esc(p.id)}" ${on ? 'checked' : ''}> 我已登記</label>
    <small>${on ? '已登記，不會再提醒' : `這個活動要先登記${p.registerBy ? `（${p6Md(p.registerBy)} 前）` : ''}${later}`}${url ? `・<a href="${esc(url)}" target="_blank" rel="noopener">活動頁 ↗</a>` : ''}</small></div>`;
}
// Under each transfer promo in 點數換算's 🎁 list: the wallet's banks and their last safe day.
function promoRowExtraHtml(p) {
  if (p.type !== 'transfer' || walletEmpty() || !data.holds) return '';
  const rows = p6DeadlineRows(p);
  if (!rows.length) return '';
  return `<div class="p6-dl"><small class="p6-dl-h">你的銀行最晚轉點日</small><ul class="p6-dl-list">${rows.map((r) => p6DeadlineLi(p, r)).join('')}</ul>${p.registration === true ? p6RegHtml(p) : ''}</div>`;
}
const p6PromoList = () => activePromos().filter((p) => p.type === 'transfer').map((p) => ({ p, rows: p6DeadlineRows(p) })).filter((x) => x.rows.length);
// The closed block's one line: the soonest last day and how many still need registering.
function p6PromosSummary(list) {
  const next = list.flatMap(({ p, rows }) => rows.filter((r) => r.date && r.days >= 0).map((r) => ({ p, r }))).sort((a, b) => a.r.date.localeCompare(b.r.date))[0];
  const todo = list.filter(({ p }) => p.registration === true && !p6Load.reg()[p.id]).length;
  return `${next ? `最近：${esc(next.r.source.bank)} ${p6Md(next.r.date)}（${p6Left(next.r.days)}）` : ''}${todo ? `・${todo} 個要登記` : ''}`;
}
function p6PromosBlock() {
  if (!data.holds) return '';
  const list = p6PromoList();
  const watch = promoWatchHtml();
  if (!list.length) return watch ? `<h3 class="sub">🎁 轉點加贈</h3>${watch}` : '';
  const item = ({ p, rows }) => `<div class="p6-promo"><p><b>${esc(p.title)}</b>${p.bonusPct && !p.rebate ? ` <span class="pill">+${p.bonusPct}%</span>` : ''} <small>到 ${p6Md(p.end)}</small></p>
    <ul class="p6-dl-list">${rows.map((r) => p6DeadlineLi(p, r)).join('')}</ul>${p.registration === true ? p6RegHtml(p) : ''}</div>`;
  return `<details class="p6-box p6-promos" data-p6-open="promos"${p6OpenAttr('promos')}><summary>🎁 轉點加贈期限 ${list.length} 項 <small class="p6-promos-sum">${p6PromosSummary(list)}</small></summary>
    ${list.map(item).join('')}<p class="hint">最晚轉點日＝活動規定的入帳期限減掉該銀行最慢的入帳天數（規則庫的轉點入帳時間）；銀行實際作業可能更久，能早轉就早轉。</p>${watch}</details>`;
}

// N4a: the owner's new-promo notice (Telegram／Email, checked by the daily run), behind the passcode like the alerts.
const PW_KEY = 'promoWatch:v1';
const p6WatchProfile = () => ({ banks: Object.keys(wallet.banks).filter((id) => walletSources().some((s) => s.id === id)).sort(), programs: Object.keys(wallet.miles).sort() });
function promoWatchHtml() {
  if (!alertCfg.store || walletEmpty()) return '';
  const saved = store.get(PW_KEY, null);
  if (saved?.on && saved.sig === JSON.stringify(p6WatchProfile())) {
    return `<p class="hint p6-watch">🔔 已開啟新加贈通知：有新的轉點加贈、買哩促銷或哩程票特惠碰到你的銀行或哩程，會傳 Telegram${saved.email ? `、寄到 ${esc(saved.email)}` : ''}（每個活動一次）。<button type="button" class="linklike" data-p6-watch="off">關閉</button></p>`;
  }
  return `<p class="hint p6-watch">${saved?.on ? '點數有變更，' : ''}<button type="button" class="linklike" data-p6-watch="on">${saved?.on ? '更新新加贈通知' : '🔔 有新的轉點加贈、買哩促銷或哩程票特惠碰到我的銀行、哩程時通知我'}</button>（Telegram／Email，每天早上檢查，不用查詢次數）</p>
    <form class="p6-watch-form" hidden><input type="email" name="email" placeholder="Email（可留空，只傳 Telegram）" value="${esc(saved?.email ?? store.get(ALERT_EMAIL_KEY, ''))}" autocomplete="email" aria-label="通知寄到的 Email"><button type="submit" class="primary small">開啟通知</button></form>`;
}
async function p6SaveWatch(on, form) {
  const body = on ? { on: true, email: form?.email.value.trim() || '', ...p6WatchProfile() } : { on: false };
  try {
    const r = await cashApi('/api/promo-watch', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' }, pass: '新加贈通知' });
    if (on) {
      store.set(PW_KEY, { on: true, sig: JSON.stringify(p6WatchProfile()), email: r.email ?? body.email });
      if (body.email) store.set(ALERT_EMAIL_KEY, body.email);
      toast(`已開啟${r.current ? `；目前進行中、跟你有關的 ${r.current} 個活動不另外通知` : ''}，之後有新的會通知你`);
    } else {
      store.del(PW_KEY);
      toast('已關閉新加贈通知');
    }
  } catch (err) {
    toast(err.message);
  }
  p6RedrawPoints();
}
function p6RedrawPoints() {
  if (currentTab !== 'points' || !tabDone.has('points')) return;
  if (pointsView.view === 'wallet') renderWallet6(true); else renderPoints();
}

// ---------- N19: what the wallet is worth, and vouchers ----------
// A bank balance at its most valuable airline transfer (rates still in date), for 約值.
function p6BankMiles(id, n) {
  const s = walletSources().find((x) => x.id === id);
  let best = null;
  for (const k of Object.keys(P6_TRANSFER)) {
    const r = s && p6RateInto(s, k, p6Today());
    const miles = r ? calcConvert(r, n, 'p2m').value || 0 : 0;
    const v = miles * p6PerMile(k);
    if (miles && (!best || v > best.v)) best = { program: k, miles, v };
  }
  return best;
}
const p6HotelTwd = (k) => (typeof POINT_VALUE_CENTS !== 'undefined' && POINT_VALUE_CENTS[k] && fxCache?.rates?.USD ? (POINT_VALUE_CENTS[k] / 100) * fxCache.rates.USD : 0);
function p6ValueHtml() {
  if (walletEmpty() || !data.points) return '';
  if (Object.keys(wallet.hotels).length) p6NeedFx();
  const v = walletValue(wallet, { perMile: p6PerMile, bankMiles: p6BankMiles, hotelTwd: p6HotelTwd });
  if (!v.total) return '';
  const parts = [v.air && `哩程 NT$${fmt(v.air)}`, v.bank && `信用卡點數 NT$${fmt(v.bank)}`, v.hotel && `飯店點數 NT$${fmt(v.hotel)}`].filter(Boolean);
  const left = v.skipped.map((id) => walletItemName(wallet.hotels[id] ? 'h' : 'b', id)?.name || id);
  return `<p class="p6-value">💰 約值 <b>NT$${fmt(v.total)}</b><small>${parts.join('・')}${left.length ? `・沒有估值：${esc([...new Set(left)].join('、'))}` : ''}</small>
    <small class="p6-muted">哩程用「每哩成本」（搜尋結果「依台幣成本」可改）、飯店點數用一般估值粗估；信用卡點數以最划算的一種轉法計一次。</small></p>`;
}
const p6Uses = (v) => (v.kind === 'lounge' || v.kind === 'transfer' ? '次' : '張');
function p6VoucherHtml() {
  const today = p6Today();
  const list = p6Load.vouchers().sort((a, b) => String(a.expires || '9').localeCompare(String(b.expires || '9')));
  const li = (v) => {
    const [icon, kind] = P6_VOUCHER_KINDS[v.kind];
    const days = v.expires ? p6Days(today, v.expires) : null;
    const when = v.expires ? `${p6Md(v.expires)} ${p6Uses(v) === '次' ? '到期／重置' : '到期'} <span class="tag until${days <= 30 ? ' soon' : ''}">${p6Left(days)}</span>` : '<small>沒填日期</small>';
    return `<li class="${days != null && days < 0 ? 'gone' : days != null && days <= 30 ? 'soon' : ''}"><span><b>${icon} ${esc(v.name || kind)}</b><small>${esc(kind)}${v.count ? `・剩 ${fmt(v.count)} ${p6Uses(v)}` : ''}</small></span>
      <span class="exp-when">${when}<button type="button" class="w-del" data-p6-vdel="${esc(v.id)}" aria-label="刪除 ${esc(v.name || kind)}">×</button></span></li>`;
  };
  const form = `<form class="p6-vform" autocomplete="off"><select name="kind" aria-label="種類">${Object.entries(P6_VOUCHER_KINDS).map(([k, [i, l]]) => `<option value="${k}">${i} ${l}</option>`).join('')}</select>
    <input name="name" maxlength="40" placeholder="名稱，例如 長榮商務艙升等券" aria-label="名稱">
    <input name="count" type="number" min="1" max="999" inputmode="numeric" placeholder="幾張／次" aria-label="剩幾張或幾次">
    <label class="p6-vdate"><small>到期／重置日</small><input name="expires" type="date" aria-label="到期或重置日"></label>
    <button type="submit" class="primary small">加入</button></form>`;
  if (!list.length) return `<details class="p6-box" data-p6-open="vouchers"${p6OpenAttr('vouchers')}><summary>🎫 記下升等券、住宿券、貴賓室與接送次數</summary>${form}<p class="hint">填上到期或每年重置的日期，會跟哩程到期一起提醒你（到期前 90／30／7 天）。</p></details>`;
  return `<h3 class="sub">🎫 票券與權益</h3><ul class="exp-list p6-vlist">${list.map(li).join('')}</ul>${list.some((v) => v.expires) ? p6VoucherRemind() : ''}
    <details class="p6-box p6-vadd" data-p6-open="vadd"${p6OpenAttr('vadd')}><summary>＋ 新增票券</summary>${form}</details>`;
}
// The voucher dates ride on the miles expiry reminders (lib/expiry.js): same mail, same 90／30／7 days.
function p6VoucherRemind() {
  const steps = (data.expiry?.reminderDays || [90, 30, 7]).join('／');
  if (typeof signedIn === 'function' && signedIn()) return acct.emailEnabled ? `<p class="hint">📧 到期前 ${steps} 天會寄提醒到 ${esc(acct.status.email)}。</p>` : '';
  if (typeof walletExpiryList === 'function' && walletExpiryList().length) return store.get(EXP_REMIND_KEY, null) ? `<p class="hint">🔔 到期前 ${steps} 天會跟哩程到期一起提醒你。</p>` : '<p class="hint">到期提醒跟上面的哩程到期一起設定。</p>';
  return typeof expiryRemindHtml === 'function' ? expiryRemindHtml([]) : '';
}

// ---------- N17: family totals ----------
const FAMQ_KEY = 'walletFamilyQ:v1';
// A family member's miles in one program: their own balance plus their own bank points moved in (bank points only go
// to the cardholder's own account), and their own Avios in a sister program (features.js reachFor).
const p6PersonReach = (m, key) => reachFor(m, key).total;
function p6RuleText(rule) {
  const t = {
    pool: `家庭帳戶可合併${rule.max ? `（最多 ${rule.max} 人）` : ''}`,
    transfer: `可把哩程轉給家人${rule.min ? `（每次至少 ${fmt(rule.min)} 哩）` : ''}`,
    nominee: `不能合併，可用自己的哩程替家人開票${rule.max ? `（名單最多 ${rule.max} 人）` : ''}`,
    none: '沒有家庭合併',
  }[rule.type] || '家庭規則未確認';
  return rule.official ? esc(t) : `${esc(t)} <span class="tag verify" title="官方資料還沒核實，先各自計算">待確認</span>`;
}
const p6PickOptions = () => `<option value="">選擇哩程或信用卡點數</option><optgroup label="航空哩程">${WALLET_PROGRAMS.map((k) => `<option value="m:${esc(k)}">${esc(programName(k))}</option>`).join('')}</optgroup>
  <optgroup label="信用卡點數（只能轉進持卡人自己的帳戶）">${(data.points?.calc?.sources || []).map((x) => `<option value="b:${esc(x.id)}">${esc(bankLabel(x))}</option>`).join('')}</optgroup>`;
function p6MemberHtml(m) {
  const rows = [...Object.entries(m.miles).map(([k, n]) => ['m', k, n]), ...Object.entries(m.banks).map(([k, n]) => ['b', k, n])].map(([kind, id, n]) => {
    const label = walletItemName(kind, id);
    const ref = `${m.id}|${kind}:${id}`;
    return label ? `<div class="w-row"><span><b>${esc(label.name)}</b>${label.sub ? `<small>${esc(label.sub)}</small>` : ''}</span>
      <input type="number" min="0" step="100" inputmode="numeric" data-p6-mv="${esc(ref)}" value="${n}" aria-label="${esc(m.name)} ${esc(label.name)} 數量"><button type="button" class="w-del" data-p6-mv-del="${esc(ref)}" aria-label="移除 ${esc(label.name)}">×</button></div>` : '';
  }).join('');
  return `<div class="p6-mem"><div class="p6-mem-head"><input class="p6-mname" data-p6-mname="${esc(m.id)}" value="${esc(m.name)}" maxlength="12" aria-label="家人名稱"><button type="button" class="linklike" data-p6-mdel="${esc(m.id)}">移除這位</button></div>
    ${rows || '<p class="hint">還沒有填哩程或點數。</p>'}
    <div class="w-add"><select data-p6-mpick="${esc(m.id)}" aria-label="選擇${esc(m.name)}的哩程或點數">${p6PickOptions()}</select><input type="number" min="0" step="100" inputmode="numeric" placeholder="數量" data-p6-mamt="${esc(m.id)}" aria-label="數量"><button type="button" class="outline" data-p6-madd="${esc(m.id)}">加入</button></div></div>`;
}
function p6FamilyRows(fam) {
  const keys = [...new Set([...WALLET_PROGRAMS, ...Object.keys(PROGRAM_TRANSFER)])];
  return keys.map((k) => {
    const people = [{ name: '我', miles: reach(k).total }, ...fam.members.map((m) => ({ name: m.name, miles: p6PersonReach(m, k) }))];
    if (people.filter((p) => p.miles > 0).length < 1) return null;
    const rec = p6ProgramRec(k);
    const rule = poolRule(rec);
    return { k, rec, rule, h: householdPool(people, rule) };
  }).filter(Boolean).sort((a, b) => b.h.people.length - a.h.people.length || b.h.usable - a.h.usable);
}
function p6FamilyOut() {
  const fam = p6Load.family();
  if (!fam.members.length) return '';
  const q = store.get(FAMQ_KEY, {}) || {};
  const per = cleanCount(q.miles);
  const pax = Math.min(9, cleanCount(q.pax));
  const rows = p6FamilyRows(fam);
  if (!rows.length) return '<p class="hint">填入家人的哩程或點數後，這裡會算出全家每個計畫能用多少。</p>';
  const tr = ({ k, rec, rule, h }) => {
    const each = h.people.map((p) => `${esc(p.name)} ${fmt(p.miles)}`).join('・');
    const sum = h.combine ? `<b>合計 ${fmt(h.usable)} 哩</b>${h.left?.length ? `<small>超過人數上限的 ${h.left.length} 位各自用</small>` : ''}` : `<b>各自用</b><small>最多一人 ${fmt(h.usable)} 哩</small>`;
    const n = per ? h.seats(per) : null;
    const seats = n == null ? '' : `<small class="${pax && n >= pax ? 'ok-text' : pax ? 'warn' : ''}">${n ? `夠 ${n} 張` : '一張都不夠'}${pax && n < pax ? `，還差 ${pax - n} 張` : pax ? ' ✓' : ''}</small>`;
    return `<tr><td><b>${esc(programName(k))}</b><small>${p6RuleText(rule)}${rec ? `・<a href="#rules" data-prog-card="${esc(rec.id)}">規則</a>` : ''}</small></td><td data-l="每個人"><small>${each}</small></td><td data-l="全家">${sum}${seats}</td></tr>`;
  };
  return `<div class="table-wrap"><table class="wallet-sum p6-fam-table"><thead><tr><th>計畫</th><th>每個人</th><th>全家</th></tr></thead><tbody>${rows.map(tr).join('')}</tbody></table></div>`;
}
function p6FamilyHtml() {
  const fam = p6Load.family();
  const q = store.get(FAMQ_KEY, {}) || {};
  const ask = fam.members.length ? `<div class="p6-famq"><label>每張票 <input type="number" id="p6-fam-miles" min="0" step="1000" inputmode="numeric" placeholder="例如 70000" value="${cleanCount(q.miles) || ''}" aria-label="每張票的哩程"> 哩</label><label>要 <input type="number" id="p6-fam-pax" min="1" max="9" inputmode="numeric" placeholder="4" value="${cleanCount(q.pax) || ''}" aria-label="要幾張票"> 張</label></div>` : '';
  return `<details class="p6-box p6-family" data-p6-open="family"${p6OpenAttr('family')}><summary>👨‍👩‍👧 家人點數合計 <small>${fam.members.length ? `${fam.members.length} 位家人` : '加入家人，看全家夠不夠換'}</small></summary>
    <div id="p6-fam-ed">${fam.members.map(p6MemberHtml).join('')}${fam.members.length < 8 ? '<button type="button" class="outline" data-p6-madd-member>＋ 加入家人</button>' : ''}</div>
    ${ask}<div id="p6-fam-out">${p6FamilyOut()}</div>
    <p class="hint">「我」用上面的點數。每個計畫依官方的家庭規則：可合併的才加總，不能合併的各自用自己的哩程（多半可以替家人開票）；信用卡點數只能轉進持卡人自己的帳戶。規則標「待確認」的，官方資料還沒核實，先各自計算。</p></details>`;
}
const p6RenderFamilyOut = () => { const el = $('#p6-fam-out'); if (el) el.innerHTML = p6FamilyOut(); };
function p6SetFamily(fn) {
  const fam = p6Load.family();
  fn(fam);
  const clean = cleanFamily(fam);
  p6Put(P6_SYNC.family, clean, !clean.members.length);
}

// ---------- N22: redemption ledger ----------
const P6_TICKETED = new Set(['ticketed', 'issued', '已開票']);
// 已開票 from 我的行程: this file's button, or a status field on the leg if 我的行程 has one.
const p6LegTicketed = (l) => P6_TICKETED.has(l?.status) || l?.ticketed === true;
const p6SumOpts = () => ({ rates: fxCache?.rates || {}, perMile: p6PerMile });
function p6Record(legs) {
  const ledger = p6Load.ledger();
  const have = new Set(ledger.map((e) => e.id));
  const add = legs.filter((l) => !have.has(ledgerId(l))).map((l) => ledgerFromLeg(l, p6Today(), typeof cashSeen === 'object' ? cashSeen : {}));
  if (add.length) p6Put(P6_SYNC.ledger, cleanLedger([...ledger, ...add]));
  return add;
}
// Under 我的行程: a 已開票 button per award leg, and the year so far.
function p6PlanLedger() {
  const body = $('#plan-body');
  if (!body || typeof plan === 'undefined') return;
  p6Record(plan.legs.filter((l) => l.k === 'a' && l.miles > 0 && p6LegTicketed(l)));
  const ledger = p6Load.ledger();
  const have = new Set(ledger.map((e) => e.id));
  const legs = plan.legs.map((l, i) => ({ l, i })).filter(({ l }) => l.k === 'a' && l.miles > 0 && !['held', 'waitlist'].includes(l.status)); // not ticketed yet
  if (!legs.length && !ledger.length) return;
  const li = ({ l, i }) => `<li><span>${mmdd(l.date)} ${esc(l.from)} → ${esc(l.to)}<small>${esc(programName(l.program))} ${fmt(l.miles * l.pax)} 哩</small></span>${have.has(ledgerId(l))
    ? '<small class="ok-text">✓ 已記入兌換紀錄</small>' : `<button type="button" class="outline small" data-p6-tick="${i}">🎫 已開票，記下來</button>`}</li>`;
  const y = ledgerSummary(ledger, p6SumOpts())[0];
  // Into 我的行程's 「更多」 fold (features.js planMoreHost).
  (typeof planMoreHost === 'function' ? planMoreHost(body) : body).insertAdjacentHTML('beforeend', `<div class="p6-ledger-plan">${legs.length ? `<ul class="p6-ticks">${legs.map(li).join('')}</ul>` : ''}
    <p class="hint">📒 ${ledger.length ? `兌換紀錄 ${ledger.length} 筆${y?.perMile != null ? `・${y.year} 年實際每哩約 NT$${y.perMile.toFixed(2)}` : ''}　<button type="button" class="linklike" data-p6-ledger-open>看年度回顧</button>` : '開票後按「已開票」，會記下用掉的哩程、稅金和你查過的當天現金票價，年底看每哩實際換到多少錢。'}</p></div>`);
}
function p6LedgerHtml() {
  const ledger = p6Load.ledger();
  if (ledger.some((e) => e.tax && e.tax.cur !== 'TWD')) p6NeedFx();
  const years = ledgerSummary(ledger, p6SumOpts());
  const cur = years[0];
  const yearHtml = (y) => {
    const progs = Object.entries(y.byProgram).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${esc(programName(k))} ${fmt(n)}`).join('、');
    const verdict = y.perMile == null ? '<p><small>還沒有現金票價：在下面填上當天的現金票價，就能算出每哩實際換到多少。</small></p>'
      : `<p class="p6-verdict">實際每哩約 <b>NT$${y.perMile.toFixed(2)}</b>，每哩成本約 NT$${y.costPerMile.toFixed(2)}：${y.perMile >= y.costPerMile ? '<span class="ok-text">換得比累積的成本划算</span>' : '<b class="warn">比累積的成本還低</b>'}</p>`;
    return `<div class="p6-year"><h4>${esc(y.year)} 年</h4><p>${y.count} 筆，用掉 <b>${fmt(y.miles)} 哩</b><small>${progs}</small></p>
      <p><small>稅金約 NT$${fmt(y.tax)}${y.taxUnknown ? `（另有 ${y.taxUnknown} 筆的幣別還沒換算）` : ''}${y.cash ? `・換掉的現金票 NT$${fmt(y.cash)}（${fmt(y.cashMiles)} 哩有現金票價）` : ''}</small></p>${verdict}</div>`;
  };
  const row = (e) => `<li><span><b>${p6Md(e.date)} ${esc(e.from)} → ${esc(e.to)}</b><small>${esc(programName(e.program))}・${CABIN_LABEL[e.cabin]}${e.pax > 1 ? `・${e.pax} 人` : ''}・${fmt(e.miles)} 哩${e.tax ? `・稅 ${esc(e.tax.cur)} ${fmt(Math.round(e.tax.amount))}` : ''}・${p6Md(e.at)} 開票</small></span>
    <span class="p6-cash"><label><small>現金票 NT$</small><input type="number" min="0" step="100" inputmode="numeric" data-p6-cash="${esc(e.id)}" value="${e.cash ?? ''}" placeholder="—" aria-label="當天現金票價（新台幣，${e.pax} 人合計）"></label><button type="button" class="w-del" data-p6-ldel="${esc(e.id)}" aria-label="刪除這筆紀錄">×</button></span></li>`;
  const sorted = ledger.slice().sort((a, b) => b.at.localeCompare(a.at) || b.date.localeCompare(a.date));
  return `<details class="p6-box p6-ledger" id="p6-ledger" data-p6-open="ledger"${p6OpenAttr('ledger')}><summary>📒 兌換紀錄與年度回顧 <small>${cur ? `${esc(cur.year)} 年 ${cur.count} 筆${cur.perMile != null ? `・實際每哩 NT$${cur.perMile.toFixed(2)}` : ''}` : '在「我的行程」按「已開票」就會記在這裡'}</small></summary>
    ${years.map(yearHtml).join('')}${sorted.length ? `<ul class="exp-list p6-llist">${sorted.map(row).join('')}</ul>` : ''}
    <p class="hint">實際每哩＝（現金票價 − 稅金）÷ 哩數，只算有現金票價的紀錄。現金票價取自你查現金票時已查過的同一天價格，不會另外查價，也可以自己填。每哩成本用搜尋結果「依台幣成本」的設定，拿來判斷信用卡累積哩程划不划算。</p></details>`;
}

// ---------- N23: what expiring miles can still buy ----------
const P6_HOME = 'TPE';
const p6TipCache = new Map();
let p6ApAsked = false;
// The 2–3 cheapest one-way awards from Taipei a balance still covers (fixed charts, no seat search): the cheapest in
// each cabin it reaches, topped up with the next cheapest economy one. null while the airport list loads.
function cheapestAwards(key, balance) {
  const k = programKeyOf(key);
  if (!data.charts || !(balance > 0)) return [];
  if (!AP.list.length) {
    if (!p6ApAsked) { p6ApAsked = true; loadAirports().then(() => { if (typeof renderWalletExpiry === 'function') renderWalletExpiry(); }).catch(() => {}); }
    return null;
  }
  const id = `${k}|${balance}`;
  if (p6TipCache.has(id)) return p6TipCache.get(id);
  const from = AP.byCode.get(P6_HOME);
  const charted = k === 'asiamiles' || (data.charts.programs || []).some((p) => p.id === k && ['distance', 'zone', 'regionMatrix', 'routeSpecific'].includes(p.kind));
  const out = [];
  if (from && charted) {
    const groupOf = new Map(AP.groups.flatMap((g) => g.codes.map((c) => [c, g.zh])));
    const best = { Y: new Map(), J: new Map(), F: new Map() };
    for (const ap of AP.list) {
      if (!ap.large || !ap.zh || ap.lat == null || ap.code === from.code || haversineMiles(from, ap) < 100) continue;
      const city = groupOf.get(ap.code) || ap.zh.replace(/（.*）$/, '');
      for (const cabin of ['Y', 'J', 'F']) {
        const p = rmapPrices(from, ap, cabin, 'ow', k).prices[0];
        if (!p || p.miles > balance) continue;
        const old = best[cabin].get(city);
        if (!old || p.miles < old.miles) best[cabin].set(city, { to: ap.code, toName: city, cabin, miles: p.miles });
      }
    }
    const sorted = (c) => [...best[c].values()].sort((a, b) => a.miles - b.miles);
    for (const c of ['Y', 'J', 'F']) { const x = sorted(c)[0]; if (x) out.push(x); }
    for (const x of sorted('Y').slice(1)) { if (out.length >= 2) break; out.push(x); }
  }
  p6TipCache.set(id, out.slice(0, 3));
  return p6TipCache.get(id);
}
// In the 哩程到期 row: what the balance still buys, the program's official ways to keep or revive miles, and a search.
function expiryHelpHtml(x) {
  if (x.days > 120) return '';
  const rec = p6ProgramRec(x.key);
  const ways = rec?.expiryWays || [];
  const awards = x.days >= 0 ? cheapestAwards(x.key, x.miles) : [];
  const first = awards?.[0];
  const list = awards == null ? '<p><small>正在載入機場資料…</small></p>'
    : awards.length ? `<ul>${awards.map((a) => `<li><span>台北 → ${esc(a.toName)} ${CABIN_LABEL[a.cabin]}單程 <b>${fmt(a.miles)} 哩</b></span><button type="button" class="linklike" data-p6-go="${esc(a.to)}|${a.cabin}">查座位（用 1 次查詢）</button></li>`).join('')}</ul>`
      : x.days >= 0 ? '<p><small>這個計畫沒有固定哩程表，或餘額不夠換最便宜的單程；可以到航線查詢看實際價格。</small></p>' : '';
  const how = ways.length ? `<p><small>官方的延長方式：${ways.map(esc).join('；')}。</small></p>` : `<p><small>官方的延長方式待確認${rec ? `，看<a href="#rules" data-prog-card="${esc(rec.id)}">規則庫</a>` : ''}。</small></p>`;
  const head = x.days < 0 ? '過期了怎麼辦' : first ? `還能換：台北 → ${esc(first.toName)} ${CABIN_LABEL[first.cabin]} ${fmt(first.miles)} 哩${awards.length > 1 ? ` 等 ${awards.length} 個` : ''}` : '快到期了怎麼辦';
  return `<details class="p6-exphelp" data-p6-open="exp:${esc(x.key)}"${p6OpenAttr(`exp:${x.key}`)}><summary>💡 ${head}</summary>${list}${how}${awards?.length ? '<p><small>依各計畫公布的固定哩程表估算，有沒有位子要另外查。</small></p>' : ''}</details>`;
}
// The same suggestions saved with the account (or the owner's list), so the reminder mail can list them.
function p6SyncTips() {
  if (typeof walletExpiryList !== 'function') return;
  const tips = {};
  for (const x of walletExpiryList()) {
    if (x.days < 0) continue;
    const a = cheapestAwards(x.key, x.miles);
    if (a?.length) tips[x.key] = { awards: a };
  }
  const clean = cleanTips(tips);
  if (p6Stable(clean) !== p6Stable(cleanTips(store.get(P6_SYNC.tips, {})))) p6Put(P6_SYNC.tips, clean, !Object.keys(clean).length);
}

// ---------- reminders for the owner's own list (no account) ----------
// What the reminder run needs besides miles dates: bank programs (for 登記 reminders), vouchers, 已登記 and tips.
const p6RemindExtras = () => ({ banks: Object.keys(wallet.banks), vouchers: p6Load.vouchers(), reg: p6Load.reg(), tips: cleanTips(store.get(P6_SYNC.tips, {})) });
const P6_RESYNC_KEY = 'p6RemindSig';
let p6ResyncT = 0;
// The owner's list keeps its own copy on the server: send it again (quietly) when any of the extras change.
function p6MaybeResync() {
  if (typeof EXP_REMIND_KEY === 'undefined') return; // ewallet.js not in yet
  if ((typeof signedIn === 'function' && signedIn()) || !store.get(EXP_REMIND_KEY, null) || !alertCfg.store) return;
  if (cashCfg.locked && !store.get(PASS_KEY, '')) return;
  const sig = p6Stable(p6RemindExtras());
  if (sig === store.get(P6_RESYNC_KEY, '')) return;
  clearTimeout(p6ResyncT);
  p6ResyncT = setTimeout(() => {
    const saved = store.get(EXP_REMIND_KEY, null);
    if (!saved) return;
    cashApi('/api/expiry', { method: 'POST', body: JSON.stringify({ email: saved.email || '', wallet: { miles: wallet.miles, expiry: wallet.expiry, ...p6RemindExtras() } }), headers: { 'content-type': 'application/json' } })
      .then(() => store.set(P6_RESYNC_KEY, sig)).catch(() => {});
  }, 1500);
}

// ---------- wallet page ----------
function p6Slot(id, after) {
  let el = document.getElementById(id);
  if (!el) {
    const ref = $(after);
    if (!ref) return null;
    ref.insertAdjacentHTML('afterend', `<div id="${id}"></div>`);
    el = document.getElementById(id);
  }
  return el;
}
// Called by ewallet.js after every wallet redraw. A block being typed in is left alone unless `force`.
function renderWallet6(force = false) {
  if (!$('.wallet')) return;
  const set = (id, after, html) => { const el = p6Slot(id, after); if (el && (force || !el.contains(document.activeElement))) el.innerHTML = html; };
  set('w6-value', '.wallet .w-add', p6ValueHtml());
  set('w6-vouchers', '#wallet-expiry', p6VoucherHtml());
  set('w6-promos', '#w6-vouchers', p6PromosBlock());
  set('w6-family', '#wallet-goal', p6FamilyHtml());
  set('w6-ledger', '#w6-family', p6LedgerHtml());
  p6SyncTips();
  p6MaybeResync();
}
// After account sync brought new copies of these keys.
function p6Refresh() {
  if (tabDone.has('points') && !$('#points-page')?.contains(document.activeElement)) renderPoints();
  if (typeof renderPlan === 'function') renderPlan();
}

// ---------- events (delegated, so redraws need no rebinding) ----------
function p6Init() {
  document.addEventListener('toggle', (e) => {
    const k = e.target?.dataset?.p6Open;
    if (k) { if (e.target.open) p6Opened.add(k); else p6Opened.delete(k); }
  }, true);
  document.addEventListener('click', (e) => {
    const t = e.target;
    const row = t.closest?.('[data-calc-row]');
    if (row) {
      const id = row.dataset.calcRow;
      const open = !p6CalcOpen.has(id);
      if (open) p6CalcOpen.add(id); else p6CalcOpen.delete(id);
      row.closest('tr')?.classList.toggle('open', open);
      row.setAttribute('aria-expanded', String(open));
      return;
    }
    const go = t.closest?.('[data-p6-go]');
    if (go) {
      const [to, cabin] = go.dataset.p6Go.split('|');
      applyShare(new URLSearchParams({ o: P6_HOME, d: to, s: isoDate(1), e: isoDate(30), c: cabin }));
      return;
    }
    const watch = t.closest?.('[data-p6-watch]');
    if (watch) {
      if (watch.dataset.p6Watch === 'off') { p6SaveWatch(false); return; }
      const f = watch.closest('.p6-watch')?.nextElementSibling;
      if (f?.classList.contains('p6-watch-form')) { f.hidden = false; f.email.focus(); }
      return;
    }
    // The voucher block's copy of the owner's reminder link (ewallet.js handles the form itself).
    if (t.closest?.('#w6-vouchers [data-exp-remind]') && !$('#w6-vouchers .exp-remind-form')) {
      renderWallet6(true);
      $('#w6-vouchers .exp-remind-form')?.removeAttribute('hidden');
      return;
    }
    const tick = t.closest?.('[data-p6-tick]');
    if (tick) {
      const leg = plan.legs[Number(tick.dataset.p6Tick)];
      const [e1] = leg ? p6Record([leg]) : [];
      if (e1) toast(e1.cash ? `已記入兌換紀錄（當天現金票 NT$${fmt(e1.cash)}）` : '已記入兌換紀錄；沒有查過當天現金票價，可以到兌換紀錄自己填');
      renderPlan();
      return;
    }
    if (t.closest?.('[data-p6-ledger-open]')) {
      p6Opened.add('ledger');
      openWallet();
      setTimeout(() => $('#p6-ledger')?.scrollIntoView({ block: 'start' }), 60);
      return;
    }
    const ldel = t.closest?.('[data-p6-ldel]');
    if (ldel) {
      if (!confirm('刪除這筆兌換紀錄？')) return;
      const left = p6Load.ledger().filter((x) => x.id !== ldel.dataset.p6Ldel);
      p6Put(P6_SYNC.ledger, left, !left.length);
      renderWallet6(true);
      return;
    }
    const vdel = t.closest?.('[data-p6-vdel]');
    if (vdel) {
      const left = p6Load.vouchers().filter((x) => x.id !== vdel.dataset.p6Vdel);
      p6Put(P6_SYNC.vouchers, left, !left.length);
      renderWallet6(true);
      return;
    }
    if (t.closest?.('[data-p6-madd-member]')) {
      const id = p6NewId();
      p6Opened.add('family');
      p6SetFamily((f) => f.members.push({ id, name: `家人${f.members.length + 1}`, miles: {}, banks: {} }));
      renderWallet6(true);
      $(`[data-p6-mname="${id}"]`)?.select();
      return;
    }
    const mdel = t.closest?.('[data-p6-mdel]');
    if (mdel) {
      if (!confirm('移除這位家人和他的點數？')) return;
      p6SetFamily((f) => { f.members = f.members.filter((m) => m.id !== mdel.dataset.p6Mdel); });
      renderWallet6(true);
      return;
    }
    const madd = t.closest?.('[data-p6-madd]');
    if (madd) {
      const id = madd.dataset.p6Madd;
      const pick = $(`[data-p6-mpick="${id}"]`);
      const amt = $(`[data-p6-mamt="${id}"]`);
      if (!pick.value) { pick.focus(); return; }
      if (!cleanCount(amt.value)) { amt.focus(); return; }
      const [kind, key] = pick.value.split(':');
      p6SetFamily((f) => { const m = f.members.find((x) => x.id === id); if (m) m[kind === 'b' ? 'banks' : 'miles'][key] = cleanCount(amt.value); });
      renderWallet6(true);
      return;
    }
    const mvdel = t.closest?.('[data-p6-mv-del]');
    if (mvdel) {
      const [id, ref] = mvdel.dataset.p6MvDel.split('|');
      const [kind, key] = ref.split(':');
      p6SetFamily((f) => { const m = f.members.find((x) => x.id === id); if (m) delete m[kind === 'b' ? 'banks' : 'miles'][key]; });
      renderWallet6(true);
    }
  });
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset?.p6Mv) {
      const [id, ref] = t.dataset.p6Mv.split('|');
      const [kind, key] = ref.split(':');
      const n = cleanCount(t.value);
      p6SetFamily((f) => { const m = f.members.find((x) => x.id === id); if (!m) return; const b = m[kind === 'b' ? 'banks' : 'miles']; if (n) b[key] = n; else delete b[key]; });
      p6RenderFamilyOut();
    } else if (t.id === 'p6-fam-miles' || t.id === 'p6-fam-pax') {
      store.set(FAMQ_KEY, { miles: cleanCount($('#p6-fam-miles')?.value), pax: cleanCount($('#p6-fam-pax')?.value) });
      p6RenderFamilyOut();
    }
  });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset?.p6Reg) {
      const reg = p6Load.reg();
      if (t.checked) reg[t.dataset.p6Reg] = true; else delete reg[t.dataset.p6Reg];
      p6Put(P6_SYNC.reg, reg, !Object.keys(reg).length);
      const p = (data.promos?.promos || []).find((x) => x.id === t.dataset.p6Reg);
      // Redraw every copy of this box (the calculator list and the wallet), keeping focus on the one just ticked.
      if (!p) return;
      const tpl = document.createElement('template');
      tpl.innerHTML = p6RegHtml(p);
      for (const box of $$(`[data-p6-reg-box="${CSS.escape(p.id)}"]`)) {
        if (!box.contains(t)) { box.replaceWith(tpl.content.firstElementChild.cloneNode(true)); continue; }
        box.classList.toggle('done', t.checked);
        $('small', box).innerHTML = tpl.content.querySelector('small').innerHTML;
      }
      const sum = $('.p6-promos-sum');
      if (sum) sum.innerHTML = p6PromosSummary(p6PromoList());
    } else if (t.dataset?.p6Cash) {
      const list = p6Load.ledger();
      const x = list.find((y) => y.id === t.dataset.p6Cash);
      if (x) { x.cash = cleanCount(t.value) || null; p6Put(P6_SYNC.ledger, list); renderWallet6(true); }
    } else if (t.dataset?.p6Mname) {
      p6SetFamily((f) => { const m = f.members.find((x) => x.id === t.dataset.p6Mname); if (m) m.name = t.value.trim().slice(0, 12) || '家人'; });
      p6RenderFamilyOut();
    }
  });
  document.addEventListener('submit', (e) => {
    const f = e.target;
    if (f.classList?.contains('p6-vform')) {
      e.preventDefault();
      if (!f.name.value.trim() && !f.expires.value) { f.name.focus(); return; }
      const list = p6Load.vouchers();
      list.push({ id: p6NewId(), kind: f.kind.value, name: f.name.value, count: f.count.value, expires: f.expires.value });
      const clean = cleanVouchers(list);
      p6Put(P6_SYNC.vouchers, clean, !clean.length);
      p6Opened.delete('vadd');
      renderWallet6(true);
      toast('已加入票券');
    } else if (f.classList?.contains('p6-watch-form')) {
      e.preventDefault();
      p6SaveWatch(true, f);
    }
  });
  // 我的行程 redraws itself in features.js; the ledger buttons follow every redraw.
  const base = renderPlan;
  renderPlan = function renderPlanWithLedger() { base(); p6PlanLedger(); };
}

if (typeof module === 'object' && module.exports) {
  module.exports = {
    P6_TRANSFER, P6_SYNC_KEYS, P6_MERGE, p6RateExpired, p6RateInto, safeTransferDate, promoDeadlines, promoTouches, newPromos, promoHistoryStats, regReminders,
    poolRule, householdPool, walletValue, ledgerId, ledgerFromLeg, ledgerSummary, cleanVouchers, cleanFamily, cleanReg, cleanLedger, cleanTips, p6MergeList, p6MergeMap,
  };
} else {
  p6Init();
}
