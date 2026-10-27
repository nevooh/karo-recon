/**
 * A school's classes and streams.
 *
 * This is the one engine for it. The command line (src/scripts/set-classes.js) uses it today,
 * and your future operator dashboard can call the very same functions, so the rules are never copied.
 *
 * How classes work here:
 *   - The 15 levels (Playgroup, PP1, PP2, Grade 1 ... Grade 12) are the same for every school.
 *   - Each school switches ON the ones it runs. Nothing else needs typing.
 *   - Promotion moves a student to the NEXT switched-on class. The last switched-on class is where
 *     students graduate. So this list decides who graduates, and who is skipped.
 *   - A stream (North, South, Red ...) belongs to one school, one class and one academic year.
 *
 * What it guarantees:
 *   - A class with students in it can never be switched off (move or promote them first).
 *   - Class names are read forgivingly ("grade 7", "Grade7", "pp 1") but an unknown name is refused
 *     with the list of real names. Nothing is ever guessed.
 *   - Streams need a switched-on class and an academic year (set the terms first).
 *   - A stream name is used once per class and year, ignoring capitals ("North" and "north" are the same).
 *   - Students move between streams of the SAME class only, and only active students of this school
 *     (move one or many by admission number). A new stream can be made in the same step.
 *   - Merging two streams moves everyone from one into the other and then removes the empty one.
 *   - A stream with students cannot be removed. A stream used in a promotion rule cannot be renamed
 *     (rules find streams by NAME, so renaming would quietly break the rule).
 *   - One change at a time per school (two people at the same instant are lined up), all or nothing.
 *   - dry: true does every check and changes NOTHING.
 *   - Every real change is written to the audit log.
 * It never touches a student, a fee or a payment.
 */
const { pool } = require('../db/db');
const { logAudit } = require('./audit');
const { getSchoolActiveYear } = require('./promotion');

const LINE_UP_KEY = 7771003;      // any fixed number: with the school id, lines changes up one at a time per school
const IN_CLASS = `('active', 'repeating')`;   // students who are still in their class

function refuse(message, status = 400) { const e = new Error(message); e.status = status; return e; }

// "Grade 7", "grade7", " GRADE  7 " -> "grade7"
const key = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
const cleanName = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/* ------------------------------------------------------------------ */
/* finding a school                                                    */
async function listSchools(deps = {}) {
  const db = deps.pool || pool;
  return (await db.query('SELECT id, name FROM schools ORDER BY id')).rows;
}

// "12" -> school number 12. Anything else is read as the school's exact name (capitals and extra spaces ignored).
async function findSchool(ref, deps = {}) {
  const db = deps.pool || pool;
  const text = cleanName(ref);
  if (!text) throw refuse('Say which school: its name in "double quotes", or its number.');
  if (/^\d+$/.test(text)) {
    const r = await db.query('SELECT id, name FROM schools WHERE id = $1', [Number(text)]);
    if (!r.rows.length) throw refuse(`There is no school with number ${text}. To see all schools: node src/scripts/set-classes.js schools`, 404);
    return r.rows[0];
  }
  const r = await db.query('SELECT id, name FROM schools WHERE lower(btrim(name)) = lower($1)', [text]);
  if (!r.rows.length) throw refuse(`There is no school named "${text}". To see all schools: node src/scripts/set-classes.js schools`, 404);
  if (r.rows.length > 1) throw refuse(`More than one school is named "${text}". Use its number instead: ${r.rows.map((s) => s.id).join(', ')}.`, 409);
  return r.rows[0];
}

/* ------------------------------------------------------------------ */
/* reading                                                             */
async function loadClasses(db, schoolId) {
  const r = await db.query(
    `SELECT c.id, c.name, c.sort_order, COALESCE(sc.enabled, FALSE) AS enabled,
            (SELECT COUNT(*)::int FROM students s WHERE s.school_id = $1 AND s.class_id = c.id AND s.status IN ${IN_CLASS}) AS students
     FROM classes c LEFT JOIN school_classes sc ON sc.class_id = c.id AND sc.school_id = $1
     ORDER BY c.sort_order`, [schoolId]);
  return r.rows;
}

