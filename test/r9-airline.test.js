// Round 9 airlines: 累積哩程試算 from each program's official earning chart (public/airinfo.js), the cash fare net of
// the miles' value, the business seat types and the 「只看平躺商務」 filter (public/airline.js), 今日好康's 「可能斜躺」
// (lib/seathint.js), 行李與貴賓室 and 航空公司小檔案, and the data behind them (data/accrual.json, seats.json,
// airline-info.json: official pages only). Own process: it starts the server for the two endpoints.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
delete process.env.SEATS_AERO_API_KEY;
delete process.env.CASH_PASSCODE;
delete process.env.CRON_SECRET;
delete process.env.MOCK;

const A = require('../public/airinfo.js');
const S = require('../public/airline.js');
const { seatHint, withSeatHints } = require('../lib/seathint');

const ROOT = path.join(__dirname, '..');
const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8'));
const src = (f) => fs.readFileSync(path.join(ROOT, 'public', f), 'utf8');
const accrual = read('accrual.json');
const seats = read('seats.json');
const info = read('airline-info.json');
const products = read('products.json').products;
const alliances = read('alliances.json');
const airlines = read('airlines.json');
const names = Object.fromEntries(read('airline-names.json').airlines.map(([c, zh]) => [c, zh]));
const plain = (x) => JSON.parse(JSON.stringify(x));
const seg = (carrier, from, to, dist, countries = []) => ({ carrier, from, to, dist, countries });
const rowOf = (rows, p) => rows.find((r) => r.program === p);

