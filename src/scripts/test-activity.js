// Tests the Activity log (src/services/activityLog.js + routes/activityRoutes.js + the new log lines).
// REAL Postgres. WIPES the database it connects to; refuses unless the name ends with _test.
//   set TEST_DATABASE_URL=postgres://user:password@localhost:5432/karo_test
//   node src/scripts/test-activity.js
const crypto = require('crypto');
const url = process.env.TEST_DATABASE_URL || '';
if (!/\/[^/]*_test(\?.*)?$/.test(url)) { console.error('Set TEST_DATABASE_URL to a database whose name ends with _test (it is WIPED).'); process.exit(1); }
process.env.DATABASE_URL = url;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { pool, initSchema } = require('../db/db');
const act = require('../services/activityLog');
const sa = require('../services/staffAdmin');
const sheet = require('../services/studentSheet');
const fees = require('../services/feeSetup');
const { createSchoolWithAdmin } = require('../services/schoolSetup');
const { admitStudent } = require('../services/studentAdmission');
const { logAudit } = require('../services/audit');
const { hashPassword } = require('../security/auth');

let failed = 0, passed = 0;
const check = (name, ok, extra) => { if (ok) passed++; else failed++; console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (!ok && extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); };
const fails = async (fn, re) => { try { await fn(); return false; } catch (e) { return re.test(e.message); } };
const q = async (sql, p) => (await pool.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];