async function loadStreams(db, schoolId, yearId) {
  if (!yearId) return [];
  const r = await db.query(
    `SELECT st.id, st.class_id, st.name,
            (SELECT COUNT(*)::int FROM students s WHERE s.stream_id = st.id AND s.status IN ${IN_CLASS}) AS students
     FROM streams st WHERE st.school_id = $1 AND st.academic_year_id = $2 ORDER BY lower(st.name)`, [schoolId, yearId]);
  return r.rows;
}

// The first and last switched-on class, and a warning for every switched-off class that sits BETWEEN two
// switched-on ones (promotion skips it). `classes` must be in class order, each with `enabled`.
function describe(classes) {
  const on = classes.filter((c) => c.enabled);
  if (!on.length) return { first: null, last: null, warnings: [] };
  const warnings = [];
  for (let i = 0; i < on.length - 1; i++) {
    const a = on[i], b = on[i + 1];
    const skipped = classes.filter((c) => c.sort_order > a.sort_order && c.sort_order < b.sort_order);
    if (skipped.length) {
      warnings.push(`${skipped.map((c) => c.name).join(', ')} ${skipped.length === 1 ? 'is' : 'are'} switched off between ${a.name} and ${b.name}. ` +
        `Students in ${a.name} will be promoted straight to ${b.name}.`);
    }
  }
  return { first: on[0], last: on[on.length - 1], warnings };
}

/** Everything about a school's classes: on/off, students, this year's streams, first and last class. */
async function getOverview(schoolId, deps = {}) {
  const db = deps.pool || pool;
  const school = (await db.query('SELECT id, name FROM schools WHERE id = $1', [schoolId])).rows[0];
  if (!school) throw refuse(`There is no school with number ${schoolId}.`, 404);
  const year = await getSchoolActiveYear(schoolId, db);
  const classes = await loadClasses(db, schoolId);
  const streams = await loadStreams(db, schoolId, year && year.id);
  classes.forEach((c) => { c.streams = streams.filter((s) => s.class_id === c.id).map((s) => ({ id: s.id, name: s.name, students: s.students })); });
  const d = describe(classes);
  return { school, year: year ? { id: year.id, year: year.year } : null, classes, first: d.first && d.first.name, last: d.last && d.last.name, warnings: d.warnings };
}

/* ------------------------------------------------------------------ */
/* one change at a time per school, all or nothing                     */
async function inTransaction(deps, schoolId, dry, work) {
  const db = deps.pool || pool;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [LINE_UP_KEY, schoolId]);
    const school = (await client.query('SELECT id, name FROM schools WHERE id = $1', [schoolId])).rows[0];
    if (!school) throw refuse(`There is no school with number ${schoolId}.`, 404);
    const out = await work(client, school);
    await client.query(dry || out.unchanged ? 'ROLLBACK' : 'COMMIT');
    return out;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* the connection is already gone */ }
    throw err;
  } finally {
    client.release();
  }
}

// Class names typed by a person -> real class rows. Unknown names are refused, never guessed.
function resolveClasses(all, names) {
  const wanted = (names || []).map(cleanName).filter(Boolean);
  if (!wanted.length) throw refuse('Say which classes, for example: "Grade 7" "Grade 8".');
  const found = [], unknown = [];
  for (const w of wanted) {
    const c = all.find((x) => key(x.name) === key(w));
    if (!c) unknown.push(w); else if (!found.includes(c)) found.push(c);
  }
  if (unknown.length) {
    throw refuse(`Unknown class: ${unknown.map((u) => `"${u}"`).join(', ')}. The classes are: ${all.map((c) => c.name).join(', ')}.`);
  }
  return found;
}

/* ------------------------------------------------------------------ */
/* switching classes on and off                                        */
/**
 * mode 'on'    -> switch these classes on (the others stay as they are)
 * mode 'off'   -> switch these classes off (refused while they have students)
 * mode 'range' -> the school runs EXACTLY this range: these two classes and everything between are on,
 *                 every other class is off. Give the two ends in either order.
 * mode 'exactly' -> the school runs EXACTLY these classes (any list, even empty): what the Choose classes
 *                 sheet on the screen saves. Every other class is switched off (refused while it has students).
 * staffId (optional) -> who did it, for the audit log.
 * Returns { dry, unchanged, switchedOn, switchedOff, enabled, first, last, warnings }.
 */
async function setClasses(schoolId, { mode, names, dry = false, staffId = null }, deps = {}) {
  if (!['on', 'off', 'range', 'exactly'].includes(mode)) throw refuse('mode must be on, off, range or exactly.');
  if (mode === 'range' && (names || []).map(cleanName).filter(Boolean).length !== 2) {
    throw refuse('A range needs exactly two classes: where it starts and where it ends, for example "Grade 7" "Grade 12".');
  }
  let result;
  await inTransaction(deps, schoolId, dry, async (client, school) => {
    const all = await loadClasses(client, schoolId);
    const picked = mode === 'exactly' && !(names || []).map(cleanName).filter(Boolean).length ? [] : resolveClasses(all, names);

    const target = new Set();
    if (mode === 'exactly') {
      picked.forEach((c) => target.add(c.id));
    } else if (mode === 'range') {
      const lo = Math.min(...picked.map((c) => c.sort_order)), hi = Math.max(...picked.map((c) => c.sort_order));
      all.filter((c) => c.sort_order >= lo && c.sort_order <= hi).forEach((c) => target.add(c.id));
    } else {
      all.filter((c) => c.enabled).forEach((c) => target.add(c.id));
      picked.forEach((c) => (mode === 'on' ? target.add(c.id) : target.delete(c.id)));
    }

    const turnOn = all.filter((c) => !c.enabled && target.has(c.id));
    const turnOff = all.filter((c) => c.enabled && !target.has(c.id));
    const blocked = turnOff.filter((c) => c.students > 0);
    if (blocked.length) {
      throw refuse(`Cannot switch off ${blocked.map((c) => `${c.name} (${plural(c.students, 'student', 'students')})`).join(', ')}. ` +
        'Move or promote those students first.', 409);
    }

    const after = all.map((c) => ({ ...c, enabled: target.has(c.id) }));
    const d = describe(after);
    result = {
      dry, unchanged: !turnOn.length && !turnOff.length,
      switchedOn: turnOn.map((c) => c.name), switchedOff: turnOff.map((c) => c.name),
      enabled: after.filter((c) => c.enabled).map((c) => c.name),
      first: d.first && d.first.name, last: d.last && d.last.name, warnings: d.warnings, school,
    };
    if (result.unchanged) return { unchanged: true };

    for (const c of [...turnOn, ...turnOff]) {
      await client.query(
        `INSERT INTO school_classes (school_id, class_id, enabled) VALUES ($1, $2, $3)
         ON CONFLICT (school_id, class_id) DO UPDATE SET enabled = $3`, [schoolId, c.id, target.has(c.id)]);
    }
    return {};
  });
  if (!result.dry && !result.unchanged) {
    await logAudit({ schoolId, staffId, action: 'classes_changed', detail: { switched_on: result.switchedOn, switched_off: result.switchedOff, via: 'set-classes' } });
  }
  delete result.school;
  return result;
}

/* ------------------------------------------------------------------ */
/* streams                                                             */
function validStreamName(raw) {
  const n = cleanName(raw);
  if (!n || n.length > 40 || /[\u0000-\u001f\u007f]/.test(n)) throw refuse('A stream name must be 1 to 40 characters, for example North or Red.');
  return n;
}

async function needYear(client, schoolId) {
  const year = await getSchoolActiveYear(schoolId, client);
  if (!year) throw refuse('There is no academic year yet. Set the terms first (Academic years & terms).', 409);
  return year;
}

async function findStream(client, schoolId, classId, yearId, name) {
  const r = await client.query(
    `SELECT id, name FROM streams WHERE school_id = $1 AND class_id = $2 AND academic_year_id = $3 AND lower(name) = lower($4)`,
    [schoolId, classId, yearId, name]);
  return r.rows[0] || null;
}

async function addStream(schoolId, { className, streamName, dry = false, staffId = null }, deps = {}) {
  const name = validStreamName(streamName);
  let result;
  await inTransaction(deps, schoolId, dry, async (client) => {
    const all = await loadClasses(client, schoolId);
    const [cls] = resolveClasses(all, [className]);
    if (!cls.enabled) throw refuse(`${cls.name} is switched off for this school. Switch the class on first.`, 409);
    const year = await needYear(client, schoolId);
    const same = await findStream(client, schoolId, cls.id, year.id, name);
    if (same) throw refuse(`${cls.name} already has a stream called "${same.name}" for ${year.year}.`, 409);
    try {
      await client.query('INSERT INTO streams (school_id, class_id, academic_year_id, name) VALUES ($1, $2, $3, $4)', [schoolId, cls.id, year.id, name]);
    } catch (e) {
      if (e.code === '23505') throw refuse(`${cls.name} already has a stream called "${name}" for ${year.year}.`, 409);
      throw e;
    }
    result = { dry, class: cls.name, stream: name, year: year.year };
    return {};
  });
  if (!dry) await logAudit({ schoolId, staffId, action: 'stream_added', detail: { class: result.class, stream: result.stream, year: result.year, via: 'set-classes' } });
  return result;
}

async function renameStream(schoolId, { className, oldName, newName, dry = false, staffId = null }, deps = {}) {
  const to = validStreamName(newName);
  let result;
  await inTransaction(deps, schoolId, dry, async (client) => {
    const all = await loadClasses(client, schoolId);
    const [cls] = resolveClasses(all, [className]);
    const year = await needYear(client, schoolId);
    const st = await findStream(client, schoolId, cls.id, year.id, cleanName(oldName));
    if (!st) throw refuse(`${cls.name} has no stream called "${cleanName(oldName)}" for ${year.year}.`, 404);
    if (st.name === to) { result = { dry, unchanged: true, class: cls.name, stream: st.name, year: year.year }; return { unchanged: true }; }
    const clash = await findStream(client, schoolId, cls.id, year.id, to);
    if (clash && clash.id !== st.id) throw refuse(`${cls.name} already has a stream called "${clash.name}" for ${year.year}.`, 409);
    const rule = await client.query(
      `SELECT 1 FROM promotion_mappings WHERE school_id = $1
         AND ((from_class_id = $2 AND lower(from_stream_name) = lower($3)) OR (to_class_id = $2 AND lower(to_stream_name) = lower($3))) LIMIT 1`,
      [schoolId, cls.id, st.name]);
    if (rule.rows.length) throw refuse(`A promotion rule uses the stream name "${st.name}". Rules find streams by name, so renaming would break it. Remove that rule first.`, 409);
    await client.query('UPDATE streams SET name = $1 WHERE id = $2', [to, st.id]);
    result = { dry, unchanged: false, class: cls.name, from: st.name, stream: to, year: year.year };
    return {};
  });
  if (!dry && !result.unchanged) await logAudit({ schoolId, staffId, action: 'stream_renamed', detail: { class: result.class, from: result.from, to: result.stream, year: result.year, via: 'set-classes' } });
  return result;
}

async function removeStream(schoolId, { className, streamName, dry = false, staffId = null }, deps = {}) {
  let result;
  await inTransaction(deps, schoolId, dry, async (client) => {
    const all = await loadClasses(client, schoolId);
    const [cls] = resolveClasses(all, [className]);
    const year = await needYear(client, schoolId);
    const st = await findStream(client, schoolId, cls.id, year.id, cleanName(streamName));
    if (!st) throw refuse(`${cls.name} has no stream called "${cleanName(streamName)}" for ${year.year}.`, 404);
    const n = (await client.query(`SELECT COUNT(*)::int AS n FROM students WHERE stream_id = $1 AND status IN ${IN_CLASS}`, [st.id])).rows[0].n;
    if (n > 0) throw refuse(`Cannot remove ${cls.name} ${st.name}: ${plural(n, 'student is', 'students are')} still in it. Move them to another stream first.`, 409);
    try {
      await client.query('DELETE FROM streams WHERE id = $1', [st.id]);
    } catch (e) {
      if (e.code === '23503') throw refuse(`Cannot remove ${cls.name} ${st.name}: it is part of past records (students who left or graduated). It stays.`, 409);
      throw e;
    }
    result = { dry, class: cls.name, stream: st.name, year: year.year };
    return {};
  });
  if (!dry) await logAudit({ schoolId, staffId, action: 'stream_removed', detail: { class: result.class, stream: result.stream, year: result.year, via: 'set-classes' } });
  return result;
}

