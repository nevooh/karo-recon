// Sets a school's fee structure from the terminal. The school can be given by its NAME (in "double quotes") or its NUMBER.
// The fee structure is a reusable template: one list per class per TERM NUMBER (1, 2 or 3), no year. It can be edited
// any day. Every save is a new version (old ones are kept). Billing is automatic: when a term starts, the latest
// version is locked for that term and students are charged. Editing later never changes a term already billed.
// Your future dashboard will use the same engine: src/services/feeSetup.js.
//
// 1) The school's list of OPTIONAL fee names (Lunch, Bus ...). Write them once, then choose from them:
//   node src/scripts/set-fees.js "<school>" optional list
//   node src/scripts/set-fees.js "<school>" optional add "Lunch"
//   node src/scripts/set-fees.js "<school>" optional remove "Lunch"
//
// 2) Set the fees of one or more classes for one or more terms (saves a new version for each that changes):
//   node src/scripts/set-fees.js "<school>" set "Grade 2" 1 --fee "Tuition=50000" --fee "Exam=2000" --optional "Lunch=3000" --optional "Bus=5000"
//   Several classes with the SAME fees:  "Grade 1,Grade 2,Grade 3"   or a range:  "Grade 1..Grade 6"
//   Several terms:  1,2,3   (term 3 is shorter, so it often has its own prices)
//   --fee       a fee everyone in the class pays
//   --optional  a fee the parent chooses (the name must be on the school's list, or add --new to add it now)
//
// 3) Copy the latest fees of one class and term onto other terms and/or other classes:
//   node src/scripts/set-fees.js "<school>" copy "Grade 1" 1 --to-terms 2,3
//   node src/scripts/set-fees.js "<school>" copy "Grade 1" 1 --to-classes "Grade 2,Grade 3" --to-terms 1,2,3
//
// 4) Set one optional fee's price for classes and terms (this is what the Optional fees page does):
//   node src/scripts/set-fees.js "<school>" price "Lunch" "Grade 1..Grade 3" 1,2 3000      (a price)
//   node src/scripts/set-fees.js "<school>" price "Lunch" "Grade 1" 3 none                   (not offered that term)
//
// 5) Look at the fees (all classes, or one class with its history):
//   node src/scripts/set-fees.js "<school>" show
//   node src/scripts/set-fees.js "<school>" show "Grade 2"
//
// Extra options:
//   --dry            check everything and change NOTHING
//   --new            (set) add optional names that are not on the school's list yet
//   --allow-drop     allow removing an optional fee that students have chosen (they lose it at the next billing)

require('dotenv').config();
const { findSchool } = require('../services/classSetup');
const svc = require('../services/feeSetup');

const raw = process.argv.slice(2);
const flags = { dry: false, new: false, allowDrop: false };
const fees = [], optional = [], positional = [];
const unknown = [];
let toClasses = null, toTerms = null;
for (let i = 0; i < raw.length; i++) {
  const a = raw[i];
  if (a === '--dry') flags.dry = true;
  else if (a === '--new') flags.new = true;
  else if (a === '--allow-drop') flags.allowDrop = true;
  else if (a === '--fee' || a === '--optional' || a === '--to-classes' || a === '--to-terms') {
    if (i + 1 >= raw.length || raw[i + 1].startsWith('--')) { console.error(`${a} needs a value.`); process.exit(1); }
    const v = raw[++i];
    if (a === '--fee') fees.push(v); else if (a === '--optional') optional.push(v); else if (a === '--to-classes') toClasses = v; else toTerms = v;
  } else if (a.startsWith('--')) unknown.push(a);
  else positional.push(a);
}

function usage() {
  console.log('Usage:');
  console.log('  node src/scripts/set-fees.js "<school>" optional list');
  console.log('  node src/scripts/set-fees.js "<school>" optional add "<name>" [--dry]');
  console.log('  node src/scripts/set-fees.js "<school>" optional remove "<name>" [--dry]');
  console.log('  node src/scripts/set-fees.js "<school>" set "<class>[,<class>...]" <term(s) 1-3, like 1 or 1,2,3> --fee "Name=Amount" [--fee ...] [--optional "Name=Amount" ...] [--new] [--allow-drop] [--dry]');
  console.log('  node src/scripts/set-fees.js "<school>" copy "<class>" <term> [--to-classes "<classes>"] [--to-terms 2,3] [--allow-drop] [--dry]');
  console.log('  node src/scripts/set-fees.js "<school>" price "<optional fee>" "<classes>" <term(s)> <amount|none> [--allow-drop] [--dry]');
  console.log('  node src/scripts/set-fees.js "<school>" show ["<class>"]');
  console.log('Example:');
  console.log('  node src/scripts/set-fees.js "Mwangaza" set "Grade 1..Grade 3" 1,2,3 --fee "Tuition=50000" --optional "Lunch=3000" --new');
  console.log('Tip: put every name that has a space in "double quotes". Classes: use a comma between classes, or .. for a range.');
}

const m = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
const list = (items) => items.map((i) => `${i.name} ${m(i.amount)}`).join(', ');

function printOverview(o) {
  console.log(`\nSchool: ${o.school.name}   (fees are the latest version of each class's template; billing locks them when a term starts)\n`);
  for (const c of o.classes) {
    const cells = c.terms.map((t) => (t.set ? `T${t.term} v${t.version} ${m(t.grand_total)}` : `T${t.term} not set`));
    console.log(`${c.name.padEnd(10)} ${cells.join('   ')}`);
  }
  console.log('');
}

function printClass(o) {
  console.log(`\nSchool: ${o.school.name}   Class: ${o.class.name}\n`);
  for (const t of o.terms) {
    if (!t.set) { console.log(`Term ${t.term}: not set\n`); continue; }
    console.log(`Term ${t.term}  latest = version ${t.latest.version}  (saved ${t.latest.created})`);
    console.log(`   fees everyone pays: ${list(t.latest.mandatory) || '-'}   (total ${m(t.latest.mandatory_total)})`);
    console.log(`   optional:           ${list(t.latest.optional) || '-'}   (total ${m(t.latest.optional_total)})`);
    console.log(`   grand total:        ${m(t.latest.grand_total)}`);
    if (t.locked.length) console.log(`   locked into: ${t.locked.map((l) => `${l.label} (v${l.version})`).join(', ')}`);
    if (t.versions.length > 1) console.log(`   older versions: ${t.versions.slice(1).map((v) => 'v' + v.version).join(', ')}`);
    console.log('');
  }
}

function printChange(r, verb) {
  console.log(r.dry ? '\nDRY RUN: everything checks out. Nothing was changed.\n' : '\nDone.\n');
  for (const c of r.classes) {
    const name = `${c.class} Term ${c.term}`.padEnd(18);
    if (c.unchanged) console.log(`${name} already exactly like that (version ${c.version}). No change.`);
    else console.log(`${name} ${r.dry ? 'would become' : 'now'} version ${c.version}${c.previous ? ` (version ${c.previous} kept in history)` : ''}: ${list(c.mandatory)}${c.optional.length ? '   optional: ' + list(c.optional) : ''}`);
    for (const d of c.drops) console.log(`                   ${d.students} ${d.students === 1 ? 'student loses' : 'students lose'} "${d.name}" at the next billing.`);
  }
  if (r.addedToList && r.addedToList.length) console.log(`\n${r.dry ? 'Would add' : 'Added'} to the school's optional fee list: ${r.addedToList.join(', ')}`);
  console.log('\nBilling is automatic: the latest version is locked for a term on its first day. A term already billed is not changed by this.');
}

(async () => {
  try {
    if (unknown.length) { console.error('Unknown option: ' + unknown.join(', ')); usage(); process.exit(1); }
    const [ref, command, ...rest] = positional;
    if (!ref || !command) { usage(); process.exit(1); }
    const school = await findSchool(ref);
    let finished = false;

    if (command === 'show') {
      if (rest.length > 1) { usage(); process.exit(1); }
      if (!rest.length) printOverview(await svc.overview(school.id));
      else {
        const hit = svc.expandClasses((await require('../db/db').pool.query(
          `SELECT c.id, c.name, c.sort_order, COALESCE(sc.enabled, FALSE) AS enabled FROM classes c LEFT JOIN school_classes sc ON sc.class_id = c.id AND sc.school_id = $1 ORDER BY c.sort_order`, [school.id])).rows, [rest[0]]);
        if (hit.length !== 1) { console.error('Name one class.'); process.exit(1); }
        printClass(await svc.classFees(school.id, hit[0].id));
      }
      process.exit(0);
    } else if (command === 'optional') {
      const [sub, name] = rest;
      if (sub === 'list' && rest.length === 1) {
        const r = await svc.listOptionalNames(school.id);
        console.log(r.names.length ? `\n${school.name} optional fees:\n  ${r.names.join('\n  ')}\n` : `\n${school.name} has no optional fees listed yet. Example: optional add "Lunch"\n`);
        process.exit(0);
      }
      if ((sub === 'add' || sub === 'remove') && rest.length === 2) {
        const r = sub === 'add' ? await svc.addOptionalName(school.id, name, { dry: flags.dry }) : await svc.removeOptionalName(school.id, name, { dry: flags.dry });
        console.log(flags.dry ? '\nDRY RUN: that would work. Nothing was changed.' : `\nDone. "${r.name}" ${sub === 'add' ? 'added to' : 'removed from'} ${school.name}'s optional fee list.`);
        finished = true;
      } else { usage(); process.exit(1); }
    } else if (command === 'set') {
      if (rest.length !== 2) { usage(); process.exit(1); }
      const r = await svc.setFees(school.id, { classNames: [rest[0]], terms: rest[1].split(','), fees, optional, newOptional: flags.new, allowDrop: flags.allowDrop, dry: flags.dry });
      printChange(r);
      finished = true;
    } else if (command === 'copy') {
      if (rest.length !== 2) { usage(); process.exit(1); }
      const r = await svc.copyFees(school.id, { fromClass: rest[0], fromTerm: rest[1], toClasses: toClasses ? [toClasses] : [], toTerms: toTerms ? toTerms.split(',') : null, allowDrop: flags.allowDrop, dry: flags.dry });
      console.log(`\nCopying from ${r.from.class} Term ${r.from.term} (version ${r.from.version}).`);
      printChange(r);
      finished = true;
    } else if (command === 'price') {
      if (rest.length !== 4) { usage(); process.exit(1); }
      const [name, classes, terms, amount] = rest;
      const all = (await require('../db/db').pool.query(
        `SELECT c.id, c.name, c.sort_order, COALESCE(sc.enabled, FALSE) AS enabled FROM classes c LEFT JOIN school_classes sc ON sc.class_id = c.id AND sc.school_id = $1 ORDER BY c.sort_order`, [school.id])).rows;
      const picked = svc.expandClasses(all, [classes]);
      const prices = [];
      for (const c of picked) for (const t of terms.split(',')) prices.push({ classId: c.id, term: t, amount: amount.toLowerCase() === 'none' ? null : amount });
      const r = await svc.setOptionalPrices(school.id, { name, prices, allowDrop: flags.allowDrop, dry: flags.dry });
      printChange(r);
      finished = true;
    }
    if (!finished) { console.error(`Unknown command "${command}".`); usage(); process.exit(1); }
    if (flags.dry) console.log('\nRun the same command without --dry to save it.\n'); else console.log('');
    process.exit(0);
  } catch (err) {
    console.error('\nNOT changed:', err.message, '\n');
    process.exit(1);
  }
})();
