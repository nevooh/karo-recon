/* page-classes.js - the Classes & streams page, connected to the real database.
   - The page lists the classes this school runs, with this year's streams.
   - "Choose classes" opens a rounded sheet that slides in from the right, over the page.
     Switch classes on/off (or use a preset), then Save - or Cancel and nothing changes.
   - Classes that still have students cannot be switched off.
   - Click a class (or one of its streams) to open its FULL PAGE: page-class-detail.js (student list, balances, CSV/print,
     moving students between streams, and the Streams tab).
   - Promotion rules are no longer shown here: by default a stream name follows its students to the next class.
   - The page says where students graduate (the last class that is on) and warns about classes switched off in the middle.
   Add to index.html AFTER page-review.js:  <script src="js/page-classes.js"></script> */

const cls = { data: null, error: null, sheet: false, draft: new Set(), open: null };   // open = the class whose full page is showing (page-class-detail.js)

/* ---------------- styles (added once) ---------------- */
(function () {
  if (document.getElementById('clsStyle')) return;
  const css = document.createElement('style');
  css.id = 'clsStyle';
  css.textContent = [
    '.cls-stage{font-size:12.5px;color:var(--muted);margin:22px 0 8px}',
    '.cls-panel{background:var(--surface);border:1px solid var(--line);border-radius:12px;overflow:hidden}',
    '.cls-row{display:flex;align-items:center;gap:14px;padding:13px 18px;border-bottom:1px solid var(--line);flex-wrap:wrap}',
    '.cls-row:last-child{border-bottom:0}',
    '.cls-name{font-family:"Space Grotesk",sans-serif;font-weight:600;font-size:15px;min-width:92px}',
    '.cls-count{font-family:"IBM Plex Mono",monospace;font-size:12px;color:var(--muted);min-width:78px}',
    '.cls-streams{display:flex;gap:8px;flex-wrap:wrap;align-items:center;flex:1;min-width:200px}',
    '.cls-chip{display:inline-flex;align-items:center;gap:8px;background:var(--surface-raised);border:1px solid var(--line);border-radius:20px;padding:4px 6px 4px 12px;font-size:12.5px}',
    '.cls-chip b{font-family:"IBM Plex Mono",monospace;font-weight:500;color:var(--muted);font-size:11.5px}',
    '.cls-chip button{font:inherit;font-size:12px;line-height:1;width:20px;height:20px;border-radius:50%;border:0;background:transparent;color:var(--muted);cursor:pointer}',
    '.cls-chip button:hover:not(:disabled){background:rgba(226,87,76,.18);color:var(--alert)}',
    '.cls-chip button:disabled{opacity:.3;cursor:not-allowed}',
    '.cls-in{font:inherit;font-size:13px;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:7px 11px;min-width:0}',
    '.cls-in:focus{outline:none;border-color:var(--matched)}',
    '.cls-btn{font:inherit;font-size:13px;font-weight:600;border-radius:9px;padding:9px 16px;cursor:pointer;border:1px solid var(--line);background:transparent;color:var(--ink)}',
    '.cls-btn.go{background:var(--matched);border-color:var(--matched);color:#0E1613}',
    '.cls-btn.go:disabled{background:transparent;border-color:var(--line);color:var(--muted);cursor:not-allowed}',
    '.cls-btn.sm{padding:5px 12px;font-size:12px;font-weight:500;border-radius:20px;color:var(--muted)}',
    '.cls-btn:focus-visible,.cls-in:focus-visible,.cls-chip button:focus-visible{outline:2px solid var(--matched);outline-offset:2px}',
    '.cls-off{margin-top:22px;font-size:13px;color:var(--muted);line-height:1.6}',
    '.cls-link{font:inherit;color:var(--matched);background:transparent;border:0;padding:0;cursor:pointer;text-decoration:underline}',
    '.cls-empty{padding:44px 28px;text-align:center}',
    '.cls-empty h3{font-family:"Space Grotesk",sans-serif;font-size:18px;margin:0 0 6px}',
    '.cls-empty p{color:var(--muted);font-size:13.5px;margin:0 0 18px}',
    '.cls-rules{margin-top:30px}',
    '.cls-rule{display:flex;align-items:center;gap:10px;padding:11px 18px;border-bottom:1px solid var(--line);font-size:13.5px}',
    '.cls-rule .arrow{color:var(--muted)}.cls-rule button{margin-left:auto}',
    '.cls-form{display:grid;grid-template-columns:repeat(4,1fr) auto;gap:8px;padding:14px 18px;background:var(--surface-raised);align-items:end}',
    '.cls-form label{display:block;font-size:12px;color:var(--muted);margin-bottom:5px}.cls-form .cls-in{width:100%}',
    /* the sheet */
    '.cls-back{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:60;opacity:0;pointer-events:none;transition:opacity .25s}',
    '.cls-back.show{opacity:1;pointer-events:auto}',
    '.cls-sheet{position:fixed;top:12px;right:12px;bottom:12px;width:min(470px,calc(100vw - 24px));background:var(--surface);border:1px solid var(--line);border-radius:22px;box-shadow:0 24px 60px rgba(0,0,0,.55);z-index:61;display:flex;flex-direction:column;transform:translateX(calc(100% + 30px));transition:transform .3s cubic-bezier(.2,.8,.2,1);overflow:hidden}',
    '.cls-sheet.show{transform:none}',
    '.cls-sh{padding:22px 24px 14px;display:flex;gap:12px;align-items:flex-start}',
    '.cls-sh h2{font-family:"Space Grotesk",sans-serif;font-size:20px;margin:0}.cls-sh p{margin:4px 0 0;font-size:13px;color:var(--muted)}',
    '.cls-x{margin-left:auto;font:inherit;font-size:16px;width:34px;height:34px;border-radius:50%;border:1px solid var(--line);background:transparent;color:var(--muted);cursor:pointer;flex-shrink:0}',
    '.cls-x:hover{color:var(--ink)}',
    '.cls-presets{display:flex;gap:8px;flex-wrap:wrap;padding:0 24px 12px}',
    '.cls-sbody{flex:1;overflow:auto;padding:4px 24px 12px}',
    '.cls-opt{display:flex;align-items:center;gap:12px;padding:10px 14px;border:1px solid var(--line);border-radius:11px;background:var(--bg);margin-bottom:7px;cursor:pointer}',
    '.cls-opt:hover{border-color:var(--muted)}.cls-opt:has(input:checked){border-color:var(--matched);background:rgba(89,179,125,.09)}',
    '.cls-opt input{accent-color:var(--matched);width:17px;height:17px;margin:0}',
    '.cls-opt .lock{margin-left:auto;font-size:11.5px;color:var(--muted)}',
    '.cls-opt.locked{cursor:not-allowed}',
    '.cls-warn{margin:6px 24px 0;padding:10px 14px;border-radius:10px;background:rgba(217,164,65,.12);border:1px solid rgba(217,164,65,.4);font-size:12.5px;line-height:1.5;color:var(--cash)}',
    '.cls-sf{display:flex;gap:10px;align-items:center;padding:14px 24px;border-top:1px solid var(--line);background:var(--surface-raised)}',
    '.cls-sf .sum{font-size:12.5px;color:var(--muted);margin-right:auto}',
    '.cls-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:var(--surface-raised);border:1px solid var(--matched);color:var(--ink);padding:11px 18px;border-radius:10px;font-size:13px;z-index:99;max-width:90vw}',
    '.cls-toast.bad{border-color:var(--alert)}',
    '@media(max-width:720px){.cls-form{grid-template-columns:1fr 1fr}.cls-sheet{top:8px;right:8px;bottom:8px;width:calc(100vw - 16px)}}',
    '@media(prefers-reduced-motion:reduce){.cls-sheet,.cls-back{transition:none}}',
  ].join('\n');
  document.head.appendChild(css);
})();

(function () {
  if (document.getElementById('clsStyle2')) return;
  const css = document.createElement('style');
  css.id = 'clsStyle2';
  css.textContent = [
    '.cls-chipbtn{font:inherit;color:inherit;background:transparent;border:0;padding:0;cursor:pointer;display:inline-flex;align-items:center;gap:8px;border-radius:12px}',
    '.cls-chipbtn:hover .nm{text-decoration:underline}.cls-chipbtn:focus-visible{outline:2px solid var(--matched);outline-offset:2px}',
    '.cls-info{margin:0 0 14px;padding:10px 14px;border:1px solid var(--line);border-radius:10px;background:var(--surface);font-size:13px;color:var(--muted);line-height:1.5}.cls-info b{color:var(--ink);font-weight:500}',
    '.cls-sec{border:1px solid var(--line);border-radius:12px;background:var(--bg);padding:14px 16px;margin-bottom:12px}',
    '.cls-sec h4{margin:0 0 8px;font-family:"Space Grotesk",sans-serif;font-size:14px}.cls-sec p{margin:8px 0 0;font-size:12.5px;color:var(--muted);line-height:1.5}',
    '.cls-inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
    '.cls-roster{max-height:230px;overflow:auto;border:1px solid var(--line);border-radius:10px;margin:8px 0 10px}',
    '.cls-rrow{display:flex;gap:10px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--line);font-size:13px;cursor:pointer}.cls-rrow:last-child{border-bottom:0}',
    '.cls-rrow .adm{font-family:"IBM Plex Mono",monospace;font-size:11.5px;color:var(--muted)}.cls-rrow .was{margin-left:auto;font-size:12px;color:var(--muted)}',
    '.cls-btn.danger{border-color:rgba(226,87,76,.5);color:var(--alert)}.cls-btn.danger:disabled{opacity:.45;cursor:not-allowed}',
  ].join('\n');
  document.head.appendChild(css);
})();

/* ---------------- helpers ---------------- */
const CLS_STAGES = [
  [0, 2, 'Pre-primary'], [3, 5, 'Lower primary'], [6, 8, 'Upper primary'], [9, 11, 'Junior school'], [12, 14, 'Senior school'],
];
const CLS_PRESETS = [
  ['Primary: PP1 to Grade 6', [1, 2, 3, 4, 5, 6, 7, 8]],
  ['Junior: Grade 7 to 9', [9, 10, 11]],
  ['Senior: Grade 10 to 12', [12, 13, 14]],
];
const clsBase = function () { return '/schools/' + live.staff.school_id; };
function clsStage(sortOrder) {
  const s = CLS_STAGES.find(function (x) { return sortOrder >= x[0] && sortOrder <= x[1]; });
  return s ? s[2] : 'Other';
}
function clsToast(msg, bad) {
  const old = document.getElementById('clsToast'); if (old) old.remove();
  const d = document.createElement('div');
  d.id = 'clsToast'; d.className = 'cls-toast' + (bad ? ' bad' : ''); d.textContent = msg;
  document.body.appendChild(d);
  setTimeout(function () { if (d.parentNode) d.remove(); }, 3800);
}
function clsClassById(id) { return cls.data.classes.find(function (c) { return c.id === Number(id); }); }
function clsByStage(list) {
  const groups = [];
  list.forEach(function (c) {
    const name = clsStage(c.sort_order);
    let g = groups.find(function (x) { return x.name === name; });
    if (!g) { g = { name: name, items: [] }; groups.push(g); }
    g.items.push(c);
  });
  return groups;
}

/* ---------------- the page ---------------- */
function clsRender() {
  const root = document.getElementById('clsRoot');
  if (root) root.innerHTML = clsBody();
}
function clsBody() {
  if (cls.error) return '<div class="cls-panel cls-empty"><h3>Could not load classes</h3><p>' + esc(cls.error) + '</p><button type="button" class="cls-btn" onclick="clsLoad()">Try again</button></div>';
  if (!cls.data) return '<div class="cls-panel cls-empty"><p>Loading classes&hellip;</p></div>';
  if (cls.open && typeof cdBody === 'function') return cdBody();
  const on = cls.data.classes.filter(function (c) { return c.enabled; });
  const off = cls.data.classes.filter(function (c) { return !c.enabled; });
  const year = cls.data.year ? cls.data.year.year : null;

  const head = '<div class="topbar"><div><h1>Classes &amp; streams</h1><p class="sub">' +
    (on.length ? on.length + ' class' + (on.length === 1 ? '' : 'es') + ' offered' + (year ? ' &middot; streams shown for ' + year : '') : 'Choose the classes this school runs') +
    '</p></div><button type="button" class="cls-btn go" onclick="clsOpenSheet()">Choose classes</button></div>';

  if (!on.length) {
    return head + '<div class="cls-panel cls-empty"><h3>Which classes does your school run?</h3>' +
      '<p>Pick them once. Promotion uses this to know where to move students, and where to graduate them.</p>' +
      CLS_PRESETS.map(function (p, i) { return '<button type="button" class="cls-btn" style="margin:4px;" onclick="clsOpenSheet(' + i + ')">' + p[0] + '</button>'; }).join('') +
      '<div style="margin-top:12px;"><button type="button" class="cls-link" onclick="clsOpenSheet()">or choose class by class</button></div></div>';
  }

  const groups = clsByStage(on).map(function (g) {
    return '<div class="cls-stage">' + g.name + '</div><div class="cls-panel">' + g.items.map(clsRowHtml).join('') + '</div>';
  }).join('');
  const offLine = off.length ? '<p class="cls-off">Not offered: ' + off.map(function (c) { return esc(c.name); }).join(', ') +
    '. <button type="button" class="cls-link" onclick="clsOpenSheet()">Change</button></p>' : '';
  const info = cls.data.last_class ? '<div class="cls-info">Students graduate after <b>' + esc(cls.data.last_class) + '</b>. Promotion moves each student to the next class that is switched on.</div>' : '';
  const gapWarn = (cls.data.warnings || []).map(function (w) { return '<div class="cls-warn" style="margin:0 0 14px;">' + esc(w) + '</div>'; }).join('');
  return head + info + gapWarn + groups + offLine;
}
function clsRowHtml(c) {
  const chips = c.streams.map(function (s) {
    return '<button type="button" class="cls-chip cls-chipbtn" style="padding:4px 12px;border:1px solid var(--line);background:var(--surface-raised)" title="Open ' + esc(c.name) + ' filtered to ' + esc(s.name) + '" onclick="clsOpenClass(' + c.id + ',' + s.id + ')"><span class="nm">' + esc(s.name) + '</span><b>' + s.student_count + '</b></button>';
  }).join('');
  return '<div class="cls-row"><button type="button" class="cls-name cls-link" style="text-decoration:none;color:var(--ink);text-align:left" onclick="clsOpenClass(' + c.id + ')">' + esc(c.name) + '</button>' +
    '<span class="cls-count">' + c.student_count + ' student' + (c.student_count === 1 ? '' : 's') + '</span>' +
    '<span class="cls-streams">' + (chips || '<span style="font-size:12.5px;color:var(--muted);">No streams</span>') + '</span>' +
    '<button type="button" class="cls-btn sm" onclick="clsOpenClass(' + c.id + ')">Open &rsaquo;</button></div>';
}


views.classes = function () {
  cls.open = null;
  setTimeout(clsLoad, 0);
  return '<div id="clsRoot">' + clsBody() + '</div>';
};

window.clsLoad = async function () {
  cls.error = null;
  try { cls.data = await Api.get(clsBase() + '/classes-overview'); } catch (e) { cls.error = e.message; }
  clsRender();
};

/* ---------------- the sheet (choose classes) ---------------- */
function clsGaps(draft) {
  const picked = cls.data.classes.filter(function (c) { return draft.has(c.id); });
  if (picked.length < 2) return [];
  const lo = picked[0].sort_order, hi = picked[picked.length - 1].sort_order;
  return cls.data.classes.filter(function (c) { return c.sort_order > lo && c.sort_order < hi && !draft.has(c.id); });
}
function clsChanged() {
  const was = cls.data.classes.filter(function (c) { return c.enabled; });
  return was.length !== cls.draft.size || was.some(function (c) { return !cls.draft.has(c.id); });
}
function clsSheetHtml() {
  const locked = function (c) { return c.student_count > 0; };
  const groups = clsByStage(cls.data.classes).map(function (g) {
    return '<div class="cls-stage" style="margin:14px 0 8px;">' + g.name + '</div>' + g.items.map(function (c) {
      const lock = locked(c) && cls.draft.has(c.id);
      return '<label class="cls-opt' + (lock ? ' locked' : '') + '"><input type="checkbox" ' + (cls.draft.has(c.id) ? 'checked ' : '') + (lock ? 'disabled ' : '') + 'onchange="clsToggle(' + c.id + ',this.checked)">' +
        '<span>' + esc(c.name) + '</span>' + (lock ? '<span class="lock">' + c.student_count + ' student' + (c.student_count === 1 ? '' : 's') + ', stays on</span>' : '') + '</label>';
    }).join('');
  }).join('');
  const gaps = clsGaps(cls.draft);
  const warn = gaps.length ? '<div class="cls-warn">' + gaps.slice(0, 3).map(function (c) { return esc(c.name); }).join(', ') + (gaps.length > 3 ? ' and ' + (gaps.length - 3) + ' more' : '') +
    (gaps.length === 1 ? ' is' : ' are') + ' switched off between classes that are on. When students are promoted they will skip ' + (gaps.length === 1 ? 'it' : 'them') + '. That is fine if your school really does not run ' + (gaps.length === 1 ? 'it' : 'them') + '.</div>' : '';
  const n = cls.draft.size, changed = clsChanged();
  return '<div class="cls-sh"><div><h2>Choose your classes</h2><p>Switch on every class your school runs.</p></div>' +
    '<button type="button" class="cls-x" aria-label="Close" onclick="clsCloseSheet()">&#10005;</button></div>' +
    '<div class="cls-presets">' + CLS_PRESETS.map(function (p, i) { return '<button type="button" class="cls-btn sm" onclick="clsPreset(' + i + ')">' + p[0] + '</button>'; }).join('') +
    '<button type="button" class="cls-btn sm" onclick="clsPresetAll()">Select all</button><button type="button" class="cls-btn sm" onclick="clsPresetNone()">Clear</button></div>' +
    '<div class="cls-sbody">' + groups + '</div>' + warn +
    '<div class="cls-sf"><span class="sum">' + n + ' selected</span><button type="button" class="cls-btn" onclick="clsCloseSheet()">Cancel</button>' +
    '<button type="button" class="cls-btn go" id="clsSave" ' + (changed ? '' : 'disabled') + ' onclick="clsSave()">Save classes</button></div>';
}
function clsSheetRender() {
  const sheet = document.getElementById('clsSheet');
  if (!sheet) return;
  const body = sheet.querySelector('.cls-sbody'), keep = body ? body.scrollTop : 0;
  sheet.innerHTML = clsSheetHtml();
  const nb = sheet.querySelector('.cls-sbody'); if (nb) nb.scrollTop = keep;
}
window.clsOpenSheet = function (presetIndex) {
  if (!cls.data) return;
  cls.draft = new Set(cls.data.classes.filter(function (c) { return c.enabled; }).map(function (c) { return c.id; }));
  if (presetIndex !== undefined) CLS_PRESETS[presetIndex][1].forEach(function (o) { const c = cls.data.classes.find(function (x) { return x.sort_order === o; }); if (c) cls.draft.add(c.id); });
  let back = document.getElementById('clsBack'), sheet = document.getElementById('clsSheet');
  if (!back) {
    back = document.createElement('div'); back.id = 'clsBack'; back.className = 'cls-back'; back.onclick = clsCloseSheet; document.body.appendChild(back);
    sheet = document.createElement('div'); sheet.id = 'clsSheet'; sheet.className = 'cls-sheet'; sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true'); sheet.setAttribute('aria-label', 'Choose your classes');
    document.body.appendChild(sheet);
  }
  cls.sheet = true; clsSheetRender();
  requestAnimationFrame(function () { requestAnimationFrame(function () { if (!cls.sheet) return; back.classList.add('show'); sheet.classList.add('show'); const x = sheet.querySelector('.cls-x'); if (x) x.focus(); }); });
};
window.clsCloseSheet = function () {
  cls.sheet = false;
  const back = document.getElementById('clsBack'), sheet = document.getElementById('clsSheet');
  if (back) back.classList.remove('show'); if (sheet) sheet.classList.remove('show');
};
window.clsToggle = function (id, on) { if (on) cls.draft.add(id); else cls.draft.delete(id); clsSheetRender(); };
window.clsPreset = function (i) {
  CLS_PRESETS[i][1].forEach(function (o) { const c = cls.data.classes.find(function (x) { return x.sort_order === o; }); if (c) cls.draft.add(c.id); });
  clsSheetRender();
};
window.clsPresetAll = function () { cls.data.classes.forEach(function (c) { cls.draft.add(c.id); }); clsSheetRender(); };
window.clsPresetNone = function () {   // classes with students stay on
  cls.draft = new Set(cls.data.classes.filter(function (c) { return c.student_count > 0 && cls.draft.has(c.id); }).map(function (c) { return c.id; }));
  clsSheetRender();
};
window.clsSave = async function () {
  const btn = document.getElementById('clsSave'); if (btn) btn.disabled = true;
  try {
    await Api.post(clsBase() + '/classes/save', { enabled_class_ids: Array.from(cls.draft) });
    clsCloseSheet(); clsToast('Classes saved'); await clsLoad();
  } catch (e) { clsToast(e.message, true); if (btn) btn.disabled = false; }
};
document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && cls.sheet) clsCloseSheet(); });