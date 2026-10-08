'use strict';
const db = require('../../models');
const { careState, assertCareAction, careActionPatch } = require('../lib/appointment-care');
const { assessAppointmentClinicalConsent } = require('./appointmentConsentEligibility.service');
const { createTreatmentDocumentationService } = require('./treatmentDocumentation.service');

async function record({ appointmentId, clinicId, actorId, action }) {
  if (!['arrive', 'start'].includes(action)) throw Object.assign(new Error('Finaliza la atención mediante el cambio de estado canónico.'), {
    statusCode: 400, code: 'care_action_invalid',
  });
  return db.sequelize.transaction(async transaction => {
    const cita = await db.CitaPaciente.findByPk(appointmentId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!cita) throw Object.assign(new Error('Cita no encontrada.'), { statusCode: 404, code: 'appointment_not_found' });
    if (Number(cita.clinica_id) !== Number(clinicId)) throw Object.assign(new Error('La cita ha cambiado de clínica. Vuelve a abrirla.'), { statusCode: 409, code: 'appointment_clinic_changed' });
    const now = new Date(), state = assertCareAction(cita, action, now);
    if (action === 'arrive' && state.arrived_at || action === 'start' && state.started_at) return { appointment: cita, care: state, replayed: true };
    let documentationSnapshot;
    if (action === 'start') {
      let consent;
      try { consent = await assessAppointmentClinicalConsent({ db, appointment: cita, transaction, now }); }
      catch (error) {
        if (error.code === 'appointment_consent_import_review_required') error.message = 'Completa el tratamiento importado o confirma que es una visita sin tratamiento antes de iniciar la cita.';
        throw error;
      }
      if (!consent.allowed) throw Object.assign(new Error('Faltan consentimientos clínicos obligatorios con firma vigente. Revisa las firmas pendientes antes de iniciar la cita.'), {
        statusCode: 409, code: 'appointment_consent_required',
      });
      // Capture exact approved protocol references while this same transaction
      // owns the appointment. Never use the paginated contextual list, accept
      // client references or backfill an already-started historical visit.
      documentationSnapshot = await createTreatmentDocumentationService(db).captureForStart({ appointment: cita, transaction, now });
    }
    const previousStatus = cita.estado;
    const patch = careActionPatch(cita, action, { now, actorId });
    // Arrival/start never claim completion, consume vouchers or dispatch messages.
    await cita.update({ ...patch, updated_by: actorId }, { transaction });
    await require('./appointmentActivity.service').recordAppointmentStatusChange({ appointment: cita,
      previousStatus, newStatus: patch.estado, actorUserId: actorId, source: 'agenda',
      metadata: { care_action: action }, occurredAt: now, transaction });
    const careEvent = await db.AppointmentCareEvent.create({ appointment_id: cita.id_cita, clinic_id: cita.clinica_id, actor_id: actorId,
      action, schedule_start: cita.inicio, created_at: now }, { transaction });
    await db.PatientOperationalEvent.create({ patient_id: cita.paciente_id, clinic_id: cita.clinica_id, actor_user_id: actorId,
      event_type: 'appointment_care_changed', source: 'agenda', occurred_at: now,
      metadata: { appointment_id: cita.id_cita, action, schedule_start: cita.inicio, care_event_id: careEvent.id,
        ...(action === 'start' ? { documentation_snapshot: documentationSnapshot } : {}) } }, { transaction });
    return { appointment: cita, care: careState(cita, now), previousStatus, replayed: false };
  });
}
// A reception correction is audited separately from the canonical status
// transition. Never silently undo clinical work or voucher consumption.
async function confirmedCorrection({ cita, nextStatus, actorId, transaction, models = db }) {
  if (!['info_confirmada', 'recordatorio_confirmado'].includes(nextStatus)) return {};
  const state = careState(cita);
  if (!state.arrived_at) return {};
  if (state.started_at) throw Object.assign(new Error('La cita ya se ha iniciado. No se puede deshacer su llegada desde recepción; conserva la atención clínica.'), {
    statusCode: 409, code: 'care_already_started',
  });
  const now = new Date();
  await models.AppointmentCareEvent.create({ appointment_id: cita.id_cita, clinic_id: cita.clinica_id, actor_id: actorId,
    action: 'arrival_corrected', schedule_start: cita.inicio, created_at: now }, { transaction });
  await models.PatientOperationalEvent.create({ patient_id: cita.paciente_id, clinic_id: cita.clinica_id, actor_user_id: actorId,
    event_type: 'appointment_care_changed', source: 'agenda', occurred_at: now,
    metadata: { appointment_id: cita.id_cita, action: 'arrival_corrected', previous_arrived_at: state.arrived_at,
      next_status: nextStatus, schedule_start: cita.inicio } }, { transaction });
  return { arrived_at: null, arrived_by: null, care_started_at: null, care_started_by: null, care_schedule_start: null };
}
async function recordCompletion({ models = db, appointment, transaction, actorId }) {
  const care = careState(appointment);
  if (!require('../lib/appointment-care').hasCompletedAppointmentCare(appointment)) throw Error('care_completion_evidence_required');
  const event = await models.AppointmentCareEvent.create({ appointment_id: appointment.id_cita,
    clinic_id: appointment.clinica_id, actor_id: actorId, action: 'finish', schedule_start: appointment.inicio,
    created_at: care.completed_at }, { transaction });
  await models.PatientOperationalEvent.create({ patient_id: appointment.paciente_id, clinic_id: appointment.clinica_id,
    actor_user_id: actorId, event_type: 'appointment_care_changed', source: 'agenda', occurred_at: care.completed_at,
    metadata: { appointment_id: appointment.id_cita, action: 'finish', schedule_start: appointment.inicio,
      care_event_id: event.id, care_lifecycle_version: 2 } }, { transaction });
}
module.exports = { record, confirmedCorrection, recordCompletion };
