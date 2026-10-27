/* settingsRoutes.js - School settings: profile, logo and the Admin's PIN. (Payment channels stay in routes/reconciliation.js.)
   GET    /api/schools/:id/profile          any signed-in staff of the school (the sidebar, receipts and reports use it)
   PUT    /api/schools/:id/profile          Admin. {name?, motto?, phone?, email?, address?, county?, receipt_footer?}. Renaming: Main Admin + PIN.
   PUT    /api/schools/:id/logo             Admin. {image: "data:image/png;base64,..."}
   DELETE /api/schools/:id/logo             Admin.
   GET    /api/schools/:id/pin              Admin. {has_pin, locked_minutes}
   POST   /api/schools/:id/pin/set          Admin. {password, pin}  -> also unlocks for 10 minutes
   POST   /api/schools/:id/pin/unlock       Admin. {pin} -> {token}  (send it back as X-Pin-Token on sensitive requests) */
const express = require('express');
const { requireAuth, requireSameSchool, requireAdmin, pinCheck } = require('../middleware/auth');
const profile = require('../services/schoolProfile');
const pin = require('../services/pin');

const router = express.Router();
const base = '/schools/:schoolId';
const wrap = (fn) => async (req, res, next) => {
  try { res.json(await fn(req, res)); } catch (e) { if (e && e.status) return res.status(e.status).json({ error: e.message, ...(e.code ? { code: e.code } : {}) }); next(e); }
};
const who = (req) => ({ schoolId: Number(req.params.schoolId), actorId: req.staff.staffId, ip: req.ip });

router.get(base + '/profile', requireAuth, requireSameSchool, wrap((req) => profile.getProfile(Number(req.params.schoolId))));
router.put(base + '/profile', requireAuth, requireSameSchool, requireAdmin, async (req, res, next) => {
  try {
    const body = req.body || {};
    if (body.name !== undefined) {                                             // renaming is sensitive: needs the PIN, but only when the name really changes
      const cur = await profile.getProfile(Number(req.params.schoolId));
      if (String(body.name).replace(/\s+/g, ' ').trim() !== cur.name) {
        const c = await pinCheck(req);
        if (!c.ok) return res.status(403).json(c.body);
      }
    }
    res.json(await profile.updateProfile({ ...who(req), changes: body }));
  } catch (e) { if (e && e.status) return res.status(e.status).json({ error: e.message }); next(e); }
});
router.put(base + '/logo', requireAuth, requireSameSchool, requireAdmin, wrap((req) => profile.setLogo({ ...who(req), image: (req.body || {}).image })));
router.delete(base + '/logo', requireAuth, requireSameSchool, requireAdmin, wrap((req) => profile.removeLogo(who(req))));
router.get(base + '/pin', requireAuth, requireSameSchool, requireAdmin, wrap((req) => pin.pinStatus(Number(req.params.schoolId), req.staff.staffId)));
router.post(base + '/pin/set', requireAuth, requireSameSchool, requireAdmin, wrap((req) => pin.setPin({ ...who(req), staffId: req.staff.staffId, password: (req.body || {}).password, pin: (req.body || {}).pin })));
router.post(base + '/pin/unlock', requireAuth, requireSameSchool, requireAdmin, wrap((req) => pin.unlock({ ...who(req), staffId: req.staff.staffId, pin: (req.body || {}).pin })));

module.exports = router;