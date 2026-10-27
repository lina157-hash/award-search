// Round 10 檢查 fixes: the load-factor airline names (國泰航空 is CX, not 國泰港龍), codeshare twins TDX lists as separate
// nonstops, TDX paged past 10,000 rows within the run's time, and the 今日好康 stale-seat cut.
const { test } = require('node:test');
const assert = require('node:assert');
delete process.env.TDX_CLIENT_ID;
delete process.env.TDX_CLIENT_SECRET;
const F = require('../lib/flightdata');
const M = require('../lib/flightdata-mock');
const { memoryKv } = require('../lib/kv');

test('load factor: the exact airline name wins over a longer one containing it; count rows and aliases', () => {
  const al = { KA: '國泰港龍航空', CX: '國泰航空', JL: '日本航空', IJ: '日本春秋航空', TG: '泰國航空' };
  const csv = ['年月,機場,航線,航空公司,入出境,架次,座位數,載客人數,載客率',
    '2026/08,桃園,香港,國泰航空,出境,30,9000,8100,90%',
    '2026/08,桃園,東京(成田),日本航空,出境,30,9000,7200,80%',
    '2026/08,桃園,曼谷,泰獅,出境,30,9000,6300,70%',
    '2026/08,桃園,東京(成田),"1,234",出境,30,9000,6300,70%'].join('\n');
  const r = F.parseLoadFactor(csv, { airportNames: [['香港', 'HKG'], ['成田', 'NRT'], ['曼谷', 'BKK']], airlineZh: al });
  assert.ok(r.routes['TPE-HKG'].CX, '國泰航空 → CX');
  assert.ok(!r.routes['TPE-HKG'].KA);
  assert.ok(r.routes['TPE-NRT'].JL, '日本航空 → JL');
  assert.ok(!r.routes['TPE-NRT'].IJ);
  assert.ok(r.routes['TPE-BKK'].SL, '泰獅 → SL');
  assert.equal(r.unknown.length, 0, 'a row of counts is not an unknown airline');
});

test('timetable: one flight under several numbers keeps the lowest as the operator; the CAA codeshare list drops a copy', () => {
  const r = (o) => ({ fn: 'BR10', o: 'TPE', d: 'YVR', dep: '23:30', arr: '19:20', ad: 0, days: 127, from: '2026-10-25', to: '2027-03-27', ac: '', t: '2', cs: [], ...o });
  const rows = F.mergeRows([r({}), r({ fn: 'AC6546' }), r({ fn: 'TG6274' }), r({ fn: 'CI32', dep: '23:55', arr: '19:45' })], '2026-10-27');
  assert.deepEqual(rows.map((x) => x.fn), ['BR10', 'CI32']);
  assert.deepEqual(rows[0].cs.sort(), ['AC6546', 'TG6274']);
  // Times that differ a little between the sources: the CAA row naming the codeshare still drops it.
  const two = F.mergeRows([r({ fn: 'BR16', d: 'LAX' }), r({ fn: 'NH5812', d: 'LAX', arr: '19:35' })], '2026-10-27', [r({ fn: 'BR16', d: 'LAX', cs: ['NH5812'] })]);
  assert.deepEqual(two.map((x) => x.fn), ['BR16']);
});

const enc = (s) => new TextEncoder().encode(s);
const reply = (body) => ({ ok: true, status: 200, arrayBuffer: async () => enc(body).buffer });
function tdxRun({ slow }) {
  const today = '2026-10-27';
  let clock = Date.parse(today + 'T00:00:00Z');
  const base = M.mockFetch(today);
  const one = M.tdxList(today);
  const full = Array.from({ length: 10000 }, (_, i) => one[i % one.length]);
  const pages = [];
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.startsWith(F.URLS.tdxSchedule)) {
      pages.push(u);
      if (slow) clock += 37e3;
      return reply(JSON.stringify(/skip=10000/.test(u) ? one.slice(0, 3) : /skip=/.test(u) ? [] : full));
    }
    return base(url, init);
  };
  const fd = F.createFlightData({ kv: memoryKv(), fetchImpl, env: { TDX_CLIENT_ID: 'x', TDX_CLIENT_SECRET: 'y' }, now: () => clock });
  return { pages, out: fd.refresh() };
}

test('TDX: reads the next page after a full one; stops and says so when the run is out of time', async () => {
  const a = tdxRun({ slow: false });
  const out = await a.out;
  assert.equal(a.pages.length, 2);
  assert.equal(out.sources.tdx.ok, true);
  assert.ok(!out.sources.tdx.cut);
  const b = tdxRun({ slow: true });
  const cut = await b.out;
  assert.equal(b.pages.length, 1);
  assert.equal(cut.sources.tdx.cut, true);
});

test('今日好康 leaves out a seat seats.aero last saw over a week ago; 哪裡都好 keeps it', () => {
  const { bestByDestination } = require('../lib/deals');
  const row = (d, upd) => ({ id: d, date: '2026-11-20', origin: 'TPE', destination: d, source: 'united', updatedAt: upd, cabins: { J: { available: true, miles: 50000, seats: 2, airlines: 'BR', direct: true } } });
  const rows = [row('LAX', '2026-10-27T01:00:00Z'), row('SFO', '2026-09-24T01:00:00Z')];
  assert.deepEqual(bestByDestination(rows, 'J', '2026-10-28', { maxAge: 8 * 864e5 }).map((x) => x.destination), ['LAX']);
  assert.equal(bestByDestination(rows, 'J', '2026-10-28').length, 2);
});

test('page start waits for the later scripts; server errors and a silent server are said in words', () => {
  const app = require('fs').readFileSync(require('path').join(__dirname, '../public/app.js'), 'utf8');
  const init = app.slice(app.indexOf("await Promise.all([api('/api/config')"));
  assert.ok(init.indexOf("document.readyState === 'loading'") < init.indexOf('watchCfg.on'), 'init waits for DOMContentLoaded before using features.js');
  assert.match(app, /AbortSignal\.timeout\(65000\)/);
  const httpWords = new Function(`${app.slice(app.indexOf('function httpWords'), app.indexOf('}\n', app.indexOf('function httpWords')) + 1)}; return httpWords;`)();
  assert.match(httpWords(504), /逾時/);
  assert.match(httpWords(502), /伺服器暫時出錯（HTTP 502）/);
  assert.equal(httpWords(404), 'HTTP 404');
});
