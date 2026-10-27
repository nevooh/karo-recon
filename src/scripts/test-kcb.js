// Tests the KCB connector with the sample payloads from KCB's own documents.
// No database or server needed.  Run:  node src/scripts/test-kcb.js
const path = require('path');
const crypto = require('crypto');
const kcb = require('../connectors/kcb');

let failed = 0;
const check = (name, ok, extra) => { if (!ok) failed++; console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (!ok && extra ? '  -> ' + extra : '')); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --- sample payloads copied from KCB's PDFs ---
const accountSample = { transactionReference: 'FT00026252', requestId: 'c7d702cb', channelCode: '202', timestamp: '2021111103005',
  transactionAmount: '100.00', currency: 'KES', customerReference: 'INV-0001', customerName: 'John Doe', customerMobileNumber: '25471111111',
  balance: '', narration: 'Payment for goods', creditAccountIdentifier: 'JD001', organizationShortCode: '777777', tillNumber: '150150' };
const tillSample = { header: { messageID: 'uniqueMessageId', originatorConversationID: '', channelCode: '202', timeStamp: '20201117101010' },
  requestPayload: { primaryData: { businessKey: '000000', businessKeyType: 'queryBiller' },
    additionalData: { notificationData: { businessKey: 'P-INV-001', businessKeyType: 'BillReferenceNumber', debitMSISDN: '254722520441',
      transactionAmt: '100.00', transactionDate: '20201102', transactionID: 'FT235373', firstName: 'James', middleName: 'Jay', lastName: 'Armstrong',
      currency: 'KES', narration: 'ticket payment', transactionType: 'vooma', balance: '0.00' } } } };

// --- reading both shapes ---
let n = kcb.normalizeIPNPayload(accountSample);
check('account/OTC shape is read correctly', n.external_ref === 'FT00026252' && n.amount === 100 && n.narration === 'INV-0001' && n.payer_phone === '25471111111' && n.payer_name === 'John Doe', JSON.stringify(n));
n = kcb.normalizeIPNPayload(tillSample);
check('till (nested) shape is read correctly', n.external_ref === 'FT235373' && n.amount === 100 && n.narration === 'P-INV-001' && n.payer_phone === '254722520441' && n.payer_name === 'James Jay Armstrong', JSON.stringify(n));
check('amount with commas "1,500.00" becomes 1500', kcb.normalizeIPNPayload({ ...accountSample, transactionAmount: '1,500.00' }).amount === 1500);
check('reference falls back to narration when customerReference is empty', kcb.normalizeIPNPayload({ ...accountSample, customerReference: '' }).narration === 'Payment for goods');

// --- which school ---
check('account shape offers account id, till, shortcode in that order', same(kcb.extractOrgIdentifiers(accountSample), ['JD001', '150150', '777777']));

// --- is OUR side ready? (the screen shows this; only a word leaves the server, never the key) ---
{
  const saved = process.env.KCB_IPN_PUBLIC_KEY;
  delete process.env.KCB_IPN_PUBLIC_KEY;
  check('key status: no key set -> "missing"', kcb.keyStatus() === 'missing');
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.KCB_IPN_PUBLIC_KEY = pair.publicKey.export({ type: 'spki', format: 'pem' });
  check('key status: a real key (PEM) -> "ok"', kcb.keyStatus() === 'ok');
  process.env.KCB_IPN_PUBLIC_KEY = pair.publicKey.export({ type: 'spki', format: 'pem' }).replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  check('key status: bare base64 text (no PEM lines) -> "ok"', kcb.keyStatus() === 'ok');
  process.env.KCB_IPN_PUBLIC_KEY = 'this is not a key';
  check('key status: garbage -> "invalid"', kcb.keyStatus() === 'invalid');
  if (saved === undefined) delete process.env.KCB_IPN_PUBLIC_KEY; else process.env.KCB_IPN_PUBLIC_KEY = saved;
}
check('empty identifiers are dropped', same(kcb.extractOrgIdentifiers({ ...accountSample, tillNumber: '', organizationShortCode: null }), ['JD001']));
check('till shape offers the biller code', same(kcb.extractOrgIdentifiers(tillSample), ['000000']));

// --- replies ---
check('flat reply: our id, statusCode "0"', same(kcb.buildAckResponse(accountSample, 55), { transactionID: '55', statusCode: '0', statusMessage: 'Notification received' }));
const till = kcb.buildAckResponse(tillSample, 55);
check('till reply is nested and keeps messageID', till.header.messageID === 'uniqueMessageId' && till.header.statusCode === '0' && till.responsePayload.transactionInfo.transactionId === '55', JSON.stringify(till));

// --- signature check ---
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = publicKey.export({ type: 'spki', format: 'pem' });
const otherKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' });
const body = JSON.stringify(accountSample);
const sig = crypto.createSign('RSA-SHA256').update(body).sign(privateKey, 'base64');
const req = (raw, signature) => ({ rawBody: Buffer.from(raw), get: (h) => (h.toLowerCase() === 'signature' ? signature : undefined) });
const withEnv = (vars, fn) => { const old = {}; Object.keys(vars).forEach((k) => { old[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }); try { return fn(); } finally { Object.keys(old).forEach((k) => { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; }); } };

withEnv({ KCB_IPN_PUBLIC_KEY: pem }, () => {
  check('genuine signature accepted', kcb.checkSignature(req(body, sig)).ok === true);
  check('tampered body rejected', kcb.checkSignature(req(body.replace('100.00', '900.00'), sig)).ok === false);
  check('missing signature rejected', kcb.checkSignature(req(body, undefined)).ok === false);
  check('garbage signature rejected', kcb.checkSignature(req(body, 'not-a-signature')).ok === false);
});
withEnv({ KCB_IPN_PUBLIC_KEY: otherKey }, () => check("someone else's key rejected", kcb.checkSignature(req(body, sig)).ok === false));
withEnv({ KCB_IPN_PUBLIC_KEY: pem.replace(/\n/g, '\\n') }, () => check('key pasted with literal \\n works', kcb.checkSignature(req(body, sig)).ok === true));
withEnv({ KCB_IPN_PUBLIC_KEY: pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '') }, () => check('key pasted as bare base64 works', kcb.checkSignature(req(body, sig)).ok === true));
withEnv({ KCB_IPN_PUBLIC_KEY: undefined, NODE_ENV: undefined }, () => { const r = kcb.checkSignature(req(body, undefined)); check('no key, local testing: allowed but flagged', r.ok === true && r.skipped === true); });
withEnv({ KCB_IPN_PUBLIC_KEY: undefined, NODE_ENV: 'production' }, () => check('no key in PRODUCTION: refused', kcb.checkSignature(req(body, sig)).ok === false));

// --- through the real route, with the database and ingest stubbed ---
const root = path.join(__dirname, '..');
const stubModule = (rel, exports) => { require.cache[path.join(root, rel)] = { id: rel, filename: rel, loaded: true, exports }; };
let schoolRows = [{ id: 1, kcb_identifier: 'JD001' }];
const ingested = [];
stubModule('db/db.js', { pool: { query: async () => ({ rows: schoolRows }) }, initSchema: async () => {} });
stubModule('services/ingest.js', { ingestPayment: async (p) => { ingested.push(p); return { alreadyProcessed: false, transactionId: 77, match: { status: 'auto_matched', confidence: 1 } }; } });
process.env.KCB_IPN_PUBLIC_KEY = pem;
const app = require(path.join(root, 'app.js'));

const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}/webhooks/kcb/ipn`;
  const send = async (payload, signature) => {
    const raw = JSON.stringify(payload);
    const sg = signature === undefined ? crypto.createSign('RSA-SHA256').update(raw).sign(privateKey, 'base64') : signature;
    const headers = { 'Content-Type': 'application/json' }; if (sg) headers.signature = sg;
    const r = await fetch(base, { method: 'POST', headers, body: raw });
    return { status: r.status, body: await r.json() };
  };
  let r = await send(accountSample);
  check('route: signed account payment -> saved, replies with OUR id 77', r.status === 200 && r.body.transactionID === '77' && ingested.length === 1 && ingested[0].school_id === 1, JSON.stringify(r));
  r = await send(tillSample); schoolRows = [{ id: 1, kcb_identifier: '000000' }]; r = await send(tillSample);
  check('route: signed till payment -> nested reply with id 77', r.status === 200 && r.body.responsePayload && r.body.responsePayload.transactionInfo.transactionId === '77', JSON.stringify(r));
  r = await send(accountSample, 'bad-signature');
  check('route: forged payment -> 401 and NOT saved', r.status === 401 && ingested.length === 2, JSON.stringify(r));
  r = await send(accountSample, '');
  check('route: unsigned payment -> 401', r.status === 401);
  r = await send({ hello: 'world' });
  check('route: signed but not a KCB payment -> 400', r.status === 400, JSON.stringify(r));
  const before = ingested.length; schoolRows = [{ id: 1, kcb_identifier: 'JD001' }, { id: 2, kcb_identifier: 'JD001' }];
  r = await send(accountSample);
  check('route: identifier shared by two schools -> not saved to either, still acknowledged', r.status === 200 && ingested.length === before, JSON.stringify(r));
  console.log('\n' + (failed === 0 ? 'All KCB checks pass.' : failed + ' check(s) FAILED.'));
  server.close(); process.exit(failed ? 1 : 0);
});