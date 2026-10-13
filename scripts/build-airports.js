#!/usr/bin/env node
// Builds public/airports.min.json, the airport list behind the search autocomplete.
//
// Inputs (download once, pass the paths):
//   1. OurAirports data (public domain) as JSON, e.g. data/airports.json from `npm pack airports-json`.
//   2. airportsdata's airports.csv (MIT, github.com/mborsetti/airportsdata), used for alternate city names.
// Chinese names and city groups come from data/airport-names-zh.json.
//
// Usage: node scripts/build-airports.js <ourairports.json> <airportsdata.csv>
const fs = require('node:fs');
const path = require('node:path');

const [ourPath, adPath] = process.argv.slice(2);
if (!ourPath || !adPath) {
  console.error('usage: node scripts/build-airports.js <ourairports.json> <airportsdata.csv>');
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

const zh = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'airport-names-zh.json'), 'utf8'));
const our = JSON.parse(fs.readFileSync(ourPath, 'utf8'));
const adRows = new Map(parseCsv(fs.readFileSync(adPath, 'utf8')).filter((r) => r.iata).map((r) => [r.iata, r]));
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

const out = {
  sources: 'OurAirports (public domain); city names from airportsdata (MIT, Mike Borsetti); Chinese names curated for this site',
  fields: ['code', 'city', 'name', 'country', 'continent', 'large', 'zh', 'altCity', 'lat', 'lon'],
  airports,
  groups,
};
const file = path.join(__dirname, '..', 'public', 'airports.min.json');
fs.writeFileSync(file, JSON.stringify(out).replace(/\],\[/g, '],\n['));
console.log(`wrote ${airports.length} airports, ${groups.length} city groups to ${path.relative(process.cwd(), file)}`);
