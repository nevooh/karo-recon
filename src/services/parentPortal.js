/**
 * The parent portal's rules in ONE place. A parent is a PHONE NUMBER: they see the students (in school now) that have
 * that number as a contact, in any school, and nothing else. Every function takes the signed-in phone and refuses
 * (404, "No such student") any student that phone is not a contact of, so a parent can never read or pay for a child
 * they were not given.
 *
 *   listChildren   the kids picker: each child with this term's money
 *   getHome        one child: balance, last 3 payments, how they can pay
 *   getFees        one child: this term's fee lines + term by term
 *   getPayments    one child: every payment
 *   getReceipt     one payment, printable (no staff names, no staff notes)
 *   startPayment   asks the parent's phone for the M-Pesa PIN (services/stkPush.js does the checks)
 *   getPaymentStatus  what the portal polls while the parent types the PIN
 *
 * READ ONLY apart from startPayment, which only creates a push request. Money is added by the callback
 * (services/stkCallback.js) or the normal Paybill alert, never here.
 */
const { pool } = require('../db/db');
const { getCurrentTerm } = require('./feeLedger');
const { startedTerms } = require('./balances');
const { getSelected } = require('./channels');
const { getReceipt: getSheetReceipt, METHODS } = require('./studentSheet');
const { createPush, getPushStatus, cancelPush, MAX_AMOUNT } = require('./stkPush');
const { refreshIfStale } = require('./stkCallback');
const { assertCallbackUrlAllowed } = require('../connectors/mpesa');

const IN_SCHOOL = ['active', 'repeating'];
const BANK_NAMES = { kcb: 'KCB', equity: 'Equity Bank', coop: 'Co-operative Bank' };
const num = (v) => Number(v) || 0;
const money2 = (v) => Math.round(Number(v) * 100) / 100;
function refuse(message, status = 400) { const e = new Error(message); e.status = status; return e; }

// Phones are stored as people typed them, so compare the last 9 digits (0712 345 678 = +254712345678). Param $1 = those 9 digits.
const LINKED = `(right(regexp_replace(s.guardian_phone, '\\D', '', 'g'), 9) = $1
  OR EXISTS (SELECT 1 FROM student_contacts c WHERE c.student_id = s.id AND right(regexp_replace(c.phone, '\\D', '', 'g'), 9) = $1))`;
const last9 = (msisdn) => String(msisdn).slice(-9);

async function phoneHasChildren(msisdn, deps = {}) {
  const db = deps.pool || pool;
  const r = await db.query(`SELECT 1 FROM students s WHERE s.status = ANY($2) AND ${LINKED} LIMIT 1`, [last9(msisdn), IN_SCHOOL]);
  return r.rows.length > 0;
}

const CHILD_SQL = `SELECT s.id, s.school_id, s.admission_no, s.full_name, s.status, s.class_id, c.name AS class, st.name AS stream, sc.name AS school_name, sc.phone AS school_phone
  FROM students s JOIN schools sc ON sc.id = s.school_id LEFT JOIN classes c ON c.id = s.class_id LEFT JOIN streams st ON st.id = s.stream_id
  WHERE s.status = ANY($2) AND ${LINKED}`;

// the one student, only if this phone is a contact of them
async function ownChild(db, msisdn, studentId) {
  const id = Number(studentId);
  if (!Number.isInteger(id)) throw refuse('No such student.', 404);
  const r = await db.query(CHILD_SQL + ' AND s.id = $3', [last9(msisdn), IN_SCHOOL, id]);
  if (!r.rows[0]) throw refuse('No such student.', 404);
  return r.rows[0];
}

async function currentTermOf(db, schoolId, cache = new Map()) {
  if (!cache.has(schoolId)) {
    const cur = await getCurrentTerm(schoolId, db);
    let value = null;
    if (cur) {
      const t = (await startedTerms(db, schoolId)).find((x) => x.id === cur.id);
      value = { id: cur.id, label: t ? t.label : 'Term ' + cur.term_number };
    }
    cache.set(schoolId, value);
  }
  return cache.get(schoolId);
}

function stateOf(opening, charged, balance) {
  if (balance > 0) return 'owing';
  if (balance < 0) return 'overpaid';
  return opening + charged > 0 ? 'cleared' : 'not_billed';
}

async function summarize(db, s, termCache) {
  const term = await currentTermOf(db, s.school_id, termCache);
  let opening = 0, charged = 0, paid = 0;
  if (term) {
    const l = (await db.query('SELECT opening_balance, fees_charged, amount_paid FROM student_term_ledger WHERE student_id = $1 AND term_id = $2', [s.id, term.id])).rows[0];
    if (l) { opening = num(l.opening_balance); charged = num(l.fees_charged); paid = num(l.amount_paid); }
  }
  const balance = money2(opening + charged - paid);
  return {
    id: s.id, name: s.full_name, first_name: String(s.full_name).trim().split(/\s+/)[0], admission_no: s.admission_no,
    class: [s.class, s.stream].filter(Boolean).join(' ') || null, school: { id: s.school_id, name: s.school_name },
    term: term ? term.label : null, brought_forward: opening, fees_charged: charged, paid, due: money2(opening + charged), balance, state: stateOf(opening, charged, balance),
  };
}

