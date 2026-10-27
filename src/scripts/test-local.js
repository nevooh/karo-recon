// Runs the whole local test in one go: seeds a school, fires a clean
// payment (should auto-match) and a messy one (should NOT auto-match),
// then prints the results so you can see the matching engine working.
//
// Usage: node src/scripts/test-local.js
// (make sure your server is already running in another terminal: npm start)

const BASE = 'http://localhost:3000';

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function get(path) {
  const res = await fetch(BASE + path);
  return res.json();
}

async function main() {
  console.log('0. Resetting local test data (clean slate)...');
  await post('/api/dev/reset', {});

  console.log('1. Seeding test school + 2 students...');
  const seed = await post('/api/dev/seed-school', {
    name: 'Test Academy',
    mpesa_shortcode: '600000',
    students: [
      { admission_no: 'ADM101', full_name: 'John Otieno Omondi', guardian_phone: '254712345678', balance: 5000 },
      { admission_no: 'ADM102', full_name: 'Mary Wanjiku Kamau', guardian_phone: '254722334455', balance: 3000 },
    ],
  });
  console.log('   ->', seed);
  const schoolId = seed.schoolId;

  console.log('\n2. Sending a clean payment (correct phone + reference) - should AUTO-MATCH...');
  const clean = await post('/webhooks/mpesa/confirmation', {
    TransID: 'LOCALTEST-' + Date.now() + '-A',
    TransAmount: '5000',
    BusinessShortCode: '600000',
    BillRefNumber: 'ADM101',
    MSISDN: '254712345678',
    FirstName: 'John',
    LastName: 'Omondi',
  });
  console.log('   -> Safaricom-style response:', clean);

  console.log('\n3. Sending a messy payment (unknown phone, no reference) - should NOT auto-match...');
  const messy = await post('/webhooks/mpesa/confirmation', {
    TransID: 'LOCALTEST-' + Date.now() + '-B',
    TransAmount: '3000',
    BusinessShortCode: '600000',
    BillRefNumber: 'school fees',
    MSISDN: '254799999999',
    FirstName: 'Mary',
    LastName: 'Kamau',
  });
  console.log('   -> Safaricom-style response:', messy);

  console.log('\n4. Checking summary for the school...');
  const summary = await get(`/api/schools/${schoolId}/summary`);
  console.log('   ->', summary);

  console.log('\n5. Checking the unmatched bucket (the messy payment should be here)...');
  const unmatched = await get(`/api/schools/${schoolId}/unmatched`);
  console.log('   ->', unmatched);

  console.log('\n6. Checking the review queue...');
  const reviewQueue = await get(`/api/schools/${schoolId}/review-queue`);
  console.log('   ->', reviewQueue);

  console.log('\nDone. Expected result: summary shows 1 auto_matched (5000), unmatched bucket shows 1 item (3000).');
}

main().catch((err) => {
  console.error('Test script failed:', err.message);
  console.error('Is your server running? (npm start, in another terminal)');
});
