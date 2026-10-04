'use strict';

const { domainError, positiveInteger } = require('./treatmentPrograms.contract');
const { materializeSession } = require('./program-booking');
const { normalizeBookingProfile } = require('./booking-profile');
const { bookingSegments } = require('./appointment-booking-segments');
const { hash } = require('./cliniccloud-import/adapter');
const fail = (code, message, details = null) => { throw domainError(409, code, message, details); };
const object = value => typeof value === 'string' ? JSON.parse(value) : value || {};

function appointmentLinkRequest(payload) {
  if (!payload || !/^[a-zA-Z0-9_-]{8,80}$/.test(payload.request_key || '')
    || !/^[a-f0-9]{64}$/.test(payload.snapshot_sha256 || '')
    || !/^[a-f0-9]{64}$/.test(payload.expected_plan_revision || '')
    || !/^[a-f0-9]{64}$/.test(payload.expected_appointment_revision || '')
    || !/^[a-zA-Z0-9_-]{1,64}$/.test(payload.session_key || '')) {
    throw domainError(400, 'program_link_request_invalid', 'Actualiza el programa y elige la sesión que corresponde a esta cita.');
  }
  const contents = { action: 'link_existing_appointment', snapshot_sha256: payload.snapshot_sha256,
    expected_plan_revision: payload.expected_plan_revision, session_key: payload.session_key,
    expected_appointment_revision: payload.expected_appointment_revision,
    appointment_id: positiveInteger(payload.appointment_id, 'appointment_id') };
  return { ...contents, request_key: payload.request_key, request_sha256: hash(contents) };
}

// Linking does not rebook. Only an already equivalent, unclaimed reservation
// can enter a purchased unit. Mismatched duration, apparatus or staff remains a
// clinical review, never a reason to shorten/move the source appointment.
function compatibleLinkedAppointment(session, appointment) {
  if (session.treatment_ids.length !== 1 || Number(appointment.tratamiento_id) !== session.treatment_ids[0]) {
    fail('program_link_treatment_mismatch', 'El tratamiento individual debe coincidir exactamente con la sesión elegida. Revisa primero el tratamiento de la cita.');
  }
  if (['cancelada', 'completada', 'no_asistio'].includes(appointment.estado) || appointment.care_started_at) {
    fail('program_link_appointment_closed', 'Vincula una cita abierta y sin atención iniciada; no se modifica el historial ni se descuentan sesiones realizadas.');
  }
  const metadata = object(appointment.import_metadata);
  if (appointment.voucher_id || metadata.program_session || appointment.es_provisional || appointment.hold_expires_at) {
    fail('program_link_appointment_claimed', 'Esta cita ya tiene un bono, un programa o una reserva provisional.');
  }
  const start = new Date(appointment.inicio), finish = new Date(appointment.fin);
  const minutes = (finish - start) / 60000;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) fail('program_link_duration_mismatch', 'Revisa el horario de la cita antes de vincularla.');
  const resolved = materializeSession(session, session.duration_minutes == null ? { duration_minutes: minutes } : {});
  if (resolved.duration_minutes !== minutes) fail('program_link_duration_mismatch', 'La cita tiene una duración distinta a la sesión del programa. Se conserva su horario: revisa la correspondencia antes de vincularla.');
  const originalProfile = metadata.booking?.profile ? normalizeBookingProfile(metadata.booking.profile) : null;
  if (metadata.booking && !bookingSegments({ ...appointment, import_metadata: metadata }).length) {
    fail('program_link_resources_mismatch', 'La reserva de la cita no acredita sus fases, intervenciones o maquinaria. Revisa la cita antes de vincularla.');
  }
  const actual = metadata.booking?.phases || (resolved.booking_profile.phases.length === 1 && !originalProfile
    ? [{ start_at: start.toISOString(), end_at: finish.toISOString(), installation_id: Number(appointment.instalacion_id),
      doctor_ids: [Number(appointment.doctor_id)] }] : []);
  if (!Array.isArray(actual) || actual.length !== resolved.booking_profile.phases.length
    || originalProfile && originalProfile.phases.length !== actual.length) fail('program_link_resources_mismatch', 'La cita no acredita las fases y los recursos de la sesión del programa.');
  let previousEnd = start.getTime();
  resolved.booking_profile.phases.forEach((phase, index) => {
    const existing = actual[index], existingProfile = originalProfile?.phases[index];
    const phaseStart = new Date(existing.start_at).getTime(), phaseEnd = new Date(existing.end_at).getTime();
    const doctors = existing.doctor_ids;
    if (phaseStart !== previousEnd || phaseEnd !== phaseStart + phase.duration_minutes * 60000
      || !phase.installation_ids.includes(Number(existing.installation_id)) || !Array.isArray(doctors) || !doctors.length
      || doctors.some(id => !phase.professionals.ids.includes(Number(id)))
      || phase.professionals.mode === 'all' && (doctors.length !== phase.professionals.ids.length
        || phase.professionals.ids.some(id => !doctors.map(Number).includes(id)))
      || phase.professionals.mode === 'any' && doctors.length !== 1
      || existing.staff_time_scope != null && existing.staff_time_scope !== (phase.professionals.mode === 'all' ? 'appointment' : 'phase')
      || hash(phase.equipment_requirements || []) !== hash(existingProfile?.equipment_requirements || [])
      || hash(phase.staff_attention || []) !== hash(existingProfile?.staff_attention || [])) {
      fail('program_link_resources_mismatch', 'La sala, el profesional, la maquinaria o las fases no corresponden a esta sesión. No se ha movido la cita.');
    }
    previousEnd = phaseEnd;
  });
  if (previousEnd !== finish.getTime()) fail('program_link_duration_mismatch', 'Las fases no cubren el horario completo de la cita.');
  return { ...resolved, linked_resources: actual };
}

