// Tests the M-Pesa (Safaricom C2B) fixes. No database, server or internet needed.
// Run:  node src/scripts/test-mpesa.js
const path = require('path');
const crypto = require('crypto');
process.env.JWT_SECRET = 'test-secret';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || require('crypto').randomBytes(32).toString('hex');
delete process.env.C2B_URL_SECRET;
delete process.env.MPESA_C2B_VERSION;
process.env.NODE_ENV = 'test';
const mpesa = require('../connectors/mpesa');
const axios = require('axios');

let failed = 0;
const check = (name, ok, extra) => { if (!ok) failed++; console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (!ok && extra ? '  -> ' + extra : '')); };
const throws = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

// --- reading a confirmation message ---
const msg = { TransactionType: 'Pay Bill', TransID: 'RKTQDM7W6S ', TransTime: '20191122063845', TransAmount: '1,500.00', BusinessShortCode: '600000',
  BillRefNumber: 'ADM101', InvoiceNumber: '', OrgAccountBalance: '49197.00', ThirdPartyTransID: '', MSISDN: '254708374149', FirstName: 'John', MiddleName: 'J.', LastName: 'Doe' };
let n = mpesa.normalizeC2BPayload(msg);
check('message read correctly (id trimmed, commas removed, name joined)', n.external_ref === 'RKTQDM7W6S' && n.amount === 1500 && n.narration === 'ADM101' && n.payer_name === 'John J. Doe' && n.payer_phone === '254708374149', JSON.stringify(n));
check('a hashed phone number is dropped, not stored as a phone', mpesa.normalizeC2BPayload({ ...msg, MSISDN: 'bbff37b6b6a9d1c1c2cf5b4e6a1f0e5d8c3b2a190f7e6d5c4b3a2918070605ff' }).payer_phone === null);
check('a masked phone number is dropped too', mpesa.normalizeC2BPayload({ ...msg, MSISDN: '2547 ***** 126' }).payer_phone === null);
check('missing names/phone do not crash', mpesa.normalizeC2BPayload({ TransID: 'X', TransAmount: '5' }).payer_phone === null);

// --- the secret in the registered URLs ---
const t1 = mpesa.c2bUrlToken('600000');
check('token is 40 hex characters and the same every time', /^[0-9a-f]{40}$/.test(t1) && t1 === mpesa.c2bUrlToken('600000'), t1);
check('a different paybill gets a different token', t1 !== mpesa.c2bUrlToken('600001'));
process.env.C2B_URL_SECRET = 'another-secret';
check('a different server secret gives a different token', mpesa.c2bUrlToken('600000') !== t1);
delete process.env.C2B_URL_SECRET;
const urls = mpesa.buildCallbackUrls('https://fees.example.com/', '600000');
check('built URLs carry the token, drop the trailing slash, and contain no blocked word',
  urls.confirmationUrl === `https://fees.example.com/webhooks/c2b/${t1}/confirmation` && urls.validationUrl.endsWith(`/${t1}/validation`) && !/mpesa|safaricom/i.test(urls.confirmationUrl + urls.validationUrl), JSON.stringify(urls));
check('the built URLs are accepted by the safety check', throws(() => { mpesa.assertCallbackUrlAllowed(urls.confirmationUrl); mpesa.assertCallbackUrlAllowed(urls.validationUrl); }) === null);

// --- refusing URLs Safaricom would block ---
check('a URL containing "mpesa" is refused with a clear reason', /mpesa/.test(throws(() => mpesa.assertCallbackUrlAllowed('https://x.example.com/webhooks/mpesa/confirmation')) || ''));
check('a URL containing "safaricom" is refused', throws(() => mpesa.assertCallbackUrlAllowed('https://safaricom-fees.example.com/c2b')) !== null);
check('plain http is refused', throws(() => mpesa.assertCallbackUrlAllowed('http://fees.example.com/c2b')) !== null);
check('localhost is refused', throws(() => mpesa.assertCallbackUrlAllowed('https://localhost:3000/c2b')) !== null);
check('a URL with a word like "query" only warns, it is not refused', throws(() => mpesa.assertCallbackUrlAllowed('https://fees.example.com/query')) === null);

// --- what is actually sent to Safaricom (axios stubbed) ---
const sent = [];
axios.get = async () => ({ data: { access_token: 'tok', expires_in: '3599' } });
axios.post = async (url, body) => { sent.push({ url, body }); return { data: { ResponseDescription: 'Success' } }; };
const creds = { consumerKey: 'k-' + crypto.randomBytes(4).toString('hex'), consumerSecret: 's', shortcode: '600000' };
(async () => {
  await mpesa.registerC2BUrls({ ...creds, ...urls });
  check('registration uses the v2 endpoint by default', /\/mpesa\/c2b\/v2\/registerurl$/.test(sent[0].url), sent[0].url);
  check('registration sends the shortcode, "Completed" and both URLs', sent[0].body.ShortCode === '600000' && sent[0].body.ResponseType === 'Completed' && sent[0].body.ConfirmationURL === urls.confirmationUrl && sent[0].body.ValidationURL === urls.validationUrl);
  process.env.MPESA_C2B_VERSION = 'v1';
  await mpesa.registerC2BUrls({ ...creds, ...urls });
  check('MPESA_C2B_VERSION=v1 switches back to the v1 endpoint', /\/c2b\/v1\/registerurl$/.test(sent[1].url));
  delete process.env.MPESA_C2B_VERSION;
  let blocked = null;
  try { await mpesa.registerC2BUrls({ ...creds, confirmationUrl: 'https://x.example.com/webhooks/mpesa/confirmation', validationUrl: urls.validationUrl }); } catch (e) { blocked = e.message; }
  check('registration refuses a bad URL BEFORE calling Safaricom', blocked && sent.length === 2, String(blocked));

  // --- through the real routes (database and ingest stubbed) ---
  const root = path.join(__dirname, '..');
  const stub = (rel, exports) => { require.cache[path.join(root, rel)] = { id: rel, filename: rel, loaded: true, exports }; };
  const ingested = [];
  // School 2 (paybill 600600) has its OWN stored secret code (the newer way); school 1 (600000) has none (the older way).
  const STORED = 'ab12cd34'.padEnd(40, '9');
  const storedEnc = require('../services/mpesaUrlToken').protect(STORED);
  stub('db/db.js', { pool: { query: async (sql, params) => ({ rows: params[0] === '600000' ? [{ id: 1, name: 'Test Academy' }] : params[0] === '600600' ? [{ id: 2, name: 'Stored School', mpesa_url_token_enc: storedEnc }] : [] }) }, initSchema: async () => {} });
  stub('services/ingest.js', { ingestPayment: async (p) => { ingested.push(p); return { alreadyProcessed: false, transactionId: ingested.length, match: { status: 'auto_matched', confidence: 1 } }; } });
  const app = require(path.join(root, 'app.js'));
  const server = app.listen(0, async () => {
    const base = `http://127.0.0.1:${server.address().port}/webhooks`;
    const post = async (p, payload) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); return { status: r.status, body: await r.json() }; };
    const good = `/c2b/${t1}`;

    let r = await post(good + '/confirmation', msg);
    check('secret URL: confirmation accepted and saved for the right school', r.status === 200 && r.body.ResultCode === 0 && ingested.length === 1 && ingested[0].school_id === 1 && ingested[0].external_ref === 'RKTQDM7W6S', JSON.stringify(r));
    check('secret URL: a real phone number is kept as a phone', ingested.length === 1 && ingested[0].payer_phone === '254708374149');
    r = await post(good + '/confirmation', { ...msg, TransID: 'H1', MSISDN: 'a'.repeat(64) });
    check('secret URL: a hashed phone is saved as null', r.status === 200 && ingested[ingested.length - 1].payer_phone === null);
    const count = ingested.length;
    r = await post('/c2b/' + 'f'.repeat(40) + '/confirmation', { ...msg, TransID: 'F1' });
    check('WRONG token -> 404 and nothing saved (a forged payment)', r.status === 404 && ingested.length === count);
    r = await post(`/c2b/${mpesa.c2bUrlToken('999999')}/confirmation`, { ...msg, TransID: 'F2' });
    check("another paybill's token cannot be used for this paybill -> 404", r.status === 404 && ingested.length === count);

    r = await post(good + '/validation', msg);
    check('validation: known paybill -> accepted (code 0)', r.status === 200 && r.body.ResultCode === 0);
    r = await post(`/c2b/${mpesa.c2bUrlToken('777777')}/validation`, { ...msg, BusinessShortCode: '777777' });
    check('validation: unknown paybill -> rejected with C2B00015 (invalid shortcode)', r.body.ResultCode === 'C2B00015', JSON.stringify(r.body));
    r = await post(good + '/confirmation', { BusinessShortCode: '600000', BillRefNumber: 'ADM1' });
    check('confirmation with no TransID or amount -> 400', r.status === 400);
    r = await post(`/c2b/${mpesa.c2bUrlToken('777777')}/confirmation`, { ...msg, BusinessShortCode: '777777', TransID: 'U1' });
    check('confirmation for an unknown paybill -> accepted but not saved', r.status === 200 && ingested.length === count);

    r = await post('/mpesa/confirmation', { ...msg, TransID: 'L1' });
    check('plain old path still works while testing locally', r.status === 200 && ingested.length === count + 1);
    process.env.NODE_ENV = 'production';
    r = await post('/mpesa/confirmation', { ...msg, TransID: 'L2' });
    check('IN PRODUCTION the plain old path is closed (404)', r.status === 404 && ingested.length === count + 1);
    r = await post('/c2b/confirmation', { ...msg, TransID: 'L3' });
    check('IN PRODUCTION the plain /c2b path is closed too', r.status === 404);
    r = await post(good + '/confirmation', { ...msg, TransID: 'P1' });
    check('IN PRODUCTION the secret URL still works', r.status === 200 && ingested.length === count + 2);

    // --- a school with its OWN stored secret code ---
    const n2 = ingested.length;
    r = await post(`/c2b/${STORED}/confirmation`, { ...msg, BusinessShortCode: '600600', TransID: 'S1' });
    check('OWN CODE: the school\'s stored code is accepted and the payment saved for THAT school', r.status === 200 && ingested.length === n2 + 1 && ingested[n2].school_id === 2);
    r = await post(`/c2b/${STORED}/validation`, { ...msg, BusinessShortCode: '600600' });
    check('OWN CODE: the validation address (same code) is accepted too', r.status === 200 && r.body.ResultCode === 0);
    r = await post(`/c2b/${mpesa.c2bUrlToken('600600')}/confirmation`, { ...msg, BusinessShortCode: '600600', TransID: 'S2' });
    check('OWN CODE: the OLDER shared-secret code is now REFUSED for that school (404, nothing saved)', r.status === 404 && ingested.length === n2 + 1);
    r = await post(`/c2b/${STORED}/confirmation`, { ...msg, BusinessShortCode: '600000', TransID: 'S3' });
    check('one school\'s stored code cannot be used for another school\'s Paybill (404)', r.status === 404 && ingested.length === n2 + 1);
    r = await post(`/c2b/${'f'.repeat(40)}/confirmation`, { ...msg, BusinessShortCode: '600600', TransID: 'S4' });
    check('OWN CODE: a wrong code is refused (404)', r.status === 404 && ingested.length === n2 + 1);
    r = await post(good + '/confirmation', { ...msg, TransID: 'S5' });
    check('OLDER school (no stored code) is unaffected: its original code still works', r.status === 200 && ingested.length === n2 + 2 && ingested[n2 + 1].school_id === 1);

    console.log('\n' + (failed === 0 ? 'All M-Pesa checks pass.' : failed + ' check(s) FAILED.'));
    server.close(); process.exit(failed ? 1 : 0);
  });
})();