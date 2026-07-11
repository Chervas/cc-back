'use strict';

function sanitizePublicLocationLabel(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value)
    .normalize('NFC')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized ? normalized.slice(0, 160) : null;
}

function normalizeConfiguredLocations(locations, availableLocations) {
  const available = Array.isArray(availableLocations) ? availableLocations : [];
  const byId = new Map();

  for (const location of available) {
    const id = location?.id;
    if (id === undefined || id === null || id === '') continue;
    byId.set(String(id), location);
  }

  const configured = Array.isArray(locations) ? locations : [];
  return configured.map((location) => {
    if (!location || typeof location !== 'object' || Array.isArray(location)) return location;

    const id = location.id ?? location.value ?? location.clinic_id ?? location.clinica_id;
    const fresh = id !== undefined && id !== null && id !== '' ? byId.get(String(id)) : null;
    const publicLabel = sanitizePublicLocationLabel(location.public_label);
    const configuredLabel = sanitizePublicLocationLabel(location.label);

    return {
      ...location,
      public_label: publicLabel,
      label: publicLabel || fresh?.label || configuredLabel || null,
      phone: location.phone || fresh?.phone || null,
      whatsapp: location.whatsapp || fresh?.whatsapp || null,
      address: location.address || fresh?.address || null,
    };
  });
}

module.exports = {
  normalizeConfiguredLocations,
  sanitizePublicLocationLabel,
};
