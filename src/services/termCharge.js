/**
 * Bills ONE school for ONE term you name. Safe to run again.
 *
 * Why it exists: the daily charge bills every school at once on the first day of a term. This is for the
 * times you must bill ONE school yourself: a school that joined mid-term, fees set after the term started,
 * a price corrected, or students admitted before their class had fees.
 *
 * The safety rules (each one is checked, and tested):
 *   - Only the school you name is touched. Other schools are never read or written.
 *   - Only the term you name (year + term number) is billed. There is no "current term" guessing.
 *   - The term must have STARTED, and must be the LATEST term that has started. Billing an older term
 *     would rewrite history that later balances already carried forward, so older terms are locked.
 *   - The school must have fees set for that term. With none, nothing is billed.
 *   - Only ACTIVE students are billed. A student with no class is skipped and reported, never guessed.
 *   - Payments are never touched (amount_paid stays exactly as it is). Fees and opening balance are
 *     recalculated from the fee lists, the previous term and any starting balance.
 *   - Optional fees a student chose that their class does not offer are dropped (same rule as the daily
 *     charge) and counted in the report.
 *   - All or nothing: one transaction, one change at a time per school. dry:true shows the full report and
 *     changes NOTHING.
 *   - One line goes to the audit log. It does not mark the term as "charged for everyone", so the daily
 *     charge for the other schools is unaffected.
 */
const { pool } = require('../db/db');
const { logAudit } = require('./audit');
const { chargeStudentForTerm, getPreviousTerm } = require('./feeLedger');
const { inTransaction, loadAllTerms, findTerm, label, refuse } = require('./feeSetup');

/**
 * input: { year, term, dry }
 * Returns { dry, school, term, students, newRows, changed, totalFees, totalOpening, skippedNoClass, classesWithoutFees, dropped }
 */
async function chargeSchoolTerm(schoolId, { year, term, dry = false }, deps = {}) {
  let report;
  await inTransaction(deps, schoolId, dry, async (client, school) => {
    const all = await loadAllTerms(client);
    const t = findTerm(all, year, term);

    if (t.state === 'nodates') throw refuse(`${label(t)} has no dates yet. Set the terms first: node src/scripts/set-terms.js ${t.year} ${t.term_number} <start> <end>`, 409);
    if (t.state === 'coming') {
      throw refuse(`${label(t)} has not started yet (it starts on ${t.start_day}). The daily charge bills it on its first day. To bill earlier, change the term's start date first.`, 409);
    }
    const started = all.terms.filter((x) => x.start_day && x.start_day <= all.today).sort((a, b) => (a.start_day < b.start_day ? -1 : 1));
    const latest = started[started.length - 1];
    if (latest.id !== t.id) {
      throw refuse(`${label(t)} is in the past: ${label(latest)} has started since. Billing an older term would rewrite balances that were already carried forward, so older terms are locked.`, 409);
    }

    const feeRows = (await client.query(
      `SELECT DISTINCT class_id FROM fee_items WHERE school_id = $1 AND term_id = $2`,
      [schoolId, t.id]
    )).rows;
    if (!feeRows.length) {
      throw refuse(`${school.name} has no fees set for ${label(t)}, so there is nothing to bill. Set them first: node src/scripts/set-fees.js "${school.name}" set "<class>" ${t.year} ${t.term_number} --fee "Tuition=<amount>" --started-term`, 409);
    }
    const schoolWide = feeRows.some((r) => r.class_id == null);

    const students = (await client.query(
      `SELECT s.id, s.admission_no, s.class_id, c.name AS class_name
       FROM students s LEFT JOIN classes c ON c.id = s.class_id
       WHERE s.school_id = $1 AND s.status = 'active' ORDER BY s.id`,
      [schoolId]
    )).rows;
    const withClass = students.filter((s) => s.class_id != null);
    const skippedNoClass = students.filter((s) => s.class_id == null).map((s) => s.admission_no);

    const before = new Map((await client.query(
      `SELECT l.student_id, l.opening_balance, l.fees_charged
       FROM student_term_ledger l JOIN students s ON s.id = l.student_id
       WHERE l.term_id = $1 AND s.school_id = $2`,
      [t.id, schoolId]
    )).rows.map((r) => [r.student_id, r]));

    const previous = await getPreviousTerm({ id: t.id, term_number: t.term_number, academic_year_id: t.academic_year_id }, client);
    const termRow = { id: t.id, term_number: t.term_number, academic_year_id: t.academic_year_id };

    let totalFees = 0, totalOpening = 0, changed = 0, newRows = 0;
    const dropped = {};
    const classesNoFees = new Map();
    for (const s of withClass) {
      const r = await chargeStudentForTerm(client, { id: s.id, school_id: schoolId, class_id: s.class_id }, termRow, previous);
      totalFees += r.feesCharged; totalOpening += r.openingBalance;
      const old = before.get(s.id);
      if (!old) newRows++;
      else if (Number(old.fees_charged) !== r.feesCharged || Number(old.opening_balance) !== r.openingBalance) changed++;
      for (const name of r.dropped) dropped[name] = (dropped[name] || 0) + 1;
      if (!schoolWide && !feeRows.some((f) => f.class_id === s.class_id)) classesNoFees.set(s.class_name, (classesNoFees.get(s.class_name) || 0) + 1);
    }

    report = {
      dry, school, term: { id: t.id, label: label(t) },
      students: withClass.length, newRows, changed,
      totalFees, totalOpening,
      skippedNoClass,
      classesWithoutFees: Array.from(classesNoFees, ([name, students]) => ({ name, students })),
      dropped,
    };
    return {};
  });
  if (!dry) {
    await logAudit({
      schoolId, action: 'term_charged',
      detail: { term_id: report.term.id, term: report.term.label, students: report.students, new_rows: report.newRows, changed: report.changed, total_fees: report.totalFees, dropped: report.dropped, skipped_no_class: report.skippedNoClass.length, via: 'charge-term' },
    });
  }
  return report;
}

module.exports = { chargeSchoolTerm };