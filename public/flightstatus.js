// 查航班動態／這班過去準點率 in 我的行程 (round 6, extra X1): on each leg of the plan that has a flight number, two
// buttons: that flight's status on the leg's day (times, terminal, gate, delay) and its past punctuality, both from
// AeroDataBox on RapidAPI (server lib/flightstatus.js). Only on a click, behind the passcode like the cash fares;
// a status costs 2 units and the punctuality 6, out of the free plan's 400 a month (shared with 直飛資料).
// features.js renderPlan calls fstBind(body) once it has drawn: the buttons go into each leg's row, and an open panel
// (kept here) is drawn again after any redraw without asking again.
// Classic script after notify.js, using app.js and features.js globals ($, $$, esc, fmt, cashApi, cashCfg, passNeeded,
// plan, twDate, isoDateFrom, mmdd, dowOf, airlineZh, airlineCodeOf, airportCity, ago). The pure helpers come first;
// the tests load them with require().

// ---------- pure helpers ----------
const FST_AHEAD = 7; // as the server: live status starts about a day before the flight
const FST_PAST = 365;
const FST_UNITS = { status: 2, delays: 6 };
// The flight numbers of a leg ("BR 32 / BR 12", "CX451, CX888") → ["BR32", "BR12"], at most four.
function fstFlights(s) {
  const out = [];
  for (const part of String(s || '').toUpperCase().split(/[,/·+]|\s{2,}/)) {
    const m = /^([A-Z0-9]{2})\s?0*(\d{1,4})([A-Z]?)$/.exec(part.trim());
    if (m && /[A-Z]/.test(m[1]) && !out.includes(`${m[1]}${m[2]}${m[3]}`)) out.push(`${m[1]}${m[2]}${m[3]}`);
  }
  return out.slice(0, 4);
}
const fstDays = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5);
// Why this day cannot be asked about yet (empty when it can), worked out before any lookup.
function fstDateNote(date, today) {
  const d = fstDays(today, date);
  if (d > FST_AHEAD) return `航班動態要在出發前 ${FST_AHEAD} 天內才查得到（即時動態通常出發前一天才有），這段還有 ${d} 天，到時候再按一次。`;
  if (d < -FST_PAST) return '超過一年前的航班查不到。';
  return '';
}
// Minutes against the timetable, in words: 準時, 晚 12 分, 早 5 分, 晚 1 小時 10 分.
function fstDelayText(min) {
  if (min == null || !Number.isFinite(min)) return '';
  const a = Math.abs(min);
  if (a < 1) return '準時';
  const t = a >= 60 ? `${Math.floor(a / 60)} 小時${a % 60 ? ` ${a % 60} 分` : ''}` : `${a} 分`;
  return `${min > 0 ? '晚' : '早'} ${t}`;
}
// One side of the punctuality: 「抵達：約 77% 在表定 15 分鐘內到；一半的班次晚 12 分以內，最晚的 1/5 晚 26 分以上」.
function fstPunctText(label, s) {
  if (!s) return '';
  const verb = label === '抵達' ? '到' : '出發';
  const share = !s.onTime ? '' : s.onTime.under ? `不到 ${s.onTime.pct}% 在表定 15 分鐘內${verb}` : `${s.onTime.approx ? '約 ' : ''}${s.onTime.pct}% 在表定 15 分鐘內${verb}`;
  const med = s.median == null ? '' : s.median <= 0 ? `一半的班次${s.median < 0 ? `提早 ${-s.median} 分以上` : '準時或更早'}` : `一半的班次晚 ${s.median} 分以內`;
  const tail = s.p80 != null && s.p80 > 15 ? `最晚的 1/5 晚 ${s.p80} 分以上` : '';
  return `${label}：${[share, med, tail].filter(Boolean).join('；')}`;
}
// The status chip's tone: bad (cancelled, diverted), late (15 minutes or more), or fine.
function fstTone(l) {
  if (['Canceled', 'CanceledUncertain', 'Diverted'].includes(l.status)) return 'bad';
  const late = Math.max(l.from?.delayMin ?? 0, l.to?.delayMin ?? 0);
  return l.status === 'Delayed' || late >= 15 ? 'late' : 'ok';
}

