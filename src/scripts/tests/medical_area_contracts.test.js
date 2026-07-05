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

  const normalized = normalizeContractPayload('nutricion', {
    service_examples: ['Consulta nutricional personalizada'],
    patient_workspace: { enabled: true, route: 'nutricion' },
    appointment_action: { enabled: true, route: 'nutricion' },
  });
  assertNutritionContract(normalized);
  assert.deepEqual(normalized.service_examples, ['Consulta nutricional personalizada']);

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
