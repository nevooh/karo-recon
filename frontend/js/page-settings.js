/* page-settings.js - the SCHOOL SETTINGS page (real, one file for this page).
   Loaded after live.js. Uses: live, esc, Api, showView, stDialog/stToast (page-staff.js), shellLogo/shellSchool (shell.js).

   Sections:
     1. SCHOOL PROFILE  name, motto, phone, email, address, county, receipt footer. Any Admin can edit.
                        Renaming the school = Main Admin only, and asks for the PIN.
     2. LOGO            PNG / JPG / WebP, shrunk in the browser before upload. Shown in the sidebar, on receipts and on report prints.
     3. PAYMENT CHANNELS  on/off switches for M-Pesa, KCB, Equity, Co-op (asks an Admin for the PIN).
     4. MY PIN          Admins only: set or change your personal PIN (needs your login password).
   Staff-role people can look at the profile and channels but can not change anything.
   Endpoints: /schools/:id/profile, /logo, /channels, /pin, /pin/set */

const settingsPage = {
  list: null,     // the 4 channels from the server
  prof: null,     // the school profile
  pin: null,      // { has_pin, locked_minutes } (Admins)
  busy: false,    // true while a switch is being saved
  error: '',
  saved: '',      // short "Saved" message after a successful flip
  pmsg: '', pbad: false,   // message under the profile form
};

(function () {
  if (document.getElementById('spStyle')) return;
  const c = document.createElement('style'); c.id = 'spStyle';
  c.textContent = [
    '.sp-wrap{max-width:660px}.sp-h{font-size:16px;margin:26px 0 4px}.sp-h:first-child{margin-top:6px}',
    '.sp-card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin-top:10px}',
    '.sp-card label{display:block;font-size:12px;color:var(--muted);margin:12px 0 5px}.sp-card label:first-child{margin-top:0}',
    '.sp-card .st-in{max-width:100%}.sp-two{display:grid;grid-template-columns:1fr 1fr;gap:12px}',
    '@media(max-width:560px){.sp-two{grid-template-columns:1fr}}',
    '.sp-note{font-size:11.5px;color:var(--muted);margin-top:4px}',
    '.sp-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:14px}',
    '.sp-btn{font:inherit;font-size:13px;border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:10px;padding:9px 14px;cursor:pointer}',
    '.sp-btn.go{background:var(--ink);color:var(--surface);border-color:var(--ink)}.sp-btn:disabled{opacity:.5;cursor:default}',
    '.sp-logo{display:flex;gap:16px;align-items:center;flex-wrap:wrap}',
    '.sp-msg{font-size:12.5px;min-height:18px;margin-top:8px}',
  ].join('\n');
  document.head.appendChild(c);
})();

function settingsIsAdmin() { return !(live.staff && live.staff.role === 'staff'); } // the server enforces this too

function settingsRow(c, admin) {
  const on = c.selected;
  let note = '';
  if (c.status === 'connected') {
    note = '<div class="fields" style="margin:6px 0 0;color:var(--cash);">Receiving payments (' + c.payments + ')' + (on ? '' : '. Hidden here, but still working.') + '</div>';
  } else if (c.connected) {
    note = '<div class="fields" style="margin:6px 0 0;">Already set up</div>';
  }
  return '<label class="bank-card" style="display:block;cursor:' + (admin && !settingsPage.busy ? 'pointer' : 'default') + ';' + (on ? 'border-color:var(--matched);' : '') + '">' +
    '<div style="display:flex;align-items:center;gap:10px;">' +
    '<input type="checkbox" ' + (on ? 'checked ' : '') + (admin && !settingsPage.busy ? '' : 'disabled ') + 'onchange="settingsToggle(\'' + c.channel + '\', this.checked)">' +
    '<h3 style="margin:0;flex:1;">' + esc(c.label) + '</h3>' +
    '<span style="font-size:11.5px;color:' + (on ? 'var(--matched)' : 'var(--muted)') + ';">' + (on ? 'Shown in Bank connections' : 'Hidden') + '</span></div>' +
    '<div class="fields" style="margin:8px 0 0;">' + esc(c.how) + '</div>' + note + '</label>';
}

