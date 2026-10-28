// Round 10 畫面小修: 環球票 pins that would cover each other, the tab lit on #rtw, 規則庫's nine chapter chips,
// 今日好康 when /api/deals fails, 我的點數's 「先選一種點數／請填數量」, 機位提醒「修改」 with the site's pickers,
// and the phone layouts (我的行程 cards, 更多分析 ▾, 查飯店 row, tap sizes).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
function grab(file, re) {
  const m = read(file).match(re);
  assert.ok(m, `${re} in ${file}`);
  return m[0];
}
const css = read('styles.css');
// The body of every @media block whose query matches `q` (one level of nesting, as styles.css writes them).
const mediaBodies = (q) => [...css.matchAll(/@media ([^{]+)\{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}/g)].filter((m) => q.test(m[1])).map((m) => m[2]).join('\n');

test('環球票 pins: a pin that would cover one already placed moves just below or above it; far pins stay', () => {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${grab('rtw.js', /function rtwPinShift\(pins, h = 28\) \{[\s\S]*?\n\}/)}\nthis.shift = rtwPinShift;`, ctx);
  // The JAL example at world zoom: TPE (1・6, placed first) and HKG (5) 4px lower and 9px to the left.
  const tpe = { x: 1135, y: 391, w: 79 };
  const hkg = { x: 1126, y: 395, w: 65 };
  const lhr = { x: 989, y: 350, w: 65 };
  assert.deepEqual([...ctx.shift([tpe, lhr, hkg])], [0, 0, 24], 'HKG goes under TPE');
  // Lying a little above, it goes up instead.
  assert.deepEqual([...ctx.shift([tpe, { ...hkg, y: 380 }])], [0, -17]);
  // Three on one spot stack; no two of them overlap afterwards.
  const dys = [...ctx.shift([tpe, { ...tpe }, { ...tpe }])];
  const ys = dys.map((d) => tpe.y + d);
  for (let i = 0; i < ys.length; i++) for (let j = i + 1; j < ys.length; j++) assert.ok(Math.abs(ys[i] - ys[j]) >= 28, `${ys}`);
  // Side by side but clear of each other: nothing moves.
  assert.deepEqual([...ctx.shift([tpe, { x: 1135 + 90, y: 391, w: 65 }])], [0, 0]);
  // Both maps that draw a route pass their map, so the pins are moved at each zoom.
  assert.match(read('rtw.js'), /rtwDrawRoute\(L, rtwLayer, pts, [^;]*, rtwMap\)/);
  assert.match(read('etrips.js'), /rtwDrawRoute\(L, L\.layerGroup\(\)\.addTo\(comboMap\), [^;]*, comboMap\)/);
});

test('環球票規劃 (#rtw) keeps 航線查詢 lit in the tab strip', () => {
  const buttons = ['search', 'explore', 'map', 'cash', 'hotels', 'points', 'rules'].map((tab) => ({ dataset: { tab }, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } }));
  const panels = ['search', 'rtw'].map((t) => ({ id: `tab-${t}`, hidden: false }));
  const ctx = {
    $$: (sel) => (sel === '.tabs button' ? buttons : sel === '.panel' ? panels : []), $: () => null,
    tabSub: {}, currentTab: 'search', history: { state: null, replaceState() {} }, tabUrl: (t) => `#${t}`, ensureTab() {}, tabShown: {},
  };
  vm.createContext(ctx);
  vm.runInContext(`${grab('app.js', /const TAB_OF = .*;/)}\nvar currentTab = 'search';\n${grab('app.js', /function showTab\(name, \{ push = true \} = \{\}\) \{[\s\S]*?\n\}/)}\nthis.showTab = showTab;`, ctx);
  ctx.showTab('rtw', { push: false });
  assert.deepEqual(buttons.filter((b) => b.attrs['aria-selected'] === 'true').map((b) => b.dataset.tab), ['search']);
  assert.equal(buttons[0].tabIndex, 0);
  assert.equal(panels.find((p) => p.id === 'tab-rtw').hidden, false);
  ctx.showTab('rules', { push: false });
  assert.deepEqual(buttons.filter((b) => b.attrs['aria-selected'] === 'true').map((b) => b.dataset.tab), ['rules']);
});

