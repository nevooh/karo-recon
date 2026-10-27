// Tests the owner console over HTTP. REAL Postgres, WIPES the *_test database.
const crypto = require('crypto');
const url = process.env.TEST_DATABASE_URL || '';
if (!/\/[^/]*_test(\?.*)?$/.test(url)) { console.error('Set TEST_DATABASE_URL to a database ending in _test (it is WIPED).'); process.exit(1); }
process.env.DATABASE_URL = url; process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex'); process.env.NODE_ENV = 'test';
const { pool, initSchema } = require('../db/db');
const { createOwner } = require('../services/ownerConsole');
const { generateParentToken, generateToken } = require('../security/auth');
let pass = 0, fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };
(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await initSchema();
  const app = require('../app'); const srv = app.listen(0); const base = 'http://127.0.0.1:' + srv.address().port;
  const call = async (m, p, body, tok) => { const r = await fetch(base + '/api/owner' + p, { method: m, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { s: r.status, j: await r.json().catch(() => ({})) }; };
  await createOwner({ email: 'Owner@Zuvy.co', fullName: 'Dray', password: 'long-owner-pass-1' });
  check('no token refused', (await call('GET', '/schools')).s === 401);
  check('parent token refused', (await call('GET', '/schools', null, generateParentToken({ phone: '254712345678' }))).s === 401);
  check('staff token refused', (await call('GET', '/schools', null, generateToken({ staffId: 1, schoolId: 1 }))).s === 401);
  check('wrong password', (await call('POST', '/login', { email: 'owner@zuvy.co', password: 'nope' })).s === 401);
  const l = await call('POST', '/login', { email: 'owner@zuvy.co', password: 'long-owner-pass-1' });
  check('login ok', l.s === 200 && l.j.token); const t = l.j.token;
  check('empty list', (await call('GET', '/schools', null, t)).j.total_schools === 0);
  const a = await call('POST', '/schools', { name: 'Mwangaza Girls', adminName: 'Jane Wanjiru', adminEmail: 'jane@mwangaza.sc.ke' }, t);
  check('school added + password shown', a.s === 201 && a.j.password && a.j.password.length === 16);
  check('duplicate name 409', (await call('POST', '/schools', { name: 'mwangaza girls', adminName: 'X Y', adminEmail: 'x@y.com' }, t)).s === 409);
  check('duplicate email 409', (await call('POST', '/schools', { name: 'Other School', adminName: 'X Y', adminEmail: 'jane@mwangaza.sc.ke' }, t)).s === 409);
  check('bad email 400', (await call('POST', '/schools', { name: 'Other School', adminName: 'X Y', adminEmail: 'nope' }, t)).s === 400);
  const sid = a.j.school.id;
  for (const [adm, st] of [['1', 'active'], ['2', 'repeating'], ['3', 'graduated']])
    await pool.query(`INSERT INTO students (school_id, admission_no, full_name, status) VALUES ($1,$2,$3,$4)`, [sid, adm, 'Kid ' + adm, st]);
  const lst = await call('GET', '/schools', null, t);
  check('count in-school students only', lst.j.schools[0].students === 2 && lst.j.total_students === 2);
  check('main admin shown', lst.j.schools[0].admin_email === 'jane@mwangaza.sc.ke');
  const staffLogin = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'jane@mwangaza.sc.ke', password: a.j.password }) });
  check('new admin can log in', staffLogin.status === 200);
  for (let i = 0; i < 5; i++) await call('POST', '/login', { email: 'lock@zuvy.co', password: 'x' });
  check('lockout after 5', (await call('POST', '/login', { email: 'lock@zuvy.co', password: 'x' })).s === 429);
  console.log(`${pass} passed, ${fail} failed`); srv.close(); await pool.end(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });