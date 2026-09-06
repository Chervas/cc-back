'use strict';

const assert = require('node:assert/strict');

process.env.JOBS_AUTO_START = 'false';

const db = require('../../../models');
const controller = require('../../controllers/automationsV2.controller');
const flowEngine = require('../../services/flowEngineV2.service');
const automationInboundMessage = require('../../services/automationInboundMessage.service');
const { buildMessageReceivedTemplateNodes } = require('../../lib/automation-intent-migration');
const migration = require('../../../migrations/20260906130000-prepare-message-received-after-hours-v5');

function sourceFixture() {
  const sourceNodes = buildMessageReceivedTemplateNodes()
    .filter((node) => !['N25', 'N26'].includes(node.id));
  const changeIntentNode = sourceNodes.find((node) => node.id === 'N13');
  changeIntentNode.outputs.on_false = 'N19';
  return {
    public_id: migration._test.TARGET_PUBLIC_ID,
    version: migration._test.SOURCE_VERSION,
    trigger_type: 'message_received',
    trigger_config: {
      timing: 'clinic_closed',
      channels: [],
      channel_scope: 'all_connected',
      only_unclaimed: true,
      response_buffer_seconds: 90,
      runtime_fallback_enabled: false,
    },
    clinic_id: null,
    entry_node_id: 'N1',
    nodes: sourceNodes,
  };
}

function assertClosedGraph(nodes) {
  const ids = new Set(nodes.map((node) => node.id));
  for (const node of nodes) {
    for (const target of Object.values(node.outputs || {})) {
      if (target) assert.equal(ids.has(target), true, `${node.id} references missing node ${target}`);
    }
  }
}

async function nextNode(node, context) {
  const result = await flowEngine._processNode(node, context, { simulation: true });
  return result.next_node_id;
}

async function assertLongReplyWaitDoesNotLookLikeAiProcessing() {
  const originalStateFindOne = db.ConversationAutomationState.findOne;
  const originalAppointmentFindByPk = db.CitaPaciente.findByPk;
  const originalUpdateOwnedState = require('../../services/conversationAutomationState.service').updateOwnedState;
  const conversationAutomationState = require('../../services/conversationAutomationState.service');
  let patch = null;

  db.ConversationAutomationState.findOne = async () => ({
    execution_id: 9910,
    appointment_id: 70001,
    appointment_status: 'cancelada',
    intent: 'cancelar_cita',
    possible_urgency: false,
  });
  db.CitaPaciente.findByPk = async () => ({ id_cita: 70001, estado: 'cancelada' });
  conversationAutomationState.updateOwnedState = async (value) => {
    patch = value;
    return value;
  };

  try {
    await flowEngine._syncConversationAutomationStateAfterExecution({
      id: 9910,
      status: 'waiting',
      clinic_id: 66,
      trigger_entity_type: 'conversation',
      trigger_entity_id: 2142,
      wait_until: new Date(Date.now() + (12 * 60 * 60 * 1000)),
      waiting_meta: { type: 'delay/wait_response' },
      context: {
        conversation: { id: 2142 },
        appointment: { id: 70001, estado: 'cancelada' },
        outputs: {
          N2: {
            intencion_principal: 'cancelar_cita',
            confianza_intencion_principal: 0.95,
            posible_urgencia: false,
            confianza_posible_urgencia: 0.95,
            necesita_respuesta: false,
            confianza_necesita_respuesta: 0.95,
          },
        },
      },
    });
    assert.equal(patch.stage, 'completed');
    assert.equal(patch.status, 'completed');
    assert.equal(patch.deadlineAt, null);
    assert.equal(patch.appointmentStatus, 'cancelada');
    assert.equal(patch.intent, 'cancelar_cita');
  } finally {
    db.ConversationAutomationState.findOne = originalStateFindOne;
    db.CitaPaciente.findByPk = originalAppointmentFindByPk;
    conversationAutomationState.updateOwnedState = originalUpdateOwnedState;
  }
}

