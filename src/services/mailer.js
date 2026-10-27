/* mailer.js - sends the invite / reset / confirm-email messages.
   Settings (.env):
     APP_URL        the address people open, e.g. https://fees.myschool.co.ke   (default http://localhost:PORT)
     MAIL_PROVIDER  'resend' or 'brevo'   (leave empty while testing locally)
     MAIL_API_KEY   the provider's API key
     MAIL_FROM      the sender, e.g. "Karo Recon <no-reply@yourdomain.co.ke>" (must be a sender the provider has verified)
   With no provider set the mail is NOT sent: it is printed in the terminal and, outside production, the link is also
   handed back to the Staff page ("dev mode") so everything can be tried locally. In production nothing is ever shown to the admin. */

const appUrl = () => String(process.env.APP_URL || 'http://localhost:' + (process.env.PORT || 3000)).replace(/\/+$/, '');
const configured = () => Boolean(process.env.MAIL_PROVIDER && process.env.MAIL_API_KEY && process.env.MAIL_FROM);
const devMode = () => !configured() && process.env.NODE_ENV !== 'production';

const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const parseFrom = (f) => { const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(f); return m ? { name: m[1].replace(/^"|"$/g, ''), email: m[2] } : { name: '', email: f.trim() }; };

// deps.fetch lets tests replace the network.
async function sendMail({ to, subject, text, html }, deps = {}) {
  const doFetch = deps.fetch || fetch;
  if (!configured()) {
    if (process.env.NODE_ENV !== 'production') console.log('\n[mail not set up - printed instead of sent]\n  To: ' + to + '\n  Subject: ' + subject + '\n  ' + text.split('\n').join('\n  ') + '\n');
    return { sent: false, dev: devMode() };
  }
  const provider = String(process.env.MAIL_PROVIDER).toLowerCase();
  let res;
  if (provider === 'resend') {
    res = await doFetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: 'Bearer ' + process.env.MAIL_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.MAIL_FROM, to: [to], subject, text, html }),
    });
  } else if (provider === 'brevo') {
    const f = parseFrom(process.env.MAIL_FROM);
    res = await doFetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST', headers: { 'api-key': process.env.MAIL_API_KEY, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sender: f.name ? { name: f.name, email: f.email } : { email: f.email }, to: [{ email: to }], subject, textContent: text, htmlContent: html }),
    });
  } else {
    throw new Error('MAIL_PROVIDER must be "resend" or "brevo".');
  }
  if (!res.ok) { let t = ''; try { t = (await res.text()).slice(0, 200); } catch (e) { /* ignore */ } throw new Error('The email service refused the message (' + res.status + '). ' + t); }
  return { sent: true, dev: false };
}

function layout(heading, lines, buttonText, link, footer) {
  const text = [heading, '', ...lines, '', buttonText + ':', link, '', footer].join('\n');
  const html = '<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px;color:#1b2430">' +
    '<h2 style="margin:0 0 14px">' + escHtml(heading) + '</h2>' +
    lines.map((l) => '<p style="line-height:1.55;margin:0 0 10px">' + escHtml(l) + '</p>').join('') +
    '<p style="margin:22px 0"><a href="' + escHtml(link) + '" style="background:#1f7a4d;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block">' + escHtml(buttonText) + '</a></p>' +
    '<p style="font-size:12px;color:#667;line-height:1.5">If the button does not work, copy this address into your browser:<br>' + escHtml(link) + '</p>' +
    '<p style="font-size:12px;color:#667">' + escHtml(footer) + '</p></div>';
  return { text, html };
}

function inviteMail({ schoolName, inviterName, role, fullName, link, hours }) {
  const roleText = role === 'admin' ? 'an Admin (you can manage staff, terms and fees)' : 'a staff member (you can record payments, look up students and print receipts)';
  const m = layout('Join ' + schoolName + ' on Karo Recon',
    ['Hello ' + fullName + ',', inviterName + ' added you to ' + schoolName + ' as ' + roleText + '.', 'Karo Recon keeps the school\'s fee payments and student balances in one place. Choose your own password to get started.'],
    'Choose my password', link, 'This link works once and expires in ' + hours + ' hours. If you were not expecting this, ignore this email and nothing happens.');
  return { subject: 'You have been added to ' + schoolName + ' on Karo Recon', ...m };
}
function resetMail({ fullName, link, minutes, schoolName }) {
  const m = layout('Choose a new password',
    ['Hello ' + fullName + ',', 'Someone asked to reset your Karo Recon password for ' + schoolName + '.'],
    'Choose a new password', link, 'This link works once and expires in ' + minutes + ' minutes. If you did not ask for this, ignore this email; your password stays the same.');
  return { subject: 'Reset your Karo Recon password', ...m };
}
function emailChangeMail({ fullName, link, hours, schoolName }) {
  const m = layout('Confirm your new email address',
    ['Hello ' + fullName + ',', 'The email address for your Karo Recon account at ' + schoolName + ' is being changed to this one.'],
    'Confirm this address', link, 'This link works once and expires in ' + hours + ' hours. If this is not right, ignore this email and nothing changes.');
  return { subject: 'Confirm your new email address', ...m };
}

module.exports = { sendMail, inviteMail, resetMail, emailChangeMail, appUrl, configured, devMode };