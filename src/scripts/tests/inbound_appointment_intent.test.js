'use strict';

const assert = require('node:assert/strict');

process.env.JOBS_AUTO_START = 'false';
process.env.RUNTIME_ROLE = 'gateway';

const db = require('../../../models');
const flowEngine = require('../../services/flowEngineV2.service');
const inbound = require('../../services/automationInboundMessage.service');
const jobExecutor = require('../../services/jobExecutor.service');
const resumeService = require('../../services/automationsV2Resume.service');
const conversationAutomationState = require('../../services/conversationAutomationState.service');
const automationDefaults = require('../../services/automationDefaults.service');
const automationsController = require('../../controllers/automationsV2.controller');
const {
  LEGACY_EXECUTION_ALLOWLIST_KEY,
  buildMessageReceivedTemplateNodes,
  transformLegacyIntentNodes,
} = require('../../lib/automation-intent-migration');

function contextWithConversation(patientText, clinicText = '¿Nos confirmas tu cita?') {
  return {
    conversation_today: [
      `[01/09/2026, 11:37] Clínica: ${clinicText}`,
      `[01/09/2026, 12:24] Paciente: ${patientText}`,
    ].join('\n'),
    trigger: {
      data: {
        appointment_id: 91,
        appointment_candidate_count: 1,
      },
    },
    appointment: { id: 91, estado: 'pendiente' },
  };
}

function testConfirmationKeepsSecondaryQuestion() {
  const output = flowEngine.buildDeterministicClassifyIntentOutput(
    contextWithConversation('Confirmado. ¿Podéis darme la dirección?')
  );
  assert.equal(output.intencion_principal, 'confirmar_cita');
  assert.equal(output.intencion_secundaria, 'pregunta');
  assert.equal(output.accion_inequivoca, true);
  assert.equal(output.necesita_respuesta, true);
}

function testThanksOnlyConfirmsInConfirmationContext() {
  const confirmation = flowEngine.buildDeterministicClassifyIntentOutput(
    contextWithConversation('Gracias')
  );
  assert.equal(confirmation.intencion_principal, 'confirmar_cita');
  assert.equal(confirmation.accion_inequivoca, true);

  const afterDirections = flowEngine.buildDeterministicClassifyIntentOutput(
    contextWithConversation('Gracias', 'Estamos en la calle Mayor 10.')
  );
  assert.equal(afterDirections.intencion_principal, 'agradecimiento');
  assert.equal(afterDirections.accion_inequivoca, false);
}

async function testCanonicalIntentRunsThroughTheRealAiNode() {
  const aiNode = buildMessageReceivedTemplateNodes()
    .find((node) => node.type === 'condition/ai_analysis');
  assert.ok(aiNode, 'the canonical graph must contain an AI analysis node');

  const deterministic = await flowEngine._processNode(
    aiNode,
    contextWithConversation('Buenos dias, si confirmo la asistencia'),
    { simulation: true }
  );
  assert.equal(deterministic.kind, 'success');
  assert.equal(deterministic.output.intencion_principal, 'confirmar_cita');
  assert.equal(deterministic.output.accion_inequivoca, true);
  assert.equal(deterministic.next_node_id, aiNode.outputs.on_success);

  const contextual = await flowEngine._processNode(
    aiNode,
    contextWithConversation('Hola, gracias por el recordatorio. Mañana estaré allí.'),
    { simulation: true }
  );
  assert.equal(contextual.kind, 'success');
  assert.equal(contextual.output.intencion_principal, 'confirmar_cita');
  assert.equal(contextual.output.accion_inequivoca, true);
  assert.equal(contextual.next_node_id, aiNode.outputs.on_success);
}

function testAiRoutingSupportsCanonicalAndLegacyContracts() {
  const node = { outputs: { on_success: 'N-success', on_fail: 'N-fail' } };
  assert.equal(
    flowEngine._resolveAiAnalysisNextNode(node, 'classify_intent', {
      intencion_principal: 'confirmar_cita',
    }),
    'N-success'
  );
  assert.equal(
    flowEngine._resolveAiAnalysisNextNode(node, 'confirm_appointment', { decision: 'confirmado' }),
    'N-success'
  );
  assert.equal(
    flowEngine._resolveAiAnalysisNextNode(node, 'confirm_appointment', { decision: null }),
    'N-fail'
  );
}

function testRescheduleBecomesOperatorPendingAction() {
  const output = flowEngine.buildDeterministicClassifyIntentOutput(
    contextWithConversation('Me va mal ese día, quiero cambiar la cita')
  );
  assert.equal(output.intencion_principal, 'solicitar_cambio_cita');
  assert.equal(output.accion_inequivoca, true);
  assert.equal(output.necesita_respuesta, true);
}

function testRescheduleWinsOverGenericCannotAttend() {
  const output = flowEngine.buildDeterministicClassifyIntentOutput(
    contextWithConversation('No puedo asistir, ¿podemos cambiar la cita?')
  );
  assert.equal(output.intencion_principal, 'solicitar_cambio_cita');
  assert.equal(output.accion_inequivoca, true);
}

function testContradictorySignalsNeverApplyTheWrongAction() {
  const confirmed = flowEngine.buildDeterministicClassifyIntentOutput(
    contextWithConversation('No quiero cancelar la cita. Confirmo que voy.')
  );
  assert.equal(confirmed.intencion_principal, 'confirmar_cita');
  assert.equal(confirmed.accion_inequivoca, true);

  const noCancellation = flowEngine.buildDeterministicClassifyIntentOutput(
    contextWithConversation('No voy a cancelar la cita.')
  );
  assert.equal(noCancellation, null);

  const noConfirmation = flowEngine.buildDeterministicClassifyIntentOutput(
    contextWithConversation('Todavía no puedo confirmar.')
  );
  assert.equal(noConfirmation, null);
}

function testCancellationQuestionIsReviewOnly() {
  const output = flowEngine.buildDeterministicClassifyIntentOutput(
    contextWithConversation('¿Se ha cancelado mi cita?')
  );
  assert.equal(output.intencion_principal, 'pregunta');
  assert.equal(output.accion_inequivoca, false);
  assert.equal(output.necesita_respuesta, true);
}

function testClearCancellationIsNotMistakenForAQuestion() {
  const output = flowEngine.buildDeterministicClassifyIntentOutput(
    contextWithConversation('No puedo asistir.')
  );
  assert.equal(output.intencion_principal, 'cancelar_cita');
  assert.equal(output.intencion_secundaria, '');
  assert.equal(output.accion_inequivoca, true);
}

function testCompoundRescheduleQuestionKeepsBothSignals() {
  const output = flowEngine.buildDeterministicClassifyIntentOutput(
    contextWithConversation('No puedo asistir, ¿podemos cambiarla al martes?')
  );
  assert.equal(output.intencion_principal, 'solicitar_cambio_cita');
  assert.equal(output.intencion_secundaria, 'pregunta');
  assert.equal(output.accion_inequivoca, true);
  assert.equal(output.necesita_respuesta, true);
}

function testUrgencyPreventsAutomaticAppointmentMutation() {
  const output = flowEngine.buildDeterministicClassifyIntentOutput(
    contextWithConversation('Tengo un sangrado intenso y además quiero cancelar la cita.')
  );
  assert.equal(output.intencion_principal, 'urgencia_posible');
  assert.equal(output.posible_urgencia, true);
  assert.equal(output.accion_inequivoca, false);
}

function testLowConfidenceCanNeverMutateAppointment() {
  const output = flowEngine.normalizeClassifyIntentOutput({
    intencion_principal: 'cancelar_cita',
    confianza: 0.6,
    accion_inequivoca: true,
    necesita_respuesta: false,
    posible_urgencia: false,
    motivo: 'Señal incierta',
  }, contextWithConversation('No sé si podré ir'));
  assert.equal(output.accion_inequivoca, false);
}

function testAiSafetySignalsOverrideRequestedMutation() {
  const urgency = flowEngine.normalizeClassifyIntentOutput({
    intencion_principal: 'cancelar_cita',
    intencion_secundaria: '',
    confianza: 0.99,
    accion_inequivoca: true,
    posible_urgencia: true,
    necesita_respuesta: false,
    motivo: 'La respuesta mezcla una cancelación con una posible urgencia.',
  }, contextWithConversation('Quiero cancelar, tengo un sangrado intenso'));
  assert.equal(urgency.accion_inequivoca, false);
  assert.equal(urgency.necesita_respuesta, true);

  const contradiction = flowEngine.normalizeClassifyIntentOutput({
    intencion_principal: 'confirmar_cita',
    intencion_secundaria: 'cancelar_cita',
    confianza: 0.99,
    accion_inequivoca: true,
    posible_urgencia: false,
    necesita_respuesta: false,
    motivo: 'Se detectaron dos acciones.',
  }, contextWithConversation('Confirmo, aunque cancélala'));
  assert.equal(contradiction.accion_inequivoca, false);
  assert.equal(contradiction.necesita_respuesta, true);
  assert.match(contradiction.motivo, /acciones incompatibles/i);
}

function testPositiveReactionConfirmsOnlyInConfirmationContext() {
  const context = contextWithConversation('');
  context.last_response_context = { reaction_emoji: '👍' };
  const output = flowEngine.buildDeterministicClassifyIntentOutput(context);
  assert.equal(output.intencion_principal, 'confirmar_cita');
  assert.equal(output.accion_inequivoca, true);

  const unrelated = contextWithConversation('', 'Estamos en la calle Mayor 10.');
  unrelated.last_response_context = { reaction_emoji: '👍' };
  assert.equal(flowEngine.buildDeterministicClassifyIntentOutput(unrelated), null);
}

function testAmbiguousAppointmentNeverMutates() {
  const context = contextWithConversation('Confirmado');
  context.trigger.data.appointment_id = null;
  context.trigger.data.appointment_candidate_count = 2;
  context.appointment = null;
  const output = flowEngine.buildDeterministicClassifyIntentOutput(context);
  assert.equal(output.intencion_principal, 'confirmar_cita');
  assert.equal(output.accion_inequivoca, false);
  assert.equal(output.necesita_respuesta, true);
  assert.match(output.motivo, /varias citas próximas/i);
}

function testBufferIsSlidingButCapped() {
  const first = new Date('2026-09-01T10:00:00.000Z');
  const second = new Date('2026-09-01T10:01:00.000Z');
  assert.equal(
    inbound.computeBatchDeadline({ firstMessageAt: first, latestMessageAt: second }).toISOString(),
    '2026-09-01T10:02:30.000Z',
  );
  const late = new Date('2026-09-01T10:04:30.000Z');
  assert.equal(
    inbound.computeBatchDeadline({ firstMessageAt: first, latestMessageAt: late }).toISOString(),
    '2026-09-01T10:05:00.000Z',
  );
}

function testTriggerChannelAndClosedClinicContract() {
  const config = inbound.normalizeMessageReceivedTriggerConfig({
    channel_scope: 'selected',
    channels: ['whatsapp'],
    timing: 'clinic_closed',
  });
  assert.equal(inbound.triggerConfigMatches({
    config,
    channel: 'whatsapp',
    clinicOpenState: { has_schedule: true, open_now: false },
  }), true);
  assert.equal(inbound.triggerConfigMatches({
    config,
    channel: 'instagram',
    clinicOpenState: { has_schedule: true, open_now: false },
  }), false);
  assert.equal(inbound.triggerConfigMatches({
    config,
    channel: 'whatsapp',
    clinicOpenState: { has_schedule: true, open_now: true },
  }), false);
  assert.equal(inbound.triggerConfigMatches({
    config: { channel_scope: 'all_connected', timing: 'always' },
    channel: 'instagram',
    clinicOpenState: { has_schedule: true, open_now: false },
  }), false, 'Instagram remains disabled until its sender/runtime exists');
  assert.equal(inbound.triggerConfigMatches({
    config,
    channel: 'whatsapp',
    clinicOpenState: { has_schedule: false, open_now: false },
  }), false, 'closed-hours automation fails closed without a configured schedule');
}

function testOverlappingMessageTriggersAreDetected() {
  const overlap = automationsController.__messageReceivedConfigsOverlap;
  assert.equal(overlap(
    { channel_scope: 'all_connected', timing: 'always' },
    { channel_scope: 'selected', channels: ['whatsapp'], timing: 'clinic_closed' },
  ), true);
  assert.equal(overlap(
    { channel_scope: 'selected', channels: ['whatsapp'], timing: 'clinic_closed' },
    { channel_scope: 'selected', channels: ['whatsapp'], timing: 'clinic_closed' },
  ), true);
}

async function testBufferedOwnershipIsRecheckedBeforeGenericExecution() {
  const originalFindAll = db.Message.findAll;
  const originalResume = resumeService.enqueueInboundResponseResume;
  const messages = [
    { id: 701, content: 'Confirmado', message_type: 'text' },
    { id: 702, content: '¿Me dais la dirección?', message_type: 'text' },
  ];
  const claims = messages.map((message) => ({
    id: message.id + 1000,
    message_id: message.id,
    metadata: {},
    async update(patch) { Object.assign(this, patch); return this; },
  }));
  const resumed = [];
  db.Message.findAll = async () => messages;
  resumeService.enqueueInboundResponseResume = async (params) => {
    resumed.push(params.inboundMessageId);
    return { matched: 1, execution_ids: [88], errors: [] };
  };
  try {
    const result = await inbound.reassignBufferedClaimsToWaitingExecution({
      claims,
      conversation: { id: 41, patient_id: 9, lead_id: null },
      clinicId: 3,
      channel: 'whatsapp',
    });
    assert.deepEqual(resumed, [701, 702]);
    assert.equal(result.reassigned.length, 2);
    assert.equal(result.remaining.length, 0);
    assert.equal(claims.every((claim) => claim.status === 'completed'), true);
    assert.equal(claims.every((claim) => claim.owner_type === 'wait_response'), true);
  } finally {
    db.Message.findAll = originalFindAll;
    resumeService.enqueueInboundResponseResume = originalResume;
  }
}

