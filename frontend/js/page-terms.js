/* page-terms.js - Academic years & terms, connected to the real database. Replaces the demo screen.
   - Every school has its OWN calendar. The school admin sets the start and end date of Term 1, 2 and 3 of each year.
   - Dates lock when they are reached: before a term starts both dates can change; once it is running only the end
     date can change; once it has ended nothing can change. The server and the database enforce this too.
   - Saving a term that starts today or earlier starts billing now, so the page first shows who would be billed
     (a "dry run" of the same save) and asks for a clear yes.
   - Billing itself is automatic. Nothing on this page bills by hand.
   Only an admin can change dates (staff can look).
   Add to index.html AFTER page-optional-fees.js:  <script src="js/page-terms.js"></script> */

const tm = { data: null, error: null, loadToken: 0, year: null, drafts: {}, busy: null, asks: {}, errs: {}, newYear: '' };

(function () {
  if (document.getElementById('tmStyle')) return;
  const css = document.createElement('style');
  css.id = 'tmStyle';
  css.textContent = [
    '.tm-years{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 18px}',
    '.tm-y{font:inherit;font-size:14px;font-weight:600;border:1px solid var(--line);border-radius:10px;padding:8px 16px;cursor:pointer;background:transparent;color:var(--ink)}',
    '.tm-y.on{background:var(--matched);border-color:var(--matched);color:#0E1613}',
    '.tm-y.add{border-style:dashed;font-weight:500;color:var(--muted)}',
    '.tm-y.add:hover{border-color:var(--matched);color:var(--matched)}',
    '.tm-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}',
    '.tm-card{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:20px 20px 22px;min-width:0}',
    '.tm-card.run{border-color:var(--matched)}',
    '.tm-h{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap}',
    '.tm-h h2{font-family:"Space Grotesk",sans-serif;font-size:19px;font-weight:600;margin:0}',
    '.tm-chip{display:inline-block;font-size:11.5px;letter-spacing:.05em;text-transform:uppercase;border:1px solid var(--line);border-radius:20px;padding:3px 10px;color:var(--muted)}',
    '.tm-chip.run{border-color:var(--matched);color:var(--matched)}',
    '.tm-chip.end{opacity:.8}',
    '.tm-f{margin-top:14px}',
    '.tm-f label{display:block;font-size:12px;color:var(--muted);margin-bottom:5px}',
    '.tm-in{font:inherit;font-size:14px;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:9px;padding:9px 11px;width:100%;box-sizing:border-box}',
    '.tm-in:focus{outline:none;border-color:var(--matched)}',
    '.tm-in:disabled{opacity:.6;cursor:not-allowed}',
    '.tm-in.changed{border-color:var(--cash);background:rgba(217,164,65,.08)}',
    '.tm-note{margin-top:12px;font-size:12.5px;line-height:1.55;color:var(--muted)}',
    '.tm-note.pay{color:var(--matched)}',
    '.tm-bill{margin-top:12px;border:1px solid var(--line);border-radius:11px;padding:10px 12px;font-size:12.5px;line-height:1.6}',
    '.tm-bill div{display:flex;justify-content:space-between;gap:10px}',
    '.tm-bill span:last-child{color:var(--muted);text-align:right}',
    '.tm-btn{font:inherit;font-size:13.5px;font-weight:600;border-radius:10px;padding:9px 16px;cursor:pointer;border:1px solid var(--line);background:transparent;color:var(--ink)}',
    '.tm-btn:hover:not(:disabled){border-color:var(--muted)}',
    '.tm-btn.go{background:var(--matched);border-color:var(--matched);color:#0E1613}',
    '.tm-btn:disabled{opacity:.5;cursor:not-allowed}',
    '.tm-foot{display:flex;gap:10px;margin-top:16px;flex-wrap:wrap}',
    '.tm-msg{margin-top:12px;padding:11px 14px;border-radius:11px;font-size:13px;line-height:1.55;background:rgba(226,87,76,.1);border:1px solid rgba(226,87,76,.45)}',
    '.tm-msg.ask{background:rgba(217,164,65,.12);border-color:rgba(217,164,65,.5)}',
    '.tm-empty{text-align:center;padding:44px 20px;background:var(--surface);border:1px dashed var(--line);border-radius:16px;color:var(--muted);font-size:13.5px;line-height:1.6}',
    '.tm-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:var(--surface-raised);border:1px solid var(--matched);color:var(--ink);padding:11px 18px;border-radius:10px;font-size:13px;z-index:99;max-width:90vw}',
    '.tm-toast.bad{border-color:var(--alert)}',
    '@media(max-width:900px){.tm-grid{grid-template-columns:1fr}}',
  ].join('\n');
  document.head.appendChild(css);
})();

