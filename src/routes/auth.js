const express = require('express');
const { pool } = require('../db/db');
const { hashPassword, verifyPassword, generateToken } = require('../security/auth');
const { requireAuth } = require('../middleware/auth');
const { logAudit } = require('../services/audit');
const staffAdmin = require('../services/staffAdmin');
const { lockedMinutes, recordFailure, clearFailures } = require('../services/lock');

const router = express.Router();

/**
 * Login: email + password -> a token good for 12 hours. Deliberately
 * generic error message on failure ("invalid email or password") rather
 * than "wrong password" vs "no such email" - doesn't help an attacker
 * enumerate which emails exist in the system.
 */
// Login lock: 5 wrong passwords in a row locks that email for 15 minutes.
// It counts emails that do not exist too, so the answer never reveals which
// emails are real. A correct login clears the count.
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
const lockedMessage = (mins) => `Too many wrong attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`;

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
  const key = String(email).trim().toLowerCase();

  // 1. Already locked? Refuse, even if the password would have been right.
  const mins = await lockedMinutes(key);
  if (mins) return res.status(429).json({ error: lockedMessage(mins) });

  // 2. Check the password.
  const result = await pool.query(`SELECT * FROM staff WHERE lower(email) = $1 AND status = 'active'`, [key]);   // capitals in the email do not matter
  const staff = result.rows[0];
  const valid = staff ? await verifyPassword(password, staff.password_hash) : false;

  // 3. Wrong: count it. The 5th wrong one in a row (within 15 min) locks the email.
  if (!valid) {
    const { locked } = await recordFailure(key, MAX_FAILS, LOCK_MINUTES);
    if (staff && !locked) await logAudit({ schoolId: staff.school_id, staffId: staff.id, action: 'login_failed', ip: req.ip });   // only for real accounts, so it never reveals which emails exist
    if (locked) {
      if (staff) await logAudit({ schoolId: staff.school_id, staffId: staff.id, action: 'login_locked', ip: req.ip });
      return res.status(429).json({ error: lockedMessage(LOCK_MINUTES) });
    }
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  // 4. Right: clear the count, record the login, hand over the token.
  await clearFailures(key);
  await logAudit({ schoolId: staff.school_id, staffId: staff.id, action: 'login', ip: req.ip });
  await pool.query('UPDATE staff SET last_login_at = NOW() WHERE id = $1', [staff.id]);
  const token = generateToken({ staffId: staff.id, schoolId: staff.school_id, tv: staff.token_version });
  res.json({ token, staff: { id: staff.id, full_name: staff.full_name, school_id: staff.school_id, role: staff.role, is_owner: staff.is_owner } });
});

const fail = (res, e, next) => (e && e.status ? res.status(e.status).json({ error: e.message }) : next(e));

// Change MY password (current one needed). Other browsers signed in as me are signed out; this one gets a fresh token.
router.post('/change-password', requireAuth, async (req, res, next) => {
  try {
    const r = await staffAdmin.changeOwnPassword({ schoolId: req.staff.schoolId, staffId: req.staff.staffId, current: (req.body || {}).current, next: (req.body || {}).password, ip: req.ip });
    res.json(r);
  } catch (e) { fail(res, e, next); }
});

// "Forgot password": always the same answer, so it never shows which emails exist.
router.post('/forgot', async (req, res, next) => {
  try { res.json(await staffAdmin.forgotPassword({ email: (req.body || {}).email, ip: req.ip })); } catch (e) { fail(res, e, next); }
});

// The one-time link: look at it, then use it.
router.post('/token-info', async (req, res, next) => {
  try { res.json(await staffAdmin.tokenInfo((req.body || {}).token)); } catch (e) { fail(res, e, next); }
});
router.post('/complete', async (req, res, next) => {
  try { res.json(await staffAdmin.completeToken({ token: (req.body || {}).token, password: (req.body || {}).password, ip: req.ip })); } catch (e) { fail(res, e, next); }
});

module.exports = router;