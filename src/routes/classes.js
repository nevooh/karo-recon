// src/routes/classes.js - everything the Classes & streams page needs.
//
// Add TWO lines to src/app.js:
//   near the other requires:   const classesRoutes = require('./routes/classes');
//   next to app.use('/api', reconciliationRoutes);   app.use('/api', classesRoutes);
//
// All routes need a login for the SAME school (same as the rest of /schools/:schoolId).
// Anything that CHANGES settings is admin-only.
const express = require('express');
const { pool } = require('../db/db');
const { requireAuth, requireSameSchool } = require('../middleware/auth');
const classSetup = require('../services/classSetup');
const { getSchoolActiveYear } = require('../services/promotion');

const router = express.Router();
router.use('/schools/:schoolId', requireAuth, requireSameSchool);

async function requireAdmin(req, res, next) {
  const r = await pool.query('SELECT role, status FROM staff WHERE id = $1 AND school_id = $2', [req.staff.staffId, req.staff.schoolId]);
  const me = r.rows[0];
  if (!me || me.status !== 'active' || me.role !== 'admin') {
    return res.status(403).json({ error: 'Only an admin can change classes and streams.' });
  }
  next();
}

// The year THIS school is in: the one it last promoted into, otherwise the platform's current year.
const currentYear = (schoolId) => getSchoolActiveYear(schoolId);

async function isEnabled(schoolId, classId) {
  const r = await pool.query('SELECT 1 FROM school_classes WHERE school_id = $1 AND class_id = $2 AND enabled = TRUE', [schoolId, classId]);
  return r.rows.length > 0;
}

// One call gives the page everything: classes (on/off, student counts), this year's streams, promotion rules.
router.get('/schools/:schoolId/classes-overview', async (req, res) => {
  const schoolId = Number(req.params.schoolId);
  const year = await currentYear(schoolId);

  const classes = (await pool.query(
    `SELECT c.id, c.name, c.sort_order, COALESCE(sc.enabled, FALSE) AS enabled,
            (SELECT COUNT(*)::int FROM students s WHERE s.school_id = $1 AND s.class_id = c.id AND s.status = 'active') AS student_count
     FROM classes c LEFT JOIN school_classes sc ON sc.class_id = c.id AND sc.school_id = $1
     ORDER BY c.sort_order`, [schoolId])).rows;

  const streams = year ? (await pool.query(
    `SELECT st.id, st.class_id, st.name, COUNT(s.id) FILTER (WHERE s.status = 'active')::int AS student_count
     FROM streams st LEFT JOIN students s ON s.stream_id = st.id
     WHERE st.school_id = $1 AND st.academic_year_id = $2
     GROUP BY st.id ORDER BY st.name`, [schoolId, year.id])).rows : [];

  const rules = (await pool.query(
    `SELECT id, from_class_id, from_stream_name, to_class_id, to_stream_name
     FROM promotion_mappings WHERE school_id = $1 ORDER BY from_class_id, from_stream_name NULLS FIRST`, [schoolId])).rows;

  classes.forEach((c) => { c.streams = streams.filter((s) => s.class_id === c.id); });
  // where students graduate, and any class switched off in the middle (promotion skips it)
  const d = classSetup.describe(classes.map((c) => ({ name: c.name, sort_order: c.sort_order, enabled: c.enabled })));
  res.json({ year, classes, rules, first_class: d.first && d.first.name, last_class: d.last && d.last.name, warnings: d.warnings });
});

// Everything below that CHANGES classes or streams goes through ONE engine (src/services/classSetup.js), the same one
// the terminal tool (set-classes.js) uses. So the screen and the terminal always follow the same rules, take the same
// lock, and write the same audit lines (with the staff member who did it).

// A stream of this school, with its class name (the engine names classes and streams, the screen sends ids).
async function streamInfo(schoolId, streamId) {
  const r = await pool.query(
    `SELECT st.id, st.name, st.class_id, c.name AS class_name
     FROM streams st JOIN classes c ON c.id = st.class_id WHERE st.id = $1 AND st.school_id = $2`, [streamId, schoolId]);
  return r.rows[0] || null;
}
async function mustStream(res, schoolId, streamId) {
  const st = await streamInfo(schoolId, streamId);
  if (!st) res.status(404).json({ error: 'Stream not found' });
  return st;
}
async function classNameOf(classId) {
  const r = await pool.query('SELECT name FROM classes WHERE id = $1', [classId]);
  return r.rows[0] ? r.rows[0].name : null;
}
const cleanList = (v) => (Array.isArray(v) ? v.map((x) => String(x == null ? '' : x).trim()).filter(Boolean) : null);

