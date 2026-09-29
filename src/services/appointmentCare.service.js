'use strict';
const db = require('../../models');
const { careState, assertCareAction } = require('../lib/appointment-care');
const { assessAppointmentClinicalConsent } = require('./appointmentConsentEligibility.service');

async function record({ appointmentId, clinicId, actorId, action }) {
  return db.sequelize.transaction(async transaction => {
    const cita = await db.CitaPaciente.findByPk(appointmentId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!cita) throw Object.assign(new Error('Cita no encontrada.'), { statusCode: 404, code: 'appointment_not_found' });
    if (Number(cita.clinica_id) !== Number(clinicId)) throw Object.assign(new Error('La cita ha cambiado de clínica. Vuelve a abrirla.'), { statusCode: 409, code: 'appointment_clinic_changed' });
    const now = new Date(), state = assertCareAction(cita, action, now);
    if (action === 'arrive' && state.arrived_at || action === 'start' && state.started_at) return { appointment: cita, care: state, replayed: true };
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
    }
    const patch = action === 'arrive'
      ? { arrived_at: now, arrived_by: actorId, care_started_at: null, care_started_by: null, care_schedule_start: cita.inicio }
      : { care_started_at: now, care_started_by: actorId };
    // Deliberately not the canonical estado writer: no completion, voucher use,
    // charges or automation events are caused by arrival/start.
    await cita.update({ ...patch, updated_by: actorId }, { transaction });
    await db.AppointmentCareEvent.create({ appointment_id: cita.id_cita, clinic_id: cita.clinica_id, actor_id: actorId,
      action, schedule_start: cita.inicio, created_at: now }, { transaction });
    await db.PatientOperationalEvent.create({ patient_id: cita.paciente_id, clinic_id: cita.clinica_id, actor_user_id: actorId,
      event_type: 'appointment_care_changed', source: 'agenda', occurred_at: now,
      metadata: { appointment_id: cita.id_cita, action, schedule_start: cita.inicio } }, { transaction });
    return { appointment: cita, care: careState(cita, now), replayed: false };
  });
}
module.exports = { record };
