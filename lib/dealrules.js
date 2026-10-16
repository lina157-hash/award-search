// 今日好康「我的條件通知」: the owner saves a few rules (region, cabin, most miles, operating airlines such as BR / JX /
// CI / CX, fewest seats, a date window). Each 今日好康 refresh matches them against every row its searches already
// fetched (not only the cheapest per city it keeps), so they cost no extra search. A match is sent once, to the linked
// Telegram / LINE and an optional email, and the latest matches are kept for the page to highlight. Rules, matches and
// sent marks live in Redis; only the owner (passcode) reads or changes them.
const crypto = require('node:crypto');
const { todayTW, validDate } = require('./day');
const { GROUPS } = require('./deals');

const P = 'dealrules:v1';
const KEYS = { doc: P, hits: `${P}:hits`, sent: `${P}:sent` };
const MAX_RULES = 10;
const PER_GROUP_HITS = 8; // kept per region and cabin for the page
const IN_MESSAGE = 10; // matches listed per message; the rest are counted
const MAX_SENT = 3000; // sent marks kept (the oldest dates go first)
const REGION = new Map(GROUPS.map((g) => [g.id, g.name]));
const CABIN_ZH = { J: '商務艙', F: '頭等艙' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n).toLocaleString('zh-TW');
const md = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;

class DealRuleError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// One rule from the page, checked. Empty means any: region '', cabin '', airlines [], maxMiles 0, minSeats 0, dates ''.
function cleanRule(input = {}, { today = todayTW() } = {}) {
  const list = (v) => [...new Set((Array.isArray(v) ? v : String(v ?? '').split(/[\s,，、/]+/)).map((x) => String(x).trim().toUpperCase()).filter(Boolean))];
  const r = {
    id: /^[a-z0-9]{6,12}$/.test(String(input.id || '')) ? input.id : crypto.randomUUID().slice(0, 8),
    region: String(input.region || ''),
    cabin: String(input.cabin || '').toUpperCase(),
    maxMiles: (() => { const t = String(input.maxMiles ?? '').replace(/[\s,，]/g, ''); return !t ? 0 : /^\d+$/.test(t) ? Number(t) : NaN; })(),
    airlines: list(input.airlines),
    minSeats: Math.min(9, Math.max(0, Math.floor(Number(input.minSeats) || 0))),
    from: String(input.from || ''),
    to: String(input.to || ''),
  };
  if (r.region && !REGION.has(r.region)) throw new DealRuleError('地區錯誤');
  if (r.cabin && !CABIN_ZH[r.cabin]) throw new DealRuleError('今日好康只有商務艙和頭等艙');
  if (r.maxMiles !== 0 && !(r.maxMiles >= 1000 && r.maxMiles <= 2e6)) throw new DealRuleError('哩數上限要填 1,000 到 2,000,000 之間的數字');
  if (r.airlines.length > 10 || !r.airlines.every((x) => /^[A-Z0-9]{2}$/.test(x))) throw new DealRuleError('航空公司代碼要是兩碼，例如 BR、JX');
  if ((r.from && !validDate(r.from)) || (r.to && !validDate(r.to)) || (r.from && r.to && r.to < r.from)) throw new DealRuleError('日期格式錯誤');
  if (r.to && r.to < today) throw new DealRuleError('日期已經過了');
  if (!r.region && !r.cabin && !r.maxMiles && !r.airlines.length && !r.minSeats && !r.from && !r.to) throw new DealRuleError('請至少設一個條件，不然每一筆好康都會通知');
  return r;
}

// 「歐洲・商務艙・8 萬哩內・BR／JX 自家飛・至少 2 位・12/1–2/28」
function ruleLabel(r) {
  return [r.region ? REGION.get(r.region) : '全部地區', r.cabin ? CABIN_ZH[r.cabin] : '', r.maxMiles ? `${fmt(r.maxMiles)} 哩內` : '', r.airlines.length ? `${r.airlines.join('／')} 自家飛` : '', r.minSeats > 1 ? `至少 ${r.minSeats} 位` : '', r.from || r.to ? `${r.from ? md(r.from) : ''}–${r.to ? md(r.to) : ''}` : ''].filter(Boolean).join('・');
}

// Does this row of a deals search (region `region`, cabin `cabin`) meet the rule? Seats seats.aero does not know
// pass a seat minimum, as in seat alerts. Every operating airline must be one of the rule's (自家飛).
function matches(rule, { region, cabin, row, start = '' }) {
  if (rule.region && rule.region !== region) return false;
  if (rule.cabin && rule.cabin !== cabin) return false;
  const c = row.cabins?.[cabin];
  if (!c?.available || !c.miles || (start && row.date < start)) return false;
  if (rule.maxMiles && c.miles > rule.maxMiles) return false;
  if (rule.minSeats > 1 && c.seats > 0 && c.seats < rule.minSeats) return false;
  if (rule.from && row.date < rule.from) return false;
  if (rule.to && row.date > rule.to) return false;
  if (rule.airlines.length) {
    const legs = String(c.airlines || '').split(/,\s*/).filter(Boolean);
    if (!legs.length || !legs.every((x) => rule.airlines.includes(x))) return false;
  }
  return true;
}

// Every match in one refresh's groups ([{ id, cabin, rows, start }]), one entry per seat with the rules it meets,
// cheapest first.
function matchGroups(rules, groups) {
  const out = [];
  for (const g of groups || []) {
    for (const row of g.rows || []) {
      const ids = rules.filter((r) => matches(r, { region: g.id, cabin: g.cabin, row, start: g.start })).map((r) => r.id);
      if (!ids.length) continue;
      const c = row.cabins[g.cabin];
      out.push({ key: `${row.id}:${g.cabin}`, rules: ids, region: g.id, cabin: g.cabin, date: row.date, origin: row.origin, destination: row.destination, source: row.source, miles: c.miles, seats: c.seats ?? null, airlines: c.airlines || '', direct: Boolean(c.direct) });
    }
  }
  return out.sort((a, b) => a.miles - b.miles || a.date.localeCompare(b.date));
}

