/**
 * One student's sheet: everything about one student and the few things staff may do on it.
 *
 *   getSheet           the student, contacts, optional fees chosen, money per term, payments, this term's fee breakdown
 *   getReceipt         the data for one printable receipt (one payment)
 *   recordManualPayment  cash / cheque / bank slip entered by staff. Goes through the same ledger path as bank payments.
 *   reverseManualPayment undo a WRONG manual payment (kept on record, marked reversed, with who and why)
 *   updateDetails      name and contacts
 *   setStudentStatus   mark a student as left, or bring them back
 *
 * Rules:
 *   - Any staff member of the SAME school may use all of it. Every change is written to the audit log with WHO did it.
 *   - Money is only ever added by payments (this file adds one kind: a manual payment). Nothing here edits a ledger number
 *     by hand, and a student is never deleted (marking left keeps all history).
 *   - A manual payment is safe to send twice: the same request id can only be recorded once.
 *   - dry: true does everything and rolls it back.
 */
const { pool } = require('../db/db');
const { logAudit } = require('./audit');
const { getCurrentTerm, applyPayment, chargeStudentForTerm, getPreviousTerm } = require('./feeLedger');
const { cleanContacts, cleanText } = require('./studentAdmission');
const { startedTerms } = require('./balances');
const { findClash, LINE_UP_KEY, checkAdmissionFormat } = require('./studentAdmission');
const { getSelected } = require('./channels');
const { describe: describeAction } = require('./activityLog');

// How a manual payment can be made. The first five are offered; bank_deposit is the older name for a bank slip and stays so old records still read.
const METHODS = { cash: 'Cash', mpesa: 'M-Pesa', bank: 'Bank', cheque: 'Cheque', other: 'Other', bank_deposit: 'Bank deposit slip' };
const OFFERED = ['cash', 'mpesa', 'bank', 'cheque', 'other'];
const BANK_NAMES = { kcb: 'KCB', equity: 'Equity', coop: 'Co-op' };
// M-Pesa and bank payments need the code: it is how a double entry (or a payment that already arrived by itself) is caught
const NEEDS_CODE = { mpesa: 'the M-Pesa transaction code (about 10 letters and numbers, from the message)', bank: 'the bank slip or transaction number' };
const CHANNELS = { mpesa: 'M-Pesa', kcb: 'KCB', equity: 'Equity Bank', coop: 'Co-operative Bank' };
const MAX_PAYMENT = 10000000;
const hasControl = (s) => /[\u0000-\u001f\u007f]/.test(s);
const receiptNo = (id) => 'RCP-' + String(id).padStart(6, '0');
const num = (v) => Number(v) || 0;
const money2 = (v) => Math.round(Number(v) * 100) / 100;

function refuse(message, status = 400) { const e = new Error(message); e.status = status; return e; }

async function loadStudent(db, schoolId, studentId, lock = false) {
  if (!Number.isInteger(studentId)) throw refuse('That is not a valid student.', 400);
  const r = await db.query(
    `SELECT s.id, s.school_id, s.admission_no, s.full_name, s.status, s.class_id, s.stream_id, s.guardian_name, s.guardian_phone,
            c.name AS class, st.name AS stream
     FROM students s LEFT JOIN classes c ON c.id = s.class_id LEFT JOIN streams st ON st.id = s.stream_id
     WHERE s.id = $1 AND s.school_id = $2${lock ? ' FOR UPDATE OF s' : ''}`, [studentId, schoolId]);
  if (!r.rows[0]) throw refuse('There is no such student in this school.', 404);
  return r.rows[0];
}

async function inTransaction(db, dry, work) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const out = await work(client);
    await client.query(dry ? 'ROLLBACK' : 'COMMIT');
    return out;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* the connection is already gone */ }
    throw err;
  } finally {
    client.release();
  }
}

// what this term's ledger says about one student: { opening, charged, paid, balance } or null
async function termMoney(db, studentId, termId) {
  const l = (await db.query('SELECT opening_balance, fees_charged, amount_paid FROM student_term_ledger WHERE student_id = $1 AND term_id = $2', [studentId, termId])).rows[0];
  if (!l) return null;
  const opening = num(l.opening_balance), charged = num(l.fees_charged), paid = num(l.amount_paid);
  return { brought_forward: opening, fees_charged: charged, paid, balance: money2(opening + charged - paid) };
}

/* ------------------------------------------------------------------ */
async function getSheet(schoolId, studentId, deps = {}) {
  const db = deps.pool || pool;
  const s = await loadStudent(db, schoolId, studentId);
  const contacts = (await db.query('SELECT full_name AS name, phone, relationship FROM student_contacts WHERE student_id = $1 ORDER BY sort_order, id', [s.id])).rows;
  const chosen = (await db.query('SELECT name FROM student_optional_choices WHERE student_id = $1 ORDER BY name', [s.id])).rows.map((r) => r.name);
  const terms = await startedTerms(db, schoolId);
  const byId = new Map(terms.map((t) => [t.id, t]));

  const ledgerRows = (await db.query('SELECT term_id, opening_balance, fees_charged, amount_paid FROM student_term_ledger WHERE student_id = $1', [s.id])).rows;
  const ledger = terms.filter((t) => ledgerRows.some((l) => l.term_id === t.id)).map((t) => {
    const l = ledgerRows.find((x) => x.term_id === t.id);
    const opening = num(l.opening_balance), charged = num(l.fees_charged), paid = num(l.amount_paid);
    return { term_id: t.id, label: t.label, brought_forward: opening, fees_charged: charged, paid, balance: money2(opening + charged - paid) };
  });                                                           // terms come newest first

  const payments = (await db.query(
    `SELECT t.id, t.source, t.external_ref, t.amount, t.payer_name, t.narration, t.received_at, t.term_id, t.raw_payload->>'method' AS method, sf.full_name AS added_by,
            r.reason AS rev_reason, r.created_at AS rev_at, rs.full_name AS rev_by
     FROM transactions t LEFT JOIN staff sf ON sf.id = t.acted_by_staff_id AND t.source = 'manual'
          LEFT JOIN payment_reversals r ON r.transaction_id = t.id LEFT JOIN staff rs ON rs.id = r.reversed_by_staff_id
     WHERE t.school_id = $1 AND t.matched_student_id = $2 AND (t.match_status IN ('auto_matched', 'confirmed') OR r.id IS NOT NULL)
     ORDER BY t.received_at DESC, t.id DESC`, [schoolId, s.id])).rows.map((t) => ({
    id: t.id, receipt_no: receiptNo(t.id), amount: num(t.amount), received_at: t.received_at,
    channel: t.source === 'manual' ? (METHODS[t.method] || 'Manual') : (CHANNELS[t.source] || t.source),
    manual: t.source === 'manual', reference: t.source === 'manual' ? (t.narration || null) : (t.external_ref || t.narration || null),
    payer_name: t.payer_name || null, added_by: t.added_by || null,
    reversed: t.rev_reason ? { reason: t.rev_reason, by: t.rev_by || null, at: t.rev_at } : null,
    can_reverse: t.source === 'manual' && !t.rev_reason,
    term: t.term_id && byId.get(t.term_id) ? byId.get(t.term_id).label : null,
  }));

  // the fee breakdown of the CURRENT term, from what billing locked for the student's class (earlier terms keep only the
  // numbers: the class a student was in then may not be the class they are in now)
  const cur = await getCurrentTerm(schoolId, db);
  let fees = null;
  if (cur && s.class_id) {
    const term = byId.get(cur.id);
    const items = (await db.query(
      `SELECT i.name, i.amount, i.is_mandatory FROM term_fee_locks l JOIN fee_template_items i ON i.template_id = l.template_id
       WHERE l.school_id = $1 AND l.term_id = $2 AND l.class_id = $3 ORDER BY i.is_mandatory DESC, i.id`, [schoolId, cur.id, s.class_id])).rows;
    if (items.length) {
      const keyOf = (n) => String(n).replace(/\s+/g, ' ').trim().toLowerCase();
      const mandatory = items.filter((i) => i.is_mandatory).map((i) => ({ name: i.name, amount: num(i.amount) }));
      const optional = items.filter((i) => !i.is_mandatory && chosen.some((c) => keyOf(c) === keyOf(i.name))).map((i) => ({ name: i.name, amount: num(i.amount) }));
      fees = { term: term ? term.label : null, mandatory, optional, total: money2(mandatory.concat(optional).reduce((a, i) => a + i.amount, 0)) };
    }
  }
  const current = cur ? await termMoney(db, s.id, cur.id) : null;

  // the ways a payment can be entered; "Bank" carries the bank's name when the school uses exactly one
  const banks = (await getSelected(schoolId)).filter((c) => BANK_NAMES[c]);
  const methods = OFFERED.map((m) => ({ value: m, label: m === 'bank' && banks.length === 1 ? 'Bank (' + BANK_NAMES[banks[0]] + ')' : METHODS[m] }));

  // what has changed on this student (newest first), in the same words as the activity log
  const hist = (await db.query(
    `SELECT a.id, a.action, a.detail, a.created_at, f.full_name AS who FROM audit_log a LEFT JOIN staff f ON f.id = a.staff_id
     WHERE a.school_id = $1 AND a.detail->>'student_id' = $2::text AND a.action IN ('student_admitted', 'student_updated', 'student_marked_left', 'student_returned', 'manual_payment_added', 'manual_payment_reversed', 'payment_confirmed', 'students_moved')
     ORDER BY a.id DESC LIMIT 12`, [schoolId, String(s.id)])).rows;
  const ctx = { student: () => s.full_name, person: () => null };
  const history = hist.map((h) => { const x = describeAction(h.action, h.detail, ctx); return { when: h.created_at, who: h.who || 'System', text: x.text.replace(s.full_name, 'this student'), extra: x.extra }; });
  return {
    student: { id: s.id, admission_no: s.admission_no, full_name: s.full_name, status: s.status, class_id: s.class_id, class: s.class, stream: s.stream },
    contacts, optional_fees: chosen, methods, history,
    current_term: cur && byId.get(cur.id) ? { id: cur.id, label: byId.get(cur.id).label, ...(current || { brought_forward: 0, fees_charged: 0, paid: 0, balance: 0 }) } : null,
    fees, ledger, payments,
  };
}

/* ------------------------------------------------------------------ */
async function getReceipt(schoolId, txnId, deps = {}) {
  const db = deps.pool || pool;
  if (!Number.isInteger(txnId)) throw refuse('That is not a valid payment.', 400);
  const t = (await db.query(
    `SELECT t.id, t.source, t.external_ref, t.amount, t.narration, t.received_at, t.term_id, t.matched_student_id, t.raw_payload->>'method' AS method,
            sf.full_name AS added_by, sc.name AS school
     FROM transactions t JOIN schools sc ON sc.id = t.school_id LEFT JOIN staff sf ON sf.id = t.acted_by_staff_id AND t.source = 'manual'
     WHERE t.id = $1 AND t.school_id = $2 AND t.match_status IN ('auto_matched', 'confirmed') AND t.matched_student_id IS NOT NULL`, [txnId, schoolId])).rows[0];
  if (!t) {
    const rev = (await db.query('SELECT 1 FROM payment_reversals WHERE transaction_id = $1 AND school_id = $2', [txnId, schoolId])).rows.length;
    if (rev) throw refuse('This payment was reversed, so it has no receipt.', 409);
    throw refuse('There is no such payment for this school.', 404);
  }
  const s = await loadStudent(db, schoolId, t.matched_student_id);
  const terms = await startedTerms(db, schoolId);
  const term = terms.find((x) => x.id === t.term_id) || null;
  let balanceAfter = null;
  if (term) {
    const l = (await db.query('SELECT opening_balance, fees_charged FROM student_term_ledger WHERE student_id = $1 AND term_id = $2', [s.id, term.id])).rows[0];
    const upTo = (await db.query(
      `SELECT COALESCE(SUM(x.amount), 0) AS paid FROM transactions x, transactions me
       WHERE me.id = $4 AND x.school_id = $1 AND x.matched_student_id = $2 AND x.term_id = $3 AND x.match_status IN ('auto_matched', 'confirmed')
         AND (x.received_at, x.id) <= (me.received_at, me.id)`, [schoolId, s.id, term.id, t.id])).rows[0];
    balanceAfter = money2((l ? num(l.opening_balance) + num(l.fees_charged) : 0) - num(upTo.paid));
  }
  return {
    receipt_no: receiptNo(t.id), school: t.school, received_at: t.received_at, amount: num(t.amount),
    channel: t.source === 'manual' ? (METHODS[t.method] || 'Manual') : (CHANNELS[t.source] || t.source),
    reference: t.source === 'manual' ? (t.narration || null) : (t.external_ref || t.narration || null),
    student: { admission_no: s.admission_no, full_name: s.full_name, class: s.class, stream: s.stream },
    term: term ? term.label : null, balance_after: balanceAfter, entered_by: t.added_by || null,
  };
}

