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
  // Import provenance and its approval are server-owned. Old clients may echo
  // these values, but cannot erase a hold or manufacture an approval in JSON.
  for (const key of Object.keys(previous || {})) {
    if (key.startsWith('source_') || ['import_batch', 'catalog_import_package', 'fiscal_mapping_pending'].includes(key)) result[key] = previous[key];
  }
  if (previous?.imported_price_review) result.imported_price_review = previous.imported_price_review;
  else delete result.imported_price_review;
  if (result.catalog_status != null && !STATUSES.has(result.catalog_status)) throw catalogError('Estado de catálogo no válido.');
  if (result.price_profile != null) result.price_profile = require('./economicPriceProfile').normalizeProfile(result.price_profile);
  if (result.booking_profile != null) {
    result.booking_profile = normalizeBookingProfile(result.booking_profile, { allowIncomplete: result.catalog_status === 'draft' });
  }
  return Object.keys(result).length ? result : null;
}

function applyImportedPriceReview(previous, next, { confirm, amount, actorId, now = new Date() } = {}) {
  if (confirm == null || confirm === false) {
    // Later edits must not turn an approved gross price back into an ambiguous
    // legacy net amount, or silently coerce a cleared amount into a free service.
    if (previous?.imported_price_review && previous.fiscal_mapping_pending === false) {
      if (!next?.price_profile) throw catalogError('Conserva el IVA incluido o un motivo de exención para este precio final.', 'imported_price_profile_required', 422);
      if (amount !== undefined) assertImportedPriceAmount(amount);
    }
    return next;
  }
  if (confirm !== true) throw catalogError('La confirmación del precio debe ser explícita.', 'imported_price_confirmation_invalid', 422);
  if (previous?.fiscal_mapping_pending !== true) throw catalogError('Este precio no tiene una revisión pendiente. Actualiza el tratamiento.', 'imported_price_not_pending', 409);
  const priceProfile = require('./economicPriceProfile').normalizeProfile(next?.price_profile);
  if (!priceProfile) throw catalogError('Indica el IVA incluido o el motivo de exención antes de confirmar.', 'imported_price_profile_required', 422);
  assertImportedPriceAmount(amount);
  if (!Number.isSafeInteger(Number(actorId)) || Number(actorId) <= 0) throw catalogError('Falta el usuario que confirma el precio.', 'imported_price_actor_required', 401);
  return { ...next, fiscal_mapping_pending: false, imported_price_review: {
    version: 1, reviewed_at: now.toISOString(), reviewed_by: Number(actorId),
    gross_amount: amount, price_profile: priceProfile,
  } };
}

function assertImportedPriceAmount(amount) {
  // Match DECIMAL(10,2). In particular, null/empty must never become free.
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > 99999999.99 || Math.round(amount * 100) / 100 !== amount) {
    throw catalogError('Indica un precio final válido, con un máximo de dos decimales.', 'imported_price_amount_invalid', 422);
  }
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

// Display only: never reinterpret an imported tax-inclusive amount as a net
// accounting price. Fiscal resolution remains an explicit, separate task.
function catalogPrice(treatment) {
  const config = treatment.clinical_config || {};
  if (config.fiscal_mapping_pending === true) {
    const source = config.source_price || {};
    return { amount: source.mode === 'fixed' && typeof source.gross_amount === 'number' && Number.isFinite(source.gross_amount) ? source.gross_amount : null,
      label: 'IVA incluido · fiscalidad pendiente', semantics: 'gross_tax_included', review_required: true };
  }
  if (config.price_profile) {
    const profile = require('./economicPriceProfile').normalizeProfile(config.price_profile);
    return { amount: treatment.precio_base == null ? null : Number(treatment.precio_base),
      label: profile.tax_percent ? `IVA ${profile.tax_percent}% incluido` : 'Exento de IVA', semantics: profile.price_semantics, review_required: false };
  }
  return { amount: treatment.precio_base == null ? null : Number(treatment.precio_base), label: 'habitual', semantics: 'existing_catalog_price', review_required: false };
}
function catalogDto(treatment) { const value = treatment?.toJSON ? treatment.toJSON() : treatment; return { ...value, catalog_price: catalogPrice(value) }; }

module.exports = { mergeClinicalConfig, applyImportedPriceReview, assertCatalogEditable, isObsolete, catalogState, catalogError, catalogPrice, catalogDto };
