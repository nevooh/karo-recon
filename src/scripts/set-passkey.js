// Saves a school's STK push passkey (from Safaricom), or shows whether it is set. The passkey is typed hidden,
// so it never lands in the command history, and it is never printed. Same engine as the rest: services/mpesaPasskey.js.
//
// Usage:
//   node src/scripts/set-passkey.js show <school>
//   node src/scripts/set-passkey.js <school> [--replace]
//
// <school> is the school's number or exact name. The school must already have its Paybill and M-Pesa keys saved.

require('dotenv').config();
const readline = require('readline');
const { pool } = require('../db/db');
const { passkeyState, savePasskey } = require('../services/mpesaPasskey');

const argv = process.argv.slice(2);
const replace = argv.includes('--replace');
const positional = argv.filter((a) => !a.startsWith('--'));
const unknown = argv.filter((a) => a.startsWith('--') && a !== '--replace');

function usage() {
  console.log('Usage:');
  console.log('  node src/scripts/set-passkey.js show <school>');
  console.log('  node src/scripts/set-passkey.js <school> [--replace]');
}

async function findSchool(text) {
  const byId = /^\d+$/.test(text) ? (await pool.query('SELECT id, name FROM schools WHERE id = $1', [Number(text)])).rows[0] : null;
  if (byId) return byId;
  const byName = (await pool.query('SELECT id, name FROM schools WHERE LOWER(name) = LOWER($1)', [text])).rows;
  if (byName.length === 1) return byName[0];
  throw new Error(byName.length > 1 ? `More than one school is called "${text}". Use its number.` : `No school "${text}". Use its number or exact name.`);
}

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = function (s) { if (!rl.muted) rl.output.write(s); };
    let done = false;
    rl.on('close', () => { if (!done) { done = true; resolve(''); } });   // input closed with nothing typed
    rl.question(question, (answer) => { done = true; rl.close(); process.stdout.write('\n'); resolve(answer); });
    rl.muted = true;
  });
}

(async () => {
  if (unknown.length || positional.length === 0) { usage(); process.exitCode = 1; return; }
  const show = positional[0] === 'show';
  const schoolText = show ? positional[1] : positional[0];
  if (!schoolText) { usage(); process.exitCode = 1; return; }
  const school = await findSchool(schoolText);
  const st = await passkeyState(school.id);

  if (show) {
    console.log(`\n${st.name} (school ${st.id})`);
    console.log(`  Paybill:  ${st.shortcode || 'not set'}`);
    console.log(`  M-Pesa keys: ${st.hasKeys ? 'set' : 'not set'}`);
    console.log(`  STK passkey: ${st.hasPasskey ? 'set' : 'not set'}\n`);
    return;
  }

  if (!st.shortcode || !st.hasKeys) throw new Error(`${st.name} has no M-Pesa Paybill and keys saved yet. Set up M-Pesa first, then add the passkey.`);
  if (st.hasPasskey && !replace) throw new Error(`${st.name} already has a passkey. To change it, run again with --replace.`);
  console.log(`\nSchool: ${st.name} (Paybill ${st.shortcode})`);
  const typed = await askHidden('Paste the passkey (you will not see it) and press Enter: ');
  const res = await savePasskey(school.id, typed, { replace });
  console.log(res.replaced ? `\nDone. The passkey for ${res.school} was replaced.\n` : `\nDone. The passkey for ${res.school} is saved (encrypted).\n`);
})().catch((e) => { console.error('\nNot saved: ' + e.message + '\n'); process.exitCode = 1; }).finally(() => pool.end());