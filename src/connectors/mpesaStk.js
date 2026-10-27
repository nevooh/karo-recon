/**
 * STK push: talks to Safaricom (Daraja "M-Pesa Express"). Nothing here touches our database.
 *   sendPush   -> asks Safaricom to show the pay prompt on a parent's phone
 *   queryPush  -> asks Safaricom "what happened to that push?" (the safety net when the callback does not come)
 *   parseCallback -> reads the result message Safaricom posts back to us
 * Every function takes the school's keys as arguments (like connectors/mpesa.js), so each school uses its own.
 * Secrets (key, secret, passkey, password) are NEVER put in an error message or a log line.
 */
const axios = require('axios');
const { getAccessToken, assertCallbackUrlAllowed } = require('./mpesa');

const BASE_URL = process.env.MPESA_ENV === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
const TIMEOUT = 20000;

function refuse(message, status = 400, code = null) { const e = new Error(message); e.status = status; if (code) e.code = code; return e; }

/** 0712345678, 0112345678, +254712345678, 254712345678, 712345678 -> 254712345678. Anything else is refused. */
function toMsisdn(input) {
  const d = String(input || '').replace(/[\s\-()]/g, '').replace(/^\+/, '');
  let n = null;
  if (/^0[17]\d{8}$/.test(d)) n = '254' + d.slice(1);
  else if (/^254[17]\d{8}$/.test(d)) n = d;
  else if (/^[17]\d{8}$/.test(d)) n = '254' + d;
  if (!n) throw refuse('Enter a Safaricom number like 0712 345 678.');
  return n;
}

/** Safaricom wants the time as YYYYMMDDHHmmss. We use Kenya time. */
function timestamp(date = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Nairobi', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}${p.month}${p.day}${p.hour === '24' ? '00' : p.hour}${p.minute}${p.second}`;
}

const makePassword = (shortcode, passkey, ts) => Buffer.from(`${shortcode}${passkey}${ts}`).toString('base64');

/** Turns a Safaricom or network failure into a plain error. Keeps the Safaricom code in e.code. */
function safaricomError(err, what) {
  const d = err && err.response && err.response.data;
  if (!err || !err.response) return refuse('Could not reach Safaricom. Please try again in a moment.', 502, 'unreachable');
  const code = d && (d.errorCode || d.ResponseCode) ? String(d.errorCode || d.ResponseCode) : String(err.response.status);
  const msg = d && (d.errorMessage || d.ResponseDescription) ? String(d.errorMessage || d.ResponseDescription) : '';
  if (err.response.status === 400 || err.response.status === 401 || /^404\.001\.0[34]$/.test(code)) {
    if (what === 'token') return refuse('Safaricom did not accept this school\'s M-Pesa keys.', 502, 'bad_keys');
  }
  if (code === '500.001.1001' && what === 'push') return refuse('This phone already has an M-Pesa request open. Wait a minute and try again.', 409, code);
  return refuse(`Safaricom refused the request${msg ? ': ' + msg : '.'}`, 502, code);
}

async function tokenFor(consumerKey, consumerSecret) {
  try { return await getAccessToken(consumerKey, consumerSecret); } catch (err) { throw safaricomError(err, 'token'); }
}

/**
 * Sends the push. amount: whole shillings. accountRef: the admission number, at most 12 characters
 * (a longer one would be cut by Safaricom and the payment could not be matched, so we refuse it).
 * Returns { merchantRequestId, checkoutRequestId, customerMessage }. Never treat this as "paid": it only means "prompt sent".
 */
async function sendPush({ consumerKey, consumerSecret, shortcode, passkey, phone, amount, accountRef, callbackUrl, description = 'School fees' }) {
  if (!consumerKey || !consumerSecret || !shortcode || !passkey) throw refuse('This school\'s M-Pesa keys, Paybill or passkey are not all set.', 409);
  const n = Number(amount);
  if (!Number.isInteger(n) || n < 1) throw refuse('The amount must be a whole number of shillings, at least 1.');
  const ref = String(accountRef || '').trim();
  if (!ref) throw refuse('The account reference is missing.');
  if (ref.length > 12) throw refuse('The admission number is longer than 12 characters, so STK push cannot carry it.');
  assertCallbackUrlAllowed(callbackUrl);
  const msisdn = toMsisdn(phone);
  const ts = timestamp();
  const token = await tokenFor(consumerKey, consumerSecret);
  const body = {
    BusinessShortCode: String(shortcode), Password: makePassword(shortcode, passkey, ts), Timestamp: ts,
    TransactionType: 'CustomerPayBillOnline', Amount: n, PartyA: msisdn, PartyB: String(shortcode), PhoneNumber: msisdn,
    CallBackURL: callbackUrl, AccountReference: ref, TransactionDesc: String(description).slice(0, 13),
  };
  let data;
  try {
    ({ data } = await axios.post(`${BASE_URL}/mpesa/stkpush/v1/processrequest`, body, { headers: { Authorization: `Bearer ${token}` }, timeout: TIMEOUT }));
  } catch (err) { throw safaricomError(err, 'push'); }
  if (!data || String(data.ResponseCode) !== '0' || !data.CheckoutRequestID) {
    throw refuse(`Safaricom did not accept the request${data && data.ResponseDescription ? ': ' + data.ResponseDescription : '.'}`, 502, data && data.ResponseCode ? String(data.ResponseCode) : null);
  }
  return { merchantRequestId: data.MerchantRequestID || null, checkoutRequestId: data.CheckoutRequestID, customerMessage: data.CustomerMessage || null };
}

/** The result code -> our word. 0 paid, 1032 cancelled by the parent, 1037 the parent did not answer, anything else failed. */
function stateFromCode(code) {
  const c = Number(code);
  if (c === 0) return 'paid';
  if (c === 1032) return 'cancelled';
  if (c === 1037) return 'timeout';
  return 'failed';
}

/**
 * Asks Safaricom what happened. state: paid | cancelled | timeout | failed | pending (Safaricom still working on it).
 * NOTE: the answer has NO M-Pesa receipt code. So "paid" here proves the money was taken, but the receipt code
 * must still come from the callback or the normal Paybill alert.
 */
async function queryPush({ consumerKey, consumerSecret, shortcode, passkey, checkoutRequestId }) {
  if (!consumerKey || !consumerSecret || !shortcode || !passkey) throw refuse('This school\'s M-Pesa keys, Paybill or passkey are not all set.', 409);
  if (!checkoutRequestId) throw refuse('The checkout request id is missing.');
  const ts = timestamp();
  const token = await tokenFor(consumerKey, consumerSecret);
  try {
    const { data } = await axios.post(`${BASE_URL}/mpesa/stkpushquery/v1/query`,
      { BusinessShortCode: String(shortcode), Password: makePassword(shortcode, passkey, ts), Timestamp: ts, CheckoutRequestID: checkoutRequestId },
      { headers: { Authorization: `Bearer ${token}` }, timeout: TIMEOUT });
    if (!data || data.ResultCode === undefined || data.ResultCode === null || data.ResultCode === '') return { state: 'pending', resultCode: null, resultDesc: null };
    return { state: stateFromCode(data.ResultCode), resultCode: Number(data.ResultCode), resultDesc: data.ResultDesc || null };
  } catch (err) {
    const d = err && err.response && err.response.data;
    if (d && String(d.errorCode) === '500.001.1001') return { state: 'pending', resultCode: null, resultDesc: null };   // "being processed"
    throw safaricomError(err, 'query');
  }
}

/** Reads what Safaricom posts to our callback address. Throws on anything that is not that shape. */
function parseCallback(body) {
  const cb = body && body.Body && body.Body.stkCallback;
  if (!cb || !cb.CheckoutRequestID || cb.ResultCode === undefined || cb.ResultCode === null) throw refuse('Not an STK callback.');
  const items = Array.isArray(cb.CallbackMetadata && cb.CallbackMetadata.Item) ? cb.CallbackMetadata.Item : [];
  const meta = {};
  for (const it of items) if (it && it.Name) meta[it.Name] = it.Value;
  const out = {
    merchantRequestId: cb.MerchantRequestID || null, checkoutRequestId: String(cb.CheckoutRequestID),
    resultCode: Number(cb.ResultCode), resultDesc: cb.ResultDesc || null, state: stateFromCode(cb.ResultCode),
    amount: meta.Amount !== undefined ? Number(meta.Amount) : null, receipt: meta.MpesaReceiptNumber ? String(meta.MpesaReceiptNumber) : null,
    phone: meta.PhoneNumber !== undefined ? String(meta.PhoneNumber) : null, transactionDate: meta.TransactionDate !== undefined ? String(meta.TransactionDate) : null,
  };
  if (out.state === 'paid' && (!out.receipt || !(out.amount > 0))) throw refuse('A paid callback without a receipt code or amount. Not trusted.');
  return out;
}

module.exports = { sendPush, queryPush, parseCallback, toMsisdn, timestamp, makePassword, stateFromCode };