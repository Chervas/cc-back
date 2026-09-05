#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const db = require('../../../models');
const migration = require('../../../migrations/20260904170000-route-appointment-data-confirmation-v16');
const alertMigration = require('../../../migrations/20260904203000-persist-appointment-data-human-response-alerts-v16');
const flowEngine = require('../../services/flowEngineV2.service');
const resumeService = require('../../services/automationsV2Resume.service');
const conversationAutomationState = require('../../services/conversationAutomationState.service');
const {
  CONFIRM_APPOINTMENT_DECISION_TEMPLATE,
} = require('../../lib/automation-intent-contract');

const nodesById = new Map();
for (const route of migration._test.ROUTES) {
  nodesById.set(route.ai, {
    id: route.ai,
    type: 'condition/ai_analysis',
    config: {
      preset_key: 'confirm_appointment',
      preset_contract_version: 2,
      routing_pending_review: true,
    },
    outputs: { on_success: route.success, on_fail: route.review },
    position: { x: 100, y: 100 },
  });
  nodesById.set(route.success, {
    id: route.success,
    type: 'action/send_whatsapp',
    config: { manual_message_text: 'Gracias' },
    outputs: { on_success: route.status, on_fail: null },
    position: { x: 100, y: 200 },
  });
  nodesById.set(route.status, {
    id: route.status,
    type: 'action/change_status',
    config: { target_entity: 'appointment', new_status: 'recordatorio_confirmado' },
    outputs: { on_success: null, on_fail: null },
    position: { x: 100, y: 300 },
  });
  nodesById.set(route.review, {
    id: route.review,
    type: 'action/send_system_notification',
    config: { title: 'Revisar', message: 'Revisar', assignee_type: 'role', assignee_id: 'admin' },
    outputs: { on_success: null, on_fail: null },
    position: { x: 100, y: 400 },
  });
}
let fillerIndex = 1;
while (nodesById.size < 41) {
  const id = `X${fillerIndex++}`;
  nodesById.set(id, {
    id,
    type: 'control/end',
    config: {},
    outputs: {},
    position: { x: 0, y: 0 },
  });
}

const routed = migration._test.applyDecisionRouting([...nodesById.values()]);
assert.equal(routed.length, 65);
const routedById = new Map(routed.map((node) => [node.id, node]));

for (const route of migration._test.ROUTES) {
  const ai = routedById.get(route.ai);
  const decision = routedById.get(route.decision);
  const mixedStatus = routedById.get(route.mixedStatus);
  const mixedNotice = routedById.get(route.mixedNotice);
  const fallbackNotice = routedById.get(route.fallbackNotice);
  const review = routedById.get(route.review);

  assert.deepEqual(ai.outputs, { on_success: route.decision, on_fail: null });
  assert.equal(routedById.get(route.success).config.suppress_if_human_replied, true);
  assert.equal(ai.config.routing_pending_review, undefined);
  assert.equal(ai.config.decision_template_key, CONFIRM_APPOINTMENT_DECISION_TEMPLATE.key);
  assert.equal(decision.type, 'condition/field_check');
  assert.equal(decision.config.mode, 'multi_branch');
  assert.equal(decision.config.source_ai_node_id, route.ai);
  assert.equal(decision.config.branch_rules.length, 3);
  assert.deepEqual(decision.outputs, {
    branch_confirm_without_reply: route.success,
    branch_confirm_needs_reply: route.mixedStatus,
    branch_not_confirmed: route.review,
    on_else: route.fallbackNotice,
  });
  assert.equal(
    decision.config.branch_rules[0].comparison_rules[1].right_value,
    0.85,
  );
  assert.equal(decision.config.branch_rules[0].comparison_rules.length, 3);
  assert.equal(mixedStatus.config.new_status, routedById.get(route.status).config.new_status);
  assert.equal(mixedStatus.outputs.on_success, route.mixedNotice);
  assert.equal(mixedNotice.config.assignee_id, 'personaldeclinica');
  assert.equal(mixedNotice.config.display_mode, 'persistent_alert');
  assert.equal(
    mixedNotice.config.presentation_preference_key,
    'automation.appointment_data.confirmed_with_reply',
  );
  assert.deepEqual(mixedNotice.outputs, { on_success: null });
  assert.equal(fallbackNotice.config.title, 'Revisión necesaria');
  assert.equal(fallbackNotice.config.display_mode, 'inbox');
  assert.deepEqual(fallbackNotice.outputs, { on_success: null });
  assert.equal(review.config.display_mode, 'persistent_alert');
  assert.equal(
    review.config.presentation_preference_key,
    'automation.appointment_data.response_needs_human',
  );
  assert.deepEqual(review.outputs, { on_success: null });
}

const persistedAlerts = alertMigration._test.applyPersistentHumanResponseAlerts(routed);
const persistedAlertsById = new Map(persistedAlerts.map((node) => [node.id, node]));
for (const id of [
  ...alertMigration._test.REVIEW_NODE_IDS,
  ...alertMigration._test.CONFIRMED_REPLY_NODE_IDS,
]) {
  assert.equal(persistedAlertsById.get(id).config.display_mode, 'persistent_alert');
  assert.equal(persistedAlertsById.get(id).config.alert_level, 'warning');
  assert.equal(
    persistedAlertsById.get(id).config.presentation_preference_key,
    alertMigration._test.REVIEW_NODE_IDS.includes(id)
      ? 'automation.appointment_data.response_needs_human'
      : 'automation.appointment_data.confirmed_with_reply',
  );
}
for (const id of alertMigration._test.LOW_CONFIDENCE_NODE_IDS) {
  assert.equal(persistedAlertsById.get(id).config.display_mode, 'inbox');
}

assert.throws(
  () => migration._test.applyDecisionRouting(routed),
  /node_count_mismatch/,
);

async function verifyRuntimeRoutes() {
  const route = migration._test.ROUTES[0];
  const decision = routedById.get(route.decision);
  const cases = [
    {
      output: {
        confirma_asistencia: true,
        confianza_confirma_asistencia: 0.96,
        requiere_respuesta: false,
        confianza_requiere_respuesta: 0,
      },
      expected: route.success,
    },
    {
      output: {
        confirma_asistencia: true,
        confianza_confirma_asistencia: 0.96,
        requiere_respuesta: true,
        confianza_requiere_respuesta: 0.96,
      },
      expected: route.mixedStatus,
    },
    {
      output: {
        confirma_asistencia: false,
        confianza_confirma_asistencia: 0.96,
        requiere_respuesta: true,
        confianza_requiere_respuesta: 0.96,
      },
      expected: route.review,
    },
    {
      output: {
        confirma_asistencia: true,
        confianza_confirma_asistencia: 0.85,
        requiere_respuesta: false,
        confianza_requiere_respuesta: 0.99,
      },
      expected: route.fallbackNotice,
    },
    {
      output: {
        confirma_asistencia: true,
        confianza_confirma_asistencia: 0.96,
        requiere_respuesta: true,
        confianza_requiere_respuesta: 0.75,
      },
      expected: route.fallbackNotice,
    },
  ];
  for (const testCase of cases) {
    const result = await flowEngine._processNode(
      decision,
      { outputs: { [route.ai]: testCase.output } },
      { simulation: true },
    );
    assert.equal(result.next_node_id, testCase.expected);
  }
}

function buildCompletedExecution({ id, branch, requiresResponse }) {
  return {
    id,
    clinic_id: 66,
    status: 'completed',
    trigger_entity_type: 'appointment',
    trigger_entity_id: 74974,
    context: {
      conversation: { id: 2142 },
      appointment: { id: 74974, estado: 'info_enviada' },
      outputs: {
        N18: {
          confirma_asistencia: true,
          confianza_confirma_asistencia: 0.95,
          requiere_respuesta: requiresResponse,
          confianza_requiere_respuesta: 0.9,
        },
        N46: {
          matched_rule_id: branch,
          next_output_key: branch,
        },
        N47: {
          status: 'success',
          target_type: 'appointment',
          new_status: 'recordatorio_confirmado',
        },
      },
    },
  };
}

async function verifyConversationStateSync() {
  const originalStateFindOne = db.ConversationAutomationState.findOne;
  const originalAppointmentFindByPk = db.CitaPaciente.findByPk;
  const originalUpdateOwnedState = conversationAutomationState.updateOwnedState;
  const originalCompleteState = conversationAutomationState.completeState;
  let currentExecutionId = 9001;
  let reviewPatch = null;
  let completedPatch = null;

  db.ConversationAutomationState.findOne = async () => ({
    conversation_id: 2142,
    clinic_id: 66,
    execution_id: currentExecutionId,
    appointment_id: 74974,
    appointment_status: 'info_enviada',
    intent: 'solicitar_cambio_cita',
    possible_urgency: true,
    needs_response: false,
    manual_action_required: false,
    source_message_id: null,
  });
  db.CitaPaciente.findByPk = async () => ({
    id_cita: 74974,
    estado: 'recordatorio_confirmado',
  });
  conversationAutomationState.updateOwnedState = async (patch) => {
    reviewPatch = patch;
    return patch;
  };
  conversationAutomationState.completeState = async (patch) => {
    completedPatch = patch;
    return patch;
  };

  try {
    await flowEngine._syncConversationAutomationStateAfterExecution(buildCompletedExecution({
      id: 9001,
      branch: 'branch_confirm_needs_reply',
      requiresResponse: true,
    }));
    assert.equal(reviewPatch.stage, 'review');
    assert.equal(reviewPatch.status, 'review');
    assert.equal(reviewPatch.intent, 'confirmar_cita');
    assert.equal(reviewPatch.possibleUrgency, false);
    assert.equal(reviewPatch.needsResponse, true);
    assert.equal(reviewPatch.manualActionRequired, true);
    assert.equal(completedPatch, null);

    currentExecutionId = 9002;
    reviewPatch = null;
    await flowEngine._syncConversationAutomationStateAfterExecution(buildCompletedExecution({
      id: 9002,
      branch: 'branch_confirm_without_reply',
      requiresResponse: false,
    }));
    assert.equal(reviewPatch, null);
    assert.equal(completedPatch.intent, 'confirmar_cita');
    assert.equal(completedPatch.possibleUrgency, false);
    assert.equal(completedPatch.needsResponse, false);
    assert.equal(completedPatch.failureCode, null);

    assert.deepEqual(
      resumeService._buildInboundAutomationStateReset({
        context: { appointment: { id: 74974, estado: 'info_enviada' } },
      }),
      {
        appointmentId: 74974,
        appointmentStatus: 'info_enviada',
        intent: null,
        possibleUrgency: false,
        needsResponse: false,
        manualActionRequired: false,
        failureCode: null,
        completedAt: null,
      },
    );
  } finally {
    db.ConversationAutomationState.findOne = originalStateFindOne;
    db.CitaPaciente.findByPk = originalAppointmentFindByPk;
    conversationAutomationState.updateOwnedState = originalUpdateOwnedState;
    conversationAutomationState.completeState = originalCompleteState;
  }
}

async function run() {
  await verifyRuntimeRoutes();
  await verifyConversationStateSync();
  console.log('Appointment data confirmation v16 decision routing: ok');
}

run().then(async () => {
  await db.sequelize.close();
  process.exit(0);
}).catch(async (error) => {
  console.error(error);
  try { await db.sequelize.close(); } catch (_closeError) {}
  process.exit(1);
});
