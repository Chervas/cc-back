'use strict';

const crypto = require('node:crypto');
const { parseConfiguration } = require('./clinic-configuration');

// Vocabulary for searches only. Assignment and order belong to the clinic's
// canonical disciplinas; this module never adds or rewrites those assignments.
/** @typedef {{code: string, label: string, category: string|null, search_term: string|null}} MedicalArea
 * @typedef {{medical_areas: MedicalArea[], selected_medical_area: MedicalArea|null, selection_required: boolean}} MedicalAreaSelection
 */
const SEARCH_AREAS = Object.freeze({
  estetica: ['Medicina estética', 'clínica de medicina estética', 'medicina estética'],
  cirugia_estetica: ['Cirugía estética', 'clínica de cirugía estética', 'cirugía estética'],
  cirugia_digestiva: ['Cirugía general y digestiva', 'clínica de cirugía digestiva y hepatobiliar', 'cirugía digestiva'],
  capilar: ['Capilar', 'clínica capilar', 'clínica capilar'],
  nutricion: ['Nutrición', 'clínica de nutrición', 'nutrición'],
  psicologia: ['Psicología', 'clínica de psicología', 'psicología'],
  dental: ['Dental', 'clínica dental', 'clínica dental'],
  podologia: ['Podología', 'clínica podológica', 'podología'],
  fisioterapia: ['Fisioterapia', 'clínica de fisioterapia', 'fisioterapia'],
  dermatologia: ['Dermatología', 'clínica dermatológica', 'dermatología'],
  oftalmologia: ['Oftalmología', 'clínica oftalmológica', 'oftalmología'],
  veterinaria: ['Veterinaria', 'clínica veterinaria', 'clínica veterinaria'],
  general: ['General', null, null],
});

// Existing spellings remain readable without rewriting stored IDs.
const LEGACY_SEARCH_CODES = {
  odontologia: 'dental', medicina_estetica: 'estetica', cirugia_plastica: 'cirugia_estetica',
  medicina_capilar: 'capilar', trasplante_capilar: 'capilar',
  cirugia_hepatobiliar: 'cirugia_digestiva', hepatobiliar: 'cirugia_digestiva',
};

function areaError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function normalizeMedicalArea(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/.test(value)) {
    throw areaError('MEDICAL_AREA_INVALID', 'Área médica inválida.');
  }
  return value;
}

function medicalAreaFromRequest(req) {
  const query = normalizeMedicalArea(req.query?.medical_area);
  const body = normalizeMedicalArea(req.body?.medical_area);
  if (query && body && query !== body) {
    throw areaError('MEDICAL_AREA_CONFLICT', 'El área de la URL y del cuerpo no coincide.');
  }
  return query || body;
}

function legacySearchArea(clinic) {
  const config = parseConfiguration(clinic?.configuracion);
  const profile = config.marketing_competition_local_profile;
  const sourceMatches = profile?.status === 'resolved' && profile.source_url
    && profile.source_url === clinic?.url_ficha_local;
  // Prefer the effective GBP category, then a URL identity that still matches.
  const categories = [clinic?.business_primary_category, sourceMatches ? profile.primary_category : null];
  for (const category of categories) {
    if (typeof category !== 'string' || !category.trim()) continue;
    const text = category.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
    if (['clinica', 'clinica medica', 'centro medico', 'hospital', 'medico', 'doctor',
      'medical clinic', 'medical center', 'clinica especializada', 'specialized clinic'].includes(text)) continue;
    const matches = [
      ['capilar', /capilar|alopecia|hair/], ['dental', /dental|dentist|odont|ortodon/],
      ['cirugia_estetica', /cirugia (estetica|plastica)|cirujano plastico|plastic surg/],
      ['estetica', /medicina estetica|clinica estetica|estetica medica/],
      ['cirugia_digestiva', /hepatobiliar|digestiv|laparoscop/],
      ['nutricion', /nutricion|dietista/], ['psicologia', /psicolog|psiquiatr/],
      ['podologia', /podolog/], ['fisioterapia', /fisioterap|rehabilitacion/],
      ['dermatologia', /dermatolog/], ['oftalmologia', /oftalmolog|oculista/],
    ].filter(([, pattern]) => pattern.test(text));
    if (matches.length > 1) return null;
    if (matches.length === 1) {
      const [, canonicalCategory, search_term] = SEARCH_AREAS[matches[0][0]];
      return { category: canonicalCategory, search_term };
    }
    return { category: category.trim().toLowerCase(), search_term: category.trim().toLowerCase() };
  }
  return null;
}

function resolveMedicalArea(clinic, requested = null) {
  const code = normalizeMedicalArea(requested);
  const config = parseConfiguration(clinic?.configuracion);
  const codes = [...new Set((Array.isArray(config.disciplinas) ? config.disciplinas : [])
    .filter((value) => typeof value === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(value)))];
  const medical_areas = codes.map((key) => {
    const [label, category, search_term] = SEARCH_AREAS[key] || SEARCH_AREAS[LEGACY_SEARCH_CODES[key]] || [key, null, null];
    return { code: key, label, category, search_term };
  });
  if (code && !codes.includes(code)) {
    throw areaError('MEDICAL_AREA_NOT_ASSIGNED', 'El área médica no está asignada a esta clínica.', 403);
  }
  // The configuration order is the clinic's deliberate default, not a sort
  // of names or a priority inferred from the public profile's description.
  const selectedCode = code || codes[0] || null;
  const selected = medical_areas.find((area) => area.code === selectedCode) || null;
  const legacy = !codes.some((key) => key !== 'general')
    ? legacySearchArea(clinic) : null;
  return {
    medical_areas,
    selected_medical_area: selected,
    selection_required: false,
    medical_search_category: selected?.category || legacy?.category || null,
    medical_search_term: selected?.search_term || legacy?.search_term || null,
  };
}

function areaMetadata(clinic) {
  return {
    medical_areas: clinic?.medical_areas || [],
    selected_medical_area: clinic?.selected_medical_area || null,
    selection_required: clinic?.selection_required === true,
  };
}

function withMedicalArea(clinic, requested = null) {
  const selection = resolveMedicalArea(clinic, requested);
  return clinic ? { ...clinic, ...selection } : null;
}

function medicalAreaBlocker(clinic) {
  if (clinic?.selection_required) return {
    code: 'MEDICAL_AREA_SELECTION_REQUIRED', action: 'select_medical_area',
    message: 'Selecciona el área médica que quieres consultar.',
  };
  if (!clinic?.medical_search_category && !clinic?.category) return {
    code: 'MEDICAL_AREA_REQUIRED', action: 'complete_clinic_medical_area',
    message: 'Configura un área médica concreta para preparar las búsquedas.',
  };
  return null;
}

function medicalContextKey(clinic) {
  return crypto.createHash('sha256').update(JSON.stringify([
    'medical-area-v1', clinic?.id_clinica || clinic?.id,
    clinic?.selected_medical_area, clinic?.medical_search_category, clinic?.medical_search_term, clinic?.nombre_clinica, clinic?.business_location_name,
    clinic?.url_ficha_local, clinic?.business_place_id, clinic?.business_location_id,
    clinic?.business_location_mapping_id, clinic?.url_web,
    clinic?.ciudad, clinic?.provincia, clinic?.codigo_postal, clinic?.direccion,
    clinic?.business_locality, clinic?.business_administrative_area,
    clinic?.business_postal_code, clinic?.business_address_lines,
    clinic?.business_latitude, clinic?.business_longitude, clinic?.pais, clinic?.business_country_code, clinic?.business_website_url,
  ])).digest('hex');
}

module.exports = {
  resolveMedicalArea, withMedicalArea, areaMetadata, medicalAreaBlocker,
  medicalAreaFromRequest, normalizeMedicalArea, medicalContextKey, areaError,
};
