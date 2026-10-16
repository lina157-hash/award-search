// 截圖讀入官網結果 (lib/nlimage.js, public/cxshot.js): the image check, the request each provider gets (fakes: no
// network), the answer checked into the lines public/cxmuse.js's museParse reads, the daily cap given back on failure,
// and that the image is never kept.
const { test } = require('node:test');
const assert = require('node:assert');
const { createNlImage, checkShot, readImage, shotPrompt, shotSchema, mockRead, MAX_IMAGE_BYTES, SHOT_AIRS } = require('../lib/nlimage');
const { memoryKv } = require('../lib/kv');
const { museParse, museDayLevel } = require('../public/cxmuse');
const { cxsFit, cxsSummary, CXS_AIRS, CXS_MAX_CHARS } = require('../public/cxshot');
const TEMPLATES = require('../data/muse-templates.json').airlines;
const AIRPORTS = require('../public/airports.min.json');

const TODAY = '2026-10-16';
const codes = new Set(AIRPORTS.airports.map((a) => a[0]));
const tpl = (id) => TEMPLATES.find((t) => t.id === id);
const b64 = (bytes) => Buffer.concat([Buffer.from(bytes), Buffer.alloc(300, 7)]).toString('base64');
const JPEG = `data:image/jpeg;base64,${b64([0xff, 0xd8, 0xff, 0xe0])}`;
const PNG = `data:image/png;base64,${b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])}`;
const day = (date, status, miles = null, flight = null, cabin = 'J') => ({ date, cabin, status, miles, flight });
const ANSWER = {
  is_award_page: true, origin: 'TPE', destination: 'NRT',
  days: [day('2026-12-01', '充足', 50000, 'CI100'), day('2026-12-02', '有限', 75000), day('2026-12-03', '稀少', 95000, 'CI 104›CI 106'), day('2026-12-04', '候補', 50000, 'CI100'), day('2026-12-05', '無位')],
};
const quietly = async (fn) => {
  const [log, err] = [console.log, console.error];
  const lines = [];
  console.log = console.error = (...a) => lines.push(a.join(' '));
  try { return await fn(lines); } finally { [console.log, console.error] = [log, err]; }
};

function fakeFetch(reply) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const r = typeof reply === 'function' ? reply() : reply;
    if (r instanceof Error) throw r;
    return { ok: (r.status || 200) < 400, status: r.status || 200, json: async () => r.body };
  };
  f.calls = calls;
  return f;
}
const chat = (content, extra = {}) => ({ body: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content), refusal: null }, ...extra }], usage: { prompt_tokens: 2900, completion_tokens: 400 } } });
function fakeClient(reply) {
  const calls = [];
  return {
    calls,
    messages: {
      async create(params, opts) {
        calls.push({ params, opts });
        const r = typeof reply === 'function' ? reply(params) : reply;
        if (r instanceof Error) throw r;
        return { stop_reason: r.stop_reason || 'end_turn', usage: { input_tokens: 3100, output_tokens: 420 }, content: [{ type: 'text', text: typeof r.text === 'string' ? r.text : JSON.stringify(r) }] };
      },
    },
  };
}
const service = (o = {}) => createNlImage({ mode: 'live', kv: memoryKv(), today: () => TODAY, airportCodes: codes, templates: TEMPLATES, limit: 30, ...o });
const openai = (fetchImpl, o = {}) => service({ provider: 'openai', apiKey: 'test-key-not-real', fetchImpl, ...o });
const ask = { air: 'ci', from: 'TPE', to: 'NRT', start: '2026-12-01', end: '2026-12-31', cabin: 'J' };

test('readImage: JPEG, PNG and WebP by their first bytes; anything else or too big is refused', () => {
  assert.equal(readImage(JPEG).mediaType, 'image/jpeg');
  assert.equal(readImage(PNG).mediaType, 'image/png');
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(300)]).toString('base64');
  assert.equal(readImage(`data:image/webp;base64,${webp}`).mediaType, 'image/webp');
  // The URL's own type is not trusted: a PNG labelled JPEG is sent as PNG.
  assert.equal(readImage(PNG.replace('image/png', 'image/jpeg')).mediaType, 'image/png');
  for (const bad of ['', 'hello', 'data:text/plain;base64,aGVsbG8=', `data:image/gif;base64,${b64([0x47, 0x49, 0x46, 0x38])}`, 'data:image/jpeg;base64,/9j/4A==']) {
    assert.throws(() => readImage(bad), (e) => e.status === 400, bad.slice(0, 20));
  }
  const big = `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(MAX_IMAGE_BYTES)]).toString('base64')}`;
  assert.throws(() => readImage(big), (e) => e.status === 413 && /太大/.test(e.message));
});

test('the page sends at most what the server takes', () => {
  assert.deepEqual(CXS_AIRS, SHOT_AIRS);
  assert.ok(CXS_MAX_CHARS * 3 / 4 < MAX_IMAGE_BYTES);
  assert.deepEqual(cxsFit(2560, 1440), { w: 1600, h: 900 });
  assert.deepEqual(cxsFit(1170, 2532), { w: 739, h: 1600 });
  assert.deepEqual(cxsFit(800, 600), { w: 800, h: 600 }); // never enlarged
});

test('OpenAI request: GPT-6 Luna, the image as a data URL in an image_url part, a strict schema of the airline\'s words', async () => {
  const f = fakeFetch(chat(ANSWER));
  const r = await quietly((logs) => openai(f).read({ ...ask, image: JPEG }).then((x) => { assert.ok(logs.some((l) => /nlimage openai in=2900 out=400/.test(l))); return x; }));
  assert.equal(f.calls.length, 1);
  const { url, init, body } = f.calls[0];
  assert.equal(url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(init.headers.authorization, 'Bearer test-key-not-real');
  assert.deepEqual([body.model, body.reasoning_effort, body.store], ['gpt-6-luna', 'none', false]);
  assert.deepEqual(body.messages.map((m) => m.role), ['system', 'user']);
  const [txt, img] = body.messages[1].content;
  assert.equal(txt.type, 'text');
  assert.match(txt.text, /今天是 2026-10-16/);
  assert.match(txt.text, /TPE → NRT，2026-12-01 到 2026-12-31，商務艙/);
  assert.deepEqual(img, { type: 'image_url', image_url: { url: JPEG, detail: 'high' } });
  const fmt = body.response_format;
  assert.deepEqual([fmt.type, fmt.json_schema.strict], ['json_schema', true]);
  assert.deepEqual(fmt.json_schema.schema.properties.days.items.properties.status.enum, ['充足', '有限', '稀少', '候補', '無位']);
  assert.match(body.messages[0].content, /中華航空/);
  assert.doesNotMatch(body.messages[0].content, /2026-10-16/); // the static part stays the same (cacheable)
  assert.ok(!JSON.stringify(body).includes('test-key-not-real')); // the key goes in the header only
  assert.equal(r.text, [
    '華航查票結果 TPE-NRT',
    '2026-12-01 | 商務 | 充足 | 50000 | CI100',
    '2026-12-02 | 商務 | 有限 | 75000',
    '2026-12-03 | 商務 | 稀少 | 95000 | CI104/CI106',
    '2026-12-04 | 商務 | 候補',
    '2026-12-05 | 商務 | 無位',
  ].join('\n'));
  assert.deepEqual([r.fc, r.tc, r.routeSeen, r.days, r.air, r.used, r.limit, r.mock], ['TPE', 'NRT', true, 5, 'ci', 1, 30, false]);
  assert.equal(r.usd, 0.00049); // 2,900 in × US$0.10 + 400 out × US$0.50 per million
});

test('Claude request: Haiku 5.5, an image block (base64) before the text, structured output, no thinking', async () => {
  const client = fakeClient({ is_award_page: true, origin: null, destination: null, days: [day('2026-11-20', '有位', null, 'BR198', 'Y'), day('2026-11-21', '候補', null, null, 'Y')] });
  const r = await quietly(() => service({ client }).read({ air: 'br', from: 'TPE', to: 'NRT', image: PNG, cabin: 'Y' }));
  const { params, opts } = client.calls[0];
  assert.equal(params.model, 'claude-haiku-5-5');
  assert.deepEqual(params.thinking, { type: 'disabled' });
  assert.equal(params.output_config.format.type, 'json_schema');
  assert.deepEqual(params.output_config.format.schema.properties.days.items.properties.cabin.enum, ['Y', 'W', 'J']);
  const [img, txt] = params.messages[0].content;
  assert.deepEqual(img, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.split(',')[1] } });
  assert.equal(txt.type, 'text');
  assert.match(params.system[0].text, /「△（三角形）」 means 候補/);
  assert.equal(opts.timeout, 25000);
  // No route on the image: the one-airport search fills it in, and says so.
  assert.deepEqual([r.fc, r.tc, r.routeSeen], ['TPE', 'NRT', false]);
  assert.equal(r.text, '長榮查票結果 TPE-NRT\n2026-11-20 | 經濟 | 有位 |  | BR198\n2026-11-21 | 經濟 | 候補');
});

