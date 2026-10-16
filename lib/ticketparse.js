// 貼上確認信 (我的行程): the owner pastes an e-ticket or a booking e-mail and a small model lists its flights as legs.
// Same providers and keys as 一句話搜尋 (lib/nlsearch.js pickProvider). Only the pasted text and today's date are sent;
// nothing is stored or cached, because the text can hold names and ticket numbers. Owner only (the passcode), with
// its own daily cap. The reply is checked field by field here; anything that fails is left out and named in `dropped`.
// The model calls are small copies of nlsearch.js's, which are built around a one-sentence user message.

const { addDays, validDate } = require('./day');
const { NlError, MODEL, OPENAI_MODEL } = require('./nlsearch');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MAX_CHARS = 6000;
const MAX_LEGS = 12;
const CABINS = ['Y', 'W', 'J', 'F'];

function buildPrompt(programs) {
  return `You read an airline e-ticket, itinerary receipt or booking confirmation that a Taiwanese traveller pasted (any language, often Traditional Chinese or English) and list every flight segment in it. Reply only with the JSON the schema asks for. Never invent anything: a field the text does not state is null.

Each leg:
- date: the local departure date, YYYY-MM-DD. If the year is missing, the next such date on or after today's date in the message.
- from, to: IATA airport codes (three capital letters) of the departure and arrival airports.
- flight: carrier code and number, like BR198.
- dep, arr: local departure and arrival times, HH:MM, 24-hour.
- arr_day_offset: how many days after the departure date the flight arrives (0, 1 or 2).
- cabin: Y economy, W premium economy, J business, F first.
- pnr: the booking reference (訂位代號, 5 to 8 letters or digits). Not the 13-digit ticket number.
Whole booking:
- award: true when it was paid with miles or points (酬賓機票, 獎勵機票, award, redemption); false when it is a paid fare; else null.
- program: the mileage program that issued an award ticket, by id from the list below; else null.
- miles_per_person: miles taken per traveller, if stated; else null.
- ticketed_on: the ticket's issue date (開票日, date of issue), if stated; else null.
- passengers: how many travellers are on it, if stated; else null.

Programs (id: name):
${programs.map((p) => `${p.id}: ${p.name}`).join('\n')}`;
}

function buildSchema(programs) {
  const nullable = (s) => ({ anyOf: [s, { type: 'null' }] });
  const str = { type: 'string' };
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      legs: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: { date: str, from: str, to: str, flight: str, dep: nullable(str), arr: nullable(str), arr_day_offset: nullable({ type: 'integer' }), cabin: nullable({ type: 'string', enum: CABINS }), pnr: nullable(str) },
          required: ['date', 'from', 'to', 'flight', 'dep', 'arr', 'arr_day_offset', 'cabin', 'pnr'],
        },
      },
      award: nullable({ type: 'boolean' }),
      program: nullable({ type: 'string', enum: programs.map((p) => p.id) }),
      miles_per_person: nullable({ type: 'integer' }),
      ticketed_on: nullable(str),
      passengers: nullable({ type: 'integer' }),
    },
    required: ['legs', 'award', 'program', 'miles_per_person', 'ticketed_on', 'passengers'],
  };
}

const userMessage = (text, today) => `今天是 ${today}（台灣時間）。以下是貼上的確認信：\n${text}`;

async function askClaude(client, { system, schema, user, timeoutMs }) {
  let res;
  try {
    res = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      thinking: { type: 'disabled' },
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: user }],
    }, { timeout: timeoutMs });
  } catch (e) {
    console.error('ticketparse', e?.constructor?.name, e?.status ?? '');
    throw new NlError(e?.status === 401 ? 'ANTHROPIC_API_KEY 無效或已停用，請到 Vercel 檢查' : '讀取服務暫時無法使用，請稍後再試', e?.status === 401 ? 503 : 502);
  }
  if (res.stop_reason === 'refusal') throw new NlError('這段文字無法讀取', 422);
  if (res.stop_reason === 'max_tokens') throw new NlError('內容太長，請只貼航班那一段', 502);
  try { return JSON.parse((res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')); } catch { throw new NlError('讀取結果格式不對，請再試一次', 502); }
}

async function askOpenAI({ apiKey, fetchImpl, system, schema, user, timeoutMs }) {
  let res;
  let data = null;
  try {
    res = await fetchImpl(OPENAI_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        response_format: { type: 'json_schema', json_schema: { name: 'ticket_legs', strict: true, schema } },
        reasoning_effort: 'none',
        max_completion_tokens: 2048,
        store: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    data = await res.json().catch(() => null);
  } catch (e) {
    console.error('ticketparse openai', e?.name || 'error');
    const late = e?.name === 'AbortError' || e?.name === 'TimeoutError';
    throw new NlError(late ? '讀取逾時，請再試一次' : '連不上讀取服務，請稍後再試', late ? 504 : 502);
  }
  if (!res.ok) {
    console.error('ticketparse openai', res.status, data?.error?.code || '');
    throw new NlError(res.status === 401 ? 'OPENAI_API_KEY 無效或已停用，請到 Vercel 檢查' : res.status === 429 && data?.error?.code === 'insufficient_quota' ? 'OpenAI 帳號餘額不足' : '讀取服務暫時無法使用，請稍後再試', res.status === 401 || res.status === 429 ? 503 : 502);
  }
  const choice = data?.choices?.[0];
  if (choice?.message?.refusal) throw new NlError('這段文字無法讀取', 422);
  if (choice?.finish_reason === 'length') throw new NlError('內容太長，請只貼航班那一段', 502);
  try { return JSON.parse(choice.message.content); } catch { throw new NlError('讀取結果格式不對，請再試一次', 502); }
}

// The model's (or the demo parser's) answer → legs in 我的行程's shape (public/features.js cleanLeg).
function validateTicket(raw, { today, airportOk, programIds = [] }) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const dropped = [];
  const time = (v) => (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : null);
  const award = r.award === true;
  const program = typeof r.program === 'string' && programIds.includes(r.program) ? r.program : '';
  const miles = Number.isInteger(r.miles_per_person) && r.miles_per_person > 0 && r.miles_per_person < 1e6 ? r.miles_per_person : null;
  const pax = Number.isInteger(r.passengers) && r.passengers >= 1 && r.passengers <= 9 ? r.passengers : 1;
  const ticketedOn = validDate(r.ticketed_on) && r.ticketed_on <= addDays(today, 1) ? r.ticketed_on : null;
  const legs = [];
  for (const [i, l] of (Array.isArray(r.legs) ? r.legs : []).slice(0, MAX_LEGS * 2).entries()) {
    const o = l && typeof l === 'object' ? l : {};
    const from = String(o.from ?? '').trim().toUpperCase();
    const to = String(o.to ?? '').trim().toUpperCase();
    const flight = String(o.flight ?? '').toUpperCase().replace(/\s+/g, '');
    const bad = [];
    if (!validDate(o.date) || o.date < addDays(today, -1) || o.date > addDays(today, 400)) bad.push('日期');
    if (!/^[A-Z]{3}$/.test(from) || !airportOk(from)) bad.push('出發機場');
    if (!/^[A-Z]{3}$/.test(to) || !airportOk(to) || to === from) bad.push('抵達機場');
    if (!/^[A-Z0-9]{2}\d{1,4}[A-Z]?$/.test(flight)) bad.push('航班號碼');
    if (bad.length) { dropped.push(`第 ${i + 1} 段（${bad.join('、')}）`); continue; }
    const arrDays = Number.isInteger(o.arr_day_offset) && o.arr_day_offset >= 0 && o.arr_day_offset <= 2 ? o.arr_day_offset : 0;
    const pnr = typeof o.pnr === 'string' && /^[A-Z0-9]{5,8}$/.test(o.pnr.trim().toUpperCase()) ? o.pnr.trim().toUpperCase() : '';
    legs.push({
      k: award ? 'a' : 'c', date: o.date, from, to, flights: `${flight.slice(0, 2)} ${flight.slice(2)}`, cabin: CABINS.includes(o.cabin) ? o.cabin : 'Y', pax,
      miles: award ? miles : null, program: award ? program : '', price: null, note: award ? '' : '確認信',
      dep: time(o.dep), arr: time(o.arr), arrDays, pnr, ...(ticketedOn ? { status: 'ticketed', ticketedOn } : {}),
    });
  }
  legs.sort((a, b) => (a.date + (a.dep || '')).localeCompare(b.date + (b.dep || '')));
  return { legs: legs.slice(0, MAX_LEGS), dropped, award, ticketedOn };
}

// ---------- demo only ----------
// DEMO-ONLY rule-based reader for screenshots when there is no model key: every line with a flight number becomes a leg
// (its first date, first two airport codes and first two times). The live site always uses the model.
const NOT_AIRPORTS = new Set(['PNR', 'THE', 'AND', 'TWD', 'USD', 'NTD', 'CAB', 'ECO', 'BUS', 'ETK', 'REF', 'DEP', 'ARR']);
function mockTicket(text, today) {
  const y0 = Number(today.slice(0, 4));
  const pad = (n) => String(n).padStart(2, '0');
  const legs = [];
  const pnr = (/(?:訂位代號|PNR|Booking (?:ref(?:erence)?|code))[^A-Z0-9]{0,6}([A-Z0-9]{6})/i.exec(text) || [])[1] || null;
  for (const line of String(text).split(/\n/)) {
    const f = /\b([A-Z][A-Z0-9]|[0-9][A-Z])\s?(\d{1,4})\b/.exec(line);
    if (!f) continue;
    const codes = [...line.matchAll(/\b[A-Z]{3}\b/g)].map((m) => m[0]).filter((c) => !NOT_AIRPORTS.has(c));
    let date = null;
    const d1 = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(line);
    const d2 = /(\d{1,2})月(\d{1,2})日/.exec(line);
    if (d1) date = `${d1[1]}-${pad(d1[2])}-${pad(d1[3])}`;
    else if (d2) { const md = `${pad(d2[1])}-${pad(d2[2])}`; date = `${`${y0}-${md}` >= today ? y0 : y0 + 1}-${md}`; }
    const times = [...line.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g)].map((m) => `${pad(m[1])}:${m[2]}`);
    if (!date || codes.length < 2) continue;
    legs.push({ date, from: codes[0], to: codes[1], flight: `${f[1]}${f[2]}`, dep: times[0] || null, arr: times[1] || null, arr_day_offset: /\+1/.test(line) ? 1 : 0, cabin: /商務|business/i.test(line) ? 'J' : /頭等|first/i.test(line) ? 'F' : /豪華經濟|premium/i.test(line) ? 'W' : /經濟|economy/i.test(line) ? 'Y' : null, pnr });
  }
  const award = /酬賓|獎勵|哩程|award|redemption/i.test(text) ? true : null;
  const issue = /(?:開票日|issue date|date of issue)[^\d]{0,6}(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/i.exec(text);
  return { legs, award, program: /長榮|EVA/i.test(text) && award ? 'eva' : /華航|China Airlines/i.test(text) && award ? 'ci' : null, miles_per_person: null, ticketed_on: issue ? `${issue[1]}-${pad(issue[2])}-${pad(issue[3])}` : null, passengers: null };
}

// mode: 'live' (provider 'anthropic' or 'openai'), 'mock' (demo reader) or 'off'. `client` and `fetchImpl` are for tests.
function createTicketParse({ mode = 'off', provider = 'anthropic', apiKey = '', client = null, fetchImpl = (...a) => fetch(...a), kv, today, airportCodes, programs = [], limit = 20, timeoutMs = 20000 }) {
  const programIds = programs.map((p) => p.id);
  const system = buildPrompt(programs);
  const schema = buildSchema(programs);
  let model = client;
  const countKey = (day) => `ticket:v1:count:${day}`;

  async function parse(text) {
    if (mode === 'off') throw new NlError('貼上確認信沒有開啟', 404);
    const body = String(text ?? '').normalize('NFKC').replace(/[ \t]+/g, ' ').trim();
    if (!body) throw new NlError('請先貼上確認信的內容');
    if (body.length > MAX_CHARS) throw new NlError(`內容太長，請只貼航班那一段（${MAX_CHARS} 字以內）`);
    const day = today();
    const used = await kv.incr(countKey(day), 1, 2 * 86400).catch(() => null);
    const giveBack = () => (used != null ? kv.incr(countKey(day), -1).catch(() => {}) : null);
    if (used != null && used > limit) {
      await giveBack();
      throw new NlError(`今天已經讀了 ${limit} 封確認信，明天（台灣時間）再試，或在航班明細按「＋ 加入我的行程」`, 429);
    }
    let raw;
    try {
      if (mode === 'mock') raw = mockTicket(body, day);
      else if (provider === 'openai') raw = await askOpenAI({ apiKey, fetchImpl, system, schema, user: userMessage(body, day), timeoutMs });
      else {
        if (!model) { const Anthropic = require('@anthropic-ai/sdk').default; model = new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 1 }); }
        raw = await askClaude(model, { system, schema, user: userMessage(body, day), timeoutMs });
      }
    } catch (e) {
      await giveBack();
      throw e;
    }
    const out = validateTicket(raw, { today: day, airportOk: (c) => airportCodes.has(c), programIds });
    return { ...out, mock: mode === 'mock', used: used ?? null, limit };
  }

  return { enabled: mode !== 'off', parse };
}

module.exports = { createTicketParse, validateTicket, mockTicket, buildSchema, MAX_CHARS };
