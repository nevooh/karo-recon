/* page-payments.js - the Payments page: every payment received, newest first.
   Replaces the old payments screen in live-screens.js (load AFTER it and after page-student-sheet.js).
   - Two separate columns: "Code" (the M-Pesa / bank transaction code) and "Paid for" (what the parent typed, usually the admission number).
   - Student name opens the student's full page. Filters: status pills with counts, channel, date range, search.
   - Dark-theme filters (the old ones were white). Read only. */
const pm = { data: null, error: null, loadToken: 0, f: { status: '', source: '', from: '', to: '', q: '', offset: 0, limit: 25 }, timer: null };

(function () {
  if (document.getElementById('pmStyle')) return;
  const css = document.createElement('style');
  css.id = 'pmStyle';
  css.textContent = [
    '.pm-tiles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:0 0 16px}',
    '.pm-tile{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:14px 16px;min-width:0}',
    '.pm-tile span{display:block;font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted)}',
    '.pm-tile b{display:block;margin-top:5px;font-family:"IBM Plex Mono",monospace;font-size:19px;font-weight:600}',
    '.pm-tile.warn b{color:var(--cash)} .pm-tile.bad b{color:var(--alert)}',
    '.pm-pills{display:flex;gap:7px;flex-wrap:wrap;margin:0 0 12px}',
    '.pm-pill{font:inherit;font-size:13px;border:1px solid var(--line);border-radius:20px;padding:6px 13px;cursor:pointer;background:transparent;color:var(--ink)}',
    '.pm-pill.on{border-color:var(--matched);background:rgba(89,179,125,.12)}',
    '.pm-pill small{color:var(--muted);margin-left:4px}',
    '.pm-bar{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin:0 0 14px}',
    '.pm-bar .f{display:flex;flex-direction:column;gap:4px;min-width:130px;flex:1}',
    '.pm-bar .f.q{flex:2;min-width:220px}',
    '.pm-bar label{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}',
    '.pm-bar input,.pm-bar select{font:inherit;font-size:14px;color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:9px 11px;box-sizing:border-box;width:100%;color-scheme:dark}',
    '.pm-bar input:focus,.pm-bar select:focus{outline:none;border-color:var(--matched)}',
    '.pm-clear{font:inherit;font-size:13px;color:var(--muted);background:transparent;border:1px solid var(--line);border-radius:10px;padding:9px 13px;cursor:pointer}',
    '.pm-clear:hover{color:var(--ink);border-color:var(--muted)}',
    '.pm-code{font-family:"IBM Plex Mono",monospace;font-size:12.5px;letter-spacing:.02em}',
    '.pm-muted{color:var(--muted)}',
    '.pm-st{font:inherit;color:var(--ink);background:none;border:0;padding:0;cursor:pointer;text-align:left;border-bottom:1px dotted var(--muted)}',
    '.pm-st:hover{color:var(--matched);border-bottom-color:var(--matched)}',
    '.pm-b{display:inline-block;padding:2px 10px;border-radius:999px;font-size:11.5px;font-weight:600;white-space:nowrap}',
    '.pm-b.auto_matched,.pm-b.confirmed{background:rgba(89,179,125,.16);color:var(--matched)}',
    '.pm-b.needs_review{background:rgba(217,164,65,.16);color:var(--cash)}',
    '.pm-b.unmatched{background:rgba(143,163,152,.16);color:var(--muted)}',
    '.pm-b.rejected{background:rgba(226,87,76,.14);color:var(--alert)}',
    '.pm-hand{display:block;font-size:11px;color:var(--muted);margin-top:2px}',
    '.pm-empty{text-align:center;padding:40px 20px;background:var(--surface);border:1px dashed var(--line);border-radius:16px;color:var(--muted);font-size:13.5px;line-height:1.6}',
    '.pm-pager{display:flex;justify-content:space-between;align-items:center;margin:12px 0;font-size:13px;color:var(--muted)}',
    '@media(max-width:760px){.pm-tiles{grid-template-columns:1fr}}',
  ].join('\n');
  document.head.appendChild(css);
})();

const pmEl = function (id) { return document.getElementById(id); };
const PM_LABEL = { auto_matched: 'Auto-matched', confirmed: 'Confirmed', needs_review: 'Needs review', unmatched: 'Unmatched', rejected: 'Rejected' };
const PM_METHOD = { cash: 'Cash', mpesa: 'M-Pesa', bank: 'Bank', cheque: 'Cheque', other: 'Other' };

views.payments = function () {
  pm.data = null; pm.error = null;
  setTimeout(pmLoad, 0);
  return '<div id="pmRoot">' + pmBody() + '</div>';
};

async function pmLoad() {
  if (!pmEl('pmRoot') || !live.staff) return;
  const token = ++pm.loadToken, f = pm.f;
  const qs = 'limit=' + f.limit + '&offset=' + f.offset + (f.status ? '&status=' + f.status : '') + (f.source ? '&source=' + f.source : '') +
    (f.from ? '&from=' + f.from : '') + (f.to ? '&to=' + f.to : '') + (f.q ? '&q=' + encodeURIComponent(f.q) : '');
  pm.error = null;
  try { const d = await Api.get('/schools/' + live.staff.school_id + '/transactions?' + qs); if (token !== pm.loadToken) return; pm.data = d; }
  catch (e) { if (token !== pm.loadToken) return; pm.error = e.message; }
  pmRenderResults();
}

function pmHead() { return '<div class="topbar"><div><h1>Payments</h1><p class="sub">Every payment received, newest first. Click a student to open their page.</p></div></div>'; }

function pmBody() {
  const f = pm.f, c = (pm.data && pm.data.counts) || {};
  const total = Object.keys(c).reduce(function (a, k) { return a + c[k]; }, 0);
  const pills = [['', 'All', total], ['auto_matched', 'Auto-matched', c.auto_matched], ['needs_review', 'Needs review', c.needs_review], ['unmatched', 'Unmatched', c.unmatched], ['confirmed', 'Confirmed', c.confirmed], ['rejected', 'Rejected', c.rejected]]
    .map(function (p) { return '<button type="button" class="pm-pill' + (f.status === p[0] ? ' on' : '') + '" onclick="pmSet(\'status\',\'' + p[0] + '\')">' + p[1] + (pm.data ? '<small>' + (p[2] || 0) + '</small>' : '') + '</button>'; }).join('');
  const src = [['', 'All channels'], ['mpesa', 'M-Pesa'], ['kcb', 'KCB'], ['equity', 'Equity'], ['coop', 'Co-op'], ['manual', 'Recorded by hand']]
    .map(function (p) { return '<option value="' + p[0] + '"' + (f.source === p[0] ? ' selected' : '') + '>' + p[1] + '</option>'; }).join('');
  const any = f.status || f.source || f.from || f.to || f.q;
  return pmHead() + '<div id="pmTiles"></div><div class="pm-pills" id="pmPills">' + pills + '</div>' +
    '<div class="pm-bar"><div class="f q"><label for="pmQ">Search</label><input id="pmQ" placeholder="Code, payer, student, admission no. or amount" value="' + esc(f.q) + '" oninput="pmSearch(this.value)"></div>' +
    '<div class="f"><label for="pmSrc">Channel</label><select id="pmSrc" onchange="pmSet(\'source\',this.value)">' + src + '</select></div>' +
    '<div class="f"><label for="pmFrom">From</label><input id="pmFrom" type="date" value="' + esc(f.from) + '" onchange="pmSet(\'from\',this.value)"></div>' +
    '<div class="f"><label for="pmTo">To</label><input id="pmTo" type="date" value="' + esc(f.to) + '" onchange="pmSet(\'to\',this.value)"></div>' +
    (any ? '<button type="button" class="pm-clear" onclick="pmClear()">Clear</button>' : '') + '</div>' +
    '<div id="pmBody"><p class="sub">Loading&hellip;</p></div>';
}

function pmWhen(v) { return esc(String(v || '').slice(0, 16).replace('T', ' ')); }

