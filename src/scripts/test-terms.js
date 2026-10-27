// Tests each school's own academic years and term dates (src/services/termSetup.js) against a REAL Postgres database:
// per-school calendars, the lock rules (a date locks when it is reached), the "this starts billing now" confirmation,
// automatic billing after it, the database trigger underneath, and the one-time copy of the old shared dates.
//
// It WIPES the database it connects to, so it refuses to run unless the database name ends with _test.
//   Windows CMD:   createdb karo_test      (once)
//                  set TEST_DATABASE_URL=postgres://user:password@localhost:5432/karo_test
//                  node src/scripts/test-terms.js
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
const terms = require('../services/termSetup');
const billing = require('../services/termBilling');
const fees = require('../services/feeSetup');
const { getCurrentTerm } = require('../services/feeLedger');
const { admitStudent } = require('../services/studentAdmission');

let failed = 0, passed = 0;
const check = (name, ok, extra) => { if (ok) passed++; else failed++; console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (!ok && extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); };
const rejects = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const fails = async (fn, re, status) => { const e = await rejects(fn); return !!(e && re.test(e.message) && (status == null || e.status === status)); };
const q = async (sql, p) => (await pool.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];

let TODAY, YEAR, C = {};
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
// a term (year + dates) that starts `s` days from today and lasts `len` days, kept inside one year
const span = (s, len) => {
  let start = addDays(TODAY, s); let end = addDays(start, len); const y = start.slice(0, 4);
  if (end.slice(0, 4) !== y) end = y + '-12-31';
  if (s > 0 && Math.round((Date.parse(end) - Date.parse(start)) / 86400000) < 30) {       // too close to the year end: use next year (still in the future)
    const ny = Number(y) + 1; start = ny + '-01-' + String(10 + (s % 10)).padStart(2, '0'); end = addDays(start, len);
  }
  return { year: Number(start.slice(0, 4)), start, end };
};
const set = (school, term, sp, extra = {}) => terms.setTermDates({ schoolId: school, year: sp.year, term, start: sp.start, end: sp.end, ...extra });

async function reset() {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await initSchema();
  TODAY = (await one(`SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS d`)).d;
  YEAR = Number(TODAY.slice(0, 4));
  C = Object.fromEntries((await q('SELECT id, name FROM classes')).map((r) => [r.name, r.id]));
  await q(`INSERT INTO schools (name) VALUES ('Mwangaza'), ('Other School')`);
  for (const s of [1, 2]) for (const n of ['Grade 1', 'Grade 2']) await q('INSERT INTO school_classes (school_id, class_id, enabled) VALUES ($1, $2, TRUE)', [s, C[n]]);
}
async function student(school, adm, cls) {
  return (await q(`INSERT INTO students (school_id, admission_no, full_name, class_id, status) VALUES ($1, $2, $3, $4, 'active') RETURNING id`, [school, adm, 'Student ' + adm, C[cls]]))[0].id;
}

