// What the owner sees of the daily run (R10): how each part of the last run went, kept per run slot (the 08:10 and
// 21:10 Taiwan runs), so the evening run doesn't hide how the morning one went. Only the owner reads these
// (GET /api/cron/status); visitors' /api/config keeps its short summary.

// Per part: 'ok', 'some' (some items failed or were left for the next run) or 'fail' (the part itself failed).
// Parts that did not run (not set up, or not asked for) are left out.
function cronParts(out = {}) {
  // `busy`: another run held the part's lock, so this one did none of it.
  const items = (r) => (r.busy || (r.report || []).some((x) => x.error || x.retry || x.skipped === 'time') ? 'some' : 'ok');
  const parts = {};
  if (out.expiry) parts.expiry = out.expiry.error ? 'fail' : out.expiry.errors > 0 || out.expiry.busy ? 'some' : 'ok';
  if ('deals' in out || out.dealsError) parts.deals = out.dealsError ? (out.deals ? 'some' : 'fail') : 'ok';
  // 今日好康每日信: shown only when it had something to send (not before 08:00, without deals, or already sent).
  if (out.digest && !out.digest.skipped && !out.digest.already) parts.digest = out.digest.error ? 'fail' : out.digest.errors > 0 || out.digest.left > 0 || out.digest.busy ? 'some' : 'ok';
  if (out.watches) parts.watches = out.watches.error ? 'fail' : items(out.watches);
  if (out.alertsError) parts.alerts = 'fail';
  else if (out.configured && Array.isArray(out.report)) parts.alerts = items(out);
  return parts;
}

// 00:10 UTC is the morning run, 13:10 UTC the evening one; a run started by hand lands in the slot of its hour.
const cronSlot = (iso) => (new Date(iso).getUTCHours() < 12 ? 'morning' : 'evening');

module.exports = { cronParts, cronSlot };
