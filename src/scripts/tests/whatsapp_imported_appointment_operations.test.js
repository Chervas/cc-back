'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const operations = require('../../lib/whatsappImportedAppointmentOperations');
const now = Date.parse('2026-10-06T12:00:00.000Z');
function fixture() {
  const rawPolicy = { version: 1, purpose: 'appointment_operations', approvedBy: 1,
    approvalRef: 'user_approval_20261006', approvedAt: '2026-10-06T11:00:00.000Z',
    clinicIds: [66, 72], automaticBacklogReplay: false, sameDayAllowed: false };
  const policy = operations.validate(rawPolicy, { now });
  const appointment = { id_cita: 10, clinica_id: 66, paciente_id: 20,
    inicio: '2026-10-07T09:00:00.000Z', estado: 'reprogramada', source_system: 'cliniccloud',
    source_reference: 'source:10', import_metadata: {
      source_account: 'cliniccloud-5880', cliniccloud_reconciliation: { automation_policy: 'hold' },
      notification_suppression: { appointment_details: true, day_before: true, same_day: true },
    } };
  const execution = { id: 50, clinic_id: 66, template_version_id: 30,
    trigger_type: 'appointment_rescheduled', trigger_entity_type: 'appointment', trigger_entity_id: 10,
    created_at: '2026-10-06T11:30:00.000Z', status: 'waiting',
    context: { appointment: { id_cita: 10, clinica_id: 66, paciente_id: 20, inicio: appointment.inicio } } };
  return { rawPolicy, policy, appointment, execution };
}

test('approval is immutable, tenant scoped and never enables a backlog or same-day reminder', () => {
  const f = fixture();
  assert(Object.isFrozen(f.policy)); assert(Object.isFrozen(f.policy.clinicIds));
  for (const change of [
    { version: 2 }, { purpose: 'marketing' }, { approvedBy: 0 }, { approvalRef: 'invalid ref' },
    { approvedAt: '2026-10-06T13:00:00.000Z' }, { approvedAt: '2026-10-06' },
    { automaticBacklogReplay: true }, { sameDayAllowed: true }, { clinicIds: [] },
    { clinicIds: [66, 99] }, { clinicIds: [66, 66] }, { clinicIds: ['66'] },
  ]) assert.throws(() => operations.validate({ ...f.rawPolicy, ...change }, { now }), /invalid_imported_appointment_operations/);
  assert.equal(operations.allowsAppointment(f.appointment, { policy: f.policy, now: Date.parse('2026-10-06T10:00Z') }), false);
});

test('operational ClinicCloud reservations retain every source receipt unchanged', () => {
  const f = fixture(), before = JSON.stringify(f.appointment);
  assert.equal(operations.allowsAppointment(f.appointment, { policy: f.policy, now }), true);
  assert.equal(operations.allowsAppointment({ ...f.appointment, source_system: ' ClinicCloud ' }, { policy: f.policy, now }), true);
  assert.equal(operations.permits(f.appointment, { execution: f.execution, policy: f.policy, now }), true);
  assert.equal(operations.allowsSuppressionOverride(f.appointment, { policy: f.policy, now }), true);
  assert.equal(JSON.stringify(f.appointment), before);
});

test('native patients, other clinics, stale visits, invalid entities and demo fixtures remain outside the release', () => {
  const f = fixture();
  for (const change of [
    { source_system: null }, { source_system: 'treatment_program' }, { clinica_id: 99 },
    { id_cita: 0 }, { paciente_id: null }, { paciente_id: true }, { inicio: 'invalid' },
    { inicio: '2026-10-06T10:59:59.000Z' }, { estado: 'unknown' }, { es_provisional: true },
    { import_metadata: { qa_demo: true } }, { import_metadata: { synthetic_data_only: true } },
  ]) assert.equal(operations.allowsAppointment({ ...f.appointment, ...change }, { policy: f.policy, now }), false, JSON.stringify(change));
  assert.equal(operations.allowsAppointment(f.appointment, { policy: null, now }), false);
  assert.equal(operations.allowsAppointment(f.appointment, { policy: { ...f.policy, clinicIds: [72] }, now }), false);
});

test('a current native booking overrides only the patient hold, not the imported appointment policy', () => {
  const f = fixture(), appointment = { ...f.appointment, source_system: null, source_reference: null,
    import_metadata: { notification_suppression: { appointment_details: false, day_before: true } } };
  const before = JSON.stringify(appointment);
  assert.equal(operations.allowsAppointment(appointment, { policy: f.policy, now }), false);
  assert.equal(operations.permits(appointment, { execution: f.execution, policy: f.policy, now }), false);
  assert.equal(operations.allowsSuppressionOverride(appointment, { policy: f.policy, now }), false);
  assert.equal(operations.permitsPatientHoldOverride(appointment, { execution: f.execution, policy: f.policy, now }), true);
  assert.equal(JSON.stringify(appointment), before);
});

test('native patient-hold override cannot release historical, foreign, blocked, cancelled or stale bookings', () => {
  const f = fixture(), native = { ...f.appointment, source_system: null, source_reference: null, import_metadata: {} };
  for (const change of [
    { source_system: 'treatment_program' }, { source_reference: 'historic:10' }, { clinica_id: 99 },
    { id_cita: 0 }, { paciente_id: null }, { estado: 'cancelada' }, { estado: 'completada' },
    { estado: 'no_asistio' }, { estado: 'cambio_solicitado' }, { es_provisional: true },
    { inicio: '2026-10-06T11:59:00.000Z' }, { inicio: '2026-10-06T12:00:00.000Z' },
    { titulo: 'Histórico: Tratamiento' }, { import_metadata: { qa_demo: true } },
    { import_metadata: { synthetic_data_only: true } }, { import_metadata: { historical_registration: true } },
    { import_metadata: { messages_enabled: false } }, { import_metadata: { automation_policy: 'hold' } },
    { import_metadata: { import: { automation_policy: 'hold' } } },
    { import_metadata: { cliniccloud_reconciliation: { automationPolicy: 'hold' } } },
  ]) assert.equal(operations.permitsPatientHoldOverride({ ...native, ...change },
    { execution: f.execution, policy: f.policy, now }), false, JSON.stringify(change));
  for (const change of [
    { created_at: '2026-10-06T10:59:59.000Z' }, { created_at: '2026-10-06T12:01:00.000Z' },
    { trigger_entity_type: 'patient' }, { trigger_type: 'lead_created' }, { clinic_id: 72 }, { trigger_entity_id: 11 },
    { context: { appointment: { ...f.execution.context.appointment, paciente_id: 21 } } },
    { context: { appointment: { ...f.execution.context.appointment, inicio: '2026-10-07T09:01:00.000Z' } } },
  ]) assert.equal(operations.permitsPatientHoldOverride(native,
    { execution: { ...f.execution, ...change }, policy: f.policy, now }), false, JSON.stringify(change));
  assert.equal(operations.permitsPatientHoldOverride(native, { execution: f.execution, policy: null, now }), false);
});

test('real historical activity is excluded even if an imported appointment date is later', () => {
  const f = fixture();
  for (const change of [
    { source_system: 'lead_resolution_historical' }, { source_system: 'clinicaclick_reactivation_import' },
    { titulo: 'Histórico: Tratamiento' }, { titulo: 'Historico: Tratamiento' },
    { motivo: 'Importación de pacientes para reactivación' }, { tipo_cita: 'historico_importado' },
    { import_metadata: { historical_registration: true } },
    { import_metadata: { historical_registration: 'true' } },
    { import_metadata: { imported_as_past_activity: true } },
    { import_metadata: { kind: 'lead_resolution_historical' } },
    { import_metadata: { kind: 'historical_treatment' } },
  ]) {
    assert.equal(operations.isHistorical({ ...f.appointment, ...change }), true);
    assert.equal(operations.allowsAppointment({ ...f.appointment, ...change }, { policy: f.policy, now }), false);
  }
  assert.equal(operations.isHistorical(f.appointment), false);
});

test('operational life-cycle continues after an appointment passes, without releasing pre-approval history', () => {
  const f = fixture();
  for (const estado of ['completada', 'cancelada', 'no_asistio', 'cambio_solicitado']) {
    assert.equal(operations.allowsAppointment({ ...f.appointment, estado, inicio: '2026-10-06T11:15:00.000Z' }, { policy: f.policy, now }), true);
  }
});

test('only importer technical boolean suppression can be overridden; every explicit manual choice stays intact', () => {
  const f = fixture();
  for (const raw of [
    { day_before: true, reason: 'manual_selection' }, { day_before: true, locked: true },
    { day_before: true, locked: false }, { day_before: true, manual_confirmation_required: true },
    { day_before: true, manual_confirmation_required: false }, { day_before: 'true' },
    { day_before: true, dayBefore: true }, { day_before: true, another_flag: true }, {},
  ]) assert.equal(operations.allowsSuppressionOverride({ ...f.appointment, import_metadata: {
    ...f.appointment.import_metadata, notification_suppression: raw,
  } }, { policy: f.policy, now }), false, JSON.stringify(raw));
  assert.equal(operations.allowsSuppressionOverride({ ...f.appointment, import_metadata: {
    notification_suppression: { day_before: true },
  } }, { policy: f.policy, now }), false);
});