async function testConversationStateOwnershipUsesAtomicCompareAndSet() {
  const originalUpdate = db.ConversationAutomationState.update;
  const originalFindOne = db.ConversationAutomationState.findOne;
  let where = null;
  db.ConversationAutomationState.update = async (_patch, options) => {
    where = options.where;
    return [1];
  };
  db.ConversationAutomationState.findOne = async () => ({
    conversation_id: 41,
    clinic_id: 3,
    execution_id: 88,
    stage: 'applying',
    status: 'active',
  });
  try {
    const state = await conversationAutomationState.updateOwnedState({
      clinicId: 3,
      conversationId: 41,
      stage: 'applying',
      executionId: 88,
    }, { expectedExecutionId: 88, emit: false });
    assert.ok(state);
    assert.deepEqual(where, { conversation_id: 41, clinic_id: 3, execution_id: 88 });

    db.ConversationAutomationState.update = async () => [0];
    const stale = await conversationAutomationState.updateOwnedState({
      clinicId: 3,
      conversationId: 41,
      stage: 'completed',
    }, { expectedExecutionId: 77, emit: false });
    assert.equal(stale, null);
  } finally {
    db.ConversationAutomationState.update = originalUpdate;
    db.ConversationAutomationState.findOne = originalFindOne;
  }
}

async function testInboundDispatchLeasePreventsConcurrentProcessing() {
  const originalFindByPk = db.AutomationInboundMessageClaim.findByPk;
  const originalTransaction = db.sequelize.transaction;
  const claim = {
    id: 1701,
    status: 'queued',
    owner_type: 'dispatching',
    processed_at: null,
    metadata: {},
    async update(patch) {
      Object.assign(this, patch);
      return this;
    },
  };
  db.AutomationInboundMessageClaim.findByPk = async () => claim;
  db.sequelize.transaction = async (callback) => callback({ LOCK: { UPDATE: 'UPDATE' } });

  try {
    const acquired = await inbound.beginInboundDispatchAttempt(1701, { id: 501, attempts: 1 });
    assert.equal(acquired.acquired, true);
    assert.equal(claim.status, 'processing');
    assert.ok(new Date(claim.metadata.processing_lease_until).getTime() > Date.now());

    const concurrent = await inbound.beginInboundDispatchAttempt(1701, { id: 502, attempts: 1 });
    assert.equal(concurrent.acquired, false);
    assert.equal(concurrent.reason, 'processing');
    assert.equal(concurrent.retryAt.toISOString(), claim.metadata.processing_lease_until);
  } finally {
    db.AutomationInboundMessageClaim.findByPk = originalFindByPk;
    db.sequelize.transaction = originalTransaction;
  }
}

async function testHumanAppointmentChangeWinsWhileAiIsAnalyzing() {
  const originalFindByPk = db.CitaPaciente.findByPk;
  const originalTransaction = db.sequelize.transaction;
  const originalUpdateOwnedState = conversationAutomationState.updateOwnedState;
  let appointmentUpdateCount = 0;
  let automationStatePatch = null;
  const appointment = {
    id_cita: 91,
    clinica_id: 3,
    paciente_id: 9,
    lead_intake_id: 17,
    estado: 'reprogramada',
    async update() {
      appointmentUpdateCount += 1;
      return this;
    },
  };

  db.CitaPaciente.findByPk = async () => appointment;
  db.sequelize.transaction = async (callback) => callback({ LOCK: { UPDATE: 'UPDATE' } });
  conversationAutomationState.updateOwnedState = async (patch) => {
    automationStatePatch = patch;
    return patch;
  };

  try {
    const context = {
      appointment: {
        id: 91,
        clinic_id: 3,
        paciente_id: 9,
        lead_intake_id: 17,
        estado: 'pendiente',
      },
      conversation: { id: 41 },
      last_response_context: { response_message_id: 701 },
    };
    const result = await flowEngine._handleChangeStatus({
      id: 'N-change',
      config: { target_entity: 'appointment', new_status: 'cancelada' },
      outputs: { on_success: 'N-auto-reply', on_fail: 'N-human-review' },
    }, context, {
      execution: {
        id: 88,
        clinic_id: 3,
        trigger_entity_type: 'conversation',
        trigger_entity_id: 41,
      },
    });

    assert.equal(appointmentUpdateCount, 0, 'the AI must not overwrite a newer human appointment change');
    assert.equal(result.output.skipped, true);
    assert.equal(result.output.reason, 'appointment_changed_during_analysis');
    assert.equal(result.output.new_status, 'reprogramada');
    assert.equal(result.next_node_id, 'N-human-review');
    assert.equal(automationStatePatch.manualActionRequired, true);
    assert.equal(automationStatePatch.appointmentStatus, 'reprogramada');
  } finally {
    db.CitaPaciente.findByPk = originalFindByPk;
    db.sequelize.transaction = originalTransaction;
    conversationAutomationState.updateOwnedState = originalUpdateOwnedState;
  }
}

