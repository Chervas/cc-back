'use strict';

function asPlainObject(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' && !Array.isArray(value) ? value : {};
}

const REVIEW_ALIAS_KEYS = [
  'google_business_profile_alias',
  'business_profile_alias',
  'google_business_profile_alias_reason',
  'google_business_profile_alias_clinic_id',
  'google_business_location_alias_clinic_id',
  'review_google_profile_alias_clinic_id',
  'google_business_profile_alias_business_location_id',
  'google_business_location_alias_business_location_id',
  'google_business_profile_alias_location_id',
  'google_business_location_alias_location_id',
  'google_business_profile_alias_updated_at',
];

const ROOT_ALIAS_KEYS = [
  'review_google_business_profile_alias_clinic_id',
  'review_google_profile_alias_clinic_id',
  'review_google_alias_clinic_id',
  'review_google_business_profile_alias_business_location_id',
  'review_google_business_profile_alias_location_id',
];

function withoutKeys(value, keys) {
  const copy = { ...asPlainObject(value) };
  for (const key of keys) delete copy[key];
  return copy;
}

function buildReviewProfileAliasConfiguration(currentConfiguration, {
  targetClinicId,
  sourceClinicId,
  sourceClinicName,
  businessLocationId,
  locationId,
  updatedAt = new Date(),
} = {}) {
  const targetId = Number(targetClinicId || 0);
  const sourceId = Number(sourceClinicId || 0);
  const locationRecordId = Number(businessLocationId || 0);
  const providerLocationId = String(locationId || '').trim();
  const configuration = withoutKeys(currentConfiguration, ROOT_ALIAS_KEYS);
  const existingReviews = configuration.reviews
    || configuration.resenas
    || configuration.review_requests
    || {};
  const reviews = withoutKeys(existingReviews, REVIEW_ALIAS_KEYS);

  if (
    Number.isInteger(targetId)
    && targetId > 0
    && targetId === sourceId
  ) {
    return { ...configuration, reviews };
  }

  if (
    !Number.isInteger(sourceId)
    || sourceId <= 0
    || !Number.isInteger(locationRecordId)
    || locationRecordId <= 0
    || !providerLocationId
  ) {
    const error = new Error('La ficha elegida no tiene un mapeo activo en Clinicaclick.');
    error.code = 'review_profile_source_not_mapped';
    error.httpStatus = 409;
    throw error;
  }

  const sourceName = String(sourceClinicName || '').trim() || `clinica ${sourceId}`;
  return {
    ...configuration,
    reviews: {
      ...reviews,
      google_business_profile_alias_reason: `Las resenas se solicitan en la ficha de ${sourceName}`,
      google_business_profile_alias_clinic_id: sourceId,
      google_business_profile_alias_business_location_id: locationRecordId,
      google_business_profile_alias_location_id: providerLocationId,
      google_business_profile_alias_updated_at: (
        updatedAt instanceof Date ? updatedAt : new Date(updatedAt)
      ).toISOString(),
    },
  };
}

module.exports = {
  buildReviewProfileAliasConfiguration,
};
