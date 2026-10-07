'use strict';

// Run the real runtime in a sandbox: no application models, workers, live
// approval registry, WhatsApp transport or patient data are loaded by this test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const operations = require('../../lib/whatsappImportedAppointmentOperations');
const source = fs.readFileSync(require.resolve('../../services/appointmentAutomationV2Runtime.service'), 'utf8');
const now = Date.parse('2026-10-06T12:00:00.000Z');
const policy = operations.validate({
  version: 1, purpose: 'appointment_operations', approvedBy: 1,
  approvalRef: 'user_approval_20261006', approvedAt: '2026-10-06T11:00:00.000Z',
  clinicIds: [66, 72], automaticBacklogReplay: false, sameDayAllowed: false,
}, { now });

class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
}

function appointment(clinica_id = 66, changes = {}) {
  return {
    id_cita: 10, clinica_id, paciente_id: 20, doctor_id: 30,
    estado: 'reprogramada', reschedule_reason: 'patient_request',
    inicio: '2026-10-08T09:00:00.000Z', fin: '2026-10-08T09:35:00.000Z',
    source_system: 'cliniccloud', source_reference: 'cliniccloud:synthetic:10',
    import_metadata: {
      source_account: 'synthetic-source-account', source_appointment_id: '10',
      cliniccloud_reconciliation: { automation_policy: 'hold' },
      notification_suppression: { appointment_details: true, day_before: true, same_day: true },
    },
    ...changes,
  };
}

function template(trigger_type = 'appointment_rescheduled', trigger_config = null) {
  return { id: 40, clinic_id: 66, group_id: 29, template_key: 'synthetic-reschedule',
    trigger_type, trigger_config, entry_node_id: 'N1', nodes: [],
    is_active: true, version: 1, published_at: new FixedDate('2026-10-05T09:00:00.000Z') };
}

function fixture(approval = policy, { cita = appointment(), templates = [], reminderPermitted = false } = {}) {
  const creations = [], jobs = [];
  const op = Object.fromEntries(['ne', 'or', 'in', 'and'].map(key => [key, Symbol(key)]));
  const db = {
    Sequelize: { Op: op, literal: value => value },
    Clinica: { findByPk: async id => ({ id_clinica: id, grupoClinicaId: 29, configuracion: { timezone: 'Europe/Madrid' } }) },
    Paciente: { findByPk: async () => ({ idioma_preferido: 'es' }) },
    CitaPaciente: { findByPk: async () => cita },
    FlowExecutionV2: { findOne: async () => null },
    JobRequest: { findAll: async () => [] },
    AutomationFlowTemplateV2: { findAll: async options => templates.filter(row => row.trigger_type === options.where.trigger_type) },
    AutomationFlowCatalog: { findAll: async () => [] },
  };
  const managed = require('../../services/appointmentVisitManaged.service').createAppointmentVisitManagedService({ db, enabled: () => false });
  const approvedOperations = {
    ...operations,
    read: () => approval,
    allowsAppointment: (a, options) => operations.allowsAppointment(a, { ...options, policy: approval, now }),
    allowsSuppressionOverride: (a, options) => operations.allowsSuppressionOverride(a, { ...options, policy: approval, now }),
    permits: (a, options) => operations.permits(a, { ...options, policy: approval, now }),
  };
  const module = { exports: {} };
  const context = {
    module, exports: module.exports, Date: FixedDate, Intl, process: { env: {} },
    require(name) {
      if (name === '../../models') return db;
      if (name === './appointmentVisitManaged.service') return { current: () => managed };
      if (name === './socket.service') return { getIO: () => null };
      if (name === './jobRequests.service') return {
        enqueueUniqueJobRequest: async data => { jobs.push(data); return { job: { id: 60 } }; },
        enqueueJobRequest: async data => { jobs.push(data); return { id: 60 }; },
        matchesCurrentRuntimeNamespace: () => true,
        markCancelled: async () => {},
      };
      if (name === './jobScheduler.service') return { triggerImmediate: async () => {} };
      if (name === '../lib/whatsappImportedAppointmentOperations') return approvedOperations;
      if (name === '../lib/whatsappImportedReminderRelease') return { permits: () => reminderPermitted };
      if (name === '../lib/appointment-synthetic-guard') return require('../../lib/appointment-synthetic-guard');
      if (name === '../lib/automation-runtime-stop') return {
        createExecution: async data => { creations.push(data); return { id: 50, created_at: new FixedDate(), ...data }; },
        isStop: () => false,
      };
      if (['../lib/whatsapp-template-locale', '../lib/appointment-template-scope', '../lib/review-automation-config'].includes(name)) {
        return require(path.resolve(__dirname, '../../lib', name.slice('../lib/'.length)));
      }
      throw Error('unexpected_dependency:' + name);
    },
  };
  vm.runInNewContext(source + '\nmodule.exports.__helpers = { isImportedHistoricalAppointment, importedTriggerHeld, getAppointmentNotificationSuppression, shouldSuppressAppointmentTrigger };',
    context, { filename: 'appointmentAutomationV2Runtime.service.js' });
  return { runtime: module.exports, helpers: module.exports.__helpers, creations, jobs };
}

for (const clinicId of [66, 72]) {
  test(`future operational ClinicCloud appointment in clinic ${clinicId} is not historical or held for rescheduling`, async () => {
    const f = fixture(), a = appointment(clinicId), before = JSON.stringify(a);
    assert.equal(f.helpers.isImportedHistoricalAppointment(a), false);
    assert.equal(f.helpers.importedTriggerHeld(a, template()), false);
    assert.equal(f.helpers.shouldSuppressAppointmentTrigger(a, 'appointment_rescheduled'), false);
    const result = await f.runtime.enqueueExecutionForTemplate(a, template(), { event_name: 'appointment_rescheduled' });
    assert.equal(result.success, true);
    assert.equal(result.skipped, undefined);
    assert.equal(f.creations.length, 1);
    assert.equal(f.creations[0].clinic_id, clinicId);
    assert.equal(f.creations[0].trigger_type, 'appointment_rescheduled');
    assert.equal(f.creations[0].trigger_entity_id, a.id_cita);
    assert.equal(f.creations[0].context.appointment.inicio, a.inicio);
    assert.equal(f.creations[0].context.appointment.reschedule_reason, 'patient_request');
    assert.equal(f.jobs.length, 1);
    assert.equal(JSON.stringify(a), before, 'the release must not erase import provenance or suppression receipts');
  });
}

test('native and imported QA reservations never enqueue, including an exact day-before release', async () => {
  const markers = [{ qa_demo: { case: 'no-delivery' } }, { synthetic_data_only: true },
    { import: { __simulation: true } }, { cliniccloud_source_booking: { is_test: true } }];
  for (const imported of [false, true]) for (const marker of markers) {
    const a = appointment(66, { source_system: imported ? 'cliniccloud' : null,
      source_reference: imported ? 'synthetic-source' : null, import_metadata: marker });
    const f = fixture(policy, { cita: a, reminderPermitted: true });
    assert.equal(f.helpers.isImportedHistoricalAppointment(a), true);
    assert.equal(f.helpers.importedTriggerHeld(a,
      template('appointment_reminder_window', { schedule_moment: 'day_before' })), true);
    assert.equal((await f.runtime.enqueueExecutionForCita(a)).skipped, true);
    assert.equal((await f.runtime.enqueueExecutionForTemplate(a, template())).skipped, true);
    assert.equal(f.creations.length, 0); assert.equal(f.jobs.length, 0);
  }
});

test('the release does not depend on the old exact-time day-before reservation list', () => {
  const f = fixture(), a = appointment();
  a.inicio = '2026-10-09T12:15:00.000Z';
  a.fin = '2026-10-09T12:50:00.000Z';
  assert.equal(f.helpers.isImportedHistoricalAppointment(a), false);
  assert.equal(f.helpers.importedTriggerHeld(a, template()), false);
  assert.equal(f.helpers.importedTriggerHeld(a, template('appointment_reminder_window', { schedule_moment: 'day_before' })), false);
});

test('other clinics, pre-approval appointments and genuinely historical imports remain held', async () => {
  const f = fixture();
  const changes = [
    { clinica_id: 35 },
    { inicio: '2026-10-06T10:59:59.999Z' },
    { source_system: 'lead_resolution_historical' },
    { source_system: 'clinicaclick_reactivation_import' },
    { motivo: 'Importación de pacientes para reactivación' },
    { titulo: 'Histórico: sesión anterior' },
    { import_metadata: { historical_registration: true } },
    { import_metadata: { imported_as_past_activity: true } },
    { import_metadata: { kind: 'historical_treatment' } },
  ];
  for (const change of changes) {
    const a = appointment(66, change), before = JSON.stringify(a);
    assert.equal(f.helpers.isImportedHistoricalAppointment(a), true, JSON.stringify(change));
    assert.equal(f.helpers.importedTriggerHeld(a, template()), true, JSON.stringify(change));
    const result = await f.runtime.enqueueExecutionForTemplate(a, template(), { event_name: 'appointment_rescheduled' });
    assert.equal(result.reason, 'imported_historical_appointment');
    assert.equal(JSON.stringify(a), before);
  }
  assert.equal(f.creations.length, 0);
  assert.equal(f.jobs.length, 0);
});

test('absent operational approval fails closed, including the imported appointment creation guard', async () => {
  const f = fixture(null), a = appointment();
  assert.equal(f.helpers.isImportedHistoricalAppointment(a), true);
  assert.equal(f.helpers.importedTriggerHeld(a, template()), true);
  assert.equal(f.helpers.shouldSuppressAppointmentTrigger(a, 'appointment_created'), true);
  const result = await f.runtime.enqueueExecutionForCita(a, { event_name: 'appointment_rescheduled' });
  assert.equal(result.reason, 'imported_historical_appointment');
  assert.equal(f.creations.length, 0);
});

test('only technical import defaults release appointment details and day-before, never same-day', () => {
  const f = fixture();
  for (const serialized of [false, true]) {
    const a = appointment();
    if (serialized) a.import_metadata = JSON.stringify(a.import_metadata);
    const before = JSON.stringify(a);
    assert.equal(f.helpers.shouldSuppressAppointmentTrigger(a, 'appointment_created'), false);
    assert.equal(f.helpers.shouldSuppressAppointmentTrigger(a, 'appointment_reminder_window'), false);
    assert.equal(f.helpers.shouldSuppressAppointmentTrigger(a, 'appointment_reminder_window', { schedule_moment: 'day_before' }), false);
    assert.equal(f.helpers.shouldSuppressAppointmentTrigger(a, 'appointment_reminder_window', { schedule_moment: 'same_day' }), true);
    assert.equal(JSON.stringify(a), before);
  }
  const a = appointment();
  a.import_metadata.notification_suppression = { appointment_details: false, day_before: false, same_day: false };
  assert.equal(f.helpers.shouldSuppressAppointmentTrigger(a, 'appointment_reminder_window', { schedule_moment: 'same_day' }), true);
});

for (const flag of [
  { reason: 'manual_selection' }, { locked: true }, { manual_confirmation_required: true },
  { locked: false }, { appointmentDetails: true }, { custom_manual_suppression: true },
]) {
  test(`manual, locked or unknown suppression is preserved: ${JSON.stringify(flag)}`, () => {
    const f = fixture(), a = appointment();
    Object.assign(a.import_metadata.notification_suppression, flag);
    const before = JSON.stringify(a);
    assert.equal(f.helpers.shouldSuppressAppointmentTrigger(a, 'appointment_created'), true);
    assert.equal(f.helpers.shouldSuppressAppointmentTrigger(a, 'appointment_reminder_window', { schedule_moment: 'day_before' }), true);
    assert.equal(f.helpers.shouldSuppressAppointmentTrigger(a, 'appointment_reminder_window', { schedule_moment: 'same_day' }), true);
    assert.equal(JSON.stringify(a), before);
  });
}

