// Round 6, 介面與速度: the Back gesture's history bookkeeping (U2), the date picker's keys (U16), one program name per
// program (U6), the quota wording (U7), Leaflet served from the site (U14) and the scripts loaded when first needed (U15).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createBackNav } = require('../public/backnav');

const pub = (f) => path.join(__dirname, '..', 'public', f);
const read = (f) => fs.readFileSync(pub(f), 'utf8');
function grab(src, re) {
  const m = src.match(re);
  assert.ok(m, String(re));
  return m[0];
}

// A stand-in for window.history: entries, the current index, and the traversals asked for.
function fakeHistory(url = '/#search') {
  const h = {
    list: [{ state: null, url }], i: 0, gone: [],
    get state() { return h.list[h.i].state; },
    get url() { return h.list[h.i].url; },
    pushState(state, _, u) { h.list.splice(h.i + 1, Infinity, { state, url: u }); h.i++; },
    replaceState(state, _, u) { h.list[h.i] = { state, url: u }; },
    go(n) { h.gone.push(n); h.i += n; },
  };
  return h;
}
const dialog = () => ({ open: true, close() { this.open = false; } });
function setup(opts = {}) {
  const hist = fakeHistory();
  const later = [];
  const calls = { tab: 0, resync: 0 };
  const nav = createBackNav({ hist, defer: (f) => later.push(f), onTab: () => calls.tab++, onResync: () => calls.resync++, ...opts });
  const flush = () => { while (later.length) later.shift()(); };
  return { hist, nav, calls, flush };
}

test('U2: a tab switch adds an entry; before any interaction it only replaces', () => {
  const { hist, nav } = setup();
  nav.tab('/#cash');
  nav.tab('/#rules');
  assert.deepEqual(hist.list.map((e) => e.url), ['/#search', '/#cash', '/#rules']);
  const quiet = setup({ canPush: () => false });
  quiet.nav.tab('/#cash');
  assert.deepEqual(quiet.hist.list.map((e) => e.url), ['/#cash']);
});

test('U2: Back with a dialog open closes the dialog and shows no other tab', () => {
  const { hist, nav, calls } = setup();
  const d = dialog();
  nav.opened(d, '/?o=TPE#search');
  assert.equal(hist.list.length, 2);
  assert.equal(hist.state.r6dlg, 1);
  hist.i--; // the browser goes back, then fires popstate
  nav.pop();
  assert.equal(d.open, false);
  assert.deepEqual(calls, { tab: 0, resync: 1 });
  nav.closed(d); // the open-attribute watcher, later: nothing more to do
  assert.equal(nav.depth, 0);
  // With nothing open, Back is a tab change.
  nav.pop();
  assert.equal(calls.tab, 1);
});

test('U2: closing a dialog with ✕ or Esc gives its entry back, and that pop is ignored', () => {
  const { hist, nav, calls, flush } = setup();
  const d = dialog();
  nav.opened(d, '/#search');
  d.close();
  nav.closed(d);
  flush();
  assert.deepEqual(hist.gone, [-1]);
  assert.equal(hist.i, 0);
  nav.pop(); // the popstate of that go(-1)
  assert.deepEqual(calls, { tab: 0, resync: 1 });
});

test('U2: a dialog that closes and switches tab in one go leaves one entry, not two', () => {
  const { hist, nav, flush } = setup();
  const d = dialog();
  nav.opened(d, '/#search');
  d.close(); // 「完整規定」: dlg.close() then showTab('rules'), before the watcher runs
  nav.tab('/#rules');
  nav.closed(d);
  flush();
  assert.deepEqual(hist.list.map((e) => e.url), ['/#search', '/#rules']);
  assert.deepEqual(hist.gone, [], 'no traversal');
});

test('U2: nested dialogs close one per Back; one under a newer entry is left alone', () => {
  const { hist, nav, flush } = setup();
  const a = dialog();
  const b = dialog();
  nav.opened(a, '/#search');
  nav.opened(b, '/#search');
  hist.i--;
  nav.pop();
  assert.equal(b.open, false);
  assert.equal(a.open, true);
  hist.i--;
  nav.pop();
  assert.equal(a.open, false);
  // A dialog closed while a newer entry sits on top of its own: no go(), the entry stays as a copy of the page.
  const c = dialog();
  nav.opened(c, '/#search');
  nav.tab('/#cash');
  c.close();
  nav.closed(c);
  flush();
  assert.deepEqual(hist.gone, []);
  // The same dialog reported twice opens one entry.
  const d = dialog();
  nav.opened(d, '/#cash');
  nav.opened(d, '/#cash');
  assert.equal(nav.depth, 1);
});

test('U2: showTab pushes only for a tab change, and URL-driven changes never push', () => {
  const app = read('app.js');
  assert.match(app, /if \(moved && push && typeof backNav === 'object'\) backNav\.tab\(tabUrl\(tab\)\);\s*else history\.replaceState\(history\.state/);
  assert.match(app, /showTab\(TABS\.includes\(h\.split\('\/'\)\[0\]\) \? h : 'search', \{ push: false \}\)/, 'opening the page');
  assert.equal((grab(app, /function navFromUrl\(\) \{[\s\S]*?\n\}/).match(/push: false/g) || []).length, 2, 'Back/Forward and hashchange');
  assert.match(app, /function setTabUrl[\s\S]*?history\.replaceState\(history\.state, '', tabUrl\(tab\)\)/, 'query updates keep replacing');
  const html = read('index.html');
  assert.ok(html.indexOf('/backnav.js') < html.indexOf('/app.js'), 'backnav.js before app.js');
});

test('U16: date picker keys move by day, week, month and to the week ends, inside the range', () => {
  const app = read('app.js');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext([
    grab(app, /function isoDateFrom\(iso, offsetDays\) \{[\s\S]*?\n\}/), grab(app, /const clampIso = .*;/), grab(app, /const monthAdd = .*;/),
    grab(app, /function dpKeyDate\(iso, key, lo, hi\) \{[\s\S]*?\n\}/), 'this.k = dpKeyDate;',
  ].join('\n'), ctx);
  const k = (iso, key, lo = '2026-01-01', hi = '2027-12-31') => ctx.k(iso, key, lo, hi);
  assert.equal(k('2026-10-31', 'ArrowRight'), '2026-11-01');
  assert.equal(k('2026-11-01', 'ArrowLeft'), '2026-10-31');
  assert.equal(k('2026-10-14', 'ArrowDown'), '2026-10-21');
  assert.equal(k('2026-10-14', 'ArrowUp'), '2026-10-07');
  assert.equal(k('2026-01-31', 'PageDown'), '2026-02-28', 'to the shorter month\'s last day');
  assert.equal(k('2026-03-31', 'PageUp'), '2026-02-28');
  assert.equal(k('2026-12-15', 'PageDown'), '2027-01-15');
  assert.equal(k('2026-10-14', 'Home'), '2026-10-11', 'Wednesday → Sunday');
  assert.equal(k('2026-10-14', 'End'), '2026-10-17', 'Wednesday → Saturday');
  assert.equal(k('2026-10-16', 'ArrowLeft', '2026-10-16'), '2026-10-16', 'not before today');
  assert.equal(k('2027-10-10', 'PageDown', '2026-10-16', '2027-10-16'), '2027-10-16', 'not past a year');
  assert.equal(k('2026-10-14', 'Enter'), null);
  assert.equal(k('2026-10-14', 'a'), null);
  // One day in the tab order (roving tabindex), and the keys are wired to the dialog.
  assert.match(app, /for \(const b of \$\$\('\.dp-day', dlg\)\) b\.tabIndex = b === tab \? 0 : -1;/);
  assert.match(app, /const to = dpKeyDate\(day\.dataset\.date, e\.key, lo\(\), hi\(\)\);/);
});

test('U6: map, 哩程試算 and 中停／開口組合 name programs as data/source-names.json does; chart wording is the variant', () => {
  const features = read('features.js');
  const names = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'source-names.json'), 'utf8')).names;
  const ctx = { SOURCE_NAMES: names };
  vm.createContext(ctx);
  vm.runInContext([
    grab(features, /const EXTRA_PROGRAM_NAMES = .*;/), grab(features, /const CHART_VARIANT = .*;/),
    grab(features, /const PROGRAM_KEY = .*;/), grab(features, /const programKeyOf = .*;/),
    grab(features, /function chartProgram\(id, full = '', alt = ''\) \{[\s\S]*?\n\}/), 'this.cp = (...a) => ({ ...chartProgram(...a) });',
  ].join('\n'), ctx);
  const cp = ctx.cp;
  assert.deepEqual(cp('american', '美國航空 AAdvantage'), { name: '美航 AAdvantage', variant: '' });
  assert.deepEqual(cp('alaska', '阿拉斯加 Atmos Rewards'), { name: '阿拉斯加 Atmos', variant: '' });
  assert.deepEqual(cp('turkish', '土耳其航空 Miles&Smiles 星盟夥伴'), { name: '土航 Miles&Smiles', variant: '星盟夥伴' });
  assert.deepEqual(cp('singapore', '新加坡航空 KrisFlyer（星盟夥伴 Saver）'), { name: '新航 KrisFlyer', variant: '星盟夥伴 Saver' });
  assert.deepEqual(cp('ana', '全日空 ANA 星盟夥伴'), { name: '全日空 ANA', variant: '星盟夥伴' });
  assert.deepEqual(cp('dynastyflyer', '華航 華夏哩程（天合聯盟夥伴）', 'ci'), { name: '華航 華夏哩程', variant: '天合聯盟夥伴' });
  assert.deepEqual(cp('jal_partner', '日航 寰宇一家獎勵機票'), { name: '日航 JMB', variant: '寰宇一家獎勵機票' }, 'paid with JAL miles');
  assert.deepEqual(cp('jal_partner', '日航 寰宇一家夥伴獎勵', 'jal_partner'), { name: '日航 JMB', variant: '寰宇一家夥伴獎勵' });
  assert.deepEqual(cp('korean', '大韓 SKYPASS'), { name: '大韓 SKYPASS', variant: '' }, 'no site name: the chart\'s own');
  // Every chart and routing program that seats.aero also lists comes out under its source-names.json name.
  const data = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', f), 'utf8'));
  for (const p of [...data('charts.json').programs, ...data('routing.json').programs]) {
    if (names[p.id]) assert.equal(cp(p.id, p.name, p.chart || '').name, names[p.id], p.id);
  }
  assert.match(read('index.html'), /一次比較加航、法荷航、阿拉斯加、聯合等計畫的獎勵位/);
  assert.match(read('etrips.js'), /const etName = \(r\) => chartProgram\(r\.id, r\.name, r\.chart\);/);
});

