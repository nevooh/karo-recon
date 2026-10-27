/* page-admit.js - the Admit student page, connected to the real database.
   Admits ONE student at a time:
   - full name, class and admission number are a must (in that order). The class is chosen from a wide, grouped picker.
   - the admission number takes digits, / and - only; the next number after the last student is suggested once a class is chosen
   - the stream box appears ONLY when the chosen class has streams this year (then it is a must)
   - the class's optional fees load when the class is chosen: tick the ones the family takes
   - parents / guardians are optional, add as many as needed
   - "Check only" tests everything and saves nothing; "Admit student" saves
   Replaces the demo "Admit students" screen. Only an admin can admit (the server checks it too).
   Add to index.html AFTER page-promotion.js:  <script src="js/page-admit.js"></script> */

const adm = {
  classes: null, year: null, error: null,
  classId: '', streamId: '', options: null, optError: null, optLoading: false, optToken: 0,
  chosen: new Set(),
  contacts: [{ name: '', phone: '', relationship: '' }],
  busy: false, err: null, note: null, result: null,
};
const ADM_MAX_CONTACTS = 10;

/* ---------------- styles (added once) ---------------- */
(function () {
  if (document.getElementById('admStyle')) return;
  const css = document.createElement('style');
  css.id = 'admStyle';
  css.textContent = [
    '.adm-wrap{display:grid;grid-template-columns:minmax(0,1fr) 330px;gap:22px;align-items:start}',
    '.adm-card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:6px 22px 22px}',
    '.adm-sec{padding-top:20px}',
    '.adm-sec + .adm-sec{border-top:1px solid var(--line);margin-top:20px}',
    '.adm-h{display:flex;align-items:baseline;gap:10px;margin:0 0 4px;font-family:"Space Grotesk",sans-serif;font-size:15.5px;font-weight:600}',
    '.adm-h small{font-family:inherit;font-weight:400;font-size:12px;color:var(--muted)}',
    '.adm-help{font-size:12.5px;color:var(--muted);margin:0 0 12px;line-height:1.55}',
    '.adm-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}',
    '.adm-grid .full{grid-column:1/-1}',
    '.adm-f label{display:block;font-size:12px;color:var(--muted);margin-bottom:5px}',
    '.adm-f label i{font-style:normal;color:var(--alert);margin-left:3px}',
    '.adm-in{font:inherit;font-size:14px;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:9px;padding:10px 12px;width:100%;min-width:0;box-sizing:border-box}',
    '.adm-in:focus{outline:none;border-color:var(--matched)}',
    '.adm-in:focus-visible{outline:2px solid var(--matched);outline-offset:1px}',
    '.adm-in:disabled{opacity:.55}',
    'select.adm-in{appearance:auto}',
    '.adm-mono{font-family:"IBM Plex Mono",monospace}',
    '.adm-hint{font-size:11.5px;color:var(--muted);margin-top:5px;min-height:15px}',
    '.adm-cg{display:flex;gap:14px;align-items:flex-start;padding:9px 0;border-bottom:1px solid var(--line)}.adm-cg:last-child{border-bottom:0}',
    '.adm-cgl{flex:0 0 118px;font-size:11.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);padding-top:9px}',
    '.adm-cgt{display:flex;gap:8px;flex-wrap:wrap;flex:1}',
    '.adm-ct{font:inherit;font-size:13.5px;border:1px solid var(--line);background:var(--bg);color:var(--ink);border-radius:10px;padding:8px 15px;cursor:pointer;min-width:64px}',
    '.adm-ct:hover{border-color:var(--muted)}.adm-ct.on{border-color:var(--matched);background:rgba(89,179,125,.14);font-weight:600}',
    '.adm-ct:focus-visible{outline:2px solid var(--matched);outline-offset:2px}',
    '.adm-cbox{border:1px solid var(--line);border-radius:12px;padding:2px 14px;background:var(--surface)}',
    '.adm-opts{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
    '.adm-opt{display:flex;align-items:center;gap:11px;padding:11px 13px;border:1px solid var(--line);border-radius:11px;background:var(--bg);cursor:pointer;min-width:0}',
    '.adm-opt:hover{border-color:var(--muted)}',
    '.adm-opt:has(input:checked){border-color:var(--matched);background:rgba(89,179,125,.09)}',
    '.adm-opt input{accent-color:var(--matched);width:17px;height:17px;margin:0;flex-shrink:0}',
    '.adm-opt span{flex:1;min-width:0;font-size:13.5px;overflow:hidden;text-overflow:ellipsis}',
    '.adm-opt b{font-family:"IBM Plex Mono",monospace;font-weight:500;font-size:12px;color:var(--muted)}',
    '.adm-none{font-size:13px;color:var(--muted);padding:12px 14px;border:1px dashed var(--line);border-radius:11px}',
    '.adm-crow{display:grid;grid-template-columns:1.3fr 1fr 1fr auto;gap:8px;margin-bottom:8px;align-items:center}',
    '.adm-x{font:inherit;font-size:14px;width:34px;height:34px;border-radius:50%;border:1px solid var(--line);background:transparent;color:var(--muted);cursor:pointer}',
    '.adm-x:hover{color:var(--alert);border-color:var(--alert)}',
    '.adm-btn{font:inherit;font-size:13.5px;font-weight:600;border-radius:10px;padding:11px 20px;cursor:pointer;border:1px solid var(--line);background:transparent;color:var(--ink)}',
    '.adm-btn:hover:not(:disabled){border-color:var(--muted)}',
    '.adm-btn.go{background:var(--matched);border-color:var(--matched);color:#0E1613}',
    '.adm-btn.go:hover:not(:disabled){filter:brightness(1.08)}',
    '.adm-btn.sm{padding:7px 14px;font-size:12.5px;font-weight:500;border-radius:20px;color:var(--muted)}',
    '.adm-btn:disabled{opacity:.55;cursor:not-allowed}',
    '.adm-btn:focus-visible,.adm-x:focus-visible{outline:2px solid var(--matched);outline-offset:2px}',
    '.adm-actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center;padding-top:22px;margin-top:20px;border-top:1px solid var(--line)}',
    '.adm-actions .hint{font-size:12px;color:var(--muted);margin-left:auto}',
    '.adm-msg{margin-top:18px;padding:12px 15px;border-radius:11px;font-size:13.5px;line-height:1.55}',
    '.adm-msg.bad{background:rgba(226,87,76,.1);border:1px solid rgba(226,87,76,.45);color:var(--ink)}',
    '.adm-msg.ok{background:rgba(89,179,125,.1);border:1px solid rgba(89,179,125,.45)}',
    '.adm-msg b{font-weight:600}',
    '.adm-side{position:sticky;top:18px;background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:20px 22px}',
    '.adm-side h3{margin:0 0 14px;font-family:"Space Grotesk",sans-serif;font-size:15px}',
    '.adm-who{font-family:"Space Grotesk",sans-serif;font-size:19px;font-weight:600;line-height:1.25;min-height:24px;word-break:break-word}',
    '.adm-who.dim{color:var(--muted);font-weight:500}',
    '.adm-sub{font-size:12.5px;color:var(--muted);margin:3px 0 0;font-family:"IBM Plex Mono",monospace}',
    '.adm-line{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid var(--line);font-size:13px}',
    '.adm-line:last-of-type{border-bottom:0}',
    '.adm-line span:first-child{color:var(--muted)}',
    '.adm-line b{font-family:"IBM Plex Mono",monospace;font-weight:500;text-align:right}',
    '.adm-note{margin:14px 0 0;font-size:12px;color:var(--muted);line-height:1.55}',
    '.adm-empty{padding:44px 28px;text-align:center;background:var(--surface);border:1px solid var(--line);border-radius:14px}',
    '.adm-empty h3{font-family:"Space Grotesk",sans-serif;font-size:18px;margin:0 0 6px}',
    '.adm-empty p{color:var(--muted);font-size:13.5px;margin:0 0 18px}',
    '.adm-done{background:var(--surface);border:1px solid var(--matched);border-radius:14px;padding:30px 28px;max-width:640px}',
    '.adm-tick{width:46px;height:46px;border-radius:50%;background:rgba(89,179,125,.16);color:var(--matched);display:flex;align-items:center;justify-content:center;font-size:22px;margin-bottom:14px}',
    '.adm-done h2{font-family:"Space Grotesk",sans-serif;font-size:22px;margin:0 0 4px}',
    '.adm-done .adm-sub{margin-bottom:18px}',
    '.adm-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:var(--surface-raised);border:1px solid var(--matched);color:var(--ink);padding:11px 18px;border-radius:10px;font-size:13px;z-index:99;max-width:90vw}',
    '.adm-toast.bad{border-color:var(--alert)}',
    '@media(max-width:980px){.adm-wrap{grid-template-columns:1fr}.adm-side{position:static}}',
    '@media(max-width:620px){.adm-cg{flex-direction:column;gap:6px}.adm-cgl{flex:none;padding-top:0}.adm-grid,.adm-opts{grid-template-columns:1fr}.adm-crow{grid-template-columns:1fr 1fr}.adm-card{padding:4px 16px 18px}.adm-actions .hint{margin-left:0;width:100%}}',
  ].join('\n');
  document.head.appendChild(css);
})();

/* ---------------- helpers ---------------- */
const admBase = function () { return '/schools/' + live.staff.school_id; };
const admEl = function (id) { return document.getElementById(id); };
const admVal = function (id) { const e = admEl(id); return e ? e.value : ''; };
function admToast(msg, bad) {
  const old = admEl('admToast'); if (old) old.remove();
  const d = document.createElement('div');
  d.id = 'admToast'; d.className = 'adm-toast' + (bad ? ' bad' : ''); d.textContent = msg;
  document.body.appendChild(d);
  setTimeout(function () { if (d.parentNode) d.remove(); }, 3800);
}
function admMoney(n) { return money(Number(n) || 0); }
function admBalance() {                       // the typed starting balance as a number, or null if empty, or NaN if not a number
  const raw = admVal('admBal').replace(/,/g, '').trim();
  if (raw === '') return null;
  return /^-?\d+(\.\d{1,2})?$/.test(raw) ? Number(raw) : NaN;
}
function admClass() { return adm.classes ? adm.classes.find(function (c) { return String(c.id) === String(adm.classId); }) : null; }
function admStreamName() {
  if (!adm.options || !adm.options.needs_stream) return null;
  const s = adm.options.streams.find(function (x) { return String(x.id) === String(adm.streamId); });
  return s ? s.name : null;
}
function admChosenFees() {
  if (!adm.options) return [];
  return adm.options.optional_fees.filter(function (f) { return adm.chosen.has(f.name); });
}
function admSyncContacts() {                  // copy what is typed in the contact rows into the state
  adm.contacts = adm.contacts.map(function (c, i) {
    return { name: admVal('admCn' + i), phone: admVal('admCp' + i), relationship: admVal('admCr' + i) };
  });
}