test('規則庫: a chip for each of the nine chapters, in page order, each pointing at a section that is drawn', () => {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${grab('app.js', /const RULES_CHAPTERS = [\s\S]*?\]\];/)}\nthis.C = RULES_CHAPTERS;`, ctx);
  const ids = ctx.C.map(([id]) => id);
  assert.deepEqual(ids, ['r-alliances', 'am-chart', 'r-programs', 'release-dates', 'points-rules', 'r-cardperks', 'r-recent', 'r-tools', 'r-glossary']);
  assert.deepEqual(ctx.C.slice(5).map(([, t]) => t), ['信用卡權益', '最近變動', '外部工具', '名詞解釋']);
  for (const [, , short] of ctx.C) assert.ok(short.length <= 3, short);
  const all = ['app.js', 'trips.js', 'prog9.js', 'features.js'].map(read).join('\n');
  for (const id of ids) assert.match(all, new RegExp(`id="${id}"|id: '${id}'|'${id}'`), id);
  // A chip whose section is not on the page (its data or script missing) hides instead of doing nothing.
  assert.match(read('app.js'), /\$\$\('\.rules-nav \[data-jump\]'\)\.forEach\(\(b\) => \(b\.hidden = !document\.getElementById\(b\.dataset\.jump\)\)\)/);
  assert.match(mediaBodies(/max-width: 640px/), /\.rules-nav \{ display: grid; grid-template-columns: repeat\(5, /);
});

test('今日好康: a failed load says so with 重試, and 重試 loads again', async () => {
  const listeners = {};
  const retry = { disabled: false, textContent: '重試', addEventListener: (ev, fn) => { listeners[ev] = fn; } };
  const host = { innerHTML: 'x', busy: true, removeAttribute(k) { if (k === 'aria-busy') this.busy = false; } };
  let calls = 0;
  let drawn = 0;
  const ctx = {
    $: (sel) => (sel === '#deals' ? host : sel === '#deals-retry' ? retry : null),
    store: { get: (k, f) => f }, encodeURIComponent, Date, AP: { loaded: true }, onAirports() {},
    api: async () => { calls++; if (calls === 1) throw new Error('伺服器回應太慢，請按重試。'); return { groups: [] }; },
    renderDeals: () => { drawn++; host.innerHTML = 'deals'; }, dealsState: {},
  };
  vm.createContext(ctx);
  vm.runInContext(`${grab('features.js', /async function loadDeals\(\) \{[\s\S]*?\n\}/)}\nthis.loadDeals = loadDeals;`, ctx);
  await ctx.loadDeals();
  assert.match(host.innerHTML, /今日好康暫時載入失敗，稍後再試。<button type="button" class="linkish" id="deals-retry">重試<\/button>/);
  assert.equal(host.busy, false, 'the reserved height goes');
  listeners.click({ currentTarget: retry });
  assert.equal(retry.disabled, true);
  assert.equal(retry.textContent, '載入中…');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls, 2);
  assert.equal(drawn, 1);
});

test('我的點數: 加入 with no type or no amount says which, under the row, on that field', () => {
  // A small stand-in for the row: <div class="w-add"><select><input><button></div>, then what comes after it.
  const mk = (tag) => ({ tag, attrs: {}, on: {}, focused: false, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; },
    hasAttribute(k) { return k in this.attrs; }, addEventListener(ev, fn) { this.on[ev] = fn; }, focus() { this.focused = true; } });
  const pick = mk('select');
  const amt = mk('input');
  const after = [];
  const row = {
    get nextElementSibling() { return after[0] || null; },
    insertAdjacentHTML(where, html) { const p = { html, textContent: '', matches: (s) => s === '.w-add-err' && /w-add-err/.test(html), remove() { after.splice(after.indexOf(p), 1); } }; after.unshift(p); },
  };
  pick.closest = amt.closest = () => row;
  const ctx = { $$: () => [pick, amt].filter((x) => x.hasAttribute('aria-invalid')) };
  vm.createContext(ctx);
  vm.runInContext(`${grab('features.js', /const W_ADD_MISSING = .*;/)}\n${grab('features.js', /function walletAddHint\(el, msg\) \{[\s\S]*?\n\}/)}\nthis.hint = walletAddHint; this.M = W_ADD_MISSING;`, ctx);
  ctx.hint(pick, ctx.M.pick);
  assert.equal(after.length, 1);
  assert.match(after[0].html, /class="field-err w-add-err" role="alert"/);
  assert.equal(after[0].textContent, '先選一種點數');
  assert.equal(pick.attrs['aria-invalid'], 'true');
  assert.ok(pick.focused);
  // Then the amount: the same line now names it, and only the amount is marked.
  ctx.hint(amt, ctx.M.amt);
  assert.equal(after.length, 1);
  assert.equal(after[0].textContent, '請填數量');
  assert.ok(!('aria-invalid' in pick.attrs));
  assert.equal(amt.attrs['aria-invalid'], 'true');
  amt.on.input();
  assert.equal(after.length, 0, 'typing an amount clears it');
  assert.ok(!('aria-invalid' in amt.attrs));
  // Both 加入 buttons use it: the wallet's own and each family member's (points6.js).
  assert.match(read('features.js'), /if \(!ref\) return walletAddHint\(\$\('#w-pick', host\), W_ADD_MISSING\.pick\);\n\s+if \(!cleanCount\(amt\.value\)\) return walletAddHint\(amt, W_ADD_MISSING\.amt\);/);
  assert.match(read('points6.js'), /if \(!pick\.value\) return walletAddHint\(pick, W_ADD_MISSING\.pick\);[^\n]*\n\s+if \(!cleanCount\(amt\.value\)\) return walletAddHint\(amt, W_ADD_MISSING\.amt\);/);
});

test('機位提醒「修改」: the search form\'s airport chips and date picker, the same values sent as before', () => {
  const app = read('app.js');
  const ctx = {
    esc: (s) => String(s ?? '').replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`), PAX_OPTIONS: [['', '不限'], ['2', '至少 2 位']],
    alertCabinChipsHtml: () => '<cabins>', alertCabins: () => ['J'], alertFiltersHtml: () => '<filters>', URLSearchParams,
  };
  vm.createContext(ctx);
  vm.runInContext(`${grab('app.js', /function alertEditHtml\(a\) \{[\s\S]*?\n\}/)}\nthis.html = alertEditHtml;`, ctx);
  const html = ctx.html({ id: 'a1', origin: 'TPE', destination: 'NRT,HND', start: '2026-12-01', end: '2026-12-10', pax: 2 });
  assert.doesNotMatch(html, /type="date"/);
  assert.match(html, /<div class="chips-box" data-for="origin">[\s\S]*?<input type="hidden" name="origin" value="TPE">/);
  assert.match(html, /<div class="chips-box" data-for="destination">[\s\S]*?<input type="hidden" name="destination" value="NRT,HND">/);
  assert.match(html, /<div class="field dp-field"><span>出發日期<\/span><button type="button" class="dp-btn"[^>]*><\/button><input type="hidden" name="start"><input type="hidden" name="end"><\/div>/);
  assert.match(html, /<option value="2" selected>/);
  // The pickers are made when the row opens; the date picker's dialog goes when it closes (and on each reload).
  assert.match(app, /alertEd = \{ origin: createAirportPicker\(f, 'origin'\), destination: createAirportPicker\(f, 'destination'\), dates: createDatePicker\(f, '出發日期'\) \};/);
  assert.match(app, /drop: \(\) => dlg\.remove\(\),/);
  assert.match(grab('app.js', /function alertEditClose\(box\) \{[\s\S]*?\n\}/), /alertEd\?\.dates\.drop\(\);/);
  // Saving: typed text is checked like the search form, then the same PUT as before.
  assert.match(app, /const problem = await checkAirports\(f, \[alertEd\.origin, alertEd\.destination\]\);\n\s+if \(problem\) return formError\(\$\('\.status', f\), problem\);/);
  // Its 「＋ 加入機場」 box sits on the chips' line as in the search form, not as a second input under them.
  assert.match(css, /\.alert-edit input\.chips-q, \.alert-edit input\.chips-q:focus \{ flex: 1 1 90px; width: 0; min-width: 72px; border: 0; background: transparent;/);
  assert.match(app, /body: JSON\.stringify\(\{ origin: codes\(f\.origin\.value\), destination: codes\(f\.destination\.value\), start: f\.start\.value, end: f\.end\.value, pax: f\.pax\.value, \.\.\.alertFilterValues\(f\) \}\)/);
});

test('phone layouts: 我的行程 cards, 更多分析 ▾ on its line, 查飯店 row top-aligned, 32px taps', () => {
  const phone = mediaBodies(/^\(max-width: 600px\)\s*$/);
  assert.match(phone, /\.plan-table, \.plan-table tbody, \.plan-table tr \{ display: block; \}/);
  assert.match(phone, /grid-template-areas: "date date rm" "route route route" "cabin fare fare"/);
  assert.match(phone, /\.more-fold > summary \.section-title small \{ order: 1; flex-basis: 100%; \}/);
  assert.match(phone, /\.w-del \{ min-width: 32px; min-height: 32px; \}/);
  assert.match(phone, /\.plan-table \.tp-air > summary \{ padding: 6px 0; \}/);
  assert.match(phone, /\.plan-table button\.tp-pill \{ border-width: 7px 0; border-color: transparent; background-clip: padding-box !important;/);
  assert.match(mediaBodies(/max-width: 600px\) and \(pointer: fine\)/), /\.linkish \{ padding-top: 6px; padding-bottom: 6px; margin-top: -6px; margin-bottom: -6px; \}/);
  // The card layout stays off wider screens: no plan-table rule outside a phone @media turns rows into blocks.
  const outside = css.replace(/@media ([^{]+)\{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}/g, '');
  for (const [, sel, body] of outside.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!/display: (block|grid)/.test(body)) continue;
    for (const one of sel.split(',')) assert.doesNotMatch(one.trim(), /^\.plan-table( (tbody|tr|td)(:[^ ]*)?)?$/, sel);
  }
  assert.match(outside, /\.h-row \{ align-items: flex-start; \}/);
});
