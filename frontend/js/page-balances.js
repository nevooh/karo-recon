/* page-balances.js - Students & balances, connected to the real database. Replaces the old read-only roster screen.
   - One row per student for ONE term (the school's current term unless you pick another that has started).
     Balance = brought forward + fees charged - paid.
   - Tiles on top follow the filters. Status chips (Owing / Cleared / Overpaid / Not billed) show how many students are in each.
   - Search by name or admission number; filter by class, stream and active/left; sort by biggest debt first and more.
   - Read only. Any staff member can look. Click a row to open the student's full page (page-student-sheet.js).
   Add to index.html AFTER live-screens.js:  <script src="js/page-balances.js"></script> */

const bl = { acc: null, moreBusy: false, data: null, error: null, loadToken: 0, f: { termId: '', q: '', classId: '', streamId: '', status: 'all', students: 'active', sort: 'name', offset: 0, limit: 40 }, timer: null };

(function () {
  if (document.getElementById('blStyle')) return;
  const css = document.createElement('style');
  css.id = 'blStyle';
  css.textContent = [
    '.bl-tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:0 0 16px}',
    '.bl-tile{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:14px 16px;min-width:0}',
    '.bl-tile span{display:block;font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted)}',
    '.bl-tile b{display:block;margin-top:5px;font-family:"IBM Plex Mono",monospace;font-size:19px;font-weight:600;overflow-wrap:anywhere}',
    '.bl-tile.warn b{color:var(--alert)} .bl-tile.good b{color:var(--matched)}',
    '.bl-bar{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 10px}',
    '.bl-bar input,.bl-bar select{font:inherit;font-size:14px;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:9px 11px;min-width:130px;flex:1;box-sizing:border-box}',
    '.bl-bar input{flex:2;min-width:200px}',
    '.bl-bar input:focus,.bl-bar select:focus{outline:none;border-color:var(--matched)}',
    '.bl-pills{display:flex;gap:7px;flex-wrap:wrap;margin:0 0 14px}',
    '.bl-pill{font:inherit;font-size:13px;border:1px solid var(--line);border-radius:20px;padding:6px 13px;cursor:pointer;background:transparent;color:var(--ink)}',
    '.bl-pill.on{border-color:var(--matched);background:rgba(89,179,125,.12)}',
    '.bl-pill small{color:var(--muted);margin-left:4px}',
    '.bl-sub{font-size:12px;color:var(--muted)}',
    '.bl-empty{text-align:center;padding:40px 20px;background:var(--surface);border:1px dashed var(--line);border-radius:16px;color:var(--muted);font-size:13.5px;line-height:1.6}',
    '.bl-pager{display:flex;justify-content:space-between;align-items:center;margin:12px 0;font-size:13px;color:var(--muted)}',
    '.bl-split{display:flex;gap:16px;align-items:flex-start}',
    '.bl-main{flex:1;min-width:0}',
    '.bl-cmp{display:none}',
    '.topbar:has(+ .bl-split.open){display:none}',
    '.bl-split.open{height:calc(100vh - 28px);align-items:stretch}',
    '.bl-split.open .bl-main{overflow-y:auto;padding:2px 6px 30px 2px;height:100%;box-sizing:border-box}',
    '.bl-split.open #blTiles,.bl-split.open .bl-x,.bl-split.open .bl-adm,.bl-split.open .bl-cls,.bl-split.open #blTerm,.bl-split.open #blStudents,.bl-split.open #blSort,.bl-split.open #blStream{display:none}',
    '.bl-split.open .bl-cmp{display:block;margin-top:2px}',
    '.bl-split.open .bl-bar{margin-bottom:8px}',
    '.bl-split.open .bl-bar input,.bl-split.open .bl-bar select{min-width:100px;padding:7px 10px;font-size:13px;border-radius:20px}',
    '.bl-split.open .bl-pills{gap:5px;margin-bottom:8px}',
    '.bl-split.open .bl-pill{font-size:12px;padding:4px 10px}',
    '.bl-split.open thead{display:none}',
    '.bl-split.open table{border-collapse:separate;border-spacing:0 6px}',
    '.bl-split.open tbody td{padding:9px 12px;font-size:13px;background:var(--surface);border:0}',
    '.bl-split.open tbody td:first-child{border-radius:12px 0 0 12px}',
    '.bl-split.open tbody td:last-child{border-radius:0 12px 12px 0;text-align:right}',
    '.bl-split.open tbody tr.sel td{background:var(--surface-raised)}',
    '.bl-split.open .bl-pager{font-size:12px}',
    '.bl-split.open tbody tr.sel{background:var(--surface-raised);box-shadow:inset 3px 0 0 var(--matched)}',
    '@media(max-width:880px){.bl-split.open .bl-main{display:none}}',
    '@media(max-width:760px){.bl-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}}',
  ].join('\n');
  document.head.appendChild(css);
})();

const blBase = function () { return '/schools/' + live.staff.school_id; };
const blEl = function (id) { return document.getElementById(id); };
const blMoney = function (n) { return money(Number(n) || 0); };
const BL_STATES = [['all', 'Everyone'], ['owing', 'Owing'], ['cleared', 'Cleared'], ['overpaid', 'Overpaid'], ['not_billed', 'Not billed']];

views.roster = function () {
  bl.data = null; bl.error = null;
  if (typeof ss !== 'undefined') { ss.open = false; ss.id = null; }
  setTimeout(blLoad, 0);
  return '<div class="topbar"><div><h1>Students &amp; balances</h1><p class="sub" id="blSub">Balance = brought forward + fees charged &minus; paid.</p></div></div>' +
    '<div class="bl-split" id="blSplit"><div class="bl-main"><div id="blTiles"></div><div id="blBar"></div><div id="blPills"></div><div id="blBody"><div class="bl-empty">Loading...</div></div></div></div>';
};

function blQuery() {
  const f = bl.f, p = [];
  const add = function (k, v) { if (v !== '' && v !== null && v !== undefined) p.push(k + '=' + encodeURIComponent(v)); };
  add('term_id', f.termId); add('q', f.q); add('class_id', f.classId); add('stream_id', f.streamId);
  add('status', f.status); add('students', f.students); add('sort', f.sort); add('limit', f.limit); add('offset', f.offset);
  return p.join('&');
}

async function blLoad() {
  if (!blEl('blBody') || !live.staff) return;
  const token = ++bl.loadToken;
  try {
    const d = await Api.get(blBase() + '/balances?' + blQuery());
    if (token !== bl.loadToken) return;
    bl.data = d; bl.error = null; bl.acc = d.rows.slice();
  } catch (e) { if (token !== bl.loadToken) return; bl.error = e.message; bl.data = null; }
  blRender();
}

function blSelect(id, label, value, options, onchange) {
  return '<select id="' + id + '" aria-label="' + esc(label) + '" onchange="' + onchange + '">' +
    options.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(value) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>';
}

function blRender() {
  if (!blEl('blBody')) return;
  const d = bl.data;
  if (bl.error) { blEl('blBody').innerHTML = '<div class="bl-empty"><b>Could not load the balances</b><br>' + esc(bl.error) + '<br><br><button type="button" class="btn small" onclick="blLoad()">Try again</button></div>'; return; }
  if (!d) return;
  if (!d.term) {
    blEl('blSub').textContent = 'No term has started for this school yet.';
    blEl('blTiles').innerHTML = ''; blEl('blBar').innerHTML = ''; blEl('blPills').innerHTML = '';
    blEl('blBody').innerHTML = '<div class="bl-empty">No term has started yet, so there are no balances to show.<br>Set the term dates first (Academic years &amp; terms).</div>';
    return;
  }
  blEl('blSub').innerHTML = esc(d.term.label) + ' &middot; ' + esc(d.term.start) + ' to ' + esc(d.term.end) + '. Balance = brought forward + fees charged &minus; paid.';
  const t = d.totals;
  blEl('blTiles').innerHTML = '<div class="bl-tiles">' +
    '<div class="bl-tile"><span>Billed</span><b>' + blMoney(t.billed) + '</b></div>' +
    '<div class="bl-tile good"><span>Paid</span><b>' + blMoney(t.paid) + '</b></div>' +
    '<div class="bl-tile warn"><span>Outstanding</span><b>' + blMoney(t.outstanding) + '</b></div>' +
    '<div class="bl-tile"><span>Students owing</span><b>' + t.owing + ' of ' + t.students + '</b></div></div>';

  // the controls are drawn once per load; the search box keeps what was typed
  const f = bl.f;
  const streams = d.streams.filter(function (s) { return !f.classId || String(s.class_id) === String(f.classId); });
  if (!blEl('blQ') || blEl('blBar').dataset.term !== String(d.term.id)) {
    blEl('blBar').dataset.term = String(d.term.id);
    blEl('blBar').innerHTML = '<div class="bl-bar"><input id="blQ" type="search" placeholder="Search name or admission number" value="' + esc(f.q) + '" aria-label="Search" oninput="blSearch(this.value)">' +
      '<span id="blSelects" style="display:contents"></span></div>';
  }
  blEl('blSelects').innerHTML =
    blSelect('blTerm', 'Term', d.term.id, d.terms.map(function (x) { return [x.id, x.label]; }), 'blSet(\'termId\',this.value)') +
    blSelect('blClass', 'Class', f.classId, [['', 'All classes']].concat(d.classes.map(function (c) { return [c.id, c.name]; })), 'blSet(\'classId\',this.value)') +
    (streams.length ? blSelect('blStream', 'Stream', f.streamId, [['', 'All streams']].concat(streams.map(function (s) { return [s.id, s.name]; })), 'blSet(\'streamId\',this.value)') : '') +
    blSelect('blStudents', 'Students', f.students, [['active', 'Active students'], ['left', 'Students who left'], ['all', 'Active and left']], 'blSet(\'students\',this.value)') +
    blSelect('blSort', 'Sort', f.sort, [['name', 'Name'], ['admission', 'Admission no.'], ['class', 'Class'], ['balance_desc', 'Biggest debt first'], ['balance_asc', 'Most credit first']], 'blSet(\'sort\',this.value)');

  blEl('blPills').innerHTML = '<div class="bl-pills">' + BL_STATES.map(function (s) {
    return '<button type="button" class="bl-pill' + (f.status === s[0] ? ' on' : '') + '" onclick="blSet(\'status\',\'' + s[0] + '\')">' + s[1] + '<small>' + d.counts[s[0]] + '</small></button>';
  }).join('') + '</div>';

  if (!d.rows.length) {
    blEl('blBody').innerHTML = '<div class="bl-empty">' + (d.counts.all === 0 && !f.q && !f.classId && !f.streamId ? 'No students here yet. Admit the first one from Admit students.' : 'No students match these filters.') + '</div>';
    return;
  }
  const isOpen = !!(blEl('blSplit') && blEl('blSplit').classList.contains('open'));
  const list = isOpen && bl.acc ? bl.acc : d.rows;
  const rows = list.map(function (s) {
    const cls = s.balance > 0 ? 'due' : (s.balance < 0 ? 'credit' : 'clear');
    const txt = s.state === 'not_billed' ? 'Not billed' : s.balance === 0 ? 'Paid up' : blMoney(Math.abs(s.balance)) + (s.balance < 0 ? ' credit' : ' due');
    return '<tr class="' + (typeof ss !== 'undefined' && ss.open && ss.id === s.id ? 'sel' : '') + '" data-id="' + s.id + '" style="cursor:pointer" tabindex="0" onclick="ssOpen(' + s.id + ')" onkeydown="if(event.key===\'Enter\')ssOpen(' + s.id + ')"><td class="bl-adm" data-label="Admission"><span class="adm">' + esc(s.admission_no) + '</span></td>' +
      '<td data-label="Name"><span class="name">' + esc(s.full_name) + '</span>' + (s.student_status !== 'active' ? ' <span class="badge repeat">' + esc(s.student_status) + '</span>' : '') + '<span class="bl-cmp bl-sub">' + esc(s.admission_no) + ' &middot; ' + esc(s.class || '-') + (s.stream ? ' ' + esc(s.stream) : '') + '</span></td>' +
      '<td class="bl-cls" data-label="Class">' + esc(s.class || '-') + (s.stream ? ' <span class="bl-sub">' + esc(s.stream) + '</span>' : '') + '</td>' +
      '<td class="bl-x" data-label="Brought fwd">' + (s.brought_forward ? blMoney(s.brought_forward) : '<span class="bl-sub">-</span>') + '</td>' +
      '<td class="bl-x" data-label="Charged">' + blMoney(s.fees_charged) + '</td><td class="bl-x" data-label="Paid">' + blMoney(s.paid) + '</td>' +
      '<td data-label="Balance"><span class="bal ' + cls + '">' + txt + '</span></td></tr>';
  }).join('');
  const to = Math.min(f.offset + f.limit, d.total);
  const foot = isOpen
    ? '<div class="bl-pager" style="justify-content:center">' + (list.length < d.total ? 'Loading more as you scroll... (' + list.length + ' of ' + d.total + ')' : 'All ' + d.total + ' shown') + '</div>'
    : '<div class="bl-pager"><button type="button" class="btn small" ' + (f.offset <= 0 ? 'disabled' : '') + ' onclick="blPage(-1)">&larr; Previous</button><span>' + (f.offset + 1) + '&ndash;' + to + ' of ' + d.total + '</span><button type="button" class="btn small" ' + (to >= d.total ? 'disabled' : '') + ' onclick="blPage(1)">Next &rarr;</button></div>';
  blEl('blBody').innerHTML = '<table><thead><tr><th>Admission</th><th>Name</th><th>Class</th><th class="bl-x">Brought fwd</th><th class="bl-x">Charged</th><th class="bl-x">Paid</th><th>Balance</th></tr></thead><tbody>' + rows + '</tbody></table>' + foot;
  if (isOpen && list.length < d.total) setTimeout(function () { const m = document.querySelector('.bl-main'); if (m && m.scrollHeight <= m.clientHeight + 160) blMore(); }, 50);
}

// infinite scroll: while a sheet is open the list keeps loading the next students as you reach the bottom
async function blMore() {
  const d = bl.data;
  if (!d || !bl.acc || bl.moreBusy || bl.acc.length >= d.total || !blEl('blBody')) return;
  bl.moreBusy = true;
  const token = bl.loadToken;
  try {
    const f = bl.f, saved = f.offset;
    f.offset = bl.acc.length;
    const q = blQuery();
    f.offset = saved;
    const more = await Api.get(blBase() + '/balances?' + q);
    if (token !== bl.loadToken) { bl.moreBusy = false; return; }
    const seen = {}; bl.acc.forEach(function (r) { seen[r.id] = 1; });
    more.rows.forEach(function (r) { if (!seen[r.id]) bl.acc.push(r); });
  } catch (e) { /* stay quiet; scrolling again retries */ }
  bl.moreBusy = false;
  blRender();
}
document.addEventListener('scroll', function (e) {
  const el = e.target;
  if (!el || !el.classList || !el.classList.contains('bl-main')) return;
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 160) blMore();
}, true);

function blSet(key, value) {
  bl.f[key] = value; bl.f.offset = 0;
  if (key === 'classId') bl.f.streamId = '';                      // a stream belongs to one class
  blLoad();
}
function blPage(dir) { bl.f.offset = Math.max(0, bl.f.offset + dir * bl.f.limit); blLoad(); }
function blSearch(v) { clearTimeout(bl.timer); bl.timer = setTimeout(function () { bl.f.q = v.trim(); bl.f.offset = 0; blLoad(); }, 300); }

// highlight the student whose sheet is open (no redraw, so the list keeps its scroll and filters)
function blMark() {
  document.querySelectorAll('#blBody tbody tr[data-id]').forEach(function (tr) {
    tr.classList.toggle('sel', typeof ss !== 'undefined' && ss.open && Number(tr.dataset.id) === ss.id);
  });
}