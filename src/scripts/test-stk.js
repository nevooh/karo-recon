// Tests the STK push rules (services/stkPush.js) against a REAL Postgres. Safaricom (axios) is faked.
// It WIPES the database it connects to, so it refuses to run unless the database name ends with _test.
//   Windows CMD:   set TEST_DATABASE_URL=postgres://user:password@localhost:5432/karo_test
//                  node src/scripts/test-stk.js
const crypto = require('crypto');
const url = process.env.TEST_DATABASE_URL || '';
if (!/\/[^/]*_test(\?.*)?$/.test(url)) {
  console.error('Set TEST_DATABASE_URL to a database whose name ends with _test (it is WIPED). Example: postgres://user:password@localhost:5432/karo_test');
  process.exit(1);
}
process.env.DATABASE_URL = url;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.PUBLIC_BASE_URL = 'https://pay.example.com';

const axios = require('axios');
const { pool, initSchema } = require('../db/db');
const { encrypt } = require('../security/crypto');
const { savePasskey } = require('../services/mpesaPasskey');
const { createPush, getPushStatus, MAX_AMOUNT, sha256 } = require('../services/stkPush');

let passed = 0, failed = 0;
const check = (name, ok, extra) => { if (ok) passed++; else failed++; console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (!ok && extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); };
const q = async (sql, p) => (await pool.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];
const rejects = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const fails = async (fn, re, status) => { const e = await rejects(fn); return !!(e && re.test(e.message) && (status == null || e.status === status)); };

// Safaricom pretend: every push is accepted unless `pushReply` says otherwise. `posts` records what was sent.
let posts = [], pushReply = null, n = 0, slow = 0;
axios.get = async () => ({ data: { access_token: 'tok', expires_in: '3599' } });
axios.post = async (u, body) => {
  posts.push({ u, body });
  if (slow) await new Promise((r) => setTimeout(r, slow));
  if (pushReply) { const r = pushReply; if (r instanceof Error) throw r; return { data: r }; }
  n++; return { data: { MerchantRequestID: 'm-' + n, CheckoutRequestID: 'ws_CO_' + n, ResponseCode: '0', ResponseDescription: 'Success', CustomerMessage: 'ok' } };
};
const httpErr = (status, data) => { const e = new Error('http ' + status); e.response = { status, data }; return e; };
const PASSKEY = 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919';

async function reset() {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await initSchema();
  const mk = async (name, code, key) => (await one(`INSERT INTO schools (name, mpesa_shortcode, mpesa_consumer_key_enc, mpesa_consumer_secret_enc) VALUES ($1, $2, $3, $4) RETURNING id`, [name, code, key ? encrypt(key) : null, key ? encrypt('sec-' + key) : null])).id;
  const A = await mk('Alpha High', '400200', 'ck-alpha'), B = await mk('Beta High', '400300', 'ck-beta'), C = await mk('Gamma High', '400400', 'ck-gamma');
  await savePasskey(A, PASSKEY); await savePasskey(C, PASSKEY);                       // Beta has no passkey
  for (const s of [A, B]) await q(`INSERT INTO school_channels (school_id, channel) VALUES ($1, 'mpesa')`, [s]);   // Gamma has M-Pesa hidden
  const st = async (sid, adm, status = 'active') => (await one(`INSERT INTO students (school_id, admission_no, full_name, status) VALUES ($1, $2, $3, $4) RETURNING id`, [sid, adm, 'Student ' + adm, status])).id;
  return {
    A, B, C,
    s1: await st(A, 'ADM101'), s2: await st(A, 'ADM102'), s3: await st(A, 'ADM103'), s4: await st(A, 'ADM104'), s5: await st(A, 'ADM105'), s6: await st(A, 'ADM106'), s7: await st(A, 'ADM107'),
    left: await st(A, 'ADM199', 'transferred_out'), rep: await st(A, 'ADM198', 'repeating'), long: await st(A, 'ADM/2026/000343'),
    beta: await st(B, 'ADM201'), gamma: await st(C, 'ADM301'),
  };
}

(async () => {
  const W = await reset();
  const push = (o) => createPush({ schoolId: W.A, studentId: W.s1, phone: '0712 345 678', amount: 1500, ...o });

  // --- a good push
  const r = await push({});
  const row = await one('SELECT * FROM stk_requests WHERE id = $1', [r.requestId]);
  const sent = posts.find((p) => p.u.endsWith('/stkpush/v1/processrequest')).body;
  check('good push: answer says sent', r.status === 'sent' && /PIN/.test(r.message), r);
  check('good push: row saved as sent with Safaricom ids', row.status === 'sent' && row.checkout_request_id === 'ws_CO_1' && row.merchant_request_id === 'm-1', row);
  check('good push: phone, amount, admission number saved', row.phone === '254712345678' && Number(row.amount) === 1500 && row.account_ref === 'ADM101', row);
  check('good push: Safaricom got the school\'s Paybill, amount and admission number', sent.BusinessShortCode === '400200' && sent.Amount === 1500 && sent.AccountReference === 'ADM101', sent);
  const m = sent.CallBackURL.match(/^https:\/\/pay\.example\.com\/webhooks\/stk\/(\d+)\/([0-9a-f]{40})\/result$/);
  check('callback address has the request number and a 40 character secret', !!m && Number(m[1]) === r.requestId, sent.CallBackURL);
  check('only the fingerprint of the secret is stored', m && row.callback_token_hash === sha256(m[2]) && !JSON.stringify(row).includes(m[2]));
  check('passkey is not in the row', !JSON.stringify(row).includes(PASSKEY));
  check('push to a repeating student works', !!(await createPush({ schoolId: W.A, studentId: W.rep, phone: '0722000001', amount: 100 })).requestId);

  // --- refused before anything is sent
  const before = posts.length;
  const noPush = async (label, o, re, status) => check('refused: ' + label, await fails(() => push(o), re, status));
  await noPush('amount 0', { studentId: W.s2, amount: 0 }, /whole number/, 400);
  await noPush('amount with cents', { studentId: W.s2, amount: 99.5 }, /whole number/, 400);
  await noPush('amount over the limit', { studentId: W.s2, amount: MAX_AMOUNT + 1 }, /most you can pay/, 400);
  await noPush('phone not Safaricom', { studentId: W.s2, phone: '0812345678' }, /Safaricom number/, 400);
  await noPush('student of another school', { studentId: W.beta }, /No such student/, 404);
  await noPush('student who left', { studentId: W.left }, /in school now/, 409);
  await noPush('admission number over 12 characters', { studentId: W.long }, /12 characters/);
  await noPush('unknown school', { schoolId: 9999 }, /No such school/, 404);
  check('refused: school without a passkey', await fails(() => createPush({ schoolId: W.B, studentId: W.beta, phone: '0712345678', amount: 100 }), /not switched on/, 409));
  check('refused: school with M-Pesa hidden', await fails(() => createPush({ schoolId: W.C, studentId: W.gamma, phone: '0712345678', amount: 100 }), /not switched on/, 409));
  check('refused: nothing was sent to Safaricom', posts.length === before);
  check('refused: nothing was saved', (await one(`SELECT COUNT(*)::int AS n FROM stk_requests WHERE student_id IN ($1, $2, $3)`, [W.s2, W.left, W.beta])).n === 0);
  check('limit amount itself is allowed', !!(await push({ studentId: W.s2, phone: '0733000002', amount: MAX_AMOUNT })).requestId);

  // --- the public address must be usable
  check('refused: public address not usable', await fails(() => createPush({ schoolId: W.A, studentId: W.s3, phone: '0744000003', amount: 100 }, { baseUrl: 'http://localhost:3000' }), /not available right now/, 503));

  // --- one open request per student
  const again = await rejects(() => push({}));
  check('second request for the same student is refused', !!again && again.status === 409 && /already open/.test(again.message), again && again.message);
  await q(`UPDATE stk_requests SET created_at = NOW() - INTERVAL '3 minutes' WHERE student_id = $1`, [W.s1]);
  check('after 2 minutes a new request is allowed', !!(await push({ phone: '0712345678' })).requestId);

  // --- two taps at the same moment
  slow = 150;
  const postsBefore = posts.length;
  const both = await Promise.allSettled([push({ studentId: W.s4, phone: '0755000004' }), push({ studentId: W.s4, phone: '0755000004' })]);
  slow = 0;
  check('two taps at once: exactly one goes through', both.filter((x) => x.status === 'fulfilled').length === 1 && both.filter((x) => x.status === 'rejected' && x.reason.status === 409).length === 1, both.map((x) => x.status));
  check('two taps at once: Safaricom was asked once and one row saved', posts.slice(postsBefore).filter((p) => p.u.endsWith('processrequest')).length === 1 && (await one(`SELECT COUNT(*)::int AS n FROM stk_requests WHERE student_id = $1`, [W.s4])).n === 1);

  // --- one phone cannot be flooded
  const flood = '0766000009';
  for (const s of [W.s5, W.s6, W.s3]) await push({ studentId: s, phone: flood, amount: 50 });
  check('4th request to the same phone in 10 minutes is refused', await fails(() => push({ studentId: W.s7, phone: flood, amount: 50 }), /Too many requests/, 429));

  // --- Safaricom says no
  await q(`UPDATE stk_requests SET created_at = NOW() - INTERVAL '30 minutes'`);
  pushReply = httpErr(500, { errorCode: '500.001.1001', errorMessage: 'Unable to lock subscriber' });
  const busy = await rejects(() => push({ studentId: W.s1, phone: '0777000001' }));
  const brow = await one(`SELECT * FROM stk_requests WHERE phone = '254777000001'`);
  check('phone busy: parent gets a 409 and a plain message', !!busy && busy.status === 409 && /already has an M-Pesa request open/.test(busy.message), busy && busy.message);
  check('phone busy: row is failed with no result code and no checkout id', brow.status === 'failed' && brow.result_code === null && brow.checkout_request_id === null && !!brow.finished_at, brow);
  check('failed push does not block the next try', (pushReply = null, !!(await push({ studentId: W.s1, phone: '0777000001' })).requestId));
  pushReply = new Error('socket hang up');
  const down = await rejects(() => push({ studentId: W.s2, phone: '0788000002' }));
  check('Safaricom unreachable: plain message, row failed', !!down && /Could not reach Safaricom/.test(down.message) && (await one(`SELECT status FROM stk_requests WHERE phone = '254788000002'`)).status === 'failed');
  pushReply = null;

  // --- the portal polling
  const fresh = await push({ studentId: W.s6, phone: '0799000006', amount: 700 });
  const st = await getPushStatus(fresh.requestId, W.A, W.s6);
  check('status: sent, amount, no receipt yet', st.status === 'sent' && st.amount === 700 && st.receipt === null && /PIN/.test(st.message), st);
  await q(`UPDATE stk_requests SET status = 'paid', mpesa_receipt = 'SKR4T8W2QA' WHERE id = $1`, [fresh.requestId]);
  const paid = await getPushStatus(fresh.requestId, W.A, W.s6);
  check('status: paid shows the receipt', paid.status === 'paid' && paid.receipt === 'SKR4T8W2QA' && /received/.test(paid.message), paid);
  check('status: wrong student cannot see it', await fails(() => getPushStatus(fresh.requestId, W.A, W.s5), /No such payment request/, 404));
  check('status: wrong school cannot see it', await fails(() => getPushStatus(fresh.requestId, W.B, W.s6), /No such payment request/, 404));
  check('status: unknown number', await fails(() => getPushStatus(987654, W.A, W.s6), /No such payment request/, 404));
  await q(`UPDATE stk_requests SET status = 'failed' WHERE id = $1`, [fresh.requestId]);
  check('status: failed says no money was taken', /No money was taken/.test((await getPushStatus(fresh.requestId, W.A, W.s6)).message));

  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error('ERROR', e); try { await pool.end(); } catch (x) {} process.exit(1); });