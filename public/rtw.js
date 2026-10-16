// 環球票規劃 (multi-city / round-the-world award planner, its own page #rtw with a map) and 國泰混艙計算 (規則庫 › 亞洲萬里通哩數表).
// Loaded after features.js; uses the shared globals (data, AP, haversineMiles, amBand, earnHtml, transferRates, pickers…).
// Rules and charts come from data/rtw.json (official pages only). The pure part comes first so tests can run it in a vm.

// ---------- pure logic ----------
const RTW_CABINS = ['Y', 'W', 'J', 'F'];
const CABIN_RANK = { Y: 0, W: 1, J: 2, F: 3 };
const RTW_STATUS_ICON = { ok: '✓', bad: '✗', warn: '⚠', na: '・' };

// IATA area of an airport: 1 Americas, 2 Europe/Africa/Middle East, 3 Asia/Pacific (Russia split at the Urals).
function rtwArea(areas, ap) {
  if (!ap) return 0;
  const split = areas.splitLon?.[ap.country];
  if (split != null && ap.lon != null) return ap.lon >= split ? 3 : 2;
  if (areas.tc1.includes(ap.country)) return 1;
  return areas.tc3.includes(ap.country) ? 3 : 2;
}

// Legs with their great-circle miles; surface legs (開口, 陸路) are kept apart because programs count them differently.
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
      date: L.date || '', airline: String(L.airline || '').trim().toUpperCase(), cabin: L.cabin || '',
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

// The distance a program prices: flown miles, plus the surface legs (開口) for some; Qantas also adds the direct way back
// to the origin when the trip ends somewhere else (its T&C 14.4.3: a one-way trip is charged as a return). → { d, back }
function rtwDistance(prog, trip) {
  const pr = prog.price;
  const d = pr.basis === 'withSurface' ? trip.total : trip.flown;
  const a = trip.pts?.[0]?.ap;
  const b = trip.pts?.at(-1)?.ap;
  let back = 0;
  if (pr.returnToOrigin && a?.lat != null && b?.lat != null) back = haversineMiles(b, a);
  if (back < 50) back = 0; // back in the same city (TSA for TPE)
  return { d: d + back, back };
}

// Price from the program's chart: { miles, unit, dist, back, band: { idx, lo, hi } } or { pending } / { over } / null.
function rtwPrice(prog, trip, cabin, charts) {
  const pr = prog.price;
  if (!prog.cabins.includes(cabin)) return { noCabin: true };
  if (pr.kind === 'fixed') return pr[cabin] ? { miles: pr[cabin], unit: pr.unit || '哩', fixed: true } : { noCabin: true };
  const { d, back } = rtwDistance(prog, trip);
  if (pr.kind === 'pending') return { pending: true, dist: d, back, over: d > pr.max };
  const bands = pr.bands || charts?.programs?.find((p) => p.id === pr.chartRef)?.tables?.[0]?.bands;
  if (!bands || !d) return null;
  if (d > pr.max) return { over: true, dist: d, back };
  const idx = bands.findIndex((b) => d <= b.upTo);
  if (idx < 0 || !bands[idx][cabin]) return { noCabin: true };
  return { miles: bands[idx][cabin], unit: pr.unit || '哩', dist: d, back, band: { idx, lo: idx ? bands[idx - 1].upTo + 1 : 1, hi: bands[idx].upTo } };
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
  // 混艙: ctx.cabin is the highest cabin of the legs (what every program here prices); ctx.legCabins the cabin of each leg.
  const MC = prog.mixedCabin || {};
  const used = [...new Set((ctx.legCabins || []).filter(Boolean))];
  if (!prog.cabins.includes(ctx.cabin)) {
    if (MC.extraLegCabins?.includes(ctx.cabin)) add('bad', `${CABIN_LABEL[ctx.cabin]}航段只能放在${MC.extraWith.map((c) => CABIN_LABEL[c]).join('或')}獎勵裡，不能單獨兌換`);
    else add('bad', `這個計畫沒有${CABIN_LABEL[ctx.cabin]}`);
  } else if (used.length > 1) {
    if (MC.pricing === 'highest') add('ok', `混艙：整趟依最高艙等（${CABIN_LABEL[ctx.cabin]}）計價`);
    else add('warn', `混艙：官方規則沒寫能不能混艙、怎麼計價，這裡先用最高艙等（${CABIN_LABEL[ctx.cabin]}）的價格（我推測）`);
  }
  const max = prog.price.max;
  if (max) {
    const { d, back } = rtwDistance(prog, trip);
    const incl = [prog.price.basis === 'withSurface' && surfaces.length ? '開口' : '', back ? `從終點回到出發地的 ${fmt(back)} 哩` : ''].filter(Boolean);
    add(d <= max ? 'ok' : 'bad', `總距離 ${fmt(d)} 哩${incl.length ? `（含${incl.join('和')}）` : ''}，上限 ${fmt(max)} 哩`);
  }
  // 開口 the program's official rules don't mention (Miles & More, TAP mid-trip): allowed by the planner, flagged here.
  if (R.surface === 'unstated' && surfaces.length) add('warn', '官方規則沒寫中途可不可以開口（自行前往），這張票可能不接受');
  // JAL: a surface sector longer than the way from the first departure to where it starts makes it two tickets.
  if (R.surfaceNotLongerThanStart && origin) {
    for (const l of surfaces) {
      const from = pts[l.i].ap;
      const reach = from?.lat != null && origin.lat != null ? haversineMiles(origin, from) : null;
      if (reach != null && l.dist > reach) add('bad', `開口 ${l.from}→${l.to}（${fmt(l.dist)} 哩）比從出發地到 ${l.from}（${fmt(reach)} 哩）還遠，日航不接受這樣的開口`);
    }
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
  if (R.maxFlights) add(flights.length <= R.maxFlights ? 'ok' : 'bad', `航班 ${flights.length} 段，上限 ${R.maxFlights} 段${surfaces.length ? '（開口不算）' : ''}`);
  if (R.maxSegments) add(trip.legs.length <= R.maxSegments ? 'ok' : 'bad', `共 ${trip.legs.length} 段${surfaces.length ? '（含開口）' : ''}，上限 ${R.maxSegments} 段（開口也算）`);
  if (R.maxStopovers != null) {
    const stops = n('stop') + (R.surfaceIsStopover ? surfaces.length : 0);
    add(stops <= R.maxStopovers ? 'ok' : 'bad', `停留 ${stops} 次，上限 ${R.maxStopovers} 次${R.surfaceIsStopover && surfaces.length ? '（開口算 1 次停留）' : ''}`);
  }
  if (R.maxTransfers != null) add(n('transfer') <= R.maxTransfers ? 'ok' : 'bad', `轉機 ${n('transfer')} 次，上限 ${R.maxTransfers} 次`);
  if (R.maxSurface != null && surfaces.length) add(surfaces.length <= R.maxSurface ? 'ok' : 'bad', `開口 ${surfaces.length} 次，上限 ${R.maxSurface} 次`);
  const tally = (pick) => {
    const m = new Map();
    pts.forEach((p, i) => { if (pick(i)) m.set(city(i), (m.get(city(i)) || 0) + 1); });
    return [...m].filter(([, c]) => c > 1).map(([k]) => k);
  };
  // Asia Miles puts open-jaw cities (where a surface sector starts) under the same once-per-city and not-at-the-ends rule.
  const openAt = (i) => Boolean(trip.legs[i]?.surface);
  const stopLike = (i) => stays[i] === 'stop' || (R.openJawLikeStop && openAt(i));
  const stopWord = R.openJawLikeStop ? '停留或開口' : '停留';
  if (R.stopoverOncePerCity) {
    const twice = tally(stopLike);
    if (twice.length) add('bad', `${twice.join('、')} ${stopWord}超過 1 次（同一城市只能${stopWord} 1 次）`);
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
    const bad = pts.map((p, i) => i).filter((i) => i > 0 && i < pts.length - 1 && stopLike(i) && ends.has(city(i))).map((i) => pts[i].code);
    if (bad.length) add('bad', `${bad.join('、')} 是出發地或目的地，不能在這裡${stopWord}`);
  }
  // Asia Miles: the T&C don't say, but the chart is for a return (round) trip and planners expect the end in the origin
  // country; and ending in another city may itself count as one of the two open jaws.
  if (R.endHomeWarn && origin && end && pts.length > 2) {
    if (origin.country !== end.country) add('warn', '最後沒有回到出發的國家：條款沒寫，但國泰官網註明這張哩數表用於來回飛行獎勵，可能不接受');
    else if (city(0) !== city(pts.length - 1)) add('warn', `終點 ${pts.at(-1).code} 和起點 ${pts[0].code} 不同城市，可能也算 1 次開口`);
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
  // Route data (rtw-routes.json): legs no allowed airline flies nonstop, and airlines picked for a leg they don't fly.
  if (ctx.routes && flights.length) {
    const allowed = rtwCarriers(prog, ctx.members);
    const none = [];
    const off = [];
    for (const l of flights) {
      if (!pts[l.i].ap || !pts[l.i + 1].ap) continue;
      const x = rtwLegAir(ctx.routes, l.from, l.to, allowed);
      if (!x.flying.length) none.push(`${l.from}→${l.to}`);
      else if (allowed.includes(l.airline) && !x.flying.includes(l.airline)) off.push(`${l.from}→${l.to}（${l.airline}）`);
    }
    if (none.length) add('warn', `${none.join('、')}：航線資料裡沒有可搭的航空公司直飛這段（資料可能不完整；也可以中途轉機或改成開口）`);
    if (off.length) add('warn', `${off.join('、')}：航線資料裡這家航空公司沒有直飛這段`);
    if (!none.length && !off.length) add('ok', '每段都有可搭的航空公司直飛紀錄');
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
        if (R.validity.note) add('warn', R.validity.note);
      }
      if (R.minDays) {
        // Miles & More's T&C: from the first to the last long-haul flight (here: a flight between two areas).
        const far = dated.filter((l) => l.area[0] && l.area[1] && l.area[0] !== l.area[1]).map((l) => l.date).sort();
        if (far.length > 1) {
          const gap = rtwDays(far[0], far.at(-1));
          add(gap >= R.minDays ? 'ok' : 'bad', `第一段到最後一段長程（跨洲）航班相隔 ${gap} 天，至少要 ${R.minDays} 天`);
        } else add('na', `填上第一段和最後一段長程（跨洲）航班的日期，就能檢查「至少相隔 ${R.minDays} 天」`);
      }
    }
  }
  return out;
}

