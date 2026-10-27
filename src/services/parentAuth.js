/**
 * Parent sign-in: phone number + a 6-digit code sent by text message. No passwords for parents to forget.
 *
 *   requestCode   asks for a code. The answer is ALWAYS the same ("if this number is registered..."), so nobody can use
 *                 it to find out which phones are on file. At most no limit on codes per phone (the connection limit in parentRoutes.js still applies).
 *   verifyCode    checks the code and hands back a sign-in token (14 days). 5 wrong tries in a row lock that phone for
 *                 15 minutes (same lock as the staff login, services/lock.js).
 *   signOutEverywhere  makes every token of this phone stop working.
 *

 * An unregistered number is told so plainly (404) - the owner chose this over hiding which numbers are registered.
 * No limit on codes per phone; the 20-requests-an-hour limit per connection (routes/parentRoutes.js) still applies.
 * Only a phone that is a contact of at least one student in school can sign in (see parentPortal.phoneHasChildren).
 * The code is never stored: only a fingerprint (HMAC with the server secret), and each new code kills the older ones.
 */
const crypto = require('crypto');
const { pool } = require('../db/db');
const { toMsisdn } = require('../connectors/mpesaStk');
const { sendSms, devMode } = require('./sms');
const { lockedMinutes, recordFailure, clearFailures } = require('./lock');
const { generateParentToken } = require('../security/auth');
const { phoneHasChildren } = require('./parentPortal');

const CODE_MINUTES = 2;
const MAX_FAILS = 5, LOCK_MINUTES = 15;

function refuse(message, status = 400) { const e = new Error(message); e.status = status; return e; }

function cleanPhone(input) {
  try { return toMsisdn(input); } catch (e) { throw refuse('Enter the phone number you gave the school, like 0712 345 678.'); }
}
function secret() {
  if (!process.env.JWT_SECRET) throw refuse('JWT_SECRET missing in .env.', 500);
  return process.env.JWT_SECRET;
}
const fingerprint = (phone, code) => crypto.createHmac('sha256', secret()).update('parent-otp:' + phone + ':' + code).digest('hex');
const safeEqual = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

async function requestCode(phoneInput, deps = {}) {
  const db = deps.pool || pool;
  const phone = cleanPhone(phoneInput);
  const reply = { ok: true, message: 'A sign-in code has been sent to your phone.', expires_in: CODE_MINUTES * 60 };

  await db.query(`DELETE FROM parent_otps WHERE created_at < NOW() - INTERVAL '1 day'`);

  const known = await phoneHasChildren(phone, deps);
  if (!known) {
    console.log(`[portal sign-in] ${phone} asked for a code, but no student who is in school has this number as a contact. Nothing sent.`);
    throw refuse('This phone number is not registered with any school. Use the number you gave the school, or ask the school to add it as a parent contact.', 404);
  }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await db.query(`UPDATE parent_otps SET used_at = NOW() WHERE phone = $1 AND used_at IS NULL`, [phone]);     // a new code kills the old ones
  await db.query(`INSERT INTO parent_otps (phone, code_hash, expires_at) VALUES ($1, $2, NOW() + make_interval(mins => $3))`, [phone, fingerprint(phone, code), CODE_MINUTES]);
  await (deps.sendSms || sendSms)({ to: phone, text: `Your Karo school fees code is ${code}. It works for ${CODE_MINUTES} minutes. Do not share it.` });
  // dev mode (no SMS provider, not production): the code is handed back so the portal can be tried on one computer
  if (process.env.NODE_ENV === 'production' && process.env.SMS_PRINT_CODE !== 'true') console.log(`[portal sign-in] code sent to ${phone}. (Not printed here because NODE_ENV=production; set SMS_PRINT_CODE=true to print it.)`);
  // the code is shown on the sign-in screen ONLY if SMS_SHOW_CODE_ON_SCREEN=true (and nothing is really sent); otherwise it is in the terminal
  return devMode() && process.env.SMS_SHOW_CODE_ON_SCREEN === 'true' ? { ...reply, devCode: code } : reply;
}

async function verifyCode(phoneInput, codeInput, deps = {}) {
  const db = deps.pool || pool;
  const phone = cleanPhone(phoneInput);
  const code = String(codeInput == null ? '' : codeInput).replace(/\s/g, '');
  const key = 'parent:' + phone;
  const mins = await lockedMinutes(key);
  if (mins) throw refuse(`Too many wrong codes. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`, 429);

  const wrong = async () => {
    const { locked } = await recordFailure(key, MAX_FAILS, LOCK_MINUTES);
    throw refuse(locked ? `Too many wrong codes. Try again in ${LOCK_MINUTES} minutes.` : 'That code is not right, or it has run out of time. Ask for a new one.', locked ? 429 : 401);
  };
  if (!/^\d{6}$/.test(code)) return wrong();

  const client = await db.connect();
  let ok = false;
  try {
    await client.query('BEGIN');
    const row = (await client.query(
      `SELECT id, code_hash FROM parent_otps WHERE phone = $1 AND used_at IS NULL AND expires_at > NOW() ORDER BY id DESC LIMIT 1 FOR UPDATE`, [phone])).rows[0];
    if (row && safeEqual(row.code_hash, fingerprint(phone, code))) {
      await client.query('UPDATE parent_otps SET used_at = NOW() WHERE id = $1', [row.id]);       // one use only
      ok = true;
    }
    await client.query('COMMIT');
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; }
  finally { client.release(); }

  if (!ok || !(await phoneHasChildren(phone, deps))) return wrong();
  await clearFailures(key);
  const acc = (await db.query(
    `INSERT INTO parent_accounts (phone, last_login_at) VALUES ($1, NOW())
     ON CONFLICT (phone) DO UPDATE SET last_login_at = NOW() RETURNING token_version`, [phone])).rows[0];
  return { token: generateParentToken({ phone, tv: acc.token_version }), phone };
}

async function signOutEverywhere(phone, deps = {}) {
  const db = deps.pool || pool;
  await db.query('UPDATE parent_accounts SET token_version = token_version + 1 WHERE phone = $1', [phone]);
  return { ok: true };
}

module.exports = { requestCode, verifyCode, signOutEverywhere, CODE_MINUTES };