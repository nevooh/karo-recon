// Tests fee setup (src/services/feeSetup.js) and the safe one-school charge (src/services/termCharge.js)
// without a real database. The pretend database can UNDO work (ROLLBACK), so dry runs and
// "all or nothing" are really tested.   Run:  node src/scripts/test-fee-setup.js
const crypto = require('crypto');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

let failed = 0;
const check = (name, ok, extra) => { if (!ok) failed++; console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (!ok && extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); };
const rejects = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const fails = async (fn, status, re) => { const e = await rejects(fn); return !!(e && e.status === status && re.test(e.message)); };

const st = {};
const CLASSES = ['Grade 1', 'Grade 2', 'Grade 3', 'Grade 4'];
function reset() {
  Object.assign(st, {
    today: '2026-02-10',
    schools: [{ id: 1, name: 'Mwangaza' }, { id: 2, name: 'Other' }],
    classes: CLASSES.map((name, i) => ({ id: i + 1, name, sort_order: i + 1 })),
    sc: [1, 2, 3].map((c) => ({ school_id: 1, class_id: c, enabled: true })).concat([1, 2, 3].map((c) => ({ school_id: 2, class_id: c, enabled: true }))),
    years: [{ id: 9, year: 2025 }, { id: 10, year: 2026 }],
    terms: [
      { id: 31, academic_year_id: 9, term_number: 3, start_day: '2025-09-01', end_day: '2025-11-20' },
      { id: 11, academic_year_id: 10, term_number: 1, start_day: '2026-01-05', end_day: '2026-04-10' },
      { id: 12, academic_year_id: 10, term_number: 2, start_day: '2026-05-05', end_day: '2026-08-07' },
      { id: 13, academic_year_id: 10, term_number: 3, start_day: '2026-09-01', end_day: '2026-11-20' },
    ],
    catalog: [], fees: [], history: [], students: [], choices: [], ledger: [], audit: [],
    nextId: 1000, log: [], released: 0, snap: null,
  });
}
const snapshot = () => JSON.stringify({ catalog: st.catalog, fees: st.fees, history: st.history, choices: st.choices, ledger: st.ledger, nextId: st.nextId });
const restore = (s) => { const o = JSON.parse(s); st.catalog = o.catalog; st.fees = o.fees; st.history = o.history; st.choices = o.choices; st.ledger = o.ledger; st.nextId = o.nextId; };
const cid = (n) => st.classes.find((c) => c.name === n).id;
const sfx = (name) => (name || '').replace(/\s+/g, ' ').trim().toLowerCase();
const addStudent = (school, adm, cls, choices = [], status = 'active') => {
  const s = { id: st.nextId++, school_id: school, admission_no: adm, class_id: cls == null ? null : cid(cls), status };
  st.students.push(s); choices.forEach((n) => st.choices.push({ id: st.nextId++, student_id: s.id, name: n, name_key: sfx(n) })); return s;
};
const feesOf = (school, term, cls) => st.fees.filter((f) => f.school_id === school && f.term_id === term && f.class_id === cid(cls));
const ledgerOf = (sid, tid) => st.ledger.find((l) => l.student_id === sid && l.term_id === tid);

