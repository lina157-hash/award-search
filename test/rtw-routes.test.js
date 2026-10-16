// Round 8 of 環球票規劃 (public/rtw.js): the airline menu follows data/rtw-routes.json (who flies each airport pair
// nonstop), 混艙 per leg priced by each program's official rule, the airports reachable from the last stop, and the
// generator scripts/build-rtw-routes.js that builds the route file from Virtual Radar Server's CC0 data.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const B = require('../scripts/build-rtw-routes.js');

const read = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', f), 'utf8'));
const rtwData = read('rtw.json');
const charts = read('charts.json');
const asiamiles = read('asiamiles.json');
const alliances = read('alliances.json');
const routes = read('rtw-routes.json');
function grab(file, re) {
  const m = fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8').match(re);
  assert.ok(m, `${re} in ${file}`);
  return m[0];
}
const ctx = {
  data: { asiamiles, charts, rtw: rtwData }, console,
  CABIN_LABEL: { Y: '經濟艙', W: '豪華經濟艙', J: '商務艙', F: '頭等艙' },
  fmt: (n) => Number(n).toLocaleString('en-US'),
  regionName: (cc) => ({ zh: cc }),
};
vm.createContext(ctx);
vm.runInContext([
  grab('features.js', /function haversineMiles\(a, b\) \{[\s\S]*?\n\}/),
  grab('features.js', /const nonstopKey = [^\n]*/),
  grab('features.js', /function nonstopIndex\(raw\) \{[\s\S]*?\n\}/),
  grab('app.js', /function amBand\(dist, o, d\) \{[\s\S]*?\n\}/),
  fs.readFileSync(path.join(__dirname, '..', 'public', 'rtw.js'), 'utf8'),
  'this.R = { rtwTrip, rtwChecks, rtwPrice, rtwCarriers, rtwRouteIndex: nonstopIndex, rtwLegAir, rtwNextStops, rtwLegCabins, rtwCabinsOf, cxBandRoom };',
].join('\n'), ctx);
const { R } = ctx;
const plain = (x) => JSON.parse(JSON.stringify(x));

const apRows = require('../public/airports.min.json').airports;
const ap = new Map(apRows.map(([code, , , country, , , , , lat, lon]) => [code, { code, country, lat, lon }]));
const apOf = (c) => ap.get(c) || null;
const prog = (id) => rtwData.programs.find((p) => p.id === id);
const members = Object.fromEntries(alliances.alliances.map((a) => [a.id, a.members]));
function plan(codes, legs = []) {
  const stops = codes.split(' ').map((code) => ({ code, stay: 'stop' }));
  return { stops, legs: stops.slice(1).map((s, i) => ({ date: '', airline: '', surface: false, ...(legs[i] || {}) })) };
}
const trip = (p) => R.rtwTrip(p, apOf, rtwData.areas);
const index = R.rtwRouteIndex(routes);
const checks = (id, p, extra = {}) => plain(R.rtwChecks(prog(id), p, trip(p), { cabin: 'J', members, cityOf: (c) => c, today: '2026-10-16', ...extra }));
const find = (list, re) => list.find((x) => re.test(x.t));

// ---------- the generator ----------
const icao = new Map([['RCTP', 'TPE'], ['VHHH', 'HKG'], ['RJAA', 'NRT'], ['RJTT', 'HND'], ['EGLL', 'LHR'], ['KIAD', 'IAD']]);
const keep = new Set(['TPE', 'HKG', 'NRT', 'HND', 'LHR', 'IAD']);
const row = (Callsign, AirlineCode, AirportCodes) => ({ Callsign, AirlineCode, AirportCodes });
const build = (rows, more = {}) => plain(B.buildRoutes(rows, { icaoToIata: icao, keep, cityOf: (c) => (c === 'HND' ? 'NRT' : c), ...more }));

