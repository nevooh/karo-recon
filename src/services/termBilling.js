/**
 * BILLING: locks a school's fees for the term that is running and charges the students. Automatic, and it can
 * never charge the same class twice for the same term.
 *
 * How it works (plain words):
 *   - The fee structure (fee_templates) is only a reusable template. Editing it never changes a billed term.
 *   - When a term has started, billing takes, for each class the school runs, the LATEST version of that class's
 *     fees for that term number and LOCKS it for this exact term (a row in term_fee_locks). The class's active
 *     students are then charged from that locked version (feeLedger.chargeStudentForTerm).
 *   - It runs by itself: when the server starts and then every hour (termAutoCharge.js). Most runs find nothing
 *     to do. The first run on or after a term's start date does the billing.
 *   - A class that has NO fees set yet, or no active students, is not billed and nothing is locked, so it is tried again on the next run.
 *     Once fees exist it is billed. Nothing is ever marked "done" while it is not.
 *   - Only the CURRENT term is ever billed (the latest term whose start date has passed, and only while it has not
 *     ended). Older terms are history, and the holiday before the next term bills nothing.
 *
 * Why it can not bill twice (each layer works even if the others failed):
 *   1. term_fee_locks has the primary key (school, term, class). A class can be locked once per term, ever.
 *   2. The lock is CLAIMED with INSERT ... ON CONFLICT DO NOTHING RETURNING. Only the run that gets the row back
 *      charges. Everyone else sees "already locked" and skips.
 *   3. One school is billed at a time (database advisory lock), the same line-up admissions and fee edits use.
 *   4. A database trigger refuses any UPDATE or DELETE on term_fee_locks and term_billing.
 *   5. Charging RECALCULATES a student's fees for the term (it never adds on top), and never touches payments.
 *   6. One school failing never stops the others (billAllSchools), and one failure rolls back only that school.
 *
 * dry: true does everything and rolls it back, so you see the report and nothing changes.
 */
const { pool } = require('../db/db');
const { logAudit } = require('./audit');
const { chargeStudentForTerm, getPreviousTerm } = require('./feeLedger');

const LINE_UP_KEY = 7771003;          // the same number admissions, promotion and fee edits use: one change at a time per school

function refuse(message, status = 400) { const e = new Error(message); e.status = status; return e; }
const termLabel = (t) => `Term ${t.term_number} ${t.year}`;

// The term billing works on: the latest term whose start date has passed FOR THIS SCHOOL (same rule as payments use).
async function loadCurrentTerm(db, schoolId) {
  const r = await db.query(
    `SELECT t.id, t.term_number, t.academic_year_id, ay.year, to_char(d.start_date, 'YYYY-MM-DD') AS start_day,
            (d.end_date < CURRENT_DATE) AS ended
     FROM school_term_dates d JOIN terms t ON t.id = d.term_id JOIN academic_years ay ON ay.id = t.academic_year_id
     WHERE d.school_id = $1 AND d.start_date <= CURRENT_DATE
     ORDER BY d.start_date DESC LIMIT 1`,
    [schoolId]
  );
  return r.rows[0] || null;
}

async function latestTemplate(db, schoolId, classId, termNumber) {
  const r = await db.query(
    `SELECT id, version FROM fee_templates WHERE school_id = $1 AND class_id = $2 AND term_number = $3 ORDER BY version DESC LIMIT 1`,
    [schoolId, classId, termNumber]
  );
  return r.rows[0] || null;
}

/**
 * The fees a class has for a term, from the right place:
 *   locked   the class was billed for this exact term: what was LOCKED (final for that term)
 *   template not billed yet: the latest version of the template (what billing would lock today)
 *   none     no fees set
 * Returns { source, version, items: [{ name, amount, is_mandatory }] }.
 */
async function getClassFees(db, schoolId, classId, term) {
  const locked = (await db.query(
    `SELECT t.id, t.version FROM term_fee_locks l JOIN fee_templates t ON t.id = l.template_id
     WHERE l.school_id = $1 AND l.term_id = $2 AND l.class_id = $3`,
    [schoolId, term.id, classId]
  )).rows[0];
  const tpl = locked || await latestTemplate(db, schoolId, classId, term.term_number);
  if (!tpl) return { source: 'none', version: null, items: [] };
  const items = (await db.query(
    `SELECT name, amount, is_mandatory FROM fee_template_items WHERE template_id = $1 ORDER BY is_mandatory DESC, id`,
    [tpl.id]
  )).rows.map((r) => ({ name: r.name, amount: Number(r.amount), is_mandatory: r.is_mandatory }));
  return { source: locked ? 'locked' : 'template', version: tpl.version, items };
}

/**
 * Locks ONE class for ONE term and charges its active students. `client` must be inside a transaction that holds
 * the school's line-up lock. Returns { status, ... }:
 *   already   the class was locked before (nothing done)
 *   no_fees   the class has no fees set yet (nothing locked, tried again next run)
 *   no_students  the class has fees but no active students (nothing locked: the first admission locks it)
 *   billed    locked now, students charged: { version, students, totalFees, dropped }
 */
