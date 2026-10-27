const crypto = require('crypto');

// One master key for the whole app, from .env - NEVER commit this.
// Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
const MASTER_KEY = process.env.ENCRYPTION_KEY;

function getKey() {
  if (!MASTER_KEY || MASTER_KEY.length !== 64) {
    throw new Error(
      'ENCRYPTION_KEY missing or wrong length in .env. Generate one with: ' +
      'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))" ' +
      'and paste the 64-character hex string into .env as ENCRYPTION_KEY.'
    );
  }
  return Buffer.from(MASTER_KEY, 'hex');
}

/**
 * Encrypts a plaintext string (an API key, secret, etc.) for storage in the
 * database. Returns one combined string safe to store in a single TEXT
 * column: iv + authTag + ciphertext, all base64.
 */
function encrypt(plaintext) {
  if (plaintext == null || plaintext === '') return null;
  const iv = crypto.randomBytes(12); // GCM standard IV size
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

/**
 * Reverses encrypt(). Returns null for null/empty input (so optional
 * credentials that were never set just come back as null, not an error).
 */
function decrypt(stored) {
  if (!stored) return null;
  const raw = Buffer.from(stored, 'base64');
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };