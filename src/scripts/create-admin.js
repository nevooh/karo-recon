// Creates (or resets the password of) an ADMIN login straight in the database.
// To sign a whole NEW school up, use create-school.js instead (it makes the school AND its first Admin).
// This one is for: a lost password, or adding another Admin to a school that already exists.
//
// Usage:  node src/scripts/create-admin.js <schoolId> "Full Name" email password
//
// One email = ONE account in the whole system (login finds a person by email alone), so an email that
// belongs to another school is refused. Emails are stored in lower case.
require('dotenv').config();
const { pool } = require('../db/db');
const { hashPassword } = require('../security/auth');
const { emailTakenElsewhere, normalizeEmail, EMAIL_RE } = require('../services/schoolSetup');

async function main() {
  const [schoolId, fullName, rawEmail, password] = process.argv.slice(2);
  if (!schoolId || !fullName || !rawEmail || !password) {
    console.error('Usage: node src/scripts/create-admin.js <schoolId> "Full Name" email password');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }
  const email = normalizeEmail(rawEmail);
  if (!EMAIL_RE.test(email)) { console.error('That does not look like an email address.'); process.exit(1); }

  const school = await pool.query(`SELECT id FROM schools WHERE id = $1`, [schoolId]);
  if (school.rows.length === 0) {
    console.error(`No school with id ${schoolId}.`);
    process.exit(1);
  }
  if (await emailTakenElsewhere(email, Number(schoolId))) {
    console.error('NOT done: this email is already used by an account in ANOTHER school. Every Admin needs their own email address, because logging in finds a person by their email.');
    process.exit(1);
  }

  const hash = await hashPassword(password);
  const existing = await pool.query('SELECT id FROM staff WHERE school_id = $1 AND lower(email) = $2', [schoolId, email]);
  const result = existing.rows[0]
    ? await pool.query(
        `UPDATE staff SET password_hash = $1, full_name = $2, email = $3, status = 'active', role = 'admin', token_version = token_version + 1 WHERE id = $4 RETURNING id, full_name, email`,
        [hash, fullName, email, existing.rows[0].id])
    : await pool.query(
        `INSERT INTO staff (school_id, full_name, email, password_hash, role, is_owner)
         VALUES ($1, $2, $3, $4, 'admin', NOT EXISTS (SELECT 1 FROM staff WHERE school_id = $1 AND is_owner)) RETURNING id, full_name, email, is_owner`,
        [schoolId, fullName, email, hash]);
  console.log('Ready to log in:', result.rows[0]);
  await pool.end();
}

main().catch((err) => { console.error(err.message); process.exit(1); });