test('ordinary native appointments and suppression without import-hold evidence retain their existing behavior', () => {
  const f = fixture(), native = appointment(66, { source_system: null, source_reference: null, import_metadata: {} });
  assert.equal(f.helpers.isImportedHistoricalAppointment(native), false);
  assert.equal(f.helpers.shouldSuppressAppointmentTrigger(native, 'appointment_created'), false);
  assert.equal(f.helpers.shouldSuppressAppointmentTrigger(native, 'appointment_reminder_window', { schedule_moment: 'same_day' }), false);
  const importedWithoutHold = appointment();
  delete importedWithoutHold.import_metadata.cliniccloud_reconciliation;
  assert.equal(f.helpers.shouldSuppressAppointmentTrigger(importedWithoutHold, 'appointment_created'), true);
  assert.equal(f.helpers.shouldSuppressAppointmentTrigger(importedWithoutHold, 'appointment_reminder_window', { schedule_moment: 'day_before' }), true);
});

test('synchronizing a future imported appointment schedules day-before but never same-day', async () => {
  const beforeTemplate = { ...template('appointment_reminder_window', { schedule_moment: 'day_before', custom_time: '09:00' }),
    template_key: 'synthetic-day-before' };
  const sameDayTemplate = { ...template('appointment_reminder_window', { schedule_moment: 'same_day', custom_time: '09:00' }),
    id: 41, template_key: 'synthetic-same-day' };
  const a = appointment(), before = JSON.stringify(a);
  const f = fixture(policy, { cita: a, templates: [beforeTemplate, sameDayTemplate] });
  const result = await f.runtime.syncScheduledTriggersForCita(a);
  assert.equal(result.success, true);
  assert.equal(result.desired_count, 1);
  assert.equal(result.scheduled_jobs.length, 1);
  assert.equal(f.jobs.length, 1);
  assert.equal(f.jobs[0].payload.template_key, beforeTemplate.template_key);
  assert.equal(f.jobs[0].payload.scheduled_for, '2026-10-07T07:00:00.000Z');
  assert.equal(f.creations.length, 0);
  assert.equal(JSON.stringify(a), before);
});

test('a pending future day-before job survives the new operational import gate', async () => {
  const t = { ...template('appointment_reminder_window', { schedule_moment: 'day_before', custom_time: '09:00' }),
    template_key: 'synthetic-day-before' };
  const f = fixture(policy, { templates: [t] });
  const result = await f.runtime.fireScheduledTrigger({ appointment_id: 10, trigger_type: t.trigger_type, template_key: t.template_key });
  assert.equal(result.success, true);
  assert.equal(result.waiting, true);
  assert.equal(result.scheduled_for, '2026-10-07T07:00:00.000Z');
  assert.equal(f.creations.length, 0);
});

test('an already queued same-day imported job is rejected before execution creation', async () => {
  const t = template('appointment_reminder_window', { schedule_moment: 'same_day', custom_time: '09:00' });
  const f = fixture(policy, { templates: [t] });
  const result = await f.runtime.fireScheduledTrigger({ appointment_id: 10, trigger_type: t.trigger_type, template_key: t.template_key });
  assert.equal(result.reason, 'appointment_notification_suppressed');
  assert.equal(result.skipped, true);
  assert.equal(f.creations.length, 0);
  assert.equal(f.jobs.length, 0);
});

test('a scheduled window preceding operational approval is not replayed even inside normal fire grace', async () => {
  const latePolicy = operations.validate({ ...policy, approvedAt: '2026-10-06T11:55:00.000Z' }, { now });
  const t = template('appointment_reminder_window', { schedule_moment: 'day_before', custom_time: '13:54' });
  const a = appointment(66, { inicio: '2026-10-07T15:00:00.000Z', fin: '2026-10-07T15:35:00.000Z' });
  const f = fixture(latePolicy, { cita: a, templates: [t] });
  const result = await f.runtime.fireScheduledTrigger({ appointment_id: 10, trigger_type: t.trigger_type, template_key: t.template_key });
  assert.equal(result.reason, 'imported_appointment_backlog_not_authorized');
  assert.equal(result.skipped, true);
  assert.equal(f.creations.length, 0);
  assert.equal(f.jobs.length, 0);
});