function pmRenderResults() {
  const box = pmEl('pmBody'); if (!box) return;
  if (pm.error) { box.innerHTML = '<div class="pm-empty"><b>Could not load payments</b><br>' + esc(pm.error) + '<br><br><button type="button" class="pm-clear" onclick="pmLoad()">Try again</button></div>'; return; }
  const d = pm.data, c = d.counts || {}, f = pm.f;
  const pills = pmEl('pmPills');
  if (pills) pills.querySelectorAll('.pm-pill').forEach(function (b, i) {
    const keys = ['', 'auto_matched', 'needs_review', 'unmatched', 'confirmed', 'rejected'];
    const n = keys[i] === '' ? Object.keys(c).reduce(function (a, k) { return a + c[k]; }, 0) : (c[keys[i]] || 0);
    const sm = b.querySelector('small'); if (sm) sm.textContent = n; else b.insertAdjacentHTML('beforeend', '<small>' + n + '</small>');
  });
  const sum = d.rows.reduce(function (a, t) { return a + (t.match_status === 'rejected' ? 0 : Number(t.amount)); }, 0);
  pmEl('pmTiles').innerHTML = '<div class="pm-tiles"><div class="pm-tile"><span>Payments found</span><b>' + d.total + '</b></div>' +
    '<div class="pm-tile warn"><span>Need review</span><b>' + (c.needs_review || 0) + '</b></div>' +
    '<div class="pm-tile bad"><span>Unmatched</span><b>' + (c.unmatched || 0) + '</b></div></div>';
  if (!d.rows.length) { box.innerHTML = '<div class="pm-empty">No payments match these filters.</div>'; return; }
  const rows = d.rows.map(function (t) {
    const manual = t.source === 'manual';
    const code = manual ? (t.typed_ref || '') : (t.external_ref || '');
    const chan = manual ? esc(PM_METHOD[t.method] || 'Hand') + '<span class="pm-hand">recorded by hand</span>' : chipFor(t.source);
    const stu = t.matched_student_id && t.student_name
      ? '<button type="button" class="pm-st" onclick="ssOpen(' + t.matched_student_id + ')">' + esc(t.student_name) + '</button> <span class="adm">' + esc(t.admission_no) + '</span>'
      : '<span class="pm-muted">-</span>';
    return '<tr><td data-label="When">' + pmWhen(t.received_at || t.created_at) + '</td><td data-label="Channel">' + chan + '</td>' +
      '<td data-label="Amount"><b>' + money(Number(t.amount)) + '</b></td>' +
      '<td data-label="Code">' + (code ? '<span class="pm-code">' + esc(code) + '</span>' : '<span class="pm-muted">-</span>') + '</td>' +
      '<td data-label="Paid for">' + (t.narration ? esc(t.narration) : '<span class="pm-muted">-</span>') + '</td>' +
      '<td data-label="Student">' + stu + '</td><td data-label="Status"><span class="pm-b ' + esc(t.match_status) + '">' + esc(PM_LABEL[t.match_status] || t.match_status) + '</span></td></tr>';
  }).join('');
  const to = Math.min(f.offset + f.limit, d.total);
  box.innerHTML = '<table><thead><tr><th>When</th><th>Channel</th><th>Amount</th><th>Code</th><th>Paid for</th><th>Student</th><th>Status</th></tr></thead><tbody>' + rows + '</tbody></table>' +
    '<div class="pm-pager"><button type="button" class="pm-clear" ' + (f.offset <= 0 ? 'disabled' : '') + ' onclick="pmPage(-1)">&larr; Newer</button><span>' + (f.offset + 1) + '&ndash;' + to + ' of ' + d.total + '</span>' +
    '<button type="button" class="pm-clear" ' + (to >= d.total ? 'disabled' : '') + ' onclick="pmPage(1)">Older &rarr;</button></div>';
}

window.pmLoad = pmLoad;
window.pmSet = function (k, v) {
  pm.f[k] = v; pm.f.offset = 0;
  const r = pmEl('pmRoot'); if (r) { const keep = pm.data; r.innerHTML = pmBody(); pm.data = keep; }
  pmLoad();
};
window.pmClear = function () { pm.f.status = pm.f.source = pm.f.from = pm.f.to = pm.f.q = ''; pm.f.offset = 0; const r = pmEl('pmRoot'); if (r) r.innerHTML = pmBody(); pmLoad(); };
window.pmPage = function (dir) { pm.f.offset = Math.max(0, pm.f.offset + dir * pm.f.limit); pmLoad(); };
window.pmSearch = function (v) { clearTimeout(pm.timer); pm.timer = setTimeout(function () { pm.f.q = v.trim(); pm.f.offset = 0; pmLoad(); }, 300); };