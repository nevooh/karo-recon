// One command to get a full LOCAL test ready:
//   - a test school (name of your choice)
//   - 5 students (some "ADM101" style, one plain "356" style)
//   - the current term with fees charged (so balances show on screen)
//   - an easy login for the screens
//   - and it PRINTS the test-payment commands for you to copy
//
// Usage (CMD, inside the karo-recon folder):
//   node src/scripts/test-setup.js "Your School Name"
// Optional: pick your own login:
//   node src/scripts/test-setup.js "Your School Name" me@test.com mypassword1
//
// Safe to run again: it reuses the school if the name already exists.
// For local testing only - do not use easy passwords on a real server.
require('dotenv').config();
const { pool } = require('../db/db');
const { hashPassword } = require('../security/auth');
const { createSchoolWithCredentials } = require('../services/schoolCredentials');
const { getCurrentTerm } = require('../services/feeLedger');

const schoolName = process.argv[2] || 'Test High School';
const email = process.argv[3] || 'admin@test.com';
const password = process.argv[4] || 'test1234';   // must be at least 8 characters
const SHORTCODE = '600000';                        // the fake paybill number used by the test payments

const STUDENTS = [
  ['ADM101', 'Jane Wanjiku', 'Grace Wanjiku', '254711000001'],
  ['ADM102', 'John Otieno', 'Peter Otieno', '254711000002'],
  ['ADM201', 'Brian Mwangi', 'Samuel Mwangi', '254722000001'],
  ['ADM202', 'Cynthia Mwangi', 'Samuel Mwangi', '254722000001'],
  ['356', 'Mary Akinyi', 'Rose Akinyi', '254711000003'],
];

async function main() {
  // 1. the school
  let school = (await pool.query('SELECT id, name, mpesa_shortcode FROM schools WHERE name = $1', [schoolName])).rows[0];
  if (!school) {
    try {
      school = await createSchoolWithCredentials({
        name: schoolName, mpesaShortcode: SHORTCODE, mpesaConsumerKey: 'test-key', mpesaConsumerSecret: 'test-secret',
      });
    } catch (err) {
      if (err.code === '23505') {
        console.error(`Another school already uses the test paybill ${SHORTCODE}. Run this once to see them:`);
        console.error('  psql -U postgres -d karo_recon -c "select id, name, mpesa_shortcode from schools"');
      } else console.error(err.message);
      process.exit(1);
    }
  }
  const shortcode = school.mpesa_shortcode || SHORTCODE;

  // 2. the students
  for (const [adm, name, gName, gPhone] of STUDENTS) {
    await pool.query(
      `INSERT INTO students (school_id, admission_no, full_name, guardian_name, guardian_phone)
       SELECT $1, $2, $3, $4, $5
       WHERE NOT EXISTS (SELECT 1 FROM students WHERE school_id = $1 AND admission_no = $2)`,
      [school.id, adm, name, gName, gPhone]
    );
  }

  // 3. a current term, with fees charged so balances show up
  let term = await getCurrentTerm();
  if (!term) {
    const year = new Date().getFullYear();
    await pool.query('INSERT INTO academic_years (year, is_current) VALUES ($1, TRUE) ON CONFLICT (year) DO UPDATE SET is_current = TRUE', [year]);
    await pool.query(
      `INSERT INTO terms (academic_year_id, term_number, start_date, is_current)
       SELECT id, 1, CURRENT_DATE, TRUE FROM academic_years WHERE year = $1
       ON CONFLICT (academic_year_id, term_number) DO UPDATE SET is_current = TRUE`, [year]);
    term = await getCurrentTerm();
  }
  await pool.query(
    `INSERT INTO student_term_ledger (student_id, term_id, fees_charged)
     SELECT s.id, $2, 20000 FROM students s WHERE s.school_id = $1
     ON CONFLICT DO NOTHING`, [school.id, term.id]);

  // 4. the login
  const hash = await hashPassword(password);
  await pool.query(
    `INSERT INTO staff (school_id, full_name, email, password_hash) VALUES ($1, $2, $3, $4)
     ON CONFLICT (school_id, email) DO UPDATE SET password_hash = $4, status = 'active'`,
    [school.id, 'Test Admin', email, hash]);

  // 5. print what to do next
  const port = process.env.PORT || 3000;
  const stamp = Date.now().toString().slice(-6);   // makes the payment ids new each time you run this script
  const curl = (id, amount, ref, extra) => {
    const body = Object.assign({ TransID: id + stamp, TransAmount: String(amount), BusinessShortCode: shortcode, BillRefNumber: ref }, extra || {});
    const json = JSON.stringify(body).replace(/"/g, '\\"');
    return `curl -X POST http://localhost:${port}/webhooks/mpesa/confirmation -H "Content-Type: application/json" -d "${json}"`;
  };
  const line = '='.repeat(64);
  console.log(`\n${line}\nREADY.  School: "${school.name}" (id ${school.id})   Paybill: ${shortcode}\n`);
  console.log(`Login at  http://localhost:${port}\n  email:    ${email}\n  password: ${password}\n`);
  console.log('Students:  ADM101 Jane Wanjiku | ADM102 John Otieno | ADM201 Brian Mwangi | ADM202 Cynthia Mwangi | 356 Mary Akinyi');
  console.log('Each student was charged KES 20,000 this term.\n');
  console.log('Start the server in ANOTHER CMD window (npm start), then paste these one by one in this window.');
  console.log('Each shows what should happen:\n');
  console.log('1) Should AUTO-MATCH to Jane (ADM101):');
  console.log('   ' + curl('A', 5000, 'ADM101') + '\n');
  console.log('2) Should AUTO-MATCH to Mary (her number is plain "356"):');
  console.log('   ' + curl('B', 4000, '356') + '\n');
  console.log('3) Should AUTO-MATCH to John (typed messily):');
  console.log('   ' + curl('C', 3000, 'adm 102 fees') + '\n');
  console.log('4) Should go to NEEDS REVIEW (two students in one reference):');
  console.log('   ' + curl('D', 6000, 'ADM201 and ADM202') + '\n');
  console.log('5) Should be UNMATCHED (only a name, no number). Find the student by hand on the Review screen:');
  console.log('   ' + curl('E', 2500, 'Mary Akinyi school fees', { MSISDN: '254700111222', FirstName: 'Peter', LastName: 'Mwangi' }) + '\n');
  console.log('6) Should be UNMATCHED (no reference at all):');
  console.log('   ' + curl('F', 1500, '') + '\n');
  console.log('Each command should answer {"ResultCode":0,"ResultDesc":"Accepted"}.');
  console.log('Sending the SAME command twice does nothing the second time (duplicates are ignored). Run this setup script again to get fresh commands.');
  console.log(line + '\n');
  await pool.end();
}

main().catch((err) => { console.error(err.message); process.exit(1); });
