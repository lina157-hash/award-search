// 一句話搜尋 (lib/nlsearch.js): the model's answer checked field by field, holidays to dates, the demo parser on the
// design doc's examples, the daily cap, the one-day cache and the request sent to Claude (a fake client: no network).
const { test } = require('node:test');
const assert = require('node:assert');
const { createNlSearch, validate, mockParse, holidayRange, normalize, MODEL } = require('../lib/nlsearch');
const { memoryKv } = require('../lib/kv');
const AIRPORTS = require('../public/airports.min.json');
const names = require('../data/source-names.json').names;

const TODAY = '2026-10-15';
const codes = new Set(AIRPORTS.airports.map((a) => a[0]));
const programs = Object.entries(names).filter(([id]) => !id.endsWith('_est')).map(([id, name]) => ({ id, name }));
const ctx = { today: TODAY, airportOk: (c) => codes.has(c), programIds: programs.map((p) => p.id), regions: ['Asia', 'North America', 'Europe', 'Oceania', 'South America', 'Africa'] };
const EMPTY = { origin: [], destination: [], region: null, date_start: null, date_end: null, holiday: null, holiday_year: null, return_start: null, return_end: null, cabin: null, alliance: null, programs: [], passengers: null, direct_only: null };
const answer = (o) => ({ ...EMPTY, ...o });

// A stand-in for the Anthropic client: records each request and answers with `reply` (JSON text) or throws it.
function fakeClient(reply) {
  const calls = [];
  return {
    calls,
    messages: {
      async create(params, opts) {
        calls.push({ params, opts });
        const r = typeof reply === 'function' ? reply(params) : reply;
        if (r instanceof Error) throw r;
        return { stop_reason: r.stop_reason || 'end_turn', content: [{ type: 'text', text: typeof r.text === 'string' ? r.text : JSON.stringify(r) }] };
      },
    },
  };
}
const service = (o = {}) => createNlSearch({ mode: 'live', kv: memoryKv(), today: () => TODAY, airportCodes: codes, groups: AIRPORTS.groups, programs, limit: 100, ...o });

test('validate: good fields pass through', () => {
  const r = validate(answer({ origin: ['tpe'], destination: ['NRT', 'HND'], date_start: '2026-12-01', date_end: '2026-12-31', return_start: '2027-01-05', return_end: '2027-01-10', cabin: 'J', alliance: 'oneworld', programs: ['asiamiles', 'aeroplan'], passengers: 2, direct_only: true }), ctx);
  assert.deepEqual(r.origin, ['TPE']);
  assert.deepEqual(r.destination, ['NRT', 'HND']);
  assert.deepEqual([r.start, r.end, r.returnStart, r.returnEnd], ['2026-12-01', '2026-12-31', '2027-01-05', '2027-01-10']);
  assert.equal(r.cabin, 'J');
  assert.equal(r.alliance, 'oneworld');
  assert.deepEqual(r.programs, ['asiamiles', 'aeroplan']);
  assert.equal(r.pax, 2);
  assert.equal(r.direct, true);
  assert.deepEqual(r.dropped, []);
  assert.equal(r.vague, undefined);
});

test('validate: bad fields are dropped and named, the rest kept', () => {
  const r = validate(answer({ origin: ['TPE', 'XQZ'], destination: ['KIX', 'Osaka'], cabin: 'Z', alliance: 'moon', programs: ['bogus', 'united'], passengers: 12, region: 'Mars', date_start: '2026-02-30', direct_only: 'yes' }), ctx);
  assert.deepEqual(r.origin, ['TPE']);
  assert.deepEqual(r.destination, ['KIX']);
  assert.equal(r.cabin, null);
  assert.equal(r.alliance, null);
  assert.deepEqual(r.programs, ['united']);
  assert.equal(r.pax, null);
  assert.equal(r.region, null);
  assert.equal(r.start, null);
  assert.equal(r.direct, null);
  for (const w of ['出發機場「XQZ」', '目的地機場「OSAKA」', '艙等', '航空聯盟', '哩程計畫「bogus」', '人數（1 到 9 位）', '區域「Mars」', '出發日期']) assert.ok(r.dropped.includes(w), w);
  for (const p of [0, 2.5, '2', 10]) assert.equal(validate(answer({ destination: ['KIX'], passengers: p }), ctx).pax, null);
  assert.equal(validate(answer({ destination: ['KIX'], passengers: 9 }), ctx).pax, 9);
});

test('validate: dates stay inside today to a year ahead', () => {
  const past = validate(answer({ destination: ['KIX'], date_start: '2026-09-01', date_end: '2026-09-30' }), ctx);
  assert.equal(past.start, null);
  assert.ok(past.dropped.includes('出發日期（已經過了或超過一年）'));
  const far = validate(answer({ destination: ['KIX'], date_start: '2027-11-01', date_end: '2027-11-30' }), ctx);
  assert.equal(far.start, null);
  // Partly past or partly too far: cut to the window.
  const clip = validate(answer({ destination: ['KIX'], date_start: '2026-10-01', date_end: '2027-12-31' }), ctx);
  assert.deepEqual([clip.start, clip.end], ['2026-10-15', '2027-10-15']);
  // Reversed, or only one end given.
  assert.deepEqual(['start', 'end'].map((k) => validate(answer({ destination: ['KIX'], date_start: '2026-12-10', date_end: '2026-12-01' }), ctx)[k]), ['2026-12-01', '2026-12-10']);
  assert.deepEqual(['start', 'end'].map((k) => validate(answer({ destination: ['KIX'], date_end: '2026-12-10' }), ctx)[k]), ['2026-12-10', '2026-12-10']);
  // A return before the outbound is dropped.
  const back = validate(answer({ destination: ['KIX'], date_start: '2026-12-10', date_end: '2026-12-20', return_start: '2026-11-01', return_end: '2026-11-05' }), ctx);
  assert.equal(back.returnStart, null);
  assert.ok(back.dropped.includes('回程日期（早於出發）'));
});

test('validate: origin defaults to TPE, a vague sentence asks for more', () => {
  const d = validate(answer({ destination: ['BKK'] }), ctx);
  assert.deepEqual(d.origin, ['TPE']);
  assert.deepEqual(d.defaults, ['origin']);
  const region = validate(answer({ region: 'Europe' }), ctx);
  assert.equal(region.vague, true);
  assert.equal(region.region, 'Europe');
  assert.match(region.message, /「歐洲」的範圍比較大：可以改用「區域探索」/);
  const none = validate(answer({ origin: ['TPE'] }), ctx);
  assert.equal(none.vague, true);
  assert.match(none.message, /看不出要飛去哪裡/);
  for (const junk of [null, 'hello', [1, 2], 42]) assert.equal(validate(junk, ctx).vague, true);
});

test('holidays: the Taiwan calendar first, the built-in day when it is out of reach', async () => {
  const taiwan = async (start) => ({ longWeekends: start.startsWith('2027') ? [{ start: '2027-02-05', end: '2027-02-14', name: '農曆除夕、春節' }, { start: '2027-06-09', end: '2027-06-11', name: '端午節' }] : [] });
  assert.deepEqual(await holidayRange('lunar_new_year', 2027, { today: TODAY, taiwan }), { start: '2027-02-02', end: '2027-02-17', label: '2027 春節連假前後' });
  // No year: the next one not over yet (this year's 端午 has passed).
  assert.deepEqual(await holidayRange('dragon_boat', null, { today: TODAY, taiwan }), { start: '2027-06-06', end: '2027-06-14', label: '2027 端午連假前後' });
  const down = async () => { throw new Error('offline'); };
  assert.deepEqual(await holidayRange('lunar_new_year', 2027, { today: TODAY, taiwan: down }), { start: '2027-02-02', end: '2027-02-12', label: '2027 春節連假前後' });
  assert.deepEqual(await holidayRange('national_day', null, { today: '2026-10-20', taiwan: null }), { start: '2027-10-07', end: '2027-10-13', label: '2027 國慶連假前後' });
  assert.equal(await holidayRange('christmas', null, { today: TODAY }), null);
  // A holiday wins over dates; one past the window is dropped.
  const far = await holidayRange('lunar_new_year', 2028, { today: TODAY });
  const r = validate(answer({ destination: ['NRT'], holiday: 'lunar_new_year', date_start: '2026-11-01' }), { ...ctx, holiday: far });
  assert.equal(r.start, null);
  assert.ok(r.dropped.includes('節日日期（已經過了或超過一年）'));
});

