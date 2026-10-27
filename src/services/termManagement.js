const { pool } = require('../db/db');

/**
 * Updates a term's dates, enforcing: end_date can change any time, but
 * start_date can only change if the term hasn't actually started yet
 * (its current start_date is in the future, or unset).
 */
async function updateTermDates(termId, { start_date, end_date }) {
  const termResult = await pool.query(`SELECT * FROM terms WHERE id = $1`, [termId]);
  const term = termResult.rows[0];
  if (!term) throw new Error(`No term found with id ${termId}`);

  const alreadyStarted = term.start_date && new Date(term.start_date) <= new Date();

  if (start_date && alreadyStarted) {
    throw new Error(
      `Cannot change the start date - this term already started on ${term.start_date.toISOString().slice(0, 10)}. ` +
      `The end date can still be changed.`
    );
  }

  const result = await pool.query(
    `UPDATE terms SET
       start_date = COALESCE($1, start_date),
       end_date = COALESCE($2, end_date)
     WHERE id = $3
     RETURNING *`,
    [start_date || null, end_date || null, termId]
  );
  return result.rows[0];
}

/**
 * Moves the "current" pointer forward: term 1 -> term 2 -> term 3.
 * Does NOT handle term 3 -> new year's term 1 - that has to go through
 * promotion first (see promotion.js), never a silent auto-advance.
 */
async function advanceToNextTerm(academicYearId, currentTermNumber) {
  if (currentTermNumber >= 3) {
    throw new Error(
      'Cannot auto-advance past term 3 - promotion must run first, then a new academic year/term 1 is created explicitly.'
    );
  }
  await pool.query(`UPDATE terms SET is_current = FALSE WHERE academic_year_id = $1`, [academicYearId]);
  const result = await pool.query(
    `UPDATE terms SET is_current = TRUE WHERE academic_year_id = $1 AND term_number = $2 RETURNING *`,
    [academicYearId, currentTermNumber + 1]
  );
  return result.rows[0];
}

module.exports = { updateTermDates, advanceToNextTerm };