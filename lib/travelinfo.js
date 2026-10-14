// Pre-trip notes for a destination: weather (Open-Meteo), Taiwan days off (government calendar via ruyut/TaiwanCalendar),
// destination public holidays (Nager.Date), and the static visa and travel-warning tables in data/.
// Every source is free and keyless. Each part fails on its own, so one broken source never hides the others.

const WEATHER_ICON = [
  [[0], '☀️', '晴'], [[1], '🌤️', '大致晴朗'], [[2], '⛅', '多雲'], [[3], '☁️', '陰'], [[45, 48], '🌫️', '霧'],
  [[51, 53, 55, 56, 57], '🌦️', '毛毛雨'], [[61, 63, 80, 81], '🌧️', '雨'], [[65, 82], '🌧️', '大雨'], [[66, 67], '🌧️', '凍雨'],
  [[71, 73, 77, 85], '🌨️', '雪'], [[75, 86], '❄️', '大雪'], [[95, 96, 97, 99], '⛈️', '雷雨'],
];
function weatherLabel(code) {
  const hit = WEATHER_ICON.find(([codes]) => codes.includes(code));
  return hit ? { icon: hit[1], text: hit[2] } : { icon: '🌡️', text: '' };
}

const DAY = 864e5;
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const addDays = (d, n) => iso(Date.parse(d) + n * DAY);
const round1 = (x) => Math.round(x * 10) / 10;
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function createTravelInfo({ fetchImpl = fetch, today = () => iso(Date.now()), visa = {}, warnings = {} } = {}) {
  const memo = new Map();
  // Small TTL cache; a failed lookup is not cached so the next visitor tries again.
  async function remember(key, ttlMs, fn) {
    const hit = memo.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    const pending = fn();
    memo.set(key, { value: pending, expires: Date.now() + ttlMs });
    if (memo.size > 800) memo.delete(memo.keys().next().value);
    try { return await pending; } catch (e) { memo.delete(key); throw e; }
  }
  async function getJson(url) {
    const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
    return res.json();
  }

  // Up to 16 days ahead: the daily forecast. Further out: that month's averages over the last three years.
  async function weather(lat, lon, start, end) {
    const t = today();
    const last = end || start;
    const ll = `latitude=${lat}&longitude=${lon}`;
    if (Date.parse(start) <= Date.parse(addDays(t, 15)) && Date.parse(last) >= Date.parse(t)) {
      const from = start < t ? t : start;
      const to = [last, addDays(from, 6), addDays(t, 15)].sort()[0];
      const j = await remember(`wf:${lat},${lon}:${from}:${to}`, 3 * 3600e3, () => getJson(`https://api.open-meteo.com/v1/forecast?${ll}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&start_date=${from}&end_date=${to}`));
      const d = j.daily || {};
      return {
        kind: 'forecast',
        days: (d.time || []).map((date, i) => ({
          date, ...weatherLabel(d.weather_code?.[i]),
          max: d.temperature_2m_max?.[i] != null ? Math.round(d.temperature_2m_max[i]) : null,
          min: d.temperature_2m_min?.[i] != null ? Math.round(d.temperature_2m_min[i]) : null,
          rain: d.precipitation_probability_max?.[i] ?? null,
        })),
      };
    }
    const month = start.slice(5, 7);
    const year = Number(t.slice(0, 4));
    // The archive lags a few days, so take the three most recent finished years of this month.
    const years = [1, 2, 3].map((k) => year - k + (`${year}-${month}` < t.slice(0, 7) ? 1 : 0));
    const runs = await remember(`wc:${lat},${lon}:${month}:${years[0]}`, 30 * DAY, () => Promise.all(years.map((y) => {
      const first = `${y}-${month}-01`;
      const lastDay = iso(Date.UTC(y, Number(month), 0));
      return getJson(`https://archive-api.open-meteo.com/v1/archive?${ll}&start_date=${first}&end_date=${lastDay}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto`);
    })));
    const max = []; const min = []; const wet = []; let n = 0;
    for (const j of runs) {
      const d = j.daily || {};
      (d.time || []).forEach((_, i) => {
        if (d.temperature_2m_max?.[i] != null) max.push(d.temperature_2m_max[i]);
        if (d.temperature_2m_min?.[i] != null) min.push(d.temperature_2m_min[i]);
        if (d.precipitation_sum?.[i] != null) { n++; if (d.precipitation_sum[i] >= 1) wet.push(1); }
      });
    }
    if (!max.length) throw new Error('沒有氣候資料');
    const daysInMonth = new Date(Date.UTC(year, Number(month), 0)).getUTCDate();
    return {
      kind: 'climate', month: Number(month), years,
      max: Math.round(avg(max)), min: Math.round(avg(min)),
      rainyDays: n ? Math.round((wet.length / n) * daysInMonth) : null,
    };
  }

  // Taiwan's office calendar for one year: { 'YYYY-MM-DD': { off, name } }.
  async function twYear(year) {
    return remember(`tw:${year}`, 7 * DAY, async () => {
      const rows = await getJson(`https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/data/${year}.json`);
      if (!Array.isArray(rows) || !rows.length) throw new Error('台灣行事曆沒有資料');
      const out = {};
      for (const r of rows) {
        const s = String(r.date || '');
        if (!/^\d{8}$/.test(s)) continue;
        out[`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`] = { off: Boolean(r.isHoliday), name: String(r.description || '').trim(), week: r.week };
      }
      return out;
    });
  }

  // Days off and make-up workdays in [start, end], plus the long weekends (3+ days off in a row that include a holiday) touching it.
  async function taiwan(start, end) {
    const years = [...new Set([Number(start.slice(0, 4)) - (start.slice(5, 7) === '01' ? 1 : 0), Number(start.slice(0, 4)), Number(end.slice(0, 4)), Number(end.slice(0, 4)) + (end.slice(5, 7) === '12' ? 1 : 0)])];
    const cal = {};
    const results = await Promise.allSettled(years.map(twYear));
    results.forEach((r) => r.status === 'fulfilled' && Object.assign(cal, r.value));
    if (!Object.keys(cal).length) throw results.find((r) => r.status === 'rejected')?.reason || new Error('台灣行事曆沒有資料');
    const days = [];
    const isWeekend = (d) => [0, 6].includes(new Date(d + 'T00:00:00Z').getUTCDay());
    for (let d = start; d <= end; d = addDays(d, 1)) {
      const c = cal[d];
      if (!c) continue;
      if (c.off && (c.name || !isWeekend(d))) days.push({ date: d, name: c.name || '放假', off: true });
      else if (!c.off && isWeekend(d)) days.push({ date: d, name: c.name || '補行上班', off: false, workday: true });
    }
    const dates = Object.keys(cal).sort();
    const long = [];
    let run = [];
    const flush = () => {
      if (run.length >= 3 && run.some((d) => cal[d].name || !isWeekend(d))) {
        const named = run.map((d) => cal[d].name).filter((n) => n && !/補假|放假|調整/.test(n));
        const from = run[0]; const to = run.at(-1);
        if (to >= start && from <= end) long.push({ start: from, end: to, days: run.length, name: [...new Set(named)].join('、') || '連假' });
      }
      run = [];
    };
    for (const d of dates) {
      if (cal[d].off && (!run.length || addDays(run.at(-1), 1) === d)) run.push(d);
      else { flush(); if (cal[d].off) run.push(d); }
    }
    flush();
    return { days, longWeekends: long };
  }

  // Public holidays of another country. Nager.Date's v4 host first, its older v3 host as a fallback.
  async function countryYear(cc, year) {
    return remember(`ng:${cc}:${year}`, 7 * DAY, async () => {
      let rows;
      try {
        rows = await getJson(`https://nagerholidays.com/api/v4/Holidays/${cc}/${year}`);
      } catch {
        rows = await getJson(`https://date.nager.at/api/v3/PublicHolidays/${year}/${cc}`);
      }
      if (!Array.isArray(rows)) rows = rows?.holidays || rows?.data || [];
      return rows.map((h) => {
        const types = h.holidayTypes || h.types || [];
        return { date: String(h.date || '').slice(0, 10), name: h.name || h.localName || '', local: h.localName && h.localName !== h.name ? h.localName : '', regional: Array.isArray(h.subdivisionCodes || h.counties) && (h.subdivisionCodes || h.counties).length > 0, types };
      }).filter((h) => /^\d{4}-\d{2}-\d{2}$/.test(h.date) && !h.regional && (!h.types.length || h.types.some((t) => /public|bank/i.test(t))));
    });
  }
  async function country(cc, start, end) {
    const years = [...new Set([Number(start.slice(0, 4)), Number(end.slice(0, 4))])];
    const lists = await Promise.all(years.map((y) => countryYear(cc, y)));
    const seen = new Set();
    return lists.flat().filter((h) => h.date >= start && h.date <= end && !seen.has(h.date) && seen.add(h.date)).map(({ date, name, local }) => ({ date, name, local }));
  }

  // Everything for one destination. `place` = { country, lat, lon }.
  async function forTrip(place, start, end, { withWeather = true } = {}) {
    const settle = async (fn) => { try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, error: e.message }; } };
    const [w, tw, dest] = await Promise.all([
      withWeather ? settle(() => weather(place.lat, place.lon, start, end)) : { ok: true, value: null },
      settle(() => taiwan(start, end)),
      place.country && place.country !== 'TW' ? settle(() => country(place.country, start, end)) : { ok: true, value: [] },
    ]);
    return {
      country: place.country,
      visa: visa[place.country] || null,
      warning: warnings[place.country] || null,
      weather: w.ok ? w.value : null,
      taiwan: tw.ok ? tw.value : null,
      holidays: dest.ok ? dest.value : null,
      errors: Object.fromEntries([['weather', w], ['taiwan', tw], ['holidays', dest]].filter(([, r]) => !r.ok).map(([k, r]) => [k, r.error])),
    };
  }

  return { forTrip, weather, taiwan, country };
}

module.exports = { createTravelInfo, weatherLabel };
