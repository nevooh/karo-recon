/* page-class-detail.js - the FULL PAGE of one class (opens from the Classes & streams list).
   Uses: cls (page-classes.js), live, esc, money, Api, stDialog/stToast (page-staff.js), shellLogo/shellSchool (shell.js).

   Two tabs:
     STUDENTS  the full class list with billed / paid / balance and a Paid-up / Owing tag.
               Filters: search, stream, status. CSV and Print both use exactly what the filters show,
               so a class teacher can filter to their stream and print just that list.
               Moving students between streams happens here (a row button, or tick several).
               "No stream" students are flagged only when the class actually has streams.
     STREAMS   add, rename and remove empty streams. Merging is hidden under "More".
   A student never changes CLASS here (that is Promotion & transfers, because fees follow the class).
   Numbers come from the same ledger as Students & balances (/balances), so they always agree.
   Add to index.html right AFTER page-classes.js:  <script src="js/page-class-detail.js"></script> */

const cd = { classId: null, tab: 'students', stream: '', status: 'all', q: '', termId: null, data: null, rows: null, error: '', picked: new Set(), busy: false };

(function () {
  if (document.getElementById('cdStyle')) return;
  const c = document.createElement('style'); c.id = 'cdStyle';
  c.textContent = [
    '.cd-back{font:inherit;font-size:13px;background:transparent;border:0;color:var(--muted);cursor:pointer;padding:0;margin:0 0 10px}.cd-back:hover{color:var(--ink)}',
    '.cd-top{display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap;margin-bottom:14px}.cd-top h1{margin:0}',
    '.cd-tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:14px 0}',
    '.cd-tile{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:13px 16px}',
    '.cd-tile span{display:block;font-size:12px;color:var(--muted)}.cd-tile b{display:block;font:500 20px "IBM Plex Mono",monospace;margin-top:3px}',
    '.cd-tabs{display:flex;gap:6px;border-bottom:1px solid var(--line);margin:6px 0 14px}',
    '.cd-tab{font:inherit;font-size:13.5px;background:transparent;border:0;border-bottom:2px solid transparent;color:var(--muted);padding:9px 14px;cursor:pointer;margin-bottom:-1px}',
    '.cd-tab.on{color:var(--ink);border-bottom-color:var(--matched);font-weight:600}',
    '.cd-bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px}',
    '.cd-bar .cls-in{min-width:0;width:auto}.cd-bar select.cls-in{min-width:140px}.cd-sp{flex:1}',
    '.cd-pill{font:inherit;font-size:12.5px;border:1px solid var(--line);background:transparent;color:var(--muted);border-radius:20px;padding:5px 12px;cursor:pointer}',
    '.cd-pill.on{border-color:var(--matched);color:var(--ink);background:rgba(89,179,125,.1)}.cd-pill b{font-weight:500;margin-left:4px;font-family:"IBM Plex Mono",monospace;font-size:11.5px}',
    '.cd-warn{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:10px 14px;border-radius:10px;background:rgba(217,164,65,.12);border:1px solid rgba(217,164,65,.4);font-size:13px;margin-bottom:12px}',
    '.cd-sel{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:9px 14px;border-radius:10px;background:var(--surface-raised);border:1px solid var(--matched);font-size:13px;margin-bottom:10px}',
    '.cd-wrap{overflow-x:auto;background:var(--surface);border:1px solid var(--line);border-radius:14px}',
    '.cd-tbl{width:100%;border-collapse:collapse;font-size:13.5px;min-width:640px}',
    '.cd-tbl th{font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:500;text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);white-space:nowrap}',
    '.cd-tbl td{padding:9px 12px;border-bottom:1px solid var(--line);white-space:nowrap}.cd-tbl tr:last-child td{border-bottom:0}',
    '.cd-tbl .n{text-align:right;font-family:"IBM Plex Mono",monospace;font-size:12.5px}.cd-tbl th.n{text-align:right}',
    '.cd-tbl .adm{font-family:"IBM Plex Mono",monospace;font-size:12px;color:var(--muted)}',
    '.cd-tag{font-size:11.5px;border-radius:20px;padding:2px 9px;border:1px solid var(--line);color:var(--muted)}',
    '.cd-tag.owing{color:var(--alert);border-color:rgba(226,87,76,.5)}.cd-tag.ok{color:var(--matched);border-color:rgba(89,179,125,.5)}.cd-tag.cr{color:var(--bank);border-color:rgba(90,140,220,.5)}',
    '.cd-nost{font-size:12px;color:var(--cash)}',
    '.cd-link{font:inherit;font-size:12.5px;color:var(--matched);background:transparent;border:0;cursor:pointer;padding:0;text-decoration:underline}',
    '.cd-empty{padding:40px 20px;text-align:center;color:var(--muted);font-size:13.5px}',
    '.cd-card{background:var(--surface);border:1px solid var(--line);border-radius:14px;margin-bottom:12px;overflow:hidden}',
    '.cd-srow{display:flex;gap:12px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line);flex-wrap:wrap}.cd-srow:last-child{border-bottom:0}',
    '.cd-srow .nm{font-weight:600;min-width:90px}.cd-srow .ct{font-size:12.5px;color:var(--muted);margin-right:auto}',
    '.cd-more{margin-top:14px}.cd-more summary{cursor:pointer;color:var(--muted);font-size:13px;padding:6px 0}.cd-more[open] summary{color:var(--ink)}',
    '.cd-more .cd-card{padding:14px 16px;margin-top:8px}.cd-more p{font-size:12.5px;color:var(--muted);margin:0 0 10px;line-height:1.5}',
    '#cdPrint{display:none}',
    '@media(max-width:760px){.cd-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}}',
    '@media print{body.cd-printing *{visibility:hidden !important}body.cd-printing{background:#fff !important}',
    'body.cd-printing #cdPrint,body.cd-printing #cdPrint *{visibility:visible !important}',
    'body.cd-printing #cdPrint{display:block;position:absolute;left:0;top:0;width:100%;padding:0 6mm;color:#111;font:12px/1.4 "IBM Plex Sans",sans-serif;background:#fff}',
    '#cdPrint table{width:100%;border-collapse:collapse;margin-top:10px}#cdPrint th,#cdPrint td{border-bottom:1px solid #ccc;padding:4px 6px;text-align:left;font-size:11.5px}',
    '#cdPrint th{font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;color:#555}#cdPrint .n{text-align:right}#cdPrint tfoot td{font-weight:700;border-top:2px solid #111}',
    '#cdPrint tr{break-inside:avoid}}',
  ].join('\n');
  document.head.appendChild(c);
})();

