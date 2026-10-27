// Registers the two webhook URLs for ONE school's M-Pesa paybill with Safaricom,
// using that school's own encrypted Daraja keys from the database.
// (The same thing the Admin screen does. This is the command-line version for the team.)
//
// Usage:
//   node src/scripts/register-urls.js <schoolId> <https-base-url> [--dry] [--force]
//     e.g. node src/scripts/register-urls.js 1 https://fees.example.com --dry
//
//   --dry    shows what would be sent (with the secret code hidden) and sends NOTHING
//   --force  only for production, and only if Safaricom has ALREADY deleted the old addresses
//
// The school gets its OWN random secret code, stored encrypted in the database. The full
// addresses are never printed: only a masked version (the first 4 characters of the code).
// The safety rules live in src/services/mpesaSetup.js, so nothing can skip them.

require('dotenv').config();
const { registerForSchool } = require('../services/mpesaSetup');

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const force = args.includes('--force');
const [schoolId, base, extra] = args.filter((a) => !a.startsWith('--'));

if (!schoolId || !base || extra) {
  console.log('Usage: node src/scripts/register-urls.js <schoolId> <https-base-url> [--dry] [--force]');
  if (extra) console.log('(The older form with two explicit addresses is gone: the secret code is now made and stored for you.)');
  process.exit(1);
}

(async () => {
  try {
    const result = await registerForSchool({ schoolId: Number(schoolId), base, dry, force });
    console.log(`School:        ${result.school.name} (paybill ${result.school.shortcode})`);
    console.log(`Confirmation:  ${result.preview.confirmation}`);
    console.log(`Validation:    ${result.preview.validation}`);
    if (result.dry) {
      console.log('\nDry run - nothing was sent to Safaricom, nothing was recorded.');
      console.log('(The real secret code is only made when you register for real. Everything but the code shown above is exactly what will be sent.)');
    } else {
      console.log(`\nRegistered successfully for "${result.school.name}":`, result.data);
      console.log('The school\'s secret code is stored (encrypted) in the database. The Bank connections screen now shows M-Pesa as registered.');
    }
    process.exit(0);
  } catch (err) {
    console.error('\nNOT registered:', err.response && err.response.data ? JSON.stringify(err.response.data) : err.message);
    process.exit(1);
  }
})();