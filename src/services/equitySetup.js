/**
 * Makes the "callback password" a school pastes into its own JengaHQ settings.
 *
 * IMPORTANT - this is NOT a JengaHQ login. The school's real JengaHQ login
 * stays with the school; we never see or store it. What we make here is a
 * username + password that only lets someone POST payment notifications to
 * OUR web address. It cannot open the school's bank account or JengaHQ.
 *
 * We keep only a FINGERPRINT (SHA-256) of the password, so even we cannot read
 * it back. That is why it is shown once. The password is 32 random characters
 * (about 190 bits), so a plain fast hash is safe here - unlike a human-chosen
 * password, there is nothing to guess.
 */
const crypto = require('crypto');
const { pool } = require('../db/db');
const { connectSchoolToBank, getSchoolBankConnection } = require('./bankConnections');

const ALPHANUMERIC = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const LOWER_DIGITS = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomString(length, alphabet) {
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}

const fingerprint = (password) => crypto.createHash('sha256').update(String(password)).digest('hex');

async function usernameIsTaken(username) {
  const result = await pool.query(
    `SELECT 1 FROM school_bank_connections sbc
     JOIN bank_providers bp ON bp.id = sbc.provider_id
     WHERE bp.code = 'equity' AND sbc.account_number = $1`,
    [username]
  );
  return result.rows.length > 0;
}

async function newUniqueUsername() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const username = 'karo_' + randomString(10, LOWER_DIGITS);
    if (!(await usernameIsTaken(username))) return username;
  }
  throw new Error('Could not generate a unique username - please try again');
}

/**
 * First call for a school: creates a username AND a password.
 * Later calls: keeps the SAME username, makes a NEW password, and the old one
 * stops working at once (the school must paste the new one into JengaHQ).
 */
async function generateEquityCallbackCredentials(schoolId) {
  const existing = await getSchoolBankConnection(schoolId, 'equity');
  const rotated = Boolean(existing && existing.accountNumber);
  const username = rotated ? existing.accountNumber : await newUniqueUsername();
  const password = randomString(32, ALPHANUMERIC);

  await connectSchoolToBank({
    schoolId,
    providerCode: 'equity',
    accountNumber: username, // the username is how an incoming message is matched to this school
    credentials: { ipn_password_hash: fingerprint(password) },
  });

  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  return {
    username,
    password,
    rotated,
    callback_url: (base || 'https://YOUR-DOMAIN') + '/webhooks/equity/ipn',
    callback_url_is_placeholder: !base,
  };
}

module.exports = { generateEquityCallbackCredentials, fingerprint };
