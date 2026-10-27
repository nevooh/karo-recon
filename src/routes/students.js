// src/routes/students.js - admitting a student.
//
// Mounted in src/app.js with:   app.use('/api', studentRoutes);
// Both routes need a login for the SAME school. Admitting is admin-only because it can create money owed
// (fees and a starting balance).
//
//   GET  /api/schools/:schoolId/admission-options?class_id=7
//        -> does this class need a stream (and which), and which optional fees does it offer
//   POST /api/schools/:schoolId/students
//        body: { admission_no, full_name, class_id, stream_id?, contacts?: [{name, phone, relationship}],
//                optional_fees?: ["Lunch","Bus"], starting_balance?, dry? }
//        dry: true checks everything and saves nothing.
const express = require('express');
const { requireAuth, requireSameSchool, requireAdmin } = require('../middleware/auth');
const { admitStudent, getAdmissionOptions } = require('../services/studentAdmission');

const router = express.Router();
router.use('/schools/:schoolId', requireAuth, requireSameSchool);

router.get('/schools/:schoolId/admission-options', async (req, res) => {
  const classId = Number(req.query.class_id);
  const options = await getAdmissionOptions(Number(req.params.schoolId), Number.isInteger(classId) ? classId : NaN);
  res.json(options);
});

router.post('/schools/:schoolId/students', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const result = await admitStudent(Number(req.params.schoolId), {
    admissionNo: b.admission_no,
    fullName: b.full_name,
    classId: b.class_id,
    streamId: b.stream_id,
    contacts: b.contacts,
    optionalFees: b.optional_fees,
    startingBalance: b.starting_balance,
  }, { dry: b.dry === true, staffId: req.staff.staffId });
  res.json(result);
});

module.exports = router;