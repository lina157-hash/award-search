// 「🤖 請 AI 助理查國泰官網」: the owner's own AI assistant (Muse, ChatGPT or Gemini agents) logs into cathaypacific.com
// with the owner's account and reads Asia Miles award space day by day, which seats.aero partner data does not show.
// This site never sees the Cathay password and calls no AI: it only writes the instruction (copied to the clipboard)
// and reads back the assistant's text answer (「貼上 AI 助理的結果」), drawn with cxcal.js's calendar (CXCAL.cxView)
// and saved, on request and with the passcode, to /api/cxcal as source 'ai' (the 國泰官網實查 card of cxlive.js).
// No quota is spent. Loaded after cxauto.js; uses aihelper.js's aiCopy and app.js's globals.

// ---------- pure logic (test/cxmuse.test.js) ----------
const MUSE_URL = 'https://www.cathaypacific.com/cx/zh_TW/book-a-trip/redeem-flights/redeem-flight-awards.html';
const MUSE_MAX_DAYS = 31;
const MUSE_MAX_PAIRS = 3;
const MUSE_HUBS = ['TPE', 'KHH', 'HKG'];
const MUSE_CN = { Y: '經濟', W: '豪華經濟', J: '商務', F: '頭等' };
const MUSE_EX = { Y: 20000, W: 30000, J: 58000, F: 90000 }; // only for the format sample in the prompt

const museIso = (y, m, d) => {
  const s = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const t = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === s ? s : '';
};
const museAdd = (iso, n) => { const t = new Date(`${iso}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const museDays = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5) + 1;
const museZh = (iso, year = true) => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${year ? `${y} 年 ` : ''}${m} 月 ${d} 日（${'日一二三四五六'[new Date(`${iso}T00:00:00Z`).getUTCDay()]}）`;
};

// The instruction for the assistant. o: { pairs: [{ fc, tc, from, to }], start, end, cabin, pax }.
// → { text, start, end, capped } (end is cut to one month from start; `capped` says it was).
function museBuildPrompt(o) {
  const pairs = (o.pairs || []).slice(0, MUSE_MAX_PAIRS);
  const cabin = MUSE_CN[o.cabin] ? o.cabin : 'J';
  const cn = MUSE_CN[cabin];
  const pax = Math.max(1, Number(o.pax) || 1);
  const start = o.start;
  const askEnd = o.end && o.end >= start ? o.end : start;
  const capped = museDays(start, askEnd) > MUSE_MAX_DAYS;
  const end = capped ? museAdd(start, MUSE_MAX_DAYS - 1) : askEnd;
  const place = (name, code) => `${name && name !== code ? `${name} ` : ''}${code}`;
  const L = ['請用我自己的國泰航空帳號（亞洲萬里通會員）登入國泰官網，幫我查獎勵機票的座位，只查不訂：', MUSE_URL, ''];
  if (pairs.length === 1) L.push(`・航線（單程）：${place(pairs[0].from, pairs[0].fc)} → ${place(pairs[0].to, pairs[0].tc)}`);
  else {
    L.push(`・航線（單程，共 ${pairs.length} 組，每組分開查）：`);
    pairs.forEach((p, i) => L.push(`　${i + 1}. ${place(p.from, p.fc)} → ${place(p.to, p.tc)}`));
  }
  L.push(`・日期：${museZh(start)} 到 ${museZh(end, end.slice(0, 4) !== start.slice(0, 4))}，共 ${museDays(start, end)} 天`);
  if (capped) L.push(`　（我在網站上查的是 ${museZh(start)} 到 ${museZh(askEnd, askEnd.slice(0, 4) !== start.slice(0, 4))}；一次最多查一個月，所以這次只查前 ${MUSE_MAX_DAYS} 天）`);
  L.push(`・艙等：${cn}艙`, `・人數：${pax} 位${pax > 1 ? `（請確認 ${pax} 位都訂得到）` : ''}`, '');
  L.push('登入與安全（很重要）：',
    '1. 要登入時，請用你（AI 助理）自己的安全登入表單或密碼保管功能向我要會員號碼和密碼；絕對不要叫我把密碼打在聊天裡，也不要在回覆中寫出密碼。簡訊或電郵驗證碼也一樣。',
    '2. 只查詢：不要訂位、不要付款、不要更改帳號的任何設定。',
    '3. 放慢速度：每小時最多查一個月的日期，不要快速連續重新查詢，以免帳號被國泰鎖住。看到驗證、錯誤或「請稍後再試」的畫面，就先停下來告訴我。');
  if (pairs.length > 1) L.push(`4. 一組航線查完一個月後，等一小時再查下一組。`);
  L.push('', `每一天請記下${cn}艙的：`,
    '・有沒有獎勵座位（有位／無位）',
    '・有位的話，最低要幾哩（每人單程，只寫數字）',
    '・畫面有顯示航班編號的話，最低哩數那班的航班編號（轉機用 / 連起來，例如 CX451/CX500）', '');
  const p0 = pairs[0] || { fc: 'TPE', tc: 'HKG' };
  L.push('全部查完後，請把結果放在「一個」純文字程式碼區塊裡回覆（```text 開頭、``` 結尾），格式完全照下面，一行一天，不要改成表格，方便我貼回網站。下面兩行只是格式範例，不是真的結果：',
    '```text',
    `國泰查票結果 ${p0.fc}-${p0.tc}`,
    `${start} | ${cn} | 有位 | ${MUSE_EX[cabin]} | CX000`,
    `${museAdd(start, 1)} | ${cn} | 無位`,
    '```',
    `欄位依序是：日期 | 艙等 | 有位或無位 | 最低哩數 | 航班編號；無位的只寫前三欄。${pairs.length > 1 ? '每組航線先寫一行「國泰查票結果 出發代碼-抵達代碼」，再接那組的每一天。' : ''}沒查到的日期不要寫。`);
  return { text: L.join('\n'), start, end, capped };
}

// Full-width letters, digits and punctuation → ASCII; box-drawing bars → |.
const museNorm = (s) => String(s).replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  .replace(/[\u3000\u00A0]/g, ' ').replace(/[│┃︱¦∣]/g, '|');
const MUSE_SEP = '\\s*(?:-|–|—|→|->|>|~|至|到|/)\\s*';
const MUSE_HEAD = new RegExp(`國泰查票結果\\s*[:：]?\\s*([A-Za-z]{3})${MUSE_SEP}([A-Za-z]{3})(?![A-Za-z])`);
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
// true = seats, false = none, null = not said. "沒有位" holds "有位", so the 「無」 words go first.
function museStatus(s) {
  if (/無位|无位|沒位|没位|沒有|没有|無|无|不適用|不适用|候補|候补|額滿|额满|售完|已滿|✗|✘|❌|\bno\b|\bnone\b|unavailable|sold\s*out|\bN\/A\b/i.test(s)) return false;
  if (/有位|有|可訂|可订|✓|✔|✅|\byes\b|available/i.test(s)) return true;
  return null;
}

// The assistant's answer → { routes: [{ fc, tc, days, cabins, range }], read, skipped }. Days have the 國泰官網實查
// record shape (lib/cxcal-store.js): { c: { J: { m, f: [{ n, d, a, p, s, m }] } } } for 有位 (m = 0 when no miles
// were given) and { c: { J: { m: 0, na: 1 } } } for 無位. Lines without a leading date are prose and are ignored;
// date lines without a cabin or a 有位／無位 count as `skipped`. Lines before any header go to opts.fallback
// ({ fc, tc }), and a line without a cabin takes opts.cabin when given.
function museParse(text, opts = {}) {
  const routes = new Map();
  let cur = opts.fallback?.fc && opts.fallback?.tc ? { fc: opts.fallback.fc.toUpperCase(), tc: opts.fallback.tc.toUpperCase() } : null;
  let read = 0;
  let skipped = 0;
  for (const raw of museNorm(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^```/.test(line)) continue;
    const h = line.match(MUSE_HEAD) || line.match(MUSE_BARE);
    if (h && h[1].toUpperCase() !== h[2].toUpperCase()) { cur = { fc: h[1].toUpperCase(), tc: h[2].toUpperCase() }; continue; }
    const dm = line.match(MUSE_DATE);
    if (!dm) continue;
    const iso = museIso(+dm[1], +dm[2], +dm[3]);
    // Other dates on the line (prose such as 「2027-08-01 到 2027-08-03」) are not prices.
    let rest = line.slice(dm[0].length).toUpperCase().replace(/\d{4}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}\s*日?/g, ' ');
    const flights = (rest.match(MUSE_FLIGHTS) || []).map((x) => x.split(/\s*[/+›>→]\s*/).map((n) => n.replace(/\s+/g, '')));
    rest = rest.replace(MUSE_FLIGHTS, ' ');
    const c = museCabin(rest) || (MUSE_CN[opts.cabin] ? opts.cabin : '');
    let ok = museStatus(rest.replace(/豪華經濟|豪华经济|經濟|经济|商務|商务|頭等|头等/g, ' '));
    const wan = rest.match(/(\d+(?:\.\d+)?)\s*萬/);
    const num = rest.match(/(\d{1,3}(?:,\d{3})+|\d{4,7})/);
    const miles = wan ? Math.round(Number(wan[1]) * 10000) : num ? Number(num[1].replace(/,/g, '')) : 0;
    if (ok == null && miles) ok = true;
    if (!iso || !c || ok == null || !cur) { skipped++; continue; }
    read++;
    const key = `${cur.fc}>${cur.tc}`;
    if (!routes.has(key)) routes.set(key, { fc: cur.fc, tc: cur.tc, days: {} });
    const r = routes.get(key);
    const day = (r.days[iso] ||= { c: {} });
    const was = day.c[c];
    if (!ok) { if (!was) day.c[c] = { m: 0, na: 1 }; continue; }
    const p = `${cur.fc}-${cur.tc}`;
    const f = flights.slice(0, 5).map((ns) => ({ n: ns.join('›'), d: '', a: '', p, s: ns.length - 1, m: miles }));
    if (!was || was.na) { day.c[c] = { m: miles, f }; continue; }
    // The same day and cabin twice: the lower price wins, and the flights are kept together.
    if (miles && (!was.m || miles < was.m)) was.m = miles;
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

// ---------- page ----------
if (typeof document !== 'undefined' && document.getElementById('search-results') && typeof CXCAL === 'object') {
  const st = { open: false, paste: false, text: '', parsed: null, view: new Map(), prompt: '' };
  const codes = (s) => [...new Set(String(s || '').toUpperCase().split(/[,\s]+/).filter((c) => /^[A-Z]{3}$/.test(c)))];
  const nameOf = (c) => (typeof airportCity === 'function' ? airportCity(c) : '') || c;
  const ends = () => { const [o, d] = String(state.route || '').split('→'); return { os: codes(o), ds: codes(d) }; };

  const ensureCss = () => {
    if (document.getElementById('cx-css')) return;
    const s = document.createElement('style');
    s.id = 'cx-css';
    s.textContent = CXCAL.cxCss();
    document.head.append(s);
  };

  // The pairs to ask about: the cxauto cards' pairs (Cathay seats already seen) first, then the searched pairs
  // that touch TPE/KHH/HKG, then the rest.
  function pairsFor(autoHtml) {
    const { os, ds } = ends();
    const keys = [...String(autoHtml || '').matchAll(/data-cxa="([A-Z]{3})&gt;([A-Z]{3})"/g)].map((m) => `${m[1]}>${m[2]}`);
    const all = os.flatMap((o) => ds.map((d) => `${o}>${d}`)).filter((k) => k.slice(0, 3) !== k.slice(4));
    const hub = all.filter((k) => MUSE_HUBS.some((h) => k.includes(h)));
    return [...new Set([...keys, ...hub, ...all])].slice(0, MUSE_MAX_PAIRS).map((k) => ({ fc: k.slice(0, 3), tc: k.slice(4), from: nameOf(k.slice(0, 3)), to: nameOf(k.slice(4)) }));
  }
  const promptNow = (autoHtml) => {
    const pairs = pairsFor(autoHtml);
    return pairs.length && state.start ? museBuildPrompt({ pairs, start: state.start, end: state.end, cabin: state.cabin, pax: state.pax }).text : '';
  };

  // Per cabin of a parsed route: days reported, days with seats, lowest miles.
  function sumHtml(r) {
    const ks = Object.keys(r.days);
    return r.cabins.map((c) => {
      const cells = ks.map((k) => r.days[k].c[c]).filter(Boolean);
      const open = cells.filter((x) => !x.na);
      const ms = open.map((x) => x.m).filter(Boolean);
      return `<span class="cx-auto-c">${MUSE_CN[c]} <b>${open.length}</b>/${cells.length} 天有位${ms.length ? `・最低 <b>${fmt(Math.min(...ms))}</b> 哩` : ''}</span>`;
    }).join('；');
  }

  function outHtml() {
    const p = st.parsed;
    if (!p) return '';
    if (!p.routes.length) return `<p class="hint">還沒讀到結果：要有「國泰查票結果 TPE-NRT」這樣的標題行，和「2027-08-01 | 商務 | 有位 | 88000 | CX450」這樣的日期行。${p.skipped ? `（有 ${p.skipped} 行看不懂，已略過）` : ''}</p>`;
    return `${p.routes.map((r) => `<section class="cx-live-card cxm-card" data-cxm="${esc(`${r.fc}>${r.tc}`)}">
      <div class="cx-live-head"><span class="cx-tag">AI 助理回報</span><b>${esc(nameOf(r.fc))} → ${esc(nameOf(r.tc))}</b><small>${esc(r.fc)}→${esc(r.tc)}</small></div>
      <p class="cx-live-sum">${sumHtml(r)}</p>
      <div class="cxp cx-live-cal"></div>
    </section>`).join('')}
    <div class="cxm-save"><button type="button" class="outline" data-cxm-save>儲存到網站${p.routes.length > 1 ? `（${p.routes.length} 條航線）` : ''}</button>
      <span class="hint">讀到 ${p.read} 筆${p.skipped ? `，${p.skipped} 行看不懂已略過` : ''}。儲存後，之後查這條航線會出現「國泰官網實查」卡片（要通關密碼）。哩數是 AI 助理回報的每人單程價格，開票前請到國泰官網確認。</span></div>`;
  }

  // cxView's own words are for Cathay's page; on our days the detail says what the assistant reported.
  function touchUp(box, r, vs) {
    const det = box.querySelector('.cx-det');
    if (!det || !vs.sel) return;
    const day = r.days[vs.sel];
    const mut = det.querySelector('.cx-mut');
    if (!day) { if (mut) mut.textContent = '這天 AI 助理沒有回報。'; return; }
    const open = Object.keys(day.c).filter((c) => !day.c[c].na && !day.c[c].m);
    if (mut && open.length) mut.textContent = `AI 助理回報${open.map((c) => `${MUSE_CN[c]}艙`).join('、')}有位，沒有寫哩數。`;
    else if (mut) mut.textContent = '';
  }
  function drawCals(root) {
    if (!st.parsed) return;
    ensureCss();
    for (const sec of root.querySelectorAll('.cxm-card')) {
      const r = st.parsed.routes.find((x) => `${x.fc}>${x.tc}` === sec.dataset.cxm);
      const box = sec.querySelector('.cx-live-cal');
      if (!r || !box) continue;
      if (!st.view.has(sec.dataset.cxm)) {
        const ks = Object.keys(r.days);
        st.view.set(sec.dataset.cxm, { ym: '', sel: ks.find((k) => Object.values(r.days[k].c).some((x) => !x.na)) || ks[0] || '' });
      }
      const vs = st.view.get(sec.dataset.cxm);
      CXCAL.cxView(box, r, vs);
      touchUp(box, r, vs);
    }
  }

  function boxHtml(autoHtml) {
    st.prompt = promptNow(autoHtml);
    if (!st.prompt) return '';
    return `<div id="cx-muse" class="cxm${st.open ? ' open' : ''}">
      <div class="ai-head"><button type="button" class="outline" data-cxm-ask aria-expanded="${st.open}">🤖 請 AI 助理查國泰官網</button><span class="ai-ok" role="status"></span></div>
      <p class="hint cxm-note">只會複製一段指示，貼到 Muse、ChatGPT 或 Gemini；國泰密碼只交給你的 AI 助理，本站看不到，也不花查詢額度。</p>
      <div class="ai-more" ${st.open ? '' : 'hidden'}><pre class="ai-text">${esc(st.prompt)}</pre></div>
      <details class="cxm-paste" ${st.paste ? 'open' : ''}><summary>貼上 AI 助理的結果</summary>
        <textarea class="cxm-in" rows="5" spellcheck="false" placeholder="把 AI 助理回覆的整段文字貼在這裡，例如：&#10;國泰查票結果 TPE-NRT&#10;2027-08-01 | 商務 | 有位 | 88000 | CX450&#10;2027-08-02 | 商務 | 無位">${esc(st.text)}</textarea>
        <div class="cxm-out">${outHtml()}</div>
      </details>
    </div>`;
  }

  // Hook: after cxauto's cards (or where they would be), before the one-line 國泰補查 badge.
  const prev = window.cxBadgeHtml;
  window.cxBadgeHtml = (c) => {
    const s = typeof prev === 'function' ? prev(c) : '';
    const auto = s.match(/<div id="cx-auto">[\s\S]*$/)?.[0] || '';
    const { os, ds } = ends();
    if (!auto && ![...os, ...ds].some((x) => MUSE_HUBS.includes(x))) return s;
    const mine = boxHtml(auto);
    if (mine && st.parsed) queueMicrotask(() => { const el = document.getElementById('cx-muse'); if (el) drawCals(el); });
    const i = s.indexOf('<details class="cx-badge"');
    return i < 0 ? s + mine : s.slice(0, i) + mine + s.slice(i);
  };

  document.addEventListener('search:start', () => { Object.assign(st, { open: false, paste: false, text: '', parsed: null, prompt: '' }); st.view.clear(); });

  const results = document.getElementById('search-results');
  const parseNow = (ta) => {
    st.text = ta.value;
    const { os, ds } = ends();
    st.parsed = st.text.trim() ? museParse(st.text, { fallback: os.length === 1 && ds.length === 1 ? { fc: os[0], tc: ds[0] } : null }) : null;
    st.view.clear();
    const out = ta.parentElement.querySelector('.cxm-out');
    out.innerHTML = outHtml();
    drawCals(out);
  };
  let timer = 0;
  results.addEventListener('input', (e) => {
    if (!e.target.matches?.('.cxm-in')) return;
    clearTimeout(timer);
    timer = setTimeout(() => parseNow(e.target), 250);
  });
  results.addEventListener('toggle', (e) => { if (e.target.matches?.('.cxm-paste')) st.paste = e.target.open; }, true);
  results.addEventListener('click', async (e) => {
    const ask = e.target.closest('[data-cxm-ask]');
    if (ask) {
      const box = ask.closest('#cx-muse');
      const more = box.querySelector('.ai-more');
      const ok = box.querySelector('.ai-ok');
      st.open = more.hidden;
      more.hidden = !st.open;
      box.classList.toggle('open', st.open);
      ask.setAttribute('aria-expanded', String(st.open));
      ok.textContent = '';
      if (st.open) ok.textContent = (await aiCopy(st.prompt)) ? '✓ 已複製，貼到你的 AI 助理就可以' : '請長按下面的文字自己複製';
      return;
    }
    const save = e.target.closest('[data-cxm-save]');
    if (save && st.parsed?.routes.length) {
      const done = busy(save, '儲存中…');
      const ok = [];
      const bad = [];
      for (const r of st.parsed.routes) {
        try {
          const body = { v: 1, from: nameOf(r.fc), to: nameOf(r.tc), fc: r.fc, tc: r.tc, at: Date.now(), days: r.days, source: 'ai', cabins: r.cabins, range: r.range, pax: state.pax || 1 };
          const x = await cashApi('/api/cxcal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
          ok.push(`${x.fc}→${x.tc}（${x.days} 天）`);
        } catch (err) { bad.push(`${r.fc}→${r.tc}：${err.message}`); }
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
      const r = st.parsed.routes.find((x) => `${x.fc}>${x.tc}` === sec.dataset.cxm);
      if (r) touchUp(sec.querySelector('.cx-live-cal'), r, st.view.get(sec.dataset.cxm));
    }
  });
}

if (typeof module === 'object' && module.exports) module.exports = { museBuildPrompt, museParse, MUSE_URL, MUSE_MAX_DAYS };
