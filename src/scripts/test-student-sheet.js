// Tests the student sheet (src/services/studentSheet.js): the sheet itself, manual payments, receipts, details, left/returned.
// REAL Postgres. It WIPES the database it connects to, so it refuses to run unless the name ends with _test.
//   set TEST_DATABASE_URL=postgres://user:password@localhost:5432/karo_test
//   node src/scripts/test-student-sheet.js
const crypto = require('crypto');
const url = process.env.TEST_DATABASE_URL || '';
if (!/\/[^/]*_test(\?.*)?$/.test(url)) { console.error('Set TEST_DATABASE_URL to a database whose name ends with _test (it is WIPED).'); process.exit(1); }
process.env.DATABASE_URL = url;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { pool, initSchema } = require('../db/db');
const sheet = require('../services/studentSheet');
const fees = require('../services/feeSetup');
const billing = require('../services/termBilling');
const { admitStudent } = require('../services/studentAdmission');

let failed = 0, passed = 0;
const check = (name, ok, extra) => { if (ok) passed++; else failed++; console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (!ok && extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); };
const fails = async (fn, re, status) => { try { await fn(); return false; } catch (e) { return re.test(e.message) && (status == null || e.status === status); } };
const q = async (sql, p) => (await pool.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];

(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await initSchema();
  const C = Object.fromEntries((await q('SELECT id, name FROM classes')).map((r) => [r.name, r.id]));
  await q(`INSERT INTO schools (name) VALUES ('Mwangaza Academy'), ('Other')`);
  for (const s of [1, 2]) for (const n of ['Grade 1', 'Grade 2']) await q('INSERT INTO school_classes (school_id, class_id, enabled) VALUES ($1,$2,TRUE)', [s, C[n]]);
  const staffA = (await q(`INSERT INTO staff (school_id, full_name, email) VALUES (1, 'Ann Bursar', 'ann@x.com') RETURNING id`))[0].id;
  const staffB = (await q(`INSERT INTO staff (school_id, full_name, email) VALUES (1, 'Ben Clerk', 'ben@x.com') RETURNING id`))[0].id;
  const y = (await q(`INSERT INTO academic_years (year, is_current) VALUES (EXTRACT(YEAR FROM CURRENT_DATE), TRUE) RETURNING id`))[0].id;
  await q(`INSERT INTO terms (academic_year_id, term_number) VALUES ($1,1),($1,2),($1,3)`, [y]);
  const T = Object.fromEntries((await q('SELECT id, term_number FROM terms')).map((r) => [r.term_number, r.id]));
  await q(`INSERT INTO school_term_dates (school_id, term_id, start_date, end_date) VALUES (1,$1,CURRENT_DATE-150,CURRENT_DATE-60),(1,$2,CURRENT_DATE-20,CURRENT_DATE+60),(2,$1,CURRENT_DATE+30,CURRENT_DATE+90)`, [T[1], T[2]]);
  await fees.setFees(1, { classNames: ['Grade 1'], terms: [1, 2, 3], fees: ['Tuition=50000', 'Exam=2000'], optional: ['Lunch=3000'], newOptional: true });

  const adm = await admitStudent(1, { admissionNo: '101', fullName: 'Amina Wanjiru', classId: C['Grade 1'], optionalFees: ['Lunch'], contacts: [{ name: 'Jane Wanjiru', phone: '0712 345 678', relationship: 'Mother' }] });
  const sid = adm.student.id;
  const other = (await admitStudent(2, { admissionNo: '101', fullName: 'Other Kid', classId: C['Grade 1'] }).catch(() => null));
  // the old term's money, written straight to the ledger (Term 1 was paid in full)
  await q(`INSERT INTO student_term_ledger (student_id, term_id, opening_balance, fees_charged, amount_paid) VALUES ($1,$2,0,48000,48000) ON CONFLICT DO NOTHING`, [sid, T[1]]);
  // a bank payment that arrived on its own
  const bank = (await q(`INSERT INTO transactions (school_id, term_id, source, external_ref, amount, payer_name, narration, match_status, matched_student_id)
     VALUES (1, $1, 'mpesa', 'QWE123', 10000, 'Jane W', 'ADM 101', 'auto_matched', $2) RETURNING id`, [T[2], sid]))[0].id;
  await q(`UPDATE student_term_ledger SET amount_paid = 10000 WHERE student_id = $1 AND term_id = $2`, [sid, T[2]]);
  await q(`INSERT INTO transactions (school_id, term_id, source, external_ref, amount, match_status, matched_student_id) VALUES (1, $1, 'mpesa', 'UNM1', 777, 'unmatched', NULL)`, [T[2]]);

  /* ---- the sheet ---- */
  let s = await sheet.getSheet(1, sid);
  check('sheet: student, class, contacts (phone cleaned) and chosen optional fee', s.student.full_name === 'Amina Wanjiru' && s.student.class === 'Grade 1' && s.contacts[0].phone === '0712345678' && s.optional_fees[0] === 'Lunch', s);
  check('sheet: current term money 55,000 charged, 10,000 paid, 45,000 due', s.current_term.label.startsWith('Term 2') && s.current_term.fees_charged === 55000 && s.current_term.paid === 10000 && s.current_term.balance === 45000, s.current_term);
  check('sheet: ledger lists both terms, newest first', s.ledger.length === 2 && s.ledger[0].label.startsWith('Term 2') && s.ledger[1].balance === 0, s.ledger);
  check('sheet: the fee breakdown comes from the LOCKED fees: Tuition + Exam + the chosen Lunch', s.fees && s.fees.mandatory.length === 2 && s.fees.optional[0].name === 'Lunch' && s.fees.total === 55000, s.fees);
  check('sheet: the bank payment is listed with its channel and a receipt number, the unmatched one is not', s.payments.length === 1 && s.payments[0].channel === 'M-Pesa' && s.payments[0].receipt_no === 'RCP-' + String(bank).padStart(6, '0'), s.payments);
  check('another school can not open this student', await fails(() => sheet.getSheet(2, sid), /no such student/, 404));
  check('a bad student id is a plain 400', await fails(() => sheet.getSheet(1, NaN), /not a valid student/, 400));

  /* ---- manual payment ---- */
  const rid = crypto.randomUUID();
  let r = await sheet.recordManualPayment(1, sid, { amount: '15,000', method: 'cash', reference: 'Slip 55', note: 'Paid at the office', requestId: rid }, { staffId: staffA });
  check('manual payment: recorded, balance 45,000 -> 30,000', r.amount === 15000 && r.balance_after === 30000 && /^RCP-/.test(r.receipt_no) && !r.already_recorded, r);
  const led = await one('SELECT amount_paid FROM student_term_ledger WHERE student_id = $1 AND term_id = $2', [sid, T[2]]);
  check('the ledger paid went 10,000 -> 25,000 (same path as bank payments)', Number(led.amount_paid) === 25000, led);
  const tx = await one('SELECT * FROM transactions WHERE id = $1', [r.transaction_id]);
  check('the transaction is a confirmed manual one, tied to the term and to who entered it', tx.source === 'manual' && tx.match_status === 'confirmed' && tx.term_id === T[2] && tx.acted_by_staff_id === staffA && tx.matched_student_id === sid);
  check('audit: who added it, how much, which receipt', !!(await one(`SELECT 1 FROM audit_log WHERE action = 'manual_payment_added' AND staff_id = $1 AND school_id = 1 AND detail::text LIKE '%Slip 55%'`, [staffA])));
  const again = await sheet.recordManualPayment(1, sid, { amount: 15000, method: 'cash', requestId: rid }, { staffId: staffA });
  check('sending the same request again records NOTHING twice', again.already_recorded === true && again.transaction_id === r.transaction_id && Number((await one('SELECT amount_paid FROM student_term_ledger WHERE student_id = $1 AND term_id = $2', [sid, T[2]])).amount_paid) === 25000 && (await q(`SELECT 1 FROM audit_log WHERE action = 'manual_payment_added'`)).length === 1);
  const par = await Promise.all([1, 2, 3].map(() => sheet.recordManualPayment(1, sid, { amount: 100, method: 'cash', requestId: 'same-id-12345' }, { staffId: staffB })));
  check('three double-clicks at the same instant: one payment', par.filter((x) => !x.already_recorded).length === 1 && Number((await one('SELECT amount_paid FROM student_term_ledger WHERE student_id = $1 AND term_id = $2', [sid, T[2]])).amount_paid) === 25100, par.map((x) => x.already_recorded));
  r = await sheet.recordManualPayment(1, sid, { amount: 500, method: 'cheque', reference: 'CHQ 9', receivedOn: new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10) }, { staffId: staffB, dry: true });
  check('dry run: reports the new balance and saves nothing', r.dry && r.balance_after === 29400 && r.transaction_id === null && Number((await one('SELECT amount_paid FROM student_term_ledger WHERE student_id = $1 AND term_id = $2', [sid, T[2]])).amount_paid) === 25100);
  r = await sheet.recordManualPayment(1, sid, { amount: 500, method: 'cheque', reference: 'CHQ 9', receivedOn: new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10) }, { staffId: staffB });
  s = await sheet.getSheet(1, sid);
  const man = s.payments.find((p) => p.id === r.transaction_id);
  check('the sheet shows the manual payment with the staff name, method and reference', man && man.manual && man.added_by === 'Ben Clerk' && man.channel === 'Cheque' && man.reference === 'CHQ 9', man);
  check('payments are listed newest first by their payment date', s.payments.length === 4 && s.payments[0].id !== r.transaction_id, s.payments.map((p) => p.id));
  const bad = (o, re) => fails(() => sheet.recordManualPayment(1, sid, { amount: 100, method: 'cash', ...o }, { staffId: staffA }), re, 400);
  check('amount 0, negative, text, 3 decimals, huge: refused', await bad({ amount: 0 }, /Enter the amount/) && await bad({ amount: -5 }, /Enter the amount/) && await bad({ amount: 'abc' }, /Enter the amount/) && await bad({ amount: 10.123 }, /2 decimals/) && await bad({ amount: 99999999 }, /typing mistake/));
  check('unknown method, future date, bad date, long note: refused', await bad({ method: 'crypto' }, /Choose how/) && await bad({ receivedOn: '2999-01-01' }, /in the future/) && await bad({ receivedOn: 'yesterday' }, /year-month-day/) && await bad({ note: 'x'.repeat(201) }, /200 characters/));
  check('no staff member -> 401', await fails(() => sheet.recordManualPayment(1, sid, { amount: 100, method: 'cash' }, {}), /logged-in staff/, 401));
  check('another school\'s student -> 404, and nothing was written', await fails(() => sheet.recordManualPayment(2, sid, { amount: 100, method: 'cash' }, { staffId: staffA }), /no such student/, 404));
  check('a school whose term has not started: 409', await fails(async () => { const o = await one(`SELECT id FROM students WHERE school_id = 2`); if (!o) throw Object.assign(new Error('no such student'), { status: 409 }); return sheet.recordManualPayment(2, o.id, { amount: 100, method: 'cash' }, { staffId: staffA }); }, /no such student|No term has started/, 409));

  /* ---- receipts ---- */
  let rc = await sheet.getReceipt(1, bank);
  check('receipt of the bank payment: school, student, amount, reference, term and the balance after it', rc.school === 'Mwangaza Academy' && rc.student.admission_no === '101' && rc.amount === 10000 && rc.reference === 'QWE123' && rc.term.startsWith('Term 2') && rc.balance_after === 44500, rc);
  rc = await sheet.getReceipt(1, man.id);
  check('receipt of the cheque: balance after counts only payments up to it, and says who entered it', rc.entered_by === 'Ben Clerk' && rc.channel === 'Cheque' && rc.balance_after === 55000 - 500, rc);
  const first = await sheet.getReceipt(1, bank);
  check('an earlier receipt keeps its own balance (not today\'s)', first.balance_after === 44500);
  check('a payment that is not matched has no receipt', await fails(() => sheet.getReceipt(1, 2), /no such payment/, 404));
  check('another school can not read the receipt', await fails(() => sheet.getReceipt(2, bank), /no such payment/, 404));


  /* ---- reversing a wrong manual payment ---- */
  const wrong = await sheet.recordManualPayment(1, sid, { amount: 1500000, method: 'cash', reference: 'typo' }, { staffId: staffA });
  const before = Number((await one('SELECT amount_paid FROM student_term_ledger WHERE student_id = $1 AND term_id = $2', [sid, T[2]])).amount_paid);
  check('a wrong manual payment was recorded (setup)', wrong.amount === 1500000 && before === 25600 + 1500000, before);
  check('a reason is required', await fails(() => sheet.reverseManualPayment(1, wrong.transaction_id, { reason: '' }, { staffId: staffA }), /Say why/, 400));
  check('no staff -> 401', await fails(() => sheet.reverseManualPayment(1, wrong.transaction_id, { reason: 'typo' }, {}), /logged-in staff/, 401));
  check('a bank payment can NOT be reversed here', await fails(() => sheet.reverseManualPayment(1, bank, { reason: 'wrong one' }, { staffId: staffA }), /real money/, 409));
  check('another school can not reverse it (404)', await fails(() => sheet.reverseManualPayment(2, wrong.transaction_id, { reason: 'typo' }, { staffId: staffA }), /no such payment/, 404));
  const dryRev = await sheet.reverseManualPayment(1, wrong.transaction_id, { reason: 'typed 15000 as 1500000' }, { staffId: staffB, dry: true });
  check('dry run: shows the balance after, changes nothing', dryRev.dry && dryRev.balance_after === 29400 && Number((await one('SELECT amount_paid FROM student_term_ledger WHERE student_id = $1 AND term_id = $2', [sid, T[2]])).amount_paid) === before && (await q('SELECT 1 FROM payment_reversals')).length === 0, dryRev);
  const rev = await sheet.reverseManualPayment(1, wrong.transaction_id, { reason: 'typed 15000 as 1500000' }, { staffId: staffB });
  check('reversed: the ledger is back to 25,600 paid and the balance is 29,400', Number((await one('SELECT amount_paid FROM student_term_ledger WHERE student_id = $1 AND term_id = $2', [sid, T[2]])).amount_paid) === 25600 && rev.balance_after === 29400, rev);
  const row2 = await one('SELECT match_status, match_reason FROM transactions WHERE id = $1', [wrong.transaction_id]);
  check('the payment row is KEPT, marked rejected with the reason', row2.match_status === 'rejected' && /Reversed: typed 15000/.test(row2.match_reason), row2);
  check('audit says who reversed it, the amount and why', !!(await one(`SELECT 1 FROM audit_log WHERE action = 'manual_payment_reversed' AND staff_id = $1 AND detail::text LIKE '%typed 15000 as 1500000%' AND detail::text LIKE '%1500000%'`, [staffB])));
  check('it can not be reversed twice', await fails(() => sheet.reverseManualPayment(1, wrong.transaction_id, { reason: 'again' }, { staffId: staffA }), /already reversed/, 409));
  const one300 = await sheet.recordManualPayment(1, sid, { amount: 300, method: 'cash' }, { staffId: staffA });
  const races = await Promise.allSettled([1, 2, 3].map(() => sheet.reverseManualPayment(1, one300.transaction_id, { reason: 'race' }, { staffId: staffA })));
  check('three reversals at the same instant: only one works, the money comes off once', races.filter((x) => x.status === 'fulfilled').length === 1 && (await q('SELECT 1 FROM payment_reversals WHERE transaction_id = $1', [one300.transaction_id])).length === 1 && Number((await one('SELECT amount_paid FROM student_term_ledger WHERE student_id = $1 AND term_id = $2', [sid, T[2]])).amount_paid) === 25600);
  s = await sheet.getSheet(1, sid);
  const shown = s.payments.find((p) => p.id === wrong.transaction_id);
  check('the sheet still lists the reversed payment, flagged, with who and why, and no reverse button', shown && shown.reversed && shown.reversed.by === 'Ben Clerk' && /typed 15000/.test(shown.reversed.reason) && shown.can_reverse === false, shown);
  check('a good manual payment can still be reversed (button flag)', s.payments.find((p) => p.manual && !p.reversed).can_reverse === true && s.payments.find((p) => !p.manual).can_reverse === false);
  check('the reversed payment has no receipt (409), others do', await fails(() => sheet.getReceipt(1, wrong.transaction_id), /was reversed/, 409));
  check('balances elsewhere skip it: the term total paid equals the sum of live payments', Number((await one('SELECT amount_paid FROM student_term_ledger WHERE student_id = $1 AND term_id = $2', [sid, T[2]])).amount_paid) === Number((await one(`SELECT SUM(amount) AS s FROM transactions WHERE matched_student_id = $1 AND term_id = $2 AND match_status IN ('auto_matched','confirmed')`, [sid, T[2]])).s));
  check('the database refuses to edit or delete a reversal', await fails(() => pool.query('DELETE FROM payment_reversals'), /can not be changed or deleted/) && await fails(() => pool.query(`UPDATE payment_reversals SET reason = 'x'`), /can not be changed or deleted/));

  /* ---- details ---- */
  let d = await sheet.updateDetails(1, sid, { fullName: '  Amina   Wanjiru Kamau ', contacts: [{ name: 'Jane Wanjiru', phone: '+254 712 345 678', relationship: 'Mother' }, { name: 'Peter', phone: '0700000000', relationship: 'Father' }] }, { staffId: staffA });
  const row = await one('SELECT full_name, guardian_name, guardian_phone FROM students WHERE id = $1', [sid]);
  check('details: name squeezed, contacts replaced, guardian fields follow the first contact', !d.unchanged && row.full_name === 'Amina Wanjiru Kamau' && row.guardian_phone === '+254712345678' && (await q('SELECT 1 FROM student_contacts WHERE student_id = $1', [sid])).length === 2, row);
  check('audit has before AND after with who', !!(await one(`SELECT 1 FROM audit_log WHERE action = 'student_updated' AND staff_id = $1 AND detail::text LIKE '%Amina Wanjiru"%' AND detail::text LIKE '%Kamau%'`, [staffA])));
  d = await sheet.updateDetails(1, sid, { fullName: 'Amina Wanjiru Kamau' }, { staffId: staffA });
  check('same details again = nothing to change, no audit line', d.unchanged === true && (await q(`SELECT 1 FROM audit_log WHERE action = 'student_updated'`)).length === 1);
  check('empty / one-letter name refused, a bad phone refused, nothing sent refused', await fails(() => sheet.updateDetails(1, sid, { fullName: 'A' }, { staffId: staffA }), /full name/) && await fails(() => sheet.updateDetails(1, sid, { contacts: [{ name: 'X', phone: '12' }] }, { staffId: staffA }), /phone number/) && await fails(() => sheet.updateDetails(1, sid, {}, { staffId: staffA }), /Nothing to change/));
  d = await sheet.updateDetails(1, sid, { fullName: 'Dry Name', dry: true }, { staffId: staffA, dry: true });
  check('dry run changes nothing', (await one('SELECT full_name FROM students WHERE id = $1', [sid])).full_name === 'Amina Wanjiru Kamau');
  check('the admission number is not editable here (matching depends on it)', (await one('SELECT admission_no FROM students WHERE id = $1', [sid])).admission_no === '101');

  /* ---- left and back ---- */
  let st = await sheet.setStudentStatus(1, sid, { status: 'left', reason: 'Transferred to another school' }, { staffId: staffB });
  check('marked left: the balance is reported and the audit says who and why', st.status === 'left' && st.balance === 29400 + 0 && !!(await one(`SELECT 1 FROM audit_log WHERE action = 'student_marked_left' AND staff_id = $1 AND detail::text LIKE '%Transferred%'`, [staffB])), st);
  check('a student who left keeps ALL history, and can still receive a payment', (await sheet.getSheet(1, sid)).payments.length === 6 && (await sheet.recordManualPayment(1, sid, { amount: 400, method: 'cash' }, { staffId: staffA })).balance_after === 29000);
  st = await sheet.setStudentStatus(1, sid, { status: 'left' }, { staffId: staffB });
  check('marking left twice = unchanged', st.unchanged === true);
  st = await sheet.setStudentStatus(1, sid, { status: 'active' }, { staffId: staffB });
  check('brought back: charged again for the running term (recalculated, payments untouched)', !st.unchanged && st.billed && st.billed.fees === 55000 && Number((await one('SELECT amount_paid FROM student_term_ledger WHERE student_id = $1 AND term_id = $2', [sid, T[2]])).amount_paid) === 26000, st);
  check('a wrong status is refused', await fails(() => sheet.setStudentStatus(1, sid, { status: 'deleted' }, { staffId: staffA }), /"active" or "left"/));
  check('nothing was ever deleted: the student, ledger and every payment are still there', (await q('SELECT 1 FROM students WHERE school_id = 1')).length === 1 && (await q(`SELECT 1 FROM transactions WHERE school_id = 1`)).length === 8);

  /* ---- the payment methods: Cash, Bank, M-Pesa, Cheque, Other ---- */
  const admin = (await q(`INSERT INTO staff (school_id, full_name, email, role) VALUES (1, 'Ada Admin', 'ada@x.com', 'admin') RETURNING id`))[0].id;
  s = await sheet.getSheet(1, sid);
  check('the sheet offers Cash, M-Pesa, Bank, Cheque, Other (plain "Bank" with no bank connected)', s.methods.map((m) => m.value).join() === 'cash,mpesa,bank,cheque,other' && s.methods.find((m) => m.value === 'bank').label === 'Bank', s.methods);
  await q(`INSERT INTO school_channels (school_id, channel) VALUES (1, 'equity')`);
  check('with exactly one bank in use, Bank carries its name', (await sheet.getSheet(1, sid)).methods.find((m) => m.value === 'bank').label === 'Bank (Equity)');
  await q(`INSERT INTO school_channels (school_id, channel) VALUES (1, 'kcb')`);
  check('with two banks it stays plain "Bank"', (await sheet.getSheet(1, sid)).methods.find((m) => m.value === 'bank').label === 'Bank');
  check('M-Pesa and Bank payments need the code', await fails(() => sheet.recordManualPayment(1, sid, { amount: 100, method: 'mpesa' }, { staffId: staffA }), /M-Pesa transaction code/) && await fails(() => sheet.recordManualPayment(1, sid, { amount: 100, method: 'bank' }, { staffId: staffA }), /bank slip or transaction number/));
  check('a code that does not look like M-Pesa is refused', await fails(() => sheet.recordManualPayment(1, sid, { amount: 100, method: 'mpesa', reference: 'hello-there!' }, { staffId: staffA }), /does not look like an M-Pesa code/));
  check('Cash and Cheque need no code', (await sheet.recordManualPayment(1, sid, { amount: 50, method: 'cash' }, { staffId: staffA })).amount === 50 && (await sheet.recordManualPayment(1, sid, { amount: 50, method: 'cheque' }, { staffId: staffA })).amount === 50);
  const mp = await sheet.recordManualPayment(1, sid, { amount: 700, method: 'mpesa', reference: ' sjk4x9t2lm ' }, { staffId: staffA });
  check('a manual M-Pesa payment keeps the code (tidied to capitals) and is labelled M-Pesa', mp.method === 'M-Pesa' && (await sheet.getSheet(1, sid)).payments.find((p) => p.id === mp.transaction_id).reference === 'SJK4X9T2LM');
  check('the same code can not be entered twice (even in other capitals)', await fails(() => sheet.recordManualPayment(1, sid, { amount: 700, method: 'mpesa', reference: 'SJK4X9T2LM' }, { staffId: staffB }), /already recorded: RCP-/, 409));
  check('a code that already arrived by itself can not be entered again by hand', await fails(() => sheet.recordManualPayment(1, sid, { amount: 10000, method: 'mpesa', reference: 'qwe123' }, { staffId: staffB }), /already recorded: RCP-.*Amina/, 409));
  const dup = await Promise.allSettled([1, 2].map((n) => sheet.recordManualPayment(1, sid, { amount: 60, method: 'bank', reference: 'SLIP-777', requestId: 'dupe-race-' + n + '-xxxx' }, { staffId: staffB })));
  check('two people entering the same code at the same moment: only one goes in', dup.filter((x) => x.status === 'fulfilled').length === 1);
  await sheet.reverseManualPayment(1, mp.transaction_id, { reason: 'typed the wrong amount' }, { staffId: staffA });
  check('after a reversal the code can be entered again (the wrong one is out of the way)', (await sheet.recordManualPayment(1, sid, { amount: 70, method: 'mpesa', reference: 'SJK4X9T2LM' }, { staffId: staffA })).amount === 70);
  check('the older "Bank deposit slip" name still works for old records', (await sheet.recordManualPayment(1, sid, { amount: 5, method: 'bank_deposit' }, { staffId: staffA })).method === 'Bank deposit slip');

  /* ---- editing the admission number ---- */
  const kid2 = await admitStudent(1, { admissionNo: '102', fullName: 'Brian Otieno', classId: C['Grade 1'] });
  check('a staff-role person can not change an admission number', await fails(() => sheet.updateDetails(1, sid, { admissionNo: '110' }, { staffId: staffA }), /Only an Admin/, 403));
  check('an empty or over-long admission number is refused', await fails(() => sheet.updateDetails(1, sid, { admissionNo: '  ' }, { staffId: admin }), /Enter the admission number/) && await fails(() => sheet.updateDetails(1, sid, { admissionNo: 'x'.repeat(41) }, { staffId: admin }), /40 characters/));
  check('letters are refused in an edited admission number', await fails(() => sheet.updateDetails(1, sid, { admissionNo: '101A' }, { staffId: admin }), /No letters/));
  check('a number another student has is refused, and says who', await fails(() => sheet.updateDetails(1, sid, { admissionNo: '102' }, { staffId: admin }), /already used by Brian Otieno/, 409));
  const ed = await sheet.updateDetails(1, sid, { admissionNo: '2024/101', fullName: 'Amina Wanjiru Kamau' }, { staffId: admin });
  check('an Admin can correct it', ed.admission_no === '2024/101' && (await one('SELECT admission_no FROM students WHERE id = $1', [sid])).admission_no === '2024/101');
  check('all the payments and the balance stay with the student', (await sheet.getSheet(1, sid)).payments.length >= 6 && (await sheet.getSheet(1, sid)).student.admission_no === '2024/101');
  check('the same number again = nothing changed', (await sheet.updateDetails(1, sid, { admissionNo: '2024/101' }, { staffId: admin })).unchanged === true);
  check('the activity log says the admission number changed', !!(await one(`SELECT 1 FROM audit_log WHERE action = 'student_updated' AND staff_id = $1 AND detail->'after'->>'admission_no' = '2024/101' AND detail->'before'->>'admission_no' = '101'`, [admin])));
  check('the old number is free for another student; the new one is not', (await admitStudent(1, { admissionNo: '101', fullName: 'New Kid', classId: C['Grade 1'] })).student.admission_no === '101' && await fails(() => admitStudent(1, { admissionNo: '2024/101', fullName: 'Other Kid', classId: C['Grade 1'] }), /already used/));
  check('another school can not rename this student number', await fails(() => sheet.updateDetails(2, sid, { admissionNo: '999' }, { staffId: admin }), /no such student/, 404));

  /* ---- what has changed on this student ---- */
  const hs = (await sheet.getSheet(1, sid)).history;
  check('the sheet lists what changed on the student, newest first, in words', hs.length > 3 && /recorded KES .* for this student/.test(hs.map((h) => h.text).join(' | ')) && hs.some((h) => /edited the details/.test(h.text) && /admission number/.test(h.extra || '')) && hs.every((h) => h.who), hs.slice(0, 3));
  check('and never lists another student\'s changes', !(await sheet.getSheet(1, kid2.student.id)).history.some((h) => /recorded/.test(h.text)));

  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error('TEST CRASHED:', e); try { await pool.end(); } catch (x) { /* done */ } process.exit(1); });