test('parser hand-off: each airline\'s lines fill the same calendar museParse draws', () => {
  const opts = { tpl: tpl('ci'), today: TODAY, airportOk: (c) => codes.has(c) };
  const ci = museParse(checkShot(ANSWER, opts).text, { airlines: TEMPLATES, air: 'cx' });
  assert.equal(ci.routes.length, 1);
  const r = ci.routes[0];
  assert.deepEqual([r.air, r.fc, r.tc, ci.read, ci.skipped], ['ci', 'TPE', 'NRT', 5, 0]);
  assert.deepEqual(r.days['2026-12-01'].c.J, { m: 50000, f: [{ n: 'CI100', d: '', a: '', p: 'TPE-NRT', s: 0, m: 50000 }], st: 'p' });
  assert.equal(r.days['2026-12-02'].c.J.st, 'l');
  assert.deepEqual(r.days['2026-12-03'].c.J.f[0].n, 'CI104›CI106');
  assert.equal(r.days['2026-12-03'].c.J.st, 's');
  assert.deepEqual(r.days['2026-12-04'].c.J, { m: 0, na: 1, st: 'w' });
  assert.deepEqual(r.days['2026-12-05'].c.J, { m: 0, na: 1 });
  assert.deepEqual(['2026-12-01', '2026-12-04', '2026-12-05'].map((k) => museDayLevel(r.days[k])), ['p', 'w', 'n']);
  // 國泰, 長榮, 星宇: their own words, their own airline id.
  for (const [id, status, name] of [['cx', '有位', '國泰'], ['br', '候補', '長榮'], ['jx', '有位', '星宇']]) {
    const out = checkShot({ is_award_page: true, origin: 'TPE', destination: 'HKG', days: [day('2026-12-10', status, status === '有位' ? 30000 : null), day('2026-12-11', '無位')] }, { ...opts, tpl: tpl(id) });
    assert.ok(out.text.startsWith(`${name}查票結果 TPE-HKG`), id);
    const p = museParse(out.text, { airlines: TEMPLATES, air: 'cx' });
    assert.equal(p.routes[0].air, id);
    assert.equal(p.read, 2);
    assert.equal(museDayLevel(p.routes[0].days['2026-12-10']), status === '候補' ? 'w' : 'o');
  }
  // Several screenshots of the same route (華航 shows one week a page) add up to one calendar.
  const week2 = checkShot({ ...ANSWER, days: [day('2026-12-08', '充足', 50000)] }, opts).text;
  const both = museParse(`${checkShot(ANSWER, opts).text}\n${week2}`, { airlines: TEMPLATES });
  assert.equal(both.routes.length, 1);
  assert.equal(Object.keys(both.routes[0].days).length, 6);
});

