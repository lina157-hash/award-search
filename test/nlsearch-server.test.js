// 一句話搜尋 over HTTP in the demo (no seats.aero key, no ANTHROPIC_API_KEY: the demo parser): the page-only and
// passcode gates, and that the Anthropic SDK is never loaded for it. Own file (own process) for its environment.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
delete process.env.SEATS_AERO_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.CASH_PASSCODE;
delete process.env.CRON_SECRET;
delete process.env.MOCK;
const { server } = require('../server');

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

const page = { 'x-requested-with': 'fetch', 'content-type': 'application/json' };
const nl = async (text, headers = page, method = 'POST') => {
  const res = await fetch(base + '/api/nl', { method, headers, body: method === 'POST' ? JSON.stringify({ text }) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

test('config says the box may show; the demo parser answers from the page', async () => {
  const cfg = await (await fetch(base + '/api/config')).json();
  assert.equal(cfg.nl, true);
  assert.ok(!JSON.stringify(cfg).includes('ANTHROPIC'));
  const r = await nl('十二月兩個人去大阪，經濟艙直飛就好');
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.origin, r.json.destination, r.json.cabin, r.json.pax, r.json.direct, r.json.mock], [['TPE'], ['KIX'], 'Y', 2, true, true]);
  assert.equal(r.json.limit, 100);
  assert.ok(r.json.used >= 1);
  // The Anthropic SDK stays unloaded: only lib/nlsearch.js would require it, and only for a live call.
  assert.ok(!Object.keys(require.cache).some((k) => k.includes('@anthropic-ai')));
});

test('only from the site page, only POST', async () => {
  assert.equal((await nl('去大阪', { 'content-type': 'application/json' })).status, 403);
  assert.equal((await nl('去大阪', { ...page, 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await nl('', page, 'GET')).status, 405);
  assert.equal((await nl('   ')).status, 400);
});

test('with a passcode set: locked without it, open with it', async () => {
  process.env.CASH_PASSCODE = 'sunny';
  try {
    const locked = await nl('高雄出發去曼谷', { ...page, 'x-forwarded-for': '10.80.0.1' });
    assert.equal(locked.status, 401);
    assert.equal(locked.json.code, 'passcode');
    const wrong = await nl('高雄出發去曼谷', { ...page, 'x-cash-pass': 'nope', 'x-forwarded-for': '10.80.0.2' });
    assert.equal(wrong.status, 401);
    const ok = await nl('高雄出發去曼谷', { ...page, 'x-cash-pass': 'sunny', 'x-forwarded-for': '10.80.0.3' });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json.destination, ['BKK']);
  } finally {
    delete process.env.CASH_PASSCODE;
  }
});