const tmBase = function () { return '/schools/' + live.staff.school_id; };
const tmAdmin = function () { return live.staff.role === 'admin'; };
const tmEl = function (id) { return document.getElementById(id); };
function tmToast(msg, bad) {
  const old = tmEl('tmToast'); if (old) old.remove();
  const d = document.createElement('div');
  d.id = 'tmToast'; d.className = 'tm-toast' + (bad ? ' bad' : ''); d.textContent = msg;
  document.body.appendChild(d);
  setTimeout(function () { if (d.parentNode) d.remove(); }, 4600);
}
const tmDay = function (s) {               // 2026-08-31 -> 31 Aug 2026
  if (!s) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s); if (!m) return s;
  return Number(m[3]) + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m[2]) - 1] + ' ' + m[1];
};
const tmKey = function (year, term) { return year + '|' + term; };

views.terms = function () {
  tm.data = null; tm.error = null; tm.drafts = {}; tm.busy = null; tm.asks = {}; tm.errs = {};
  setTimeout(function () { tmLoad(); }, 0);
  return '<div id="tmRoot">' + tmBody() + '</div>';
};

async function tmLoad(keepDrafts) {
  const token = ++tm.loadToken;
  tm.error = null;
  try {
    const d = await Api.get(tmBase() + '/terms');
    if (token !== tm.loadToken) return;
    tm.data = d;
    if (!keepDrafts) { tm.drafts = {}; tm.asks = {}; tm.errs = {}; }
    if (tm.want) { tm.year = tm.want; tm.want = null; if (!d.years.some(function (y) { return y.year === tm.year; })) { tm.data = d; tmPickYear(tm.year, true); return; } }
    if (!tm.year || !d.years.some(function (y) { return y.year === tm.year; })) tm.year = Number(d.today.slice(0, 4));
  } catch (e) { if (token !== tm.loadToken) return; tm.error = e.message; tm.data = null; }
  tmRender();
}
function tmRender() { const r = tmEl('tmRoot'); if (r) r.innerHTML = tmBody(); }

function tmBody() {
  const head = '<div class="topbar"><div><h1>Academic years &amp; terms</h1><p class="sub">Your school\'s own calendar. Billing starts by itself on the first day of each term. A date locks once it is reached.</p></div></div>';
  if (tm.error) return head + '<div class="tm-empty"><b>Could not load the terms</b><br>' + esc(tm.error) + '<br><br><button type="button" class="tm-btn" onclick="tmLoad()">Try again</button></div>';
  if (!tm.data) return head + '<div class="tm-empty">Loading...</div>';
  const thisYear = Number(tm.data.today.slice(0, 4));
  const have = tm.data.years.map(function (y) { return y.year; });
  const tabs = tm.data.years.map(function (y) {
    return '<button type="button" class="tm-y' + (y.year === tm.year ? ' on' : '') + '" onclick="tmPickYear(' + y.year + ')">' + y.year + '</button>';
  }).join('');
  const next = have.length ? Math.max.apply(null, have) + 1 : thisYear;
  const add = tmAdmin() ? '<button type="button" class="tm-y add" id="tmAddYear" onclick="tmAddYear()">' + (have.length ? '+ Add ' + next : '+ Add academic year') + '</button>' : '';
  const yr = tm.data.years.find(function (y) { return y.year === tm.year; }) || { year: tm.year, terms: [1, 2, 3].map(function (n) { return { term: n, start: null, end: null, state: 'no dates', billed: false, canChangeStart: true, canChangeEnd: true, billing: null }; }) };
  const who = tmAdmin() ? '' : '<p class="tm-note">Only an admin can change the dates.</p>';
  return head + '<div class="tm-years">' + tabs + add + '</div><div class="tm-grid">' + yr.terms.map(function (t) { return tmCard(yr.year, t); }).join('') + '</div>' + who;
}

async function tmAddYear() {
  const have = tm.data.years.map(function (y) { return y.year; });
  const next = have.length ? Math.max.apply(null, have) + 1 : Number(tm.data.today.slice(0, 4));
  const r = await stDialog({ title: have.length ? 'Add the next academic year' : 'Add your first academic year',
    intro: have.length ? 'The year after ' + Math.max.apply(null, have) + '. Press OK, then set its three term dates.' : 'Press OK, then set its three term dates.',
    fields: [{ id: 'year', label: 'Academic year', value: String(next), inputmode: 'numeric' }], okText: 'OK',
    run: function (v) {
      const y = Number(String(v.year).trim());
      if (!/^\d{4}$/.test(String(v.year).trim()) || y < 2000 || y > 2100) throw new Error('Type the year as four digits, like ' + next + '.');
      if (have.indexOf(y) >= 0) throw new Error(y + ' is already in the list.');
      return y;
    } });
  if (r) tmPickYear(r, true);
}

