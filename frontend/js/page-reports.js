/* page-reports.js - the REPORTS page (real). Replaces the old demo screen.
   For ONE term at a time (the newest term that has figures, or pick another):
   - Tiles: billed, collected, outstanding, collection rate.   - Collection by term (click a term to switch).
   - Where the money came from (M-Pesa, banks, recorded by hand).   - Money in over the term (per day, or per week for a full term).
   - Arrears by class (click a class to see those students).   - Biggest arrears (click a name to open the sheet).   - Needs attention.
   Terms from before the school started using Karo (no billing, no payments) are not shown at all.
   Admins only. "Print" gives a clean black-on-white page (save it as PDF from the print window).
   Endpoint: GET /schools/:id/reports?term_id=   (src/routes/reportRoutes.js)
   Add to index.html AFTER page-activity.js:  <script src="js/page-reports.js"></script> */

const rp = { d: null, error: null, token: 0, termId: '' };

(function () {
  if (document.getElementById('rpStyle')) return;
  const css = document.createElement('style');
  css.id = 'rpStyle';
  css.textContent = [
    '.rp-ctl{display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
    '.rp-sel{font:inherit;font-size:14px;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:22px;padding:9px 15px}',
    '.rp-sel:focus{outline:none;border-color:var(--matched)}',
    '.rp-btn{font:inherit;font-size:13px;font-weight:600;border-radius:22px;padding:9px 18px;cursor:pointer;border:1px solid var(--line);background:transparent;color:var(--ink)}',
    '.rp-btn:hover{border-color:var(--muted)}',
    '.rp-tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin:16px 0 8px}',
    '.rp-tile{background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:18px 20px;min-width:0;position:relative;overflow:hidden}',
    '.rp-tile span{display:block;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}',
    '.rp-tile b{display:block;margin-top:8px;font-family:"IBM Plex Mono",monospace;font-size:23px;font-weight:600;overflow-wrap:anywhere}',
    '.rp-tile small{display:block;margin-top:6px;font-size:12px;color:var(--muted)}',
    '.rp-tile.good b{color:var(--matched)} .rp-tile.warn b{color:var(--alert)}',
    '.rp-tile:before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--c,var(--line))}',
    '.rp-note{font-size:12.5px;color:var(--muted);margin:0 2px 22px;line-height:1.6}',
    '.rp-grid{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:16px;margin:0 0 16px}',
    '.rp-card{background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:18px 20px;min-width:0;margin:0 0 16px}',
    '.rp-grid .rp-card{margin:0}',
    '.rp-card h2{font-family:"Space Grotesk",sans-serif;font-size:16px;margin:0 0 4px}',
    '.rp-card .rp-sub{font-size:12.5px;color:var(--muted);margin:0 0 14px}',
    '.rp-term{display:grid;grid-template-columns:110px minmax(0,1fr) 52px;gap:12px;align-items:center;padding:8px 0;cursor:pointer;border-radius:10px}',
    '.rp-term:hover{background:var(--surface-raised)}',
    '.rp-term.on .rp-tl{color:var(--matched);font-weight:600}',
    '.rp-tl{font-size:13px}',
    '.rp-bar{height:12px;border-radius:8px;background:var(--bg);overflow:hidden;border:1px solid var(--line)}',
    '.rp-bar i{display:block;height:100%;border-radius:8px}',
    '.rp-pct{font-family:"IBM Plex Mono",monospace;font-size:13px;text-align:right}',
    '.rp-nums{grid-column:2/4;font-size:12px;color:var(--muted);margin-top:-4px}',
    '.rp-stack{display:flex;height:22px;border-radius:12px;overflow:hidden;border:1px solid var(--line);background:var(--bg)}',
    '.rp-stack i{display:block;height:100%}',
    '.rp-leg{margin-top:14px;display:grid;gap:8px}',
    '.rp-leg div{display:flex;align-items:center;gap:9px;font-size:13px}',
    '.rp-leg i{width:10px;height:10px;border-radius:3px;flex:none}',
    '.rp-leg span{margin-left:auto;font-family:"IBM Plex Mono",monospace;font-size:12.5px;text-align:right}',
    '.rp-leg small{color:var(--muted);margin-left:6px}',
    '.rp-chart{display:flex;align-items:flex-end;gap:5px;height:150px;padding:0 2px;border-bottom:1px solid var(--line)}',
    '.rp-col{flex:1;min-width:3px;border-radius:5px 5px 0 0;background:var(--matched);opacity:.85;transition:opacity .15s}',
    '.rp-col:hover{opacity:1}',
    '.rp-axis{display:flex;justify-content:space-between;font-size:11.5px;color:var(--muted);margin-top:7px}',
    '.rp-tbl{width:100%;border-collapse:collapse}',
    '.rp-tbl th{font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);text-align:left;padding:6px 8px;font-weight:500}',
    '.rp-tbl td{padding:11px 8px;border-top:1px solid var(--line);font-size:13.5px;vertical-align:middle}',
    '.rp-tbl tr.go{cursor:pointer}',
    '.rp-tbl tr.go:hover td{background:var(--surface-raised)}',
    '.rp-tbl .r{text-align:right;font-family:"IBM Plex Mono",monospace}',
    '.rp-tbl .due{color:var(--alert)}',
    '.rp-mini{height:8px;border-radius:6px;background:var(--bg);border:1px solid var(--line);min-width:70px;overflow:hidden}',
    '.rp-mini i{display:block;height:100%}',
    '.rp-sub2{font-size:12px;color:var(--muted)}',
    '.rp-att{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}',
    '.rp-a{background:var(--bg);border:1px solid var(--line);border-radius:14px;padding:14px 16px;cursor:pointer;text-align:left;font:inherit;color:var(--ink)}',
    '.rp-a:hover{border-color:var(--muted)}',
    '.rp-a b{display:block;font-size:22px;font-family:"IBM Plex Mono",monospace}',
    '.rp-a span{font-size:12.5px;color:var(--muted);line-height:1.5}',
    '.rp-a.hot{border-color:var(--cash)}',
    '.rp-a.ok b{color:var(--matched)}',
    '.rp-empty{text-align:center;padding:48px 20px;background:var(--surface);border:1px dashed var(--line);border-radius:16px;color:var(--muted);font-size:13.5px;line-height:1.7}',
    '.rp-printhead{display:none}',
    '@media(max-width:900px){.rp-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}.rp-grid{grid-template-columns:1fr}.rp-grid .rp-card{margin:0 0 16px}.rp-att{grid-template-columns:1fr}}',
    '@media print{body.rp-printing *{visibility:hidden !important}body.rp-printing #main,body.rp-printing #main *{visibility:visible !important}',
    'body.rp-printing{background:#fff !important}body.rp-printing #main{position:absolute;left:0;top:0;width:100%;padding:0 10mm;background:#fff}',
    'body.rp-printing #main{--bg:#fff;--surface:#fff;--surface-raised:#f2f2f2;--ink:#111;--muted:#555;--line:#c9c9c9;--matched:#1f7a4d;--cash:#9a6b00;--alert:#b3261e;--bank:#2c5aa0;--sibling:#6a3d99;--repeat:#a35a1c;color:#111}',
    'body.rp-printing .rp-ctl,body.rp-printing .rp-a{display:none !important}body.rp-printing .rp-att{display:none}',
    'body.rp-printing .rp-printhead{display:block;margin:0 0 10px;border-bottom:2px solid #111;padding-bottom:8px}',
    'body.rp-printing .rp-printhead b{font-size:18px}body.rp-printing .rp-card,body.rp-printing .rp-tile{break-inside:avoid;border-color:#c9c9c9}}',
  ].join('\n');
  document.head.appendChild(css);
})();

const rpEl = function (id) { return document.getElementById(id); };
const rpBase = function () { return '/schools/' + live.staff.school_id; };
const rpMoney = function (n) { return money(Number(n) || 0); };
const rpColor = function (r) { return r === null ? 'var(--muted)' : (r >= 95 ? 'var(--matched)' : (r >= 75 ? 'var(--cash)' : 'var(--alert)')); };
const rpPct = function (r) { return r === null ? '-' : (Math.round(r) === r ? r : r.toFixed(1)) + '%'; };
const rpDay = function (s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); if (!m) return s || '';
  return Number(m[3]) + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m[2]) - 1];
};

views.reports = function () {
  if (live.staff && live.staff.role === 'staff') return '<div class="topbar"><div><h1>Reports</h1></div></div><div class="rp-empty">Only Admins can see the reports.</div>';
  rp.d = null; rp.error = null;
  setTimeout(function () { rpLoad(); }, 0);
  return '<div id="rpRoot">' + rpBody() + '</div>';
};
async function rpLoad() {
  const token = ++rp.token;
  try {
    const d = await Api.get(rpBase() + '/reports' + (rp.termId ? '?term_id=' + encodeURIComponent(rp.termId) : ''));
    if (token !== rp.token) return;
    rp.d = d; rp.error = null; if (d.term) rp.termId = String(d.term.id);
  } catch (e) { if (token !== rp.token) return; rp.error = e.message; rp.d = null; if (/no figures/.test(e.message)) rp.termId = ''; }
  rpRender();
}
function rpRender() { const r = rpEl('rpRoot'); if (r) r.innerHTML = rpBody(); }
function rpPick(id) { rp.termId = String(id); rp.d = null; rpRender(); rpLoad(); }

