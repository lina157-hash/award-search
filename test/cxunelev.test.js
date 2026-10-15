// 國泰哩程日曆 外掛模式: reading the 「Unelevated Award Search」 userscript's batch results (text transcribed from the
// owner's screenshots), the v2 export with several routes, and the store accepting its seat counts.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const CX = require('../public/cxcal.js');
const { validatePayload, CxcalError } = require('../lib/cxcal-store');

// Date → route → chips, as on the screenshots (2/13–2/16); 2/17 is made up: NRT with economy only, KIX with nothing.
const H = 'HKG';
const SHOTS = {
  '2027-02-13 Sat': {
    'TPE - NRT': ['CX450 J1', `CX461 ${H} CX500 J3 Y9`, `CX489 ${H} CX500 J3 Y9`, `CX499 ${H} CX500 J3 Y9`, `CX469 ${H} CX504 J2 Y9`, `CX479 ${H} CX504 J2 Y9`, `CX531 ${H} CX504 J2 Y9`],
    'TPE - KIX': ['CX564 J1', `CX495 ${H} CX502 J6 Y9`, `CX499 ${H} CX598 J3 Y6`, `CX469 ${H} CX566 J1 Y9`, `CX461 ${H} CX502 J6 Y9`, `CX479 ${H} CX566 J1 Y9`, `CX407 ${H} CX598 J3 Y6`, `CX531 ${H} CX566 J1 Y9`, `CX489 ${H} CX502 J5 Y9`, `CX469 ${H} CX596 J3 Y6`, `CX479 ${H} CX596 J3 Y6`, `CX531 ${H} CX596 J3 Y6`, `CX469 ${H} CX506 J4 Y9`, `CX479 ${H} CX506 J4 Y9`, `CX531 ${H} CX506 J4 Y9`],
  },
  '2027-02-14 Sun': {
    'TPE - NRT': [`CX479 ${H} CX526 J1 Y3`, `CX479 ${H} CX504 J4 Y9`, `CX531 ${H} CX526 J1 Y3`, `CX531 ${H} CX504 J4 Y9`],
    'TPE - KIX': ['CX564 J2', `CX495 ${H} CX502 J6 Y9`, `CX469 ${H} CX566 J2 Y9`, `CX461 ${H} CX502 J6 Y9`, `CX479 ${H} CX566 J2 Y9`, `CX407 ${H} CX598 J3 Y9`, `CX531 ${H} CX566 J2 Y9`, `CX489 ${H} CX502 J6 Y9`, `CX469 ${H} CX596 J2 Y9`, `CX479 ${H} CX596 J2 Y9`, `CX531 ${H} CX596 J2 Y9`, `CX469 ${H} CX506 J2 Y9`, `CX479 ${H} CX506 J2 Y9`, `CX531 ${H} CX506 J2 Y9`],
  },
  '2027-02-15 Mon': {
    'TPE - NRT': [`CX461 ${H} CX500 J4 Y9`, `CX469 ${H} CX524 Y9`, `CX479 ${H} CX524 Y9`, `CX489 ${H} CX500 J4 Y9`, `CX531 ${H} CX524 Y9`, `CX499 ${H} CX500 J4 Y9`, `CX469 ${H} CX526 Y9`, `CX469 ${H} CX504 J4 Y9`, `CX479 ${H} CX526 Y9`, `CX479 ${H} CX504 J4 Y9`, `CX531 ${H} CX526 Y9`, `CX531 ${H} CX504 J4 Y9`],
    'TPE - KIX': ['CX564 J2 Y3', `CX495 ${H} CX502 J3 Y9`, `CX499 ${H} CX598 J1 Y9`, `CX469 ${H} CX566 J1 Y9`, `CX461 ${H} CX502 J3 Y9`, `CX479 ${H} CX566 J1 Y9`, `CX407 ${H} CX598 J1 Y9`, `CX531 ${H} CX566 J1 Y9`, `CX489 ${H} CX502 J3 Y9`, `CX469 ${H} CX596 J2 Y9`, `CX479 ${H} CX596 J2 Y9`, `CX531 ${H} CX596 J2 Y9`, `CX469 ${H} CX506 J3 Y9`, `CX479 ${H} CX506 J3 Y9`, `CX531 ${H} CX506 J3 Y9`],
  },
  '2027-02-16 Tue': {
    'TPE - NRT': ['CX450 J2 Y5', `CX461 ${H} CX500 J6 Y9`, `CX489 ${H} CX500 J6 Y9`, `CX407 ${H} CX500 J6 Y9`, `CX469 ${H} CX526 Y1`, `CX469 ${H} CX504 J1 Y9`, `CX479 ${H} CX526 Y1`, `CX479 ${H} CX504 J1 Y9`, `CX531 ${H} CX526 Y1`, `CX531 ${H} CX504 J1 Y9`],
    'TPE - KIX': ['CX564 J1 Y1', `CX495 ${H} CX502 J3 Y9`, `CX469 ${H} CX566 J1 Y6`, `CX461 ${H} CX502 J3 Y9`, `CX479 ${H} CX566 J1 Y6`, `CX407 ${H} CX598 J3 Y9`, `CX531 ${H} CX566 J1 Y6`, `CX489 ${H} CX502 J3 Y9`, `CX469 ${H} CX596 Y9`, `CX479 ${H} CX596 Y9`, `CX531 ${H} CX596 Y9`, `CX469 ${H} CX506 J4 Y9`, `CX479 ${H} CX506 J4 Y9`, `CX531 ${H} CX506 J4 Y9`],
  },
  '2027-02-17 Wed': {
    'TPE - NRT': [`CX469 ${H} CX524 Y9`, `CX479 ${H} CX524 Y2`],
    'TPE - KIX': [],
  },
};

// innerText of the panel. layout: 'line' (a chip per line), 'split' (every chip part on its own line, as flex items
// come out of innerText) or 'row' (a section's chips on one line).
function panelText(shots = SHOTS, layout = 'line', err = true) {
  const chip = (c) => (layout === 'split' ? `${c.replace(/\b([FJWY])(\d)\b/g, '$1\n$2').split(' ').join('\n')}\n›` : `${c} ›`);
  const out = ['Unelevated Award Search', '♥ 0', 'From', 'To', 'Date', 'Adults', 'Children', '搜尋', '這工具有幫到你嗎？歡迎請我喝杯咖啡呀！', '直飛 頭等 商務 豪經 經濟', '日期\t可兌換航班 頭等 商務 豪經 經濟'];
  for (const [d, routes] of Object.entries(shots)) {
    const [iso, wd] = d.split(' ');
    out.push(iso, wd);
    for (const [rt, chips] of Object.entries(routes)) {
      out.push(`♥ ${rt}\tBook »`);
      if (layout === 'row') out.push(chips.map(chip).join(' '));
      else chips.forEach((c) => out.push(chip(c)));
    }
  }
  out.push('批次搜尋 20 天可兌換航班');
  if (err) out.push('Error: 無法取得金鑰，請試著登出再重新登入。 (Login)');
  return out.join('\n');
}

test('cxunelev: the userscript results give every route and date with seats per cabin', () => {
  const u = CX.parseUnelevatedText(panelText(), { from: 'TPE', to: 'NRT,KIX', date: '20270213' });
  assert.equal(u.found, true);
  assert.deepEqual(u.dates, ['2027-02-13', '2027-02-14', '2027-02-15', '2027-02-16', '2027-02-17']);
  assert.deepEqual(u.routes.map((r) => `${r.fc}>${r.tc}`), ['TPE>NRT', 'TPE>KIX']);
  const [nrt, kix] = u.routes;
  const d13 = nrt.days['2027-02-13'].c;
  assert.deepEqual(Object.keys(d13).sort(), ['J', 'Y']);
  assert.deepEqual([d13.J.seats, d13.J.n, d13.J.nonstop], [3, 7, true]);
  assert.deepEqual([d13.Y.seats, d13.Y.n, d13.Y.nonstop], [9, 6, false]);
  assert.deepEqual(d13.J.f[0], { n: 'CX450', p: 'TPE-NRT', s: 0, q: { J: 1 } });
  assert.deepEqual(d13.J.f[1], { n: 'CX461›CX500', p: 'TPE-HKG-NRT', s: 1, q: { J: 3, Y: 9 } });
  assert.deepEqual(d13.Y.f[0], { n: 'CX461›CX500', p: 'TPE-HKG-NRT', s: 1, q: { J: 3, Y: 9 } });
  // The nonstop CX564 J2 Y3 on 2/15 comes first; no nonstop to Narita that day.
  assert.deepEqual(kix.days['2027-02-15'].c.Y.f[0], { n: 'CX564', p: 'TPE-KIX', s: 0, q: { J: 2, Y: 3 } });
  assert.deepEqual([kix.days['2027-02-15'].c.J.seats, kix.days['2027-02-15'].c.J.n, kix.days['2027-02-15'].c.Y.n], [3, 15, 15]);
  assert.equal(nrt.days['2027-02-15'].c.J.nonstop, false);
  assert.equal(nrt.days['2027-02-16'].c.Y.nonstop, true);
  assert.equal(nrt.days['2027-02-16'].c.Y.n, 10);
  // A date with economy only; a route with no chips that day has no seats.
  assert.deepEqual(nrt.days['2027-02-17'], { c: { Y: { seats: 9, n: 2, nonstop: false, f: [{ n: 'CX469›CX524', p: 'TPE-HKG-NRT', s: 1, q: { Y: 9 } }, { n: 'CX479›CX524', p: 'TPE-HKG-NRT', s: 1, q: { Y: 2 } }] } } });
  assert.deepEqual(kix.days['2027-02-17'], { na: 1 });
  // The error line: the batch stopped, so the rest of the 20 days are missing.
  assert.match(u.err, /^無法取得金鑰/);
  assert.equal(u.missing.length, 15);
  assert.deepEqual([u.missing[0], u.missing.at(-1)], ['2027-02-18', '2027-03-04']);
});

test('cxunelev: the same answer whatever way innerText breaks the chips, and without form hints', () => {
  const want = JSON.stringify(CX.parseUnelevatedText(panelText(SHOTS, 'line')).routes);
  assert.equal(JSON.stringify(CX.parseUnelevatedText(panelText(SHOTS, 'split')).routes), want);
  assert.equal(JSON.stringify(CX.parseUnelevatedText(panelText(SHOTS, 'row')).routes), want);
  const u = CX.parseUnelevatedText(panelText(SHOTS, 'line', false));
  assert.deepEqual([u.err, u.missing], ['', []]);
  // Without hints the batch is taken to start at the first date shown.
  assert.equal(CX.parseUnelevatedText(panelText()).missing[0], '2027-02-18');
});

test('cxunelev: cabin filters, the 20-flight cap, routes from the form and pages without the panel', () => {
  // Only 商務 ticked: other cabins are not recorded, and a day without business chips is 「不適用」 for business only.
  const j = CX.parseUnelevatedText(panelText(), { cabins: 'J' });
  assert.deepEqual(Object.keys(j.routes[0].days['2027-02-13'].c), ['J']);
  assert.deepEqual(j.routes[0].days['2027-02-17'], { c: { J: { na: 1 } } });
  // 25 chips: counts stay exact, flights are capped at 20 a day (nonstop first).
  const many = { '2027-03-01 Mon': { 'TPE - HKG': [...Array.from({ length: 24 }, (_, i) => `CX${400 + i} J2 Y9`), 'CX999 Y1'] } };
  const m = CX.parseUnelevatedText(panelText(many)).routes[0].days['2027-03-01'].c;
  assert.deepEqual([m.Y.n, m.Y.f.length, m.J.n, m.J.f.length], [25, 20, 24, 20]);
  // A route in the form that shows no section at all counts as no seats on every date shown.
  const k = CX.parseUnelevatedText(panelText({ '2027-02-13 Sat': SHOTS['2027-02-13 Sat'] }), { from: 'TPE', to: 'NRT,KIX,HND' });
  assert.deepEqual(k.routes.map((r) => r.tc), ['NRT', 'KIX', 'HND']);
  assert.deepEqual(k.routes[2].days, { '2027-02-13': { na: 1 } });
  // Nothing to read.
  const none = CX.parseUnelevatedText('出發\n台北\n東京\nCX450 07:30 TPE');
  assert.deepEqual([none.found, none.routes, none.dates], [false, [], []]);
  assert.equal(CX.parseUnelevatedText('Unelevated Award Search\n批次搜尋 20 天可兌換航班').found, true);
});

test('cxunelev: the parser minified (as in the bookmark) gives the same answer', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'cxcal.js'), 'utf8');
  const fn = src.slice(src.indexOf('function parseUnelevatedText'), src.indexOf('  // The calendar and the chosen day'));
  const p2 = vm.runInNewContext(`(${CX.cxMin(fn)})`);
  const hints = { from: 'TPE', to: 'NRT,KIX', date: '20270213' };
  const text = panelText(SHOTS, 'split');
  assert.deepEqual(JSON.parse(JSON.stringify(p2(text, hints))), JSON.parse(JSON.stringify(CX.parseUnelevatedText(text, hints))));
  const code = decodeURIComponent(CX.bookmarkletCode('https://award.example').slice('javascript:'.length));
  assert.match(code, /function parseUnelevatedText/);
  assert.match(code, /function cxUnFind/);
  assert.match(code, /外掛模式：讀到 /);
});

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

