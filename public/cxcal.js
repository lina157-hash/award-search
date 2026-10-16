// 國泰哩程日曆 (bookmarklet): on Cathay's own redemption results page, the owner clicks the bookmark once and a small
// panel reads what the page already shows (route, date strip, cabin tiles, flight cards) every time the page changes,
// building a month calendar of the lowest miles per cabin. It never clicks, never sends a request to Cathay and never
// reads a password; data stays in Cathay-origin localStorage until the owner exports it to our site in the URL hash.
//
// The functions from parseCathayText to cxRun are serialized into the bookmark with Function#toString, so each one may
// only use its own parameters, browser globals and the other serialized functions. parseCathayText is pure (node tests).
(function (root) {
  // Visible page text (innerText) + DOM hints ({ day: selected strip day number, cabin: selected cabin tile text }) →
  // { from, to, fc, tc, head, date, cabin, strip: [{ date, na, m }], tiles: [{ c, m, na }], flights, low: { Y: miles }, issues }.
  function parseCathayText(text, hints) {
    hints = hints || {};
    const L = String(text || '').split('\n').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const MO = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const pad = (n) => String(n).padStart(2, '0');
    const iso = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
    const add = (s, n) => new Date(Date.parse(s) + n * 864e5).toISOString().slice(0, 10);
    const wd = (s) => new Date(Date.parse(s)).getUTCDay();
    const ZW = '日一二三四五六';
    const enM = (s) => MO.indexOf(s.slice(0, 3).toLowerCase()) + 1;
    const dateIn = (s) => {
      let m = s.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
      if (m) return iso(+m[1], +m[2], +m[3]);
      m = s.match(/\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(\d{4})/i);
      if (m) return iso(+m[3], enM(m[2]), +m[1]);
      m = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/i);
      return m ? iso(+m[3], enM(m[1]), +m[2]) : '';
    };
    const cabinOf = (s) => {
      const m = String(s || '').trim().match(/^(?:(特選經濟|豪華經濟|高級經濟)|(經濟)|(商務)|(頭等))(?:客艙|艙)?|^(?:(premium economy)|(economy)|(business)|(first))(?:\sclass)?\b/i);
      if (!m) return '';
      return m[1] || m[5] ? 'W' : m[2] || m[6] ? 'Y' : m[3] || m[7] ? 'J' : 'F';
    };
    const isCabinLine = (s) => !!cabinOf(s) && s.length <= 24 && !/\d{1,2}:\d{2}/.test(s);
    const NA = /^(不適用|不提供|沒有座位|已售完|售罄|not available|unavailable|n\/a|sold out)$/i;
    const miles = (s) => {
      if (/\d{1,2}:\d{2}|\d{4}\s*年|HKD|TWD|NTD|USD|EUR|JPY|HK\$|NT\$|稅|附加費|tax|surcharge|fee/i.test(s)) return 0;
      const m = s.replace(/\b[A-Z]{2}\s?\d{1,4}\b/g, ' ').match(/(?:^|[^\d,.])(\d{1,3}(?:,\d{3})+|\d{4,6})(?![\d,])/);
      const v = m ? +m[1].replace(/,/g, '') : 0;
      return v >= 1000 ? v : 0;
    };
    const issues = [];

    // The results section starts at the 「出發」 heading and ends at a 「回程」 heading, if any.
    let start = L.findIndex((s) => /^(出發|去程|departure|depart|departing|outbound|departing flights?|outbound flights?)$/i.test(s));
    const head = L.slice(0, Math.max(start, 0));
    let end = L.length;
    if (start < 0) { start = 0; issues.push('nohead'); }
    for (let i = start + 1; i < L.length; i++) if (/^(回程|return|returning|inbound|returning flights?|inbound flights?)$/i.test(L[i])) { end = i; break; }

    // Departure date in the summary (出發日期 2026年11月3日).
    let hd = '';
    for (let i = 0; i < head.length && !hd; i++) if (/出發日期|departure date|departing on|depart date/i.test(head[i])) hd = dateIn(head[i]) || dateIn(head[i + 1] || '');
    if (!hd) for (let i = 0; i < head.length && !hd; i++) hd = dateIn(head[i]);

    // Route: 「台北 ✈ 東京」 on one line, or the two names on their own lines (the plane is an icon).
    const LBL = /最低|日期|旅客|搜尋|資料|推薦|直航|客艙|星期|不適用|里數|哩|選擇|服務|選項|付款|詳情|lowest|select|payment|review|options|date|passenger|search|details|recommend|non-?stop|direct|class|cabin|miles|economy|business|first/i;
    const nameLike = (s) => !!s && s.length <= 30 && !/[\d:：,，]/.test(s) && !LBL.test(s) && !cabinOf(s);
    const route = (from, to) => {
      for (let i = from; i < to; i++) {
        const s = L[i];
        let m = s.match(/^(.+?)\s*(?:✈|✈️|→|➝|➔|⟶|›|>|–|—|\s-\s|\sto\s|\s至\s)\s*(.+)$/);
        if (m && nameLike(m[1]) && nameLike(m[2])) return [m[1], m[2]];
        m = s.match(/^(\S+)\s(\S+)$/);
        if (m && /[^\x00-\x7f]/.test(s) && nameLike(m[1]) && nameLike(m[2])) return [m[1], m[2]];
        if (nameLike(s) && nameLike(L[i + 1])) return [s, L[i + 1]];
      }
      return null;
    };
    const rt = route(start + 1, Math.min(start + 6, end)) || route(Math.max(0, start - 12), start) || ['', ''];

    // The 7-day strip: 星期六 / 31 / [不適用 | miles], or 「Sat 31」 on one line.
    const W1 = /^(?:星期|週|周|禮拜)([日天一二三四五六])$|^(sun|mon|tue|wed|thu|fri|sat)[a-z]{0,6}\.?$/i;
    const W2 = /^(?:星期|週|周|禮拜)([日天一二三四五六])\s*(\d{1,2})$|^(sun|mon|tue|wed|thu|fri|sat)[a-z]{0,6}\.?,?\s*(\d{1,2})(?:\s[a-z]{3,9})?$/i;
    const wnum = (z, e) => (z ? ZW.indexOf(z === '天' ? '日' : z) : ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(e.toLowerCase()));
    const strip = [];
    let gap = 0;
    let stripEnd = start;
    for (let i = start; i < end && !(strip.length && gap > 2); i++) {
      let m = L[i].match(W2);
      let it = null;
      if (m) it = { w: wnum(m[1], m[3]), d: +(m[2] || m[4]) };
      else if ((m = L[i].match(W1)) && /^\d{1,2}$/.test(L[i + 1] || '')) { it = { w: wnum(m[1], m[2]), d: +L[i + 1] }; i++; }
      if (!it) { if (strip.length) gap++; continue; }
      const nx = L[i + 1] || '';
      if (NA.test(nx)) { it.na = 1; i++; } else if (miles(nx) && !W1.test(nx)) { it.m = miles(nx); i++; }
      strip.push(it);
      gap = 0;
      stripEnd = i;
    }

    // Dates for the strip: anchored on the summary date or on a month label, and only kept when every day number and
    // weekday agrees (so a wrong guess never lands on the calendar).
    const months = [];
    const sec = L.slice(start, stripEnd + 1).join('\n');
    for (const m of sec.matchAll(/(\d{4})\s*年\s*(\d{1,2})\s*月/g)) months.push([+m[1], +m[2]]);
    for (const m of sec.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{4})\b/gi)) months.push([+m[2], enM(m[1])]);
    let base = '';
    if (strip.length) {
      const cands = [];
      if (hd) strip.forEach((it, k) => { if (it.d === +hd.slice(8)) cands.push(add(hd, -k)); });
      for (const [y, mo] of months) { cands.push(iso(y, mo, strip[0].d)); cands.push(iso(y, mo - 1, strip[0].d)); }
      base = cands.find((b) => +b.slice(8) === strip[0].d && strip.every((it, k) => +add(b, k).slice(8) === it.d && wd(add(b, k)) === it.w)) || '';
      if (!base) issues.push('stripdate');
    } else issues.push('nostrip');
    const stripOut = base ? strip.map((it, k) => ({ date: add(base, k), na: it.na || 0, m: it.m || 0 })) : [];

    // Which strip day is selected: the DOM hint, else the summary date when it is on the strip.
    let date = '';
    const hday = hints.day != null ? +hints.day : NaN;
    const hit = stripOut.filter((s) => +s.date.slice(8) === hday);
    if (hit.length === 1) date = hit[0].date;
    else if (hd && (!stripOut.length || stripOut.some((s) => s.date === hd))) date = hd;
    if (!date) issues.push('nodate');

    // Cabin tiles between the strip and the flight list (optionally with miles under each, e.g. after 查看全部資料).
    const FN = /\b([A-Z]{2})\s?(\d{1,4})\b/g;
    let fStart = L.findIndex((s, i) => i > stripEnd && i < end && /\b[A-Z]{2}\s?\d{2,4}\b/.test(s));
    if (fStart < 0) fStart = end;
    const tiles = [];
    for (let i = stripEnd + 1; i < fStart; i++) {
      if (!isCabinLine(L[i])) continue;
      const t = { c: cabinOf(L[i]), m: 0, na: 0 };
      const nx = L[i + 1] || '';
      if (NA.test(nx)) t.na = 1; else if (miles(nx) && !isCabinLine(nx)) t.m = miles(nx);
      if (!tiles.some((x) => x.c === t.c)) tiles.push(t);
    }
    let cabin = cabinOf(String(hints.cabin || '').split('\n')[0]);
    if (!cabin && tiles.length === 1) cabin = tiles[0].c;
    if (!cabin) issues.push('nocabin');

    // Flight cards: a card starts at a line with flight numbers once the previous card has its times or miles.
    const CUR = /^(HKD|TWD|NTD|USD|EUR|GBP|JPY|CNY|AUD|SGD|CAD|KRW|THB)$/;
    const flights = [];
    let cur = null;
    const done = () => { if (cur && cur.n.length && (cur.m || cur.t.length)) flights.push(cur); cur = null; };
    for (let i = fStart; i < end; i++) {
      const s = L[i];
      const fns = (s.match(FN) || []).map((x) => x.replace(/\s/g, '')).filter((x) => /\d{2}/.test(x));
      if (fns.length && (!cur || cur.t.length || cur.m)) { done(); cur = { n: [], t: [], p: [], s: -1, du: '', m: 0, mc: {}, q: 0, x: '', lab: '' }; }
      if (!cur) continue;
      fns.forEach((x) => { if (!cur.n.includes(x)) cur.n.push(x); });
      for (const m of s.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b(\s*\+\s?\d)?/g)) { cur.t.push(pad(+m[1]) + ':' + m[2]); if (m[3] && cur.t.length > 1) cur.x = m[3].replace(/\s/g, ''); }
      const ex = s.match(/^\+\s?(\d)\s*(天|日|day)?/i);
      if (ex && cur.t.length > 1) cur.x = '+' + ex[1];
      let m = s.match(/(\d+)\s*小時\s*(\d+)\s*分(?:鐘)?|(\d+)\s*(?:h|hr|hrs|hours?)\s*(\d+)\s*(?:m|min|mins|minutes?)\b/i);
      if (m) cur.du = m[1] ? m[1] + '小時' + m[2] + '分' : m[3] + 'h' + m[4] + 'm';
      if ((m = s.match(/停留\s*(\d+)\s*次|轉機\s*(\d+)\s*次|(\d+)\s*stops?\b/i))) cur.s = +(m[1] || m[2] || m[3]);
      else if (/^(直航|直飛|不停站|non-?stop|direct)$/i.test(s) || /^(直航|直飛|non-?stop|direct)\b/i.test(s)) cur.s = 0;
      for (const c of s.match(/\b[A-Z]{3}\b/g) || []) if (!CUR.test(c) && cur.p[cur.p.length - 1] !== c) cur.p.push(c);
      const q = s.match(/剩(?:餘|下)?\s*(\d+)\s*個?(?:座位|位)|(\d+)\s*seats?\s*left/i);
      if (q) cur.q = +(q[1] || q[2]);
      if (isCabinLine(s)) { cur.lab = cabinOf(s); continue; }
      const v = miles(s);
      if (v) { if (cur.lab) { cur.mc[cur.lab] = v; cur.lab = ''; } else if (!cur.m) cur.m = v; }
    }
    done();
    const out = flights.map((f) => {
      const o = { n: f.n.join('›'), d: f.t[0] || '', a: f.t[1] || '', p: f.p.join('-'), s: f.s >= 0 ? f.s : Math.max(0, f.n.length - 1), m: f.m };
      if (f.x) o.x = f.x;
      if (f.du) o.du = f.du;
      if (f.q) o.q = f.q;
      if (Object.keys(f.mc).length) { o.mc = f.mc; if (!o.m) o.m = Math.min(...Object.values(f.mc)); }
      return o;
    });
    if (!out.length) issues.push('noflights');

    // Lowest miles per cabin for the selected date: cabin-labelled card prices, else the cards under the selected
    // cabin, plus any miles printed on the cabin tiles themselves.
    const low = {};
    const put = (c, v) => { if (c && v && (!low[c] || v < low[c])) low[c] = v; };
    tiles.forEach((t) => put(t.c, t.m));
    const labelled = out.some((f) => f.mc);
    out.forEach((f) => { if (labelled) Object.keys(f.mc || {}).forEach((c) => put(c, f.mc[c])); else put(cabin, f.m); });
    const first = out[0] ? out[0].p.split('-') : [];
    const last = out.length ? out[out.length - 1].p.split('-') : [];
    return { from: rt[0], to: rt[1], fc: first[0] || '', tc: last[last.length - 1] || '', head: hd, date, cabin, strip: stripOut, tiles, flights: out, low, issues };
  }

  // 外掛模式: the visible text of the third-party 「Unelevated Award Search」 userscript's batch results on Cathay's
  // redeem page (its DOM is not ours, so only the text is read): date lines 2027-02-13, route headers 「TPE - NRT」 and
  // flight chips 「CX461 HKG CX500 J3 Y9 ›」 (flights, connecting airports, then cabin letter + seats; 9 = 9 or more).
  // hints (from its form, when readable): { from: 'TPE', to: 'NRT,KIX', date: '20270213', cabins: 'FJWY', direct, err }.
  // → { found, dates, routes: [{ fc, tc, days: { iso: { na: 1 } | { c: { J: { seats, n, nonstop, f: [{ n, p, s, q }] } } } } }],
  //     err, missing: [iso], chips }. A date shown with no chips for a route counts as no seats.
  function parseUnelevatedText(text, hints) {
    hints = hints || {};
    // A copied page runs the route header into the link after it (「TPE - NRTBook »」): keep them apart.
    const s = String(text || '').replace(/\s*(Book\s*»)/g, '\n$1');
    const add = (d, n) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);
    const RE = /(Error\s*[:：][^\n]*)|\b(\d{4})-(\d{2})-(\d{2})\b|\b([A-Z]{3})\s*[-–—]\s*([A-Z]{3})\b|\b([A-Z]{2})\s?(\d{2,4})\b|\b([FJWY])\s?(\d)\b|\b([A-Z]{3})\b/g;
    const shown = 'FJWY'.split('').filter((c) => !hints.cabins || hints.cabins.includes(c));
    const sec = {};
    const dates = [];
    const keys = [];
    const codes = (x) => String(x || '').toUpperCase().split(/[^A-Z]+/).filter((c) => c.length === 3);
    for (const o of codes(hints.from)) for (const d of codes(hints.to)) if (o !== d) keys.push(o + '>' + d);
    let date = '';
    let rt = '';
    let cur = null;
    let err = String(hints.err || '');
    let chips = 0;
    const has = (c) => c && Object.keys(c.q).length;
    const close = () => { if (cur && has(cur) && sec[date + '|' + rt]) { sec[date + '|' + rt].push(cur); chips++; } cur = null; };
    for (const m of s.matchAll(RE)) {
      if (m[1]) { close(); err = m[1].replace(/^Error\s*[:：]\s*/, '').replace(/\s*\(?\s*Login\s*\)?\s*$/i, '').trim(); continue; }
      if (m[2]) { close(); date = m[2] + '-' + m[3] + '-' + m[4]; rt = ''; if (!dates.includes(date)) dates.push(date); continue; }
      if (m[5]) { close(); rt = m[5] + '>' + m[6]; if (!keys.includes(rt)) keys.push(rt); if (date) sec[date + '|' + rt] = sec[date + '|' + rt] || []; continue; }
      if (!date || !rt) continue;
      if (m[7]) { if (!cur || has(cur)) { close(); cur = { n: [], v: [], q: {} }; } cur.n.push(m[7] + m[8]); continue; }
      if (m[9]) { if (cur && cur.n.length) cur.q[m[9]] = Math.max(cur.q[m[9]] || 0, +m[10]); continue; }
      if (m[11] && cur && cur.n.length && !has(cur)) cur.v.push(m[11]);
    }
    close();
    dates.sort();
    const routes = keys.map((k) => {
      const [fc, tc] = k.split('>');
      const days = {};
      dates.forEach((d) => {
        const list = (sec[d + '|' + k] || []).filter((x) => shown.some((c) => x.q[c]));
        if (!list.length) {
          if (shown.length === 4) days[d] = { na: 1 };
          else { days[d] = { c: {} }; shown.forEach((c) => { days[d].c[c] = { na: 1 }; }); }
          return;
        }
        const top = list.filter((x) => !x.v.length).concat(list.filter((x) => x.v.length)).slice(0, 20);
        const c = {};
        shown.forEach((cb) => {
          const w = list.filter((x) => x.q[cb]);
          if (!w.length) return;
          c[cb] = { seats: Math.max(...w.map((x) => x.q[cb])), n: w.length, nonstop: w.some((x) => !x.v.length), f: top.filter((x) => x.q[cb]).map((x) => {
            const q = {};
            'FJWY'.split('').forEach((y) => { if (x.q[y]) q[y] = x.q[y]; });
            return { n: x.n.join('›'), p: [fc].concat(x.v, [tc]).join('-'), s: x.v.length, q };
          }) };
        });
        days[d] = { c };
      });
      return { fc, tc, days };
    }).filter((r) => dates.length && r.fc !== r.tc);
    // The batch covers 20 days from the form's date (else the first date shown); with an error, the rest are missing.
    let start = '';
    const hd = String(hints.date || '').match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
    if (hd) start = hd[1] + '-' + hd[2] + '-' + hd[3];
    else if (dates.length) start = dates[0];
    const missing = [];
    if (err && start) for (let i = 0; i < (hints.days || 20); i++) { const d = add(start, i); if (!dates.includes(d)) missing.push(d); }
    const found = /Unelevated Award Search|批次搜尋\s*\d*\s*天可兌換航班/i.test(s) || !!hints.found;
    return { found, dates, routes, err, missing, chips, start };
  }

  // The calendar and the chosen day's flights, drawn into `box` from a route record { from, to, days }. `st` holds the
  // month on show and the chosen day; clicks redraw in place. Shared by the panel on Cathay's page and our landing.
  function cxView(box, db, st) {
    const E = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
    const LB = { Y: '經', W: '豪', J: '商', F: '頭' };
    const CN = { Y: '經濟艙', W: '豪華經濟艙', J: '商務艙', F: '頭等艙' };
    const fmt = (n) => Number(n).toLocaleString('en-US');
    const short = (n) => (n >= 10000 ? +(n / 10000).toFixed(3) + '萬' : fmt(n));
    const days = (db && db.days) || {};
    const ks = Object.keys(days).sort();
    if (!st.ym) st.ym = (st.sel || ks[ks.length - 1] || new Date().toISOString()).slice(0, 7);
    const y = +st.ym.slice(0, 4);
    const mo = +st.ym.slice(5, 7);
    const shift = (n) => { const d = new Date(Date.UTC(y, mo - 1 + n, 1)); st.ym = d.toISOString().slice(0, 7); cxView(box, db, st); };
    box.textContent = '';
    const nav = E('div', 'cx-nav');
    const pv = E('button', 'cx-arw', '‹');
    const nx = E('button', 'cx-arw', '›');
    pv.type = nx.type = 'button';
    pv.setAttribute('aria-label', '上個月');
    nx.setAttribute('aria-label', '下個月');
    pv.onclick = () => shift(-1);
    nx.onclick = () => shift(1);
    nav.append(pv, E('b', '', y + '年' + mo + '月'), nx);
    const g = E('div', 'cx-g');
    for (const w of '日一二三四五六') g.append(E('span', 'cx-w', w));
    const first = new Date(Date.UTC(y, mo - 1, 1));
    for (let i = 0; i < first.getUTCDay(); i++) g.append(E('span'));
    const n = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    for (let d = 1; d <= n; d++) {
      const iso = st.ym + '-' + String(d).padStart(2, '0');
      const r = days[iso];
      const b = E('button', 'cx-d');
      b.type = 'button';
      b.append(E('i', '', d));
      const cs = r && r.c ? 'YWJF'.split('').filter((c) => r.c[c] && r.c[c].m) : [];
      cs.forEach((c) => { const s = E('span', 'cx-m'); s.append(E('b', '', LB[c]), document.createTextNode(short(r.c[c].m))); b.append(s); });
      // 外掛模式 knows seat counts but no miles: 「商J3」.
      const seat = !cs.length && r && r.c ? 'YWJF'.split('').filter((c) => r.c[c] && r.c[c].seats) : [];
      seat.forEach((c) => { const s = E('span', 'cx-m'); s.append(E('b', '', LB[c]), document.createTextNode(c + r.c[c].seats)); b.append(s); });
      // The runner's strip sweep knows a cabin has seats (no 不適用) before any miles are read: 「有位」.
      const open = !cs.length && !seat.length && r && r.c ? 'YWJF'.split('').filter((c) => r.c[c] && !r.c[c].na) : [];
      if (seat.length) b.title = seat.map((c) => CN[c] + ' ' + (r.c[c].seats >= 9 ? '9 位以上' : r.c[c].seats + ' 位')).join('、');
      if (!cs.length && !seat.length && r && (r.na || (r.c && !open.length && !r.lo))) b.append(E('span', 'cx-na', '無位'));
      else if (!cs.length && r && r.lo) b.append(E('span', 'cx-m', '低' + short(r.lo)));
      else if (open.length) b.append(E('span', 'cx-m', open.map((c) => LB[c]).join('') + '有位'));
      if (cs.length || seat.length || (r && r.lo) || open.length) b.classList.add('has');
      else if (r && (r.na || r.c)) b.classList.add('na');
      if (st.sel === iso) b.classList.add('sel');
      b.onclick = () => { st.sel = iso; cxView(box, db, st); };
      g.append(b);
    }
    box.append(nav, g);
    if (!st.sel) return;
    const det = E('div', 'cx-det');
    const r = days[st.sel];
    det.append(E('b', 'cx-dh', +st.sel.slice(5, 7) + '/' + +st.sel.slice(8) + '（' + '日一二三四五六'[new Date(st.sel).getUTCDay()] + '）'));
    const cs = r && r.c ? 'YWJF'.split('').filter((c) => r.c[c] && r.c[c].m) : [];
    const open = r && r.c ? 'YWJF'.split('').filter((c) => r.c[c] && !r.c[c].na) : [];
    const shut = r && r.c ? 'YWJF'.split('').filter((c) => r.c[c] && r.c[c].na) : [];
    const seat = !cs.length && r && r.c ? 'YWJF'.split('').filter((c) => r.c[c] && r.c[c].seats) : [];
    // 外掛模式: seats per cabin and the flights, priced 「約」 on the Asia Miles chart when the page gives st.est(cabin, path).
    const est = (c, p) => (st.est ? st.est(c, p) || 0 : 0);
    const nseat = (v) => (v >= 9 ? '9 位以上' : v + ' 位');
    if (seat.length) {
      // One line per cabin (most seats, flights, 「約」 price), then the day's flights once, with their seats per cabin.
      let any = false;
      const all = [];
      seat.slice().reverse().forEach((c) => {
        const x = r.c[c];
        const fs = x.f || [];
        const ms = fs.map((f) => est(c, f.p)).filter(Boolean);
        const lo = ms.length ? Math.min(...ms) : est(c, (db.fc || '') + '-' + (db.tc || ''));
        if (lo) any = true;
        det.append(E('div', 'cx-ch', CN[c] + ' 最多 ' + nseat(x.seats) + '・' + (x.n || fs.length) + ' 班' + (x.nonstop ? '（有直飛）' : '') + (lo ? '・約 ' + fmt(lo) + ' 哩起' : '')));
        fs.forEach((f) => { if (!all.some((g) => g.n === f.n)) all.push(f); });
      });
      all.sort((a, b) => (a.s || 0) - (b.s || 0)).forEach((f) => {
        const row = E('div', 'cx-f');
        const q = f.q || {};
        row.append(E('span', '', f.n), E('b', '', 'FJWY'.split('').filter((y) => q[y]).map((y) => y + q[y]).join(' ')),
          E('small', '', [(f.p || '').split('-').join(' → '), f.s ? '轉 ' + f.s + ' 次' : '直飛'].join('・')));
        det.append(row);
      });
      // On our site the card or the landing explains 「約」; on Cathay's page there is no chart.
      if (!any && !st.est) det.append(E('p', 'cx-mut', '外掛只顯示座位數（9 表示 9 位以上），不顯示哩數；匯出到網站後會依獎勵表估算。'));
    } else if (!cs.length && (open.length || shut.length)) det.append(E('p', 'cx-mut', (open.length ? '國泰日期列顯示' + open.map((c) => CN[c]).join('、') + '有位（哩數要點進那天才看得到）' : '') + (shut.length ? (open.length ? '；' : '') + shut.map((c) => CN[c]).join('、') + '「不適用」' : '') + '。'));
    else if (!r || (!cs.length && !r.na)) det.append(E('p', 'cx-mut', r && r.lo ? '國泰日期列顯示最低 ' + fmt(r.lo) + ' 哩；在國泰頁面點這天就會記下航班。' : '這天還沒有紀錄：在國泰頁面點這天，就會記下來。'));
    else if (!cs.length) det.append(E('p', 'cx-mut', '國泰顯示「不適用」：這天沒有獎勵位。'));
    cs.forEach((c) => {
      const x = r.c[c];
      det.append(E('div', 'cx-ch', CN[c] + ' ' + fmt(x.m) + ' 哩起' + (x.f ? '' : '（未看航班）')));
      (x.f || []).forEach((f) => {
        const row = E('div', 'cx-f');
        const p = (f.p || '').split('-');
        const via = p.slice(1, -1).join('、');
        row.append(E('span', '', f.n), E('b', '', fmt(f.m)),
          E('small', '', [f.d && f.a ? f.d + ' ' + (p[0] || '') + ' → ' + f.a + (f.x || '') + ' ' + (p[p.length - 1] || '') : '', f.s ? '轉 ' + f.s + ' 次' + (via ? '（' + via + '）' : '') : '直飛', f.du || '', f.q ? '剩 ' + f.q + ' 位' : ''].filter(Boolean).join('・')));
        det.append(row);
      });
    });
    box.append(det);
  }

  // Panel styles, scoped to .cxp. Colours are custom properties so our site can map them to its own (dark) tokens.
  function cxCss() {
    return '.cxp{--cb:#fff;--ct:#1f2a37;--cm:#5f6b76;--cl:#dfe5e8;--ca:#006564;--cs:#e3f1ef;--cn:#eef0f2;font:13px/1.45 system-ui,-apple-system,"PingFang TC","Microsoft JhengHei",sans-serif;color:var(--ct)}'
      + '.cxp *{box-sizing:border-box}.cxp button{font:inherit;color:inherit;background:var(--cb);border:1px solid var(--cl);border-radius:8px;padding:5px 9px;cursor:pointer}'
      + '.cx-panel{width:360px;max-width:calc(100vw - 24px);max-height:calc(100vh - 32px);overflow:auto;background:var(--cb);border:1px solid var(--cl);border-radius:14px;box-shadow:0 10px 34px rgba(0,0,0,.28);padding:10px 12px 12px}'
      + '.cx-top{display:flex;align-items:center;gap:6px}.cx-top>b{flex:1;font-size:14px}.cx-top button{border:0;padding:2px 8px;font-size:16px;line-height:1}'
      + '.cx-st{color:var(--cm);font-size:12px;margin:4px 0 6px}.cx-nav{display:flex;align-items:center;justify-content:space-between;margin:2px 0 4px}.cx-arw{border:0!important;font-size:18px!important;padding:0 10px!important}'
      + '.cx-g{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:2px}.cx-w{text-align:center;color:var(--cm);font-size:11px}'
      + '.cxp .cx-d{min-height:44px;display:flex;flex-direction:column;align-items:stretch;justify-content:flex-start;padding:2px 3px;border-radius:7px;border:1.5px solid transparent;background:none;text-align:left;font-size:10.5px;line-height:1.3;font-variant-numeric:tabular-nums;overflow:hidden}'
      + '.cx-d i{font-style:normal;color:var(--cm);font-size:11px}.cx-d.has{background:var(--cs)}.cx-d.na{background:var(--cn)}.cxp .cx-d.sel{border-color:var(--ca)}'
      + '.cx-m{white-space:nowrap}.cx-m b{color:var(--ca);margin-right:1px}.cx-na{color:var(--cm)}'
      + '.cx-det{border-top:1px solid var(--cl);margin-top:8px;padding-top:6px}.cx-dh{display:block;margin-bottom:2px}.cx-ch{font-weight:700;color:var(--ca);margin-top:6px}.cx-mut{color:var(--cm);margin:4px 0}'
      + '.cx-f{display:flex;flex-wrap:wrap;justify-content:space-between;gap:0 8px;padding:4px 0;border-bottom:1px dashed var(--cl);font-variant-numeric:tabular-nums}.cx-f small{flex-basis:100%;color:var(--cm)}'
      + '.cx-tabs{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 6px}.cx-tabs:empty{display:none}.cxp .cx-tabs button{padding:3px 10px;font-variant-numeric:tabular-nums}'
      + '.cx-btns{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}.cxp .cx-pri{background:var(--ca);border-color:var(--ca);color:#fff}'
      + '.cx-note{color:var(--cm);font-size:11.5px;margin:8px 0 0}.cx-out textarea{width:100%;height:90px;margin-top:6px;font:11px monospace}.cx-out a{color:var(--ca)}';
  }

  // DOM hints: which strip day and which cabin tile are selected, from aria/class markers or, failing that, the one
  // item whose text is clearly lighter than its siblings (Cathay draws the selected day and cabin white on dark).
  function cxHints() {
    const SEL = '[aria-selected="true"],[aria-pressed="true"],[aria-checked="true"],[aria-current]:not([aria-current="false"]),[class*="selected" i],[class*="active" i]';
    const WT = /^(?:(?:星期|週|周|禮拜)[日天一二三四五六]|(?:sun|mon|tue|wed|thu|fri|sat)[a-z]{0,6}\.?)(?:\s*\d{1,2})?$/i;
    const WD = /^\s*(?:(?:星期|週|周|禮拜)[日天一二三四五六]|(?:sun|mon|tue|wed|thu|fri|sat)[a-z]{0,6}\.?),?\s*(\d{1,2})\b/i;
    const CB = /^(特選經濟|豪華經濟|經濟|商務|頭等)(客艙|艙)$|^(premium economy|economy|business|first)(\sclass)?$/i;
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const dayEls = [];
    const cabEls = [];
    let n;
    while ((n = tw.nextNode())) {
      const t = n.nodeValue.trim();
      const el = n.parentElement;
      if (!t || t.length > 24 || !el || !el.getClientRects().length) continue;
      if (WT.test(t)) {
        for (let e = el, k = 0; e && k < 4; e = e.parentElement, k++) {
          const m = (e.innerText || '').match(WD);
          if (m) { dayEls.push([el, +m[1], e]); break; }
        }
      } else if (CB.test(t)) cabEls.push([el, t, el]);
    }
    const lum = (el) => { const m = (getComputedStyle(el).color.match(/[\d.]+/g) || [0, 0, 0]).map(Number); return (0.3 * m[0] + 0.59 * m[1] + 0.11 * m[2]) / 255; };
    const marked = (el) => { for (let e = el, k = 0; e && k < 4; e = e.parentElement, k++) if (e.matches(SEL)) return true; return false; };
    const choose = (list, one) => {
      const hit = list.filter((x) => marked(x[0]));
      if (hit.length === 1) return hit[0];
      if (one && list.length === 1) return list[0];
      if (list.length < 2) return null;
      const ls = list.map((x) => lum(x[0]));
      const mx = Math.max(...ls);
      const rest = ls.filter((v) => v !== mx);
      return ls.filter((v) => v === mx).length === 1 && rest.length && mx - Math.max(...rest) > 0.25 ? list[ls.indexOf(mx)] : null;
    };
    const d = choose(dayEls, false);
    const c = choose(cabEls, true);
    return { day: d ? d[1] : null, cabin: c ? c[1] : '', nd: dayEls.length, nc: cabEls.length };
  }

  // 外掛模式: the 「Unelevated Award Search」 userscript's panel, if it is on the page → { root, text, hints } or null.
  // The panel may sit in the page itself, in an open shadow root or in a same-origin iframe, so every one of those is
  // searched (a closed shadow root cannot be read; 讀取外掛結果 covers that). root is the smallest element (or shadow
  // root) holding its title and the dated results; without a readable title, the smallest one holding all the dated
  // results. hints come from its form (From / To / Date inputs, the 直飛 and cabin checkboxes) and an error line.
  function cxUnFind() {
    const TT = /^(Unelevated\s+Award\s+Search\b.{0,20}|批次搜尋\s*\d*\s*天可兌換航班)$/i;
    const DT = /\b\d{4}-\d{2}-\d{2}\b/;
    const RT = /\b[A-Z]{3}\s*[-–—]\s*[A-Z]{3}\b/;
    const CH = /\b[A-Z]{2}\s?\d{2,4}\b[\s\S]{0,60}?\b[FJWY]\s?\d\b/;
    const me = window.__cxcal && window.__cxcal.host;
    const roots = [];
    const add = (r) => {
      if (!r || roots.includes(r)) return;
      roots.push(r);
      for (const e of r.querySelectorAll('*')) {
        if (e === me) continue;
        if (e.shadowRoot) add(e.shadowRoot);
        if (e.tagName === 'IFRAME' || e.tagName === 'FRAME') { try { add(e.contentDocument); } catch (x) { /* cross-origin */ } }
      }
    };
    add(document);
    const tx = (e) => (e.nodeType === 11 ? [].map.call(e.children, (c) => c.innerText || '').join('\n') : e.innerText || '');
    const up = (e) => e.parentElement || (e.parentNode && e.parentNode.nodeType === 11 ? e.parentNode : null);
    const top = (e) => e.nodeType === 11 || e.nodeName === 'HTML';
    const vis = (e) => e && e.getClientRects().length;
    let t = null;
    let first = null;
    for (const r of roots) {
      const tw = (r.ownerDocument || r).createTreeWalker(r.body || r, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = tw.nextNode())) {
        const v = n.nodeValue.replace(/\s+/g, ' ').trim();
        if (TT.test(v) && vis(n.parentElement)) { t = n.parentElement; break; }
        if (!first && DT.test(v) && vis(n.parentElement)) first = n.parentElement;
      }
      if (t) break;
    }
    let panel = null;
    let root = null;
    if (t) {
      for (let e = t; e; e = top(e) ? null : up(e)) {
        const x = tx(e);
        if (!panel && /Unelevated\s+Award\s+Search/i.test(x) && /搜尋/.test(x)) panel = e;
        if (!root && DT.test(x) && RT.test(x)) root = e;
        if (root && panel) break;
      }
      panel = panel || t.parentElement || t;
      root = root || panel;
    } else {
      // No title: the results table alone, if it looks like the userscript's (dates, 「TPE - NRT」 headers, flight chips).
      if (!first) return null;
      const all = (x) => (x.match(/\b\d{4}-\d{2}-\d{2}\b/g) || []).length;
      let e = first;
      while (!top(e) && !(RT.test(tx(e)) && CH.test(tx(e)))) e = up(e);
      const rn = e.getRootNode();
      const base = rn.body || rn;
      const want = all(tx(base));
      while (!top(e) && all(tx(e)) < want) e = up(e);
      if (!RT.test(tx(e)) || !CH.test(tx(e))) return null;
      root = panel = e;
    }
    const lab = (i) => ((i.labels && i.labels[0] && i.labels[0].innerText) || i.getAttribute('aria-label') || i.getAttribute('placeholder') || i.name || (i.previousElementSibling && i.previousElementSibling.innerText) || (i.parentElement && i.parentElement.innerText) || '').trim();
    const hints = { cabins: '' };
    const CB = { 頭等: 'F', 商務: 'J', 豪經: 'W', 經濟: 'Y' };
    let boxes = 0;
    for (const i of (root.contains(panel) ? root : panel).querySelectorAll('input')) {
      const l = lab(i);
      if (i.type === 'checkbox') {
        const w = (l.match(/直飛|頭等|商務|豪經|經濟/) || [''])[0];
        if (w === '直飛') hints.direct = i.checked;
        else if (w) { boxes++; if (i.checked) hints.cabins += CB[w]; }
      } else if (/^from\b/i.test(l)) hints.from = i.value;
      else if (/^to\b/i.test(l)) hints.to = i.value;
      else if (/^date\b/i.test(l)) hints.date = i.value.trim();
    }
    if (boxes < 4) delete hints.cabins;
    const text = tx(root);
    const er = (text + '\n' + (document.body.innerText || '')).match(/Error\s*[:：]\s*([^\n]*)/);
    if (er) hints.err = er[1].replace(/\s*\(?\s*Login\s*\)?\s*$/i, '').trim();
    hints.found = true;
    return { root, text, hints };
  }

  // For 複製診斷資料 when the userscript's panel was not found: where text could be hiding (counts only, no content).
  function cxUnProbe() {
    const me = window.__cxcal && window.__cxcal.host;
    let open = 0;
    let fr = 0;
    let xfr = 0;
    let hosts = 0;
    const walk = (r) => {
      for (const e of r.querySelectorAll('*')) {
        if (e === me) continue;
        if (e.shadowRoot) { open++; walk(e.shadowRoot); }
        if (e.tagName === 'IFRAME' || e.tagName === 'FRAME') { fr++; try { if (e.contentDocument) walk(e.contentDocument); else xfr++; } catch (x) { xfr++; } }
        if (e.tagName.includes('-') && !e.shadowRoot && !e.children.length && e.getClientRects().length && e.getBoundingClientRect().height > 100) hosts++;
      }
    };
    walk(document);
    const b = document.body.innerText || '';
    return { v: 3, open, iframes: fr, xorigin: xfr, emptyHosts: hosts, title: /Unelevated/i.test(document.body.textContent || ''), dates: (b.match(/\b\d{4}-\d{2}-\d{2}\b/g) || []).length, routes: (b.match(/\b[A-Z]{3}\s*[-–—]\s*[A-Z]{3}\b/g) || []).length };
  }

  // The results section only (from the 出發 heading down through the flight list), never the header/account area.
  function cxRoot() {
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    let h = null;
    while ((n = tw.nextNode())) if (/^(出發|去程|departure|depart|departing|outbound|departing flights?)$/i.test(n.nodeValue.trim()) && n.parentElement.getClientRects().length) { h = n.parentElement; break; }
    if (!h) return null;
    const BAD = /選擇航班|旅客及服務|重新搜尋|出發日期|select flights?|modify search|departure date|會員|member|登出|log ?out|sign ?out|里數餘額|balance/i;
    let best = h;
    let found = null;
    for (let e = h.parentElement; e && e !== document.body; e = e.parentElement) {
      if (BAD.test(e.innerText || '') || e.matches('header,nav,footer,[role=banner],[role=navigation]')) break;
      best = e;
      if (!found && /\b[A-Z]{2}\s?\d{2,4}\b/.test(e.innerText) && /\d{1,2}:\d{2}/.test(e.innerText)) found = e;
    }
    return found || best;
  }

  // A sanitized outline of the results section: tags, class/role/aria attributes and visible text, with anything that
  // looks like an e-mail, member number, name or miles balance removed.
  function cxDiag(rootEl, extra) {
    const clean = (t) => String(t).replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]').replace(/\d[\d\s-]{6,}\d/g, (x) => (/\d{7,}/.test(x.replace(/[\s-]/g, '')) ? '[number]' : x))
      .replace(/\b(MR|MRS|MS|MISS|MSTR|DR)\b\.?\s+[A-Z][A-Za-z' -]*/g, '[name]').replace(/[一-鿿]{1,4}(先生|小姐|女士|太太)/g, '[name]')
      .replace(/(里數餘額|哩程餘額|會員編號|會員號碼|balance|member(ship)?\s*(no|number|#))[^\n]*/gi, '[removed]');
    const SKIP = /member|account|profile|user|balance|greet|avatar|login|logout|signin|signout|email|loyalty|tier/i;
    const out = [];
    let size = 0;
    const walk = (e, dep) => {
      if (size > 60000) return;
      const pad = ' '.repeat(dep);
      if (e.nodeType === 3) { const t = e.nodeValue.replace(/\s+/g, ' ').trim(); if (t) { out.push(pad + clean(t)); size += t.length; } return; }
      if (e.nodeType === 11) { for (const c of e.childNodes) walk(c, dep); return; }
      if (e.nodeType !== 1) return;
      const tag = e.tagName.toLowerCase();
      if (/^(script|style|noscript|iframe|template|link|meta)$/.test(tag)) return;
      if (tag !== 'option' && !e.getClientRects().length) return;
      const at = [];
      for (const a of ['class', 'role', 'type', 'aria-label', 'aria-selected', 'aria-pressed', 'aria-current', 'aria-checked', 'aria-expanded', 'aria-disabled', 'disabled']) {
        const v = e.getAttribute(a);
        if (v != null) at.push(a + '="' + clean(v).slice(0, 80) + '"');
      }
      if (tag === 'input' && (e.type === 'checkbox' || e.type === 'radio')) at.push('checked=' + e.checked);
      const line = pad + '<' + tag + (at.length ? ' ' + at.join(' ') : '') + '>';
      if (SKIP.test((e.getAttribute('class') || '') + ' ' + (e.id || '') + ' ' + (e.getAttribute('aria-label') || '')) || /^(header|nav)$/.test(tag) || e.matches('[role=banner],[role=navigation],input[type=password],input[type=email]')) { out.push(line + ' [略過]'); return; }
      out.push(line);
      size += line.length;
      if (tag === 'svg' || tag === 'input' || tag === 'select') return;
      for (const c of e.childNodes) walk(c, dep + 1);
    };
    if (rootEl) walk(rootEl, 0); else out.push('（找不到「出發」標題，沒有擷取頁面內容）');
    return '國泰哩程日曆・診斷資料（只含航班結果區，已移除姓名、會員號碼、e-mail 與哩程餘額）\n頁面：' + location.origin + location.pathname + '\n語言：' + (document.documentElement.lang || '') + '\n' + extra + '\n----\n' + out.join('\n');
  }

  // The bookmark's entry point on Cathay's page.
  function cxRun(origin, note) {
    if (window.__cxcal && window.__cxcal.host.isConnected) { window.__cxcal.show(); return; }
    const E = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
    const ld = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
    const sv = (k, v) => { try { if (v) localStorage.setItem(k, JSON.stringify(v)); else localStorage.removeItem(k); return true; } catch (e) { return false; } };
    const CN = { Y: '經濟艙', W: '豪華經濟艙', J: '商務艙', F: '頭等艙' };
    const host = E('div');
    host.style.cssText = 'all:initial;position:fixed;right:12px;bottom:12px;z-index:2147483647';
    const sr = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    const css = E('style');
    css.textContent = cxCss();
    const p = E('div', 'cxp cx-panel');
    const top = E('div', 'cx-top');
    const ttl = E('b', '', '國泰哩程日曆');
    const sw = E('button', '', '⇆');
    const mn = E('button', '', '–');
    const cl = E('button', '', '×');
    sw.type = mn.type = cl.type = 'button';
    sw.title = '移到另一邊（擋住國泰頁面時）';
    mn.title = '縮小';
    cl.title = '關閉（已記錄的資料會保留）';
    top.append(ttl, sw, mn, cl);
    const body = E('div');
    const stat = E('div', 'cx-st', '讀取中…');
    const tabs = E('div', 'cx-tabs');
    const view = E('div');
    const btns = E('div', 'cx-btns');
    const bClr = E('button', '', '清除');
    const bExp = E('button', 'cx-pri', '匯出到機票搜索雷達');
    const bDia = E('button', '', '複製診斷資料');
    const bPas = E('button', '', '讀取外掛結果');
    bPas.hidden = true;
    [bClr, bExp, bDia, bPas].forEach((b) => { b.type = 'button'; btns.append(b); });
    const outBox = E('div', 'cx-out');
    const NT = '只讀取你畫面上已顯示的內容：不會自動點選或查詢，密碼不會離開你的瀏覽器。在國泰頁面點其他日期或艙等，日曆會自己補上。';
    const NTU = '外掛模式：只讀取 Unelevated 外掛畫面上已顯示的批次結果，不會替你按任何按鈕；外掛還在跑時，結果會自己補上。';
    const nt = E('p', 'cx-note', NT + (note ? ' ' + note : ''));
    body.append(stat, tabs, view, btns, outBox, nt);
    p.append(top, body);
    sr.append(css, p);
    document.documentElement.append(host);

    let key = '';
    let db = null;
    let last = null;
    const st = { ym: '', sel: '' };
    // 外掛模式: every route the userscript shows, [{ k, d }], and the one on show.
    let un = null;
    let unList = [];
    const draw = () => {
      ttl.textContent = '國泰哩程日曆' + (un ? '・外掛模式' : db && db.from ? '・' + db.from + ' → ' + db.to : '');
      tabs.textContent = '';
      if (un && unList.length > 1) unList.forEach((x) => {
        const b = E('button', x.k === key ? 'cx-pri' : '', x.d.fc + ' → ' + x.d.tc);
        b.type = 'button';
        b.onclick = () => { key = x.k; db = x.d; st.ym = ''; st.sel = un.dates[0] || ''; draw(); };
        tabs.append(b);
      });
      cxView(view, db || { days: {} }, st);
    };
    const md = (d) => +d.slice(5, 7) + '/' + +d.slice(8);
    // Dates as short runs: 2/17–2/20、2/25.
    const runs = (ds) => {
      const out = [];
      ds.forEach((d, i) => { if (i && Date.parse(d) - Date.parse(ds[i - 1]) === 864e5) out[out.length - 1][1] = d; else out.push([d, d]); });
      return out.map((r) => (r[0] === r[1] ? md(r[0]) : md(r[0]) + '–' + md(r[1]))).join('、');
    };
    const readUn = (f, u) => {
      const now = Date.now();
      let saved = true;
      unList = u.routes.map((rt) => {
        const k = 'cxcal:' + rt.fc + '>' + rt.tc;
        const d = ld(k) || { from: rt.fc, to: rt.tc, days: {} };
        Object.assign(d, { fc: rt.fc, tc: rt.tc, source: 'unelevated', at: now });
        Object.keys(rt.days).forEach((x) => {
          const v = rt.days[x];
          if (v.c) Object.keys(v.c).forEach((c) => { v.c[c].t = now; });
          d.days[x] = v;
        });
        saved = sv(k, d) && saved;
        return { k, d };
      });
      if (!un) { nt.textContent = NTU; st.ym = ''; st.sel = ''; }
      un = u;
      last = { u, hints: f.hints };
      const cur = unList.find((x) => x.k === key) || unList[0];
      if (cur.k !== key) { st.ym = ''; st.sel = u.dates[0]; }
      key = cur.k;
      db = cur.d;
      let msg = '外掛模式：讀到 ' + unList.length + ' 條航線、' + u.dates.length + ' 天';
      if (f.hints.direct) msg += '（外掛只勾了直飛，轉機航班沒有列出）';
      if (u.err) msg += '。外掛顯示：' + (/金鑰/.test(u.err) ? '無法取得金鑰，請登出國泰再登入後重跑批次搜尋' : u.err) + (u.missing.length ? '（缺 ' + runs(u.missing) + '，共 ' + u.missing.length + ' 天）' : '');
      if (!saved) msg += '（瀏覽器不允許儲存，關掉分頁就會不見）';
      stat.textContent = msg;
      draw();
    };
    const read = () => {
      const busy = [].some.call(document.body.querySelectorAll('[aria-busy="true"],[class*="spinner" i],[class*="loading" i]'), (e) => e.getClientRects().length);
      if (busy && waits++ < 6) { later(); return; }
      waits = 0;
      let r;
      let hints;
      let f = null;
      try {
        f = cxUnFind();
        const rn = f && f.root.getRootNode();
        if (rn && rn !== document && !seen.includes(rn)) { seen.push(rn); mo.observe(rn, OBS); }
        const u = f ? parseUnelevatedText(f.text, f.hints) : null;
        if (u && u.routes.length) { pasted = false; bPas.hidden = true; readUn(f, u); return; }
        if (pasted) return;
      } catch (e) { stat.textContent = '外掛模式讀取失敗：' + e.message + '。請按「複製診斷資料」傳給我們。'; return; }
      if (un) { un = null; unList = []; key = ''; db = null; nt.textContent = NT + (note ? ' ' + note : ''); }
      try { hints = cxHints(); r = parseCathayText(document.body.innerText, hints); } catch (e) { stat.textContent = '讀取失敗：' + e.message + '。請按「複製診斷資料」傳給我們。'; return; }
      last = { r, hints, f };
      if ((!r.from && !r.fc) || (r.issues.includes('nohead') && !r.flights.length && !r.strip.length)) {
        bPas.hidden = !!f;
        stat.textContent = f ? '外掛模式：還沒有結果。請先按外掛的「批次搜尋」，跑完會自動讀進來。' : '還讀不到航線：請在國泰「選擇航班」的結果頁使用。裝了 Unelevated 外掛但讀不到它的結果時，請按「讀取外掛結果」。';
        draw();
        return;
      }
      const k = 'cxcal:' + (r.from && r.to ? r.from + '>' + r.to : r.fc + '>' + r.tc);
      if (k !== key) { key = k; db = ld(k) || { from: r.from || r.fc, to: r.to || r.tc, days: {} }; st.ym = ''; st.sel = ''; }
      if (r.fc) { db.fc = r.fc; db.tc = r.tc; }
      const day = (d) => (db.days[d] = db.days[d] || {});
      r.strip.forEach((s) => {
        const x = day(s.date);
        if (s.na) x.na = 1; else delete x.na;
        if (s.m) x.lo = s.m;
      });
      if (r.date) {
        const x = day(r.date);
        const now = Date.now();
        Object.keys(r.low).forEach((c) => {
          x.c = x.c || {};
          const fl = r.flights.filter((f) => (f.mc ? f.mc[c] : c === r.cabin)).slice(0, 15).map((f) => { const o = Object.assign({}, f); if (o.mc) { o.m = o.mc[c]; delete o.mc; } return o; });
          if (fl.length) x.c[c] = { m: r.low[c], f: fl, t: now };
          else x.c[c] = Object.assign(x.c[c] || {}, { m: r.low[c], t: now });
          delete x.na;
        });
        if (!st.sel) st.sel = r.date;
      }
      Object.keys(db.days).forEach((d) => { if (!Object.keys(db.days[d]).length) delete db.days[d]; });
      db.at = Date.now();
      const saved = sv(key, db);
      const n = Object.keys(db.days).filter((d) => db.days[d].c).length;
      let msg = '已記錄 ' + n + ' 天的哩程';
      if (r.date && r.cabin && r.flights.length) msg += '・剛讀到 ' + md(r.date) + ' ' + CN[r.cabin] + ' ' + r.flights.length + ' 班';
      else if (r.date && !r.cabin && r.flights.length) msg += '・讀到 ' + md(r.date) + ' 的航班，但分不出選的是哪個艙等，請按「複製診斷資料」傳給我們';
      else if (!r.date) msg += '・分不出目前選的是哪一天，請按「複製診斷資料」傳給我們';
      if (!saved) msg += '（瀏覽器不允許儲存，關掉分頁就會不見）';
      stat.textContent = msg;
      draw();
    };
    let timer = 0;
    let waits = 0;
    let pasted = false;
    const seen = [];
    const later = () => { clearTimeout(timer); timer = setTimeout(read, 800); };
    const mo = new MutationObserver(later);
    const OBS = { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'aria-selected', 'aria-pressed', 'aria-current', 'aria-checked'] };
    mo.observe(document.body, OBS);
    const shout = (t, x) => {
      outBox.textContent = '';
      outBox.append(E('p', 'cx-note', t));
      if (x) outBox.append(x);
    };
    const copy = (text, okMsg) => {
      const fallback = () => {
        const ta = E('textarea');
        ta.value = text;
        ta.readOnly = true;
        shout('無法自動複製，請在下面框內按 Ctrl+A、Ctrl+C（Mac：⌘A、⌘C）複製：', ta);
        ta.focus();
        ta.select();
      };
      try { navigator.clipboard.writeText(text).then(() => shout(okMsg), fallback); } catch (e) { fallback(); }
    };
    bClr.onclick = () => {
      if (!db) return;
      if (un) {
        if (!window.confirm('清除外掛模式讀到的 ' + unList.length + ' 條航線（' + unList.map((x) => x.d.fc + '→' + x.d.tc).join('、') + '）已記錄的日曆？外掛畫面上的結果還在時，會再讀進來。')) return;
        unList.forEach((x) => { x.d.days = {}; sv(x.k, null); });
        st.sel = '';
        shout('已清除。');
        draw();
        return;
      }
      if (!window.confirm('清除「' + db.from + ' → ' + db.to + '」已記錄的日曆？')) return;
      db.days = {};
      sv(key, null);
      st.sel = '';
      shout('已清除。');
      draw();
    };
    bExp.onclick = () => {
      if (!db || !Object.keys(db.days).length) { shout('還沒有記錄任何日期。'); return; }
      const json = JSON.stringify(un ? { v: 2, source: 'unelevated', at: Date.now(), routes: unList.map((x) => ({ from: x.d.from, to: x.d.to, fc: x.d.fc, tc: x.d.tc, days: x.d.days })) }
        : { v: 1, from: db.from, to: db.to, fc: db.fc || '', tc: db.tc || '', at: Date.now(), days: db.days });
      const b64 = btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const url = origin + '/#cxcal=' + b64;
      const w = window.open(url, '_blank');
      if (w) try { w.opener = null; } catch (e) { /* cross-origin */ }
      if (!w) { const a = E('a', '', '點這裡打開機票搜索雷達'); a.href = url; a.target = '_blank'; a.rel = 'noopener'; shout('瀏覽器擋住了新分頁：', a); }
    };
    bDia.onclick = () => {
      if (un && last && last.u) {
        const u = last.u;
        const sum = JSON.stringify({ mode: 'unelevated', routes: u.routes.map((x) => x.fc + '>' + x.tc), dates: u.dates.length, chips: u.chips, err: u.err, missing: u.missing, hints: last.hints });
        const f = cxUnFind();
        copy(cxDiag(f && f.root, '解析結果：' + sum), '已複製診斷資料（不含姓名、會員號碼與哩程餘額），可以直接貼給我們。');
        return;
      }
      const r = last && last.r;
      const sum = r ? JSON.stringify({ route: [r.from, r.to, r.fc, r.tc], head: r.head, date: r.date, cabin: r.cabin, strip: r.strip.length, tiles: r.tiles, flights: r.flights.length, low: r.low, issues: r.issues, hints: last.hints }) : '';
      let pr = '';
      try { pr = JSON.stringify(cxUnProbe()); } catch (e) { pr = e.message; }
      copy(cxDiag(cxRoot(), '解析結果：' + sum + '\n外掛偵測：' + pr), '已複製診斷資料（不含姓名、會員號碼與哩程餘額），可以直接貼給我們。');
    };
    // When the userscript's panel cannot be read (it sits in a closed shadow root, as on the owner's page): the browser
    // still copies its text when the whole page is selected. On a click: select the page body (our panel lives outside
    // it), copy, read the clipboard back (the browser asks once) and parse that. If any step is refused, the owner does
    // the same by hand: Ctrl+A, Ctrl+C on the page, Ctrl+V into the box here.
    const usePasted = (t) => {
      const u = parseUnelevatedText(t, {});
      if (!u.routes.length) return false;
      pasted = true;
      bPas.hidden = true;
      outBox.textContent = '';
      readUn({ hints: {} }, u);
      return true;
    };
    const byHand = (why) => {
      const ta = E('textarea');
      ta.placeholder = '在國泰頁面的空白處點一下，按 Ctrl+A、再按 Ctrl+C（Mac：⌘A、⌘C），然後回到這個框按 Ctrl+V（Mac：⌘V）。';
      ta.oninput = () => { if (!usePasted(ta.value)) stat.textContent = '貼上的文字裡找不到外掛的結果（例如 2027-03-01、TPE - NRT），請確認外掛已經查完再試一次。'; };
      shout((why ? why + '請改用手動：' : '') + '在國泰頁面全選、複製，再貼到下面：', ta);
      ta.focus();
    };
    bPas.onclick = async () => {
      const sel = window.getSelection();
      let text = '';
      try {
        sel.removeAllRanges();
        sel.selectAllChildren(document.body);
        const ok = document.execCommand('copy');
        sel.removeAllRanges();
        if (ok && navigator.clipboard && navigator.clipboard.readText) text = await navigator.clipboard.readText();
      } catch (e) { sel.removeAllRanges(); }
      if (text && usePasted(text)) { shout('已從頁面讀到外掛的結果（剪貼簿裡現在是這頁的文字）。外掛再查新的結果時，請再按一次「讀取外掛結果」。'); bPas.hidden = false; return; }
      byHand(text ? '頁面上找不到外掛的結果，' : '瀏覽器沒有允許讀取剪貼簿，');
    };
    sw.onclick = () => { const l = host.style.left === '12px'; host.style.left = l ? 'auto' : '12px'; host.style.right = l ? '12px' : 'auto'; };
    mn.onclick = () => { body.hidden = !body.hidden; mn.textContent = body.hidden ? '+' : '–'; mn.title = body.hidden ? '展開' : '縮小'; };
    cl.onclick = () => { mo.disconnect(); clearTimeout(timer); host.remove(); window.__cxcal = null; };
    window.__cxcal = { host, show: () => { body.hidden = false; mn.textContent = '–'; read(); } };
    read();
  }

  // Strip comments and needless spaces, string- and regex-aware, so the bookmark stays small and is one line.
  function cxMin(src) {
    let out = '';
    let i = 0;
    let pendingSpace = false;
    const P = '{}()[];,=:<>!&|?+-*/.%^~';
    const emit = (s) => {
      if (pendingSpace && out && !P.includes(out[out.length - 1]) && !P.includes(s[0])) out += ' ';
      else if (pendingSpace && out && /[+-]/.test(out[out.length - 1]) && /[+-]/.test(s[0])) out += ' ';
      pendingSpace = false;
      out += s;
    };
    const regexOk = () => {
      const t = out.replace(/\s+$/, '');
      const c = t[t.length - 1];
      return !c || '(,=:[!&|?{};+-*%<>~^'.includes(c) || /(^|[^\w$])(return|typeof|case|do|else|in|of|void|yield|await|delete|new)$/.test(t);
    };
    while (i < src.length) {
      const c = src[i];
      const d = src[i + 1];
      if (/\s/.test(c)) { pendingSpace = true; i++; continue; }
      if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (c === '/' && d === '*') { i = src.indexOf('*/', i + 2) + 2; pendingSpace = true; continue; }
      if (c === '"' || c === "'" || c === '`') {
        let j = i + 1;
        while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
        emit(src.slice(i, j + 1));
        i = j + 1;
        continue;
      }
      if (c === '/' && regexOk()) {
        let j = i + 1;
        let cls = false;
        while (j < src.length && (cls || src[j] !== '/')) { if (src[j] === '\\') j++; else if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; j++; }
        j++;
        while (/[a-z]/.test(src[j] || '')) j++;
        emit(src.slice(i, j));
        i = j;
        continue;
      }
      let j = i;
      if (/[\w$]/.test(c)) { while (j < src.length && /[\w$]/.test(src[j])) j++; } else j = i + 1;
      emit(src.slice(i, j));
      i = j;
    }
    return out;
  }

  // The bookmark: the parser, the calendar and the panel in one javascript: URL (no script is loaded from anywhere,
  // so no script host has to be allowed by Cathay's page). One line, with % and # escaped for the URL.
  function bookmarkletCode(origin, note) {
    const fns = [parseCathayText, parseUnelevatedText, cxView, cxCss, cxHints, cxUnFind, cxUnProbe, cxRoot, cxDiag, cxRun].map(String).join('\n');
    const src = '(function(){' + fns + '\ncxRun(' + JSON.stringify(String(origin || '').replace(/\/$/, '')) + ',' + JSON.stringify(note || '') + ')})()';
    return 'javascript:' + cxMin(src).replace(/%/g, '%25').replace(/#/g, '%23');
  }

  // Export payload (base64url JSON in the hash) → route record { from, to, fc, tc, at, days } (v1), or
  // { v: 2, source, at, routes: [route records] } (v2, several routes from 外掛模式), or null.
  function decodeExport(b64) {
    const route = (d, at, source) => {
      if (!d || typeof d.days !== 'object' || Array.isArray(d.days)) return null;
      const days = {};
      for (const k of Object.keys(d.days)) if (/^\d{4}-\d{2}-\d{2}$/.test(k) && d.days[k] && typeof d.days[k] === 'object') days[k] = d.days[k];
      const r = { from: String(d.from || '').slice(0, 40), to: String(d.to || '').slice(0, 40), fc: String(d.fc || '').slice(0, 3), tc: String(d.tc || '').slice(0, 3), at: Number(at) || 0, days };
      if (source) r.source = source;
      return r;
    };
    try {
      const s = String(b64 || '').replace(/-/g, '+').replace(/_/g, '/');
      const bin = typeof atob === 'function' ? atob(s) : Buffer.from(s, 'base64').toString('binary');
      const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
      const d = JSON.parse(new TextDecoder().decode(bytes));
      if (d && Number(d.v) === 2) {
        const source = d.source === 'unelevated' ? 'unelevated' : '';
        const routes = (Array.isArray(d.routes) ? d.routes : []).slice(0, 10).map((x) => route(x, d.at, source)).filter(Boolean);
        return routes.length ? { v: 2, source, at: Number(d.at) || 0, routes } : null;
      }
      return route(d, d && d.at);
    } catch { return null; }
  }

  const api = { parseCathayText, parseUnelevatedText, bookmarkletCode, cxMin, decodeExport, cxView, cxCss };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }
  root.CXCAL = api;

  // ---------- on our site: the help card next to Google 航班快捷, and the #cxcal= landing ----------
  if (typeof document === 'undefined' || !document.getElementById('rules') || typeof $ !== 'function') return;
  const ensureCss = () => {
    if (document.getElementById('cx-css')) return;
    const s = document.createElement('style');
    s.id = 'cx-css';
    s.textContent = cxCss();
    document.head.append(s);
  };
  const LAST = 'cxcal-last';
  function openLanding(d) {
    ensureCss();
    let dlg = document.getElementById('cx-dialog');
    if (!dlg) {
      document.body.insertAdjacentHTML('beforeend', `<dialog id="cx-dialog" class="cx-dlg" aria-labelledby="cx-title">
        <div class="dialog-head"><h2 id="cx-title">國泰哩程日曆</h2><button class="ghost" id="cx-close" aria-label="關閉">✕</button></div>
        <div class="cx-land"><p class="hint" id="cx-src"></p><div class="cxp"><div class="cx-tabs" id="cx-tabs" role="tablist"></div><div id="cx-view"></div></div></div></dialog>`);
      dlg = document.getElementById('cx-dialog');
      $('#cx-close').addEventListener('click', () => dlg.close());
      dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
    }
    // v1: one route; v2 (外掛模式): several, one calendar each behind tabs.
    const list = d.routes || [d];
    const un = d.source === 'unelevated';
    const at = d.at ? new Date(d.at) : null;
    const when = at ? `${at.getMonth() + 1}/${at.getDate()} ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}` : '';
    const name = (r) => (un ? `${r.fc} → ${r.tc}` : `${r.from} → ${r.to}`);
    // 外掛模式 has seats but no miles: priced 「約」 on the Asia Miles chart (cxlive.js cxEst, once the chart is loaded).
    const est = typeof cxEst === 'function' ? cxEst : null;
    let cur = 0;
    const show = (i) => {
      cur = i;
      const r = list[i];
      const ks = Object.keys(r.days).filter((k) => r.days[k].c).sort();
      for (const b of document.querySelectorAll('#cx-tabs button')) { const on = +b.dataset.i === i; b.classList.toggle('cx-pri', on); b.setAttribute('aria-selected', on); }
      cxView($('#cx-view'), r, { ym: '', sel: ks[0] || '', est });
    };
    const n = list.reduce((a, r) => a + Object.keys(r.days).filter((k) => r.days[k].c).length, 0);
    $('#cx-title').textContent = list.length > 1 ? `國泰哩程日曆・${list.length} 條航線` : `國泰哩程日曆・${name(list[0])}`;
    $('#cx-src').textContent = un
      ? `這些資料來自國泰查票外掛（你自己的瀏覽器）的批次查詢結果${when ? `（${when} 匯出，${list.length} 條航線、共 ${n} 天有資料）` : ''}，本站只負責顯示，沒有向國泰查詢。外掛只顯示座位數（9 表示 9 位以上），哩數是依亞洲萬里通國泰航班獎勵表與飛行距離估算的「約」，每人單程，未含稅金與附加費。機位隨時會變，開票前請到國泰官網確認。`
      : `這些資料來自你自己在國泰官網的查詢畫面${when ? `（${when} 匯出，共 ${n} 天有哩程）` : ''}，本站只負責顯示，沒有向國泰查詢。機位隨時會變，開票前請到國泰官網確認。`;
    $('#cx-tabs').innerHTML = list.length > 1 ? list.map((r, i) => `<button type="button" role="tab" data-i="${i}">${esc(name(r))}</button>`).join('') : '';
    for (const b of document.querySelectorAll('#cx-tabs button')) b.addEventListener('click', () => show(+b.dataset.i));
    show(0);
    if (est && un && typeof cxEstReady === 'function') cxEstReady().then(() => show(cur), () => {});
    // cxlive.js: 「儲存到網站」 so the route search shows this calendar (passcode).
    if (typeof cxLiveSave === 'function') cxLiveSave($('#cx-src'), d);
    if (!dlg.open) dlg.showModal();
  }

  // Under the 書籤小工具 heading (index.html #bm-tools), or after the rules on a page without it.
  const bm = $('#bm-list');
  if (bm) $('#bm-tools').hidden = false;
  (bm || $('#rules')).insertAdjacentHTML(bm ? 'beforeend' : 'afterend', `<details class="card gf-card" id="cx-card">
    <summary><b>🗓 國泰哩程日曆（書籤）</b><small>把你在國泰官網查獎勵位時看到的日期和哩程，整理成一張月曆</small></summary>
    <div id="cx-body"></div></details>`);
  // Keep it right after the Google 航班快捷 card (etrips.js adds that one next to #rules too).
  const gf = document.getElementById('gf-card');
  if (gf) gf.after(document.getElementById('cx-card'));
  $('#cx-card').addEventListener('toggle', () => {
    if (!$('#cx-card').open || $('#cx-link')) return;
    const code = bookmarkletCode(location.origin);
    let last = null;
    try { last = JSON.parse(localStorage.getItem(LAST) || 'null'); } catch { /* storage blocked */ }
    $('#cx-body').innerHTML = `<p class="hint">seats.aero 幾乎沒有從台北出發的亞洲萬里通資料。這個「書籤小工具」在你登入國泰官網、查獎勵機票時，把畫面上已顯示的日期與各艙等最低哩程記下來，排成月曆；點其他日期或艙等，月曆會自己補上，也能匯出到這裡看。</p>
      <p class="gf-drag"><a class="outline btn primary-link" id="cx-link" href="${esc(code)}">🗓 國泰日曆</a><span class="hint">← 電腦上把這個按鈕拖到書籤列</span></p>
      <div class="gf-how">
        <div><b>怎麼用（電腦版 Chrome／Edge）</b><ol><li>按 Ctrl＋Shift＋B（Mac：⌘＋Shift＋B）打開書籤列，把「🗓 國泰日曆」拖上去。</li><li>到國泰官網登入，用哩數兌換搜尋航班，停在「選擇航班」結果頁。</li><li>點書籤列的「🗓 國泰日曆」：右下角出現月曆。之後照常點日期、切換艙等，月曆會逐格填上。</li><li>裝了 Unelevated 外掛的話：先按它的「批次搜尋 20 天」，跑完再點這個書籤，會一次讀完所有日期。</li></ol>
          <button type="button" class="outline" id="cx-copy">複製書籤程式碼</button> <span class="hint">拖不動時：新增一個書籤，網址貼上這段程式碼。</span></div>
        <div><b>安全</b><p class="hint">密碼不會離開你的瀏覽器、不會自動點選或查詢：它只讀你自己畫面上已經顯示的內容，資料存在你的瀏覽器裡；按「匯出」才會帶到本站，而且放在網址 # 後面，不會傳到伺服器。</p>
          ${last ? '<button type="button" class="outline" id="cx-last">打開上次匯入的日曆</button>' : ''}</div>
      </div>`;
    $('#cx-link').addEventListener('click', (ev) => { ev.preventDefault(); toast('請把它拖到書籤列，在國泰官網的選擇航班頁面再點'); });
    $('#cx-copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(code); toast('已複製書籤程式碼'); } catch { prompt('複製這段程式碼：', code); }
    });
    $('#cx-last')?.addEventListener('click', () => openLanding(last));
  });

  // Landing: the hash was captured as BOOT_HASH before app.js moved to #search.
  const boot = typeof BOOT_HASH === 'string' ? BOOT_HASH : location.hash;
  if (boot.startsWith('#cxcal=')) {
    const d = decodeExport(boot.slice(7));
    if (!d) toast('國泰哩程日曆的資料讀不出來，請在國泰頁面再按一次「匯出」');
    else {
      try { localStorage.setItem(LAST, JSON.stringify(d)); } catch { /* storage blocked: still show it */ }
      // After the rest of the scripts, so cxlive.js's 「儲存到網站」 (cxLiveSave) and cxEst exist.
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => openLanding(d), { once: true });
      // Loaded by app.js after the page (loadSearchScripts): once cxlive.js has run too.
      else if (typeof loadSearchScripts === 'function') loadSearchScripts().then(() => openLanding(d));
      else openLanding(d);
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