test('checkShot: each entry checked; past, unknown and off-template entries are left out and counted', () => {
  const opts = { tpl: tpl('br'), today: TODAY, airportOk: (c) => codes.has(c), from: ['TPE'], to: ['LAX'] };
  const r = checkShot({
    is_award_page: true, origin: 'tpe', destination: 'XQZ',
    days: [
      day('2026-10-15', '有位'), // yesterday
      day('2027-12-01', '有位'), // past a year
      day('2026-11-31', '有位'), // no such day
      day('2026-11-02', '有位', null, null, 'F'), // 長榮 has no first class here
      day('2026-11-03', '充足'), // not one of 長榮's words
      day('2026-11-04', '有位', 120, 'not a flight'), // miles too small, flight unreadable: dropped, the day kept
      day('2026-11-05', '候補', 90000, 'BR12'), // no miles or flight on a waitlist day
      day('2026-11-01', '有位', 75000, 'br 12', 'W'),
      'junk',
    ],
  }, opts);
  assert.deepEqual([r.fc, r.tc, r.routeSeen], ['TPE', 'LAX', false]); // XQZ is no airport: the search's one
  assert.deepEqual([r.past, r.bad, r.days, r.cabins], [2, 4, 3, ['W', 'J']]);
  assert.ok(r.text.startsWith('長榮查票結果 TPE-LAX\n2026-11-01 | 豪華經濟 | 有位 | 75000 | BR12\n'));
  assert.match(r.text, /^2026-11-04 \| 商務 \| 有位$/m);
  assert.match(r.text, /^2026-11-05 \| 商務 \| 候補$/m);
  assert.match(r.text, /^2026-11-01 \| 豪華經濟 \| 有位 \| 75000 \| BR12$/m);
  const bad = (raw, o = opts) => { try { checkShot(raw, o); return ''; } catch (e) { return e.code; } };
  assert.equal(bad({ is_award_page: false, days: [] }), 'not-award');
  assert.equal(bad({ is_award_page: true, days: [] }), 'not-award');
  assert.equal(bad(null), 'not-award');
  assert.equal(bad({ is_award_page: true, origin: 'TPE', destination: 'NRT', days: [day('2026-01-01', '有位')] }), 'empty');
  // No route on the image and two airports in the search: it cannot be told.
  assert.equal(bad({ is_award_page: true, origin: null, destination: null, days: [day('2026-11-01', '有位')] }, { ...opts, from: ['TPE', 'TSA'] }), 'route');
});

test('the daily cap: counted per read, given back when there is no usable answer, never more than the limit', async () => {
  const kv = memoryKv();
  let reply = chat(ANSWER);
  const f = fakeFetch(() => reply);
  const svc = openai(f, { kv, limit: 2 });
  await quietly(async () => {
    assert.equal((await svc.read({ ...ask, image: JPEG })).used, 1);
    reply = { status: 500, body: { error: { code: 'server_error' } } };
    await assert.rejects(svc.read({ ...ask, image: JPEG }), (e) => e.status === 502);
    reply = chat({ is_award_page: false, origin: null, destination: null, days: [] });
    await assert.rejects(svc.read({ ...ask, image: JPEG }), (e) => e.status === 422 && e.code === 'not-award');
    assert.deepEqual(await svc.usage(), { used: 1, limit: 2 }); // both given back
    reply = chat(ANSWER);
    assert.equal((await svc.read({ ...ask, image: JPEG })).used, 2);
    await assert.rejects(svc.read({ ...ask, image: JPEG }), (e) => e.status === 429 && e.code === 'nl-limit' && /2 張/.test(e.message));
  });
  assert.equal(f.calls.length, 4); // the read over the limit never reached the model
  assert.deepEqual(await svc.usage(), { used: 2, limit: 2 });
  // Nothing but the count is kept: no image, no answer.
  assert.deepEqual(await kv.scan('*'), [`nl:v1:img:count:${TODAY}`]);
  // A bad file or an airline without the button costs nothing.
  await assert.rejects(svc.read({ ...ask, image: 'data:image/png;base64,AAAA' }), (e) => e.status === 400);
  await assert.rejects(svc.read({ ...ask, air: 'jl', image: JPEG }), (e) => e.status === 400 && /國泰、華航、長榮、星宇/.test(e.message));
  assert.equal(f.calls.length, 4);
});

test('failures from either model become plain Chinese errors, without the key or the image in the logs', async () => {
  const logs = await quietly(async (lines) => {
    const err = (status, code, message = 'x') => ({ status, body: { error: { message, type: 'invalid_request_error', code } } });
    const read = (reply) => openai(fakeFetch(reply)).read({ ...ask, image: JPEG });
    await assert.rejects(read(err(401, 'invalid_api_key')), (e) => e.status === 503 && e.code === 'setup' && /OPENAI_API_KEY/.test(e.message));
    await assert.rejects(read(err(429, 'insufficient_quota')), (e) => e.status === 503 && /餘額不足/.test(e.message));
    await assert.rejects(read(err(400, 'invalid_image_format', 'Invalid image.')), (e) => e.status === 422 && e.code === 'image');
    await assert.rejects(read(err(400, null, 'bad request')), (e) => e.status === 502);
    await assert.rejects(read(chat('', { message: { content: null, refusal: 'no' } })), (e) => e.status === 422 && e.code === 'refusal');
    await assert.rejects(read(chat('{"days":[', { finish_reason: 'length' })), (e) => e.status === 502 && /太多/.test(e.message));
    await assert.rejects(read(chat('not json')), (e) => e.status === 502);
    await assert.rejects(read(Object.assign(new Error('t'), { name: 'TimeoutError' })), (e) => e.status === 504);
    await assert.rejects(read(new TypeError('fetch failed')), (e) => e.status === 502 && /連不上/.test(e.message));
    const claude = (reply) => service({ client: fakeClient(reply) }).read({ ...ask, image: PNG });
    await assert.rejects(claude(Object.assign(new Error('messages.0.content.0.image.source.base64: invalid image data'), { status: 400 })), (e) => e.status === 422 && e.code === 'image');
    await assert.rejects(claude(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), (e) => e.status === 504);
    await assert.rejects(claude({ stop_reason: 'refusal', text: '' }), (e) => e.status === 422 && e.code === 'refusal');
    await assert.rejects(claude({ stop_reason: 'max_tokens', text: '{"days":[' }), (e) => e.status === 502 && /太多/.test(e.message));
    return lines;
  });
  const all = logs.join('\n');
  assert.ok(!all.includes('test-key-not-real'));
  assert.ok(!all.includes(JPEG.split(',')[1].slice(0, 40)) && !all.includes(PNG.split(',')[1].slice(0, 40)));
});

test('off without a model; the demo answers with a made-up week that the parser reads', async () => {
  await assert.rejects(service({ mode: 'off' }).read({ ...ask, image: JPEG }), (e) => e.status === 404);
  const r = await service({ mode: 'mock' }).read({ ...ask, image: JPEG });
  assert.equal(r.mock, true);
  assert.equal(r.days, 7);
  const p = museParse(r.text, { airlines: TEMPLATES });
  assert.deepEqual([p.routes[0].air, p.routes[0].fc, p.routes[0].tc, p.read], ['ci', 'TPE', 'NRT', 7]);
  assert.ok(Object.values(p.routes[0].days).some((d) => d.c.J?.st === 'w'));
  assert.equal(mockRead(tpl('cx'), { from: [], to: [], cabin: 'F', start: '' }, TODAY).days[0].date, '2026-11-15');
});

test('prompt and schema: only the airline\'s cabins and words, and how its page reads', () => {
  for (const id of SHOT_AIRS) {
    const t = tpl(id);
    const s = shotSchema(t);
    assert.deepEqual(s.properties.days.items.properties.status.enum, t.statuses, id);
    assert.deepEqual(s.properties.days.items.properties.cabin.enum, t.cabins, id);
    assert.deepEqual(s.required, ['is_award_page', 'origin', 'destination', 'days']);
    const p = shotPrompt(t);
    for (const line of t.read) assert.ok(p.includes(line), id);
    assert.ok(p.includes(t.full), id);
  }
  assert.match(shotPrompt(tpl('jx')), /Alaska miles for flights STARLUX \(JX\) operates/);
});

test('the summary line says what was read, what was skipped, the cost and what is left', () => {
  assert.equal(cxsSummary({ days: 5, fc: 'TPE', tc: 'NRT', routeSeen: true, past: 2, bad: 0, usd: 0.00049, used: 3, limit: 30 }),
    '✓ 讀到 5 天（TPE→NRT），已放進下面「貼上 AI 助理的結果」，看過沒問題再按「儲存到網站」。略過已過的日期 2 筆。這張約 US$0.00049。今天還可以讀 27 張。');
  assert.match(cxsSummary({ days: 7, fc: 'TPE', tc: 'HKG', routeSeen: false, mock: true, used: 1, limit: 30 }), /圖上沒有航線，用上面填的.*示範/);
});
