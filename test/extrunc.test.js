// 區域探索 cut short by seats.aero (bulk rows come in date order): the note says which days were covered, and once the
// result filters pick airports each way, offers the route search for the full range.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const grab = (re) => { const m = app.match(re); assert.ok(m, String(re)); return m[0]; };
const ctx = { esc: (s) => String(s), mmdd: (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}` };
vm.createContext(ctx);
vm.runInContext([grab(/function exploreCoverage\(e\) \{[\s\S]*?\n\}/), grab(/function exploreTruncNote\(cov\) \{[\s\S]*?\n\}/), 'this.f = { exploreCoverage, exploreTruncNote };'].join('\n'), ctx);
const { exploreCoverage, exploreTruncNote } = ctx.f;

const rows = ['2026-10-24', '2026-10-18', '2026-10-30'].map((date) => ({ date, origin: 'TPE', destination: 'PVG' }));
const ex = (over) => ({ rows, truncated: true, cabin: 'Y', f: {}, q: { start: '2026-10-18', end: '2027-10-17' }, ...over });

test('a full answer has no note', () => {
  assert.equal(exploreCoverage(ex({ truncated: false })), null);
  assert.equal(exploreTruncNote(null), '');
});

test('a cut-off answer names the days it covered and that later days were not checked', () => {
  const cov = exploreCoverage(ex());
  assert.equal(cov.from, '2026-10-18');
  assert.equal(cov.to, '2026-10-30');
  assert.equal(cov.route, null);
  const note = exploreTruncNote(cov);
  assert.match(note, /10\/18–10\/30/);
  assert.match(note, /10\/30 之後的日期這次沒查到，不代表沒位/);
  assert.doesNotMatch(note, /ex-route/);
  assert.doesNotMatch(note, /5,000/);
});

test('with airports picked, a button opens the route search over the same dates and cabin', () => {
  const cov = exploreCoverage(ex({ f: { origin: new Set(['TPE']), destination: new Set(['PVG']) } }));
  assert.deepEqual({ ...cov.route }, { o: 'TPE', d: 'PVG', s: '2026-10-18', e: '2027-10-17', c: 'Y', calls: 3 });
  assert.match(exploreTruncNote(cov), /id="ex-route"[^>]*>改用航線查詢看 TPE → PVG 的完整日期（最多 3 次查詢）/);
  // Only one side picked, or too many airports: no button.
  assert.equal(exploreCoverage(ex({ f: { origin: new Set(['TPE']) } })).route, null);
  assert.equal(exploreCoverage(ex({ f: { origin: new Set(['TPE']), destination: new Set(['A', 'B', 'C', 'D', 'E', 'F']) } })).route, null);
});
