#!/usr/bin/env node
// Bump data/version.json before committing a user-visible change.
//   node scripts/bump-version.js patch "修正日期選擇器"   → 1.9.0 → 1.9.1
//   node scripts/bump-version.js minor "新增 XX 功能"     → 1.9.0 → 1.10.0
// Sets `updated` to today's date in Taipei and prepends the note to `history` (keeps 20 entries).
// Write the note for visitors (the page footer shows it). An entry may also carry `user`, a plain-language line shown
// instead of `note` when `note` is technical.
const fs = require('node:fs');
const path = require('node:path');

const file = path.join(__dirname, '..', 'data', 'version.json');
const [kind = 'patch', ...noteParts] = process.argv.slice(2);
const note = noteParts.join(' ').trim();
if (!['major', 'minor', 'patch'].includes(kind)) {
  console.error('用法：node scripts/bump-version.js <major|minor|patch> "這次改了什麼"');
  process.exit(1);
}
if (!note) {
  console.error('請在版本類型後面加上一句說明，會顯示在頁尾的更新紀錄裡。');
  process.exit(1);
}

const v = JSON.parse(fs.readFileSync(file, 'utf8'));
let [major, minor, patch] = v.version.split('.').map(Number);
if (kind === 'major') { major++; minor = 0; patch = 0; } else if (kind === 'minor') { minor++; patch = 0; } else patch++;
const version = `${major}.${minor}.${patch}`;
const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(new Date());
v.version = version;
v.updated = date;
v.history = [{ version, date, note }, ...(v.history || [])].slice(0, 20);
// What this release's cached files hold (test/assets-version.test.js checks nothing changed after the bump).
v.assets = require('./asset-hash').assetHash();
fs.writeFileSync(file, `${JSON.stringify(v, null, 2)}\n`);
// Cache-bust the page's script and stylesheet URLs (?v=) so browsers fetch the new release, and keep the preloaded
// data bundle URL the same as the one app.js asks for (it takes ?v= from its own script URL).
const page = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(page, 'utf8');
const next = html.replace(/(\.(?:js|css)|\/api\/data\/core)\?v=[\w.-]+/g, `$1?v=${version}`);
if (next !== html) fs.writeFileSync(page, next);
console.log(`版本 ${version}（${date}）：${note}`);
