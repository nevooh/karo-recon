/* live-screens.js - Payments and Students & balances. READ-ONLY screens fed by the real engine.
   Loaded after live.js. Uses the same table markup as before, so it stacks nicely on phones. */
(function () {
  var css = document.createElement('style');
  css.textContent = '.pill-row{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0}.fpill{padding:6px 12px;border-radius:999px;border:1px solid #d9dfd9;background:#fff;font-size:12.5px;cursor:pointer}.fpill.on{background:#1f7a4d;color:#fff;border-color:transparent}.sbadge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11.5px;font-weight:600;white-space:nowrap}.s-auto_matched,.s-confirmed{background:#e3f4ea;color:#166a3c}.s-needs_review{background:#fff3d6;color:#8a5a00}.s-unmatched{background:#eceeec;color:#555}.s-rejected{background:#fde4e4;color:#a12727}.sbar{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}.sbar input,.sbar select{padding:10px 12px;border:1px solid #d9dfd9;border-radius:10px;font-size:14px;flex:1;min-width:140px;background:#fff}.pager{display:flex;justify-content:space-between;align-items:center;margin:12px 0;font-size:13px;color:#6b756d}';
  document.head.appendChild(css);

  var LABEL = { auto_matched: 'Auto-matched', confirmed: 'Confirmed', needs_review: 'Needs review', unmatched: 'Unmatched', rejected: 'Rejected' };
  var pay = { status: '', source: '', q: '', offset: 0, limit: 25 };
  var stu = { q: '', offset: 0, limit: 40 };
  var timer = null;

  function when(v) { return esc(String(v || '').slice(0, 16).replace('T', ' ')); }
  function badge(s) { return '<span class="sbadge s-' + esc(s) + '">' + esc(LABEL[s] || s) + '</span>'; }
  function pager(total, offset, limit, fn) {
    var to = Math.min(offset + limit, total);
    return '<div class="pager"><button class="btn small" ' + (offset <= 0 ? 'disabled' : '') + ' onclick="' + fn + '(-1)">&larr; Newer</button><span>' +
      (total ? (offset + 1) + '&ndash;' + to + ' of ' + total : '0') + '</span><button class="btn small" ' + (to >= total ? 'disabled' : '') + ' onclick="' + fn + '(1)">Older &rarr;</button></div>';
  }

  /* ---------------- Payments ---------------- */
  views.payments = function () {
    setTimeout(loadPayments, 0);
    var pills = [['', 'All'], ['auto_matched', 'Auto-matched'], ['needs_review', 'Needs review'], ['unmatched', 'Unmatched'], ['confirmed', 'Confirmed'], ['rejected', 'Rejected']]
      .map(function (p) { return '<div class="fpill' + (pay.status === p[0] ? ' on' : '') + '" onclick="payFilter(\'status\',\'' + p[0] + '\')">' + p[1] + '</div>'; }).join('');
    var src = [['', 'All channels'], ['mpesa', 'M-Pesa'], ['kcb', 'KCB'], ['equity', 'Equity'], ['coop', 'Co-op']]
      .map(function (p) { return '<option value="' + p[0] + '"' + (pay.source === p[0] ? ' selected' : '') + '>' + p[1] + '</option>'; }).join('');
    return '<div class="topbar"><div><h1>Payments</h1><p class="sub">Every payment received, newest first. View only.</p></div></div>' +
      '<div class="pill-row">' + pills + '</div>' +
      '<div class="sbar"><input placeholder="Search reference, payer, student or amount" value="' + esc(pay.q) + '" oninput="paySearch(this.value)">' +
      '<select onchange="payFilter(\'source\',this.value)">' + src + '</select></div><div id="payBody"><p class="sub">Loading&hellip;</p></div>';
  };
  async function loadPayments() {
    if (!document.getElementById('payBody') || !live.staff) return;
    var qs = 'limit=' + pay.limit + '&offset=' + pay.offset + (pay.status ? '&status=' + pay.status : '') + (pay.source ? '&source=' + pay.source : '') + (pay.q ? '&q=' + encodeURIComponent(pay.q) : '');
    try {
      var r = await Api.get('/schools/' + live.staff.school_id + '/transactions?' + qs);
      var box = document.getElementById('payBody'); if (!box) return;
      var rows = r.rows.map(function (t) {
        return '<tr><td data-label="When">' + when(t.received_at || t.created_at) + '</td><td data-label="Channel">' + chipFor(t.source) + '</td>' +
          '<td data-label="Amount"><b>' + money(num(t.amount)) + '</b></td><td data-label="Reference">' + esc(t.narration || '-') + '</td>' +
          '<td data-label="Student">' + (t.student_name ? esc(t.student_name) + ' <span class="adm">' + esc(t.admission_no) + '</span>' : '-') + '</td>' +
          '<td data-label="Status">' + badge(t.match_status) + '</td></tr>';
      }).join('');
      box.innerHTML = r.rows.length
        ? '<table><thead><tr><th>When</th><th>Channel</th><th>Amount</th><th>Reference</th><th>Student</th><th>Status</th></tr></thead><tbody>' + rows + '</tbody></table>' + pager(r.total, pay.offset, pay.limit, 'payPage')
        : '<p class="sub">No payments match.</p>';
    } catch (e) { var b = document.getElementById('payBody'); if (b) b.innerHTML = '<p class="sub">' + esc(e.message) + '</p>'; }
  }
  window.payFilter = function (k, v) { pay[k] = v; pay.offset = 0; showView('payments'); };
  window.payPage = function (d) { pay.offset = Math.max(0, pay.offset + d * pay.limit); loadPayments(); };
  window.paySearch = function (v) { clearTimeout(timer); timer = setTimeout(function () { pay.q = v.trim(); pay.offset = 0; loadPayments(); }, 300); };

  /* ---------------- Students & balances ---------------- */
  views.roster = function () {
    setTimeout(loadStudents, 0);
    return '<div class="topbar"><div><h1>Students &amp; balances</h1><p class="sub">Balance = brought forward + fees charged &minus; paid, for the current term. View only.</p></div></div>' +
      '<div id="stuTotals"></div><div class="sbar"><input placeholder="Search name or admission number" value="' + esc(stu.q) + '" oninput="stuSearch(this.value)"></div>' +
      '<div id="stuBody"><p class="sub">Loading&hellip;</p></div>';
  };
  async function loadStudents() {
    if (!document.getElementById('stuBody') || !live.staff) return;
    var qs = 'limit=' + stu.limit + '&offset=' + stu.offset + (stu.q ? '&q=' + encodeURIComponent(stu.q) : '');
    try {
      var r = await Api.get('/schools/' + live.staff.school_id + '/students?' + qs);
      var box = document.getElementById('stuBody'); if (!box) return;
      var t = r.totals;
      document.getElementById('stuTotals').innerHTML = '<div class="totals-row">' +
        '<div class="stat"><div class="n">' + t.students + '</div><div class="l">Students</div></div>' +
        '<div class="stat good"><div class="n">' + money(t.paid) + '</div><div class="l">Paid this term</div></div>' +
        '<div class="stat warn"><div class="n">' + money(t.outstanding) + '</div><div class="l">Outstanding</div></div></div>';
      var rows = r.rows.map(function (s) {
        var cls = s.balance > 0 ? 'due' : (s.balance < 0 ? 'credit' : 'clear');
        var txt = s.balance === 0 ? 'Paid up' : money(Math.abs(s.balance)) + (s.balance < 0 ? ' credit' : ' due');
        return '<tr><td data-label="Admission"><span class="adm">' + esc(s.admission_no) + '</span></td><td data-label="Name"><span class="name">' + esc(s.full_name) + '</span></td>' +
          '<td data-label="Status"><span class="badge ' + (s.status === 'active' ? 'active' : 'repeat') + '">' + esc(s.status) + '</span></td>' +
          '<td data-label="Charged">' + money(s.fees_charged) + '</td><td data-label="Paid">' + money(s.amount_paid) + '</td>' +
          '<td data-label="Balance"><span class="bal ' + cls + '">' + txt + '</span></td></tr>';
      }).join('');
      box.innerHTML = r.rows.length
        ? '<table><thead><tr><th>Admission</th><th>Name</th><th>Status</th><th>Charged</th><th>Paid</th><th>Balance</th></tr></thead><tbody>' + rows + '</tbody></table>' + pager(t.students, stu.offset, stu.limit, 'stuPage')
        : '<p class="sub">No students found.</p>';
    } catch (e) { var b = document.getElementById('stuBody'); if (b) b.innerHTML = '<p class="sub">' + esc(e.message) + '</p>'; }
  }
  window.stuPage = function (d) { stu.offset = Math.max(0, stu.offset + d * stu.limit); loadStudents(); };
  window.stuSearch = function (v) { clearTimeout(timer); timer = setTimeout(function () { stu.q = v.trim(); stu.offset = 0; loadStudents(); }, 300); };

  /* The Bank connections page now lives in page-banks.js (one file per page). */
})();