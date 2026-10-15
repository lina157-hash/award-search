#!/usr/bin/env node
// 國泰獎勵機位定時查詢腳本（在站長自己的電腦上執行）
//
// 用 Playwright 開一個「有記憶的」Chromium（profile/ 資料夾），第一次請站長自己在視窗裡登入國泰；腳本從不碰密碼、
// 不讀 cookie。之後依網站上的「國泰定時查詢清單」，用國泰首頁的預訂行程小工具搜尋航線（只用畫面上的文字找欄位，找不到就
// 請站長手動搜尋），在「選擇航班」頁沿著 7 天的日期列往後翻，記下每天各艙等的最低里數／不適用，合併到 data/<FROM>-<TO>.json，
// 再上傳到機票搜索雷達（/api/cxcal，用網站的通關密碼，不是國泰密碼）。
//
// 讀頁面的程式（parseCathayText、cxHints、cxRoot、cxDiag）來自 public/cxcal.js（node build.js 會複製到 cxcal-page.js），
// 書籤小工具和這支腳本讀的是同一套規則。
//
// 用法：node run.js            依清單查一輪（給工作排程器用）
//       node run.js --watch    一直開著：每 60 秒看網站有沒有「現在就查」的要求，每天 dailyAt 查一輪
//       node run.js --route TPE-NRT   只查這一條（第一次測試用）
//       node run.js --config 另一個設定檔.json
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const PAGE_FNS = require('./cxcal-page.js');

const DIR = __dirname;
const ARGS = process.argv.slice(2);
const flag = (n) => ARGS.includes(n);
const opt = (n) => { const i = ARGS.indexOf(n); return i >= 0 ? ARGS[i + 1] : ''; };
const CABIN_NAME = { Y: '經濟', W: '豪華經濟', J: '商務', F: '頭等' };
const TILE = { Y: /^經濟(客)?艙$|^economy( class)?$/i, W: /^(特選|豪華|高級)經濟(客)?艙$|^premium economy( class)?$/i, J: /^商務(客)?艙$|^business( class)?$/i, F: /^頭等(客)?艙$|^first( class)?$/i };
const DEFAULTS = {
  site: 'https://award-search-zeta.vercel.app', passcode: '', routes: [], cabins: ['Y', 'J'], pax: 1, daysAhead: 60, maxRoutes: 3, startDate: '',
  searchUrl: '', headless: false, detailDays: false, dailyAt: '07:30', pollSeconds: 60, pace: [3, 7], browserChannel: '',
  homeUrl: 'https://www.cathaypacific.com/cx/zh_TW.html', resultsUrl: 'https://book.cathaypacific.com/CathayPacificAwardV3/dyn/air/booking/availability',
  redeemUrls: ['https://www.cathaypacific.com/cx/zh_TW/book-a-trip/redeem-flights/redeem-flight-awards.html', 'https://www.cathaypacific.com/cx/zh_HK/book-a-trip/redeem-flights/redeem-flight-awards.html'],
};

if (flag('--help') || flag('-h')) {
  console.log('node run.js [--watch] [--route TPE-NRT] [--config 設定檔.json]\n請看 README.md');
  process.exit(0);
}

// ---------- config, log ----------
const cfgPath = path.resolve(DIR, opt('--config') || 'config.json');
if (!fs.existsSync(cfgPath)) {
  console.error(`找不到設定檔 ${cfgPath}：請把 config.example.json 複製成 config.json 再改內容。`);
  process.exit(2);
}
let cfg;
try { cfg = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(cfgPath, 'utf8')) }; } catch (e) { console.error(`設定檔讀不出來：${e.message}`); process.exit(2); }
cfg.site = String(cfg.site || '').replace(/\/$/, '');
// The site's passcode may also come from the environment (CXRUNNER_PASSCODE), e.g. from a scheduler that keeps secrets.
if (process.env.CXRUNNER_PASSCODE) cfg.passcode = process.env.CXRUNNER_PASSCODE;
cfg.pace = Array.isArray(cfg.pace) && cfg.pace.length === 2 ? cfg.pace.map(Number) : [3, 7];
for (const k of ['password', 'cathayPassword', 'cxPassword', 'cathayPasscode']) if (cfg[k]) { console.error(`設定檔裡不可以放國泰密碼（${k}）：腳本從不處理密碼，請刪掉它。`); process.exit(2); }
const DATA_DIR = path.join(DIR, 'data');
const DEBUG_DIR = path.join(DIR, 'runner-debug');
const LOG = path.join(DIR, 'runner.log');
fs.mkdirSync(DATA_DIR, { recursive: true });
const stamp = () => new Date().toLocaleString('zh-TW', { hour12: false });
function log(msg) {
  const line = `[${stamp()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch { /* read-only folder: the console still has it */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
// Human pace: a random pause between actions (3–7 s by default; the README says not to lower it).
const pause = (min = cfg.pace[0], max = cfg.pace[1]) => sleep(rand(min, max) * 1000);
const isoDay = (d) => new Date(d).toISOString().slice(0, 10);
const addDays = (iso, n) => isoDay(Date.parse(iso + 'T00:00:00Z') + n * 864e5);
const todayLocal = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const fmt = (n) => Number(n).toLocaleString('en-US');

// ---------- asking the person at the keyboard (login, CAPTCHA, manual search) ----------
let rl = null;
let stdinClosed = false;
function ask(prompt) {
  if (stdinClosed || !process.stdin.readable) return Promise.resolve(null);
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on('close', () => { stdinClosed = true; });
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    rl.once('close', () => finish(null));
    rl.question(`\n>>> ${prompt}\n`, (a) => finish(a));
  });
}

// ---------- the site (機票搜索雷達) ----------
async function site(pathname, body) {
  const res = await fetch(cfg.site + pathname, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-requested-with': 'fetch', ...(cfg.passcode ? { 'x-cash-pass': cfg.passcode } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}
let hbState = { lastRun: '', summary: '' };
async function heartbeat(status, route) {
  if (!cfg.site) return;
  try { await site('/api/cxcal/heartbeat', { status, route: route || '', ...(hbState.lastRun ? { lastRun: hbState.lastRun } : {}), ...(hbState.summary ? { summary: hbState.summary } : {}) }); } catch (e) { log(`（心跳沒送到網站：${e.message}）`); }
}

// ---------- the browser ----------
let context = null;
async function openBrowser() {
  if (context) return context;
  let chromium;
  try { ({ chromium } = require('playwright')); } catch { log('找不到 playwright：請在這個資料夾執行 npm install，然後 npx playwright install chromium'); process.exit(2); }
  const profile = path.join(DIR, 'profile');
  const o = { headless: cfg.headless === true, viewport: { width: 1280, height: 900 }, locale: 'zh-TW', timezoneId: 'Asia/Taipei', args: ['--disable-blink-features=AutomationControlled'] };
  if (cfg.browserChannel) o.channel = cfg.browserChannel;
  if (cfg.executablePath) o.executablePath = cfg.executablePath;
  context = await chromium.launchPersistentContext(profile, o);
  context.setDefaultTimeout(8000);
  return context;
}
async function closeBrowser() {
  if (!context) return;
  await context.close().catch(() => {});
  context = null;
}
async function newPage() {
  const ctx = await openBrowser();
  const page = ctx.pages()[0] || (await ctx.newPage());
  // 「你將要離開此頁面」 style beforeunload prompts: leave.
  page.removeAllListeners('dialog');
  page.on('dialog', (d) => d.accept().catch(() => {}));
  return page;
}

// Wait until the page has no visible spinner / aria-busy region (the results list reloads after every click).
async function waitIdle(page, maxMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const busy = await page.evaluate(() => [...document.querySelectorAll('[aria-busy="true"],[class*="spinner" i],[class*="loading" i],[class*="skeleton" i]')].some((e) => e.getClientRects().length)).catch(() => false);
    if (!busy) return true;
    await sleep(400);
  }
  return false;
}

// Everything the page shows, read by the same code as the bookmarklet (no Cathay class names anywhere).
async function readPage(page) {
  return page.evaluate(`(() => { ${PAGE_FNS}
    const hints = cxHints();
    const text = document.body ? document.body.innerText : '';
    const r = parseCathayText(text, hints);
    const pw = [...document.querySelectorAll('input')].some((e) => e.type === 'password' && e.getClientRects().length);
    return { r, hints, url: location.href, title: document.title, len: text.length, text: text.slice(0, 4000), pw };
  })()`).catch((e) => ({ r: { strip: [], flights: [], tiles: [], low: {}, issues: ['evalfail'] }, hints: {}, url: page.url(), title: '', len: 0, text: '', pw: false, err: e.message }));
}

// Signs that Cathay wants a person: a visible password field or a login URL, a CAPTCHA, a block page, an empty page.
function blockedKind(info) {
  const t = `${info.title}\n${info.text}`.toLowerCase();
  if (info.pw || /\/(login|signin|sign-in|auth)\b/i.test(info.url)) return 'login';
  if (/captcha|驗證碼|verify (that )?you are (a )?human|請證明你不是機器人|press and hold|按住/.test(t)) return 'captcha';
  if (/access denied|拒絕存取|forbidden|request blocked|unusual traffic|暫時無法提供服務|error 403|403 forbidden/.test(t)) return 'denied';
  if (info.len < 80) return 'empty';
  return '';
}
const KIND_TEXT = { login: '國泰要求登入', captcha: '國泰顯示驗證（CAPTCHA）', denied: '國泰拒絕存取（可能已被擋）', empty: '頁面是空的' };

class Stop extends Error { constructor(msg, code) { super(msg); this.exitCode = code; } }

// Login / CAPTCHA: ask the person once, at the keyboard; a block page stops the run (no retries, ever).
async function ensureNotBlocked(page, mode) {
  let info = await readPage(page);
  let kind = blockedKind(info);
  if (kind === 'empty') { await sleep(5000); info = await readPage(page); kind = blockedKind(info); }
  if (!kind) return info;
  if (kind === 'denied' || kind === 'empty') {
    await saveDebug(page, kind);
    throw new Stop(`${KIND_TEXT[kind]}（${info.url}），這次先停下來，不再重試。請過幾個小時再看，或自己開瀏覽器看看國泰頁面。`, 3);
  }
  if (cfg.headless === true) throw new Stop(`${KIND_TEXT[kind]}，但設定是 headless（看不到視窗）。請把 config.json 的 headless 改成 false 再執行一次，登入後就會記住。`, 3);
  log(`${KIND_TEXT[kind]}。`);
  await heartbeat('login', mode && mode.route);
  const a = await ask(kind === 'login' ? '請在開啟的瀏覽器登入國泰，登入完成後回到這裡按 Enter' : '請在開啟的瀏覽器完成驗證，完成後回到這裡按 Enter');
  if (a == null) throw new Stop('沒有人在鍵盤前（stdin 已關閉），無法完成登入，這次先停下來。', 3);
  await pause(1, 2);
  info = await readPage(page);
  kind = blockedKind(info);
  if (kind) throw new Stop(`按了 Enter 之後${KIND_TEXT[kind]}，這次先停下來。`, 3);
  return info;
}

// Local-only debugging aids: a screenshot and a sanitized outline (same cxDiag as the bookmarklet's 診斷資料).
async function saveDebug(page, tag, scope) {
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const base = path.join(DEBUG_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}-${tag}`);
    await page.screenshot({ path: base + '.png', fullPage: false }).catch(() => {});
    const diag = await page.evaluate(`((scope) => { ${PAGE_FNS}
      let root = null;
      if (scope === 'form') {
        const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = tw.nextNode())) if (/^(出發地點|出發地|目的地)$/.test(n.nodeValue.trim())) { root = n.parentElement; break; }
        for (let k = 0; root && k < 6 && !(root.querySelectorAll('input,button,[role=button],[role=combobox]').length >= 3); k++) root = root.parentElement;
      } else root = cxRoot();
      return cxDiag(root || document.body, '腳本診斷：' + scope);
    })(${JSON.stringify(scope || 'results')})`).catch((e) => `診斷失敗：${e.message}`);
    fs.writeFileSync(base + '.txt', diag);
    log(`已存診斷資料到 runner-debug/${path.basename(base)}.txt（已去掉姓名、會員號碼、e-mail、里數餘額；只在你電腦上，不會上傳）`);
  } catch (e) { log(`（存診斷資料失敗：${e.message}）`); }
}

