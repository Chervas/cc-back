'use strict';

const { sanitize } = require('./clinicAttribution');
const { locationId, parseIntakeId } = require('./intakeLocations');

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

function normalizedAlias(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  return sanitize(String(value).normalize('NFKC')) || null;
}

function cleanClinicLabel(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .normalize('NFKC')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || /^\d+$/.test(cleaned)) return null;
  return cleaned;
}

function normalizeFieldKey(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function isClinicLabelField(key) {
  const normalized = normalizeFieldKey(key);
  if (!normalized || /(^|_)(?:id|ids)$/.test(normalized)) return false;
  return normalized.includes('clinic')
    || normalized.includes('clinica')
    || normalized.includes('sede')
    || normalized.includes('centro')
    || normalized.includes('ubicacion');
}

/**
 * Extract a human location label while ignoring routing ids such as
 * `clinica_id=0`. Runtime group forms deliberately submit that zero sentinel
 * and keep the selected human label in form_submission.fields.
 */
function extractClinicLabelHint(...sources) {
  const directKeys = [
    'clinica',
    'clínica',
    'clinic',
    'clinic_name',
    'clinicName',
    'clinic_name_text',
    'clinicText',
    'sede',
    'centro',
  ];

  for (const source of sources) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;

    for (const key of directKeys) {
      const label = cleanClinicLabel(source[key]);
      if (label) return label;
    }

    for (const [key, value] of Object.entries(source)) {
      if (!isClinicLabelField(key)) continue;
      const label = cleanClinicLabel(value);
      if (label) return label;
    }
  }
  return null;
}

function addAlias(target, value) {
  if (Array.isArray(value)) {
    value.forEach((item) => addAlias(target, item));
    return;
  }
  const alias = normalizedAlias(value);
  if (alias) target.add(alias);
}

function locationAliases(location, clinic) {
  const aliases = new Set();
  const locationFields = [
    'label',
    'public_label',
    'name',
    'clinic_name',
    'nombre_clinica',
    'text',
    'aliases',
  ];
  const clinicFields = [
    'nombre_clinica',
    'name',
    'label',
    'public_label',
    'aliases',
  ];

  locationFields.forEach((field) => addAlias(aliases, location?.[field]));
  clinicFields.forEach((field) => addAlias(aliases, clinic?.[field]));
  return aliases;
}

function containsWholeAlias(candidate, alias) {
  if (!candidate || !alias) return false;
  if (candidate === alias) return true;
  // Accept an authoritative alias inside a decorated form label (for example,
  // "Propdental Hospitalet de Llobregat"), never a partial user value inside
  // a longer alias. This prevents a generic token such as "Barcelona" from
  // selecting a clinic by accident.
  return (` ${candidate} `).includes(` ${alias} `);
}

function baseResult(overrides = {}) {
  return {
    matched: false,
    hasCandidate: true,
    reason: null,
    clinicId: null,
    groupId: null,
    matchedAlias: null,
    ...overrides,
  };
}

/**
 * Resolve a human clinic label from an intercepted form without ever widening
 * the configured group scope. IntakeConfig.config.locations is authoritative;
 * clinic rows only contribute current names/aliases for those configured IDs.
 */
function resolveConfiguredFormClinicLocation({
  hint,
  requestedGroupId = null,
  configRecord = null,
  clinics = [],
} = {}) {
  const candidate = normalizedAlias(hint);
  if (!candidate) {
    return baseResult({
      hasCandidate: false,
      reason: 'no_candidate',
    });
  }

  const groupId = parseIntakeId(requestedGroupId);
  const configGroupId = configRecord?.assignment_scope === 'group'
    ? parseIntakeId(configRecord.group_id)
    : null;
  if (groupId === null || configGroupId === null) {
    return baseResult({ reason: 'untrusted_group_scope', groupId: groupId ?? configGroupId });
  }
  if (groupId !== configGroupId) {
    return baseResult({ reason: 'group_scope_mismatch', groupId });
  }

  const config = parseConfig(configRecord?.config);
  if (!Array.isArray(config.locations) || config.locations.length === 0) {
    return baseResult({ reason: 'locations_not_configured', groupId });
  }

  const clinicsById = new Map();
  for (const clinic of (Array.isArray(clinics) ? clinics : [])) {
    const clinicId = parseIntakeId(clinic?.id_clinica ?? clinic?.id ?? clinic?.clinic_id);
    if (clinicId !== null && !clinicsById.has(clinicId)) {
      clinicsById.set(clinicId, clinic);
    }
  }

  const entries = [];
  for (const location of config.locations) {
    const clinicId = parseIntakeId(locationId(location));
    if (clinicId === null) continue;
    const clinic = clinicsById.get(clinicId) || null;
    const aliases = locationAliases(location, clinic);
    if (!aliases.size) continue;
    entries.push({ clinicId, clinic, aliases });
  }

  const exactMatches = entries.flatMap((entry) => (
    entry.aliases.has(candidate) ? [{ ...entry, matchedAlias: candidate }] : []
  ));
  const matches = exactMatches.length
    ? exactMatches
    : entries.flatMap((entry) => Array.from(entry.aliases)
      .filter((alias) => containsWholeAlias(candidate, alias))
      .map((matchedAlias) => ({ ...entry, matchedAlias })));

  if (!matches.length) {
    return baseResult({ reason: 'location_not_configured', groupId });
  }

  const matchedIds = Array.from(new Set(matches.map((match) => match.clinicId)));
  if (matchedIds.length !== 1) {
    return baseResult({ reason: 'location_ambiguous', groupId });
  }

  const winner = matches.find((match) => match.clinicId === matchedIds[0]);
  if (!winner?.clinic) {
    return baseResult({ reason: 'clinic_not_found', groupId });
  }

  const clinicGroupId = parseIntakeId(
    winner.clinic.grupoClinicaId ?? winner.clinic.grupo_clinica_id ?? winner.clinic.group_id,
  );
  if (clinicGroupId !== groupId) {
    return baseResult({ reason: 'clinic_outside_group', groupId });
  }
  if (![true, 1, '1'].includes(winner.clinic.estado_clinica)) {
    return baseResult({ reason: 'clinic_inactive', groupId });
  }

  return baseResult({
    matched: true,
    reason: null,
    clinicId: winner.clinicId,
    groupId,
    matchedAlias: winner.matchedAlias,
  });
}

module.exports = {
  cleanClinicLabel,
  containsWholeAlias,
  extractClinicLabelHint,
  isClinicLabelField,
  locationAliases,
  normalizeFieldKey,
  normalizedAlias,
  resolveConfiguredFormClinicLocation,
};
