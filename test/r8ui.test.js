// Round 8, 版面整理: the scripts that moved out of the page (P2), the linked tab shown from the first paint (P3) and
// the details summaries that no longer carry a page-wide top margin (L1).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const list = (src, name) => JSON.parse(src.match(new RegExp(`const ${name} = (\\[[^\\]]*\\])`))[1].replace(/'/g, '"'));
const LAZY = ['nlsearch', 'flightstatus', 'anywhere', 'dealrules', 'aihelper', 'line', 'cashverdict'];

test('P2: the owner tools and rarely used scripts are not in the page; the page uses them behind typeof', () => {
  const html = read('index.html');
  for (const f of LAZY) assert.doesNotMatch(html, new RegExp(`<script src="/${f}\\.js`), f);
  const own = (f) => [...read(`${f}.js`).matchAll(/^(?:async\s+)?(?:function\s+([\w$]+)|(?:const|let)\s+([\w$]+))/gm)].map((m) => m[1] || m[2]);
  const eager = [...html.matchAll(/<script src="\/([\w-]+)\.js/g)].map((m) => m[1]);
  const esc = (n) => n.replace(/\$/g, '\\$');
  for (const lazy of LAZY) {
    const names = own(lazy);
    // Each line that uses one of the script's names checks one of them with typeof first (nl.on && nlOwnerHere()).
    const guard = new RegExp(`typeof (?:${names.map(esc).join('|')}) `);
    for (const name of names) {
      const re = new RegExp(`\\b${esc(name)}\\b`);
      for (const f of eager) {
        const src = read(`${f}.js`);
        if (new RegExp(`(?:const|let|var|function)\\s+${esc(name)}\\b`).test(src)) continue; // its own local of that name
        for (const line of src.split('\n')) {
          // Only inside strings (the /api/nl/… paths) or comments: nothing to guard.
          const code = line.replace(/\/\*.*?\*\/|\/\/.*$/g, '').replace(/`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\])*'/g, '""');
          if (re.test(code)) assert.match(line, guard, `${f}.js uses ${lazy}.js's ${name} without a typeof check: ${line.trim()}`);
        }
      }
    }
  }
});

test('P2: each lazy script is fetched where it is needed, after the scripts it builds on', () => {
  const app = read('app.js');
  const search = list(app, 'SEARCH_SCRIPTS');
  assert.ok(search.includes('aihelper') && search.indexOf('aihelper') < search.indexOf('cxmuse'), 'cxmuse.js copies with aiCopy');
  assert.ok(search.includes('nlsearch') && search.indexOf('nlsearch') < search.indexOf('cxshot'), 'cxshot.js reads nl.on');
  assert.deepEqual(list(app, 'OWNER_SCRIPTS'), ['anywhere', 'dealrules', 'nlsearch']);
  assert.match(read('account.js'), /if \(ownerHere\(\) && typeof loadOwnerScripts === 'function'\) loadOwnerScripts\(\);/);
  assert.match(app, /const aiP = loadScripts\(\['aihelper'\]\);/, '航班明細 opened outside the route results');
  assert.match(app, /tabInit\.cash = \(\) => \{\n  loadCashQuota\(\);\n  loadScripts\(\['cashverdict'\]\)/);
  assert.match(read('features.js'), /else if \(\$\('#plan-panel'\)\?\.open && \$\('\.plan-table tr', body\)\) loadScripts\(\['flightstatus'\]\);/);
  for (const f of ['account.js', 'notify.js']) assert.match(read(f), /loadScripts\(\['line'\]\)\.then\(\(\) => \{ if \(typeof lineRender === 'function'\) lineRender\(/, f);
  // dealrules.js reads notify.js's notifyCfg, so notify.js stays in the page.
  assert.match(read('index.html'), /<script src="\/notify\.js/);
  // nlsearch.js sets itself up from /api/config whenever it arrives; init hands it over, or {} when init failed.
  assert.match(read('nlsearch.js'), /\nif \(typeof configP === 'object'\) configP\.then\(nlInit\);\n$/);
  assert.match(app, /configDone\(config\);/);
  assert.match(app, /\}\)\(\)\.catch\(\(err\) => \{\n  configDone\(\{\}\);/);
  assert.doesNotMatch(app, /nlInit\(config\)/);
});

test('P3: a linked tab is the one shown from the first paint', () => {
  const html = read('index.html');
  const m = html.match(/<\/main>\n(?:\s*<!--[^\n]*-->\n)?\s*<script>([^<]+)<\/script>/);
  assert.ok(m, 'an inline script right after </main>');
  const ids = [...html.matchAll(/<section id="(tab-[\w-]+)" class="panel"/g)].map((x) => x[1]);
  const run = (hash) => {
    const panels = ids.map((id) => ({ id, hidden: id !== 'tab-search', classList: { contains: (c) => c === 'panel' } }));
    const document = { getElementById: (id) => panels.find((p) => p.id === id) || null, querySelectorAll: () => panels };
    vm.runInNewContext(m[1], { document, location: { hash } });
    return panels.filter((p) => !p.hidden).map((p) => p.id);
  };
  assert.deepEqual(run('#points'), ['tab-points']);
  assert.deepEqual(run('#points/award'), ['tab-points']);
  assert.deepEqual(run('#rules'), ['tab-rules']);
  assert.deepEqual(run(''), ['tab-search']);
  assert.deepEqual(run('#unsub=abc'), ['tab-search'], 'not a tab');
  assert.deepEqual(run('#nope'), ['tab-search']);
  // The tabs drawn from the second data part keep the footer below the fold until they are drawn.
  assert.match(read('styles.css'), /#tab-points, #tab-rules, #tab-map, #tab-rtw \{ min-height: calc\(100vh - var\(--hdr-h, 67px\)\); \}/);
});

test('L1: no page-wide top margin on details summaries', () => {
  const css = read('styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = css.match(/(^|\})\s*details summary\s*\{([^}]*)\}/);
  assert.ok(rule, 'the details summary rule');
  assert.doesNotMatch(rule[2], /margin/);
});
