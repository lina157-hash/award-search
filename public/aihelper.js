// 「🤖 交給 AI 助理」 in the flight details dialog: one tap writes a ready-made instruction (in Chinese, with an English
// call script) for an AI assistant that can phone the program's call center, and copies it to the clipboard.
// Nothing is sent anywhere and no quota is spent: the text is built here from the trip already on screen.
// Loaded after features.js and sharing the globals of app.js / features.js.

const AI_CABIN_EN = { economy: 'economy class', premium: 'premium economy', business: 'business class', first: 'first class' };
const AI_CABIN_ZH = { economy: '經濟艙', premium: '豪華經濟艙', business: '商務艙', first: '頭等艙' };
const AI_MONTH_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const AI_NUM_EN = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const aiNum = (n) => Number(n).toLocaleString('en-US');

// The whole text from facts already resolved to names (no page globals, so it can be tested on its own).
// o: { program, programEn, segs: [{ flight, al, alEn, from, fromZh, fromEn, dep, to, toZh, toEn, arr, arrNote }],
//      date, cabin, pax, miles, taxes: { zh, en } | null, phones: [{ number, label }], contactUrl, phoneFee, warnings: [] }
function aiBriefText(o) {
  const pax = Math.max(1, Number(o.pax) || 1);
  const [y, m, d] = o.date.split('-').map(Number);
  const dow = '日一二三四五六'[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const cabinZh = AI_CABIN_ZH[o.cabin] || o.cabin;
  const place = (zh, code) => `${zh ? `${zh} ` : ''}${code}`;
  const segZh = (s) => `${s.al ? `${s.al} ` : ''}${s.flight}　${place(s.fromZh, s.from)} ${s.dep} → ${place(s.toZh, s.to)} ${s.arr}${s.arrNote || ''}`;
  const lines = [`請幫我打電話給${o.program} 客服（如果客服不說中文，就用英文溝通），用我的哩程訂${pax === 1 ? '一張' : ` ${pax} 張`}獎勵機票：`, ''];
  if (o.segs.length === 1) lines.push(`・航班（直飛）：${segZh(o.segs[0])}`);
  else {
    lines.push(`・航班（轉機 ${o.segs.length - 1} 次，共 ${o.segs.length} 段）：`);
    o.segs.forEach((s, i) => lines.push(`　第 ${i + 1} 段　${segZh(s)}`));
  }
  lines.push(`・日期：${y} 年 ${m} 月 ${d} 日（${dow}）`, `・艙等：${cabinZh}，${pax} 位`);
  const miles = pax === 1 ? `${aiNum(o.miles)} 哩` : `每位 ${aiNum(o.miles)} 哩，${pax} 位共 ${aiNum(o.miles * pax)} 哩`;
  lines.push(`・網站查到：${miles}${o.taxes ? `＋稅金約 ${o.taxes.zh}` : '，網站沒列出稅金'}（${o.taxes && pax > 1 ? `稅金是 ${pax} 位合計，` : ''}請以客服報價為準）`);
  if (o.phones?.length) lines.push(`・客服電話：${o.phones.map((p) => `${p.number}${p.label ? `（${p.label}）` : ''}`).join('；')}`);
  else if (o.contactUrl) lines.push(`・客服電話請見官網：${o.contactUrl}`);
  else lines.push(`・客服電話：請到 ${o.program} 官網查詢`);
  if (o.phoneFee) lines.push(`・電話訂位費用：${o.phoneFee}`);
  for (const w of o.warnings || []) lines.push(`・注意：${w}`);
  lines.push('・我的會員號碼：〔請自己填，不要給密碼或信用卡〕', '');
  lines.push('請先問清楚再訂：',
    `1. 這班還有沒有${cabinZh}獎勵座位${pax > 1 ? `，${pax} 位都訂得到嗎` : ''}${o.warnings?.length ? '（網站提醒這裡偶有查得到、訂不到的幻影機位，請務必確認）' : ''}`,
    '2. 總共要幾哩、稅金和手續費多少',
    '3. 改票、退票要多少錢',
    '確認後再幫我訂位，並告訴我訂位代號；需要付款時先問我。', '');

  const where = (en, code) => (en ? `${en} (${code})` : code);
  const segEn = (s) => `${s.alEn ? `${s.alEn} ` : ''}${s.flight} from ${where(s.fromEn, s.from)} to ${where(s.toEn, s.to)}`;
  const dateEn = `${d} ${AI_MONTH_EN[m - 1]} ${y}`;
  const route = o.segs.length === 1 ? `${segEn(o.segs[0])} on ${dateEn}` : `${o.segs.map(segEn).join(', connecting to ')}, departing ${dateEn}`;
  const prog = o.programEn || o.program;
  const paxEn = pax > 1 ? `${AI_NUM_EN[pax] || pax} passengers` : 'one passenger';
  const seen = `${aiNum(o.miles)} miles${pax > 1 ? ' per person' : ''}${o.taxes ? ` plus about ${o.taxes.en} in taxes${pax > 1 ? ' in total' : ''}` : ' plus taxes'}`;
  lines.push('English script for the call:',
    `"Hi, I'd like to book ${pax > 1 ? AI_NUM_EN[pax] || pax : /^[AEIO]/i.test(prog) ? 'an' : 'a'} ${prog} award ticket${pax > 1 ? 's' : ''} on ${route}, ${AI_CABIN_EN[o.cabin] || o.cabin}, ${paxEn}. ` +
    `I saw it online for ${seen}. My member number is ________. Could you confirm the award seat${pax > 1 ? 's are' : ' is'} available, ` +
    'and tell me the total miles, taxes and fees, and the change and cancellation fees before booking?"');
  return lines.join('\n');
}

// ---------- browser side ----------
// Call centers (data/callcenters.json) load once, when the first flight dialog opens.
let aiCenters = null;
let aiCentersP = null;
const loadCallCenters = () => (aiCentersP ||= api('/api/data/callcenters')
  .then((d) => (aiCenters = d.programs || {}))
  .catch(() => { aiCentersP = null; return {}; }));

// Taxes for all passengers: in NT$ when the exchange rate is known, else in the program's own currency.
function aiTaxes(t, pax) {
  if (t.taxes == null) return null;
  const cur = String(t.taxesCurrency || '').toUpperCase();
  const total = (t.taxes / 100) * pax;
  const rate = cur && fxCache?.rates?.[cur];
  if (rate) { const twd = Math.round((total * rate) / 10) * 10; return { zh: `NT$${aiNum(twd)}`, en: `TWD ${aiNum(twd)}` }; }
  const amt = aiNum(Math.round(total * 100) / 100);
  return { zh: `${t.taxesSymbol || ''}${amt}${cur ? ` ${cur}` : ''}`, en: `${cur || t.taxesSymbol || ''} ${amt}`.trim() };
}

// English airline name for a code, from data/airline-names.json ([code, zh, en, ...]).
const aiAirlineEn = (code) => (data.airlineNames?.airlines || []).find((a) => a[0] === code)?.[2] || '';
// English place for the call script: the city group (Tokyo for NRT/HND), else the airport's own name without
// "International Airport" (Hong Kong, where the city field says "Islands"), else the city.
function aiAirport(code) {
  const a = AP.byCode.get(code);
  if (!a) return { zh: '', en: '' };
  const group = AP.groups.find((g) => g.codes.includes(code))?.en;
  const name = String(a.name || '').replace(/\s+(International\s+)?Airport$/i, '');
  return { zh: a.zh || '', en: group || (name && !/airport|airfield/i.test(name) ? name : a.city) };
}

function aiBriefFacts(t, pax) {
  const center = aiCenters?.[programKeyOf(t.source)] || aiCenters?.[t.source] || {};
  const fee = bookingInfo(t.source)?.booking?.phoneFee;
  const segs = t.segments.map((s) => {
    const code = (s.flight || '').slice(0, 2).toUpperCase();
    const dep = (s.departsAt || '').slice(0, 10);
    const arrDay = (s.arrivesAt || '').slice(0, 10);
    const days = dep && arrDay ? Math.round((Date.parse(arrDay) - Date.parse(dep)) / 864e5) : 0;
    const f = aiAirport(s.from);
    const to = aiAirport(s.to);
    return {
      flight: s.flight, al: airlineZh(code) !== code ? airlineZh(code) : '', alEn: aiAirlineEn(code),
      from: s.from, fromZh: f.zh, fromEn: f.en, dep: hhmm(s.departsAt),
      to: s.to, toZh: to.zh, toEn: to.en, arr: hhmm(s.arrivesAt),
      arrNote: days === 1 ? '（隔天）' : days > 1 ? `（${mmdd(arrDay)}）` : days < 0 ? `（${mmdd(arrDay)}）` : '',
    };
  });
  return {
    program: programName(t.source), programEn: center.en, segs,
    date: (t.departsAt || t.segments[0]?.departsAt || '').slice(0, 10), cabin: t.cabin, pax, miles: t.miles,
    taxes: aiTaxes(t, pax), phones: center.phones || [], contactUrl: center.contactUrl || '',
    phoneFee: fee ? phoneFeeText(fee) : '', warnings: phantomWarnings(t.source, t.carriers).map((p) => p.warning),
  };
}

async function aiCopy(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back below */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

// Hook from openTrips: the button goes after the trips of the chosen cabin; t is the cheapest of them.
function aiHelperMount(t, pax, nMain) {
  const anchor = $$('#trip-body > .trip')[nMain - 1];
  if (!t?.segments?.length || !anchor) return;
  // Free and cached: the call centers, today's exchange rates and the airport names, so a tap can copy at once.
  loadCallCenters();
  loadFx().catch(() => {});
  loadAirports();
  const box = document.createElement('div');
  box.className = 'ai-box';
  box.innerHTML = `<div class="ai-head"><button type="button" class="outline" aria-expanded="false">🤖 交給 AI 助理</button><span class="ai-ok" role="status"></span></div>
    <div class="ai-more" hidden><pre class="ai-text"></pre><p class="hint">只會複製這段文字，不會把你的資料傳給任何網站，也不花查詢額度。</p></div>`;
  anchor.after(box);
  const btn = $('button', box);
  const ok = $('.ai-ok', box);
  const more = $('.ai-more', box);
  btn.addEventListener('click', async () => {
    if (!more.hidden) {
      more.hidden = true; ok.textContent = ''; box.classList.remove('open'); btn.setAttribute('aria-expanded', 'false');
      return;
    }
    if (!aiCenters) await Promise.race([loadCallCenters(), new Promise((r) => setTimeout(r, 1500))]);
    const text = aiBriefText(aiBriefFacts(t, pax));
    $('.ai-text', box).textContent = text;
    more.hidden = false; box.classList.add('open'); btn.setAttribute('aria-expanded', 'true');
    ok.textContent = (await aiCopy(text)) ? '✓ 已複製，貼到 Muse、ChatGPT 或 Gemini 就可以' : '請長按下面的文字自己複製';
  });
}

if (typeof module !== 'undefined') module.exports = { aiBriefText };