// Airlines the program lets you fly, in the program's own order (JAL lists them; the others take the whole alliance).
function rtwCarriers(prog, members) {
  const c = prog.rules?.carriers || {};
  return c.list || members[c.alliance || prog.alliance] || [];
}

// ---- 航線資料 (data/rtw-routes.json, fetched when the page opens): which airlines fly each airport pair nonstop ----
// raw.routes holds each pair once, under the code that sorts first: { HKG: 'NRT:CXJLNH TPE:BRCX' } (two-letter codes).
// → { pairs: Map('HKG NRT' → ['CX', 'JL', 'NH']), from: Map('HKG' → Map('NRT' → [...])), source }
const rtwPairKey = (a, b) => (a < b ? `${a} ${b}` : `${b} ${a}`);
function rtwRouteIndex(raw) {
  const pairs = new Map();
  const from = new Map();
  const link = (a, b, list) => { if (!from.has(a)) from.set(a, new Map()); from.get(a).set(b, list); };
  for (const [a, s] of Object.entries(raw?.routes || {})) {
    for (const e of String(s).split(' ')) {
      const [b, codes] = e.split(':');
      const list = codes?.match(/[A-Z0-9]{2}/g);
      if (!/^[A-Z]{3}$/.test(b || '') || !list) continue;
      pairs.set(rtwPairKey(a, b), list);
      link(a, b, list);
      link(b, a, list);
    }
  }
  return { pairs, from, source: raw?.source || null };
}

// One leg: the allowed airlines that fly it nonstop (in the program's order) and the other alliance airlines that do.
function rtwLegAir(index, from, to, allowed) {
  if (!index) return null;
  const list = index.pairs.get(rtwPairKey(from, to)) || [];
  return { flying: allowed.filter((c) => list.includes(c)), others: list.filter((c) => !allowed.includes(c)), known: list.length > 0 };
}

// Where the program's airlines fly nonstop from an airport → [{ code, carriers }], most airlines first.
function rtwNextStops(index, from, allowed) {
  const m = index?.from.get(from);
  if (!m) return [];
  return [...m].map(([code, list]) => ({ code, carriers: allowed.filter((c) => list.includes(c)) }))
    .filter((x) => x.carriers.length).sort((a, b) => b.carriers.length - a.carriers.length || a.code.localeCompare(b.code));
}

// 混艙: the cabins a leg may take in this program (JAL also takes a premium economy leg inside a business or first award).
function rtwLegCabins(prog) {
  const extra = prog.mixedCabin?.extraLegCabins || [];
  return RTW_CABINS.filter((c) => prog.cabins.includes(c) || extra.includes(c));
}
// Each flight leg's cabin (its own when 混艙 is on, otherwise the trip's) and the highest one, which these programs price.
function rtwCabinsOf(prog, trip, cabin, mixed) {
  const opts = rtwLegCabins(prog);
  const legs = trip.legs.map((l) => (l.surface ? null : mixed && opts.includes(l.cabin) ? l.cabin : cabin));
  const used = [...new Set(legs.filter(Boolean))];
  const top = used.reduce((t, c) => (CABIN_RANK[c] > CABIN_RANK[t] ? c : t), used[0] || cabin);
  return { legs, top, mixed: used.length > 1 };
}

