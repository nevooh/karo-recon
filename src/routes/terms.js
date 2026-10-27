// src/routes/terms.js - a school's own academic years and term dates.
//
// Mounted in src/app.js with:   app.use('/api', termRoutes);
// Every route needs a login for the SAME school. Anyone on staff can look; only an admin can change dates.
// All the rules (locks, order, confirmation of a started term) live in src/services/termSetup.js, the same
// engine the set-terms command uses.
//
//   GET  /api/schools/:schoolId/terms           the school's years, each with Term 1/2/3: dates, state, billed, what can change
//   POST /api/schools/:schoolId/terms           { year, term, start, end, dry?, confirm_started? }
//        A start date of today or earlier starts billing now, so it answers 409 with
//        { error, needs_confirmation: true, preview } first; send it again with confirm_started: true to save.
const express = require('express');
const { requireAuth, requireSameSchool, requireAdmin } = require('../middleware/auth');
const terms = require('../services/termSetup');

const router = express.Router();
router.use('/schools/:schoolId/terms', requireAuth, requireSameSchool);

const sid = (req) => Number(req.params.schoolId);

router.get('/schools/:schoolId/terms', async (req, res) => {
  res.json(await terms.listTerms(sid(req)));
});

router.post('/schools/:schoolId/terms', requireAdmin, async (req, res) => {
  const b = req.body || {};
  try {
    res.json(await terms.setTermDates({
      schoolId: sid(req), year: b.year, term: b.term, start: b.start, end: b.end,
      dry: b.dry === true, confirmStarted: b.confirm_started === true, via: 'admin', actor: req.staff.staffId,
    }));
  } catch (err) {
    if (err.needsConfirmation) return res.status(409).json({ error: err.message, needs_confirmation: true, preview: err.preview });
    throw err;
  }
});

module.exports = router;