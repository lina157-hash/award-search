// 請 AI 助理查國泰官網: the prompt for the owner's assistant, the parser for its answer, and the store taking source 'ai'.
const { test } = require('node:test');
const assert = require('node:assert');
const { museBuildPrompt, museParse, MUSE_URL } = require('../public/cxmuse');
const { validatePayload, createCxcalStore } = require('../lib/cxcal-store');
const { memoryKv } = require('../lib/kv');

const plain = (x) => JSON.parse(JSON.stringify(x));
const one = { fc: 'TPE', tc: 'NRT', from: '台北', to: '東京' };

test('cxmuse prompt: route, dates, cabin, passengers and the Cathay page are filled in', () => {
  const { text, end, capped } = museBuildPrompt({ pairs: [one], start: '2027-08-01', end: '2027-08-20', cabin: 'J', pax: 2 });
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
  const { text } = museBuildPrompt({ pairs: [one], start: '2027-08-01', end: '2027-08-02', cabin: 'Y', pax: 1 });
  assert.match(text, /自己的安全登入表單/);
  assert.match(text, /不要叫我把密碼打在聊天裡/);
  assert.match(text, /每小時最多查一個月/);
  assert.match(text, /不要訂位、不要付款/);
  assert.match(text, /經濟艙/);
  assert.doesNotMatch(text, /請確認 1 位/);
});

test('cxmuse prompt: a long range is cut to one month and says so; several pairs are listed with the wait', () => {
  const p = museBuildPrompt({ pairs: [one, { fc: 'KHH', tc: 'HKG', from: '高雄', to: '香港' }], start: '2027-08-01', end: '2027-10-15', cabin: 'F', pax: 1 });
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
