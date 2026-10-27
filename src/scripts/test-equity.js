// Tests the Equity connector with the sample messages from Equity's own docs.
// No database or server needed.  Run:  node src/scripts/test-equity.js
const path = require('path');
const crypto = require('crypto');
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test';
const eq = require('../connectors/equityJenga');
const { encrypt } = require('../security/crypto');

let failed = 0;
const check = (name, ok, extra) => { if (!ok) failed++; console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (!ok && extra ? '  -> ' + extra : '')); };

// --- samples copied from Equity's docs ---
const ipnSample = { callbackType: 'IPN', customer: { name: 'John Doe', mobileNumber: '254712345678', reference: '071648816466242' },
  transaction: { date: '2023-10-11 14:15:20', reference: '328411183176', paymentMode: 'MPESA', amount: 150, currency: 'KES', billNumber: 'INVZCF',
    servedBy: 'EQ', additionalInfo: 'CARD', orderAmount: 150, serviceCharge: 5.25, orderCurrency: 'KES', status: 'SUCCESS', remarks: '00:Approved' },
  bank: { reference: '328411183176', transactionType: 'C', account: null } };
const alertSample = { callbackType: 'ALT', customer: { name: 'Customer Name', mobileNumber: null, reference: '2547xxxxx QJ50A5ZZMI 076332' },
  transaction: { date: '2022-10-05 14:22:48', reference: ' S8550312', paymentMode: 'MISYS', amount: 5, billNumber: ' S8550312', servedBy: 'EQ',
    additionalInfo: '254711xxxxxx QJ50A5ZZMI 076332', orderAmount: 5, serviceCharge: 0, status: 'SUCCESS', remarks: 'MPS 25471xxxxx4 QJ50A5ZZMI xxxxxx DONK/974361' },
  bank: { reference: ' S8550312', transactionType: 'Credit', account: '01xxxxxxxxxxx' } };
const clone = (o) => JSON.parse(JSON.stringify(o));

// --- reading both kinds of message ---
let n = eq.normalizeIPNPayload(ipnSample);
check('IPN sample read correctly', n.external_ref === '328411183176' && n.amount === 150 && n.payer_phone === '254712345678' && n.payer_name === 'John Doe', JSON.stringify(n));
check('IPN: bill number (the account number) is part of the reference', n.narration.split(' | ')[0] === 'INVZCF', n.narration);
n = eq.normalizeIPNPayload(alertSample);
check('Alert sample read correctly (leading space trimmed)', n.external_ref === 'S8550312' && n.amount === 5 && n.payer_phone === null, JSON.stringify(n));
check("Alert: bank's own reference is NOT used as the parent's reference", !n.narration.includes('S8550312'), n.narration);
check('Alert: customer reference, extra info and remarks all offered to the matcher',
  n.narration.includes('2547xxxxx QJ50A5ZZMI 076332') && n.narration.includes('254711xxxxxx QJ50A5ZZMI 076332') && n.narration.includes('DONK/974361'), n.narration);
check('same text in two fields is only offered once', (eq.buildReference({ customer: { reference: 'ADM101' }, transaction: { billNumber: 'ADM101', reference: 'X1' }, bank: {} }).match(/ADM101/g) || []).length === 1);
check('amount with commas read as a number', eq.normalizeIPNPayload({ ...ipnSample, transaction: { ...ipnSample.transaction, amount: '1,500.00' } }).amount === 1500);

// --- success and credits only ---
check('SUCCESS accepted', eq.isSuccessfulPayment(ipnSample) === true);
check('FAILED ignored', eq.isSuccessfulPayment({ ...ipnSample, transaction: { ...ipnSample.transaction, status: 'FAILED' } }) === false);
check('"C" counts as money in', eq.isCreditPayment(ipnSample) === true);
check('"Credit" counts as money in', eq.isCreditPayment(alertSample) === true);
check('"Debit" is NOT a payment', eq.isCreditPayment({ ...alertSample, bank: { ...alertSample.bank, transactionType: 'Debit' } }) === false);
check('"D" is NOT a payment', eq.isCreditPayment({ ...alertSample, bank: { ...alertSample.bank, transactionType: 'D' } }) === false);
check('missing type counts as a gateway payment', eq.isCreditPayment({ transaction: {} }) === true);
check('an unknown type is NOT treated as money in', eq.isCreditPayment({ bank: { transactionType: 'REVERSAL' } }) === false);

// --- through the real route, database and ingest stubbed ---
const root = path.join(__dirname, '..');
const stub = (rel, exports) => { require.cache[path.join(root, rel)] = { id: rel, filename: rel, loaded: true, exports }; };
const PASSWORD = 'S3cret:with:colons';
const schoolRow = { id: 1, credentials_enc: encrypt(JSON.stringify({ ipn_password: PASSWORD })) };
const ingested = [];
stub('db/db.js', { pool: { query: async (sql, params) => ({ rows: params[0] === 'school-one' ? [schoolRow] : [] }) }, initSchema: async () => {} });
stub('services/ingest.js', { ingestPayment: async (p) => { ingested.push(p); return { alreadyProcessed: false, transactionId: 9, match: { status: 'needs_review', confidence: 0.5 } }; } });
const app = require(path.join(root, 'app.js'));
const basic = (user, pass) => 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');

const server = app.listen(0, async () => {
  const url = `http://127.0.0.1:${server.address().port}/webhooks/equity/ipn`;
  const send = async (payload, auth) => {
    const headers = { 'Content-Type': 'application/json' }; if (auth) headers.Authorization = auth;
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
    return { status: r.status, body: await r.json() };
  };
  const good = basic('school-one', PASSWORD);
  let r = await send(ipnSample, good);
  check('route: IPN with right login -> saved for the right school', r.status === 200 && ingested.length === 1 && ingested[0].school_id === 1 && ingested[0].external_ref === '328411183176', JSON.stringify(r));
  r = await send(alertSample, good);
  check('route: credit alert -> saved', r.status === 200 && ingested.length === 2 && ingested[1].external_ref === 'S8550312', JSON.stringify(r));
  r = await send({ ...alertSample, bank: { ...alertSample.bank, transactionType: 'Debit' } }, good);
  check('route: DEBIT alert -> acknowledged but NOT saved', r.status === 200 && ingested.length === 2, JSON.stringify(r));
  r = await send({ ...ipnSample, transaction: { ...ipnSample.transaction, status: 'FAILED' } }, good);
  check('route: FAILED payment -> acknowledged but NOT saved', r.status === 200 && ingested.length === 2);
  r = await send(ipnSample, basic('school-one', 'wrong'));
  check('route: wrong password -> 401, not saved', r.status === 401 && ingested.length === 2);
  r = await send(ipnSample, basic('school-one', ''));
  check('route: empty password -> 401', r.status === 401);
  r = await send(ipnSample, basic('nobody', PASSWORD));
  check('route: unknown username -> 401', r.status === 401);
  r = await send(ipnSample, undefined);
  check('route: no login at all -> 401', r.status === 401);
  r = await send({ callbackType: 'ALT', transaction: { status: 'SUCCESS' }, bank: { transactionType: 'Credit' } }, good);
  check('route: signed-in but not a real payment -> 400', r.status === 400, JSON.stringify(r));
  console.log('\n' + (failed === 0 ? 'All Equity checks pass.' : failed + ' check(s) FAILED.'));
  server.close(); process.exit(failed ? 1 : 0);
});