#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const migration = require('../../../migrations/20260912152000-refresh-appointment-ai-recipes');
const {
  CLASSIFY_INTENT_PRESET_CONFIG,
  CONFIRM_APPOINTMENT_PRESET_CONFIG,
} = require('../../lib/automation-intent-contract');

const { refreshNode, refreshNodes } = migration._test;

const structuredConfirmation = {
  id: 'N18',
  type: 'condition/ai_analysis',
  position: { x: 120, y: 300 },
  config: {
    preset_key: 'confirm_appointment',
    preset_contract_version: 2,
    mode: 'auto',
    max_tokens: 650,
    migration_key: 'keep_me',
    instruction: 'Old instruction with an unsafe concrete example.',
    context_sources: [{ key: 'patient_message_batch', path: '{{last_response_context}}' }],
    output_fields: [
      { name: 'confirma_asistencia', type: 'boolean' },
      { name: 'requiere_respuesta', type: 'boolean' },
      { name: 'motivo', type: 'string' },
    ],
  },
  outputs: { on_success: 'N19', on_fail: 'N20' },
};

const refreshedConfirmation = refreshNode(structuredConfirmation);
assert.equal(refreshedConfirmation.config.preset_contract_version, 3);
assert.equal(refreshedConfirmation.config.instruction, CONFIRM_APPOINTMENT_PRESET_CONFIG.instruction);
assert.equal(refreshedConfirmation.config.max_tokens, 650);
assert.equal(refreshedConfirmation.config.migration_key, 'keep_me');
assert.deepEqual(refreshedConfirmation.position, structuredConfirmation.position);
assert.deepEqual(refreshedConfirmation.outputs, structuredConfirmation.outputs);

const legacyConfirmation = {
  ...structuredConfirmation,
  id: 'N4',
  config: {
    preset_key: 'confirm_appointment',
    instruction: 'Legacy binary contract',
    output_fields: [
      { name: 'decision', type: 'string' },
      { name: 'confianza', type: 'number' },
      { name: 'motivo', type: 'string' },
    ],
  },
};
assert.equal(refreshNode(legacyConfirmation), legacyConfirmation);

const classifyIntent = {
  id: 'N3',
  type: 'condition/ai_analysis',
  position: { x: 420, y: 500 },
  config: {
    preset_key: 'classify_intent',
    instruction: 'Old classify instruction',
    mode: 'auto',
    custom_setting: 'keep_me_too',
    context_sources: [{ key: 'legacy', path: '{{legacy}}' }],
    output_fields: [
      { name: 'intencion_principal', type: 'string', description: 'Old description' },
      { name: 'accion_inequivoca', type: 'boolean', description: 'Legacy-only field' },
      { name: 'necesita_respuesta', type: 'boolean', description: 'Old description' },
    ],
  },
  outputs: { on_success: 'N4', on_fail: 'N5' },
};

const refreshedClassify = refreshNode(classifyIntent);
assert.equal(refreshedClassify.config.instruction, CLASSIFY_INTENT_PRESET_CONFIG.instruction);
assert.deepEqual(refreshedClassify.config.context_sources, CLASSIFY_INTENT_PRESET_CONFIG.context_sources);
assert.equal(refreshedClassify.config.custom_setting, 'keep_me_too');
assert.deepEqual(
  refreshedClassify.config.output_fields.map((field) => field.name),
  ['intencion_principal', 'accion_inequivoca', 'necesita_respuesta'],
);
assert.equal(
  refreshedClassify.config.output_fields[1].description,
  'Legacy-only field',
);
assert.equal(
  refreshedClassify.config.output_fields[2].description,
  CLASSIFY_INTENT_PRESET_CONFIG.output_fields
    .find((field) => field.name === 'necesita_respuesta').description,
);
assert.deepEqual(refreshedClassify.position, classifyIntent.position);
assert.deepEqual(refreshedClassify.outputs, classifyIntent.outputs);

const result = refreshNodes([structuredConfirmation, legacyConfirmation, classifyIntent]);
assert.equal(result.changed, true);
assert.equal(result.nodes.length, 3);
assert.equal(result.nodes[1], legacyConfirmation);

console.log('Appointment AI recipe migration: ok');
process.exit(0);
