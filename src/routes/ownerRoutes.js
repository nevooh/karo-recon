const express = require('express');
const { requireOwner } = require('../middleware/ownerAuth');
const owner = require('../services/ownerConsole');
const router = express.Router();

// Slow down guessing from one connection (the per-email lock still applies on top).
const hits = new Map();
function limited(ip) {
  const now = Date.now(), h = (hits.get(ip) || []).filter((t) => now - t < 3600e3);
  h.push(now); hits.set(ip, h); return h.length > 30;
}

router.post('/login', async (req, res, next) => {
  try {
    if (limited(req.ip)) return res.status(429).json({ error: 'Too many tries. Wait a while.' });
    res.json(await owner.login(req.body.email, req.body.password, req.body.code));
  } catch (e) { next(e); }
});
router.get('/me', requireOwner, (req, res) => res.json({ owner: req.owner }));
router.get('/schools', requireOwner, async (req, res, next) => { try { res.json(await owner.listSchools()); } catch (e) { next(e); } });
router.post('/schools', requireOwner, async (req, res, next) => {
  try { res.status(201).json(await owner.addSchool({ name: req.body.name, adminName: req.body.adminName, adminEmail: req.body.adminEmail })); }
  catch (e) { next(e); }
});
router.get('/applications', requireOwner, async (req, res, next) => { try { res.json(await owner.listApplications()); } catch (e) { next(e); } });
router.post('/applications/:id', requireOwner, async (req, res, next) => {
  try { res.json(await owner.updateApplication(Number(req.params.id), { status: req.body.status, note: req.body.note })); } catch (e) { next(e); }
});
router.post('/schools/:id/reset-admin', requireOwner, async (req, res, next) => { try { res.json(await owner.resetAdminPassword(Number(req.params.id))); } catch (e) { next(e); } });
router.post('/schools/:id/pause', requireOwner, async (req, res, next) => { try { res.json(await owner.setSchoolPaused(Number(req.params.id), !!req.body.paused)); } catch (e) { next(e); } });
// M-Pesa set-up on a school's behalf. Keys go IN here and never come back out (see the rules in ownerConsole.js).
const ip = (req) => req.ip;
router.get('/schools/:id/mpesa', requireOwner, async (req, res, next) => { try { res.json({ ...(await owner.mpesaState(Number(req.params.id))), two_step: await owner.twoStepEnabled(req.owner.id) }); } catch (e) { next(e); } });
router.post('/schools/:id/mpesa/keys', requireOwner, async (req, res, next) => {
  try {
    const b = req.body || {};
    res.json(await owner.ownerSaveMpesaKeys({ owner: req.owner, ip: ip(req), schoolId: Number(req.params.id), paybill: b.paybill, consumerKey: b.consumer_key, consumerSecret: b.consumer_secret, password: b.owner_password, code: b.code, confirmText: b.confirm_text }));
  } catch (e) { next(e); }
});
router.post('/schools/:id/mpesa/passkey', requireOwner, async (req, res, next) => {
  try { const b = req.body || {}; res.json(await owner.ownerSavePasskey({ owner: req.owner, ip: ip(req), schoolId: Number(req.params.id), passkey: b.passkey, password: b.owner_password, code: b.code, confirmText: b.confirm_text })); } catch (e) { next(e); }
});
router.post('/schools/:id/mpesa/check', requireOwner, async (req, res, next) => { try { res.json(await owner.ownerCheckMpesa({ ip: ip(req), schoolId: Number(req.params.id) })); } catch (e) { next(e); } });
router.post('/schools/:id/mpesa/register', requireOwner, async (req, res, next) => {
  try { const b = req.body || {}; res.json(await owner.ownerRegisterMpesa({ owner: req.owner, ip: ip(req), schoolId: Number(req.params.id), dry: !!b.dry, confirmPaybill: b.confirm_paybill, password: b.owner_password, code: b.code })); } catch (e) { next(e); }
});
// KCB on a school's behalf: only the account (or Vooma till) number. Same guards as M-Pesa.
router.get('/schools/:id/kcb', requireOwner, async (req, res, next) => { try { res.json({ ...(await owner.kcbState(Number(req.params.id))), two_step: await owner.twoStepEnabled(req.owner.id) }); } catch (e) { next(e); } });
router.post('/schools/:id/kcb', requireOwner, async (req, res, next) => {
  try { const b = req.body || {}; res.json(await owner.ownerSaveKcb({ owner: req.owner, ip: req.ip, schoolId: Number(req.params.id), accountNumber: b.account_number, password: b.owner_password, confirmText: b.confirm_text, code: b.code })); } catch (e) { next(e); }
});

// Equity on a school's behalf: makes the callback password and shows it ONCE (never cached, never stored readable).
router.get('/schools/:id/equity', requireOwner, async (req, res, next) => { try { res.json({ ...(await owner.equityState(Number(req.params.id))), two_step: await owner.twoStepEnabled(req.owner.id) }); } catch (e) { next(e); } });
router.post('/schools/:id/equity', requireOwner, async (req, res, next) => {
  try {
    const b = req.body || {};
    const out = await owner.ownerGenerateEquity({ owner: req.owner, ip: req.ip, schoolId: Number(req.params.id), password: b.owner_password, confirmText: b.confirm_text, code: b.code });
    res.set('Cache-Control', 'no-store');
    res.json(out);
  } catch (e) { next(e); }
});

// Co-op on a school's behalf: needs the school's account number; makes a username + password and shows it ONCE.
router.get('/schools/:id/coop', requireOwner, async (req, res, next) => { try { res.json({ ...(await owner.coopState(Number(req.params.id))), two_step: await owner.twoStepEnabled(req.owner.id) }); } catch (e) { next(e); } });
router.post('/schools/:id/coop', requireOwner, async (req, res, next) => {
  try {
    const b = req.body || {};
    const out = await owner.ownerGenerateCoop({ owner: req.owner, ip: req.ip, schoolId: Number(req.params.id), accountNumber: b.account_number, password: b.owner_password, confirmText: b.confirm_text, code: b.code });
    res.set('Cache-Control', 'no-store');
    res.json(out);
  } catch (e) { next(e); }
});

// Two-step sign-in for the owner account.
router.get('/2fa', requireOwner, async (req, res, next) => { try { res.json({ enabled: await owner.twoStepEnabled(req.owner.id) }); } catch (e) { next(e); } });
router.post('/2fa/start', requireOwner, async (req, res, next) => { try { res.json(await owner.twoStepStart(req.owner)); } catch (e) { next(e); } });
router.post('/2fa/enable', requireOwner, async (req, res, next) => { try { res.json(await owner.twoStepEnable(req.owner, (req.body || {}).code)); } catch (e) { next(e); } });
router.post('/2fa/disable', requireOwner, async (req, res, next) => { try { const b = req.body || {}; res.json(await owner.twoStepDisable(req.owner, req.ip, b.owner_password, b.code)); } catch (e) { next(e); } });
module.exports = router;