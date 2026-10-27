const { pool } = require('../db/db');

/**
 * The term payments should record against FOR ONE SCHOOL (each school has its own calendar) - computed purely from dates,
 * not a manually-toggled flag. Rule: whichever term's start_date has most
 * recently passed. This is what closes the "holiday gap" problem: between
 * Term 1 ending and Term 2 actually starting, Term 1 stays the answer
 * (nothing has superseded it yet) - no manual "advance" action needed for
 * payments to keep recording correctly. The moment Term 2's start_date
 * arrives, this automatically flips, with zero action from anyone.
 *
 * A frontend can independently show a term as "Ended" by comparing today
 * against end_date - that's a display concern, entirely separate from
 * which term payments actually attach to.
 */
async function getCurrentTerm(schoolId, db = pool) {
  if (!schoolId) throw new Error('getCurrentTerm needs the school (every school has its own calendar)');
  const result = await db.query(
    `SELECT t.id, t.academic_year_id, t.term_number, d.start_date, d.end_date
     FROM school_term_dates d JOIN terms t ON t.id = d.term_id
     WHERE d.school_id = $1 AND d.start_date <= CURRENT_DATE
     ORDER BY d.start_date DESC
     LIMIT 1`,
    [schoolId]
  );
  return result.rows[0] || null;
}

/**
 * The term immediately before this one - term 2 -> term 1 same year,
 * term 1 -> term 3 of the PREVIOUS year. This is what an opening balance
 * carries forward from.
 */
async function getPreviousTerm(term, db = pool) {
  if (term.term_number > 1) {
    const result = await db.query(
      `SELECT * FROM terms WHERE academic_year_id = $1 AND term_number = $2`,
      [term.academic_year_id, term.term_number - 1]
    );
    return result.rows[0] || null;
  }
  const result = await db.query(
    `SELECT t.* FROM terms t
     JOIN academic_years ay ON ay.id = t.academic_year_id
     WHERE ay.year = (SELECT year FROM academic_years WHERE id = $1) - 1
       AND t.term_number = 3`,
    [term.academic_year_id]
  );
  return result.rows[0] || null;
}

// "Bus", " bus " and "BUS" are the same choice.
const nameKey = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Charges ONE student for ONE term and writes their ledger row.
 * The fees come ONLY from the term's lock (term_fee_locks): the version of the student's class fees that
 * billing locked for this exact term. The editable fee structure is never read here, so editing it can not
 * change a term that is already billed.
 *   - mandatory fees: every mandatory line of the locked version.
 *   - optional fees: only the names the student CHOSE (student_optional_choices), billed at the price the
 *     locked version gives. If the class is locked but has no optional fee with that name, the choice is
 *     DROPPED here (the class does not offer it) and its name is returned in `dropped`. If the class has no
 *     lock at all, nothing is dropped: we cannot tell "not offered" from "not set up yet".
 *   - opening balance: whatever was left at the end of the previous term, plus any starting balance
 *     saved for this student and this term.
 * Safe to repeat: fees and opening balance are recalculated, amount_paid is never touched.
 * `db` can be a transaction client, so the caller decides when it commits.
 */
async function chargeStudentForTerm(db, student, term, previousTerm) {
  // The class's LOCKED fees for this exact term: the version of the class's fees that billing locked
  // (term_fee_locks points at a template version, and versions never change). No lock = the class has not been
  // billed yet: nothing is charged and no optional choice is dropped.
  const locked = (await db.query(
    `SELECT i.name, i.amount, i.is_mandatory
     FROM term_fee_locks l JOIN fee_template_items i ON i.template_id = l.template_id
     WHERE l.school_id = $1 AND l.term_id = $2 AND l.class_id = $3`,
    [student.school_id, term.id, student.class_id]
  )).rows;
  const mandatoryTotal = locked.filter((r) => r.is_mandatory).reduce((a, r) => a + Number(r.amount), 0);
  const offered = locked.filter((r) => !r.is_mandatory);
  const hasStructure = locked.length > 0;

  const choices = (await db.query(
    `SELECT id, name, name_key FROM student_optional_choices WHERE student_id = $1`,
    [student.id]
  )).rows;

  let optionalTotal = 0;
  const dropped = [];
  for (const choice of choices) {
    const pick = offered.find((o) => nameKey(o.name) === choice.name_key);
    if (pick) optionalTotal += Number(pick.amount);
    else if (hasStructure) {
      await db.query(`DELETE FROM student_optional_choices WHERE id = $1`, [choice.id]);
      dropped.push(choice.name);
    }
  }
  const feesCharged = mandatoryTotal + optionalTotal;

  let openingBalance = 0;
  if (previousTerm) {
    const prevLedgerResult = await db.query(
      `SELECT opening_balance, fees_charged, amount_paid FROM student_term_ledger
       WHERE student_id = $1 AND term_id = $2`,
      [student.id, previousTerm.id]
    );
    const prevLedger = prevLedgerResult.rows[0];
    if (prevLedger) {
      openingBalance = Number(prevLedger.opening_balance) + Number(prevLedger.fees_charged) - Number(prevLedger.amount_paid);
    }
  }
  const startResult = await db.query(
    `SELECT amount FROM student_starting_balance WHERE student_id = $1 AND term_id = $2`,
    [student.id, term.id]
  );
  if (startResult.rows[0]) openingBalance += Number(startResult.rows[0].amount);

  await db.query(
    `INSERT INTO student_term_ledger (student_id, term_id, opening_balance, fees_charged, amount_paid)
     VALUES ($1, $2, $3, $4, 0)
     ON CONFLICT (student_id, term_id)
     DO UPDATE SET opening_balance = $3, fees_charged = $4`,
    [student.id, term.id, openingBalance, feesCharged]
  );
  return { feesCharged, openingBalance, dropped };
}

/**
 * The actual amount owed right now: positive = still owed, negative =
 * credit/overpayment. This is what the matching engine should compare
 * incoming payments against, instead of the old flat balance column.
 */
async function getOutstandingBalance(studentId, termId) {
  const result = await pool.query(
    `SELECT opening_balance, fees_charged, amount_paid FROM student_term_ledger
     WHERE student_id = $1 AND term_id = $2`,
    [studentId, termId]
  );
  const ledger = result.rows[0];
  if (!ledger) return 0;
  return Number(ledger.opening_balance) + Number(ledger.fees_charged) - Number(ledger.amount_paid);
}

/**
 * Applies a payment to a student's current-term ledger. If somehow no
 * ledger row exists yet (chargeFeesForTerm wasn't run for them), creates
 * one with zero opening/fees so the payment still isn't lost.
 */
async function applyPayment(studentId, termId, amount, db = pool) {
  // `db` lets a caller pass its own transaction client, so the ledger update
  // commits or rolls back together with whatever else that caller is doing.
  await db.query(
    `INSERT INTO student_term_ledger (student_id, term_id, opening_balance, fees_charged, amount_paid)
     VALUES ($1, $2, 0, 0, $3)
     ON CONFLICT (student_id, term_id)
     DO UPDATE SET amount_paid = student_term_ledger.amount_paid + $3`,
    [studentId, termId, amount]
  );
}

/**
 * All students for a school, with their CURRENT outstanding balance
 * computed from the ledger instead of a flat column - this is what
 * ingest.js hands to the matching engine.
 */
async function getStudentsWithOutstanding(schoolId, termId) {
  const result = await pool.query(
    `SELECT s.*, COALESCE(
       stl.opening_balance + stl.fees_charged - stl.amount_paid, 0
     ) AS balance
     FROM students s
     LEFT JOIN student_term_ledger stl ON stl.student_id = s.id AND stl.term_id = $2
     WHERE s.school_id = $1`,
    [schoolId, termId]
  );
  return result.rows;
}

module.exports = {
  getCurrentTerm, getPreviousTerm, chargeStudentForTerm, nameKey,
  getOutstandingBalance, applyPayment, getStudentsWithOutstanding,
};