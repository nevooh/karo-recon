/**
 * STK push rules in ONE place (the parent portal's server and, later, any staff screen use this).
 *   createPush     checks everything, saves a request row, asks Safaricom to show the prompt on the phone
 *   getPushStatus  what the portal polls while the parent is entering the PIN
 * This file NEVER marks anything paid and never touches a balance: the paid result comes from the callback (step 4)
 * and goes through the normal payment path, so a payment is counted once.
 *
 * Rules (each refused with a plain message BEFORE anything is sent to Safaricom):
 *   - amount: whole shillings, 1 up to the limit (150,000 unless STK_MAX_AMOUNT in .env says otherwise)
 *   - the school must have M-Pesa switched on, with its Paybill, keys and passkey saved
 *   - the student must belong to the school and be in school now (active or repeating)
 *   - one open request per student (a second tap is refused for 2 minutes)
 *   - at most 3 requests to one phone in 10 minutes (so nobody can flood a stranger's phone with prompts)
 */
const crypto = require('crypto');
const { pool } = require('../db/db');
const stk = require('../connectors/mpesaStk');
const { assertCallbackUrlAllowed } = require('../connectors/mpesa');
const { getSchoolCredentials } = require('./schoolCredentials');
const { getPasskey } = require('./mpesaPasskey');
const { getSelected } = require('./channels');

const MAX_AMOUNT = Number(process.env.STK_MAX_AMOUNT) > 0 ? Number(process.env.STK_MAX_AMOUNT) : 150000;
const OPEN_MINUTES = 2;
// At most this many requests to one phone in the window. STK_PHONE_LIMIT=0 in .env switches the limit OFF (for testing).
const PHONE_LIMIT = (process.env.STK_PHONE_LIMIT || '').trim() !== '' && Number.isFinite(Number(process.env.STK_PHONE_LIMIT)) ? Number(process.env.STK_PHONE_LIMIT) : 3;
const PHONE_WINDOW_MINUTES = 10;
const IN_SCHOOL = ['active', 'repeating'];

function refuse(message, status = 400) { const e = new Error(message); e.status = status; return e; }
const sha256 = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const kes = (n) => Number(n).toLocaleString('en-KE');

async function createPush({ schoolId, studentId, phone, amount }, deps = {}) {
  const db = deps.pool || pool;
  const sId = Number(schoolId), stId = Number(studentId);
  if (!Number.isInteger(sId) || !Number.isInteger(stId)) throw refuse('The school and the student are needed.');

  // 1. things we can check without the database
  const n = Number(amount);
  if (!Number.isInteger(n) || n < 1) throw refuse('The amount must be a whole number of shillings, at least 1.');
  if (n > MAX_AMOUNT) throw refuse(`The most you can pay in one request is KES ${kes(MAX_AMOUNT)}. Pay in parts if you need to.`);
  const msisdn = stk.toMsisdn(phone);
  const base = String(deps.baseUrl || process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  try { assertCallbackUrlAllowed(base + '/webhooks/stk/1/x/result'); }
  catch (err) { console.error('STK push cannot start, PUBLIC_BASE_URL problem:', err.message); throw refuse('Online payment is not available right now. Please try again later.', 503); }

  // 2. the school
  const creds = await (deps.getCreds || getSchoolCredentials)(sId);
  if (!creds) throw refuse('No such school.', 404);
  const passkey = await (deps.getPasskey || getPasskey)(sId);
  const channels = await (deps.getSelected || getSelected)(sId);
  if (!channels.includes('mpesa') || !creds.shortcode || !creds.consumerKey || !creds.consumerSecret || !passkey) {
    throw refuse('This school has not switched on online M-Pesa payment yet.', 409);
  }

  // 3. the student
  const student = (await db.query('SELECT id, admission_no, status FROM students WHERE id = $1 AND school_id = $2', [stId, sId])).rows[0];
  if (!student) throw refuse('No such student at this school.', 404);
  if (!IN_SCHOOL.includes(student.status)) throw refuse('Online payment is only for students who are in school now. Please pay at the school.', 409);

  // 4. open request and phone limit, then save the row. Taking turns on the student so two taps at once cannot both pass.
  const token = crypto.randomBytes(20).toString('hex');
  let requestId;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [stId]);
    const open = await client.query(`SELECT 1 FROM stk_requests WHERE student_id = $1 AND status IN ('created', 'sent') AND created_at > NOW() - make_interval(mins => $2) LIMIT 1`, [stId, OPEN_MINUTES]);
    if (open.rowCount) throw refuse(`A payment request for this student is already open. Check your phone, or wait ${OPEN_MINUTES} minutes and try again.`, 409);
    const recent = await client.query(`SELECT COUNT(*)::int AS n FROM stk_requests WHERE phone = $1 AND created_at > NOW() - make_interval(mins => $2)`, [msisdn, PHONE_WINDOW_MINUTES]);
    if (PHONE_LIMIT > 0 && recent.rows[0].n >= PHONE_LIMIT) throw refuse(`Too many requests to this phone. Please wait ${PHONE_WINDOW_MINUTES} minutes.`, 429);
    requestId = (await client.query(
      `INSERT INTO stk_requests (school_id, student_id, phone, amount, account_ref, callback_token_hash) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [sId, stId, msisdn, n, student.admission_no, sha256(token)])).rows[0].id;
    await client.query('COMMIT');
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; }
  finally { client.release(); }

  // 5. ask Safaricom. If it fails we keep the row as 'failed' with NO result code (so a late callback can still fix it, step 4).
  try {
    const sent = await (deps.connector || stk).sendPush({
      consumerKey: creds.consumerKey, consumerSecret: creds.consumerSecret, shortcode: creds.shortcode, passkey,
      phone: msisdn, amount: n, accountRef: student.admission_no, callbackUrl: `${base}/webhooks/stk/${requestId}/${token}/result`, description: 'School fees',
    });
    await db.query(`UPDATE stk_requests SET status = 'sent', merchant_request_id = $1, checkout_request_id = $2 WHERE id = $3`, [sent.merchantRequestId, sent.checkoutRequestId, requestId]);
    return { requestId, status: 'sent', message: 'Check your phone and enter your M-Pesa PIN.' };
  } catch (err) {
    await db.query(`UPDATE stk_requests SET status = 'failed', result_desc = $1, finished_at = NOW() WHERE id = $2 AND status = 'created'`, [String(err.message).slice(0, 300), requestId]);
    throw err;
  }
}

const MESSAGE = {
  created: 'Sending the request to your phone...',
  sent: 'Waiting for you to enter your M-Pesa PIN.',
  paid: 'Payment received. Thank you.',
  cancelled: 'The request was cancelled on your phone.',
  timeout: 'The request ran out of time before it was answered.',
  failed: 'The payment did not go through. No money was taken.',
};

/** For the portal to poll. Only returns the request if it is this school's and this student's. */
async function getPushStatus(requestId, schoolId, studentId, deps = {}) {
  const db = deps.pool || pool;
  const r = (await db.query(
    `SELECT id, status, amount, mpesa_receipt FROM stk_requests WHERE id = $1 AND school_id = $2 AND student_id = $3`,
    [Number(requestId) || 0, Number(schoolId), Number(studentId)])).rows[0];
  if (!r) throw refuse('No such payment request.', 404);
  return { id: r.id, status: r.status, amount: Number(r.amount), receipt: r.status === 'paid' ? r.mpesa_receipt : null, message: MESSAGE[r.status] || MESSAGE.failed };
}

/**
 * The parent pressed Cancel in the portal: stop waiting NOW so the student is free for a new request (the "already open" rule only
 * looks at created / sent). Money is never lost by this: if the parent still pays the prompt on the phone, the late PAID message
 * (or the normal Paybill alert) books it, exactly as for a timed-out request. Only this school's and this student's open request.
 */
async function cancelPush(requestId, schoolId, studentId, deps = {}) {
  const db = deps.pool || pool;
  const r = await db.query(
    `UPDATE stk_requests SET status = 'cancelled', result_desc = 'Stopped by the parent in the portal', finished_at = NOW()
     WHERE id = $1 AND school_id = $2 AND student_id = $3 AND status IN ('created', 'sent') RETURNING id`,
    [Number(requestId) || 0, Number(schoolId), Number(studentId)]);
  return { cancelled: r.rowCount > 0 };
}

module.exports = { createPush, getPushStatus, cancelPush, MAX_AMOUNT, OPEN_MINUTES, PHONE_LIMIT, sha256 };