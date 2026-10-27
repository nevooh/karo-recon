/* page-bank-setup-kcb.js - the KCB setup flow (plugs into page-bank-setup.js).
   Loaded AFTER page-bank-setup.js. It uses that file's popup and copy buttons.

   KCB is different from Equity and Co-op: there is NO password to generate.
   - KCB signs every message it sends us, and we check the signature with KCB's public key.
     That key is installed ONCE on our server (for all schools), not typed by the school.
   - The only thing the school tells us is its KCB account number (or Vooma till), which is how
     we know a payment belongs to this school.
   So this flow has three views:
   1. FORM     (card says "Not set up yet")  the account number -> "Save account number"
   2. DETAILS  after saving, or any time from "Show details": the account number and our
               callback URL (to copy), the steps for the request letter, and whether OUR side is ready
   3. CHANGE   (already set up) danger form: new number + type RESET + your own password
   Nothing secret is shown anywhere here, so the popup can be closed freely.
   Endpoint: POST /schools/:id/bank-connections  { provider_code:'kcb', account_number, credentials:{} }
             (changing an existing number also sends { confirm_text, password }; the server enforces the rules) */

const KCB_NUMBER = /^[A-Za-z0-9]{4,24}$/;
const KCB_NUMBER_ERROR = 'Enter the account (or Vooma till) number using letters and numbers only, 4 to 24 characters.';
let kcbBusy = false;

function kcbRow() {
  return (typeof bankPage !== 'undefined' && bankPage.list && bankPage.list.find(function (c) { return c.channel === 'kcb'; })) || {};
}

/* ---------------- "is OUR side ready?" ---------------- */
// Short line for the card.
window.kcbKeyLine = function (c) {
  if (!c || c.channel !== 'kcb' || !c.key_status) return '';
  const line = function (colour, html) { return '<div class="fields" style="color:var(--' + colour + ');">Our KCB key: ' + html + '</div>'; };
  if (c.key_status === 'ok') return line('matched', '<b>installed</b>');
  if (c.key_status === 'invalid') return line('alert', '<b>unreadable</b> &middot; KCB payments are refused');
  return c.unsigned_allowed
    ? line('cash', '<b>not installed</b> (test mode)')
    : line('alert', '<b>NOT installed</b> &middot; KCB payments are refused');
};

// Longer box for the popup.
function kcbKeyBox(c) {
  let colour, text;
  if (c.key_status === 'ok') {
    colour = 'matched'; text = '<b>Our side is ready.</b> KCB\u2019s key is installed on our server, so we can check that messages really come from KCB.';
  } else if (c.key_status === 'invalid') {
    colour = 'alert'; text = '<b>Our side is NOT ready.</b> KCB\u2019s key is installed but cannot be read, so KCB payments are being refused. Our team must fix it.';
  } else if (c.unsigned_allowed) {
    colour = 'cash'; text = '<b>Test mode.</b> KCB\u2019s key is not installed yet, so signatures are NOT being checked. This is fine for testing only, never for real money.';
  } else {
    colour = 'alert'; text = '<b>Our side is NOT ready.</b> KCB\u2019s key is not installed on our server, so KCB payments are refused until our team installs it.';
  }
  return '<div style="border:1px solid var(--' + colour + ');color:var(--' + colour + ');border-radius:6px;padding:9px 12px;font-size:12.5px;line-height:1.5;margin-bottom:14px;">' + text + '</div>';
}

/* ---------------- 1. FORM (first time) ---------------- */
function kcbOpen() {
  const c = kcbRow();
  bankSetup.channel = 'kcb'; bankSetup.busy = false; bankSetup.locked = false; kcbBusy = false;
  setupOpenShell('Set up KCB', 'KCB signs every message it sends us. You only tell us which account to listen to.');
  setupBody(
    '<div style="font-size:12.5px;margin-bottom:6px;"><b>The school needs:</b></div>' +
    '<ul style="margin:0 0 12px 18px;padding:0;font-size:12.5px;line-height:1.6;">' +
    '<li>The school\u2019s KCB account number (or Vooma till number) that receives the fees.</li>' +
    '<li>A request letter to KCB, signed by the account signatories. The steps appear after you save.</li></ul>' +
    kcbKeyBox(c) +
    '<label class="field">KCB account (or Vooma till) number</label>' +
    '<input type="text" id="setupField" autocomplete="off" placeholder="e.g. 1234567890">' +
    '<div style="font-size:11.5px;color:var(--muted);margin-top:4px;">Letters and numbers only, 4 to 24 characters. Spaces are ignored.</div>' +
    '<div id="setupErr" style="' + ERR_STYLE + '"></div>' +
    '<div class="actions" style="margin-top:16px;"><button class="btn" id="setupCancel" onclick="bankSetupClose()">Cancel</button>' +
    '<button class="btn primary" id="setupGo" onclick="kcbSave()">Save account number</button></div>');
}

window.kcbSave = function () {
  const value = document.getElementById('setupField').value.replace(/\s+/g, '');   // spaces are ignored
  if (!KCB_NUMBER.test(value)) return setupError(KCB_NUMBER_ERROR);
  kcbSend({ provider_code: 'kcb', account_number: value, credentials: {} }, 'KCB account saved');
};

