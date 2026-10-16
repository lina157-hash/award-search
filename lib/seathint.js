// 今日好康's 「可能斜躺」 tag: a business deal to 日韓 or 東南亞 (short-haul from Taipei) on an airline whose official cabin
// pages list recliner business seats on aircraft it flies around Asia (data/seats.json `regional`). The deals carry no
// aircraft (their search has no trips), so the tag only says "may" and names the aircraft; 航班明細 shows the real one.
const SHORT_GROUPS = new Set(['jk', 'sea']);
const AC_NAME = { '333': 'A330-300', '32Q': 'A321neo', '321': 'A321', '32N': 'A320neo', '773': '777-300', '788': '787-8', '738': '737-800', '763': '767-300ER' };

// seats: data/seats.json; names: code → Chinese name. → { label, note } or null.
function seatHint(seats, names, airlines, groupId, cabin) {
  if (cabin !== 'J' || !SHORT_GROUPS.has(groupId)) return null;
  const codes = [...new Set(String(airlines || '').split(/[,\s]+/).filter((c) => /^[A-Z0-9]{2}$/.test(c)))];
  const parts = [];
  let some = false;
  for (const c of codes) {
    const list = (seats?.airlines?.[c]?.J || []).filter((s) => s.regional && (s.type === 'recliner' || s.type === 'mixed'));
    if (!list.length) continue;
    const ac = list.flatMap((s) => s.ac.map((a) => `${AC_NAME[a] || a}${s.type === 'mixed' ? '（部分）' : ''}`));
    some ||= list.some((s) => s.type === 'mixed');
    parts.push(`${names?.[c] || c} ${ac.join('、')}`);
  }
  if (!parts.length) return null;
  return { label: '可能斜躺', note: `依航空公司官網，這些機型的商務艙是斜躺座椅${some ? '（標「部分」的是有的平躺、有的斜躺）' : ''}：${parts.join('；')}。這筆飛哪一型，點進去看航班明細。` };
}

// The deals answer with a `seat` hint on the matching items (a copy; the saved deals stay as they are).
function withSeatHints(d, seats, names) {
  if (!d || !Array.isArray(d.groups) || !seats) return d;
  return { ...d, groups: d.groups.map((g) => ({ ...g, items: (g.items || []).map((x) => { const h = seatHint(seats, names, x.airlines, g.id, g.cabin); return h ? { ...x, seat: h } : x; }) })) };
}

module.exports = { seatHint, withSeatHints, SHORT_GROUPS };
