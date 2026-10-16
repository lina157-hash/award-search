// 「📷 貼上截圖」 in the 「請 AI 助理查官網」 card (cxmuse.js) for 國泰、華航、長榮、星宇: the owner opens the airline's own
// award page or app himself, takes a screenshot and picks it here (or pastes it with Ctrl+V). The page shrinks it to a
// ≤1600 px JPEG, sends it with the card's route, dates and cabin to /api/nl/image (lib/nlimage.js: the 一句話搜尋 model
// reads it; owner only, own daily cap; the image is never kept) and puts the lines that come back into 「貼上 AI 助理的
// 結果」, which draws the same calendar and offers 儲存到網站. Each read is a paid model call, so it happens only on a
// click that says so. Loaded after cxmuse.js; uses app.js's globals (esc, cashApi) and nlsearch.js's `nl` (server on).

// ---------- pure logic (test/nlimage.test.js) ----------
const CXS_AIRS = ['cx', 'ci', 'br', 'jx']; // lib/nlimage.js SHOT_AIRS
const CXS_MAX_PX = 1600; // longest side sent: enough for a calendar's small print, a few thousand image tokens
const CXS_MAX_CHARS = 1_900_000; // the data URL the server takes (lib/nlimage.js MAX_IMAGE_BYTES, as base64)
// Official prices: US$0.10 in / 0.50 out per million tokens for both models; one screenshot is about 2,000 image
// tokens, 1,000 of instructions and 300–1,000 out (a week to a month), so about US$0.001. An estimate (說明.md).
const CXS_COST = '約 US$0.001';

// The size a w × h image is sent at: the longest side at most max, the shape kept.
function cxsFit(w, h, max = CXS_MAX_PX) {
  const k = Math.min(1, max / Math.max(w, h, 1));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

// The server's answer in one line for the owner.
function cxsSummary(r) {
  const left = r.limit ? `今天還可以讀 ${Math.max(0, r.limit - (r.used || 0))} 張。` : '';
  const skip = [r.past ? `已過的日期 ${r.past} 筆` : '', r.bad ? `看不懂的 ${r.bad} 筆` : ''].filter(Boolean).join('、');
  return `✓ 讀到 ${r.days} 天（${r.fc}→${r.tc}${r.routeSeen ? '' : '，圖上沒有航線，用上面填的'}），已放進下面「貼上 AI 助理的結果」，看過沒問題再按「儲存到網站」。${skip ? `略過${skip}。` : ''}${r.mock ? '（示範：沒有真的讀圖，填的是範例資料）' : r.usd ? `這張約 US$${r.usd}。` : ''}${left}`;
}

// ---------- page ----------
if (typeof document !== 'undefined' && document.getElementById('search-results')) {
  const cxs = { busy: false, file: null, url: '' };
  const on = () => typeof nl === 'object' && nl.on; // nlsearch.js: the server has a model (or the demo stand-in)
  const rootEl = () => document.querySelector('#cx-muse [data-cxs]');

  window.cxShotPart = {
    html(t) {
      if (!t || !CXS_AIRS.includes(t.id) || !on()) return '';
      return `<div class="cxs" data-cxs="${esc(t.id)}">
        <div class="cxs-row"><button type="button" class="outline" data-cxs-pick>📷 貼上截圖<small>用 AI 讀圖・每張${CXS_COST}</small></button>
          <input type="file" accept="image/*" data-cxs-file hidden>
          <span class="hint">自己開${esc(t.site)}截下哩程日曆，網站讀成下面的日曆；圖不會保存。</span></div>
        <div class="cxs-stage" hidden><img alt="要讀的截圖"><div><button type="button" class="outline" data-cxs-go>用 AI 讀這張（${CXS_COST}）</button><button type="button" class="linklike" data-cxs-cancel>取消</button></div></div>
        <p class="cxs-msg" role="status" aria-live="polite"></p>
      </div>`;
    },
  };

  const say = (text, kind = '') => {
    const el = rootEl()?.querySelector('.cxs-msg');
    if (!el) return;
    el.className = `cxs-msg${kind ? ` ${kind}` : ''}`;
    el.textContent = text;
  };
  const unstage = () => {
    if (cxs.url) URL.revokeObjectURL(cxs.url);
    Object.assign(cxs, { file: null, url: '' });
    const box = rootEl()?.querySelector('.cxs-stage');
    if (box) { box.hidden = true; box.querySelector('img').removeAttribute('src'); }
  };
  // A pasted image waits here until the owner presses the button that says it uses AI.
  const stage = (file) => {
    unstage();
    cxs.file = file;
    cxs.url = URL.createObjectURL(file);
    const box = rootEl().querySelector('.cxs-stage');
    box.querySelector('img').src = cxs.url;
    box.hidden = false;
    say('');
  };

  // The file → a JPEG data URL at most CXS_MAX_PX on its longest side (white behind a transparent PNG).
  async function toJpeg(file) {
    if (file.type && !/^image\//.test(file.type)) throw new Error('請選一張圖片（PNG 或 JPG 截圖）');
    if (file.size > 30e6) throw new Error('這張圖太大（超過 30 MB），請先裁切再試');
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((ok, bad) => {
        const i = new Image();
        i.onload = () => ok(i);
        i.onerror = () => bad(new Error('這張圖打不開，請換一張 PNG 或 JPG 截圖'));
        i.src = url;
      });
      const { w, h } = cxsFit(img.naturalWidth, img.naturalHeight);
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const g = c.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, w, h);
      g.drawImage(img, 0, 0, w, h);
      for (const q of [0.85, 0.7, 0.55]) {
        const d = c.toDataURL('image/jpeg', q);
        if (d.length <= CXS_MAX_CHARS) return d;
      }
      throw new Error('圖片縮小後還是太大，請先裁切再試');
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function readShot(file) {
    const root = rootEl();
    const f = window.cxMusePart?.fields?.();
    if (cxs.busy || !root || !f || !file) return;
    cxs.busy = true;
    const btns = root.querySelectorAll('[data-cxs-pick], [data-cxs-go]');
    btns.forEach((b) => { b.disabled = true; });
    try {
      say('縮小圖片中…');
      const image = await toJpeg(file);
      say('AI 讀圖中…（大約 5 到 20 秒）');
      const r = await cashApi('/api/nl/image', { pass: '截圖讀取', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image, ...f }) });
      unstage();
      window.cxMusePart.addText(r.text);
      say(cxsSummary(r), 'ok');
      // The calendar sits below the long instruction: bring it up.
      document.querySelector('#cx-muse .cxm-paste')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      say(err.message || '讀圖失敗，請再試一次', 'err');
    } finally {
      cxs.busy = false;
      rootEl()?.querySelectorAll('[data-cxs-pick], [data-cxs-go]').forEach((b) => { b.disabled = false; });
    }
  }

  const results = document.getElementById('search-results');
  results.addEventListener('click', (e) => {
    if (e.target.closest('[data-cxs-pick]')) { rootEl()?.querySelector('[data-cxs-file]').click(); return; }
    if (e.target.closest('[data-cxs-go]')) { readShot(cxs.file); return; }
    if (e.target.closest('[data-cxs-cancel]')) { unstage(); say(''); }
  });
  // Picking a file is the click on 「📷 貼上截圖」 carried through: read it at once.
  results.addEventListener('change', (e) => {
    if (!e.target.matches?.('[data-cxs-file]')) return;
    const file = e.target.files?.[0];
    e.target.value = ''; // the same file can be picked again
    if (file) readShot(file);
  });
  // Ctrl+V of an image inside the card (or with nothing else focused): shown first, read only on the button.
  document.addEventListener('paste', (e) => {
    const root = rootEl();
    if (!root || cxs.busy) return;
    const inCard = e.target.closest?.('#cx-muse');
    if (!inCard && e.target.closest?.('input, textarea, select, [contenteditable]')) return;
    const file = [...(e.clipboardData?.files || [])].find((x) => /^image\//.test(x.type));
    if (!file) return;
    e.preventDefault();
    stage(file);
  });
  document.addEventListener('search:start', unstage);
}

if (typeof module === 'object' && module.exports) module.exports = { cxsFit, cxsSummary, CXS_AIRS, CXS_MAX_PX, CXS_MAX_CHARS };
