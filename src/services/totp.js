/**
 * Two-step sign-in codes (TOTP, RFC 6238): the 6 digits that Google Authenticator, Microsoft Authenticator,
 * Authy and similar apps show. No outside package: it is only HMAC-SHA1 from Node's own crypto.
 * The secret is base32 text. A code is valid for 30 seconds; we also accept one step either side for clock drift.
 */
const crypto = require('crypto');
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  let bits = 0, value = 0; const out = [];
  for (const ch of String(str || '').toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
    value &= (1 << bits) - 1;
  }
  return Buffer.from(out);
}

const newSecret = () => base32Encode(crypto.randomBytes(20));

function hotp(secretBuf, counter) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', secretBuf).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  const n = (((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1000000;
  return String(n).padStart(6, '0');
}

const same = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// Returns the 30-second step number the code belongs to, or null. A step that was already used (<= lastStep) is refused,
// so a code that someone watched you type cannot be used again.
function checkCode(secretB32, code, lastStep = 0, now = Date.now()) {
  const c = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const secret = base32Decode(secretB32), step = Math.floor(now / 30000);
  for (const s of [step - 1, step, step + 1]) {
    if (s > Number(lastStep || 0) && same(hotp(secret, s), c)) return s;
  }
  return null;
}

const otpauthUri = (secretB32, email) =>
  'otpauth://totp/' + encodeURIComponent('Zuvy Owner:' + email) + '?secret=' + secretB32 + '&issuer=' + encodeURIComponent('Zuvy Owner') + '&digits=6&period=30';

// One-time backup codes, for a lost phone. Only their hashes are stored.
const normalizeBackup = (c) => String(c || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
const hashBackup = (c) => crypto.createHash('sha256').update(normalizeBackup(c)).digest('hex');
function newBackupCodes(n = 10) {
  const codes = [];
  for (let i = 0; i < n; i++) { const raw = base32Encode(crypto.randomBytes(7)).slice(0, 10); codes.push(raw.slice(0, 5) + '-' + raw.slice(5)); }
  return codes;
}

module.exports = { newSecret, checkCode, otpauthUri, newBackupCodes, hashBackup, normalizeBackup, base32Encode, base32Decode, hotp };