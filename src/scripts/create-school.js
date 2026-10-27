// Signs a new school up: makes the school AND its first Admin login, together.
// (This is the school "sign-up". It is done by you or your agents, not by the public, so nobody
// can create schools by themselves. Your future operator dashboard will use the same engine:
// src/services/schoolSetup.js.)
//
// Usage:
//   node src/scripts/create-school.js "<School name>" "<Admin full name>" <admin-email> [options]
//
// Options:
//   --channels mpesa,kcb,equity,coop   switch these channels ON for the school right away
//                                      (the school's Admin can change this later in School settings)
//   --password "<password>"            choose the password yourself (10+ characters).
//                                      Without it, a strong one is made and shown ONCE.
//   --dry                              check everything and create NOTHING
//
// Example:
//   node src/scripts/create-school.js "Mwangaza Girls High" "Jane Wanjiru" jane@mwangaza.sc.ke --channels mpesa,equity

require('dotenv').config();
const { createSchoolWithAdmin } = require('../services/schoolSetup');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const valueIdx = new Set(['--password', '--channels'].map((n) => argv.indexOf(n) + 1).filter((i) => i > 0));
const positional = argv.filter((a, i) => !a.startsWith('--') && !valueIdx.has(i));
const [name, adminName, adminEmail] = positional;

if (!name || !adminName || !adminEmail || positional.length > 3) {
  console.log('Usage: node src/scripts/create-school.js "<School name>" "<Admin full name>" <admin-email> [--channels mpesa,kcb,equity,coop] [--password "<password>"] [--dry]');
  console.log('Tip: put every name in "double quotes".');
  process.exit(1);
}
const password = option('--password');
if (argv.includes('--password') && password === undefined) { console.error('--password needs a value.'); process.exit(1); }
const channelsOpt = option('--channels');
if (argv.includes('--channels') && !channelsOpt) { console.error('--channels needs a list, for example --channels mpesa,equity'); process.exit(1); }

(async () => {
  try {
    const dry = flag('--dry');
    const r = await createSchoolWithAdmin({
      name, adminName, adminEmail, password,
      channels: channelsOpt ? channelsOpt.split(',') : [],
      dry,
    });
    const line = '-'.repeat(60);
    console.log(dry ? '\nDRY RUN: everything checks out. Nothing was created.\n' : '\nSchool created.\n');
    console.log(line);
    console.log(`School:    ${r.school.name}${r.school.id ? `  (id ${r.school.id})` : ''}`);
    console.log(`Admin:     ${r.admin.full_name}  <${r.admin.email}>   role: admin`);
    if (r.password) {
      console.log(`Password:  ${r.password}`);
      console.log('           ^ shown ONCE. It is not stored anywhere readable. Give it to the Admin.');
      console.log(`           (If it is lost: node src/scripts/create-admin.js ${r.school.id} "${r.admin.full_name}" ${r.admin.email} <new-password>)`);
    } else if (!dry) {
      console.log('Password:  the one you chose (not shown).');
    }
    console.log(`Channels:  ${r.channels.length ? r.channels.join(', ') + ' (switched on)' : 'none switched on yet'}`);
    console.log(line);
    if (!dry) {
      const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
      console.log(`\nThe Admin logs in at: ${base || '(your server address: set PUBLIC_BASE_URL in .env)'}`);
      console.log('\nNext steps for this school:');
      console.log('  1. The Admin logs in and opens School settings to switch on the channels it uses.');
      console.log('  2. On Bank connections, set up each channel (M-Pesa checklist, KCB, Equity, Co-op).');
      console.log('  3. Students and fees are added separately.');
      console.log('  4. Test each channel by paying KES 50 with a test admission number.\n');
    } else {
      console.log('\nRun the same command without --dry to create it.\n');
    }
    process.exit(0);
  } catch (err) {
    console.error('\nNOT created:', err.message, '\n');
    process.exit(1);
  }
})();