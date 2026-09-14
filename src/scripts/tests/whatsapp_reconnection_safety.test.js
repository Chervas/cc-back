'use strict';

// Exercise the real scheduler/replay/retry code with fictitious rows and all
// external sockets, dotenv loading and production queues forbidden.
require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../../../models');
const runtime = require('../../services/appointmentAutomationV2Runtime.service');
const engine = require('../../services/flowEngineV2.service');
const { buildWhatsappOutboundRetryDecision } = require('../../lib/whatsapp-outbound-retry');

const NOW = Date.parse('2026-09-14T10:00:00Z');
const MINUTE = 60_000;
const appointment = (start, changes = {}) => ({
  id_cita: 990001, clinica_id: 990002, paciente_id: 990003,
  tipo_cita: 'primera_sin_trat', estado: 'info_confirmada',
  inicio: new Date(start), fin: new Date(start + 30 * MINUTE),
  created_at: new Date(NOW - 7 * 24 * 60 * MINUTE), ...changes,
});
const triggerConfig = { schedule_moment: 'same_day', schedule_time_mode: 'one_hour_before' };
const template = (config = {}) => ({
  id: 990004, template_key: 'qa_reconnection_reminder', trigger_type: 'appointment_reminder_window',
  trigger_config: { ...triggerConfig, ...config }, version: 1, engine_version: 'v2',
  entry_node_id: 'trigger', nodes: [], clinic_id: 990002, is_active: true,
  published_at: new Date(NOW - 24 * 60 * MINUTE),
});

test.after(() => db.sequelize.close());

test('restart does not recover an expired reminder window, even when the appointment is still future', t => {
  t.mock.method(Date, 'now', () => NOW);
  const schedule = (minutes, grace = 15 * MINUTE) => runtime.computeScheduledRunAt({
    cita: appointment(NOW + minutes * MINUTE), triggerType: 'appointment_reminder_window',
    triggerConfig, timeZone: 'UTC', pastWindowGraceMs: grace,
  });
  assert.equal(schedule(-1), null, 'appointment already started');
  assert.equal(schedule(30), null, 'appointment future but reminder is thirty minutes late');
  assert.equal(schedule(45), null, 'the fifteen-minute grace boundary is exclusive');
  assert.equal(schedule(46).getTime(), NOW - 14 * MINUTE, 'bounded scheduler delay remains supported');
  assert.equal(schedule(46, 0), null, 'resynchronization must not create retroactive reminders');
  assert.equal(schedule(120).getTime(), NOW + 60 * MINUTE, 'future reminders retain their original time');
});

test('dispatch re-reads the appointment and rejects obsolete work without creating executions', async t => {
  t.mock.method(Date, 'now', () => NOW);
  let current = appointment(NOW + 120 * MINUTE);
  let currentTemplate = template();
  let executions = 0;
  t.mock.method(db.CitaPaciente, 'findByPk', async () => current);
  t.mock.method(db.Clinica, 'findByPk', async () => ({ id_clinica: 990002, configuracion: { timezone: 'UTC' } }));
  t.mock.method(db.AutomationFlowTemplateV2, 'findOne', async () => currentTemplate);
  t.mock.method(db.FlowExecutionV2, 'create', async () => { executions++; throw Error('UNEXPECTED_EXECUTION'); });
  const payload = { appointment_id: 990001, trigger_type: 'appointment_reminder_window', template_key: currentTemplate.template_key };
  for (const status of ['cancelada', 'cambio_solicitado', 'no_asistio']) {
    current = appointment(NOW + 120 * MINUTE, { estado: status });
    assert.equal((await runtime.fireScheduledTrigger(payload)).reason, 'appointment_' + status);
  }
  current = null;
  assert.equal((await runtime.fireScheduledTrigger(payload)).reason, 'appointment_not_found');
  current = appointment(NOW + 120 * MINUTE);
  currentTemplate = null;
  assert.equal((await runtime.fireScheduledTrigger(payload)).reason, 'template_not_active');
  currentTemplate = template({ only_if_not_confirmed: true });
  assert.equal((await runtime.fireScheduledTrigger(payload)).reason, 'appointment_already_confirmed');
  currentTemplate = template({ exclude_if_not_confirmed: true });
  current = appointment(NOW + 120 * MINUTE, { estado: 'pendiente' });
  assert.equal((await runtime.fireScheduledTrigger(payload)).reason, 'appointment_not_confirmed');
  currentTemplate = template();
  current = appointment(NOW + 30 * MINUTE);
  assert.equal((await runtime.fireScheduledTrigger(payload)).reason, 'invalid_schedule');
  current = appointment(NOW + 120 * MINUTE);
  const oldWindow = runtime.buildScheduledWindowIdentifier({ triggerType: payload.trigger_type,
    triggerConfig, scheduledFor: new Date(NOW + 30 * MINUTE) });
  assert.equal((await runtime.fireScheduledTrigger({ ...payload, window_identifier: oldWindow })).reason, 'stale_schedule_window');
  const future = await runtime.fireScheduledTrigger(payload);
  assert.equal(future.waiting, true);
  assert.equal(future.scheduled_for, new Date(NOW + 60 * MINUTE).toISOString());
  assert.equal(executions, 0);
});

test('preflight failures and pending messages with unknown handoff are never blindly replayed', async t => {
  let updates = 0;
  t.mock.method(db.Conversation, 'findByPk', async () => ({ id: 990010,
    update: async () => { updates++; } }));
  for (const [status, metadata, error] of [
    ['failed', { failure_source: 'automation_send_whatsapp_preflight', error: 'whatsapp_config_missing' }, /whatsapp_previous_delivery_failed:whatsapp_config_missing/],
    ['pending', {}, /whatsapp_previous_delivery_state_unknown/],
  ]) {
    await assert.rejects(engine.reuseExistingAutomationWhatsappMessage({ existingMessage: {
      id: 990011, conversation_id: 990010, status, metadata,
      update: async () => { updates++; },
    }, node: {} }), error);
  }
  assert.equal(updates, 0, 'failure history must not be changed into a new pending send');
});

test('accepted/delivered/read messages reuse their identity without issuing transport jobs', async t => {
  t.mock.method(db.Conversation, 'findByPk', async () => ({ id: 990010, update: async () => {} }));
  for (const status of ['sent', 'delivered', 'read']) {
    const result = await engine.reuseExistingAutomationWhatsappMessage({ existingMessage: {
      id: 990011, conversation_id: 990010, status,
      metadata: { automation_transport_job_id: 'qa-original-transport' },
      update: async () => { throw Error('MESSAGE_MUST_NOT_BE_REWRITTEN'); },
    }, node: {} });
    assert.equal(result.output.message_id, 990011);
    assert.equal(result.output.status, status);
    assert.equal(result.output.replay_reused, true);
  }
});

test('ambiguous provider delivery never retries; known transient failures stop at the configured limit', () => {
  for (const error of [{ code: 'ECONNRESET' }, { code: 'ETIMEDOUT' }, { request: {} },
    { delivery_unknown: true, response: { status: 503 } }]) {
    const decision = buildWhatsappOutboundRetryDecision({ error, retryOnFailure: true, maxAttempts: 5 });
    assert.equal(decision.delivery_unknown, true);
    assert.equal(decision.should_retry, false);
  }
  const options = { error: { response: { status: 503 } }, retryOnFailure: true, maxAttempts: 3 };
  assert.equal(buildWhatsappOutboundRetryDecision({ ...options, attemptsMade: 0 }).should_retry, true);
  assert.equal(buildWhatsappOutboundRetryDecision({ ...options, attemptsMade: 2 }).should_retry, false);
  assert.equal(buildWhatsappOutboundRetryDecision({ ...options, retryOnFailure: false }).should_retry, false);
  assert.equal(buildWhatsappOutboundRetryDecision({ ...options,
    error: { response: { status: 401, data: { error: { code: 190 } } } } }).should_retry, false);
});
