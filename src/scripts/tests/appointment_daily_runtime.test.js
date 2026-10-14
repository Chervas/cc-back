'use strict';

// Real scheduling runtime; only storage/queues are isolated doubles. No app
// model bootstrap, live registry, worker, database, environment or transport.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const operations = require('../../lib/whatsappImportedAppointmentOperations');
const daily = require('../../lib/appointment-reminder-sequence');
const source = fs.readFileSync(require.resolve('../../services/appointmentAutomationV2Runtime.service'), 'utf8');
const NOW = Date.parse('2026-10-14T12:00:00.000Z');
const appointment = (id_cita = 10, changes = {}) => ({ id_cita, clinica_id: 66, paciente_id: 20,
  doctor_id: 30, instalacion_id: 40, estado: 'info_confirmada',
  inicio: '2026-10-16T09:00:00.000Z', fin: '2026-10-16T09:30:00.000Z',
  created_at: '2026-10-01T09:00:00.000Z', source_system: null, source_reference: null,
  import_metadata: {}, ...changes });
const template = (id = 50, trigger_type = 'appointment_reminder_window', changes = {}) => ({
  id, clinic_id: 66, group_id: 29, template_key: 'isolated-template-' + id,
  trigger_type, trigger_config: { schedule_moment: 'day_before', schedule_time_mode: 'custom', custom_time: '09:00' },
  entry_node_id: 'N1', nodes: [], is_active: true, version: 1, published_at: '2026-10-01T09:00:00.000Z', ...changes,
});
const imported = (id = 10, changes = {}) => appointment(id, { source_system: 'cliniccloud',
  source_reference: 'isolated:' + id, import_metadata: { cliniccloud_reconciliation: { automation_policy: 'hold' },
    notification_suppression: { appointment_details: true, day_before: true, same_day: true } }, ...changes });