test('U7: availability is 獎勵位 and quota costs read 「（用 N 次查詢）」 or 「（用 N 次查價）」', () => {
  const files = fs.readdirSync(pub('')).filter((f) => /\.(js|html)$/.test(f));
  for (const f of files) {
    const src = read(f);
    assert.doesNotMatch(src, /獎勵座位|獎勵機位|獎勵機票座位/, f);
    for (const m of src.matchAll(/（用[^）]{0,30}）/g)) assert.match(m[0], /^（用約? \S+ 次(查詢|查價)）$/, `${f}: ${m[0]}`);
    assert.doesNotMatch(src, /會用掉 1 次查價|（用額度）|<small>用額度<\/small>/, f);
  }
});

test('U14: Leaflet 1.9.4 is served from the site, byte for byte the upstream release', () => {
  const sri = (f) => `sha256-${crypto.createHash('sha256').update(fs.readFileSync(pub(f))).digest('base64')}`;
  // The integrity hashes Leaflet publishes for 1.9.4 (leafletjs.com/download.html).
  assert.equal(sri('leaflet/leaflet.js'), 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=');
  assert.equal(sri('leaflet/leaflet.css'), 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=');
  assert.match(read('leaflet/leaflet.js'), /^\/\* @preserve\n \* Leaflet 1\.9\.4/);
  assert.match(read('leaflet/LICENSE.txt'), /BSD 2-Clause License/);
  const features = read('features.js');
  assert.doesNotMatch(features, /cdnjs\.cloudflare\.com\/ajax\/libs\/leaflet/);
  assert.match(features, /const LEAFLET_URL = '\/leaflet\/leaflet';/);
  assert.match(features, /box\.outerHTML = `\$\{mapFailHtml\(err\)\}\$\{rmapListHtml\(dests\)\}`/, '重試 and the city list');
});

test('U15: hotels, admin, etrips, ewallet and award-tools are not in the page; their users wait for them', () => {
  const html = read('index.html');
  for (const f of ['hotels', 'admin', 'etrips', 'ewallet', 'award-tools']) assert.doesNotMatch(html, new RegExp(`<script src="/${f}\\.js`), f);
  const app = read('app.js');
  const list = (name) => JSON.parse(grab(app, new RegExp(`const ${name} = (\\[[^\\]]*\\])`)).replace(/^[^[]*/, '').replace(/'/g, '"'));
  assert.deepEqual(list('TOOL_SCRIPTS'), ['rtw', 'award-tools', 'ewallet', 'airline', 'prog9']); // rtw.js first: toolsIn() then means it ran too
  const search = list('SEARCH_SCRIPTS');
  assert.ok(search.indexOf('etrips') >= 0 && search.indexOf('etrips') < search.indexOf('cxcal'), 'Google 航班快捷 card before 國泰哩程日曆');
  // Everything that draws with those scripts' functions waits for them.
  assert.match(app, /function renderPoints\(\) \{\n  const host = \$\('#points-page'\);\n  if \(!host \|\| !withTools\(host, renderPoints\)\) return;/);
  assert.match(app, /function renderRules\(\) \{\n  if \(!withTools\(\$\('#rules'\), renderRules\)\) return;/);
  assert.match(app, /api\(`\/api\/trips\/\$\{encodeURIComponent\(id\)\}`\), loadMore\(\), loadTools\(\)\]/, '航班明細');
  assert.match(app, /\[pre \|\| api\(`\/api\/search\?\$\{params\}`\), loadMore\(\), loadSearchScripts\(\)\]/, 'route results');
  assert.match(app, /loadScripts\(\['hotels', 'hotelwatch'\]\)\.then/);
  assert.match(read('account.js'), /if \(ownerHere\(\)\) loadAdmin\(\);/);
  // Only app.js and features.js use the tools' functions, and only on those paths; hotels.js and admin.js are used
  // by nothing else (admOpen behind a typeof check).
  const own = (f) => [...read(f).matchAll(/^(?:async\s+)?(?:function\s+([\w$]+)|(?:const|let)\s+([\w$]+))/gm)].map((m) => m[1] || m[2]);
  const eager = [...html.matchAll(/<script src="\/([\w-]+)\.js/g)].map((m) => m[1]).filter((f) => !['app', 'features'].includes(f));
  for (const lazy of ['hotels', 'admin', 'ewallet', 'award-tools', 'etrips', 'airline', 'airinfo', 'prog9']) {
    for (const name of own(`${lazy}.js`)) {
      for (const f of eager) {
        const src = read(`${f}.js`);
        if (!new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`).test(src)) continue;
        if (new RegExp(`(?:const|let|var|function)\\s+${name.replace(/\$/g, '\\$')}\\b`).test(src)) continue; // its own local of that name
        assert.ok(new RegExp(`typeof ${name} `).test(src), `${f}.js uses ${lazy}.js's ${name} without a typeof check`);
      }
    }
  }
  // The 中停／開口組合 pill is in the page from the start; etrips.js fills it in.
  assert.match(html, /<details class="alerts-panel" id="combo-panel">/);
});