// Save the whole choice at once (what the side sheet does): the school runs EXACTLY these classes.
// A class that still has students can never be switched off - move or promote them first.
router.post('/schools/:schoolId/classes/save', requireAdmin, async (req, res) => {
  const schoolId = Number(req.params.schoolId);
  const ids = req.body && req.body.enabled_class_ids;
  if (!Array.isArray(ids) || !ids.every((n) => Number.isInteger(n))) {
    return res.status(400).json({ error: 'enabled_class_ids must be a list of class ids' });
  }
  const all = (await pool.query('SELECT id, name FROM classes ORDER BY sort_order')).rows;
  const known = new Set(all.map((c) => c.id));
  if (ids.some((n) => !known.has(n))) return res.status(400).json({ error: 'One of those classes does not exist' });
  const chosen = new Set(ids);
  const r = await classSetup.setClasses(schoolId, { mode: 'exactly', names: all.filter((c) => chosen.has(c.id)).map((c) => c.name), staffId: req.staff.staffId });
  res.json({ ok: true, enabled_count: r.enabled.length, first_class: r.first, last_class: r.last, warnings: r.warnings });
});

// Add a stream to a class, for the year this school is in.
router.post('/schools/:schoolId/classes/:classId/streams', requireAdmin, async (req, res) => {
  const schoolId = Number(req.params.schoolId), classId = Number(req.params.classId);
  const name = String((req.body && req.body.name) || '').trim();
  if (!name || name.length > 40) return res.status(400).json({ error: 'Give the stream a name (up to 40 characters).' });
  const className = await classNameOf(classId);
  if (!className) return res.status(404).json({ error: 'Class not found' });
  const r = await classSetup.addStream(schoolId, { className, streamName: name, staffId: req.staff.staffId });
  const row = (await pool.query(
    `SELECT st.id, st.class_id, st.name FROM streams st JOIN academic_years ay ON ay.id = st.academic_year_id
     WHERE st.school_id = $1 AND st.class_id = $2 AND ay.year = $3 AND lower(st.name) = lower($4)`, [schoolId, classId, r.year, r.stream])).rows[0];
  res.json(row || { class_id: classId, name: r.stream });
});

// Rename a stream. Students stay in it (they are tied to the stream, not to its name).
router.put('/schools/:schoolId/streams/:streamId', requireAdmin, async (req, res) => {
  const schoolId = Number(req.params.schoolId);
  const st = await mustStream(res, schoolId, Number(req.params.streamId));
  if (!st) return;
  const name = String((req.body && req.body.name) || '').trim();
  if (!name || name.length > 40) return res.status(400).json({ error: 'Give the stream a name (up to 40 characters).' });
  const r = await classSetup.renameStream(schoolId, { className: st.class_name, oldName: st.name, newName: name, staffId: req.staff.staffId });
  res.json({ id: st.id, name: r.stream, unchanged: !!r.unchanged });
});

// Remove a stream - blocked while students are in it, or if past records point to it.
router.delete('/schools/:schoolId/streams/:streamId', requireAdmin, async (req, res) => {
  const schoolId = Number(req.params.schoolId);
  const st = await mustStream(res, schoolId, Number(req.params.streamId));
  if (!st) return;
  await classSetup.removeStream(schoolId, { className: st.class_name, streamName: st.name, staffId: req.staff.staffId });
  res.json({ removed: true });
});

