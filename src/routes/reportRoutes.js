/* reportRoutes.js - the Reports page (read only, Admins only).
   GET /api/schools/:schoolId/reports?term_id=   -> { school, terms, byTerm, term, tiles, arrearsByClass, topArrears, moneyIn, sources, attention } */
const express = require('express');
const { requireAuth, requireSameSchool, requireAdmin } = require('../middleware/auth');
const { getReport } = require('../services/reports');

const router = express.Router();
router.get('/schools/:schoolId/reports', requireAuth, requireSameSchool, requireAdmin, async (req, res, next) => {
  try { res.json(await getReport(Number(req.params.schoolId), { termId: req.query.term_id })); }
  catch (e) { if (e && e.status) return res.status(e.status).json({ error: e.message }); next(e); }
});
module.exports = router;