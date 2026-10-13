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

function mockSearch({ origin_airport, destination_airport, start_date, end_date, carriers, sources }) {
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

function mockCash({ departure_id, arrival_id, outbound_date, return_date, type = 1, travel_class = 1, adults = 1, stops = 0, include_airlines, departure_token }) {
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
      ...(type === 1 && !returning ? { departure_token: `mock-${c}` } : {}),
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

module.exports = { mockSearch, mockTrips, mockAvailability, mockCash };