// ---------- the page ----------
// Open panels by leg (date, airports and flights), so a redraw or a reordered plan keeps the right one.
const fstOpen = new Map();
const fstKey = (l) => `${l.date}|${l.from}|${l.to}|${l.flights}`;
const fstAirport = (code, name) => `${esc(code)}${airportCity(code) ? ` ${esc(airportCity(code))}` : name && name !== code ? ` ${esc(name)}` : ''}`;
const fstEnd = (label, e, legDate) => {
  if (!e?.scheduled) return '';
  const day = (d) => (d && d !== legDate ? `${mmdd(d)} ` : '');
  const late = e.latest && e.delayMin != null ? ` → ${e.actual ? '實際' : '預計'} <b>${day(e.latest.date)}${esc(e.latest.time)}</b>（${fstDelayText(e.delayMin)}）` : '';
  const where = [e.terminal && `第 ${esc(e.terminal)} 航廈`, e.gate && `登機門 ${esc(e.gate)}`, e.checkIn && `報到櫃台 ${esc(e.checkIn)}`, e.belt && `行李轉盤 ${esc(e.belt)}`].filter(Boolean).join('・');
  return `<div class="fst-end"><span class="fst-lab">${label}</span><span>${fstAirport(e.iata, e.name)}　表定 ${day(e.scheduled.date)}${esc(e.scheduled.time)}${late}${where ? `<small>${where}</small>` : ''}</span></div>`;
};
const fstSource = (r) => `<p class="hint fst-src">資料來源 <a href="https://aerodatabox.com" target="_blank" rel="noopener">AeroDataBox</a>・${r.mock ? '示範資料，沒有用到額度' : r.spent ? `這次用了 ${r.spent} 單位` : '剛查過，這次沒有用到額度'}${r.unitsLeft != null && !r.mock ? `・本月約剩 ${fmt(r.unitsLeft)}／${fmt(r.unitsLimit)} 單位` : ''}</p>`;
function fstStatusHtml(r, st, leg) {
  if (!r.found) {
    const later = st.flights.indexOf(st.flight) > 0 && st.date === leg.date;
    return `<p>這天（${mmdd(st.date)}）查不到 <b>${esc(st.flight)}</b>。${later ? '轉機的下一段可能是隔天出發。' : '可能是航班號碼或日期不對。'}</p>${later ? `<button type="button" class="outline small" data-fst-next>改查 ${mmdd(isoDateFrom(st.date, 1))}</button>` : ''}${fstSource(r)}`;
  }
  return r.legs.map((l) => {
    const code = l.number.replace(/\s+/g, '').slice(0, 2);
    const al = airlineZh(code) !== code ? airlineZh(code) : l.airline;
    const late = Math.max(l.from.delayMin ?? -1e9, l.to.delayMin ?? -1e9);
    const chip = `${esc(l.statusZh)}${['Canceled', 'CanceledUncertain', 'Diverted'].includes(l.status) || late < 1 ? '' : `・${fstDelayText(late)}`}`;
    const live = l.from.live || l.to.live;
    return `<div class="fst-flight"><div class="fst-head"><b>${esc(l.number)}</b> ${esc(al)}${l.codeshare ? '<small>（共掛班號）</small>' : ''}<span class="fst-chip ${fstTone(l)}">${chip}</span></div>
      ${fstEnd('出發', l.from, st.date)}${fstEnd('抵達', l.to, st.date)}
      <p class="hint">${[l.aircraft && `${esc(l.aircraft)}${l.reg ? `（${esc(l.reg)}）` : ''}`, live ? (l.updated ? `${ago(l.updated.replace(' ', 'T'))}更新` : '') : '還沒有即時資料，目前是時刻表'].filter(Boolean).join('・')}</p></div>`;
  }).join('') + fstSource(r);
}
function fstDelaysHtml(r) {
  if (!r.found) return `<p><b>${esc(r.flight)}</b> 沒有足夠的準點紀錄（只統計 AeroDataBox 有即時追蹤的機場、最近幾個月的班次）。</p>${fstSource(r)}`;
  const s = r.arr || r.dep;
  const span = s.from && s.to ? `${mmdd(s.from)}–${mmdd(s.to)}，` : '';
  return `<p><b>${esc(r.flight)}</b> <small>（${span}約 ${fmt(Math.max(r.arr?.flights || 0, r.dep?.flights || 0))} 班）</small></p>
    <ul class="fst-punct">${[fstPunctText('抵達', r.arr), fstPunctText('出發', r.dep)].filter(Boolean).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
    <p class="hint">是過去的統計，不代表這一天會不會誤點。</p>${fstSource(r)}`;
}
function fstPanelHtml(st, leg) {
  const pick = st.flights.length > 1 ? `<span class="fst-pick">${st.flights.map((f) => `<button type="button" class="chip-btn${f === st.flight ? ' on' : ''}" data-fst-flight="${esc(f)}" aria-pressed="${f === st.flight}">${esc(f)}</button>`).join('')}</span>` : '';
  const title = st.kind === 'delays' ? '這班過去準點率' : `航班動態・${mmdd(st.date)}（${dowOf(st.date)}）`;
  const body = !st.flight ? '<p class="hint">這段有好幾個航班，要查哪一班？</p>'
    : st.busy ? '<p class="hint">查詢中…</p>'
      : st.err ? `<p class="fst-err">${esc(st.err)}</p>`
        : st.data ? (st.kind === 'delays' ? fstDelaysHtml(st.data) : fstStatusHtml(st.data, st, leg)) : '';
  return `<div class="fst-box" role="region" aria-label="${esc(title)}"><div class="fst-top"><b>${title}</b>${pick}<button type="button" class="ghost fst-x" data-fst-close aria-label="關閉">✕</button></div>${body}</div>`;
}
// The panel under leg i's row (a row of its own spanning the table).
function fstDraw(i) {
  const leg = plan.legs[i];
  const tr = $(`#plan-body [data-leg-rm="${i}"]`)?.closest('tr');
  if (!leg || !tr) return;
  let row = tr.nextElementSibling?.classList.contains('fst-row') ? tr.nextElementSibling : null;
  const st = fstOpen.get(fstKey(leg));
  if (!st) { row?.remove(); return; }
  if (!row) {
    tr.insertAdjacentHTML('afterend', `<tr class="fst-row"><td colspan="${tr.children.length}"></td></tr>`);
    row = tr.nextElementSibling;
  }
  row.dataset.fstLeg = String(i);
  row.firstElementChild.innerHTML = fstPanelHtml(st, leg);
}
async function fstRun(i) {
  const leg = plan.legs[i];
  const st = leg && fstOpen.get(fstKey(leg));
  if (!st || !st.flight || st.busy) return;
  Object.assign(st, { err: '', data: null });
  const note = st.kind === 'status' ? fstDateNote(st.date, twDate(0)) : '';
  if (note) { st.err = note; return fstDraw(i); }
  st.busy = true;
  fstDraw(i);
  try {
    const q = st.kind === 'delays' ? new URLSearchParams({ flight: st.flight }) : new URLSearchParams({ flight: st.flight, date: st.date, from: leg.from, to: leg.to });
    const r = await cashApi(`/api/${st.kind === 'delays' ? 'flight-delays' : 'flight-status'}?${q}`, { pass: '航班動態' });
    if (r.configured === false) throw new Error('網站還沒設定 RAPIDAPI_KEY，查不到航班動態。');
    st.data = r;
  } catch (err) {
    st.err = err.message;
  }
  st.busy = false;
  fstDraw(i);
}
// The leg's two buttons (each opens its panel and asks at once when the leg has one flight), and the cost line.
function fstBind(host) {
  if (!host) return;
  let any = false;
  const rows = $$('[data-leg-rm]', host);
  for (const b of rows) {
    const i = Number(b.dataset.legRm);
    const leg = plan.legs[i];
    if (!leg || !fstFlights(leg.flights).length) continue;
    any = true;
    const cell = b.closest('tr')?.children[1];
    if (cell && !$('.fst-acts', cell)) cell.insertAdjacentHTML('beforeend', `<span class="fst-acts"><button type="button" class="linklike" data-fst="status" data-fst-leg="${i}">✈ 查航班動態</button><button type="button" class="linklike" data-fst="delays" data-fst-leg="${i}">這班過去準點率</button></span>`);
    if (fstOpen.has(fstKey(leg))) fstDraw(i);
  }
  // Under the plan's own total (a friend's shared plan may be drawn above it).
  const wrap = rows[0]?.closest('.table-wrap');
  const after = wrap?.nextElementSibling?.classList.contains('plan-sum') ? wrap.nextElementSibling : wrap;
  // In 我的行程's 「更多」 fold when features.js has it (renderPlan moves it there too).
  const into = (html) => (typeof planMoreHost === 'function' && host.id === 'plan-body' ? planMoreHost(host).insertAdjacentHTML('afterbegin', html) : after.insertAdjacentHTML('afterend', html));
  if (any && after && !$('.fst-note', host)) into(`<p class="hint fst-note">✈ 航班動態每次用 ${FST_UNITS.status} 單位、準點率每次 ${FST_UNITS.delays} 單位（AeroDataBox，每月免費 400 單位，和直飛資料共用）；按了才查${cashCfg.locked && passNeeded() ? '，要通關密碼' : ''}。</p>`);
}
function fstClick(e) {
  const t = e.target.closest?.('[data-fst], [data-fst-flight], [data-fst-close], [data-fst-next]');
  if (!t || !t.closest('#plan-body')) return;
  if (t.dataset.fst) {
    const i = Number(t.dataset.fstLeg);
    const leg = plan.legs[i];
    if (!leg) return;
    const flights = fstFlights(leg.flights);
    const cur = fstOpen.get(fstKey(leg));
    // The same button again on a finished panel closes it; the other one switches it.
    if (cur && cur.kind === t.dataset.fst && !cur.busy && (cur.data || cur.err)) { fstOpen.delete(fstKey(leg)); return fstDraw(i); }
    fstOpen.set(fstKey(leg), { kind: t.dataset.fst, flights, flight: flights.length === 1 ? flights[0] : cur?.flight || null, date: leg.date, busy: false, err: '', data: null });
    fstDraw(i);
    return fstRun(i);
  }
  const i = Number(t.closest('.fst-row')?.dataset.fstLeg);
  const leg = plan.legs[i];
  const st = leg && fstOpen.get(fstKey(leg));
  if (!st) return;
  if ('fstClose' in t.dataset) { fstOpen.delete(fstKey(leg)); return fstDraw(i); }
  if (st.busy) return;
  if (t.dataset.fstFlight) Object.assign(st, { flight: t.dataset.fstFlight, date: leg.date });
  else if ('fstNext' in t.dataset) st.date = isoDateFrom(st.date, 1);
  fstRun(i);
}

if (typeof module === 'object' && module.exports) module.exports = { fstFlights, fstDateNote, fstDelayText, fstPunctText, fstTone, FST_AHEAD, FST_UNITS };
else {
  document.addEventListener('click', fstClick);
  fstBind($('#plan-body')); // features.js drew the plan once before this script loaded
}
