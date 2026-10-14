'use strict';

// Real inbound resume code with storage/queue doubles only. Never bootstraps
// application models, reads configuration, opens sockets or sends messages.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const daily = require('../../lib/appointment-reminder-sequence');
const source = fs.readFileSync(require.resolve('../../services/automationsV2Resume.service'), 'utf8');
const appointment = (id_cita = 10, changes = {}) => ({ id_cita, clinica_id: 66, paciente_id: 7,
  inicio: '2030-01-11T12:00:00.000Z', estado: 'recordatorio_enviado', es_provisional: false,
  import_metadata: { cliniccloud_reconciliation: { automation_policy: 'hold' } }, ...changes });
function execution(id, a, changes = {}) {
  return { id, clinic_id: a.clinica_id, status: 'waiting', trigger_type: 'appointment_reminder_window',
    trigger_entity_type: 'appointment', trigger_entity_id: a.id_cita, current_node_id: 'WAIT',
    created_at: '2030-01-10T08:00:00.000Z', waiting_meta: { runtime_namespace: 'staging' },
    context: { conversation: { id: 71 }, appointment: { id_cita: a.id_cita, clinica_id: a.clinica_id,
      paciente_id: a.paciente_id, inicio: a.inicio }, trigger: { schedule_moment: 'day_before' } },
    templateVersion: { nodes: [{ id: 'WAIT', type: 'delay/wait_response', config: { response_buffer_enabled: false } }] },
    ...changes };
}
function fixture({ rows = [appointment(), appointment(11, { inicio: '2030-01-11T12:15:00.000Z' })],
  executions = null, claims = {}, dailyError = null, role = 'api', media = null } = {}) {
  const state = { rows: new Map(rows.map(row => [row.id_cita, structuredClone(row)])), updates: [], jobs: [], emits: [],
    inspectCalls: [], appointmentReads: [], callbacks: [], sqlReads: [] };
  state.executions = (executions || [execution(50, rows[0]), execution(51, rows[1])]).map(row => ({ ...structuredClone(row),
    async update(patch) { state.updates.push({ id: this.id, patch: structuredClone(patch) }); Object.assign(this, patch); } }));
  const op = Object.fromEntries(['in','gte','or'].map(key => [key, Symbol(key)]));
  const db = { Sequelize: { Op: op }, AutomationFlowTemplateV2: {}, JobRequest: {},
    FlowExecutionV2: { findAll: async options => state.executions.filter(row => row.status === options.where.status
      && row.clinic_id === options.where.clinic_id) },
    CitaPaciente: { findByPk: async (id, options) => { state.appointmentReads.push({ id, options }); return structuredClone(state.rows.get(Number(id))); } },
    Message: { findByPk: async id => ({ id, metadata: media ? { media } : {} }) },
    sequelize: { QueryTypes: { SELECT: 'select' }, query: async (sql, options) => { state.sqlReads.push({ sql, options }); return []; } },
  };
  const sequence = { inspectAppointment: async ({ appointment: supplied }) => {
    state.inspectCalls.push(supplied.id_cita); if (dailyError) throw Error(dailyError);
    const scope = daily.dayScope(supplied, 'Europe/Madrid');
    const appointments = [...state.rows.values()].filter(row => row.clinica_id === scope.clinic_id && row.paciente_id === scope.patient_id
      && daily.dayScope(row, scope.time_zone).local_date === scope.local_date);
    const anchor = daily.selectAnchor(appointments, scope);
    return { scope, appointments, anchor_appointment_id: anchor?.id_cita,
      sequence: Object.keys(claims).length ? { claims } : null };
  } };
  const module = { exports: {} };
  vm.runInNewContext(source, { module, Date, Intl, process: { env: { RUNTIME_ROLE: role,
    JOB_RUNTIME_NAMESPACE: 'staging', AUTOMATIONS_V2_MEDIA_RESPONSE_RUNTIMES: 'staging' }, cwd: () => '/fictitious' }, require(name) {
    if (name === '../../models') return db;
    if (name === '../lib/appointment-reminder-sequence') return daily;
    if (name === '../lib/phone') return { normalizePhoneDigits: value => String(value || '').replace(/\D/g, '') };
    if (name === './appointmentReminderSequence.service') return { current: () => sequence };
    if (name === './jobRequests.service') return { getCurrentRuntimeNamespace: () => 'staging',
      enqueueUniqueJobRequest: async data => { state.jobs.push(data); return { created: true, job: { id: 100 } }; },
      markCancelled: async (...args) => state.callbacks.push(args) };
    if (name === './jobScheduler.service') return { triggerImmediate: async () => {} };
    if (name === './conversationPendingReply.service') return { emitAutomationResponseProcessing: data => state.emits.push(data) };
    if (name === './conversationAutomationState.service') return { setState: async data => state.callbacks.push(data) };
    throw Error('UNEXPECTED_OFFLINE_DEPENDENCY:' + name);
  } }, { filename: 'automationsV2Resume.service.js' });
  return { state, run: changes => module.exports.enqueueInboundResponseResume({ clinicId: 66, conversationId: 71,
    patientId: 7, inboundMessageId: 200, messageText: 'Fictitious offline reply', ...changes }) };
}

