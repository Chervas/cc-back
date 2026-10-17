'use strict';
const db = require('../../models');
const { assertUserCanAccessFeature } = require('../lib/access-policy');
const service = require('../services/patientPrivacyStatus.service');
const positive = value => ['number', 'string'].includes(typeof value) && /^\d+$/.test(String(value ?? ''))
  && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const failure = (message, statusCode) => Object.assign(new Error(message), { code: message, statusCode });
const replyError = (error, res, next) => {
  const status = error.statusCode || error.status;
  if ([400, 401, 403, 404, 409].includes(status)) return res.status(status).json({ code: error.code || error.message, message: error.message });
  return next(error);
};

async function scope(req, featureKey, transaction, mutate = false) {
  const actorId = positive(req.userData?.userId);
  if (!actorId) throw failure('auth_failed', 401);
  const values = mutate ? req.body : req.query;
  if (values?.clinic_id != null && values?.clinica_id != null
    && positive(values.clinic_id) !== positive(values.clinica_id)) throw failure('clinic_id_conflict', 400);
  const clinicId = positive(values?.clinic_id ?? values?.clinica_id);
  if (!clinicId) throw failure('clinic_id_required', 400);
  // Check actor clinic rights before any patient existence/group lookup.
  await assertUserCanAccessFeature({ actorId, featureKey, clinicId });
  // Match the intake writer's clinic -> patient anchor order. The clinic is a
  // shared lock only; a concurrent configuration/membership change cannot
  // slip between authorization and document preparation.
  if (mutate) {
    const clinic = await db.Clinica.findByPk(clinicId, { attributes: ['id_clinica'], transaction, lock: transaction.LOCK.SHARE });
    if (!clinic) throw failure('clinic_not_found', 404);
  }
  const patient = await service.patientForPrivacyClinic({ db, identifier: req.params.id, clinicId, transaction, lock: mutate });
  return { actorId, clinicId, patientId: Number(patient.id_paciente) };
}

exports.status = async (req, res, next) => {
  try {
    if (Object.keys(req.query || {}).some(name => !['clinic_id', 'clinica_id', 'appointment_id'].includes(name))) throw failure('patient_privacy_query_invalid', 400);
    if (req.query?.appointment_id != null && !positive(req.query.appointment_id)) throw failure('appointment_id_required', 400);
    const result = await db.sequelize.transaction({ readOnly: true, isolationLevel: 'REPEATABLE READ' }, async transaction => {
      const target = await scope(req, 'consents.view', transaction);
      const appointmentId = positive(req.query?.appointment_id);
      if (appointmentId) {
        const cita = await db.CitaPaciente.findByPk(appointmentId, { attributes: ['id_cita', 'paciente_id', 'clinica_id'], raw: true, transaction });
        if (!cita || Number(cita.paciente_id) !== target.patientId || Number(cita.clinica_id) !== target.clinicId) throw failure('appointment_not_found', 404);
      }
      return service.getPatientPrivacyStatus({ db, ...target, appointmentId, transaction });
    });
    return res.json(result);
  } catch (error) { return replyError(error, res, next); }
};

exports.profile = async (req, res, next) => {
  try {
    if (Object.keys(req.query || {}).some(name => !['clinic_id', 'clinica_id'].includes(name))) throw failure('patient_privacy_query_invalid', 400);
    const result = await db.sequelize.transaction({ readOnly: true, isolationLevel: 'REPEATABLE READ' }, async transaction => {
      const target = await scope(req, 'consents.view', transaction);
      await assertUserCanAccessFeature({ actorId: target.actorId, featureKey: 'patients.view', clinicId: target.clinicId });
      return require('../services/patientPrivacyProfile.service').view({ db, ...target, transaction });
    });
    return res.json(result);
  } catch (error) { return replyError(error, res, next); }
};

exports.applyProfile = async (req, res, next) => {
  try {
    if (!req.body || Array.isArray(req.body)) throw failure('privacy_profile_payload_invalid', 400);
    const result = await db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
      // Authorize without acquiring patient/package locks; reconciliation takes
      // sorted clinic anchors first so contact collision checks are serialized.
      const target = await scope({ ...req, query: req.body }, 'consents.view', transaction);
      const patient = await db.Paciente.findByPk(target.patientId, { attributes: ['clinica_id'], transaction });
      for (const clinicId of [...new Set([target.clinicId, Number(patient.clinica_id)])]) {
        await assertUserCanAccessFeature({ actorId: target.actorId, featureKey: 'patients.edit', clinicId });
      }
      return require('../services/patientPrivacyProfile.service').apply({ db, ...target,
        authorizedPrimaryClinicId: Number(patient.clinica_id), payload: req.body, transaction,
        authorizeCurrent: async primaryClinicId => {
          await assertUserCanAccessFeature({ actorId: target.actorId, featureKey: 'consents.view', clinicId: target.clinicId });
          for (const clinicId of [...new Set([target.clinicId, primaryClinicId])]) {
            await assertUserCanAccessFeature({ actorId: target.actorId, featureKey: 'patients.edit', clinicId });
          }
        } });
    });
    return res.json(result);
  } catch (error) {
    // Older intake writers use another clinic/patient lock order. MySQL may
    // choose either transaction as the recoverable deadlock victim; Sequelize
    // has already rolled this reconciliation back before reaching this catch.
    if (['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(error.original?.code || error.parent?.code || error.code)) {
      return replyError(failure('privacy_profile_changed', 409), res, next);
    }
    return replyError(error, res, next);
  }
};

exports.prepare = async (req, res, next) => {
  try {
    if (!req.body || Array.isArray(req.body) || Object.keys(req.body).some(name => !['clinic_id', 'clinica_id'].includes(name))) throw failure('patient_privacy_payload_invalid', 400);
    const result = await db.sequelize.transaction(async transaction => {
      const target = await scope(req, 'consents.manage', transaction, true);
      const policy = await require('../services/appointmentPrivacyEligibility.service').registrationPolicy({ db, clinicId: target.clinicId, transaction });
      if (!policy.enabled) throw failure('patient_privacy_registration_scope', 409);
      return require('../services/consentimientos.service').createPatientIntakePackage(target.patientId,
        { clinicId: target.clinicId, createdBy: target.actorId, allowLinkedClinic: true, privacyOnly: true, transaction });
    });
    return res.status(result.created_count ? 201 : 200).json(result);
  } catch (error) { return replyError(error, res, next); }
};

exports.paper = async (req, res, next) => {
  try {
    if (!req.body || Array.isArray(req.body) || req.body.acknowledged !== true
      || Object.keys(req.body).some(name => !['clinic_id', 'clinica_id', 'acknowledged'].includes(name))) {
      throw failure('appointment_consent_privacy_paper_acknowledgement_required', 400);
    }
    const result = await db.sequelize.transaction(async transaction => {
      const target = await scope(req, 'consents.manage', transaction, true);
      return require('../lib/registration-privacy-paper').recordPatientRegistrationPrivacyPaper({ db, ...target,
        acknowledged: true, transaction });
    });
    return res.status(result.created ? 201 : 200).json(result);
  } catch (error) { return replyError(error, res, next); }
};
