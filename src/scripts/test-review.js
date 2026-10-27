// Tests the REVIEW QUEUE end to end: payments come in, land in the right
// queue, a person confirms/rejects them, and balances move correctly.
//
// Before running:
//   1. node src/scripts/test-setup.js "green park"      (creates school + 5 students)
//   2. npm start                                         (in another CMD window)
// Then:
//   node src/scripts/test-review.js "green park"
// Optional login:  node src/scripts/test-review.js "green park" me@test.com mypassword1
//
// Safe to run many times: every run uses brand-new payment ids.
// It only ADDS test payments - it never deletes anything.
require('dotenv').config();
const axios = require('axios');
const { pool } = require('../db/db');
const { hashPassword } = require('../security/auth');
const { createSchoolWithCredentials } = require('../services/schoolCredentials');

const schoolName = process.argv[2] || 'Test High School';
const email = process.argv[3] || 'admin@test.com';
const password = process.argv[4] || 'test1234';
const BASE = `http://localhost:${process.env.PORT || 3000}`;
const http = axios.create({ baseURL: BASE, validateStatus: () => true, timeout: 10000 });

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra !== undefined ? '-> ' + JSON.stringify(extra) : ''); }
}
const section = (t) => console.log('\n' + t);
const auth = (token) => ({ headers: { Authorization: 'Bearer ' + token } });

async function login(em, pw) {
  const r = await http.post('/api/auth/login', { email: em, password: pw });
  return r;
}

async function sendPayment(shortcode, id, amount, ref, extra) {
  return http.post('/webhooks/mpesa/confirmation', Object.assign({
    TransID: id, TransAmount: String(amount), BusinessShortCode: shortcode, BillRefNumber: ref,
  }, extra || {}));
}

async function findTxn(schoolId, externalRef) {
  const r = await pool.query('SELECT * FROM transactions WHERE school_id = $1 AND external_ref = $2', [schoolId, externalRef]);
  return r.rows[0];
}

async function paidFor(schoolId, admissionNo, token) {
  const r = await http.get(`/api/schools/${schoolId}/students?q=${encodeURIComponent(admissionNo)}&limit=200`, auth(token));
  const row = (r.data.rows || []).find((s) => s.admission_no === admissionNo);
  return row ? row.amount_paid : null;
}

async function main() {
  // ---- find the school made by test-setup.js ----
  const school = (await pool.query('SELECT id, name, mpesa_shortcode FROM schools WHERE name = $1', [schoolName])).rows[0];
  if (!school) {
    console.error(`No school called "${schoolName}". Run first: node src/scripts/test-setup.js "${schoolName}"`);
    process.exit(1);
  }
  const sid = school.id;
  const shortcode = school.mpesa_shortcode;
  const stamp = Date.now().toString().slice(-7);

  // is the server up?
  const ping = await http.post('/api/auth/login', {}).catch(() => null);
  if (!ping) {
    console.error(`Cannot reach the server at ${BASE}. Start it in another CMD window with: npm start`);
    process.exit(1);
  }

  // ---------------------------------------------------------------
  section('1. LOGIN');
  const bad = await login(email, 'definitely-wrong-password');
  check('wrong password -> 401', bad.status === 401, bad.status);
  const good = await login(email, password);
  check('correct login -> token', good.status === 200 && !!good.data.token, good.status);
  if (!good.data.token) { console.error('Cannot continue without a login.'); process.exit(1); }
  const token = good.data.token;

  // ---------------------------------------------------------------
  section('2. PAYMENTS ARRIVE AND LAND IN THE RIGHT PLACE');
  const idAuto = 'T1' + stamp, idTwo = 'T2' + stamp, idName = 'T3' + stamp, idEmpty = 'T4' + stamp;
  const before = {
    jane: await paidFor(sid, 'ADM101', token),
    brian: await paidFor(sid, 'ADM201', token),
    cynthia: await paidFor(sid, 'ADM202', token),
    mary: await paidFor(sid, '356', token),
  };

  const r1 = await sendPayment(shortcode, idAuto, 1500, 'ADM101');
  check('webhook answers Accepted', r1.status === 200 && r1.data.ResultCode === 0, r1.data);
  await sendPayment(shortcode, idTwo, 1111, 'ADM201 and ADM202');
  await sendPayment(shortcode, idName, 2222, 'Mary Akinyi school fees', { MSISDN: '254700111222', FirstName: 'Peter', LastName: 'Mwangi' });
  await sendPayment(shortcode, idEmpty, 3333, '');

  const tAuto = await findTxn(sid, idAuto), tTwo = await findTxn(sid, idTwo);
  const tName = await findTxn(sid, idName), tEmpty = await findTxn(sid, idEmpty);
  check('clean reference -> auto_matched', tAuto && tAuto.match_status === 'auto_matched', tAuto && tAuto.match_status);
  check('two students in one reference -> needs_review', tTwo && tTwo.match_status === 'needs_review', tTwo && tTwo.match_status);
  check('needs_review keeps BOTH candidates', tTwo && Array.isArray(tTwo.candidates) && tTwo.candidates.length === 2, tTwo && tTwo.candidates);
  check('needs_review has no student picked yet', tTwo && tTwo.matched_student_id === null);
  check('name only -> unmatched', tName && tName.match_status === 'unmatched', tName && tName.match_status);
  check('empty reference -> unmatched', tEmpty && tEmpty.match_status === 'unmatched', tEmpty && tEmpty.match_status);
  check('auto-match added 1500 to Jane', (await paidFor(sid, 'ADM101', token)) === before.jane + 1500);
  check('needs_review did NOT touch Brian or Cynthia',
    (await paidFor(sid, 'ADM201', token)) === before.brian && (await paidFor(sid, 'ADM202', token)) === before.cynthia);

  const countBefore = (await pool.query('SELECT COUNT(*)::int AS n FROM transactions WHERE school_id = $1', [sid])).rows[0].n;
  await sendPayment(shortcode, idTwo, 1111, 'ADM201 and ADM202');   // same id again
  const countAfter = (await pool.query('SELECT COUNT(*)::int AS n FROM transactions WHERE school_id = $1', [sid])).rows[0].n;
  check('same payment sent twice is ignored', countAfter === countBefore, { countBefore, countAfter });

  // ---------------------------------------------------------------
  section('3. THE SCREENS\' DATA (queues)');
  const q = await http.get(`/api/schools/${sid}/review-queue`, auth(token));
  check('review queue loads', q.status === 200 && Array.isArray(q.data), q.status);
  check('two-student payment is in the review queue', q.data.some((t) => t.id === tTwo.id));
  check('auto-matched payment is NOT in the review queue', !q.data.some((t) => t.id === tAuto.id));
  const u = await http.get(`/api/schools/${sid}/unmatched`, auth(token));
  check('name-only payment is in unmatched', u.data.some((t) => t.id === tName.id));
  check('empty-reference payment is in unmatched', u.data.some((t) => t.id === tEmpty.id));

  // ---------------------------------------------------------------
  section('4. CONFIRM - the rules');
  const noToken = await http.post(`/api/transactions/${tTwo.id}/confirm`, { student_id: 1 });
  check('confirm without login -> 401', noToken.status === 401, noToken.status);

  const noStudent = await http.post(`/api/transactions/${tTwo.id}/confirm`, {}, auth(token));
  check('confirm without choosing a student -> 400', noStudent.status === 400, noStudent.data);

  const fakeStudent = await http.post(`/api/transactions/${tTwo.id}/confirm`, { student_id: 99999999 }, auth(token));
  check('confirm with a student that does not exist -> 400', fakeStudent.status === 400, fakeStudent.data);

  const missing = await http.post(`/api/transactions/99999999/confirm`, { student_id: 1 }, auth(token));
  check('confirm a payment that does not exist -> 404', missing.status === 404, missing.status);

  const stillWaiting = await findTxn(sid, idTwo);
  check('failed confirms changed nothing', stillWaiting.match_status === 'needs_review');

  // other school must not be able to touch this payment
  let otherSchool = (await pool.query(`SELECT id FROM schools WHERE name = 'Other School (review test)'`)).rows[0];
  if (!otherSchool) {
    try {
      otherSchool = await createSchoolWithCredentials({
        name: 'Other School (review test)', mpesaShortcode: '600999', mpesaConsumerKey: 'k', mpesaConsumerSecret: 's',
      });
    } catch (e) { otherSchool = null; }
  }
  if (otherSchool) {
    const hash = await hashPassword('other1234');
    await pool.query(
      `INSERT INTO staff (school_id, full_name, email, password_hash) VALUES ($1, 'Other Admin', 'other@test.com', $2)
       ON CONFLICT (school_id, email) DO UPDATE SET password_hash = $2, status = 'active'`, [otherSchool.id, hash]);
    const other = await login('other@test.com', 'other1234');
    if (other.data.token) {
      const c = await http.post(`/api/transactions/${tTwo.id}/confirm`, { student_id: 1 }, auth(other.data.token));
      const rj = await http.post(`/api/transactions/${tTwo.id}/reject`, {}, auth(other.data.token));
      check("another school's staff cannot confirm this payment -> 403", c.status === 403, c.status);
      check("another school's staff cannot reject this payment -> 403", rj.status === 403, rj.status);
    }
  } else {
    console.log('  SKIP other-school checks (could not create the second test school)');
  }

  // ---------------------------------------------------------------
  section('5. CONFIRM - the happy path');
  const brianId = (await pool.query('SELECT id FROM students WHERE school_id = $1 AND admission_no = $2', [sid, 'ADM201'])).rows[0].id;
  const ok = await http.post(`/api/transactions/${tTwo.id}/confirm`, { student_id: brianId }, auth(token));
  check('confirm with Brian -> ok', ok.status === 200 && ok.data.ok === true, ok.data);
  const done = await findTxn(sid, idTwo);
  check('status is now confirmed', done.match_status === 'confirmed', done.match_status);
  check('payment points at Brian', done.matched_student_id === brianId);
  check('who confirmed it is recorded', !!done.acted_by_staff_id && !!done.acted_at);
  check('Brian got the 1111', (await paidFor(sid, 'ADM201', token)) === before.brian + 1111);
  check('Cynthia got nothing', (await paidFor(sid, 'ADM202', token)) === before.cynthia);

  const again = await http.post(`/api/transactions/${tTwo.id}/confirm`, { student_id: brianId }, auth(token));
  check('confirm the same payment again -> 409', again.status === 409, again.status);
  check('...and Brian was NOT charged twice', (await paidFor(sid, 'ADM201', token)) === before.brian + 1111);

  const q2 = await http.get(`/api/schools/${sid}/review-queue`, auth(token));
  check('confirmed payment left the review queue', !q2.data.some((t) => t.id === tTwo.id));

  // an UNMATCHED payment can be assigned by hand too
  const maryId = (await pool.query('SELECT id FROM students WHERE school_id = $1 AND admission_no = $2', [sid, '356'])).rows[0].id;
  const byHand = await http.post(`/api/transactions/${tName.id}/confirm`, { student_id: maryId }, auth(token));
  check('unmatched payment assigned to Mary by hand -> ok', byHand.status === 200, byHand.data);
  check('Mary got the 2222', (await paidFor(sid, '356', token)) === before.mary + 2222);
  const u2 = await http.get(`/api/schools/${sid}/unmatched`, auth(token));
  check('it left the unmatched list', !u2.data.some((t) => t.id === tName.id));

  // ---------------------------------------------------------------
  section('6. REJECT');
  const janeNow = await paidFor(sid, 'ADM101', token);
  const rej = await http.post(`/api/transactions/${tEmpty.id}/reject`, {}, auth(token));
  check('reject an unmatched payment -> ok', rej.status === 200, rej.data);
  check('status is now rejected', (await findTxn(sid, idEmpty)).match_status === 'rejected');
  check('reject changed nobody\'s balance', (await paidFor(sid, 'ADM101', token)) === janeNow);

  const rejNoToken = await http.post(`/api/transactions/${tEmpty.id}/reject`, {});
  check('reject without login -> 401', rejNoToken.status === 401, rejNoToken.status);
  const rejAuto = await http.post(`/api/transactions/${tAuto.id}/reject`, {}, auth(token));
  check('cannot reject an auto-matched payment -> 409', rejAuto.status === 409, rejAuto.status);
  const rejDone = await http.post(`/api/transactions/${tTwo.id}/reject`, {}, auth(token));
  check('cannot reject a confirmed payment -> 409', rejDone.status === 409, rejDone.status);
  const confRej = await http.post(`/api/transactions/${tEmpty.id}/confirm`, { student_id: maryId }, auth(token));
  check('cannot confirm a rejected payment -> 409', confRej.status === 409, confRej.status);

  // ---------------------------------------------------------------
  section('7. SUMMARY');
  const sum = await http.get(`/api/schools/${sid}/summary`, auth(token));
  const by = Object.fromEntries((sum.data || []).map((r) => [r.match_status, Number(r.count)]));
  check('summary loads', sum.status === 200 && Array.isArray(sum.data), sum.status);
  check('summary shows confirmed and rejected payments', (by.confirmed || 0) >= 2 && (by.rejected || 0) >= 1, by);

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch(async (err) => { console.error('Test crashed:', err.message); await pool.end().catch(() => {}); process.exit(1); });
