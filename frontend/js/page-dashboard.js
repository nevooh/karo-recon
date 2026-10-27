/* page-dashboard.js - the Dashboard. Replaces the old one in live.js (load AFTER live.js, page-payments.js).
   Built for the bursar: what needs attention first, then how the term is going, recent payments and who owes most.
   Any staff member can see it. Read only. Data: GET /schools/:id/dashboard */
const dbd = { data: null, error: null, loadToken: 0 };

(function () {
  if (document.getElementById('dbdStyle')) return;
  const css = document.createElement('style');
  css.id = 'dbdStyle';
  css.textContent = [
    '.dbd-card{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:18px 20px;min-width:0}',
    '.dbd-card h2{font-family:"Space Grotesk",sans-serif;font-size:16px;font-weight:600;margin:0 0 12px;display:flex;justify-content:space-between;align-items:baseline;gap:10px}',
    '.dbd-link{font:inherit;font-size:12.5px;font-weight:500;color:var(--muted);background:none;border:0;cursor:pointer;padding:0}',
    '.dbd-link:hover{color:var(--matched)}',
    '.dbd-att{margin:0 0 16px}',
    '.dbd-att.warn{border-color:rgba(217,164,65,.5);background:rgba(217,164,65,.07)}',
    '.dbd-att.ok{border-color:rgba(89,179,125,.4)}',
    '.dbd-big{font-family:"Space Grotesk",sans-serif;font-size:19px;font-weight:600;margin:0 0 4px}',
    '.dbd-sub{font-size:13px;color:var(--muted);line-height:1.55}',
    '.dbd-chips{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0 12px}',
    '.dbd-chip{font-size:12.5px;border:1px solid var(--line);border-radius:20px;padding:5px 12px}',
    '.dbd-wrow{display:flex;gap:12px;align-items:center;padding:9px 0;border-top:1px solid var(--line);font-size:13.5px}',
    '.dbd-wrow .who{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.dbd-wrow small{display:block;color:var(--muted);font-size:12px;overflow:hidden;text-overflow:ellipsis}',
    '.dbd-amt{font-family:"IBM Plex Mono",monospace;font-weight:600;white-space:nowrap}',
    '.dbd-btn{font:inherit;font-size:13.5px;font-weight:600;border-radius:10px;padding:9px 16px;cursor:pointer;border:1px solid var(--matched);background:var(--matched);color:#0E1613}',
    '.dbd-nudge{display:flex;gap:14px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin:0 0 12px;padding:13px 16px;border:1px solid var(--line);border-radius:12px;background:var(--surface);font-size:13.5px;line-height:1.5}',
    '.dbd-nudge .dbd-btn{background:transparent;color:var(--ink);border-color:var(--line)}',
    '.dbd-nudge .dbd-btn:hover{border-color:var(--matched)}',
    '.dbd-tiles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:0 0 12px}',
    '.dbd-tile{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:14px 16px;min-width:0}',
    '.dbd-tile span{display:block;font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted)}',
    '.dbd-tile b{display:block;margin-top:5px;font-family:"IBM Plex Mono",monospace;font-size:19px;font-weight:600;overflow-wrap:anywhere}',
    '.dbd-tile.good b{color:var(--matched)} .dbd-tile.warn b{color:var(--alert)}',
    '.dbd-prog{margin:0 0 16px;background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:14px 16px}',
    '.dbd-bar{height:10px;border-radius:6px;background:var(--surface-raised);overflow:hidden;margin:8px 0 6px}',
    '.dbd-bar i{display:block;height:100%;background:var(--matched);border-radius:6px}',
    '.dbd-prog .row{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;font-size:12.5px;color:var(--muted)}',
    '.dbd-prog .row b{color:var(--ink)}',
    '.dbd-two{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr);gap:16px;align-items:start}',
    '.dbd-st{font:inherit;color:var(--ink);background:none;border:0;padding:0;cursor:pointer;text-align:left}',
    '.dbd-st:hover{color:var(--matched)}',
    '.dbd-empty{font-size:13px;color:var(--muted);padding:6px 0}',
    '@media(max-width:900px){.dbd-two{grid-template-columns:1fr}.dbd-tiles{grid-template-columns:1fr}}',
  ].join('\n');
  document.head.appendChild(css);
})();

const dbdEl = function (id) { return document.getElementById(id); };
const dbdMethod = { cash: 'Cash', mpesa: 'M-Pesa', bank: 'Bank', cheque: 'Cheque', other: 'Other' };

views.dashboard = function () {
  dbd.data = null; dbd.error = null;
  setTimeout(dbdLoad, 0);
  return '<div id="dbdRoot">' + dbdBody() + '</div>';
};

async function dbdLoad() {
  if (!dbdEl('dbdRoot') || !live.staff) return;
  const token = ++dbd.loadToken;
  try { const d = await Api.get('/schools/' + live.staff.school_id + '/dashboard'); if (token !== dbd.loadToken) return; dbd.data = d; dbd.error = null; }
  catch (e) { if (token !== dbd.loadToken) return; dbd.error = e.message; }
  const r = dbdEl('dbdRoot'); if (r) r.innerHTML = dbdBody();
}
window.dbdLoad = dbdLoad;

