// LINE notifications panel: in 帳號設定 (and notify.js's 通知設定 dialog when no account is signed in).
// Linking: the site shows a one-time 6-digit code, the owner sends it to the site's LINE Official Account, and the
// server's webhook remembers who sent it. Passcode-gated like Telegram (see account.js tgOpen / app.js cashApi).
// Classic script; uses the globals of app.js and account.js ($, esc, api, cashApi, busy, toast, tgOpen…).

const LINE_STEPS = `<ol class="tg-steps">
  <li>到 <a href="https://manager.line.biz/" target="_blank" rel="noopener">LINE Official Account Manager ↗</a> 建立一個免費的 LINE 官方帳號。</li>
  <li>在官方帳號的「設定 → Messaging API」按「啟用 Messaging API」，選一個提供者（Provider）。</li>
  <li>到 <a href="https://developers.line.biz/console/" target="_blank" rel="noopener">LINE Developers ↗</a>：Basic settings 的 Channel secret 放進 Vercel 的 <code>LINE_CHANNEL_SECRET</code>；Messaging API 分頁最下面發行 Channel access token（long-lived），放進 <code>LINE_CHANNEL_ACCESS_TOKEN</code>，重新部署。</li>
  <li>同一頁的 Webhook URL 填 <code>${esc(location.origin)}/api/line/webhook</code>，按 Verify，打開 Use webhook；官方帳號的「回應設定」把「自動回應訊息」關掉。</li></ol>`;
const LINE_ERR = {
  'not-configured': '網站還沒設定 LINE 官方帳號，請照上面的步驟設定。',
  token: 'LINE 不接受 Vercel 裡的 LINE_CHANNEL_ACCESS_TOKEN：請到 LINE Developers 的 Messaging API 分頁重新發行，更新後重新部署。',
  'not-linked': '還沒連結 LINE，請先產生連結碼並傳給官方帳號。',
  blocked: 'LINE 拒絕傳送：請確認你有把官方帳號加為好友、沒有封鎖它。',
  cap: '本月 LINE 通知已達上限，下個月 1 日恢復；Email 和 Telegram 照常。',
  limit: 'LINE 官方帳號本月的免費訊息已用完，下個月 1 日恢復。',
};
const linePoll = new WeakMap();
const addFriendUrl = (id) => `https://line.me/R/ti/p/${encodeURIComponent(id)}`;

// `pending`: { code, until } while a link code is waiting to be sent from LINE.
async function lineRender(host, note = '', pending = null) {
  if (!host) return;
  clearTimeout(linePoll.get(host));
  if (!pending) host.innerHTML = '<p class="hint">載入中…</p>';
  let st;
  try {
    const cfg = (await api('/api/config')).line || {};
    // Not set up: which settings are missing is the owner's to read (/api/line behind the passcode; /api/config
    // tells visitors only that LINE is off).
    const pass = store.get(PASS_KEY, '');
    st = cfg.configured && tgOpen() ? await cashApi('/api/line')
      : !cfg.configured && typeof ownerHere === 'function' && ownerHere() ? await api('/api/line', { headers: pass ? { 'x-cash-pass': pass } : {} }).catch(() => ({ ...cfg })) : { ...cfg };
  } catch (err) { host.innerHTML = `<p class="acct-err">${esc(err.message)}</p>`; return; }
  const mock = st.mock ? '<p class="hint">（示範模式：連結的是一個假的 LINE 帳號，不會真的傳訊息。）</p>' : '';
  const bot = st.botId ? `<a href="${esc(addFriendUrl(st.botId))}" target="_blank" rel="noopener" title="${esc(st.botName || '')}">${esc(st.botId)} ↗</a>` : '你的 LINE 官方帳號';
  const usage = st.cap ? `本月已傳 ${st.used || 0}／${st.cap} 則（測試訊息也算）${st.capped ? '，<b>已達上限</b>，下個月 1 日恢復' : ''}。` : '';
  let html;
  if (!st.configured) {
    const miss = (st.missing || []).filter((x) => x !== 'Upstash Redis').map((x) => `<code>${esc(x)}</code>`).join('、');
    html = `<p class="hint">也可以傳到 LINE（官方帳號免費方案每月 200 則，網站最多用 180 則）。網站主人要先設定${miss ? ` ${miss}` : ''}${(st.missing || []).includes('Upstash Redis') ? '，並連接 Upstash Redis' : ''}：</p>
      <details class="line-setup"><summary>設定步驟</summary>${LINE_STEPS}</details>`;
  } else if (st.linked) {
    html = `<p class="tg-on">✅ 已連結${st.name ? `：<b>${esc(st.name)}</b>` : ''}${st.linkedAt ? `<small>（${esc(st.linkedAt.slice(0, 10))}）</small>` : ''}</p>
      <p class="hint">機位提醒和降價通知會同時傳到這個 LINE。${usage}</p>${mock}
      <div class="pass-actions"><button type="button" class="primary small" data-line="test" ${st.capped ? 'disabled' : ''}>傳送測試訊息</button><button type="button" class="outline" data-line="unlink">取消連結</button></div>`;
  } else if (st.tokenOk === false) {
    html = `<p class="acct-err">${LINE_ERR.token}</p>`;
  } else if (pending) {
    html = `<p class="hint">請在 10 分鐘內把這 6 位數字傳給 ${bot}：</p>
      <p class="line-code" aria-label="連結碼">${esc(pending.code.slice(0, 3))}<span> </span>${esc(pending.code.slice(3))}</p>
      <p class="hint">傳出後這裡會自動更新。還沒加好友的話，先加好友再傳。</p>${mock}
      <div class="pass-actions">${st.mock ? '<button type="button" class="primary small" data-line="demo">示範：模擬從 LINE 傳出連結碼</button>' : ''}<button type="button" class="outline" data-line="code">重新產生</button></div>`;
  } else {
    html = `<p class="hint">機位提醒、降價通知也可以傳到 LINE，兩個步驟：</p>
      <ol class="tg-steps"><li>用 LINE 加 ${bot} 為好友。</li><li>按「產生連結碼」，把 6 位數字傳給它。</li></ol>${mock}
      <div class="pass-actions"><button type="button" class="primary small" data-line="code">產生連結碼</button></div>`;
  }
  host.innerHTML = html + `<p class="acct-err" role="alert" ${note ? '' : 'hidden'}>${esc(note)}</p>`;
  // Waiting for the code: look again every 3 seconds while the panel is on the page, up to 10 minutes.
  if (pending && st.configured && !st.linked) {
    const { until } = pending;
    const tick = async () => {
      if (!host.isConnected || Date.now() > until) return;
      const s = await cashApi('/api/line').catch(() => null);
      if (s?.linked) { toast(`已連結 LINE${s.name ? `：${s.name}` : ''}`); if (typeof notifyRefresh === 'function') notifyRefresh(true); return lineRender(host); }
      linePoll.set(host, setTimeout(tick, 3000));
    };
    linePoll.set(host, setTimeout(tick, 3000));
  }
  $$('[data-line]', host).forEach((b) => b.addEventListener('click', async () => {
    const act = b.dataset.line;
    if (act === 'unlink' && !confirm('取消連結後，通知就不會再傳到 LINE。確定嗎？')) return;
    const done = busy(b, act === 'unlink' ? '取消中…' : act === 'test' ? '傳送中…' : '處理中…');
    try {
      if (act === 'test') {
        await cashApi('/api/line/test', { method: 'POST' });
        toast('已傳送測試訊息，請到 LINE 查看');
        return lineRender(host);
      }
      if (act === 'code') {
        const r = await cashApi('/api/line/code', { method: 'POST' });
        return lineRender(host, '', { code: String(r.code), until: Date.parse(r.expiresAt) || Date.now() + 600e3 });
      }
      if (act === 'demo') {
        const r = await cashApi('/api/line/demo', { method: 'POST' });
        if (r.linked) toast(`已連結 LINE：${r.name || '示範帳號'}`);
        if (typeof notifyRefresh === 'function') notifyRefresh(true);
        return lineRender(host);
      }
      await cashApi('/api/line', { method: 'DELETE' });
      toast('已取消連結 LINE');
      if (typeof notifyRefresh === 'function') notifyRefresh(true);
      lineRender(host);
    } catch (err) {
      done();
      const p = $('.acct-err', host);
      p.textContent = LINE_ERR[err.code] || err.message;
      p.hidden = false;
    }
  }));
}
