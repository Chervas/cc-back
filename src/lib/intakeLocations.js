'use strict';

function parseIntakeId(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!/^[1-9]\d*$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function locationId(location) {
  if (!location || typeof location !== 'object') return null;
  const value = location.id ?? location.value ?? location.clinic_id ?? location.clinica_id;
  if (value === undefined || value === null || value === '') return null;
  return String(value);
}

function restrictAvailableLocationsToConfigured(availableLocations, configuredLocations) {
  const available = Array.isArray(availableLocations) ? availableLocations : [];
  const configured = Array.isArray(configuredLocations) ? configuredLocations : [];
  if (!configured.length) return [];

  const availableById = new Map();
  for (const location of available) {
    const id = locationId(location);
    if (!id || availableById.has(id)) continue;
    availableById.set(id, location);
  }

  const result = [];
  const seen = new Set();
  for (const location of configured) {
    const id = locationId(location);
    if (!id || seen.has(id)) continue;
    const availableLocation = availableById.get(id);
    if (!availableLocation) continue;
    seen.add(id);
    result.push(availableLocation);
  }
  return result;
}

function configuredLocationsWithinAllowedScope(configuredLocations, allowedClinicIds) {
  if (!Array.isArray(configuredLocations) || !Array.isArray(allowedClinicIds)) return false;
  const allowedIds = new Set(allowedClinicIds
    .map((id) => String(id))
    .filter(Boolean));
  return configuredLocations.every((location) => {
    const id = locationId(location);
    return !!id && allowedIds.has(id);
  });
}

function resolveIntakeLocationVisibility(
  availableLocations,
  configuredLocations,
  { includeAllLocations = false, clinicId = null, allowedClinicIds = null } = {},
) {
  let available = Array.isArray(availableLocations) ? availableLocations : [];
  let configured = Array.isArray(configuredLocations) ? configuredLocations : [];

  if (Array.isArray(allowedClinicIds)) {
    const allowedIds = new Set(allowedClinicIds
      .map((id) => String(id))
      .filter(Boolean));
    available = available.filter((location) => {
      const id = locationId(location);
      return id && allowedIds.has(id);
    });
    configured = configured.filter((location) => {
      const id = locationId(location);
      return id && allowedIds.has(id);
    });
  }

  if (includeAllLocations) {
    return {
      availableLocations: available,
      configuredLocations: configured,
    };
  }

  const publicConfiguredLocations = configured.length
    ? configured
    : (clinicId ? [{ id: clinicId }] : []);

  return {
    availableLocations: restrictAvailableLocationsToConfigured(
      available,
      publicConfiguredLocations,
    ),
    configuredLocations: publicConfiguredLocations,
  };
}

module.exports = {
  configuredLocationsWithinAllowedScope,
  locationId,
  parseIntakeId,
  restrictAvailableLocationsToConfigured,
  resolveIntakeLocationVisibility,
};