/* ------------------------------------------------------------------ */
function cleanPayment(i) {
  const o = i || {};
  const raw = typeof o.amount === 'number' ? o.amount : Number(String(o.amount == null ? '' : o.amount).replace(/,/g, '').trim());
  if (!Number.isFinite(raw) || raw <= 0) throw refuse('Enter the amount paid, for example 15000.');
  if (Math.abs(raw * 100 - Math.round(raw * 100)) > 1e-6) throw refuse('The amount can have at most 2 decimals.');
  if (raw > MAX_PAYMENT) throw refuse('That amount looks like a typing mistake.');
  const method = String(o.method || '');
  if (!METHODS[method]) throw refuse('Choose how it was paid: ' + OFFERED.map((m) => METHODS[m]).join(', ') + '.');
  let reference = cleanText(o.reference);
  const note = cleanText(o.note), payer = cleanText(o.payerName);
  if (reference.length > 60 || hasControl(reference)) throw refuse('The reference must be 60 characters or fewer (a transaction code, cheque number or slip number).');
  if (NEEDS_CODE[method] && !reference) throw refuse('Enter ' + NEEDS_CODE[method] + '.');
  if (method === 'mpesa') {
    reference = reference.replace(/\s+/g, '').toUpperCase();
    if (!/^[A-Z0-9]{6,20}$/.test(reference)) throw refuse('That does not look like an M-Pesa code. It is about 10 letters and numbers, for example SJK4X9T2LM.');
  }
  if (note.length > 200 || hasControl(note)) throw refuse('The note must be 200 characters or fewer.');
  if (payer.length > 100 || hasControl(payer)) throw refuse('The payer name must be 100 characters or fewer.');
  let receivedOn = null;
  if (o.receivedOn != null && o.receivedOn !== '') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(o.receivedOn)) || Number.isNaN(Date.parse(o.receivedOn))) throw refuse('The date must be written year-month-day, for example 2026-10-23.');
    receivedOn = String(o.receivedOn);
  }
  let requestId = null;
  if (o.requestId != null && o.requestId !== '') {
    if (!/^[A-Za-z0-9-]{8,64}$/.test(String(o.requestId))) throw refuse('The request id is not valid.');
    requestId = String(o.requestId);
  }
  return { amount: money2(raw), method, reference, note, payer, receivedOn, requestId };
}

async function recordManualPayment(schoolId, studentId, input, { staffId = null, dry = false } = {}, deps = {}) {
  const db = deps.pool || pool;
  const v = cleanPayment(input);
  if (!staffId) throw refuse('Only a logged-in staff member can record a payment.', 401);
  const out = await inTransaction(db, dry, async (client) => {
    const s = await loadStudent(client, schoolId, studentId, true);                       // one payment per student at a time
    const term = await getCurrentTerm(schoolId, client);
    if (!term) throw refuse('No term has started for this school yet, so a payment has nowhere to go. Set the term dates first (Academic years & terms).', 409);
    const today = (await client.query(`SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS d, to_char(CURRENT_DATE - 400, 'YYYY-MM-DD') AS old`)).rows[0];
    if (v.receivedOn && (v.receivedOn > today.d)) throw refuse('The payment date can not be in the future.');
    if (v.receivedOn && v.receivedOn < today.old) throw refuse('That payment date is more than a year ago. Check the year.');
    if (NEEDS_CODE[v.method] && v.reference) {
      // one code, one payment: lock on the code so two people can not enter it at the same moment
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['paycode:' + schoolId + ':' + v.reference.toUpperCase()]);
      const dupe = (await client.query(
        `SELECT t.id, t.amount, st.full_name FROM transactions t LEFT JOIN students st ON st.id = t.matched_student_id
         WHERE t.school_id = $1 AND t.match_status <> 'rejected'
           AND (upper(t.external_ref) = upper($2) OR (t.source = 'manual' AND upper(t.raw_payload->>'reference') = upper($2)))
         LIMIT 1`, [schoolId, v.reference])).rows[0];
      if (dupe) throw refuse('That code is already recorded: ' + receiptNo(dupe.id) + ' (KES ' + num(dupe.amount).toLocaleString('en-US') + (dupe.full_name ? ' for ' + dupe.full_name : '') + '). Enter a payment only once.', 409);
    }
    const ref = 'MAN-' + schoolId + '-' + (v.requestId || require('crypto').randomUUID());
    const narration = [v.reference, v.note].filter(Boolean).join(' - ') || null;
    const ins = await client.query(
      `INSERT INTO transactions (school_id, term_id, source, external_ref, amount, payer_name, narration, raw_payload, received_at,
                                 match_status, matched_student_id, confidence, match_reason, acted_by_staff_id, acted_at)
       VALUES ($1, $2, 'manual', $3, $4, $5, $6, $7, COALESCE(($8::text || ' 12:00:00+03')::timestamptz, NOW()), 'confirmed', $9, 1, 'Entered by staff', $10, NOW())
       ON CONFLICT (source, external_ref) DO NOTHING RETURNING id`,
      [schoolId, term.id, ref, v.amount, v.payer || null, narration, JSON.stringify({ method: v.method, reference: v.reference || null, note: v.note || null }), v.receivedOn, s.id, staffId]);
    if (!ins.rows.length) {                                                              // the same request again: already recorded
      const old = (await client.query(`SELECT id, matched_student_id FROM transactions WHERE source = 'manual' AND external_ref = $1`, [ref])).rows[0];
      if (!old || old.matched_student_id !== s.id) throw refuse('That request id was already used for another payment.', 409);
      return { already: true, id: old.id, student: s, term, balance: (await termMoney(client, s.id, term.id)).balance };
    }
    await applyPayment(s.id, term.id, v.amount, client);
    const m = await termMoney(client, s.id, term.id);
    return { already: false, id: ins.rows[0].id, student: s, term, balance: m.balance };
  });
  const terms = await startedTerms(db, schoolId);
  const t = terms.find((x) => x.id === out.term.id);
  if (!dry && !out.already) {
    await logAudit({ schoolId, staffId, action: 'manual_payment_added', detail: {
      student_id: out.student.id, admission_no: out.student.admission_no, amount: v.amount, method: v.method, reference: v.reference || null,
      note: v.note || null, term: t ? t.label : null, transaction_id: out.id, receipt_no: receiptNo(out.id) } });
  }
  return { dry, already_recorded: out.already, transaction_id: dry ? null : out.id, receipt_no: dry ? null : receiptNo(out.id), amount: v.amount, method: METHODS[v.method], term: t ? t.label : null, balance_after: out.balance };
}

/* ------------------------------------------------------------------ */
// Undo a WRONG manual payment. The payment stays on record (marked rejected), a reversal row says who and why, and the
// student's ledger goes down by the same amount. Bank payments (M-Pesa, KCB, Equity, Co-op) are real money and can not
// be reversed here. Only a payment of the current term or the one before it can be reversed (older ones are history).
async function reverseManualPayment(schoolId, txnId, input, { staffId = null, dry = false } = {}, deps = {}) {
  const db = deps.pool || pool;
  if (!Number.isInteger(txnId)) throw refuse('That is not a valid payment.', 400);
  if (!staffId) throw refuse('Only a logged-in staff member can reverse a payment.', 401);
  const reason = cleanText((input || {}).reason);
  if (reason.length < 3) throw refuse('Say why the payment is being reversed (at least a few words).');
  if (reason.length > 200 || hasControl(reason)) throw refuse('The reason must be 200 characters or fewer.');
  const out = await inTransaction(db, dry, async (client) => {
    const t = (await client.query(
      `SELECT id, source, amount, term_id, matched_student_id, match_status FROM transactions WHERE id = $1 AND school_id = $2 FOR UPDATE`, [txnId, schoolId])).rows[0];
    if (!t) throw refuse('There is no such payment for this school.', 404);
    if (t.source !== 'manual') throw refuse('Only a payment entered by staff can be reversed here. Bank and M-Pesa payments are real money: handle a wrong match in the Review queue.', 409);
    if (!t.matched_student_id) throw refuse('This payment is not on a student.', 409);
    if ((await client.query('SELECT 1 FROM payment_reversals WHERE transaction_id = $1', [t.id])).rows.length) throw refuse('This payment was already reversed.', 409);
    const s = await loadStudent(client, schoolId, t.matched_student_id, true);
    const cur = await getCurrentTerm(schoolId, client);
    if (!cur) throw refuse('No term has started for this school.', 409);
    const prev = await getPreviousTerm(cur, client);
    if (t.term_id !== cur.id && !(prev && t.term_id === prev.id)) throw refuse('This payment belongs to an older term, which is closed. It can not be reversed here.', 409);
    const led = (await client.query('SELECT amount_paid FROM student_term_ledger WHERE student_id = $1 AND term_id = $2 FOR UPDATE', [s.id, t.term_id])).rows[0];
    if (!led || num(led.amount_paid) < num(t.amount) - 0.005) throw refuse('The student\'s ledger does not hold this payment, so it can not be reversed safely. Nothing was changed.', 409);
    await client.query('INSERT INTO payment_reversals (school_id, transaction_id, reason, reversed_by_staff_id) VALUES ($1, $2, $3, $4)', [schoolId, t.id, reason, staffId]);
    await client.query(`UPDATE transactions SET match_status = 'rejected', match_reason = $2 WHERE id = $1`, [t.id, 'Reversed: ' + reason]);
    await client.query('UPDATE student_term_ledger SET amount_paid = amount_paid - $3 WHERE student_id = $1 AND term_id = $2', [s.id, t.term_id, t.amount]);
    if (t.term_id !== cur.id && s.class_id) {
      // the payment was in the previous term: this term's brought-forward changes with it, so it is recalculated (payments untouched)
      if ((await client.query('SELECT 1 FROM student_term_ledger WHERE student_id = $1 AND term_id = $2', [s.id, cur.id])).rows.length) {
        await chargeStudentForTerm(client, { id: s.id, school_id: schoolId, class_id: s.class_id }, cur, prev);
      }
    }
    const m = await termMoney(client, s.id, cur.id);
    return { t, s, balance: m ? m.balance : null, termId: t.term_id };
  });
  const terms = await startedTerms(db, schoolId);
  const term = terms.find((x) => x.id === out.termId);
  if (!dry) {
    await logAudit({ schoolId, staffId, action: 'manual_payment_reversed', detail: {
      student_id: out.s.id, admission_no: out.s.admission_no, amount: num(out.t.amount), transaction_id: out.t.id, receipt_no: receiptNo(out.t.id), term: term ? term.label : null, reason } });
  }
  return { dry, transaction_id: out.t.id, receipt_no: receiptNo(out.t.id), amount: num(out.t.amount), term: term ? term.label : null, balance_after: out.balance };
}

/* ------------------------------------------------------------------ */
async function updateDetails(schoolId, studentId, input, { staffId = null, dry = false } = {}, deps = {}) {
  const db = deps.pool || pool;
  const i = input || {};
  const fullName = i.fullName === undefined ? undefined : cleanText(i.fullName);
  if (fullName !== undefined) {
    if (fullName.length < 2) throw refuse('Enter the full name of the student.');
    if (fullName.length > 100 || hasControl(fullName)) throw refuse('The full name must be 100 characters or fewer.');
  }
  const contacts = i.contacts === undefined ? undefined : cleanContacts(i.contacts);
  let admissionNo;
  if (i.admissionNo !== undefined) {
    admissionNo = cleanText(i.admissionNo);
    if (!admissionNo) throw refuse('Enter the admission number.');
    if (admissionNo.length > 40 || hasControl(admissionNo)) throw refuse('The admission number must be 40 characters or fewer.');
  }
  if (fullName === undefined && contacts === undefined && admissionNo === undefined) throw refuse('Nothing to change: send the name, the admission number or the contacts.');
  const res = await inTransaction(db, dry, async (client) => {
    const s = await loadStudent(client, schoolId, studentId, true);
    if (admissionNo !== undefined && admissionNo !== s.admission_no) {
      // payments are matched on this number, so only an Admin may change it, and it can not clash with another student's
      const who = (await client.query('SELECT role FROM staff WHERE id = $1 AND school_id = $2 AND status = \'active\'', [staffId, schoolId])).rows[0];
      if (!who || who.role !== 'admin') throw refuse('Only an Admin can change an admission number. Ask an Admin of this school.', 403);
      checkAdmissionFormat(admissionNo);                                   // a changed number follows the same rule as a new one
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [LINE_UP_KEY, schoolId]);
      const others = (await client.query('SELECT id, admission_no, full_name FROM students WHERE school_id = $1 AND id <> $2', [schoolId, s.id])).rows;
      const clash = findClash(others, admissionNo);
      if (clash && clash.kind === 'same') throw refuse('Admission number ' + clash.student.admission_no + ' is already used by ' + clash.student.full_name + '.', 409);
      if (clash) throw refuse('"' + admissionNo + '" would be confused with "' + clash.student.admission_no + '" (' + clash.student.full_name + '): a payment that mentions the number matches both students. Use a different admission number.', 409);
    }
    const before = { admission_no: s.admission_no, full_name: s.full_name, contacts: (await client.query('SELECT full_name AS name, phone, relationship FROM student_contacts WHERE student_id = $1 ORDER BY sort_order, id', [s.id])).rows };
    const after = { admission_no: admissionNo === undefined ? s.admission_no : admissionNo, full_name: fullName === undefined ? s.full_name : fullName, contacts: contacts === undefined ? before.contacts : contacts };
    const same = JSON.stringify(before) === JSON.stringify(after);
    if (!same) {
      const first = after.contacts[0] || null;
      try {
        await client.query('UPDATE students SET admission_no = $5, full_name = $1, guardian_name = $2, guardian_phone = $3 WHERE id = $4', [after.full_name, first ? first.name : null, first ? first.phone : null, s.id, after.admission_no]);
      } catch (e) { if (e.code === '23505') throw refuse('Admission number ' + after.admission_no + ' is already used in this school.', 409); throw e; }
      if (contacts !== undefined) {
        await client.query('DELETE FROM student_contacts WHERE student_id = $1', [s.id]);
        for (let k = 0; k < after.contacts.length; k++) {
          const c = after.contacts[k];
          await client.query('INSERT INTO student_contacts (student_id, full_name, phone, relationship, sort_order) VALUES ($1, $2, $3, $4, $5)', [s.id, c.name, c.phone, c.relationship, k]);
        }
      }
    }
    return { unchanged: same, student: s, before, after };
  });
  if (!dry && !res.unchanged) {
    await logAudit({ schoolId, staffId, action: 'student_updated', detail: { student_id: res.student.id, admission_no: res.student.admission_no, before: res.before, after: res.after } });
  }
  return { dry, unchanged: res.unchanged, full_name: res.after.full_name, admission_no: res.after.admission_no, contacts: res.after.contacts };
}

/* ------------------------------------------------------------------ */
async function setStudentStatus(schoolId, studentId, input, { staffId = null, dry = false } = {}, deps = {}) {
  const db = deps.pool || pool;
  const status = String((input || {}).status || '');
  if (!['active', 'left'].includes(status)) throw refuse('The status must be "active" or "left".');
  const reason = cleanText((input || {}).reason);
  if (reason.length > 200 || hasControl(reason)) throw refuse('The reason must be 200 characters or fewer.');
  const res = await inTransaction(db, dry, async (client) => {
    const s = await loadStudent(client, schoolId, studentId, true);
    const cur = await getCurrentTerm(schoolId, client);
    const money = cur ? await termMoney(client, s.id, cur.id) : null;
    if (s.status === status) return { unchanged: true, student: s, money, billed: null };
    await client.query('UPDATE students SET status = $1 WHERE id = $2', [status, s.id]);
    let billed = null;
    if (status === 'active' && cur && s.class_id) {
      // coming back while the term is running: if the class was already billed this term, the student is charged now
      const running = (await client.query(`SELECT 1 FROM school_term_dates WHERE school_id = $1 AND term_id = $2 AND end_date >= CURRENT_DATE`, [schoolId, cur.id])).rows.length > 0;
      const locked = (await client.query('SELECT 1 FROM term_fee_locks WHERE school_id = $1 AND term_id = $2 AND class_id = $3', [schoolId, cur.id, s.class_id])).rows.length > 0;
      if (running && locked) {
        const previous = await getPreviousTerm(cur, client);
        const b = await chargeStudentForTerm(client, { id: s.id, school_id: schoolId, class_id: s.class_id }, cur, previous);
        billed = { fees: b.feesCharged };
      }
    }
    return { unchanged: false, student: s, money: cur ? await termMoney(client, s.id, cur.id) : null, billed };
  });
  if (!dry && !res.unchanged) {
    await logAudit({ schoolId, staffId, action: status === 'left' ? 'student_marked_left' : 'student_returned', detail: {
      student_id: res.student.id, admission_no: res.student.admission_no, reason: reason || null, balance: res.money ? res.money.balance : null, billed: res.billed } });
  }
  return { dry, unchanged: res.unchanged, status, balance: res.money ? res.money.balance : null, billed: res.billed };
}

module.exports = { getSheet, getReceipt, recordManualPayment, reverseManualPayment, updateDetails, setStudentStatus, receiptNo, METHODS };