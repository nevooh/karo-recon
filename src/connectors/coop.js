/**
 * Co-operative Bank connector - RECEIVING payments only.
 *
 * Co-op's developer portal documents an "Instant Notification Service" (INS,
 * listed as "SendTransactionINS"): Co-op POSTs a Debit/Credit event to an
 * endpoint of ours, protected by Basic Auth credentials that WE supply to Co-op.
 * There is no signature, so those credentials are the only protection.
 *
 * What a message contains (from the portal): MessageReference, AccountNumber
 * (the school's Co-op account - this is how we know which school was paid),
 * Amount, EventType (DEBIT/CREDIT), TransactionId (Co-op's own number),
 * Narration (max 25 characters), CustMemo.CustMemoLine1-3, PaymentRef, balances.
 *
 * The parent's typed reference is probably in Narration and/or the CustMemo
 * lines. Narration is cut at 25 characters, so we offer EVERY text field to
 * the matcher; a real sample will show which one holds it.
 *
 * The old polling code is gone: it called endpoints that don't exist in Co-op's
 * documentation and would have counted money going OUT as payments.
 */

const text = (value) => (value == null ? '' : String(value).trim());

function buildReference(body) {
  const memo = body.CustMemo || {};
  const parts = [];
  [body.Narration, memo.CustMemoLine1, memo.CustMemoLine2, memo.CustMemoLine3, body.PaymentRef].forEach((value) => {
    const t = text(value);
    if (t && t !== text(body.TransactionId) && !parts.includes(t)) parts.push(t);
  });
  return parts.join(' | ');
}

/** Turns an INS message into what ingestPayment() expects. */
function normalizeINSPayload(body) {
  return {
    source: 'coop',
    external_ref: text(body.TransactionId) || text(body.MessageReference),
    amount: Number(text(body.Amount).replace(/,/g, '')),
    payer_phone: null, // Co-op's message carries no payer phone or name
    payer_name: null,
    narration: buildReference(body),
    raw: body,
  };
}

/**
 * Only CREDIT events are payments. The notification service covers debits too
 * (the portal's own sample is a DEBIT), and the school's spending must never be
 * counted as fees. Anything that isn't clearly a credit is ignored - but an
 * UNKNOWN type is reported separately so it can be logged loudly: the portal
 * only shows a DEBIT sample, so the real credit wording is still unconfirmed.
 */
function eventKind(body) {
  const type = text(body && body.EventType).toUpperCase();
  if (type === 'CREDIT' || type === 'CR' || type === 'C') return 'credit';
  if (type === 'DEBIT' || type === 'DR' || type === 'D') return 'debit';
  return 'unknown';
}
const isCreditEvent = (body) => eventKind(body) === 'credit';

function extractAccountNumber(body) {
  return text(body && body.AccountNumber);
}

/** The reply Co-op expects: HTTP 200 with code 0 ("Acknowledged"). */
function buildAckResponse(body) {
  return {
    MessageReference: text(body && body.MessageReference),
    MessageDateTime: new Date().toISOString().slice(0, 19),
    MessageCode: '0',
    MessageDescription: 'Acknowledged',
  };
}

module.exports = { normalizeINSPayload, isCreditEvent, eventKind, extractAccountNumber, buildAckResponse, buildReference };
