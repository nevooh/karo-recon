// Promotes a school into the next academic year: shows the full plan first, and changes things ONLY with --apply.
// Promotion can be done ONCE per school per year and can NOT be undone, so the plan always comes first.
// Your future operator dashboard will use the same engine: src/services/promotion.js.
//
//   node src/scripts/promote-school.js "<school name or number>"
//       -> shows exactly what would happen. Changes NOTHING.
//   node src/scripts/promote-school.js "<school>" --repeat=ADM5,ADM9 --leave=ADM12 --stream=ADM5:Pink
//       -> the same plan, with decisions:
//          --repeat=  students who stay in their class this year
//          --leave=   students who left the school (they are not moved; their money history stays)
//          --stream=  the stream a repeater should join (otherwise the stream with the fewest students arriving)
//   node src/scripts/promote-school.js "<school>" ... --apply
//       -> does it for real (all or nothing).
//
// Rules (they are checked for you):
//   - Only after Term 3 of the year being left has ENDED (set the dates with set-terms.js).
//   - Every active student must have a class.
//   - The next year must exist (set-terms.js makes it when you set its first term).
// How students move: each student goes to the next class the school has switched ON, the last class
// graduates, and the stream NAME follows the student (new streams are made fresh for the new year).
// Put "double quotes" around anything with a space, for example "--stream=ADM5:Light Blue".

require('dotenv').config();
const { pool } = require('../db/db');
const classSetup = require('../services/classSetup');
const promo = require('../services/promotion');

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const dry = argv.includes('--dry');
const valueFlags = ['--repeat=', '--leave=', '--stream='];
const unknownFlags = argv.filter((a) => a.startsWith('--') && a !== '--apply' && a !== '--dry' && !valueFlags.some((f) => a.startsWith(f)));
const positional = argv.filter((a) => !a.startsWith('--'));
const flagValues = (name) => argv.filter((a) => a.startsWith(name)).map((a) => a.slice(name.length));

function usage() {
  console.log('Usage:');
  console.log('  node src/scripts/promote-school.js "<school name or number>"                (shows the plan, changes nothing)');
  console.log('  node src/scripts/promote-school.js "<school>" [--repeat=ADM1,ADM2] [--leave=ADM3] [--stream=ADM1:Pink]');
  console.log('  node src/scripts/promote-school.js "<school>" ... --apply                   (does it for real, once, no undo)');
}

const PLACEMENT = {
  chosen: 'stream you chose',
  nostream: 'no stream, as you chose',
  fewest: 'stream with the fewest students',
  own: 'kept his/her own stream',
  none: 'no stream',
};
const pad = (v, n) => String(v).padEnd(n);
const list = (items) => items.join(', ');

function printPlan(summary) {
  const t = summary.totals;
  console.log('WHAT WILL HAPPEN');
  console.log(pad('Class', 11) + pad('Students', 10) + pad('Promote', 9) + pad('Repeat', 8) + pad('Leave', 7) + 'Graduate');
  console.log(pad('-----', 11) + pad('--------', 10) + pad('-------', 9) + pad('------', 8) + pad('-----', 7) + '--------');
  for (const c of summary.bySource) console.log(pad(c.class_name, 11) + pad(c.students, 10) + pad(c.promote, 9) + pad(c.repeat, 8) + pad(c.leave, 7) + c.graduate);
  console.log(pad('Total', 11) + pad(t.promote + t.repeat + t.leave + t.graduate, 10) + pad(t.promote, 9) + pad(t.repeat, 8) + pad(t.leave, 7) + t.graduate + '\n');

  if (summary.arrivals.length) {
    console.log('THE NEW YEAR: who is in each class');
    for (const a of summary.arrivals) {
      const parts = a.streams.map((s) => `${s.name} ${s.count}`);
      if (a.noStream) parts.push(`no stream ${a.noStream}`);
      console.log(`  ${pad(a.class_name, 10)} ${pad(a.total + (a.total === 1 ? ' student' : ' students'), 13)} ${list(parts)}`);
    }
    console.log('');
  }
  if (summary.repeaters.length) {
    console.log('REPEATING (they stay in their class)');
    for (const r of summary.repeaters) {
      const from = r.from_stream ? `${r.class_name} ${r.from_stream}` : r.class_name;
      const to = r.to_stream ? `${r.to_class_name} ${r.to_stream}` : `${r.to_class_name} (no stream)`;
      console.log(`  ${r.admission_no}  ${r.full_name}:  ${from}  ->  ${to}   (${PLACEMENT[r.placement] || r.placement})`);
    }
    console.log('');
  }
  if (summary.leavers.length) {
    console.log('LEAVING THE SCHOOL (not moved; their money history stays)');
    for (const l of summary.leavers) console.log(`  ${l.admission_no}  ${l.full_name}  (${l.class_name}${l.stream_name ? ' ' + l.stream_name : ''})`);
    console.log('');
  }
  if (summary.graduates.length) console.log(`GRADUATING: ${summary.graduates.length} ${summary.graduates.length === 1 ? 'student' : 'students'} (${list([...new Set(summary.graduates.map((g) => g.class_name))])})\n`);
}

(async () => {
  try {
    if (unknownFlags.length) { console.error('Unknown option: ' + unknownFlags.join(', ')); usage(); process.exit(1); }
    if (positional.length !== 1) { usage(); process.exit(1); }
    if (apply && dry) { console.error('Choose one: --apply (do it) or --dry (only the plan).'); process.exit(1); }

    const school = await classSetup.findSchool(positional[0]);
    const outgoing = await promo.getSchoolActiveYear(school.id);
    if (!outgoing) throw new Error('There is no academic year yet. Set the terms first with set-terms.js.');
    console.log(`\nSchool: ${school.name}  (number ${school.id})`);

    const last = (await pool.query(
      `SELECT to_char(pr.ran_at, 'YYYY-MM-DD') AS day, ay.year FROM promotion_runs pr JOIN academic_years ay ON ay.id = pr.incoming_academic_year_id
       WHERE pr.school_id = $1 ORDER BY ay.year DESC LIMIT 1`, [school.id]).catch(() => ({ rows: [] }))).rows[0];
    if (last) console.log(`Last promotion: into ${last.year} on ${last.day}.`);

    const incoming = (await pool.query('SELECT id, year FROM academic_years WHERE year = $1', [outgoing.year + 1])).rows[0];
    console.log(`Promoting out of ${outgoing.year}` + (incoming ? ` into ${incoming.year}.\n` : '.\n'));
    if (!incoming) {
      throw new Error(`The year ${outgoing.year + 1} does not exist yet. Make it by setting its first term: node src\\scripts\\set-terms.js ${school.id} ${outgoing.year + 1} 1 <start> <end>`);
    }

    const streams = {};
    for (const v of flagValues('--stream=')) {
      const i = v.indexOf(':');
      if (i < 1) throw new Error(`--stream needs the form ADM5:Pink (got "${v}").`);
      streams[v.slice(0, i)] = v.slice(i + 1);
    }
    const split = (name) => flagValues(name).join(',').split(',').map((x) => x.trim()).filter(Boolean);
    const decisions = await promo.buildDecisions(school.id, { repeat: split('--repeat='), leave: split('--leave='), streams });

    const ready = await promo.checkPromotionReady({ schoolId: school.id, outgoingAcademicYearId: outgoing.id, incomingAcademicYearId: incoming.id });
    const classes = (await pool.query(
      `SELECT c.id, c.name, c.sort_order FROM classes c JOIN school_classes sc ON sc.class_id = c.id WHERE sc.school_id = $1 AND sc.enabled = TRUE ORDER BY c.sort_order`, [school.id])).rows;
    const plan = await promo.planPromotion({ schoolId: school.id, outgoingAcademicYearId: outgoing.id, decisions });
    const summary = promo.summarizePlan(plan, classes);

    for (const p of ready.problems) console.log('NOT READY: ' + p + '\n');
    for (const w of ready.warnings) console.log('Note: ' + w + '\n');
    for (const cmd of ready.commands) console.log('To fix, run:  ' + cmd + '\n');
    if (!plan.length) console.log('There are no active students with a class, so there is nothing to promote.\n');
    else printPlan(summary);

    if (ready.problems.length) { console.log('Nothing was changed.\n'); process.exit(1); }
    if (!plan.length) process.exit(0);

    if (!apply) {
      console.log('This was only the PLAN. Nothing was changed.');
      console.log('Promotion can be done once and cannot be undone. If the plan is right, run the same command with --apply.\n');
      process.exit(0);
    }

    const r = await promo.promoteSchool({ outgoingAcademicYearId: outgoing.id, incomingAcademicYearId: incoming.id, schoolId: school.id, decisions });
    console.log('DONE. The school is now in ' + incoming.year + '.');
    console.log(`${r.promoted.length} promoted, ${r.repeating.length} repeating, ${r.leftOrTransferred.length} left, ${r.graduated.length} graduated.\n`);
    console.log('Next: set the fees for ' + incoming.year + ' (fees are per class, and lock once a term starts), and set the term dates if you have not.');
    console.log('To see the classes now: node src/scripts/set-classes.js "' + school.name + '" show\n');
    process.exit(0);
  } catch (err) {
    console.error('\nNOT changed:', err.message, '\n');
    process.exit(1);
  }
})();