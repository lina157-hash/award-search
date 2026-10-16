// 環球票規劃 (multi-city / round-the-world award planner, 航線查詢 › 🌏) and 國泰混艙計算 (規則庫 › 亞洲萬里通哩數表).
// Loaded after features.js; uses the shared globals (data, AP, haversineMiles, amBand, earnHtml, transferRates, pickers…).
// Rules and charts come from data/rtw.json (official pages only). The pure part comes first so tests can run it in a vm.

// ---------- pure logic ----------
const RTW_CABINS = ['Y', 'W', 'J', 'F'];
const RTW_STATUS_ICON = { ok: '✓', bad: '✗', warn: '⚠', na: '・' };

// IATA area of an airport: 1 Americas, 2 Europe/Africa/Middle East, 3 Asia/Pacific (Russia split at the Urals).
function rtwArea(areas, ap) {
  if (!ap) return 0;
  const split = areas.splitLon?.[ap.country];
  if (split != null && ap.lon != null) return ap.lon >= split ? 3 : 2;
  if (areas.tc1.includes(ap.country)) return 1;
  return areas.tc3.includes(ap.country) ? 3 : 2;
}

// Legs with their great-circle miles; surface legs (陸路) are kept apart because programs count them differently.
function rtwTrip(plan, apOf, areas) {
  const pts = plan.stops.map((s) => ({ ...s, ap: apOf(s.code) || null }));
  const legs = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1].ap;
    const b = pts[i].ap;
    const L = plan.legs?.[i - 1] || {};
    const geo = a && b && a.lat != null && b.lat != null;
    legs.push({
      i: i - 1, from: pts[i - 1].code, to: pts[i].code, dist: geo ? haversineMiles(a, b) : 0, surface: Boolean(L.surface),
      date: L.date || '', airline: String(L.airline || '').trim().toUpperCase(),
      area: [rtwArea(areas, a), rtwArea(areas, b)], cc: [a?.country || '', b?.country || ''],
      dlon: geo ? ((b.lon - a.lon + 540) % 360) - 180 : 0, // eastward change in longitude, -180…180
    });
  }
  const flown = legs.filter((l) => !l.surface).reduce((n, l) => n + l.dist, 0);
  const surface = legs.filter((l) => l.surface).reduce((n, l) => n + l.dist, 0);
  return { pts, legs, flown, surface, total: flown + surface, unknown: pts.filter((p) => !p.ap).map((p) => p.code) };
}

// Ocean crossings and direction from the area changes: Pacific 1↔3, Atlantic 1↔2; eastbound is 3→1→2→3.
const RTW_EAST = new Set(['3>1', '1>2', '2>3']);
function rtwShape(trip) {
  const out = { pacific: 0, atlantic: 0, east: 0, west: 0 };
  for (const l of trip.legs) {
    const [a, b] = l.area;
    if (!a || !b || a === b) continue;
    out[RTW_EAST.has(`${a}>${b}`) ? 'east' : 'west']++;
    if (a + b === 4) out.pacific++;
    else if (a + b === 3) out.atlantic++;
  }
  out.dir = out.east && !out.west ? 'east' : out.west && !out.east ? 'west' : out.east || out.west ? 'mixed' : '';
  return out;
}

// What each intermediate point is: a stopover (over 24 h), a transfer, or the end of a surface leg (counted as surface).
function rtwStays(plan, trip) {
  return trip.pts.map((p, i) => {
    if (i === 0 || i === trip.pts.length - 1) return 'end';
    if (trip.legs[i - 1]?.surface || trip.legs[i]?.surface) return 'surface';
    return plan.stops[i].stay === 'transfer' ? 'transfer' : 'stop';
  });
}

// Price from the program's official chart: { miles, unit, band: { idx, lo, hi } } or { pending } / { over } / null.
function rtwPrice(prog, trip, cabin, charts) {
  const pr = prog.price;
  if (!prog.cabins.includes(cabin)) return { noCabin: true };
  if (pr.kind === 'fixed') return pr[cabin] ? { miles: pr[cabin], unit: pr.unit || '哩', fixed: true } : { noCabin: true };
  const d = pr.basis === 'withSurface' ? trip.total : trip.flown;
  if (pr.kind === 'pending') return { pending: true, dist: d, over: d > pr.max };
  const bands = pr.bands || charts?.programs?.find((p) => p.id === pr.chartRef)?.tables?.[0]?.bands;
  if (!bands || !d) return null;
  if (d > pr.max) return { over: true, dist: d };
  const idx = bands.findIndex((b) => d <= b.upTo);
  if (idx < 0 || !bands[idx][cabin]) return { noCabin: true };
  return { miles: bands[idx][cabin], unit: pr.unit || '哩', dist: d, band: { idx, lo: idx ? bands[idx - 1].upTo + 1 : 1, hi: bands[idx].upTo } };
}

function rtwAddMonths(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate(); // clamp 31 Jan + 1 month to 28/29 Feb
  return new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))).toISOString().slice(0, 10);
}
const rtwDays = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);

