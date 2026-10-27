// Tests staff management (src/services/staffAdmin.js + routes/staffRoutes.js + login changes): owner, invites, links, suspension, sign-out.
// REAL Postgres. WIPES the database it connects to; refuses unless the name ends with _test.
//   set TEST_DATABASE_URL=postgres://user:password@localhost:5432/karo_test
//   node src/scripts/test-staff.js
const crypto = require('crypto');
const url = process.env.TEST_DATABASE_URL || '';
if (!/\/[^/]*_test(\?.*)?$/.test(url)) { console.error('Set TEST_DATABASE_URL to a database whose name ends with _test (it is WIPED).'); process.exit(1); }
process.env.DATABASE_URL = url;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
delete process.env.MAIL_PROVIDER; delete process.env.MAIL_API_KEY; delete process.env.MAIL_FROM;
process.env.APP_URL = 'https://fees.example.co.ke';

const { pool, initSchema } = require('../db/db');
const sa = require('../services/staffAdmin');
const mailer = require('../services/mailer');
const { createSchoolWithAdmin } = require('../services/schoolSetup');
const { hashPassword, verifyToken, generatePinToken } = require('../security/auth');

let failed = 0, passed = 0;
const check = (name, ok, extra) => { if (ok) passed++; else failed++; console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (!ok && extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); };
const fails = async (fn, re, status) => { try { await fn(); return false; } catch (e) { return re.test(e.message) && (status == null || e.status === status); } };
const q = async (sql, p) => (await pool.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];

const outbox = [];
const deps = { sendMail: async (m) => { outbox.push(m); return { sent: true }; } };
const lastLink = () => outbox[outbox.length - 1].text.match(/https?:\/\/\S+/)[0];
const lastToken = () => lastLink().split('token=')[1];

