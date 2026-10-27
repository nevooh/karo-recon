/**
 * Signing a new school up: the school record AND its first Admin login, made together.
 *
 * This is the one engine for it. The command line (src/scripts/create-school.js) uses it today,
 * and your future operator dashboard can call the very same function, so the rules are never copied.
 *
 * What it guarantees:
 *   - ALL OR NOTHING. The school and its Admin are made in one database transaction. If anything
 *     fails there is no half-made school left behind.
 *   - Nobody else can slip in at the same moment. Creations are lined up one at a time, so two people
 *     cannot both create "the same" school or both use the same email.
 *   - ONE EMAIL = ONE ACCOUNT in the whole system. Login finds a person by email alone, so the same
 *     email in two schools would lock the second school's person out. Emails are stored in lower case.
 *   - A school name is used by one school only (ignoring capitals and extra spaces), so operators and
 *     the "type the school's name" confirmations never get confusing.
 *   - The password is never stored: only a scrambled copy. A generated password is returned ONCE.
 *   - Channels the school uses can be switched on at the same time (hiding or showing them later is
 *     done in School settings).
 */
const crypto = require('crypto');
const { pool } = require('../db/db');
const { hashPassword } = require('../security/auth');
const { logAudit } = require('./audit');
const { CHANNELS } = require('./channels');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const LINE_UP_KEY = 7771001;   // any fixed number: makes school creations happen one at a time

function refuse(message, status = 400) { const e = new Error(message); e.status = status; return e; }

const normalizeEmail = (e) => String(e == null ? '' : e).trim().toLowerCase();
const cleanText = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

// 16 characters, with no look-alikes (no 0/O and no 1/l/I), so it can be read out over the phone.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
function generatePassword(length = 16) {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[crypto.randomInt(ALPHABET.length)];   // randomInt has no bias
  return out;
}

// Is this email already used by an account in ANOTHER school? (schoolId = the school to ignore.)
async function emailTakenElsewhere(email, schoolId = null, db = pool) {
  const r = schoolId
    ? await db.query('SELECT 1 FROM staff WHERE lower(email) = $1 AND school_id <> $2 LIMIT 1', [email, schoolId])
    : await db.query('SELECT 1 FROM staff WHERE lower(email) = $1 LIMIT 1', [email]);
  return r.rows.length > 0;
}

// Checks the typed values. Returns the cleaned values or throws a 400 with a message a person can act on.
function validateNewSchool({ name, adminName, adminEmail, password, channels }) {
  const n = cleanText(name), a = cleanText(adminName), e = normalizeEmail(adminEmail);
  const bad = (s) => /[\u0000-\u001f\u007f]/.test(s);
  if (n.length < 3 || n.length > 100 || bad(n)) throw refuse('The school name must be 3 to 100 characters.');
  if (a.length < 2 || a.length > 100 || bad(a)) throw refuse('The Admin\'s full name must be 2 to 100 characters.');
  if (!EMAIL_RE.test(e) || e.length > 200) throw refuse('Enter a valid email address for the school\'s first Admin.');
  if (password != null && String(password).length < 10) throw refuse('A password you choose must be at least 10 characters. Leave it out and a strong one is made for you.');
  const list = [...new Set((channels || []).map((c) => String(c).trim().toLowerCase()).filter(Boolean))];
  const unknown = list.filter((c) => !CHANNELS.includes(c));
  if (unknown.length) throw refuse(`Unknown channel: ${unknown.join(', ')}. Choose from: ${CHANNELS.join(', ')}`);
  return { name: n, adminName: a, adminEmail: e, channels: list };
}

const NAME_TAKEN = 'A school with this name already exists. Use a clearly different name (for example add the town).';
const EMAIL_TAKEN = 'This email is already used by another account. Every Admin needs their own email address, because logging in finds a person by their email.';

/**
 * Creates a school and its first Admin.
 *   dry: true  -> checks everything and writes NOTHING
 * Returns { dry, school, admin, password (only when it was generated), channels }.
 */
async function createSchoolWithAdmin({ name, adminName, adminEmail, password, channels, dry = false }, deps = {}) {
  const v = validateNewSchool({ name, adminName, adminEmail, password, channels });
  const db = deps.pool || pool;
  const generated = password == null;
  const finalPassword = generated ? generatePassword() : String(password);

  // Quick answers first (no password scrambling, no transaction). The real check is repeated safely below.
  const taken = async (client) => {
    if ((await client.query('SELECT 1 FROM schools WHERE lower(btrim(name)) = lower($1) LIMIT 1', [v.name])).rows.length) throw refuse(NAME_TAKEN, 409);
    if (await emailTakenElsewhere(v.adminEmail, null, client)) throw refuse(EMAIL_TAKEN, 409);
  };
  if (dry) {
    await taken(db);
    return { dry: true, school: { name: v.name }, admin: { full_name: v.adminName, email: v.adminEmail, role: 'admin' }, password: null, channels: v.channels };
  }

  const hash = await (deps.hashPassword || hashPassword)(finalPassword);   // before the transaction: it is slow
  const client = await db.connect();
  let created;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [LINE_UP_KEY]);   // one creation at a time
    await taken(client);
    const school = (await client.query('INSERT INTO schools (name) VALUES ($1) RETURNING id, name', [v.name])).rows[0];
    const admin = (await client.query(
      `INSERT INTO staff (school_id, full_name, email, password_hash, role, status, is_owner)
       VALUES ($1, $2, $3, $4, 'admin', 'active', TRUE) RETURNING id, full_name, email, role`,
      [school.id, v.adminName, v.adminEmail, hash])).rows[0];
    if (v.channels.length) {
      await client.query('INSERT INTO school_channels (school_id, channel) SELECT $1, c FROM unnest($2::text[]) AS c ON CONFLICT DO NOTHING', [school.id, v.channels]);
    }
    await client.query('COMMIT');
    created = { school, admin };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* the connection is already gone */ }
    if (err && err.code === '23505') throw refuse(EMAIL_TAKEN, 409);       // someone used the email at the very same instant
    throw err;
  } finally {
    client.release();
  }
  await logAudit({ schoolId: created.school.id, action: 'school_created', detail: { admin_id: created.admin.id, channels: v.channels, via: 'create-school' } });
  return { dry: false, school: created.school, admin: created.admin, password: generated ? finalPassword : null, channels: v.channels };
}

module.exports = { createSchoolWithAdmin, validateNewSchool, generatePassword, emailTakenElsewhere, normalizeEmail, EMAIL_RE };