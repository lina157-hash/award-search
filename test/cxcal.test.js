// 國泰哩程日曆 bookmarklet: the page-text parser, the minifier and the javascript: URL builder, the export decoder.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const CX = require('../public/cxcal.js');

// innerText of the zh_HK results page as in the owner's screenshots (account area, stepper, summary, results).
const ZH = (strip = ['星期六', '31', '星期日', '1', '不適用', '星期一', '2', '星期二', '3', '星期三', '4', '星期四', '5', '星期五', '6'], tiles = ['經濟客艙'], cards = null) => [
  '國泰航空', 'CHAN TAI MAN', '1', '選擇航班', '2', '旅客及服務', '3', '增值選項', '4', '付款詳情',
  '台北', '東京', '出發日期', '2026年11月3日', '旅客', '1', '重新搜尋',
  '出發', '台北', '東京', '日曆上顯示的最低里數', '2026年10', '月', '2026年11', '月',
  ...strip, ...tiles, '查看全部資料', '推薦', '直航',
  ...(cards || ['CX407 › CX500', '航班資料', '08:20', 'TPE', '11小時 0分鐘', '停留1次, HKG', '20:20', 'NRT', '₳13,000',
    'CX450', '航班資料', '07:30', 'TPE', '3小時 15分鐘', '直航', '11:45', 'NRT', '13,000', '另加稅項 HKD 345',
    'CX565', 'CX520', '航班資料', '19:10', 'TPE', '停留1次, HKG', '06:05', '+1', 'NRT', '20,000']),
  '© 2026 國泰航空',
].join('\n');

test('cxcal: the zh_HK results page gives route, dates, cabin and flights', () => {
  const r = CX.parseCathayText(ZH(), { day: 3 });
  assert.deepEqual([r.from, r.to, r.fc, r.tc, r.head, r.date, r.cabin], ['台北', '東京', 'TPE', 'NRT', '2026-11-03', '2026-11-03', 'Y']);
  assert.deepEqual(r.strip.map((s) => s.date), ['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06']);
  assert.deepEqual(r.strip.filter((s) => s.na).map((s) => s.date), ['2026-11-01']);
  assert.deepEqual(r.flights, [
    { n: 'CX407›CX500', d: '08:20', a: '20:20', p: 'TPE-HKG-NRT', s: 1, m: 13000, du: '11小時0分' },
    { n: 'CX450', d: '07:30', a: '11:45', p: 'TPE-NRT', s: 0, m: 13000, du: '3小時15分' },
    { n: 'CX565›CX520', d: '19:10', a: '06:05', p: 'TPE-HKG-NRT', s: 1, m: 20000, x: '+1' },
  ]);
  assert.deepEqual(r.low, { Y: 13000 });
  assert.deepEqual(r.issues, []);
});

test('cxcal: the selected strip day wins over a summary date that did not follow the click', () => {
  const r = CX.parseCathayText(ZH(), { day: 5 });
  assert.equal(r.date, '2026-11-05');
  // No hint at all: the summary date, since it is on the strip.
  assert.equal(CX.parseCathayText(ZH(), {}).date, '2026-11-03');
});

test('cxcal: a strip moved to the next week is dated from the month label; without a selection nothing is recorded', () => {
  const next = ['星期六', '7', '星期日', '8', '不適用', '星期一', '9', '星期二', '10', '星期三', '11', '星期四', '12', '星期五', '13'];
  const r = CX.parseCathayText(ZH(next), {});
  assert.equal(r.strip[0].date, '2026-11-07');
  assert.equal(r.strip[1].na, 1);
  assert.equal(r.date, '');
  assert.ok(r.issues.includes('nodate'));
  assert.equal(CX.parseCathayText(ZH(next), { day: 10 }).date, '2026-11-10');
});

test('cxcal: day numbers whose weekdays do not fit any month are not dated (no wrong calendar entries)', () => {
  const wrong = ['星期一', '31', '星期二', '1', '星期三', '2'];
  const r = CX.parseCathayText(ZH(wrong), { day: 2 });
  assert.deepEqual(r.strip, []);
  assert.ok(r.issues.includes('stripdate'));
});

test('cxcal: with two cabin tiles the selected one comes from the hint; tile miles and cabin-labelled card prices count', () => {
  const two = ['經濟客艙', '商務客艙'];
  assert.equal(CX.parseCathayText(ZH(undefined, two), {}).cabin, '');
  const j = CX.parseCathayText(ZH(undefined, two), { day: 4, cabin: '商務客艙' });
  assert.equal(j.cabin, 'J');
  assert.deepEqual(j.low, { J: 13000 });
  const shown = CX.parseCathayText(ZH(undefined, ['經濟客艙', '13,000', '商務客艙', '38,000', '頭等客艙', '不適用']), { day: 3, cabin: '經濟客艙' });
  assert.deepEqual(shown.tiles, [{ c: 'Y', m: 13000, na: 0 }, { c: 'J', m: 38000, na: 0 }, { c: 'F', m: 0, na: 1 }]);
  assert.deepEqual(shown.low, { Y: 13000, J: 38000 });
  const labelled = CX.parseCathayText(ZH(undefined, two, ['CX450', '07:30', 'TPE', '11:45', 'NRT', '經濟客艙', '13,000', '商務客艙', '38,000']), { day: 3 });
  assert.deepEqual(labelled.flights[0].mc, { Y: 13000, J: 38000 });
  assert.deepEqual(labelled.low, { Y: 13000, J: 38000 });
});

test('cxcal: the en_HK page parses too', () => {
  const EN = ['Taipei', 'Tokyo', 'Departure date', 'Tue 3 Nov 2026', 'Passengers', '1', 'Departure', 'Taipei', 'Tokyo', 'Lowest miles shown on calendar', 'Oct 2026', 'Nov 2026',
    'Sat', '31', 'Sun', '1', 'Not available', 'Mon', '2', 'Tue', '3', 'Wed', '4', 'Economy', 'Business', 'View all', 'Recommended', 'Non-stop',
    'CX407', 'CX500', 'Flight details', '08:20', 'TPE', '11h 0m', '1 stop, HKG', '20:20', 'NRT', '13,000'].join('\n');
  const r = CX.parseCathayText(EN, { day: 2, cabin: 'Business' });
  assert.deepEqual([r.from, r.to, r.head, r.date, r.cabin], ['Taipei', 'Tokyo', '2026-11-03', '2026-11-02', 'J']);
  assert.equal(r.strip[1].na, 1);
  assert.deepEqual(r.flights[0], { n: 'CX407›CX500', d: '08:20', a: '20:20', p: 'TPE-HKG-NRT', s: 1, m: 13000, du: '11h0m' });
});

test('cxcal: junk text gives an empty result, never a throw', () => {
  for (const t of ['', 'hello', '出發', '星期一\n99', null]) {
    const r = CX.parseCathayText(t, { day: 'x' });
    assert.equal(r.date, '');
    assert.deepEqual(r.flights, []);
  }
});

test('cxcal: the minifier keeps strings, regexes and behaviour', () => {
  const src = `function f(a) {
    // a comment with 'quote'
    const s = 'a // not a comment', re = /['"\\/]+/g; /* block */
    return a.replace(re, '') + s + (a - -1) + typeof a;
  }`;
  const min = CX.cxMin(src);
  assert.ok(!/comment with|block/.test(min) && !/\n/.test(min), min);
  const f = vm.runInNewContext(`(${min})`);
  assert.equal(f(`x'"/y`), 'xya // not a commentNaNstring');
  // The parser itself, minified, gives the same answers.
  const src2 = fs.readFileSync(path.join(__dirname, '..', 'public', 'cxcal.js'), 'utf8');
  const fn = src2.slice(src2.indexOf('function parseCathayText'), src2.indexOf('  // 外掛模式: the visible text'));
  const p2 = vm.runInNewContext(`(${CX.cxMin(fn)})`);
  assert.deepEqual(JSON.parse(JSON.stringify(p2(ZH(), { day: 4 }))), JSON.parse(JSON.stringify(CX.parseCathayText(ZH(), { day: 4 }))));
});

test('cxcal: the bookmark is one javascript: line that compiles, with % and # escaped and the site origin inside', () => {
  const code = CX.bookmarkletCode('https://award.example/', '匯出要等網站更新後才能用');
  assert.match(code, /^javascript:\(function\(\)\{/);
  assert.ok(!/[\n#]/.test(code), 'no newline or raw #');
  assert.ok(!/[\u00a0\u2028\u2029]/.test(code), 'no invisible spaces or line separators');
  assert.ok(!/%(?!2[35])/.test(code), 'every % is an escape');
  assert.ok(code.length < 36000, code.length);
  const body = decodeURIComponent(code.slice('javascript:'.length));
  assert.doesNotThrow(() => new Function(body));
  assert.match(body, /cxRun\("https:\/\/award\.example","匯出要等網站更新後才能用"\)/);
  assert.match(body, /'\/#cxcal='/);
  // Nothing in it sends requests or asks for credentials on Cathay's page.
  assert.ok(!/fetch\(|XMLHttpRequest|sendBeacon|\.click\(\)|password'\)/.test(body.replace(/input\[type=password\]/g, '')));
});

test('cxcal: export payload round trip; bad input is refused', () => {
  const days = { '2026-11-03': { c: { Y: { m: 13000, f: [{ n: 'CX450', m: 13000 }] } } }, '2026-11-01': { na: 1 }, bad: { x: 1 } };
  const b64 = Buffer.from(JSON.stringify({ v: 1, from: '台北', to: '東京', fc: 'TPE', tc: 'NRT', at: 1, days })).toString('base64url');
  const d = CX.decodeExport(b64);
  assert.deepEqual(Object.keys(d.days).sort(), ['2026-11-01', '2026-11-03']);
  assert.equal(d.from, '台北');
  assert.equal(CX.decodeExport('!!!'), null);
  assert.equal(CX.decodeExport(Buffer.from('[1,2]').toString('base64url')), null);
});

test('cxcal: index.html loads cxcal.js', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /<script src="\/cxcal\.js\?v=[\w.-]+"><\/script>/);
});
