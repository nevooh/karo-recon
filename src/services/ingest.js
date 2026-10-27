const { pool } = require('../db/db');
const { matchTransaction } = require('../matching/matcher');
const { getCurrentTerm, getStudentsWithOutstanding, applyPayment } = require('./feeLedger');

/**
 * Single entry point for any incoming payment, regardless of source.
 */
async function ingestPayment(payment) {
  const {
    school_id, source, external_ref, amount,
    payer_phone = null, payer_name = null, narration = null, raw = {},
  } = payment;

  if (!school_id || !source || !external_ref || amount == null) {
    throw new Error('ingestPayment: school_id, source, external_ref, and amount are required');
  }

  const client = await pool.connect();
  try {
    const existing = await client.query(
      `SELECT id FROM transactions WHERE source = $1 AND external_ref = $2`,
      [source, external_ref]
    );
    if (existing.rows.length > 0) {
      return { alreadyProcessed: true, transactionId: existing.rows[0].id };
    }

    // Balance now comes from the term ledger, not a flat column - but if
    // no academic year/term has been set up yet, fall back to a plain
    // student list with balance=0 so testing without fee structure still
    // works (just without the "amount matches balance" matching signal).
    const currentTerm = await getCurrentTerm(school_id, client);
    let students;
    if (currentTerm) {
      students = await getStudentsWithOutstanding(school_id, currentTerm.id);
    } else {
      const fallback = await client.query(`SELECT *, 0 AS balance FROM students WHERE school_id = $1`, [school_id]);
      students = fallback.rows;
    }

    // Only the reference and the amount go to the matcher. Names and phone
    // numbers are still SAVED with the payment, but never used to match.
    const txnForMatching = { narration, amount };
    const match = matchTransaction(txnForMatching, students);

    const insertResult = await client.query(
      `INSERT INTO transactions
        (school_id, term_id, source, external_ref, amount, payer_phone, payer_name, narration,
         raw_payload, match_status, matched_student_id, confidence, match_reason, candidates)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING id`,
      [
        school_id, currentTerm ? currentTerm.id : null, source, external_ref, amount, payer_phone, payer_name, narration,
        JSON.stringify(raw), match.status, match.student ? match.student.id : null,
        null, match.reason, match.candidates ? JSON.stringify(match.candidates) : null,
      ]
    );

    if (match.status === 'auto_matched' && match.student) {
      if (currentTerm) {
        await applyPayment(match.student.id, currentTerm.id, amount);
      }
      // if no fee structure set up yet, the payment is still recorded in
      // transactions above - just not applied to any ledger balance yet
    }

    return {
      alreadyProcessed: false,
      transactionId: insertResult.rows[0].id,
      match,
    };
  } finally {
    client.release();
  }
}

module.exports = { ingestPayment };