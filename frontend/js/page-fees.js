/* page-fees.js - the Fee structure page, connected to the real database.
   How the fee structure works (decided by the owner):
   - It is a reusable template: one list of fees per CLASS and per TERM NUMBER (1, 2, 3). No year. Set once, reused every year.
   - It can be edited any day. Every save is a new VERSION; the latest is always on top and the older ones stay in the history.
   - It never locks anything. Billing (automatic, on the server) locks the latest version for a real term when that term starts.
     The page only tells you which real terms a version was locked into.
   - A class's optional fees for a term show up here by themselves (no toggle). They are set on the Optional fees page.
   Screens: (1) one card per class, (2) click a class -> Term 1 / 2 / 3 tabs with the latest fees, totals, history and Copy.
   Replaces the old range-based Fee structure screen. Only an admin can change anything (the server checks it too).
   Add to index.html AFTER page-admit.js:  <script src="js/page-fees.js"></script> */

const fx = {
  list: null, cls: null, classId: null, term: 1,
  error: null, loadToken: 0,
  sheet: null, draft: null, busy: false, sheetErr: null,
};

/* ---------------- styles (added once) ---------------- */
(function () {
  if (document.getElementById('fxStyle')) return;
  const css = document.createElement('style');
  css.id = 'fxStyle';
  css.textContent = [
    '.fx-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px}',
    '.fx-cc{text-align:left;font:inherit;color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:16px 18px;cursor:pointer;transition:border-color .15s}',
    '.fx-cc:hover{border-color:var(--matched)}',
    '.fx-cc h3{font-family:"Space Grotesk",sans-serif;font-size:17px;font-weight:600;margin:0 0 10px}',
    '.fx-cc .tr{display:flex;justify-content:space-between;gap:10px;font-size:13px;padding:5px 0;border-top:1px solid var(--line)}',
    '.fx-cc .tr span{color:var(--muted)}',
    '.fx-cc .tr b{font-family:"IBM Plex Mono",monospace;font-weight:500}',
    '.fx-cc .tr.none b{color:var(--cash);font-family:inherit;font-weight:400}',
    '.fx-back-link{font:inherit;color:var(--muted);background:transparent;border:0;padding:0;cursor:pointer;font-size:13px;margin-bottom:10px}',
    '.fx-back-link:hover{color:var(--ink)}',
    '.fx-tabs{display:flex;gap:8px;overflow-x:auto;padding:2px 2px 12px}',
    '.fx-tab{flex:0 0 auto;font:inherit;color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:10px 18px;cursor:pointer;display:flex;gap:10px;align-items:baseline}',
    '.fx-tab b{font-family:"Space Grotesk",sans-serif;font-weight:600;font-size:14px}',
    '.fx-tab span{font-family:"IBM Plex Mono",monospace;font-size:11.5px;color:var(--muted)}',
    '.fx-tab.on{background:var(--surface-raised);border-color:var(--matched);box-shadow:0 0 0 1px var(--matched) inset}',
    '.fx-panel{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:24px 26px 26px;min-width:0}',
    '.fx-ph{display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap}',
    '.fx-ph > div:first-child{flex:1;min-width:200px}',
    '.fx-eyebrow{font-family:"IBM Plex Mono",monospace;font-size:11.5px;letter-spacing:.06em;color:var(--muted);text-transform:uppercase}',
    '.fx-panel h2{font-family:"Space Grotesk",sans-serif;font-size:24px;font-weight:600;margin:4px 0 0}',
    '.fx-chips{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}',
    '.fx-chip{font-size:12px;color:var(--muted);border:1px solid var(--line);border-radius:20px;padding:3px 11px}',
    '.fx-chip.lock{color:var(--cash);border-color:rgba(217,164,65,.5)}',
    '.fx-tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:20px 0 4px}',
    '.fx-tile{background:var(--bg);border:1px solid var(--line);border-radius:13px;padding:13px 16px}',
    '.fx-tile span{display:block;font-size:12px;color:var(--muted)}',
    '.fx-tile b{display:block;margin-top:5px;font-family:"IBM Plex Mono",monospace;font-weight:500;font-size:19px}',
    '.fx-tile.grand{border-color:var(--matched)}',
    '.fx-panel h3{font-family:"Space Grotesk",sans-serif;font-size:14.5px;font-weight:600;margin:24px 0 4px;display:flex;align-items:baseline;gap:10px}',
    '.fx-panel h3 small{font-family:inherit;font-weight:400;font-size:12px;color:var(--muted)}',
    '.fx-list{border:1px solid var(--line);border-radius:13px;overflow:hidden;margin-top:10px}',
    '.fx-li{display:flex;align-items:center;gap:12px;padding:11px 16px;border-bottom:1px solid var(--line);font-size:14px}',
    '.fx-li:last-child{border-bottom:0}',
    '.fx-li .nm{flex:1;min-width:0;overflow-wrap:anywhere}',
    '.fx-li .am{font-family:"IBM Plex Mono",monospace;font-size:13.5px}',
    '.fx-li.total{background:var(--bg);font-weight:600}',
    '.fx-none{margin-top:10px;font-size:13px;color:var(--muted);padding:14px 16px;border:1px dashed var(--line);border-radius:13px}',
    '.fx-tl{margin-top:14px;position:relative;padding-left:22px}',
    '.fx-tl::before{content:"";position:absolute;left:5px;top:6px;bottom:6px;width:2px;background:var(--line)}',
    '.fx-v{position:relative;padding:0 0 16px}',
    '.fx-v:last-child{padding-bottom:0}',
    '.fx-v::before{content:"";position:absolute;left:-22px;top:5px;width:12px;height:12px;border-radius:50%;background:var(--surface);border:2px solid var(--line)}',
    '.fx-v.cur::before{border-color:var(--matched);background:var(--matched)}',
    '.fx-v .vh{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;font-size:13.5px}',
    '.fx-v .vh b{font-family:"Space Grotesk",sans-serif;font-weight:600}',
    '.fx-v .vh span{font-size:12px;color:var(--muted)}',
    '.fx-v ul{margin:6px 0 0;padding:0;list-style:none;font-size:13px;color:var(--muted);line-height:1.7}',
    '.fx-v li b{color:var(--ink);font-weight:500}',
    '.fx-n{font-family:"IBM Plex Mono",monospace;font-size:10.5px;color:var(--muted);border:1px solid var(--line);border-radius:20px;padding:1px 8px}',
    '.fx-empty{text-align:center;padding:44px 20px}',
    '.fx-empty h2{font-size:21px}.fx-empty p{color:var(--muted);font-size:13.5px;max-width:420px;margin:8px auto 18px;line-height:1.6}',
    '.fx-top{display:flex;gap:10px;flex-wrap:wrap;align-items:center}',
    '.fx-btn{font:inherit;font-size:13.5px;font-weight:600;border-radius:10px;padding:10px 18px;cursor:pointer;border:1px solid var(--line);background:transparent;color:var(--ink)}',
    '.fx-btn:hover:not(:disabled){border-color:var(--muted)}',
    '.fx-btn.go{background:var(--matched);border-color:var(--matched);color:#0E1613}',
    '.fx-btn:disabled{opacity:.5;cursor:not-allowed}',
    '.fx-link{font:inherit;color:var(--matched);background:transparent;border:0;padding:0;cursor:pointer;text-decoration:underline;font-size:inherit}',
    '.fx-btn:focus-visible,.fx-tab:focus-visible,.fx-cc:focus-visible,.fx-in:focus-visible{outline:2px solid var(--matched);outline-offset:2px}',
    /* the side sheet */
    '.fx-back{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:60;opacity:0;pointer-events:none;transition:opacity .25s}',
    '.fx-back.show{opacity:1;pointer-events:auto}',
    '.fx-sheet{position:fixed;top:12px;right:12px;bottom:12px;width:min(520px,calc(100vw - 24px));background:var(--surface);border:1px solid var(--line);border-radius:22px;box-shadow:0 24px 60px rgba(0,0,0,.55);z-index:61;display:flex;flex-direction:column;transform:translateX(calc(100% + 30px));transition:transform .3s cubic-bezier(.2,.8,.2,1);overflow:hidden}',
    '.fx-sheet.show{transform:none}',
    '.fx-sh{padding:22px 26px 12px;display:flex;gap:12px;align-items:flex-start}',
    '.fx-sh h2{font-family:"Space Grotesk",sans-serif;font-size:20px;margin:0}.fx-sh p{margin:4px 0 0;font-size:13px;color:var(--muted)}',
    '.fx-xx{margin-left:auto;font:inherit;font-size:16px;width:34px;height:34px;border-radius:50%;border:1px solid var(--line);background:transparent;color:var(--muted);cursor:pointer;flex-shrink:0}',
    '.fx-sbody{flex:1;overflow:auto;padding:4px 26px 18px}',
    '.fx-blk{padding:14px 0;border-top:1px solid var(--line)}',
    '.fx-blk:first-child{border-top:0}',
    '.fx-blk h4{font-family:"Space Grotesk",sans-serif;font-size:14.5px;margin:0 0 3px}',
    '.fx-help{font-size:12.5px;color:var(--muted);margin:0 0 12px;line-height:1.55}',
    '.fx-row{display:grid;grid-template-columns:minmax(0,1fr) 130px 34px;gap:8px;margin-bottom:8px;align-items:center}',
    '.fx-in{font:inherit;font-size:14px;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:9px;padding:9px 11px;width:100%;min-width:0;box-sizing:border-box}',
    '.fx-in:focus{outline:none;border-color:var(--matched)}',
    '.fx-in.mono{font-family:"IBM Plex Mono",monospace;text-align:right}',
    '.fx-x{font:inherit;font-size:13px;width:34px;height:34px;border-radius:50%;border:1px solid var(--line);background:transparent;color:var(--muted);cursor:pointer}',
    '.fx-x:hover{color:var(--alert);border-color:var(--alert)}',
    '.fx-pills{display:flex;gap:7px;flex-wrap:wrap}',
    '.fx-pill{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--line);border-radius:20px;padding:6px 13px;font-size:13px;cursor:pointer;background:var(--bg);user-select:none}',
    '.fx-pill:has(input:checked){border-color:var(--matched);background:rgba(89,179,125,.1)}',
    '.fx-pill input{accent-color:var(--matched);margin:0;width:14px;height:14px}',
    '.fx-msg{margin:12px 0 0;padding:11px 14px;border-radius:11px;font-size:13px;line-height:1.55;background:rgba(226,87,76,.1);border:1px solid rgba(226,87,76,.45)}',
    '.fx-sf{display:flex;gap:10px;align-items:center;padding:14px 26px;border-top:1px solid var(--line);background:var(--surface-raised)}',
    '.fx-sf .sum{font-size:12.5px;color:var(--muted);margin-right:auto;line-height:1.45}',
    '.fx-sf .sum b{color:var(--ink);font-family:"IBM Plex Mono",monospace;font-weight:500}',
    '.fx-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:var(--surface-raised);border:1px solid var(--matched);color:var(--ink);padding:11px 18px;border-radius:10px;font-size:13px;z-index:99;max-width:90vw}',
    '.fx-toast.bad{border-color:var(--alert)}',
    '@media(max-width:620px){.fx-panel{padding:20px 18px 22px}.fx-tiles{grid-template-columns:1fr}.fx-sheet{top:8px;right:8px;bottom:8px;width:calc(100vw - 16px)}.fx-row{grid-template-columns:minmax(0,1fr) 105px 34px}}',
    '@media(prefers-reduced-motion:reduce){.fx-sheet,.fx-back{transition:none}}',
  ].join('\n');
  document.head.appendChild(css);
})();

/* ---------------- small helpers ---------------- */
const fxBase = function () { return '/schools/' + live.staff.school_id; };
const fxIsAdmin = function () { return live.staff.role === 'admin'; };
const fxEl = function (id) { return document.getElementById(id); };
const fxVal = function (id) { const e = fxEl(id); return e ? e.value : ''; };
const fxMoney = function (n) { return money(Number(n) || 0); };
function fxToast(msg, bad) {
  const old = fxEl('fxToast'); if (old) old.remove();
  const d = document.createElement('div');
  d.id = 'fxToast'; d.className = 'fx-toast' + (bad ? ' bad' : ''); d.textContent = msg;
  document.body.appendChild(d);
  setTimeout(function () { if (d.parentNode) d.remove(); }, 4200);
}
function fxNum(s) {                                     // typed amount -> number, or null if it is not a good amount
  const t = String(s == null ? '' : s).replace(/,/g, '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const n = Number(t);
  return n > 0 && n <= 10000000 ? n : null;
}
function fxChangeText(c) {
  const opt = c.optional ? ' <span class="fx-n">optional</span>' : '';
  if (c.kind === 'added') return 'Added <b>' + esc(c.name) + '</b> ' + fxMoney(c.to) + opt;
  if (c.kind === 'removed') return 'Removed <b>' + esc(c.name) + '</b>' + opt;
  if (c.kind === 'price') return '<b>' + esc(c.name) + '</b> ' + fxMoney(c.from) + ' &rarr; ' + fxMoney(c.to) + opt;
  if (c.kind === 'now_mandatory') return '<b>' + esc(c.name) + '</b> is now paid by everyone';
  return '<b>' + esc(c.name) + '</b> is now optional';
}
function fxTerm() { return fx.cls ? fx.cls.terms.find(function (t) { return t.term === fx.term; }) : null; }

/* ---------------- the page ---------------- */
views.feestructure = function () {
  fx.list = null; fx.cls = null; fx.classId = null; fx.term = 1; fx.error = null;   // no stale data from the last visit
  fxCloseSheet(true);
  setTimeout(function () { fxLoadList(); }, 0);
  return '<div id="fxRoot">' + fxBody() + '</div>';
};

async function fxLoadList() {
  const token = ++fx.loadToken;
  fx.error = null;
  try {
    const d = await Api.get(fxBase() + '/fees');
    if (token !== fx.loadToken) return;
    fx.list = d;
  } catch (e) { if (token !== fx.loadToken) return; fx.error = e.message; fx.list = null; }
  fxRender();
}

async function fxLoadClass() {
  const token = ++fx.loadToken;
  fx.error = null;
  try {
    const d = await Api.get(fxBase() + '/fees/class/' + fx.classId);
    if (token !== fx.loadToken) return;
    fx.cls = d;
  } catch (e) { if (token !== fx.loadToken) return; fx.error = e.message; fx.cls = null; }
  fxRender();
}

function fxRender() { const r = fxEl('fxRoot'); if (r) r.innerHTML = fxBody(); }

function fxOpenClass(classId) { fx.classId = classId; fx.cls = null; fx.term = 1; fxRender(); fxLoadClass(); }
function fxBackToList() { fx.classId = null; fx.cls = null; fx.list = null; fxRender(); fxLoadList(); }
function fxPickTerm(n) { fx.term = n; fxRender(); }

function fxBody() {
  if (fx.error) return '<div class="topbar"><div><h1>Fee structure</h1></div></div><div class="fx-panel"><div class="fx-empty"><h2>Could not load the fees</h2><p>' + esc(fx.error) + '</p><button type="button" class="fx-btn" onclick="' + (fx.classId ? 'fxLoadClass()' : 'fxLoadList()') + '">Try again</button></div></div>';
  if (fx.classId) return fxClassBody();
  return fxListBody();
}

/* ---- screen 1: one card per class ---- */
function fxListBody() {
  const head = '<div class="topbar"><div><h1>Fee structure</h1><p class="sub">What each class pays in Term 1, 2 and 3. Pick a class to see or change its fees.</p></div></div>';
  if (!fx.list) return head + '<div class="fx-panel"><div class="fx-empty"><p>Loading...</p></div></div>';
  if (!fx.list.classes.length) {
    return head + '<div class="fx-panel"><div class="fx-empty"><h2>No classes yet</h2><p>Switch on the classes this school runs first (Classes &amp; streams), then set their fees here.</p></div></div>';
  }
  return head + '<div class="fx-grid">' + fx.list.classes.map(function (c) {
    return '<button type="button" class="fx-cc" onclick="fxOpenClass(' + c.id + ')"><h3>' + esc(c.name) + '</h3>' + c.terms.map(function (t) {
      return t.set
        ? '<div class="tr"><span>Term ' + t.term + ' <small>v' + t.version + '</small></span><b>' + fxMoney(t.grand_total) + '</b></div>'
        : '<div class="tr none"><span>Term ' + t.term + '</span><b>Not set</b></div>';
    }).join('') + '</button>';
  }).join('') + '</div>';
}

/* ---- screen 2: one class, Term 1/2/3 ---- */
function fxClassBody() {
  const name = fx.cls ? fx.cls.class.name : (fx.list ? (fx.list.classes.find(function (c) { return c.id === fx.classId; }) || {}).name : '') || '';
  const head = '<button type="button" class="fx-back-link" onclick="fxBackToList()">&larr; All classes</button>' +
    '<div class="topbar"><div><h1>' + esc(name) + '</h1><p class="sub">Fees for each term. They can be changed any day; billing locks the latest version when a term starts.</p></div></div>';
  if (!fx.cls) return head + '<div class="fx-panel"><div class="fx-empty"><p>Loading...</p></div></div>';
  const tabs = '<div class="fx-tabs" role="tablist">' + fx.cls.terms.map(function (t) {
    return '<button type="button" role="tab" class="fx-tab' + (t.term === fx.term ? ' on' : '') + '" aria-selected="' + (t.term === fx.term) + '" onclick="fxPickTerm(' + t.term + ')"><b>Term ' + t.term + '</b><span>' + (t.set ? fxMoney(t.latest.grand_total) : 'not set') + '</span></button>';
  }).join('') + '</div>';
  return head + tabs + '<div class="fx-panel">' + fxTermPanel() + '</div>';
}

function fxTermPanel() {
  const t = fxTerm();
  const admin = fxIsAdmin();
  if (!t.set) {
    const sources = fx.cls.terms.filter(function (x) { return x.set && x.term !== t.term; });
    return '<div class="fx-empty"><h2>No fees set for Term ' + t.term + '</h2><p>Set the fees this class pays in Term ' + t.term + '.' + (admin ? '' : ' Only an admin can set them.') + '</p>' +
      (admin ? '<div class="fx-top" style="justify-content:center"><button type="button" class="fx-btn go" onclick="fxOpenEdit()">Set the fees</button>' +
        sources.map(function (s) { return '<button type="button" class="fx-btn" onclick="fxCopyFromTerm(' + s.term + ')">Copy from Term ' + s.term + '</button>'; }).join('') + '</div>' : '') + '</div>';
  }
  const L = t.latest;
  const row = function (f) { return '<div class="fx-li"><span class="nm">' + esc(f.name) + '</span><span class="am">' + fxMoney(f.amount) + '</span></div>'; };
  const locked = t.locked.map(function (l) { return '<span class="fx-chip lock">' + esc(l.label) + ' was billed with version ' + l.version + '</span>'; }).join('');
  const behind = t.locked.filter(function (l) { return l.version < L.version; });
  const note = behind.length ? '<div class="fx-chips"><span class="fx-chip">You edited after billing (this is version ' + L.version + '). A term that is already billed keeps the version it was billed with. This version is used the next time Term ' + t.term + ' is billed.</span></div>' : '';
  const actions = admin ? '<div class="fx-top"><button type="button" class="fx-btn go" onclick="fxOpenEdit()">Edit fees</button><button type="button" class="fx-btn" onclick="fxOpenCopy()">Copy to other terms or classes</button></div>' : '';
  return '<div class="fx-ph"><div><div class="fx-eyebrow">Latest &middot; version ' + L.version + ' &middot; saved ' + esc(L.created) + '</div><h2>Term ' + t.term + '</h2>' +
      '<div class="fx-chips">' + (locked || '<span class="fx-chip">Not billed yet: billing uses the latest version when the term starts and the class has students</span>') + '</div>' + note + '</div>' + actions + '</div>' +
    '<div class="fx-tiles"><div class="fx-tile"><span>Total mandatory</span><b>' + fxMoney(L.mandatory_total) + '</b></div>' +
      '<div class="fx-tile"><span>Total optional</span><b>' + fxMoney(L.optional_total) + '</b></div>' +
      '<div class="fx-tile grand"><span>Grand total</span><b>' + fxMoney(L.grand_total) + '</b></div></div>' +
    '<h3>Everyone pays</h3>' + (L.mandatory.length ? '<div class="fx-list">' + L.mandatory.map(row).join('') + '<div class="fx-li total"><span class="nm">Total</span><span class="am">' + fxMoney(L.mandatory_total) + '</span></div></div>' : '<div class="fx-none">No fee is paid by everyone in this class.</div>') +
    (L.optional.length ? '<h3>Optional <small>parents choose these when the student is admitted</small></h3><div class="fx-list">' + L.optional.map(row).join('') + '<div class="fx-li total"><span class="nm">Total if all are chosen</span><span class="am">' + fxMoney(L.optional_total) + '</span></div></div>' +
      (admin ? '<p class="fx-help" style="margin-top:10px">Optional fees are set on the <button type="button" class="fx-link" onclick="showView(\'optionalfees\')">Optional fees</button> page.</p>' : '') : '') +
    '<h3>History <small>newest first</small></h3>' + fxHistoryHtml(t);
}

function fxHistoryHtml(t) {
  return '<div class="fx-tl">' + t.versions.map(function (v) {
    const mand = v.items.filter(function (i) { return i.is_mandatory; });
    const what = v.changes === null
      ? '<li>First set: ' + v.items.length + ' fee' + (v.items.length === 1 ? '' : 's') + ', ' + fxMoney(mand.reduce(function (a, i) { return a + i.amount; }, 0)) + ' paid by everyone</li>'
      : (v.changes.length ? v.changes.map(function (c) { return '<li>' + fxChangeText(c) + '</li>'; }).join('') : '<li>No change in the fees</li>');
    return '<div class="fx-v' + (v.current ? ' cur' : '') + '"><div class="vh"><b>Version ' + v.version + '</b>' + (v.current ? '<span class="fx-n">latest</span>' : '') + '<span>' + esc(v.created) + '</span></div><ul>' + what + '</ul></div>';
  }).join('') + '</div>';
}

/* ---------------- side sheet ---------------- */
function fxSheetOpen() {
  let back = fxEl('fxBack'), sheet = fxEl('fxSheet');
  if (!back) {
    back = document.createElement('div'); back.id = 'fxBack'; back.className = 'fx-back'; back.onclick = function () { fxCloseSheet(); };
    sheet = document.createElement('div'); sheet.id = 'fxSheet'; sheet.className = 'fx-sheet'; sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true');
    document.body.appendChild(back); document.body.appendChild(sheet);
  }
  fxSheetRender();
  requestAnimationFrame(function () { requestAnimationFrame(function () { if (!fx.sheet) return; back.classList.add('show'); sheet.classList.add('show'); }); });
}
function fxCloseSheet(instant) {
  fx.sheet = null; fx.draft = null; fx.busy = false; fx.sheetErr = null;
  const back = fxEl('fxBack'), sheet = fxEl('fxSheet');
  if (back) back.classList.remove('show');
  if (sheet) sheet.classList.remove('show');
  if (instant) { if (back) back.remove(); if (sheet) sheet.remove(); }
}
document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && fx.sheet) fxCloseSheet(); });
function fxSheetFrame(title, sub, body, footer) {
  return '<div class="fx-sh"><div><h2>' + esc(title) + '</h2><p>' + esc(sub) + '</p></div><button type="button" class="fx-xx" aria-label="Close" onclick="fxCloseSheet()">&times;</button></div>' +
    '<div class="fx-sbody">' + body + '<div id="fxSheetMsg">' + (fx.sheetErr ? '<div class="fx-msg" role="alert">' + esc(fx.sheetErr) + '</div>' : '') + '</div></div><div class="fx-sf">' + footer + '</div>';
}
function fxSheetRender() { const s = fxEl('fxSheet'); if (!s) return; s.innerHTML = fx.sheet === 'edit' ? fxEditHtml() : fxCopyHtml(); }
function fxSheetFail(msg) { fx.sheetErr = msg; fx.busy = false; const m = fxEl('fxSheetMsg'); if (m) m.innerHTML = '<div class="fx-msg" role="alert">' + esc(msg) + '</div>'; const b = fxEl('fxSaveBtn'); if (b) b.disabled = false; }

