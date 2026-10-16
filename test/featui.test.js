// Data and helper checks behind the features UI: Chinese airline names, promo caps, the earn section's matching.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', f), 'utf8'));
const names = read('airline-names.json');
const zh = new Map(names.airlines.map(([code, name]) => [code, name]));

// Pull one top-level declaration out of a classic browser script (they share globals, so they can't be required).
function grab(file, re) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
  const m = src.match(re);
  assert.ok(m, `${re} in ${file}`);
  return m[0];
}

test('every alliance member, member note and airlines.json carrier has a Chinese name', () => {
  const codes = new Set([...read('alliances.json').alliances.flatMap((a) => [...a.members, ...(a.memberNotes || []).map((n) => n.code)]), ...read('airlines.json').airlines.map((a) => a.code)]);
  const missing = [...codes].filter((c) => !/[一-鿿]/.test(zh.get(c) || ''));
  assert.deepEqual(missing, []);
  for (const code of Object.keys(names.defunct || {})) assert.ok(zh.has(code), `defunct ${code} keeps a name`);
});

test('promo caps: KGI 「每月加贈上限500里」 reads as a monthly 500-mile cap; point rebates have none', () => {
  const ctx = { fmt: (n) => Number(n).toLocaleString('en-US') };
  vm.createContext(ctx);
  vm.runInContext(`${grab('features.js', /function promoCap\(p\) \{[\s\S]*?\n\}/)}\n${grab('features.js', /const capText = .*;/)}\nthis.promoCap = promoCap; this.capText = capText;`, ctx);
  const promos = read('promos.json').promos;
  const kgi = promos.find((p) => p.bank === '凱基' && p.bonusPct === 0);
  if (kgi) {
    assert.deepEqual({ ...ctx.promoCap(kgi) }, { miles: 500, per: '月' });
    assert.equal(ctx.capText(ctx.promoCap(kgi)), '每月最多加贈 500 哩');
  }
  assert.deepEqual({ ...ctx.promoCap({ cap: { miles: 1000, per: '人' } }) }, { miles: 1000, per: '人' });
  assert.equal(ctx.promoCap({ conditions: '每人每月上限160點、每月限1,000名' }), null);
  assert.deepEqual({ ...ctx.promoCap({ conditions: '每戶每月一次，每月加贈上限1,500哩' }) }, { miles: 1500, per: '戶' });
});

test('co-brand cards are found for the programs the earn section names', () => {
  const ctx = {};
  vm.createContext(ctx);
  const cob = read('points.json').cobrand;
  ctx.data = { points: { cobrand: cob } };
  vm.runInContext(`${grab('features.js', /const COBRAND_MATCH = .*;/)}\n${grab('features.js', /const cobrandFor = .*;/)}\nthis.M = COBRAND_MATCH; this.cobrandFor = cobrandFor;`, ctx);
  // 新光 JAL stopped earning on 2026-04-30: it stays in the 規則庫 table but is not suggested any more.
  const live = Object.keys(ctx.M).filter((key) => ctx.cobrandFor(key).length);
  assert.deepEqual(Object.keys(ctx.M).filter((key) => !live.includes(key)), ['jal']);
  assert.ok(cob.some((c) => c.ended && c.program.includes(ctx.M.jal)));
  assert.ok(ctx.cobrandFor('eva').every((c) => !c.ended));
});

test('結果卡 🎁 轉點加贈: today\'s bank bonuses into the card\'s program, rebates left out, each bank in the title', () => {
  const today = new Date().toISOString().slice(0, 10);
  const promos = [
    { type: 'transfer', program: 'asiamiles', bank: null, excludeBanks: ['台新'], bonusPct: 8, bonusPer: [10000, 800], start: '2000-01-01', end: '2999-10-31', title: 'A' },
    { type: 'transfer', program: 'asiamiles', bank: '凱基', bonusPct: 0, start: '2000-01-01', end: '2999-12-31', title: '凱基每月5日換亞萬 加贈500哩' },
    { type: 'transfer', program: 'asiamiles', bank: '台新', bonusPct: 8, rebate: true, start: '2000-01-01', end: '2999-10-31', title: 'R' },
    { type: 'transfer', program: 'eva', bank: '國泰世華', bonusPct: 10, start: '2999-01-01', end: '2999-02-01', title: 'later' },
  ];
  const ctx = { data: { promos: { promos } }, fmt: (n) => Number(n).toLocaleString('en-US'), isoDate: () => today, mmdd: (d) => d.slice(5).replace('-', '/'),
    esc: (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])), SOURCE_NAMES: { asiamiles: '亞洲萬里通' } };
  vm.createContext(ctx);
  vm.runInContext([/const EXTRA_PROGRAM_NAMES = .*;/, /const programName = .*;/, /const PROGRAM_TRANSFER = \{[\s\S]*?\n\};/, /const PROGRAM_KEY = .*;/, /const programKeyOf = .*;/,
    /const PROMO_COL = .*;/, /const promoCol = .*;/, /const activePromos = \(\) => \{[\s\S]*?\n\};/, /function transferPromosFor\([\s\S]*?\n\}/, /const promoBonusText = .*;/,
    /const promoBankText = .*;/, /function transferBonusTag\([\s\S]*?\n\}/].map((re) => grab('features.js', re)).join('\n') + '\nthis.tag = transferBonusTag;', ctx);
  const tag = ctx.tag({ source: 'asiamiles' });
  assert.match(tag, /🎁 轉點加贈 8%<\/span>$/);
  assert.match(tag, /各銀行（台新除外）：每 10,000 哩加贈 800 哩（到 10\/31）/);
  assert.match(tag, /凱基：凱基每月5日換亞萬 加贈500哩（到 12\/31）/);
  assert.doesNotMatch(tag, /台新：/);
  assert.equal(ctx.tag({ source: 'eva' }), '', 'not started yet');
  assert.equal(ctx.tag({ source: 'aeroplan' }), '', 'no bonus into it');
  assert.match(ctx.tag({ source: 'asiamiles_est' }), /轉點加贈 8%/, 'the Asia Miles estimate counts as Asia Miles');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8'), /typeof transferBonusTag === 'function' \? transferBonusTag\(r\) : ''/);
});

test('混艙行程: 「X 至少佔」 filter, remembered, 不限 by default', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'flightplus.js'), 'utf8');
  assert.match(src, /const MIXED_MIN = \[0, 70, 80, 90\];/);
  assert.match(src, /store\.get\('mixedMin:v1', 0\)/);
  assert.match(src, /list\.filter\(\(t\) => 100 - t\.mixedPct >= min\)/);
});