test('transport permission requires the exact current reservation and a freshly created appointment execution', () => {
  const f = fixture();
  for (const change of [
    { trigger_entity_type: 'entity' }, { trigger_type: 'lead_created' }, { trigger_entity_id: 11 },
    { clinic_id: 72 }, { created_at: '2026-10-06T10:59:59.000Z' }, { created_at: '2026-10-06T12:01:00.000Z' },
    { context: { appointment: { ...f.execution.context.appointment, id_cita: 11 } } },
    { context: { appointment: { ...f.execution.context.appointment, clinica_id: 72 } } },
    { context: { appointment: { ...f.execution.context.appointment, paciente_id: 21 } } },
    { context: { appointment: { ...f.execution.context.appointment, inicio: '2026-10-07T09:01:00.000Z' } } },
    { context: {} },
  ]) assert.equal(operations.permits(f.appointment, { execution: { ...f.execution, ...change }, policy: f.policy, now }), false, JSON.stringify(change));
  assert.equal(operations.permits(f.appointment, { policy: f.policy, now }), false);
  assert.equal(operations.permits(f.appointment, { execution: { ...f.execution,
    context: JSON.stringify(f.execution.context), trigger_type: 'appointment_reminder_window' }, policy: f.policy, now }), true);
});

test('live registry is unavailable to DEV, ingress or unconfigured processes', () => {
  assert.equal(operations.read({}), null);
  assert.equal(operations.read({ WHATSAPP_AUTHORIZED_BROKER_CONFIG_FILE: '/etc/clinicaclick-whatsapp-authorized/dev/config.json' }), null);
  assert.equal(operations.read({ RUNTIME_ROLE: 'gateway', WHATSAPP_AUTHORIZED_BROKER_CONFIG_FILE: '/etc/clinicaclick-whatsapp-authorized/staging/config.json' }), null);
});

function replyFixture() {
  const f = fixture(), queries = [];
  const conversation = { id: 60, clinic_id: 66, patient_id: 20 };
  const message = { direction: 'inbound', conversation_id: 60, sent_at: '2026-10-06T11:55:00.000Z' };
  const db = { sequelize: { query: async (sql, options) => { queries.push({ sql, options }); return [[f.execution]]; } },
    CitaPaciente: { findByPk: async () => f.appointment } };
  return { ...f, queries, conversation, message, db };
}

test('fresh reply requires an accepted outbound in that conversation and the exact current live execution', async () => {
  const f = replyFixture();
  assert.equal(await operations.permitsReply(f.conversation, f.message, f.db, null, { policy: f.policy, now }), true);
  assert.match(f.queries[0].sql, /m.status IN \('sent','delivered','read'\)/);
  assert.match(f.queries[0].sql, /m.message_type<>'event'/);
  assert.match(f.queries[0].sql, /m.conversation_id=:conversationId/);
  assert.match(f.queries[0].sql, /m.sent_at>=:approvedAt AND m.sent_at<=:inboundAt/);
  assert.match(f.queries[0].sql, /e.status IN \('running','waiting'\)/);
  assert.equal(f.queries[0].options.replacements.conversationId, 60);
  assert.equal(f.queries[0].options.replacements.clinicId, 66);
});

test('fresh native booking reply may override its imported patient hold only after an accepted current outbound', async () => {
  const f = replyFixture(); Object.assign(f.appointment, { source_system: null, source_reference: null, import_metadata: {} });
  assert.equal(await operations.permitsReply(f.conversation, f.message, f.db, null, { policy: f.policy, now }), true);
  f.appointment.import_metadata = { import: { automation_policy: 'hold' } };
  assert.equal(await operations.permitsReply(f.conversation, f.message, f.db, null, { policy: f.policy, now }), false);
});

test('old, foreign and future inbound messages cannot open the release', async () => {
  const f = replyFixture();
  for (const message of [
    { ...f.message, sent_at: '2026-10-06T10:59:59.000Z' },
    { ...f.message, sent_at: '2026-10-06T12:01:00.000Z' },
    { ...f.message, direction: 'outbound' }, { ...f.message, conversation_id: 61 },
  ]) assert.equal(await operations.permitsReply(f.conversation, message, f.db, null, { policy: f.policy, now }), false);
  assert.equal(await operations.permitsReply({ ...f.conversation, clinic_id: 99 }, f.message, f.db, null, { policy: f.policy, now }), false);
  assert.equal(f.queries.length, 0);
});

test('replies never exempt a patient globally or resume stale, cancelled, past or completed executions', async () => {
  for (const change of [
    { paciente_id: 21 }, { clinica_id: 72 }, { inicio: '2026-10-07T10:00:00.000Z' },
    { inicio: '2026-10-06T11:15:00.000Z' }, { estado: 'cancelada' }, { estado: 'completada' },
    { estado: 'cambio_solicitado' }, { source_system: null },
  ]) {
    const f = replyFixture(); Object.assign(f.appointment, change);
    assert.equal(await operations.permitsReply(f.conversation, f.message, f.db, null, { policy: f.policy, now }), false, JSON.stringify(change));
  }
  const f = replyFixture(); f.execution.status = 'completed';
  assert.equal(await operations.permitsReply(f.conversation, f.message, f.db, null, { policy: f.policy, now }), false);
  const g = replyFixture(); g.execution.created_at = '2026-10-06T10:59:59.000Z';
  assert.equal(await operations.permitsReply(g.conversation, g.message, g.db, null, { policy: g.policy, now }), false);
});
