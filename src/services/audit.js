const { pool } = require('../db/db');

/**
 * Writes one line to the audit log: who did what, when.
 * NEVER put passwords, keys or other secrets in `detail`.
 * A failure to write the log is printed but never stops the real action.
 */
async function logAudit({ schoolId = null, staffId = null, action, detail = null, ip = null }) {
  try {
    await pool.query(
      `INSERT INTO audit_log (school_id, staff_id, action, detail, ip) VALUES ($1, $2, $3, $4, $5)`,
      [schoolId, staffId, action, detail ? JSON.stringify(detail) : null, ip]
    );
  } catch (err) {
    console.error('audit log write failed:', err.message);
  }
}

module.exports = { logAudit };