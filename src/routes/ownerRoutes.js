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
    res.json(await owner.login(req.body.email, req.body.password));
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
router.post('/schools/:id/channel', requireOwner, async (req, res, next) => { try { res.json(await owner.addSchoolChannel(Number(req.params.id), String(req.body.channel || ''))); } catch (e) { next(e); } });
// M-Pesa set-up on a school's behalf. Keys go IN here and never come back out (see the rules in ownerConsole.js).
const ip = (req) => req.ip;
router.get('/schools/:id/mpesa', requireOwner, async (req, res, next) => { try { res.json(await owner.mpesaState(Number(req.params.id))); } catch (e) { next(e); } });
router.post('/schools/:id/mpesa/keys', requireOwner, async (req, res, next) => {
  try {
    const b = req.body || {};
    res.json(await owner.ownerSaveMpesaKeys({ owner: req.owner, ip: ip(req), schoolId: Number(req.params.id), paybill: b.paybill, consumerKey: b.consumer_key, consumerSecret: b.consumer_secret, password: b.owner_password, confirmText: b.confirm_text }));
  } catch (e) { next(e); }
});
router.post('/schools/:id/mpesa/passkey', requireOwner, async (req, res, next) => {
  try { const b = req.body || {}; res.json(await owner.ownerSavePasskey({ owner: req.owner, ip: ip(req), schoolId: Number(req.params.id), passkey: b.passkey, password: b.owner_password, confirmText: b.confirm_text })); } catch (e) { next(e); }
});
router.post('/schools/:id/mpesa/check', requireOwner, async (req, res, next) => { try { res.json(await owner.ownerCheckMpesa({ ip: ip(req), schoolId: Number(req.params.id) })); } catch (e) { next(e); } });
router.post('/schools/:id/mpesa/register', requireOwner, async (req, res, next) => {
  try { const b = req.body || {}; res.json(await owner.ownerRegisterMpesa({ owner: req.owner, ip: ip(req), schoolId: Number(req.params.id), dry: !!b.dry, confirmPaybill: b.confirm_paybill, password: b.owner_password })); } catch (e) { next(e); }
});
module.exports = router;