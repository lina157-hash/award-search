// 今日好康每日信: the 「📬 每天寄給我」 link next to the 今日好康 heading opens a small dialog to get the deals by mail
// once a day (signed-in accounts, verified email), plus, for the owner, the linked Telegram / LINE. The same switch sits
// in 帳號設定. The unsubscribe link in each mail (/#unsub=<token>) is handled here, without signing in: the page asks
// first and posts only on a click, so mail scanners that open links (and run the page) unsubscribe nobody.
// Classic script loaded after account.js; uses the globals of app.js (api, store, esc, toast, busy, $) and account.js
// (acct, openAuth, signedIn).

const dsubPass = () => store.get(PASS_KEY, '');
// The owner's passcode goes along when this device has it, so the answer can include the owner's part.
const dsubApi = (path, body) => api(path, {
  ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
  headers: { ...(dsubPass() ? { 'x-cash-pass': dsubPass() } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
});
const DSUB_ERR = { full: '名額已滿', 'no-mail': '網站還沒設定寄信服務', 'login-required': '請先登入' };

// Called by renderDeals (features.js) after it draws the section: the small link next to the heading.
function dealSubMount(host) {
  const h = $('.deals-head .section-title', host);
  if (!h || $('.dsub-link', h)) return;
  h.insertAdjacentHTML('beforeend', ' <button type="button" class="linkish dsub-link" aria-haspopup="dialog">📬 每天寄給我</button>');
  $('.dsub-link', h).addEventListener('click', dsubOpen);
}

function dsubDialog() {
  let dlg = $('#dsub-dialog');
  if (dlg) return dlg;
  document.body.insertAdjacentHTML('beforeend', `<dialog id="dsub-dialog" class="pass acct-dlg dsub-dlg" aria-labelledby="dsub-title">
    <button type="button" class="ghost acct-x" aria-label="關閉">✕</button><div class="pass-in" id="dsub-body"></div></dialog>`);
  dlg = $('#dsub-dialog');
  $('.acct-x', dlg).addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  return dlg;
}

async function dsubOpen() {
  const dlg = dsubDialog();
  const body = $('#dsub-body');
  body.innerHTML = '<h2 id="dsub-title">📬 今日好康每日信</h2><p class="hint">載入中…</p>';
  if (!dlg.open) dlg.showModal();
  $('.acct-x', dlg).focus();
  let st;
  try { st = await dsubApi('/api/dealsub'); } catch (e) { body.insertAdjacentHTML('beforeend', `<p class="acct-err">${esc(e.message)}</p>`); return; }
  body.innerHTML = `<h2 id="dsub-title">📬 今日好康每日信</h2>
    <p class="hint">每天早上 8 點多整理好後寄一次，有好康才寄：台北出發的商務、頭等艙最便宜獎勵位，和這裡看到的一樣，點一筆就在網站上查那幾天。不用時隨時取消。</p>
    <section class="acct-sec dsub-sec"><h3>Email</h3><div id="dsub-mail"></div></section>
    ${st.owner ? '<section class="acct-sec dsub-sec"><h3>站長的通知 <small class="dsub-tag">只有你看得到</small></h3><div id="dsub-owner"></div></section>' : ''}`;
  dsubMailBox($('#dsub-mail'), st);
  if (st.owner) dsubOwnerBox($('#dsub-owner'), st);
}

// The email part, in the dialog and in 帳號設定.
function dsubMailBox(host, st) {
  if (!st.configured) { host.innerHTML = '<p class="hint">這個網站沒有開啟帳號功能，暫時不能訂閱。</p>'; return; }
  if (!st.signedIn) {
    host.innerHTML = `<p class="hint">用 Email 收需要先登入（免費註冊，Email 驗證過才會寄）。</p>
      <div class="pass-actions"><button type="button" class="primary small" data-dsub="login">登入／註冊</button></div>`;
    $('[data-dsub=login]', host).addEventListener('click', () => { $('#dsub-dialog')?.close(); openAuth('login'); });
    return;
  }
  const off = !st.subscribed && (st.full || !st.mail);
  host.innerHTML = `<label class="chk"><input type="checkbox" data-dsub="mail" ${st.subscribed ? 'checked' : ''} ${off ? 'disabled' : ''}><span>每天寄到 <b>${esc(st.email)}</b></span></label>
    <p class="hint dsub-note">${!st.mail && !st.subscribed ? '網站還沒設定寄信服務，暫時不能用 Email 訂閱。'
      : st.full && !st.subscribed ? `名額已滿：網站每天能寄的信有限，目前最多 ${st.cap} 人訂閱，請之後再試。`
        : '每封信最下面都有「取消訂閱」，點一下就停，不用登入。'}</p>
    <p class="acct-err" role="alert" hidden></p>`;
  const box = $('[data-dsub=mail]', host);
  box.addEventListener('change', async () => {
    const want = box.checked;
    box.disabled = true;
    try {
      const r = await dsubApi('/api/dealsub', { on: want });
      toast(r.subscribed ? '已訂閱：明天早上起每天寄一次今日好康' : '已取消訂閱今日好康每日信');
      dsubMailBox(host, r);
    } catch (e) {
      box.checked = !want;
      box.disabled = false;
      const p = $('.acct-err', host);
      p.textContent = e.code === 'full' ? `名額已滿（最多 ${st.cap} 人），請之後再試` : e.message;
      p.hidden = false;
    }
  });
}

// The owner's part: the linked Telegram / LINE get the same list, and how many people subscribe.
function dsubOwnerBox(host, st) {
  const o = st.owner;
  const row = (k, name, c) => (!c.configured && k === 'line' ? '' : `<label class="chk"><input type="checkbox" data-ch="${k}" ${c.on && c.linked ? 'checked' : ''} ${c.linked ? '' : 'disabled'}><span>也傳到 ${name}${c.linked ? `${c.name ? `（${esc(c.name)}）` : '（已連結）'}` : '<small class="dsub-muted">（還沒連結，可在「帳號設定」連結）</small>'}</span></label>`);
  host.innerHTML = `${row('telegram', 'Telegram', o.telegram)}${row('line', 'LINE', o.line)}
    <p class="hint">目前 <b>${fmt(o.count)}</b> 人用 Email 訂閱（上限 ${st.cap} 人）。</p><p class="acct-err" role="alert" hidden></p>`;
  $$('[data-ch]', host).forEach((b) => b.addEventListener('change', async () => {
    b.disabled = true;
    try {
      const r = await dsubApi('/api/dealsub/owner', { [b.dataset.ch]: b.checked });
      toast(b.checked ? `今日好康會每天也傳到 ${b.dataset.ch === 'line' ? 'LINE' : 'Telegram'}` : `不再傳到 ${b.dataset.ch === 'line' ? 'LINE' : 'Telegram'}`);
      if (r.owner) dsubOwnerBox(host, r);
    } catch (e) {
      b.checked = !b.checked;
      b.disabled = false;
      const p = $('.acct-err', host);
      p.textContent = e.message;
      p.hidden = false;
    }
  }));
}

// 帳號設定 (account.js bindSettings) calls this for its 「今日好康每日信」 section.
async function dsubRender(host) {
  if (!host) return;
  host.innerHTML = '<p class="hint">載入中…</p>';
  try { dsubMailBox(host, await dsubApi('/api/dealsub')); } catch (e) { host.innerHTML = `<p class="acct-err">${esc(e.message)}</p>`; }
}

// The address inside an unsubscribe token (base64url before the dot), masked like the server's answer; '' if unreadable.
function dsubTokenEmail(t) {
  try {
    const b = atob(t.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'));
    const [u, d] = new TextDecoder().decode(Uint8Array.from(b, (c) => c.charCodeAt(0))).split('@');
    return u && d ? `${u.slice(0, 1)}***@${d}` : '';
  } catch { return ''; }
}

// The unsubscribe link from a mail: /#unsub=<token>. No sign-in; the page shows the address and posts on the button.
function dsubUnsubLink(hash) {
  const m = /^#unsub=([\w.%-]{10,600})$/.exec(hash || '');
  if (!m) return;
  if (location.hash === hash) history.replaceState(null, '', `${location.pathname}${location.search}#${tabHash(currentTab)}`);
  const t = decodeURIComponent(m[1]);
  const who = dsubTokenEmail(t);
  const dlg = dsubDialog();
  const body = $('#dsub-body');
  body.innerHTML = `<p class="ok-big" aria-hidden="true">📬</p><h2 id="dsub-title" class="center">取消訂閱今日好康每日信？</h2>
    <p class="hint center">按下「取消訂閱」後，${who ? `<b>${esc(who)}</b>` : '這個信箱'}就不會再收到今日好康每日信。</p>
    <button type="button" class="primary full" data-dsub="unsub">取消訂閱</button>`;
  const go = $('[data-dsub=unsub]', body);
  go.addEventListener('click', async () => {
    go.disabled = true;
    let html;
    try {
      const r = await api('/api/dealsub/unsubscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ t }) });
      html = `<p class="ok-big" aria-hidden="true">📭</p><h2 id="dsub-title" class="center">已取消訂閱</h2>
        <p class="hint center"><b>${esc(r.email)}</b> 不會再收到今日好康每日信。<br>想再收的話，登入後在「今日好康」旁按「📬 每天寄給我」。</p>`;
    } catch (e) {
      html = `<p class="ok-big" aria-hidden="true">⚠️</p><h2 id="dsub-title" class="center">取消訂閱沒有完成</h2><p class="hint center">${esc(e.message)}</p>`;
    }
    body.innerHTML = `${html}<button type="button" class="primary full" data-dsub="ok">知道了</button>`;
    $('[data-dsub=ok]', body).addEventListener('click', () => dlg.close());
  });
  if (!dlg.open) dlg.showModal();
  go.focus();
}
addEventListener('hashchange', () => { if (location.hash.startsWith('#unsub=')) dsubUnsubLink(location.hash); });
dsubUnsubLink(typeof BOOT_HASH === 'string' ? BOOT_HASH : location.hash);
// renderDeals may have drawn the section before this script loaded.
if ($('#deals .deals-head')) dealSubMount($('#deals'));
