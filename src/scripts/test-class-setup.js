// Tests the classes and streams engine (src/services/classSetup.js) without a real database.
// The pretend database can UNDO work (ROLLBACK), so "all or nothing" and --dry are really tested.
// Run:  node src/scripts/test-class-setup.js
const crypto = require('crypto');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

let failed = 0;
const check = (name, ok, extra) => { if (!ok) failed++; console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (!ok && extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); };
const rejects = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

// ---- a pretend database with transactions ----
const NAMES = ['Playgroup', 'PP1', 'PP2', 'Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6', 'Grade 7', 'Grade 8', 'Grade 9', 'Grade 10', 'Grade 11', 'Grade 12'];
const st = {};
function reset() {
  Object.assign(st, {
    schools: [{ id: 1, name: 'Mwangaza Girls High' }, { id: 2, name: 'Other School' }],
    classes: NAMES.map((name, i) => ({ id: i + 1, name, sort_order: i + 1 })),
    sc: [],            // { school_id, class_id, enabled }
    students: [],      // { school_id, class_id, stream_id, status }
    streams: [],       // { id, school_id, class_id, academic_year_id, name }
    years: [{ id: 10, year: 2026, is_current: true }],
    runs: [],          // { school_id, incoming_academic_year_id }
    rules: [],         // { school_id, from_class_id, from_stream_name, to_class_id, to_stream_name }
    pastRecords: [],   // stream ids that old records still point at (deleting them fails)
    audit: [], log: [], nextId: 100, released: 0, snap: null,
    failSecondClassWrite: false, classWrites: 0, dup23505: false, failStudentUpdate: false,
  });
}
const snapshot = () => JSON.stringify({ sc: st.sc, streams: st.streams, students: st.students, nextId: st.nextId });
const restore = (s) => { const o = JSON.parse(s); st.sc = o.sc; st.streams = o.streams; st.students = o.students; st.nextId = o.nextId; };
const cid = (name) => st.classes.find((c) => c.name === name).id;
const classRow = (school, name) => st.sc.find((x) => x.school_id === school && x.class_id === cid(name));
const isOn = (school, name) => !!(classRow(school, name) && classRow(school, name).enabled);
const onList = (school) => NAMES.filter((n) => isOn(school, n));
// which student statuses count, read from the SQL text itself (so a wrong list in the engine is noticed)
const statusesIn = (q) => { const m = /status IN \(([^)]*)\)/.exec(q); return m ? m[1].split(',').map((x) => x.trim().replace(/'/g, '')) : []; };

const query = async (sql, p = []) => {
  const q = sql.replace(/\s+/g, ' ').trim();
  if (/^SAVEPOINT|^RELEASE SAVEPOINT|^ROLLBACK TO SAVEPOINT/.test(q)) { st.log.push(q.split(' ')[0] + (/^ROLLBACK TO/.test(q) ? ' TO' : '')); return { rows: [] }; }
  if (/^BEGIN/.test(q)) { st.log.push('BEGIN'); st.snap = snapshot(); return { rows: [] }; }
  if (/^COMMIT/.test(q)) { st.log.push('COMMIT'); st.snap = null; return { rows: [] }; }
  if (/^ROLLBACK/.test(q)) { st.log.push('ROLLBACK'); if (st.snap) restore(st.snap); st.snap = null; return { rows: [] }; }
  if (/pg_advisory_xact_lock/.test(q)) { st.log.push('LOCK ' + p.join(',')); return { rows: [] }; }
  if (/^CREATE TABLE IF NOT EXISTS promotion_runs/.test(q)) return { rows: [] };
  if (/^SELECT id, name FROM schools ORDER BY id/.test(q)) return { rows: st.schools.map((s) => ({ ...s })) };
  if (/^SELECT id, name FROM schools WHERE id = \$1/.test(q)) return { rows: st.schools.filter((s) => s.id === p[0]).map((s) => ({ ...s })) };
  if (/^SELECT id, name FROM schools WHERE lower\(btrim\(name\)\) = lower\(\$1\)/.test(q)) return { rows: st.schools.filter((s) => s.name.trim().toLowerCase() === String(p[0]).toLowerCase()).map((s) => ({ ...s })) };
  if (/FROM classes c LEFT JOIN school_classes sc/.test(q)) {
    return { rows: st.classes.map((c) => {
      const row = st.sc.find((x) => x.school_id === p[0] && x.class_id === c.id);
      return { id: c.id, name: c.name, sort_order: c.sort_order, enabled: row ? row.enabled : false,
        students: st.students.filter((s) => s.school_id === p[0] && s.class_id === c.id && statusesIn(q).includes(s.status)).length };
    }) };
  }
  if (/FROM streams st WHERE st.school_id = \$1 AND st.academic_year_id = \$2/.test(q)) {
    return { rows: st.streams.filter((s) => s.school_id === p[0] && s.academic_year_id === p[1]).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
      .map((s) => ({ id: s.id, class_id: s.class_id, name: s.name, students: st.students.filter((x) => x.stream_id === s.id && statusesIn(q).includes(x.status)).length })) };
  }
  if (/FROM promotion_runs pr JOIN academic_years ay/.test(q)) {
    const mine = st.runs.filter((r) => r.school_id === p[0]).map((r) => st.years.find((y) => y.id === r.incoming_academic_year_id)).sort((a, b) => b.year - a.year);
    return { rows: mine.slice(0, 1).map((y) => ({ id: y.id, year: y.year })) };
  }
  if (/FROM academic_years ORDER BY is_current DESC, year DESC LIMIT 1/.test(q)) {
    const y = [...st.years].sort((a, b) => (b.is_current - a.is_current) || (b.year - a.year))[0];
    return { rows: y ? [{ id: y.id, year: y.year }] : [] };
  }
  if (/^INSERT INTO school_classes/.test(q)) {
    st.classWrites++;
    if (st.failSecondClassWrite && st.classWrites === 2) throw new Error('disk is full');
    const row = st.sc.find((x) => x.school_id === p[0] && x.class_id === p[1]);
    if (row) row.enabled = p[2]; else st.sc.push({ school_id: p[0], class_id: p[1], enabled: p[2] });
    return { rows: [] };
  }
  if (/FROM streams WHERE school_id = \$1 AND class_id = \$2 AND academic_year_id = \$3 AND lower\(name\) = lower\(\$4\)/.test(q)) {
    return { rows: st.streams.filter((s) => s.school_id === p[0] && s.class_id === p[1] && s.academic_year_id === p[2] && s.name.toLowerCase() === String(p[3]).toLowerCase()).map((s) => ({ id: s.id, name: s.name })) };
  }
  if (/^INSERT INTO streams/.test(q)) {
    if (st.dup23505) { const e = new Error('duplicate key'); e.code = '23505'; throw e; }
    const row = { id: st.nextId++, school_id: p[0], class_id: p[1], academic_year_id: p[2], name: p[3] }; st.streams.push(row); return { rows: [{ id: row.id }] };
  }
  if (/^UPDATE streams SET name/.test(q)) { st.streams.find((s) => s.id === p[1]).name = p[0]; return { rows: [] }; }
  if (/^DELETE FROM streams/.test(q)) {
    if (st.pastRecords.includes(p[0]) || st.students.some((x) => x.stream_id === p[0])) { const e = new Error('foreign key'); e.code = '23503'; throw e; }
    st.streams = st.streams.filter((s) => s.id !== p[0]); return { rows: [] };
  }
  if (/SELECT COUNT\(\*\)::int AS n FROM students WHERE stream_id/.test(q)) return { rows: [{ n: st.students.filter((s) => s.stream_id === p[0] && statusesIn(q).includes(s.status)).length }] };
  if (/FROM promotion_mappings WHERE school_id = \$1/.test(q)) {
    const lc = (x) => String(x || '').toLowerCase();
    return { rows: st.rules.filter((r) => r.school_id === p[0] && ((r.from_class_id === p[1] && lc(r.from_stream_name) === lc(p[2])) || (r.to_class_id === p[1] && lc(r.to_stream_name) === lc(p[2])))).map(() => ({ '?column?': 1 })) };
  }
  if (/FROM students s LEFT JOIN classes c ON c.id = s.class_id LEFT JOIN streams old/.test(q)) {
    const want = p[1];
    const scoped = /s\.school_id = \$1/.test(q);   // is the school filter really in the SQL?
    return { rows: st.students.filter((s) => (!scoped || s.school_id === p[0]) && want.includes(String(s.admission_no).toLowerCase())).sort((a, b) => String(a.admission_no).localeCompare(String(b.admission_no)))
      .map((s) => ({ id: s.id, admission_no: s.admission_no, full_name: s.full_name, class_id: s.class_id, class_name: s.class_id ? st.classes.find((c) => c.id === s.class_id).name : null,
        stream_id: s.stream_id, stream_name: s.stream_id ? (st.streams.find((x) => x.id === s.stream_id) || {}).name || null : null, status: s.status })) };
  }
  if (/^UPDATE students SET stream_id = \$1 WHERE id = ANY/.test(q)) {
    if (st.failStudentUpdate) throw new Error('disk is full');
    const scoped = /AND school_id = \$3/.test(q);
    st.students.filter((s) => p[1].includes(s.id) && (!scoped || s.school_id === p[2])).forEach((s) => { s.stream_id = p[0]; }); return { rows: [] };
  }
  if (/^SELECT id, status FROM students WHERE school_id = \$1 AND stream_id = \$2 FOR UPDATE/.test(q)) return { rows: st.students.filter((s) => (!/school_id = \$1/.test(q) || s.school_id === p[0]) && s.stream_id === p[1]).map((s) => ({ id: s.id, status: s.status })) };
  if (/^UPDATE students SET stream_id = \$1 WHERE school_id = \$2 AND stream_id = \$3/.test(q)) {
    if (st.failStudentUpdate) throw new Error('disk is full');
    st.students.filter((s) => (!/school_id = \$2/.test(q) || s.school_id === p[1]) && s.stream_id === p[2]).forEach((s) => { s.stream_id = p[0]; }); return { rows: [] };
  }
  if (/^INSERT INTO audit_log/.test(q)) { st.audit.push({ school_id: p[0], staff_id: p[1], action: p[2], detail: JSON.parse(p[3]) }); return { rows: [] }; }
  throw new Error('the pretend database does not know this query: ' + q.slice(0, 80));
};
const pool = { query, connect: async () => ({ query, release: () => { st.released++; } }) };
require.cache[require.resolve('../db/db')] = { id: require.resolve('../db/db'), filename: require.resolve('../db/db'), loaded: true, exports: { pool, initSchema: async () => {} } };
const svc = require('../services/classSetup');
const SCHOOL = 1;
const setC = (mode, names, extra = {}) => svc.setClasses(SCHOOL, { mode, names, ...extra });
const addS = (cls, name, extra = {}) => svc.addStream(SCHOOL, { className: cls, streamName: name, ...extra });
const streamsOf = (school, cls) => st.streams.filter((s) => s.school_id === school && s.class_id === cid(cls)).map((s) => s.name);
const fails = async (fn, status, re) => { const e = await rejects(fn); return !!(e && e.status === status && re.test(e.message)); };

(async () => {
  // ================= reading names =================
  check('names are read forgivingly', svc.key('Grade 7') === 'grade7' && svc.key('grade7') === 'grade7' && svc.key('  GRADE   7 ') === 'grade7' && svc.key('pp 1') === 'pp1' && svc.key('PP1') === 'pp1');
  check('Grade 1 and Grade 10 are never mixed up', svc.key('Grade 1') !== svc.key('Grade 10'));

  // ================= finding a school =================
  reset();
  check('find by number', (await svc.findSchool('1')).name === 'Mwangaza Girls High');
  check('find by exact name', (await svc.findSchool('Mwangaza Girls High')).id === 1);
  check('find by name: capitals and extra spaces ignored', (await svc.findSchool('  mwangaza   GIRLS high ')).id === 1);
  check('unknown name -> 404 with the way to see all schools', await fails(() => svc.findSchool('Nowhere'), 404, /no school named "Nowhere".*schools/));
  check('unknown number -> 404', await fails(() => svc.findSchool('99'), 404, /number 99/));
  check('nothing typed -> 400', await fails(() => svc.findSchool('   '), 400, /Say which school/));
  st.schools.push({ id: 3, name: 'other school' });
  check('two schools with the same name -> asks for the number', await fails(() => svc.findSchool('Other School'), 409, /More than one.*2, 3/));
  check('list of schools', (await svc.listSchools()).length === 3);

  // ================= switching classes: range =================
  reset();
  let r = await setC('range', ['Grade 7', 'Grade 12']);
  check('range: the two ends and everything between are switched ON', JSON.stringify(onList(1)) === JSON.stringify(['Grade 7', 'Grade 8', 'Grade 9', 'Grade 10', 'Grade 11', 'Grade 12']), onList(1));
  check('range: reports what changed, first class and last class', r.switchedOn.length === 6 && r.switchedOff.length === 0 && r.first === 'Grade 7' && r.last === 'Grade 12' && !r.unchanged);
  check('range: one transaction, lined up per school, committed, connection given back', st.log[0] === 'BEGIN' && st.log[1] === 'LOCK 7771003,1' && st.log[st.log.length - 1] === 'COMMIT' && st.released === 1, st.log);
  check('range: written to the audit log for that school, with class names only', st.audit.length === 1 && st.audit[0].action === 'classes_changed' && st.audit[0].school_id === 1 && st.audit[0].detail.switched_on.length === 6, st.audit);
  check('another school is untouched', onList(2).length === 0);
  const auditBefore = st.audit.length;
  r = await setC('range', ['grade12', 'GRADE 7']);
  check('same range again (ends in the other order, odd spelling) -> unchanged, nothing audited', r.unchanged && st.audit.length === auditBefore && st.log[st.log.length - 1] === 'ROLLBACK');
  r = await setC('range', ['Grade 8', 'Grade 10']);
  check('a new range REPLACES the old one: Grade 7, 11 and 12 go off', JSON.stringify(onList(1)) === JSON.stringify(['Grade 8', 'Grade 9', 'Grade 10']) && r.switchedOff.join() === 'Grade 7,Grade 11,Grade 12', r);
  check('a range with one end only -> 400', await fails(() => setC('range', ['Grade 7']), 400, /exactly two/));
  check('a range with three names -> 400', await fails(() => setC('range', ['Grade 7', 'Grade 8', 'Grade 9']), 400, /exactly two/));
  check('a range with the same class twice is just that one class', (await setC('range', ['Grade 9', 'Grade 9'])).enabled.join() === 'Grade 9' && onList(1).join() === 'Grade 9', onList(1));

  // ================= on / off =================
  reset();
  await setC('range', ['Grade 7', 'Grade 12']);
  r = await setC('on', ['Grade 7', 'Grade 8']);
  check('on: classes that are already on -> unchanged', r.unchanged);
  r = await setC('off', ['Grade 12']);
  check('off: switches it off, the rest stay on', JSON.stringify(onList(1)) === JSON.stringify(['Grade 7', 'Grade 8', 'Grade 9', 'Grade 10', 'Grade 11']) && r.last === 'Grade 11', onList(1));
  r = await setC('on', ['grade 12']);
  check('on: switches it back on', isOn(1, 'Grade 12') && r.switchedOn.join() === 'Grade 12');
  check('off: a class that is already off -> unchanged', (await setC('off', ['PP1'])).unchanged);

  // ================= bad names =================
  const before = JSON.stringify(st.sc);
  check('an unknown class is refused and the real names are listed', await fails(() => setC('on', ['Grade 13']), 400, /Unknown class: "Grade 13".*Playgroup, PP1, PP2, Grade 1/));
  check('one wrong word in a list refuses the WHOLE list (nothing guessed, nothing switched)', await fails(() => setC('on', ['Grade 1', 'Gade 2']), 400, /"Gade 2"/) && JSON.stringify(st.sc) === before);
  check('no class named -> 400', await fails(() => setC('on', []), 400, /Say which classes/));
  check('a wrong mode -> 400', await fails(() => setC('fly', ['Grade 1']), 400, /mode/));

  // ================= classes with students can not be switched off =================
  reset();
  await setC('range', ['Grade 7', 'Grade 12']);
  st.students.push({ school_id: 1, class_id: cid('Grade 8'), stream_id: null, status: 'active' }, { school_id: 1, class_id: cid('Grade 8'), stream_id: null, status: 'repeating' },
    { school_id: 1, class_id: cid('Grade 9'), stream_id: null, status: 'active' }, { school_id: 1, class_id: cid('Grade 10'), stream_id: null, status: 'transferred_out' },
    { school_id: 1, class_id: cid('Grade 11'), stream_id: null, status: 'graduated' }, { school_id: 2, class_id: cid('Grade 7'), stream_id: null, status: 'active' });
  check('off with students -> 409 that counts them (active + repeating)', await fails(() => setC('off', ['Grade 8']), 409, /Cannot switch off Grade 8 \(2 students\).*Move or promote/));
  check('one student is "1 student"', await fails(() => setC('off', ['Grade 9']), 409, /Grade 9 \(1 student\)\./));
  const snap = JSON.stringify(st.sc);
  check('all or nothing: Grade 10 (no one in it) is NOT switched off when Grade 8 is blocked', await fails(() => setC('off', ['Grade 10', 'Grade 8']), 409, /Grade 8/) && JSON.stringify(st.sc) === snap && isOn(1, 'Grade 10'));
  check('a range that would drop a class with students -> 409, nothing changes', await fails(() => setC('range', ['Grade 9', 'Grade 12']), 409, /Grade 8/) && JSON.stringify(st.sc) === snap);
  check('students who LEFT or GRADUATED do not block (Grade 10, Grade 11)', (await setC('off', ['Grade 10', 'Grade 11'])).switchedOff.join() === 'Grade 10,Grade 11');
  check('students of ANOTHER school do not block this school (Grade 7)', (await setC('off', ['Grade 7'])).switchedOff.join() === 'Grade 7');
  check('a blocked change is not in the audit log', st.audit.filter((a) => /Grade 8/.test(JSON.stringify(a.detail.switched_off))).length === 0);

  // ================= gaps (promotion skips a class that is off in the middle) =================
  reset();
  await setC('range', ['Grade 7', 'Grade 12']);
  r = await setC('on', ['Grade 4']);
  check('a gap is allowed but warned about, in plain words', r.warnings.length === 1 && /Grade 5, Grade 6 are switched off between Grade 4 and Grade 7.*promoted straight to Grade 7/.test(r.warnings[0]), r.warnings);
  r = await setC('on', ['Grade 6']);
  check('a gap of one class says "is"', r.warnings.length === 1 && /^Grade 5 is switched off between Grade 4 and Grade 6/.test(r.warnings[0]), r.warnings);
  r = await setC('range', ['Grade 7', 'Grade 12']);
  check('a plain range has no warnings', r.warnings.length === 0);
  check('the last class is where students graduate (reported)', r.last === 'Grade 12' && r.first === 'Grade 7');

  // ================= --dry =================
  reset();
  r = await setC('range', ['Grade 7', 'Grade 12'], { dry: true });
  check('--dry reports what it WOULD switch on', r.dry && r.switchedOn.length === 6);
  check('--dry changes NOTHING and writes no audit line', st.sc.length === 0 && st.audit.length === 0 && st.log[st.log.length - 1] === 'ROLLBACK');
  st.students.push({ school_id: 1, class_id: cid('Grade 7'), stream_id: null, status: 'active' });
  await setC('range', ['Grade 7', 'Grade 12']);
  check('--dry still refuses what a real run would refuse', await fails(() => setC('range', ['Grade 8', 'Grade 12'], { dry: true }), 409, /Grade 7/));

  // ================= all or nothing =================
  reset();
  st.failSecondClassWrite = true;
  const e = await rejects(() => setC('range', ['Grade 7', 'Grade 12']));
  check('if saving fails half-way, NO class is left switched on', e && /disk is full/.test(e.message) && st.sc.length === 0, st.sc);
  check('...nothing audited, connection still given back', st.audit.length === 0 && st.released === 1);

  // ================= no such school inside the engine =================
  reset();
  check('a school that does not exist is refused', await fails(() => svc.setClasses(99, { mode: 'on', names: ['Grade 1'] }), 404, /number 99/) && st.sc.length === 0);

  // ================= streams: adding =================
  reset();
  await setC('range', ['Grade 7', 'Grade 12']);
  r = await addS('Grade 8', 'North');
  check('add a stream: it belongs to the school, the class and the academic year', r.stream === 'North' && r.class === 'Grade 8' && r.year === 2026 && st.streams.length === 1 && st.streams[0].academic_year_id === 10 && st.streams[0].school_id === 1);
  check('add a stream: audited', st.audit[st.audit.length - 1].action === 'stream_added' && st.audit[st.audit.length - 1].detail.stream === 'North');
  check('the same name with other capitals is a duplicate, and the message shows the real name', await fails(() => addS('grade 8', '  NORTH '), 409, /already has a stream called "North" for 2026/));
  check('the same name in ANOTHER class is fine', (await addS('Grade 9', 'North')).stream === 'North');
  check('extra spaces inside a name are tidied', (await addS('Grade 8', '  Red    Door ')).stream === 'Red Door');
  check('empty name -> 400', await fails(() => addS('Grade 8', '   '), 400, /1 to 40/));
  check('41 characters -> 400', await fails(() => addS('Grade 8', 'x'.repeat(41)), 400, /1 to 40/));
  check('40 characters is fine', (await addS('Grade 8', 'y'.repeat(40))).stream.length === 40);
  check('a hidden control character -> 400', await fails(() => addS('Grade 8', 'No\u0007rth'), 400, /1 to 40/));
  check('a class that is OFF -> 409 with the way to switch it on', await fails(() => addS('Grade 3', 'North'), 409, /Grade 3 is switched off for this school\. Switch the class on first\.$/));
  check('an unknown class -> 400', await fails(() => addS('Grade 13', 'North'), 400, /Unknown class/));
  st.dup23505 = true;
  check('two people at the very same instant: the database duplicate error becomes a plain message', await fails(() => addS('Grade 8', 'Blue'), 409, /already has a stream called "Blue"/));
  st.dup23505 = false;
  const streamCount = st.streams.length;
  r = await addS('Grade 8', 'Green', { dry: true });
  check('--dry adds nothing', r.dry && st.streams.length === streamCount && st.log[st.log.length - 1] === 'ROLLBACK');

  // the academic year
  check('a school that promoted uses its NEW year', await (async () => {
    st.years.push({ id: 11, year: 2027, is_current: false }); st.runs.push({ school_id: 1, incoming_academic_year_id: 11 });
    const x = await addS('Grade 8', 'Fresh'); const row = st.streams.find((s) => s.name === 'Fresh');
    st.runs = []; st.years = st.years.filter((y) => y.id !== 11); st.streams = st.streams.filter((s) => s.name !== 'Fresh');
    return x.year === 2027 && row.academic_year_id === 11;
  })());
  st.years = [];
  check('no academic year yet -> 409 that tells you to set the terms first', await fails(() => addS('Grade 8', 'Late'), 409, /set the terms first \(Academic years & terms\)/i));
  st.years = [{ id: 10, year: 2026, is_current: true }];

  // ================= streams: renaming =================
  reset();
  await setC('range', ['Grade 7', 'Grade 12']);
  await addS('Grade 9', 'Red'); await addS('Grade 9', 'Yellow');
  r = await svc.renameStream(1, { className: 'Grade 9', oldName: 'red', newName: 'Blue' });
  check('rename: works (the old name is found whatever its capitals)', !r.unchanged && r.from === 'Red' && r.stream === 'Blue' && streamsOf(1, 'Grade 9').includes('Blue'));
  check('rename: audited with the old and the new name', st.audit[st.audit.length - 1].action === 'stream_renamed' && st.audit[st.audit.length - 1].detail.from === 'Red' && st.audit[st.audit.length - 1].detail.to === 'Blue');
  const aud = st.audit.length;
  check('rename to the same name -> unchanged and not audited', (await svc.renameStream(1, { className: 'Grade 9', oldName: 'Blue', newName: 'Blue' })).unchanged && st.audit.length === aud);
  check('rename to a name that only differs by capitals is allowed (fixing a typo)', (await svc.renameStream(1, { className: 'Grade 9', oldName: 'Blue', newName: 'BLUE' })).stream === 'BLUE');
  check('rename onto another existing stream -> 409', await fails(() => svc.renameStream(1, { className: 'Grade 9', oldName: 'Yellow', newName: 'blue' }), 409, /already has a stream called "BLUE"/));
  check('rename a stream that does not exist -> 404', await fails(() => svc.renameStream(1, { className: 'Grade 9', oldName: 'Green', newName: 'Pink' }), 404, /no stream called "Green"/));
  st.rules.push({ school_id: 1, from_class_id: cid('Grade 9'), from_stream_name: 'Yellow', to_class_id: cid('Grade 10'), to_stream_name: 'Gold' });
  check('rename is refused when a promotion rule uses the name (from side)', await fails(() => svc.renameStream(1, { className: 'Grade 9', oldName: 'Yellow', newName: 'Lemon' }), 409, /promotion rule uses the stream name "Yellow"/));
  await addS('Grade 10', 'Gold');
  check('rename is refused when a promotion rule uses the name (to side)', await fails(() => svc.renameStream(1, { className: 'Grade 10', oldName: 'Gold', newName: 'Silver' }), 409, /promotion rule uses the stream name "Gold"/));
  check('a rule of ANOTHER school does not block', await (async () => { st.rules = [{ school_id: 2, from_class_id: cid('Grade 9'), from_stream_name: 'Yellow', to_class_id: null, to_stream_name: null }]; return (await svc.renameStream(1, { className: 'Grade 9', oldName: 'Yellow', newName: 'Lemon' })).stream === 'Lemon'; })());
  const names = streamsOf(1, 'Grade 9').join();
  await svc.renameStream(1, { className: 'Grade 9', oldName: 'Lemon', newName: 'Sun', dry: true });
  check('--dry rename changes nothing', streamsOf(1, 'Grade 9').join() === names);

  // ================= streams: removing =================
  reset();
  await setC('range', ['Grade 7', 'Grade 12']);
  await addS('Grade 8', 'North'); await addS('Grade 8', 'South');
  const north = st.streams.find((s) => s.name === 'North').id;
  st.students.push({ school_id: 1, class_id: cid('Grade 8'), stream_id: north, status: 'active' }, { school_id: 1, class_id: cid('Grade 8'), stream_id: north, status: 'repeating' });
  check('remove a stream that has students -> 409 that counts them', await fails(() => svc.removeStream(1, { className: 'Grade 8', streamName: 'north' }), 409, /Cannot remove Grade 8 North: 2 students are still in it/));
  check('...and it is still there', streamsOf(1, 'Grade 8').includes('North'));
  r = await svc.removeStream(1, { className: 'Grade 8', streamName: 'South', dry: true });
  check('--dry remove changes nothing', r.dry && streamsOf(1, 'Grade 8').includes('South'));
  r = await svc.removeStream(1, { className: 'Grade 8', streamName: 'south' });
  check('remove an empty stream', !streamsOf(1, 'Grade 8').includes('South') && st.audit[st.audit.length - 1].action === 'stream_removed');
  check('remove a stream that does not exist -> 404', await fails(() => svc.removeStream(1, { className: 'Grade 8', streamName: 'South' }), 404, /no stream called "South"/));
  st.students.forEach((s) => { s.status = 'graduated'; });
  check('a stream that students who LEFT still point at stays, with a plain reason', await fails(() => svc.removeStream(1, { className: 'Grade 8', streamName: 'North' }), 409, /part of past records/) && streamsOf(1, 'Grade 8').includes('North'));
  st.students = [];
  check('with no student pointing at it any more, it can go', (await svc.removeStream(1, { className: 'Grade 8', streamName: 'North' })).stream === 'North' && !streamsOf(1, 'Grade 8').includes('North'));

  // ================= moving students between streams of their own class =================
  const mkStudents = () => {
    reset();
    return (async () => {
      await setC('range', ['Grade 7', 'Grade 12']);
      for (const n of ['North', 'South', 'East']) await addS('Grade 7', n);
      await addS('Grade 8', 'White');
      const sid = (cls, n) => st.streams.find((s) => s.class_id === cid(cls) && s.name === n).id;
      st.students = [
        { id: 1, school_id: 1, admission_no: 'ADM1', full_name: 'Amina A', class_id: cid('Grade 7'), stream_id: sid('Grade 7', 'North'), status: 'active' },
        { id: 2, school_id: 1, admission_no: 'ADM2', full_name: 'Brian B', class_id: cid('Grade 7'), stream_id: sid('Grade 7', 'North'), status: 'repeating' },
        { id: 3, school_id: 1, admission_no: 'ADM3', full_name: 'Cate C', class_id: cid('Grade 7'), stream_id: sid('Grade 7', 'East'), status: 'active' },
        { id: 4, school_id: 1, admission_no: 'ADM4', full_name: 'Dan D', class_id: cid('Grade 7'), stream_id: sid('Grade 7', 'East'), status: 'active' },
        { id: 5, school_id: 1, admission_no: 'ADM5', full_name: 'Eve E', class_id: cid('Grade 7'), stream_id: sid('Grade 7', 'East'), status: 'transferred_out' },
        { id: 6, school_id: 1, admission_no: 'ADM6', full_name: 'Faith F', class_id: cid('Grade 7'), stream_id: null, status: 'active' },
        { id: 7, school_id: 1, admission_no: 'ADM7', full_name: 'Gina G', class_id: cid('Grade 8'), stream_id: sid('Grade 8', 'White'), status: 'active' },
        { id: 8, school_id: 1, admission_no: 'ADM8', full_name: 'Hana H', class_id: null, stream_id: null, status: 'active' },
        { id: 9, school_id: 2, admission_no: 'X9', full_name: 'Other School Kid', class_id: cid('Grade 7'), stream_id: null, status: 'active' },
      ];
      return sid;
    })();
  };
  const mv = (cls, to, nos, extra = {}) => svc.moveStudents(1, { className: cls, toStream: to, admissionNos: nos, ...extra });
  const where = (id) => { const s = st.students.find((x) => x.id === id); const t = s.stream_id && st.streams.find((x) => x.id === s.stream_id); return t ? t.name : null; };

  let sid = await mkStudents();
  const auditN = st.audit.length;
  r = await mv('Grade 7', 'South', ['adm1', ' ADM2 ']);
  check('move: students are named by admission number (capitals and spaces ignored), both end up in South', where(1) === 'South' && where(2) === 'South', st.students.map((s) => s.stream_id));
  check('move: the answer says where each one came from (a "repeating" student can be moved too)', r.moved.length === 2 && r.moved[0].from === 'North' && r.moved[1].admission_no === 'ADM2' && r.class === 'Grade 7' && r.stream === 'South' && !r.created);
  check('move: one transaction, lined up per school, committed', st.log.includes('LOCK 7771003,1') && st.log[st.log.length - 1] === 'COMMIT');
  check('move: audited with the count and admission numbers, never names', st.audit.length === auditN + 1 && st.audit[st.audit.length - 1].action === 'students_moved' && st.audit[st.audit.length - 1].detail.count === 2 && !/Amina|Brian/.test(JSON.stringify(st.audit[st.audit.length - 1])));
  const a2 = st.audit.length;
  r = await mv('Grade 7', 'South', ['ADM1']);
  check('move: a student already there -> "unchanged", nothing audited', r.unchanged && r.alreadyThere.join() === 'ADM1' && st.audit.length === a2);
  r = await mv('Grade 7', 'North', ['ADM1', 'ADM6']);
  check('move: one student moves and a student with NO stream gets one', where(1) === 'North' && where(6) === 'North' && r.moved.find((m) => m.admission_no === 'ADM6').from === null);
  r = await mv('Grade 7', 'North', ['ADM1', 'ADM3']);
  check('move: those already there are skipped, the rest move', r.alreadyThere.join() === 'ADM1' && r.moved.length === 1 && where(3) === 'North');
  check('move: the same number twice counts once', (await mv('Grade 7', 'South', ['ADM4', 'adm4', 'ADM4'])).moved.length === 1 && where(4) === 'South');

  // refusals: one bad student refuses the whole list, nothing moves
  sid = await mkStudents();
  const was = JSON.stringify(st.students);
  check('refused: a student of ANOTHER class (named, with the reason), and the good ones do not move either', await fails(() => mv('Grade 7', 'South', ['ADM1', 'ADM7']), 409, /ADM7 \(Gina G\) is in Grade 8, not Grade 7\. Students only move between streams of their own class\. Nothing was moved/) && JSON.stringify(st.students) === was);
  check('refused: a student who has no class at all', await fails(() => mv('Grade 7', 'South', ['ADM8']), 409, /ADM8 \(Hana H\) is in no class/));
  check('refused: a student who already left', await fails(() => mv('Grade 7', 'South', ['ADM5']), 409, /ADM5 \(Eve E\) is transferred out\. Only students still at school/));
  check('refused: an unknown admission number', await fails(() => mv('Grade 7', 'South', ['ADM1', 'ADM99', 'ZZ']), 409, /No student with admission number ADM99, ZZ in this school/) && JSON.stringify(st.students) === was);
  check('refused: a student of ANOTHER SCHOOL is not found (even with a real admission number)', await fails(() => mv('Grade 7', 'South', ['X9']), 409, /No student with admission number X9/));
  check('refused: several problems are all reported together', await fails(() => mv('Grade 7', 'South', ['ADM7', 'ADM5', 'ADM99']), 409, /ADM99.*ADM7.*ADM5/));
  check('refused moves are not audited and are rolled back', st.audit.filter((x) => x.action === 'students_moved').length === 0 && st.log[st.log.length - 1] === 'ROLLBACK');

  // the stream
  check('stream missing -> 404 that offers --create', await fails(() => mv('Grade 7', 'Gold', ['ADM3']), 404, /no stream called "Gold".*--create/));
  check('a stream of ANOTHER class is not accepted (White is Grade 8)', await fails(() => mv('Grade 7', 'White', ['ADM3']), 404, /Grade 7 has no stream called "White"/));
  check('class switched off -> 409', await fails(() => mv('Grade 3', 'South', ['ADM1']), 409, /Grade 3 is switched off/));
  check('unknown class -> 400', await fails(() => mv('Grade 13', 'South', ['ADM1']), 400, /Unknown class/));
  check('no admission numbers -> 400', await fails(() => mv('Grade 7', 'South', []), 400, /Say which students/));
  check('no stream named -> 400', await fails(() => mv('Grade 7', '  ', ['ADM1']), 400, /Say which stream/));
  check('too many at once -> 400', await fails(() => mv('Grade 7', 'South', Array.from({ length: 501 }, (_, i) => 'N' + i)), 400, /at most 500/));

  // --create (a new stream in the middle of the term)
  r = await mv('Grade 7', 'Gold', ['ADM3', 'ADM4'], { create: true });
  check('--create: the stream is made and the students move into it, in one step', r.created && where(3) === 'Gold' && where(4) === 'Gold' && streamsOf(1, 'Grade 7').includes('Gold'));
  check('--create: audited as a new stream too', st.audit[st.audit.length - 1].detail.created_stream === true);
  r = await mv('Grade 7', 'gold', ['ADM6'], { create: true });
  check('--create with a name that exists (other capitals) uses the existing stream, makes nothing new', !r.created && r.stream === 'Gold' && streamsOf(1, 'Grade 7').filter((n) => /gold/i.test(n)).length === 1 && where(6) === 'Gold');
  check('--create with a bad name -> 400', await fails(() => mv('Grade 7', 'x'.repeat(41), ['ADM1'], { create: true }), 400, /1 to 40/));
  st.dup23505 = true;
  check('--create: two people at the same instant -> plain message', await fails(() => mv('Grade 7', 'Silver', ['ADM1'], { create: true }), 409, /already has a stream called "Silver"/));
  st.dup23505 = false;

  // --dry and all or nothing
  sid = await mkStudents();
  const s0 = JSON.stringify(st.students), n0 = st.streams.length;
  r = await mv('Grade 7', 'Gold', ['ADM3'], { create: true, dry: true });
  check('--dry reports it would make the stream and move the student', r.dry && r.created && r.moved.length === 1);
  check('--dry changes NOTHING (no student moved, the new stream is undone)', JSON.stringify(st.students) === s0 && st.streams.length === n0 && st.log[st.log.length - 1] === 'ROLLBACK');
  st.failStudentUpdate = true;
  const e2 = await rejects(() => mv('Grade 7', 'Gold', ['ADM3'], { create: true }));
  check('if saving fails half-way, the new stream is NOT left behind and no student moved', e2 && /disk is full/.test(e2.message) && st.streams.length === n0 && JSON.stringify(st.students) === s0);
  st.failStudentUpdate = false;
  st.years = [];
  check('no academic year yet -> 409', await fails(() => mv('Grade 7', 'South', ['ADM1']), 409, /set the terms first \(Academic years & terms\)/i));
  st.years = [{ id: 10, year: 2026, is_current: true }];

  // ================= merging two streams of one class =================
  sid = await mkStudents();
  const mg = (cls, from, into, extra = {}) => svc.mergeStreams(1, { className: cls, fromStream: from, intoStream: into, ...extra });
  r = await mg('Grade 7', 'East', 'south');
  check('merge: everyone in East moves to South, and the empty East is removed', where(3) === 'South' && where(4) === 'South' && !streamsOf(1, 'Grade 7').includes('East') && r.removed && r.moved === 2, r);
  check('merge: students who already LEFT are re-pointed too, and counted separately (so the stream can go)', r.pastMoved === 1 && where(5) === 'South');
  check('merge: other streams and other classes are untouched', where(1) === 'North' && where(7) === 'White' && streamsOf(1, 'Grade 8').includes('White') && streamsOf(1, 'Grade 7').includes('North'));
  check('merge: audited', st.audit[st.audit.length - 1].action === 'streams_merged' && st.audit[st.audit.length - 1].detail.from === 'East' && st.audit[st.audit.length - 1].detail.moved === 2 && st.audit[st.audit.length - 1].detail.removed === true);
  check('merge into itself (other capitals) -> 400', await fails(() => mg('Grade 7', 'north', 'NORTH'), 400, /itself/));
  check('merge: from-stream missing -> 404', await fails(() => mg('Grade 7', 'East', 'North'), 404, /no stream called "East"/));
  check('merge: into-stream missing -> 404', await fails(() => mg('Grade 7', 'North', 'Nowhere'), 404, /no stream called "Nowhere"/));
  check('merge: streams of ANOTHER class are not accepted', await fails(() => mg('Grade 7', 'North', 'White'), 404, /Grade 7 has no stream called "White"/));
  sid = await mkStudents();
  const s1 = JSON.stringify(st.students), n1 = st.streams.length;
  r = await mg('Grade 7', 'East', 'South', { dry: true });
  check('merge --dry reports it and changes NOTHING', r.dry && r.moved === 2 && JSON.stringify(st.students) === s1 && st.streams.length === n1 && st.log[st.log.length - 1] === 'ROLLBACK');
  st.failStudentUpdate = true;
  const e3 = await rejects(() => mg('Grade 7', 'East', 'South'));
  check('merge: if saving fails half-way, nobody is left moved', e3 && /disk is full/.test(e3.message) && JSON.stringify(st.students) === s1 && st.streams.length === n1);
  st.failStudentUpdate = false;
  sid = await mkStudents();
  st.pastRecords.push(st.streams.find((s) => s.name === 'East').id);
  r = await mg('Grade 7', 'East', 'South');
  check('merge: if old records still hold the stream, it STAYS (empty), the students still move, and it says so', !r.removed && where(3) === 'South' && streamsOf(1, 'Grade 7').includes('East') && r.warnings.some((w) => /stays/.test(w)) && st.log.includes('ROLLBACK TO'), r);
  st.pastRecords = [];
  sid = await mkStudents();
  st.rules.push({ school_id: 1, from_class_id: cid('Grade 7'), from_stream_name: 'East', to_class_id: cid('Grade 8'), to_stream_name: 'East' });
  r = await mg('Grade 7', 'East', 'South');
  check('merge: warns when a promotion rule still mentions the removed stream', r.warnings.some((w) => /promotion rule still mentions "East"/.test(w)));
  sid = await mkStudents();
  st.students = [];
  r = await mg('Grade 7', 'East', 'South');
  check('merge: an empty stream is just removed', r.moved === 0 && r.removed && !streamsOf(1, 'Grade 7').includes('East'));

  // ================= "exactly these classes" (what the Choose classes sheet saves) and who did it =================
  reset();
  r = await setC('exactly', ['Grade 7', 'grade 9', 'Grade 10'], { staffId: 42 });
  check('exactly: the school runs exactly these classes, nothing else', JSON.stringify(onList(1)) === JSON.stringify(['Grade 7', 'Grade 9', 'Grade 10']) && r.switchedOn.length === 3, onList(1));
  check('exactly: a gap (Grade 8 off between 7 and 9) is warned about', r.warnings.length === 1 && /Grade 8 is switched off between Grade 7 and Grade 9/.test(r.warnings[0]), r.warnings);
  check('exactly: the audit line says WHO did it (the staff member)', st.audit[st.audit.length - 1].staff_id === 42 && st.audit[st.audit.length - 1].action === 'classes_changed');
  r = await setC('exactly', ['Grade 10', 'Grade 7', 'Grade 9']);
  check('exactly: the same classes again (any order) -> unchanged', r.unchanged);
  r = await setC('exactly', ['Grade 7']);
  check('exactly: classes not in the list are switched off', JSON.stringify(onList(1)) === JSON.stringify(['Grade 7']) && r.switchedOff.join() === 'Grade 9,Grade 10');
  st.students.push({ id: 1, school_id: 1, class_id: cid('Grade 7'), stream_id: null, status: 'active' });
  const keep = JSON.stringify(st.sc);
  check('exactly: a class with students can not be left out', await fails(() => setC('exactly', ['Grade 9']), 409, /Cannot switch off Grade 7 \(1 student\)/) && JSON.stringify(st.sc) === keep);
  check('exactly: an empty list is allowed when nobody is in a class, and it clears everything', await (async () => { st.students = []; const x = await setC('exactly', []); return onList(1).length === 0 && x.switchedOff.join() === 'Grade 7' && x.first === null; })());
  check('exactly: an unknown class refuses the whole list', await fails(() => setC('exactly', ['Grade 7', 'Grade 99']), 400, /Unknown class: "Grade 99"/) && onList(1).length === 0);
  reset();
  await setC('range', ['Grade 7', 'Grade 9']);
  await addS('Grade 7', 'North', { staffId: 5 });
  check('add stream: audit has the staff id', st.audit[st.audit.length - 1].staff_id === 5);
  await svc.renameStream(1, { className: 'Grade 7', oldName: 'North', newName: 'Blue', staffId: 6 });
  check('rename: audit has the staff id', st.audit[st.audit.length - 1].staff_id === 6);
  await addS('Grade 7', 'Red');
  st.students.push({ id: 1, school_id: 1, admission_no: 'A1', full_name: 'A', class_id: cid('Grade 7'), stream_id: st.streams.find((x) => x.name === 'Red').id, status: 'active' });
  await svc.moveStudents(1, { className: 'Grade 7', toStream: 'Blue', admissionNos: ['A1'], staffId: 7 });
  check('move: audit has the staff id', st.audit[st.audit.length - 1].staff_id === 7);
  await svc.mergeStreams(1, { className: 'Grade 7', fromStream: 'Red', intoStream: 'Blue', staffId: 8 });
  check('merge: audit has the staff id', st.audit[st.audit.length - 1].staff_id === 8);
  await svc.removeStream(1, { className: 'Grade 7', streamName: 'Blue' }).catch(() => {});
  st.students = [];
  await svc.removeStream(1, { className: 'Grade 7', streamName: 'Blue', staffId: 9 });
  check('remove: audit has the staff id', st.audit[st.audit.length - 1].staff_id === 9);
  check('without a staff id (the terminal) the audit line has none', await (async () => { await addS('Grade 7', 'Plain'); return st.audit[st.audit.length - 1].staff_id === null; })());

  // ================= the overview (show) =================
  reset();
  await setC('range', ['Grade 7', 'Grade 12']);
  await addS('Grade 8', 'South'); await addS('Grade 8', 'North');
  st.students.push({ school_id: 1, class_id: cid('Grade 8'), stream_id: st.streams.find((s) => s.name === 'North').id, status: 'active' });
  let o = await svc.getOverview(1);
  const g8 = o.classes.find((c) => c.name === 'Grade 8');
  check('overview: all 15 classes in order, 6 on', o.classes.length === 15 && o.classes[0].name === 'Playgroup' && o.classes.filter((c) => c.enabled).length === 6);
  check('overview: student count and streams (sorted by name) with their counts', g8.students === 1 && g8.streams.map((s) => s.name + ':' + s.students).join() === 'North:1,South:0', g8.streams);
  check('overview: first, last, the year, the school', o.first === 'Grade 7' && o.last === 'Grade 12' && o.year.year === 2026 && o.school.name === 'Mwangaza Girls High');
  check('overview: another school sees none of it', (await svc.getOverview(2)).classes.every((c) => !c.enabled && c.streams.length === 0));
  st.years = [];
  o = await svc.getOverview(1);
  check('overview: no academic year yet -> year is null and nothing breaks', o.year === null && o.classes.length === 15);
  check('overview: unknown school -> 404', await fails(() => svc.getOverview(99), 404, /number 99/));

  // ================= describe (first, last, gaps) =================
  const cl = (spec) => spec.map(([n, e], i) => ({ name: n, sort_order: i + 1, enabled: e }));
  const d1 = svc.describe(cl([['A', false], ['B', true], ['C', true], ['D', false]]));
  check('describe: first and last are the first and last that are ON', d1.first.name === 'B' && d1.last.name === 'C' && d1.warnings.length === 0);
  const d2 = svc.describe(cl([['A', true], ['B', false], ['C', true], ['D', false], ['E', false], ['F', true]]));
  check('describe: two separate gaps give two warnings', d2.warnings.length === 2 && /B is switched off between A and C/.test(d2.warnings[0]) && /D, E are switched off between C and F/.test(d2.warnings[1]), d2.warnings);
  const d3 = svc.describe(cl([['A', false], ['B', false]]));
  check('describe: nothing on -> no first, no last, no warnings', d3.first === null && d3.last === null && d3.warnings.length === 0);

  console.log(failed ? `\n${failed} check(s) FAILED.` : '\nAll class setup checks pass.');
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });