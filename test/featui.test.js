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
  vm.runInContext(`${grab('features.js', /const COBRAND_MATCH = .*;/)}\nthis.M = COBRAND_MATCH;`, ctx);
  const cob = read('points.json').cobrand;
  for (const [key, word] of Object.entries(ctx.M)) assert.ok(cob.some((c) => c.program.includes(word)), `${key} (${word}) has a co-brand card`);
});
