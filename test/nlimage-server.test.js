// 貼上截圖 over HTTP in the demo (no seats.aero key, no model key: a made-up answer): the page-only and passcode gates,
// the size cap and a bad file refused before anything is counted. Own file (own process) for its environment.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
delete process.env.SEATS_AERO_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.CASH_PASSCODE;
delete process.env.CRON_SECRET;
delete process.env.MOCK;
process.env.NL_IMAGE_DAILY_LIMIT = '3';
const { server } = require('../server');
const { MAX_IMAGE_BYTES } = require('../lib/nlimage');

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => { server.close(); delete process.env.NL_IMAGE_DAILY_LIMIT; });

const JPEG = `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, 1)]).toString('base64')}`;
const page = { 'x-requested-with': 'fetch', 'content-type': 'application/json' };
const shot = async (body, headers = page, method = 'POST') => {
  const res = await fetch(base + '/api/nl/image', { method, headers, body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const ask = { air: 'ci', from: 'TPE', to: 'NRT', start: '2027-01-10', end: '2027-01-20', cabin: 'J', image: JPEG };

test('the demo reads a screenshot into the lines 貼上 AI 助理的結果 takes', async () => {
  const r = await shot(ask);
  assert.equal(r.status, 200);
  assert.equal(r.json.mock, true);
  assert.equal(r.json.limit, 3);
  assert.match(r.json.text, /^華航查票結果 TPE-NRT\n2027-01-10 \| 商務 \| 充足 \| 58000 \| CI100\n/);
  assert.ok(!Object.keys(require.cache).some((k) => k.includes('@anthropic-ai')));
});

test('only from the site page, only POST; a bad file or airline is refused before counting', async () => {
  assert.equal((await shot(ask, { 'content-type': 'application/json' })).status, 403);
  assert.equal((await shot(ask, { ...page, 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await shot(null, page, 'GET')).status, 405);
  assert.equal((await shot({ ...ask, image: 'data:text/plain;base64,aGVsbG8=' })).status, 400);
  assert.equal((await shot({ ...ask, air: 'nh' })).status, 400);
  assert.equal((await shot('not json')).status, 400);
  // Past the body cap the rest is thrown away unread.
  const big = await shot({ ...ask, image: `data:image/jpeg;base64,${'A'.repeat(Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 8000)}` });
  assert.equal(big.status, 400);
  assert.match(big.json.error, /太長/);
  const r = await shot(ask);
  assert.equal(r.json.used, 2); // only the two good reads counted
});

test('with a passcode set: locked without it, open with it; the own daily cap', async () => {
  process.env.CASH_PASSCODE = 'sunny';
  try {
    const locked = await shot(ask, { ...page, 'x-forwarded-for': '10.81.0.1' });
    assert.equal(locked.status, 401);
    assert.equal(locked.json.code, 'passcode');
    const ok = await shot(ask, { ...page, 'x-cash-pass': 'sunny', 'x-forwarded-for': '10.81.0.2' });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.used, 3);
    const over = await shot(ask, { ...page, 'x-cash-pass': 'sunny', 'x-forwarded-for': '10.81.0.2' });
    assert.equal(over.status, 429);
    assert.equal(over.json.code, 'nl-limit');
  } finally {
    delete process.env.CASH_PASSCODE;
  }
});
