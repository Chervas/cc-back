'use strict';

const assert = require('node:assert/strict');

const {
  VERSION,
  FALLBACK_CODE,
  getBaseContractForArea,
  normalizeContractPayload,
} = require('../../services/medicalAreaContracts.service');

function valuesOf(options) {
  return options.map((option) => option.value);
}

function byValue(options) {
  return new Map(options.map((option) => [option.value, option]));
}

function assertNutritionContract(contract) {
  assert.equal(contract.code, 'nutricion');
  assert.equal(contract.profile.supportsPiece, false);
  assert.equal(contract.profile.supportsLaboratory, false);
  assert.deepEqual(valuesOf(contract.nutrition_measurement_profile_options), [
    'none',
    'quick',
    'express_isak',
  ]);
  assert.equal(contract.nutrition_measurement_fields.weight_kg.label, 'Peso');
  assert.equal(contract.nutrition_measurement_fields.skinfold_triceps_mm.unit, 'mm');
  assert.equal(contract.nutrition_measurement_fields.arm_span_cm.unit, 'cm');
  assert.equal(contract.nutrition_measurement_fields.breadth_wrist_bistyloid_cm.label, 'Diámetro biestiloideo');

  const profileSchemas = new Map(contract.nutrition_measurement_profile_schemas.map((profile) => [profile.code, profile]));
  assert.deepEqual(profileSchemas.get('quick')?.groups?.[0]?.fields, [
    'weight_kg',
    'stature_cm',
    'waist_cm',
    'hip_cm',
    'arm_relaxed_cm',
    'calf_cm',
  ]);
  assert.deepEqual(profileSchemas.get('quick')?.groups?.[0]?.required_fields, [
    'weight_kg',
    'stature_cm',
  ]);
  assert.equal(
    profileSchemas.get('express_isak')?.groups?.some((group) => group.key === 'skinfolds' && group.fields.includes('skinfold_medial_calf_mm')),
    true,
  );
  assert.equal(
    profileSchemas.get('express_isak')?.groups?.some((group) => group.key === 'breadths' && group.fields.includes('breadth_biacromial_cm')),
    true,
  );
  assert.equal(
    profileSchemas.get('express_isak')?.groups?.some((group) => group.key === 'base' && group.fields.includes('sitting_height_cm')),
    true,
  );
  assert.equal(
    profileSchemas.get('express_isak')?.groups?.some((group) => group.key === 'base' && group.fields.includes('arm_span_cm')),
    true,
  );
  assert.equal(
    profileSchemas.get('express_isak')?.groups?.some((group) => group.key === 'breadths' && group.fields.includes('breadth_wrist_bistyloid_cm')),
    true,
  );
  assert.deepEqual(
    profileSchemas.get('express_isak')?.groups?.find((group) => group.key === 'base')?.required_fields,
    ['weight_kg', 'stature_cm'],
  );
  assert.deepEqual(
    profileSchemas.get('express_isak')?.groups?.find((group) => group.key === 'skinfolds')?.required_fields,
    [
      'skinfold_triceps_mm',
      'skinfold_subscapular_mm',
      'skinfold_biceps_mm',
      'skinfold_iliac_crest_mm',
      'skinfold_supraspinale_mm',
      'skinfold_medial_calf_mm',
    ],
  );

  const serviceKinds = byValue(contract.nutrition_service_kind_options);
  assert.equal(serviceKinds.get('consultation')?.recommendedProfile, 'none');
  assert.equal(serviceKinds.get('consultation')?.recommendedName, 'Consulta nutricional');
  assert.equal(serviceKinds.get('consultation')?.defaultGenerateReport, false);
  assert.equal(serviceKinds.get('consultation')?.defaultComparePrevious, false);
  assert.equal(serviceKinds.get('follow_up')?.recommendedProfile, 'quick');
  assert.equal(serviceKinds.get('follow_up')?.defaultCategory, 'Nutrición clínica');
  assert.equal(serviceKinds.get('quick_measurement')?.recommendedProfile, 'quick');
  assert.equal(serviceKinds.get('isak_study')?.recommendedProfile, 'express_isak');
  assert.equal(serviceKinds.get('isak_study')?.recommendedName, 'Estudio antropométrico completo');
  assert.equal(serviceKinds.get('isak_study')?.defaultCategory, 'Antropometría avanzada');
  assert.equal(serviceKinds.get('isak_study')?.defaultGenerateReport, true);
  assert.equal(serviceKinds.get('nutrition_plan_pack')?.recommendedProfile, 'quick');
  assert.equal(serviceKinds.get('nutrition_plan_pack')?.defaultSessions, 4);

  assert.equal(contract.patient_workspace.enabled, true);
  assert.equal(contract.patient_workspace.route, 'nutricion');
  assert.equal(contract.patient_workspace.labelKey, 'patients.detail.tabs.nutrition');

  assert.equal(contract.appointment_action.enabled, true);
  assert.equal(contract.appointment_action.route, 'nutricion');
  assert.equal(contract.appointment_action.label, 'Registrar medici\u00f3n');
  assert.equal(contract.appointment_action.compareLabel, 'Registrar y comparar');
  assert.equal(contract.appointment_action.requiresProfile, true);
  assert.equal(contract.appointment_action.profileDetails.quick.includes('peso'), true);
  assert.equal(contract.appointment_action.profileDetails.express_isak.includes('somatotipo'), true);

  assert.equal(contract.protocol_rules.length >= 3, true);
  assert.equal(contract.protocol_rules.some((rule) => rule.code === 'nutrition-measurement-before-report' && rule.action === 'block'), true);
  assert.equal(contract.protocol_rules.some((rule) => rule.source_type === 'measurement' && rule.target_type === 'document'), true);
  assert.equal(contract.protocol_rules.every((rule) => typeof rule.enabled === 'boolean'), true);

  assert.equal(contract.setup_steps.some((step) => step.section === 'nutrition'), true);
  assert.equal(
    contract.contract_sections.some((section) => section.chips.includes('Express')),
    true,
  );
}

function run() {
  const nutrition = getBaseContractForArea('nutricion');
  assertNutritionContract(nutrition);
  assert.equal(nutrition.service_examples.includes('Valoraci\u00f3n nutricional'), true);
  assert.equal(nutrition.service_examples.includes('Plan de seguimiento mensual'), true);

  const normalized = normalizeContractPayload('nutricion', {
    service_examples: ['Consulta nutricional personalizada'],
    patient_workspace: { enabled: true, route: 'nutricion' },
    appointment_action: { enabled: true, route: 'nutricion' },
    nutrition_service_kind_options: [
      {
        value: 'isak_study',
        label: 'Perfil completo custom',
        hint: 'Custom sin defaults',
        recommendedProfile: 'express_isak',
      },
    ],
  });
  assertNutritionContract(normalized);
  assert.equal(normalized.service_examples.includes('Consulta nutricional personalizada'), true);
  assert.equal(normalized.service_examples.includes('Valoraci\u00f3n nutricional'), true);
  assert.equal(
    byValue(normalized.nutrition_service_kind_options).get('isak_study')?.recommendedName,
    'Estudio antropom\u00e9trico completo',
  );
  assert.equal(normalized.protocol_rules.some((rule) => rule.code === 'nutrition-follow-up-after-measurement'), true);

  const normalizedProtocolOverride = normalizeContractPayload('nutricion', {
    protocol_rules: [
      {
        code: 'custom follow up',
        title: 'Regla editable',
        description: 'Permite configurar un recordatorio clínico',
        source_type: 'invalid',
        target_type: 'appointment',
        wait_min_value: -5,
        wait_min_unit: 'weeks',
        condition: 'Cuando exista medición',
        action: 'allow_override_with_reason',
        scope: 'clinic',
        enabled: false,
      },
    ],
  });
  assert.deepEqual(normalizedProtocolOverride.protocol_rules, [
    {
      code: 'custom_follow_up',
      title: 'Regla editable',
      description: 'Permite configurar un recordatorio clínico',
      source_type: 'measurement',
      source_ref: null,
      target_type: 'appointment',
      target_ref: null,
      wait_min_value: 0,
      wait_min_unit: 'weeks',
      condition: 'Cuando exista medición',
      action: 'allow_override_with_reason',
      scope: 'clinic',
      enabled: false,
    },
  ]);

  const normalizedWithRemovedRequired = normalizeContractPayload('nutricion', {
    nutrition_measurement_profile_schemas: [
      {
        code: 'quick',
        name: 'Perfil rápido custom',
        description: 'Intento de quitar peso',
        groups: [
          {
            key: 'base',
            label: 'Datos base',
            fields: ['waist_cm'],
          },
        ],
      },
      {
        code: 'express_isak',
        name: 'Perfil Completa custom',
        description: 'Intento de quitar pliegues',
        groups: [
          {
            key: 'base',
            label: 'Datos base',
            fields: ['stature_cm'],
          },
          {
            key: 'skinfolds',
            label: 'Pliegues',
            fields: ['skinfold_biceps_mm'],
          },
          {
            key: 'girths',
            label: 'Perímetros',
            fields: ['waist_cm'],
          },
        ],
      },
    ],
  });
  const guardedSchemas = new Map(normalizedWithRemovedRequired.nutrition_measurement_profile_schemas.map((profile) => [profile.code, profile]));
  assert.deepEqual(guardedSchemas.get('express_isak').groups.map((group) => group.key), [
    'base',
    'skinfolds',
    'girths',
    'breadths',
  ]);
  assert.deepEqual(guardedSchemas.get('quick').groups[0].required_fields, ['weight_kg', 'stature_cm']);
  assert.equal(guardedSchemas.get('quick').groups[0].fields.includes('weight_kg'), true);
  assert.equal(guardedSchemas.get('quick').groups[0].fields.includes('stature_cm'), true);
  assert.equal(
    guardedSchemas.get('express_isak').groups.find((group) => group.key === 'skinfolds').fields.includes('skinfold_triceps_mm'),
    true,
  );
  assert.equal(
    guardedSchemas.get('express_isak').groups.find((group) => group.key === 'breadths').fields.includes('breadth_humerus_cm'),
    true,
  );
  assert.equal(
    guardedSchemas.get('express_isak').groups.find((group) => group.key === 'breadths').fields.includes('breadth_wrist_bistyloid_cm'),
    true,
  );

  const dental = getBaseContractForArea('dental');
  assert.equal(dental.patient_workspace.enabled, false);
  assert.equal(dental.appointment_action.enabled, false);
  assert.equal(dental.protocol_rules.some((rule) => rule.code === 'dental-lab-before-prosthesis'), true);
  assert.deepEqual(dental.nutrition_measurement_profile_options, []);

  const unknown = getBaseContractForArea('area-inexistente');
  assert.equal(unknown.code, 'area-inexistente');
  assert.equal(unknown.profile.label, getBaseContractForArea(FALLBACK_CODE).profile.label);
  assert.deepEqual(unknown.nutrition_service_kind_options, []);

  assert.equal(VERSION, 'medical-area-contracts-v1');
  console.log('medical_area_contracts.test ok');
}

run();
