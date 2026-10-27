/* page-optional-fees.js - the Optional fees page, connected to the real database.
   - The school keeps ONE list of optional fee names (Lunch, Bus, Swimming ...). Add a name once, then price it.
   - The page shows ONE optional fee at a time. Pick it from the chips at the top.
   - For the picked fee there is one table: one row per class, one column per term (1, 2, 3).
     A price means "this class offers it in that term at that price" (Term 3 is shorter, so it can cost less).
     An empty box means "this class does not offer it in that term".
   - "Fill all classes" row: type a price under a term, press the button, every class gets that price (not saved yet).
   - Saving makes a new version of those classes' fees for those terms. A term that is already billed is never changed.
   - A name can only be removed when no class offers it and no student has chosen it.
   Only an admin can change anything (the server checks it too).
   Backend calls are the same as before: GET /optional-fees, POST /optional-fees, POST /optional-fees/prices, DELETE /optional-fees/:name.
   Add to index.html AFTER page-fees.js:  <script src="js/page-optional-fees.js"></script> */

const ox = { data: null, error: null, loadToken: 0, drafts: {}, busy: null, asks: {}, errs: {}, sel: null };

(function () {
  if (document.getElementById('oxStyle')) return;
  const css = document.createElement('style');
  css.id = 'oxStyle';
  css.textContent = [
    '.ox-add{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:0 0 16px}',
    '.ox-name{font:inherit;font-size:14px;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:9px;padding:9px 11px;flex:1;min-width:200px;max-width:320px;box-sizing:border-box}',
    '.ox-name:focus{outline:none;border-color:var(--matched)}',
    /* chips: one per optional fee, scroll sideways if there are many */
    '.ox-chips{display:flex;gap:8px;overflow-x:auto;padding:2px 0 12px;margin:0 0 4px;scrollbar-width:thin}',
    '.ox-chip{font:inherit;font-size:13.5px;font-weight:500;white-space:nowrap;border-radius:999px;padding:8px 15px;cursor:pointer;border:1px solid var(--line);background:transparent;color:var(--muted);display:inline-flex;gap:7px;align-items:center;flex:0 0 auto}',
    '.ox-chip:hover{border-color:var(--muted);color:var(--ink)}',
    '.ox-chip.on{background:var(--surface-raised);border-color:var(--matched);color:var(--ink)}',
    '.ox-chip .dot{width:7px;height:7px;border-radius:50%;background:var(--cash)}',
    '.ox-chip .cnt{font-size:11.5px;color:var(--muted);font-family:"IBM Plex Mono",monospace}',
    '.ox-card{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:18px 20px 20px;min-width:0}',
    '.ox-h{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap}',
    '.ox-h > div:first-child{flex:1;min-width:180px}',
    '.ox-h h2{font-family:"Space Grotesk",sans-serif;font-size:19px;font-weight:600;margin:0}',
    '.ox-h p{margin:4px 0 0;font-size:12.5px;color:var(--muted)}',
    /* long tables scroll inside the box, the header stays on top */
    '.ox-scroll{overflow:auto;max-height:62vh;margin-top:14px;border:1px solid var(--line);border-radius:13px}',
    '.ox-t{width:100%;border-collapse:collapse;font-size:14px;min-width:420px}',
    '.ox-t th{position:sticky;top:0;z-index:1;background:var(--surface);font-size:11.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);font-weight:500;text-align:left;padding:10px 12px;border-bottom:1px solid var(--line)}',
    '.ox-t td{padding:5px 12px;border-bottom:1px solid var(--line)}',
    '.ox-t tr:last-child td{border-bottom:0}',
    '.ox-t td.cl{white-space:nowrap}',
    '.ox-t tr.fill td{background:rgba(255,255,255,.03);border-bottom:1px solid var(--muted)}',
    '.ox-in{font:inherit;font-family:"IBM Plex Mono",monospace;font-size:13.5px;text-align:right;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:9px;padding:6px 10px;width:110px;box-sizing:border-box}',
    '.ox-in:focus{outline:none;border-color:var(--matched)}',
    '.ox-in.changed{border-color:var(--cash);background:rgba(217,164,65,.08)}',
    '.ox-in:disabled{opacity:.7}',
    '.ox-foot{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:14px}',
    '.ox-foot .sum{font-size:12.5px;color:var(--muted);margin-right:auto}',
    '.ox-btn{font:inherit;font-size:13.5px;font-weight:600;border-radius:10px;padding:9px 16px;cursor:pointer;border:1px solid var(--line);background:transparent;color:var(--ink)}',
    '.ox-btn:hover:not(:disabled){border-color:var(--muted)}',
    '.ox-btn.go{background:var(--matched);border-color:var(--matched);color:#0E1613}',
    '.ox-btn.warn{border-color:var(--alert);color:var(--alert)}',
    '.ox-btn.small{font-size:12.5px;padding:7px 12px}',
    '.ox-btn:disabled{opacity:.5;cursor:not-allowed}',
    '.ox-msg{margin-top:12px;padding:11px 14px;border-radius:11px;font-size:13px;line-height:1.55;background:rgba(226,87,76,.1);border:1px solid rgba(226,87,76,.45)}',
    '.ox-msg.ask{background:rgba(217,164,65,.12);border-color:rgba(217,164,65,.5)}',
    '.ox-empty{text-align:center;padding:44px 20px;background:var(--surface);border:1px dashed var(--line);border-radius:16px;color:var(--muted);font-size:13.5px;line-height:1.6}',
    '.ox-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:var(--surface-raised);border:1px solid var(--matched);color:var(--ink);padding:11px 18px;border-radius:10px;font-size:13px;z-index:99;max-width:90vw}',
    '.ox-toast.bad{border-color:var(--alert)}',
    '@media(max-width:620px){.ox-card{padding:14px 12px 16px}.ox-in{width:88px}}',
  ].join('\n');
  document.head.appendChild(css);
})();

const oxBase = function () { return '/schools/' + live.staff.school_id; };
const oxAdmin = function () { return live.staff.role === 'admin'; };
const oxEl = function (id) { return document.getElementById(id); };
const oxKey = function (s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase(); };
function oxToast(msg, bad) {
  const old = oxEl('oxToast'); if (old) old.remove();
  const d = document.createElement('div');
  d.id = 'oxToast'; d.className = 'ox-toast' + (bad ? ' bad' : ''); d.textContent = msg;
  document.body.appendChild(d);
  setTimeout(function () { if (d.parentNode) d.remove(); }, 4200);
}
function oxNum(s) {                                     // typed price -> number, or null if it is not a good amount
  const t = String(s == null ? '' : s).replace(/,/g, '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const n = Number(t);
  return n > 0 && n <= 10000000 ? n : null;
}
const oxCell = function (v) { return v == null ? '' : String(v); };

views.optionalfees = function () {
  ox.data = null; ox.error = null; ox.drafts = {}; ox.busy = null; ox.asks = {}; ox.errs = {};
  setTimeout(function () { oxLoad(); }, 0);
  return '<div id="oxRoot">' + oxBody() + '</div>';
};

async function oxLoad() {
  const token = ++ox.loadToken;
  ox.error = null;
  try {
    const d = await Api.get(oxBase() + '/optional-fees');
    if (token !== ox.loadToken) return;
    ox.data = d; ox.drafts = {}; ox.asks = {}; ox.errs = {};
  } catch (e) { if (token !== ox.loadToken) return; ox.error = e.message; ox.data = null; }
  oxRender();
}
function oxRender() { const r = oxEl('oxRoot'); if (r) r.innerHTML = oxBody(); }

function oxDraft(name) { const k = oxKey(name); if (!ox.drafts[k]) ox.drafts[k] = {}; return ox.drafts[k]; }
// the changed cells of one optional fee: [{ class_id, term, raw }]
function oxChanges(item) {
  const d = ox.drafts[oxKey(item.name)] || {};
  const out = [];
  Object.keys(d).forEach(function (cell) {
    const parts = cell.split('|'), classId = Number(parts[0]), term = Number(parts[1]);
    const was = oxCell((item.prices[classId] || {})[term]);
    const now = String(d[cell]).replace(/,/g, '').trim();
    if (now !== was && !(now !== '' && was !== '' && Number(now) === Number(was))) out.push({ class_id: classId, term: term, raw: now });
  });
  return out;
}
// how many classes offer this fee in at least one term
function oxOffered(item) {
  return ox.data.classes.filter(function (c) {
    const p = item.prices[c.id] || {};
    return oxCell(p[1]) !== '' || oxCell(p[2]) !== '' || oxCell(p[3]) !== '';
  }).length;
}
// the fee that is open now (first one if none picked, or if the picked one is gone)
function oxPicked() {
  const names = ox.data.names;
  let i = names.findIndex(function (n) { return oxKey(n.name) === ox.sel; });
  if (i < 0) { i = 0; ox.sel = oxKey(names[0].name); }
  return i;
}

function oxBody() {
  const head = '<div class="topbar"><div><h1>Optional fees</h1><p class="sub">Lunch, bus, swimming... Pick one, then set the price for each class and term. An empty box means the class does not offer it that term.</p></div></div>';
  if (ox.error) return head + '<div class="ox-empty"><b>Could not load the optional fees</b><br>' + esc(ox.error) + '<br><br><button type="button" class="ox-btn" onclick="oxLoad()">Try again</button></div>';
  if (!ox.data) return head + '<div class="ox-empty">Loading...</div>';
  const add = oxAdmin() ? '<div class="ox-add"><input class="ox-name" id="oxNewName" placeholder="New optional fee, for example Lunch" maxlength="60" aria-label="New optional fee name" onkeydown="if(event.key===\'Enter\')oxAddName()"><button type="button" class="ox-btn go" onclick="oxAddName()">Add to the list</button></div>' : '';
  if (!ox.data.classes.length) return head + add + '<div class="ox-empty">No classes are switched on yet. Switch on the classes this school runs first (Classes &amp; streams).</div>';
  if (!ox.data.names.length) return head + add + '<div class="ox-empty">No optional fees yet.' + (oxAdmin() ? ' Add the first one above, for example <b>Lunch</b>, then set its price for each class.' : '') + '</div>';
  const cur = oxPicked();
  const chips = '<div class="ox-chips" role="tablist">' + ox.data.names.map(function (item, i) {
    const dirty = oxChanges(item).length > 0;
    return '<button type="button" role="tab" aria-selected="' + (i === cur) + '" class="ox-chip' + (i === cur ? ' on' : '') + '" onclick="oxPick(' + i + ')">' +
      esc(item.name) + (dirty ? '<span class="dot" title="Not saved yet"></span>' : '') +
      '<span class="cnt">' + oxOffered(item) + '/' + ox.data.classes.length + '</span></button>';
  }).join('') + '</div>';
  return head + add + chips + oxCard(ox.data.names[cur], cur);
}

function oxPick(idx) { ox.sel = oxKey(ox.data.names[idx].name); oxRender(); }

function oxCard(item, idx) {
  const admin = oxAdmin();
  const d = ox.drafts[oxKey(item.name)];
  const fillRow = admin ? '<tr class="fill"><td class="cl"><b>All classes</b></td>' + [1, 2, 3].map(function (t) {
    return '<td><input class="ox-in" id="oxf_' + t + '" placeholder="same price" inputmode="decimal" aria-label="Price for all classes, Term ' + t + '"></td>';
  }).join('') + '</tr>' : '';
  const rows = ox.data.classes.map(function (c) {
    const cells = [1, 2, 3].map(function (t) {
      const was = oxCell((item.prices[c.id] || {})[t]);
      const val = d && d[c.id + '|' + t] !== undefined ? d[c.id + '|' + t] : was;
      return '<td><input class="ox-in' + (val !== was ? ' changed' : '') + '" id="oxc_' + c.id + '_' + t + '" value="' + esc(val) + '" placeholder="not offered" inputmode="decimal" aria-label="' + esc(item.name + ', ' + c.name + ', Term ' + t) + '"' + (admin ? '' : ' disabled') +
        ' oninput="oxEdit(' + idx + ',' + c.id + ',' + t + ',this)"></td>';
    }).join('');
    return '<tr><td class="cl">' + esc(c.name) + '</td>' + cells + '</tr>';
  }).join('');
  const n = oxChanges(item).length;
  const busy = ox.busy === item.name;
  const remove = admin && item.removable ? '<button type="button" class="ox-btn warn small" onclick="oxRemove(' + idx + ')">Remove from the list</button>' : '';
  const sub = item.students + ' student' + (item.students === 1 ? '' : 's') + ' take it' +
    (item.blockedBy && admin ? ' &middot; in use, so it can not be removed' : '') + (item.inList ? '' : ' &middot; not on the school\'s list yet');
  const ask = ox.asks[item.name];
  const msg = ox.errs[item.name] ? '<div class="ox-msg" role="alert">' + esc(ox.errs[item.name]) + '</div>' : '';
  const askHtml = ask ? '<div class="ox-msg ask" role="alert">' + esc(ask) + '<br><button type="button" class="ox-btn warn" style="margin-top:8px" onclick="oxSave(' + idx + ',true)">Save anyway: they lose it</button></div>' : '';
  return '<div class="ox-card" id="oxCard"><div class="ox-h"><div><h2>' + esc(item.name) + '</h2><p>' + sub + '</p></div>' +
    (admin ? '<button type="button" class="ox-btn small" onclick="oxFill(' + idx + ')">Fill all classes</button>' : '') + remove + '</div>' +
    '<div class="ox-scroll"><table class="ox-t"><thead><tr><th>Class</th><th>Term 1</th><th>Term 2</th><th>Term 3</th></tr></thead><tbody>' + fillRow + rows + '</tbody></table></div>' +
    (admin ? '<div class="ox-foot"><div class="sum" id="oxSum">' + (n ? n + ' change' + (n === 1 ? '' : 's') + ' not saved yet' : 'No changes') + '</div>' +
      '<button type="button" class="ox-btn" onclick="oxReset(' + idx + ')"' + (n && !busy ? '' : ' disabled') + ' id="oxReset">Undo</button>' +
      '<button type="button" class="ox-btn go" id="oxSave" onclick="oxSave(' + idx + ')"' + (n && !busy ? '' : ' disabled') + '>Save prices</button></div>' : '') + msg + askHtml + '</div>';
}

// typing in a box: remember it and update the buttons without redrawing (so the cursor stays)
function oxEdit(idx, classId, term, input) {
  const item = ox.data.names[idx];
  oxDraft(item.name)[classId + '|' + term] = input.value;
  const was = oxCell((item.prices[classId] || {})[term]);
  input.classList.toggle('changed', input.value.replace(/,/g, '').trim() !== was && !(input.value.trim() !== '' && was !== '' && Number(input.value.replace(/,/g, '')) === Number(was)));
  delete ox.errs[item.name]; delete ox.asks[item.name];
  const n = oxChanges(item).length;
  const sum = oxEl('oxSum'); if (sum) sum.textContent = n ? n + ' change' + (n === 1 ? '' : 's') + ' not saved yet' : 'No changes';
  const s = oxEl('oxSave'); if (s) s.disabled = !n;
  const u = oxEl('oxReset'); if (u) u.disabled = !n;
}

// "Fill all classes": copy the price typed in the top row into every class (only the terms that have a price typed)
function oxFill(idx) {
  const item = ox.data.names[idx];
  let any = false;
  [1, 2, 3].forEach(function (t) {
    const box = oxEl('oxf_' + t);
    const v = box ? box.value.trim() : '';
    if (v === '') return;
    any = true;
    ox.data.classes.forEach(function (c) { oxDraft(item.name)[c.id + '|' + t] = v; });
  });
  if (!any) { oxToast('Type a price in the "All classes" row first, under the term you want.', true); return; }
  delete ox.errs[item.name]; delete ox.asks[item.name];
  oxRender();
}

function oxReset(idx) { delete ox.drafts[oxKey(ox.data.names[idx].name)]; delete ox.errs[ox.data.names[idx].name]; delete ox.asks[ox.data.names[idx].name]; oxRender(); }

async function oxSave(idx, allowDrop) {
  const item = ox.data.names[idx];
  if (ox.busy) return;
  const changes = oxChanges(item);
  if (!changes.length) return;
  const prices = [];
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    const cls = ox.data.classes.find(function (x) { return x.id === c.class_id; });
    if (c.raw === '') { prices.push({ class_id: c.class_id, term: c.term, amount: null }); continue; }
    const amount = oxNum(c.raw);
    if (amount == null) { ox.errs[item.name] = cls.name + ', Term ' + c.term + ': write the price as a number like 3000, or leave it empty for "not offered".'; oxRender(); return; }
    prices.push({ class_id: c.class_id, term: c.term, amount: amount });
  }
  ox.busy = item.name; delete ox.errs[item.name]; delete ox.asks[item.name]; oxRender();
  try {
    const r = await Api.post(oxBase() + '/optional-fees/prices', { name: item.name, prices: prices, allow_drop: allowDrop === true });
    const n = r.classes.filter(function (c) { return !c.unchanged; }).length;
    ox.busy = null;
    await oxLoad();
    oxToast(n ? 'Saved: ' + n + ' fee list' + (n === 1 ? '' : 's') + ' updated.' : 'No change.');
  } catch (e) {
    ox.busy = null;
    if (/lose it at the next billing/.test(e.message)) ox.asks[item.name] = e.message.replace(/ If that is what you want, add --allow-drop\.?/, '');
    else ox.errs[item.name] = e.message;
    oxRender();
  }
}

async function oxAddName() {
  const input = oxEl('oxNewName');
  const name = input ? input.value.replace(/\s+/g, ' ').trim() : '';
  if (!name) { oxToast('Type the name of the optional fee first.', true); return; }
  try {
    await Api.post(oxBase() + '/optional-fees', { name: name });
    ox.sel = oxKey(name);                                // open the new fee straight away
    await oxLoad();
    oxToast('"' + name + '" added. Now set its price for each class and term.');
  } catch (e) { oxToast(e.message, true); }
}

async function oxRemove(idx) {
  const item = ox.data.names[idx];
  if (!window.confirm('Remove "' + item.name + '" from the list? Nothing uses it, so no fees change.')) return;
  try {
    await Api.request('DELETE', oxBase() + '/optional-fees/' + encodeURIComponent(item.name));
    ox.sel = null;
    await oxLoad();
    oxToast('"' + item.name + '" removed.');
  } catch (e) { oxToast(e.message, true); }
}