/* ------------------------------------------------------------------ */
/* moving students between streams (same class only) and merging       */
const MOVE_LIMIT = 500;

/**
 * Moves students into one stream of THEIR OWN class (this year). Students are named by admission number.
 *   create: true -> the stream is made first if it does not exist yet
 * Everything is refused (nothing moves) if ANY student is unknown, is in another class, or is not active.
 * Students who are already in that stream are skipped, not an error.
 * Returns { dry, created, class, stream, year, moved: [{ admission_no, full_name, from }], alreadyThere: [admission_no] }.
 */
async function moveStudents(schoolId, { className, toStream, admissionNos, create = false, dry = false, staffId = null }, deps = {}) {
  const seen = new Map();
  for (const a of (admissionNos || []).map(cleanName).filter(Boolean)) if (!seen.has(a.toLowerCase())) seen.set(a.toLowerCase(), a);
  const wanted = [...seen.values()];
  if (!wanted.length) throw refuse('Say which students: their admission numbers, for example ADM343 ADM344.');
  if (wanted.length > MOVE_LIMIT) throw refuse(`Move at most ${MOVE_LIMIT} students at a time.`);
  const toName = cleanName(toStream);
  if (!toName) throw refuse('Say which stream the students go to.');

  let result;
  await inTransaction(deps, schoolId, dry, async (client) => {
    const all = await loadClasses(client, schoolId);
    const [cls] = resolveClasses(all, [className]);
    if (!cls.enabled) throw refuse(`${cls.name} is switched off for this school. Switch the class on first.`, 409);
    const year = await needYear(client, schoolId);

    let target = await findStream(client, schoolId, cls.id, year.id, toName);
    let created = false;
    if (!target) {
      if (!create) throw refuse(`${cls.name} has no stream called "${toName}" for ${year.year}. Add it first, or add --create to make it in the same step.`, 404);
      const nm = validStreamName(toName);
      try {
        const ins = await client.query('INSERT INTO streams (school_id, class_id, academic_year_id, name) VALUES ($1, $2, $3, $4) RETURNING id', [schoolId, cls.id, year.id, nm]);
        target = { id: ins.rows[0].id, name: nm };
      } catch (e) {
        if (e.code === '23505') throw refuse(`${cls.name} already has a stream called "${nm}" for ${year.year}.`, 409);
        throw e;
      }
      created = true;
    }

    const rows = (await client.query(
      `SELECT s.id, s.admission_no, s.full_name, s.class_id, c.name AS class_name, s.stream_id, old.name AS stream_name, s.status
       FROM students s LEFT JOIN classes c ON c.id = s.class_id LEFT JOIN streams old ON old.id = s.stream_id
       WHERE s.school_id = $1 AND lower(s.admission_no) = ANY($2::text[]) ORDER BY s.admission_no FOR UPDATE OF s`,
      [schoolId, wanted.map((w) => w.toLowerCase())])).rows;

    const problems = [];
    const found = new Set(rows.map((r) => String(r.admission_no).toLowerCase()));
    const unknown = wanted.filter((w) => !found.has(w.toLowerCase()));
    if (unknown.length) problems.push(`No student with admission number ${unknown.join(', ')} in this school.`);
    const offClass = rows.filter((r) => r.class_id !== cls.id);
    if (offClass.length) {
      problems.push(offClass.map((r) => `${r.admission_no} (${r.full_name}) is ${r.class_name ? 'in ' + r.class_name : 'in no class'}, not ${cls.name}`).join('; ') +
        '. Students only move between streams of their own class.');
    }
    const notActive = rows.filter((r) => r.class_id === cls.id && !['active', 'repeating'].includes(r.status));
    if (notActive.length) problems.push(`${notActive.map((r) => `${r.admission_no} (${r.full_name}) is ${String(r.status).replace(/_/g, ' ')}`).join('; ')}. Only students still at school can be moved.`);
    if (problems.length) throw refuse(problems.join(' ') + ' Nothing was moved.', 409);

    const alreadyThere = rows.filter((r) => r.stream_id === target.id);
    const toMove = rows.filter((r) => r.stream_id !== target.id);
    result = {
      dry, created, class: cls.name, stream: target.name, year: year.year,
      moved: toMove.map((r) => ({ admission_no: r.admission_no, full_name: r.full_name, from: r.stream_name || null })),
      alreadyThere: alreadyThere.map((r) => r.admission_no), unchanged: !toMove.length,
    };
    if (!toMove.length) return { unchanged: true };
    await client.query('UPDATE students SET stream_id = $1 WHERE id = ANY($2::int[]) AND school_id = $3', [target.id, toMove.map((r) => r.id), schoolId]);
    return {};
  });
  if (!dry && !result.unchanged) {
    await logAudit({ schoolId, staffId, action: 'students_moved', detail: { class: result.class, stream: result.stream, year: result.year, created_stream: result.created, count: result.moved.length, admission_nos: result.moved.map((m) => m.admission_no).slice(0, 200), via: 'set-classes' } });
  }
  return result;
}