(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await initSchema();
  await q(`INSERT INTO schools (name) VALUES ('Other School')`);
  const made = await createSchoolWithAdmin({ name: 'Mwangaza Academy', adminName: 'Olive Owner', adminEmail: 'olive@m.ke', password: 'Owner-pass-1', channels: [] });
  const S = made.school.id, owner = made.admin.id;
  const ann = (await q(`INSERT INTO staff (school_id, full_name, email, password_hash, role, status) VALUES ($1, 'Ann Bursar', 'ann@m.ke', $2, 'staff', 'active') RETURNING id`, [S, await hashPassword('Ann-pass-123')]))[0].id;
  const C = Object.fromEntries((await q('SELECT id, name FROM classes')).map((r) => [r.name, r.id]));
  for (const n of ['Grade 1']) await q('INSERT INTO school_classes (school_id, class_id, enabled) VALUES ($1,$2,TRUE)', [S, C[n]]);
  const y = (await q(`INSERT INTO academic_years (year, is_current) VALUES (EXTRACT(YEAR FROM CURRENT_DATE), TRUE) RETURNING id`))[0].id;
  await q(`INSERT INTO terms (academic_year_id, term_number) VALUES ($1,1),($1,2),($1,3)`, [y]);
  const T = Object.fromEntries((await q('SELECT id, term_number FROM terms')).map((r) => [r.term_number, r.id]));
  await q(`INSERT INTO school_term_dates (school_id, term_id, start_date, end_date) VALUES ($1,$2,CURRENT_DATE-20,CURRENT_DATE+60)`, [S, T[2]]);
  await fees.setFees(S, { classNames: ['Grade 1'], terms: [1, 2, 3], fees: ['Tuition=50000'], optional: [], newOptional: false });
  const adm = await admitStudent(S, { admissionNo: '101', fullName: 'Amina Wanjiru', classId: C['Grade 1'], contacts: [{ name: 'Jane', phone: '0712345678', relationship: 'Mother' }] });
  const sid = adm.student.id;
  await sheet.recordManualPayment(S, sid, { amount: 5000, method: 'cash', reference: 'SLIP9', requestId: crypto.randomUUID() }, { staffId: ann });
  const pay2 = await sheet.recordManualPayment(S, sid, { amount: 1500, method: 'cash', requestId: crypto.randomUUID() }, { staffId: ann });
  await sheet.reverseManualPayment(S, pay2.transaction_id, { reason: 'typed twice' }, { staffId: owner });
  await sa.inviteStaff({ schoolId: S, actorId: owner, fullName: 'Ben Clerk', email: 'ben@m.ke' }, { sendMail: async () => ({ sent: true }) });
  await logAudit({ schoolId: S, staffId: ann, action: 'login' });
  await logAudit({ schoolId: S, staffId: ann, action: 'login_failed' });
  await logAudit({ schoolId: S, action: 'term_billed', detail: { term: 'Term 2 2026', classes: [{ class: 'Grade 1', students: 1 }], total_fees: 50000 } });
  await logAudit({ schoolId: 1, staffId: null, action: 'manual_payment_added', detail: { amount: 999, student_id: 1 } });          // another school
  await logAudit({ schoolId: S, staffId: owner, action: 'some_future_action' });

  // ---- reading
  const all = await act.listActivity(S, { range: 'all' });
  const texts = all.rows.map((r) => (r.who.name + ' ' + r.text + ' ' + (r.extra || '')));
  const hasText = (re) => texts.some((t) => re.test(t));
  check('newest first', all.rows.every((r, i) => i === 0 || all.rows[i - 1].id > r.id));
  check('a payment reads in plain words with the student name, method and receipt', hasText(/Ann Bursar recorded KES 5,000 \(cash\) for Amina Wanjiru.*Receipt RCP-\d+.*Ref SLIP9/), texts);
  check('a reversal says who, amount, student and the reason', hasText(/Olive Owner reversed the KES 1,500 payment for Amina Wanjiru.*typed twice/), texts);
  check('an invite names the invited person', hasText(/Olive Owner invited Ben Clerk to join as Staff/), texts);
  check('the first admin shows as Main Admin, others as Staff', all.rows.find((r) => r.who.name === 'Olive Owner').who.label === 'Main Admin' && all.rows.find((r) => r.who.name === 'Ann Bursar').who.label === 'Staff');
  check('admission is in the log in words', hasText(/admitted Amina Wanjiru to Grade 1/), texts);
  check('automatic billing shows as System with the totals', hasText(/System Billed Term 2 2026 automatically.*1 class.*1 student.*KES 50,000/), texts);
  check('an unknown action still shows (readable), never crashes', hasText(/some future action/));
  check('another school\'s lines never appear', !all.rows.some((r) => /999/.test(r.text)) && !hasText(/KES 999/));
  check('sign-ins are hidden by default, wrong passwords are not', !all.rows.some((r) => r.action === 'login') && all.rows.some((r) => r.action === 'login_failed'));
  check('"show sign-ins" brings them back', (await act.listActivity(S, { range: 'all', signIns: true })).rows.some((r) => r.action === 'login'));
  check('bad things are marked (reversal, wrong password)', all.rows.find((r) => r.action === 'login_failed').tone === 'bad' && all.rows.find((r) => r.action === 'manual_payment_reversed').tone === 'bad');
  check('payment lines can open the student', all.rows.find((r) => r.action === 'manual_payment_added').student_id === sid);
  check('groups filter: Money only has money lines', (await act.listActivity(S, { range: 'all', group: 'money' })).rows.every((r) => r.group === 'money') && (await act.listActivity(S, { range: 'all', group: 'money' })).rows.length === 3);
  check('group Sign-ins shows only sign-ins', (await act.listActivity(S, { range: 'all', group: 'signins' })).rows.every((r) => r.action === 'login'));
  check('filter by person', (await act.listActivity(S, { range: 'all', staffId: ann })).rows.every((r) => r.who.id === ann));
  check('search by student name finds their lines', (await act.listActivity(S, { range: 'all', q: 'amina' })).rows.length >= 3);
  check('search by receipt number', (await act.listActivity(S, { range: 'all', q: 'RCP-' })).rows.length >= 2);
  check('search by a person (as the one acted on) finds the invite', (await act.listActivity(S, { range: 'all', q: 'ben clerk' })).rows.some((r) => r.action === 'staff_invited'));
  check('search with % or _ is taken literally', (await act.listActivity(S, { range: 'all', q: '%' })).rows.length === 0);
  check('dates: today has everything, a past window nothing', (await act.listActivity(S, { range: 'today' })).rows.length === all.rows.length && (await act.listActivity(S, { range: 'custom', from: '2020-01-01', to: '2020-01-31' })).rows.length === 0);
  check('"this term" works with the school\'s own term', (await act.listActivity(S, { range: 'term' })).rows.length === all.rows.length);
  check('a bad date is ignored, not an error', (await act.listActivity(S, { range: 'custom', from: 'garbage', to: "'; DROP TABLE x;--" })).rows.length === all.rows.length);
  // paging
  for (let i = 0; i < 95; i++) await logAudit({ schoolId: S, staffId: owner, action: 'channels_changed', detail: { selected: ['mpesa'] } });
  const p1 = await act.listActivity(S, { range: 'all', limit: 40 });
  const p2 = await act.listActivity(S, { range: 'all', limit: 40, before: p1.next });
  const p3 = await act.listActivity(S, { range: 'all', limit: 40, before: p2.next });
  const seen = new Set([...p1.rows, ...p2.rows, ...p3.rows].map((r) => r.id));
  check('paging walks the whole log once, no repeats, then stops', p1.rows.length === 40 && p2.rows.length === 40 && seen.size === p1.rows.length + p2.rows.length + p3.rows.length && p3.next === null && seen.size >= 100, [p1.rows.length, p2.rows.length, p3.rows.length, p3.next]);
  check('the page also returns the people list and groups for the filters', p1.people.some((x) => x.name === 'Ann Bursar') && p1.groups.length === 6);

  // ---- describe covers every action that exists in the code
  const fs = require('fs'), path = require('path');
  const used = new Set();
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => { const f = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'scripts') walk(f); } else if (f.endsWith('.js')) for (const m of fs.readFileSync(f, 'utf8').matchAll(/action:\s*'([a-z_]+)'/g)) used.add(m[1]); });
  walk(path.join(__dirname, '..'));
  ['credentials_rotated', 'credentials_created', 'student_marked_left', 'student_returned', 'mpesa_keys_replaced'].forEach((a) => used.add(a));
  const missing = [...used].filter((a) => !act.GROUP_OF[a] && !['repeat', 'promote', 'graduate', 'leave'].includes(a));
  check('every action the app writes has a group (so it is findable)', missing.length === 0, missing);

  // ---- tamper-proof
  const line = await one('SELECT id FROM audit_log LIMIT 1');
  check('a log line can not be edited', await fails(() => pool.query(`UPDATE audit_log SET action = 'x' WHERE id = $1`, [line.id]), /can.?not|not allowed|append|change/i));
  check('a log line can not be deleted', await fails(() => pool.query(`DELETE FROM audit_log WHERE id = $1`, [line.id]), /can.?not|not allowed|append|change/i));

  // ---- through the real server: who may look, confirm/reject lines, failed sign-in line
  const app = require('../app');
  const server = app.listen(0); const base = 'http://localhost:' + server.address().port + '/api';
  const call = async (m, p, body, tk) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: body ? JSON.stringify(body) : undefined }); let d = null; try { d = await r.json(); } catch (e) { /* none */ } return { s: r.status, d }; };
  const adminTok = (await call('POST', '/auth/login', { email: 'olive@m.ke', password: 'Owner-pass-1' })).d.token;
  const staffTok = (await call('POST', '/auth/login', { email: 'ann@m.ke', password: 'Ann-pass-123' })).d.token;
  check('an Admin can read the log over the API', (await call('GET', '/schools/' + S + '/activity?range=all', null, adminTok)).d.rows.length > 0);
  check('a staff-role person can not', (await call('GET', '/schools/' + S + '/activity?range=all', null, staffTok)).s === 403);
  check('another school\'s Admin can not read this log', (await call('GET', '/schools/1/activity', null, adminTok)).s === 403);
  await call('POST', '/auth/login', { email: 'ann@m.ke', password: 'wrong-wrong' });
  check('a wrong password on a real account is logged; on a fake email it is not', (await q(`SELECT 1 FROM audit_log WHERE action = 'login_failed' AND staff_id = $1`, [ann])).length >= 2 && (await call('POST', '/auth/login', { email: 'ghost@nowhere.ke', password: 'x12345678' })).s === 401 && (await q(`SELECT 1 FROM audit_log WHERE action = 'login_failed' AND staff_id IS NULL`)).length === 0);
  const t1 = (await q(`INSERT INTO transactions (school_id, term_id, source, external_ref, amount, payer_name, narration, match_status) VALUES ($1,$2,'mpesa','R1',8000,'Jane W','ADM 101','needs_review') RETURNING id`, [S, T[2]]))[0].id;
  const t2 = (await q(`INSERT INTO transactions (school_id, term_id, source, external_ref, amount, payer_name, narration, match_status) VALUES ($1,$2,'mpesa','R2',300,'Unknown','??','unmatched') RETURNING id`, [S, T[2]]))[0].id;
  check('confirming a payment works', (await call('POST', '/transactions/' + t1 + '/confirm', { student_id: sid }, staffTok)).s === 200);
  check('rejecting a payment works', (await call('POST', '/transactions/' + t2 + '/reject', {}, staffTok)).s === 200);
  const after = (await act.listActivity(S, { range: 'all', group: 'money' })).rows.map((r) => r.who.name + ' ' + r.text);
  check('confirm and reject are now in the log, in words', after.some((t) => /Ann Bursar confirmed KES 8,000 from Jane W to Amina Wanjiru/.test(t)) && after.some((t) => /Ann Bursar rejected KES 300 from Unknown/.test(t)), after);
  check('a repeat confirm (refused) adds no second line', (await call('POST', '/transactions/' + t1 + '/confirm', { student_id: sid }, staffTok)).s === 409 && (await q(`SELECT 1 FROM audit_log WHERE action = 'payment_confirmed'`)).length === 1);
  server.close();

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  await pool.end();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });