// 貼上確認信 over HTTP in the demo (no model key: the demo reader): page only, POST only, the passcode gate, nothing kept;
// and the owner's 行程提醒 saved through /api/expiry next to the miles list. Own file (own process) for its environment.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
delete process.env.SEATS_AERO_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.CASH_PASSCODE;
delete process.env.CRON_SECRET;
delete process.env.MOCK;
const { server } = require('../server');

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

const page = { 'x-requested-with': 'fetch', 'content-type': 'application/json' };
const call = async (p, { method = 'POST', headers = page, body } = {}) => {
  const res = await fetch(base + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const MAIL = '長榮航空 電子機票\n訂位代號 QWE789\nBR 198 2027/03/03 TPE 08:50 NRT 13:15 經濟艙\nBR 197 2027/03/10 NRT 14:30 TPE 17:20 經濟艙';

test('the demo reader turns a pasted mail into plan legs', async () => {
  const r = await call('/api/nl/ticket', { body: { text: MAIL } });
  assert.equal(r.status, 200);
  assert.equal(r.json.mock, true);
  assert.equal(r.json.limit, 20);
  assert.deepEqual(r.json.legs.map((l) => [l.k, l.date, l.from, l.to, l.flights, l.dep, l.arr, l.pnr, l.cabin]), [
    ['c', '2027-03-03', 'TPE', 'NRT', 'BR 198', '08:50', '13:15', 'QWE789', 'Y'],
    ['c', '2027-03-10', 'NRT', 'TPE', 'BR 197', '14:30', '17:20', 'QWE789', 'Y'],
  ]);
});

test('only from the page, only POST, empty and over-long text refused', async () => {
  assert.equal((await call('/api/nl/ticket', { headers: { 'content-type': 'application/json' }, body: { text: MAIL } })).status, 403);
  assert.equal((await call('/api/nl/ticket', { method: 'GET', body: undefined })).status, 405);
  assert.equal((await call('/api/nl/ticket', { body: { text: '  ' } })).status, 400);
  assert.equal((await call('/api/nl/ticket', { body: { text: 'x'.repeat(6001) } })).status, 400);
});

test('with a passcode set: locked without it, open with it', async () => {
  process.env.CASH_PASSCODE = 'sunny';
  try {
    const locked = await call('/api/nl/ticket', { headers: { ...page, 'x-forwarded-for': '10.81.0.1' }, body: { text: MAIL } });
    assert.equal(locked.status, 401);
    assert.equal(locked.json.code, 'passcode');
    const ok = await call('/api/nl/ticket', { headers: { ...page, 'x-cash-pass': 'sunny', 'x-forwarded-for': '10.81.0.2' }, body: { text: MAIL } });
    assert.equal(ok.status, 200);
    // The owner's trip reminders save beside the miles list (same passcode).
    const saved = await call('/api/expiry', { headers: { ...page, 'x-cash-pass': 'sunny', 'x-forwarded-for': '10.81.0.3' }, body: { email: 'me@example.com', notes: [{ key: 'checkin-TPENRT-2027-03-03', name: 'BR198 開放線上報到', date: '2027-03-01', steps: [0] }], passport: { expiry: '2028-01-01' } } });
    assert.deepEqual(saved.json, { ok: true, count: 2, email: 'me@example.com' });
    assert.equal((await call('/api/expiry', { headers: { ...page, 'x-forwarded-for': '10.81.0.4' }, body: { email: 'x@example.com', notes: [] } })).status, 401);
  } finally {
    delete process.env.CASH_PASSCODE;
  }
});

test('the data bundle carries the trip rules for the page', async () => {
  const r = await fetch(`${base}/api/data/more`).then((x) => x.json());
  assert.ok(r.trips?.checkin?.BR && r.trips.passport?.countries?.TH && r.trips.accrual?.CI && r.trips.cardPerks?.cards?.length);
});
