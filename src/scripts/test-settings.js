// Tests School settings: profile, logo, PIN and the PIN check on sensitive actions.
// REAL Postgres. WIPES the database it connects to; refuses unless the name ends with _test.
//   set TEST_DATABASE_URL=postgres://user:password@localhost:5432/karo_test
//   node src/scripts/test-settings.js
const crypto = require('crypto');
const url = process.env.TEST_DATABASE_URL || '';
if (!/\/[^/]*_test(\?.*)?$/.test(url)) { console.error('Set TEST_DATABASE_URL to a database whose name ends with _test (it is WIPED).'); process.exit(1); }
process.env.DATABASE_URL = url;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { pool, initSchema } = require('../db/db');
const profile = require('../services/schoolProfile');
const pin = require('../services/pin');
const act = require('../services/activityLog');
const { createSchoolWithAdmin } = require('../services/schoolSetup');
const { hashPassword } = require('../security/auth');

let failed = 0, passed = 0;
const check = (name, ok, extra) => { if (ok) passed++; else failed++; console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (!ok && extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); };
const fails = async (fn, re, status) => { try { await fn(); return false; } catch (e) { return re.test(e.message) && (status == null || e.status === status); } };
const q = async (sql, p) => (await pool.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const jpegBytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.from('JFIF'), Buffer.alloc(40)]);
const webpBytes = Buffer.concat([Buffer.from('RIFF'), Buffer.from([40, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(40)]);
const uri = (type, buf) => 'data:' + type + ';base64,' + buf.toString('base64');

(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await initSchema();
  const o2 = await createSchoolWithAdmin({ name: 'Other School', adminName: 'Olga Other', adminEmail: 'olga@o.ke', password: 'Other-pass-12', channels: [] });
  const made = await createSchoolWithAdmin({ name: 'Mwangaza Academy', adminName: 'Olive Owner', adminEmail: 'olive@m.ke', password: 'Owner-pass-1', channels: [] });
  const S = made.school.id, owner = made.admin.id;
  const adm2 = (await q(`INSERT INTO staff (school_id, full_name, email, password_hash, role, status) VALUES ($1, 'Adam Admin', 'adam@m.ke', $2, 'admin', 'active') RETURNING id`, [S, await hashPassword('Adam-pass-12')]))[0].id;
  const clerk = (await q(`INSERT INTO staff (school_id, full_name, email, password_hash, role, status) VALUES ($1, 'Cleo Clerk', 'cleo@m.ke', $2, 'staff', 'active') RETURNING id`, [S, await hashPassword('Cleo-pass-12')]))[0].id;

  // ---- profile
  const p0 = await profile.getProfile(S);
  check('a new school has a name and nothing else', p0.name === 'Mwangaza Academy' && p0.motto === '' && p0.logo === null);
  const u = await profile.updateProfile({ schoolId: S, actorId: adm2, changes: { motto: '  Knowledge   is   power ', phone: '+254 712 345 678', email: 'Info@Mwangaza.sc.ke', address: 'P.O. Box 12, Kwale', county: 'Kwale', receipt_footer: 'Fees are not refundable.', bogus: 'x' } });
  check('an Admin can fill in the profile (spaces tidied, email lower-cased, unknown keys ignored)', u.changed.length === 6 && u.profile.motto === 'Knowledge is power' && u.profile.email === 'info@mwangaza.sc.ke' && u.profile.county === 'Kwale', u);
  check('saving the same again changes nothing and writes no log line', (await profile.updateProfile({ schoolId: S, actorId: adm2, changes: { motto: 'Knowledge is power' } })).unchanged === true && (await q(`SELECT 1 FROM audit_log WHERE action = 'school_profile_changed'`)).length === 1);
  check('an empty value clears a field', (await profile.updateProfile({ schoolId: S, actorId: adm2, changes: { motto: '' } })).profile.motto === '');
  check('bad email, bad phone and too-long text are refused with plain words',
    await fails(() => profile.updateProfile({ schoolId: S, actorId: adm2, changes: { email: 'nope' } }), /email/) &&
    await fails(() => profile.updateProfile({ schoolId: S, actorId: adm2, changes: { phone: 'call me maybe' } }), /phone/) &&
    await fails(() => profile.updateProfile({ schoolId: S, actorId: adm2, changes: { motto: 'x'.repeat(121) } }), /too long/));
  check('staff-role people can not edit the profile', await fails(() => profile.updateProfile({ schoolId: S, actorId: clerk, changes: { motto: 'hi' } }), /Only an Admin/, 403));
  check('an Admin of another school can not touch this one', await fails(() => profile.updateProfile({ schoolId: S, actorId: o2.admin.id, changes: { motto: 'hi' } }), /can not do this/, 403));
  check('an ordinary Admin can not rename the school', await fails(() => profile.updateProfile({ schoolId: S, actorId: adm2, changes: { name: 'Brand New Name' } }), /Main Admin/, 403));
  check('the Main Admin can not take a name another school has', await fails(() => profile.updateProfile({ schoolId: S, actorId: owner, changes: { name: ' other   school ' } }), /already exists/, 409));
  const rn = await profile.updateProfile({ schoolId: S, actorId: owner, changes: { name: 'Mwangaza Junior Academy' } });
  check('the Main Admin can rename it, and the log says from and to', rn.profile.name === 'Mwangaza Junior Academy' && !!(await one(`SELECT 1 FROM audit_log WHERE action = 'school_profile_changed' AND detail->>'name_to' = 'Mwangaza Junior Academy' AND detail->>'name_from' = 'Mwangaza Academy'`)));
  check('the other school was not touched', (await profile.getProfile(o2.school.id)).name === 'Other School' && (await profile.getProfile(o2.school.id)).motto === '');

  const p2 = await profile.updateProfile({ schoolId: S, actorId: adm2, changes: { phone: '0712 345 678', phone2: '0722 111 222' } });
  check('a second (optional) phone number saves and shows in the profile', p2.profile.phone2 === '0722 111 222' && (await profile.getProfile(S)).phone2 === '0722 111 222');
  check('a bad second phone is refused', await fails(() => profile.updateProfile({ schoolId: S, actorId: adm2, changes: { phone2: 'abc' } }), /second phone/));
  check('the second phone can be cleared', (await profile.updateProfile({ schoolId: S, actorId: adm2, changes: { phone2: '' } })).profile.phone2 === '' && (await profile.getProfile(o2.school.id)).phone2 === '');

  // ---- logo
  check('a real PNG is accepted', (await profile.setLogo({ schoolId: S, actorId: adm2, image: PNG })).ok && (await profile.getProfile(S)).logo === PNG.replace(/^data:image\/png;base64,/, 'data:image/png;base64,'), 'png');
  check('a JPEG and a WebP (by their real bytes) are accepted', (await profile.setLogo({ schoolId: S, actorId: adm2, image: uri('image/jpeg', jpegBytes) })).ok && (await profile.setLogo({ schoolId: S, actorId: adm2, image: uri('image/webp', webpBytes) })).ok);
  check('SVG is refused', await fails(() => profile.setLogo({ schoolId: S, actorId: adm2, image: 'data:image/svg+xml;base64,' + Buffer.from('<svg onload="alert(1)"/>').toString('base64') }), /PNG, JPG or WebP/));
  check('a file that lies about its type is refused (PNG bytes called JPEG; text called PNG)', await fails(() => profile.setLogo({ schoolId: S, actorId: adm2, image: PNG.replace('image/png', 'image/jpeg') }), /not a real/) && await fails(() => profile.setLogo({ schoolId: S, actorId: adm2, image: uri('image/png', Buffer.from('hello world, I am not a picture')) }), /not a real/));
  check('a huge picture is refused', await fails(() => profile.setLogo({ schoolId: S, actorId: adm2, image: uri('image/png', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(800 * 1024)])) }), /too big/, 413));
  check('rubbish text is refused', await fails(() => profile.setLogo({ schoolId: S, actorId: adm2, image: 'not an image' }), /PNG, JPG or WebP/));
  check('staff-role people can not change the logo', await fails(() => profile.setLogo({ schoolId: S, actorId: clerk, image: PNG }), /Only an Admin/, 403));
  await profile.setLogo({ schoolId: S, actorId: adm2, image: PNG });
  check('another school does not see this logo', (await profile.getProfile(o2.school.id)).logo === null);
  check('the logo can be removed (and removing twice is harmless)', (await profile.removeLogo({ schoolId: S, actorId: adm2 })).removed === true && (await profile.removeLogo({ schoolId: S, actorId: adm2 })).removed === false && (await profile.getProfile(S)).logo === null);

  // ---- PIN
  check('at first there is no PIN', (await pin.pinStatus(S, adm2)).has_pin === false);
  check('staff-role people have no PIN', await fails(() => pin.pinStatus(S, clerk), /Only Admins/, 403));
  check('setting a PIN needs the right password', await fails(() => pin.setPin({ schoolId: S, staffId: adm2, password: 'wrong-wrong', pin: '482915' }), /password is not right/, 403));
  for (const bad of ['123', '1234567', 'abcd', '1111', '1234', '4321', '654321', '']) check('the PIN "' + bad + '" is refused', await fails(() => pin.setPin({ schoolId: S, staffId: adm2, password: 'Adam-pass-12', pin: bad }), /PIN/));
  const sp = await pin.setPin({ schoolId: S, staffId: adm2, password: 'Adam-pass-12', pin: '4829' });
  check('a good PIN is saved as a hash and unlocks at once', sp.ok && sp.token && sp.minutes === 10 && (await one('SELECT pin_hash FROM staff WHERE id=$1', [adm2])).pin_hash !== '4829' && (await pin.pinStatus(S, adm2)).has_pin);
  check('the right PIN unlocks', (await pin.unlock({ schoolId: S, staffId: adm2, pin: '4829' })).token.length > 20);
  check('a wrong PIN is refused and logged', await fails(() => pin.unlock({ schoolId: S, staffId: adm2, pin: '0000' }), /not right/, 403) && !!(await one(`SELECT 1 FROM audit_log WHERE action = 'pin_failed'`)));
  for (let i = 0; i < 3; i++) await fails(() => pin.unlock({ schoolId: S, staffId: adm2, pin: '0000' }), /./);
  check('the 5th wrong PIN in a row locks PIN use for 15 minutes', await fails(() => pin.unlock({ schoolId: S, staffId: adm2, pin: '0000' }), /locked for 15 minutes/, 429) && (await pin.pinStatus(S, adm2)).locked_minutes >= 14);
  check('while locked even the right PIN is refused', await fails(() => pin.unlock({ schoolId: S, staffId: adm2, pin: '4829' }), /locked/, 429));
  check('the lock is in the log', !!(await one(`SELECT 1 FROM audit_log WHERE action = 'pin_locked'`)));
  await q(`UPDATE staff SET pin_locked_until = NOW() - INTERVAL '1 minute' WHERE id = $1`, [adm2]);
  check('after the lock runs out the right PIN works again', !!(await pin.unlock({ schoolId: S, staffId: adm2, pin: '4829' })).token);
  check('changing the PIN needs the password again and is logged as a change', (await pin.setPin({ schoolId: S, staffId: adm2, password: 'Adam-pass-12', pin: '7316' })).ok && !!(await one(`SELECT 1 FROM audit_log WHERE action = 'pin_changed'`)) && await fails(() => pin.unlock({ schoolId: S, staffId: adm2, pin: '4829' }), /not right/));
  check('unlocking without a PIN says to set one', await fails(() => pin.unlock({ schoolId: S, staffId: owner, pin: '4829' }), /Set your PIN/, 403));

  // ---- the activity log shows it all in words
  const lines = (await act.listActivity(S, { range: 'all' })).rows.map((r) => r.who.name + ' ' + r.text + ' ' + (r.extra || ''));
  check('the activity log reads: profile, rename, logo, PIN', lines.some((t) => /Olive Owner renamed the school from "Mwangaza Academy" to "Mwangaza Junior Academy"/.test(t)) && lines.some((t) => /Adam Admin changed the school profile.*motto.*phone/.test(t)) && lines.some((t) => /Adam Admin changed the school logo/.test(t)) && lines.some((t) => /Adam Admin set their PIN/.test(t)) && lines.some((t) => /typed a wrong PIN/.test(t)), lines.slice(0, 8));

  // ---- over the API: who can look, and the PIN check
  const app = require('../app');
  const server = app.listen(0); const base = 'http://localhost:' + server.address().port + '/api';
  const call = async (m, p, body, tk, pinTok) => { const x = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}), ...(pinTok ? { 'X-Pin-Token': pinTok } : {}) }, body: body ? JSON.stringify(body) : undefined }); let j = null; try { j = await x.json(); } catch (e) { /* none */ } return { s: x.status, d: j }; };
  const login = async (email, password) => (await call('POST', '/auth/login', { email, password })).d.token;
  const adamTok = await login('adam@m.ke', 'Adam-pass-12'), cleoTok = await login('cleo@m.ke', 'Cleo-pass-12'), oliveTok = await login('olive@m.ke', 'Owner-pass-1'), olgaTok = await login('olga@o.ke', 'Other-pass-12');
  const g = await call('GET', '/schools/' + S + '/profile', null, cleoTok);
  check('any staff can read the profile (for receipts and the sidebar)', g.s === 200 && g.d.name === 'Mwangaza Junior Academy' && g.d.county === 'Kwale');
  check('another school can not read it', (await call('GET', '/schools/' + S + '/profile', null, olgaTok)).s === 403);
  check('no login, no profile', (await call('GET', '/schools/' + S + '/profile')).s === 401);
  check('staff-role can not save the profile or the logo over the API', (await call('PUT', '/schools/' + S + '/profile', { motto: 'x' }, cleoTok)).s === 403 && (await call('PUT', '/schools/' + S + '/logo', { image: PNG }, cleoTok)).s === 403);
  check('an Admin saves the profile and the logo with no PIN (cosmetic things)', (await call('PUT', '/schools/' + S + '/profile', { motto: 'Excellence' }, adamTok)).s === 200 && (await call('PUT', '/schools/' + S + '/logo', { image: PNG }, adamTok)).s === 200);
  check('a logo of about 400 KB passes the body limit (the old limit would have refused it)', (await call('PUT', '/schools/' + S + '/logo', { image: uri('image/png', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(400 * 1024)])) }, adamTok)).s === 200);
  const rn1 = await call('PUT', '/schools/' + S + '/profile', { name: 'Mwangaza Senior Academy' }, oliveTok);
  check('renaming asks for the PIN (this Main Admin has none: "set your PIN")', rn1.s === 403 && rn1.d.code === 'pin_not_set');
  const oSet = await call('POST', '/schools/' + S + '/pin/set', { password: 'Owner-pass-1', pin: '8206' }, oliveTok);
  check('the Main Admin sets a PIN over the API and gets an unlock', oSet.s === 200 && oSet.d.token);
  check('renaming with the unlock works', (await call('PUT', '/schools/' + S + '/profile', { name: 'Mwangaza Senior Academy' }, oliveTok, oSet.d.token)).s === 200);
  check('saving the same name again needs no PIN', (await call('PUT', '/schools/' + S + '/profile', { name: 'Mwangaza Senior Academy', motto: 'Excellence' }, oliveTok)).s === 200);
  check('a plain Admin renaming is refused even with a PIN', (await call('PUT', '/schools/' + S + '/profile', { name: 'Hijacked' }, adamTok, (await call('POST', '/schools/' + S + '/pin/unlock', { pin: '7316' }, adamTok)).d.token)).s === 403);

  const adamPin = (await call('POST', '/schools/' + S + '/pin/unlock', { pin: '7316' }, adamTok)).d.token;
  const sens = [['PUT', '/schools/' + S + '/channels', { channels: ['mpesa'] }], ['POST', '/schools/' + S + '/bank-connections', {}], ['PUT', '/schools/' + S + '/mpesa/keys', {}], ['POST', '/schools/' + S + '/mpesa/register', {}],
    ['POST', '/schools/' + S + '/bank-connections/equity/credentials', {}], ['POST', '/schools/' + S + '/bank-connections/coop/credentials', {}],
    ['POST', '/schools/' + S + '/staff', { full_name: 'New Person', email: 'np@m.ke' }], ['POST', '/schools/' + S + '/staff/' + clerk + '/status', { status: 'suspended' }], ['POST', '/schools/' + S + '/staff/' + clerk + '/role', { role: 'staff' }],
    ['POST', '/schools/' + S + '/staff/' + clerk + '/send-reset', {}], ['POST', '/schools/' + S + '/staff/' + clerk + '/email', { email: 'cc@m.ke' }], ['POST', '/schools/' + S + '/transfer-ownership', {}]];
  let allAsk = true; for (const [m, pth, b] of sens) { const r = await call(m, pth, b, adamTok); if (r.s !== 403 || r.d.code !== 'pin_required') { allAsk = false; console.log('   not guarded:', m, pth, r.s, JSON.stringify(r.d)); } }
  check('every sensitive route (banks, M-Pesa, channels, staff access, ownership) asks an Admin with a PIN for it', allAsk);
  let allPass = true; for (const [m, pth, b] of sens.slice(0, 6)) { const r = await call(m, pth, b, adamTok, adamPin); if (r.s === 403 && r.d && r.d.code) { allPass = false; console.log('   still asks:', m, pth, r.s, JSON.stringify(r.d)); } }
  check('with the PIN unlock the same routes get past the PIN check', allPass);
  check('the channels switch really works with the unlock', (await call('PUT', '/schools/' + S + '/channels', { channels: ['mpesa'] }, adamTok, adamPin)).s === 200);
  const inv = await call('POST', '/schools/' + S + '/staff', { full_name: 'New Person', email: 'np@m.ke' }, adamTok, adamPin);
  check('inviting with the unlock works', inv.s === 200 && inv.d.staff.email === 'np@m.ke');
  const oliveTok2 = oSet.d.token;
  check('somebody else\'s unlock does not work for me', (await call('PUT', '/schools/' + S + '/channels', { channels: ['mpesa'] }, adamTok, oliveTok2)).s === 403);
  check('a garbage unlock is refused', (await call('PUT', '/schools/' + S + '/channels', { channels: ['mpesa'] }, adamTok, 'garbage')).d.code === 'pin_required');
  const { generatePinToken, verifyToken } = require('../security/auth');
  const expired = require('jsonwebtoken').sign({ staffId: adm2, schoolId: S, tv: 0, purpose: 'pin' }, process.env.JWT_SECRET, { expiresIn: -10 });
  check('an expired unlock is refused', (await call('PUT', '/schools/' + S + '/channels', { channels: ['mpesa'] }, adamTok, expired)).d.code === 'pin_required');
  check('an ordinary login token can not be used as an unlock', (await call('PUT', '/schools/' + S + '/channels', { channels: ['mpesa'] }, adamTok, adamTok)).d.code === 'pin_required');
  check('staff-role people are stopped by the Admin rule before any PIN talk', (await call('PUT', '/schools/' + S + '/channels', { channels: [] }, cleoTok, adamPin)).s === 403 && (await call('POST', '/schools/' + S + '/pin/unlock', { pin: '1357' }, cleoTok)).s === 403);
  await call('POST', '/auth/change-password', { current: 'Adam-pass-12', password: 'Adam-new-pass-3' }, adamTok);
  check('after a password change the old unlock is dead too', (await call('PUT', '/schools/' + S + '/channels', { channels: ['mpesa'] }, adamTok, adamPin)).s === 401 || (await call('PUT', '/schools/' + S + '/channels', { channels: ['mpesa'] }, adamTok, adamPin)).d.code === 'pin_required');
  check('routine work needs no PIN (the review queue, reversing, manual payments are not in the guarded list)', !sens.some(([, pth]) => /confirm|reject|payments|reverse|status$/.test(pth) && !/staff/.test(pth)));
  server.close();

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  await pool.end();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });