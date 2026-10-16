// Round 9 (r9-prog): Avios moves in 我的點數, award sales, the weekly digest, gcmap links, chart before/after,
// status match and official cash sales. Browser scripts run in a vm sandbox with the real data files.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8'));
const src = (f) => fs.readFileSync(path.join(ROOT, 'public', f), 'utf8');

// The top of features.js (programs, transfer rates, promos, wallet, Avios, reach) with app.js's calcConvert.
function featSandbox({ today = '2026-10-16', promos = read('promos.json') } = {}) {
  const feat = src('features.js');
  const head = `${feat.slice(0, feat.indexOf('// ---------- booking channels'))}\n${feat.match(/const promosFor = .*;/)[0]}`;
  const calcConvert = src('app.js').match(/function calcConvert\(rate, amount, mode\) \{[\s\S]*?\n\}/)[0];
  const ctx = {
    data: { points: read('points.json'), promos },
    SOURCE_NAMES: read('source-names.json').names,
    fmt: (n) => Number(n).toLocaleString('en-US'),
    esc: (s) => String(s ?? ''),
    isoDate: () => today,
    mmdd: (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`,
    store: { get: (k, d) => d },
    CONFIDENCE_TAG: {},
  };
  vm.createContext(ctx);
  vm.runInContext(`${calcConvert}\nconst CABIN_API = { Y: 'economy', W: 'premium', J: 'business', F: 'first' };\nconst AP = { byCode: new Map([['IST', { country: 'TR' }], ['ESB', { country: 'TR' }], ['TPE', { country: 'TW' }]]) };\n${head}
this.api = { reach, reachFor, aviosPath, ratesInto, aviosMoves, aviosNeedHtml, aviosEarnHtml, setWallet: (w) => { wallet = w; }, awardSaleFor, awardSaleNeedsAirports, awardSaleNoticeHtml, awardSaleTripHtml, promosFor, promosHtml };`, ctx);
  return ctx.api;
}

// ---------- #7 Avios ----------
test('Avios links: Qatar only through BA, every link official with its source', () => {
  const av = read('points.json').calc.avios;
  assert.deepEqual(Object.keys(av.programs).sort(), ['aerlingus', 'british', 'finnair', 'iberia', 'qatar']);
  for (const l of av.links) {
    assert.ok(av.programs[l.a] && av.programs[l.b], `${l.a}-${l.b}`);
    assert.equal(l.confidence, 'official');
    assert.match(l.source.url, /^https:\/\/www\.(qatarairways|finnair|britishairways)\.com\//);
  }
  assert.deepEqual(av.links.filter((l) => [l.a, l.b].includes('qatar')).map((l) => [l.a, l.b]), [['british', 'qatar']]);
  const f = featSandbox();
  assert.deepEqual([...f.aviosPath('qatar', 'finnair')], ['qatar', 'british', 'finnair']);
  assert.deepEqual([...f.aviosPath('british', 'qatar')], ['british', 'qatar']);
  assert.equal(f.aviosPath('qatar', 'qatar'), null);
  assert.equal(f.aviosPath('eva', 'qatar'), null);
});

test('reach: BA Avios and 國泰世華 points count for Qatar and Finnair, marked as a move', () => {
  const f = featSandbox();
  f.setWallet({ banks: { 'cathay-tree': 45000 }, miles: { british: 20000 }, hotels: {} });
  // 國泰世華 450 points = 1,000 BA Avios beats its own 480 points = 1,000 Qatar Avios.
  const q = f.reach('qatar');
  assert.equal(q.own, 0);
  assert.equal(q.banks.length, 1);
  assert.equal(q.banks[0].miles, 100000);
  assert.deepEqual([...q.banks[0].path], ['british', 'qatar']);
  assert.deepEqual(q.moved.map((m) => [m.program, m.miles]), [['british', 20000]]);
  assert.equal(q.total, 120000);
  assert.equal(f.aviosMoves(q).length, 2);
  // Without the moves only the direct 480-point rate is left.
  const plain = f.reach('qatar', { avios: false });
  assert.equal(plain.total, 93000);
  assert.equal(plain.moved.length, 0);
  // Finnair takes no Taiwanese points directly: everything comes through BA.
  const fin = f.reach('finnair');
  assert.equal(fin.total, 120000);
  assert.ok(fin.banks.every((b) => b.path?.at(-1) === 'finnair'));
  assert.match(f.aviosNeedHtml(fin.banks[0].path), /^需先把 Avios 轉到芬航（1:1，<a href="https:\/\/www\.finnair\.com\//);
  // BA itself: the bank's direct rate, no move needed.
  const ba = f.reach('british');
  assert.equal(ba.own, 20000);
  assert.equal(ba.banks[0].path, null);
  assert.equal(f.aviosMoves(ba).length, 0);
  // Programs outside Avios are untouched.
  assert.equal(f.reach('eva').moved.length, 0);
});

test('reach: HSBC points (1:1 into Qatar only) reach BA through Qatar; a family member uses their own balances', () => {
  const f = featSandbox();
  f.setWallet({ banks: { 'hsbc-travel': 10000 }, miles: {}, hotels: {} });
  const ba = f.reach('british');
  assert.equal(ba.total, 10000);
  assert.deepEqual([...ba.banks[0].path], ['qatar', 'british']);
  const member = { miles: { qatar: 5000 }, banks: {} };
  assert.equal(f.reachFor(member, 'british').total, 5000);
  assert.equal(f.reachFor(member, 'british', { avios: false }).total, 0);
  assert.match(f.aviosEarnHtml('qatar'), /你可以用英航 Avios 轉過來（1:1）/);
  assert.match(f.aviosEarnHtml('finnair'), /卡達的 Avios 要先轉到英航再轉過來/);
  assert.match(f.aviosEarnHtml('british'), /卡達、芬航、西班牙國家航空、愛爾蘭航空的 Avios 都能 1:1 轉過來/);
});

test('detour: Avios-aware hotel partners and direct routes', () => {
  const feat = src('features.js');
  assert.match(feat, /function hotelPartner\(hotel, air\) \{[\s\S]*?isAvios\(air\)/);
  assert.match(feat, /function directRoute\(air, sourceId, amount\)/);
  // Accor sends Iberia 1:1 but Qatar only 4:3: the Qatar route goes through Iberia (official rates on both).
  const accor = read('points.json').calc.hotels.toAir.hotels.accor.partners;
  const ib = accor.find((p) => p.to === 'iberia');
  const qr = accor.find((p) => p.to === 'qatar');
  assert.ok(ib.miles / ib.hotelPoints > qr.miles / qr.hotelPoints);
  assert.equal(ib.confidence, 'official');
  // 繞路兌換 shows the chain, 我的點數 the need-to-move mark, the results note under 只看我換得起的.
  assert.match(feat, /aviosChainText\(d\.path, d\.source\.bank\)/);
  assert.match(feat, /class="avios-need"/);
  assert.match(src('app.js'), /state\.affordOnly && typeof aviosAffordHtml === 'function' \? aviosAffordHtml\(\) : ''/);
  assert.match(src('points6.js'), /const p6PersonReach = \(m, key\) => reachFor\(m, key\)\.total;/);
});

// ---------- #9 award sales ----------
const P6 = require('../public/points6.js');
const { createPromoWatch } = require('../lib/promowatch');
const { memoryKv } = require('../lib/kv');

test('award sales: official sources, booking and travel windows, routes in the documented shape', () => {
  const award = read('promos.json').promos.filter((p) => p.type === 'award');
  assert.ok(award.length >= 1);
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  for (const p of award) {
    assert.equal(p.confidence, 'official', p.id);
    assert.ok(p.sources.length && p.sources.every((x) => x.official), p.id);
    assert.ok(p.discountPct > 0 && p.discountPct < 100, p.id);
    for (const k of ['start', 'end', 'travelFrom', 'travelTo']) assert.match(p[k], iso, `${p.id} ${k}`);
    assert.ok(p.start <= p.end && p.travelFrom <= p.travelTo, p.id);
    assert.ok(read('source-names.json').names[p.program], `${p.id} program is a seats.aero source`);
    for (const rt of p.routes) {
      assert.match(rt.cabins, /^[YWJF]+$/, p.id);
      const ends = rt.between ? [rt.between, rt.and] : [rt.from, rt.to];
      for (const t of ends.flat()) assert.match(t, /^[A-Z]{2,3}$/, `${p.id} ${t}`);
    }
  }
});

test('awardSaleFor: program, route (both ways for between), cabin, travel date and operating airline', () => {
  const promos = { promos: [
    { id: 't', type: 'award', program: 'turkish', title: '土航測試', discountPct: 30, start: '2026-10-16', end: '2026-10-30', travelFrom: '2026-11-01', travelTo: '2026-11-30', carriers: ['TK'], routes: [{ between: 'TR', and: ['TPE'], cabins: 'Y' }], sources: [{ label: '官網', url: 'https://example.test', official: true }] },
    { id: 's', type: 'award', program: 'singapore', title: '新航測試', discountPct: 30, start: '2026-10-15', end: '2026-10-31', travelFrom: '2026-11-01', travelTo: '2026-11-30', carriers: ['SQ'], routes: [{ from: 'SIN', to: 'BKK', cabins: 'YJ' }] },
  ] };
  const f = featSandbox({ promos });
  const tk = { source: 'turkish', origin: 'TPE', destination: 'IST', date: '2026-11-10', cabin: 'Y', airlines: 'TK' };
  assert.equal(f.awardSaleFor(tk)?.id, 't');
  assert.equal(f.awardSaleFor({ ...tk, origin: 'ESB', destination: 'TPE' })?.id, 't', 'other way, any Turkish airport');
  assert.equal(f.awardSaleFor({ ...tk, cabin: 'J' }), null, 'economy only');
  assert.equal(f.awardSaleFor({ ...tk, date: '2026-12-01' }), null, 'outside the travel window');
  assert.equal(f.awardSaleFor({ ...tk, airlines: 'TK, OZ' }), null, 'partner carrier');
  assert.equal(f.awardSaleFor({ ...tk, source: 'united' }), null, 'other program');
  const sq = { source: 'singapore', origin: 'SIN', destination: 'BKK', date: '2026-11-03', cabin: 'J', airlines: 'SQ' };
  assert.equal(f.awardSaleFor(sq)?.id, 's');
  assert.equal(f.awardSaleFor({ ...sq, origin: 'BKK', destination: 'SIN' }), null, 'from/to is one way');
  assert.equal(featSandbox({ promos, today: '2026-11-01' }).awardSaleFor(sq), null, 'booking window closed');
  // 航班明細 and the results notice; 怎麼湊到這些哩 no longer lists route sales for the whole program.
  const trip = { source: 'turkish', cabin: 'economy', carriers: 'TK', segments: [{ from: 'TPE', to: 'IST', departsAt: '2026-11-10T23:30:00' }] };
  assert.match(f.awardSaleTripHtml(trip), /土航測試.*官網開票約少 30%/);
  assert.equal(f.awardSaleTripHtml({ ...trip, cabin: 'business' }), '');
  const rows = [{ source: 'turkish', origin: 'TPE', destination: 'IST', date: '2026-11-10', cabins: { Y: { available: true, airlines: 'TK' } } }];
  assert.match(f.awardSaleNoticeHtml(rows, 'Y'), /結果裡有 1 筆符合・11\/1–11\/30 搭乘、10\/30 前開票/);
  assert.equal(f.promosFor('turkish').length, 0);
  assert.match(f.promosHtml(), /<h3 class="sub">哩程票特惠<\/h3>/);
});

test('promo watch: a new award sale touching the wallet goes out as 「新的哩程票特惠碰到你的計畫」', async () => {
  const sources = read('points.json').calc.sources;
  const sale = { id: 'sq-sale-test', type: 'award', bank: null, program: 'singapore', title: '新航測試特惠', discountPct: 30, start: '2026-10-15', end: '2026-10-31', travelFrom: '2026-11-01', travelTo: '2026-11-30', routes: [] };
  assert.ok(P6.promoTouches(sale, [], ['singapore'], '2026-10-16'), 'holds KrisFlyer miles');
  assert.ok(P6.promoTouches(sale, [sources.find((s) => s.id === 'ctbc-bonus')], [], '2026-10-16'), 'a bank that transfers in');
  assert.ok(!P6.promoTouches(sale, [], ['eva'], '2026-10-16'));
  const promos = [];
  const sent = [];
  const w = createPromoWatch({ kv: memoryKv(), promos, sources, holds: read('holds.json'), notify: async (h) => { sent.push(h); return true; }, now: () => Date.parse('2026-10-16T02:00:00Z') });
  await w.save({ on: true, banks: [], programs: ['singapore'] });
  promos.push(sale);
  const out = await w.run();
  assert.equal(out.fresh, 1);
  assert.match(sent[0], /✈️ <b>新的哩程票特惠碰到你的計畫<\/b>\n• 新航測試特惠（少 30%），11\/1–11\/30 搭乘、10\/31 前開票・你有這個計畫的哩程/);
  assert.doesNotMatch(sent[0], /轉點加贈/);
});

test('award sales routed by country wait for the airport list (a shared link opens without it)', () => {
  const f = featSandbox();
  assert.equal(f.awardSaleNeedsAirports([{ source: 'turkish' }]), true); // Türkiye is a country token
  assert.equal(f.awardSaleNeedsAirports([{ source: 'singapore' }]), false); // KrisFlyer lists airports
  assert.equal(f.awardSaleNeedsAirports([{ source: 'united' }]), false);
  assert.match(src('app.js'), /awardSaleNeedsAirports\(body\.results\)\)\)\) await loadAirports\(\);/);
});

// ---------- #17 Great Circle Mapper ----------
const P9 = require('../public/prog9.js');

test('gcmap: the route as one path, a comma where it breaks (open jaw or surface sector)', () => {
  assert.equal(P9.gcmapUrl([{ from: 'TPE', to: 'HKG' }, { from: 'HKG', to: 'LHR' }]), 'https://www.gcmap.com/mapui?P=TPE-HKG-LHR');
  assert.equal(P9.gcmapPath([{ from: 'tpe', to: 'nrt' }, { from: 'NRT', to: 'HND', surface: true }, { from: 'HND', to: 'TPE' }]), 'TPE-NRT,HND-TPE');
  assert.equal(P9.gcmapPath([{ from: 'TPE', to: 'HKG' }, { from: 'LHR', to: 'JFK' }]), 'TPE-HKG,LHR-JFK');
  assert.equal(P9.gcmapUrl([{ from: 'TPE', to: '' }, { from: 'X<Y', to: 'HKG' }]), '');
  // 航班明細, 中停／開口組合 and 環球票規劃 carry it; prog9.js comes with the tools.
  assert.match(src('app.js'), /typeof gcmapLinkHtml === 'function' \? gcmapLinkHtml\(t\.segments\)/);
  assert.match(src('etrips.js'), /gcmapLinkHtml\(legs\)/);
  assert.match(src('rtw.js'), /gcmapLinkHtml\(trip\.legs\)/);
  assert.match(src('app.js'), /const TOOL_SCRIPTS = \['rtw', 'award-tools', 'ewallet', 'prog9'\];/);
  const tools = src('prog9.js').match(/const P9_TOOLS = \[([\s\S]*?)\n {2}\];/)[1];
  for (const name of ['Great Circle Mapper', 'FlightConnections', 'wheretocredit', 'SeatMaps', 'AeroLOPA', 'CX Planner']) assert.ok(tools.includes(`'${name}'`), name);
  assert.match(src('prog9.js'), /<span class="tag tp">第三方<\/span>/);
});

// ---------- #21 recent changes and the weekly digest ----------
const dataSrc = () => ({
  promos: read('promos.json').promos, history: read('promos-history.json').promos, log: read('changes.json').log,
  changes: read('changes.json').changes, alliances: read('alliances.json').alliances, transfers: read('points.json').transfers,
});

test('changes.json log: dated entries with an official source', () => {
  const c = read('changes.json');
  assert.ok(c.log.length >= 2);
  for (const x of c.log) {
    assert.match(x.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(['rule', 'alliance'].includes(x.kind), x.title);
    assert.equal(x.confidence, 'official', x.title);
    assert.match(x.source.url, /^https:\/\//);
  }
});

test('recentChanges: promos started and ended, log entries, alliance notes and bank rates, split at today', () => {
  const s = {
    promos: [{ id: 'a', type: 'transfer', title: 'A 加贈', start: '2026-10-01', end: '2026-10-20', sources: [{ url: 'https://a.test' }] }, { id: 'b', type: 'award', title: 'B 特惠', start: '2026-11-01', end: '2026-11-10' }],
    history: [{ id: 'c', type: 'buy', title: 'C 買哩', start: '2026-08-01', end: '2026-10-10' }, { id: 'old', type: 'buy', title: 'Old', start: '2026-01-01', end: '2026-02-01' }],
    log: [{ date: '2026-10-05', kind: 'rule', title: 'R 規則', source: { url: 'https://r.test' } }, { date: '2026-06-01', kind: 'rule', title: 'Too old' }],
    changes: [{ date: '2026-11-01', title: 'Next 規則', pct: 7 }],
    alliances: [{ name: '星空聯盟 Star Alliance', memberNotes: [{ code: 'OZ', status: 'leaving', date: '2026-11-05', source: { url: 'https://s.test' } }, { code: 'PR', status: 'upcoming', date: null }] }],
    transfers: [{ bank: '台新', toName: '華航', validUntil: '2026-10-31' }, { bank: '台新', toName: '長榮', validUntil: '2026-10-31' }, { bank: 'X', toName: 'Y', validUntil: '2026-10-12' }],
  };
  const { past, next } = P9.recentChanges(s, '2026-10-16');
  assert.deepEqual(past.map((x) => `${x.date} ${x.kind} ${x.title}`), ['2026-10-12 rate X 轉Y的比率保證期限', '2026-10-10 end C 買哩', '2026-10-05 rule R 規則', '2026-10-01 start A 加贈']);
  assert.deepEqual(next.map((x) => `${x.date} ${x.kind} ${x.title}`), ['2026-10-20 end A 加贈', '2026-10-31 rate 台新 轉華航、長榮的比率保證期限', '2026-11-01 rule Next 規則', '2026-11-05 alliance OZ退出星空聯盟']);
  assert.equal(next[2].pct, 7);
  // Real data: the Asiana log entry and Taishin's rates running out show up.
  const real = P9.recentChanges(dataSrc(), '2026-10-16');
  assert.ok(real.past.some((x) => x.kind === 'alliance' && x.title.includes('韓亞')));
  assert.ok(real.next.some((x) => x.kind === 'rate' && x.title.startsWith('台新')));
});

test('weekly digest: the first run of each week, Telegram and mail, nothing twice', async () => {
  const { createWeekly, isoWeek } = require('../lib/weekly');
  assert.equal(isoWeek('2026-10-19'), '2026-W43');
  assert.equal(isoWeek('2026-10-18'), '2026-W42'); // Sunday still belongs to the week before
  assert.equal(isoWeek('2027-01-01'), '2026-W53');
  const kv = memoryKv();
  const sent = [];
  const mails = [];
  let t = Date.parse('2026-10-19T00:10:00Z'); // Monday 08:10 Taiwan time
  const w = createWeekly({ kv, src: dataSrc, notify: async (h) => { sent.push(h); return true; }, sendEmail: async (m) => { mails.push(m); }, emailOf: async () => 'owner@example.test', siteUrl: 'https://example.test', now: () => t });
  const r = await w.run();
  assert.equal(r.telegram, true);
  assert.equal(r.mailed, true);
  assert.ok(r.items > 0);
  assert.match(sent[0], /^🗓 <b>本週變動（10\/13–10\/19）<\/b>/);
  assert.match(sent[0], /<b>過去 7 天<\/b>/);
  assert.match(sent[0], /【比率】台新 轉/);
  assert.match(sent[0], /https:\/\/example\.test\/#rules$/);
  assert.equal(mails[0].to, 'owner@example.test');
  assert.match(mails[0].subject, /^【機票搜索雷達】本週變動 \d+ 項：/);
  t += 13 * 3600e3; // the evening run, same week
  assert.deepEqual(await w.run(), { already: '2026-W43' });
  t = Date.parse('2026-10-26T00:10:00Z');
  await w.run();
  assert.equal(sent.length, 2);
  // Not linked and no address: nothing is marked, so the next run tries again.
  const kv2 = memoryKv();
  const w2 = createWeekly({ kv: kv2, src: dataSrc, notify: async () => null, now: () => Date.parse('2026-10-19T00:10:00Z') });
  assert.equal((await w2.run()).noChannel, true);
  assert.equal(await kv2.get('weekly:v1:last'), null);
  assert.deepEqual(await createWeekly({ kv: kv2, src: dataSrc, off: true }).run(), { off: true });
  // server.js runs it with the daily cron (no new cron entry), right after the promo notice.
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(server, /'expiry,promos,weekly,deals,digest,watches,booked,alerts,hotels'/);
  assert.match(server, /emailOf: \(\) => promoWatch\.ownerEmail\(\)/);
  const crons = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8')).crons || [];
  assert.deepEqual(crons.map((c) => c.path), ['/api/alerts/run', '/api/cron/daily'], 'no new cron entry');
});

// ---------- #27 status match ----------
test('status match: official program pages only, with conditions and an end date (or none stated)', () => {
  const sm = read('programs.json').statusMatch;
  assert.ok(sm.offers.length >= 2);
  for (const o of sm.offers) {
    assert.equal(o.confidence, 'official', o.id);
    assert.match(o.source.url, /^https:\/\/www\.(delta|virginatlantic)\.com\//, o.id);
    assert.ok(o.needs.length && o.limits.length && o.keep && o.gives, o.id);
    assert.ok(o.ends === null || /^\d{4}-\d{2}-\d{2}$/.test(o.ends), o.id);
    assert.ok(o.endsNote, o.id);
  }
  assert.equal(sm.offers.find((o) => o.id === 'delta-challenge').ends, '2026-12-31');
});

// ---------- #28 official cash sales ----------
test('cash sales: official pages for the four carriers; the fold fills the form and never submits it', () => {
  const p = read('promos.json');
  assert.ok(Array.isArray(p.cashSales));
  assert.deepEqual(p.cashSalePages.map((x) => x.airline), ['BR', 'CI', 'JX', 'CX']);
  for (const x of p.cashSalePages) assert.match(x.url, /^https:\/\/[\w.]*(evaair|china-airlines|starlux-airlines|cathaypacific)\.com\//);
  for (const s of p.cashSales) assert.match(s.source.url, /^https:\/\//);
  const js = src('prog9.js');
  const fill = js.match(/function saleFill\(s, to\) \{[\s\S]*?\n {2}\}/)[0];
  assert.doesNotMatch(fill, /submit|requestSubmit|api\(/);
  assert.match(fill, /按「搜尋票價」才會查價/);
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.match(html, /<details class="promos cash-sales" id="cash-sales" hidden>/); // closed, and hidden until filled
});

// ---------- #29 before/after ----------
test('chart before/after: Aeroplan old values from the official notice, Asia Miles marked third-party', () => {
  const ac = read('charts.json').programs.find((p) => p.id === 'aeroplan');
  assert.equal(ac.before.source.official, true);
  assert.equal(ac.before.effective, '2026-06-01');
  const cells = ac.tables.flatMap((t) => t.pairs.flatMap((pr) => pr.bands.flatMap((b) => Object.entries(b.was || {}).map(([c, w]) => [`${pr.from}-${pr.to} ${b.upTo} ${c}`, b[c], w]))));
  assert.equal(cells.length, 41);
  for (const [k, now, was] of cells) assert.ok(now > 0 && was > 0 && now !== was, k);
  const get = (k) => cells.find((c) => c[0] === k);
  assert.deepEqual(get('PAC-NA 11000 J').slice(1), [102500, 87500]);
  assert.deepEqual(get('PAC-PAC null J').slice(1), [85000, 90000]); // some went down
  const am = read('asiamiles.json');
  assert.equal(am.before.confidence, 'secondary');
  assert.equal(am.charts.cx.long.J, 91000);
  assert.equal(am.before.cx.long.J, 88000);
  assert.equal(P9.p9Pct(91000, 88000), '+3%');
  assert.equal(P9.p9Pct(27000, 28000), '-4%');
  // 即將變更 says 「X 月起漲約 N%」 when changes.json gives pct.
  assert.match(src('ewallet.js'), /月起\$\{x\.pct > 0 \? '漲' : '降'\}約/);
});
