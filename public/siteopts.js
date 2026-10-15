// Footer extras: the 外觀 switch (跟隨系統／淺色／深色, this device only) and, for the owner, one quiet line on the
// daily run and today's seats.aero calls. Classic script loaded after account.js; uses app.js's globals (store, api,
// $, fmt) and account.js's ownerHere.

// ---------- 外觀 (theme) ----------
// Saved as 'light' or 'dark'; nothing saved follows the system. index.html applies it before the first paint.
const THEME_KEY = 'theme';
const THEMES = [['auto', '跟隨系統'], ['light', '淺色'], ['dark', '深色']];
const themeOf = (v) => (v === 'light' || v === 'dark' ? v : 'auto');
const themeNext = (cur) => THEMES[(THEMES.findIndex(([k]) => k === themeOf(cur)) + 1) % THEMES.length][0];
const themeLabel = (t) => THEMES.find(([k]) => k === themeOf(t))[1];
function applyTheme(t) {
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}
function mountTheme() {
  const at = $('#ver-history');
  if (!at) return;
  // On the version row, before 更新紀錄 (which takes a row of its own).
  at.insertAdjacentHTML('beforebegin', '<span class="theme-pick">外觀 <button type="button" class="linkish" id="theme-btn"></button></span>');
  const btn = $('#theme-btn');
  const show = (t) => {
    btn.textContent = themeLabel(t);
    btn.setAttribute('aria-label', `外觀：${themeLabel(t)}，點一下換成${themeLabel(themeNext(t))}`);
  };
  show(themeOf(store.get(THEME_KEY, '')));
  btn.addEventListener('click', () => {
    const t = themeNext(store.get(THEME_KEY, ''));
    if (t === 'auto') store.del(THEME_KEY); else store.set(THEME_KEY, t);
    applyTheme(t);
    show(t);
  });
}

// ---------- the owner's status line (daily run, seats.aero calls) ----------
const CRON_PART = { expiry: '哩程到期', deals: '好康', digest: '好康信', watches: '降價', alerts: '提醒' };
const CRON_MARK = { ok: '✓', some: '△', fail: '✗' };
// Taiwan date and time of an ISO stamp: ['2026-10-15', '08:12'].
const twParts = (iso) => { const s = new Date(Date.parse(iso) + 8 * 3600e3).toISOString(); return [s.slice(0, 10), s.slice(11, 16)]; };
// 「排程：今天 08:12、21:11 跑完（好康 ✓ 降價 ✓ 提醒 ✓）・seats.aero 今天已用 123／1,000 次」 from /api/cron/status.
function cronLine(st, now = Date.now()) {
  const [today] = twParts(new Date(now).toISOString());
  const [yesterday] = twParts(new Date(now - 864e5).toISOString());
  const dayWord = (d) => (d === today ? '今天' : d === yesterday ? '昨天' : `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`);
  const runs = (st.runs || []).filter((r) => r && r.at);
  if (!runs.length && st.lastDone) runs.push({ at: st.lastDone });
  const last = runs.at(-1);
  let run;
  if (!st.secret) run = '排程：還沒設定 CRON_SECRET，每日排程不會跑';
  else if (st.lastDenied && (!st.lastRun || st.lastDenied > st.lastRun)) run = `排程：${dayWord(twParts(st.lastDenied)[0])} ${twParts(st.lastDenied)[1]} 被擋下，請檢查 CRON_SECRET`;
  else if (!last) run = '排程：還沒有跑完的紀錄';
  else {
    const day = twParts(last.at)[0];
    const times = runs.filter((r) => twParts(r.at)[0] === day).map((r) => twParts(r.at)[1]);
    const parts = Object.entries(last.parts || {}).filter(([k, v]) => CRON_PART[k] && (k !== 'expiry' || v !== 'ok'));
    run = `排程：${dayWord(day)} ${times.join('、')} 跑完${parts.length ? `（${parts.map(([k, v]) => `${CRON_PART[k]} ${CRON_MARK[v] || v}`).join(' ')}）` : ''}`;
    // Started after the last finish and not done a few minutes later: cut off (Vercel's 60-second limit).
    if (st.lastRun && st.lastRun > last.at) run += now - Date.parse(st.lastRun) > 3 * 60e3 ? `，${twParts(st.lastRun)[1]} 那次沒跑完` : '，正在跑';
  }
  return `${run}・seats.aero 今天已用 ${fmt(st.callsTodayAll || 0)}／${fmt(st.dailyLimit || 1000)} 次`;
}
const cronState = { at: 0, busy: false };
async function renderCronLine() {
  const el = $('#cron-line');
  if (!el) return;
  const owner = typeof ownerHere === 'function' && ownerHere();
  // 帳號管理 also from here, so the owner needn't sign in to an account to reach it (the passcode is enough).
  const adm = $('#foot-admin');
  if (adm) adm.hidden = !owner || typeof admOpen !== 'function';
  if (!owner) { el.hidden = true; return; }
  if (cronState.busy || (!el.hidden && Date.now() - cronState.at < 60e3)) return;
  cronState.busy = true;
  try {
    const pass = store.get(PASS_KEY, '');
    const st = await api('/api/cron/status', { headers: pass ? { 'x-cash-pass': pass } : {} });
    el.textContent = cronLine(st);
    el.title = '△：有幾項失敗或留到下一次；✗：這部分沒跑成。seats.aero 每天早上 8 點（台灣時間）歸零，次數含訪客查詢和每日排程。';
    el.hidden = false;
    cronState.at = Date.now();
  } catch { el.hidden = true; } finally { cronState.busy = false; }
}
function mountCronLine() {
  $('#version-line')?.insertAdjacentHTML('afterend', '<p class="cron-line" id="cron-line" hidden></p><p class="cron-line"><button type="button" class="linkish" id="foot-admin" hidden>🗂️ 帳號管理</button></p>');
  $('#foot-admin')?.addEventListener('click', () => admOpen());
  whenReady().then(renderCronLine);
  // Follows the passcode and the account's unlock, like 今日好康's 立即更新.
  const base = updateLockHint;
  updateLockHint = function () { base(); renderCronLine(); };
}

mountTheme();
mountCronLine();
