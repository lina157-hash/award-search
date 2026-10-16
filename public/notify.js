// Round 6, alerts and notifications on the page:
// - U5 通知狀態: Telegram and LINE are set up in 帳號設定 only; 機位提醒, 降價追蹤 and 我的行程 show one line,
//   「通知：Email ✓｜Telegram ✓｜LINE —　設定」, whose 設定 opens it (a small dialog when no account is signed in).
// - N1 / N16: the alert form's optional part (最多 N 哩, 降哩也通知, 只要這些航班), for app.js alertFiltersHtml and
//   alertFilterValues, in the create dialog and in 修改.
// - N7 已開票「便宜了通知我」: a switch on each award leg of 我的行程 (features.js planHtml), kept on the server
//   (/api/booked, at most 5 legs) and checked by the daily run, one search per leg a day.
// Classic script after line.js; uses the globals of app.js, features.js and account.js ($, $$, esc, fmt, api, cashApi,
// store, toast, alertCfg, ALERT_EMAIL_KEY, ownerHere, tgRender, lineRender, openAuth, signedIn, acct, plan, renderPlan,
// programName, CABIN_LABEL, mmdd).

// ---------- U5: the status line ----------
const notifyCfg = { email: false, telegram: false, line: false, booked: false, at: 0, busy: false };
function notifyInit(config) {
  notifyRead(config);
  // Back from 帳號設定 or the small dialog: the line follows what was linked there.
  whenReady().then(() => $('#acct-dialog')?.addEventListener('close', () => notifyRefresh(true)));
  // 我的行程's switches are the owner's: drawn once the page knows, and again when the passcode comes or goes.
  let owner = null;
  const follow = () => { const now = ownerHere(); if (now !== owner) { owner = now; if (notifyCfg.booked) renderPlan(); } };
  const base = updateLockHint;
  updateLockHint = function () { base(); follow(); };
  follow();
}
function notifyRead(config) {
  Object.assign(notifyCfg, {
    email: Boolean(config.alerts?.email),
    telegram: Boolean(config.telegram?.linked),
    line: Boolean(config.line?.linked),
    booked: Boolean(config.booked),
    dealRules: Boolean(config.dealRules),
    at: Date.now(),
  });
}
const nfMark = (on, what) => `<b class="${on ? 'nf-on' : 'nf-off'}" aria-label="${what}${on ? '已設定' : '未設定'}">${on ? '✓' : '—'}</b>`;
const notifyInner = () => `通知：Email ${nfMark(notifyCfg.email, 'Email')}｜Telegram ${nfMark(notifyCfg.telegram, 'Telegram')}｜LINE ${nfMark(notifyCfg.line, 'LINE')}　<button type="button" class="linkish" data-nf-set>設定</button>`;
// The line itself, drawn from what the page knows now; a fresh look follows in the background.
function notifyLineHtml() {
  notifyRefresh();
  return `<p class="nf-status">${notifyInner()}</p>`;
}
async function notifyRefresh(force = false) {
  if (notifyCfg.busy || (!force && Date.now() - notifyCfg.at < 30e3)) return;
  notifyCfg.busy = true;
  try {
    notifyRead(await api('/api/config'));
    $$('.nf-status').forEach((p) => { p.innerHTML = notifyInner(); });
  } catch { /* the line keeps what it showed */ } finally { notifyCfg.busy = false; }
}
document.addEventListener('click', (e) => { if (e.target.closest('[data-nf-set]')) openNotifySettings(); });

// 設定: 帳號設定 when an account is signed in here; otherwise the same two boxes (passcode-gated, not account-gated).
function openNotifySettings() {
  if (typeof acct !== 'undefined' && acct.configured && signedIn()) {
    openAuth('settings');
    requestAnimationFrame(() => $('#tg-h')?.scrollIntoView({ block: 'start' }));
    return;
  }
  let dlg = $('#nf-dialog');
  if (!dlg) {
    document.body.insertAdjacentHTML('beforeend', `<dialog id="nf-dialog" class="pass acct-dlg" aria-labelledby="nf-title">
      <button type="button" class="ghost acct-x" aria-label="關閉">✕</button>
      <div class="pass-in"><h2 id="nf-title">通知設定</h2><p class="hint">機位提醒、降價追蹤、已開票追蹤和我的條件通知，都會傳到這裡連結的 Telegram／LINE。登入帳號後，在「帳號設定」也找得到。</p>
      <section class="acct-sec"><h3>📨 Telegram</h3><div class="tg-box" id="nf-tg"></div></section>
      <section class="acct-sec"><h3>💬 LINE</h3><div class="tg-box" id="nf-line"></div></section></div></dialog>`);
    dlg = $('#nf-dialog');
    $('.acct-x', dlg).addEventListener('click', () => dlg.close());
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
    dlg.addEventListener('close', () => notifyRefresh(true));
  }
  tgRender($('#nf-tg'));
  if (typeof lineRender === 'function') lineRender($('#nf-line'));
  dlg.showModal();
  $('.acct-x', dlg).focus();
}

