// Prints whether the newer pages' routes are loaded in THIS copy of the project (no database needed).
// Use it when a page shows "404": it tells you which file or line is missing.
//   node src/scripts/check-routes.js
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@localhost:5432/x';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0'.repeat(64);
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const need = ['services/studentSheet.js', 'services/balances.js', 'services/termSetup.js', 'routes/studentSheetRoutes.js', 'routes/balanceRoutes.js', 'routes/terms.js', 'routes/fees.js', 'routes/parentRoutes.js', 'services/parentPortal.js', 'services/stkCallback.js', 'db/parent_schema.sql'];
let bad = 0;
for (const f of need) { const ok = fs.existsSync(path.join(root, f)); if (!ok) bad++; console.log((ok ? 'found   ' : 'MISSING ') + 'src/' + f); }
for (const f of ['routes/balances.js', 'routes/studentSheet.js']) if (fs.existsSync(path.join(root, f))) console.log('OLD FILE (delete it) src/' + f);
const appText = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
for (const line of ["require('./routes/studentSheetRoutes')", "require('./routes/balanceRoutes')", "require('./routes/terms')", "app.use('/api', studentSheetRoutes)", "app.use('/api', balanceRoutes)", "app.use('/api/parent', parentRoutes)"]) {
  const ok = appText.includes(line); if (!ok) bad++; console.log((ok ? 'app.js has     ' : 'app.js LACKS   ') + line);
}
try {
  const app = require('../app');
  const paths = [];
  const walk = (stack) => stack.forEach((l) => { if (l.route) paths.push(Object.keys(l.route.methods)[0].toUpperCase() + ' ' + l.route.path); else if (l.handle && l.handle.stack) walk(l.handle.stack); });
  walk(app._router.stack);
  const sheet = paths.find((p) => /students\/:studentId\/sheet/.test(p));
  console.log(sheet ? 'route loaded:  ' + sheet : 'ROUTE NOT LOADED: GET .../students/:studentId/sheet'); if (!sheet) bad++;
} catch (e) { bad++; console.log('The app could not start: ' + e.message); }
console.log(bad ? '\nProblems found: ' + bad + '. Fix the lines marked MISSING / LACKS / NOT LOADED, then restart npm start.' : '\nAll good: the routes are loaded. If the page still shows 404, send me the exact red message.');
process.exit(0);