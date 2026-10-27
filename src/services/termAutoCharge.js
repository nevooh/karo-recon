const { billAllSchools } = require('./termBilling');

// Billing is automatic. It runs when the server starts and then every hour, so a term is billed on (or within an
// hour of) its first day, and a class whose fees were set a little late is billed soon after. Most runs find
// nothing to do: a class already billed for the term is skipped, never charged again (see termBilling.js).
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

let isChecking = false; // guards against overlapping runs in this process (the database guards across processes)

async function checkAndBill() {
  if (isChecking) return null;
  isChecking = true;
  try {
    const r = await billAllSchools();
    for (const b of r.billed) console.log(`Billed ${b.school}, ${b.term}: ${b.classes} class(es), ${b.students} student(s).`);
    for (const f of r.failed) console.error(`Billing failed for school ${f.school_id} (nothing was changed for it): ${f.error}`);
    return r;
  } finally {
    isChecking = false;
  }
}

function startTermAutoCharge() {
  // Once right away (a term that started while the server was off must not wait an hour), then hourly.
  checkAndBill().catch((err) => console.error('Billing check failed:', err.message));
  setInterval(() => { checkAndBill().catch((err) => console.error('Billing check failed:', err.message)); }, CHECK_INTERVAL_MS);
  console.log('Automatic billing started (checked every hour)');
}

module.exports = { checkAndBill, startTermAutoCharge };