function rpPrint() {
  document.body.classList.add('rp-printing');
  const done = function () { document.body.classList.remove('rp-printing'); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  setTimeout(function () { try { window.print(); } catch (e) { done(); } if (!('onafterprint' in window)) setTimeout(done, 1500); }, 50);
}
function rpGoClass(classId) {
  if (typeof bl === 'undefined') return;
  bl.f.classId = String(classId); bl.f.streamId = ''; bl.f.status = 'owing'; bl.f.q = ''; bl.f.offset = 0; bl.f.termId = rp.d && rp.d.term ? String(rp.d.term.id) : '';
  showView('roster');
}
function rpGoStatus(status) {
  if (typeof bl === 'undefined') return;
  bl.f.classId = ''; bl.f.streamId = ''; bl.f.status = status; bl.f.q = ''; bl.f.offset = 0; bl.f.termId = rp.d && rp.d.term ? String(rp.d.term.id) : '';
  showView('roster');
}

function rpBody() {
  const head = function (sub, ctl) {
    return '<div class="topbar"><div><h1>Reports</h1><p class="sub">' + sub + '</p></div>' + (ctl || '') + '</div>';
  };
  if (rp.error) return head('How the school is doing on fees.') + '<div class="rp-empty"><b>Could not load the reports</b><br>' + esc(rp.error) + '<br><br><button type="button" class="rp-btn" onclick="rp.termId=\'\';rpLoad()">Try again</button></div>';
  const d = rp.d;
  if (!d) return head('How the school is doing on fees.') + '<div class="rp-empty">Loading...</div>';
  if (!d.term) return head('How the school is doing on fees.') + '<div class="rp-empty">No figures yet.<br>Reports appear once a term has been billed or a payment has been recorded.</div>';

  const t = d.tiles, term = d.term;
  const sel = '<div class="rp-ctl"><select class="rp-sel" aria-label="Term" onchange="rpPick(this.value)">' + d.terms.map(function (x) { return '<option value="' + x.id + '"' + (x.id === term.id ? ' selected' : '') + '>' + esc(x.label) + '</option>'; }).join('') + '</select>' +
    '<button type="button" class="rp-btn" onclick="rpPrint()">Print / Save as PDF</button></div>';
  const printed = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Nairobi' });
  const out = head(esc(term.label) + ' &middot; ' + esc(rpDay(term.start)) + ' to ' + esc(rpDay(term.end)), sel) +
    '<div class="rp-printhead"><div style="display:flex;gap:10px;align-items:center">' + (typeof shellLogo === 'function' ? shellLogo(44, live.school || d.school) : '') + '<div><b>' + esc(d.school.name) + '</b>' + ((live.school && live.school.motto) ? '<br><i style="font-size:12px">' + esc(live.school.motto) + '</i>' : '') + '</div></div><div style="margin-top:6px">Fee report &middot; ' + esc(term.label) + ' &middot; printed ' + esc(printed) + '</div></div>';

  const tiles = '<div class="rp-tiles">' +
    '<div class="rp-tile" style="--c:var(--bank)"><span>Billed</span><b>' + rpMoney(t.billed) + '</b><small>' + t.students_billed + ' students' + (t.brought_forward ? ' &middot; includes ' + rpMoney(t.brought_forward) + ' brought forward' : '') + '</small></div>' +
    '<div class="rp-tile good" style="--c:var(--matched)"><span>Collected</span><b>' + rpMoney(t.collected) + '</b><small>payments that were applied</small></div>' +
    '<div class="rp-tile' + (t.outstanding > 0 ? ' warn' : '') + '" style="--c:var(--alert)"><span>Outstanding</span><b>' + rpMoney(t.outstanding) + '</b><small>' + t.students_owing + ' students owing</small></div>' +
    '<div class="rp-tile" style="--c:' + rpColor(t.rate) + '"><span>Collection rate</span><b style="color:' + rpColor(t.rate) + '">' + rpPct(t.rate) + '</b><small>collected &divide; billed</small></div></div>' +
    '<p class="rp-note">' + (t.credit ? rpMoney(t.credit) + ' is paid ahead (credit), so it is not taken off what others owe. ' : '') + 'Students who have left are included, because their money is still the school\'s money.</p>';

  const termRows = d.byTerm.slice().reverse().map(function (x) {
    return '<div class="rp-term' + (x.id === term.id ? ' on' : '') + '" onclick="rpPick(' + x.id + ')"><div class="rp-tl">' + esc(x.label) + '</div><div class="rp-bar"><i style="width:' + Math.min(100, x.rate || 0) + '%;background:' + rpColor(x.rate) + '"></i></div><div class="rp-pct" style="color:' + rpColor(x.rate) + '">' + rpPct(x.rate) + '</div><div class="rp-nums">' + rpMoney(x.paid) + ' of ' + rpMoney(x.billed) + '</div></div>';
  }).join('');
  const SRC_COL = { mpesa: 'var(--mpesa)', bank: 'var(--bank)', manual: 'var(--cash)' };
  const shades = { mpesa: 0, bank: 0, manual: 0 };
  const srcTotal = d.sources.reduce(function (s, x) { return s + x.amount; }, 0);
  const src = d.sources.length ? '<div class="rp-stack">' + d.sources.map(function (x, i) { return '<i title="' + esc(x.name) + '" style="width:' + (x.amount / srcTotal * 100) + '%;background:' + SRC_COL[x.kind] + ';opacity:' + (1 - 0.18 * (shades[x.kind]++ % 4)) + '"></i>'; }).join('') + '</div>' +
    (function () { const sh = { mpesa: 0, bank: 0, manual: 0 }; return '<div class="rp-leg">' + d.sources.map(function (x) { return '<div><i style="background:' + SRC_COL[x.kind] + ';opacity:' + (1 - 0.18 * (sh[x.kind]++ % 4)) + '"></i>' + esc(x.name) + '<span>' + rpMoney(x.amount) + '<small>' + Math.round(x.amount / srcTotal * 100) + '%</small></span></div>'; }).join('') + '</div>'; })()
    : '<div class="rp-sub2">No payments in this term yet.</div>';
  const top = '<div class="rp-grid"><div class="rp-card"><h2>Collection by term</h2><p class="rp-sub">Click a term to look at it.</p>' + termRows + '</div>' +
    '<div class="rp-card"><h2>Where the money came from</h2><p class="rp-sub">' + rpMoney(srcTotal) + ' in ' + d.moneyIn.count + ' payments</p>' + src + '</div></div>';

  const ser = d.moneyIn.series, mx = Math.max.apply(null, ser.map(function (x) { return x.amount; }).concat([1]));
  const chart = ser.length
    ? '<div class="rp-chart" role="img" aria-label="Money received during the term">' + ser.map(function (x) { return '<div class="rp-col" style="height:' + Math.max(3, x.amount / mx * 100) + '%" title="' + esc((d.moneyIn.bucket === 'week' ? 'Week of ' : '') + rpDay(x.day) + ': ' + rpMoney(x.amount) + ' (' + x.count + ' payments)') + '"></div>'; }).join('') + '</div>' +
      '<div class="rp-axis"><span>' + esc((d.moneyIn.bucket === 'week' ? 'Week of ' : '') + rpDay(ser[0].day)) + '</span><span>Biggest ' + (d.moneyIn.bucket === 'week' ? 'week' : 'day') + ': ' + rpMoney(mx) + '</span><span>' + esc(rpDay(ser[ser.length - 1].day)) + '</span></div>'
    : '<div class="rp-sub2">No payments in this term yet.</div>';
  const inCard = '<div class="rp-card"><h2>Money in</h2><p class="rp-sub">Payments received, ' + (d.moneyIn.bucket === 'week' ? 'week by week' : 'day by day') + '. Hover a bar for the amount.</p>' + chart + '</div>';

  const cls = d.arrearsByClass.length
    ? '<table class="rp-tbl"><thead><tr><th>Class</th><th class="r">Owing</th><th class="r">Owed</th><th style="width:26%">Collected</th></tr></thead><tbody>' + d.arrearsByClass.map(function (x) {
      return '<tr class="go" onclick="rpGoClass(' + x.class_id + ')"><td>' + esc(x.class) + '</td><td class="r">' + x.students_owing + ' of ' + x.students + '</td><td class="r' + (x.owed > 0 ? ' due' : '') + '">' + rpMoney(x.owed) + '</td>' +
        '<td><div style="display:flex;gap:9px;align-items:center"><div class="rp-mini" style="flex:1"><i style="width:' + Math.min(100, x.rate || 0) + '%;background:' + rpColor(x.rate) + '"></i></div><span class="rp-sub2" style="min-width:40px;text-align:right">' + rpPct(x.rate) + '</span></div></td></tr>';
    }).join('') + '</tbody></table>' : '<div class="rp-sub2">No class has figures in this term.</div>';
  const clsCard = '<div class="rp-card"><h2>Arrears by class</h2><p class="rp-sub">Click a class to see the students who owe.</p>' + cls + '</div>';

  const tp = d.topArrears.length
    ? '<table class="rp-tbl"><thead><tr><th>Student</th><th>Class</th><th>Parent / guardian</th><th class="r">Owes</th></tr></thead><tbody>' + d.topArrears.map(function (x) {
      return '<tr class="go" onclick="ssOpen(' + x.id + ')"><td>' + esc(x.full_name) + (x.status !== 'active' ? ' <span class="rp-sub2">(' + esc(x.status) + ')</span>' : '') + '<div class="rp-sub2">' + esc(x.admission_no) + '</div></td><td>' + esc(x.class || '-') + (x.stream ? ' <span class="rp-sub2">' + esc(x.stream) + '</span>' : '') + '</td>' +
        '<td>' + (x.guardian_name ? esc(x.guardian_name) : '<span class="rp-sub2">-</span>') + (x.guardian_phone ? '<div class="rp-sub2">' + esc(x.guardian_phone) + '</div>' : '') + '</td><td class="r due">' + rpMoney(x.balance) + '</td></tr>';
    }).join('') + '</tbody></table>' : '<div class="rp-sub2">Nobody owes anything in this term.</div>';
  const topCard = '<div class="rp-card"><h2>Biggest arrears</h2><p class="rp-sub">The ten students who owe most. Click a name to open the sheet.</p>' + tp + '</div>';

  const a = d.attention;
  const att = '<div class="rp-card"><h2>Needs attention</h2><p class="rp-sub">Things somebody should look at.</p><div class="rp-att">' +
    '<button type="button" class="rp-a' + (a.review ? ' hot' : ' ok') + '" onclick="showView(\'reviewqueue\')"><b>' + a.review + '</b><span>payments waiting in the Review queue' + (a.review ? ' (' + rpMoney(a.review_amount) + ')' : '') + '</span></button>' +
    '<button type="button" class="rp-a' + (a.unmatched ? ' hot' : ' ok') + '" onclick="showView(\'reviewqueue\')"><b>' + a.unmatched + '</b><span>payments nobody could be matched to' + (a.unmatched ? ' (' + rpMoney(a.unmatched_amount) + ')' : '') + '</span></button>' +
    '<button type="button" class="rp-a' + (a.not_billed ? ' hot' : ' ok') + '" onclick="rpGoStatus(\'not_billed\')"><b>' + a.not_billed + '</b><span>active students not billed in this term</span></button></div></div>';

  return out + tiles + top + inCard + clsCard + topCard + att;
}