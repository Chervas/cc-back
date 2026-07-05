'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const db = require('../../models');
const medicalAreaContracts = require('./medicalAreaContracts.service');

const { Op } = db.Sequelize;
const execFileAsync = promisify(execFile);
const FORMULA_VERSION = 'nutrition-basic-v2';
const DEFAULT_CHROMIUM_PATH = '/home/ubuntu/.cache/clinicaclick-browsers/chrome-headless-shell/linux-148.0.7778.56/chrome-headless-shell-linux64/chrome-headless-shell';

const FORMULA_REFERENCES = [
  {
    key: 'bmi',
    label: 'IMC',
    description: 'Peso en kg dividido por la estatura en metros al cuadrado.',
    source: 'NHS BMI adult calculation',
    url: 'https://www.nhs.uk/health-assessment-tools/calculate-your-body-mass-index/calculate-bmi-for-adults/',
    profiles: ['quick', 'express_isak'],
  },
  {
    key: 'isak_restricted_profile',
    label: 'Perfil restringido ISAK',
    description: 'Estructura de medición antropométrica restringida: masa, estatura, pliegues, perímetros y diámetros.',
    source: 'ISAK restricted profile overview',
    url: 'https://paulstokes.com.au/isak-restricted-profile/',
    profiles: ['express_isak'],
  },
  {
    key: 'heath_carter_somatotype',
    label: 'Somatotipo Heath-Carter',
    description: 'Cálculo de endomorfia, mesomorfia y ectomorfia a partir de medidas antropométricas.',
    source: 'The Heath-Carter Anthropometric Somatotype Instruction Manual',
    url: 'https://phentermineclinics.net/wp-content/uploads/2023/09/Heath-CarterManual.pdf',
    profiles: ['express_isak'],
  },
  {
    key: 'durnin_womersley_body_density',
    label: 'Densidad corporal Durnin-Womersley',
    description: 'Estimación de densidad corporal por sexo y edad usando la suma de bíceps, tríceps, subescapular e ilíaco/suprailiaco.',
    source: 'Durnin & Womersley 1974',
    url: 'https://pubmed.ncbi.nlm.nih.gov/4843734/',
    profiles: ['express_isak'],
  },
  {
    key: 'siri_body_fat',
    label: 'Porcentaje graso Siri',
    description: 'Conversión de densidad corporal a porcentaje estimado de grasa corporal.',
    source: 'Siri body density conversion',
    url: 'https://www.ncbi.nlm.nih.gov/books/NBK235961/',
    profiles: ['express_isak'],
  },
  {
    key: 'linear_projection',
    label: 'Proyección temporal',
    description: 'Estimación lineal simple basada en las dos últimas mediciones comparables con fechas distintas.',
    source: 'ClinicaClick nutrition-basic-v2',
    url: null,
    profiles: ['quick', 'express_isak'],
  },
];

const PROFILE_DEFINITIONS = medicalAreaContracts.NUTRITION_MEASUREMENT_PROFILE_SCHEMAS;
const FIELD_DEFINITIONS = medicalAreaContracts.NUTRITION_MEASUREMENT_FIELD_DEFINITIONS;

const REPORT_METRIC_DEFINITIONS = [
  { key: 'weight_kg', label: 'Peso', unit: 'kg', source: 'raw_values', decimals: 1, section: 'base' },
  { key: 'bmi', label: 'IMC', unit: '', source: 'calculated_values', decimals: 1, section: 'base' },
  { key: 'waist_cm', label: 'Cintura', unit: 'cm', source: 'raw_values', decimals: 1, section: 'base' },
  { key: 'hip_cm', label: 'Cadera', unit: 'cm', source: 'raw_values', decimals: 1, section: 'base' },
  { key: 'waist_hip_ratio', label: 'Ratio cintura/cadera', unit: '', source: 'calculated_values', decimals: 2, section: 'base' },
  { key: 'skinfold_sum_mm', label: 'Suma de pliegues', unit: 'mm', source: 'calculated_values', decimals: 1, section: 'anthropometry' },
  { key: 'corrected_arm_girth_cm', label: 'Brazo corregido', unit: 'cm', source: 'calculated_values', decimals: 1, section: 'anthropometry' },
  { key: 'corrected_calf_girth_cm', label: 'Pantorrilla corregida', unit: 'cm', source: 'calculated_values', decimals: 1, section: 'anthropometry' },
  { key: 'body_fat_percent', label: 'Grasa estimada', unit: '%', source: 'body_composition', decimals: 1, section: 'body_composition' },
  { key: 'fat_mass_kg', label: 'Masa grasa estimada', unit: 'kg', source: 'body_composition', decimals: 1, section: 'body_composition' },
  { key: 'fat_free_mass_kg', label: 'Masa libre de grasa', unit: 'kg', source: 'body_composition', decimals: 1, section: 'body_composition' },
  { key: 'body_density', label: 'Densidad corporal', unit: 'g/ml', source: 'body_composition', decimals: 4, section: 'body_composition' },
  { key: 'endomorphy', label: 'Endomorfia', unit: '', source: 'somatotype', decimals: 1, section: 'somatotype' },
  { key: 'mesomorphy', label: 'Mesomorfia', unit: '', source: 'somatotype', decimals: 1, section: 'somatotype' },
  { key: 'ectomorphy', label: 'Ectomorfia', unit: '', source: 'somatotype', decimals: 1, section: 'somatotype' },
];

const REPORT_SECTION_DEFINITIONS = {
  base: 'Datos principales',
  anthropometry: 'Antropometría',
  body_composition: 'Composición corporal',
  somatotype: 'Somatotipo Heath-Carter',
};

const DURNIN_WOMERSLEY_COEFFICIENTS = {
  male: [
    { maxAge: 16, c: 1.1533, m: 0.0643, label: '<17' },
    { maxAge: 19, c: 1.1620, m: 0.0630, label: '17-19' },
    { maxAge: 29, c: 1.1631, m: 0.0632, label: '20-29' },
    { maxAge: 39, c: 1.1422, m: 0.0544, label: '30-39' },
    { maxAge: 49, c: 1.1620, m: 0.0700, label: '40-49' },
    { maxAge: Infinity, c: 1.1715, m: 0.0779, label: '50+' },
  ],
  female: [
    { maxAge: 16, c: 1.1369, m: 0.0598, label: '<17' },
    { maxAge: 19, c: 1.1549, m: 0.0678, label: '17-19' },
    { maxAge: 29, c: 1.1599, m: 0.0717, label: '20-29' },
    { maxAge: 39, c: 1.1423, m: 0.0632, label: '30-39' },
    { maxAge: 49, c: 1.1333, m: 0.0612, label: '40-49' },
    { maxAge: Infinity, c: 1.1339, m: 0.0645, label: '50+' },
  ],
};

function toIntOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function toNumberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, decimals = 1) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function hashSnapshot(payload) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(payload || {}))
    .digest('hex');
}

function isMissingReportTableError(error) {
  const message = String(error?.message || '');
  const code = String(error?.original?.code || error?.parent?.code || error?.code || '');
  return code === 'ER_NO_SUCH_TABLE'
    || code === '42P01'
    || /PatientNutritionReports/i.test(message) && /doesn't exist|does not exist|no such table/i.test(message);
}

async function generateUniqueNutritionReportPublicId() {
  const model = db.PatientNutritionReport;
  if (!model) return `nrep_${crypto.randomBytes(10).toString('hex')}`;
  for (let i = 0; i < 5; i += 1) {
    const publicId = `nrep_${crypto.randomBytes(10).toString('hex')}`;
    const existing = await model.findOne({ where: { public_id: publicId }, attributes: ['id'] });
    if (!existing) return publicId;
  }
  return `nrep_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function formatDate(value, withTime = true) {
  if (!value) return 'No indicado';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'No indicado';
  return new Intl.DateTimeFormat('es-ES', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  }).format(date);
}

function formatMetricValue(metric = {}) {
  const value = metric.value;
  if (value === null || value === undefined || value === '') return '-';
  return `${value}${metric.unit ? ` ${metric.unit}` : ''}`;
}

function formatDelta(metric = {}) {
  const delta = metric.delta;
  if (delta === null || delta === undefined) return '-';
  const sign = Number(delta) > 0 ? '+' : '';
  return `${sign}${delta}${metric.unit ? ` ${metric.unit}` : ''}`;
}

function normalizeProfileCode(value) {
  return value === 'express_isak' ? 'express_isak' : 'quick';
}

async function getNutritionContractSafe() {
  try {
    return await medicalAreaContracts.getContractForArea('nutricion');
  } catch (error) {
    return medicalAreaContracts.getBaseContractForArea('nutricion');
  }
}

function profileDefinitionsFromContract(contract = {}) {
  return Array.isArray(contract.nutrition_measurement_profile_schemas) && contract.nutrition_measurement_profile_schemas.length
    ? contract.nutrition_measurement_profile_schemas
    : PROFILE_DEFINITIONS;
}

function fieldDefinitionsFromContract(contract = {}) {
  return contract.nutrition_measurement_fields
    && typeof contract.nutrition_measurement_fields === 'object'
    && Object.keys(contract.nutrition_measurement_fields).length
    ? contract.nutrition_measurement_fields
    : FIELD_DEFINITIONS;
}

function requiredFieldsForProfile(profileCode = 'quick', profileDefinitions = PROFILE_DEFINITIONS) {
  const profile = (profileDefinitions || PROFILE_DEFINITIONS).find((item) => item.code === profileCode)
    || (profileDefinitions || PROFILE_DEFINITIONS)[0]
    || {};
  return Array.from(new Set((profile.groups || [])
    .flatMap((group) => group.required_fields || [])
    .filter(Boolean)));
}

function missingRequiredFieldsForProfile(rawValues = {}, profileCode = 'quick', profileDefinitions = PROFILE_DEFINITIONS, fieldDefinitions = FIELD_DEFINITIONS) {
  return requiredFieldsForProfile(profileCode, profileDefinitions)
    .filter((field) => {
      const value = rawValues[field];
      return value === undefined || value === null || value === '';
    })
    .map((field) => ({
      field,
      label: fieldDefinitions?.[field]?.label || field,
      unit: fieldDefinitions?.[field]?.unit || '',
    }));
}

function formulaReferencesForProfile(profileCode = 'quick') {
  return FORMULA_REFERENCES
    .filter((reference) => (reference.profiles || []).includes(profileCode))
    .map(({ profiles, ...reference }) => reference);
}

function normalizeRawValues(values = {}, fieldDefinitions = FIELD_DEFINITIONS) {
  const normalized = {};
  Object.keys(fieldDefinitions || FIELD_DEFINITIONS).forEach((field) => {
    const parsed = toNumberOrNull(values[field]);
    if (parsed !== null) normalized[field] = parsed;
  });
  if (values.objective) normalized.objective = String(values.objective).trim().slice(0, 160);
  return normalized;
}

function qualityFlagsForValues(rawValues = {}, fieldDefinitions = FIELD_DEFINITIONS) {
  const flags = [];
  Object.entries(fieldDefinitions || FIELD_DEFINITIONS).forEach(([key, def]) => {
    const value = rawValues[key];
    if (value === undefined || value === null) return;
    if (value < def.min || value > def.max) {
      flags.push({
        field: key,
        code: 'out_of_expected_range',
        message: `${def.label} fuera del rango esperado`,
      });
    }
  });
  return flags;
}

function calculateSomatotype(rawValues = {}) {
  const height = rawValues.stature_cm;
  const weight = rawValues.weight_kg;
  const triceps = rawValues.skinfold_triceps_mm;
  const subscapular = rawValues.skinfold_subscapular_mm;
  const supraspinale = rawValues.skinfold_supraspinale_mm;
  const medialCalf = rawValues.skinfold_medial_calf_mm;
  const humerus = rawValues.breadth_humerus_cm;
  const femur = rawValues.breadth_femur_cm;
  const armFlexed = rawValues.arm_flexed_tensed_cm;
  const calf = rawValues.calf_cm;

  if (![height, weight, triceps, subscapular, supraspinale, medialCalf, humerus, femur, armFlexed, calf]
    .every((value) => Number.isFinite(value) && value > 0)) {
    return null;
  }

  const correctedSkinfoldSum = (triceps + subscapular + supraspinale) * (170.18 / height);
  const endomorphy =
    -0.7182 +
    (0.1451 * correctedSkinfoldSum) -
    (0.00068 * correctedSkinfoldSum ** 2) +
    (0.0000014 * correctedSkinfoldSum ** 3);
  const correctedArm = armFlexed - (triceps / 10);
  const correctedCalf = calf - (medialCalf / 10);
  const mesomorphy =
    (0.858 * humerus) +
    (0.601 * femur) +
    (0.188 * correctedArm) +
    (0.161 * correctedCalf) -
    (0.131 * height) +
    4.5;
  const heightWeightRatio = height / Math.cbrt(weight);
  let ectomorphy = 0.1;
  if (heightWeightRatio >= 40.75) {
    ectomorphy = (0.732 * heightWeightRatio) - 28.58;
  } else if (heightWeightRatio > 38.25) {
    ectomorphy = (0.463 * heightWeightRatio) - 17.63;
  }

  return {
    endomorphy: round(Math.max(endomorphy, 0), 1),
    mesomorphy: round(Math.max(mesomorphy, 0), 1),
    ectomorphy: round(Math.max(ectomorphy, 0.1), 1),
    source: 'Heath-Carter anthropometric somatotype',
  };
}

function normalizeSexForBodyComposition(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  if (!normalized) return null;
  if (['hombre', 'masculino', 'male', 'man', 'varon', 'h'].includes(normalized)) return 'male';
  if (['mujer', 'femenino', 'female', 'woman', 'f'].includes(normalized)) return 'female';
  if (normalized.includes('hombre') || normalized.includes('mascul') || normalized.includes('varon')) return 'male';
  if (normalized.includes('mujer') || normalized.includes('femen')) return 'female';
  return null;
}

function calculateAgeYears(birthValue, referenceDate = new Date()) {
  if (!birthValue) return null;
  const birthDate = new Date(birthValue);
  const refDate = new Date(referenceDate);
  if (!Number.isFinite(birthDate.getTime()) || !Number.isFinite(refDate.getTime())) return null;
  let age = refDate.getUTCFullYear() - birthDate.getUTCFullYear();
  const monthDelta = refDate.getUTCMonth() - birthDate.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && refDate.getUTCDate() < birthDate.getUTCDate())) {
    age -= 1;
  }
  return age >= 0 && age <= 130 ? age : null;
}

function normalizeAgeYears(value) {
  const parsed = toIntOrNull(value);
  return parsed !== null && parsed >= 0 && parsed <= 130 ? parsed : null;
}

function buildPatientFormulaContext(patient, referenceDate = new Date()) {
  return {
    sex: normalizeSexForBodyComposition(patient?.sexo),
    age_years: calculateAgeYears(patient?.fecha_nacimiento, referenceDate) ?? normalizeAgeYears(patient?.edad),
  };
}

function coefficientForDurninWomersley(sex, ageYears) {
  if (!sex || !Number.isFinite(ageYears)) return null;
  return (DURNIN_WOMERSLEY_COEFFICIENTS[sex] || []).find((item) => ageYears <= item.maxAge) || null;
}

function calculateBodyComposition(rawValues = {}, context = {}) {
  const sex = normalizeSexForBodyComposition(context.sex);
  const ageYears = normalizeAgeYears(context.age_years);
  const weight = rawValues.weight_kg;
  const biceps = rawValues.skinfold_biceps_mm;
  const triceps = rawValues.skinfold_triceps_mm;
  const subscapular = rawValues.skinfold_subscapular_mm;
  const iliacCrest = rawValues.skinfold_iliac_crest_mm;

  if (![weight, biceps, triceps, subscapular, iliacCrest].every((value) => Number.isFinite(value) && value > 0)) {
    return null;
  }

  const coefficient = coefficientForDurninWomersley(sex, ageYears);
  if (!coefficient) return null;

  const skinfoldSum4 = biceps + triceps + subscapular + iliacCrest;
  const bodyDensity = coefficient.c - (coefficient.m * Math.log10(skinfoldSum4));
  if (!Number.isFinite(bodyDensity) || bodyDensity <= 0) return null;

  const bodyFatPercent = (495 / bodyDensity) - 450;
  if (!Number.isFinite(bodyFatPercent)) return null;

  const fatMassKg = weight * (bodyFatPercent / 100);
  return {
    method: 'Durnin-Womersley 4 skinfold body density + Siri body fat',
    sex,
    age_years: ageYears,
    age_band: coefficient.label,
    skinfold_sum_4_mm: round(skinfoldSum4, 1),
    body_density: round(bodyDensity, 4),
    body_fat_percent: round(bodyFatPercent, 1),
    fat_mass_kg: round(fatMassKg, 1),
    fat_free_mass_kg: round(weight - fatMassKg, 1),
    input_fields: [
      'weight_kg',
      'skinfold_biceps_mm',
      'skinfold_triceps_mm',
      'skinfold_subscapular_mm',
      'skinfold_iliac_crest_mm',
    ],
    source: 'Durnin-Womersley 1974 + Siri conversion',
  };
}

function calculateNutritionValues(rawValues = {}, profileCode = 'quick', context = {}) {
  const weight = rawValues.weight_kg;
  const height = rawValues.stature_cm;
  const waist = rawValues.waist_cm;
  const hip = rawValues.hip_cm;
  const triceps = rawValues.skinfold_triceps_mm;
  const medialCalf = rawValues.skinfold_medial_calf_mm;
  const skinfoldFields = Object.keys(FIELD_DEFINITIONS).filter((field) => field.startsWith('skinfold_'));
  const skinfoldValues = skinfoldFields
    .map((field) => rawValues[field])
    .filter((value) => Number.isFinite(value));
  const skinfoldSum = skinfoldValues.length ? skinfoldValues.reduce((sum, value) => sum + value, 0) : null;
  const armFlexed = rawValues.arm_flexed_tensed_cm;
  const calf = rawValues.calf_cm;

  return {
    formula_version: FORMULA_VERSION,
    profile_code: profileCode,
    bmi: Number.isFinite(weight) && Number.isFinite(height) && height > 0
      ? round(weight / ((height / 100) ** 2), 1)
      : null,
    waist_hip_ratio: Number.isFinite(waist) && Number.isFinite(hip) && hip > 0
      ? round(waist / hip, 2)
      : null,
    skinfold_sum_mm: skinfoldSum !== null ? round(skinfoldSum, 1) : null,
    corrected_arm_girth_cm: Number.isFinite(armFlexed) && Number.isFinite(triceps)
      ? round(armFlexed - (triceps / 10), 1)
      : null,
    corrected_calf_girth_cm: Number.isFinite(calf) && Number.isFinite(medialCalf)
      ? round(calf - (medialCalf / 10), 1)
      : null,
    somatotype: profileCode === 'express_isak' ? calculateSomatotype(rawValues) : null,
    body_composition: profileCode === 'express_isak' ? calculateBodyComposition(rawValues, context) : null,
  };
}

function measurementToJson(row) {
  if (!row) return null;
  const plain = typeof row.toJSON === 'function' ? row.toJSON() : row;
  return {
    id: plain.id,
    patient_id: plain.patient_id,
    clinic_id: plain.clinic_id,
    professional_id: plain.professional_id,
    appointment_id: plain.appointment_id,
    treatment_id: plain.treatment_id,
    profile_code: plain.profile_code,
    measured_at: plain.measured_at,
    raw_values: plain.raw_values_json || {},
    calculated_values: plain.calculated_values_json || {},
    formula_version: plain.formula_version || FORMULA_VERSION,
    quality_flags: plain.quality_flags_json || [],
    notes: plain.notes || '',
    created_at: plain.created_at,
    updated_at: plain.updated_at,
  };
}

function buildEvolution(measurements = []) {
  const chronological = [...measurements].reverse().map(measurementToJson);
  return chronological.map((item, index) => {
    const previous = chronological[index - 1] || null;
    const weight = item.raw_values.weight_kg ?? null;
    const waist = item.raw_values.waist_cm ?? null;
    return {
      measurement_id: item.id,
      measured_at: item.measured_at,
      profile_code: item.profile_code,
      weight_kg: weight,
      waist_cm: waist,
      hip_cm: item.raw_values.hip_cm ?? null,
      skinfold_sum_mm: item.calculated_values.skinfold_sum_mm ?? null,
      bmi: item.calculated_values.bmi ?? null,
      body_fat_percent: item.calculated_values.body_composition?.body_fat_percent ?? null,
      delta_weight_kg: previous && Number.isFinite(weight) && Number.isFinite(previous.raw_values.weight_kg)
        ? round(weight - previous.raw_values.weight_kg, 1)
        : null,
      delta_waist_cm: previous && Number.isFinite(waist) && Number.isFinite(previous.raw_values.waist_cm)
        ? round(waist - previous.raw_values.waist_cm, 1)
        : null,
    };
  });
}

function buildProjection(measurements = []) {
  const chronological = [...measurements].reverse().map(measurementToJson);
  const usable = chronological.filter((item) => Number.isFinite(item.raw_values.weight_kg));
  if (usable.length < 2) {
    return {
      available: false,
      reason: 'need_two_measurements',
    };
  }

  const first = usable[usable.length - 2];
  const last = usable[usable.length - 1];
  const firstDate = new Date(first.measured_at).getTime();
  const lastDate = new Date(last.measured_at).getTime();
  const weeks = (lastDate - firstDate) / (1000 * 60 * 60 * 24 * 7);
  if (!Number.isFinite(weeks) || weeks <= 0) {
    return {
      available: false,
      reason: 'same_measurement_date',
    };
  }

  const weightPerWeek = (last.raw_values.weight_kg - first.raw_values.weight_kg) / weeks;
  const waistPerWeek = Number.isFinite(last.raw_values.waist_cm) && Number.isFinite(first.raw_values.waist_cm)
    ? (last.raw_values.waist_cm - first.raw_values.waist_cm) / weeks
    : null;

  return {
    available: true,
    based_on_measurement_ids: [first.id, last.id],
    observed_weeks: round(weeks, 1),
    weight_change_per_week_kg: round(weightPerWeek, 2),
    waist_change_per_week_cm: waistPerWeek !== null ? round(waistPerWeek, 2) : null,
    projected_8_week_weight_kg: round(last.raw_values.weight_kg + (weightPerWeek * 8), 1),
    projected_8_week_waist_cm: waistPerWeek !== null
      ? round(last.raw_values.waist_cm + (waistPerWeek * 8), 1)
      : null,
  };
}

function buildProjectionForMeasurement(measurements = [], measurementId) {
  const chronologicalRows = [...measurements].reverse();
  const targetIndex = chronologicalRows.findIndex((item) => Number(measurementToJson(item)?.id) === Number(measurementId));
  if (targetIndex < 0) {
    return {
      available: false,
      reason: 'measurement_not_found',
    };
  }
  return buildProjection(chronologicalRows.slice(0, targetIndex + 1).reverse());
}

function getReportMetricValue(measurement, metricDefinition) {
  if (!measurement || !metricDefinition) return null;
  const calculatedValues = measurement.calculated_values || {};
  if (metricDefinition.source === 'raw_values') {
    return measurement.raw_values?.[metricDefinition.key] ?? null;
  }
  if (metricDefinition.source === 'calculated_values') {
    return calculatedValues[metricDefinition.key] ?? null;
  }
  if (metricDefinition.source === 'somatotype') {
    return calculatedValues.somatotype?.[metricDefinition.key] ?? null;
  }
  if (metricDefinition.source === 'body_composition') {
    return calculatedValues.body_composition?.[metricDefinition.key] ?? null;
  }
  return null;
}

function normalizeMetricValue(value, decimals = 1) {
  if (!Number.isFinite(value)) return value ?? null;
  return round(value, decimals);
}

function buildReportMetric(measurement, previousMeasurement, metricDefinition) {
  const value = getReportMetricValue(measurement, metricDefinition);
  if (value === null || value === undefined || value === '') return null;

  const previousValue = getReportMetricValue(previousMeasurement, metricDefinition);
  const numericValue = Number(value);
  const numericPreviousValue = Number(previousValue);
  const canCompare = Number.isFinite(numericValue) && Number.isFinite(numericPreviousValue);
  const delta = canCompare ? round(numericValue - numericPreviousValue, metricDefinition.decimals) : null;

  return {
    key: metricDefinition.key,
    label: metricDefinition.label,
    unit: metricDefinition.unit,
    section: metricDefinition.section,
    value: normalizeMetricValue(value, metricDefinition.decimals),
    previous_value: canCompare ? normalizeMetricValue(previousValue, metricDefinition.decimals) : null,
    delta,
    trend: delta === null
      ? 'not_comparable'
      : Math.abs(delta) < (metricDefinition.decimals === 2 ? 0.01 : 0.05)
        ? 'stable'
        : delta > 0
          ? 'up'
          : 'down',
  };
}

function buildReportSections(metrics = []) {
  return Object.entries(REPORT_SECTION_DEFINITIONS)
    .map(([key, title]) => ({
      key,
      title,
      metrics: metrics.filter((metric) => metric.section === key),
    }))
    .filter((section) => section.metrics.length);
}

function buildMeasurementComparison(measurement, previousMeasurement, metrics = []) {
  if (!measurement || !previousMeasurement) {
    return {
      available: false,
      reason: 'need_previous_measurement',
    };
  }

  const measuredAt = new Date(measurement.measured_at).getTime();
  const previousMeasuredAt = new Date(previousMeasurement.measured_at).getTime();
  const daysBetween = (measuredAt - previousMeasuredAt) / (1000 * 60 * 60 * 24);
  const comparableMetrics = metrics
    .filter((metric) => metric.delta !== null && metric.delta !== undefined)
    .map((metric) => ({
      key: metric.key,
      label: metric.label,
      unit: metric.unit,
      value: metric.value,
      previous_value: metric.previous_value,
      delta: metric.delta,
      trend: metric.trend,
    }));

  if (!comparableMetrics.length) {
    return {
      available: false,
      reason: 'no_comparable_metrics',
      previous_measurement_id: previousMeasurement.id,
      previous_measured_at: previousMeasurement.measured_at,
    };
  }

  return {
    available: true,
    previous_measurement_id: previousMeasurement.id,
    previous_measured_at: previousMeasurement.measured_at,
    days_between: Number.isFinite(daysBetween) ? round(daysBetween, 0) : null,
    metrics: comparableMetrics,
  };
}

function buildReportNarrative(measurement, comparison, metrics = []) {
  const notes = [];
  const rawValues = measurement.raw_values || {};
  const skinfoldCount = Object.keys(rawValues)
    .filter((key) => key.startsWith('skinfold_') && Number.isFinite(rawValues[key]))
    .length;

  if (measurement.profile_code === 'express_isak') {
    notes.push(skinfoldCount >= 8
      ? 'Perfil express/ISAK con los 8 pliegues del perfil restringido registrados.'
      : `Perfil express/ISAK parcial con ${skinfoldCount} de 8 pliegues registrados.`);
    if (measurement.calculated_values?.body_composition) {
      notes.push('Composición corporal estimada con Durnin-Womersley y Siri a partir de 4 pliegues; debe interpretarse como estimación antropométrica.');
    } else {
      notes.push('La composición corporal estimada requiere sexo, edad, peso y los pliegues bíceps, tríceps, subescapular e ilíaco/suprailiaco.');
    }
  } else {
    notes.push('Resumen rápido para seguimiento de consulta.');
  }

  if (comparison?.available) {
    const weightMetric = comparison.metrics.find((metric) => metric.key === 'weight_kg');
    const waistMetric = comparison.metrics.find((metric) => metric.key === 'waist_cm');
    const changes = [weightMetric, waistMetric]
      .filter(Boolean)
      .map((metric) => `${metric.label.toLowerCase()} ${metric.delta > 0 ? '+' : ''}${metric.delta}${metric.unit ? ` ${metric.unit}` : ''}`);
    notes.push(changes.length
      ? `Comparado con la medición anterior: ${changes.join(', ')}.`
      : 'Comparativa disponible frente a la medición anterior.');
  } else {
    notes.push('Registra otra medición en una fecha distinta para activar la comparativa temporal.');
  }

  if (measurement.quality_flags?.length) {
    notes.push('Hay medidas fuera del rango esperado; conviene revisarlas antes de entregar el informe.');
  }

  if (!metrics.some((metric) => metric.section === 'somatotype')) {
    notes.push('El somatotipo requiere perfil express/ISAK completo.');
  }

  return notes;
}

function buildReports(measurements = []) {
  const chronological = [...measurements].reverse().map(measurementToJson);
  return chronological
    .map((measurement, index) => {
      const previousMeasurement = chronological[index - 1] || null;
      const metrics = REPORT_METRIC_DEFINITIONS
        .map((metricDefinition) => buildReportMetric(measurement, previousMeasurement, metricDefinition))
        .filter(Boolean);
      if (!metrics.length) return null;

      const comparison = buildMeasurementComparison(measurement, previousMeasurement, metrics);
      return {
        id: `nutrition-report-${measurement.id}`,
        measurement_id: measurement.id,
        report_type: measurement.profile_code === 'express_isak' ? 'express_isak' : 'quick_summary',
        title: measurement.profile_code === 'express_isak' ? 'Informe antropometría ISAK' : 'Resumen rápido nutricional',
        created_at: measurement.measured_at,
        formula_version: measurement.formula_version,
        formula_references: formulaReferencesForProfile(measurement.profile_code),
        profile_code: measurement.profile_code,
        quality_flags: measurement.quality_flags || [],
        summary: {
          bmi: measurement.calculated_values.bmi,
          waist_hip_ratio: measurement.calculated_values.waist_hip_ratio,
          skinfold_sum_mm: measurement.calculated_values.skinfold_sum_mm,
          somatotype: measurement.calculated_values.somatotype,
          body_composition: measurement.calculated_values.body_composition,
          metric_count: metrics.length,
        },
        sections: buildReportSections(metrics),
        comparison,
        narrative: buildReportNarrative(measurement, comparison, metrics),
      };
    })
    .filter(Boolean)
    .reverse();
}

function nutritionReportSnapshotToJson(row) {
  if (!row) return null;
  const plain = typeof row.toJSON === 'function' ? row.toJSON() : row;
  return {
    id: plain.id,
    public_id: plain.public_id,
    measurement_id: plain.measurement_id,
    patient_id: plain.patient_id,
    clinic_id: plain.clinic_id,
    appointment_id: plain.appointment_id,
    treatment_id: plain.treatment_id,
    report_type: plain.report_type,
    title: plain.title,
    status: plain.status,
    formula_version: plain.formula_version,
    snapshot_hash: plain.snapshot_hash,
    pdf_asset_id: plain.pdf_asset_id,
    storage_strategy: plain.storage_strategy || 'json_snapshot_printable_on_demand',
    generated_by: plain.generated_by,
    generated_at: plain.generated_at,
    created_at: plain.created_at,
    updated_at: plain.updated_at,
  };
}

function attachReportSnapshots(reports = [], snapshotRows = []) {
  const snapshotsByMeasurement = new Map();
  (snapshotRows || []).forEach((row) => {
    const snapshot = nutritionReportSnapshotToJson(row);
    if (!snapshot || snapshot.status !== 'active') return;
    const key = `${snapshot.measurement_id}:${snapshot.report_type}`;
    const current = snapshotsByMeasurement.get(key);
    if (!current || new Date(snapshot.generated_at).getTime() > new Date(current.generated_at).getTime()) {
      snapshotsByMeasurement.set(key, snapshot);
    }
  });

  return (reports || []).map((report) => {
    const snapshot = snapshotsByMeasurement.get(`${report.measurement_id}:${report.report_type}`);
    if (!snapshot) return report;
    return {
      ...report,
      snapshot,
      snapshot_id: snapshot.id,
      snapshot_public_id: snapshot.public_id,
      snapshot_hash: snapshot.snapshot_hash,
      snapshot_created_at: snapshot.generated_at,
      storage_strategy: snapshot.storage_strategy,
    };
  });
}

async function findActiveNutritionReportSnapshotsForPatient(patientId) {
  if (!db.PatientNutritionReport || !patientId) return [];
  try {
    return await db.PatientNutritionReport.findAll({
      where: {
        patient_id: patientId,
        status: 'active',
      },
      order: [['generated_at', 'DESC'], ['id', 'DESC']],
      limit: 100,
    });
  } catch (error) {
    if (isMissingReportTableError(error)) return [];
    throw error;
  }
}

async function findActiveNutritionReportSnapshot(measurementId, reportType = null) {
  if (!db.PatientNutritionReport || !measurementId) return null;
  try {
    return await db.PatientNutritionReport.findOne({
      where: {
        measurement_id: measurementId,
        status: 'active',
        ...(reportType ? { report_type: reportType } : {}),
      },
      order: [['generated_at', 'DESC'], ['id', 'DESC']],
    });
  } catch (error) {
    if (isMissingReportTableError(error)) return null;
    throw error;
  }
}

function buildNutritionReportSnapshotPayload(reportData, renderedHtml, generatedAt = new Date().toISOString()) {
  const meta = {
    ...(reportData.meta || {}),
    generated_at: generatedAt,
    pdf_strategy: 'json_snapshot_printable_on_demand',
    storage: 'patient_nutrition_report_snapshot',
  };

  const snapshot = {
    kind: 'nutrition_measurement_report',
    snapshot_version: 1,
    patient: reportData.patient,
    treatment: reportData.treatment,
    appointment: reportData.appointment,
    measurement: reportData.measurement,
    report: reportData.report,
    profile_definitions: reportData.profile_definitions,
    field_definitions: reportData.field_definitions,
    projection: reportData.projection,
    meta,
  };

  return {
    snapshot,
    snapshot_hash: hashSnapshot({ ...snapshot, rendered_html: renderedHtml || '' }),
  };
}

async function findPatient(patientIdentifier) {
  const raw = String(patientIdentifier || '').trim();
  if (!raw) return null;
  const where = /^\d+$/.test(raw)
    ? { id_paciente: Number(raw) }
    : { public_id: raw };
  return db.Paciente.findOne({
    where,
    include: db.Clinica
      ? [{ model: db.Clinica, as: 'clinica', required: false }]
      : [],
  });
}

async function getNutritionTreatments({ clinicId, groupId }) {
  if (!db.Tratamiento || !clinicId) return [];
  const scope = [
    { origen: 'sistema' },
    { clinica_id: clinicId },
  ];
  if (groupId) scope.push({ grupo_clinica_id: groupId });
  const rows = await db.Tratamiento.findAll({
    where: {
      disciplina: 'nutricion',
      activo: true,
      [Op.or]: scope,
    },
    attributes: ['id_tratamiento', 'nombre', 'categoria', 'duracion_min', 'precio_base', 'clinical_config'],
    order: [['nombre', 'ASC']],
    limit: 100,
  });
  return rows.map((row) => {
    const plain = row.toJSON();
    return {
      id: plain.id_tratamiento,
      name: plain.nombre,
      category: plain.categoria,
      duration_min: plain.duracion_min,
      price_base: plain.precio_base,
      clinical_config: plain.clinical_config || null,
    };
  });
}

async function getPatientNutritionWorkspace(patientIdentifier) {
  const patient = await findPatient(patientIdentifier);
  if (!patient) {
    const error = new Error('patient_not_found');
    error.status = 404;
    throw error;
  }

  const clinicId = Number(patient.clinica_id);
  const groupId = toIntOrNull(patient.clinica?.grupoClinicaId || patient.clinica?.grupo_clinica_id);
  const nutritionContract = await getNutritionContractSafe();
  const profileDefinitions = profileDefinitionsFromContract(nutritionContract);
  const fieldDefinitions = fieldDefinitionsFromContract(nutritionContract);
  const measurements = await db.PatientNutritionMeasurement.findAll({
    where: { patient_id: patient.id_paciente },
    order: [['measured_at', 'DESC'], ['id', 'DESC']],
    limit: 50,
  });
  const reportSnapshots = await findActiveNutritionReportSnapshotsForPatient(patient.id_paciente);
  const reports = attachReportSnapshots(buildReports(measurements), reportSnapshots);
  const patientFormulaContext = buildPatientFormulaContext(patient);

  return {
    patient: {
      id: patient.id_paciente,
      public_id: patient.public_id,
      name: [patient.nombre, patient.apellidos].filter(Boolean).join(' ').trim(),
      clinic_id: clinicId,
      sex: patientFormulaContext.sex,
      age_years: patientFormulaContext.age_years,
    },
    profiles: profileDefinitions,
    fields: fieldDefinitions,
    treatments: await getNutritionTreatments({ clinicId, groupId }),
    latest: measurementToJson(measurements[0]),
    measurements: measurements.map(measurementToJson),
    evolution: buildEvolution(measurements),
    projection: buildProjection(measurements),
    reports,
    meta: {
      formula_version: FORMULA_VERSION,
      formula_references: FORMULA_REFERENCES.map(({ profiles, ...reference }) => reference),
      measurement_contract_source: 'medical-area-contracts-v1',
      generated_at: new Date().toISOString(),
    },
  };
}

async function createNutritionMeasurement(patientIdentifier, payload = {}, actorUserId = null) {
  const patient = await findPatient(patientIdentifier);
  if (!patient) {
    const error = new Error('patient_not_found');
    error.status = 404;
    throw error;
  }

  const profileCode = normalizeProfileCode(payload.profile_code);
  const nutritionContract = await getNutritionContractSafe();
  const profileDefinitions = profileDefinitionsFromContract(nutritionContract);
  const fieldDefinitions = fieldDefinitionsFromContract(nutritionContract);
  const rawValues = normalizeRawValues(payload.raw_values || payload.values || {}, fieldDefinitions);
  const missingRequiredFields = missingRequiredFieldsForProfile(rawValues, profileCode, profileDefinitions, fieldDefinitions);
  if (missingRequiredFields.length) {
    const error = new Error('missing_required_measurement_fields');
    error.status = 400;
    error.details = {
      profile_code: profileCode,
      missing_fields: missingRequiredFields,
    };
    throw error;
  }
  const qualityFlags = qualityFlagsForValues(rawValues, fieldDefinitions);
  const clinicId = toIntOrNull(payload.clinic_id) || Number(patient.clinica_id);
  const measuredAt = payload.measured_at ? new Date(payload.measured_at) : new Date();

  if (!Number.isFinite(measuredAt.getTime())) {
    const error = new Error('invalid_measured_at');
    error.status = 400;
    throw error;
  }
  const calculatedValues = calculateNutritionValues(rawValues, profileCode, buildPatientFormulaContext(patient, measuredAt));

  const row = await db.PatientNutritionMeasurement.create({
    patient_id: patient.id_paciente,
    clinic_id: clinicId,
    professional_id: toIntOrNull(payload.professional_id) || toIntOrNull(actorUserId),
    appointment_id: toIntOrNull(payload.appointment_id),
    treatment_id: toIntOrNull(payload.treatment_id),
    profile_code: profileCode,
    measured_at: measuredAt,
    raw_values_json: rawValues,
    calculated_values_json: calculatedValues,
    formula_version: FORMULA_VERSION,
    quality_flags_json: qualityFlags,
    notes: payload.notes ? String(payload.notes).trim().slice(0, 2000) : null,
    created_by: toIntOrNull(actorUserId),
    updated_by: toIntOrNull(actorUserId),
  });

  const measurement = measurementToJson(row);
  try {
    measurement.report_snapshot = await createNutritionMeasurementReportSnapshot(patient.id_paciente, row.id, actorUserId);
  } catch (error) {
    console.warn('[nutritionWorkspace] report snapshot creation failed', {
      measurement_id: row.id,
      message: error.message,
    });
    measurement.report_snapshot_error = 'report_snapshot_creation_failed';
  }

  return measurement;
}

async function buildNutritionMeasurementReportData(patientIdentifier, measurementIdentifier) {
  const patient = await findPatient(patientIdentifier);
  if (!patient) {
    const error = new Error('patient_not_found');
    error.status = 404;
    throw error;
  }

  const measurementId = toIntOrNull(measurementIdentifier);
  if (!measurementId) {
    const error = new Error('measurement_not_found');
    error.status = 404;
    throw error;
  }

  const measurements = await db.PatientNutritionMeasurement.findAll({
    where: { patient_id: patient.id_paciente },
    order: [['measured_at', 'DESC'], ['id', 'DESC']],
    limit: 50,
  });
  const measurementRow = measurements.find((item) => Number(item.id) === Number(measurementId));
  if (!measurementRow) {
    const error = new Error('measurement_not_found');
    error.status = 404;
    throw error;
  }

  const measurement = measurementToJson(measurementRow);
  const report = buildReports(measurements).find((item) => Number(item.measurement_id) === Number(measurement.id));
  if (!report) {
    const error = new Error('report_not_available');
    error.status = 404;
    throw error;
  }

  const nutritionContract = await getNutritionContractSafe();
  const profileDefinitions = profileDefinitionsFromContract(nutritionContract);
  const fieldDefinitions = fieldDefinitionsFromContract(nutritionContract);
  const treatment = measurement.treatment_id && db.Tratamiento
    ? await db.Tratamiento.findByPk(measurement.treatment_id, {
      attributes: ['id_tratamiento', 'nombre', 'disciplina', 'categoria', 'clinical_config'],
    })
    : null;
  const appointment = measurement.appointment_id && db.CitaPaciente
    ? await db.CitaPaciente.findByPk(measurement.appointment_id, {
      attributes: ['id_cita', 'inicio', 'fin', 'estado', 'doctor_id', 'clinica_id'],
      include: db.Usuario
        ? [{ model: db.Usuario, as: 'doctor', attributes: ['id_usuario', 'nombre', 'apellidos'], required: false }]
        : [],
    })
    : null;
  const patientFormulaContext = buildPatientFormulaContext(patient, measurement.measured_at);

  return {
    patient: {
      id: patient.id_paciente,
      public_id: patient.public_id,
      name: [patient.nombre, patient.apellidos].filter(Boolean).join(' ').trim(),
      clinic_id: Number(patient.clinica_id),
      clinic_name: patient.clinica?.nombre_clinica || '',
      sex: patientFormulaContext.sex,
      age_years: patientFormulaContext.age_years,
    },
    treatment: treatment?.toJSON ? treatment.toJSON() : treatment,
    appointment: appointment?.toJSON ? appointment.toJSON() : appointment,
    measurement,
    report,
    profile_definitions: profileDefinitions,
    field_definitions: fieldDefinitions,
    projection: buildProjectionForMeasurement(measurements, measurement.id),
    meta: {
      formula_version: FORMULA_VERSION,
      formula_references: formulaReferencesForProfile(measurement.profile_code),
      measurement_contract_source: 'medical-area-contracts-v1',
      generated_at: new Date().toISOString(),
      pdf_strategy: 'json_snapshot_printable_on_demand',
      storage: 'not_persisted',
    },
  };
}

async function getNutritionMeasurementReport(patientIdentifier, measurementIdentifier) {
  const reportData = await buildNutritionMeasurementReportData(patientIdentifier, measurementIdentifier);
  const snapshot = await findActiveNutritionReportSnapshot(
    reportData.measurement.id,
    reportData.report.report_type,
  );
  const snapshotJson = nutritionReportSnapshotToJson(snapshot);
  if (!snapshotJson) return reportData;
  return {
    ...reportData,
    report: {
      ...reportData.report,
      snapshot: snapshotJson,
      snapshot_id: snapshotJson.id,
      snapshot_public_id: snapshotJson.public_id,
      snapshot_hash: snapshotJson.snapshot_hash,
      snapshot_created_at: snapshotJson.generated_at,
      storage_strategy: snapshotJson.storage_strategy,
    },
    meta: {
      ...reportData.meta,
      storage: snapshotJson.storage_strategy,
      snapshot_hash: snapshotJson.snapshot_hash,
    },
  };
}

async function createNutritionMeasurementReportSnapshot(patientIdentifier, measurementIdentifier, actorUserId = null) {
  if (!db.PatientNutritionReport) return null;

  const reportData = await buildNutritionMeasurementReportData(patientIdentifier, measurementIdentifier);
  const existing = await findActiveNutritionReportSnapshot(
    reportData.measurement.id,
    reportData.report.report_type,
  );
  if (existing) return nutritionReportSnapshotToJson(existing);

  const generatedAt = new Date().toISOString();
  const normalizedReportData = {
    ...reportData,
    meta: {
      ...reportData.meta,
      generated_at: generatedAt,
      storage: 'patient_nutrition_report_snapshot',
    },
  };
  const renderedHtml = buildNutritionReportHtml(normalizedReportData);
  const { snapshot, snapshot_hash: snapshotHash } = buildNutritionReportSnapshotPayload(
    normalizedReportData,
    renderedHtml,
    generatedAt,
  );

  try {
    const row = await db.PatientNutritionReport.create({
      public_id: await generateUniqueNutritionReportPublicId(),
      measurement_id: reportData.measurement.id,
      patient_id: reportData.patient.id,
      clinic_id: reportData.patient.clinic_id,
      appointment_id: reportData.measurement.appointment_id || null,
      treatment_id: reportData.measurement.treatment_id || null,
      report_type: reportData.report.report_type,
      title: reportData.report.title,
      status: 'active',
      formula_version: reportData.report.formula_version || FORMULA_VERSION,
      snapshot_json: snapshot,
      snapshot_html: renderedHtml,
      snapshot_hash: snapshotHash,
      pdf_asset_id: null,
      storage_strategy: 'json_snapshot_printable_on_demand',
      generated_by: toIntOrNull(actorUserId),
      generated_at: generatedAt,
    });
    return nutritionReportSnapshotToJson(row);
  } catch (error) {
    if (isMissingReportTableError(error)) return null;
    throw error;
  }
}

function rawMeasurementRows(measurement = {}, profileDefinitions = PROFILE_DEFINITIONS, fieldDefinitions = FIELD_DEFINITIONS) {
  const profile = profileDefinitions.find((item) => item.code === measurement.profile_code) || profileDefinitions[0] || PROFILE_DEFINITIONS[0];
  const rawValues = measurement.raw_values || {};
  return profile.groups.map((group) => ({
    title: group.label,
    fields: group.fields
      .filter((field) => rawValues[field] !== undefined && rawValues[field] !== null && rawValues[field] !== '')
      .map((field) => ({
        label: fieldDefinitions[field]?.label || field,
        unit: fieldDefinitions[field]?.unit || '',
        value: rawValues[field],
      })),
  })).filter((group) => group.fields.length);
}

function buildNutritionReportHtml(reportData) {
  const { patient, treatment, appointment, measurement, report, projection, meta } = reportData;
  const profileLabel = measurement.profile_code === 'express_isak' ? 'Express/ISAK' : 'Rápido';
  const comparison = report.comparison || { available: false };
  const sectionsHtml = (report.sections || []).map((section) => `
    <section class="card">
      <h2>${escapeHtml(section.title)}</h2>
      <div class="metric-grid">
        ${(section.metrics || []).map((metric) => `
          <div class="metric">
            <dt>${escapeHtml(metric.label)}</dt>
            <dd>${escapeHtml(formatMetricValue(metric))}</dd>
            ${metric.delta !== null && metric.delta !== undefined ? `<span class="delta">${escapeHtml(formatDelta(metric))} vs anterior</span>` : ''}
          </div>
        `).join('')}
      </div>
    </section>
  `).join('');
  const comparisonHtml = comparison.available ? `
    <section class="card">
      <h2>Comparativa</h2>
      <p class="muted">Comparado con la medición del ${escapeHtml(formatDate(comparison.previous_measured_at))}${comparison.days_between != null ? ` · ${escapeHtml(comparison.days_between)} días entre mediciones` : ''}.</p>
      <table>
        <thead><tr><th>Métrica</th><th>Anterior</th><th>Actual</th><th>Diferencia</th></tr></thead>
        <tbody>
          ${(comparison.metrics || []).map((metric) => `
            <tr>
              <td>${escapeHtml(metric.label)}</td>
              <td>${escapeHtml(metric.previous_value ?? '-')} ${escapeHtml(metric.unit || '')}</td>
              <td>${escapeHtml(metric.value ?? '-')} ${escapeHtml(metric.unit || '')}</td>
              <td>${escapeHtml(formatDelta(metric))}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </section>
  ` : `
    <section class="card muted-card">
      <h2>Comparativa</h2>
      <p>No hay una medición anterior comparable para este informe.</p>
    </section>
  `;
  const projectionHtml = projection?.available ? `
    <section class="card">
      <h2>Proyección temporal</h2>
      <p class="muted">Estimación lineal simple basada en ${escapeHtml(projection.observed_weeks)} semanas observadas entre las dos últimas mediciones comparables del informe.</p>
      <div class="metric-grid">
        <div class="metric">
          <dt>Cambio semanal peso</dt>
          <dd>${escapeHtml(formatMetricValue({ value: projection.weight_change_per_week_kg, unit: 'kg' }))}</dd>
        </div>
        <div class="metric">
          <dt>Peso estimado 8 semanas</dt>
          <dd>${escapeHtml(formatMetricValue({ value: projection.projected_8_week_weight_kg, unit: 'kg' }))}</dd>
        </div>
        <div class="metric">
          <dt>Cambio semanal cintura</dt>
          <dd>${escapeHtml(formatMetricValue({ value: projection.waist_change_per_week_cm, unit: 'cm' }))}</dd>
        </div>
        <div class="metric">
          <dt>Cintura estimada 8 semanas</dt>
          <dd>${escapeHtml(formatMetricValue({ value: projection.projected_8_week_waist_cm, unit: 'cm' }))}</dd>
        </div>
      </div>
      <p class="muted small-note">Esta proyección es orientativa y debe interpretarse por el profesional junto al contexto clínico.</p>
    </section>
  ` : `
    <section class="card muted-card">
      <h2>Proyección temporal</h2>
      <p>Se necesitan dos mediciones con peso y fechas distintas para estimar tendencia.</p>
    </section>
  `;
  const rawHtml = rawMeasurementRows(measurement, reportData.profile_definitions, reportData.field_definitions).map((group) => `
    <section class="card">
      <h2>${escapeHtml(group.title)}</h2>
      <table>
        <tbody>
          ${group.fields.map((field) => `
            <tr>
              <td>${escapeHtml(field.label)}</td>
              <td>${escapeHtml(field.value)} ${escapeHtml(field.unit)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </section>
  `).join('');
  const narrativeHtml = (report.narrative || []).length
    ? `<section class="card"><h2>Resumen clínico</h2><ul>${report.narrative.map((note) => `<li>${escapeHtml(note)}</li>`).join('')}</ul></section>`
    : '';
  const qualityHtml = (report.quality_flags || []).length
    ? `<section class="card warning"><h2>Revisión de datos</h2><ul>${report.quality_flags.map((flag) => `<li>${escapeHtml(flag.message || flag.code)}</li>`).join('')}</ul></section>`
    : '';
  const formulaReferences = report.formula_references || meta.formula_references || [];
  const formulaReferencesHtml = formulaReferences.length ? `
    <section class="card muted-card">
      <h2>Bases de cálculo</h2>
      <ul>
        ${formulaReferences.map((reference) => `
          <li>
            <strong>${escapeHtml(reference.label)}</strong>: ${escapeHtml(reference.description || reference.source || '')}
            ${reference.url ? `<br><a href="${escapeHtml(reference.url)}">${escapeHtml(reference.source || reference.url)}</a>` : `<br><span class="muted">${escapeHtml(reference.source || '')}</span>`}
          </li>
        `).join('')}
      </ul>
    </section>
  ` : '';

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(report.title)} · ${escapeHtml(patient.name)}</title>
  <style>
    @page { size: A4; margin: 16mm; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f8fafc; color: #0f172a; font-family: Inter, Arial, sans-serif; font-size: 13px; line-height: 1.45; }
    .page { max-width: 920px; margin: 0 auto; padding: 24px; }
    header { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 24px; align-items: start; border-bottom: 1px solid #cbd5e1; padding-bottom: 20px; margin-bottom: 20px; }
    .brand { font-weight: 800; letter-spacing: .02em; color: #4f46e5; font-size: 20px; }
    h1 { margin: 8px 0 0; font-size: 28px; line-height: 1.1; }
    h2 { margin: 0 0 12px; font-size: 15px; }
    .muted { color: #64748b; }
    .pill { display: inline-flex; align-items: center; border-radius: 999px; background: #ecfdf5; color: #047857; padding: 4px 10px; font-size: 11px; font-weight: 700; }
    .summary { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 18px; margin-top: 16px; }
    .summary dt { color: #64748b; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
    .summary dd { margin: 2px 0 0; font-weight: 700; }
    .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 16px; margin-bottom: 14px; break-inside: avoid; }
    .muted-card { background: #f8fafc; }
    .warning { border-color: #f59e0b; background: #fffbeb; }
    .metric-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    .metric { border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px; }
    .metric dt { color: #64748b; font-size: 11px; }
    .metric dd { margin: 3px 0; font-size: 22px; font-weight: 800; }
    .delta { color: #0369a1; font-size: 11px; font-weight: 700; }
    .small-note { margin: 10px 0 0; font-size: 11px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; border-bottom: 1px solid #e2e8f0; padding: 7px 6px; }
    th { color: #64748b; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
    ul { margin: 0; padding-left: 18px; }
    footer { margin-top: 20px; padding-top: 12px; border-top: 1px solid #cbd5e1; color: #64748b; font-size: 11px; }
    @media print { body { background: #fff; } .page { padding: 0; } }
  </style>
</head>
<body>
  <main class="page">
    <header>
      <div>
        <div class="brand">ClinicaClick</div>
        <h1>${escapeHtml(report.title)}</h1>
        <p class="muted">${escapeHtml(patient.clinic_name || 'Clínica')} · Generado el ${escapeHtml(formatDate(meta.generated_at))}</p>
      </div>
      <span class="pill">${escapeHtml(meta.formula_version)}</span>
    </header>
    <section class="card">
      <dl class="summary">
        <div><dt>Paciente</dt><dd>${escapeHtml(patient.name || 'Paciente')}</dd></div>
        <div><dt>Perfil</dt><dd>${escapeHtml(profileLabel)}</dd></div>
        <div><dt>Medición</dt><dd>${escapeHtml(formatDate(measurement.measured_at))}</dd></div>
        <div><dt>Tratamiento</dt><dd>${escapeHtml(treatment?.nombre || 'No asociado')}</dd></div>
        <div><dt>Cita</dt><dd>${escapeHtml(appointment?.inicio ? formatDate(appointment.inicio) : 'No asociada')}</dd></div>
        <div><dt>Informe</dt><dd>${escapeHtml(report.id)}</dd></div>
      </dl>
    </section>
    ${sectionsHtml}
    ${comparisonHtml}
    ${projectionHtml}
    ${narrativeHtml}
    ${qualityHtml}
    ${formulaReferencesHtml}
    ${rawHtml}
    <footer>
      Informe calculado bajo demanda desde medición #${escapeHtml(measurement.id)} con ${escapeHtml(meta.formula_version)}. No persistido en PUBLIC_MEDIA.
    </footer>
  </main>
</body>
</html>`;
}

async function htmlToPdfBuffer(html, filenameSeed = 'nutrition-report') {
  const chromiumPath = process.env.CHROME_PATH
    || process.env.CHROMIUM_PATH
    || DEFAULT_CHROMIUM_PATH;
  const safeSeed = String(filenameSeed || 'nutrition-report').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clinicaclick-nutrition-'));
  const htmlPath = path.join(workDir, `${safeSeed}.html`);
  const pdfPath = path.join(workDir, `${safeSeed}.pdf`);

  try {
    await fs.writeFile(htmlPath, html, 'utf8');
    await execFileAsync(chromiumPath, [
      '--headless',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--no-pdf-header-footer',
      `--print-to-pdf=${pdfPath}`,
      `file://${htmlPath}`,
    ], { timeout: 25000, maxBuffer: 1024 * 1024 });
    return await fs.readFile(pdfPath);
  } catch (error) {
    const err = new Error(`pdf_generation_failed:${error.message || 'unknown'}`);
    err.status = 500;
    throw err;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function renderNutritionMeasurementReport(patientIdentifier, measurementIdentifier) {
  const reportData = await buildNutritionMeasurementReportData(patientIdentifier, measurementIdentifier);
  const snapshot = await findActiveNutritionReportSnapshot(
    reportData.measurement.id,
    reportData.report.report_type,
  );
  if (snapshot?.snapshot_html) {
    return snapshot.snapshot_html;
  }
  return buildNutritionReportHtml(reportData);
}

async function generateNutritionMeasurementReportPdf(patientIdentifier, measurementIdentifier) {
  const reportData = await buildNutritionMeasurementReportData(patientIdentifier, measurementIdentifier);
  const snapshot = await findActiveNutritionReportSnapshot(
    reportData.measurement.id,
    reportData.report.report_type,
  );
  const html = snapshot?.snapshot_html || buildNutritionReportHtml(reportData);
  const filename = `informe-nutricion-${reportData.measurement.id}.pdf`;
  return {
    filename,
    buffer: await htmlToPdfBuffer(html, `nutrition-${reportData.measurement.id}`),
  };
}

module.exports = {
  FORMULA_VERSION,
  FORMULA_REFERENCES,
  PROFILE_DEFINITIONS,
  FIELD_DEFINITIONS,
  calculateNutritionValues,
  getPatientNutritionWorkspace,
  createNutritionMeasurement,
  getNutritionMeasurementReport,
  createNutritionMeasurementReportSnapshot,
  renderNutritionMeasurementReport,
  generateNutritionMeasurementReportPdf,
  __testing: {
    buildReports,
    buildProjection,
    buildProjectionForMeasurement,
    buildNutritionReportHtml,
    buildNutritionReportSnapshotPayload,
    hashSnapshot,
    requiredFieldsForProfile,
    missingRequiredFieldsForProfile,
    normalizeSexForBodyComposition,
    calculateAgeYears,
    buildPatientFormulaContext,
    calculateBodyComposition,
  },
};
