// Tests promotion (src/services/promotion.js) without a real database.
// The pretend database can UNDO work (ROLLBACK), so "all or nothing" is really tested.
// Run:  node src/scripts/test-promotion.js
const crypto = require('crypto');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

let failed = 0;
const check = (name, ok, extra) => { if (!ok) failed++; console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (!ok && extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); };
const rejects = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const fails = async (fn, status, re) => { const e = await rejects(fn); return !!(e && e.status === status && re.test(e.message)); };

// ---- a pretend database with transactions ----
const NAMES = ['Playgroup', 'PP1', 'PP2', 'Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6', 'Grade 7', 'Grade 8', 'Grade 9', 'Grade 10', 'Grade 11', 'Grade 12'];
const st = {};
function world(enabled = ['Grade 6', 'Grade 7', 'Grade 8', 'Grade 9']) {
  Object.assign(st, {
    today: '2026-11-01',
    classes: NAMES.map((name, i) => ({ id: i + 1, name, sort_order: i + 1 })),
    enabled: { 1: enabled },
    years: [{ id: 10, year: 2026 }, { id: 11, year: 2027 }],
    terms: [
      { id: 1, academic_year_id: 10, term_number: 1, start_day: '2026-01-05', end_day: '2026-04-10' },
      { id: 2, academic_year_id: 10, term_number: 2, start_day: '2026-05-04', end_day: '2026-08-07' },
      { id: 3, academic_year_id: 10, term_number: 3, start_day: '2026-08-31', end_day: '2026-10-23' },
      { id: 4, academic_year_id: 11, term_number: 1, start_day: '2027-01-04', end_day: '2027-04-09' },
      { id: 5, academic_year_id: 11, term_number: 2, start_day: null, end_day: null },
      { id: 6, academic_year_id: 11, term_number: 3, start_day: null, end_day: null },
    ],
    charged: [], streams: [], students: [], rules: [], runs: [], history: [], audit: [], log: [],
    nextId: 1000, released: 0, snap: null, failOnUpdateNumber: 0, classUpdates: 0,
  });
}
const snapshot = () => JSON.stringify({ streams: st.streams, students: st.students, runs: st.runs, history: st.history, nextId: st.nextId });
const restore = (s) => { const o = JSON.parse(s); st.streams = o.streams; st.students = o.students; st.runs = o.runs; st.history = o.history; st.nextId = o.nextId; };
const cid = (name) => st.classes.find((c) => c.name === name).id;
const cname = (id) => st.classes.find((c) => c.id === id).name;

const query = async (sql, p = []) => {
  const q = sql.replace(/\s+/g, ' ').trim();
  if (/^BEGIN/.test(q)) { st.log.push('BEGIN'); st.snap = snapshot(); return { rows: [] }; }
  if (/^COMMIT/.test(q)) { st.log.push('COMMIT'); st.snap = null; return { rows: [] }; }
  if (/^ROLLBACK/.test(q)) { st.log.push('ROLLBACK'); if (st.snap) restore(st.snap); st.snap = null; return { rows: [] }; }
  if (/^SELECT pg_advisory_xact_lock/.test(q)) { st.log.push('LOCK ' + p.join(',')); return { rows: [] }; }
  if (/^CREATE TABLE IF NOT EXISTS promotion_runs/.test(q)) return { rows: [] };
  if (/^SELECT id, year FROM academic_years WHERE id = ANY/.test(q)) return { rows: st.years.filter((y) => p[0].includes(y.id)).map((y) => ({ ...y })) };
  if (/to_char\(CURRENT_DATE/.test(q)) return { rows: [{ today: st.today }] };
  if (/FROM terms t LEFT JOIN school_term_dates/.test(q)) {
    return { rows: st.terms.filter((t) => p[0].includes(t.academic_year_id)).map((t) => ({ ...t, charged: st.charged.includes(t.id) })) };
  }
  if (/FROM students WHERE school_id = \$1 AND class_id IS NULL AND status = 'active'/.test(q)) {
    return { rows: st.students.filter((s) => s.school_id === p[0] && !s.class_id && s.status === 'active').map((s) => ({ admission_no: s.admission_no })).sort((a, b) => a.admission_no.localeCompare(b.admission_no)) };
  }
  if (/FROM students s JOIN classes c ON c\.id = s\.class_id LEFT JOIN streams st ON st\.id = s\.stream_id/.test(q)) {
    const rows = st.students.filter((s) => s.school_id === p[0] && s.class_id && s.status === 'active').map((s) => ({
      id: s.id, admission_no: s.admission_no, full_name: s.full_name, class_id: s.class_id, class_name: cname(s.class_id), stream_id: s.stream_id,
      stream_name: s.stream_id ? st.streams.find((x) => x.id === s.stream_id).name : null }));
    rows.sort((a, b) => (st.classes.find((c) => c.id === a.class_id).sort_order - st.classes.find((c) => c.id === b.class_id).sort_order)
      || ((a.stream_name === null ? -1 : 0) - (b.stream_name === null ? -1 : 0)) || String(a.stream_name || '').localeCompare(String(b.stream_name || ''))
      || a.full_name.localeCompare(b.full_name) || a.id - b.id);
    return { rows };
  }
  if (/^SELECT id, name FROM classes$/.test(q)) return { rows: st.classes.map((c) => ({ id: c.id, name: c.name })) };
  if (/^SELECT \* FROM promotion_mappings WHERE school_id = \$1/.test(q)) return { rows: st.rules.filter((r) => r.school_id === p[0]) };
  if (/^SELECT c2\.\* FROM classes c1 JOIN classes c2 ON c2\.sort_order >/.test(q)) {
    const c1 = st.classes.find((c) => c.id === p[0]);
    const on = (st.enabled[p[1]] || []).map((n) => st.classes.find((c) => c.name === n));
    return { rows: on.filter((c) => c.sort_order > c1.sort_order).sort((a, b) => a.sort_order - b.sort_order).slice(0, 1) };
  }
  if (/^SELECT id, admission_no, full_name, class_id, status FROM students WHERE school_id = \$1 AND lower\(admission_no\)/.test(q)) {
    return { rows: st.students.filter((s) => s.school_id === p[0] && p[1].includes(s.admission_no.toLowerCase())).map((s) => ({ id: s.id, admission_no: s.admission_no, full_name: s.full_name, class_id: s.class_id, status: s.status })) };
  }
  if (/^INSERT INTO promotion_runs/.test(q)) {
    if (st.runs.some((r) => r.school_id === p[0] && r.outgoing === p[1])) return { rows: [] };
    const row = { id: st.nextId++, school_id: p[0], outgoing: p[1], incoming: p[2], staff_id: p[3], summary: null, ran_at: '2026-11-01T08:00:00Z' };
    st.runs.push(row); return { rows: [{ id: row.id }] };
  }
  if (/^SELECT \* FROM promotion_runs WHERE school_id = \$1 AND outgoing_academic_year_id = \$2/.test(q)) {
    const r = st.runs.find((x) => x.school_id === p[0] && x.outgoing === p[1]); return { rows: r ? [{ ...r }] : [] };
  }
  if (/^INSERT INTO student_class_history/.test(q)) {
    st.students.filter((s) => s.school_id === p[1] && s.class_id).forEach((s) => {
      if (!st.history.some((h) => h.student_id === s.id && h.year_id === p[0])) st.history.push({ student_id: s.id, year_id: p[0], class_id: s.class_id, stream_id: s.stream_id });
    });
    return { rows: [] };
  }
  if (/^UPDATE students SET status = 'transferred_out' WHERE id = \$1/.test(q)) { const s = st.students.find((x) => x.id === p[0]); s.status = 'transferred_out'; return { rows: [{ id: s.id, status: s.status }] }; }
  if (/^UPDATE students SET status = 'graduated' WHERE id = \$1/.test(q)) { st.students.find((x) => x.id === p[0]).status = 'graduated'; return { rows: [] }; }
  if (/^SELECT id FROM streams WHERE school_id = \$1 AND class_id = \$2 AND academic_year_id = \$3 AND name = \$4/.test(q)) {
    const r = st.streams.find((s) => s.school_id === p[0] && s.class_id === p[1] && s.academic_year_id === p[2] && s.name === p[3]); return { rows: r ? [{ id: r.id }] : [] };
  }
  if (/^INSERT INTO streams/.test(q)) { const row = { id: st.nextId++, school_id: p[0], class_id: p[1], academic_year_id: p[2], name: p[3] }; st.streams.push(row); return { rows: [{ id: row.id }] }; }
  if (/^UPDATE students SET class_id = \$1, stream_id = \$2 WHERE id = \$3/.test(q)) {
    st.classUpdates++;
    if (st.failOnUpdateNumber && st.classUpdates === st.failOnUpdateNumber) throw new Error('disk is full');
    const s = st.students.find((x) => x.id === p[2]); s.class_id = p[0]; s.stream_id = p[1]; return { rows: [] };
  }
  if (/^UPDATE promotion_runs SET summary/.test(q)) { st.runs.find((r) => r.id === p[0]).summary = JSON.parse(p[1]); return { rows: [] }; }
  if (/^INSERT INTO audit_log/.test(q)) { st.audit.push({ school_id: p[0], staff_id: p[1], action: p[2], detail: JSON.parse(p[3]) }); return { rows: [] }; }
  throw new Error('the pretend database does not know this query: ' + q.slice(0, 90));
};
const pool = { query, connect: async () => ({ query, release: () => { st.released++; } }) };
require.cache[require.resolve('../db/db')] = { id: require.resolve('../db/db'), filename: require.resolve('../db/db'), loaded: true, exports: { pool, initSchema: async () => {} } };
const promo = require('../services/promotion');
const classSetup = require('../services/classSetup');

let nextStu = 1;
function stu(adm, name, cls, streamName = null, status = 'active') {
  let streamId = null;
  if (streamName) {
    let s = st.streams.find((x) => x.school_id === 1 && x.class_id === cid(cls) && x.academic_year_id === 10 && x.name === streamName);
    if (!s) { s = { id: st.nextId++, school_id: 1, class_id: cid(cls), academic_year_id: 10, name: streamName }; st.streams.push(s); }
    streamId = s.id;
  }
  const row = { id: nextStu++, school_id: 1, admission_no: adm, full_name: name, class_id: cls ? cid(cls) : null, stream_id: streamId, status };
  st.students.push(row); return row;
}
const sid = (adm) => st.students.find((s) => s.admission_no === adm).id;
const plan = (decisions = {}) => promo.planPromotion({ schoolId: 1, outgoingAcademicYearId: 10, decisions, db: pool });
const to = (pl, adm) => { const p = pl.find((x) => x.admission_no === adm); return p.action === 'graduate' ? 'graduate' : p.action === 'leave' ? 'leave' : `${p.dest_class_name}/${p.dest_stream_name}`; };
const place = (pl, adm) => pl.find((x) => x.admission_no === adm).placement;

// the example from the conversation
function theExample() {
  world();
  stu('G6B1', 'Bella', 'Grade 6', 'Brown'); stu('G6B2', 'Bob', 'Grade 6', 'Brown'); stu('G6B3', 'Bea', 'Grade 6', 'Brown');
  stu('G6P1', 'Pam', 'Grade 6', 'Pink'); stu('G6P2', 'Paul', 'Grade 6', 'Pink');
  stu('G7N1', 'Peter', 'Grade 7', 'North'); stu('G7N2', 'Nora', 'Grade 7', 'North'); stu('G7N3', 'Neil', 'Grade 7', 'North');
  stu('G7S1', 'Sam', 'Grade 7', 'South'); stu('G7E1', 'Eli', 'Grade 7', 'East');
  stu('G8W1', 'Wale', 'Grade 8', 'White'); stu('G8W2', 'Wanjiku', 'Grade 8', 'White'); stu('G8Y1', 'Yusuf', 'Grade 8', 'Yellow');
  stu('G9A1', 'Zed', 'Grade 9'); stu('G9A2', 'Zoe', 'Grade 9');
}

(async () => {
  check('the promotion lock is the SAME number classSetup uses', promo.SCHOOL_LOCK_KEY === classSetup.LINE_UP_KEY && promo.SCHOOL_LOCK_KEY === 7771003);

  // ================= everyone moves up, names follow =================
  theExample();
  let pl = await plan();
  check('names follow: Grade 6 Brown/Pink -> Grade 7 Brown/Pink', to(pl, 'G6B1') === 'Grade 7/Brown' && to(pl, 'G6P2') === 'Grade 7/Pink');
  check('Grade 7 North/South/East -> Grade 8 North/South/East (streams are made new for the new year)', to(pl, 'G7N1') === 'Grade 8/North' && to(pl, 'G7S1') === 'Grade 8/South' && to(pl, 'G7E1') === 'Grade 8/East');
  check('Grade 8 White/Yellow (different names) -> Grade 9 White/Yellow', to(pl, 'G8W1') === 'Grade 9/White' && to(pl, 'G8Y1') === 'Grade 9/Yellow');
  check('the last class graduates', to(pl, 'G9A1') === 'graduate' && to(pl, 'G9A2') === 'graduate');
  check('nobody arrives in Grade 6 (it is empty, waiting for new admissions)', !pl.some((p) => p.dest_class_name === 'Grade 6'));
  check('the plan changed nothing', st.students.every((s) => s.class_id !== null) && st.history.length === 0 && st.runs.length === 0);
  check('one plan line per active student', pl.length === 15);

  // ================= leave =================
  pl = await plan({ [sid('G8W1')]: 'leave' });
  check('leave: not moved, action leave', to(pl, 'G8W1') === 'leave');
  const sm = promo.summarizePlan(pl, st.classes.filter((c) => st.enabled[1].includes(c.name)));
  check('leave: does not count as arriving in Grade 9', sm.arrivals.find((a) => a.class_name === 'Grade 9').total === 2 && sm.totals.leave === 1);

  // ================= repeaters, the rule =================
  pl = await plan({ [sid('G7N1')]: 'repeat', [sid('G7N2')]: 'repeat', [sid('G7N3')]: { action: 'repeat', streamName: 'East' } });
  check('repeaters stay in their class', to(pl, 'G7N1').startsWith('Grade 7/') && to(pl, 'G7N2').startsWith('Grade 7/') && to(pl, 'G7N3') === 'Grade 7/East');
  check('the admin choice always wins ("chosen")', place(pl, 'G7N3') === 'chosen');
  check('Nora joins the smaller arriving stream (Pink 2 < Brown 3)', to(pl, 'G7N2') === 'Grade 7/Pink' && place(pl, 'G7N2') === 'fewest');
  check('then Brown and Pink tie at 3 -> the first name A-Z: Peter joins Brown', to(pl, 'G7N1') === 'Grade 7/Brown' && place(pl, 'G7N1') === 'fewest');
  check('a stream the admin made up for one repeater (East) is NOT a target for the others', !['G7N1', 'G7N2'].some((a) => to(pl, a) === 'Grade 7/East'));
  pl = await plan({ [sid('G7N1')]: 'repeat', [sid('G7N2')]: 'repeat', [sid('G7N3')]: { action: 'repeat', streamName: 'Pink' } });
  check('an admin choice INSIDE an arriving stream counts: Neil in Pink makes it 3, so Nora ties and takes Brown (A-Z), then Peter takes Pink (Brown is now 4)', to(pl, 'G7N3') === 'Grade 7/Pink' && to(pl, 'G7N2') === 'Grade 7/Brown' && to(pl, 'G7N1') === 'Grade 7/Pink', ['G7N1', 'G7N2', 'G7N3'].map((a) => to(pl, a)));
  pl = await plan({ [sid('G7N1')]: { action: 'repeat' }, [sid('G7N2')]: { action: 'repeat', streamName: '' } });
  check('a repeat decision with no stream named is "automatic" too', place(pl, 'G7N1') === 'fewest' && place(pl, 'G7N2') === 'fewest');

  theExample();
  pl = await plan({ [sid('G7N1')]: { action: 'repeat', noStream: true }, [sid('G7N2')]: { action: 'repeat', noStream: true, streamName: 'Pink' } });
  check('"No stream" chosen on purpose is kept (not turned into automatic)', to(pl, 'G7N1') === 'Grade 7/null' && place(pl, 'G7N1') === 'nostream' && to(pl, 'G7N2') === 'Grade 7/null', [to(pl, 'G7N1'), to(pl, 'G7N2')]);
  pl = await plan({ [sid('G7N1')]: { action: 'repeat', noStream: true }, [sid('G7N2')]: 'repeat' });
  check('a repeater with no stream does not count as arriving anywhere, so others still go to Pink', to(pl, 'G7N2') === 'Grade 7/Pink');
  check('the summary shows a "no stream" repeater as no stream', promo.summarizePlan(pl, st.classes).arrivals.find((a) => a.class_name === 'Grade 7').noStream === 1);

  // many repeaters spread out
  world();
  stu('A1', 'a1', 'Grade 6', 'Brown'); stu('A2', 'a2', 'Grade 6', 'Brown'); stu('B1', 'b1', 'Grade 6', 'Pink'); stu('B2', 'b2', 'Grade 6', 'Pink');
  for (let i = 1; i <= 5; i++) stu('R' + i, 'R' + i, 'Grade 7', 'North');
  const decs = {}; for (let i = 1; i <= 5; i++) decs[sid('R' + i)] = 'repeat';
  pl = await plan(decs);
  check('five repeaters spread one by one: Brown, Pink, Brown, Pink, Brown', ['R1', 'R2', 'R3', 'R4', 'R5'].map((a) => to(pl, a).split('/')[1]).join() === 'Brown,Pink,Brown,Pink,Brown', ['R1', 'R2', 'R3', 'R4', 'R5'].map((a) => to(pl, a)));
  const sm2 = promo.summarizePlan(pl, st.classes);
  check('the final sizes are Brown 5 and Pink 4', JSON.stringify(sm2.arrivals.find((a) => a.class_name === 'Grade 7').streams) === JSON.stringify([{ name: 'Brown', count: 5 }, { name: 'Pink', count: 4 }]));

  // ties ignore capitals
  const manual = [
    { action: 'promote', dest_class_id: 1, dest_stream_name: 'banana', placement: undefined },
    { action: 'promote', dest_class_id: 1, dest_stream_name: 'Apple', placement: undefined },
    { action: 'repeat', dest_class_id: 1, dest_stream_name: null, placement: 'auto', stream_name: 'X' },
  ];
  promo.placeRepeaters(manual);
  check('a tie is broken A-Z ignoring capitals (Apple before banana)', manual[2].dest_stream_name === 'Apple');

  // no arriving streams
  world();
  stu('F1', 'first', 'Grade 6', 'Brown'); stu('F2', 'second', 'Grade 6');
  pl = await plan({ [sid('F1')]: 'repeat', [sid('F2')]: 'repeat' });
  check('first class (nobody arrives): a repeater keeps his OWN stream', to(pl, 'F1') === 'Grade 6/Brown' && place(pl, 'F1') === 'own');
  check('first class: a repeater with no stream gets none', to(pl, 'F2') === 'Grade 6/null' && place(pl, 'F2') === 'none');
  world();
  stu('L1', 'low', 'Grade 6'); stu('L2', 'low2', 'Grade 6'); stu('H1', 'high', 'Grade 7', 'North');
  pl = await plan({ [sid('H1')]: 'repeat' });
  check('the class below has no streams: the repeater keeps his own stream', to(pl, 'H1') === 'Grade 7/North' && place(pl, 'H1') === 'own');
  check('and the students below arrive with no stream', to(pl, 'L1') === 'Grade 7/null');

  // ================= repeat into another class, rules, disabled classes, odd students =================
  theExample();
  pl = await plan({ [sid('G8W1')]: { action: 'repeat', classId: cid('Grade 7'), streamName: null } });
  check('a repeater sent to another class counts for THAT class (arrivals into Grade 7 there: Brown/Pink)', to(pl, 'G8W1').startsWith('Grade 7/') && ['Brown', 'Pink'].includes(to(pl, 'G8W1').split('/')[1]) && place(pl, 'G8W1') === 'fewest');
  st.rules.push({ school_id: 1, from_class_id: cid('Grade 7'), from_stream_name: 'North', to_class_id: cid('Grade 8'), to_stream_name: 'Blue' });
  st.rules.push({ school_id: 1, from_class_id: cid('Grade 7'), from_stream_name: 'East', to_class_id: cid('Grade 8'), to_stream_name: null });
  pl = await plan();
  check('a promotion rule renames the stream (North -> Blue)', to(pl, 'G7N1') === 'Grade 8/Blue');
  check('a promotion rule can send students to NO stream', to(pl, 'G7E1') === 'Grade 8/null');
  check('students without a rule still keep their name', to(pl, 'G7S1') === 'Grade 8/South');
  pl = await plan({ [sid('G8W1')]: 'repeat' });
  st.rules = [];
  theExample();
  st.enabled[1] = ['Grade 6', 'Grade 8', 'Grade 9'];
  pl = await plan();
  check('a class switched off is skipped: Grade 6 goes straight to Grade 8', to(pl, 'G6B1') === 'Grade 8/Brown');
  theExample();
  stu('NOCLS', 'No Class', null); stu('LEFT1', 'Gone', 'Grade 7', 'North', 'transferred_out'); stu('GRAD1', 'Old', 'Grade 9', null, 'graduated');
  pl = await plan();
  check('students without a class, who left or who graduated are not in the plan', !pl.some((p) => ['NOCLS', 'LEFT1', 'GRAD1'].includes(p.admission_no)) && pl.length === 15);

  // ================= summarizePlan =================
  theExample();
  pl = await plan({ [sid('G7N1')]: 'repeat', [sid('G8W1')]: 'leave' });
  const sum = promo.summarizePlan(pl, st.classes.filter((c) => st.enabled[1].includes(c.name)));
  check('summary: totals', JSON.stringify(sum.totals) === JSON.stringify({ promote: 11, repeat: 1, leave: 1, graduate: 2 }), sum.totals);
  check('summary: per class, in class order', sum.bySource.map((r) => r.class_name).join() === 'Grade 6,Grade 7,Grade 8,Grade 9' && sum.bySource[1].repeat === 1 && sum.bySource[2].leave === 1);
  check('summary: arrivals per class with sorted streams and counts', JSON.stringify(sum.arrivals[0]) === JSON.stringify({ class_id: cid('Grade 7'), class_name: 'Grade 7', total: 6, noStream: 0, streams: [{ name: 'Brown', count: 3 }, { name: 'Pink', count: 3 }] }), sum.arrivals[0]);
  check('summary: the repeater line says where from and where to', sum.repeaters.length === 1 && sum.repeaters[0].from_stream === 'North' && sum.repeaters[0].to_stream === 'Pink' && sum.repeaters[0].placement === 'fewest', sum.repeaters);
  check('summary: leavers and graduates', sum.leavers.length === 1 && sum.leavers[0].admission_no === 'G8W1' && sum.graduates.length === 2);
  const shuffled = [
    { action: 'promote', class_id: 3, class_name: 'Grade 8', dest_class_id: 4, dest_class_name: 'Grade 9', dest_stream_name: 'Yellow', student_id: 1 },
    { action: 'promote', class_id: 1, class_name: 'Grade 6', dest_class_id: 2, dest_class_name: 'Grade 7', dest_stream_name: 'Pink', student_id: 2 },
    { action: 'promote', class_id: 3, class_name: 'Grade 8', dest_class_id: 4, dest_class_name: 'Grade 9', dest_stream_name: 'White', student_id: 3 },
    { action: 'promote', class_id: 1, class_name: 'Grade 6', dest_class_id: 2, dest_class_name: 'Grade 7', dest_stream_name: 'brown', student_id: 4 },
    { action: 'promote', class_id: 2, class_name: 'Grade 7', dest_class_id: 3, dest_class_name: 'Grade 8', dest_stream_name: null, student_id: 5 },
  ];
  const sh = promo.summarizePlan(shuffled, [{ id: 1, name: 'Grade 6', sort_order: 1 }, { id: 2, name: 'Grade 7', sort_order: 2 }, { id: 3, name: 'Grade 8', sort_order: 3 }, { id: 4, name: 'Grade 9', sort_order: 4 }]);
  check('summary: classes come in the school\'s class order even when the plan is shuffled', sh.bySource.map((r) => r.class_name).join() === 'Grade 6,Grade 7,Grade 8' && sh.arrivals.map((a) => a.class_name).join() === 'Grade 7,Grade 8,Grade 9', [sh.bySource.map((r) => r.class_name), sh.arrivals.map((a) => a.class_name)]);
  check('summary: streams are sorted A-Z ignoring capitals, and students with no stream are counted apart', sh.arrivals[0].streams.map((s) => s.name).join() === 'brown,Pink' && sh.arrivals[2].streams.map((s) => s.name).join() === 'White,Yellow' && sh.arrivals[1].noStream === 1 && sh.arrivals[1].streams.length === 0, sh.arrivals);
  check('summary of an empty plan does not break', promo.summarizePlan([], []).totals.promote === 0);

  // ================= buildDecisions =================
  theExample();
  let d = await promo.buildDecisions(1, { repeat: ['g7n1', ' G7N2 '], leave: ['G8W1'], streams: { G7N2: 'Pink' } }, pool);
  check('decisions: admission numbers (capitals, spaces ignored) become student ids', d[sid('G7N1')] === 'repeat' && d[sid('G8W1')] === 'leave' && JSON.stringify(d[sid('G7N2')]) === JSON.stringify({ action: 'repeat', streamName: 'Pink' }), d);
  check('decisions: nothing given -> empty', Object.keys(await promo.buildDecisions(1, {}, pool)).length === 0);
  check('decisions: unknown admission number refused', await fails(() => promo.buildDecisions(1, { repeat: ['NOPE1', 'G7N1'] }, pool), 400, /No student with admission number nope1/));
  check('decisions: repeating AND leaving refused', await fails(() => promo.buildDecisions(1, { repeat: ['G7N1'], leave: ['g7n1'] }, pool), 400, /both repeating and leaving/));
  check('decisions: a stream for a student who is not repeating is refused', await fails(() => promo.buildDecisions(1, { repeat: ['G7N1'], streams: { G7S1: 'Pink' } }, pool), 400, /not marked repeating/));
  check('decisions: an empty or too long stream name is refused', await fails(() => promo.buildDecisions(1, { repeat: ['G7N1'], streams: { G7N1: ' ' } }, pool), 400, /1 to 40/) && await fails(() => promo.buildDecisions(1, { repeat: ['G7N1'], streams: { G7N1: 'x'.repeat(41) } }, pool), 400, /1 to 40/));
  stu('GONE', 'Gone', 'Grade 7', 'North', 'transferred_out'); stu('NOC', 'No Class', null);
  check('decisions: a student who already left, or has no class, is refused', await fails(() => promo.buildDecisions(1, { repeat: ['GONE'] }, pool), 400, /not an active student with a class/) && await fails(() => promo.buildDecisions(1, { leave: ['NOC'] }, pool), 400, /not an active student with a class/));
  check('decisions: a student of another school is not found', await (async () => { stu('OTHER', 'Other', 'Grade 7'); st.students.find((s) => s.admission_no === 'OTHER').school_id = 2; return fails(() => promo.buildDecisions(1, { repeat: ['OTHER'] }, pool), 400, /No student with admission number other/); })());

  // ================= readiness =================
  theExample();
  const ready = (over = {}) => promo.checkPromotionReady({ schoolId: 1, outgoingAcademicYearId: 10, incomingAcademicYearId: 11, db: pool, ...over });
  let rd = await ready();
  check('ready: Term 3 ended on 23 Oct, today is 1 Nov -> no problems', rd.problems.length === 0, rd);
  check('ready: nothing to fix -> no commands and no warnings either', rd.commands.length === 0 && rd.warnings.length === 0);
  st.today = '2026-10-23';
  rd = await ready();
  check('NOT ready on the last day of Term 3, and it says from which day', rd.problems.length === 1 && /not finished: Term 3 2026 ends on 2026-10-23\. Promotion can be done from 2026-10-24/.test(rd.problems[0]), rd.problems);
  st.today = '2026-10-24';
  check('ready from the day AFTER Term 3 ends', (await ready()).problems.length === 0);
  st.today = '2026-08-01';
  check('NOT ready in the middle of the year', (await ready()).problems.length === 1);
  st.today = '2026-11-01';
  st.terms.find((t) => t.id === 3).end_day = null;
  rd = await ready();
  check('Term 3 without an end date -> a plain problem; the command is kept apart and is EXACTLY right (with real backslashes)', rd.problems.length === 1 && /Term 3 of 2026 has no dates yet/.test(rd.problems[0]) && !/node |set-terms/.test(rd.problems[0]) && rd.commands.length === 1 && rd.commands[0] === 'node src\\scripts\\set-terms.js 1 2026 3 <start> <end>', rd);
  st.terms.find((t) => t.id === 3).end_day = '2026-10-23';
  st.terms = st.terms.filter((t) => t.id !== 3);
  check('Term 3 missing altogether -> problem', (await ready()).problems.length === 1);
  world(); theExample();
  st.terms.find((t) => t.id === 3).start_day = null; st.terms.find((t) => t.id === 3).end_day = null;
  check('only Term 1 and 2 finished is NOT enough (it must be Term 3)', (await ready()).problems.length === 1);
  world(); theExample();
  st.today = '2026-12-31'; st.terms.find((t) => t.id === 3).end_day = '2026-12-31';
  check('the day after is worked out across a year end (31 Dec -> 1 Jan)', /from 2027-01-01/.test((await ready()).problems[0] || ''));
  world(); theExample();
  for (let i = 1; i <= 7; i++) stu('NC' + i, 'nc' + i, null);
  rd = await ready();
  check('students without a class are a problem: first five shown, then "and 2 more"', rd.problems.length === 1 && /7 active students have no class \(NC1, NC2, NC3, NC4, NC5 and 2 more\)/.test(rd.problems[0]), rd.problems);
  world(); theExample(); stu('NC1', 'nc1', null);
  check('one student without a class is said in the singular', /1 active student has no class \(NC1\)/.test((await ready()).problems[0]));
  st.today = '2026-08-01';
  rd = await ready();
  check('several problems are reported together', rd.problems.length === 2);
  world(); theExample();
  check('a year that does not exist -> problem, no crash', (await ready({ incomingAcademicYearId: 99 })).problems[0].includes('does not exist'));
  // warnings about the new year
  st.terms.find((t) => t.id === 4).start_day = null; st.terms.find((t) => t.id === 4).end_day = null;
  rd = await ready();
  check('warning: the new year has no dates yet (promotion is still allowed); the command is exact', rd.problems.length === 0 && rd.warnings.length === 1 && /2027 has no term dates yet/.test(rd.warnings[0]) && !/set-terms/.test(rd.warnings[0]) && rd.commands[0] === 'node src\\scripts\\set-terms.js 1 2027 1 <start> <end>', rd);
  st.terms.find((t) => t.id === 4).start_day = '2026-10-30'; st.terms.find((t) => t.id === 4).end_day = '2027-04-09';
  rd = await ready();
  check('warning: the new year already started and is not charged yet -> do it BEFORE the next check', rd.warnings.length === 1 && /already started \(2026-10-30\).*BEFORE/.test(rd.warnings[0]), rd.warnings);
  st.charged.push(4);
  rd = await ready();
  check('warning: the new year already started AND was charged -> old class fees, charge again', rd.warnings.length === 1 && /ALREADY charged.*OLD class/.test(rd.warnings[0]), rd.warnings);
  st.terms.find((t) => t.id === 4).start_day = '2027-01-04'; st.charged = [];
  check('no warning when the new year starts in the future', (await ready()).warnings.length === 0);

  // ================= promoteSchool: the real thing =================
  theExample();
  const dec = () => ({ [sid('G7N1')]: 'repeat', [sid('G7N2')]: 'repeat', [sid('G7N3')]: { action: 'repeat', streamName: 'East' }, [sid('G8W1')]: 'leave' });   // built when used: students are re-made in every scenario
  const run = (over = {}) => promo.promoteSchool({ outgoingAcademicYearId: 10, incomingAcademicYearId: 11, schoolId: 1, decisions: dec(), staffId: 7, ...over });
  const where = (adm) => { const s = st.students.find((x) => x.admission_no === adm); const sn = s.stream_id ? st.streams.find((x) => x.id === s.stream_id) : null; return `${s.class_id ? cname(s.class_id) : '-'}/${sn ? sn.name : '-'}/${s.status}`; };
  const oldStreams = st.streams.length;
  let r = await run();
  check('result counts: 9 promoted, 3 repeating, 1 left, 2 graduated', r.promoted.length === 9 && r.repeating.length === 3 && r.leftOrTransferred.length === 1 && r.graduated.length === 2, r);
  check('Grade 6 Brown/Pink are now in Grade 7 Brown/Pink', where('G6B1') === 'Grade 7/Brown/active' && where('G6P1') === 'Grade 7/Pink/active');
  check('Grade 7 East/South are in Grade 8 East/South; Grade 8 White/Yellow are in Grade 9', where('G7E1') === 'Grade 8/East/active' && where('G7S1') === 'Grade 8/South/active' && where('G8W2') === 'Grade 9/White/active' && where('G8Y1') === 'Grade 9/Yellow/active');
  check('repeaters are where the plan said (Nora Pink, Peter Brown, Neil East)', where('G7N2') === 'Grade 7/Pink/active' && where('G7N1') === 'Grade 7/Brown/active' && where('G7N3') === 'Grade 7/East/active');
  check('the leaver is marked transferred out and not moved', where('G8W1') === 'Grade 8/White/transferred_out');
  check('graduates are marked graduated', where('G9A1').endsWith('/graduated') && where('G9A2').endsWith('/graduated'));
  check('streams of the new year were made fresh (old ones kept as history)', st.streams.length > oldStreams && st.streams.filter((s) => s.academic_year_id === 10).length === oldStreams && st.streams.some((s) => s.academic_year_id === 11 && s.class_id === cid('Grade 7') && s.name === 'Brown'));
  check('last year is kept: a history row for every student with a class, with the OLD class and stream', st.history.length === 15 && st.history.find((h) => h.student_id === sid('G7N1')).class_id === cid('Grade 7') && st.streams.find((x) => x.id === st.history.find((h) => h.student_id === sid('G7N1')).stream_id).name === 'North');
  check('the run is recorded with its summary (the "only once" guard)', st.runs.length === 1 && st.runs[0].summary.promoted === 9 && st.runs[0].summary.graduated === 2);
  check('one transaction: lock for this school first, committed, connection given back', st.log[0] === 'BEGIN' && st.log[1] === 'LOCK 7771003,1' && st.log[st.log.length - 1] === 'COMMIT' && st.released === 1, st.log);
  check('audited with the staff id and the counts', st.audit.length === 1 && st.audit[0].action === 'school_promoted' && st.audit[0].staff_id === 7 && st.audit[0].detail.outgoing_year === 2026 && st.audit[0].detail.incoming_year === 2027 && st.audit[0].detail.promoted === 9, st.audit);
  const after = JSON.stringify(st.students);
  check('a second run is refused with ALREADY_PROMOTED and changes nothing', await (async () => { const e = await rejects(() => run()); return e && e.code === 'ALREADY_PROMOTED' && /already been promoted/.test(e.message) && JSON.stringify(st.students) === after && st.runs.length === 1 && st.audit.length === 1; })());

  // not ready: refused BEFORE anything moves
  theExample();
  st.today = '2026-08-01';
  const before = JSON.stringify({ s: st.students, st: st.streams });
  check('promotion in the middle of the year is refused (409 NOT_READY) and nothing moves', await (async () => { const e = await rejects(() => run()); return e && e.status === 409 && e.code === 'NOT_READY' && /not finished/.test(e.message) && JSON.stringify({ s: st.students, st: st.streams }) === before; })());
  check('...the "already promoted" claim is undone, no history, no audit, connection given back', st.runs.length === 0 && st.history.length === 0 && st.audit.length === 0 && st.log.includes('ROLLBACK'));
  st.today = '2026-11-01'; stu('NOCLS', 'No Class', null);
  check('a student with no class refuses the promotion', await fails(() => run(), 409, /1 active student has no class \(NOCLS\)/) && st.runs.length === 0);
  st.students = st.students.filter((s) => s.admission_no !== 'NOCLS');
  check('...and once fixed, it runs', (await run()).promoted.length === 9);

  // all or nothing
  theExample();
  st.failOnUpdateNumber = 5;
  const snapB = JSON.stringify({ s: st.students, st: st.streams });
  const err = await rejects(() => run());
  check('a failure half-way undoes EVERYTHING: students, new streams, the claim, the history', err && /disk is full/.test(err.message) && JSON.stringify({ s: st.students, st: st.streams }) === snapB && st.runs.length === 0 && st.history.length === 0, err && err.message);
  check('...nothing is audited, the connection is given back, and it can be run again', st.audit.length === 0 && st.released >= 1 && (st.failOnUpdateNumber = 0, (await run()).promoted.length === 9));

  // years
  theExample();
  check('the new year must come after the old one', await (async () => { const e = await rejects(() => promo.promoteSchool({ outgoingAcademicYearId: 11, incomingAcademicYearId: 10, schoolId: 1 })); return !!e && /must come after/.test(e.message) && st.runs.length === 0; })());
  check('a year that does not exist is refused', await (async () => { const e = await rejects(() => promo.promoteSchool({ outgoingAcademicYearId: 10, incomingAcademicYearId: 99, schoolId: 1 })); return !!e && /does not exist/.test(e.message); })());

  console.log(failed ? `\n${failed} check(s) FAILED.` : '\nAll promotion checks pass.');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });