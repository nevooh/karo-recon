// Tests the Reports numbers (src/services/reports.js + routes/reportRoutes.js).
// REAL Postgres. WIPES the database it connects to; refuses unless the name ends with _test.
//   set TEST_DATABASE_URL=postgres://user:password@localhost:5432/karo_test
//   node src/scripts/test-reports.js
const crypto = require('crypto');
const url = process.env.TEST_DATABASE_URL || '';
if (!/\/[^/]*_test(\?.*)?$/.test(url)) { console.error('Set TEST_DATABASE_URL to a database whose name ends with _test (it is WIPED).'); process.exit(1); }
process.env.DATABASE_URL = url;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { pool, initSchema } = require('../db/db');
const { getReport } = require('../services/reports');
const { listBalances } = require('../services/balances');
const sheet = require('../services/studentSheet');
const fees = require('../services/feeSetup');
const { createSchoolWithAdmin } = require('../services/schoolSetup');
const { admitStudent } = require('../services/studentAdmission');
const { hashPassword } = require('../security/auth');

let failed = 0, passed = 0;
const check = (name, ok, extra) => { if (ok) passed++; else failed++; console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (!ok && extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); };
const fails = async (fn, re) => { try { await fn(); return false; } catch (e) { return re.test(e.message); } };
const q = async (sql, p) => (await pool.query(sql, p)).rows;

(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await initSchema();
  await q(`INSERT INTO schools (name) VALUES ('Other School')`);                        // school 1
  const made = await createSchoolWithAdmin({ name: 'Mwangaza Academy', adminName: 'Olive Owner', adminEmail: 'olive@m.ke', password: 'Owner-pass-1', channels: [] });
  const S = made.school.id, owner = made.admin.id;
  const ben = (await q(`INSERT INTO staff (school_id, full_name, email, password_hash, role, status) VALUES ($1, 'Ben Clerk', 'ben@m.ke', $2, 'staff', 'active') RETURNING id`, [S, await hashPassword('Ben-pass-123')]))[0].id;
  const C = Object.fromEntries((await q('SELECT id, name FROM classes')).map((r) => [r.name, r.id]));
  for (const s of [1, S]) for (const n of ['Grade 1', 'Grade 2']) await q('INSERT INTO school_classes (school_id, class_id, enabled) VALUES ($1,$2,TRUE)', [s, C[n]]);
  const y = (await q(`INSERT INTO academic_years (year, is_current) VALUES (EXTRACT(YEAR FROM CURRENT_DATE), TRUE) RETURNING id`))[0].id;
  await q(`INSERT INTO terms (academic_year_id, term_number) VALUES ($1,1),($1,2),($1,3)`, [y]);
  const T = Object.fromEntries((await q('SELECT id, term_number FROM terms')).map((r) => [r.term_number, r.id]));
  // Term 1 ended long ago but has NO figures (school joined Karo later); Term 2 is running.
  await q(`INSERT INTO school_term_dates (school_id, term_id, start_date, end_date) VALUES ($1,$2,CURRENT_DATE-200,CURRENT_DATE-120),($1,$3,CURRENT_DATE-20,CURRENT_DATE+60)`, [S, T[1], T[2]]);
  await q(`INSERT INTO school_term_dates (school_id, term_id, start_date, end_date) VALUES (1,$1,CURRENT_DATE-20,CURRENT_DATE+60)`, [T[2]]);
  await fees.setFees(S, { classNames: ['Grade 1'], terms: [1, 2, 3], fees: ['Tuition=40000'], optional: [], newOptional: false });
  await fees.setFees(S, { classNames: ['Grade 2'], terms: [1, 2, 3], fees: ['Tuition=60000'], optional: [], newOptional: false });
  const adm = async (no, name, cls, bf) => (await admitStudent(S, { admissionNo: no, fullName: name, classId: C[cls], startingBalance: bf, contacts: [{ name: name + ' Parent', phone: '0712' + no.padStart(6, '0'), relationship: 'Mother' }] })).student.id;
  const a = await adm('101', 'Amina One', 'Grade 1'), b = await adm('102', 'Brian Two', 'Grade 1'), c = await adm('103', 'Cate Three', 'Grade 2'), d = await adm('104', 'Dan Four', 'Grade 2');
  const rec = (sid, amount, method) => sheet.recordManualPayment(S, sid, { amount, method, requestId: crypto.randomUUID() }, { staffId: ben });
  await rec(a, 40000, 'cash');                    // Amina fully paid (cash)
  await rec(b, 10000, 'cheque');                  // Brian owes 30,000
  const bank = async (sid, ref, source, amount, daysAgo) => {
    const t = (await q(`INSERT INTO transactions (school_id, term_id, source, external_ref, amount, payer_name, narration, match_status, matched_student_id, received_at) VALUES ($1,$2,$3,$4,$5,'P','x','auto_matched',$6, NOW() - make_interval(days => $7)) RETURNING id`, [S, T[2], source, ref, amount, sid, daysAgo]))[0].id;
    await q(`UPDATE student_term_ledger SET amount_paid = amount_paid + $1 WHERE student_id = $2 AND term_id = $3`, [amount, sid, T[2]]);
    return t;
  };
  await bank(c, 'M1', 'mpesa', 20000, 3);         // Cate owes 40,000
  await bank(d, 'E1', 'equity', 70000, 1);        // Dan overpays by 10,000
  const wrong = await rec(b, 500, 'cash');        // a wrong one, then reversed
  await sheet.reverseManualPayment(S, wrong.transaction_id, { reason: 'typo' }, { staffId: owner });
  await q(`INSERT INTO transactions (school_id, term_id, source, external_ref, amount, payer_name, match_status) VALUES ($1,$2,'mpesa','RV1',8000,'Jane','needs_review'),($1,$2,'mpesa','UN1',300,'Who','unmatched')`, [S, T[2]]);
  await q(`UPDATE students SET status = 'left' WHERE id = $1`, [d]);
  await adm('105', 'Eve Five', 'Grade 1');        // admitted later, not billed? (billed on admission) -> billed
  await q(`DELETE FROM student_term_ledger WHERE student_id = (SELECT id FROM students WHERE admission_no = '105' AND school_id = $1)`, [S]);   // pretend: not billed yet

  const r = await getReport(S);
  check('the school name comes back', r.school.name === 'Mwangaza Academy');
  check('only terms with real figures are listed: Term 1 (no data) is left out', r.terms.length === 1 && /Term 2/.test(r.terms[0].label) && r.byTerm.length === 1, r.terms);
  check('the newest term with figures is picked', r.term.id === T[2] && r.term.start && r.term.end);
  check('billed = 40,000 + 40,000 + 60,000 + 60,000', r.tiles.billed === 200000, r.tiles);
  check('collected = 40,000 + 10,000 + 20,000 + 70,000 (reversed 500 not counted)', r.tiles.collected === 140000, r.tiles);
  check('outstanding = 30,000 + 40,000 (only people who owe) and credit = 10,000', r.tiles.outstanding === 70000 && r.tiles.credit === 10000, r.tiles);
  check('collection rate = 70%', r.tiles.rate === 70, r.tiles.rate);
  check('students billed 4, owing 2', r.tiles.students_billed === 4 && r.tiles.students_owing === 2, r.tiles);
  const bal = await listBalances(S, { students: 'all' });
  check('the totals agree with Students & balances (the same ledger)', bal.totals.billed === r.tiles.billed && bal.totals.paid === r.tiles.collected && bal.totals.outstanding === r.tiles.outstanding, [bal.totals, r.tiles]);
  const g1 = r.arrearsByClass.find((x) => x.class === 'Grade 1'), g2 = r.arrearsByClass.find((x) => x.class === 'Grade 2');
  check('arrears by class: Grade 1 owes 30,000 (1 student), Grade 2 owes 40,000 (1 student, the overpayer owes nothing)', g1.owed === 30000 && g1.students_owing === 1 && g2.owed === 40000 && g2.students_owing === 1, r.arrearsByClass);
  check('classes come in school order with a rate and an id to link to', r.arrearsByClass[0].class === 'Grade 1' && g1.rate === 62.5 && g1.class_id === C['Grade 1']);
  check('biggest arrears: Cate (40,000) first, then Brian; nobody who owes nothing', r.topArrears.length === 2 && r.topArrears[0].full_name === 'Cate Three' && r.topArrears[0].balance === 40000 && r.topArrears[1].full_name === 'Brian Two' && r.topArrears[0].guardian_phone, r.topArrears);
  check('money in totals match collected (every payment has a source)', r.moneyIn.total === 140000 && r.moneyIn.count === 4, r.moneyIn);
  check('money in by day (a 80-day term shows weeks), newest week last', r.moneyIn.bucket === 'week' && r.moneyIn.series.length >= 1 && r.moneyIn.series.every((x, i, arr) => i === 0 || arr[i - 1].day < x.day), r.moneyIn.series);
  const srcName = (n) => (r.sources.find((x) => x.name === n) || {}).amount;
  check('sources: M-Pesa 20,000, Equity 70,000, hand-recorded cash 40,000 and cheque 10,000', srcName('M-Pesa') === 20000 && srcName('Equity Bank') === 70000 && srcName('Recorded by hand: Cash') === 40000 && srcName('Recorded by hand: Cheque') === 10000, r.sources);
  check('sources add up to money in', r.sources.reduce((s, x) => s + x.amount, 0) === r.moneyIn.total);
  check('attention: 1 payment to review (8,000), 1 unmatched (300), 1 student not billed', r.attention.review === 1 && r.attention.review_amount === 8000 && r.attention.unmatched === 1 && r.attention.unmatched_amount === 300 && r.attention.not_billed === 1, r.attention);
  check('another term with no figures is refused politely', await fails(() => getReport(S, { termId: T[1] }), /no figures/));
  check('a term that has not started is refused', await fails(() => getReport(S, { termId: T[3] }), /no figures/));
  const other = await getReport(1);
  check('another school sees none of this (no figures, no students)', other.term === null && other.tiles === null && other.terms.length === 0 && other.attention.review === 0);
  const empty = await getReport(S, {}, {});
  check('asking again gives the same numbers', empty.tiles.billed === r.tiles.billed);

  // ---- over the API
  const app = require('../app');
  const server = app.listen(0); const base = 'http://localhost:' + server.address().port + '/api';
  const call = async (m, p, body, tk) => { const x = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: body ? JSON.stringify(body) : undefined }); let j = null; try { j = await x.json(); } catch (e) { /* none */ } return { s: x.status, d: j }; };
  const adminTok = (await call('POST', '/auth/login', { email: 'olive@m.ke', password: 'Owner-pass-1' })).d.token;
  const staffTok = (await call('POST', '/auth/login', { email: 'ben@m.ke', password: 'Ben-pass-123' })).d.token;
  const ok = await call('GET', '/schools/' + S + '/reports', null, adminTok);
  check('an Admin gets the report over the API', ok.s === 200 && ok.d.tiles.billed === 200000);
  check('a term can be chosen', (await call('GET', '/schools/' + S + '/reports?term_id=' + T[2], null, adminTok)).s === 200 && (await call('GET', '/schools/' + S + '/reports?term_id=' + T[1], null, adminTok)).s === 404);
  check('staff-role people are refused', (await call('GET', '/schools/' + S + '/reports', null, staffTok)).s === 403);
  check('another school\'s Admin can not read it', (await call('GET', '/schools/1/reports', null, adminTok)).s === 403);
  check('no login, no report', (await call('GET', '/schools/' + S + '/reports')).s === 401);
  server.close();

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  await pool.end();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });