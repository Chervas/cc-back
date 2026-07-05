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
  assert.equal(serviceKinds.get('follow_up')?.recommendedProfile, 'quick');
  assert.equal(serviceKinds.get('quick_measurement')?.recommendedProfile, 'quick');
  assert.equal(serviceKinds.get('isak_study')?.recommendedProfile, 'express_isak');
  assert.equal(serviceKinds.get('nutrition_plan_pack')?.recommendedProfile, 'quick');

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

  assert.equal(contract.setup_steps.some((step) => step.section === 'nutrition'), true);
  assert.equal(
    contract.contract_sections.some((section) => section.chips.includes('Perfil r\u00e1pido')),
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
  });
  assertNutritionContract(normalized);
  assert.equal(normalized.service_examples.includes('Consulta nutricional personalizada'), true);
  assert.equal(normalized.service_examples.includes('Valoraci\u00f3n nutricional'), true);

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
        name: 'Perfil express custom',
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

  const dental = getBaseContractForArea('dental');
  assert.equal(dental.patient_workspace.enabled, false);
  assert.equal(dental.appointment_action.enabled, false);
  assert.deepEqual(dental.nutrition_measurement_profile_options, []);

  const unknown = getBaseContractForArea('area-inexistente');
  assert.equal(unknown.code, 'area-inexistente');
  assert.equal(unknown.profile.label, getBaseContractForArea(FALLBACK_CODE).profile.label);
  assert.deepEqual(unknown.nutrition_service_kind_options, []);

  assert.equal(VERSION, 'medical-area-contracts-v1');
  console.log('medical_area_contracts.test ok');
}

run();
