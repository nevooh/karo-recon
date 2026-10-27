/* page-banks.js - the BANK CONNECTIONS page (real, one file for this page).
   Loaded after live-screens.js. Uses: live, esc, Api, showView (and the shared look in styles.css).

   What it does:
   - Shows a card for each channel the school has SWITCHED ON in School settings
     (page-settings.js). Channels switched off are hidden here. Nothing is disconnected
     by hiding, and payments that arrive are still saved.
   - Each card has a plain status:
       "Not set up yet" / "Set up - waiting for the first payment" / "Connected".
     "Connected" means a payment really arrived (not just "saved").
   - Cards of banks where we generate the login get Set up / Reset buttons
     (see page-bank-setup.js).
   - If nothing is switched on yet, it says so and points to School settings.
   Endpoint: GET /schools/:id/channels */

const bankPage = {
  list: null,        // the 4 channels from the server
};

function banksWhen(v) { return esc(String(v || '').slice(0, 16).replace('T', ' ')); }
function banksIsAdmin() { return !(live.staff && live.staff.role === 'staff'); } // the server enforces this too
const SETTINGS_LINK = '<span class="gpill" onclick="showView(\'settings\')">School settings</span>';

function bankStatusHtml(c) {
  if (c.status === 'connected') {
    return '<div class="connected-tag"><span class="sw"></span>Connected</div>';
  }
  if (c.status === 'waiting_for_bank') {
    return '<div style="font-size:11px;color:var(--cash);margin-bottom:8px;">Set up &middot; waiting for the first payment</div>';
  }
  return '<div style="font-size:11px;color:var(--muted);margin-bottom:8px;">Not set up yet</div>';
}

// The button(s) at the bottom of a card (see page-bank-setup.js and page-bank-setup-kcb.js).
function bankActions(c) {
  if (typeof bankSetupAvailable !== 'function' || !bankSetupAvailable(c.channel)) return '';
  const admin = banksIsAdmin();
  if (c.status === 'setup_needed') {
    return admin
      ? '<button class="btn primary wide" style="margin-top:12px;" onclick="bankSetupOpen(\'' + c.channel + '\')">Set up ' + esc(c.label) + '</button>'
      : '<div class="fields" style="margin:10px 0 0;">Ask an Admin to set this up.</div>';
  }
  return bankSetupButtons(c, admin);
}

/* ---------------- one channel card ---------------- */
function bankCard(c) {
  const login = c.login_set === null ? '' : '<div class="fields">Notification login: <b>' + (c.login_set ? 'set' : 'NOT set') + '</b></div>';
  const activity = c.payments
    ? c.payments + ' payment' + (c.payments === 1 ? '' : 's') + ' &middot; last ' + banksWhen(c.last_payment_at)
    : 'No payments received yet';
  return '<div class="bank-card"><h3>' + esc(c.label) + '</h3>' + bankStatusHtml(c) +
    '<div class="fields">' + esc(c.identifier_label) + ': <b>' + esc(c.identifier || '-') + '</b></div>' + login +
    (typeof kcbKeyLine === 'function' ? kcbKeyLine(c) : '') +
    (typeof mpesaStageLine === 'function' ? mpesaStageLine(c) : '') +
    '<div class="fields">' + esc(c.how) + '</div><div class="fields" style="margin-top:6px;">' + activity + '</div>' + bankActions(c) + '</div>';
}

/* ---------------- the page ---------------- */
function banksRender() {
  const box = document.getElementById('banksBody');
  if (!box || !bankPage.list) return;
  const picked = bankPage.list.filter(function (c) { return c.selected; });
  if (!picked.length) {
    box.innerHTML = '<div style="max-width:560px;margin-top:14px;"><h2 style="font-size:16px;margin:0 0 6px;">No payment channels are switched on yet</h2>' +
      '<p class="sub" style="margin-bottom:12px;">' + (banksIsAdmin()
        ? 'Choose the channels this school uses in ' + SETTINGS_LINK + '. They will appear here.'
        : 'An Admin of this school must switch on the channels it uses in ' + SETTINGS_LINK + '.') + '</p></div>';
    return;
  }
  const listening = bankPage.list.filter(function (c) { return !c.selected && c.payments > 0; });
  const warn = listening.length
    ? '<p style="margin-top:14px;font-size:12.5px;color:var(--cash);">Hidden but still receiving payments: ' + listening.map(function (c) { return esc(c.label) + ' (' + c.payments + ')'; }).join(', ') + '. Switch it on in ' + SETTINGS_LINK + ' to see it here.</p>'
    : '';
  box.innerHTML = '<div class="bank-grid" style="margin-top:12px;">' + picked.map(bankCard).join('') + '</div>' + warn +
    '<p style="margin-top:16px;font-size:12px;color:var(--muted);">Only the channels switched on in ' + SETTINGS_LINK + ' are shown here.</p>';
}

async function banksLoad() {
  if (!document.getElementById('banksBody') || !live.staff) return;
  try {
    bankPage.list = await Api.get('/schools/' + live.staff.school_id + '/channels');
    banksRender();
  } catch (e) {
    const b = document.getElementById('banksBody');
    if (b) b.innerHTML = '<p class="sub">' + esc(e.message) + '</p>';
  }
}

views.banks = function () {
  setTimeout(banksLoad, 0);
  return '<div class="topbar"><div><h1>Bank connections</h1><p class="sub">The ways money reaches this school, and whether each one is working. Keys and passwords are never shown.</p></div></div>' +
    '<div id="banksBody"><p class="sub">Loading&hellip;</p></div>';
};