function testInboundResponseScopeIsStrict() {
  const execution = {
    trigger_entity_type: 'conversation',
    trigger_entity_id: 41,
    context: { conversation: { id: 41 }, trigger: { data: { conversation_id: 41 } } },
  };
  assert.equal(
    jobExecutor._resolveInboundResponseConversationId(
      execution,
      { inbound_conversation_id: 41 },
      { inbound_conversation_id: 41 },
    ),
    41,
  );
  assert.throws(
    () => jobExecutor._resolveInboundResponseConversationId(
      execution,
      { inbound_conversation_id: 99 },
      { inbound_conversation_id: 41 },
    ),
    /inbound_response_conversation_scope_mismatch/,
  );
  assert.deepEqual(
    jobExecutor._inboundResponseMessageIds(
      { inbound_message_ids: [7, '8'], inbound_message_id: 8 },
      { pending_response_message_ids: [7, 9], last_inbound_message_id: 9 },
    ),
    [7, 8, 9],
  );
}

async function testBufferedTextSurvivesATrailingReaction() {
  const originalFindAll = db.Message.findAll;
  db.Message.findAll = async () => [
    {
      id: 7,
      content: 'Confirmado',
      message_type: 'text',
      metadata: {},
      sent_at: new Date('2026-09-01T10:00:00.000Z'),
    },
    {
      id: 8,
      content: 'Reacción de WhatsApp',
      message_type: 'reaction',
      metadata: { reaction: { emoji: '👍' } },
      sent_at: new Date('2026-09-01T10:00:05.000Z'),
    },
  ];
  try {
    const loaded = await jobExecutor._loadInboundResponseFromMessageIds(
      { inbound_message_ids: [7, 8] },
      {},
      41,
    );
    assert.equal(loaded.responseText, 'Confirmado');
    assert.equal(loaded.inboundMessageId, 8);
    assert.deepEqual(loaded.loadedMessageIds, [7, 8]);
  } finally {
    db.Message.findAll = originalFindAll;
  }
}

function testLegacyPresetRequiresExactCutoverMarker() {
  const execution = { template_version_id: 88 };
  assert.equal(flowEngine.isLegacyIntentExecutionAllowed(execution, {}), false);
  assert.equal(flowEngine.isLegacyIntentExecutionAllowed(execution, {
    __legacy_automation_compatibility: {
      [LEGACY_EXECUTION_ALLOWLIST_KEY]: { allowed: true, template_version_id: 87 },
    },
  }), false);
  assert.equal(flowEngine.isLegacyIntentExecutionAllowed(execution, {
    __legacy_automation_compatibility: {
      [LEGACY_EXECUTION_ALLOWLIST_KEY]: { allowed: true, template_version_id: 88 },
    },
  }), true);
}

function assertGraphIsClosed(nodes) {
  const ids = new Set(nodes.map((node) => node.id));
  assert.equal(ids.size, nodes.length, 'node ids must be unique');
  for (const node of nodes) {
    for (const target of Object.values(node.outputs || {})) {
      if (target) assert.equal(ids.has(target), true, `${node.id} points to missing ${target}`);
    }
  }
}

function assertGraphHasNoCycleAndFitsRuntime(nodes, entryNodeId, maxSteps = 100) {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const visiting = new Set();
  const memo = new Map();
  const longestPath = (nodeId) => {
    if (!nodeId) return 0;
    if (memo.has(nodeId)) return memo.get(nodeId);
    assert.equal(visiting.has(nodeId), false, `cycle detected at ${nodeId}`);
    visiting.add(nodeId);
    const node = nodeMap.get(nodeId);
    assert.ok(node, `missing node ${nodeId}`);
    const length = 1 + Math.max(0, ...Object.values(node.outputs || {}).map(longestPath));
    visiting.delete(nodeId);
    memo.set(nodeId, length);
    return length;
  };
  assert.ok(longestPath(entryNodeId) <= maxSteps, 'graph exceeds runtime step budget');
}

