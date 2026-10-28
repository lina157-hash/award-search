// One hash over every file browsers cache for a year under ?v=<version>: public scripts, styles and JSON, and the
// data bundles (/api/data/*?v=). bump-version.js records it in data/version.json; a test fails when a file changed
// after the last bump, so a release never ships new files under an old ?v= (visitors would mix old and new copies).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.join(__dirname, '..');
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}
function assetFiles() {
  const pub = walk(path.join(root, 'public')).filter((f) => /\.(js|css|json)$/.test(f));
  const data = fs.readdirSync(path.join(root, 'data')).filter((f) => f.endsWith('.json') && f !== 'version.json').map((f) => path.join(root, 'data', f));
  return [...pub, ...data].map((f) => path.relative(root, f).split(path.sep).join('/')).sort();
}
function assetHash() {
  const h = crypto.createHash('sha256');
  for (const rel of assetFiles()) h.update(rel).update('\0').update(fs.readFileSync(path.join(root, rel))).update('\0');
  return h.digest('hex').slice(0, 16);
}
module.exports = { assetHash, assetFiles };
