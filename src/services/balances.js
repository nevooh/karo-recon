/**
 * Students & balances: the list the bursar works from. READ ONLY, nothing here changes money.
 *
 * For one term of one school: every student with what was billed, what was paid and what is left.
 *   balance = brought forward + fees charged - paid       (the same sum the ledger uses everywhere)
 * The term is the school's CURRENT term unless another started term is asked for (history).
 *
 * A student's money state for the term:
 *   owing       balance above 0
 *   overpaid    balance below 0 (paid ahead / credit)
 *   cleared     balance is 0 and something was billed
 *   not_billed  nothing billed and nothing paid yet (new student, class had no fees, or the term has not billed)
 *
 * Filters: q (name or admission number), classId, streamId, status (a money state, or "all"),
 *          students ("active" default, "left", "all"), sort, limit, offset.
 * Everything is per school: it never reads another school's students.
 */
const { pool } = require('../db/db');
const { getCurrentTerm } = require('./feeLedger');

const STATES = ['owing', 'overpaid', 'cleared', 'not_billed'];
const STUDENT_SETS = ['active', 'left', 'all'];
const SORTS = {                                                  // names of the columns of the inner select
  name: 'full_name ASC, id',
  admission: "NULLIF(regexp_replace(admission_no, '\\D', '', 'g'), '')::numeric ASC NULLS LAST, admission_no ASC, id",   // 2 before 10
  class: 'sort_order ASC NULLS LAST, stream ASC NULLS LAST, full_name ASC, id',
  balance_desc: 'balance DESC, full_name ASC, id',
  balance_asc: 'balance ASC, full_name ASC, id',
};

function refuse(message, status = 400) { const e = new Error(message); e.status = status; return e; }
const num = (v) => Number(v) || 0;
const int = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

async function startedTerms(db, schoolId) {
  const r = await db.query(
    `SELECT t.id, t.term_number, ay.year, to_char(d.start_date, 'YYYY-MM-DD') AS start_day, to_char(d.end_date, 'YYYY-MM-DD') AS end_day
     FROM school_term_dates d JOIN terms t ON t.id = d.term_id JOIN academic_years ay ON ay.id = t.academic_year_id
     WHERE d.school_id = $1 AND d.start_date <= CURRENT_DATE ORDER BY d.start_date DESC`, [schoolId]);
  return r.rows.map((t) => ({ id: t.id, term: t.term_number, year: t.year, label: `Term ${t.term_number} ${t.year}`, start: t.start_day, end: t.end_day }));
}

async function listBalances(schoolId, opts = {}, deps = {}) {
  const db = deps.pool || pool;
  const sId = Number(schoolId);
  const o = {
    termId: int(opts.termId), q: String(opts.q || '').trim().slice(0, 80), classId: int(opts.classId), streamId: int(opts.streamId),
    status: opts.status || 'all', students: opts.students || 'active', sort: opts.sort || 'name',
    limit: Math.min(Math.max(Number(opts.limit) || 40, 1), 200), offset: Math.max(Number(opts.offset) || 0, 0),
  };
  if (o.status !== 'all' && !STATES.includes(o.status)) throw refuse('The status must be one of: all, ' + STATES.join(', ') + '.');
  if (!STUDENT_SETS.includes(o.students)) throw refuse('The students filter must be one of: ' + STUDENT_SETS.join(', ') + '.');
  if (!SORTS[o.sort]) throw refuse('The sort must be one of: ' + Object.keys(SORTS).join(', ') + '.');
  for (const k of ['termId', 'classId', 'streamId']) if (o[k] !== null && !Number.isInteger(o[k])) throw refuse(`${k} must be a number.`);

  const terms = await startedTerms(db, sId);
  let term = null;
  if (o.termId !== null) {
    term = terms.find((t) => t.id === o.termId);
    if (!term) throw refuse('That term has not started for this school, so there are no balances for it.', 404);
  } else {
    const cur = await getCurrentTerm(sId, db);
    term = cur ? terms.find((t) => t.id === cur.id) || null : null;
  }

  const classes = (await db.query(
    `SELECT c.id, c.name FROM classes c WHERE c.id IN (SELECT class_id FROM students WHERE school_id = $1 AND class_id IS NOT NULL) ORDER BY c.sort_order`, [sId])).rows;
  const streams = (await db.query(
    `SELECT DISTINCT st.id, st.class_id, st.name FROM streams st WHERE st.id IN (SELECT stream_id FROM students WHERE school_id = $1 AND stream_id IS NOT NULL) ORDER BY st.name`, [sId])).rows;
  const base = { school_id: sId, term, terms, classes, streams, filters: { ...o } };
  if (!term) {
    return { ...base, totals: { students: 0, billed: 0, paid: 0, outstanding: 0, credit: 0, owing: 0 }, counts: { owing: 0, overpaid: 0, cleared: 0, not_billed: 0, all: 0 }, rows: [], total: 0 };
  }

  // filters that do not depend on the money state (the status chips count inside these)
  const p = [sId, term.id];
  const where = ['s.school_id = $1'];
  if (o.students !== 'all') { p.push(o.students); where.push(`s.status = $${p.length}`); }
  if (o.q) { p.push('%' + o.q.replace(/[%_\\]/g, '\\$&') + '%'); where.push(`(s.full_name ILIKE $${p.length} OR s.admission_no ILIKE $${p.length})`); }
  if (o.classId !== null) { p.push(o.classId); where.push(`s.class_id = $${p.length}`); }
  if (o.streamId !== null) { p.push(o.streamId); where.push(`s.stream_id = $${p.length}`); }

  const money = `COALESCE(l.opening_balance,0) + COALESCE(l.fees_charged,0)`;
  const bal = `(${money} - COALESCE(l.amount_paid,0))`;
  const state = `CASE WHEN ${bal} > 0 THEN 'owing' WHEN ${bal} < 0 THEN 'overpaid' WHEN ${money} > 0 THEN 'cleared' ELSE 'not_billed' END`;
  const from = `FROM students s LEFT JOIN student_term_ledger l ON l.student_id = s.id AND l.term_id = $2
                LEFT JOIN classes c ON c.id = s.class_id LEFT JOIN streams st ON st.id = s.stream_id WHERE ${where.join(' AND ')}`;

  const agg = (await db.query(
    `SELECT state, COUNT(*)::int AS n, COALESCE(SUM(billed),0) AS billed, COALESCE(SUM(paid),0) AS paid, COALESCE(SUM(bal),0) AS bal,
            COALESCE(SUM(GREATEST(bal,0)),0) AS owed, COALESCE(SUM(GREATEST(-bal,0)),0) AS credit
     FROM (SELECT ${state} AS state, ${money} AS billed, COALESCE(l.amount_paid,0) AS paid, ${bal} AS bal ${from}) x GROUP BY state`, p)).rows;
  const counts = { owing: 0, overpaid: 0, cleared: 0, not_billed: 0, all: 0 };
  for (const a of agg) { counts[a.state] = a.n; counts.all += a.n; }
  const pick = o.status === 'all' ? agg : agg.filter((a) => a.state === o.status);
  const totals = {
    students: pick.reduce((s, a) => s + a.n, 0), billed: pick.reduce((s, a) => s + num(a.billed), 0), paid: pick.reduce((s, a) => s + num(a.paid), 0),
    outstanding: pick.reduce((s, a) => s + num(a.owed), 0), credit: pick.reduce((s, a) => s + num(a.credit), 0), owing: pick.reduce((s, a) => s + (a.state === 'owing' ? a.n : 0), 0),
  };

  const rp = p.slice();
  let stateFilter = '';
  if (o.status !== 'all') { rp.push(o.status); stateFilter = ` WHERE state = $${rp.length}`; }
  const rows = (await db.query(
    `SELECT * FROM (SELECT s.id, s.admission_no, s.full_name, s.status AS student_status, s.class_id, c.name AS class, c.sort_order, s.stream_id, st.name AS stream,
            s.guardian_name, s.guardian_phone, COALESCE(l.opening_balance,0) AS opening_balance, COALESCE(l.fees_charged,0) AS fees_charged,
            COALESCE(l.amount_paid,0) AS paid, ${bal} AS balance, ${state} AS state ${from}) y${stateFilter}
     ORDER BY ${SORTS[o.sort]}
     LIMIT ${o.limit} OFFSET ${o.offset}`, rp)).rows;

  return {
    ...base, totals, counts, total: totals.students,
    rows: rows.map((r) => ({
      id: r.id, admission_no: r.admission_no, full_name: r.full_name, student_status: r.student_status,
      class_id: r.class_id, class: r.class, stream_id: r.stream_id, stream: r.stream,
      guardian_name: r.guardian_name, guardian_phone: r.guardian_phone,
      brought_forward: num(r.opening_balance), fees_charged: num(r.fees_charged), paid: num(r.paid), balance: num(r.balance), state: r.state,
    })),
  };
}

module.exports = { listBalances, startedTerms, STATES };