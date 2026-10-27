/* page-staff.js - the STAFF page, plus the two screens that belong to it: "Choose your password" (the link in the email)
   and "Forgot password" (on the login screen). Replaces the old demo Staff screen.
   - Admins invite people by email. Nobody ever sees or sets anyone else's password: the person chooses their own
     through a one-time link in their email. A password change or a suspension signs that person out everywhere.
   - Roles: Main Admin (one per school, can never be removed) > Admin > Staff. Admins manage Staff people; only the Main Admin
     manages other Admins. The server enforces every rule; the buttons here just hide what you cannot do.
   - "My account" (top of the page, for everyone): change my password, edit my name; the Main Admin can change email and hand over the Main Admin role.
   - While email is not set up (running on your own computer) the page shows the link on screen instead, so you can try it.
   Endpoints: see src/routes/staffRoutes.js and routes/auth.js.
   Add to index.html AFTER page-balances.js (before shell.js):  <script src="js/page-staff.js"></script> */

const st = { me: null, list: null, error: null, token: 0, form: null, formErr: '', busy: false };

(function () {
  if (document.getElementById('stStyle')) return;
  const css = document.createElement('style');
  css.id = 'stStyle';
  css.textContent = [
    '.st-card{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:18px 20px;margin:0 0 16px}',
    '.st-me{display:flex;gap:16px;align-items:center;justify-content:space-between;flex-wrap:wrap}',
    '.st-me h2{font-family:"Space Grotesk",sans-serif;font-size:19px;margin:0 0 3px}',
    '.st-me p{margin:0;font-size:13px;color:var(--muted);overflow-wrap:anywhere}',
    '.st-acts{display:flex;gap:8px;flex-wrap:wrap}',
    '.st-b{font:inherit;font-size:12.5px;font-weight:600;border-radius:9px;padding:7px 13px;cursor:pointer;border:1px solid var(--line);background:transparent;color:var(--ink)}',
    '.st-b:hover:not(:disabled){border-color:var(--muted)}',
    '.st-b.go{background:var(--matched);border-color:var(--matched);color:#0E1613}',
    '.st-b.bad{border-color:rgba(226,87,76,.6);color:var(--alert)}',
    '.st-b:disabled{opacity:.5;cursor:not-allowed}',
    '.st-head{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 12px}',
    '.st-head h2{font-family:"Space Grotesk",sans-serif;font-size:17px;margin:0}',
    '.st-row{display:grid;grid-template-columns:minmax(0,2.2fr) auto minmax(0,1.1fr) minmax(0,1.6fr);gap:12px;align-items:center;padding:13px 0;border-top:1px solid var(--line)}',
    '.st-row:first-of-type{border-top:0}',
    '.st-nm{font-weight:600;overflow-wrap:anywhere}',
    '.st-sub{font-size:12px;color:var(--muted);overflow-wrap:anywhere}',
    '.st-tag{display:inline-block;font-size:11px;letter-spacing:.05em;text-transform:uppercase;border:1px solid var(--line);border-radius:20px;padding:2px 9px;color:var(--muted);margin-right:5px}',
    '.st-tag.own{border-color:var(--cash);color:var(--cash)} .st-tag.adm{border-color:var(--bank);color:var(--bank)} .st-tag.ok{border-color:var(--matched);color:var(--matched)} .st-tag.warn{border-color:var(--repeat);color:var(--repeat)} .st-tag.off{border-color:var(--alert);color:var(--alert)}',
    '.st-rowacts{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}',
    '.st-empty{text-align:center;padding:36px 20px;border:1px dashed var(--line);border-radius:16px;color:var(--muted);font-size:13.5px;line-height:1.6}',
    '.st-ov{position:fixed;inset:0;background:rgba(5,10,8,.72);z-index:120;display:flex;align-items:center;justify-content:center;padding:16px}',
    '.st-box{background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:24px;width:100%;max-width:440px;max-height:92vh;overflow-y:auto;box-sizing:border-box}',
    '.st-box h3{font-family:"Space Grotesk",sans-serif;font-size:19px;margin:0 0 8px}',
    '.st-box p{font-size:13.5px;line-height:1.6;color:var(--muted);margin:0 0 12px}',
    '.st-box label{display:block;font-size:12px;color:var(--muted);margin:12px 0 5px}',
    '.st-in{font:inherit;font-size:14px;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:10px 12px;width:100%;box-sizing:border-box}',
    '.st-in:focus{outline:none;border-color:var(--matched)}',
    '.st-err{margin-top:12px;padding:10px 13px;border-radius:10px;font-size:13px;line-height:1.5;background:rgba(226,87,76,.1);border:1px solid rgba(226,87,76,.45)}',
    '.st-foot{display:flex;gap:10px;justify-content:flex-end;margin-top:18px;flex-wrap:wrap}',
    '.st-link{display:block;margin-top:10px;padding:10px 12px;border:1px dashed var(--cash);border-radius:10px;font-family:"IBM Plex Mono",monospace;font-size:12px;overflow-wrap:anywhere;user-select:all;color:var(--ink)}',
    '.st-auth{position:fixed;inset:0;z-index:150;background:var(--bg);display:flex;align-items:center;justify-content:center;padding:16px;overflow-y:auto}',
    '.st-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:var(--surface-raised);border:1px solid var(--matched);padding:11px 18px;border-radius:10px;font-size:13px;z-index:200;max-width:90vw}',
    '.st-toast.bad{border-color:var(--alert)}',
    '@media(max-width:820px){.st-row{grid-template-columns:1fr auto}.st-row>:nth-child(3){grid-column:1/2}.st-rowacts{grid-column:1/3;justify-content:flex-start}}',
  ].join('\n');
  document.head.appendChild(css);
})();

const stEl = function (id) { return document.getElementById(id); };
const stBase = function () { return '/schools/' + live.staff.school_id; };
const stRoleLabel = function (p) { return p.is_owner ? 'Main Admin' : (p.role === 'admin' ? 'Admin' : 'Staff'); };
function stToast(msg, bad) {
  const old = stEl('stToast'); if (old) old.remove();
  const d = document.createElement('div'); d.id = 'stToast'; d.className = 'st-toast' + (bad ? ' bad' : ''); d.textContent = msg;
  document.body.appendChild(d); setTimeout(function () { if (d.parentNode) d.remove(); }, 4800);
}
const stWhen = function (iso) {
  if (!iso) return 'Never';
  const d = new Date(iso); if (isNaN(d)) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) + ', ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
};

/* ---------- a small dialog used by every action ---------- */
// fields: [{id,label,type,value,options:[[v,l]],placeholder,autocomplete}]. run(values) does the work; throwing keeps the dialog open with the message.
function stDialog(o) {
  return new Promise(function (resolve) {
    const old = stEl('stDlg'); if (old) old.remove();
    const ov = document.createElement('div'); ov.id = 'stDlg'; ov.className = 'st-ov';
    const fields = (o.fields || []).map(function (f) {
      const inp = f.type === 'select'
        ? '<select class="st-in" id="stf_' + f.id + '">' + f.options.map(function (x) { return '<option value="' + esc(x[0]) + '"' + (String(x[0]) === String(f.value) ? ' selected' : '') + '>' + esc(x[1]) + '</option>'; }).join('') + '</select>'
        : '<input class="st-in" id="stf_' + f.id + '" type="' + (f.type || 'text') + '" value="' + esc(f.value || '') + '" placeholder="' + esc(f.placeholder || '') + '" autocomplete="' + (f.autocomplete || 'off') + '"' + (f.inputmode ? ' inputmode="' + f.inputmode + '"' : '') + '>';
      return '<label for="stf_' + f.id + '">' + esc(f.label) + '</label>' + inp;
    }).join('');
    ov.innerHTML = '<div class="st-box" role="dialog" aria-modal="true"><h3>' + esc(o.title) + '</h3>' + (o.intro ? '<p>' + o.intro + '</p>' : '') + (o.extra || '') + fields +
      '<div class="st-err" id="stDlgErr" style="display:none"></div><div class="st-foot">' + (o.noCancel ? '' : '<button type="button" class="st-b" id="stDlgNo">Cancel</button>') +
      '<button type="button" class="st-b ' + (o.danger ? 'bad' : 'go') + '" id="stDlgOk">' + esc(o.okText || 'OK') + '</button></div></div>';
    document.body.appendChild(ov);
    const close = function (v) { ov.remove(); resolve(v); };
    const no = stEl('stDlgNo'); if (no) no.onclick = function () { close(null); };
    ov.addEventListener('mousedown', function (e) { if (e.target === ov && !o.noCancel) close(null); });
    const ok = stEl('stDlgOk');
    const go = async function () {
      const vals = {}; (o.fields || []).forEach(function (f) { vals[f.id] = stEl('stf_' + f.id).value; });
      ok.disabled = true; const err = stEl('stDlgErr'); err.style.display = 'none';
      try { const r = o.run ? await o.run(vals) : vals; close(r === undefined ? true : r); }
      catch (e) { err.textContent = e.message; err.style.display = 'block'; ok.disabled = false; }
    };
    ok.onclick = go;
    ov.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target.tagName !== 'SELECT') { e.preventDefault(); go(); } else if (e.key === 'Escape' && !o.noCancel) close(null); });
    const first = ov.querySelector('input,select'); (first || ok).focus();
  });
}
// After an email-sending action: say what happened. In local dev mode the link is shown on screen.
async function stMailResult(m, who) {
  if (!m) return;
  if (m.dev) {
    await stDialog({ title: 'Email is not set up on this computer', intro: 'Normally this link is emailed to ' + esc(who) + ' and you never see it. While you are testing locally, here it is. Open it in a private window to try the "choose your password" page.',
      extra: '<div class="st-link">' + esc(m.link) + '</div>', okText: 'Done', noCancel: true });
    return;
  }
  if (m.sent) stToast('Email sent to ' + who + '.');
  else if (m.error) stToast('Saved, but ' + m.error, true);
}

/* ---------- the page ---------- */
views.staff = function () {
  st.list = null; st.me = null; st.error = null; st.form = null;
  setTimeout(function () { stLoad(); }, 0);
  return '<div id="stRoot">' + stBody() + '</div>';
};
async function stLoad() {
  const token = ++st.token;
  try {
    const me = await Api.get(stBase() + '/me');
    const list = me.role === 'admin' ? await Api.get(stBase() + '/staff') : null;
    if (token !== st.token) return;
    st.me = me; st.list = list; st.error = null;
    if (live.staff) { live.staff.role = me.role; live.staff.is_owner = me.is_owner; live.staff.full_name = me.full_name; }
  } catch (e) { if (token !== st.token) return; st.error = e.message; }
  stRender();
}
function stRender() { const r = stEl('stRoot'); if (r) r.innerHTML = stBody(); }

function stStatusTag(p) {
  if (p.status === 'suspended') return '<span class="st-tag off">Suspended</span>';
  if (p.status === 'invited') return p.invite_expired ? '<span class="st-tag warn">Invite expired</span>' : '<span class="st-tag warn">Invited</span>';
  return '<span class="st-tag ok">Active</span>';
}
// what the signed-in person may do to this row (the server checks again)
function stActionsFor(p) {
  const me = st.me; if (!me || me.role !== 'admin' || p.id === me.id || p.is_owner) return [];
  if (p.role === 'admin' && !me.is_owner) return [];
  const a = [];
  if (p.status === 'invited') a.push(['resend', 'Resend invite']);
  if (p.status === 'active') a.push(['reset', 'Send reset link']);
  if (p.status === 'suspended') a.push(['reactivate', 'Reactivate']);
  a.push(['name', 'Edit name'], ['email', 'Change email']);
  if (me.is_owner && p.status === 'active') a.push(['role', p.role === 'admin' ? 'Make Staff' : 'Make Admin']);
  if (p.status !== 'suspended') a.push(['suspend', 'Suspend']);
  return a;
}
function stRow(p) {
  const acts = stActionsFor(p).map(function (x) { return '<button type="button" class="st-b' + (x[0] === 'suspend' ? ' bad' : '') + '" onclick="stAct(\'' + x[0] + '\',' + p.id + ')">' + x[1] + '</button>'; }).join('');
  const tag = p.is_owner ? '<span class="st-tag own">Main Admin</span>' : (p.role === 'admin' ? '<span class="st-tag adm">Admin</span>' : '<span class="st-tag">Staff</span>');
  const extra = p.status === 'invited' ? (p.invite_expired ? 'Invite expired. Press Resend.' : 'Waiting to join &middot; link expires ' + esc(stWhen(p.invite_expires_at))) : 'Last sign-in: ' + esc(stWhen(p.last_login_at));
  return '<div class="st-row"><div><div class="st-nm">' + esc(p.full_name) + (st.me && p.id === st.me.id ? ' <span class="st-sub">(you)</span>' : '') + '</div><div class="st-sub">' + esc(p.email || '') + '</div>' +
    (p.pending_email ? '<div class="st-sub">Change to ' + esc(p.pending_email) + ' waiting for confirmation</div>' : '') + '</div>' +
    '<div>' + tag + '</div><div>' + stStatusTag(p) + '</div><div class="st-sub">' + extra + '</div><div class="st-rowacts" style="grid-column:1/-1;justify-content:flex-start">' + acts + '</div></div>';
}
function stBody() {
  const head = '<div class="topbar"><div><h1>Staff</h1><p class="sub">Who can sign in to this school\'s Karo Recon. People choose their own passwords. Nobody, not even an Admin, ever sees one.</p></div></div>';
  if (st.error) return head + '<div class="st-empty"><b>Could not load staff</b><br>' + esc(st.error) + '<br><br><button type="button" class="st-b" onclick="stLoad()">Try again</button></div>';
  if (!st.me) return head + '<div class="st-empty">Loading...</div>';
  const m = st.me;
  const mine = '<div class="st-card"><div class="st-me"><div><h2>' + esc(m.full_name) + ' <span class="st-tag ' + (m.is_owner ? 'own' : (m.role === 'admin' ? 'adm' : '')) + '">' + stRoleLabel(m) + '</span></h2><p>' + esc(m.email || '') + ' &middot; last sign-in ' + esc(stWhen(m.last_login_at)) + '</p></div>' +
    '<div class="st-acts"><button type="button" class="st-b go" onclick="stAct(\'mypw\')">Change my password</button><button type="button" class="st-b" onclick="stAct(\'myname\')">Edit my name</button>' +
    (m.is_owner ? '<button type="button" class="st-b" onclick="stAct(\'myemail\')">Change my email</button><button type="button" class="st-b" onclick="stAct(\'transfer\')">Hand over Main Admin role</button>' : '') + '</div></div></div>';
  if (m.role !== 'admin') return head + mine + '<div class="st-empty">Only Admins can see and manage the staff list. You can change your own password above.</div>';
  const list = st.list || [];
  return head + mine + '<div class="st-head"><h2>People (' + list.length + ')</h2><button type="button" class="st-b go" onclick="stAct(\'invite\')">+ Add staff member</button></div>' +
    '<div class="st-card" style="padding-top:6px;padding-bottom:6px">' + (list.length ? list.map(stRow).join('') : '<div class="st-empty">No staff yet.</div>') + '</div>' +
    '<p class="st-sub">Suspended people keep their name in the activity log. They are signed out at once and can be brought back any time.</p>';
}

/* ---------- actions ---------- */
async function stAct(kind, id) {
  const p = id && st.list ? st.list.find(function (x) { return x.id === id; }) : null;
  const sid = function (pid) { return stBase() + '/staff/' + pid; };
  let r;
  if (kind === 'invite') {
    const owner = st.me.is_owner;
    r = await stDialog({ title: 'Add a staff member', intro: 'They get an email with a link to choose their own password. The link works once and lasts 48 hours.',
      fields: [{ id: 'full_name', label: 'Full name' }, { id: 'email', label: 'Email address', type: 'email', autocomplete: 'off' },
        { id: 'role', label: 'Role', type: 'select', value: 'staff', options: owner ? [['staff', 'Staff - records payments, looks up students'], ['admin', 'Admin - also manages staff, terms and fees']] : [['staff', 'Staff - records payments, looks up students']] }],
      okText: 'Send invite', run: function (v) { return Api.post(stBase() + '/staff', v); } });
    if (r && r.staff) { await stLoad(); await stMailResult(r.mail, r.staff.email); }
    return;
  }
  if (kind === 'resend') { r = await stCall(function () { return Api.post(sid(id) + '/resend-invite'); }); if (r) { await stLoad(); await stMailResult(r.mail, p.email); } return; }
  if (kind === 'reset') {
    r = await stDialog({ title: 'Send a reset link?', intro: 'We email ' + esc(p.full_name) + ' (' + esc(p.email) + ') a link to choose a new password. It works once and lasts 1 hour. Their current password keeps working until they use it.', okText: 'Send link', run: function () { return Api.post(sid(id) + '/send-reset'); } });
    if (r && r.mail) await stMailResult(r.mail, p.email); return;
  }
  if (kind === 'suspend') {
    r = await stDialog({ title: 'Suspend ' + p.full_name + '?', intro: 'They are signed out right away and cannot sign in until you reactivate them. Their name stays in the activity log.', okText: 'Suspend', danger: true, run: function () { return Api.post(sid(id) + '/status', { status: 'suspended' }); } });
    if (r) { stToast(p.full_name + ' is suspended.'); await stLoad(); } return;
  }
  if (kind === 'reactivate') {
    r = await stCall(function () { return Api.post(sid(id) + '/status', { status: 'active' }); });
    if (r) { stToast(p.full_name + ' is back.' + (r.status === 'invited' ? ' They never joined, so press Resend invite.' : '')); await stLoad(); } return;
  }
  if (kind === 'role') {
    const to = p.role === 'admin' ? 'staff' : 'admin';
    r = await stDialog({ title: (to === 'admin' ? 'Make ' : 'Change ') + p.full_name + (to === 'admin' ? ' an Admin?' : ' to Staff?'), intro: to === 'admin' ? 'Admins can manage staff, term dates and fees.' : 'They will lose the Admin powers.', okText: 'Yes, change', run: function () { return Api.post(sid(id) + '/role', { role: to }); } });
    if (r) { stToast('Role changed.'); await stLoad(); } return;
  }
  if (kind === 'name' || kind === 'myname') {
    const target = kind === 'myname' ? st.me : p;
    r = await stDialog({ title: 'Edit name', fields: [{ id: 'full_name', label: 'Full name', value: target.full_name }], okText: 'Save', run: function (v) { return Api.post(sid(target.id) + '/name', v); } });
    if (r) { stToast('Name saved.'); await stLoad(); } return;
  }
  if (kind === 'email' || kind === 'myemail') {
    const target = kind === 'myemail' ? st.me : p;
    const joined = target.status !== 'invited';
    r = await stDialog({ title: 'Change email', intro: joined ? 'We send a confirmation link to the NEW address. The old address keeps working until it is confirmed.' : 'They have not joined yet, so the address changes now and a new invite is sent to it.',
      fields: [{ id: 'email', label: 'New email address', type: 'email' }], okText: joined ? 'Send confirmation' : 'Change and resend', run: function (v) { return Api.post(sid(target.id) + '/email', v); } });
    if (r) { await stLoad(); await stMailResult(r.mail, 'the new address'); } return;
  }
  if (kind === 'mypw') {
    r = await stDialog({ title: 'Change my password', intro: 'You stay signed in here. Anywhere else you are signed in will be signed out.',
      fields: [{ id: 'current', label: 'Current password', type: 'password', autocomplete: 'current-password' }, { id: 'password', label: 'New password (at least 8 characters)', type: 'password', autocomplete: 'new-password' }, { id: 'again', label: 'New password again', type: 'password', autocomplete: 'new-password' }],
      okText: 'Change password', run: async function (v) { if (v.password !== v.again) throw new Error('The two new passwords are not the same.'); return Api.post('/auth/change-password', { current: v.current, password: v.password }); } });
    if (r && r.token) { Api.save(r.token, Api.staff()); stToast('Password changed.'); } return;
  }
  if (kind === 'transfer') {
    const admins = (st.list || []).filter(function (x) { return x.role === 'admin' && x.status === 'active' && !x.is_owner; });
    if (!admins.length) { await stDialog({ title: 'Hand over Main Admin role', intro: 'The new Main Admin must already be an active Admin. Add or promote an Admin first, then come back.', okText: 'OK', noCancel: true }); return; }
    r = await stDialog({ title: 'Hand over Main Admin role', intro: 'The new Main Admin becomes the one person nobody can remove, and you become an ordinary Admin. Type your password to confirm.',
      fields: [{ id: 'to', label: 'New Main Admin', type: 'select', value: admins[0].id, options: admins.map(function (x) { return [x.id, x.full_name + ' (' + x.email + ')']; }) }, { id: 'password', label: 'Your password', type: 'password', autocomplete: 'current-password' }],
      okText: 'Hand over', danger: true, run: function (v) { return Api.post(stBase() + '/transfer-ownership', { to_staff_id: Number(v.to), password: v.password }); } });
    if (r) { stToast('Main Admin role handed over.'); await stLoad(); } return;
  }
}
async function stCall(fn) { try { return await fn(); } catch (e) { stToast(e.message, true); return null; } }

/* ---------- the email link: "Choose your password" ---------- */
function stAuthScreen(html) {
  let s = stEl('stAuth');
  if (!s) { s = document.createElement('div'); s.id = 'stAuth'; s.className = 'st-auth'; document.body.appendChild(s); }
  s.innerHTML = '<div class="st-box"><div style="font-family:\'Space Grotesk\',sans-serif;font-weight:700;font-size:22px;margin-bottom:10px">Karo Recon</div>' + html + '</div>';
  return s;
}
async function stLinkInit(token) {
  stAuthScreen('<p>Checking your link...</p>');
  let info;
  try { info = await Api.request('POST', '/auth/token-info', { token: token }); }
  catch (e) { stAuthScreen('<h3>This link is no longer valid</h3><p>It may have been used already or it has expired. Ask your school admin to send a new one, or use "Forgot password" on the sign-in page.</p><div class="st-foot"><button type="button" class="st-b go" onclick="stCloseAuth()">Go to sign in</button></div>'); return; }
  if (info.purpose === 'email_change') {
    stAuthScreen('<h3>Confirm your new email</h3><p>' + esc(info.full_name) + ', your Karo Recon sign-in email at ' + esc(info.school_name) + ' will change to <b>' + esc(info.email) + '</b>.</p><div class="st-err" id="stAuthErr" style="display:none"></div><div class="st-foot"><button type="button" class="st-b go" id="stAuthGo">Confirm</button></div>');
    stEl('stAuthGo').onclick = async function () {
      try { await Api.request('POST', '/auth/complete', { token: token }); stAuthScreen('<h3>Email changed</h3><p>Sign in with <b>' + esc(info.email) + '</b> from now on. Your password is the same.</p><div class="st-foot"><button type="button" class="st-b go" onclick="stCloseAuth()">Go to sign in</button></div>'); }
      catch (e) { const er = stEl('stAuthErr'); er.textContent = e.message; er.style.display = 'block'; }
    };
    return;
  }
  const welcome = info.purpose === 'invite';
  const s = stAuthScreen('<h3>' + (welcome ? 'Welcome, ' + esc(info.full_name) : 'Choose a new password') + '</h3><p>' + (welcome ? 'You were added to <b>' + esc(info.school_name) + '</b>. ' : 'For ' + esc(info.email) + ' at ' + esc(info.school_name) + '. ') + 'Choose a password you will remember (at least 8 characters).</p>' +
    '<label for="stNp">Password</label><input class="st-in" id="stNp" type="password" autocomplete="new-password">' +
    '<label for="stNp2">Password again</label><input class="st-in" id="stNp2" type="password" autocomplete="new-password">' +
    '<div class="st-err" id="stAuthErr" style="display:none"></div><div class="st-foot"><button type="button" class="st-b go" id="stAuthGo">' + (welcome ? 'Save and sign in' : 'Change password and sign in') + '</button></div>');
  const go = async function () {
    const er = stEl('stAuthErr'); er.style.display = 'none';
    const p1 = stEl('stNp').value, p2 = stEl('stNp2').value;
    if (p1 !== p2) { er.textContent = 'The two passwords are not the same.'; er.style.display = 'block'; return; }
    stEl('stAuthGo').disabled = true;
    try {
      Api.clear();                                                      // never mix with another person's old session
      const r = await Api.request('POST', '/auth/complete', { token: token, password: p1 });
      Api.save(r.token, r.staff); live.staff = r.staff;
      await loadLiveData(); s.remove(); enterApp();
    } catch (e) { er.textContent = e.message; er.style.display = 'block'; stEl('stAuthGo').disabled = false; }
  };
  stEl('stAuthGo').onclick = go;
  s.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
  stEl('stNp').focus();
}
function stCloseAuth() { const s = stEl('stAuth'); if (s) s.remove(); if (typeof goToLogin === 'function') goToLogin(); }

/* ---------- "Forgot password" on the sign-in page ---------- */
async function stForgot(e) {
  if (e) e.preventDefault();
  const typed = stEl('loginEmail') ? stEl('loginEmail').value.trim() : '';
  const r = await stDialog({ title: 'Forgot your password?', intro: 'Type your email. If it belongs to an account, we send a link to choose a new password.',
    fields: [{ id: 'email', label: 'Email address', type: 'email', value: typed, autocomplete: 'username' }], okText: 'Send me a link',
    run: function (v) { return Api.request('POST', '/auth/forgot', { email: v.email }); } });
  if (!r) return;
  if (r.mail && r.mail.dev) await stMailResult(r.mail, 'you');
  else await stDialog({ title: 'Check your email', intro: 'If that address has an account, a link is on its way. It works once and lasts 1 hour. Look in spam too.', okText: 'OK', noCancel: true });
}
(function addForgotLink() {
  const pw = document.getElementById('loginPassword');
  if (!pw || document.getElementById('stForgotLink')) return;
  const d = document.createElement('div'); d.style.cssText = 'text-align:right;margin-top:8px;font-size:12.5px';
  d.innerHTML = '<a href="#" id="stForgotLink" style="color:var(--matched)">Forgot password?</a>';
  (pw.closest('.pw-wrap') || pw).after(d);
  document.getElementById('stForgotLink').addEventListener('click', stForgot);
})();

// opened from an email link?  /?token=...
(function readLink() {
  let t = null;
  try { t = new URLSearchParams(location.search).get('token'); } catch (e) { /* old browser */ }
  if (!t) return;
  try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignore */ }   // the link is not left in the address bar or history
  stLinkInit(t);
})();