// 飯店點數房提醒 (round 6, N13): on 查飯店 the owner watches one hotel, or the whole search, for its check-in dates; the
// daily run asks rooms.aero once per watch and tells them (email, Telegram, LINE) when a points night opens or drops to
// their per-night ceiling (lib/hotelwatch.js). Behind the passcode like 機位提醒. Classic script after hotels.js; uses
// its globals (hotelState, hotelDate, searchHotels, HOTEL_SHORT) and app.js's (cashApi, passNeeded, lockNoteHtml…).

const HW_PASS = '飯店點數房提醒';
// The owner's device: the hotel cards get their own 🔔 button only here (visitors cannot set one anyway).
const hwOwner = () => !cashCfg.locked || Boolean(store.get(PASS_KEY, '')) || Boolean(typeof acct === 'object' && acct.status?.unlocked);
const hwRange = (start, end) => `${mmdd(start)}${end !== start ? `–${mmdd(end)}` : ''} 入住`;
const hwChains = (list) => list.map((p) => HOTEL_SHORT[p] || p).join('、');
const hwTitle = (w) => (w.kind === 'hotel' ? w.name : `${w.label || w.where}（${hwChains(w.programs)}）`);
const hwUnit = (kind) => (kind === 'hotel' ? '個入住日' : '家飯店');

function hwPanelHtml() {
  if (!cashCfg.hotelWatch) return '';
  return `<details class="alerts-panel" id="hw-panel">
      <summary>🔔 飯店點數房提醒 <span id="hw-count"></span></summary>
      <div id="hw-body" class="alerts-body"><p class="hint">載入中…</p></div>
    </details>`;
}
const hwBarButton = () => (cashCfg.hotelWatch ? '<button type="button" class="outline small" data-hw-area>🔔 有點數房時通知我</button>' : '');
const hwCardButton = (h) => (cashCfg.hotelWatch && hwOwner() ? `<button type="button" class="outline hw-bell" data-hw-hotel="${esc(h.id)}" aria-expanded="false" aria-label="有點數房時提醒我" title="有點數房時提醒我">🔔<span> 提醒我</span></button>` : '');

// The form for a new watch: the search's dates and nights as they are, a points ceiling and an address, both optional.
function hwFormHtml(t) {
  const p = hotelState.params;
  const what = t.kind === 'hotel' ? t.name : `${hotelState.where}（${hwChains(p.programs.split(','))}）`;
  return `<form class="hw-form" data-kind="${t.kind}" data-id="${esc(t.id || '')}">
      <p class="hw-what"><b>🔔 ${esc(what)}</b><small>${hwRange(p.start, p.end)}・${p.nights} 晚</small></p>
      <div class="hw-row">
        <label class="hw-max">每晚最多<input type="number" name="maxPoints" inputmode="numeric" min="1000" max="500000" step="500" placeholder="不限">點</label>
        <input type="email" name="email" placeholder="通知信箱（可留空）" autocomplete="email" value="${esc(store.get(ALERT_EMAIL_KEY, ''))}" aria-label="通知信箱">
      </div>
      <div class="hw-row"><button type="submit" class="primary small">建立提醒（用 1 次查詢）</button><button type="button" class="outline" data-hw-cancel>取消</button></div>
      <p class="hint">每天早上檢查一次，${t.kind === 'hotel' ? '這段日期' : '這次搜尋的飯店'}有新的點數房（或降到上限以下）就通知；現在已有的不會通知。每個提醒每天用 1 次 rooms.aero 查詢（飯店點數的額度，不佔機位查詢），最多 5 個。</p>
    </form>`;
}
function hwOpenForm(slot, t, btn) {
  if (!slot.hidden && $('.hw-form', slot)) { slot.hidden = true; slot.innerHTML = ''; btn?.setAttribute('aria-expanded', 'false'); return; }
  slot.hidden = false;
  slot.innerHTML = hwFormHtml(t);
  btn?.setAttribute('aria-expanded', 'true');
  $('[name=maxPoints]', slot).focus();
}
async function hwSubmit(f) {
  const p = hotelState.params;
  const slot = f.parentElement;
  const hotel = f.dataset.kind === 'hotel' ? hotelState.results?.hotels.find((x) => x.id === f.dataset.id) : null;
  if (f.dataset.kind === 'hotel' && !hotel) return toast('找不到這家飯店，請重新搜尋');
  const btn = $('button[type=submit]', f);
  btn.disabled = true;
  try {
    const email = f.email.value.trim();
    store.set(ALERT_EMAIL_KEY, email);
    const body = await cashApi('/api/hotel-watch', { pass: HW_PASS, method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: f.dataset.kind, ...(hotel ? { hotelId: hotel.id, name: hotel.name, source: hotel.source } : { programs: p.programs.split(',') }),
        where: p.where, label: hotelState.where, start: p.start, end: p.end, nights: p.nights, date: p.date, flex: p.flex, maxPoints: Number(f.maxPoints.value) || 0, email }) });
    const w = body.watch;
    slot.innerHTML = `<p class="status">🔔 ${body.duplicate ? '一樣的提醒已經有了，不用再建一次。' : `已建立提醒，現在有 ${fmt(body.found)} ${hwUnit(w.kind)}符合，之後只通知新出現的。`}${w.email ? '' : '沒填信箱：有連結 Telegram／LINE 就傳到那裡，也會顯示在「飯店點數房提醒」。'}</p>`;
    $$('[data-hw-hotel][aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
    hwLoad();
  } catch (err) {
    toast(err.message);
    btn.disabled = false;
  }
}