// A link preserves the original booking's phase keys. Bought programs use
// composed keys, so a subsequent authorized rebooking must translate selections
// against the persisted reservation, not silently let the solver ignore them.
function programBookingSelections(snapshot, appointment, selections = {}) {
  const profile = normalizeBookingProfile(snapshot.booking_profile);
  if (!profile || !selections || typeof selections !== 'object' || Array.isArray(selections)) {
    fail('program_selection_invalid', 'Actualiza las fases de la cita antes de cambiar su reserva.');
  }
  const destinations = new Map(profile.phases.map(phase => [phase.key, phase.key]));
  const metadata = object(appointment?.import_metadata);
  if (snapshot.linked_appointment && Number(snapshot.linked_appointment.id) === Number(appointment?.id_cita)
    && metadata.booking) {
    const phases = metadata.booking.phases;
    if (!Array.isArray(phases) || phases.length !== profile.phases.length
      || !bookingSegments({ ...appointment, import_metadata: metadata }).length || new Set(phases.map(phase => phase.key)).size !== phases.length) {
      fail('program_selection_invalid', 'La reserva original no acredita sus fases. Actualiza la cita.');
    }
    phases.forEach((phase, index) => {
      const target = profile.phases[index].key;
      if (destinations.has(phase.key) && destinations.get(phase.key) !== target) {
        fail('program_selection_invalid', 'Las claves de la cita y del programa son ambiguas. Revisa su reserva.');
      }
      destinations.set(phase.key, target);
    });
  }
  const result = {};
  for (const [key, value] of Object.entries(selections)) {
    const target = destinations.get(key);
    if (!target || Object.hasOwn(result, target)) {
      fail('program_selection_invalid', 'La fase elegida no pertenece a esta cita o se ha seleccionado dos veces.');
    }
    result[target] = value;
  }
  return result;
}

module.exports = { appointmentLinkRequest, compatibleLinkedAppointment, programBookingSelections };
