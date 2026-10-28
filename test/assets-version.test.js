// Scripts, styles and data are cached a year under ?v=<version>: a change to any of them needs a version bump
// (node scripts/bump-version.js patch "…"), or visitors keep old copies beside new ones.
const { test } = require('node:test');
const assert = require('node:assert');
const { assetHash } = require('../scripts/asset-hash');
const version = require('../data/version.json');

test('the cached files are the ones the current version was bumped with', () => {
  assert.equal(assetHash(), version.assets, '有檔案改了但版本號沒換：請執行 node scripts/bump-version.js patch "這次改了什麼"');
});
