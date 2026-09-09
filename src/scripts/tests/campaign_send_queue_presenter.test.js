'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  describeDispatchCadence,
  humanizeQueueReason,
  marketingQueuePresentation,
  statusGroup,
  statusPresentation,
  summarizeLeadBackfillQueue,
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

test('delivery verification explains that WhatsApp accepted the messages', () => {
  assert.deepEqual(statusPresentation('awaiting_delivery'), {
    label: 'Esperando confirmación de WhatsApp',
    explanation: 'WhatsApp ha aceptado los mensajes. Clinicaclick espera sus confirmaciones de entrega o error antes de cerrar la cola.',
  });
});

test('review and mass-send queues expose their type and canonical configuration destination', () => {
  assert.deepEqual(marketingQueuePresentation({
    objective_id: 'mass_sends',
    name: 'Solicitud de reseña · septiembre',
    criteria: { review_request: true },
  }, {}), {
    type: 'review_request',
    type_label: 'Solicitud de reseña',
    configuration_url: '/marketing/objetivos?objective=get_reviews',
    configuration_label: 'Abrir reseñas',
  });

  assert.deepEqual(marketingQueuePresentation({
    objective_id: 'mass_sends',
    name: 'Campaña de seguimiento',
    criteria: { review_request: false },
  }, {}), {
    type: 'mass_send',
    type_label: 'Envío masivo',
    configuration_url: '/marketing/objetivos?objective=mass_sends&mass_send_view=campaigns',
    configuration_label: 'Abrir envíos masivos',
  });
});

test('lead queues distinguish candidates skipped before enqueue from actual scheduled sends', () => {
  const summary = summarizeLeadBackfillQueue({
    summary: { total: 8, queued: 3, skipped: 5 },
    related: [
      { id: 1, status: 'waiting', wait_until: '2026-09-09T08:00:00.000Z', context: { outputs: {} } },
      { id: 2, status: 'waiting', wait_until: '2026-09-09T08:30:00.000Z', context: { outputs: {} } },
      { id: 3, status: 'waiting', wait_until: '2026-09-09T09:00:00.000Z', context: { outputs: {} } },
    ],
    jobStatus: 'completed',
    now: new Date('2026-09-09T07:00:00.000Z'),
  });

  assert.equal(summary.candidateTotal, 8);
  assert.equal(summary.total, 3);
  assert.equal(summary.skipped, 5);
  assert.equal(summary.sent, 0);
  assert.equal(summary.pending, 3);
  assert.equal(summary.processed, 0);
  assert.equal(summary.effectiveStatus, 'waiting');
  assert.equal(summary.nextAt, '2026-09-09T08:00:00.000Z');
});

test('lead queues preserve optional calls as context without adding them to send progress', () => {
  const summary = summarizeLeadBackfillQueue({
    summary: {
      total: 3,
      queued: 3,
      candidate_total: 8,
      excluded_call_total: 5,
    },
    related: [
      { id: 1, status: 'waiting', context: { outputs: {} } },
      { id: 2, status: 'waiting', context: { outputs: {} } },
      { id: 3, status: 'waiting', context: { outputs: {} } },
    ],
  });

  assert.equal(summary.total, 3);
  assert.equal(summary.candidateTotal, 8);
  assert.equal(summary.excludedCall, 5);
  assert.equal(summary.skipped, 0);
  assert.equal(summary.pending, 3);
});

test('lead queues derive the last send date from a completed execution', () => {
  const summary = summarizeLeadBackfillQueue({
    summary: { total: 1, queued: 1 },
    related: [{
      id: 1,
      status: 'completed',
      updated_at: '2026-09-09T08:00:04.000Z',
      context: { outputs: { N9: { message_id: 101, status: 'sent' } } },
    }],
  });

  assert.equal(summary.sent, 1);
  assert.equal(summary.lastSentAt, '2026-09-09T08:00:04.000Z');
});
