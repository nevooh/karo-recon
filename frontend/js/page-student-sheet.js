/* page-student-sheet.js - one student's FULL PAGE (opens from a row of Students & balances, the reports, the activity log).
   - Money this term (brought forward, fees, paid, balance) with the sum written out, the last 5 payments (Show all for the rest,
     reversed ones stay in the list), the fee breakdown, money per term, contacts and what changed on the student.
   - Any staff member can: record a payment (Cash, M-Pesa, Bank, Cheque, Other; M-Pesa and Bank need the code), edit the name and contacts,
     mark a student as left or bring them back. An ADMIN can also correct the admission number.
     Every one of those is audited with who did it. Nothing deletes a student or edits a ledger number by hand.
   - Adding a payment is safe to double-click: one request id per form, the server records it once.
   Add to index.html AFTER page-balances.js:  <script src="js/page-student-sheet.js"></script> */

const ss = { rev: null, open: false, id: null, data: null, error: null, mode: null, busy: false, err: null, reqId: null, done: null, token: 0, from: 'roster', scroll: 0, termId: null, all: false };

(function () {
  if (document.getElementById('ssStyle')) return;
  const css = document.createElement('style');
  css.id = 'ssStyle';
  css.textContent = [
    '.ss-sub{font-size:13px;color:var(--muted);margin-top:4px}',
    '.ss-acts{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 6px}',
    '.ss-btn{font:inherit;font-size:13.5px;font-weight:600;border-radius:10px;padding:9px 15px;cursor:pointer;border:1px solid var(--line);background:transparent;color:var(--ink)}',
    '.ss-btn:hover:not(:disabled){border-color:var(--muted)}',
    '.ss-btn.go{background:var(--matched);border-color:var(--matched);color:#0E1613}',
    '.ss-btn.warn{border-color:var(--alert);color:var(--alert)}',
    '.ss-btn:disabled{opacity:.5;cursor:not-allowed}',
    '.ss-h3{font-size:12px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);margin:22px 0 8px;font-weight:500}',
    '.ss-li{display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid var(--line);font-size:14px}',
    '.ss-li:last-child{border-bottom:0}',
    '.ss-li .am{font-family:"IBM Plex Mono",monospace;white-space:nowrap}',
    '.ss-li.total{font-weight:600}',
    '.ss-small{font-size:12px;color:var(--muted)}',
    '.ss-pay{display:flex;gap:10px;justify-content:space-between;align-items:flex-start;padding:10px 0;border-bottom:1px solid var(--line);font-size:14px}',
    '.ss-pay:last-child{border-bottom:0}',
    '.ss-form{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:16px;margin:12px 0}',
    '.ss-form label{display:block;font-size:12px;color:var(--muted);margin:10px 0 4px}',
    '.ss-form label:first-child{margin-top:0}',
    '.ss-in{font:inherit;font-size:14px;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:9px;padding:9px 11px;width:100%;box-sizing:border-box}',
    '.ss-in:focus{outline:none;border-color:var(--matched)}',
    '.ss-crow{display:grid;grid-template-columns:1.2fr 1fr .9fr;gap:8px;margin-bottom:8px}',
    '.ss-msg{margin-top:12px;padding:11px 14px;border-radius:11px;font-size:13px;line-height:1.55;background:rgba(226,87,76,.1);border:1px solid rgba(226,87,76,.45)}',
    '.ss-msg.ok{background:rgba(89,179,125,.1);border-color:rgba(89,179,125,.5)}',
    '.ss-msg.ask{background:rgba(217,164,65,.12);border-color:rgba(217,164,65,.5)}',
    '.ss-foot{display:flex;gap:10px;margin-top:14px;flex-wrap:wrap}',
    '.ss-rc-back{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:flex-start;justify-content:center;padding:28px 12px;overflow-y:auto;z-index:60}',
    '.ss-rc{background:#fff;color:#1a1a1a;width:100%;max-width:400px;border-radius:6px;padding:26px 28px 22px;box-shadow:0 12px 40px rgba(0,0,0,.35);font:13px/1.5 "IBM Plex Sans",sans-serif;box-sizing:border-box}',
    '.ss-rc h3{font:700 15px "Space Grotesk",sans-serif;margin:0;letter-spacing:.01em}',
    '.ss-rc .rt{text-align:center;padding-bottom:16px;border-bottom:1px solid #e3e3e3}',
    '.ss-rc .rm{font-style:italic;font-size:11px;color:#777;margin-top:3px}',
    '.ss-rc .rcn{font-size:10.5px;color:#777;margin-top:6px;line-height:1.6}',
    '.ss-rc .rn{text-align:center;font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:#888;margin:16px 0 4px}',
    '.ss-rc .big{text-align:center;font:700 26px "Space Grotesk",sans-serif;margin:2px 0 18px}',
    '.ss-rc .r{display:flex;justify-content:space-between;gap:14px;padding:5px 0;font-size:12.5px}',
    '.ss-rc .r span{color:#888}.ss-rc .r b{font-weight:500;text-align:right}',
    '.ss-rc .rf{margin-top:16px;padding-top:12px;border-top:1px solid #e3e3e3;text-align:center;font-size:11px;color:#777}',
    '.ss-rc .rref{font-size:10px;color:#aaa;text-align:center;margin-top:8px;overflow-wrap:anywhere}',
    '.ss-rc .no{display:flex;gap:8px;justify-content:center;margin-top:18px}',
    '.ss-rc .ss-btn{color:#1a1a1a;background:#fff;border:1px solid #c9c9c9}.ss-rc .ss-btn.go{background:#2f9e63;border-color:#2f9e63;color:#fff}',
    '@page{margin:8mm}',
    '@media print{body *{visibility:hidden !important}.ss-rc-back,.ss-rc-back *{visibility:visible !important}.ss-rc-back{position:absolute;inset:0;background:#fff;padding:0;display:block;overflow:visible}.ss-rc{box-shadow:none;width:105mm;max-width:105mm;margin:0 auto;padding:6mm 7mm;border-radius:0}.ss-rc .no{display:none !important}}',
  ].join('\n');
  document.head.appendChild(css);
})();


(function () {
  if (document.getElementById('stpStyle')) return;
  const c = document.createElement('style'); c.id = 'stpStyle';
  c.textContent = [
    '.stp{max-width:1120px}',
    '.stp-nav{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px}',
    '.stp-back{font:inherit;font-size:13px;background:transparent;border:0;color:var(--muted);cursor:pointer;padding:0}.stp-back:hover{color:var(--ink)}',
    '.stp-step{display:flex;gap:8px;align-items:center;font-size:12.5px;color:var(--muted)}',
    '.stp-sb{font:inherit;font-size:12.5px;background:transparent;border:1px solid var(--line);color:var(--ink);border-radius:20px;padding:5px 12px;cursor:pointer}.stp-sb:disabled{opacity:.4;cursor:default}',
    '.stp-head{display:flex;gap:16px;align-items:center;flex-wrap:wrap;background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:18px 20px}',
    '.stp-id{flex:1;min-width:200px}.stp-id h1{font-family:"Space Grotesk",sans-serif;font-size:24px;font-weight:600;margin:0 0 6px;letter-spacing:-.01em}',
    '.stp-meta{display:flex;gap:7px;flex-wrap:wrap}',
    '.stp-chip{font-size:12px;border:1px solid var(--line);border-radius:20px;padding:3px 11px;color:var(--muted)}',
    '.stp-chip.mono{font-family:"IBM Plex Mono",monospace;color:var(--ink)}.stp-chip.ok{color:var(--matched);border-color:rgba(89,179,125,.5)}.stp-chip.warn{color:var(--cash);border-color:rgba(217,164,65,.5);text-transform:capitalize}',
    '.stp-acts{margin:0}',
    '.ss-row2{display:grid;grid-template-columns:1fr 1fr;gap:10px}@media(max-width:560px){.ss-row2{grid-template-columns:1fr}}',
    '.stp-formbox{margin-top:14px;max-width:560px}.stp-formbox .ss-form{margin:0}',
    '.stp-money{margin-top:14px;background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:16px 20px}',
    '.stp-mh{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:12px}',
    '.stp-k{font-size:11.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}.stp-term{font-size:13px;color:var(--ink)}',
    '.stp-sel{font:inherit;font-size:13px;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:20px;padding:5px 12px}',
    '.stp-tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}',
    '.stp-tile{background:var(--bg);border:1px solid var(--line);border-radius:13px;padding:12px 14px;min-width:0}',
    '.stp-tile span{display:block;font-size:11.5px;color:var(--muted)}',
    '.stp-tile b{display:block;margin-top:5px;font:500 18px "IBM Plex Mono",monospace;overflow-wrap:anywhere}',
    '.stp-tile.paid b{color:var(--matched)}',
    '.stp-tile.bal{border-width:1.5px}.stp-tile.bal b{font-size:20px;font-weight:600}',
    '.stp-tile.bal.due{border-color:rgba(226,87,76,.55)}.stp-tile.bal.due b{color:var(--alert)}',
    '.stp-tile.bal.ok{border-color:rgba(89,179,125,.55)}.stp-tile.bal.ok b{color:var(--matched)}',
    '.stp-tile.bal.cr{border-color:rgba(90,140,220,.55)}.stp-tile.bal.cr b{color:var(--bank)}',
    '.stp-eq{margin-top:12px;font:12.5px "IBM Plex Mono",monospace;color:var(--muted);overflow-wrap:anywhere}.stp-eq b{font-weight:600}',
    '.due{color:var(--alert)}.cr{color:var(--bank)}.stp-eq .ok,.am.ok{color:var(--matched)}',
    '.stp-cols{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(0,1fr);gap:16px;margin-top:16px;align-items:start}',
    '.stp-card{background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:16px 20px;margin-bottom:16px}',
    '.stp-ch{display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin-bottom:8px}',
    '.stp-ch h3{font-family:"Space Grotesk",sans-serif;font-size:15px;font-weight:600;margin:0}',
    '.stp-pay{display:flex;gap:12px;align-items:flex-start;padding:12px 0;border-bottom:1px solid var(--line)}.stp-pay:last-of-type{border-bottom:0}',
    '.stp-pay.gone{opacity:.62}.stp-pay.gone .am{text-decoration:line-through}',
    '.stp-pm{flex:0 0 74px;text-align:center;font-size:11.5px;font-weight:600;border-radius:9px;padding:6px 4px;border:1px solid var(--line);color:var(--muted)}',
    '.stp-pm.mp{color:var(--matched);border-color:rgba(89,179,125,.5);background:rgba(89,179,125,.08)}.stp-pm.bk{color:var(--bank);border-color:rgba(90,140,220,.5);background:rgba(90,140,220,.08)}',
    '.stp-pm.cs{color:var(--cash);border-color:rgba(217,164,65,.5);background:rgba(217,164,65,.08)}.stp-pm.ck{color:var(--sibling);border-color:rgba(160,110,210,.5);background:rgba(160,110,210,.08)}',
    '.stp-pb{flex:1;min-width:0;line-height:1.5}.stp-pb .am{font:600 15px "IBM Plex Mono",monospace}',
    '.stp-pact{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}.stp-pact .ss-btn{padding:6px 11px;font-size:12.5px}',
    '.stp-lrow{cursor:pointer}.stp-lrow:hover{background:var(--surface-raised)}',
    '.stp-h{padding:9px 0;border-bottom:1px solid var(--line);font-size:13px;line-height:1.5}.stp-h:last-child{border-bottom:0}',
    '@media(max-width:960px){.stp-cols{grid-template-columns:1fr}.stp-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}}',
    '@media(max-width:560px){.stp-pay{flex-wrap:wrap}.stp-pact{width:100%;justify-content:flex-start}}',
  ].join('\n');
  document.head.appendChild(c);
})();

const ssBase = function () { return '/schools/' + live.staff.school_id; };
const ssEl = function (id) { return document.getElementById(id); };
const ssMoney = function (n) { return money(Number(n) || 0); };
const ssVal = function (id) { const e = ssEl(id); return e ? e.value : ''; };
const ssDate = function (iso) { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); };
function ssToast(msg, bad) {
  const old = ssEl('ssToast'); if (old) old.remove();
  const d = document.createElement('div');
  d.id = 'ssToast'; d.className = 'ss-msg' + (bad ? '' : ' ok'); d.style.cssText = 'position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:90;max-width:90vw;background:var(--surface-raised)';
  d.textContent = msg; document.body.appendChild(d);
  setTimeout(function () { if (d.parentNode) d.remove(); }, 4200);
}
const ssIsAdmin = function () { return !(live.staff && live.staff.role === 'staff'); };   // the server enforces this too
const SS_REF = {
  cash: null,
  mpesa: ['M-Pesa code', 'Required. The 10 letters and numbers in the M-Pesa message, e.g. SJK4X9T2LM.'],
  bank: ['Bank slip or transaction number', 'Required. It stops the same payment being entered twice.'],
  cheque: ['Cheque number', 'Optional.'],
  other: ['Reference', 'Optional.'],
};
window.ssAdmInput = function (el) { const c = el.value.replace(/[^0-9\/\-]/g, ''); if (c !== el.value) el.value = c; };
function ssMethodChange() {
  const m = ssVal('ssMethod'), r = SS_REF[m], box = ssEl('ssRefBox'); if (!box) return;
  box.style.display = r ? 'block' : 'none';
  if (r) { ssEl('ssRefLabel').textContent = r[0]; ssEl('ssRefHint').textContent = r[1]; }
}
const ssUuid = function () { return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12); };

/* ---------------- open / close / load ---------------- */
function ssOpen(studentId) {
  if (!ss.open) { const a = document.querySelector('.nav.active'); ss.from = a && a.dataset.view ? a.dataset.view : 'roster'; ss.scroll = window.scrollY; }
  ss.rev = null; ss.open = true; ss.id = studentId; ss.data = null; ss.error = null; ss.mode = null; ss.err = null; ss.done = null; ss.busy = false; ss.reqId = null; ss.termId = null; ss.all = false;
  document.getElementById('main').innerHTML = '<div id="ssSheet" class="stp"></div>';
  document.querySelectorAll('.nav, .bnav-item').forEach(function (el) { el.classList.toggle('active', el.dataset.view === ss.from); });
  window.scrollTo(0, 0); ssRender(); ssLoad();
}
function ssClose() {
  const back = ss.from || 'roster', y = ss.scroll || 0;
  ss.open = false; ss.id = null; ss.mode = null;
  showView(back); setTimeout(function () { window.scrollTo(0, y); }, 600);
}
async function ssLoad() {
  const token = ++ss.token;
  try {
    const d = await Api.get(ssBase() + '/students/' + ss.id + '/sheet');
    if (token !== ss.token) return;
    ss.data = d; ss.error = null;
  } catch (e) { if (token !== ss.token) return; ss.error = e.message; ss.data = null; }
  ssRender();
}
function ssRefreshList() { /* the list is not on screen any more: it reloads when you go back */ }