function dbdAgo(iso) {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return m + (m === 1 ? ' minute ago' : ' minutes ago');
  const h = Math.round(m / 60); if (h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago');
  const dd = Math.round(h / 24); return dd + (dd === 1 ? ' day ago' : ' days ago');
}
function dbdChan(t) { return t.source === 'manual' ? (dbdMethod[t.method] || 'By hand') : ({ mpesa: 'M-Pesa', equity: 'Equity', kcb: 'KCB', coop: 'Co-op' }[t.source] || t.source); }
function dbdStu(id, name, adm) { return id && name ? '<button type="button" class="dbd-st" onclick="ssOpen(' + id + ')">' + esc(name) + '</button> <span class="adm">' + esc(adm) + '</span>' : '<span class="pm-muted">Unknown payer</span>'; }

function dbdBody() {
  const first = esc(String(live.staff.full_name || '').split(' ')[0]);
  const head = function (sub) { return '<div class="topbar"><div><h1>Dashboard</h1><p class="sub">' + sub + '</p></div></div>'; };
  if (dbd.error) return head('Hello ' + first) + '<div class="dbd-card"><b>Could not load the dashboard</b><div class="dbd-sub">' + esc(dbd.error) + '</div><br><button type="button" class="dbd-btn" onclick="dbdLoad()">Try again</button></div>';
  const d = dbd.data;
  if (!d) return head('Hello ' + first) + '<div class="dbd-card dbd-sub">Loading&hellip;</div>';

  const w = d.waiting, pending = w.review + w.unmatched;
  let att;
  if (pending) {
    att = '<div class="dbd-card dbd-att warn"><h2>Needs your attention<button type="button" class="dbd-link" onclick="showView(\'reviewqueue\')">Open review queue &rarr;</button></h2>' +
      '<div class="dbd-chips">' + (w.review ? '<span class="dbd-chip">' + w.review + ' to review &middot; ' + money(w.review_total) + '</span>' : '') +
      (w.unmatched ? '<span class="dbd-chip">' + w.unmatched + ' unmatched &middot; ' + money(w.unmatched_total) + '</span>' : '') + '</div>' +
      w.rows.map(function (t) {
        return '<div class="dbd-wrow"><div class="who">' + esc(t.payer_name || 'Unknown payer') + '<small>' + dbdChan(t) + ' &middot; ' + esc(t.narration || t.match_reason || 'no reference') + '</small></div>' +
          '<div class="dbd-amt">' + money(t.amount) + '</div></div>';
      }).join('') +
      (pending > w.rows.length ? '<div class="dbd-sub" style="margin-top:8px">and ' + (pending - w.rows.length) + ' more in the review queue.</div>' : '') + '</div>';
  } else {
    const lp = d.last_payment;
    att = '<div class="dbd-card dbd-att ok"><div class="dbd-big">All caught up</div><div class="dbd-sub">' +
      (lp ? 'Nothing is waiting for a decision. Last payment came in ' + dbdAgo(lp.received_at) + ': ' + money(lp.amount) + ' by ' + esc(dbdChan(lp)) + (lp.student_name ? ' for ' + esc(lp.student_name) : '') + '.'
          : 'Nothing is waiting for a decision. Payments will show up here as soon as they come in.') + '</div></div>';
  }
  const nudges = d.nudges.map(function (n) {
    return '<div class="dbd-nudge"><span>' + esc(n.text) + '</span><button type="button" class="dbd-btn" onclick="showView(\'' + n.go + '\')">' + esc(n.button) + '</button></div>';
  }).join('');

  const m = d.money;
  const tiles = '<div class="dbd-tiles"><div class="dbd-tile good"><span>Collected this term</span><b>' + money(m.paid) + '</b></div>' +
    '<div class="dbd-tile"><span>Billed this term</span><b>' + money(m.billed) + '</b></div>' +
    '<div class="dbd-tile warn"><span>Still owed</span><b>' + money(m.outstanding) + '</b></div></div>' +
    '<div class="dbd-prog"><div class="row"><span><b>' + m.percent + '%</b> of fees collected' + (d.term ? ' &middot; ' + esc(d.term.label) : '') + '</span>' +
    '<span>Today <b>' + money(d.collected.today) + '</b> &middot; Last 7 days <b>' + money(d.collected.week) + '</b></span></div>' +
    '<div class="dbd-bar"><i style="width:' + m.percent + '%"></i></div></div>';

  const recent = d.recent.length ? d.recent.map(function (t) {
    return '<div class="dbd-wrow"><div class="who">' + dbdStu(t.student_id, t.student_name, t.admission_no) + '<small>' + dbdChan(t) + ' &middot; ' + dbdAgo(t.received_at) + '</small></div><div class="dbd-amt">' + money(t.amount) + '</div></div>';
  }).join('') : '<div class="dbd-empty">No payments yet.</div>';
  const debtors = d.debtors.length ? d.debtors.map(function (s) {
    return '<div class="dbd-wrow"><div class="who">' + dbdStu(s.id, s.full_name, s.admission_no) + '<small>' + esc(s.class || '') + (s.stream ? ' ' + esc(s.stream) : '') + '</small></div><div class="dbd-amt">' + money(s.balance) + '</div></div>';
  }).join('') : '<div class="dbd-empty">Nobody owes anything right now.</div>';

  return head('Hello ' + first + (d.term ? ' &middot; ' + esc(d.term.label) : '')) + att + nudges + tiles +
    '<div class="dbd-two"><div class="dbd-card"><h2>Recent payments<button type="button" class="dbd-link" onclick="showView(\'payments\')">See all &rarr;</button></h2>' + recent + '</div>' +
    '<div class="dbd-card"><h2>Who owes most<button type="button" class="dbd-link" onclick="showView(\'roster\')">All balances &rarr;</button></h2>' + debtors + '</div></div>';
}