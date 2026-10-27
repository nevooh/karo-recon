const { pool } = require('../db/db');

/**
 * Replaces a SCHOOL's class fee items for a specific term with a new set,
 * archiving the old ones first (never deleted, just moved to history).
 * Only that class's version bumps - every other class is untouched, and
 * this never touches another school's fee_items at all.
 *
 * Enforces the core rule: you can only edit a term that HASN'T STARTED
 * YET. Once a term begins, its charged amounts are locked - editing only
 * ever affects future terms, never rewrites what's already in progress.
 *
 * @param {number} schoolId
 * @param {number} classId
 * @param {number} termId
 * @param {Array<{name, amount, is_mandatory}>} newFeeItems
 */
async function setClassFeesForTerm(schoolId, classId, termId, newFeeItems) {
  const termResult = await pool.query(`SELECT * FROM terms WHERE id = $1`, [termId]);
  const term = termResult.rows[0];
  if (!term) throw new Error(`No term found with id ${termId}`);

  const alreadyStarted = term.start_date && new Date(term.start_date) <= new Date();
  if (alreadyStarted) {
    throw new Error(
      `Cannot edit fees for this term - it already started on ${term.start_date.toISOString().slice(0, 10)}. ` +
      `Fee changes only apply to terms that haven't begun yet.`
    );
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existingResult = await client.query(
      `SELECT * FROM fee_items WHERE school_id = $1 AND term_id = $2 AND class_id IS NOT DISTINCT FROM $3`,
      [schoolId, termId, classId]
    );
    const existing = existingResult.rows;

    for (const row of existing) {
      await client.query(
        `INSERT INTO fee_item_history (school_id, term_id, class_id, name, amount, is_mandatory, version)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [row.school_id, row.term_id, row.class_id, row.name, row.amount, row.is_mandatory, row.version]
      );
    }

    const currentVersion = existing.length > 0 ? Math.max(...existing.map((r) => r.version)) : 0;
    const newVersion = currentVersion + 1;

    await client.query(
      `DELETE FROM fee_items WHERE school_id = $1 AND term_id = $2 AND class_id IS NOT DISTINCT FROM $3`,
      [schoolId, termId, classId]
    );

    const inserted = [];
    for (const item of newFeeItems) {
      const result = await client.query(
        `INSERT INTO fee_items (school_id, term_id, class_id, name, amount, is_mandatory, version)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [schoolId, termId, classId, item.name, item.amount, item.is_mandatory !== false, newVersion]
      );
      inserted.push(result.rows[0]);
    }

    await client.query('COMMIT');
    return { version: newVersion, archivedCount: existing.length, newFeeItems: inserted };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getClassFeeHistory(schoolId, classId, termId) {
  const result = await pool.query(
    `SELECT * FROM fee_item_history WHERE school_id = $1 AND term_id = $2 AND class_id IS NOT DISTINCT FROM $3
     ORDER BY version ASC, replaced_at ASC`,
    [schoolId, termId, classId]
  );
  return result.rows;
}

module.exports = { setClassFeesForTerm, getClassFeeHistory };
