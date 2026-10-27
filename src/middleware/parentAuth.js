const { verifyParentToken } = require('../security/auth');
const { pool } = require('../db/db');

/**
 * Requires a valid PARENT token (made by services/parentAuth.js). A staff token is refused here, and a parent token is
 * refused by the staff check, because the two carry different "purpose" markers.
 * On success: req.parent = { phone }  (phone as 2547XXXXXXXX).
 * "Sign out everywhere" bumps token_version, which stops every older token at once.
 */
async function requireParent(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return res.status(401).json({ error: 'Please sign in.' });
  let p;
  try { p = verifyParentToken(header.slice(7)); }
  catch (err) { return res.status(401).json({ error: 'Your sign-in has expired. Please sign in again.' }); }
  try {
    const r = await pool.query('SELECT token_version FROM parent_accounts WHERE phone = $1', [p.phone]);
    if (!r.rows[0] || r.rows[0].token_version !== (p.tv || 0)) return res.status(401).json({ error: 'Your sign-in has expired. Please sign in again.' });
    req.parent = { phone: p.phone };
    next();
  } catch (err) { next(err); }
}

module.exports = { requireParent };
