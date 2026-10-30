'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DataTypes: D } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createTemporaryPatientDirectionService } = require('../../services/temporaryPatientDirection.service');
const { createLeadPatientAttentionService } = require('../../services/leadPatientAttention.service');
const { createLeadPatientContextService } = require('../../services/leadPatientContext.service');
const { LEAD_PATIENT_CONTEXT_TYPE, LEAD_PATIENT_ATTENTION_TYPE, leadPatientContextSql } = require('../../lib/lead-patient-context');
const { temporaryQuickChatEligibilitySql, attachTemporaryQuickChatEligibility } = require('../../lib/temporary-quickchat-focus');

test('temporary attention: actual models, SQL locks, commit/rollback and list projection without provider access', {
  skip: process.env.CAMPAIGN_OPTIMIZATION_MYSQL_TEST !== '1', timeout: 120000,
}, async () => withIsolatedCampaignMysql(async ({ sql, models: db, report }) => {
  sql.define('Clinica', { id_clinica: { type: D.INTEGER, primaryKey: true } }, { tableName: 'Clinicas', timestamps: false });
  sql.define('Paciente', { id_paciente: { type: D.INTEGER, primaryKey: true } }, { tableName: 'Pacientes', timestamps: false });
  for (const file of ['usuario', 'leadintake', 'leadattributionaudit', 'leadcontactattempt', 'citapaciente', 'conversation', 'message', 'patientoperationalevent']) {
    const model = require('../../../models/' + file)(sql, D); db[model.name] = model;
  }
  db.PatientOperationalEvent.options.indexes.forEach((index, i) => { index.name = 'temporary_attention_poe_' + i; });
  await sql.sync();
  await sql.models.Clinica.bulkCreate([66, 72, 77, 35].map(id_clinica => ({ id_clinica })));
  await sql.models.Paciente.bulkCreate([100, 101, 102].map(id_paciente => ({ id_paciente })));
  await db.Usuario.create({ id_usuario: 44, nombre: 'Graci', email_usuario: 'maria.gonzalez@modmarketing.net' });
  // This fixture seeds explicit snapshots below; intake classification is tested
  // by the context suite, not against these deliberately minimal patient tables.
  const lead = await db.LeadIntake.create({ clinica_id: 72 }, { hooks: false });
  const conversation = await db.Conversation.create({ clinic_id: 72, channel: 'whatsapp', lead_id: lead.id });
  const notifications = [], warnings = [];
  const contexts = createLeadPatientContextService(db);
  const snapshot = (leadId, context) => db.LeadAttributionAudit.create({ lead_intake_id: leadId, attribution_steps: {
    type: LEAD_PATIENT_CONTEXT_TYPE, [LEAD_PATIENT_CONTEXT_TYPE]: { version: 1, ...context },
  } });
  await snapshot(lead.id, {
    relationship: 'new_contact', patient_id: null, clinic_id: 72, clinic_name: 'Synthetic clinic',
    same_clinic: true, captured_at: new Date().toISOString(), reason: 'synthetic_snapshot', request_kind: 'commercial',
  });
  const attention = createLeadPatientAttentionService(db, { contexts, authorize: async () => true, isAdmin: () => false });
  const service = createTemporaryPatientDirectionService(db, { patientContextService: contexts, patientAttentionService: attention,
    notify: event => notifications.push(event.id), warn: code => warnings.push(code) });
  await Promise.all(Array.from({ length: 10 }, () => service.observeConversation(conversation)));
  assert.equal((await lead.reload()).asignado_a, 44);
  assert.equal(await db.Message.count(), 1, 'row lock plus unique identity deduplicates concurrent observations');
  const [active] = await service.enrich([conversation]);
  assert.equal(active.patient_direction.mode, 'temporary_clinic_phone');
  assert.equal(active.patient_direction.director_name, 'Graci', 'real Usuario uses email_usuario, not email');
  await conversation.update({ patient_id: 100 });
  const tomorrow = new Date(Date.now() + 86400000);
  const appointment = await db.CitaPaciente.create({ clinica_id: 72, paciente_id: 100, lead_intake_id: lead.id,
    created_by: 99, inicio: tomorrow, fin: new Date(+tomorrow + 1800000), estado: 'info_confirmada' });
  await service.observeAppointment(appointment);
  assert.equal((await service.enrich([conversation]))[0].patient_direction.status, 'active');
  await db.CitaPaciente.create({ clinica_id: 72, paciente_id: 101, lead_intake_id: lead.id,
    inicio: new Date(+tomorrow - 1000), fin: tomorrow, estado: 'completada' });
  await service.observeAppointment(appointment);
  assert.equal(await db.Message.count(), 1, 'same lead does not override the exact patient identity');
  const predicate = temporaryQuickChatEligibilitySql();
  const [[before]] = await sql.query('SELECT ' + predicate + ' AS eligible FROM Conversations AS Conversation WHERE id=:id',
    { replacements: { id: conversation.id } });
  assert.equal(before.eligible, 1);
  const marker = await db.Message.findOne();
  assert.equal(marker.sender_id, null);
  assert.equal(marker.message_type, 'event');
  assert.equal(marker.status, 'sent');
  assert.equal(marker.metadata.source, 'temporary_patient_direction');
  report.checks.push('Real core model schema, one marker under ten concurrent SQL transactions, lead assignment and conversion preserve ownership without creating a WhatsApp job.');

  const rollbackConversation = await db.Conversation.create({ clinic_id: 66, patient_id: 102, channel: 'whatsapp' });
  const transaction = await sql.transaction();
  await service.observeConversation(rollbackConversation, { transaction, actorUserId: 44 });
  await transaction.rollback();
  assert.equal(await db.Message.count({ where: { conversation_id: rollbackConversation.id } }), 0);
  await sql.transaction(async transaction => {
    await appointment.update({ estado: 'completada' }, { transaction });
    await service.observeAppointment(appointment, { transaction });
  });
  assert.equal(await db.Message.count(), 2);
  assert.equal((await service.enrich([conversation]))[0].patient_direction, null);
  const [eligibility] = await attachTemporaryQuickChatEligibility([conversation.toJSON()],
    { userId: 44, email: 'maria.gonzalez@modmarketing.net' }, db.CitaPaciente);
  assert.equal(eligibility.quickchat_list_eligible, false);
  await service.observeAppointment(appointment);
  assert.equal(await db.Message.count(), 2);
  assert.equal(notifications.length, 2);
  report.checks.push('After-commit only, rollback leaves no marker; first actual completion writes one handoff and removes the conversation from Graci habitual list, not clinic ACLs.');

  const unrelated = await db.Conversation.create({ clinic_id: 77, patient_id: 102, channel: 'whatsapp' });
  await service.observeConversation(unrelated);
  assert.equal(await db.Message.count({ where: { conversation_id: unrelated.id } }), 0, 'reading does not claim an unrelated patient');

  const eligible = async () => {
    const [[row]] = await sql.query('SELECT ' + predicate + ' AS eligible FROM Conversations AS Conversation WHERE id=:id',
      { replacements: { id: conversation.id } });
    return Number(row.eligible);
  };
  const existingContext = { relationship: 'existing_patient', patient_id: 100, clinic_id: 72,
    clinic_name: 'Synthetic clinic', same_clinic: true, captured_at: new Date().toISOString(),
    reason: 'synthetic_existing_patient', request_kind: 'commercial' };
  const request = await db.LeadIntake.create({ clinica_id: 72 }, { hooks: false });
  await snapshot(request.id, existingContext);
  await conversation.update({ lead_id: request.id });
  const oldCount = await db.Message.count();
  await service.observeConversation(conversation);
  assert.equal((await request.reload()).asignado_a, null);
  assert.equal((await service.enrich([conversation]))[0].patient_direction.status, 'pending_review');
  assert.equal(await db.Message.count(), oldCount, 'review does not assert active care or claim a lead');
  assert.equal(await eligible(), 1, 'the previous lead handoff does not hide the new request');
  await attention.decide({ leadId: request.id, actorId: 44, decision: 'director', requestKind: 'patient_care' });
  assert.equal((await service.enrich([conversation]))[0].patient_direction.status, 'active');
  for (const leadAlias of ['LeadIntake', 'request_alias']) {
    const expressions = leadPatientContextSql({ leadAlias });
    const [projection] = await sql.query(`SELECT \`${leadAlias}\`.id,
      ${expressions.relationship} AS relationship, ${expressions.request_kind} AS request_kind,
      ${expressions.persisted} AS persisted FROM LeadIntakes AS \`${leadAlias}\`
      WHERE \`${leadAlias}\`.id IN (:ids) ORDER BY \`${leadAlias}\`.id`,
    { replacements: { ids: [lead.id, request.id] } });
    assert.deepEqual(projection.map(row => ({ ...row, persisted: Number(row.persisted) })), [
      { id: lead.id, relationship: 'new_contact', request_kind: 'commercial', persisted: 1 },
      { id: request.id, relationship: 'existing_patient', request_kind: 'patient_care', persisted: 1 },
    ], `actual MySQL projection uses the core audit types with alias ${leadAlias}`);
  }
  report.checks.push('Real patient-context SQL projections with default and custom lead aliases use the exported core audit types and retain director/patient_care independently of relationship.');
  await service.observeConversation(conversation);
  const own = await db.CitaPaciente.create({ clinica_id: 72, paciente_id: 100, lead_intake_id: request.id,
    inicio: new Date(+tomorrow + 3600000), fin: new Date(+tomorrow + 5400000), estado: 'info_confirmada' });
  for (const patch of [{ lead_intake_id: lead.id }, { paciente_id: 101 }, { clinica_id: 66 },
    { source_system: 'cliniccloud' }, { es_provisional: true }, { care_legacy_attendance: true }]) {
    await db.CitaPaciente.create({ clinica_id: 72, paciente_id: 100, lead_intake_id: request.id,
      inicio: tomorrow, fin: new Date(+tomorrow + 1800000), estado: 'completada', ...patch });
  }
  await service.observeAppointment(own);
  assert.equal((await service.enrich([conversation]))[0].patient_direction.status, 'active');
  assert.equal(await eligible(), 1, 'unrelated attendance does not close the request');
  await own.update({ estado: 'completada' });
  await service.observeAppointment(own);
  assert.equal((await service.enrich([conversation]))[0].patient_direction, null);
  assert.equal(await eligible(), 0);
  await service.observeConversation(conversation, { actorUserId: 44 });
  assert.equal(await db.Message.count({ where: {
    automation_delivery_key: `temporary-patient-direction:handoff:lead:72:${request.id}`,
  } }), 1, 'completion is idempotent per request');
  report.checks.push('Real attention decide + temporal projection + paginated SQL: existing-patient request remains pending until decided; only the same lead, patient and clinic can hand off, never historical/imported/provisional attendance.');

  const transferred = await db.LeadIntake.create({ clinica_id: 72 }, { hooks: false });
  await snapshot(transferred.id, existingContext);
  await conversation.update({ lead_id: transferred.id });
  await attention.decide({ leadId: transferred.id, actorId: 44, decision: 'director' });
  await service.observeConversation(conversation);
  assert.equal((await service.enrich([conversation]))[0].patient_direction.status, 'active');
  await attention.decide({ leadId: transferred.id, actorId: 44, decision: 'clinic', requestKind: 'patient_care' });
  await db.LeadAttributionAudit.create({ lead_intake_id: transferred.id, attribution_steps: { action: 'unrelated_later_audit' } });
  const afterTransfer = await db.Message.count();
  await service.observeConversation(conversation, { actorUserId: 44 });
  assert.equal((await transferred.reload()).asignado_a, null, 'observation does not reclaim a transferred lead');
  assert.equal((await service.enrich([conversation]))[0].patient_direction, null);
  assert.equal(await eligible(), 0, 'clinic decision wins over an existing active marker');
  assert.equal(await db.Message.count(), afterTransfer);
  const selected = (await attention.decisions([transferred.id])).get(transferred.id);
  assert.equal(selected.version, 1); assert.equal(selected.decision, 'clinic');
  assert.equal(selected.actor_user_id, 44);
  for (const malformed of [
    { type: 'unrelated', [LEAD_PATIENT_ATTENTION_TYPE]: { ...selected, decision: 'director' } },
    { type: LEAD_PATIENT_ATTENTION_TYPE, [LEAD_PATIENT_ATTENTION_TYPE]: { ...selected, decision: 'director', version: 2 } },
    { type: LEAD_PATIENT_ATTENTION_TYPE, [LEAD_PATIENT_ATTENTION_TYPE]: { ...selected, decision: 'invalid' } },
    { type: LEAD_PATIENT_ATTENTION_TYPE, [LEAD_PATIENT_ATTENTION_TYPE]: { ...selected, decision: 'director', request_kind: 'invalid' } },
  ]) {
    await db.LeadAttributionAudit.create({ lead_intake_id: transferred.id, attribution_steps: malformed });
    assert.equal((await attention.decisions([transferred.id])).get(transferred.id).decision, 'clinic');
    assert.equal(await eligible(), 0, 'SQL and decision service ignore the same invalid or unrelated audit rows');
  }
  const pending = await db.LeadIntake.create({ clinica_id: 72 }, { hooks: false });
  await snapshot(pending.id, { ...existingContext, relationship: 'possible_patient' });
  await conversation.update({ lead_id: pending.id });
  assert.equal((await service.enrich([conversation]))[0].patient_direction.status, 'pending_review');
  assert.equal(await eligible(), 1);
  await pending.update({ asignado_a: 99 });
  await service.observeConversation(conversation, { actorUserId: 44 });
  assert.equal((await service.enrich([conversation]))[0].patient_direction, null);
  assert.equal(await eligible(), 0, 'the list also respects human ownership');
  assert.equal((await pending.reload()).asignado_a, 99);
  report.checks.push('A versioned clinic decision excludes even marked chats; unrelated audits do not erase it, a new lead receives its own review, and human ownership is preserved.');

  const discarded = await db.LeadIntake.create({ clinica_id: 72 }, { hooks: false });
  await snapshot(discarded.id, existingContext);
  await conversation.update({ lead_id: discarded.id });
  await attention.decide({ leadId: discarded.id, actorId: 44, decision: 'director' });
  await service.observeConversation(conversation);
  assert.equal((await service.enrich([conversation]))[0].patient_direction.status, 'active');
  assert.equal(await eligible(), 1);
  await discarded.update({ status_lead: 'descartado' });
  await service.observeConversation(conversation);
  assert.equal((await service.enrich([conversation]))[0].patient_direction, null);
  assert.equal(await eligible(), 0, 'discard closes the active projection even though its start marker is retained');
  report.checks.push('A discarded lead loses the active marker in both the DTO and list SQL without deleting its request audit history.');

  const arrivalLead = await db.LeadIntake.create({ clinica_id: 72, status_lead: 'citado' }, { hooks: false });
  await snapshot(arrivalLead.id, existingContext);
  await conversation.update({ lead_id: arrivalLead.id });
  const beforeFailedDecision = await db.Message.count();
  db.Message.addHook('beforeCreate', 'rejectSyntheticAttentionEvent', message => {
    if (message.metadata?.source === LEAD_PATIENT_ATTENTION_TYPE && Number(message.metadata.lead_id) === arrivalLead.id) {
      throw Error('SYNTHETIC_ATTENTION_EVENT_REJECTED');
    }
  });
  try {
    await assert.rejects(attention.decide({ leadId: arrivalLead.id, actorId: 44, decision: 'director' }),
      /SYNTHETIC_ATTENTION_EVENT_REJECTED/);
  } finally { db.Message.removeHook('beforeCreate', 'rejectSyntheticAttentionEvent'); }
  assert.equal((await attention.decisions([arrivalLead.id])).has(arrivalLead.id), false,
    'the audit cannot survive a failed decision transaction');
  assert.equal((await arrivalLead.reload()).asignado_a, null, 'the assignment rolls back with its audit');
  assert.equal(await db.Message.count(), beforeFailedDecision);
  assert.equal((await service.enrich([conversation]))[0].patient_direction.status, 'pending_review');
  await attention.decide({ leadId: arrivalLead.id, actorId: 44, decision: 'director' });
  await service.observeConversation(conversation);
  report.checks.push('A rejected internal decision event rolls back the actual audit and lead assignment together; retry commits once and activates the same request.');

  const arrival = await db.CitaPaciente.create({ clinica_id: 72, paciente_id: 100, lead_intake_id: arrivalLead.id,
    inicio: tomorrow, fin: new Date(+tomorrow + 1800000), estado: 'info_confirmada',
    arrived_at: tomorrow, care_schedule_start: new Date(+tomorrow - 86400000) });
  const arrivalKey = `temporary-patient-direction:handoff:lead:72:${arrivalLead.id}`;
  const handoffCount = () => db.Message.count({ where: { automation_delivery_key: arrivalKey } });
  await service.observeAppointment(arrival);
  assert.equal(await handoffCount(), 0, 'arrival from an obsolete schedule cannot close the request');
  const beforeArrivalNotifications = notifications.length;
  await assert.rejects(sql.transaction(async transaction => {
    await arrival.update({ estado: 'ha_acudido', care_schedule_start: arrival.inicio }, { transaction });
    await service.observeAppointment(arrival, { transaction });
    assert.equal(await handoffCount(), 0, 'the observer does not publish before commit');
    throw Error('SYNTHETIC_ARRIVAL_ROLLBACK');
  }), /SYNTHETIC_ARRIVAL_ROLLBACK/);
  await arrival.reload();
  assert.equal(arrival.estado, 'info_confirmada');
  assert.equal(await handoffCount(), 0);
  assert.equal(notifications.length, beforeArrivalNotifications);
  assert.equal((await service.enrich([conversation]))[0].patient_direction.status, 'active');
  assert.equal(await eligible(), 1);
  await sql.transaction(async transaction => {
    await arrival.update({ estado: 'ha_acudido', care_schedule_start: arrival.inicio }, { transaction });
    await service.observeAppointment(arrival, { transaction });
    assert.equal(await handoffCount(), 0, 'the successful transaction also waits for commit');
  });
  assert.equal(await handoffCount(), 1);
  assert.equal(notifications.length, beforeArrivalNotifications + 1);
  assert.equal((await service.enrich([conversation]))[0].patient_direction, null);
  assert.equal(await eligible(), 0);
  const [rootAttention] = await attention.enrich(await contexts.enrich([await arrivalLead.reload()]), { actorId: 44 });
  assert.equal(arrivalLead.status_lead, 'citado', 'the handoff guard must not depend on an asynchronous lead status update');
  assert.equal(rootAttention.patient_attention.state, 'completed');
  assert.equal(rootAttention.patient_attention.can_decide, false);
  const resolvedAuditCount = await db.LeadAttributionAudit.count({ where: { lead_intake_id: arrivalLead.id } });
  const resolvedMessageCount = await db.Message.count();
  for (const change of [{ decision: 'clinic', requestKind: 'commercial' }, { decision: 'director', requestKind: 'patient_care' }]) {
    await assert.rejects(attention.decide({ leadId: arrivalLead.id, actorId: 44, ...change }),
      { status: 409, code: 'patient_attention_already_resolved' });
  }
  assert.equal(await db.LeadAttributionAudit.count({ where: { lead_intake_id: arrivalLead.id } }), resolvedAuditCount);
  assert.equal(await db.Message.count(), resolvedMessageCount);
  assert.equal((await arrivalLead.reload()).asignado_a, 44, 'rejected decisions cannot mutate the stored owner');
  report.patientAttentionAfterHandoff = { leadStatus: arrivalLead.status_lead,
    state: rootAttention.patient_attention.state, canDecide: rootAttention.patient_attention.can_decide,
    expectedState: 'completed', temporaryDirection: null, decisionChangeStatus: 409 };
  report.checks.push('A real per-lead handoff yields root completed/can_decide=false while the lead is still citado; new ownership/purpose decisions fail with 409 and create no audit, message or owner change.');
  await arrival.update({ estado: 'completada' });
  await service.observeAppointment(arrival);
  assert.equal(await handoffCount(), 1, 'completion following arrival does not duplicate the handoff');
  report.checks.push('Stale arrival and rolled-back arrival cannot hand off an existing-patient request; committed arrival publishes exactly once after commit, and later completion remains idempotent.');

  const racingLead = await db.LeadIntake.create({ clinica_id: 72 }, { hooks: false });
  await snapshot(racingLead.id, existingContext);
  await conversation.update({ lead_id: racingLead.id });
  await attention.decide({ leadId: racingLead.id, actorId: 44, decision: 'director' });
  await service.observeConversation(conversation);
  let decisionTransaction, releaseDecision, decisionLocked, observationStarted;
  const gate = new Promise(resolve => { releaseDecision = resolve; });
  const locked = new Promise(resolve => { decisionLocked = resolve; });
  const observing = new Promise(resolve => { observationStarted = resolve; });
  const bounded = async promise => {
    let timeout;
    try { return await Promise.race([promise, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(Error('SYNTHETIC_RACE_BARRIER_TIMEOUT')), 3000);
    })]); } finally { clearTimeout(timeout); }
  };
  db.LeadAttributionAudit.addHook('afterCreate', 'holdSyntheticClinicDecision', async (audit, options) => {
    if (Number(audit.lead_intake_id) === racingLead.id && audit.attribution_steps?.[LEAD_PATIENT_ATTENTION_TYPE]?.decision === 'clinic') {
      decisionTransaction = options.transaction;
      decisionLocked();
      await gate;
    }
  });
  db.Conversation.addHook('beforeFind', 'observeSyntheticLockWait', options => {
    if (Number(options.where?.id) === conversation.id && options.lock && options.transaction !== decisionTransaction) observationStarted();
  });
  let choosing, observingRequest;
  const beforeRaceNotifications = notifications.length;
  try {
    choosing = attention.decide({ leadId: racingLead.id, actorId: 44, decision: 'clinic' });
    // Attach a handler immediately so a failed barrier cannot leave an unhandled rejection.
    choosing.catch(() => {});
    await bounded(locked);
    observingRequest = service.ensure(conversation.id, 44);
    await bounded(observing);
    releaseDecision();
    assert.equal((await choosing).changed, true);
    assert.equal(await observingRequest, null);
  } finally {
    releaseDecision();
    await Promise.allSettled([choosing, observingRequest]);
    db.LeadAttributionAudit.removeHook('afterCreate', 'holdSyntheticClinicDecision');
    db.Conversation.removeHook('beforeFind', 'observeSyntheticLockWait');
  }
  assert.equal((await racingLead.reload()).asignado_a, null);
  assert.equal((await service.enrich([conversation]))[0].patient_direction, null);
  assert.equal(await eligible(), 0);
  assert.equal(notifications.length, beforeRaceNotifications);
  assert.equal(await db.Message.count({ where: {
    automation_delivery_key: `temporary-patient-direction:start:lead:72:${racingLead.id}`,
  } }), 1, 'the observer cannot reclaim or restart the lead after waiting for the decision lock');
  assert.deepEqual(warnings, [], 'no swallowed SQL errors or deadlocks are accepted');
  report.checks.push('A real clinic decision holds its transaction while the temporal observer requests the same row lock; after commit the observer reads clinic ownership, never reclaims the lead, and raises no SQL warning.');

  await db.PatientOperationalEvent.drop();
  await sql.transaction(async transaction => {
    await appointment.update({ nota: 'Synthetic clinical operation committed' }, { transaction });
    await service.observeConversation(unrelated, { transaction });
  });
  assert.equal((await appointment.reload()).nota, 'Synthetic clinical operation committed');
  assert.equal(warnings.at(-1), 'ER_NO_SUCH_TABLE');
  report.checks.push('Missing tracking schema is isolated after commit: synthetic clinical operation remains committed; no Meta, Redis or real database connection occurred.');
}));
