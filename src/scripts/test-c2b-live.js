// Posts a FAKE Safaricom C2B payment straight to your live server, the way Safaricom would.
// It proves your server accepts and books a payment without needing Safaricom's sandbox to call you.
//
// Needs, in the CMD window (these only last for that window):
//   set DATABASE_URL=<your Supabase Session pooler string>
//   set ENCRYPTION_KEY=<the SAME ENCRYPTION_KEY as on Render>   (needed to read the school's secret code)
// Usage:
//   node src/scripts/test-c2b-live.js <https://your-server> <paybill> <amount> <admission_no>
// Example:
//   node src/scripts/test-c2b-live.js https://karo-recon.onrender.com 600980 500 101
require('dotenv').config();
const { pool } = require('../db/db');
const { reveal } = require('../services/mpesaUrlToken');

const [, , base, shortcode, amount, bill] = process.argv;
if (!base || !shortcode || !amount || !bill) {
  console.log('Usage: node src/scripts/test-c2b-live.js <https://your-server> <paybill> <amount> <admission_no>');
  process.exit(1);
}
(async () => {
  try {
    const s = (await pool.query('SELECT id, name, mpesa_url_token_enc FROM schools WHERE mpesa_shortcode = $1', [shortcode])).rows[0];
    if (!s) throw new Error('No school has Paybill ' + shortcode + ' in this database.');
    const token = reveal(s.mpesa_url_token_enc);
    if (!token) throw new Error('Could not read the school\'s secret code. Is ENCRYPTION_KEY the same as on Render, and are the addresses registered?');
    const url = base.replace(/\/+$/, '') + '/webhooks/c2b/' + token + '/confirmation';
    const transId = 'TEST' + Date.now().toString(36).toUpperCase();
    const body = { TransactionType: 'Pay Bill', TransID: transId, TransTime: new Date().toISOString().replace(/\D/g, '').slice(0, 14), TransAmount: String(amount), BusinessShortCode: String(shortcode), BillRefNumber: String(bill), InvoiceNumber: '', OrgAccountBalance: '0.00', ThirdPartyTransID: '', MSISDN: '254708374149', FirstName: 'Test', MiddleName: '', LastName: 'Payer' };
    console.log('School:', s.name, '(id ' + s.id + ')');
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    console.log('Server answered', r.status, await r.text());
    console.log('Receipt code used:', transId, '- now check the school\'s Payments page.');
  } catch (e) { console.error('Failed:', e.message); process.exitCode = 1; }
  finally { await pool.end(); }
})();