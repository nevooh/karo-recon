// src/routes/balanceRoutes.js - Students & balances (read only).
//
// Mounted in src/app.js with:   app.use('/api', balanceRoutes);
// Needs a login for the SAME school. Any staff member can look. Nothing here changes money.
//
//   GET /api/schools/:schoolId/balances?term_id=&q=&class_id=&stream_id=&status=&students=&sort=&limit=&offset=
//     status:   all | owing | overpaid | cleared | not_billed
//     students: active (default) | left | all
//     sort:     name | admission | class | balance_desc | balance_asc
//     -> { term, terms, classes, streams, totals, counts, total, rows }
const express = require('express');
const { requireAuth, requireSameSchool } = require('../middleware/auth');
const { listBalances } = require('../services/balances');
const { getDashboard } = require('../services/dashboard');

const router = express.Router();
router.use('/schools/:schoolId/balances', requireAuth, requireSameSchool);
router.use('/schools/:schoolId/dashboard', requireAuth, requireSameSchool);

// the Dashboard numbers. Any staff member of the school can look.
router.get('/schools/:schoolId/dashboard', async (req, res) => { res.json(await getDashboard(Number(req.params.schoolId))); });

router.get('/schools/:schoolId/balances', async (req, res) => {
  const q = req.query;
  res.json(await listBalances(Number(req.params.schoolId), {
    termId: q.term_id, q: q.q, classId: q.class_id, streamId: q.stream_id, status: q.status, students: q.students,
    sort: q.sort, limit: q.limit, offset: q.offset,
  }));
});

module.exports = router;