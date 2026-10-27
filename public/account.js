// Optional accounts (email + password): the header button and menu, the sign-in / sign-up / reset dialogs, account
// settings, carrying this device's own settings (favourites, recent searches, wallet, plan…) between devices, and the
// Telegram link panel. Nothing else needs an account: signed out, everything works exactly as before.
// Classic script loaded last; uses the globals of app.js, features.js and hotels.js (store, toast, cashApi, $…).

// localStorage keys carried by the account. The passcode (cashPass) never leaves the device.
// passport:v1 is 我的行程's passport expiry (trips.js); points6.js adds family members, vouchers, 已登記, the redemption
// ledger and the expiry suggestions.
const SYNC_KEYS = ['favSearches', 'recentSearches', 'wallet:v1', 'plan:v1', 'cashSeen:v1', 'hotelSearch:v1', 'alertEmail', 'mileCost:v1', 'passport:v1', ...(typeof P6_SYNC_KEYS !== 'undefined' ? P6_SYNC_KEYS : [])];
// What this device last agreed with the server: { email, joined, rev, base, syncedAt }.
const ACCT_SYNC = 'acct:sync';
const acct = { configured: false, emailEnabled: false, status: null, syncing: false, syncErr: '', timer: 0, conflicts: 0, lockFlipped: false, lastPull: 0, pending: false };

// ---------- small helpers ----------
// fetch with the session cookie; errors keep their body (a sync conflict carries the server's copy).
async function acctCall(path, method = 'GET', body, headers = {}) {
  let res;
  try {
    res = await fetch(path, { method, credentials: 'same-origin', headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  } catch {
    throw Object.assign(new Error('連不上伺服器，請檢查網路後再試。'), { code: 'offline' });
  }
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(out.error || (typeof httpWords === 'function' ? httpWords(res.status) : `HTTP ${res.status}`)), { code: out.code, status: res.status, body: out });
  return out;
}
// JSON with sorted keys, so two copies of the same data compare equal whatever order they were built in.
const stable = (v) => (Array.isArray(v) ? `[${v.map(stable).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}` : JSON.stringify(v ?? null));
const same = (a, b) => stable(a) === stable(b);
const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
// Storage writes made by this file go around the change watcher below.
const rawSet = store.set.bind(store);
const rawDel = store.del.bind(store);
const whenReady = () => new Promise((resolve) => { const t = () => (dataReady ? resolve() : setTimeout(t, 120)); t(); });
const signedIn = () => Boolean(acct.status?.loggedIn);
// Menu items other files add (admin.js): { m, label, show(), run() }, listed above 登出 while show() is true.
const ACCT_MENU_EXTRA = [];

// ---------- merging two copies of the synced keys ----------
// `base` is the copy both sides started from (null on a device's first sync): with it, something removed on one side
// stays removed; without it, lists are joined and the account's value wins for single values.
function interleave(a, b) {
  const out = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) { if (i < a.length) out.push(a[i]); if (i < b.length) out.push(b[i]); }
  return [...new Set(out)];
}
const goneFrom = (b, l, r, idOf = (x) => x) => new Set(b.map(idOf).filter((id) => !l.map(idOf).includes(id) || !r.map(idOf).includes(id)));
const legId = (l) => [l.k, l.date, l.from, l.to, l.flights, l.cabin, l.pax, l.price ?? '', l.miles ?? ''].join('|');
const legsOf = (p) => (Array.isArray(obj(p).legs) ? obj(p).legs.filter((x) => x && typeof x === 'object') : []);
const MERGE = {
  // Favourites are kept oldest first (app.js appends), at most 12.
  favSearches(l, r, b) {
    const gone = goneFrom(arr(b), arr(l), arr(r));
    return [...new Set([...arr(r), ...arr(l)])].filter((k) => !gone.has(k)).slice(-12);
  },
  // Recent searches are newest first, at most 8; with no times saved, the two lists are interleaved.
  recentSearches(l, r, b) {
    const gone = goneFrom(arr(b), arr(l), arr(r));
    return interleave(arr(l), arr(r)).filter((k) => !gone.has(k)).slice(0, 8);
  },
  // Per program: the side that changed it since the base, else the account's number; the device adds what's missing.
  'wallet:v1'(l, r, b, hasBase) {
    const out = {};
    // expiry: the dates entered for miles balances (ewallet.js), merged per program like the balances.
    for (const bucket of ['banks', 'miles', 'hotels', 'expiry']) {
      const L = obj(obj(l)[bucket]);
      const R = obj(obj(r)[bucket]);
      const B = obj(obj(b)[bucket]);
      const o = {};
      for (const f of new Set([...Object.keys(L), ...Object.keys(R), ...Object.keys(B)])) {
        const v = hasBase ? (L[f] !== B[f] ? L[f] : R[f]) : R[f] ?? L[f];
        if (v) o[f] = v;
      }
      out[bucket] = o;
    }
    return Object.values(out).some((o) => Object.keys(o).length) ? out : undefined;
  },
  // Legs joined by their content (they carry no id), sorted by date, at most 12.
  'plan:v1'(l, r, b, hasBase) {
    const gone = goneFrom(legsOf(b), legsOf(l), legsOf(r), legId);
    const seen = new Set();
    // A leg on both sides keeps the copy this device changed since the base (its 訂位進度, times…), else the account's.
    const base = new Map(legsOf(b).map((x) => [legId(x), stable(x)]));
    const mine = new Map(legsOf(l).filter((x) => hasBase && base.has(legId(x)) && base.get(legId(x)) !== stable(x)).map((x) => [legId(x), x]));
    const legs = [...legsOf(r), ...legsOf(l)].filter((x) => { const id = legId(x); if (seen.has(id) || gone.has(id)) return false; seen.add(id); return true; }).map((x) => mine.get(legId(x)) || x);
    legs.sort((x, y) => String(x.date).localeCompare(String(y.date)));
    const name = hasBase && obj(l).name !== obj(b).name ? obj(l).name : obj(r).name || obj(l).name;
    return { name: name || '我的行程', legs: legs.slice(0, 12) };
  },
  // Fares seen: everything from both sides, the newer one per route and day; old entries dropped.
  'cashSeen:v1'(l, r) {
    const cutoff = Date.now() - 3 * 864e5;
    const out = {};
    for (const [k, v] of [...Object.entries(obj(r)), ...Object.entries(obj(l))]) if (v?.at > cutoff && (!out[k] || v.at > out[k].at)) out[k] = v;
    return out;
  },
  alertEmail: (l, r, b, hasBase) => (hasBase ? l : typeof r === 'string' && r ? r : l),
  ...(typeof P6_MERGE !== 'undefined' ? P6_MERGE : {}),
};
// Single values (hotelSearch:v1 and anything new): the account's value on a first sync, else this device's newer edit.
const keepOne = (l, r, b, hasBase) => (hasBase ? l : r !== undefined ? r : l);
function mergeAll(local, remote, base) {
  const out = {};
  for (const k of new Set([...SYNC_KEYS, ...Object.keys(remote)])) {
    // Keys written by a newer version of the site are passed along untouched.
    if (!SYNC_KEYS.includes(k)) { out[k] = remote[k]; continue; }
    const L = local[k];
    const R = remote[k];
    const B = base ? base[k] : undefined;
    let v;
    if (base && same(L, B)) v = R;
    else if (base && same(R, B)) v = L;
    else if (L === undefined && R === undefined) v = undefined;
    else v = (MERGE[k] || keepOne)(L, R, B, Boolean(base));
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// ---------- this device's copy ----------
function snapshot() {
  const o = {};
  for (const k of SYNC_KEYS) { const v = store.get(k, undefined); if (v != null) o[k] = v; }
  return o;
}
const syncInfo = () => obj(store.get(ACCT_SYNC, null));
const saveInfo = (x) => rawSet(ACCT_SYNC, x);
// Write a merged copy into localStorage and refresh what shows it.
function applyData(data) {
  const now = snapshot();
  const changed = SYNC_KEYS.filter((k) => !same(now[k], data[k]));
  for (const k of changed) if (data[k] === undefined) rawDel(k); else rawSet(k, data[k]);
  if (changed.length) refreshViews(changed);
}
function refreshViews(keys) {
  const has = (k) => keys.includes(k);
  if (has('favSearches') || has('recentSearches')) { renderMine(); renderSearchFav(); }
  if (has('wallet:v1')) {
    wallet = loadWallet();
    // Not while someone is typing a number into it.
    if (tabDone.has('points') && !$('#points-page')?.contains(document.activeElement)) renderPoints();
    if (currentTab === 'map') syncRmap(); // otherwise when the tab is next shown
  }
  if (has('plan:v1')) { plan = cleanPlan(store.get(PLAN_KEY, null)); if (typeof tripRemindSync === 'function') tripRemindSync(); renderPlan(); }
  if (has('passport:v1') && typeof tpSavePassport === 'function') { $$('li.ti-passport').forEach(tpFillPassport); renderPlan(); }
  if (has('cashSeen:v1')) cashSeen = loadCashSeen();
  if (typeof P6_SYNC_KEYS !== 'undefined' && keys.some((k) => P6_SYNC_KEYS.includes(k))) p6Refresh();
  // hotelSearch:v1 and alertEmail are read when their form opens.
}
// What the merge dialog lists: only the things people would miss.
function deviceSummary(d) {
  const lines = [];
  const favs = arr(d.favSearches);
  const recent = arr(d.recentSearches).filter((k) => !favs.includes(k));
  const route = (q) => { const p = new URLSearchParams(q); return `${p.get('o')} → ${p.get('d')}`; };
  if (favs.length) lines.push(`常用航線 ${favs.length} 條（${favs.slice(0, 2).map(route).join('、')}${favs.length > 2 ? '…' : ''}）`);
  if (recent.length) lines.push(`最近搜尋 ${recent.length} 筆`);
  const w = obj(d['wallet:v1']);
  const items = [['b', 'banks', '點'], ['m', 'miles', '哩'], ['h', 'hotels', '點']].flatMap(([kind, bucket, unit]) => Object.entries(obj(w[bucket])).map(([id, n]) => {
    const label = typeof walletItemName === 'function' ? walletItemName(kind, id) : null;
    return `${label?.name || id} ${fmt(n)} ${unit}`;
  }));
  if (items.length) lines.push(`我的點數：${items.slice(0, 3).join('、')}${items.length > 3 ? ` 等 ${items.length} 項` : ''}`);
  const legs = legsOf(d['plan:v1']);
  if (legs.length) lines.push(`我的行程「${obj(d['plan:v1']).name || '我的行程'}」${legs.length} 段`);
  return lines;
}

// ---------- sync with the server ----------
function schedulePush(ms = 2000) {
  clearTimeout(acct.timer);
  acct.pending = true;
  acct.timer = setTimeout(push, ms);
}
// Every app write to a synced key goes through store.set / store.del: watch those.
store.set = (key, value) => {
  rawSet(key, value);
  if (SYNC_KEYS.includes(key)) schedulePush();
  if (key === PASS_KEY && value && signedIn()) unlockAccount(value);
};
store.del = (key) => { rawDel(key); if (SYNC_KEYS.includes(key)) schedulePush(); };

// This device's copy, plus keys a newer version of the site saved in the account (kept as they are).
const outgoing = (info) => ({ ...Object.fromEntries(Object.entries(obj(info.base)).filter(([k]) => !SYNC_KEYS.includes(k))), ...snapshot() });
const joinedHere = () => { const i = syncInfo(); return signedIn() && i.joined && i.email === acct.status.email; };
async function push() {
  clearTimeout(acct.timer);
  acct.pending = false;
  if (!joinedHere() || acct.syncing) { if (acct.syncing) schedulePush(1500); return; }
  const info = syncInfo();
  const data = outgoing(info);
  if (same(data, info.base)) return;
  acct.syncing = true;
  renderSync();
  let newer = null;
  try {
    const r = await acctCall('/api/account/data', 'PUT', { data, rev: info.rev || 0 });
    saveInfo({ ...info, rev: r.rev, base: data, syncedAt: r.syncedAt });
    acct.syncErr = '';
    acct.conflicts = 0;
  } catch (e) {
    if (e.code === 'conflict' && acct.conflicts++ < 3) newer = e.body;
    else if (e.code === 'login-required') signedOutHere('登入已過期，請重新登入，這台裝置上的資料都還在。');
    else {
      acct.syncErr = e.code === 'busy' || e.code === 'offline' || e.code === 'conflict' || e.status >= 500 ? '暫時無法同步，稍後會自動再試' : e.message;
      acct.conflicts = 0;
      if (e.status !== 400 && e.status !== 413) schedulePush(e.code === 'busy' ? 4000 : 30000);
    }
  } finally {
    acct.syncing = false;
    renderSync();
  }
  // Another device saved first: merge its copy in and save again.
  if (newer) await reconcile(newer);
}
// The server has a newer copy: merge it with this device's changes since the last agreed copy, then save.
async function reconcile(remote) {
  const info = syncInfo();
  const rData = obj(remote?.data);
  const merged = mergeAll(snapshot(), rData, info.joined ? obj(info.base) : null);
  applyData(merged);
  saveInfo({ ...info, rev: remote.rev || 0, base: rData, syncedAt: remote.syncedAt || null });
  if (!same(merged, rData)) await push();
  else renderSync();
}
// Look for changes from other devices (on load, and when the page comes back to the front).
async function pull() {
  if (!joinedHere()) return;
  acct.lastPull = Date.now();
  try {
    const remote = await acctCall('/api/account/data');
    const info = syncInfo();
    if (remote.rev !== info.rev) await reconcile(remote);
    else if (!same(snapshot(), Object.fromEntries(SYNC_KEYS.filter((k) => obj(info.base)[k] !== undefined).map((k) => [k, info.base[k]])))) await push();
    if (remote.syncedAt && !syncInfo().syncedAt) saveInfo({ ...syncInfo(), syncedAt: remote.syncedAt });
    acct.syncErr = '';
  } catch (e) {
    if (e.code === 'login-required') return signedOutHere('登入已過期，請重新登入，這台裝置上的資料都還在。');
    acct.syncErr = '暫時無法同步，稍後會自動再試';
  }
  renderSync();
}
// First sync of this device with this account: ask before putting the device's own data into the account.
async function firstSync({ ask }) {
  await whenReady();
  const email = acct.status.email;
  const info = syncInfo();
  if (info.email === email && info.joined) return pull();
  let remote;
  try { remote = await acctCall('/api/account/data'); } catch (e) { acct.syncErr = e.message; renderSync(); return; }
  const local = snapshot();
  const rData = obj(remote.data);
  const merged = mergeAll(local, rData, null);
  // Does the device hold anything the account doesn't have yet?
  const adds = ['favSearches', 'recentSearches', 'wallet:v1', 'plan:v1'].some((k) => local[k] !== undefined && !same(merged[k], rData[k]));
  const join = async () => {
    saveInfo({ email, joined: true, rev: remote.rev || 0, base: rData, syncedAt: remote.syncedAt || null });
    applyData(merged);
    await push();
    renderSync();
  };
  if (!adds) return join();
  if (!ask) { saveInfo({ email, joined: false }); renderSync(); return; }
  openMerge(local, Object.keys(rData).length > 0, join, () => { saveInfo({ email, joined: false }); renderSync(); toast('這台裝置的資料先不同步，之後可以在帳號選單合併'); });
}
// Send a write that's still waiting when the page closes.
addEventListener('pagehide', () => {
  if (!acct.pending || !joinedHere()) return;
  const info = syncInfo();
  const data = outgoing(info);
  if (same(data, info.base)) return;
  try { fetch('/api/account/data', { method: 'PUT', keepalive: true, credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data, rev: info.rev || 0 }) }); } catch { /* best effort */ }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && joinedHere() && Date.now() - acct.lastPull > 60e3) pull();
  if (document.visibilityState === 'hidden' && acct.pending) push();
});

// ---------- passcode unlock that follows the account ----------
async function unlockAccount(pass) {
  const was = acct.status?.unlocked;
  try {
    const s = await acctCall('/api/account/unlock', 'POST', {}, { 'x-cash-pass': pass });
    if (s.loggedIn) acct.status = { ...acct.status, ...s };
    if (!was && s.unlocked) toast('已記在帳號：其他登入的裝置不用再輸入通關密碼');
  } catch { /* wrong passcode: the cash request itself will say so */ }
}
// A signed-in account that entered the passcode before needs none on this device: the server takes the session.
async function applyUnlock() {
  await whenReady();
  const on = signedIn() && acct.status.unlocked;
  if (on && cashCfg.locked && !store.get(PASS_KEY, '')) { cashCfg.locked = false; acct.lockFlipped = true; }
  else if (!on && acct.lockFlipped) { cashCfg.locked = true; acct.lockFlipped = false; }
  updateLockHint();
}
// 帳號管理 (admin.js) is fetched only on the owner's device; siteopts.js then shows its footer link too.
const loadAdmin = () => loadScripts(['admin']).then(([ok]) => { if (ok && typeof renderCronLine === 'function') renderCronLine(); });
const baseLockHint = updateLockHint;
updateLockHint = function () {
  baseLockHint();
  if (ownerHere()) loadAdmin();
  if (ownerHere() && typeof loadOwnerScripts === 'function') loadOwnerScripts(); // 哪裡都好, 我的條件通知, 一句話搜尋 (app.js)
  if (!acct.lockFlipped || cashCfg.locked) return;
  const el = $('#cash-lock');
  el.hidden = false;
  el.textContent = '🔓 你的帳號已解鎖即時查價，這台裝置不用輸入通關密碼。';
};

// ---------- header button and menu ----------
function mountHeader() {
  const inner = $('.top-inner');
  // index.html carries the button already (so the header doesn't shift); older pages get it inserted here.
  if (!$('#acct')) inner.insertAdjacentHTML('beforeend', `<div class="acct" id="acct" hidden>
    <button type="button" class="acct-btn" id="acct-btn" aria-haspopup="dialog">👤 登入</button>
    <div class="acct-menu" id="acct-menu" role="menu" aria-labelledby="acct-btn" hidden></div>
  </div>`);
  $('#acct-btn').addEventListener('click', () => (signedIn() ? toggleMenu() : openAuth('login')));
  $('#acct-btn').addEventListener('keydown', (e) => { if (signedIn() && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); toggleMenu(true); } });
  document.addEventListener('click', (e) => { if (!$('#acct-menu').hidden && !e.target.closest('#acct')) toggleMenu(false); });
  $('#acct-menu').addEventListener('keydown', (e) => {
    const items = $$('[role=menuitem]', $('#acct-menu'));
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); toggleMenu(false); $('#acct-btn').focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); items[e.key === 'Home' ? 0 : items.length - 1].focus(); }
    else if (e.key === 'Tab') toggleMenu(false);
  });
}
function renderHeader() {
  const box = $('#acct');
  if (!box) return;
  box.hidden = !acct.configured;
  const b = $('#acct-btn');
  if (signedIn()) {
    const name = acct.status.name || acct.status.email;
    b.innerHTML = `<span class="av" aria-hidden="true">${esc(name.slice(0, 1).toUpperCase())}</span><span class="nm">${esc(name)}</span><span aria-hidden="true">▾</span>`;
    b.setAttribute('aria-haspopup', 'menu');
    b.setAttribute('aria-expanded', String(!$('#acct-menu').hidden));
    b.setAttribute('aria-label', `帳號：${name}`);
  } else {
    b.innerHTML = '<span aria-hidden="true">👤</span><span class="acct-txt">登入</span>';
    b.setAttribute('aria-haspopup', 'dialog');
    b.removeAttribute('aria-expanded');
    b.removeAttribute('aria-label');
    toggleMenu(false);
  }
}
function syncLine() {
  const info = syncInfo();
  if (!joinedHere()) return '<div class="sync paused">☁️ 這台裝置的資料還沒存進帳號 <button type="button" class="linklike" role="menuitem" data-m="merge">合併到帳號</button></div>';
  if (acct.syncing) return '<div class="sync">☁️ 同步中…</div>';
  if (acct.syncErr) return `<div class="sync warn">⚠️ ${esc(acct.syncErr)}</div>`;
  const dev = acct.status.devices > 1 ? `（${acct.status.devices} 台裝置）` : '';
  return `<div class="sync">☁️ 已同步・${info.syncedAt ? esc(ago(info.syncedAt)) : '剛剛'}${dev}</div>`;
}
function renderSync() {
  renderHeader();
  const m = $('#acct-menu');
  if (!m || m.hidden || !signedIn()) return;
  const s = $('.sync', m);
  if (s && !s.contains(document.activeElement)) s.outerHTML = syncLine();
}
function toggleMenu(open = $('#acct-menu').hidden) {
  const m = $('#acct-menu');
  if (!m) return;
  if (open && signedIn()) {
    const st = acct.status;
    m.innerHTML = `<div class="who"><b>${esc(st.name || st.email)}</b><small>${esc(st.email)}</small></div>${syncLine()}
      <button type="button" role="menuitem" data-m="wallet">💳 我的點數</button>
      <button type="button" role="menuitem" data-m="mine">⭐ 常用航線與最近搜尋</button>
      <button type="button" role="menuitem" data-m="plan">🧳 我的行程</button>
      <button type="button" role="menuitem" data-m="alerts">🔔 機位提醒與降價追蹤</button>
      <button type="button" role="menuitem" data-m="settings">⚙️ 帳號設定（改密碼、Telegram）</button>
      ${ACCT_MENU_EXTRA.filter((x) => x.show()).map((x) => `<button type="button" role="menuitem" data-m="${x.m}">${x.label}</button>`).join('')}
      <button type="button" role="menuitem" data-m="logout" class="out">登出</button>`;
    m.hidden = false;
    $$('[data-m]', m).forEach((x) => x.addEventListener('click', () => menuAction(x.dataset.m)));
    $('[role=menuitem]', m).focus({ preventScroll: true });
  } else m.hidden = true;
  $('#acct-btn')?.setAttribute('aria-expanded', String(!m.hidden));
}
// Open a panel on the search tab and bring it into view.
function showPanel(id, tab = 'search') {
  showTab(tab);
  const el = $(`#${id}`);
  if (!el) return;
  el.hidden = false; // 我的行程 stays hidden until it has a leg
  if (el.tagName === 'DETAILS') el.open = true;
  requestAnimationFrame(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}
async function menuAction(what) {
  toggleMenu(false);
  if (what === 'wallet') openWallet();
  else if (what === 'mine') {
    if (!$('#mine').innerHTML.trim()) toast('還沒有常用航線或最近搜尋，搜尋一條航線就會出現在搜尋框下方');
    showPanel('mine');
  } else if (what === 'plan') showPanel('plan-panel');
  else if (what === 'alerts') showPanel('alerts-panel');
  else if (what === 'settings') openAuth('settings');
  else if (what === 'merge') { saveInfo({ email: acct.status.email, joined: false }); firstSync({ ask: true }); }
  else if (what === 'logout') {
    if (acct.pending) await push();
    try { await acctCall('/api/account/logout', 'POST', {}); } catch { /* the cookie is cleared below either way */ }
    signedOutHere('已登出。這台裝置上的資料都還在。');
  } else ACCT_MENU_EXTRA.find((x) => x.m === what)?.run();
}
function signedOutHere(msg) {
  clearTimeout(acct.timer);
  acct.pending = false;
  acct.status = { loggedIn: false };
  acct.syncErr = '';
  renderHeader();
  applyUnlock();
  if (msg) toast(msg);
}
async function signedInHere(status, { ask }) {
  acct.status = status;
  renderHeader();
  applyUnlock();
  // This device remembers the passcode: let the account carry the unlock to the others.
  const pass = store.get(PASS_KEY, '');
  if (pass && !status.unlocked) unlockAccount(pass).then(applyUnlock);
  await firstSync({ ask });
}

// ---------- dialogs ----------
function mountDialog() {
  document.body.insertAdjacentHTML('beforeend', `<dialog id="acct-dialog" class="pass acct-dlg" aria-labelledby="acct-title">
    <button type="button" class="ghost acct-x" aria-label="關閉">✕</button><div id="acct-body"></div></dialog>`);
  const dlg = $('#acct-dialog');
  $('.acct-x', dlg).addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  // Tab wraps around inside the dialog instead of leaving for the browser's own controls.
  dlg.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const items = $$('button, input, select, a[href], summary', dlg).filter((x) => !x.disabled && x.checkVisibility?.() !== false);
    const [first, last] = [items[0], items.at(-1)];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  // close() fires its event a task later; a dialog already reopened (login → merge) ignores the stale one.
  dlg.addEventListener('close', () => { if (!dlg.open && acct.onClose) { const f = acct.onClose; acct.onClose = null; f(); } });
}
const pwOk = (s) => s.length >= 8;
const ACCT_ERR = { rate: '嘗試太多次，請 15 分鐘後再試', origin: '請直接從網站操作' };
const errOf = (e, map = {}) => map[e.code] || ACCT_ERR[e.code] || e.message;
function showErr(form, msg, extra = '') {
  const p = $('.acct-err', form);
  p.innerHTML = `${esc(msg)}${extra}`;
  p.hidden = !msg;
}
const why = () => `<p class="why">登入是為了<b>同步你的資料</b>：我的點數、常用航線、最近搜尋、我的行程和通知信箱會存在雲端，換手機或電腦登入就會看到同樣的資料。不登入也能用全部功能。</p>
  <p class="hint">「通關密碼」是另一回事：只用來解鎖會用付費額度的即時查價（現金票價、雅高），一般訪客不需要。登入後輸入過一次，其他登入的裝置就不用再輸入（密碼本身不會上傳）。</p>`;
const tabsHtml = (on) => `<div class="auth-tabs" role="tablist" aria-label="登入或註冊">${[['login', '登入'], ['signup', '註冊']].map(([k, l]) => `<button type="button" role="tab" aria-selected="${k === on}" data-view="${k}">${l}</button>`).join('')}</div>`;

// view: login | signup | sent | forgot | forgot-sent | reset | settings | message
function openAuth(view, opt = {}) {
  const dlg = $('#acct-dialog');
  const body = $('#acct-body');
  const email = opt.email ?? acct.lastEmail ?? '';
  const V = {
    login: () => `<form class="pass-in" novalidate>${tabsHtml('login')}<h2 id="acct-title" class="sr-only">登入</h2>
      ${opt.notice ? `<p class="acct-ok" role="status">${esc(opt.notice)}</p>` : ''}
      <label>Email<input type="email" name="email" autocomplete="username" inputmode="email" required value="${esc(email)}"></label>
      <label>密碼<input type="password" name="password" autocomplete="current-password" required></label>
      <div class="row"><label class="chk"><input type="checkbox" name="remember" checked>這台裝置保持登入</label><button type="button" class="linklike" data-view="forgot">忘記密碼？</button></div>
      <p class="acct-err" role="alert" hidden></p>
      <button type="submit" class="primary full">登入</button>${why()}</form>`,
    signup: () => `<form class="pass-in" novalidate>${tabsHtml('signup')}<h2 id="acct-title" class="sr-only">註冊</h2>
      <label>Email<input type="email" name="email" autocomplete="email" inputmode="email" required value="${esc(email)}"></label>
      <label>密碼（至少 8 個字）<input type="password" name="password" autocomplete="new-password" minlength="8" required></label>
      <label>再輸入一次密碼<input type="password" name="password2" autocomplete="new-password" minlength="8" required></label>
      <p class="acct-err" role="alert" hidden></p>
      <button type="submit" class="primary full">建立帳號</button>
      <p class="hint">${acct.emailEnabled ? '我們會寄一封確認信到這個 Email，點信裡的連結就完成註冊。' : '網站沒有設定寄信服務，帳號建立後就能直接登入。'}</p>${why()}</form>`,
    sent: () => `<form class="pass-in"><p class="ok-big" aria-hidden="true">📮</p><h2 id="acct-title" class="center">確認信已寄出</h2>
      <p class="hint center">請到 <b>${esc(email)}</b> 收信，點信裡的連結完成註冊（24 小時內有效）。沒看到的話，請找找垃圾郵件。</p>
      <p class="acct-err" role="alert" hidden></p>
      <button type="submit" class="primary full">知道了</button></form>`,
    forgot: () => `<form class="pass-in" novalidate><h2 id="acct-title">忘記密碼</h2>
      <p class="hint">${acct.emailEnabled ? '輸入註冊用的 Email，我們會寄一封重設密碼的信給你。' : '網站沒有設定寄信服務，沒辦法寄重設密碼的信。請網站主人在 Vercel 設定 RESEND_API_KEY。'}</p>
      <label>Email<input type="email" name="email" autocomplete="username" inputmode="email" required value="${esc(email)}"></label>
      <p class="acct-err" role="alert" hidden></p>
      <div class="pass-actions"><button type="button" class="outline" data-view="login">回到登入</button><button type="submit" class="primary small" ${acct.emailEnabled ? '' : 'disabled'}>寄出重設信</button></div></form>`,
    'forgot-sent': () => `<form class="pass-in"><p class="ok-big" aria-hidden="true">📮</p><h2 id="acct-title" class="center">重設密碼的信已寄出</h2>
      <p class="hint center">請到 <b>${esc(email)}</b> 收信，點信裡的連結設定新密碼。連結 30 分鐘內有效。（如果這個 Email 沒有註冊過，就不會收到信。）</p>
      <button type="submit" class="primary full">知道了</button></form>`,
    reset: () => `<form class="pass-in" novalidate><h2 id="acct-title">設定新密碼</h2>
      <label>新密碼（至少 8 個字）<input type="password" name="password" autocomplete="new-password" minlength="8" required></label>
      <label>再輸入一次<input type="password" name="password2" autocomplete="new-password" minlength="8" required></label>
      <p class="acct-err" role="alert" hidden></p>
      <button type="submit" class="primary full">更新密碼</button><p class="hint">更新後，所有裝置都要用新密碼重新登入。</p></form>`,
    message: () => `<form class="pass-in"><p class="ok-big" aria-hidden="true">${opt.icon || '⚠️'}</p><h2 id="acct-title" class="center">${esc(opt.title)}</h2>
      <p class="hint center">${esc(opt.text)}</p><button type="submit" class="primary full">${esc(opt.button || '知道了')}</button></form>`,
    settings: () => settingsHtml(),
  };
  body.innerHTML = V[view]();
  const form = $('form', body);
  $$('[data-view]', body).forEach((b) => b.addEventListener('click', () => openAuth(b.dataset.view, { email: form.email?.value ?? email })));
  // Arrow keys move between the 登入 / 註冊 tabs.
  $$('[role=tab]', body).forEach((t) => t.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const next = t.dataset.view === 'login' ? 'signup' : 'login';
    openAuth(next, { email: form.email?.value ?? email });
    $(`[data-view="${next}"]`, body)?.focus();
  }));
  BIND[view]?.(form, opt);
  if (!dlg.open) dlg.showModal();
  // Settings opens on its close button, so a phone doesn't pop up the keyboard.
  (view === 'settings' ? $('.acct-x', dlg) : view === 'login' && form.email.value ? form.password : $('input:not([type=checkbox]), button[type=submit]', form))?.focus();
}
const BIND = {
  login(form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = form.email.value.trim();
      const password = form.password.value;
      if (!email || !password) return showErr(form, '請輸入 Email 和密碼');
      acct.lastEmail = email;
      const done = busy($('button[type=submit]', form), '登入中…');
      try {
        const st = await acctCall('/api/account/login', 'POST', { email, password, remember: form.remember.checked });
        $('#acct-dialog').close();
        toast(`已登入 ${st.email}`);
        await signedInHere(st, { ask: true });
      } catch (err) {
        if (err.code === 'unverified') {
          showErr(form, '這個 Email 還沒驗證，請到信箱點確認信裡的連結。', ' <button type="button" class="linklike" id="acct-resend">重寄確認信</button>');
          $('#acct-resend').addEventListener('click', async () => {
            try { await acctCall('/api/account/signup', 'POST', { email, password }); openAuth('sent', { email }); } catch (e2) { showErr(form, errOf(e2)); }
          });
        } else showErr(form, errOf(err, { login: 'Email 或密碼不正確' }));
      } finally { done(); }
    });
  },
  signup(form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = form.email.value.trim();
      const password = form.password.value;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { form.email.focus(); return showErr(form, '請輸入正確的 Email'); }
      if (!pwOk(password)) { form.password.focus(); return showErr(form, '密碼至少要 8 個字元'); }
      if (password !== form.password2.value) { form.password2.focus(); return showErr(form, '兩次輸入的密碼不一樣'); }
      acct.lastEmail = email;
      const done = busy($('button[type=submit]', form), '建立中…');
      try {
        const r = await acctCall('/api/account/signup', 'POST', { email, password });
        if (r.verifyNeeded) { openAuth('sent', { email }); return; }
        // No mail service: the account starts verified, so sign straight in.
        const st = await acctCall('/api/account/login', 'POST', { email, password, remember: true });
        $('#acct-dialog').close();
        toast('帳號已建立並登入');
        await signedInHere(st, { ask: true });
      } catch (err) { showErr(form, errOf(err)); } finally { done(); }
    });
  },
  sent(form, opt) { form.addEventListener('submit', (e) => { e.preventDefault(); openAuth('login', { email: opt.email }); }); },
  forgot(form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = form.email.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { form.email.focus(); return showErr(form, '請輸入正確的 Email'); }
      acct.lastEmail = email;
      const done = busy($('button[type=submit]', form), '寄出中…');
      try { await acctCall('/api/account/forgot', 'POST', { email }); openAuth('forgot-sent', { email }); } catch (err) { showErr(form, errOf(err)); } finally { done(); }
    });
  },
  'forgot-sent'(form) { form.addEventListener('submit', (e) => { e.preventDefault(); $('#acct-dialog').close(); }); },
  reset(form, opt) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = form.password.value;
      if (!pwOk(password)) { form.password.focus(); return showErr(form, '密碼至少要 8 個字元'); }
      if (password !== form.password2.value) { form.password2.focus(); return showErr(form, '兩次輸入的密碼不一樣'); }
      const done = busy($('button[type=submit]', form), '更新中…');
      try {
        await acctCall('/api/account/reset', 'POST', { token: opt.token, password });
        if (signedIn()) signedOutHere();
        openAuth('login', { notice: '✅ 密碼已更新，請用新密碼登入。' });
      } catch (err) {
        if (err.code === 'token') openAuth('message', { title: '重設連結不能用了', text: '這個連結無效、已經用過或超過 30 分鐘。請在登入畫面按「忘記密碼？」重新申請。', button: '重新申請', next: 'forgot' });
        else showErr(form, errOf(err));
      } finally { done(); }
    });
  },
  message(form, opt) { form.addEventListener('submit', (e) => { e.preventDefault(); if (opt.next) openAuth(opt.next); else $('#acct-dialog').close(); }); },
  settings: bindSettings,
};

// First sync: ask before putting this device's data into the account.
function openMerge(local, accountHasData, onYes, onNo) {
  const dlg = $('#acct-dialog');
  $('#acct-body').innerHTML = `<form class="pass-in"><h2 id="acct-title">要把這台裝置的資料存進帳號嗎？</h2>
    <p class="hint">這台裝置上已經有：</p>
    <ul class="merge-list">${deviceSummary(local).map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
    <p class="hint">${accountHasData ? '帳號裡原本就有的資料會保留，兩邊合在一起。' : '帳號裡還沒有資料；存進去之後，其他裝置登入就看得到。'}</p>
    <div class="pass-actions"><button type="button" class="outline" id="merge-no">先不要</button><button type="submit" class="primary small">合併到帳號</button></div></form>`;
  let answered = false;
  const form = $('#acct-body form');
  form.addEventListener('submit', (e) => { e.preventDefault(); answered = true; dlg.close(); onYes().then(() => toast('已合併，這台裝置的資料已存進帳號')); });
  $('#merge-no').addEventListener('click', () => dlg.close());
  acct.onClose = () => { if (!answered) onNo(); };
  if (!dlg.open) dlg.showModal();
  $('button[type=submit]', form).focus();
}

// ---------- account settings ----------
function settingsHtml() {
  const st = acct.status;
  return `<form class="pass-in settings" novalidate><h2 id="acct-title">帳號設定</h2>
    <p class="hint">${esc(st.email)}${st.devices ? `・已登入 ${st.devices} 台裝置` : ''}</p>
    <section class="acct-sec" aria-labelledby="pw-h"><h3 id="pw-h">變更密碼</h3>
      <label>目前的密碼<input type="password" name="old" autocomplete="current-password"></label>
      <label>新密碼（至少 8 個字）<input type="password" name="new1" autocomplete="new-password" minlength="8"></label>
      <label>再輸入一次新密碼<input type="password" name="new2" autocomplete="new-password" minlength="8"></label>
      <p class="acct-err" role="alert" hidden></p>
      <div class="pass-actions"><button type="button" class="primary small" id="pw-save">更新密碼</button></div>
      <p class="hint">改好後，其他裝置會被登出，這台不會。</p>
    </section>
    <section class="acct-sec" aria-labelledby="tg-h"><h3 id="tg-h">📨 連結 Telegram</h3><div class="tg-box" id="tg-settings"></div></section>
    <section class="acct-sec" aria-labelledby="line-h"><h3 id="line-h">💬 連結 LINE</h3><div class="tg-box" id="line-settings"></div></section>
    <section class="acct-sec" aria-labelledby="dsub-h"><h3 id="dsub-h">📬 今日好康每日信</h3><div class="tg-box" id="dsub-settings"></div></section>
    <section class="acct-sec" aria-labelledby="del-h"><h3 id="del-h">刪除帳號</h3>
      <p class="hint">會刪掉帳號和存在雲端的資料；這台裝置上的資料不會被刪。</p>
      <label>輸入密碼確認<input type="password" name="delpw" autocomplete="current-password"></label>
      <p class="acct-err del-err" role="alert" hidden></p>
      <div class="pass-actions"><button type="button" class="danger-btn" id="acct-del">永久刪除帳號</button></div>
    </section></form>`;
}
function bindSettings(form) {
  form.addEventListener('submit', (e) => e.preventDefault());
  const pwSec = $('#pw-save', form).closest('section');
  $('#pw-save', form).addEventListener('click', async () => {
    const [o, n1, n2] = [form.old.value, form.new1.value, form.new2.value];
    if (!o) { form.old.focus(); return showErr(pwSec, '請輸入目前的密碼'); }
    if (!pwOk(n1)) { form.new1.focus(); return showErr(pwSec, '新密碼至少要 8 個字元'); }
    if (n1 !== n2) { form.new2.focus(); return showErr(pwSec, '兩次輸入的新密碼不一樣'); }
    const done = busy($('#pw-save', form), '更新中…');
    try {
      await acctCall('/api/account/password', 'POST', { old: o, new: n1 });
      form.old.value = form.new1.value = form.new2.value = '';
      showErr(pwSec, '');
      toast('密碼已更新，其他裝置已登出');
      acct.status.devices = 1;
    } catch (err) { showErr(pwSec, errOf(err)); } finally { done(); }
  });
  const delSec = $('#acct-del', form).closest('section');
  $('#acct-del', form).addEventListener('click', async () => {
    if (!form.delpw.value) { form.delpw.focus(); return showErr(delSec, '請輸入密碼確認'); }
    if (!confirm('確定要永久刪除帳號？雲端的資料會一起刪掉，無法復原。')) return;
    const done = busy($('#acct-del', form), '刪除中…');
    try {
      await acctCall('/api/account', 'DELETE', { password: form.delpw.value });
      rawDel(ACCT_SYNC);
      $('#acct-dialog').close();
      signedOutHere('帳號已刪除。這台裝置上的資料都還在。');
    } catch (err) { showErr(delSec, errOf(err)); } finally { done(); }
  });
  tgRender($('#tg-settings', form));
  loadScripts(['line']).then(() => { if (typeof lineRender === 'function') lineRender($('#line-settings', form)); }); // LINE (line.js, fetched here)
  if (typeof dsubRender === 'function') dsubRender($('#dsub-settings', form));
}

// ---------- Telegram (passcode-gated, not account-gated) ----------
const TG_STEPS = `<ol class="tg-steps">
  <li>在 Telegram 找 <b>@BotFather</b>，傳 <code>/newbot</code> 建立你自己的機器人。</li>
  <li>把它給的金鑰放進 Vercel 的 <code>TELEGRAM_BOT_TOKEN</code>（Settings → Environment Variables），存好後重新部署。</li>
  <li>打開你的機器人按「開始」，再回來按「連結 Telegram」。</li></ol>`;
const TG_ERR = { 'no-start': '機器人還沒收到你的訊息：請先照第 1 步打開機器人按「開始」（或隨便傳一句話給它），再按一次連結。', token: 'Telegram 不接受網站設定的機器人金鑰（TELEGRAM_BOT_TOKEN），請到 @BotFather 重新複製後更新到 Vercel 並重新部署。', 'not-configured': '網站還沒設定 Telegram 機器人，請照上面的步驟設定。', blocked: '機器人被封鎖了：請在 Telegram 解除封鎖、按「開始」後再試一次。', 'not-linked': '還沒連結 Telegram，請先按「連結 Telegram」。' };
// Can the gated status be read without asking for the passcode?
const tgOpen = () => !cashCfg.locked || Boolean(store.get(PASS_KEY, ''));
// The owner is here: this device has the passcode, or the account was unlocked with it (the demo, with no passcode
// set, counts too). Same gate as 帳號管理 (admin.js).
const ownerHere = () => Boolean(store.get(PASS_KEY, '') || acct.status?.unlocked || (!cashCfg.locked && !$('#mock-banner').hidden));
// Through the passcode prompt only when the site has a passcode. Without one the server refuses Telegram with a note
// for the owner (set CASH_PASSCODE); cashApi would read that as a wrong passcode, ask every visitor for one and lock
// 即時查價 for the rest of the visit.
const tgApi = (path, opts) => (cashCfg.locked ? cashApi(path, opts) : api(path, opts));
async function tgRender(host, note = '') {
  if (!host) return;
  host.innerHTML = '<p class="hint">載入中…</p>';
  let st;
  try {
    const cfg = (await api('/api/config')).telegram || {};
    st = cfg.configured && tgOpen() ? await tgApi('/api/telegram') : { ...cfg };
  } catch (err) { host.innerHTML = `<p class="acct-err">${esc(err.message)}</p>`; return; }
  const mock = st.mock ? '<p class="hint">（示範模式：連結的是一個假的 Telegram 帳號。）</p>' : '';
  host.innerHTML = !st.configured
    ? `<p class="hint">機位提醒、降價通知可以同時傳到你的 Telegram。網站還沒設定機器人，需要網站主人做三件事：</p>${TG_STEPS}`
    : st.linked
      ? `<p class="tg-on">✅ 已連結${st.name ? `：<b>${esc(st.name)}</b>` : ''}${st.linkedAt ? `<small>（${esc(st.linkedAt.slice(0, 10))}）</small>` : ''}</p><p class="hint">機位提醒和降價通知會同時傳到這個 Telegram。</p>${mock}
        <div class="pass-actions"><button type="button" class="primary small" data-tg="send">傳送測試訊息</button><button type="button" class="outline" data-tg="test">重新連結</button><button type="button" class="outline" data-tg="unlink">取消連結</button></div>`
      : st.tokenOk === false
        ? `<p class="acct-err">Telegram 不接受 Vercel 裡的 <code>TELEGRAM_BOT_TOKEN</code>：請到 @BotFather 傳 <code>/mybots</code> → 選你的機器人 → API Token，重新複製整串金鑰（不要有空白或引號），更新後重新部署。</p>`
        : `<p class="hint">機位提醒、降價通知可以同時傳到你的 Telegram，兩個步驟：</p>
        <ol class="tg-steps"><li>${st.bot ? `<a href="https://t.me/${encodeURIComponent(st.bot)}?start=link" target="_blank" rel="noopener">打開你的機器人 @${esc(st.bot)} ↗</a>，按下方的「開始」（Start）。` : '在 Telegram 打開你自己建立的機器人，按下方的「開始」（Start）。'}</li>
        <li>回到這裡，按「連結 Telegram」。</li></ol>${mock}
        <div class="pass-actions"><button type="button" class="primary small" data-tg="link">連結 Telegram</button></div>`;
  host.insertAdjacentHTML('beforeend', `<p class="acct-err" role="alert" ${note ? '' : 'hidden'}>${esc(note)}</p>`);
  $$('[data-tg]', host).forEach((b) => b.addEventListener('click', async () => {
    const act = b.dataset.tg;
    if (act === 'unlink' && !confirm('取消連結後，通知就不會再傳到 Telegram。確定嗎？')) return;
    const done = busy(b, act === 'unlink' ? '取消中…' : act === 'send' ? '傳送中…' : '連結中…');
    try {
      if (act === 'send') {
        await tgApi('/api/telegram/test', { method: 'POST' });
        done();
        $('.acct-err', host).hidden = true;
        toast('已傳送測試訊息，請到 Telegram 查看');
        return;
      }
      const r = act === 'unlink' ? await tgApi('/api/telegram', { method: 'DELETE' }) : await tgApi('/api/telegram/link', { method: 'POST' });
      toast(r.linked ? `已連結 Telegram${r.name ? `：${r.name}` : ''}` : '已取消連結 Telegram');
      tgSummaries(r.linked);
      tgRender(host);
    } catch (err) {
      done();
      const p = $('.acct-err', host);
      p.textContent = TG_ERR[err.code] || err.message;
      p.hidden = false;
    }
  }));
}
// The status lines (notify.js) follow a link or unlink made here.
const tgSummaries = () => { if (typeof notifyRefresh === 'function') notifyRefresh(true); };
// Telegram and LINE are set up in 帳號設定 only (U5); 機位提醒, 降價追蹤 and 我的行程 show one status line whose
// 設定 opens it (notify.js).

// ---------- links from the mails: /#verify=<token> and /#reset=<token> ----------
async function handleMailLink(hash) {
  const m = /^#(verify|reset)=([\w-]{10,200})$/.exec(hash || '');
  if (!m) return false;
  if (location.hash === hash) history.replaceState(null, '', `${location.pathname}${location.search}#${tabHash(currentTab)}`);
  if (m[1] === 'reset') { openAuth('reset', { token: m[2] }); return true; }
  try {
    const r = await acctCall('/api/account/verify', 'POST', { token: m[2] });
    toast('Email 驗證完成，請登入');
    if (!signedIn()) openAuth('login', { email: r.email, notice: '✅ Email 已驗證，現在可以登入了。' });
  } catch (err) {
    openAuth('message', { title: '驗證連結不能用了', text: err.code === 'token' ? '這個連結無效或已超過 24 小時。請再按「註冊」用同一個 Email 註冊一次，我們會重寄確認信。' : err.message, button: '去註冊', next: 'signup' });
  }
  return true;
}
addEventListener('hashchange', () => { if (/^#(verify|reset)=/.test(location.hash)) handleMailLink(location.hash); });

// ---------- start ----------
(async function initAccount() {
  let st;
  const hideBtn = () => { const box = $('#acct'); if (box) box.hidden = true; };
  try { st = await acctCall('/api/account'); } catch { hideBtn(); return; }
  acct.configured = Boolean(st.configured);
  acct.emailEnabled = Boolean(st.emailEnabled);
  if (!acct.configured) { hideBtn(); return; }
  mountHeader();
  mountDialog();
  acct.status = st;
  renderHeader();
  if (st.loggedIn) {
    applyUnlock();
    firstSync({ ask: false });
  }
  await handleMailLink(typeof BOOT_HASH === 'string' ? BOOT_HASH : location.hash);
})();