test('legacy PRP duplicate reply resumes existing extraction first-arrival wait without changing reservations or HOLDs', async () => {
  const f = fixture(), before = JSON.stringify([...f.state.rows.values()]);
  const result = await f.run();
  assert.deepEqual(Array.from(result.execution_ids), [50]);
  assert.deepEqual(Array.from(result.superseded_execution_ids), [51]);
  assert.equal(f.state.jobs.length, 1); assert.equal(f.state.jobs[0].payload.execution_id, 50);
  assert.equal(f.state.updates[0].patch.waiting_meta.cancelled_reason, 'superseded_by_patient_day_response_owner');
  assert.equal(JSON.stringify([...f.state.rows.values()]), before);
  assert.equal(f.state.appointmentReads[0].options.attributes.includes('nota'), false);
});
test('different local day, stage or newest non-reminder preserves latest verified reply selection and old cancellation reason', async () => {
  for (const scenario of ['day','stage','intent']) {
    const first = appointment(), later = appointment(11, { inicio: scenario === 'day' ? '2030-01-12T12:15:00.000Z' : '2030-01-11T12:15:00.000Z' });
    const newest = execution(51, later);
    if (scenario === 'stage') newest.context.trigger.schedule_moment = 'same_day';
    if (scenario === 'intent') newest.trigger_type = 'appointment_created';
    const f = fixture({ rows: [first, later], executions: [execution(50, first), newest] });
    assert.deepEqual(Array.from((await f.run()).execution_ids), [51], scenario);
    assert.equal(f.state.updates[0].patch.waiting_meta.cancelled_reason, 'superseded_by_newer_waiting_execution');
    if (scenario === 'intent') assert.equal(f.state.inspectCalls.length, 0);
  }
});
test('same-day preference cannot choose wrong namespace, stale slot, cancelled or provisional first-arrival instance', async () => {
  for (const scenario of ['namespace','stale','cancelled','provisional','foreign_patient','missing_identity']) {
    const first = appointment(), later = appointment(11, { inicio: '2030-01-11T12:15:00.000Z' });
    const firstWait = execution(50, first);
    if (scenario === 'namespace') firstWait.waiting_meta.runtime_namespace = 'dev';
    if (scenario === 'stale') firstWait.context.appointment.inicio = '2030-01-11T11:59:00.000Z';
    if (scenario === 'cancelled') first.estado = 'cancelada';
    if (scenario === 'provisional') first.es_provisional = true;
    if (scenario === 'foreign_patient') first.paciente_id = 8;
    if (scenario === 'missing_identity') delete firstWait.context.appointment.id_cita;
    const f = fixture({ rows: [first, later], executions: [firstWait, execution(51, later)] });
    assert.deepEqual(Array.from((await f.run()).execution_ids), [51], scenario);
  }
});
test('no compatible wait or unavailable diagnostic ledger keeps old reply behavior without new executions', async () => {
  for (const scenario of ['missing_wait','paused','read_error','unscoped_runtime']) {
    const first = appointment(), later = appointment(11, { inicio: '2030-01-11T12:15:00.000Z' });
    const firstWait = execution(50, first), newest = execution(51, later);
    if (scenario === 'missing_wait') firstWait.current_node_id = 'NOT_A_WAIT';
    if (scenario === 'paused') firstWait.status = 'paused';
    if (scenario === 'unscoped_runtime') delete newest.waiting_meta.runtime_namespace;
    const f = fixture({ rows: [first, later], executions: [firstWait, newest], dailyError: scenario === 'read_error' ? 'PRIVATE_SQL_FAILURE' : null });
    assert.deepEqual(Array.from((await f.run()).execution_ids), [51], scenario);
    assert.equal(f.state.executions.length, 2); assert.equal(f.state.jobs.length, 1);
  }
});
test('durable stage owner is preferred among compatible canonical waits and can continue when no canonical wait exists', async () => {
  const first = appointment(), middle = appointment(11, { inicio: '2030-01-11T12:15:00.000Z' }), last = appointment(12, { inicio: '2030-01-11T12:30:00.000Z' });
  const claim = id => ({ day_before: { execution_id: id, appointment_id: id === 50 ? 10 : 11,
    claimed_at: '2030-01-10T08:00:00.000Z', message_id: 101, attempted: true } });
  const canonical = fixture({ rows: [first, middle], executions: [execution(50, first), execution(52, first), execution(53, middle)], claims: claim(50) });
  assert.deepEqual(Array.from((await canonical.run()).execution_ids), [50]);
  const olderOwner = fixture({ rows: [first, middle, last], executions: [execution(51, middle), execution(53, last)], claims: claim(51) });
  assert.deepEqual(Array.from((await olderOwner.run()).execution_ids), [51]);
});
test('existing matching prechecks exclude media runtime and non-response nodes before owner preference', async () => {
  const first = appointment(), later = appointment(11, { inicio: '2030-01-11T12:15:00.000Z' });
  const inaccessible = execution(50, first); inaccessible.waiting_meta.runtime_namespace = 'dev';
  const f = fixture({ rows: [first, later], executions: [inaccessible, execution(51, later)], role: 'gateway', media: { kind: 'image', id: 'fictitious' } });
  assert.deepEqual(Array.from((await f.run({ messageText: '' })).execution_ids), [51]);
  assert.equal(f.state.updates.length, 0, 'an inaccessible/unmatched instance must not be superseded by this reply');
});
