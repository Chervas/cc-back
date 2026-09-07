'use strict';

const router = require('express').Router();
const authMiddleware = require('./auth.middleware');
const controller = require('../controllers/patientFollowUps.controller');

router.use(authMiddleware);
router.get('/', controller.list);
router.post('/', controller.create);
router.get('/from-appointment/:appointmentId', controller.getForSourceAppointment);
router.get('/:id/appointment-candidates', controller.appointmentCandidates);
router.get('/:id', controller.get);
router.patch('/:id', controller.update);
// No DELETE: closing/cancelling retains clinical provenance and revisions.
router.use((error, req, res, next) => {
  if (['ER_NO_SUCH_TABLE', '42P01'].includes(error.original?.code || error.parent?.code)) {
    res.set('Cache-Control', 'no-store');
    return res.status(503).json({ error: { code: 'follow_up_schema_pending', message: 'Los seguimientos están pendientes de habilitación técnica. La agenda existente sigue disponible.' } });
  }
  if (!error?.statusCode) return next(error);
  res.set('Cache-Control', 'no-store');
  return res.status(error.statusCode).json({ error: {
    code: error.code || 'follow_up_error', message: error.message, details: error.details || null,
  } });
});

module.exports = router;
