/* page-promotion.js - the Promotion screen, connected to the real database.
   - Nothing moves until you press "Run promotion". Everything before that is a preview.
   - Default is "promote": you only mark the exceptions (repeat / leaving) per student.
   - Click a class to open its sheet, which slides in from the right like the Choose classes sheet.
   - The run is all-or-nothing and can only be done once per school per year (the server enforces this).
   - A repeater's stream starts as "Automatic (fewest students)": the server picks the arriving stream with the fewest
     students. The admin can choose a stream, or "No stream", instead.
   - Before running, the confirm box shows the server's exact plan (where every repeater lands), and the run button is
     blocked when the server says promotion cannot be done yet (year not finished, students without a class).
   Add to index.html AFTER page-classes.js:  <script src="js/page-promotion.js"></script> */

const pr = { data: null, error: null, decisions: {}, openClass: null, q: '', running: false };

/* ---------------- styles (added once) ---------------- */
(function () {
  if (document.getElementById('prStyle')) return;
  const css = document.createElement('style');
  css.id = 'prStyle';
  css.textContent = [
    '.pr-strip{display:flex;border:1px solid var(--line);border-radius:10px;background:var(--surface);margin:14px 0;overflow:hidden}',
    '.pr-strip>div{flex:1;padding:12px 18px;border-right:1px solid var(--line);min-width:0}.pr-strip>div:last-child{border-right:0}',
    '.pr-strip .n{font-family:"IBM Plex Mono",monospace;font-size:20px;font-weight:600;line-height:1.2}',
    '.pr-strip .l{font-size:12px;color:var(--muted);margin-top:2px}',
    '.pr-strip .rep .n{color:var(--cash)}.pr-strip .lv .n{color:var(--alert)}.pr-strip .ok .n{color:var(--matched)}',
    '.pr-note{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:14px 18px;font-size:13px;color:var(--muted);line-height:1.55;margin:14px 0}',
    '.pr-note b{color:var(--ink)}.pr-note.warn{border-color:rgba(217,164,65,.45);background:rgba(217,164,65,.08);color:var(--cash)}',
    '.pr-note.done{border-color:rgba(89,179,125,.5);background:rgba(89,179,125,.08);color:var(--ink)}',
    '.pr-list{background:var(--surface);border:1px solid var(--line);border-radius:12px;overflow:hidden;margin-top:14px}',
    '.pr-row{display:flex;align-items:center;gap:14px;width:100%;text-align:left;background:transparent;border:0;border-bottom:1px solid var(--line);color:var(--ink);padding:14px 18px;cursor:pointer;font:inherit}',
    '.pr-row:last-child{border-bottom:0}.pr-row:hover{background:rgba(255,255,255,.025)}',
    '.pr-row:focus-visible{outline:2px solid var(--matched);outline-offset:-2px}',
    '.pr-cname{font-family:"Space Grotesk",sans-serif;font-weight:600;font-size:15px;min-width:92px}',
    '.pr-cnt{font-family:"IBM Plex Mono",monospace;font-size:12px;color:var(--muted);min-width:82px}',
    '.pr-dest{font-size:13px;color:var(--muted);flex:1}',
    '.pr-tag{font-size:11.5px;padding:3px 10px;border-radius:20px;white-space:nowrap}',
    '.pr-tag.rep{background:rgba(217,164,65,.16);color:var(--cash)}.pr-tag.lv{background:rgba(226,87,76,.14);color:var(--alert)}',
    '.pr-chev{color:var(--muted);font-size:18px}',
    '.pr-run{display:flex;align-items:center;gap:14px;margin-top:18px;padding:16px 18px;background:var(--surface-raised);border:1px solid var(--line);border-radius:12px;flex-wrap:wrap}',
    '.pr-run p{margin:0;font-size:13px;color:var(--muted);flex:1;min-width:200px}',
    '.pr-btn{font:inherit;font-size:13.5px;font-weight:600;border-radius:9px;padding:11px 20px;cursor:pointer;border:1px solid var(--line);background:transparent;color:var(--ink)}',
    '.pr-btn.go{background:var(--matched);border-color:var(--matched);color:#0E1613}.pr-btn.go:disabled{background:transparent;color:var(--muted);cursor:not-allowed}',
    '.pr-btn.sm{padding:6px 14px;font-size:12.5px;font-weight:500}',
    '.pr-btn:focus-visible,.pr-in:focus-visible,.pr-seg button:focus-visible{outline:2px solid var(--matched);outline-offset:2px}',
    '.pr-in{font:inherit;font-size:13px;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 12px;min-width:0}',
    '.pr-in:focus{outline:none;border-color:var(--matched)}',
    '.pr-empty{padding:44px 28px;text-align:center;color:var(--muted);font-size:13.5px;line-height:1.6}',
    '.pr-empty h3{font-family:"Space Grotesk",sans-serif;font-size:18px;color:var(--ink);margin:0 0 6px}',
    /* sheet + dialog */
    '.pr-back{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:60;opacity:0;pointer-events:none;transition:opacity .25s}.pr-back.show{opacity:1;pointer-events:auto}',
    '.pr-sheet{position:fixed;top:12px;right:12px;bottom:12px;width:min(520px,calc(100vw - 24px));background:var(--surface);border:1px solid var(--line);border-radius:22px;box-shadow:0 24px 60px rgba(0,0,0,.55);z-index:61;display:flex;flex-direction:column;transform:translateX(calc(100% + 30px));transition:transform .3s cubic-bezier(.2,.8,.2,1);overflow:hidden}',
    '.pr-sheet.show{transform:none}',
    '.pr-sh{padding:22px 24px 12px;display:flex;gap:12px;align-items:flex-start}.pr-sh h2{font-family:"Space Grotesk",sans-serif;font-size:20px;margin:0}.pr-sh p{margin:4px 0 0;font-size:13px;color:var(--muted)}',
    '.pr-x{margin-left:auto;font:inherit;font-size:16px;width:34px;height:34px;border-radius:50%;border:1px solid var(--line);background:transparent;color:var(--muted);cursor:pointer;flex-shrink:0}.pr-x:hover{color:var(--ink)}',
    '.pr-search{padding:0 24px 12px}.pr-search .pr-in{width:100%}',
    '.pr-sbody{flex:1;overflow:auto;padding:0 24px 12px}',
    '.pr-st{border:1px solid var(--line);border-radius:12px;background:var(--bg);padding:12px 14px;margin-bottom:9px}',
    '.pr-st-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.pr-st-name{font-weight:500;font-size:14px}.pr-adm{font-family:"IBM Plex Mono",monospace;font-size:12px;color:var(--muted)}',
    '.pr-seg{display:inline-flex;border:1px solid var(--line);border-radius:9px;padding:2px;gap:2px;margin-left:auto}',
    '.pr-seg button{font:inherit;font-size:12px;color:var(--muted);background:transparent;border:0;border-radius:7px;padding:5px 11px;cursor:pointer}',
    '.pr-seg button.on{background:var(--surface-raised);color:var(--ink)}.pr-seg button.on.rep{color:var(--cash)}.pr-seg button.on.lv{color:var(--alert)}.pr-seg button.on.pm{color:var(--matched)}',
    '.pr-flow{font-size:12.5px;color:var(--muted);margin-top:8px}.pr-flow b{color:var(--ink);font-weight:500}',
    '.pr-rep{display:flex;gap:8px;margin-top:9px;flex-wrap:wrap}.pr-rep label{font-size:11.5px;color:var(--muted);display:block;margin-bottom:3px}',
    '.pr-sf{display:flex;gap:10px;align-items:center;padding:14px 24px;border-top:1px solid var(--line);background:var(--surface-raised)}.pr-sf .sum{font-size:12.5px;color:var(--muted);margin-right:auto}',
    '.pr-dialog{position:fixed;left:50%;top:50%;transform:translate(-50%,-46%);width:min(440px,calc(100vw - 32px));background:var(--surface);border:1px solid var(--line);border-radius:20px;box-shadow:0 24px 60px rgba(0,0,0,.55);z-index:71;padding:26px;opacity:0;pointer-events:none;transition:opacity .2s,transform .25s}',
    '.pr-dialog.show{opacity:1;pointer-events:auto;transform:translate(-50%,-50%)}',
    '.pr-dialog h3{font-family:"Space Grotesk",sans-serif;font-size:19px;margin:0 0 8px}.pr-dialog p{font-size:13.5px;color:var(--muted);line-height:1.55;margin:0 0 12px}',
    '.pr-dialog ul{list-style:none;margin:0 0 14px;padding:0;font-size:14px}.pr-dialog li{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line)}.pr-dialog li b{font-family:"IBM Plex Mono",monospace}',
    '.pr-dialog .acts{display:flex;gap:10px;justify-content:flex-end;margin-top:16px}',
    '.pr-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:var(--surface-raised);border:1px solid var(--matched);color:var(--ink);padding:11px 18px;border-radius:10px;font-size:13px;z-index:99;max-width:90vw}.pr-toast.bad{border-color:var(--alert)}',
    '@media(max-width:720px){.pr-strip{flex-wrap:wrap}.pr-strip>div{flex:1 1 45%}.pr-sheet{top:8px;right:8px;bottom:8px;width:calc(100vw - 16px)}.pr-dest{display:none}}',
    '@media(prefers-reduced-motion:reduce){.pr-sheet,.pr-back,.pr-dialog{transition:none}}',
  ].join('\n');
  document.head.appendChild(css);
})();