test('cxunelev: v2 export with several routes round-trips; v1 still decodes', () => {
  const u = CX.parseUnelevatedText(panelText(), { from: 'TPE', to: 'NRT,KIX' });
  const at = Date.UTC(2026, 9, 15);
  const d = CX.decodeExport(b64({ v: 2, source: 'unelevated', at, routes: u.routes.map((r) => ({ from: r.fc, to: r.tc, fc: r.fc, tc: r.tc, days: { ...r.days, junk: 1 } })) }));
  assert.deepEqual([d.v, d.source, d.at, d.routes.length], [2, 'unelevated', at, 2]);
  assert.deepEqual(d.routes.map((r) => [r.fc, r.tc, r.source, r.at]), [['TPE', 'NRT', 'unelevated', at], ['TPE', 'KIX', 'unelevated', at]]);
  assert.deepEqual(d.routes[0].days, u.routes[0].days);
  assert.equal(CX.decodeExport(b64({ v: 2, routes: [] })), null);
  assert.equal(CX.decodeExport(b64({ v: 2, routes: [{ days: [] }] })), null);
  const v1 = CX.decodeExport(b64({ v: 1, from: '台北', to: '東京', fc: 'TPE', tc: 'NRT', at: 1, days: { '2026-11-01': { na: 1 } } }));
  assert.deepEqual([v1.from, v1.fc, v1.routes, Object.keys(v1.days)], ['台北', 'TPE', undefined, ['2026-11-01']]);
});

test('cxunelev: the store keeps seat counts and chips, refuses unknown fields, and 20 full days fit', () => {
  const u = CX.parseUnelevatedText(panelText(), { from: 'TPE', to: 'NRT,KIX' });
  const body = (days, extra = {}) => ({ v: 1, from: '台北', to: '東京', fc: 'TPE', tc: 'NRT', at: 1, days, source: 'unelevated', ...extra });
  const r = validatePayload(body(u.routes[0].days));
  assert.equal(r.source, 'unelevated');
  assert.deepEqual(r.days['2027-02-13'].c.J.f[1], { n: 'CX461›CX500', p: 'TPE-HKG-NRT', s: 1, q: { J: 3, Y: 9 } });
  const { f, ...j } = r.days['2027-02-13'].c.J;
  assert.deepEqual([j, f.length], [{ m: 0, seats: 3, n: 7, nonstop: true }, 7]);
  assert.equal(r.days['2027-02-17'].c.Y.seats, 9);
  const bad = (p, re) => assert.throws(() => validatePayload(p), (e) => e instanceof CxcalError && re.test(e.message), re);
  bad(body({ '2027-02-13': { c: { J: { seats: 3, zzz: 1 } } } }), /不認識的欄位/);
  bad(body({ '2027-02-13': { c: { J: { seats: 'many' } } } }), /座位數/);
  bad(body({ '2027-02-13': { c: { J: { seats: 3, f: [{ n: 'CX450', p: 'TPE-NRT', q: { X: 1 } }] } } } }), /不認識的欄位/);
  bad(body({ '2027-02-13': { c: { J: { seats: 3, f: [{ n: 'CX450', p: 'TPE-NRT', q: { J: -1 } }] } } } }), /座位數/);
  bad(body({ '2027-02-13': { c: { J: { seats: 3, f: [{ n: 'CX450', m: 1, q: { J: 1 } }] } } } }), /格式不對/);
  bad(body(u.routes[0].days, { source: 'userscript' }), /source/);
  // 20 days of 20 connecting flights with business and economy seats: under the 64 KB cap.
  const chips = Array.from({ length: 20 }, (_, i) => `CX${400 + i} ${H} CX${500 + i} J${1 + (i % 9)} Y9`);
  const shots = {};
  for (let i = 0; i < 20; i++) shots[`${new Date(Date.UTC(2027, 1, 13 + i)).toISOString().slice(0, 10)} x`] = { 'TPE - NRT': chips };
  const big = CX.parseUnelevatedText(panelText(shots)).routes[0];
  for (const v of Object.values(big.days)) for (const x of Object.values(v.c)) x.t = Date.now();
  assert.doesNotThrow(() => validatePayload(body(big.days)));
});