// Previous / Next student in the list you came from (Students & balances), across its pages
async function ssStep(dir) {
  if (typeof bl === 'undefined' || !bl.data) return;
  let rows = bl.data.rows, i = rows.findIndex(function (r) { return r.id === ss.id; }), j = i + dir;
  try {
    if (j < 0) { if (bl.f.offset <= 0) return; bl.f.offset = Math.max(0, bl.f.offset - bl.f.limit); bl.data = await Api.get(blBase() + '/balances?' + blQuery()); j = bl.data.rows.length - 1; }
    else if (j >= rows.length) { if (bl.f.offset + bl.f.limit >= bl.data.total) return; bl.f.offset += bl.f.limit; bl.data = await Api.get(blBase() + '/balances?' + blQuery()); j = 0; }
    if (bl.data.rows[j]) ssOpen(bl.data.rows[j].id);
  } catch (e) { ssToast(e.message, true); }
}
function ssStepper() {
  if (ss.from !== 'roster' || typeof bl === 'undefined' || !bl.data) return '';
  const i = bl.data.rows.findIndex(function (r) { return r.id === ss.id; }); if (i < 0) return '';
  const pos = bl.f.offset + i + 1, total = bl.data.total;
  return '<div class="stp-step"><button type="button" class="stp-sb" onclick="ssStep(-1)"' + (pos <= 1 ? ' disabled' : '') + '>&lsaquo; Previous</button><span>' + pos + ' of ' + total + '</span>' +
    '<button type="button" class="stp-sb" onclick="ssStep(1)"' + (pos >= total ? ' disabled' : '') + '>Next &rsaquo;</button></div>';
}

/* ---------------- drawing ---------------- */
const SS_BACK = { roster: 'Students & balances', dashboard: 'Dashboard', reports: 'Reports', activity: 'Activity log', classes: 'Classes', payments: 'Payments', reviewqueue: 'Review queue' };
const ssBackLabel = function () { return SS_BACK[ss.from] || 'Back'; };
function ssTermView(d) {
  const cur = d.current_term;
  if (!ss.termId || (cur && ss.termId === cur.id)) return cur ? { label: cur.label, brought_forward: cur.brought_forward, fees_charged: cur.fees_charged, paid: cur.paid, balance: cur.balance, current: true } : null;
  const l = d.ledger.find(function (x) { return x.term_id === ss.termId; });
  return l ? { label: l.label, brought_forward: l.brought_forward, fees_charged: l.fees_charged, paid: l.paid, balance: l.balance, current: false } : null;
}
const ssWhen = function (iso) {
  const d = new Date(iso); if (isNaN(d)) return '';
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  return days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : days < 7 ? days + ' days ago' : ssDate(iso);
};
function ssRender() {
  const sh = ssEl('ssSheet'); if (!sh) return;
  const back = '<div class="stp-nav"><button type="button" class="stp-back" onclick="ssClose()">&larr; ' + esc(ssBackLabel()) + '</button>' + ssStepper() + '</div>';
  if (ss.error) { sh.innerHTML = back + '<div class="ss-msg">' + esc(ss.error) + '</div><div class="ss-foot"><button type="button" class="ss-btn" onclick="ssLoad()">Try again</button></div>'; return; }
  if (!ss.data) { sh.innerHTML = back + '<div class="stp-card" style="margin-top:14px;color:var(--muted)">Loading&hellip;</div>'; return; }
  const d = ss.data, s = d.student, c = d.current_term, left = s.status !== 'active';
  const v = ssTermView(d);

  const head = '<div class="stp-head"><div class="stp-av">' + (typeof shellLogo === 'function' ? shellLogo(58, { name: s.full_name }) : '') + '</div>' +
    '<div class="stp-id"><h1>' + esc(s.full_name) + '</h1><div class="stp-meta"><span class="stp-chip mono">' + esc(s.admission_no) + '</span><span class="stp-chip">' + esc(s.class || 'No class') + (s.stream ? ' &middot; ' + esc(s.stream) : '') + '</span>' +
    (left ? '<span class="stp-chip warn">' + esc(s.status) + '</span>' : '<span class="stp-chip ok">Active</span>') + '</div></div>' +
    '<div class="ss-acts stp-acts"><button type="button" class="ss-btn go" onclick="ssMode(\'pay\')"' + (c ? '' : ' disabled') + '>Record payment</button>' +
    '<button type="button" class="ss-btn" onclick="ssMode(\'edit\')">Edit details</button>' +
    (left ? '<button type="button" class="ss-btn" onclick="ssMode(\'back\')">Bring back</button>' : '<button type="button" class="ss-btn warn" onclick="ssMode(\'left\')">Mark as left</button>') + '</div></div>';

  let money = '<div class="stp-card"><div class="ss-msg ask" style="margin:0">No term has started for this school yet, so there is no balance.</div></div>';
  if (v) {
    const bal = v.balance, tone = bal > 0 ? 'due' : bal < 0 ? 'cr' : 'ok';
    const termSel = d.ledger.length > 1 || (c && ss.termId && ss.termId !== c.id)
      ? '<select class="stp-sel" aria-label="Term" onchange="ssTerm(this.value)">' + (c && !d.ledger.some(function (l) { return l.term_id === c.id; }) ? '<option value="' + c.id + '">' + esc(c.label) + '</option>' : '') +
        d.ledger.map(function (l) { return '<option value="' + l.term_id + '"' + ((ss.termId || (c && c.id)) === l.term_id ? ' selected' : '') + '>' + esc(l.label) + '</option>'; }).join('') + '</select>'
      : '<span class="stp-term">' + esc(v.label) + '</span>';
    money = '<div class="stp-money"><div class="stp-mh"><span class="stp-k">Money &middot; ' + (v.current ? 'this term' : 'earlier term') + '</span>' + termSel + '</div>' +
      '<div class="stp-tiles"><div class="stp-tile"><span>Brought forward</span><b>' + ssMoney(v.brought_forward) + '</b></div><div class="stp-tile"><span>Fees charged</span><b>' + ssMoney(v.fees_charged) + '</b></div>' +
      '<div class="stp-tile paid"><span>Paid</span><b>' + ssMoney(v.paid) + '</b></div><div class="stp-tile bal ' + tone + '"><span>' + (bal < 0 ? 'Credit' : bal === 0 ? 'Balance' : 'Balance due') + '</span><b>' + ssMoney(Math.abs(bal)) + '</b></div></div>' +
      '<div class="stp-eq"><span>' + ssMoney(v.brought_forward) + '</span> + <span>' + ssMoney(v.fees_charged) + '</span> &minus; <span>' + ssMoney(v.paid) + '</span> = <b class="' + tone + '">' + ssMoney(Math.abs(bal)) + (bal < 0 ? ' credit' : bal > 0 ? ' due' : '') + '</b></div></div>';
  }

  // payments: the last 5, "Show all" for the rest. Reversed ones stay in the list.
  const all = d.payments, shown = ss.all ? all : all.slice(0, 5);
  const kind = function (p) { return /M-Pesa/.test(p.channel) ? 'mp' : /Bank|KCB|Equity|Co-op/.test(p.channel) ? 'bk' : /Cash/.test(p.channel) ? 'cs' : /Cheque/.test(p.channel) ? 'ck' : 'ot'; };
  const rows = shown.map(function (p) {
    const gone = !!p.reversed;
    const buttons = gone ? '' : '<div class="stp-pact"><button type="button" class="ss-btn" onclick="ssReceipt(' + p.id + ')">Receipt</button>' +
      (p.can_reverse ? '<button type="button" class="ss-btn warn" onclick="ssAskReverse(' + p.id + ')">Reverse</button>' : '') + '</div>';
    const askRev = ss.rev && ss.rev.id === p.id ? '<div class="ss-form" style="margin:10px 0 0"><div class="ss-msg ask" style="margin-top:0">Reversing takes <b>' + ssMoney(p.amount) + '</b> off what the student has paid. The payment stays on record as reversed, with your name and the reason.</div>' +
      '<label for="ssRevReason">Why is it being reversed?</label><input class="ss-in" id="ssRevReason" maxlength="200" placeholder="e.g. typed 15000 instead of 1500">' +
      (ss.err ? '<div class="ss-msg" role="alert">' + esc(ss.err) + '</div>' : '') +
      '<div class="ss-foot"><button type="button" class="ss-btn warn" onclick="ssReverse()"' + (ss.busy ? ' disabled' : '') + '>' + (ss.busy ? 'Reversing...' : 'Reverse this payment') + '</button><button type="button" class="ss-btn" onclick="ssCancelReverse()">Cancel</button></div></div>' : '';
    return '<div class="stp-pay' + (gone ? ' gone' : '') + '"><span class="stp-pm ' + kind(p) + '">' + esc(p.channel) + '</span>' +
      '<div class="stp-pb"><div><b class="am">' + ssMoney(p.amount) + '</b> <span class="ss-small">' + esc(ssDate(p.received_at)) + (p.term ? ' &middot; ' + esc(p.term) : '') + '</span></div>' +
      '<div class="ss-small">' + esc(p.receipt_no) + (p.reference ? ' &middot; ' + esc(p.reference) : '') + (p.payer_name ? ' &middot; from ' + esc(p.payer_name) : '') + (p.added_by ? ' &middot; entered by ' + esc(p.added_by) : '') + '</div>' +
      (gone ? '<div class="ss-small" style="color:var(--alert)">Reversed' + (p.reversed.by ? ' by ' + esc(p.reversed.by) : '') + ' on ' + esc(ssDate(p.reversed.at)) + ': ' + esc(p.reversed.reason) + '</div>' : '') + askRev + '</div>' + buttons + '</div>';
  }).join('');
  const total = all.filter(function (p) { return !p.reversed; }).reduce(function (a, p) { return a + p.amount; }, 0);
  const pays = '<div class="stp-card"><div class="stp-ch"><h3>' + (ss.all ? 'All payments' : 'Recent payments') + '</h3><span class="ss-small">' + all.length + ' in all &middot; ' + ssMoney(total) + ' received</span></div>' +
    (rows || '<div class="ss-small" style="padding:8px 0">No payments yet.</div>') +
    (all.length > 5 ? '<div style="text-align:center;margin-top:10px"><button type="button" class="ss-btn" onclick="ssAll()">' + (ss.all ? 'Show only the last 5' : 'Show all ' + all.length) + '</button></div>' : '') + '</div>';

  const fees = d.fees ? '<div class="stp-card"><div class="stp-ch"><h3>Fees for ' + esc(d.fees.term) + '</h3></div>' +
    d.fees.mandatory.map(function (f) { return '<div class="ss-li"><span>' + esc(f.name) + '</span><span class="am">' + ssMoney(f.amount) + '</span></div>'; }).join('') +
    d.fees.optional.map(function (f) { return '<div class="ss-li"><span>' + esc(f.name) + ' <span class="ss-small">optional</span></span><span class="am">' + ssMoney(f.amount) + '</span></div>'; }).join('') +
    '<div class="ss-li total"><span>Fees this term</span><span class="am">' + ssMoney(d.fees.total) + '</span></div></div>' : '';
  const ledger = d.ledger.length > 1 ? '<div class="stp-card"><div class="stp-ch"><h3>Money by term</h3></div>' + d.ledger.map(function (l) {
    return '<div class="ss-li stp-lrow" onclick="ssTerm(' + l.term_id + ')" title="Show this term"><span>' + esc(l.label) + '<div class="ss-small">b/f ' + ssMoney(l.brought_forward) + ' &middot; fees ' + ssMoney(l.fees_charged) + ' &middot; paid ' + ssMoney(l.paid) + '</div></span><span class="am ' + (l.balance > 0 ? 'due' : l.balance < 0 ? 'cr' : 'ok') + '">' + (l.balance === 0 ? 'Paid up' : ssMoney(Math.abs(l.balance)) + (l.balance < 0 ? ' credit' : ' due')) + '</span></div>';
  }).join('') + '</div>' : '';
  const contacts = '<div class="stp-card"><div class="stp-ch"><h3>Contacts</h3></div>' + (d.contacts.length ? d.contacts.map(function (k) {
    return '<div class="ss-li"><span>' + esc(k.name || '-') + (k.relationship ? ' <span class="ss-small">' + esc(k.relationship) + '</span>' : '') + '</span><span class="am">' + esc(k.phone || '') + '</span></div>';
  }).join('') : '<div class="ss-small">No contacts saved.</div>') +
    (d.optional_fees.length ? '<div class="ss-small" style="margin-top:10px">Optional fees chosen: ' + d.optional_fees.map(esc).join(', ') + '</div>' : '') + '</div>';
  const hist = d.history && d.history.length ? '<div class="stp-card"><div class="stp-ch"><h3>What changed</h3></div>' + d.history.map(function (h) {
    return '<div class="stp-h"><div>' + esc(h.who) + ' ' + esc(h.text) + '</div>' + (h.extra ? '<div class="ss-small">' + esc(h.extra) + '</div>' : '') + '<div class="ss-small">' + esc(ssWhen(h.when)) + '</div></div>';
  }).join('') + '</div>' : '';

  sh.innerHTML = back + head + ssFormBox() + money + '<div class="stp-cols"><div class="stp-col">' + pays + '</div><div class="stp-col">' + fees + ledger + contacts + hist + '</div></div>';
}
window.ssAll = function () { ss.all = !ss.all; ssRender(); };
window.ssTerm = function (id) { ss.termId = Number(id); ssRender(); window.scrollTo(0, 0); };
function ssFormBox() { const f = ssForm(); return f ? '<div class="stp-formbox">' + f + '</div>' : ''; }

function ssMode(m) { ss.mode = ss.mode === m ? null : m; ss.err = null; ss.done = null; if (m === 'pay') ss.reqId = ssUuid(); ssRender(); const f = ssEl('ssAmount'); if (f) f.focus(); }

function ssForm() {
  if (!ss.mode && !ss.done) return '';
  const e = ss.err ? '<div class="ss-msg" role="alert">' + esc(ss.err) + '</div>' : '';
  if (ss.done) return '<div class="ss-msg ok" role="status">' + ss.done.text + (ss.done.txn ? '<div class="ss-foot"><button type="button" class="ss-btn go" onclick="ssReceipt(' + ss.done.txn + ')">Print receipt</button></div>' : '') + '</div>';
  if (ss.mode === 'pay') {
    const ms = ss.data.methods || [{ value: 'cash', label: 'Cash' }, { value: 'mpesa', label: 'M-Pesa' }, { value: 'bank', label: 'Bank' }, { value: 'cheque', label: 'Cheque' }, { value: 'other', label: 'Other' }];
    return '<div class="ss-form"><label for="ssAmount">Amount (KES)</label><input class="ss-in" id="ssAmount" inputmode="decimal" placeholder="e.g. 15000" autocomplete="off">' +
      '<div class="ss-row2"><div><label for="ssMethod">Paid by</label><select class="ss-in" id="ssMethod" onchange="ssMethodChange()">' + ms.map(function (m) { return '<option value="' + m.value + '">' + esc(m.label) + '</option>'; }).join('') + '</select></div>' +
      '<div><label for="ssOn">Date paid <span class="ss-small">(blank = today)</span></label><input class="ss-in" id="ssOn" type="date"></div></div>' +
      '<div id="ssRefBox" style="display:none"><label for="ssRef" id="ssRefLabel">Reference</label><input class="ss-in" id="ssRef" maxlength="60" autocomplete="off"><div class="ss-small" id="ssRefHint" style="margin-top:4px"></div></div>' +
      '<label for="ssPayer">Paid by (name)</label><input class="ss-in" id="ssPayer" maxlength="100" placeholder="the parent or guardian">' +
      '<label for="ssNote">Note</label><input class="ss-in" id="ssNote" maxlength="200">' + e +
      '<div class="ss-foot"><button type="button" class="ss-btn go" id="ssSubmit" onclick="ssPay()"' + (ss.busy ? ' disabled' : '') + '>' + (ss.busy ? 'Saving...' : 'Record payment') + '</button><button type="button" class="ss-btn" onclick="ssMode(null)">Cancel</button></div>' +
      '<div class="ss-small" style="margin-top:10px">It is added to this term\'s balance and your name is saved with it.</div></div>';
  }
  if (ss.mode === 'edit') {
    const d = ss.data, rows = d.contacts.length ? d.contacts : [{ name: '', phone: '', relationship: '' }];
    return '<div class="ss-form"><label for="ssName">Full name</label><input class="ss-in" id="ssName" maxlength="100" value="' + esc(d.student.full_name) + '">' +
      '<label for="ssAdm">Admission number</label><input class="ss-in" id="ssAdm" maxlength="40" oninput="ssAdmInput(this)" value="' + esc(d.student.admission_no) + '"' + (ssIsAdmin() ? '' : ' disabled') + '>' +
      '<div class="ss-small" style="margin-top:4px">' + (ssIsAdmin() ? 'Digits, / and - only. Fix a typing mistake here. Parents paying by M-Pesa must then use the new number. Payments already received stay with this student.' : 'Only an Admin can correct the admission number.') + '</div>' +
      '<label>Contacts <span class="ss-small">(the first one is the main guardian)</span></label><div id="ssContacts">' + rows.map(ssContactRow).join('') + '</div>' +
      '<button type="button" class="ss-btn" style="font-size:12.5px;padding:6px 12px" onclick="ssAddContact()">+ Add a contact</button>' +
      e +
      '<div class="ss-foot"><button type="button" class="ss-btn go" onclick="ssSaveDetails()"' + (ss.busy ? ' disabled' : '') + '>' + (ss.busy ? 'Saving...' : 'Save details') + '</button><button type="button" class="ss-btn" onclick="ssMode(null)">Cancel</button></div></div>';
  }
  if (ss.mode === 'left' || ss.mode === 'back') {
    const c = ss.data.current_term, owing = c && c.balance > 0;
    const warn = ss.mode === 'left' ? '<div class="ss-msg ask">' + (owing ? esc(ss.data.student.full_name) + ' still owes <b>' + ssMoney(c.balance) + '</b>. The debt stays on the record and payments can still be added. ' : '') + 'The student is not billed again. All history is kept.</div>'
      : '<div class="ss-msg ask">The student becomes active again. If the class was already billed this term, they are charged for it now.</div>';
    return '<div class="ss-form">' + warn + (ss.mode === 'left' ? '<label for="ssReason">Reason <span class="ss-small">(optional)</span></label><input class="ss-in" id="ssReason" maxlength="200" placeholder="e.g. transferred to another school">' : '') + e +
      '<div class="ss-foot"><button type="button" class="ss-btn ' + (ss.mode === 'left' ? 'warn' : 'go') + '" onclick="ssStatus(\'' + (ss.mode === 'left' ? 'left' : 'active') + '\')"' + (ss.busy ? ' disabled' : '') + '>' + (ss.mode === 'left' ? 'Mark as left' : 'Bring back') + '</button><button type="button" class="ss-btn" onclick="ssMode(null)">Cancel</button></div></div>';
  }
  return '';
}
function ssContactRow(k) {
  return '<div class="ss-crow"><input class="ss-in ssC-name" placeholder="Name" maxlength="100" value="' + esc(k.name || '') + '"><input class="ss-in ssC-phone" placeholder="Phone" inputmode="tel" value="' + esc(k.phone || '') + '"><input class="ss-in ssC-rel" placeholder="Mother, Father..." maxlength="30" value="' + esc(k.relationship || '') + '"></div>';
}
function ssAddContact() { const b = ssEl('ssContacts'); if (b && b.children.length < 10) b.insertAdjacentHTML('beforeend', ssContactRow({})); }

