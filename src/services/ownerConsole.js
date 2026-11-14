/**
 * The platform owner's console: log in, add a school with its main admin, list schools with student counts.
 * Nothing here touches a school's bank keys, M-Pesa keys or passkeys.
 */
const { pool } = require('../db/db');
const { hashPassword, verifyPassword, generateOwnerToken } = require('../security/auth');
const { lockedMinutes, recordFailure, clearFailures } = require('./lock');
const { createSchoolWithAdmin, normalizeEmail, generatePassword } = require('./schoolSetup');
const { CHANNELS, ensureSelected } = require('./channels');
const { saveMpesaKeys, validateKeysInput, checkKeys, registerForSchool } = require('./mpesaSetup');
const { passkeyState, savePasskey } = require('./mpesaPasskey');

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
    `SELECT sc.id, sc.name, sc.created_at, sc.suspended_at,
            (SELECT COUNT(*)::int FROM students s WHERE s.school_id = sc.id AND s.status IN ('active','repeating')) AS students,
            a.full_name AS admin_name, a.email AS admin_email, a.status AS admin_status, a.last_login_at AS admin_last_login,
            (SELECT MAX(received_at) FROM transactions t WHERE t.school_id = sc.id) AS last_payment_at,
            (SELECT COUNT(*)::int FROM transactions t WHERE t.school_id = sc.id AND t.received_at > NOW() - INTERVAL '14 days') AS payments_14d,
            (SELECT COUNT(*)::int FROM transactions t WHERE t.school_id = sc.id AND t.match_status IN ('needs_review','unmatched')) AS in_review,
            COALESCE((SELECT json_agg(c.channel ORDER BY c.channel) FROM school_channels c WHERE c.school_id = sc.id), '[]'::json) AS channels
     FROM schools sc
     LEFT JOIN LATERAL (SELECT full_name, email, status, last_login_at FROM staff WHERE school_id = sc.id AND is_owner ORDER BY id LIMIT 1) a ON TRUE
     ORDER BY sc.id DESC`);
  return { schools: r.rows, total_schools: r.rows.length, total_students: r.rows.reduce((n, x) => n + x.students, 0) };
}

// A new password for the school's main admin, shown ONCE. Their other sign-ins stop working.
async function resetAdminPassword(schoolId, db = pool) {
  if (!Number.isInteger(schoolId)) throw refuse('School not found.', 404);
  const a = (await db.query(`SELECT id, full_name, email FROM staff WHERE school_id = $1 AND is_owner AND status = 'active' ORDER BY id LIMIT 1`, [schoolId])).rows[0];
  if (!a) throw refuse('This school has no active main admin.', 404);
  const password = generatePassword();
  await db.query('UPDATE staff SET password_hash = $1, token_version = token_version + 1 WHERE id = $2', [await hashPassword(password), a.id]);
  try { await clearFailures(String(a.email || '').toLowerCase()); } catch (e) { /* the lock count is only a convenience here */ }
  return { admin: { full_name: a.full_name, email: a.email }, password };
}

// Pause or resume a school. Pausing signs every staff member out and blocks sign-in; payments keep being recorded.
async function setSchoolPaused(schoolId, paused, db = pool) {
  if (!Number.isInteger(schoolId)) throw refuse('School not found.', 404);
  const r = await db.query('UPDATE schools SET suspended_at = CASE WHEN $2 THEN COALESCE(suspended_at, NOW()) ELSE NULL END WHERE id = $1', [schoolId, !!paused]);
  if (!r.rowCount) throw refuse('School not found.', 404);
  if (paused) await db.query('UPDATE staff SET token_version = token_version + 1 WHERE school_id = $1', [schoolId]);
  return { ok: true, paused: !!paused };
}

// Switch a bank (or M-Pesa) on for a school. This only makes it visible; the school still does its own set-up.
async function addSchoolChannel(schoolId, channel, db = pool) {
  if (!Number.isInteger(schoolId)) throw refuse('School not found.', 404);
  if (!CHANNELS.includes(channel)) throw refuse('Unknown bank or channel.');
  if (!(await db.query('SELECT 1 FROM schools WHERE id = $1', [schoolId])).rowCount) throw refuse('School not found.', 404);
  await ensureSelected(schoolId, channel);
  return { ok: true };
}

// Adds a school and its main admin. The admin's password is generated and returned ONCE (it is never stored in plain text).
async function addSchool({ name, adminName, adminEmail }) {
  const out = await createSchoolWithAdmin({ name, adminName, adminEmail });
  return { school: out.school, admin: out.admin, password: out.password };
}

async function listApplications(db = pool) {
  const r = await db.query(`SELECT * FROM school_applications ORDER BY (status = 'new') DESC, id DESC LIMIT 300`);
  return { applications: r.rows, new_count: r.rows.filter((x) => x.status === 'new').length };
}

async function updateApplication(id, { status, note }, db = pool) {
  if (!Number.isInteger(id) || id < 1) throw refuse('Application not found.', 404);
  if (!['new', 'contacted', 'accepted', 'declined'].includes(status)) throw refuse('Unknown status.');
  const r = await db.query('UPDATE school_applications SET status = $2, note = COALESCE($3, note) WHERE id = $1', [id, status, note == null ? null : String(note).slice(0, 500)]);
  if (!r.rowCount) throw refuse('Application not found.', 404);
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// M-Pesa set-up on a school's behalf. SECURITY RULES, all of them on purpose:
//  1. Keys are WRITE-ONLY. Nothing here can read a saved key back, and nothing returns one.
//  2. Every save asks for the owner's password again, even though the owner is signed in. Wrong tries are counted and lock.
//  3. Replacing something already saved also needs the typed word RESET.
//  4. Every action is written to the SCHOOL's activity log as "Zuvy Technologies". If that line cannot be written, the owner sees an error.
// ---------------------------------------------------------------------------------------------
async function reauth(ownerId, password, ip) {
  const key = 'owner-keys:' + ownerId;
  const mins = await lockedMinutes(key);
  if (mins) throw refuse('Too many wrong passwords. Try again in ' + mins + ' minutes.', 429);
  const o = (await pool.query('SELECT password_hash FROM platform_owners WHERE id = $1', [ownerId])).rows[0];
  const ok = o ? await verifyPassword(String(password || ''), o.password_hash) : false;
  if (!ok) {
    const { locked } = await recordFailure(key, MAX_FAILS, LOCK_MINUTES);
    throw refuse(locked ? 'Too many wrong passwords. Locked for ' + LOCK_MINUTES + ' minutes.' : 'Your owner password is not right.', locked ? 429 : 403);
  }
  await clearFailures(key);
}

// Unlike the normal log helper, this one does NOT swallow a failure: the school must be able to see what we did.
async function auditStrict({ schoolId, action, detail, ip }) {
  await pool.query('INSERT INTO audit_log (school_id, staff_id, action, detail, ip) VALUES ($1, NULL, $2, $3, $4)',
    [schoolId, action, JSON.stringify({ ...(detail || {}), by: 'zuvy' }), ip || null]);
}

async function mpesaState(schoolId) {
  if (!Number.isInteger(schoolId)) throw refuse('School not found.', 404);
  const sc = (await pool.query(
    `SELECT name, mpesa_shortcode, (mpesa_consumer_key_enc IS NOT NULL AND mpesa_consumer_secret_enc IS NOT NULL) AS keys_saved FROM schools WHERE id = $1`, [schoolId])).rows[0];
  if (!sc) throw refuse('School not found.', 404);
  const pk = await passkeyState(schoolId);
  return { school: sc.name, paybill: sc.mpesa_shortcode || null, keys_saved: !!sc.keys_saved, passkey_saved: !!pk.hasPasskey };   // only yes/no: never a key
}

async function ownerSaveMpesaKeys({ owner, ip, schoolId, paybill, consumerKey, consumerSecret, password, confirmText }) {
  const input = { paybill, consumerKey, consumerSecret };
  validateKeysInput(input);                                         // a typo never costs a password attempt
  const st = await mpesaState(schoolId);
  if (st.keys_saved && String(confirmText || '').trim().toUpperCase() !== 'RESET') throw refuse('Type RESET to replace keys that are already saved.');
  await reauth(owner.id, password, ip);
  const { replaced } = await saveMpesaKeys({ schoolId, ...input });
  await ensureSelected(schoolId, 'mpesa');
  await auditStrict({ schoolId, action: replaced ? 'mpesa_keys_replaced' : 'mpesa_keys_saved', detail: {}, ip });
  return { ok: true, replaced };
}

async function ownerSavePasskey({ owner, ip, schoolId, passkey, password, confirmText }) {
  const st = await passkeyState(schoolId);
  if (st.hasPasskey && String(confirmText || '').trim().toUpperCase() !== 'RESET') throw refuse('Type RESET to replace a passkey that is already saved.');
  await reauth(owner.id, password, ip);
  const r = await savePasskey(schoolId, passkey, { replace: st.hasPasskey, staffId: null, by: 'zuvy' });   // logs itself, as Zuvy
  return { ok: true, replaced: r.replaced };
}

async function ownerCheckMpesa({ ip, schoolId }) {
  const result = await checkKeys(schoolId);                          // asks Safaricom if the keys work; registers nothing
  await auditStrict({ schoolId, action: 'mpesa_keys_checked', detail: { ok: result.ok, reason: result.reason || null }, ip });
  return result;
}

async function ownerRegisterMpesa({ owner, ip, schoolId, dry, confirmPaybill, password }) {
  const base = process.env.PUBLIC_BASE_URL;
  const rehearsal = await registerForSchool({ schoolId, staffId: null, base, dry: true });
  if (dry) return { ok: true, dry: true, preview: rehearsal.preview };
  const typed = String(confirmPaybill || '').replace(/\s+/g, '');
  if (!typed || typed !== rehearsal.school.shortcode) throw refuse("Type the school's Paybill number to confirm.");
  await reauth(owner.id, password, ip);
  const result = await registerForSchool({ schoolId, staffId: null, base, by: 'zuvy' });   // logs itself, as Zuvy
  await ensureSelected(schoolId, 'mpesa');
  return { ok: true, preview: result.preview };
}

module.exports = { createOwner, login, listSchools, addSchool, listApplications, updateApplication, resetAdminPassword, setSchoolPaused, addSchoolChannel, mpesaState, ownerSaveMpesaKeys, ownerSavePasskey, ownerCheckMpesa, ownerRegisterMpesa };