/* ---------------- the page ---------------- */
views.admit = function () {
  // every visit starts with a clean form
  adm.noSuggested = ''; adm.noTyped = false;
  adm.classId = ''; adm.streamId = ''; adm.options = null; adm.optError = null; adm.optLoading = false; adm.optToken++;
  adm.chosen = new Set(); adm.contacts = [{ name: '', phone: '', relationship: '' }];
  adm.result = null; adm.err = null; adm.note = null; adm.busy = false;
  setTimeout(admLoad, 0);
  return '<div id="admRoot">' + admBody() + '</div>';
};

window.admLoad = async function () {
  adm.error = null;
  try {
    const o = await Api.get(admBase() + '/classes-overview');
    adm.year = o.year;
    adm.classes = o.classes.filter(function (c) { return c.enabled; });
  } catch (e) { adm.error = e.message; }
  admRender();
};
function admRender() { const r = admEl('admRoot'); if (r) r.innerHTML = admBody(); admAfterRender(); }

function admHead(sub) {
  return '<div class="topbar"><div><h1>Admit student</h1><p class="sub">' + sub + '</p></div></div>';
}
function admBody() {
  if (live.staff.role !== 'admin') {
    return admHead('One student at a time') + '<div class="adm-empty"><h3>Only a school admin can admit students</h3><p>Admitting a student creates fees the family owes, so it is kept to admins. Ask your school admin to do it.</p></div>';
  }
  if (adm.error) return admHead('One student at a time') + '<div class="adm-empty"><h3>Could not load the classes</h3><p>' + esc(adm.error) + '</p><button type="button" class="adm-btn" onclick="admLoad()">Try again</button></div>';
  if (!adm.classes) return admHead('One student at a time') + '<div class="adm-empty"><p>Loading&hellip;</p></div>';
  if (!adm.classes.length) {
    return admHead('One student at a time') + '<div class="adm-empty"><h3>No classes are switched on yet</h3><p>Choose the classes your school runs first. A student cannot be admitted without a class.</p>' +
      '<button type="button" class="adm-btn go" onclick="showView(\'classes\')">Go to Classes &amp; streams</button></div>';
  }
  if (adm.result && !adm.result.dry) return admHead('Student admitted') + admDoneHtml(adm.result);
  return admHead('One student at a time' + (adm.year ? ' &middot; ' + adm.year.year : '')) +
    '<div class="adm-wrap"><form class="adm-card" id="admForm" novalidate onsubmit="return admSubmit(event,false)" autocomplete="off">' +
    '<div class="adm-sec"><div class="adm-h">Student</div><div class="adm-grid">' +
    '<div class="adm-f full"><label for="admName">Full name<i>*</i></label><input class="adm-in" id="admName" maxlength="100" oninput="admSummary()"></div>' +
    '<div class="adm-f full"><label id="admClassLbl">Class<i>*</i></label><div id="admClassBox" role="group" aria-labelledby="admClassLbl">' + admClassPicker() + '</div></div>' +
    '<div class="adm-f"><label for="admNo">Admission number<i>*</i></label><input class="adm-in adm-mono" id="admNo" maxlength="40" inputmode="text" autocomplete="off" oninput="admNoInput(this)">' +
    '<div class="adm-hint" id="admNoHint">Digits, and / or - if your school writes it that way.</div></div>' +
    '<div class="adm-f" id="admStreamBox"></div></div></div>' +
    '<div class="adm-sec" id="admOptBox"></div>' +
    '<div class="adm-sec"><div class="adm-h">Parents or guardians <small>optional</small></div>' +
    '<p class="adm-help">Add as many contacts as you need. None is required.</p><div id="admContacts"></div></div>' +
    '<div class="adm-sec"><div class="adm-h">Balance brought forward <small>optional</small></div>' +
    '<p class="adm-help">Money the family already owed before joining this system. If they paid ahead, put a minus in front.</p>' +
    '<div class="adm-grid"><div class="adm-f"><label for="admBal">Amount (KES)</label><input class="adm-in adm-mono" id="admBal" inputmode="decimal" placeholder="0" oninput="admSummary()"></div></div></div>' +
    '<div id="admMsg" aria-live="polite"></div>' +
    '<div class="adm-actions"><button type="submit" class="adm-btn go" id="admGo">Admit student</button>' +
    '<button type="button" class="adm-btn" id="admCheck" onclick="admSubmit(event,true)">Check only</button>' +
    '<span class="hint">Check only tests everything and saves nothing.</span></div></form>' +
    '<aside class="adm-side" id="admSide"></aside></div>';
}
function admAfterRender() {
  if (!admEl('admForm')) return;
  admClassPart(); admContactsRender(); admSummary(); admMsgRender();
}

/* ---------------- class, stream and optional fees ---------------- */
window.admPickClass = async function (value) {
  adm.classId = value; adm.streamId = ''; adm.options = null; adm.optError = null; adm.chosen = new Set(); adm.note = null;
  const token = ++adm.optToken;
  const box = admEl('admClassBox'); if (box) box.innerHTML = admClassPicker();
  if (!value) { admClassPart(); admSummary(); return; }
  adm.optLoading = true; admClassPart(); admSummary();
  try {
    const o = await Api.get(admBase() + '/admission-options?class_id=' + encodeURIComponent(value));
    if (token !== adm.optToken) return;                       // the person picked another class meanwhile
    adm.options = o;
    if (o.needs_stream && o.streams.length === 1) adm.streamId = String(o.streams[0].id);
  } catch (e) { if (token !== adm.optToken) return; adm.optError = e.message; }
  adm.optLoading = false; admClassPart(); admSuggestNumber(); admSummary();
};
// the classes this school runs, grouped by stage (Pre-primary, Lower primary...), as buttons across the full width
function admClassPicker() {
  if (!adm.classes) return '';
  const groups = [];
  adm.classes.forEach(function (c) {
    const name = typeof clsStage === 'function' ? clsStage(c.sort_order) : 'Classes';
    let g = groups.find(function (x) { return x.name === name; });
    if (!g) { g = { name: name, items: [] }; groups.push(g); }
    g.items.push(c);
  });
  return '<div class="adm-cbox">' + groups.map(function (g) {
    return '<div class="adm-cg"><div class="adm-cgl">' + esc(g.name) + '</div><div class="adm-cgt">' + g.items.map(function (c) {
      return '<button type="button" class="adm-ct' + (String(c.id) === String(adm.classId) ? ' on' : '') + '" aria-pressed="' + (String(c.id) === String(adm.classId)) + '" onclick="admPickClass(\'' + c.id + '\')">' + esc(c.name) + '</button>';
    }).join('') + '</div></div>';
  }).join('') + '</div>';
}
// the admission number takes digits, / and - only; typing anything else does nothing
window.admNoInput = function (el) {
  const clean = el.value.replace(/[^0-9\/\-]/g, '');
  if (clean !== el.value) el.value = clean;
  adm.noTyped = clean !== '' && clean !== adm.noSuggested;
  admSummary();
};
function admSuggestNumber() {
  const o = adm.options, inp = admEl('admNo'), hint = admEl('admNoHint'); if (!inp) return;
  const untouched = inp.value === '' || inp.value === adm.noSuggested;
  if (o && o.next_admission_no && untouched) { inp.value = o.next_admission_no; adm.noSuggested = o.next_admission_no; adm.noTyped = false; }
  if (hint) hint.textContent = o && o.next_admission_no && inp.value === adm.noSuggested ? 'Suggested: the next number after the last student. Change it if it is not the right one.' : 'Digits, and / or - if your school writes it that way.';
}
function admClassPart() {
  const sb = admEl('admStreamBox'), ob = admEl('admOptBox');
  if (!sb || !ob) return;
  const o = adm.options;
  // stream: only when the class has streams
  if (o && o.needs_stream) {
    sb.style.display = '';
    sb.innerHTML = '<label for="admStream">Stream<i>*</i></label><select class="adm-in" id="admStream" onchange="admPickStream(this.value)"><option value="">Choose a stream</option>' +
      o.streams.map(function (s) { return '<option value="' + s.id + '"' + (String(s.id) === String(adm.streamId) ? ' selected' : '') + '>' + esc(s.name) + '</option>'; }).join('') + '</select>';
  } else { sb.style.display = 'none'; sb.innerHTML = ''; }
  // optional fees
  if (!adm.classId) { ob.style.display = 'none'; ob.innerHTML = ''; return; }
  ob.style.display = '';
  if (adm.optLoading) { ob.innerHTML = '<div class="adm-h">Optional fees</div><p class="adm-help">Loading what this class offers&hellip;</p>'; return; }
  if (adm.optError) { ob.innerHTML = '<div class="adm-h">Optional fees</div><div class="adm-msg bad">' + esc(adm.optError) + '</div>'; return; }
  const term = o && o.term ? 'Term ' + o.term.term_number + ' ' + o.term.year : null;
  const head = '<div class="adm-h">Optional fees' + (term ? ' <small>' + esc(term) + '</small>' : '') + '</div>';
  if (!o || !o.optional_fees.length) {
    ob.innerHTML = head + '<div class="adm-none">' + (term ? 'This class has no optional fees set for ' + esc(term) + '.' : 'No term has dates yet, so there are no fees to show.') + '</div>';
    return;
  }
  ob.innerHTML = head + '<p class="adm-help">Tick the ones this family takes. They stay with the student from term to term while the class offers them.</p><div class="adm-opts">' +
    o.optional_fees.map(function (f, i) {
      return '<label class="adm-opt"><input type="checkbox" value="' + i + '"' + (adm.chosen.has(f.name) ? ' checked' : '') + ' onchange="admToggleFee(' + i + ',this.checked)"><span>' + esc(f.name) + '</span> <b>' + admMoney(f.amount) + '</b></label>';
    }).join('') + '</div>';
}
window.admPickStream = function (v) { adm.streamId = v; admSummary(); };
window.admToggleFee = function (i, on) {
  const f = adm.options && adm.options.optional_fees[i]; if (!f) return;
  if (on) adm.chosen.add(f.name); else adm.chosen.delete(f.name);
  admSummary();
};

/* ---------------- contacts ---------------- */
function admContactsRender() {
  const box = admEl('admContacts'); if (!box) return;
  const rows = adm.contacts.map(function (c, i) {
    return '<div class="adm-crow"><input class="adm-in" id="admCn' + i + '" maxlength="100" placeholder="Full name" aria-label="Contact ' + (i + 1) + ' name" value="' + esc(c.name) + '">' +
      '<input class="adm-in adm-mono" id="admCp' + i + '" inputmode="tel" maxlength="20" placeholder="Phone" aria-label="Contact ' + (i + 1) + ' phone" value="' + esc(c.phone) + '">' +
      '<input class="adm-in" id="admCr' + i + '" maxlength="30" list="admRel" placeholder="Relationship" aria-label="Contact ' + (i + 1) + ' relationship" value="' + esc(c.relationship) + '">' +
      '<button type="button" class="adm-x" aria-label="Remove contact ' + (i + 1) + '" onclick="admRemoveContact(' + i + ')">&#10005;</button></div>';
  }).join('');
  box.innerHTML = rows + '<datalist id="admRel"><option value="Mother"><option value="Father"><option value="Guardian"><option value="Uncle"><option value="Aunt"><option value="Grandparent"><option value="Sibling"></datalist>' +
    (adm.contacts.length < ADM_MAX_CONTACTS ? '<button type="button" class="adm-btn sm" onclick="admAddContact()">+ Add another contact</button>' : '<p class="adm-help">That is the most contacts one student can have (' + ADM_MAX_CONTACTS + ').</p>');
}
window.admAddContact = function () {
  admSyncContacts();
  if (adm.contacts.length >= ADM_MAX_CONTACTS) return;
  adm.contacts.push({ name: '', phone: '', relationship: '' });
  admContactsRender();
  const last = admEl('admCn' + (adm.contacts.length - 1)); if (last) last.focus();
};
window.admRemoveContact = function (i) {
  admSyncContacts();
  adm.contacts.splice(i, 1);
  if (!adm.contacts.length) adm.contacts.push({ name: '', phone: '', relationship: '' });
  admContactsRender();
};

/* ---------------- the summary beside the form ---------------- */
function admSummary() {
  const side = admEl('admSide'); if (!side) return;
  const name = admVal('admName').trim(), no = admVal('admNo').trim();
  const c = admClass(), stream = admStreamName(), chosen = admChosenFees(), bal = admBalance();
  const optTotal = chosen.reduce(function (a, f) { return a + Number(f.amount); }, 0);
  const term = adm.options && adm.options.term ? 'Term ' + adm.options.term.term_number + ' ' + adm.options.term.year : null;
  const line = function (k, v) { return '<div class="adm-line"><span>' + k + '</span><b>' + v + '</b></div>'; };
  let html = '<h3>Summary</h3><div class="adm-who' + (name ? '' : ' dim') + '">' + (name ? esc(name) : 'New student') + '</div>' +
    '<div class="adm-sub">' + (no ? esc(no) : 'admission number') + '</div><div style="height:12px"></div>' +
    line('Class', c ? esc(c.name) + (stream ? ' &middot; ' + esc(stream) : '') : '&mdash;') +
    line('Billed for', term ? esc(term) : '&mdash;') +
    line('Optional fees', chosen.length ? chosen.map(function (f) { return esc(f.name); }).join(', ') : 'none');
  if (chosen.length) html += line('Optional total', admMoney(optTotal));
  html += line('Brought forward', bal === null ? 'none' : (Number.isNaN(bal) ? '<span style="color:var(--alert)">not a number</span>' : admMoney(bal)));
  html += '<p class="adm-note">The class\'s standard fees are added automatically. If the term has already begun, the student is billed as soon as you admit them.</p>';
  side.innerHTML = html;
}
window.admSummary = admSummary;

/* ---------------- check and admit ---------------- */
function admMsgRender() {
  const box = admEl('admMsg'); if (!box) return;
  if (adm.err) box.innerHTML = '<div class="adm-msg bad" role="alert">' + esc(adm.err) + '</div>';
  else if (adm.note) box.innerHTML = '<div class="adm-msg ok">' + adm.note + '</div>';
  else box.innerHTML = '';
  const go = admEl('admGo'), ck = admEl('admCheck');
  if (go) go.disabled = adm.busy; if (ck) ck.disabled = adm.busy;
}
function admFail(msg) {
  adm.err = msg; adm.note = null; adm.busy = false; admMsgRender();
  const box = admEl('admMsg'); if (box && box.scrollIntoView) box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
window.admSubmit = async function (ev, dry) {
  if (ev && ev.preventDefault) ev.preventDefault();
  if (adm.busy) return false;
  adm.err = null; adm.note = null;
  const no = admVal('admNo').trim(), name = admVal('admName').trim();
  if (!no) { admFail('Enter the admission number.'); admEl('admNo').focus(); return false; }
  if (name.length < 2) { admFail('Enter the full name of the student.'); admEl('admName').focus(); return false; }
  if (!adm.classId) { admFail('Choose the class. A student cannot be admitted without one.'); const cb = admEl('admClassBox'); if (cb && cb.querySelector('button')) cb.querySelector('button').focus(); return false; }
  if (adm.optLoading) { admFail('Wait a moment, the class details are still loading.'); return false; }
  if (!adm.options) { admFail(adm.optError || 'The class details did not load. Choose the class again.'); return false; }
  if (adm.options.needs_stream && !adm.streamId) { admFail('Choose a stream for ' + admClass().name + '.'); const s = admEl('admStream'); if (s) s.focus(); return false; }
  const bal = admBalance();
  if (Number.isNaN(bal)) { admFail('The balance brought forward must be a number, for example 12500. Use a minus if the family paid ahead.'); admEl('admBal').focus(); return false; }

  admSyncContacts();
  const body = {
    admission_no: no, full_name: name, class_id: Number(adm.classId),
    contacts: adm.contacts.filter(function (c) { return c.name.trim() || c.phone.trim() || c.relationship.trim(); }),
    optional_fees: admChosenFees().map(function (f) { return f.name; }),
    dry: !!dry,
  };
  if (adm.options.needs_stream) body.stream_id = Number(adm.streamId);
  if (bal !== null) body.starting_balance = bal;

  adm.busy = true; admMsgRender();
  try {
    const r = await Api.post(admBase() + '/students', body);
    adm.busy = false;
    if (dry) { adm.note = admCheckText(r); admMsgRender(); return false; }
    adm.result = r; admRender(); window.scrollTo(0, 0);
    admToast('Admitted ' + r.student.full_name);
  } catch (e) { admFail(e.message); }
  return false;
};
function admBilledText(r) {
  if (r.billed) return 'Fees ' + admMoney(r.billed.fees) + (r.billed.starting_balance ? ' &middot; brought forward ' + admMoney(r.billed.starting_balance) : '') + ' &middot; owes <b>' + admMoney(r.billed.owed) + '</b>';
  return 'Not billed yet: Term ' + r.term.term_number + ' ' + r.term.year + ' has not begun. The student is billed automatically on its first day.';
}
function admCheckText(r) {
  return '<b>Everything checks out. Nothing was saved.</b><br>' + esc(r.student.full_name) + ' would join ' + esc(r.student.class) + (r.student.stream ? ' &middot; ' + esc(r.student.stream) : '') + '. ' + admBilledText(r);
}

/* ---------------- after a successful admission ---------------- */
function admDoneHtml(r) {
  const s = r.student;
  const line = function (k, v) { return '<div class="adm-line"><span>' + k + '</span><b>' + v + '</b></div>'; };
  return '<div class="adm-done"><div class="adm-tick">&#10003;</div><h2>' + esc(s.full_name) + ' is admitted</h2>' +
    '<div class="adm-sub">' + esc(s.admission_no) + '</div>' +
    line('Class', esc(s.class) + (s.stream ? ' &middot; ' + esc(s.stream) : '')) +
    line('Term', 'Term ' + r.term.term_number + ' ' + r.term.year) +
    line('Optional fees', r.optional_fees.length ? r.optional_fees.map(esc).join(', ') : 'none') +
    line('Contacts', String(r.contacts)) +
    line('Billing', admBilledText(r)) +
    '<div class="adm-actions" style="border-top:0;margin-top:8px;padding-top:14px;">' +
    '<button type="button" class="adm-btn go" onclick="admAnother(true)">Admit another in ' + esc(s.class) + '</button>' +
    '<button type="button" class="adm-btn" onclick="admAnother(false)">Admit in another class</button></div></div>';
}
window.admAnother = function (sameClass) {
  const keepClass = sameClass && adm.classId, keepStream = sameClass && adm.streamId, keepOptions = sameClass ? adm.options : null;
  adm.result = null; adm.err = null; adm.note = null; adm.busy = false;
  adm.contacts = [{ name: '', phone: '', relationship: '' }]; adm.chosen = new Set();
  adm.classId = keepClass || ''; adm.streamId = keepStream || ''; adm.options = keepOptions; adm.optError = null; adm.optLoading = false;
  admRender();
  const n = admEl('admName'); if (n) n.focus();
};