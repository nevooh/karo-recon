/**
 * Makes the Basic Auth username + password we give to Co-op so it can deliver
 * Instant Notification Service (INS) messages to us. Same idea as Equity's:
 * NOT a login to anything - it only lets someone drop payment notifications
 * at our address. We keep a fingerprint of the password, never the password.
 *
 * Unlike Equity, Co-op's message names the school's account number, so that
 * (not the username) is how we find the school; the username/password then
 * has to match what we stored for that account.
 */
const crypto = require('crypto');
const { connectSchoolToBank, getSchoolBankConnection } = require('./bankConnections');
const { fingerprint } = require('./equitySetup');

const ALPHANUMERIC = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const LOWER_DIGITS = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomString(length, alphabet) {
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}

/**
 * First call: needs the school's Co-op account number; makes a username AND password.
 * Later calls: same username, NEW password; the old one stops working at once.
 */
async function generateCoopCallbackCredentials(schoolId, accountNumber) {
  const existing = await getSchoolBankConnection(schoolId, 'coop');
  const account = String(accountNumber || (existing && existing.accountNumber) || '').trim();
  if (!account) throw new Error("account_number is required the first time (the school's Co-op account number)");
  if (!/^[A-Za-z0-9]{8,20}$/.test(account)) throw new Error('That does not look like a Co-op account number (letters and numbers only)');

  const existingUsername = existing && existing.credentials && existing.credentials.ins_username;
  const rotated = Boolean(existingUsername);
  const username = existingUsername || 'karo_' + randomString(10, LOWER_DIGITS);
  const password = randomString(32, ALPHANUMERIC);

  await connectSchoolToBank({
    schoolId,
    providerCode: 'coop',
    accountNumber: account,
    credentials: { ins_username: username, ins_password_hash: fingerprint(password) },
  });

  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  return {
    account_number: account,
    username,
    password,
    rotated,
    callback_url: (base || 'https://YOUR-DOMAIN') + '/webhooks/coop/ins',
    callback_url_is_placeholder: !base,
  };
}

module.exports = { generateCoopCallbackCredentials };