/* ---------- small helpers ---------- */
const cdIsAdmin = function () { return !(live.staff && live.staff.role === 'staff'); };   // the server enforces this too
const cdMoney = function (n) { return Number(n || 0).toLocaleString('en-KE', { maximumFractionDigits: 2 }); };
const cdClass = function () { return cls.data ? cls.data.classes.find(function (c) { return c.id === cd.classId; }) : null; };
const cdStreams = function () { const c = cdClass(); return c ? c.streams : []; };
const cdBilled = function (r) { return r.brought_forward + r.fees_charged; };
function cdStreamLabel() {
  if (cd.stream === 'none') return 'No stream';
  const s = cdStreams().find(function (x) { return String(x.id) === String(cd.stream); });
  return s ? s.name : '';
}

/* ---------- opening, loading ---------- */
window.clsOpenClass = function (classId, streamId) {
  cd.classId = Number(classId); cd.tab = 'students'; cd.stream = streamId ? String(streamId) : ''; cd.status = 'all'; cd.q = '';
  cd.picked = new Set(); cd.rows = null; cd.data = null; cd.error = ''; cls.open = cd.classId;
  clsRender(); window.scrollTo(0, 0); cdLoad();
};
window.clsCloseClass = function () { cls.open = null; cd.rows = null; clsRender(); clsLoad(); };
async function cdLoad() {
  if (!cls.open) return;
  try {
    let all = [], off = 0, first = null;
    for (;;) {                                                    // pages of 200 until the whole class is in
      const r = await Api.get(clsBase() + '/balances?class_id=' + cd.classId + '&limit=200&offset=' + off + (cd.termId ? '&term_id=' + cd.termId : ''));
      if (!first) first = r;
      all = all.concat(r.rows); off += r.rows.length;
      if (!r.rows.length || all.length >= r.total) break;
    }
    cd.data = first; cd.rows = all; cd.error = '';
    if (!cd.termId && first.term) cd.termId = first.term.id;
    cd.picked = new Set(Array.from(cd.picked).filter(function (id) { return all.some(function (r) { return r.id === id; }); }));
    if (!live.school) await shellSchool();
  } catch (e) { cd.error = e.message; }
  if (cls.open) clsRender();
}
async function cdReload() { await clsLoad(); await cdLoad(); }

