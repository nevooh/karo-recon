// Tests for connectors/mpesaStk.js. Offline: Safaricom (axios) is faked, no database needed.
// Run: node src/scripts/test-mpesa-stk.js
const axios = require('axios');
const stk = require('../connectors/mpesaStk');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL: ' + m); } };
const rejects = async (fn, re, m) => { try { await fn(); ok(false, m + ' (was not refused)'); } catch (e) { ok(re.test(e.message), m + ' -> got: ' + e.message); return e; } };

const sent = [];
let pushReply, queryReply, tokenFails = false;
axios.get = async () => { if (tokenFails) { const e = new Error('401'); e.response = { status: 401, data: {} }; throw e; } return { data: { access_token: 'tok', expires_in: '3599' } }; };
axios.post = async (url, body, cfg) => {
  sent.push({ url, body, cfg });
  const r = url.includes('stkpushquery') ? queryReply : pushReply;
  if (r instanceof Error) throw r;
  return { data: r };
};
const httpErr = (status, data) => { const e = new Error('http ' + status); e.response = { status, data }; return e; };

const K = { consumerKey: 'ck1', consumerSecret: 'cs1', shortcode: '400200', passkey: 'PASSKEYPASSKEYPASSKEY1234' };
const GOOD = { ...K, phone: '0712 345 678', amount: 1500, accountRef: 'ADM343', callbackUrl: 'https://pay.example.com/webhooks/stk/abc123/result' };

(async () => {
  // --- phone numbers
  ok(stk.toMsisdn('0712 345 678') === '254712345678', '07 form');
  ok(stk.toMsisdn('+254712345678') === '254712345678', '+254 form');
  ok(stk.toMsisdn('254112345678') === '254112345678', '2541 form');
  ok(stk.toMsisdn('712345678') === '254712345678', 'no leading zero');
  ok(stk.toMsisdn('0112-345-678') === '254112345678', '01 with dashes');
  for (const bad of ['', '071234567', '0812345678', '25571234567', 'abc', '07123456789']) { try { stk.toMsisdn(bad); ok(false, 'bad phone accepted: ' + bad); } catch (e) { ok(true, 'bad phone refused'); } }

  // --- time and password
  ok(/^\d{14}$/.test(stk.timestamp()), 'timestamp is 14 digits');
  ok(stk.timestamp(new Date('2026-10-26T21:30:05Z')) === '20261027003005', 'timestamp is Kenya time (UTC+3)');
  ok(stk.makePassword('400200', 'PK', '20261027003005') === Buffer.from('400200PK20261027003005').toString('base64'), 'password = base64(shortcode+passkey+time)');

  // --- sending a push
  pushReply = { MerchantRequestID: 'm-1', CheckoutRequestID: 'ws_CO_1', ResponseCode: '0', ResponseDescription: 'Success', CustomerMessage: 'Success. Request accepted for processing' };
  const r = await stk.sendPush(GOOD);
  const call = sent.find((s) => s.url.endsWith('/stkpush/v1/processrequest'));
  ok(r.checkoutRequestId === 'ws_CO_1' && r.merchantRequestId === 'm-1', 'returns the checkout id');
  ok(call.body.TransactionType === 'CustomerPayBillOnline', 'paybill type');
  ok(call.body.Amount === 1500 && call.body.PartyA === '254712345678' && call.body.PhoneNumber === '254712345678', 'amount and phone');
  ok(call.body.PartyB === '400200' && call.body.BusinessShortCode === '400200', 'paybill number');
  ok(call.body.AccountReference === 'ADM343', 'admission number is the account reference');
  ok(call.body.TransactionDesc.length <= 13, 'description within 13 characters');
  ok(call.body.CallBackURL === GOOD.callbackUrl, 'callback address');
  ok(Buffer.from(call.body.Password, 'base64').toString() === '400200' + K.passkey + call.body.Timestamp, 'password matches the timestamp sent');
  ok(call.cfg.headers.Authorization === 'Bearer tok' && call.cfg.timeout > 0, 'token header and a timeout');

  // --- refusals before anything is sent
  const before = sent.length;
  await rejects(() => stk.sendPush({ ...GOOD, amount: 0 }), /whole number/, 'amount 0');
  await rejects(() => stk.sendPush({ ...GOOD, amount: 10.5 }), /whole number/, 'amount with cents');
  await rejects(() => stk.sendPush({ ...GOOD, amount: 'abc' }), /whole number/, 'amount text');
  await rejects(() => stk.sendPush({ ...GOOD, accountRef: 'ADM/2026/000343' }), /12 characters/, 'reference over 12');
  await rejects(() => stk.sendPush({ ...GOOD, accountRef: '' }), /reference is missing/, 'reference empty');
  await rejects(() => stk.sendPush({ ...GOOD, phone: '0812345678' }), /Safaricom number/, 'phone not Safaricom');
  await rejects(() => stk.sendPush({ ...GOOD, passkey: null }), /not all set/, 'no passkey');
  await rejects(() => stk.sendPush({ ...GOOD, callbackUrl: 'http://pay.example.com/x' }), /https/, 'callback not https');
  await rejects(() => stk.sendPush({ ...GOOD, callbackUrl: 'https://pay.example.com/mpesa/result' }), /must not contain/, 'callback with blocked word');
  await rejects(() => stk.sendPush({ ...GOOD, callbackUrl: 'https://localhost/x' }), /localhost/, 'callback on localhost');
  ok(sent.length === before, 'nothing was sent to Safaricom for refused requests');

  // --- Safaricom says no
  pushReply = { ResponseCode: '1', ResponseDescription: 'Rejected' };
  await rejects(() => stk.sendPush(GOOD), /did not accept/, 'ResponseCode not 0');
  pushReply = httpErr(500, { errorCode: '500.001.1001', errorMessage: 'Unable to lock subscriber' });
  const busy = await rejects(() => stk.sendPush(GOOD), /already has an M-Pesa request open/, 'phone busy');
  ok(busy && busy.status === 409 && busy.code === '500.001.1001', 'busy is a 409 with the Safaricom code');
  pushReply = httpErr(500, { errorCode: '500.001.1100', errorMessage: 'Merchant does not exist' });
  const other = await rejects(() => stk.sendPush(GOOD), /Merchant does not exist/, 'other Safaricom error is passed on');
  ok(other && other.status === 502, 'other error is 502');
  pushReply = new Error('socket hang up');
  await rejects(() => stk.sendPush(GOOD), /Could not reach Safaricom/, 'network failure');
  tokenFails = true;
  await rejects(() => stk.sendPush({ ...GOOD, consumerKey: 'ck-bad' }), /did not accept this school's M-Pesa keys/, 'wrong keys');
  tokenFails = false;

  // --- no secrets in any error message
  for (const reply of [httpErr(500, { errorMessage: 'x' }), new Error('boom')]) {
    pushReply = reply;
    try { await stk.sendPush(GOOD); } catch (e) { ok(!e.message.includes(K.passkey) && !e.message.includes(K.consumerSecret), 'no secret in error'); }
  }

  // --- asking about a push
  const Q = { ...K, checkoutRequestId: 'ws_CO_1' };
  queryReply = { ResponseCode: '0', ResultCode: '0', ResultDesc: 'The service request is processed successfully.' };
  ok((await stk.queryPush(Q)).state === 'paid', 'query: paid');
  queryReply = { ResultCode: '1032', ResultDesc: 'Request cancelled by user' };
  ok((await stk.queryPush(Q)).state === 'cancelled', 'query: cancelled');
  queryReply = { ResultCode: '1037', ResultDesc: 'DS timeout user cannot be reached' };
  ok((await stk.queryPush(Q)).state === 'timeout', 'query: timeout');
  queryReply = { ResultCode: '1', ResultDesc: 'The balance is insufficient for the transaction' };
  const lowBal = await stk.queryPush(Q);
  ok(lowBal.state === 'failed' && /insufficient/.test(lowBal.resultDesc), 'query: failed keeps the reason');
  queryReply = httpErr(500, { errorCode: '500.001.1001', errorMessage: 'The transaction is being processed' });
  ok((await stk.queryPush(Q)).state === 'pending', 'query: still being processed is pending, not an error');
  queryReply = httpErr(500, { errorCode: '500.001.1100', errorMessage: 'Something else' });
  await rejects(() => stk.queryPush(Q), /Something else/, 'query: other error is thrown');
  await rejects(() => stk.queryPush({ ...Q, checkoutRequestId: '' }), /checkout request id/, 'query: no id');

  // --- reading the callback
  const paidBody = { Body: { stkCallback: { MerchantRequestID: 'm-1', CheckoutRequestID: 'ws_CO_1', ResultCode: 0, ResultDesc: 'The service request is processed successfully.',
    CallbackMetadata: { Item: [{ Name: 'Amount', Value: 1500 }, { Name: 'MpesaReceiptNumber', Value: 'SKR4T8W2QA' }, { Name: 'TransactionDate', Value: 20261026213005 }, { Name: 'PhoneNumber', Value: 254712345678 }] } } } };
  const p = stk.parseCallback(paidBody);
  ok(p.state === 'paid' && p.amount === 1500 && p.receipt === 'SKR4T8W2QA' && p.phone === '254712345678' && p.checkoutRequestId === 'ws_CO_1', 'callback: paid');
  const c = stk.parseCallback({ Body: { stkCallback: { MerchantRequestID: 'm-1', CheckoutRequestID: 'ws_CO_2', ResultCode: 1032, ResultDesc: 'Request cancelled by user' } } });
  ok(c.state === 'cancelled' && c.receipt === null && c.amount === null, 'callback: cancelled has no metadata');
  ok(stk.parseCallback({ Body: { stkCallback: { CheckoutRequestID: 'x', ResultCode: 1037, ResultDesc: 't' } } }).state === 'timeout', 'callback: timeout');
  ok(stk.parseCallback({ Body: { stkCallback: { CheckoutRequestID: 'x', ResultCode: 2001, ResultDesc: 'wrong pin' } } }).state === 'failed', 'callback: wrong pin is failed');
  for (const [bad, m] of [[null, 'null'], [{}, 'empty'], [{ Body: {} }, 'no callback'], [{ Body: { stkCallback: { ResultCode: 0 } } }, 'no checkout id'], [{ Body: { stkCallback: { CheckoutRequestID: 'x' } } }, 'no result code']]) {
    try { stk.parseCallback(bad); ok(false, 'bad callback accepted: ' + m); } catch (e) { ok(/Not an STK callback/.test(e.message), 'bad callback refused: ' + m); }
  }
  try { stk.parseCallback({ Body: { stkCallback: { CheckoutRequestID: 'x', ResultCode: 0, ResultDesc: 'ok' } } }); ok(false, 'paid without receipt accepted'); } catch (e) { ok(/not trusted/i.test(e.message), 'paid callback without receipt is not trusted'); }
  try { stk.parseCallback({ Body: { stkCallback: { CheckoutRequestID: 'x', ResultCode: 0, CallbackMetadata: { Item: [{ Name: 'MpesaReceiptNumber', Value: 'AB1' }] } } } }); ok(false, 'paid without amount accepted'); } catch (e) { ok(/not trusted/i.test(e.message), 'paid callback without amount is not trusted'); }

  console.log(`${pass} pass, ${fail} fail`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('ERROR', e); process.exitCode = 1; });