function fixture({ rows = [appointment()], templates = [template()], sameDayAllowed = true,
  linkedFollowers = [], rejectClaim = false } = {}) {
  let clock = NOW, nextExecution = 100, nextJob = 200;
  const state = { appointments: new Map(rows.map(row => [Number(row.id_cita), row])),
    executions: new Map(), jobs: new Map(), claims: new Map(), created: [], claimsCalled: [], cancelled: [] };
  const op = Object.fromEntries(['ne', 'or', 'in', 'and'].map(key => [key, Symbol(key)]));
  const policy = operations.validate({ version: 1, purpose: 'appointment_operations', approvedBy: 1,
    approvalRef: 'isolated-test-only', approvedAt: '2026-10-14T11:00:00.000Z',
    clinicIds: [66, 72], automaticBacklogReplay: false, sameDayAllowed }, { now: clock });
  const db = {
    Sequelize: { Op: op, literal: value => value },
    Clinica: { findByPk: async id => ({ id_clinica: id, grupoClinicaId: 29, configuracion: { timezone: 'Europe/Madrid' } }) },
    Paciente: { findByPk: async () => ({ idioma_preferido: 'es' }) },
    CitaPaciente: { findByPk: async id => state.appointments.get(Number(id)) || null },
    Tratamiento: { findByPk: async () => null },
    FlowExecutionV2: {
      findOne: async ({ where }) => [...state.executions.values()].find(row => row.idempotency_key === where.idempotency_key) || null,
      update: async (patch, { where }) => {
        const row = state.executions.get(Number(where.id));
        if (!row || !where.status[op.in].includes(row.status)) return [0];
        Object.assign(row, patch); return [1];
      },
    },
    JobRequest: { findAll: async ({ where }) => {
      const literal = where[op.and]?.[0], id = / = (\d+)$/.exec(literal || '')?.[1];
      return [...state.jobs.values()].filter(row => row.origin === where.origin
        && (!where.status || where.status[op.in].includes(row.status))
        && (!id || Number(row.payload.appointment_id) === Number(id)));
    } },
    AutomationFlowTemplateV2: { findAll: async ({ where }) => templates.filter(row => !where.trigger_type || row.trigger_type === where.trigger_type) },
    AutomationFlowCatalog: { findAll: async () => [] },
  };
  const inspect = async ({ appointment: supplied }) => {
    const row = state.appointments.get(Number(supplied.id_cita));
    if (!row) throw Error('isolated_appointment_missing');
    const scope = daily.dayScope(row, 'Europe/Madrid');
    const anchor = daily.selectAnchor([...state.appointments.values()], scope);
    return { anchor, anchor_appointment_id: anchor?.id_cita || null, scope,
      follower: !anchor || Number(anchor.id_cita) !== Number(row.id_cita),
      confirmedForReminder: [...state.appointments.values()].some(item => Number(item.clinica_id) === scope.clinic_id
        && Number(item.paciente_id) === scope.patient_id && daily.dayScope(item, 'Europe/Madrid').local_date === scope.local_date
        && ['info_confirmada', 'recordatorio_confirmado', 'completada'].includes(item.estado)),
      reason: 'appointment_day_uses_first_arrival' };
  };
  const sequence = { inspectAppointment: inspect, claimExecution: async input => {
    state.claimsCalled.push(input);
    const context = await inspect(input), key = daily.sequenceKey(context.scope) + ':' + input.scheduleMoment;
    const prior = state.claims.get(key);
    if (rejectClaim || context.follower || prior && prior !== Number(input.executionId)) {
      return { allowed: false, reason: 'appointment_day_stage_already_owned' };
    }
    state.claims.set(key, Number(input.executionId)); return { allowed: true };
  } };
  const managed = { managedVisit: async () => false, syncReminderIntents: async () => null, publishCita: async () => null };
  const jobs = {
    enqueueUniqueJobRequest: async data => {
      assert(data.type !== 'automations_v2_execute' || state.claims.size > 0
        || state.executions.get(Number(data.payload.execution_id))?.trigger_type !== 'appointment_reminder_window',
      'a reminder must claim the durable communication stage before queueing');
      let row = [...state.jobs.values()].find(item => item.dedupeScope && item.dedupeScope === data.dedupeScope);
      if (!row) { row = { id: nextJob++, status: 'pending', ...data }; state.jobs.set(row.id, row); }
      return { job: row };
    },
    enqueueJobRequest: async data => { const row = { id: nextJob++, status: 'pending', ...data }; state.jobs.set(row.id, row); return row; },
    matchesCurrentRuntimeNamespace: () => true,
    markCancelled: async (id, detail) => { state.cancelled.push({ id, detail }); state.jobs.get(Number(id)).status = 'cancelled'; },
  };
  const approval = { ...operations, read: () => policy };
  for (const name of ['allowsAppointment', 'allowsSameDayAppointment', 'allowsSuppressionOverride', 'permits', 'permitsSameDay', 'permitsPatientHoldOverride']) {
    approval[name] = (row, options) => operations[name](row, { ...options, policy, now: clock });
  }
  function loadRuntime() {
    class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } }
    const module = { exports: {} };
    vm.runInNewContext(source + '\nmodule.exports.__suppression = { getAppointmentNotificationSuppression, shouldSuppressAppointmentTrigger };', {
      module, Date: ClockDate, Intl, process: { env: {} }, require(name) {
        if (name === '../../models') return db;
        if (name === './appointmentReminderSequence.service') return { current: () => sequence };
        if (name === './appointmentVisitManaged.service') return { current: () => managed };
        if (name === './appointmentPatientLinks.service') return { follower: async (_db, id) => linkedFollowers.includes(Number(id)) };
        if (name === './jobRequests.service') return jobs;
        if (name === './jobScheduler.service') return { triggerImmediate: async () => {} };
        if (name === './socket.service') return { getIO: () => null };
        if (name === '../lib/whatsappImportedAppointmentOperations') return approval;
        if (name === '../lib/whatsappImportedReminderRelease') return { permits: () => false };
        if (name === '../lib/whatsappSameDayRecovery') return { allowsAppointment: () => false };
        if (name === '../lib/automation-runtime-stop') return {
          createExecution: async data => {
            if ([...state.executions.values()].some(row => row.idempotency_key === data.idempotency_key)) {
              throw Object.assign(Error('isolated_idempotency_duplicate'), { name: 'SequelizeUniqueConstraintError' });
            }
            const row = { id: nextExecution++, created_at: new ClockDate(), ...data };
            state.created.push(row); state.executions.set(row.id, row); return row;
          }, isStop: () => false,
        };
        if (['../lib/appointment-care', '../lib/appointment-synthetic-guard', '../lib/whatsapp-template-locale',
          '../lib/appointment-template-scope', '../lib/review-automation-config'].includes(name)) {
          return require(path.resolve(__dirname, '../../lib', name.slice('../lib/'.length)));
        }
        throw Error('unexpected_isolated_dependency:' + name);
      },
    }, { filename: 'appointmentAutomationV2Runtime.service.js' });
    return module.exports;
  }
  return { state, db, runtime: loadRuntime(), restart: loadRuntime, policy,
    now(value) { clock = Date.parse(value); }, row(id) { return state.appointments.get(Number(id)); } };
}

test('explicit same-day authorization reaches real scheduling while false/manual suppression stays closed', async () => {
  for (const sameDayAllowed of [false, true]) {
    const row = imported(), before = JSON.stringify(row);
    const f = fixture({ rows: [row], sameDayAllowed,
      templates: [template(50), template(51, 'appointment_reminder_window', {
        trigger_config: { schedule_moment: 'same_day', schedule_time_mode: 'custom', custom_time: '09:00' } })] });
    const result = await f.runtime.syncScheduledTriggersForCita(row);
    assert.equal(result.desired_count, sameDayAllowed ? 2 : 1);
    assert.equal(f.state.jobs.size, sameDayAllowed ? 2 : 1);
    assert.equal(JSON.stringify(row), before);
    assert.equal(f.runtime.__suppression.shouldSuppressAppointmentTrigger(row, 'appointment_reminder_window', { schedule_moment: 'same_day' }), !sameDayAllowed);
  }
  for (const patch of [{ reason: 'manual_selection' }, { locked: true }, { locked: false }, { manual_confirmation_required: true }, { sameDay: true }]) {
    const row = imported(); Object.assign(row.import_metadata.notification_suppression, patch);
    const f = fixture({ rows: [row] });
    assert.equal(f.runtime.__suppression.shouldSuppressAppointmentTrigger(row, 'appointment_reminder_window', { schedule_moment: 'same_day' }), true);
    assert.equal((await f.runtime.syncScheduledTriggersForCita(row)).desired_count, 0);
    assert.equal(f.state.jobs.size, 0);
  }
});

test('patient/clinic/day follower starts no reminder, without requiring or changing appointment links', async () => {
  const first = appointment(10), later = appointment(11, { inicio: '2026-10-16T10:00:00.000Z', fin: '2026-10-16T10:30:00.000Z' });
  const before = JSON.stringify([first, later]), f = fixture({ rows: [first, later] });
  assert.equal((await f.runtime.syncScheduledTriggersForCita(later)).desired_count, 0);
  assert.equal((await f.runtime.syncScheduledTriggersForCita(first)).desired_count, 1);
  const result = await f.runtime.enqueueExecutionForTemplate(later, template(), { event_name: 'appointment_reminder_window' });
  assert.equal(result.skipped, true); assert.equal(result.reason, 'appointment_day_uses_first_arrival');
  assert.equal(f.state.executions.size, 0); assert.equal(f.state.claims.size, 0);
  assert.equal(JSON.stringify([first, later]), before);
});

test('PRP first extraction can remind despite a clinical link follower; later treatment cannot remind', async () => {
  const extraction = appointment(11, { inicio: '2026-10-16T09:00:00.000Z', fin: '2026-10-16T09:15:00.000Z' });
  const parent = appointment(10, { inicio: '2026-10-16T09:15:00.000Z', fin: '2026-10-16T09:45:00.000Z' });
  const f = fixture({ rows: [parent, extraction], linkedFollowers: [11] });
  assert.equal((await f.runtime.syncScheduledTriggersForCita(extraction)).desired_count, 1);
  assert.equal((await f.runtime.syncScheduledTriggersForCita(parent)).desired_count, 0);
  assert.equal((await f.runtime.enqueueExecutionForTemplate(extraction, template(), { event_name: 'appointment_reminder_window', window_identifier: 'first-arrival' })).skipped, undefined);
  assert.equal((await f.runtime.enqueueExecutionForTemplate(parent, template(), { event_name: 'appointment_reminder_window', window_identifier: 'later-prp' })).skipped, true);
  assert.equal(f.state.claims.size, 1); assert.equal(f.state.executions.size, 1);
  // Details still respect the pre-existing clinical linked first-notice policy.
  assert.equal((await f.runtime.enqueueExecutionForTemplate(extraction, template(52, 'appointment_created'), { event_name: 'appointment_created' })).reason,
    'linked_appointment_uses_first_notice');
});

test('daily reminder grouping leaves genuine completed aftercare scheduling unchanged', async () => {
  const first = appointment(10, { inicio: '2026-10-14T09:00:00.000Z', fin: '2026-10-14T09:30:00.000Z' });
  const completed = appointment(11, { inicio: '2026-10-14T10:00:00.000Z', fin: '2026-10-14T10:30:00.000Z', estado: 'completada',
    care_schedule_start: '2026-10-14T10:00:00.000Z', arrived_at: '2026-10-14T10:00:00.000Z',
    care_started_at: '2026-10-14T10:02:00.000Z', care_completed_at: '2026-10-14T10:30:00.000Z' });
  const after = template(52, 'appointment_after', { trigger_config: { schedule_moment: 'day_after', schedule_time_mode: 'custom', custom_time: '09:00' } });
  const f = fixture({ rows: [first, completed], templates: [template(), after] });
  const result = await f.runtime.syncScheduledTriggersForCita(completed);
  assert.equal(result.desired_count, 1);
  assert.equal([...f.state.jobs.values()][0].payload.trigger_type, 'appointment_after');
  assert.equal([...f.state.jobs.values()][0].payload.scheduled_for, '2026-10-15T07:00:00.000Z');
  assert.equal(f.state.claims.size, 0);
});

test('pending duplicate fire is checked again against first arrival and cancels stale follower scheduling', async () => {
  const first = appointment(10), later = appointment(11, { inicio: '2026-10-16T10:00:00.000Z', fin: '2026-10-16T10:30:00.000Z' });
  const f = fixture({ rows: [first, later] });
  f.state.jobs.set(99, { id: 99, status: 'waiting', origin: 'appointment_automation_schedule', payload: {
    appointment_id: 11, trigger_type: 'appointment_reminder_window', template_key: template().template_key,
    window_identifier: 'legacy-independent-later', scheduled_for: '2026-10-15T07:00:00.000Z' } });
  assert.equal((await f.runtime.syncScheduledTriggersForCita(later)).cancelled_jobs[0], 99);
  assert.equal(f.state.jobs.get(99).status, 'cancelled');
  const result = await f.runtime.fireScheduledTrigger({ appointment_id: 11, trigger_type: 'appointment_reminder_window', template_key: template().template_key });
  assert.equal(result.reason, 'appointment_day_uses_first_arrival');
  assert.equal(f.state.created.length, 0); assert.equal(f.state.claims.size, 0);
});

test('one stage and queue survive simultaneous calls, confirmation/column edits and a runtime restart', async () => {
  const row = appointment(), f = fixture({ rows: [row] }), options = { event_name: 'appointment_reminder_window', window_identifier: 'same-day-fixed-window' };
  const results = await Promise.all(Array.from({ length: 6 }, () => f.runtime.enqueueExecutionForTemplate(row, template(), options)));
  assert.equal(new Set(results.map(result => result.execution.id)).size, 1);
  assert.equal(f.state.created.length, 1); assert.equal(f.state.claims.size, 1); assert.equal(f.state.jobs.size, 1);
  Object.assign(row, { estado: 'recordatorio_confirmado', doctor_id: 31, instalacion_id: 42 });
  const restarted = f.restart();
  assert.equal((await restarted.enqueueExecutionForTemplate(row, template(), options)).deduplicated, true);
  assert.equal(f.state.created.length, 1); assert.equal(f.state.claims.size, 1); assert.equal(f.state.jobs.size, 1);
  const otherVersion = await restarted.enqueueExecutionForTemplate(row, template(51), options);
  assert.equal(otherVersion.skipped, true); assert.equal(otherVersion.reason, 'appointment_day_stage_already_owned');
  assert.equal(otherVersion.execution.status, 'cancelled'); assert.equal(f.state.jobs.size, 1);
});

test('claim race denial prevents executor queueing while ordinary appointment-created behavior remains independent', async () => {
  const row = appointment(), f = fixture({ rows: [row], rejectClaim: true });
  const denied = await f.runtime.enqueueExecutionForTemplate(row, template(), { event_name: 'appointment_reminder_window' });
  assert.equal(denied.skipped, true); assert.equal(denied.execution.status, 'cancelled');
  assert.equal(f.state.jobs.size, 0); assert.equal(f.state.claims.size, 0);
  const created = await f.runtime.enqueueExecutionForTemplate(row, template(52, 'appointment_created'), { event_name: 'appointment_created' });
  assert.equal(created.skipped, undefined); assert.equal(f.state.jobs.size, 1);
  assert.equal(f.state.claimsCalled.length, 1);
});
