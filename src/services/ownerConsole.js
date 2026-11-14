/**
 * The platform owner's console: log in, add a school with its main admin, list schools with student counts.
 * It CAN save M-Pesa keys on a school's behalf (write-only, with password + code re-checks, logged in the school's activity log).
 * It can never read a saved key back.
 */
const { pool } = require('../db/db');
const { hashPassword, verifyPassword, generateOwnerToken } = require('../security/auth');
const { lockedMinutes, recordFailure, clearFailures } = require('./lock');
const { createSchoolWithAdmin, normalizeEmail, generatePassword } = require('./schoolSetup');
const { getSelected } = require('./channels');
const { saveMpesaKeys, validateKeysInput, checkKeys, registerForSchool } = require('./mpesaSetup');
const { passkeyState, savePasskey } = require('./mpesaPasskey');
const { connectSchoolToBank, listSchoolBankConnections } = require('./bankConnections');
const { generateEquityCallbackCredentials } = require('./equitySetup');
const { generateCoopCallbackCredentials } = require('./coopSetup');
const totp = require('./totp');
const { encrypt, decrypt } = require('../security/crypto');

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

// Second step helpers. column is one of two fixed names (never user input): the login and the key actions keep separate "last used" counters.
async function acceptSecondStep(row, code, column) {
  if (!row.totp_secret_enc) return false;
  const step = totp.checkCode(decrypt(row.totp_secret_enc), code, row[column]);
  if (!step) return false;
  await pool.query(`UPDATE platform_owners SET ${column === 'totp_last_step_action' ? 'totp_last_step_action' : 'totp_last_step'} = $1 WHERE id = $2`, [step, row.id]);
  return true;
}
async function acceptBackup(row, code) {                                 // sign-in only; each backup code works once
  const h = totp.hashBackup(code), list = Array.isArray(row.backup_codes) ? row.backup_codes : [];
  if (!list.includes(h)) return false;
  await pool.query('UPDATE platform_owners SET backup_codes = $1 WHERE id = $2', [JSON.stringify(list.filter((x) => x !== h)), row.id]);
  return true;
}

