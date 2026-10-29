// 區域探索's raised page cap (owner, 2026-10-29): the pages stop before the run's deadline, and a long list is gzipped.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('../lib/seats');

test('bulk availability pages until done, or stops (and says it was cut) when the deadline is near', async () => {
  let n = 0;
  const page = (i) => ({ ok: true, status: 200, json: async () => ({ data: [{ ID: `r${i}` }], hasMore: true, cursor: i }) });
  const client = createClient({ apiKey: 'k', fetchImpl: async () => page(++n) });
  const all = await client.availability({ source: 'aeroplan' }, { maxPages: 21 });
  assert.equal(n, 21);
  assert.equal(all.items.length, 21);
  n = 0;
  const cut = await client.availability({ source: 'aeroplan' }, { maxPages: 21, until: Date.now() + 5000 });
  assert.equal(n, 1, 'one page, then too close to the deadline for another');
  assert.equal(cut.hasMore, true);
});

test('the explore cap is 3 times the old one; big answers go gzipped', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /const EXPLORE_PAGE_X = 3;/);
  assert.match(src, /pagesFor\(params, 3\) \* EXPLORE_PAGE_X/);
  assert.match(src, /'content-encoding': 'gzip'/);
});
