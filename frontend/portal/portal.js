/* Parent portal: the live version of parent-portal-mockup.html. Talks to /api/parent/* (src/routes/parentRoutes.js).
   Everything that comes from the server is passed through esc() before it goes into the page: student and school
   names are typed by people and must never be treated as HTML. */
(function () {
  'use strict';
  var API = '/api/parent';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var KES = function (n) { return Number(n).toLocaleString('en-KE'); };

  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private window: the sign-in just will not be remembered */ } },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  };

  var S = { token: store.get('karo_parent_token'), me: null, cur: 0, tab: 'home', c: {}, pay: null, payRun: 0, phone: '' };

  var ICONS = {
    home: '<svg viewBox="0 0 24 24"><path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/></svg>',
    fees: '<svg viewBox="0 0 24 24"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>',
    pays: '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/></svg>'
  };
  var NAV = [['home', 'Home'], ['fees', 'Fees'], ['pays', 'Payments']];

  /* ---------- small helpers ---------- */
  function show(id, on) { $(id).classList.toggle('hidden', !on); }
  function toast(msg) { var t = $('toast'); t.textContent = msg; show('toast', true); setTimeout(function () { show('toast', false); }, 3200); }
  function pretty(msisdn) { var d = String(msisdn || '').replace(/\D/g, '').slice(-9); return d.length === 9 ? ('0' + d).replace(/^(\d{4})(\d{3})(\d{3})$/, '$1 $2 $3') : String(msisdn || ''); }
  function fmtDate(iso, withTime) {
    var d = new Date(iso); if (isNaN(d)) return '';
    var o = { timeZone: 'Africa/Nairobi', day: '2-digit', month: 'short', year: 'numeric' };
    if (withTime) { o.hour = 'numeric'; o.minute = '2-digit'; }
    return d.toLocaleString('en-GB', o).replace(',', withTime ? ',' : '');
  }
  function initials(name) { var p = String(name || '').trim().split(/\s+/).filter(Boolean); return p.length ? (p[0][0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase() : ''; }

  async function api(method, path, body) {
    var res;
    try {
      res = await fetch(API + path, { method: method, headers: Object.assign({ 'Content-Type': 'application/json' }, S.token ? { Authorization: 'Bearer ' + S.token } : {}), body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) { throw new Error('No internet connection. Please check it and try again.'); }
    var json = null; try { json = await res.json(); } catch (e) { /* no body */ }
    if (res.status === 401 && S.token) { signedOut('Please sign in again.'); throw new Error((json && json.error) || 'Please sign in again.'); }
    if (!res.ok) throw new Error((json && json.error) || 'Something went wrong. Please try again.');
    return json;
  }

  /* ---------- sign in ---------- */
  function showLogin(msg) {
    show('app', false); show('tabs', false); show('login', true);
    loginPhone(msg || '');
  }
  function loginPhone(msg) {
    $('loginCard').innerHTML = '<div class="logo">K</div><h1>Parent portal</h1><p>See your child\'s fees and pay by M-Pesa.</p>' +
      '<label for="lp">Phone number you gave the school</label><input class="in" id="lp" inputmode="tel" autocomplete="tel" placeholder="0712 345 678" value="' + esc(S.phone) + '">' +
      '<div class="err" id="lerr">' + esc(msg) + '</div><button class="btn go" id="lgo" style="margin-top:6px">Send me a code</button>';
    $('lgo').onclick = sendCode;
    $('lp').onkeydown = function (e) { if (e.key === 'Enter') sendCode(); };
  }
  async function sendCode() {
    var ph = $('lp').value, btn = $('lgo'); S.phone = ph;
    btn.disabled = true; $('lerr').textContent = '';
    try { var r = await api('POST', '/otp', { phone: ph }); loginCode(r); }
    catch (e) { $('lerr').textContent = e.message; btn.disabled = false; }
  }
  var codeTimer = null;
  function loginCode(r) {
    var total = (r && r.expires_in) || 120, t0 = Date.now(), RESEND_AFTER = 30;
    clearInterval(codeTimer);
    $('loginCard').innerHTML = '<div class="logo">K</div><h1>Enter your code</h1><p>We sent a 6-digit code by text message to <b class="mono" style="color:var(--ink)">' + esc(pretty(S.phone)) + '</b>.</p>' +
      '<label for="lc">Code</label><input class="in" id="lc" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000">' +
      '<div class="barnote" style="margin-top:8px"><span id="lleft"></span></div>' +
      (r && r.devCode ? '<div class="hint">Test mode (no text-message service set up): your code is <b class="mono">' + esc(r.devCode) + '</b></div>' : '') +
      '<div class="err" id="lerr"></div><button class="btn go" id="lgo" style="margin-top:6px">Sign in</button>' +
      '<button class="linkbtn" id="lagain"></button><br><button class="linkbtn" id="lother">Use a different number</button>';
    $('lc').focus();
    $('lgo').onclick = verify;
    $('lc').onkeydown = function (e) { if (e.key === 'Enter') verify(); };
    $('lc').oninput = function () { this.value = this.value.replace(/\D/g, '').slice(0, 6); if (this.value.length === 6) verify(); };
    $('lother').onclick = function () { clearInterval(codeTimer); loginPhone(''); };
    $('lagain').onclick = async function () {
      if (this.disabled) return; this.disabled = true;
      try { var x = await api('POST', '/otp', { phone: S.phone }); loginCode(x); toast('A new code was sent.'); }
      catch (e) { $('lerr').textContent = e.message; this.disabled = false; }
    };
    function tick() {
      var used = Math.floor((Date.now() - t0) / 1000), left = Math.max(0, total - used);
      if (!$('lleft')) return clearInterval(codeTimer);
      var again = $('lagain');
      if (left > 0) {
        $('lleft').textContent = 'Code expires in ' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
        var wait = Math.max(0, RESEND_AFTER - used);
        again.textContent = wait > 0 ? 'Send the code again (in ' + wait + 's)' : 'Send the code again';
        again.disabled = wait > 0;
      } else {
        $('lleft').textContent = 'This code has expired.'; $('lleft').style.color = 'var(--alert)';
        $('lgo').disabled = true; again.textContent = 'Send a new code'; again.disabled = false; clearInterval(codeTimer);
      }
    }
    tick(); codeTimer = setInterval(tick, 1000);
  }
  var verifying = false;
  async function verify() {
    if (verifying) return; var code = $('lc').value; if (code.length !== 6) { $('lerr').textContent = 'Enter the 6-digit code.'; return; }
    verifying = true; $('lgo').disabled = true; $('lerr').textContent = '';
    try {
      var r = await api('POST', '/verify', { phone: S.phone, code: code });
      clearInterval(codeTimer); S.token = r.token; store.set('karo_parent_token', r.token);
      await start();
    } catch (e) { $('lerr').textContent = e.message; $('lgo').disabled = false; }
    verifying = false;
  }
  function signedOut(msg) {
    S.token = null; S.me = null; S.c = {}; store.del('karo_parent_token'); closePay(); showLogin(msg);
  }
  async function logout() {
    try { await api('POST', '/logout', {}); } catch (e) { /* signing out locally anyway */ }
    signedOut('');
  }

  /* ---------- start ---------- */
  async function start() {
    S.me = await api('GET', '/me');
    S.c = {}; S.cur = 0; S.tab = 'home';
    show('login', false); show('app', true); show('tabs', true);
    draw();
  }
  function kid() { return S.me && S.me.children[S.cur]; }
  function cache() { var k = kid(); if (!k) return null; return S.c[k.id] || (S.c[k.id] = {}); }

  /* ---------- shell ---------- */
  function drawShell() {
    var k = kid(), school = k ? k.school.name : 'Parent portal';
    var t = NAV.map(function (n) { return '<button class="' + (S.tab === n[0] ? 'on' : '') + '" data-tab="' + n[0] + '">' + ICONS[n[0]] + n[1] + '</button>'; }).join('');
    $('tabs').innerHTML = t;
    $('side').innerHTML = '<div class="brand"><div class="logo">' + esc((school[0] || 'K').toUpperCase()) + '</div><div><b style="font-family:Space Grotesk">' + esc(school) + '</b><br><span class="muted" style="font-size:12px">Parent portal</span></div></div>' + t +
      '<div class="foot">Signed in as<br><b style="color:var(--ink)">' + esc((S.me && S.me.name) || pretty(S.me && S.me.phone)) + '</b><br>' + esc(pretty(S.me && S.me.phone)) + '<br><button class="link" id="sideOut">Sign out</button></div>';
    $('topLogo').textContent = (school[0] || 'K').toUpperCase();
    $('topSchool').textContent = school;
    $('who').textContent = initials(S.me && S.me.name) || 'Me';
    $('kids').innerHTML = (S.me ? S.me.children : []).map(function (c, i) {
      return '<button class="kid ' + (i === S.cur ? 'on' : '') + '" data-kid="' + i + '"><i>' + esc((c.first_name || '?')[0]) + '</i><span>' + esc(c.first_name) + '<small>' + esc(c.class || '') + '</small></span></button>';
    }).join('');
    Array.prototype.forEach.call(document.querySelectorAll('[data-tab]'), function (b) { b.onclick = function () { go(b.getAttribute('data-tab')); }; });
    Array.prototype.forEach.call(document.querySelectorAll('[data-kid]'), function (b) { b.onclick = function () { S.cur = Number(b.getAttribute('data-kid')); draw(); }; });
    var so = $('sideOut'); if (so) so.onclick = logout;
  }
  function go(t) { S.tab = t; draw(); window.scrollTo(0, 0); }
  $('who').onclick = function () {
    $('sheet').innerHTML = '<div class="hd"><h2>Your account</h2><button class="x" id="xAcc" aria-label="Close">&times;</button></div>' +
      '<div class="muted" style="font-size:13px;margin-top:6px">' + esc((S.me && S.me.name) || '') + ' ' + esc(pretty(S.me && S.me.phone)) + '</div>' +
      '<button class="btn" style="margin-top:18px" id="accOut">Sign out</button>';
    $('shade').classList.add('open'); $('xAcc').onclick = closePay; $('accOut').onclick = function () { closePay(); logout(); };
  };

  /* ---------- screens ---------- */
  function payRow(p) {
    var cls = p.kind === 'bank' ? 'bank' : (p.kind === 'cash' ? 'cash' : ''), ab = p.kind === 'bank' ? 'BK' : (p.kind === 'cash' ? 'CS' : 'MP');
    return '<button class="row tap" data-rcpt="' + Number(p.id) + '"><div class="ic ' + cls + '">' + ab + '</div><div class="mid"><b>' + esc(p.reference || (p.channel + ' payment')) + '</b><span>' + esc(fmtDate(p.received_at, p.kind === 'mpesa')) + '</span></div>' +
      '<div class="amt pos">+ ' + KES(p.amount) + '<small>' + esc(p.channel) + '</small></div></button>';
  }
  function bindRows() { Array.prototype.forEach.call(document.querySelectorAll('[data-rcpt]'), function (b) { b.onclick = function () { openReceipt(Number(b.getAttribute('data-rcpt'))); }; }); }
  function loading() { return '<div class="panel"><div class="skel" style="width:60%"></div><div class="skel" style="width:85%"></div><div class="skel" style="width:40%"></div></div>'; }
  function failBox(msg) { return '<div class="note">' + esc(msg) + ' <button class="link" id="retry">Try again</button></div>'; }

  function homeHtml(d) {
    var c = d.child, b = c.balance, clear = b <= 0, pct = c.due > 0 ? Math.min(100, Math.round(c.paid / c.due * 100)) : (c.paid > 0 ? 100 : 0);
    var lbl = !c.term ? 'No term has started yet' : (c.state === 'not_billed' ? 'Nothing has been billed yet this term' : (b < 0 ? 'Paid ahead (credit)' : (b === 0 ? 'Fees are fully paid' : 'Balance to pay')));
    var h = '<div class="hero ' + (clear ? 'clear' : '') + '"><div class="lbl">' + esc(c.first_name) + ' (' + esc(c.admission_no) + ')' + (c.term ? ' &nbsp;|&nbsp; ' + esc(c.term) : '') + '</div>' +
      '<div class="lbl" style="margin-top:12px">' + esc(lbl) + '</div>' +
      '<div class="bal"><small>KES</small>' + KES(Math.abs(b)) + '</div>' +
      '<div class="bar"><div style="width:' + pct + '%"></div></div>' +
      '<div class="barnote"><span>Paid KES ' + KES(c.paid) + '</span><span>of KES ' + KES(c.due) + '</span></div>' +
      '<div class="cta"><button class="btn go" id="payBtn">' + (d.pay.online ? (clear ? 'Pay ahead with M-Pesa' : 'Pay with M-Pesa') : 'How to pay') + '</button></div></div>';
    h += '<div class="tiles"><div class="tile"><div class="l">Brought forward</div><div class="n">' + KES(c.brought_forward) + '</div></div>' +
      '<div class="tile"><div class="l">Fees this term</div><div class="n">' + KES(c.fees_charged) + '</div></div>' +
      '<div class="tile"><div class="l">Paid</div><div class="n pos">' + KES(c.paid) + '</div></div></div>';
    h += '<div class="sec"><h2>Recent payments</h2><button class="link" id="seeAll">See all</button></div><div class="panel">' +
      (d.recent_payments.length ? d.recent_payments.map(payRow).join('') : '<div class="empty">No payments yet.</div>') + '</div>';
    return h;
  }
  function feesHtml(d) {
    var c = d.child, h = '<div class="sec" style="margin-top:4px"><h2>What ' + esc(c.first_name) + ' is charged this term</h2></div><div class="panel">';
    if (d.items.length) {
      h += d.items.map(function (i) { return '<div class="row"><div class="mid"><b>' + esc(i.name) + '</b>' + (i.optional ? '<span>Optional, chosen by you</span>' : '') + '</div><div class="amt">' + KES(i.amount) + '</div></div>'; }).join('');
      h += '<div class="sum"><span>Fees for ' + esc(d.term) + '</span><span class="mono">' + KES(d.total) + '</span></div>';
    } else h += '<div class="empty">The fees for this term have not been set up yet.</div>';
    h += '</div><div class="sec"><h2>Term by term</h2></div><div class="panel">' + (d.by_term.length ? d.by_term.map(function (r) {
      var tg = r.balance > 0 ? '<span class="tag owing">Owing ' + KES(r.balance) + '</span>' : (r.balance < 0 ? '<span class="tag over">Credit ' + KES(-r.balance) + '</span>' : '<span class="tag cleared">Cleared</span>');
      return '<div class="row"><div class="mid"><b>' + esc(r.label) + '</b><span>Charged ' + KES(r.fees_charged) + (r.brought_forward ? ' + brought forward ' + KES(r.brought_forward) : '') + ', paid ' + KES(r.paid) + '</span></div>' + tg + '</div>';
    }).join('') : '<div class="empty">Nothing billed yet.</div>') + '</div>';
    return h + '<div class="note">Balance = brought forward + fees charged - paid. The school updates this every time a payment arrives.</div>';
  }
  function paysHtml(d) {
    return '<div class="sec" style="margin-top:4px"><h2>Payment history for ' + esc(d.child.first_name) + '</h2></div><div class="panel">' +
      (d.payments.length ? d.payments.map(payRow).join('') : '<div class="empty">No payments yet.</div>') + '</div>' +
      '<div class="note">Tap a payment for its receipt. Paid at the bank or in cash? It shows here after the school records it.</div>';
  }

  async function draw() {
    drawShell();
    var k = kid(), v = $('view');
    if (!k) { v.innerHTML = '<div class="note">No students are linked to this phone number right now. If this is wrong, please contact the school.</div><button class="btn" style="margin-top:14px" id="noKidsOut">Sign out</button>'; $('noKidsOut').onclick = logout; return; }
    var key = S.tab === 'home' ? 'home' : (S.tab === 'fees' ? 'fees' : 'pays'), path = { home: '', fees: '/fees', pays: '/payments?limit=200' }[key];
    var cc = cache();
    if (!cc[key]) {
      v.innerHTML = loading();
      var myKid = k.id, myTab = S.tab;
      try { cc[key] = await api('GET', '/children/' + k.id + path); }
      catch (e) { if (S.token && kid() && kid().id === myKid && S.tab === myTab) { v.innerHTML = failBox(e.message); $('retry').onclick = draw; } return; }
      if (!kid() || kid().id !== myKid || S.tab !== myTab) return;                 // the parent moved on while it loaded
    }
    var d = cc[key];
    v.innerHTML = key === 'home' ? homeHtml(d) : (key === 'fees' ? feesHtml(d) : paysHtml(d));
    bindRows();
    if (key === 'home') { $('payBtn').onclick = openPay; $('seeAll').onclick = function () { go('pays'); }; }
  }

  /* ---------- receipt ---------- */
  async function openReceipt(id) {
    var k = kid(); $('sheet').innerHTML = '<div class="hd"><h2>Receipt</h2><button class="x" id="xr" aria-label="Close">&times;</button></div>' + loading();
    $('shade').classList.add('open'); $('xr').onclick = closePay;
    try {
      var r = await api('GET', '/children/' + k.id + '/payments/' + id + '/receipt');
      var row = function (a, b) { return b == null || b === '' ? '' : '<div class="kv"><span class="muted">' + esc(a) + '</span><b>' + esc(b) + '</b></div>'; };
      $('sheet').innerHTML = '<div class="hd"><h2>' + esc(r.school) + '</h2><button class="x" id="xr" aria-label="Close">&times;</button></div><div class="muted" style="font-size:13px">Receipt ' + esc(r.receipt_no) + '</div>' +
        '<div class="rcpt">' + row('Date', fmtDate(r.received_at, true)) + row('Amount', 'KES ' + KES(r.amount)) + row('Paid by', r.channel) + row('Reference', r.reference) +
        row('Student', r.student.full_name + ' (' + r.student.admission_no + ')') + row('Class', [r.student.class, r.student.stream].filter(Boolean).join(' ')) + row('Term', r.term) +
        (r.balance_after == null ? '' : row('Balance after', r.balance_after > 0 ? 'KES ' + KES(r.balance_after) : (r.balance_after < 0 ? 'Credit KES ' + KES(-r.balance_after) : 'Cleared'))) + '</div>' +
        '<button class="btn noprint" style="margin-top:14px" id="prt">Print or save as PDF</button>';
      $('xr').onclick = closePay; $('prt').onclick = function () { window.print(); };
    } catch (e) { $('sheet').innerHTML = '<div class="hd"><h2>Receipt</h2><button class="x" id="xr" aria-label="Close">&times;</button></div>' + failBox(e.message); $('xr').onclick = closePay; $('retry').onclick = function () { openReceipt(id); }; }
  }

  /* ---------- the pay sheet ---------- */
  function openPay() {
    var d = cache().home, k = kid(), b = d.child.balance;
    S.pay = { amt: b > 0 ? b : 0 };
    S.payRun++;
    $('shade').classList.add('open');
    payForm('');
  }
  function closePay() { S.payRun++; $('shade').classList.remove('open'); }
  function copyTxt(t, btn) { try { navigator.clipboard.writeText(t); } catch (e) { /* the number is on screen anyway */ } btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy'; }, 1200); }
  function paybillBlock(d) {
    var pb = d.pay.paybill; if (!pb) return '';
    return '<div class="alt"><h3>' + (d.pay.online ? 'Or pay yourself from the M-Pesa menu' : 'Pay from the M-Pesa menu') + '</h3><div class="muted" style="font-size:12.5px;margin-bottom:4px">Lipa na M-Pesa, then Paybill</div>' +
      '<div class="kv"><span>Business number</span><span><b>' + esc(pb.business_number) + '</b><button data-copy="' + esc(pb.business_number) + '">Copy</button></span></div>' +
      '<div class="kv"><span>Account number</span><span><b>' + esc(pb.account_number) + '</b><button data-copy="' + esc(pb.account_number) + '">Copy</button></span></div>' +
      '<div class="muted" style="font-size:12.5px;margin-top:6px">Always use the admission number as the account, so the money reaches the right child.</div></div>';
  }
  function bindCopy() { Array.prototype.forEach.call(document.querySelectorAll('[data-copy]'), function (b) { b.onclick = function () { copyTxt(b.getAttribute('data-copy'), b); }; }); }
  function payForm(msg) {
    var d = cache().home, c = d.child, b = c.balance, h;
    h = '<div class="hd"><h2>Pay for ' + esc(c.first_name) + '</h2><button class="x" id="xp" aria-label="Close">&times;</button></div>' +
      '<div class="muted" style="font-size:13px">' + esc(c.admission_no) + ' &nbsp;|&nbsp; ' + esc(c.class || '') + (b > 0 ? ' &nbsp;|&nbsp; Balance KES ' + KES(b) : '') + '</div>';
    if (d.pay.online) {
      h += '<label for="amt">Amount (KES)</label><input class="in" id="amt" inputmode="numeric" value="' + (S.pay.amt ? KES(S.pay.amt) : '') + '">' +
        '<div class="quick">' + (b > 0 ? '<button data-amt="' + b + '">Full balance</button><button data-amt="' + Math.round(b / 2) + '">Half</button>' : '') + '<button data-amt="5000">5,000</button></div>' +
        '<label for="ph">M-Pesa phone number</label><input class="in" id="ph" inputmode="tel" value="' + esc(S.pay.phone || pretty(S.me.phone)) + '">' +
        '<div class="err" id="err">' + esc(msg) + '</div><button class="btn go" id="send" style="margin-top:6px">Send request to my phone</button>' + paybillBlock(d);
    } else if (d.pay.paybill) {
      h += paybillBlock(d) + '<div class="note">Online "send to my phone" payment is not switched on for this school yet. Pay from your M-Pesa menu with the numbers above, and it shows here after the school records it.</div><button class="btn" style="margin-top:14px" id="xp2">Close</button>';
    } else {
      var banks = d.pay.banks && d.pay.banks.length ? ' (' + esc(d.pay.banks.join(' or ')) + ')' : '';
      h += '<div class="alt" style="margin-top:20px"><h3>Online payment is not switched on yet</h3><div class="muted" style="font-size:13.5px">' + esc(c.school.name) + ' has not set up M-Pesa online payment. Please pay at the school bank account' + banks + ' and use <b class="mono" style="color:var(--ink)">' + esc(c.admission_no) + '</b> as the reference. Your payment shows here after the school records it.' +
        (d.pay.school_phone ? '<br><br>Questions? Call the school on ' + esc(d.pay.school_phone) + '.' : '') + '</div></div><button class="btn" style="margin-top:14px" id="xp2">Close</button>';
    }
    $('sheet').innerHTML = h;
    $('xp').onclick = closePay; var x2 = $('xp2'); if (x2) x2.onclick = closePay;
    bindCopy();
    if (d.pay.online) {
      var amt = $('amt');
      amt.oninput = function () { var n = Number(amt.value.replace(/\D/g, '')); S.pay.amt = n; amt.value = n ? KES(n) : ''; };
      Array.prototype.forEach.call(document.querySelectorAll('[data-amt]'), function (q) { q.onclick = function () { S.pay.amt = Number(q.getAttribute('data-amt')); amt.value = KES(S.pay.amt); $('err').textContent = ''; }; });
      $('ph').oninput = function () { S.pay.phone = this.value; };
      $('send').onclick = sendPush;
    }
  }
  async function sendPush() {
    var d = cache().home, c = d.child, ph = $('ph').value, err = $('err');
    if (!S.pay.amt || S.pay.amt < 1) { err.textContent = 'Enter an amount of at least KES 1.'; return; }
    if (d.pay.max_amount && S.pay.amt > d.pay.max_amount) { err.textContent = 'The most you can pay in one request is KES ' + KES(d.pay.max_amount) + '. Pay in parts if you need to.'; return; }
    if (!/^(\+?254|0)?[17]\d{8}$/.test(ph.replace(/[\s-]/g, ''))) { err.textContent = 'Enter a phone number like 0712 345 678.'; return; }
    $('send').disabled = true; err.textContent = '';
    var run = ++S.payRun, amount = S.pay.amt;
    try {
      var r = await api('POST', '/children/' + c.id + '/pay', { amount: amount, phone: ph });
      if (run !== S.payRun) return;
      waiting(c, amount, ph, r.request_id, run);
    } catch (e) { if (run === S.payRun) { payForm(e.message); } }
  }
  function waiting(c, amount, ph, requestId, run) {
    var t0 = Date.now(), msg = '';
    function paint() {
      var left = Math.max(0, 60 - Math.round((Date.now() - t0) / 1000)), slow = Date.now() - t0 > 150000;
      $('sheet').innerHTML = '<div class="state"><div class="phone"></div><h2>Check your phone</h2><p>We sent a request for <b class="mono" style="color:var(--ink)">KES ' + KES(amount) + '</b> to ' + esc(pretty(ph)) + '.<br>Enter your M-Pesa PIN to finish.</p>' +
        (msg ? '<p style="margin-top:12px;font-size:13px">' + esc(msg) + '</p>' : '') +
        (slow ? '<p style="margin-top:14px;font-size:12.5px">This is taking longer than usual. If money left your phone, it will show under Payments shortly.</p>'
              : '<p style="margin-top:14px;font-size:12.5px">Waiting for M-Pesa... ' + (left > 0 ? '<span class="mono">' + left + '</span>s' : '') + '</p>') +
        '<button class="btn" style="margin-top:18px" id="wc">' + (slow ? 'Close' : 'Cancel') + '</button></div>';
      $('wc').onclick = function () {
        S.payRun++;                                                   // stop polling
        if (!slow) api('POST', '/children/' + c.id + '/pay/' + requestId + '/cancel').catch(function () { /* the request times out by itself */ });
        closePay(); draw();
      };
    }
    paint();
    var tick = setInterval(function () { if (run !== S.payRun) return clearInterval(tick); if ($('wc')) paint(); }, 1000);
    (async function poll() {
      while (run === S.payRun && Date.now() - t0 < 300000) {
        await new Promise(function (r) { setTimeout(r, 3000); });
        if (run !== S.payRun) return;
        var st;
        try { st = await api('GET', '/children/' + c.id + '/pay/' + requestId); } catch (e) { continue; }          // a bad connection for a moment: keep trying
        if (run !== S.payRun) return;
        if (st.status === 'paid') { clearInterval(tick); return done(c, amount, st); }
        if (['cancelled', 'failed', 'timeout'].indexOf(st.status) > -1) { clearInterval(tick); return ended(c, st); }
        msg = st.confirmed ? st.message : '';
      }
      clearInterval(tick);
    })();
  }
  async function done(c, amount, st) {
    var cc = cache(); cc.home = null; cc.pays = null; cc.fees = null;                      // the numbers changed: reload them
    var bal = null;
    try { cc.home = await api('GET', '/children/' + c.id); bal = cc.home.child.balance; } catch (e) { /* the receipt below is still true */ }
    var me = S.me.children[S.cur]; if (cc.home) { me.balance = cc.home.child.balance; me.paid = cc.home.child.paid; }
    $('sheet').innerHTML = '<div class="state"><div class="tick"><svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg></div><h2>Payment received</h2><p>Thank you. ' + esc(c.first_name) + '\'s balance is updated.</p></div>' +
      '<div class="rcpt"><div class="kv"><span class="muted">Amount</span><b>KES ' + KES(st.amount || amount) + '</b></div><div class="kv"><span class="muted">M-Pesa code</span><b>' + esc(st.receipt || '') + '</b></div><div class="kv"><span class="muted">Student</span><b>' + esc(c.admission_no) + '</b></div>' +
      (bal == null ? '' : '<div class="kv"><span class="muted">' + (bal > 0 ? 'Balance now' : 'Balance') + '</span><b>' + (bal > 0 ? 'KES ' + KES(bal) : (bal < 0 ? 'Credit KES ' + KES(-bal) : 'Cleared')) + '</b></div>') + '</div>' +
      '<button class="btn go" id="dn">Done</button>';
    $('dn').onclick = function () { closePay(); draw(); };
    draw();
  }
  function ended(c, st) {
    $('sheet').innerHTML = '<div class="state"><div class="bad">!</div><h2>' + (st.status === 'cancelled' ? 'Request cancelled' : 'Payment not completed') + '</h2><p>' + esc(st.message) + '</p></div>' +
      '<button class="btn go" id="again">Try again</button><button class="btn ghost" id="cl">Close</button>';
    $('again').onclick = function () { S.payRun++; payForm(''); };
    $('cl').onclick = function () { closePay(); draw(); };
  }

  $('shade').addEventListener('click', function (e) { if (e.target.id === 'shade') closePay(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closePay(); });

  /* ---------- go ---------- */
  (async function boot() {
    if (!S.token) return showLogin('');
    try { await start(); } catch (e) { if (S.token) { show('app', false); showLogin('Could not open the portal: ' + e.message); } }
  })();
})();