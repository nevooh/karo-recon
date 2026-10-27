// Tests the fee structure (versioned templates per class and term number) and AUTOMATIC, once-only billing,
// against a REAL Postgres database (the pretend-database tests can not prove SQL rules, triggers or races).
//
// It WIPES the database it connects to, so it refuses to run unless the database name ends with _test.
//   Windows CMD:   createdb karo_test      (once)
//                  set TEST_DATABASE_URL=postgres://user:password@localhost:5432/karo_test
//                  node src/scripts/test-fee-billing.js
const crypto = require('crypto');
const url = process.env.TEST_DATABASE_URL || '';
if (!/\/[^/]*_test(\?.*)?$/.test(url)) {
  console.error('Set TEST_DATABASE_URL to a database whose name ends with _test (it is WIPED). Example: postgres://user:password@localhost:5432/karo_test');
  process.exit(1);
}
process.env.DATABASE_URL = url;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { pool, initSchema } = require('../db/db');
const fees = require('../services/feeSetup');
const billing = require('../services/termBilling');
const { admitStudent } = require('../services/studentAdmission');

let failed = 0, passed = 0;
const check = (name, ok, extra) => { if (ok) passed++; else failed++; console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (!ok && extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); };
const rejects = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const fails = async (fn, re, status) => { const e = await rejects(fn); return !!(e && re.test(e.message) && (status == null || e.status === status)); };
const q = async (sql, p) => (await pool.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];

let C = {};     // class ids by name
const cid = (n) => C[n];

async function reset() {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await initSchema();
  C = Object.fromEntries((await q('SELECT id, name FROM classes')).map((r) => [r.name, r.id]));
  await q(`INSERT INTO schools (name) VALUES ('Mwangaza'), ('Other School')`);
  for (const s of [1, 2]) for (const n of ['Grade 1', 'Grade 2', 'Grade 3']) await q('INSERT INTO school_classes (school_id, class_id, enabled) VALUES ($1, $2, TRUE)', [s, C[n]]);
  const y = (await q(`INSERT INTO academic_years (year, is_current) VALUES (2026, TRUE) RETURNING id`))[0].id;
  // Term 1 is RUNNING (started 20 days ago), Term 2 and 3 are coming
  await q(`INSERT INTO terms (academic_year_id, term_number) VALUES ($1, 1), ($1, 2), ($1, 3)`, [y]);
  await setDates(1, -20, 60); await setDates(2, 90, 160); await setDates(3, 200, 240);
}
// every school's own dates for a term of 2026, as days from today (null = no dates). Deleting first is how a test
// moves a start date that has already been reached (the engine never does this; the database trigger only guards updates).
async function setDates(tn, startDay, endDay) {
  const t = (await q(`SELECT t.id FROM terms t JOIN academic_years ay ON ay.id = t.academic_year_id WHERE ay.year = 2026 AND t.term_number = $1`, [tn]))[0].id;
  await q('DELETE FROM school_term_dates WHERE term_id = $1', [t]);
  if (startDay != null) await q(`INSERT INTO school_term_dates (school_id, term_id, start_date, end_date) SELECT id, $1, CURRENT_DATE + $2::int, CURRENT_DATE + $3::int FROM schools`, [t, startDay, endDay]);
}
const term = async (n) => one('SELECT id, term_number, academic_year_id FROM terms WHERE term_number = $1', [n]);
async function student(school, adm, cls, optional = []) {
  const s = (await q(`INSERT INTO students (school_id, admission_no, full_name, class_id, status) VALUES ($1, $2, $3, $4, 'active') RETURNING id`, [school, adm, 'Student ' + adm, C[cls]]))[0];
  for (const n of optional) await q(`INSERT INTO student_optional_choices (student_id, name, name_key) VALUES ($1, $2, $3)`, [s.id, n, n.toLowerCase()]);
  return s.id;
}
const ledger = async (sid, tn) => one('SELECT * FROM student_term_ledger WHERE student_id = $1 AND term_id = (SELECT id FROM terms WHERE term_number = $2)', [sid, tn]);
const n = (v) => Number(v);

(async () => {
  /* ============ 1. the fee structure: versions, no year, edit any day ============ */
  await reset();
  await initSchema(); await initSchema();
  check('schema can be built again and again (safe to repeat)', true);

  let r = await fees.setFees(1, { classNames: ['Grade 1'], term: 1, fees: ['Tuition=50000', 'Exam=2000'] });
  check('set fees for Grade 1 Term 1 = version 1', r.classes[0].version === 1 && !r.classes[0].unchanged, r);
  r = await fees.setFees(1, { classNames: ['Grade 1'], term: 1, fees: ['Exam=2000', 'Tuition=50000'] });
  check('the same list again changes nothing (no new version)', r.classes[0].unchanged && r.classes[0].version === 1, r);
  r = await fees.setFees(1, { classNames: ['Grade 1'], term: 1, fees: ['Tuition=52000', 'Exam=2000'] });
  check('a changed price = version 2', r.classes[0].version === 2 && r.classes[0].previous === 1, r);
  check('the table has no year in it', (await q(`SELECT column_name FROM information_schema.columns WHERE table_name='fee_templates'`)).every((c) => !/year|term_id/.test(c.column_name)));

  r = await fees.setFees(1, { classNames: ['Grade 1'], terms: [1, 2, 3], fees: ['Tuition=52000', 'Exam=2000'] });
  check('terms 1,2,3 together: term 1 unchanged, terms 2 and 3 start at version 1',
    r.classes.find((c) => c.term === 1).unchanged && r.classes.find((c) => c.term === 2).version === 1 && r.classes.find((c) => c.term === 3).version === 1, r.classes);
  r = await fees.setFees(1, { classNames: ['Grade 1'], term: 3, fees: ['Tuition=40000', 'Exam=2000'] });
  check('term 3 can be cheaper (its own version)', r.classes[0].version === 2);

  check('a fee that is not an amount is refused', await fails(() => fees.setFees(1, { classNames: ['Grade 1'], term: 1, fees: ['Tuition=abc'] }), /not an amount/));
  check('term 4 is refused', await fails(() => fees.setFees(1, { classNames: ['Grade 1'], term: 4, fees: ['Tuition=1'] }), /not a term/));
  check('a switched-off class is refused', await fails(() => fees.setFees(1, { classNames: ['Grade 4'], term: 1, fees: ['Tuition=1000'] }), /switched off/, 409));
  check('the same fee name twice is refused', await fails(() => fees.setFees(1, { classNames: ['Grade 1'], term: 1, fees: ['Tuition=1', 'tuition=2'] }), /written twice/));
  check('an optional fee not on the school list is refused', await fails(() => fees.setFees(1, { classNames: ['Grade 1'], term: 1, fees: ['Tuition=52000', 'Exam=2000'], optional: ['Lunch=3000'] }), /not on this school's optional fee list/));

  r = await fees.setFees(1, { classNames: ['Grade 1'], term: 1, fees: ['Tuition=52000', 'Exam=2000'], optional: ['Lunch=3000', 'Bus=5000'], newOptional: true });
  check('optional fees saved with the mandatory ones in one version (version 3) and names added to the list', r.classes[0].version === 3 && r.addedToList.length === 2, r);
  r = await fees.setFees(1, { classNames: ['Grade 1'], term: 1, fees: ['Tuition=52000', 'Exam=2000'], optional: ['Lunch=3000'], dry: true });
  check('dry run changes nothing', (await one(`SELECT MAX(version) AS v FROM fee_templates WHERE school_id=1 AND class_id=$1 AND term_number=1`, [cid('Grade 1')])).v === 3);

  const cf = await fees.classFees(1, cid('Grade 1'));
  const t1 = cf.terms[0];
  check('class page: latest on top, 3 versions, totals', t1.latest.version === 3 && t1.versions.map((v) => v.version).join() === '3,2,1' && t1.latest.mandatory_total === 54000 && t1.latest.optional_total === 8000 && t1.latest.grand_total === 62000, t1.latest);
  check('history says what changed (price 50000 -> 52000, then optionals added)',
    t1.versions[1].changes.some((c) => c.kind === 'price' && c.name === 'Tuition' && c.from === 50000 && c.to === 52000) && t1.versions[0].changes.filter((c) => c.kind === 'added' && c.optional).length === 2, t1.versions.map((v) => v.changes));
  check('overview: one card per class with each term', (await fees.overview(1)).classes.length === 3 && (await fees.overview(1)).classes[0].terms.length === 3);
  check('another school sees none of it', (await fees.overview(2)).classes.every((c) => c.terms.every((t) => !t.set)));

  // old versions can never change (the database refuses, not only the code)
  const upd = await rejects(() => q(`UPDATE fee_template_items SET amount = 1`));
  const del = await rejects(() => q(`DELETE FROM fee_templates`));
  check('a database trigger refuses to change or delete versions', upd && del && /can not be changed or deleted/.test(upd.message + del.message), [upd && upd.message, del && del.message]);

  // copy
  r = await fees.copyFees(1, { fromClass: 'Grade 1', fromTerm: 1, toTerms: [2], toClasses: ['Grade 2,Grade 3'] });
  check('copy Grade 1 Term 1 to Grade 2 and 3, term 2', r.classes.length === 2 && r.classes.every((c) => c.term === 2 && c.version === 1 && c.optional.length === 2), r.classes);
  r = await fees.copyFees(1, { fromClass: 'Grade 1', fromTerm: 1, toTerms: [2] });
  check('copy Grade 1 Term 1 onto its own Term 2 = new version (Term 2 now has the optionals too)', !r.classes[0].unchanged && r.classes[0].version === 2, r.classes);
  r = await fees.copyFees(1, { fromClass: 'Grade 1', fromTerm: 1, toTerms: [2] });
  check('copying the same thing again = nothing new', r.classes[0].unchanged && r.classes[0].version === 2, r.classes);
  check('copy from a class with no fees is refused', await fails(() => fees.copyFees(1, { fromClass: 'Grade 3', fromTerm: 1, toTerms: [2] }), /nothing to copy/, 409));

  // optional page: set the prices
  r = await fees.setOptionalPrices(1, { name: 'Lunch', prices: [{ classId: cid('Grade 1'), term: 3, amount: 2000 }, { classId: cid('Grade 1'), term: 1, amount: 3500 }] });
  check('optional price per class per term: Term 3 cheaper, Term 1 changed (new versions)', r.classes.length === 2 && r.classes.every((c) => c.version >= 2), r.classes);
  const g1 = (await fees.classFees(1, cid('Grade 1'))).terms;
  check('the fee page shows them by itself (T1 Lunch 3500, T3 Lunch 2000, mandatory untouched)',
    g1[0].latest.optional.find((o) => o.name === 'Lunch').amount === 3500 && g1[2].latest.optional.find((o) => o.name === 'Lunch').amount === 2000 && g1[2].latest.mandatory_total === 42000, g1.map((t) => t.latest));
  r = await fees.setOptionalPrices(1, { name: 'Bus', prices: [{ classId: cid('Grade 1'), term: 1, amount: null }] });
  check('"not offered" removes that optional fee from that class and term only', (await fees.classFees(1, cid('Grade 1'))).terms[0].latest.optional.every((o) => o.name !== 'Bus') && (await fees.classFees(1, cid('Grade 2'))).terms[1].latest.optional.some((o) => o.name === 'Bus'));
  check('pricing a fee that is not on the list is refused', await fails(() => fees.setOptionalPrices(1, { name: 'Swimming', prices: [{ classId: cid('Grade 1'), term: 1, amount: 100 }] }), /not on this school's optional fee list/, 404));
  const op = await fees.optionalOverview(1);
  check('optional overview: price matrix per class per term', op.names.find((x) => x.name === 'Lunch').prices[cid('Grade 1')][1] === 3500 && op.names.find((x) => x.name === 'Lunch').prices[cid('Grade 1')][3] === 2000 && op.names.find((x) => x.name === 'Bus').prices[cid('Grade 1')][1] === null, op.names);
  check('a name in use can not be removed from the list', await fails(() => fees.removeOptionalName(1, 'Lunch'), /still in use/, 409));

  /* ============ 2. billing: automatic, locks, once only ============ */
  await reset();
  await fees.setFees(1, { classNames: ['Grade 1'], terms: [1, 2], fees: ['Tuition=50000', 'Exam=2000'], optional: ['Lunch=3000', 'Bus=5000'], newOptional: true });
  const a1 = await student(1, '101', 'Grade 1', ['Lunch']);
  const a2 = await student(1, '102', 'Grade 1');
  const b1 = await student(1, '201', 'Grade 2');
  const o1 = await student(2, '901', 'Grade 1');
  await fees.setFees(2, { classNames: ['Grade 1'], term: 1, fees: ['Tuition=1'] });

  let rep = await billing.billSchool(1, { dry: true });
  check('dry run reports but changes nothing', rep.billedClasses === 1 && (await q('SELECT 1 FROM term_fee_locks WHERE school_id = 1')).length === 0 && !(await ledger(a1, 1)), rep.classes);

  rep = await billing.billSchool(1);
  check('billing locks Grade 1 and tells us Grade 2 has no fees yet', rep.classes.find((c) => c.class === 'Grade 1').status === 'billed' && rep.classes.find((c) => c.class === 'Grade 2').status === 'no_fees' && rep.classes.find((c) => c.class === 'Grade 2').waitingStudents === 1, rep.classes);
  check('Lunch student charged 55,000 (52,000 + 3,000), the other 52,000', n((await ledger(a1, 1)).fees_charged) === 55000 && n((await ledger(a2, 1)).fees_charged) === 52000, [await ledger(a1, 1), await ledger(a2, 1)]);
  check('class with no fees: not billed, nothing locked, no ledger row', !(await ledger(b1, 1)) && (await q(`SELECT 1 FROM term_fee_locks WHERE school_id=1 AND class_id=$1`, [cid('Grade 2')])).length === 0);
  check('the other school was not touched', !(await ledger(o1, 1)) && (await q('SELECT 1 FROM term_fee_locks WHERE school_id = 2')).length === 0);
  check('a billing record and an audit line were written', (await q('SELECT 1 FROM term_billing WHERE school_id = 1')).length === 1 && (await q(`SELECT 1 FROM audit_log WHERE school_id = 1 AND action = 'term_billed'`)).length === 1);

  // payment arrives, then billing runs again
  await q(`UPDATE student_term_ledger SET amount_paid = 20000 WHERE student_id = $1 AND term_id = (SELECT id FROM terms WHERE term_number = 1)`, [a1]);
  rep = await billing.billSchool(1);
  check('running billing again bills nothing and touches nothing', rep.billedClasses === 0 && rep.classes.find((c) => c.class === 'Grade 1').status === 'already', rep.classes);
  check('payments and charges are exactly as before after the second run', n((await ledger(a1, 1)).amount_paid) === 20000 && n((await ledger(a1, 1)).fees_charged) === 55000);
  check('only one audit line for billing (the repeat wrote none)', (await q(`SELECT 1 FROM audit_log WHERE school_id = 1 AND action = 'term_billed'`)).length === 1);

  // edit the structure after the term was billed: the billed term must not move
  await fees.setFees(1, { classNames: ['Grade 1'], term: 1, fees: ['Tuition=99000'], optional: ['Lunch=9000'] });
  await billing.billSchool(1);
  check('editing the fee structure after billing does NOT change the billed term', n((await ledger(a1, 1)).fees_charged) === 55000 && n((await ledger(a2, 1)).fees_charged) === 52000);
  check('...but the structure itself has the new latest version', (await fees.classFees(1, cid('Grade 1'))).terms[0].latest.mandatory_total === 99000);
  check('the class page shows which version Term 1 was locked to (version 1)', (await fees.classFees(1, cid('Grade 1'))).terms[0].locked[0].version === 1);

  // Grade 2 gets its fees late: it is billed on the next run, Grade 1 stays untouched
  await fees.setFees(1, { classNames: ['Grade 2'], term: 1, fees: ['Tuition=45000'] });
  rep = await billing.billSchool(1);
  check('fees set late: the next run bills only Grade 2', rep.classes.find((c) => c.class === 'Grade 2').status === 'billed' && rep.classes.find((c) => c.class === 'Grade 1').status === 'already' && n((await ledger(b1, 1)).fees_charged) === 45000, rep.classes);
  check('Grade 1 still exactly as locked', n((await ledger(a1, 1)).fees_charged) === 55000 && n((await ledger(a1, 1)).amount_paid) === 20000);

  // the database itself refuses a second lock or any change
  const dup = await rejects(() => q(`INSERT INTO term_fee_locks (school_id, term_id, class_id, template_id) SELECT school_id, term_id, class_id, template_id FROM term_fee_locks LIMIT 1`));
  check('database: a second lock for the same school+term+class is impossible (primary key)', dup && dup.code === '23505', dup && dup.message);
  const dupB = await rejects(() => q(`INSERT INTO term_billing (school_id, term_id) SELECT school_id, term_id FROM term_billing LIMIT 1`));
  check('database: a second billing record for the same school+term is impossible', dupB && dupB.code === '23505');
  const chg = await rejects(() => q(`DELETE FROM term_fee_locks`));
  const chg2 = await rejects(() => q(`UPDATE term_billing SET students_billed = 0`));
  check('database: locks and billing records can not be changed or deleted', chg && chg2, [chg && chg.message, chg2 && chg2.message]);

  /* ============ 3. the race: many billings at the same instant ============ */
  await reset();
  await fees.setFees(1, { classNames: ['Grade 1'], term: 1, fees: ['Tuition=50000'] });
  const ids = [];
  for (let i = 0; i < 12; i++) ids.push(await student(1, String(300 + i), 'Grade 1'));
  const runs = await Promise.all(Array.from({ length: 10 }, () => billing.billSchool(1, { via: 'auto' })));
  check('10 billings at the same instant: exactly ONE did the billing', runs.filter((x) => x.billedClasses === 1).length === 1 && runs.filter((x) => x.billedClasses === 0).length === 9, runs.map((x) => x.billedClasses));
  check('one lock, one billing record', (await q('SELECT 1 FROM term_fee_locks')).length === 1 && (await q('SELECT 1 FROM term_billing')).length === 1);
  let allRight = true;
  for (const id of ids) { const l = await ledger(id, 1); if (!l || n(l.fees_charged) !== 50000) allRight = false; }
  check('every student was charged exactly 50,000 (nobody doubled)', allRight);
  const racers = await Promise.all([billing.billAllSchools(), billing.billAllSchools(), billing.billSchool(1)]);
  check('billAllSchools in parallel with billSchool: still nothing billed twice', racers[0].billed.length === 0 && racers[1].billed.length === 0 && racers[2].billedClasses === 0);

  /* ============ 4. other rules ============ */
  // one school failing must not stop the others
  await reset();
  await fees.setFees(1, { classNames: ['Grade 1'], term: 1, fees: ['Tuition=1000'] });
  await fees.setFees(2, { classNames: ['Grade 1'], term: 1, fees: ['Tuition=2000'] });
  await student(1, '1', 'Grade 1'); const s2 = await student(2, '2', 'Grade 1');
  const flaky = { connect: async () => { const c = await pool.connect(); return { query: (sql, p) => (/FROM schools WHERE id = \$1/.test(String(sql)) && p && p[0] === 1 ? Promise.reject(new Error('boom (test)')) : c.query(sql, p)), release: () => c.release() }; }, query: (...a) => pool.query(...a) };
  const all = await billing.billAllSchools({ pool: flaky });
  check('one school failing is reported and the other school is still billed', all.failed.length === 1 && all.failed[0].school_id === 1 && all.billed.length === 1 && n((await ledger(s2, 1)).fees_charged) === 2000, all);
  check('the failed school changed nothing (rolled back)', (await q('SELECT 1 FROM term_fee_locks WHERE school_id = 1')).length === 0);
  const again = await billing.billAllSchools();
  check('the failed school is billed on the next run, the other is not touched again', again.billed.length === 1 && again.billed[0].school === 'Mwangaza' && n((await ledger(s2, 1)).fees_charged) === 2000, again);

  // a term that is over is never billed
  await setDates(1, -120, -30);
  await q(`TRUNCATE term_fee_locks, term_billing`);
  await q(`DELETE FROM student_term_ledger`);
  const ended = await billing.billSchool(1);
  check('a term that has ended (holiday) bills nothing', ended.ended === true && ended.billedClasses === 0 && (await q('SELECT 1 FROM term_fee_locks')).length === 0, ended);
  await setDates(1, null); await setDates(2, null); await setDates(3, null);
  const none = await billing.billSchool(1);
  check('no term started at all: billing says so and does nothing', none.term === null);

  // next term: opening balance carries, locked price is the new term's own version, dropped optional
  await reset();
  await fees.setFees(1, { classNames: ['Grade 1'], term: 1, fees: ['Tuition=50000'], optional: ['Lunch=3000'], newOptional: true });
  await fees.setFees(1, { classNames: ['Grade 1'], term: 2, fees: ['Tuition=48000'] });
  const k = await student(1, '77', 'Grade 1', ['Lunch']);
  await billing.billSchool(1);
  await q(`UPDATE student_term_ledger SET amount_paid = 30000 WHERE student_id = $1`, [k]);
  await setDates(1, -100, -5);
  await setDates(2, -2, 80);
  const rep2 = await billing.billSchool(1);
  const l2 = await ledger(k, 2);
  check('Term 2 billed from Term 2\'s own fees, owing from Term 1 carried (23,000), Lunch dropped (class does not offer it in Term 2)',
    rep2.billedClasses === 1 && n(l2.fees_charged) === 48000 && n(l2.opening_balance) === 23000 && rep2.dropped.Lunch === 1, [rep2.dropped, l2]);
  check('Term 1 is untouched by billing Term 2', n((await ledger(k, 1)).fees_charged) === 53000 && n((await ledger(k, 1)).amount_paid) === 30000);
  check('the dropped choice was written to the audit log', (await q(`SELECT 1 FROM audit_log WHERE action = 'optional_fee_dropped'`)).length === 1);

  // removing an optional fee students chose needs --allow-drop
  await reset();
  await fees.setFees(1, { classNames: ['Grade 1'], term: 1, fees: ['Tuition=50000'], optional: ['Lunch=3000'], newOptional: true });
  await student(1, '5', 'Grade 1', ['Lunch']);
  check('removing an optional fee a student chose is refused with the number of students', await fails(() => fees.setFees(1, { classNames: ['Grade 1'], term: 1, fees: ['Tuition=50000'] }), /1 student has chosen "Lunch"/, 409));
  const okDrop = await fees.setFees(1, { classNames: ['Grade 1'], term: 1, fees: ['Tuition=50000'], allowDrop: true });
  check('...and allowed when you say so', okDrop.classes[0].version === 2 && okDrop.classes[0].drops[0].students === 1);

  /* ============ 5. admission into a running term ============ */
  await reset();
  await fees.setFees(1, { classNames: ['Grade 1'], term: 1, fees: ['Tuition=50000'], optional: ['Lunch=3000'], newOptional: true });
  let adm = await admitStudent(1, { admissionNo: '801', fullName: 'New Learner', classId: cid('Grade 1'), optionalFees: ['Lunch'] });
  check('admitted before the class was billed: the class is locked now and the student is charged 53,000', adm.billed && adm.billed.fees === 53000 && (await q('SELECT 1 FROM term_fee_locks WHERE school_id = 1')).length === 1, adm.billed);
  await fees.setFees(1, { classNames: ['Grade 1'], term: 1, fees: ['Tuition=70000'], optional: ['Lunch=9000'] });
  adm = await admitStudent(1, { admissionNo: '802', fullName: 'Later Learner', classId: cid('Grade 1'), optionalFees: ['Lunch'] });
  check('admitted after the structure was edited: still charged the LOCKED 53,000, not the new 79,000', adm.billed.fees === 53000, adm.billed);
  rep = await billing.billSchool(1);
  check('billing afterwards does not charge them again', rep.billedClasses === 0 && n((await ledger((await one(`SELECT id FROM students WHERE admission_no='801'`)).id, 1)).fees_charged) === 53000);
  const opts = await require('../services/studentAdmission').getAdmissionOptions(1, cid('Grade 1'));
  check('the admit screen offers the locked optional fee (Lunch 3,000)', opts.optional_fees.length === 1 && opts.optional_fees[0].amount === 3000, opts.optional_fees);

  /* ============ 6. carrying over the old design ============ */
  await reset();
  const y25 = (await q(`INSERT INTO academic_years (year) VALUES (2025) RETURNING id`))[0].id;
  await q(`INSERT INTO terms (academic_year_id, term_number, start_date, end_date) VALUES ($1, 1, '2025-01-06', '2025-04-10'), ($1, 2, '2025-05-05', '2025-08-08')`, [y25]);
  const tid = async (yr, tn) => (await one(`SELECT t.id FROM terms t JOIN academic_years ay ON ay.id = t.academic_year_id WHERE ay.year = $1 AND t.term_number = $2`, [yr, tn])).id;
  const fi = (term, cls, name, amount, mand = true) => q(`INSERT INTO fee_items (school_id, term_id, class_id, name, amount, is_mandatory, version) VALUES (1, $1, $2, $3, $4, $5, 1)`, [term, cls, name, amount, mand]);
  await fi(await tid(2025, 1), cid('Grade 1'), 'Tuition', 40000);
  await fi(await tid(2026, 1), cid('Grade 1'), 'Tuition', 50000);
  await fi(await tid(2026, 1), cid('Grade 1'), 'Lunch', 3000, false);
  await fi(await tid(2026, 2), cid('Grade 1'), 'Tuition', 51000);
  const mig = await student(1, '66', 'Grade 1');
  await q(`INSERT INTO student_term_ledger (student_id, term_id, opening_balance, fees_charged, amount_paid) VALUES ($1, $2, 0, 50000, 10000)`, [mig, await tid(2026, 1)]);
  await q(`TRUNCATE fee_templates, fee_template_items, term_billing, term_fee_locks CASCADE`);
  await initSchema();                                   // the carry-over runs here
  const cfm = await fees.classFees(1, cid('Grade 1'));
  check('carry-over: Term 1 has two versions, the newest year is the latest (50,000 + Lunch)', cfm.terms[0].versions.length === 2 && cfm.terms[0].latest.mandatory_total === 50000 && cfm.terms[0].latest.optional_total === 3000, cfm.terms[0].versions.map((v) => v.items));
  check('carry-over: Term 2 carried too', cfm.terms[1].latest.mandatory_total === 51000);
  check('carry-over: the term that already had a ledger is marked billed and locked to the version it used', (await q('SELECT 1 FROM term_billing')).length === 1 && cfm.terms[0].locked.length === 1 && cfm.terms[0].locked[0].version === 2, cfm.terms[0].locked);
  const afterMig = await billing.billSchool(1);
  const migLedger = await one('SELECT * FROM student_term_ledger WHERE student_id = $1 AND term_id = $2', [mig, await tid(2026, 1)]);
  check('carry-over: billing after the carry-over does NOT bill the already-billed term again', afterMig.billedClasses === 0 && n(migLedger.fees_charged) === 50000 && n(migLedger.amount_paid) === 10000, afterMig.classes);
  await initSchema();
  check('carry-over does not repeat on the next start', (await q('SELECT 1 FROM fee_templates')).length === 3);

  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error('TEST CRASHED:', e); try { await pool.end(); } catch (x) { /* ignore */ } process.exit(1); });