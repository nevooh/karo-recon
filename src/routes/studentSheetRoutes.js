// src/routes/studentSheetRoutes.js - one student's sheet, manual payments, receipts, and the small things staff may change.
//
// Mounted in src/app.js with:   app.use('/api', studentSheetRoutes);
// Every route needs a login for the SAME school. ANY staff member may use all of them (decided with the owner);
// every change is audited with who did it. Rules live in src/services/studentSheet.js.
//
//   GET  /api/schools/:schoolId/students/:studentId/sheet     the student, contacts, money per term, payments, this term's fees
//   POST /api/schools/:schoolId/students/:studentId/payments  { amount, method: cash|mpesa|bank|cheque|other (mpesa and bank need reference = the code), reference?, note?, payer_name?,
//                                                               received_on?, request_id?, dry? }   safe to send twice with the same request_id
//   POST /api/schools/:schoolId/students/:studentId/details   { full_name?, admission_no? (Admin only), contacts?: [{name, phone, relationship}], dry? }
//   POST /api/schools/:schoolId/students/:studentId/status    { status: "left"|"active", reason?, dry? }
//   POST /api/schools/:schoolId/payments/:transactionId/reverse   { reason, dry? }   undo a wrong MANUAL payment (kept on record)
//   GET  /api/schools/:schoolId/payments/:transactionId/receipt   the data of one printable receipt
const express = require('express');
const { requireAuth, requireSameSchool } = require('../middleware/auth');
const sheet = require('../services/studentSheet');

const router = express.Router();
router.use('/schools/:schoolId', requireAuth, requireSameSchool);

const sid = (req) => Number(req.params.schoolId);
const stu = (req) => Number(req.params.studentId);
const actor = (req) => ({ staffId: req.staff.staffId });

router.get('/schools/:schoolId/students/:studentId/sheet', async (req, res) => {
  res.json(await sheet.getSheet(sid(req), stu(req)));
});

router.post('/schools/:schoolId/students/:studentId/payments', async (req, res) => {
  const b = req.body || {};
  res.json(await sheet.recordManualPayment(sid(req), stu(req), {
    amount: b.amount, method: b.method, reference: b.reference, note: b.note, payerName: b.payer_name, receivedOn: b.received_on, requestId: b.request_id,
  }, { ...actor(req), dry: b.dry === true }));
});

router.post('/schools/:schoolId/students/:studentId/details', async (req, res) => {
  const b = req.body || {};
  res.json(await sheet.updateDetails(sid(req), stu(req), { fullName: b.full_name, admissionNo: b.admission_no, contacts: b.contacts }, { ...actor(req), dry: b.dry === true }));
});

router.post('/schools/:schoolId/students/:studentId/status', async (req, res) => {
  const b = req.body || {};
  res.json(await sheet.setStudentStatus(sid(req), stu(req), { status: b.status, reason: b.reason }, { ...actor(req), dry: b.dry === true }));
});

router.post('/schools/:schoolId/payments/:transactionId/reverse', async (req, res) => {
  const b = req.body || {};
  res.json(await sheet.reverseManualPayment(sid(req), Number(req.params.transactionId), { reason: b.reason }, { ...actor(req), dry: b.dry === true }));
});

router.get('/schools/:schoolId/payments/:transactionId/receipt', async (req, res) => {
  res.json(await sheet.getReceipt(sid(req), Number(req.params.transactionId)));
});

module.exports = router;