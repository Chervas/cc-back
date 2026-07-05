'use strict';

const db = require('../../models');

const { Op } = db.Sequelize;
const FORMULA_VERSION = 'nutrition-basic-v1';

const PROFILE_DEFINITIONS = [
  {
    code: 'quick',
    name: 'Perfil rápido',
    description: 'Seguimiento de consulta con peso y perímetros principales.',
    groups: [
      {
        key: 'base',
        label: 'Datos base',
        fields: ['weight_kg', 'stature_cm', 'waist_cm', 'hip_cm', 'arm_relaxed_cm', 'calf_cm'],
      },
    ],
  },
  {
    code: 'express_isak',
    name: 'Perfil express/ISAK',
    description: 'Perfil antropométrico restringido para informe y evolución.',
    groups: [
      {
        key: 'base',
        label: 'Datos base',
        fields: ['weight_kg', 'stature_cm'],
      },
      {
        key: 'skinfolds',
        label: 'Pliegues',
        fields: [
          'skinfold_triceps_mm',
          'skinfold_subscapular_mm',
          'skinfold_biceps_mm',
          'skinfold_iliac_crest_mm',
          'skinfold_supraspinale_mm',
          'skinfold_abdominal_mm',
          'skinfold_front_thigh_mm',
          'skinfold_medial_calf_mm',
        ],
      },
      {
        key: 'girths',
        label: 'Perímetros',
        fields: [
          'arm_relaxed_cm',
          'arm_flexed_tensed_cm',
          'waist_cm',
          'hip_cm',
          'calf_cm',
        ],
      },
      {
        key: 'breadths',
        label: 'Diámetros',
        fields: ['breadth_humerus_cm', 'breadth_femur_cm'],
      },
    ],
  },
];

const FIELD_DEFINITIONS = {
  weight_kg: { label: 'Peso', unit: 'kg', min: 20, max: 300 },
  stature_cm: { label: 'Estatura', unit: 'cm', min: 80, max: 230 },
  waist_cm: { label: 'Cintura', unit: 'cm', min: 30, max: 220 },
  hip_cm: { label: 'Cadera', unit: 'cm', min: 30, max: 240 },
  arm_relaxed_cm: { label: 'Brazo relajado', unit: 'cm', min: 10, max: 80 },
  arm_flexed_tensed_cm: { label: 'Brazo flexionado', unit: 'cm', min: 10, max: 90 },
  calf_cm: { label: 'Pantorrilla', unit: 'cm', min: 10, max: 90 },
  skinfold_triceps_mm: { label: 'Tríceps', unit: 'mm', min: 1, max: 80 },
  skinfold_subscapular_mm: { label: 'Subescapular', unit: 'mm', min: 1, max: 90 },
  skinfold_biceps_mm: { label: 'Bíceps', unit: 'mm', min: 1, max: 70 },
  skinfold_iliac_crest_mm: { label: 'Cresta ilíaca', unit: 'mm', min: 1, max: 100 },
  skinfold_supraspinale_mm: { label: 'Supraespinal', unit: 'mm', min: 1, max: 100 },
  skinfold_abdominal_mm: { label: 'Abdominal', unit: 'mm', min: 1, max: 120 },
  skinfold_front_thigh_mm: { label: 'Muslo frontal', unit: 'mm', min: 1, max: 120 },
  skinfold_medial_calf_mm: { label: 'Pantorrilla medial', unit: 'mm', min: 1, max: 90 },
  breadth_humerus_cm: { label: 'Diámetro húmero', unit: 'cm', min: 3, max: 12 },
  breadth_femur_cm: { label: 'Diámetro fémur', unit: 'cm', min: 5, max: 16 },
};

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

function normalizeProfileCode(value) {
  return value === 'express_isak' ? 'express_isak' : 'quick';
}

function normalizeRawValues(values = {}) {
  const normalized = {};
  Object.keys(FIELD_DEFINITIONS).forEach((field) => {
    const parsed = toNumberOrNull(values[field]);
    if (parsed !== null) normalized[field] = parsed;
  });
  if (values.objective) normalized.objective = String(values.objective).trim().slice(0, 160);
  return normalized;
}

function qualityFlagsForValues(rawValues = {}) {
  const flags = [];
  Object.entries(FIELD_DEFINITIONS).forEach(([key, def]) => {
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
    profiles: PROFILE_DEFINITIONS,
    fields: FIELD_DEFINITIONS,
    treatments: await getNutritionTreatments({ clinicId, groupId }),
    latest: measurementToJson(measurements[0]),
    measurements: measurements.map(measurementToJson),
    evolution: buildEvolution(measurements),
    projection: buildProjection(measurements),
    reports: buildReports(measurements),
    meta: {
      formula_version: FORMULA_VERSION,
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
  const rawValues = normalizeRawValues(payload.raw_values || payload.values || {});
  const qualityFlags = qualityFlagsForValues(rawValues);
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

module.exports = {
  FORMULA_VERSION,
  PROFILE_DEFINITIONS,
  FIELD_DEFINITIONS,
  calculateNutritionValues,
  getPatientNutritionWorkspace,
  createNutritionMeasurement,
};