const query = async (sql, p = []) => {
  const q = sql.replace(/\s+/g, ' ').trim();
  if (/^BEGIN/.test(q)) { st.log.push('BEGIN'); st.snap = snapshot(); return { rows: [] }; }
  if (/^COMMIT/.test(q)) { st.log.push('COMMIT'); st.snap = null; return { rows: [] }; }
  if (/^ROLLBACK/.test(q)) { st.log.push('ROLLBACK'); if (st.snap) restore(st.snap); st.snap = null; return { rows: [] }; }
  if (/pg_advisory_xact_lock/.test(q)) { st.log.push('LOCK ' + p.join(',')); return { rows: [] }; }
  if (/^SELECT id, name FROM schools WHERE id = \$1/.test(q)) return { rows: st.schools.filter((s) => s.id === p[0]).map((s) => ({ ...s })) };
  if (/^SELECT to_char\(CURRENT_DATE/.test(q)) return { rows: [{ today: st.today }] };
  if (/FROM terms t JOIN academic_years ay ON ay.id = t.academic_year_id ORDER BY ay.year, t.term_number/.test(q)) {
    return { rows: st.terms.map((t) => ({ ...t, year: st.years.find((y) => y.id === t.academic_year_id).year })).sort((a, b) => (a.year - b.year) || (a.term_number - b.term_number)) };
  }
  if (/FROM classes c LEFT JOIN school_classes sc ON sc.class_id = c.id AND sc.school_id = \$1 ORDER BY c.sort_order/.test(q)) {
    return { rows: st.classes.map((c) => ({ id: c.id, name: c.name, sort_order: c.sort_order, enabled: !!st.sc.find((x) => x.school_id === p[0] && x.class_id === c.id && x.enabled) })) };
  }
  if (/^SELECT id, name, name_key FROM school_optional_fees WHERE school_id = \$1/.test(q)) return { rows: st.catalog.filter((c) => c.school_id === p[0]).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())).map((c) => ({ ...c })) };
  if (/^INSERT INTO school_optional_fees/.test(q)) { st.catalog.push({ id: st.nextId++, school_id: p[0], name: p[1], name_key: p[2] }); return { rows: [] }; }
  if (/^DELETE FROM school_optional_fees WHERE id = \$1/.test(q)) { st.catalog = st.catalog.filter((c) => c.id !== p[0]); return { rows: [] }; }
  if (/FROM fee_items WHERE school_id = \$1 AND is_mandatory = FALSE AND lower\(regexp_replace/.test(q)) return { rows: [{ n: st.fees.filter((f) => f.school_id === p[0] && !f.is_mandatory && sfx(f.name) === p[1]).length }] };
  if (/FROM student_optional_choices c JOIN students s ON s.id = c.student_id WHERE s.school_id = \$1 AND c.name_key = \$2/.test(q)) {
    return { rows: [{ n: st.choices.filter((c) => c.name_key === p[1] && st.students.find((s) => s.id === c.student_id).school_id === p[0]).length }] };
  }
  if (/^SELECT id, name, amount, is_mandatory, version FROM fee_items WHERE school_id = \$1 AND term_id = \$2 AND class_id = \$3/.test(q)) {
    return { rows: st.fees.filter((f) => f.school_id === p[0] && f.term_id === p[1] && f.class_id === p[2]).map((f) => ({ id: f.id, name: f.name, amount: String(f.amount), is_mandatory: f.is_mandatory, version: f.version })) };
  }
  if (/FROM student_optional_choices c JOIN students s ON s.id = c.student_id WHERE s.school_id = \$1 AND s.class_id = \$2 AND s.status = 'active' AND c.name_key = ANY\(\$3\) GROUP BY/.test(q)) {
    const counts = {};
    for (const c of st.choices) { const s = st.students.find((x) => x.id === c.student_id); if (s.school_id === p[0] && s.class_id === p[1] && s.status === 'active' && p[2].includes(c.name_key)) counts[c.name_key] = (counts[c.name_key] || 0) + 1; }
    return { rows: Object.entries(counts).map(([name_key, n]) => ({ name_key, n })) };
  }
  if (/^INSERT INTO fee_item_history/.test(q)) { st.history.push({ school_id: p[0], term_id: p[1], class_id: p[2], name: p[3], amount: p[4], is_mandatory: p[5], version: p[6], replaced_at: '2026-02-10 09:00' }); return { rows: [] }; }
  if (/^DELETE FROM fee_items WHERE school_id = \$1 AND term_id = \$2 AND class_id = \$3/.test(q)) { st.fees = st.fees.filter((f) => !(f.school_id === p[0] && f.term_id === p[1] && f.class_id === p[2])); return { rows: [] }; }
  if (/^INSERT INTO fee_items/.test(q)) { st.fees.push({ id: st.nextId++, school_id: p[0], term_id: p[1], class_id: p[2], name: p[3], amount: p[4], is_mandatory: /TRUE/.test(q), version: p[5] }); return { rows: [] }; }
  if (/^SELECT class_id, name, amount, is_mandatory FROM fee_items WHERE school_id = \$1 AND term_id = \$2 AND class_id IS NOT NULL ORDER BY id/.test(q)) {
    return { rows: st.fees.filter((f) => f.school_id === p[0] && f.term_id === p[1] && f.class_id != null).map((f) => ({ class_id: f.class_id, name: f.name, amount: String(f.amount), is_mandatory: f.is_mandatory })) };
  }
  if (/^SELECT class_id, name, amount, is_mandatory FROM fee_items WHERE school_id = \$1 AND term_id = \$2 ORDER BY id/.test(q)) {
    return { rows: st.fees.filter((f) => f.school_id === p[0] && f.term_id === p[1]).map((f) => ({ class_id: f.class_id, name: f.name, amount: String(f.amount), is_mandatory: f.is_mandatory })) };
  }
  if (/^SELECT class_id, name, amount FROM fee_items WHERE school_id = \$1 AND term_id = \$2 AND is_mandatory = FALSE ORDER BY id/.test(q)) {
    return { rows: st.fees.filter((f) => f.school_id === p[0] && f.term_id === p[1] && !f.is_mandatory).map((f) => ({ class_id: f.class_id, name: f.name, amount: String(f.amount) })) };
  }
  if (/SELECT c\.name_key, s\.class_id, COUNT\(\*\)::int AS n FROM student_optional_choices c JOIN students s .* GROUP BY c\.name_key, s\.class_id/.test(q)) {
    const g = {};
    for (const c of st.choices) { const s2 = st.students.find((x) => x.id === c.student_id); if (s2.school_id === p[0] && s2.status === 'active') { const k = c.name_key + '|' + s2.class_id; g[k] = (g[k] || 0) + 1; } }
    return { rows: Object.entries(g).map(([k, n]) => ({ name_key: k.split('|')[0], class_id: Number(k.split('|')[1]), n })) };
  }
  if (/SELECT c\.name_key, COUNT\(\*\)::int AS n FROM student_optional_choices c JOIN students s ON s\.id = c\.student_id WHERE s\.school_id = \$1 GROUP BY c\.name_key/.test(q)) {
    const g = {};
    for (const c of st.choices) { const s2 = st.students.find((x) => x.id === c.student_id); if (s2.school_id === p[0]) g[c.name_key] = (g[c.name_key] || 0) + 1; }
    return { rows: Object.entries(g).map(([name_key, n]) => ({ name_key, n })) };
  }
  if (/AS name_key, COUNT\(\*\)::int AS n FROM fee_items WHERE school_id = \$1 AND is_mandatory = FALSE GROUP BY 1/.test(q)) {
    const g = {};
    for (const f of st.fees) if (f.school_id === p[0] && !f.is_mandatory) g[sfx(f.name)] = (g[sfx(f.name)] || 0) + 1;
    return { rows: Object.entries(g).map(([name_key, n]) => ({ name_key, n })) };
  }
  if (/^SELECT name, amount, is_mandatory, version FROM fee_items WHERE school_id = \$1 AND term_id = \$2 AND class_id = \$3 ORDER BY is_mandatory DESC, id/.test(q)) {
    return { rows: st.fees.filter((f) => f.school_id === p[0] && f.term_id === p[1] && f.class_id === p[2]).sort((a, b) => (b.is_mandatory - a.is_mandatory) || (a.id - b.id)).map((f) => ({ name: f.name, amount: String(f.amount), is_mandatory: f.is_mandatory, version: f.version })) };
  }
  if (/FROM fee_item_history WHERE school_id = \$1 AND term_id = \$2 AND class_id = \$3 ORDER BY version DESC, id/.test(q)) {
    return { rows: st.history.filter((h) => h.school_id === p[0] && h.term_id === p[1] && h.class_id === p[2]).sort((a, b) => b.version - a.version).map((h) => ({ version: h.version, name: h.name, amount: String(h.amount), is_mandatory: h.is_mandatory, replaced_at: h.replaced_at })) };
  }
  // ---- termCharge and chargeStudentForTerm
  if (/^SELECT DISTINCT class_id FROM fee_items WHERE school_id = \$1 AND term_id = \$2/.test(q)) {
    return { rows: [...new Set(st.fees.filter((f) => f.school_id === p[0] && f.term_id === p[1]).map((f) => f.class_id))].map((class_id) => ({ class_id })) };
  }
  if (/FROM students s LEFT JOIN classes c ON c.id = s.class_id WHERE s.school_id = \$1 AND s.status = 'active' ORDER BY s.id/.test(q)) {
    st.touched = st.touched || []; st.touched.push('students of ' + p[0]);
    return { rows: st.students.filter((s) => s.school_id === p[0] && s.status === 'active').map((s) => ({ id: s.id, admission_no: s.admission_no, class_id: s.class_id, class_name: s.class_id ? st.classes.find((c) => c.id === s.class_id).name : null })) };
  }
  if (/FROM student_term_ledger l JOIN students s ON s.id = l.student_id WHERE l.term_id = \$1 AND s.school_id = \$2/.test(q)) {
    st.touched = st.touched || []; st.touched.push('ledger of ' + p[1]);
    return { rows: st.ledger.filter((l) => l.term_id === p[0] && st.students.find((s) => s.id === l.student_id).school_id === p[1]).map((l) => ({ student_id: l.student_id, opening_balance: String(l.opening_balance), fees_charged: String(l.fees_charged) })) };
  }
  if (/^SELECT COALESCE\(SUM\(amount\), 0\) as total FROM fee_items/.test(q)) {
    return { rows: [{ total: String(st.fees.filter((f) => f.school_id === p[0] && f.term_id === p[1] && f.is_mandatory && (f.class_id == null || f.class_id === p[2])).reduce((a, f) => a + Number(f.amount), 0)) }] };
  }
  if (/^SELECT name, amount, class_id FROM fee_items WHERE school_id = \$1 AND term_id = \$2 AND is_mandatory = FALSE AND \(class_id IS NULL OR class_id = \$3\)/.test(q)) {
    return { rows: st.fees.filter((f) => f.school_id === p[0] && f.term_id === p[1] && !f.is_mandatory && (f.class_id == null || f.class_id === p[2])).map((f) => ({ name: f.name, amount: String(f.amount), class_id: f.class_id })) };
  }
  if (/^SELECT 1 FROM fee_items WHERE school_id = \$1 AND term_id = \$2 AND \(class_id IS NULL OR class_id = \$3\) LIMIT 1/.test(q)) {
    return { rows: st.fees.filter((f) => f.school_id === p[0] && f.term_id === p[1] && (f.class_id == null || f.class_id === p[2])).slice(0, 1).map(() => ({ x: 1 })) };
  }
  if (/^SELECT id, name, name_key FROM student_optional_choices WHERE student_id = \$1/.test(q)) return { rows: st.choices.filter((c) => c.student_id === p[0]).map((c) => ({ ...c })) };
  if (/^DELETE FROM student_optional_choices WHERE id = \$1/.test(q)) { st.choices = st.choices.filter((c) => c.id !== p[0]); return { rows: [] }; }
  if (/^SELECT opening_balance, fees_charged, amount_paid FROM student_term_ledger/.test(q)) {
    return { rows: st.ledger.filter((l) => l.student_id === p[0] && l.term_id === p[1]).map((l) => ({ opening_balance: String(l.opening_balance), fees_charged: String(l.fees_charged), amount_paid: String(l.amount_paid) })) };
  }
  if (/^SELECT amount FROM student_starting_balance/.test(q)) return { rows: [] };
  if (/^INSERT INTO student_term_ledger/.test(q)) {
    st.touched = st.touched || []; st.touched.push('write ledger of student ' + p[0]);
    const row = ledgerOf(p[0], p[1]);
    if (row) { row.opening_balance = p[2]; row.fees_charged = p[3]; } else st.ledger.push({ student_id: p[0], term_id: p[1], opening_balance: p[2], fees_charged: p[3], amount_paid: 0 });
    return { rows: [] };
  }
  if (/^SELECT \* FROM terms WHERE academic_year_id = \$1 AND term_number = \$2/.test(q)) return { rows: st.terms.filter((t) => t.academic_year_id === p[0] && t.term_number === p[1]).map((t) => ({ ...t })) };
  if (/^SELECT t\.\* FROM terms t JOIN academic_years ay/.test(q)) {
    const year = st.years.find((y) => y.id === p[0]).year - 1;
    return { rows: st.terms.filter((t) => st.years.find((y) => y.id === t.academic_year_id).year === year && t.term_number === 3).map((t) => ({ ...t })) };
  }
  if (/^INSERT INTO audit_log/.test(q)) { st.audit.push({ school_id: p[0], action: p[2], detail: JSON.parse(p[3]) }); return { rows: [] }; }
  throw new Error('the pretend database does not know this query: ' + q.slice(0, 100));
};
const pool = { query, connect: async () => ({ query, release: () => { st.released++; } }) };
require.cache[require.resolve('../db/db')] = { id: require.resolve('../db/db'), filename: require.resolve('../db/db'), loaded: true, exports: { pool, initSchema: async () => {} } };
const fsvc = require('../services/feeSetup');
const tc = require('../services/termCharge');
const S = 1;

