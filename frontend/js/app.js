/* ============================================================ HELPERS ============================================================ */
function money(n){ const abs = Math.abs(n).toLocaleString(); return (n < 0 ? '\u2212KES ' : 'KES ') + abs; }
function chipFor(source){ const map = { mpesa:'M-Pesa', equity:'Equity', kcb:'KCB', coop:'Co-op' }; return '<span class="chip ' + source + '">' + (map[source] || source) + '</span>'; }

/* ============================================================ AUTH ============================================================ */
function goToLogin(){
  document.getElementById('landingScreen').style.display = 'none';
  document.getElementById('loginScreen').style.display = 'flex';
}
function backToLanding(){
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('landingScreen').style.display = 'block';
}
function attemptLogin(){
  const pw = document.getElementById('loginPassword').value;
  const errBox = document.getElementById('loginErr');
  if (!pw) {
    errBox.textContent = 'Enter any password to continue (this is a visual demo, not a real login check)';
    errBox.classList.add('show');
    return;
  }
  errBox.classList.remove('show');
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('mainApp').style.display = 'grid';
  showView('dashboard');
}
function skipLogin(){
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('mainApp').style.display = 'grid';
  showView('dashboard');
}
function logout(){
  document.getElementById('mainApp').style.display = 'none';
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('landingScreen').style.display = 'block';
  document.getElementById('loginPassword').value = '';
}

/* ============================================================ VIEW RENDERERS ============================================================ */

function renderDashboard(){
  const auto = summary.find(function(s){return s.match_status==='auto_matched';}) || {count:0,total:0};
  const review = summary.find(function(s){return s.match_status==='needs_review';}) || {count:0,total:0};
  const unmatchedS = summary.find(function(s){return s.match_status==='unmatched';}) || {count:0,total:0};
  let rowsHtml = '';
  reviewQueue.concat(unmatched).forEach(function(t){
    rowsHtml += '<div class="prow pending">' +
      '<div>' + chipFor(t.source) + '</div>' +
      '<div><div class="who">' + (t.payer_name||'Unknown') + '</div><div class="ref">' + (t.narration||'no reference') + '</div></div>' +
      '<div class="amt">' + money(t.amount) + '</div>' +
      '<div class="status review"><span class="sw"></span>' + (t.match_reason?'Needs review':'Unmatched') + '</div>' +
      '<div style="font-size:11.5px;color:var(--muted);">' + (t.match_reason||'No plausible candidate') + '</div>' +
    '</div>';
  });
  return '' +
    '<div class="topbar"><div><h1>' + schoolName + '</h1><p class="sub">Fee reconciliation overview &middot; Term 2, 2026</p></div>' +
      '<div class="totals-row">' +
        '<div class="stat good"><div class="n">' + money(auto.total) + '</div><div class="l">Auto-matched (' + auto.count + ')</div></div>' +
        '<div class="stat mid"><div class="n">' + money(review.total) + '</div><div class="l">Needs review (' + review.count + ')</div></div>' +
        '<div class="stat warn"><div class="n">' + money(unmatchedS.total) + '</div><div class="l">Unmatched (' + unmatchedS.count + ')</div></div>' +
      '</div></div>' +
    '<h2>Recent activity</h2>' +
    '<div class="panel"><div class="prow-head"><div>Channel</div><div>Payer</div><div>Amount</div><div>Status</div><div>Reason</div></div>' + rowsHtml + '</div>';
}

function renderReviewQueue(){
  let cardsHtml = '';
  reviewQueue.forEach(function(t){
    let inner = '';
    if (t.candidates) {
      let candHtml = '';
      t.candidates.forEach(function(c, i){
        candHtml += '<label class="candidate-opt"><span><input type="radio" name="cand-' + t.id + '" ' + (i===0?'checked':'') + '> ' + c.full_name + ' <span class="adm">' + c.admission_no + '</span></span><span class="conf">' + Math.round(c.score*100) + '%</span></label>';
      });
      inner = '<div class="sibling-label">&#9670; Likely siblings &mdash; pick one</div><div class="candidates">' + candHtml + '</div>';
    } else {
      inner = '<div class="suggest">Suggested: <b>' + t.suggested_student_name + '</b> <span class="adm">' + t.suggested_admission_no + '</span><span class="conf">' + Math.round(t.confidence*100) + '%</span></div>' +
              '<div style="font-size:11px;color:var(--muted);margin-bottom:9px;">' + t.match_reason + '</div>';
    }
    cardsHtml += '<div class="card ' + (t.candidates?'sibling':'') + '">' +
      '<div class="card-top"><span>' + chipFor(t.source) + ' &middot; ' + (t.narration || 'no reference') + '</span><span>#' + t.id + '</span></div>' +
      '<div class="card-amt">' + money(t.amount) + '</div>' +
      '<div class="card-raw">From: ' + (t.payer_name||'Unknown') + (t.payer_phone?' &middot; '+t.payer_phone:'') + '</div>' +
      inner +
      '<div class="actions"><button class="btn" onclick="rejectTxn(' + t.id + ')">Reject</button><button class="btn primary" onclick="confirmTxn(' + t.id + ')">Confirm</button></div>' +
    '</div>';
  });
  let unmatchedHtml = '';
  unmatched.forEach(function(t){
    unmatchedHtml += '<div class="card" style="border-left-color:var(--muted);">' +
      '<div class="card-top"><span>' + chipFor(t.source) + '</span><span>' + t.received_at + '</span></div>' +
      '<div class="card-amt">' + money(t.amount) + '</div>' +
      '<div class="card-raw">' + t.payer_name + ' &middot; ' + (t.payer_phone||'no phone') + '</div>' +
      '<button class="btn wide small">Assign manually</button>' +
    '</div>';
  });
  return '' +
    '<div class="topbar"><div><h1>Review queue</h1><p class="sub">' + reviewQueue.length + ' payments need a decision before they touch a balance</p></div></div>' +
    '<div class="cols"><div>' + cardsHtml + '</div>' +
    '<div><h2 style="margin-top:0;">Unmatched (' + unmatched.length + ')</h2><p class="sub" style="margin-bottom:12px;">No plausible student at all.</p>' + unmatchedHtml + '</div></div>';
}

function renderRoster(){
  let rowsHtml = '';
  roster.forEach(function(s){
    const balHtml = s.balance===0 ? 'Paid up' : (money(s.balance) + (s.balance<0?' credit':' due'));
    const balClass = s.balance>0?'due':(s.balance<0?'credit':'clear');
    rowsHtml += '<tr class="clickable-row" onclick="showView(\'studentdetail\')">' +
      '<td data-label="Admission"><span class="adm">' + s.admission_no + '</span></td>' +
      '<td data-label="Name"><span class="name">' + s.full_name + '</span></td>' +
      '<td data-label="Class">' + s.class_name + (s.stream_name?' &middot; <span class="stream-tag">'+s.stream_name+'</span>':'') + '</td>' +
      '<td data-label="Status"><span class="badge ' + (s.status==='repeating'?'repeat':'active') + '">' + s.status + '</span></td>' +
      '<td data-label="Balance"><span class="bal ' + balClass + '">' + balHtml + '</span></td>' +
    '</tr>';
  });
  return '' +
    '<div class="topbar"><div><h1>Roster</h1><p class="sub">' + roster.length + ' students &middot; balances from the live term ledger</p></div>' +
    '<button class="btn primary small" onclick="showView(\'admit\')">+ Admit students</button></div>' +
    '<div class="gradebar"><div class="gpill on">All classes</div><div class="gpill">Grade 1</div><div class="gpill">Grade 2</div><div class="gpill">Grade 3</div></div>' +
    '<table><thead><tr><th>Admission</th><th>Name</th><th>Class</th><th>Status</th><th>Balance</th></tr></thead><tbody>' + rowsHtml + '</tbody></table>';
}

/* ---------- ADMIT STUDENTS (bulk upload + manual) ---------- */
function renderAdmit(){
  let previewHtml = '';
  if (bulkAdmitPreview.length) {
    let rows = '';
    bulkAdmitPreview.forEach(function(s, i){
      const warn = !s.admission_no || !s.full_name;
      rows += '<tr class="' + (warn?'warn-row':'') + '">' +
        '<td data-label="Admission">' + (s.admission_no || '<i>missing</i>') + '</td>' +
        '<td data-label="Name">' + (s.full_name || '<i>missing</i>') + '</td>' +
        '<td data-label="Class">' + (s.class_name || 'Unassigned') + '</td>' +
        '<td data-label="Balance">' + money(s.balance||0) + '</td>' +
      '</tr>';
    });
    previewHtml = '<h2>Preview (' + bulkAdmitPreview.length + ' rows)</h2>' +
      '<p class="sub">Rows in orange are missing required fields &mdash; fix your file and re-upload, or edit before confirming.</p>' +
      '<table class="preview-table"><thead><tr><th>Admission</th><th>Name</th><th>Class</th><th>Opening balance</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<button class="btn primary wide" style="margin-top:14px;" onclick="openModal(\'Admit ' + bulkAdmitPreview.length + ' students\',\'This adds every valid row above to the roster in one action.\')">Admit all ' + bulkAdmitPreview.length + ' students</button>';
  }
  return '' +
    '<div class="topbar"><div><h1>Admit students</h1><p class="sub">Bulk upload a class list, or add one student manually</p></div></div>' +
    '<div class="cols" style="grid-template-columns:1fr 1fr;">' +
      '<div class="panel pad">' +
        '<h3>Bulk upload</h3><p class="sub" style="margin-bottom:10px;">Paste a CSV-style list: admission number, full name, class, opening balance &mdash; one student per line.</p>' +
        '<textarea id="bulkText" placeholder="ADM301, Alice Wanjiru, Grade 1, 5000\nADM302, Brian Kamau, Grade 1, 4500\nADM303, Cynthia Otieno, PP2, 3000"></textarea>' +
        '<button class="btn primary wide" style="margin-top:10px;" onclick="parseBulkAdmit()">Preview list</button>' +
        '<div class="upload-zone" style="margin-top:10px;">Or drop a scanned/exported class list here (image or spreadsheet)</div>' +
        '<p class="hint">Tip: a photo of a school\'s printed class register can be sent for transcription first, then pasted here as text.</p>' +
      '</div>' +
      '<div class="panel pad">' +
        '<h3>Add one student</h3>' +
        '<label class="field">Admission number</label><input type="text" placeholder="e.g. ADM301">' +
        '<label class="field">Full name</label><input type="text" placeholder="Student name">' +
        '<div class="form-grid"><div><label class="field">Class</label><select><option>PP1</option><option>PP2</option><option>Grade 1</option><option>Grade 2</option></select></div>' +
        '<div><label class="field">Stream (if any)</label><select><option>&mdash; none &mdash;</option><option>North</option><option>South</option></select></div></div>' +
        '<div class="form-grid"><div><label class="field">Guardian phone</label><input type="tel" placeholder="2547..."></div>' +
        '<div><label class="field">Opening balance</label><input type="number" placeholder="0"></div></div>' +
        '<button class="btn primary wide" style="margin-top:14px;">Add student</button>' +
      '</div>' +
    '</div>' +
    previewHtml;
}
function parseBulkAdmit(){
  const raw = document.getElementById('bulkText').value.trim();
  if (!raw) return;
  bulkAdmitPreview = raw.split('\n').filter(function(l){return l.trim();}).map(function(line){
    const parts = line.split(',').map(function(p){return p.trim();});
    return { admission_no: parts[0]||'', full_name: parts[1]||'', class_name: parts[2]||'', balance: Number(parts[3])||0 };
  });
  showView('admit');
}

function renderFeeStructure(){
  const cls = feeViewSelectedClass;
  const termId = feeViewSelectedTerm;
  const data = (feeStructureData[cls] && feeStructureData[cls][termId]) || { version: 0, items: [], history: [] };

  let classStripHtml = '';
  enabledClassesForFeeView.forEach(function(c){
    classStripHtml += '<div class="fee-class-tab ' + (c===cls?'on':'') + '" onclick="selectFeeClass(\'' + c + '\')">' + c + '</div>';
  });

  let termTabsHtml = '';
  termTabs.forEach(function(t){
    termTabsHtml += '<div class="fee-term-tab ' + (t.id===termId?'on':'') + '" onclick="selectFeeTerm(' + t.id + ')">' + t.label + '</div>';
  });

  let mandatoryTotal = 0, optionalTotal = 0;
  data.items.forEach(function(f){ if (f.is_mandatory) mandatoryTotal += f.amount; else optionalTotal += f.amount; });
  const grandTotal = mandatoryTotal + optionalTotal;

  let itemsHtml = '';
  if (data.items.length === 0) {
    itemsHtml = '<div class="empty">No fees set for ' + cls + ' yet this term.</div>';
  } else {
    data.items.forEach(function(f){
      itemsHtml += '<tr><td data-label="Fee">' + f.name + '</td><td data-label="Amount"><span class="amt">' + money(f.amount) + '</span></td>' +
        '<td data-label="Type"><span class="badge ' + (f.is_mandatory?'active':'repeat') + '">' + (f.is_mandatory?'Mandatory':'Optional') + '</span></td></tr>';
    });
  }

  let historyHtml = '';
  if (data.history.length > 0) {
    data.history.slice().reverse().forEach(function(h){
      historyHtml += '<span class="history-pill">v' + h.version + ' <del>' + h.name + ' ' + money(h.amount) + '</del></span>';
    });
  }

  return '' +
    '<div class="topbar"><div><h1>Fee structure</h1><p class="sub">Tap a class, then a term &mdash; each keeps its own independent version</p></div></div>' +
    '<div class="fee-class-strip">' + classStripHtml + '</div>' +
    '<div class="fee-term-strip">' + termTabsHtml + '</div>' +
    '<div class="fee-header-row">' +
      '<h2 style="margin:0;display:flex;align-items:center;gap:8px;">' + cls + ' <span class="badge version">v' + data.version + '</span></h2>' +
      '<button class="btn small primary" onclick="openAddFeeForm()">+ Add fee</button>' +
    '</div>' +
    '<div class="fee-totals">' +
      '<div class="fee-total-card"><div class="l">Mandatory</div><div class="n">' + money(mandatoryTotal) + '</div></div>' +
      '<div class="fee-total-card"><div class="l">Optional</div><div class="n">' + money(optionalTotal) + '</div></div>' +
      '<div class="fee-total-card grand"><div class="l">Total</div><div class="n">' + money(grandTotal) + '</div></div>' +
    '</div>' +
    '<table><thead><tr><th>Fee</th><th>Amount</th><th>Type</th></tr></thead><tbody>' + itemsHtml + '</tbody></table>' +
    (historyHtml ? '<h2>Version history</h2><div class="history-strip">' + historyHtml + '</div>' : '') +
    (feeAddFormOpen ? renderAddFeeForm() : '') +
    '<p class="hint" style="margin-top:18px;">The billing system only ever reads the current version above &mdash; older versions are archived, never live, so a past charge can never silently change.</p>';
}

function renderAddFeeForm(){
  let checklistHtml = '';
  enabledClassesForFeeView.forEach(function(c){
    checklistHtml += '<label class="opt-fee-row"><span>' + c + (c===feeViewSelectedClass?' <span class="hint" style="display:inline;">(current)</span>':'') + '</span>' +
      '<input type="checkbox" ' + (feeAddMultiClasses[c]?'checked':'') + ' onchange="toggleFeeAddClass(\'' + c + '\')"></label>';
  });
  return '' +
    '<div class="panel pad" style="margin-top:14px;border:1px solid var(--matched);">' +
      '<h3 style="margin-top:0;">Add a fee</h3>' +
      '<div class="form-grid">' +
        '<div><label class="field">Fee name</label><input type="text" placeholder="e.g. Tuition, Transport"></div>' +
        '<div><label class="field">Amount</label><input type="number" placeholder="0"></div>' +
      '</div>' +
      '<label class="field">Type</label>' +
      '<div class="decision-opts"><button class="dopt on promote">Mandatory</button><button class="dopt">Optional</button></div>' +
      '<h3 style="margin:18px 0 4px;">Apply to multiple classes at once</h3>' +
      '<p class="hint" style="margin-top:0;">Optional &mdash; each ticked class gets its own independent fee row and version, starting from the same numbers. Editing one later never affects the others.</p>' +
      '<div class="panel" style="margin-top:8px;">' + checklistHtml + '</div>' +
      '<div class="actions" style="margin-top:14px;">' +
        '<button class="btn" onclick="closeAddFeeForm()">Cancel</button>' +
        '<button class="btn primary" onclick="confirmSaveFee()">Save fee</button>' +
      '</div>' +
    '</div>';
}

function selectFeeClass(c){ feeViewSelectedClass = c; window.__feeUiState.lastFeeClass = c; feeAddFormOpen = false; showView('feestructure'); }
function selectFeeTerm(t){ feeViewSelectedTerm = t; feeAddFormOpen = false; showView('feestructure'); }
function openAddFeeForm(){
  feeAddFormOpen = true;
  feeAddMultiClasses = {};
  feeAddMultiClasses[feeViewSelectedClass] = true;
  showView('feestructure');
}
function closeAddFeeForm(){ feeAddFormOpen = false; showView('feestructure'); }
function toggleFeeAddClass(c){ feeAddMultiClasses[c] = !feeAddMultiClasses[c]; showView('feestructure'); }
function confirmSaveFee(){
  const count = Object.values(feeAddMultiClasses).filter(Boolean).length;
  const termLabel = termTabs.find(function(t){ return t.id === feeViewSelectedTerm; }).label;
  openModal('Save fee', 'This creates a new version for ' + count + ' class(es) in ' + termLabel + ' - each independently, and only if that term has not started yet.');
}