test('generator: a pair counts when the airline has it both ways; stops split into legs; one-way, same-city and unknown airports drop', () => {
  const out = build([
    row('CPA400', 'CPA', 'RCTP-VHHH'), row('CPA401', 'CPA', 'VHHH-RCTP'), // both ways: kept
    row('CPA450', 'CPA', 'VHHH-RCTP-RJAA'), row('CPA451', 'CPA', 'RJAA-RCTP-VHHH'), // a flight with a stop: each leg
    row('CPA250', 'CPA', 'VHHH-EGLL'), // one way only: dropped
    row('JAL1', 'JAL', 'RJAA-RJTT'), row('JAL2', 'JAL', 'RJTT-RJAA'), // the same city
    row('JAL3', 'JAL', 'RJAA-ZZZZ'), row('JAL4', 'JAL', 'ZZZZ-RJAA'), // unknown airport
    row('XXX1', 'XXX', 'RCTP-VHHH'), row('XXX2', 'XXX', 'VHHH-RCTP'), // not an alliance operator
  ]);
  assert.deepEqual(out, { HKG: { TPE: ['CX'] }, NRT: { TPE: ['CX'] } });
});

test('generator: mainline charter/ferry numbers and VRS positioning patterns drop; wholly owned regionals count for their airline', () => {
  const out = build([
    row('AAL9604', 'AAL', 'VHHH-RJAA'), row('AAL9605', 'AAL', 'RJAA-VHHH'), // AA 9xxx: charters
    row('BAW38X', 'BAW', 'EGLL-VHHH'), row('BAW27', 'BAW', 'VHHH-EGLL'), // letters in the number are fine
    row('QFA6001', 'QFA', 'RCTP-VHHH'), row('QFA6002', 'QFA', 'VHHH-RCTP'), // VRS: QF 6xxx is positioning
    row('ENY3401', 'ENY', 'KIAD-RCTP'), row('ENY5402', 'ENY', 'RCTP-KIAD'), // Envoy flies American Eagle (high numbers)
  ], { patterns: { QFA: [/^6\d\d\d$/] } });
  assert.deepEqual(out, { HKG: { LHR: ['BA'] }, IAD: { TPE: ['AA'] } });
  assert.deepEqual(B.packRoutes({ HKG: { TPE: ['BR', 'CX'], NRT: ['CX', 'JL'] } }), { HKG: 'NRT:CXJL TPE:BRCX' });
  // Joined VRS files repeat their header: those lines are skipped.
  assert.deepEqual(B.parseCsv('﻿Callsign,AirlineCode\nCPA1,CPA\nCallsign,AirlineCode\nCPA2,CPA\n').map((r) => r.Callsign), ['CPA1', 'CPA2']);
});

test('generator: freighter and charter number ranges drop; stale routes listed by hand drop', () => {
  const out = build([
    row('CPA2025', 'CPA', 'RCTP-VHHH'), row('CPA2026', 'CPA', 'VHHH-RCTP'), // CX 2xxx: freighters
    row('CPA80', 'CPA', 'VHHH-KIAD'), row('CPA81D', 'CPA', 'KIAD-VHHH'), // CX 1–99, a letter after the number too
    row('EVA632', 'EVA', 'RCTP-EGLL'), row('EVA631', 'EVA', 'EGLL-RCTP'), // BR 6xx: freighters
    row('EVA1361', 'EVA', 'RCTP-RJAA'), row('EVA1362', 'EVA', 'RJAA-RCTP'), // BR 1xxx: charters
    row('EVA195', 'EVA', 'RJAA-RCTP'), row('EVA196', 'EVA', 'RCTP-RJAA'), // a scheduled number: kept
    row('ANZ38', 'ANZ', 'EGLL-VHHH'), row('ANZ39', 'ANZ', 'VHHH-EGLL'), // listed as stale below
  ], { operators: { CPA: 'CX', EVA: 'BR', ANZ: 'NZ' }, stale: [['NZ', 'LHR', 'HKG', 'test']] });
  assert.deepEqual(out, { NRT: { TPE: ['BR'] } });
  // The real lists: each stale entry names an alliance airline and two known airports, with a reason.
  for (const [c, a, b, why] of B.STALE) assert.ok(members.oneworld.concat(members.star).includes(c) && ap.has(a) && ap.has(b) && why, `${c} ${a}-${b}`);
  assert.deepEqual(plain(R.rtwLegAir(index, 'TPE', 'LAX', ['MH'])).flying, [], 'MH TPE-LAX is gone');
  assert.deepEqual(plain(R.rtwLegAir(index, 'HKG', 'LHR', R.rtwCarriers(prog('asiamiles_ow'), members))).flying.sort(), ['BA', 'CX']);
});

test('generator: every member of the three alliances has an operator; regionals map to a member', () => {
  const ops = new Set(Object.values(B.OPERATORS));
  for (const id of ['oneworld', 'star', 'skyteam']) for (const c of members[id]) assert.ok(ops.has(c), `${c} (${id}) has no operator in build-rtw-routes.js`);
  for (const c of B.EXTRA_CARRIERS) assert.ok(ops.has(c), c);
  for (const op of B.REGIONAL) assert.ok(B.OPERATORS[op], op);
});

// ---------- the data file ----------
test('rtw-routes.json: CC0 source with its date, the covered airlines only, known airports, each pair once and in order', () => {
  assert.equal(routes.source.licence, 'CC0 1.0');
  assert.match(routes.source.url, /^https:\/\/github\.com\/vradarserver\/standing-data$/);
  assert.match(routes.source.fetched, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(routes.airportCodes.licence, 'Public domain');
  assert.ok(routes.method.length >= 3 && /可能漏掉/.test(routes.note));
  const allianceCodes = new Set([...members.oneworld, ...members.star, ...members.skyteam, ...B.EXTRA_CARRIERS]);
  assert.deepEqual(routes.carriers, [...allianceCodes].sort());
  const AP = new Set(ap.keys());
  let n = 0;
  for (const [a, s] of Object.entries(routes.routes)) {
    assert.ok(AP.has(a), a);
    for (const e of s.split(' ')) {
      const m = e.match(/^([A-Z]{3}):((?:[A-Z0-9]{2})+)$/);
      assert.ok(m, `${a} ${e}`);
      assert.ok(AP.has(m[1]) && a < m[1], `${a}-${m[1]}`);
      const cs = m[2].match(/../g);
      assert.ok(cs.every((c) => allianceCodes.has(c)) && new Set(cs).size === cs.length, `${a}-${m[1]} ${m[2]}`);
      n++;
    }
  }
  assert.equal(n, routes.pairs);
  assert.equal(index.pairs.size, n);
  assert.ok(fs.statSync(path.join(__dirname, '..', 'data', 'rtw-routes.json')).size < 120000, 'kept small');
});

test('the owner\'s examples: TPE→HKG offers only Cathay on oneworld; HKG→NRT offers Cathay and JAL', () => {
  const ow = R.rtwCarriers(prog('asiamiles_ow'), members);
  assert.deepEqual(plain(R.rtwLegAir(index, 'TPE', 'HKG', ow)).flying, ['CX']);
  assert.deepEqual(plain(R.rtwLegAir(index, 'HKG', 'NRT', ow)).flying.sort(), ['CX', 'JL']);
  // Either direction, any program's own order (JAL lists JL first).
  assert.deepEqual(plain(R.rtwLegAir(index, 'NRT', 'HKG', R.rtwCarriers(prog('jal_ow'), members))).flying, ['JL', 'CX']);
  // Star Alliance programs see EVA Air on Taipei–Hong Kong, never Cathay.
  const star = plain(R.rtwLegAir(index, 'TPE', 'HKG', R.rtwCarriers(prog('tap_rtw'), members)));
  assert.ok(star.flying.includes('BR') && !star.flying.includes('CX') && star.others.includes('CX'));
  assert.equal(R.rtwLegAir(null, 'TPE', 'HKG', ow), null, 'no data yet: no filter');
  const none = plain(R.rtwLegAir(index, 'TPE', 'XXX', ow));
  assert.deepEqual([none.flying, none.known], [[], false]);
});

// ---------- pure logic in rtw.js ----------
test('route index: each pair both ways, and the airports reachable from a stop with the program\'s airlines', () => {
  const ix = R.rtwRouteIndex({ routes: { HKG: 'NRT:CXJLNH TPE:BRCX', LHR: 'TPE:BR', bad: 'x', NRT: 'XX' } });
  assert.deepEqual(plain(ix.pairs.get('HKG NRT')), ['CX', 'JL', 'NH']);
  assert.deepEqual(plain([...ix.from.get('TPE').keys()]).sort(), ['HKG', 'LHR']);
  const next = plain(R.rtwNextStops(ix, 'HKG', ['JL', 'CX', 'AA']));
  assert.deepEqual(next, [{ code: 'NRT', carriers: ['JL', 'CX'] }, { code: 'TPE', carriers: ['CX'] }]);
  assert.deepEqual(plain(R.rtwNextStops(ix, 'LHR', ['CX'])), [], 'only airlines the program allows');
  assert.deepEqual(plain(R.rtwNextStops(null, 'HKG', ['CX'])), []);
  // From the real data: Hong Kong reaches many airports on Cathay.
  assert.ok(R.rtwNextStops(index, 'HKG', ['CX']).length > 40);
});

test('rule check: legs no allowed airline flies nonstop, and an airline picked for a leg it doesn\'t fly', () => {
  const ix = R.rtwRouteIndex({ routes: { HKG: 'LHR:BACX TPE:BRCX', JFK: 'LHR:AABA LAX:AAUA', HKG_: '' } });
  const p = plan('TPE HKG LHR JFK LAX TPE', [{ airline: 'CX' }, { airline: 'AA' }, { airline: 'BA' }, { airline: 'AA' }, { airline: 'CX' }]);
  const ck = checks('asiamiles_ow', p, { routes: ix });
  assert.match(find(ck, /沒有可搭的航空公司直飛/).t, /^LAX→TPE：/);
  assert.match(find(ck, /這家航空公司沒有直飛這段/).t, /HKG→LHR（AA）/);
  assert.equal(find(ck, /沒有可搭的航空公司直飛/).s, 'warn');
  assert.ok(!find(ck, /每段都有/), 'no all-clear line while a leg is flagged');
  const good = checks('asiamiles_ow', plan('TPE HKG LHR', [{ airline: 'CX' }, { airline: 'BA' }]), { routes: ix });
  assert.equal(find(good, /每段都有可搭的航空公司直飛紀錄/).s, 'ok', JSON.stringify(good));
  // Surface sectors need no airline, and without the data there is no such line.
  const open = checks('asiamiles_ow', plan('TPE HKG LHR CDG', [{}, {}, { surface: true }]), { routes: ix });
  assert.ok(!find(open, /LHR→CDG/), JSON.stringify(open));
  assert.ok(!find(checks('asiamiles_ow', p), /直飛/));
});

test('混艙: per-leg cabins price at the highest, as each program\'s official rule says; JAL takes premium economy only inside J/F', () => {
  const t = trip(plan('TPE HKG LHR', [{ cabin: 'J' }, { cabin: 'F' }]));
  assert.deepEqual(plain(R.rtwCabinsOf(prog('asiamiles_ow'), t, 'J', true)), { legs: ['J', 'F'], top: 'F', mixed: true });
  assert.deepEqual(plain(R.rtwCabinsOf(prog('asiamiles_ow'), t, 'J', false)), { legs: ['J', 'J'], top: 'J', mixed: false }, 'off: the trip cabin');
  // A cabin the program doesn't sell falls back to the trip cabin (Asia Miles: no premium economy).
  assert.deepEqual(plain(R.rtwCabinsOf(prog('asiamiles_ow'), trip(plan('TPE HKG LHR', [{ cabin: 'W' }])), 'Y', true)).legs, ['Y', 'Y']);
  assert.deepEqual(plain(R.rtwLegCabins(prog('jal_ow'))), ['Y', 'W', 'J', 'F']);
  assert.deepEqual(plain(R.rtwLegCabins(prog('asiamiles_ow'))), ['Y', 'J', 'F']);
  const mixed = (id, cabins) => {
    const p = plan('TPE HKG LHR JFK', cabins.map((cabin) => ({ cabin })));
    const c = R.rtwCabinsOf(prog(id), trip(p), 'J', true);
    return { c, ck: checks(id, p, { cabin: c.top, legCabins: c.legs }), price: R.rtwPrice(prog(id), trip(p), c.top, charts) };
  };
  const am = mixed('asiamiles_ow', ['J', 'F', 'J']);
  assert.equal(find(am.ck, /混艙/).s, 'ok');
  assert.match(find(am.ck, /混艙/).t, /最高艙等（頭等艙）/);
  assert.equal(am.price.miles, R.rtwPrice(prog('asiamiles_ow'), trip(plan('TPE HKG LHR JFK')), 'F', charts).miles);
  // JAL: a premium economy leg rides in a business award; premium economy with economy only can't be booked.
  const jw = mixed('jal_ow', ['W', 'J', 'W']);
  assert.equal(jw.c.top, 'J');
  assert.ok(jw.ck.every((x) => x.s !== 'bad'), JSON.stringify(jw.ck));
  const jy = mixed('jal_ow', ['Y', 'W', 'Y']);
  assert.equal(jy.c.top, 'W');
  assert.match(find(jy.ck, /豪華經濟艙航段只能放在/).t, /商務艙或頭等艙獎勵/);
  assert.ok(jy.price.noCabin);
  // Miles & More doesn't say: a warning that the price is a guess.
  assert.equal(find(mixed('mm_world', ['J', 'F', 'J']).ck, /混艙/).s, 'warn');
  assert.match(find(mixed('mm_world', ['J', 'F', 'J']).ck, /混艙/).t, /我推測/);
  // Same cabin on every leg: no 混艙 line.
  assert.ok(!find(mixed('qantas_ow', ['J', 'J', 'J']).ck, /混艙/));
});

test('rtw.json: every program states its mixed-cabin rule; "highest" ones cite an official page; tips are labelled third-party', () => {
  for (const p of rtwData.programs) {
    const m = p.mixedCabin;
    assert.ok(m && ['highest', 'unstated'].includes(m.pricing) && m.text, p.id);
    if (m.pricing === 'highest') assert.ok(/^https:\/\//.test(m.url) && m.quote && p.sources.some((s) => s.url.split('#')[0] === m.url.split('#')[0]), `${p.id} cites the page it quotes`);
    if (m.extraLegCabins) assert.ok(m.extraWith.every((c) => p.cabins.includes(c)), p.id);
  }
  assert.match(prog('asiamiles_ow').mixedCabin.quote, /highest class booked/);
  assert.match(prog('qantas_ow').mixedCabin.quote, /highest class booked/);
  // Asia Miles: booked through Customer Care (the T&C's list of online awards leaves it out); codeshares don't count.
  assert.match(prog('asiamiles_ow').howToBook, /客戶服務團隊/);
  assert.ok(prog('asiamiles_ow').summary.some((t) => /共用班號/.test(t)));
  for (const tips of [prog('asiamiles_ow').tips, rtwData.cxMixed.tips]) {
    assert.ok(tips.items.length && /^https:\/\/www\.scottt\.org\//.test(tips.url) && /\d{4}-\d{2}-\d{2}/.test(tips.label));
  }
  assert.ok(rtwData.cxMixed.notes.some((t) => /最多可以混搭 2 家航空公司，其中一家必須是國泰/.test(t)));
});

test('國泰混艙計算: the zone\'s range and how far the next zone starts', () => {
  assert.deepEqual(plain(R.cxBandRoom(asiamiles, 2306)), { lo: 751, hi: 2750, left: 445, next: '中程' });
  assert.deepEqual(plain(R.cxBandRoom(asiamiles, 750)), { lo: 1, hi: 750, left: 1, next: '短程' });
  const top = plain(R.cxBandRoom(asiamiles, 9000));
  assert.deepEqual([top.hi, top.left, top.next], [null, null, '']);
});

// ---------- served on demand ----------
let base;
let server;
before(() => new Promise((r) => { delete process.env.SEATS_AERO_API_KEY; ({ server } = require('../server')); server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); }); }));
after(() => server.close());

test('/api/data/rtwroutes serves the route data when the page opens, outside the start-up bundles', async () => {
  const res = await fetch(`${base}/api/data/rtwroutes`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), routes);
  for (const part of ['all', 'core', 'more']) assert.ok(!('rtwroutes' in (await (await fetch(`${base}/api/data/${part}`)).json())), part);
  // One loader (features.js nonstopLoad) for 環球票規劃 and mapkit.js.
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'public', 'features.js'), 'utf8'), /api\('\/api\/data\/rtwroutes'\)/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'public', 'rtw.js'), 'utf8'), /nonstopLoad\(\)/);
});
