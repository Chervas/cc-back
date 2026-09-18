'use strict';
// The provider's incorrect false/false result is deliberately preserved. This
// checks its operational destination and durable state, not semantic accuracy.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const D = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { cloneConfirmAppointmentDecisionConfig } = require('../../lib/automation-intent-contract');
const socketFile = require.resolve('../../services/socket.service');
const events = [];
require.cache[socketFile] = { id: socketFile, filename: socketFile, loaded: true,
  exports: { getIO: () => ({ to: room => ({ emit: (event, payload) => events.push({ room, event, payload }) }) }) } };
const definitionsFile = process.env.AUTOMATION_AI_DEFINITIONS_FILE;
const definitions = definitionsFile ? JSON.parse(fs.readFileSync(definitionsFile)) : [{ id: 'fictitious', is_active: true, nodes: [
  { id: 'ai', type: 'condition/ai_analysis', config: { preset_key: 'confirm_appointment' }, outputs: { on_success: 'router' } },
  { id: 'router', type: 'condition/field_check', config: cloneConfirmAppointmentDecisionConfig('ai'), outputs: {
    branch_confirm_without_reply: 'confirm', branch_confirm_needs_reply: 'reply', branch_not_confirmed: 'review', on_else: 'review',
  } },
  { id: 'review', type: 'action/send_system_notification', config: { title: 'Fictitious review' }, outputs: { on_success: null } },
] }];

withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  // The MySQL fixture must capture the original socket connector first. Its
  // offline preload is already cached; this adds inert env/dotenv only.
  require('./fixtures/security_offline_runtime.cjs');
  models.Sequelize = D;
  // Real state/appointment/message models; only the conversation ID FK parent
  // is a minimal fixture. No user accounts, recipients or providers are loaded.
  await sql.getQueryInterface().createTable('Conversations', { id: { type: D.INTEGER, primaryKey: true } });
  await sql.query('INSERT INTO Conversations (id) VALUES (501)');
  for (const [name, file] of [['ConversationAutomationState', 'conversationautomationstate'], ['CitaPaciente', 'citapaciente'], ['Message', 'message']]) {
    models[name] = require('../../../models/' + file)(sql, D); await models[name].sync();
  }
  await models.CitaPaciente.create({ id_cita: 901, clinica_id: 31, paciente_id: 41, estado: 'recordatorio_enviado',
    inicio: new Date('2030-01-01T12:00:00Z'), fin: new Date('2030-01-01T12:30:00Z') });
  await models.Message.create({ id: 101, conversation_id: 501, direction: 'inbound', message_type: 'text', status: 'read',
    content: 'No podré asistir a esa cita. Necesito cambiarla de día.' });
  const flow = require('../../services/flowEngineV2.service');
  const stateService = require('../../services/conversationAutomationState.service');
  const pending = require('../../services/conversationPendingReply.service');
  const appointmentBefore = (await models.CitaPaciente.findByPk(901)).get({ plain: true });
  const messageBefore = (await models.Message.findByPk(101)).get({ plain: true });
  const cases = []; let executionId = 1000; let lastRealtimePayload;
  const rows = definitions.filter(d => d.is_active).flatMap(d => d.nodes
    .filter(n => n.type === 'condition/ai_analysis' && n.config?.preset_key === 'confirm_appointment')
    .map(n => ({ definition: d, node: n })));
  assert.ok(rows.length > 0);
  for (const { definition, node } of rows) {
    const router = definition.nodes.find(n => n.id === node.outputs.on_success);
    assert.equal(router?.type, 'condition/field_check');
    for (const confidence of [0.95, 0.2]) {
      executionId++;
      const output = { confirma_asistencia: false, requiere_respuesta: false,
        confianza_confirma_asistencia: confidence, confianza_requiere_respuesta: confidence,
        motivo: 'El paciente indica que no podrá asistir y necesita cambiar la cita.', confianza_motivo: confidence };
      const context = { conversation: { id: 501 }, appointment: { id: 901, estado: 'recordatorio_enviado' },
        last_response_context: { response_message_id: 101 }, outputs: { [node.id]: output } };
      const decision = await flow._processNode(router, context, { simulation: true });
      context.outputs[router.id] = decision.output;
      const notification = definition.nodes.find(n => n.id === decision.next_node_id);
      assert.equal(notification?.type, 'action/send_system_notification');
      // Resolve the saved path to its end, but never invoke notification delivery.
      let next = notification; const visited = new Set();
      while (next) {
        assert(!visited.has(next.id), 'review path must terminate'); visited.add(next.id);
        assert(['action/send_system_notification', 'control/end'].includes(next.type), 'review path must not execute a clinical action');
        const result = await flow._processNode(next, context, { simulation: true });
        context.outputs[next.id] = result.output;
        const target = result.next_node_id;
        next = target ? definition.nodes.find(n => n.id === target) : null;
        if (target) assert.ok(next, 'review path target must exist');
      }
      const execution = { id: executionId, clinic_id: 31, status: 'completed', trigger_entity_type: 'appointment', trigger_entity_id: 901, context };
      await stateService.setState({ clinicId: 31, conversationId: 501, stage: 'analyzing', executionId,
        appointmentId: 901, sourceMessageId: 101, needsResponse: false, manualActionRequired: false }, { emit: false });
      events.length = 0;
      await flow._syncConversationAutomationStateAfterExecution(execution);
      const row = await models.ConversationAutomationState.findOne({ where: { conversation_id: 501 } });
      assert.equal(row.status, 'review'); assert.equal(row.stage, 'review');
      assert.equal(row.manual_action_required, true);
      assert.equal(row.needs_response, false, 'preserve the semantic defect rather than relabel it as a pass');
      assert.equal(events.length, 1); assert.equal(events[0].room, 'clinic:31');
      assert.equal(events[0].event, 'conversation:updated');
      assert.equal(events[0].payload.automation_manual_action_required, true);
      assert.equal(events[0].payload.automation_processing_status, 'review');
      lastRealtimePayload = events[0].payload;
      const dto = (await pending.getPendingReplyStatesByConversationIds([501])).get(501);
      assert.equal(dto.automationManualActionRequired, true); assert.equal(dto.automationProcessingStatus, 'review');
      assert.equal(dto.automationNeedsResponse, false); assert.equal(dto.automationResponseProcessingMessageId, 101);
      assert.equal(dto.automationActionAppointmentStatus, 'recordatorio_enviado');
      cases.push({ templateId: definition.id, nodeId: node.id, confidence, branch: decision.output.next_output_key,
        notificationId: notification.id, terminalPath: [...visited], persistedReview: true, realtimeReview: true, reloadReview: true });
    }
  }
  assert.deepEqual((await models.CitaPaciente.findByPk(901)).get({ plain: true }), appointmentBefore);
  assert.deepEqual((await models.Message.findByPk(101)).get({ plain: true }), messageBefore);
  assert.equal(await models.Message.count(), 1);
  report.checks.push('false/false provider result and low confidence traverse saved notification paths without clinical actions',
    'real MySQL state remains review with manual_action_required even when needs_response is false',
    'both realtime payload and reload DTO carry review status and source message',
    'appointment and fictitious message remain byte-for-byte unchanged; no outbound rows or notifications sent');

  // A stale execution or another clinic must not overwrite the current owner.
  const protectedState = (await models.ConversationAutomationState.findOne({ where: { conversation_id: 501 } })).get({ plain: true });
  events.length = 0;
  await flow._syncConversationAutomationStateAfterExecution({ id: executionId - 1, clinic_id: 31, status: 'completed', context: { conversation: { id: 501 } } });
  await flow._syncConversationAutomationStateAfterExecution({ id: executionId, clinic_id: 32, status: 'completed', context: { conversation: { id: 501 } } });
  assert.deepEqual((await models.ConversationAutomationState.findOne({ where: { conversation_id: 501 } })).get({ plain: true }), protectedState);
  assert.equal(events.length, 0);
  report.checks.push('stale execution and foreign clinic cannot overwrite the persisted owner or emit a review event');
  report.coverage = { activeConfirmNodes: rows.length, cases: cases.length, providerCalled: false, clinicalActionsExecuted: false,
    notificationsDelivered: false, uiRendered: false, semanticDiscrepancyResolved: false,
    ...(definitionsFile ? { definitionsSha256: createHash('sha256').update(fs.readFileSync(definitionsFile)).digest('hex') } : {}) };
  fs.writeFileSync(report.root + '/manual-review-cases.json', JSON.stringify(cases, null, 2), { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(report.root + '/manual-review-ui-payload.json', JSON.stringify(lastRealtimePayload, null, 2), { mode: 0o600, flag: 'wx' });
}).catch(() => { process.exitCode = 1; });
