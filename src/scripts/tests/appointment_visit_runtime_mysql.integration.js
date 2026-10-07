'use strict';

// Opt-in own mysqld/socket only. Actual migrations/model factories/services;
// no app, command/controller bootstrap, queue, provider or external database.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const S = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');

withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  require('./fixtures/security_offline_runtime.cjs');
  const D = S.DataTypes, v = require('../../lib/appointment-visit-communication');
  const r = require('../../lib/appointment-visit-runtime-contract');
  const { createAppointmentVisitCommunicationService } = require('../../services/appointmentVisitCommunications.service');
  const { createAppointmentVisitRuntimeService } = require('../../services/appointmentVisitRuntime.service');
  const { createAppointmentVisitDispatchService, JOB_TYPE } = require('../../services/appointmentVisitDispatch.service');
  const { combinedAppointment, NOW } = require('./helpers/appointment-visit-fixture');
  const f = require('./helpers/appointment-visit-runtime-fixture');
  const base = require('../../../migrations/20261006130000-create-appointment-visit-communications');
  const migration = require('../../../migrations/20261007130000-add-appointment-visit-runtime-contracts');
  models.Sequelize = S;
  // Reduced FK anchors only. All model factories used by the unit are real.
  models.Clinica = sql.define('Clinica', { id_clinica: { type: D.INTEGER, primaryKey: true } }, { tableName: 'Clinicas', timestamps: false });
  models.Paciente = sql.define('Paciente', { id_paciente: { type: D.INTEGER, primaryKey: true } }, { tableName: 'Pacientes', timestamps: false });
  models.Usuario = sql.define('Usuario', { id_usuario: { type: D.INTEGER, primaryKey: true } }, { tableName: 'Usuarios', timestamps: false });
  models.LeadIntake = sql.define('LeadIntake', { id: { type: D.INTEGER, primaryKey: true } }, { tableName: 'LeadIntakes', timestamps: false });
  for (const [name, file] of [['CitaPaciente', 'citapaciente'], ['Conversation', 'conversation'], ['Message', 'message'],
    ['FlowExecutionV2', 'flowexecutionv2'], ['AutomationFlowTemplateV2', 'automationflowtemplatev2'],
    ['JobRequest', 'jobrequest'], ['AutomationInboundMessageClaim', 'automationinboundmessageclaim']]) models[name] = require('../../../models/' + file)(sql, D);
  await sql.sync();
  const qi = sql.getQueryInterface();
  await base.up(qi, S); await migration.up(qi, S);
  assert.equal((await qi.showAllTables()).filter(name => /^AppointmentVisit/.test(name)).length, 5);
  await migration.down(qi); await base.down(qi);
  assert.equal((await qi.showAllTables()).filter(name => /^AppointmentVisit/.test(name)).length, 0);
  await base.up(qi, S); await migration.up(qi, S);
  for (const [name, file] of [['AppointmentVisit', 'appointmentvisit'], ['AppointmentVisitMember', 'appointmentvisitmember'],
    ['AppointmentVisitCommunication', 'appointmentvisitcommunication'], ['AppointmentVisitBirthRequest', 'appointmentvisitbirthrequest'],
    ['AppointmentVisitDispatch', 'appointmentvisitdispatch']]) models[name] = require('../../../models/' + file)(sql, D);
  for (const name of ['AppointmentVisit', 'AppointmentVisitMember', 'AppointmentVisitCommunication', 'AppointmentVisitBirthRequest', 'AppointmentVisitDispatch']) models[name].associate?.(models);
  for (const [table, name, fields] of [['AppointmentVisitBirthRequests', 'avbr_clinic_request', ['clinic_id', 'request_key']],
    ['AppointmentVisitDispatches', 'avd_intent_attempt', ['communication_id', 'attempt_number']]]) {
    const index = (await qi.showIndex(table)).find(index => index.name === name);
    assert.equal(index.unique, true); assert.deepEqual(index.fields.map(field => field.attribute), fields);
  }
  report.checks.push('actual composed migration up/down/up, FK RESTRICT and business-unique indexes on MySQL');
  await models.Clinica.bulkCreate([{ id_clinica: 66 }, { id_clinica: 72 }]);
  await models.Paciente.bulkCreate([{ id_paciente: 8 }, { id_paciente: 9 }]);
  await models.Usuario.create({ id_usuario: 7 });
  const detailsTemplate = await models.AutomationFlowTemplateV2.create(f.template());
  const reminderTemplate = await models.AutomationFlowTemplateV2.create(f.template({ id: 43, public_id: 'fixture_visit_reminder', template_key: 'fixture_visit_reminder',
    trigger_type: 'appointment_reminder_window', trigger_config: { schedule_moment: 'day_before' } }));
  const newerTemplate = await models.AutomationFlowTemplateV2.create(f.template({ id: 44, public_id: 'fixture_visit_details_newer', template_key: 'fixture_visit_details_newer', version: 2 }));
  const token = r.compileEnrollmentContract({ clinicId: 66, timeZone: 'Europe/Madrid', manifests: [
    { template: detailsTemplate, stages: f.stages() },
    { template: newerTemplate, stages: f.stages() },
    { template: reminderTemplate, stages: f.stages('attendance_day_before') },
  ] });
  let clock = '2030-01-01T12:00:00.123Z', enabled = true, calls = 0, failCheck = null, inbox = null;
  const now = () => new Date(clock), namespace = () => 'visit_fixture';
  const foundation = createAppointmentVisitCommunicationService({ db: models, now, readOperationalPolicy: () => null, readLegacyPolicy: () => null });
  // This is the trusted persistence seam, not the production availability/book
  // command. The unit proves SQL identity; endpoint integration is a later test.
  const writer = async ({ clinicId, patientId, plan, persist }) => {
    calls++;
    const row = combinedAppointment(); delete row.id_cita; delete row.created_at; delete row.updated_at;
    Object.assign(row, { clinica_id: clinicId, paciente_id: patientId, inicio: plan.start_at, fin: plan.end_at,
      doctor_id: plan.doctor_id, instalacion_id: plan.installation_id, tratamiento_id: plan.treatment_id,
      import_metadata: { booking: plan.booking, ...(plan.additional_staff ? { additional_staff: plan.additional_staff } : {}) } });
    return persist(row);
  };
  const runtime = createAppointmentVisitRuntimeService({ db: models, now, foundation, rolloutEnabled: () => enabled, bookCanonicalBirth: writer,
    readInboxHealth: () => inbox });
  const dispatch = createAppointmentVisitDispatchService({ db: models, now, foundation, namespace, rolloutEnabled: () => enabled,
    preDispatchCheck: async () => { if (failCheck) throw Object.assign(Error('owned guard denial'), { code: failCheck }); } });
  const birth = (requestKey = randomUUID(), patch = {}, service = runtime) => service.createCanonicalBirth({ clinicId: 66, patientId: 8, actorId: 7,
    requestKey, plan: f.plan(), contract: token, ...patch });
  enabled = false;
  await assert.rejects(birth(), { code: 'appointment_visit_runtime_rollout_closed' });
  assert.equal(await models.AppointmentVisitBirthRequest.count(), 0); assert.equal(await models.CitaPaciente.count(), 0);
  enabled = true;
  for (const requestKey of [null, undefined, 'optional-key-bypass']) await assert.rejects(birth(randomUUID(), { requestKey }), { code: 'appointment_visit_runtime_birth_key_invalid' });
  for (const contract of [structuredClone(token), { newAppointment: true }, undefined]) await assert.rejects(birth(randomUUID(), { contract }), { code: 'appointment_visit_runtime_server_contract_required' });
  assert.equal(await models.AppointmentVisitBirthRequest.count(), 0);
  const requestKey = randomUUID(), births = await Promise.all(Array.from({ length: 8 }, () => birth(requestKey)));
  const first = births[0];
  assert.equal(births.filter(result => result.created).length, 1); assert.equal(calls, 1);
  assert.equal(new Set(births.map(result => result.appointment.id_cita)).size, 1);
  assert.equal(await models.CitaPaciente.count(), 1); assert.equal(await models.AppointmentVisitBirthRequest.count(), 1);
  assert.equal(await models.AppointmentVisitMember.count(), 1);
  assert.equal(first.request.recorded_at.getTime(), Date.parse(clock));
  enabled = false; assert.equal((await birth(requestKey)).appointment.id_cita, first.appointment.id_cita); enabled = true;
  await assert.rejects(birth(requestKey, { patientId: 9 }), { code: 'appointment_visit_runtime_birth_request_conflict' });
  const alteredPlan = f.plan(); alteredPlan.booking.phases[1].doctor_ids = [52];
  await assert.rejects(birth(requestKey, { plan: alteredPlan }), { code: 'appointment_visit_runtime_birth_request_conflict' });
  const unsafeWriter = createAppointmentVisitRuntimeService({ db: models, now, foundation, rolloutEnabled: () => true,
    bookCanonicalBirth: async () => first.appointment });
  await assert.rejects(birth(randomUUID(), {}, unsafeWriter), { code: 'appointment_visit_runtime_canonical_birth_proof_required' });
  assert.equal(await models.AppointmentVisitBirthRequest.count(), 1);
  const duplicateWriter = createAppointmentVisitRuntimeService({ db: models, now, foundation, rolloutEnabled: () => true,
    bookCanonicalBirth: async args => { await writer(args); return writer(args); } });
  await assert.rejects(birth(randomUUID(), {}, duplicateWriter), { code: 'appointment_visit_runtime_canonical_birth_invalid' });
  assert.equal(await models.CitaPaciente.count(), 1); assert.equal(await models.AppointmentVisitBirthRequest.count(), 1);
  await assert.rejects(models.AppointmentVisitBirthRequest.create({ ...first.request.toJSON(), id: randomUUID() }), S.UniqueConstraintError);
  await assert.rejects(migration.down(qi), /durable history/);
  report.checks.push('8 simultaneous real canonical births create one appointment/member/visit/request; mixed keys/hash/patient, cloned contracts and nonsealed/double persist roll back; closed default and identity-only replay');

  const plan = (visit, stageKey = 'details', templateVersionId = 42, patch = {}) => runtime.planVisitCommunication({ visitId: visit.id, clinicId: 66,
    expectedRevision: Number(visit.communication_revision), stageKey, templateVersionId, actorId: 7, ...patch });
  const claims = await Promise.all(Array.from({ length: 8 }, () => plan(first.visit)));
  const intent = claims[0].communication;
  assert.equal(claims.filter(result => result.created).length, 1); assert.equal(new Set(claims.map(result => result.communication.id)).size, 1);
  assert.equal((await plan(first.visit, 'details', 44)).communication.id, intent.id);
  assert.equal(await models.AppointmentVisitCommunication.count(), 1);
  await assert.rejects(foundation.claimCommunication({ visitId: first.visit.id, clinicId: 66, expectedRevision: 1, purpose: 'appointment_details',
    window: { key: 'details', starts_at: clock, ends_at: first.appointment.inicio }, templateVersionId: 42 }), { code: 'appointment_visit_runtime_server_stage_plan_required' });
  report.checks.push('persisted enrollment -> 8 concurrent actual foundation intent claims; template-version changes reuse same original intent/key, arbitrary caller windows/stage brands fail closed');

  const conversation = await models.Conversation.create({ clinic_id: 66, patient_id: 8, channel: 'internal' });
  async function materialize(visit, communication, nodeId = 'S') {
    const row = await models.CitaPaciente.findByPk(visit.owner_appointment_id);
    const execution = await models.FlowExecutionV2.create({ idempotency_key: 'owned_fixture:' + randomUUID(),
      template_version_id: communication.template_version_id, status: 'running', context: { appointment: row.toJSON(),
        appointment_visit: { visit_id: visit.id, communication_revision: visit.communication_revision, enrollment_sha256: visit.runtime_enrollment_sha256 } },
      current_node_id: nodeId, trigger_type: communication.template_version_id === 43 ? 'appointment_reminder_window' : 'appointment_created',
      trigger_entity_type: 'appointment', trigger_entity_id: row.id_cita, clinic_id: 66, created_by: 7 });
    const message = await models.Message.create({ conversation_id: conversation.id, direction: 'outbound', status: 'pending', content: 'Owned fixture only',
      automation_delivery_key: v.deliveryKey(communication), metadata: { execution_id: execution.id, node_id: nodeId, visit_communication_id: communication.id } });
    await foundation.bindCommunication({ communicationId: communication.id, clinicId: 66, executionId: execution.id, messageId: message.id });
    const job = await models.JobRequest.create({ type: JOB_TYPE, status: 'running', attempts: 1, last_attempt_at: now(),
      payload: { __runtime_namespace: namespace(), visit_communication_id: communication.id, execution_id: execution.id, message_id: message.id } });
    const claim = dispatch.captureJobClaim({ job, isActive: () => true });
    return { visit, communication, execution, message, job, claim };
  }
  const bound = await materialize(first.visit, intent);
  const begin = (b = bound, service = dispatch, claim = b.claim) => service.beginDispatch({ communicationId: b.communication.id, clinicId: 66, claim });
  const leaseResults = await Promise.all(Array.from({ length: 8 }, () => begin()));
  const lease = leaseResults[0].dispatch;
  assert.equal(leaseResults.filter(result => result.begun).length, 1);
  assert.equal(await models.AppointmentVisitDispatch.count(), 1);
  assert.equal((await models.Message.findByPk(bound.message.id)).status, 'sending');
  assert.equal(lease.started_at.getTime(), Date.parse(clock)); assert.equal(lease.lease_expires_at.getTime(), Date.parse(clock) + 60000);
  await assert.rejects(begin(bound, dispatch, structuredClone(bound.claim)), { code: 'appointment_visit_runtime_server_job_claim_required' });
  const attempt = b => ({ dispatchId: b.dispatch.id, clinicId: 66, attemptToken: b.dispatch.attempt_token, claim: b.claim });
  bound.dispatch = lease;
  await dispatch.assertDispatchAttemptCurrent(attempt(bound));
  const lockTrace = [];
  sql.addHook('afterQuery', 'visit_dispatch_lock_trace', (_options, query) => {
    if (query.sql?.includes('FOR UPDATE')) lockTrace.push(query.sql);
  });
  try { await dispatch.assertDispatchAttemptCurrent(attempt(bound)); }
  finally { sql.removeHook('afterQuery', 'visit_dispatch_lock_trace'); }
  const lockNames = ['AutomationFlowTemplatesV2', 'FlowExecutionsV2', 'JobRequests', 'CitasPacientes', 'AppointmentVisitMembers',
    'AppointmentVisits', 'AppointmentVisitCommunications', 'AppointmentVisitDispatches', 'Messages'];
  let previousIndex = -1;
  for (const table of lockNames) {
    const index = lockTrace.findIndex((query, index) => index > previousIndex && query.includes('FROM `' + table + '`'));
    assert(index > previousIndex, 'actual SQL lock order: ' + table); previousIndex = index;
  }
  await bound.job.update({ payload: { ...bound.job.payload, synthetic_data_only: true } });
  await assert.rejects(dispatch.assertDispatchAttemptCurrent(attempt(bound)), { code: 'appointment_visit_runtime_dispatch_job_scope_changed' });
  await bound.job.update({ payload: { ...bound.job.payload, synthetic_data_only: false } });
  await assert.rejects(dispatch.assertDispatchAttemptCurrent({ ...attempt(bound), attemptToken: randomUUID() }), { code: 'appointment_visit_runtime_dispatch_lease_lost' });
  assert.equal((await dispatch.reconcileDispatch({ dispatchId: lease.id, clinicId: 66 })).status, 'dispatching');
  const authorized = await dispatch.runPreDispatchCheck(attempt(bound)); assert.equal(authorized.allowed, true);
  assert.equal(authorized.message.id, bound.message.id); assert.equal(authorized.delivery_key, v.deliveryKey(intent));
  await assert.rejects(dispatch.runPreDispatchCheck(attempt(bound)), { code: 'appointment_visit_runtime_dispatch_network_already_started' });
  // No provider is called: SQL fixtures publish a factual receipt explicitly.
  await bound.message.reload(); await bound.message.update({ status: 'sent', sent_at: now(), metadata: { ...bound.message.metadata, wamid: 'owned_acceptance_only' } });
  assert.equal((await dispatch.reconcileDispatch({ dispatchId: lease.id, clinicId: 66 })).status, 'accepted');
  assert.equal((await begin()).reason, 'accepted');
  const acceptedAt = (await models.AppointmentVisitCommunication.findByPk(intent.id)).accepted_at.getTime();
  assert.equal((await dispatch.cancelIntent({ communicationId: intent.id, clinicId: 66, reason: 'cancelled_by_patient' })).cancelled, false);
  await bound.message.update({ status: 'failed' });
  assert.equal((await dispatch.reconcileDispatch({ dispatchId: lease.id, clinicId: 66 })).status, 'accepted');
  assert.equal((await models.AppointmentVisitCommunication.findByPk(intent.id)).accepted_at.getTime(), acceptedAt);
  report.checks.push('8 simultaneous job-owned beginDispatch calls lease one existing Message; SQL trace family -> execution -> job -> appointment -> member -> visit -> intent -> dispatch -> Message; exact branded JobRequest/attempt/token/QA and DATE3 binding; one pre-network authorization; actual accepted receipt never reset/reassigned');

  // Purpose-native wait snapshot keeps actual flow JSON clock milliseconds,
  // and independently captures source Message/execution/conversation identity.
  await bound.message.update({ status: 'sent' });
  const starts = '2030-01-01T12:00:01.123Z', due = '2030-01-01T14:00:01.123Z';
  const waitingMeta = { type: 'delay/wait_response', listens_to_node_id: 'S', wait_starts_at: starts, runtime_namespace: namespace(), pending_response_message_ids: [] };
  const waitingContext = JSON.parse(JSON.stringify({ ...bound.execution.context, outputs: { S: { message_id: bound.message.id, conversation_id: conversation.id }, W: { timeout_at: due } } }));
  await bound.execution.update({ status: 'waiting', current_node_id: 'W', wait_until: new Date(due), waiting_meta: waitingMeta, context: waitingContext });
  const frozen = await runtime.freezePurposeWait({ sourceCommunicationId: intent.id, clinicId: 66, waitNodeId: 'W' });
  assert.equal(frozen.wait.due_at, due); assert.equal(frozen.wait.source_message_id, bound.message.id);
  assert.equal((await runtime.freezePurposeWait({ sourceCommunicationId: intent.id, clinicId: 66, waitNodeId: 'W' })).created, false);
  await bound.execution.reload(); assert.deepEqual(bound.execution.waiting_meta, waitingMeta); assert.deepEqual(bound.execution.context, waitingContext);
  clock = '2030-01-01T12:30:00.123Z';
  const inbound = await models.Message.create({ conversation_id: conversation.id, direction: 'inbound', status: 'sent', sent_at: now(), content: 'Owned fixture only' });
  await assert.rejects(plan(first.visit, 'ack_details', 42, { sourceCommunicationId: intent.id, inboundMessageId: inbound.id }), { code: 'appointment_visit_runtime_inbound_owner_invalid' });
  await models.AutomationInboundMessageClaim.create({ claim_key: 'owned:' + inbound.id, message_id: inbound.id, clinic_id: 66, conversation_id: conversation.id,
    channel: 'internal', owner_type: 'wait_response', owner_reference_id: bound.execution.id, status: 'completed' });
  const ack = await plan(first.visit, 'ack_details', 42, { sourceCommunicationId: intent.id, inboundMessageId: inbound.id });
  assert.equal(ack.communication.window_key, 'ack:details'); assert.equal(ack.communication.window_ends_at.getTime(), Date.parse(due));
  clock = due; inbox = f.healthyInbox(clock);
  await bound.execution.update({ waiting_meta: { ...waitingMeta, pending_response_message_ids: [inbound.id] } });
  await assert.rejects(plan(first.visit, 'timeout_details', 42, { sourceCommunicationId: intent.id }), { code: 'appointment_visit_runtime_timeout_not_owned' });
  await bound.execution.update({ waiting_meta: waitingMeta }); inbox.recoveryHold = true;
  await assert.rejects(plan(first.visit, 'timeout_details', 42, { sourceCommunicationId: intent.id }), { code: 'appointment_visit_runtime_timeout_reception_held' });
  inbox = f.healthyInbox(clock);
  const timeout = await plan(first.visit, 'timeout_details', 42, { sourceCommunicationId: intent.id });
  assert.equal(timeout.communication.window_key, 'timeout:details'); assert.equal(timeout.communication.window_ends_at.getTime(), Date.parse(due) + 300000);
  assert.equal((await dispatch.cancelIntent({ communicationId: timeout.communication.id, clinicId: 66, reason: 'purpose_cancelled' })).cancelled, true);
  await bound.execution.reload(); assert.deepEqual(bound.execution.waiting_meta, waitingMeta); assert.deepEqual(bound.execution.context, waitingContext);
  report.checks.push('accepted source captures actual purpose wait clock/owner immutably with millisecond JSON vs DATE0 validation; ACK needs real inbound owner receipt; timeout blocks pending native replies/recovery; cancelling timeout preserves details wait/context');

  async function freshBound() { const result = await birth(); const intent = await plan(result.visit); return materialize(result.visit, intent.communication); }
  clock = '2030-01-01T15:00:00.123Z';
  const definite = await freshBound(); definite.dispatch = (await begin(definite)).dispatch;
  failCheck = 'fixture_pre_network_hold';
  assert.equal((await dispatch.runPreDispatchCheck(attempt(definite))).allowed, false); failCheck = null;
  assert.equal((await models.Message.findByPk(definite.message.id)).status, 'failed');
  await definite.job.update({ attempts: 2, last_attempt_at: new Date(Date.parse(clock) + 1000) });
  definite.claim = dispatch.captureJobClaim({ job: definite.job, isActive: () => true });
  const retried = await begin(definite); definite.dispatch = retried.dispatch;
  assert.equal(retried.begun, true); assert.equal(retried.dispatch.attempt_number, 2);
  assert.equal(retried.dispatch.message_id, definite.message.id); assert.equal(retried.delivery_key, v.deliveryKey(definite.communication));
  assert.equal(await models.AppointmentVisitDispatch.count({ where: { communication_id: definite.communication.id } }), 2);
  const cancelled = await dispatch.cancelIntent({ communicationId: definite.communication.id, clinicId: 66, reason: 'before_network_cancelled' });
  assert.equal(cancelled.cancelled, true); assert.equal((await models.Message.findByPk(definite.message.id)).status, 'failed');
  await assert.rejects(dispatch.assertDispatchAttemptCurrent(attempt(definite)), { code: 'appointment_visit_runtime_dispatch_lease_lost' });
  const unknown = await freshBound(); unknown.dispatch = (await begin(unknown)).dispatch;
  await unknown.job.update({ status: 'failed' });
  const orphanCancel = await dispatch.cancelIntent({ communicationId: unknown.communication.id, clinicId: 66, reason: 'orphan_cancelled' });
  assert.equal(orphanCancel.cancelled, false); assert.equal(orphanCancel.communication.status, 'unknown');
  await unknown.job.update({ status: 'running', attempts: 2, last_attempt_at: new Date(Date.parse(clock) + 1000) });
  unknown.claim = dispatch.captureJobClaim({ job: unknown.job, isActive: () => true });
  assert.equal((await begin(unknown)).reason, 'unknown');
  // Late receipt is retained even after current booking is held/marked QA.
  await unknown.message.reload(); await unknown.message.update({ status: 'failed', metadata: { ...unknown.message.metadata, wamid: 'owned_late_acceptance' } });
  const unknownAppointment = await models.CitaPaciente.findByPk(unknown.visit.owner_appointment_id);
  await unknownAppointment.update({ import_metadata: { ...unknownAppointment.import_metadata, automation_policy: 'hold', synthetic_data_only: true } });
  assert.equal((await dispatch.reconcileDispatch({ dispatchId: unknown.dispatch.id, clinicId: 66 })).status, 'accepted');
  const expired = await freshBound(); expired.dispatch = (await begin(expired)).dispatch;
  clock = new Date(Date.parse(clock) + 60001).toISOString();
  assert.equal((await dispatch.reconcileDispatch({ dispatchId: expired.dispatch.id, clinicId: 66 })).status, 'unknown');
  assert.equal((await begin(expired)).reason, 'unknown');
  report.checks.push('definite pre-network failure retries same intent/Message/delivery key under new actual job attempt; fresh pre-network cancel is definite; orphan/expired sending -> protected unknown; late acceptance retained after HOLD/QA');

  const stale = await freshBound(); stale.dispatch = (await begin(stale)).dispatch;
  const staleRow = await models.CitaPaciente.findByPk(stale.visit.owner_appointment_id), metadata = structuredClone(staleRow.import_metadata);
  metadata.booking.phases[1].doctor_ids = [52];
  const move = await sql.transaction({ isolationLevel: 'READ COMMITTED' }); let blocked;
  try {
    const held = await models.CitaPaciente.findByPk(stale.visit.owner_appointment_id, { transaction: move, lock: move.LOCK.UPDATE });
    await held.update({ import_metadata: metadata }, { transaction: move });
    let settled = false;
    blocked = dispatch.assertDispatchAttemptCurrent(attempt(stale)).then(result => ({ result }), error => ({ error })).finally(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(settled, false);
    await move.commit(); assert.equal((await blocked).error?.code, 'appointment_visit_snapshot_changed');
  } finally { if (!move.finished) await move.rollback(); if (blocked) await blocked; }
  await assert.rejects(birth(stale.visit.runtime_enrollment.birth_request_key), { code: 'appointment_visit_runtime_birth_replay_changed' });
  const refreshed = await foundation.refreshVisitSnapshot({ visitId: stale.visit.id, clinicId: 66, expectedRevision: 1, actorId: 7 });
  assert.equal(refreshed.visit.communication_revision, 2);
  await assert.rejects(dispatch.assertDispatchAttemptCurrent(attempt(stale)), { code: 'appointment_visit_revision_changed' });
  await assert.rejects(plan(refreshed.visit), { code: 'appointment_visit_runtime_mutation_event_required' });
  assert.equal((await models.AppointmentVisitCommunication.findByPk(stale.communication.id)).communication_revision, 1);
  const stopped = await freshBound(); await stopped.execution.update({ status: 'cancelled' });
  await assert.rejects(begin(stopped), { code: 'automation_execution_stopped' });
  const qa = await freshBound(), qaRow = await models.CitaPaciente.findByPk(qa.visit.owner_appointment_id);
  await qaRow.update({ import_metadata: { ...qaRow.import_metadata, cliniccloud_source_booking: { synthetic_data_only: true } } });
  await assert.rejects(begin(qa)); assert.equal(await models.AppointmentVisitDispatch.count({ where: { communication_id: qa.communication.id } }), 0);
  const gated = await freshBound(); enabled = false;
  await assert.rejects(begin(gated), { code: 'appointment_visit_runtime_rollout_closed' }); enabled = true;
  const changedGraph = await freshBound(), graph = structuredClone(detailsTemplate.nodes);
  graph.find(node => node.id === 'S').config.changed_after_enrollment = true;
  await detailsTemplate.update({ nodes: graph });
  await assert.rejects(begin(changedGraph), { code: 'appointment_visit_runtime_graph_changed' });
  await detailsTemplate.update({ nodes: f.template().nodes });
  const unavailable = await freshBound(), closedDispatch = createAppointmentVisitDispatchService({ db: models, now, foundation, namespace, rolloutEnabled: () => true });
  // Capture proof in the service whose WeakMap owns it, never serialize/reuse
  // another factory's internal proof as a bypass.
  unavailable.claim = closedDispatch.captureJobClaim({ job: unavailable.job, isActive: () => true });
  unavailable.dispatch = (await begin(unavailable, closedDispatch)).dispatch;
  assert.equal((await closedDispatch.runPreDispatchCheck(attempt(unavailable))).allowed, false);
  assert.equal((await models.Message.findByPk(unavailable.message.id)).status, 'failed');
  report.checks.push('actual locked phase-only edit race/CAS revision/closed flag/stopped family execution/fresh nested QA/changed frozen graph/missing trusted preflight block before network; old revision receipts stay immutable, no lazy enrollment or legacy fallback');
  const attempted = await models.AppointmentVisitDispatch.findByPk(lease.id);
  await assert.rejects(models.AppointmentVisitDispatch.create({ ...attempted.toJSON(), id: randomUUID(), attempt_token: randomUUID() }), S.UniqueConstraintError);
  await assert.rejects(bound.message.destroy(), error => error.original?.code === 'ER_ROW_IS_REFERENCED_2');
  await assert.rejects(migration.down(qi), /durable history/);
  report.providerAttempts = 0; report.consumerIntegration = false;
  report.counts = { appointments: await models.CitaPaciente.count(), visits: await models.AppointmentVisit.count(), intents: await models.AppointmentVisitCommunication.count(),
    messages: await models.Message.count(), jobs: await models.JobRequest.count(), attempts: await models.AppointmentVisitDispatch.count() };
  report.checks.push('populated rollback and Message deletion refuse to erase durable receipts; zero provider/worker execution; native command/runtime/controller wiring deliberately not claimed');
}).catch(error => { console.error(error.stack); process.exitCode = 1; });