/* ---- edit the mandatory fees of the chosen term (optional fees are carried over untouched) ---- */
function fxOpenEdit() {
  const t = fxTerm();
  fx.sheet = 'edit'; fx.sheetErr = null;
  fx.draft = { fees: t.set ? t.latest.mandatory.map(function (f) { return { name: f.name, amount: String(f.amount) }; }) : [{ name: 'Tuition', amount: '' }] };
  fxSheetOpen();
}
function fxSync() { fx.draft.fees = fx.draft.fees.map(function (r, i) { return { name: fxVal('fxFn' + i), amount: fxVal('fxFa' + i) }; }); }
function fxAddRow() { fxSync(); fx.draft.fees.push({ name: '', amount: '' }); fxSheetRender(); const i = fx.draft.fees.length - 1; const e = fxEl('fxFn' + i); if (e) e.focus(); }
function fxDelRow(i) { fxSync(); fx.draft.fees.splice(i, 1); fxSheetRender(); }
function fxEditHtml() {
  const t = fxTerm();
  const rows = fx.draft.fees.map(function (r, i) {
    return '<div class="fx-row"><input class="fx-in" id="fxFn' + i + '" value="' + esc(r.name) + '" placeholder="Fee name" maxlength="60" aria-label="Fee name">' +
      '<input class="fx-in mono" id="fxFa' + i + '" value="' + esc(r.amount) + '" placeholder="Amount" inputmode="decimal" aria-label="Amount">' +
      '<button type="button" class="fx-x" aria-label="Remove this fee" onclick="fxDelRow(' + i + ')">&times;</button></div>';
  }).join('');
  const keep = t.set && t.latest.optional.length ? '<div class="fx-blk"><h4>Optional fees</h4><p class="fx-help">This class keeps its ' + t.latest.optional.length + ' optional fee' + (t.latest.optional.length === 1 ? '' : 's') + ' for Term ' + t.term + ' as they are. Change them on the Optional fees page.</p></div>' : '';
  const body = '<div class="fx-blk"><h4>Fees everyone pays</h4><p class="fx-help">Saving makes a new version. The old one stays in the history. A term that is already billed is not changed.</p>' + rows +
    '<button type="button" class="fx-btn" onclick="fxAddRow()">+ Add a fee</button></div>' + keep;
  return fxSheetFrame('Edit ' + fx.cls.class.name + ', Term ' + t.term, 'Fees everyone in the class pays', body,
    '<div class="sum"></div><button type="button" class="fx-btn" onclick="fxCloseSheet()">Cancel</button><button type="button" class="fx-btn go" id="fxSaveBtn" onclick="fxSave()"' + (fx.busy ? ' disabled' : '') + '>Save fees</button>');
}
async function fxSave() {
  if (fx.busy) return;
  fxSync();
  const t = fxTerm();
  const fees = [];
  for (let i = 0; i < fx.draft.fees.length; i++) {
    const r = fx.draft.fees[i];
    const name = String(r.name).replace(/\s+/g, ' ').trim();
    if (!name && !String(r.amount).trim()) continue;                       // an empty row is ignored
    if (!name) return fxSheetFail('Row ' + (i + 1) + ' has an amount but no name.');
    const amount = fxNum(r.amount);
    if (amount == null) return fxSheetFail('"' + name + '": write the amount as a number, like 50000.');
    fees.push({ name: name, amount: amount });
  }
  const optional = t.set ? t.latest.optional.map(function (o) { return { name: o.name, amount: o.amount }; }) : [];
  if (!fees.length && !optional.length) return fxSheetFail('Add at least one fee.');
  fx.busy = true; const b = fxEl('fxSaveBtn'); if (b) b.disabled = true;
  try {
    const r = await Api.post(fxBase() + '/fees/set', { class_ids: [fx.classId], term: fx.term, fees: fees, optional: optional });
    const c = r.classes[0];
    fxCloseSheet();
    fxToast(c.unchanged ? 'No change: those are already the latest fees.' : 'Saved as version ' + c.version + '.');
    await fxLoadClass();
  } catch (e) { fxSheetFail(e.message); }
}

/* ---- copy this term's fees to other terms and/or other classes ---- */
function fxOpenCopy(fromTerm) {
  fx.sheet = 'copy'; fx.sheetErr = null;
  fx.draft = { from: fromTerm || fx.term, terms: [], classes: [fx.classId] };
  if (fromTerm) { fx.draft.terms = [fx.term]; fx.draft.from = fromTerm; fx.draft.classes = [fx.classId]; }
  fxSheetOpen();
}
function fxCopyFromTerm(term) { fxOpenCopy(term); }
function fxCopyToggle(kind, id) {
  const list = fx.draft[kind], i = list.indexOf(id);
  if (i >= 0) list.splice(i, 1); else list.push(id);
  fxSheetRender();
}
function fxCopyHtml() {
  const d = fx.draft;
  const terms = [1, 2, 3].map(function (n) {
    return '<label class="fx-pill"><input type="checkbox"' + (d.terms.indexOf(n) >= 0 ? ' checked' : '') + ' onchange="fxCopyToggle(\'terms\',' + n + ')"> Term ' + n + '</label>';
  }).join('');
  const classes = (fx.list ? fx.list.classes : []).map(function (c) {
    return '<label class="fx-pill"><input type="checkbox"' + (d.classes.indexOf(c.id) >= 0 ? ' checked' : '') + ' onchange="fxCopyToggle(\'classes\',' + c.id + ')"> ' + esc(c.name) + '</label>';
  }).join('');
  const targets = d.terms.length * d.classes.length - (d.terms.indexOf(d.from) >= 0 && d.classes.indexOf(fx.classId) >= 0 ? 1 : 0);   // the source itself is never a target
  const body = '<div class="fx-blk"><h4>Copy the latest Term ' + d.from + ' fees of ' + esc(fx.cls.class.name) + '</h4><p class="fx-help">Each place you pick gets a new version with the same fees (including the optional fees). Places that already have exactly these fees are left alone.</p></div>' +
    '<div class="fx-blk"><h4>Into which terms</h4><div class="fx-pills">' + terms + '</div></div>' +
    '<div class="fx-blk"><h4>For which classes</h4><div class="fx-pills">' + classes + '</div></div>';
  return fxSheetFrame('Copy fees', fx.cls.class.name + ', Term ' + d.from, body,
    '<div class="sum"><b>' + targets + '</b> place' + (targets === 1 ? '' : 's') + '</div><button type="button" class="fx-btn" onclick="fxCloseSheet()">Cancel</button><button type="button" class="fx-btn go" id="fxSaveBtn" onclick="fxDoCopy()"' + (fx.busy || !targets ? ' disabled' : '') + '>Copy</button>');
}
async function fxDoCopy() {
  if (fx.busy) return;
  const d = fx.draft;
  if (!d.terms.length || !d.classes.length) return fxSheetFail('Choose at least one term and one class.');
  fx.busy = true; const b = fxEl('fxSaveBtn'); if (b) b.disabled = true;
  try {
    const r = await Api.post(fxBase() + '/fees/copy', { from_class_id: fx.classId, from_term: d.from, to_class_ids: d.classes, to_terms: d.terms });
    const changed = r.classes.filter(function (c) { return !c.unchanged; }).length;
    fxCloseSheet();
    fxToast(changed ? 'Copied: ' + changed + ' new version' + (changed === 1 ? '' : 's') + ' saved.' : 'Nothing to change: they already have these fees.');
    await fxLoadClass();
  } catch (e) { fxSheetFail(e.message); }
}