function tmPickYear(y, isNew) {
  tm.year = y;
  if (isNew && tm.data && !tm.data.years.some(function (x) { return x.year === y; })) {
    tm.data.years.push({ year: y, terms: [1, 2, 3].map(function (n) { return { term: n, start: null, end: null, state: 'no dates', billed: false, canChangeStart: true, canChangeEnd: true, paymentsGoHere: false, billing: null }; }) });
    tm.data.years.sort(function (a, b) { return a.year - b.year; });
  }
  tmRender();
}

const tmStateChip = function (t) {
  if (t.state === 'running') return '<span class="tm-chip run">Running</span>';
  if (t.state === 'ended') return '<span class="tm-chip end">Ended</span>';
  if (t.state === 'coming') return '<span class="tm-chip">Coming</span>';
  return '<span class="tm-chip">Not set</span>';
};

function tmDraftOf(year, term, t) {
  const d = tm.drafts[tmKey(year, term)] || {};
  return { start: d.start !== undefined ? d.start : (t.start || ''), end: d.end !== undefined ? d.end : (t.end || '') };
}

function tmCard(year, t) {
  const admin = tmAdmin();
  const k = tmKey(year, t.term);
  const dr = tmDraftOf(year, t.term, t);
  const changed = dr.start !== (t.start || '') || dr.end !== (t.end || '');
  const busy = tm.busy === k;
  const sDis = !admin || !t.canChangeStart || busy, eDis = !admin || !t.canChangeEnd || busy;
  let lockNote = '';
  if (t.state === 'running') lockNote = 'The start date is locked because the term has started. You can still move the end date.';
  else if (t.state === 'ended') lockNote = 'This term is over, so its dates are locked.';
  else if (t.state === 'coming') lockNote = 'Both dates can change until the term starts. On the start date it is billed automatically and the start date locks.';
  const bill = t.billing ? '<div class="tm-bill">' + t.billing.classes.map(function (c) {
    return '<div><span>' + esc(c.class) + '</span><span>' + c.students + ' student' + (c.students === 1 ? '' : 's') + ' &middot; ' + esc(c.action) + '</span></div>';
  }).join('') + '</div>' : '';
  const billed = t.billed ? '<div class="tm-note">Billed. Fees for this term are locked into each class.</div>' : '';
  const pay = t.paymentsGoHere ? '<div class="tm-note pay">New payments are recorded against this term.</div>' : '';
  const ask = tm.asks[k];
  const askHtml = ask ? tmAsk(k, ask) : '';
  const msg = tm.errs[k] ? '<div class="tm-msg" role="alert">' + esc(tm.errs[k]) + '</div>' : '';
  const foot = admin && t.state !== 'ended' ? '<div class="tm-foot"><button type="button" class="tm-btn go" id="tmSave_' + t.term + '" onclick="tmSave(' + year + ',' + t.term + ')"' + (changed && !busy && dr.start && dr.end ? '' : ' disabled') + '>' + (busy ? 'Saving...' : 'Save dates') + '</button>' +
    '<button type="button" class="tm-btn" onclick="tmUndo(' + year + ',' + t.term + ')"' + (changed && !busy ? '' : ' disabled') + '>Undo</button></div>' : '';
  return '<div class="tm-card' + (t.state === 'running' ? ' run' : '') + '" id="tmCard' + t.term + '"><div class="tm-h"><h2>Term ' + t.term + '</h2>' + tmStateChip(t) + '</div>' +
    '<div class="tm-f"><label for="tmS' + t.term + '">Starts</label><input class="tm-in' + (dr.start !== (t.start || '') ? ' changed' : '') + '" type="date" id="tmS' + t.term + '" value="' + esc(dr.start) + '"' + (sDis ? ' disabled' : '') + ' oninput="tmEdit(' + year + ',' + t.term + ',\'start\',this.value)"></div>' +
    '<div class="tm-f"><label for="tmE' + t.term + '">Ends</label><input class="tm-in' + (dr.end !== (t.end || '') ? ' changed' : '') + '" type="date" id="tmE' + t.term + '" value="' + esc(dr.end) + '"' + (eDis ? ' disabled' : '') + ' oninput="tmEdit(' + year + ',' + t.term + ',\'end\',this.value)"></div>' +
    (t.start ? '<div class="tm-note">' + esc(tmDay(t.start)) + ' to ' + esc(tmDay(t.end)) + '</div>' : '') +
    (lockNote ? '<div class="tm-note">' + esc(lockNote) + '</div>' : '') + pay + billed + bill + foot + msg + askHtml + '</div>';
}