// ---------- 累積哩程試算 ----------
test('a percentage chart: the distance times the booking class\'s official %, programs with numbers first', () => {
  const rows = A.accrualRows(accrual, [seg('BR', 'TPE', 'NRT', 1330)], { BR: 'C' }, 'J');
  assert.equal(rowOf(rows, 'eva').hi, Math.round(1330 * 1.75)); // 長榮 C 175%
  assert.equal(rowOf(rows, 'eva').lo, rowOf(rows, 'eva').hi);
  assert.deepEqual(rowOf(rows, 'eva').pcts, [175]);
  assert.equal(rowOf(rows, 'turkish').hi, Math.round(1330 * 1.5));
  assert.equal(rowOf(rows, 'singapore').hi, Math.round(1330 * 1.25));
  assert.equal(rows[0].program, 'eva');
  // United and Aeroplan: no readable official chart, so no numbers, last, with the official page.
  const pend = rows.filter((r) => r.pending);
  assert.deepEqual(pend.map((r) => r.program).sort(), ['aeroplan', 'united']);
  assert.ok(rows.slice(-2).every((r) => r.pending));
  for (const r of pend) assert.match(r.pending.source.url, /^https:\/\//);
  assert.equal(rows.find((r) => r.pending).hi, 0);
});

test('「還不知道」: the range over every booking code of the cabin', () => {
  const rows = A.accrualRows(accrual, [seg('BR', 'TPE', 'LAX', 6781)], {}, 'J');
  const eva = rowOf(rows, 'eva');
  assert.equal(eva.lo, Math.round(6781 * 1.25)); // D
  assert.equal(eva.hi, Math.round(6781 * 1.75)); // C
  assert.deepEqual(eva.pcts, [125, 150, 175]);
  // Economy on 華航: the official table lists L at 0%, so the range starts at nothing.
  const ci = rowOf(A.accrualRows(accrual, [seg('CI', 'TPE', 'NRT', 1330)], {}, 'Y'), 'ci');
  assert.equal(ci.lo, 0);
  assert.equal(ci.hi, 1330);
  // A code the chart leaves out earns nothing.
  assert.equal(rowOf(A.accrualRows(accrual, [seg('CI', 'TPE', 'NRT', 1330)], { CI: 'L' }, 'Y'), 'ci').hi, 0);
  assert.equal(rowOf(A.accrualRows(accrual, [seg('CI', 'TPE', 'NRT', 1330)], { CI: 'O' }, 'Y'), 'korean').hi, 0);
});

test('Asia Miles on Cathay: fixed miles by distance band; Japan, India… use short-haul 2', () => {
  const am = accrual.carriers.CX.earn.find((r) => r.program === 'asiamiles');
  const z = (d, c) => A.accZone(am.zones, d, c);
  assert.equal(z(500, ['TW', 'HK']), 0);
  assert.equal(z(750, ['TW', 'HK']), 0);
  assert.equal(z(751, ['HK', 'TH']), 1);
  assert.equal(z(1800, ['HK', 'JP']), 2);
  assert.equal(z(1800, ['HK', 'KR']), 1);
  assert.equal(z(4000, ['HK', 'AU']), 3);
  assert.equal(z(6000, ['HK', 'GB']), 4);
  assert.equal(z(8000, ['HK', 'US']), 5);
  // J is a Flex fare only; Y has Flex, Essential and Light, so the code alone gives a range.
  assert.deepEqual(plain(A.accSegEarn(am, 'J', seg('CX', 'HKG', 'NRT', 1823, ['HK', 'JP']))), { lo: 5000, hi: 5000, zone: 2 });
  assert.deepEqual(plain(A.accSegEarn(am, 'Y', seg('CX', 'HKG', 'NRT', 1823, ['HK', 'JP']))), { lo: 1800, hi: 3500, zone: 2 });
  assert.deepEqual(plain(A.accSegEarn(am, 'G', seg('CX', 'HKG', 'NRT', 1823, ['HK', 'JP']))), { lo: 0, hi: 0, zone: 2 });
  const rows = A.accrualRows(accrual, [seg('CX', 'TPE', 'HKG', 501, ['TW', 'HK']), seg('CX', 'HKG', 'LHR', 5990, ['HK', 'GB'])], { CX: 'C' }, 'J');
  const r = rowOf(rows, 'asiamiles');
  assert.equal(r.zone, true);
  assert.equal(r.hi, 3000 + 13000);
});

test('a minimum per flight and the codes it skips (British Airways on Cathay); a route exception (American)', () => {
  const ba = accrual.carriers.CX.earn.find((r) => r.program === 'british');
  assert.equal(A.accSegEarn(ba, 'J', seg('CX', 'HKG', 'MFM', 200)).hi, 500); // 125% of 200, raised to the minimum
  assert.equal(A.accSegEarn(ba, 'K', seg('CX', 'HKG', 'MFM', 200)).hi, 50); // 25%, no minimum for K
  assert.equal(A.accSegEarn(ba, 'G', seg('CX', 'HKG', 'MFM', 200)).hi, 0); // not on the chart: nothing, not the minimum
  const aa = accrual.carriers.CX.earn.find((r) => r.program === 'american');
  assert.equal(A.accSegEarn(aa, 'W', seg('CX', 'HKG', 'BKK', 1049)).hi, 1049); // HKG–BKK W: 100%
  assert.equal(A.accSegEarn(aa, 'W', seg('CX', 'BKK', 'HKG', 1049)).hi, 1049); // either way
  assert.equal(A.accSegEarn(aa, 'W', seg('CX', 'HKG', 'TPE', 501)).hi, Math.round(501 * 1.1));
  assert.equal(A.accSegEarn({ pending: true }, 'J', seg('CX', 'HKG', 'TPE', 501)), null);
});

test('two airlines on one ticket: each program counts the flights it has a chart for and says which it left out', () => {
  const rows = A.accrualRows(accrual, [seg('BR', 'TPE', 'HKG', 501), seg('CX', 'HKG', 'LHR', 5990, ['HK', 'GB'])], {}, 'J');
  assert.deepEqual(rowOf(rows, 'eva').missing, ['CX']);
  assert.deepEqual(rowOf(rows, 'asiamiles').missing, ['BR']);
  assert.equal(rowOf(rows, 'eva').hi, Math.round(501 * 1.75));
  // Alaska credits both but has no readable chart for either.
  assert.ok(rowOf(rows, 'alaska').pending);
  // A flight without a distance counts nothing (and does not throw).
  assert.equal(rowOf(A.accrualRows(accrual, [seg('BR', 'TPE', 'XXX', null)], {}, 'J'), 'eva').hi, 0);
  // An airline without a chart gives no rows (the calculator shows the official links instead).
  assert.deepEqual(A.accrualRows(accrual, [seg('SQ', 'TPE', 'SIN', 2017)], {}, 'J'), []);
});

test('the fare net of the miles\' value; routes typed as codes; flights to carriers; nonstops from Taiwan', () => {
  assert.deepEqual(A.accNetFare({ lo: 1000, hi: 1500 }, 0.5, 30000), { valueLo: 500, valueHi: 750, netLo: 29250, netHi: 29500 });
  assert.deepEqual(A.accNetFare({ lo: 1000, hi: 1000 }, 2, 1000), { valueLo: 2000, valueHi: 2000, netLo: 0, netHi: 0 });
  assert.deepEqual(A.accParseRoute('tpe-hkg-lhr'), ['TPE', 'HKG', 'LHR']);
  assert.deepEqual(A.accParseRoute(' TPE → NRT '), ['TPE', 'NRT']);
  assert.deepEqual(A.accParseRoute('TPE NRT'), ['TPE', 'NRT']);
  for (const bad of ['TPE', 'TPE-HK', 'TPE-NRT-1', 'A-B', '', 'TPE-HKG-BKK-SIN-KUL-CGK-DPS']) assert.equal(A.accParseRoute(bad), null, bad);
  assert.deepEqual(plain(A.accLegSegments('BR 867 / CX 255', ['TPE', 'HKG', 'LHR'])), [{ carrier: 'BR', from: 'TPE', to: 'HKG' }, { carrier: 'CX', from: 'HKG', to: 'LHR' }]);
  assert.deepEqual(plain(A.accLegSegments('BR 12', ['TPE', 'LAX', 'JFK'])).map((s) => s.carrier), ['BR', 'BR']);
  assert.deepEqual(plain(A.accLegSegments('', ['TPE', 'NRT'])), [{ carrier: '', from: 'TPE', to: 'NRT' }]);
  // Pairs are kept once, under either airport; Taiwan–Taiwan pairs are not nonstops abroad.
  const routes = { HKG: 'KHH:CX TPE:BRCX', KHH: 'TPE:CX', NRT: 'TPE:BRJL', TPE: 'TSA:BR' };
  assert.deepEqual(plain(A.alNonstopsFrom(routes, 'CX')), [{ from: 'TPE', to: 'HKG' }, { from: 'KHH', to: 'HKG' }]);
  assert.deepEqual(plain(A.alNonstopsFrom(routes, 'BR')), [{ from: 'TPE', to: 'HKG' }, { from: 'TPE', to: 'NRT' }]);
  const real = A.alNonstopsFrom(read('rtw-routes.json').routes, 'CX');
  assert.ok(real.some((x) => x.from === 'TPE' && x.to === 'HKG'));
});

// ---------- 商務艙座椅 ----------
test('seat types: lookup by airline and aircraft, labels, and what a result\'s fleet adds up to', () => {
  assert.equal(S.seatTypeOf(seats, 'BR', '77W').type, 'flat');
  assert.equal(S.seatTypeLabel(S.seatTypeOf(seats, 'br', '77w')), '平躺・反魚骨');
  assert.equal(S.seatTypeLabel(S.seatTypeOf(seats, 'JL', '77W')), '平躺・直通走道');
  assert.equal(S.seatTypeLabel(S.seatTypeOf(seats, 'BR', '333')), '斜躺');
  assert.equal(S.seatTypeLabel(S.seatTypeOf(seats, 'CX', '333')), '平躺或斜躺');
  assert.equal(S.seatTypeOf(seats, 'BR', '321'), null);
  assert.equal(S.seatTypeOf(seats, 'SQ', '359'), null);
  const kind = (fleet, prods = []) => S.fleetSeat(seats, prods, fleet).kind;
  assert.equal(kind(['BR:77W', 'BR:789']), 'flat');
  assert.equal(kind(['BR:77W', 'BR:333']), 'mixed');
  assert.equal(kind(['BR:333', 'CX:773']), 'recliner');
  assert.equal(kind(['BR:333', 'SQ:359']), 'some');
  assert.equal(kind(['BR:77W', 'SQ:359']), 'unknown');
  assert.equal(kind([]), 'unknown');
  // A premium product (third-party summary) counts as flat when the airline's own pages say nothing, marked.
  assert.deepEqual(plain(S.fleetSeat(seats, products, ['BR:77W', 'JX:359'])), { kind: 'flat', third: true });
  assert.deepEqual(plain(S.fleetSeat(seats, products, ['BR:77W'])), { kind: 'flat', third: false });
});

test('今日好康: 「可能斜躺」 only on short-haul business deals on airlines whose own pages list regional recliners', () => {
  const h = seatHint(seats, names, 'BR', 'jk', 'J');
  assert.equal(h.label, '可能斜躺');
  assert.match(h.note, /長榮航空 A330-300/);
  assert.match(seatHint(seats, names, 'CX, JL', 'sea', 'J').note, /國泰航空 .*A330-300（部分）.*；日本航空 /);
  assert.equal(seatHint(seats, names, 'BR', 'na', 'J'), null); // long-haul
  assert.equal(seatHint(seats, names, 'BR', 'jk', 'Y'), null);
  assert.equal(seatHint(seats, names, 'SQ', 'sea', 'J'), null); // nothing official
  assert.equal(seatHint(seats, names, '', 'sea', 'J'), null);
  const d = { groups: [{ id: 'jk', cabin: 'J', items: [{ airlines: 'JL' }, { airlines: 'KE' }] }, { id: 'eu', cabin: 'J', items: [{ airlines: 'BR' }] }] };
  const out = withSeatHints(d, seats, names);
  assert.deepEqual(out.groups.map((g) => g.items.map((x) => Boolean(x.seat))), [[true, false], [false]]);
  assert.equal(d.groups[0].items[0].seat, undefined, 'the saved deals stay as they are');
  assert.equal(withSeatHints(null, seats, names), null);
});

// ---------- the data: official pages only ----------
const OFFICIAL = /^https:\/\/([\w-]+\.)*(evaair|china-airlines|starlux-airlines|cathaypacific|united|aircanada|singaporeair|ana\.co|turkishairlines|flyingblue|delta|koreanair|virginatlantic|alaskaair|aa|britishairways|jal\.co|qantas|oneworld|staralliance|skyteam|vietnamairlines)\.(com|co\.jp|jp|tw)\//;
test('data/accrual.json: each chart comes from the program\'s own site, dated; the third-party site is only a link', () => {
  assert.match(accrual.lastReviewed, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(accrual.wheretocredit, 'https://wheretocredit.com/en/');
  assert.doesNotMatch(JSON.stringify(accrual.carriers), /wheretocredit/i);
  for (const [c, C] of Object.entries(accrual.carriers)) {
    assert.match(c, /^[A-Z0-9]{2}$/);
    const letters = Object.values(C.cabins || {}).join('');
    assert.equal(new Set(letters).size, letters.length, `${c}: a booking code in one cabin only`);
    for (const r of C.earn) {
      const at = `${c} ${r.program}`;
      assert.ok(accrual.programs[r.program], at);
      assert.match(r.source.url, OFFICIAL, at);
      if (r.pending) { assert.ok(!r.rates && !r.rows, `${at}: no numbers while pending`); continue; }
      assert.match(r.checked, /^\d{4}-\d{2}-\d{2}$/, at);
      if (r.kind === 'zone') {
        for (const row of r.rows) {
          assert.equal(row.miles.length, r.zones.length, at);
          for (const l of row.classes) assert.ok(letters.includes(l), `${at}: ${l}`);
          for (const m of row.miles) assert.ok(Number.isInteger(m) && m > 0, at);
        }
      } else {
        assert.ok(Object.keys(r.rates).length >= 5, at);
        for (const [l, pct] of Object.entries(r.rates)) {
          assert.ok(letters.includes(l), `${at}: ${l} is one of ${c}'s codes`);
          assert.ok(Number.isInteger(pct) && pct >= 0 && pct <= 200, `${at}: ${l} ${pct}`);
        }
        for (const l of r.zero || '') assert.ok(!r.rates[l], `${at}: ${l} listed as not earning`);
      }
    }
  }
  // Every route-search airline the chart covers is one the site knows.
  for (const c of Object.keys(accrual.carriers)) assert.ok(names[c], c);
});

test('data/seats.json and data/airline-info.json: quoted from official pages, nothing invented', () => {
  assert.deepEqual(Object.keys(seats.types).sort(), ['flat', 'mixed', 'recliner']);
  for (const [c, X] of Object.entries(seats.airlines)) {
    assert.ok(names[c], c);
    for (const s of X.sources) assert.match(s.url, /^https:\/\//, c);
    for (const e of X.J) {
      assert.ok(seats.types[e.type], `${c} ${e.ac}`);
      assert.ok(X.sources[e.src], `${c} ${e.ac}: source`);
      assert.ok(e.quote.length > 10, `${c} ${e.ac}: the official wording`);
      for (const ac of e.ac) assert.match(ac, /^[A-Z0-9]{3}$/);
      if (e.regional) assert.notEqual(e.type, 'flat', `${c} ${e.ac}: regional means a recliner somewhere`);
    }
    // One entry per aircraft code.
    const acs = X.J.flatMap((e) => e.ac);
    assert.equal(new Set(acs).size, acs.length, c);
  }
  // The airlines still waiting for their official seat pages are listed (shown in the report, not on the page).
  assert.ok(seats.pending.length >= 5);
  const urls = [];
  const walk = (x) => { if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { if (k === 'url') urls.push(v); else walk(v); } };
  walk(info);
  assert.ok(urls.length >= 12);
  for (const u of urls) assert.match(u, OFFICIAL, u);
  for (const id of Object.keys(info.alliances)) assert.ok(alliances.alliances.some((a) => a.id === id), id);
  for (const [c, X] of Object.entries(info.airlines)) {
    assert.ok(names[c], c);
    for (const r of X.rules || []) assert.ok(r.text && r.quote, c);
  }
});

// ---------- drawing (airinfo.js in a sandbox with the page's helpers stubbed) ----------
function sandbox(extra = {}) {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const ctx = {
    console, esc, fmt: (n) => Number(n).toLocaleString('en-US'),
    data: {
      airlineInfo: { accrual, info }, seats, alliances, airlines, products: { products },
      trips: read('trips.json'), callcenters: read('callcenters.json'), programs: read('programs.json'), milecost: read('milecost.json'),
    },
    CABIN_LABEL: { Y: '經濟艙', W: '豪華經濟艙', J: '商務艙', F: '頭等艙' },
    airlineZh: (c) => names[c] || c, airlineLogo: () => '', allianceLogo: () => '', airportCity: (c) => c,
    programName: (k) => k, srcName: (k) => k, programKeyOf: (k) => k, productList: () => products, seatTypeLabel: S.seatTypeLabel,
    perMileOf: () => 0.5, costOverrides: () => ({}), store: { get: (k, d) => (k === 'walletGoal:v1' ? extra.goal || d : d) },
    wallet: { miles: extra.miles || {} }, walletEmpty: () => true,
    cash: { req: { cabin: 'J', adults: 1 } },
    ...extra.ctx,
  };
  vm.createContext(ctx);
  vm.runInContext(`${src('airinfo.js')}\nthis.X = { accCalcHtml, accNetHtml, accSummary, alSheetHtml, alBagHtml, accRowHtml };`, ctx);
  return ctx.X;
}

test('the calculator draws rows, 官方資料待補 and the third-party link; the net fare and the 🎯 goal', () => {
  const X = sandbox({ goal: { key: 'eva', miles: 50000 }, miles: { eva: 40000 } });
  const st = { segs: [seg('BR', 'TPE', 'NRT', 1330, ['TW', 'JP'])], cabin: 'J', picks: { BR: 'C' }, sel: '', price: 30000, pax: 1, net: true };
  const html = X.accCalcHtml(st, '1');
  assert.match(html, /長榮 無限萬哩遊/);
  assert.match(html, /<b>2,328<\/b> 哩/);
  assert.match(html, /官方資料待補/);
  assert.match(html, /wheretocredit\.com\/en\/BR" target="_blank" rel="noopener">wheretocredit\.com ↗<\/a><sup class="mk-3p"[^>]*>\*<\/sup>（第三方整理，以官網為準）/);
  assert.match(html, /還不知道/);
  // The 🎯 goal's program (also the most miles here): 2,328 × 0.5 = NT$1,164 off NT$30,000.
  assert.equal(st.sel, 'eva');
  assert.match(html, /累積到 <b>長榮 無限萬哩遊<\/b> 約 2,328 哩，約值 NT\$1,164（每哩成本 NT\$0\.5）→ 實際約 <b>NT\$28,836<\/b>/);
  assert.match(html, /🎯 飛完離你的目標（我的點數 › 🎯 eva 50,000 哩）還差 <b>7,672<\/b> 哩/);
  assert.match(X.accSummary(st), /^最多約 2,328 哩（長榮 無限萬哩遊）・扣掉哩程價值實際約 NT\$28,836$/);
  // No price (我的行程, 點數換算器): no net line.
  assert.doesNotMatch(X.accCalcHtml({ ...st, net: false }, '2'), /實際約/);
  // A goal in another program it earns: that row is the one priced; without a goal, the most miles.
  const Y = sandbox({ goal: { key: 'ana', miles: 50000 } });
  const st2 = { ...st, sel: '' };
  Y.accCalcHtml(st2, '3');
  assert.equal(st2.sel, 'ana');
  assert.match(Y.accSummary(st2), /^最多約 2,328 哩（長榮 無限萬哩遊）・累積到全日空 ANA Mileage Club，扣掉哩程價值實際約 NT\$29,168$/);
  const st3 = { ...st, sel: '' };
  sandbox().accCalcHtml(st3, '4');
  assert.equal(st3.sel, 'eva');
});

test('航空公司小檔案 and 行李與貴賓室 draw for airlines with and without data', () => {
  const X = sandbox();
  const cx = X.alSheetHtml('CX');
  for (const h of ['聯盟', '可以用哪些計畫換', '商務艙座椅', '從台灣直飛', '現金票累積到哪裡', '行李與貴賓室']) assert.match(cx, new RegExp(`<h3>${h}</h3>`), h);
  assert.doesNotMatch(cx, /線上報到/, 'no official check-in hours in data/trips.json: the section is left out');
  const br = X.alSheetHtml('BR');
  assert.match(br, /<h3>線上報到<\/h3><p>起飛前 48 小時開放/);
  assert.match(br, /eva・自家/);
  assert.match(cx, /asiamiles・自家/);
  assert.match(cx, /<h3>客服<\/h3><p><a href="https:\/\/www\.cathaypacific\.com\/[^"]*contact-us[^"]*"[^>]*>Cathay Asia Miles：聯絡我們（官方） ↗<\/a>/);
  assert.match(X.alSheetHtml('AA'), /<h3>客服電話<\/h3><ul class="als-list"><li><a href="tel:\+18008828880">/);
  assert.match(cx, /data-acc-go="CX"/);
  assert.match(cx, /寰宇一家 oneworld 的貴賓室/);
  const sq = X.alSheetHtml('SQ');
  assert.match(sq, /累積比例還沒整理/);
  assert.match(sq, /wheretocredit\.com ↗<\/a><sup class="mk-3p"[^>]*>\*<\/sup>（第三方）/);
  assert.match(X.alSheetHtml('ZZ'), /沒有加入航空聯盟/);
  const bag = X.alBagHtml([{ c: 'NH', cabin: 'J' }, { c: 'BR', cabin: 'Y' }]);
  assert.match(bag, /全日空：國際線行李（官方）/);
  assert.match(bag, /according to the standards of the higher class/);
  assert.match(bag, /實際營運・經濟艙/);
  assert.match(bag, /data-al="NH"/);
  assert.match(bag, /最主要航空公司/); // several airlines: the IATA baggage rule
  assert.match(X.alBagHtml([{ c: 'SQ', cabin: 'J' }]), /還沒整理/);
});

// ---------- the page ----------
test('wiring: lazy scripts, typeof-guarded hooks, seats in the `more` bundle, one CSS block', () => {
  const html = src('index.html');
  for (const f of ['airline', 'airinfo']) assert.doesNotMatch(html, new RegExp(`<script src="/${f}\\.js`), f);
  const app = src('app.js');
  for (const hook of ['flatOk', 'flatToolsHtml', 'fleetTagHtml', 'flatFiltering', 'seatTagHtml', 'alTripMount', 'accrualToolHtml']) assert.match(app, new RegExp(`typeof ${hook} [!=]== 'function'`), hook);
  assert.match(app, /const DATA_MORE = \[[^\]]*'seats'\]/);
  assert.match(app, /const DATA_OPTIONAL = \[[^\]]*'seats'\]/);
  assert.match(src('trips.js'), /loadScripts\(\[\.\.\.TOOL_SCRIPTS, 'airinfo'\]\)/);
  // Classic scripts share one global scope: none of the new names may shadow another script's (calcHtml once did).
  const own = (f) => [...src(f).matchAll(/^(?:async\s+)?(?:function\s+([\w$]+)|(?:const|let|var)\s+([\w$]+))/gm)].map((m) => m[1] || m[2]);
  const others = fs.readdirSync(path.join(ROOT, 'public')).filter((f) => f.endsWith('.js') && !['airinfo.js', 'airline.js'].includes(f));
  const taken = new Set(others.flatMap(own));
  for (const f of ['airinfo.js', 'airline.js']) for (const n of own(f)) assert.ok(!taken.has(n), `${f}: ${n} is declared elsewhere too`);
  assert.deepEqual(own('airinfo.js').filter((n) => own('airline.js').includes(n)), []);
  const css = src('styles.css');
  assert.equal(css.split('/* round 9: r9-airline */').length, 2);
  assert.ok(css.indexOf('/* round 9: r9-airline */') > css.length - 30000, 'at the end');
});

const { server } = require('../server');
let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

test('server: /api/data/airlineinfo, the seats in `more`, and 今日好康 with 「可能斜躺」', async () => {
  const res = await fetch(`${base}/api/data/airlineinfo`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('etag') || '', /./);
  const d = await res.json();
  assert.deepEqual(d.accrual.carriers.CX.cabins, accrual.carriers.CX.cabins);
  assert.ok(d.info.alliances.oneworld);
  const more = await fetch(`${base}/api/data/more`).then((r) => r.json());
  assert.deepEqual(Object.keys(more.seats.airlines), Object.keys(seats.airlines));
  const core = await fetch(`${base}/api/data/core`).then((r) => r.json());
  assert.equal(core.seats, undefined, 'not on the first screen');
  const deals = await fetch(`${base}/api/deals`).then((r) => r.json());
  const recl = new Set(Object.entries(seats.airlines).filter(([, X]) => X.J.some((e) => e.regional)).map(([c]) => c));
  let tagged = 0;
  for (const g of deals.groups) {
    for (const x of g.items) {
      const short = g.cabin === 'J' && ['jk', 'sea'].includes(g.id);
      const want = short && String(x.airlines).split(/[,\s]+/).some((c) => recl.has(c));
      assert.equal(Boolean(x.seat), want, `${g.id} ${g.cabin} ${x.airlines}`);
      if (x.seat) tagged++;
    }
  }
  assert.ok(tagged >= 0);
});