(async () => {
  // ================= reading what is typed =================
  const p = fsvc.parseItem;
  check('fee "Tuition=50000" read', JSON.stringify(p('Tuition=50000')) === '{"name":"Tuition","amount":50000}');
  check('commas and decimals in the amount', p('Exam= 2,500.50 ').amount === 2500.5 && p('Exam= 2,500.50 ').name === 'Exam');
  check('a name that has an = in it uses the LAST =', p('A=B=100').name === 'A=B');
  for (const bad of ['Tuition', '=500', 'Tuition=', 'Tuition=abc', 'Tuition=0', 'Tuition=-5', 'Tuition=1.234', 'Tuition=99999999999']) {
    check(`"${bad}" is refused`, !!(await rejects(() => p(bad))), bad);
  }
  check('long names refused', !!(await rejects(() => p('x'.repeat(61) + '=5'))));

  // ================= class lists =================
  reset();
  const all = (await query('SELECT c.id FROM classes c LEFT JOIN school_classes sc ON sc.class_id = c.id AND sc.school_id = $1 ORDER BY c.sort_order', [S])).rows;
  const classRows = await (async () => (await query(`SELECT c.id, c.name, c.sort_order, 1 FROM classes c LEFT JOIN school_classes sc ON sc.class_id = c.id AND sc.school_id = $1 ORDER BY c.sort_order`, [S])).rows)();
  check('class rows come back in order, Grade 4 is off', classRows.length === 4 && classRows[3].enabled === false);
  const ex = fsvc.expandClasses;
  check('comma list', ex(classRows, ['Grade 1,Grade 3']).map((c) => c.name).join() === 'Grade 1,Grade 3');
  check('range "Grade 1..Grade 3" = all three', ex(classRows, ['Grade 1..Grade 3']).map((c) => c.name).join() === 'Grade 1,Grade 2,Grade 3');
  check('range backwards works too', ex(classRows, ['Grade 3..Grade 1']).length === 3);
  check('mixed: range and a name', ex(classRows, ['Grade 1..Grade 2, Grade 3']).length === 3);
  check('same class twice counts once', ex(classRows, ['Grade 1,grade 1']).length === 1);
  check('unknown class refused', await fails(async () => ex(classRows, ['Grade 9']), 400, /Unknown class/));
  check('a switched-off class refused', await fails(async () => ex(classRows, ['Grade 4']), 409, /Grade 4 is switched off/));
  check('nothing given refused', await fails(async () => ex(classRows, ['']), 400, /Say which classes/));

  // ================= the school's optional fee list =================
  reset();
  await fsvc.addOptionalName(S, 'Lunch'); await fsvc.addOptionalName(S, ' Bus ');
  check('names added, tidied', (await fsvc.listOptionalNames(S)).names.join() === 'Bus,Lunch');
  check('same name again refused (capitals ignored)', await fails(() => fsvc.addOptionalName(S, 'LUNCH'), 409, /already on this school/));
  check('the list is per school', (await fsvc.listOptionalNames(2)).names.length === 0);
  const dryAdd = await fsvc.addOptionalName(S, 'Swimming', { dry: true });
  check('dry add changes nothing', dryAdd.dry && (await fsvc.listOptionalNames(S)).names.length === 2 && st.audit.length === 2);
  check('removing an unknown name refused', await fails(() => fsvc.removeOptionalName(S, 'Pizza'), 404, /not on this school/));
  await fsvc.removeOptionalName(S, 'bus');
  check('removing an unused name works', (await fsvc.listOptionalNames(S)).names.join() === 'Lunch');

  // ================= setting fees =================
  reset();
  await fsvc.addOptionalName(S, 'Lunch'); await fsvc.addOptionalName(S, 'Bus');
  let r = await fsvc.setFees(S, { classNames: ['Grade 1..Grade 3'], year: 2026, term: 2, fees: ['Tuition=50000', 'Exam=2,000'], optional: ['lunch=3000', 'Bus=5000'] });
  check('3 classes set in one go, term is coming', r.classes.length === 3 && r.term.state === 'coming' && r.term.label === 'Term 2 2026');
  check('each class got its OWN rows (4 each)', ['Grade 1', 'Grade 2', 'Grade 3'].every((c) => feesOf(S, 12, c).length === 4));
  check('optional stored with the list\'s spelling', feesOf(S, 12, 'Grade 1').find((f) => !f.is_mandatory && sfx(f.name) === 'lunch').name === 'Lunch');
  check('mandatory flag right', feesOf(S, 12, 'Grade 1').filter((f) => f.is_mandatory).map((f) => f.name).sort().join() === 'Exam,Tuition');
  check('first time = version 1, nothing in history', feesOf(S, 12, 'Grade 1').every((f) => f.version === 1) && st.history.length === 0);
  check('audit line written', st.audit.some((a) => a.action === 'fees_set' && a.detail.classes.length === 3));
  check('one transaction, committed, locked per school', st.log.includes('LOCK 7771003,1') && st.log.includes('COMMIT'));
  const before = st.audit.length;
  r = await fsvc.setFees(S, { classNames: ['Grade 2'], year: 2026, term: 2, fees: ['Exam=2000', 'Tuition=50000'], optional: ['Bus=5000', 'Lunch=3000'] });
  check('the same list in another order -> unchanged', r.classes[0].unchanged && st.history.length === 0 && st.audit.length === before);
  r = await fsvc.setFees(S, { classNames: ['Grade 2'], year: 2026, term: 2, fees: ['Tuition=55000', 'Exam=2000'], optional: ['Bus=5000', 'Lunch=3000'] });
  check('a price change replaces the list, old rows go to history, version goes up', !r.classes[0].unchanged && st.history.length === 4 && feesOf(S, 12, 'Grade 2').every((f) => f.version === 2) && feesOf(S, 12, 'Grade 2').find((f) => f.name === 'Tuition').amount === 55000);
  check('other classes untouched by that change', feesOf(S, 12, 'Grade 1').find((f) => f.name === 'Tuition').amount === 50000);
  check('optional name not on the list refused, saves nothing', await fails(() => fsvc.setFees(S, { classNames: ['Grade 1'], year: 2026, term: 2, fees: ['Tuition=1'], optional: ['Swimming=100'] }), 400, /"Swimming" is not on this school's optional fee list \(it has: Bus, Lunch\)/) && st.catalog.length === 2);
  r = await fsvc.setFees(S, { classNames: ['Grade 1'], year: 2026, term: 2, fees: ['Tuition=50000', 'Exam=2000'], optional: ['Lunch=3000', 'Bus=5000', 'Swimming=100'], newOptional: true });
  check('--new adds the name to the list and sets the fee', r.addedToList.join() === 'Swimming' && st.catalog.some((c) => c.name === 'Swimming') && feesOf(S, 12, 'Grade 1').length === 5);
  check('a name written twice refused', await fails(() => fsvc.setFees(S, { classNames: ['Grade 1'], year: 2026, term: 2, fees: ['Lunch=1'], optional: ['LUNCH=2'] }), 400, /written twice/));
  check('no fees at all refused', await fails(() => fsvc.setFees(S, { classNames: ['Grade 1'], year: 2026, term: 2 }), 400, /at least one fee/));
  check('a class that is off refused', await fails(() => fsvc.setFees(S, { classNames: ['Grade 4'], year: 2026, term: 2, fees: ['Tuition=1'] }), 409, /switched off/));
  check('an unknown term refused', await fails(() => fsvc.setFees(S, { classNames: ['Grade 1'], year: 2027, term: 1, fees: ['Tuition=1'] }), 404, /no Term 1 2027/));
  check('a bad term number refused', await fails(() => fsvc.setFees(S, { classNames: ['Grade 1'], year: 2026, term: 4, fees: ['Tuition=1'] }), 400, /not a term/));
  check('an ENDED term can never be changed', await fails(() => fsvc.setFees(S, { classNames: ['Grade 1'], year: 2025, term: 3, fees: ['Tuition=1'], startedTerm: true }), 409, /already ended/));
  check('a RUNNING term is locked', await fails(() => fsvc.setFees(S, { classNames: ['Grade 1'], year: 2026, term: 1, fees: ['Tuition=1'] }), 409, /running, so its fees are locked.*--started-term/));
  r = await fsvc.setFees(S, { classNames: ['Grade 1,Grade 2'], year: 2026, term: 1, fees: ['Tuition=40000'], optional: ['Lunch=2500', 'Bus=4000'], startedTerm: true });
  check('a running term is allowed with --started-term', r.classes.length === 2 && r.term.state === 'running');
  const hist = st.history.length, fees11 = JSON.stringify(st.fees.filter((f) => f.term_id === 11));
  r = await fsvc.setFees(S, { classNames: ['Grade 3'], year: 2026, term: 1, fees: ['Tuition=99'], startedTerm: true, dry: true });
  check('dry run changes nothing', r.dry && st.history.length === hist && feesOf(S, 11, 'Grade 3').length === 0 && JSON.stringify(st.fees.filter((f) => f.term_id === 11)) === fees11);
  check('dry run rolled back, no audit line for it', st.log[st.log.length - 1] === 'ROLLBACK' && !st.audit.some((a) => a.detail.fees === 1 && a.detail.classes && a.detail.classes[0] === 'Grade 3'));

  // ================= removing an optional fee that students chose =================
  reset();
  await fsvc.addOptionalName(S, 'Lunch'); await fsvc.addOptionalName(S, 'Bus');
  await fsvc.setFees(S, { classNames: ['Grade 2'], year: 2026, term: 2, fees: ['Tuition=50000'], optional: ['Lunch=3000', 'Bus=5000'] });
  addStudent(S, 'A1', 'Grade 2', ['Bus', 'Lunch']); addStudent(S, 'A2', 'Grade 2', ['Bus']); addStudent(S, 'A3', 'Grade 2', []); addStudent(S, 'A4', 'Grade 2', ['Bus'], 'transferred_out'); addStudent(2, 'B1', 'Grade 2', ['Bus']);
  let e = await rejects(() => fsvc.setFees(S, { classNames: ['Grade 2'], year: 2026, term: 2, fees: ['Tuition=50000'], optional: ['Lunch=3000'] }));
  check('removing Bus is refused and says 2 students (only active, only this school)', e && e.status === 409 && /Grade 2: 2 students have chosen "Bus"/.test(e.message) && /--allow-drop/.test(e.message), e && e.message);
  check('refused = nothing changed', feesOf(S, 12, 'Grade 2').length === 3 && st.history.length === 0);
  r = await fsvc.setFees(S, { classNames: ['Grade 2'], year: 2026, term: 2, fees: ['Tuition=50000'], optional: ['Lunch=3000'], allowDrop: true, dry: true });
  check('dry + allow-drop reports who would lose it', r.classes[0].drops.length === 1 && r.classes[0].drops[0].students === 2 && feesOf(S, 12, 'Grade 2').length === 3);
  r = await fsvc.setFees(S, { classNames: ['Grade 2'], year: 2026, term: 2, fees: ['Tuition=50000'], optional: ['Lunch=3000'], allowDrop: true });
  check('with --allow-drop it goes through', feesOf(S, 12, 'Grade 2').length === 2);
  check('turning an optional fee into a fee everyone pays also counts as a drop of the choice', await fails(() => fsvc.setFees(S, { classNames: ['Grade 2'], year: 2026, term: 2, fees: ['Tuition=50000', 'Lunch=3000'] }), 409, /have chosen "Lunch"|has chosen "Lunch"/));
  check('a list name in use cannot be removed', await fails(() => fsvc.removeOptionalName(S, 'Bus'), 409, /still in use.*chosen by 3 students/));
  check('a list name used in a fee line cannot be removed', await fails(() => fsvc.removeOptionalName(S, 'Lunch'), 409, /still in use in 1 class fee line/));

  // ================= copying fees =================
  reset();
  await fsvc.addOptionalName(S, 'Lunch');
  await fsvc.setFees(S, { classNames: ['Grade 1..Grade 2'], year: 2026, term: 2, fees: ['Tuition=50000'], optional: ['Lunch=3000'] });
  r = await fsvc.copyFees(S, { from: { year: 2026, term: 2 }, to: { year: 2026, term: 3 } });
  check('copy repeats Term 2 into Term 3 for the classes that have fees', r.classes.length === 2 && r.skipped.join() === 'Grade 3' && feesOf(S, 13, 'Grade 1').length === 2 && feesOf(S, 13, 'Grade 2').length === 2);
  check('copy keeps mandatory/optional and prices', feesOf(S, 13, 'Grade 1').find((f) => f.name === 'Lunch').is_mandatory === false && feesOf(S, 13, 'Grade 1').find((f) => f.name === 'Tuition').amount === 50000);
  r = await fsvc.copyFees(S, { from: { year: 2026, term: 2 }, to: { year: 2026, term: 3 } });
  check('copying again changes nothing', r.classes.every((c) => c.unchanged));
  r = await fsvc.copyFees(S, { from: { year: 2026, term: 2 }, to: { year: 2026, term: 3 }, classNames: ['Grade 1'] });
  check('copy can be limited to some classes', r.classes.length === 1);
  check('copy to the same term refused', await fails(() => fsvc.copyFees(S, { from: { year: 2026, term: 2 }, to: { year: 2026, term: 2 } }), 400, /same one/));
  check('copy into an ended term refused', await fails(() => fsvc.copyFees(S, { from: { year: 2026, term: 2 }, to: { year: 2025, term: 3 } }), 409, /ended/));
  check('copy into a running term needs --started-term', await fails(() => fsvc.copyFees(S, { from: { year: 2026, term: 2 }, to: { year: 2026, term: 1 } }), 409, /--started-term/));
  check('copy from a term with no fees refused', await fails(() => fsvc.copyFees(S, { from: { year: 2026, term: 1 }, to: { year: 2026, term: 3 } }), 409, /nothing to copy/));
  // a name used in the source but missing from the list is added to the list by the copy
  reset();
  st.fees.push({ id: 1, school_id: S, term_id: 12, class_id: cid('Grade 1'), name: 'Old Optional', amount: 700, is_mandatory: false, version: 1 });
  r = await fsvc.copyFees(S, { from: { year: 2026, term: 2 }, to: { year: 2026, term: 3 } });
  check('a name already in use but missing from the list is added to it by copy', r.addedToList.join() === 'Old Optional' && st.catalog.length === 1);

  // ================= show =================
  reset();
  await fsvc.addOptionalName(S, 'Lunch');
  await fsvc.setFees(S, { classNames: ['Grade 1'], year: 2026, term: 1, fees: ['Tuition=40000'], optional: ['Lunch=2500'], startedTerm: true });
  let sh = await fsvc.showFees(S, {});
  check('show defaults to the running term', sh.term.label === 'Term 1 2026' && sh.term.state === 'running');
  check('show lists the switched-on classes, set or not', sh.classes.length === 3 && sh.classes[0].mandatory[0].amount === 40000 && sh.classes[1].mandatory.length === 0);
  check('show includes the school\'s optional list', sh.optionalList.join() === 'Lunch');
  sh = await fsvc.showFees(S, { year: 2026, term: 3 });
  check('show can name another term', sh.term.label === 'Term 3 2026' && sh.classes.every((c) => !c.mandatory.length));

  // ================= charge-term: the safety rules =================
  reset();
  await fsvc.addOptionalName(S, 'Lunch'); await fsvc.addOptionalName(S, 'Bus');
  await fsvc.setFees(S, { classNames: ['Grade 1,Grade 2'], year: 2026, term: 1, fees: ['Tuition=40000'], optional: ['Lunch=2500', 'Bus=4000'], startedTerm: true });
  const a1 = addStudent(S, 'A1', 'Grade 1', ['Lunch', 'Bus']);
  const a2 = addStudent(S, 'A2', 'Grade 2', []);
  const a3 = addStudent(S, 'A3', null);                                   // no class
  const a4 = addStudent(S, 'A4', 'Grade 3', []);                          // class with no fees set
  const a5 = addStudent(S, 'A5', 'Grade 1', ['Lunch'], 'transferred_out');
  const b1 = addStudent(2, 'B1', 'Grade 1', ['Lunch']);                   // another school
  check('a term that has not started is refused', await fails(() => tc.chargeSchoolTerm(S, { year: 2026, term: 2 }), 409, /has not started yet \(it starts on 2026-05-05\)/));
  check('an older term is locked', await fails(() => tc.chargeSchoolTerm(S, { year: 2025, term: 3 }), 409, /in the past: Term 1 2026 has started since/));
  check('an unknown term refused', await fails(() => tc.chargeSchoolTerm(S, { year: 2027, term: 1 }), 404, /no Term 1 2027/));
  check('a bad year refused', await fails(() => tc.chargeSchoolTerm(S, { year: 'abc', term: 1 }), 400, /not a year/));
  check('a school with no fees for the term refused', await fails(() => tc.chargeSchoolTerm(2, { year: 2026, term: 1 }), 409, /no fees set for Term 1 2026/));
  check('an unknown school refused', await fails(() => tc.chargeSchoolTerm(77, { year: 2026, term: 1 }), 404, /no school/));
  check('refusals changed nothing', st.ledger.length === 0 && st.audit.filter((x) => x.action === 'term_charged').length === 0);
  st.touched = [];
  const dry = await tc.chargeSchoolTerm(S, { year: 2026, term: 1, dry: true });
  check('dry run: counts the right students (active, with a class, this school)', dry.dry && dry.students === 3 && dry.newRows === 3 && dry.changed === 0, dry);
  check('dry run: totals are right (46,500 + 40,000 + 0)', dry.totalFees === 46500 + 40000 + 0 && dry.totalOpening === 0, dry);
  check('dry run: a student with no class is skipped and named', dry.skippedNoClass.join() === 'A3');
  check('dry run: a class with students but no fees is reported', dry.classesWithoutFees.length === 1 && dry.classesWithoutFees[0].name === 'Grade 3' && dry.classesWithoutFees[0].students === 1);
  check('dry run: changed NOTHING and wrote no audit line', st.ledger.length === 0 && st.log[st.log.length - 1] === 'ROLLBACK' && st.audit.filter((x) => x.action === 'term_charged').length === 0);
  check('ONLY the named school was read or written', st.touched.every((t) => !/ of 2$|student ' + b1.id/.test(t)) && !st.touched.some((t) => t === 'write ledger of student ' + b1.id));
  const real = await tc.chargeSchoolTerm(S, { year: 2026, term: 1 });
  check('real run: ledger rows written for this school only', st.ledger.length === 3 && !ledgerOf(b1.id, 11) && !ledgerOf(a3.id, 11) && !ledgerOf(a5.id, 11));
  check('real run: fees per student right (Lunch+Bus for A1)', ledgerOf(a1.id, 11).fees_charged === 46500 && ledgerOf(a2.id, 11).fees_charged === 40000 && ledgerOf(a4.id, 11).fees_charged === 0);
  check('real run: audit line written, no admission numbers in it', st.audit.some((x) => x.action === 'term_charged' && x.detail.students === 3 && x.detail.via === 'charge-term') && !JSON.stringify(st.audit).includes('"A1"'));
  ledgerOf(a1.id, 11).amount_paid = 15000;
  const again = await tc.chargeSchoolTerm(S, { year: 2026, term: 1 });
  check('running again: nothing changes, payments kept', again.changed === 0 && again.newRows === 0 && ledgerOf(a1.id, 11).amount_paid === 15000);
  await fsvc.setFees(S, { classNames: ['Grade 1'], year: 2026, term: 1, fees: ['Tuition=42000'], optional: ['Lunch=2500', 'Bus=4000'], startedTerm: true });
  const fix = await tc.chargeSchoolTerm(S, { year: 2026, term: 1 });
  check('after a price change the run updates only that class and keeps the payment', fix.changed === 1 && ledgerOf(a1.id, 11).fees_charged === 48500 && ledgerOf(a1.id, 11).amount_paid === 15000 && ledgerOf(a2.id, 11).fees_charged === 40000);
  await fsvc.setFees(S, { classNames: ['Grade 1'], year: 2026, term: 1, fees: ['Tuition=42000'], optional: ['Lunch=2500'], startedTerm: true, allowDrop: true });
  const drop = await tc.chargeSchoolTerm(S, { year: 2026, term: 1 });
  check('a choice the class stopped offering is dropped at the charge and counted', drop.dropped.Bus === 1 && ledgerOf(a1.id, 11).fees_charged === 44500 && !st.choices.some((c) => c.student_id === a1.id && c.name_key === 'bus'), drop.dropped);
  check('the other school\'s student keeps their choice', st.choices.some((c) => c.student_id === b1.id));
  // carry-over from the previous term works through the per-school charge
  st.today = '2026-05-20';
  await fsvc.setFees(S, { classNames: ['Grade 1'], year: 2026, term: 2, fees: ['Tuition=42000'], optional: ['Lunch=2600'], startedTerm: true });
  const t2 = await tc.chargeSchoolTerm(S, { year: 2026, term: 2 });
  check('next term: opening = what was left unpaid in Term 1', ledgerOf(a1.id, 12).opening_balance === 44500 - 15000 && ledgerOf(a1.id, 12).fees_charged === 44600, ledgerOf(a1.id, 12));
  check('Term 1 is now locked', await fails(() => tc.chargeSchoolTerm(S, { year: 2026, term: 1 }), 409, /in the past: Term 2 2026 has started since/));
  st.today = '2026-12-15';
  check('Term 2 is locked once Term 3 has started', await fails(() => tc.chargeSchoolTerm(S, { year: 2026, term: 2 }), 409, /in the past: Term 3 2026/) );

  // ================= classes by id (what the screens send) =================
  reset();
  await fsvc.addOptionalName(S, 'Lunch');
  r = await fsvc.setFees(S, { classIds: [cid('Grade 3'), cid('Grade 1')], year: 2026, term: 2, fees: [{ name: 'Tuition', amount: 50000 }], optional: [{ name: 'Lunch', amount: 3000 }] });
  check('classes by id: set, in class order', r.classes.map((c) => c.class).join() === 'Grade 1,Grade 3' && feesOf(S, 12, 'Grade 1').length === 2 && feesOf(S, 12, 'Grade 3').length === 2);
  check('classes by id: amounts may be numbers', feesOf(S, 12, 'Grade 1').find((f) => f.name === 'Tuition').amount === 50000);
  check('classes by id: an unknown class refused', await fails(() => fsvc.setFees(S, { classIds: [999], year: 2026, term: 2, fees: ['Tuition=1'] }), 400, /does not exist/));
  check('classes by id: a switched-off class refused', await fails(() => fsvc.setFees(S, { classIds: [cid('Grade 4')], year: 2026, term: 2, fees: ['Tuition=1'] }), 409, /Grade 4 is switched off/));
  check('classes by id: an empty list refused', await fails(() => fsvc.setFees(S, { classIds: [], year: 2026, term: 2, fees: ['Tuition=1'] }), 400, /at least one class/));
  check('classes by id: text instead of numbers refused', await fails(() => fsvc.setFees(S, { classIds: ['1'], year: 2026, term: 2, fees: ['Tuition=1'] }), 400, /at least one class/));
  r = await fsvc.copyFees(S, { from: { year: 2026, term: 2 }, to: { year: 2026, term: 3 }, classIds: [cid('Grade 3')] });
  check('copy by class id copies only that class', r.classes.length === 1 && r.classes[0].class === 'Grade 3' && feesOf(S, 13, 'Grade 1').length === 0);

  // ================= ranges: "Grade 1-3" =================
  const six = [1, 2, 3, 4, 5, 6].map((i) => ({ id: i, name: 'Grade ' + i, sort_order: i }));
  const br = fsvc.buildRanges;
  check('1,2,3 -> "Grade 1–3"', br(six, [1, 2, 3]).label === 'Grade 1\u20133');
  check('two next to each other -> "Grade 4–5"', br(six, [4, 5]).label === 'Grade 4\u20135');
  check('a single class keeps its name', br(six, [2]).label === 'Grade 2');
  check('a gap is never swallowed: 1,2,3 and 5 -> "Grade 1–3, Grade 5"', br(six, [1, 2, 3, 5]).label === 'Grade 1\u20133, Grade 5' && br(six, [1, 2, 3, 5]).segments.length === 2);
  check('order of the ids does not matter', br(six, [3, 1, 2]).label === 'Grade 1\u20133' && br(six, [3, 1, 2]).ids.join() === '1,2,3');
  check('every switched-on class -> "All classes"', br(six, [1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5, 6]).label === 'All classes');
  check('"All classes" needs more than one class', br(six, [1], [1]).label === 'Grade 1');
  check('almost all is NOT "All classes"', br(six, [1, 2, 3, 4, 5], [1, 2, 3, 4, 5, 6]).label === 'Grade 1\u20135');
  check('a switched-off class in the middle breaks the range when the order has it', br(six, [1, 2, 4, 5]).label === 'Grade 1\u20132, Grade 4\u20135');
  check('PP1,PP2 -> "PP1–2"; Playgroup..PP2 -> "Playgroup–PP2"', fsvc.rangeText('PP1', 'PP2') === 'PP1\u20132' && fsvc.rangeText('Playgroup', 'PP2') === 'Playgroup\u2013PP2');

  // ================= the fees overview: terms, same-fee groups, not set =================
  reset();
  await fsvc.addOptionalName(S, 'Lunch'); await fsvc.addOptionalName(S, 'Bus');
  await fsvc.setFees(S, { classIds: [cid('Grade 1'), cid('Grade 2')], year: 2026, term: 2, fees: ['Tuition=50000'], optional: ['Lunch=3000'] });
  await fsvc.setFees(S, { classIds: [cid('Grade 3')], year: 2026, term: 2, fees: ['Tuition=60000'], optional: ['Lunch=3000', 'Bus=5000'] });
  sh = await fsvc.showFees(S, { year: 2026, term: 2 });
  check('overview: every term for the tabs, with states, and which one is selected', sh.terms.length === 4 && sh.terms.find((t) => t.selected).label === 'Term 2 2026' && sh.terms.map((t) => t.state).join() === 'ended,running,coming,coming', sh.terms);
  check('overview: classes with identical fees are grouped as a range', sh.sameFees.length === 2 && sh.sameFees[0].label === 'Grade 1\u20132' && sh.sameFees[1].label === 'Grade 3', sh.sameFees.map((g) => g.label));
  check('overview: the group carries the shared fee list', sh.sameFees[0].mandatory[0].amount === 50000 && sh.sameFees[0].optional[0].name === 'Lunch');
  check('overview: nothing is "not set" when every class has fees', sh.notSet === null);
  check('overview: carries every class level (on or off) so a screen can build the same ranges', sh.levels.length === 4 && sh.levels.filter((l) => l.enabled).length === 3 && sh.levels[3].enabled === false);
  sh = await fsvc.showFees(S, { year: 2026, term: 3 });
  check('overview: a term with no fees lists every switched-on class as "All classes" not set', sh.notSet && sh.notSet.label === 'All classes' && sh.sameFees.length === 0, sh.notSet);
  await fsvc.setFees(S, { classIds: [cid('Grade 1')], year: 2026, term: 3, fees: ['Tuition=1000'] });
  sh = await fsvc.showFees(S, { year: 2026, term: 3 });
  check('overview: classes still without fees are named as a range', sh.notSet.label === 'Grade 2\u20133', sh.notSet);
  check('overview: year without term refused (route rule) / default term works', (await fsvc.showFees(S, {})).term.state === 'running');

  // ================= the optional fees overview =================
  reset();
  await fsvc.addOptionalName(S, 'Lunch'); await fsvc.addOptionalName(S, 'Bus'); await fsvc.addOptionalName(S, 'Swimming');
  await fsvc.setFees(S, { classIds: [cid('Grade 1'), cid('Grade 2'), cid('Grade 3')], year: 2026, term: 2, fees: ['Tuition=50000'], optional: ['Lunch=3000'] });
  await fsvc.setFees(S, { classIds: [cid('Grade 3')], year: 2026, term: 2, fees: ['Tuition=50000'], optional: ['Lunch=3500', 'Bus=5000'] });
  addStudent(S, 'A1', 'Grade 1', ['Lunch']); addStudent(S, 'A2', 'Grade 1', ['Lunch']); addStudent(S, 'A3', 'Grade 3', ['Lunch', 'Bus']); addStudent(S, 'A4', 'Grade 3', ['Bus'], 'transferred_out'); addStudent(2, 'B1', 'Grade 1', ['Lunch']);
  let oo = await fsvc.optionalOverview(S, { year: 2026, term: 2 });
  const lunch = oo.names.find((n) => n.name === 'Lunch'), bus = oo.names.find((n) => n.name === 'Bus'), swim = oo.names.find((n) => n.name === 'Swimming');
  check('optional: names listed A-Z', oo.names.map((n) => n.name).join() === 'Bus,Lunch,Swimming');
  check('optional: classes that share a price are ONE range, others split', lunch.offers.length === 2 && lunch.offers[0].label === 'Grade 1\u20132' && lunch.offers[0].amount === 3000 && lunch.offers[1].label === 'Grade 3' && lunch.offers[1].amount === 3500, lunch.offers);
  check('optional: a fee offered by one class says so and names who does not offer it', bus.offers.length === 1 && bus.offers[0].label === 'Grade 3' && bus.notOffered.label === 'Grade 1\u20132', bus);
  check('optional: a fee nobody offers has no offers and "All classes" not offering it', swim.offers.length === 0 && swim.notOffered.label === 'All classes');
  check('optional: students counted per fee (active, this school only)', lunch.students === 3 && bus.students === 1 && swim.students === 0, [lunch.students, bus.students]);
  check('optional: students counted per class', lunch.studentsByClass[cid('Grade 1')] === 2 && lunch.studentsByClass[cid('Grade 3')] === 1);
  check('optional: in use -> not removable, with the reason', lunch.removable === false && lunch.blockedBy.feeLines === 3 && bus.blockedBy.students === 2, [lunch.blockedBy, bus.blockedBy]);
  check('optional: unused name is removable', swim.removable === true && swim.blockedBy === null);
  check('optional: classes list is the switched-on classes only', oo.classes.map((c) => c.name).join() === 'Grade 1,Grade 2,Grade 3');
  st.fees.push({ id: 7001, school_id: S, term_id: 12, class_id: cid('Grade 2'), name: 'Old Fee', amount: 100, is_mandatory: false, version: 1 });
  oo = await fsvc.optionalOverview(S, { year: 2026, term: 2 });
  check('optional: a name in use but missing from the list is shown and flagged', oo.names.find((n) => n.name === 'Old Fee').inList === false && oo.names.find((n) => n.name === 'Old Fee').removable === false);
  st.fees.push({ id: 7002, school_id: S, term_id: 12, class_id: null, name: 'Insurance', amount: 400, is_mandatory: false, version: 1 });
  oo = await fsvc.optionalOverview(S, { year: 2026, term: 2 });
  check('optional: a school-wide price applies to every switched-on class', oo.names.find((n) => n.name === 'Insurance').offers[0].label === 'All classes');

  // ================= history: versions and what changed =================
  reset();
  await fsvc.addOptionalName(S, 'Lunch'); await fsvc.addOptionalName(S, 'Bus');
  await fsvc.setFees(S, { classIds: [cid('Grade 1')], year: 2026, term: 2, fees: ['Tuition=50000'], optional: ['Lunch=3000', 'Bus=5000'] });
  await fsvc.setFees(S, { classIds: [cid('Grade 1')], year: 2026, term: 2, fees: ['Tuition=55000', 'Exam=2000'], optional: ['Lunch=3000', 'Bus=5000'] });
  await fsvc.setFees(S, { classIds: [cid('Grade 1')], year: 2026, term: 2, fees: ['Tuition=55000', 'Exam=2000'], optional: ['Lunch=3000'], allowDrop: true });
  const hh = await fsvc.feeHistory(S, { classId: cid('Grade 1'), year: 2026, term: 2 });
  check('history: three versions, newest first, only the newest is current', hh.versions.map((v) => v.version).join() === '3,2,1' && hh.versions.map((v) => v.current).join() === 'true,false,false', hh.versions.map((v) => v.version));
  check('history: version 3 removed Bus', hh.versions[0].changes.length === 1 && hh.versions[0].changes[0].kind === 'removed' && hh.versions[0].changes[0].name === 'Bus' && hh.versions[0].changes[0].optional === true, hh.versions[0].changes);
  check('history: version 2 changed a price and added a fee', hh.versions[1].changes.some((c) => c.kind === 'price' && c.name === 'Tuition' && c.from === 50000 && c.to === 55000) && hh.versions[1].changes.some((c) => c.kind === 'added' && c.name === 'Exam' && c.to === 2000), hh.versions[1].changes);
  check('history: the first list has no "changes" (it is the start)', hh.versions[2].changes === null);
  check('history: old versions say when they were replaced, the current one does not', hh.versions[1].replacedAt === '2026-02-10 09:00' && hh.versions[0].replacedAt === null);
  check('history: each version carries its own items', hh.versions[2].items.length === 3 && hh.versions[0].items.length === 3 && hh.versions[0].items.some((i) => i.name === 'Exam'));
  const emptyH = await fsvc.feeHistory(S, { classId: cid('Grade 2'), year: 2026, term: 2 });
  check('history: a class with no fees has no versions', emptyH.versions.length === 0);
  check('history: unknown class / bad class refused', await fails(() => fsvc.feeHistory(S, { classId: 999, year: 2026, term: 2 }), 404, /no such class/) && await fails(() => fsvc.feeHistory(S, { classId: NaN, year: 2026, term: 2 }), 400, /Choose a class/));
  check('diff: a fee that becomes mandatory is reported', fsvc.diffItems([{ name: 'Lunch', amount: 1, is_mandatory: false }], [{ name: 'Lunch', amount: 1, is_mandatory: true }])[0].kind === 'now_mandatory');
  check('diff: identical lists have no changes', fsvc.diffItems([{ name: 'A', amount: 1, is_mandatory: true }], [{ name: 'a ', amount: 1, is_mandatory: true }]).length === 0);

  console.log(failed ? `\n${failed} check(s) FAILED.` : '\nAll fee setup and charge-term checks pass.');
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });