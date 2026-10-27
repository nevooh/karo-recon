// Looks at, or runs, billing for ONE school right now. Billing is AUTOMATIC (the server does it when a term
// starts and checks every hour), so you normally never need this. Use it to see what billing would do, or to
// not wait for the next hourly check.
//
//   node src/scripts/charge-term.js "<school>" --dry     look first: nothing is changed
//   node src/scripts/charge-term.js "<school>"           do it now
//
// It is the SAME engine as the automatic run, with the same protection: a class that is already billed for the
// term is skipped, so running this twice (or while the server runs) never charges anyone twice.
// Only the current term (the latest one that has started) is ever billed. Payments are never touched.

require('dotenv').config();
const { findSchool } = require('../services/classSetup');
const { billSchool } = require('../services/termBilling');

const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const unknown = argv.filter((a) => a.startsWith('--') && a !== '--dry');
const positional = argv.filter((a) => !a.startsWith('--'));
const m = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });

function usage() {
  console.log('Usage:');
  console.log('  node src/scripts/charge-term.js "<school name or number>" [--dry]');
}

(async () => {
  try {
    if (unknown.length) { console.error('Unknown option: ' + unknown.join(', ')); usage(); process.exit(1); }
    if (positional.length !== 1) { usage(); process.exit(1); }
    const school = await findSchool(positional[0]);
    const r = await billSchool(school.id, { dry, via: 'charge-term' });
    if (!r.term) { console.log(`\nNo term has started yet, so there is nothing to bill. Set the terms: node src/scripts/set-terms.js show <school>\n`); process.exit(0); }
    console.log(dry ? `\nDRY RUN for ${r.school.name}, ${r.term.label}: nothing was changed.\n` : `\n${r.school.name}, ${r.term.label}\n`);
    for (const c of r.classes) {
      if (c.status === 'billed') console.log(`${c.class.padEnd(10)} ${dry ? 'would be billed' : 'billed'}: fees version ${c.version}, ${c.students} student(s), ${m(c.totalFees)} in fees`);
      else if (c.status === 'already') console.log(`${c.class.padEnd(10)} already billed for this term (locked, nothing done)`);
      else console.log(`${c.class.padEnd(10)} no fees set yet, not billed${c.waitingStudents ? ` (${c.waitingStudents} student(s) waiting)` : ''}. Set them in the fee structure; billing picks it up on its own.`);
    }
    if (!r.classes.length) console.log('This school has no classes switched on.');
    console.log(`\nClasses billed now: ${r.billedClasses}   students: ${r.students}   fees: ${m(r.totalFees)}`);
    const dropped = Object.entries(r.dropped);
    if (dropped.length) console.log(`Optional fees dropped (the class does not offer them): ${dropped.map(([n, c]) => `${n} x${c}`).join(', ')}`);
    console.log(dry ? '\nRun the same command without --dry to do it.\n' : '');
    process.exit(0);
  } catch (err) {
    console.error('\nNOT billed:', err.message, '\n');
    process.exit(1);
  }
})();