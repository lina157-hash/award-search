// 一句話搜尋: one Chinese sentence → the 航線查詢 form's conditions. A small model reads the sentence (only the sentence,
// today's date and the static lists below are sent; nothing personal), the reply is checked field by field here, and
// the page fills the form with what passed. Nothing here spends seats.aero: the visitor still presses 搜尋機位.
// Two providers, whichever key the owner set (pickProvider): Claude Haiku through the Anthropic SDK (required lazily,
// so the rest of the server never loads it; tests inject a fake client), or OpenAI's GPT-6 Luna over plain fetch.
// Demo mode (no model key, no seats.aero key) uses mockParse below instead of a model.

const { addDays, validDate } = require('./day');
const { hashKey } = require('./kv');

const MODEL = 'claude-haiku-5-5';
const OPENAI_MODEL = 'gpt-6-luna'; // OpenAI's cheapest current model, same price as Haiku 5.5 (US$0.10 / 0.50 per MTok)
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MAX_CHARS = 100;
const MAX_AHEAD_DAYS = 365; // the site's search window (public/app.js MAX_AHEAD_DAYS)
const CACHE_SEC = 86400;
const CABINS = ['Y', 'W', 'J', 'F'];
const ALLIANCES = { star: '星空聯盟', skyteam: '天合聯盟', oneworld: '寰宇一家' };
const REGION_ZH = { Asia: '亞洲', 'North America': '北美', Europe: '歐洲', Oceania: '大洋洲', 'South America': '南美', Africa: '非洲' };

// Taiwan holidays the sentence may name. `re` finds the long weekend in the Taiwan office calendar (lib/travelinfo.js);
// without the calendar, `days` (lunar dates) or `md` gives the day and `pad` the days around it.
const HOLIDAYS = {
  lunar_new_year: { zh: '春節', re: /除夕|春節/, days: { 2026: '2026-02-17', 2027: '2027-02-06', 2028: '2028-01-26' }, pad: [4, 6] },
  peace_memorial: { zh: '228', re: /和平紀念/, md: '02-28', pad: [3, 3] },
  spring_break: { zh: '春假', re: /兒童節|民族掃墓|清明/, md: '04-04', pad: [3, 3] },
  labor_day: { zh: '勞動節', re: /勞動節/, md: '05-01', pad: [3, 3] },
  dragon_boat: { zh: '端午', re: /端午/, days: { 2026: '2026-06-19', 2027: '2027-06-09', 2028: '2028-05-28' }, pad: [3, 3] },
  mid_autumn: { zh: '中秋', re: /中秋/, days: { 2026: '2026-09-25', 2027: '2027-09-15', 2028: '2028-10-03' }, pad: [3, 3] },
  national_day: { zh: '國慶', re: /國慶/, md: '10-10', pad: [3, 3] },
  new_year: { zh: '元旦', re: /開國紀念|元旦/, md: '01-01', pad: [3, 3] },
};

class NlError extends Error {
  constructor(message, status = 400, code) { super(message); this.status = status; this.code = code; }
}

