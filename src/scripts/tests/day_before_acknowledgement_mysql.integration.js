'use strict';
const assert = require('node:assert/strict');
const D = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { adapt, FAMILY_KEY, NODE_ID } = require('../../lib/day-before-acknowledgement-review');

withIsolatedCampaignMysql(async ({ sql, models: db, report }) => {
  const net = require('node:net'), ownedConnect = net.connect, ownedCreateConnection = net.createConnection;
  require('./fixtures/security_offline_runtime.cjs'); db.Sequelize = D;
  // Preserve the fixture's owned Unix socket for additional pooled InnoDB
  // transactions; Socket.prototype.connect still rejects every other socket.
  net.connect = ownedConnect; net.createConnection = ownedCreateConnection;
  const events = [];
  const socketFile = require.resolve('../../services/socket.service');
  require.cache[socketFile] = { id: socketFile, filename: socketFile, loaded: true,
    exports: { getIO: () => ({ to: room => ({ emit: (event, payload) => events.push({ room, event, payload }) }) }) } };
  // Fictitious parent and metadata only; no app bootstrap/provider credentials.
  db.Conversation = sql.define('Conversation', { id: { type: D.INTEGER, primaryKey: true }, clinic_id: D.INTEGER,
    patient_id: D.INTEGER, lead_id: D.INTEGER, channel: D.STRING, contact_id: D.STRING,
    last_message_at: D.DATE, last_inbound_at: D.DATE, unread_count: D.INTEGER }, { tableName: 'Conversations' });
  for (const file of ['citapaciente', 'conversationautomationstate', 'notification', 'message']) {
    const model = require('../../../models/' + file)(sql, D); db[model.name] = model;
  }
  await sql.sync();
  await sql.getQueryInterface().createTable('FlowExecutionsV2', { id: { type: D.INTEGER, primaryKey: true }, context: D.JSON });
  for (const name of ['Paciente', 'Clinica', 'Usuario', 'LeadIntake']) db[name] = { findByPk: async () => null };
  db.UsuarioClinica = { findOne: async () => ({ id_usuario: 1 }) };
  await db.Conversation.create({ id: 501, clinic_id: 31, patient_id: 41, channel: 'whatsapp', contact_id: 'TESTONLY' });
  const start = new Date(Date.now() + 24 * 3600000);
  await db.CitaPaciente.create({ id_cita: 901, clinica_id: 31, paciente_id: 41,
    estado: 'recordatorio_enviado', inicio: start, fin: new Date(+start + 1800000) });
  await db.Message.create({ id: 101, conversation_id: 501, direction: 'inbound', message_type: 'text',
    status: 'read', content: 'Gracias' });
  const engine = require('../../services/flowEngineV2.service');
  const stateService = require('../../services/conversationAutomationState.service');
  const pending = require('../../services/conversationPendingReply.service');
  const graph = { template_key: FAMILY_KEY + '__clinic_31', trigger_type: 'appointment_reminder_window', nodes: [
    { id: 'N3', type: 'condition/ai_analysis', config: { preset_key: 'classify_intent' }, outputs: { on_success: 'N16' } },
    { id: 'N16', type: 'condition/field_check', config: { mode: 'multi_branch', branch_rules: [{ id: 'branch_ack' }] }, outputs: { branch_ack: null } },
    { id: 'N33', type: 'action/send_system_notification', config: { assignee_type: 'user', assignee_id: 1, title: 'Review', message: 'Review' } },
  ] };
  const node = adapt(graph).find(n => n.id === NODE_ID);
  const context = { conversation: { id: 501 }, appointment: { id_cita: 901, paciente_id: 41, clinica_id: 31,
    estado: 'recordatorio_enviado', inicio: start.toISOString() }, patient: { id: 41 }, paciente: { nombre: 'Paciente QA' },
    last_response_context: { response_message_id: 101 }, outputs: { N3: {
      intencion_principal: 'agradecimiento', confianza_intencion_principal: .96,
      necesita_respuesta: false, confianza_necesita_respuesta: .96, posible_urgencia: false } } };
  const execution = { id: 1001, clinic_id: 31, status: 'completed', trigger_type: graph.trigger_type,
    trigger_entity_type: 'appointment', trigger_entity_id: 901, templateVersion: graph, context };
  const prepare = () => stateService.setState({ clinicId: 31, conversationId: 501, stage: 'applying',
    executionId: 1001, appointmentId: 901, sourceMessageId: 101, needsResponse: false, manualActionRequired: false,
    completedAt: null }, { emit: false });
  await prepare();
  const before = (await db.CitaPaciente.findByPk(901)).toJSON();
  const first = await engine._processNode(node, context, { execution });
  assert.equal(first.output.notifications_created, 1, JSON.stringify(first));
  const repeated = await engine._processNode(node, context, { execution });
  assert.equal(repeated.output.notifications_created, 0); assert.equal(repeated.output.notifications_reused, 1);
  assert.equal(await db.Notification.count(), 1);
  assert.equal(events.filter(e => e.event === 'notification:created').length, 1);
  context.outputs[NODE_ID] = first.output;
  await engine._syncConversationAutomationStateAfterExecution(execution);
  let state = await db.ConversationAutomationState.findOne({ where: { conversation_id: 501 } });
  assert.equal(state.status, 'review'); assert.equal(state.manual_action_required, true); assert.equal(state.needs_response, false);
  const dto = (await pending.getPendingReplyStatesByConversationIds([501])).get(501);
  assert.equal(dto.automationManualActionRequired, true); assert.equal(dto.automationProcessingStatus, 'review');
  assert.ok(events.some(e => e.event === 'conversation:updated' && e.payload.automation_manual_action_required === true));
  assert.deepEqual((await db.CitaPaciente.findByPk(901)).toJSON(), before);
  assert.equal(await db.Message.count(), 1, 'no WhatsApp or synthetic historical message');
  report.checks.push('actual notification creation/reuse and real InnoDB review state, reload DTO and realtime event; appointment unchanged');

  // Concurrent worker retries serialize at the appointment and reuse one alert.
  await prepare(); await db.Notification.destroy({ where: {} });
  const concurrent = await Promise.all(Array.from({ length: 6 }, () => engine._processNode(node, context, { execution })));
  assert.equal(concurrent.reduce((sum, r) => sum + r.output.notifications_created, 0), 1);
  assert.equal(await db.Notification.count(), 1);
  report.checks.push('six simultaneous retries create one durable notification');

  // A failure after insert must roll back the alert, with no early socket emit.
  await db.Notification.destroy({ where: {} });
  const eventCount = events.length, originalCreate = db.Notification.findOrCreate;
  db.Notification.findOrCreate = async function (...args) { await originalCreate.apply(this, args); throw Error('TESTONLY notification rollback'); };
  try { await assert.rejects(engine._processNode(node, context, { execution }), /TESTONLY notification rollback/); }
  finally { db.Notification.findOrCreate = originalCreate; }
  assert.equal(await db.Notification.count(), 0); assert.equal(events.length, eventCount);
  report.checks.push('failed notification insert rolls back atomically and emits no realtime alert');

  await state.update({ status: 'completed', stage: 'completed', manual_action_required: false });
  const resolved = await engine._processNode(node, context, { execution });
  assert.equal(resolved.output.suppressed, true);
  await engine._syncConversationAutomationStateAfterExecution(execution);
  await state.reload(); assert.equal(state.manual_action_required, false); assert.equal(state.status, 'completed');
  report.checks.push('manual completion is not reopened by a retry or execution state sync');

  await prepare();
  await db.Message.create({ id: 102, conversation_id: 501, direction: 'outbound', sender_id: 1,
    message_type: 'text', status: 'sent', content: 'TESTONLY reception handled' });
  const human = await engine._processNode(node, context, { execution });
  assert.equal(human.output.status, 'resolved_before_notification');
  await engine._syncConversationAutomationStateAfterExecution(execution);
  await state.reload(); assert.equal(state.manual_action_required, false);
  await db.Message.destroy({ where: { id: 102 } });
  report.checks.push('a human reply suppresses both notification and pending card, including after an earlier review');

  for (const patch of [{ estado: 'recordatorio_confirmado' }, { estado: 'cancelada' },
    { inicio: new Date(Date.now() - 3600000) }, { inicio: new Date(+start + 3600000) }, { arrived_at: new Date() }]) {
    await prepare(); await db.CitaPaciente.update({ ...before, ...patch }, { where: { id_cita: 901 } });
    const result = await engine._processNode(node, context, { execution });
    assert.equal(result.output.suppressed, true);
    await engine._syncConversationAutomationStateAfterExecution(execution);
    await state.reload(); assert.equal(state.manual_action_required, false);
  }
  await db.CitaPaciente.update(before, { where: { id_cita: 901 } });
  await prepare();
  await state.update({ execution_id: 1002 });
  assert.equal((await engine._processNode(node, context, { execution })).output.suppressed, true);
  await state.reload();
  const owned = state.toJSON(); await engine._syncConversationAutomationStateAfterExecution(execution);
  await state.reload(); assert.deepEqual(state.toJSON(), owned);
  report.checks.push('confirmed/cancelled/started/rescheduled and changed conversation owner cannot create or revive review');

  // Same-day acknowledgments have no new node/flag and retain their terminal exit.
  delete context.outputs[NODE_ID];
  await prepare(); await engine._syncConversationAutomationStateAfterExecution(execution);
  await state.reload(); assert.equal(state.status, 'completed'); assert.equal(state.manual_action_required, false);
  report.checks.push('unpatched acknowledgment path retains previous completion; no effect on other families');
  report.coverage = { providerCalls: 0, outboundMessagesCreated: 0, isolated: true };
  console.log(JSON.stringify({ success: true, groups: report.checks.length, root: report.root }));
}).catch(error => { console.error(error.stack); process.exitCode = 1; });
