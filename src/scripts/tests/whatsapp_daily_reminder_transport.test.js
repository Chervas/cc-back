'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWhatsappAuthorizedBrokerClient } = require('../../lib/whatsappAuthorizedBrokerClient');
const daily = require('../../lib/appointment-reminder-sequence');
const { requestIdFor } = require('../../lib/whatsappBrokerClient');

// Only an injected fake transport and fake durable ledger. No environment
// files, application models, provider client, real contacts or database.
const binding = () => ({ connectionRef: 'wa:fictitious:123', authorizationId: 'a1234567-1234-4234-8234-123456789abc',
  clinicId: 123, assetId: 456, phoneId: '401', wabaId: '501', revision: 1, sendEnabled: true });
function fixture(t, { durable = new Map(), providerReceipts = new Map(), authorization = null } = {}) {
  const state = { now: Date.parse('2030-01-10T08:00:00.000Z'), blocked: false, patientHold: false,
    responded: false, ledger: durable, providerReceipts, messages: new Map(), executions: new Map(), appointments: new Map(),
    claims: [], transportCalls: [], providerCalls: [], messageReads: 0, onMessageRead: null,
    config: { version: 1, origin: 'https://broker.example.invalid:8445', keyId: 'staging-whatsapp', audience: 'authorized-wa',
      messageNotBefore: '2030-01-01T00:00:00Z', privateKeyFile: '/etc/clinicaclick-whatsapp-authorized/staging/private.pem',
      caFile: '/etc/clinicaclick-whatsapp-authorized/staging/ca.pem', bindings: [binding()] } };
  t.mock.method(Date, 'now', () => state.now);
  const appointment = (id, start = '2030-01-11T12:00:00.000Z') => {
    const row = { id_cita: id, clinica_id: 123, paciente_id: 7, inicio: start,
      estado: 'pendiente', es_provisional: false, import_metadata: {} }; state.appointments.set(id, row); return row;
  };
  const first = appointment(10), later = appointment(11, '2030-01-11T13:00:00.000Z');
  function notice(messageId, { appointmentId = 10, executionId = 19, stage = 'day_before', timeout = false,
    status = 'pending', metadata = {}, payloadName = null, text = false } = {}) {
    const a = state.appointments.get(appointmentId);
    const templateName = stage === 'same_day' ? 'clinicaclick_recordatorio_mismo_dia_fixture' : 'clinicaclick_recordatorio_dia_antes_fixture';
    const execution = { id: executionId, clinic_id: 123, trigger_entity_type: 'appointment', trigger_entity_id: a.id_cita,
      trigger_type: 'appointment_reminder_window', status: 'running', created_at: '2030-01-10T07:00:00.000Z',
      context: { appointment: { id_cita: a.id_cita, clinica_id: a.clinica_id, paciente_id: a.paciente_id, inicio: a.inicio },
        trigger: { schedule_moment: stage } } };
    state.executions.set(executionId, execution);
    state.messages.set(String(messageId), { id: String(messageId), conversation_id: 71, direction: 'outbound', status,
      message_type: text ? 'text' : 'template', createdAt: '2030-01-10T07:30:00.000Z',
      metadata: { execution_id: executionId, communication_scope: 'care', template_name: text ? null : templateName,
        appointment_timeout: timeout, ...metadata } });
    return { messageId: String(messageId), clinicId: 123, assetId: 456, expectedBinding: binding(),
      message: text ? { messaging_product: 'whatsapp', recipient_type: 'individual', to: '34000000000', type: 'text',
        text: { body: 'Fictitious offline response', preview_url: false } }
        : { messaging_product: 'whatsapp', recipient_type: 'individual', to: '34000000000', type: 'template',
          template: { name: payloadName || templateName, language: { code: 'es' } } } };
  }
  async function authorize(input) {
    state.claims.push(structuredClone(input));
    if (authorization) return authorization(input, state);
    const scope = daily.dayScope(input.appointment, 'Europe/Madrid');
    const anchor = daily.selectAnchor([...state.appointments.values()], scope);
    if (anchor?.id_cita !== input.appointment.id_cita) return { allowed: false, reason: 'appointment_day_uses_first_arrival' };
    if (input.stageKey === 'no_response' && (state.responded || [...state.appointments.values()]
      .some(row => row.estado === 'recordatorio_confirmado'))) return { allowed: false, reason: 'appointment_day_patient_already_replied' };
    const key = daily.sequenceKey(scope) + ':' + input.stageKey;
    const prior = durable.get(key);
    const identity = { executionId: input.execution.id, messageId: input.messageId };
    if (prior && (prior.executionId !== identity.executionId || prior.messageId !== identity.messageId)) return { allowed: false };
    if (!prior) durable.set(key, identity);
    return { allowed: true };
  }
  const dependencies = {
    environment: () => ({ RUNTIME_ROLE: 'api', JOB_RUNTIME_NAMESPACE: 'staging', QUEUE_PREFIX: 'staging', JOBS_WORKER_ENABLED: 'true' }),
    loadConfiguration: () => structuredClone(state.config),
    loadAsset: async () => ({ id: 456, assetType: 'whatsapp_phone_number', assignmentScope: 'clinic', clinicaId: 123,
      grupoClinicaId: null, phoneNumberId: '401', wabaId: '501', isActive: false }),
    loadClinic: async () => ({ id_clinica: 123, grupoClinicaId: 42 }),
    loadMessage: async id => {
      const message = structuredClone(state.messages.get(String(id)));
      state.messageReads++;
      if (state.onMessageRead) await state.onMessageRead(state.messageReads, message);
      return message;
    },
    loadConversation: async () => ({ id: 71, clinic_id: 123, patient_id: 7 }),
    loadExecution: async id => structuredClone(state.executions.get(Number(id))),
    loadAppointment: async id => structuredClone(state.appointments.get(Number(id))),
    loadVisitCommunication: async () => null, patientHeld: async () => state.patientHold,
    loadReceptionState: async () => ({ readyForTimeout: true }), isBlocked: async () => state.blocked,
    authorizeReminderMessage: authorize,
    createTransport: () => ({ execute: async command => {
      state.transportCalls.push(structuredClone(command));
      let accepted = providerReceipts.get(command.requestId), replayed = true;
      if (!accepted) {
        replayed = false; state.providerCalls.push(structuredClone(command));
        accepted = { messages: [{ id: 'wamid.FICTITIOUS_ACCEPTED', message_status: 'accepted' }] };
        providerReceipts.set(command.requestId, accepted);
      }
      return { requestId: command.requestId, replayed, data: accepted };
    } }),
  };
  const client = createWhatsappAuthorizedBrokerClient(dependencies);
  return { state, client, notice, first, later, dependencies, restart: () => createWhatsappAuthorizedBrokerClient(dependencies) };
}
async function denied(client, input, state, reason = null) {
  await assert.rejects(client.send(input), error => {
    assert.equal(error.code, 'whatsapp_authorized_message_ineligible');
    assert.equal(error.retryable, false); assert.equal(error.delivery_unknown, undefined, 'no dispatch attempt is not unknown delivery');
    if (reason) assert.equal(error.details?.reason_code, reason);
    return true;
  });
  assert.equal(state.providerCalls.length, 0); assert.equal(state.transportCalls.length, 0);
}

