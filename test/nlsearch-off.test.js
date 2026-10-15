// 一句話搜尋 on a live site without ANTHROPIC_API_KEY: invisible. /api/config says nl: false and /api/nl is a 404.
// Own file (own process): the server reads its keys when it loads. No request here reaches seats.aero.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
process.env.SEATS_AERO_API_KEY = 'test-not-a-real-key';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.MOCK;
delete process.env.CASH_PASSCODE;
const { server } = require('../server');

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => { server.close(); delete process.env.SEATS_AERO_API_KEY; });

test('no key: no box, no endpoint', async () => {
  const cfg = await (await fetch(base + '/api/config')).json();
  assert.equal(cfg.mock, false);
  assert.equal(cfg.nl, false);
  for (const method of ['POST', 'GET']) {
    const res = await fetch(base + '/api/nl', { method, headers: { 'x-requested-with': 'fetch', 'content-type': 'application/json' }, body: method === 'POST' ? '{"text":"去大阪"}' : undefined });
    assert.equal(res.status, 404);
  }
});