// Merge a stream into another stream of the SAME class: everyone moves, then the empty stream is removed.
router.post('/schools/:schoolId/streams/:streamId/merge', requireAdmin, async (req, res) => {
  const schoolId = Number(req.params.schoolId);
  const from = await mustStream(res, schoolId, Number(req.params.streamId));
  if (!from) return;
  const into = await streamInfo(schoolId, Number(req.body && req.body.into_stream_id));
  if (!into) return res.status(404).json({ error: 'The stream to merge into was not found' });
  if (into.class_id !== from.class_id) return res.status(400).json({ error: 'Streams can only be merged inside the same class.' });
  const r = await classSetup.mergeStreams(schoolId, { className: from.class_name, fromStream: from.name, intoStream: into.name, staffId: req.staff.staffId });
  res.json({ merged: true, moved: r.moved, past_moved: r.pastMoved, removed: r.removed, into_stream_id: into.id, warnings: r.warnings });
});

// The students of one class who are still at school (for the "Move students" list on a stream).
router.get('/schools/:schoolId/classes/:classId/roster', async (req, res) => {   // (named 'roster' because /students is already used by the older staff route)
  const schoolId = Number(req.params.schoolId), classId = Number(req.params.classId);
  const rows = (await pool.query(
    `SELECT s.id, s.admission_no, s.full_name, s.stream_id, st.name AS stream_name
     FROM students s LEFT JOIN streams st ON st.id = s.stream_id
     WHERE s.school_id = $1 AND s.class_id = $2 AND s.status IN ('active', 'repeating')
     ORDER BY s.full_name, s.admission_no`, [schoolId, classId])).rows;
  res.json({ students: rows });
});

// Move students (by admission number) into this stream. Only students of the stream's OWN class, only students still at school.
router.post('/schools/:schoolId/streams/:streamId/move-students', requireAdmin, async (req, res) => {
  const schoolId = Number(req.params.schoolId);
  const st = await mustStream(res, schoolId, Number(req.params.streamId));
  if (!st) return;
  const admissionNos = cleanList(req.body && req.body.admission_nos);
  if (!admissionNos || !admissionNos.length) return res.status(400).json({ error: 'Choose at least one student.' });
  const r = await classSetup.moveStudents(schoolId, { className: st.class_name, toStream: st.name, admissionNos, staffId: req.staff.staffId });
  res.json({ moved: r.moved.length, already_there: r.alreadyThere.length, unchanged: !!r.unchanged });
});

// Promotion rules: "students in <class> <stream> go to <class> <stream>" instead of the default.
router.post('/schools/:schoolId/promotion-rules', requireAdmin, async (req, res) => {
  const schoolId = Number(req.params.schoolId);
  const b = req.body || {};
  const fromClass = Number(b.from_class_id), toClass = Number(b.to_class_id);
  const fromStream = String(b.from_stream_name || '').trim() || null;   // blank = students with no stream
  const toStream = String(b.to_stream_name || '').trim() || null;       // blank = they arrive with no stream
  if (!fromClass || !toClass) return res.status(400).json({ error: 'Choose both classes.' });
  if (fromClass === toClass) return res.status(400).json({ error: 'A rule must move students to a different class.' });
  if (!(await isEnabled(schoolId, fromClass)) || !(await isEnabled(schoolId, toClass))) {
    return res.status(409).json({ error: 'Both classes must be switched on.' });
  }
  const existing = await pool.query(
    'SELECT id FROM promotion_mappings WHERE school_id = $1 AND from_class_id = $2 AND from_stream_name IS NOT DISTINCT FROM $3',
    [schoolId, fromClass, fromStream]);
  const r = existing.rows.length
    ? await pool.query('UPDATE promotion_mappings SET to_class_id = $2, to_stream_name = $3 WHERE id = $1 RETURNING *', [existing.rows[0].id, toClass, toStream])
    : await pool.query(
        'INSERT INTO promotion_mappings (school_id, from_class_id, from_stream_name, to_class_id, to_stream_name) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [schoolId, fromClass, fromStream, toClass, toStream]);
  res.json(r.rows[0]);
});

router.delete('/schools/:schoolId/promotion-rules/:ruleId', requireAdmin, async (req, res) => {
  const r = await pool.query('DELETE FROM promotion_mappings WHERE id = $1 AND school_id = $2', [Number(req.params.ruleId), Number(req.params.schoolId)]);
  if (!r.rowCount) return res.status(404).json({ error: 'Rule not found' });
  res.json({ removed: true });
});

// the Promotion screen's routes live in their own file but share this router
router.use(require('./promotionRoutes'));

module.exports = router;