// The sentence as the cache sees it: full-width letters and digits folded, spaces collapsed, closing punctuation dropped.
function normalize(text) {
  return String(text ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().replace(/[。.!！?？~～]+$/, '').trim();
}

// ---------- what the model is told (static, so it can be cached) ----------

function buildPrompt({ groups, programs, regions }) {
  const cities = ['台北: TPE (TSA only when 松山 is named)', '高雄: KHH', '台中: RMQ', ...groups.filter((g) => g.zh !== '台北').map((g) => `${g.zh}: ${g.codes.join(', ')}`)];
  return `You turn one Traditional Chinese sentence (Taiwan wording) that describes an award-flight search into search conditions for a Taiwanese mileage search site. Reply only with the JSON the schema asks for. Never invent a condition the sentence does not state: leave it null or empty.

Fields:
- origin, destination: IATA airport codes (three capital letters), at most 6 each. A city with several airports: its main airports (hints below). A country: its 1-3 main international airports (日本 -> NRT, HND, KIX). Always codes, never place names: a city missing from the hints is still its main airport's code (溫哥華 -> YVR). When only one place is named, it is the destination unless the sentence marks it as the start (從X, X出發). No origin stated -> []. When the destination is only a continent or a broad region (歐洲, 北美, 東南亞), destination is [] and region is set.
- region: one of ${regions.join(', ')}, only when the destination is that broad; else null.
- date_start, date_end (YYYY-MM-DD): the outbound travel window, worked out from today's date in the message. A month is its first to last day, in the month's next occurrence unless a year is given (今年, 明年 = next year, 後年). 下個月 = the next calendar month. One day: the same start and end. 「X號前後」: three days either side. Never before today. No date stated -> null.
- holiday, holiday_year: a Taiwan holiday instead of dates (過年/春節/農曆年 lunar_new_year, 228 peace_memorial, 春假/清明/兒童節 spring_break, 勞動節 labor_day, 端午 dragon_boat, 中秋 mid_autumn, 國慶/雙十 national_day, 元旦/跨年 new_year). The site maps it to dates, so leave date_start and date_end null. holiday_year only when a year is stated or implied (明年 = next year); else null.
- return_start, return_end: only for a round trip (來回) whose return time is stated, same rules; else null.
- cabin: 經濟 Y, 豪經/豪華經濟 W, 商務 J, 頭等 F; else null.
- alliance: 星空聯盟 star, 天合聯盟 skyteam, 寰宇一家 oneworld; else null.
- programs: the mileage programs the sentence names (用 X, 只要 X), by id from the list below; else [].
- passengers: how many people travel, if stated (兩個人 = 2); else null.
- direct_only: true only when 直飛 is asked for; else null.

City hints (name: airports):
${cities.join('\n')}

Programs (id: name):
${programs.map((p) => `${p.id}: ${p.name}`).join('\n')}`;
}

function buildSchema({ programs, regions }) {
  const nullable = (s) => ({ anyOf: [s, { type: 'null' }] });
  const date = nullable({ type: 'string', format: 'date' });
  const codes = { type: 'array', items: { type: 'string' } };
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      origin: codes,
      destination: codes,
      region: nullable({ type: 'string', enum: regions }),
      date_start: date,
      date_end: date,
      holiday: nullable({ type: 'string', enum: Object.keys(HOLIDAYS) }),
      holiday_year: nullable({ type: 'integer' }),
      return_start: date,
      return_end: date,
      cabin: nullable({ type: 'string', enum: CABINS }),
      alliance: nullable({ type: 'string', enum: Object.keys(ALLIANCES) }),
      programs: { type: 'array', items: { type: 'string', enum: programs.map((p) => p.id) } },
      passengers: nullable({ type: 'integer' }),
      direct_only: nullable({ type: 'boolean' }),
    },
    required: ['origin', 'destination', 'region', 'date_start', 'date_end', 'holiday', 'holiday_year', 'return_start', 'return_end', 'cabin', 'alliance', 'programs', 'passengers', 'direct_only'],
  };
}

const DOW = '日一二三四五六';
const userMessage = (sentence, today) => `今天是 ${today}（星期${DOW[new Date(today + 'T00:00:00Z').getUTCDay()]}），台灣時間。\n句子：${sentence}`;

// The Anthropic client, made on first use. The key goes to the SDK only; it is never logged or returned.
function anthropicClient({ apiKey, timeoutMs }) {
  const Anthropic = require('@anthropic-ai/sdk').default;
  return new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 1 });
}

// One model call: structured output (the reply is JSON matching the schema), no thinking, a small token cap.
async function askModel(client, { system, schema, sentence, today, timeoutMs }) {
  let res;
  try {
    res = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      thinking: { type: 'disabled' },
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userMessage(sentence, today) }],
    }, { timeout: timeoutMs });
  } catch (e) {
    throw modelError(e);
  }
  if (res.stop_reason === 'refusal') throw new NlError('這句話無法解析，請換個說法', 422, 'refusal');
  if (res.stop_reason === 'max_tokens') throw new NlError('解析結果不完整，請把句子說短一點再試', 502);
  const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return JSON.parse(text);
  } catch {
    throw new NlError('解析結果格式不對，請再試一次', 502);
  }
}

