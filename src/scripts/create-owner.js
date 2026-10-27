// Makes (or resets) the platform-owner login. Run once on the server/your PC:
//   node src/scripts/create-owner.js you@email.com "Your Name" "a-long-password-12+"
require('dotenv').config();
const { initSchema, pool } = require('../db/db');
const { createOwner } = require('../services/ownerConsole');
const [email, name, password] = process.argv.slice(2);
if (!email || !password) { console.log('Usage: node src/scripts/create-owner.js <email> "<Your Name>" "<password 12+ chars>"'); process.exit(1); }
(async () => {
  try { await initSchema(); const o = await createOwner({ email, fullName: name, password }); console.log('Owner ready:', o.email); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
  finally { await pool.end(); }
})();