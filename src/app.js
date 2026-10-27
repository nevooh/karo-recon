const express = require('express');
const path = require('path');

// Express 4 does not catch errors thrown inside async route handlers: one
// failed query or "Cannot edit fees..." error would crash the whole server.
// This makes any rejected promise from a route go to the error handler at
// the bottom of this file instead. (Express 5 does this natively.)
const Layer = require('express/lib/router/layer');
Layer.prototype.handle_request = function handleRequest(req, res, next) {
  const fn = this.handle;
  if (fn.length > 3) return next(); // an error-handling middleware, skip
  try {
    const result = fn(req, res, next);
    if (result && typeof result.catch === 'function') result.catch(next);
  } catch (err) {
    next(err);
  }
};
const { pool } = require('./db/db');
const webhookRoutes = require('./routes/webhooks');
const reconciliationRoutes = require('./routes/reconciliation');
const authRoutes = require('./routes/auth');
const classesRoutes = require('./routes/classes');
const studentRoutes = require('./routes/students');
const feeRoutes = require('./routes/fees');
const termRoutes = require('./routes/terms');
const balanceRoutes = require('./routes/balanceRoutes');
const studentSheetRoutes = require('./routes/studentSheetRoutes');
const staffRoutes = require('./routes/staffRoutes');
const activityRoutes = require('./routes/activityRoutes');
const reportRoutes = require('./routes/reportRoutes');
const settingsRoutes = require('./routes/settingsRoutes');
const parentRoutes = require('./routes/parentRoutes');
const ownerRoutes = require('./routes/ownerRoutes');
const { createSchoolWithCredentials } = require('./services/schoolCredentials');

const app = express();
// Behind a host's proxy (Render etc.) every request would look like it comes from the proxy's address. This makes req.ip the real
// visitor, which the per-connection limit on parent sign-in codes and the login audit log rely on. One proxy in front of us.
app.set('trust proxy', 1);
// rawBody is kept because KCB signs the exact bytes it sends, and the
// signature can only be checked against those exact bytes.
app.use(express.json({ limit: '1mb', verify: (req, res, buf) => { req.rawBody = buf; } }));

app.use('/webhooks', webhookRoutes);
app.use('/api', reconciliationRoutes);
app.use('/api', classesRoutes);
app.use('/api', studentRoutes);
app.use('/api', feeRoutes);
app.use('/api', termRoutes);
app.use('/api', balanceRoutes);
app.use('/api', studentSheetRoutes);
app.use('/api', staffRoutes);
app.use('/api', activityRoutes);
app.use('/api', reportRoutes);
app.use('/api', settingsRoutes);
app.use('/api/auth', authRoutes);
// Parent portal: parents sign in with their phone number (not a staff account), see their children's fees and pay by M-Pesa.
app.use('/api/parent', parentRoutes);
// Platform owner console (Zuvy): add schools, see the list.
app.use('/api/owner', ownerRoutes);

// ---------------------------------------------------------------------
// DEV-ONLY ROUTES. These are unauthenticated and one of them wipes the
// whole database, so they are OFF by default. To use them locally, put
// ENABLE_DEV_ROUTES=true in your .env. They can never turn on when
// NODE_ENV=production, even if the flag is set by mistake.
// ---------------------------------------------------------------------
const isProduction = process.env.NODE_ENV === 'production';
const devFlag = process.env.ENABLE_DEV_ROUTES === 'true';
const devRoutesEnabled = devFlag && !isProduction;

if (devFlag && isProduction) {
  console.error('ENABLE_DEV_ROUTES=true ignored because NODE_ENV=production. Dev routes stay OFF.');
}

if (devRoutesEnabled) {
  console.warn('WARNING: dev routes are ON (/api/dev/*). Never run this way on a public server.');

  app.post('/api/dev/reset', async (req, res) => {
    await pool.query('TRUNCATE transactions, students, schools RESTART IDENTITY CASCADE');
    res.json({ ok: true });
  });

  // Onboards a school with its OWN M-Pesa credentials, encrypted at rest.
  app.post('/api/dev/seed-school', async (req, res) => {
    const { name, mpesa_shortcode, mpesa_consumer_key, mpesa_consumer_secret, students = [] } = req.body;

    const school = await createSchoolWithCredentials({
      name,
      mpesaShortcode: mpesa_shortcode,
      mpesaConsumerKey: mpesa_consumer_key,
      mpesaConsumerSecret: mpesa_consumer_secret,
    });

    for (const s of students) {
      await pool.query(
        `INSERT INTO students (school_id, admission_no, full_name, phone, guardian_phone, guardian_name)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [school.id, s.admission_no, s.full_name, s.phone || null, s.guardian_phone || null, s.guardian_name || null]
      );
    }

    res.json({ schoolId: school.id });
  });
}

// Short link for parents. PORTAL_HOST=pay.yourdomain.com makes that address open the parent portal straight away
// (the staff app stays on the main address). /pay also works on any address and goes to the portal.
const PORTAL_HOST = String(process.env.PORTAL_HOST || '').trim().toLowerCase();
app.use((req, res, next) => {
  if (PORTAL_HOST && String(req.hostname).toLowerCase() === PORTAL_HOST && !/^\/(api|webhooks|health)(\/|$)/.test(req.path)) {
    req.url = '/portal' + (req.url === '/' ? '/' : req.url);
  }
  next();
});
app.get('/pay', (req, res) => res.redirect('/portal/'));

// The admin screens, served from the same server (so no CORS setup is needed).
app.use(express.static(path.join(__dirname, '..', 'frontend')));

app.get('/health', (req, res) => res.json({ ok: true }));
// Same, but also touches the database. Point an uptime pinger at THIS one: it keeps a sleepy host awake AND counts as database
// activity, so a free database (Supabase pauses idle projects) stays awake too. It reveals nothing about the data.
app.get('/health/db', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, db: true }); }
  catch (err) { console.error('health/db:', err.message); res.status(503).json({ ok: false, db: false }); }
});

// ---------------------------------------------------------------------
// Error handler - must come after every route. Anything thrown (or
// rejected) in a route lands here instead of crashing the server.
//  - errors with an explicit .status use it
//  - database errors and programming bugs -> 500, generic message
//    (details go to the server log only, never to the caller)
//  - any other Error thrown on purpose by our services ("No term found",
//    "Cannot edit fees...", etc.) -> 400 with its own message, so the UI
//    can show the user something useful
// ---------------------------------------------------------------------
app.use((err, req, res, next) => {
  console.error(`[${req.method} ${req.originalUrl}]`, err.message);
  if (res.headersSent) return next(err);

  const isDbError = typeof err.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code);
  const isBug = err instanceof TypeError || err instanceof ReferenceError || err instanceof RangeError;
  const status = err.status || err.statusCode || (isDbError || isBug ? 500 : 400);

  res.status(status).json({ error: status >= 500 ? 'Something went wrong on the server' : err.message });
});

module.exports = app;