// Tests admitting a student (src/services/studentAdmission.js) and the charging rules for optional fees
// and starting balances (src/services/feeLedger.js) without a real database.
// The pretend database can UNDO work (ROLLBACK), so "all or nothing" and dry runs are really tested.
// Run:  node src/scripts/test-student-admission.js
const crypto = require('crypto');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

let failed = 0;
const check = (name, ok, extra) => { if (!ok) failed++; console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (!ok && extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); };
const rejects = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const fails = async (fn, status, re) => { const e = await rejects(fn); return !!(e && e.status === status && re.test(e.message)); };

// ---- a pretend database with transactions ----
const CLASSES = ['Grade 1', 'Grade 2', 'Grade 3', 'Grade 4'];
const st = {};
function reset() {
  Object.assign(st, {
    today: '2026-02-10',
    schools: [{ id: 1, name: 'Mwangaza' }, { id: 2, name: 'Other School' }],
    classes: CLASSES.map((name, i) => ({ id: i + 1, name })),
    sc: [1, 2, 3, 4].map((c) => ({ school_id: 1, class_id: c, enabled: true })),
    years: [{ id: 10, year: 2026, is_current: true }, { id: 9, year: 2025, is_current: false }],
    runs: [],
    // Term 1 2026 is running; Term 3 2025 is the term before it
    terms: [
      { id: 31, academic_year_id: 9, term_number: 3, start_day: '2025-09-01', end_day: '2025-11-20' },
      { id: 11, academic_year_id: 10, term_number: 1, start_day: '2026-01-05', end_day: '2026-04-10' },
      { id: 12, academic_year_id: 10, term_number: 2, start_day: '2026-05-05', end_day: '2026-08-07' },
    ],
    streams: [{ id: 101, school_id: 1, class_id: 1, academic_year_id: 10, name: 'North' }, { id: 102, school_id: 1, class_id: 1, academic_year_id: 10, name: 'South' },
      { id: 103, school_id: 1, class_id: 2, academic_year_id: 9, name: 'Old' }],     // Grade 2 has NO stream this year; 103 is last year's
    students: [], contacts: [], choices: [], starting: [], ledger: [], fees: [], audit: [],
    nextId: 500, log: [], released: 0, snap: null, failContactInsert: false, forceDup: false,
  });
}
const snapshot = () => JSON.stringify({ students: st.students, contacts: st.contacts, choices: st.choices, starting: st.starting, ledger: st.ledger, nextId: st.nextId });
const restore = (s) => { const o = JSON.parse(s); st.students = o.students; st.contacts = o.contacts; st.choices = o.choices; st.starting = o.starting; st.ledger = o.ledger; st.nextId = o.nextId; };
const cid = (name) => st.classes.find((c) => c.name === name).id;
const fee = (term, cls, name, amount, mandatory = true, school = 1) => st.fees.push({ school_id: school, term_id: term, class_id: cls == null ? null : cid(cls), name, amount, is_mandatory: mandatory });
const ledgerOf = (sid, tid) => st.ledger.find((l) => l.student_id === sid && l.term_id === tid);
const studentBy = (adm) => st.students.find((s) => s.admission_no === adm);

const query = async (sql, p = []) => {
  const q = sql.replace(/\s+/g, ' ').trim();
  if (/^BEGIN/.test(q)) { st.log.push('BEGIN'); st.snap = snapshot(); return { rows: [] }; }
  if (/^COMMIT/.test(q)) { st.log.push('COMMIT'); st.snap = null; return { rows: [] }; }
  if (/^ROLLBACK/.test(q)) { st.log.push('ROLLBACK'); if (st.snap) restore(st.snap); st.snap = null; return { rows: [] }; }
  if (/pg_advisory_xact_lock/.test(q)) { st.log.push('LOCK ' + p.join(',')); return { rows: [] }; }
  if (/^CREATE TABLE IF NOT EXISTS promotion_runs/.test(q)) return { rows: [] };
  if (/^SELECT id, name FROM schools WHERE id = \$1/.test(q)) return { rows: st.schools.filter((s) => s.id === p[0]).map((s) => ({ ...s })) };
  if (/FROM promotion_runs pr JOIN academic_years ay/.test(q)) return { rows: [] };
  if (/FROM academic_years ORDER BY is_current DESC, year DESC LIMIT 1/.test(q)) {
    const y = [...st.years].sort((a, b) => (b.is_current - a.is_current) || (b.year - a.year))[0];
    return { rows: y ? [{ id: y.id, year: y.year }] : [] };
  }
  if (/FROM classes c LEFT JOIN school_classes sc ON sc.class_id = c.id AND sc.school_id = \$1 WHERE c.id = \$2/.test(q)) {
    const c = st.classes.find((x) => x.id === p[1]); if (!c) return { rows: [] };
    const row = st.sc.find((x) => x.school_id === p[0] && x.class_id === c.id);
    return { rows: [{ id: c.id, name: c.name, enabled: row ? row.enabled : false }] };
  }
  if (/^SELECT id, name FROM streams WHERE school_id = \$1 AND class_id = \$2 AND academic_year_id = \$3 ORDER BY lower\(name\)/.test(q)) {
    return { rows: st.streams.filter((s) => s.school_id === p[0] && s.class_id === p[1] && s.academic_year_id === p[2]).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())).map((s) => ({ id: s.id, name: s.name })) };
  }
  if (/^SELECT id, admission_no FROM students WHERE school_id = \$1 ORDER BY id DESC/.test(q)) {
    return { rows: st.students.filter((s) => s.school_id === p[0]).map((s) => ({ id: s.id, admission_no: s.admission_no })).sort((a, b) => b.id - a.id) };
  }
  if (/^SELECT id, admission_no, full_name FROM students WHERE school_id = \$1/.test(q)) {
    return { rows: st.students.filter((s) => s.school_id === p[0]).map((s) => ({ id: s.id, admission_no: s.admission_no, full_name: s.full_name })) };
  }
  if (/^SELECT to_char\(CURRENT_DATE/.test(q)) return { rows: [{ today: st.today }] };
  if (/FROM school_term_dates d JOIN terms t ON t.id = d.term_id JOIN academic_years ay/.test(q)) {
    return { rows: st.terms.map((t) => ({ id: t.id, term_number: t.term_number, academic_year_id: t.academic_year_id, year: st.years.find((y) => y.id === t.academic_year_id).year, start_day: t.start_day, end_day: t.end_day }))
      .sort((a, b) => (a.year - b.year) || (a.term_number - b.term_number)) };
  }
  // The pretend fee model: a row in st.fees = a fee line LOCKED for that school, term and class (school-wide fees no longer exist).
  const lockedRows = (school, term, cls) => st.fees.filter((f) => f.school_id === school && f.term_id === term && f.class_id === cls);
  if (/^SELECT i\.name, i\.amount, i\.is_mandatory FROM term_fee_locks l JOIN fee_template_items i/.test(q)) {
    return { rows: lockedRows(p[0], p[1], p[2]).map((f) => ({ name: f.name, amount: String(f.amount), is_mandatory: f.is_mandatory })) };
  }
  if (/^SELECT 1 FROM term_fee_locks WHERE school_id = \$1 AND term_id = \$2 AND class_id = \$3/.test(q)) {
    return { rows: lockedRows(p[0], p[1], p[2]).slice(0, 1).map(() => ({ '?column?': 1 })) };
  }
  if (/^SELECT t\.id, t\.version FROM term_fee_locks l JOIN fee_templates t/.test(q)) {
    return { rows: lockedRows(p[0], p[1], p[2]).length ? [{ id: p[0] * 1000000 + p[1] * 1000 + p[2], version: 1 }] : [] };
  }
  if (/^SELECT id, version FROM fee_templates WHERE school_id = \$1 AND class_id = \$2 AND term_number = \$3/.test(q)) return { rows: [] };
  if (/^SELECT name, amount, is_mandatory FROM fee_template_items WHERE template_id = \$1/.test(q)) {
    const id = p[0], school = Math.floor(id / 1000000), term = Math.floor((id % 1000000) / 1000), cls = id % 1000;
    return { rows: lockedRows(school, term, cls).map((f) => ({ name: f.name, amount: String(f.amount), is_mandatory: f.is_mandatory })) };
  }
  if (/^SELECT id, name, name_key FROM student_optional_choices WHERE student_id = \$1/.test(q)) return { rows: st.choices.filter((c) => c.student_id === p[0]).map((c) => ({ ...c })) };
  if (/^DELETE FROM student_optional_choices WHERE id = \$1/.test(q)) { st.choices = st.choices.filter((c) => c.id !== p[0]); return { rows: [] }; }
  if (/^SELECT opening_balance, fees_charged, amount_paid FROM student_term_ledger/.test(q)) {
    return { rows: st.ledger.filter((l) => l.student_id === p[0] && l.term_id === p[1]).map((l) => ({ opening_balance: String(l.opening_balance), fees_charged: String(l.fees_charged), amount_paid: String(l.amount_paid) })) };
  }
  if (/^SELECT amount FROM student_starting_balance WHERE student_id = \$1 AND term_id = \$2/.test(q)) {
    return { rows: st.starting.filter((s) => s.student_id === p[0] && s.term_id === p[1]).map((s) => ({ amount: String(s.amount) })) };
  }
  if (/^INSERT INTO student_term_ledger/.test(q)) {
    const row = ledgerOf(p[0], p[1]);
    if (row) { row.opening_balance = p[2]; row.fees_charged = p[3]; } else st.ledger.push({ student_id: p[0], term_id: p[1], opening_balance: p[2], fees_charged: p[3], amount_paid: 0 });
    return { rows: [] };
  }
  if (/^SELECT \* FROM terms WHERE academic_year_id = \$1 AND term_number = \$2/.test(q)) return { rows: st.terms.filter((t) => t.academic_year_id === p[0] && t.term_number === p[1]).map((t) => ({ ...t })) };
  if (/^SELECT t\.\* FROM terms t JOIN academic_years ay/.test(q)) {
    const year = st.years.find((y) => y.id === p[0]).year - 1;
    return { rows: st.terms.filter((t) => st.years.find((y) => y.id === t.academic_year_id).year === year && t.term_number === 3).map((t) => ({ ...t })) };
  }
  if (/^SELECT \* FROM terms WHERE id = \$1/.test(q)) return { rows: st.terms.filter((t) => t.id === p[0]).map((t) => ({ ...t })) };
  if (/^SELECT id, school_id, class_id FROM students WHERE status = 'active'/.test(q)) return { rows: st.students.filter((s) => s.status === 'active').map((s) => ({ id: s.id, school_id: s.school_id, class_id: s.class_id })) };
  if (/^INSERT INTO students/.test(q)) {
    if (st.forceDup) { const e = new Error('duplicate key'); e.code = '23505'; throw e; }
    const row = { id: st.nextId++, school_id: p[0], admission_no: p[1], full_name: p[2], class_id: p[3], stream_id: p[4], guardian_name: p[5], guardian_phone: p[6], status: 'active' };
    st.students.push(row); return { rows: [{ id: row.id, admission_no: row.admission_no, full_name: row.full_name, class_id: row.class_id, stream_id: row.stream_id }] };
  }
  if (/^INSERT INTO student_contacts/.test(q)) {
    if (st.failContactInsert) throw new Error('disk is full');
    st.contacts.push({ student_id: p[0], full_name: p[1], phone: p[2], relationship: p[3], sort_order: p[4] }); return { rows: [] };
  }
  if (/^INSERT INTO student_optional_choices/.test(q)) { st.choices.push({ id: st.nextId++, student_id: p[0], name: p[1], name_key: p[2] }); return { rows: [] }; }
  if (/^INSERT INTO student_starting_balance/.test(q)) { st.starting.push({ student_id: p[0], term_id: p[1], amount: p[2] }); return { rows: [] }; }
  if (/^INSERT INTO audit_log/.test(q)) { st.audit.push({ school_id: p[0], staff_id: p[1], action: p[2], detail: JSON.parse(p[3]) }); return { rows: [] }; }
  throw new Error('the pretend database does not know this query: ' + q.slice(0, 90));
};
const pool = { query, connect: async () => ({ query, release: () => { st.released++; } }) };
require.cache[require.resolve('../db/db')] = { id: require.resolve('../db/db'), filename: require.resolve('../db/db'), loaded: true, exports: { pool, initSchema: async () => {} } };
const svc = require('../services/studentAdmission');
const ledger = require('../services/feeLedger');