function settingsRender() {
  const box = document.getElementById('settingsBody');
  if (!box || !settingsPage.list) return;
  const admin = settingsIsAdmin();
  box.innerHTML =
    '<div class="sp-wrap">' + settingsProfileHtml(admin) +
    '<h2 class="sp-h">Payment channels</h2>' +
    '<p class="sub" style="margin-bottom:6px;">Switch on the channels this school uses. Only those appear on the Bank connections page.</p>' +
    '<p class="sub" style="margin-bottom:12px;">Switching one off only hides it. Nothing is disconnected, and payments that arrive are still saved. You can switch it back on any time.</p>' +
    (admin ? '' : '<p class="sub" style="color:var(--cash);">Only an Admin can change these. Ask an Admin of this school.</p>') +
    '<div class="bank-grid" style="grid-template-columns:1fr;">' + settingsPage.list.map(function (c) { return settingsRow(c, admin); }).join('') + '</div>' +
    '<div style="min-height:22px;margin-top:10px;font-size:12.5px;">' +
    (settingsPage.error ? '<span style="color:var(--alert);">' + esc(settingsPage.error) + '</span>' : (settingsPage.saved ? '<span style="color:var(--matched);">' + esc(settingsPage.saved) + '</span>' : '')) +
    '</div>' + settingsPinHtml(admin) + '</div>';
}

function settingsProfileHtml(admin) {
  const p = settingsPage.prof; if (!p) return '';
  const main = !!(live.staff && live.staff.is_owner);
  const f = function (id, label, val, max, ph, extra) {
    return '<div><label for="sp_' + id + '">' + label + '</label><input class="st-in" id="sp_' + id + '" maxlength="' + max + '" value="' + esc(val || '') + '" placeholder="' + esc(ph || '') + '"' + (admin && !(id === 'name' && !main) ? '' : ' disabled') + '>' + (extra || '') + '</div>';
  };
  return '<h2 class="sp-h">School profile</h2><p class="sub">Shown in the menu, on receipts and on printed reports. Receipts print the phone numbers and the address.</p>' +
    '<div class="sp-card">' + f('name', 'School name', p.name, 120, '', main ? '<div class="sp-note">Changing the name asks for your PIN. It is saved in the activity log.</div>' : '<div class="sp-note">Only the Main Admin can change the school name.</div>') +
    f('motto', 'Motto', p.motto, 120, 'e.g. Knowledge is power') +
    '<div class="sp-two">' + f('phone', 'Phone', p.phone, 30, '07xx xxx xxx') + f('phone2', 'Second phone (optional)', p.phone2, 30, '07xx xxx xxx') + '</div>' +
    f('email', 'Email', p.email, 120, 'office@school.ac.ke') +
    '<div class="sp-two">' + f('address', 'Address', p.address, 200, 'P.O. Box ...') + f('county', 'County', p.county, 60, '') + '</div>' +
    f('receipt_footer', 'Receipt footer', p.receipt_footer, 200, 'e.g. Fees are not refundable.', '<div class="sp-note">One line printed at the bottom of every receipt.</div>') +
    (admin ? '<div class="sp-row"><button type="button" class="sp-btn go" id="spSave" onclick="settingsSaveProfile()">Save profile</button></div>' : '<p class="sp-note" style="margin-top:12px">Only an Admin can change these.</p>') +
    '<div class="sp-msg" id="spMsg" style="color:' + (settingsPage.pbad ? 'var(--alert)' : 'var(--matched)') + '">' + esc(settingsPage.pmsg) + '</div></div>' +
    '<h2 class="sp-h">Logo</h2><div class="sp-card"><div class="sp-logo"><div>' + shellLogo(84, p) + '</div><div>' +
    '<div class="sp-note" style="margin:0 0 8px">PNG, JPG or WebP. It is shrunk for you. A square picture looks best.</div>' +
    (admin ? '<input type="file" id="spFile" accept="image/png,image/jpeg,image/webp" style="display:none" onchange="settingsPickLogo(this)">' +
      '<button type="button" class="sp-btn go" onclick="document.getElementById(\'spFile\').click()">' + (p.logo ? 'Replace logo' : 'Upload logo') + '</button> ' +
      (p.logo ? '<button type="button" class="sp-btn" onclick="settingsRemoveLogo()">Remove</button>' : '') : '') +
    '</div></div><div class="sp-msg" id="spLogoMsg"></div></div>';
}

function settingsPinHtml(admin) {
  if (!admin) return '';
  const st = settingsPage.pin; if (!st) return '';
  return '<h2 class="sp-h">My PIN</h2><p class="sub">Your personal PIN protects the sensitive things: bank and M-Pesa settings, payment channels, staff access and renaming the school. Recording payments and everyday work never ask for it.</p>' +
    '<div class="sp-card"><div>' + (st.has_pin ? 'You have a PIN.' : 'You have not set a PIN yet. You will be asked to set one the first time you do something sensitive.') +
    (st.locked_minutes ? ' <b style="color:var(--alert)">Locked for about ' + st.locked_minutes + ' more minutes after too many wrong tries.</b>' : '') + '</div>' +
    '<div class="sp-row"><button type="button" class="sp-btn go" onclick="settingsSetPin()">' + (st.has_pin ? 'Change my PIN' : 'Set my PIN') + '</button></div></div>';
}

async function settingsLoad() {
  if (!document.getElementById('settingsBody') || !live.staff) return;
  try {
    const sid = '/schools/' + live.staff.school_id;
    settingsPage.list = await Api.get(sid + '/channels');
    settingsPage.prof = await Api.get(sid + '/profile');
    settingsPage.pin = settingsIsAdmin() ? await Api.get(sid + '/pin') : null;
    settingsRender();
  } catch (e) {
    const b = document.getElementById('settingsBody');
    if (b) b.innerHTML = '<p class="sub">' + esc(e.message) + '</p>';
  }
}

views.settings = function () {
  settingsPage.busy = false; settingsPage.error = ''; settingsPage.saved = ''; settingsPage.pmsg = ''; settingsPage.pbad = false;
  setTimeout(settingsLoad, 0);
  return '<div class="topbar"><div><h1>School settings</h1><p class="sub">How this school is set up in Karo Recon</p></div></div>' +
    '<div id="settingsBody"><p class="sub">Loading&hellip;</p></div>';
};

// Flip one switch. We send the WHOLE list of channels that should be on.
window.settingsToggle = async function (channel, on) {
  if (settingsPage.busy) return;
  const now = settingsPage.list.filter(function (c) { return c.selected; }).map(function (c) { return c.channel; });
  const next = on ? now.concat([channel]) : now.filter(function (c) { return c !== channel; });
  const label = (settingsPage.list.find(function (c) { return c.channel === channel; }) || {}).label || channel;
  settingsPage.busy = true; settingsPage.error = ''; settingsPage.saved = ''; settingsRender();
  try {
    settingsPage.list = await Api.put('/schools/' + live.staff.school_id + '/channels', { channels: next });
    settingsPage.saved = label + (on ? ' is now shown in Bank connections.' : ' is now hidden from Bank connections.');
  } catch (e) {
    settingsPage.error = e.message;           // e.g. "Only an Admin can do this"; the switch goes back to what the server has
  }
  settingsPage.busy = false; settingsRender();
};

/* ---- profile, logo, PIN actions ---- */
function settingsSid() { return '/schools/' + live.staff.school_id; }
function settingsSay(id, text, bad) { const m = document.getElementById(id); if (m) { m.textContent = text; m.style.color = bad ? 'var(--alert)' : 'var(--matched)'; } }

window.settingsSaveProfile = async function () {
  const g = function (id) { const e = document.getElementById('sp_' + id); return e ? e.value : ''; };
  const body = { motto: g('motto'), phone: g('phone'), phone2: g('phone2'), email: g('email'), address: g('address'), county: g('county'), receipt_footer: g('receipt_footer') };
  if (live.staff.is_owner) body.name = g('name');
  const b = document.getElementById('spSave'); if (b) b.disabled = true;
  try {
    const r = await Api.put(settingsSid() + '/profile', body);       // a rename asks for the PIN by itself (api.js)
    settingsPage.prof = r.profile; await shellSchool(r.profile);
    settingsPage.pmsg = r.unchanged ? 'Nothing changed.' : 'Saved.'; settingsPage.pbad = false;
  } catch (e) { settingsPage.pmsg = e.message; settingsPage.pbad = true; }
  settingsRender();
};

// shrink the picture in the browser (max 400px) so uploads stay small; keeps transparency as PNG
function settingsShrink(file) {
  return new Promise(function (resolve, reject) {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return reject(new Error('Please choose a PNG, JPG or WebP picture.'));
    const fr = new FileReader();
    fr.onerror = function () { reject(new Error('Could not read that file.')); };
    fr.onload = function () {
      const img = new Image();
      img.onerror = function () { reject(new Error('That does not look like a picture.')); };
      img.onload = function () {
        const k = Math.min(1, 400 / Math.max(img.width, img.height));
        const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        let out = c.toDataURL('image/png');
        if (out.length > 600000) {                                       // a photo-like logo: JPEG is much smaller
          const j = document.createElement('canvas'); j.width = c.width; j.height = c.height; const x = j.getContext('2d');
          x.fillStyle = '#fff'; x.fillRect(0, 0, j.width, j.height); x.drawImage(c, 0, 0); out = j.toDataURL('image/jpeg', 0.85);
        }
        resolve(out);
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}
window.settingsPickLogo = async function (inp) {
  const f = inp.files && inp.files[0]; if (!f) return;
  settingsSay('spLogoMsg', 'Uploading\u2026', false);
  try {
    const image = await settingsShrink(f);
    await Api.put(settingsSid() + '/logo', { image: image });
    settingsPage.prof = await Api.get(settingsSid() + '/profile'); await shellSchool(settingsPage.prof);
    settingsRender(); settingsSay('spLogoMsg', 'Logo saved.', false);
  } catch (e) { settingsSay('spLogoMsg', e.message, true); }
  inp.value = '';
};
window.settingsRemoveLogo = async function () {
  const ok = await stDialog({ title: 'Remove the logo?', intro: 'The menu and receipts go back to a coloured circle with the school initials.', okText: 'Remove', danger: true, run: function () { return Api.request('DELETE', settingsSid() + '/logo'); } });
  if (!ok) return;
  settingsPage.prof = await Api.get(settingsSid() + '/profile'); await shellSchool(settingsPage.prof); settingsRender();
};
window.settingsSetPin = async function () {
  const has = settingsPage.pin && settingsPage.pin.has_pin;
  const r = await stDialog({ title: has ? 'Change my PIN' : 'Set my PIN', intro: '4 to 6 digits. Easy ones like 1234 or 1111 are refused. We ask for your login password to be sure it is you.',
    fields: [{ id: 'pw', label: 'Your login password', type: 'password', autocomplete: 'current-password' }, { id: 'p1', label: has ? 'New PIN' : 'PIN', type: 'password', inputmode: 'numeric' }, { id: 'p2', label: 'PIN again', type: 'password', inputmode: 'numeric' }],
    okText: 'Save PIN', run: async function (v) { if (v.p1 !== v.p2) throw new Error('The two PINs are not the same.'); return Api.request('POST', settingsSid() + '/pin/set', { password: v.pw, pin: v.p1 }, true); } });
  if (!r || !r.token) return;
  Api.setPin(r.token, r.minutes); stToast('PIN saved.');
  settingsPage.pin = await Api.get(settingsSid() + '/pin'); settingsRender();
};