// the "this starts billing now" box: who would be billed, and a clear yes
function tmAsk(k, r) {
  const p = r.preview || { classes: [], classesBilled: 0, studentsBilled: 0, waitingForFees: [] };
  const lines = p.classes.length ? '<div class="tm-bill" style="margin-top:8px">' + p.classes.map(function (c) {
    return '<div><span>' + esc(c.class) + '</span><span>' + c.students + ' student' + (c.students === 1 ? '' : 's') + ' &middot; ' + esc(c.action) + '</span></div>';
  }).join('') + '</div>' : '';
  const text = p.note ? esc(p.note) : 'This term starts today or earlier, so billing runs right now: <b>' + p.studentsBilled + ' student' + (p.studentsBilled === 1 ? '' : 's') + '</b> in <b>' + p.classesBilled + ' class' + (p.classesBilled === 1 ? '' : 'es') + '</b> will be charged. Once a date is reached it locks, so check them.';
  return '<div class="tm-msg ask" role="alert">' + text + lines +
    '<div class="tm-foot"><button type="button" class="tm-btn go" onclick="tmConfirm(\'' + k + '\')">Yes, start it now</button><button type="button" class="tm-btn" onclick="tmCancelAsk(\'' + k + '\')">Cancel</button></div></div>';
}

// typing/picking a date: remember it and update the buttons without redrawing (so the picker stays open)
function tmEdit(year, term, which, value) {
  const k = tmKey(year, term);
  if (!tm.drafts[k]) tm.drafts[k] = {};
  tm.drafts[k][which] = value;
  delete tm.errs[k]; delete tm.asks[k];
  const yr = tm.data.years.find(function (y) { return y.year === year; });
  const t = yr.terms.find(function (x) { return x.term === term; });
  const dr = tmDraftOf(year, term, t);
  const changed = dr.start !== (t.start || '') || dr.end !== (t.end || '');
  const s = tmEl('tmSave_' + term); if (s) s.disabled = !(changed && dr.start && dr.end);
  const input = tmEl((which === 'start' ? 'tmS' : 'tmE') + term);
  if (input) input.classList.toggle('changed', value !== (which === 'start' ? (t.start || '') : (t.end || '')));
}
function tmUndo(year, term) { const k = tmKey(year, term); delete tm.drafts[k]; delete tm.errs[k]; delete tm.asks[k]; tmRender(); }
function tmCancelAsk(k) { delete tm.asks[k]; tmRender(); }
function tmConfirm(k) { const p = k.split('|'); tmSave(Number(p[0]), Number(p[1]), true); }

async function tmSave(year, term, confirmed) {
  const k = tmKey(year, term);
  if (tm.busy) return;
  const yr = tm.data.years.find(function (y) { return y.year === year; });
  const t = yr.terms.find(function (x) { return x.term === term; });
  const dr = tmDraftOf(year, term, t);
  delete tm.errs[k];
  tm.busy = k; tmRender();
  try {
    if (!confirmed) {
      // first a dry run of the very same save: it shows whether this starts billing now, and changes nothing
      const dry = await Api.post(tmBase() + '/terms', { year: year, term: term, start: dr.start, end: dr.end, dry: true });
      if (dry.needsConfirmation) { tm.asks[k] = dry; tm.busy = null; tmRender(); return; }
    }
    const r = await Api.post(tmBase() + '/terms', { year: year, term: term, start: dr.start, end: dr.end, confirm_started: confirmed === true });
    tm.busy = null;
    delete tm.drafts[k]; delete tm.asks[k];
    let msg = r.unchanged ? 'Nothing changed.' : 'Term ' + term + ' ' + year + ' saved.';
    if (r.billed && !r.billed.error && r.billed.billedClasses > 0) msg += ' Billed ' + r.billed.students + ' student' + (r.billed.students === 1 ? '' : 's') + '.';
    if (r.billed && r.billed.error) msg += ' Saved, but billing hit a problem and will retry by itself.';
    tmToast(msg);
    await tmLoad(true);
  } catch (e) {
    tm.busy = null; tm.errs[k] = e.message; tmRender();
  }
}