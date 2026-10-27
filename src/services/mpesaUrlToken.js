/**
 * The secret code inside a school's two M-Pesa addresses (the 40 characters).
 *
 * Safaricom does not sign its messages, so the address itself is the proof. Each school gets its
 * OWN random code, made here and stored encrypted in the database. It does not depend on any
 * server-wide secret, so nothing in .env can break every school at once.
 *
 * Kept in its own small file so other tools (for example a future operator dashboard) can use
 * the very same generator and checker.
 */
const crypto = require('crypto');
const { encrypt, decrypt } = require('../security/crypto');
const { c2bUrlToken } = require('../connectors/mpesa');

// 40 random characters (0-9, a-f). Made by us alone: Safaricom never sees how.
const generateUrlToken = () => crypto.randomBytes(20).toString('hex');

const protect = (token) => encrypt(token);            // what goes into the database
function reveal(enc) {                                 // what comes back out (null if missing or unreadable)
  if (!enc) return null;
  try { return decrypt(enc); } catch (err) { return null; }
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Is `given` (the code in the address that was called) acceptable for this school?
 *   - the school's stored code: yes
 *   - the "pending" code (registration in progress, or interrupted after Safaricom accepted it): yes
 *   - the OLDER shared-secret code: only while the school has NO stored code yet
 *     (schools registered before per-school codes existed keep working until they re-register)
 * `school` is the row from the schools table, or null when the Paybill is unknown.
 */
function tokenAccepted(given, shortcode, school) {
  if (!given || !shortcode) return false;
  const candidates = [];
  if (school) {
    candidates.push(reveal(school.mpesa_url_token_enc));
    candidates.push(reveal(school.mpesa_url_token_pending_enc));
  }
  if (!school || !school.mpesa_url_token_enc) {
    try { candidates.push(c2bUrlToken(shortcode)); } catch (err) { /* no shared secret set: nothing to compare with */ }
  }
  return candidates.some((c) => c && safeEqual(given, c));
}

module.exports = { generateUrlToken, protect, reveal, tokenAccepted };