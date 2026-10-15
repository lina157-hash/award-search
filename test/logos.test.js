// 規則庫 logos: every listed logo has a small file in public/logos, every airline the rules page names gets a logo or a
// coloured badge, and the helpers never put anything but a two-character code into the markup.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (f) => JSON.parse(fs.readFileSync(path.join(root, 'data', f), 'utf8'));
const ctx = {};
vm.createContext(ctx);
vm.runInContext(`${fs.readFileSync(path.join(root, 'public', 'logos.js'), 'utf8')}
this.LOGO_CODES = LOGO_CODES; this.ALLIANCE_LOGOS = ALLIANCE_LOGOS; this.AIRLINE_COLOR = AIRLINE_COLOR;
this.airlineLogo = airlineLogo; this.allianceLogo = allianceLogo;`, ctx);
const dir = path.join(root, 'public', 'logos');

test('each listed logo has a small WebP file, and every file is listed', () => {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.webp')).map((f) => f.slice(0, -5)).sort();
  const listed = [...ctx.LOGO_CODES, ...ctx.ALLIANCE_LOGOS].sort();
  assert.deepEqual(files, listed);
  let total = 0;
  for (const f of files) {
    const buf = fs.readFileSync(path.join(dir, `${f}.webp`));
    assert.equal(buf.toString('latin1', 0, 4) + buf.toString('latin1', 8, 12), 'RIFFWEBP', `${f}.webp is a WebP`);
    assert.ok(buf.length < 12000, `${f}.webp is small`);
    total += buf.length;
  }
  assert.ok(total < 300000, `logos total ${total} bytes`);
  assert.ok(fs.existsSync(path.join(dir, 'CREDITS.txt')), 'sources and licences are noted');
});

test('every airline on the rules page gets a logo or a coloured badge', () => {
  const codes = new Set([
    ...read('alliances.json').alliances.flatMap((a) => [...a.members, ...(a.memberNotes || []).map((n) => n.code)]),
    ...read('airlines.json').airlines.map((a) => a.code),
    ...read('programs.json').programs.map((p) => p.airline).filter(Boolean),
  ]);
  const missing = [...codes].filter((c) => !ctx.LOGO_CODES.has(c) && !ctx.AIRLINE_COLOR[c]);
  assert.deepEqual(missing, []);
  for (const a of read('alliances.json').alliances) assert.match(ctx.allianceLogo(a.id), new RegExp(`/logos/${a.id}\\.webp`));
});

test('logo markup: file, badge fallback, nothing for odd input', () => {
  assert.match(ctx.airlineLogo('cx'), /<img src="\/logos\/CX\.webp" alt=""/);
  const badge = ctx.airlineLogo('Q9');
  assert.match(badge, /alogo-code/);
  assert.match(badge, />Q9<\/span>$/);
  assert.equal(ctx.airlineLogo('<b>'), '');
  assert.equal(ctx.airlineLogo(null), '');
  assert.equal(ctx.allianceLogo('valuealliance'), '');
});
