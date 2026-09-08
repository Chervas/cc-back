'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  describeDispatchCadence,
  humanizeQueueReason,
  statusGroup,
} = require('../../services/sendQueues.service');

test('describeDispatchCadence presents batches instead of treating delay as per-message cadence', () => {
  assert.deepEqual(describeDispatchCadence({
    batch_size: 20,
    delay_ms: 8 * 60 * 60 * 1000,
    delivery_governance: {
      effective_batch_size: 5,
      effective_delay_ms: 8 * 60 * 60 * 1000,
    },
  }), {
    cadence: 'Hasta 5 mensajes por tanda · siguiente tanda tras 8 horas',
    cadence_note: 'La tanda configurada es de 20; se ha reducido temporalmente a 5 para proteger el número.',
  });
});

test('describeDispatchCadence keeps the configured batch when no safety reduction applies', () => {
  assert.deepEqual(describeDispatchCadence({
    batch_size: 20,
    delay_ms: 60 * 60 * 1000,
  }), {
    cadence: 'Hasta 20 mensajes por tanda · siguiente tanda tras 1 hora',
    cadence_note: null,
  });
});

test('manual queue pauses and technical reasons are presented in plain language', () => {
  assert.equal(statusGroup('pause_requested'), 'paused');
  assert.equal(statusGroup('paused'), 'paused');
  assert.equal(humanizeQueueReason('legacy_messaging_limit_review'), 'Detenida hasta revisar el límite de envío anterior.');
  assert.equal(humanizeQueueReason('outside_business_hours'), 'Esperando al próximo horario de atención.');
});
