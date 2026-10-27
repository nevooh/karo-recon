/**
 * The school's STK push passkey (given by Safaricom). ONE place for the rules:
 *   - stored encrypted in schools.mpesa_passkey_enc, like the consumer key and secret
 *   - never returned to any screen or printed: passkeyState() only says set / not set
 *   - getPasskey() is for the STK push code only (it decrypts)
 * A passkey is useless without the school's Paybill and keys, so we refuse to save it before those exist.
 */
const { pool } = require('../db/db');
const { encrypt, decrypt } = require('../security/crypto');
const { logAudit } = require('./audit');

function refuse(message, status = 400) { const e = new Error(message); e.status = status; return e; }

async function passkeyState(schoolId, deps = {}) {
  const db = deps.pool || pool;
  const s = (await db.query(
    `SELECT id, name, mpesa_shortcode, (mpesa_consumer_key_enc IS NOT NULL AND mpesa_consumer_secret_enc IS NOT NULL) AS has_keys,
            (mpesa_passkey_enc IS NOT NULL) AS has_passkey FROM schools WHERE id = $1`, [Number(schoolId)])).rows[0];
  if (!s) throw refuse('No such school.', 404);
  return { id: s.id, name: s.name, shortcode: s.mpesa_shortcode, hasKeys: s.has_keys, hasPasskey: s.has_passkey };
}

// Checks the shape only. Only Safaricom can say if it is the right one (the first live push tells us).
function checkPasskeyShape(text) {
  const p = String(text || '').trim();
  if (!p) throw refuse('The passkey is empty.');
  if (/\s/.test(p)) throw refuse('A passkey has no spaces. Copy it again, exactly.');
  if (p.length < 20 || p.length > 128) throw refuse('That does not look like a passkey (usually about 64 letters and numbers). Copy it again from Daraja.');
  if (!/^[A-Za-z0-9]+$/.test(p)) throw refuse('A passkey has only letters and numbers. Copy it again, exactly.');
  return p;
}

async function savePasskey(schoolId, passkeyText, { replace = false, staffId = null } = {}, deps = {}) {
  const db = deps.pool || pool;
  const st = await passkeyState(schoolId, deps);
  if (!st.shortcode || !st.hasKeys) throw refuse(`${st.name} has no M-Pesa Paybill and keys saved yet. Set up M-Pesa first, then add the passkey.`, 409);
  if (st.hasPasskey && !replace) throw refuse(`${st.name} already has a passkey. To change it, run again with --replace.`, 409);
  const p = checkPasskeyShape(passkeyText);
  await db.query('UPDATE schools SET mpesa_passkey_enc = $1 WHERE id = $2', [encrypt(p), st.id]);
  await logAudit({ schoolId: st.id, staffId, action: st.hasPasskey ? 'mpesa_keys_replaced' : 'mpesa_keys_saved', detail: { what: 'stk passkey' } });
  return { school: st.name, replaced: st.hasPasskey };
}

async function getPasskey(schoolId, deps = {}) {
  const db = deps.pool || pool;
  const r = (await db.query('SELECT mpesa_passkey_enc FROM schools WHERE id = $1', [Number(schoolId)])).rows[0];
  return r ? decrypt(r.mpesa_passkey_enc) : null;
}

module.exports = { passkeyState, savePasskey, getPasskey, checkPasskeyShape };