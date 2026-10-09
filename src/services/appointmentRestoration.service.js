'use strict';
const contract = require('../lib/appointment-restoration');
const links = require('./appointmentPatientLinks.service');
const { bookingError } = require('./treatmentBookingProfile.service');

async function loadPlan({ db, appointmentId, actorId, transaction, lock = false }) {
  const group = await links.load(db, appointmentId, transaction, lock);
  const selected = group ? group.rows.find(row => Number(row.id_cita) === Number(appointmentId))
    : await db.CitaPaciente.findByPk(appointmentId, { transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
  if (!selected) throw bookingError('appointment_not_found', 'Cita no encontrada.', null, 404);
  if (!db.PatientOperationalEvent) throw bookingError('booking_restore_history_required', 'El historial de cancelaciones no está disponible. No se ha cambiado la cita.');
  const rows = group?.rows || [selected];
  const events = await db.PatientOperationalEvent.findAll({ where: { clinic_id: selected.clinica_id,
    patient_id: selected.paciente_id || null, event_type: 'appointment.status_changed' },
    order: [['occurred_at', 'DESC'], ['id', 'DESC']], transaction });
  return { group, selected, rows, plan: contract.buildRestorationPlan({ rows, events, actorId, selectedId: appointmentId, link: group?.link }) };
}
async function previewRestoration(input) {
  try { return contract.preview((await loadPlan(input)).plan); }
  catch (error) {
    if (!String(error.code || '').startsWith('booking_restore_')) throw error;
    return { can_restore: false, code: error.code, message: error.message, communications_suppressed: true };
  }
}
async function restoreAppointment({ db, appointmentId, actorId, acknowledgement, restrictionAcknowledgement, expectedPlanSha256 }) {
  return db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
    const current = await loadPlan({ db, appointmentId, actorId, transaction, lock: true });
    contract.assertRestorationAcknowledgement(current.plan, acknowledgement);
    const options = { transaction, actorId, states: new Map(current.plan.members.map(row => [row.appointment_id, row.previous_status])),
      restorationAcknowledgement: current.plan.acknowledgement, restrictionConfirmation: { actorId, acknowledgement: restrictionAcknowledgement },
      expectedPlanSha256 };
    const result = current.group ? await links.restoreTogether(db, appointmentId, options)
      : { selected: await require('./appointmentBookingCommand.service').mutateAppointmentBooking({ db, transaction,
        existingAppointmentId: appointmentId, appointmentValues: { estado: options.states.get(Number(appointmentId)), updated_by: actorId },
        allowObsolete: true, administrativeRestore: true, restrictionConfirmation: options.restrictionConfirmation, expectedPlanSha256,
        persist: ({ values, existing }) => existing.update(values, { transaction }) }) };
    const restored = result.rows || [result.selected];
    for (const row of restored) await require('./appointmentActivity.service').recordAppointmentStatusChange({ appointment: row,
      previousStatus: 'cancelada', newStatus: options.states.get(Number(row.id_cita)), actorUserId: actorId, transaction, administrativeRestore: true,
      source: 'agenda', metadata: { action: 'appointment_restored', restoration_acknowledgement: current.plan.acknowledgement,
        cancellation_event_id: current.plan.members.find(member => member.appointment_id === Number(row.id_cita)).cancellation_event_id,
        communications_suppressed: true, ...(current.group ? { appointment_link_id: current.group.link.id } : {}) } });
    return { selected: result.selected, rows: restored, restoration: { ...contract.preview(current.plan), restored: true } };
  });
}
module.exports = { previewRestoration, restoreAppointment };
