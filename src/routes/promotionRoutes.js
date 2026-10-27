// src/routes/promotion.js - what the Promotion screen talks to.
// It is attached to the classes router (see classes.js), so app.js needs no change.
//   GET  /schools/:id/promotion/preview     where every student would go (changes nothing)
//   POST /schools/:id/promotion/plan        the SAME plan with the admin's decisions (who repeats, who leaves, which
//                                           stream), so the screen can show exactly where everyone lands (changes nothing)
//   POST /schools/:id/promotion/execute     do it - admin only, once per year, all-or-nothing
//   POST /schools/:id/academic-years        create the next year (3 terms) - admin only
const express = require('express');
const { pool } = require('../db/db');
const { requireAuth, requireSameSchool } = require('../middleware/auth');
const {
  planPromotion, promoteSchool, getPromotionRun, getSchoolActiveYear, getRepeatStreamOptions,
  checkPromotionReady, summarizePlan,
} = require('../services/promotion');

const router = express.Router();
router.use('/schools/:schoolId', requireAuth, requireSameSchool);

async function requireAdmin(req, res, next) {
  const r = await pool.query('SELECT role, status FROM staff WHERE id = $1 AND school_id = $2', [req.staff.staffId, req.staff.schoolId]);
  const me = r.rows[0];
  if (!me || me.status !== 'active' || me.role !== 'admin') return res.status(403).json({ error: 'Only an admin can do this.' });
  next();
}

async function enabledClasses(schoolId) {
  return (await pool.query(
    `SELECT c.id, c.name, c.sort_order FROM classes c JOIN school_classes sc ON sc.class_id = c.id
     WHERE sc.school_id = $1 AND sc.enabled = TRUE ORDER BY c.sort_order`, [schoolId])).rows;
}

router.get('/schools/:schoolId/promotion/preview', async (req, res) => {
  const schoolId = Number(req.params.schoolId);
  const outgoing = req.query.outgoing
    ? (await pool.query('SELECT id, year FROM academic_years WHERE id = $1', [Number(req.query.outgoing)])).rows[0]
    : await getSchoolActiveYear(schoolId);
  if (!outgoing) return res.json({ outgoing: null });

  const incoming = (await pool.query('SELECT id, year FROM academic_years WHERE year = $1', [outgoing.year + 1])).rows[0] || null;
  const run = await getPromotionRun(schoolId, outgoing.id);
  const classes = await enabledClasses(schoolId);
  const plan = await planPromotion({ schoolId, outgoingAcademicYearId: outgoing.id });

  const repeat_options = {};
  for (const c of classes) repeat_options[c.id] = await getRepeatStreamOptions(schoolId, c.id, outgoing.id);

  const noClass = (await pool.query(
    `SELECT COUNT(*)::int AS n FROM students WHERE school_id = $1 AND class_id IS NULL AND status = 'active'`, [schoolId])).rows[0].n;

  // Can the school be promoted right now? Plain words: problems stop the run, warnings are only for information.
  const readiness = incoming && !run
    ? await checkPromotionReady({ schoolId, outgoingAcademicYearId: outgoing.id, incomingAcademicYearId: incoming.id })
    : null;

  // the last promotion this school did (so the screen can say it just happened, instead of jumping to next year)
  const lastRun = (await pool.query(
    `SELECT pr.ran_at, pr.summary, ay.year FROM promotion_runs pr JOIN academic_years ay ON ay.id = pr.incoming_academic_year_id
     WHERE pr.school_id = $1 ORDER BY ay.year DESC LIMIT 1`, [schoolId])).rows[0] || null;

  res.json({
    outgoing, incoming, next_year: outgoing.year + 1, readiness,
    last_run: lastRun ? { into_year: lastRun.year, ran_at: lastRun.ran_at, summary: lastRun.summary } : null,
    already_run: run ? { ran_at: run.ran_at, summary: run.summary } : null,
    classes: classes.map((c, i) => ({ ...c, is_final: i === classes.length - 1, next_class_name: classes[i + 1] ? classes[i + 1].name : null })),
    plan, repeat_options, students_without_class: noClass,
  });
});

