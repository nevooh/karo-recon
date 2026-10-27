/**
 * STK push, the second half: what happens AFTER the parent answers on their phone.
 *
 *   handleCallback   Safaricom posts the result to /webhooks/stk/:requestId/:token/result. This checks the secret code in
 *                    the address, then either marks the request cancelled / timed out / failed, or - when it is PAID -
 *                    books the payment on the student's ledger.
 *   refreshIfStale   the safety net for a callback that never comes: while the portal polls, ask Safaricom what
 *                    happened (not more than every 15 seconds, and only after 40 seconds).
 *
 * Counted ONCE, however many messages arrive:
 *   A paid STK push makes Safaricom send TWO messages for the same money: this callback, and the normal Paybill alert
 *   (C2B confirmation, routes/webhooks.js). Both carry the same M-Pesa receipt code, and transactions has
 *   UNIQUE(source, external_ref). Whichever arrives first books the payment; the other finds it and does nothing.
 *   If the Paybill alert got there first but could not tell which student it was for (it goes to the Review queue), this
 *   callback knows the student for certain and settles it.
 *
 * Rules:
 *   - the address carries a secret code; only its SHA-256 fingerprint is in the database (stk_requests.callback_token_hash)
 *   - a PAID message must carry a receipt code and an amount (connectors/mpesaStk.parseCallback refuses it otherwise)
 *   - the amount booked is what Safaricom says it took (it is the money that really moved), even if it differs from the request
 *   - "paid" is final. A cancelled / failed / timeout message never undoes it; a late PAID message does fix a request we had
 *     already given up on (timeout, or failed with no result code)
 *   - the whole thing runs in ONE database transaction on the request row, so a repeated message is a harmless no-op
 */
const crypto = require('crypto');
const { pool } = require('../db/db');
const stk = require('../connectors/mpesaStk');
const { getCurrentTerm, applyPayment } = require('./feeLedger');
const { sha256 } = require('./stkPush');
const { getSchoolCredentials } = require('./schoolCredentials');
const { getPasskey } = require('./mpesaPasskey');
const { logAudit } = require('./audit');

const FIRST_CHECK_SECONDS = 40, CHECK_EVERY_SECONDS = 15, GIVE_UP_SECONDS = 180;

function refuse(message, status = 400) { const e = new Error(message); e.status = status; return e; }
const safeEqual = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

async function handleCallback({ requestId, token, body }, deps = {}) {
  const db = deps.pool || pool;
  const id = Number(requestId);
  if (!Number.isInteger(id) || !token) throw refuse('Not found', 404);

  const client = await db.connect();
  let booked = null;
  try {
    await client.query('BEGIN');
    const row = (await client.query('SELECT * FROM stk_requests WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!row || !row.callback_token_hash || !safeEqual(row.callback_token_hash, sha256(token))) { await client.query('ROLLBACK'); throw refuse('Not found', 404); }

    let cb;
    try { cb = stk.parseCallback(body); } catch (e) { await client.query('ROLLBACK'); throw refuse(e.message, 400); }
    if (row.checkout_request_id && row.checkout_request_id !== cb.checkoutRequestId) { await client.query('ROLLBACK'); throw refuse('This message is not for that request.', 400); }

    if (row.status === 'paid') { await client.query('COMMIT'); return { duplicate: true, state: 'paid' }; }

    // a message that is not "paid" only moves a request that is still open, or one we had already given up on
    const open = ['created', 'sent', 'timeout'].includes(row.status) || (row.status === 'failed' && row.result_code === null);
    if (cb.state !== 'paid') {
      if (open) {
        await client.query(
          `UPDATE stk_requests SET status = $2, result_code = $3, result_desc = $4, callback_payload = $5,
                  checkout_request_id = COALESCE(checkout_request_id, $6), merchant_request_id = COALESCE(merchant_request_id, $7), finished_at = NOW()
           WHERE id = $1`, [id, cb.state, cb.resultCode, cb.resultDesc, JSON.stringify(body), cb.checkoutRequestId, cb.merchantRequestId]);
      }
      await client.query('COMMIT');
      return { duplicate: !open, state: cb.state };
    }

    // ---- PAID: book it ----
    const term = await getCurrentTerm(row.school_id, client);
    const note = cb.amount !== Number(row.amount) ? `Parent portal (STK push). Asked for KES ${Number(row.amount)}, M-Pesa took KES ${cb.amount}.` : 'Parent portal (STK push)';
    const ins = await client.query(
      `INSERT INTO transactions (school_id, term_id, source, external_ref, amount, payer_phone, payer_name, narration, raw_payload,
                                 match_status, matched_student_id, confidence, match_reason)
       VALUES ($1, $2, 'mpesa', $3, $4, $5, NULL, $6, $7, 'auto_matched', $8, 1, $9)
       ON CONFLICT (source, external_ref) DO NOTHING RETURNING id`,
      [row.school_id, term ? term.id : null, cb.receipt, cb.amount, cb.phone || row.phone, row.account_ref, JSON.stringify({ via: 'stk_push', stk_request_id: row.id, callback: body }), row.student_id, note]);
    let txnId, how;
    if (ins.rows.length) {
      txnId = ins.rows[0].id; how = 'booked';
      if (term) await applyPayment(row.student_id, term.id, cb.amount, client);       // no term set up yet: recorded, like any payment, just not on a ledger
    } else {
      // the Paybill alert for the same receipt got here first
      const old = (await client.query(
        `SELECT id, amount, match_status, matched_student_id, term_id FROM transactions WHERE source = 'mpesa' AND external_ref = $1 FOR UPDATE`, [cb.receipt])).rows[0];
      if (!old) throw refuse('This receipt code is already used by a payment that could not be read. Not booked.', 409);
      txnId = old.id; how = 'already_booked';
      if (!old.matched_student_id && ['unmatched', 'needs_review'].includes(old.match_status)) {
        // it was waiting for a person; the push knows exactly who it is for, so settle it now
        await client.query(
          `UPDATE transactions SET match_status = 'auto_matched', matched_student_id = $2, confidence = 1, match_reason = $3, candidates = NULL WHERE id = $1`,
          [old.id, row.student_id, 'Settled by the parent portal request (STK push)']);
        const t2 = old.term_id || (term ? term.id : null);
        if (t2) await applyPayment(row.student_id, t2, Number(old.amount), client);
        how = 'settled_from_review';
      }
    }
    await client.query(
      `UPDATE stk_requests SET status = 'paid', result_code = 0, result_desc = $2, mpesa_receipt = $3, callback_payload = $4,
              checkout_request_id = COALESCE(checkout_request_id, $5), merchant_request_id = COALESCE(merchant_request_id, $6), finished_at = NOW()
       WHERE id = $1`, [id, cb.resultDesc, cb.receipt, JSON.stringify(body), cb.checkoutRequestId, cb.merchantRequestId]);
    await client.query('COMMIT');
    booked = { how, txnId, row, cb };
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; }
  finally { client.release(); }

  if (booked) {
    const stu = (await db.query('SELECT admission_no FROM students WHERE id = $1', [booked.row.student_id])).rows[0];
    await logAudit({ schoolId: booked.row.school_id, action: 'stk_payment_received', detail: {
      student_id: booked.row.student_id, admission_no: stu ? stu.admission_no : null, amount: booked.cb.amount, receipt: booked.cb.receipt, request_id: booked.row.id, how: booked.how } });
    return { duplicate: false, state: 'paid', how: booked.how, transactionId: booked.txnId };
  }
}

/**
 * Called while the portal polls. If the request is still "sent" after 40 seconds, asks Safaricom what happened.
 * Returns the state Safaricom reported ('paid' | 'cancelled' | 'timeout' | 'failed' | 'pending') or null if it did not ask.
 * It can end a request as cancelled / timeout / failed, but it NEVER marks one paid: Safaricom's answer has no receipt code, so
 * only the callback (or the Paybill alert) may book money. Still "pending" after 3 minutes -> 'timeout' (a late PAID callback can still fix that).
 */
async function refreshIfStale(requestId, schoolId, studentId, deps = {}) {
  const db = deps.pool || pool;
  // claim the check atomically: only one poll at a time gets to ask, and not more often than every 15 s
  const row = (await db.query(
    `UPDATE stk_requests SET last_checked_at = NOW()
     WHERE id = $1 AND school_id = $2 AND student_id = $3 AND status = 'sent' AND checkout_request_id IS NOT NULL
       AND created_at < NOW() - make_interval(secs => $4)
       AND (last_checked_at IS NULL OR last_checked_at < NOW() - make_interval(secs => $5))
     RETURNING id, created_at, checkout_request_id, EXTRACT(EPOCH FROM (NOW() - created_at))::int AS age`,
    [requestId, schoolId, studentId, FIRST_CHECK_SECONDS, CHECK_EVERY_SECONDS])).rows[0];
  if (!row) return null;
  const creds = await (deps.getCreds || getSchoolCredentials)(schoolId);
  const passkey = await (deps.getPasskey || getPasskey)(schoolId);
  if (!creds || !passkey) return null;
  const q = await (deps.connector || stk).queryPush({ consumerKey: creds.consumerKey, consumerSecret: creds.consumerSecret, shortcode: creds.shortcode, passkey, checkoutRequestId: row.checkout_request_id });
  if (q.state === 'cancelled' || q.state === 'timeout' || q.state === 'failed') {
    await db.query(`UPDATE stk_requests SET status = $2, result_code = $3, result_desc = $4, finished_at = NOW() WHERE id = $1 AND status = 'sent'`, [row.id, q.state, q.resultCode, q.resultDesc]);
  } else if (q.state === 'pending' && row.age >= GIVE_UP_SECONDS) {
    await db.query(`UPDATE stk_requests SET status = 'timeout', result_desc = 'No answer from M-Pesa', finished_at = NOW() WHERE id = $1 AND status = 'sent'`, [row.id]);
  }
  return q.state;
}

module.exports = { handleCallback, refreshIfStale, FIRST_CHECK_SECONDS, CHECK_EVERY_SECONDS, GIVE_UP_SECONDS };
