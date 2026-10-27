// Tests the school sign-up engine (src/services/schoolSetup.js) without a real database.
// The pretend database can UNDO work (ROLLBACK), so "all or nothing" is really tested.
// Run:  node src/scripts/test-school-setup.js
const crypto = require('crypto');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

let failed = 0;
const check = (name, ok, extra) => { if (!ok) failed++; console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (!ok && extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); };
const rejects = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

// ---- a pretend database with transactions ----
const st = { schools: [], staff: [], channels: [], log: [], nextId: 1, released: 0, snap: null, failStaffInsert: null };
const snapshot = () => JSON.stringify({ schools: st.schools, staff: st.staff, channels: st.channels });
const restore = (s) => { const o = JSON.parse(s); st.schools = o.schools; st.staff = o.staff; st.channels = o.channels; };
const query = async (sql, params = []) => {
  const q = sql.replace(/\s+/g, ' ').trim();
  if (/^BEGIN/.test(q)) { st.log.push('BEGIN'); st.snap = snapshot(); return { rows: [] }; }
  if (/^COMMIT/.test(q)) { st.log.push('COMMIT'); st.snap = null; return { rows: [] }; }
  if (/^ROLLBACK/.test(q)) { st.log.push('ROLLBACK'); if (st.snap) restore(st.snap); st.snap = null; return { rows: [] }; }
  if (/pg_advisory_xact_lock/.test(q)) { st.log.push('LOCK'); return { rows: [] }; }
  if (/FROM schools WHERE lower\(btrim\(name\)\) = lower\(\$1\)/.test(q)) return { rows: st.schools.some((s) => s.name.trim().toLowerCase() === String(params[0]).toLowerCase()) ? [{}] : [] };
  if (/FROM staff WHERE lower\(email\) = \$1 AND school_id <> \$2/.test(q)) return { rows: st.staff.some((x) => x.email.toLowerCase() === params[0] && x.school_id !== params[1]) ? [{}] : [] };
  if (/FROM staff WHERE lower\(email\) = \$1/.test(q)) return { rows: st.staff.some((x) => x.email.toLowerCase() === params[0]) ? [{}] : [] };
  if (/^INSERT INTO schools/.test(q)) { const row = { id: st.nextId++, name: params[0] }; st.schools.push(row); st.log.push('INSERT school'); return { rows: [row] }; }
  if (/^INSERT INTO staff/.test(q)) {
    if (st.failStaffInsert) { const e = new Error(st.failStaffInsert.message); e.code = st.failStaffInsert.code; throw e; }
    const row = { id: st.nextId++, school_id: params[0], full_name: params[1], email: params[2], password_hash: params[3], role: 'admin' };
    st.staff.push(row); st.log.push('INSERT staff');
    return { rows: [{ id: row.id, full_name: row.full_name, email: row.email, role: 'admin' }] };
  }
  if (/INSERT INTO school_channels/.test(q)) { params[1].forEach((c) => st.channels.push({ school_id: params[0], channel: c })); st.log.push('INSERT channels'); return { rows: [] }; }
  if (/^INSERT INTO audit_log/.test(q)) { st.log.push({ audit: params }); return { rows: [] }; }
  return { rows: [] };
};
const pool = { query, connect: async () => ({ query, release: () => { st.released++; } }) };
require.cache[require.resolve('../db/db')] = { id: require.resolve('../db/db'), filename: require.resolve('../db/db'), loaded: true, exports: { pool, initSchema: async () => {} } };
const svc = require('../services/schoolSetup');
const reset = () => { st.schools = []; st.staff = []; st.channels = []; st.log = []; st.nextId = 1; st.released = 0; st.snap = null; st.failStaffInsert = null; };
const good = { name: 'Mwangaza Girls High', adminName: 'Jane Wanjiru', adminEmail: 'Jane@Mwangaza.sc.ke' };
const auditActions = () => st.log.filter((x) => x.audit).map((x) => x.audit[2]);

(async () => {
  // ================= the generated password =================
  const pws = Array.from({ length: 300 }, () => svc.generatePassword());
  check('a generated password is 16 characters', pws.every((p) => p.length === 16));
  check('it never contains look-alike characters (0 O 1 l I) so it can be read out over the phone', pws.every((p) => !/[0O1lI]/.test(p)));
  check('every one is different (random)', new Set(pws).size === 300);
  check('it uses capitals, small letters AND digits across samples', /[A-Z]/.test(pws.join('')) && /[a-z]/.test(pws.join('')) && /[2-9]/.test(pws.join('')));

  // ================= checking what was typed =================
  const bad = (over, re) => { try { svc.validateNewSchool({ ...good, ...over }); return false; } catch (e) { return e.status === 400 && re.test(e.message); } };
  check('school name too short -> 400', bad({ name: 'ab' }, /3 to 100/));
  check('school name too long -> 400', bad({ name: 'x'.repeat(101) }, /3 to 100/));
  check('school name with control characters -> 400', bad({ name: 'Bad\u0007Name School' }, /3 to 100/));
  check('Admin name too short -> 400', bad({ adminName: 'J' }, /2 to 100/));
  for (const e of ['', 'not-an-email', 'a@b', 'a b@c.com', '@x.com']) check(`bad email "${e}" -> 400`, bad({ adminEmail: e }, /valid email/));
  check('a chosen password under 10 characters -> 400', bad({ password: 'short' }, /at least 10/));
  check('unknown channel -> 400 naming the allowed ones', bad({ channels: ['mpesa', 'visa'] }, /Unknown channel: visa.*mpesa, kcb, equity, coop/));
  const v = svc.validateNewSchool({ ...good, name: '  Mwangaza   Girls  High ', channels: ['MPESA', 'equity', 'mpesa', ''] });
  check('extra spaces are tidied, the email is lower-cased, channels are cleaned and de-duplicated', v.name === 'Mwangaza Girls High' && v.adminEmail === 'jane@mwangaza.sc.ke' && v.channels.join() === 'mpesa,equity', v);

  // ================= a dry run =================
  reset(); let r = await svc.createSchoolWithAdmin({ ...good, dry: true }, { pool });
  check('DRY RUN: says it would work, creates nothing (no school, no Admin, no transaction)', r.dry === true && r.password === null && !st.schools.length && !st.staff.length && !st.log.includes('BEGIN'));

  // ================= the real thing =================
  reset(); r = await svc.createSchoolWithAdmin({ ...good, channels: ['mpesa', 'equity'] }, { pool });
  check('creates the school and its first Admin', r.dry === false && r.school.id && r.admin.role === 'admin' && st.schools.length === 1 && st.staff.length === 1);
  check('the steps ran in a safe order: BEGIN, line up, school, Admin, channels, COMMIT', st.log.slice(0, 6).join() === 'BEGIN,LOCK,INSERT school,INSERT staff,INSERT channels,COMMIT', st.log);
  check('the Admin is linked to the new school and its email is stored in lower case', st.staff[0].school_id === r.school.id && st.staff[0].email === 'jane@mwangaza.sc.ke');
  check('a password was generated and returned ONCE', typeof r.password === 'string' && r.password.length === 16);
  check('the password is NOT stored: only a scrambled copy that is not the password', st.staff[0].password_hash && st.staff[0].password_hash !== r.password && !JSON.stringify(st).includes(r.password));
  check('the scrambled copy really matches the password', await require('../security/auth').verifyPassword(r.password, st.staff[0].password_hash));
  check('the chosen channels were switched on', st.channels.map((c) => c.channel).join() === 'mpesa,equity' && st.channels.every((c) => c.school_id === r.school.id));
  check('the connection was given back', st.released === 1);
  check('a "school_created" audit entry was written AFTER the commit, with no password in it', auditActions().join() === 'school_created' && st.log.indexOf('COMMIT') < st.log.findIndex((x) => x.audit) && !JSON.stringify(st.log.filter((x) => x.audit)).includes(r.password));

  // you choose the password yourself
  reset(); r = await svc.createSchoolWithAdmin({ ...good, password: 'my-chosen-password-1' }, { pool });
  check('a chosen password is used and NOT returned (so it is never printed)', r.password === null && await require('../security/auth').verifyPassword('my-chosen-password-1', st.staff[0].password_hash));
  reset(); r = await svc.createSchoolWithAdmin(good, { pool });
  check('no channels given -> none switched on, and no channel write at all', st.channels.length === 0 && !st.log.includes('INSERT channels'));

  // ================= duplicates are refused, with nothing left behind =================
  reset(); await svc.createSchoolWithAdmin(good, { pool }); st.log.length = 0; st.released = 0;
  let e = await rejects(() => svc.createSchoolWithAdmin({ ...good, adminEmail: 'someone.else@x.com', name: '  mwangaza girls HIGH ' }, { pool }));
  check('same school name (any capitals / spaces) -> 409 and rolled back', e && e.status === 409 && /school with this name already exists/.test(e.message) && st.schools.length === 1 && st.log.includes('ROLLBACK') && !st.log.includes('INSERT school'), e && e.message);
  check('...and the connection was still given back', st.released === 1);
  st.log.length = 0;
  e = await rejects(() => svc.createSchoolWithAdmin({ ...good, name: 'A Completely Different School', adminEmail: 'JANE@mwangaza.SC.ke' }, { pool }));
  check('an email already used in ANOTHER school (even in other capitals) -> 409 and nothing created', e && e.status === 409 && /already used by another account/.test(e.message) && st.schools.length === 1 && st.staff.length === 1 && !st.log.includes('INSERT school'), e && e.message);
  e = await rejects(() => svc.createSchoolWithAdmin({ ...good, name: 'Another One', adminEmail: 'jane@mwangaza.sc.ke', dry: true }, { pool }));
  check('a DRY RUN also reports duplicates', e && e.status === 409);

  // ================= all or nothing =================
  reset(); st.failStaffInsert = { code: '23505', message: 'duplicate key value violates unique constraint "uniq_staff_email_ci"' };
  e = await rejects(() => svc.createSchoolWithAdmin(good, { pool }));
  check('someone took the email at the very same instant (database says duplicate) -> a clear 409', e && e.status === 409 && /already used by another account/.test(e.message), e && e.message);
  check('...the school made a moment earlier is UNDONE (no orphan school)', st.schools.length === 0 && st.staff.length === 0 && st.log.includes('ROLLBACK') && !st.log.includes('COMMIT'), { schools: st.schools, log: st.log });
  check('...and nothing is written to the audit log for a creation that did not happen', auditActions().length === 0 && st.released === 1);
  reset(); st.failStaffInsert = { code: 'XX000', message: 'the database fell over' };
  e = await rejects(() => svc.createSchoolWithAdmin({ ...good, channels: ['mpesa'] }, { pool }));
  check('any other failure -> the error is passed up, everything undone, connection given back', e && /fell over/.test(e.message) && st.schools.length === 0 && st.channels.length === 0 && st.log.includes('ROLLBACK') && st.released === 1);

  // ================= the email helper (also used by create-admin and the add-staff route) =================
  reset(); await svc.createSchoolWithAdmin(good, { pool });
  check('emailTakenElsewhere: true for another school, false for the school itself, false for a new email', await svc.emailTakenElsewhere('jane@mwangaza.sc.ke', 99, pool) === true && await svc.emailTakenElsewhere('jane@mwangaza.sc.ke', 1, pool) === false && await svc.emailTakenElsewhere('new@x.com', 1, pool) === false);

  console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nAll school sign-up checks pass.');
  process.exit(failed ? 1 : 0);
})();