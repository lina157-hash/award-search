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
        { FlightNumber: flight, OriginAirport: o, DestinationAirport: d, DepartsAt: dep, ArrivesAt: arr, AircraftName: 'Boeing 777-300ER', FareClass: cabin === 'J' ? 'I' : 'X', Order: 0 },
      ],
    })),
    booking_links: [{ label: `${source} 官網訂位`, link: '#demo', primary: true }],
  };
}

function mockAvailability({ source, start_date, end_date }) {
  const pairs = [['TPE', 'YVR'], ['TPE', 'SFO'], ['HKG', 'LAX'], ['TPE', 'CDG'], ['NRT', 'JFK'], ['TPE', 'AMS']];
  return pairs.flatMap(([o, d]) => mockSearch({ origin_airport: o, destination_airport: d, start_date, end_date, sources: source }));
}

module.exports = { mockSearch, mockTrips, mockAvailability };
