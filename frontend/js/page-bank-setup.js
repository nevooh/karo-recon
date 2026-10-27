/* page-bank-setup.js - guided setup for banks where WE generate the login (Equity and Co-op).
   Loaded after page-banks.js. It adds buttons to the cards on the Bank connections page and shows
   its own popup (separate from the shared one, so nothing here can be closed by accident).

   Three views in the popup:
   1. INTRO   (card says "Not set up yet")  what the school needs (+ any field the bank needs,
              like Co-op's account number) -> "Generate login"
   2. RESET   (card is already set up)      danger form: type RESET + your own password
   3. LOGIN   shown after either one: callback URL, username, password (and the account number
              for Co-op) with Copy buttons, the steps to follow, and how to test.
              The password is shown ONCE. This popup cannot be closed until the person
              ticks "I have saved the password".
   Endpoints: POST /schools/:id/bank-connections/<bank>/credentials
              (first time: nothing needed, except Co-op's account_number.
               Reset: { confirm_text, password } - the server enforces the rules) */

const bankSetup = {
  channel: null,
  busy: false,
  locked: false,   // true while a show-once password is on screen
};

// One entry per bank where we generate the login. A new bank of this kind = a new entry here.
//   introSub / give / afterReset : the bank's own wording
//   field : an extra thing the bank needs the FIRST time (Co-op: the school's account number)
const BANK_SETUP = {
  equity: {
    name: 'Equity',
    path: '/bank-connections/equity/credentials',
    needs: [
      'The school\u2019s own JengaHQ login (the person who manages the school\u2019s Equity account).',
      'A Jenga production account with KYC done. (Equity does this with the school.)',
    ],
    happens: 'We make a username and a password for Equity to use when it sends us payment alerts. You paste them into JengaHQ once.',
    introSub: 'We generate the login. Nothing is sent to Equity until you paste it into JengaHQ.',
    give: 'Copy these into JengaHQ now.',
    afterReset: 'paste the new password into JengaHQ',
    test: 'Test it: pay KES 50 to the school\u2019s Equity account using a test student\u2019s admission number. This card turns \u201cConnected\u201d when the alert arrives.',
  },
  coop: {
    name: 'Co-op Bank',
    path: '/bank-connections/coop/credentials',
    needs: [
      'The school\u2019s Co-op account number (the account that receives the fees).',
      'The school (the account holder) must ask Co-op to switch on Instant Notifications (INS) for credit events on that account.',
    ],
    happens: 'We make a username and a password for Co-op to use when it sends us payment notifications. The school gives them to Co-op together with the account number.',
    introSub: 'We generate the login. Nothing is sent to Co-op until the school gives it to them.',
    give: 'Copy these and give them to Co-op now.',
    afterReset: 'give Co-op the new password',
    test: 'Test it: pay KES 50 into the school\u2019s Co-op account using a test student\u2019s admission number. This card turns \u201cConnected\u201d when the notification arrives.',
    note: 'Co-op\u2019s exact subscription steps are still being confirmed with the first real school. If Co-op asks for something different, tell us.',
    field: {
      key: 'account_number',
      label: 'School\u2019s Co-op account number',
      placeholder: 'e.g. 36001873000',
      help: 'Letters and numbers only, 8 to 20 characters. Spaces are ignored.',
      pattern: /^[A-Za-z0-9]{8,20}$/,
      error: 'Enter the account number with letters and numbers only, 8 to 20 characters.',
    },
  },
};

// Banks with their OWN flow (no generated login) register here. KCB does, in page-bank-setup-kcb.js:
//   BANK_SETUP_OWN.kcb = { open(), change(), buttons(card, isAdmin) }
const BANK_SETUP_OWN = {};

window.bankSetupAvailable = function (channel) { return Boolean(BANK_SETUP[channel] || BANK_SETUP_OWN[channel]); };

// The buttons shown on a card that is ALREADY set up (page-banks.js calls this).
window.bankSetupButtons = function (c, isAdmin) {
  if (BANK_SETUP_OWN[c.channel]) return BANK_SETUP_OWN[c.channel].buttons(c, isAdmin);
  if (!isAdmin) return '';
  return '<button class="btn danger small" style="margin-top:12px;" onclick="bankResetOpen(\'' + c.channel + '\')">Reset login</button>';
};

/* ---------------- the popup shell (created once) ---------------- */
function setupShell() {
  let el = document.getElementById('setupBackdrop');
  if (el) return el;
  el = document.createElement('div');
  el.className = 'modal-backdrop';
  el.id = 'setupBackdrop';
  el.innerHTML = '<div class="modal">' +
    '<span class="modal-close" id="setupX" onclick="bankSetupClose()">&#10005;</span>' +
    '<h3 id="setupTitle"></h3><p class="msub" id="setupSub"></p><div id="setupBody"></div></div>';
  document.body.appendChild(el);
  return el;
}
function setupOpenShell(title, sub) {
  setupShell().classList.add('show');
  document.getElementById('setupTitle').textContent = title;
  document.getElementById('setupSub').textContent = sub || '';
  document.getElementById('setupX').style.display = bankSetup.locked ? 'none' : '';
}
function setupBody(html) { document.getElementById('setupBody').innerHTML = html; }
function setupError(msg) {
  const e = document.getElementById('setupErr');
  if (e) { e.textContent = msg || ''; e.style.display = msg ? 'block' : 'none'; }
}
const ERR_STYLE = 'display:none;color:var(--alert);font-size:12.5px;margin:10px 0 0;';

window.bankSetupClose = function () {
  if (bankSetup.locked) return;           // a show-once password is on screen: use "Done"
  const el = document.getElementById('setupBackdrop');
  if (el) el.classList.remove('show');
  setupBody('');
  bankSetup.channel = null; bankSetup.busy = false;
};

/* ---------------- 1. intro (first time) ---------------- */
window.bankSetupOpen = function (channel) {
  if (BANK_SETUP_OWN[channel]) return BANK_SETUP_OWN[channel].open();
  const cfg = BANK_SETUP[channel]; if (!cfg) return;
  bankSetup.channel = channel; bankSetup.busy = false; bankSetup.locked = false;
  setupOpenShell('Set up ' + cfg.name, cfg.introSub);
  const field = cfg.field
    ? '<label class="field" style="margin-top:14px;">' + esc(cfg.field.label) + '</label>' +
      '<input type="text" id="setupField" autocomplete="off" placeholder="' + esc(cfg.field.placeholder) + '">' +
      '<div style="font-size:11.5px;color:var(--muted);margin-top:4px;">' + esc(cfg.field.help) + '</div>'
    : '';
  setupBody(
    '<div style="font-size:12.5px;margin-bottom:6px;"><b>The school needs:</b></div>' +
    '<ul style="margin:0 0 12px 18px;padding:0;font-size:12.5px;line-height:1.6;">' + cfg.needs.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul>' +
    '<p style="font-size:12.5px;line-height:1.6;margin:0 0 4px;">' + esc(cfg.happens) + '</p>' +
    '<p style="font-size:12.5px;line-height:1.6;margin:0;color:var(--cash);">The password is shown <b>once</b>. Have a safe place ready to keep it.</p>' +
    field +
    '<div id="setupErr" style="' + ERR_STYLE + '"></div>' +
    '<div class="actions" style="margin-top:16px;"><button class="btn" id="setupCancel" onclick="bankSetupClose()">Cancel</button>' +
    '<button class="btn primary" id="setupGo" onclick="bankSetupGenerate()">Generate login</button></div>');
};

window.bankSetupGenerate = function () {
  const cfg = BANK_SETUP[bankSetup.channel];
  const body = {};
  if (cfg.field) {
    const value = document.getElementById('setupField').value.replace(/\s+/g, '');   // spaces are ignored
    if (!cfg.field.pattern.test(value)) return setupError(cfg.field.error);
    body[cfg.field.key] = value;
  }
  setupRun(bankSetup.channel, body);
};

/* ---------------- 2. reset (already set up) ---------------- */
window.bankResetOpen = function (channel) {
  if (BANK_SETUP_OWN[channel]) return BANK_SETUP_OWN[channel].change();
  const cfg = BANK_SETUP[channel]; if (!cfg) return;
  bankSetup.channel = channel; bankSetup.busy = false; bankSetup.locked = false;
  setupOpenShell('Reset ' + cfg.name + ' login', 'This is a dangerous step. Read it before you continue.');
  setupBody(
    '<div style="border:1px solid var(--alert);border-radius:6px;padding:10px 12px;font-size:12.5px;line-height:1.6;margin-bottom:14px;">' +
    'This makes a <b>new</b> password. The <b>old password stops working immediately</b>, so ' + esc(cfg.name) + ' payments will <b>not arrive</b> until you ' + esc(cfg.afterReset) + '.</div>' +
    '<label class="field">Type RESET to confirm</label>' +
    '<input type="text" id="setupConfirm" autocomplete="off" placeholder="RESET">' +
    '<label class="field" style="margin-top:10px;">Your own password</label>' +
    '<input type="password" id="setupPassword" autocomplete="current-password" placeholder="The password you log in with">' +
    '<div id="setupErr" style="' + ERR_STYLE + '"></div>' +
    '<div class="actions" style="margin-top:16px;"><button class="btn" id="setupCancel" onclick="bankSetupClose()">Cancel</button>' +
    '<button class="btn danger" id="setupGo" onclick="bankResetGo()">Reset login</button></div>');
};

window.bankResetGo = function () {
  const confirmText = document.getElementById('setupConfirm').value.trim();
  const password = document.getElementById('setupPassword').value;
  if (!confirmText) return setupError('Type RESET to confirm.');
  if (!password) return setupError('Enter your own password.');
  setupRun(bankSetup.channel, { confirm_text: confirmText, password: password });
};

/* ---------------- talking to the server ---------------- */
async function setupRun(channel, body) {
  if (bankSetup.busy) return;
  const cfg = BANK_SETUP[channel];
  bankSetup.busy = true; setupError('');
  const go = document.getElementById('setupGo'), cancel = document.getElementById('setupCancel');
  const goText = go.textContent; go.disabled = true; cancel.disabled = true; go.textContent = 'Please wait\u2026';
  try {
    const r = await Api.post('/schools/' + live.staff.school_id + cfg.path, body);
    bankSetup.locked = true;                 // from here the person must press Done
    showLogin(channel, r);
  } catch (e) {
    setupError(e.message);                   // the server's own words, e.g. "Wrong password"
    const pw = document.getElementById('setupPassword'); if (pw) pw.value = '';
    go.disabled = false; cancel.disabled = false; go.textContent = goText;
  }
  bankSetup.busy = false;
}

/* ---------------- 3. the login, shown once ---------------- */
function copyRow(label, value, id) {
  return '<div style="margin-bottom:10px;"><label class="field">' + esc(label) + '</label>' +
    '<div style="display:flex;gap:6px;"><input type="text" readonly id="' + id + '" value="' + esc(value) + '" style="flex:1;font-family:\'IBM Plex Mono\',monospace;font-size:12px;" onfocus="this.select()">' +
    '<button class="btn small" onclick="bankSetupCopy(\'' + id + '\', this)">Copy</button></div></div>';
}

function showLogin(channel, r) {
  const cfg = BANK_SETUP[channel];
  setupOpenShell(r.rotated ? 'New ' + cfg.name + ' login' : cfg.name + ' login ready', cfg.give);
  const steps = (r.steps || []).map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
  setupBody(
    '<div style="border:1px solid var(--cash);border-radius:6px;padding:9px 12px;font-size:12.5px;line-height:1.5;margin-bottom:14px;color:var(--cash);">' +
    '<b>Copy the password now.</b> It cannot be shown again. If it is lost you must reset it and update ' + esc(cfg.name) + ' again.</div>' +
    (r.account_number ? copyRow('Account number', r.account_number, 'cpAcct') : '') +
    copyRow('Callback URL', r.callback_url, 'cpUrl') +
    (r.callback_url_is_placeholder ? '<p style="font-size:12px;color:var(--cash);margin:-4px 0 10px;">Our public address is not set on the server yet, so this URL contains YOUR-DOMAIN. Replace it with the real address before pasting.</p>' : '') +
    copyRow('Username', r.username, 'cpUser') +
    copyRow('Password', r.password, 'cpPass') +
    '<div style="font-size:12.5px;margin:14px 0 6px;"><b>What to do next</b></div>' +
    '<ol style="margin:0 0 12px 18px;padding:0;font-size:12.5px;line-height:1.6;">' + steps + '</ol>' +
    '<p style="font-size:12.5px;line-height:1.6;margin:0 0 ' + (cfg.note ? '8' : '14') + 'px;">' + esc(cfg.test) + '</p>' +
    (cfg.note ? '<p style="font-size:12px;line-height:1.5;margin:0 0 14px;color:var(--muted);">' + esc(cfg.note) + '</p>' : '') +
    '<label style="display:flex;gap:8px;align-items:center;font-size:12.5px;cursor:pointer;"><input type="checkbox" id="setupSaved" onchange="document.getElementById(\'setupDone\').disabled = !this.checked"> I have saved the password</label>' +
    '<div class="actions" style="margin-top:14px;"><button class="btn primary" id="setupDone" disabled onclick="bankSetupDone()">Done</button></div>');
}

window.bankSetupCopy = function (id, btn) {
  const el = document.getElementById(id); if (!el) return;
  el.select();
  const ok = function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy'; }, 1500); };
  const fallback = function () { try { document.execCommand('copy'); } catch (e) { /* the text is selected: the person can copy by hand */ } ok(); };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(el.value).then(ok, fallback);
  else fallback();
};

window.bankSetupDone = function () {
  if (!document.getElementById('setupSaved') || !document.getElementById('setupSaved').checked) return;
  bankSetup.locked = false;
  bankSetupClose();                          // also wipes the popup, so the password is gone from the page
  if (typeof bankPage !== 'undefined') { bankPage.editing = false; }
  if (typeof banksLoad === 'function') banksLoad();
};