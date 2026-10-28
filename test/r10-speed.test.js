// Round 10 speed and steadiness: the route results don't wait for the search scripts (they add their parts when they
// arrive, search:done replayed for them), the 更多分析 extras come after the first paint, the status line and the
// placeholders keep the room of what replaces them, and 規則庫 builds a topic's body when it first opens.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
function grab(file, re) {
  const m = src(file).match(re);
  assert.ok(m, `${re} in ${file}`);
  return m[0];
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const run = (ctx, code) => { vm.createContext(ctx); vm.runInContext(code, ctx); return ctx; };

test('search:done is replayed for a search script that arrives after the results', () => {
  const document = new EventTarget();
  class CustomEvent extends Event { constructor(type, o) { super(type); this.detail = o?.detail; } }
  const c = run({ document, CustomEvent }, `${grab('app.js', /let lastSearchDone = null;\nfunction onSearchDone\(fn\) \{[\s\S]*?\n\}/)}
    this.setDone = (d) => { lastSearchDone = d; if (d) document.dispatchEvent(new CustomEvent('search:done', { detail: d })); };`);
  const seen = [];
  c.onSearchDone((e) => seen.push(`early ${e.detail.share}`));
  c.setDone({ share: 'o=TPE' });
  c.onSearchDone((e) => seen.push(`late ${e.detail.share}`)); // arrived after the table
  c.setDone(null); // a new search started
  c.onSearchDone((e) => seen.push(`during ${e.detail.share}`)); // arrived while it runs: only its own search:done
  c.setDone({ share: 'o=KHH' });
  assert.deepEqual(seen, ['early o=TPE', 'late o=TPE', 'early o=KHH', 'late o=KHH', 'during o=KHH']);
  // Every search script that answers search:done goes through it; nlsearch.js only acts on a search its box started
  // (nl.armed is set on submit), so it was there before the results.
  const app = src('app.js');
  const list = JSON.parse(grab('app.js', /const SEARCH_SCRIPTS = (\[[^\]]*\])/).replace(/^[^[]*/, '').replace(/'/g, '"'));
  for (const f of list) {
    const s = src(`${f}.js`);
    if (f === 'nlsearch') { assert.match(s, /if \(!nl\.armed\) return;/); continue; }
    assert.doesNotMatch(s, /addEventListener\('search:done'/, `${f}.js listens with onSearchDone`);
  }
  assert.match(src('flightdata.js'), /^onSearchDone\(\(e\) => \{ ttSearchDone/m);
  assert.match(app, /lastSearchDone = null;\n  document\.dispatchEvent\(new CustomEvent\('search:start'\)\);/);
});

test('route results wait for the answer, the second data part and the tools only; the extras come after the paint', () => {
  const app = src('app.js');
  const body = grab('app.js', /async function runSearch\(share, pre, autoRange = false\) \{[\s\S]*?\n\}/);
  assert.match(body, /await Promise\.all\(\[pre \|\| api\(`\/api\/search\?\$\{params\}`\), loadMore\(\), loadTools\(\)\]\)/);
  assert.doesNotMatch(body.slice(0, body.indexOf('renderSearch();')), /loadSearchScripts|loadTripInfo|histShow\(share\)/);
  // After the table: 出發前小提醒, then the search scripts (the table again if they weren't all in) and 釋位紀錄.
  const after = body.slice(body.indexOf('afterPaint(() => {'));
  assert.match(after, /^afterPaint\(\(\) => \{\n\s+if \(!fresh\(\)\) return;\n\s+loadTripInfo\(/);
  assert.match(after, /loadSearchScripts\(\)\.then\(\(\) => \{\n\s+if \(!fresh\(\)\) return;\n\s+if \(!drawnWith\) renderSearch\(\);\n\s+if \(typeof histShow === 'function'\) histShow\(share\);/);
  assert.ok(body.indexOf('const drawnWith = searchScriptsIn();') < body.indexOf('renderSearch();'));
  // 航班明細 from the results waits for them (混艙, 這班還可以用, 也看混艙行程); the first tap warms the tools first.
  assert.match(app, /loadScripts\(\['flightdata'\]\), loadAirports\(\), \$\('#tab-search'\)\.hidden \? null : loadSearchScripts\(\)\]/);
  assert.match(app, /const warmMore = \(\) => \{ Promise\.allSettled\(\[loadMore\(\), loadTools\(\)\]\)\.then\(\(\) => loadSearchScripts\(\)\); \};/);

  // afterPaint: a frame, then idle time (at most a second), or a timer where there is no requestIdleCallback.
  const calls = [];
  const ctx = { requestAnimationFrame: (f) => { calls.push('raf'); f(); }, setTimeout: (f, ms) => { calls.push(`timeout ${ms}`); f(); } };
  run(ctx, `${grab('app.js', /const afterPaint = [^\n]*/)}; this.afterPaint = afterPaint;`);
  ctx.afterPaint(() => calls.push('ran'));
  ctx.requestIdleCallback = (f, o) => { calls.push(`idle ${o.timeout}`); f(); };
  ctx.afterPaint(() => calls.push('ran'));
  assert.deepEqual(calls, ['raf', 'timeout 0', 'ran', 'raf', 'idle 1000', 'ran']);
});

test('lazy scripts: which have run and which failed, for the 國泰 card placeholder', () => {
  const made = [];
  const document = { createElement: () => ({ remove() {} }), body: { append: (el) => made.push(el) } };
  const c = run({ document, ASSET_V: '' }, `${grab('app.js', /const lazyScripts = \{\};[\s\S]*?\n\}\n/)}
    this.loadScripts = loadScripts; this.lazyIn = lazyIn; this.lazyOut = lazyOut; this.lazyScripts = lazyScripts;`);
  c.loadScripts(['cxcard']);
  made[0].onerror();
  assert.ok(c.lazyOut.has('cxcard') && !c.lazyScripts.cxcard, 'failed: fetched again on the next ask');
  c.loadScripts(['cxcard']);
  made[1].onload();
  assert.ok(c.lazyIn.has('cxcard') && !c.lazyOut.has('cxcard'));

  const ctx = { lazyIn: new Set(), lazyOut: new Set(), state: { results: [] } };
  run(ctx, `${grab('app.js', /const cxCardComing = [^\n]*/)}\n${grab('app.js', /const cxWaitHtml = [^\n]*/)}; this.cxCardComing = cxCardComing; this.cxWaitHtml = cxWaitHtml;`);
  assert.equal(ctx.cxCardComing(), true);
  ctx.state.results = [{ source: 'united', cabins: { J: { available: true, miles: 80000 } } }];
  assert.equal(ctx.cxWaitHtml(), '<div class="cxc cxc-wait" aria-hidden="true"><i></i><i class="m"></i></div>', 'heading and 其他 ▾ only');
  ctx.state.results.push({ source: 'asiamiles_est', cabins: { J: { available: true, miles: 58000 } } });
  assert.match(ctx.cxWaitHtml(), /<i><\/i><i class="r"><\/i><i class="m"><\/i>/, 'with a cabin line');
  ctx.lazyOut.add('cxcard');
  assert.equal(ctx.cxCardComing(), false, 'it failed: the plain Asia Miles callouts');
  const app = src('app.js');
  assert.match(app, /parts\.am = typeof cxBadgeHtml === 'function' \|\| cxCardComing\(\) \? '' :/);
  assert.match(app, /\$\{typeof cxBadgeHtml === 'function' \? cxBadgeHtml\(c\) : cxCardComing\(\) \? cxWaitHtml\(\) : ''\}/);
  assert.match(src('cxcard.js'), /const old = document\.getElementById\('cxc-card'\) \|\| document\.querySelector\('#search-results \.cxc-wait'\);/, 'a redraw before the table is drawn again takes its place');
  // Its bars are the folded card's lines: heading 22px, cabin line 22px (41px on phones, two lines), 其他 ▾ 32px.
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(css, /\.cxc-wait > i \{ display: block; height: 22px;/);
  assert.match(css, /\.cxc-wait > i\.m \{ height: 32px; margin-top: 4px;/);
  assert.match(css, /\n {2}\.cxc-w \{ flex-basis: 100%;[^\n]*\n {2}\.cxc-row:not\(\.cur\) \.cxc-w \{ display: none; \}\n {2}\.cxc-wait > i\.r \{ height: 41px; \}/);
});

test('the status line keeps the room of its buttons while searching; placeholders keep the footer down', () => {
  const ctx = { esc };
  run(ctx, `${grab('app.js', /function statusActionsHtml\(hold = false\) \{[\s\S]*?\n\}/)}\n${grab('app.js', /function searchingStatusHtml\(autoNote = ''\) \{[\s\S]*?\n\}/)}
    this.statusActionsHtml = statusActionsHtml; this.searchingStatusHtml = searchingStatusHtml;`);
  const done = ctx.statusActionsHtml();
  const hold = ctx.statusActionsHtml(true);
  for (const id of ['alert-btn', 'to-cash', 'fav-btn', 'share-btn']) {
    assert.ok(done.includes(`id="${id}"`), id);
    assert.ok(!hold.includes(id), `no second ${id} while searching`);
  }
  assert.equal(hold.replace(/ class="status-actions status-hold" aria-hidden="true"/, ' class="status-actions"'), done.replace(/ id="[^"]+"/g, ''), 'the same buttons');
  const wait = ctx.searchingStatusHtml();
  assert.match(wait, /^<span>正在搜尋各哩程計畫的獎勵位…<small class="fresh status-hold" aria-hidden="true">🕒 資料最新 剛剛更新<\/small><\/span><span class="status-actions status-hold"/);
  assert.match(ctx.searchingStatusHtml('沒有選日期 <x>'), /^<span>沒有選日期 &lt;x&gt;<small class="fresh">搜尋中…<\/small><\/span>/);
  const app = src('app.js');
  assert.match(app, /status\.innerHTML = searchingStatusHtml\(autoNote\);/);
  assert.match(app, /\$\('#search-status'\)\.innerHTML = searchingStatusHtml\(\);/, 'a share link searching while the page loads');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(css, /^\.status-hold \{ visibility: hidden; \}/m);
  assert.match(css, /^#search-results > \.skeleton, #hotels-page > \.skeleton \{ min-height: 85vh; align-content: start; \}/m);
});

test('規則庫 builds a topic body when it first opens; with a query, all at once', () => {
  const ctx = { rulesState: { q: '' } };
  run(ctx, `let rulesLazy = [];\n${grab('app.js', /function rulesSection\(html, cls = '', sum = ''\) \{[\s\S]*?\n\}/)}
    this.rulesSection = rulesSection; this.lazy = () => rulesLazy;`);
  const html = '<h2 class="section" id="r-x">標題</h2><div class="cards">內容</div>';
  assert.equal(ctx.rulesSection(html, 'c', '摘要'), '<details class="rules-sec rules-fold c" ><summary><h2 class="section" id="r-x">標題</h2><small class="sec-sum">摘要</small></summary><div class="sec-body" data-lazy="0"></div></details>');
  assert.deepEqual(ctx.lazy(), ['<div class="cards">內容</div>']);
  ctx.rulesState.q = '內容';
  assert.match(ctx.rulesSection(html), /<details class="rules-sec rules-fold " open><summary>[\s\S]*<\/summary><div class="sec-body"><div class="cards">內容<\/div><\/div><\/details>/);
  const app = src('app.js');
  // The tap (before the section shows) or its toggle builds it; 全部展開 and the links into a section build first.
  assert.match(app, /\$\('#rules-body'\)\.addEventListener\('click', \(e\) => \{ const d = e\.target\.closest\('summary'\)\?\.parentElement; if \(d\?\.matches\('\.rules-fold'\)\) rulesBuild\(d\); \}, true\);/);
  assert.match(app, /\$\('#rules-body'\)\.addEventListener\('toggle', \(e\) => \{ if \(e\.target\.open && e\.target\.matches\('\.rules-fold'\)\) rulesBuild\(e\.target\); \}, true\);/);
  assert.match(app, /\$\('#rules-all'\)\.addEventListener\('click', \(\) => \{\n\s+rulesBuild\(\$\('#rules-body'\)\);/);
  assert.match(app, /const target = a\.dataset\.anchor && rulesFind\(a\.dataset\.anchor\);/);
  assert.match(src('features.js'), /const el = rulesFind\(`prog-\$\{id\}`\);/);
  assert.match(src('rtw.js'), /const m = rulesFind\('cxmix'\);/);
  // A built body gets what renderRulesBody gave the page: its chips, program cards, points filter and tab links.
  assert.match(grab('app.js', /function rulesBuild\(root\) \{[\s\S]*?\n\}/), /box\.innerHTML = rulesLazy\[box\.dataset\.lazy\];\n\s+box\.removeAttribute\('data-lazy'\);\n\s+rulesWire\(box\);\n\s+bindTabLinks\(box\);/);
  assert.match(grab('app.js', /function rulesWire\(root\) \{[\s\S]*?\n\}/), /if \(\$\('#program-cards', root\)\) renderProgramCards\(\);\n\s+bindPoints\(root\);/);
  // The chapter chips jump to headings, which are in the summaries, so they need no build.
  for (const id of ['r-alliances', 'r-programs', 'r-glossary']) assert.match(app, new RegExp(`rulesSection\\(\`<h2 class="section" id="${id}">`));
  assert.match(app, /return `<h2 class="section" id="am-chart">/);
  assert.match(app, /return `<h2 class="section" id="points-rules">/);
  assert.match(src('features.js'), /return `<h2 class="section" id="release-dates">/);
});