// ---------- the homepage booking widget (labels from the owner's screenshots; text locators only) ----------
const visible = async (loc) => { try { return await loc.first().isVisible({ timeout: 1500 }); } catch { return false; } };
async function firstVisible(cands) { for (const c of cands) if (await visible(c)) return c.first(); return null; }
const anyText = (page, re) => page.getByText(re);

// The field under a small label (出發地點 / 目的地 / 旅程類別 …): the smallest box holding the label and something
// else (the value), as the page's own code — not Cathay's class names — tells it apart. In the page: { box, input,
// value } elements, or null.
const FIELD_JS = `(src) => {
  const re = new RegExp(src, 'i');
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = tw.nextNode())) {
    const t = n.nodeValue.trim();
    if (!t || t.length > 16 || !re.test(t)) continue;
    const lab = n.parentElement;
    if (!lab || !lab.getClientRects().length) continue;
    let box = lab;
    for (let k = 0; box.parentElement && box.parentElement !== document.body && k < 6 && (box.innerText || '').trim() === t; k++) box = box.parentElement;
    const vis = (e) => e && e.getClientRects().length;
    const input = [...box.querySelectorAll('input,textarea,[contenteditable=true],[role=textbox],[role=combobox],select')].find((e) => vis(e) && e.type !== 'password' && e.type !== 'hidden');
    let value = null;
    const tw2 = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    let m;
    while ((m = tw2.nextNode())) if (m.nodeValue.trim() && m.parentElement !== lab && vis(m.parentElement)) { value = m.parentElement; break; }
    return { box, input, value, lab };
  }
  return null;
}`;
async function clickField(page, labelRe) {
  return page.evaluate(`((find) => {
    const f = find(${JSON.stringify(labelRe.source)});
    if (!f) return '';
    if (f.input) { f.input.focus(); f.input.click(); return 'input'; }
    if (f.lab.tagName === 'LABEL' && f.lab.control) { f.lab.click(); return 'label'; }
    (f.value || f.box).click();
    return f.value ? 'value' : 'box';
  })(${FIELD_JS})`).catch(() => '');
}

// Type into the input that belongs to the field (after clicking it), else into whatever took focus (never a
// password field).
async function typeIntoField(page, labelRe, text) {
  const ok = await page.evaluate(`((find) => {
    const f = find(${JSON.stringify(labelRe.source)});
    if (f && f.input) { f.input.focus(); return true; }
    const a = document.activeElement;
    return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable) && a.type !== 'password';
  })(${FIELD_JS})`).catch(() => false);
  if (!ok) {
    const inp = await firstVisible([page.getByRole('combobox'), page.getByRole('textbox'), page.locator('input:not([type=password]):not([type=hidden]):not([type=checkbox]):not([type=radio])')]);
    if (!inp) return false;
    await inp.click();
  }
  await page.keyboard.press('Control+A').catch(() => {});
  await page.keyboard.press('Backspace').catch(() => {});
  await page.keyboard.type(text, { delay: rand(60, 140) });
  return true;
}

// A city field: click, type the name, pick the suggestion that carries the airport code (else the first one).
async function fillCity(page, labelRe, name, code) {
  if (!(await clickField(page, labelRe))) return false;
  await pause(1, 2);
  if (!(await typeIntoField(page, labelRe, name || code))) return false;
  await pause(1.5, 3);
  const pick = await firstVisible([page.getByRole('option', { name: new RegExp(code, 'i') }), page.getByRole('option'), anyText(page, new RegExp(`\\(${code}\\)`)), page.getByRole('listitem').filter({ hasText: new RegExp(code) })]);
  if (pick) await pick.click(); else { await page.keyboard.press('ArrowDown'); await sleep(300); await page.keyboard.press('Enter'); }
  await pause(1, 2);
  const txt = await page.evaluate(() => document.body.innerText);
  return new RegExp(`\\(?${code}\\)?`).test(txt) || (name && txt.includes(name));
}

// A dropdown field: click, choose by text. Skipped when the field already shows the wanted text.
async function chooseIn(page, labelRe, wantRe) {
  const shown = await page.evaluate(`((lab, want) => {
    const L = new RegExp(lab); const W = new RegExp(want);
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = tw.nextNode())) if (L.test(n.nodeValue.trim())) { let e = n.parentElement; for (let k = 0; e && k < 4; e = e.parentElement, k++) if (W.test(e.innerText || '')) return true; return false; }
    return false;
  })(${JSON.stringify(labelRe.source)}, ${JSON.stringify(wantRe.source)})`).catch(() => false);
  if (shown) return true;
  if (!(await clickField(page, labelRe))) return false;
  await pause(1, 2);
  const o = await firstVisible([page.getByRole('option', { name: wantRe }), page.getByRole('menuitem', { name: wantRe }), page.getByRole('radio', { name: wantRe }), anyText(page, wantRe)]);
  if (!o) return false;
  await o.click();
  await pause(1, 2);
  return true;
}

// The departure date: a date picker that opens under the field (click the day, flipping months with the › arrow),
// or an input we can type into.
async function fillDate(page, iso) {
  if (!(await clickField(page, /^出發日期$|^departure date$|^departing$/i))) return false;
  await pause(1, 2);
  const [y, m, d] = iso.split('-').map(Number);
  const typed = await page.evaluate(() => { const a = document.activeElement; return !!a && a.tagName === 'INPUT' && a.type !== 'password' && !a.readOnly; });
  if (typed) {
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.type(`${y}/${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}`, { delay: 80 });
    await page.keyboard.press('Enter').catch(() => {});
    await pause(1, 2);
  }
  const monthRe = new RegExp(`${y}\\s*年\\s*0?${m}\\s*月|${['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'][m - 1]}[a-z]*\\.?\\s+${y}`, 'i');
  for (let k = 0; k < 4; k++) {
    if (await visible(page.getByText(monthRe))) break;
    const nx = await firstVisible([page.getByRole('button', { name: /下一?個?月|next month/i }), page.locator('[aria-label*="下個月"],[aria-label*="下一個月"],[aria-label*="next month" i]'), page.getByRole('button', { name: /^(›|>|»)$/ })]);
    if (!nx) break;
    await nx.click();
    await pause(1, 2);
  }
  const cell = await firstVisible([page.getByRole('gridcell', { name: new RegExp(`^0?${d}$`) }), page.getByRole('button', { name: new RegExp(`^0?${d}$|${y}年0?${m}月0?${d}日|^${d}\\s*日$`) }), page.getByRole('gridcell').filter({ hasText: new RegExp(`^0?${d}$`) }), page.locator('td,li,span,div').filter({ hasText: new RegExp(`^0?${d}$`) })]);
  if (cell) { await cell.click(); await pause(1, 2); }
  const ok = await page.evaluate(`(() => new RegExp(${JSON.stringify(`${y}\\s*年\\s*0?${m}\\s*月\\s*0?${d}\\s*日|${y}[/-]0?${m}[/-]0?${d}`)}).test(document.body.innerText))()`).catch(() => false);
  return Boolean(ok);
}

// 「使用里數兌換」 must be on. The toggle is a switch/checkbox next to that text.
async function milesToggleOn(page) {
  const state = await page.evaluate(`(() => {
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = tw.nextNode())) if (/使用里數兌換|使用里數|redeem (with )?miles|pay with miles/i.test(n.nodeValue)) {
      let e = n.parentElement;
      for (let k = 0; e && k < 5; e = e.parentElement, k++) {
        const sw = e.querySelector('[role=switch],[role=checkbox],input[type=checkbox]');
        if (sw) { const on = sw.getAttribute('aria-checked') === 'true' || sw.checked === true; return { found: true, on }; }
      }
      return { found: true, on: null };
    }
    return { found: false };
  })()`).catch(() => ({ found: false }));
  if (!state.found) return false;
  if (state.on === true) return true;
  const sw = await firstVisible([page.getByRole('switch', { name: /里數|miles/i }), page.getByRole('checkbox', { name: /里數|miles/i }), page.getByRole('switch'), anyText(page, /使用里數兌換/)]);
  if (!sw) return false;
  await sw.click();
  await pause(1, 2);
  return true;
}

// The whole homepage search: true when the results page with the date strip came up.
async function searchFromHome(page, route, date) {
  const step = async (name, fn) => { const ok = await fn(); log(`　${ok ? '✓' : '✗'} ${name}`); if (!ok) throw new Error(name); await pause(); };
  await step('預訂航班 分頁', async () => { const t = await firstVisible([page.getByRole('tab', { name: /^預訂航班$|^book (a )?flight/i }), anyText(page, /^預訂航班$/)]); if (t) await t.click(); return true; });
  await step('使用里數兌換 開啟', () => milesToggleOn(page));
  await step(`出發地點 ${route.from}（${route.fc}）`, () => fillCity(page, /^出發地點$|^出發地$|^from$|^origin$/i, route.from, route.fc));
  await step(`目的地 ${route.to}（${route.tc}）`, () => fillCity(page, /^目的地$|^到達地$|^to$|^destination$/i, route.to, route.tc));
  await step('旅程類別 單程', () => chooseIn(page, /^旅程類別$|^trip type$/i, /^單程$|^one[- ]?way$/i));
  if (!route.cabins.includes('Y')) await step(`客艙 ${CABIN_NAME[route.cabins[0]]}`, () => chooseIn(page, /^客艙級別及乘客$|^客艙|cabin/i, TILE[route.cabins[0]]));
  await step(`出發日期 ${date}`, () => fillDate(page, date));
  const home = await page.evaluate(() => { const m = document.body.innerText.match(/里數低至\s*₳?\s*([\d,]{4,8})/); return m ? +m[1].replace(/,/g, '') : 0; }).catch(() => 0);
  if (home) log(`　首頁顯示 ${date} 每位乘客里數低至 ${fmt(home)}`);
  await step('兌換機票', async () => {
    const b = await firstVisible([page.getByRole('button', { name: /兌換機票|搜尋航班|搜尋|redeem flights?|search flights?|search/i }), anyText(page, /^兌換機票$/)]);
    if (!b) return false;
    await b.click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    return true;
  });
  await leaveModal(page);
  await sleep(3000);
  const info = await readPage(page);
  return { ok: info.r.strip.length > 0 || info.r.flights.length > 0, info, home };
}

// 「你將要離開此頁面」: click 離開頁面 when that modal is up.
async function leaveModal(page) {
  const b = await firstVisible([page.getByRole('button', { name: /^離開頁面$|^leave( page)?$/i })]);
  if (!b) return false;
  await b.click();
  await pause(1, 2);
  return true;
}

// ---------- the results page: strip, cabin tiles, arrows, days ----------
async function stripInfo(page) {
  const info = await readPage(page);
  const s = info.r.strip;
  return { info, first: s.length ? s[0].date : '', last: s.length ? s[s.length - 1].date : '', n: s.length };
}

async function clickArrow(page, dir) {
  const next = dir === 'next';
  const cands = next
    ? [page.locator('[aria-label*="下一週"],[aria-label*="下週"],[aria-label*="下一"],[aria-label*="next" i]'), page.getByRole('button', { name: /下一週|下週|next/i }), page.getByRole('button', { name: /^(›|>|»|→)$/ })]
    : [page.locator('[aria-label*="上一週"],[aria-label*="上週"],[aria-label*="上一"],[aria-label*="prev" i]'), page.getByRole('button', { name: /上一週|上週|previous|prev/i }), page.getByRole('button', { name: /^(‹|<|«|←)$/ })];
  for (const c of cands) {
    const n = await c.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 4); i++) {
      const el = c.nth(i);
      if (await el.isVisible().catch(() => false)) { await el.click(); return 'locator'; }
    }
  }
  // Fallback: the clickable thing right after (or before) the row of weekday cells.
  const ok = await page.evaluate(`((next) => { ${PAGE_FNS}
    const WD = /^\\s*(?:(?:星期|週|周|禮拜)[日天一二三四五六]|(?:sun|mon|tue|wed|thu|fri|sat)[a-z]{0,6}\\.?),?\\s*(\\d{1,2})\\b/i;
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const cells = [];
    let n;
    while ((n = tw.nextNode())) {
      const t = n.nodeValue.trim();
      if (!/^(?:星期|週|周|禮拜)[日天一二三四五六]$|^(sun|mon|tue|wed|thu|fri|sat)[a-z]{0,6}\\.?$/i.test(t)) continue;
      let e = n.parentElement;
      for (let k = 0; e && k < 4; e = e.parentElement, k++) if (WD.test(e.innerText || '')) { if (e.getClientRects().length) cells.push(e); break; }
    }
    if (cells.length < 3) return false;
    const edge = next ? cells[cells.length - 1] : cells[0];
    const r = edge.getBoundingClientRect();
    let row = edge.parentElement;
    for (let k = 0; row && k < 4 && !row.querySelector('button,[role=button],svg,a'); k++) row = row.parentElement;
    const cands = [...(row || document.body).querySelectorAll('button,[role=button],a,svg')].filter((b) => !cells.some((c) => c.contains(b) || b.contains(c)));
    const hit = cands.map((b) => [b, b.getBoundingClientRect()]).filter(([, q]) => q.width && Math.abs((q.top + q.bottom) / 2 - (r.top + r.bottom) / 2) < r.height && (next ? q.left >= r.right - 4 : q.right <= r.left + 4)).sort((a, b) => (next ? a[1].left - b[1].left : b[1].right - a[1].right))[0];
    if (!hit) return false;
    const el = hit[0].closest('button,[role=button],a') || hit[0];
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  })(${next})`).catch(() => false);
  return ok ? 'fallback' : '';
}

// Select a cabin tile; true when that cabin is now selected (or is the only one).
async function selectCabin(page, cabin) {
  const before = await readPage(page);
  if (!before.r.tiles.length) return before.r.cabin === cabin || (!before.r.cabin && cabin === 'Y' && !before.r.tiles.length);
  if (!before.r.tiles.some((t) => t.c === cabin)) return false;
  if (before.r.cabin === cabin) return true;
  const t = await firstVisible([page.getByRole('button', { name: TILE[cabin] }), page.getByRole('tab', { name: TILE[cabin] }), anyText(page, TILE[cabin])]);
  if (!t) return false;
  await t.click();
  await pause();
  await waitIdle(page);
  const after = await readPage(page);
  return after.r.cabin === cabin;
}

// Click a day on the strip (detailDays): the cell whose weekday/number text matches.
async function clickDay(page, iso) {
  const d = +iso.slice(8);
  return page.evaluate(`((d) => {
    const WD = /^\\s*(?:(?:星期|週|周|禮拜)[日天一二三四五六]|(?:sun|mon|tue|wed|thu|fri|sat)[a-z]{0,6}\\.?),?\\s*(\\d{1,2})\\b/i;
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = tw.nextNode())) {
      if (!/^(?:星期|週|周|禮拜)[日天一二三四五六]$|^(sun|mon|tue|wed|thu|fri|sat)[a-z]{0,6}\\.?$/i.test(n.nodeValue.trim())) continue;
      let e = n.parentElement;
      for (let k = 0; e && k < 4; e = e.parentElement, k++) { const m = (e.innerText || '').match(WD); if (m) { if (+m[1] === d && e.getClientRects().length) { (e.closest('button,[role=button],a') || e).click(); return true; } break; } }
    }
    return false;
  })(${d})`).catch(() => false);
}

// ---------- one route ----------
// Reach the results page for `route` on `date`: searchUrl template → homepage widget → the person at the keyboard.
async function reachResults(page, route, date, mode) {
  const where = `${route.from || route.fc} → ${route.to || route.tc}`;
  if (cfg.searchUrl) {
    const url = cfg.searchUrl.replace(/\{from\}/g, route.fc).replace(/\{to\}/g, route.tc).replace(/\{date\}/g, date).replace(/\{pax\}/g, String(route.pax || 1)).replace(/\{cabin\}/g, route.cabins[0] || 'Y');
    log(`開啟搜尋網址 ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await pause();
    const info = await ensureNotBlocked(page, mode);
    if (info.r.strip.length) return { info, how: 'url' };
    log('搜尋網址開了，但看不到日期列。');
  }
  // The homepage widget.
  let formErr = '';
  try {
    log(`開啟國泰首頁 ${cfg.homeUrl}`);
    await page.goto(cfg.homeUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await pause();
    await ensureNotBlocked(page, mode);
    const r = await searchFromHome(page, route, date);
    const info = await ensureNotBlocked(page, mode);
    if (r.ok && info.r.strip.length) return { info, how: 'form', home: r.home };
    formErr = r.ok ? '結果頁沒有日期列' : '結果頁沒出現';
    await saveDebug(page, 'form-' + route.fc + route.tc, info.r.strip.length ? 'results' : 'form');
  } catch (e) {
    if (e instanceof Stop) throw e;
    formErr = e.message;
    await saveDebug(page, 'form-' + route.fc + route.tc, 'form');
  }
  log(`自動填搜尋表單沒成功（${formErr}），改請你手動搜尋。`);
  // The person at the keyboard.
  if (cfg.headless === true) throw new Stop('headless 模式下無法請你手動搜尋，請把 headless 改成 false。', 3);
  for (const u of cfg.redeemUrls) {
    try { await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 60000 }); break; } catch (e) { log(`（打不開 ${u}：${e.message}）`); }
  }
  await pause(1, 2);
  await heartbeat('needs-user', `${route.fc}→${route.tc}`);
  for (let tries = 0; tries < 2; tries++) {
    const a = await ask(`請在瀏覽器裡搜尋 ${where}（${route.pax || 1} 位，單程，出發 ${date}），停在「選擇航班」頁，然後按 Enter`);
    if (a == null) throw new Stop('沒有人在鍵盤前（stdin 已關閉），這條航線先跳過。', 3);
    await leaveModal(page);
    const info = await ensureNotBlocked(page, mode);
    if (info.r.strip.length) return { info, how: 'manual' };
    log('還是看不到日期列：請確認頁面停在「選擇航班」（有星期幾和日期的那一列）。');
  }
  await saveDebug(page, 'manual-' + route.fc + route.tc, 'results');
  throw new Error('看不到日期列');
}

// Does the page show the route we asked for? Codes from the flight cards when there are any, else the names.
function routeMatches(r, route) {
  if (r.fc && r.tc) return r.fc === route.fc && r.tc === route.tc;
  if (r.from && route.from) return r.from.includes(route.from) || route.from.includes(r.from);
  return true;
}

async function sweepRoute(route, mode) {
  const page = await newPage();
  const tag = `${route.fc}→${route.tc}`;
  const start = cfg.startDate && /^\d{4}-\d{2}-\d{2}$/.test(cfg.startDate) && cfg.startDate >= todayLocal() ? cfg.startDate : addDays(todayLocal(), 1);
  const until = addDays(start, cfg.daysAhead - 1);
  log(`開始查 ${tag}（${route.from} → ${route.to}）${start} ～ ${until}，艙等 ${route.cabins.map((c) => CABIN_NAME[c]).join('、')}，${route.pax} 位`);
  await heartbeat('running', tag);
  const reached = await reachResults(page, route, start, { route: tag });
  if (!routeMatches(reached.info.r, route)) {
    await saveDebug(page, 'route-' + route.fc + route.tc, 'results');
    throw new Error(`頁面上的航線（${reached.info.r.from || reached.info.r.fc} → ${reached.info.r.to || reached.info.r.tc}）和要查的不一樣，這條先跳過。`);
  }
  const days = {};
  const day = (d) => (days[d] = days[d] || {});
  if (reached.home) { day(start).lo = reached.home; }
  const record = (r, cabin) => {
    for (const s of r.strip) {
      const x = day(s.date);
      x.c = x.c || {};
      const c = x.c[cabin] || { m: 0 };
      if (s.na) c.na = 1; else delete c.na;
      if (s.m) { c.m = s.m; if (!x.lo || s.m < x.lo) x.lo = s.m; }
      x.c[cabin] = c;
    }
  };
  const within = (d) => d >= start && d <= until;
  const maxTurns = Math.ceil(cfg.daysAhead / 7) + 2;
  let ci = 0;
  for (const cabin of route.cabins) {
    if (!(await selectCabin(page, cabin))) { log(`　${CABIN_NAME[cabin]}艙：頁面上沒有這個艙等的選項，跳過。`); continue; }
    const forward = ci++ % 2 === 0; // the second cabin sweeps back toward the start: half the clicks
    let st = await stripInfo(page);
    if (!st.n) { await saveDebug(page, 'strip-' + route.fc + route.tc, 'results'); throw new Error('讀不到日期列（已存診斷資料）'); }
    for (let turn = 0; turn < maxTurns; turn++) {
      record(st.info.r, cabin);
      if (cfg.detailDays) {
        for (const s of st.info.r.strip) {
          if (s.na || !within(s.date)) continue;
          if (!(await clickDay(page, s.date))) { log(`　（點不到 ${s.date}）`); continue; }
          await pause();
          await waitIdle(page);
          const info = await readPage(page);
          const r = info.r;
          if (r.date !== s.date) { log(`　（點了 ${s.date} 但頁面顯示 ${r.date || '不明'}，先不記航班）`); continue; }
          if (r.cabin && r.cabin !== cabin) { log(`　（點了 ${s.date} 但頁面選的是${CABIN_NAME[r.cabin]}艙，先不記航班）`); continue; }
          const fl = r.flights.filter((f) => (f.mc ? f.mc[cabin] : !f.mc)).slice(0, 15).map((f) => { const o = { ...f }; if (o.mc) { o.m = o.mc[cabin]; delete o.mc; } return o; });
          const low = r.low[cabin] || (fl.length ? Math.min(...fl.map((f) => f.m).filter(Boolean)) : 0);
          const x = day(s.date);
          x.c = x.c || {};
          x.c[cabin] = { ...(x.c[cabin] || {}), m: low || 0, t: Date.now() };
          // No flight cards: 無位 only when the page says so; otherwise the day stays "open, miles unknown".
          const none = /沒有可兌換|沒有座位|沒有航班|無可用|no (award )?(seats|flights)|not available|sold out/i.test(info.text);
          if (fl.length) x.c[cabin].f = fl; else if (!low && none) x.c[cabin].na = 1; else if (!low) log(`　（${s.date} ${CABIN_NAME[cabin]}艙讀不到航班卡片，先記為有位但里數不明）`);
          if (low && (!x.lo || low < x.lo)) x.lo = low;
        }
      }
      const done = forward ? st.last >= until : st.first <= start;
      if (done) break;
      const how = await clickArrow(page, forward ? 'next' : 'prev');
      if (!how) { log(`　找不到日期列的${forward ? '›' : '‹'}箭頭，這個艙等到此為止。`); await saveDebug(page, 'arrow-' + route.fc + route.tc, 'results'); break; }
      await pause();
      await waitIdle(page);
      const nx = await stripInfo(page);
      if (!nx.n || nx.first === st.first) { await sleep(3000); const again = await stripInfo(page); if (!again.n || again.first === st.first) { log('　日期列沒有往前，停在這裡。'); break; } st = again; } else st = nx;
      if (blockedKind(st.info)) { await ensureNotBlocked(page, { route: tag }); st = await stripInfo(page); }
    }
    const n = Object.keys(days).filter((d) => within(d) && days[d].c && days[d].c[cabin] && !days[d].c[cabin].na).length;
    log(`　${CABIN_NAME[cabin]}艙：讀到 ${Object.keys(days).filter((d) => within(d) && days[d].c && days[d].c[cabin]).length} 天，${n} 天有位`);
  }
  // A day every swept cabin calls 不適用 is 無位.
  for (const d of Object.keys(days)) {
    const c = days[d].c || {};
    const ks = Object.keys(c);
    if (ks.length && ks.every((k) => c[k].na)) days[d].na = 1; else delete days[d].na;
  }
  return { days, start, until };
}

// Merge into data/<FROM>-<TO>.json (new sweep wins, past days dropped) and upload.
function mergeLocal(route, sweep) {
  const file = path.join(DATA_DIR, `${route.fc}-${route.tc}.json`);
  let old = null;
  try { old = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first time */ }
  const today = todayLocal();
  const days = {};
  for (const [d, v] of Object.entries((old && old.days) || {})) if (d >= today) days[d] = v;
  for (const [d, v] of Object.entries(sweep.days)) {
    if (d < today) continue;
    const x = { ...(days[d] || {}), ...v };
    // Cabins not swept this time keep their old reading; a strip-only reading (open, miles unknown) does not wipe
    // the flights and miles a detailDays run recorded earlier.
    if (days[d] && days[d].c && v.c) {
      x.c = { ...days[d].c };
      for (const [k, nv] of Object.entries(v.c)) { const ov = days[d].c[k]; x.c[k] = ov && ov.m && !nv.na && !nv.m ? ov : nv; }
    }
    if (!v.na) delete x.na;
    // The day's lowest: the cabins' known miles, else what the sweep said (the homepage's 里數低至).
    const ms = Object.values(x.c || {}).map((c) => c.m).filter(Boolean);
    if (ms.length) x.lo = Math.min(...ms); else if (!v.lo) delete x.lo;
    days[d] = x;
  }
  const out = { v: 1, from: route.from || route.fc, to: route.to || route.tc, fc: route.fc, tc: route.tc, at: Date.now(), days, source: 'runner', cabins: route.cabins, pax: route.pax || 1, range: { from: sweep.start, to: sweep.until } };
  fs.writeFileSync(file, JSON.stringify(out, null, 1));
  return { file, out };
}

function summary(route, sweep) {
  const within = (d) => d >= sweep.start && d <= sweep.until;
  const total = Object.keys(sweep.days).filter(within).length || cfg.daysAhead;
  const parts = route.cabins.map((cabin) => {
    const ds = Object.keys(sweep.days).filter((d) => within(d) && sweep.days[d].c && sweep.days[d].c[cabin]);
    if (!ds.length) return `${CABIN_NAME[cabin]} 沒讀到`;
    const open = ds.filter((d) => !sweep.days[d].c[cabin].na);
    const ms = open.map((d) => sweep.days[d].c[cabin].m).filter(Boolean);
    return `${CABIN_NAME[cabin]} ${open.length}/${total} 天有位${ms.length ? `，最低 ${fmt(Math.min(...ms))}` : '（里數要點進日期才看得到）'}`;
  });
  return `${route.fc}→${route.tc} ${parts.join('；')}`;
}

async function runRoute(route) {
  const t0 = Date.now();
  const sweep = await sweepRoute(route);
  const { file, out } = mergeLocal(route, sweep);
  const line = summary(route, sweep);
  log(`${line}（${Math.round((Date.now() - t0) / 1000)} 秒，已存 ${path.relative(DIR, file)}）`);
  hbState.lastRun = new Date().toISOString();
  hbState.summary = line;
  if (!cfg.site) return { line, uploaded: false };
  try {
    const r = await site('/api/cxcal', out);
    log(`已上傳到 ${cfg.site}（${r.days} 天）`);
    return { line, uploaded: true };
  } catch (e) {
    log(`上傳失敗：${e.message}。資料留在 ${path.relative(DIR, file)}，下次成功時會一起上傳。`);
    return { line, uploaded: false };
  }
}

// The routes to sweep: the site's list (managed on the website), else config.routes.
const cleanRoute = (r) => ({ fc: String(r.fc || r.from || '').toUpperCase().slice(0, 3), tc: String(r.tc || r.to || '').toUpperCase().slice(0, 3), from: r.fromName || r.from || '', to: r.toName || r.to || '', cabins: Array.isArray(r.cabins) && r.cabins.length ? r.cabins : cfg.cabins, pax: Number(r.pax) || cfg.pax || 1 });
async function wantedRoutes() {
  let routes = [];
  let queue = [];
  if (cfg.site && cfg.passcode) {
    try {
      const w = await site('/api/cxcal/wanted');
      routes = (w.routes || []).map(cleanRoute);
      queue = (w.queue || []).map((q) => routes.find((r) => r.fc === q.fc && r.tc === q.tc) || cleanRoute(q));
    } catch (e) { log(`讀不到網站上的清單（${e.message}），改用設定檔的 routes。`); routes = []; }
  }
  if (!routes.length) routes = (cfg.routes || []).map((r) => cleanRoute({ ...r, fromName: r.fromName || '', toName: r.toName || '' }));
  const only = opt('--route');
  if (only) {
    const [fc, tc] = only.toUpperCase().split(/[-> ]+/);
    routes = routes.filter((r) => r.fc === fc && r.tc === tc);
    if (!routes.length) routes = [cleanRoute({ fc, tc })];
  }
  return { routes: routes.filter((r) => /^[A-Z]{3}$/.test(r.fc) && /^[A-Z]{3}$/.test(r.tc)), queue };
}

async function runBatch(routes, label) {
  const lines = [];
  let code = 0;
  for (const route of routes) {
    try {
      lines.push((await runRoute(route)).line);
    } catch (e) {
      if (e instanceof Stop) { log(`停止：${e.message}`); code = e.exitCode; lines.push(`${route.fc}→${route.tc} 沒查完（${e.message}）`); break; }
      log(`${route.fc}→${route.tc} 失敗：${e.message}`);
      lines.push(`${route.fc}→${route.tc} 失敗（${e.message}）`);
      code = code || 1;
    }
    await pause();
  }
  if (lines.length) log(`${label}結果：${lines.join('｜')}`);
  return code;
}

async function once() {
  const { routes, queue } = await wantedRoutes();
  const list = [...queue, ...routes.filter((r) => !queue.some((q) => q.fc === r.fc && q.tc === r.tc))].slice(0, cfg.maxRoutes);
  if (!list.length) { log('沒有要查的航線：請在網站的航線查詢結果按「加入國泰定時查詢」，或在 config.json 的 routes 填航線。'); return 2; }
  log(`這次查 ${list.length} 條：${list.map((r) => `${r.fc}→${r.tc}`).join('、')}（每次最多 ${cfg.maxRoutes} 條）`);
  const code = await runBatch(list, '這次');
  for (const q of queue) await site('/api/cxcal/queue', { action: 'done', fc: q.fc, tc: q.tc }).catch(() => {});
  await heartbeat(code === 3 ? 'blocked' : 'idle');
  await closeBrowser();
  return code;
}

// --watch: poll the site; queued routes right away, the whole list once a day at dailyAt.
async function watch() {
  const stateFile = path.join(DIR, 'state.json');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* first run */ }
  const saveState = () => fs.writeFileSync(stateFile, JSON.stringify(state));
  log(`監看模式：每 ${cfg.pollSeconds} 秒問一次網站，每天 ${cfg.dailyAt} 查一輪清單。按 Ctrl+C 結束。`);
  let stop = false;
  process.on('SIGINT', () => { stop = true; log('收到 Ctrl+C，查完手上的就結束。'); });
  while (!stop) {
    let code = 0;
    try {
      const { routes, queue } = await wantedRoutes();
      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const today = todayLocal();
      const daily = routes.length && hhmm >= cfg.dailyAt && state.lastDaily !== today;
      if (queue.length) {
        log(`網站上有 ${queue.length} 條「現在就查」：${queue.map((q) => `${q.fc}→${q.tc}`).join('、')}`);
        code = await runBatch(queue.slice(0, 5), '隨選');
        for (const q of queue) await site('/api/cxcal/queue', { action: 'done', fc: q.fc, tc: q.tc }).catch(() => {});
      } else if (daily) {
        state.lastDaily = today;
        saveState();
        log(`每日一輪：${routes.length} 條（最多 ${cfg.maxRoutes} 條）`);
        code = await runBatch(routes.slice(0, cfg.maxRoutes), '每日');
      }
      if (queue.length || daily) await closeBrowser();
      await heartbeat(code === 3 ? 'blocked' : 'idle');
      if (code === 3) { log('被擋或需要登入而沒完成，等 6 小時後再試。'); await sleep(6 * 3600e3); }
    } catch (e) {
      log(`監看出錯：${e.message}`);
      await closeBrowser();
    }
    for (let i = 0; i < cfg.pollSeconds && !stop; i++) await sleep(1000);
  }
  await closeBrowser();
  return 0;
}

(async () => {
  log(`cathay-runner 啟動（${flag('--watch') ? '監看' : '查一輪'}，設定檔 ${path.basename(cfgPath)}，網站 ${cfg.site || '未設定'}）`);
  if (!cfg.passcode) log('提醒：config.json 沒填 passcode（網站的通關密碼），只會存在本機，不會上傳。');
  if (cfg.pace[0] < 3) log('提醒：pace 低於 3 秒，比真人快很多，容易被國泰擋。');
  const code = flag('--watch') ? await watch() : await once();
  if (rl) rl.close();
  process.exit(code);
})().catch(async (e) => {
  log(`錯誤：${e.stack || e.message}`);
  await closeBrowser();
  process.exit(1);
});
