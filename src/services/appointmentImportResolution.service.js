'use strict';

const { createHash } = require('node:crypto');
const { importReviewVersion, importTreatmentPending } = require('../lib/appointment-import-review');
const { bookingError, bookingCapabilities } = require('./treatmentBookingProfile.service');
const { mutateAppointmentBooking } = require('./appointmentBookingCommand.service');

const plain = row => row?.toJSON ? row.toJSON() : row;
const metadata = row => typeof row.import_metadata === 'string' ? JSON.parse(row.import_metadata) : (row.import_metadata || {});
const fail = (suffix, message, status = 409) => { throw bookingError(`booking_import_${suffix}`, message, null, status); };

function normalizeResolution(input) {
  if (!input || !['treatment', 'no_treatment'].includes(input.mode)
    || !/^[a-f0-9]{64}$/.test(input.expected_version || '')
    || typeof input.reason !== 'string' || input.reason.trim().length < 3 || input.reason.trim().length > 500) {
    fail('invalid', 'Selecciona cómo resolver la cita y explica brevemente la decisión.', 400);
  }
  const result = { mode: input.mode, expected_version: input.expected_version, reason: input.reason.trim() };
  if (input.mode === 'treatment') {
    if (!Number.isSafeInteger(input.treatment_id) || input.treatment_id < 1 || input.visit_type != null) {
      fail('invalid', 'Selecciona un tratamiento del catálogo.', 400);
    }
    result.treatment_id = input.treatment_id;
  } else {
    if (input.treatment_id != null || !['revision', 'primera_sin_trat'].includes(input.visit_type)) {
      fail('invalid', 'Confirma si es una primera visita sin tratamiento o una revisión.', 400);
    }
    result.visit_type = input.visit_type;
  }
  return result;
}

// One explicit clinical classification, never a generic appointment patch.
// No notifications, signatures, charges, program consumption or automation hooks.
async function resolveImportedTreatment({ db, appointmentId, clinicId, actorId, input,
  capabilities = bookingCapabilities(), transaction = null }) {
  const decision = normalizeResolution(input);
  if (!Number.isSafeInteger(actorId) || actorId < 1) fail('actor_required', 'Falta el usuario que revisa la cita.', 403);
  if (!capabilities.simple) throw bookingError('booking_profile_runtime_unavailable', 'La reserva de perfiles todavía no está activada.');
  const requestHash = createHash('sha256').update(JSON.stringify({ appointmentId, clinicId, actorId, ...decision })).digest('hex');
  const execute = async tx => {
    if (tx.options?.isolationLevel !== 'READ COMMITTED') throw Error('booking_requires_read_committed');
    const row = await db.CitaPaciente.findByPk(appointmentId, { transaction: tx, lock: tx.LOCK.UPDATE });
    if (!row || Number(row.clinica_id) !== Number(clinicId)) fail('not_found', 'Cita no encontrada.', 404);
    const before = plain(row);
    const original = metadata(before);
    // A lost HTTP response may be retried. Do not rebook or overwrite subsequent
    // edits, and never append a second operational event for the same decision.
    if (original.import_treatment_resolution?.request_hash === requestHash) return { appointment: row, replayed: true };
    if (!importTreatmentPending(before) || original.import_treatment_resolution || before.voucher_id
      || original.program_session || before.es_provisional || before.hold_expires_at
      || ['cancelada', 'completada', 'no_asistio'].includes(before.estado)) {
      fail('not_resolvable', 'Esta acción solo completa citas importadas abiertas, sin tratamiento ni programa ya vinculado.');
    }
    if (decision.expected_version !== importReviewVersion(before)) {
      fail('changed', 'La cita ha cambiado. Ciérrala y vuelve a abrirla antes de confirmar.');
    }
    // Existing clinical/economic/documentary links must be reviewed through their
    // own correction workflows, never reinterpreted by an import assignment.
    for (const [model, field] of [['AppointmentClinicalReport', 'appointment_id'],
      ['PatientNutritionMeasurement', 'appointment_id'], ['PatientNutritionReport', 'appointment_id'],
      ['PatientConsentDocument', 'cita_id'], ['PatientVoucherMovement', 'appointment_id'],
      ['PatientProgramSession', 'appointment_id']]) {
      if (await db[model].findOne({ where: { [field]: appointmentId }, attributes: ['id'],
        transaction: tx, lock: tx.LOCK.SHARE })) {
        fail('history_exists', 'La cita ya tiene documentación clínica o económica. Revisa esa documentación antes de cambiar su clasificación.');
      }
    }
    const appointment = await mutateAppointmentBooking({ db, existingAppointmentId: appointmentId, transaction: tx,
      capabilities, priorityAcknowledged: input.priority_acknowledged === true,
      appointmentValues: { updated_by: actorId, ...(decision.mode === 'treatment'
        ? { tratamiento_id: decision.treatment_id } : { tipo_cita: decision.visit_type }) },
      persist: async ({ values, existing, transaction: bookingTx }) => {
        for (const field of ['doctor_id', 'instalacion_id']) {
          if (before[field] && Number(before[field]) !== Number(values[field])) {
            fail('resource_change', 'El tratamiento necesita otros recursos. Revisa el profesional y la cabina desde Editar antes de vincularlo.');
          }
        }
        // Only this authenticated resolution service authors the marker. Generic
        // booking requests cannot supply it, even when the booking gate is off.
        const resolution = { version: 1, mode: decision.mode, treatment_id: decision.treatment_id || null,
          visit_type: values.tipo_cita, previous_visit_type: before.tipo_cita, appointment_id: appointmentId,
          patient_id: Number(before.paciente_id), clinic_id: Number(before.clinica_id), actor_id: actorId,
          reason: decision.reason, reviewed_at: new Date().toISOString(), request_hash: requestHash };
        const saved = await existing.update({ tratamiento_id: values.tratamiento_id,
          tipo_cita: values.tipo_cita, doctor_id: values.doctor_id, instalacion_id: values.instalacion_id,
          updated_by: actorId, import_metadata: { ...metadata(values), import_treatment_resolution: resolution } },
        { transaction: bookingTx });
        await db.PatientOperationalEvent.create({ patient_id: before.paciente_id, clinic_id: before.clinica_id,
          actor_user_id: actorId, event_type: 'appointment.import_resolved', source: 'agenda', channel: null,
          metadata: { appointment_id: appointmentId, mode: decision.mode, treatment_id: resolution.treatment_id,
            previous_visit_type: before.tipo_cita, visit_type: values.tipo_cita, reason: decision.reason,
            previous_doctor_id: before.doctor_id || null, doctor_id: values.doctor_id || null,
            previous_installation_id: before.instalacion_id || null, installation_id: values.instalacion_id || null,
            preserves_status_and_schedule: true, preserves_notification_suppression: true }, occurred_at: new Date() },
        { transaction: bookingTx });
        return saved;
      },
    });
    return { appointment, replayed: false };
  };
  return transaction ? execute(transaction) : db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, execute);
}

module.exports = { normalizeResolution, resolveImportedTreatment };
