// Dates as the site's users see them: "today" and "this month" follow Asia/Taipei (UTC+8, no daylight saving),
// not the server's UTC clock. seats.aero's daily quota is the one thing that still resets at 00:00 UTC.
const TW_OFFSET_MS = 8 * 3600e3;
const todayTW = (t = Date.now()) => new Date(t + TW_OFFSET_MS).toISOString().slice(0, 10);
const monthTW = (t = Date.now()) => todayTW(t).slice(0, 7);
// An ISO date `n` days after `iso` (calendar arithmetic, no time zone involved).
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
// YYYY-MM-DD that is a real calendar day (2026-02-30 and 2026-13-01 are not).
function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return false;
  const t = Date.parse(s + 'T00:00:00Z');
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

module.exports = { todayTW, monthTW, addDays, validDate, TW_OFFSET_MS };
