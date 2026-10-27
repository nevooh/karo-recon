const { verifyToken, verifyPinToken } = require('../security/auth');
const { pool } = require('../db/db');

/**
 * Requires a valid Bearer token for an ACTIVE account whose password has not changed since the token was made.
 * On success, attaches req.staff = { staffId, schoolId }.
 * Use on any route that touches real school data.
 */
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }
  let payload;
  try { payload = verifyToken(header.slice(7)); }
  catch (err) { return res.status(401).json({ error: 'Invalid or expired token - please log in again' }); }
  try {
    // A suspended person, or one whose password was changed/reset, is signed out at once (token_version moved on).
    const r = await pool.query('SELECT status, token_version FROM staff WHERE id = $1', [payload.staffId]);
    const row = r.rows[0];
    if (!row || row.status !== 'active' || row.token_version !== (payload.tv || 0)) {
      return res.status(401).json({ error: 'Invalid or expired token - please log in again' });
    }
    req.staff = payload;
    next();
  } catch (err) { next(err); }
}

/**
 * Use AFTER requireAuth on any route with :schoolId in the URL. Blocks a
 * staff member from one school touching another school's data, even if
 * they guess/type a different schoolId in the URL - this is the real fix
 * for the gap where a staff_id alone used to be enough.
 */
function requireSameSchool(req, res, next) {
  const urlSchoolId = Number(req.params.schoolId);
  if (req.staff.schoolId !== urlSchoolId) {
    return res.status(403).json({ error: 'This account does not belong to that school' });
  }
  next();
}

/**
 * Use AFTER requireAuth + requireSameSchool. Only lets an ADMIN of this school
 * through. The role is read from the database on every request (not from the
 * login token), so taking someone's admin power away works immediately.
 */
async function requireAdmin(req, res, next) {
  try {
    const r = await pool.query(
      `SELECT role FROM staff WHERE id = $1 AND school_id = $2 AND status = 'active'`,
      [req.staff.staffId, req.staff.schoolId]
    );
    if (!r.rows[0] || r.rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Only an Admin can do this' });
    }
    req.staffRole = 'admin';
    next();
  } catch (err) { next(err); }
}

/**
 * Use AFTER requireAuth (and requireAdmin) on SENSITIVE actions: bank and M-Pesa settings, payment channels, staff access.
 * The person must have typed their PIN in the last 10 minutes in this same sign-in. The screen sends the proof in the
 * X-Pin-Token header. If it is missing or old the answer is 403 with code 'pin_required' (or 'pin_not_set' when they have
 * no PIN yet), and the screen asks for the PIN and tries again by itself.
 */
// Has this request proven the PIN? -> { ok: true } or { ok: false, body } (body is the 403 answer). Also used where only SOME requests need a PIN.
async function pinCheck(req) {
  const raw = req.headers['x-pin-token'];
  if (raw) {
    try {
      const p = verifyPinToken(String(raw));
      if (p.staffId === req.staff.staffId && p.schoolId === req.staff.schoolId && (p.tv || 0) === (req.staff.tv || 0)) return { ok: true };
    } catch (e) { /* expired or not valid: fall through and ask again */ }
  }
  const r = await pool.query('SELECT pin_hash FROM staff WHERE id = $1', [req.staff.staffId]);
  const has = Boolean(r.rows[0] && r.rows[0].pin_hash);
  return { ok: false, body: { error: has ? 'Enter your PIN to continue.' : 'Set your PIN first. It protects sensitive actions.', code: has ? 'pin_required' : 'pin_not_set' } };
}
async function requirePin(req, res, next) {
  try {
    const c = await pinCheck(req);
    if (c.ok) return next();
    return res.status(403).json(c.body);
  } catch (err) { next(err); }
}

module.exports = { requireAuth, requireSameSchool, requireAdmin, requirePin, pinCheck };