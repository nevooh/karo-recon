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
module.exports = router;