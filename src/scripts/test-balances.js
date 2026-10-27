// Tests Students & balances (src/services/balances.js, route src/routes/balanceRoutes.js) against a REAL Postgres database.
// It WIPES the database it connects to, so it refuses to run unless the database name ends with _test.
//   set TEST_DATABASE_URL=postgres://user:password@localhost:5432/karo_test
//   node src/scripts/test-balances.js
const crypto = require('crypto');
const url = process.env.TEST_DATABASE_URL || '';
if (!/\/[^/]*_test(\?.*)?$/.test(url)) {
  console.error('Set TEST_DATABASE_URL to a database whose name ends with _test (it is WIPED).');
  process.exit(1);
}
process.env.DATABASE_URL = url;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { pool, initSchema } = require('../db/db');
const { listBalances } = require('../services/balances');

let failed = 0, passed = 0;
const check = (name, ok, extra) => { if (ok) passed++; else failed++; console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (!ok && extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); };
const fails = async (fn, re, status) => { try { await fn(); return false; } catch (e) { return re.test(e.message) && (status == null || e.status === status); } };
const q = async (sql, p) => (await pool.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];

(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await initSchema();
  const C = Object.fromEntries((await q('SELECT id, name FROM classes')).map((r) => [r.name, r.id]));
  await q(`INSERT INTO schools (name) VALUES ('Mwangaza'), ('Other')`);
  const y = (await q(`INSERT INTO academic_years (year, is_current) VALUES (EXTRACT(YEAR FROM CURRENT_DATE), TRUE) RETURNING id`))[0].id;
  await q(`INSERT INTO terms (academic_year_id, term_number) VALUES ($1,1),($1,2),($1,3)`, [y]);
  const T = Object.fromEntries((await q('SELECT id, term_number FROM terms')).map((r) => [r.term_number, r.id]));
  // Term 1 ended, Term 2 running, Term 3 not started (for BOTH schools); school 2 is one term behind
  await q(`INSERT INTO school_term_dates (school_id, term_id, start_date, end_date) VALUES
    (1, $1, CURRENT_DATE - 150, CURRENT_DATE - 60), (1, $2, CURRENT_DATE - 20, CURRENT_DATE + 60), (1, $3, CURRENT_DATE + 100, CURRENT_DATE + 150),
    (2, $1, CURRENT_DATE - 20, CURRENT_DATE + 60)`, [T[1], T[2], T[3]]);
  const st = (await q(`INSERT INTO streams (school_id, class_id, academic_year_id, name) VALUES (1, $1, $2, 'North'), (1, $1, $2, 'South') RETURNING id, name`, [C['Grade 1'], y]));
  const S = Object.fromEntries(st.map((s) => [s.name, s.id]));
  const add = async (school, adm, name, cls, stream, status = 'active') => (await q(
    `INSERT INTO students (school_id, admission_no, full_name, class_id, stream_id, status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [school, adm, name, C[cls], stream, status]))[0].id;
  const led = (sid, term, open, fees, paid) => q(`INSERT INTO student_term_ledger (student_id, term_id, opening_balance, fees_charged, amount_paid) VALUES ($1,$2,$3,$4,$5)`, [sid, T[term], open, fees, paid]);
  const owe = await add(1, '2', 'Amina Owes', 'Grade 1', S.North);       await led(owe, 2, 5000, 50000, 20000);      // balance 35,000
  const clr = await add(1, '10', 'Brian Cleared', 'Grade 1', S.South);   await led(clr, 2, 0, 50000, 50000);          // 0
  const ovr = await add(1, '3', 'Cheri Ahead', 'Grade 2', null);          await led(ovr, 2, 0, 40000, 45000);          // -5,000
  const nb = await add(1, '4', 'Dan NotBilled', 'Grade 2', null);                                                       // no ledger row
  const left = await add(1, '5', 'Eve Left', 'Grade 2', null, 'left');    await led(left, 2, 0, 40000, 10000);
  const t1 = await add(1, '6', 'Fred History', 'Grade 2', null);          await led(t1, 1, 0, 38000, 38000);          // paid in Term 1 only
  const other = await add(2, '2', 'Other School Kid', 'Grade 1', null);   await led(other, 1, 0, 99999, 0);
  const name = (r) => r.rows.map((x) => x.full_name);

  let r = await listBalances(1);
  check('defaults to the school\'s current term (Term 2), active students only', r.term && r.term.term === 2 && r.total === 5 && !name(r).includes('Eve Left'), [r.term, name(r)]);
  check('the money: balance = brought forward + charged - paid', r.rows.find((x) => x.id === owe).balance === 35000 && r.rows.find((x) => x.id === owe).brought_forward === 5000 && r.rows.find((x) => x.id === ovr).balance === -5000);
  check('states: owing, cleared, overpaid, not billed', r.rows.find((x) => x.id === owe).state === 'owing' && r.rows.find((x) => x.id === clr).state === 'cleared' && r.rows.find((x) => x.id === ovr).state === 'overpaid' && r.rows.find((x) => x.id === nb).state === 'not_billed');
  check('totals: billed 145,000, paid 115,000, outstanding 35,000, credit 5,000, 1 owing', r.totals.billed === 5000 + 50000 + 50000 + 40000 && r.totals.paid === 20000 + 50000 + 45000 && r.totals.outstanding === 35000 && r.totals.credit === 5000 && r.totals.owing === 1, r.totals);
  check('status counts for the chips', r.counts.owing === 1 && r.counts.cleared === 1 && r.counts.overpaid === 1 && r.counts.not_billed === 2 && r.counts.all === 5, r.counts);
  check('another school\'s students never appear', !name(r).includes('Other School Kid') && r.classes.every((c) => c.name));
  check('the term picker lists only started terms, newest first', r.terms.length === 2 && r.terms[0].term === 2 && r.terms[1].term === 1, r.terms);

  r = await listBalances(1, { status: 'owing' });
  check('filter owing: one student, totals follow the filter', r.rows.length === 1 && r.rows[0].id === owe && r.totals.students === 1 && r.totals.outstanding === 35000 && r.counts.all === 5, r);
  r = await listBalances(1, { students: 'left' });
  check('students=left shows the one who left, with his balance', r.rows.length === 1 && r.rows[0].full_name === 'Eve Left' && r.rows[0].balance === 30000);
  r = await listBalances(1, { students: 'all' });
  check('students=all shows everyone in the school (6)', r.total === 6);
  r = await listBalances(1, { q: 'amina' });
  check('search by name, any case', r.rows.length === 1 && r.rows[0].id === owe);
  r = await listBalances(1, { q: '10' });
  check('search by admission number', r.rows.length === 1 && r.rows[0].id === clr);
  r = await listBalances(1, { q: '%' });
  check('a % in the search is just a character, not "everyone"', r.rows.length === 0);
  r = await listBalances(1, { classId: C['Grade 2'] });
  check('filter by class', name(r).sort().join() === 'Cheri Ahead,Dan NotBilled,Fred History');
  r = await listBalances(1, { streamId: S.North });
  check('filter by stream', r.rows.length === 1 && r.rows[0].id === owe && r.rows[0].stream === 'North');
  r = await listBalances(1, { sort: 'balance_desc' });
  check('sort biggest debt first', r.rows[0].id === owe && r.rows[r.rows.length - 1].balance <= 0);
  r = await listBalances(1, { sort: 'admission' });
  check('admission numbers sort as numbers (2, 3, 4, 6, 10)', r.rows.map((x) => x.admission_no).join() === '2,3,4,6,10', r.rows.map((x) => x.admission_no));
  r = await listBalances(1, { sort: 'class' });
  check('sort by class then stream', r.rows[0].class === 'Grade 1' && r.rows[r.rows.length - 1].class === 'Grade 2');
  r = await listBalances(1, { limit: 2, offset: 2, sort: 'admission' });
  check('paging: 2 per page, total still 5', r.rows.length === 2 && r.total === 5 && r.rows[0].admission_no === '4');

  r = await listBalances(1, { termId: T[1] });
  check('history: Term 1 shows Term 1 money (Fred paid in full) and nobody else is billed', r.term.term === 1 && r.rows.find((x) => x.id === t1).state === 'cleared' && r.counts.cleared === 1);
  check('a term that has not started is refused', await fails(() => listBalances(1, { termId: T[3] }), /has not started/, 404));
  check('another school\'s calendar decides: school 2 has no Term 2 yet', await fails(() => listBalances(2, { termId: T[2] }), /has not started/, 404));
  r = await listBalances(2);
  check('school 2 current term is Term 1 and shows only its student', r.term.term === 1 && r.rows.length === 1 && r.rows[0].fees_charged === 99999);

  await q(`DELETE FROM school_term_dates WHERE school_id = 2`);
  r = await listBalances(2);
  check('no term started: empty list, no crash, term is null', r.term === null && r.rows.length === 0 && r.total === 0);
  check('bad filters are plain 400s', await fails(() => listBalances(1, { status: 'rich' }), /status must be/, 400) && await fails(() => listBalances(1, { sort: 'x; DROP TABLE students' }), /sort must be/, 400) && await fails(() => listBalances(1, { classId: 'abc' }), /classId must be a number/, 400));
  check('nothing was changed by looking', (await q('SELECT 1 FROM students')).length === 7);

  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error('TEST CRASHED:', e); try { await pool.end(); } catch (x) { /* done */ } process.exit(1); });