// The plan with the admin's decisions applied. Changes nothing.
router.post('/schools/:schoolId/promotion/plan', async (req, res) => {
  const schoolId = Number(req.params.schoolId);
  const b = req.body || {};
  const outgoing = b.outgoing_academic_year_id
    ? (await pool.query('SELECT id, year FROM academic_years WHERE id = $1', [Number(b.outgoing_academic_year_id)])).rows[0]
    : await getSchoolActiveYear(schoolId);
  if (!outgoing) return res.status(404).json({ error: 'There is no academic year yet.' });
  const decisions = await checkDecisions(schoolId, b.decisions);
  const incoming = (await pool.query('SELECT id, year FROM academic_years WHERE year = $1', [outgoing.year + 1])).rows[0] || null;
  const classes = await enabledClasses(schoolId);
  const plan = await planPromotion({ schoolId, outgoingAcademicYearId: outgoing.id, decisions });
  const readiness = incoming
    ? await checkPromotionReady({ schoolId, outgoingAcademicYearId: outgoing.id, incomingAcademicYearId: incoming.id })
    : null;
  res.json({ outgoing, incoming, plan, summary: summarizePlan(plan, classes), readiness });
});

// Checks the decisions the screen sends BEFORE anything moves.
async function checkDecisions(schoolId, decisions) {
  if (decisions === undefined || decisions === null) return {};
  if (typeof decisions !== 'object' || Array.isArray(decisions)) throw Object.assign(new Error('decisions must be an object'), { status: 400 });
  const ids = Object.keys(decisions).map(Number);
  if (ids.some((n) => !Number.isInteger(n))) throw Object.assign(new Error('Each decision must be for a student id'), { status: 400 });
  if (ids.length) {
    const found = (await pool.query(`SELECT id FROM students WHERE school_id = $1 AND id = ANY($2::int[])`, [schoolId, ids])).rows.length;
    if (found !== ids.length) throw Object.assign(new Error('A decision names a student who is not in this school'), { status: 400 });
  }
  const enabled = new Set((await enabledClasses(schoolId)).map((c) => c.id));
  for (const [sid, d] of Object.entries(decisions)) {
    if (d === 'leave' || d === 'repeat') continue;
    if (d && typeof d === 'object' && d.action === 'repeat') {
      if (d.classId !== undefined && d.classId !== null && !enabled.has(Number(d.classId))) throw Object.assign(new Error('Student ' + sid + ' cannot repeat into a class that is switched off'), { status: 400 });
      if (d.streamName !== undefined && d.streamName !== null && (typeof d.streamName !== 'string' || d.streamName.length > 40)) throw Object.assign(new Error('Bad stream name for student ' + sid), { status: 400 });
      if (d.noStream !== undefined && typeof d.noStream !== 'boolean') throw Object.assign(new Error('Bad "no stream" choice for student ' + sid), { status: 400 });
      continue;
    }
    throw Object.assign(new Error('Unknown decision for student ' + sid), { status: 400 });
  }
  return decisions;
}

router.post('/schools/:schoolId/promotion/execute', requireAdmin, async (req, res) => {
  const schoolId = Number(req.params.schoolId);
  const b = req.body || {};
  const decisions = await checkDecisions(schoolId, b.decisions);
  try {
    const r = await promoteSchool({
      outgoingAcademicYearId: Number(b.outgoing_academic_year_id), incomingAcademicYearId: Number(b.incoming_academic_year_id),
      schoolId, decisions, staffId: req.staff.staffId,
    });
    res.json({ ok: true, promoted: r.promoted.length, repeating: r.repeating.length, left: r.leftOrTransferred.length, graduated: r.graduated.length });
  } catch (e) {
    if (e.code === 'ALREADY_PROMOTED' || e.code === 'NOT_READY') return res.status(409).json({ error: e.message, code: e.code });
    throw e;
  }
});

router.post('/schools/:schoolId/academic-years', requireAdmin, async (req, res) => {
  const year = Number(req.body && req.body.year);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return res.status(400).json({ error: 'Give a year such as 2027.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const made = await client.query('INSERT INTO academic_years (year, is_current) VALUES ($1, FALSE) ON CONFLICT (year) DO NOTHING RETURNING id, year', [year]);
    if (!made.rows.length) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'The year ' + year + ' already exists.' }); }
    for (const n of [1, 2, 3]) {
      await client.query('INSERT INTO terms (academic_year_id, term_number, is_current) VALUES ($1, $2, FALSE)', [made.rows[0].id, n]);
    }
    await client.query('COMMIT');
    res.json(made.rows[0]);
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
});

module.exports = router;