// what the automatic billing does for the students of every school in one term (the real engine is tested in test-fee-billing.js)
const chargeTerm = async (termId) => {
  const term = st.terms.find((t) => t.id === termId);
  const previous = await ledger.getPreviousTerm(term, pool);
  for (const s of st.students.filter((x) => x.status === 'active')) await ledger.chargeStudentForTerm(pool, { id: s.id, school_id: s.school_id, class_id: s.class_id }, term, previous);
};

const SCHOOL = 1;
const base = (extra = {}) => ({ admissionNo: '100', fullName: 'Amina Wanjiru', classId: cid('Grade 2'), ...extra });
const admit = (extra, opts) => svc.admitStudent(SCHOOL, base(extra), opts || {});

(async () => {
  // ================= reading what is typed =================
  reset();
  check('empty admission number refused', await fails(() => admit({ admissionNo: '  ' }), 400, /admission number/i));
  check('admission number with no digits refused', await fails(() => admit({ admissionNo: '///' }), 400, /only have digits/));
  check('letters are refused (digits, / and - only)', await fails(() => admit({ admissionNo: 'ADM100' }), 400, /No letters/) && await fails(() => admit({ admissionNo: '10A' }), 400, /No letters/) && await fails(() => admit({ admissionNo: '10 5' }), 400, /only have digits/));
  check('digits with / and - are fine', (await admit({ admissionNo: '2024/015' }, { dry: true })).student.admission_no === '2024/015' && (await admit({ admissionNo: '12-07' }, { dry: true })).student.admission_no === '12-07');
  check('name too short refused', await fails(() => admit({ fullName: 'A' }), 400, /full name/));
  check('no class refused', await fails(() => admit({ classId: undefined }), 400, /Choose the class/));
  check('class given as text refused', await fails(() => admit({ classId: 'Grade 2' }), 400, /Choose the class/));
  check('names are tidied (extra spaces)', (await admit({ fullName: '  Amina    Wanjiru ', admissionNo: ' 100 ' }, { dry: true })).student.full_name === 'Amina Wanjiru');

  // ================= which term a new student starts in =================
  const T = (id, n, s, e) => ({ id, term_number: n, year: 2026, start_day: s, end_day: e });
  const t1 = T(1, 1, '2026-01-05', '2026-04-10'), t2 = T(2, 2, '2026-05-05', '2026-08-07');
  check('term running now -> that term', svc.pickStartTerm([t1, t2], '2026-02-10').id === 1);
  check('first and last day of a term count as running', svc.pickStartTerm([t1, t2], '2026-01-05').id === 1 && svc.pickStartTerm([t1, t2], '2026-04-10').id === 1);
  check('school holiday -> the NEXT term', svc.pickStartTerm([t1, t2], '2026-04-20').id === 2);
  check('before any term -> the first coming term', svc.pickStartTerm([t1, t2], '2025-12-01').id === 1);
  check('after the last term -> the last term (nothing newer)', svc.pickStartTerm([t1, t2], '2026-09-01').id === 2);
  check('no term with dates -> none', svc.pickStartTerm([{ id: 9, term_number: 1, year: 2026, start_day: null, end_day: null }], '2026-02-10') === null);
  check('a running term with no end date still counts', svc.pickStartTerm([{ id: 5, term_number: 1, year: 2026, start_day: '2026-01-05', end_day: null }], '2026-06-01').id === 5);

  // ================= what a class offers =================
  reset();
  fee(11, 'Grade 2', 'Tuition', 50000);
  fee(11, 'Grade 2', 'Lunch', 3000, false);
  fee(11, 'Grade 2', 'Bus', 5000, false);
  fee(11, 'Grade 3', 'Swimming', 1000, false);  // another class: never shown
  fee(11, 'Grade 2', 'Tuition2', 100, true);    // mandatory: never offered as a choice
  fee(11, 'Grade 2', 'Lunch', 1, false, 2);     // another school: never shown
  let o = await svc.getAdmissionOptions(SCHOOL, cid('Grade 2'));
  check('options: class without streams -> no stream box', o.needs_stream === false && o.streams.length === 0, o);
  check('options: only this class\'s optional fees, one line per name', JSON.stringify(o.optional_fees) === JSON.stringify([{ name: 'Bus', amount: 5000 }, { name: 'Lunch', amount: 3000 }]), o.optional_fees);
  check('options: say which term the fees are for', o.term.id === 11 && o.term.term_number === 1);
  o = await svc.getAdmissionOptions(SCHOOL, cid('Grade 1'));
  check('options: class with streams -> needs a stream, lists them A-Z', o.needs_stream === true && o.streams.map((s) => s.name).join() === 'North,South', o);
  check('options: last year\'s stream is not offered', !(await svc.getAdmissionOptions(SCHOOL, cid('Grade 2'))).streams.some((s) => s.name === 'Old'));
  check('options: a class with no fees set offers no optional fees', (await svc.getAdmissionOptions(SCHOOL, cid('Grade 4'))).optional_fees.length === 0);
  st.sc.find((x) => x.class_id === cid('Grade 3')).enabled = false;
  check('options: a class switched off is refused', await fails(() => svc.getAdmissionOptions(SCHOOL, cid('Grade 3')), 409, /switched off/));
  check('options: unknown class -> 404', await fails(() => svc.getAdmissionOptions(SCHOOL, 999), 404, /no such class/));
  check('options: unknown school -> 404', await fails(() => svc.getAdmissionOptions(77, cid('Grade 1')), 404, /no school/));
  check('options: no class chosen -> 400', await fails(() => svc.getAdmissionOptions(SCHOOL, NaN), 400, /class first/));

  // ================= the happy path =================
  reset();
  fee(11, 'Grade 2', 'Tuition', 50000);
  fee(11, 'Grade 2', 'Lunch', 3000, false);
  fee(11, 'Grade 2', 'Bus', 5000, false);
  const r = await admit({ contacts: [{ name: 'Jane Wanjiru', phone: '0712 345 678', relationship: 'Mother' }, { name: 'Peter Kamau', phone: '+254 722-111-222' }], optionalFees: ['lunch', ' BUS '], startingBalance: '12,500' }, { staffId: 7 });
  const s1 = studentBy('100');
  check('student saved in the right school, class, active', s1 && s1.school_id === 1 && s1.class_id === cid('Grade 2') && s1.stream_id === null && s1.status === 'active');
  check('contacts saved in order, any phone spacing cleaned', st.contacts.length === 2 && st.contacts[0].phone === '0712345678' && st.contacts[1].phone === '+254722111222' && st.contacts[0].sort_order === 0 && st.contacts[1].sort_order === 1, st.contacts);
  check('first contact copied to the old guardian fields', s1.guardian_name === 'Jane Wanjiru' && s1.guardian_phone === '0712345678');
  check('choices saved with the SCHOOL\'s spelling', st.choices.map((c) => c.name).sort().join() === 'Bus,Lunch' && st.choices.every((c) => c.name_key === c.name.toLowerCase()), st.choices);
  check('starting balance saved for the starting term', st.starting.length === 1 && st.starting[0].term_id === 11 && st.starting[0].amount === 12500);
  const led = ledgerOf(s1.id, 11);
  check('billed straight away: fees 58,000 and opening 12,500', led && led.fees_charged === 58000 && led.opening_balance === 12500, led);
  check('result says what was billed', r.billed && r.billed.fees === 58000 && r.billed.owed === 70500 && r.term.started === true, r);
  check('one transaction, committed, connection given back', st.log.filter((x) => x === 'BEGIN').length === 1 && st.log.includes('COMMIT') && !st.log.includes('ROLLBACK') && st.released === 1);
  check('lined up per school (lock taken)', st.log.includes('LOCK 7771003,1'));
  check('audit line written with no phone numbers', st.audit.length === 1 && st.audit[0].action === 'student_admitted' && st.audit[0].staff_id === 7 && !JSON.stringify(st.audit[0]).match(/0712|254722/), st.audit);

  // ================= streams =================
  reset();
  check('class with streams: stream is a must', await fails(() => admit({ classId: cid('Grade 1') }), 400, /Choose a stream for Grade 1: North, South/));
  check('a stream from another class is refused', await fails(() => admit({ classId: cid('Grade 1'), streamId: 103 }), 400, /not part of Grade 1/));
  check('a stream that does not exist is refused', await fails(() => admit({ classId: cid('Grade 1'), streamId: 999 }), 400, /not part of Grade 1/));
  const ok1 = await admit({ classId: cid('Grade 1'), streamId: 102 });
  check('a real stream is accepted and shown by name', ok1.student.stream === 'South' && studentBy('100').stream_id === 102);
  reset();
  check('class with NO streams: giving a stream is refused', await fails(() => admit({ streamId: 101 }), 400, /no streams for 2026/));
  check('class with NO streams: admitted without one', (await admit()).student.stream === null);
  reset();
  st.sc.find((x) => x.class_id === cid('Grade 2')).enabled = false;
  check('a switched-off class cannot take students', await fails(() => admit(), 409, /Grade 2 is switched off/));
  check('unknown class refused', await fails(() => admit({ classId: 999 }), 404, /no such class/));

  // ================= admission numbers =================
  reset();
  await admit({ admissionNo: '343', fullName: 'First Student' });
  check('same number again -> 409 naming the student', await fails(() => admit({ admissionNo: '343', fullName: 'Other' }), 409, /already used by First Student/));
  check('"0343" clashes too (leading zeros ignored)', await fails(() => admit({ admissionNo: '0343' }), 409, /confused with/));
  check('"/343" style is not a clash trick: a number with a different shape is its own number', (await admit({ admissionNo: '2024/343', fullName: 'Shape' }, { dry: true })).student.admission_no === '2024/343');
  check('a different number is fine', (await admit({ admissionNo: '344', fullName: 'Second' })).student.admission_no === '344');
  check('numbers with several parts are compared whole', (await admit({ admissionNo: '12/34/01/17', fullName: 'Third' })).student.id > 0 && (await admit({ admissionNo: '12/34/01/18', fullName: 'Fourth' })).student.id > 0);
  st.students.push({ id: 900, school_id: 2, admission_no: '777', full_name: 'Other school kid', class_id: 1, status: 'active' });
  check('another school\'s numbers do not matter', (await admit({ admissionNo: '777', fullName: 'Mine' })).student.admission_no === '777');
  st.students.find((s) => s.admission_no === '343').status = 'transferred_out';
  check('a student who left still blocks the number', await fails(() => admit({ admissionNo: '343' }), 409, /already used by/));
  st.forceDup = true;
  check('a race on the database unique rule -> clear 409, not a server error', await fails(() => admit({ admissionNo: '999' }), 409, /already used in this school/));
  st.forceDup = false;

  // ================= contacts =================
  reset();
  check('no contacts at all is fine', (await admit()).contacts === 0 && studentBy('100').guardian_phone === null);
  reset();
  check('empty contact rows are ignored', (await admit({ contacts: [{ name: '', phone: ' ' }, {}, { name: 'Real Parent' }] })).contacts === 1);
  reset();
  check('a contact with only a name is fine (phone is not a must)', (await admit({ contacts: [{ name: 'Real Parent' }] })).contacts === 1 && st.contacts[0].phone === null);
  reset();
  check('a contact with only a phone is fine', (await admit({ contacts: [{ phone: '0711000111' }] })).contacts === 1 && st.contacts[0].full_name === null);
  check('a contact with only a relationship is refused', await fails(() => admit({ contacts: [{ relationship: 'Mother' }] }), 400, /Contact 1 needs a name or a phone/));
  check('a bad phone number is refused and says which contact', await fails(() => admit({ contacts: [{ name: 'A', phone: '0712345678' }, { name: 'B', phone: '12ab' }] }), 400, /Contact 2: "12ab" does not look like a phone number/));
  check('contacts must be a list', await fails(() => admit({ contacts: 'Jane' }), 400, /must be a list/));
  reset();
  check('ten contacts are fine', (await admit({ admissionNo: '1010', contacts: Array.from({ length: 10 }, (_, i) => ({ name: 'P' + i })) }, { dry: true })).contacts === 10);
  check('eleven contacts are refused', await fails(() => admit({ contacts: Array.from({ length: 11 }, (_, i) => ({ name: 'P' + i })) }), 400, /at most 10/));
  check('after a refused admission nothing was saved', st.students.length === 0 && st.contacts.length === 0);

  // ================= optional fees =================
  reset();
  fee(11, 'Grade 2', 'Tuition', 50000);
  fee(11, 'Grade 2', 'Lunch', 3000, false);
  check('a fee the class does not offer is refused, with what it offers', await fails(() => admit({ optionalFees: ['Bus'] }), 400, /Grade 2 does not offer "Bus"\. It offers: Lunch\./));
  check('same name twice counts once', (await admit({ optionalFees: ['Lunch', 'lunch', ' LUNCH '] })).optional_fees.length === 1);
  reset();
  check('a class with nothing set up says so', await fails(() => admit({ optionalFees: ['Lunch'] }), 400, /no optional fees set up for this term/));
  check('optional_fees must be a list of names', await fails(() => admit({ optionalFees: [5] }), 400, /list of fee names/));
  check('refused admission saved nothing', st.students.length === 0 && st.choices.length === 0);

  // ================= starting balance =================
  reset();
  fee(11, 'Grade 2', 'Tuition', 40000);
  check('starting balance: number ok', (await admit({ startingBalance: 8000 })).starting_balance === 8000);
  reset(); fee(11, 'Grade 2', 'Tuition', 40000);
  check('starting balance: money paid ahead (negative) ok', (await admit({ startingBalance: -2000 })).billed.owed === 38000);
  check('starting balance: 12.345 refused', await fails(() => admit({ admissionNo: '9001', startingBalance: 12.345 }), 400, /2 decimals/));
  check('starting balance: text refused', await fails(() => admit({ admissionNo: '9002', startingBalance: 'a lot' }), 400, /must be a number/));
  check('starting balance: absurd amount refused', await fails(() => admit({ admissionNo: '9003', startingBalance: 5e9 }), 400, /typing mistake/));
  reset(); fee(11, 'Grade 2', 'Tuition', 40000);
  await admit({ startingBalance: 0 });
  check('starting balance: zero or empty saves no row', st.starting.length === 0);

  // ================= term not started / holiday / no terms =================
  reset();
  fee(11, 'Grade 2', 'Tuition', 40000); fee(12, 'Grade 2', 'Tuition', 41000); fee(12, 'Grade 2', 'Lunch', 3100, false);
  st.today = '2026-04-20';      // holiday between Term 1 and Term 2
  const h = await admit({ optionalFees: ['Lunch'], startingBalance: 5000 });
  check('holiday: student starts in the NEXT term and sees that term\'s fees', h.term.id === 12 && h.term.started === false, h.term);
  check('holiday: not billed yet (the daily charge will do it on the first day)', h.billed === null && st.ledger.length === 0);
  check('holiday: starting balance waits for that term', st.starting[0].term_id === 12 && st.starting[0].amount === 5000);
  check('holiday: optional fee checked against the NEXT term\'s fees', st.choices.length === 1);
  reset();
  st.terms = [];
  check('no terms at all -> refused with the way to fix it', await fails(() => admit(), 409, /No term has dates yet.*Academic years & terms/));
  reset();
  st.years = [];
  check('no academic year -> refused', await fails(() => admit(), 409, /no academic year/));

  // ================= dry run and all-or-nothing =================
  reset(); fee(11, 'Grade 2', 'Tuition', 40000); fee(11, 'Grade 2', 'Lunch', 3000, false);
  const dry = await admit({ contacts: [{ name: 'P' }], optionalFees: ['Lunch'], startingBalance: 100 }, { dry: true });
  check('dry run: answers as if it happened', dry.dry === true && dry.student.admission_no === '100' && dry.billed.fees === 43000);
  check('dry run: saves NOTHING', st.students.length === 0 && st.contacts.length === 0 && st.choices.length === 0 && st.starting.length === 0 && st.ledger.length === 0 && st.audit.length === 0);
  check('dry run: rolled back', st.log.includes('ROLLBACK') && !st.log.includes('COMMIT'));
  reset(); fee(11, 'Grade 2', 'Tuition', 40000);
  st.failContactInsert = true;
  const crash = await rejects(() => admit({ contacts: [{ name: 'P' }], startingBalance: 100 }));
  check('a failure half-way undoes everything (no half-saved student)', !!crash && st.students.length === 0 && st.starting.length === 0 && st.ledger.length === 0 && st.audit.length === 0 && st.log.includes('ROLLBACK'), { crash: crash && crash.message, st: st.students.length });
  check('connection is given back even after a failure', st.released === 1);

  // ================= charging: optional fees follow the student up the classes =================
  reset();
  fee(11, 'Grade 2', 'Tuition', 50000); fee(11, 'Grade 2', 'Lunch', 3000, false); fee(11, 'Grade 2', 'Bus', 5000, false);
  await admit({ optionalFees: ['Lunch', 'Bus'], startingBalance: 10000 });
  const kid = studentBy('100');
  ledgerOf(kid.id, 11).amount_paid = 20000;                      // the parent paid something
  // next year: Grade 3 offers Lunch (new price) but NOT Bus. The student is promoted to Grade 3.
  st.terms.push({ id: 13, academic_year_id: 10, term_number: 3, start_day: '2026-09-01', end_day: '2026-11-20' });
  fee(12, 'Grade 3', 'Tuition', 52000); fee(12, 'Grade 3', 'Lunch', 3500, false); fee(12, 'Grade 3', 'Swimming', 1000, false);
  kid.class_id = cid('Grade 3');
  await chargeTerm(12);
  const l2 = ledgerOf(kid.id, 12);
  check('moved up: Lunch continues at the NEW class\'s price, Bus is dropped', l2.fees_charged === 52000 + 3500, l2);
  check('moved up: Bus is removed from his choices, Lunch stays', st.choices.map((c) => c.name).join() === 'Lunch', st.choices);
  // (the audit line for a dropped choice is written by billing itself: see test-fee-billing.js)
  check('moved up: what was left unpaid in the old term carries over', l2.opening_balance === 10000 + 58000 - 20000, l2);
  check('moved up: Swimming (never chosen) is not billed', l2.fees_charged === 55500);
  // run it again: same answer, payments untouched
  l2.amount_paid = 9000;
  await chargeTerm(12);
  check('running the charge again gives the same numbers and keeps payments', l2.fees_charged === 55500 && l2.opening_balance === 48000 && l2.amount_paid === 9000);
  // the starting balance survives a re-run in the term it belongs to
  await chargeTerm(11);
  check('re-running the starting term keeps the starting balance (no wipe)', ledgerOf(kid.id, 11).opening_balance === 10000, ledgerOf(kid.id, 11));
  // a class that has NO fees set yet must not eat the student's choices
  reset();
  fee(11, 'Grade 2', 'Tuition', 50000); fee(11, 'Grade 2', 'Lunch', 3000, false);
  await admit({ optionalFees: ['Lunch'] });
  const kid2 = studentBy('100'); kid2.class_id = cid('Grade 4');          // Grade 4 has nothing set up
  await chargeTerm(11);
  check('class with no fees set up: choices are kept (not wrongly dropped)', st.choices.length === 1 && ledgerOf(kid2.id, 11).fees_charged === 0, { c: st.choices, l: ledgerOf(kid2.id, 11) });
  // a class with fees but the student chose nothing
  reset(); fee(11, 'Grade 2', 'Tuition', 50000); fee(11, 'Grade 2', 'Lunch', 3000, false);
  await admit();
  check('no choices -> only mandatory fees', ledgerOf(studentBy('100').id, 11).fees_charged === 50000);
  // another school's student is charged by their own school's fees only
  reset(); fee(11, 'Grade 2', 'Tuition', 50000); fee(11, 'Grade 2', 'Tuition', 99999, true, 2);
  await admit();
  check('billing: another school\'s fees never leak in', ledgerOf(studentBy('100').id, 11).fees_charged === 50000);

  /* ---- the suggested next admission number ---- */
  {
    const { nextAdmissionNo } = require('../services/studentAdmission');
    const fake = (list) => ({ query: async () => ({ rows: list.map((n, i) => ({ id: list.length - i, admission_no: n })) }) });   // newest first
    check('next number: nobody yet -> 1', (await nextAdmissionNo(fake([]), 1)) === '1');
    check('next number: 214 -> 215', (await nextAdmissionNo(fake(['214', '213']), 1)) === '215');
    check('next number: leading zeros kept (2024/015 -> 2024/016)', (await nextAdmissionNo(fake(['2024/015']), 1)) === '2024/016');
    check('next number: 099 -> 100 keeps the width of the group it can', (await nextAdmissionNo(fake(['099']), 1)) === '100');
    check('next number: old numbers with letters are skipped when looking for the last one', (await nextAdmissionNo(fake(['ADM500', '41', 'ADM9']), 1)) === '42');
    check('next number: only letter-style numbers exist -> no suggestion', (await nextAdmissionNo(fake(['ADM500']), 1)) === null);
    check('next number: skips one that is taken or confusable', (await nextAdmissionNo(fake(['9', '10', '11']), 1)) === '12' && (await nextAdmissionNo(fake(['10', 'ADM11']), 1)) === '12');
  }

  console.log(failed ? `\n${failed} check(s) FAILED.` : '\nAll student admission checks pass.');
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });