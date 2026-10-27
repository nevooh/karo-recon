/* shell.js - the frame around every page.
   - A foldable sidebar (icons only when folded). Your choice is remembered; it also folds by itself while a student sheet is open.
   - The sidebar shows the REAL school term and the logged-in person's name (before, these were fixed demo text).
   - The dashboard refreshes itself when you open it and once a minute while you stay on it, so new payments appear without a reload.
   Add to index.html LAST:  <script src="js/shell.js"></script> */

const shell = { folded: false, auto: false, timer: null };

(function () {
  if (document.getElementById('shellStyle')) return;
  const css = document.createElement('style');
  css.id = 'shellStyle';
  css.textContent = [
    '.app{transition:grid-template-columns .2s ease}',
    '.fold-btn{float:right;font:inherit;font-size:11px;background:transparent;border:1px solid var(--line);border-radius:8px;width:26px;height:26px;cursor:pointer;color:var(--muted);margin:2px 0 0 6px}',
    '.fold-btn:hover{color:var(--ink);border-color:var(--muted)}',
    '.app.folded{grid-template-columns:64px 1fr}',
    '.app.folded .sidebar{overflow-x:hidden}',
    '.app.folded .brand{padding:0 0 14px;text-align:center}',
    '.app.folded .brand .brand-name,.app.folded .brand span{display:none}',
    '.app.folded .fold-btn{float:none;display:inline-block;margin:0;transform:rotate(180deg)}',
    '.app.folded .navsec{font-size:0;padding:8px 0 2px;border-top:1px solid var(--line);margin:6px 10px 0}',
    '.app.folded .nav{font-size:0;justify-content:center;padding:11px 0;gap:0}',
    '.app.folded .nav .ic{font-size:16px;width:auto}',
    '.app.folded .sidebar-foot{padding:12px 6px 0;text-align:center}',
    '.app.folded .term-badge{font-size:9px;padding:5px 2px;display:block}',
    '.app.folded .term-badge .live{display:none}',
    '.app.folded .who-row{justify-content:center}',
    '.app.folded #sidebarName,.app.folded .logout-link{display:none}',
    '.brand-logo{display:none;margin:0 0 8px}.brand-logo.on{display:block}',
    '.app.folded .brand-logo{margin:8px auto 10px}',
    '.brand-name{display:block;line-height:1.2;overflow-wrap:anywhere}',
    '@media(max-width:880px){.fold-btn{display:none}}',
  ].join('\n');
  document.head.appendChild(css);
})();

/* The school's logo, or a coloured circle with its initials when there is none. px = size. */
function shellLogo(px, school) {
  const sc = school || live.school || {}; const name = sc.name || 'School';
  const size = 'width:' + px + 'px;height:' + px + 'px;';
  if (sc.logo) return '<img src="' + sc.logo + '" alt="" style="' + size + 'object-fit:contain;border-radius:' + Math.round(px / 5) + 'px;display:block;background:#fff">';
  let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  const ini = name.split(/\s+/).filter(Boolean).slice(0, 2).map(function (w) { return w[0].toUpperCase(); }).join('');
  return '<div style="' + size + 'border-radius:50%;background:hsl(' + h + ',45%,38%);color:#fff;display:flex;align-items:center;justify-content:center;font:700 ' + Math.round(px * 0.4) + 'px \'Space Grotesk\',sans-serif">' + esc(ini) + '</div>';
}
// reads the school profile (name, logo, ...) and puts it in the sidebar; settings calls this again after a save
async function shellSchool(fresh) {
  if (!live.staff) return;
  try { live.school = fresh || await Api.get('/schools/' + live.staff.school_id + '/profile'); } catch (e) { return; }
  const l = document.getElementById('brandLogo'), n = document.getElementById('brandName'), sub = document.getElementById('brandSub');
  if (l) { l.innerHTML = shellLogo(40); l.classList.add('on'); }
  if (n) n.textContent = live.school.name;
  if (sub) sub.textContent = 'Karo Recon';
}
function shellApp() { return document.getElementById('mainApp'); }
function shellSetFold(on, remember) {
  shell.folded = !!on;
  const a = shellApp(); if (a) a.classList.toggle('folded', shell.folded);
  const b = document.getElementById('foldBtn'); if (b) { b.title = shell.folded ? 'Open the menu' : 'Fold the menu'; b.setAttribute('aria-label', b.title); }
  if (remember) { try { localStorage.setItem('karo_menu_folded', shell.folded ? '1' : '0'); } catch (e) { /* private window: not remembered */ } }
}
function shellToggleFold() { shellSetFold(!shell.folded, true); }
// used by the student sheet: fold while it is open, then put the menu back the way the person had it
function shellFoldForSheet(open) {
  if (open) { if (!shell.auto) { shell.auto = true; shell.before = shell.folded; shellSetFold(true, false); } }
  else if (shell.auto) { shell.auto = false; shellSetFold(shell.before, false); }
}

function shellLabelNav() {                                     // hover names for the icons when the menu is folded
  document.querySelectorAll('.sidebar .nav').forEach(function (n) { n.title = n.textContent.replace(/\s+/g, ' ').trim(); });
}
function shellWho() {
  if (!live.staff) return;
  const name = live.staff.full_name || '';
  const n = document.getElementById('sidebarName'); if (n) n.textContent = name;
  const a = document.getElementById('sidebarAvatar'); if (a) a.textContent = name.split(/\s+/).filter(Boolean).slice(0, 2).map(function (w) { return w[0].toUpperCase(); }).join('');
}
async function shellTerm() {
  const text = document.getElementById('termBadgeText'), state = document.getElementById('termBadgeState'), mob = document.getElementById('termBadgeMobile');
  if (!live.staff || !text) return;
  try {
    const d = await Api.get('/schools/' + live.staff.school_id + '/terms');
    let cur = null;
    d.years.forEach(function (y) { y.terms.forEach(function (t) { if (t.paymentsGoHere) cur = { year: y.year, term: t.term, state: t.state }; }); });
    if (!cur) { text.textContent = 'No term yet'; state.textContent = ''; if (mob) mob.textContent = 'No term'; return; }
    text.textContent = cur.year + ' · Term ' + cur.term;
    state.textContent = cur.state === 'running' ? '● running' : '○ holiday';
    state.style.color = cur.state === 'running' ? 'var(--matched)' : 'var(--muted)';
    if (mob) mob.textContent = 'T' + cur.term;
  } catch (e) { /* the badge just stays as it was */ }
}

/* every time the app is entered */
const shellEnterApp = enterApp;
enterApp = function () {
  shellEnterApp();
  try { shellSetFold(localStorage.getItem('karo_menu_folded') === '1', false); } catch (e) { shellSetFold(false, false); }
  shellLabelNav(); shellWho(); shellTerm(); shellSchool();
};

/* the dashboard shows fresh numbers when opened, and keeps itself fresh while you stay on it */
const shellShowView = showView;
showView = function (name) {
  shellShowView(name);
  clearInterval(shell.timer); shell.timer = null;
  if (name === 'dashboard') {
    shellRefreshDashboard(name);
    shell.timer = setInterval(function () { if (!document.hidden) shellRefreshDashboard('dashboard'); }, 60000);
  }
  if (name === 'terms' || name === 'dashboard') shellTerm();
};
async function shellRefreshDashboard(name) {
  try {
    await loadLiveData();
    const active = document.querySelector('.nav.active');
    if (active && active.dataset.view === name && !document.querySelector('#ssSheet')) shellShowViewQuiet(name);
  } catch (e) { /* a failed refresh keeps what is on screen; an expired login is handled in Api */ }
}
function shellShowViewQuiet(name) {                             // redraw without scrolling to the top or restarting the timer
  const y = window.scrollY;
  document.getElementById('main').innerHTML = views[name]();
  window.scrollTo(0, y);
}

window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && typeof ssClose === 'function' && document.getElementById('ssSheet')) ssClose(); });

// the app can already be showing (a page refresh while logged in) before this file ran
setTimeout(function () {
  const a = shellApp();
  if (a && a.style.display !== 'none' && live.staff) { try { shellSetFold(localStorage.getItem('karo_menu_folded') === '1', false); } catch (e) { shellSetFold(false, false); } shellLabelNav(); shellWho(); shellTerm(); }
}, 0);