/* page-review.js - the Review queue page (redesigned, v2).
   Layout: a searchable list of waiting payments on the left, the selected payment
   and its decision on the right. Built to stay fast and readable with hundreds of payments.
   - "Needs review": a number was found but a person must decide (two students, or number = amount).
   - "Unmatched": no admission number found; the person finds the student by hand.
   Endpoints used: GET review-queue, GET unmatched, GET students?q=, POST transactions/:id/confirm|reject
   Keys: J / K (or arrows) move through the list, / jumps to search, Enter opens the confirm popup when a student is chosen.
   NEW in v2:
   - No Refresh button. The page refreshes itself: when you open it, when you click its menu link again,
     when you come back to the browser tab, and every 30 seconds. Typing is never wiped.
   - A small message tells you when new payments arrive. The top line says when the list was last updated.
   - Unmatched payments search the payer name for you as soon as you open them (nothing is chosen for you).
   - Each row shows the payer name. Payments waiting more than 2 days show their time in red.
   This file adds its own styles, so no other file needs to change. */

const review = {
  tab: null,        // 'review' | 'unmatched' | 'all'. null = pick automatically until a tab is clicked
  q: '', src: '', sort: 'new',
  sel: null,        // id of the payment shown on the right
  mobileOpen: false, sig: null, force: false,
  picked: {},       // payment id -> student chosen for it
  results: {},      // payment id -> students listed by the finder
  timers: {}, seq: {},
  loading: false,   // a refresh is running
  updated: null,    // when the list was last loaded
};

/* ---------------- styles (added once) ---------------- */
(function addReviewStyles() {
  if (document.getElementById('rvStyle')) return;
  const css = document.createElement('style');
  css.id = 'rvStyle';
  css.textContent = [
    '.rv-strip{display:flex;border:1px solid var(--line);border-radius:10px;background:var(--surface);margin:14px 0;overflow:hidden}',
    '.rv-strip>div{flex:1;padding:12px 18px;border-right:1px solid var(--line);min-width:0}.rv-strip>div:last-child{border-right:0}',
    '.rv-strip .n{font-family:"IBM Plex Mono",monospace;font-size:19px;font-weight:600;line-height:1.2}',
    '.rv-strip .l{font-size:12px;color:var(--muted);margin-top:2px}',
    '.rv-strip .amber .n{color:var(--cash)}',
    '.rv-bar2{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px}',
    '.rv-seg{display:inline-flex;border:1px solid var(--line);border-radius:9px;background:var(--surface);padding:3px;gap:2px}',
    '.rv-seg button{font:inherit;font-size:12.5px;color:var(--muted);background:transparent;border:0;border-radius:7px;padding:6px 12px;cursor:pointer}',
    '.rv-seg button.on{background:var(--surface-raised);color:var(--ink)}',
    '.rv-seg b{font-family:"IBM Plex Mono",monospace;font-weight:500;margin-left:6px;font-size:11.5px;color:var(--muted)}',
    '.rv-seg button.on b{color:var(--cash)}',
    '.rv-in{font:inherit;font-size:13px;color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:8px 12px;min-width:0}',
    '.rv-in:focus{outline:none;border-color:var(--matched)}',
    '#rvSearch{flex:1;min-width:180px;max-width:340px}',
    '.rv-wrap{display:grid;grid-template-columns:minmax(300px,390px) 1fr;gap:16px;align-items:start}',
    '.rv-listcol{background:var(--surface);border:1px solid var(--line);border-radius:12px;overflow:auto;max-height:calc(100vh - 300px);min-height:240px}',
    '.rv-row{display:grid;grid-template-columns:3px 1fr auto;gap:12px;width:100%;text-align:left;background:transparent;border:0;border-bottom:1px solid var(--line);color:var(--ink);padding:12px 14px 12px 0;cursor:pointer;font:inherit}',
    '.rv-row:hover{background:rgba(255,255,255,.025)}.rv-row.on{background:var(--surface-raised)}',
    '.rv-row:focus-visible{outline:2px solid var(--matched);outline-offset:-2px}',
    '.rv-bar{border-radius:0 3px 3px 0;background:var(--muted)}.rv-row.k-review .rv-bar{background:var(--cash)}',
    '.rv-amt{font-family:"IBM Plex Mono",monospace;font-size:14.5px;font-weight:600}',
    '.rv-who{font-size:12.5px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:210px}',
    '.rv-ref{font-family:"IBM Plex Mono",monospace;font-size:11.5px;color:var(--muted);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:210px}',
    '.rv-side{text-align:right;font-size:11.5px;color:var(--muted);display:flex;flex-direction:column;align-items:flex-end;gap:5px}',
    '.rv-old{color:var(--alert)}',
    '.rv-tag{font-size:11px;padding:2px 8px;border-radius:20px;background:rgba(217,164,65,.16);color:var(--cash);white-space:nowrap}',
    '.rv-row.k-unmatched .rv-tag{background:rgba(143,163,152,.16);color:var(--muted)}',
    '.rv-keys{padding:10px 16px;font-size:11.5px;color:var(--muted)}',
    '.rv-detail{background:var(--surface);border:1px solid var(--line);border-radius:12px;position:sticky;top:16px;display:flex;flex-direction:column;max-height:calc(100vh - 300px);min-height:380px;overflow:hidden}',
    '.rv-dbody{padding:24px 28px;overflow:auto;flex:1}',
    '.rv-back{display:none;font:inherit;font-size:12.5px;color:var(--muted);background:transparent;border:0;padding:0;margin-bottom:14px;cursor:pointer}',
    '.rv-dhead{display:flex;align-items:center;gap:10px;font-size:12.5px;color:var(--muted);flex-wrap:wrap}',
    '.rv-kind{font-size:11.5px;font-weight:600;padding:3px 10px;border-radius:20px;background:rgba(217,164,65,.16);color:var(--cash)}',
    '.rv-kind.u{background:rgba(143,163,152,.16);color:var(--muted)}',
    '.rv-hero{font-family:"IBM Plex Mono",monospace;font-size:38px;font-weight:600;letter-spacing:-.01em;margin:14px 0 6px;line-height:1.1}',
    '.rv-hero small{font-size:15px;color:var(--muted);font-weight:500;margin-right:8px;letter-spacing:0}',
    '.rv-payer{font-size:13px;color:var(--muted);display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:20px}',
    '.rv-lab{font-size:12.5px;color:var(--muted);margin:0 0 7px}',
    '.rv-refbox{background:var(--bg);border:1px solid var(--line);border-radius:9px;padding:13px 15px;font-family:"IBM Plex Mono",monospace;font-size:15px;word-break:break-word;line-height:1.5}',
    '.rv-refbox mark{background:rgba(217,164,65,.2);color:var(--cash);border-radius:4px;padding:1px 5px;box-shadow:inset 0 -2px 0 var(--cash)}',
    '.rv-none{color:var(--muted);font-family:"IBM Plex Sans",sans-serif;font-size:13.5px}',
    '.rv-why{font-size:13px;color:var(--muted);margin:10px 0 22px;line-height:1.55}',
    '.rv-opt{display:flex;align-items:center;gap:12px;padding:11px 14px;border:1px solid var(--line);border-radius:9px;background:var(--bg);cursor:pointer;margin-bottom:8px}',
    '.rv-opt:hover{border-color:var(--muted)}.rv-opt:has(input:checked){border-color:var(--matched);background:rgba(89,179,125,.09)}',
    '.rv-opt input{accent-color:var(--matched);margin:0}',
    '.rv-opt .nm{font-weight:500;font-size:14px}.rv-opt .adm{margin-left:8px}',
    '.rv-opt .bal{margin-left:auto;font-family:"IBM Plex Mono",monospace;font-size:12px;color:var(--muted);white-space:nowrap}',
    '.rv-hint{font-size:12.5px;color:var(--muted);padding:4px 2px}',
    '.rv-link{font:inherit;font-size:12.5px;color:var(--matched);background:transparent;border:0;padding:0;cursor:pointer;text-decoration:underline}',
    '.rv-foot{display:flex;gap:10px;padding:14px 28px;border-top:1px solid var(--line);background:var(--surface-raised)}',
    '.rv-btn{font:inherit;font-size:13.5px;font-weight:600;border-radius:9px;padding:11px 18px;cursor:pointer;border:1px solid var(--line);background:transparent;color:var(--ink)}',
    '.rv-btn.rej{color:var(--alert);border-color:rgba(226,87,76,.45)}.rv-btn.rej:hover{background:rgba(226,87,76,.1)}',
    '.rv-btn.go{flex:1;background:var(--matched);border-color:var(--matched);color:#0E1613;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.rv-btn.go:disabled{background:transparent;border-color:var(--line);color:var(--muted);cursor:not-allowed}',
    '.rv-btn:focus-visible,.rv-in:focus-visible,.rv-seg button:focus-visible{outline:2px solid var(--matched);outline-offset:2px}',
    '.rv-empty{padding:56px 28px;text-align:center;color:var(--muted);font-size:13.5px;line-height:1.6}',
    '.rv-empty h3{font-family:"Space Grotesk",sans-serif;font-size:17px;color:var(--ink);margin:0 0 6px;font-weight:600}',
    '.rv-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:var(--surface-raised);border:1px solid var(--matched);color:var(--ink);padding:11px 18px;border-radius:10px;font-size:13px;z-index:99;max-width:90vw}',
    '.rv-toast.bad{border-color:var(--alert)}',
    '.modal.rv-modal>.actions{display:none!important}',
    '@media(max-width:860px){.rv-wrap{grid-template-columns:1fr}.rv-listcol{max-height:none}.rv-detail{position:static;max-height:none;display:none}',
    '.rv-wrap.open .rv-listcol{display:none}.rv-wrap.open .rv-detail{display:flex}.rv-back{display:block}.rv-dbody{padding:20px 18px}.rv-foot{padding:12px 18px;position:sticky;bottom:0}.rv-hero{font-size:32px}.rv-keys{display:none}.rv-ref,.rv-who{max-width:46vw}}',
  ].join('\n');
  document.head.appendChild(css);
})();

/* ---------------- small helpers ---------------- */
function rvTabNow() {   // lands on whichever tab has something in it, until the person picks one
  if (review.tab) return review.tab;
  return live.queue.length ? 'review' : (live.unmatched.length ? 'unmatched' : 'review');
}
function rvAll() {
  return live.queue.map(function (t) { return Object.assign({ _k: 'review' }, t); })
    .concat(live.unmatched.map(function (t) { return Object.assign({ _k: 'unmatched' }, t); }));
}
function rvAgo(iso) {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (!isFinite(m)) return '';
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + ' h ago';
  return Math.round(h / 24) + ' d ago';
}
function rvIsOld(iso) { return Date.now() - new Date(iso).getTime() > 48 * 3600 * 1000; }
function rvWhen(iso) { return esc(String(iso || '').slice(0, 16).replace('T', ' ')); }
function rvSum(list) { return list.reduce(function (a, t) { return a + num(t.amount); }, 0); }
function balanceText(b) {
  b = num(b);
  if (b > 0) return 'owes ' + money(b);
  if (b < 0) return 'credit ' + money(-b);
  return 'paid up';
}
function rvSubText() {
  const n = live.queue.length + live.unmatched.length;
  const a = n ? n + ' payment' + (n === 1 ? '' : 's') + ' waiting for a person to decide' : 'Nothing is waiting right now';
  return a + (review.updated ? ' \u00b7 updated ' + rvAgo(review.updated) : '');
}
function rvVisible() {
  const q = review.q.trim().toLowerCase();
  let list = rvAll().filter(function (t) {
    if (rvTabNow() !== 'all' && t._k !== rvTabNow()) return false;
    if (review.src && t.source !== review.src) return false;
    if (!q) return true;
    return [t.id, t.amount, t.narration, t.payer_name, t.payer_phone, t.external_ref].some(function (v) {
      return String(v == null ? '' : v).toLowerCase().indexOf(q) !== -1;
    });
  });
  list.sort(function (a, b) {
    if (review.sort === 'big') return num(b.amount) - num(a.amount);
    const d = new Date(a.received_at) - new Date(b.received_at);
    return review.sort === 'old' ? d : -d;
  });
  return list;
}
function rvSelected() { return rvAll().find(function (t) { return t.id === review.sel; }) || null; }
function rvEnsureSel() {
  const vis = rvVisible();
  if (!vis.some(function (t) { return t.id === review.sel; })) review.sel = vis.length ? vis[0].id : null;
  const t = rvSelected();
  // a single suggested student is pre-chosen; several candidates are never pre-chosen
  if (t && t._k === 'review' && !(Array.isArray(t.candidates) && t.candidates.length) && t.matched_student_id && !review.picked[t.id]) {
    review.picked[t.id] = { id: t.matched_student_id, full_name: t.suggested_student_name, admission_no: t.suggested_admission_no };
  }
}

// Marks the admission numbers the matcher found inside what the payer typed.
function rvHighlight(text, adms) {
  text = String(text == null ? '' : text);
  if (!text.trim()) return '<span class="rv-none">The payer left the reference empty.</span>';
  const pats = adms.filter(Boolean).map(function (a) {
    return String(a).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/^([A-Za-z]+)(\d)/, '$1[\\s\\/\\-]*$2');
  });
  if (!pats.length) return esc(text);
  let parts;
  try { parts = text.split(new RegExp('(' + pats.join('|') + ')', 'i')); } catch (e) { return esc(text); }
  return parts.map(function (p, i) { return i % 2 ? '<mark>' + esc(p) + '</mark>' : esc(p); }).join('');
}

/* ---------------- pieces of the page ---------------- */
function rvStatsHtml() {
  const R = live.queue, U = live.unmatched, all = R.concat(U);
  let oldest = '&ndash;', oldCls = '';
  if (all.length) {
    const o = all.reduce(function (m, t) { return new Date(t.received_at) < new Date(m) ? t.received_at : m; }, all[0].received_at);
    oldest = rvAgo(o);
    if (rvIsOld(o)) oldCls = ' rv-old';
  }
  return '<div class="rv-strip">' +
    '<div class="amber"><div class="n">' + R.length + '</div><div class="l">need review, ' + money(rvSum(R)) + '</div></div>' +
    '<div><div class="n">' + U.length + '</div><div class="l">unmatched, ' + money(rvSum(U)) + '</div></div>' +
    '<div><div class="n' + oldCls + '">' + oldest + '</div><div class="l">oldest still waiting</div></div></div>';
}
function rvTabsHtml() {
  const nR = live.queue.length, nU = live.unmatched.length;
  function b(k, label, n) { return '<button type="button" class="' + (rvTabNow() === k ? 'on' : '') + '" onclick="rvTab(\'' + k + '\')">' + label + '<b>' + n + '</b></button>'; }
  return b('review', 'Needs review', nR) + b('unmatched', 'Unmatched', nU) + b('all', 'All', nR + nU);
}
function rvRowHtml(t) {
  const nc = Array.isArray(t.candidates) ? t.candidates.length : 0;
  const tag = t._k === 'review' ? (nc > 1 ? nc + ' students' : 'Check match') : 'No number';
  return '<button type="button" class="rv-row k-' + t._k + (t.id === review.sel ? ' on' : '') + '" onclick="rvSelect(' + t.id + ')">' +
    '<span class="rv-bar"></span>' +
    '<span><div class="rv-amt">' + money(num(t.amount)) + '</div><div class="rv-who">' + esc(t.payer_name || 'Unknown payer') + '</div><div class="rv-ref">' + esc(t.narration || 'No reference') + '</div></span>' +
    '<span class="rv-side"><span class="' + (rvIsOld(t.received_at) ? 'rv-old' : '') + '">' + esc(rvAgo(t.received_at)) + '</span><span class="rv-tag">' + tag + '</span></span></button>';
}
function rvListHtml() {
  const vis = rvVisible();
  if (!vis.length) {
    const none = !rvAll().length;
    return '<div class="rv-empty"><h3>' + (none ? 'Nothing is waiting' : 'No payments match') + '</h3>' +
      (none ? 'Payments the system cannot match on its own will appear here.' : 'Try a different search or <button type="button" class="rv-link" onclick="rvClear()">clear the filters</button>.') + '</div>';
  }
  return vis.map(rvRowHtml).join('') + '<div class="rv-keys">J and K move through the list, / searches, Enter confirms the chosen student.</div>';
}

function rvFinderHtml(t) {
  const clue = t.payer_name ? ' <button type="button" class="rv-link" onclick="reviewUsePayerName(' + t.id + ')">Search with the payer name</button>' : '';
  return '<div class="rv-lab">Find the student</div>' +
    '<input type="search" class="rv-in" id="rv-q" style="width:100%;margin-bottom:10px;" placeholder="Admission number or name" autocomplete="off" oninput="reviewSearch(' + t.id + ')">' +
    '<div id="rv-res"><div class="rv-hint">Type an admission number or a name.' + clue + '</div></div>';
}
function rvChoiceHtml(t) {
  const picked = review.picked[t.id];
  if (t._k === 'unmatched') return rvFinderHtml(t);
  if (Array.isArray(t.candidates) && t.candidates.length) {
    return '<div class="rv-lab">Which student is this payment for?</div>' + t.candidates.map(function (c) {
      const sid = candId(c);
      return '<label class="rv-opt"><input type="radio" name="rv-cand" ' + (picked && Number(picked.id) === Number(sid) ? 'checked' : '') + ' onchange="rvPickCand(' + t.id + ',' + Number(sid) + ')">' +
        '<span><span class="nm">' + esc(c.full_name) + '</span><span class="adm">' + esc(c.admission_no) + '</span></span></label>';
    }).join('');
  }
  return '<div class="rv-lab">Suggested student</div><div class="rv-opt" style="cursor:default;border-color:var(--matched);"><span><span class="nm">' +
    esc(t.suggested_student_name || 'None') + '</span><span class="adm">' + esc(t.suggested_admission_no || '') + '</span></span></div>';
}
function rvConfirmLabel(t) {
  const p = review.picked[t.id];
  return p ? 'Confirm for ' + esc(p.full_name) : 'Choose a student to confirm';
}
function rvDetailHtml() {
  const t = rvSelected();
  if (!t) return '<div class="rv-empty"><h3>' + (rvAll().length ? 'Select a payment' : 'You are all caught up') + '</h3>' +
    (rvAll().length ? 'Pick one from the list to see what was typed and decide.' : 'Nothing needs a decision right now.') + '</div>';
  const adms = (Array.isArray(t.candidates) && t.candidates.length ? t.candidates.map(function (c) { return c.admission_no; }) : [t.suggested_admission_no]);
  const reason = t.match_reason || (t._k === 'unmatched' ? 'No admission number was found in the reference.' : '');
  return '<div class="rv-dbody"><button type="button" class="rv-back" onclick="rvBack()">&larr; Back to the list</button>' +
    '<div class="rv-dhead"><span class="rv-kind' + (t._k === 'unmatched' ? ' u' : '') + '">' + (t._k === 'review' ? 'Needs review' : 'Unmatched') + '</span>' +
    '<span>Payment #' + t.id + '</span><span>received ' + rvWhen(t.received_at) + '</span></div>' +
    '<div class="rv-hero"><small>KES</small>' + esc(num(t.amount).toLocaleString()) + '</div>' +
    '<div class="rv-payer">' + chipFor(t.source) + '<span>' + esc(t.payer_name || 'Payer name unknown') + '</span>' + (t.payer_phone ? '<span class="adm">' + esc(t.payer_phone) + '</span>' : '') + '</div>' +
    '<div class="rv-lab">What the payer typed</div><div class="rv-refbox">' + rvHighlight(t.narration, adms) + '</div>' +
    '<p class="rv-why">' + esc(reason) + '</p>' + rvChoiceHtml(t) + '</div>' +
    '<div class="rv-foot"><button type="button" class="rv-btn rej" onclick="rejectTxn(' + t.id + ')">Reject</button>' +
    '<button type="button" class="rv-btn go" id="rvGo" ' + (review.picked[t.id] ? '' : 'disabled') + ' onclick="confirmItem(' + t.id + ')">' + rvConfirmLabel(t) + '</button></div>';
}

function rvSig(t) { return t ? [t.id, t._k, t.amount, t.match_reason, JSON.stringify(t.candidates)].join('|') : 'none'; }

// For an Unmatched payment: search the payer name right away so the person starts with a list.
// Nothing is chosen for them.
function rvAutoFind() {
  const t = rvSelected();
  if (!t || t._k !== 'unmatched' || !t.payer_name) return;
  const box = document.getElementById('rv-q');
  if (box && !box.value) { box.value = t.payer_name; reviewSearch(t.id); }
}

function rvRefresh() {
  if (!document.getElementById('rvRoot')) return;
  rvEnsureSel();
  const sub = document.getElementById('rvSub'); if (sub) sub.textContent = rvSubText();
  document.getElementById('rvStats').innerHTML = rvStatsHtml();
  document.getElementById('rvTabs').innerHTML = rvTabsHtml();
  const listEl = document.getElementById('rvList'), keep = listEl.scrollTop;
  listEl.innerHTML = rvListHtml();
  listEl.scrollTop = keep;
  // Leave the right side alone when the same payment is still showing, so a background
  // refresh never wipes what someone is typing into the student finder.
  const t = rvSelected();
  const sig = rvSig(t);
  if (sig !== review.sig || review.force) {
    document.getElementById('rvDetail').innerHTML = rvDetailHtml();
    review.sig = sig; review.force = false;
    rvAutoFind();
  }
  document.getElementById('rvWrap').classList.toggle('open', review.mobileOpen && !!review.sel);
}
function rvToast(msg, bad) {
  const old = document.getElementById('rvToast'); if (old) old.remove();
  const d = document.createElement('div');
  d.id = 'rvToast'; d.className = 'rv-toast' + (bad ? ' bad' : ''); d.textContent = msg;
  document.body.appendChild(d);
  setTimeout(function () { if (d.parentNode) d.remove(); }, 3500);
}

/* ---------------- refreshing by itself ---------------- */
// announce = true: tell the person when new payments arrived.
async function rvAuto(announce) {
  if (review.loading) return;
  review.loading = true;
  const before = {};
  rvAll().forEach(function (t) { before[t.id] = 1; });
  try {
    await loadLiveData();
    review.updated = new Date().toISOString();
    if (announce) {
      const fresh = rvAll().filter(function (t) { return !before[t.id]; }).length;
      if (fresh) rvToast(fresh + ' new payment' + (fresh === 1 ? '' : 's') + ' waiting');
    }
  } catch (e) { /* session expiry is handled in Api; the next refresh tries again */ }
  review.loading = false;
  rvRefresh();
}

if (!window.__rvAuto) {
  window.__rvAuto = true;
  const onPage = function () { return !!document.getElementById('rvRoot'); };
  setInterval(function () { if (onPage() && !document.hidden) rvAuto(true); }, 30000);      // every 30 seconds
  document.addEventListener('visibilitychange', function () { if (!document.hidden && onPage()) rvAuto(true); });
  window.addEventListener('focus', function () { if (onPage()) rvAuto(true); });
  // clicking the menu link of this page while you are already on it
  document.addEventListener('click', function (e) {
    if (!onPage() || !e.target || !e.target.closest) return;
    const link = e.target.closest('[onclick*="reviewqueue"],[data-view="reviewqueue"],[data-page="reviewqueue"],[href="#reviewqueue"]');
    if (link && !link.closest('#rvRoot')) rvAuto(true);
  }, true);
}

/* ---------------- the page ---------------- */
views.reviewqueue = function () {
  rvEnsureSel(); review.sig = rvSig(rvSelected());
  setTimeout(function () { rvAutoFind(); rvAuto(false); }, 0);    // every time the page opens it loads fresh payments
  return '<div id="rvRoot"><div class="topbar"><div><h1>Review queue</h1><p class="sub" id="rvSub">' + esc(rvSubText()) + '</p></div></div>' +
    '<div id="rvStats">' + rvStatsHtml() + '</div>' +
    '<div class="rv-bar2"><div class="rv-seg" id="rvTabs">' + rvTabsHtml() + '</div>' +
    '<input type="search" class="rv-in" id="rvSearch" placeholder="Search amount, reference, payer or number" value="' + esc(review.q) + '" oninput="rvSearchInput(this.value)">' +
    '<select class="rv-in" onchange="rvSrcPick(this.value)"><option value="">All sources</option>' +
    ['mpesa', 'equity', 'kcb', 'coop'].map(function (s) { return '<option value="' + s + '"' + (review.src === s ? ' selected' : '') + '>' + ({ mpesa: 'M-Pesa', equity: 'Equity', kcb: 'KCB', coop: 'Co-op' })[s] + '</option>'; }).join('') + '</select>' +
    '<select class="rv-in" onchange="rvSortPick(this.value)"><option value="new"' + (review.sort === 'new' ? ' selected' : '') + '>Newest first</option><option value="old"' + (review.sort === 'old' ? ' selected' : '') + '>Oldest first</option><option value="big"' + (review.sort === 'big' ? ' selected' : '') + '>Largest first</option></select></div>' +
    '<div class="rv-wrap' + (review.mobileOpen && review.sel ? ' open' : '') + '" id="rvWrap"><div class="rv-listcol" id="rvList">' + rvListHtml() + '</div><div class="rv-detail" id="rvDetail">' + rvDetailHtml() + '</div></div></div>';
};

window.rvTab = function (k) { review.tab = k; review.mobileOpen = false; review.force = true; rvRefresh(); };
window.rvSearchInput = function (v) { review.q = v; rvRefresh(); };
window.rvSrcPick = function (v) { review.src = v; rvRefresh(); };
window.rvSortPick = function (v) { review.sort = v; rvRefresh(); };
window.rvClear = function () { review.q = ''; review.src = ''; const s = document.getElementById('rvSearch'); if (s) s.value = ''; rvRefresh(); };
window.rvSelect = function (id) { review.sel = id; review.mobileOpen = true; review.force = true; rvRefresh(); };
window.rvBack = function () { review.mobileOpen = false; rvRefresh(); };
window.rvReload = function () { return rvAuto(false); };      // kept so older calls still work

