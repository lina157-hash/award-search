// Demo data in seats.aero's raw response shape, used when no API key is set.
// Numbers are made up; the UI labels them as demo data.
const airlines = require('../data/airlines.json').airlines;

function hash(str) {
  let h = 2166136261;
  for (const ch of str) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

const BASE_MILES = { Y: 30000, W: 50000, J: 75000, F: 110000 };
const SOURCES_BY_CARRIER = Object.fromEntries(airlines.map((a) => [a.code, a.bookableVia]));
const carrierById = new Map();
const ROUTE_CARRIERS = ['BR', 'CI', 'CX', 'AC', 'AF', 'KL', 'JL', 'NH', 'UA', 'DL'];

function* dates(start, end) {
  const d = new Date(start + 'T00:00:00Z');
  const last = new Date(end + 'T00:00:00Z');
  while (d <= last) {
    yield d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

const MOCK_FLEET = ['77W', '789', '781', '359', '351', '388', '333', '321'];

function mockSearch({ origin_airport, destination_airport, start_date, end_date, carriers, sources, include_trips }) {
  const out = [];
  const carrierFilter = carriers ? carriers.split(',') : null;
  const sourceFilter = sources ? sources.split(',') : null;
  for (const o of origin_airport.split(',')) {
    for (const d of destination_airport.split(',')) {
      const routeKey = o + d;
      const routeCarriers = ROUTE_CARRIERS.filter((c, i) => (hash(routeKey) >> i) & 1).slice(0, 4);
      if (!routeCarriers.length) routeCarriers.push('BR');
      const distance = 1000 + (hash(routeKey) % 9000);
      for (const date of dates(start_date, end_date)) {
        const programs = new Set(routeCarriers.flatMap((c) => SOURCES_BY_CARRIER[c] || []));
        for (const source of programs) {
          if (sourceFilter && !sourceFilter.includes(source)) continue;
          const h = hash(routeKey + date + source);
          const item = {
            ID: `mock-${routeKey}-${date}-${source}`,
            RouteID: `mock-${routeKey}-${source}`,
            Route: { OriginAirport: o, DestinationAirport: d, Distance: distance, Source: source },
            Date: date,
            Source: source,
            UpdatedAt: new Date(Date.now() - (h % 72) * 3600e3).toISOString(),
          };
          let any = false;
          ['Y', 'W', 'J', 'F'].forEach((c, i) => {
            const ops = routeCarriers.filter((rc) => (SOURCES_BY_CARRIER[rc] || []).includes(source));
            const opsForCabin = ops.filter((_, j) => ((h >>> (i * 3 + j)) & 3) !== 0);
            const available = opsForCabin.length > 0 && ((h >>> (i * 5)) & 3) !== 0 && !(c === 'F' && h % 3);
            const shown = carrierFilter ? opsForCabin.filter((x) => carrierFilter.includes(x)) : opsForCabin;
            const ok = available && shown.length > 0;
            any ||= ok;
            item[`${c}Available`] = ok;
            item[`${c}MileageCost`] = ok ? String(Math.round((BASE_MILES[c] * (0.8 + ((h >>> i) % 7) / 10) * distance) / 6000 / 500) * 500) : '0';
            item[`${c}RemainingSeats`] = ok ? 1 + ((h >>> (i + 2)) % 4) : 0;
            item[`${c}Airlines`] = ok ? shown.join(', ') : '';
            item[`${c}Direct`] = ok && ((h >>> (i + 7)) & 1) === 1;
          });
          if (any) {
            carrierById.set(item.ID, (item.JAirlines || item.YAirlines || item.WAirlines || item.FAirlines).split(',')[0]);
            // What `include_trips=true` adds: one trip per available cabin, with taxes in cents.
            if (include_trips) item.AvailabilityTrips = ['Y', 'W', 'J', 'F'].filter((c) => item[`${c}Available`]).map((c) => ({
              Cabin: { Y: 'economy', W: 'premium', J: 'business', F: 'first' }[c], MileageCost: Number(item[`${c}MileageCost`]),
              TotalTaxes: (1500 + (h % 9000)) * 100, TaxesCurrency: 'TWD', TaxesCurrencySymbol: 'NT$',
              AvailabilitySegments: item[`${c}Airlines`].split(', ').slice(0, 1).map((al) => ({
                FlightNumber: `${al}${10 + (h % 80)}`, OriginAirport: o, DestinationAirport: d, AircraftCode: MOCK_FLEET[(h >>> 4) % MOCK_FLEET.length], Order: 0,
              })),
            }));
            out.push(item);
          }
        }
      }
    }
  }
  return out;
}

function mockTrips(id) {
  const [, o_d, ...rest] = id.split('-');
  const source = rest.pop();
  const date = rest.join('-');
  const o = o_d.slice(0, 3);
  const d = o_d.slice(3, 6);
  const h = hash(id);
  const carrier = carrierById.get(id) || 'BR';
  const flight = `${carrier}${10 + (h % 890)}`;
  const dep = `${date}T${String(8 + (h % 14)).padStart(2, '0')}:${h % 2 ? '30' : '05'}:00Z`;
  const arr = new Date(new Date(dep).getTime() + (5 + (h % 9)) * 3600e3).toISOString();
  return {
    data: ['J', 'Y'].map((cabin) => ({
      ID: `${id}-${cabin}`,
      Cabin: cabin === 'J' ? 'business' : 'economy',
      MileageCost: cabin === 'J' ? 70000 : 30000,
      TotalTaxes: 850000,
      TaxesCurrency: 'TWD',
      TaxesCurrencySymbol: 'NT$',
      RemainingSeats: 2,
      Stops: 0,
      Carriers: carrier,
      FlightNumbers: flight,
      DepartsAt: dep,
      ArrivesAt: arr,
      TotalDuration: Math.round((new Date(arr) - new Date(dep)) / 60000),
      Source: source,
      AvailabilitySegments: [
        { FlightNumber: flight, OriginAirport: o, DestinationAirport: d, DepartsAt: dep, ArrivesAt: arr, AircraftName: 'Boeing 777-300ER', AircraftCode: '77W', FareClass: cabin === 'J' ? 'I' : 'X', Distance: 1000 + (hash(o + d) % 9000), Order: 0 },
      ],
    })),
    booking_links: [{ label: `${source} 官網訂位`, link: '#demo', primary: true }],
  };
}

function mockAvailability({ source, start_date, end_date }) {
  const pairs = [['TPE', 'YVR'], ['TPE', 'SFO'], ['HKG', 'LAX'], ['TPE', 'CDG'], ['NRT', 'JFK'], ['TPE', 'AMS'], ['TPE', 'LAX'], ['HKG', 'YVR'], ['ICN', 'SEA'], ['HND', 'ORD'], ['SIN', 'LHR'], ['BKK', 'FRA']];
  return pairs.flatMap(([o, d]) => mockSearch({ origin_airport: o, destination_airport: d, start_date, end_date, sources: source }));
}

// Cash fares in SerpApi google_flights shape. Prices in TWD are made up.
const alliances = require('../data/alliances.json').alliances;
const ALLIANCE_IDS = { STAR_ALLIANCE: 'star', SKYTEAM: 'skyteam', ONEWORLD: 'oneworld' };
const HUBS = { CX: 'HKG', BR: 'TPE', CI: 'TPE', JL: 'NRT', NH: 'HND', SQ: 'SIN', KE: 'ICN', QR: 'DOH', TK: 'IST', AF: 'CDG', KL: 'AMS', BA: 'LHR', UA: 'SFO', DL: 'SEA', AC: 'YVR' };
const CLASS_NAMES = { 1: '經濟艙', 2: '豪華經濟艙', 3: '商務艙', 4: '頭等艙' };
const CLASS_MULT = { 1: 1, 2: 1.8, 3: 4, 4: 7 };
const AIRCRAFT = ['Boeing 777-300ER', 'Airbus A350-900', 'Boeing 787-9', 'Airbus A321neo', 'Boeing 787-10'];

let airportIndex;
function airportInfo(code) {
  if (!airportIndex) {
    try {
      airportIndex = new Map(require('../public/airports.min.json').airports.map((r) => [r[0], { name: r[2], lat: r[8], lon: r[9] }]));
    } catch {
      airportIndex = new Map();
    }
  }
  return airportIndex.get(code);
}

// Great-circle miles between two airports; falls back to a stable made-up number.
function miles(a, b) {
  const x = airportInfo(a);
  const y = airportInfo(b);
  if (!x || !y) return 1000 + (hash(a + b) % 6000);
  const rad = Math.PI / 180;
  const h = Math.sin(((y.lat - x.lat) * rad) / 2) ** 2 + Math.cos(x.lat * rad) * Math.cos(y.lat * rad) * Math.sin(((y.lon - x.lon) * rad) / 2) ** 2;
  return Math.round(2 * 3959 * Math.asin(Math.sqrt(h)));
}

function mockCash({ departure_id, arrival_id, outbound_date, return_date, type = 1, travel_class = 1, adults = 1, stops = 0, include_airlines, departure_token, booking_token }) {
  if (booking_token) return mockBooking({ departure_id, arrival_id, outbound_date, return_date, type, travel_class, adults, include_airlines, booking_token });
  const returning = Boolean(departure_token);
  const o = (returning ? arrival_id : departure_id).split(',')[0];
  const d = (returning ? departure_id : arrival_id).split(',')[0];
  const date = returning ? return_date : outbound_date;
  let carriers = airlines.map((a) => a.code);
  if (include_airlines) {
    const allow = new Set(include_airlines.split(',').flatMap((c) => (ALLIANCE_IDS[c] ? alliances.find((x) => x.id === ALLIANCE_IDS[c]).members : [c])));
    carriers = carriers.filter((c) => allow.has(c));
  }
  const dist = miles(o, d);
  const at = (mins) => {
    const t = new Date(`${date}T00:00:00Z`);
    t.setUTCMinutes(mins);
    return t.toISOString().slice(0, 16).replace('T', ' ');
  };
  const options = [];
  carriers.forEach((c) => {
    const h = hash(o + d + date + c + (returning ? 'r' : ''));
    const hub = HUBS[c];
    // Carriers fly direct from their hub; others connect only when the hub is roughly on the way.
    const direct = Boolean(hub) && (miles(o, hub) < 150 || miles(hub, d) < 150);
    if (!direct && (!hub || miles(o, hub) + miles(hub, d) > dist * 1.3 + 300)) return;
    const legs = direct ? [[o, d]] : [[o, hub], [hub, d]];
    let clock = 7 * 60 + (h % 840);
    const flights = legs.map(([a, b], j) => {
      const dur = Math.round(miles(a, b) / 8) + 35;
      const dep = clock;
      clock += dur + 70 + ((h >>> (j + 3)) % 150);
      return {
        departure_airport: { name: airportInfo(a)?.name || a, id: a, time: at(dep) },
        arrival_airport: { name: airportInfo(b)?.name || b, id: b, time: at(dep + dur) },
        duration: dur, airplane: AIRCRAFT[(h >>> j) % AIRCRAFT.length], airline: (airlines.find((x) => x.code === c) || {}).name || c,
        airline_logo: '', travel_class: CLASS_NAMES[travel_class], flight_number: `${c} ${10 + ((h >>> (j * 4)) % 880)}`,
        legroom: travel_class >= 3 ? '78 英吋' : '31 英吋', extensions: [], ...(j === 0 && (h & 8) ? { often_delayed_by_over_30_min: true } : {}),
      };
    });
    const layovers = direct ? [] : [{ duration: 70 + ((h >>> 3) % 150), name: airportInfo(hub)?.name || hub, id: hub }];
    const total = flights.reduce((t, f) => t + f.duration, 0) + layovers.reduce((t, l) => t + l.duration, 0);
    const oneWay = (dist * 5 + 3500 + (h % 4000)) * CLASS_MULT[travel_class] * (direct ? 1.1 : 1);
    options.push({
      flights, layovers, total_duration: total, price: Math.round((oneWay * (type === 1 ? 1.6 : 1) * adults) / 100) * 100,
      type: type === 1 ? '來回' : '單程', airline_logo: '',
      carbon_emissions: { this_flight: dist * 90 * CLASS_MULT[travel_class], typical_for_this_route: dist * 95, difference_percent: (h % 30) - 15 },
      ...(type === 1 && !returning ? { departure_token: `mock-${c}` } : { booking_token: `mock-b-${c}` }),
    });
  });
  const shown = options.filter((x) => stops !== 1 || x.layovers.length === 0).sort((a, b) => a.price - b.price);
  const prices = shown.map((x) => x.price);
  return {
    search_metadata: { google_flights_url: '' },
    best_flights: shown.slice(0, 3),
    other_flights: shown.slice(3),
    price_insights: prices.length ? {
      lowest_price: prices[0], price_level: ['low', 'typical', 'high'][hash(o + d) % 3],
      typical_price_range: [Math.round((prices[0] * 1.05) / 100) * 100, Math.round((prices[0] * 1.5) / 100) * 100],
      price_history: Array.from({ length: 60 }, (_, k) => [Math.floor(Date.now() / 1000) - (60 - k) * 86400, Math.round(prices[0] * (1 + ((hash(o + d + k) % 40) - 10) / 100))]),
    } : undefined,
  };
}

// Booking options for a chosen itinerary: the airline itself plus two agencies, with form-style booking requests.
function mockBooking(p) {
  const code = String(p.booking_token).replace(/^mock-b-/, '');
  const pick = (opts) => opts.find((x) => x.flights[0].flight_number.startsWith(`${code} `)) || opts[0];
  const out = pick(allFlights({ ...p, booking_token: undefined, departure_token: undefined }));
  const back = p.type === 1 ? pick(allFlights({ ...p, booking_token: undefined, departure_token: 'x' })) : null;
  const price = (back || out || { price: 0 }).price;
  const name = (airlines.find((x) => x.code === code) || {}).name || code;
  const h = hash(code + p.outbound_date);
  const req = (seller) => ({ url: 'https://www.google.com/travel/flights', post_data: `u=mock&seller=${encodeURIComponent(seller)}` });
  return {
    search_metadata: { google_flights_url: '' },
    selected_flights: [out, back].filter(Boolean),
    booking_options: [
      { together: { book_with: name, price, baggage_prices: ['隨身行李 1 件', '託運行李 1 件（23 公斤）'], option_title: '官網訂票', booking_request: req(name) } },
      { together: { book_with: 'Trip.com', price: price - 200 - (h % 500), baggage_prices: ['隨身行李 1 件', '託運行李 1 件'], extensions: ['可能有額外手續費'], booking_request: req('Trip.com') } },
      { together: { book_with: '易遊網 ezTravel', price: price + 300, baggage_prices: ['隨身行李 1 件'], booking_phone: '+886 2 4128 000', estimated_phone_service_fee: 0 } },
    ],
  };
}

function allFlights(p) {
  const r = mockCash(p);
  return [...r.best_flights, ...r.other_flights];
}

// ---------- rooms.aero (hotel points) demo data, in its raw response shape ----------
const MOCK_HOTELS = [
  ['marriott', 'Marriott Bonvoy', 'JW Marriott Hotel', 'JW', 1.0], ['marriott', 'Marriott Bonvoy', 'The Ritz-Carlton', 'RZ', 1.6], ['marriott', 'Marriott Bonvoy', 'Courtyard by Marriott', 'CY', 0.45],
  ['hilton', 'Hilton Honors', 'Conrad', 'CH', 1.5], ['hilton', 'Hilton Honors', 'Hilton', 'HI', 1.0], ['ihg', 'IHG One Rewards', 'InterContinental', 'IC', 1.1],
  ['ihg', 'IHG One Rewards', 'Holiday Inn Express', 'EX', 0.4], ['hyatt', 'World of Hyatt', 'Park Hyatt', 'park', 1.4], ['hyatt', 'World of Hyatt', 'Hyatt Regency', 'regency', 0.7],
];
const POINT_BASE = { marriott: 50000, hilton: 70000, ihg: 45000, hyatt: 21000 };
const USD_PER_POINT = { marriott: 0.0085, hilton: 0.005, ihg: 0.0065, hyatt: 0.019 };
function mockHotel(i, city) {
  const [source, program, brandName, brand] = MOCK_HOTELS[i];
  const id = `demo${i}${hash(city) % 1000}`;
  return { id, source, program, name: `${brandName} ${city}`, brand, award_category: '', address: '', city, state: '', country: '', latitude: 0, longitude: 0, image_url: '', description: '', internal_id: id,
    open: true, url: '', standard_award_availability_percent: 30 + (hash(id) % 60), standard_award_availability_window_days: 90, last_checked_at: new Date(Date.now() - (hash(id) % 20) * 3600e3).toISOString() };
}
function mockStay(i, city, date, nights) {
  const [source, , , , mult] = MOCK_HOTELS[i];
  const h = hash(`${i}${city}${date}`);
  const award = h % 5 === 0 ? 0 : Math.round((POINT_BASE[source] * mult * (0.8 + (h % 40) / 100)) / 500) * 500 * nights;
  const cash = Math.round(POINT_BASE[source] * mult * USD_PER_POINT[source] * (0.85 + (h % 50) / 100) * 100) * nights;
  return { award, cash, suite: h % 3 === 0 ? award * 2 : 0 };
}
const cityOf = (p) => String(p.location || 'Tokyo').replace(/[^\w\s-]/g, '').trim() || 'Tokyo';
function mockRoomsSearch(p) {
  const city = cityOf(p);
  const nights = Number(p.nights) || 1;
  const allowed = p.source ? String(p.source).split(',') : null;
  const data = MOCK_HOTELS.map((_, i) => i).filter((i) => !allowed || allowed.includes(MOCK_HOTELS[i][0])).map((i) => {
    let best = null;
    for (const d of dates(p.start_date, p.end_date)) {
      const s = mockStay(i, city, d, nights);
      if (s.award && (!best || s.award < best.s.award)) best = { d, s };
    }
    if (!best) return null;
    return { hotel: mockHotel(i, city), lowest_award_standard: best.s.award, lowest_award_suite: best.s.suite, lowest_cash_standard: best.s.cash, lowest_cash_suite: best.s.suite ? best.s.cash * 2 : 0,
      currency_code: 'USD', standard_date: best.d, standard_nights: nights, suite_date: best.s.suite ? best.d : '', suite_nights: best.s.suite ? nights : 0,
      cpp: Math.round((best.s.cash / best.s.award) * 100) / 100, last_checked_at: new Date().toISOString() };
  }).filter(Boolean).sort((a, b) => a.lowest_award_standard - b.lowest_award_standard);
  return { data, count: data.length, has_more: false };
}
function mockRoomsAvailability(p) {
  const [i, city] = demoHotelRef(p.hotel_id);
  const nights = Number(p.nights) || 1;
  const data = [];
  for (const d of dates(p.start_date, p.end_date)) {
    const s = mockStay(i, city, d, nights);
    const dep = new Date(Date.parse(d) + nights * 864e5).toISOString().slice(0, 10);
    data.push({ id: `${p.hotel_id}_${d}_${nights}`, hotel_id: p.hotel_id, hotel: mockHotel(i, city), source: MOCK_HOTELS[i][0], arrival_date: d, departure_date: dep, num_nights: nights, cash_currency_code: 'USD',
      standard_award_available: Boolean(s.award), standard_award_cost: s.award, standard_cash_available: true, standard_cash_cost: s.cash, standard_cpp: s.award ? Math.round((s.cash / s.award) * 100) / 100 : 0,
      suite_award_available: Boolean(s.suite), suite_award_cost: s.suite, suite_cash_available: Boolean(s.suite), suite_cash_cost: s.suite ? s.cash * 2 : 0, suite_cpp: s.suite ? Math.round((s.cash / s.award) * 100) / 100 : 0,
      booking_link: { label: `Book via ${MOCK_HOTELS[i][1]}`, url: 'https://rooms.aero/' }, last_checked_at: new Date().toISOString(), created_at: new Date().toISOString() });
  }
  return { data, count: data.length, has_more: false };
}
// Demo ids carry the hotel index; the city is not recoverable, so details reuse a fixed one.
const demoHotelRef = (id) => [Number(String(id).match(/^demo(\d)/)?.[1] || 0), 'Tokyo'];
function mockRoomsDetail(id) {
  const [hotelId, d, n] = String(id).split('_');
  const row = mockRoomsAvailability({ hotel_id: hotelId, start_date: d, end_date: d, nights: n }).data[0];
  const rooms = [['Guest room, 1 King', false], ['Guest room, 2 Double', false], ['Executive Suite', true]].map(([name, suite], k) => ({
    id: `${id}_${k}`, availability_id: id, hotel_id: hotelId, source: row.source, room_code: '', name, description: '', image_url: '', suite, accessible: false,
    award_cost: suite ? row.suite_award_cost : row.standard_award_cost + k * 5000, cash_cost: suite ? row.suite_cash_cost : row.standard_cash_cost + k * 3000, cash_cost_currency: 'USD',
    arrival_date: row.arrival_date, departure_date: row.departure_date, num_nights: row.num_nights, last_checked_at: row.last_checked_at }));
  return { ...row, rooms: rooms.filter((r) => r.award_cost || r.cash_cost) };
}

// Lowest fare per departure day, shaped like the RapidAPI calendar result.
function mockCashCalendar({ departure_id, arrival_id, start_date, end_date, trip_days, travel_class = 1, adults = 1 }) {
  const base = Math.max(3000, miles(departure_id, arrival_id) * 4) * [0, 1, 1.6, 3.5, 6][travel_class] * (trip_days ? 1.8 : 1);
  const days = [];
  for (const date of dates(start_date, end_date)) {
    const h = hash(departure_id + arrival_id + date + travel_class);
    const dow = new Date(date + 'T00:00:00Z').getUTCDay();
    days.push({ date, price: Math.round((base * (0.75 + (h % 60) / 100) * ([5, 6, 0].includes(dow) ? 1.15 : 1) * adults) / 10) * 10 });
  }
  return { round: Boolean(trip_days), days };
}

// Nonstop carriers for a pair, made up from the demo carriers' hubs.
function mockDirects(from, to) {
  const dist = miles(from[0], to[0]);
  const pool = [['BR', 'EVA Air', '長榮航空'], ['CI', 'China Airlines', '中華航空'], ['JX', 'Starlux', '星宇航空'], ['CX', 'Cathay Pacific', '國泰航空'], ['JL', 'Japan Airlines', '日本航空']];
  const n = dist > 7000 ? 0 : 1 + (hash(from[0] + to[0]) % 4);
  return { airlines: pool.slice(0, n).map(([code, name, zh]) => ({ code, name, zh })), perDay: n ? Math.round(n * 2.6 * 10) / 10 : 0, airports: n ? [to[0]] : [], updated: new Date().toISOString().slice(0, 10) };
}

// Cash prices for one stay, shaped like lib/hotelcash's results.
function mockHotelCash(w, src) {
  const n = Math.max(1, Math.round((Date.parse(w.checkout) - Date.parse(w.checkin)) / 864e5));
  const base = 4000 + (hash(w.name) % 9000);
  if (src === 'booking') return { provider: 'booking', found: true, requests: 2, name: w.name, soldOut: false, total: Math.round(base * 1.06) * n, currency: 'TWD', url: 'https://www.booking.com/', bookingLeft: 46, bookingLimit: 50 };
  const sites = [['官方網站', true, 1.0], ['Booking.com', false, 1.04], ['Agoda', false, 0.97], ['Trip.com', false, 1.01], ['Expedia', false, 1.08], ['Hotels.com', false, 1.06]];
  const prices = sites.map(([source, official, f]) => ({ source, official, logo: '', link: 'https://www.google.com/travel/hotels', perNight: Math.round(base * f), total: Math.round(base * f) * n, freeCancel: official || f > 1.03 }))
    .sort((a, b) => a.total - b.total);
  return { provider: 'serpapi', found: true, credits: 2, name: w.name, site: 'https://www.marriott.com/', lowest: prices[0].total, typical: [Math.round(base * 0.85), Math.round(base * 1.3)], prices, serpLeft: 229 };
}

module.exports = { mockHotelCash, mockDirects, mockCashCalendar, mockSearch, mockTrips, mockAvailability, mockCash, mockRoomsSearch, mockRoomsAvailability, mockRoomsDetail };
