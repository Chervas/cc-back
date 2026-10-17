'use strict';
const db = require('../../models');
const { assertUserCanAccessFeature } = require('../lib/access-policy');
const service = require('../services/appointmentRegistrationDocuments.service');
const failure = (code, statusCode) => Object.assign(new Error(code), { code, statusCode });
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
function context(req) {
  const actorId = Number(req.userData?.userId), appointmentId = Number(req.params.id);
  if (!positive(actorId)) throw failure('auth_failed', 401);
  if (!positive(appointmentId)) throw failure('appointment_id_required', 400);
  return { actorId, appointmentId };
}
async function appointment({ actorId, appointmentId }, featureKey, transaction, lock = false) {
  const cita = await db.CitaPaciente.findByPk(appointmentId, { attributes: ['id_cita', 'paciente_id', 'clinica_id'],
    raw: true, transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
  if (!cita?.paciente_id) throw failure('appointment_not_found', 404);
  await assertUserCanAccessFeature({ actorId, featureKey, clinicId: Number(cita.clinica_id) });
  await require('../services/patientPrivacyStatus.service').patientForPrivacyClinic({ db, identifier: cita.paciente_id,
    clinicId: cita.clinica_id, transaction, lock });
  return cita;
}
function reply(error, res, next) {
  const status = error.statusCode || error.status;
  if ([400, 401, 403, 404, 409].includes(status)) return res.status(status).json({ code: error.code || error.message,
    message: error.message, ...(error.details ? { details: error.details } : {}) });
  return next(error);
}
exports.get = async (req, res, next) => { try {
  const scope = context(req);
  const result = await db.sequelize.transaction({ readOnly: true, isolationLevel: 'REPEATABLE READ' }, async transaction => {
    const cita = await appointment(scope, 'consents.view', transaction);
    return service.registrationDocuments({ db, appointment: cita, transaction });
  });
  return res.json(result);
} catch (error) { return reply(error, res, next); } };
exports.prepare = async (req, res, next) => { try {
  const scope = context(req), templateId = Number(req.params.templateId);
  if (!positive(templateId)) throw failure('registration_document_id_invalid', 400);
  if (req.body != null && (typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length)) throw failure('registration_document_payload_invalid', 400);
  const result = await db.sequelize.transaction(async transaction => {
    const cita = await appointment(scope, 'consents.manage', transaction, true);
    const state = await service.registrationDocuments({ db, appointment: cita, transaction, lock: true });
    if (!state.items.some(row => row.template_id === templateId)) throw failure('intake_additional_document_not_configured', 409);
    return require('../services/consentimientos.service').createPatientIntakePackage(cita.paciente_id,
      { clinicId: cita.clinica_id, createdBy: scope.actorId, allowLinkedClinic: true, additionalTemplateId: templateId, transaction });
  });
  return res.status(result.created_count ? 201 : 200).json(result);
} catch (error) { return reply(error, res, next); } };