/* keyboard: J/K or arrows move, / searches, Enter opens the confirm popup (ignored while typing or while the popup is open) */
if (!window.__rvKeys) {
  window.__rvKeys = true;
  document.addEventListener('keydown', function (e) {
    if (!document.getElementById('rvRoot') || e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (e.target && e.target.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
    const modal = document.getElementById('modalBackdrop');
    if (modal && modal.classList.contains('show')) return;
    if (e.key === 'Enter') {
      if (tag === 'BUTTON' || tag === 'A') return;                // a focused button handles Enter itself
      const cur = rvSelected();
      if (cur && review.picked[cur.id]) { e.preventDefault(); confirmItem(cur.id); }   // the popup still asks before anything is saved
      return;
    }
    if (e.key === '/') { e.preventDefault(); const s = document.getElementById('rvSearch'); if (s) s.focus(); return; }
    const down = e.key === 'j' || e.key === 'ArrowDown', up = e.key === 'k' || e.key === 'ArrowUp';
    if (!down && !up) return;
    const vis = rvVisible(); if (!vis.length) return;
    e.preventDefault();
    const i = vis.findIndex(function (t) { return t.id === review.sel; });
    const next = vis[Math.max(0, Math.min(vis.length - 1, i + (down ? 1 : -1)))];
    review.sel = next.id; review.force = true; rvRefresh();
    const row = document.querySelector('.rv-row.on'); if (row) row.scrollIntoView({ block: 'nearest' });
  });
}

/* ---------------- choosing a student ---------------- */
window.rvPickCand = function (id, studentId) {
  const t = rvSelected();
  const c = t && (t.candidates || []).find(function (x) { return Number(candId(x)) === studentId; });
  review.picked[id] = c ? { id: studentId, full_name: c.full_name, admission_no: c.admission_no } : null;
  rvSyncConfirm(id);
};
window.rvPickFound = function (id, studentId) {
  const r = (review.results[id] || []).find(function (x) { return Number(x.id) === studentId; });
  review.picked[id] = r || null;
  rvSyncConfirm(id);
};
function rvSyncConfirm(id) {
  const t = rvSelected(), go = document.getElementById('rvGo');
  if (!t || t.id !== id || !go) return;
  go.disabled = !review.picked[id];
  go.innerHTML = rvConfirmLabel(t);
}

/* ---------------- the student finder (Unmatched) ---------------- */
function digitsOf(s) { return (String(s == null ? '' : s).match(/\d+/g) || []).join('').replace(/^0+/, ''); }

window.reviewUsePayerName = function (id) {
  const t = rvSelected();
  const box = document.getElementById('rv-q');
  if (!t || t.id !== id || !box) return;
  box.value = t.payer_name || '';
  reviewSearch(id);
};
window.reviewSearch = function (id) {
  clearTimeout(review.timers[id]);
  review.timers[id] = setTimeout(function () { runReviewSearch(id); }, 300);
};

async function runReviewSearch(id) {
  const box = document.getElementById('rv-q');
  const out = document.getElementById('rv-res');
  if (!box || !out || review.sel !== id) return;
  const q = box.value.trim();
  review.picked[id] = null; rvSyncConfirm(id);

  const words = q.split(/\s+/).filter(function (w) { return w.length >= 2 || /^\d+$/.test(w); }).slice(0, 3);
  if (!words.length) { out.innerHTML = '<div class="rv-hint">Type an admission number or a name.</div>'; return; }
  const mySeq = review.seq[id] = (review.seq[id] || 0) + 1;
  out.innerHTML = '<div class="rv-hint">Searching&hellip;</div>';
  try {
    const base = '/schools/' + live.staff.school_id + '/students?limit=20&q=';
    const answers = await Promise.all(words.map(function (w) { return Api.get(base + encodeURIComponent(w)); }));
    if (mySeq !== review.seq[id] || review.sel !== id) return;     // a newer search or another payment took over
    const byId = {};
    answers.forEach(function (a) {
      (a.rows || []).forEach(function (r) {
        if (!byId[r.id]) byId[r.id] = { row: r, hits: 0 };
        byId[r.id].hits++;
      });
    });
    const typedNumber = /^\d+$/.test(q) ? digitsOf(q) : null;
    const list = Object.keys(byId).map(function (k) { return byId[k]; }).sort(function (a, b) {
      const ea = typedNumber && digitsOf(a.row.admission_no) === typedNumber ? 1 : 0;
      const eb = typedNumber && digitsOf(b.row.admission_no) === typedNumber ? 1 : 0;
      if (ea !== eb) return eb - ea;
      if (a.hits !== b.hits) return b.hits - a.hits;
      return String(a.row.admission_no).localeCompare(String(b.row.admission_no), undefined, { numeric: true });
    }).slice(0, 8).map(function (x) { return x.row; });
    review.results[id] = list;
    if (!list.length) { out.innerHTML = '<div class="rv-hint">No student found. Try another spelling or number.</div>'; return; }
    out.innerHTML = list.map(function (r) {
      const left = r.status && r.status !== 'active' ? '<span class="adm">(' + esc(String(r.status).replace(/_/g, ' ')) + ')</span>' : '';
      return '<label class="rv-opt"><input type="radio" name="rv-found" onchange="rvPickFound(' + id + ',' + Number(r.id) + ')">' +
        '<span><span class="nm">' + esc(r.full_name) + '</span><span class="adm">' + esc(r.admission_no) + '</span>' + left + '</span>' +
        '<span class="bal">' + esc(balanceText(r.balance)) + '</span></label>';
    }).join('');
  } catch (e) {
    if (mySeq === review.seq[id]) out.innerHTML = '<div class="rv-hint" style="color:var(--alert);">Could not search: ' + esc(e.message) + '</div>';
  }
}

/* ---------------- confirm / reject (with the popup) ---------------- */
async function actOnTxn(kind, id, body, doneMsg) {
  const before = rvVisible(), idx = Math.max(0, before.findIndex(function (t) { return t.id === id; }));
  let failed = null;
  try { await Api.post('/transactions/' + id + '/' + kind, body); } catch (e) { failed = e; }
  closeModal();
  if (failed) rvToast(failed.message, true); else rvToast(doneMsg);
  try { await loadLiveData(); review.updated = new Date().toISOString(); } catch (e) { /* session expiry is handled in Api */ }
  if (!live.staff) return;
  delete review.picked[id];
  const vis = rvVisible();
  review.sel = vis.length ? vis[Math.min(idx, vis.length - 1)].id : null;   // jump to the next payment
  review.mobileOpen = false; review.force = true;
  if (document.getElementById('rvRoot')) rvRefresh(); else showView('reviewqueue');
}
// The shared popup (index.html) has its own Cancel / Confirm row at the bottom, and that
// Confirm only closes the popup. While a review popup is open that row is hidden, so the
// buttons you see are ours and the Confirm here really does the action.
const rvOrigClose = window.closeModal;
window.closeModal = function () {
  rvOrigClose();
  const box = document.getElementById('modalBody');
  if (box && box.querySelector('#rvModalBtns')) box.innerHTML = '';
  const m = document.querySelector('#modalBackdrop .modal');
  if (m) m.classList.remove('rv-modal');
};
function askAndAct(kind, id, title, sub, body, doneMsg) {
  openModal(title, sub);
  const m = document.querySelector('#modalBackdrop .modal');
  if (m) m.classList.add('rv-modal');
  document.getElementById('modalBody').innerHTML =
    '<div class="actions" id="rvModalBtns"><button type="button" class="btn" onclick="closeModal()">Cancel</button>' +
    '<button type="button" class="btn ' + (kind === 'confirm' ? 'primary' : 'danger') + '" id="modalGo">' + (kind === 'confirm' ? 'Confirm' : 'Reject') + '</button></div>';
  document.getElementById('modalGo').onclick = function () { this.disabled = true; actOnTxn(kind, id, body, doneMsg); };
}

window.confirmItem = function (id) {
  const t = rvSelected(), s = review.picked[id];
  if (!t || t.id !== id || !s) return;
  askAndAct('confirm', id, 'Confirm payment #' + id,
    'Add ' + money(num(t.amount)) + ' to ' + s.full_name + (s.admission_no ? ' (' + s.admission_no + ')' : '') + "'s balance? Your name is recorded against this action.",
    { student_id: Number(s.id) },
    'Confirmed ' + money(num(t.amount)) + ' for ' + s.full_name);
};
window.rejectTxn = function (id) {
  const t = rvSelected();
  askAndAct('reject', id, 'Reject payment #' + id,
    'This marks the payment as rejected. It will not touch any balance.', {},
    'Rejected payment #' + id + (t ? ' (' + money(num(t.amount)) + ')' : ''));
};

/* names the earlier review page exposed, so any other screen that calls them keeps working */
window.reviewTabTo = function (name) { review.tab = name; if (document.getElementById('rvRoot')) { review.force = true; rvRefresh(); } else showView('reviewqueue'); };
window.reviewPick = function (id, studentId) { rvPickFound(id, Number(studentId)); };
window.confirmTxn = window.confirmUnmatched = function (id) {
  if (!document.getElementById('rvRoot')) { review.sel = id; review.mobileOpen = true; showView('reviewqueue'); return; }
  rvSelect(id);
  if (review.picked[id]) confirmItem(id);
};