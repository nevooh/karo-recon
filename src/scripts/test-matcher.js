// Offline tests for the admission-number-only matcher. Run: node src/scripts/test-matcher.js
const { matchTransaction, tokenize, splitAdmission } = require('../matching/matcher');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra !== undefined ? '-> ' + JSON.stringify(extra) : ''); }
}
const S = (id, adm, name) => ({ id, admission_no: adm, full_name: name || 'Student ' + id });
const run = (ref, students, amount = 7000) => matchTransaction({ narration: ref, amount }, students);

// ---- School A saves "ADM343" style ----
const A = [S(1, 'ADM343'), S(2, 'ADM344'), S(3, 'ADM3430'), S(4, 'ADM5')];
for (const ref of ['ADM343', 'adm343', 'ADM 343', 'adm/343', 'Adm-343 fees', '343', 'fees for 343 term 2', '343ADM', 'ADM0343']) {
  const r = run(ref, A);
  check(`A: "${ref}" -> ADM343`, r.status === 'auto_matched' && r.student.id === 1, r);
}
// ---- School B saves plain "343" style ----
const B = [S(1, '343'), S(2, '344'), S(3, '3430'), S(4, '5')];
for (const ref of ['343', 'ADM343', 'adm 343', 'Admission no 343', '343 school fees']) {
  const r = run(ref, B);
  check(`B: "${ref}" -> 343`, r.status === 'auto_matched' && r.student.id === 1, r);
}
// ---- numbers must match whole, never a piece of a bigger number ----
check('ADM3430 does NOT match 343', run('ADM3430', A).student.id === 3);
check('ADM1010 does NOT match ADM101', run('ADM1010', [S(1, 'ADM101'), S(2, 'ADM102')]).status === 'unmatched');
check('1343 does NOT match 343', run('1343', B).status === 'unmatched');
// ---- no names / phones / guessing ----
const N = [{ id: 1, admission_no: 'ADM101', full_name: 'Mary Akinyi', guardian_name: 'Rose Akinyi', guardian_phone: '254711000003' }];
check('name in reference is ignored', run('Mary Akinyi fees', N).status === 'unmatched');
check('empty reference -> unmatched', run('', N).status === 'unmatched');
check('null reference -> unmatched', run(null, N).status === 'unmatched');
check('words only -> unmatched', run('school fees', N).status === 'unmatched');
check('no percentage anywhere', !('confidence' in run('ADM101', N)) && !('score' in run('ADM101', N)));
// ---- short numbers ----
check('"5" alone -> student 5', run('5', B).student && run('5', B).student.id === 4);
check('"ADM5" -> student ADM5', run('ADM5', A).student.id === 4);
check('"term 2 fees" does not catch student 2', run('term 2 fees', [S(9, '2')]).status === 'unmatched');
check('"2 kids" does not catch student 2', run('2 kids', [S(9, 'ADM2')]).status === 'unmatched');
// ---- two students found -> a person decides ----
const two = run('ADM343 and ADM344', A);
check('two numbers -> needs_review with 2 candidates', two.status === 'needs_review' && two.candidates.length === 2 && two.student === null, two);
check('candidate has student_id/full_name/admission_no', two.candidates[0].student_id && two.candidates[0].full_name && two.candidates[0].admission_no);
const dup = run('343', [S(1, 'ADM343'), S(2, 'KAB343')]);
check('same number, two prefixes -> needs_review', dup.status === 'needs_review' && dup.candidates.length === 2, dup);
// ---- number equals the amount paid ----
const same = run('5000', [S(1, '5000')], 5000);
check('number equals amount -> needs_review, not auto', same.status === 'needs_review' && same.student && same.student.id === 1, same);
check('same number but different amount -> auto', run('5000', [S(1, '5000')], 7000).status === 'auto_matched');
// ---- long / odd admission formats ----
const L = [S(1, 'CM/M/1234/01/17'), S(2, '12345K24810')];
check('slash format with full reference', run('cm/m/1234/01/17', L).student.id === 1);
check('slash format without prefix', run('1234/01/17', L).student.id === 1);
check('1234 alone does not match slash format', run('1234', L).status === 'unmatched');
check('letter-in-middle format', run('12345K24810', L).student.id === 2);
// ---- helpers ----
check('tokenize', JSON.stringify(tokenize('Adm/0343 fees')) === '["ADM","343","FEES"]', tokenize('Adm/0343 fees'));
check('splitAdmission ADM343', JSON.stringify(splitAdmission('ADM343')) === '{"prefix":["ADM"],"key":["343"]}');
check('no students -> unmatched', run('ADM1', []).status === 'unmatched');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
