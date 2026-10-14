// Accor hotels priced in ALL – Accor Live Limitless points. rooms.aero has no Accor, and ALL has no award chart: points
// pay part or all of a cash booking at a fixed value. So the cash price of each Accor hotel in a city (Booking.com)
// is turned into the points it is worth.
//
// The rule, from the ALL terms and conditions (article 10) and the "use points online" page:
// - 2,000 Reward points take €40 off a booking (so 1 point = €0.02, 50 points per euro); online the minimum is 1,000
//   points (€20), and above 2,000 points they go in multiples of 2,000.
// - The points used cannot be worth more than the booking total (taxes included); the rest is paid by card, and
//   prepaid rates always need part of it on a card. Some taxes cannot be paid with points.
// - Prices in other currencies are converted with Accor's own reference rate at payment or check-out.
// - Not at IntercityHotel, Steigenberger, MAXX, Jaz in the City, Zleep or independent partner hotels; not on Day Use
//   and some promotional rates.
const RULE = {
  pointsPerEuro: 50,
  minPoints: 1000,
  step: 2000,
  text: 'ALL 點數可折抵雅高旗下飯店的房價：2,000 點折 €40（每點約 €0.02），線上訂房最少 1,000 點，超過 2,000 點要以 2,000 點為單位，折抵金額不能超過訂單總額（含稅），剩下的刷卡；預付房價一定要刷一部分卡，部分稅金不能用點數付。非歐元房價依雅高的匯率換算。IntercityHotel、Steigenberger、MAXX、Jaz in the City、Zleep 不能用點數折抵。',
  source: 'https://all.accor.com/a/en/loyalty-program/legal/terms-and-conditions.html',
  sourceOnline: 'https://all.accor.com/gb/booking/burn-online-condition.html',
};

// Accor brands where ALL points can be spent, as hotel names spell them on Booking.com. Order matters: the longer
// name first (Grand Mercure before Mercure, ibis Styles before ibis). Names are compared without accents, lower case.
// Generic words are anchored to the start of the name (a "Hyde Park Hotel" is not Hyde, "Hotel Adagio" in Rome is not
// Adagio). Hotel Indigo is IHG, not Accor.
const BRANDS = [
  ['Raffles', /^raffles\b/],
  ['Orient Express', /\borient express\b/],
  ['Fairmont', /\bfairmont\b/],
  ['Sofitel Legend', /\bsofitel legend\b/],
  ['Sofitel', /\bsofitel\b/],
  ['SO/', /^so ?\//],
  ['Banyan Tree', /\bbanyan tree\b/],
  ['Angsana', /\bangsana\b/],
  ['Cassia', /^cassia\b/],
  ['Dhawa', /^dhawa\b/],
  ['Garrya', /^garrya\b/],
  ['Rixos', /\brixos\b/],
  ['Faena', /^faena\b/],
  ['Delano', /^delano\b/],
  ['SLS', /^sls\b/],
  ['Mondrian', /\bmondrian\b/],
  ['Hyde', /^hyde\b(?! park)/],
  ['25hours', /\b25 ?hours hotel\b|^25hours\b/],
  ['MGallery', /\bm ?gallery\b/],
  ['Handwritten Collection', /\bhandwritten collection\b/],
  ['Art Series', /\bart series\b/],
  ['Mantis', /\bmantis\b/],
  ['Pullman', /\bpullman\b/],
  ['Swissôtel', /\bswissotel\b/],
  ['Mövenpick', /\bmovenpick\b/],
  ['Grand Mercure', /\bgrand mercure\b/],
  ['Mercure', /\bmercure\b/],
  ['Peppers', /^peppers\b/],
  ['The Sebel', /\bthe sebel\b/],
  ['Mantra', /^mantra\b/],
  ['BreakFree', /^breakfree\b/],
  ['Novotel', /\bnovotel\b/],
  ['Adagio', /\badagio (access|aparthotel|premium)\b|\baparthotel adagio\b/],
  ['Mama Shelter', /\bmama shelter\b/],
  ['Tribe', /^tribe\b/],
  ['ibis Styles', /\bibis styles\b/],
  ['ibis budget', /\bibis budget\b/],
  ['ibis', /\bibis\b/],
  ['greet', /^greet\b/],
  ['hotelF1', /\bhotel ?f1\b/],
  ['JO&JOE', /\bjo ?& ?joe\b/],
];
// Chinese brand names, as the brands use them in Taiwan or Hong Kong (shown beside the English brand).
const BRAND_ZH = {
  Raffles: '萊佛士', Fairmont: '費爾蒙', 'Sofitel Legend': '索菲特傳奇', Sofitel: '索菲特', 'Banyan Tree': '悅榕莊', Angsana: '悅椿',
  Rixos: '瑞克索斯', MGallery: '美憬閣', Pullman: '鉑爾曼', 'Swissôtel': '瑞士酒店', 'Mövenpick': '瑞享', 'Grand Mercure': '美爵',
  Mercure: '美居', Novotel: '諾富特', 'Mama Shelter': '媽媽小屋', 'ibis Styles': '宜必思尚品', 'ibis budget': '宜必思快捷', ibis: '宜必思',
};
// In ALL, but points cannot be spent there.
const NO_POINTS = /\bintercityhotel\b|\bintercity hotel\b|\bsteigenberger\b|\bmaxx by\b|\bjaz in the city\b|\bzleep\b/;
const plain = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
function brandOf(name) {
  const n = plain(name);
  if (!n || NO_POINTS.test(n)) return null;
  for (const [brand, re] of BRANDS) if (re.test(n)) return brand;
  return null;
}

// A Booking.com brand filter title that is Accor ("Novotel", "ibis Styles", "Accor"); brands where points cannot
// be spent are left out.
const isAccorTitle = (title) => Boolean(brandOf(title)) || /^accor\b/.test(plain(title));
// Booking.com brand filter ids seen live for Accor brands (Bangkok, 2026-10-14). The same in every city; used when a
// city's filter list cannot be read.
const BOOKING_CHAINS = ['chaincode::1050', 'chaincode::1051', 'chaincode::1053', 'chaincode::3086'];

// Points for a stay of `totalEur`: `points` is what the whole price is worth (to compare with an award night),
// `usablePoints` the most the rule lets one booking take (1,000, or multiples of 2,000, never above the total).
function pointsFor(totalEur) {
  if (!(totalEur > 0)) return { points: null, usablePoints: 0, usableEur: 0 };
  const worth = totalEur * RULE.pointsPerEuro;
  const usablePoints = worth >= RULE.step ? Math.floor(worth / RULE.step) * RULE.step : worth >= RULE.minPoints ? RULE.minPoints : 0;
  return { points: Math.ceil(worth), usablePoints, usableEur: usablePoints / RULE.pointsPerEuro };
}

// From a city search (lib/hotelcash.js lookup.city) to the answer: Accor hotels only, cheapest first, sold out last.
// `eurRate`: TWD per euro.
function accorAnswer(search, { eurRate, nights }) {
  const pointValueTwd = Math.round((eurRate / RULE.pointsPerEuro) * 100) / 100;
  const hotels = [];
  for (const h of search.hotels || []) {
    const brand = brandOf(h.name);
    if (!brand) continue;
    const total = h.total && h.currency === 'TWD' ? Math.round(h.total) : null;
    const totalEur = total ? Math.round((total / eurRate) * 100) / 100 : null;
    const p = pointsFor(totalEur);
    hotels.push({
      id: h.id, name: h.name, nameZh: h.nameZh || null, brand, brandZh: BRAND_ZH[brand] || null, total, totalEur, points: p.points, usablePoints: p.usablePoints,
      cashLeftTwd: total ? Math.max(0, Math.round(total - p.usableEur * eurRate)) : null,
      pointValueTwd, url: h.url, stars: h.stars ?? null, lat: h.lat ?? null, lon: h.lon ?? null, soldOut: Boolean(h.soldOut || !total),
    });
  }
  hotels.sort((a, b) => Number(a.soldOut) - Number(b.soldOut) || (a.total ?? Infinity) - (b.total ?? Infinity));
  return { found: search.found !== false, city: search.city || '', cityUrl: search.url || '', hotels, scanned: (search.hotels || []).length, nights, eurRate, pointValueTwd, requests: search.requests ?? 0, rule: RULE };
}

module.exports = { brandOf, isAccorTitle, BOOKING_CHAINS, BRAND_ZH, pointsFor, accorAnswer, RULE, BRANDS };