async function main() {
  assert.equal(automationInboundMessage.resolveMessageReceivedRuntimeNamespace({
    trigger_config: { runtime_namespace: 'dev' },
  }, {
    runtimeRole: 'gateway',
    currentRuntimeNamespace: 'gateway',
    fallbackRuntimeNamespace: 'staging',
  }), 'dev');
  assert.equal(automationInboundMessage.resolveMessageReceivedRuntimeNamespace({
    trigger_config: {},
  }, {
    runtimeRole: 'gateway',
    currentRuntimeNamespace: 'gateway',
    fallbackRuntimeNamespace: 'staging',
  }), 'staging');
  assert.equal(automationInboundMessage.resolveMessageReceivedRuntimeNamespace({
    trigger_config: {},
  }, {
    runtimeRole: 'api',
    currentRuntimeNamespace: 'dev',
    fallbackRuntimeNamespace: 'staging',
  }), 'dev');

  const source = sourceFixture();
  assert.equal(migration._test.validateSource(source), true);
  const nodes = migration._test.buildTargetNodes(source);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  assert.equal(nodes.length, 32);
  assertClosedGraph(nodes);

  const validation = await controller.validateFlowPayloadForInternalUse({
    entry_node_id: source.entry_node_id,
    trigger_type: source.trigger_type,
    trigger_config: source.trigger_config,
    nodes,
  });
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));

  const mainDecision = byId.get('N3');
  assert.match(byId.get('N2').config.instruction, /ya esta en la puerta y no puede entrar/);
  assert.equal(
    byId.get('N60').config.message_text,
    '¡Hola! La clínica no está abierta ahora mismo y no te puedo responder, pero te contestaremos cuanto antes.',
  );
  assert.equal(byId.get('N46').config.message_text, '¡Gracias! Te esperamos 😊');
  assert.equal(byId.get('N51').config.title, '{{paciente.nombre}} necesita respuesta urgente');
  assert.doesNotMatch(byId.get('N50').config.message_text, /servicios de emergencia/i);
  assert.equal(mainDecision.config.mode, 'multi_branch');
  assert.equal(mainDecision.config.branch_rules.length, 6);
  assert.equal(
    mainDecision.config.branch_rules.some((branch) => (
      branch.comparison_rules.some((rule) => rule.left_ref?.path === 'accion_inequivoca')
    )),
    false,
  );

  const appointment = { id: 70001, estado: 'recordatorio_enviado' };
  const context = (output, appointmentValue = appointment) => ({
    outputs: { N2: output },
    appointment: appointmentValue,
  });
  const confident = {
    confianza_intencion_principal: 0.96,
    confianza_necesita_respuesta: 0.94,
    confianza_posible_urgencia: 0.95,
    posible_urgencia: false,
    necesita_respuesta: false,
  };

  assert.equal(await nextNode(mainDecision, context({ ...confident, intencion_principal: 'cancelar_cita' })), 'N20');
  assert.equal(await nextNode(mainDecision, context({ ...confident, intencion_principal: 'solicitar_cambio_cita', necesita_respuesta: true })), 'N30');
  assert.equal(await nextNode(mainDecision, context({ ...confident, intencion_principal: 'confirmar_cita' })), 'N40');
  assert.equal(await nextNode(mainDecision, context({
    ...confident,
    intencion_principal: 'cancelar_cita',
    posible_urgencia: true,
    necesita_respuesta: true,
  })), 'N20', 'the appointment action is applied before a secondary urgency signal');
  assert.equal(await nextNode(mainDecision, context({
    ...confident,
    intencion_principal: 'urgencia_posible',
    posible_urgencia: true,
    necesita_respuesta: true,
  }, null)), 'N50');
  assert.equal(await nextNode(mainDecision, context({
    ...confident,
    intencion_principal: 'pregunta',
    necesita_respuesta: true,
  }, null)), 'N60');
  assert.equal(await nextNode(mainDecision, context({
    ...confident,
    intencion_principal: 'agradecimiento',
  }, null)), null);
  assert.equal(await nextNode(mainDecision, context({
    ...confident,
    intencion_principal: 'cancelar_cita',
    confianza_intencion_principal: 0.7,
  })), 'N70');
  assert.equal(await nextNode(mainDecision, context({
    ...confident,
    intencion_principal: 'cancelar_cita',
    necesita_respuesta: true,
  }, null)), 'N60', 'an appointment action without one appointment remains for reception');

  const statusDecision = byId.get('N40');
  assert.equal(await nextNode(statusDecision, context(confident, { id_cita: 1, estado: 'info_enviada' })), 'N41');
  assert.equal(await nextNode(statusDecision, context(confident, { id_cita: 1, estado: 'recordatorio_enviado' })), 'N42');
  assert.equal(await nextNode(statusDecision, context(confident, { id_cita: 1, estado: 'info_confirmada' })), 'N43');
  assert.equal(await nextNode(statusDecision, context(confident, { id_cita: 1, estado: 'recordatorio_confirmado' })), 'N43');
  assert.equal(await nextNode(statusDecision, context(confident, { id_cita: 1, estado: 'pendiente' })), 'N71');

  const confirmationDecision = byId.get('N43');
  assert.equal(await nextNode(confirmationDecision, context({
    ...confident,
    posible_urgencia: true,
    necesita_respuesta: true,
  })), 'N50');
  assert.equal(await nextNode(confirmationDecision, context({ ...confident, necesita_respuesta: true })), 'N44');
  assert.equal(await nextNode(confirmationDecision, context(confident)), 'N46');

  const followupDecision = byId.get('N25');
  assert.equal(await nextNode(followupDecision, {
    outputs: { N24: { quiere_nueva_cita: true, confianza_quiere_nueva_cita: 0.96 } },
  }), 'N26');
  assert.equal(await nextNode(followupDecision, {
    outputs: { N24: { quiere_nueva_cita: false, confianza_quiere_nueva_cita: 0.96 } },
  }), 'N27');
  assert.equal(await nextNode(followupDecision, {
    outputs: { N24: { quiere_nueva_cita: true, confianza_quiere_nueva_cita: 0.5 } },
  }), 'N28');

  const replies = nodes.filter((node) => node.type === 'action/reply_message');
  assert.equal(replies.every((node) => node.config.suppress_if_human_replied === true), true);
  assert.equal(replies.every((node) => node.config.language_routing?.enabled === true), true);
  assert.equal(replies.every((node) => Boolean(node.config.language_routing?.variants?.ca?.message_text)), true);
  assert.equal(replies.every((node) => Boolean(node.config.language_routing?.variants?.en?.message_text)), true);
  const multilingualReplyConfig = flowEngine._buildReplyWhatsappConfig(byId.get('N22').config, {
    contact_id: '+34600000000',
  });
  assert.equal(
    flowEngine.resolveWhatsappLanguageRouting(multilingualReplyConfig, { communication_language: 'ca' })
      .config.manual_message_text,
    byId.get('N22').config.language_routing.variants.ca.message_text,
  );
  assert.equal(
    flowEngine.resolveWhatsappLanguageRouting(multilingualReplyConfig, { communication_language: 'en' })
      .config.manual_message_text,
    byId.get('N22').config.language_routing.variants.en.message_text,
  );
  assert.equal(flowEngine._resolveLatestResponseMessageId({
    trigger: { data: { latest_inbound_message_id: 101 } },
    last_response_context: { response_message_id: 102 },
  }), 102);
  assert.equal(flowEngine._resolveLatestResponseMessageId({
    trigger: { data: { latest_inbound_message_id: 101 } },
    outputs: { N23: { status: 'responded', response_message_id: 103 } },
  }), 103);
  const notifications = nodes.filter((node) => node.type === 'action/send_system_notification');
  assert.equal(notifications.every((node) => !node.outputs?.on_fail), true);
  assert.equal(byId.get('N2').outputs.on_fail, 'N90');
  assert.equal(byId.get('N20').outputs.on_fail, 'N91');
  assert.equal(byId.get('N41').config.new_status, 'info_confirmada');
  assert.equal(byId.get('N42').config.new_status, 'recordatorio_confirmado');
  assert.equal(byId.get('N23').config.response_buffer_delay_seconds, 90);
  await assertLongReplyWaitDoesNotLookLikeAiProcessing();

  console.log('message_received_after_hours_v5.test.js OK');
}

main()
  .then(async () => {
    await db.sequelize.close();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error);
    await db.sequelize.close();
    process.exit(1);
  });
