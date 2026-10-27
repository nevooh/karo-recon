/**
 * Equity (Jenga) connector - RECEIVING payments only.
 *
 * Equity pushes a message to the callback URL the SCHOOL registers in its own
 * JengaHQ login. Two kinds of push exist, and both reach the same URL here:
 *   IPN  (callbackType "IPN")  payments made through the Jenga payment gateway
 *   ALT  (callbackType "ALT")  Account Alerts: activity on the school's bank account
 *
 * Equity does NOT sign these messages. The only protection is the Basic Auth
 * username/password the school chose when registering the callback - so that
 * username is also how we know WHICH school a message belongs to. There is no
 * Equity public key to check, and nothing here ever calls Jenga's API (so no
 * API keys or private keys are needed on our side).
 */

const text = (value) => (value == null ? '' : String(value).trim());

/**
 * Builds the "reference" text the matcher reads.
 * Equity's own sample alerts don't make it obvious which field holds what the
 * parent typed, so we offer every free-text field (each once) and let the
 * matcher look for an admission number or name inside. A field that merely
 * repeats a bank/transaction id is left out. Anything unsure goes to review.
 */
function buildReference(body) {
  const { customer = {}, transaction = {}, bank = {} } = body;
  const ids = new Set([text(transaction.reference), text(bank.reference)].filter(Boolean));
  const parts = [];
  [transaction.billNumber, customer.reference, transaction.additionalInfo, transaction.remarks].forEach((value) => {
    const t = text(value);
    if (t && !ids.has(t) && !parts.includes(t)) parts.push(t);
  });
  return parts.join(' | ');
}

/** Turns an IPN or ALT message into what ingestPayment() expects. */
function normalizeIPNPayload(body) {
  const { customer = {}, transaction = {} } = body;
  return {
    source: 'equity',
    external_ref: text(transaction.reference),
    amount: Number(text(transaction.amount).replace(/,/g, '')),
    payer_phone: customer.mobileNumber || null,
    payer_name: customer.name || null,
    narration: buildReference(body),
    raw: body,
  };
}

/** Jenga sends FAILED ones too. Only SUCCESS is ever ingested. */
function isSuccessfulPayment(body) {
  return Boolean(body && body.transaction && body.transaction.status === 'SUCCESS');
}

/**
 * Only money coming IN counts. Alerts can be set to debit, credit or both, and
 * a school's own spending must never show up as a fee payment. Equity writes
 * the type as "C"/"Credit" (seen in its samples). No type at all is treated as
 * a credit (gateway payments); anything else, e.g. "Debit", is ignored.
 */
function isCreditPayment(body) {
  const type = text(body && body.bank && body.bank.transactionType).toUpperCase();
  return type === '' || type === 'C' || type === 'CREDIT';
}

module.exports = { normalizeIPNPayload, isSuccessfulPayment, isCreditPayment, buildReference };
