#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const migration = require('../../../migrations/20260721101000-add-wait-response-before-confirm-ai');

const {
  MIGRATION_KEY,
  WAIT_TIMEOUT_DURATION,
  WAIT_TIMEOUT_UNIT,
  addWaitResponseBeforeConfirmAppointmentAi,
  hasMigrationWaitResponse,
} = migration.__test;

function ids(nodes) {
  return nodes.map((node) => node.id);
}

test('inserta wait_response entre join e IA de confirmación', () => {
  const nodes = [
    { id: 'N1', type: 'trigger/appointment_reminder_window', outputs: { on_success: 'N6' }, position: { x: 100, y: 100 } },
    { id: 'N6', type: 'condition/field_check', outputs: { on_true: 'N7', on_false: 'N2' }, position: { x: 100, y: 220 } },
    { id: 'N2', type: 'action/send_whatsapp', outputs: { on_success: 'N8', on_fail: null }, position: { x: 300, y: 340 } },
    { id: 'N7', type: 'action/send_whatsapp', outputs: { on_success: 'N8', on_fail: null }, position: { x: -100, y: 340 } },
    { id: 'N8', type: 'control/join', outputs: { on_joined: 'N3' }, position: { x: 100, y: 460 } },
    {
      id: 'N3',
      type: 'condition/ai_analysis',
      config: { preset_key: 'confirm_appointment' },
      outputs: { on_success: 'N4', on_fail: 'N5' },
      position: { x: 100, y: 620 },
    },
    { id: 'N4', type: 'action/send_whatsapp', outputs: { on_success: null, on_fail: null }, position: { x: -40, y: 780 } },
    { id: 'N5', type: 'action/send_system_notification', outputs: { on_success: null, on_fail: null }, position: { x: 240, y: 780 } },
  ];

  const result = addWaitResponseBeforeConfirmAppointmentAi(nodes);
  assert.equal(result.changed, true);
  assert.equal(result.inserted, 1);
  assert.deepEqual(ids(result.nodes), ['N1', 'N6', 'N2', 'N7', 'N8', 'N3', 'N4', 'N5', 'N9']);

  const join = result.nodes.find((node) => node.id === 'N8');
  const wait = result.nodes.find((node) => node.id === 'N9');
  const ai = result.nodes.find((node) => node.id === 'N3');

  assert.equal(join.outputs.on_joined, wait.id);
  assert.equal(wait.type, 'delay/wait_response');
  assert.equal(wait.config.migration_key, MIGRATION_KEY);
  assert.equal(wait.config.timeout_duration, WAIT_TIMEOUT_DURATION);
  assert.equal(wait.config.timeout_unit, WAIT_TIMEOUT_UNIT);
  assert.equal(wait.config.listens_to_node_id, 'N8');
  assert.equal(wait.outputs.on_response, ai.id);
  assert.equal(wait.outputs.on_timeout, null);
  assert.equal(hasMigrationWaitResponse(result.nodes), true);
});

test('inserta wait_response directo tras send_whatsapp si la IA estaba pegada al envío', () => {
  const nodes = [
    { id: 'N1', type: 'trigger/appointment_created', outputs: { on_success: 'N2' } },
    { id: 'N2', type: 'action/send_whatsapp', outputs: { on_success: 'N3', on_fail: null } },
    {
      id: 'N3',
      type: 'condition/ai_analysis',
      config: { preset_key: 'confirm_appointment' },
      outputs: { on_success: 'N4', on_fail: null },
    },
    { id: 'N4', type: 'action/change_status', outputs: { on_success: null, on_fail: null } },
  ];

  const result = addWaitResponseBeforeConfirmAppointmentAi(nodes);
  const send = result.nodes.find((node) => node.id === 'N2');
  const wait = result.nodes.find((node) => node.type === 'delay/wait_response');

  assert.equal(result.changed, true);
  assert.equal(send.outputs.on_success, wait.id);
  assert.equal(wait.config.listens_to_node_id, 'N2');
  assert.equal(wait.outputs.on_response, 'N3');
});

test('no cambia flujos donde confirm_appointment ya viene de wait_response', () => {
  const nodes = [
    { id: 'N1', type: 'trigger/appointment_created', outputs: { on_success: 'N2' } },
    { id: 'N2', type: 'action/send_whatsapp', outputs: { on_success: 'N3', on_fail: null } },
    {
      id: 'N3',
      type: 'delay/wait_response',
      config: { timeout_duration: 40, timeout_unit: 'minutes', listens_to_node_id: 'N2' },
      outputs: { on_response: 'N4', on_timeout: null },
    },
    {
      id: 'N4',
      type: 'condition/ai_analysis',
      config: { preset_key: 'confirm_appointment' },
      outputs: { on_success: 'N5', on_fail: null },
    },
    { id: 'N5', type: 'action/change_status', outputs: { on_success: null, on_fail: null } },
  ];

  const result = addWaitResponseBeforeConfirmAppointmentAi(nodes);
  assert.equal(result.changed, false);
  assert.equal(result.nodes, nodes);
});

