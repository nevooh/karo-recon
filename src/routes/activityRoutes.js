/* activityRoutes.js - the Activity log page.
   GET /api/schools/:schoolId/activity?q=&staff_id=&group=&range=today|7d|30d|term|custom&from=&to=&sign_ins=1&before=<id>&limit=
   Admins only (the Main Admin is an Admin). Read only: nothing here can change the log. */
const express = require('express');
const { requireAuth, requireSameSchool, requireAdmin } = require('../middleware/auth');
const { listActivity } = require('../services/activityLog');

const router = express.Router();
router.get('/schools/:schoolId/activity', requireAuth, requireSameSchool, requireAdmin, async (req, res, next) => {
  try {
    const q = req.query;
    res.json(await listActivity(Number(req.params.schoolId), {
      q: q.q, staffId: q.staff_id, group: q.group, range: q.range, from: q.from, to: q.to,
      signIns: q.sign_ins === '1' || q.sign_ins === 'true', before: q.before, limit: q.limit,
    }));
  } catch (e) { next(e); }
});
module.exports = router;