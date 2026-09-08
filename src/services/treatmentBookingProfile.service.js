'use strict';

const { normalizeBookingProfile, requiresMultiResourceBooking } = require('../lib/booking-profile');

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
  return { simple, multi: simple && environment.BOOKING_MULTI_RESOURCE_ENABLED === 'true' };
}

function parseClinicalConfig(treatment) {
  let config = treatment?.clinical_config;
  if (typeof config === 'string') {
    try { config = JSON.parse(config); } catch { throw bookingError('booking_profile_invalid', 'La configuración del tratamiento no es válida.'); }
  }
  return config && typeof config === 'object' && !Array.isArray(config) ? config : {};
}

function requireOperationalProfile(treatment, { capabilities = bookingCapabilities(), allowObsolete = false } = {}) {
  const config = parseClinicalConfig(treatment);
  if (!allowObsolete && (config.catalog_status === 'obsolete' || config.catalog_status === 'draft' || treatment?.activo === false)) {
    throw bookingError('treatment_not_bookable', 'Este tratamiento está obsoleto o en borrador. Selecciona un tratamiento vigente.');
  }
  const profile = normalizeBookingProfile(config.booking_profile);
  if (!profile) return null;
  if (!capabilities.simple || (requiresMultiResourceBooking(profile) && !capabilities.multi)) {
    throw bookingError('booking_profile_runtime_unavailable',
      requiresMultiResourceBooking(profile)
        ? 'El tratamiento requiere fases o un equipo simultáneo. La reserva multicabina/equipo todavía no está activada.'
        : 'El perfil de agenda está configurado, pero su reserva todavía no está activada.',
      { configured: true, simple_enabled: capabilities.simple, multi_enabled: capabilities.multi, can_force: false });
  }
  return profile;
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
  if (!treatment || (treatment.origen === 'clinica' && Number(treatment.clinica_id) !== clinicId)
    || (treatment.origen === 'grupo' && (!groupId || treatmentGroupId !== groupId))) {
    throw bookingError('treatment_not_found', 'Tratamiento no encontrado.', null, 404);
  }
  const hidden = treatment.eliminado_por_clinica;
  if (Array.isArray(hidden) && hidden.map(Number).includes(clinicId)) {
    throw bookingError('treatment_not_found', 'Tratamiento no encontrado.', null, 404);
  }
  return treatment;
}

function assertPriorityAcknowledgement(solution, acknowledged) {
  if (solution?.requires_priority_acknowledgement && acknowledged !== true) {
    throw bookingError('booking_priority_confirmation_required',
      'La cita la atenderá un profesional que no es el prioritario. Confirma si deseas agendarla de todos modos.',
      { warnings: solution.warnings, can_force: false });
  }
}

function bookingErrorMiddleware(error, req, res, next) {
  if (!/^(booking_|treatment_not_|treatment_not_found)/.test(String(error?.code || ''))) return next(error);
  return res.status(error.statusCode || 409).json({ code: error.code, message: error.message, details: error.details || null, can_force: false });
}

module.exports = { bookingError, bookingCapabilities, parseClinicalConfig, requireOperationalProfile,
  loadScopedTreatment, assertPriorityAcknowledgement, bookingErrorMiddleware };
