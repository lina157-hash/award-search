// Accor hotels priced in ALL points: brand filter, points rule, the Booking.com city search and its caching.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
delete process.env.SEATS_AERO_API_KEY;
delete process.env.CASH_PASSCODE;
const { server } = require('../server');
const { brandOf, pointsFor, accorAnswer, RULE, isAccorTitle } = require('../lib/accor');
const { bookingHotels } = require('../lib/hotelcash');
const { memoryKv, sharedCache } = require('../lib/kv');

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());
const isoIn = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

test('Accor brands are recognised from Booking.com names, look-alikes are not', () => {
  const yes = {
    'Sofitel Legend Metropole Hanoi': 'Sofitel Legend', 'Sofitel Bangkok Sukhumvit': 'Sofitel', 'SO/ Bangkok': 'SO/', 'Raffles Singapore': 'Raffles',
    'Fairmont Tokyo': 'Fairmont', 'Pullman Tokyo Tamachi': 'Pullman', 'Swissôtel Bangkok Ratchada': 'Swissôtel', 'Movenpick Hotel Sukhumvit 15': 'Mövenpick',
    'Mövenpick BDMS Wellness Resort': 'Mövenpick', 'Grand Mercure Bangkok Atrium': 'Grand Mercure', 'Mercure Tokyo Ginza': 'Mercure', 'Novotel Living Bangkok': 'Novotel',
    'ibis Styles Tokyo Bay': 'ibis Styles', 'ibis budget Singapore Ruby': 'ibis budget', 'ibis Tokyo Shinjuku': 'ibis', 'Hotel Molitor Paris - MGallery': 'MGallery',
    'Aparthotel Adagio Paris Centre Tour Eiffel': 'Adagio', 'Peppers Soul Surfers Paradise': 'Peppers', 'The Sebel Sydney Chatswood': 'The Sebel', 'Mantra on Russell': 'Mantra',
    '25hours Hotel Paris Terminus Nord': '25hours', 'TRIBE Perth': 'Tribe', 'Mama Shelter Paris East': 'Mama Shelter', 'Banyan Tree Bangkok': 'Banyan Tree', 'greet hotel Beaune': 'greet',
  };
  for (const [name, brand] of Object.entries(yes)) assert.equal(brandOf(name), brand, name);
  for (const name of ['Hotel Indigo Tokyo Shibuya', 'Tokyo Marriott Hotel', 'Hyde Park Hotel London', 'Hotel Adagio Rome', 'IntercityHotel Berlin Hauptbahnhof', 'Steigenberger Hotel Herrenhof', 'Zleep Hotel Copenhagen', 'Hotel Gracery Shinjuku', 'Peninsula Bangkok', '']) {
    assert.equal(brandOf(name), null, name);
  }
});

