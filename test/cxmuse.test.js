// 請 AI 助理查官網: the per-airline prompt for the owner's assistant (data/muse-templates.json), the parser for its
// answer, and the store taking source 'ai' with the airline.
const { test } = require('node:test');
const assert = require('node:assert');
const { museBuildPrompt, musePhonePrompt, museParse, museAirOf, museDayLevel, museMonthsEnd } = require('../public/cxmuse');
const { validatePayload, createCxcalStore, AIRS } = require('../lib/cxcal-store');
const TPL = require('../data/muse-templates.json').airlines;
const tpl = (id) => TPL.find((a) => a.id === id);
const CX = tpl('cx');
const MUSE_URL = CX.url;
const museBuild = (o) => museBuildPrompt({ tpl: CX, ...o });
const { memoryKv } = require('../lib/kv');

const plain = (x) => JSON.parse(JSON.stringify(x));
const one = { fc: 'TPE', tc: 'NRT', from: '台北', to: '東京' };

test('cxmuse prompt: route, dates, cabin, passengers and the Cathay page are filled in', () => {
  const { text, end, capped } = museBuild({ pairs: [one], start: '2027-08-01', end: '2027-08-20', cabin: 'J', pax: 2 });
  assert.equal(capped, false);
  assert.equal(end, '2027-08-20');
  assert.ok(text.includes(MUSE_URL));
  assert.match(text, /台北 TPE → 東京 NRT/);
  assert.match(text, /2027 年 8 月 1 日（日） 到 8 月 20 日（五），共 20 天/);
  assert.match(text, /艙等：商務艙/);
  assert.match(text, /人數：2 位/);
  assert.match(text, /國泰查票結果 TPE-NRT/);
  assert.match(text, /2027-08-01 \| 商務 \| 有位 \| \d+ \| /);
  assert.match(text, /2027-08-02 \| 商務 \| 無位/);
});

test('cxmuse prompt: the password stays out of the chat, one month per hour, query only', () => {
  const { text } = museBuild({ pairs: [one], start: '2027-08-01', end: '2027-08-02', cabin: 'Y', pax: 1 });
  assert.match(text, /自己的安全登入表單/);
  assert.match(text, /不要叫我把密碼打在聊天裡/);
  assert.match(text, /每小時最多查一個月/);
  assert.match(text, /不要訂位、不要保留機位、不要付款、不要兌換或扣哩程/);
  assert.match(text, /經濟艙/);
  assert.doesNotMatch(text, /請確認 1 位/);
});

test('cxmuse prompt: a long range is cut to one month and says so; several pairs are listed with the wait', () => {
  const p = museBuild({ pairs: [one, { fc: 'KHH', tc: 'HKG', from: '高雄', to: '香港' }], start: '2027-08-01', end: '2027-10-15', cabin: 'F', pax: 1 });
  assert.equal(p.capped, true);
  assert.equal(p.end, '2027-08-31');
  assert.match(p.text, /共 31 天/);
  assert.match(p.text, /一次最多查一個月，所以這次只查前 31 天/);
  assert.match(p.text, /共 2 組/);
  assert.match(p.text, /2\. 高雄 KHH → 香港 HKG/);
  assert.match(p.text, /等一小時再查下一組/);
  assert.match(p.text, /頭等艙/);
});

test('cxmuse parse: the exact format → cxcal day records (有位 with miles and flight, 無位, 有位 without miles)', () => {
  const r = museParse(['國泰查票結果 TPE-NRT', '2027-08-01 | 商務 | 有位 | 88000 | CX450', '2027-08-02 | 商務 | 無位', '2027-08-03 | 商務 | 有位'].join('\n'));
  assert.equal(r.read, 3);
  assert.equal(r.skipped, 0);
  assert.equal(r.routes.length, 1);
  const x = plain(r.routes[0]);
  assert.deepEqual([x.fc, x.tc, x.cabins, x.range], ['TPE', 'NRT', ['J'], { from: '2027-08-01', to: '2027-08-03' }]);
  assert.deepEqual(x.days['2027-08-01'], { c: { J: { m: 88000, f: [{ n: 'CX450', d: '', a: '', p: 'TPE-NRT', s: 0, m: 88000 }] } } });
  assert.deepEqual(x.days['2027-08-02'], { c: { J: { m: 0, na: 1 } } });
  assert.deepEqual(x.days['2027-08-03'], { c: { J: { m: 0, f: [] } } });
  // The records pass the store's own validation unchanged.
  const rec = validatePayload({ v: 1, fc: x.fc, tc: x.tc, from: '台北', to: '東京', at: 1, days: x.days, source: 'ai', cabins: x.cabins, range: x.range, pax: 2 });
  assert.deepEqual(rec.days, x.days);
  assert.equal(rec.source, 'ai');
});

test('cxmuse parse: full-width separators, Y/W/J/F letters, commas, 萬, prose and code fences around the block', () => {
  const text = [
    '好的！我已經查完了，結果如下：',
    '```text',
    '國泰查票結果：ＴＰＥ－ＮＲＴ',
    '２０２７－０８－０１ ｜ 商務 ｜ 有位 ｜ ８８，０００ ｜ ＣＸ４５０',
    '2027/8/2 | J | 無位',
    '2027-08-03 | Y | 有位 | 23,000 | CX 450',
    '2027-08-03 | W | 有位 | 3.5萬',
    '2027年8月4日 | 頭等 | 有位 | 125,000 | CX451/CX500',
    '2027-08-05 | 豪華經濟 | 沒有位',
    '```',
    '以上資料僅供參考，訂位前請再確認。',
  ].join('\n');
  const r = museParse(text);
  assert.equal(r.read, 6);
  const d = plain(r.routes[0].days);
  assert.equal(d['2027-08-01'].c.J.m, 88000);
  assert.equal(d['2027-08-01'].c.J.f[0].n, 'CX450');
  assert.deepEqual(d['2027-08-02'].c.J, { m: 0, na: 1 });
  assert.equal(d['2027-08-03'].c.Y.m, 23000);
  assert.equal(d['2027-08-03'].c.Y.f[0].n, 'CX450');
  assert.equal(d['2027-08-03'].c.W.m, 35000);
  assert.deepEqual(d['2027-08-04'].c.F.f, [{ n: 'CX451›CX500', d: '', a: '', p: 'TPE-NRT', s: 1, m: 125000 }]);
  assert.deepEqual(d['2027-08-05'].c.W, { m: 0, na: 1 }, '「沒有位」 is 無位 even though it holds 「有位」');
  assert.deepEqual(plain(r.routes[0].cabins), ['Y', 'W', 'J', 'F']);
});

test('cxmuse parse: bad lines are skipped, prose is ignored, the same day twice keeps seats and the lower price', () => {
  const r = museParse([
    '國泰查票結果 TPE-NRT',
    '我在 8 月查了商務艙。', // prose without a leading date: ignored, not counted
    '2027-08-01 到 2027-08-03 我查了商務艙。', // prose led by a date: no 有位／無位 and no price, so skipped
    '2027-02-30 | 商務 | 有位 | 88000', // no such day
    '2027-08-06 | 商務 | 不確定',
    '2027-08-07 | 有位 | 88000', // no cabin
    '這一行沒有日期，略過。',
    '2027-08-08 | 商務 | 無位',
    '2027-08-08 | 商務 | 有位 | 90000 | CX450',
    '2027-08-08 | 商務 | 有位 | 85000 | CX520',
    '2027-08-09 | 商務 | 88000', // miles without a word count as 有位
  ].join('\n'));
  assert.equal(r.skipped, 4);
  assert.equal(r.read, 4);
  const d = plain(r.routes[0].days);
  assert.deepEqual(Object.keys(d), ['2027-08-08', '2027-08-09']);
  assert.equal(d['2027-08-08'].c.J.m, 85000);
  assert.deepEqual(d['2027-08-08'].c.J.f.map((f) => f.n), ['CX450', 'CX520']);
  assert.equal(d['2027-08-09'].c.J.m, 88000);
});

test('cxmuse parse: several routes, and lines before any header go to the fallback route (or are skipped)', () => {
  const text = ['2027-08-01 | 商務 | 有位 | 58000', '國泰查票結果 KHH-HKG', '2027-08-01 | 經濟 | 有位 | 10,000 | CX433, KA451', 'TPE → NRT', '2027-08-02 | 商務 | 無位'].join('\n');
  const a = museParse(text, { fallback: { fc: 'tpe', tc: 'hkg' } });
  assert.deepEqual(a.routes.map((x) => `${x.fc}-${x.tc}`), ['TPE-HKG', 'KHH-HKG', 'TPE-NRT']);
  assert.deepEqual(plain(a.routes[1].days['2027-08-01'].c.Y.f.map((f) => f.n)), ['CX433', 'KA451']);
  const b = museParse(text);
  assert.deepEqual(b.routes.map((x) => `${x.fc}-${x.tc}`), ['KHH-HKG', 'TPE-NRT']);
  assert.equal(b.skipped, 1);
  assert.deepEqual(museParse('').routes, []);
});

test('cxcal-store: source ai is accepted and stored; unknown sources still refused', async () => {
  const store = createCxcalStore({ kv: memoryKv() });
  const { routes } = museParse('國泰查票結果 TPE-NRT\n2027-08-01 | 商務 | 有位 | 88000 | CX450');
  const r = routes[0];
  const out = await store.save({ v: 1, from: '台北', to: '東京', fc: r.fc, tc: r.tc, at: 1, days: r.days, source: 'ai', cabins: r.cabins, range: r.range, pax: 1 });
  assert.deepEqual([out.fc, out.tc, out.days], ['TPE', 'NRT', 1]);
  const [got] = await store.find('TPE', 'NRT');
  assert.equal(got.source, 'ai');
  assert.equal(got.days['2027-08-01'].c.J.m, 88000);
  assert.throws(() => validatePayload({ fc: 'TPE', tc: 'NRT', days: r.days, source: 'muse' }), /source/);
});

// ---------- every airline (data/muse-templates.json) ----------
const TPE_LAX = { fc: 'TPE', tc: 'LAX', from: '台北', to: '洛杉磯' };

test('muse templates: six airlines with the fields the prompt needs; the store accepts exactly their ids', () => {
  assert.deepEqual(TPL.map((a) => a.id), ['cx', 'ci', 'br', 'jx', 'jl', 'nh']);
  assert.deepEqual(AIRS, TPL.map((a) => a.id));
  const OK = ['有位', '充足', '有限', '稀少', '候補', '無位'];
  for (const a of TPL) {
    for (const k of ['name', 'full', 'program', 'site', 'url', 'flight']) assert.ok(a[k], `${a.id}.${k}`);
    assert.match(a.url, /^https:\/\//);
    assert.equal(typeof a.login, 'boolean', `${a.id}.login`);
    assert.ok(Number.isInteger(a.monthsPerRun) && a.monthsPerRun >= 1 && a.monthsPerRun <= 12, `${a.id}.monthsPerRun`);
    assert.ok(a.statuses.includes('無位') && a.statuses.every((x) => OK.includes(x)), `${a.id}.statuses`);
    for (const [, to] of a.symbols) assert.ok(a.statuses.includes(to), `${a.id} symbol → ${to}`);
    assert.ok(a.pace.length && a.tips.length, `${a.id} pace/tips`);
    assert.equal(museAirOf(`${a.name}查票結果`, TPL), a.id);
  }
  assert.equal(tpl('jx').login, false, '星宇 via Alaska needs no login');
  assert.ok(!JSON.stringify(TPL).toLowerCase().includes('gmail'), 'no Gmail advice');
  assert.ok(!/seats\.?aero/i.test(JSON.stringify(TPL)), 'the SeatsAero part is not a template');
});

test('muse prompt per airline: name, page, header tag, statuses, pacing and safety are in every one', () => {
  for (const a of TPL) {
    const { text } = museBuildPrompt({ tpl: a, pairs: [TPE_LAX], start: '2027-06-01', end: '2027-06-10', cabin: 'J', pax: 1 });
    assert.ok(text.includes(a.url), a.id);
    assert.ok(text.includes(`${a.name}查票結果 TPE-LAX`), `${a.id} header`);
    assert.match(text, /2027-06-01 \| 商務 \| [^|]+ \| \d+ \| [A-Z]{2}000/);
    assert.match(text, /2027-06-02 \| 商務 \| 無位/);
    assert.ok(text.includes(`狀態只能是${a.statuses.map((x) => `「${x}」`).join('')}`), `${a.id} statuses`);
    assert.ok(text.includes(a.pace[0]), `${a.id} pace`);
    assert.match(text, /不要訂位、不要保留機位、不要付款、不要兌換或扣哩程/);
    assert.match(text, /絕對不要叫我把密碼打在聊天裡/);
    assert.doesNotMatch(text, /gmail/i);
    if (a.login) assert.match(text, /自己的安全登入表單/); else assert.match(text, /查票不用登入/);
  }
});

test('muse prompt 華航: 充足／有限／稀少／候補, no pax picker, two months per run, the optional upgrade block', () => {
  const ci = tpl('ci');
  const p = museBuildPrompt({ tpl: ci, pairs: [TPE_LAX], start: '2027-06-01', end: '2027-10-31', cabin: 'J', pax: 2 });
  assert.equal(p.capped, true);
  assert.equal(p.end, '2027-07-31');
  assert.match(p.text, /華航一次最多查 2 個月，所以這次只查前 61 天/);
  assert.match(p.text, /一次顯示一週/);
  assert.match(p.text, /2027-06-01 \| 商務 \| 充足 \| 58000 \| CI000/);
  assert.match(p.text, /不能選人數/);
  assert.doesNotMatch(p.text, /請確認 2 位都訂得到/);
  assert.doesNotMatch(p.text, /升等/);
  const u = museBuildPrompt({ tpl: ci, pairs: [TPE_LAX], start: '2027-06-01', end: '2027-06-30', cabin: 'J', pax: 1, extras: ['upgrade'] });
  assert.match(u.text, /座艙升等/);
  assert.match(u.text, /華航升等結果 出發代碼-抵達代碼/);
});

test('muse prompt 長榮: 41 seconds between queries, ○ → 有位 and △ → 候補, no first class; the phone prompt keeps placeholders', () => {
  const br = tpl('br');
  const p = museBuildPrompt({ tpl: br, pairs: [TPE_LAX, { fc: 'KHH', tc: 'LAX' }], start: '2027-08-01', end: '2027-08-31', cabin: 'F', pax: 2 });
  assert.equal(p.cabin, 'J');
  assert.match(p.text, /至少等 41 秒/);
  assert.match(p.text, /24 小時/);
  assert.match(p.text, /網頁上的「○（圓形）」寫「有位」/);
  assert.match(p.text, /網頁上的「△（三角形）」寫「候補」/);
  assert.match(p.text, /讓我自己解/);
  assert.match(p.text, /查詢間隔一樣至少 41 秒/);
  assert.match(p.text, /艙等：商務艙/);
  const ph = musePhonePrompt({ tpl: br, pair: TPE_LAX, start: '2027-08-01', cabin: 'J', pax: 2 });
  assert.match(ph, /我的姓名：（你的姓名）/);
  assert.match(ph, /我的會員號碼：（你的會員號碼）/);
  assert.match(ph, /2027-07-25 到 2027-08-08/);
  assert.match(ph, /不要提供密碼、信用卡/);
  assert.match(ph, /不要訂位、不要保留機位/);
  assert.match(ph, /長榮查票結果 TPE-LAX/);
  assert.ok(!TPL.filter((a) => a.phone).some((a) => a.id !== 'br'), 'only 長榮 offers the phone prompt');
});

test('muse prompt 星宇、日航、ANA: Alaska without login and only JX flights, the JAL calendar path, ANA previous-day calendar', () => {
  const jx = museBuildPrompt({ tpl: tpl('jx'), pairs: [{ fc: 'TPE', tc: 'NRT' }], start: '2027-01-01', end: '2027-07-31', cabin: 'J', pax: 1 });
  assert.match(jx.text, /阿拉斯加航空官網幫我查用阿拉斯加航空哩程兌換星宇航空/);
  assert.match(jx.text, /只看星宇（JX）/);
  assert.equal(jx.end, '2027-03-31');
  const jl = museBuildPrompt({ tpl: tpl('jl'), pairs: [{ fc: 'LAX', tc: 'HND' }], start: '2027-03-01', end: '2027-03-31', cabin: 'J', pax: 1 });
  assert.match(jl.text, /Search by Seat Availability Check Calendar/);
  assert.match(jl.text, /日航查票結果 LAX-HND/);
  const nh = museBuildPrompt({ tpl: tpl('nh'), pairs: [{ fc: 'HND', tc: 'LAX' }], start: '2027-03-01', end: '2027-12-31', cabin: 'W', pax: 1 });
  assert.match(nh.text, /前一天的資料/);
  assert.match(nh.text, /不要去 ANA 其他的訂位頁面/);
  assert.match(nh.text, /艙等：豪華經濟艙/);
  assert.equal(nh.end, '2027-08-31');
  assert.equal(museMonthsEnd('2027-01-31', 1), '2027-02-27');
});

test('muse parse: every airline header, ○／△ and the new statuses, several blocks in one paste, upgrade block ignored', () => {
  const text = [
    '以下是結果：',
    '```text',
    '華航查票結果 TPE-LAX',
    '2027-06-01 | 商務 | 充足 | 50000 | CI6',
    '2027-06-02 | 商務 | 有限 | 75000 | CI6',
    '2027-06-03 | 商務 | 稀少 | 100000',
    '2027-06-04 | 商務 | 候補',
    '2027-06-05 | 商務 | 無位',
    '華航升等結果 TPE-LAX',
    '2027-06-01 | 商務 | 充足 | 30000',
    '```',
    '```text',
    '長榮查票結果：TPE-LAX',
    '2027-06-01 | 商務 | ○ | 75000 | BR12',
    '2027-06-02 | 商務 | △',
    '2027-06-03 | 商務 | ×',
    '```',
    '星宇查票結果 TPE-NRT', '2027-06-01 | 商務 | 有位 | 30,000 | JX800',
    '日本航空查票結果 LAX-HND', '2027-06-01 | 商務 | 有位 | 70000 | JL61', '2027-06-02 | 商務 | 候補',
    '**ANA查票結果 HND-LAX**', '2027-06-01 | 豪華經濟 | 有位', '2027-06-02 | 豪經 | 無位',
    '國泰查票結果 TPE-HKG', '2027-06-01 | 商務 | 有位 | 23000 | CX465',
  ].join('\n');
  const r = museParse(text, { airlines: TPL });
  assert.deepEqual(r.routes.map((x) => `${x.air}:${x.fc}-${x.tc}`), ['ci:TPE-LAX', 'br:TPE-LAX', 'jx:TPE-NRT', 'jl:LAX-HND', 'nh:HND-LAX', 'cx:TPE-HKG']);
  assert.equal(r.skipped, 0);
  assert.equal(r.read, 14, 'the 升等 line is not read');
  const ci = plain(r.routes[0].days);
  assert.deepEqual(ci['2027-06-01'].c.J, { m: 50000, f: [{ n: 'CI6', d: '', a: '', p: 'TPE-LAX', s: 0, m: 50000 }], st: 'p' });
  assert.equal(ci['2027-06-02'].c.J.st, 'l');
  assert.deepEqual(ci['2027-06-03'].c.J, { m: 100000, f: [], st: 's' });
  assert.deepEqual(ci['2027-06-04'].c.J, { m: 0, na: 1, st: 'w' });
  assert.deepEqual(ci['2027-06-05'].c.J, { m: 0, na: 1 });
  assert.deepEqual(Object.values(ci).map(museDayLevel), ['p', 'l', 'l', 'w', 'n']);
  const br = plain(r.routes[1].days);
  assert.equal(br['2027-06-01'].c.J.m, 75000);
  assert.ok(!br['2027-06-01'].c.J.na && !br['2027-06-01'].c.J.st, '○ is 有位');
  assert.deepEqual(br['2027-06-02'].c.J, { m: 0, na: 1, st: 'w' }, '△ is 候補');
  assert.deepEqual(br['2027-06-03'].c.J, { m: 0, na: 1 }, '× is 無位');
  assert.equal(r.routes[2].days['2027-06-01'].c.J.m, 30000);
  assert.equal(r.routes[3].days['2027-06-02'].c.J.st, 'w');
  assert.deepEqual(plain(r.routes[4].cabins), ['W']);
  assert.equal(r.routes[5].days['2027-06-01'].c.J.f[0].n, 'CX465');
  // Every record passes the store's validation with its airline.
  for (const x of r.routes) {
    const rec = validatePayload({ v: 1, air: x.air, fc: x.fc, tc: x.tc, at: 1, days: plain(x.days), source: 'ai', cabins: x.cabins, range: x.range });
    assert.deepEqual(rec.days, plain(x.days));
    assert.equal(rec.air, x.air);
  }
});

test('muse parse: a header without a known airline keeps the one chosen in the tool; 候補 never hides seats on the same day', () => {
  const r = museParse(['查票結果 TPE-KIX', '2027-06-01 | 商務 | 候補', '2027-06-01 | 商務 | 有位 | 60000', '2027-06-02 | 商務 | 無位', '2027-06-02 | 商務 | 候補', '2027-06-03 | 商務 | 有限 | 80000', '2027-06-03 | 商務 | 充足 | 60000'].join('\n'), { airlines: TPL, air: 'br' });
  assert.equal(r.routes[0].air, 'br');
  const d = plain(r.routes[0].days);
  assert.equal(d['2027-06-01'].c.J.m, 60000);
  assert.ok(!d['2027-06-01'].c.J.na);
  assert.deepEqual(d['2027-06-02'].c.J, { m: 0, na: 1, st: 'w' });
  assert.deepEqual([d['2027-06-03'].c.J.m, d['2027-06-03'].c.J.st], [60000, 'p']);
  // No templates given: everything is Cathay, as before.
  assert.equal(museParse('國泰查票結果 TPE-NRT\n2027-08-01 | 商務 | 有位').routes[0].air, 'cx');
});

test('cxcal-store: the airline dimension — ids from the templates, old Cathay keys, one card per airline and route', async () => {
  const kv = memoryKv();
  const store = createCxcalStore({ kv });
  const days = { '2027-06-01': { c: { J: { m: 50000, f: [], st: 'p' } } }, '2027-06-02': { c: { J: { m: 0, na: 1, st: 'w' } } } };
  assert.throws(() => validatePayload({ air: 'xx', fc: 'TPE', tc: 'LAX', days, source: 'ai' }), /air 只能是/);
  assert.throws(() => validatePayload({ air: 'ci', fc: 'TPE', tc: 'LAX', days, source: 'bookmarklet' }), /只能由 AI 助理/);
  assert.throws(() => validatePayload({ air: 'ci', fc: 'TPE', tc: 'LAX', days: { '2027-06-01': { c: { J: { m: 1, st: 'x' } } } }, source: 'ai' }), /狀態只能是/);
  assert.equal(validatePayload({ fc: 'TPE', tc: 'LAX', days, source: 'ai' }).air, 'cx', 'no air is Cathay');
  // A record saved before the airline dimension (no air, old key, not in the index) still shows, as Cathay.
  await kv.set('cxcal:v1:TPE>LAX', { v: 1, fc: 'TPE', tc: 'LAX', days, source: 'bookmarklet', savedAt: '2026-10-01T00:00:00.000Z' });
  const ci = await store.save({ v: 1, air: 'CI', fc: 'TPE', tc: 'LAX', from: '台北', to: '洛杉磯', at: 1, days, source: 'ai' });
  assert.deepEqual([ci.air, ci.fc, ci.tc, ci.days], ['ci', 'TPE', 'LAX', 2]);
  await store.save({ v: 1, air: 'br', fc: 'TPE', tc: 'LAX', at: 1, days, source: 'ai' });
  assert.ok(await kv.get('cxcal:v1:ci:TPE>LAX'));
  const found = await store.find('TPE', 'LAX,SFO');
  assert.deepEqual(found.map((x) => x.air).sort(), ['br', 'ci', 'cx']);
  assert.equal(found.find((x) => x.air === 'cx').source, 'bookmarklet');
  assert.equal(found.find((x) => x.air === 'ci').days['2027-06-01'].c.J.st, 'p');
  // The 50-route cap counts every airline; ids of expired records are dropped to make room.
  let t = Date.parse('2026-10-15T00:00:00Z');
  const kv2 = memoryKv({ now: () => t });
  const st2 = createCxcalStore({ kv: kv2, now: () => t });
  for (let i = 0; i < 50; i++) await st2.save({ air: TPL[i % 6].id, fc: 'TPE', tc: `Q${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`, days, source: 'ai' });
  await assert.rejects(st2.save({ air: 'jl', fc: 'TPE', tc: 'ZZZ', days, source: 'ai' }), /最多保存 50 條/);
  t += 22 * 86400e3;
  await st2.save({ air: 'jl', fc: 'TPE', tc: 'ZZZ', days, source: 'ai' });
  assert.deepEqual(await kv2.get('cxcal:v1:routes'), ['jl:TPE>ZZZ']);
});

test('the templates are served at /api/data/musetemplates', async () => {
  const { server } = require('../server');
  await new Promise((r) => server.listen(0, r));
  try {
    const res = await fetch(`http://localhost:${server.address().port}/api/data/musetemplates`, { headers: { 'x-requested-with': 'fetch' } });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).airlines.map((a) => a.id), TPL.map((a) => a.id));
  } finally { server.close(); }
});
