const { pool } = require('../db/db');

// Columns that are safe to send to a client. password_hash is deliberately
// NOT here - it must never leave the server. has_password tells the UI
// whether the account can log in yet, without exposing the hash.
const SAFE_STAFF_COLUMNS =
  `id, school_id, full_name, email, role, status, created_at, (password_hash IS NOT NULL) AS has_password`;

async function createStaffAccount({ schoolId, fullName, email = null, role = 'staff' }) {
  const result = await pool.query(
    `INSERT INTO staff (school_id, full_name, email, role) VALUES ($1, $2, $3, $4) RETURNING ${SAFE_STAFF_COLUMNS}`,
    [schoolId, fullName, email, role]
  );
  return result.rows[0];
}

async function listStaffForSchool(schoolId) {
  const result = await pool.query(
    `SELECT ${SAFE_STAFF_COLUMNS} FROM staff WHERE school_id = $1 AND status = 'active' ORDER BY full_name`,
    [schoolId]
  );
  return result.rows;
}

/**
 * Confirms a staff account belongs to the SAME school as the transaction
 * they're trying to act on - even without login yet, this prevents one
 * school's staff id from being used against another school's data.
 */
async function staffBelongsToSchool(staffId, schoolId) {
  const result = await pool.query(
    `SELECT id FROM staff WHERE id = $1 AND school_id = $2 AND status = 'active'`,
    [staffId, schoolId]
  );
  return result.rows.length > 0;
}

module.exports = { createStaffAccount, listStaffForSchool, staffBelongsToSchool };