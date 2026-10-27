/* pin.js - an Admin's personal PIN. It guards sensitive actions (bank and M-Pesa settings, payment channels, staff access, renaming the school).
   - 4 to 6 digits, stored only as a hash. Obvious ones (1111, 1234, 4321...) are refused.
   - Setting or changing it needs the account PASSWORD (so someone at an unlocked computer can not set their own PIN).
   - Typing it right gives a 10-minute unlock (a signed token the screen keeps in memory and sends as X-Pin-Token).
   - 5 wrong PINs in a row lock PIN use for 15 minutes. Every wrong try and every lock is in the activity log. */
const { pool } = require('../db/db');
const { verifyPassword, hashPassword, generatePinToken, PIN_MINUTES } = require('../security/auth');
const { lockedMinutes, recordFailure, clearFailures } = require('./lock');
const { logAudit } = require('./audit');

const MAX_FAILS = 5, LOCK_MINUTES = 15;
function refuse(message, status = 400, extra) { const e = new Error(message); e.status = status; if (extra) Object.assign(e, extra); return e; }

function checkPinShape(pin) {
  if (typeof pin !== 'string' || !/^\d{4,6}$/.test(pin)) throw refuse('The PIN must be 4 to 6 digits.');
  const d = pin.split('').map(Number);
  const same = d.every((x) => x === d[0]);
  const up = d.every((x, i) => i === 0 || x === d[i - 1] + 1), down = d.every((x, i) => i === 0 || x === d[i - 1] - 1);
  if (same || up || down) throw refuse('That PIN is too easy to guess. Avoid repeats like 1111 and runs like 1234.');
}
async function loadAdmin(db, schoolId, staffId) {
  const r = await db.query('SELECT id, school_id, role, status, password_hash, pin_hash, pin_failures, pin_locked_until, token_version FROM staff WHERE id = $1 AND school_id = $2', [staffId, schoolId]);
  const a = r.rows[0];
  if (!a || a.status !== 'active') throw refuse('Your account can not do this.', 403);
  if (a.role !== 'admin') throw refuse('Only Admins use a PIN.', 403);
  return a;
}
const tokenFor = (a) => ({ token: generatePinToken({ staffId: a.id, schoolId: a.school_id, tv: a.token_version }), minutes: PIN_MINUTES });

async function pinStatus(schoolId, staffId, db = pool) {
  const a = await loadAdmin(db, schoolId, staffId);
  const lock = a.pin_locked_until && new Date(a.pin_locked_until) > new Date() ? Math.max(1, Math.ceil((new Date(a.pin_locked_until) - new Date()) / 60000)) : 0;
  return { has_pin: Boolean(a.pin_hash), locked_minutes: lock };
}

async function setPin({ schoolId, staffId, password, pin, ip = null }, deps = {}) {
  const db = deps.pool || pool;
  const a = await loadAdmin(db, schoolId, staffId);
  const key = 'pinpw:' + staffId;
  const mins = await lockedMinutes(key);
  if (mins) throw refuse(`Too many wrong passwords. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`, 429);
  if (!(await verifyPassword(String(password || ''), a.password_hash))) {
    await recordFailure(key, MAX_FAILS, LOCK_MINUTES);
    throw refuse('Your password is not right.', 403);
  }
  await clearFailures(key);
  checkPinShape(pin);
  const hash = await hashPassword(pin);
  await db.query('UPDATE staff SET pin_hash = $1, pin_failures = 0, pin_locked_until = NULL WHERE id = $2', [hash, staffId]);
  await logAudit({ schoolId, staffId, action: a.pin_hash ? 'pin_changed' : 'pin_set', ip });
  return { ok: true, ...tokenFor(a) };
}

async function unlock({ schoolId, staffId, pin, ip = null }, deps = {}) {
  const db = deps.pool || pool;
  const a = await loadAdmin(db, schoolId, staffId);
  if (!a.pin_hash) throw refuse('Set your PIN first.', 403, { code: 'pin_not_set' });
  if (a.pin_locked_until && new Date(a.pin_locked_until) > new Date()) {
    const m = Math.max(1, Math.ceil((new Date(a.pin_locked_until) - new Date()) / 60000));
    throw refuse(`PIN is locked after too many wrong tries. Try again in ${m} minute${m === 1 ? '' : 's'}.`, 429);
  }
  if (!(await verifyPassword(String(pin || ''), a.pin_hash))) {
    const r = await db.query(
      `UPDATE staff SET pin_locked_until = CASE WHEN pin_failures + 1 >= $2 THEN NOW() + make_interval(mins => $3) ELSE pin_locked_until END,
              pin_failures = CASE WHEN pin_failures + 1 >= $2 THEN 0 ELSE pin_failures + 1 END
       WHERE id = $1 RETURNING pin_locked_until`, [staffId, MAX_FAILS, LOCK_MINUTES]);
    const locked = r.rows[0].pin_locked_until && new Date(r.rows[0].pin_locked_until) > new Date();
    await logAudit({ schoolId, staffId, action: locked ? 'pin_locked' : 'pin_failed', ip });
    throw refuse(locked ? `That PIN is not right. PIN is now locked for ${LOCK_MINUTES} minutes.` : 'That PIN is not right.', locked ? 429 : 403);
  }
  await db.query('UPDATE staff SET pin_failures = 0, pin_locked_until = NULL WHERE id = $1', [staffId]);
  return { ok: true, ...tokenFor(a) };
}

module.exports = { setPin, unlock, pinStatus, checkPinShape };