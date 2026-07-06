'use strict';

const assert = require('node:assert/strict');

const {
  FORMULA_VERSION,
  FORMULA_REFERENCES,
  CALCULATION_PROFILE,
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

const maleAdultContext = {
  sex: 'hombre',
  age_years: 32,
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
    calculated_values_json: calculateNutritionValues(rawValues, 'express_isak', maleAdultContext),
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
  }, 'express_isak', maleAdultContext);

  assert.equal(FORMULA_VERSION, 'nutrition-basic-v3');
  assert.equal(
    FORMULA_REFERENCES.find((reference) => reference.key === 'waist_hip_ratio').url,
    'https://www.who.int/publications/i/item/9789241501491',
  );
  assert.equal(
    FORMULA_REFERENCES.find((reference) => reference.key === 'isak_restricted_profile').url,
    'https://www.ausport.gov.au/ais/performance-support/anthropometry',
  );
  assert.equal(
    FORMULA_REFERENCES.find((reference) => reference.key === 'kerr_ross_five_component_fractionation').url,
    'https://summit.sfu.ca/item/5139',
  );
  assert.equal(calculated.bmi, 24.7);
  assert.equal(calculated.waist_hip_ratio, 0.85);
  assert.equal(calculated.skinfold_sum_mm, 94);
  assert.equal(calculated.corrected_arm_girth_cm, 33);
  assert.equal(calculated.corrected_calf_girth_cm, 37.2);
  assert.deepEqual(calculated.body_composition, {
    method: 'Durnin-Womersley 4 skinfold body density + Siri body fat',
    sex: 'male',
    age_years: 32,
    age_band: '30-39',
    skinfold_sum_4_mm: 41,
    body_density: 1.0545,
    body_fat_percent: 19.4,
    fat_mass_kg: 15.5,
    fat_free_mass_kg: 64.5,
    input_fields: [
      'weight_kg',
      'skinfold_biceps_mm',
      'skinfold_triceps_mm',
      'skinfold_subscapular_mm',
      'skinfold_iliac_crest_mm',
    ],
    source: 'Durnin-Womersley 1974 + Siri conversion',
  });
  assert.deepEqual(calculated.somatotype, {
    endomorphy: 3.2,
    mesomorphy: 4.8,
    ectomorphy: 2,
    source: 'Heath-Carter anthropometric somatotype',
  });
  assert.equal(calculated.body_fractionation, null);

  const kerrRawValues = {
    ...baseRawValues,
    weight_kg: 80,
    waist_cm: 82,
    arm_relaxed_cm: 31,
    forearm_cm: 28,
    thigh_cm: 55,
    chest_cm: 98,
    head_cm: 56,
    sitting_height_cm: 92,
    breadth_biacromial_cm: 40,
    breadth_biiliocristal_cm: 29,
    depth_chest_ap_cm: 20,
    breadth_chest_transverse_cm: 28,
  };
  assert.deepEqual(__testing.calculateKerrRossFiveComponent(kerrRawValues, maleAdultContext), {
    method: 'Kerr-Ross five-component body mass fractionation',
    sex: 'male',
    age_years: 32,
    skin_mass_kg: 4.1,
    adipose_mass_kg: 21.2,
    muscle_mass_kg: 36.2,
    bone_mass_kg: 8.4,
    residual_mass_kg: 8.8,
    predicted_body_mass_kg: 78.8,
    prediction_error_kg: -1.2,
    prediction_error_percent: -1.5,
    predicted_to_scale_ratio: 0.985,
    skin_percent_of_body_mass: 5.2,
    adipose_percent_of_body_mass: 26.5,
    muscle_percent_of_body_mass: 45.2,
    bone_percent_of_body_mass: 10.5,
    residual_percent_of_body_mass: 11,
    phantom_z: {
      adipose: -1.31,
      head_bone: 0,
      body_bone: -0.46,
      muscle: 1.13,
      residual: 1.72,
    },
    input_fields: [
      'weight_kg',
      'stature_cm',
      'sitting_height_cm',
      'head_cm',
      'skinfold_triceps_mm',
      'skinfold_subscapular_mm',
      'skinfold_supraspinale_mm',
      'skinfold_abdominal_mm',
      'skinfold_front_thigh_mm',
      'skinfold_medial_calf_mm',
      'arm_relaxed_cm',
      'forearm_cm',
      'thigh_cm',
      'chest_cm',
      'waist_cm',
      'calf_cm',
      'breadth_biacromial_cm',
      'breadth_biiliocristal_cm',
      'breadth_humerus_cm',
      'breadth_femur_cm',
      'depth_chest_ap_cm',
      'breadth_chest_transverse_cm',
    ],
    source: 'Kerr 1988 / Ross-Kerr five-component fractionation',
  });

  assert.deepEqual(__testing.requiredFieldsForProfile('quick'), [
    'weight_kg',
    'stature_cm',
  ]);
  assert.deepEqual(__testing.missingRequiredFieldsForProfile({ weight_kg: 80 }, 'quick'), [
    {
      field: 'stature_cm',
      label: 'Estatura',
      unit: 'cm',
    },
  ]);
  assert.deepEqual(
    __testing.missingRequiredFieldsForProfile({
      weight_kg: 80,
      stature_cm: 180,
      skinfold_triceps_mm: 10,
      skinfold_subscapular_mm: 12,
      skinfold_biceps_mm: 5,
      skinfold_iliac_crest_mm: 14,
      skinfold_supraspinale_mm: 11,
      skinfold_medial_calf_mm: 8,
      arm_flexed_tensed_cm: 34,
      calf_cm: 38,
      breadth_humerus_cm: 7,
    }, 'express_isak'),
    [
      {
        field: 'breadth_femur_cm',
        label: 'Diámetro fémur',
        unit: 'cm',
      },
    ],
  );

  const first = measurementRow(1, '2026-01-01T10:00:00.000Z', {
    weight_kg: 100,
    waist_cm: 100,
  });
  const second = measurementRow(2, '2026-02-26T10:00:00.000Z', {
    weight_kg: 92,
    waist_cm: 96,
    skinfold_triceps_mm: 9,
    skinfold_subscapular_mm: 11,
    skinfold_biceps_mm: 4,
    skinfold_iliac_crest_mm: 12,
    skinfold_supraspinale_mm: 10,
    skinfold_abdominal_mm: 16,
    skinfold_front_thigh_mm: 14,
    skinfold_medial_calf_mm: 7,
  });
  const third = measurementRow(3, '2026-04-23T10:00:00.000Z', {
    weight_kg: 120,
    waist_cm: 110,
  });
  const rowsDesc = [third, second, first];

  const reports = __testing.buildReports(rowsDesc);
  const secondReport = reports.find((report) => report.measurement_id === 2);
  assert.equal(secondReport.calculation_profile.code, CALCULATION_PROFILE.code);
  assert.equal(secondReport.calculation_profile.fat_mass_model.label, 'Durnin-Womersley + Siri');
  assert.equal(secondReport.clinical_storage.public_media, false);
  assert.equal(secondReport.clinical_storage.snapshot_persisted, false);
  assert.equal(secondReport.clinical_storage.pdf_strategy, 'generated_on_demand');
  assert.equal(secondReport.clinical_storage.pdf_persisted, false);
  assert.equal(secondReport.comparison.available, true);
  assert.equal(secondReport.calculation_trace.find((item) => item.key === 'bmi').status, 'applied');
  assert.equal(secondReport.calculation_trace.find((item) => item.key === 'bmi').source_references[0].key, 'bmi');
  assert.equal(secondReport.calculation_trace.find((item) => item.key === 'waist_hip_ratio').source_references[0].key, 'waist_hip_ratio');
  assert.equal(secondReport.calculation_trace.find((item) => item.key === 'body_composition').status, 'applied');
  assert.equal(secondReport.calculation_trace.find((item) => item.key === 'body_fractionation').status, 'pending');
  assert.deepEqual(
    secondReport.calculation_trace.find((item) => item.key === 'body_fractionation').source_reference_keys,
    ['kerr_ross_five_component_fractionation'],
  );
  assert.equal(
    secondReport.calculation_trace.find((item) => item.key === 'body_fractionation').missing_input_labels.includes('Altura sentado'),
    true,
  );
  assert.deepEqual(
    secondReport.calculation_trace.find((item) => item.key === 'body_composition').source_reference_keys,
    ['durnin_womersley_body_density', 'siri_body_fat'],
  );
  assert.deepEqual(secondReport.calculation_trace.find((item) => item.key === 'body_composition').missing_input_labels, []);
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
  assert.equal(latestProjection.skinfold_sum_change_per_week_mm, -1.37);
  assert.equal(latestProjection.body_fat_change_per_week_percent, -0.16);
  assert.equal(latestProjection.projected_8_week_weight_kg, 84);
  assert.equal(latestProjection.projected_8_week_waist_cm, 92);
  assert.equal(latestProjection.projected_8_week_skinfold_sum_mm, 72);
  assert.equal(latestProjection.projected_8_week_body_fat_percent, 16.8);
  assert.deepEqual(
    latestProjection.metric_projections.map((metric) => metric.key),
    ['weight_kg', 'waist_cm', 'skinfold_sum_mm', 'body_fat_percent'],
  );

  const projectionForSecond = __testing.buildProjectionForMeasurement(rowsDesc, 2);
  assert.equal(projectionForSecond.projected_8_week_weight_kg, 84);
  assert.equal(projectionForSecond.projected_8_week_waist_cm, 92);
  assert.equal(projectionForSecond.projected_8_week_skinfold_sum_mm, 72);
  assert.equal(projectionForSecond.projected_8_week_body_fat_percent, 16.8);

  const projectionForThird = __testing.buildProjectionForMeasurement(rowsDesc, 3);
  assert.equal(projectionForThird.projected_8_week_weight_kg, 148);
  assert.equal(projectionForThird.projected_8_week_waist_cm, 124);

  const html = __testing.buildNutritionReportHtml({
    patient: { name: 'Paciente Test', clinic_name: 'Clinica Test' },
    treatment: null,
    appointment: null,
    measurement: measurementJson(second),
    previous_measurement: measurementJson(first),
    report: secondReport,
    projection: projectionForSecond,
    meta: {
      formula_version: FORMULA_VERSION,
      calculation_profile: CALCULATION_PROFILE,
      formula_references: FORMULA_REFERENCES,
      generated_at: '2026-02-26T11:00:00.000Z',
    },
  });
  const noComparisonReport = __testing.buildReportForMeasurement(
    measurementJson(second),
    null,
    undefined,
    { comparisonReason: 'comparison_disabled' },
  );
  const noComparisonHtml = __testing.buildNutritionReportHtml({
    patient: { name: 'Paciente Test', clinic_name: 'Clinica Test' },
    treatment: null,
    appointment: null,
    measurement: measurementJson(second),
    previous_measurement: null,
    report: noComparisonReport,
    projection: projectionForSecond,
    meta: {
      formula_version: FORMULA_VERSION,
      calculation_profile: CALCULATION_PROFILE,
      formula_references: FORMULA_REFERENCES,
      generated_at: '2026-02-26T11:00:00.000Z',
    },
  });
  assert.equal(noComparisonReport.comparison.available, false);
  assert.equal(noComparisonReport.comparison.reason, 'comparison_disabled');
  assert.match(noComparisonHtml, /sin comparación temporal/);
  assert.doesNotMatch(noComparisonHtml, /Comparativas principales/);
  assert.equal(
    calculateNutritionValues({
      ...baseRawValues,
      weight_kg: 80,
      waist_cm: 82,
    }, 'express_isak').body_composition,
    null,
  );
  const pendingTrace = __testing.buildCalculationTrace({
    profile_code: 'express_isak',
    raw_values: {
      ...baseRawValues,
      weight_kg: 80,
      waist_cm: 82,
    },
    calculated_values: calculateNutritionValues({
      ...baseRawValues,
      weight_kg: 80,
      waist_cm: 82,
    }, 'express_isak'),
  });
  assert.deepEqual(
    pendingTrace.find((item) => item.key === 'body_composition').missing_input_labels,
    ['Sexo del paciente', 'Edad del paciente'],
  );
  assert.equal(__testing.normalizeSexForBodyComposition('mujer'), 'female');
  assert.equal(__testing.calculateAgeYears('1994-07-06', '2026-07-05T10:00:00.000Z'), 31);
  assert.deepEqual(__testing.buildPatientFormulaContext({
    sexo: 'hombre',
    fecha_nacimiento: '1994-07-06',
    edad: 40,
  }, '2026-07-05T10:00:00.000Z'), {
    sex: 'male',
    age_years: 31,
  });
  assert.match(html, /Proyección temporal/);
  assert.match(html, /Gráficas de evolución/);
  assert.match(html, /Comparativas principales/);
  assert.match(html, /Pliegue tríceps/);
  assert.match(html, /Diámetros/);
  assert.match(html, /Distribución adiposa y muscular/);
  assert.match(html, /Actual [0-9.]+%/);
  assert.match(html, /Previo [0-9.]+%/);
  assert.match(html, /body-distribution-neutral-front|Distribución corporal/);
  assert.match(html, /Distribución corporal de grasa/);
  assert.match(html, /Somatocarta/);
  assert.match(html, /Fraccionamiento molecular/);
  assert.match(html, /Fraccionamiento tisular/);
  assert.match(html, /Índices de salud/);
  assert.match(html, /Rango orientativo/);
  assert.doesNotMatch(html, /Posición visual/);
  assert.match(html, /stroke-dasharray="5 5"/);
  assert.match(html, /Tronco<small>Previo /);
  assert.match(html, /Extremidades<small>Previo /);
  assert.doesNotMatch(html, /<strong>Previo tronco<\/strong>/);
  assert.match(html, /Peso estimado 8 semanas/);
  assert.match(html, /84 kg/);
  assert.match(html, /Suma de pliegues estimada 8 semanas/);
  assert.match(html, /Grasa estimada 8 semanas/);
  assert.match(html, /Perfil de cálculo aplicado/);
  assert.match(html, /Perfil ClinicaClick Antropometría v3/);
  assert.match(html, /Fuentes de cálculo/);
  assert.match(html, /Trazabilidad de cálculo/);
  assert.match(html, /Aplicado/);
  assert.match(html, /WHO waist circumference and waist-hip ratio report/);
  assert.match(html, /Composición corporal/);
  assert.match(html, /Grasa estimada/);
  assert.match(html, /Durnin-Womersley/);
  assert.match(html, /Siri body density conversion/);
  assert.match(html, /Cinco componentes Kerr-Ross/);
  assert.match(html, /Fraccionamiento Kerr-Ross 5 componentes/);
  assert.match(html, /Somatotipo Heath-Carter/);
  assert.match(html, /Documento clínico privado/);
  assert.match(html, /data:image\/svg\+xml;base64/);
  assert.doesNotMatch(html, /148 kg/);
  const clinicBrandHtml = __testing.buildNutritionReportHtml({
    patient: { name: 'Paciente Test', clinic_name: 'Clinica Norte', clinic_avatar_url: 'https://media.clinicaclick.com/logos/clinicas/clinica-norte.png' },
    treatment: null,
    appointment: null,
    measurement: measurementJson(second),
    previous_measurement: measurementJson(first),
    report: secondReport,
    projection: projectionForSecond,
    profile_definitions: [],
    field_definitions: {},
    meta: {
      formula_version: FORMULA_VERSION,
      calculation_profile: CALCULATION_PROFILE,
      formula_references: FORMULA_REFERENCES,
      generated_at: '2026-02-26T11:00:00.000Z',
    },
  }, { brandingMode: 'clinic' });
  assert.match(clinicBrandHtml, /Clinica Norte/);
  assert.match(clinicBrandHtml, /logos\/clinicas\/clinica-norte\.png/);
  assert.match(clinicBrandHtml, /Con la tecnología de ClinicaClick/);
  const finalHtml = __testing.buildNutritionReportHtml({
    patient: { name: 'Paciente Test', clinic_name: 'Clinica Test' },
    treatment: null,
    appointment: null,
    measurement: measurementJson(second),
    previous_measurement: measurementJson(first),
    report: secondReport,
    projection: projectionForSecond,
    meta: {
      formula_version: FORMULA_VERSION,
      calculation_profile: CALCULATION_PROFILE,
      formula_references: FORMULA_REFERENCES,
      generated_at: '2026-02-26T11:00:00.000Z',
      document_status: 'final',
    },
  });
  assert.doesNotMatch(finalHtml, /Informe final/);
  assert.doesNotMatch(finalHtml, /<dt>Estado<\/dt>/);
  assert.match(finalHtml, /Documento clínico privado/);
  assert.doesNotMatch(finalHtml, /Snapshot final privado/);
  assert.doesNotMatch(finalHtml, /nutrition-basic-v3/);
  assert.doesNotMatch(finalHtml, /PUBLIC_MEDIA/);

  const snapshotPayload = __testing.buildNutritionReportSnapshotPayload({
    patient: { id: 1, name: 'Paciente Test', clinic_id: 1, clinic_name: 'Clinica Test' },
    treatment: null,
    appointment: null,
    measurement: measurementJson(second),
    report: secondReport,
    projection: projectionForSecond,
    profile_definitions: [],
    field_definitions: {},
    meta: {
      formula_version: FORMULA_VERSION,
      calculation_profile: CALCULATION_PROFILE,
      formula_references: FORMULA_REFERENCES,
      generated_at: '2026-02-26T11:00:00.000Z',
    },
  }, html, '2026-02-26T11:00:00.000Z');
  assert.equal(snapshotPayload.snapshot.kind, 'nutrition_measurement_report');
  assert.equal(snapshotPayload.snapshot.snapshot_version, 10);
  assert.equal(snapshotPayload.snapshot.report.calculation_profile.code, CALCULATION_PROFILE.code);
  assert.equal(snapshotPayload.snapshot.measurement.id, 2);
  assert.equal(snapshotPayload.snapshot.report.measurement_id, 2);
  assert.equal(snapshotPayload.snapshot.meta.storage, 'patient_nutrition_report_snapshot');
  assert.equal(snapshotPayload.snapshot.meta.clinical_storage.sensitivity, 'clinical_private');
  assert.equal(snapshotPayload.snapshot.meta.clinical_storage.primary, 'database_snapshot');
  assert.equal(snapshotPayload.snapshot.meta.clinical_storage.snapshot_persisted, true);
  assert.equal(snapshotPayload.snapshot.meta.clinical_storage.pdf_strategy, 'generated_on_demand');
  assert.equal(snapshotPayload.snapshot.meta.clinical_storage.pdf_persisted, false);
  assert.equal(snapshotPayload.snapshot.meta.clinical_storage.public_media, false);
  assert.equal(snapshotPayload.snapshot.meta.clinical_storage.public_media_allowed, false);
  assert.equal(snapshotPayload.snapshot_hash.length, 64);

  const finalStorage = __testing.buildClinicalStoragePolicy({
    storageStrategy: 'final_json_snapshot_printable_on_demand',
    status: 'final',
  });
  assert.equal(finalStorage.document_status, 'final');
  assert.equal(finalStorage.label, 'Informe clínico cerrado');
  assert.equal(finalStorage.private_binary_storage, 'pending');
  assert.doesNotMatch(finalStorage.detail, /Snapshot|PUBLIC_MEDIA/);

  const finalStorageWithPdf = __testing.buildClinicalStoragePolicy({
    storageStrategy: 'final_json_snapshot_printable_on_demand',
    status: 'final',
    pdfPersisted: true,
    pdfAssetId: 42,
  });
  assert.equal(finalStorageWithPdf.pdf_strategy, 'private_asset_cached');
  assert.equal(finalStorageWithPdf.pdf_persisted, true);
  assert.equal(finalStorageWithPdf.pdf_asset_id, 42);
  assert.equal(finalStorageWithPdf.private_binary_storage, 'clinical_private_asset');
  assert.match(finalStorageWithPdf.detail, /archivo clínico privado/);
  assert.doesNotMatch(finalStorageWithPdf.detail, /Snapshot|PUBLIC_MEDIA/);
  assert.equal(
    __testing.displayNutritionText('Estudio antropométrico ISAK'),
    'Estudio antropométrico completo',
  );
  assert.equal(
    __testing.nutritionReportSnapshotToJson({
      id: 99,
      measurement_id: 2,
      patient_id: 1,
      clinic_id: 1,
      report_type: 'express_isak',
      title: 'Informe antropometría ISAK',
      status: 'final',
      snapshot_hash: 'abc',
      storage_strategy: 'final_json_snapshot_printable_on_demand',
    }).title,
    'Informe de antropometría completa',
  );

  console.log('nutrition_workspace.test ok');
}

run();