/**
 * Merges one stream into another of the SAME class (this year): everyone moves, then the empty stream is removed.
 * Students who already left are re-pointed too (so the stream can go); if something still holds on to the
 * stream it simply stays, empty, and the answer says so.
 * Returns { dry, class, from, into, year, moved, pastMoved, removed, warnings }.
 */
async function mergeStreams(schoolId, { className, fromStream, intoStream, dry = false, staffId = null }, deps = {}) {
  let result;
  await inTransaction(deps, schoolId, dry, async (client) => {
    const all = await loadClasses(client, schoolId);
    const [cls] = resolveClasses(all, [className]);
    const year = await needYear(client, schoolId);
    const fromName = cleanName(fromStream), intoName = cleanName(intoStream);
    const from = await findStream(client, schoolId, cls.id, year.id, fromName);
    if (!from) throw refuse(`${cls.name} has no stream called "${fromName}" for ${year.year}.`, 404);
    const into = await findStream(client, schoolId, cls.id, year.id, intoName);
    if (!into) throw refuse(`${cls.name} has no stream called "${intoName}" for ${year.year}.`, 404);
    if (from.id === into.id) throw refuse('A stream cannot be merged into itself. Give two different streams.', 400);

    const people = (await client.query('SELECT id, status FROM students WHERE school_id = $1 AND stream_id = $2 FOR UPDATE', [schoolId, from.id])).rows;
    const moved = people.filter((p) => ['active', 'repeating'].includes(p.status)).length;
    const pastMoved = people.length - moved;
    if (people.length) await client.query('UPDATE students SET stream_id = $1 WHERE school_id = $2 AND stream_id = $3', [into.id, schoolId, from.id]);

    let removed = true;
    await client.query('SAVEPOINT remove_old_stream');
    try {
      await client.query('DELETE FROM streams WHERE id = $1', [from.id]);
      await client.query('RELEASE SAVEPOINT remove_old_stream');
    } catch (e) {
      if (e.code !== '23503') throw e;
      await client.query('ROLLBACK TO SAVEPOINT remove_old_stream');
      removed = false;
    }

    const warnings = [];
    const rule = await client.query(
      `SELECT 1 FROM promotion_mappings WHERE school_id = $1
         AND ((from_class_id = $2 AND lower(from_stream_name) = lower($3)) OR (to_class_id = $2 AND lower(to_stream_name) = lower($3))) LIMIT 1`,
      [schoolId, cls.id, from.name]);
    if (rule.rows.length) warnings.push(`A promotion rule still mentions "${from.name}". Check it before you promote.`);
    if (!removed) warnings.push(`"${from.name}" stays (now empty) because old records still point at it.`);
    result = { dry, class: cls.name, from: from.name, into: into.name, year: year.year, moved, pastMoved, removed, warnings };
    return {};
  });
  if (!dry) await logAudit({ schoolId, staffId, action: 'streams_merged', detail: { class: result.class, from: result.from, into: result.into, year: result.year, moved: result.moved, past_moved: result.pastMoved, removed: result.removed, via: 'set-classes' } });
  return result;
}

module.exports = { listSchools, findSchool, getOverview, setClasses, addStream, renameStream, removeStream, moveStudents, mergeStreams, key, describe, resolveClasses, LINE_UP_KEY };