/* ---------- filtering ---------- */
function cdFiltered(ignoreStatus) {
  const q = cd.q.trim().toLowerCase();
  return (cd.rows || []).filter(function (r) {
    if (cd.stream === 'none' && r.stream_id) return false;
    if (cd.stream && cd.stream !== 'none' && String(r.stream_id) !== cd.stream) return false;
    if (q && (r.full_name + ' ' + r.admission_no).toLowerCase().indexOf(q) === -1) return false;
    if (!ignoreStatus && cd.status !== 'all') {
      if (cd.status === 'paid') return r.state === 'cleared' || r.state === 'overpaid';
      return r.state === cd.status;
    }
    return true;
  });
}
const cdTag = function (r) {
  return r.state === 'owing' ? '<span class="cd-tag owing">Owing</span>' : r.state === 'cleared' ? '<span class="cd-tag ok">Paid up</span>' :
    r.state === 'overpaid' ? '<span class="cd-tag cr">Credit</span>' : '<span class="cd-tag">Not billed</span>';
};
const cdTagText = function (r) { return r.state === 'owing' ? 'Owing' : r.state === 'cleared' ? 'Paid up' : r.state === 'overpaid' ? 'Credit' : 'Not billed'; };
function cdSums(rows) {
  const s = { n: rows.length, billed: 0, paid: 0, owed: 0 };
  rows.forEach(function (r) { s.billed += cdBilled(r); s.paid += r.paid; if (r.balance > 0) s.owed += r.balance; });
  return s;
}

/* ---------- the page ---------- */
function cdBody() {
  const c = cdClass();
  if (!c) return '<button type="button" class="cd-back" onclick="clsCloseClass()">&larr; All classes</button><p class="sub">That class is not offered any more.</p>';
  const term = cd.data && cd.data.term ? cd.data.term.label : '';
  const back = '<button type="button" class="cd-back" onclick="clsCloseClass()">&larr; All classes</button>';
  const top = '<div class="cd-top"><div><h1>' + esc(c.name) + '</h1><p class="sub">' + (term ? esc(term) + ' &middot; ' : '') + c.student_count + ' student' + (c.student_count === 1 ? '' : 's') +
    (c.streams.length ? ' &middot; ' + c.streams.length + ' stream' + (c.streams.length === 1 ? '' : 's') : '') + '</p></div></div>';
  const tabs = '<div class="cd-tabs"><button type="button" class="cd-tab' + (cd.tab === 'students' ? ' on' : '') + '" onclick="cdTab(\'students\')">Students</button>' +
    '<button type="button" class="cd-tab' + (cd.tab === 'streams' ? ' on' : '') + '" onclick="cdTab(\'streams\')">Streams</button></div>';
  return back + top + tabs + (cd.tab === 'streams' ? cdStreamsHtml(c) : cdStudentsHtml(c));
}

function cdStudentsHtml(c) {
  if (cd.error) return '<div class="cd-empty">' + esc(cd.error) + '<br><button type="button" class="cls-btn" style="margin-top:10px" onclick="cdLoad()">Try again</button></div>';
  if (!cd.rows) return '<div class="cd-empty">Loading students&hellip;</div>';
  const admin = cdIsAdmin(), streams = c.streams;
  const base = cdFiltered(true), rows = cdFiltered(false), sums = cdSums(rows);
  const cnt = { all: base.length, owing: 0, paid: 0, not_billed: 0 };
  base.forEach(function (r) { if (r.state === 'owing') cnt.owing++; else if (r.state === 'not_billed') cnt.not_billed++; else cnt.paid++; });
  const pill = function (k, label) { return '<button type="button" class="cd-pill' + (cd.status === k ? ' on' : '') + '" onclick="cdStatus(\'' + k + '\')">' + label + '<b>' + cnt[k] + '</b></button>'; };
  const noStream = streams.length ? (cd.rows || []).filter(function (r) { return !r.stream_id; }) : [];
  const warn = admin && noStream.length && cd.stream !== 'none'
    ? '<div class="cd-warn"><span><b>' + noStream.length + '</b> student' + (noStream.length === 1 ? ' has' : 's have') + ' no stream yet.</span><button type="button" class="cls-btn sm" onclick="cdStream(\'none\')">Show them</button></div>' : '';
  const tiles = '<div class="cd-tiles"><div class="cd-tile"><span>Students shown</span><b>' + sums.n + '</b></div><div class="cd-tile"><span>Billed</span><b>' + cdMoney(sums.billed) + '</b></div>' +
    '<div class="cd-tile"><span>Collected</span><b>' + cdMoney(sums.paid) + '</b></div><div class="cd-tile"><span>Outstanding</span><b style="color:' + (sums.owed > 0 ? 'var(--alert)' : 'inherit') + '">' + cdMoney(sums.owed) + '</b></div></div>';
  const streamSel = streams.length ? '<select class="cls-in" aria-label="Stream" onchange="cdStream(this.value)"><option value="">All streams</option>' +
    streams.map(function (s) { return '<option value="' + s.id + '"' + (cd.stream === String(s.id) ? ' selected' : '') + '>' + esc(s.name) + '</option>'; }).join('') +
    '<option value="none"' + (cd.stream === 'none' ? ' selected' : '') + '>No stream</option></select>' : '';
  const termSel = cd.data.terms && cd.data.terms.length > 1 ? '<select class="cls-in" aria-label="Term" onchange="cdTerm(this.value)">' +
    cd.data.terms.map(function (t) { return '<option value="' + t.id + '"' + (t.id === cd.termId ? ' selected' : '') + '>' + esc(t.label) + '</option>'; }).join('') + '</select>' : '';
  const bar = '<div class="cd-bar"><input type="search" class="cls-in" style="flex:1;min-width:150px;max-width:280px" placeholder="Search name or admission no." value="' + esc(cd.q) + '" oninput="cdSearch(this.value)">' + streamSel + termSel +
    '<span class="cd-sp"></span><button type="button" class="cls-btn sm" onclick="cdCsv()">Download CSV</button><button type="button" class="cls-btn sm" onclick="cdPrint()">Print list</button></div>' +
    '<div class="cd-bar">' + pill('all', 'All') + pill('owing', 'Owing') + pill('paid', 'Paid up') + pill('not_billed', 'Not billed') + '</div>';
  const canMove = admin && streams.length > 0;
  const sel = cd.picked.size && canMove ? '<div class="cd-sel"><b>' + cd.picked.size + ' selected</b><button type="button" class="cls-btn go sm" style="color:#0E1613" onclick="cdMove()">Move to stream&hellip;</button><button type="button" class="cd-link" onclick="cdClear()">Clear</button></div>' : '';
  const allOn = rows.length && rows.every(function (r) { return cd.picked.has(r.id); });
  const head = '<tr>' + (canMove ? '<th style="width:30px"><input type="checkbox" aria-label="Select all shown" ' + (allOn ? 'checked ' : '') + 'onchange="cdPickAll(this.checked)"></th>' : '') +
    '<th>Adm no.</th><th>Name</th>' + (streams.length ? '<th>Stream</th>' : '') + '<th class="n">Billed</th><th class="n">Paid</th><th class="n">Balance</th><th>Status</th>' + (canMove ? '<th></th>' : '') + '</tr>';
  const body = rows.map(function (r) {
    const st = streams.length ? '<td>' + (r.stream ? esc(r.stream) : '<span class="cd-nost">No stream</span>') + '</td>' : '';
    const act = canMove ? '<td style="text-align:right"><button type="button" class="cd-link" onclick="cdMove(' + r.id + ')">' + (r.stream_id ? 'Move' : 'Put in stream') + '</button></td>' : '';
    return '<tr>' + (canMove ? '<td><input type="checkbox" aria-label="Select ' + esc(r.full_name) + '" ' + (cd.picked.has(r.id) ? 'checked ' : '') + 'onchange="cdPick(' + r.id + ',this.checked)"></td>' : '') +
      '<td class="adm">' + esc(r.admission_no) + '</td><td>' + esc(r.full_name) + '</td>' + st +
      '<td class="n">' + cdMoney(cdBilled(r)) + '</td><td class="n">' + cdMoney(r.paid) + '</td><td class="n" style="color:' + (r.balance > 0 ? 'var(--alert)' : r.balance < 0 ? 'var(--bank)' : 'inherit') + '">' + cdMoney(r.balance) + '</td><td>' + cdTag(r) + '</td>' + act + '</tr>';
  }).join('');
  const table = rows.length ? '<div class="cd-wrap"><table class="cd-tbl"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>'
    : '<div class="cd-wrap"><div class="cd-empty">' + (cd.rows.length ? 'No student matches these filters.' : esc(c.name) + ' has no students yet.') + '</div></div>';
  const note = admin && !streams.length ? '' : '';
  return tiles + warn + bar + sel + table + note + '<div id="cdPrint"></div>';
}

/* ---------- streams tab ---------- */
function cdStreamsHtml(c) {
  const admin = cdIsAdmin();
  const rows = c.streams.map(function (s) {
    return '<div class="cd-srow"><span class="nm">' + esc(s.name) + '</span><span class="ct">' + s.student_count + ' student' + (s.student_count === 1 ? '' : 's') + '</span>' +
      '<button type="button" class="cd-link" onclick="cdOpenStream(' + s.id + ')">See students</button>' +
      (admin ? '<button type="button" class="cd-link" onclick="cdRename(' + s.id + ')">Rename</button>' +
        '<button type="button" class="cd-link" ' + (s.student_count ? 'disabled style="opacity:.4;cursor:not-allowed;text-decoration:none" title="Move the students out first"' : 'style="color:var(--alert)"') + ' onclick="cdRemove(' + s.id + ')">Remove</button>' : '') + '</div>';
  }).join('');
  const none = '<div class="cd-srow"><span class="ct">' + (admin ? 'No streams yet. Add one if ' + esc(c.name) + ' has more than one group.' : 'No streams.') + '</span></div>';
  const merge = admin && c.streams.length > 1 ? '<details class="cd-more"><summary>More</summary><div class="cd-card"><b style="font-size:14px">Merge two streams</b>' +
    '<p>Everyone in the first stream moves into the second one, and the first stream is removed. This is rare, so it is tucked away here.</p>' +
    '<div class="cd-bar"><select class="cls-in" id="cdMFrom" aria-label="Stream to merge">' + c.streams.map(function (s) { return '<option value="' + s.id + '">' + esc(s.name) + '</option>'; }).join('') + '</select>' +
    '<span>into</span><select class="cls-in" id="cdMInto" aria-label="Merge into">' + c.streams.map(function (s, i) { return '<option value="' + s.id + '"' + (i === 1 ? ' selected' : '') + '>' + esc(s.name) + '</option>'; }).join('') + '</select>' +
    '<button type="button" class="cls-btn sm" onclick="cdMerge()">Merge&hellip;</button></div></div></details>' : '';
  return '<div class="cd-card">' + (rows || none) + '</div>' + (admin ? '<button type="button" class="cls-btn" onclick="cdAddStream()">+ Add stream</button>' : '') + merge +
    '<p class="sub" style="margin-top:14px">Students stay in their class. Moving a student to another class is done in Promotion &amp; transfers.</p>';
}

/* ---------- actions ---------- */
window.cdTab = function (t) { cd.tab = t; clsRender(); };
window.cdSearch = function (v) {                                   // redraw only the table area so typing keeps its focus
  cd.q = v; const keep = document.activeElement && document.activeElement.type === 'search'; const pos = keep ? document.activeElement.selectionStart : 0;
  clsRender(); const i = document.querySelector('.cd-bar input[type=search]'); if (i && keep) { i.focus(); i.setSelectionRange(pos, pos); }
};
window.cdStatus = function (k) { cd.status = k; clsRender(); };
window.cdStream = function (v) { cd.stream = v; cd.picked = new Set(); clsRender(); };
window.cdTerm = function (v) { cd.termId = Number(v); cd.rows = null; clsRender(); cdLoad(); };
window.cdOpenStream = function (id) { cd.stream = String(id); cd.tab = 'students'; clsRender(); };
window.cdPick = function (id, on) { if (on) cd.picked.add(id); else cd.picked.delete(id); clsRender(); };
window.cdPickAll = function (on) { cdFiltered(false).forEach(function (r) { if (on) cd.picked.add(r.id); else cd.picked.delete(r.id); }); clsRender(); };
window.cdClear = function () { cd.picked = new Set(); clsRender(); };

// move one student (id given) or everyone ticked
window.cdMove = async function (oneId) {
  const ids = oneId ? [oneId] : Array.from(cd.picked);
  const people = (cd.rows || []).filter(function (r) { return ids.indexOf(r.id) !== -1; });
  if (!people.length) return;
  const here = people.length === 1 ? people[0].stream_id : null;
  const opts = cdStreams().filter(function (s) { return s.id !== here; }).map(function (s) { return [s.id, s.name]; });
  if (!opts.length) { stToast('There is no other stream to move to.', true); return; }
  const r = await stDialog({
    title: people.length === 1 ? (people[0].stream_id ? 'Move ' + people[0].full_name : 'Put ' + people[0].full_name + ' in a stream') : 'Move ' + people.length + ' students',
    intro: 'Pick the stream. They stay in ' + esc(cdClass().name) + '. Their fees and balances do not change.',
    fields: [{ id: 'sid', label: 'Stream', type: 'select', options: opts, value: opts[0][0] }], okText: 'Move',
    run: function (v) { return Api.post(clsBase() + '/streams/' + v.sid + '/move-students', { admission_nos: people.map(function (p) { return p.admission_no; }) }); },
  });
  if (!r) return;
  stToast('Moved ' + (r.moved === 1 ? '1 student' : r.moved + ' students') + '.'); cd.picked = new Set(); await cdReload();
};

window.cdAddStream = async function () {
  const c = cdClass();
  const r = await stDialog({ title: 'Add a stream to ' + c.name, intro: 'For example North, East or A.', fields: [{ id: 'name', label: 'Stream name' }], okText: 'Add stream',
    run: function (v) { if (!v.name.trim()) throw new Error('Type a stream name first.'); return Api.post(clsBase() + '/classes/' + c.id + '/streams', { name: v.name.trim() }); } });
  if (!r) return; stToast('Stream added.'); await cdReload();
};
window.cdRename = async function (id) {
  const s = cdStreams().find(function (x) { return x.id === id; });
  const r = await stDialog({ title: 'Rename ' + s.name, intro: 'The students stay in the stream.', fields: [{ id: 'name', label: 'New name', value: s.name }], okText: 'Rename',
    run: function (v) { return Api.put(clsBase() + '/streams/' + id, { name: v.name.trim() }); } });
  if (!r) return; stToast(r.unchanged ? 'The name is already ' + r.name + '.' : 'Renamed to ' + r.name + '.'); await cdReload();
};
window.cdRemove = async function (id) {
  const s = cdStreams().find(function (x) { return x.id === id; }); if (!s || s.student_count) return;
  const r = await stDialog({ title: 'Remove ' + s.name + '?', intro: 'The stream is empty, so nothing else changes.', okText: 'Remove', danger: true, run: function () { return Api.request('DELETE', clsBase() + '/streams/' + id); } });
  if (!r) return; stToast('Stream removed.'); if (String(cd.stream) === String(id)) cd.stream = ''; await cdReload();
};
window.cdMerge = async function () {
  const from = Number(document.getElementById('cdMFrom').value), into = Number(document.getElementById('cdMInto').value);
  if (from === into) { stToast('Pick two different streams.', true); return; }
  const a = cdStreams().find(function (s) { return s.id === from; }), b = cdStreams().find(function (s) { return s.id === into; });
  const r = await stDialog({ title: 'Merge ' + a.name + ' into ' + b.name + '?', intro: 'All ' + a.student_count + ' student' + (a.student_count === 1 ? '' : 's') + ' in ' + esc(a.name) + ' move into ' + esc(b.name) + ', and ' + esc(a.name) + ' is removed. Their fees do not change.',
    okText: 'Yes, merge', danger: true, run: function () { return Api.post(clsBase() + '/streams/' + from + '/merge', { into_stream_id: into }); } });
  if (!r) return; stToast('Merged: ' + r.moved + ' student' + (r.moved === 1 ? '' : 's') + ' moved.'); cd.stream = ''; await cdReload();
};

/* ---------- CSV and print: exactly what the filters show ---------- */
function cdFileName(ext) {
  const c = cdClass(), term = cd.data && cd.data.term ? cd.data.term.label : '';
  return [c.name, cdStreamLabel(), cd.status !== 'all' ? cd.status : '', term].filter(Boolean).join(' ').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.' + ext;
}
const cdCell = function (v) {
  let s = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s) && isNaN(Number(s))) s = "'" + s;                  // a name can not run as a spreadsheet formula
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
window.cdCsv = function () {
  const c = cdClass(), rows = cdFiltered(false), term = cd.data && cd.data.term ? cd.data.term.label : '';
  const lines = [['Admission no', 'Name', 'Class', 'Stream', 'Term', 'Billed', 'Paid', 'Balance', 'Status', 'Guardian', 'Guardian phone']];
  rows.forEach(function (r) { lines.push([r.admission_no, r.full_name, c.name, r.stream || '', term, cdBilled(r), r.paid, r.balance, cdTagText(r), r.guardian_name || '', r.guardian_phone || '']); });
  const csv = '﻿' + lines.map(function (l) { return l.map(cdCell).join(','); }).join('\r\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); a.download = cdFileName('csv');
  document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  stToast('Downloaded ' + rows.length + ' student' + (rows.length === 1 ? '' : 's') + '.');
};
window.cdPrint = function () {
  const c = cdClass(), rows = cdFiltered(false), sums = cdSums(rows), sc = live.school || {};
  const term = cd.data && cd.data.term ? cd.data.term.label : '';
  const printed = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Nairobi' });
  const what = [c.name, cdStreamLabel(), term, cd.status === 'owing' ? 'owing only' : cd.status === 'paid' ? 'paid up only' : cd.status === 'not_billed' ? 'not billed only' : ''].filter(Boolean).join(' · ');
  const hasSt = c.streams.length > 0;
  const box = document.getElementById('cdPrint'); if (!box) return;
  box.innerHTML = '<div style="display:flex;gap:10px;align-items:center;border-bottom:2px solid #111;padding-bottom:8px">' + shellLogo(44, sc.name ? sc : { name: 'School' }) +
    '<div><b style="font-size:16px">' + esc(sc.name || '') + '</b>' + (sc.motto ? '<br><i style="font-size:11px">' + esc(sc.motto) + '</i>' : '') + '</div></div>' +
    '<div style="margin-top:8px"><b>Class list</b> &middot; ' + esc(what) + '<br><span style="color:#555">Printed ' + esc(printed) + '</span></div>' +
    '<table><thead><tr><th>#</th><th>Adm no.</th><th>Name</th>' + (hasSt ? '<th>Stream</th>' : '') + '<th class="n">Billed</th><th class="n">Paid</th><th class="n">Balance</th><th>Status</th></tr></thead><tbody>' +
    rows.map(function (r, i) { return '<tr><td>' + (i + 1) + '</td><td>' + esc(r.admission_no) + '</td><td>' + esc(r.full_name) + '</td>' + (hasSt ? '<td>' + esc(r.stream || '-') + '</td>' : '') +
      '<td class="n">' + cdMoney(cdBilled(r)) + '</td><td class="n">' + cdMoney(r.paid) + '</td><td class="n">' + cdMoney(r.balance) + '</td><td>' + cdTagText(r) + '</td></tr>'; }).join('') +
    '</tbody><tfoot><tr><td></td><td></td><td>' + sums.n + ' students</td>' + (hasSt ? '<td></td>' : '') + '<td class="n">' + cdMoney(sums.billed) + '</td><td class="n">' + cdMoney(sums.paid) + '</td><td class="n">' + cdMoney(sums.owed) + ' owed</td><td></td></tr></tfoot></table>';
  document.body.classList.add('cd-printing');
  const done = function () { document.body.classList.remove('cd-printing'); box.innerHTML = ''; window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done); setTimeout(function () { window.print(); }, 50);
};