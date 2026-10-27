require('dotenv').config();
const { initSchema } = require('./db/db');
const { startTermAutoCharge } = require('./services/termAutoCharge');
const app = require('./app');

// Refuse to start without the two secrets, instead of starting happily and
// crashing later on the first login.
const missing = [];
if (!process.env.JWT_SECRET) missing.push('JWT_SECRET');
if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length !== 64) {
  missing.push('ENCRYPTION_KEY (must be exactly 64 characters)');
}
if (missing.length > 0) {
  console.error('\nMissing or invalid in .env: ' + missing.join(', '));
  console.error('Generate each with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n');
  process.exit(1);
}

// A forgotten await in a background job should be logged, not kill the server.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason && reason.message ? reason.message : reason);
});

const PORT = process.env.PORT || 3000;

initSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`Karo Recon listening on port ${PORT}`));
    startTermAutoCharge();
  })
  .catch((err) => {
    console.error('Failed to initialize database schema:', err);
    process.exit(1);
  });
