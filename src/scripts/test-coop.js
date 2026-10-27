// Tests the Co-op notification receiver with the sample message from Co-op's own
// developer portal (SendTransactionINS). No database or server needed.
// Run:  node src/scripts/test-coop.js
const path = require('path');
const crypto = require('crypto');
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.JWT_SECRET = 'test-secret';
delete process.env.PUBLIC_BASE_URL;
const coop = require('../connectors/coop');
const { decrypt } = require('../security/crypto');

let failed = 0;
const check = (name, ok, extra) => { if (!ok) failed++; console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (!ok && extra ? '  -> ' + extra : '')); };
const clone = (o) => JSON.parse(JSON.stringify(o));

// Sample copied from Co-op's portal (its own example is a DEBIT event)
const portalSample = { MessageReference: '40ca18c6765086089a1', MessageDateTime: '2019-08-24T14:15:22Z', ServiceName: 'string', NotificationCode: 'string',
  CallBackUrl: 'https://yourdomain.com/ftresponse', Basic: 'BasicAuthCredential', PaymentRef: 'SFI427E9136D7D3F21C2C89', AccountNumber: '36001873000',
  Amount: '777', TransactionDate: '20190301165420', EventType: 'DEBIT', BookedBalance: 1242, ClearedBalance: 3442, Currency: 'KES', ExchangeRate: 1,
  Narration: 'Supplier Payment', CustMemo: { CustMemoLine1: '728210595 ABD01', CustMemoLine2: 'string', CustMemoLine3: 'string' },
  ValueDate: '20190301', EntryDate: '20190301', TransactionId: '1169716b658911I6' };
const credit = { ...clone(portalSample), EventType: 'CREDIT' };

// --- reading a message ---
let n = coop.normalizeINSPayload(credit);
check('message read correctly', n.external_ref === '1169716b658911I6' && n.amount === 777 && n.source === 'coop' && n.payer_phone === null, JSON.stringify(n));
check("reference text offers narration, all 3 memo lines and Co-op's payment ref",
  ['Supplier Payment', '728210595 ABD01', 'SFI427E9136D7D3F21C2C89'].every((p) => n.narration.includes(p)), n.narration);
check("Co-op's own transaction number is not mixed into the reference", !n.narration.includes('1169716b658911I6'));
check('falls back to MessageReference when TransactionId is missing', coop.normalizeINSPayload({ ...credit, TransactionId: undefined }).external_ref === '40ca18c6765086089a1');
check('amount with commas read as a number', coop.normalizeINSPayload({ ...credit, Amount: '1,500.00' }).amount === 1500);
check('missing memo block does not crash', coop.normalizeINSPayload({ ...credit, CustMemo: undefined }).narration.includes('Supplier Payment'));
check('account number read from the message', coop.extractAccountNumber(credit) === '36001873000');

// --- credits only ---
check('CREDIT is money in', coop.isCreditEvent(credit) === true);
check('lower-case "credit" is money in', coop.isCreditEvent({ EventType: 'credit' }) === true);
check("Co-op's own DEBIT sample is NOT a payment", coop.isCreditEvent(portalSample) === false);
check('an unknown event type is NOT treated as money in', coop.isCreditEvent({ EventType: 'REVERSAL' }) === false);
check('missing event type is NOT treated as money in', coop.isCreditEvent({}) === false);
check('event kinds: credit / debit / unknown are told apart', coop.eventKind(credit) === 'credit' && coop.eventKind(portalSample) === 'debit' && coop.eventKind({ EventType: 'DEPOSIT' }) === 'unknown');

// --- the reply ---
const ack = coop.buildAckResponse(credit);
check('reply: code 0, echoes the message reference', ack.MessageCode === '0' && ack.MessageReference === '40ca18c6765086089a1' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(ack.MessageDateTime), JSON.stringify(ack));

// --- through the real routes, database and ingest stubbed ---
const bcrypt = require('bcryptjs');
const PW_HASH = bcrypt.hashSync('pw12345678', 4);
const RESET = { confirm_text: 'RESET', password: 'pw12345678' };
const conns = [];
const handler = (sql, params) => {
  const q = sql.replace(/\s+/g, ' ').trim();
  if (/SELECT id FROM bank_providers WHERE code = \$1/.test(q)) return { rows: [{ id: params[0] === 'coop' ? 2 : 1 }] };
  if (/SELECT sbc.account_number, sbc.credentials_enc, bp.code, bp.name FROM school_bank_connections/.test(q)) {
    const c = conns.find((x) => x.school_id === params[0] && x.provider_id === (params[1] === 'coop' ? 2 : 1));
    return { rows: c ? [{ account_number: c.account_number, credentials_enc: c.credentials_enc, code: params[1], name: 'Co-op' }] : [] };
  }
  if (/INSERT INTO school_bank_connections/.test(q)) {
    const [school_id, provider_id, account_number, credentials_enc] = params;
    const existing = conns.find((c) => c.school_id === school_id && c.provider_id === provider_id);
    if (existing) Object.assign(existing, { account_number, credentials_enc }); else conns.push({ school_id, provider_id, account_number, credentials_enc });
    return { rows: [{ id: 1 }] };
  }
  if (/SELECT s\.\*, sbc\.credentials_enc FROM schools s/.test(q)) {
    return { rows: conns.filter((c) => c.provider_id === 2 && c.account_number === params[0]).map((c) => ({ id: c.school_id, credentials_enc: c.credentials_enc })) };
  }
  // --- answers for the Admin + reset rules (the logged-in test person is an Admin) ---
  if (/SELECT role FROM staff WHERE id/.test(q)) return { rows: [{ role: 'admin' }] };
  if (/SELECT status, token_version FROM staff WHERE id/.test(q)) return { rows: [{ status: 'active', token_version: 0 }] };
  if (/SELECT name FROM schools WHERE id/.test(q)) return { rows: [{ name: 'Test School' }] };
  if (/SELECT password_hash FROM staff WHERE id/.test(q)) return { rows: [{ password_hash: PW_HASH }] };
  if (/SELECT sbc.id, sbc.last_rotated_at FROM school_bank_connections sbc JOIN bank_providers/.test(q)) return { rows: conns.some((c) => c.school_id === params[0] && c.provider_id === (params[1] === 'coop' ? 2 : 1)) ? [{ id: 1, last_rotated_at: null }] : [] };
  if (/UPDATE school_bank_connections SET last_rotated_at = NOW\(\)/.test(q)) return { rows: [{ id: 1 }] };
  return { rows: [] };
};
const root = path.join(__dirname, '..');
const stub = (rel, exports) => { require.cache[path.join(root, rel)] = { id: rel, filename: rel, loaded: true, exports }; };
const ingested = [];
stub('db/db.js', { pool: { query: async (s, p) => handler(s, p) }, initSchema: async () => {} });
stub('services/ingest.js', { ingestPayment: async (p) => { ingested.push(p); return { alreadyProcessed: false, transactionId: ingested.length, match: { status: 'needs_review', confidence: 0.5 } }; } });
const app = require(path.join(root, 'app.js'));
const { generateToken, generatePinToken } = require(path.join(root, 'security/auth.js'));

