'use strict';

const { mutateAppointmentBooking } = require('./appointmentBookingCommand.service');
const { additionalStaffPayload } = require('../lib/appointment-additional-staff');

// Deliberately no automation, milestone, notification or economic dependencies.
// The event and the reservation commit together; the controller emits only the
// normal calendar refresh after that commit.
async function changeAppointmentSupport({ db, appointmentId, actorId, ids, expectedRange, capabilities }) {
  return mutateAppointmentBooking({ db, existingAppointmentId: appointmentId,
    appointmentValues: { updated_by: actorId }, additionalStaffIds: ids,
    supportOnly: true, expectedRange, capabilities, allowObsolete: true,
    persist: async ({ values, existing, transaction }) => {
      const before = additionalStaffPayload(existing);
      const saved = await existing.update(values, { transaction });
      const after = additionalStaffPayload(saved);
      if (JSON.stringify(before.map(p => p.id)) !== JSON.stringify(after.map(p => p.id))) {
        await db.PatientOperationalEvent.create({ patient_id: saved.paciente_id, clinic_id: saved.clinica_id,
          actor_user_id: actorId, event_type: 'appointment.staff_changed', source: 'agenda', channel: null,
          metadata: { appointment_id: saved.id_cita, previous_support: before, additional_staff: after,
            preserves_status_and_schedule: true }, occurred_at: new Date() }, { transaction });
      }
      return saved;
    },
  });
}

module.exports = { changeAppointmentSupport };
