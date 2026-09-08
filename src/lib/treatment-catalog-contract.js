'use strict';

const { normalizeBookingProfile, requiresMultiResourceBooking } = require('./booking-profile');
const STATUSES = new Set(['active', 'draft', 'obsolete']);

function catalogError(message, code = 'invalid_treatment_catalog', status = 400) {
  return Object.assign(new Error(message), { status, statusCode: status, code });
}

function isObsolete(treatment) {
  return treatment?.clinical_config?.catalog_status === 'obsolete';
}

function assertCatalogEditable(treatment) {
  if (isObsolete(treatment)) throw catalogError('Este tratamiento está obsoleto. Su historia se conserva y no se modifica desde el catálogo.', 'treatment_obsolete', 409);
}

// Omitted keys are preserved for older clients. Explicit null removes an individual key.
// Never clear the full JSON because a client does not know newer configuration fields.
function mergeClinicalConfig(previous, patch) {
  const result = previous && typeof previous === 'object' && !Array.isArray(previous) ? { ...previous } : {};
  if (patch != null) {
    if (typeof patch !== 'object' || Array.isArray(patch)) throw catalogError('clinical_config debe ser un objeto.');
    for (const [key, value] of Object.entries(patch)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw catalogError('Clave de configuración no válida.');
      if (value === null) delete result[key];
      else result[key] = value;
    }
  }
  if (result.catalog_status != null && !STATUSES.has(result.catalog_status)) throw catalogError('Estado de catálogo no válido.');
  if (result.booking_profile != null) {
    result.booking_profile = normalizeBookingProfile(result.booking_profile, { allowIncomplete: result.catalog_status === 'draft' });
  }
  return Object.keys(result).length ? result : null;
}

function catalogState(treatment) {
  const config = treatment?.clinical_config || {};
  const status = config.catalog_status || (treatment?.activo === false ? 'inactive' : 'active');
  const reasons = [];
  if (status !== 'active' || treatment?.activo === false) reasons.push(status);
  if (config.booking_profile) {
    try {
      const profile = normalizeBookingProfile(config.booking_profile);
      if (requiresMultiResourceBooking(profile)) reasons.push('advanced_booking_required');
    } catch (_) { reasons.push('incomplete_booking_profile'); }
  }
  return { status, editable: status !== 'obsolete', booking_ready: reasons.length === 0, booking_issues: reasons };
}

module.exports = { mergeClinicalConfig, assertCatalogEditable, isObsolete, catalogState, catalogError };