function testLegacyGraphMigrationPublishesCanonicalRoutes() {
  const legacy = [
    { id: 'N1', type: 'trigger/appointment_created', config: {}, outputs: { on_success: 'N2' } },
    {
      id: 'N2',
      type: 'action/send_whatsapp',
      config: { message_mode: 'manual', manual_message_text: '¿Confirmas?' },
      outputs: { on_success: 'N3' },
    },
    {
      id: 'N3',
      type: 'delay/wait_response',
      config: { response_buffer_enabled: true },
      outputs: { on_response: 'N4', on_timeout: null },
    },
    {
      id: 'N4',
      type: 'condition/ai_analysis',
      config: { preset_key: 'confirm_appointment', mode: 'auto', max_tokens: 180 },
      outputs: { on_success: 'N5', on_fail: 'N7' },
    },
    {
      id: 'N5',
      type: 'action/send_whatsapp',
      config: { message_mode: 'manual', manual_message_text: 'Gracias' },
      outputs: { on_success: 'N6' },
    },
    {
      id: 'N6',
      type: 'action/change_status',
      config: { target_entity: 'appointment', new_status: 'recordatorio_confirmado' },
      outputs: { on_success: null },
    },
    {
      id: 'N7',
      type: 'action/send_system_notification',
      config: { title: 'Revisar', message: 'Revisar' },
      outputs: { on_success: null },
    },
  ];
  const transformed = transformLegacyIntentNodes(legacy);
  assert.equal(transformed.changed, true);
  assert.equal(transformed.replaced, 1);
  assertGraphIsClosed(transformed.nodes);
  assert.equal(
    transformed.nodes.some((node) => ['confirm_appointment', 'appointment_unconfirmed_reply'].includes(node.config?.preset_key)),
    false,
  );
  assert.equal(transformed.nodes.find((node) => node.id === 'N4').config.preset_key, 'classify_intent');
  assert.equal(transformed.nodes.find((node) => node.id === 'N5').config.suppress_if_human_replied, true);
  assert.equal(transformed.nodes.find((node) => node.id === 'N3').config.response_buffer_delay_seconds, 90);
  assert.equal(
    transformed.nodes.some((node) => node.type === 'action/change_status' && node.config?.new_status === 'cancelada'),
    true,
  );
  assert.equal(
    transformed.nodes.some((node) => node.type === 'action/change_status' && node.config?.new_status === 'cambio_solicitado'),
    true,
  );
  const secondPass = transformLegacyIntentNodes(transformed.nodes);
  assert.equal(secondPass.changed, false, 'migration must be idempotent');
  assert.deepEqual(secondPass.nodes, transformed.nodes);
}

function testNightlyLegacyDecisionChecksAreRemoved() {
  const legacy = [
    { id: 'N1', type: 'trigger/appointment_reminder_window', config: {}, outputs: { on_success: 'N2' } },
    { id: 'N2', type: 'delay/wait_response', config: {}, outputs: { on_response: 'N3', on_timeout: 'N9' } },
    { id: 'N3', type: 'condition/ai_analysis', config: { preset_key: 'appointment_unconfirmed_reply' }, outputs: { on_success: 'N4', on_fail: 'N10' } },
    { id: 'N4', type: 'condition/field_check', config: { left_ref: { source: 'node_output', node_id: 'N3', path: 'decision' }, right_value: 'confirmar' }, outputs: { on_true: 'N5', on_false: 'N6' } },
    { id: 'N5', type: 'action/change_status', config: { new_status: 'recordatorio_confirmado' }, outputs: { on_success: null } },
    { id: 'N6', type: 'condition/field_check', config: { left_ref: { source: 'node_output', node_id: 'N3', path: 'decision' }, right_value: 'reprogramar' }, outputs: { on_true: 'N7', on_false: 'N8' } },
    { id: 'N7', type: 'action/change_status', config: { new_status: 'cancelada' }, outputs: { on_success: null } },
    { id: 'N8', type: 'condition/field_check', config: { left_ref: { source: 'node_output', node_id: 'N3', path: 'decision' }, right_value: 'cancelar' }, outputs: { on_true: 'N9', on_false: 'N10' } },
    { id: 'N9', type: 'action/change_status', config: { new_status: 'cancelada' }, outputs: { on_success: null } },
    { id: 'N10', type: 'action/send_system_notification', config: { title: 'Revisar', message: 'Revisar' }, outputs: { on_success: null } },
  ];
  const transformed = transformLegacyIntentNodes(legacy);
  assertGraphIsClosed(transformed.nodes);
  assert.equal(
    transformed.nodes.some((node) => node.type === 'condition/field_check' && node.config?.left_ref?.path === 'decision'),
    false,
  );
  assert.equal(transformed.nodes.some((node) => node.id === 'N5'), true, 'confirmation target remains reachable');
  assert.equal(transformed.nodes.some((node) => node.id === 'N7'), false, 'old reschedule-as-cancel branch is removed');
}

function testDefaultAfterHoursGraphIsClosedAndSafeByDefault() {
  const nodes = buildMessageReceivedTemplateNodes();
  assertGraphIsClosed(nodes);
  const trigger = nodes.find((node) => node.id === 'N1');
  assert.equal(trigger.type, 'trigger/message_received');
  assert.equal(trigger.config.timing, 'clinic_closed');
  assert.equal(trigger.config.runtime_fallback_enabled, false);
  const aiNode = nodes.find((node) => node.id === 'N2');
  assert.equal(aiNode.config.preset_key, 'classify_intent');
  assert.equal(
    aiNode.config.context_sources.some((source) => source.key === 'patient_message_batch'),
    true,
  );
  assert.equal(nodes.some((node) => node.config?.preset_key === 'confirm_appointment'), false);
  assertGraphHasNoCycleAndFitsRuntime(nodes, 'N1');
}

function simulateAfterHoursGraph(aiOutput) {
  const nodes = buildMessageReceivedTemplateNodes();
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const actions = [];
  let nodeId = 'N1';
  for (let step = 0; nodeId && step < 50; step += 1) {
    const node = nodeMap.get(nodeId);
    assert.ok(node, `simulation references missing node ${nodeId}`);
    if (node.type === 'trigger/message_received') {
      nodeId = node.outputs?.on_success || null;
    } else if (node.type === 'condition/ai_analysis') {
      nodeId = node.outputs?.on_success || null;
    } else if (node.type === 'condition/field_check') {
      const actual = aiOutput?.[node.config?.left_ref?.path];
      nodeId = actual === node.config?.right_value
        ? node.outputs?.on_true || null
        : node.outputs?.on_false || null;
    } else {
      actions.push(node);
      nodeId = node.outputs?.on_success || null;
    }
  }
  return actions;
}

function testAfterHoursConversationMatrix() {
  const statusChanges = (actions) => actions
    .filter((node) => node.type === 'action/change_status')
    .map((node) => node.config.new_status);
  const replyTexts = (actions) => actions
    .filter((node) => node.type === 'action/reply_message')
    .map((node) => node.config.message_text);
  const notifications = (actions) => actions
    .filter((node) => node.type === 'action/send_system_notification');

  const confirmationWithQuestion = simulateAfterHoursGraph(flowEngine.buildDeterministicClassifyIntentOutput(
    contextWithConversation('Confirmado. ¿Podéis darme la dirección?')
  ));
  assert.deepEqual(statusChanges(confirmationWithQuestion), ['recordatorio_confirmado']);
  assert.match(replyTexts(confirmationWithQuestion)[0], /pregunta pendiente/i);
  assert.equal(notifications(confirmationWithQuestion).length, 1);

  const contextualThanks = simulateAfterHoursGraph(flowEngine.buildDeterministicClassifyIntentOutput(
    contextWithConversation('Gracias')
  ));
  assert.deepEqual(statusChanges(contextualThanks), ['recordatorio_confirmado']);
  assert.match(replyTexts(contextualThanks)[0], /confirmacion de tu cita/i);
  assert.equal(notifications(contextualThanks).length, 0);

  const cancellation = simulateAfterHoursGraph(flowEngine.buildDeterministicClassifyIntentOutput(
    contextWithConversation('No puedo asistir, cancelad la cita por favor.')
  ));
  assert.deepEqual(statusChanges(cancellation), ['cancelada']);
  assert.match(replyTexts(cancellation)[0], /cancelado tu cita/i);

  const reschedule = simulateAfterHoursGraph(flowEngine.buildDeterministicClassifyIntentOutput(
    contextWithConversation('Quiero cambiar la cita al martes.')
  ));
  assert.deepEqual(statusChanges(reschedule), ['cambio_solicitado']);
  assert.match(replyTexts(reschedule)[0], /no recibiras mas recordatorios/i);
  assert.equal(notifications(reschedule).length, 1);

  const urgency = simulateAfterHoursGraph(flowEngine.buildDeterministicClassifyIntentOutput(
    contextWithConversation('Tengo un sangrado intenso y quiero cancelar la cita.')
  ));
  assert.deepEqual(statusChanges(urgency), []);
  assert.match(replyTexts(urgency)[0], /servicios de emergencia/i);
  assert.equal(notifications(urgency).length, 1);

  const ambiguousContext = contextWithConversation('Confirmado');
  ambiguousContext.trigger.data.appointment_id = null;
  ambiguousContext.trigger.data.appointment_candidate_count = 2;
  ambiguousContext.appointment = null;
  const ambiguous = simulateAfterHoursGraph(
    flowEngine.buildDeterministicClassifyIntentOutput(ambiguousContext)
  );
  assert.deepEqual(statusChanges(ambiguous), []);
  assert.match(replyTexts(ambiguous)[0], /pendiente para recepcion/i);
  assert.equal(notifications(ambiguous).length, 1);

  const allReplies = [confirmationWithQuestion, contextualThanks, cancellation, reschedule, urgency, ambiguous]
    .flat()
    .filter((node) => node.type === 'action/reply_message');
  assert.equal(allReplies.every((node) => node.config.suppress_if_human_replied === true), true);
}

