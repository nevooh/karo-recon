// src/routes/fees.js - the fee structure (a reusable template per class and term 1/2/3) and the school's optional fees.
//
// Mounted in src/app.js with:   app.use('/api', feeRoutes);
// Every route needs a login for the SAME school. Reading is open to all staff; anything that changes fees or the
// optional list is admin-only. All the rules live in src/services/feeSetup.js (the same engine the set-fees command
// uses). Billing is automatic (src/services/termBilling.js): there is no route to bill, on purpose.
//
//   GET    /api/schools/:schoolId/fees                          one card per class: its three terms (version + totals)
//   GET    /api/schools/:schoolId/fees/class/:classId           one class: Term 1/2/3, latest fees on top, history, what was locked
//   POST   /api/schools/:schoolId/fees/set                      { class_ids, term | terms, fees:[{name,amount}], optional:[{name,amount}],
//                                                                 new_optional?, allow_drop?, dry? }   saves a NEW version
//   POST   /api/schools/:schoolId/fees/copy                     { from_class_id, from_term, to_class_ids?, to_terms?, allow_drop?, dry? }
//   GET    /api/schools/:schoolId/optional-fees                 every optional fee: price per class per term, who takes it
//   POST   /api/schools/:schoolId/optional-fees                 { name, dry? }   add a name to the school's list
//   POST   /api/schools/:schoolId/optional-fees/prices          { name, prices:[{class_id, term, amount|null}], allow_drop?, dry? }
//   DELETE /api/schools/:schoolId/optional-fees/:name           remove a name nothing uses
const express = require('express');
const { requireAuth, requireSameSchool, requireAdmin } = require('../middleware/auth');
const fees = require('../services/feeSetup');

const router = express.Router();
router.use('/schools/:schoolId', requireAuth, requireSameSchool);

const sid = (req) => Number(req.params.schoolId);
const flag = (v) => v === true;
const ids = (v) => (Array.isArray(v) ? v : undefined);

router.get('/schools/:schoolId/fees', async (req, res) => {
  res.json(await fees.overview(sid(req)));
});

router.get('/schools/:schoolId/fees/class/:classId', async (req, res) => {
  res.json(await fees.classFees(sid(req), Number(req.params.classId)));
});

router.post('/schools/:schoolId/fees/set', requireAdmin, async (req, res) => {
  const b = req.body || {};
  res.json(await fees.setFees(sid(req), {
    classIds: ids(b.class_ids), term: b.term, terms: b.terms, fees: b.fees, optional: b.optional,
    newOptional: flag(b.new_optional), allowDrop: flag(b.allow_drop), dry: flag(b.dry),
  }));
});

router.post('/schools/:schoolId/fees/copy', requireAdmin, async (req, res) => {
  const b = req.body || {};
  res.json(await fees.copyFees(sid(req), {
    fromClassId: b.from_class_id, fromTerm: b.from_term, toClassIds: ids(b.to_class_ids), toTerms: b.to_terms,
    allowDrop: flag(b.allow_drop), dry: flag(b.dry),
  }));
});

router.get('/schools/:schoolId/optional-fees', async (req, res) => {
  res.json(await fees.optionalOverview(sid(req)));
});

router.post('/schools/:schoolId/optional-fees', requireAdmin, async (req, res) => {
  const b = req.body || {};
  res.json(await fees.addOptionalName(sid(req), b.name, { dry: flag(b.dry) }));
});

router.post('/schools/:schoolId/optional-fees/prices', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const prices = Array.isArray(b.prices) ? b.prices.map((p) => ({ classId: p && p.class_id, term: p && p.term, amount: p && p.amount })) : b.prices;
  res.json(await fees.setOptionalPrices(sid(req), { name: b.name, prices, allowDrop: flag(b.allow_drop), dry: flag(b.dry) }));
});

router.delete('/schools/:schoolId/optional-fees/:name', requireAdmin, async (req, res) => {
  res.json(await fees.removeOptionalName(sid(req), req.params.name, { dry: false }));
});

module.exports = router;
