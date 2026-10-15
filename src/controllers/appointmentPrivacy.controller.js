'use strict';
const db = require('../../models');
const { assertUserCanAccessFeature } = require('../lib/access-policy');
exports.status = async (req, res, next) => {
  try {
    const actorId = Number(req.userData?.userId), id = Number(req.params.id);
    if (!Number.isSafeInteger(actorId) || actorId < 1) return res.status(401).json({ message: 'auth_failed' });
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ message: 'appointment_id_required' });
    const result = await db.sequelize.transaction({ readOnly: true, isolationLevel: 'REPEATABLE READ' }, async transaction => {
      const cita = await db.CitaPaciente.findByPk(id, { attributes: ['id_cita', 'paciente_id', 'clinica_id'], raw: true, transaction });
      if (!cita?.paciente_id) throw Object.assign(new Error('appointment_not_found'), { statusCode: 404 });
      await assertUserCanAccessFeature({ actorId, featureKey: 'consents.view', clinicId: Number(cita.clinica_id) });
      return require('../services/appointmentPrivacyEligibility.service').assessPrivacyBeforeStart({ db, appointment: cita, transaction });
    });
    return res.json(result);
  } catch (error) {
    const status = error.statusCode || error.status;
    if ([400, 401, 403, 404, 409].includes(status)) return res.status(status).json({ code: error.code, message: error.message });
    next(error);
  }
};
exports.prepare = async (req, res, next) => {
  try {
    const actorId = Number(req.userData?.userId), id = Number(req.params.id);
    if (!Number.isSafeInteger(actorId) || actorId < 1) return res.status(401).json({ message: 'auth_failed' });
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ message: 'appointment_id_required' });
    const result = await db.sequelize.transaction(async transaction => {
      // Read/authorize the exact current reservation while holding its anchor.
      // A concurrent move cannot commit a package for the previous identity.
      const cita = await db.CitaPaciente.findByPk(id, { attributes: ['id_cita', 'paciente_id', 'clinica_id'],
        raw: true, transaction, lock: transaction.LOCK.UPDATE });
      if (!cita?.paciente_id) throw Object.assign(new Error('appointment_not_found'), { statusCode: 404 });
      await assertUserCanAccessFeature({ actorId, featureKey: 'consents.manage', clinicId: Number(cita.clinica_id) });
      return require('../services/consentimientos.service').createPatientIntakePackage(cita.paciente_id,
        { clinicId: cita.clinica_id, createdBy: actorId, allowLinkedClinic: true, transaction });
    });
    return res.status(result.created_count ? 201 : 200).json(result);
  } catch (error) {
    const status = error.statusCode || error.status;
    if ([400, 401, 403, 404, 409].includes(status)) return res.status(status).json({ code: error.code, message: error.message });
    next(error);
  }
};
