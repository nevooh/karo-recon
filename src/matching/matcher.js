/**
 * Karo Recon matcher - ADMISSION NUMBER ONLY.
 *
 * No names, no phone numbers, no amounts, no percentages.
 * A payment is either matched, needs a person, or is unmatched.
 *
 * How it reads a number (this is the whole idea):
 *   Schools save the same student in different ways: "ADM343", "343",
 *   "adm/343". Parents also type it in different ways: "ADM343", "343",
 *   "Adm 343 fees", "343-term2". So we only compare the NUMBER part:
 *   the letters in front (ADM, KAB ...) are just a prefix and are ignored.
 *
 * Results:
 *   auto_matched : exactly ONE student's number was found in the reference
 *   needs_review : a person must decide (two students found, or the
 *                  number looks like it might be the money amount)
 *   unmatched    : no admission number found at all
 *
 * Returns { status, student, reason, candidates }
 */

// Cut text into "pieces". Letters and digits are split apart, symbols and
// spaces are dropped, everything is upper case, and leading zeros of
// numbers are removed:   "Adm/0343 fees" -> ["ADM","343","FEES"]
function tokenize(text) {
  if (text == null) return [];
  return String(text)
    .toUpperCase()
    .replace(/([A-Z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Z])/g, '$1 $2')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((t) => (/^\d+$/.test(t) ? (t.replace(/^0+/, '') || '0') : t));
}

const isNum = (t) => /^\d+$/.test(t);

// Split a student's admission number into { prefix, key }.
//   ADM343            -> prefix ["ADM"],       key ["343"]
//   343               -> prefix [],            key ["343"]
//   CM/M/1234/01/17   -> prefix ["CM","M"],    key ["1234","1","17"]
// If it has no digits at all (rare), the whole thing is the key.
function splitAdmission(admissionNo) {
  const tokens = tokenize(admissionNo);
  let i = 0;
  while (i < tokens.length && !isNum(tokens[i])) i++;
  if (i === tokens.length) return { prefix: [], key: tokens };
  return { prefix: tokens.slice(0, i), key: tokens.slice(i) };
}

// Is the list `small` found inside the list `big`, side by side, in order?
function containsRun(big, small) {
  if (small.length === 0 || small.length > big.length) return false;
  for (let i = 0; i <= big.length - small.length; i++) {
    let ok = true;
    for (let j = 0; j < small.length; j++) {
      if (big[i + j] !== small[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// Check ONE student against the reference. Returns null (no match) or
// { amountLookalike: true/false }.
function checkStudent(refTokens, amount, student) {
  const { prefix, key } = splitAdmission(student.admission_no);
  if (key.length === 0) return null;
  if (!containsRun(refTokens, key)) return null;

  const singleNumber = key.length === 1 && isNum(key[0]);

  // Very short numbers (1-2 digits, like "5" or "12") are too easy to
  // find by accident ("term 2", "2 kids"). They only count when the
  // reference is JUST the number (or the student's own prefix + number).
  if (singleNumber && key[0].length <= 2) {
    const justNumber = sameList(refTokens, key);
    const prefixPlusNumber = sameList(refTokens, [...prefix, ...key]);
    if (!justNumber && !prefixPlusNumber) return null;
  }

  // If the number is the same as the money paid (reference "5000" and
  // 5000 paid) it may be the amount, not the student. A person checks.
  const amountLookalike = singleNumber && amount != null &&
    String(Math.round(Number(amount))) === key[0];

  return { amountLookalike };
}

function toCandidate(student) {
  return { student_id: student.id, full_name: student.full_name, admission_no: student.admission_no };
}

function matchTransaction(txn, students) {
  const refTokens = tokenize(txn.narration);

  if (refTokens.length === 0) {
    return { status: 'unmatched', student: null, reason: 'Payment had no reference', candidates: null };
  }

  const found = [];
  for (const student of students) {
    const hit = checkStudent(refTokens, txn.amount, student);
    if (hit) found.push({ student, ...hit });
  }

  if (found.length === 0) {
    return { status: 'unmatched', student: null, reason: 'No admission number found in the payment reference', candidates: null };
  }

  if (found.length > 1) {
    return {
      status: 'needs_review',
      student: null,
      reason: `Reference contains ${found.length} admission numbers - a person must pick`,
      candidates: found.map((f) => toCandidate(f.student)),
    };
  }

  const only = found[0];
  if (only.amountLookalike) {
    return {
      status: 'needs_review',
      student: only.student,
      reason: `Admission number ${only.student.admission_no} found, but it is the same as the amount paid - please confirm`,
      candidates: null,
    };
  }

  return {
    status: 'auto_matched',
    student: only.student,
    reason: `Admission number ${only.student.admission_no} found in payment reference`,
    candidates: null,
  };
}

module.exports = { matchTransaction, tokenize, splitAdmission };