/* ---------------- 3. CHANGE (already set up) ---------------- */
function kcbChange() {
  bankSetup.channel = 'kcb'; bankSetup.busy = false; bankSetup.locked = false; kcbBusy = false;
  setupOpenShell('Change KCB account number', 'This is a dangerous step. Read it before you continue.');
  setupBody(
    '<div style="border:1px solid var(--alert);border-radius:6px;padding:10px 12px;font-size:12.5px;line-height:1.6;margin-bottom:14px;">' +
    'This changes which KCB account we listen to. Payments sent to the <b>old</b> number will <b>not be recognised</b> any more. Only do this if the school\u2019s KCB account has really changed.</div>' +
    '<label class="field">New KCB account (or Vooma till) number</label>' +
    '<input type="text" id="setupField" autocomplete="off" placeholder="e.g. 1234567890">' +
    '<label class="field" style="margin-top:10px;">Type RESET to confirm</label>' +
    '<input type="text" id="setupConfirm" autocomplete="off" placeholder="RESET">' +
    '<label class="field" style="margin-top:10px;">Your own password</label>' +
    '<input type="password" id="setupPassword" autocomplete="current-password" placeholder="The password you log in with">' +
    '<div id="setupErr" style="' + ERR_STYLE + '"></div>' +
    '<div class="actions" style="margin-top:16px;"><button class="btn" id="setupCancel" onclick="bankSetupClose()">Cancel</button>' +
    '<button class="btn danger" id="setupGo" onclick="kcbChangeGo()">Change account number</button></div>');
}

window.kcbChangeGo = function () {
  const value = document.getElementById('setupField').value.replace(/\s+/g, '');
  const confirmText = document.getElementById('setupConfirm').value.trim();
  const password = document.getElementById('setupPassword').value;
  if (!KCB_NUMBER.test(value)) return setupError(KCB_NUMBER_ERROR);
  if (!confirmText) return setupError('Type RESET to confirm.');
  if (!password) return setupError('Enter your own password.');
  kcbSend({ provider_code: 'kcb', account_number: value, credentials: {}, confirm_text: confirmText, password: password }, 'KCB account changed');
};

/* ---------------- talking to the server ---------------- */
async function kcbSend(body, doneTitle) {
  if (kcbBusy) return;
  kcbBusy = true; setupError('');
  const go = document.getElementById('setupGo'), cancel = document.getElementById('setupCancel');
  const goText = go.textContent; go.disabled = true; cancel.disabled = true; go.textContent = 'Please wait\u2026';
  try {
    await Api.post('/schools/' + live.staff.school_id + '/bank-connections', body);
    // Fetch the fresh card data (it now has the account number), update the page behind the popup, then show the details.
    bankPage.list = await Api.get('/schools/' + live.staff.school_id + '/channels');
    banksRender();
    kcbDetails(doneTitle);
  } catch (e) {
    setupError(e.message);                   // the server's own words, e.g. "already registered to another school"
    const pw = document.getElementById('setupPassword'); if (pw) pw.value = '';
    go.disabled = false; cancel.disabled = false; go.textContent = goText;
  }
  kcbBusy = false;
}

/* ---------------- 2. DETAILS ---------------- */
function kcbDetails(title) {
  const c = kcbRow();
  bankSetup.channel = 'kcb'; bankSetup.locked = false;
  setupOpenShell(title || 'KCB setup details', 'Follow these steps to finish. Nothing here is secret.');
  const steps = [
    'The school (the account holder) writes a request letter to KCB, signed by the account signatories, at buni@kcbgroup.com. It asks KCB to send instant payment notifications for the account.',
    'In the letter, give KCB the account number and the callback URL shown above.',
    'KCB sends back its public key. Give that key to the Karo Recon team. They install it once on our server, for every school.',
    'When the line at the top says \u201cOur side is ready\u201d, pay KES 50 into the account using a test student\u2019s admission number.',
  ];
  setupBody(
    kcbKeyBox(c) +
    copyRow('KCB account number', c.identifier || '', 'cpAcct') +
    copyRow('Callback URL (for the letter)', c.callback_url || '', 'cpUrl') +
    (c.callback_url_is_placeholder ? '<p style="font-size:12px;color:var(--cash);margin:-4px 0 10px;">Our public address is not set on the server yet, so this URL contains YOUR-DOMAIN. Replace it with the real address before sending the letter.</p>' : '') +
    '<div style="font-size:12.5px;margin:14px 0 6px;"><b>What to do next</b></div>' +
    '<ol style="margin:0 0 12px 18px;padding:0;font-size:12.5px;line-height:1.6;">' + steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' +
    '<p style="font-size:12.5px;line-height:1.6;margin:0 0 8px;">This card turns \u201cConnected\u201d when the first payment arrives.</p>' +
    '<p style="font-size:12px;line-height:1.5;margin:0 0 14px;color:var(--muted);">KCB\u2019s exact steps are still being confirmed with the first real school. If KCB asks for something different, tell us.</p>' +
    '<div class="actions"><button class="btn primary" onclick="kcbDone()">Done</button></div>');
}

window.kcbDone = function () {
  bankSetupClose();
  if (typeof banksLoad === 'function') banksLoad();
};

/* ---------------- plug into page-bank-setup.js ---------------- */
BANK_SETUP_OWN.kcb = {
  open: kcbOpen,
  change: kcbChange,
  // Buttons on a card that is already set up. Everyone can see the details (nothing secret).
  buttons: function (c, isAdmin) {
    return '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;">' +
      '<button class="btn small" onclick="kcbShowDetails()">Show details</button>' +
      (isAdmin ? '<button class="btn danger small" onclick="bankResetOpen(\'kcb\')">Change account number</button>' : '') + '</div>';
  },
};
window.kcbShowDetails = function () { kcbDetails('KCB setup details'); };