// Whether the program takes a surface sector (開口), and how it counts it.
function rtwOpenJaw(prog) {
  const R = prog.rules || {};
  if (R.maxSurface === 0) return null;
  return { max: R.maxSurface ?? null, stopover: Boolean(R.surfaceIsStopover), inDistance: prog.price.basis === 'withSurface', unstated: R.surface === 'unstated' };
}

// A distance-priced program's chart as a meter: the trip's distance, the bands up to the cap with this cabin's price,
// the band the trip is in, and how many more miles reach the next one. null for fixed-price programs.
function rtwMeter(prog, trip, cabin, charts) {
  const pr = prog.price;
  if (pr.kind !== 'distance' && pr.kind !== 'pending') return null;
  const { d } = rtwDistance(prog, trip);
  const all = pr.kind === 'distance' ? pr.bands || charts?.programs?.find((p) => p.id === pr.chartRef)?.tables?.[0]?.bands || [] : [];
  const bands = all.filter((b, i) => i === 0 || all[i - 1].upTo < pr.max).map((b) => ({ upTo: Math.min(b.upTo, pr.max), miles: b[cabin] || null }));
  const idx = bands.findIndex((b) => d <= b.upTo);
  const next = idx >= 0 && idx + 1 < bands.length ? { at: bands[idx].upTo + 1, miles: bands[idx + 1].miles } : null;
  return { d, max: pr.max, bands, idx, next, left: next ? next.at - d : null };
}

// A few words on what makes each program different, for its card: price basis, the cap, the counts.
function rtwKeyFacts(prog) {
  const R = prog.rules || {};
  const f = [prog.price.kind === 'fixed' ? '固定價' : `依總距離計價・${Number(prog.price.max).toLocaleString('en-US')} 哩內`];
  if (R.crossings) f.push('要跨太平洋和大西洋');
  if (R.maxStopovers != null) f.push(`停留 ${R.maxStopovers} 次`);
  if (R.maxFlights) f.push(`${R.maxFlights} 段航班`);
  const oj = rtwOpenJaw(prog);
  f.push(!oj ? '不能開口' : oj.unstated ? '開口沒寫' : `開口${oj.max != null ? ` ${oj.max} 次` : ''}`);
  return f;
}

// Points along the great circle from a to b ({ lat, lon } in degrees), each longitude carried on from the one before
// (starting near lon0), so a line across the date line keeps going instead of jumping across the map.
function rtwArc(a, b, lon0 = a.lon, n = 32) {
  const r = Math.PI / 180;
  const [p1, l1, p2, l2] = [a.lat * r, a.lon * r, b.lat * r, b.lon * r];
  const d = 2 * Math.asin(Math.min(1, Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2)));
  const out = [];
  let prev = lon0;
  const steps = Math.sin(d) < 1e-9 ? 1 : n;
  for (let k = 0; k <= steps; k++) {
    let lat;
    let lon;
    if (steps === 1) [lat, lon] = k ? [b.lat, b.lon] : [a.lat, a.lon];
    else {
      const A = Math.sin((1 - k / n) * d) / Math.sin(d);
      const B = Math.sin((k / n) * d) / Math.sin(d);
      const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
      const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
      lat = Math.atan2(A * Math.sin(p1) + B * Math.sin(p2), Math.hypot(x, y)) / r;
      lon = Math.atan2(y, x) / r;
    }
    lon += Math.round((prev - lon) / 360) * 360;
    out.push([lat, lon]);
    prev = lon;
  }
  return out;
}

// ---------- 國泰混艙計算: Asia Miles Standard Award, one direction ----------
// Official rule (Cathay membership T&C 2026, Standard Awards cl. 3): the zone comes from the direction's summed sector
// distances; each sector's cabin price in that zone is prorated by its share of the great-circle distance; the sum is
// rounded down to the hundred. legs: [{ from, to, dist, cabin }]; o/d decide the short-haul type 2 (Japan, India…).
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

// Where a direction's summed distance sits in the distance zones: the zone's range and how many more miles reach the
// next one (the zone prices every leg, so staying under its top keeps the whole direction in the cheaper zone).
function cxBandRoom(am, total) {
  const i = am.bands.findIndex((b) => b.max == null || total <= b.max);
  if (i < 0) return null;
  const b = am.bands[i];
  const next = am.bands[i + 1];
  return { lo: i ? am.bands[i - 1].max + 1 : 1, hi: b.max, left: b.max == null ? null : b.max + 1 - total, next: next?.name || '' };
}

