/* staffAdmin.js - everything about WHO can use a school's account.
   Roles: Main Admin (one per school, an admin who can never be removed) > admin > staff.
   Rules (the server enforces all of them, whatever the screen shows):
     - An admin sets nobody's password. People choose their own through a one-time link sent to their email.
     - Admins manage people with the 'staff' role. Only the Main Admin manages other admins (invite, role, suspend, reset, email).
     - Nobody touches the owner; the Main Admin can hand ownership to another active admin (password needed).
     - Staff are suspended, never deleted, so the activity log always has their name.
     - A suspended person, or one whose password changed, is signed out at once (token_version).
   Links: invite 48 hours, reset 1 hour, email confirmation 48 hours. One use each; a new link replaces the old one. */
const crypto = require('crypto');
const { pool } = require('../db/db');
const { hashPassword, verifyPassword, generateToken } = require('../security/auth');
const { logAudit } = require('./audit');
const { normalizeEmail, EMAIL_RE, emailTakenElsewhere } = require('./schoolSetup');
const mailer = require('./mailer');

const INVITE_HOURS = 48, RESET_MINUTES = 60, EMAIL_HOURS = 48;
const MIN_PASSWORD = 8, MAX_PASSWORD = 200;

function refuse(message, status = 400) { const e = new Error(message); e.status = status; return e; }
const cleanName = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const sha = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex');

function checkPassword(pw, email) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) throw refuse('Password must be at least ' + MIN_PASSWORD + ' characters.');
  if (pw.length > MAX_PASSWORD) throw refuse('That password is too long.');
  if (email && pw.toLowerCase() === String(email).toLowerCase()) throw refuse('Password can not be your email address.');
}

async function loadPerson(db, schoolId, staffId) {
  const r = await db.query('SELECT id, school_id, full_name, email, role, is_owner, status, password_hash FROM staff WHERE id = $1 AND school_id = $2', [staffId, schoolId]);
  return r.rows[0] || null;
}
async function loadActor(db, schoolId, staffId) {
  const a = await loadPerson(db, schoolId, staffId);
  if (!a || a.status !== 'active') throw refuse('Your account can not do this.', 403);
  return a;
}
function requireAdminActor(a) { if (a.role !== 'admin') throw refuse('Only an Admin can do this.', 403); }
// May this actor manage this target (invite/role/suspend/reset)?  Never the owner, never yourself.
function requireCanManage(actor, target) {
  requireAdminActor(actor);
  if (!target) throw refuse('Staff member not found in this school.', 404);
  if (target.is_owner) throw refuse('The Main Admin can not be changed by anyone else.', 403);
  if (target.id === actor.id) throw refuse('You can not do this to your own account.', 403);
  if (target.role === 'admin' && !actor.is_owner) throw refuse('Only the Main Admin can manage other Admins.', 403);
}

async function schoolName(db, schoolId) { return (await db.query('SELECT name FROM schools WHERE id = $1', [schoolId])).rows[0]?.name || 'your school'; }

async function makeToken(db, { staffId, purpose, newEmail = null, createdBy = null, minutes }) {
  const raw = crypto.randomBytes(32).toString('base64url');
  await db.query(`UPDATE staff_tokens SET used_at = NOW() WHERE staff_id = $1 AND purpose = $2 AND used_at IS NULL`, [staffId, purpose]);   // the new link replaces the old one
  await db.query(
    `INSERT INTO staff_tokens (staff_id, purpose, token_hash, new_email, expires_at, created_by) VALUES ($1, $2, $3, $4, NOW() + make_interval(mins => $5), $6)`,
    [staffId, purpose, sha(raw), newEmail, minutes, createdBy]);
  return raw;
}

// Sends the mail. A failed send never undoes the change: the admin can press Resend. In dev mode (no mail set up, not production) the link is handed back.
async function deliver(to, built, link, deps) {
  try {
    const r = await (deps.sendMail || mailer.sendMail)({ to, subject: built.subject, text: built.text, html: built.html });
    return r.sent ? { sent: true } : (r.dev ? { sent: false, dev: true, link } : { sent: false, dev: false });
  } catch (e) { console.error('mail failed:', e.message); return { sent: false, dev: false, error: 'The email could not be sent. Try Resend in a minute.' }; }
}

/* ------------------------------ looking ------------------------------ */
async function listStaff(schoolId, db = pool) {
  const r = await db.query(
    `SELECT s.id, s.full_name, s.email, s.role, s.is_owner, s.status, s.last_login_at, s.created_at, inv.full_name AS invited_by_name,
            (SELECT t.expires_at FROM staff_tokens t WHERE t.staff_id = s.id AND t.purpose = 'invite' AND t.used_at IS NULL ORDER BY t.id DESC LIMIT 1) AS invite_expires_at,
            (SELECT t.new_email FROM staff_tokens t WHERE t.staff_id = s.id AND t.purpose = 'email_change' AND t.used_at IS NULL AND t.expires_at > NOW() ORDER BY t.id DESC LIMIT 1) AS pending_email
     FROM staff s LEFT JOIN staff inv ON inv.id = s.invited_by
     WHERE s.school_id = $1 AND s.status <> 'removed'
     ORDER BY s.is_owner DESC, (s.role = 'admin') DESC, lower(s.full_name), s.id`, [schoolId]);
  return r.rows.map((x) => ({ ...x, invite_expired: x.status === 'invited' && x.invite_expires_at ? new Date(x.invite_expires_at) < new Date() : x.status === 'invited' }));
}
async function getMe(schoolId, staffId, db = pool) {
  const r = await db.query('SELECT id, full_name, email, role, is_owner, status, last_login_at FROM staff WHERE id = $1 AND school_id = $2', [staffId, schoolId]);
  if (!r.rows[0]) throw refuse('Account not found.', 404);
  return r.rows[0];
}

/* ------------------------------ inviting ------------------------------ */
async function inviteStaff({ schoolId, actorId, fullName, email, role = 'staff', ip = null }, deps = {}) {
  const db = deps.db || pool;
  const actor = await loadActor(db, schoolId, actorId);
  requireAdminActor(actor);
  const name = cleanName(fullName), mail = normalizeEmail(email);
  if (name.length < 2) throw refuse('Enter the person\'s full name.');
  if (name.length > 120) throw refuse('That name is too long.');
  if (!EMAIL_RE.test(mail)) throw refuse('That does not look like an email address.');
  if (!['admin', 'staff'].includes(role)) throw refuse('Role must be Admin or Staff.');
  if (role === 'admin' && !actor.is_owner) throw refuse('Only the Main Admin can add another Admin.', 403);
  if (await emailTakenElsewhere(mail, null, db)) throw refuse('That email already belongs to an account. Every person needs their own email address.', 409);
  let row;
  try {
    row = (await db.query(
      `INSERT INTO staff (school_id, full_name, email, role, status, invited_by) VALUES ($1, $2, $3, $4, 'invited', $5) RETURNING id, full_name, email, role, status`,
      [schoolId, name, mail, role, actorId])).rows[0];
  } catch (e) { if (e.code === '23505') throw refuse('That email already belongs to an account. Every person needs their own email address.', 409); throw e; }
  const out = await sendInvite(db, row, actor, schoolId, deps);
  await logAudit({ schoolId, staffId: actorId, action: 'staff_invited', detail: { staff_id: row.id, name, role }, ip });
  return { staff: row, mail: out };
}
async function sendInvite(db, person, actor, schoolId, deps) {
  const raw = await makeToken(db, { staffId: person.id, purpose: 'invite', createdBy: actor.id, minutes: INVITE_HOURS * 60 });
  const link = mailer.appUrl() + '/?token=' + raw;
  const built = mailer.inviteMail({ schoolName: await schoolName(db, schoolId), inviterName: actor.full_name, role: person.role, fullName: person.full_name, link, hours: INVITE_HOURS });
  return deliver(person.email, built, link, deps);
}
async function resendInvite({ schoolId, actorId, staffId, ip = null }, deps = {}) {
  const db = deps.db || pool;
  const actor = await loadActor(db, schoolId, actorId);
  const t = await loadPerson(db, schoolId, staffId);
  requireCanManage(actor, t);
  if (t.status !== 'invited') throw refuse('This person has already joined. Use "Send reset link" if they forgot their password.');
  const out = await sendInvite(db, t, actor, schoolId, deps);
  await logAudit({ schoolId, staffId: actorId, action: 'invite_resent', detail: { staff_id: t.id }, ip });
  return { mail: out };
}

/* ------------------------------ password links ------------------------------ */
async function sendResetLink({ schoolId, actorId, staffId, ip = null }, deps = {}) {
  const db = deps.db || pool;
  const actor = await loadActor(db, schoolId, actorId);
  const t = await loadPerson(db, schoolId, staffId);
  requireCanManage(actor, t);
  if (t.status === 'invited') throw refuse('This person has not joined yet. Use Resend invite.');
  if (t.status !== 'active') throw refuse('This person is suspended. Reactivate them first.');
  const out = await sendReset(db, t, schoolId, actorId, deps);
  await logAudit({ schoolId, staffId: actorId, action: 'password_reset_sent', detail: { staff_id: t.id }, ip });
  return { mail: out };
}
async function sendReset(db, person, schoolId, createdBy, deps) {
  const raw = await makeToken(db, { staffId: person.id, purpose: 'reset', createdBy, minutes: RESET_MINUTES });
  const link = mailer.appUrl() + '/?token=' + raw;
  const built = mailer.resetMail({ fullName: person.full_name, link, minutes: RESET_MINUTES, schoolName: await schoolName(db, schoolId) });
  return deliver(person.email, built, link, deps);
}
// "Forgot password" on the login screen. Always answers the same, so it never shows which emails exist.
async function forgotPassword({ email, ip = null }, deps = {}) {
  const db = deps.db || pool;
  const mail = normalizeEmail(email);
  const generic = { ok: true };
  if (!EMAIL_RE.test(mail)) return generic;
  const p = (await db.query(`SELECT id, school_id, full_name, email, role, status FROM staff WHERE lower(email) = $1 AND status IN ('active', 'invited')`, [mail])).rows[0];
  if (!p) return generic;
  const recent = (await db.query(`SELECT COUNT(*)::int AS n FROM staff_tokens WHERE staff_id = $1 AND purpose IN ('reset','invite') AND created_at > NOW() - INTERVAL '1 hour'`, [p.id])).rows[0].n;
  if (recent >= 3) return generic;                     // quietly stop mail floods
  let out;
  if (p.status === 'invited') {
    const inviter = (await db.query('SELECT id, full_name FROM staff WHERE id = (SELECT invited_by FROM staff WHERE id = $1)', [p.id])).rows[0] || { id: null, full_name: 'Your school' };
    out = await sendInvite(db, p, inviter, p.school_id, deps);
  } else out = await sendReset(db, p, p.school_id, p.id, deps);
  await logAudit({ schoolId: p.school_id, staffId: p.id, action: 'password_reset_requested', ip });
  return out.dev ? { ok: true, mail: out } : generic;   // the link is only ever handed back in local dev mode
}
async function peekToken(raw, db = pool) {
  if (!raw || typeof raw !== 'string' || raw.length > 200) return null;
  const r = await db.query(
    `SELECT t.id, t.purpose, t.new_email, s.full_name, s.email, s.status, s.school_id, sc.name AS school_name
     FROM staff_tokens t JOIN staff s ON s.id = t.staff_id JOIN schools sc ON sc.id = s.school_id
     WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > NOW()`, [sha(raw)]);
  const t = r.rows[0];
  if (!t) return null;
  const okState = (t.purpose === 'invite' && t.status === 'invited') || (t.purpose === 'reset' && t.status === 'active') || (t.purpose === 'email_change' && ['active', 'invited'].includes(t.status));
  return okState ? t : null;
}
async function tokenInfo(raw, db = pool) {
  const t = await peekToken(raw, db);
  if (!t) throw refuse('This link is no longer valid. Ask for a new one.', 410);
  return { purpose: t.purpose, full_name: t.full_name, email: t.purpose === 'email_change' ? t.new_email : t.email, school_name: t.school_name };
}
// Uses the link. invite/reset: sets the password and signs the person in. email_change: switches the address.
async function completeToken({ token, password, ip = null }, deps = {}) {
  const db = deps.db || pool;
  const peek = await peekToken(token, db);
  if (!peek) throw refuse('This link is no longer valid. Ask for a new one.', 410);
  if (peek.purpose !== 'email_change') checkPassword(password, peek.email);
  const hash = peek.purpose === 'email_change' ? null : await hashPassword(password);
  const client = await db.connect();
  let staff;
  try {
    await client.query('BEGIN');
    const used = await client.query(`UPDATE staff_tokens SET used_at = NOW() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW() RETURNING staff_id, purpose, new_email`, [sha(token)]);
    const u = used.rows[0];
    if (!u) throw refuse('This link is no longer valid. Ask for a new one.', 410);
    let upd;
    if (u.purpose === 'invite') upd = await client.query(`UPDATE staff SET password_hash = $1, status = 'active', token_version = token_version + 1, last_login_at = NOW() WHERE id = $2 AND status = 'invited' RETURNING id, school_id, full_name, role, is_owner, token_version`, [hash, u.staff_id]);
    else if (u.purpose === 'reset') upd = await client.query(`UPDATE staff SET password_hash = $1, token_version = token_version + 1, last_login_at = NOW() WHERE id = $2 AND status = 'active' RETURNING id, school_id, full_name, role, is_owner, token_version`, [hash, u.staff_id]);
    else {
      if (await emailTakenElsewhere(u.new_email, null, client)) throw refuse('That email address is now used by another account.', 409);
      upd = await client.query(`UPDATE staff SET email = $1 WHERE id = $2 AND status IN ('active','invited') RETURNING id, school_id, full_name, role, is_owner, token_version`, [u.new_email, u.staff_id]);
    }
    if (!upd.rows[0]) throw refuse('This link is no longer valid. Ask for a new one.', 410);
    staff = { ...upd.rows[0], purpose: u.purpose };
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (x) { /* gone */ }
    if (e.code === '23505') throw refuse('That email address is now used by another account.', 409);
    throw e;
  } finally { client.release(); }
  const action = { invite: 'staff_joined', reset: 'password_reset_done', email_change: 'staff_email_changed' }[staff.purpose];
  await logAudit({ schoolId: staff.school_id, staffId: staff.id, action, ip });
  if (staff.purpose === 'email_change') return { ok: true, purpose: 'email_change' };
  return { ok: true, purpose: staff.purpose, token: generateToken({ staffId: staff.id, schoolId: staff.school_id, tv: staff.token_version }),
    staff: { id: staff.id, full_name: staff.full_name, school_id: staff.school_id, role: staff.role, is_owner: staff.is_owner } };
}
async function changeOwnPassword({ schoolId, staffId, current, next, ip = null }, deps = {}) {
  const db = deps.db || pool;
  const me = await loadActor(db, schoolId, staffId);
  if (!(await verifyPassword(String(current || ''), me.password_hash))) throw refuse('Your current password is not right.', 403);
  checkPassword(next, me.email);
  if (next === current) throw refuse('Choose a password different from the current one.');
  const hash = await hashPassword(next);
  const r = await db.query(`UPDATE staff SET password_hash = $1, token_version = token_version + 1 WHERE id = $2 RETURNING token_version`, [hash, staffId]);
  await logAudit({ schoolId, staffId, action: 'password_changed', ip });
  return { ok: true, token: generateToken({ staffId, schoolId, tv: r.rows[0].token_version }) };   // this browser stays signed in; every other one is signed out
}

/* ------------------------------ roles, suspension, names, emails ------------------------------ */
async function setRole({ schoolId, actorId, staffId, role, ip = null }, deps = {}) {
  const db = deps.db || pool;
  const actor = await loadActor(db, schoolId, actorId);
  const t = await loadPerson(db, schoolId, staffId);
  requireCanManage(actor, t);
  if (!['admin', 'staff'].includes(role)) throw refuse('Role must be Admin or Staff.');
  if (role === 'admin' && !actor.is_owner) throw refuse('Only the Main Admin can make someone an Admin.', 403);
  if (t.role === role) return { ok: true, unchanged: true };
  await db.query(`UPDATE staff SET role = $1 WHERE id = $2`, [role, t.id]);
  await logAudit({ schoolId, staffId: actorId, action: 'staff_role_changed', detail: { staff_id: t.id, from: t.role, to: role }, ip });
  return { ok: true };
}
async function setStatus({ schoolId, actorId, staffId, status, ip = null }, deps = {}) {
  const db = deps.db || pool;
  const actor = await loadActor(db, schoolId, actorId);
  const t = await loadPerson(db, schoolId, staffId);
  requireCanManage(actor, t);
  if (status === 'suspended') {
    if (t.status === 'suspended') return { ok: true, unchanged: true };
    await db.query(`UPDATE staff SET status = 'suspended', token_version = token_version + 1 WHERE id = $1`, [t.id]);
    await logAudit({ schoolId, staffId: actorId, action: 'staff_suspended', detail: { staff_id: t.id }, ip });
    return { ok: true };
  }
  if (status === 'active') {
    if (t.status !== 'suspended') return { ok: true, unchanged: true };
    const back = t.password_hash ? 'active' : 'invited';
    await db.query(`UPDATE staff SET status = $1 WHERE id = $2`, [back, t.id]);
    await logAudit({ schoolId, staffId: actorId, action: 'staff_reactivated', detail: { staff_id: t.id }, ip });
    return { ok: true, status: back };
  }
  throw refuse('Status must be suspended or active.');
}
async function setName({ schoolId, actorId, staffId, fullName, ip = null }, deps = {}) {
  const db = deps.db || pool;
  const actor = await loadActor(db, schoolId, actorId);
  const t = await loadPerson(db, schoolId, staffId);
  if (!t) throw refuse('Staff member not found in this school.', 404);
  if (t.id !== actor.id) requireCanManage(actor, t);
  const name = cleanName(fullName);
  if (name.length < 2 || name.length > 120) throw refuse('Enter the person\'s full name.');
  await db.query('UPDATE staff SET full_name = $1 WHERE id = $2', [name, t.id]);
  await logAudit({ schoolId, staffId: actorId, action: 'staff_name_changed', detail: { staff_id: t.id }, ip });
  return { ok: true, full_name: name };
}
// Email change: the owner may change anyone's (and their own), an admin may change staff-role people's. The new address must confirm first.
async function changeEmail({ schoolId, actorId, staffId, email, ip = null }, deps = {}) {
  const db = deps.db || pool;
  const actor = await loadActor(db, schoolId, actorId);
  requireAdminActor(actor);
  const t = await loadPerson(db, schoolId, staffId);
  if (!t) throw refuse('Staff member not found in this school.', 404);
  const ownerSelf = t.is_owner && actor.is_owner && t.id === actor.id;
  if (!ownerSelf) {
    if (t.is_owner) throw refuse('Only the Main Admin can change the Main Admin\'s email.', 403);
    if (t.id === actor.id) throw refuse('Ask the Main Admin to change your email.', 403);
    if (t.role === 'admin' && !actor.is_owner) throw refuse('Only the Main Admin can change an Admin\'s email.', 403);
  }
  const mail = normalizeEmail(email);
  if (!EMAIL_RE.test(mail)) throw refuse('That does not look like an email address.');
  if (mail === String(t.email || '').toLowerCase()) throw refuse('That is already their email.');
  if (await emailTakenElsewhere(mail, null, db)) throw refuse('That email already belongs to an account.', 409);
  if (t.status === 'invited') {                        // not joined yet: just fix the typo and send a fresh invite
    try { await db.query('UPDATE staff SET email = $1 WHERE id = $2', [mail, t.id]); } catch (e) { if (e.code === '23505') throw refuse('That email already belongs to an account.', 409); throw e; }
    const out = await sendInvite(db, { ...t, email: mail }, actor, schoolId, deps);
    await logAudit({ schoolId, staffId: actorId, action: 'staff_email_changed', detail: { staff_id: t.id, before_joining: true }, ip });
    return { ok: true, changed: true, mail: out };
  }
  const raw = await makeToken(db, { staffId: t.id, purpose: 'email_change', newEmail: mail, createdBy: actorId, minutes: EMAIL_HOURS * 60 });
  const link = mailer.appUrl() + '/?token=' + raw;
  const built = mailer.emailChangeMail({ fullName: t.full_name, link, hours: EMAIL_HOURS, schoolName: await schoolName(db, schoolId) });
  const out = await deliver(mail, built, link, deps);
  await logAudit({ schoolId, staffId: actorId, action: 'staff_email_change_requested', detail: { staff_id: t.id }, ip });
  return { ok: true, changed: false, pending: true, mail: out };
}

/* ------------------------------ ownership ------------------------------ */
async function transferOwnership({ schoolId, actorId, toStaffId, password, ip = null }, deps = {}) {
  const db = deps.db || pool;
  const actor = await loadActor(db, schoolId, actorId);
  if (!actor.is_owner) throw refuse('Only the Main Admin can hand over the Main Admin role.', 403);
  if (!(await verifyPassword(String(password || ''), actor.password_hash))) throw refuse('Your password is not right.', 403);
  const t = await loadPerson(db, schoolId, toStaffId);
  if (!t || t.id === actor.id) throw refuse('Pick another person.');
  if (t.status !== 'active' || t.role !== 'admin') throw refuse('The new Main Admin must be an active Admin. Make them an Admin first.');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('karo.owner_transfer', 'on', true)`);     // only for this transaction
    await client.query('UPDATE staff SET is_owner = FALSE WHERE id = $1 AND is_owner', [actor.id]);
    await client.query('UPDATE staff SET is_owner = TRUE WHERE id = $1', [t.id]);
    await client.query('COMMIT');
  } catch (e) { try { await client.query('ROLLBACK'); } catch (x) { /* gone */ } throw e; } finally { client.release(); }
  await logAudit({ schoolId, staffId: actorId, action: 'ownership_transferred', detail: { to_staff_id: t.id }, ip });
  return { ok: true };
}

module.exports = { listStaff, getMe, inviteStaff, resendInvite, sendResetLink, forgotPassword, tokenInfo, completeToken, changeOwnPassword,
  setRole, setStatus, setName, changeEmail, transferOwnership, INVITE_HOURS, RESET_MINUTES };