test('ALL points: 50 per euro, 1,000 minimum, then 2,000-point steps never above the total', () => {
  assert.deepEqual([RULE.pointsPerEuro, RULE.minPoints, RULE.step], [50, 1000, 2000]);
  assert.match(RULE.source, /^https:\/\/all\.accor\.com\//);
  assert.deepEqual(pointsFor(40), { points: 2000, usablePoints: 2000, usableEur: 40 });
  assert.deepEqual(pointsFor(119.5), { points: 5975, usablePoints: 4000, usableEur: 80 });
  assert.deepEqual(pointsFor(25), { points: 1250, usablePoints: 1000, usableEur: 20 });
  assert.deepEqual(pointsFor(15), { points: 750, usablePoints: 0, usableEur: 0 });
  assert.equal(pointsFor(null).points, null);
  const a = accorAnswer({ found: true, city: 'Tokyo', hotels: [
    { id: '1', name: 'Hotel Indigo Tokyo Shibuya', total: 9000, currency: 'TWD' },
    { id: '2', name: 'Pullman Tokyo Tamachi', total: 7162, currency: 'TWD', stars: 4 },
    { id: '3', name: 'ibis Tokyo Shinjuku', total: null, currency: 'TWD', soldOut: true },
    { id: '4', name: 'Mercure Tokyo Ginza', total: 3581, currency: 'TWD' },
  ] }, { eurRate: 35.81, nights: 2 });
  assert.deepEqual(a.hotels.map((h) => [h.brand, h.total, h.totalEur, h.points, h.usablePoints, h.cashLeftTwd, h.soldOut]), [
    ['Mercure', 3581, 100, 5000, 4000, 716, false],
    ['Pullman', 7162, 200, 10000, 10000, 0, false],
    ['ibis', null, null, null, 0, null, true],
  ]);
  assert.equal(a.pointValueTwd, 0.72);
});

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
test('Booking.com city search: two requests at most, city id cached, a cache hit costs nothing', async () => {
  const calls = [];
  const kv = memoryKv();
  let quota;
  const tokyo = b64({ city_name: 'Tokyo', country: 'Japan', dest_id: '-246227', dest_type: 'city' });
  const fetchImpl = async (url) => {
    const u = new URL(String(url));
    assert.equal(u.host, 'booking-com18.p.rapidapi.com');
    calls.push(u.pathname + (u.searchParams.get('page') ? `#${u.searchParams.get('page')}` : ''));
    const headers = { 'x-ratelimit-requests-remaining': String(530 - calls.length), 'x-ratelimit-requests-limit': '530' };
    if (u.pathname === '/stays/auto-complete') {
      return Response.json({ status: true, data: [{ id: tokyo, name: 'Tokyo', latitude: 35.68, longitude: 139.76 }, { id: b64({ city_name: 'Tokyo', dest_id: '-9', dest_type: 'city' }), name: 'Tokyo, Ohio', latitude: 39, longitude: -84 }, { id: b64({ dest_id: '5', dest_type: 'hotel' }), name: 'Tokyo Hotel' }] }, { headers });
    }
    assert.equal(u.searchParams.get('locationId'), tokyo, 'the city nearest to the given position');
    assert.equal(u.searchParams.get('currencyCode'), 'TWD');
    const page = Number(u.searchParams.get('page'));
    return Response.json({ status: true, data: page === 1
      ? [{ id: 1, name: 'Pullman Tokyo Tamachi', priceBreakdown: { grossPrice: { value: 20000, currency: 'TWD' } }, propertyClass: 4, latitude: 35.64, longitude: 139.75 }, { id: 2, name: 'Tokyo Marriott Hotel', priceBreakdown: { grossPrice: { value: 25000, currency: 'TWD' } } }]
      : [{ id: 3, name: 'ibis Tokyo Shinjuku', priceBreakdown: { grossPrice: { value: 8000, currency: 'TWD' } } }] }, { headers });
  };
  const lookup = bookingHotels({ apiKey: 'r', kv, fetchImpl, onQuota: (q) => { quota = q; } });
  const want = { city: 'Tokyo', checkin: '2026-12-01', checkout: '2026-12-03', adults: 2, lat: 35.68, lon: 139.76 };
  const first = await lookup.city(want);
  assert.deepEqual(calls, ['/stays/auto-complete', '/stays/search#1']);
  assert.equal(first.requests, 2);
  assert.deepEqual(quota, { left: 528, limit: 530 });
  assert.match(first.url, /dest_id=-246227&dest_type=city/);
  const again = await lookup.city(want);
  assert.deepEqual(calls.slice(2), ['/stays/search#1', '/stays/search#2'], 'with the city id cached, both requests are result pages');
  assert.equal(again.hotels.length, 3);
  assert.match(again.url, /dest_id=-246227/);
  const answer = accorAnswer(again, { eurRate: 36, nights: 2 });
  assert.deepEqual(answer.hotels.map((h) => [h.name, h.total, h.stars]), [['ibis Tokyo Shinjuku', 8000, null], ['Pullman Tokyo Tamachi', 20000, 4]]);
  // The whole answer is shared: the same query again spends nothing.
  let spent = 0;
  const run = () => sharedCache(kv, 'accor:v1:' + JSON.stringify(want), 6 * 3600, async () => { spent++; return accorAnswer(await lookup.city(want), { eurRate: 36, nights: 2 }); });
  await run();
  const n = calls.length;
  await run();
  assert.deepEqual([spent, calls.length], [1, n]);
});

test('Booking.com city search with a brand filter: Accor brands asked for by filter id, filter ids kept per city', async () => {
  const calls = [];
  const kv = memoryKv();
  const fetchImpl = async (url) => {
    const u = new URL(String(url));
    calls.push(u.pathname);
    if (u.hostname === 'booking-com18.p.rapidapi.com') return new Response(JSON.stringify({ message: 'You are not subscribed to this API.' }), { status: 403 });
    if (u.pathname === '/api/v1/hotels/searchDestination') return Response.json({ status: true, data: [{ dest_id: '-3414440', search_type: 'city', name: 'Bangkok' }] });
    if (u.pathname === '/api/v1/hotels/getFilter') {
      return Response.json({ status: true, data: { filters: [
        { title: 'Property rating', field: 'class', options: [{ title: '5 stars', genericId: 'class::5' }] },
        { title: 'Brands', field: 'chaincode', options: [{ title: 'Novotel', genericId: 'chaincode::1053' }, { title: 'Marriott Hotels & Resorts', genericId: 'chaincode::1001' }, { title: 'ibis Styles', genericId: 'chaincode::1121' }, { title: 'Steigenberger', genericId: 'chaincode::1400' }] },
      ] } });
    }
    assert.equal(u.searchParams.get('categories_filter'), 'chaincode::1053,chaincode::1121');
    return Response.json({ status: true, data: { hotels: [{ hotel_id: 7, property: { name: 'Novotel Bangkok Sukhumvit 20', priceBreakdown: { grossPrice: { value: 9000, currency: 'TWD' } } } }] } });
  };
  const lookup = bookingHotels({ apiKey: 'r', kv, fetchImpl });
  const want = { city: 'Bangkok', checkin: '2026-11-26', checkout: '2026-11-28', adults: 2, lat: null, lon: null };
  const first = await lookup.city(want, { brands: isAccorTitle });
  assert.deepEqual(calls.filter((c) => c.startsWith('/api/')), ['/api/v1/hotels/searchDestination', '/api/v1/hotels/getFilter', '/api/v1/hotels/searchHotels']);
  assert.equal(first.requests, 3, 'a new city: city id, filters, one page');
  assert.deepEqual(first.debug.filters.matched, ['Novotel=chaincode::1053', 'ibis Styles=chaincode::1121']);
  assert.deepEqual(accorAnswer(first, { eurRate: 36, nights: 2 }).hotels.map((h) => h.brand), ['Novotel']);
  calls.length = 0;
  const again = await lookup.city({ ...want, checkin: '2026-12-01', checkout: '2026-12-03' }, { brands: isAccorTitle });
  assert.deepEqual(calls, ['/api/v1/hotels/searchHotels'], 'same city: city id and filters cached, one filtered page');
  assert.equal(again.requests, 1);
});

test('Things4u brand filter: get-filters genericIds go back as categoriesFilter', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(String(url));
    calls.push(u.pathname);
    if (u.pathname === '/stays/auto-complete') return Response.json({ status: true, data: [{ id: b64({ city_name: 'Bangkok', dest_id: '-3414440', dest_type: 'city' }), name: 'Bangkok' }] });
    if (u.pathname === '/stays/get-filters') return Response.json({ status: true, data: { filters: [{ field: 'chaincode', title: 'Brands', options: [{ value: { text: 'Novotel', __typename: 'TranslatedString' }, genericId: 'chaincode::1050' }, { value: { text: 'Hilton Hotels & Resorts' }, genericId: 'chaincode::1000' }, { value: { text: 'Pullman Hotels and Resorts' }, genericId: 'chaincode::1049' }] }] } });
    assert.equal(u.searchParams.get('categoriesFilter'), 'chaincode::1050,chaincode::1049');
    return Response.json({ status: true, data: [{ id: 7, name: 'Novotel Bangkok Sukhumvit 20', priceBreakdown: { grossPrice: { value: 9000, currency: 'TWD' } } }] });
  };
  const lookup = bookingHotels({ apiKey: 'r', kv: memoryKv(), fetchImpl });
  const r = await lookup.city({ city: 'Bangkok', checkin: '2026-11-26', checkout: '2026-11-28', adults: 2, lat: null, lon: null }, { brands: isAccorTitle });
  assert.deepEqual(calls, ['/stays/auto-complete', '/stays/get-filters', '/stays/search']);
  assert.deepEqual([r.requests, r.hotels[0].total, r.url.includes('dest_id=-3414440')], [3, 9000, true]);
});

test('/api/hotels/accor: demo list, validation, passcode, config flag', async () => {
  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.equal(cfg.hotels.accor, true);
  const res = await fetch(`${base}/api/hotels/accor?city=Bangkok&checkin=${isoIn(30)}&checkout=${isoIn(32)}&adults=2`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.equal(body.mock, true);
  assert.equal(body.nights, 2);
  assert.ok(body.hotels.length >= 6);
  assert.ok(body.hotels.every((h) => h.brand && !/Indigo|Marriott/.test(h.name)));
  const priced = body.hotels.filter((h) => !h.soldOut);
  assert.ok(priced.every((h) => h.total > 0 && h.totalEur > 0 && h.points === Math.ceil(h.totalEur * 50) && h.pointValueTwd > 0));
  assert.match(body.rule.text, /2,000 點折 €40/);
  for (const q of [`city=&checkin=${isoIn(30)}&checkout=${isoIn(32)}`, `city=Tokyo&checkin=${isoIn(30)}&checkout=${isoIn(60)}`, `city=Tokyo&checkin=2026-02-30&checkout=2026-03-02`]) {
    assert.equal((await fetch(`${base}/api/hotels/accor?${q}`)).status, 400, q);
  }
  process.env.CASH_PASSCODE = 'pw';
  try {
    assert.equal((await fetch(`${base}/api/hotels/accor?city=Tokyo&checkin=${isoIn(30)}&checkout=${isoIn(31)}`)).status, 401);
  } finally { delete process.env.CASH_PASSCODE; }
});

test('brand filter: when the city filter list cannot be read, the known Accor brand ids are used', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    const u = new URL(String(url));
    seen.push(u.pathname);
    if (u.pathname === '/stays/auto-complete') return Response.json({ status: true, data: [{ id: Buffer.from(JSON.stringify({ dest_id: '-246227', dest_type: 'city' })).toString('base64'), name: 'Tokyo' }] });
    if (u.pathname === '/stays/get-filters') return Response.json({ status: true, data: { something: 'else' } });
    assert.equal(u.searchParams.get('categoriesFilter'), 'chaincode::1050,chaincode::1053');
    const zh = u.searchParams.get('languageCode') === 'zh-tw';
    return Response.json({ status: true, data: [{ id: 1, name: zh ? '東京新宿諾富特酒店' : 'Novotel Tokyo Shinjuku', priceBreakdown: { grossPrice: { value: 9000, currency: 'TWD' } } }] });
  };
  const lookup = bookingHotels({ apiKey: 'r', kv: memoryKv(), fetchImpl });
  const r = await lookup.city({ city: 'Tokyo', checkin: '2026-11-22', checkout: '2026-11-24', adults: 2, lat: null, lon: null }, { brands: isAccorTitle, brandIds: ['chaincode::1050', 'chaincode::1053'], zhNames: true });
  assert.deepEqual(seen, ['/stays/auto-complete', '/stays/get-filters', '/stays/search', '/stays/search'], 'the last request is the Chinese names');
  assert.equal(r.requests, 4);
  assert.deepEqual(accorAnswer(r, { eurRate: 36, nights: 2 }).hotels.map((h) => [h.name, h.nameZh]), [['Novotel Tokyo Shinjuku', '東京新宿諾富特酒店']]);
  assert.match(r.debug.filters.shape, /something/);
});
