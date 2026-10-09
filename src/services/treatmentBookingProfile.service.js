'use strict';

const { normalizeBookingProfile, requiresMultiResourceBooking, pendingAttentionRequirements } = require('../lib/booking-profile');

function bookingError(code, message, details = null, statusCode = 409) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.status = statusCode;
  if (details) error.details = details;
  return error;
}

function bookingCapabilities(environment = process.env) {
  const simple = environment.BOOKING_PROFILES_ENABLED === 'true';
  const multi = simple && environment.BOOKING_MULTI_RESOURCE_ENABLED === 'true';
  return { simple, multi, relativeSteps: multi && environment.BOOKING_PHASE_OFFSETS_ENABLED === 'true' };
}

// A v4 profile is not a v3 itinerary: offsets, partial staff attention and the
// visit span must be understood by every read/write consumer before activation.
// Also used for contracted/snapshot profiles, without applying catalog lifecycle
// restrictions to an existing purchase. Cancellation does not need this gate.
function assertOperationalBookingProfile(profile, { capabilities = bookingCapabilities() } = {}) {
  if (!profile) return null;
  const advanced = requiresMultiResourceBooking(profile);
  if (!capabilities.simple || (advanced && !capabilities.multi) || (profile.version === 4 && capabilities.relativeSteps !== true)) {
    throw bookingError('booking_profile_runtime_unavailable',
      profile.version === 4
        ? 'La reserva por pasos y tiempos de atención todavía no está habilitada. Se conserva la configuración; no puede reservarse hasta completar su publicación.'
        : advanced
          ? 'El tratamiento requiere fases o un equipo simultáneo. La reserva multicabina/equipo todavía no está activada.'
          : 'El perfil de agenda está configurado, pero su reserva todavía no está activada.',
      { configured: true, simple_enabled: capabilities.simple === true, multi_enabled: capabilities.multi === true,
        relative_steps_enabled: capabilities.relativeSteps === true, can_force: false });
  }
  const pending = pendingAttentionRequirements(profile);
  if (pending.length) throw bookingError('pending_attention_requirements',
    'Falta definir el tiempo de algunas intervenciones del profesional. No se puede confirmar disponibilidad completa para esta visita.',
    { requirements: pending, can_force: false });
  if (profile.version === 4 && profile.phases.some(phase => (phase.equipment_requirements || []).length > 1)) {
    throw bookingError('booking_profile_attention_ambiguous',
      'Define un paso por técnica para conservar la atención de cada máquina. Esta configuración todavía no puede reservarse.',
      { can_force: false });
  }
  return profile;
}

function parseClinicalConfig(treatment) {
  let config = treatment?.clinical_config;
  if (typeof config === 'string') {
    try { config = JSON.parse(config); } catch { throw bookingError('booking_profile_invalid', 'La configuración del tratamiento no es válida.'); }
  }
  return config && typeof config === 'object' && !Array.isArray(config) ? config : {};
}

function requireOperationalProfile(treatment, { capabilities = bookingCapabilities(), allowObsolete = false,
  durationSelection, allowMissingDuration = false } = {}) {
  const config = parseClinicalConfig(treatment);
  if (require('../lib/historical-treatment-reference').isHistoricalTreatment(treatment)) {
    throw bookingError('treatment_not_bookable', 'Esta referencia conserva una reserva importada; no puede utilizarse para dar nuevas citas.');
  }
  if (!allowObsolete && (config.catalog_status === 'obsolete' || config.catalog_status === 'draft' || treatment?.activo === false)) {
    throw bookingError('treatment_not_bookable', 'Este tratamiento está obsoleto o en borrador. Selecciona un tratamiento vigente.');
  }
  const { profile } = require('../lib/booking-profile-duration').resolveBookingProfileDuration(config.booking_profile,
    { durationSelection, allowMissingDuration });
  return assertOperationalBookingProfile(profile, { capabilities });
}

// Editing previews resolve only a server-owned appointment snapshot. A changed
// catalog template must not resize its old reservation or choose new minutes.
async function resolveAppointmentBookingProfile({ db, treatment, clinic, existingAppointmentId = null,
  capabilities = bookingCapabilities(), durationSelection, transaction = null, allowObsolete = false }) {
  if (existingAppointmentId == null) return requireOperationalProfile(treatment, { capabilities, durationSelection, allowObsolete });
  const id = Number(existingAppointmentId);
  if (!Number.isSafeInteger(id) || id < 1) throw bookingError('booking_ignore_invalid', 'Revisa la cita que quieres modificar.', null, 400);
  const stored = await db.CitaPaciente.findByPk(id, { transaction });
  const appointment = stored?.toJSON ? stored.toJSON() : stored;
  if (!appointment || Number(appointment.clinica_id) !== Number(clinic.id_clinica)
    || Number(appointment.tratamiento_id) !== Number(treatment?.id_tratamiento)) {
    throw bookingError('appointment_not_found', 'Cita no encontrada.', null, 404);
  }
  let metadata = appointment.import_metadata;
  if (typeof metadata === 'string') { try { metadata = JSON.parse(metadata); } catch {
    throw bookingError('booking_profile_invalid', 'La configuración guardada de la cita no es válida.');
  } }
  if (metadata?.booking != null) {
    const profile = normalizeBookingProfile(metadata.booking.profile);
    if (!profile) throw bookingError('booking_profile_invalid', 'Falta el perfil guardado de la cita.');
    return requireOperationalProfile({ activo: true, clinical_config: { booking_profile: profile } }, { capabilities, durationSelection });
  }
  return requireOperationalProfile(treatment, { capabilities, durationSelection, allowObsolete });
}

async function loadScopedTreatment({ db, treatmentId, clinic, transaction = null }) {
  if (treatmentId == null || treatmentId === '') return null;
  const id = Number(treatmentId);
  if (!Number.isSafeInteger(id) || id <= 0) throw bookingError('treatment_not_found', 'Tratamiento no encontrado.', null, 404);
  const treatment = await db.Tratamiento.findByPk(id, { transaction });
  const clinicId = Number(clinic?.id_clinica);
  const groupId = Number(clinic?.grupoClinicaId);
  let treatmentGroupId = Number(treatment?.grupo_clinica_id);
  if (treatment?.origen === 'grupo' && !treatmentGroupId && treatment.clinica_id) {
    const owner = await db.Clinica.findByPk(treatment.clinica_id, { attributes: ['grupoClinicaId'], transaction });
    treatmentGroupId = Number(owner?.grupoClinicaId);
  }
  if (!treatment || !['sistema', 'clinica', 'grupo'].includes(treatment.origen) || (treatment.origen === 'clinica' && Number(treatment.clinica_id) !== clinicId)
    || (treatment.origen === 'grupo' && (!groupId || treatmentGroupId !== groupId))) {
    throw bookingError('treatment_not_found', 'Tratamiento no encontrado.', null, 404);
  }
  let hidden = treatment.eliminado_por_clinica;
  if (typeof hidden === 'string') { try { hidden = JSON.parse(hidden); } catch { throw bookingError('treatment_not_found', 'Tratamiento no encontrado.', null, 404); } }
  if (Array.isArray(hidden) && hidden.map(Number).includes(clinicId)) {
    throw bookingError('treatment_not_found', 'Tratamiento no encontrado.', null, 404);
  }
  return treatment;
}

function assertPriorityAcknowledgement(solution, acknowledged) {
  if (solution?.requires_priority_acknowledgement && acknowledged !== true) {
    throw bookingError('booking_priority_confirmation_required',
      'La cita la atenderá un profesional que no es el prioritario. Confirma si deseas agendarla de todos modos.',
      { warnings: (solution.warnings || []).map(warning => {
        const phase = solution.phases?.find(item => item.key === warning.phase_key);
        const index = phase?.doctor_ids?.indexOf(warning.doctor_id) ?? -1;
        return { ...warning, ...(index >= 0 && phase.doctor_names?.[index] ? { doctor_name: phase.doctor_names[index] } : {}) };
      }), can_force: false });
  }
}

function bookingErrorMiddleware(error, req, res, next) {
  if (!/^(care_|booking_|program_|pending_attention_requirements$|appointment_consent_|appointment_clinical_component_|appointment_link_|appointment_same_day_|historical_reference_|treatment_not_|treatment_not_found)/.test(String(error?.code || ''))) return next(error);
  return res.status(error.statusCode || 409).json(bookingErrorPayload(error));
}

function bookingErrorPayload(error) {
  const canForce = error?.code === 'booking_unavailable' && error?.details?.can_force === true;
  return { code: error.code, message: error.message, details: error.details || null, can_force: canForce,
    ...(error?.code === 'booking_restriction_confirmation_required' ? {
      can_confirm_restrictions: error.details?.can_confirm_restrictions === true,
      booking_restriction_acknowledgement: error.details?.booking_restriction_acknowledgement || null,
      booking_restrictions: error.details?.booking_restrictions || [],
      booking: error.details?.booking || null,
      booking_plan_sha256: error.details?.booking_plan_sha256 || null,
      ...(Number.isInteger(error.details?.linked_appointments) && error.details.linked_appointments > 1
        ? { linked_appointments: error.details.linked_appointments } : {}),
    } : {}),
    ...(error?.code === 'booking_patient_overlap' ? {
      can_confirm_patient_overlap: error.details?.can_confirm_patient_overlap === true,
      patient_overlap_acknowledgement: error.details?.patient_overlap_acknowledgement || null,
      patient_conflicts: error.details?.patient_conflicts || [],
    } : {}),
    ...(canForce ? { reason: 'overlap', conflicts: [{ type: 'overlap', message: 'Recurso ocupado por otra cita de esta clínica' }] } : {}) };
}

module.exports = { bookingError, bookingCapabilities, parseClinicalConfig, requireOperationalProfile, resolveAppointmentBookingProfile, assertOperationalBookingProfile,
  loadScopedTreatment, assertPriorityAcknowledgement, bookingErrorMiddleware, bookingErrorPayload,
  assertTreatmentBookingVisibility: (...args) => require('./treatmentBookingEligibility.service').assertTreatmentBookingVisibility(...args) };