// Every official rule the program states that the itinerary can show: [{ s: ok|bad|warn|na, t }].
// ctx: { cabin, members: alliance id → codes, cityOf: code → city key, today: 'YYYY-MM-DD' }.
function rtwChecks(prog, plan, trip, ctx) {
  const R = prog.rules || {};
  const out = [];
  const add = (s, t) => out.push({ s, t });
  const flights = trip.legs.filter((l) => !l.surface);
  const surfaces = trip.legs.filter((l) => l.surface);
  const stays = rtwStays(plan, trip);
  const pts = trip.pts;
  const origin = pts[0]?.ap;
  const end = pts.at(-1)?.ap;
  const city = (i) => ctx.cityOf(pts[i].code);
  const shape = rtwShape(trip);
  const n = (k) => stays.filter((x) => x === k).length;

  if (trip.unknown.length) add('warn', `找不到 ${trip.unknown.join('、')} 的位置，距離與區域沒算進去`);
  if (!prog.cabins.includes(ctx.cabin)) add('bad', `這個計畫沒有${CABIN_LABEL[ctx.cabin]}`);
  const max = prog.price.max;
  if (max) {
    const d = prog.price.basis === 'withSurface' ? trip.total : trip.flown;
    add(d <= max ? 'ok' : 'bad', `總距離 ${fmt(d)} 哩${prog.price.basis === 'withSurface' && surfaces.length ? '（含陸路）' : ''}，上限 ${fmt(max)} 哩`);
  }
  if (R.crossings) {
    const c = R.crossings;
    const okP = c.exact ? shape.pacific === c.pacific : shape.pacific >= c.pacific;
    const okA = c.exact ? shape.atlantic === c.atlantic : shape.atlantic >= c.atlantic;
    add(okP && okA ? 'ok' : 'bad', `跨太平洋 ${shape.pacific} 次、跨大西洋 ${shape.atlantic} 次（規定${c.exact ? '各剛好' : '至少各'} 1 次）`);
  }
  if (R.sameDirection) {
    if (shape.dir === 'mixed') add('bad', '飛行方向有改變（規定全程往東或全程往西）');
    else if (shape.dir) {
      // Within one area the official wording (「at all times in the same direction」) may also rule out a long step back.
      const back = flights.filter((l) => (shape.dir === 'east' ? l.dlon < -15 : l.dlon > 15)).map((l) => `${l.from}→${l.to}`);
      add(back.length ? 'warn' : 'ok', `全程往${shape.dir === 'east' ? '東' : '西'}${back.length ? `；${back.join('、')} 往回飛，可能不被接受` : ''}`);
    } else add('bad', '沒有跨區飛行，不是環球行程');
  }
  if (R.endInOriginCountry && origin && end) add(origin.country === end.country ? 'ok' : 'bad', origin.country === end.country ? '回到出發的國家' : '最後沒有回到出發的國家');
  if (R.maxFlights) add(flights.length <= R.maxFlights ? 'ok' : 'bad', `航班 ${flights.length} 段，上限 ${R.maxFlights} 段${surfaces.length ? '（陸路不算）' : ''}`);
  if (R.maxSegments) add(trip.legs.length <= R.maxSegments ? 'ok' : 'bad', `共 ${trip.legs.length} 段${surfaces.length ? '（含陸路）' : ''}，上限 ${R.maxSegments} 段（陸路也算）`);
  if (R.maxStopovers != null) {
    const stops = n('stop') + (R.surfaceIsStopover ? surfaces.length : 0);
    add(stops <= R.maxStopovers ? 'ok' : 'bad', `停留 ${stops} 次，上限 ${R.maxStopovers} 次${R.surfaceIsStopover && surfaces.length ? '（陸路算 1 次停留）' : ''}`);
  }
  if (R.maxTransfers != null) add(n('transfer') <= R.maxTransfers ? 'ok' : 'bad', `轉機 ${n('transfer')} 次，上限 ${R.maxTransfers} 次`);
  if (R.maxSurface != null && surfaces.length) add(surfaces.length <= R.maxSurface ? 'ok' : 'bad', `陸路 ${surfaces.length} 段，上限 ${R.maxSurface} 段`);
  const tally = (pick) => {
    const m = new Map();
    pts.forEach((p, i) => { if (pick(i)) m.set(city(i), (m.get(city(i)) || 0) + 1); });
    return [...m].filter(([, c]) => c > 1).map(([k]) => k);
  };
  if (R.stopoverOncePerCity) {
    const twice = tally((i) => stays[i] === 'stop');
    if (twice.length) add('bad', `${twice.join('、')} 停留超過 1 次（同一城市只能停留 1 次）`);
  }
  if (R.maxTransfersPerCity) {
    const m = new Map();
    pts.forEach((p, i) => { if (stays[i] === 'transfer') m.set(city(i), (m.get(city(i)) || 0) + 1); });
    const over = [...m].filter(([, c]) => c > R.maxTransfersPerCity).map(([k]) => k);
    if (over.length) add('bad', `${over.join('、')} 轉機超過 ${R.maxTransfersPerCity} 次`);
  }
  if (R.cityMaxVisits) {
    const m = new Map();
    pts.forEach((p, i) => m.set(city(i), (m.get(city(i)) || 0) + 1));
    const over = [...m].filter(([, c]) => c > R.cityMaxVisits).map(([k]) => k);
    if (over.length) add('bad', `${over.join('、')} 經過超過 ${R.cityMaxVisits} 次`);
  }
  if (R.noStopoverAtEnds && pts.length > 2) {
    const ends = new Set([city(0), city(pts.length - 1)]);
    const bad = pts.map((p, i) => i).filter((i) => stays[i] === 'stop' && ends.has(city(i))).map((i) => pts[i].code);
    if (bad.length) add('bad', `${bad.join('、')} 是出發地或目的地，不能在這裡停留`);
  }
  if (R.noReturnToOriginCountry && origin) {
    const outs = trip.legs.filter((l) => l.cc[0] === origin.country && l.cc[1] !== origin.country).length;
    add(outs <= 1 ? 'ok' : 'bad', outs <= 1 ? '沒有中途回到出發國家再出發' : `從出發國家出發了 ${outs} 次（中途回到出發國家再飛往其他國家不行）`);
  }
  if (R.maxDomestic) {
    const dom = flights.filter((l) => l.cc[0] === R.maxDomestic.country && l.cc[1] === R.maxDomestic.country).length;
    if (dom) add(dom <= R.maxDomestic.n ? 'ok' : 'bad', `${regionName(R.maxDomestic.country).zh}國內線 ${dom} 段，上限 ${R.maxDomestic.n} 段`);
  }
  if (R.noStopoverInOriginCountry?.includes(origin?.country)) {
    const bad = pts.filter((p, i) => stays[i] === 'stop' && p.ap?.country === origin.country).map((p) => p.code);
    if (bad.length) add('bad', `從${regionName(origin.country).zh}出發時不能在${regionName(origin.country).zh}國內停留（${bad.join('、')}）`);
  }
  if (R.carriers && flights.length) {
    const codes = flights.map((l) => l.airline);
    if (codes.some((c) => !/^[A-Z0-9]{2}$/.test(c))) add('na', '每段都填上航空公司代碼（例如 CX、BA），才能檢查航空公司規定');
    else {
      const allowed = R.carriers.list || ctx.members[R.carriers.alliance] || [];
      const outside = [...new Set(codes.filter((c) => !allowed.includes(c)))];
      const set = new Set(codes.filter((c) => !(R.carriers.notCounting || []).includes(c)));
      const need = R.carriers.withCX && set.has('CX') ? R.carriers.withCX : R.carriers.min || 0;
      if (outside.length) add('bad', `${outside.join('、')} 不在這個獎勵可搭的航空公司內`);
      if (need) add(set.size >= need ? 'ok' : 'bad', `${R.carriers.notCounting ? `${R.carriers.notCounting.join('、')} 以外` : ''}搭了 ${set.size} 家航空公司，至少要 ${need} 家${R.carriers.withCX && set.has('CX') ? '（有搭國泰時）' : ''}`);
      else if (!outside.length) add('ok', '每段都是可搭的航空公司');
    }
  }
  const dated = flights.filter((l) => /^\d{4}-\d{2}-\d{2}$/.test(l.date));
  if (R.validity || R.minDays) {
    if (!dated.length) add('na', '填上每段日期，就能檢查效期');
    else {
      const ds = dated.map((l) => l.date);
      if (ds.some((d, i) => i && d < ds[i - 1])) add('warn', '日期沒有照順序');
      if (ctx.today && ds[0] < ctx.today) add('warn', '第一段日期已經過了');
      const first = [...ds].sort()[0];
      const last = [...ds].sort().at(-1);
      if (R.validity) {
        const until = rtwAddMonths(first, R.validity.months);
        const ok = last <= until;
        const issue = rtwAddMonths(last, -R.validity.months);
        // Counted from the issue date: say how early the ticket may be issued (any time now, if that day has passed).
        const when = ctx.today && issue <= ctx.today ? '現在開票就來得及' : `要在 ${issue} 之後開票`;
        add(ok ? 'ok' : 'bad', R.validity.from === 'issue'
          ? `效期自開票日起 ${R.validity.months} 個月：最後一段 ${last}，${ok ? when : '行程超過 1 年，排不進去'}`
          : `效期自第一段起 ${R.validity.months} 個月：${first} 出發，要在 ${until} 前飛完（最後一段 ${last}）`);
      }
      if (R.minDays) {
        const intl = dated.filter((l) => l.cc[0] !== l.cc[1]).map((l) => l.date).sort();
        if (intl.length > 1) {
          const gap = rtwDays(intl[0], intl.at(-1));
          add(gap >= R.minDays ? 'ok' : 'bad', `第一段到最後一段國際線相隔 ${gap} 天，至少要 ${R.minDays} 天`);
        }
      }
    }
  }
  return out;
}

// ---------- 國泰混艙計算: Asia Miles Standard Award, one direction ----------
// Official rule (Cathay membership T&C 2026, Standard Awards cl. 3): the zone comes from the direction's summed sector
// distances; each sector's cabin price in that zone is prorated by its share of the great-circle distance; the sum is
// rounded down to the hundred. legs: [{ from, to, dist, cabin }]; o/d decide the short-haul type 2 (Japan, India…).
const CABIN_RANK = { Y: 0, W: 1, J: 2, F: 3 };
function cxMixQuote(am, kind, legs, o, d) {
  const total = legs.reduce((n, l) => n + (l.dist || 0), 0);
  if (!am || !total || legs.some((l) => !l.dist)) return null;
  const band = amBand(total, o, d);
  const chart = am.charts[kind][band];
  const missing = [...new Set(legs.map((l) => l.cabin).filter((c) => !chart[c]))];
  if (missing.length) return { total, band, missing };
  const rows = legs.map((l) => ({ ...l, full: chart[l.cabin], share: (chart[l.cabin] * l.dist) / total }));
  const raw = rows.reduce((n, r) => n + r.share, 0);
  const top = legs.map((l) => l.cabin).sort((a, b) => CABIN_RANK[b] - CABIN_RANK[a])[0];
  return { total, band, rows, raw, miles: Math.floor(raw / 100) * 100, top, topMiles: chart[top] };
}

// ---------- page (browser only) ----------
if (typeof document !== 'undefined') {
  const RTW_KEY = 'rtw:v1';
  const rtw = { program: '', cabin: 'J', stops: [], legs: [] };
  try { Object.assign(rtw, JSON.parse(localStorage.getItem(RTW_KEY)) || {}); } catch { /* private window: start blank */ }
  const rtwSave = () => { try { localStorage.setItem(RTW_KEY, JSON.stringify(rtw)); } catch { /* not kept */ } };
  const rtwData = () => data.rtw;
  const rtwApOf = (c) => AP.byCode.get(c);
  // A city with several airports (東京 NRT/HND) counts once for the per-city rules.
  const rtwCityOf = (code) => AP.groups.find((g) => g.codes.includes(code))?.zh || code;
  const rtwPlace = (c) => { const a = AP.byCode.get(c); return a ? a.zh || a.city : data.airportNames?.names?.[c] || ''; };
  const rtwMembers = () => Object.fromEntries((data.alliances?.alliances || []).map((a) => [a.id, a.members]));
  const rtwUnit = (p) => (p.price.unit === '點' ? '點' : '哩');

  // One airport field that adds each pick to a list (the site's picker, emptied after every pick so cities can repeat).
  function rtwStopPicker(host, id, onAdd) {
    host.innerHTML = `<form class="rtw-add" autocomplete="off"><div class="route-row"><div class="field grow ac-host">
        <label for="${id}-q">加入下一站</label>
        <div class="chips-box" data-for="next"><span class="chips"></span>
          <input id="${id}-q" class="chips-q" placeholder="城市、機場或代碼" autocapitalize="off" spellcheck="false" enterkeyhint="done" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${id}-ac"></div>
        <input type="hidden" name="next" value="">
        <div class="ac-list" id="${id}-ac" role="listbox" aria-label="下一站建議" hidden></div>
      </div></div></form>`;
    const form = $('form', host);
    const pk = createAirportPicker(form, 'next');
    form.next.addEventListener('change', () => {
      const codes = pk.codes();
      if (!codes.length) return;
      pk.set([]);
      onAdd(codes);
    });
    form.addEventListener('submit', (e) => { e.preventDefault(); const bad = pk.commit(); if (bad.length) toast(`找不到「${bad.join('、')}」`); });
    return pk;
  }

  // ---- 環球票規劃 ----
  function rtwMount() {
    const body = $('#rtw-body');
    if (!body || body.dataset.ready) return;
    body.dataset.ready = '1';
    body.innerHTML = skeleton(3);
    Promise.all([loadMore(), loadAirports()]).then(() => {
      const d = rtwData();
      if (!d) { body.innerHTML = '<p class="hint">環球票資料載入失敗，請重新整理。</p>'; return; }
      body.innerHTML = `<p class="hint">依序加入要去的城市，就會算出總距離、要多少哩，並對照各計畫的官方規則。試算不用查詢額度；只有每段的「查這段」會用。</p>
        <div class="opts-row rtw-opts">
          <label class="field">哩程計畫<select id="rtw-prog"><option value="">全部比較</option>${d.programs.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label>
          <fieldset class="seg" id="rtw-cabin" aria-label="艙等">${RTW_CABINS.map((c) => `<label><input type="radio" name="rtw-cabin" value="${c}"><span>${CABIN_LABEL[c].replace('艙', '')}</span></label>`).join('')}</fieldset>
        </div>
        <div id="rtw-add"></div>
        <div id="rtw-out" aria-live="polite"></div>`;
      $('#rtw-prog').value = d.programs.some((p) => p.id === rtw.program) ? rtw.program : '';
      $('#rtw-prog').addEventListener('change', (e) => { rtw.program = e.target.value; rtwSave(); rtwDraw(); });
      $('#rtw-cabin').addEventListener('change', (e) => { rtw.cabin = e.target.value; rtwSave(); rtwDraw(); });
      rtwStopPicker($('#rtw-add'), 'rtw-next', (codes) => {
        for (const c of codes) {
          if (rtw.stops.length >= 20) { toast('最多 20 站'); break; }
          if (rtw.stops.length) rtw.legs.push({ date: '', airline: '', surface: false });
          rtw.stops.push({ code: c, stay: 'stop' });
        }
        rtwSave();
        rtwDraw();
      });
      $('#rtw-out').addEventListener('click', rtwClick);
      $('#rtw-out').addEventListener('change', rtwChange);
      rtwDraw();
    }, () => { body.dataset.ready = ''; body.innerHTML = '<p class="hint">資料載入失敗，請檢查網路後再打開一次。</p>'; });
  }

  function rtwSyncCabin(progs) {
    // Cabins none of the shown programs sell are greyed out; a picked cabin the program lacks moves to business.
    const sells = new Set(progs.flatMap((p) => p.cabins));
    if (!sells.has(rtw.cabin)) rtw.cabin = sells.has('J') ? 'J' : [...sells][0];
    $$('#rtw-cabin input').forEach((i) => { i.checked = i.value === rtw.cabin; i.disabled = !sells.has(i.value); i.parentElement.classList.toggle('off', i.disabled); });
  }

  function rtwPriceText(p, price) {
    if (!price) return '—';
    if (price.noCabin) return `沒有${CABIN_LABEL[rtw.cabin]}`;
    if (price.pending) return price.over ? `超過 ${fmt(p.price.max)} 哩上限` : '待確認';
    if (price.over) return `超過 ${fmt(p.price.max)} 哩上限`;
    return `${fmt(price.miles)} ${rtwUnit(p)}`;
  }

  function rtwDraw() {
    const out = $('#rtw-out');
    const d = rtwData();
    if (!out || !d) return;
    const prog = d.programs.find((p) => p.id === rtw.program) || null;
    rtwSyncCabin(prog ? [prog] : d.programs);
    const plan = { stops: rtw.stops, legs: rtw.legs };
    const trip = rtwTrip(plan, rtwApOf, d.areas);
    const shape = rtwShape(trip);
    const n = rtw.stops.length;
    const last = n - 1;
    const stopRow = (s, i) => `<li class="rtw-stop"><span class="rtw-no">${i + 1}</span><b>${esc(s.code)}</b> <span>${esc(rtwPlace(s.code))}</span>
        ${i > 0 && i < last && !trip.legs[i - 1]?.surface && !trip.legs[i]?.surface ? `<select data-stay="${i}" aria-label="${esc(s.code)} 停多久"><option value="stop" ${s.stay !== 'transfer' ? 'selected' : ''}>停留（逾 24 小時）</option><option value="transfer" ${s.stay === 'transfer' ? 'selected' : ''}>轉機（24 小時內）</option></select>` : ''}
        <button type="button" class="ghost rtw-rm" data-rm="${i}" aria-label="移除 ${esc(s.code)}">✕</button></li>`;
    const legRow = (l) => `<li class="rtw-leg${l.surface ? ' surface' : ''}"><span class="rtw-dist">${l.surface ? '陸路' : '✈'} ${fmt(l.dist)} 哩</span>
        <label class="rtw-in">日期<input type="date" data-date="${l.i}" value="${esc(l.date)}"></label>
        ${l.surface ? '' : `<label class="rtw-in">航空<input data-air="${l.i}" value="${esc(l.airline)}" maxlength="2" placeholder="CX" autocapitalize="characters" spellcheck="false"></label>`}
        <label class="rtw-in rtw-chk"><input type="checkbox" data-surface="${l.i}" ${l.surface ? 'checked' : ''}>陸路（自行前往）</label>
        ${l.surface ? '' : `<button type="button" class="outline rtw-go" data-go="${l.i}">查這段（用 1 次查詢）</button>`}</li>`;
    const list = n ? `<ol class="rtw-list">${rtw.stops.map((s, i) => stopRow(s, i) + (i < last ? legRow(trip.legs[i]) : '')).join('')}</ol>
      <div class="rtw-tools">${n > 1 && rtw.stops[0].code !== rtw.stops[last].code ? `<button type="button" class="outline" data-close>↩ 回到起點 ${esc(rtw.stops[0].code)}</button>` : ''}<button type="button" class="linklike" data-clear>清除全部</button></div>`
      : '<p class="hint rtw-empty">還沒有城市。<button type="button" class="linklike" data-example>看範例：台北 → 香港 → 倫敦 → 紐約 → 洛杉磯 → 台北</button></p>';
    if (n < 2) { out.innerHTML = list + rtwOtherHtml(d); return; }
    const dirText = shape.dir === 'east' ? '往東' : shape.dir === 'west' ? '往西' : shape.dir === 'mixed' ? '方向有變' : '同一區內';
    const sum = `<p class="rtw-sum">總飛行距離 <b>${fmt(trip.flown)} 哩</b>${trip.surface ? `（另有陸路 ${fmt(trip.surface)} 哩）` : ''}・${trip.legs.filter((l) => !l.surface).length} 段航班・跨太平洋 ${shape.pacific} 次、跨大西洋 ${shape.atlantic} 次・${dirText}</p>`;
    const ctx = { cabin: rtw.cabin, members: rtwMembers(), cityOf: rtwCityOf, today: isoDate(0) };
    let res;
    if (!prog) {
      // No program picked: one row each, so the owner sees which fits this route before reading the rules.
      const rows = d.programs.map((p) => {
        const price = rtwPrice(p, trip, rtw.cabin, data.charts);
        const ck = rtwChecks(p, plan, trip, ctx);
        const bad = ck.filter((x) => x.s === 'bad').length;
        const warn = ck.filter((x) => x.s === 'warn').length;
        return `<tr><td><button type="button" class="linklike rtw-pick" data-pick="${esc(p.id)}">${esc(p.short)}</button><small>${esc(ALLIANCE_SHORT[p.alliance] || p.alliance)}</small></td><td>${esc(rtwPriceText(p, price))}</td>
          <td>${bad ? `<span class="tag warn">✗ ${bad} 項不符</span>` : '<span class="tag ok">✓ 符合</span>'}${warn ? ` <span class="tag">⚠ ${warn}</span>` : ''}</td></tr>`;
      }).join('');
      res = `<div class="table-wrap rtw-cmp"><table><thead><tr><th>計畫</th><th>${CABIN_LABEL[rtw.cabin]}</th><th>官方規則</th></tr></thead><tbody>${rows}</tbody></table></div>
        <p class="hint">點計畫名稱看哪幾條不符、要多少卡點。價格依各計畫官方哩數表與本站算的大圓距離；「待確認」是官網表格讀不到；澳航是澳航點數。</p>`;
    } else {
      const price = rtwPrice(prog, trip, rtw.cabin, data.charts);
      const ck = rtwChecks(prog, plan, trip, ctx);
      let head;
      if (price?.miles) head = `<b class="rtw-miles">${fmt(price.miles)} ${rtwUnit(prog)}</b><small>${CABIN_LABEL[rtw.cabin]}・${price.fixed ? '固定價' : `總距離 ${fmt(price.dist)} 哩，落在 ${fmt(price.band.lo)}–${fmt(price.band.hi)} 哩這一級`}・每人</small>`;
      else if (price?.pending) head = `<b class="rtw-miles">價格待確認</b><small>${esc(prog.price.why)} <a href="${esc(prog.price.chartUrl)}" target="_blank" rel="noopener">國泰哩數表 ↗</a>（總距離 ${fmt(price.dist)} 哩）</small>`;
      else head = `<b class="rtw-miles">${esc(rtwPriceText(prog, price))}</b>`;
      // Taiwan card points: the same rates and wallet as the flight dialog's 「怎麼湊到這些哩」 (Qantas Points transfer 1:1 too).
      const key = prog.walletKey;
      const earn = !price?.miles ? '' : transferRates(key).length ? earnHtml(key, price.miles) : '<p class="hint">台灣的信用卡點數目前沒有直接轉入這個計畫。</p>';
      res = `<div class="rtw-price">${head}</div>${earn}
        <ul class="rtw-checks">${ck.map((x) => `<li class="${x.s}"><span aria-hidden="true">${RTW_STATUS_ICON[x.s]}</span> ${esc(x.t)}</li>`).join('')}</ul>
        <details class="rtw-rules"><summary>${esc(prog.name)}：規則重點與官方來源</summary>
          <ul>${prog.summary.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
          <p class="hint">訂位：${esc(prog.howToBook)}</p>
          <p class="hint">來源：${prog.sources.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a>（${esc(s.checked)} 查核）`).join('、')}</p></details>`;
    }
    out.innerHTML = list + sum + res + rtwOtherHtml(d);
  }

  function rtwOtherHtml(d) {
    return `<details class="rtw-other"><summary>已停辦的環球獎勵機票、現金環球票</summary>
      <ul>${d.ended.map((e) => `<li><b>${esc(e.name)}</b>：${esc(e.text)} <a href="${esc(e.url)}" target="_blank" rel="noopener">官方公告 ↗</a></li>`).join('')}</ul>
      <p class="hint">付現金的環球票（不用哩程）：${d.cashFares.map((c) => `<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.name)} ↗</a>`).join('、')}</p>
      <p class="hint">${esc(d.note)}（${esc(d.lastReviewed)} 整理）</p></details>`;
  }

  function rtwClick(e) {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.rm != null) {
      const i = Number(t.dataset.rm);
      const n = rtw.stops.length;
      rtw.stops.splice(i, 1);
      // Removing a middle stop joins its two legs into one, which keeps the earlier leg's date and airline.
      rtw.legs.splice(i === 0 ? 0 : i === n - 1 ? i - 1 : i, 1);
      rtw.legs.length = Math.max(0, rtw.stops.length - 1);
    } else if (t.dataset.go != null) return rtwGo(Number(t.dataset.go));
    else if (t.dataset.pick) { rtw.program = t.dataset.pick; $('#rtw-prog').value = rtw.program; }
    else if (t.hasAttribute('data-close')) { rtw.legs.push({ date: '', airline: '', surface: false }); rtw.stops.push({ code: rtw.stops[0].code, stay: 'stop' }); }
    else if (t.hasAttribute('data-clear')) { rtw.stops = []; rtw.legs = []; }
    else if (t.hasAttribute('data-example')) {
      rtw.stops = ['TPE', 'HKG', 'LHR', 'JFK', 'LAX', 'TPE'].map((code) => ({ code, stay: 'stop' }));
      rtw.legs = ['CX', 'CX', 'BA', 'AA', 'CX'].map((airline) => ({ date: '', airline, surface: false }));
    } else return;
    rtwSave();
    rtwDraw();
  }

  function rtwChange(e) {
    const t = e.target;
    const ds = t.dataset;
    if (ds.stay != null) rtw.stops[Number(ds.stay)].stay = t.value;
    else if (ds.date != null) rtw.legs[Number(ds.date)].date = t.value;
    else if (ds.air != null) rtw.legs[Number(ds.air)].airline = t.value.trim().toUpperCase().slice(0, 2);
    else if (ds.surface != null) rtw.legs[Number(ds.surface)].surface = t.checked;
    else return;
    rtwSave();
    rtwDraw();
  }

  // 查這段: the normal search for one leg (one seats.aero call): a week around its date, or the next month without one.
  function rtwGo(i) {
    const l = rtwTrip({ stops: rtw.stops, legs: rtw.legs }, rtwApOf, rtwData().areas).legs[i];
    if (!l) return;
    const prog = rtwData().programs.find((p) => p.id === rtw.program);
    const f = $('#search-form');
    pickers.origin.set([l.from]);
    pickers.destination.set([l.to]);
    const today = isoDate(0);
    if (/^\d{4}-\d{2}-\d{2}$/.test(l.date) && l.date >= today) {
      const s = isoDateFrom(l.date, -3);
      datePickers.search.set(s < today ? today : s, isoDateFrom(l.date, 3));
    } else datePickers.search.set('');
    f.alliance.value = prog?.alliance || '';
    f.carrier.value = l.airline && data.airlines.airlines.some((a) => a.code === l.airline) ? l.airline : '';
    if (f.carrier.value) f.alliance.value = data.airlines.airlines.find((a) => a.code === l.airline)?.alliance || f.alliance.value;
    carrierHint();
    setCabin(rtw.cabin);
    f.requestSubmit();
  }

  // ---- 國泰混艙計算 (inside 規則庫 › 亞洲萬里通哩數表; that section re-renders, so the state lives here) ----
  const cxMix = { kind: 'cx', stops: [], cabins: [] };
  window.cxMixHtml = function cxMixHtml() {
    const m = rtwData()?.cxMixed;
    if (!m || !data.asiamiles) return '';
    return `<details class="sub-fold cxmix" id="cxmix"><summary><h3 class="sub">國泰混艙計算</h3><small>例如一段商務、一段頭等，要多少哩</small></summary>
      <div class="cxmix-body">
        <p class="hint">官方規則：${esc(m.rule)} <a href="${esc(m.source.url)}" target="_blank" rel="noopener">${esc(m.source.label)} ↗</a>（${esc(m.source.checked)} 查核）</p>
        <fieldset class="seg" id="cxmix-kind" aria-label="航班">${[['cx', '國泰航班'], ['partner', '單一夥伴航空']].map(([k, l]) => `<label><input type="radio" name="cxmix-kind" value="${k}" ${cxMix.kind === k ? 'checked' : ''}><span>${l}</span></label>`).join('')}</fieldset>
        <div id="cxmix-add"></div>
        <div id="cxmix-out" aria-live="polite"></div>
        <details class="cxmix-ex"><summary>算法範例</summary>${cxMixExampleHtml(m)}</details>
        <ul class="hint cxmix-notes">${m.notes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      </div></details>`;
  };

  const cxBandLabel = (band) => `${(data.asiamiles.bands.find((b) => band.startsWith(b.id)) || {}).name || band}${band === 'short2' ? '第二類' : ''}`;
  function cxMixLegs(stops, cabins) {
    const legs = [];
    for (let i = 1; i < stops.length; i++) {
      const a = AP.byCode.get(stops[i - 1]);
      const b = AP.byCode.get(stops[i]);
      legs.push({ from: stops[i - 1], to: stops[i], dist: a && b && a.lat != null && b.lat != null ? haversineMiles(a, b) : 0, cabin: cabins[i - 1] || 'J' });
    }
    return legs;
  }
  function cxMixTable(q) {
    const name = (c) => CABIN_LABEL[c];
    return `<div class="table-wrap"><table class="cxmix-table"><thead><tr><th>航段</th><th>距離</th><th>艙等</th><th>${esc(cxBandLabel(q.band))}全程價</th><th>分攤</th></tr></thead><tbody>
      ${q.rows.map((r) => `<tr><td>${esc(r.from)} → ${esc(r.to)}</td><td>${fmt(r.dist)} 哩</td><td>${name(r.cabin)}</td><td>${fmt(r.full)}</td><td>${fmt(r.full)} × ${fmt(r.dist)} ÷ ${fmt(q.total)} = ${fmt(Math.round(r.share))}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="cxmix-res">合計 ${fmt(Math.round(q.raw * 10) / 10)}，捨去到百位：<b>約 ${fmt(q.miles)} 哩</b>（全程${name(q.top)}要 ${fmt(q.topMiles)} 哩${q.topMiles > q.miles ? `，省 ${fmt(q.topMiles - q.miles)} 哩` : ''}）</p>`;
  }
  function cxMixExampleHtml(m) {
    if (!AP.loaded) return '<p class="hint">打開後載入機場資料再顯示範例。</p>';
    const ex = m.example;
    const q = cxMixQuote(data.asiamiles, ex.kind, cxMixLegs(ex.stops, ex.cabins), ex.stops[0], ex.stops.at(-1));
    if (!q?.rows) return '';
    return `<p class="hint">${esc(ex.stops.join(' → '))}，${ex.cabins.map((c, i) => `${ex.stops[i]}→${ex.stops[i + 1]} ${CABIN_LABEL[c]}`).join('、')}（${ex.kind === 'cx' ? '國泰航班' : '夥伴航班'}）：兩段距離相加 ${fmt(q.total)} 哩，屬於「${esc(cxBandLabel(q.band))}」。</p>${cxMixTable(q)}`;
  }
  function cxMixDraw() {
    const out = $('#cxmix-out');
    if (!out) return;
    const n = cxMix.stops.length;
    const legs = cxMixLegs(cxMix.stops, cxMix.cabins);
    const list = n ? `<ol class="rtw-list">${cxMix.stops.map((c, i) => `<li class="rtw-stop"><span class="rtw-no">${i + 1}</span><b>${esc(c)}</b> <span>${esc(rtwPlace(c))}</span><button type="button" class="ghost rtw-rm" data-cxrm="${i}" aria-label="移除 ${esc(c)}">✕</button></li>${i < n - 1 ? `<li class="rtw-leg"><span class="rtw-dist">✈ ${fmt(legs[i].dist)} 哩</span>
        <label class="rtw-in">艙等<select data-cxcab="${i}">${RTW_CABINS.map((k) => `<option value="${k}" ${legs[i].cabin === k ? 'selected' : ''}>${CABIN_LABEL[k]}</option>`).join('')}</select></label></li>` : ''}`).join('')}</ol>
      <div class="rtw-tools"><button type="button" class="linklike" data-cxclear>清除</button></div>`
      : '<p class="hint">依序加入同一個方向的機場（例如 TPE、HKG、LHR），再選每段的艙等。<button type="button" class="linklike" data-cxex>載入範例</button></p>';
    let res = '';
    if (n > 1) {
      const q = cxMixQuote(data.asiamiles, cxMix.kind, legs, cxMix.stops[0], cxMix.stops.at(-1));
      if (!q) res = '<p class="hint">有機場找不到位置，算不出距離。</p>';
      else if (q.missing) res = `<p class="hint">${esc(cxBandLabel(q.band))}的${cxMix.kind === 'cx' ? '國泰' : '夥伴'}哩數表沒有${q.missing.map((c) => CABIN_LABEL[c]).join('、')}，算不出來。</p>`;
      else res = `<p class="hint">各段相加 ${fmt(q.total)} 哩，屬於「${esc(cxBandLabel(q.band))}」（${cxMix.kind === 'cx' ? '國泰航班' : '夥伴航班'}表）。</p>${cxMixTable(q)}
        <p class="hint">估算：區間哩數取自本站亞洲萬里通哩數表（媒體整理），距離是本站算的大圓距離，和國泰系統可能差幾十哩。來回時去程、回程各算一次再相加。</p>`;
    }
    out.innerHTML = list + res;
  }
  function cxMixMount(det) {
    const add = $('#cxmix-add', det);
    if (!add || add.dataset.ready) return;
    add.dataset.ready = '1';
    loadAirports().then(() => {
      rtwStopPicker(add, 'cxmix-next', (codes) => {
        cxMix.stops.push(...codes);
        cxMix.stops.length = Math.min(cxMix.stops.length, 8);
        while (cxMix.cabins.length < cxMix.stops.length - 1) cxMix.cabins.push('J');
        cxMixDraw();
      });
      const ex = $('.cxmix-ex', det);
      if (ex) ex.innerHTML = `<summary>算法範例</summary>${cxMixExampleHtml(rtwData().cxMixed)}`;
      cxMixDraw();
    });
    det.addEventListener('change', (e) => {
      if (e.target.name === 'cxmix-kind') cxMix.kind = e.target.value;
      else if (e.target.dataset.cxcab != null) cxMix.cabins[Number(e.target.dataset.cxcab)] = e.target.value;
      else return;
      cxMixDraw();
    });
    det.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.cxrm != null) { const i = Number(b.dataset.cxrm); cxMix.stops.splice(i, 1); cxMix.cabins.splice(Math.min(i, cxMix.cabins.length - 1), 1); cxMix.cabins.length = Math.max(0, cxMix.stops.length - 1); }
      else if (b.hasAttribute('data-cxclear')) { cxMix.stops = []; cxMix.cabins = []; }
      else if (b.hasAttribute('data-cxex')) { const ex = rtwData().cxMixed.example; cxMix.kind = ex.kind; cxMix.stops = [...ex.stops]; cxMix.cabins = [...ex.cabins]; $$('input[name=cxmix-kind]', det).forEach((i) => (i.checked = i.value === cxMix.kind)); }
      else return;
      cxMixDraw();
    });
  }

  // Both tools draw when their fold first opens (toggle doesn't bubble, so listen while it travels down).
  document.addEventListener('toggle', (e) => {
    const t = e.target;
    if (!t.open) return;
    if (t.id === 'rtw-panel') rtwMount();
    else if (t.id === 'cxmix') cxMixMount(t);
  }, true);
  // A panel that is already open (a restored page) draws now.
  if ($('#rtw-panel')?.open) rtwMount();
}
