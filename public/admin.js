// 帳號管理 (owner only): who signed up, verified or not, last sign-in, devices signed in, what each account keeps in
// sync; deleting an account or signing all its devices out. The entry sits in the account menu and shows only on a
// device where the passcode was entered (or an account unlocked with it); the server checks the passcode again.
// Classic script loaded after account.js; uses its globals (acct, ACCT_MENU_EXTRA, signedOutHere) and app.js's.

const adm = { list: null, q: '', busy: false, err: '' };

const admPass = () => store.get(PASS_KEY, '');
const admOwnerHere = () => Boolean(admPass() || acct.status?.unlocked || (!cashCfg.locked && !$('#mock-banner').hidden));
async function admCall(path, body) {
  const headers = { ...(admPass() ? { 'x-cash-pass': admPass() } : {}), ...(body ? { 'content-type': 'application/json' } : {}) };
  return api(path, body ? { method: 'POST', headers, body: JSON.stringify(body) } : { headers });
}

const admDate = (iso) => {
  const d = iso && new Date(iso);
  return d && !Number.isNaN(d.getTime()) ? `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}` : '—';
};
const admStamp = (iso) => (iso ? `${admDate(iso)} ${new Date(iso).toTimeString().slice(0, 5)}` : '');
const admSize = (b) => (b >= 1024 ? `${(b / 1024).toFixed(b >= 10240 ? 0 : 1)} KB` : `${b} B`);
// What an account keeps in sync, in a few words.
function admSynced(a) {
  const s = a.synced;
  const bits = s ? [[s.wallet, '點數', '項'], [s.routes, '常用航線', '條'], [s.recent, '最近搜尋', '筆'], [s.trips, '行程', '段']].filter(([n]) => n > 0).map(([n, l, u]) => `${l} ${n} ${u}`) : [];
  if (a.alerts) bits.push(`提醒 ${a.alerts} 個`);
  if (!bits.length) return '<span class="adm-mute">沒有同步資料</span>';
  return `${bits.map(esc).join('・')}${s ? `<small class="adm-mute">${admSize(s.bytes)}</small>` : ''}`;
}

function admMount() {
  document.body.insertAdjacentHTML('beforeend', `<dialog id="adm-dialog" class="adm-dlg" aria-labelledby="adm-title">
    <div class="dialog-head"><h2 id="adm-title">帳號管理</h2><button type="button" class="ghost" data-adm="close" aria-label="關閉">✕</button></div>
    <div class="adm" id="adm-body"></div>
  </dialog>
  <dialog id="adm-confirm" class="pass adm-confirm" aria-labelledby="adm-c-title"><form method="dialog" class="pass-in" id="adm-c-body"></form></dialog>`);
  const dlg = $('#adm-dialog');
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) return dlg.close();
    const b = e.target.closest('[data-adm]');
    if (!b) return;
    if (b.dataset.adm === 'close') dlg.close();
    else if (b.dataset.adm === 'reload') admLoad();
    else admConfirm(b.dataset.adm, b.dataset.email);
  });
  dlg.addEventListener('input', (e) => { if (e.target.id === 'adm-q') { adm.q = e.target.value.trim().toLowerCase(); admRows(); } });
  $('#adm-confirm').addEventListener('click', (e) => { if (e.target.id === 'adm-confirm') e.target.close(); });
}

function admRender() {
  const body = $('#adm-body');
  const L = adm.list;
  const t = L?.totals;
  body.innerHTML = `<p class="adm-note">🔒 密碼只以無法還原的加密方式保存，任何人（包括站長）都看不到。</p>
    ${t ? `<div class="adm-stats">
      <div><b>${fmt(t.accounts)}</b><span>帳號</span></div>
      <div><b>${fmt(t.verified)}</b><span>已驗證</span></div>
      <div><b>${fmt(t.last7)}</b><span>近 7 天新註冊</span></div>
    </div>` : ''}
    ${L?.accounts.length > 5 ? '<div class="adm-tools"><input type="search" id="adm-q" placeholder="搜尋 Email" aria-label="搜尋 Email" autocomplete="off"></div>' : ''}
    <div id="adm-rows">${adm.err ? `<p class="adm-err">${esc(adm.err)} <button type="button" class="linkish" data-adm="reload">再試一次</button></p>` : L ? '' : skeleton(3)}</div>`;
  const q = $('#adm-q');
  if (q) q.value = adm.q;
  if (L && !adm.err) admRows();
}

function admRows() {
  const box = $('#adm-rows');
  const me = acct.status?.email;
  const rows = adm.list.accounts.filter((a) => !adm.q || a.email.includes(adm.q));
  if (!adm.list.accounts.length) { box.innerHTML = '<p class="adm-empty">還沒有人註冊。</p>'; return; }
  if (!rows.length) { box.innerHTML = '<p class="adm-empty">找不到符合的帳號。</p>'; return; }
  box.innerHTML = `<table class="adm-table">
    <thead><tr><th>Email</th><th>註冊日期</th><th>狀態</th><th>最後登入</th><th>登入中</th><th>同步資料</th><th><span class="sr-only">操作</span></th></tr></thead>
    <tbody>${rows.map((a) => `<tr>
      <td class="adm-email">${esc(a.email)}${a.email === me ? ' <span class="adm-tag">你</span>' : ''}${a.unlocked ? ' <span class="adm-tag" title="這個帳號輸入過通關密碼">已解鎖</span>' : ''}</td>
      <td data-l="註冊">${admDate(a.createdAt)}</td>
      <td data-l="狀態">${a.verified ? '<span class="adm-pill ok">已驗證</span>' : '<span class="adm-pill wait">未驗證</span>'}</td>
      <td data-l="最後登入"${a.lastLoginAt ? ` title="${esc(admStamp(a.lastLoginAt))}"` : ''}>${a.lastLoginAt ? esc(ago(a.lastLoginAt)) : '<span class="adm-mute">從未登入</span>'}</td>
      <td data-l="登入中">${a.sessions ? `${a.sessions} 台裝置` : '<span class="adm-mute">—</span>'}</td>
      <td data-l="同步資料" class="adm-sync">${admSynced(a)}</td>
      <td class="adm-act">
        <button type="button" class="outline" data-adm="signout" data-email="${esc(a.email)}"${a.sessions ? '' : ' disabled'}>登出裝置</button>
        <button type="button" class="outline adm-del" data-adm="delete" data-email="${esc(a.email)}">刪除</button>
      </td></tr>`).join('')}</tbody></table>`;
}

async function admLoad() {
  adm.err = '';
  adm.list = null;
  admRender();
  try { adm.list = await admCall('/api/admin/accounts'); } catch (e) {
    adm.err = e.code === 'passcode' ? '需要通關密碼：請先在「現金票價」輸入一次通關密碼。' : e.message;
  }
  admRender();
}

function admOpen() {
  if (!$('#adm-dialog')) admMount();
  $('#adm-dialog').showModal();
  admLoad();
}

// Delete or sign out, after a confirm that says exactly what happens.
function admConfirm(kind, email) {
  const a = adm.list?.accounts.find((x) => x.email === email);
  if (!a) return;
  const mine = email === acct.status?.email;
  const dlg = $('#adm-confirm');
  const f = $('#adm-c-body');
  const what = [a.sessions ? `登入中的 ${a.sessions} 台裝置` : '', a.synced ? '同步的資料（點數、常用航線、行程等）' : ''].filter(Boolean);
  f.innerHTML = kind === 'delete'
    ? `<h2 id="adm-c-title">刪除這個帳號？</h2>
      <p class="adm-c-email">${esc(email)}</p>
      <p class="hint">帳號${what.length ? `、${what.join('、')}` : ''}都會刪除，無法復原。對方之後可以用同一個 Email 重新註冊。${mine ? '<br><b>這是你目前登入的帳號</b>，刪除後這台裝置也會登出。' : ''}</p>
      <p class="acct-err adm-err" hidden></p>
      <div class="pass-actions"><button type="submit" class="outline" value="cancel">取消</button><button type="button" class="danger-btn" data-go>刪除帳號</button></div>`
    : `<h2 id="adm-c-title">登出這個帳號的所有裝置？</h2>
      <p class="adm-c-email">${esc(email)}</p>
      <p class="hint">目前有 ${a.sessions} 台裝置登入中，會全部登出。帳號和資料都會保留，對方重新登入即可。${mine ? '<br><b>這是你目前登入的帳號</b>，這台裝置也會登出。' : ''}</p>
      <p class="acct-err adm-err" hidden></p>
      <div class="pass-actions"><button type="submit" class="outline" value="cancel">取消</button><button type="button" class="danger-btn" data-go>全部登出</button></div>`;
  $('[data-go]', f).addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await admCall(`/api/admin/accounts/${kind}`, { email });
      dlg.close();
      toast(kind === 'delete' ? `已刪除 ${email}` : `已登出 ${email} 的所有裝置`);
      if (mine) { $('#adm-dialog').close(); signedOutHere(); return; }
      admLoad();
    } catch (err) {
      const p = $('.adm-err', f);
      p.textContent = err.message;
      p.hidden = false;
      btn.disabled = false;
    }
  });
  dlg.showModal();
  $('button[value=cancel]', f).focus();
}

ACCT_MENU_EXTRA.push({ m: 'admin', label: '🗂️ 帳號管理', show: admOwnerHere, run: admOpen });