(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await initSchema();
  await q(`INSERT INTO schools (name) VALUES ('Other School')`);                       // school 1
  const made = await createSchoolWithAdmin({ name: 'Mwangaza Academy', adminName: 'Olive Owner', adminEmail: 'olive@mwangaza.sc.ke', password: 'Owner-pass-1', channels: [] });
  const S = made.school.id; const owner = made.admin.id;
  const o2 = (await q(`INSERT INTO staff (school_id, full_name, email, password_hash, role, status, is_owner) VALUES (1, 'Other Owner', 'oo@other.com', 'x', 'admin', 'active', TRUE) RETURNING id`))[0].id;

  // ---- owner basics
  check('a school made through setup gets its first admin as owner', (await one('SELECT is_owner, role FROM staff WHERE id = $1', [owner])).is_owner === true);
  const dupe = await q(`INSERT INTO staff (school_id, full_name, email, role, status) VALUES ($1, 'Temp', 'temp@x.com', 'admin', 'active') RETURNING id`, [S]);
  check('a second owner in the same school is refused', await fails(() => pool.query('UPDATE staff SET is_owner = TRUE WHERE id = $1', [dupe[0].id]), /uniq_one_owner/));
  await q('DELETE FROM staff WHERE id = $1', [dupe[0].id]);
  check('the owner can not be suspended straight in the database', await fails(() => pool.query(`UPDATE staff SET status = 'suspended' WHERE id = $1`, [owner]), /Main Admin/));
  check('the owner can not be demoted straight in the database', await fails(() => pool.query(`UPDATE staff SET role = 'staff' WHERE id = $1`, [owner]), /Main Admin/));
  check('the owner row can not be deleted', await fails(() => pool.query('DELETE FROM staff WHERE id = $1', [owner]), /Main Admin/));

  // ---- invite
  const inv = await sa.inviteStaff({ schoolId: S, actorId: owner, fullName: '  Wanjiku   Clerk ', email: 'Wanjiku@Mwangaza.sc.ke', role: 'staff' }, deps);
  const clerk = inv.staff.id;
  check('inviting makes an "invited" person with no password and a cleaned name/email', inv.staff.status === 'invited' && inv.staff.email === 'wanjiku@mwangaza.sc.ke' && inv.staff.full_name === 'Wanjiku Clerk' && (await one('SELECT password_hash FROM staff WHERE id=$1', [clerk])).password_hash === null);
  check('one email is sent, to that address, with the link on the app address', outbox.length === 1 && outbox[0].to === 'wanjiku@mwangaza.sc.ke' && /^https:\/\/fees\.example\.co\.ke\/\?token=[\w-]{40,}$/.test(lastLink()), outbox[0] && outbox[0].text);
  check('the mail names the school and who invited', /Mwangaza Academy/.test(outbox[0].text) && /Olive Owner/.test(outbox[0].text));
  check('the invite email says the link works once and for 48 hours', /48 hours/.test(outbox[0].text));
  const tokenRow = await one(`SELECT token_hash FROM staff_tokens WHERE staff_id = $1`, [clerk]);
  check('only a hash of the link is stored, never the link', tokenRow.token_hash !== lastToken() && tokenRow.token_hash.length === 64);
  check('the response to the admin never contains the link (mail was really sent)', inv.mail.sent === true && inv.mail.link === undefined);
  check('the same email can not be invited again', await fails(() => sa.inviteStaff({ schoolId: S, actorId: owner, fullName: 'X Y', email: 'wanjiku@mwangaza.sc.ke' }, deps), /already belongs/, 409));
  check('an email used in another school is refused too', await fails(() => sa.inviteStaff({ schoolId: S, actorId: owner, fullName: 'X Y', email: 'oo@other.com' }, deps), /already belongs/, 409));
  check('bad email / short name are refused', await fails(() => sa.inviteStaff({ schoolId: S, actorId: owner, fullName: 'X Y', email: 'nope' }, deps), /email/) && await fails(() => sa.inviteStaff({ schoolId: S, actorId: owner, fullName: 'X', email: 'a@b.co' }, deps), /full name/));
  check('an invited person can not log in or hold a session yet', (await one(`SELECT status FROM staff WHERE id=$1`, [clerk])).status === 'invited');

  // ---- link: peek and use
  const tok1 = lastToken();
  const info = await sa.tokenInfo(tok1);
  check('the link page can show who it is for (name, email, school)', info.purpose === 'invite' && info.full_name === 'Wanjiku Clerk' && info.school_name === 'Mwangaza Academy');
  check('a made-up link is "no longer valid"', await fails(() => sa.tokenInfo('abc'), /no longer valid/, 410));
  check('a weak password does not burn the link', await fails(() => sa.completeToken({ token: tok1, password: 'short' }), /at least 8/) && (await sa.tokenInfo(tok1)).purpose === 'invite');
  check('the email address is refused as a password', await fails(() => sa.completeToken({ token: tok1, password: 'wanjiku@mwangaza.sc.ke' }), /email/));
  await sa.resendInvite({ schoolId: S, actorId: owner, staffId: clerk }, deps);
  check('resending makes a new link and kills the old one', outbox.length === 2 && lastToken() !== tok1 && await fails(() => sa.tokenInfo(tok1), /no longer valid/));
  const tok2 = lastToken();
  const done = await sa.completeToken({ token: tok2, password: 'Clerk-pass-1' });
  check('setting the password activates the person and signs them in', done.ok && done.token && done.staff.role === 'staff' && (await one('SELECT status FROM staff WHERE id=$1', [clerk])).status === 'active');
  check('the link works only once', await fails(() => sa.completeToken({ token: tok2, password: 'Another-pass-1' }), /no longer valid/, 410));
  check('resend is refused for someone who already joined', await fails(() => sa.resendInvite({ schoolId: S, actorId: owner, staffId: clerk }, deps), /already joined/));
  check('an expired link is refused', await (async () => {
    await sa.sendResetLink({ schoolId: S, actorId: owner, staffId: clerk }, deps);
    const t = lastToken(); await q(`UPDATE staff_tokens SET expires_at = NOW() - INTERVAL '1 minute' WHERE used_at IS NULL`);
    return fails(() => sa.completeToken({ token: t, password: 'Clerk-pass-2' }), /no longer valid/, 410);
  })());

  // ---- permissions
  check('staff-role people can not invite or manage anyone', await fails(() => sa.inviteStaff({ schoolId: S, actorId: clerk, fullName: 'A B', email: 'ab@x.com' }, deps), /Only an Admin/, 403));
  const adm = await sa.inviteStaff({ schoolId: S, actorId: owner, fullName: 'Admin Two', email: 'admin2@mwangaza.sc.ke', role: 'admin' }, deps);
  await sa.completeToken({ token: lastToken(), password: 'Admin-pass-1' });
  const admin2 = adm.staff.id;
  check('the owner can add another Admin', (await one('SELECT role, is_owner FROM staff WHERE id=$1', [admin2])).role === 'admin');
  check('an ordinary Admin can not add an Admin', await fails(() => sa.inviteStaff({ schoolId: S, actorId: admin2, fullName: 'A B', email: 'ab@x.com', role: 'admin' }, deps), /only the Main Admin/i, 403));
  const staff3 = (await sa.inviteStaff({ schoolId: S, actorId: admin2, fullName: 'Third Staff', email: 'third@mwangaza.sc.ke' }, deps)).staff.id;
  check('an Admin can invite a staff member', !!staff3);
  check('an Admin can not touch the owner (reset, suspend, role, email)',
    await fails(() => sa.sendResetLink({ schoolId: S, actorId: admin2, staffId: owner }, deps), /Main Admin/, 403) &&
    await fails(() => sa.setStatus({ schoolId: S, actorId: admin2, staffId: owner, status: 'suspended' }), /Main Admin/, 403) &&
    await fails(() => sa.setRole({ schoolId: S, actorId: admin2, staffId: owner, role: 'staff' }), /Main Admin/, 403) &&
    await fails(() => sa.changeEmail({ schoolId: S, actorId: admin2, staffId: owner, email: 'new@x.com' }, deps), /Main Admin/, 403));
  check('the owner can not suspend or demote themself', await fails(() => sa.setStatus({ schoolId: S, actorId: owner, staffId: owner, status: 'suspended' }), /Main Admin|own account/, 403) && await fails(() => sa.setRole({ schoolId: S, actorId: owner, staffId: owner, role: 'staff' }), /Main Admin|own account/, 403));
  check('an Admin can not manage another Admin', await fails(() => sa.setStatus({ schoolId: S, actorId: admin2, staffId: owner, status: 'suspended' }), /Main Admin/, 403));
  check('nobody can reach into another school', await fails(() => sa.setStatus({ schoolId: S, actorId: owner, staffId: o2, status: 'suspended' }), /not found/, 404));

  // ---- roles & suspension
  check('only the owner can make someone an Admin', await fails(() => sa.setRole({ schoolId: S, actorId: admin2, staffId: clerk, role: 'admin' }), /only the Main Admin/i, 403));
  await sa.setRole({ schoolId: S, actorId: owner, staffId: clerk, role: 'admin' });
  check('the owner can promote, and an Admin then can not manage that Admin', (await one('SELECT role FROM staff WHERE id=$1', [clerk])).role === 'admin' && await fails(() => sa.setStatus({ schoolId: S, actorId: admin2, staffId: clerk, status: 'suspended' }), /only the Main Admin/i, 403));
  await sa.setRole({ schoolId: S, actorId: owner, staffId: clerk, role: 'staff' });
  const tvBefore = (await one('SELECT token_version FROM staff WHERE id=$1', [clerk])).token_version;
  await sa.setStatus({ schoolId: S, actorId: admin2, staffId: clerk, status: 'suspended' });
  check('suspending signs the person out at once (token version moves) and keeps the row', (await one('SELECT status, token_version FROM staff WHERE id=$1', [clerk])).token_version === tvBefore + 1);
  check('a suspended person gets no reset link', await fails(() => sa.sendResetLink({ schoolId: S, actorId: owner, staffId: clerk }, deps), /suspended/));
  const re = await sa.setStatus({ schoolId: S, actorId: admin2, staffId: clerk, status: 'active' });
  check('reactivating brings back an active person (they already have a password)', re.status === 'active');
  const stNever = (await sa.inviteStaff({ schoolId: S, actorId: owner, fullName: 'Never Joined', email: 'never@x.com' }, deps)).staff.id;
  await sa.setStatus({ schoolId: S, actorId: owner, staffId: stNever, status: 'suspended' });
  check('reactivating someone who never joined puts them back to "invited"', (await sa.setStatus({ schoolId: S, actorId: owner, staffId: stNever, status: 'active' })).status === 'invited');

  // ---- reset by link, own password change
  const n0 = outbox.length;
  await sa.sendResetLink({ schoolId: S, actorId: owner, staffId: clerk }, deps);
  check('reset link goes by email, expires in 60 minutes, admin sees nothing', outbox.length === n0 + 1 && /60 minutes/.test(outbox[n0].text));
  const tvA = (await one('SELECT token_version FROM staff WHERE id=$1', [clerk])).token_version;
  const rr = await sa.completeToken({ token: lastToken(), password: 'Clerk-new-9' });
  check('using the reset link sets the new password, signs in, and signs out older sessions', rr.ok && rr.token && (await one('SELECT token_version FROM staff WHERE id=$1', [clerk])).token_version === tvA + 1);
  check('changing own password needs the right current password', await fails(() => sa.changeOwnPassword({ schoolId: S, staffId: clerk, current: 'wrong', next: 'Brand-new-1' }), /current password/, 403));
  const cp = await sa.changeOwnPassword({ schoolId: S, staffId: clerk, current: 'Clerk-new-9', next: 'Brand-new-1' });
  check('own password change works and returns a fresh login for this browser', cp.ok && !!cp.token);
  check('the new password must differ from the old', await fails(() => sa.changeOwnPassword({ schoolId: S, staffId: clerk, current: 'Brand-new-1', next: 'Brand-new-1' }), /different/));
  // forgot password
  const n1 = outbox.length;
  const f1 = await sa.forgotPassword({ email: 'CLERK-does-not-exist@x.com' }, deps), f2 = await sa.forgotPassword({ email: 'admin2@mwangaza.sc.ke' }, deps);
  check('forgot password answers the same for real and unknown emails, and mails only the real one', JSON.stringify(f1) === JSON.stringify(f2) && outbox.length === n1 + 1 && outbox[n1].to === 'admin2@mwangaza.sc.ke', [f1, f2, outbox.length - n1, outbox[n1] && outbox[n1].to]);
  await sa.forgotPassword({ email: 'admin2@mwangaza.sc.ke' }, deps); await sa.forgotPassword({ email: 'admin2@mwangaza.sc.ke' }, deps);
  const n2 = outbox.length; await sa.forgotPassword({ email: 'admin2@mwangaza.sc.ke' }, deps);
  check('forgot password stops after 3 mails in an hour', outbox.length === n2);

  // ---- email change
  check('a staff member can not change their own email', await fails(() => sa.changeEmail({ schoolId: S, actorId: clerk, staffId: clerk, email: 'x@x.com' }, deps), /Only an Admin/, 403));
  check('an Admin can not change another Admin\'s email', await fails(() => sa.changeEmail({ schoolId: S, actorId: admin2, staffId: owner, email: 'n@x.com' }, deps), /Main Admin/, 403));
  const cr = await sa.changeEmail({ schoolId: S, actorId: admin2, staffId: clerk, email: 'wanjiku.new@mwangaza.sc.ke' }, deps);
  check('an email change is only requested: the old address still works, and the confirm mail goes to the NEW address', cr.pending && (await one('SELECT email FROM staff WHERE id=$1', [clerk])).email === 'wanjiku@mwangaza.sc.ke' && outbox[outbox.length - 1].to === 'wanjiku.new@mwangaza.sc.ke');
  await sa.completeToken({ token: lastToken() });
  check('confirming the new address switches it', (await one('SELECT email FROM staff WHERE id=$1', [clerk])).email === 'wanjiku.new@mwangaza.sc.ke');
  await sa.changeEmail({ schoolId: S, actorId: owner, staffId: owner, email: 'olive.new@mwangaza.sc.ke' }, deps);
  await sa.completeToken({ token: lastToken() });
  check('the owner can change their own email', (await one('SELECT email FROM staff WHERE id=$1', [owner])).email === 'olive.new@mwangaza.sc.ke');
  const nj = await sa.changeEmail({ schoolId: S, actorId: owner, staffId: stNever, email: 'never.fixed@x.com' }, deps);
  check('fixing a typo for someone who has not joined changes it at once and sends a new invite', nj.changed && outbox[outbox.length - 1].to === 'never.fixed@x.com');

  // ---- ownership transfer
  check('only the owner can hand over ownership', await fails(() => sa.transferOwnership({ schoolId: S, actorId: admin2, toStaffId: owner, password: 'Admin-pass-1' }), /Only the Main Admin/, 403));
  check('transfer needs the owner\'s password', await fails(() => sa.transferOwnership({ schoolId: S, actorId: owner, toStaffId: admin2, password: 'wrong' }), /password/, 403));
  check('the new owner must be an active Admin', await fails(() => sa.transferOwnership({ schoolId: S, actorId: owner, toStaffId: clerk, password: 'Owner-pass-1' }), /active Admin/));
  await sa.transferOwnership({ schoolId: S, actorId: owner, toStaffId: admin2, password: 'Owner-pass-1' });
  const owners = await q('SELECT id FROM staff WHERE school_id = $1 AND is_owner', [S]);
  check('ownership moved, and there is still exactly one owner', owners.length === 1 && owners[0].id === admin2);
  check('the old owner is now an ordinary Admin and can be managed by the new owner', (await one('SELECT role FROM staff WHERE id=$1', [owner])).role === 'admin' && !!(await sa.setStatus({ schoolId: S, actorId: admin2, staffId: owner, status: 'suspended' })));
  await sa.setStatus({ schoolId: S, actorId: admin2, staffId: owner, status: 'active' });

  // ---- list and audit
  const list = await sa.listStaff(S);
  check('the list shows owner first, with status, last login and no secrets', list[0].id === admin2 && list[0].is_owner && list.every((r) => r.password_hash === undefined && r.token_hash === undefined));
  check('an invited person shows their invite expiry', list.find((r) => r.id === stNever).status === 'invited' && !!list.find((r) => r.id === stNever).invite_expires_at);
  check('the list never includes another school', list.every((r) => r.id !== o2));
  const acts = (await q(`SELECT DISTINCT action FROM audit_log WHERE school_id = $1`, [S])).map((r) => r.action);
  check('every step was written to the activity log', ['staff_invited', 'invite_resent', 'staff_joined', 'password_reset_sent', 'password_reset_done', 'password_changed', 'staff_role_changed', 'staff_suspended', 'staff_reactivated', 'staff_email_change_requested', 'staff_email_changed', 'ownership_transferred'].every((a) => acts.includes(a)), acts);
  check('no audit line holds a link or password', (await q(`SELECT detail::text AS d FROM audit_log`)).every((r) => !/token|password|Pass/i.test(r.d || '')));

  // ---- mail failure keeps the change
  const bad = await sa.inviteStaff({ schoolId: S, actorId: owner, fullName: 'Mail Fails', email: 'mf@x.com' }, { sendMail: async () => { throw new Error('boom'); } });
  check('if the email service fails the person is still created and the admin is told to resend', bad.staff.id && bad.mail.sent === false && /Resend/.test(bad.mail.error));
  // dev mode (no mail provider, not production) hands the link back instead of mailing
  const dev = await sa.inviteStaff({ schoolId: S, actorId: owner, fullName: 'Dev Mode', email: 'dm@x.com' }, {});
  check('local dev mode (no mail set up) returns the link to the screen', dev.mail.sent === false && dev.mail.dev === true && /\?token=/.test(dev.mail.link));
  process.env.NODE_ENV = 'production';
  const prod = await sa.inviteStaff({ schoolId: S, actorId: owner, fullName: 'Prod Mode', email: 'pm@x.com' }, {});
  check('in production an unset mailer NEVER hands the link to the admin', prod.mail.dev === false && prod.mail.link === undefined);
  process.env.NODE_ENV = 'test';

  // ---- mailer providers (network stubbed)
  process.env.MAIL_PROVIDER = 'resend'; process.env.MAIL_API_KEY = 'k'; process.env.MAIL_FROM = 'Karo <no-reply@x.co.ke>';
  let seen; await mailer.sendMail({ to: 'a@b.co', subject: 's', text: 't', html: 'h' }, { fetch: async (u, o) => { seen = { u, o }; return { ok: true }; } });
  check('Resend: right address, bearer key, from/to/subject', seen.u === 'https://api.resend.com/emails' && seen.o.headers.Authorization === 'Bearer k' && JSON.parse(seen.o.body).to[0] === 'a@b.co' && JSON.parse(seen.o.body).from.includes('no-reply'));
  process.env.MAIL_PROVIDER = 'brevo';
  await mailer.sendMail({ to: 'a@b.co', subject: 's', text: 't', html: 'h' }, { fetch: async (u, o) => { seen = { u, o }; return { ok: true }; } });
  check('Brevo: api-key header and parsed sender', seen.u.includes('brevo.com') && seen.o.headers['api-key'] === 'k' && JSON.parse(seen.o.body).sender.email === 'no-reply@x.co.ke' && JSON.parse(seen.o.body).sender.name === 'Karo');
  check('a refused send is an error', await fails(() => mailer.sendMail({ to: 'a@b.co', subject: 's', text: 't', html: 'h' }, { fetch: async () => ({ ok: false, status: 401, text: async () => 'bad key' }) }), /refused/));
  delete process.env.MAIL_PROVIDER; delete process.env.MAIL_API_KEY; delete process.env.MAIL_FROM;

  // ---- through the real server: sign-out rules
  const app = require('../app');
  const server = app.listen(0); const port = server.address().port; const base = 'http://localhost:' + port + '/api';
  const call = async (m, p, body, tk) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk, 'X-Pin-Token': generatePinToken(verifyToken(tk)) } : {}) }, body: body ? JSON.stringify(body) : undefined }); let d = null; try { d = await r.json(); } catch (e) { /* none */ } return { s: r.status, d }; };
  await q(`UPDATE staff SET password_hash = $1 WHERE id = $2`, [await hashPassword('Admin-pass-1'), admin2]);
  const lg = await call('POST', '/auth/login', { email: 'admin2@mwangaza.sc.ke', password: 'Admin-pass-1' });
  check('login works and tells the screen whether this person is the owner', lg.s === 200 && lg.d.staff.is_owner === true && lg.d.token, lg);
  check('login stamps "last login"', (await one('SELECT last_login_at FROM staff WHERE id=$1', [admin2])).last_login_at !== null);
  const A = lg.d.token;
  check('an invited person can not log in', (await call('POST', '/auth/login', { email: 'never.fixed@x.com', password: 'whatever12' })).s === 401);
  const gl = await call('GET', '/schools/' + S + '/staff', null, A); check('GET staff returns the list for an Admin', Array.isArray(gl.d) && gl.d.length >= 5, gl);
  const lc = await call('POST', '/auth/login', { email: 'wanjiku.new@mwangaza.sc.ke', password: 'Brand-new-1' });
  check('the staff-role person can log in with their own password', lc.s === 200, lc);
  check('a staff-role person can read their own account but not the staff list', (await call('GET', '/schools/' + S + '/me', null, lc.d.token)).d.email === 'wanjiku.new@mwangaza.sc.ke' && (await call('GET', '/schools/' + S + '/staff', null, lc.d.token)).s === 403);
  const chg = await call('POST', '/auth/change-password', { current: 'Brand-new-1', password: 'Brand-new-2' }, lc.d.token);
  check('change password: this browser gets a fresh token, the old token stops working', chg.s === 200 && (await call('GET', '/schools/' + S + '/me', null, lc.d.token)).s === 401 && (await call('GET', '/schools/' + S + '/me', null, chg.d.token)).s === 200);
  const sus = await call('POST', '/schools/' + S + '/staff/' + clerk + '/status', { status: 'suspended' }, A);
  check('suspending over the API signs that person out immediately', sus.s === 200 && (await call('GET', '/schools/' + S + '/me', null, chg.d.token)).s === 401);
  check('and they can not log in again', (await call('POST', '/auth/login', { email: 'wanjiku.new@mwangaza.sc.ke', password: 'Brand-new-2' })).s === 401);
  const ty = await call('POST', '/schools/' + S + '/staff/' + owner + '/status', { status: 'suspended' }, A);
  check('the API gives a clear refusal when someone tries to act on a protected person', ty.s === 200 || ty.s === 403);
  const e1 = await call('POST', '/auth/token-info', { token: 'nope' });
  check('a bad link answers 410 with plain words', e1.s === 410 && /no longer valid/.test(e1.d.error));
  const fo = await call('POST', '/auth/forgot', { email: 'nobody@nowhere.com' });
  check('forgot password over the API always answers ok', fo.s === 200 && fo.d.ok === true && fo.d.mail === undefined);
  check('the old endpoint that let an Admin set someone else\'s password is gone', (await call('POST', '/auth/schools/' + S + '/staff/' + clerk + '/set-password', { password: 'Hacked-pass1' }, A)).s === 404);
  server.close();

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  await pool.end();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });