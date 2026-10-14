// 我的點數 extras, loaded after features.js and sharing its globals (wallet, reach, transferRates, calcConvert…):
// miles expiry dates and reminders (data/expiry.json, lib/expiry.js), the 「用哪張卡最快湊到目標」 transfer plan,
// the cost of buying a shortfall (data/buymiles.json + promos.json buy offers), and countdowns for dated rules
// (points.json validUntil, promos.json end, alliances.json leaving members, data/changes.json). No paid quota.

// ---------- dates ----------
const EW_DAY = 864e5;
const ewDays = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / EW_DAY);
const ewIso = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && Number.isFinite(Date.parse(`${s}T00:00:00Z`));
// Same arithmetic as lib/expiry.js: a day past the end of the shorter month lands on its last day.
function ewAddMonths(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last))).toISOString().slice(0, 10);
}
const ewLeft = (days) => (days < 0 ? '已過期' : days === 0 ? '今天截止' : `還剩 ${days} 天`);
const ewYmd = (iso, today) => `${iso.slice(0, 4) !== today.slice(0, 4) ? `${iso.slice(0, 4)}/` : ''}${mmdd(iso)}`;

// ---------- E1: miles expiry ----------
const expiryRule = (key) => data.expiry?.programs?.[key] || null;
function expiryOfEntry(rule, entered) {
  if (!ewIso(entered) || rule?.kind === 'none') return null;
  return rule?.kind === 'activity' && rule.months ? ewAddMonths(entered, rule.months) : entered;
}
// Every miles balance with a date, soonest first: { key, miles, entered, date, days, rule }.
function walletExpiryList(w = wallet, today = isoDate(0)) {
  return Object.entries(w.expiry || {}).map(([key, entered]) => {
    const rule = expiryRule(key);
    const date = expiryOfEntry(rule, entered);
    return date && w.miles[key] ? { key, miles: w.miles[key], entered, date, days: ewDays(today, date), rule } : null;
  }).filter(Boolean).sort((a, b) => a.date.localeCompare(b.date));
}
// The date field on a miles row in 我的點數: the expiry itself, or the last activity for activity-based programs.
function expiryInputHtml(key) {
  const rule = expiryRule(key);
  if (rule?.kind === 'none') return '<small class="w-exp w-exp-none">不會過期</small>';
  const activity = rule?.kind === 'activity';
  const label = activity ? '最後活動' : '到期日';
  return `<label class="w-exp" title="${esc(rule?.rule || '填航空公司帳戶上顯示的最早到期日')}"><small>${label}</small><input type="date" data-exp="${esc(key)}" value="${esc(wallet.expiry?.[key] || '')}" aria-label="${esc(programName(key))} ${label}"></label>`;
}
function setExpiry(key, value) {
  wallet.expiry ||= {};
  if (ewIso(value) && wallet.miles[key]) wallet.expiry[key] = value; else delete wallet.expiry[key];
  store.set(WALLET_KEY, wallet);
}

// Owner reminders without an account (passcode-protected, like the seat alerts): what was last saved on this device.
const EXP_REMIND_KEY = 'expiryRemind:v1';
const expirySig = () => JSON.stringify(Object.entries(wallet.expiry || {}).sort());
function expiryRemindHtml(list) {
  const steps = (data.expiry?.reminderDays || [90, 30, 7]).join('／');
  if (typeof signedIn === 'function' && signedIn()) {
    if (!acct.emailEnabled) return '<p class="hint">網站還沒設定寄信服務，暫時無法寄到期提醒。</p>';
    if (typeof joinedHere === 'function' && !joinedHere()) return '<p class="hint">這台裝置的資料還沒存進帳號；合併到帳號後，到期前會寄 Email 提醒你。</p>';
    return `<p class="hint">📧 到期前 ${steps} 天會各寄一次提醒到 ${esc(acct.status.email)}（每天早上檢查）。</p>`;
  }
  if (!alertCfg.store) return typeof acct !== 'undefined' && acct.configured ? '<p class="hint">登入帳號後，到期前會寄 Email 提醒你。</p>' : '';
  const saved = store.get(EXP_REMIND_KEY, null);
  if (saved && saved.sig === expirySig()) return `<p class="hint">🔔 已設定：到期前 ${steps} 天提醒${saved.email ? `寄到 ${esc(saved.email)}` : ''}，也會傳到已連結的 Telegram。<button type="button" class="linklike" data-exp-remind>修改</button></p>`;
  return `<p class="hint">${saved ? '日期有變更，' : ''}<button type="button" class="linklike" data-exp-remind>${saved ? '更新到期提醒' : `到期前 ${steps} 天用 Email／Telegram 提醒我`}</button>${typeof acct !== 'undefined' && acct.configured ? '，或登入帳號自動寄到帳號 Email' : ''}。</p>
    <form class="exp-remind-form" hidden><input type="email" name="email" placeholder="Email（可留空，只傳 Telegram）" value="${esc(saved?.email ?? store.get(ALERT_EMAIL_KEY, ''))}" autocomplete="email" aria-label="提醒寄到的 Email"><button type="submit" class="primary small">儲存提醒</button></form>`;
}
function renderWalletExpiry() {
  const host = $('#wallet-expiry');
  if (!host) return;
  const today = isoDate(0);
  const list = walletExpiryList(wallet, today);
  const dateable = Object.keys(wallet.miles).some((k) => expiryRule(k)?.kind !== 'none');
  if (!list.length) {
    host.innerHTML = dateable ? '<p class="hint exp-empty">⏰ 在哩程旁填上到期日（亞洲萬里通、Aeroplan 這類有活動就延長的，填最後一次活動日），這裡會列出快到期的哩程並提醒你。</p>' : '';
    return;
  }
  const li = (x) => {
    const soon = x.days <= 90;
    const how = x.rule?.kind === 'activity' ? `<small>最後活動 ${ewYmd(x.entered, today)} 加 ${x.rule.months} 個月</small>` : '';
    return `<li class="${x.days < 0 ? 'gone' : soon ? 'soon' : ''}"><span><b>${esc(programName(x.key))}</b> ${fmt(x.miles)} 哩${how}</span>
      <span class="exp-when">${ewYmd(x.date, today)} 到期 <span class="tag ${soon ? 'until soon' : 'until'}">${ewLeft(x.days)}</span></span></li>`;
  };
  host.innerHTML = `<h3 class="sub">⏰ 哩程到期</h3><ul class="exp-list">${list.map(li).join('')}</ul>${expiryRemindHtml(list)}`;
}
async function saveOwnerRemind(form) {
  const email = form.email.value.trim();
  const btn = $('button[type=submit]', form);
  btn.disabled = true;
  try {
    const r = await cashApi('/api/expiry', { method: 'POST', body: JSON.stringify({ email, wallet: { miles: wallet.miles, expiry: wallet.expiry } }), headers: { 'content-type': 'application/json' } });
    store.set(EXP_REMIND_KEY, { email: r.email ?? email, sig: expirySig() });
    if (email) store.set(ALERT_EMAIL_KEY, email);
    toast(r.count ? `已設定 ${r.count} 筆哩程的到期提醒` : '已清除到期提醒');
    renderWalletExpiry();
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
}

// ---------- E11: which points to move to reach a target ----------
// Smallest x in [1, max] with fn(x) >= target (fn only grows with x), or null.
function ewPointsFor(target, fn, max) {
  if (!(max > 0) || fn(max) < target) return null;
  let lo = 1, hi = max;
  while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (fn(mid) >= target) hi = mid; else lo = mid + 1; }
  return lo;
}
// groups: one per balance, each with the ways it can reach the program: [{ id, choices: [{ label, balance, fn }] }].
// A balance is used once (directly or via one hotel). Every mix is tried; inside a mix the most efficient choices are
// moved in full and one is topped up with just enough points, which honours minimums and transfer units.
// Returns the plan with the fewest points (then the fewest transfers): { ok, steps, points, miles } or the best partial.
function planTransfers(need, groups) {
  if (!(need > 0)) return { ok: true, steps: [], points: 0, miles: 0 };
  const opts = groups.map((g) => g.choices.map((c) => {
    const full = c.fn(c.balance) || 0;
    return full > 0 ? { ...c, group: g.id, full, used: ewPointsFor(full, c.fn, c.balance) || c.balance } : null;
  }).filter(Boolean)).filter((x) => x.length).map((x) => x.sort((a, b) => b.full - a.full))
    .sort((a, b) => b[0].full - a[0].full).slice(0, 8);
  // Not enough even with everything: the most each balance can give, without trying every mix.
  const top = opts.map((x) => x[0]);
  if (top.reduce((n, o) => n + o.full, 0) < need) {
    return { ok: false, steps: top.map((o) => ({ ...o, points: o.used, miles: o.full })), points: top.reduce((n, o) => n + o.used, 0), miles: top.reduce((n, o) => n + o.full, 0) };
  }
  let best = null;
  const pick = [];
  const visit = (i) => {
    if (i === opts.length) {
      if (pick.reduce((n, o) => n + o.full, 0) < need) return;
      for (let j = 0; j < pick.length; j++) {
        const others = pick.reduce((n, o, k) => (k === j ? n : n + o.full), 0);
        const rem = need - others;
        if (rem <= 0) continue; // a smaller mix already covers it
        const pts = ewPointsFor(rem, pick[j].fn, pick[j].balance);
        if (pts == null) continue;
        const points = pick.reduce((n, o, k) => n + (k === j ? pts : o.used), 0);
        if (!best || points < best.points || (points === best.points && pick.length < best.steps.length)) {
          best = { ok: true, points, steps: pick.map((o, k) => ({ ...o, points: k === j ? pts : o.used, miles: k === j ? o.fn(pts) : o.full })) };
        }
      }
      return;
    }
    visit(i + 1);
    for (const o of opts[i]) { pick.push(o); visit(i + 1); pick.pop(); }
  };
  visit(0);
  return { ...best, miles: best.steps.reduce((n, s) => n + s.miles, 0) };
}
// The wallet's ways into one program: each bank directly or through its best hotel, and own hotel points.
function goalGroups(key) {
  const groups = [];
  const t = toAir();
  const hotelNames = data.points?.calc?.hotels?.programs || {};
  for (const src of walletSources()) {
    const bal = wallet.banks[src.id];
    if (!bal) continue;
    const choices = [];
    const direct = transferRates(key).find((x) => x.source.id === src.id);
    if (direct) {
      const bonus = direct.rate.to !== 'other' ? transferBonus(direct.source, direct.rate.to) : null;
      choices.push({ label: `${src.bank} ${src.program}`, via: '', ratio: ratioLabel(direct.rate), bonus: Boolean(bonus), balance: bal, fn: (x) => withBonus(calcConvert(direct.rate, x, 'p2m').value || 0, bonus) });
    }
    if (t) {
      for (const r of data.points.calc.hotels.rates || []) {
        const partner = r.source === src.id && hotelPartner(r.to, key);
        if (!partner) continue;
        const fn = (x) => { const hp = calcConvert(hotelRate(r), x, 'p2m').value || 0; return hp ? hotelToAir(r.to, partner, hp).value || 0 : 0; };
        choices.push({ label: `${src.bank} ${src.program}`, via: hotelNames[r.to] || r.to, balance: bal, fn });
      }
    }
    if (choices.length) groups.push({ id: src.id, choices });
  }
  for (const [h, bal] of Object.entries(wallet.hotels)) {
    const partner = t && hotelPartner(h, key);
    if (partner) groups.push({ id: `h:${h}`, choices: [{ label: `${hotelNames[h] || h}（自有飯店點數）`, via: '', hotel: true, balance: bal, fn: (x) => hotelToAir(h, partner, x).value || 0 }] });
  }
  // Within one bank only its best hotel route competes with the direct transfer, which keeps the search small.
  for (const g of groups) {
    const direct = g.choices.filter((c) => !c.via);
    const detours = g.choices.filter((c) => c.via).sort((a, b) => b.fn(b.balance) - a.fn(a.balance));
    g.choices = [...direct, ...detours.slice(0, 1)];
  }
  return groups;
}
function walletPlan(key, target) {
  const own = wallet.miles[programKeyOf(key)] || 0;
  const plan = planTransfers(Math.max(0, target - own), goalGroups(key));
  return { ...plan, own, total: own + plan.miles, target };
}

const GOAL_KEY = 'walletGoal:v1';
const ewGoal = { key: '', miles: 0 };
function goalPrograms() {
  // Programs the site knows well; the long tail of hotel-only airlines stays in 繞路兌換.
  const keys = [...new Set([...WALLET_PROGRAMS, ...Object.keys(PROGRAM_TRANSFER), ...(toAir() ? detourAirlines().filter(searchable) : [])])];
  return keys.filter((k) => k !== 'other').sort((a, b) => searchable(b) - searchable(a) || airName(a).localeCompare(airName(b), 'zh-Hant'));
}
function renderWalletGoal() {
  const host = $('#wallet-goal');
  if (!host) return;
  if (walletEmpty()) { host.innerHTML = ''; return; }
  if (!$('#goal-form', host)) {
    Object.assign(ewGoal, store.get(GOAL_KEY, {}) || {});
    const progs = goalPrograms();
    if (!progs.includes(ewGoal.key)) ewGoal.key = Object.keys(wallet.miles)[0] || 'eva';
    host.innerHTML = `<h3 class="sub">🎯 想湊到多少哩？</h3>
      <form id="goal-form" class="goal-bar" autocomplete="off">
        <select name="key" aria-label="想換的計畫">${progs.map((k) => `<option value="${esc(k)}" ${k === ewGoal.key ? 'selected' : ''}>${esc(airName(k))}</option>`).join('')}</select>
        <input type="number" name="miles" min="0" step="1000" inputmode="numeric" placeholder="目標哩數，例如 70000" value="${ewGoal.miles || ''}" aria-label="目標哩數">
      </form><div id="goal-out"></div>`;
    const f = $('#goal-form', host);
    const sync = () => {
      ewGoal.key = f.key.value;
      ewGoal.miles = Math.max(0, Math.floor(Number(f.miles.value) || 0));
      store.set(GOAL_KEY, { ...ewGoal });
      renderGoalOut();
    };
    f.addEventListener('input', sync);
    f.addEventListener('change', sync);
    f.addEventListener('submit', (e) => e.preventDefault());
  }
  renderGoalOut();
}
function renderGoalOut() {
  const host = $('#goal-out');
  if (!host) return;
  const { key, miles: target } = ewGoal;
  if (!(target > 0)) { host.innerHTML = '<p class="hint">選一個計畫、填目標哩數，這裡會用你填的點數算出最省點數的轉法。</p>'; return; }
  const p = walletPlan(key, target);
  const step = (s) => `<li><span><b>${esc(s.label)}</b>${s.via ? ` → ${esc(s.via)}` : ''}</span><span>轉 <b>${fmt(s.points)}</b> ${s.hotel ? '飯店點' : '點'} → ${fmt(s.miles)} 哩${s.bonus ? ' <span class="pill">🎁 含加贈</span>' : ''}${s.points < s.balance ? `<small>剩 ${fmt(s.balance - s.points)} 點</small>` : ''}</span></li>`;
  const own = p.own ? `<li><span><b>自有 ${esc(airName(key))}</b></span><span>${fmt(Math.min(p.own, target))} 哩</span></li>` : '';
  const slow = p.steps.some((s) => s.via) ? '<p class="hint">經飯店繞路要多等幾天到幾週，飯店點數轉出後不能退回。</p>' : '';
  if (p.ok) {
    host.innerHTML = `<p class="goal-sum"><span class="ok-text">湊得到</span>　${p.steps.length ? `共轉 ${fmt(p.points)} 點、${p.steps.length} 筆，合計 ${fmt(p.total)} 哩` : `自有哩程就夠了（${fmt(p.own)} 哩）`}</p>
      ${own || p.steps.length ? `<ul class="goal-steps">${own}${p.steps.map(step).join('')}</ul>` : ''}${slow}
      <p class="hint">依「點數換算」的比率，最低點數與轉換單位都算進去；同一筆點數只用一次。先確認有位子再轉，轉出後通常不能退回。</p>`;
    return;
  }
  const short = target - p.total;
  host.innerHTML = `<p class="goal-sum">最多湊到 ${fmt(p.total)} 哩，<b class="warn">還差 ${fmt(short)} 哩</b></p>
    ${own || p.steps.length ? `<ul class="goal-steps">${own}${p.steps.map(step).join('')}</ul>` : '<p class="hint">你填的點數都不能轉進這個計畫。</p>'}${slow}${buyMilesHtml(key, short)}`;
}
function renderWalletExtras() {
  renderWalletExpiry();
  renderWalletGoal();
}
function bindWalletExtras(host) {
  host.addEventListener('change', (e) => {
    const k = e.target.dataset?.exp;
    if (k == null) return;
    setExpiry(k, e.target.value);
    renderWalletExpiry();
  });
  host.addEventListener('click', (e) => {
    if (!e.target.closest('[data-exp-remind]')) return;
    const f = $('.exp-remind-form', host);
    if (!f) { store.del(EXP_REMIND_KEY); renderWalletExpiry(); $('.exp-remind-form', host)?.removeAttribute('hidden'); return; }
    f.hidden = false;
    f.email.focus();
  });
  host.addEventListener('submit', (e) => {
    if (!e.target.classList.contains('exp-remind-form')) return;
    e.preventDefault();
    saveOwnerRemind(e.target);
  });
}

// ---------- E13: what buying the shortfall costs ----------
const CUR_SIGN = { USD: 'US$', TWD: 'NT$', EUR: '€', GBP: '£', CAD: 'CA$' };
// "US$18.8/千哩" → { currency: 'USD', perThousand: 18.8 }; anything else → null.
function parseBuyPrice(text) {
  const m = /(US\$|NT\$|CA\$|€|£)\s*([\d.]+)\s*\/\s*(?:千|1,?000)/.exec(String(text || ''));
  if (!m) return null;
  return { currency: Object.keys(CUR_SIGN).find((c) => CUR_SIGN[c] === m[1]), perThousand: Number(m[2]) };
}
// The price to use: a running sale with a stated price first, then the usual price from buymiles.json.
function buyPriceFor(key, today = isoDate(0)) {
  const k = programKeyOf(key);
  const sale = (data.promos?.promos || []).filter((p) => p.type === 'buy' && p.program === k && p.start <= today && today <= p.end);
  const priced = sale.map((p) => ({ p, price: parseBuyPrice(p.price) })).find((x) => x.price);
  const base = data.buymiles?.programs?.[k];
  if (priced) return { ...priced.price, promo: priced.p, base };
  if (base?.perThousand) return { currency: base.currency || 'USD', perThousand: base.perThousand, base, promo: null, sale: sale[0] || null };
  return sale[0] ? { promo: null, sale: sale[0] } : null;
}
const twdText = (amount, currency) => {
  if (currency === 'TWD') return '';
  const rate = typeof fxCache !== 'undefined' && fxCache?.rates?.[currency];
  if (!rate && typeof loadFx === 'function') loadFx().then(fillTwd).catch(() => {});
  return `<span data-twd="${currency}:${amount}">${rate ? `（約 NT$${fmt(Math.round(amount * rate))}）` : ''}</span>`;
};
function fillTwd() {
  for (const el of $$('[data-twd]')) {
    const [cur, amt] = el.dataset.twd.split(':');
    const rate = fxCache?.rates?.[cur];
    if (rate && !el.textContent) el.textContent = `（約 NT$${fmt(Math.round(Number(amt) * rate))}）`;
  }
}
function buyCost(key, short) {
  const price = buyPriceFor(key);
  if (!price?.perThousand || !(short > 0)) return null;
  const amount = Math.round((short / 1000) * price.perThousand * 100) / 100;
  return { ...price, amount };
}
function buyMilesHtml(key, short, compact = false) {
  const price = buyPriceFor(key);
  if (!price || !(short > 0)) return '';
  const sign = (c) => CUR_SIGN[c] || `${c} `;
  const sale = price.promo || price.sale;
  const saleText = sale ? `🎁 ${esc(sale.title)}（到 ${mmdd(sale.end)}）` : '';
  if (!price.perThousand) return compact ? '' : `<p class="buy-line">${saleText}</p>`;
  const c = buyCost(key, short);
  const money = `${sign(c.currency)}${fmt(Math.ceil(c.amount))}${twdText(Math.ceil(c.amount), c.currency)}`;
  if (compact) return `<small class="buy-short">買哩約 ${money}</small>`;
  const src = price.promo ? (price.promo.sources || [])[0] : data.buymiles?.source;
  const how = price.promo ? `促銷價 ${sign(c.currency)}${c.perThousand}／千哩` : `一般價約 ${sign(c.currency)}${c.perThousand}／千哩，未核實${price.base?.note ? `；${esc(price.base.note)}` : ''}`;
  return `<p class="buy-line">💵 差的 ${fmt(short)} 哩用買的約 <b>${money}</b><small>${how}${!price.promo && sale ? `・${saleText}` : ''}・多半另加稅費、有購買上限${src ? `・<a href="${esc(price.base?.url || src.url)}" target="_blank" rel="noopener">${price.base?.url ? '購買頁' : '價格來源'} ↗</a>` : ''}</small></p>`;
}
// 哩程試算 rows: what the wallet reaches for that program and, when short, what buying the rest costs.
function shortfallHtml(chartId, miles) {
  if (walletEmpty() || !(miles > 0)) return '';
  const key = String(chartId).replace(/_partner$/, '');
  const p = walletPlan(key, miles);
  if (p.ok) return '<small class="ok-text">你的點數夠換</small>';
  if (!p.total) return '';
  return `<small>你最多湊到 ${fmt(p.total)}，差 ${fmt(miles - p.total)} 哩</small>${buyMilesHtml(key, miles - p.total, true)}`;
}

// ---------- E5: countdowns for dated rules ----------
// The soonest validUntil on an entry or its rates (points.json), or null.
function validUntilOf(x) {
  const dates = [x?.validUntil, ...(Array.isArray(x?.rates) ? x.rates.map((r) => r.validUntil) : [])].filter(ewIso).sort();
  return dates[0] || null;
}
function untilTag(x) {
  const date = validUntilOf(x);
  if (!date) return '';
  const today = isoDate(0);
  const days = ewDays(today, date);
  if (days < 0) return `<span class="tag until gone" title="這個比率只保證到 ${date}，可能已經調整">比率期限已過，待確認</span>`;
  return `<span class="tag until${days <= 30 ? ' soon' : ''}" title="這個比率只保證到 ${date}">${days <= 60 ? ewLeft(days) : `到 ${ewYmd(date, today)}`}</span>`;
}
const bankProgram = (x) => (String(x.program).startsWith(x.bank) ? x.program : `${x.bank} ${x.program}`);
// Everything dated that is still ahead: { date, days, title, advice, kind, source }, soonest first.
function upcomingChanges(today = isoDate(0), { promoDays = 14 } = {}) {
  const out = [];
  const seen = new Set();
  const add = (x) => {
    if (!ewIso(x.date)) return;
    const days = ewDays(today, x.date);
    const id = `${x.date}|${x.key || x.title}`;
    if (days < 0 || seen.has(id)) return;
    seen.add(id);
    out.push({ ...x, days });
  };
  const pts = data.points || {};
  for (const s of pts.calc?.sources || []) {
    const date = validUntilOf(s);
    if (date) add({ date, key: s.bank, kind: 'rate', title: `${bankProgram(s)} 轉點比率保證期限`, advice: '之後比率可能調整，要用目前的比率請在這天前轉點' });
  }
  for (const t of pts.transfers || []) {
    const date = validUntilOf(t);
    if (date) add({ date, key: t.bank, kind: 'rate', title: `${bankProgram(t)} 轉點比率保證期限`, advice: '之後比率可能調整，要用目前的比率請在這天前轉點', source: t.source });
  }
  for (const p of data.promos?.promos || []) {
    if (p.start <= today && ewDays(today, p.end) <= promoDays) add({ date: p.end, kind: 'promo', title: `${p.title} 結束`, advice: p.type === 'buy' ? '買哩促銷最後一天' : '要拿加贈請在這天前完成轉點', source: (p.sources || [])[0] });
  }
  for (const a of data.alliances?.alliances || []) {
    for (const n of a.memberNotes || []) {
      if (n.status !== 'leaving') continue;
      const name = typeof airlineZh === 'function' ? airlineZh(n.code) : n.code;
      add({ date: n.date, kind: 'alliance', title: `${name}退出${a.name.replace(/\s+[A-Za-z].*$/, '')}`, advice: '用聯盟夥伴哩程換這家航空的票，要在這天前飛完', source: n.source });
    }
  }
  for (const c of data.changes?.changes || []) add({ date: c.date, kind: 'change', program: c.program, title: c.title, advice: c.advice || '', source: c.source });
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
function upcomingHtml() {
  const today = isoDate(0);
  const list = upcomingChanges(today);
  if (!list.length) return '';
  const first = list[0];
  const li = (x) => `<li><b>${esc(x.title)}</b> <span class="tag until${x.days <= 30 ? ' soon' : ''}">${ewLeft(x.days)}</span>
    <small>${ewYmd(x.date, today)}${x.advice ? `・${esc(x.advice)}` : ''}${x.source?.url ? ` <a href="${esc(x.source.url)}" target="_blank" rel="noopener">${esc(x.source.label || '來源')} ↗</a>` : ''}</small></li>`;
  return `<details class="promos upcoming"><summary>⏳ 即將變更 ${list.length} 項 <small>最近：${esc(first.title)}・${ewLeft(first.days)}</small></summary><ul>${list.map(li).join('')}</ul></details>`;
}
// A small badge on a 規則庫 program card when data/changes.json has a dated change for it.
function programChangeTag(id) {
  const today = isoDate(0);
  const c = (data.changes?.changes || []).filter((x) => x.program === id && ewIso(x.date) && x.date >= today).sort((a, b) => a.date.localeCompare(b.date))[0];
  return c ? `<span class="tag until" title="${esc(c.title)}">⏳ ${ewYmd(c.date, today)} 起有變更</span>` : '';
}
