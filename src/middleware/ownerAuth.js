const { verifyOwnerToken } = require('../security/auth');
const { pool } = require('../db/db');

// Requires a valid PLATFORM OWNER token. On success: req.owner = { id, email, full_name }.
async function requireOwner(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return res.status(401).json({ error: 'Please sign in.' });
  let p;
  try { p = verifyOwnerToken(header.slice(7)); }
  catch (e) { return res.status(401).json({ error: 'Your sign-in has expired. Please sign in again.' }); }
  try {
    const r = await pool.query('SELECT id, email, full_name, token_version FROM platform_owners WHERE id = $1', [p.ownerId]);
    if (!r.rows[0] || r.rows[0].token_version !== (p.tv || 0)) return res.status(401).json({ error: 'Your sign-in has expired. Please sign in again.' });
    req.owner = { id: r.rows[0].id, email: r.rows[0].email, full_name: r.rows[0].full_name };
    next();
  } catch (err) { next(err); }
}
module.exports = { requireOwner };