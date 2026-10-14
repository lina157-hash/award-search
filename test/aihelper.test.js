// The 「交給 AI 助理」 text and its call-center data.
const { test } = require('node:test');
const assert = require('node:assert');
const { aiBriefText } = require('../public/aihelper.js');
const centers = require('../data/callcenters.json').programs;
const names = require('../data/source-names.json').names;

const seg = (o) => ({ flight: 'JL51', al: '日本航空', alEn: 'Japan Airlines', from: 'TPE', fromZh: '台北桃園', fromEn: 'Taipei', dep: '21:30', to: 'NRT', toZh: '東京成田', toEn: 'Tokyo', arr: '10:30', arrNote: '（隔天）', ...o });
const base = {
  program: '美航 AAdvantage', programEn: 'American Airlines AAdvantage', segs: [seg()], date: '2026-11-02', cabin: 'business', pax: 1, miles: 70000,
  taxes: { zh: 'NT$8,500', en: 'TWD 8,500' }, phones: [{ number: '+1 800-882-8880', label: '美國・加拿大' }], contactUrl: 'https://www.aa.com/x', phoneFee: '', warnings: ['AA 顯示的日航艙位偶有幻影機位'],
};

test('direct flight: facts, phone, warning, questions and English script', () => {
  const t = aiBriefText(base);
  assert.match(t, /・航班（直飛）：日本航空 JL51　台北桃園 TPE 21:30 → 東京成田 NRT 10:30（隔天）\n/);
  assert.match(t, /・日期：2026 年 11 月 2 日（一）/);
  assert.match(t, /・艙等：商務艙，1 位/);
  assert.match(t, /・網站查到：70,000 哩＋稅金約 NT\$8,500（請以客服報價為準）/);
  assert.match(t, /・客服電話：\+1 800-882-8880（美國・加拿大）/);
  assert.match(t, /・注意：AA 顯示的日航艙位偶有幻影機位/);
  assert.match(t, /〔請自己填，不要給密碼或信用卡〕/);
  assert.match(t, /需要付款時先問我/);
  assert.match(t, /3\. 改票、退票要多少錢/);
  assert.match(t, /an American Airlines AAdvantage award ticket on Japan Airlines JL51 from Taipei \(TPE\) to Tokyo \(NRT\) on 2 November 2026, business class, one passenger\./);
  assert.doesNotMatch(t, /官網/);
});

test('connection, two passengers, no phone: every segment, totals, contact page', () => {
  const t = aiBriefText({
    ...base, pax: 2, phones: [], warnings: [], taxes: { zh: '$112.20 USD', en: 'USD 112.2' },
    segs: [seg({ flight: 'BR18', al: '長榮航空', alEn: 'EVA Air', to: 'SFO', toZh: '舊金山', toEn: 'San Francisco', arrNote: '' }), seg({ flight: 'UA1', al: '聯合航空', alEn: 'United Airlines', from: 'SFO', fromZh: '舊金山', fromEn: 'San Francisco', to: 'DEN', toZh: '丹佛', toEn: 'Denver', arrNote: '' })],
  });
  assert.match(t, /・航班（轉機 1 次，共 2 段）：/);
  assert.match(t, /第 1 段　長榮航空 BR18　台北桃園 TPE 21:30 → 舊金山 SFO 10:30/);
  assert.match(t, /第 2 段　聯合航空 UA1　舊金山 SFO 21:30 → 丹佛 DEN 10:30/);
  assert.match(t, /每位 70,000 哩，2 位共 140,000 哩＋稅金約 \$112.20 USD（稅金是 2 位合計，請以客服報價為準）/);
  assert.match(t, /book two American Airlines AAdvantage award tickets on/);
  assert.match(aiBriefText({ ...base, taxes: null }), /・網站查到：70,000 哩，網站沒列出稅金（請以客服報價為準）/);
  assert.match(t, /・客服電話請見官網：https:\/\/www\.aa\.com\/x/);
  assert.match(t, /訂 2 張獎勵機票/);
  assert.match(t, /EVA Air BR18 from Taipei \(TPE\) to San Francisco \(SFO\), connecting to United Airlines UA1 from San Francisco \(SFO\) to Denver \(DEN\), departing 2 November 2026, business class, two passengers\./);
  assert.doesNotMatch(t, /幻影/);
});

test('callcenters.json: known program ids, https sources, dated phones', () => {
  for (const [id, c] of Object.entries(centers)) {
    assert.ok(names[id], `${id} is a seats.aero program on the site`);
    assert.ok(c.en, `${id} English name`);
    if (c.contactUrl) assert.match(c.contactUrl, /^https:\/\//, id);
    for (const p of c.phones || []) {
      assert.match(p.number, /^[+0-9][0-9 -]+$/, `${id} ${p.number}`);
      assert.match(c.source, /^https:\/\//, `${id} source`);
      assert.match(c.asOf, /^\d{4}-\d{2}-\d{2}$/, `${id} asOf`);
    }
  }
});
