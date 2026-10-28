// Tests the PARENT PORTAL end to end over HTTP: sign-in by text-message code, the kids picker, fees, payment history, receipts,
// "send request to my phone" (STK push) and the Safaricom callback that books the money.
// REAL Postgres. Safaricom (axios) and the text-message service are faked. It WIPES the database it connects to, so it
// refuses to run unless the name ends with _test.
//   Windows CMD:   set TEST_DATABASE_URL=postgres://user:password@localhost:5432/karo_test
//                  node src/scripts/test-parent-portal.js
const crypto = require('crypto');
const url = process.env.TEST_DATABASE_URL || '';
if (!/\/[^/]*_test(\?.*)?$/.test(url)) { console.error('Set TEST_DATABASE_URL to a database whose name ends with _test (it is WIPED). Example: postgres://user:password@localhost:5432/karo_test'); process.exit(1); }
process.env.DATABASE_URL = url;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.PUBLIC_BASE_URL = 'https://pay.example.com';
delete process.env.SMS_PROVIDER; delete process.env.SMS_PARTNER_ID; delete process.env.SMS_API_KEY; delete process.env.SMS_SENDER_ID;   // dev mode: the code comes back in the reply
process.env.NODE_ENV = 'test';
process.env.SMS_SHOW_CODE_ON_SCREEN = 'true';   // so the tests can read the code from the reply

const axios = require('axios');
const { pool, initSchema } = require('../db/db');
const { encrypt } = require('../security/crypto');
const { generateParentToken, generateToken } = require('../security/auth');
const { savePasskey } = require('../services/mpesaPasskey');
const fees = require('../services/feeSetup');
const sheet = require('../services/studentSheet');
const { admitStudent } = require('../services/studentAdmission');
const { ingestPayment } = require('../services/ingest');
const parentAuth = require('../services/parentAuth');
const portal = require('../services/parentPortal');
const { refreshIfStale } = require('../services/stkCallback');

let passed = 0, failed = 0;
const check = (name, ok, extra) => { if (ok) passed++; else failed++; console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (!ok && extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); };
const q = async (sql, p) => (await pool.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];

// Safaricom pretend: every push is accepted. `posts` records what was sent (the callback address has the secret code in it).
let posts = [], n = 0;
axios.get = async () => ({ data: { access_token: 'tok', expires_in: '3599' } });
axios.post = async (u, body) => { posts.push({ u, body }); n++; return { data: { MerchantRequestID: 'm-' + n, CheckoutRequestID: 'ws_CO_' + n, ResponseCode: '0', ResponseDescription: 'Success', CustomerMessage: 'ok' } }; };
const PASSKEY = 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919';

const app = require('../app');
let base = '';
async function call(method, path, body, token, extraHeaders) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(extraHeaders || {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, body: json };
}
const tokenFor = async (phone) => {                                       // sign-in itself is tested separately; the portal tests use a ready token
  const acc = (await q(`INSERT INTO parent_accounts (phone) VALUES ($1) ON CONFLICT (phone) DO UPDATE SET last_login_at = NOW() RETURNING token_version`, [phone]))[0];
  return generateParentToken({ phone, tv: acc.token_version });
};
const cbBody = (checkout, o = {}) => (o.code ?? 0) === 0
  ? { Body: { stkCallback: { MerchantRequestID: 'm-x', CheckoutRequestID: checkout, ResultCode: 0, ResultDesc: 'The service request is processed successfully.', CallbackMetadata: { Item: [
    { Name: 'Amount', Value: o.amount ?? 5000 }, { Name: 'MpesaReceiptNumber', Value: ('receipt' in o ? o.receipt : 'SKR4T8W2QA') }, { Name: 'TransactionDate', Value: 20261026211700 }, { Name: 'PhoneNumber', Value: o.phone || 254712345678 }] } } } }
  : { Body: { stkCallback: { MerchantRequestID: 'm-x', CheckoutRequestID: checkout, ResultCode: o.code, ResultDesc: o.desc || 'Request cancelled by user' } } };
const cbUrl = (requestId) => { const p = posts.filter((x) => x.u.includes('stkpush')).pop(); const m = /\/webhooks\/stk\/(\d+)\/([0-9a-f]+)\/result/.exec(p.body.CallBackURL); return { id: Number(m[1]), token: m[2], path: new URL(p.body.CallBackURL).pathname }; };
const checkoutOf = async (id) => (await one('SELECT checkout_request_id FROM stk_requests WHERE id = $1', [id])).checkout_request_id;
const paidOf = async (sid, tid) => Number((await one('SELECT amount_paid FROM student_term_ledger WHERE student_id = $1 AND term_id = $2', [sid, tid])).amount_paid);
const JANE = '254712345678', PETER = '254722000111';

(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await initSchema();
  await initSchema();                                                       // running the schema twice must be harmless
  const server = app.listen(0); base = 'http://127.0.0.1:' + server.address().port;

  /* ---------------- the world ---------------- */
  const C = Object.fromEntries((await q('SELECT id, name FROM classes')).map((r) => [r.name, r.id]));
  await q(`INSERT INTO schools (name, phone) VALUES ('Alpha High', '0711000000'), ('Beta High', NULL)`);
  for (const s of [1, 2]) await q('INSERT INTO school_classes (school_id, class_id, enabled) VALUES ($1,$2,TRUE)', [s, C['Grade 1']]);
  await q(`UPDATE schools SET mpesa_shortcode = '400200', mpesa_consumer_key_enc = $1, mpesa_consumer_secret_enc = $2 WHERE id = 1`, [encrypt('ck-alpha'), encrypt('sec-alpha')]);
  await savePasskey(1, PASSKEY);
  await q(`INSERT INTO school_channels (school_id, channel) VALUES (1, 'mpesa')`);                 // Beta has no M-Pesa
  const staffA = (await q(`INSERT INTO staff (school_id, full_name, email) VALUES (1, 'Ann Bursar', 'ann@x.com') RETURNING id`))[0].id;
  const y = (await q(`INSERT INTO academic_years (year, is_current) VALUES (EXTRACT(YEAR FROM CURRENT_DATE), TRUE) RETURNING id`))[0].id;
  await q(`INSERT INTO terms (academic_year_id, term_number) VALUES ($1,1),($1,2),($1,3)`, [y]);
  const T = Object.fromEntries((await q('SELECT id, term_number FROM terms')).map((r) => [r.term_number, r.id]));
  await q(`INSERT INTO school_term_dates (school_id, term_id, start_date, end_date) VALUES (1,$1,CURRENT_DATE-150,CURRENT_DATE-60),(1,$2,CURRENT_DATE-20,CURRENT_DATE+60),(2,$2,CURRENT_DATE-20,CURRENT_DATE+60)`, [T[1], T[2]]);
  await fees.setFees(1, { classNames: ['Grade 1'], terms: [1, 2, 3], fees: ['Tuition=50000', 'Exam=2000'], optional: ['Lunch=3000'], newOptional: true });
  await fees.setFees(2, { classNames: ['Grade 1'], terms: [2, 3], fees: ['Tuition=30000'] });
  const adm = (s, no, name, contacts, extra = {}) => admitStudent(s, { admissionNo: no, fullName: name, classId: C['Grade 1'], contacts, ...extra }).then((r) => r.student.id);
  const amina = await adm(1, '101', 'Amina Wanjiru', [{ name: 'Jane Wanjiru', phone: '0712 345 678', relationship: 'Mother' }], { optionalFees: ['Lunch'] });
  const brian = await adm(1, '102', 'Brian Otieno', [{ name: 'Jane Wanjiru', phone: '+254712345678', relationship: 'Mother' }, { name: 'Uncle Joe', phone: '0700 111 222', relationship: 'Uncle' }]);
  const cara = await adm(1, '103', 'Cara Mutua', [{ name: 'Peter Mutua', phone: '0722 000 111', relationship: 'Father' }]);
  const leftKid = await adm(1, '104', 'Lara Left', [{ name: 'Jane Wanjiru', phone: '0712345678' }]);
  await q(`UPDATE students SET status = 'left' WHERE id = $1`, [leftKid]);
  const dan = await adm(2, '201', 'Dan Kimani', [{ name: 'Jane Wanjiru', phone: '0712345678' }]);
  const eve = await adm(1, '105', 'Eve Test', [{ phone: '0733 000 001' }]), fred = await adm(1, '106', 'Fred Test', [{ phone: '0733 000 002' }]), gina = await adm(1, '107', 'Gina Test', [{ phone: '0733 000 003' }]);

  await q(`INSERT INTO student_term_ledger (student_id, term_id, opening_balance, fees_charged, amount_paid) VALUES ($1,$2,0,48000,48000) ON CONFLICT DO NOTHING`, [amina, T[1]]);
  const bank = (await q(`INSERT INTO transactions (school_id, term_id, source, external_ref, amount, payer_name, narration, match_status, matched_student_id)
     VALUES (1, $1, 'mpesa', 'QWE123', 10000, 'Jane W', 'ADM 101', 'auto_matched', $2) RETURNING id`, [T[2], amina]))[0].id;
  await q(`UPDATE student_term_ledger SET amount_paid = 10000 WHERE student_id = $1 AND term_id = $2`, [amina, T[2]]);
  const man = await sheet.recordManualPayment(1, amina, { amount: 15000, method: 'cash', reference: 'Slip 55', note: 'PRIVATE: mother promised the rest on Friday' }, { staffId: staffA });
  const wrong = await sheet.recordManualPayment(1, amina, { amount: 700, method: 'cash', reference: 'Slip 56' }, { staffId: staffA });
  await sheet.reverseManualPayment(1, wrong.transaction_id, { reason: 'typed twice' }, { staffId: staffA });
  await q(`INSERT INTO transactions (school_id, term_id, source, external_ref, amount, match_status, matched_student_id) VALUES (1, $1, 'mpesa', 'UNM1', 777, 'unmatched', NULL)`, [T[2]]);
  const caraTxn = (await q(`INSERT INTO transactions (school_id, term_id, source, external_ref, amount, match_status, matched_student_id) VALUES (1, $1, 'kcb', 'CARA1', 4000, 'auto_matched', $2) RETURNING id`, [T[2], cara]))[0].id;
  const jane = await tokenFor(JANE), peter = await tokenFor(PETER);

  /* ---------------- sign-in ---------------- */
  let r = await call('POST', '/api/parent/otp', { phone: '0733 000 999' });
  check('a phone no school knows is told so plainly (404), nothing sent', r.status === 404 && /not registered/.test(r.body.error) && r.body.devCode === undefined, r);
  const unknownReply = { message: 'A sign-in code has been sent to your phone.' };
  r = await call('POST', '/api/parent/otp', { phone: '0733 000 003' });
  check('code for a known phone: 200 and (dev mode) the code comes back', r.status === 200 && /^\d{6}$/.test(r.body.devCode || '') && r.body.message === unknownReply.message, r);
  const codeGina = r.body.devCode;
  check('the code is stored only as a fingerprint', !(await q('SELECT code_hash FROM parent_otps WHERE phone = $1', ['254733000003'])).some((x) => x.code_hash.includes(codeGina)));
  r = await call('POST', '/api/parent/otp', { phone: '12345' });
  check('a bad phone number is a plain 400', r.status === 400 && /phone number/i.test(r.body.error), r);
  r = await call('POST', '/api/parent/verify', { phone: '0733 000 003', code: codeGina === '000000' ? '111111' : '000000' });
  check('wrong code: 401, plain message', r.status === 401 && /not right/.test(r.body.error), r);
  r = await call('POST', '/api/parent/verify', { phone: '0733 000 003', code: codeGina });
  check('right code: a token', r.status === 200 && typeof r.body.token === 'string' && r.body.phone === '254733000003', r);
  const ginaToken = r.body.token;
  r = await call('POST', '/api/parent/verify', { phone: '0733 000 003', code: codeGina });
  check('the same code can not be used twice', r.status === 401, r);
  r = await call('GET', '/api/parent/me', undefined, ginaToken);
  check('the token opens the portal', r.status === 200 && r.body.children.length === 1 && r.body.children[0].admission_no === '107', r);

  r = await call('POST', '/api/parent/otp', { phone: '0733 000 003' }); const c1 = r.body.devCode;
  r = await call('POST', '/api/parent/otp', { phone: '0733 000 003' }); const c2 = r.body.devCode;
  r = await call('POST', '/api/parent/verify', { phone: '0733 000 003', code: c1 === c2 ? '000001' : c1 });
  check('asking for a new code kills the older one', r.status === 401, r);
  r = await call('POST', '/api/parent/otp', { phone: '0733 000 003' });
  check('no limit on codes per phone: a 4th code in the hour is sent', r.status === 200 && /^\d{6}$/.test(r.body.devCode || ''), r);
  r = await call('POST', '/api/parent/otp', { phone: '0733 000 001' }); const codeEve = r.body.devCode;
  await q(`UPDATE parent_otps SET expires_at = NOW() - INTERVAL '1 minute' WHERE phone = '254733000001'`);
  r = await call('POST', '/api/parent/verify', { phone: '0733 000 001', code: codeEve });
  check('an expired code is refused', r.status === 401, r);

  r = await call('POST', '/api/parent/otp', { phone: '0733 000 002' }); const codeFred = r.body.devCode;
  const wrongCode = codeFred === '123456' ? '654321' : '123456';
  let last; for (let i = 0; i < 5; i++) last = await call('POST', '/api/parent/verify', { phone: '0733 000 002', code: wrongCode });
  check('5 wrong codes in a row lock the phone for 15 minutes', last.status === 429 && /15 minutes/.test(last.body.error), last);
  r = await call('POST', '/api/parent/verify', { phone: '0733 000 002', code: codeFred });
  check('while locked even the right code is refused', r.status === 429, r);

  // the real text-message path, with a pretend Celcom
  process.env.SMS_PROVIDER = 'celcom'; process.env.SMS_PARTNER_ID = '123'; process.env.SMS_API_KEY = 'k'; process.env.SMS_SENDER_ID = 'KARO';
  let sent = [];
  const rep = await parentAuth.requestCode('0722 000 111', { sendSms: async (m) => { sent.push(m); return { sent: true }; } });
  check('with Celcom set: the code goes by text and is NOT in the reply', sent.length === 1 && sent[0].to === PETER && /\b\d{6}\b/.test(sent[0].text) && rep.devCode === undefined && rep.ok, { sent, rep });
  const sms = require('../services/sms');
  const calls = [];
  const okReply = { ok: true, text: async () => JSON.stringify({ responses: [{ 'respose-code': 200, 'response-description': 'Success', mobile: PETER, messageid: 77 }] }) };
  const res1 = await sms.sendSms({ to: PETER, text: 'hello' }, { fetch: async (u, o) => { calls.push({ u, o }); return okReply; } });
  const sentBody = JSON.parse(calls[0].o.body);
  check('Celcom request: JSON with apikey, partnerID, shortcode, 254 number, message', res1.sent && sentBody.apikey === 'k' && sentBody.partnerID === '123' && sentBody.shortcode === 'KARO' && sentBody.mobile === PETER && sentBody.message === 'hello' && calls[0].u === sms.DEFAULT_URL, calls);
  const fail = async (f) => { try { await sms.sendSms({ to: PETER, text: 'x' }, { fetch: f }); return null; } catch (e) { return e; } };
  let e1 = await fail(async () => ({ ok: true, text: async () => JSON.stringify({ responses: [{ 'respose-code': 1004, 'response-description': 'Low bulk credits' }] }) }));
  check('Celcom refuses (low credits): a plain 502, never a silent success', e1 && e1.status === 502, e1 && e1.message);
  e1 = await fail(async () => ({ ok: true, text: async () => 'weird page' }));
  check('an unreadable Celcom reply counts as NOT sent', e1 && e1.status === 502);
  e1 = await fail(async () => { throw new Error('offline'); });
  check('Celcom unreachable: a plain 502', e1 && e1.status === 502);
  process.env.SMS_URL = 'https://sms.example.com/send'; calls.length = 0;
  await sms.sendSms({ to: PETER, text: 'x' }, { fetch: async (u) => { calls.push(u); return okReply; } });
  check('SMS_URL changes where it is sent', calls[0] === 'https://sms.example.com/send'); delete process.env.SMS_URL;
  delete process.env.SMS_PROVIDER; delete process.env.SMS_PARTNER_ID; delete process.env.SMS_API_KEY; delete process.env.SMS_SENDER_ID;

  r = await call('GET', '/api/parent/me');
  check('no token: 401', r.status === 401, r);
  r = await call('GET', '/api/parent/me', undefined, generateToken({ staffId: staffA, schoolId: 1, tv: 0 }));
  check('a STAFF token does not open the parent portal', r.status === 401, r);
  r = await call('GET', '/api/schools/1/balances', undefined, jane);
  check('a PARENT token does not open staff pages', r.status === 401, r);
  const logoutTok = await tokenFor('254733000009');
  await q(`INSERT INTO parent_accounts (phone) VALUES ('254733000009') ON CONFLICT DO NOTHING`);
  r = await call('POST', '/api/parent/logout', {}, logoutTok);
  check('sign out everywhere', r.status === 200, r);
  r = await call('GET', '/api/parent/me', undefined, logoutTok);
  check('after sign-out the old token stops working', r.status === 401, r);

  /* ---------------- the kids picker ---------------- */
  r = await call('GET', '/api/parent/me', undefined, jane);
  const kids = r.body.children || [];
  check('Jane sees Amina, Brian (saved as +254...) and Dan (other school); NOT Cara, NOT the child who left', kids.map((k) => k.name).join('|') === 'Amina Wanjiru|Brian Otieno|Dan Kimani', kids.map((k) => k.name));
  const kA = kids.find((k) => k.id === amina);
  check('Amina: Term 2, charged 55,000 (Tuition+Exam+Lunch), paid 25,000, owes 30,000', kA.term && kA.term.startsWith('Term 2') && kA.fees_charged === 55000 && kA.paid === 25000 && kA.balance === 30000 && kA.state === 'owing' && kA.first_name === 'Amina' && kA.class === 'Grade 1' && kA.school.name === 'Alpha High', kA);
  check('Dan is in the other school, with that school\'s fees', kids.find((k) => k.id === dan).school.name === 'Beta High' && kids.find((k) => k.id === dan).balance === 30000);
  check('the greeting name is the contact name the school has for that phone', r.body.name === 'Jane Wanjiru', r.body.name);
  r = await call('GET', '/api/parent/me', undefined, peter);
  check('Peter sees only Cara', r.body.children.length === 1 && r.body.children[0].name === 'Cara Mutua', r.body);

  /* ---------------- one child: access rules ---------------- */
  for (const [name, path] of [['home', ''], ['fees', '/fees'], ['payments', '/payments']]) {
    r = await call('GET', `/api/parent/children/${cara}${path}`, undefined, jane);
    check(`${name}: another parent's child is a 404 (never "forbidden", so nothing is revealed)`, r.status === 404 && r.body.error === 'No such student.', r);
  }
  r = await call('GET', `/api/parent/children/${leftKid}`, undefined, jane);
  check('a child who left is not available', r.status === 404);
  r = await call('GET', '/api/parent/children/abc', undefined, jane);
  check('a nonsense id is a 404', r.status === 404);

  /* ---------------- home ---------------- */
  r = await call('GET', `/api/parent/children/${amina}`, undefined, jane);
  check('home: balance, last payments newest first, paybill and push both on', r.status === 200 && r.body.child.balance === 30000 && r.body.recent_payments.length === 2 && r.body.recent_payments[0].id === man.transaction_id
    && r.body.pay.online === true && r.body.pay.paybill.business_number === '400200' && r.body.pay.paybill.account_number === '101' && r.body.pay.school_phone === '0711000000', r.body);
  r = await call('GET', `/api/parent/children/${dan}`, undefined, jane);
  check('home at a school without M-Pesa: no push, no paybill', r.body.pay.online === false && r.body.pay.paybill === null, r.body.pay);
  await q(`UPDATE schools SET mpesa_passkey_enc = NULL WHERE id = 1`);
  r = await call('GET', `/api/parent/children/${amina}`, undefined, jane);
  check('school with a Paybill but no passkey: paybill steps shown, push off', r.body.pay.online === false && r.body.pay.paybill && r.body.pay.paybill.business_number === '400200', r.body.pay);
  await savePasskey(1, PASSKEY);

  /* ---------------- fees ---------------- */
  r = await call('GET', `/api/parent/children/${amina}/fees`, undefined, jane);
  check('fees: this term\'s lines come from the locked fees, Lunch marked optional', r.body.items.length === 3 && r.body.items.find((i) => i.name === 'Lunch').optional === true && r.body.total === 55000 && r.body.term.startsWith('Term 2'), r.body);
  check('fees: term by term, newest first, Term 1 cleared', r.body.by_term.length === 2 && r.body.by_term[0].state === 'owing' && r.body.by_term[1].state === 'cleared' && r.body.by_term[1].paid === 48000, r.body.by_term);
  r = await call('GET', `/api/parent/children/${brian}/fees`, undefined, jane);
  check('fees: Brian did not choose Lunch, so it is not on his bill', r.body.items.length === 2 && r.body.total === 52000, r.body);

  /* ---------------- payment history ---------------- */
  r = await call('GET', `/api/parent/children/${amina}/payments`, undefined, jane);
  const pays = r.body.payments || [];
  check('payments: the M-Pesa one and the cash one only (not the unmatched, not the reversed)', r.body.total === 2 && pays.length === 2, r.body);
  const pBank = pays.find((p) => p.id === bank), pMan = pays.find((p) => p.id === man.transaction_id);
  check('payments: M-Pesa row has its code, kind and receipt number', pBank.kind === 'mpesa' && pBank.channel === 'M-Pesa' && pBank.reference === 'QWE123' && pBank.receipt_no === 'RCP-' + String(bank).padStart(6, '0') && pBank.amount === 10000, pBank);
  check('payments: the cash row shows the slip number, NEVER the staff\'s private note', pMan.kind === 'cash' && pMan.channel === 'Cash' && pMan.reference === 'Slip 55' && !JSON.stringify(r.body).includes('PRIVATE'), pMan);
  check('payments: nothing about who at the school typed it in', !/Ann Bursar|added_by|acted_by/.test(JSON.stringify(r.body)));
  r = await call('GET', `/api/parent/children/${amina}/payments?limit=1&offset=1`, undefined, jane);
  check('payments: paging works', r.body.payments.length === 1 && r.body.total === 2, r.body);

  /* ---------------- receipts ---------------- */
  r = await call('GET', `/api/parent/children/${amina}/payments/${man.transaction_id}/receipt`, undefined, jane);
  check('receipt: own payment, school, student, balance after, no staff name, no private note', r.status === 200 && r.body.school === 'Alpha High' && r.body.student.admission_no === '101' && r.body.reference === 'Slip 55' && r.body.entered_by === undefined && !JSON.stringify(r.body).includes('PRIVATE') && r.body.balance_after === 30000, r.body);
  r = await call('GET', `/api/parent/children/${amina}/payments/${caraTxn}/receipt`, undefined, jane);
  check('receipt: another child\'s payment is a 404 even through my own child\'s address', r.status === 404, r);
  r = await call('GET', `/api/parent/children/${cara}/payments/${caraTxn}/receipt`, undefined, jane);
  check('receipt: another parent\'s child is a 404', r.status === 404, r);
  r = await call('GET', `/api/parent/children/${amina}/payments/${wrong.transaction_id}/receipt`, undefined, jane);
  check('receipt: a reversed payment has none', r.status === 404 || r.status === 409, r);

  /* ---------------- paying: starting the push ---------------- */
  r = await call('POST', `/api/parent/children/${amina}/pay`, { amount: 0 }, jane);
  check('pay: amount 0 is refused with a plain message', r.status === 400 && /whole number/.test(r.body.error), r);
  r = await call('POST', `/api/parent/children/${amina}/pay`, { amount: 'abc' }, jane);
  check('pay: text is refused', r.status === 400, r);
  r = await call('POST', `/api/parent/children/${cara}/pay`, { amount: 1000 }, jane);
  check('pay: for a child that is not mine: 404, nothing sent to Safaricom', r.status === 404 && posts.length === 0, { r, posts: posts.length });
  r = await call('POST', `/api/parent/children/${dan}/pay`, { amount: 1000 }, jane);
  check('pay: school without M-Pesa: 409 with a plain message', r.status === 409 && /not switched on/.test(r.body.error), r);
  r = await call('POST', `/api/parent/children/${amina}/pay`, { amount: '5,000', phone: '0799 000 001' }, jane);
  check('pay: "5,000" typed with a comma is accepted; the prompt goes to the phone typed', r.status === 200 && r.body.status === 'sent' && Number.isInteger(r.body.request_id), r);
  const req1 = r.body.request_id;
  const push1 = posts.filter((x) => x.u.includes('stkpush')).pop().body;
  check('pay: Safaricom was asked for 5,000, to that phone, with the admission number as the account', push1.Amount === 5000 && push1.PhoneNumber === '254799000001' && push1.AccountReference === '101' && push1.BusinessShortCode === '400200', push1);
  r = await call('POST', `/api/parent/children/${amina}/pay`, { amount: 100, phone: '0799 000 002' }, jane);
  check('pay: a second tap while one is open is refused', r.status === 409 && /already open/.test(r.body.error), r);
  r = await call('GET', `/api/parent/children/${amina}/pay/${req1}`, undefined, jane);
  check('status: sent, no receipt yet', r.status === 200 && r.body.status === 'sent' && r.body.receipt === null && r.body.amount === 5000, r);
  r = await call('GET', `/api/parent/children/${amina}/pay/${req1}`, undefined, peter);
  check('status: another parent can not see my request', r.status === 404, r);
  r = await call('GET', `/api/parent/children/${brian}/pay/${req1}`, undefined, jane);
  check('status: my request under my OTHER child\'s address is a 404', r.status === 404, r);

  /* ---------------- the callback: who may call it ---------------- */
  const cb1 = cbUrl(req1), ck1 = await checkoutOf(req1);
  r = await call('POST', `/webhooks/stk/${req1}/${'0'.repeat(40)}/result`, cbBody(ck1));
  check('callback: wrong secret code -> 404, nothing changes', r.status === 404 && (await one('SELECT status FROM stk_requests WHERE id = $1', [req1])).status === 'sent' && await paidOf(amina, T[2]) === 25000, r);
  r = await call('POST', `/webhooks/stk/99999/${cb1.token}/result`, cbBody(ck1));
  check('callback: unknown request number -> 404', r.status === 404, r);
  r = await call('POST', cb1.path, { hello: 'world' });
  check('callback: not a Safaricom message -> 400, nothing changes', r.status === 400 && (await one('SELECT status FROM stk_requests WHERE id = $1', [req1])).status === 'sent', r);
  r = await call('POST', cb1.path, cbBody(ck1, { receipt: null }));
  check('callback: "paid" without a receipt code is not trusted', r.status === 400 && await paidOf(amina, T[2]) === 25000, r);
  r = await call('POST', cb1.path, cbBody('ws_CO_other'));
  check('callback: a message for a different checkout id is refused', r.status === 400 && await paidOf(amina, T[2]) === 25000, r);

  /* ---------------- the callback: paid ---------------- */
  r = await call('POST', cb1.path, cbBody(ck1, { amount: 5000, receipt: 'SKR4T8W2QA' }));
  check('callback: paid -> Accepted', r.status === 200 && r.body.ResultCode === 0, r);
  const t1 = await one(`SELECT * FROM transactions WHERE external_ref = 'SKR4T8W2QA'`);
  check('callback: booked once, as M-Pesa, matched to Amina, in the current term', t1 && t1.source === 'mpesa' && Number(t1.amount) === 5000 && t1.matched_student_id === amina && t1.term_id === T[2] && t1.match_status === 'auto_matched' && t1.school_id === 1, t1);
  check('callback: Amina\'s ledger 25,000 -> 30,000 paid', await paidOf(amina, T[2]) === 30000);
  check('callback: request row is paid with the receipt', (await one('SELECT status, mpesa_receipt, result_code FROM stk_requests WHERE id = $1', [req1])).mpesa_receipt === 'SKR4T8W2QA');
  check('callback: audit line, no staff member (it was the parent)', !!(await one(`SELECT 1 FROM audit_log WHERE action = 'stk_payment_received' AND staff_id IS NULL AND school_id = 1 AND detail->>'receipt' = 'SKR4T8W2QA'`)));
  r = await call('GET', `/api/parent/children/${amina}/pay/${req1}`, undefined, jane);
  check('status: paid, with the receipt code', r.body.status === 'paid' && r.body.receipt === 'SKR4T8W2QA', r.body);
  r = await call('GET', `/api/parent/children/${amina}`, undefined, jane);
  check('home now shows the new balance and the new payment on top', r.body.child.balance === 25000 && r.body.recent_payments[0].reference === 'SKR4T8W2QA' && r.body.recent_payments[0].amount === 5000, r.body.recent_payments[0]);

  r = await call('POST', cb1.path, cbBody(ck1, { amount: 5000, receipt: 'SKR4T8W2QA' }));
  check('callback sent again: Accepted, and NOTHING is counted twice', r.status === 200 && await paidOf(amina, T[2]) === 30000 && (await q(`SELECT 1 FROM transactions WHERE external_ref = 'SKR4T8W2QA'`)).length === 1);
  const dup = await ingestPayment({ school_id: 1, source: 'mpesa', external_ref: 'SKR4T8W2QA', amount: 5000, narration: '101' });
  check('the normal Paybill alert for the same money arriving AFTER is ignored', dup.alreadyProcessed === true && await paidOf(amina, T[2]) === 30000);
  r = await call('POST', cb1.path, cbBody(ck1, { code: 1032 }));
  check('a late "cancelled" message never undoes a paid request', r.status === 200 && (await one('SELECT status FROM stk_requests WHERE id = $1', [req1])).status === 'paid' && await paidOf(amina, T[2]) === 30000);

  /* ---------------- both messages arrive: the Paybill alert FIRST ---------------- */
  r = await call('POST', `/api/parent/children/${amina}/pay`, { amount: 2000, phone: '0799 000 003' }, jane);
  const req2 = r.body.request_id, cb2 = cbUrl(req2), ck2 = await checkoutOf(req2);
  const first = await ingestPayment({ school_id: 1, source: 'mpesa', external_ref: 'SKR2ALERT1', amount: 2000, payer_phone: '254799000003', narration: '101' });
  check('Paybill alert first: matched and booked by the normal path', first.match.status === 'auto_matched' && await paidOf(amina, T[2]) === 32000, first.match);
  r = await call('POST', cb2.path, cbBody(ck2, { amount: 2000, receipt: 'SKR2ALERT1', phone: 254799000003 }));
  check('then the callback: request marked paid, the money is NOT counted a second time', r.status === 200 && (await one('SELECT status FROM stk_requests WHERE id = $1', [req2])).status === 'paid' && await paidOf(amina, T[2]) === 32000 && (await q(`SELECT 1 FROM transactions WHERE external_ref = 'SKR2ALERT1'`)).length === 1);

  /* ---------------- ... the Paybill alert FIRST, but it could not tell the student ---------------- */
  r = await call('POST', `/api/parent/children/${brian}/pay`, { amount: 3000, phone: '0700 111 222' }, jane);
  const req3 = r.body.request_id, cb3 = cbUrl(req3), ck3 = await checkoutOf(req3);
  const before = await paidOf(brian, T[2]).catch(() => 0);
  const lost = await ingestPayment({ school_id: 1, source: 'mpesa', external_ref: 'SKR3ALERT1', amount: 3000, narration: 'school fees please' });
  check('Paybill alert with a vague reference goes to the Review queue (not booked)', lost.match.status !== 'auto_matched' && await paidOf(brian, T[2]) === before, lost.match);
  r = await call('POST', cb3.path, cbBody(ck3, { amount: 3000, receipt: 'SKR3ALERT1', phone: 254700111222 }));
  const t3 = await one(`SELECT * FROM transactions WHERE external_ref = 'SKR3ALERT1'`);
  check('the callback knows the student for sure, so it settles that waiting payment', r.status === 200 && t3.matched_student_id === brian && t3.match_status === 'auto_matched' && await paidOf(brian, T[2]) === before + 3000, t3);
  check('...and says so in the activity log', !!(await one(`SELECT 1 FROM audit_log WHERE action = 'stk_payment_received' AND detail->>'how' = 'settled_from_review'`)));

  /* ---------------- two copies of the callback at the same instant ---------------- */
  r = await call('POST', `/api/parent/children/${amina}/pay`, { amount: 1000, phone: '0799 000 004' }, jane);
  const req4 = r.body.request_id, cb4 = cbUrl(req4), ck4 = await checkoutOf(req4);
  const paid4 = await paidOf(amina, T[2]);
  const both = await Promise.all([1, 2, 3].map(() => call('POST', cb4.path, cbBody(ck4, { amount: 1000, receipt: 'SKR4RACE01' }))));
  check('three copies at once: all Accepted, counted ONCE', both.every((x) => x.status === 200) && await paidOf(amina, T[2]) === paid4 + 1000 && (await q(`SELECT 1 FROM transactions WHERE external_ref = 'SKR4RACE01'`)).length === 1, both.map((x) => x.status));

  /* ---------------- amount different from what we asked ---------------- */
  r = await call('POST', `/api/parent/children/${amina}/pay`, { amount: 2000, phone: '0799 000 005' }, jane);
  const req5 = r.body.request_id, cb5 = cbUrl(req5), ck5 = await checkoutOf(req5);
  const paid5 = await paidOf(amina, T[2]);
  await call('POST', cb5.path, cbBody(ck5, { amount: 1900, receipt: 'SKR5DIFF01' }));
  const t5 = await one(`SELECT amount, match_reason FROM transactions WHERE external_ref = 'SKR5DIFF01'`);
  check('if M-Pesa took a different amount, the amount M-Pesa took is booked, and the note says so', Number(t5.amount) === 1900 && /2000/.test(t5.match_reason) && await paidOf(amina, T[2]) === paid5 + 1900, t5);

  /* ---------------- not paid: cancelled, ran out of time ---------------- */
  r = await call('POST', `/api/parent/children/${amina}/pay`, { amount: 1500, phone: '0799 000 006' }, jane);
  const req6 = r.body.request_id, cb6 = cbUrl(req6), ck6 = await checkoutOf(req6);
  const paid6 = await paidOf(amina, T[2]);
  r = await call('POST', cb6.path, cbBody(ck6, { code: 1032 }));
  const st6 = await call('GET', `/api/parent/children/${amina}/pay/${req6}`, undefined, jane);
  check('cancelled on the phone: status cancelled, plain message, no money moved', r.status === 200 && st6.body.status === 'cancelled' && /cancelled/.test(st6.body.message) && await paidOf(amina, T[2]) === paid6 && (await q(`SELECT 1 FROM transactions WHERE payer_phone = '254799000006'`)).length === 0, st6.body);
  r = await call('POST', `/api/parent/children/${amina}/pay`, { amount: 1500, phone: '0799 000 007' }, jane);
  check('after a cancel the parent can try again straight away', r.status === 200, r);
  const req7 = r.body.request_id, cb7 = cbUrl(req7), ck7 = await checkoutOf(req7);
  await call('POST', cb7.path, cbBody(ck7, { code: 2001, desc: 'The initiator information is invalid.' }));
  const st7 = await call('GET', `/api/parent/children/${amina}/pay/${req7}`, undefined, jane);
  check('wrong PIN / failed: status failed, "no money was taken"', st7.body.status === 'failed' && /No money was taken/.test(st7.body.message), st7.body);

  /* ---------------- the safety net when no callback comes ---------------- */
  r = await call('POST', `/api/parent/children/${amina}/pay`, { amount: 800, phone: '0799 000 008' }, jane);
  const req8 = r.body.request_id, cb8 = cbUrl(req8), ck8 = await checkoutOf(req8);
  r = await call('GET', `/api/parent/children/${amina}/pay/${req8}`, undefined, jane);
  check('a young request is not checked with Safaricom yet', r.body.status === 'sent' && posts.filter((x) => /stkpushquery/.test(x.u)).length === 0, r.body);
  let asked = 0, answer = { state: 'pending', resultCode: null, resultDesc: null };
  const dep = { connector: { queryPush: async () => { asked++; return answer; } } };
  await q(`UPDATE stk_requests SET created_at = NOW() - INTERVAL '60 seconds' WHERE id = $1`, [req8]);
  let seen = await refreshIfStale(req8, 1, amina, dep);
  check('after 40 s it asks Safaricom; still pending -> stays sent', seen === 'pending' && asked === 1 && (await one('SELECT status FROM stk_requests WHERE id = $1', [req8])).status === 'sent');
  seen = await refreshIfStale(req8, 1, amina, dep);
  check('it does not ask again within 15 s', seen === null && asked === 1);
  await q(`UPDATE stk_requests SET last_checked_at = NOW() - INTERVAL '20 seconds' WHERE id = $1`, [req8]);
  answer = { state: 'paid', resultCode: 0, resultDesc: 'ok' };
  seen = await refreshIfStale(req8, 1, amina, dep);
  check('Safaricom says paid but gives no receipt: it does NOT book anything', seen === 'paid' && (await one('SELECT status FROM stk_requests WHERE id = $1', [req8])).status === 'sent' && (await q(`SELECT 1 FROM transactions WHERE payer_phone = '254799000008'`)).length === 0);
  const poll = await portal.getPaymentStatus(JANE, amina, req8, { refreshIfStale: async () => 'paid' });
  check('the parent is told the payment went through and the balance will update', poll.confirmed === true && /taken the payment/.test(poll.message), poll);
  await q(`UPDATE stk_requests SET created_at = NOW() - INTERVAL '200 seconds', last_checked_at = NOW() - INTERVAL '20 seconds' WHERE id = $1`, [req8]);
  answer = { state: 'pending', resultCode: null, resultDesc: null };
  await refreshIfStale(req8, 1, amina, dep);
  check('still no answer after 3 minutes: marked timed out', (await one('SELECT status FROM stk_requests WHERE id = $1', [req8])).status === 'timeout');
  const paid8 = await paidOf(amina, T[2]);
  r = await call('POST', cb8.path, cbBody(ck8, { amount: 800, receipt: 'SKR8LATE01' }));
  check('a LATE paid callback still books the money after a timeout', r.status === 200 && (await one('SELECT status FROM stk_requests WHERE id = $1', [req8])).status === 'paid' && await paidOf(amina, T[2]) === paid8 + 800);
  r = await call('POST', `/api/parent/children/${amina}/pay`, { amount: 800, phone: '0799 000 009' }, jane);
  const req9 = r.body.request_id;
  await q(`UPDATE stk_requests SET created_at = NOW() - INTERVAL '60 seconds' WHERE id = $1`, [req9]);
  answer = { state: 'cancelled', resultCode: 1032, resultDesc: 'Request cancelled by user' };
  await refreshIfStale(req9, 1, amina, dep);
  check('Safaricom says cancelled: the request is closed as cancelled', (await one('SELECT status, result_code FROM stk_requests WHERE id = $1', [req9])).status === 'cancelled');
  check('a poll for a request of another school/student never checks Safaricom', await refreshIfStale(req9, 2, dan, dep) === null);

  /* ---------------- other safety ---------------- */
  r = await call('POST', '/api/parent/children/' + amina + '/pay', { amount: 100 }, null);
  check('paying without signing in is a 401', r.status === 401);
  await q(`UPDATE students SET status = 'left' WHERE id = $1`, [brian]);
  r = await call('GET', `/api/parent/children/${brian}`, undefined, jane);
  check('a child marked left disappears from the portal', r.status === 404);
  const staffView = await q(`SELECT source, match_status FROM transactions WHERE external_ref = 'SKR4T8W2QA'`);
  check('staff see the portal payment as a normal M-Pesa payment (Reports, Students & balances, receipts)', staffView[0].source === 'mpesa' && staffView[0].match_status === 'auto_matched');
  const sh = await sheet.getSheet(1, amina);
  check('...and it is on Amina\'s sheet for staff too', sh.payments.some((p) => p.reference === 'SKR4T8W2QA' && p.channel === 'M-Pesa'));

  /* ---------------- the optional STK passkey, set from the admin page ---------------- */
  const { hashPassword, generatePinToken } = require('../security/auth');
  const admin = (await q(`INSERT INTO staff (school_id, full_name, email, role, status, password_hash) VALUES (1, 'Admin Ann', 'admin@x.com', 'admin', 'active', $1) RETURNING id`, [await hashPassword('pw12345678')]))[0].id;
  const plain = (await q(`INSERT INTO staff (school_id, full_name, email, role, status) VALUES (1, 'Plain Pat', 'pat@x.com', 'staff', 'active') RETURNING id`))[0].id;
  const adminTok = generateToken({ staffId: admin, schoolId: 1, tv: 0 }), plainTok = generateToken({ staffId: plain, schoolId: 1, tv: 0 });
  const pin = { 'X-Pin-Token': generatePinToken({ staffId: admin, schoolId: 1, tv: 0 }) };
  const pinPlain = { 'X-Pin-Token': generatePinToken({ staffId: plain, schoolId: 1, tv: 0 }) };
  const NEWKEY = 'a'.repeat(30) + 'B7'.repeat(10);
  await q(`UPDATE schools SET mpesa_passkey_enc = NULL WHERE id = 1`);
  const mp = async () => (await call('GET', '/api/schools/1/channels', undefined, adminTok)).body.find((c) => c.channel === 'mpesa').mpesa;
  check('passkey: a school without one is fine: stk not ready, but not blocked', (await mp()).has_passkey === false && (await mp()).stk_ready === false && (await mp()).can_register !== undefined);
  r = await call('PUT', '/api/schools/1/mpesa/passkey', { passkey: NEWKEY }, plainTok, pinPlain);
  check('passkey: a non-admin can not set it', r.status === 403, r);
  r = await call('PUT', '/api/schools/1/mpesa/passkey', { passkey: NEWKEY }, adminTok);
  check('passkey: admin without the PIN is asked for it', r.status === 403 && /PIN/.test(r.body.error), r);
  r = await call('PUT', '/api/schools/1/mpesa/passkey', { passkey: 'has spaces in it 1234567890' }, adminTok, pin);
  check('passkey: a passkey with spaces is refused in plain words', r.status === 400 && /no spaces/.test(r.body.error), r);
  r = await call('PUT', '/api/schools/1/mpesa/passkey', { passkey: NEWKEY }, adminTok, pin);
  check('passkey: admin + PIN saves it', r.status === 200 && r.body.ok && r.body.replaced === false, r);
  check('passkey: the card now says passkey saved and STK ready (no restart needed)', (await mp()).has_passkey === true && (await mp()).stk_ready === true);
  r = await call('GET', `/api/parent/children/${amina}`, undefined, jane);
  check('passkey: the parent portal turns "Send request to my phone" on by itself', r.body.pay.online === true, r.body.pay);
  check('passkey: it is stored encrypted and never sent to any screen', !(await one('SELECT mpesa_passkey_enc FROM schools WHERE id = 1')).mpesa_passkey_enc.includes(NEWKEY) && !JSON.stringify((await call('GET', '/api/schools/1/channels', undefined, adminTok)).body).includes(NEWKEY));
  r = await call('PUT', '/api/schools/1/mpesa/passkey', { passkey: NEWKEY + 'x' }, adminTok, pin);
  check('passkey: replacing needs RESET + password, not just a new value', r.status >= 400 && r.status < 500, r);
  r = await call('PUT', '/api/schools/1/mpesa/passkey', { passkey: NEWKEY + 'x', confirm_text: 'RESET', password: 'wrong-password' }, adminTok, pin);
  check('passkey: a wrong password does not replace it', r.status >= 400 && r.status < 500, r);
  r = await call('PUT', '/api/schools/1/mpesa/passkey', { passkey: NEWKEY + 'x', confirm_text: 'RESET', password: 'pw12345678' }, adminTok, pin);
  check('passkey: RESET + the right password replaces it', r.status === 200 && r.body.replaced === true, r);
  check('passkey: the activity log says it was the STK passkey', !!(await one(`SELECT 1 FROM audit_log WHERE action = 'mpesa_keys_replaced' AND detail->>'what' = 'stk passkey'`)));

  /* ---------------- Cancel in the portal: frees the student at once; a late payment is still booked ---------------- */
  const cancelKid = await adm(1, '150', 'Cancel Tester', [{ name: 'Jane Wanjiru', phone: '0712 345 678', relationship: 'Mother' }]);
  r = await call('POST', `/api/parent/children/${cancelKid}/pay`, { amount: 700, phone: '0799 000 777' }, jane);
  check('cancel: a request for the second child is sent', r.status === 200 && r.body.status === 'sent', r);
  const reqC = r.body.request_id; const urlC = cbUrl(reqC); const ckC = await checkoutOf(reqC);
  r = await call('POST', `/api/parent/children/${cancelKid}/pay`, { amount: 100, phone: '0799 000 777' }, jane);
  check('cancel: while it is open a second tap is refused', r.status === 409 && /already open/.test(r.body.error), r);
  r = await call('POST', `/api/parent/children/${amina}/pay/${reqC}/cancel`, undefined, jane);
  check('cancel: the same request under my OTHER child does nothing', r.status === 200 && r.body.cancelled === false && (await one('SELECT status FROM stk_requests WHERE id = $1', [reqC])).status === 'sent', r);
  r = await call('POST', `/api/parent/children/${cancelKid}/pay/${reqC}/cancel`, undefined, peter);
  check('cancel: a parent who is not linked to the child is refused', r.status === 404 && (await one('SELECT status FROM stk_requests WHERE id = $1', [reqC])).status === 'sent', r);
  r = await call('POST', `/api/parent/children/${cancelKid}/pay/${reqC}/cancel`, undefined, null);
  check('cancel: needs a sign-in', r.status === 401, r);
  r = await call('POST', `/api/parent/children/${cancelKid}/pay/${reqC}/cancel`, undefined, jane);
  check('cancel: my own open request is cancelled', r.status === 200 && r.body.cancelled === true && (await one('SELECT status FROM stk_requests WHERE id = $1', [reqC])).status === 'cancelled', r);
  r = await call('POST', `/api/parent/children/${cancelKid}/pay/${reqC}/cancel`, undefined, jane);
  check('cancel: pressing it twice is harmless', r.status === 200 && r.body.cancelled === false, r);
  r = await call('POST', `/api/parent/children/${cancelKid}/pay`, { amount: 100, phone: '0799 000 778' }, jane);
  check('cancel: the student is free again straight away (no 2 minute wait)', r.status === 200 && r.body.status === 'sent', r);
  const reqD = r.body.request_id;
  r = await call('POST', urlC.path, cbBody(ckC, { amount: 700, receipt: 'LATE0CANCEL', phone: 254712345678 }));
  check('cancel: if the parent still pays the cancelled prompt, the money is booked, not lost', r.status === 200 && (await one("SELECT amount FROM transactions WHERE source = 'mpesa' AND external_ref = 'LATE0CANCEL' AND matched_student_id = $1", [cancelKid])) && (await one('SELECT status FROM stk_requests WHERE id = $1', [reqC])).status === 'paid', r);

  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('TEST CRASHED:', e); process.exit(1); });