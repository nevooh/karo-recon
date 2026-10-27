// Sets the dates of ONE SCHOOL's term, or shows that school's terms. Every school has its own calendar, and school
// admins normally do this themselves in the app (Academic years & terms). This command is the operator's way in.
// Same engine as the app: src/services/termSetup.js.
//
// Usage:
//   node src/scripts/set-terms.js show <school>
//   node src/scripts/set-terms.js <school> <year> <term 1-3> <start date> <end date> [--dry] [--confirm-started]
//
// <school> is the school's number or exact name. Dates are written YEAR-MONTH-DAY. Example (term 3 of 2026):
//   node src/scripts/set-terms.js 1 2026 3 2026-08-31 2026-10-23
//
// Rules: a term that has not started can be changed freely. Once its start date is reached the start is locked
// (the end can still move). A term that has ended is locked. A start date of today or earlier starts billing
// at once, so it needs --confirm-started (run with --dry first to see who would be billed).

require('dotenv').config();
const { pool } = require('../db/db');
const { setTermDates, listTerms } = require('../services/termSetup');

const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const confirmStarted = argv.includes('--confirm-started');
const positional = argv.filter((a) => !a.startsWith('--'));
const unknownFlags = argv.filter((a) => a.startsWith('--') && !['--dry', '--confirm-started'].includes(a));

function usage() {
  console.log('Usage:');
  console.log('  node src/scripts/set-terms.js show <school>');
  console.log('  node src/scripts/set-terms.js <school> <year> <term 1-3> <start date> <end date> [--dry] [--confirm-started]');
  console.log('Example:');
  console.log('  node src/scripts/set-terms.js 1 2026 3 2026-08-31 2026-10-23');
}

async function findSchool(text) {
  const byId = /^\d+$/.test(text) ? (await pool.query('SELECT id, name FROM schools WHERE id = $1', [Number(text)])).rows[0] : null;
  if (byId) return byId;
  const byName = (await pool.query('SELECT id, name FROM schools WHERE LOWER(name) = LOWER($1)', [text])).rows;
  if (byName.length === 1) return byName[0];
  throw new Error(byName.length > 1 ? `More than one school is called "${text}". Use its number.` : `No school "${text}". Use its number or exact name.`);
}

function printTable(list) {
  console.log(`\n${list.school.name} | today: ${list.today}\n`);
  console.log('Year  Term  Starts      Ends        Status    Billed');
  console.log('----  ----  ----------  ----------  --------  ------');
  for (const y of list.years) {
    for (const t of y.terms) {
      console.log(
        `${String(y.year).padEnd(4)}  ${String(t.term).padEnd(4)}  ${(t.start || '-').padEnd(10)}  ${(t.end || '-').padEnd(10)}  ${(t.state === 'running' ? 'RUNNING' : t.state).padEnd(8)}  ${(t.billed ? 'yes' : 'no').padEnd(6)}` +
        (t.paymentsGoHere ? '  <- payments go here' : ''));
    }
  }
  console.log('');
  if (!list.current) console.log('No term has started yet, so no payment can reach a balance.\n');
}

(async () => {
  try {
    if (unknownFlags.length) { console.error('Unknown option: ' + unknownFlags.join(', ')); usage(); process.exit(1); }

    if (positional[0] === 'show' && positional.length === 2 && !dry && !confirmStarted) {
      const school = await findSchool(positional[1]);
      printTable(await listTerms(school.id));
      process.exit(0);
    }
    if (positional.length !== 5) { usage(); process.exit(1); }

    const [schoolText, year, term, start, end] = positional;
    const school = await findSchool(schoolText);
    let r;
    try {
      r = await setTermDates({ schoolId: school.id, year, term, start, end, dry, confirmStarted, via: 'set-terms' });
    } catch (err) {
      if (err.needsConfirmation) {
        console.error('\nNOT changed:', err.message);
        console.error('\nIf this billing is what you want, run it again with --confirm-started. Billing preview:');
        for (const c of err.preview.classes) console.error(`  ${c.class}: ${c.students} students - ${c.action}`);
        console.error('');
        process.exit(1);
      }
      throw err;
    }
    const name = `Term ${r.term} ${r.year}`;
    if (r.unchanged) {
      console.log(`\nNothing to change: ${name} of ${school.name} already runs ${r.start} to ${r.end}.`);
    } else {
      console.log(dry ? '\nDRY RUN: everything checks out. Nothing was changed.\n' : '\nDone.\n');
      if (r.createdYear) console.log(`${dry ? 'Would make' : 'Made'} the year ${r.year} with its 3 terms.`);
      const was = r.previous.start ? `  (was ${r.previous.start} to ${r.previous.end})` : '  (had no dates before)';
      console.log(`${school.name} | ${name}: ${r.start} to ${r.end}${was}`);
      if (r.needsConfirmation) console.log('\nThis term starts billing now. It needs --confirm-started to save.');
      if (r.preview) for (const c of r.preview.classes) console.log(`  ${c.class}: ${c.students} students - ${c.action}`);
      if (r.billed && !r.billed.error) console.log(`\nBilled now: ${r.billed.billedClasses} classes, ${r.billed.students} students.`);
      if (r.billed && r.billed.error) console.log('\nSaved, but billing hit a problem (it will be retried by the hourly check): ' + r.billed.error);
    }
    for (const w of r.warnings) console.log('\nNote: ' + w);
    if (!dry) printTable(await listTerms(school.id));
    else console.log('\nRun the same command without --dry to save it.\n');
    process.exit(0);
  } catch (err) {
    console.error('\nNOT changed:', err.message, '\n');
    process.exit(1);
  }
})();