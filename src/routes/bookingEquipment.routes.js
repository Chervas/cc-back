'use strict';
const router = require('express').Router();
const db = require('../../models');
const { assertUserCanAccessFeature } = require('../lib/access-policy');
const { createBookingEquipmentRegistry } = require('../services/bookingEquipmentRegistry.service');
const { equipmentError } = require('../lib/booking-equipment');
router.use(require('./auth.middleware'));
const id = value => {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw equipmentError('invalid', 'Identificador no válido.', 400);
  return Number(value);
};
const handler = work => async (req, res, next) => {
  try {
    const service = createBookingEquipmentRegistry({ db, authorize: (featureKey, clinicId) =>
      assertUserCanAccessFeature({ actorId: Number(req.userData?.userId), featureKey, clinicId }) });
    res.json(await work(service, req));
  } catch (error) {
    if (error.code?.startsWith('booking_equipment_')) return res.status(error.statusCode || 422).json({ code: error.code, message: error.message, can_force: false });
    if (error.status === 403 || error.message === 'access_policy_forbidden') return res.status(403).json({ message: 'No tienes permiso para gestionar equipos en estas clínicas.' });
    next(error);
  }
};
router.get('/:clinicId', handler((s, r) => s.read(id(r.params.clinicId))));
router.put('/:clinicId/enabled', handler((s, r) => s.setEnabled(id(r.params.clinicId), r.body.enabled)));
router.post('/:clinicId/units', handler((s, r) => s.saveUnit(id(r.params.clinicId), null, r.body)));
router.put('/:clinicId/units/:unitId', handler((s, r) => s.saveUnit(id(r.params.clinicId), id(r.params.unitId), r.body)));
router.post('/:clinicId/units/:unitId/archive', handler((s, r) => s.archiveUnit(id(r.params.clinicId), id(r.params.unitId), r.body.revision)));
router.put('/:clinicId/rooms/:roomId', handler((s, r) => s.saveRoomPolicy(id(r.params.clinicId), id(r.params.roomId), r.body)));
module.exports = router;
