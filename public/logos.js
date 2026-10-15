// ---------- airline and alliance logos (規則庫) ----------
// Small self-hosted WebP files in /logos/ (sources and licences: /logos/CREDITS.txt). They sit on a light rounded
// backdrop so dark marks stay visible in dark mode. An airline without a file gets a round badge with its code.
const LOGO_CODES = new Set(('A3 AA AC AF AI AM AR AS AT AV AY AZ BA BR CA CI CM CX DL EK ET EY FJ GA HA IB JL JX KE KL KQ LH LO LX '
  + 'ME MF MH MS MU NH NZ OS OU OZ PR QF QR RJ RO SA SK SN SQ SV TG TK TP UA UL UX VN VS WY ZH').split(' '));
const ALLIANCE_LOGOS = ['oneworld', 'star', 'skyteam'];
// Brand colours, used only for the fallback badge.
const AIRLINE_COLOR = {
  A3: '#002677', AA: '#0078d2', AC: '#f01428', AF: '#051039', AI: '#da0e29', AM: '#020c41', AR: '#0080be', AS: '#01426a', AT: '#c20831',
  AV: '#ff0000', AY: '#0c0243', AZ: '#0d2b6b', BA: '#2e5c99', BR: '#409e54', CA: '#ed1c24', CI: '#8c4f9f', CM: '#0032a0', CX: '#005d63',
  DL: '#e31837', EK: '#d71921', ET: '#b71d20', EY: '#bd8b13', FJ: '#473729', GA: '#002560', HA: '#5a2a82', IB: '#d7192d', JL: '#e50012',
  JX: '#996a4e', KE: '#051766', KL: '#009fd9', KQ: '#ed1c24', LH: '#05164d', LO: '#252668', LX: '#cf0a2c', ME: '#00703c', MF: '#008cd5',
  MH: '#174887', MS: '#0b3b7a', MU: '#1a2a6c', NH: '#00146e', NZ: '#000000', OS: '#e3001b', OU: '#1f3a93', OZ: '#4a4f54', PR: '#001f60',
  QF: '#e40000', QR: '#662046', RJ: '#8a6d3b', RO: '#003366', SA: '#00337f', SK: '#000099', SN: '#051446', SQ: '#232f67', SV: '#0a6937',
  TG: '#330066', TK: '#c90019', TP: '#5c8a00', UA: '#1414d2', UL: '#8b1d41', UX: '#006fde', VN: '#b07f00', VS: '#da0530', WY: '#8a7340', ZH: '#c8102e',
};

// <span class="alogo">: the airline's mark, or its code on a badge in the airline's colour. Decorative: the name is always next to it.
function airlineLogo(code, cls = '') {
  const c = String(code || '').toUpperCase();
  if (!/^[A-Z0-9]{2}$/.test(c)) return '';
  if (LOGO_CODES.has(c)) return `<span class="alogo ${cls}" aria-hidden="true"><img src="/logos/${c}.webp" alt="" width="64" height="64" loading="lazy" decoding="async"></span>`;
  return `<span class="alogo alogo-code ${cls}" style="--lc:${AIRLINE_COLOR[c] || '#64748b'}" aria-hidden="true">${c}</span>`;
}
// The comparison table's small round mark (looks like airlineLogo(code, 'xs')): one element with the logo as its
// background instead of a wrapper and an <img>, because the table draws hundreds of them. `name` is already escaped.
function airlineMark(code, name) {
  const c = String(code || '').toUpperCase();
  if (!/^[A-Z0-9]{2}$/.test(c)) return '';
  const label = `role="img" aria-label="${name}" title="${name}"`;
  if (LOGO_CODES.has(c)) return `<span class="alogo xs alogo-bg" ${label} style="background-image:url(/logos/${c}.webp)"></span>`;
  return `<span class="alogo alogo-code xs" ${label} style="--lc:${AIRLINE_COLOR[c] || '#64748b'}">${c}</span>`;
}
function allianceLogo(id, cls = '') {
  if (!ALLIANCE_LOGOS.includes(id)) return '';
  return `<span class="alogo alogo-al ${cls}" aria-hidden="true"><img src="/logos/${id}.webp" alt="" width="64" height="64" loading="lazy" decoding="async"></span>`;
}
