// Simplified → Traditional Chinese, one character at a time (Booking.com's "zh-tw" names are sometimes in
// Simplified characters). The table is OpenCC's cn → tw character conversion (Apache-2.0,
// https://github.com/BYVoid/OpenCC), generated once with opencc-js; words that need a phrase table are rare in
// hotel names.
const { s, t } = require('./s2t-data.json');
const T = [...t];
const MAP = new Map([...s].map((c, i) => [c, T[i]]));
const toTraditional = (str) => [...String(str ?? '')].map((c) => MAP.get(c) || c).join('');
module.exports = { toTraditional };
