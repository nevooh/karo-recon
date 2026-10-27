// Tests the Dashboard numbers (src/services/dashboard.js). REAL Postgres, WIPES the _test database.
//   set TEST_DATABASE_URL=postgres://user:password@localhost:5432/karo_test
const crypto = require('crypto');
const url = process.env.TEST_DATABASE_URL || '';
if (!/\/[^/]*_test(\?.*)?$/.test(url)) { console.error('Set TEST_DATABASE_URL to a database whose name ends with _test (it is WIPED).'); process.exit(1); }
process.env.DATABASE_URL = url;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { pool, initSchema } = require('../db/db');
const { getDashboard } = require('../services/dashboard');
const sheet = require('../services/studentSheet');
const fees = require('../services/feeSetup');
const { createSchoolWithAdmin } = require('../services/schoolSetup');
const { admitStudent } = require('../services/studentAdmission');

let failed = 0, passed = 0;
const check = (n, ok, x) => { if (ok) passed++; else failed++; console.log((ok ? 'PASS' : 'FAIL') + ' | ' + n + (!ok && x !== undefined ? '  -> ' + JSON.stringify(x) : '')); };
const q = async (sql, p) => (await pool.query(sql, p)).rows;

(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await initSchema();
  const made = await createSchoolWithAdmin({ name: 'Dash School', adminName: 'Olive Owner', adminEmail: 'o@d.ke', password: 'Owner-pass-1', channels: [] });
  const S = made.school.id, owner = made.admin.id;
  const O = (await q(`INSERT INTO schools (name) VALUES ('Other') RETURNING id`))[0].id;
  const empty = await getDashboard(S);
  check('empty school: no term -> a "set term dates" nudge and an "admit" nudge', empty.term === null && empty.nudges.some((n) => n.kind === 'term_dates') && empty.nudges.some((n) => n.kind === 'no_students'), empty.nudges);
  check('empty school: zeros, no crash', empty.money.billed === 0 && empty.money.percent === 0 && empty.collected.today === 0 && empty.last_payment === null && empty.recent.length === 0 && empty.debtors.length === 0, empty);

  const C = Object.fromEntries((await q('SELECT id, name FROM classes')).map((r) => [r.name, r.id]));
  await q('INSERT INTO school_classes (school_id, class_id, enabled) VALUES ($1,$2,TRUE)', [S, C['Grade 1']]);
  const y = (await q(`INSERT INTO academic_years (year, is_current) VALUES (EXTRACT(YEAR FROM CURRENT_DATE), TRUE) RETURNING id`))[0].id;
  await q(`INSERT INTO terms (academic_year_id, term_number) VALUES ($1,1),($1,2),($1,3)`, [y]);
  const T2 = (await q('SELECT id FROM terms WHERE term_number = 2'))[0].id;
  await q(`INSERT INTO school_term_dates (school_id, term_id, start_date, end_date) VALUES ($1,$2,CURRENT_DATE-20,CURRENT_DATE+60)`, [S, T2]);
  await fees.setFees(S, { classNames: ['Grade 1'], terms: [1, 2, 3], fees: ['Tuition=40000'], optional: [], newOptional: false });
  const adm = async (no, name) => (await admitStudent(S, { admissionNo: no, fullName: name, classId: C['Grade 1'], contacts: [{ name: name + ' P', phone: '0712' + no.padStart(6, '0'), relation: 'Parent' }] })).student.id;
  const a = await adm('101', 'Amina One'), b = await adm('102', 'Brian Two'), c = await adm('103', 'Cate Three');
  await sheet.recordManualPayment(S, a, { amount: 40000, method: 'cash', requestId: crypto.randomUUID() }, { staffId: owner });
  const p2 = await sheet.recordManualPayment(S, b, { amount: 10000, method: 'mpesa', reference: 'ABC123XYZ9', requestId: crypto.randomUUID() }, { staffId: owner });
  const wrong = await sheet.recordManualPayment(S, c, { amount: 700, method: 'cash', requestId: crypto.randomUUID() }, { staffId: owner });
  await sheet.reverseManualPayment(S, wrong.transaction_id, { reason: 'typo' }, { staffId: owner });
  await q(`INSERT INTO transactions (school_id, term_id, source, external_ref, amount, payer_name, match_status) VALUES ($1,$2,'mpesa','RV1',8000,'Jane','needs_review'),($1,$2,'mpesa','UN1',300,'Who','unmatched'),($3,$2,'mpesa','OTHER',999,'X','needs_review')`, [S, T2, O]);
  await q(`UPDATE students SET class_id = NULL WHERE id = $1`, [c]);

  const d = await getDashboard(S);
  check('term is the running one', d.term && /Term 2/.test(d.term.label), d.term);
  check('money: billed 120000, paid 50000, outstanding is only what is owed', d.money.billed === 120000 && d.money.paid === 50000 && d.money.outstanding === 70000, d.money);
  check('collected today = 50000 (the reversed 700 is not counted)', d.collected.today === 50000 && d.collected.week === 50000, d.collected);
  check('waiting counts only this school', d.waiting.review === 1 && d.waiting.unmatched === 1 && d.waiting.review_total === 8000 && d.waiting.rows.length === 2, d.waiting);
  check('needs-review rows come first', d.waiting.rows[0].match_status === 'needs_review');
  check('recent payments: newest first, reversed one left out, student named', d.recent.length === 2 && d.recent[0].student_name === 'Brian Two' && d.recent.every((r) => r.amount !== 700), d.recent);
  check('last payment is the newest', d.last_payment && d.last_payment.student_name === 'Brian Two');
  check('top debtors: only people who owe, biggest first, max 5', d.debtors.length >= 1 && d.debtors.every((r) => r.balance > 0) && d.debtors.every((r, i, arr) => i === 0 || arr[i - 1].balance >= r.balance), d.debtors);
  check('a student without a class gets a nudge (singular)', d.nudges.some((n) => n.kind === 'no_class' && /1 student has no class/.test(n.text)), d.nudges);
  check('percent is between 0 and 100', d.money.percent >= 0 && d.money.percent <= 100, d.money);
  console.log('\n' + passed + ' passed, ' + failed + ' failed'); await pool.end(); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });