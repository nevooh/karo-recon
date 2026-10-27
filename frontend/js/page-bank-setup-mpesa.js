/* page-bank-setup-mpesa.js - the M-PESA setup CHECKLIST (plugs into page-bank-setup.js).
   Loaded AFTER page-bank-setup.js. It uses that file's popup (setupOpenShell, setupBody, setupError, ERR_STYLE).

   M-Pesa is different from the other banks: WE call Safaricom to register two addresses that
   carry a secret code (made and stored by the server). So this popup is a 5-step CHECKLIST:
     1. Paybill number and Daraja keys saved        (Save keys / Replace keys)
     2. Keys checked with Safaricom                 (Check keys: registers nothing)
     3. Our server's public address is ready        (a server setting; shown so the team can see it)
     4. Addresses registered with Safaricom         (Register: typed Paybill + your password; one time in LIVE)
     5. First payment arrived                       (turns green by itself)
   The full addresses are NEVER shown: only a masked preview with the secret code hidden.
   The secret and the keys are never shown again after saving.
   Endpoints: PUT  /schools/:id/mpesa/keys       { paybill, consumer_key, consumer_secret [, confirm_text, password] }
              POST /schools/:id/mpesa/check-keys
              POST /schools/:id/mpesa/register   { dry:true }  or  { confirm_paybill, password }
              PUT  /schools/:id/mpesa/passkey    { passkey [, confirm_text, password] }   OPTIONAL: only for "Send request to my phone"
              GET  /schools/:id/channels         (the card data: c.mpesa has the stage, address state, blockers, masked preview) */

const mpesaUi = {
  view: 'list',      // 'list' | 'keys' | 'register'
  checked: null,     // result of "Check keys" in this session: { ok, message }
  notice: '',        // a short green message after something succeeded
  busy: false,
  preview: null,     // masked preview shown in the register view
};

function mpesaRowData() {
  return (typeof bankPage !== 'undefined' && bankPage.list && bankPage.list.find(function (c) { return c.channel === 'mpesa'; })) || {};
}
function mpesaWhen(v) { return esc(String(v || '').slice(0, 10)); }

/* ---------------- the card (page-banks.js asks for this line) ---------------- */
window.mpesaStageLine = function (c) {
  if (!c || c.channel !== 'mpesa' || !c.mpesa) return '';
  const m = c.mpesa;
  const line = function (colour, text) { return '<div class="fields" style="color:var(--' + colour + ');">' + text + '</div>'; };
  if (m.stage === 'no_keys') return line('muted', 'Paybill and keys not saved yet');
  if (m.stage === 'keys_saved') return line('cash', 'Keys saved &middot; addresses not registered yet');
  return line('matched', 'Addresses registered' + (m.token_kind === 'legacy' ? ' (the older way)' : ''));
};

/* ---------------- one checklist row ---------------- */
// state: done | todo | wait | fail
function mpesaStep(state, title, detail, actionHtml) {
  const icon = { done: ['\u2713', 'matched'], fail: ['\u2715', 'alert'], todo: ['\u25CB', 'cash'], wait: ['\u00B7', 'muted'] }[state];
  return '<div style="display:flex;gap:12px;padding:12px 0;border-top:1px solid var(--border,#2a2a2a);">' +
    '<div style="width:24px;height:24px;border-radius:50%;border:1px solid var(--' + icon[1] + ');color:var(--' + icon[1] + ');display:flex;align-items:center;justify-content:center;font-size:13px;flex:none;">' + icon[0] + '</div>' +
    '<div style="flex:1;min-width:0;"><div style="font-size:13px;font-weight:600;' + (state === 'wait' ? 'color:var(--muted);' : '') + '">' + esc(title) + '</div>' +
    '<div style="font-size:12px;line-height:1.5;color:var(--muted);margin-top:2px;">' + detail + '</div>' +
    (actionHtml ? '<div style="margin-top:8px;">' + actionHtml + '</div>' : '') + '</div></div>';
}

/* ---------------- view 1: the checklist ---------------- */
function mpesaListHtml() {
  const c = mpesaRowData(), m = c.mpesa || {};
  const admin = banksIsAdmin();
  const registered = m.stage === 'registered';
  const keysSaved = Boolean(m.keys_saved);
  const btn = function (label, fn, cls) { return '<button class="btn ' + (cls || 'small') + '" ' + (mpesaUi.busy ? 'disabled ' : '') + 'onclick="' + fn + '">' + label + '</button>'; };

  // 1. keys
  const s1 = mpesaStep(keysSaved ? 'done' : 'todo', 'Paybill number and Daraja keys saved',
    keysSaved ? 'Paybill <b>' + esc(c.identifier || '') + '</b>. The keys are saved (encrypted) and are never shown again.' : 'Not saved yet. You need the school\u2019s Paybill number and its PRODUCTION Consumer Key and Secret from the Daraja portal (Go Live).',
    admin ? btn(keysSaved ? 'Replace keys' : 'Save keys', 'mpesaKeysOpen()', keysSaved ? 'small' : 'primary small') : '');

  // 2. check keys
  const ck = mpesaUi.checked;
  let s2state, s2text;
  if (ck && ck.ok) { s2state = 'done'; s2text = esc(ck.message); }
  else if (ck && !ck.ok) { s2state = 'fail'; s2text = esc(ck.message); }
  else if (registered) { s2state = 'done'; s2text = 'Not re-checked in this session (the keys worked when the addresses were registered). You can check again.'; }
  else if (keysSaved) { s2state = 'todo'; s2text = 'Not checked yet. Recommended before registering. This registers nothing.'; }
  else { s2state = 'wait'; s2text = 'Save the keys first.'; }
  const s2 = mpesaStep(s2state, 'Keys checked with Safaricom', s2text,
    admin && keysSaved ? btn(mpesaUi.busy ? 'Checking\u2026' : 'Check keys', 'mpesaCheck()') : '');

  // 3. public address
  const s3 = mpesaStep(m.public_address_ok ? 'done' : 'fail', 'Our server\u2019s public address is ready',
    m.public_address_ok ? 'Safaricom will be given addresses on our public website address.' : esc(m.public_address_problem || 'Not ready.') + ' The team sets this on the server (PUBLIC_BASE_URL).', '');

  // 4. registered
  let s4state, s4text, s4action = '';
  if (registered) {
    s4state = 'done';
    s4text = m.registered_at
      ? 'Registered on <b>' + mpesaWhen(m.registered_at) + '</b>' + (m.registered_base ? ' at ' + esc(m.registered_base) : '') + '.'
      : 'Registered (this school was set up before we recorded dates).';
    if (m.token_kind === 'legacy') s4text += ' It uses the older shared-secret address, which keeps working. Re-registering moves it to its own code' + (m.production ? ', but in LIVE that needs the team.' : '.');
    if (admin && m.token_kind === 'legacy' && !m.production) s4action = btn('Re-register (moves to the new code)', 'mpesaRegisterOpen()');
  } else if (m.can_register) {
    s4state = 'todo'; s4text = 'Ready. This is the one step that tells Safaricom where to send payments' + (m.production ? ' and in LIVE it can only be done <b>once</b>.' : '.');
    if (admin) s4action = btn('Register with Safaricom', 'mpesaRegisterOpen()', 'primary small');
  } else {
    s4state = 'wait'; s4text = (m.blockers && m.blockers.length ? m.blockers.map(esc).join(' ') : 'Finish the steps above first.');
  }
  const s4 = mpesaStep(s4state, 'Addresses registered with Safaricom', s4text, s4action);

  // 5. first payment
  let s5state, s5text;
  if (c.status === 'connected') { s5state = 'done'; s5text = (c.payments || 0) + ' payment' + (c.payments === 1 ? '' : 's') + ' received &middot; last ' + esc(String(c.last_payment_at || '').slice(0, 16).replace('T', ' ')) + '.'; }
  else if (registered) { s5state = 'todo'; s5text = 'Pay KES 50 to the school\u2019s Paybill, with a test student\u2019s admission number as the account. This turns green by itself when it arrives.'; }
  else { s5state = 'wait'; s5text = 'Waiting for the steps above.'; }
  const s5 = mpesaStep(s5state, 'First payment arrived', s5text, '');

  // 6. OPTIONAL: the STK passkey. Never needed for payments to arrive; it only adds "Send request to my phone" to the parent portal.
  const hasPk = Boolean(m.has_passkey);
  const s6 = mpesaStep(hasPk ? 'done' : (keysSaved ? 'todo' : 'wait'), 'Optional: parents can pay from the portal (STK push)',
    (hasPk ? 'Passkey saved (encrypted, never shown again). ' + (m.stk_ready ? 'Parents now see \u201cSend request to my phone\u201d in the portal.' : 'It switches on once the server\u2019s public address is ready (step 3).')
           : 'Not set. <b>You can skip this.</b> Payments still arrive as normal, and parents pay from the M-Pesa menu using the Paybill and the admission number. Add the passkey only if you want parents to tap \u201cSend request to my phone\u201d.' + (keysSaved ? '' : ' (Save the keys first.)')),
    admin && keysSaved ? btn(hasPk ? 'Replace passkey' : 'Add passkey', 'mpesaPasskeyOpen()', hasPk ? 'small' : 'small') : '');

  const env = m.production
    ? '<div style="font-size:12px;color:var(--alert);margin-bottom:8px;"><b>Safaricom environment: LIVE</b> (real money)</div>'
    : '<div style="font-size:12px;color:var(--cash);margin-bottom:8px;"><b>Safaricom environment: TEST</b> (sandbox, no real money)</div>';
  return (mpesaUi.notice ? '<div style="border:1px solid var(--matched);color:var(--matched);border-radius:6px;padding:8px 12px;font-size:12.5px;margin-bottom:10px;">' + mpesaUi.notice + '</div>' : '') +
    env + (admin ? '' : '<div style="font-size:12px;color:var(--cash);margin-bottom:6px;">Only an Admin can change these steps. Ask an Admin of this school.</div>') +
    '<div style="margin-top:4px;">' + s1 + s2 + s3 + s4 + s5 + s6 + '</div>' +
    '<div class="actions" style="margin-top:14px;"><button class="btn primary" onclick="mpesaDone()">Close</button></div>';
}

function mpesaShow() {
  mpesaUi.view = 'list';
  setupOpenShell('M-Pesa setup', 'Where this school is, step by step.');
  setupBody(mpesaListHtml());
}

/* ---------------- opening, refreshing, closing ---------------- */
function mpesaOpen() {
  bankSetup.channel = 'mpesa'; bankSetup.busy = false; bankSetup.locked = false;
  mpesaUi.checked = null; mpesaUi.notice = ''; mpesaUi.busy = false; mpesaUi.preview = null;
  mpesaShow();
}
window.mpesaOpen = mpesaOpen;

// Fetch fresh card data, update the page behind the popup, and come back to the checklist.
async function mpesaRefresh(notice) {
  try {
    bankPage.list = await Api.get('/schools/' + live.staff.school_id + '/channels');
    banksRender();
  } catch (e) { /* the old data stays on screen */ }
  mpesaUi.notice = notice || '';
  mpesaShow();
}

window.mpesaDone = function () {
  bankSetupClose();
  if (typeof banksLoad === 'function') banksLoad();
};
window.mpesaBack = function () { mpesaUi.notice = ''; mpesaShow(); };

/* ---------------- view 2: save / replace the Paybill and keys ---------------- */
window.mpesaKeysOpen = function () {
  const c = mpesaRowData(), m = c.mpesa || {};
  const replacing = Boolean(m.keys_saved);
  const locked = replacing && m.stage === 'registered';          // the Paybill number cannot change once registered
  mpesaUi.view = 'keys';
  setupOpenShell(replacing ? 'Replace the M-Pesa keys' : 'Save the Paybill and keys', 'From the school\u2019s Daraja portal (Go Live). The secret is saved encrypted and never shown again.');
  setupBody(
    (replacing ? '<div style="border:1px solid var(--alert);border-radius:6px;padding:10px 12px;font-size:12.5px;line-height:1.6;margin-bottom:12px;">You are replacing keys that are already saved. If the new ones are wrong, registering with Safaricom will fail until they are fixed.</div>' : '') +
    '<label class="field">Paybill number</label>' +
    '<input type="text" id="mkPaybill" autocomplete="off" placeholder="e.g. 174379" value="' + esc(replacing ? (c.identifier || '') : '') + '"' + (locked ? ' readonly' : '') + '>' +
    (locked ? '<div style="font-size:11.5px;color:var(--muted);margin-top:4px;">The Paybill number cannot be changed after the school is registered.</div>' : '<div style="font-size:11.5px;color:var(--muted);margin-top:4px;">Digits only, 5 to 7 digits. It must be a Paybill (not a Till).</div>') +
    '<label class="field" style="margin-top:10px;">Consumer Key</label><input type="text" id="mkKey" autocomplete="off" placeholder="From the Daraja app">' +
    '<label class="field" style="margin-top:10px;">Consumer Secret</label><input type="password" id="mkSecret" autocomplete="new-password" placeholder="From the Daraja app">' +
    (replacing
      ? '<label class="field" style="margin-top:14px;">Type RESET to confirm</label><input type="text" id="mkConfirm" autocomplete="off" placeholder="RESET">' +
        '<label class="field" style="margin-top:10px;">Your own password</label><input type="password" id="mkPassword" autocomplete="current-password" placeholder="The password you log in with">'
      : '') +
    '<div id="setupErr" style="' + ERR_STYLE + '"></div>' +
    '<div class="actions" style="margin-top:16px;"><button class="btn" id="setupCancel" onclick="mpesaBack()">Back</button>' +
    '<button class="btn primary" id="setupGo" onclick="mpesaKeysSave()">' + (replacing ? 'Replace keys' : 'Save keys') + '</button></div>');
};

window.mpesaKeysSave = async function () {
  if (mpesaUi.busy) return;
  const replacing = Boolean(document.getElementById('mkConfirm'));
  const paybill = document.getElementById('mkPaybill').value.replace(/\s+/g, '');
  const key = document.getElementById('mkKey').value.trim(), secret = document.getElementById('mkSecret').value.trim();
  if (!/^\d{5,7}$/.test(paybill)) return setupError('Enter the Paybill number using digits only (5 to 7 digits).');
  if (!/^\S{8,200}$/.test(key)) return setupError('Enter the Daraja Consumer Key (no spaces).');
  if (!/^\S{8,200}$/.test(secret)) return setupError('Enter the Daraja Consumer Secret (no spaces).');
  const body = { paybill: paybill, consumer_key: key, consumer_secret: secret };
  if (replacing) {
    const confirmText = document.getElementById('mkConfirm').value.trim(), password = document.getElementById('mkPassword').value;
    if (!confirmText) return setupError('Type RESET to confirm.');
    if (!password) return setupError('Enter your own password.');
    body.confirm_text = confirmText; body.password = password;
  }
  mpesaUi.busy = true; setupError('');
  const go = document.getElementById('setupGo'), back = document.getElementById('setupCancel');
  const goText = go.textContent; go.disabled = true; back.disabled = true; go.textContent = 'Please wait\u2026';
  try {
    await Api.put('/schools/' + live.staff.school_id + '/mpesa/keys', body);
    document.getElementById('mkSecret').value = '';          // the secret does not stay on the page
    mpesaUi.busy = false; mpesaUi.checked = null;
    await mpesaRefresh(replacing ? 'Keys replaced. Press \u201cCheck keys\u201d to confirm they work.' : 'Paybill and keys saved. Next: check the keys.');
  } catch (e) {
    setupError(e.message);                                    // the server's own words (wrong password, Paybill taken, ...)
    const pw = document.getElementById('mkPassword'); if (pw) pw.value = '';
    go.disabled = false; back.disabled = false; go.textContent = goText;
    mpesaUi.busy = false;
  }
};

/* ---------------- optional: the STK passkey ---------------- */
window.mpesaPasskeyOpen = function () {
  const replacing = Boolean((mpesaRowData().mpesa || {}).has_passkey);
  mpesaUi.view = 'passkey';
  setupOpenShell(replacing ? 'Replace the STK passkey' : 'Add the STK passkey', 'Optional. Only needed for \u201cSend request to my phone\u201d in the parent portal.');
  setupBody(
    '<div style="font-size:12.5px;line-height:1.6;color:var(--muted);margin-bottom:12px;">Safaricom calls it the <b>Lipa Na M-Pesa Online Passkey</b>. In the Daraja portal it is under the app\u2019s M-Pesa Express (STK Push) details; for a live Paybill Safaricom gives it when the school goes live. It is one long line of letters and numbers (about 64 characters), with no spaces. Copy and paste it exactly.</div>' +
    (replacing ? '<div style="border:1px solid var(--alert);border-radius:6px;padding:10px 12px;font-size:12.5px;line-height:1.6;margin-bottom:12px;">A passkey is already saved. If the new one is wrong, \u201cSend request to my phone\u201d will fail until it is fixed.</div>' : '') +
    '<label class="field">Passkey</label><input type="password" id="mpKey" autocomplete="new-password" placeholder="Paste the passkey">' +
    (replacing
      ? '<label class="field" style="margin-top:14px;">Type RESET to confirm</label><input type="text" id="mpConfirm" autocomplete="off" placeholder="RESET">' +
        '<label class="field" style="margin-top:10px;">Your own password</label><input type="password" id="mpPassword" autocomplete="current-password" placeholder="The password you log in with">'
      : '') +
    '<div id="setupErr" style="' + ERR_STYLE + '"></div>' +
    '<div class="actions" style="margin-top:16px;"><button class="btn" id="setupCancel" onclick="mpesaBack()">Back</button>' +
    '<button class="btn primary" id="setupGo" onclick="mpesaPasskeySave()">' + (replacing ? 'Replace passkey' : 'Save passkey') + '</button></div>');
};

window.mpesaPasskeySave = async function () {
  if (mpesaUi.busy) return;
  const replacing = Boolean(document.getElementById('mpConfirm'));
  const passkey = document.getElementById('mpKey').value.trim();
  if (!passkey) return setupError('Paste the passkey.');
  if (/\s/.test(passkey)) return setupError('A passkey has no spaces. Copy it again, exactly.');
  const body = { passkey: passkey };
  if (replacing) {
    const confirmText = document.getElementById('mpConfirm').value.trim(), password = document.getElementById('mpPassword').value;
    if (!confirmText) return setupError('Type RESET to confirm.');
    if (!password) return setupError('Enter your own password.');
    body.confirm_text = confirmText; body.password = password;
  }
  mpesaUi.busy = true; setupError('');
  const go = document.getElementById('setupGo'), back = document.getElementById('setupCancel');
  const goText = go.textContent; go.disabled = true; back.disabled = true; go.textContent = 'Please wait\u2026';
  try {
    await Api.put('/schools/' + live.staff.school_id + '/mpesa/passkey', body);
    document.getElementById('mpKey').value = '';            // the passkey does not stay on the page
    mpesaUi.busy = false;
    await mpesaRefresh(replacing ? 'Passkey replaced.' : 'Passkey saved. Parents can now use \u201cSend request to my phone\u201d once the server\u2019s public address is ready.');
  } catch (e) {
    setupError(e.message);
    const pw = document.getElementById('mpPassword'); if (pw) pw.value = '';
    go.disabled = false; back.disabled = false; go.textContent = goText;
    mpesaUi.busy = false;
  }
};

/* ---------------- check keys (no view: the answer shows in the checklist row) ---------------- */
window.mpesaCheck = async function () {
  if (mpesaUi.busy) return;
  mpesaUi.busy = true; mpesaUi.notice = ''; setupBody(mpesaListHtml());
  try {
    const r = await Api.post('/schools/' + live.staff.school_id + '/mpesa/check-keys', {});
    mpesaUi.checked = { ok: Boolean(r.ok), message: r.message || (r.ok ? 'Safaricom accepted these keys.' : 'The check did not pass.') };
  } catch (e) {
    mpesaUi.checked = { ok: false, message: e.message };
  }
  mpesaUi.busy = false; setupBody(mpesaListHtml());
};

/* ---------------- view 3: register with Safaricom ---------------- */
window.mpesaRegisterOpen = async function () {
  const m = mpesaRowData().mpesa || {};
  mpesaUi.view = 'register'; mpesaUi.preview = null;
  setupOpenShell('Register with Safaricom', 'We tell Safaricom where to send this school\u2019s payments.');
  setupBody('<p style="font-size:12.5px;color:var(--muted);">Preparing the preview\u2026</p>');
  try {
    // A rehearsal first: nothing is sent, nothing is saved. It also shows any reason we cannot register.
    const r = await Api.post('/schools/' + live.staff.school_id + '/mpesa/register', { dry: true });
    mpesaUi.preview = r.preview;
  } catch (e) {
    setupBody('<div style="color:var(--alert);font-size:12.5px;line-height:1.6;">' + esc(e.message) + '</div>' +
      '<div class="actions" style="margin-top:16px;"><button class="btn primary" onclick="mpesaBack()">Back to the checklist</button></div>');
    return;
  }
  const p = mpesaUi.preview;
  setupBody(
    (m.production
      ? '<div style="border:1px solid var(--alert);color:var(--alert);border-radius:6px;padding:10px 12px;font-size:12.5px;line-height:1.6;margin-bottom:12px;"><b>LIVE: one time only.</b> If these addresses turn out wrong, fixing it needs Safaricom to delete the old ones first (two people from the school\u2019s M-Pesa account). Check the preview, and press \u201cCheck keys\u201d first.</div>'
      : '<div style="border:1px solid var(--cash);color:var(--cash);border-radius:6px;padding:9px 12px;font-size:12.5px;line-height:1.5;margin-bottom:12px;">TEST environment: you can register again here while testing.</div>') +
    '<div style="font-size:12.5px;margin-bottom:6px;"><b>The two addresses we will give Safaricom</b> (the secret code is made when you register, and stays hidden):</div>' +
    '<div style="font-family:\'IBM Plex Mono\',monospace;font-size:11.5px;line-height:1.7;word-break:break-all;background:var(--surface,#161616);border-radius:6px;padding:8px 10px;margin-bottom:6px;">Confirmation: ' + esc(p.confirmation) + '<br>Validation: ' + esc(p.validation) + '</div>' +
    '<div style="font-size:11.5px;color:var(--muted);margin-bottom:14px;">Both addresses carry the same secret code. Safaricom stores them and calls them when money arrives.</div>' +
    '<label class="field">Type the school\u2019s Paybill number to confirm</label><input type="text" id="mrPaybill" autocomplete="off" placeholder="' + esc(mpesaRowData().identifier || '') + '">' +
    '<label class="field" style="margin-top:10px;">Your own password</label><input type="password" id="mrPassword" autocomplete="current-password" placeholder="The password you log in with">' +
    '<div id="setupErr" style="' + ERR_STYLE + '"></div>' +
    '<div class="actions" style="margin-top:16px;"><button class="btn" id="setupCancel" onclick="mpesaBack()">Back</button>' +
    '<button class="btn ' + (m.production ? 'danger' : 'primary') + '" id="setupGo" onclick="mpesaRegisterGo()">Register with Safaricom</button></div>');
};

window.mpesaRegisterGo = async function () {
  if (mpesaUi.busy) return;
  const typed = document.getElementById('mrPaybill').value.replace(/\s+/g, ''), password = document.getElementById('mrPassword').value;
  if (!typed) return setupError('Type the school\u2019s Paybill number to confirm.');
  if (!password) return setupError('Enter your own password.');
  mpesaUi.busy = true; setupError('');
  const go = document.getElementById('setupGo'), back = document.getElementById('setupCancel');
  const goText = go.textContent; go.disabled = true; back.disabled = true; go.textContent = 'Registering\u2026';
  try {
    const r = await Api.post('/schools/' + live.staff.school_id + '/mpesa/register', { confirm_paybill: typed, password: password });
    mpesaUi.busy = false;
    await mpesaRefresh('Registered with Safaricom. We gave them ' + esc((r.preview || {}).confirmation || 'the two addresses') + ' (and the matching validation address).');
  } catch (e) {
    setupError(e.message);                                    // wrong Paybill/password, Safaricom's own reason, "one time only", ...
    document.getElementById('mrPassword').value = '';
    go.disabled = false; back.disabled = false; go.textContent = goText;
    mpesaUi.busy = false;
  }
};

/* ---------------- plug into page-bank-setup.js ---------------- */
BANK_SETUP_OWN.mpesa = {
  open: mpesaOpen,
  change: mpesaOpen,
  // Button on a card that is already set up. Everyone can look at the checklist.
  buttons: function () { return '<button class="btn small" style="margin-top:12px;" onclick="mpesaOpen()">Show checklist</button>'; },
};