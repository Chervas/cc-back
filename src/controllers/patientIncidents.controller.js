'use strict';

const db = require('../../models');
const { assertUserCanAccessFeature } = require('../lib/access-policy');
const { patientForPrivacyClinic } = require('../services/patientPrivacyStatus.service');
const service = require('../services/patientIncidents.service');
const id = value => /^[1-9]\d*$/.test(String(value ?? '')) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });

exports.set = async (req, res, next) => {
  try {
    const actorId = id(req.userData?.userId);
    const clinicId = id(req.body?.clinic_id);
    const active = req.body?.active;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    const reviewId = req.body?.review_id == null ? null : id(req.body.review_id);
    if (!actorId) throw fail(401, 'auth_failed', 'Inicia sesión.');
    if (!clinicId || req.body?.kind !== 'unwanted' || typeof active !== 'boolean'
      || active && (!reason || reason.length > 600) || req.body?.review_id != null && (!active || !reviewId)) {
      throw fail(400, 'patient_incident_invalid', 'Indica un motivo de hasta 600 caracteres.');
    }
    const result = await db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
      for (const featureKey of ['patients.view', 'patients.sensitive.view', 'patients.edit']) {
        await assertUserCanAccessFeature({ actorId, featureKey, clinicId });
      }
      const patient = await patientForPrivacyClinic({ db, identifier: req.params.id, clinicId, transaction });
      const patientId = Number(patient.id_paciente);
      await db.Paciente.findByPk(patientId, { attributes: ['id_paciente'], transaction, lock: transaction.LOCK.UPDATE });
      if (reviewId) {
        const review = await db.BusinessProfileReview.findOne({
          where: { id: reviewId, clinica_id: clinicId, is_negative: true },
          attributes: ['id'], transaction,
        });
        if (!review) throw fail(404, 'patient_incident_review_not_found', 'La reseña no está disponible en esta clínica.');
      }
      await service.setUnwanted({ db, patientId, clinicId, actorId, active, reason, reviewId, transaction });
      return service.summary({ db, patientId, clinicIds: [clinicId], transaction });
    });
    return res.json(result);
  } catch (error) {
    const status = error.statusCode || error.status;
    if ([400, 401, 403, 404, 409].includes(status)) return res.status(status).json({ code: error.code, message: error.message });
    return next(error);
  }
};