const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const tok = (schoolId) => ({ Authorization: 'Bearer ' + generateToken({ staffId: 5, schoolId }), 'X-Pin-Token': generatePinToken({ staffId: 5, schoolId }), 'Content-Type': 'application/json' });
  const generate = async (schoolId, headers, body) => { const r = await fetch(`${base}/api/schools/${schoolId}/bank-connections/coop/credentials`, { method: 'POST', headers, body: JSON.stringify(body || {}) }); return { status: r.status, headers: r.headers, body: await r.json() }; };
  const push = async (payload, user, pass) => {
    const headers = { 'Content-Type': 'application/json' }; if (user !== undefined) headers.Authorization = 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
    const r = await fetch(`${base}/webhooks/coop/ins`, { method: 'POST', headers, body: JSON.stringify(payload) });
    return { status: r.status, body: await r.json() };
  };

  let r = await generate(1, { 'Content-Type': 'application/json' }, { account_number: '36001873000' });
  check('set-up: no login -> 401', r.status === 401);
  r = await generate(1, tok(2), { account_number: '36001873000' });
  check("set-up: another school's staff -> 403", r.status === 403);
  r = await generate(1, tok(1), {});
  check('set-up: first time without an account number -> 400 with a clear message', r.status === 400 && /account_number/.test(r.body.error), JSON.stringify(r.body));
  r = await generate(1, tok(1), { account_number: '12' });
  check('set-up: nonsense account number -> 400', r.status === 400);

  r = await generate(1, tok(1), { account_number: '36001873000' });
  const first = r.body;
  check('set-up: school 1 gets a username and a 32-character password', r.status === 200 && /^karo_[a-z0-9]{10}$/.test(first.username) && /^[A-Za-z0-9]{32}$/.test(first.password), JSON.stringify(first));
  check('set-up: shown once, not cached, address ends /webhooks/coop/ins (placeholder flagged)', first.show_once === true && /no-store/.test(r.headers.get('cache-control') || '') && first.callback_url === 'https://YOUR-DOMAIN/webhooks/coop/ins' && first.callback_url_is_placeholder === true);
  const stored = conns.find((c) => c.school_id === 1);
  const blob = decrypt(stored.credentials_enc);
  check('set-up: account number stored; password NOT stored anywhere (fingerprint only)', stored.account_number === '36001873000' && !blob.includes(first.password) && JSON.parse(blob).ins_password_hash.length === 64);

  r = await push(credit, first.username, first.password);
  check('push: credit with the right login -> acknowledged and saved for school 1', r.status === 200 && r.body.MessageCode === '0' && ingested.length === 1 && ingested[0].school_id === 1 && ingested[0].external_ref === '1169716b658911I6', JSON.stringify(r));
  r = await push(portalSample, first.username, first.password);
  check("push: Co-op's own DEBIT sample -> acknowledged but NOT saved", r.status === 200 && ingested.length === 1);
  r = await push(credit, first.username, first.password + 'x');
  check('push: wrong password -> 401', r.status === 401 && ingested.length === 1);
  r = await push(credit, 'karo_wrongname', first.password);
  check('push: wrong username -> 401', r.status === 401);
  r = await push({ ...credit, AccountNumber: '36000000000' }, first.username, first.password);
  check('push: account we do not know -> 401', r.status === 401);
  r = await push(credit, undefined);
  check('push: no login at all -> 401', r.status === 401);
  r = await push({ ...credit, TransactionId: undefined, MessageReference: undefined }, first.username, first.password);
  check('push: right login but no id at all -> 400', r.status === 400);
  const asBase64 = (u, p) => Buffer.from(u + ':' + p).toString('base64');
  const pushRaw = async (headers, payload) => { const r = await fetch(`${base}/webhooks/coop/ins`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload) }); return r.status; };
  const n0 = ingested.length;
  check('login in a header literally named "Basic" (base64) is accepted', (await pushRaw({ Basic: 'Basic ' + asBase64(first.username, first.password) }, { ...credit, TransactionId: 'H1' })) === 200 && ingested.length === n0 + 1);
  check('login in the message body field "Basic" (base64) is accepted', (await pushRaw({}, { ...credit, TransactionId: 'B1', Basic: asBase64(first.username, first.password) })) === 200 && ingested.length === n0 + 2);
  check('login in the body as plain user:pass is accepted', (await pushRaw({}, { ...credit, TransactionId: 'B2', Basic: first.username + ':' + first.password })) === 200 && ingested.length === n0 + 3);
  check('a WRONG password in the body field is still refused', (await pushRaw({}, { ...credit, TransactionId: 'B3', Basic: asBase64(first.username, 'nope') })) === 401 && ingested.length === n0 + 3);
  check("Co-op's literal placeholder 'BasicAuthCredential' is refused", (await pushRaw({}, { ...credit, TransactionId: 'B4', Basic: 'BasicAuthCredential' })) === 401);
  r = await push({ ...credit, EventType: 'DEPOSIT', TransactionId: 'UNK1' }, first.username, first.password);
  check('push: unknown event type -> acknowledged, NOT saved (and logged loudly)', r.status === 200 && ingested.length === n0 + 3, JSON.stringify(r));
  r = await push({ ...credit, TransactionId: undefined }, first.username, first.password);
  check('push: no TransactionId -> still saved using MessageReference', r.status === 200 && ingested[ingested.length - 1].external_ref === '40ca18c6765086089a1');

  r = await generate(1, tok(1), {});
  check('reset WITHOUT confirmation is refused (400) and the old password still works', r.status === 400 && (await push(credit, first.username, first.password)).status === 200, r.status);

  r = await generate(1, tok(1), RESET);
  const second = r.body;
  check('rotate: same username, new password, same account kept', second.rotated === true && second.username === first.username && second.password !== first.password && second.account_number === '36001873000');
  check('rotate: the old password stops working at once', (await push(credit, first.username, first.password)).status === 401);
  const before = ingested.length;
  check('rotate: the new password works', (await push({ ...credit, TransactionId: 'NEW1' }, second.username, second.password)).status === 200 && ingested.length === before + 1);

  r = await generate(2, tok(2), { account_number: '36009999999' });
  const other = r.body;
  check("school 2 gets its own username and account", r.status === 200 && other.username !== first.username && other.account_number === '36009999999');
  r = await push({ ...credit, AccountNumber: '36009999999', TransactionId: 'X2' }, first.username, first.password);
  check("school 1's login cannot post for school 2's account", r.status === 401);
  r = await push({ ...credit, AccountNumber: '36009999999', TransactionId: 'X3' }, other.username, other.password);
  check("school 2's own login works for its own account only", r.status === 200 && ingested[ingested.length - 1].school_id === 2);

  conns.push({ school_id: 99, provider_id: 2, account_number: '36001873000', credentials_enc: stored.credentials_enc });
  r = await push({ ...credit, TransactionId: 'AMB' }, second.username, second.password);
  check('an account number shared by two schools is refused, never guessed', r.status === 401);

  console.log('\n' + (failed === 0 ? 'All Co-op checks pass.' : failed + ' check(s) FAILED.'));
  server.close(); process.exit(failed ? 1 : 0);
});