'use strict';

// Opt-in only. Own mysqld/Unix socket, blocked TCP/providers/queues and fictitious
// parent records. Never imports the production model bootstrap or app/runtime.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const S = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');

withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  require('./fixtures/security_offline_runtime.cjs');
  const D = S.DataTypes;
  const { appointment, prpFixture, combinedAppointment, window, policy, NOW } = require('./helpers/appointment-visit-fixture');
  const v = require('../../lib/appointment-visit-communication');
  const { createAppointmentVisitCommunicationService } = require('../../services/appointmentVisitCommunications.service');
  const migration = require('../../../migrations/20261006130000-create-appointment-visit-communications');
  models.Sequelize = S;
  // Only FK anchors are reduced fixture schemas. Every model exercised by the
  // foundation service comes from its actual factory, not an emulated ORM.
  models.Clinica = sql.define('Clinica', { id_clinica: { type: D.INTEGER, primaryKey: true } }, { tableName: 'Clinicas', timestamps: false });
  models.Paciente = sql.define('Paciente', { id_paciente: { type: D.INTEGER, primaryKey: true },
    nombre: D.STRING, apellidos: D.STRING, telefono_movil: D.STRING }, { tableName: 'Pacientes', timestamps: false });
  models.Usuario = sql.define('Usuario', { id_usuario: { type: D.INTEGER, primaryKey: true } }, { tableName: 'Usuarios', timestamps: false });
  models.LeadIntake = sql.define('LeadIntake', { id: { type: D.INTEGER, primaryKey: true } }, { tableName: 'LeadIntakes', timestamps: false });
  for (const [name, file] of [['CitaPaciente', 'citapaciente'], ['Conversation', 'conversation'], ['Message', 'message'],
    ['FlowExecutionV2', 'flowexecutionv2'], ['Tratamiento', 'tratamiento'], ['JobRequest', 'jobrequest']]) {
    models[name] = require('../../../models/' + file)(sql, D);
  }
  await sql.sync(); // Owned fixture scaffolding only; foundation schema is migrated below.
  const qi = sql.getQueryInterface();
  // The actual audit migration has explicit short index names; its factory's
  // implicit sync index name exceeds MySQL's 64-character limit. Do not change
  // that production model or emulate its append-only behavior in this test.
  await require('../../../migrations/20260731150000-create-patient-operational-events').up(qi, S);
  models.PatientOperationalEvent = require('../../../models/patientoperationalevent')(sql, D);
  await migration.up(qi, S);
  assert.equal((await qi.showAllTables()).filter(name => /^AppointmentVisit/.test(name)).length, 3);
  await migration.down(qi);
  assert.equal((await qi.showAllTables()).filter(name => /^AppointmentVisit/.test(name)).length, 0);
  await migration.up(qi, S);
  await require('../../../migrations/20261007130000-add-appointment-visit-runtime-contracts').up(qi, S);
  for (const [name, file] of [['AppointmentVisit', 'appointmentvisit'], ['AppointmentVisitMember', 'appointmentvisitmember'],
    ['AppointmentVisitCommunication', 'appointmentvisitcommunication']]) models[name] = require('../../../models/' + file)(sql, D);
  for (const name of ['AppointmentVisit', 'AppointmentVisitMember', 'AppointmentVisitCommunication']) models[name].associate(models);
  const uniqueIndex = (await qi.showIndex('AppointmentVisitCommunications')).find(index => index.name === 'avc_visit_purpose_revision_window');
  assert(uniqueIndex.unique);
  assert.deepEqual(uniqueIndex.fields.map(field => field.attribute), ['visit_id', 'purpose', 'communication_revision', 'window_sha256']);
  assert((await qi.showIndex('AppointmentVisitCommunications')).find(index => index.name === 'avc_message_unique').unique);
  report.checks.push('base migration up/down/up creates exact three tables and indexes; runtime additive migration supplies nullable model columns, with no backfill/enrollment');

  await models.Clinica.bulkCreate([{ id_clinica: 66 }, { id_clinica: 72 }]);
  await models.Paciente.create({ id_paciente: 8 });
  await models.Usuario.create({ id_usuario: 7 });
  const source = prpFixture();
  const descendingSource = prpFixture({ componentAppointmentId: 602, parentAppointmentId: 601, auditEventId: '9007199254740994' });
  const historicalSource = prpFixture({ componentAppointmentId: 802, parentAppointmentId: 801, auditEventId: '9007199254740995' });
  await models.Tratamiento.create({ id_tratamiento: 688, clinica_id: 66, nombre: 'PRP', disciplina: 'fixture-only', activo: true,
    clinical_config: source.treatment.clinical_config });
  await models.PatientOperationalEvent.create(source.event);
  await models.PatientOperationalEvent.create(descendingSource.event);
  await models.PatientOperationalEvent.create(historicalSource.event);
  await models.CitaPaciente.bulkCreate([
    ...source.rows, ...descendingSource.rows, ...historicalSource.rows,
    appointment(201), appointment(202), appointment(203), appointment(204), combinedAppointment(301),
    appointment(401, { import_metadata: { qa_demo: { fixture: 'SQL only' } } }),
    appointment(402, { source_system: 'cliniccloud', source_reference: 'fixture-held', import_metadata: { automation_policy: 'hold' } }),
    appointment(403, { source_system: 'cliniccloud', source_reference: 'fixture-qa', import_metadata: { automation_policy: 'hold', synthetic_data_only: true } }),
  ]);
  await models.Conversation.create({ id: 14, clinic_id: 66, patient_id: 8, channel: 'internal' });
  let activePolicy = null, clock = NOW, executionSequence = 0;
  const service = createAppointmentVisitCommunicationService({ db: models, now: () => new Date(clock),
    readOperationalPolicy: () => activePolicy, readLegacyPolicy: () => null });
  const singleton = (appointmentId, transaction) => service.ensureSingletonVisit({ appointmentId, clinicId: 66, actorId: 7, transaction });
  const group = transaction => service.linkValidatedPrpVisit({ componentAppointmentId: 101, parentAppointmentId: 102, clinicId: 66, actorId: 7, transaction });
  const claim = (visit, overrides = {}) => service.claimCommunication({ visitId: visit.id, clinicId: 66,
    expectedRevision: Number(visit.communication_revision), purpose: 'appointment_details', window: window(), templateVersionId: 42, actorId: 7, ...overrides });
  const readAppointment = id => models.CitaPaciente.findByPk(id, { raw: true });
  const uniqueFailure = error => error.name === 'SequelizeUniqueConstraintError' && error.original?.code === 'ER_DUP_ENTRY';
  async function materialize(communication, { trigger = 'appointment_created', context = null } = {}) {
    const owner = await readAppointment(communication.owner_appointment_id);
    const execution = await models.FlowExecutionV2.create({ idempotency_key: 'isolated-visit-' + ++executionSequence,
      template_version_id: 42, status: 'running', clinic_id: 66, created_by: 7, trigger_type: trigger,
      trigger_entity_type: 'appointment', trigger_entity_id: owner.id_cita, created_at: new Date(clock),
      context: context || { appointment: { id_cita: owner.id_cita, clinica_id: 66, paciente_id: 8, inicio: v.instant(owner.inicio) } } });
    const message = await models.Message.create({ conversation_id: 14, direction: 'outbound', status: 'pending', message_type: 'text',
      content: 'Owned SQL fixture, never transported', metadata: { execution_id: execution.id }, automation_delivery_key: v.deliveryKey(communication) });
    return { execution, message, bind: () => service.bindCommunication({ communicationId: communication.id, clinicId: 66,
      executionId: execution.id, messageId: message.id }) };
  }

  const nativeBefore = await readAppointment(201);
  const identities = await Promise.all(Array.from({ length: 8 }, () => singleton(201)));
  assert.equal(identities.filter(value => value.created).length, 1);
  assert.equal(new Set(identities.map(value => value.visit.id)).size, 1);
  const native = identities[0].visit;
  assert.equal(await models.AppointmentVisitMember.count({ where: { appointment_id: 201 } }), 1);
  const intents = await Promise.all(Array.from({ length: 8 }, () => claim(native)));
  assert.equal(intents.filter(value => value.created).length, 1);
  assert.equal(new Set(intents.map(value => value.communication.id)).size, 1);
  assert.equal(new Set(intents.map(value => value.delivery_key)).size, 1);
  assert.equal(await models.AppointmentVisitCommunication.count({ where: { visit_id: native.id } }), 1);
  assert.deepEqual(await readAppointment(201), nativeBefore);
  const details = intents[0].communication;
  await assert.rejects(models.AppointmentVisitCommunication.create({ ...details.toJSON(), id: randomUUID() }), uniqueFailure);
  const member = await models.AppointmentVisitMember.findByPk(201);
  await assert.rejects(models.AppointmentVisitMember.create(member.toJSON()), uniqueFailure);
  await assert.rejects(claim(native, { window: { ...window(), ends_at: '2030-01-03T12:00:00.000Z' } }), { code: 'appointment_visit_window_definition_changed' });
  const replay = await claim(native, { templateVersionId: 43 });
  assert.equal(replay.communication.id, details.id); assert.equal(replay.communication.template_version_id, 42);
  const preciseWindow = { key: 'millisecond-precision', starts_at: '2030-01-01T12:00:00.123Z', ends_at: '2030-01-02T12:00:00.789Z' };
  const precise = await claim(native, { window: preciseWindow });
  const precisePersisted = await models.AppointmentVisitCommunication.findByPk(precise.communication.id);
  assert.equal(v.instant(precisePersisted.window_starts_at), preciseWindow.starts_at);
  assert.equal(v.instant(precisePersisted.window_ends_at), preciseWindow.ends_at);
  assert.equal((await claim(native, { window: preciseWindow })).communication.id, precise.communication.id);
  report.checks.push('8 simultaneous real READ COMMITTED singletons and 8 claims produce one identity/intent; raw SQL duplicate member/intent fail unique constraints; template/bounds cannot evade replay');

  const forcedRollback = await singleton(202);
  const beforeVisitCount = await models.AppointmentVisit.count();
  await assert.rejects(sql.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
    const created = await singleton(203, transaction); await claim(created.visit, { transaction });
    throw Error('OWNED_FIXTURE_ATOMIC_ROLLBACK');
  }), /OWNED_FIXTURE_ATOMIC_ROLLBACK/);
  assert.equal(await models.AppointmentVisit.count(), beforeVisitCount);
  assert.equal(await models.AppointmentVisitMember.count({ where: { appointment_id: 203 } }), 0);
  assert.equal(await models.AppointmentVisitCommunication.count({ where: { owner_appointment_id: 203 } }), 0);
  const invalidMember = { ...member.toJSON(), appointment_id: 999999, visit_id: forcedRollback.visit.id };
  await assert.rejects(models.AppointmentVisitMember.create(invalidMember), error => error.original?.code === 'ER_NO_REFERENCED_ROW_2');
  await assert.rejects(models.CitaPaciente.destroy({ where: { id_cita: 201 } }), error => error.original?.code === 'ER_ROW_IS_REFERENCED_2');
  report.checks.push('actual rollback removes identity/member/intent atomically; FK rejects phantom appointments and RESTRICT preserves bound reservation history');

  const hold = await sql.transaction({ isolationLevel: 'READ COMMITTED' });
  let race;
  try {
    await models.CitaPaciente.findByPk(201, { transaction: hold, lock: hold.LOCK.UPDATE });
    await models.CitaPaciente.update({ inicio: '2030-01-07T10:20:00.000Z' }, { where: { id_cita: 201 }, transaction: hold });
    let settled = false;
    race = claim(native).then(result => ({ result }), error => ({ error })).finally(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(settled, false);
    await hold.commit(); assert.equal((await race).error?.code, 'appointment_visit_snapshot_changed');
  } finally { if (!hold.finished) await hold.rollback(); if (race) await race; }
  const refreshes = await Promise.allSettled([1, 2].map(() => service.refreshVisitSnapshot({ visitId: native.id, clinicId: 66, expectedRevision: 1, actorId: 7 })));
  assert.equal(refreshes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(refreshes.find(result => result.status === 'rejected').reason.code, 'appointment_visit_revision_changed');
  const refreshed = (await models.AppointmentVisit.findByPk(native.id)); assert.equal(refreshed.communication_revision, 2);
  await assert.rejects(service.assertCommunicationCurrent({ communicationId: details.id, clinicId: 66 }), { code: 'appointment_visit_revision_changed' });
  assert.equal((await models.AppointmentVisitCommunication.findByPk(details.id)).communication_revision, 1);
  report.checks.push('real appointment-row lock race blocks stale claim after schedule commit; simultaneous CAS refresh yields exactly one revision increment and preserves stale intent');

  const combined = (await singleton(301)).visit, combinedIntent = await claim(combined);
  const combinedBefore = await readAppointment(301), metadata = structuredClone(combinedBefore.import_metadata);
  metadata.booking.phases[1].doctor_ids = [52]; metadata.booking.phases[1].installation_id = 77;
  await models.CitaPaciente.update({ import_metadata: metadata }, { where: { id_cita: 301 } });
  for (const field of ['doctor_id', 'instalacion_id', 'tratamiento_id', 'inicio', 'fin']) assert.deepEqual((await readAppointment(301))[field], combinedBefore[field]);
  await assert.rejects(claim(combined), { code: 'appointment_visit_snapshot_changed' });
  const combinedRefresh = await service.refreshVisitSnapshot({ visitId: combined.id, clinicId: 66, expectedRevision: 1 });
  assert.equal(combinedRefresh.visit.communication_revision, 2);
  await assert.rejects(service.assertCommunicationCurrent({ communicationId: combinedIntent.communication.id, clinicId: 66 }), { code: 'appointment_visit_revision_changed' });
  const staleBinding = await materialize(combinedIntent.communication);
  await assert.rejects(staleBinding.bind(), { code: 'appointment_visit_revision_changed' });
  assert.equal((await models.AppointmentVisitCommunication.findByPk(combinedIntent.communication.id)).message_id, null);
  report.checks.push('persisted MySQL JSON combined phase2 professional/room change invalidates intent and increments revision even with unchanged top-level reservation fields');

  const sourceBefore = await Promise.all([101, 102].map(readAppointment));
  const [child, parent] = await Promise.all([singleton(101), singleton(102)]);
  await assert.rejects(sql.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
    await group(transaction); throw Error('OWNED_FIXTURE_GROUP_ROLLBACK');
  }), /OWNED_FIXTURE_GROUP_ROLLBACK/);
  assert.equal((await models.AppointmentVisitMember.findByPk(101)).visit_id, child.visit.id);
  assert.equal((await models.AppointmentVisit.findByPk(child.visit.id)).status, 'active');
  const groups = await Promise.all(Array.from({ length: 4 }, () => group()));
  assert.equal(groups.filter(result => result.created).length, 1);
  assert(groups.every(result => result.visit.id === parent.visit.id && result.visit.owner_appointment_id === 102));
  const prp = groups[0].visit;
  assert.equal((await models.AppointmentVisit.findByPk(child.visit.id)).status, 'merged');
  assert.equal((await models.AppointmentVisitMember.findByPk(101)).visit_id, parent.visit.id);
  assert.equal((await models.AppointmentVisitMember.findByPk(102)).role, 'primary');
  assert.deepEqual(await Promise.all([101, 102].map(readAppointment)), sourceBefore);
  await assert.rejects(claim(prp), { code: 'appointment_visit_held' });
  activePolicy = policy();
  const released = await Promise.all(Array.from({ length: 6 }, () => claim(prp)));
  assert.equal(released.filter(result => result.created).length, 1);
  assert.equal(new Set(released.map(result => result.communication.id)).size, 1);
  await assert.rejects(claim(prp, { purpose: 'reminder_same_day' }), { code: 'appointment_visit_notification_suppressed' });
  await assert.rejects(claim(prp, { window: { ...window(), starts_at: '2029-12-30T12:00:00.000Z' } }), { code: 'appointment_visit_held' });
  const releasedBinding = await materialize(released[0].communication); await releasedBinding.bind();
  await service.assertCommunicationCurrent({ communicationId: released[0].communication.id, clinicId: 66 });
  activePolicy = null;
  await assert.rejects(service.assertCommunicationCurrent({ communicationId: released[0].communication.id, clinicId: 66 }), { code: 'appointment_visit_held' });
  activePolicy = policy();
  for (const id of [401, 403]) {
    const qa = (await singleton(id)).visit;
    await assert.rejects(claim(qa), { code: 'appointment_visit_qa_forbidden' });
    assert.equal(await models.AppointmentVisitCommunication.count({ where: { visit_id: qa.id } }), 0);
  }
  activePolicy = null; const held = (await singleton(402)).visit;
  await assert.rejects(claim(held), { code: 'appointment_visit_held' });
  report.checks.push('actual reciprocal PRP audit/BIGINT receipt survives MySQL JSON; grouping rollback and 4 simultaneous grouped requests preserve parent owner and appointments; 6 imported claims deduplicate under verified policy, revocation/QA/HOLD/same-day/backlog close gates');

  const descendingBefore = await Promise.all([601, 602].map(readAppointment));
  const lockTrace = [], previousLogging = sql.options.logging;
  let descendingGroup;
  try {
    sql.options.logging = query => {
      const match = query.match(/`CitaPaciente`\.`id_cita` = (\d+)/);
      if (query.includes('FOR UPDATE') && match) lockTrace.push(Number(match[1]));
    };
    descendingGroup = await service.linkValidatedPrpVisit({ componentAppointmentId: 602, parentAppointmentId: 601, clinicId: 66, actorId: 7 });
  } finally { sql.options.logging = previousLogging; }
  assert.deepEqual(lockTrace, [601, 602]);
  assert.notEqual(descendingGroup.visit.id, prp.id, 'same patient/time never merges distinct explicit relations');
  assert.deepEqual(await Promise.all([601, 602].map(readAppointment)), descendingBefore);
  const preservedWait = await models.FlowExecutionV2.create({ idempotency_key: 'owned-legacy-wait', template_version_id: 42,
    status: 'waiting', clinic_id: 66, created_by: 7, trigger_type: 'appointment_created', trigger_entity_type: 'appointment',
    trigger_entity_id: 801, wait_until: new Date('2030-01-02T12:00:00.000Z'),
    waiting_meta: { type: 'delay/wait_response', pending_response_message_ids: [999] }, context: { appointment: { id_cita: 801 } } });
  await preservedWait.reload(); // Baseline must be persisted SQL, not create's optimistic defaults/DATE precision.
  const preservedWaitBefore = preservedWait.toJSON();
  await assert.rejects(service.linkValidatedPrpVisit({ componentAppointmentId: 802, parentAppointmentId: 801, clinicId: 66, actorId: 7 }),
    { code: 'appointment_visit_grouping_communication_history_requires_review' });
  assert.equal(await models.AppointmentVisitMember.count({ where: { appointment_id: { [S.Op.in]: [801, 802] } } }), 0);
  await preservedWait.reload(); assert.deepEqual(preservedWait.toJSON(), preservedWaitBefore);
  report.checks.push('actual SQL trace locks parent601 then component602 by numeric ID, not clinical role; same-time explicit pairs stay distinct; legacy wait blocks grouping and retains native pending reply IDs/wait ownership');

  const secondNative = (await singleton(204)).visit, acceptedIntent = await claim(secondNative);
  const acceptedBinding = await materialize(acceptedIntent.communication); await acceptedBinding.bind();
  await assert.rejects(models.Message.create({ ...acceptedBinding.message.toJSON(), id: undefined }), uniqueFailure);
  const otherIntent = await claim(secondNative, { window: window('second-window') });
  await assert.rejects(models.AppointmentVisitCommunication.update({ message_id: acceptedBinding.message.id }, { where: { id: otherIntent.communication.id } }), uniqueFailure);
  assert.equal((await models.AppointmentVisitCommunication.findByPk(otherIntent.communication.id)).message_id, null);
  await acceptedBinding.message.update({ status: 'failed', metadata: { execution_id: acceptedBinding.execution.id, wamid: 'owned-fixture-accepted' } });
  assert.equal((await service.reconcileDelivery({ communicationId: acceptedIntent.communication.id, clinicId: 66 })).status, 'accepted');
  assert.equal((await service.cancelCommunication({ communicationId: acceptedIntent.communication.id, clinicId: 66, reason: 'fixture_cancel' })).cancelled, false);
  const unknownIntent = await claim(secondNative, { window: window('unknown-window') }), unknownBinding = await materialize(unknownIntent.communication);
  await unknownBinding.bind();
  await unknownBinding.message.update({ status: 'failed', metadata: { execution_id: unknownBinding.execution.id, outcome_unknown: true } });
  assert.equal((await service.reconcileDelivery({ communicationId: unknownIntent.communication.id, clinicId: 66 })).status, 'unknown');
  assert.equal((await service.cancelCommunication({ communicationId: unknownIntent.communication.id, clinicId: 66, reason: 'fixture_cancel' })).cancelled, false);
  await assert.rejects(service.assertCommunicationCurrent({ communicationId: unknownIntent.communication.id, clinicId: 66 }), { code: 'appointment_visit_communication_not_dispatchable' });
  await assert.rejects(service.bindCommunication({ communicationId: unknownIntent.communication.id, clinicId: 66,
    executionId: acceptedBinding.execution.id, messageId: acceptedBinding.message.id }), { code: 'appointment_visit_binding_exists' });
  const acceptedBefore = (await models.AppointmentVisitCommunication.findByPk(acceptedIntent.communication.id)).toJSON();
  await models.CitaPaciente.update({ inicio: '2030-01-07T11:00:00.000Z', import_metadata: { automation_policy: 'hold', qa_demo: true } }, { where: { id_cita: 204 } });
  await acceptedBinding.message.update({ status: 'failed', metadata: { execution_id: acceptedBinding.execution.id } });
  assert.equal((await service.reconcileDelivery({ communicationId: acceptedIntent.communication.id, clinicId: 66 })).status, 'accepted');
  assert.equal((await service.cancelCommunication({ communicationId: unknownIntent.communication.id, clinicId: 66, reason: 'fixture_stale' })).communication.status, 'unknown');
  await unknownBinding.message.update({ status: 'sent', metadata: { execution_id: unknownBinding.execution.id, wamid: 'owned-fixture-late-acceptance' } });
  const reconciledUnknown = await service.reconcileDelivery({ communicationId: unknownIntent.communication.id, clinicId: 66 });
  assert.equal(reconciledUnknown.status, 'accepted'); assert.equal(reconciledUnknown.message_id, unknownBinding.message.id);
  assert.equal((await models.AppointmentVisitCommunication.findByPk(acceptedIntent.communication.id)).accepted_at.getTime(), acceptedBefore.accepted_at.getTime());
  assert.equal((await models.FlowExecutionV2.findByPk(acceptedBinding.execution.id)).status, 'running');
  report.checks.push('actual SQL Message delivery/binding uniqueness; accepted and unknown survive cancellation/HOLD/QA/stale projection/failed labels; unknown only advances on same Message, execution waits/state untouched');

  const purposeVisit = forcedRollback.visit, one = await claim(purposeVisit), two = await claim(purposeVisit, { purpose: 'reminder_day_before' });
  await service.cancelCommunication({ communicationId: one.communication.id, clinicId: 66, reason: 'fixture_purpose_only' });
  assert.equal((await models.AppointmentVisitCommunication.findByPk(two.communication.id)).status, 'pending');
  await assert.rejects(migration.down(qi), /durable history/);
  assert.equal((await qi.showAllTables()).filter(name => /^AppointmentVisit/.test(name)).length, 5);
  assert.equal(await models.PatientOperationalEvent.count(), 3);
  assert.equal(await models.Conversation.count(), 1);
  assert.deepEqual(await Promise.all([101, 102].map(readAppointment)), sourceBefore);
  report.checks.push('cancellation is per purpose without cancelling unrelated reminders; populated down refuses history; original source appointments/audit/conversation remain unchanged');
  report.coverage = { actualMysql: true, actualMigration: true, actualModels: true, actualFoundationService: true,
    realTransactions: true, concurrentSingletonRequests: 8, concurrentClaimRequests: 8, concurrentPrpRequests: 4,
    concurrentReleasedPrpClaims: 6, concurrentCasRefreshes: 2, providerCalls: 0, realPatientsTouched: 0,
    runtimeConsumersActivated: false, schedulerOutboxWaitsIntegrated: false };
}).catch(error => { console.error(error.stack); process.exitCode = 1; });
