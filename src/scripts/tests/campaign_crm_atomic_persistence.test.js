'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { persistLeadWithCrmSignals, enqueueCreatedAppointmentCrmSignals } = require('../../services/leadCrmSignalPersistence.service');
const { maybeUploadLeadLifecycleConversion } = require('../../services/leadLifecycleConversion.service');
const { CRM_MILESTONE_SOURCE } = require('../../services/campaignWorkspaceSignalPolicy.service');
const { createAppointmentWithPatientLanguage } = require('../../lib/patient-language');

function harness() {
  const now = new Date('2026-09-10T21:00:00Z');
  const state = { transactions: 0, reloads: [], queueCalls: [], external: [], rollback: false,
    committed: {
      lead: { id: 1, clinica_id: 2, source: 'meta_ads', status_lead: 'contactado', updated_at: now, campana_id: 42 },
      appointment: { id_cita: 3, clinica_id: 2, lead_intake_id: null, estado: 'pendiente', campana_id: null, created_at: now },
      jobs: [], patient: { idioma_preferido: 'es' },
    } };
  const sequelize = { transaction: async (options, work) => {
    if (typeof options === 'function') work = options;
    const callbacks = []; const transaction = { staged: structuredClone(state.committed), LOCK: { UPDATE: 'UPDATE' },
      afterCommit: cb => callbacks.push(cb) };
    state.transactions++;
    try {
      const result = await work(transaction);
      if (state.failCommit) throw new Error('commit rejected');
      state.committed = transaction.staged;
      for (const cb of callbacks) await cb();
      return result;
    } catch (error) { state.rollback = true; throw error; }
  } };
  function instance(key) {
    const row = { ...structuredClone(state.committed[key]) };
    row.reload = async options => {
      assert.equal(options.lock, 'UPDATE'); state.reloads.push(key);
      Object.assign(row, structuredClone(options.transaction.staged[key])); return row;
    };
    row.update = async (patch, options) => {
      const target = options?.transaction?.staged || state.committed;
      Object.assign(target[key], structuredClone(patch), { updated_at: now });
      Object.assign(row, structuredClone(target[key])); return row;
    };
    row.get = () => Object.fromEntries(Object.entries(row).filter(([, value]) => typeof value !== 'function'));
    return row;
  }
  const lead = instance('lead'); const appointment = instance('appointment');
  const dependencies = { models: { sequelize }, env: { CAMPAIGN_WORKSPACE_ACTIVATION_ENABLED: 'true' }, now: () => now,
    enqueue: async (input, options) => {
      assert.ok(options.transaction); assert.equal(input.crmEventSource, CRM_MILESTONE_SOURCE);
      state.queueCalls.push(input);
      if (state.failEvent === input.eventName) throw new Error('queue unavailable');
      if (state.denied) return { queued: false, reason: 'meta_crm_consent_required' };
      const jobs = options.transaction.staged.jobs;
      jobs.push({ eventId: input.eventId, eventName: input.eventName });
      return { queued: true, jobId: jobs.length };
    } };
  const run = changes => persistLeadWithCrmSignals({ lead, changes: changes || { status_lead: 'cualificado' }, dependencies });
  const link = () => persistLeadWithCrmSignals({ lead, appointment, changes: { status_lead: 'citado', call_outcome_appointment_id: 3 }, dependencies });
  const googleHook = eventId => maybeUploadLeadLifecycleConversion({ lead, eventId,
    eventName: eventId.startsWith('appointment') ? 'schedule' : 'qualified_lead', occurredAt: now,
    dependencies: { enqueueMeta: async () => { state.external.push('unexpected enqueue'); return { queued: false }; },
      google: async () => { state.external.push('google'); return { sent: true }; } } });
  return { state, lead, appointment, dependencies, sequelize, run, link, googleHook, now };
}

test('qualification and its job commit together; the Google hook reuses the committed Meta result', async () => {
  const h = harness(); const result = await h.run();
  assert.equal(result.previousStatus, 'contactado');
  assert.equal(h.state.committed.lead.status_lead, 'cualificado');
  assert.deepEqual(h.state.committed.jobs, [{ eventId: 'lead-1-qualified', eventName: 'qualified_lead' }]);
  assert.equal(h.state.external.length, 0);
  const delivery = await h.googleHook('lead-1-qualified'); assert.equal(delivery.sent, true);
  assert.equal(delivery.meta.queued, true); assert.deepEqual(h.state.external, ['google']);
});

test('a queue failure rolls back qualification and does not publish a committed-result marker', async () => {
  const h = harness(); h.state.failEvent = 'qualified_lead';
  await assert.rejects(h.run(), /queue unavailable/);
  assert.equal(h.state.committed.lead.status_lead, 'contactado'); assert.equal(h.state.committed.jobs.length, 0);
  await h.googleHook('lead-1-qualified'); assert.deepEqual(h.state.external, ['unexpected enqueue', 'google']);
});

test('link, lead status, qualification and Schedule share one transaction', async () => {
  const h = harness(); await h.link();
  assert.equal(h.state.transactions, 1); assert.deepEqual(h.state.reloads, ['appointment', 'lead']);
  assert.equal(h.state.committed.appointment.lead_intake_id, 1);
  assert.equal(h.state.committed.appointment.campana_id, 42);
  assert.equal(h.state.committed.lead.status_lead, 'citado'); assert.equal(h.state.committed.jobs.length, 2);
  assert.equal((await h.googleHook('lead-1-qualified')).meta.queued, true);
  assert.equal((await h.googleHook('appointment-3')).meta.queued, true);
  assert.deepEqual(h.state.external, ['google', 'google']);
});

test('if Schedule cannot be queued, qualification, appointment link and lead update all roll back', async () => {
  const h = harness(); h.state.failEvent = 'schedule';
  await assert.rejects(h.link(), /queue unavailable/);
  assert.equal(h.state.committed.appointment.lead_intake_id, null);
  assert.equal(h.state.committed.lead.status_lead, 'contactado'); assert.equal(h.state.committed.jobs.length, 0);
  assert.equal(h.state.queueCalls.length, 2);
});

test('commit failure cannot leave signal jobs or post-commit markers behind', async () => {
  const h = harness(); h.state.failCommit = true;
  await assert.rejects(h.link(), /commit rejected/);
  assert.equal(h.state.committed.jobs.length, 0); assert.equal(h.state.committed.appointment.lead_intake_id, null);
  await h.googleHook('appointment-3'); assert.ok(h.state.external.includes('unexpected enqueue'));
});

test('consent/policy denial saves the CRM normally, and the post-commit hook does not retry that denial', async () => {
  const h = harness(); h.state.denied = true; await h.link();
  assert.equal(h.state.committed.lead.status_lead, 'citado'); assert.equal(h.state.committed.jobs.length, 0);
  assert.equal((await h.googleHook('lead-1-qualified')).meta.reason, 'meta_crm_consent_required');
  assert.deepEqual(h.state.external, ['google']);
});

test('closed gate and other lead sources retain the existing persistence path without new transactions', async () => {
  for (const otherSource of [false, true]) {
    const h = harness();
    if (otherSource) h.lead.source = 'google_ads'; else h.dependencies.env.CAMPAIGN_WORKSPACE_ACTIVATION_ENABLED = 'false';
    await h.link(); assert.equal(h.state.committed.lead.status_lead, 'citado');
    assert.equal(h.state.transactions, 0); assert.equal(h.state.reloads.length, 0); assert.equal(h.state.queueCalls.length, 0);
  }
});

test('the locked status prevents a stale second qualification from enqueuing another event', async () => {
  const h = harness(); h.state.committed.lead.status_lead = 'cualificado';
  const result = await h.run(); assert.equal(result.previousStatus, 'cualificado'); assert.equal(h.state.queueCalls.length, 0);
});

test('a lead moved to another clinic after the controller read is rejected before writing', async () => {
  const h = harness(); h.state.committed.lead.clinica_id = 99;
  await assert.rejects(h.run(), { status: 409, code: 'meta_crm_scope_changed' });
  assert.equal(h.state.committed.lead.status_lead, 'contactado'); assert.equal(h.state.queueCalls.length, 0);
});

test('link revalidates the locked appointment owner, clinic and active state', async () => {
  for (const patch of [{ lead_intake_id: 99 }, { lead_intake_id: 0 }, { clinica_id: 99 }, { estado: 'cancelada' }]) {
    const h = harness(); Object.assign(h.state.committed.appointment, patch);
    await assert.rejects(h.link(), { status: 409, code: 'meta_crm_scope_changed' });
    assert.equal(h.state.committed.lead.status_lead, 'contactado'); assert.equal(h.state.queueCalls.length, 0);
  }
});

test('notes-only updates do not invent qualification events', async () => {
  const h = harness(); await h.run({ notas_internas: 'Only stored in CRM' });
  assert.equal(h.state.queueCalls.length, 0); assert.equal(h.state.committed.lead.notas_internas, 'Only stored in CRM');
});

test('existing campaign association on a linked appointment is not overwritten', async () => {
  const h = harness(); h.state.committed.appointment.campana_id = 55;
  await h.link(); assert.equal(h.state.committed.appointment.campana_id, 55);
});

test('created appointment, patient language and Meta jobs commit in the existing creation transaction', async () => {
  const h = harness();
  const created = await createAppointmentWithPatientLanguage({ sequelize: h.sequelize,
    AppointmentModel: { create: async (values, { transaction }) => {
      transaction.staged.appointment = { ...values, id_cita: 3, created_at: h.now };
      return transaction.staged.appointment;
    } }, appointmentValues: { clinica_id: 2, lead_intake_id: 1, estado: 'pendiente' },
    patient: { idioma_preferido: 'es', update: async (values, { transaction }) => Object.assign(transaction.staged.patient, values) },
    requestedLanguage: 'ca', afterPersist: (appointment, transaction) => enqueueCreatedAppointmentCrmSignals({
      lead: h.lead, appointment, transaction, dependencies: h.dependencies }) });
  assert.equal(created.id_cita, 3); assert.equal(h.state.transactions, 1);
  assert.equal(h.state.committed.patient.idioma_preferido, 'ca'); assert.equal(h.state.committed.jobs.length, 2);
  assert.equal((await h.googleHook('appointment-3')).meta.queued, true);
});

test('creation rolls back the appointment and language when either signal job fails', async () => {
  const h = harness(); h.state.failEvent = 'schedule';
  await assert.rejects(createAppointmentWithPatientLanguage({ sequelize: h.sequelize,
    AppointmentModel: { create: async (values, { transaction }) => {
      transaction.staged.appointment = { ...values, id_cita: 3, created_at: h.now };
      return transaction.staged.appointment;
    } }, appointmentValues: { clinica_id: 2, lead_intake_id: 1, estado: 'pendiente' },
    patient: { idioma_preferido: 'es', update: async (values, { transaction }) => Object.assign(transaction.staged.patient, values) },
    requestedLanguage: 'ca', afterPersist: (appointment, transaction) => enqueueCreatedAppointmentCrmSignals({
      lead: h.lead, appointment, transaction, dependencies: h.dependencies }) }), /queue unavailable/);
  assert.equal(h.state.committed.appointment.lead_intake_id, null);
  assert.equal(h.state.committed.patient.idioma_preferido, 'es'); assert.equal(h.state.committed.jobs.length, 0);
});

test('native appointment hook cannot be invoked without a transaction or with another lead', async () => {
  const h = harness();
  await assert.rejects(enqueueCreatedAppointmentCrmSignals({ lead: h.lead, appointment: h.appointment,
    dependencies: h.dependencies }), /meta_crm_transaction_required/);
  await assert.rejects(h.sequelize.transaction(async transaction => enqueueCreatedAppointmentCrmSignals({
    lead: h.lead, appointment: { ...h.appointment, lead_intake_id: 99 }, transaction, dependencies: h.dependencies })),
  { code: 'meta_crm_scope_changed' });
});

test('controllers use atomic persistence before post-commit conversion hooks in every existing writer', () => {
  const source = file => fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
  const intake = source('controllers/intake.controller.js');
  for (const [start, end] of [['updateLeadStatus', 'registrarContacto'], ['resolveLeadNotice', 'saveCallOutcome'], ['saveCallOutcome', 'deleteLead']]) {
    const body = intake.slice(intake.indexOf(`exports.${start} =`), intake.indexOf(`exports.${end} =`));
    const persistence = body.indexOf('await persistLeadWithCrmSignals(');
    assert.ok(persistence >= 0, start);
    const upload = body.search(/await (maybeUploadQualifiedLeadStatusTransition|ensureQualifiedLeadConversion)\(/);
    assert.ok(upload > persistence, `${start}: no Google upload before the CRM commits`);
  }
  const appointments = source('controllers/citas.controller.js');
  assert.match(appointments, /afterPersist: \(appointment, transaction\) => enqueueCreatedAppointmentCrmSignals/);
  assert.match(appointments, /await createOptions\.afterPersist\(created, transaction\)/);
  assert.match(source('lib/patient-language.js'), /await afterPersist\(appointment, transaction\)/);
  assert.doesNotMatch(source('services/leadCrmSignalPersistence.service.js'), /sendMeta|maybeUploadGoogle|axios|fetch\(/);
});
