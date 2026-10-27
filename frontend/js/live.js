/* live.js - connects login, dashboard and review queue to the REAL engine.
   Loaded after app.js, so it replaces the demo versions of those screens.
   Everything else still shows demo data until its endpoints exist. */
const live = { staff: null, summary: [], queue: [], unmatched: [] };

// Payer names and references come from outside (M-Pesa, banks) - always escape them.
function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
const num = function (v) { return Number(v) || 0; };
const candId = function (c) { return c.student_id != null ? c.student_id : c.id; };

async function loadLiveData() {
  const base = '/schools/' + live.staff.school_id;
  const out = await Promise.all([Api.get(base + '/summary'), Api.get(base + '/review-queue'), Api.get(base + '/unmatched')]);
  live.summary = out[0]; live.queue = out[1]; live.unmatched = out[2];
}

function enterApp() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('landingScreen').style.display = 'none';
  document.getElementById('mainApp').style.display = 'grid';
  showView('dashboard');
}

/* ---------------- login / logout ---------------- */
window.attemptLogin = async function () {
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errBox = document.getElementById('loginErr');
  const fail = function (msg) { errBox.textContent = msg; errBox.classList.add('show'); };
  if (!email || !password) return fail('Enter your email and password');
  try {
    const r = await Api.request('POST', '/auth/login', { email: email, password: password });
    Api.save(r.token, r.staff);
    live.staff = r.staff;
    await loadLiveData();
    errBox.classList.remove('show');
    enterApp();
  } catch (e) { Api.clear(); fail(e.message); }
};
window.logout = function () {
  Api.clear(); live.staff = null;
  document.getElementById('mainApp').style.display = 'none';
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('landingScreen').style.display = 'block';
  document.getElementById('loginPassword').value = '';
};

/* ---------------- dashboard ---------------- */
views.dashboard = function () {
  const row = function (k) { return live.summary.find(function (s) { return s.match_status === k; }) || { count: 0, total: 0 }; };
  const a = row('auto_matched'), r = row('needs_review'), u = row('unmatched');
  const rows = live.queue.concat(live.unmatched).map(function (t) {
    const review = t.match_status === 'needs_review';
    return '<div class="prow pending"><div>' + chipFor(t.source) + '</div>' +
      '<div><div class="who">' + esc(t.payer_name || 'Unknown') + '</div><div class="ref">' + esc(t.narration || 'no reference') + '</div></div>' +
      '<div class="amt">' + money(num(t.amount)) + '</div>' +
      '<div class="status review"><span class="sw"></span>' + (review ? 'Needs review' : 'Unmatched') + '</div>' +
      '<div style="font-size:11.5px;color:var(--muted);">' + esc(t.match_reason || 'No plausible candidate') + '</div></div>';
  }).join('');
  return '<div class="topbar"><div><h1>Dashboard</h1><p class="sub">Fee reconciliation overview &middot; ' + esc(live.staff.full_name) + '</p></div>' +
    '<div class="totals-row">' +
    '<div class="stat good"><div class="n">' + money(num(a.total)) + '</div><div class="l">Auto-matched (' + a.count + ')</div></div>' +
    '<div class="stat mid"><div class="n">' + money(num(r.total)) + '</div><div class="l">Needs review (' + r.count + ')</div></div>' +
    '<div class="stat warn"><div class="n">' + money(num(u.total)) + '</div><div class="l">Unmatched (' + u.count + ')</div></div></div></div>' +
    '<h2>Waiting for a decision</h2><div class="panel"><div class="prow-head"><div>Channel</div><div>Payer</div><div>Amount</div><div>Status</div><div>Reason</div></div>' +
    (rows || '<div style="padding:18px;color:var(--muted);">Nothing waiting. All payments are matched.</div>') + '</div>';
};

/* The Review queue page now lives in page-review.js (one file per page). */
window.skipLogin = window.goToLogin;

/* Stay logged in across a page refresh (token lasts 12 hours). */
(async function restoreSession() {
  if (!Api.token() || !Api.staff()) return;
  live.staff = Api.staff();
  try { await loadLiveData(); enterApp(); } catch (e) { Api.clear(); live.staff = null; }
})();