/**
 * One student's sheet: everything about one student and the few things staff may do on it.
 *
 *   getSheet           the student, contacts, optional fees chosen, money per term, payments, this term's fee breakdown
 *   getReceipt         the data for one printable receipt (one payment)
 *   recordManualPayment  cash / cheque / bank slip entered by staff. Goes through the same ledger path as bank payments.
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

const METHODS = { cash: 'Cash', cheque: 'Cheque', bank_deposit: 'Bank deposit slip', other: 'Other' };
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
    `SELECT t.id, t.source, t.external_ref, t.amount, t.payer_name, t.narration, t.received_at, t.term_id, t.raw_payload->>'method' AS method, sf.full_name AS added_by
     FROM transactions t LEFT JOIN staff sf ON sf.id = t.acted_by_staff_id AND t.source = 'manual'
     WHERE t.school_id = $1 AND t.matched_student_id = $2 AND t.match_status IN ('auto_matched', 'confirmed')
     ORDER BY t.received_at DESC, t.id DESC`, [schoolId, s.id])).rows.map((t) => ({
    id: t.id, receipt_no: receiptNo(t.id), amount: num(t.amount), received_at: t.received_at,
    channel: t.source === 'manual' ? (METHODS[t.method] || 'Manual') : (CHANNELS[t.source] || t.source),
    manual: t.source === 'manual', reference: t.source === 'manual' ? (t.narration || null) : (t.external_ref || t.narration || null),
    payer_name: t.payer_name || null, added_by: t.added_by || null,
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
  return {
    student: { id: s.id, admission_no: s.admission_no, full_name: s.full_name, status: s.status, class_id: s.class_id, class: s.class, stream: s.stream },
    contacts, optional_fees: chosen,
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
  if (!t) throw refuse('There is no such payment for this school.', 404);
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
  if (!METHODS[method]) throw refuse('Choose how it was paid: ' + Object.values(METHODS).join(', ') + '.');
  const reference = cleanText(o.reference), note = cleanText(o.note), payer = cleanText(o.payerName);
  if (reference.length > 60 || hasControl(reference)) throw refuse('The reference must be 60 characters or fewer (a cheque number or slip number).');
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
async function updateDetails(schoolId, studentId, input, { staffId = null, dry = false } = {}, deps = {}) {
  const db = deps.pool || pool;
  const i = input || {};
  const fullName = i.fullName === undefined ? undefined : cleanText(i.fullName);
  if (fullName !== undefined) {
    if (fullName.length < 2) throw refuse('Enter the full name of the student.');
    if (fullName.length > 100 || hasControl(fullName)) throw refuse('The full name must be 100 characters or fewer.');
  }
  const contacts = i.contacts === undefined ? undefined : cleanContacts(i.contacts);
  if (fullName === undefined && contacts === undefined) throw refuse('Nothing to change: send the name or the contacts.');
  const res = await inTransaction(db, dry, async (client) => {
    const s = await loadStudent(client, schoolId, studentId, true);
    const before = { full_name: s.full_name, contacts: (await client.query('SELECT full_name AS name, phone, relationship FROM student_contacts WHERE student_id = $1 ORDER BY sort_order, id', [s.id])).rows };
    const after = { full_name: fullName === undefined ? s.full_name : fullName, contacts: contacts === undefined ? before.contacts : contacts };
    const same = JSON.stringify(before) === JSON.stringify(after);
    if (!same) {
      const first = after.contacts[0] || null;
      await client.query('UPDATE students SET full_name = $1, guardian_name = $2, guardian_phone = $3 WHERE id = $4', [after.full_name, first ? first.name : null, first ? first.phone : null, s.id]);
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
  return { dry, unchanged: res.unchanged, full_name: res.after.full_name, contacts: res.after.contacts };
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

module.exports = { getSheet, getReceipt, recordManualPayment, updateDetails, setStudentStatus, receiptNo, METHODS };