function testUnchangedCatalogPropagationDoesNotCreateAnotherVersion() {
  const desired = {
    engine_version: 'v2',
    name: 'Gestionar mensajes fuera de horario',
    description: 'Clasifica mensajes no reclamados.',
    trigger_type: 'message_received',
    is_system: false,
    clinic_id: 3,
    group_id: null,
    entry_node_id: 'N1',
    nodes: [{ id: 'N1', config: { timing: 'clinic_closed', channels: ['whatsapp'] } }],
    trigger_config: { timing: 'clinic_closed', channels: ['whatsapp'], only_unclaimed: true },
  };
  const published = {
    ...desired,
    is_active: 0,
    nodes: [{ config: { channels: ['whatsapp'], timing: 'clinic_closed' }, id: 'N1' }],
    trigger_config: { only_unclaimed: true, channels: ['whatsapp'], timing: 'clinic_closed' },
  };
  assert.equal(automationDefaults.catalogTemplateMatchesDesired(published, desired, false), true);
  assert.equal(automationDefaults.catalogTemplateMatchesDesired({
    ...published,
    trigger_config: { ...published.trigger_config, timing: 'always' },
  }, desired, false), false);
}

async function run() {
  testConfirmationKeepsSecondaryQuestion();
  testThanksOnlyConfirmsInConfirmationContext();
  await testCanonicalIntentRunsThroughTheRealAiNode();
  testAiRoutingSupportsCanonicalAndLegacyContracts();
  testRescheduleBecomesOperatorPendingAction();
  testRescheduleWinsOverGenericCannotAttend();
  testContradictorySignalsNeverApplyTheWrongAction();
  testCancellationQuestionIsReviewOnly();
  testClearCancellationIsNotMistakenForAQuestion();
  testCompoundRescheduleQuestionKeepsBothSignals();
  testUrgencyPreventsAutomaticAppointmentMutation();
  testLowConfidenceCanNeverMutateAppointment();
  testAiSafetySignalsOverrideRequestedMutation();
  testPositiveReactionConfirmsOnlyInConfirmationContext();
  testAmbiguousAppointmentNeverMutates();
  testBufferIsSlidingButCapped();
  testTriggerChannelAndClosedClinicContract();
  testOverlappingMessageTriggersAreDetected();
  await testBufferedOwnershipIsRecheckedBeforeGenericExecution();
  await testConversationStateOwnershipUsesAtomicCompareAndSet();
  await testInboundDispatchLeasePreventsConcurrentProcessing();
  await testHumanAppointmentChangeWinsWhileAiIsAnalyzing();
  testInboundResponseScopeIsStrict();
  await testBufferedTextSurvivesATrailingReaction();
  testLegacyPresetRequiresExactCutoverMarker();
  testLegacyGraphMigrationPublishesCanonicalRoutes();
  testNightlyLegacyDecisionChecksAreRemoved();
  testDefaultAfterHoursGraphIsClosedAndSafeByDefault();
  testAfterHoursConversationMatrix();
  testUnchangedCatalogPropagationDoesNotCreateAnotherVersion();
  console.log('inbound_appointment_intent.test.js OK');
}

run().then(async () => {
  await db.sequelize.close();
  process.exit(0);
}).catch(async (error) => {
  console.error(error);
  try { await db.sequelize.close(); } catch (_closeError) {}
  process.exit(1);
});
