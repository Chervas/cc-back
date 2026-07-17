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
      // Contact data belongs to the clinic record/assets and can change after
      // the intake scope was saved. Prefer the fresh effective values so an
      // old location snapshot cannot keep publishing or attributing a retired
      // phone number. Only the explicit public label remains an editor-owned
      // override.
      phone: fresh?.phone || location.phone || null,
      fixed_phone: fresh?.fixed_phone || location.fixed_phone || null,
      mobile_phone: fresh?.mobile_phone || location.mobile_phone || null,
      whatsapp: fresh?.whatsapp || location.whatsapp || null,
      phone_source: fresh?.phone_source || location.phone_source || null,
      whatsapp_source: fresh?.whatsapp_source || location.whatsapp_source || null,
      address: fresh?.address || location.address || null,
      url_web: fresh?.url_web || location.url_web || null,
    };
  });
}

module.exports = {
  normalizeConfiguredLocations,
  sanitizePublicLocationLabel,
};
