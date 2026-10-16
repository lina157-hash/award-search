// Round 9 #14 拆兩段查：經樞紐轉機 (public/hubsplit.js): hubs from data/split-hubs.json where the alliance flies both legs
// nonstop (data/rtw-routes.json, data/skyteam-routes.json), date pairing of the two searches, per-program totals, the
// SkyTeam route generator and the data endpoint.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const S = require('../scripts/build-skyteam-routes.js');

const read = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', f), 'utf8'));
const hubData = read('split-hubs.json');
const rtwRoutes = read('rtw-routes.json');
const skyRoutes = read('skyteam-routes.json');
const alliances = read('alliances.json').alliances;
function grab(file, re) {
  const m = fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8').match(re);
  assert.ok(m, `${re} in ${file}`);
  return m[0];
}
const ctx = { console };
vm.createContext(ctx);
vm.runInContext([
  grab('features.js', /function haversineMiles\(a, b\) \{[\s\S]*?\n\}/),
  grab('features.js', /const nonstopKey = [^\n]*/),
  grab('features.js', /function nonstopIndex\(raw\) \{[\s\S]*?\n\}/),
  grab('cxfill.js', /const cxSeatsOk = [^\n]*/),
  grab('cxfill.js', /const cxNextDay = [^\n]*/),
  fs.readFileSync(path.join(__dirname, '..', 'public', 'hubsplit.js'), 'utf8'),
  'this.H = { splitSeatDays, splitWanted, splitHubMap, splitCandidates, splitLegDays, splitBest, splitPairs, splitByProgram, splitCalls, splitCostText, nonstopIndex, nonstopKey };',
].join('\n'), ctx);
const { H } = ctx;
const plain = (x) => JSON.parse(JSON.stringify(x));

const ap = require('../public/airports.min.json');
const apMap = new Map(ap.airports.map(([code, , , country, , , , , lat, lon]) => [code, { code, country, lat, lon }]));
const apOf = (c) => apMap.get(c) || null;
const group = new Map(ap.groups.flatMap((g) => g.codes.map((c) => [c, g.zh])));
const cityOf = (c) => group.get(c) || c;
const members = Object.fromEntries(alliances.map((a) => [a.id, a.members]));
const rtw = H.nonstopIndex(rtwRoutes);
const sky = H.nonstopIndex(skyRoutes);
const flies = (a, b) => [...(rtw.pairs.get(H.nonstopKey(a, b)) || []), ...(sky.pairs.get(H.nonstopKey(a, b)) || [])];
const hubs = H.splitHubMap(hubData, alliances);
const cands = (o, d, more = {}) => plain(H.splitCandidates({ origins: o.split(','), dests: d.split(','), hubs, members, flies, apOf, cityOf, ...more }));
const at = (list, code) => list.find((h) => h.codes.includes(code));

// ---------- the hub list ----------
test('hub data: every airline is in an alliance, every hub airport is known, every source is an https page with a quote', () => {
  const all = new Set(alliances.flatMap((a) => a.members));
  for (const a of hubData.airlines) {
    assert.ok(all.has(a.code), `${a.code} in an alliance`);
    assert.ok(a.hubs.length && a.hubs.every((h) => apMap.has(h)), `${a.code} hubs known`);
    assert.match(a.source.url, /^https:\/\//, a.code);
    assert.ok(a.source.label && a.quote, a.code);
  }
  assert.equal(new Set(hubData.airlines.map((a) => a.code)).size, hubData.airlines.length, 'one entry per airline');
});

test('hub map: hubs follow alliance membership, so an airline that leaves takes its hubs with it', () => {
  assert.deepEqual(plain(hubs.get('star').get('BKK')), ['TG']);
  assert.deepEqual(plain(hubs.get('oneworld').get('HKG')), ['CX']);
  assert.deepEqual(plain(hubs.get('skyteam').get('AMS')), ['KL']);
  assert.deepEqual(plain(hubs.get('star').get('NRT')), ['NH']);
  assert.deepEqual(plain(hubs.get('oneworld').get('LAX')).sort(), ['AA', 'AS']);
  const noThai = alliances.map((a) => (a.id === 'star' ? { ...a, members: a.members.filter((c) => c !== 'TG') } : a));
  assert.equal(H.splitHubMap(hubData, noThai).get('star').has('BKK'), false);
});

// ---------- hubs for a search ----------
test('TPE→ZRH: Star, oneworld and SkyTeam hubs where the alliance flies both legs, shortest detour first', () => {
  const list = cands('TPE', 'ZRH');
  const codes = list.map((h) => h.codes.join('/'));
  for (const c of ['MUC', 'VIE', 'IST', 'BKK', 'SIN', 'HKG', 'AMS', 'ICN']) assert.ok(codes.includes(c), c);
  assert.ok(!codes.includes('TPE'), 'never the origin');
  for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].total <= list[i].total, 'sorted by distance');
  const bkk = at(list, 'BKK');
  assert.deepEqual(bkk.via.map((v) => v.alliance), ['star']);
  assert.ok(bkk.via[0].leg1.includes('TG') && bkk.via[0].leg2.includes('LX'), JSON.stringify(bkk.via));
  assert.ok(bkk.extra > 0 && bkk.dist1 + bkk.dist2 === bkk.total);
  assert.deepEqual(at(list, 'HKG').via.map((v) => v.alliance), ['oneworld']);
  assert.deepEqual(at(list, 'AMS').via.map((v) => v.alliance), ['skyteam']);
  // Every leg airline belongs to the hub's alliance.
  for (const h of list) for (const v of h.via) for (const c of [...v.leg1, ...v.leg2]) assert.ok(members[v.alliance].includes(c), `${h.codes} ${c}`);
});

test('filters: an alliance picked in the form keeps its own hubs; an airline picked needs it on both legs', () => {
  const ow = cands('TPE', 'ZRH', { only: ['oneworld'] });
  assert.ok(ow.length && ow.every((h) => h.via.every((v) => v.alliance === 'oneworld')));
  assert.ok(!at(ow, 'BKK'));
  const tk = cands('TPE', 'ZRH', { carrier: 'TK' });
  assert.deepEqual(tk.map((h) => h.codes.join('/')), ['IST']);
  assert.deepEqual(cands('TPE', 'ZRH', { carrier: 'ZZ' }), []);
});

test('same-city hubs merge and the ends\' cities are never offered; long detours drop out', () => {
  const tokyo = at(cands('TPE,TSA', 'LAX'), 'NRT');
  assert.ok(tokyo, 'Tokyo offered for TPE→LAX');
  assert.equal(new Set(tokyo.codes.map(cityOf)).size, 1);
  assert.ok(!at(cands('TPE', 'NRT'), 'HND') && !at(cands('TPE', 'HND'), 'NRT'), 'Tokyo is the destination');
  assert.ok(!at(cands('TPE', 'HKG'), 'LHR'), 'no hub far off the way');
  for (const h of cands('TPE', 'ZRH')) assert.ok(h.dist1 >= 100 && h.dist2 >= 100);
});

// ---------- seats and pairing ----------
const row = (date, source, miles, extra = {}) => ({
  id: `${date}-${source}-${extra.origin || 'TPE'}`, date, source, origin: 'TPE', destination: 'BKK',
  cabins: { J: { available: true, miles, seats: 2, airlines: 'BR', direct: true } }, ...extra,
});
const leg2 = (date, source, miles, extra = {}) => row(date, source, miles, { origin: 'BKK', destination: 'ZRH', ...extra });

test('few seats: none, or seats on at most one day in ten', () => {
  const rows = [row('2026-11-02', 'united', 40000), row('2026-11-02', 'aeroplan', 35000), row('2026-11-09', 'united', 40000),
    { ...row('2026-11-10', 'asiamiles_est', 1), estimate: true }, { ...row('2026-11-11', 'united', 1), cabins: { J: { available: false } } }];
  assert.equal(H.splitSeatDays(rows, 'J'), 2);
  assert.equal(H.splitSeatDays(rows, 'J', 3), 0, 'seat count below the party');
  assert.equal(H.splitWanted(2, 30), true);
  assert.equal(H.splitWanted(4, 30), false);
  assert.equal(H.splitWanted(0, 1), true);
  assert.equal(H.splitWanted(1, 7), false);
});

test('pairing: the second leg the same day or the next, the cheapest two tickets, same airport first', () => {
  const l1 = H.splitLegDays([row('2026-11-02', 'united', 40000), row('2026-11-02', 'aeroplan', 35000), row('2026-11-05', 'united', 30000), row('2026-11-08', 'united', 30000)], 'J');
  const l2 = H.splitLegDays([leg2('2026-11-02', 'united', 60000), leg2('2026-11-02', 'lufthansa', 70000), leg2('2026-11-06', 'aeroplan', 50000)], 'J');
  const pairs = plain(H.splitPairs(l1, l2));
  assert.deepEqual(pairs.map((p) => [p.date, p.date2, p.next, p.miles, p.a.source, p.b.source]), [
    ['2026-11-02', '2026-11-02', false, 95000, 'aeroplan', 'united'],
    ['2026-11-05', '2026-11-06', true, 80000, 'united', 'aeroplan'],
  ]);
  assert.deepEqual(pairs[0].la.map((x) => x.source), ['aeroplan', 'united'], 'the whole day for 「另有」');
  // Same-airport combinations win over a cheaper change of airport in the hub city.
  const t1 = H.splitLegDays([row('2026-11-02', 'united', 30000, { destination: 'HND' }), row('2026-11-02', 'aeroplan', 40000, { destination: 'NRT' })], 'J');
  const t2 = H.splitLegDays([leg2('2026-11-02', 'united', 50000, { origin: 'NRT' })], 'J');
  const [p] = plain(H.splitPairs(t1, t2));
  assert.deepEqual([p.a.source, p.swap, p.miles], ['aeroplan', false, 90000]);
  const [q] = plain(H.splitPairs(H.splitLegDays([row('2026-11-02', 'united', 30000, { destination: 'HND' })], 'J'), t2));
  assert.equal(q.swap, true);
});

test('per program: both tickets on one program, its cheapest paired days', () => {
  const l1 = H.splitLegDays([row('2026-11-02', 'united', 40000), row('2026-11-02', 'aeroplan', 35000), row('2026-11-05', 'united', 30000)], 'J');
  const l2 = H.splitLegDays([leg2('2026-11-02', 'united', 60000), leg2('2026-11-06', 'united', 55000), leg2('2026-11-03', 'aeroplan', 70000)], 'J');
  assert.deepEqual(plain(H.splitByProgram(l1, l2)).map((x) => [x.source, x.miles, x.date, x.date2, x.next]), [
    ['united', 85000, '2026-11-05', '2026-11-06', true],
    ['aeroplan', 105000, '2026-11-02', '2026-11-03', true],
  ]);
});

test('calls: 2 for ranges under 150 days, one more per leg for each further 150 days', () => {
  assert.equal(H.splitCalls('2026-11-01', '2026-11-30'), 2);
  assert.equal(H.splitCalls('2026-11-01', '2027-03-30'), 2);
  assert.equal(H.splitCalls('2026-11-01', '2027-04-30'), 4);
  assert.equal(H.splitCostText(2), '用 2 次查詢');
  assert.equal(H.splitCostText(4), '最多用 4 次查詢');
});

// ---------- SkyTeam route data ----------
test('SkyTeam routes: every member has an operator, the file covers the SkyTeam hubs of split-hubs.json, pairs touch a hub', () => {
  const sky = alliances.find((a) => a.id === 'skyteam').members;
  const ops = new Set(Object.values(S.OPERATORS));
  for (const c of sky) assert.ok(ops.has(c), `${c} has an operator`);
  assert.deepEqual(skyRoutes.carriers, [...sky].sort());
  const hubsNow = [...new Set(hubData.airlines.filter((a) => sky.includes(a.code)).flatMap((a) => a.hubs))].sort();
  assert.deepEqual(skyRoutes.hubs, hubsNow, 'rebuild data/skyteam-routes.json after changing SkyTeam hubs');
  const set = new Set(hubsNow);
  for (const [a, s] of Object.entries(skyRoutes.routes)) for (const e of s.split(' ')) assert.ok(set.has(a) || set.has(e.split(':')[0]), `${a} ${e}`);
  assert.deepEqual(plain(S.hubPairs({ AAA: { BBB: ['KL'], AMS: ['KL'] } }, new Set(['AMS']))), { AAA: { AMS: ['KL'] } });
});

// ---------- page wiring ----------
test('page: loaded lazily after cxfill.js, drawn by renderSearch in both branches, button names the calls', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(app, /SEARCH_SCRIPTS = \[[^\]]*'cxfill', 'hubsplit'/);
  assert.equal(app.match(/splitRender\(\); \/\/ 拆兩段查/g).length, 2);
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'hubsplit.js'), 'utf8');
  assert.match(js, /\$\{label\}（\$\{splitCostText\(calls\)\}）/);
  assert.match(js, /兩張票，前段延誤不保護；轉機時間請自己留足/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8'), /hubsplit/);
});

let base;
let server;
before(() => new Promise((r) => { delete process.env.SEATS_AERO_API_KEY; ({ server } = require('../server')); server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); }); }));
after(() => server.close());

test('/api/data/splithubs serves the hubs and SkyTeam routes on demand, outside the start-up bundles', async () => {
  const res = await fetch(`${base}/api/data/splithubs`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { hubs: hubData, skyteam: skyRoutes });
  for (const part of ['all', 'core', 'more']) assert.ok(!('splithubs' in (await (await fetch(`${base}/api/data/${part}`)).json())), part);
});
