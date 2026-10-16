// 哪裡都好 (區域探索, round 6 extra X3; the owner's only): from one to three airports, every program's cheapest award
// seat to every destination of the regions picked (今日好康's 北美, 歐洲, 日韓, 東南亞, 澳紐, from /api/anywhere/regions),
// one seats.aero search per region (server lib/anywhere.js: at most 2 calls each, 10 a press, cached 30 minutes).
// A fold under the explore form, shown only on the owner's device (ownerHere(), the 帳號管理 gate) and folded at first;
// each row opens 航線查詢 on that route and day (applyShare), which is one more search.
// Classic script after notify.js, using app.js, features.js and account.js globals ($, $$, esc, fmt, api, cashApi,
// toast, ownerHere, updateLockHint, createDatePicker, applyShare, srcName, airportCity, dayLabel, taxText, CABIN_LABEL,
// SOURCE_NAMES, and reach() for the programs 我的點數 can pay).
// The pure helpers come first; the tests load them with require().

// ---------- pure helpers ----------
// The button's words for `n` regions picked: each region is one search (two when its answer is long).
const awButtonText = (n) => (n ? `開始查（用約 ${n} 次查詢）` : '開始查（先選區域）');
// "tpe, khh nrt" → ["TPE", "KHH", "NRT"]; null when any part is not an airport code or there are more than three.
function awOrigins(s) {
  const list = [...new Set(String(s || '').toUpperCase().split(/[\s,，、]+/).filter(Boolean))];
  return list.length && list.length <= 3 && list.every((c) => /^[A-Z]{3}$/.test(c)) ? list : null;
}
// The programs to offer: every seats.aero program the site names (not the site's own estimates such as asiamiles_est),
// the ones you hold miles in first (biggest first), then those your card points transfer to, then the rest by name.
// Two seats.aero ids with one name (copa and connectmiles) are one row whose id lists both.
// `reachOf(id)` → { own, total } miles (我的點數). → [{ id: 'a' or 'a,b', name, own, total }]
function awProgramList(names, reachOf) {
  const rows = new Map();
  for (const [id, name] of Object.entries(names || {})) {
    if (!/^[a-z]+$/.test(id)) continue;
    const r = { own: 0, total: 0, ...reachOf(id) };
    const row = rows.get(name);
    if (row) Object.assign(row, { id: `${row.id},${id}`, own: Math.max(row.own, r.own), total: Math.max(row.total, r.total) });
    else rows.set(name, { id, name, own: r.own, total: r.total });
  }
  return [...rows.values()].sort((a, b) => b.own - a.own || b.total - a.total || a.name.localeCompare(b.name, 'zh-Hant'));
}

// ---------- the page ----------
const aw = { regions: null, picker: null, busy: false, last: null };
// 「只看我勾的計畫」 and the programs ticked, kept on this device (null: not chosen yet → the wallet's programs).
const AW_PROG_KEY = 'aw:progs:v1';
const awProgSaved = () => { try { return JSON.parse(localStorage.getItem(AW_PROG_KEY)) || null; } catch { return null; } };
const awProgSave = (x) => { try { localStorage.setItem(AW_PROG_KEY, JSON.stringify(x)); } catch { /* not kept */ } };
const awReach = (id) => (typeof reach === 'function' && data.points?.calc ? reach(id) : { own: 0, total: 0 });
function awMount() {
  const form = $('#explore-form');
  if (!form || $('#aw-panel')) return;
  form.insertAdjacentHTML('afterend', `<details class="alerts-panel" id="aw-panel" hidden><summary>🌏 哪裡都好 <span>（只有你能用）</span></summary><div id="aw-body" class="alerts-body"></div></details>`);
  $('#aw-panel').addEventListener('toggle', (e) => { if (e.target.open) awOpen(); });
}
// Shown on the owner's device only; follows the passcode as it is entered or cleared.
function awFollow() {
  const panel = $('#aw-panel');
  if (!panel) return;
  const on = typeof ownerHere === 'function' && ownerHere();
  panel.hidden = !on;
  if (!on) panel.open = false;
}
async function awOpen() {
  const body = $('#aw-body');
  if ($('#aw-form', body)) return;
  body.innerHTML = '<p class="hint">載入中…</p>';
  try {
    aw.regions ||= (await api('/api/anywhere/regions')).regions;
    // 我的點數 needs the transfer table (the second data part) to tick the programs your points reach.
    if (typeof loadMore === 'function') await loadMore().catch(() => {});
  } catch (err) {
    body.innerHTML = `<p class="status error">${esc(err.message)}</p>`;
    return;
  }
  body.innerHTML = `<form id="aw-form" class="aw-form" novalidate>
    <p class="hint">一次查所有哩程計畫：每個區域查一次，列出每個目的地最便宜的獎勵位。</p>
    <div class="opts-row">
      <label class="field">出發機場（最多 3 個）<input name="origin" value="TPE" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="15"></label>
      <div class="field dp-field"><span>出發日期</span><button type="button" class="dp-btn" aria-haspopup="dialog"></button><input type="hidden" name="start"><input type="hidden" name="end"></div>
      <fieldset class="seg" aria-label="艙等">${['Y', 'W', 'J', 'F'].map((c) => `<label><input type="radio" name="cabin" value="${c}" ${c === 'J' ? 'checked' : ''}><span>${{ Y: '經濟', W: '豪經', J: '商務', F: '頭等' }[c]}</span></label>`).join('')}</fieldset>
    </div>
    ${awProgsHtml()}
    <fieldset class="aw-regions"><legend>區域</legend>${aw.regions.map((r) => `<label class="chk"><input type="checkbox" name="region" value="${esc(r.id)}"><span>${esc(r.name)}</span><small>${esc(r.destinations.join('、'))}</small></label>`).join('')}</fieldset>
    <div class="aw-go"><button type="submit" class="primary" disabled>${awButtonText(0)}</button><small class="hint">每個區域查 1 次，結果多時最多 2 次；30 分鐘內查過的不再用額度。</small></div>
  </form><div id="aw-out"></div>`;
  const f = $('#aw-form', body);
  aw.picker = createDatePicker(f, '出發日期');
  const count = () => $$('input[name=region]:checked', f).length;
  f.addEventListener('change', (e) => {
    if (e.target.name === 'pmode' || e.target.name === 'prog') awProgFollow(f);
    const btn = $('button[type=submit]', f);
    btn.textContent = awButtonText(count());
    btn.disabled = !count() || aw.busy;
  });
  f.addEventListener('submit', (e) => { e.preventDefault(); awRun(f); });
  f.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pall]');
    if (!b) return;
    const on = b.dataset.pall === '1';
    $$('input[name=prog]', f).forEach((i) => { i.checked = on; });
    awProgFollow(f);
  });
}
// 哩程計畫: 全部 (the default) or only the ticked ones; the list opens only for the second, already ticked with the
// programs you hold miles in (我的點數), or what you ticked last time. Card points that transfer in are noted, not ticked.
function awProgsHtml() {
  const saved = awProgSaved();
  const list = awProgramList(SOURCE_NAMES, awReach);
  const ticked = new Set(saved?.ids || list.filter((p) => p.own).map((p) => p.id));
  const mine = saved?.mode === 'mine';
  return `<fieldset class="aw-progs"><legend>哩程計畫</legend>
    <div class="seg-row"><label class="chk"><input type="radio" name="pmode" value="all" ${mine ? '' : 'checked'}><span>全部計畫</span></label>
      <label class="chk"><input type="radio" name="pmode" value="mine" ${mine ? 'checked' : ''}><span>只看我勾的計畫</span></label></div>
    <div class="aw-prog-list" ${mine ? '' : 'hidden'}>
      <p class="hint">${list.some((p) => p.own) ? '已先勾好「我的點數」裡有哩程的計畫；信用卡點數可以轉入的也標出來了，要用的話自己勾。' : '在「點數換算器 › 我的點數」填上哩程，下次會自動勾好。'}
        <button type="button" class="linklike" data-pall="1">全選</button> <button type="button" class="linklike" data-pall="0">全不選</button></p>
      <div class="aw-prog-grid">${list.map((p) => `<label class="chk"><input type="checkbox" name="prog" value="${esc(p.id)}" ${ticked.has(p.id) ? 'checked' : ''}><span>${esc(p.name)}</span>${p.own ? `<small>你有 ${fmt(p.own)} 哩</small>` : p.total ? `<small>信用卡點數可轉約 ${fmt(p.total)} 哩</small>` : ''}</label>`).join('')}</div>
    </div></fieldset>`;
}
function awProgPick(f) {
  if (f.pmode.value !== 'mine') return null;
  return $$('input[name=prog]:checked', f).flatMap((i) => i.value.split(','));
}
function awProgFollow(f) {
  const mine = f.pmode.value === 'mine';
  $('.aw-prog-list', f).hidden = !mine;
  awProgSave({ mode: mine ? 'mine' : 'all', ids: $$('input[name=prog]:checked', f).map((i) => i.value) });
}
async function awRun(f) {
  const origins = awOrigins(f.origin.value);
  if (!origins) { toast('出發機場請填 3 碼代號，最多 3 個，例如 TPE 或 TPE,KHH'); return f.origin.focus(); }
  if (!f.start.value) { toast('請先選出發日期'); return $('.dp-btn', f).click(); }
  const regions = $$('input[name=region]:checked', f).map((i) => i.value);
  if (!regions.length || aw.busy) return;
  const progs = awProgPick(f);
  if (progs && !progs.length) { toast('請至少勾一個哩程計畫，或改選「全部計畫」'); return; }
  if (progs && progs.length > 30) { toast('最多勾 30 個計畫'); return; }
  const cabin = f.cabin.value || 'J';
  const out = $('#aw-out');
  const btn = $('button[type=submit]', f);
  aw.busy = true;
  btn.disabled = true;
  out.innerHTML = `<p class="hint">正在查 ${regions.length} 個區域…（約 10–30 秒）</p>`;
  try {
    const q = new URLSearchParams({ origin: origins.join(','), start: f.start.value, end: f.end.value || f.start.value, cabin, regions: regions.join(',') });
    if (progs) q.set('programs', progs.join(','));
    aw.last = await cashApi(`/api/anywhere?${q}`, { pass: '哪裡都好' });
    awDraw(out, aw.last);
  } catch (err) {
    out.innerHTML = `<p class="status error">${esc(err.message)}</p>`;
  }
  aw.busy = false;
  btn.disabled = !regions.length;
}
function awDraw(out, r) {
  const range = `${dayLabel(r.start)}${r.end !== r.start ? ` – ${dayLabel(r.end)}` : ''}`;
  const used = r.mock ? '示範資料，沒有用到額度' : r.calls ? `這次用了 ${r.calls} 次查詢` : '30 分鐘內查過，這次沒有用到額度';
  const rows = (g) => g.items.map((x) => `<tr class="click" tabindex="0" data-aw="${esc(`${x.origin}|${x.destination}|${x.date}`)}" title="到航線查詢查這一天">
      <td><b>${esc(x.destination)}</b><small>${esc(airportCity(x.destination) || '')}${r.origins.length > 1 ? `・從 ${esc(x.origin)}` : ''}</small></td>
      <td><b>${fmt(x.miles)} 哩</b><small>${esc(srcName(x.source))}</small></td>
      <td>${esc(dayLabel(x.date))}<small>${[x.seats ? `${x.seats} 位` : '', x.direct ? '直飛' : '轉機', x.taxes ? `稅 ${esc(taxText(x.taxes))}` : ''].filter(Boolean).join('・')}</small></td></tr>`).join('');
  const only = r.programs?.length ? `・只看 ${r.programs.length > 4 ? `${r.programs.length} 個計畫` : r.programs.map((s) => esc(srcName(s))).join('、')}` : '';
  out.innerHTML = `<p class="hint aw-sum">從 ${esc(r.origins.join('、'))}・${esc(range)}・${esc(CABIN_LABEL[r.cabin])}${only}：${used}。點一列會到「航線查詢」查那一天（再用 1 次查詢）。</p>
    ${r.regions.map((g) => `<h3 class="sub">${esc(g.name)} <small>${g.items.length ? `${g.items.length} 個目的地有位，最便宜的在前` : ''}</small></h3>
      ${g.error ? `<p class="status error">${esc(g.error)}</p>` : g.items.length ? `<div class="table-wrap"><table class="aw-table"><tbody>${rows(g)}</tbody></table></div>` : '<p class="hint">這段日期沒有找到獎勵位。</p>'}
      ${g.truncated ? '<p class="hint">結果很多，只看了最便宜的一部分，可能有目的地沒列到；縮短日期可以看得更完整。</p>' : ''}`).join('')}`;
}
function awGo(e) {
  const tr = e.target.closest?.('#aw-out [data-aw]');
  if (!tr || (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ')) return;
  e.preventDefault();
  const [o, d, date] = tr.dataset.aw.split('|');
  applyShare(new URLSearchParams({ o, d, s: date, e: date, c: aw.last?.cabin || 'J' }));
}

if (typeof module === 'object' && module.exports) module.exports = { awButtonText, awOrigins, awProgramList };
else {
  awMount();
  awFollow();
  // updateLockHint runs once the page knows about the passcode and the account, and again whenever either changes.
  const awBase = updateLockHint;
  updateLockHint = function () { awBase(); awFollow(); };
  document.addEventListener('click', awGo);
  document.addEventListener('keydown', awGo);
}
