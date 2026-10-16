// 買或等 (查現金票, round 6 extra X2): one plain line under Google's 價格水準: buy now, or wait and let 追蹤降價 say
// when it drops; and, when the price history Google sent shows a clear move over the last two weeks, by how much.
// Worded from Google's own level (low / typical / high) and the history already on the page: nothing is forecast and
// no quota is spent. app.js renderCash calls cashVerdictHtml(ins, { watch }) under the insight box; `watch`: the
// site has 追蹤降價 (its 📉 button comes with a chosen flight). Classic script; the tests load it with require().

// A clear two-week trend in [[unix seconds, NT$], …], or null: the least-squares line over the last 14 days moves at
// least 5% and fits the points well (R² ≥ 0.5), with at least 5 points spread over 11 days or more.
function cvTrend(history, { days = 14, min = 0.05 } = {}) {
  const pts = (Array.isArray(history) ? history : [])
    .map((h) => [Number(h?.[0]) > 1e11 ? Number(h[0]) / 1000 : Number(h?.[0]), Number(h?.[1])])
    .filter(([t, p]) => Number.isFinite(t) && p > 0).sort((a, b) => a[0] - b[0]);
  if (pts.length < 5) return null;
  const last = pts.at(-1)[0];
  const win = pts.filter(([t]) => t >= last - days * 86400);
  if (win.length < 5 || last - win[0][0] < (days - 3) * 86400) return null;
  const n = win.length;
  const mx = win.reduce((s, [t]) => s + t, 0) / n;
  const my = win.reduce((s, [, p]) => s + p, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const [t, p] of win) { sxy += (t - mx) * (p - my); sxx += (t - mx) ** 2; syy += (p - my) ** 2; }
  if (!sxx || !syy) return null;
  const slope = sxy / sxx;
  const start = my + slope * (win[0][0] - mx);
  const end = my + slope * (last - mx);
  const pct = start > 0 ? (end - start) / start : 0;
  if ((sxy * sxy) / (sxx * syy) < 0.5 || Math.abs(pct) < min) return null;
  return { dir: pct > 0 ? 'up' : 'down', pct: Math.round(pct * 100) };
}
const cvTrendText = (t) => (!t ? '' : t.dir === 'up' ? `過去兩週在漲（約 +${t.pct}%）` : `過去兩週在跌（約 −${-t.pct}%）`);

// The advice for Google's level, or null for a level it did not give.
function cvVerdict(level, { watch = false } = {}) {
  const later = watch ? '選好航班後按「📉 追蹤降價」，降價時通知你' : '可以過幾天再查一次';
  if (level === 'low') return { cls: 'good', lead: '比平常便宜', text: '現在買划算。' };
  if (level === 'typical') return { cls: '', lead: '價格一般', text: `不急的話，${later}。` };
  if (level === 'high') return { cls: 'bad', lead: '比平常貴', text: `建議先別急著買，${later}。` };
  return null;
}
function cashVerdictHtml(ins, { watch = false } = {}) {
  const v = cvVerdict(ins?.level, { watch });
  if (!v) return '';
  const trend = cvTrendText(cvTrend(ins.history));
  return `<div class="cash-verdict ${v.cls}"><p>💡 <b>${v.lead}</b>，${v.text}${trend ? ` <span class="cv-trend">${trend}。</span>` : ''}</p><p class="hint">依 Google 航班的「價格水準」判斷，不是價格預測。</p></div>`;
}

if (typeof module === 'object' && module.exports) module.exports = { cvTrend, cvTrendText, cvVerdict, cashVerdictHtml };
