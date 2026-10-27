/* reports.js - the Reports page: how the school is doing on fees, for ONE term at a time. READ ONLY.
   All numbers come from the same ledger as Students & balances (balance = brought forward + charged - paid), so they always agree.
   - Only terms that have real money in them are listed. Terms from before the school started using Karo (no billing, no payments) are left out.
   - Includes students who have left (their money is still the school's money). Students & balances shows active students by default.
   - "Collected" counts payments that were applied (matched or confirmed). Rejected and reversed payments are not counted.
   Everything is per school. Times are Kenya time. */
const { pool } = require('../db/db');
const { startedTerms } = require('./balances');

const TZ = 'Africa/Nairobi';
const num = (v) => Number(v) || 0;
const rate = (paid, billed) => (billed > 0 ? Math.round((paid / billed) * 1000) / 10 : null);
const APPLIED = `('auto_matched','confirmed')`;
function refuse(message, status = 400) { const e = new Error(message); e.status = status; return e; }
const SOURCE_NAMES = { mpesa: 'M-Pesa', kcb: 'KCB', equity: 'Equity Bank', coop: 'Co-operative Bank' };
const METHOD_NAMES = { cash: 'Cash', cheque: 'Cheque', bank_deposit: 'Bank deposit slip', other: 'Other' };

async function getReport(schoolId, opts = {}, deps = {}) {
  const db = deps.pool || pool;
  const sId = Number(schoolId);
  const school = (await db.query('SELECT name FROM schools WHERE id = $1', [sId])).rows[0];
  if (!school) throw refuse('School not found.', 404);

  // one row per started term: what was billed and paid (this decides which terms exist on the page)
  const started = await startedTerms(db, sId);                                  // newest first
  const sums = (await db.query(
    `SELECT l.term_id, COALESCE(SUM(l.opening_balance + l.fees_charged),0) AS billed, COALESCE(SUM(l.amount_paid),0) AS paid
     FROM student_term_ledger l JOIN students s ON s.id = l.student_id WHERE s.school_id = $1 GROUP BY l.term_id`, [sId])).rows;
  const byId = new Map(sums.map((r) => [r.term_id, r]));
  const withData = started.filter((t) => { const r = byId.get(t.id); return r && (num(r.billed) > 0 || num(r.paid) > 0); })
    .map((t) => { const r = byId.get(t.id); const billed = num(r.billed), paid = num(r.paid); return { ...t, billed, paid, rate: rate(paid, billed) }; });
  const base = { school: { name: school.name }, terms: withData.map((t) => ({ id: t.id, label: t.label })), byTerm: withData.slice().reverse().slice(-8).map((t) => ({ id: t.id, label: t.label, billed: t.billed, paid: t.paid, rate: t.rate })) };
  if (!withData.length) return { ...base, term: null, tiles: null, arrearsByClass: [], topArrears: [], moneyIn: null, sources: [], attention: await attention(db, sId, null) };

  let term;
  if (opts.termId !== undefined && opts.termId !== null && opts.termId !== '') {
    term = withData.find((t) => t.id === Number(opts.termId));
    if (!term) throw refuse('There are no figures for that term.', 404);
  } else {
    term = withData[0];                                                         // the newest term that has figures
  }

  const ledger = `FROM student_term_ledger l JOIN students s ON s.id = l.student_id LEFT JOIN classes c ON c.id = s.class_id LEFT JOIN streams st ON st.id = s.stream_id WHERE s.school_id = $1 AND l.term_id = $2`;
  const bal = `(l.opening_balance + l.fees_charged - l.amount_paid)`;
  const t = (await db.query(
    `SELECT COUNT(*) FILTER (WHERE l.opening_balance + l.fees_charged > 0)::int AS billed_students,
            COUNT(*) FILTER (WHERE ${bal} > 0)::int AS owing,
            COALESCE(SUM(l.opening_balance + l.fees_charged),0) AS billed, COALESCE(SUM(l.amount_paid),0) AS paid,
            COALESCE(SUM(GREATEST(${bal},0)),0) AS outstanding, COALESCE(SUM(GREATEST(-${bal},0)),0) AS credit,
            COALESCE(SUM(l.opening_balance),0) AS brought_forward
     ${ledger}`, [sId, term.id])).rows[0];
  const tiles = { billed: num(t.billed), collected: num(t.paid), outstanding: num(t.outstanding), credit: num(t.credit), rate: rate(num(t.paid), num(t.billed)),
    students_billed: t.billed_students, students_owing: t.owing, brought_forward: num(t.brought_forward) };

  const arrearsByClass = (await db.query(
    `SELECT c.id, c.name, c.sort_order, COUNT(*) FILTER (WHERE ${bal} > 0)::int AS owing, COUNT(*) FILTER (WHERE l.opening_balance + l.fees_charged > 0)::int AS students,
            COALESCE(SUM(l.opening_balance + l.fees_charged),0) AS billed, COALESCE(SUM(l.amount_paid),0) AS paid, COALESCE(SUM(GREATEST(${bal},0)),0) AS owed
     ${ledger} AND c.id IS NOT NULL GROUP BY c.id, c.name, c.sort_order HAVING SUM(l.opening_balance + l.fees_charged) > 0 OR SUM(l.amount_paid) > 0 ORDER BY c.sort_order`, [sId, term.id]))
    .rows.map((r) => ({ class_id: r.id, class: r.name, students: r.students, students_owing: r.owing, billed: num(r.billed), paid: num(r.paid), owed: num(r.owed), rate: rate(num(r.paid), num(r.billed)) }));

  const topArrears = (await db.query(
    `SELECT s.id, s.admission_no, s.full_name, s.status, c.name AS class, st.name AS stream, s.guardian_name, s.guardian_phone, ${bal} AS balance
     ${ledger} AND ${bal} > 0 ORDER BY ${bal} DESC, s.full_name LIMIT 10`, [sId, term.id]))
    .rows.map((r) => ({ id: r.id, admission_no: r.admission_no, full_name: r.full_name, status: r.status, class: r.class, stream: r.stream, guardian_name: r.guardian_name, guardian_phone: r.guardian_phone, balance: num(r.balance) }));

  // money coming in during this term: per day (short term view) or per week (a full term)
  const days = Math.max(1, Math.round((new Date(term.end + 'T00:00:00Z') - new Date(term.start + 'T00:00:00Z')) / 864e5) + 1);
  const bucket = days > 45 ? 'week' : 'day';
  const trunc = bucket === 'week' ? `date_trunc('week', t.received_at AT TIME ZONE '${TZ}')` : `date_trunc('day', t.received_at AT TIME ZONE '${TZ}')`;
  const series = (await db.query(
    `SELECT to_char(${trunc}, 'YYYY-MM-DD') AS day, COALESCE(SUM(t.amount),0) AS amount, COUNT(*)::int AS n
     FROM transactions t WHERE t.school_id = $1 AND t.term_id = $2 AND t.match_status IN ${APPLIED} GROUP BY 1 ORDER BY 1`, [sId, term.id]))
    .rows.map((r) => ({ day: r.day, amount: num(r.amount), count: r.n }));
  const moneyIn = { bucket, series, total: series.reduce((s, x) => s + x.amount, 0), count: series.reduce((s, x) => s + x.count, 0) };

  const sources = (await db.query(
    `SELECT t.source, COALESCE(t.raw_payload->>'method', '') AS method, COALESCE(SUM(t.amount),0) AS amount, COUNT(*)::int AS n
     FROM transactions t WHERE t.school_id = $1 AND t.term_id = $2 AND t.match_status IN ${APPLIED} GROUP BY 1, 2 ORDER BY SUM(t.amount) DESC`, [sId, term.id]))
    .rows.map((r) => ({ name: r.source === 'manual' ? 'Recorded by hand: ' + (METHOD_NAMES[r.method] || 'Other') : (SOURCE_NAMES[r.source] || r.source), kind: r.source === 'manual' ? 'manual' : (r.source === 'mpesa' ? 'mpesa' : 'bank'), amount: num(r.amount), count: r.n }));

  return { ...base, term: { id: term.id, label: term.label, start: term.start, end: term.end }, tiles, arrearsByClass, topArrears, moneyIn, sources, attention: await attention(db, sId, term.id) };
}

// things somebody should look at (not tied to a term, except "not billed yet")
async function attention(db, sId, termId) {
  const q = (await db.query(
    `SELECT COUNT(*) FILTER (WHERE match_status = 'needs_review')::int AS review, COALESCE(SUM(amount) FILTER (WHERE match_status = 'needs_review'),0) AS review_amount,
            COUNT(*) FILTER (WHERE match_status = 'unmatched')::int AS unmatched, COALESCE(SUM(amount) FILTER (WHERE match_status = 'unmatched'),0) AS unmatched_amount
     FROM transactions WHERE school_id = $1`, [sId])).rows[0];
  let notBilled = 0;
  if (termId) {
    notBilled = (await db.query(
      `SELECT COUNT(*)::int AS n FROM students s LEFT JOIN student_term_ledger l ON l.student_id = s.id AND l.term_id = $2
       WHERE s.school_id = $1 AND s.status = 'active' AND COALESCE(l.opening_balance + l.fees_charged, 0) = 0 AND COALESCE(l.amount_paid, 0) = 0`, [sId, termId])).rows[0].n;
  }
  return { review: q.review, review_amount: num(q.review_amount), unmatched: q.unmatched, unmatched_amount: num(q.unmatched_amount), not_billed: notBilled };
}

module.exports = { getReport };