// ---------- page (browser only) ----------
if (typeof document !== 'undefined') {
  const RTW_KEY = 'rtw:v1';
  const rtw = { program: '', cabin: 'J', mixed: false, stops: [], legs: [] };
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

  // ---- 環球票規劃 (its own page, #rtw: the planner beside a map; planning only, no seat searches) ----
  const RTW_STAY_LABEL = { stop: '停留（逾 24 小時）', transfer: '轉機（24 小時內）' };
  const rtwAirName = (c) => { const n = airlineZh(c); return n === c ? '' : n; };
  let rtwMap = null;
  let rtwLayer = null;
  let rtwAirOpen = -1; // the leg whose airline list is open
  let rtwAirAll = false; // that list also shows the allowed airlines with no nonstop record
  let rtwNextOpen = false; // the 「直飛的機場」 list under the stop picker is open
  // data/rtw-routes.json (which airlines fly each airport pair), fetched when the page opens; until then every allowed
  // airline is offered.
  let rtwRoutes = null;
  let rtwRoutesP = null;
  let rtwRoutesFailed = false;
  const rtwRoutesLoad = () => (rtwRoutesP ||= api('/api/data/rtwroutes').then((raw) => {
    rtwRoutes = rtwRouteIndex(raw);
    rtwRoutes.meta = { note: raw.note, source: raw.source };
    rtwRoutesFailed = false;
    rtwDraw();
  }, () => { rtwRoutesP = null; rtwRoutesFailed = true; rtwDraw(); }));

  function rtwMount() {
    const host = $('#rtw-page');
    if (!host || host.dataset.ready) return;
    host.dataset.ready = '1';
    host.innerHTML = skeleton(3);
    Promise.all([loadMore(), loadAirports()]).then(() => {
      const d = rtwData();
      if (!d) { host.innerHTML = '<p class="hint">環球票資料載入失敗，請重新整理。</p>'; return; }
      if (rtw.program && !d.programs.some((p) => p.id === rtw.program)) rtw.program = '';
      host.innerHTML = `<div class="rtw-layout">
          <div class="rtw-main">
            <h2 class="rtw-step">1. 選哩程計畫</h2>
            <div class="rtw-progs" role="radiogroup" aria-label="哩程計畫">${d.programs.map((p) => `<label class="rtw-prog">
              <input type="radio" name="rtw-prog" value="${esc(p.id)}" ${p.id === rtw.program ? 'checked' : ''}>
              <span class="rtw-prog-in">${allianceLogo(p.alliance, 'xs')}<b>${esc(p.short)}</b><small>${esc(p.name)}</small>
                <span class="rtw-facts">${rtwKeyFacts(p).map((t) => `<span>${esc(t)}</span>`).join('')}</span></span></label>`).join('')}</div>
            <div id="rtw-plan"></div>
          </div>
          <aside class="rtw-side" aria-label="行程地圖"><div id="rtw-map" class="ex-map rtw-map"><p class="hint">地圖載入中…</p></div>
            <p class="hint rtw-legend"><span class="rtw-key"></span>飛行　<span class="rtw-key surface"></span>開口（自行前往）</p></aside>
        </div>`;
      $('.rtw-progs', host).addEventListener('change', (e) => { rtw.program = e.target.value; rtwSave(); rtwPlan(); });
      rtwPlan();
      rtwMapInit();
      rtwRoutesLoad();
    }, () => { host.dataset.ready = ''; host.innerHTML = '<p class="hint">資料載入失敗，請檢查網路後再打開一次。</p>'; });
  }

  // The part under the program cards: cabin, the stop picker and the itinerary. Built again when the program changes.
  function rtwPlan() {
    const box = $('#rtw-plan');
    const prog = rtwData().programs.find((p) => p.id === rtw.program);
    if (!prog) { box.innerHTML = '<p class="hint rtw-pick-first">先選一個計畫：每個計畫的規則不同，下面的選項會跟著計畫改變。</p>'; rtwMapDraw(null); return; }
    if (!prog.cabins.includes(rtw.cabin)) rtw.cabin = prog.cabins.includes('J') ? 'J' : prog.cabins[0];
    box.innerHTML = `<h2 class="rtw-step">2. 艙等和城市</h2>
      <div class="rtw-cabin-row"><fieldset class="seg" id="rtw-cabin" aria-label="艙等">${prog.cabins.map((c) => `<label><input type="radio" name="rtw-cabin" value="${c}" ${c === rtw.cabin ? 'checked' : ''}><span>${CABIN_LABEL[c].replace('艙', '')}</span></label>`).join('')}</fieldset>
        <label class="rtw-mixed"><input type="checkbox" id="rtw-mixed" ${rtw.mixed ? 'checked' : ''}> 混艙（每段選艙等）</label></div>
      <div id="rtw-add"></div>
      <div id="rtw-hops"></div>
      <div id="rtw-out" aria-live="polite"></div>`;
    $('#rtw-cabin').addEventListener('change', (e) => { rtw.cabin = e.target.value; rtwSave(); rtwDraw(); });
    $('#rtw-mixed').addEventListener('change', (e) => { rtw.mixed = e.target.checked; rtwSave(); rtwDraw(); });
    rtwStopPicker($('#rtw-add'), 'rtw-next', rtwAddStops);
    const next = $('#rtw-hops');
    next.addEventListener('click', (e) => { const b = e.target.closest('[data-addstop]'); if (b) rtwAddStops([b.dataset.addstop]); });
    next.addEventListener('toggle', (e) => { rtwNextOpen = e.target.open; }, true);
    const out = $('#rtw-out');
    out.addEventListener('click', rtwClick);
    out.addEventListener('change', rtwChange);
    out.addEventListener('input', (e) => { if (e.target.matches('.rtw-air-q')) rtwAirFilter(e.target); });
    out.addEventListener('keydown', rtwAirKeys);
    rtwDraw();
  }

  function rtwAddStops(codes) {
    for (const c of codes) {
      if (rtw.stops.length >= 20) { toast('最多 20 站'); break; }
      if (rtw.stops.length) rtw.legs.push({ date: '', airline: '', surface: false });
      rtw.stops.push({ code: c, stay: 'stop' });
    }
    rtwSave();
    rtwDraw();
  }

  // Under the stop picker: the airports the program's airlines fly to nonstop from the last stop, by IATA area,
  // each a button that adds it (collapsed: it can be a hundred airports from a hub).
  const RTW_AREA_NAME = [[3, '亞洲・大洋洲'], [2, '歐洲・非洲・中東'], [1, '美洲'], [0, '其他']];
  function rtwNextHtml(allowed) {
    const last = rtw.stops.at(-1)?.code;
    if (!last || !rtwRoutes) return '';
    const list = rtwNextStops(rtwRoutes, last, allowed);
    if (!list.length) return `<p class="hint rtw-next-none">航線資料裡沒有這個計畫可搭的航空公司從 ${esc(last)} 直飛的紀錄。</p>`;
    const areaOf = (c) => rtwArea(rtwData().areas, AP.byCode.get(c));
    const groups = RTW_AREA_NAME.map(([a, name]) => [name, list.filter((x) => areaOf(x.code) === a)]).filter(([, xs]) => xs.length);
    return `<details class="rtw-next"${rtwNextOpen ? ' open' : ''}><summary>從 ${esc(last)} 有可搭的航空公司直飛的機場（${list.length} 個）</summary>
      ${groups.map(([name, xs]) => `<div class="rtw-next-g"><h3>${name}</h3><div class="rtw-next-list">${xs.map((x) => `<button type="button" class="rtw-next-opt" data-addstop="${x.code}" aria-label="加入 ${x.code} ${esc(rtwPlace(x.code))}（${x.carriers.join('、')}）"><b>${x.code}</b><span>${esc(rtwPlace(x.code))}</span><small>${x.carriers.join(' ')}</small></button>`).join('')}</div></div>`).join('')}
      <p class="hint">點一下就加入下一站。依飛機愛好者整理的航班呼號紀錄，可能還列著已停飛的航線，也可能漏掉新航線。</p></details>`;
  }

  // The airline button of a leg: the logo and code, or 選航空公司.
  function rtwAirBtn(l, allowed) {
    const c = l.airline;
    const off = c && !allowed.includes(c);
    return `<button type="button" class="rtw-air${off ? ' off' : ''}" data-airbtn="${l.i}" aria-haspopup="listbox" aria-expanded="${rtwAirOpen === l.i}"
      aria-label="第 ${l.i + 1} 段航空公司：${c ? esc(`${c} ${rtwAirName(c)}`) : '還沒選'}">${c ? `${airlineLogo(c, 'xs')}<span>${esc(c)}</span>` : '<span>選航空公司</span>'}<span class="rtw-caret" aria-hidden="true">▾</span></button>`;
  }
  // The airline list of a leg. With the route data: the allowed airlines that fly the leg nonstop, and the rest of the
  // allowed airlines behind 「顯示全部可搭的航空公司」 (the data may miss a route); without it, every allowed airline.
  function rtwAirPop(l, allowed, info) {
    const i = l.i;
    const cur = l.airline;
    const opts = (codes) => `<div class="rtw-air-list" role="listbox">${codes.map((c) => `<button type="button" role="option" class="rtw-air-opt" data-air="${i}" data-code="${c}" aria-selected="${c === cur}" data-q="${esc(`${c} ${rtwAirName(c)}`.toLowerCase())}">${airlineLogo(c, 'xs')}<b>${c}</b><span>${esc(rtwAirName(c))}</span></button>`).join('')}</div>`;
    const leg = `${esc(l.from)}→${esc(l.to)}`;
    let body;
    let shown = allowed.length;
    if (!info) body = (rtwRoutesFailed ? '<p class="rtw-air-note">直飛資料沒有載入，先列出全部可搭的航空公司。</p>' : rtwRoutesP && !rtwRoutes ? '<p class="rtw-air-note">直飛資料載入中…</p>' : '') + opts(allowed);
    else {
      const rest = allowed.filter((c) => !info.flying.includes(c));
      const all = rtwAirAll || (cur && rest.includes(cur));
      const others = info.others.map((c) => `${c}${rtwAirName(c) ? ` ${rtwAirName(c)}` : ''}`).join('、');
      const head = info.flying.length ? `<p class="rtw-air-note">${leg} 有直飛紀錄、這個計畫可搭的航空公司</p>`
        : `<p class="rtw-air-note warn">航線資料裡沒有這個計畫可搭的航空公司直飛 ${leg}${others ? `（有直飛紀錄的是 ${esc(others)}，這個計畫不能搭）` : ''}。資料可能不完整。</p>`;
      shown = info.flying.length + (all ? rest.length : 0);
      body = head + (info.flying.length ? opts(info.flying) : '')
        + (!rest.length ? '' : all ? `<p class="rtw-air-note">${info.flying.length ? '其他' : ''}可搭的航空公司（沒有直飛紀錄）</p>${opts(rest)}`
          : `<button type="button" class="linklike rtw-air-all" data-airall>顯示全部可搭的航空公司（${allowed.length} 家）</button>`);
    }
    return `<div class="rtw-air-pop" role="dialog" aria-label="選第 ${i + 1} 段的航空公司">
      ${shown > 8 ? '<input class="rtw-air-q" type="search" placeholder="搜尋代碼或名稱" aria-label="搜尋航空公司" autocomplete="off" spellcheck="false">' : ''}
      ${body}
      ${cur ? `<button type="button" class="linklike rtw-air-clear" data-air="${i}" data-code="">不指定</button>` : ''}</div>`;
  }
  function rtwAirFilter(q) {
    const v = q.value.trim().toLowerCase();
    $$('.rtw-air-opt', q.closest('.rtw-air-pop')).forEach((b) => { b.hidden = Boolean(v) && !b.dataset.q.includes(v); });
  }
  function rtwAirKeys(e) {
    if (rtwAirOpen < 0) return;
    if (e.key === 'Escape') { const i = rtwAirOpen; rtwAirOpen = -1; rtwDraw(); $(`[data-airbtn="${i}"]`)?.focus(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const opts = $$('.rtw-air-pop .rtw-air-opt').filter((b) => !b.hidden);
    if (!opts.length) return;
    e.preventDefault();
    const at = opts.indexOf(document.activeElement);
    opts[(at + (e.key === 'ArrowDown' ? 1 : -1) + opts.length + (at < 0 && e.key === 'ArrowUp' ? 1 : 0)) % opts.length].focus();
  }

  function rtwDraw() {
    const out = $('#rtw-out');
    const d = rtwData();
    const prog = d?.programs.find((p) => p.id === rtw.program);
    if (!out || !prog) return;
    const plan = { stops: rtw.stops, legs: rtw.legs };
    const trip = rtwTrip(plan, rtwApOf, d.areas);
    const shape = rtwShape(trip);
    const allowed = rtwCarriers(prog, rtwMembers());
    const oj = rtwOpenJaw(prog);
    const n = rtw.stops.length;
    const last = n - 1;
    const cab = rtwCabinsOf(prog, trip, rtw.cabin, rtw.mixed);
    const legCabs = rtwLegCabins(prog);
    const nextBox = $('#rtw-hops');
    if (nextBox) nextBox.innerHTML = rtwNextHtml(allowed);
    // A program without surface sectors: any 開口 kept from another program goes back to a flight.
    if (!oj) trip.legs.forEach((l) => { if (l.surface) { rtw.legs[l.i].surface = false; l.surface = false; } });
    const openLabel = !oj ? '' : oj.unstated ? '開口（自行前往；官方沒寫，可能不行）' : `開口（自行前往下一站${oj.stopover ? '，算 1 次停留' : ''}）`;
    const stayOf = (i) => (trip.legs[i]?.surface ? 'open' : rtw.stops[i].stay === 'transfer' ? 'transfer' : 'stop');
    const stopRow = (s, i) => {
      let what = '';
      if (i > 0 && i < last && trip.legs[i - 1]?.surface) what = '<span class="rtw-tag">開口另一端，從這裡繼續飛</span>';
      else if (i > 0 && i < last) {
        const v = stayOf(i);
        what = `<select data-stay="${i}" aria-label="${esc(s.code)} 停多久">${Object.entries(RTW_STAY_LABEL).map(([k, t]) => `<option value="${k}" ${v === k ? 'selected' : ''}>${t}</option>`).join('')}
          ${oj ? `<option value="open" ${v === 'open' ? 'selected' : ''}>${openLabel}</option>` : ''}</select>`;
      }
      return `<li class="rtw-stop"><span class="rtw-no">${i + 1}</span><b>${esc(s.code)}</b> <span>${esc(rtwPlace(s.code))}</span>${what}
        <button type="button" class="ghost rtw-rm" data-rm="${i}" aria-label="移除 ${esc(s.code)}">✕</button></li>`;
    };
    const known = (l) => trip.pts[l.i].ap && trip.pts[l.i + 1].ap;
    const legRow = (l) => {
      if (l.surface) return `<li class="rtw-leg surface"><span class="rtw-dist">開口・自行前往 ${fmt(l.dist)} 哩</span>
        <label class="rtw-in">日期<input type="date" data-date="${l.i}" value="${esc(l.date)}"></label></li>`;
      const info = known(l) ? rtwLegAir(rtwRoutes, l.from, l.to, allowed) : null;
      const none = info && !info.flying.length ? '<span class="rtw-noair">沒有直飛紀錄</span>' : '';
      const cabSel = rtw.mixed ? `<label class="rtw-in">艙等<select data-cab="${l.i}">${legCabs.map((c) => `<option value="${c}" ${cab.legs[l.i] === c ? 'selected' : ''}>${CABIN_LABEL[c].replace('艙', '')}</option>`).join('')}</select></label>` : '';
      return `<li class="rtw-leg"><span class="rtw-dist">✈ ${fmt(l.dist)} 哩</span>
        <span class="rtw-in rtw-air-host">航空${rtwAirBtn(l, allowed)}${rtwAirOpen === l.i ? rtwAirPop(l, allowed, info) : ''}</span>${none}${cabSel}
        <label class="rtw-in">日期<input type="date" data-date="${l.i}" value="${esc(l.date)}"></label></li>`;
    };
    const ex = prog.example ? `<button type="button" class="linklike" data-example>看範例：${esc(prog.example.stops.map((c) => rtwPlace(c) || c).join(' → '))}</button>` : '';
    const list = n ? `<ol class="rtw-list">${rtw.stops.map((s, i) => stopRow(s, i) + (i < last ? legRow(trip.legs[i]) : '')).join('')}</ol>
      <div class="rtw-tools">${n > 1 && rtw.stops[0].code !== rtw.stops[last].code ? `<button type="button" class="outline" data-close>↩ 回到起點 ${esc(rtw.stops[0].code)}</button>` : ''}<button type="button" class="linklike" data-clear>清除全部</button></div>`
      : `<p class="hint rtw-empty">還沒有城市，從上面依序加入。${ex}</p>`;
    rtwMapDraw(trip);
    if (n < 2) { out.innerHTML = list + rtwOtherHtml(d); return; }
    const ctx = { cabin: cab.top, legCabins: cab.legs, members: rtwMembers(), cityOf: rtwCityOf, today: isoDate(0), routes: rtwRoutes };
    const ck = rtwChecks(prog, plan, trip, ctx);
    const price = rtwPrice(prog, trip, cab.top, data.charts);
    const flights = trip.legs.filter((l) => !l.surface).length;
    const dirText = prog.rules.crossings ? `・${shape.dir === 'east' ? '往東' : shape.dir === 'west' ? '往西' : shape.dir === 'mixed' ? '方向有改變' : '還沒跨區'}` : '';
    const sum = `<p class="rtw-sum">總飛行距離 <b>${fmt(trip.flown)} 哩</b>${trip.surface ? `（另有開口 ${fmt(trip.surface)} 哩${oj?.inDistance ? '，這個計畫也算進總距離' : '，不算進總距離'}）` : ''}・${flights} 段航班${dirText}</p>`;
    // Round-the-world programs: the shape comes first (two oceans, one direction, home again); distance programs: the meter.
    let shapeHtml = '';
    if (prog.rules.crossings) {
      const c = prog.rules.crossings;
      const dir = shape.dir === 'east' ? '往東' : shape.dir === 'west' ? '往西' : shape.dir === 'mixed' ? '方向有改變' : '還沒跨區';
      const o = trip.pts[0]?.ap;
      const e = trip.pts.at(-1)?.ap;
      const steps = [
        [shape.pacific >= c.pacific && (!c.exact || shape.pacific === c.pacific), `跨太平洋 ${shape.pacific} 次`],
        [shape.atlantic >= c.atlantic && (!c.exact || shape.atlantic === c.atlantic), `跨大西洋 ${shape.atlantic} 次`],
        ...(prog.rules.sameDirection ? [[shape.dir === 'east' || shape.dir === 'west', `全程同方向：${dir}`]] : []),
        ...(prog.rules.endInOriginCountry ? [[Boolean(o && e && o.country === e.country), '回到出發的國家']] : []),
      ];
      shapeHtml = `<ol class="rtw-shape" aria-label="環球條件">${steps.map(([ok, t]) => `<li class="${ok ? 'ok' : ''}"><span aria-hidden="true">${ok ? '✓' : '○'}</span>${esc(t)}</li>`).join('')}</ol>`;
    } else {
      const m = rtwMeter(prog, trip, cab.top, data.charts);
      if (m) {
        const pct = (x) => `${Math.min(100, (x / m.max) * 100).toFixed(1)}%`;
        const ticks = m.bands.slice(0, -1).map((b) => `<i style="left:${pct(b.upTo)}"></i>`).join('');
        const nextTxt = m.d > m.max ? `超過上限 ${fmt(m.d - m.max)} 哩`
          : m.next ? `再 ${fmt(m.left)} 哩會跳到下一級${m.next.miles ? `（${fmt(m.next.miles)} ${rtwUnit(prog)}）` : ''}` : '已在最高一級';
        shapeHtml = `<div class="rtw-meter" role="img" aria-label="總距離 ${fmt(m.d)} 哩，上限 ${fmt(m.max)} 哩"><div class="rtw-bar${m.d > m.max ? ' over' : ''}"><span style="width:${pct(m.d)}"></span>${ticks}</div>
          <small>${fmt(m.d)} / ${fmt(m.max)} 哩${m.bands.length ? `・${esc(nextTxt)}` : ''}</small></div>`;
      }
    }
    let head;
    if (price?.miles) head = `<b class="rtw-miles">${prog.price.secondary ? '約 ' : ''}${fmt(price.miles)} ${rtwUnit(prog)}</b><small>${CABIN_LABEL[cab.top]}${cab.mixed ? '（混艙，依最高艙等）' : ''}・${price.fixed ? '固定價' : `總距離 ${fmt(price.dist)} 哩${price.back ? `（含從終點回到出發地 ${fmt(price.back)} 哩）` : ''}，落在 ${fmt(price.band.lo)}–${fmt(price.band.hi)} 哩這一級`}・每人</small>`;
    else if (price?.pending) head = `<b class="rtw-miles">價格待確認</b><small>${esc(prog.price.why)} <a href="${esc(prog.price.chartUrl)}" target="_blank" rel="noopener">國泰哩數表 ↗</a>（總距離 ${fmt(price.dist)} 哩）</small>`;
    else head = `<b class="rtw-miles">${esc(rtwPriceText(prog, price, cab.top))}</b>`;
    const sec = prog.price.secondary;
    if (price?.miles && sec) head += `<small class="rtw-price-note">${esc(sec.note)} ${sec.sources.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a>`).join('、')}・<a href="${esc(prog.price.chartUrl)}" target="_blank" rel="noopener">國泰官網哩數表 ↗</a></small>`;
    else if (price?.miles && prog.price.chartUrl) head += `<small class="rtw-price-note">哩數依官網哩數表（${esc(prog.sources.find((s) => s.url === prog.price.chartUrl)?.checked || rtwData().lastReviewed)} 核對）・<a href="${esc(prog.price.chartUrl)}" target="_blank" rel="noopener">官網哩數表 ↗</a></small>`;
    const MC = prog.mixedCabin;
    if (cab.mixed && MC) {
      head += `<small class="rtw-price-note">混艙：${esc(MC.text)}${MC.url ? `（<a href="${esc(MC.url)}" target="_blank" rel="noopener">官方規則 ↗</a>）` : ''}${MC.cxMixLink ? `。只搭國泰（或國泰加 1 家夥伴）的一般飛行獎勵，混艙改依距離比例分攤，比較省：<a href="#rules" data-cxmix-link>國泰混艙計算</a>` : ''}</small>`;
    }
    const key = prog.walletKey;
    const earn = !price?.miles ? '' : transferRates(key).length ? earnHtml(key, price.miles) : '<p class="hint">台灣的信用卡點數目前沒有直接轉入這個計畫。</p>';
    const res = `<div class="rtw-price">${head}</div>${shapeHtml}${earn}
      <ul class="rtw-checks">${ck.map((x) => `<li class="${x.s}"><span aria-hidden="true">${RTW_STATUS_ICON[x.s]}</span> ${esc(x.t)}</li>`).join('')}</ul>
      <p class="hint">這裡只做規劃，不查座位、不用額度。訂位方式：${esc(prog.howToBook)}</p>
      <details class="rtw-rules"><summary>${esc(prog.name)}：規則重點與官方來源</summary>
        <ul>${prog.summary.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
        ${MC ? `<p class="hint">混艙：${esc(MC.text)}${MC.pricing === 'unstated' ? '；本站先用最高艙等的價格估（我推測）' : ''}。</p>` : ''}
        <p class="hint">來源：${prog.sources.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a>（${esc(s.checked)} 查核）`).join('、')}</p>
        ${rtwTipsHtml(prog.tips)}
        ${rtwRoutes?.meta ? `<p class="hint">航空公司選單的直飛紀錄：<a href="${esc(rtwRoutes.meta.source.url)}" target="_blank" rel="noopener">${esc(rtwRoutes.meta.source.label)}</a>（${esc(rtwRoutes.meta.source.licence)}，${esc(rtwRoutes.meta.source.fetched)} 取得）。${esc(rtwRoutes.meta.note)}</p>` : ''}</details>`;
    out.innerHTML = list + sum + res + rtwOtherHtml(d);
    if (rtwAirOpen >= 0) {
      // Bring the whole menu into view (it opens below the button), then focus its search box.
      $('.rtw-air-pop')?.scrollIntoView({ block: 'nearest' });
      ($('.rtw-air-pop .rtw-air-q') || $('.rtw-air-pop [aria-selected="true"]') || $('.rtw-air-pop .rtw-air-opt'))?.focus({ preventScroll: true });
    }
  }

  // Practical tips from a third-party article, kept apart from the official rules and labelled as such.
  function rtwTipsHtml(tips) {
    if (!tips?.items?.length) return '';
    return `<div class="rtw-tips"><b>第三方整理（不是官方規則，僅供參考）</b><ul>${tips.items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
      <p class="hint">出處：<a href="${esc(tips.url)}" target="_blank" rel="noopener">${esc(tips.label)}</a></p></div>`;
  }

  function rtwPriceText(p, price, cabin) {
    if (!price) return '—';
    if (price.noCabin) return `沒有${CABIN_LABEL[cabin]}`;
    if (price.pending || price.over) return price.over ? `超過 ${fmt(p.price.max)} 哩上限` : '待確認';
    return `${fmt(price.miles)} ${rtwUnit(p)}`;
  }

  function rtwOtherHtml(d) {
    return `<details class="rtw-other"><summary>已停辦的環球獎勵機票、現金環球票</summary>
      <ul>${d.ended.map((e) => `<li><b>${esc(e.name)}</b>：${esc(e.text)} <a href="${esc(e.url)}" target="_blank" rel="noopener">官方公告 ↗</a></li>`).join('')}</ul>
      <p class="hint">付現金的環球票（不用哩程）：${d.cashFares.map((c) => `<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.name)} ↗</a>`).join('、')}</p>
      <p class="hint">${esc(d.note)}（${esc(d.lastReviewed)} 整理）</p></details>`;
  }

  function rtwClick(e) {
    const t = e.target.closest('button');
    if (!t) { if (rtwAirOpen >= 0 && !e.target.closest('.rtw-air-pop')) { rtwAirOpen = -1; rtwDraw(); } return; }
    if (t.dataset.airbtn != null) {
      const i = Number(t.dataset.airbtn);
      rtwAirOpen = rtwAirOpen === i ? -1 : i;
      rtwAirAll = false;
      rtwDraw();
      return;
    }
    if (t.hasAttribute('data-airall')) {
      rtwAirAll = true;
      const n = $$('.rtw-air-pop .rtw-air-opt').length;
      rtwDraw();
      $$('.rtw-air-pop .rtw-air-opt')[n]?.focus();
      return;
    }
    if (t.dataset.air != null && t.dataset.code != null) {
      const i = Number(t.dataset.air);
      rtw.legs[i].airline = t.dataset.code;
      rtwAirOpen = -1;
      rtwSave();
      rtwDraw();
      $(`[data-airbtn="${i}"]`)?.focus();
      return;
    }
    rtwAirOpen = -1;
    if (t.dataset.rm != null) {
      const i = Number(t.dataset.rm);
      const n = rtw.stops.length;
      rtw.stops.splice(i, 1);
      // Removing a middle stop joins its two legs into one, which keeps the earlier leg's date and airline.
      rtw.legs.splice(i === 0 ? 0 : i === n - 1 ? i - 1 : i, 1);
      rtw.legs.length = Math.max(0, rtw.stops.length - 1);
    } else if (t.hasAttribute('data-close')) { rtw.legs.push({ date: '', airline: '', surface: false }); rtw.stops.push({ code: rtw.stops[0].code, stay: 'stop' }); }
    else if (t.hasAttribute('data-clear')) { rtw.stops = []; rtw.legs = []; }
    else if (t.hasAttribute('data-example')) {
      const ex = rtwData().programs.find((p) => p.id === rtw.program)?.example;
      if (!ex) return;
      rtw.stops = ex.stops.map((code, i) => ({ code, stay: ex.stays?.[i] === 'transfer' ? 'transfer' : 'stop' }));
      rtw.legs = ex.airlines.map((airline, i) => ({ date: '', airline: airline || '', surface: ex.stays?.[i] === 'open' }));
    } else return;
    rtwSave();
    rtwDraw();
  }

  function rtwChange(e) {
    const t = e.target;
    const ds = t.dataset;
    if (ds.stay != null) {
      const i = Number(ds.stay);
      // 開口 here: the leg from this stop to the next is travelled on your own (a surface sector).
      rtw.legs[i].surface = t.value === 'open';
      if (t.value !== 'open') rtw.stops[i].stay = t.value;
      // Two surface sectors in a row are one: the stop in between can't open again.
      if (t.value === 'open' && rtw.legs[i + 1]?.surface) rtw.legs[i + 1].surface = false;
    } else if (ds.date != null) rtw.legs[Number(ds.date)].date = t.value;
    else if (ds.cab != null) rtw.legs[Number(ds.cab)].cabin = t.value;
    else return;
    rtwSave();
    rtwDraw();
  }

  // ---- the map beside the planner (Leaflet, the same base map as 兌換地圖) ----
  function rtwMapInit() {
    const el = $('#rtw-map');
    if (!el || rtwMap || typeof loadLeaflet !== 'function') return;
    loadLeaflet().then(() => {
      if (rtwMap || !el.isConnected) return;
      el.innerHTML = '';
      const L = window.L;
      // An itinerary around the world runs past ±180°: the plain fallback map draws its land again on both sides.
      rtwMap = L.map(el, { scrollWheelZoom: false, zoomSnap: 0.25, minZoom: 0, landCopies: [-360, 360] });
      addBaseMap(rtwMap);
      keepMapSized(rtwMap);
      rtwLayer = L.layerGroup().addTo(rtwMap);
      rtwMap.setView([25, 140], 1.5);
      const prog = rtwData()?.programs.find((p) => p.id === rtw.program);
      rtwMapDraw(prog ? rtwTrip({ stops: rtw.stops, legs: rtw.legs }, rtwApOf, rtwData().areas) : null);
    }, (err) => { el.innerHTML = `<p class="hint">${esc(err.message)}</p>`; });
  }
  function rtwMapDraw(trip) {
    if (!rtwMap) return;
    const L = window.L;
    rtwLayer.clearLayers();
    const pts = trip?.pts || [];
    if (!pts.some((p) => p.ap)) { rtwMap.setView([25, 140], 1.5); return; }
    // Each stop where the line reaches it, longitudes carried on so the loop keeps going round the world.
    const at = [];
    const lines = [];
    pts.forEach((p, i) => {
      if (!p.ap) { at.push(null); return; }
      if (!i || !at[i - 1] || !pts[i - 1].ap) {
        const prev = at.findLast?.((x) => x) || null;
        const lon = prev ? p.ap.lon + Math.round((prev[1] - p.ap.lon) / 360) * 360 : p.ap.lon;
        at.push([p.ap.lat, lon]);
        return;
      }
      const arc = rtwArc(pts[i - 1].ap, p.ap, at[i - 1][1]);
      lines.push({ arc, surface: trip.legs[i - 1]?.surface });
      at.push(arc.at(-1));
    });
    for (const l of lines) L.polyline(l.arc, { className: `rtw-line${l.surface ? ' surface' : ''}`, weight: l.surface ? 2 : 3, dashArray: l.surface ? '5 7' : null, interactive: false }).addTo(rtwLayer);
    // One pin per place: a loop that ends where it began, at the same spot on the map, shows 1・6 on one pin.
    const pins = new Map();
    at.forEach((x, i) => {
      if (!x) return;
      const k = `${x[0].toFixed(3)},${x[1].toFixed(3)}`;
      if (!pins.has(k)) pins.set(k, { x, nos: [], code: pts[i].code });
      pins.get(k).nos.push(i + 1);
    });
    for (const p of pins.values()) {
      // The start and end sit on top when a nearby stop overlaps them at world zoom.
      const ends = p.nos.includes(1) || p.nos.includes(at.length);
      L.marker(p.x, { icon: L.divIcon({ className: 'rtw-pin', html: `<span class="rtw-pin-n">${p.nos.join('・')}</span><span class="rtw-pin-c">${esc(p.code)}</span>`, iconSize: null, iconAnchor: [13, 13] }), keyboard: false, zIndexOffset: ends ? 1000 : 0 })
        .bindTooltip(`${p.nos.join('・')}. ${esc(p.code)} ${esc(rtwPlace(p.code))}`).addTo(rtwLayer);
    }
    const all = [...lines.flatMap((l) => l.arc), ...at.filter(Boolean)];
    rtwMap.fitBounds(L.latLngBounds(all), { paddingTopLeft: [24, 20], paddingBottomRight: [60, 20], maxZoom: 5 });
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
        ${rtwTipsHtml(m.tips)}
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
      else {
        const room = cxBandRoom(data.asiamiles, q.total);
        const range = room && (room.hi ? `${fmt(room.lo)}–${fmt(room.hi)} 哩` : `${fmt(room.lo)} 哩以上`);
        const roomTxt = room ? `（${range}${room.left != null && room.next ? `；再多 ${fmt(room.left)} 哩就會跳到${room.next}` : ''}）` : '';
        res = `<p class="hint">各段相加 ${fmt(q.total)} 哩，屬於「${esc(cxBandLabel(q.band))}」${roomTxt}，用${cxMix.kind === 'cx' ? '國泰航班' : '夥伴航班'}表。</p>${cxMixTable(q)}`
          + `<p class="hint">估算：區間哩數取自本站亞洲萬里通哩數表（媒體整理），距離是本站算的大圓距離，和國泰系統可能差幾十哩。來回時去程、回程各算一次再相加。</p>`;
      }
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
    if (e.target.open && e.target.id === 'cxmix') cxMixMount(e.target);
  }, true);
  // 「國泰混艙計算」 from the planner's price note: 規則庫 with the calculator open.
  document.addEventListener('click', (e) => {
    if (!e.target.closest?.('[data-cxmix-link]')) return;
    e.preventDefault();
    showTab('rules');
    setTimeout(() => {
      const m = $('#cxmix');
      if (!m) return;
      m.closest('details:not(#cxmix)')?.setAttribute('open', '');
      m.open = true;
      m.scrollIntoView({ block: 'start' });
    }, 80);
  });
  // 「中停／開口組合」 in the page's lead: back to 航線查詢 with that panel open.
  document.addEventListener('click', (e) => {
    if (!e.target.closest?.('[data-open-combo]')) return;
    setTimeout(() => { const p = $('#combo-panel'); if (p) { p.open = true; p.scrollIntoView({ block: 'center' }); } }, 50);
  });
  // The 環球票規劃 page (#rtw) asks for it when it opens (app.js tabInit.rtw), or already did before this script arrived.
  window.rtwMount = rtwMount;
  if (currentTab === 'rtw') rtwMount();
}
