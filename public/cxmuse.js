// 「🤖 請 AI 助理查官網」: the owner's own AI assistant (Muse, ChatGPT or Gemini agents) opens an airline's own award
// page (國泰, 華航, 長榮, 星宇 via Alaska, 日航, ANA: data/muse-templates.json, served at /api/data/musetemplates), logs in
// with the owner's account where needed, and reads award space day by day, which seats.aero data does not show.
// This site never sees a password and calls no AI (except 貼上截圖, cxshot.js, on the owner's click): it only writes
// the instruction (copied to the clipboard) and reads back the assistant's text answer (「貼上 AI 助理的結果」), drawn
// with cxcal.js's calendar (CXCAL.cxView) and saved, on request and with the passcode, to /api/cxcal as source 'ai'
// with the airline (cxlive.js's 「<航空>官網實查」 card). No quota is spent.
// An action of the 國泰／亞洲萬里通 card (cxcard.js), shown only where the passcode is (owner).
// Loaded after cxauto.js; uses aihelper.js's aiCopy and app.js's globals.

// ---------- pure logic (test/cxmuse.test.js) ----------
const MUSE_MAX_PAIRS = 3;
const MUSE_CN = { Y: '經濟', W: '豪華經濟', J: '商務', F: '頭等' };
const MUSE_EX = { Y: 20000, W: 30000, J: 58000, F: 90000 }; // only for the format sample in the prompt
// The words an answer may use for a day: 有位 and 無位 for every airline, 充足／有限／稀少 (華航's three price levels)
// and 候補 (waitlist only: 長榮's △). Stored as the cabin's `st`: p, l, s, w.
const MUSE_ST = { 充足: 'p', 有限: 'l', 稀少: 's', 候補: 'w' };
const MUSE_ST_CN = { p: '充足', l: '有限', s: '稀少', w: '候補' };

const museIso = (y, m, d) => {
  const s = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const t = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === s ? s : '';
};
const museAdd = (iso, n) => { const t = new Date(`${iso}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const museDays = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5) + 1;
// The last day of an n-month run from iso: 08-01 + 1 → 08-31; 08-15 + 2 → 10-14; 01-31 + 1 → 02-27.
const museMonthsEnd = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  const last = new Date(Date.UTC(y, m + n, 0)).getUTCDate(); // days in the month n months on
  return museAdd(new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))).toISOString().slice(0, 10), -1);
};
const museZh = (iso, year = true) => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${year ? `${y} 年 ` : ''}${m} 月 ${d} 日（${'日一二三四五六'[new Date(`${iso}T00:00:00Z`).getUTCDay()]}）`;
};
const musePlace = (name, code) => `${name && name !== code ? `${name} ` : ''}${code}`;
const museCabinOf = (tpl, c) => ((tpl.cabins || ['Y', 'W', 'J', 'F']).includes(c) ? c : (tpl.cabins || []).includes('J') ? 'J' : (tpl.cabins || ['J'])[0]);
const museQuote = (xs) => xs.map((x) => `「${x}」`).join('');

// The instruction for the assistant. o: { tpl (one airline of data/muse-templates.json), pairs: [{ fc, tc, from, to }],
// start, end, cabin, pax, extras: ['upgrade'] }. → { text, start, end, capped, cabin } (end is cut to the airline's
// months per run; `capped` says it was).
function museBuildPrompt(o) {
  const t = o.tpl;
  const pairs = (o.pairs || []).slice(0, MUSE_MAX_PAIRS);
  const cabin = museCabinOf(t, o.cabin);
  const cn = MUSE_CN[cabin];
  const pax = Math.max(1, Math.min(9, Number(o.pax) || 1));
  const months = Math.max(1, Number(t.monthsPerRun) || 1);
  const start = o.start;
  const askEnd = o.end && o.end >= start ? o.end : start;
  const capEnd = museMonthsEnd(start, months);
  const capped = askEnd > capEnd;
  const end = capped ? capEnd : askEnd;
  const statuses = t.statuses?.length ? t.statuses : ['有位', '無位'];
  const L = [];
  L.push(t.login
    ? `請到${t.site}幫我查${t.full}的獎勵機票座位（${t.program}），只查不訂。需要登入時，用我自己的${t.program}帳號：`
    : `請到${t.site}幫我查用${t.program}兌換${t.full}的獎勵機票座位，只查不訂；這個網站查票不用登入：`, t.url);
  if (t.path) L.push(`・查票路徑：${t.path}`);
  L.push('');
  if (pairs.length === 1) L.push(`・航線（單程）：${musePlace(pairs[0].from, pairs[0].fc)} → ${musePlace(pairs[0].to, pairs[0].tc)}`);
  else {
    L.push(`・航線（單程，共 ${pairs.length} 組，每組分開查）：`);
    pairs.forEach((p, i) => L.push(`　${i + 1}. ${musePlace(p.from, p.fc)} → ${musePlace(p.to, p.tc)}`));
  }
  L.push(`・日期：${museZh(start)} 到 ${museZh(end, end.slice(0, 4) !== start.slice(0, 4))}，共 ${museDays(start, end)} 天`);
  if (capped) L.push(`　（我在網站上查的是 ${museZh(start)} 到 ${museZh(askEnd, askEnd.slice(0, 4) !== start.slice(0, 4))}；${t.name}一次最多查${months === 1 ? '一個月' : ` ${months} 個月`}，所以這次只查前 ${museDays(start, end)} 天）`);
  L.push(`・艙等：${cn}艙`, `・人數：${pax} 位${t.paxNote ? `（${t.paxNote}）` : pax > 1 ? `（請確認 ${pax} 位都訂得到）` : ''}`, '');
  L.push('登入與安全（很重要）：',
    t.login
      ? '1. 要登入時，請用你（AI 助理）自己的安全登入表單或密碼保管功能向我要會員號碼和密碼；絕對不要叫我把密碼打在聊天裡，也不要在回覆中寫出密碼。簡訊或電郵驗證碼也一樣。'
      : '1. 這個網站查票不用登入；如果它要你登入或填個人資料，先停下來問我，絕對不要叫我把密碼打在聊天裡。',
    '2. 只查詢：不要訂位、不要保留機位、不要付款、不要兌換或扣哩程，也不要更改帳號的任何設定。',
    `3. 放慢速度：${(t.pace || []).join('')}看到驗證、錯誤或「請稍後再試」的畫面，就先停下來告訴我。`);
  if (pairs.length > 1) L.push(`4. ${t.pairWait || '一組航線查完再查下一組，中間一樣放慢速度。'}`);
  if (t.read?.length) L.push('', '怎麼看結果：', ...t.read.map((x) => `・${x}`));
  const sym = (t.symbols || []).filter(([a, b]) => a !== b);
  L.push('', `每一天請記下${cn}艙的：`,
    `・狀態：只能用${museQuote(statuses)}其中一個詞${sym.length ? `（${sym.map(([a, b]) => `網頁上的「${a}」寫「${b}」`).join('，')}）` : ''}`,
    `・${statuses.filter((x) => !['無位', '候補'].includes(x)).join('、')}的話，最低要幾哩（每人單程，只寫數字；網頁沒顯示就不寫）`,
    `・畫面有顯示航班編號的話，最低哩數那班的航班編號（轉機用 / 連起來，例如 ${t.flight}100/${t.flight}200）`, '');
  const p0 = pairs[0] || { fc: 'TPE', tc: 'HKG' };
  const ok0 = statuses.find((x) => !['無位', '候補'].includes(x)) || '有位';
  const short = statuses.filter((x) => ['無位', '候補'].includes(x)).join('和');
  L.push('全部查完後，請把結果放在「一個」純文字程式碼區塊裡回覆（```text 開頭、``` 結尾），格式完全照下面，一行一天，不要改成表格，方便我貼回網站。下面兩行只是格式範例，不是真的結果：',
    '```text',
    `${t.name}查票結果 ${p0.fc}-${p0.tc}`,
    `${start} | ${cn} | ${ok0} | ${MUSE_EX[cabin]} | ${t.flight}000`,
    `${museAdd(start, 1)} | ${cn} | 無位`,
    '```',
    `欄位依序是：日期 | 艙等 | 狀態 | 最低哩數 | 航班編號；狀態只能是${museQuote(statuses)}；${short || '無位'}的只寫前三欄。${pairs.length > 1 ? `每組航線先寫一行「${t.name}查票結果 出發代碼-抵達代碼」，再接那組的每一天。` : ''}沒查到的日期不要寫。`);
  for (const x of t.extras || []) if ((o.extras || []).includes(x.id)) L.push('', x.text);
  return { text: L.join('\n'), start, end, capped, cabin };
}

// The optional phone call (templates with `phone`): the owner fills in their name and member number inside the
// assistant; this site never asks for them. o: { tpl, pair, start, cabin, pax }.
function musePhonePrompt(o) {
  const t = o.tpl;
  const p = o.pair || { fc: 'TPE', tc: 'HKG' };
  const cabin = museCabinOf(t, o.cabin);
  const pax = Math.max(1, Math.min(9, Number(o.pax) || 1));
  const a = museAdd(o.start, -7);
  const b = museAdd(o.start, 7);
  return [
    `請你幫我打${t.full}的訂位／會員客服電話，問${t.program}獎勵機票的座位，只問不訂：`,
    `・電話：請用${t.site}公布的客服電話（台灣或我所在地區的）`,
    `・航線（單程）：${musePlace(p.from, p.fc)} → ${musePlace(p.to, p.tc)}`,
    `・日期：${museZh(o.start)} 的前後 7 天（${a} 到 ${b}）`,
    `・艙等：${MUSE_CN[cabin]}艙`,
    `・人數：${pax} 位`,
    '・我的姓名：（你的姓名）',
    '・我的會員號碼：（你的會員號碼）',
    '',
    '注意：',
    '1. 客服要核對身分時，只提供上面的姓名和會員號碼；不要提供密碼、信用卡、證件號碼或任何其他資料。',
    '2. 只問有沒有位：不要訂位、不要保留機位、不要付款或扣哩程，也不要同意任何收費。',
    '3. 這段時間都沒有位的話，請客服往前、往後各找第一個有位的日期。',
    '4. 客服不願意和 AI 助理談，就禮貌地結束通話，告訴我結果就好。',
    '',
    '問完後請照下面的格式回覆（放在一個 ```text 程式碼區塊裡，一行一天；有位寫「有位」、候補寫「候補」、沒位寫「無位」）。下面一行只是格式範例，不是真的結果：',
    '```text',
    `${t.name}查票結果 ${p.fc}-${p.tc}`,
    `${o.start} | ${MUSE_CN[cabin]} | 有位 | ${MUSE_EX[cabin]} | ${t.flight}000`,
    '```',
  ].join('\n');
}

// Full-width letters, digits and punctuation → ASCII; box-drawing bars → |.
const museNorm = (s) => String(s).replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  .replace(/[\u3000\u00A0]/g, ' ').replace(/[│┃︱¦∣]/g, '|');
const MUSE_SEP = '\\s*(?:-|–|—|→|->|>|~|至|到|/)\\s*';
const MUSE_HEAD = new RegExp(`^[\\s#*>\`_|]*([^|\\d]{0,24}?)\\s*(查票結果|升等結果)\\s*[:：]?\\s*([A-Za-z]{3})${MUSE_SEP}([A-Za-z]{3})(?![A-Za-z])`);
const MUSE_BARE = new RegExp(`^[\\s#*>\`_|]*([A-Z]{3})${MUSE_SEP}([A-Z]{3})[\\s*_\`|:：]*$`);
const MUSE_DATE = /^[\s|*•·>`-]*(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?(?:\s*[（(][^）)]*[）)])?/;
const MUSE_FL = '(?:[A-Z][A-Z0-9]|[0-9][A-Z])\\s?\\d{1,4}';
const MUSE_FLIGHTS = new RegExp(`(?<![A-Z0-9])${MUSE_FL}(?:\\s*[/+›>→]\\s*${MUSE_FL})*(?![0-9])`, 'g');

function museCabin(s) {
  if (/豪華經濟|豪华经济|豪經|特選經濟|premium/i.test(s) || /(^|[|\s])W([|\s]|$)/.test(s)) return 'W';
  if (/頭等|头等|first/i.test(s) || /(^|[|\s])F([|\s]|$)/.test(s)) return 'F';
  if (/商務|商务|business/i.test(s) || /(^|[|\s])[JC]([|\s]|$)/.test(s)) return 'J';
  if (/經濟|经济|economy/i.test(s) || /(^|[|\s])Y([|\s]|$)/.test(s)) return 'Y';
  return '';
}
// { ok, st } or null when the line does not say. 候補 (or △) first: no seats, but a waitlist. "沒有位" holds "有位"
// and "有限" holds "有", so the 「無」 words and the three price levels go before the plain 「有」.
function museStatus(s) {
  if (/候補|候补|waitlist|wait\s*list|[△▲]/i.test(s)) return { ok: false, st: 'w' };
  if (/無位|无位|沒位|没位|沒有|没有|無|无|不適用|不适用|額滿|额满|售完|已滿|[✗✘❌×✕╳]|\bno\b|\bnone\b|unavailable|sold\s*out|\bN\/A\b/i.test(s)) return { ok: false, st: '' };
  if (/充足/.test(s)) return { ok: true, st: 'p' };
  if (/有限/.test(s)) return { ok: true, st: 'l' };
  if (/稀少|稀有/.test(s)) return { ok: true, st: 's' };
  if (/有位|有|可訂|可订|[○◯〇●✓✔✅]|\byes\b|available/i.test(s)) return { ok: true, st: '' };
  return null;
}

// An airline name from a header ("華航", "中華航空", "EVA") → its template id, or '' when unknown.
function museAirOf(name, airlines) {
  const s = String(name || '').replace(/[\s#*>`_|:：「」【】[\]]/g, '').toLowerCase();
  if (!s) return '';
  let best = '';
  let len = 0;
  for (const a of airlines || []) {
    for (const al of [a.name, a.full, ...(a.aliases || [])]) {
      const k = String(al || '').replace(/\s/g, '').toLowerCase();
      if (k && s.includes(k) && k.length > len) { best = a.id; len = k.length; }
    }
  }
  return best;
}

// The assistant's answer → { routes: [{ air, fc, tc, days, cabins, range }], read, skipped }. Days have the 官網實查
// record shape (lib/cxcal-store.js): { c: { J: { m, f: [{ n, d, a, p, s, m }], st? } } } for a day with seats (m = 0
// when no miles were given; st p/l/s for 充足／有限／稀少), { c: { J: { m: 0, na: 1, st: 'w' } } } for 候補 and
// { c: { J: { m: 0, na: 1 } } } for 無位. A header 「<航空>查票結果 TPE-HKG」 starts a route of that airline (opts.airlines:
// the templates, for the names; an unknown or missing name keeps the airline before it, else opts.air, else 'cx');
// a 「<航空>升等結果」 block is not stored and its lines are ignored. Lines without a leading date are prose and are
// ignored; date lines without a cabin or a status count as `skipped`. Lines before any header go to opts.fallback
// ({ fc, tc }), and a line without a cabin takes opts.cabin when given.
function museParse(text, opts = {}) {
  const routes = new Map();
  let air = opts.air || 'cx';
  let cur = opts.fallback?.fc && opts.fallback?.tc ? { fc: opts.fallback.fc.toUpperCase(), tc: opts.fallback.tc.toUpperCase() } : null;
  let skip = false;
  let read = 0;
  let skipped = 0;
  const RANK = { p: 3, l: 2, s: 1 };
  for (const raw of museNorm(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^```/.test(line)) continue;
    const hh = line.match(MUSE_HEAD);
    if (hh && hh[3].toUpperCase() !== hh[4].toUpperCase()) {
      air = museAirOf(hh[1], opts.airlines) || air;
      skip = hh[2] === '升等結果' || /升等/.test(hh[1]);
      cur = { fc: hh[3].toUpperCase(), tc: hh[4].toUpperCase() };
      continue;
    }
    const h = line.match(MUSE_BARE);
    if (h && h[1] !== h[2]) { cur = { fc: h[1], tc: h[2] }; skip = false; continue; }
    const dm = line.match(MUSE_DATE);
    if (!dm || skip) continue;
    const iso = museIso(+dm[1], +dm[2], +dm[3]);
    // Other dates on the line (prose such as 「2027-08-01 到 2027-08-03」) are not prices.
    let rest = line.slice(dm[0].length).toUpperCase().replace(/\d{4}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}\s*日?/g, ' ');
    const flights = (rest.match(MUSE_FLIGHTS) || []).map((x) => x.split(/\s*[/+›>→]\s*/).map((n) => n.replace(/\s+/g, '')));
    rest = rest.replace(MUSE_FLIGHTS, ' ');
    const c = museCabin(rest) || (MUSE_CN[opts.cabin] ? opts.cabin : '');
    let s = museStatus(rest.replace(/豪華經濟|豪华经济|經濟|经济|商務|商务|頭等|头等/g, ' '));
    const wan = rest.match(/(\d+(?:\.\d+)?)\s*萬/);
    const num = rest.match(/(\d{1,3}(?:,\d{3})+|\d{4,7})/);
    const miles = wan ? Math.round(Number(wan[1]) * 10000) : num ? Number(num[1].replace(/,/g, '')) : 0;
    if (s == null && miles) s = { ok: true, st: '' };
    if (!iso || !c || s == null || !cur) { skipped++; continue; }
    read++;
    const key = `${air}:${cur.fc}>${cur.tc}`;
    if (!routes.has(key)) routes.set(key, { air, fc: cur.fc, tc: cur.tc, days: {} });
    const r = routes.get(key);
    const day = (r.days[iso] ||= { c: {} });
    const was = day.c[c];
    if (!s.ok) {
      // 候補 beats 無位; neither replaces seats.
      if (!was || (was.na && s.st === 'w')) day.c[c] = s.st === 'w' ? { m: 0, na: 1, st: 'w' } : { m: 0, na: 1 };
      continue;
    }
    const p = `${cur.fc}-${cur.tc}`;
    const f = flights.slice(0, 5).map((ns) => ({ n: ns.join('›'), d: '', a: '', p, s: ns.length - 1, m: miles }));
    if (!was || was.na) { day.c[c] = { m: miles, f, ...(s.st ? { st: s.st } : {}) }; continue; }
    // The same day and cabin twice: the lower price (and its level) wins, and the flights are kept together.
    if (miles && (!was.m || miles < was.m)) {
      was.m = miles;
      if (s.st) was.st = s.st; else delete was.st;
    } else if (!miles && !was.m && s.st && (RANK[s.st] || 0) > (RANK[was.st] || 0)) was.st = s.st;
    for (const x of f) if (!was.f.some((y) => y.n === x.n)) was.f.push(x);
  }
  for (const r of routes.values()) {
    const ks = Object.keys(r.days).sort();
    r.days = Object.fromEntries(ks.map((k) => [k, r.days[k]]));
    r.cabins = ['Y', 'W', 'J', 'F'].filter((c) => ks.some((k) => r.days[k].c[c]));
    r.range = { from: ks[0], to: ks[ks.length - 1] };
  }
  return { routes: [...routes.values()], read, skipped };
}

// A day's word per cabin, and the day's best: p (充足), l (有限／稀少), o (有位), w (候補), n (無位) or ''.
const museWord = (x) => (x.na ? (x.st === 'w' ? '候補' : '無位') : MUSE_ST_CN[x.st] || '有位');
function museDayLevel(day) {
  const xs = Object.values(day?.c || {});
  if (!xs.length) return day?.na ? 'n' : '';
  if (xs.some((x) => !x.na && x.st === 'p')) return 'p';
  if (xs.some((x) => !x.na && (x.st === 'l' || x.st === 's'))) return 'l';
  if (xs.some((x) => !x.na)) return 'o';
  return xs.some((x) => x.st === 'w') ? 'w' : 'n';
}
const museHasLevels = (r) => Object.values(r.days || {}).some((d) => Object.values(d.c || {}).some((x) => x.st));

// After CXCAL.cxView has drawn r into box (st: its { ym, sel }): status colours on the days, 候補 instead of 無位,
// and the chosen day's words per cabin in place of cxView's Cathay-page wording. Shared with cxlive.js's cards.
function museTint(box, r, st) {
  if (!box || !r || !st?.ym) return;
  box.querySelectorAll('.cx-g .cx-d').forEach((b, i) => {
    const day = r.days[`${st.ym}-${String(i + 1).padStart(2, '0')}`];
    const lv = museDayLevel(day);
    if (lv && lv !== 'o') b.classList.add(`cxm-${lv}`);
    if (lv === 'w') { const na = b.querySelector('.cx-na'); if (na) na.textContent = '候補'; }
  });
  const det = box.querySelector('.cx-det');
  if (!det || !st.sel) return;
  det.querySelectorAll('.cx-mut').forEach((x) => x.remove());
  const day = r.days[st.sel];
  const p = document.createElement('p');
  p.className = 'cx-mut';
  p.textContent = day?.c ? `AI 助理回報：${'YWJF'.split('').filter((c) => day.c[c]).map((c) => `${MUSE_CN[c]}艙${museWord(day.c[c])}${!day.c[c].na && !day.c[c].m ? '（沒寫哩數）' : ''}`).join('、')}` : '這天 AI 助理沒有回報。';
  det.querySelector('.cx-dh')?.after(p);
}
// The colour key under a calendar, for the levels the route has (有位 and 充足 share a colour).
function museLegendHtml(r) {
  const has = new Set(Object.values(r?.days || {}).map(museDayLevel));
  const keys = [['p', '充足'], ['o', '有位'], ['l', '有限／稀少'], ['w', '候補'], ['n', '無位']].filter(([k]) => has.has(k) && !(k === 'o' && has.has('p')));
  return `<p class="cxm-legend">${keys.map(([k, t]) => `<span class="cxm-k cxm-${k === 'o' ? 'p' : k}"></span>${t}`).join(' ')}</p>`;
}

// ---------- page ----------
let musePromise = null;
// The airline templates, loaded once (cxlive.js uses the names too); [] when they cannot be loaded.
function museTemplates() {
  musePromise ||= api('/api/data/musetemplates').then((b) => b.airlines || [], (e) => { musePromise = null; throw e; });
  return musePromise;
}

if (typeof document !== 'undefined' && document.getElementById('search-results') && typeof CXCAL === 'object') {
  const st = { paste: false, text: '', parsed: null, view: new Map(), prompt: '', mode: 'web', air: store.get('museAir', 'cx'), f: {}, extras: new Set(), tpls: null, loading: false };
  const codes = (s) => [...new Set(String(s || '').toUpperCase().split(/[,\s]+/).filter((c) => /^[A-Z]{3}$/.test(c)))];
  const nameOf = (c) => (typeof airportCity === 'function' ? airportCity(c) : '') || c;
  const ends = () => { const [o, d] = String(state.route || '').split('→'); return { os: codes(o), ds: codes(d) }; };
  const tplOf = (id) => st.tpls?.find((a) => a.id === id) || st.tpls?.[0] || null;
  const airName = (id) => st.tpls?.find((a) => a.id === id)?.name || String(id || '').toUpperCase();

  const ensureCss = () => {
    if (document.getElementById('cx-css')) return;
    const s = document.createElement('style');
    s.id = 'cx-css';
    s.textContent = CXCAL.cxCss();
    document.head.append(s);
  };
  const loadTpls = () => {
    if (st.tpls || st.loading) return;
    st.loading = true;
    museTemplates().then((t) => { st.tpls = t; if (!t.some((a) => a.id === st.air)) st.air = t[0]?.id || 'cx'; }, () => { st.tpls = null; })
      .finally(() => { st.loading = false; redrawBody(); });
  };

  // The tool's own fields, filled from the current search until the owner changes them.
  const field = (k) => {
    if (st.f[k] != null) return st.f[k];
    const { os, ds } = ends();
    return { from: os.join(','), to: ds.join(','), start: state.start || '', end: state.end || '', cabin: state.cabin || 'J', pax: state.pax || 1 }[k];
  };
  // The pairs to ask about: for 國泰 the pairs cxauto shows (Cathay seats already seen) first; then the pairs that
  // touch the airline's hubs; then the rest.
  function pairsFor(t) {
    const os = codes(field('from'));
    const ds = codes(field('to'));
    const keys = t.id === 'cx' ? (window.cxAutoPart?.keys() || []).filter((k) => os.includes(k.slice(0, 3)) && ds.includes(k.slice(4))) : [];
    const all = os.flatMap((o) => ds.map((d) => `${o}>${d}`)).filter((k) => k.slice(0, 3) !== k.slice(4));
    const hub = all.filter((k) => (t.hubs || []).some((h) => k.includes(h)));
    const list = [...new Set([...keys, ...hub, ...all])];
    const out = list.slice(0, MUSE_MAX_PAIRS).map((k) => ({ fc: k.slice(0, 3), tc: k.slice(4), from: nameOf(k.slice(0, 3)), to: nameOf(k.slice(4)) }));
    out.dropped = list.slice(MUSE_MAX_PAIRS).map((k) => k.replace('>', '→')); // past the cap: said in the note
    return out;
  }
  // → { text, note } for the instruction on show, or { text: '', note } saying what is missing.
  function promptNow() {
    const t = tplOf(st.air);
    if (!t) return { text: '', note: '' };
    const pairs = pairsFor(t);
    const start = field('start');
    if (!pairs.length) return { text: '', note: '請填出發和抵達的機場代碼（例如 TPE、HKG）。' };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return { text: '', note: '請填出發日期。' };
    if (st.mode === 'phone' && t.phone) return { text: musePhonePrompt({ tpl: t, pair: pairs[0], start, cabin: field('cabin'), pax: field('pax') }), note: '貼到 AI 助理之前，先把「（你的姓名）」「（你的會員號碼）」換成你自己的；本站不會問、也不會存你的會員號碼。' };
    const p = museBuildPrompt({ tpl: t, pairs, start, end: field('end'), cabin: field('cabin'), pax: field('pax'), extras: [...st.extras] });
    const notes = [
      p.capped ? `${t.name}一次最多查 ${t.monthsPerRun} 個月，這次查到 ${p.end}；之後再複製一次查下一段。` : '',
      pairs.dropped.length ? `一次最多 ${MUSE_MAX_PAIRS} 組航線，這次沒查：${pairs.dropped.join('、')}（改上面的出發／抵達機場再複製一次）。` : '',
    ];
    return { text: p.text, note: notes.filter(Boolean).join('') };
  }

  // Per cabin of a parsed route: days reported, days with seats (and how many 充足), 候補 days, lowest miles.
  function sumHtml(r) {
    const ks = Object.keys(r.days);
    return r.cabins.map((c) => {
      const cells = ks.map((k) => r.days[k].c[c]).filter(Boolean);
      const open = cells.filter((x) => !x.na);
      const ms = open.map((x) => x.m).filter(Boolean);
      const plenty = open.filter((x) => x.st === 'p').length;
      const wait = cells.filter((x) => x.st === 'w').length;
      return `<span class="cx-auto-c">${MUSE_CN[c]} <b>${open.length}</b>/${cells.length} 天有位${plenty ? `（充足 ${plenty} 天）` : ''}${wait ? `・候補 ${wait} 天` : ''}${ms.length ? `・最低 <b>${fmt(Math.min(...ms))}</b> 哩` : ''}</span>`;
    }).join('；');
  }
  const rkey = (r) => `${r.air}:${r.fc}>${r.tc}`;

  function outHtml() {
    const p = st.parsed;
    if (!p) return '';
    const n = airName(st.air);
    if (!p.routes.length) return `<p class="hint">還沒讀到結果：要有「${esc(n)}查票結果 TPE-NRT」這樣的標題行，和「2027-08-01 | 商務 | 有位 | 88000 | ${esc(tplOf(st.air)?.flight || 'CX')}450」這樣的日期行。${p.skipped ? `（有 ${p.skipped} 行看不懂，已略過）` : ''}</p>`;
    const names = [...new Set(p.routes.map((r) => airName(r.air)))];
    return `${p.routes.map((r) => `<section class="cx-live-card cxm-card" data-cxm="${esc(rkey(r))}">
      <div class="cx-live-head"><span class="cx-tag">${esc(airName(r.air))}・AI 助理回報</span><b>${esc(nameOf(r.fc))} → ${esc(nameOf(r.tc))}</b><small>${esc(r.fc)}→${esc(r.tc)}</small></div>
      <p class="cx-live-sum">${sumHtml(r)}</p>
      <div class="cxp cx-live-cal"></div>${museHasLevels(r) ? museLegendHtml(r) : ''}
    </section>`).join('')}
    <div class="cxm-save"><button type="button" class="outline" data-cxm-save>儲存到網站${p.routes.length > 1 ? `（${p.routes.length} 條航線）` : ''}</button>
      <span class="hint">讀到 ${p.read} 筆${p.skipped ? `，${p.skipped} 行看不懂已略過` : ''}。儲存後，之後查這條航線會出現「${esc(names.join('／'))}官網實查」卡片（要通關密碼）。哩數是 AI 助理回報的每人單程價格，開票前請到官網確認。</span></div>`;
  }

  function drawCals(root) {
    if (!st.parsed) return;
    ensureCss();
    for (const sec of root.querySelectorAll('.cxm-card')) {
      const r = st.parsed.routes.find((x) => rkey(x) === sec.dataset.cxm);
      const box = sec.querySelector('.cx-live-cal');
      if (!r || !box) continue;
      if (!st.view.has(sec.dataset.cxm)) {
        const ks = Object.keys(r.days);
        st.view.set(sec.dataset.cxm, { ym: '', sel: ks.find((k) => Object.values(r.days[k].c).some((x) => !x.na)) || ks[0] || '' });
      }
      const vs = st.view.get(sec.dataset.cxm);
      CXCAL.cxView(box, r, vs);
      museTint(box, r, vs);
    }
  }

  function bodyHtml() {
    if (!st.tpls) return `<p class="hint">${st.loading ? '載入航空公司模板中…' : '航空公司模板載入失敗，請稍後再試。'}</p>`;
    const t = tplOf(st.air);
    const { text, note } = promptNow();
    st.prompt = text;
    const cab = (t.cabins || ['Y', 'W', 'J', 'F']).map((c) => `<option value="${c}"${museCabinOf(t, field('cabin')) === c ? ' selected' : ''}>${MUSE_CN[c]}</option>`).join('');
    return `<div class="cxm-air" role="radiogroup" aria-label="要查哪一家">${st.tpls.map((a) => `<button type="button" role="radio" class="cxm-chip" aria-checked="${a.id === t.id}" data-cxm-air="${esc(a.id)}">${esc(a.label || a.name)}</button>`).join('')}</div>
      <ul class="cxm-tips"><li>${t.login ? `要登入：AI 助理會用它自己的安全表單向你要${esc(t.program)}帳號密碼，本站看不到。` : '不用登入。'}</li>${(t.tips || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      <div class="cxm-form">
        <label>出發<input data-cxm-f="from" value="${esc(field('from'))}" autocomplete="off" spellcheck="false"></label>
        <label>抵達<input data-cxm-f="to" value="${esc(field('to'))}" autocomplete="off" spellcheck="false"></label>
        <label>從<input type="date" data-cxm-f="start" value="${esc(field('start'))}"></label>
        <label>到<input type="date" data-cxm-f="end" value="${esc(field('end'))}"></label>
        <label>艙等<select data-cxm-f="cabin">${cab}</select></label>
        <label>人數<input type="number" min="1" max="9" data-cxm-f="pax" value="${esc(field('pax'))}"></label>
        ${(t.extras || []).map((x) => `<label class="cxm-x"><input type="checkbox" data-cxm-x="${esc(x.id)}"${st.extras.has(x.id) ? ' checked' : ''}>${esc(x.label)}</label>`).join('')}
      </div>
      <div class="cxm-acts"><button type="button" class="outline" data-cxm-copy="web"${text ? '' : ' disabled'}>複製查${esc(t.name)}官網的指示</button>${t.phone ? `<button type="button" class="linklike" data-cxm-copy="phone"${text ? '' : ' disabled'}>選用：請 AI 助理打電話問${esc(t.name)}客服</button>` : ''}<span class="ai-ok" role="status"></span></div>${window.cxShotPart?.html(t) || ''}
      <p class="hint cxm-cap"${note ? '' : ' hidden'}>${esc(note)}</p>
      <pre class="ai-text"${text ? '' : ' hidden'}>${esc(text)}</pre>`;
  }
  function redrawBody() {
    const el = document.querySelector('#cx-muse .cxm-body');
    if (el) el.innerHTML = bodyHtml();
  }
  // Typing in a field: only the instruction changes (a full redraw would lose the caret).
  function refreshPrompt() {
    const el = document.querySelector('#cx-muse .cxm-body');
    if (!el || !st.tpls) return;
    const { text, note } = promptNow();
    st.prompt = text;
    el.querySelector('.ai-text').textContent = text;
    el.querySelector('.ai-text').hidden = !text;
    el.querySelector('.cxm-cap').textContent = note;
    el.querySelector('.cxm-cap').hidden = !note;
    el.querySelectorAll('[data-cxm-copy]').forEach((b) => { b.disabled = !text; });
  }

  // The 「🤖 請 AI 助理查官網」 panel of the 國泰／亞洲萬里通 card (cxcard.js, which shows it to the owner only).
  function panelHtml() {
    const { os, ds } = ends();
    if (!os.length || !ds.length) return '';
    loadTpls(); // 載入中… until they come (then redrawBody)
    return `<div id="cx-muse" class="cxm open">
      <p class="hint cxm-note">國泰、華航、長榮、星宇、日航、ANA：只會複製一段指示，貼到 Muse、ChatGPT 或 Gemini；密碼只交給你的 AI 助理，本站看不到，也不花查詢額度。</p>
      <div class="cxm-body">${bodyHtml()}</div>
      <details class="cxm-paste" ${st.paste ? 'open' : ''}><summary>貼上 AI 助理的結果</summary>
        <textarea class="cxm-in" rows="5" spellcheck="false" placeholder="把 AI 助理回覆的整段文字貼在這裡，例如：&#10;華航查票結果 TPE-NRT&#10;2027-08-01 | 商務 | 充足 | 50000 | CI100&#10;2027-08-02 | 商務 | 候補">${esc(st.text)}</textarea>
        <div class="cxm-out">${outHtml()}</div>
      </details>
    </div>`;
  }
  window.cxMusePart = {
    available: () => Boolean(ends().os.length && ends().ds.length),
    html: panelHtml,
    after: (el) => { if (st.parsed && el) drawCals(el); },
    // For cxshot.js (貼上截圖): the airline and fields on show, and lines read from a screenshot, added after what is
    // already pasted (華航 shows a week per page, so several screenshots make one calendar) and read at once.
    fields: () => ({ air: st.air, from: field('from'), to: field('to'), start: field('start'), end: field('end'), cabin: field('cabin') }),
    addText(lines) {
      const box = document.querySelector('#cx-muse .cxm-paste');
      const ta = box?.querySelector('.cxm-in');
      if (!ta) return;
      st.paste = box.open = true;
      ta.value = ta.value.trim() ? `${ta.value.trimEnd()}\n${lines}` : lines;
      parseNow(ta);
    },
  };

  document.addEventListener('search:start', () => { Object.assign(st, { paste: false, text: '', parsed: null, prompt: '', mode: 'web', f: {} }); st.view.clear(); });

  const results = document.getElementById('search-results');
  const parseNow = async (ta) => {
    st.text = ta.value;
    if (st.text.trim() && !st.tpls) st.tpls = await museTemplates().catch(() => null);
    const { os, ds } = ends();
    st.parsed = st.text.trim() ? museParse(st.text, { airlines: st.tpls || [], air: st.air, fallback: os.length === 1 && ds.length === 1 ? { fc: os[0], tc: ds[0] } : null }) : null;
    st.view.clear();
    const out = ta.parentElement.querySelector('.cxm-out');
    out.innerHTML = outHtml();
    drawCals(out);
  };
  let timer = 0;
  results.addEventListener('input', (e) => {
    if (e.target.matches?.('.cxm-in')) {
      clearTimeout(timer);
      timer = setTimeout(() => parseNow(e.target), 250);
      return;
    }
    const f = e.target.dataset?.cxmF;
    if (f) { st.f[f] = f === 'from' || f === 'to' ? e.target.value.toUpperCase() : e.target.value; refreshPrompt(); return; }
    const x = e.target.dataset?.cxmX;
    if (x) { if (e.target.checked) st.extras.add(x); else st.extras.delete(x); refreshPrompt(); }
  });
  results.addEventListener('toggle', (e) => { if (e.target.matches?.('.cxm-paste')) st.paste = e.target.open; }, true);
  results.addEventListener('click', async (e) => {
    const pick = e.target.closest('[data-cxm-air]');
    if (pick) {
      st.air = pick.dataset.cxmAir;
      st.mode = 'web';
      store.set('museAir', st.air);
      redrawBody();
      return;
    }
    const copy = e.target.closest('[data-cxm-copy]');
    if (copy) {
      st.mode = copy.dataset.cxmCopy;
      redrawBody();
      const ok = document.querySelector('#cx-muse .cxm-acts .ai-ok');
      if (st.prompt && ok) ok.textContent = (await aiCopy(st.prompt)) ? '✓ 已複製，貼到你的 AI 助理就可以' : '請長按下面的文字自己複製';
      return;
    }
    const save = e.target.closest('[data-cxm-save]');
    if (save && st.parsed?.routes.length) {
      const done = busy(save, '儲存中…');
      const ok = [];
      const bad = [];
      for (const r of st.parsed.routes) {
        const tag = `${airName(r.air)} ${r.fc}→${r.tc}`;
        try {
          const body = { v: 1, air: r.air, from: nameOf(r.fc), to: nameOf(r.tc), fc: r.fc, tc: r.tc, at: Date.now(), days: r.days, source: 'ai', cabins: r.cabins, range: r.range, pax: Number(field('pax')) || 1 };
          const x = await cashApi('/api/cxcal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
          ok.push(`${tag}（${x.days} 天）`);
        } catch (err) { bad.push(`${tag}：${err.message}`); }
      }
      if (ok.length) document.dispatchEvent(new CustomEvent('cxcal:saved'));
      toast([ok.length ? `已儲存 ${ok.join('、')}` : '', bad.join('；')].filter(Boolean).join('；'));
      done();
      return;
    }
    // A day or a month arrow: cxView has already redrawn the calendar (the clicked button is detached).
    const path = e.composedPath();
    const sec = path.find((el) => el.classList?.contains('cxm-card'));
    if (sec && st.parsed && path.some((el) => el.classList?.contains('cx-live-cal'))) {
      const r = st.parsed.routes.find((x) => rkey(x) === sec.dataset.cxm);
      if (r) museTint(sec.querySelector('.cx-live-cal'), r, st.view.get(sec.dataset.cxm));
    }
  });
}

if (typeof module === 'object' && module.exports) module.exports = { museBuildPrompt, musePhonePrompt, museParse, museAirOf, museDayLevel, museMonthsEnd, MUSE_MAX_PAIRS };