// The SDK's errors in words the owner can act on. Only the class and status are logged, never the request.
function modelError(e) {
  let Anthropic = null;
  try { Anthropic = require('@anthropic-ai/sdk').default; } catch { /* a fake client in tests */ }
  console.error('nlsearch', e?.constructor?.name, e?.status ?? '');
  if (Anthropic && e instanceof Anthropic.APIConnectionTimeoutError) return new NlError('解析逾時，請再試一次', 504);
  if (Anthropic && e instanceof Anthropic.AuthenticationError) return new NlError('ANTHROPIC_API_KEY 無效或已停用，請到 Vercel 檢查', 503, 'setup');
  if (Anthropic && e instanceof Anthropic.PermissionDeniedError) return new NlError('Anthropic 帳號沒有使用這個模型的權限', 503, 'setup');
  if (Anthropic && e instanceof Anthropic.RateLimitError) return new NlError('解析服務忙碌中，請稍後再試', 503);
  if (Anthropic && e instanceof Anthropic.APIConnectionError) return new NlError('連不上解析服務，請稍後再試', 502);
  if (Anthropic && e instanceof Anthropic.APIError && e.status === 400) return new NlError('解析服務拒絕了這次請求（可能是帳號餘額不足），請到 Anthropic Console 查看', 502);
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') return new NlError('解析逾時，請再試一次', 504);
  return new NlError('解析服務暫時無法使用，請稍後再試', 502);
}

// OpenAI's Chat Completions with a strict JSON schema (the same schema), no reasoning, a small token cap. `store: false`
// keeps the request out of OpenAI's stored completions. The key goes in the header only; it is never logged or returned.
async function askOpenAI({ apiKey, fetchImpl, system, schema, sentence, today, timeoutMs }) {
  let res;
  let data = null;
  try {
    res = await fetchImpl(OPENAI_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [{ role: 'system', content: system }, { role: 'user', content: userMessage(sentence, today) }],
        response_format: { type: 'json_schema', json_schema: { name: 'search_conditions', strict: true, schema } },
        reasoning_effort: 'none',
        max_completion_tokens: 1024,
        store: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    data = await res.json().catch(() => null);
  } catch (e) {
    console.error('nlsearch openai', e?.name || 'error');
    if (e?.name === 'AbortError' || e?.name === 'TimeoutError') throw new NlError('解析逾時，請再試一次', 504);
    throw new NlError('連不上解析服務，請稍後再試', 502);
  }
  if (!res.ok) throw openAIError(res.status, data?.error?.code);
  const choice = data?.choices?.[0];
  if (choice?.message?.refusal || choice?.finish_reason === 'content_filter') throw new NlError('這句話無法解析，請換個說法', 422, 'refusal');
  if (choice?.finish_reason === 'length') throw new NlError('解析結果不完整，請把句子說短一點再試', 502);
  try {
    return JSON.parse(choice.message.content);
  } catch {
    throw new NlError('解析結果格式不對，請再試一次', 502);
  }
}

// OpenAI's HTTP errors in words the owner can act on. Only the status and OpenAI's error code are logged.
function openAIError(status, code) {
  console.error('nlsearch openai', status, code || '');
  if (status === 401) return new NlError('OPENAI_API_KEY 無效或已停用，請到 Vercel 檢查', 503, 'setup');
  if (status === 429 && code === 'insufficient_quota') return new NlError('OpenAI 帳號餘額不足，請到 platform.openai.com 的 Billing 儲值', 503, 'setup');
  if (status === 429) return new NlError('解析服務忙碌中，請稍後再試', 503);
  if (status === 403) return new NlError('OpenAI 帳號沒有使用這個模型的權限', 503, 'setup');
  if (status === 404) return new NlError(`OpenAI 帳號找不到 ${OPENAI_MODEL} 模型`, 503, 'setup');
  if (status === 400) return new NlError('解析服務拒絕了這次請求，請稍後再試', 502);
  return new NlError('解析服務暫時無法使用，請稍後再試', 502);
}

// Which model the server uses, from its environment: NL_PROVIDER (openai / claude) when that key is set, else whichever
// key is set (both: OpenAI), else the demo parser on a demo site, else off. Returns no key text beyond what it was given.
function pickProvider(env, demo) {
  const keys = { openai: (env.OPENAI_API_KEY || '').trim(), anthropic: (env.ANTHROPIC_API_KEY || '').trim() };
  const want = { openai: 'openai', chatgpt: 'openai', claude: 'anthropic', anthropic: 'anthropic' }[String(env.NL_PROVIDER || '').trim().toLowerCase()];
  const provider = want && keys[want] ? want : keys.openai ? 'openai' : keys.anthropic ? 'anthropic' : null;
  if (provider) return { mode: 'live', provider, apiKey: keys[provider] };
  return { mode: demo ? 'mock' : 'off', provider: null, apiKey: '' };
}

// ---------- holidays → dates ----------

// The holiday's window: the long weekend in the Taiwan office calendar (`taiwan`, lib/travelinfo.js) with three days
// either side, or the built-in day when the calendar is out of reach. `year` null: the next one not yet over.
async function holidayRange(id, year, { today, taiwan }) {
  const h = HOLIDAYS[id];
  if (!h) return null;
  const y0 = Number(today.slice(0, 4));
  const years = Number.isInteger(year) ? [year] : [y0, y0 + 1];
  for (const y of years) {
    let r = null;
    if (taiwan) {
      try {
        const { longWeekends = [] } = await taiwan(`${y}-01-01`, `${y}-12-31`);
        const lw = longWeekends.find((w) => h.re.test(w.name) && (w.start.startsWith(String(y)) || w.end.startsWith(String(y))));
        if (lw) r = [addDays(lw.start, -3), addDays(lw.end, 3)];
      } catch { /* calendar unreachable: the built-in day below */ }
    }
    if (!r) {
      const day = h.days?.[y] || (h.md && `${y}-${h.md}`);
      if (day) r = [addDays(day, -h.pad[0]), addDays(day, h.pad[1])];
    }
    if (r && r[1] >= today) return { start: r[0], end: r[1], label: `${y} ${h.zh}連假前後` };
  }
  return null;
}

// ---------- checking what came back ----------

// Place names → airports, from the site's own airport list: city groups first (台北 → TPE only, as the prompt says;
// otherwise the group's main airports), then each airport's Chinese name with and without its （…） qualifier, then
// English city names. A name shared by several airports maps to the main ones, or to nothing when none is main or
// they are in different countries.
// `codes(name)`: a place name the model returned instead of a code. `find(sentence)`: the Chinese place names the
// sentence itself contains, longest first, without overlaps, in sentence order.
function buildPlaces(groups = [], airports = []) {
  const main = new Map(airports.map((a) => [a[0], a[5] === 1]));
  const byName = new Map();
  const set = (name, codes) => {
    const k = String(name ?? '').trim().toLowerCase();
    if (k.length >= 2 && codes.length && !byName.has(k)) byName.set(k, codes.slice(0, 6));
  };
  for (const g of groups) {
    const top = g.codes.filter((c) => main.get(c));
    const codes = g.zh === '台北' ? ['TPE'] : top.length ? top : g.codes;
    set(g.zh, codes);
    set(g.en, codes);
  }
  const shared = new Map();
  const note = (name, a) => {
    const k = String(name ?? '').trim().toLowerCase();
    if (k) shared.set(k, [...(shared.get(k) || []), a]);
  };
  for (const a of airports) {
    if (a[6]) {
      note(a[6], a);
      if (/（.+）$/.test(a[6])) note(a[6].replace(/（.+）$/, ''), a);
    }
    note(a[1], a);
  }
  for (const [k, list] of shared) {
    const top = list.filter((a) => a[5] === 1);
    if (new Set(list.map((a) => a[3])).size > 1) continue; // 奧克蘭: Auckland or Oakland, so neither
    if (list.length === 1 || top.length) set(k, (list.length === 1 ? list : top).map((a) => a[0]).slice(0, 3));
  }
  const zhNames = [...byName.keys()].filter((k) => /[\u4e00-\u9fff]/.test(k)).sort((a, b) => b.length - a.length);
  return {
    codes: (name) => byName.get(String(name ?? '').trim().toLowerCase()) || null,
    find(sentence) {
      const hits = [];
      for (const name of zhNames) {
        for (let i = sentence.indexOf(name); i >= 0; i = sentence.indexOf(name, i + name.length)) {
          if (!hits.some((h) => i < h.i + h.name.length && h.i < i + name.length)) hits.push({ i, name, codes: byName.get(name) });
        }
      }
      return hits.sort((a, b) => a.i - b.i);
    },
  };
}

// The model's (or the demo parser's) answer, field by field. Anything that fails a check is left out and named in
// `dropped`, so the visitor fills it in; nothing unchecked reaches the page.
function validate(raw, { today, airportOk, programIds, regions, holiday = null, sentence = '', places = null }) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const maxDay = addDays(today, MAX_AHEAD_DAYS);
  const dropped = [];
  const short = (v) => String(v ?? '').slice(0, 12);
  const codes = (v, label) => {
    if (!Array.isArray(v)) return [];
    const good = [];
    const bad = [];
    for (const c of v.slice(0, 10)) {
      const s = String(c ?? '').trim().toUpperCase();
      const named = /^[A-Z]{3}$/.test(s) && airportOk(s) ? [s] : (places?.codes(String(c ?? '')) || []).filter(airportOk);
      if (named.length) good.push(...named);
      else bad.push(s);
    }
    if (bad.length) dropped.push(`${label}「${bad.map(short).join('、')}」`);
    return [...new Set(good)].slice(0, 6);
  };
  const range = (s, e, label) => {
    if (s == null && e == null) return null;
    if (s == null) s = e;
    if (e == null) e = s;
    if (!validDate(s) || !validDate(e)) { dropped.push(label); return null; }
    if (e < s) [s, e] = [e, s];
    if (e < today || s > maxDay) { dropped.push(`${label}（已經過了或超過一年）`); return null; }
    return [s < today ? today : s, e > maxDay ? maxDay : e];
  };

  const out = { origin: codes(r.origin, '出發機場'), destination: codes(r.destination, '目的地機場'), region: null, start: null, end: null, dateLabel: '', returnStart: null, returnEnd: null, cabin: null, alliance: null, programs: [], pax: null, direct: null, defaults: [], dropped };
  if (r.region != null) {
    if (regions.includes(r.region)) out.region = r.region;
    else dropped.push(`區域「${short(r.region)}」`);
  }
  // A named holiday wins over dates; one the calendar could not place is left for the visitor.
  if (r.holiday != null && !holiday) dropped.push('節日');
  const hol = holiday ? range(holiday.start, holiday.end, '節日日期') : null;
  const go = hol || (holiday ? null : range(r.date_start, r.date_end, '出發日期'));
  if (go) {
    [out.start, out.end] = go;
    if (hol) out.dateLabel = holiday.label;
  }
  const back = range(r.return_start, r.return_end, '回程日期');
  if (back && go && back[1] < go[0]) dropped.push('回程日期（早於出發）');
  else if (back) [out.returnStart, out.returnEnd] = [go && back[0] < go[0] ? go[0] : back[0], back[1]];
  if (r.cabin != null) {
    if (CABINS.includes(r.cabin)) out.cabin = r.cabin;
    else dropped.push('艙等');
  }
  if (r.alliance != null) {
    if (ALLIANCES[r.alliance]) out.alliance = r.alliance;
    else dropped.push('航空聯盟');
  }
  if (Array.isArray(r.programs)) {
    const bad = r.programs.filter((p) => !programIds.includes(p));
    if (bad.length) dropped.push(`哩程計畫「${bad.map(short).join('、')}」`);
    out.programs = [...new Set(r.programs.filter((p) => programIds.includes(p)))].slice(0, 5);
  }
  if (r.passengers != null) {
    if (Number.isInteger(r.passengers) && r.passengers >= 1 && r.passengers <= 9) out.pax = r.passengers;
    else dropped.push('人數（1 到 9 位）');
  }
  if (r.direct_only === true) out.direct = true;
  // No destination came back (a city the model left out, or put as the origin): the last place the sentence names
  // that it does not mark as the start (從X, X出發), from the site's airport list.
  if (!out.destination.length && places && sentence) {
    const start = (h) => sentence.slice(0, h.i).endsWith('從') || sentence.slice(h.i + h.name.length).startsWith('出發');
    const to = places.find(sentence).filter((h) => !start(h)).pop();
    const codes = to ? to.codes.filter(airportOk) : [];
    if (codes.length) {
      out.destination = codes;
      out.origin = out.origin.filter((c) => !codes.includes(c));
      out.dropped = dropped.filter((d) => !d.startsWith('目的地機場')); // nothing is added to `dropped` after this
    }
  }
  // Unspecified origin on a Taiwanese site: Taipei, marked as a default so the page can say so.
  if (out.destination.length && !out.origin.length && !dropped.some((d) => d.startsWith('出發機場'))) {
    out.origin = ['TPE'];
    out.defaults.push('origin');
  }
  if (!out.destination.length) {
    const zh = REGION_ZH[out.region];
    out.vague = true;
    out.message = zh
      ? `「${zh}」的範圍比較大：可以改用「區域探索」看整個${zh}還有哪些位子，或在句子裡加上一個城市或機場（例如「${zh === '歐洲' ? '倫敦' : zh === '北美' ? '溫哥華' : '東京'}」）。`
      : '看不出要飛去哪裡。請在句子裡加上目的地的城市或機場，例如「台北飛東京」。';
  }
  return out;
}

// ---------- demo only ----------
// DEMO-ONLY rule-based parser, used when there is no model key and the site runs on demo data. It knows a
// handful of cities and phrases, enough to preview the feature and take screenshots; the live site always uses Claude.
const MOCK_CITIES = [
  ['台北', ['TPE']], ['臺北', ['TPE']], ['桃園', ['TPE']], ['松山', ['TSA']], ['高雄', ['KHH']], ['台中', ['RMQ']],
  ['東京', ['NRT', 'HND']], ['成田', ['NRT']], ['羽田', ['HND']], ['大阪', ['KIX']], ['京都', ['KIX']], ['札幌', ['CTS']], ['福岡', ['FUK']], ['沖繩', ['OKA']], ['日本', ['NRT', 'HND', 'KIX']],
  ['首爾', ['ICN', 'GMP']], ['香港', ['HKG']], ['澳門', ['MFM']], ['曼谷', ['BKK']], ['新加坡', ['SIN']], ['吉隆坡', ['KUL']], ['峇里島', ['DPS']],
  ['倫敦', ['LHR', 'LGW']], ['巴黎', ['CDG']], ['阿姆斯特丹', ['AMS']], ['法蘭克福', ['FRA']], ['慕尼黑', ['MUC']], ['伊斯坦堡', ['IST']], ['杜拜', ['DXB']],
  ['紐約', ['JFK', 'EWR']], ['舊金山', ['SFO', 'SJC', 'OAK']], ['洛杉磯', ['LAX']], ['西雅圖', ['SEA']], ['芝加哥', ['ORD']], ['溫哥華', ['YVR']], ['多倫多', ['YYZ']], ['夏威夷', ['HNL']],
  ['雪梨', ['SYD']], ['墨爾本', ['MEL']], ['布里斯本', ['BNE']], ['奧克蘭', ['AKL']],
];
const MOCK_REGIONS = [['歐洲', 'Europe'], ['北美', 'North America'], ['美國', 'North America'], ['加拿大', 'North America'], ['南美', 'South America'], ['非洲', 'Africa'], ['澳洲', 'Oceania'], ['紐西蘭', 'Oceania'], ['大洋洲', 'Oceania'], ['東南亞', 'Asia'], ['亞洲', 'Asia']];
const MOCK_PROGRAMS = [[/亞洲萬里通|亞萬|asia ?miles/i, 'asiamiles'], [/aeroplan/i, 'aeroplan'], [/聯合|united/i, 'united'], [/阿拉斯加|alaska/i, 'alaska'], [/flying ?blue|飛行藍/i, 'flyingblue'], [/krisflyer|新航/i, 'singapore'], [/avios|英航/i, 'british'], [/aadvantage|美航/i, 'american'], [/達美|delta/i, 'delta'], [/土航|turkish/i, 'turkish'], [/卡達|qatar/i, 'qatar'], [/阿聯酋|emirates/i, 'emirates'], [/lifemiles/i, 'lifemiles'], [/漢莎|miles ?& ?more/i, 'lufthansa'], [/澳航|qantas/i, 'qantas']];
const MOCK_HOLIDAYS = [[/過年|春節|農曆年/, 'lunar_new_year'], [/春假|清明|兒童節/, 'spring_break'], [/端午/, 'dragon_boat'], [/中秋/, 'mid_autumn'], [/國慶|雙十/, 'national_day'], [/元旦|跨年/, 'new_year'], [/勞動節/, 'labor_day'], [/228|和平紀念/, 'peace_memorial']];
const ZH_NUM = { 一: 1, 兩: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };
const num = (s) => (/^\d+$/.test(s) ? Number(s) : ZH_NUM[s] ?? null);
const monthEnd = (y, m) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
const pad2 = (n) => String(n).padStart(2, '0');

function mockParse(sentence, today) {
  const s = sentence;
  const y0 = Number(today.slice(0, 4));
  const m0 = Number(today.slice(5, 7));
  const out = { origin: [], destination: [], region: null, date_start: null, date_end: null, holiday: null, holiday_year: null, return_start: null, return_end: null, cabin: null, alliance: null, programs: [], passengers: null, direct_only: null };

  // Cities in the order they appear; 「X出發」 or 「從X」 marks the origin, else the first of two is the origin.
  const hits = [];
  for (const [name, codes] of MOCK_CITIES) for (let i = s.indexOf(name); i >= 0; i = s.indexOf(name, i + name.length)) hits.push({ i, name, codes });
  for (const m of s.matchAll(/\b[A-Z]{3}\b/g)) hits.push({ i: m.index, name: m[0], codes: [m[0]] });
  hits.sort((a, b) => a.i - b.i || b.name.length - a.name.length);
  const cities = hits.filter((h, k) => !hits.slice(0, k).some((p) => h.i < p.i + p.name.length));
  const from = cities.find((c) => s.slice(c.i + c.name.length).startsWith('出發') || s.slice(Math.max(0, c.i - 1), c.i) === '從');
  const rest = cities.filter((c) => c !== from);
  if (from) out.origin = from.codes;
  else if (rest.length >= 2) out.origin = rest.shift().codes;
  if (rest.length) out.destination = rest[0].codes;
  if (!out.destination.length) out.region = MOCK_REGIONS.find(([w]) => s.includes(w))?.[1] || null;

  // Months: 「明年五月」, 「十二月」, 「七月去八月回」; 「下個月」.
  const months = [...s.matchAll(/(明年|今年|後年)?(\d{1,2}|十[一二]?|[一二三四五六七八九])月/g)].map((m) => {
    const mo = num(m[2]);
    if (!(mo >= 1 && mo <= 12)) return null;
    const y = m[1] === '明年' ? y0 + 1 : m[1] === '後年' ? y0 + 2 : m[1] === '今年' ? y0 : mo >= m0 ? y0 : y0 + 1;
    return [`${y}-${pad2(mo)}-01`, monthEnd(y, mo)];
  }).filter(Boolean);
  if (/下個?月/.test(s)) {
    const y = m0 === 12 ? y0 + 1 : y0;
    const mo = m0 === 12 ? 1 : m0 + 1;
    months.unshift([`${y}-${pad2(mo)}-01`, monthEnd(y, mo)]);
  }
  const hol = MOCK_HOLIDAYS.find(([re]) => re.test(s));
  if (hol) {
    out.holiday = hol[1];
    out.holiday_year = /明年/.test(s) ? y0 + 1 : null;
  } else if (months[0]) [out.date_start, out.date_end] = months[0];
  if (/來回/.test(s) && months[hol ? 0 : 1]) [out.return_start, out.return_end] = months[hol ? 0 : 1];

  out.cabin = /頭等/.test(s) ? 'F' : /商務/.test(s) ? 'J' : /豪經|豪華經濟/.test(s) ? 'W' : /經濟/.test(s) ? 'Y' : null;
  out.alliance = /寰宇一家|oneworld/i.test(s) ? 'oneworld' : /星空/.test(s) ? 'star' : /天合/.test(s) ? 'skyteam' : null;
  out.programs = MOCK_PROGRAMS.filter(([re]) => re.test(s)).map(([, id]) => id);
  const pax = s.match(/([1-9一兩二三四五六七八九])\s*(?:個人|個大人|位|人)/);
  if (pax) out.passengers = num(pax[1]);
  if (/直飛/.test(s)) out.direct_only = true;
  return out;
}

// ---------- the service ----------

// mode: 'live' (a model: provider 'anthropic' or 'openai'), 'mock' (demo parser) or 'off'. `taiwan`: lib/travelinfo.js's
// Taiwan calendar lookup. `client` (Anthropic) and `fetchImpl` (OpenAI) are for tests.
function createNlSearch({ mode = 'off', provider = 'anthropic', apiKey = '', client = null, fetchImpl = (...a) => fetch(...a), kv, today, taiwan = null, airportCodes, groups = [], programs = [], regions = Object.keys(REGION_ZH), limit = 100, timeoutMs = 15000, airports = [] }) {
  const programIds = programs.map((p) => p.id);
  const places = buildPlaces(groups, airports);
  const system = buildPrompt({ groups, programs, regions });
  const schema = buildSchema({ programs, regions });
  let model = client;
  const countKey = (day) => `nl:v1:count:${day}`;

  async function usage() {
    const day = today();
    return { used: Number(await kv.get(countKey(day)).catch(() => 0)) || 0, limit };
  }

  async function parse(text) {
    if (mode === 'off') throw new NlError('一句話搜尋沒有開啟', 404);
    const sentence = normalize(text);
    if (!sentence) throw new NlError('請先輸入一句話');
    if (sentence.length > MAX_CHARS) throw new NlError(`句子太長，請精簡到 ${MAX_CHARS} 字以內`);
    const day = today();
    // The same sentence on the same Taiwan day: the answer from earlier, free (relative dates depend on the day).
    const cacheKey = `nl:v2:q:${hashKey(`${mode === 'live' ? provider : mode}|${day}|${sentence}`)}`;
    const hit = await kv.get(cacheKey).catch(() => null);
    if (hit) return { ...hit, cached: true, ...(await usage()) };
    const used = await kv.incr(countKey(day), 1, 2 * 86400).catch(() => null);
    if (used != null && used > limit) {
      await kv.incr(countKey(day), -1).catch(() => {});
      throw new NlError(`今天的一句話搜尋已經用了 ${limit} 次，明天（台灣時間）再試，或直接填下面的表單`, 429, 'nl-limit');
    }
    let raw;
    if (mode === 'mock') raw = mockParse(sentence, day);
    else if (provider === 'openai') raw = await askOpenAI({ apiKey, fetchImpl, system, schema, sentence, today: day, timeoutMs });
    else {
      model ||= anthropicClient({ apiKey, timeoutMs });
      raw = await askModel(model, { system, schema, sentence, today: day, timeoutMs });
    }
    const holiday = raw?.holiday ? await holidayRange(raw.holiday, raw.holiday_year, { today: day, taiwan }) : null;
    const result = { ...validate(raw, { today: day, airportOk: (c) => airportCodes.has(c), programIds, regions, holiday, sentence, places }), mock: mode === 'mock' };
    await kv.set(cacheKey, result, { ex: CACHE_SEC }).catch(() => {});
    return { ...result, cached: false, used: used ?? 0, limit };
  }

  return { enabled: mode !== 'off', mode, provider: mode === 'live' ? provider : null, parse, usage, system, schema };
}

module.exports = { createNlSearch, pickProvider, buildPlaces, validate, mockParse, holidayRange, normalize, buildPrompt, buildSchema, NlError, MODEL, OPENAI_MODEL, HOLIDAYS };
