// Google 航班快捷 (bookmarklet landing): read origin, destination, dates, cabin and travellers from a Google Flights URL
// (the tfs= protobuf, the ?q= text form or the old #flt= form) plus what the bookmarklet read off the page, and turn
// them into a 航線查詢 link. Pure functions; gf.html runs them, and the tests require this file.
(function (root) {
  // Freebase ids Google uses for cities in tfs. Only ones we are sure of; anything else falls back to the page text.
  const GF_CITIES = {
    '/m/0ftkx': ['TPE', 'TSA'], // 台北
    '/m/07dfk': ['NRT', 'HND'], // 東京
    '/m/03h64': ['HKG'], // 香港
    '/m/0hsqf': ['ICN', 'GMP'], // 首爾
    '/m/04jpl': ['LHR', 'LGW'], // 倫敦
    '/m/05qtj': ['CDG', 'ORY'], // 巴黎
    '/m/02_286': ['JFK', 'EWR'], // 紐約
    '/m/030qb3t': ['LAX'], // 洛杉磯
    '/m/0d6lp': ['SFO'], // 舊金山
    '/m/01_d4': ['ORD'], // 芝加哥
    '/m/0d9jr': ['SEA'], // 西雅圖
    '/m/080h2': ['YVR'], // 溫哥華
    '/m/0h7h6': ['YYZ'], // 多倫多
    '/m/06y57': ['SYD'], // 雪梨
  };
  const SEAT = { 1: 'Y', 2: 'W', 3: 'J', 4: 'F' };
  const ISO = /^\d{4}-\d{2}-\d{2}$/;

  function b64bytes(s) {
    const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const clean = String(s).replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '');
    const out = [];
    let buf = 0;
    let bits = 0;
    for (const ch of clean) {
      buf = (buf << 6) | abc.indexOf(ch);
      bits += 6;
      if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 255); }
    }
    return Uint8Array.from(out);
  }
  const utf8 = (bytes) => (typeof TextDecoder !== 'undefined' ? new TextDecoder().decode(bytes) : String.fromCharCode(...bytes));

  // Minimal protobuf reader: [{ f: field, w: wire type, v: number | Uint8Array }]. Throws on anything malformed.
  function pb(bytes) {
    const out = [];
    let i = 0;
    const varint = () => {
      let n = 0;
      let mul = 1;
      for (let k = 0; k < 10; k++) {
        if (i >= bytes.length) throw new Error('truncated');
        const b = bytes[i++];
        n += (b & 127) * mul;
        mul *= 128;
        if (!(b & 128)) return n;
      }
      throw new Error('varint');
    };
    while (i < bytes.length) {
      const key = varint();
      const f = Math.floor(key / 8);
      const w = key % 8;
      if (w === 0) out.push({ f, w, v: varint() });
      else if (w === 2) {
        const len = varint();
        if (i + len > bytes.length) throw new Error('truncated');
        out.push({ f, w, v: bytes.subarray(i, i + len) });
        i += len;
      } else if (w === 1) i += 8;
      else if (w === 5) i += 4;
      else throw new Error('wire');
    }
    return out;
  }
  const str = (x) => (x && x.w === 2 ? utf8(x.v) : '');
  // A repeated enum may come packed (one bytes field) or one varint at a time.
  const enums = (fields, f) => fields.filter((x) => x.f === f).flatMap((x) => {
    if (x.w === 0) return [x.v];
    try { const r = []; let j = 0; const b = x.v; while (j < b.length) { let n = 0; let m = 1; let c; do { c = b[j++]; n += (c & 127) * m; m *= 128; } while (c & 128 && j < b.length); r.push(n); } return r; } catch { return []; }
  });

  // tfs → { legs: [{ date, from: [place], to: [place] }], cabin, pax, trip }. A place is an IATA code or a /m/ id.
  function parseTfs(tfs) {
    const top = pb(b64bytes(tfs));
    const place = (x) => {
      if (x.w !== 2) return '';
      const p = pb(x.v);
      return str(p.find((y) => y.f === 2)).trim();
    };
    const legs = top.filter((x) => x.f === 3 && x.w === 2).map((x) => {
      const d = pb(x.v);
      return {
        date: str(d.find((y) => y.f === 2)),
        from: d.filter((y) => y.f === 13).map(place).filter(Boolean),
        to: d.filter((y) => y.f === 14).map(place).filter(Boolean),
      };
    });
    const pax = enums(top, 8).filter((p) => p === 1 || p === 2).length;
    const seat = enums(top, 9)[0];
    const trip = enums(top, 19)[0];
    return { legs, cabin: SEAT[seat] || '', pax, trip: trip === 1 ? 'rt' : trip === 2 ? 'ow' : trip === 3 ? 'multi' : '' };
  }

  // Places to codes: IATA codes as they are, known city ids to their airports; the rest are left for the page text.
  function placeCodes(list) {
    const codes = [];
    let unknown = false;
    for (const p of list || []) {
      if (/^[A-Z]{3}$/.test(p)) codes.push(p);
      else if (GF_CITIES[p]) codes.push(...GF_CITIES[p]);
      else unknown = true;
    }
    return { codes: [...new Set(codes)], unknown };
  }

  const cabinFromText = (t) => (/first|頭等/i.test(t) ? 'F' : /premium|豪華經濟|豪經/i.test(t) ? 'W' : /business|商務/i.test(t) ? 'J' : /economy|經濟/i.test(t) ? 'Y' : '');
  const isCode = (t) => /^[A-Z]{3}(,[A-Z]{3})*$/.test(t);

  // ?q=Flights to NRT from TPE on 2026-12-01 through 2026-12-08 (and the Chinese 從台北到東京 forms).
  function parseQ(q) {
    const text = String(q || '').replace(/\+/g, ' ').replace(/\s+/g, ' ').trim();
    const dates = text.match(/\d{4}-\d{2}-\d{2}/g) || [];
    const stop = '(?=\\s+(?:on|from|to|through|departing|returning|one[ -]?way|round[ -]?trip|in|for)\\b|\\s*[,，]|\\s+\\d{4}-|$)';
    const grab = (re) => (text.match(re) || [])[1]?.trim() || '';
    let from = grab(new RegExp(`\\bfrom\\s+(.+?)${stop}`, 'i'));
    let to = grab(new RegExp(`\\bto\\s+(.+?)${stop}`, 'i'));
    if (!from || !to) {
      const zh = text.match(/(?:從|由)?\s*([^\s從由到飛往至的]+?)\s*(?:到|飛往|飛|往|至)\s*([^\s的航班機票]+)/);
      if (zh) { from ||= zh[1]; to ||= zh[2]; }
    }
    const clean = (t) => t.replace(/^(the\s+)?/i, '').replace(/\s*(flights?|航班|機票)$/i, '').trim();
    return { from: clean(from), to: clean(to), dates, cabin: cabinFromText(text), oneWay: /one[ -]?way|單程/i.test(text) };
  }

  // Old Google Flights links: #flt=TPE.NRT.2026-12-01*NRT.TPE.2026-12-08;c:TWD;e:1;sc:b;t:f
  function parseFlt(hash) {
    const m = String(hash || '').match(/flt=([^;&]+)(.*)$/);
    if (!m) return null;
    const legs = m[1].split('*').map((s) => s.split('.')).filter((p) => p.length >= 3).map(([o, d, date]) => ({ from: o.toUpperCase().split(','), to: d.toUpperCase().split(','), date }));
    const sc = (m[2].match(/;sc:([a-z])/) || [])[1];
    return { legs, cabin: { b: 'J', f: 'F', p: 'W', e: 'Y' }[sc] || '', trip: legs.length === 2 ? 'rt' : 'ow' };
  }

  // A date typed on the page: 2026-12-01, 12月1日, Dec 1, Tue, Dec 1 (the next one on or after today).
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  function pageDate(t, today) {
    const s = String(t || '');
    const iso = s.match(/\d{4}-\d{2}-\d{2}/);
    if (iso) return iso[0];
    let mo = 0;
    let d = 0;
    let y = 0;
    const zh = s.match(/(?:(\d{4})年)?\s*(\d{1,2})月\s*(\d{1,2})日/);
    const en = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b(?:,?\s*(\d{4}))?/i) || s.match(/\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:\s+(\d{4}))?/i);
    if (zh) { y = Number(zh[1] || 0); mo = Number(zh[2]); d = Number(zh[3]); }
    else if (en) {
      const [a, b] = /^\d/.test(en[1]) ? [en[2], en[1]] : [en[1], en[2]];
      mo = MONTHS.indexOf(a.toLowerCase().slice(0, 3)) + 1;
      d = Number(b);
      y = Number(en[3] || 0);
    }
    if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return '';
    const pad = (n) => String(n).padStart(2, '0');
    const now = today || new Date().toISOString().slice(0, 10);
    if (!y) { y = Number(now.slice(0, 4)); if (`${y}-${pad(mo)}-${pad(d)}` < now) y++; }
    return `${y}-${pad(mo)}-${pad(d)}`;
  }

  // Everything together. `page` is what the bookmarklet read: { f, t, v: [input values], title }.
  function parseGoogleFlights(href, page = {}, today) {
    const out = { o: '', d: '', oText: '', dText: '', s: '', r: '', c: '', n: 0, source: '' };
    let url = null;
    try { url = new URL(href); } catch { /* not a URL: page text only */ }
    const fromTo = (legs) => {
      const a = placeCodes(legs[0]?.from);
      const b = placeCodes(legs[0]?.to);
      out.o = a.codes.join(',');
      out.d = b.codes.join(',');
      out.s = ISO.test(legs[0]?.date || '') ? legs[0].date : '';
      // A round trip's second leg comes back to the start: its date is the return date.
      const back = legs[1];
      if (back && ISO.test(back.date || '')) out.r = back.date;
    };
    const tfs = url?.searchParams.get('tfs');
    if (tfs) {
      try {
        const t = parseTfs(tfs);
        if (t.legs.length) {
          fromTo(t.legs);
          if (t.trip === 'ow' || t.trip === 'multi') out.r = '';
          out.c = t.cabin;
          out.n = t.pax;
          out.source = 'tfs';
        }
      } catch { /* a tfs we can't read: fall through to the other forms */ }
    }
    const q = url?.searchParams.get('q');
    if (q && (!out.o || !out.d || !out.s)) {
      const p = parseQ(q);
      const up = (t) => (/^[A-Za-z]{3}$/.test(t) ? t.toUpperCase() : '');
      if (!out.o) { out.o = up(p.from); if (!out.o) out.oText = p.from; }
      if (!out.d) { out.d = up(p.to); if (!out.d) out.dText = p.to; }
      out.s ||= p.dates[0] || '';
      if (!p.oneWay && !out.r) out.r = p.dates[1] || '';
      out.c ||= p.cabin;
      out.source ||= 'q';
    }
    if (url && /flt=/.test(url.hash) && (!out.o || !out.d)) {
      const f = parseFlt(url.hash);
      if (f?.legs.length) {
        fromTo(f.legs);
        if (f.trip !== 'rt') out.r = '';
        out.c ||= f.cabin;
        out.source ||= 'flt';
      }
    }
    // Page text for whatever the URL didn't give (a city id we don't know, or no usable URL at all).
    const vals = (page.v || []).map((x) => String(x || '').trim()).filter(Boolean).slice(0, 8);
    const words = vals.filter((x) => !pageDate(x, today));
    const fText = String(page.f || words[0] || '').trim().slice(0, 40);
    const tText = String(page.t || words[1] || '').trim().slice(0, 40);
    if (!out.o && !out.oText) { if (/^[A-Za-z]{3}$/.test(fText)) out.o = fText.toUpperCase(); else out.oText = fText; }
    if (!out.d && !out.dText) { if (/^[A-Za-z]{3}$/.test(tText)) out.d = tText.toUpperCase(); else out.dText = tText; }
    if (!out.s) {
      const ds = vals.map((x) => pageDate(x, today)).filter(Boolean);
      out.s = ds[0] || '';
      out.r ||= ds[1] || '';
    }
    out.c ||= cabinFromText(vals.join(' ') + ' ' + String(page.title || ''));
    if (out.oText && !out.o) out.oText = out.oText.replace(/[,，].*$/, '');
    if (out.dText && !out.d) out.dText = out.dText.replace(/[,，].*$/, '');
    if (!(out.n >= 1 && out.n <= 9)) out.n = 0;
    if (out.r && out.r < out.s) out.r = '';
    return out;
  }

  // Where to send the browser: a complete parse is an ordinary search link (it runs one normal search); anything less
  // opens the search form with what we have filled in.
  function searchTarget(p, today) {
    const now = today || new Date().toISOString().slice(0, 10);
    const okDate = ISO.test(p.s) && p.s >= now;
    const q = new URLSearchParams();
    if (isCode(p.o) && isCode(p.d) && okDate) {
      q.set('o', p.o);
      q.set('d', p.d);
      q.set('s', p.s);
      q.set('e', p.s);
      q.set('c', p.c || 'Y');
      if (p.n > 1) q.set('n', String(p.n));
      if (p.r) q.set('gfr', p.r);
      return `/?${q}#search`;
    }
    if (isCode(p.o)) q.set('gfo', p.o); else if (p.oText) q.set('gfo', p.oText);
    if (isCode(p.d)) q.set('gfd', p.d); else if (p.dText) q.set('gfd', p.dText);
    if (okDate) q.set('gfs', p.s);
    if (p.c) q.set('gfc', p.c);
    // In the hash: the page rewrites its query string as it starts, but keeps the hash it was opened with (BOOT_HASH).
    return `/#gf?${q}`;
  }

  // The bookmark itself: tiny, so parsing fixes never need a reinstall. It sends the URL and the visible field values.
  function bookmarkletCode(origin) {
    const js = `(function(){var v=[].slice.call(document.querySelectorAll('input')).filter(function(i){return i.offsetParent&&i.value&&i.type!=='hidden'&&i.type!=='password'}).map(function(i){return i.value}).slice(0,8);var u='${origin}/gf.html?u='+encodeURIComponent(location.href)+'&v='+encodeURIComponent(JSON.stringify(v))+'&title='+encodeURIComponent(document.title);if(!window.open(u,'_blank'))location.href=u})()`;
    return `javascript:${js}`;
  }

  const api = { parseTfs, parseQ, parseFlt, pageDate, parseGoogleFlights, searchTarget, bookmarkletCode, placeCodes, GF_CITIES };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GF = api;
})(typeof window !== 'undefined' ? window : globalThis);
