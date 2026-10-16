// 哪裡都好 (區域探索, round 6 extra X3; the owner's only): from one to three airports, every program's cheapest award
// seat to every destination of the regions picked (今日好康's 北美, 歐洲, 日韓, 東南亞, 澳紐, from /api/anywhere/regions),
// one seats.aero search per region (server lib/anywhere.js: at most 2 calls each, 10 a press, cached 30 minutes).
// A fold under the explore form, shown only on the owner's device (ownerHere(), the 帳號管理 gate) and folded at first;
// each row opens 航線查詢 on that route and day (applyShare), which is one more search.
// Classic script after notify.js, using app.js, features.js and account.js globals ($, $$, esc, fmt, api, cashApi,
// toast, ownerHere, updateLockHint, createDatePicker, applyShare, srcName, airportCity, dayLabel, taxText, CABIN_LABEL).
// The pure helpers come first; the tests load them with require().

// ---------- pure helpers ----------
// The button's words for `n` regions picked: each region is one search (two when its answer is long).
const awButtonText = (n) => (n ? `開始查（用約 ${n} 次查詢）` : '開始查（先選區域）');
// "tpe, khh nrt" → ["TPE", "KHH", "NRT"]; null when any part is not an airport code or there are more than three.
function awOrigins(s) {
  const list = [...new Set(String(s || '').toUpperCase().split(/[\s,，、]+/).filter(Boolean))];
  return list.length && list.length <= 3 && list.every((c) => /^[A-Z]{3}$/.test(c)) ? list : null;
}

// ---------- the page ----------
const aw = { regions: null, picker: null, busy: false, last: null };
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
    <fieldset class="aw-regions"><legend>區域</legend>${aw.regions.map((r) => `<label class="chk"><input type="checkbox" name="region" value="${esc(r.id)}"><span>${esc(r.name)}</span><small>${esc(r.destinations.join('、'))}</small></label>`).join('')}</fieldset>
    <div class="aw-go"><button type="submit" class="primary" disabled>${awButtonText(0)}</button><small class="hint">每個區域查 1 次，結果多時最多 2 次；30 分鐘內查過的不再用額度。</small></div>
  </form><div id="aw-out"></div>`;
  const f = $('#aw-form', body);
  aw.picker = createDatePicker(f, '出發日期');
  const count = () => $$('input[name=region]:checked', f).length;
  f.addEventListener('change', () => {
    const btn = $('button[type=submit]', f);
    btn.textContent = awButtonText(count());
    btn.disabled = !count() || aw.busy;
  });
  f.addEventListener('submit', (e) => { e.preventDefault(); awRun(f); });
}
async function awRun(f) {
  const origins = awOrigins(f.origin.value);
  if (!origins) { toast('出發機場請填 3 碼代號，最多 3 個，例如 TPE 或 TPE,KHH'); return f.origin.focus(); }
  if (!f.start.value) { toast('請先選出發日期'); return $('.dp-btn', f).click(); }
  const regions = $$('input[name=region]:checked', f).map((i) => i.value);
  if (!regions.length || aw.busy) return;
  const cabin = f.cabin.value || 'J';
  const out = $('#aw-out');
  const btn = $('button[type=submit]', f);
  aw.busy = true;
  btn.disabled = true;
  out.innerHTML = `<p class="hint">正在查 ${regions.length} 個區域…（約 10–30 秒）</p>`;
  try {
    const q = new URLSearchParams({ origin: origins.join(','), start: f.start.value, end: f.end.value || f.start.value, cabin, regions: regions.join(',') });
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
  out.innerHTML = `<p class="hint aw-sum">從 ${esc(r.origins.join('、'))}・${esc(range)}・${esc(CABIN_LABEL[r.cabin])}：${used}。點一列會到「航線查詢」查那一天（再用 1 次查詢）。</p>
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

if (typeof module === 'object' && module.exports) module.exports = { awButtonText, awOrigins };
else {
  awMount();
  awFollow();
  // updateLockHint runs once the page knows about the passcode and the account, and again whenever either changes.
  const awBase = updateLockHint;
  updateLockHint = function () { awBase(); awFollow(); };
  document.addEventListener('click', awGo);
  document.addEventListener('keydown', awGo);
}
