#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');

process.env.JOBS_AUTO_START = 'false';

const db = require('../../../models');
const flowEngine = require('../../services/flowEngineV2.service');
const conversationAutomationState = require('../../services/conversationAutomationState.service');
const { validateFlowPayloadForInternalUse } = require('../../controllers/automationsV2.controller');
const migration = require('../../../migrations/20260906090000-prepare-cancel-unconfirmed-night-before-v7');

async function evaluate(node, sourceNodeId, output) {
  return flowEngine._processNode(
    node,
    { outputs: { [sourceNodeId]: output } },
    { simulation: true },
  );
}

async function verifyNewAppointmentConversationAction() {
  const originalStateFindOne = db.ConversationAutomationState.findOne;
  const originalAppointmentFindByPk = db.CitaPaciente.findByPk;
  const originalUpdateOwnedState = conversationAutomationState.updateOwnedState;
  let reviewPatch = null;

  db.ConversationAutomationState.findOne = async () => ({
    conversation_id: 2142,
    clinic_id: 66,
    execution_id: 9907,
    appointment_id: 75006,
    appointment_status: 'cancelada',
    source_message_id: 105371,
    manual_action_required: false,
    needs_response: false,
  });
  db.CitaPaciente.findByPk = async () => ({ id_cita: 75006, estado: 'cancelada' });
  conversationAutomationState.updateOwnedState = async (patch) => {
    reviewPatch = patch;
    return patch;
  };

  try {
    await flowEngine._syncConversationAutomationStateAfterExecution({
      id: 9907,
      status: 'completed',
      clinic_id: 66,
      trigger_entity_type: 'appointment',
      trigger_entity_id: 75006,
      context: {
        conversation: { id: 2142 },
        appointment: { id: 75006, estado: 'cancelada' },
        outputs: {
          N4: {
            intencion_principal: 'cancelar_cita',
            confianza_intencion_principal: 0.95,
            necesita_respuesta: false,
            confianza_necesita_respuesta: 0.95,
          },
          N21: { status: 'success', target_type: 'appointment', new_status: 'cancelada' },
          N27: { status: 'created', conversation_action: 'schedule_new_appointment' },
        },
      },
    });
    assert.equal(reviewPatch.stage, 'review');
    assert.equal(reviewPatch.status, 'review');
    assert.equal(reviewPatch.intent, 'solicitar_nueva_cita');
    assert.equal(reviewPatch.appointmentStatus, 'cancelada');
    assert.equal(reviewPatch.needsResponse, false);
    assert.equal(reviewPatch.manualActionRequired, true);
  } finally {
    db.ConversationAutomationState.findOne = originalStateFindOne;
    db.CitaPaciente.findByPk = originalAppointmentFindByPk;
    conversationAutomationState.updateOwnedState = originalUpdateOwnedState;
  }
}

async function verifyHumanTakeoverLeavesCancellationReview() {
  const originalStateFindOne = db.ConversationAutomationState.findOne;
  const originalAppointmentFindByPk = db.CitaPaciente.findByPk;
  const originalUpdateOwnedState = conversationAutomationState.updateOwnedState;
  let reviewPatch = null;

  db.ConversationAutomationState.findOne = async () => ({
    conversation_id: 2142,
    clinic_id: 66,
    execution_id: 9908,
    appointment_id: 75006,
    appointment_status: 'recordatorio_enviado',
    source_message_id: 105526,
    manual_action_required: false,
    needs_response: false,
  });
  db.CitaPaciente.findByPk = async () => ({ id_cita: 75006, estado: 'recordatorio_enviado' });
  conversationAutomationState.updateOwnedState = async (patch) => {
    reviewPatch = patch;
    return patch;
  };

  try {
    await flowEngine._syncConversationAutomationStateAfterExecution({
      id: 9908,
      status: 'cancelled',
      clinic_id: 66,
      trigger_entity_type: 'appointment',
      trigger_entity_id: 75006,
      context: {
        conversation: { id: 2142 },
        appointment: { id: 75006, estado: 'recordatorio_enviado' },
        human_takeover: { active: true, human_message_id: 105527 },
        outputs: {
          N4: {
            intencion_principal: 'cancelar_cita',
            confianza_intencion_principal: 0.95,
            necesita_respuesta: false,
            confianza_necesita_respuesta: 0.95,
          },
          N14: { matched_rule_id: 'branch_cancel', next_output_key: 'branch_cancel' },
        },
      },
    });
    assert.equal(reviewPatch.stage, 'review');
    assert.equal(reviewPatch.status, 'review');
    assert.equal(reviewPatch.intent, 'cancelar_cita');
    assert.equal(reviewPatch.appointmentStatus, 'recordatorio_enviado');
    assert.equal(reviewPatch.needsResponse, false);
    assert.equal(reviewPatch.manualActionRequired, true);
  } finally {
    db.ConversationAutomationState.findOne = originalStateFindOne;
    db.CitaPaciente.findByPk = originalAppointmentFindByPk;
    conversationAutomationState.updateOwnedState = originalUpdateOwnedState;
  }
}

async function verifyHumanTakeoverRebookingDecision() {
  const originalStateFindOne = db.ConversationAutomationState.findOne;
  const originalAppointmentFindByPk = db.CitaPaciente.findByPk;
  const originalUpdateOwnedState = conversationAutomationState.updateOwnedState;
  const originalCompleteState = conversationAutomationState.completeState;
  let reviewPatch = null;
  let completionPatch = null;
  let wantsNewAppointment = true;

  db.ConversationAutomationState.findOne = async () => ({
    conversation_id: 2142,
    clinic_id: 66,
    execution_id: 9909,
    appointment_id: 75006,
    appointment_status: 'cancelada',
    source_message_id: 105536,
    manual_action_required: false,
    needs_response: false,
  });
  db.CitaPaciente.findByPk = async () => ({ id_cita: 75006, estado: 'cancelada' });
  conversationAutomationState.updateOwnedState = async (patch) => {
    reviewPatch = patch;
    return patch;
  };
  conversationAutomationState.completeState = async (patch) => {
    completionPatch = patch;
    return patch;
  };

  const execution = () => ({
    id: 9909,
    status: 'cancelled',
    clinic_id: 66,
    trigger_entity_type: 'appointment',
    trigger_entity_id: 75006,
    context: {
      conversation: { id: 2142 },
      appointment: { id: 75006, estado: 'cancelada' },
      human_takeover: { active: true, human_message_id: 105537 },
      outputs: {
        ...(wantsNewAppointment ? {
          N4: {
            intencion_principal: 'cancelar_cita',
            confianza_intencion_principal: 0.95,
            necesita_respuesta: true,
            confianza_necesita_respuesta: 0.95,
          },
        } : {}),
        N25: { quiere_nueva_cita: wantsNewAppointment, motivo: 'Respuesta contextual.' },
        N26: {
          matched_rule_id: wantsNewAppointment ? 'branch_yes' : 'branch_no',
          next_output_key: wantsNewAppointment ? 'branch_yes' : 'branch_no',
        },
      },
    },
  });

  try {
    await flowEngine._syncConversationAutomationStateAfterExecution(execution());
    assert.equal(reviewPatch.stage, 'review');
    assert.equal(reviewPatch.intent, 'solicitar_nueva_cita');
    assert.equal(reviewPatch.appointmentStatus, 'cancelada');
    assert.equal(reviewPatch.manualActionRequired, true);
    assert.equal(completionPatch, null);

    reviewPatch = null;
    wantsNewAppointment = false;
    await flowEngine._syncConversationAutomationStateAfterExecution(execution());
    assert.equal(reviewPatch, null);
    assert.equal(completionPatch.intent, 'otra');
  } finally {
    db.ConversationAutomationState.findOne = originalStateFindOne;
    db.CitaPaciente.findByPk = originalAppointmentFindByPk;
    conversationAutomationState.updateOwnedState = originalUpdateOwnedState;
    conversationAutomationState.completeState = originalCompleteState;
  }
}

