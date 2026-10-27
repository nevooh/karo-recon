const { pool } = require('../db/db');

/**
 * One shared "too many wrong tries" counter, kept in the login_attempts table.
 * The `key` is any text: an email for logins ("admin@school.com"), or
 * "rotate:<staffId>" for wrong passwords typed while resetting bank credentials.
 * Works for keys that do not exist anywhere else, so it gives nothing away.
 */

// Minutes still locked (0 = not locked).
async function lockedMinutes(key) {
  const r = await pool.query(
    `SELECT CEIL(EXTRACT(EPOCH FROM (locked_until - NOW())) / 60)::int AS mins
     FROM login_attempts WHERE email = $1 AND locked_until > NOW()`, [key]);
  return r.rows[0] ? Math.max(r.rows[0].mins, 1) : 0;
}

// Count one wrong try. The Nth wrong try in a row (within lockMinutes) locks the key.
// Returns { locked: true/false }.
async function recordFailure(key, maxFails, lockMinutes) {
  const r = await pool.query(
    `INSERT INTO login_attempts (email, failures, last_failed_at) VALUES ($1, 1, NOW())
     ON CONFLICT (email) DO UPDATE SET
       failures = CASE WHEN login_attempts.last_failed_at < NOW() - make_interval(mins => $3) THEN 1 ELSE login_attempts.failures + 1 END,
       last_failed_at = NOW(),
       locked_until = CASE WHEN (CASE WHEN login_attempts.last_failed_at < NOW() - make_interval(mins => $3) THEN 1 ELSE login_attempts.failures + 1 END) >= $2
                           THEN NOW() + make_interval(mins => $3) ELSE NULL END
     RETURNING locked_until`,
    [key, maxFails, lockMinutes]);
  return { locked: Boolean(r.rows[0].locked_until) };
}

// A correct try clears the count.
async function clearFailures(key) {
  await pool.query(`DELETE FROM login_attempts WHERE email = $1`, [key]);
}

module.exports = { lockedMinutes, recordFailure, clearFailures };