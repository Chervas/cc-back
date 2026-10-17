'use strict';
const assert = require('node:assert/strict');
const S = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { loadSource } = require('./fixtures/business_profile_flow_runtime.fixture');
const { createRuntime, DELAY_MS } = require('../../services/googleReviewReminder.service');
const { checkStoredPublication } = require('../../services/googleReviewPublication.service');

withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  models.Sequelize = S;
  const simple = (name, fields, table) => sql.define(name, fields, { tableName: table, timestamps: false });
  const pk = { type: S.DataTypes.INTEGER, primaryKey: true, autoIncrement: true };
  const int = S.DataTypes.INTEGER, json = S.DataTypes.JSON;
  models.AutomationFlowTemplateV2 = require('../../../models/automationflowtemplatev2')(sql, S.DataTypes);
  models.FlowExecutionV2 = require('../../../models/flowexecutionv2')(sql, S.DataTypes);
  models.MarketingPatientContactEvent = require('../../../models/marketingpatientcontactevent')(sql, S.DataTypes);
  models.MarketingPatientList = simple('MarketingPatientList', { id: pk, clinica_id: int, status: S.DataTypes.STRING, criteria: json }, 'MarketingPatientLists');
  models.MarketingPatientListItem = simple('MarketingPatientListItem', { id: pk, list_id: int, clinica_id: int, paciente_id: int, name: S.DataTypes.STRING, phone: S.DataTypes.STRING }, 'MarketingPatientListItems');
  models.Conversation = simple('Conversation', { id: pk, clinic_id: int, patient_id: int, last_inbound_at: S.DataTypes.DATE }, 'Conversations');
  models.Message = require('../../../models/message')(sql, S.DataTypes);
  models.JobRequest = simple('JobRequest', { id: pk, type: S.DataTypes.STRING, status: S.DataTypes.STRING, priority: S.DataTypes.STRING,
    payload: json, next_run_at: S.DataTypes.DATE, dedupe_scope: { type: S.DataTypes.STRING, unique: true } }, 'JobRequests');
  models.ClinicBusinessLocation = simple('ClinicBusinessLocation', { id: pk, is_active: S.DataTypes.BOOLEAN, raw_payload: json }, 'ClinicBusinessLocations');
  models.BusinessProfileReview = simple('BusinessProfileReview', { id: pk, business_location_id: int, reviewer_name: S.DataTypes.STRING,
    star_rating: int, matched_paciente_id: int, match_confidence: S.DataTypes.FLOAT, create_time: S.DataTypes.DATE, google_missing_at: S.DataTypes.DATE }, 'BusinessProfileReviews');
  models.Paciente = simple('Paciente', { id_paciente: { type: int, primaryKey: true }, nombre: S.DataTypes.STRING, apellidos: S.DataTypes.STRING }, 'Pacientes');
  await sql.sync();
  await sql.getQueryInterface().addIndex('AutomationFlowTemplatesV2', ['public_id', 'version'], { unique: true });
  await sql.getQueryInterface().addIndex('FlowExecutionsV2', ['idempotency_key'], { unique: true });
  const now = new Date('2026-10-20T12:00:00Z'), linkAt = new Date(+now - DELAY_MS);
  await models.MarketingPatientList.create({ id: 1, clinica_id: 59, status: 'completed', criteria: { review_request: true } });
  await models.MarketingPatientListItem.create({ id: 2, list_id: 1, clinica_id: 59, paciente_id: 7, name: 'Ana Prueba Apellido', phone: '34600000000' });
  await models.Paciente.create({ id_paciente: 7, nombre: 'Ana', apellidos: 'Prueba Apellido' });
  await models.Conversation.create({ id: 3, clinic_id: 59, patient_id: 7, last_inbound_at: new Date(+linkAt - 60000) });
  await models.Message.create({ id: 8, conversation_id: 3, direction: 'outbound', content: 'TESTONLY original link', message_type: 'text',
    status: 'read', sent_at: linkAt, metadata: { wamid: 'wamid.TESTONLY' } });
  const event = await models.MarketingPatientContactEvent.create({ list_id: 1, item_id: 2, paciente_id: 7,
    event_type: 'review_rating_followup_sent', channel: 'whatsapp', occurred_at: linkAt,
    payload: { status: 'sent', kind: 'review_google_link_followup', test_send: false, google_publication_reminder_enabled: true,
      google_link_sent_at: linkAt.toISOString(), google_review_url: 'https://search.google.com/local/writereview?placeid=TESTONLY',
      clinic_id: 59, conversation_id: 3, sender_origin_id: 4, phoneNumberId: 'secondary', recipient: '34600000000',
      app_message_id: 8, provider_message_id: 'wamid.TESTONLY' } });
  await models.ClinicBusinessLocation.create({ id: 11, is_active: true, raw_payload: {
    clinicaclick_reviews_complete_synced_at: new Date(+now - 3600000).toISOString(), clinicaclick_reviews_complete_count: 0 } });
  const matcher = loadSource('googleReviewMatch.service', { '../../models': models, './jobRequests.service': {} });
  const engine = loadSource('flowEngineV2.service', { '../../models': models, './jobRequests.service': { getCurrentRuntimeNamespace: () => 'test' } }, {}, 10000);
  const sender = { originId: 4, phoneNumberId: 'secondary' }, queued = [];
  let runtime;
  const bulk = { assertReviewRequestCommunicationAllowed: async () => {}, reviewReminderAllowedAt: async (_list, at) => ({ at }),
    getGoogleReviewPublicationState: args => checkStoredPublication(models, { ...args, locationIds: [11], now }, matcher.scoreNameMatch) };
  runtime = createRuntime({ db: models, bulk, now: () => now,
    normalizePhone: v => String(v || '').replace(/\D/g, ''),
    serviceWindow: async () => ({ open: true, matchedBy: 'message_phone_number_id', lastInboundAt: new Date(+linkAt - 60000) }),
    engine: { computeQuietHoursDelayMs: engine.computeQuietHoursDelayMs, findOrCreateAutomationWhatsappMessage: engine.findOrCreateAutomationWhatsappMessage,
      resolveScheduledWhatsappSenderConfig: async () => sender,
      enqueueAutomationWhatsappTransport: async ({ msg }) => { queued.push(msg.id); await msg.update({ metadata: { ...msg.metadata, automation_transport_job_id: 'TESTONLY' } }); } },
    stop: { createExecution: values => models.FlowExecutionV2.create(values), isStop: () => false },
    enqueueJob: async values => { const [job] = await models.JobRequest.findOrCreate({ where: { dedupe_scope: values.dedupeScope }, defaults: {
      type: values.type, status: values.status, priority: values.priority, payload: values.payload, next_run_at: values.nextRunAt } }); return { job }; },
    triggerJob: async () => {} });
  await runtime.ensureCatalog(59);
  const results = await Promise.all(Array.from({ length: 8 }, () => runtime.schedule(event)));
  assert(results.every(r => r.execution_id === results[0].execution_id));
  assert.equal(await models.FlowExecutionV2.count(), 1); assert.equal(await models.JobRequest.count(), 1);
  assert.equal(await models.AutomationFlowTemplateV2.count(), 2);
  report.checks.push('8 concurrent future-link schedules share actual unique execution/job indexes');
  const exec = await models.FlowExecutionV2.findByPk(results[0].execution_id);
  const template = await models.AutomationFlowTemplateV2.findByPk(exec.template_version_id);
  const readNode = template.nodes.find(n => n.type === 'condition/google_review_check');
  const processEngine = loadSource('flowEngineV2.service', { '../../models': models,
    './jobRequests.service': { getCurrentRuntimeNamespace: () => 'test' }, './marketingBulkSends.service': bulk,
    './googleReviewReminder.service': { current: () => runtime } }, {}, 10000);
  const check = await processEngine._processNode(readNode, exec.context, { execution: exec });
  assert.equal(check.next_node_id, 'N4'); assert.equal(check.output.state, 'not_detected');
  const actionNode = template.nodes.find(n => n.type === 'action/remind_google_review');
  const a = await processEngine._processNode(actionNode, exec.context, { execution: exec });
  const b = await processEngine._processNode(actionNode, exec.context, { execution: exec });
  assert.equal(a.output.status, 'queued'); assert.equal(b.output.status, 'already_recorded');
  assert.equal(await models.Message.count({ where: { message_type: 'text', direction: 'outbound' } }), 2);
  assert.equal(queued.length, 1);
  report.checks.push('current native V2 condition/action run against local SQL without provider calls; duplicate action sends once');
  const message = await models.Message.findByPk(a.output.message_id);
  assert.equal((await runtime.authorizeTransport({ message, to: '34600000000', sender, useTemplate: false, now })).allowed, true);
  await models.BusinessProfileReview.create({ id: 19, business_location_id: 11, reviewer_name: 'Ana Prueba Apellido',
    star_rating: 1, create_time: new Date(+now - 60000) });
  const found = await processEngine._processNode(readNode, exec.context, { execution: exec });
  assert.equal(found.next_node_id, 'N5');
  assert.equal((await runtime.authorizeTransport({ message, to: '34600000000', sender, useTemplate: false, now })).reason, 'google_review_found');
  await message.reload(); assert.equal(message.metadata.google_review_reminder_skipped, true);
  report.checks.push('a one-star review arriving while transport waits stops the queued message');
  await models.BusinessProfileReview.destroy({ where: { id: 19 } });
  assert.equal((await runtime.authorizeTransport({ message, to: '34600000000', sender, useTemplate: false, now })).allowed, false);
  report.checks.push('a skipped message cannot resurrect after the review disappears');
  await models.ClinicBusinessLocation.update({ raw_payload: { clinicaclick_reviews_complete_synced_at: new Date(+now - 3 * 3600000).toISOString(), clinicaclick_reviews_complete_count: 0 } }, { where: { id: 11 } });
  const stale = await processEngine._processNode(readNode, exec.context, { execution: exec });
  assert.equal(stale.next_node_id, 'N5'); assert.equal(stale.output.state, 'unknown');
  report.checks.push('stale local observations close the V2 flow instead of sending or requesting Google');
  const old = event.toJSON(); delete old.payload.google_publication_reminder_enabled;
  assert.equal((await runtime.schedule(old)).skipped, true); assert.equal(await models.FlowExecutionV2.count(), 1);
  report.checks.push('historical receipts are not replayed');
}).catch(error => { console.error(error); process.exitCode = 1; });
