'use strict';

const { normalizePhoneDigits } = require('./phone');

function positiveInt(value) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseConfig(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function extractAssetPhone(asset) {
  const additional = asset?.additionalData && typeof asset.additionalData === 'object'
    ? asset.additionalData
    : {};
  return additional.displayPhoneNumber
    || additional.display_phone_number
    || asset?.metaAssetName
    || null;
}

function configuredPhoneAliasesByClinic(configRecord) {
  const config = parseConfig(configRecord?.config);
  const locations = Array.isArray(config.locations) ? config.locations : [];
  const aliases = new Map();
  for (const location of locations) {
    const clinicId = positiveInt(location?.id ?? location?.value ?? location?.clinic_id ?? location?.clinica_id);
    if (!clinicId) continue;
    const values = [
      location?.phone,
      location?.fixed_phone,
      location?.mobile_phone,
      location?.whatsapp,
      ...(Array.isArray(location?.phone_aliases) ? location.phone_aliases : []),
      ...(Array.isArray(location?.whatsapp_aliases) ? location.whatsapp_aliases : []),
    ];
    aliases.set(clinicId, values);
  }
  return aliases;
}

/**
 * Resolves a clicked public number to a clinic only when the match is unique.
 * Group-level WhatsApp assets are deliberately excluded: a shared number
 * cannot identify one clinic. Clinic-level Meta assets and explicitly stored
 * location aliases are accepted alongside every clinic contact phone.
 */
function matchClinicByContactPhone({
  phone,
  clinics = [],
  clinicPhoneAssets = [],
  configRecord = null,
  allowedClinicIds = [],
} = {}) {
  const normalizedPhone = normalizePhoneDigits(phone);
  if (!normalizedPhone) return null;

  const allowed = new Set((Array.isArray(allowedClinicIds) ? allowedClinicIds : [])
    .map(positiveInt)
    .filter(Boolean));
  const aliases = configuredPhoneAliasesByClinic(configRecord);
  const assetsByClinic = new Map();
  for (const asset of (Array.isArray(clinicPhoneAssets) ? clinicPhoneAssets : [])) {
    const clinicId = positiveInt(asset?.clinicaId ?? asset?.clinica_id);
    const assignmentScope = String(asset?.assignmentScope ?? asset?.assignment_scope ?? '').toLowerCase();
    if (!clinicId || assignmentScope === 'group') continue;
    const list = assetsByClinic.get(clinicId) || [];
    list.push(extractAssetPhone(asset));
    assetsByClinic.set(clinicId, list);
  }

  const matches = [];
  for (const clinic of (Array.isArray(clinics) ? clinics : [])) {
    const clinicId = positiveInt(clinic?.id_clinica ?? clinic?.id);
    if (!clinicId || (allowed.size && !allowed.has(clinicId))) continue;
    if (![true, 1, '1', undefined, null].includes(clinic?.estado_clinica)) continue;

    const candidates = [
      clinic?.telefono,
      clinic?.telefono_fijo,
      clinic?.telefono_movil,
      clinic?.telefono_whatsapp,
      ...(assetsByClinic.get(clinicId) || []),
      ...(aliases.get(clinicId) || []),
    ];
    if (candidates.some((candidate) => normalizePhoneDigits(candidate) === normalizedPhone)) {
      matches.push(clinic);
    }
  }

  return matches.length === 1 ? matches[0] : null;
}

module.exports = {
  configuredPhoneAliasesByClinic,
  extractAssetPhone,
  matchClinicByContactPhone,
};
