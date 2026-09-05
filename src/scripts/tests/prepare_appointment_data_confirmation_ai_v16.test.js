#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const migration = require('../../../migrations/20260904162000-prepare-appointment-data-confirmation-ai-v16');

const oldConfig = {
  preset_key: 'confirm_appointment',
  instruction: 'Contrato histórico',
  context_sources: [{ key: 'conversation_today', path: '{{conversation_today}}' }],
  output_fields: [{ name: 'decision', type: 'string', description: 'Histórico' }],
  mode: 'auto',
  max_tokens: 700,
};

const aiNodes = Array.from(migration._test.AI_NODE_IDS).map((id, index) => ({
  id,
  type: 'condition/ai_analysis',
  position: { x: 100, y: 400 + index * 100 },
  config: { ...oldConfig },
  outputs: { on_success: `S${index}`, on_fail: `F${index}` },
}));
const fillerNodes = Array.from({ length: 35 }, (_, index) => ({
  id: `X${index + 1}`,
  type: index === 0 ? 'trigger/appointment_created' : 'action/send_whatsapp',
  position: { x: 100, y: index * 100 },
  config: {},
  outputs: { on_success: null },
}));

const prepared = migration._test.prepareNodes([...fillerNodes, ...aiNodes]);
assert.equal(prepared.length, 41);
for (const id of migration._test.AI_NODE_IDS) {
  const node = prepared.find((item) => item.id === id);
  assert.equal(node.config.preset_key, 'confirm_appointment');
  assert.equal(node.config.preset_contract_version, 2);
  assert.equal(node.config.routing_pending_review, true);
  assert.deepEqual(
    node.config.output_fields.map((field) => field.name),
    ['confirma_asistencia', 'requiere_respuesta', 'motivo'],
  );
  assert.equal(node.config.output_fields.every((field) => field.include_confidence), true);
  assert.equal(node.config.context_sources[0].key, 'patient_message_batch');
  assert.deepEqual(
    node.config.context_sources.map((source) => source.key),
    ['patient_message_batch', 'appointment', 'trigger'],
  );
  assert.equal(node.outputs.on_success.startsWith('S'), true);
  assert.equal(node.outputs.on_fail.startsWith('F'), true);
}
assert.equal(
  prepared.filter((node) => node.config?.preset_contract_version === 2).length,
  6,
);

const source = {
  public_id: migration._test.TARGET_PUBLIC_ID,
  version: migration._test.SOURCE_VERSION,
  is_active: 0,
  published_at: new Date(),
  template_key: 'env_o_de_datos_de_la_cita_tras_agendar',
  trigger_type: 'appointment_created',
  nodes: [...fillerNodes, ...aiNodes],
};
assert.doesNotThrow(() => migration._test.validateSource(source));

console.log('Appointment data confirmation AI v16 migration contract: ok');
