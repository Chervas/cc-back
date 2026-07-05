'use strict';

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const db = require('../../models');
const medicalAreaContracts = require('./medicalAreaContracts.service');

const { Op } = db.Sequelize;
const execFileAsync = promisify(execFile);
const FORMULA_VERSION = 'nutrition-basic-v1';
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
    key: 'linear_projection',
    label: 'Proyección temporal',
    description: 'Estimación lineal simple basada en las dos últimas mediciones comparables con fechas distintas.',
    source: 'ClinicaClick nutrition-basic-v1',
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
  { key: 'endomorphy', label: 'Endomorfia', unit: '', source: 'somatotype', decimals: 1, section: 'somatotype' },
  { key: 'mesomorphy', label: 'Mesomorfia', unit: '', source: 'somatotype', decimals: 1, section: 'somatotype' },
  { key: 'ectomorphy', label: 'Ectomorfia', unit: '', source: 'somatotype', decimals: 1, section: 'somatotype' },
];

const REPORT_SECTION_DEFINITIONS = {
  base: 'Datos principales',
  anthropometry: 'Antropometría',
  somatotype: 'Somatotipo Heath-Carter',
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

function calculateNutritionValues(rawValues = {}, profileCode = 'quick') {
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

  return {
    patient: {
      id: patient.id_paciente,
      public_id: patient.public_id,
      name: [patient.nombre, patient.apellidos].filter(Boolean).join(' ').trim(),
      clinic_id: clinicId,
    },
    profiles: profileDefinitions,
    fields: fieldDefinitions,
    treatments: await getNutritionTreatments({ clinicId, groupId }),
    latest: measurementToJson(measurements[0]),
    measurements: measurements.map(measurementToJson),
    evolution: buildEvolution(measurements),
    projection: buildProjection(measurements),
    reports: buildReports(measurements),
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
  const fieldDefinitions = fieldDefinitionsFromContract(nutritionContract);
  const rawValues = normalizeRawValues(payload.raw_values || payload.values || {}, fieldDefinitions);
  const qualityFlags = qualityFlagsForValues(rawValues, fieldDefinitions);
  const calculatedValues = calculateNutritionValues(rawValues, profileCode);
  const clinicId = toIntOrNull(payload.clinic_id) || Number(patient.clinica_id);
  const measuredAt = payload.measured_at ? new Date(payload.measured_at) : new Date();

  if (!Number.isFinite(measuredAt.getTime())) {
    const error = new Error('invalid_measured_at');
    error.status = 400;
    throw error;
  }

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

  return measurementToJson(row);
}

async function getNutritionMeasurementReport(patientIdentifier, measurementIdentifier) {
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

  return {
    patient: {
      id: patient.id_paciente,
      public_id: patient.public_id,
      name: [patient.nombre, patient.apellidos].filter(Boolean).join(' ').trim(),
      clinic_id: Number(patient.clinica_id),
      clinic_name: patient.clinica?.nombre_clinica || '',
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
  const reportData = await getNutritionMeasurementReport(patientIdentifier, measurementIdentifier);
  return buildNutritionReportHtml(reportData);
}

async function generateNutritionMeasurementReportPdf(patientIdentifier, measurementIdentifier) {
  const reportData = await getNutritionMeasurementReport(patientIdentifier, measurementIdentifier);
  const html = buildNutritionReportHtml(reportData);
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
  renderNutritionMeasurementReport,
  generateNutritionMeasurementReportPdf,
  __testing: {
    buildReports,
    buildProjection,
    buildProjectionForMeasurement,
    buildNutritionReportHtml,
  },
};
