/* page-activity.js - the ACTIVITY LOG page (real). Replaces the old demo screen.
   - Every important thing anyone does is written to the log by the server, with who did it and when. Nobody can edit or delete a line.
   - Newest first, grouped by day, in plain words ("Ann Bursar recorded KES 5,000 for Amina Wanjiru"). Scrolls on as you reach the bottom.
   - Search a person or student, filter by person, by kind (Money / Students / Fees & terms / Staff & access / Setup / Sign-ins) and by date.
   - Sign-ins are hidden until you press "Show sign-ins". Wrong passwords and lockouts always show (Staff & access).
   - Admins only. Endpoint: GET /schools/:id/activity   (src/routes/activityRoutes.js)
   Add to index.html AFTER page-staff.js:  <script src="js/page-activity.js"></script> */

const al = { rows: [], next: null, people: [], groups: [], loading: false, error: null, token: 0, timer: null, ready: false,
  f: { q: '', staffId: '', group: '', range: '7d', from: '', to: '', signIns: false } };
const AL_TZ = 'Africa/Nairobi';

(function () {
  if (document.getElementById('alStyle')) return;
  const css = document.createElement('style');
  css.id = 'alStyle';
  css.textContent = [
    '.al-bar{background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:14px 16px;margin:0 0 18px}',
    '.al-top{display:flex;gap:10px;flex-wrap:wrap}',
    '.al-in{font:inherit;font-size:14px;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:22px;padding:9px 15px;box-sizing:border-box;min-width:130px;flex:1}',
    '.al-in.search{flex:3;min-width:220px}',
    '.al-in:focus{outline:none;border-color:var(--matched)}',
    '.al-chips{display:flex;gap:7px;flex-wrap:wrap;margin-top:12px;align-items:center}',
    '.al-chip{font:inherit;font-size:13px;border:1px solid var(--line);border-radius:20px;padding:6px 14px;cursor:pointer;background:transparent;color:var(--ink);display:inline-flex;gap:7px;align-items:center}',
    '.al-chip:hover{border-color:var(--muted)}',
    '.al-chip.on{border-color:var(--matched);background:rgba(89,179,125,.13)}',
    '.al-chip i{width:8px;height:8px;border-radius:50%;display:inline-block}',
    '.al-chip.sep{margin-left:auto;border-style:dashed;color:var(--muted)}',
    '.al-chip.sep.on{color:var(--ink);border-style:solid}',
    '.al-day{font-family:"Space Grotesk",sans-serif;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:22px 4px 10px;display:flex;align-items:center;gap:12px}',
    '.al-day:after{content:"";flex:1;height:1px;background:var(--line)}',
    '.al-ev{display:grid;grid-template-columns:40px minmax(0,1fr) auto;gap:14px;align-items:start;background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:12px 15px;margin:0 0 8px;transition:border-color .15s,transform .15s}',
    '.al-ev:hover{border-color:var(--muted)}',
    '.al-ev.bad{border-left:3px solid var(--alert)}',
    '.al-ic{width:38px;height:38px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--c) 16%,transparent);color:var(--c)}',
    '.al-ic svg{width:19px;height:19px;stroke:currentColor;fill:none;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}',
    '.al-t{font-size:14px;line-height:1.5;overflow-wrap:anywhere}',
    '.al-t b{font-weight:600}',
    '.al-role{font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);border:1px solid var(--line);border-radius:20px;padding:1px 7px;margin:0 6px 0 2px;vertical-align:1px}',
    '.al-x{font-size:12.5px;color:var(--muted);margin-top:3px;overflow-wrap:anywhere;line-height:1.5}',
    '.al-r{text-align:right;font-size:12.5px;color:var(--muted);white-space:nowrap}',
    '.al-r a{display:block;margin-top:4px;color:var(--matched);cursor:pointer;text-decoration:none;font-size:12px}',
    '.al-r a:hover{text-decoration:underline}',
    '.al-more{text-align:center;margin:18px 0 30px;font-size:13px;color:var(--muted)}',
    '.al-btn{font:inherit;font-size:13px;font-weight:600;border-radius:10px;padding:8px 18px;cursor:pointer;border:1px solid var(--line);background:transparent;color:var(--ink)}',
    '.al-btn:hover{border-color:var(--muted)}',
    '.al-empty{text-align:center;padding:48px 20px;background:var(--surface);border:1px dashed var(--line);border-radius:16px;color:var(--muted);font-size:13.5px;line-height:1.6}',
    '@media(max-width:620px){.al-ev{grid-template-columns:34px minmax(0,1fr);gap:11px}.al-ev .al-r{grid-column:2;text-align:left}.al-ic{width:34px;height:34px}.al-chip.sep{margin-left:0}}',
  ].join('\n');
  document.head.appendChild(css);
})();

const alEl = function (id) { return document.getElementById(id); };
const alBase = function () { return '/schools/' + live.staff.school_id; };
const AL_COLOR = { money: 'var(--matched)', students: 'var(--bank)', fees: 'var(--cash)', staff: 'var(--sibling)', setup: 'var(--repeat)', signins: 'var(--muted)' };
const AL_ICON = {
  money: '<circle cx="12" cy="12" r="9"/><path d="M12 7v10M9.5 9.5c0-1 1.1-1.7 2.5-1.7s2.5.7 2.5 1.7-1.1 1.5-2.5 1.8-2.5.8-2.5 1.8 1.1 1.7 2.5 1.7 2.5-.7 2.5-1.7"/>',
  students: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6"/>',
  fees: '<path d="M4 7h16M4 12h16M4 17h10"/><circle cx="18" cy="17" r="2"/>',
  staff: '<path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6z"/><path d="M9.5 12l2 2 3.5-4"/>',
  setup: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>',
  signins: '<path d="M10 4H5v16h5M14 8l4 4-4 4M18 12H9"/>',
};

views.auditlog = function () {
  if (live.staff && live.staff.role === 'staff') return '<div class="topbar"><div><h1>Activity log</h1></div></div><div class="al-empty">Only Admins can see the activity log.</div>';
  al.rows = []; al.next = null; al.error = null; al.ready = false;
  setTimeout(function () { alInit(); alLoad(false); }, 0);
  return '<div class="topbar"><div><h1>Activity log</h1><p class="sub">Everything important that happens, who did it and when. Nobody can change or delete a line.</p></div>' +
    '<button type="button" class="al-btn" onclick="alLoad(false)">Refresh</button></div>' +
    '<div class="al-bar"><div class="al-top"><input id="alQ" class="al-in search" type="search" placeholder="Search a person, student or receipt" aria-label="Search" oninput="alSearch(this.value)">' +
    '<select id="alWho" class="al-in" aria-label="Person" onchange="alSet(\'staffId\',this.value)"><option value="">Everyone</option></select>' +
    '<select id="alRange" class="al-in" aria-label="When" onchange="alSet(\'range\',this.value)">' +
    [['today', 'Today'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['term', 'This term'], ['custom', 'Pick dates...'], ['all', 'All time']].map(function (r) { return '<option value="' + r[0] + '"' + (al.f.range === r[0] ? ' selected' : '') + '>' + r[1] + '</option>'; }).join('') + '</select>' +
    '<span id="alDates" style="display:' + (al.f.range === 'custom' ? 'contents' : 'none') + '"><input id="alFrom" class="al-in" type="date" value="' + esc(al.f.from) + '" aria-label="From" onchange="alSet(\'from\',this.value)"><input id="alTo" class="al-in" type="date" value="' + esc(al.f.to) + '" aria-label="To" onchange="alSet(\'to\',this.value)"></span></div>' +
    '<div class="al-chips" id="alChips"></div></div><div id="alList"></div>';
};

function alInit() {
  const q = alEl('alQ'); if (q) q.value = al.f.q;
  alChips();
}
function alChips() {
  const box = alEl('alChips'); if (!box) return;
  const gs = al.groups.length ? al.groups.filter(function (g) { return g.key !== 'signins'; }) : [['money', 'Money'], ['students', 'Students'], ['fees', 'Fees & terms'], ['staff', 'Staff & access'], ['setup', 'Setup']].map(function (g) { return { key: g[0], label: g[1] }; });
  box.innerHTML = '<button type="button" class="al-chip' + (!al.f.group ? ' on' : '') + '" onclick="alSet(\'group\',\'\')">Everything</button>' +
    gs.map(function (g) { return '<button type="button" class="al-chip' + (al.f.group === g.key ? ' on' : '') + '" onclick="alSet(\'group\',\'' + g.key + '\')"><i style="background:' + AL_COLOR[g.key] + '"></i>' + esc(g.label) + '</button>'; }).join('') +
    '<button type="button" class="al-chip sep' + (al.f.signIns || al.f.group === 'signins' ? ' on' : '') + '" onclick="alToggleSignIns()"><i style="background:' + AL_COLOR.signins + '"></i>' + (al.f.signIns || al.f.group === 'signins' ? 'Sign-ins shown' : 'Show sign-ins') + '</button>';
}
function alWhoOptions() {
  const sel = alEl('alWho'); if (!sel) return;
  sel.innerHTML = '<option value="">Everyone</option>' + al.people.map(function (p) { return '<option value="' + p.id + '"' + (String(al.f.staffId) === String(p.id) ? ' selected' : '') + '>' + esc(p.name) + '</option>'; }).join('');
}
function alQuery(before) {
  const f = al.f, p = [];
  const add = function (k, v) { if (v !== '' && v !== null && v !== undefined && v !== false) p.push(k + '=' + encodeURIComponent(v)); };
  add('q', f.q); add('staff_id', f.staffId); add('group', f.group); add('range', f.range);
  if (f.range === 'custom') { add('from', f.from); add('to', f.to); }
  add('sign_ins', f.signIns ? '1' : ''); add('before', before);
  return p.join('&');
}
async function alLoad(append) {
  if (!alEl('alList') || !live.staff) return;
  if (al.loading && append) return;
  const token = ++al.token; al.loading = true;
  if (!append) { al.error = null; al.rows = al.ready ? al.rows : []; }
  alRender();
  try {
    const d = await Api.get(alBase() + '/activity?' + alQuery(append ? al.next : ''));
    if (token !== al.token) return;
    al.rows = append ? al.rows.concat(d.rows) : d.rows; al.next = d.next;
    if (!al.people.length || !append) { al.people = d.people; al.groups = d.groups; alWhoOptions(); alChips(); }
    al.ready = true; al.error = null;
  } catch (e) { if (token !== al.token) return; al.error = e.message; if (!append) al.rows = []; }
  al.loading = false;
  alRender();
}
function alSet(k, v) {
  al.f[k] = v;
  if (k === 'range') { const d = alEl('alDates'); if (d) d.style.display = v === 'custom' ? 'contents' : 'none'; }
  if (k === 'group' && v === 'signins') al.f.signIns = true;
  al.ready = false; alChips(); alLoad(false);
}
function alToggleSignIns() {
  if (al.f.group === 'signins') { al.f.group = ''; al.f.signIns = false; } else al.f.signIns = !al.f.signIns;
  al.ready = false; alChips(); alLoad(false);
}
function alSearch(v) { clearTimeout(al.timer); al.timer = setTimeout(function () { al.f.q = v.trim(); al.ready = false; alLoad(false); }, 300); }

const alDayKey = function (iso) { return new Date(iso).toLocaleDateString('en-CA', { timeZone: AL_TZ }); };
function alDayLabel(key) {
  const today = alDayKey(new Date().toISOString());
  const y = alDayKey(new Date(Date.now() - 864e5).toISOString());
  if (key === today) return 'Today';
  if (key === y) return 'Yesterday';
  return new Date(key + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
const alTime = function (iso) { return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: AL_TZ }); };
const alFull = function (iso) { return new Date(iso).toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'medium', timeZone: AL_TZ }); };

function alEvent(r) {
  const c = AL_COLOR[r.group] || 'var(--muted)';
  const role = r.who.label ? '<span class="al-role">' + esc(r.who.label) + '</span>' : '';
  const text = r.who.id ? '<b>' + esc(r.who.name) + '</b>' + role + esc(r.text) : (r.who.name === 'System' ? '<b>System</b> ' + esc(r.text) : '<b>' + esc(r.who.name) + '</b> ' + esc(r.text));
  return '<div class="al-ev' + (r.tone === 'bad' ? ' bad' : '') + '"><div class="al-ic" style="--c:' + c + '"><svg viewBox="0 0 24 24" aria-hidden="true">' + (AL_ICON[r.group] || AL_ICON.setup) + '</svg></div>' +
    '<div><div class="al-t">' + text + '</div>' + (r.extra ? '<div class="al-x">' + esc(r.extra) + '</div>' : '') + '</div>' +
    '<div class="al-r" title="' + esc(alFull(r.when) + (r.ip ? ' - from ' + r.ip : '')) + '">' + esc(alTime(r.when)) + (r.student_id ? '<a onclick="ssOpen(' + r.student_id + ')">View student &rarr;</a>' : '') + '</div></div>';
}
let alObserver = null;
function alRender() {
  const box = alEl('alList'); if (!box) return;
  if (alObserver) { alObserver.disconnect(); alObserver = null; }
  if (al.error) { box.innerHTML = '<div class="al-empty"><b>Could not load the activity log</b><br>' + esc(al.error) + '<br><br><button type="button" class="al-btn" onclick="alLoad(false)">Try again</button></div>'; return; }
  if (!al.rows.length) { box.innerHTML = '<div class="al-empty">' + (al.loading ? 'Loading...' : 'Nothing found for these filters.' + (al.f.range !== 'all' ? '<br>Try a longer time range.' : '')) + '</div>'; return; }
  let html = '', day = '';
  al.rows.forEach(function (r) {
    const k = alDayKey(r.when);
    if (k !== day) { day = k; html += '<div class="al-day">' + esc(alDayLabel(k)) + '</div>'; }
    html += alEvent(r);
  });
  html += '<div class="al-more" id="alMore">' + (al.next ? (al.loading ? 'Loading more...' : '<button type="button" class="al-btn" onclick="alLoad(true)">Load more</button>') : 'That is everything for these filters (' + al.rows.length + ').') + '</div>';
  box.innerHTML = html;
  if (al.next && !al.loading && 'IntersectionObserver' in window) {
    const m = alEl('alMore');
    alObserver = new IntersectionObserver(function (es) { if (es[0].isIntersecting) { alObserver.disconnect(); alLoad(true); } }, { rootMargin: '300px' });
    if (m) alObserver.observe(m);
  }
}