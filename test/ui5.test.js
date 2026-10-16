// Fifth round, small UI items: favourite/recent chips name their filters (F14), the date picker's shorter ± list (F17),
// the 外觀 switch (F13) and the owner's status line on the daily run with its server side (R10).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
delete process.env.SEATS_AERO_API_KEY;
delete process.env.CASH_PASSCODE;
delete process.env.CRON_SECRET;
const { server } = require('../server');
const { cronParts, cronSlot } = require('../lib/cronreport');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
function grab(src, re) {
  const m = src.match(re);
  assert.ok(m, String(re));
  return m[0];
}
const app = read('app.js');
const opts = read('siteopts.js');

test('F14: chips show the alliance, airline and 直飛 filters, and ✕ names the route', () => {
  const ctx = { isoDate: () => '2026-10-15', URLSearchParams };
  vm.createContext(ctx);
  vm.runInContext([
    grab(app, /const CABIN_LABEL = .*;/), grab(app, /const mmdd = .*;/), grab(app, /const ymd = .*;/),
    grab(app, /const ALLIANCE_SHORT = .*;/), grab(app, /const shareRoute = .*;/), grab(app, /function shareLabel\(q\) \{[\s\S]*?\n\}/),
    'this.shareLabel = shareLabel; this.shareRoute = shareRoute;',
  ].join('\n'), ctx);
  assert.equal(ctx.shareLabel('o=TPE&d=HKG&s=2026-11-13&e=2026-11-27&c=Y&al=oneworld'), 'TPE → HKG・寰宇一家　11/13 – 11/27　經濟艙');
  assert.equal(ctx.shareLabel('o=TPE&d=HKG&s=2026-11-13&e=2026-11-27&c=Y&al=oneworld&direct=1'), 'TPE → HKG・寰宇一家・直飛　11/13 – 11/27　經濟艙');
  assert.equal(ctx.shareLabel('o=TPE&d=NRT&s=2026-11-13&e=2026-11-13&c=J&a=BR&n=2'), 'TPE → NRT・BR　11/13　商務艙　2+ 位');
  assert.equal(ctx.shareLabel('o=TPE,TSA&d=NRT&s=2026-11-13&c=J'), 'TPE,TSA → NRT　11/13　商務艙');
  assert.equal(ctx.shareRoute(new URLSearchParams('o=TPE&d=HKG&al=star&direct=1&s=2026-11-13')), 'TPE → HKG・星空聯盟・直飛');
  assert.match(app, /aria-label="\$\{esc\(`從常用移除 \$\{shareRoute\(/);
});

test('F17: six ± options; a wider ± (old links, favourites) opens as a date range', () => {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext([grab(app, /const FLEX_DAYS = .*;/), grab(app, /const flexHalf = .*;/), grab(app, /const dayCount = .*;/), 'this.FLEX_DAYS = FLEX_DAYS; this.flexHalf = flexHalf;'].join('\n'), ctx);
  assert.deepEqual([...ctx.FLEX_DAYS], [0, 1, 3, 7, 14, 28]);
  assert.equal(ctx.flexHalf('2026-11-20', '2026-11-20'), 0);
  assert.equal(ctx.flexHalf('2026-11-13', '2026-11-27'), 7);
  assert.equal(ctx.flexHalf('2026-11-01', '2026-12-27'), 28);
  // ±10 and ±60 were options before: now a range, as is any span that isn't one day ± an option.
  assert.equal(ctx.flexHalf('2026-11-10', '2026-11-30'), null);
  assert.equal(ctx.flexHalf('2026-11-01', '2027-01-30'), null);
  assert.equal(ctx.flexHalf('2026-11-01', '2026-11-30'), null);
  // The mode switch redraws the field's button, not only the calendar.
  assert.match(grab(app, /if \(t\.name === `\$\{uid\}-mode`\) \{[\s\S]*?return render\(\);\n    \}/), /updateButton\(\);/);
});

test('F13: 外觀 cycles 跟隨系統 → 淺色 → 深色 and the head script applies a saved choice before paint', () => {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext([grab(opts, /const THEMES = .*;/), grab(opts, /const themeOf = .*;/), grab(opts, /const themeNext = .*;/), grab(opts, /const themeLabel = .*;/), 'this.f = { themeOf, themeNext, themeLabel };'].join('\n'), ctx);
  const { themeOf, themeNext, themeLabel } = ctx.f;
  assert.equal(themeNext(''), 'light');
  assert.equal(themeNext('light'), 'dark');
  assert.equal(themeNext('dark'), 'auto');
  assert.equal(themeNext('bogus'), 'light');
  assert.equal(themeOf(null), 'auto');
  assert.deepEqual(['auto', 'light', 'dark'].map(themeLabel), ['跟隨系統', '淺色', '深色']);

  const head = read('index.html').match(/<script>(try \{ var t = JSON\.parse\(localStorage\.getItem\('theme'\)\)[\s\S]*?)<\/script>/)[1];
  const run = (stored, throws = false) => {
    const el = { dataset: {} };
    const c = { document: { documentElement: el }, localStorage: { getItem: () => { if (throws) throw new Error('blocked'); return stored; } } };
    vm.runInNewContext(head, c);
    return el.dataset.theme;
  };
  assert.equal(run('"dark"'), 'dark');
  assert.equal(run('"light"'), 'light');
  assert.equal(run(null), undefined);
  assert.equal(run('"<x>"'), undefined);
  assert.equal(run('not json'), undefined);
  assert.equal(run('"dark"', true), undefined, 'blocked storage leaves the system choice');
  // Both forced palettes exist: every dark-scheme rule also has a data-theme="dark" twin.
  const css = read('styles.css');
  assert.equal((css.match(/@media \(prefers-color-scheme: dark\)/g) || []).length, (css.match(/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\)/g) || []).length);
});

test('F6: no web font is loaded; the system font stack covers Traditional Chinese', () => {
  assert.doesNotMatch(read('index.html'), /fonts\.googleapis|fonts\.gstatic/);
  const stack = read('styles.css').match(/:root \{[\s\S]*?font-family: ([^;]+);/)[1];
  for (const f of ['-apple-system', '"PingFang TC"', '"Microsoft JhengHei"', '"Noto Sans TC"', 'sans-serif']) assert.ok(stack.includes(f), f);
});

test('R10: cronParts says how each part of a run went', () => {
  assert.deepEqual(cronParts({ configured: true, expiry: { errors: 0 }, deals: 46, watches: { report: [{ id: 1, price: 1 }] }, report: [{ id: 'a', found: 0 }] }), { expiry: 'ok', deals: 'ok', watches: 'ok', alerts: 'ok' });
  assert.deepEqual(cronParts({ configured: true, deals: 30, dealsError: '1 組更新失敗：x', watches: { report: [{ id: 1, retry: true }] }, report: [{ id: 'a', skipped: 'time' }] }), { deals: 'some', watches: 'some', alerts: 'some' });
  assert.deepEqual(cronParts({ configured: true, dealsError: 'down', watches: { error: 'kv' }, alertsError: 'kv', expiry: { error: 'x' } }), { expiry: 'fail', deals: 'fail', watches: 'fail', alerts: 'fail' });
  assert.deepEqual(cronParts({ configured: true, busy: true, report: [] }), { alerts: 'some' });
  assert.deepEqual(cronParts({ configured: false }), {}, 'parts that did not run are left out');
  assert.deepEqual(cronParts({ digest: { mailed: 3, done: true } }), { digest: 'ok' });
  assert.deepEqual(cronParts({ digest: { mailed: 1, left: 2 } }), { digest: 'some' });
  assert.deepEqual(cronParts({ digest: { error: 'kv' } }), { digest: 'fail' });
  assert.deepEqual(cronParts({ digest: { skipped: 'no-deals' } }), {}, 'a digest with nothing to send is left out');
  assert.equal(cronSlot('2026-10-15T00:12:00Z'), 'morning');
  assert.equal(cronSlot('2026-10-15T13:11:00Z'), 'evening');
});

test('R10: the owner line reads 「排程：今天 08:12、21:11 跑完（…）・seats.aero 今天已用 …」', () => {
  const ctx = { fmt: (n) => Number(n).toLocaleString('en-US') };
  vm.createContext(ctx);
  vm.runInContext([grab(opts, /const CRON_PART = .*;/), grab(opts, /const CRON_MARK = .*;/), grab(opts, /const twParts = .*;/), grab(opts, /function cronLine\(st, now = Date\.now\(\)\) \{[\s\S]*?\n\}/), 'this.cronLine = cronLine;'].join('\n'), ctx);
  const now = Date.parse('2026-10-15T14:00:00Z'); // 22:00 in Taiwan
  const morning = { at: '2026-10-15T00:12:30Z', parts: { expiry: 'ok', deals: 'ok', watches: 'ok', alerts: 'ok' } };
  const evening = { at: '2026-10-15T13:11:05Z', parts: { expiry: 'ok', deals: 'ok', watches: 'some', alerts: 'fail' } };
  const base = { secret: true, lastRun: '2026-10-15T13:10:01Z', callsTodayAll: 123, dailyLimit: 1000 };
  assert.equal(ctx.cronLine({ ...base, lastRun: '2026-10-15T00:10:01Z', runs: [morning] }, now), '排程：今天 08:12 跑完（好康 ✓ 降價 ✓ 提醒 ✓）・seats.aero 今天已用 123／1,000 次');
  assert.equal(ctx.cronLine({ ...base, runs: [morning, evening] }, now), '排程：今天 08:12、21:11 跑完（好康 ✓ 降價 △ 提醒 ✗）・seats.aero 今天已用 123／1,000 次');
  // Yesterday's evening run only, today's morning one cut off.
  const y = { at: '2026-10-14T13:11:05Z', parts: { deals: 'ok', alerts: 'ok', expiry: 'fail' } };
  assert.equal(ctx.cronLine({ ...base, lastRun: '2026-10-15T00:10:01Z', runs: [y] }, now), '排程：昨天 21:11 跑完（好康 ✓ 提醒 ✓ 哩程到期 ✗），08:10 那次沒跑完・seats.aero 今天已用 123／1,000 次');
  assert.match(ctx.cronLine({ ...base, lastRun: '2026-10-15T13:59:00Z', runs: [morning] }, now), /08:12 跑完（.*），正在跑・/);
  assert.match(ctx.cronLine({ ...base, secret: false, runs: [] }, now), /^排程：還沒設定 CRON_SECRET/);
  assert.match(ctx.cronLine({ ...base, lastDenied: '2026-10-15T00:10:02Z', lastRun: '2026-10-14T00:10:00Z', runs: [] }, now), /^排程：今天 08:10 被擋下，請檢查 CRON_SECRET/);
  assert.match(ctx.cronLine({ ...base, lastRun: null, runs: [] }, now), /^排程：還沒有跑完的紀錄・seats\.aero 今天已用 123／1,000 次$/);
});

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

test('R10: /api/cron/status is for the owner only and has each slot\'s parts; /api/config has none of it (U18)', async () => {
  Object.assign(process.env, { CASH_PASSCODE: 'pw5', CRON_SECRET: 'tick5' });
  try {
    assert.equal((await fetch(`${base}/api/cron/status`)).status, 403);
    assert.equal((await fetch(`${base}/api/cron/status`, { headers: { authorization: 'Bearer tick5' } })).status, 403, 'the cron secret is not the owner');
    assert.equal((await fetch(`${base}/api/cron/status`, { method: 'POST', headers: { 'x-cash-pass': 'pw5' } })).status, 405);
    const run = await fetch(`${base}/api/alerts/run`, { headers: { authorization: 'Bearer tick5' } });
    assert.equal(run.status, 200);
    const res = await fetch(`${base}/api/cron/status`, { headers: { 'x-cash-pass': 'pw5' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const st = await res.json();
    assert.equal(st.secret, true);
    assert.equal(st.runs.length, 1);
    // The daily deals mail shows up only when it had something to send (depends on the hour and the demo's subscribers).
    assert.deepEqual(Object.keys(st.runs[0].parts).filter((k) => k !== 'digest').sort(), ['alerts', 'deals', 'expiry', 'watches']);
    assert.equal(typeof st.callsTodayAll, 'number');
    assert.equal(st.dailyLimit, 1000);
    assert.ok(st.lastDone);
    assert.ok(Array.isArray(st.setup.missing) && Array.isArray(st.setup.line.missing), 'what is not set up is the owner\'s to read');
    // Visitors: on/off only, no setting names and no run details.
    const cfg = await (await fetch(`${base}/api/config`)).json();
    assert.equal(cfg.cron, undefined);
    assert.equal(cfg.line.missing, undefined);
    assert.deepEqual(cfg.searchCache, { enabled: false });
  } finally {
    delete process.env.CASH_PASSCODE;
    delete process.env.CRON_SECRET;
  }
});
