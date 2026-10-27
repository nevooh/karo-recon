/**
 * The "danger zone" lock for bank credentials. Every route that CREATES or
 * REPLACES a bank connection's credentials goes through here, so the rules
 * live in ONE place and cannot be skipped by calling a different route.
 *
 * Who may reach this: the route must already use requireAdmin (Admin only).
 *
 * FIRST TIME (the school has no connection for that bank yet):
 *   an Admin may create it. Nothing existing can break, so no extra checks.
 *
 * REPLACING (a connection already exists - the old password stops working):
 *   1. confirm_text  - the school's exact name, or the word RESET
 *   2. password      - the logged-in admin's OWN password, typed again
 *                      (5 wrong tries in a row locks this for 15 minutes)
 *   3. 10 minutes must have passed since the last reset of that bank
 *   Then the change is made and written to the audit log (who, when, which bank).
 *   The audit log never contains the new password or any key.
 */
const { pool } = require('../db/db');
const { verifyPassword } = require('../security/auth');
const { lockedMinutes, recordFailure, clearFailures } = require('./lock');
const { logAudit } = require('./audit');

const COOLDOWN_MINUTES = 10;
const MAX_WRONG_PASSWORDS = 5;
const PASSWORD_LOCK_MINUTES = 15;

function refuse(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
const plural = (n) => `${n} minute${n === 1 ? '' : 's'}`;

// Runs the checks. Returns { mode: 'create' | 'replace', rollback() }.
async function guardCredentialChange({ schoolId, staffId, bank, body, ip }) {
  const found = await pool.query(
    `SELECT sbc.id, sbc.last_rotated_at
       FROM school_bank_connections sbc JOIN bank_providers bp ON bp.id = sbc.provider_id
      WHERE sbc.school_id = $1 AND bp.code = $2`, [schoolId, bank]);
  const conn = found.rows[0];
  if (!conn) return { mode: 'create', rollback: async () => {} };

  const input = body || {};

  // 1. Type the school's name or RESET
  const school = (await pool.query(`SELECT name FROM schools WHERE id = $1`, [schoolId])).rows[0];
  const typed = String(input.confirm_text || '').trim().toLowerCase();
  const okText = typed === 'reset' || (school && typed === String(school.name).trim().toLowerCase());
  if (!okText) throw refuse(400, "To replace these credentials, type the school's exact name or the word RESET");

  // 2. Your own password again
  if (!input.password) throw refuse(400, 'Enter your own password to confirm');
  const pwKey = 'rotate:' + staffId;
  const mins = await lockedMinutes(pwKey);
  if (mins) throw refuse(429, `Too many wrong passwords. Try again in ${plural(mins)}.`);
  const me = (await pool.query(`SELECT password_hash FROM staff WHERE id = $1 AND school_id = $2 AND status = 'active'`, [staffId, schoolId])).rows[0];
  const valid = me ? await verifyPassword(String(input.password), me.password_hash) : false;
  if (!valid) {
    const { locked } = await recordFailure(pwKey, MAX_WRONG_PASSWORDS, PASSWORD_LOCK_MINUTES);
    await logAudit({ schoolId, staffId, action: 'credentials_reset_wrong_password', detail: { bank }, ip });
    if (locked) throw refuse(429, `Too many wrong passwords. Try again in ${plural(PASSWORD_LOCK_MINUTES)}.`);
    throw refuse(403, 'Wrong password');
  }
  await clearFailures(pwKey);

  // 3. The wait. One single statement claims the slot, so two people pressing at the
  //    same moment cannot both get through.
  const claim = await pool.query(
    `UPDATE school_bank_connections SET last_rotated_at = NOW()
      WHERE id = $1 AND (last_rotated_at IS NULL OR last_rotated_at <= NOW() - make_interval(mins => $2))
      RETURNING id`, [conn.id, COOLDOWN_MINUTES]);
  if (claim.rows.length === 0) {
    const w = await pool.query(
      `SELECT CEIL(EXTRACT(EPOCH FROM (last_rotated_at + make_interval(mins => $2) - NOW())) / 60)::int AS mins
         FROM school_bank_connections WHERE id = $1`, [conn.id, COOLDOWN_MINUTES]);
    const wait = Math.max((w.rows[0] && w.rows[0].mins) || 1, 1);
    throw refuse(429, `These credentials were reset a moment ago. Wait ${plural(wait)} before resetting again.`);
  }

  // If the change then fails, give the slot back so the admin can try again at once.
  const previous = conn.last_rotated_at;
  return {
    mode: 'replace',
    rollback: async () => {
      await pool.query(`UPDATE school_bank_connections SET last_rotated_at = $2 WHERE id = $1`, [conn.id, previous]);
    },
  };
}

/**
 * Use this in a route:  const result = await changeCredentials({...}, () => doTheChange());
 * It runs the guard, then your function, then writes the audit entry.
 */
async function changeCredentials({ schoolId, staffId, bank, body, ip }, doTheChange) {
  const guard = await guardCredentialChange({ schoolId, staffId, bank, body, ip });
  let result;
  try {
    result = await doTheChange();
  } catch (err) {
    await guard.rollback();
    throw err;
  }
  await logAudit({
    schoolId, staffId, ip,
    action: guard.mode === 'replace' ? 'credentials_rotated' : 'credentials_created',
    detail: { bank },
  });
  return result;
}

/**
 * Two of the same checks, for things that are not a "bank connection" row (M-Pesa keys, M-Pesa registration).
 * They follow exactly the same rules as above:
 *   checkConfirmText  - the school's exact name, or the word RESET
 *   checkAdminPassword - the logged-in admin's OWN password again (5 wrong tries locks it for 15 minutes,
 *                        counted together with the bank-credential resets), every wrong try is audited
 * Both throw an Error with .status (400 / 403 / 429) and a message the screen can show as it is.
 */
async function checkConfirmText({ schoolId, text }) {
  const school = (await pool.query(`SELECT name FROM schools WHERE id = $1`, [schoolId])).rows[0];
  const typed = String(text || '').trim().toLowerCase();
  const ok = typed === 'reset' || (school && typed === String(school.name).trim().toLowerCase());
  if (!ok) throw refuse(400, "To continue, type the school's exact name or the word RESET");
}

async function checkAdminPassword({ schoolId, staffId, password, ip, what }) {
  if (!password) throw refuse(400, 'Enter your own password to confirm');
  const pwKey = 'rotate:' + staffId;
  const mins = await lockedMinutes(pwKey);
  if (mins) throw refuse(429, `Too many wrong passwords. Try again in ${plural(mins)}.`);
  const me = (await pool.query(`SELECT password_hash FROM staff WHERE id = $1 AND school_id = $2 AND status = 'active'`, [staffId, schoolId])).rows[0];
  const valid = me ? await verifyPassword(String(password), me.password_hash) : false;
  if (!valid) {
    const { locked } = await recordFailure(pwKey, MAX_WRONG_PASSWORDS, PASSWORD_LOCK_MINUTES);
    await logAudit({ schoolId, staffId, action: 'credentials_reset_wrong_password', detail: { bank: what || null }, ip });
    if (locked) throw refuse(429, `Too many wrong passwords. Try again in ${plural(PASSWORD_LOCK_MINUTES)}.`);
    throw refuse(403, 'Wrong password');
  }
  await clearFailures(pwKey);
}

module.exports = { changeCredentials, guardCredentialChange, checkConfirmText, checkAdminPassword, COOLDOWN_MINUTES };