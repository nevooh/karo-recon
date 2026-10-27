/**
 * The platform owner's console: log in, add a school with its main admin, list schools with student counts.
 * Nothing here touches a school's bank keys, M-Pesa keys or passkeys.
 */
const { pool } = require('../db/db');
const { hashPassword, verifyPassword, generateOwnerToken } = require('../security/auth');
const { lockedMinutes, recordFailure, clearFailures } = require('./lock');
const { createSchoolWithAdmin, normalizeEmail } = require('./schoolSetup');

const MAX_FAILS = 5, LOCK_MINUTES = 15;
function refuse(message, status = 400) { const e = new Error(message); e.status = status; return e; }

async function createOwner({ email, fullName, password }, db = pool) {
  const mail = normalizeEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(mail)) throw refuse('Enter a valid email.');
  if (String(password || '').length < 12) throw refuse('Owner password must be at least 12 characters.');
  const name = String(fullName || '').trim() || 'Owner';
  const hash = await hashPassword(String(password));
  const r = await db.query(
    `INSERT INTO platform_owners (email, full_name, password_hash) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, full_name = EXCLUDED.full_name, token_version = platform_owners.token_version + 1
     RETURNING id, email, full_name`, [mail, name, hash]);
  return r.rows[0];
}

async function login(emailInput, password) {
  const mail = normalizeEmail(emailInput);
  const key = 'owner:' + mail;
  const mins = await lockedMinutes(key);
  if (mins) throw refuse(`Too many wrong tries. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`, 429);
  const o = (await pool.query('SELECT id, email, full_name, password_hash, token_version FROM platform_owners WHERE email = $1', [mail])).rows[0];
  const ok = await verifyPassword(String(password || ''), o && o.password_hash);
  if (!o || !ok) {
    const { locked } = await recordFailure(key, MAX_FAILS, LOCK_MINUTES);
    throw refuse(locked ? `Too many wrong tries. Try again in ${LOCK_MINUTES} minutes.` : 'Wrong email or password.', locked ? 429 : 401);
  }
  await clearFailures(key);
  await pool.query('UPDATE platform_owners SET last_login_at = NOW() WHERE id = $1', [o.id]);
  return { token: generateOwnerToken({ ownerId: o.id, tv: o.token_version }), owner: { email: o.email, full_name: o.full_name } };
}

// Every school: main admin + students in school now (active or repeating). Newest first.
async function listSchools(db = pool) {
  const r = await db.query(
    `SELECT sc.id, sc.name, sc.created_at,
            (SELECT COUNT(*)::int FROM students s WHERE s.school_id = sc.id AND s.status IN ('active','repeating')) AS students,
            a.full_name AS admin_name, a.email AS admin_email, a.status AS admin_status
     FROM schools sc
     LEFT JOIN LATERAL (SELECT full_name, email, status FROM staff WHERE school_id = sc.id AND is_owner ORDER BY id LIMIT 1) a ON TRUE
     ORDER BY sc.id DESC`);
  return { schools: r.rows, total_schools: r.rows.length, total_students: r.rows.reduce((n, x) => n + x.students, 0) };
}

// Adds a school and its main admin. The admin's password is generated and returned ONCE (it is never stored in plain text).
async function addSchool({ name, adminName, adminEmail }) {
  const out = await createSchoolWithAdmin({ name, adminName, adminEmail });
  return { school: out.school, admin: out.admin, password: out.password };
}

module.exports = { createOwner, login, listSchools, addSchool };