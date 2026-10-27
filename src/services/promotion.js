// src/services/promotion.js - REPLACES the old file. Same rules as before, made safer:
//   1. planPromotion() works out where every student goes WITHOUT changing anything.
//      The Promotion screen shows exactly this, and the real run applies exactly this.
//   2. promoteSchool() applies the plan inside ONE database transaction: either everyone
//      moves or nobody does (a crash halfway can no longer leave a school half-promoted).
//   3. A school can promote out of a given year only ONCE (table promotion_runs).
//   4. The two years are checked before anything moves.
// The rules themselves are unchanged: next ENABLED class (disabled classes are skipped,
// no next class = graduated), stream name follows the student unless a promotion rule
// says otherwise, streams are created fresh for the new year, repeaters join the cohort
// arriving from the class below.
//
// CHANGES (promotion piece):
//   - A repeater whose stream the admin did NOT choose is placed in the stream with the FEWEST students
//     among the streams the promoted students arrive with (ties: first name A-Z). Many repeaters spread out one by one.
//     No arriving streams at all (first class, or a class below with no streams): he keeps his own stream.
//   - checkPromotionReady(): promotion is allowed only after Term 3 of the outgoing year has ended, and
//     only when no active student is without a class. promoteSchool() refuses (409) otherwise.
//   - promoteSchool() takes the same per-school lock as classSetup.js (moves and promotion never mix).
//   - A successful promotion is written to the audit log.
//   - summarizePlan() / buildDecisions(): used by the terminal tool (src/scripts/promote-school.js).
const { pool } = require('../db/db');
const { logAudit } = require('./audit');

// The same lock number classSetup.js uses (with the school id): class changes, student moves and
// promotion of one school are lined up one after the other, never at the same time.
const SCHOOL_LOCK_KEY = 7771003;

/* ------------------------------------------------------------------ */
/* the "already promoted" record (created on first use, safe to repeat) */
let runsTableReady = null;
function ensureRunsTable() {
  if (!runsTableReady) {
    runsTableReady = pool.query(
      `CREATE TABLE IF NOT EXISTS promotion_runs (
         id SERIAL PRIMARY KEY,
         school_id INTEGER NOT NULL REFERENCES schools(id),
         outgoing_academic_year_id INTEGER NOT NULL REFERENCES academic_years(id),
         incoming_academic_year_id INTEGER NOT NULL REFERENCES academic_years(id),
         staff_id INTEGER REFERENCES staff(id),
         summary JSONB,
         ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         UNIQUE (school_id, outgoing_academic_year_id)
       )`).catch((e) => { runsTableReady = null; throw e; });
  }
  return runsTableReady;
}

async function getPromotionRun(schoolId, outgoingAcademicYearId, db = pool) {
  await ensureRunsTable();
  const r = await db.query('SELECT * FROM promotion_runs WHERE school_id = $1 AND outgoing_academic_year_id = $2', [schoolId, outgoingAcademicYearId]);
  return r.rows[0] || null;
}

// The year this school is "in" right now: the year it last promoted INTO, otherwise the
// platform's current year. (academic_years is shared by all schools, so a school's own
// promotion must not flip the shared "current" flag.)
async function getSchoolActiveYear(schoolId, db = pool) {
  await ensureRunsTable();
  const run = await db.query(
    `SELECT ay.id, ay.year FROM promotion_runs pr JOIN academic_years ay ON ay.id = pr.incoming_academic_year_id
     WHERE pr.school_id = $1 ORDER BY ay.year DESC LIMIT 1`, [schoolId]);
  if (run.rows[0]) return run.rows[0];
  const cur = await db.query('SELECT id, year FROM academic_years ORDER BY is_current DESC, year DESC LIMIT 1');
  return cur.rows[0] || null;
}

/* ------------------------------------------------------------------ */
async function recordCurrentYearHistory(academicYearId, schoolId = null, db = pool) {
  await db.query(
    schoolId
      ? `INSERT INTO student_class_history (student_id, academic_year_id, class_id, stream_id)
         SELECT id, $1, class_id, stream_id FROM students WHERE class_id IS NOT NULL AND school_id = $2
         ON CONFLICT (student_id, academic_year_id) DO NOTHING`
      : `INSERT INTO student_class_history (student_id, academic_year_id, class_id, stream_id)
         SELECT id, $1, class_id, stream_id FROM students WHERE class_id IS NOT NULL
         ON CONFLICT (student_id, academic_year_id) DO NOTHING`,
    schoolId ? [academicYearId, schoolId] : [academicYearId]
  );
}

async function markStudentTransferredOut(studentId, db = pool) {
  const result = await db.query(`UPDATE students SET status = 'transferred_out' WHERE id = $1 RETURNING id, status`, [studentId]);
  if (result.rows.length === 0) throw new Error(`No student found with id ${studentId}`);
  return result.rows[0];
}

// The class right after this one in THIS school's own enabled list (none = final class).
async function getNextClass(schoolId, classId, db = pool) {
  const result = await db.query(
    `SELECT c2.* FROM classes c1
     JOIN classes c2 ON c2.sort_order > c1.sort_order
     JOIN school_classes sc2 ON sc2.class_id = c2.id AND sc2.school_id = $2 AND sc2.enabled = TRUE
     WHERE c1.id = $1 ORDER BY c2.sort_order ASC LIMIT 1`, [classId, schoolId]);
  return result.rows[0] || null;
}

// The class right BELOW this one in the school's enabled list.
async function getPreviousClass(schoolId, classId, db = pool) {
  const result = await db.query(
    `SELECT c2.* FROM classes c1
     JOIN classes c2 ON c2.sort_order < c1.sort_order
     JOIN school_classes sc2 ON sc2.class_id = c2.id AND sc2.school_id = $2 AND sc2.enabled = TRUE
     WHERE c1.id = $1 ORDER BY c2.sort_order DESC LIMIT 1`, [classId, schoolId]);
  return result.rows[0] || null;
}

// A repeater's stream options: the stream names the class one level BELOW had in the outgoing year.
async function getRepeatStreamOptions(schoolId, classId, outgoingAcademicYearId, db = pool) {
  const lowerClass = await getPreviousClass(schoolId, classId, db);
  if (!lowerClass) return [];
  const result = await db.query(
    `SELECT name FROM streams WHERE school_id = $1 AND class_id = $2 AND academic_year_id = $3 ORDER BY name`,
    [schoolId, lowerClass.id, outgoingAcademicYearId]);
  return result.rows.map((r) => r.name);
}

async function getOrCreateStream(schoolId, classId, academicYearId, streamName, db = pool) {
  if (!streamName) return null;
  const existing = await db.query(
    `SELECT id FROM streams WHERE school_id = $1 AND class_id = $2 AND academic_year_id = $3 AND name = $4`,
    [schoolId, classId, academicYearId, streamName]);
  if (existing.rows[0]) return existing.rows[0].id;
  const created = await db.query(
    `INSERT INTO streams (school_id, class_id, academic_year_id, name) VALUES ($1, $2, $3, $4) RETURNING id`,
    [schoolId, classId, academicYearId, streamName]);
  return created.rows[0].id;
}

/* ------------------------------------------------------------------ */
/* Years must make sense before anything moves.                         */
async function checkYears(outgoingId, incomingId, db = pool) {
  const r = await db.query('SELECT id, year FROM academic_years WHERE id = ANY($1::int[])', [[Number(outgoingId), Number(incomingId)]]);
  const out = r.rows.find((y) => y.id === Number(outgoingId));
  const inc = r.rows.find((y) => y.id === Number(incomingId));
  if (!out) throw new Error('The year being promoted from does not exist.');
  if (!inc) throw new Error('The year being promoted into does not exist. Create it first.');
  if (inc.year <= out.year) throw new Error(`The new year (${inc.year}) must come after ${out.year}.`);
  return { out, inc };
}

/**
 * Works out where every active student with a class goes. Changes NOTHING.
 * decisions: { studentId: 'leave' | 'repeat' | { action:'repeat', classId?, streamName? } }
 * Returns one entry per student: { student_id, admission_no, full_name, class_id, class_name, stream_name,
 *   action: 'promote'|'repeat'|'leave'|'graduate', dest_class_id, dest_class_name, dest_stream_name }
 */
async function planPromotion({ schoolId, outgoingAcademicYearId, decisions = {}, db = pool }) {
  const students = (await db.query(
    `SELECT s.id, s.admission_no, s.full_name, s.class_id, c.name AS class_name, s.stream_id, st.name AS stream_name
     FROM students s JOIN classes c ON c.id = s.class_id LEFT JOIN streams st ON st.id = s.stream_id
     WHERE s.school_id = $1 AND s.class_id IS NOT NULL AND s.status = 'active'
     ORDER BY c.sort_order, st.name NULLS FIRST, s.full_name, s.id`, [schoolId])).rows;

  const classNames = new Map((await db.query('SELECT id, name FROM classes')).rows.map((c) => [c.id, c.name]));
  const rules = new Map();
  (await db.query('SELECT * FROM promotion_mappings WHERE school_id = $1', [schoolId])).rows
    .forEach((r) => rules.set(r.from_class_id + '|' + (r.from_stream_name === null ? '\u0000' : r.from_stream_name), r));
  const nextCache = new Map();

  const plan = [];
  for (const s of students) {
    const base = { student_id: s.id, admission_no: s.admission_no, full_name: s.full_name, class_id: s.class_id, class_name: s.class_name, stream_name: s.stream_name };
    const decision = decisions[s.id];

    if (decision === 'leave') { plan.push({ ...base, action: 'leave', dest_class_id: null, dest_class_name: null, dest_stream_name: null }); continue; }

    if (decision === 'repeat') {
      // stream not chosen: placed after everyone else is known (see placeRepeaters)
      plan.push({ ...base, action: 'repeat', dest_class_id: s.class_id, dest_class_name: s.class_name, dest_stream_name: null, placement: 'auto' });
      continue;
    }

    if (decision && typeof decision === 'object' && decision.action === 'repeat') {
      const destClass = decision.classId || s.class_id;
      // noStream: true = the admin chose "No stream" on purpose. A stream name = the admin chose that stream.
      // Neither = automatic (fewest students).
      plan.push({
        ...base, action: 'repeat', dest_class_id: destClass, dest_class_name: classNames.get(destClass) || null,
        dest_stream_name: decision.noStream ? null : (decision.streamName || null),
        placement: decision.noStream ? 'nostream' : decision.streamName ? 'chosen' : 'auto',
      });
      continue;
    }

    if (!nextCache.has(s.class_id)) nextCache.set(s.class_id, await getNextClass(schoolId, s.class_id, db));
    const next = nextCache.get(s.class_id);
    if (!next) { plan.push({ ...base, action: 'graduate', dest_class_id: null, dest_class_name: null, dest_stream_name: null }); continue; }

    const rule = rules.get(s.class_id + '|' + (s.stream_name === null ? '\u0000' : s.stream_name));
    const destClass = rule ? rule.to_class_id : next.id;
    plan.push({
      ...base, action: 'promote', dest_class_id: destClass, dest_class_name: classNames.get(destClass) || null,
      dest_stream_name: rule ? rule.to_stream_name : s.stream_name,
    });
  }
  return placeRepeaters(plan);
}

// Order used for stream names: A-Z ignoring capitals, then exact (so the result never depends on luck).
function byName(a, b) {
  const x = String(a).toLowerCase(), y = String(b).toLowerCase();
  if (x !== y) return x < y ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Places the repeaters whose stream the admin did not choose (placement 'auto'). Pure: changes the plan only.
 *   1. The streams a class is arriving WITH are the streams its PROMOTED students bring (after any promotion
 *      rule). Count the students in each.
 *   2. A repeater the admin placed counts too, but only when he joined one of those streams. A stream the admin
 *      invented for one repeater is not a stream the cohort arrives with, so others are never sent into it.
 *   3. One repeater at a time (plan order), join the arriving stream with the FEWEST students; on a tie the
 *      first name A-Z. The count goes up by one, so several repeaters spread out.
 *   4. Nobody arrives with a stream (first class, or the class below had no streams): he keeps his OWN stream
 *      (or none, if he had none).
 * Each repeater gets placement 'chosen' (admin), 'nostream' (admin chose no stream), 'fewest', 'own' or 'none'.
 */
function placeRepeaters(plan) {
  const arriving = new Map();   // destination class id -> Map(stream name -> students)
  for (const p of plan) {
    if (p.action !== 'promote' || !p.dest_stream_name) continue;
    if (!arriving.has(p.dest_class_id)) arriving.set(p.dest_class_id, new Map());
    const m = arriving.get(p.dest_class_id);
    m.set(p.dest_stream_name, (m.get(p.dest_stream_name) || 0) + 1);
  }
  for (const p of plan) {
    if (p.action !== 'repeat' || p.placement !== 'chosen') continue;
    const m = arriving.get(p.dest_class_id);
    if (m && m.has(p.dest_stream_name)) m.set(p.dest_stream_name, m.get(p.dest_stream_name) + 1);
  }
  for (const p of plan) {
    if (p.placement !== 'auto') continue;
    const m = arriving.get(p.dest_class_id);
    if (m && m.size) {
      let best = null;
      for (const [name, n] of m) if (!best || n < best.n || (n === best.n && byName(name, best.name) < 0)) best = { name, n };
      p.dest_stream_name = best.name;
      p.placement = 'fewest';
      m.set(best.name, best.n + 1);
    } else {
      p.dest_stream_name = p.stream_name || null;
      p.placement = p.stream_name ? 'own' : 'none';
    }
  }
  return plan;
}

/**
 * A readable summary of a plan (pure): totals, per class, who arrives where, repeaters, leavers.
 * classes: [{ id, name, sort_order }] (the school's switched-on classes) - used for the order.
 */
function summarizePlan(plan, classes = []) {
  const order = new Map(classes.map((c) => [c.id, c.sort_order]));
  const rank = (id) => (order.has(id) ? order.get(id) : 9999);
  const totals = { promote: 0, repeat: 0, leave: 0, graduate: 0 };
  const source = new Map(), arrivals = new Map();
  for (const p of plan) {
    totals[p.action]++;
    if (!source.has(p.class_id)) source.set(p.class_id, { class_id: p.class_id, class_name: p.class_name, students: 0, promote: 0, repeat: 0, leave: 0, graduate: 0 });
    const row = source.get(p.class_id); row.students++; row[p.action]++;
    if (p.action === 'promote' || p.action === 'repeat') {
      if (!arrivals.has(p.dest_class_id)) arrivals.set(p.dest_class_id, { class_id: p.dest_class_id, class_name: p.dest_class_name, total: 0, noStream: 0, streams: new Map() });
      const a = arrivals.get(p.dest_class_id); a.total++;
      if (p.dest_stream_name) a.streams.set(p.dest_stream_name, (a.streams.get(p.dest_stream_name) || 0) + 1); else a.noStream++;
    }
  }
  return {
    totals,
    bySource: [...source.values()].sort((a, b) => rank(a.class_id) - rank(b.class_id)),
    arrivals: [...arrivals.values()].sort((a, b) => rank(a.class_id) - rank(b.class_id))
      .map((a) => ({ class_id: a.class_id, class_name: a.class_name, total: a.total, noStream: a.noStream, streams: [...a.streams.entries()].sort((x, y) => byName(x[0], y[0])).map(([name, count]) => ({ name, count })) })),
    repeaters: plan.filter((p) => p.action === 'repeat').map((p) => ({ admission_no: p.admission_no, full_name: p.full_name, class_name: p.class_name, from_stream: p.stream_name || null, to_class_name: p.dest_class_name, to_stream: p.dest_stream_name || null, placement: p.placement })),
    leavers: plan.filter((p) => p.action === 'leave').map((p) => ({ admission_no: p.admission_no, full_name: p.full_name, class_name: p.class_name, stream_name: p.stream_name || null })),
    graduates: plan.filter((p) => p.action === 'graduate').map((p) => ({ admission_no: p.admission_no, class_name: p.class_name })),
  };
}

/**
 * Turns admission numbers into the decisions planPromotion wants. Refuses (nothing guessed) when a number is
 * unknown, is not an active student with a class, is named twice with different decisions, or a stream choice
 * is given for a student who is not repeating.
 *   input: { repeat: ['ADM1'], leave: ['ADM2'], streams: { ADM1: 'Pink' } }
 */
async function buildDecisions(schoolId, { repeat = [], leave = [], streams = {} } = {}, db = pool) {
  const clean = (x) => String(x == null ? '' : x).trim();
  const lc = (x) => clean(x).toLowerCase();
  const reps = [...new Set(repeat.map(clean).filter(Boolean).map(lc))];
  const leaves = [...new Set(leave.map(clean).filter(Boolean).map(lc))];
  const choice = new Map(Object.entries(streams).map(([k, v]) => [lc(k), clean(v)]));
  const fail = (m) => Object.assign(new Error(m), { status: 400 });
  const both = reps.filter((a) => leaves.includes(a));
  if (both.length) throw fail(`${both.join(', ')} ${both.length === 1 ? 'is' : 'are'} marked both repeating and leaving. Choose one.`);
  const stray = [...choice.keys()].filter((a) => !reps.includes(a));
  if (stray.length) throw fail(`A stream was chosen for ${stray.join(', ')}, but ${stray.length === 1 ? 'that student is' : 'those students are'} not marked repeating.`);
  for (const [a, name] of choice) if (!name || name.length > 40) throw fail(`The stream chosen for ${a} must be 1 to 40 characters.`);
  const wanted = [...reps, ...leaves];
  const decisions = {};
  if (!wanted.length) return decisions;
  const rows = (await db.query(
    `SELECT id, admission_no, full_name, class_id, status FROM students WHERE school_id = $1 AND lower(admission_no) = ANY($2::text[])`,
    [schoolId, wanted])).rows;
  const byAdm = new Map(rows.map((r) => [String(r.admission_no).toLowerCase(), r]));
  const unknown = wanted.filter((a) => !byAdm.has(a));
  if (unknown.length) throw fail(`No student with admission number ${unknown.join(', ')} in this school.`);
  const unfit = wanted.map((a) => byAdm.get(a)).filter((r) => r.status !== 'active' || !r.class_id);
  if (unfit.length) throw fail(`${unfit.map((r) => `${r.admission_no} (${r.full_name})`).join(', ')} ${unfit.length === 1 ? 'is' : 'are'} not an active student with a class, so promotion does not apply.`);
  for (const a of reps) decisions[byAdm.get(a).id] = choice.has(a) ? { action: 'repeat', streamName: choice.get(a) } : 'repeat';
  for (const a of leaves) decisions[byAdm.get(a).id] = 'leave';
  return decisions;
}

function addDays(dayText, n) {
  const [y, m, d] = dayText.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * Can this school be promoted right now? Changes nothing.
 *   problems -> promotion is refused until they are fixed
 *   warnings -> promotion is allowed, but the person must know
 * Rules:
 *   - Term 3 of the year being left must have dates, and must have ENDED (promotion from the day after).
 *     Otherwise students would sit in their new class while the old term is still running.
 *   - Every active student must have a class (promotion would silently skip them).
 *   - Warns when the new year has no dates yet, or its first term already started / was already charged.
 */
async function checkPromotionReady({ schoolId, outgoingAcademicYearId, incomingAcademicYearId, db = pool }) {
  // problems and warnings are plain words for a school admin. `commands` are terminal hints for the operator.
  const problems = [], warnings = [], commands = [], fixes = [];
  const years = (await db.query('SELECT id, year FROM academic_years WHERE id = ANY($1::int[])', [[Number(outgoingAcademicYearId), Number(incomingAcademicYearId)]])).rows;
  const out = years.find((y) => y.id === Number(outgoingAcademicYearId)), inc = years.find((y) => y.id === Number(incomingAcademicYearId));
  if (!out || !inc) { problems.push('The year being promoted from, or into, does not exist.'); return { problems, warnings, commands }; }
  const today = (await db.query(`SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS today`)).rows[0].today;
  const terms = (await db.query(
    `SELECT t.id, t.academic_year_id, t.term_number, to_char(d.start_date, 'YYYY-MM-DD') AS start_day, to_char(d.end_date, 'YYYY-MM-DD') AS end_day,
            EXISTS (SELECT 1 FROM term_billing r WHERE r.term_id = t.id AND r.school_id = $2) AS charged
     FROM terms t LEFT JOIN school_term_dates d ON d.term_id = t.id AND d.school_id = $2
     WHERE t.academic_year_id = ANY($1::int[]) ORDER BY t.academic_year_id, t.term_number`,
    [[out.id, inc.id], schoolId])).rows;

  const last = terms.find((t) => t.academic_year_id === out.id && t.term_number === 3);
  if (!last || !last.end_day) {
    problems.push(`Term 3 of ${out.year} has no dates yet, so we do not know when the school year ends. Add its start and end dates, then come back.`);
    commands.push(`node src\\scripts\\set-terms.js ${schoolId} ${out.year} 3 <start> <end>`);
    fixes.push({ kind: 'term_dates', year: out.year, term: 3 });
  } else if (last.end_day >= today) {
    problems.push(`The school year is not finished: Term 3 ${out.year} ends on ${last.end_day}. Promotion can be done from ${addDays(last.end_day, 1)}.`);
  }

  const noClass = (await db.query(`SELECT admission_no FROM students WHERE school_id = $1 AND class_id IS NULL AND status = 'active' ORDER BY admission_no`, [schoolId])).rows;
  if (noClass.length) {
    const shown = noClass.slice(0, 5).map((r) => r.admission_no).join(', ') + (noClass.length > 5 ? ` and ${noClass.length - 5} more` : '');
    problems.push(`${noClass.length} active ${noClass.length === 1 ? 'student has' : 'students have'} no class (${shown}). Promotion would skip ${noClass.length === 1 ? 'him or her' : 'them'}. Give each a class first, or mark them as left.`);
  }

  const first = terms.find((t) => t.academic_year_id === inc.id && t.term_number === 1);
  if (first && !first.start_day) {
    warnings.push(`${inc.year} has no term dates yet. Set Term 1 before it begins, or payments will not reach balances (Academic years & terms).`);
    commands.push(`node src\\scripts\\set-terms.js ${schoolId} ${inc.year} 1 <start> <end>`);
    fixes.push({ kind: 'term_dates', year: inc.year, term: 1 });
  } else if (first && first.start_day <= today) {
    warnings.push(first.charged
      ? `Term 1 ${inc.year} already started (${first.start_day}) and its fees were ALREADY charged, so these students were charged the fees of their OLD class. After promotion the fees must be charged again.`
      : `Term 1 ${inc.year} already started (${first.start_day}). The server charges it at its next check, so promote and set the new fees BEFORE that.`);
  }
  return { problems, warnings, commands, fixes };
}

/**
 * Promotes a school into a new academic year. All-or-nothing, and only once per outgoing year.
 * Returns { promoted, repeating, leftOrTransferred, graduated } (lists of student ids), as before.
 */
async function promoteSchool({ outgoingAcademicYearId, incomingAcademicYearId, schoolId, decisions = {}, staffId = null }) {
  const { out, inc } = await checkYears(outgoingAcademicYearId, incomingAcademicYearId);
  await ensureRunsTable();

  const client = await pool.connect();
  let result;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [SCHOOL_LOCK_KEY, schoolId]);   // not at the same time as moves or class changes

    // the guard: a second run for the same school + outgoing year finds this row and stops
    const claim = await client.query(
      `INSERT INTO promotion_runs (school_id, outgoing_academic_year_id, incoming_academic_year_id, staff_id)
       VALUES ($1, $2, $3, $4) ON CONFLICT (school_id, outgoing_academic_year_id) DO NOTHING RETURNING id`,
      [schoolId, outgoingAcademicYearId, incomingAcademicYearId, staffId]);
    if (!claim.rows.length) {
      const prev = await getPromotionRun(schoolId, outgoingAcademicYearId, client);
      const err = new Error('This school has already been promoted out of that year (on ' + new Date(prev.ran_at).toISOString().slice(0, 10) + ').');
      err.code = 'ALREADY_PROMOTED';
      throw err;
    }

    // not ready (the year is not finished, students without a class)? Refuse before anything moves.
    const ready = await checkPromotionReady({ schoolId, outgoingAcademicYearId, incomingAcademicYearId, db: client });
    if (ready.problems.length) throw Object.assign(new Error(ready.problems.join(' ')), { code: 'NOT_READY', status: 409 });

    await recordCurrentYearHistory(outgoingAcademicYearId, schoolId, client);
    const plan = await planPromotion({ schoolId, outgoingAcademicYearId, decisions, db: client });

    result = { promoted: [], repeating: [], leftOrTransferred: [], graduated: [] };
    for (const p of plan) {
      if (p.action === 'leave') {
        await markStudentTransferredOut(p.student_id, client);
        result.leftOrTransferred.push(p.student_id);
      } else if (p.action === 'graduate') {
        await client.query(`UPDATE students SET status = 'graduated' WHERE id = $1`, [p.student_id]);
        result.graduated.push(p.student_id);
      } else {
        const streamId = await getOrCreateStream(schoolId, p.dest_class_id, incomingAcademicYearId, p.dest_stream_name, client);
        await client.query('UPDATE students SET class_id = $1, stream_id = $2 WHERE id = $3', [p.dest_class_id, streamId, p.student_id]);
        (p.action === 'repeat' ? result.repeating : result.promoted).push(p.student_id);
      }
    }

    await client.query('UPDATE promotion_runs SET summary = $2 WHERE id = $1', [claim.rows[0].id, JSON.stringify({
      promoted: result.promoted.length, repeating: result.repeating.length, left: result.leftOrTransferred.length, graduated: result.graduated.length,
    })]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  await logAudit({ schoolId, staffId, action: 'school_promoted', detail: {
    outgoing_year: out.year, incoming_year: inc.year, promoted: result.promoted.length, repeating: result.repeating.length,
    left: result.leftOrTransferred.length, graduated: result.graduated.length,
  } });
  return result;
}

async function admitStudents(schoolId, students) {
  const inserted = [];
  for (const s of students) {
    const result = await pool.query(
      `INSERT INTO students (school_id, admission_no, full_name, class_id, stream_id, guardian_phone, guardian_name, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
       RETURNING *`,
      [schoolId, s.admissionNo, s.fullName, s.classId, s.streamId || null, s.guardianPhone || null, s.guardianName || null]);
    inserted.push(result.rows[0]);
  }
  return inserted;
}

async function transferInStudent({ schoolId, admissionNo, fullName, classId, streamId = null, guardianPhone = null, guardianName = null }) {
  const [student] = await admitStudents(schoolId, [{ admissionNo, fullName, classId, streamId, guardianPhone, guardianName }]);
  return student;
}

module.exports = {
  promoteSchool, planPromotion, placeRepeaters, summarizePlan, buildDecisions, checkPromotionReady, SCHOOL_LOCK_KEY, checkYears, getPromotionRun, getSchoolActiveYear,
  recordCurrentYearHistory, transferInStudent, admitStudents,
  markStudentTransferredOut, getNextClass, getPreviousClass, getRepeatStreamOptions, getOrCreateStream,
};