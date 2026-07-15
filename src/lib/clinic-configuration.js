'use strict';

const ACCESS_GUIDANCE_MAX_DIRECTIONS_LENGTH = 500;

const DEFAULT_ACCESS_GUIDANCE = Object.freeze({
  enabled: false,
  directions: '',
  image_asset_id: null,
  image_url: null,
});

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value);
}

function parseConfiguration(value) {
  if (isPlainObject(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return isPlainObject(parsed) ? parsed : {};
    } catch (_) {
      return {};
    }
  }
  return {};
}

function normalizePositiveInteger(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const raw = String(value).trim();
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeAccessGuidance(value) {
  const raw = isPlainObject(value) ? value : {};
  return {
    enabled: raw.enabled === true,
    directions: typeof raw.directions === 'string' ? raw.directions.trim() : '',
    image_asset_id: normalizePositiveInteger(raw.image_asset_id),
    image_url: typeof raw.image_url === 'string' && raw.image_url.trim()
      ? raw.image_url.trim()
      : null,
  };
}

function normalizeClinicConfigurationForRead(value) {
  const configuration = parseConfiguration(value);
  return {
    ...configuration,
    disciplinas: Array.isArray(configuration.disciplinas) && configuration.disciplinas.length > 0
      ? configuration.disciplinas
      : ['dental'],
    access_guidance: normalizeAccessGuidance(configuration.access_guidance),
  };
}

function filterClinicConfigurationForSettingsAccess(value, canViewSettings) {
  const normalized = normalizeClinicConfigurationForRead(value);
  if (canViewSettings === true) return normalized;

  // El selector global necesita las disciplinas para conservar el contexto
  // asistencial, pero una denegacion explicita de clinic.settings.view no debe
  // filtrar ajustes privados de la ficha (incluido access_guidance).
  return {
    disciplinas: normalized.disciplinas,
  };
}

function mergePlainObjects(currentValue, patchValue) {
  const current = isPlainObject(currentValue) ? currentValue : {};
  const patch = isPlainObject(patchValue) ? patchValue : {};
  const merged = { ...current };

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (isPlainObject(value) && isPlainObject(current[key])) {
      merged[key] = mergePlainObjects(current[key], value);
    } else if (Array.isArray(value)) {
      merged[key] = [...value];
    } else {
      merged[key] = value;
    }
  }

  return merged;
}

function createValidationError(message, details = null) {
  const error = new Error(message);
  error.status = 400;
  error.details = details;
  return error;
}

function validateAccessGuidancePatch(value) {
  if (!isPlainObject(value)) {
    throw createValidationError('clinic_access_guidance_must_be_an_object');
  }

  const allowedKeys = new Set(['enabled', 'directions', 'image_asset_id', 'image_url']);
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length) {
    throw createValidationError('clinic_access_guidance_unknown_fields', { fields: unknownKeys });
  }
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    throw createValidationError('clinic_access_guidance_enabled_must_be_boolean');
  }
  if (value.directions !== undefined && value.directions !== null && typeof value.directions !== 'string') {
    throw createValidationError('clinic_access_guidance_directions_must_be_string');
  }
  if (
    typeof value.directions === 'string'
    && value.directions.trim().length > ACCESS_GUIDANCE_MAX_DIRECTIONS_LENGTH
  ) {
    throw createValidationError('clinic_access_guidance_directions_too_long', {
      maxLength: ACCESS_GUIDANCE_MAX_DIRECTIONS_LENGTH,
    });
  }
  if (
    value.image_asset_id !== undefined
    && value.image_asset_id !== null
    && normalizePositiveInteger(value.image_asset_id) === null
  ) {
    throw createValidationError('clinic_access_guidance_image_asset_id_invalid');
  }
  if (
    value.image_url !== undefined
    && value.image_url !== null
    && typeof value.image_url !== 'string'
  ) {
    throw createValidationError('clinic_access_guidance_image_url_must_be_string');
  }
}

function assertAccessGuidanceIsConsistent(value) {
  const normalized = normalizeAccessGuidance(value);
  const hasAssetId = normalized.image_asset_id !== null;
  const hasImageUrl = normalized.image_url !== null;

  if (hasAssetId !== hasImageUrl) {
    throw createValidationError('clinic_access_guidance_image_reference_incomplete');
  }
  if (normalized.image_url) {
    let parsed;
    try {
      parsed = new URL(normalized.image_url);
    } catch (_) {
      throw createValidationError('clinic_access_guidance_image_url_invalid');
    }
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'media.clinicaclick.com') {
      throw createValidationError('clinic_access_guidance_image_url_must_be_public_media');
    }
  }
  if (normalized.enabled && !normalized.directions) {
    throw createValidationError('clinic_access_guidance_directions_required');
  }
  if (normalized.enabled && !hasAssetId) {
    throw createValidationError('clinic_access_guidance_image_required');
  }

  return normalized;
}

function mergeClinicConfiguration(currentValue, patchValue) {
  if (!isPlainObject(patchValue)) {
    throw createValidationError('clinic_configuration_patch_must_be_an_object');
  }

  const current = parseConfiguration(currentValue);
  const patch = { ...patchValue };

  if (Object.prototype.hasOwnProperty.call(patch, 'access_guidance')) {
    validateAccessGuidancePatch(patch.access_guidance);
    patch.access_guidance = {
      ...normalizeAccessGuidance(current.access_guidance),
      ...patch.access_guidance,
    };

    if (Object.prototype.hasOwnProperty.call(patchValue.access_guidance, 'directions')) {
      patch.access_guidance.directions = typeof patchValue.access_guidance.directions === 'string'
        ? patchValue.access_guidance.directions.trim()
        : '';
    }
    if (Object.prototype.hasOwnProperty.call(patchValue.access_guidance, 'image_asset_id')) {
      patch.access_guidance.image_asset_id = normalizePositiveInteger(
        patchValue.access_guidance.image_asset_id
      );
    }
    if (Object.prototype.hasOwnProperty.call(patchValue.access_guidance, 'image_url')) {
      patch.access_guidance.image_url = typeof patchValue.access_guidance.image_url === 'string'
        && patchValue.access_guidance.image_url.trim()
        ? patchValue.access_guidance.image_url.trim()
        : null;
    }
    patch.access_guidance = assertAccessGuidanceIsConsistent(patch.access_guidance);
  }

  const merged = mergePlainObjects(current, patch);
  if (!Array.isArray(merged.disciplinas) || merged.disciplinas.length === 0) {
    merged.disciplinas = ['dental'];
  }
  return merged;
}

module.exports = {
  ACCESS_GUIDANCE_MAX_DIRECTIONS_LENGTH,
  DEFAULT_ACCESS_GUIDANCE,
  assertAccessGuidanceIsConsistent,
  isPlainObject,
  filterClinicConfigurationForSettingsAccess,
  mergeClinicConfiguration,
  normalizeAccessGuidance,
  normalizeClinicConfigurationForRead,
  parseConfiguration,
  validateAccessGuidancePatch,
};
