// Sets up a school's classes and streams from the terminal.
// The school can be given by its NAME (in "double quotes") or its NUMBER.
// Your future operator dashboard will use the same engine: src/services/classSetup.js.
//
// See the schools and their numbers:
//   node src/scripts/set-classes.js schools
// Look at a school's classes:
//   node src/scripts/set-classes.js "<school>" show
// The school runs one range of classes (these two and everything between are ON, all others OFF):
//   node src/scripts/set-classes.js "<school>" range "Grade 7" "Grade 12"
// Switch single classes on or off:
//   node src/scripts/set-classes.js "<school>" on "Grade 7" "Grade 8"
//   node src/scripts/set-classes.js "<school>" off "Grade 7"
// Streams (for the academic year the school is in; set the terms first):
//   node src/scripts/set-classes.js "<school>" add-stream "Grade 7" North
//   node src/scripts/set-classes.js "<school>" rename-stream "Grade 7" North Blue
//   node src/scripts/set-classes.js "<school>" remove-stream "Grade 7" North
// Moving students between streams of THEIR OWN class (by admission number), any time of the term:
//   node src/scripts/set-classes.js "<school>" move "Grade 7" South ADM343 ADM344
//   node src/scripts/set-classes.js "<school>" move "Grade 7" Gold ADM343 ADM344 --create    (makes the stream Gold first)
// Merging two streams of the same class (everyone moves, the empty one is removed):
//   node src/scripts/set-classes.js "<school>" merge-streams "Grade 7" East South
//
// Add --dry to any change: everything is checked and NOTHING is changed.
// Good to know: promotion moves a student to the NEXT switched-on class, and the LAST switched-on
// class is where students graduate. A class that has students can not be switched off.

require('dotenv').config();
const svc = require('../services/classSetup');

const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const create = argv.includes('--create');
const unknownFlags = argv.filter((a) => a.startsWith('--') && a !== '--dry' && a !== '--create');
const positional = argv.filter((a) => !a.startsWith('--'));

function usage() {
  console.log('Usage:');
  console.log('  node src/scripts/set-classes.js schools');
  console.log('  node src/scripts/set-classes.js "<school name or number>" show');
  console.log('  node src/scripts/set-classes.js "<school>" range "<first class>" "<last class>" [--dry]');
  console.log('  node src/scripts/set-classes.js "<school>" on "<class>" ["<class>" ...] [--dry]');
  console.log('  node src/scripts/set-classes.js "<school>" off "<class>" ["<class>" ...] [--dry]');
  console.log('  node src/scripts/set-classes.js "<school>" add-stream "<class>" <stream> [--dry]');
  console.log('  node src/scripts/set-classes.js "<school>" rename-stream "<class>" <old name> <new name> [--dry]');
  console.log('  node src/scripts/set-classes.js "<school>" remove-stream "<class>" <stream> [--dry]');
  console.log('  node src/scripts/set-classes.js "<school>" move "<class>" <to stream> <admission no> [<admission no> ...] [--create] [--dry]');
  console.log('  node src/scripts/set-classes.js "<school>" merge-streams "<class>" <from stream> <into stream> [--dry]');
  console.log('Example:');
  console.log('  node src/scripts/set-classes.js "Mwangaza Girls High" range "Grade 7" "Grade 12"');
  console.log('Tip: put every name that has a space in "double quotes".');
}

function printOverview(o) {
  console.log(`\nSchool: ${o.school.name}  (number ${o.school.id})`);
  console.log(o.year ? `Academic year this school is in: ${o.year.year}\n` : 'Academic year: none yet (set the terms first, with set-terms.js)\n');
  console.log('Class       Status  Students  Streams');
  console.log('----------  ------  --------  -------');
  for (const c of o.classes) {
    const streams = c.streams.length ? c.streams.map((s) => `${s.name} (${s.students})`).join(', ') : '';
    console.log(`${c.name.padEnd(10)}  ${(c.enabled ? 'ON' : 'off').padEnd(6)}  ${(c.enabled || c.students ? String(c.students) : '-').padEnd(8)}  ${streams}`);
  }
  console.log('');
  if (o.first) {
    console.log(`First class: ${o.first}.   Last class: ${o.last} (students graduate after it).`);
  } else {
    console.log('No class is switched on yet. Example: node src/scripts/set-classes.js "' + o.school.name + '" range "Grade 7" "Grade 12"');
  }
  for (const w of o.warnings) console.log('Note: ' + w);
  console.log('');
}


(async () => {
  try {
    if (unknownFlags.length) { console.error('Unknown option: ' + unknownFlags.join(', ')); usage(); process.exit(1); }

    if (positional[0] === 'schools' && positional.length === 1 && !dry) {
      const rows = await svc.listSchools();
      console.log(rows.length ? '\nNumber  School\n------  ------' : '\nNo schools yet. Make one with create-school.js.');
      rows.forEach((r) => console.log(`${String(r.id).padEnd(6)}  ${r.name}`));
      console.log('');
      process.exit(0);
    }

    const [ref, command, ...rest] = positional;
    if (!ref || !command) { usage(); process.exit(1); }
    const school = await svc.findSchool(ref);

    if (command === 'show') {
      if (rest.length || dry) { usage(); process.exit(1); }
      printOverview(await svc.getOverview(school.id));
      process.exit(0);
    }

    let said;   // the lines to print after the change
    const head = () => console.log(dry ? '\nDRY RUN: everything checks out. Nothing was changed.\n' : '\nDone.\n');

    if (command === 'range' || command === 'on' || command === 'off') {
      if (!rest.length) { usage(); process.exit(1); }
      const r = await svc.setClasses(school.id, { mode: command, names: rest, dry });
      if (r.unchanged) {
        console.log(`\nNothing to change: ${school.name} already has exactly that.`);
      } else {
        head();
        if (r.switchedOn.length) console.log(`${dry ? 'Would switch ON' : 'Switched ON'}:  ${r.switchedOn.join(', ')}`);
        if (r.switchedOff.length) console.log(`${dry ? 'Would switch OFF' : 'Switched OFF'}: ${r.switchedOff.join(', ')}`);
        if (dry) {   // after a real change the full picture below already shows all of this
          console.log(`\nClasses ON: ${r.enabled.length ? r.enabled.join(', ') : 'none'}`);
          if (r.first) console.log(`First class: ${r.first}.   Last class: ${r.last} (students graduate after it).`);
          for (const w of r.warnings) console.log('\nNote: ' + w);
        }
      }
      said = true;
    } else if (command === 'add-stream') {
      if (rest.length !== 2) { usage(); process.exit(1); }
      const r = await svc.addStream(school.id, { className: rest[0], streamName: rest[1], dry });
      head();
      console.log(`${dry ? 'Would add' : 'Added'} the stream "${r.stream}" to ${r.class} for ${r.year}.`);
      said = true;
    } else if (command === 'rename-stream') {
      if (rest.length !== 3) { usage(); process.exit(1); }
      const r = await svc.renameStream(school.id, { className: rest[0], oldName: rest[1], newName: rest[2], dry });
      if (r.unchanged) console.log(`\nNothing to change: the stream is already called "${r.stream}".`);
      else { head(); console.log(`${dry ? 'Would rename' : 'Renamed'} ${r.class} "${r.from}" to "${r.stream}" (${r.year}).`); }
      said = true;
    } else if (command === 'remove-stream') {
      if (rest.length !== 2) { usage(); process.exit(1); }
      const r = await svc.removeStream(school.id, { className: rest[0], streamName: rest[1], dry });
      head();
      console.log(`${dry ? 'Would remove' : 'Removed'} the stream "${r.stream}" from ${r.class} (${r.year}).`);
      said = true;
    }

    else if (command === 'move') {
      if (rest.length < 3) { usage(); process.exit(1); }
      const [className, toStream, ...admissionNos] = rest;
      const r = await svc.moveStudents(school.id, { className, toStream, admissionNos, create, dry });
      if (r.unchanged) {
        console.log(`\nNothing to change: ${r.alreadyThere.length === 1 ? 'that student is' : 'those students are'} already in ${r.class} ${r.stream}.`);
      } else {
        head();
        if (r.created) console.log(`${dry ? 'Would make' : 'Made'} the stream "${r.stream}" in ${r.class} for ${r.year}.`);
        console.log(`${dry ? 'Would move' : 'Moved'} ${r.moved.length} ${r.moved.length === 1 ? 'student' : 'students'} into ${r.class} ${r.stream}:`);
        r.moved.forEach((m) => console.log(`  ${m.admission_no}  ${m.full_name}:  ${m.from || 'no stream'}  ->  ${r.stream}`));
        if (r.alreadyThere.length) console.log(`Already there (skipped): ${r.alreadyThere.join(', ')}`);
      }
      said = true;
    } else if (command === 'merge-streams') {
      if (rest.length !== 3) { usage(); process.exit(1); }
      const r = await svc.mergeStreams(school.id, { className: rest[0], fromStream: rest[1], intoStream: rest[2], dry });
      head();
      console.log(`${dry ? 'Would merge' : 'Merged'} ${r.class} "${r.from}" into "${r.into}" (${r.year}).`);
      console.log(`${r.moved} ${r.moved === 1 ? 'student' : 'students'} ${dry ? 'would move' : 'moved'}` + (r.pastMoved ? ` (and ${r.pastMoved} who already left ${r.pastMoved === 1 ? 'was' : 'were'} re-pointed)` : '') + '.');
      console.log(r.removed ? `The empty stream "${r.from}" ${dry ? 'would be' : 'was'} removed.` : `The stream "${r.from}" stays, empty.`);
      for (const w of r.warnings.filter((x) => !/stays/.test(x))) console.log('\nNote: ' + w);
      said = true;
    }

    if (!said) { console.error(`Unknown command "${command}".`); usage(); process.exit(1); }
    if (dry) console.log('\nRun the same command without --dry to save it.\n');
    else printOverview(await svc.getOverview(school.id));
    process.exit(0);
  } catch (err) {
    console.error('\nNOT changed:', err.message, '\n');
    process.exit(1);
  }
})();