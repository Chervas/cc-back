'use strict';
const db = require('../../models');
const { assertUserCanAccessFeature } = require('../lib/access-policy');
const privacy = require('../services/patientPrivacyStatus.service');
const verification = require('../services/patientMobileVerification.service');
const { id } = require('../lib/patient-mobile-verification');
const fail = (code, statusCode) => Object.assign(new Error(code), { code, statusCode });
async function authorize(req, values, transaction, edit = false) {
  const actorId = id(req.userData?.userId), clinicId = id(values?.clinic_id);
  if (!actorId) throw fail('auth_failed', 401);
  if (!clinicId) throw fail('clinic_id_required', 400);
  for (const featureKey of ['patients.view', 'patients.sensitive.view', ...(edit ? ['patients.edit'] : [])]) {
    await assertUserCanAccessFeature({ actorId, clinicId, featureKey });
  }
  const patient = await privacy.patientForPrivacyClinic({ db, identifier: req.params.id, clinicId, transaction });
  return { patientId: Number(patient.id_paciente), clinicId, actorId };
}
function reply(error, res, next) {
  if ([400, 401, 403, 404, 409].includes(error.statusCode || error.status)) {
    return res.status(error.statusCode || error.status).json({ code: error.code || error.message, message: error.message });
  }
  return next(error);
}
exports.get = async (req, res, next) => {
  try {
    if (Object.keys(req.query || {}).some(k => k !== 'clinic_id')) throw fail('mobile_verification_query_invalid', 400);
    const result = await db.sequelize.transaction({ readOnly: true, isolationLevel: 'REPEATABLE READ' }, async transaction => {
      const target = await authorize(req, req.query, transaction);
      return verification.current().view({ ...target, transaction });
    });
    return res.json(result);
  } catch (error) { return reply(error, res, next); }
};
exports.resolve = async (req, res, next) => {
  try {
    const result = await db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
      const target = await authorize(req, req.body, transaction, true);
      return verification.current().manual({ ...target, transaction, payload: req.body,
        authorizeCurrent: async patient => {
          await authorize(req, req.body, transaction, true);
          if (Number(patient.clinica_id) !== target.clinicId) await assertUserCanAccessFeature({
            actorId: target.actorId, clinicId: Number(patient.clinica_id), featureKey: 'patients.edit' });
        } });
    });
    return res.json(result);
  } catch (error) {
    if (['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(error.original?.code || error.parent?.code || error.code)) {
      return reply(fail('mobile_verification_changed', 409), res, next);
    }
    return reply(error, res, next);
  }
};
