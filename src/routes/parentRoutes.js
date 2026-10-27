// src/routes/parentRoutes.js - the parent portal's API.
//
// Mounted in src/app.js with:   app.use('/api/parent', parentRoutes);
// A parent signs in with their phone number + a code sent by text message (no password). Every route after sign-in works
// only on children that phone is a contact of (services/parentPortal.js refuses anything else with 404).
//
//   POST /api/parent/otp                                     { phone }                 -> always the same answer (dev mode adds devCode)
//   POST /api/parent/verify                                  { phone, code }           -> { token, phone }
//   POST /api/parent/logout                                  sign out everywhere
//   GET  /api/parent/me                                      -> { phone, children[] }   the kids picker, each with this term's money
//   GET  /api/parent/children/:studentId                     -> { child, recent_payments, pay }       the Home tab
//   GET  /api/parent/children/:studentId/fees                -> { child, term, items, total, by_term }  the Fees tab
//   GET  /api/parent/children/:studentId/payments?limit=&offset=   -> { child, total, payments }       the Payments tab
//   GET  /api/parent/children/:studentId/payments/:txnId/receipt   -> one printable receipt
//   POST /api/parent/children/:studentId/pay                 { amount, phone? }        -> { request_id, status, message }  "Send request to my phone"
//   GET  /api/parent/children/:studentId/pay/:requestId      -> { id, status, amount, receipt, message }  poll every ~3 s until status is not created/sent
const express = require('express');
const { requireParent } = require('../middleware/parentAuth');
const parentAuth = require('../services/parentAuth');
const portal = require('../services/parentPortal');

const router = express.Router();

// A plain-spoken error from OUR code (it has a status and is not a database or network error) is shown to the parent as it is.
// The app-wide handler hides everything 500 and above, but "Could not reach Safaricom" (502) is exactly what a parent needs to read.
function plain(err, res, next) {
  const isOurs = err && err instanceof Error && Number.isInteger(err.status) && !err.isAxiosError && !(typeof err.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code));
  if (isOurs && err.status >= 400 && err.status < 600 && err.status !== 500) return res.status(err.status).json({ error: err.message });
  return next(err);
}
const wrap = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (e) { plain(e, res, next); } };

// A text message costs real money, so one address can only ask for a limited number of codes (on top of the 3 an hour per phone).
const ipHits = new Map();
function ipLimited(ip) {
  const now = Date.now(), hour = 3600 * 1000;
  const hits = (ipHits.get(ip) || []).filter((t) => now - t < hour);
  hits.push(now);
  ipHits.set(ip, hits);
  if (ipHits.size > 5000) for (const [k, v] of ipHits) if (!v.some((t) => now - t < hour)) ipHits.delete(k);
  return hits.length > 20;
}

router.post('/otp', wrap(async (req, res) => {
  if (ipLimited(req.ip)) return res.status(429).json({ error: 'Too many requests from this connection. Please try again later.' });
  res.json(await parentAuth.requestCode((req.body || {}).phone));
}));

router.post('/verify', wrap(async (req, res) => {
  const b = req.body || {};
  res.json(await parentAuth.verifyCode(b.phone, b.code));
}));

router.post('/logout', requireParent, wrap(async (req, res) => { res.json(await parentAuth.signOutEverywhere(req.parent.phone)); }));

router.get('/me', requireParent, wrap(async (req, res) => { res.json(await portal.listChildren(req.parent.phone)); }));

router.get('/children/:studentId', requireParent, wrap(async (req, res) => {
  res.json(await portal.getHome(req.parent.phone, req.params.studentId));
}));

router.get('/children/:studentId/fees', requireParent, wrap(async (req, res) => {
  res.json(await portal.getFees(req.parent.phone, req.params.studentId));
}));

router.get('/children/:studentId/payments', requireParent, wrap(async (req, res) => {
  res.json(await portal.getPayments(req.parent.phone, req.params.studentId, { limit: req.query.limit, offset: req.query.offset }));
}));

router.get('/children/:studentId/payments/:txnId/receipt', requireParent, wrap(async (req, res) => {
  res.json(await portal.getReceipt(req.parent.phone, req.params.studentId, req.params.txnId));
}));

router.post('/children/:studentId/pay', requireParent, wrap(async (req, res) => {
  const b = req.body || {};
  res.json(await portal.startPayment(req.parent.phone, req.params.studentId, { amount: b.amount, phone: b.phone }));
}));

router.get('/children/:studentId/pay/:requestId', requireParent, wrap(async (req, res) => {
  res.json(await portal.getPaymentStatus(req.parent.phone, req.params.studentId, req.params.requestId));
}));

module.exports = router;