/* ---------------- actions ---------------- */
async function ssRun(path, body, onDone) {
  if (ss.busy) return;
  ss.busy = true; ss.err = null; ssRender2();
  try { const r = await Api.post(ssBase() + path, body); ss.busy = false; await onDone(r); }
  catch (e) { ss.busy = false; ss.err = e.message; ssRender2(); }
}
// redraw but keep what was typed in the open form
function ssRender2() {
  const keep = {}; ['ssAmount', 'ssMethod', 'ssOn', 'ssRef', 'ssPayer', 'ssNote', 'ssName', 'ssAdm', 'ssReason', 'ssRevReason'].forEach(function (id) { const e = ssEl(id); if (e) keep[id] = e.value; });
  const cons = [...document.querySelectorAll('#ssContacts .ss-crow')].map(function (r) { return { name: r.querySelector('.ssC-name').value, phone: r.querySelector('.ssC-phone').value, relationship: r.querySelector('.ssC-rel').value }; });
  const top = window.scrollY;
  ssRender();
  Object.keys(keep).forEach(function (id) { const e = ssEl(id); if (e) e.value = keep[id]; });
  if (typeof ssMethodChange === 'function') ssMethodChange();
  if (cons.length && ssEl('ssContacts')) ssEl('ssContacts').innerHTML = cons.map(ssContactRow).join('');
  window.scrollTo(0, top);
}
function ssPay() {
  const body = { amount: ssVal('ssAmount'), method: ssVal('ssMethod'), reference: ssVal('ssRef'), note: ssVal('ssNote'), payer_name: ssVal('ssPayer'), request_id: ss.reqId };
  if (ssVal('ssOn')) body.received_on = ssVal('ssOn');
  ssRun('/students/' + ss.id + '/payments', body, async function (r) {
    ss.mode = null; ss.reqId = null;
    ss.done = { text: 'Recorded <b>' + ssMoney(r.amount) + '</b> (' + esc(r.method) + '). Balance for ' + esc(r.term) + ' is now <b>' + ssMoney(r.balance_after) + '</b>.', txn: r.transaction_id };
    await ssLoad(); ssRefreshList();
    ssReceipt(r.transaction_id);                  // the receipt opens by itself, ready to print
  });
}
function ssSaveDetails() {
  const contacts = [...document.querySelectorAll('#ssContacts .ss-crow')].map(function (r) {
    return { name: r.querySelector('.ssC-name').value, phone: r.querySelector('.ssC-phone').value, relationship: r.querySelector('.ssC-rel').value };
  });
  const body = { full_name: ssVal('ssName'), contacts: contacts };
  if (ssIsAdmin() && ssVal('ssAdm').trim() !== ss.data.student.admission_no) body.admission_no = ssVal('ssAdm');
  ssRun('/students/' + ss.id + '/details', body, async function (r) {
    ss.mode = null; ssToast(r.unchanged ? 'Nothing changed.' : 'Details saved.');
    await ssLoad(); ssRefreshList();
  });
}
function ssStatus(status) {
  ssRun('/students/' + ss.id + '/status', { status: status, reason: ssVal('ssReason') }, async function (r) {
    ss.mode = null; ssToast(r.unchanged ? 'Nothing changed.' : (status === 'left' ? 'Marked as left.' : 'Brought back.'));
    await ssLoad(); ssRefreshList();
  });
}

function ssAskReverse(id) { ss.rev = { id: id }; ss.err = null; ssRender(); const f = ssEl('ssRevReason'); if (f) f.focus(); }
function ssCancelReverse() { ss.rev = null; ss.err = null; ssRender(); }
function ssReverse() {
  if (!ss.rev || ss.busy) return;
  const id = ss.rev.id, reason = ssVal('ssRevReason');
  ss.busy = true; ss.err = null; ssRender2();
  Api.post(ssBase() + '/payments/' + id + '/reverse', { reason: reason }).then(async function (r) {
    ss.busy = false; ss.rev = null;
    ss.done = { text: 'Reversed <b>' + ssMoney(r.amount) + '</b>. Balance for ' + esc(r.term) + ' is now <b>' + ssMoney(r.balance_after) + '</b>.', txn: null };
    await ssLoad(); ssRefreshList();
  }).catch(function (e) { ss.busy = false; ss.err = e.message; ssRender2(); });
}

/* ---------------- receipt ---------------- */
// small letterhead for a receipt: logo, school name, motto, then the phone number(s) and address on one quiet line
function ssLetterhead(name) {
  const sc = (typeof live !== 'undefined' && live.school) || {};
  const phones = [sc.phone, sc.phone2].filter(Boolean).map(esc).join(' / ');
  const place = [sc.address, sc.county].filter(Boolean).map(esc).join(', ');
  const contact = [phones && 'Tel ' + phones, place].filter(Boolean).join('<br>');
  return '<div class="rt">' + (typeof shellLogo === 'function' ? '<div style="display:flex;justify-content:center;margin-bottom:8px">' + shellLogo(40, sc.name ? sc : { name: name }) + '</div>' : '') +
    '<h3>' + esc(name) + '</h3>' + (sc.motto ? '<div class="rm">' + esc(sc.motto) + '</div>' : '') + (contact ? '<div class="rcn">' + contact + '</div>' : '') + '</div>';
}
async function ssReceipt(txnId) {
  try {
    const r = await Api.get(ssBase() + '/payments/' + txnId + '/receipt');
    if (!live.school && typeof shellSchool === 'function') await shellSchool();
    const old = ssEl('ssRcBack'); if (old) old.remove();
    const row = function (a, b) { return b == null || b === '' ? '' : '<div class="r"><span>' + a + '</span><b>' + esc(b) + '</b></div>'; };
    const w = document.createElement('div'); w.id = 'ssRcBack'; w.className = 'ss-rc-back';
    w.onclick = function (ev) { if (ev.target === w) w.remove(); };
    const foot = (typeof live !== 'undefined' && live.school && live.school.receipt_footer) ? '<div class="rf">' + esc(live.school.receipt_footer) + '</div>' : '';
    w.innerHTML = '<div class="ss-rc" role="dialog" aria-label="Receipt">' + ssLetterhead(r.school) + '<div class="rn">Receipt ' + esc(r.receipt_no) + '</div>' +
      '<div class="big">' + esc(ssMoney(r.amount)) + '</div>' +
      row('Date', ssDate(r.received_at)) + row('Student', r.student.full_name) + row('Admission no.', r.student.admission_no) +
      row('Class', (r.student.class || '') + (r.student.stream ? ' ' + r.student.stream : '')) + row('Paid by', r.channel) + row('Term', r.term) +
      (r.balance_after == null ? '' : row(r.balance_after < 0 ? 'Credit now' : 'Balance now', ssMoney(Math.abs(r.balance_after)))) + row('Received by', r.entered_by) +
      (r.reference ? '<div class="rref">Ref ' + esc(r.reference) + '</div>' : '') + foot +
      '<div class="no"><button type="button" class="ss-btn go" onclick="window.print()">Print</button><button type="button" class="ss-btn" onclick="document.getElementById(\'ssRcBack\').remove()">Close</button></div></div>';
    document.body.appendChild(w);
  } catch (e) { ssToast(e.message, true); }
}