/**
 * M-Pesa setup rules in ONE place. The command-line script, the screen's routes (and later an
 * operator dashboard) all use this, so nothing can skip a rule.
 *
 * What registering means: we tell Safaricom the two web addresses to call when money arrives on a
 * school's Paybill. They contain a secret code (40 random characters), because Safaricom does not
 * sign its messages. WE make that code, one per school, and store it encrypted in the database
 * (see mpesaUrlToken.js). Safaricom just stores the whole address and calls it later.
 *
 * In PRODUCTION registering is effectively one time only, so we refuse the risky cases:
 *   - the public address is missing, not https, or contains a word Safaricom blocks
 *   - the school was already registered (needs an explicit force, which only the command line has)
 * If Safaricom says no (or cannot be reached), nothing is recorded: a failed attempt never
 * changes what already works. The full address is NEVER returned to a screen: only a masked
 * preview with the secret code hidden. (getFullUrls is for trusted internal tools only.)
 */
const { pool } = require('../db/db');
const mpesa = require('../connectors/mpesa');
const { getSchoolCredentials } = require('./schoolCredentials');
const { logAudit } = require('./audit');
const { generateUrlToken, protect, reveal } = require('./mpesaUrlToken');
const { encrypt } = require('../security/crypto');

const isProduction = () => process.env.MPESA_ENV === 'production';

function refuse(message, status = 400) { const e = new Error(message); e.status = status; return e; }

// Only matters for schools registered BEFORE per-school codes existed (they still use the shared secret).
function secretSource() {
  if (process.env.C2B_URL_SECRET) return 'dedicated';
  if (process.env.JWT_SECRET) return 'login_secret_fallback';
  return 'missing';
}

// Is the public address usable for Safaricom? { base, ok, problem }
function baseState(base) {
  const clean = String(base || '').replace(/\/+$/, '');
  if (!clean) return { base: '', ok: false, problem: 'The public address (PUBLIC_BASE_URL) is not set on the server.' };
  try {
    mpesa.assertCallbackUrlAllowed(clean + '/webhooks/c2b/x/confirmation');
    return { base: clean, ok: true, problem: null };
  } catch (err) {
    return { base: clean, ok: false, problem: err.message };
  }
}

// Hide the secret code: .../c2b/3f9a1c...(40 chars)/confirmation  ->  .../c2b/3f9a.../confirmation
const maskUrl = (url) => String(url).replace(/(\/c2b\/)([0-9a-f]{4})[0-9a-f]+/i, '$1$2\u2026');
const maskedUrls = (urls) => ({ confirmation: maskUrl(urls.confirmationUrl), validation: maskUrl(urls.validationUrl) });

function looksSuccessful(data) {
  if (!data) return false;
  if (String(data.ResponseCode) === '0') return true;
  return /success/i.test(String(data.ResponseDescription || ''));
}

/* ---------------- what the screen is told ---------------- */

/**
 * How far along is M-Pesa for this school?
 *   stage: 'no_keys' | 'keys_saved' (keys saved, addresses not registered) | 'registered'
 * (A school already receiving M-Pesa payments counts as registered, even if it was set up before this record existed.)
 *   token_kind: 'stored' (its own code, in the database) | 'legacy' (older shared-secret code) | 'none'
 */
async function mpesaStatus(schoolId, hasPayments = false) {
  const r = await pool.query(
    `SELECT mpesa_shortcode, (mpesa_consumer_key_enc IS NOT NULL AND mpesa_consumer_secret_enc IS NOT NULL) AS keys_saved,
            mpesa_urls_registered_at, mpesa_urls_registered_base, mpesa_url_token_enc, (mpesa_passkey_enc IS NOT NULL) AS has_passkey
       FROM schools WHERE id = $1`, [schoolId]);
  const s = r.rows[0] || {};
  const keysSaved = Boolean(s.mpesa_shortcode && s.keys_saved);
  const registered = Boolean(s.mpesa_urls_registered_at) || (keysSaved && hasPayments);
  const stored = reveal(s.mpesa_url_token_enc);
  const tokenKind = stored ? 'stored' : (registered ? 'legacy' : 'none');
  const base = baseState(process.env.PUBLIC_BASE_URL);

  let preview = null;   // masked: shows the address is right, never the secret code
  if (keysSaved && base.ok) {
    if (stored) preview = maskedUrls(mpesa.buildUrlsFromToken(base.base, stored));
    else if (tokenKind === 'legacy' && secretSource() !== 'missing') preview = maskedUrls(mpesa.buildCallbackUrls(base.base, s.mpesa_shortcode));
  }
  const blockers = [];
  if (!keysSaved) blockers.push('Save the Paybill number and the Daraja keys first.');
  if (!base.ok) blockers.push(base.problem);
  if (isProduction() && registered) blockers.push('Already registered. In production this is one time only.');

  return {
    stage: !keysSaved ? 'no_keys' : (registered ? 'registered' : 'keys_saved'),
    keys_saved: keysSaved,
    // OPTIONAL: the passkey only switches on "Send request to my phone" in the parent portal. Without it the school still receives
    // payments exactly as before and parents pay from the M-Pesa menu. It never blocks registering.
    has_passkey: Boolean(s.has_passkey),
    stk_ready: Boolean(keysSaved && s.has_passkey && base.ok),
    registered_at: s.mpesa_urls_registered_at || null,
    registered_base: s.mpesa_urls_registered_base || null,
    token_kind: tokenKind,
    legacy_secret_source: tokenKind === 'legacy' ? secretSource() : null,
    production: isProduction(),
    public_address_ok: base.ok,
    public_address_problem: base.problem,
    can_register: blockers.length === 0,
    blockers,
    preview,
  };
}

/* ---------------- saving the Paybill and the Daraja keys ---------------- */

// Checks the typed values. Throws a 400 with a message the screen can show.
function validateKeysInput({ paybill, consumerKey, consumerSecret }) {
  const pb = String(paybill == null ? '' : paybill).replace(/\s+/g, '');
  if (!/^\d{5,7}$/.test(pb)) throw refuse('Enter the Paybill number using digits only (5 to 7 digits).');
  const key = String(consumerKey == null ? '' : consumerKey).trim();
  const secret = String(consumerSecret == null ? '' : consumerSecret).trim();
  if (!/^\S{8,200}$/.test(key)) throw refuse('Enter the Daraja Consumer Key (no spaces).');
  if (!/^\S{8,200}$/.test(secret)) throw refuse('Enter the Daraja Consumer Secret (no spaces).');
  return { paybill: pb, consumerKey: key, consumerSecret: secret };
}

/**
 * Saves (or replaces) a school's Paybill number and Daraja keys, encrypted. Returns { replaced }.
 * The Paybill number cannot be changed once the school is registered or receiving payments:
 * that would cut off the registered addresses.
 */
async function saveMpesaKeys({ schoolId, paybill, consumerKey, consumerSecret }) {
  const v = validateKeysInput({ paybill, consumerKey, consumerSecret });
  const cur = (await pool.query(
    `SELECT mpesa_shortcode, mpesa_urls_registered_at,
            (mpesa_consumer_key_enc IS NOT NULL AND mpesa_consumer_secret_enc IS NOT NULL) AS keys_saved,
            EXISTS (SELECT 1 FROM transactions t WHERE t.school_id = schools.id AND t.source = 'mpesa') AS has_payments
       FROM schools WHERE id = $1`, [schoolId])).rows[0];
  if (!cur) throw refuse('School not found', 404);
  const live = Boolean(cur.mpesa_urls_registered_at) || cur.has_payments;
  if (live && cur.mpesa_shortcode && cur.mpesa_shortcode !== v.paybill) {
    throw refuse('The Paybill number cannot be changed after the school is registered or receiving payments. Contact Karo Recon support.', 409);
  }
  try {
    await pool.query(
      `UPDATE schools SET mpesa_shortcode = $2, mpesa_consumer_key_enc = $3, mpesa_consumer_secret_enc = $4 WHERE id = $1`,
      [schoolId, v.paybill, encrypt(v.consumerKey), encrypt(v.consumerSecret)]);
  } catch (err) {
    if (err && err.code === '23505') throw refuse('This Paybill number is already registered to another school. If it is really yours, contact Karo Recon support.', 409);
    throw err;
  }
  return { replaced: Boolean(cur.keys_saved) };
}

/* ---------------- "check keys" ---------------- */

/**
 * Proves the school's Daraja keys are accepted by Safaricom. Registers nothing, changes nothing.
 * Returns { ok: true } or { ok: false, reason: 'no_keys' | 'rejected' | 'unexpected' | 'unreachable', message }.
 * The message never contains a key.
 */
async function checkKeys(schoolId, deps = {}) {
  const getCreds = deps.getCredentials || getSchoolCredentials;
  const verify = deps.verify || mpesa.verifyCredentials;
  const school = await getCreds(schoolId);
  if (!school || !school.shortcode || !school.consumerKey || !school.consumerSecret) {
    return { ok: false, reason: 'no_keys', message: 'No Paybill number or Daraja keys are saved for this school yet.' };
  }
  try {
    const ok = await verify(school.consumerKey, school.consumerSecret);
    return ok
      ? { ok: true, message: 'Safaricom accepted these keys.' }
      : { ok: false, reason: 'rejected', message: 'Safaricom did not accept these keys.' };
  } catch (err) {
    const code = err.response && err.response.status;
    // Only 400/401 really mean "wrong keys". Anything else (a firewall's 403, a 5xx) is NOT the school's fault.
    if (code === 400 || code === 401) {
      return { ok: false, reason: 'rejected', message: 'Safaricom did not accept these keys. Check the Consumer Key and Secret (and that they are the PRODUCTION ones for a live school).' };
    }
    if (code) {
      return { ok: false, reason: 'unexpected', message: `Safaricom gave an unexpected answer (HTTP ${code}). This does not mean the keys are wrong. Try again, and tell us if it keeps happening.` };
    }
    return { ok: false, reason: 'unreachable', message: 'Could not reach Safaricom to check. Try again in a moment.' };
  }
}

/* ---------------- registering with Safaricom ---------------- */

/**
 * The real (or dry) registration for ONE school.
 * dry  -> { dry: true, preview } (masked; the real code is only made when you really register)
 * real -> { dry: false, preview, data, school } ; the full addresses are never returned
 * Throws an Error (with .status) for every refused case, and a refused or failed attempt changes nothing.
 *
 * Order of events (so no failure can break what already works):
 *   1. make a new code and keep it as PENDING (the webhook accepts pending codes too)
 *   2. ask Safaricom to register the two addresses
 *   3. only if Safaricom confirms: the pending code becomes the school's code, and the date is recorded
 *      if Safaricom refuses or cannot be reached: the pending code is thrown away
 */
async function registerForSchool({ schoolId, staffId = null, base, dry = false, force = false }, deps = {}) {
  const getCreds = deps.getCredentials || getSchoolCredentials;
  const register = deps.register || mpesa.registerC2BUrls;
  const makeToken = deps.generateToken || generateUrlToken;

  const school = await getCreds(schoolId);
  if (!school) throw refuse(`No school found with id ${schoolId}`, 404);
  if (!school.shortcode || !school.consumerKey || !school.consumerSecret) {
    throw refuse('This school has no Paybill number or Daraja keys saved yet.');
  }
  const b = baseState(base);
  if (!b.ok) throw refuse(b.problem || 'The public address is not usable.');

  // "Already registered" = we recorded it, OR M-Pesa payments are already arriving (a school set up before we recorded dates).
  const prior = (await pool.query(
    `SELECT mpesa_urls_registered_at, EXISTS (SELECT 1 FROM transactions t WHERE t.school_id = schools.id AND t.source = 'mpesa') AS has_payments
       FROM schools WHERE id = $1`, [schoolId])).rows[0] || {};
  if (isProduction() && (prior.mpesa_urls_registered_at || prior.has_payments) && !force) {
    const when = prior.mpesa_urls_registered_at ? `on ${new Date(prior.mpesa_urls_registered_at).toISOString().slice(0, 10)}` : '(M-Pesa payments are already arriving)';
    throw refuse(`Already registered ${when}. In production this is one time only. Only if Safaricom has already deleted the old addresses can it be forced from the command line.`, 409);
  }

  if (dry) {
    return { dry: true, school, preview: maskedUrls(mpesa.buildUrlsFromToken(b.base, makeToken())) };
  }

  const token = makeToken();
  const urls = mpesa.buildUrlsFromToken(b.base, token);
  try { mpesa.assertCallbackUrlAllowed(urls.confirmationUrl); mpesa.assertCallbackUrlAllowed(urls.validationUrl); }
  catch (err) { throw refuse(err.message); }

  // 1. keep the new code as pending
  await pool.query('UPDATE schools SET mpesa_url_token_pending_enc = $2 WHERE id = $1', [schoolId, protect(token)]);
  const dropPending = () => pool.query('UPDATE schools SET mpesa_url_token_pending_enc = NULL WHERE id = $1', [schoolId]);

  // 2. Safaricom
  let data;
  try {
    data = await register({ consumerKey: school.consumerKey, consumerSecret: school.consumerSecret, shortcode: school.shortcode, ...urls });
  } catch (err) {
    await dropPending();
    throw err;
  }
  if (!looksSuccessful(data)) {
    await dropPending();
    throw refuse('Safaricom did not confirm the registration: ' + JSON.stringify(data), 502);
  }

  // 3. confirmed: the pending code becomes the school's code
  let origin = b.base;
  try { origin = new URL(urls.confirmationUrl).origin; } catch (e) { /* keep base */ }
  await pool.query(
    `UPDATE schools SET mpesa_url_token_enc = mpesa_url_token_pending_enc, mpesa_url_token_pending_enc = NULL,
            mpesa_urls_registered_at = NOW(), mpesa_urls_registered_base = $2 WHERE id = $1`,
    [schoolId, origin]);
  await logAudit({ schoolId, staffId, action: 'mpesa_urls_registered', detail: { base: origin, forced: Boolean(force) } });
  return { dry: false, school, data, preview: maskedUrls(urls) };
}

/**
 * The FULL addresses (secret code included). For trusted internal tools only, for example a future
 * operator dashboard, so an operator can copy them. NEVER connect this to a route a school can reach.
 */
async function getFullUrls(schoolId, base) {
  const r = await pool.query('SELECT mpesa_url_token_enc FROM schools WHERE id = $1', [schoolId]);
  const token = reveal(r.rows[0] && r.rows[0].mpesa_url_token_enc);
  if (!token) throw refuse('This school has no stored M-Pesa code (it was registered the older way, or not registered yet).', 404);
  const b = baseState(base || process.env.PUBLIC_BASE_URL);
  if (!b.ok) throw refuse(b.problem);
  return mpesa.buildUrlsFromToken(b.base, token);
}

module.exports = {
  mpesaStatus, saveMpesaKeys, validateKeysInput, checkKeys, registerForSchool, getFullUrls,
  secretSource, baseState, maskUrl, looksSuccessful,
};