test('demo parser: the design doc examples', () => {
  const p = (s) => validate(mockParse(normalize(s), TODAY), ctx);
  let r = p('十二月兩個人去大阪，經濟艙直飛就好');
  assert.deepEqual([r.origin, r.destination, r.start, r.end, r.cabin, r.pax, r.direct], [['TPE'], ['KIX'], '2026-12-01', '2026-12-31', 'Y', 2, true]);
  r = p('高雄出發去曼谷，下個月任何一天');
  assert.deepEqual([r.origin, r.destination, r.start, r.end, r.cabin], [['KHH'], ['BKK'], '2026-11-01', '2026-11-30', null]);
  r = p('明年五月台北到倫敦頭等艙，只要寰宇一家');
  assert.deepEqual([r.origin, r.destination, r.start, r.end, r.cabin, r.alliance], [['TPE'], ['LHR', 'LGW'], '2027-05-01', '2027-05-31', 'F', 'oneworld']);
  r = p('用 Aeroplan 去舊金山來回，七月去八月回');
  assert.deepEqual([r.origin, r.destination, r.start, r.end, r.returnStart, r.returnEnd, r.programs], [['TPE'], ['SFO', 'SJC', 'OAK'], '2027-07-01', '2027-07-31', '2027-08-01', '2027-08-31', ['aeroplan']]);
  const raw = mockParse('明年過年從台北飛東京商務艙，用亞洲萬里通', TODAY);
  assert.deepEqual([raw.origin, raw.destination, raw.holiday, raw.holiday_year, raw.cabin, raw.programs], [['TPE'], ['NRT', 'HND'], 'lunar_new_year', 2027, 'J', ['asiamiles']]);
  r = p('想去歐洲');
  assert.equal(r.vague, true);
  assert.equal(r.region, 'Europe');
  assert.equal(normalize('  ＴＰＥ　到　ＮＲＴ。 '), 'TPE 到 NRT');
});

test('Claude request: Haiku 5.5, structured output, only the sentence and the date', async () => {
  const client = fakeClient(answer({ origin: ['TPE'], destination: ['NRT', 'HND'], holiday: 'lunar_new_year', holiday_year: 2027, cabin: 'J', programs: ['asiamiles'] }));
  const s = service({ client, taiwan: async () => { throw new Error('offline'); } });
  const r = await s.parse('明年過年從台北飛東京商務艙，用亞洲萬里通');
  assert.equal(client.calls.length, 1);
  const { params, opts } = client.calls[0];
  assert.equal(params.model, MODEL);
  assert.equal(MODEL, 'claude-haiku-5-5');
  assert.ok(params.max_tokens <= 1024);
  assert.deepEqual(params.thinking, { type: 'disabled' });
  assert.equal(params.output_config.format.type, 'json_schema');
  assert.equal(params.output_config.format.schema.additionalProperties, false);
  assert.deepEqual(params.output_config.format.schema.required.sort(), Object.keys(EMPTY).sort());
  assert.equal(params.temperature, undefined);
  assert.equal(params.system[0].cache_control.type, 'ephemeral');
  assert.doesNotMatch(params.system[0].text, /2026-10-15/); // the static part stays the same every day
  assert.equal(params.messages.length, 1);
  assert.equal(params.messages[0].content, '今天是 2026-10-15（星期四），台灣時間。\n句子：明年過年從台北飛東京商務艙,用亞洲萬里通'); // NFKC folds full-width punctuation
  assert.equal(opts.timeout, 15000);
  assert.deepEqual([r.origin, r.destination, r.start, r.end, r.dateLabel, r.cabin, r.programs, r.mock, r.cached, r.used], [['TPE'], ['NRT', 'HND'], '2027-02-02', '2027-02-12', '2027 春節連假前後', 'J', ['asiamiles'], false, false, 1]);
});

test('the same sentence the same day comes from the cache, without a call or a count', async () => {
  const client = fakeClient(answer({ destination: ['KIX'] }));
  const s = service({ client });
  const a = await s.parse('十二月去大阪');
  const b = await s.parse(' 十二月去大阪。');
  assert.equal(client.calls.length, 1);
  assert.equal(a.cached, false);
  assert.equal(b.cached, true);
  assert.deepEqual(b.destination, ['KIX']);
  assert.equal(b.used, 1);
  assert.deepEqual(await s.usage(), { used: 1, limit: 100 });
});

test('the daily cap stops the model calls', async () => {
  const client = fakeClient(answer({ destination: ['KIX'] }));
  const s = service({ client, limit: 2 });
  await s.parse('一月去大阪');
  await s.parse('二月去大阪');
  await assert.rejects(s.parse('三月去大阪'), (e) => e.status === 429 && e.code === 'nl-limit' && /已經用了 2 次/.test(e.message));
  assert.equal(client.calls.length, 2);
  assert.deepEqual(await s.usage(), { used: 2, limit: 2 });
  // A cached sentence still answers.
  assert.equal((await s.parse('一月去大阪')).cached, true);
});

test('bad input and model failures become plain Chinese errors', async () => {
  const s = service({ client: fakeClient(answer({})) });
  await assert.rejects(s.parse('   '), (e) => e.status === 400 && /請先輸入/.test(e.message));
  await assert.rejects(s.parse('去'.repeat(101)), (e) => e.status === 400 && /100 字以內/.test(e.message));
  await assert.rejects(service({ mode: 'off' }).parse('去大阪'), (e) => e.status === 404);
  await assert.rejects(service({ client: fakeClient({ text: 'not json' }) }).parse('去大阪'), (e) => e.status === 502);
  await assert.rejects(service({ client: fakeClient({ text: '{}', stop_reason: 'refusal' }) }).parse('去大阪'), (e) => e.status === 422);
  await assert.rejects(service({ client: fakeClient({ text: '{"origin":', stop_reason: 'max_tokens' }) }).parse('去大阪'), (e) => e.status === 502);
  const Anthropic = require('@anthropic-ai/sdk').default;
  const quiet = console.error;
  console.error = () => {};
  try {
    await assert.rejects(service({ client: fakeClient(new Anthropic.AuthenticationError(401, {}, 'bad key', new Headers())) }).parse('去大阪'), (e) => e.status === 503 && e.code === 'setup' && !/sk-/.test(e.message));
    await assert.rejects(service({ client: fakeClient(new Anthropic.APIConnectionTimeoutError()) }).parse('去大阪'), (e) => e.status === 504);
    await assert.rejects(service({ client: fakeClient(new Anthropic.RateLimitError(429, {}, 'slow down', new Headers())) }).parse('去大阪'), (e) => e.status === 503);
  } finally { console.error = quiet; }
});

test('demo mode answers without a client and counts like the real one', async () => {
  const s = createNlSearch({ mode: 'mock', kv: memoryKv(), today: () => TODAY, airportCodes: codes, groups: AIRPORTS.groups, programs, limit: 1 });
  const r = await s.parse('高雄出發去曼谷，下個月任何一天');
  assert.equal(r.mock, true);
  assert.deepEqual(r.destination, ['BKK']);
  await assert.rejects(s.parse('想去歐洲'), (e) => e.status === 429);
});

test('the real SDK client, made on first use, sends the documented request (to a local stand-in server)', async () => {
  const http = require('node:http');
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, key: req.headers['x-api-key'], version: req.headers['anthropic-version'], body: JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: JSON.stringify(answer({ destination: ['KIX'], cabin: 'Y' })) }] }));
    });
  });
  await new Promise((r) => srv.listen(0, r));
  const before = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = `http://localhost:${srv.address().port}`;
  try {
    const r = await service({ apiKey: 'test-key-not-real' }).parse('十二月去大阪');
    assert.deepEqual([r.destination, r.cabin], [['KIX'], 'Y']);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, '/v1/messages');
    assert.equal(seen[0].key, 'test-key-not-real');
    assert.ok(seen[0].version);
    const b = seen[0].body;
    assert.deepEqual([b.model, b.thinking.type, b.output_config.effort, b.output_config.format.type], ['claude-haiku-5-5', 'disabled', 'low', 'json_schema']);
    assert.deepEqual(Object.keys(b).sort(), ['max_tokens', 'messages', 'model', 'output_config', 'system', 'thinking']);
  } finally {
    if (before === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = before;
    srv.close();
  }
});