async function listChildren(msisdn, deps = {}) {
  const db = deps.pool || pool;
  const rows = (await db.query(CHILD_SQL + ' ORDER BY sc.name, s.full_name, s.id', [last9(msisdn), IN_SCHOOL])).rows;
  const cache = new Map();
  const children = [];
  for (const s of rows) children.push(await summarize(db, s, cache));
  // The name the school has for this phone ("Mary Wanjiku"), for the greeting. Not required: the portal works without it.
  const nm = (await db.query(
    `SELECT c.full_name FROM student_contacts c JOIN students s ON s.id = c.student_id
     WHERE c.full_name IS NOT NULL AND right(regexp_replace(c.phone, '\\D', '', 'g'), 9) = $1 AND s.status = ANY($2) ORDER BY c.id LIMIT 1`, [last9(msisdn), IN_SCHOOL])).rows[0];
  return { phone: msisdn, name: nm ? nm.full_name : null, children };
}

/* ---------------------------- payments ---------------------------- */
function describePayment(t) {
  if (t.source === 'manual') {
    const m = t.method || 'other';
    return { channel: METHODS[m] === 'Bank deposit slip' ? 'Bank' : (METHODS[m] || 'Other'), kind: m === 'mpesa' ? 'mpesa' : (m === 'cash' || m === 'other' ? 'cash' : 'bank') };
  }
  if (t.source === 'mpesa') return { channel: 'M-Pesa', kind: 'mpesa' };
  return { channel: BANK_NAMES[t.source] || t.source, kind: 'bank' };
}

async function listPayments(db, s, { limit = 50, offset = 0 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200), off = Math.max(Number(offset) || 0, 0);
  const terms = await startedTerms(db, s.school_id);
  const byId = new Map(terms.map((t) => [t.id, t.label]));
  const where = `t.school_id = $1 AND t.matched_student_id = $2 AND t.match_status IN ('auto_matched', 'confirmed')`;
  const total = (await db.query(`SELECT COUNT(*)::int AS n FROM transactions t WHERE ${where}`, [s.school_id, s.id])).rows[0].n;
  // For a payment typed in by staff only the code/slip number is shown, never the staff's private note.
  const rows = (await db.query(
    `SELECT t.id, t.source, t.external_ref, t.amount, t.received_at, t.term_id, t.raw_payload->>'method' AS method, t.raw_payload->>'reference' AS manual_ref
     FROM transactions t WHERE ${where} ORDER BY t.received_at DESC, t.id DESC LIMIT $3 OFFSET $4`, [s.school_id, s.id, lim, off])).rows;
  return {
    total, payments: rows.map((t) => ({
      id: t.id, receipt_no: 'RCP-' + String(t.id).padStart(6, '0'), amount: num(t.amount), received_at: t.received_at,
      ...describePayment(t), reference: t.source === 'manual' ? (t.manual_ref || null) : (t.external_ref || null),
      term: t.term_id ? byId.get(t.term_id) || null : null,
    })),
  };
}

async function payOptions(db, s) {
  const sc = (await db.query(
    `SELECT mpesa_shortcode, (mpesa_consumer_key_enc IS NOT NULL AND mpesa_consumer_secret_enc IS NOT NULL) AS has_keys, (mpesa_passkey_enc IS NOT NULL) AS has_passkey
     FROM schools WHERE id = $1`, [s.school_id])).rows[0] || {};
  const channels = await getSelected(s.school_id);
  const mpesaOn = channels.includes('mpesa') && Boolean(sc.mpesa_shortcode);
  let baseOk = true;
  try { assertCallbackUrlAllowed(String(process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '') + '/webhooks/stk/1/x/result'); } catch (e) { baseOk = false; }
  return {
    online: Boolean(mpesaOn && sc.has_keys && sc.has_passkey && baseOk && IN_SCHOOL.includes(s.status)),   // "Send request to my phone"
    paybill: mpesaOn ? { business_number: sc.mpesa_shortcode, account_number: s.admission_no } : null,   // "or pay yourself from the M-Pesa menu"
    banks: channels.filter((c) => BANK_NAMES[c]).map((c) => BANK_NAMES[c]),
    max_amount: MAX_AMOUNT, school_phone: s.school_phone || null,
  };
}

async function getHome(msisdn, studentId, deps = {}) {
  const db = deps.pool || pool;
  const s = await ownChild(db, msisdn, studentId);
  const child = await summarize(db, s, new Map());
  const recent = (await listPayments(db, s, { limit: 3 })).payments;
  return { child, recent_payments: recent, pay: await payOptions(db, s) };
}

async function getFees(msisdn, studentId, deps = {}) {
  const db = deps.pool || pool;
  const s = await ownChild(db, msisdn, studentId);
  const child = await summarize(db, s, new Map());
  const terms = await startedTerms(db, s.school_id);
  const ledger = (await db.query('SELECT term_id, opening_balance, fees_charged, amount_paid FROM student_term_ledger WHERE student_id = $1', [s.id])).rows;
  const byTerm = terms.filter((t) => ledger.some((l) => l.term_id === t.id)).map((t) => {      // newest first
    const l = ledger.find((x) => x.term_id === t.id);
    const opening = num(l.opening_balance), charged = num(l.fees_charged), paid = num(l.amount_paid), balance = money2(opening + charged - paid);
    return { term_id: t.id, label: t.label, brought_forward: opening, fees_charged: charged, paid, balance, state: stateOf(opening, charged, balance) };
  });
  // This term's fee lines come from what billing LOCKED for the child's class (never the editable fee structure).
  // Earlier terms keep numbers only: the class the child was in then may not be the class they are in now.
  let items = [];
  const cur = await currentTermOf(db, s.school_id);
  if (cur && s.class_id) {
    const lines = (await db.query(
      `SELECT i.name, i.amount, i.is_mandatory FROM term_fee_locks l JOIN fee_template_items i ON i.template_id = l.template_id
       WHERE l.school_id = $1 AND l.term_id = $2 AND l.class_id = $3 ORDER BY i.is_mandatory DESC, i.id`, [s.school_id, cur.id, s.class_id])).rows;
    const chosen = (await db.query('SELECT name_key FROM student_optional_choices WHERE student_id = $1', [s.id])).rows.map((r) => r.name_key);
    const key = (n) => String(n).replace(/\s+/g, ' ').trim().toLowerCase();
    items = lines.filter((i) => i.is_mandatory || chosen.includes(key(i.name))).map((i) => ({ name: i.name, amount: num(i.amount), optional: !i.is_mandatory }));
  }
  return { child, term: cur ? cur.label : null, items, total: money2(items.reduce((a, i) => a + i.amount, 0)), by_term: byTerm };
}

async function getPayments(msisdn, studentId, opts = {}, deps = {}) {
  const db = deps.pool || pool;
  const s = await ownChild(db, msisdn, studentId);
  return { child: await summarize(db, s, new Map()), ...(await listPayments(db, s, opts)) };
}

async function getReceipt(msisdn, studentId, txnId, deps = {}) {
  const db = deps.pool || pool;
  const s = await ownChild(db, msisdn, studentId);
  const id = Number(txnId);
  if (!Number.isInteger(id)) throw refuse('No such payment.', 404);
  const own = (await db.query(`SELECT source, raw_payload->>'reference' AS manual_ref FROM transactions WHERE id = $1 AND school_id = $2 AND matched_student_id = $3`, [id, s.school_id, s.id])).rows[0];
  if (!own) throw refuse('No such payment.', 404);
  const r = await getSheetReceipt(s.school_id, id, deps);
  delete r.entered_by;                                                       // the receipt for staff names who typed it in; a parent does not need that
  if (own.source === 'manual') r.reference = own.manual_ref || null;         // and never the staff's private note
  return r;
}

/* ---------------------------- paying ---------------------------- */
async function startPayment(msisdn, studentId, { amount, phone } = {}, deps = {}) {
  const db = deps.pool || pool;
  const s = await ownChild(db, msisdn, studentId);
  const raw = typeof amount === 'number' ? amount : Number(String(amount == null ? '' : amount).replace(/[,\s]/g, ''));
  const out = await (deps.createPush || createPush)({ schoolId: s.school_id, studentId: s.id, phone: phone || msisdn, amount: raw }, deps);
  return { request_id: out.requestId, status: out.status, message: out.message };
}

async function getPaymentStatus(msisdn, studentId, requestId, deps = {}) {
  const db = deps.pool || pool;
  const s = await ownChild(db, msisdn, studentId);
  let seen = null;
  try { seen = await (deps.refreshIfStale || refreshIfStale)(Number(requestId) || 0, s.school_id, s.id, deps); }
  catch (err) { console.error('STK status check failed:', err.message); }              // the check is a bonus: never break the poll
  const st = await getPushStatus(requestId, s.school_id, s.id, deps);
  // Safaricom says the money was taken but the receipt has not reached us yet: the balance updates when it does.
  if (st.status === 'sent' && seen === 'paid') return { ...st, message: 'M-Pesa has taken the payment. Your balance will update in a moment.', confirmed: true };
  return st;
}

// "Cancel" in the sheet: stop waiting at once so a new request can be made straight away.
async function cancelPayment(msisdn, studentId, requestId, deps = {}) {
  const db = deps.pool || pool;
  const s = await ownChild(db, msisdn, studentId);
  const out = await (deps.cancelPush || cancelPush)(requestId, s.school_id, s.id, deps);
  return { ok: true, cancelled: out.cancelled };
}

module.exports = { listChildren, getHome, getFees, getPayments, getReceipt, startPayment, getPaymentStatus, cancelPayment, phoneHasChildren, IN_SCHOOL };