const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db/db');
const { normalizeC2BPayload } = require('../connectors/mpesa');
const { tokenAccepted } = require('../services/mpesaUrlToken');
const { normalizeIPNPayload, extractOrgIdentifiers, buildAckResponse, checkSignature: checkKcbSignature } = require('../connectors/kcb');
const { normalizeIPNPayload: normalizeEquityIPN, isSuccessfulPayment: isEquitySuccess, isCreditPayment: isEquityCredit } = require('../connectors/equityJenga');
const { decrypt } = require('../security/crypto');
const { fingerprint: fingerprintEquityPassword } = require('../services/equitySetup');
const { normalizeINSPayload: normalizeCoopINS, isCreditEvent: isCoopCredit, eventKind: coopEventKind, extractAccountNumber: extractCoopAccount, buildAckResponse: buildCoopAck } = require('../connectors/coop');
const { ingestPayment } = require('../services/ingest');
const { handleCallback: handleStkCallback } = require('../services/stkCallback');

const router = express.Router();

/**
 * Finds the school for a KCB notification. Identifiers come most specific
 * first; the first one that matches EXACTLY ONE school wins. If an identifier
 * is shared by several schools (e.g. a common shortcode) we never guess.
 */
async function schoolForKcbIdentifiers(identifiers) {
  if (identifiers.length === 0) return null;
  const result = await pool.query(
    `SELECT s.*, sbc.account_number AS kcb_identifier
     FROM schools s
     JOIN school_bank_connections sbc ON sbc.school_id = s.id
     JOIN bank_providers bp ON bp.id = sbc.provider_id
     WHERE bp.code = 'kcb' AND sbc.account_number = ANY($1)`,
    [identifiers]
  );
  for (const id of identifiers) {
    const matches = result.rows.filter((r) => r.kcb_identifier === id);
    if (matches.length === 1) return matches[0];
  }
  return null;
}

let warnedUnsignedKcb = false;

/**
 * KCB pushes one notification per credit, in either of two shapes (see
 * connectors/kcb.js). Order of events: signature, shape, school, ingest, ack.
 */
router.post('/kcb/ipn', async (req, res) => {
  const check = checkKcbSignature(req);
  if (!check.ok) {
    console.error('KCB IPN rejected:', check.reason);
    return res.status(401).json({ error: 'Signature check failed' });
  }
  if (check.skipped && !warnedUnsignedKcb) {
    warnedUnsignedKcb = true;
    console.warn('WARNING: KCB_IPN_PUBLIC_KEY is not set, so KCB signatures are NOT being checked. Fine for local testing only.');
  }

  const payment = normalizeIPNPayload(req.body);
  if (!payment.external_ref || !(payment.amount > 0)) {
    return res.status(400).json({ error: 'Not a recognisable KCB notification' });
  }

  const identifiers = extractOrgIdentifiers(req.body);
  const school = await schoolForKcbIdentifiers(identifiers);
  if (!school) {
    console.error('KCB IPN for unrecognized or shared identifier:', identifiers, req.body);
    // Still acknowledge - the money has already moved, rejecting won't undo it.
    return res.json(buildAckResponse(req.body, payment.external_ref));
  }

  const result = await ingestPayment({ ...payment, school_id: school.id });
  console.log(
    result.alreadyProcessed
      ? `Duplicate KCB IPN for ${payment.external_ref}, ignored`
      : `Ingested KCB ${payment.external_ref}: ${result.match.status}`
  );
  return res.json(buildAckResponse(req.body, result.transactionId));
});

/**
 * Equity does not sign its messages, so the Basic Auth username/password the
 * school chose in JengaHQ is the only protection AND the routing key: we keep
 * that username in account_number and the password (encrypted) in the
 * credentials blob. Use a long random password for every school.
 */
