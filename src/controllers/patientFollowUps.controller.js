'use strict';

const asyncHandler = require('express-async-handler');
const service = require('../services/patientFollowUps.service');
const canUserAccessFeature = (...args) => require('../lib/access-policy').canUserAccessFeature(...args);

function createPatientFollowUpsController({ followUps = service, canAccess = canUserAccessFeature } = {}) {
  async function context(req, { writing = false, sourceReport = false } = {}) {
    if (!req.userData?.userId) throw followUps.domainError(401, 'unauthenticated', 'Usuario no autenticado.');
    const actorId = followUps.positiveInteger(req.userData.userId, 'actor_id');
    const clinicId = followUps.positiveInteger(req.query.clinic_id ?? (req.method === 'POST' ? req.body?.clinic_id : null), 'clinic_id');
    // A reason for follow-up is health data, even when labelled operational.
    const required = [writing ? 'appointments.manage' : 'appointments.view', 'patients.view', 'patients.sensitive.view'];
    if (sourceReport) required.push('clinical.reports.manage');
    const checks = await Promise.all(required.map((featureKey) => canAccess({ actorId, clinicId, featureKey })));
    if (checks.some((allowed) => !allowed)) throw followUps.domainError(403, 'access_policy_forbidden', 'No tienes permisos para estos seguimientos.');
    const includeClinical = await canAccess({ actorId, clinicId, featureKey: writing ? 'clinical.reports.manage' : 'clinical.reports.view' });
    return { actorId, clinicId, includeClinical };
  }

  return {
    list: asyncHandler(async (req, res) => {
      const ctx = await context(req);
      res.set('Cache-Control', 'no-store');
      res.json(await followUps.list({ ...ctx, patientIdentifier: req.query.patient_id, query: req.query }));
    }),
    get: asyncHandler(async (req, res) => {
      const ctx = await context(req);
      res.set('Cache-Control', 'no-store');
      res.json(await followUps.get({ ...ctx, id: req.params.id }));
    }),
    getForSourceAppointment: asyncHandler(async (req, res) => {
      const ctx = await context(req);
      res.set('Cache-Control', 'no-store');
      res.json(await followUps.getForSourceAppointment({ ...ctx, appointmentId: req.params.appointmentId }));
    }),
    create: asyncHandler(async (req, res) => {
      const ctx = await context(req, { writing: true, sourceReport: req.body?.source_appointment_id != null || req.body?.source_kind === 'clinical_report' });
      const result = await followUps.create({ ...ctx, patientIdentifier: req.body?.patient_id, payload: req.body });
      res.set('Cache-Control', 'no-store');
      res.status(result.created ? 201 : 200).json(result);
    }),
    update: asyncHandler(async (req, res) => {
      const ctx = await context(req, { writing: true });
      res.set('Cache-Control', 'no-store');
      res.json(await followUps.update({ ...ctx, id: req.params.id, payload: req.body }));
    }),
    appointmentCandidates: asyncHandler(async (req, res) => {
      const ctx = await context(req);
      res.set('Cache-Control', 'no-store');
      res.json(await followUps.appointmentCandidates({ ...ctx, id: req.params.id, query: req.query }));
    }),
  };
}

module.exports = { ...createPatientFollowUpsController(), createPatientFollowUpsController };