async function lockAndChargeClass(client, schoolId, term, cls) {
  const have = await client.query(`SELECT 1 FROM term_fee_locks WHERE school_id = $1 AND term_id = $2 AND class_id = $3`, [schoolId, term.id, cls.id]);
  if (have.rows.length) return { status: 'already' };
  const tpl = await latestTemplate(client, schoolId, cls.id, term.term_number);
  if (!tpl) return { status: 'no_fees' };
  // An empty class is NOT locked: nobody would be charged, and locking would freeze its fees for the term for nothing.
  // The first student admitted to the class locks it (admission calls this after saving the student).
  const anyone = await client.query(`SELECT 1 FROM students WHERE school_id = $1 AND class_id = $2 AND status = 'active' LIMIT 1`, [schoolId, cls.id]);
  if (!anyone.rows.length) return { status: 'no_students' };

  // the claim: only the run that gets a row back may charge
  const claim = await client.query(
    `INSERT INTO term_fee_locks (school_id, term_id, class_id, template_id) VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING RETURNING class_id`,
    [schoolId, term.id, cls.id, tpl.id]
  );
  if (!claim.rows.length) return { status: 'already' };

  const previous = await getPreviousTerm({ id: term.id, term_number: term.term_number, academic_year_id: term.academic_year_id }, client);
  const students = (await client.query(
    `SELECT id, school_id, class_id FROM students WHERE school_id = $1 AND class_id = $2 AND status = 'active' ORDER BY id`,
    [schoolId, cls.id]
  )).rows;
  let totalFees = 0;
  const dropped = {};
  for (const s of students) {
    const r = await chargeStudentForTerm(client, s, term, previous);
    totalFees += r.feesCharged;
    for (const name of r.dropped) dropped[name] = (dropped[name] || 0) + 1;
  }
  return { status: 'billed', version: tpl.version, students: students.length, totalFees, dropped };
}

async function inSchoolTransaction(db, schoolId, dry, work) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [LINE_UP_KEY, schoolId]);
    const school = (await client.query('SELECT id, name FROM schools WHERE id = $1', [schoolId])).rows[0];
    if (!school) throw refuse(`There is no school with number ${schoolId}.`, 404);
    const out = await work(client, school);
    await client.query(dry ? 'ROLLBACK' : 'COMMIT');
    return out;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* the connection is already gone */ }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Bills ONE school for the current term: every class it runs that is not locked yet and has fees set.
 * Safe to run any number of times: a class already locked is skipped. Returns
 * { dry, school, term, classes: [{ name, status, version?, students?, totalFees? }], billedClasses, students, totalFees, dropped }
 * or { dry, school, term: null } when no term has started yet.
 */
async function billSchool(schoolId, { dry = false, via = 'auto' } = {}, deps = {}) {
  const db = deps.pool || pool;
  const report = await inSchoolTransaction(db, schoolId, dry, async (client, school) => {
    const term = await loadCurrentTerm(client, schoolId);
    if (!term) return { dry, school, term: null, classes: [], billedClasses: 0, students: 0, totalFees: 0, dropped: {} };
    // a term that is over (holiday before the next one starts) is history: nothing is locked or charged for it
    if (term.ended) return { dry, school, term: { id: term.id, label: termLabel(term), starts: term.start_day }, ended: true, classes: [], billedClasses: 0, students: 0, totalFees: 0, dropped: {} };

    const classes = (await client.query(
      `SELECT c.id, c.name FROM school_classes sc JOIN classes c ON c.id = sc.class_id
       WHERE sc.school_id = $1 AND sc.enabled ORDER BY c.sort_order`,
      [schoolId]
    )).rows;

    const out = [];
    let students = 0, totalFees = 0;
    const dropped = {};
    for (const cls of classes) {
      const r = await lockAndChargeClass(client, schoolId, term, cls);
      if (r.status === 'billed') {
        students += r.students; totalFees += r.totalFees;
        for (const [n, c] of Object.entries(r.dropped)) dropped[n] = (dropped[n] || 0) + c;
      }
      if (r.status === 'no_fees') {
        const n = (await client.query(`SELECT COUNT(*)::int AS n FROM students WHERE school_id = $1 AND class_id = $2 AND status = 'active'`, [schoolId, cls.id])).rows[0].n;
        r.waitingStudents = n;
      }
      out.push({ class: cls.name, ...r });
    }
    const billedClasses = out.filter((c) => c.status === 'billed').length;
    if (billedClasses > 0) {
      // the school-level record: the first time anything is billed for this term
      await client.query(
        `INSERT INTO term_billing (school_id, term_id, students_billed, via) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [schoolId, term.id, students, via]
      );
    }
    return { dry, school, term: { id: term.id, label: termLabel(term), starts: term.start_day }, classes: out, billedClasses, students, totalFees, dropped };
  });
  if (!dry && report.billedClasses > 0) {
    await logAudit({
      schoolId, action: 'term_billed',
      detail: {
        term_id: report.term.id, term: report.term.label, via,
        classes: report.classes.filter((c) => c.status === 'billed').map((c) => ({ class: c.class, version: c.version, students: c.students })),
        total_fees: report.totalFees, dropped: report.dropped,
      },
    });
    for (const [name, count] of Object.entries(report.dropped)) {
      await logAudit({ schoolId, action: 'optional_fee_dropped', detail: { fee: name, students: count, term_id: report.term.id, reason: 'class does not offer it' } });
    }
  }
  return report;
}

/**
 * Bills every school (what the automatic run does). One school failing is logged and the others carry on.
 * Returns { schools, billed: [{ school, classes, students }], failed: [{ school_id, error }] }.
 */
async function billAllSchools(deps = {}) {
  const db = deps.pool || pool;
  const ids = (await db.query('SELECT id FROM schools ORDER BY id')).rows.map((r) => r.id);
  const billed = [], failed = [];
  for (const id of ids) {
    try {
      const r = await billSchool(id, { via: 'auto' }, deps);
      if (r.billedClasses > 0) billed.push({ school: r.school.name, term: r.term.label, classes: r.billedClasses, students: r.students });
    } catch (err) {
      failed.push({ school_id: id, error: err.message });
    }
  }
  return { schools: ids.length, billed, failed };
}

module.exports = { billSchool, billAllSchools, lockAndChargeClass, getClassFees, loadCurrentTerm, latestTemplate, LINE_UP_KEY };