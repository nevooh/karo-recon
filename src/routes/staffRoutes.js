/* staffRoutes.js - the Staff page's endpoints. All need a login for the same school; the rules live in services/staffAdmin.js.
   GET  /schools/:schoolId/me                       my own account (any staff)
   GET  /schools/:schoolId/staff                    the list (Admin)
   POST /schools/:schoolId/staff                    invite {full_name, email, role}   (Admin; only the Main Admin can add an Admin)
   POST /schools/:schoolId/staff/:id/resend-invite
   POST /schools/:schoolId/staff/:id/send-reset     email them a reset link (nobody ever sees a password)
   POST /schools/:schoolId/staff/:id/role           {role}
   POST /schools/:schoolId/staff/:id/status         {status: 'suspended' | 'active'}
   POST /schools/:schoolId/staff/:id/name           {full_name}   (yourself, or an Admin for others)
   POST /schools/:schoolId/staff/:id/email          {email}       (owner: anyone incl. self; Admin: staff-role people)
   POST /schools/:schoolId/transfer-ownership       {to_staff_id, password}   (Main Admin)
   Sensitive ones (invite, send-reset, role, status, email, transfer) also need the Admin's PIN (X-Pin-Token) - see middleware requirePin. */
const express = require('express');
const { requireAuth, requireSameSchool, requireAdmin, requirePin } = require('../middleware/auth');
const sa = require('../services/staffAdmin');

const router = express.Router();
const base = '/schools/:schoolId';
const ids = (req) => ({ schoolId: Number(req.params.schoolId), actorId: req.staff.staffId, ip: req.ip });
const wrap = (fn) => async (req, res, next) => {
  try { res.json(await fn(req)); } catch (e) { if (e && e.status) return res.status(e.status).json({ error: e.message }); next(e); }
};

router.get(base + '/me', requireAuth, requireSameSchool, wrap((req) => sa.getMe(Number(req.params.schoolId), req.staff.staffId)));
router.get(base + '/staff', requireAuth, requireSameSchool, requireAdmin, wrap((req) => sa.listStaff(Number(req.params.schoolId))));
router.post(base + '/staff', requireAuth, requireSameSchool, requireAdmin, requirePin, wrap((req) => sa.inviteStaff({ ...ids(req), fullName: req.body.full_name, email: req.body.email, role: req.body.role || 'staff' })));
router.post(base + '/staff/:id/resend-invite', requireAuth, requireSameSchool, requireAdmin, wrap((req) => sa.resendInvite({ ...ids(req), staffId: Number(req.params.id) })));
router.post(base + '/staff/:id/send-reset', requireAuth, requireSameSchool, requireAdmin, requirePin, wrap((req) => sa.sendResetLink({ ...ids(req), staffId: Number(req.params.id) })));
router.post(base + '/staff/:id/role', requireAuth, requireSameSchool, requireAdmin, requirePin, wrap((req) => sa.setRole({ ...ids(req), staffId: Number(req.params.id), role: req.body.role })));
router.post(base + '/staff/:id/status', requireAuth, requireSameSchool, requireAdmin, requirePin, wrap((req) => sa.setStatus({ ...ids(req), staffId: Number(req.params.id), status: req.body.status })));
router.post(base + '/staff/:id/name', requireAuth, requireSameSchool, wrap((req) => sa.setName({ ...ids(req), staffId: Number(req.params.id), fullName: req.body.full_name })));
router.post(base + '/staff/:id/email', requireAuth, requireSameSchool, requireAdmin, requirePin, wrap((req) => sa.changeEmail({ ...ids(req), staffId: Number(req.params.id), email: req.body.email })));
router.post(base + '/transfer-ownership', requireAuth, requireSameSchool, requireAdmin, requirePin, wrap((req) => sa.transferOwnership({ ...ids(req), toStaffId: Number(req.body.to_staff_id), password: req.body.password })));

module.exports = router;