// ---------- N1 / N16: the alert form's optional part ----------
function alertExtraHtml(a) {
  const open = Boolean(a?.maxMiles || a?.drops || a?.flights?.length);
  return `<details class="alert-pick alert-more"${open ? ' open' : ''}><summary>哩數上限、降價、指定航班 <small class="muted">（選填）</small></summary>
    <label class="field">最多幾哩（每人單程，不填＝不限）<input name="maxMiles" inputmode="numeric" placeholder="例如 80000" value="${esc(a?.maxMiles || '')}" autocomplete="off"></label>
    <label class="switch"><input type="checkbox" name="drops" ${a?.drops ? 'checked' : ''}><span class="knob"></span>降哩也通知（看過的位子便宜 5% 以上時，寫出原本和現在幾哩）</label>
    <label class="field">只要這些航班（不填＝全部）<input name="flights" value="${esc((a?.flights || []).join(', '))}" placeholder="BR16, JX12" autocomplete="off" autocapitalize="characters"></label>
    <p class="hint">指定航班：45 天內的日期直接比對；更遠的日期，每天最多再查 5 筆航班明細（用 0–5 次查詢）。同一個價格只通知一次。</p>
  </details>`;
}
// 「8萬」 or 「80,000」 → 80000; anything else goes as typed, for the server to refuse with a reason.
function alertExtraValues(f) {
  const cap = String(f.maxMiles?.value || '').replace(/[\s,，]/g, '');
  const wan = /^(\d+(?:\.\d+)?)萬$/.exec(cap);
  return { maxMiles: wan ? Math.round(Number(wan[1]) * 1e4) : cap, drops: Boolean(f.drops?.checked), flights: String(f.flights?.value || '') };
}

// ---------- N7: 已開票「便宜了通知我」 in 我的行程 ----------
const bkState = { legs: [], max: 5, loaded: false, busy: false };
const bkSame = (s, l) => s.date === l.date && s.from === l.from && s.to === l.to && s.program === l.program && s.cabin === l.cabin;
const bkFind = (l) => bkState.legs.find((s) => bkSame(s, l));
const bkOk = (l) => l.k === 'a' && l.program && l.miles && l.date >= isoDate(0);
async function bookedLoad() {
  if (bkState.busy || !notifyCfg.booked || !ownerHere()) return;
  bkState.busy = true;
  try {
    const r = await cashApi('/api/booked', { pass: '已開票追蹤' });
    Object.assign(bkState, { legs: r.legs || [], max: r.max || 5, loaded: true });
    renderPlan();
  } catch { bkState.loaded = true; } finally { bkState.busy = false; }
}
// The switch under an award leg's miles (features.js planHtml, editable plan only).
function bookedToggleHtml(l, i) {
  if (!bkOk(l) || !notifyCfg.booked || !ownerHere()) return '';
  if (!bkState.loaded) { bookedLoad(); return ''; }
  const on = bkFind(l);
  const last = !on ? '' : on.lastRun ? (on.lastMiles ? `上次查 ${fmt(on.lastMiles)} 哩${on.lastMiles < l.miles ? '，比你付的便宜' : ''}` : '上次查：沒有這班的位子') : '明天早上第一次檢查';
  return `<label class="chk bk-tog"><input type="checkbox" data-bk="${i}" ${on ? 'checked' : ''}><span>已開票，便宜了通知我</span></label>${last ? `<small class="bk-last">${esc(last)}</small>` : ''}`;
}
// Under the plan: how many legs are watched, what it costs, and where the news goes.
function bookedFootHtml() {
  if (!notifyCfg.booked || !ownerHere() || !plan.legs.some(bkOk)) return '';
  const n = plan.legs.filter((l) => bkOk(l) && bkFind(l)).length;
  return `<div class="bk-foot"><p class="hint">已開票追蹤 ${n}／${bkState.max} 段：每天早上查一次同一天、同計畫、同艙等（有航班號碼就查同一班），每段每天用 1 次查詢。比你付的少 1,000 哩以上才通知，附上這個計畫的退票、改票費。</p>${notifyLineHtml()}</div>`;
}
function bookedBind(host) {
  $$('[data-bk]', host).forEach((b) => b.addEventListener('change', async () => {
    const l = plan.legs[Number(b.dataset.bk)];
    if (!l) return;
    b.disabled = true;
    try {
      const cur = bkFind(l);
      if (b.checked && !cur) {
        await cashApi('/api/booked', { pass: '已開票追蹤', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ date: l.date, from: l.from, to: l.to, cabin: l.cabin, program: l.program, miles: l.miles, pax: l.pax, flights: l.flights, email: store.get(ALERT_EMAIL_KEY, '') }) });
        toast('已開始追蹤：每天早上查一次（用 1 次查詢），便宜了會通知你');
      } else if (!b.checked && cur) {
        await cashApi(`/api/booked?id=${encodeURIComponent(cur.id)}`, { pass: '已開票追蹤', method: 'DELETE' });
        toast('已停止追蹤這段');
      }
      bkState.loaded = false;
      await bookedLoad();
    } catch (err) {
      b.checked = !b.checked;
      b.disabled = false;
      toast(err.message);
    }
  }));
}
