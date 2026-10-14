const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

test('Vercel adapter drops the rewrite params so public lookups are not redirected in a loop', () => {
  const load = Module._load;
  let seen;
  Module._load = function (req, ...rest) { return req === '../server' ? { route: (r) => { seen = r.url; } } : load.call(this, req, ...rest); };
  try {
    delete require.cache[require.resolve('../api/index.js')];
    const handler = require('../api/index.js');
    handler({ url: '/api/index?__path=search&path=search&origin=TPE&cabin=J' }, {});
    assert.strictEqual(seen, '/api/search?origin=TPE&cabin=J');
    handler({ url: '/api/index?__path=hotels/search&path=hotels%2Fsearch&where=Tokyo' }, {});
    assert.strictEqual(seen, '/api/hotels/search?where=Tokyo');
  } finally {
    Module._load = load;
    delete require.cache[require.resolve('../api/index.js')];
  }
});
