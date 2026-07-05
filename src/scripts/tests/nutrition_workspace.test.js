'use strict';

const assert = require('node:assert/strict');

const {
  FORMULA_VERSION,
  FORMULA_REFERENCES,
  calculateNutritionValues,
  __testing,
} = require('../../services/nutritionWorkspace.service');

const baseRawValues = {
  stature_cm: 180,
  hip_cm: 96,
  arm_flexed_tensed_cm: 34,
  calf_cm: 38,
  skinfold_triceps_mm: 10,
  skinfold_subscapular_mm: 12,
  skinfold_biceps_mm: 5,
  skinfold_iliac_crest_mm: 14,
  skinfold_supraspinale_mm: 11,
  skinfold_abdominal_mm: 18,
  skinfold_front_thigh_mm: 16,
  skinfold_medial_calf_mm: 8,
  breadth_humerus_cm: 7,
  breadth_femur_cm: 9.5,
};

function measurementRow(id, measuredAt, values) {
  const rawValues = {
    ...baseRawValues,
    ...values,
  };
  return {
    id,
    patient_id: 1,
    clinic_id: 1,
    profile_code: 'express_isak',
    measured_at: measuredAt,
    raw_values_json: rawValues,
    calculated_values_json: calculateNutritionValues(rawValues, 'express_isak'),
    formula_version: FORMULA_VERSION,
    quality_flags_json: [],
    notes: '',
    created_at: measuredAt,
    updated_at: measuredAt,
  };
}

function measurementJson(row) {
  return {
    id: row.id,
    patient_id: row.patient_id,
    clinic_id: row.clinic_id,
    profile_code: row.profile_code,
    measured_at: row.measured_at,
    raw_values: row.raw_values_json,
    calculated_values: row.calculated_values_json,
    formula_version: row.formula_version,
    quality_flags: row.quality_flags_json,
    notes: row.notes,
  };
}

function run() {
  const calculated = calculateNutritionValues({
    ...baseRawValues,
    weight_kg: 80,
    waist_cm: 82,
  }, 'express_isak');

  assert.equal(calculated.bmi, 24.7);
  assert.equal(calculated.waist_hip_ratio, 0.85);
  assert.equal(calculated.skinfold_sum_mm, 94);
  assert.equal(calculated.corrected_arm_girth_cm, 33);
  assert.equal(calculated.corrected_calf_girth_cm, 37.2);
  assert.deepEqual(calculated.somatotype, {
    endomorphy: 3.2,
    mesomorphy: 4.8,
    ectomorphy: 2,
    source: 'Heath-Carter anthropometric somatotype',
  });

  const first = measurementRow(1, '2026-01-01T10:00:00.000Z', {
    weight_kg: 100,
    waist_cm: 100,
  });
  const second = measurementRow(2, '2026-02-26T10:00:00.000Z', {
    weight_kg: 92,
    waist_cm: 96,
  });
  const third = measurementRow(3, '2026-04-23T10:00:00.000Z', {
    weight_kg: 120,
    waist_cm: 110,
  });
  const rowsDesc = [third, second, first];

  const reports = __testing.buildReports(rowsDesc);
  const secondReport = reports.find((report) => report.measurement_id === 2);
  assert.equal(secondReport.comparison.available, true);
  assert.equal(secondReport.comparison.previous_measurement_id, 1);
  assert.equal(secondReport.comparison.days_between, 56);
  assert.equal(
    secondReport.comparison.metrics.find((metric) => metric.key === 'weight_kg').delta,
    -8,
  );
  assert.equal(
    secondReport.comparison.metrics.find((metric) => metric.key === 'waist_cm').delta,
    -4,
  );

  const latestProjection = __testing.buildProjection([second, first]);
  assert.equal(latestProjection.available, true);
  assert.equal(latestProjection.observed_weeks, 8);
  assert.equal(latestProjection.weight_change_per_week_kg, -1);
  assert.equal(latestProjection.waist_change_per_week_cm, -0.5);
  assert.equal(latestProjection.projected_8_week_weight_kg, 84);
  assert.equal(latestProjection.projected_8_week_waist_cm, 92);

  const projectionForSecond = __testing.buildProjectionForMeasurement(rowsDesc, 2);
  assert.equal(projectionForSecond.projected_8_week_weight_kg, 84);
  assert.equal(projectionForSecond.projected_8_week_waist_cm, 92);

  const projectionForThird = __testing.buildProjectionForMeasurement(rowsDesc, 3);
  assert.equal(projectionForThird.projected_8_week_weight_kg, 148);
  assert.equal(projectionForThird.projected_8_week_waist_cm, 124);

  const html = __testing.buildNutritionReportHtml({
    patient: { name: 'Paciente Test', clinic_name: 'Clinica Test' },
    treatment: null,
    appointment: null,
    measurement: measurementJson(second),
    report: secondReport,
    projection: projectionForSecond,
    meta: {
      formula_version: FORMULA_VERSION,
      formula_references: FORMULA_REFERENCES,
      generated_at: '2026-02-26T11:00:00.000Z',
    },
  });
  assert.match(html, /Proyección temporal/);
  assert.match(html, /Peso estimado 8 semanas/);
  assert.match(html, /84 kg/);
  assert.match(html, /Bases de cálculo/);
  assert.match(html, /Somatotipo Heath-Carter/);
  assert.doesNotMatch(html, /148 kg/);

  console.log('nutrition_workspace.test ok');
}

run();
