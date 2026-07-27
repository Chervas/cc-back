'use strict';

const asyncHandler = require('express-async-handler');
const db = require('../../models');
const reports = require('../services/appointmentClinicalReports.service');
const { canUserAccessFeature } = require('../lib/access-policy');

function actorId(req) {
  const value = Number.parseInt(String(req.userData?.userId ?? ''), 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw reports.domainError(401, 'unauthenticated', 'Usuario no autenticado.');
  }
  return value;
}

async function appointmentAccess(req, featureKey) {
  const appointment = await db.CitaPaciente.findByPk(req.params.id, {
    attributes: ['clinica_id'],
  });
  if (!appointment) throw reports.domainError(404, 'appointment_not_found', 'Cita no encontrada.');
  const allowed = await canUserAccessFeature({
    actorId: actorId(req),
    featureKey,
    clinicId: Number(appointment.clinica_id),
  });
  if (!allowed) throw reports.domainError(403, 'access_policy_forbidden', 'No tienes permisos para este informe.');
}

async function patientAccess(req, featureKey) {
  const clinicId = Number.parseInt(String(req.query.clinic_id ?? ''), 10);
  if (!Number.isInteger(clinicId) || clinicId <= 0) {
    throw reports.domainError(400, 'clinic_scope_required', 'Selecciona una clínica.');
  }
  const allowed = await canUserAccessFeature({
    actorId: actorId(req),
    featureKey,
    clinicId,
  });
  if (!allowed) throw reports.domainError(403, 'access_policy_forbidden', 'No tienes permisos para estos informes.');
  return clinicId;
}

exports.getByAppointment = asyncHandler(async (req, res) => {
  await appointmentAccess(req, 'clinical.reports.view');
  res.json(await reports.getByAppointment({ appointmentId: req.params.id }));
});

exports.save = asyncHandler(async (req, res) => {
  await appointmentAccess(req, 'clinical.reports.manage');
  res.json(await reports.save({
    appointmentId: req.params.id,
    actorId: actorId(req),
    payload: req.body,
    finalize: false,
  }));
});

exports.finalize = asyncHandler(async (req, res) => {
  await appointmentAccess(req, 'clinical.reports.manage');
  res.json(await reports.save({
    appointmentId: req.params.id,
    actorId: actorId(req),
    payload: req.body,
    finalize: true,
  }));
});

exports.listForPatient = asyncHandler(async (req, res) => {
  const clinicId = await patientAccess(req, 'clinical.reports.view');
  res.json(await reports.listForPatient({
    patientIdentifier: req.params.patientId,
    clinicId,
  }));
});