async function login(emailInput, password, code) {
  const mail = normalizeEmail(emailInput);
  const key = 'owner:' + mail;
  const mins = await lockedMinutes(key);
  if (mins) throw refuse(`Too many wrong tries. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`, 429);
  const o = (await pool.query('SELECT id, email, full_name, password_hash, token_version, totp_enabled, totp_secret_enc, totp_last_step, backup_codes FROM platform_owners WHERE email = $1', [mail])).rows[0];
  const ok = await verifyPassword(String(password || ''), o && o.password_hash);
  if (!o || !ok) {
    const { locked } = await recordFailure(key, MAX_FAILS, LOCK_MINUTES);
    throw refuse(locked ? `Too many wrong tries. Try again in ${LOCK_MINUTES} minutes.` : 'Wrong email or password.', locked ? 429 : 401);
  }
  if (o.totp_enabled) {
    if (!String(code || '').trim()) return { needs_code: true };        // the password was right: now ask for the 6 digits (or a backup code)
    if (!((await acceptSecondStep(o, code, 'totp_last_step')) || (await acceptBackup(o, code)))) {
      const { locked } = await recordFailure(key, MAX_FAILS, LOCK_MINUTES);
      throw refuse(locked ? `Too many wrong tries. Try again in ${LOCK_MINUTES} minutes.` : 'That code is not right.', locked ? 429 : 401);
    }
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
const CHANNEL_LABELS = { mpesa: 'M-Pesa', kcb: 'KCB', equity: 'Equity', coop: 'Co-op' };
// The SCHOOL chooses its bank in School settings. We only configure what it chose, and never switch anything on for it.
async function requireChosen(schoolId, channel) {
  if (!(await getSelected(schoolId)).includes(channel)) {
    throw refuse('This school has not chosen ' + (CHANNEL_LABELS[channel] || channel) + '. Ask the school to pick its bank in School settings first.', 409);
  }
}

async function reauth(ownerId, password, ip, code) {
  const key = 'owner-keys:' + ownerId;
  const mins = await lockedMinutes(key);
  if (mins) throw refuse('Too many wrong tries. Try again in ' + mins + ' minutes.', 429);
  const o = (await pool.query('SELECT id, password_hash, totp_enabled, totp_secret_enc, totp_last_step_action FROM platform_owners WHERE id = $1', [ownerId])).rows[0];
  const ok = o ? await verifyPassword(String(password || ''), o.password_hash) : false;
  const codeOk = !o || !o.totp_enabled || (await acceptSecondStep(o, code, 'totp_last_step_action'));   // two-step on: the current 6 digits are needed too
  if (!ok || !codeOk) {
    const { locked } = await recordFailure(key, MAX_FAILS, LOCK_MINUTES);
    throw refuse(locked ? 'Too many wrong tries. Locked for ' + LOCK_MINUTES + ' minutes.' : (!ok ? 'Your owner password is not right.' : 'The 6-digit code is not right. If you just used it, wait for the next one.'), locked ? 429 : 403);
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

async function ownerSaveMpesaKeys({ owner, ip, schoolId, paybill, consumerKey, consumerSecret, password, confirmText, code }) {
  const input = { paybill, consumerKey, consumerSecret };
  validateKeysInput(input);                                         // a typo never costs a password attempt
  const st = await mpesaState(schoolId);
  if (st.keys_saved && String(confirmText || '').trim().toUpperCase() !== 'RESET') throw refuse('Type RESET to replace keys that are already saved.');
  await requireChosen(schoolId, 'mpesa');
  await reauth(owner.id, password, ip, code);
  const { replaced } = await saveMpesaKeys({ schoolId, ...input });
  await auditStrict({ schoolId, action: replaced ? 'mpesa_keys_replaced' : 'mpesa_keys_saved', detail: {}, ip });
  return { ok: true, replaced };
}

async function ownerSavePasskey({ owner, ip, schoolId, passkey, password, confirmText, code }) {
  const st = await passkeyState(schoolId);
  if (st.hasPasskey && String(confirmText || '').trim().toUpperCase() !== 'RESET') throw refuse('Type RESET to replace a passkey that is already saved.');
  await requireChosen(schoolId, 'mpesa');
  await reauth(owner.id, password, ip, code);
  const r = await savePasskey(schoolId, passkey, { replace: st.hasPasskey, staffId: null, by: 'zuvy' });   // logs itself, as Zuvy
  return { ok: true, replaced: r.replaced };
}

async function ownerCheckMpesa({ ip, schoolId }) {
  const result = await checkKeys(schoolId);                          // asks Safaricom if the keys work; registers nothing
  await auditStrict({ schoolId, action: 'mpesa_keys_checked', detail: { ok: result.ok, reason: result.reason || null }, ip });
  return result;
}

async function ownerRegisterMpesa({ owner, ip, schoolId, dry, confirmPaybill, password, code }) {
  await requireChosen(schoolId, 'mpesa');
  const base = process.env.PUBLIC_BASE_URL;
  const rehearsal = await registerForSchool({ schoolId, staffId: null, base, dry: true });
  if (dry) return { ok: true, dry: true, preview: rehearsal.preview };
  const typed = String(confirmPaybill || '').replace(/\s+/g, '');
  if (!typed || typed !== rehearsal.school.shortcode) throw refuse("Type the school's Paybill number to confirm.");
  await reauth(owner.id, password, ip, code);
  const result = await registerForSchool({ schoolId, staffId: null, base, by: 'zuvy' });   // logs itself, as Zuvy
  return { ok: true, preview: result.preview };
}

// ---- Bank connections on a school's behalf (same rules as the school's own reset rules, plus the owner checks above) ----
const COOLDOWN_MINUTES = 10;
async function existingConnection(schoolId, bank) {
  return (await pool.query(
    `SELECT sbc.id, sbc.last_rotated_at FROM school_bank_connections sbc JOIN bank_providers bp ON bp.id = sbc.provider_id WHERE sbc.school_id = $1 AND bp.code = $2`,
    [schoolId, bank])).rows[0] || null;
}
// One single statement claims the slot, so two people pressing at the same moment cannot both get through.
async function claimRotationSlot(conn) {
  const claim = await pool.query(
    `UPDATE school_bank_connections SET last_rotated_at = NOW() WHERE id = $1 AND (last_rotated_at IS NULL OR last_rotated_at <= NOW() - make_interval(mins => $2)) RETURNING id`,
    [conn.id, COOLDOWN_MINUTES]);
  if (!claim.rows.length) {
    const w = (await pool.query(`SELECT CEIL(EXTRACT(EPOCH FROM (last_rotated_at + make_interval(mins => $2) - NOW())) / 60)::int AS mins FROM school_bank_connections WHERE id = $1`, [conn.id, COOLDOWN_MINUTES])).rows[0];
    const wait = Math.max((w && w.mins) || 1, 1);
    throw refuse(`This was changed a moment ago. Wait ${wait} minute${wait === 1 ? '' : 's'} before changing it again.`, 429);
  }
  return async () => { await pool.query('UPDATE school_bank_connections SET last_rotated_at = $2 WHERE id = $1', [conn.id, conn.last_rotated_at]); };
}

async function kcbState(schoolId) {
  if (!Number.isInteger(schoolId)) throw refuse('School not found.', 404);
  const row = (await listSchoolBankConnections(schoolId)).find((c) => c.code === 'kcb');
  return { connected: !!row, account_number: row ? row.account_number : null };
}

async function ownerSaveKcb({ owner, ip, schoolId, accountNumber, password, confirmText, code }) {
  const num = String(accountNumber == null ? '' : accountNumber).replace(/\s+/g, '');         // spaces would stop it matching the bank's message
  if (!/^[A-Za-z0-9]{4,24}$/.test(num)) throw refuse('Enter the KCB account (or Vooma till) number using letters and numbers only, 4 to 24 characters.');
  if (!(await pool.query('SELECT 1 FROM schools WHERE id = $1', [schoolId])).rowCount) throw refuse('School not found.', 404);
  if ((await pool.query(`SELECT 1 FROM school_bank_connections sbc JOIN bank_providers bp ON bp.id = sbc.provider_id WHERE bp.code = 'kcb' AND sbc.account_number = $1 AND sbc.school_id <> $2 LIMIT 1`, [num, schoolId])).rowCount) {
    throw refuse('That account number is already used by another school.', 409);
  }
  await requireChosen(schoolId, 'kcb');
  const conn = await existingConnection(schoolId, 'kcb');
  if (conn && String(confirmText || '').trim().toUpperCase() !== 'RESET') throw refuse('Type RESET to replace an account number that is already saved.');
  await reauth(owner.id, password, ip, code);
  const rollback = conn ? await claimRotationSlot(conn) : async () => {};
  try {
    await connectSchoolToBank({ schoolId, providerCode: 'kcb', accountNumber: num, credentials: {} });
  } catch (e) { await rollback(); throw e; }                       // if it fails, give the slot back
  await auditStrict({ schoolId, action: conn ? 'credentials_rotated' : 'credentials_created', detail: { bank: 'kcb' }, ip });
  return { ok: true, replaced: !!conn };
}

async function equityState(schoolId) {
  if (!Number.isInteger(schoolId)) throw refuse('School not found.', 404);
  const row = (await listSchoolBankConnections(schoolId)).find((c) => c.code === 'equity');
  return { connected: !!row, username: row ? row.account_number : null };        // the username is only an identifier; the password is never kept readable
}

// Makes the callback password and returns it ONCE. Equity cannot be reached with it: it only lets Equity post payment notifications to us.
async function ownerGenerateEquity({ owner, ip, schoolId, password, confirmText, code }) {
  if (!Number.isInteger(schoolId) || !(await pool.query('SELECT 1 FROM schools WHERE id = $1', [schoolId])).rowCount) throw refuse('School not found.', 404);
  await requireChosen(schoolId, 'equity');
  const conn = await existingConnection(schoolId, 'equity');
  if (conn && String(confirmText || '').trim().toUpperCase() !== 'RESET') throw refuse('Type RESET to make a new password.');
  await reauth(owner.id, password, ip, code);
  const rollback = conn ? await claimRotationSlot(conn) : async () => {};
  let creds;
  try { creds = await generateEquityCallbackCredentials(schoolId); } catch (e) { await rollback(); throw e; }
  let audit_warning = null;
  try { await auditStrict({ schoolId, action: conn ? 'credentials_rotated' : 'credentials_created', detail: { bank: 'equity' }, ip }); }
  catch (e) {   // the password already exists and cannot be shown again, so do not lose it: tell the owner instead
    console.error('owner audit write failed for Equity set-up:', e.message);
    audit_warning = 'The activity log line could not be written. Tell whoever looks after the database.';
  }
  return {
    ...creds, audit_warning, show_once: true,
    steps: [
      "Sign in to JengaHQ with the school's own login.",
      "Settings > Alerts: choose the school's account, set the type to Credit only, then paste the username, password and callback URL.",
      'For online/gateway payments also open Settings > IPNs and paste the same three values.',
      'Keep the password safe. It cannot be shown again; if it is lost, make a new one and update JengaHQ.',
    ],
  };
}

async function coopState(schoolId) {
  if (!Number.isInteger(schoolId)) throw refuse('School not found.', 404);
  const row = (await listSchoolBankConnections(schoolId)).find((c) => c.code === 'coop');
  return { connected: !!row, account_number: row ? row.account_number : null };
}

// Co-op names the school's ACCOUNT NUMBER in each message, so that is how we find the school. The password is made here and shown once.
async function ownerGenerateCoop({ owner, ip, schoolId, accountNumber, password, confirmText, code }) {
  if (!Number.isInteger(schoolId) || !(await pool.query('SELECT 1 FROM schools WHERE id = $1', [schoolId])).rowCount) throw refuse('School not found.', 404);
  await requireChosen(schoolId, 'coop');
  const conn = await existingConnection(schoolId, 'coop');
  const typed = String(accountNumber == null ? '' : accountNumber).replace(/\s+/g, '');
  const account = typed || (conn ? (await coopState(schoolId)).account_number : '');
  if (!/^[A-Za-z0-9]{8,20}$/.test(account || '')) throw refuse("Enter the school's Co-op account number (letters and numbers only, 8 to 20 characters).");
  if ((await pool.query(`SELECT 1 FROM school_bank_connections sbc JOIN bank_providers bp ON bp.id = sbc.provider_id WHERE bp.code = 'coop' AND sbc.account_number = $1 AND sbc.school_id <> $2 LIMIT 1`, [account, schoolId])).rowCount) {
    throw refuse('That account number is already used by another school.', 409);
  }
  if (conn && String(confirmText || '').trim().toUpperCase() !== 'RESET') throw refuse('Type RESET to make a new password.');
  await reauth(owner.id, password, ip, code);
  const rollback = conn ? await claimRotationSlot(conn) : async () => {};
  let creds;
  try { creds = await generateCoopCallbackCredentials(schoolId, account); } catch (e) { await rollback(); throw e; }
  let audit_warning = null;
  try { await auditStrict({ schoolId, action: conn ? 'credentials_rotated' : 'credentials_created', detail: { bank: 'coop' }, ip }); }
  catch (e) {
    console.error('owner audit write failed for Co-op set-up:', e.message);
    audit_warning = 'The activity log line could not be written. Tell whoever looks after the database.';
  }
  return {
    ...creds, audit_warning, show_once: true,
    steps: [
      'The school (the account holder) asks Co-op to subscribe this account to the Instant Notification Service (INS), for CREDIT events.',
      'Give Co-op the callback URL, the username and the password, together with the account number.',
      'Keep the password safe. It cannot be shown again; if it is lost, make a new one and give Co-op the new password.',
    ],
  };
}

// ---- Two-step sign-in for the owner ----
async function twoStepEnabled(ownerId) {
  const r = (await pool.query('SELECT totp_enabled FROM platform_owners WHERE id = $1', [ownerId])).rows[0];
  return !!(r && r.totp_enabled);
}
async function twoStepStart(owner) {
  if (await twoStepEnabled(owner.id)) throw refuse('Two-step sign-in is already on.');
  const secret = totp.newSecret();
  await pool.query('UPDATE platform_owners SET totp_secret_enc = $1 WHERE id = $2', [encrypt(secret), owner.id]);
  return { secret, otpauth: totp.otpauthUri(secret, owner.email) };
}
async function twoStepEnable(owner, code) {
  const row = (await pool.query('SELECT id, totp_enabled, totp_secret_enc FROM platform_owners WHERE id = $1', [owner.id])).rows[0];
  if (!row || !row.totp_secret_enc) throw refuse('Press Start again.');
  if (row.totp_enabled) throw refuse('Two-step sign-in is already on.');
  const step = totp.checkCode(decrypt(row.totp_secret_enc), code, 0);
  if (!step) throw refuse('That code is not right. Check the 6 digits in your app and try again.');
  const codes = totp.newBackupCodes(10);
  // token_version + 1 signs out every other session, including a stolen one. This one must sign in again too, with the app.
  await pool.query('UPDATE platform_owners SET totp_enabled = TRUE, totp_last_step = $1, totp_last_step_action = $1, backup_codes = $2, token_version = token_version + 1 WHERE id = $3',
    [step, JSON.stringify(codes.map(totp.hashBackup)), owner.id]);
  return { ok: true, backup_codes: codes };
}
async function twoStepDisable(owner, ip, password, code) {
  await reauth(owner.id, password, ip, code);                      // needs the password AND a current code
  await pool.query(`UPDATE platform_owners SET totp_enabled = FALSE, totp_secret_enc = NULL, backup_codes = '[]'::jsonb, token_version = token_version + 1 WHERE id = $1`, [owner.id]);
  return { ok: true };
}

module.exports = { createOwner, login, listSchools, addSchool, listApplications, updateApplication, resetAdminPassword, setSchoolPaused, mpesaState, ownerSaveMpesaKeys, ownerSavePasskey, ownerCheckMpesa, ownerRegisterMpesa, twoStepEnabled, twoStepStart, twoStepEnable, twoStepDisable, kcbState, ownerSaveKcb, equityState, ownerGenerateEquity, coopState, ownerGenerateCoop };