/* ---------- PROMOTION - tap a class opens a slide-in review panel ---------- */
const allClassesList = ['Grade 1', 'Grade 2', 'Grade 3', 'Grade 4'];
const classStreamsMap = { 'Grade 1': ['Y','G','R'], 'Grade 2': ['North','South'], 'Grade 3': [], 'Grade 4': ['Brown','White'] };
function nextClassOf(className){
  const i = allClassesList.indexOf(className);
  return (i >= 0 && i < allClassesList.length - 1) ? allClassesList[i+1] : null;
}
function previousClassOf(className){
  const i = allClassesList.indexOf(className);
  return i > 0 ? allClassesList[i-1] : null;
}
function repeatOptionsFor(className){
  // Matches the real backend rule: a repeater's options come from whatever
  // the class ONE LEVEL BELOW currently has - that cohort is what defines
  // this class this cycle, not the repeater's own old stream name.
  const lower = previousClassOf(className);
  return lower ? (classStreamsMap[lower] || []) : [];
}

const promotionClasses = [
  { name: 'Grade 1', students: [
    { name: 'Alice Wanjiru', stream: 'Y', decision: null, repeatClass: null, repeatStream: null },
    { name: 'Ben Otieno', stream: 'G', decision: null, repeatClass: null, repeatStream: null },
  ]},
  { name: 'Grade 2', students: [
    { name: 'Kevin Otieno Mwangi', stream: 'North', decision: null, repeatClass: null, repeatStream: null },
    { name: 'Faith Otieno Mwangi', stream: 'North', decision: null, repeatClass: null, repeatStream: null },
    { name: 'Brian Otieno', stream: 'South', decision: 'repeat', repeatClass: 'Grade 2', repeatStream: 'South' },
  ]},
  { name: 'Grade 3', students: [
    { name: 'James Kariuki', stream: null, decision: 'leave', repeatClass: null, repeatStream: null },
  ]},
];
let reviewOpenClassIndex = null;

function renderPromotion(){
  let totalPromote = 0, totalRepeat = 0, totalLeave = 0;
  promotionClasses.forEach(function(c){ c.students.forEach(function(s){
    if (s.decision === 'repeat') totalRepeat++; else if (s.decision === 'leave') totalLeave++; else totalPromote++;
  }); });

  let classCardsHtml = '';
  promotionClasses.forEach(function(c, ci){
    const nextClass = nextClassOf(c.name);
    classCardsHtml += '<div class="class-card" style="cursor:pointer;" onclick="openReviewPanel(' + ci + ')">' +
      '<div class="class-card-top"><h3>' + c.name + '</h3><span style="color:var(--muted);font-size:18px;">&#8250;</span></div>' +
      '<p class="hint" style="margin:0;">' + c.students.length + ' students' + (nextClass ? ' &middot; promotes to ' + nextClass : ' &middot; final class, promotes to graduated') + '</p>' +
    '</div>';
  });

  return '' +
    '<div class="topbar"><div><h1>Promotion & transfers</h1><p class="sub">Tap a class to open its review panel. Default is promote &mdash; only mark the exceptions.</p></div></div>' +
    '<div class="summary"><div class="sumcard promote"><div class="n">' + totalPromote + '</div><div class="l">Promoting</div></div>' +
    '<div class="sumcard repeat"><div class="n">' + totalRepeat + '</div><div class="l">Repeating</div></div>' +
    '<div class="sumcard leave"><div class="n">' + totalLeave + '</div><div class="l">Leaving</div></div></div>' +
    '<div class="class-grid">' + classCardsHtml + '</div>' +
    '<button class="btn primary wide" style="margin-top:16px;" onclick="openModal(\'Confirm promotion\',\'Everyone not marked repeat/leave moves up automatically - their stream name follows them, recreated fresh for the new year. Nothing here needs manual mapping unless a stream is merging, splitting, or renaming.\')">Confirm & run promotion</button>' +
    '<h2>Add a transfer-in student</h2>' +
    '<div class="panel pad"><div class="form-grid"><div><label class="field">Admission number</label><input type="text" placeholder="e.g. T2"></div>' +
    '<div><label class="field">Full name</label><input type="text" placeholder="Student name"></div>' +
    '<div><label class="field">Class</label><select><option>Grade 1</option><option>Grade 2</option><option>Grade 3</option></select></div>' +
    '<div><label class="field">Stream (if any)</label><select><option>&mdash; none &mdash;</option></select></div></div>' +
    '<button class="btn primary wide" style="margin-top:14px;">Add student directly to class</button></div>';
}

function openReviewPanel(ci){
  reviewOpenClassIndex = ci;
  document.getElementById('reviewPanelTitle').textContent = promotionClasses[ci].name + ' - review';
  renderReviewPanelBody();
  document.getElementById('reviewPanel').classList.add('show');
  document.getElementById('reviewBackdrop').classList.add('show');
}
function closeReviewPanel(){
  document.getElementById('reviewPanel').classList.remove('show');
  document.getElementById('reviewBackdrop').classList.remove('show');
  reviewOpenClassIndex = null;
}

function renderReviewPanelBody(){
  const ci = reviewOpenClassIndex;
  const c = promotionClasses[ci];
  const nextClass = nextClassOf(c.name);
  let html = '';
  c.students.forEach(function(s, si){
    let previewHtml = '';
    let pickerHtml = '';

    if (s.decision === 'leave') {
      previewHtml = '<div class="review-flow-preview leaving"><span class="cur">' + c.name + (s.stream?' '+s.stream:'') + '</span><span class="arrow">&rarr;</span><span class="dest">Leaving school</span></div>';
    } else if (s.decision === 'repeat') {
      const repeatClass = s.repeatClass || c.name;
      const repeatStream = s.repeatStream;
      previewHtml = '<div class="review-flow-preview"><span class="cur">' + c.name + (s.stream?' '+s.stream:'') + '</span><span class="arrow">&rarr;</span><span class="dest">Repeats ' + repeatClass + (repeatStream?' '+repeatStream:' (no stream)') + '</span></div>';
      const streamOptions = repeatOptionsFor(repeatClass);
      let streamSelectHtml = '<option value="">No stream</option>';
      streamOptions.forEach(function(st){ streamSelectHtml += '<option ' + (st===repeatStream?'selected':'') + '>' + st + '</option>'; });
      let classSelectHtml = '';
      allClassesList.forEach(function(cn){ classSelectHtml += '<option ' + (cn===repeatClass?'selected':'') + '>' + cn + '</option>'; });
      pickerHtml = '<div class="repeat-picker">' +
        '<label class="field">Repeating into class</label><select onchange="updateRepeatClass(' + ci + ',' + si + ',this.value)">' + classSelectHtml + '</select>' +
        (streamOptions.length ? '<label class="field">Which stream</label><select onchange="updateRepeatStream(' + ci + ',' + si + ',this.value)">' + streamSelectHtml + '</select>' : '<p class="hint">This class has no streams.</p>') +
      '</div>';
    } else {
      previewHtml = '<div class="review-flow-preview"><span class="cur">' + c.name + (s.stream?' '+s.stream:'') + '</span><span class="arrow">&rarr;</span><span class="dest">' + (nextClass ? nextClass + (s.stream?' '+s.stream:'') : 'Graduated') + '</span></div>';
    }

    html += '<div class="review-student">' +
      '<div class="review-student-name">' + s.name + '</div>' +
      previewHtml +
      '<div class="decision-opts">' +
        '<button class="dopt ' + (!s.decision?'on promote':'') + '" onclick="setPromoDecision(' + ci + ',' + si + ',null)">Promote</button>' +
        '<button class="dopt ' + (s.decision==='repeat'?'on repeat':'') + '" onclick="setPromoDecision(' + ci + ',' + si + ',\'repeat\')">Repeat</button>' +
        '<button class="dopt ' + (s.decision==='leave'?'on leave':'') + '" onclick="setPromoDecision(' + ci + ',' + si + ',\'leave\')">Leaving</button>' +
      '</div>' +
      pickerHtml +
    '</div>';
  });
  document.getElementById('reviewPanelBody').innerHTML = html;
}

function setPromoDecision(ci, si, decision){
  const s = promotionClasses[ci].students[si];
  s.decision = decision;
  if (decision === 'repeat') {
    // Defaults to the SAME class and stream they're already in - admin can
    // then explicitly change it (e.g. their old stream no longer exists).
    s.repeatClass = promotionClasses[ci].name;
    s.repeatStream = s.stream;
  }
  renderReviewPanelBody();
  showView('promotion'); // refreshes the summary counts and class-card list behind the panel
  openReviewPanel(ci);   // showView wipes #main but the panel lives outside it - keep it open and in sync
}
function updateRepeatClass(ci, si, className){
  const s = promotionClasses[ci].students[si];
  s.repeatClass = className;
  const streamOptions = repeatOptionsFor(className);
  s.repeatStream = streamOptions.length ? streamOptions[0] : null;
  renderReviewPanelBody();
}
function updateRepeatStream(ci, si, streamName){
  promotionClasses[ci].students[si].repeatStream = streamName || null;
  renderReviewPanelBody();
}

/* ---------- CLASSES & STREAMS ---------- */
function renderClasses(){
  let cardsHtml = '';
  classesData.forEach(function(c, i){
    let streamsHtml = '';
    c.streams.forEach(function(s, si){
      streamsHtml += '<div class="stream-item"><span>' + s.name + ' <span class="cnt">(' + s.count + ' students, 2026)</span></span>' +
        '<span class="rm" onclick="removeStream(' + i + ',' + si + ')" title="Remove - blocked if students are in it">&#10005;</span></div>';
    });
    cardsHtml += '<div class="class-card ' + (c.enabled?'':'off') + '">' +
      '<div class="class-card-top"><h3>' + c.name + '</h3><div class="toggle ' + (c.enabled?'on':'') + '" onclick="toggleClass(' + i + ')"></div></div>' +
      (c.enabled ? ('<p class="hint" style="margin-top:0;">This year\'s streams &mdash; a fresh set is created automatically each year as cohorts move up.</p><div class="stream-list">' + streamsHtml + '</div>' +
        '<div class="add-stream-row"><input type="text" placeholder="New stream name" id="streamInput' + i + '"><button class="btn small" onclick="addStream(' + i + ')">Add</button></div>')
        : '<p class="hint">Not offered by this school &mdash; disabling this stops promotion from ever moving a student here, so it can correctly graduate at the right class instead.</p>') +
    '</div>';
  });
  return '' +
    '<div class="topbar"><div><h1>Classes & streams</h1><p class="sub">Toggle which classes this school actually runs. This also tells promotion where to stop and graduate students.</p></div></div>' +
    '<div class="class-grid">' + cardsHtml + '</div>' +
    '<h2>How promotion handles streams</h2>' +
    '<div class="panel pad">' +
      '<p class="hint" style="margin-top:0;">By default, nothing needs setting up here: a student\'s stream name just follows them to the next class automatically, recreated fresh for the new year. A class with no stream stays stream-less, even if the next class happens to have streams for a different cohort.</p>' +
      '<p class="hint">You only need to add an override below if a school wants something different than that default &mdash; merging two streams into one, renaming a stream on promotion, or splitting a cohort.</p>' +
      '<div class="form-grid three" style="margin-top:12px;">' +
        '<div><label class="field">If a student\'s stream is</label><input type="text" placeholder="e.g. North (leave blank for no-stream)"></div>' +
        '<div><label class="field">Send them to class</label><select><option>Grade 2</option><option>Grade 3</option></select></div>' +
        '<div><label class="field">Renamed to stream</label><input type="text" placeholder="Leave blank to keep same name"></div>' +
      '</div><button class="btn primary" style="margin-top:12px;width:auto;padding:9px 18px;">Save override</button>' +
    '</div>';
}
function toggleClass(i){ classesData[i].enabled = !classesData[i].enabled; showView('classes'); }
function addStream(i){
  const input = document.getElementById('streamInput'+i);
  if (input.value.trim()) { classesData[i].streams.push({ name: input.value.trim(), count: 0 }); showView('classes'); }
}
function removeStream(i, si){
  const s = classesData[i].streams[si];
  if (s.count > 0) { openModal('Cannot remove ' + s.name, s.count + ' active student(s) are still in this stream. Transfer them to another stream first.'); return; }
  classesData[i].streams.splice(si,1); showView('classes');
}

/* ---------- ACADEMIC YEARS & TERMS ---------- */
let activeYear = '2026';
function renderTerms(){
  let tabsHtml = '';
  Object.keys(academicYears).sort().reverse().forEach(function(y){
    tabsHtml += '<div class="year-tab ' + (y===activeYear?'on':'') + '" onclick="switchYear(\'' + y + '\')">' + y + (academicYears[y].current?' (current)':'') + '</div>';
  });
  tabsHtml += '<div class="year-tab" style="border-style:dashed;" onclick="openModal(\'Create new academic year\',\'This creates the year and its 3 terms - dates can be adjusted per term afterward.\')">+ New year</div>';

  let termsHtml = '';
  academicYears[activeYear].terms.forEach(function(t){
    const locked = t.status !== 'upcoming';
    termsHtml += '<div class="term-card ' + (t.status==='live'?'live':'') + '">' +
      '<div class="term-card-top"><h3>Term ' + t.number + '</h3><span class="badge ' + (t.status==='live'?'active':(t.status==='ended'?'inactive':'repeat')) + '">' + t.status + '</span></div>' +
      '<div class="term-dates"><span>Start: <b>' + t.start + '</b></span><span>End: <b>' + t.end + '</b></span></div>' +
      (locked ? '<div class="locked-note">Start date locked (already begun) &mdash; end date can still be adjusted</div>' : '<div class="locked-note" style="color:var(--matched);">Not started yet &mdash; both dates editable</div>') +
      '<button class="btn small" style="margin-top:10px;">Edit end date</button>' +
    '</div>';
  });

  return '' +
    '<div class="topbar"><div><h1>Academic years & terms</h1><p class="sub">Term 1 &rarr; 2 &rarr; 3 &rarr; promotion &rarr; new year\'s Term 1. Payments always attach to whichever term has most recently started, even during the holiday gap.</p></div></div>' +
    '<div class="year-tabs">' + tabsHtml + '</div>' +
    termsHtml;
}
function switchYear(y){ activeYear = y; showView('terms'); }

function renderBanks(){
  let cardsHtml = '';
  banks.forEach(function(b){
    cardsHtml += '<div class="bank-card"><h3>' + b.name + '</h3>' +
      (b.connected ? '<div class="connected-tag"><span class="sw"></span>Connected</div>' : '<div style="font-size:11px;color:var(--muted);margin-bottom:8px;">Not connected</div>') +
      '<div class="fields">Needs: ' + b.fields.join(', ') + '</div>' +
      '<span class="badge ' + (b.push?'push':'poll') + '">' + (b.push?'Real-time push':'Polled every 5 min') + '</span>' +
      '<button class="btn wide small" style="margin-top:10px;" onclick="openModal(\'' + (b.connected?'Update':'Connect') + ' ' + b.name + '\',\'Credentials are encrypted before ever touching the database.\')">' + (b.connected?'Edit credentials':'Connect') + '</button>' +
    '</div>';
  });
  return '<div class="topbar"><div><h1>Bank connections</h1><p class="sub">Which banks this school uses, and the API keys tied to each</p></div></div><div class="bank-grid">' + cardsHtml + '</div>';
}

function renderStaff(){
  let rowsHtml = '';
  staffList.forEach(function(s){
    const initials = s.full_name.split(' ').map(function(w){return w[0];}).join('').slice(0,2);
    rowsHtml += '<div class="staff-row"><div class="staff-info"><div class="avatar">' + initials + '</div><div><div class="name">' + s.full_name + '</div><div class="staff-meta">' + s.email + '</div></div></div>' +
      '<span class="badge ' + (s.has_password?'active':'repeat') + '">' + (s.has_password?'active':'no password set') + '</span></div>';
  });
  return '' +
    '<div class="topbar"><div><h1>Staff</h1><p class="sub">Accounts that can confirm or reject payments &mdash; every action is attributed to one of these</p></div></div>' +
    '<div class="panel">' + rowsHtml + '</div>' +
    '<h2>Add staff account</h2>' +
    '<div class="panel pad"><div class="form-grid"><div><label class="field">Full name</label><input type="text" placeholder="e.g. Grace Wanjiru"></div>' +
    '<div><label class="field">Email</label><input type="email" placeholder="name@school.ac.ke"></div></div>' +
    '<p class="hint">A temporary password can be set now, or the staff member sets their own on first login.</p>' +
    '<button class="btn primary wide" style="margin-top:10px;">Add staff account</button></div>';
}

/* ---------- STUDENT DETAIL ---------- */
function renderStudentDetail(){
  const s = studentDetailData;
  let ledgerHtml = '';
  s.ledgerByTerm.forEach(function(l){
    ledgerHtml += '<tr><td data-label="Term">' + l.term + '</td><td data-label="Opening">' + money(l.opening) + '</td>' +
      '<td data-label="Charged">' + money(l.charged) + '</td><td data-label="Paid">' + money(l.paid) + '</td>' +
      '<td data-label="Closing"><span class="bal ' + (l.closing>0?'due':(l.closing<0?'credit':'clear')) + '">' + money(l.closing) + '</span></td></tr>';
  });
  let paymentsHtml = '';
  s.payments.forEach(function(p){
    paymentsHtml += '<tr><td data-label="Date">' + p.date + '</td><td data-label="Source">' + chipFor(p.source) + '</td>' +
      '<td data-label="Amount">' + money(p.amount) + '</td><td data-label="Reference"><span class="adm">' + p.ref + '</span></td>' +
      '<td data-label="Status"><span class="badge active">' + p.status + '</span></td></tr>';
  });
  let editHistHtml = '';
  if (s.feeEditHistory.length) {
    s.feeEditHistory.forEach(function(e){
      editHistHtml += '<div class="edit-log-row"><div class="edit-log-top"><b>' + e.by + '</b><span>' + e.date + '</span></div>' +
        '<div class="edit-log-change">' + money(e.from) + ' &rarr; ' + money(e.to) + '</div>' +
        '<div class="edit-log-reason">"' + e.reason + '"</div></div>';
    });
  } else {
    editHistHtml = '<p class="hint">No manual edits on record - every change here will be logged permanently, same as this.</p>';
  }
  return '' +
    '<div class="topbar"><div><p class="back-link" onclick="showView(\'roster\')" style="margin-bottom:6px;">&larr; Back to roster</p>' +
      '<h1>' + s.full_name + '</h1><p class="sub">' + s.admission_no + ' &middot; ' + s.class_name + (s.stream_name?' &middot; '+s.stream_name:'') + ' &middot; Guardian: ' + s.guardian_name + ' (' + s.guardian_phone + ')</p></div></div>' +
    '<h2>Term-by-term ledger</h2>' +
    '<table><thead><tr><th>Term</th><th>Opening</th><th>Charged</th><th>Paid</th><th>Closing balance</th></tr></thead><tbody>' + ledgerHtml + '</tbody></table>' +
    '<h2>Payment history</h2>' +
    '<table><thead><tr><th>Date</th><th>Source</th><th>Amount</th><th>Reference</th><th>Status</th></tr></thead><tbody>' + paymentsHtml + '</tbody></table>' +
    '<h2>Manual fee adjustment</h2>' +
    '<div class="panel pad">' +
      '<p class="hint" style="margin-top:0;color:var(--cash);">Manual edits bypass the matching engine entirely - a reason is required, and this cannot be submitted blank.</p>' +
      '<div class="form-grid"><div><label class="field">New tuition amount</label><input type="number" value="4500"></div>' +
      '<div><label class="field">Effective from</label><select><option>Immediately</option><option>Next term</option></select></div></div>' +
      '<label class="field">Reason for this change (required, shown in the audit log permanently)</label>' +
      '<textarea placeholder="e.g. Sibling discount, hardship waiver, correction of a data entry error..." style="min-height:70px;"></textarea>' +
      '<button class="btn primary wide" style="margin-top:12px;" onclick="openModal(\'Confirm fee adjustment\',\'This will be recorded permanently with your name, the old value, the new value, and your stated reason. It cannot be edited or deleted afterward.\')">Save adjustment</button>' +
    '</div>' +
    '<h2>Fee edit history</h2>' +
    '<div class="panel pad">' + editHistHtml + '</div>';
}

/* ---------- REPORTS ---------- */
function renderReports(){
  let termsHtml = '';
  reportsData.termCollection.forEach(function(t){
    const rate = Math.round((t.collected / t.charged) * 100);
    const barColor = rate >= 95 ? 'var(--matched)' : (rate >= 75 ? 'var(--cash)' : 'var(--alert)');
    termsHtml += '<div class="report-row">' +
      '<div class="report-term">' + t.term + '</div>' +
      '<div class="report-bar-wrap"><div class="report-bar" style="width:' + rate + '%;background:' + barColor + ';"></div></div>' +
      '<div class="report-pct" style="color:' + barColor + ';">' + rate + '%</div>' +
      '<div class="report-nums">' + money(t.collected) + ' of ' + money(t.charged) + '</div>' +
    '</div>';
  });
  let arrearsHtml = '';
  reportsData.arrearsByClass.forEach(function(a){
    arrearsHtml += '<tr><td data-label="Class">' + a.class_name + '</td><td data-label="Students owing">' + a.students_owing + '</td>' +
      '<td data-label="Total owed"><span class="bal due">' + money(a.owed) + '</span></td></tr>';
  });
  return '' +
    '<div class="topbar"><div><h1>Reports</h1><p class="sub">Collection rate per term, and where arrears are concentrated by class</p></div></div>' +
    '<h2>Collection rate by term</h2>' +
    '<div class="panel pad">' + termsHtml + '</div>' +
    '<h2>Arrears by class (current term)</h2>' +
    '<table><thead><tr><th>Class</th><th>Students owing</th><th>Total owed</th></tr></thead><tbody>' + arrearsHtml + '</tbody></table>' +
    '<p class="hint" style="margin-top:14px;">Every payment is tagged with the term it landed in, so this report is a direct query - not a date-range guess.</p>';
}

/* ---------- OPTIONAL FEES ASSIGNMENT ---------- */
function renderOptionalFees(){
  let html = '<div class="topbar"><div><h1>Optional fees</h1><p class="sub">Decide which students are opted into which optional fee - mandatory fees never need this, they apply to everyone automatically</p></div></div>';
  optionalFeesData.forEach(function(f){
    let rowsHtml = '';
    f.students.forEach(function(st, i){
      rowsHtml += '<label class="opt-fee-row"><span>' + st.name + '</span><input type="checkbox" ' + (st.opted_in?'checked':'') + '></label>';
    });
    const optedCount = f.students.filter(function(s){return s.opted_in;}).length;
    html += '<h2>' + f.fee_name + ' <span class="badge active" style="margin-left:6px;">' + money(f.amount) + '/term</span> <span class="hint" style="display:inline;">&mdash; ' + optedCount + ' of ' + f.students.length + ' opted in</span></h2>' +
      '<div class="panel pad">' + rowsHtml + '</div>';
  });
  html += '<button class="btn primary" style="margin-top:16px;width:auto;padding:10px 20px;">Save opt-ins</button>';
  return html;
}

/* ---------- ACTIVITY / AUDIT LOG ---------- */
function renderAuditLog(){
  let rowsHtml = '';
  auditLog.forEach(function(a){
    const iconColor = a.action.indexOf('Reject')===0 ? 'var(--alert)' : (a.action.indexOf('Manually')===0 ? 'var(--cash)' : 'var(--matched)');
    rowsHtml += '<div class="audit-row">' +
      '<div class="audit-dot" style="background:' + iconColor + ';"></div>' +
      '<div class="audit-body"><div class="audit-top"><b>' + a.staff + '</b><span class="audit-date">' + a.date + '</span></div>' +
      '<div class="audit-action">' + a.action + '</div><div class="audit-detail">' + a.detail + '</div></div>' +
    '</div>';
  });
  return '' +
    '<div class="topbar"><div><h1>Activity log</h1><p class="sub">Every confirm, reject, manual edit, and promotion run - who did it, and when. This is what you pull up if a parent disputes something.</p></div></div>' +
    '<div class="panel pad">' + rowsHtml + '</div>';
}

/* ---------- SCHOOL SETTINGS ---------- */
function renderSettings(){
  return '' +
    '<div class="topbar"><div><h1>School settings</h1><p class="sub">General information for ' + schoolSettings.name + '</p></div></div>' +
    '<div class="panel pad" style="max-width:480px;">' +
      '<label class="field">School name</label><input type="text" value="' + schoolSettings.name + '">' +
      '<label class="field">Contact phone</label><input type="tel" value="' + schoolSettings.phone + '">' +
      '<label class="field">Contact email</label><input type="email" value="' + schoolSettings.email + '">' +
      '<label class="field">Address</label><input type="text" value="' + schoolSettings.address + '">' +
      '<button class="btn primary wide" style="margin-top:16px;">Save changes</button>' +
    '</div>';
}

/* ---------- SCHOOL-WIDE FEE EDITS (standout audit page) ---------- */
let feeEditsSortNewest = true;
function renderFeeEdits(){
  const sorted = allFeeEdits.slice().sort(function(a,b){
    return feeEditsSortNewest ? new Date(b.date) - new Date(a.date) : new Date(a.date) - new Date(b.date);
  });
  let rowsHtml = '';
  sorted.forEach(function(e){
    const pctChange = e.from > 0 ? Math.round(((e.to - e.from) / e.from) * 100) : 0;
    const isBigCut = pctChange <= -30;
    rowsHtml += '<div class="fedit-row ' + (isBigCut?'flagged':'') + '">' +
      (isBigCut ? '<div class="fedit-flag">&#9888; Large reduction (' + pctChange + '%) &mdash; worth a second look</div>' : '') +
      '<div class="fedit-top">' +
        '<div><span class="name">' + e.student + '</span> <span class="adm">' + e.admission_no + '</span></div>' +
        '<span class="audit-date">' + e.date + '</span>' +
      '</div>' +
      '<div class="fedit-change">' + money(e.from) + ' <span class="fedit-arrow">&rarr;</span> ' + money(e.to) +
        (e.from !== e.to ? ' <span class="fedit-pct ' + (pctChange<0?'down':'up') + '">(' + (pctChange>0?'+':'') + pctChange + '%)</span>' : ' <span class="fedit-pct" style="color:var(--muted);">(no change)</span>') +
      '</div>' +
      '<div class="fedit-reason">"' + e.reason + '"</div>' +
      '<div class="fedit-by">Edited by <b>' + e.by + '</b></div>' +
    '</div>';
  });
  return '' +
    '<div class="topbar"><div><h1>Fee edits</h1><p class="sub">Every manual fee change across the whole school, in one place &mdash; not buried per-student. ' + allFeeEdits.length + ' total edits on record.</p></div></div>' +
    '<div class="sort-toggle">' +
      '<button class="btn small ' + (feeEditsSortNewest?'primary':'') + '" onclick="feeEditsSortNewest=true;showView(\'feeedits\')">Newest first</button>' +
      '<button class="btn small ' + (!feeEditsSortNewest?'primary':'') + '" onclick="feeEditsSortNewest=false;showView(\'feeedits\')">Oldest first</button>' +
    '</div>' +
    '<div class="panel" style="margin-top:12px;">' + rowsHtml + '</div>';
}

const views = {
  dashboard: renderDashboard, reviewqueue: renderReviewQueue, roster: renderRoster, admit: renderAdmit,
  feestructure: renderFeeStructure, promotion: renderPromotion, classes: renderClasses, terms: renderTerms,
  banks: renderBanks, staff: renderStaff, studentdetail: renderStudentDetail, reports: renderReports,
  optionalfees: renderOptionalFees, auditlog: renderAuditLog, settings: renderSettings, feeedits: renderFeeEdits
};

function showView(name){
  document.getElementById('main').innerHTML = views[name]();
  document.querySelectorAll('.nav, .bnav-item').forEach(function(el){ el.classList.toggle('active', el.dataset.view === name); });
  closeDrawer();
  window.scrollTo(0,0);
}
document.querySelectorAll('.nav, .bnav-item').forEach(function(el){
  if (!el.dataset.view) return;
  el.addEventListener('click', function(){ showView(el.dataset.view); });
});

function openDrawer(){ document.getElementById('drawer').classList.add('show'); document.getElementById('drawerBackdrop').classList.add('show'); }
function closeDrawer(){ document.getElementById('drawer').classList.remove('show'); document.getElementById('drawerBackdrop').classList.remove('show'); }
function openModal(title, sub){ document.getElementById('modalTitle').textContent = title; document.getElementById('modalSub').textContent = sub; document.getElementById('modalBackdrop').classList.add('show'); }
function closeModal(){ document.getElementById('modalBackdrop').classList.remove('show'); }
function confirmTxn(id){ openModal('Confirm payment #'+id, 'This applies the payment to the selected student\'s balance and records your staff account against it.'); }
function rejectTxn(id){ openModal('Reject payment #'+id, 'This marks the payment as rejected.'); }

document.getElementById('loginPassword').addEventListener('keydown', function(e){ if (e.key === 'Enter') attemptLogin(); });