async function run() {
  await verifyNewAppointmentConversationAction();
  await verifyHumanTakeoverLeavesCancellationReview();
  await verifyHumanTakeoverRebookingDecision();
  const source = await db.AutomationFlowTemplateV2.findOne({
    where: {
      public_id: migration._test.TARGET_PUBLIC_ID,
      version: migration._test.SOURCE_VERSION,
    },
    raw: true,
  });
  assert(source, 'historical v2 source is required');
  assert.equal(migration._test.validateSource(source), true);

  const nodes = migration._test.buildTargetNodes(source);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  assert.equal(nodes.length, 28);
  assert.equal(nodes.filter((node) => node.type === 'condition/field_check').length, 2);

  assert.equal(byId.get('N1').config.custom_time, '21:00');
  assert.equal(byId.get('N1').config.only_if_not_confirmed, true);
  assert.equal(byId.get('N2').config.template_name, 'clinicaclick_aviso_cita_sin_confirmar_noche');
  assert.equal(byId.get('N2').config.language_routing.enabled, true);
  assert.equal(byId.get('N2').outputs.on_fail, 'N40');

  const wait = byId.get('N3');
  assert.equal(wait.config.timeout_duration, 1);
  assert.equal(wait.config.timeout_unit, 'hours');
  assert.equal(wait.config.response_buffer_delay_seconds, 90);
  assert.equal(wait.outputs.on_response, 'N4');
  assert.equal(wait.outputs.on_timeout, 'N10');
  assert.equal(byId.get('N10').config.new_status, 'cancelada');
  assert.equal(byId.get('N10').outputs.on_fail, 'N37');

  const ai = byId.get('N4');
  assert.equal(ai.config.preset_key, 'classify_intent');
  assert.deepEqual(
    ai.config.output_fields.map((field) => field.name),
    ['intencion_principal', 'intencion_secundaria', 'posible_urgencia', 'necesita_respuesta', 'motivo'],
  );
  assert.equal(ai.outputs.on_success, 'N14');
  assert.equal(ai.outputs.on_fail, 'N35');

  const router = byId.get('N14');
  assert.equal(router.config.mode, 'multi_branch');
  assert.deepEqual(
    router.config.branch_rules.map((item) => item.label),
    [
      'Confirma y necesita respuesta',
      'Confirma la cita',
      'Cancela la cita',
      'Solicita cambiar la cita',
      'Requiere respuesta de la clínica',
    ],
  );
  assert.equal(
    router.config.branch_rules.every((item) => item.comparison_rules.some((rule) => (
      rule.left_ref.path.startsWith('confianza_')
      && rule.operator === 'greater_than'
      && rule.right_value === 0.85
    ))),
    true,
  );

  const common = {
    intencion_secundaria: 'ninguna',
    confianza_intencion_secundaria: 0.95,
    motivo: 'QA',
  };
  const cases = [
    [{
      ...common,
      intencion_principal: 'confirmar_cita',
      confianza_intencion_principal: 0.96,
      necesita_respuesta: true,
      confianza_necesita_respuesta: 0.96,
    }, 'N15'],
    [{
      ...common,
      intencion_principal: 'confirmar_cita',
      confianza_intencion_principal: 0.96,
      necesita_respuesta: false,
      confianza_necesita_respuesta: 0.96,
    }, 'N6'],
    [{
      ...common,
      intencion_principal: 'cancelar_cita',
      confianza_intencion_principal: 0.96,
      necesita_respuesta: false,
      confianza_necesita_respuesta: 0.96,
    }, 'N21'],
    [{
      ...common,
      intencion_principal: 'solicitar_cambio_cita',
      confianza_intencion_principal: 0.96,
      necesita_respuesta: true,
      confianza_necesita_respuesta: 0.96,
    }, 'N30'],
    [{
      ...common,
      intencion_principal: 'pregunta',
      confianza_intencion_principal: 0.96,
      necesita_respuesta: true,
      confianza_necesita_respuesta: 0.96,
    }, 'N33'],
  ];
  for (const [output, expected] of cases) {
    const result = await evaluate(router, 'N4', output);
    assert.equal(result.next_node_id, expected);
  }

  const lowConfidence = await evaluate(router, 'N4', {
    ...common,
    intencion_principal: 'confirmar_cita',
    confianza_intencion_principal: 0.7,
    necesita_respuesta: false,
    confianza_necesita_respuesta: 0.96,
  });
  assert.equal(lowConfidence.next_node_id, 'N13');

  const ambiguousAcknowledgement = await evaluate(router, 'N4', {
    ...common,
    intencion_principal: 'agradecimiento',
    confianza_intencion_principal: 0.96,
    necesita_respuesta: false,
    confianza_necesita_respuesta: 0.96,
  });
  assert.equal(ambiguousAcknowledgement.next_node_id, 'N13');

  assert.equal(byId.get('N15').config.new_status, 'recordatorio_confirmado');
  assert.equal(byId.get('N6').config.new_status, 'recordatorio_confirmado');
  assert.equal(byId.get('N21').config.new_status, 'cancelada');
  assert.equal(byId.get('N21').outputs.on_success, 'N22');
  assert.equal(byId.get('N22').outputs.on_success, 'N23');
  assert.match(byId.get('N23').config.manual_message_text, /nueva fecha/i);
  assert.equal(byId.get('N30').config.new_status, 'cambio_solicitado');
  assert.match(byId.get('N31').config.manual_message_text, /Revisamos agenda/i);

  const followupWait = byId.get('N24');
  assert.equal(followupWait.config.timeout_duration, 12);
  assert.equal(followupWait.config.response_buffer_delay_seconds, 90);
  assert.equal(followupWait.outputs.on_response, 'N25');
  assert.equal(followupWait.outputs.on_timeout, null);
  assert.equal(byId.get('N25').outputs.on_fail, 'N36');

  const followupRouter = byId.get('N26');
  const yes = await evaluate(followupRouter, 'N25', {
    quiere_nueva_cita: true,
    confianza_quiere_nueva_cita: 0.96,
  });
  assert.equal(yes.next_node_id, 'N27');
  assert.equal(byId.get('N27').config.conversation_action, 'schedule_new_appointment');
  const no = await evaluate(followupRouter, 'N25', {
    quiere_nueva_cita: false,
    confianza_quiere_nueva_cita: 0.96,
  });
  assert.equal(no.next_node_id, 'N28');
  const uncertain = await evaluate(followupRouter, 'N25', {
    quiere_nueva_cita: true,
    confianza_quiere_nueva_cita: 0.7,
  });
  assert.equal(uncertain.next_node_id, 'N29');

  for (const id of ['N12', 'N23', 'N28', 'N31']) {
    assert.equal(byId.get(id).config.suppress_if_human_replied, true);
  }
  for (const item of nodes.filter((node) => node.type === 'action/send_system_notification')) {
    assert.equal(Boolean(item.outputs?.on_fail), false, `${item.id} notifications must not branch on failure`);
  }
  for (const id of ['N15', 'N6', 'N21', 'N30', 'N10']) {
    assert.equal(byId.get(id).outputs.on_fail, 'N37');
  }

  const validation = await validateFlowPayloadForInternalUse({
    entry_node_id: source.entry_node_id,
    trigger_type: source.trigger_type,
    trigger_config: source.trigger_config || {},
    nodes,
  });
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));

  const active = await db.AutomationFlowTemplateV2.findOne({
    where: {
      public_id: migration._test.TARGET_PUBLIC_ID,
      version: migration._test.ACTIVE_VERSION,
      is_active: true,
    },
    raw: true,
  });
  assert(active, 'active v6 must remain untouched');

  console.log('Cancel unconfirmed appointment night before v7: ok');
}

run().then(async () => {
  await db.sequelize.close();
  process.exit(0);
}).catch(async (error) => {
  console.error(error);
  try { await db.sequelize.close(); } catch (_closeError) {}
  process.exit(1);
});