function hwItemHtml(w) {
  const best = w.best ? `，最少 ${fmt(w.best.points)} 點（${w.best.name ? `${esc(w.best.name)} ` : ''}${mmdd(w.best.date)} 入住）` : '';
  return `<li>
      <div><b>${w.kind === 'hotel' && HOTEL_SHORT[w.source] ? `<span class="pill h-${esc(w.source)}">${esc(HOTEL_SHORT[w.source])}</span> ` : ''}${esc(hwTitle(w))}</b>
        <small>${hwRange(w.start, w.end)}・${w.nights} 晚${w.maxPoints ? `・每晚 ${fmt(w.maxPoints)} 點以下` : '・有點數房就通知'}</small><small>${w.email ? `→ ${esc(w.email)}` : '不寄信，只用 Telegram／LINE 和網站'}</small></div>
      <div class="hint">${w.lastRun ? `${ago(w.lastRun)}檢查：符合 ${fmt(w.lastFound ?? 0)} ${hwUnit(w.kind)}${best}${w.lastNew ? `，<b class="new">新增 ${w.lastNew} 筆</b>` : ''}` : '尚未檢查'}${w.lastError ? `　⚠ ${esc(w.lastError)}` : ''}</div>
      <div class="alert-actions"><button type="button" class="outline" data-hw-open="${esc(w.id)}">查看</button><button type="button" class="outline" data-hw-del="${esc(w.id)}">刪除</button></div>
    </li>`;
}
let hwList = [];
async function hwLoad() {
  const panel = $('#hw-panel');
  const box = $('#hw-body');
  if (!panel || !box || !panel.open) return;
  if (passNeeded()) {
    box.innerHTML = lockNoteHtml(HW_PASS);
    $('[data-unlock]', box).addEventListener('click', () => unlockFor(HW_PASS, hwLoad));
    return;
  }
  box.innerHTML = '<p class="hint">載入中…</p>';
  try {
    const body = await cashApi('/api/hotel-watch', { pass: HW_PASS });
    hwList = body.watches || [];
    $('#hw-count').textContent = hwList.length ? `（${hwList.length}）` : '';
    box.innerHTML = (hwList.length ? `<ul class="alert-list">${hwList.map(hwItemHtml).join('')}</ul>` : '<p class="hint">還沒有提醒。搜尋飯店後，按結果上方的「🔔 有點數房時通知我」，或飯店卡片上的「🔔 提醒我」。</p>')
      + `<div class="alert-foot">${hwList.length ? `<button type="button" class="outline" data-hw-run>立即檢查全部（用 ${hwList.length} 次查詢）</button>` : ''}<span class="hint">每天早上 8 點多（台灣時間）自動檢查${body.email ? '並寄信' : ''}，每個提醒用 1 次 rooms.aero 查詢；最多 ${body.max || 5} 個${body.used ? `。今天的檢查用了 ${body.used}／${body.cap} 次` : ''}。</span></div>`;
  } catch (err) {
    box.innerHTML = `<p class="status error">${esc(err.message)}</p>`;
  }
}
// 查看: the watch's search on the form again (only its chains, so 雅高 spends nothing), then its hotel in view.
async function hwShow(w) {
  const f = $('#hotel-form');
  if (!f) return;
  const today = isoDate(0);
  const date = w.date && w.date >= today ? w.date : w.start > today ? w.start : today;
  f.where.value = w.label || w.where;
  hotelDate.set(date);
  f.flex.value = String(date === w.date ? w.flex : 0);
  f.nights.value = String(w.nights);
  $$('input[name=h-prog]', f).forEach((i) => { i.checked = w.kind === 'hotel' ? i.value === w.source : w.programs.includes(i.value); });
  $('#hw-panel').open = false;
  await searchHotels();
  const card = w.kind === 'hotel' && $(`.hotel[data-hotel="${CSS.escape(w.hotelId)}"]`);
  if (card) { card.classList.add('hw-hit'); card.scrollIntoView({ block: 'center' }); }
}

document.addEventListener('click', async (e) => {
  const t = e.target.closest?.('[data-hw-area], [data-hw-hotel], [data-hw-cancel], [data-hw-open], [data-hw-del], [data-hw-run]');
  if (!t) return;
  if (t.matches('[data-hw-area]')) return hwOpenForm($('#hw-slot'), { kind: 'area' });
  if (t.matches('[data-hw-hotel]')) {
    const h = hotelState.results?.hotels.find((x) => x.id === t.dataset.hwHotel);
    if (h) hwOpenForm($('.hotel-watch', t.closest('.hotel')), { kind: 'hotel', id: h.id, name: h.name }, t);
    return;
  }
  if (t.matches('[data-hw-cancel]')) {
    const slot = t.closest('form').parentElement;
    slot.innerHTML = '';
    slot.hidden = slot.id !== 'hw-slot';
    slot.closest('.hotel')?.querySelector('[data-hw-hotel]')?.setAttribute('aria-expanded', 'false');
    return;
  }
  const w = hwList.find((x) => x.id === (t.dataset.hwOpen || t.dataset.hwDel));
  if (t.matches('[data-hw-open]') && w) return hwShow(w);
  if (t.matches('[data-hw-del]') && w) {
    if (!confirm(`刪除這個飯店提醒？\n${hwTitle(w)}`)) return;
    try { await cashApi(`/api/hotel-watch?id=${encodeURIComponent(w.id)}`, { pass: HW_PASS, method: 'DELETE' }); toast('已刪除提醒'); hwLoad(); } catch (err) { toast(err.message); }
    return;
  }
  if (t.matches('[data-hw-run]')) {
    t.disabled = true;
    t.textContent = '檢查中…';
    try {
      const r = await cashApi('/api/alerts/run?part=hotels', { pass: HW_PASS });
      const rep = r.hotels?.report || [];
      const fresh = rep.reduce((n, x) => n + (x.fresh || 0), 0);
      const capped = rep.some((x) => x.skipped === 'cap');
      toast(r.hotels?.error || (fresh ? `檢查完成，有 ${fresh} 筆新的點數房` : capped ? '今天的檢查次數用完了，明天早上再自動檢查' : '檢查完成，沒有新的點數房'));
      hwLoad();
    } catch (err) { toast(err.message); t.disabled = false; }
  }
});
document.addEventListener('submit', (e) => {
  const f = e.target.closest?.('.hw-form');
  if (!f) return;
  e.preventDefault();
  hwSubmit(f);
});
document.addEventListener('toggle', (e) => { if (e.target.id === 'hw-panel' && e.target.open) hwLoad(); }, true);