function safeEqual(a, b) {
  // Hash both first so the two buffers are the same length, then compare in
  // constant time (so response timing can't leak how much of a guess matched).
  const hashA = crypto.createHash('sha256').update(String(a)).digest();
  const hashB = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

async function schoolForEquityAuth(username, password) {
  const result = await pool.query(
    `SELECT s.*, sbc.credentials_enc FROM schools s
     JOIN school_bank_connections sbc ON sbc.school_id = s.id
     JOIN bank_providers bp ON bp.id = sbc.provider_id
     WHERE bp.code = 'equity' AND sbc.account_number = $1`,
    [username]
  );
  const row = result.rows[0];
  if (!row) return null;

  const storedCreds = JSON.parse(decrypt(row.credentials_enc) || '{}');
  // Connections made by "Connect Equity" keep only a fingerprint of the password;
  // older hand-made connections kept the password itself (encrypted). Accept both.
  let passwordOk = false;
  if (storedCreds.ipn_password_hash) {
    passwordOk = safeEqual(storedCreds.ipn_password_hash, fingerprintEquityPassword(password));
  } else if (storedCreds.ipn_password) {
    passwordOk = safeEqual(storedCreds.ipn_password, password);
  }
  return passwordOk ? row : null;
}

function parseBasicAuth(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return null;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const colon = decoded.indexOf(':'); // the password itself may contain ":"
  if (colon < 0) return null;
  return { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

/**
 * One URL for both kinds of Equity push (gateway IPN and Account Alerts).
 * Order: password check, successful?, money coming in?, readable?, ingest.
 */
router.post('/equity/ipn', async (req, res) => {
  const auth = parseBasicAuth(req);
  if (!auth) return res.status(401).json({ error: 'Missing Basic Auth' });

  const school = await schoolForEquityAuth(auth.username, auth.password);
  if (!school) {
    console.error('Equity push with unrecognized or invalid credentials:', auth.username);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  if (!isEquitySuccess(req.body)) {
    console.log('Equity: ignoring non-successful transaction', req.body.transaction && req.body.transaction.status);
    return res.json({ status: 'acknowledged' });
  }
  if (!isEquityCredit(req.body)) {
    console.log('Equity: ignoring a debit (money going out), not a payment');
    return res.json({ status: 'acknowledged' });
  }

  const payment = normalizeEquityIPN(req.body);
  if (!payment.external_ref || !(payment.amount > 0)) {
    return res.status(400).json({ error: 'Not a recognisable Equity notification' });
  }

  const result = await ingestPayment({ ...payment, school_id: school.id });
  console.log(
    result.alreadyProcessed
      ? `Duplicate Equity message for ${payment.external_ref}, ignored`
      : `Ingested Equity ${payment.external_ref}: ${result.match.status}`
  );
  return res.json({ status: 'acknowledged' });
});

/**
 * Co-op's portal lists the credential as "Basic" (a header parameter AND a field
 * in the message) and does not say whether it arrives as the normal
 * "Authorization: Basic ..." header. We accept all three places so the first real
 * message is not refused for arriving in a slightly different spot. The username
 * AND password must still match exactly - this only widens WHERE we look.
 */
function decodeCoopCredential(value) {
  const raw = String(value || '').trim().replace(/^Basic\s+/i, '');
  if (!raw) return null;
  let candidate = raw;
  const decoded = Buffer.from(raw, 'base64').toString('utf8');
  if (decoded.includes(':') && /^[\x20-\x7e]+$/.test(decoded)) candidate = decoded; // base64 of "user:pass"
  const colon = candidate.indexOf(':');
  if (colon < 1) return null;
  return { username: candidate.slice(0, colon), password: candidate.slice(colon + 1) };
}

function parseCoopCredentials(req) {
  return parseBasicAuth(req)
    || decodeCoopCredential(req.headers.basic)
    || decodeCoopCredential(req.body && req.body.Basic);
}

/**
 * Co-op names the school's account in every message, so the account number
 * finds the school, and the Basic Auth username + password we gave Co-op must
 * then match what we stored for that account. If the account is unknown or
 * shared by two schools we never guess. Every failure looks the same (401).
 */
async function schoolForCoopAuth(accountNumber, username, password) {
  if (!accountNumber) return null;
  const result = await pool.query(
    `SELECT s.*, sbc.credentials_enc FROM schools s
     JOIN school_bank_connections sbc ON sbc.school_id = s.id
     JOIN bank_providers bp ON bp.id = sbc.provider_id
     WHERE bp.code = 'coop' AND sbc.account_number = $1`,
    [accountNumber]
  );
  if (result.rows.length !== 1) return null;
  const row = result.rows[0];

  const stored = JSON.parse(decrypt(row.credentials_enc) || '{}');
  if (!stored.ins_username || !stored.ins_password_hash) return null;
  const userOk = safeEqual(stored.ins_username, username);
  const passOk = safeEqual(stored.ins_password_hash, fingerprintEquityPassword(password)); // same fingerprint method
  return userOk && passOk ? row : null;
}

/**
 * Co-op's Instant Notification Service. Order: login + account, credit only,
 * readable, ingest, acknowledge.
 */
router.post('/coop/ins', async (req, res) => {
  const auth = parseCoopCredentials(req);
  if (!auth) return res.status(401).json({ error: 'Missing credentials' });

  const accountNumber = extractCoopAccount(req.body);
  const school = await schoolForCoopAuth(accountNumber, auth.username, auth.password);
  if (!school) {
    console.error('Co-op INS with unrecognized account or invalid credentials, account:', accountNumber);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const kind = coopEventKind(req.body);
  if (kind === 'unknown') {
    // Not a clear credit or debit. Acknowledge (so Co-op doesn't keep resending) but shout:
    // this could be a REAL payment under a name we haven't seen yet.
    console.error('Co-op: UNKNOWN event type, NOT saved. Check whether this is a real payment:', JSON.stringify(req.body));
    return res.json(buildCoopAck(req.body));
  }
  if (kind === 'debit') {
    console.log('Co-op: ignoring a debit (money going out), not a payment');
    return res.json(buildCoopAck(req.body));
  }

  const payment = normalizeCoopINS(req.body);
  if (!payment.external_ref || !(payment.amount > 0)) {
    return res.status(400).json({ error: 'Not a recognisable Co-op notification' });
  }

  const result = await ingestPayment({ ...payment, school_id: school.id });
  console.log(
    result.alreadyProcessed
      ? `Duplicate Co-op message for ${payment.external_ref}, ignored`
      : `Ingested Co-op ${payment.external_ref}: ${result.match.status}`
  );
  return res.json(buildCoopAck(req.body));
});

/**
 * Resolves which school a webhook belongs to, by matching the shortcode
 * Safaricom sends against the school we registered it under. Every school
 * has its own paybill, so this is how one shared server handles many schools.
 */
async function schoolForShortcode(shortcode) {
  const result = await pool.query(
    `SELECT * FROM schools WHERE mpesa_shortcode = $1`,
    [shortcode]
  );
  return result.rows[0] || null;
}

/**
 * Safaricom does NOT sign its callbacks, so a stranger who guessed our URL could
 * post a fake payment. Defence: each school's registered URLs contain a long
 * secret code (made per school, see services/mpesaUrlToken.js), checked here against the
 * shortcode in the message. The older plain paths (/webhooks/mpesa/... and /webhooks/c2b/...)
 * keep working OUTSIDE production so local tests and curl still work; in
 * production they answer 404.
 */
async function c2bAuthorized(req) {
  if (req.params.token) {
    const shortcode = String((req.body && req.body.BusinessShortCode) || '');
    if (!shortcode) return false;
    // The school's own stored code (or, for schools registered before codes were stored, the older shared one).
    return tokenAccepted(req.params.token, shortcode, await schoolForShortcode(shortcode));
  }
  return process.env.NODE_ENV !== 'production';
}

/**
 * Validation fires BEFORE Safaricom accepts the payment - use it to reject
 * obviously bad transactions (e.g. wrong school entirely). Keep this fast
 * and conservative: rejecting a legitimate payment here is worse than
 * accepting one you'll sort out in the review queue.
 * (Safaricom only calls this if the shortcode owner asked for validation to be
 * switched on. C2B00015 = invalid shortcode.)
 */
async function c2bValidation(req, res) {
  if (!(await c2bAuthorized(req))) return res.status(404).json({ error: 'Not found' });
  const school = await schoolForShortcode(req.body.BusinessShortCode);
  if (!school) {
    return res.json({ ResultCode: 'C2B00015', ResultDesc: 'Rejected - invalid shortcode' });
  }
  return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
}

/**
 * Confirmation fires AFTER the payment has already gone through - this is
 * the one that actually books the transaction. Never reject a REAL payment
 * here; the money has moved regardless of what we say.
 */
async function c2bConfirmation(req, res) {
  if (!(await c2bAuthorized(req))) return res.status(404).json({ error: 'Not found' });

  const school = await schoolForShortcode(req.body.BusinessShortCode);
  if (!school) {
    console.error('Confirmation for unknown shortcode:', req.body.BusinessShortCode, req.body);
    return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }

  const payment = normalizeC2BPayload(req.body);
  if (!payment.external_ref || !(payment.amount > 0)) {
    return res.status(400).json({ error: 'Not a recognisable M-Pesa notification' });
  }
  const result = await ingestPayment({ ...payment, school_id: school.id });

  console.log(
    result.alreadyProcessed
      ? `Duplicate webhook for ${payment.external_ref}, ignored`
      : `Ingested ${payment.external_ref}: ${result.match.status}`
  );

  return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
}

/**
 * STK push result: Safaricom posts here after the parent enters (or cancels) the M-Pesa PIN. The address was built by
 * services/stkPush.js and carries the request number and a one-time secret code, so a stranger cannot fake a "paid" message.
 * Wrong number or code -> 404 (looks like any other missing page). Everything else is in services/stkCallback.js.
 * NOTE: this address contains no "mpesa" word on purpose (Safaricom blocks callback URLs that do).
 */
router.post('/stk/:requestId/:token/result', async (req, res) => {
  const out = await handleStkCallback({ requestId: req.params.requestId, token: req.params.token, body: req.body });
  console.log(`STK request ${req.params.requestId}: ${out.state}${out.duplicate ? ' (repeat, ignored)' : ''}${out.how ? ' (' + out.how + ')' : ''}`);
  return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

// The registered (secret-token) paths - the ones Safaricom is given
router.post('/c2b/:token/validation', c2bValidation);
router.post('/c2b/:token/confirmation', c2bConfirmation);
// Plain paths - local testing only (answer 404 in production)
router.post(['/c2b/validation', '/mpesa/validation'], c2bValidation);
router.post(['/c2b/confirmation', '/mpesa/confirmation'], c2bConfirmation);

module.exports = router;