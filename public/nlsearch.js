// 一句話搜尋: a one-line box above the 航線查詢 form. The sentence goes to /api/nl (GPT-6 Luna or Claude Haiku on the server, a demo
// parser in demo mode); what comes back fills the form and shows as a row of chips the owner can click to fix or
// remove. Parsing spends no seats.aero: the search still runs only when 搜尋機位 is pressed.
// Shown only when the server has it on (config.nl, i.e. OPENAI_API_KEY or ANTHROPIC_API_KEY is set) and on the owner's
// device (the passcode stored here or an unlocked account), like 帳號管理. Classic script loaded after features.js; uses app.js's
// globals ($, $$, esc, store, PASS_KEY, cashCfg, cashApi, pickers, datePickers, setCabin, carrierHint, loadAirports, AP,
// toast, showTab, state, refreshPrograms, srcName, ymd, CABIN_SHORT, updateLockHint).

const nl = { on: false, busy: false, result: null, programs: [], ret: null, leg: 'out', armed: false };
const NL_OPEN_KEY = 'nlOpen'; // true after the first use, then whatever the owner last left it as
const NL_PAX_MAX = 5; // the form's 人數 menu goes up to 「至少 5 位」
const NL_ALLIANCE = { star: '星空聯盟', skyteam: '天合聯盟', oneworld: '寰宇一家' };

const nlOwnerHere = () => Boolean(store.get(PASS_KEY, '') || (typeof acct !== 'undefined' && acct.status?.unlocked) || (!cashCfg.locked && !$('#mock-banner').hidden));

// Called by app.js once /api/config has answered.
function nlInit(config) {
  nl.on = Boolean(config.nl);
  if (!nl.on) return;
  // Entering or clearing the passcode, or an account unlocking, shows or hides the box.
  const base = updateLockHint;
  updateLockHint = function () { base(); nlRender(); };
  const form = $('#search-form');
  form.addEventListener('change', () => { if (nl.result) nlChips(); });
  form.addEventListener('submit', () => { nl.armed = Boolean(nl.result && nl.programs.length); });
  document.addEventListener('search:done', nlFilterPrograms);
  nlRender();
}

function nlRender() {
  const box = $('#nl-card');
  if (!nl.on || !nlOwnerHere()) { box?.remove(); return; }
  if (box) return;
  // One line until opened, so the form's 搜尋機位 stays on a phone's first screen; it opens by itself once it has been
  // used (and stays the way the owner last left it).
  $('#search-form').insertAdjacentHTML('beforebegin', `<details class="nl-card" id="nl-card" ${store.get(NL_OPEN_KEY, false) ? 'open' : ''}>
    <summary class="nl-head"><b id="nl-title">✨ 一句話找機票</b><span>用中文描述就好，會幫你填好下面的條件</span></summary>
    <form class="nl-row" id="nl-form" autocomplete="off">
      <input id="nl-q" type="text" maxlength="100" enterkeyhint="go" aria-labelledby="nl-title"
        placeholder="用一句話說你想怎麼飛，例如：明年過年台北飛東京商務艙">
      <button type="submit" class="primary">幫我填</button>
    </form>
    <div class="nl-chips" id="nl-chips" hidden></div>
    <p class="nl-msg" id="nl-msg" aria-live="polite"></p>
  </details>`);
  $('#nl-card').addEventListener('toggle', (e) => store.set(NL_OPEN_KEY, e.target.open));
  // Opened by a tap: straight to the box (a click comes before the details opens).
  $('#nl-card > summary').addEventListener('click', () => { if (!$('#nl-card').open) setTimeout(() => $('#nl-q')?.focus(), 0); });
  $('#nl-form').addEventListener('submit', nlParse);
  $('#nl-chips').addEventListener('click', nlChipClick);
  $('#nl-msg').addEventListener('click', (e) => { if (e.target.closest('[data-explore]')) nlToExplore(); });
}

function nlMsg(html, kind = '') {
  const el = $('#nl-msg');
  el.className = `nl-msg${kind ? ` ${kind}` : ''}`;
  el.innerHTML = html;
}

async function nlParse(e) {
  e.preventDefault();
  if (nl.busy) return;
  const text = $('#nl-q').value.trim();
  if (!text) { nlMsg('請先輸入一句話，例如：十二月兩個人去大阪，經濟艙直飛就好', 'err'); return; }
  const btn = $('#nl-form button');
  nl.busy = true;
  btn.disabled = true;
  btn.textContent = '解析中…';
  nlMsg('');
  try {
    const [r] = await Promise.all([
      cashApi('/api/nl', { pass: '一句話搜尋', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }),
      loadAirports(),
    ]);
    nlApply(r);
  } catch (err) {
    nlMsg(esc(err.message || '解析失敗，請再試一次'), 'err');
  } finally {
    nl.busy = false;
    btn.disabled = false;
    btn.textContent = '幫我填';
  }
}

const nlLeft = (r) => (r.limit ? `今天還可以用 ${Math.max(0, r.limit - (r.used || 0))} 次。` : '');

function nlApply(r) {
  if (r.vague) {
    Object.assign(nl, { result: null, programs: [], ret: null, armed: false, vague: r });
    $('#nl-chips').hidden = true;
    const missed = r.dropped?.length ? ` 沒看懂的部分：${r.dropped.map(esc).join('、')}。` : '';
    nlMsg(`${esc(r.message)}${missed}${r.region ? ' <button type="button" class="linkish" data-explore>到區域探索</button>' : ''} <small>${esc(nlLeft(r))}</small>`);
    return;
  }
  store.set(NL_OPEN_KEY, true);
  const f = $('#search-form');
  // The sentence describes the whole search: what it leaves out goes back to the form's defaults (cabin excepted,
  // which stays as last used).
  pickers.origin.set(r.origin || []);
  pickers.destination.set(r.destination || []);
  datePickers.search.set(r.start || '', r.end || r.start || '');
  if (r.cabin) setCabin(r.cabin);
  f.alliance.value = r.alliance || '';
  f.carrier.value = '';
  f.pax.value = r.pax >= 2 ? String(Math.min(r.pax, NL_PAX_MAX)) : '';
  f.direct.checked = Boolean(r.direct);
  carrierHint();
  Object.assign(nl, { result: r, programs: [...(r.programs || [])], ret: r.returnStart ? { start: r.returnStart, end: r.returnEnd } : null, out: r.start ? { start: r.start, end: r.end } : null, leg: 'out', armed: false });
  nlChips();
  const notes = [];
  if (r.dropped?.length) notes.push(`沒看懂的部分：${r.dropped.map(esc).join('、')}，請直接在表單補上。`);
  if (r.pax > NL_PAX_MAX) notes.push(`人數選單最多到「至少 ${NL_PAX_MAX} 位」。`);
  if (!r.start) notes.push('句子沒提到日期，搜尋時會先查未來 1 個月。');
  nlMsg(`已填進下方表單，確認無誤再按「搜尋機位」；點標籤或直接改表單都可以。${notes.join('')}${r.mock ? '（示範解析）' : ''} <small>${esc(nlLeft(r))}</small>`);
}

// Chips follow the form as it is now (the owner may have changed it since), plus the two things the form has no
// field for: the programs (applied to the results) and the return leg of a round trip.
function nlChips() {
  const f = $('#search-form');
  const chip = (k, label, value, { rm = true, title = '' } = {}) => `<span class="nl-chip"><button type="button" class="nl-go" data-go="${k}"${title ? ` title="${esc(title)}"` : ''}><small>${label}</small>${value}</button>${rm ? `<button type="button" class="nl-x" data-rm="${k}" aria-label="移除${label}">×</button>` : ''}</span>`;
  const place = (codes) => {
    if (!codes.length) return '';
    const g = codes.length > 1 && AP.groups.find((x) => codes.every((c) => x.codes.includes(c)));
    const a = AP.byCode.get(codes[0]);
    const name = g ? g.zh : codes.length === 1 && a ? a.zh || a.city : '';
    return `<b>${codes.map(esc).join('・')}</b>${name ? ` ${esc(name)}` : ''}`;
  };
  const r = nl.result;
  const o = pickers.origin.codes();
  const d = pickers.destination.codes();
  const s = f.start.value;
  const e = f.end.value || s;
  const sameDates = nl.out && nl.leg === 'out' && s === nl.out.start && e === nl.out.end;
  const parts = [];
  if (o.length) parts.push(chip('origin', '出發', place(o) + (r.defaults?.includes('origin') && o.join() === 'TPE' ? ' <small>（預設）</small>' : '')));
  if (d.length) parts.push(chip('destination', '抵達', place(d)));
  if (s) parts.push(chip('date', nl.leg === 'back' ? '回程日期' : '日期', esc(sameDates && r.dateLabel ? r.dateLabel : `${ymd(s)}${e !== s ? ` – ${ymd(e)}` : ''}`), { title: `${s} – ${e}` }));
  const cabin = $('#search-form input[name=cabin]:checked')?.value;
  if (cabin) parts.push(chip('cabin', '艙等', esc(CABIN_SHORT[cabin]), { rm: false }));
  if (f.alliance.value) parts.push(chip('alliance', '聯盟', esc(NL_ALLIANCE[f.alliance.value] || f.alliance.value)));
  if (f.pax.value) parts.push(chip('pax', '人數', `至少 ${esc(f.pax.value)} 位`));
  if (f.direct.checked) parts.push(chip('direct', '直飛', '只看直飛'));
  for (const p of nl.programs) parts.push(chip(`program:${p}`, '計畫', esc(srcName(p)), { title: '搜尋後只列出這個計畫的座位（結果頁可以再勾選其他計畫）' }));
  if (nl.ret) {
    const other = nl.leg === 'out' ? nl.ret : nl.out;
    const dates = other ? `${ymd(other.start)}${other.end !== other.start ? ` – ${ymd(other.end)}` : ''}` : '';
    parts.push(`<span class="nl-chip nl-leg"><button type="button" class="nl-go" data-go="leg"><small>${nl.leg === 'out' ? '回程' : '去程'}</small>${esc(dates)}<span class="nl-act">${nl.leg === 'out' ? '改查回程' : '改查去程'}</span></button></span>`);
  }
  const box = $('#nl-chips');
  box.innerHTML = parts.join('');
  box.hidden = !parts.length;
}