test('unlinked later arrival and an existing pending follower are denied before fake provider dispatch', async t => {
  for (const status of ['pending','sending']) {
    const f = fixture(t), input = f.notice(101, { appointmentId: 11, status });
    await denied(f.client, input, f.state, 'whatsapp_appointment_daily_sequence_owned');
    assert.equal(f.state.claims.length, 1);
  }
});
test('competing executions/messages seal one daily owner only at final preflight; restarted clients retain that claim', async t => {
  const f = fixture(t), inputs = Array.from({ length: 8 }, (_, i) => f.notice(101 + i, { executionId: 19 + i }));
  const results = await Promise.allSettled(inputs.map(input => f.client.send(input)));
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(f.state.providerCalls.length, 1); assert.equal(f.state.ledger.size, 1);
  const sent = f.state.providerCalls[0];
  assert.equal(f.state.claims.filter(row => row.messageId === Number(inputs.find(input => requestIdFor(input.messageId) === sent.requestId).messageId)).length, 1,
    'the first preflight is read-only; only the final preflight seals a provider delivery right');
  const newInput = f.notice(200, { executionId: 99 });
  await assert.rejects(f.restart().send(newInput), { code: 'whatsapp_authorized_message_ineligible' });
  assert.equal(f.state.providerCalls.length, 1);
  f.first.doctor_id = 88; f.first.instalacion_id = 99; f.first.estado = 'info_confirmada';
  await assert.rejects(f.restart().send(newInput), { code: 'whatsapp_authorized_message_ineligible' });
  assert.equal(f.state.providerCalls.length, 1);
});
test('concurrent same durable Message uses one stable broker idempotency and one fake provider acceptance', async t => {
  const f = fixture(t), input = f.notice(101);
  const results = await Promise.all([f.client.send(input), f.client.send(input)]);
  assert.equal(results.length, 2); assert.equal(f.state.transportCalls.length, 2);
  assert.equal(f.state.providerCalls.length, 1);
  assert.equal(f.state.transportCalls[0].requestId, requestIdFor('101'));
  assert.equal(f.state.transportCalls[0].requestId, f.state.transportCalls[1].requestId);
});
test('definite binding/start denials spend no delivery claim; final ownership denial prevents any fake network call', async t => {
  for (const scenario of ['binding','start','ownership']) {
    const f = fixture(t), input = f.notice(101);
    f.state.onMessageRead = reads => {
      if (scenario === 'binding' && reads === 1) f.state.config.bindings[0].revision = 2;
      if (scenario === 'start' && reads === 2) f.first.inicio = '2030-01-11T12:05:00.000Z';
      if (scenario === 'ownership' && reads === 2) {
        const key = daily.sequenceKey(daily.dayScope(f.first, 'Europe/Madrid')) + ':day_before';
        f.state.ledger.set(key, { executionId: 88, messageId: 999 });
      }
    };
    await assert.rejects(f.client.send(input), error => !error.delivery_unknown && error.retryable === false);
    assert.equal(f.state.providerCalls.length, 0); assert.equal(f.state.transportCalls.length, 0);
    assert.equal(f.state.claims.length, scenario === 'ownership' ? 1 : 0);
    if (scenario !== 'ownership') assert.equal(f.state.ledger.size, 0, 'a definite preflight denial must not seal an unattempted message');
  }
});
test('day-before/same-day have separate stages while one no-response stage spans both executions', async t => {
  const f = fixture(t), before = f.notice(101), beforeTimeout = f.notice(102, { text: true, timeout: true });
  await f.client.send(before); await f.client.send(beforeTimeout);
  f.state.now = Date.parse('2030-01-11T08:00:00Z');
  const today = f.notice(103, { stage: 'same_day', executionId: 20 }); await f.client.send(today);
  const duplicateTimeout = f.notice(104, { stage: 'same_day', executionId: 20, text: true, timeout: true });
  await assert.rejects(f.client.send(duplicateTimeout), { code: 'whatsapp_authorized_message_ineligible' });
  assert.equal(f.state.providerCalls.length, 3); assert.equal(f.state.ledger.size, 3);
});
test('confirmation/cancellation acknowledgements are not daily reminder claims even inside a reminder execution', async t => {
  for (const status of ['recordatorio_confirmado','cancelada']) {
    const f = fixture(t); f.state.now = Date.parse('2030-01-11T08:00:00Z'); f.first.estado = status;
    const input = f.notice(101, { stage: 'same_day', text: true });
    await f.client.send(input); assert.equal(f.state.providerCalls.length, 1);
    assert.equal(f.state.claims.length, 0); assert.equal(f.state.ledger.size, 0);
  }
});
test('manual suppression, patient HOLD, appointment HOLD and uncertain delivery remain closed without any daily claim/network', async t => {
  for (const scenario of ['suppression','patient_hold','appointment_hold','unknown','marketing','receipt']) {
    const f = fixture(t), input = f.notice(101);
    if (scenario === 'suppression') f.first.import_metadata = { notification_suppression: { day_before: true, locked: true, reason: 'manual_selection' } };
    if (scenario === 'patient_hold' || scenario === 'marketing') f.state.patientHold = true;
    if (scenario === 'appointment_hold') f.first.import_metadata = { automation_policy: 'hold' };
    if (scenario === 'unknown') f.state.messages.get('101').metadata.delivery_unknown = true;
    if (scenario === 'marketing') f.state.messages.get('101').metadata.communication_scope = 'marketing';
    if (scenario === 'receipt') f.state.messages.get('101').metadata.provider_acceptance_at = '2030-01-10T07:35:00Z';
    await denied(f.client, input, f.state); assert.equal(f.state.claims.length, 0);
  }
});
test('unknown daily SQL failure is scrubbed before network rather than misreported as unknown provider delivery', async t => {
  const f = fixture(t, { authorization: async () => { throw Error('PRIVATE_FAKE_SQL_ERROR'); } });
  await denied(f.client, f.notice(101), f.state);
  assert.equal(f.state.claims.length, 1);
});
test('actual reminder payload cannot bypass daily ownership by missing persisted template name', async t => {
  const f = fixture(t), input = f.notice(101, { appointmentId: 11, metadata: { template_name: null } });
  await denied(f.client, input, f.state);
});
test('template stage mismatch is denied and execution-only timeout classification cannot be stripped from the persisted message', async t => {
  const mismatch = fixture(t); mismatch.state.now = Date.parse('2030-01-11T08:00:00Z');
  const bad = mismatch.notice(101, { stage: 'same_day', metadata: { template_name: 'clinicaclick_recordatorio_dia_antes_fixture' } });
  await denied(mismatch.client, bad, mismatch.state, 'whatsapp_appointment_daily_sequence_owned');
  const timeout = fixture(t), input = timeout.notice(101, { appointmentId: 11, text: true });
  delete timeout.state.messages.get('101').metadata.appointment_timeout;
  timeout.state.executions.get(19).context.whatsapp_no_response_timeout = true;
  await denied(timeout.client, input, timeout.state, 'whatsapp_appointment_daily_sequence_owned');
});
test('default ledger dependency fails closed without bootstrapping the application model index', async t => {
  const index = require.resolve('../../../models');
  assert.equal(require.cache[index], undefined);
  const f = fixture(t), dependencies = { ...f.dependencies }; delete dependencies.authorizeReminderMessage;
  const client = createWhatsappAuthorizedBrokerClient(dependencies);
  await denied(client, f.notice(101), f.state, 'whatsapp_appointment_daily_sequence_unavailable');
  assert.equal(require.cache[index], undefined, 'a pure client must not start application models/workers for the default daily guard');
});
