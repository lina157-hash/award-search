#!/usr/bin/env node
// Builds public/airports.min.json, the airport list behind the search autocomplete.
//
// Inputs (download once, pass the paths):
//   1. OurAirports data (public domain) as JSON, e.g. data/airports.json from `npm pack airports-json`.
//   2. airportsdata's airports.csv (MIT, github.com/mborsetti/airportsdata), used for alternate city names and each
//      airport's IANA time zone.
// Chinese names and city groups come from data/airport-names-zh.json.
//
// Usage: node scripts/build-airports.js <ourairports.json> <airportsdata.csv>
//        node scripts/build-airports.js --tz <airportsdata.csv>   (only adds or refreshes the time zones of the file as it is)
// Time zones are stored as an index into the top-level `tzs` list (most used first), which keeps the file small.
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const tzOnly = args[0] === '--tz';
const [ourPath, adPath] = tzOnly ? [null, args[1]] : args;
if ((!tzOnly && !ourPath) || !adPath) {
  console.error('usage: node scripts/build-airports.js <ourairports.json> <airportsdata.csv>\n       node scripts/build-airports.js --tz <airportsdata.csv>');
  process.exit(1);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') cell += text[++i];
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) rows.push([...row, cell]);
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

const FIELDS = ['code', 'city', 'name', 'country', 'continent', 'large', 'zh', 'altCity', 'lat', 'lon', 'tz'];
const file = path.join(__dirname, '..', 'public', 'airports.min.json');
const write = (out) => fs.writeFileSync(file, JSON.stringify(out).replace(/\],\[/g, '],\n['));
const adRows = new Map(parseCsv(fs.readFileSync(adPath, 'utf8')).filter((r) => r.iata).map((r) => [r.iata, r]));

// Each row's IANA zone (field 10) as an index into `tzs`. An airport airportsdata lacks takes the zone of its
// nearest airportsdata airport in the same country.
function addTz(airports) {
  const known = [...adRows.values()].filter((r) => r.tz && r.lat !== '' && r.lon !== '');
  const zoneOf = (row) => {
    const r = adRows.get(row[0]);
    if (r?.tz) return r.tz;
    let best = null;
    let bestD = Infinity;
    for (const k of known) {
      if (k.country !== row[3]) continue;
      const d = (Number(k.lat) - row[8]) ** 2 + (Number(k.lon) - row[9]) ** 2;
      if (d < bestD) { bestD = d; best = k.tz; }
    }
    return best || '';
  };
  const zones = airports.map(zoneOf);
  const count = new Map();
  for (const z of zones) if (z) count.set(z, (count.get(z) || 0) + 1);
  const tzs = [...count.keys()].sort((a, b) => count.get(b) - count.get(a) || a.localeCompare(b));
  const idx = new Map(tzs.map((z, i) => [z, i]));
  airports.forEach((row, i) => { row.length = 10; if (zones[i]) row[10] = idx.get(zones[i]); });
  return { tzs, missing: airports.filter((_, i) => !zones[i]).map((r) => r[0]) };
}

if (tzOnly) {
  const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { tzs, missing } = addTz(cur.airports);
  const { sources, airports, groups } = cur;
  write({ sources: sources.includes('time zones') ? sources : sources.replace('city names from airportsdata', 'city names and time zones from airportsdata'), fields: FIELDS, tzs, airports, groups });
  console.log(`added time zones (${tzs.length} zones) to ${airports.length} airports${missing.length ? `; no zone for ${missing.join(', ')}` : ''}`);
  process.exit(0);
}

const zh = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'airport-names-zh.json'), 'utf8'));
const our = JSON.parse(fs.readFileSync(ourPath, 'utf8'));
const altCity = new Map([...adRows].map(([code, r]) => [code, r.city]));

const round = (x) => Math.round(Number(x) * 100) / 100;
const clean = (s) => String(s || '').replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
const byCode = new Map();
for (const a of our) {
  const code = a.iata_code;
  if (!/^[A-Z]{3}$/.test(code || '')) continue;
  if (a.scheduled_service !== 'yes' && !zh.names[code]) continue;
  const prev = byCode.get(code);
  if (prev && prev.scheduled_service === 'yes' && a.scheduled_service !== 'yes') continue;
  byCode.set(code, a);
}

const airports = [...byCode.values()].map((a) => {
  const code = a.iata_code;
  const city = clean(a.municipality) || clean(altCity.get(code));
  const alt = clean(altCity.get(code));
  return [code, city, a.name, a.iso_country, a.continent, a.type === 'large_airport' ? 1 : 0, zh.names[code] || '', alt && alt !== city ? alt : '', round(a.latitude_deg), round(a.longitude_deg)];
});

// Small or newly opened airports that OurAirports' list lacks: fill from airportsdata when we have a Chinese name.
const continentOf = new Map(airports.map((r) => [r[3], r[4]]));
for (const code of Object.keys(zh.names)) {
  const r = !byCode.has(code) && adRows.get(code);
  if (r && continentOf.has(r.country)) airports.push([code, clean(r.city), r.name, r.country, continentOf.get(r.country), 0, zh.names[code], '', round(r.lat), round(r.lon)]);
}
airports.sort((x, y) => x[0].localeCompare(y[0]));

const known = new Set(airports.map((r) => r[0]));
const missing = Object.keys(zh.names).filter((c) => !known.has(c));
if (missing.length) console.warn(`Chinese names without an airport row (skipped): ${missing.join(', ')}`);
const groups = zh.groups.map((g) => ({ ...g, codes: g.codes.filter((c) => known.has(c)) })).filter((g) => g.codes.length > 1);

const { tzs } = addTz(airports);
const out = {
  sources: 'OurAirports (public domain); city names and time zones from airportsdata (MIT, Mike Borsetti); Chinese names curated for this site',
  fields: FIELDS,
  tzs,
  airports,
  groups,
};
write(out);
console.log(`wrote ${airports.length} airports, ${groups.length} city groups to ${path.relative(process.cwd(), file)}`);
