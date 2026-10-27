// src/services/dashboard.js - what the Dashboard shows. Read only, one school. Any staff member can look.
//   -> { term, money:{billed,paid,outstanding,percent}, collected:{today,week}, last_payment,
//        waiting:{review,unmatched,review_total,unmatched_total, rows[]}, recent[], debtors[], nudges[] }
// "Collected" counts payments that are applied to a balance (auto_matched / confirmed), by Nairobi calendar day.
const { pool } = require('../db/db');
const { listBalances } = require('./balances');

const num = (v) => Number(v) || 0;
const DAY = `(t.received_at AT TIME ZONE 'Africa/Nairobi')::date`;
const TODAY = `(NOW() AT TIME ZONE 'Africa/Nairobi')::date`;

async function getDashboard(schoolId, db = pool) {
  const bal = await listBalances(schoolId, { students: 'all', status: 'all', limit: 1 }, { pool: db });
  const owing = await listBalances(schoolId, { students: 'active', status: 'owing', sort: 'balance_desc', limit: 5 }, { pool: db });
  const t = bal.totals;
  const applied = `t.school_id = $1 AND t.match_status IN ('auto_matched','confirmed')`;

  const sums = (await db.query(
    `SELECT COALESCE(SUM(t.amount) FILTER (WHERE ${DAY} = ${TODAY}),0) AS today,
            COALESCE(SUM(t.amount) FILTER (WHERE ${DAY} > ${TODAY} - 7),0) AS week
     FROM transactions t WHERE ${applied}`, [schoolId])).rows[0];

  const recentSql = `SELECT t.id, t.source, t.amount, t.received_at, t.match_status, t.matched_student_id AS student_id, s.full_name AS student_name, s.admission_no,
                            t.raw_payload->>'method' AS method
                     FROM transactions t LEFT JOIN students s ON s.id = t.matched_student_id`;
  const recent = (await db.query(`${recentSql} WHERE ${applied} ORDER BY t.received_at DESC, t.id DESC LIMIT 8`, [schoolId])).rows
    .map((r) => ({ ...r, amount: num(r.amount) }));

  const wait = (await db.query(
    `SELECT match_status, COUNT(*)::int AS n, COALESCE(SUM(amount),0) AS total FROM transactions WHERE school_id = $1 AND match_status IN ('needs_review','unmatched') GROUP BY match_status`, [schoolId])).rows;
  const w = (k) => wait.find((x) => x.match_status === k) || { n: 0, total: 0 };
  const waitRows = (await db.query(
    `SELECT t.id, t.source, t.amount, t.payer_name, t.narration, t.match_status, t.match_reason, t.received_at
     FROM transactions t WHERE t.school_id = $1 AND t.match_status IN ('needs_review','unmatched')
     ORDER BY (t.match_status = 'needs_review') DESC, t.received_at DESC LIMIT 5`, [schoolId])).rows.map((r) => ({ ...r, amount: num(r.amount) }));

  const nudges = [];
  if (!bal.term) nudges.push({ kind: 'term_dates', text: 'No term is running yet. Set the term dates so fees are billed and payments reach balances.', go: 'terms', button: 'Set term dates' });
  const noClass = (await db.query(`SELECT COUNT(*)::int AS n FROM students WHERE school_id = $1 AND status = 'active' AND class_id IS NULL`, [schoolId])).rows[0].n;
  if (noClass) nudges.push({ kind: 'no_class', text: noClass + (noClass === 1 ? ' student has' : ' students have') + ' no class, so they are not billed.', go: 'classes', button: 'Open classes' });
  const anyStudent = (await db.query('SELECT 1 FROM students WHERE school_id = $1 LIMIT 1', [schoolId])).rows.length;
  if (!anyStudent) nudges.push({ kind: 'no_students', text: 'No students yet. Admit your first student to get going.', go: 'admit', button: 'Admit a student' });

  return {
    term: bal.term ? { id: bal.term.id, label: bal.term.label, start: bal.term.start, end: bal.term.end } : null,
    money: { billed: num(t.billed), paid: num(t.paid), outstanding: num(t.outstanding), percent: num(t.billed) > 0 ? Math.min(100, Math.round((num(t.paid) / num(t.billed)) * 100)) : 0 },
    collected: { today: num(sums.today), week: num(sums.week) },
    last_payment: recent[0] || null,
    waiting: { review: w('needs_review').n, unmatched: w('unmatched').n, review_total: num(w('needs_review').total), unmatched_total: num(w('unmatched').total), rows: waitRows },
    recent,
    debtors: owing.rows.map((r) => ({ id: r.id, full_name: r.full_name, admission_no: r.admission_no, class: r.class, stream: r.stream, balance: r.balance })),
    nudges,
  };
}

module.exports = { getDashboard };