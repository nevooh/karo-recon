// Fires a fake payment at a specific school's own sandbox paybill, using
// that school's own credentials from the database.
//
// Usage: node src/scripts/simulate-payment.js <schoolId> <amount> <phone> <billRefNumber>
// Example: node src/scripts/simulate-payment.js 1 5000 254708374149 ADM101

require('dotenv').config();
const { getSchoolCredentials } = require('../services/schoolCredentials');
const { simulateC2BPayment } = require('../connectors/mpesa');

const [, , schoolId, amount, phone, billRefNumber] = process.argv;

if (!schoolId || !amount || !phone) {
  console.log('Usage: node src/scripts/simulate-payment.js <schoolId> <amount> <phone> <billRefNumber>');
  process.exit(1);
}

(async () => {
  const school = await getSchoolCredentials(Number(schoolId));
  if (!school) {
    console.error(`No school found with id ${schoolId}`);
    process.exit(1);
  }

  try {
    const data = await simulateC2BPayment({
      consumerKey: school.consumerKey,
      consumerSecret: school.consumerSecret,
      shortcode: school.shortcode,
      amount: Number(amount),
      phone,
      billRefNumber: billRefNumber || '',
    });
    console.log(`Simulated payment sent for "${school.name}". Safaricom response:`, data);
  } catch (err) {
    console.error('Simulate failed:', err.response ? err.response.data : err.message);
  }
  process.exit(0);
})();