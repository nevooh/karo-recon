const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// One secret for signing tokens, from .env - same principle as
// ENCRYPTION_KEY: never commit it, never share it, losing it invalidates
// every existing login session (everyone just logs in again - not
// catastrophic like losing ENCRYPTION_KEY, since no data is encrypted
// with this, it just signs tokens).
const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_EXPIRY = '12h'; // a school day's worth of session, roughly

function requireSecret() {
  if (!JWT_SECRET) {
    const err = new Error(
      'JWT_SECRET missing in .env. Generate one with: ' +
      'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
    err.status = 500; // a server setup problem, not the caller's fault
    throw err;
  }
}

async function hashPassword(plainPassword) {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(plainPassword, salt);
}

async function verifyPassword(plainPassword, hash) {
  if (!hash) return false; // account has no password set yet
  return bcrypt.compare(plainPassword, hash);
}

/**
 * Token payload deliberately carries schoolId alongside staffId - this is
 * what lets every protected route check "does this token's school match
 * the school in the URL" without a separate database lookup per request.
 */
function generateToken({ staffId, schoolId, tv = 0 }) {
  requireSecret();
  // tv = the person's token_version: when it moves on (password changed, suspended) this token stops working
  return jwt.sign({ staffId, schoolId, tv }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
}

function verifyToken(token) {
  requireSecret();
  return jwt.verify(token, JWT_SECRET); // throws if invalid/expired
}

// A PIN unlock: proves that THIS signed-in person just typed their PIN. Lasts 10 minutes, and dies with the login (same token_version).
const PIN_MINUTES = 10;
function generatePinToken({ staffId, schoolId, tv = 0 }) {
  requireSecret();
  return jwt.sign({ staffId, schoolId, tv, purpose: 'pin' }, JWT_SECRET, { expiresIn: PIN_MINUTES * 60 });
}
function verifyPinToken(token) {
  requireSecret();
  const p = jwt.verify(token, JWT_SECRET);
  if (p.purpose !== 'pin') throw new Error('not a PIN token');
  return p;
}

// A parent's sign-in. A parent is a phone number, not a staff member, so this token has its own "purpose" and the
// staff checks (requireAuth) can never accept it, and the parent check can never accept a staff token.
const PARENT_DAYS = 14;
function generateParentToken({ phone, tv = 0 }) {
  requireSecret();
  return jwt.sign({ phone, tv, purpose: 'parent' }, JWT_SECRET, { expiresIn: PARENT_DAYS * 24 * 3600 });
}
function verifyParentToken(token) {
  requireSecret();
  const p = jwt.verify(token, JWT_SECRET);
  if (p.purpose !== 'parent' || !p.phone) throw new Error('not a parent token');
  return p;
}

// The platform owner's sign-in (Zuvy). Own purpose, so staff and parent tokens never open owner routes and vice versa.
function generateOwnerToken({ ownerId, tv = 0 }) {
  requireSecret();
  return jwt.sign({ ownerId, tv, purpose: 'owner' }, JWT_SECRET, { expiresIn: '8h' });
}
function verifyOwnerToken(token) {
  requireSecret();
  const p = jwt.verify(token, JWT_SECRET);
  if (p.purpose !== 'owner' || !p.ownerId) throw new Error('not an owner token');
  return p;
}

module.exports = { generateOwnerToken, verifyOwnerToken, hashPassword, verifyPassword, generateToken, verifyToken, generatePinToken, verifyPinToken, PIN_MINUTES, generateParentToken, verifyParentToken, PARENT_DAYS };