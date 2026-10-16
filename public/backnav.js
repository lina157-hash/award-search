// Back gesture (a phone's swipe back, the browser's ← button): switching tabs and opening a dialog each add a history
// entry, so Back closes the dialog (航班明細, the date picker, 提醒…) or returns to the previous tab instead of leaving
// the site. Query updates inside a tab still replace the entry (app.js setTabUrl), so history doesn't fill up.
// Classic script loaded before app.js: app.js calls backNav.tab() from showTab; the dialog watcher and the popstate
// handler below call app.js's navResync() / navFromUrl() only when they run, after everything has loaded.

// The bookkeeping, kept apart from the page so the tests can drive it with a stand-in history.
// hist: { state, pushState, replaceState, go }; canPush(): may add entries (false before the visitor has interacted:
// browsers skip such entries on Back anyway); defer(fn): run fn after the current task; onTab(): show the tab the URL
// now names; onResync(): write the current view back into the URL after a dialog's entry is gone.
function createBackNav({ hist, canPush = () => true, defer = (f) => setTimeout(f, 0), onTab = () => {}, onResync = () => {} }) {
  const open = []; // [{ dlg, id }]: dialogs that own an entry, oldest first
  let spare = 0; // entries left by dialogs that closed: the next push takes one over, or they are given back
  let skip = 0; // pops caused by our own go(-n), to ignore
  let n = 0;
  // A dialog closed by dlg.close() is closed at once, but its watcher runs later: settle it before touching history.
  const settle = () => { for (const o of [...open]) if (!o.dlg.open) closed(o.dlg); };
  function entry(state, url) {
    settle();
    if (spare) { spare--; hist.replaceState(state, '', url); } else hist.pushState(state, '', url);
  }
  function release() {
    if (!spare) return;
    const k = spare;
    spare = 0;
    skip++;
    hist.go(-k);
  }
  function closed(dlg) {
    const i = open.findIndex((o) => o.dlg === dlg);
    if (i < 0) return;
    const [o] = open.splice(i, 1);
    // Still on its entry: give it back after this task, unless a tab switch or another dialog takes it over first.
    // (Under a newer entry it stays behind as a plain copy of the page's URL.)
    if (hist.state?.r6dlg === o.id) { spare++; defer(release); }
  }
  return {
    // A tab switch the visitor made: a new entry (the query updates that follow replace it).
    tab(url) {
      if (canPush()) entry(null, url);
      else hist.replaceState(hist.state, '', url);
    },
    opened(dlg, url) {
      settle();
      if (!canPush() || open.some((o) => o.dlg === dlg)) return;
      const id = ++n;
      entry({ r6dlg: id }, url);
      open.push({ dlg, id });
    },
    closed,
    // popstate: ours to ignore, a dialog to close (Back while it was open), or a tab to show.
    pop() {
      if (skip) { skip--; onResync(); return; }
      settle();
      const o = open.pop();
      if (o) {
        if (o.dlg.open) o.dlg.close();
        onResync();
        return;
      }
      onTab();
    },
    get depth() { return open.length; },
  };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  // eslint-disable-next-line no-var
  var backNav = createBackNav({
    hist: history,
    canPush: () => navigator.userActivation?.hasBeenActive !== false,
    onTab: () => { if (typeof navFromUrl === 'function') navFromUrl(); },
    onResync: () => { if (typeof navResync === 'function') navResync(); },
  });
  addEventListener('popstate', () => backNav.pop());
  // Any modal dialog on the page, whoever opens it: watch the open attribute instead of hooking every showModal().
  const modal = (d) => { try { return d.matches(':modal'); } catch { return true; } }; // :modal is newer than <dialog>
  new MutationObserver((list) => {
    for (const m of list) {
      const d = m.target;
      if (d.tagName !== 'DIALOG') continue;
      if (d.open && modal(d)) backNav.opened(d, location.href);
      else if (!d.open) backNav.closed(d);
    }
  }).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['open'] });
}

if (typeof module === 'object' && module.exports) module.exports = { createBackNav };
