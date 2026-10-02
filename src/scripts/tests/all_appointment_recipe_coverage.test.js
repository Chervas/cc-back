'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { nativeReference, configurationSignature, contextualConfirmationStates } = require('../qa/prepare-all-appointment-recipes');

test('a native wait may listen to the event after the actual WhatsApp send', () => {
  const send = { id: 'SEND', type: 'action/send_whatsapp', outputs: { on_success: 'EVENT' } };
  const wait = { id: 'WAIT', type: 'delay/wait_response', config: { listens_to_node_id: 'EVENT' },
    outputs: { on_response: 'AI' } };
  const nodes = [send, { id: 'EVENT', type: 'action/send_system_notification', outputs: { on_success: 'WAIT' } },
    wait, { id: 'AI', type: 'condition/ai_analysis' }];
  assert.deepEqual(nativeReference(nodes, 'AI'), { wait, send });
  assert.deepEqual(nativeReference(nodes, 'UNCLAIMED'), {});
});

test('coverage signatures distinguish changed references and decision branches', () => {
  const node = { id: 'AI', type: 'condition/ai_analysis', config: { preset_key: 'classify_intent' },
    outputs: { on_success: 'COMPARE' } };
  const row = { nodes: [node, { id: 'COMPARE', type: 'condition/field_check', config: { mode: 'multi_branch' } }] };
  const signature = configurationSignature(row, node, { text: 'Confirm attendance' });
  assert.notEqual(signature, configurationSignature(row, node, { text: 'Do you know the way?' }));
  row.nodes[1].config.mode = 'simple';
  assert.notEqual(signature, configurationSignature(row, node, { text: 'Confirm attendance' }));
});

test('QA acknowledgement expectations distinguish information receipt from attendance', () => {
  assert.deepEqual(contextualConfirmationStates({ name: 'Envío de datos de la cita tras agendar' },
    { id: 'N14', config: { preset_key: 'confirm_appointment' } }), []);
  for (const name of ['Envío de datos de la cita tras agendar', 'Envío de datos de la cita tras reprogramar']) {
    for (const id of ['N18', 'N24', 'N28']) {
      assert.deepEqual(contextualConfirmationStates({ name },
        { id, config: { preset_key: 'confirm_appointment' } }), ['recordatorio_confirmado']);
    }
  }
  const node = { id: 'AI', config: { preset_key: 'classify_intent' } };
  assert.deepEqual(contextualConfirmationStates({ name: 'Recordatorio y confirmación día de antes' }, node),
    ['recordatorio_confirmado']);
  assert.deepEqual(contextualConfirmationStates({ name: 'Recordatorio mismo día a las 8 ¿Sabes llegar?' }, node), []);
  assert.deepEqual(contextualConfirmationStates({ name: 'Gestionar mensajes fuera de horario' }, node), []);
});