(function () {
  if (document.getElementById('prStyle2')) return;
  const css = document.createElement('style');
  css.id = 'prStyle2';
  css.textContent = [
    '.pr-note.bad{border-color:rgba(226,87,76,.5);background:rgba(226,87,76,.09);color:var(--ink);margin-top:14px}',
    '.pr-note.warn{margin-top:14px}.pr-note ul{margin:6px 0 0 18px;padding:0}.pr-note li{margin:3px 0}',
    '.pr-sumbox{border:1px solid var(--line);border-radius:10px;background:var(--bg);padding:10px 12px;margin:0 0 12px;max-height:200px;overflow:auto;font-size:12.5px;line-height:1.65;color:var(--muted)}',
    '.pr-sumbox h4{margin:0 0 3px;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);font-weight:600}',
    '.pr-sumbox .blk+.blk{margin-top:9px}.pr-sumbox b{color:var(--ink);font-weight:500}.pr-sumbox .why{color:var(--muted)}',
    '.pr-dialog.wide{width:min(520px,calc(100vw - 32px))}',
  ].join('\n');
  document.head.appendChild(css);
})();

/* ---------------- helpers ---------------- */
const prBase = function () { return '/schools/' + live.staff.school_id; };
function prToast(msg, bad) {
  const old = document.getElementById('prToast'); if (old) old.remove();
  const d = document.createElement('div'); d.id = 'prToast'; d.className = 'pr-toast' + (bad ? ' bad' : ''); d.textContent = msg;
  document.body.appendChild(d); setTimeout(function () { if (d.parentNode) d.remove(); }, 4200);
}
function prDec(id) { return pr.decisions[id] || { mode: 'promote' }; }
function prStudentOutcome(p) {                     // where this student ends up, given what was chosen
  const d = prDec(p.student_id);
  if (d.mode === 'leave') return { kind: 'leave', text: 'Leaving school' };
  if (d.mode === 'repeat') {
    const cn = prClassName(d.classId || p.class_id);
    const where = d.stream === '' ? ' &middot; automatic stream' : d.stream === '__none__' ? ' &middot; no stream' : ' ' + esc(d.stream);
    return { kind: 'repeat', text: 'Repeats <b>' + esc(cn) + '</b>' + where };
  }
  if (p.action === 'graduate') return { kind: 'graduate', text: 'Graduates' };
  return { kind: 'promote', text: '<b>' + esc(p.dest_class_name) + '</b>' + (p.dest_stream_name ? ' ' + esc(p.dest_stream_name) : '') };
}
function prClassName(id) { const c = pr.data.classes.find(function (x) { return x.id === Number(id); }); return c ? c.name : '?'; }
function prCounts(list) {
  const c = { promote: 0, repeat: 0, leave: 0, graduate: 0 };
  (list || pr.data.plan).forEach(function (p) { c[prStudentOutcome(p).kind]++; });
  return c;
}
function prByClass() {
  const groups = [];
  pr.data.classes.forEach(function (c) {
    const students = pr.data.plan.filter(function (p) { return p.class_id === c.id; });
    if (students.length) groups.push({ cls: c, students: students });
  });
  return groups;
}
// What the admin decided, in the shape the server wants (the same for the plan and for the real run).
// stream '' = automatic (fewest students), '__none__' = no stream on purpose, anything else = that stream.
function prDecisionsPayload() {
  const decisions = {};
  Object.keys(pr.decisions).forEach(function (id) {
    const d = pr.decisions[id];
    if (d.mode === 'leave') decisions[id] = 'leave';
    else if (d.stream === '__none__') decisions[id] = { action: 'repeat', classId: d.classId, noStream: true };
    else decisions[id] = { action: 'repeat', classId: d.classId, streamName: d.stream || null };
  });
  return decisions;
}
const PR_WHY = { chosen: 'your choice', nostream: 'no stream, your choice', fewest: 'stream with the fewest students', own: 'kept their own stream', none: 'no stream' };

/* ---------------- the page ---------------- */
function prBody() {
  if (pr.error) return '<div class="pr-list"><div class="pr-empty"><h3>Could not load promotion</h3><p>' + esc(pr.error) + '</p><button type="button" class="pr-btn" onclick="prLoad()">Try again</button></div></div>';
  if (!pr.data) return '<div class="pr-list"><div class="pr-empty">Loading&hellip;</div></div>';
  const d = pr.data;
  const head = '<div class="topbar"><div><h1>Promotion &amp; transfers</h1><p class="sub">' + (d.outgoing ? esc(d.outgoing.year) + ' &rarr; ' + esc(d.next_year) + '. Default is promote, so only mark the exceptions.' : 'No academic year yet') + '</p></div></div>';
  if (!d.outgoing) return head + '<div class="pr-list"><div class="pr-empty"><h3>No academic year found</h3>Create one on the Terms screen first.</div></div>';

  if (d.already_run) {
    const s = d.already_run.summary || {};
    return head + '<div class="pr-note done"><b>Promotion for ' + esc(d.outgoing.year) + ' was already run</b> on ' + esc(String(d.already_run.ran_at).slice(0, 10)) + '.<br>' +
      (s.promoted || 0) + ' promoted, ' + (s.repeating || 0) + ' repeating, ' + (s.left || 0) + ' left, ' + (s.graduated || 0) + ' graduated. It can only be run once per year.</div>';
  }
  // the promotion that brought the school into THIS year (so right after a run the screen says so, calmly)
  const lr = d.last_run;
  const lastNote = lr ? '<div class="pr-note done"><b>Promotion into ' + esc(lr.into_year) + ' was run</b> on ' + esc(String(lr.ran_at).slice(0, 10)) + '. ' +
    ((lr.summary && lr.summary.promoted) || 0) + ' promoted, ' + ((lr.summary && lr.summary.repeating) || 0) + ' repeating, ' + ((lr.summary && lr.summary.left) || 0) + ' left, ' + ((lr.summary && lr.summary.graduated) || 0) + ' graduated. ' +
    'The next promotion (' + esc(d.outgoing.year) + ' &rarr; ' + esc(d.next_year) + ') opens after Term 3 of ' + esc(d.outgoing.year) + ' ends.</div>' : '';
  if (!d.incoming) {
    return head + lastNote + '<div class="pr-note warn"><b>The ' + esc(d.next_year) + ' academic year does not exist yet.</b> Students need it to be promoted into.</div>' +
      '<button type="button" class="pr-btn go" onclick="prCreateYear(' + d.next_year + ')">Create academic year ' + esc(d.next_year) + '</button>';
  }
  if (!d.plan.length) return head + lastNote + '<div class="pr-list"><div class="pr-empty"><h3>No students to promote</h3>Students need a class first. Choose classes on the Classes screen and admit or assign students.</div></div>';

  const c = prCounts();
  const strip = '<div class="pr-strip"><div class="ok"><div class="n">' + c.promote + '</div><div class="l">Promoting</div></div>' +
    '<div class="rep"><div class="n">' + c.repeat + '</div><div class="l">Repeating</div></div>' +
    '<div class="lv"><div class="n">' + c.leave + '</div><div class="l">Leaving</div></div>' +
    '<div><div class="n">' + c.graduate + '</div><div class="l">Graduating</div></div></div>';
  const rd = d.readiness;
  const blocked = !!(rd && rd.problems.length);
  let skipped = '';
  if (rd) {
    if (rd.problems.length) {
      const fx = (rd.fixes || []).filter(function (f) { return f.kind === 'term_dates'; })[0];
      skipped += '<div class="pr-note bad"><b>Almost ready</b><ul>' + rd.problems.map(function (m) { return '<li>' + esc(m) + '</li>'; }).join('') + '</ul>' +
        (fx ? '<button type="button" class="pr-btn go" style="margin-top:10px" onclick="prGoTerms(' + fx.year + ')">Set Term ' + fx.term + ' dates for ' + fx.year + '</button>' : '') + '</div>';
    }
    if (rd.warnings.length) skipped += '<div class="pr-note warn"><b>Please note</b><ul>' + rd.warnings.map(function (m) { return '<li>' + esc(m) + '</li>'; }).join('') + '</ul></div>';
  } else if (d.students_without_class) {
    skipped = '<div class="pr-note"><b>' + d.students_without_class + ' student' + (d.students_without_class === 1 ? ' has' : 's have') + ' no class</b> and will not be moved.</div>';
  }
  const rows = prByClass().map(function (g) {
    const cc = prCounts(g.students);
    return '<button type="button" class="pr-row" onclick="prOpen(' + g.cls.id + ')"><span class="pr-cname">' + esc(g.cls.name) + '</span>' +
      '<span class="pr-cnt">' + g.students.length + ' student' + (g.students.length === 1 ? '' : 's') + '</span>' +
      '<span class="pr-dest">' + (g.cls.is_final ? 'final class, graduates' : 'moves to ' + esc(g.cls.next_class_name)) + '</span>' +
      (cc.repeat ? '<span class="pr-tag rep">' + cc.repeat + ' repeating</span>' : '') + (cc.leave ? '<span class="pr-tag lv">' + cc.leave + ' leaving</span>' : '') +
      '<span class="pr-chev">&#8250;</span></button>';
  }).join('');
  return head + lastNote + skipped + strip + '<div class="pr-list">' + rows + '</div>' +
    '<div class="pr-run"><p>' + (blocked ? 'Promotion opens once the step above is done. You can still look through the classes.' : 'Nothing has moved yet. Running promotion moves everyone at once, and it can only be done once for ' + esc(d.outgoing.year) + '.') + '</p>' +
    '<button type="button" class="pr-btn go" onclick="prAsk()"' + (blocked ? ' disabled' : '') + '>Run promotion</button></div>';
}
function prRender() { const r = document.getElementById('prRoot'); if (r) r.innerHTML = prBody(); }

views.promotion = function () { setTimeout(prLoad, 0); return '<div id="prRoot">' + prBody() + '</div>'; };

window.prLoad = async function () {
  pr.error = null;
  try { pr.data = await Api.get(prBase() + '/promotion/preview'); } catch (e) { pr.error = e.message; }
  // keep earlier choices only for students who are still in the plan
  if (pr.data && pr.data.plan) { const ids = {}; pr.data.plan.forEach(function (p) { ids[p.student_id] = 1; }); Object.keys(pr.decisions).forEach(function (k) { if (!ids[k]) delete pr.decisions[k]; }); }
  prRender();
};
window.prGoTerms = function (year) { tm.want = Number(year); showView('terms'); };
window.prCreateYear = async function (year) {
  try { await Api.post(prBase() + '/academic-years', { year: year }); prToast('Created academic year ' + year); await prLoad(); }
  catch (e) { prToast(e.message, true); }
};

/* ---------------- the class sheet ---------------- */
function prStudentCard(p) {
  const d = prDec(p.student_id), o = prStudentOutcome(p), id = p.student_id;
  const seg = function (mode, label, cls) { return '<button type="button" class="' + (d.mode === mode ? 'on ' + cls : '') + '" onclick="prSetMode(' + id + ',\'' + mode + '\')">' + label + '</button>'; };
  let picker = '';
  if (d.mode === 'repeat') {
    const cid = d.classId || p.class_id, opts = pr.data.repeat_options[cid] || [];
    picker = '<div class="pr-rep"><div><label for="rc' + id + '">Repeats in class</label><select class="pr-in" id="rc' + id + '" onchange="prRepClass(' + id + ',this.value)">' +
      pr.data.classes.map(function (c) { return '<option value="' + c.id + '"' + (c.id === cid ? ' selected' : '') + '>' + esc(c.name) + '</option>'; }).join('') + '</select></div>' +
      '<div><label for="rs' + id + '">Stream</label><select class="pr-in" id="rs' + id + '" onchange="prRepStream(' + id + ',this.value)">' +
      '<option value=""' + (d.stream === '' ? ' selected' : '') + '>Automatic (fewest students)</option>' +
      '<option value="__none__"' + (d.stream === '__none__' ? ' selected' : '') + '>No stream</option>' +
      opts.map(function (n) { return '<option' + (n === d.stream ? ' selected' : '') + '>' + esc(n) + '</option>'; }).join('') + '</select></div></div>';
  }
  return '<div class="pr-st"><div class="pr-st-top"><span class="pr-st-name">' + esc(p.full_name) + '</span><span class="pr-adm">' + esc(p.admission_no) + '</span>' +
    '<span class="pr-seg">' + seg('promote', 'Promote', 'pm') + seg('repeat', 'Repeat', 'rep') + seg('leave', 'Leaving', 'lv') + '</span></div>' +
    '<div class="pr-flow">' + esc(p.class_name) + (p.stream_name ? ' ' + esc(p.stream_name) : '') + ' &rarr; ' + o.text + '</div>' + picker + '</div>';
}
function prSheetList() {
  const g = prByClass().find(function (x) { return x.cls.id === pr.openClass; });
  if (!g) return '';
  const q = pr.q.trim().toLowerCase();
  const list = g.students.filter(function (p) { return !q || (p.full_name + ' ' + p.admission_no).toLowerCase().indexOf(q) !== -1; });
  return list.length ? list.map(prStudentCard).join('') : '<div class="pr-empty">No student matches.</div>';
}
function prSheetShell() {
  const g = prByClass().find(function (x) { return x.cls.id === pr.openClass; });
  const cc = prCounts(g.students);
  return '<div class="pr-sh"><div><h2>' + esc(g.cls.name) + '</h2><p>' + g.students.length + ' students &middot; ' + (g.cls.is_final ? 'final class, graduates unless marked' : 'move to ' + esc(g.cls.next_class_name) + ' unless marked') + '</p></div>' +
    '<button type="button" class="pr-x" aria-label="Close" onclick="prCloseSheet()">&#10005;</button></div>' +
    '<div class="pr-search"><input type="search" class="pr-in" id="prSearch" placeholder="Search name or admission number" value="' + esc(pr.q) + '" oninput="prSearchInput(this.value)"></div>' +
    '<div class="pr-sbody" id="prSheetList">' + prSheetList() + '</div>' +
    '<div class="pr-sf"><span class="sum" id="prSheetSum">' + cc.repeat + ' repeating, ' + cc.leave + ' leaving</span><button type="button" class="pr-btn go" onclick="prCloseSheet()">Done</button></div>';
}
function prSheetRefresh() {
  const list = document.getElementById('prSheetList'); if (!list || pr.openClass === null) return;
  const g = prByClass().find(function (x) { return x.cls.id === pr.openClass; }); if (!g) return;
  const keep = list.scrollTop; list.innerHTML = prSheetList(); list.scrollTop = keep;
  const cc = prCounts(g.students);
  const sum = document.getElementById('prSheetSum'); if (sum) sum.textContent = cc.repeat + ' repeating, ' + cc.leave + ' leaving';
}
window.prOpen = function (classId) {
  pr.openClass = classId; pr.q = '';
  let back = document.getElementById('prBack'), sheet = document.getElementById('prSheet');
  if (!back) {
    back = document.createElement('div'); back.id = 'prBack'; back.className = 'pr-back'; back.onclick = prCloseSheet; document.body.appendChild(back);
    sheet = document.createElement('div'); sheet.id = 'prSheet'; sheet.className = 'pr-sheet'; sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true'); sheet.setAttribute('aria-label', 'Review class');
    document.body.appendChild(sheet);
  }
  sheet.innerHTML = prSheetShell();
  requestAnimationFrame(function () { requestAnimationFrame(function () { if (pr.openClass === null) return; back.classList.add('show'); sheet.classList.add('show'); const x = sheet.querySelector('.pr-x'); if (x) x.focus(); }); });
};
window.prCloseSheet = function () {
  pr.openClass = null;
  const b = document.getElementById('prBack'), s = document.getElementById('prSheet');
  if (b) b.classList.remove('show'); if (s) s.classList.remove('show');
  prRender();   // counts on the page behind
};
window.prSearchInput = function (v) { pr.q = v; prSheetRefresh(); };
window.prSetMode = function (id, mode) {
  const p = pr.data.plan.find(function (x) { return x.student_id === id; });
  if (mode === 'promote') delete pr.decisions[id];
  else if (mode === 'leave') pr.decisions[id] = { mode: 'leave' };
  else pr.decisions[id] = { mode: 'repeat', classId: p.class_id, stream: '' };   // starts automatic: the stream with the fewest students
  prSheetRefresh();
};
window.prRepClass = function (id, classId) { classId = Number(classId); pr.decisions[id] = { mode: 'repeat', classId: classId, stream: '' }; prSheetRefresh(); };
window.prRepStream = function (id, name) { const d = pr.decisions[id]; if (d) { d.stream = name; prSheetRefresh(); } };

/* ---------------- running it ---------------- */
function prDialog() {
  let back = document.getElementById('prDlgBack'), dlg = document.getElementById('prDialog');
  if (!back) {
    back = document.createElement('div'); back.id = 'prDlgBack'; back.className = 'pr-back'; back.style.zIndex = 70; back.onclick = function () { if (!pr.running) prCloseDialog(); };
    dlg = document.createElement('div'); dlg.id = 'prDialog'; dlg.className = 'pr-dialog'; dlg.setAttribute('role', 'alertdialog'); dlg.setAttribute('aria-modal', 'true');
    document.body.appendChild(back); document.body.appendChild(dlg);
  }
  return { back: back, dlg: dlg };
}
window.prCloseDialog = function () { const b = document.getElementById('prDlgBack'), d = document.getElementById('prDialog'); if (b) b.classList.remove('show'); if (d) d.classList.remove('show'); };
window.prAsk = async function () {
  const y = pr.data.outgoing.year, n = pr.data.next_year, x = prDialog();
  x.dlg.classList.add('wide');
  const head = '<h3>Run promotion for ' + esc(y) + ' &rarr; ' + esc(n) + '?</h3>';
  x.dlg.innerHTML = head + '<p>Checking exactly where everyone will go&hellip;</p><div class="acts"><button type="button" class="pr-btn" onclick="prCloseDialog()">Cancel</button></div>';
  requestAnimationFrame(function () { x.back.classList.add('show'); x.dlg.classList.add('show'); });
  let plan;
  try { plan = await Api.post(prBase() + '/promotion/plan', { outgoing_academic_year_id: pr.data.outgoing.id, decisions: prDecisionsPayload() }); }
  catch (e) { x.dlg.innerHTML = head + '<p>' + esc(e.message) + '</p><div class="acts"><button type="button" class="pr-btn" onclick="prCloseDialog()">Close</button></div>'; return; }
  const t = plan.summary.totals, rd = plan.readiness;
  const problems = rd && rd.problems.length ? '<div class="pr-note bad" style="margin:0 0 12px"><b>Cannot run yet</b><ul>' + rd.problems.map(function (m) { return '<li>' + esc(m) + '</li>'; }).join('') + '</ul></div>' : '';
  let box = '';
  if (plan.summary.arrivals.length) {
    box += '<div class="blk"><h4>Who will be in each class in ' + esc(n) + '</h4>' + plan.summary.arrivals.map(function (a) {
      const parts = a.streams.map(function (s) { return esc(s.name) + ' ' + s.count; });
      if (a.noStream) parts.push('no stream ' + a.noStream);
      return '<div><b>' + esc(a.class_name) + '</b> &middot; ' + a.total + ' student' + (a.total === 1 ? '' : 's') + (parts.length ? ' &middot; ' + parts.join(', ') : '') + '</div>';
    }).join('') + '</div>';
  }
  if (plan.summary.repeaters.length) {
    box += '<div class="blk"><h4>Repeating</h4>' + plan.summary.repeaters.map(function (r) {
      return '<div><b>' + esc(r.full_name) + '</b> ' + esc(r.admission_no) + ': ' + esc(r.class_name) + (r.from_stream ? ' ' + esc(r.from_stream) : '') + ' &rarr; ' + esc(r.to_class_name) + (r.to_stream ? ' ' + esc(r.to_stream) : ' (no stream)') + ' <span class="why">(' + esc(PR_WHY[r.placement] || '') + ')</span></div>';
    }).join('') + '</div>';
  }
  if (plan.summary.leavers.length) {
    box += '<div class="blk"><h4>Leaving the school</h4>' + plan.summary.leavers.map(function (l) { return '<div><b>' + esc(l.full_name) + '</b> ' + esc(l.admission_no) + ' <span class="why">(' + esc(l.class_name) + ')</span></div>'; }).join('') + '</div>';
  }
  x.dlg.innerHTML = head +
    '<p>This moves every student at once. It cannot be undone, and it can only be run once for ' + esc(y) + '.</p>' + problems +
    '<ul><li><span>Promoting</span><b>' + t.promote + '</b></li><li><span>Repeating</span><b>' + t.repeat + '</b></li><li><span>Leaving school</span><b>' + t.leave + '</b></li><li><span>Graduating</span><b>' + t.graduate + '</b></li></ul>' +
    (box ? '<div class="pr-sumbox">' + box + '</div>' : '') +
    '<div class="acts"><button type="button" class="pr-btn" onclick="prCloseDialog()">Cancel</button><button type="button" class="pr-btn go" id="prRunGo" onclick="prRun()"' + (problems ? ' disabled' : '') + '>Run promotion</button></div>';
  const go = document.getElementById('prRunGo'); if (go && !go.disabled) go.focus();
};
// After a run: what happened, and what the admin should do next (fees lock once a term starts).
function prDone(r, nextYear) {
  const x = prDialog();
  x.dlg.classList.add('wide');
  x.dlg.innerHTML = '<h3>Promotion done</h3><p>The school is now in ' + esc(nextYear) + '.</p>' +
    '<ul><li><span>Promoted</span><b>' + r.promoted + '</b></li><li><span>Repeating</span><b>' + r.repeating + '</b></li><li><span>Left school</span><b>' + r.left + '</b></li><li><span>Graduated</span><b>' + r.graduated + '</b></li></ul>' +
    '<div class="pr-sumbox"><div class="blk"><h4>Next</h4>' +
    '<div>Set the <b>fees</b> for ' + esc(nextYear) + '. Fees are per class and per term, and they lock once a term starts.</div>' +
    '<div>Check the <b>term dates</b> for ' + esc(nextYear) + '.</div>' +
    '<div>Open <b>Classes &amp; streams</b> to see the new year&rsquo;s classes.</div></div></div>' +
    '<div class="acts"><button type="button" class="pr-btn go" id="prDoneOk" onclick="prCloseDialog()">OK</button></div>';
  requestAnimationFrame(function () { x.back.classList.add('show'); x.dlg.classList.add('show'); const b = document.getElementById('prDoneOk'); if (b) b.focus(); });
}
window.prRun = async function () {
  if (pr.running) return; pr.running = true;
  const btn = document.getElementById('prRunGo'); if (btn) { btn.disabled = true; btn.textContent = 'Running...'; }
  const decisions = prDecisionsPayload();
  try {
    const r = await Api.post(prBase() + '/promotion/execute', { outgoing_academic_year_id: pr.data.outgoing.id, incoming_academic_year_id: pr.data.incoming.id, decisions: decisions });
    const nextYear = pr.data.next_year;
    pr.decisions = {}; pr.running = false;
    await prLoad();
    prDone(r, nextYear);
  } catch (e) {
    pr.running = false; prCloseDialog(); prToast(e.message, true); await prLoad();
  }
};
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape') return;
  if (document.getElementById('prDialog') && document.getElementById('prDialog').classList.contains('show') && !pr.running) prCloseDialog();
  else if (pr.openClass !== null) prCloseSheet();
});