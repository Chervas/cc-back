'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const v = require('../../lib/appointment-visit-communication');
const { fixture, appointment, window, policy, NOW } = require('./helpers/appointment-visit-fixture');
const c = require('../../lib/appointment-clinical-components');
const claim = (f, visit, overrides = {}) => f.service.claimCommunication({ visitId: visit.id, clinicId: 66,
  expectedRevision: Number(visit.communication_revision), purpose: 'appointment_details', window: window(), templateVersionId: 42, ...overrides });
function prepareBinding(f, communication, overrides = {}) {
  const owner = f.state.CitaPaciente.get(String(communication.owner_appointment_id));
  f.seed('FlowExecutionV2', { id: 21, clinic_id: 66, trigger_entity_type: 'appointment', trigger_entity_id: owner.id_cita,
    trigger_type: 'appointment_created', template_version_id: 42, status: 'running', created_at: NOW,
    context: { appointment: { id_cita: owner.id_cita, clinica_id: 66, paciente_id: 8, inicio: owner.inicio } }, ...overrides.execution });
  f.seed('Conversation', { id: 14, clinic_id: 66, patient_id: 8, ...overrides.conversation });
  f.seed('Message', { id: 31, conversation_id: 14, direction: 'outbound', status: 'pending',
    metadata: { execution_id: 21 }, automation_delivery_key: v.deliveryKey(communication), ...overrides.message });
  return () => f.service.bindCommunication({ communicationId: communication.id, clinicId: 66, executionId: 21, messageId: 31 });
}
test('singleton identity is durable/idempotent and simultaneous requests make one membership', async () => {
  const f = fixture(), before = structuredClone(f.state.CitaPaciente);
  const results = await Promise.all([f.singleton(), f.singleton(), f.singleton()]);
  assert.equal(results.filter(r => r.created).length, 1); assert.equal(new Set(results.map(r => r.visit.id)).size, 1);
  assert.equal(f.state.AppointmentVisit.size, 1); assert.equal(f.state.AppointmentVisitMember.size, 1);
  assert.deepEqual(f.state.CitaPaciente, before);
  assert(f.writes.every(write => ['AppointmentVisit', 'AppointmentVisitMember'].includes(write.model)));
  assert(f.calls.filter(call => call.model === 'CitaPaciente').every(call => call.lock === 'UPDATE' && call.transaction));
});
test('singleton rollback after membership failure creates no orphan and does not touch the appointment', async () => {
  const f = fixture({ failCreate: 'AppointmentVisitMember' });
  await assert.rejects(f.singleton(), /fixture_create_failed/);
  assert.equal(f.state.AppointmentVisit.size, 0); assert.equal(f.state.AppointmentVisitMember.size, 0);
  assert.equal(f.state.CitaPaciente.size, 1);
});
test('tenant, invalid IDs and isolation fail closed without creating identity', async () => {
  const f = fixture();
  await assert.rejects(f.service.ensureSingletonVisit({ appointmentId: 101, clinicId: 72 }), { code: 'appointment_visit_appointment_not_found' });
  await assert.rejects(f.service.ensureSingletonVisit({ appointmentId: '101', clinicId: 66 }), { code: 'appointment_visit_invalid_appointment' });
  await assert.rejects(f.service.ensureSingletonVisit({ appointmentId: 101, clinicId: 66, transaction: { options: { isolationLevel: 'REPEATABLE READ' }, LOCK: { UPDATE: 'UPDATE' } } }), { code: 'appointment_visit_transaction_invalid' });
  assert.equal(f.state.AppointmentVisit.size, 0);
});
test('real service concurrent claims return one intent and one stable Message delivery key', async () => {
  const f = fixture(), { visit } = await f.singleton();
  const results = await Promise.all(Array.from({ length: 8 }, () => claim(f, visit)));
  assert.equal(results.filter(result => result.created).length, 1);
  assert.equal(new Set(results.map(result => result.communication.id)).size, 1);
  assert.equal(new Set(results.map(result => result.delivery_key)).size, 1);
  assert.equal(f.state.AppointmentVisitCommunication.size, 1);
  const replay = await claim(f, visit, { templateVersionId: 43 });
  assert.equal(replay.created, false); assert.equal(replay.communication.template_version_id, 42);
  assert(!f.writes.some(write => ['CitaPaciente', 'FlowExecutionV2', 'Message'].includes(write.model)));
});
test('an execution-only persisted binding gains the same Message once without reassignment', async () => {
  const f = fixture(), { visit } = await f.singleton(), { communication } = await claim(f, visit);
  const bind = prepareBinding(f, communication);
  // Publisher commits execution first; materializer later binds the Message.
  f.change('AppointmentVisitCommunication', communication.id, { execution_id: 21 });
  const first = await bind();
  assert.equal(first.communication.execution_id, 21); assert.equal(first.communication.message_id, 31);
  assert.equal((await bind()).communication.message_id, 31);
  await assert.rejects(f.service.bindCommunication({ communicationId: communication.id, clinicId: 66, executionId: 21, messageId: 32 }), { code: 'appointment_visit_binding_exists' });
});
test('same semantic window cannot evade deduplication by changing bounds; distinct purpose/window are separate', async () => {
  const f = fixture(), { visit } = await f.singleton(); await claim(f, visit);
  await assert.rejects(claim(f, visit, { window: { ...window(), ends_at: '2030-01-03T12:00:00.000Z' } }), { code: 'appointment_visit_window_definition_changed' });
  await claim(f, visit, { purpose: 'reminder_day_before', window: window('day_before:2030-01-06') });
  await claim(f, visit, { window: window('other-explicit-window') });
  assert.equal(f.state.AppointmentVisitCommunication.size, 3);
});
test('explicit CAS refresh increments semantic revision, stale intent blocks and old history stays intact', async () => {
  const f = fixture(), { visit } = await f.singleton(), intent = await claim(f, visit);
  f.change('CitaPaciente', 101, { updated_at: '2030-01-01T13:00:00.000Z', estado: 'info_confirmada' });
  assert.equal((await f.service.refreshVisitSnapshot({ visitId: visit.id, clinicId: 66, expectedRevision: 1 })).changed, false);
  f.change('CitaPaciente', 101, { inicio: '2030-01-07T10:20:00.000Z' });
  await assert.rejects(claim(f, visit), { code: 'appointment_visit_snapshot_changed' });
  const refreshed = await f.service.refreshVisitSnapshot({ visitId: visit.id, clinicId: 66, expectedRevision: 1 });
  assert.equal(refreshed.changed, true); assert.equal(refreshed.visit.communication_revision, 2);
  await assert.rejects(f.service.refreshVisitSnapshot({ visitId: visit.id, clinicId: 66, expectedRevision: 1 }), { code: 'appointment_visit_revision_changed' });
  await assert.rejects(f.service.assertCommunicationCurrent({ communicationId: intent.communication.id, clinicId: 66 }), { code: 'appointment_visit_revision_changed' });
  const second = await claim(f, refreshed.visit);
  assert.notEqual(second.communication.id, intent.communication.id); assert.equal(f.state.AppointmentVisitCommunication.size, 2);
});
test('tampered membership/snapshot or reassigned patient cannot authorize a communication', async () => {
  for (const mutate of [f => f.change('AppointmentVisitMember', 101, { role: 'prp_extraction' }),
    f => f.change('AppointmentVisitMember', 101, { patient_id: 9 }),
    f => f.change('AppointmentVisit', [...f.state.AppointmentVisit.keys()][0], { snapshot: { altered: true } }),
    f => f.change('CitaPaciente', 101, { paciente_id: 9 })]) {
    const f = fixture(), { visit } = await f.singleton(); mutate(f); await assert.rejects(claim(f, visit));
    assert.equal(f.state.AppointmentVisitCommunication.size, 0);
  }
});
test('HOLD/QA/source/provisional/history/migration never create an intent by default', async () => {
  for (const patch of [{ source_system: 'cliniccloud' }, { import_metadata: { automation_policy: 'hold' } },
    { import_metadata: { qa_demo: true } }, { import_metadata: { synthetic_data_only: true } }, { es_provisional: true },
    { import_metadata: { historical_registration: true } }]) {
    const f = fixture({ rows: [appointment(101, patch)] }), { visit } = await f.singleton();
    await assert.rejects(claim(f, visit)); assert.equal(f.state.AppointmentVisitCommunication.size, 0);
  }
  const f = fixture(), { visit } = await f.singleton();
  await assert.rejects(claim(f, visit, { purpose: 'migration' }), { code: 'appointment_visit_invalid_purpose' });
});
test('validated reciprocal PRP makes one visit with parent compatibility owner, without editing either source appointment', async () => {
  const f = fixture({ prp: true }), before = structuredClone(f.state.CitaPaciente);
  const grouped = await f.group();
  assert.equal(grouped.visit.grouping_kind, 'validated_prp'); assert.equal(grouped.visit.owner_appointment_id, 102);
  assert.equal(f.state.AppointmentVisit.size, 1); assert.equal(f.state.AppointmentVisitMember.size, 2);
  assert.equal(f.state.AppointmentVisitMember.get('101').role, 'prp_extraction');
  assert.equal(f.state.AppointmentVisitMember.get('102').role, 'primary');
  assert.equal((await f.group()).created, false);
  assert.equal((await f.singleton(101)).visit.id, grouped.visit.id);
  assert.deepEqual(f.state.CitaPaciente, before);
  await assert.rejects(claim(f, grouped.visit), { code: 'appointment_visit_held' });
});
test('PRP link requires actual reciprocal records plus current audit/treatment, never matching dates or client metadata', async () => {
  const arbitrary = fixture({ rows: [appointment(101), appointment(102)] });
  await assert.rejects(arbitrary.group(), { code: 'appointment_visit_clinical_relation_unproven' });
  for (const mutate of [f => f.change('CitaPaciente', 102, { import_metadata: {} }),
    f => f.change('PatientOperationalEvent', '9007199254740993', { event_type: 'other' }),
    f => f.change('Tratamiento', 688, { activo: false }), f => f.change('CitaPaciente', 101, { fin: '2030-01-07T10:16:00.000Z' })]) {
    const f = fixture({ prp: true }); mutate(f); await assert.rejects(f.group(), { code: 'appointment_visit_clinical_relation_unproven' });
    assert.equal(f.state.AppointmentVisit.size, 0);
  }
});
test('empty singleton merge retains parent identity and tombstones child; current relation does not independently claim', async () => {
  const f = fixture({ prp: true }), child = await f.singleton(101), parent = await f.singleton(102);
  await assert.rejects(claim(f, child.visit), { code: 'appointment_visit_clinical_grouping_required' });
  const grouped = await f.group(); assert.equal(grouped.visit.id, parent.visit.id); assert.equal(grouped.visit.communication_revision, 2);
  assert.equal(f.state.AppointmentVisit.get(child.visit.id).status, 'merged');
  assert.equal(f.state.AppointmentVisit.get(child.visit.id).merged_into_visit_id, parent.visit.id);
  assert.equal(f.state.AppointmentVisitMember.get('101').visit_id, parent.visit.id);
});
test('merging any new or legacy delivery/wait history refuses adoption and preserves all identities/rights', async () => {
  for (const status of ['pending', 'waiting', 'paused', 'accepted', 'unknown', 'cancelled']) {
    const f = fixture({ prp: true }), child = await f.singleton(101); await f.singleton(102);
    if (['waiting', 'paused'].includes(status)) f.seed('FlowExecutionV2', { id: 22, clinic_id: 66, trigger_entity_type: 'appointment', trigger_entity_id: 101, status });
    else f.seed('AppointmentVisitCommunication', { id: randomUUID(), visit_id: child.visit.id, status });
    const before = structuredClone(f.state);
    await assert.rejects(f.group(), { code: 'appointment_visit_grouping_communication_history_requires_review' });
    assert.deepEqual(f.state, before);
  }
  const f = fixture({ prp: true });
  f.seed('FlowExecutionV2', { id: 22, clinic_id: 66, trigger_entity_type: 'appointment', trigger_entity_id: 102, status: 'completed' });
  await assert.rejects(f.group(), { code: 'appointment_visit_grouping_communication_history_requires_review' });
  assert.equal(f.state.AppointmentVisit.size, 0);
});
test('current protected operations policy releases future imported PRP per member; same-day/backlog/QA/manual suppression remain closed', async () => {
  const f = fixture({ prp: true, policy: policy() }), { visit } = await f.group();
  const intent = await claim(f, visit); assert.equal(intent.created, true);
  await assert.rejects(claim(f, visit, { purpose: 'reminder_same_day' }), { code: 'appointment_visit_notification_suppressed' });
  const bind = prepareBinding(f, intent.communication); await bind();
  assert.equal((await f.service.assertCommunicationCurrent({ communicationId: intent.communication.id, clinicId: 66 })).owner_appointment_id, 102);
  f.policy(null); await assert.rejects(f.service.assertCommunicationCurrent({ communicationId: intent.communication.id, clinicId: 66 }), { code: 'appointment_visit_held' });
  const g = fixture({ prp: true, policy: policy() }), group = await g.group();
  await assert.rejects(claim(g, group.visit, { window: { ...window(), starts_at: '2029-12-30T12:00:00.000Z' } }), { code: 'appointment_visit_held' });
  for (const metadata of [{ synthetic_data_only: true }, { historical_registration: true },
    { notification_suppression: { appointment_details: true, locked: false } }]) {
    const h = fixture({ rows: [appointment(101, { source_system: 'cliniccloud', import_metadata: { automation_policy: 'hold', ...metadata } })], policy: policy() });
    const identity = await h.singleton(); await assert.rejects(claim(h, identity.visit));
  }
});
test('imported bind needs real fresh owner execution, current snapshot and purpose; old waits cannot be adopted', async () => {
  for (const execution of [{ created_at: '2029-12-30T12:00:00.000Z' }, { trigger_entity_id: 101 },
    { context: { appointment: { inicio: '2030-01-07T10:00:00.000Z' } } }, { trigger_type: 'appointment_cancelled' },
    { context: { __simulation: true, appointment: { inicio: '2030-01-07T10:15:00.000Z' } } }]) {
    const f = fixture({ prp: true, policy: policy() }), { visit } = await f.group(), intent = await claim(f, visit);
    const bind = prepareBinding(f, intent.communication, { execution }); await assert.rejects(bind());
    assert.equal(f.state.AppointmentVisitCommunication.get(intent.communication.id).execution_id, undefined);
  }
});
test('exact legacy day-before release is reused, never upgraded to generic details or same-day', async () => {
  const row = appointment(101, { source_system: 'cliniccloud', source_reference: 'fixture-source', import_metadata: { automation_policy: 'hold', notification_suppression: { day_before: true } } });
  const legacy = { version: 1, purpose: 'day_before_reminder', approvedBy: 7, approvalRef: 'fixture-only',
    approvedAt: '2029-12-31T12:00:00.000Z', startsNotBefore: '2030-01-01T00:00:00.000Z', expiresAt: '2030-01-08T00:00:00.000Z',
    automaticBacklogReplay: false, sameDayAllowed: false,
    appointments: [{ id: 101, clinicId: 66, patientId: 8, templateVersionId: 42, startAt: row.inicio, sourceSystem: row.source_system, sourceReference: row.source_reference }] };
  const f = fixture({ rows: [row], legacy }), { visit } = await f.singleton();
  const intent = await claim(f, visit, { purpose: 'reminder_day_before' });
  await assert.rejects(claim(f, visit), { code: 'appointment_visit_held' });
  await assert.rejects(claim(f, visit, { purpose: 'reminder_day_before', templateVersionId: 43 }), { code: 'appointment_visit_held' });
  const bind = prepareBinding(f, intent.communication, { execution: { trigger_type: 'appointment_reminder_window' } }); await bind();
  assert.equal((await f.service.assertCommunicationCurrent({ communicationId: intent.communication.id, clinicId: 66 })).communication.id, intent.communication.id);
  f.legacy(null); await assert.rejects(f.service.assertCommunicationCurrent({ communicationId: intent.communication.id, clinicId: 66 }));
});
test('binding cannot change compatibility owner, contact scope, Message delivery key or synthetic execution', async () => {
  for (const overrides of [{ execution: { trigger_entity_id: 102 } }, { conversation: { patient_id: 9 } },
    { conversation: { clinic_id: 72 } }, { message: { automation_delivery_key: 'old-appointment-key' } },
    { message: { direction: 'inbound' } }, { message: { metadata: { execution_id: 22 } } },
    { execution: { status: 'cancelled' } }, { execution: { status: 'paused' } }, { execution: { template_version_id: 43 } },
    { message: { metadata: { execution_id: 21, recipient_patient_id: 9 } } },
    { message: { metadata: { execution_id: 21, qa_demo: true } } }]) {
    const f = fixture(), { visit } = await f.singleton(), intent = await claim(f, visit);
    const bind = prepareBinding(f, intent.communication, overrides); await assert.rejects(bind());
    assert.equal(f.state.AppointmentVisitCommunication.get(intent.communication.id).message_id, undefined);
    assert(!f.writes.some(write => ['FlowExecutionV2', 'Message'].includes(write.model)));
  }
});
test('accepted/unknown outcomes survive cancellation, HOLD, stale snapshot and failed labels without resetting receipts', async () => {
  for (const metadata of [{ execution_id: 21, wamid: 'fixture-id' }, { execution_id: 21, outcome_unknown: true }]) {
    const f = fixture(), { visit } = await f.singleton(), intent = await claim(f, visit), bind = prepareBinding(f, intent.communication);
    await bind(); f.change('Message', 31, { status: 'failed', metadata });
    const expected = metadata.wamid ? 'accepted' : 'unknown';
    const reconciled = await f.service.reconcileDelivery({ communicationId: intent.communication.id, clinicId: 66 });
    assert.equal(reconciled.status, expected);
    f.change('CitaPaciente', 101, { inicio: '2030-01-07T11:00:00.000Z', import_metadata: { automation_policy: 'hold' } });
    const cancelled = await f.service.cancelCommunication({ communicationId: intent.communication.id, clinicId: 66, reason: 'visit_changed' });
    assert.equal(cancelled.cancelled, false); assert.equal(cancelled.communication.status, expected);
    f.change('Message', 31, { metadata: { execution_id: 21 }, status: 'failed' });
    assert.equal((await f.service.reconcileDelivery({ communicationId: intent.communication.id, clinicId: 66 })).status, expected);
    assert.equal(f.state.Message.get('31').automation_delivery_key, intent.delivery_key);
    assert(!f.writes.some(write => write.model === 'Message'));
  }
});
test('uncertain delivery reconciles only the same Message and can advance to accepted, never pending', async () => {
  const f = fixture(), { visit } = await f.singleton(), intent = await claim(f, visit), bind = prepareBinding(f, intent.communication);
  await bind(); f.change('Message', 31, { metadata: { execution_id: 21, delivery_unknown: true } });
  await f.service.reconcileDelivery({ communicationId: intent.communication.id, clinicId: 66 });
  await assert.rejects(f.service.assertCommunicationCurrent({ communicationId: intent.communication.id, clinicId: 66 }), { code: 'appointment_visit_communication_not_dispatchable' });
  f.seed('Message', { ...f.state.Message.get('31'), id: 32 });
  await assert.rejects(f.service.bindCommunication({ communicationId: intent.communication.id, clinicId: 66, executionId: 21, messageId: 32 }), { code: 'appointment_visit_binding_exists' });
  f.change('Message', 31, { metadata: { execution_id: 21, wamid: 'fixture-accepted-later' }, status: 'sent' });
  assert.equal((await f.service.reconcileDelivery({ communicationId: intent.communication.id, clinicId: 66 })).status, 'accepted');
});
test('cancellation is per intent/purpose and late provider acceptance is preserved', async () => {
  const f = fixture(), { visit } = await f.singleton(), details = await claim(f, visit), reminder = await claim(f, visit, { purpose: 'reminder_day_before' });
  const bind = prepareBinding(f, details.communication); await bind();
  assert.equal((await f.service.cancelCommunication({ communicationId: details.communication.id, clinicId: 66, reason: 'purpose_cancelled' })).cancelled, true);
  assert.equal(f.state.AppointmentVisitCommunication.get(reminder.communication.id).status, 'pending');
  f.change('Message', 31, { metadata: { execution_id: 21, provider_acceptance_at: NOW }, status: 'sent' });
  assert.equal((await f.service.reconcileDelivery({ communicationId: details.communication.id, clinicId: 66 })).status, 'accepted');
  assert.equal((await claim(f, visit)).communication.id, details.communication.id);
});
test('sending/outcome-unknown Message is never cancelled or re-dispatched', async () => {
  const f = fixture(), { visit } = await f.singleton(), intent = await claim(f, visit), bind = prepareBinding(f, intent.communication);
  await bind(); f.change('Message', 31, { status: 'sending' });
  const result = await f.service.cancelCommunication({ communicationId: intent.communication.id, clinicId: 66, reason: 'visit_changed' });
  assert.equal(result.cancelled, false); assert.equal(result.communication.status, 'unknown');
  await assert.rejects(f.service.assertCommunicationCurrent({ communicationId: intent.communication.id, clinicId: 66 }), { code: 'appointment_visit_communication_not_dispatchable' });
});
test('dispatch rechecks window and current membership; create/claim never enqueue or send', async () => {
  const f = fixture(), { visit } = await f.singleton(), intent = await claim(f, visit, { window: { ...window(), starts_at: '2030-01-01T13:00:00.000Z' } });
  await assert.rejects(f.service.assertCommunicationCurrent({ communicationId: intent.communication.id, clinicId: 66 }), { code: 'appointment_visit_window_not_open' });
  f.now('2030-01-02T12:00:00.000Z');
  await assert.rejects(f.service.assertCommunicationCurrent({ communicationId: intent.communication.id, clinicId: 66 }), { code: 'appointment_visit_window_expired' });
  assert(f.writes.every(write => ['AppointmentVisit', 'AppointmentVisitMember', 'AppointmentVisitCommunication'].includes(write.model)));
  assert(!('queue' in f.db)); assert(!('sender' in f.db));
});
test('current dispatch closes when the actual bound execution is stopped or its captured start changes', async () => {
  for (const patch of [{ status: 'cancelled' }, { status: 'paused' }, { status: 'failed' },
    { context: { appointment: { inicio: '2030-01-07T10:20:00.000Z' } } }]) {
    const f = fixture(), { visit } = await f.singleton(), intent = await claim(f, visit), bind = prepareBinding(f, intent.communication);
    await bind(); f.change('FlowExecutionV2', 21, patch);
    await assert.rejects(f.service.assertCommunicationCurrent({ communicationId: intent.communication.id, clinicId: 66 }));
    assert.equal(f.state.AppointmentVisitCommunication.get(intent.communication.id).message_id, 31);
  }
});
test('link rollback on partial membership creation preserves the old singleton and both appointments', async () => {
  const f = fixture({ prp: true, failCreate: 'AppointmentVisitMember' });
  await assert.rejects(f.group(), /fixture_create_failed/);
  assert.equal(f.state.AppointmentVisit.size, 0); assert.equal(f.state.AppointmentVisitMember.size, 0);
  assert.equal(f.state.CitaPaciente.size, 2); assert.equal(f.state.PatientOperationalEvent.size, 1);
});
test('canonical group/claim lock order starts with both historical appointment IDs sorted', async () => {
  const f = fixture({ prp: true, policy: policy() }), { visit } = await f.group();
  assert.deepEqual(f.calls.filter(call => call.model === 'CitaPaciente' && call.lock === 'UPDATE').map(call => call.id), [101, 102]);
  f.calls.length = 0; await claim(f, visit);
  const writes = f.calls.filter(call => call.lock === 'UPDATE');
  assert.deepEqual(writes.slice(0, 2).map(call => [call.model, call.id]), [['CitaPaciente', 101], ['CitaPaciente', 102]]);
  assert(writes.findIndex(call => call.model === 'AppointmentVisit') > writes.findIndex(call => call.model === 'AppointmentVisitMember'));
});
test('caller-shaped release flags never override policy, and a claimed intent predating approval is not replayed', async () => {
  const f = fixture({ rows: [appointment(101, { source_system: 'cliniccloud', import_metadata: { automation_policy: 'hold' } })] }), { visit } = await f.singleton();
  await assert.rejects(claim(f, visit, { patientHoldOverride: true, releaseForAppointment: { allowed: true }, policy: policy() }), { code: 'appointment_visit_held' });
  const g = fixture({ prp: true, policy: policy() }), group = await g.group(), intent = await claim(g, group.visit);
  g.change('AppointmentVisitCommunication', intent.communication.id, { created_at: '2029-12-30T12:00:00.000Z' });
  const bind = prepareBinding(g, intent.communication); await assert.rejects(bind(), { code: 'appointment_visit_held' });
});
test('Message binding is exclusive even if an old Message key has been incorrectly reassigned elsewhere', async () => {
  const f = fixture(), { visit } = await f.singleton(), first = await claim(f, visit), second = await claim(f, visit, { window: window('different-window') });
  const bind = prepareBinding(f, first.communication); await bind();
  f.change('Message', 31, { automation_delivery_key: v.deliveryKey(second.communication) });
  await assert.rejects(f.service.bindCommunication({ communicationId: second.communication.id, clinicId: 66, executionId: 21, messageId: 31 }), { code: 'appointment_visit_message_already_bound' });
  assert.equal(f.state.AppointmentVisitCommunication.get(first.communication.id).message_id, 31);
  assert.equal(f.state.AppointmentVisitCommunication.get(second.communication.id).message_id, undefined);
});
