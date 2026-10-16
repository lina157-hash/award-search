// 今日好康「我的條件通知」 (N2): the owner's rules (region, cabin, most miles, operating airlines, fewest seats, dates),
// matched on the server against every row each 今日好康 refresh fetched (lib/dealrules.js, no extra search), sent once
// to Telegram / LINE / email, and highlighted here: a 「🎯 符合我的條件」 row above the regions and a mark on matching
// cards. Behind the passcode like the other owner tools; visitors see nothing of it.
// Classic script after notify.js; uses the globals of app.js, features.js, account.js and notify.js ($, $$, esc, fmt,
// api, cashApi, toast, busy, ownerHere, dealsState, renderDeals, applyShare, airportCity, srcName, dayLabel, isoDate,
// isoDateFrom, notifyCfg, notifyLineHtml).

const drState = { data: null, at: 0, busy: false };
const DR_REGIONS = [['na', '北美'], ['eu', '歐洲'], ['jk', '日韓'], ['sea', '東南亞'], ['oc', '澳紐']];
const DR_AIRLINES = [['BR', '長榮'], ['JX', '星宇'], ['CI', '華航'], ['CX', '國泰']];
const drOn = () => Boolean(notifyCfg.dealRules) && ownerHere();
const drCall = (path, opts = {}) => cashApi(path, { pass: '我的條件通知', ...opts, ...(opts.body ? { method: opts.method || 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(opts.body) } : {}) });

// Called by renderDeals (features.js) after it draws 今日好康: the owner's link, the matches row and the marks.
function dealRulesMount(host) {
  if (!drOn()) return;
  const h = $('.deals-head .section-title', host);
  if (h && !$('.dr-link', h)) {
    h.insertAdjacentHTML('beforeend', ' <button type="button" class="linkish dr-link" aria-haspopup="dialog">🎯 我的條件通知</button>');
    $('.dr-link', h).addEventListener('click', drOpen);
  }
  if (drState.data) drHighlight(host);
  if (!drState.busy && Date.now() - drState.at > 5 * 60e3) drLoad().then(() => drHighlight($('#deals'))).catch(() => {});
}
async function drLoad() {
  drState.busy = true;
  try { drState.data = await drCall('/api/dealrules'); drState.at = Date.now(); } finally { drState.busy = false; }
  return drState.data;
}

// The matches of the cabin on screen, cheapest first, as a row of cards; cards of the regions that match get a tag.
function drHighlight(host) {
  if (!host || !drState.data) return;
  $('.dr-hits', host)?.remove();
  const hits = (drState.data.hits || []).filter((x) => x.cabin === dealsState.cabin && x.date >= isoDate(1));
  const keys = new Set(hits.map((x) => `${x.origin}|${x.destination}|${x.date}`));
  $$('.deal-mini[data-deal]', host).forEach((b) => {
    const on = keys.has(b.dataset.deal);
    b.classList.toggle('dm-hit', on);
    if (on && !$('.dm-tag', b)) b.insertAdjacentHTML('beforeend', '<span class="dm-tag">🎯 符合條件</span>');
  });
  if (!hits.length) return;
  const card = (d) => `<button type="button" class="deal-mini dm-hit" data-dr="${esc(d.origin)}|${esc(d.destination)}|${esc(d.date)}">
      <span class="dm-route">${esc(d.origin)} → ${esc(d.destination)} <small>${esc(airportCity(d.destination))}</small></span>
      <span class="dm-miles">${fmt(d.miles)} <small>哩</small>${d.direct ? '<small class="dm-direct">直飛</small>' : ''}</span>
      <span class="dm-meta">${dayLabel(d.date)} · ${esc(srcName(d.source))} · ${esc(d.airlines)}${d.seats ? ` · ${d.seats} 位` : ''}</span>
    </button>`;
  $('.deals-head', host).insertAdjacentHTML('afterend', `<div class="deal-group dr-hits"><h3 class="sub">🎯 符合我的條件 <small>（${hits.length} 筆，只有你看得到）</small></h3><div class="deal-row">${hits.slice(0, 4).map(card).join('')}</div></div>`);
  $$('[data-dr]', host).forEach((b) => b.addEventListener('click', () => {
    const [o, d, date] = b.dataset.dr.split('|');
    const s = date < isoDateFrom(isoDate(0), 3) ? isoDate(0) : isoDateFrom(date, -3);
    applyShare(new URLSearchParams({ o, d, s, e: isoDateFrom(date, 3), c: dealsState.cabin }));
  }));
}

function drDialog() {
  let dlg = $('#dr-dialog');
  if (dlg) return dlg;
  document.body.insertAdjacentHTML('beforeend', `<dialog id="dr-dialog" class="pass acct-dlg dr-dlg" aria-labelledby="dr-title">
    <button type="button" class="ghost acct-x" aria-label="關閉">✕</button><div class="pass-in" id="dr-body"></div></dialog>`);
  dlg = $('#dr-dialog');
  $('.acct-x', dlg).addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener('close', () => { if (drState.data) drHighlight($('#deals')); });
  return dlg;
}
async function drOpen() {
  const dlg = drDialog();
  const body = $('#dr-body');
  body.innerHTML = '<h2 id="dr-title">🎯 我的條件通知</h2><p class="hint">載入中…</p>';
  if (!dlg.open) dlg.showModal();
  $('.acct-x', dlg).focus();
  try { drRender(await drLoad()); } catch (e) { body.insertAdjacentHTML('beforeend', `<p class="acct-err">${esc(e.message)}</p>`); }
}

// 「修改」 fills the form with that rule; saving keeps its id.
function drFormHtml(r = {}) {
  const regions = dealsState.body?.groups?.length ? [...new Map(dealsState.body.groups.map((g) => [g.id, g.name]))] : DR_REGIONS;
  const opt = (v, t, on) => `<option value="${esc(v)}" ${on ? 'selected' : ''}>${esc(t)}</option>`;
  const al = new Set(r.airlines || []);
  const other = (r.airlines || []).filter((x) => !DR_AIRLINES.some(([c]) => c === x));
  const lo = isoDate(1);
  return `<form class="dr-form" data-id="${esc(r.id || '')}" novalidate>
    <div class="alert-edit-grid">
      <label class="field">地區<select name="region">${opt('', '全部地區', !r.region)}${regions.map(([id, n]) => opt(id, n, r.region === id)).join('')}</select></label>
      <label class="field">艙等<select name="cabin">${opt('', '商務或頭等', !r.cabin)}${opt('J', '商務艙', r.cabin === 'J')}${opt('F', '頭等艙', r.cabin === 'F')}</select></label>
      <label class="field">最多幾哩（每人單程）<input name="maxMiles" inputmode="numeric" placeholder="例如 80000" value="${esc(r.maxMiles || '')}" autocomplete="off"></label>
      <label class="field">至少幾位<select name="minSeats">${opt('', '不限', !r.minSeats)}${[2, 3, 4].map((n) => opt(n, `至少 ${n} 位`, r.minSeats === n)).join('')}</select></label>
      <label class="field">出發日（從）<input type="date" name="from" value="${esc(r.from || '')}" min="${lo}"></label>
      <label class="field">到<input type="date" name="to" value="${esc(r.to || '')}" min="${lo}"></label>
    </div>
    <div class="field"><span>只要這些航空公司自家飛（不選＝全部）</span><div class="h-progs">${DR_AIRLINES.map(([c, n]) => `<label class="h-chip"><input type="checkbox" name="dr-al" value="${c}" ${al.has(c) ? 'checked' : ''}><span>${n} ${c}</span></label>`).join('')}</div></div>
    <label class="field">其他航空公司代碼<input name="alExtra" value="${esc(other.join(', '))}" placeholder="例如 SQ, NH" autocomplete="off" autocapitalize="characters"></label>
    <p class="acct-err" role="alert" hidden></p>
    <div class="pass-actions">${r.id ? '<button type="button" class="outline" data-dr-cancel>取消</button>' : ''}<button type="submit" class="primary small">${r.id ? '儲存修改' : '加入這條'}</button></div>
  </form>`;
}

function drRender(d, note = '') {
  const body = $('#dr-body');
  const rules = d.rules || [];
  body.innerHTML = `<h2 id="dr-title">🎯 我的條件通知</h2>
    <p class="hint">今日好康每天早晚各更新一次，每次都會用你的條件比對<b>全部</b>查到的位子（不只最便宜的那幾筆），不會多用查詢。符合的同一筆只通知一次，並在今日好康最上面標出來。</p>
    <section class="acct-sec"><h3>我的條件（${rules.length}／${d.max || 10}）</h3>
      ${rules.length ? `<ul class="alert-list dr-list">${rules.map((r) => `<li data-rid="${esc(r.id)}"><div><b>${esc(r.label)}</b></div><div class="alert-actions"><button type="button" class="outline" data-dr-edit="${esc(r.id)}">修改</button><button type="button" class="outline" data-dr-del="${esc(r.id)}">刪除</button></div></li>`).join('')}</ul>` : '<p class="hint">還沒有條件。例如：歐洲・商務艙・8 萬哩內・長榮或星宇自家飛・至少 2 位。</p>'}
      ${rules.length < (d.max || 10) ? `<details class="alert-pick dr-add"${rules.length ? '' : ' open'}><summary>＋ 新增條件</summary>${drFormHtml()}</details>` : ''}
    </section>
    <section class="acct-sec"><h3>傳到哪裡</h3>
      <label class="chk"><input type="checkbox" data-ch="telegram" ${d.telegram ? 'checked' : ''}><span>Telegram</span></label>
      <label class="chk"><input type="checkbox" data-ch="line" ${d.line ? 'checked' : ''}><span>LINE <small class="muted">（每月免費則數有限）</small></span></label>
      <label class="field">Email（選填${d.mail === false ? '；網站還沒設定寄信服務' : ''}）<span class="dr-mail"><input type="email" name="dr-email" value="${esc(d.email || '')}" placeholder="you@example.com" autocomplete="email"><button type="button" class="outline" data-dr-mail>儲存</button></span></label>
      ${notifyLineHtml()}
    </section>
    <p class="acct-err dr-note" role="alert" ${note ? '' : 'hidden'}>${esc(note)}</p>`;
  const done = (r, msg) => { drState.data = r; drState.at = Date.now(); drRender(r); if (msg) toast(msg); };
  const fail = (e, at = $('.dr-note', body)) => { at.textContent = e.message; at.hidden = false; };
  const bindForm = (f) => {
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const airlines = [...$$('input[name="dr-al"]:checked', f).map((i) => i.value), ...f.alExtra.value.toUpperCase().split(/[\s,，、/]+/).filter(Boolean)];
      const cap = f.maxMiles.value.replace(/[\s,，]/g, '');
      const wan = /^(\d+(?:\.\d+)?)萬$/.exec(cap);
      const rule = { id: f.dataset.id || undefined, region: f.region.value, cabin: f.cabin.value, maxMiles: wan ? Math.round(Number(wan[1]) * 1e4) : cap, minSeats: f.minSeats.value, from: f.from.value, to: f.to.value, airlines };
      const end = busy($('button[type=submit]', f), '儲存中…');
      try { done(await drCall('/api/dealrules', { body: rule }), f.dataset.id ? '已更新條件' : '已加入條件，下次今日好康更新時開始比對'); } catch (err) { end(); fail(err, $('.acct-err', f)); }
    });
    $('[data-dr-cancel]', f)?.addEventListener('click', () => drRender(drState.data));
  };
  $$('.dr-form', body).forEach(bindForm);
  $$('[data-dr-edit]', body).forEach((b) => b.addEventListener('click', () => {
    const r = rules.find((x) => x.id === b.dataset.drEdit);
    const li = b.closest('li');
    $$('.dr-list .dr-form', body).forEach((x) => x.remove());
    li.insertAdjacentHTML('beforeend', drFormHtml(r));
    bindForm($('.dr-form', li));
    $('select', li).focus();
  }));
  $$('[data-dr-del]', body).forEach((b) => b.addEventListener('click', async () => {
    const r = rules.find((x) => x.id === b.dataset.drDel);
    if (!confirm(`刪除這個條件？\n${r?.label || ''}`)) return;
    try { done(await drCall(`/api/dealrules?id=${encodeURIComponent(b.dataset.drDel)}`, { method: 'DELETE' }), '已刪除條件'); } catch (err) { fail(err); }
  }));
  $$('[data-ch]', body).forEach((c) => c.addEventListener('change', async () => {
    c.disabled = true;
    try { done(await drCall('/api/dealrules/channels', { body: { [c.dataset.ch]: c.checked } })); } catch (err) { c.checked = !c.checked; c.disabled = false; fail(err); }
  }));
  $('[data-dr-mail]', body).addEventListener('click', async (e) => {
    const end = busy(e.currentTarget, '儲存中…');
    try { done(await drCall('/api/dealrules/channels', { body: { email: $('input[name="dr-email"]', body).value.trim() } }), '已儲存 Email'); } catch (err) { end(); fail(err); }
  });
}

// renderDeals may have drawn 今日好康 before this script loaded.
if ($('#deals .deals-head')) dealRulesMount($('#deals'));