// `kv` (lib/kv.js); `notify` { telegram, line }: (html) → true / null / false; `sendEmail` (Resend) or null; `names`
// { program(source), city(code) }.
function createDealRules({ kv, notify = {}, sendEmail = null, names = {}, siteUrl = '', today = () => todayTW() }) {
  const prog = (s) => names.program?.(s) || s;
  const city = (c) => names.city?.(c) || '';
  async function doc() {
    const d = (await kv.get(KEYS.doc).catch(() => null)) || {};
    return { rules: Array.isArray(d.rules) ? d.rules : [], email: d.email || '', telegram: d.telegram !== false, line: Boolean(d.line) };
  }
  async function hits() {
    const h = (await kv.get(KEYS.hits).catch(() => null)) || {};
    const t = today();
    return Object.values(h).flat().filter((x) => x.date >= t).sort((a, b) => a.miles - b.miles);
  }
  const view = async () => {
    const d = await doc();
    return { ...d, max: MAX_RULES, rules: d.rules.map((r) => ({ ...r, label: ruleLabel(r) })), hits: await hits() };
  };

  const link = (h) => `${siteUrl}/?${new URLSearchParams({ o: h.origin, d: h.destination, s: h.date, e: h.date, c: h.cabin })}#search`;
  function message(news, rules) {
    const by = new Map(rules.map((r) => [r.id, r]));
    const which = [...new Set(news.flatMap((h) => h.rules))].map((id) => by.get(id)).filter(Boolean).map(ruleLabel);
    const line = (h) => `${md(h.date)} ${h.origin}→${h.destination}${city(h.destination) ? ` ${city(h.destination)}` : ''} ${CABIN_ZH[h.cabin]} ${fmt(h.miles)} 哩・${prog(h.source)}・${h.airlines}${h.direct ? '・直飛' : ''}${h.seats ? `・${h.seats} 位` : ''}`;
    const more = news.length > IN_MESSAGE ? `還有 ${news.length - IN_MESSAGE} 筆，打開網站的今日好康看` : '';
    const chat = [`🎯 <b>今日好康有 ${news.length} 筆符合你的條件</b>`, esc(which.join('；')), ...news.slice(0, IN_MESSAGE).map((h) => (siteUrl ? `<a href="${esc(link(h))}">${esc(line(h))}</a>` : esc(line(h)))), ...(more ? [esc(more)] : [])].join('\n');
    const html = `<div style="font-family:system-ui,sans-serif;line-height:1.6"><h2 style="margin:0 0 8px">今日好康有 ${news.length} 筆符合你的條件</h2>
      <p style="color:#555">${esc(which.join('；'))}</p><ul>${news.slice(0, IN_MESSAGE).map((h) => `<li>${siteUrl ? `<a href="${esc(link(h))}">${esc(line(h))}</a>` : esc(line(h))}</li>`).join('')}</ul>
      ${more ? `<p>${esc(more)}</p>` : ''}<p style="color:#777;font-size:13px">座位資料來自 seats.aero 快取，可能已被訂走，開票前請到航空公司官網確認。</p></div>`;
    return { chat, html, subject: `【機票搜索雷達】今日好康有 ${news.length} 筆符合你的條件` };
  }

  return {
    view,
    async saveRule(input) {
      const d = await doc();
      const r = cleanRule(input, { today: today() });
      const i = d.rules.findIndex((x) => x.id === r.id);
      if (i < 0 && d.rules.length >= MAX_RULES) throw new DealRuleError(`最多 ${MAX_RULES} 條，請先刪掉一條`);
      if (i < 0) d.rules.push(r); else d.rules[i] = r;
      await kv.set(KEYS.doc, d);
      return view();
    },
    async removeRule(id) {
      const d = await doc();
      d.rules = d.rules.filter((r) => r.id !== id);
      await kv.set(KEYS.doc, d);
      return view();
    },
    // Where matches go: the linked Telegram (on unless turned off), LINE (off unless turned on: it has a monthly
    // allowance), and an email address (optional).
    async setChannels({ email, telegram, line } = {}) {
      const d = await doc();
      if (email !== undefined) {
        const e = String(email || '').trim();
        if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new DealRuleError('Email 格式錯誤');
        d.email = e;
      }
      if (telegram !== undefined) d.telegram = Boolean(telegram);
      if (line !== undefined) d.line = Boolean(line);
      await kv.set(KEYS.doc, d);
      return view();
    },
    // After a 今日好康 refresh (lib/deals.js onFetched): match, keep the matches of the groups just fetched for the
    // page, and send the ones not sent before in one message per channel. A send that failed everywhere leaves those
    // matches unmarked, so the next refresh tries again. Never throws: the deals must not suffer for it.
    async onFetched(groups) {
      try {
        const d = await doc();
        const rules = d.rules.filter((r) => !r.to || r.to >= today());
        if (!rules.length) return { matched: 0 };
        const found = matchGroups(rules, groups);
        // The page's highlight: the fetched groups' best matches replace their old ones.
        const h = (await kv.get(KEYS.hits).catch(() => null)) || {};
        for (const g of groups) h[`${g.id}:${g.cabin}`] = found.filter((x) => x.region === g.id && x.cabin === g.cabin).slice(0, PER_GROUP_HITS);
        await kv.set(KEYS.hits, h, { ex: 3 * 86400 });
        const sent = (await kv.get(KEYS.sent).catch(() => null)) || {};
        const markOf = (x, id) => `${id}|${x.key}`;
        const news = found.filter((x) => x.rules.some((id) => !(markOf(x, id) in sent)));
        if (!news.length) return { matched: found.length, sent: 0 };
        const m = message(news, rules);
        const tries = [
          d.telegram && notify.telegram ? notify.telegram(m.chat) : null,
          d.line && notify.line ? notify.line(m.chat) : null,
          d.email && sendEmail ? sendEmail({ to: d.email, subject: m.subject, html: m.html }).then(() => true) : null,
        ];
        const rs = (await Promise.allSettled(tries)).map((x) => (x.status === 'fulfilled' ? x.value : false));
        // Delivered somewhere, or nowhere set up: these are done. Every channel tried failed: try again next time.
        if (rs.includes(true) || !rs.includes(false)) {
          const t = today();
          for (const x of news) for (const id of x.rules) sent[markOf(x, id)] = x.date;
          const keep = Object.entries(sent).filter(([, date]) => date >= t).sort((a, b) => b[1].localeCompare(a[1])).slice(0, MAX_SENT);
          await kv.set(KEYS.sent, Object.fromEntries(keep), { ex: 400 * 86400 });
          return { matched: found.length, sent: news.length, delivered: rs.includes(true) };
        }
        return { matched: found.length, sent: 0, retry: true };
      } catch (e) {
        console.error('dealrules', e.message);
        return { error: e.message };
      }
    },
  };
}

module.exports = { createDealRules, cleanRule, ruleLabel, matches, matchGroups, DealRuleError, MAX_RULES };