(async () => {
  /* ============ 1. every school has its own calendar ============ */
  await reset();
  const running = span(-20, 80), coming = span(60, 80);
  let r = await set(1, 1, running, { confirmStarted: true });
  check('school 1: a running term is saved (with confirmation)', !r.unchanged && r.startsNow === true && r.year === running.year, r);
  r = await set(2, 1, coming);
  check('school 2: the same term number gets different dates, no confirmation needed (not started)', !r.startsNow && !r.needsConfirmation && r.start === coming.start);
  const t1 = (await getCurrentTerm(1)), t2 = (await getCurrentTerm(2));
  check('school 1 has a current term, school 2 has none yet', !!t1 && t1.term_number === 1 && t2 === null, [t1, t2]);
  const l1 = await terms.listTerms(1), l2 = await terms.listTerms(2);
  const y1 = l1.years.find((y) => y.year === running.year).terms, y2 = l2.years.find((y) => y.year === coming.year).terms;
  check('listTerms: school 1 sees Term 1 running and payments going there; Term 2 and 3 not set', y1[0].state === 'running' && y1[0].paymentsGoHere && y1[1].state === 'no dates' && y1[2].state === 'no dates', y1);
  check('listTerms: school 2 sees Term 1 as coming, nothing running, no payment term', y2[0].state === 'coming' && !y2[0].paymentsGoHere && l2.current === null, y2);
  check('this year always shows with three terms, even for a school with no dates', (await terms.listTerms(1)).years.every((y) => y.terms.length === 3));
  check('the shared term slots hold no dates', (await q('SELECT 1 FROM terms WHERE start_date IS NOT NULL OR end_date IS NOT NULL')).length === 0);
  check('the change is in the audit log with the school', (await q(`SELECT 1 FROM audit_log WHERE action = 'terms_set' AND school_id = 1`)).length === 1);
  check('no school number -> refused', await fails(() => terms.setTermDates({ year: YEAR, term: 1, start: coming.start, end: coming.end }), /Which school/i));
  check('unknown school -> 404', await fails(() => terms.setTermDates({ schoolId: 99, year: running.year, term: 1, start: running.start, end: running.end }), /no school with number 99/i, 404));

  /* ============ 2. billing follows each school's own dates ============ */
  await reset();
  await fees.setFees(1, { classNames: ['Grade 1'], terms: [1, 2, 3], fees: ['Tuition=50000'] });
  await fees.setFees(2, { classNames: ['Grade 1'], terms: [1, 2, 3], fees: ['Tuition=40000'] });
  const a1 = await student(1, '1', 'Grade 1'), a2 = await student(2, '1', 'Grade 1');
  await set(1, 1, span(-20, 80), { confirmStarted: true });          // school 1 is running (it also billed itself, see section 4)
  await set(2, 1, span(30, 80));                                    // school 2 starts later
  let all = await billing.billAllSchools();
  const led = (sid) => one('SELECT fees_charged FROM student_term_ledger WHERE student_id = $1', [sid]);
  check('billing charges only the school whose term has started', (await led(a1)) && Number((await led(a1)).fees_charged) === 50000 && !(await led(a2)), all);
  check('...and nothing is locked for the school whose term has not started', (await q('SELECT 1 FROM term_fee_locks WHERE school_id = 2')).length === 0);

  /* ============ 3. the lock rules ============ */
  await reset();
  const cur = span(-20, 80);
  await set(1, 1, cur, { confirmStarted: true });
  check('a running term: the START date is locked', await fails(() => terms.setTermDates({ schoolId: 1, year: cur.year, term: 1, start: addDays(cur.start, 3), end: cur.end }), /start date is locked/i, 409));
  const longer = addDays(cur.end, -5);
  r = await terms.setTermDates({ schoolId: 1, year: cur.year, term: 1, start: cur.start, end: longer });
  check('a running term: the END date can still move', !r.unchanged && r.end === longer && r.startsNow === false, r);
  check('a running term: the end can not be before today', await fails(() => terms.setTermDates({ schoolId: 1, year: cur.year, term: 1, start: cur.start, end: addDays(TODAY, -1) }), /can not be before today/i, 409));
  check('the database refuses to move a reached start date even if the code were skipped', await fails(() => pool.query(`UPDATE school_term_dates SET start_date = start_date + 1 WHERE school_id = 1`), /already started/i));
  await q(`DELETE FROM school_term_dates WHERE school_id = 1`);
  await q(`INSERT INTO school_term_dates (school_id, term_id, start_date, end_date) SELECT 1, id, CURRENT_DATE - 120, CURRENT_DATE - 30 FROM terms WHERE term_number = 1 LIMIT 1`);
  const ended = (await terms.listTerms(1)).years.flatMap((y) => y.terms).find((t) => t.state === 'ended');
  check('an ended term is listed as ended with nothing editable', !!ended && !ended.canChangeStart && !ended.canChangeEnd, ended);
  const endedRow = await one(`SELECT to_char(d.start_date,'YYYY-MM-DD') AS s, to_char(d.end_date,'YYYY-MM-DD') AS e, ay.year FROM school_term_dates d JOIN terms t ON t.id = d.term_id JOIN academic_years ay ON ay.id = t.academic_year_id WHERE d.school_id = 1`);
  check('an ended term is fully locked', await fails(() => terms.setTermDates({ schoolId: 1, year: endedRow.year, term: 1, start: endedRow.s, end: addDays(endedRow.e, 3) }), /dates are locked/i, 409));
  check('the database refuses to change an ended term too', await fails(() => pool.query(`UPDATE school_term_dates SET end_date = end_date + 5 WHERE school_id = 1`), /ended/i));
  await reset();
  const fut = span(40, 80);
  await set(1, 1, fut);
  const moved = { year: fut.year, start: addDays(fut.start, 7), end: addDays(fut.end, 7) };
  r = await set(1, 1, moved.end.slice(0, 4) === String(fut.year) ? moved : fut);
  check('a term that has not started can change both dates freely', r.unchanged === true || (!r.unchanged && r.start === moved.start), r);
  check('already-saved identical dates say "nothing to change"', (await set(1, 1, fut.year === moved.year && moved.end.slice(0, 4) === String(fut.year) ? moved : fut)).unchanged === true);

  /* ============ 4. starting now needs a yes, shows who is billed, then bills at once ============ */
  await reset();
  await fees.setFees(1, { classNames: ['Grade 1'], terms: [1, 2, 3], fees: ['Tuition=50000'] });
  const s1 = await student(1, '10', 'Grade 1'), s2 = await student(1, '11', 'Grade 1'), s3 = await student(1, '12', 'Grade 2');
  const now = span(-5, 80);
  const e = await rejects(() => set(1, 1, now));
  check('a start date in the past without a yes is refused with a 409 and a preview', !!e && e.status === 409 && e.needsConfirmation === true && !!e.preview, e && e.message);
  check('the preview says 2 students in 1 class will be billed and Grade 2 waits for fees', e.preview.studentsBilled === 2 && e.preview.classesBilled === 1 && e.preview.waitingForFees[0].class === 'Grade 2' && e.preview.waitingForFees[0].students === 1, e.preview);
  check('refused means NOTHING saved', (await q('SELECT 1 FROM school_term_dates')).length === 0);
  r = await set(1, 1, now, { dry: true });
  check('a dry run reports needsConfirmation and the preview, and saves nothing', r.needsConfirmation === true && r.preview.studentsBilled === 2 && (await q('SELECT 1 FROM school_term_dates')).length === 0 && (await q('SELECT 1 FROM term_billing')).length === 0, r);
  r = await set(1, 1, now, { confirmStarted: true });
  check('with the yes: saved, and billed straight away (2 students, 1 class)', r.billed && r.billed.billedClasses === 1 && r.billed.students === 2, r.billed);
  check('the two Grade 1 students were charged, the Grade 2 student was not (no fees set)', Number((await one('SELECT fees_charged FROM student_term_ledger WHERE student_id = $1', [s1])).fees_charged) === 50000 && !(await one('SELECT 1 FROM student_term_ledger WHERE student_id = $1', [s3])));
  check('...and the warning names the class waiting for fees', r.warnings.some((w) => /Grade 2 \(1 students\)/.test(w)), r.warnings);
  await set(1, 1, now, { confirmStarted: true });
  check('saving the same thing again charges nobody twice', (await q('SELECT 1 FROM term_billing')).length === 1 && Number((await one('SELECT fees_charged FROM student_term_ledger WHERE student_id = $1', [s2])).fees_charged) === 50000);
  const over = span(-60, 30);
  check('a term that is already over also needs a yes', await fails(() => set(2, 1, over), /already over/i, 409));
  r = await set(2, 1, over, { confirmStarted: true });
  check('...and bills nothing when confirmed', r.preview.classesBilled === 0 && (await q('SELECT 1 FROM term_billing WHERE school_id = 2')).length === 0, r.preview);

  /* ============ 5. an empty class is not locked; the first admission locks it ============ */
  await reset();
  await fees.setFees(1, { classNames: ['Grade 1'], terms: [1, 2, 3], fees: ['Tuition=50000'] });
  await set(1, 1, span(-5, 80), { confirmStarted: true });
  const rep = await billing.billSchool(1);
  check('a class with fees but no students is NOT locked', rep.classes.find((c) => c.class === 'Grade 1').status === 'no_students' && (await q('SELECT 1 FROM term_fee_locks')).length === 0, rep.classes);
  await fees.setFees(1, { classNames: ['Grade 1'], term: 1, fees: ['Tuition=60000'] });
  const adm = await admitStudent(1, { admissionNo: '900', fullName: 'First Learner', classId: C['Grade 1'] });
  check('the first admission locks the class at the latest version and charges 60,000', adm.billed && adm.billed.fees === 60000 && (await q('SELECT 1 FROM term_fee_locks')).length === 1, adm.billed);

  /* ============ 6. the rules for what is typed ============ */
  await reset();
  const ok = span(40, 80);
  const bad = (o, re) => fails(() => terms.setTermDates({ schoolId: 1, year: ok.year, term: 1, start: ok.start, end: ok.end, ...o }), re, 400);
  check('term 4 refused', await bad({ term: 4 }, /must be 1, 2 or 3/));
  check('a date typed the wrong way round refused', await bad({ start: '31-08-2026' }, /year-month-day/));
  check('a date that does not exist refused', await bad({ end: ok.year + '-02-30' }, /not a real date/));
  check('end before start refused', await bad({ start: ok.end, end: ok.start }, /AFTER the start/));
  check('a 3-day term refused as a typing mistake', await bad({ end: addDays(ok.start, 3) }, /shortest allowed is 14/));
  check('a 300-day term refused', await bad({ start: ok.year + '-01-02', end: ok.year + '-12-30' }, /longest allowed is 180/));
  check('dates outside the year refused', await bad({ year: ok.year + 1 }, /inside/));
  check('a far-off year refused (typo guard)', await fails(() => terms.setTermDates({ schoolId: 1, year: YEAR + 7, term: 1, start: (YEAR + 7) + '-01-10', end: (YEAR + 7) + '-04-10' }), /outside the years/i, 400));
  check('typing mistakes created nothing (no junk year)', (await q('SELECT 1 FROM academic_years WHERE year > $1', [YEAR + 2])).length === 0);

  /* ============ 7. order and overlaps, per school ============ */
  await reset();
  const y = YEAR + 1;
  await terms.setTermDates({ schoolId: 1, year: y, term: 2, start: y + '-05-05', end: y + '-08-08' });
  check('term 1 must end before term 2 starts', await fails(() => terms.setTermDates({ schoolId: 1, year: y, term: 1, start: y + '-01-05', end: y + '-05-10' }), /must end BEFORE/, 409));
  check('term 3 must start after term 2 ends', await fails(() => terms.setTermDates({ schoolId: 1, year: y, term: 3, start: y + '-08-01', end: y + '-10-30' }), /must start AFTER/, 409));
  r = await terms.setTermDates({ schoolId: 2, year: y, term: 1, start: y + '-01-05', end: y + '-05-10' });
  check('another school\'s calendar is independent: the same dates are fine there', !r.unchanged && r.start === y + '-01-05');
  r = await terms.setTermDates({ schoolId: 1, year: y, term: 3, start: y + '-09-01', end: y + '-10-30' });
  check('a good term after term 2 is saved', r.start === y + '-09-01');

  /* ============ 8. two people at once, same school ============ */
  await reset();
  const w = span(50, 80);
  const both = await Promise.allSettled([set(1, 1, w), set(1, 1, { ...w, end: addDays(w.end, -2) })]);
  const row = await q('SELECT 1 FROM school_term_dates WHERE school_id = 1');
  check('two saves at the same instant: no crash, exactly one row, both answered', row.length === 1 && both.every((x) => x.status === 'fulfilled'), both.map((x) => x.status));

  /* ============ 9. the old shared dates become every school's own ============ */
  await reset();
  const yy = (await q(`INSERT INTO academic_years (year, is_current) VALUES ($1, TRUE) RETURNING id`, [YEAR]))[0].id;
  await q(`INSERT INTO terms (academic_year_id, term_number, start_date, end_date) VALUES ($1, 1, $2, $3), ($1, 2, NULL, NULL), ($1, 3, NULL, NULL)`, [yy, YEAR + '-01-12', YEAR + '-04-10']);
  await initSchema();
  check('old shared dates copied to both schools', (await q('SELECT 1 FROM school_term_dates')).length === 2);
  check('...and the shared columns emptied', (await q('SELECT 1 FROM terms WHERE start_date IS NOT NULL')).length === 0);
  await q(`INSERT INTO schools (name) VALUES ('Third')`);
  await initSchema(); await initSchema();
  check('running the schema again changes nothing, and a school added later starts with a blank calendar', (await q('SELECT 1 FROM school_term_dates')).length === 2 && (await q('SELECT 1 FROM school_term_dates WHERE school_id = 3')).length === 0);

  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error('TEST CRASHED:', e); try { await pool.end(); } catch (x) { /* done */ } process.exit(1); });