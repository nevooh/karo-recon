/* sms.js - sends one text message (used for the parent portal sign-in code) through Celcom Africa.
   Settings (.env):
     SMS_PROVIDER    'celcom'   (leave empty while testing: nothing is sent, the code shows in the terminal and on the sign-in screen)
     SMS_API_KEY     your Celcom API key         (Celcom dashboard: "Get API key & Partner ID")
     SMS_PARTNER_ID  your Celcom partner ID
     SMS_SENDER_ID   your approved sender name (Celcom calls it the "shortcode")
     SMS_URL         optional: the send address, if Celcom gave you a different one than the default below
     SMS_PRINT_CODE  'true' = ALSO print every text (so the sign-in code) in the terminal, even in production. Outside production
                     it is always printed. Turn it off in production once Celcom is proven: a code in a log is a code anyone with the log can use.
   With SMS_PROVIDER set, the text is sent to Celcom AND (outside production / with SMS_PRINT_CODE=true) printed in the terminal. */

const DEFAULT_URL = 'https://isms.celcomafrica.com/api/services/sendsms/';
const configured = () => Boolean(process.env.SMS_PROVIDER && process.env.SMS_API_KEY && process.env.SMS_PARTNER_ID && process.env.SMS_SENDER_ID);
// "dev mode" = nothing is really sent, so the code is also handed to the sign-in screen
const devMode = () => !configured() && process.env.NODE_ENV !== 'production';
const printIt = () => process.env.SMS_PRINT_CODE === 'true' || process.env.NODE_ENV !== 'production';

function refuse(message, status = 400) { const e = new Error(message); e.status = status; return e; }

// to: 2547XXXXXXXX. deps.fetch lets tests replace the network.
async function sendSms({ to, text }, deps = {}) {
  const doFetch = deps.fetch || fetch;
  if (printIt()) console.log('\n[sms ' + (configured() ? 'sent to Celcom and printed here' : 'not set up - printed instead of sent') + ']\n  To: ' + to + '\n  ' + text + '\n');
  if (!configured()) {
    if (process.env.NODE_ENV === 'production') throw refuse('Sign-in by text message is not set up on the server yet.', 503);
    return { sent: false, dev: true };
  }
  if (String(process.env.SMS_PROVIDER).toLowerCase() !== 'celcom') throw new Error('SMS_PROVIDER must be "celcom".');
  let res;
  try {
    res = await doFetch(process.env.SMS_URL || DEFAULT_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ apikey: process.env.SMS_API_KEY, partnerID: process.env.SMS_PARTNER_ID, shortcode: process.env.SMS_SENDER_ID, mobile: String(to).replace(/^\+/, ''), message: text, pass_type: 'plain' }),
    });
  } catch (err) { console.error('Celcom could not be reached:', err.message); throw refuse('The text message service could not be reached. Please try again in a moment.', 502); }
  let body = null, raw = '';
  try { raw = await res.text(); body = JSON.parse(raw); } catch (e) { /* not JSON: judged below */ }
  if (!res.ok) { console.error('Celcom refused (HTTP ' + res.status + '): ' + String(raw).slice(0, 300)); throw refuse('The text message could not be sent. Please try again later.', 502); }
  // Celcom answers { responses: [ { "respose-code": 200, "response-description": "Success", mobile, messageid, ... } ] }
  // ("respose" is spelt that way in their own replies, so both spellings are read). 200 = accepted.
  const r = body && Array.isArray(body.responses) ? body.responses[0] : null;
  if (!r) { console.error('Celcom reply not understood, treating the text as NOT sent: ' + String(raw).slice(0, 300)); throw refuse('The text message could not be sent. Please try again later.', 502); }
  const code = Number(r['respose-code'] !== undefined ? r['respose-code'] : r['response-code']);
  if (code !== 200) { console.error('Celcom did not accept the text: ' + code + ' ' + (r['response-description'] || '')); throw refuse('The text message could not be sent. Please try again later.', 502); }
  return { sent: true, dev: false, messageId: r.messageid || null };
}

module.exports = { sendSms, configured, devMode, DEFAULT_URL };