function nlChipClick(e) {
  const f = $('#search-form');
  const rm = e.target.closest('[data-rm]')?.dataset.rm;
  if (rm) {
    if (rm === 'origin' || rm === 'destination') pickers[rm].set([]);
    else if (rm === 'date') datePickers.search.set('');
    else if (rm === 'alliance') { f.alliance.value = ''; carrierHint(); }
    else if (rm === 'pax') f.pax.value = '';
    else if (rm === 'direct') f.direct.checked = false;
    else if (rm.startsWith('program:')) nl.programs = nl.programs.filter((p) => `program:${p}` !== rm);
    nlChips();
    return;
  }
  const go = e.target.closest('[data-go]')?.dataset.go;
  if (!go) return;
  if (go === 'origin' || go === 'destination') $(`#f-${go}`).focus();
  else if (go === 'date') $('#search-form .dp-btn').click();
  else if (go === 'cabin') $('#search-form input[name=cabin]:checked')?.focus();
  else if (go === 'alliance' || go === 'pax' || go === 'direct') f[go].focus();
  else if (go.startsWith('program:')) toast('搜尋後只列出這個計畫的座位；不要的話按 × 取消');
  else if (go === 'leg') nlSwapLeg();
}

// A round trip: the form searches one way at a time, so the chip swaps the route and dates to the other leg.
function nlSwapLeg() {
  const o = pickers.origin.codes();
  const d = pickers.destination.codes();
  const to = nl.leg === 'out' ? nl.ret : nl.out;
  pickers.origin.set(d);
  pickers.destination.set(o);
  if (to) datePickers.search.set(to.start, to.end);
  nl.leg = nl.leg === 'out' ? 'back' : 'out';
  nlChips();
  toast(`已換成${nl.leg === 'back' ? '回程' : '去程'}，按「搜尋機位」查詢`);
}

// After the search the owner started from a parsed sentence: only the named programs stay ticked.
function nlFilterPrograms() {
  if (!nl.armed) return;
  nl.armed = false;
  const want = new Set(nl.programs.flatMap((p) => (p === 'asiamiles' ? ['asiamiles', 'asiamiles_est'] : [p])));
  const all = [...new Set(state.results.map((r) => r.source))];
  if (!all.some((s) => want.has(s))) {
    if (all.length) toast(`這次結果沒有${nl.programs.map(srcName).join('、')}的座位，先列出全部計畫`);
    return;
  }
  state.hidden = new Set(all.filter((s) => !want.has(s)));
  refreshPrograms('');
}

// Too broad a destination (「想去歐洲」): 區域探索 with that region picked, dates and cabin carried over; nothing runs
// until 開始探索 is pressed.
function nlToExplore() {
  const f = $('#explore-form');
  const r = nl.vague || {};
  if (r.region) f.destination_region.value = r.region;
  f.origin_region.value = 'Asia';
  if (r.start) datePickers.explore.set(r.start, r.end);
  if (r.cabin) setCabin(r.cabin);
  const prog = (r.programs || []).find((p) => $(`option[value="${p}"]`, f.program));
  if (prog) f.program.value = prog;
  showTab('explore');
  f.scrollIntoView({ block: 'center' });
  toast('已選好區域，按「開始探索」查詢');
}
