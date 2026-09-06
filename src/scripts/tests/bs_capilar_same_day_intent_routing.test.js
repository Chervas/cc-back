'use strict';

const assert = require('node:assert/strict');

process.env.JOBS_AUTO_START = 'false';

const db = require('../../../models');
const automationsController = require('../../controllers/automationsV2.controller');
const flowEngine = require('../../services/flowEngineV2.service');
const migration = require('../../../migrations/20260903132000-publish-bs-capilar-same-day-intent-routing')._test;
const urgencyFix = require('../../../migrations/20260903225500-fix-bs-capilar-urgency-routing')._test;
const uncertaintyFix = require('../../../migrations/20260903234500-harden-bs-capilar-uncertain-confirmation')._test;
const simplification = require('../../../migrations/20260904090000-simplify-bs-capilar-same-day-v10')._test;
const technicalNotificationCleanup = require('../../../migrations/20260904110000-remove-bs-capilar-technical-notification-nodes')._test;
const humanRescheduleRace = require('../../../migrations/20260904123000-resolve-bs-capilar-human-reschedule-race')._test;

async function route(node, output) {
  return flowEngine._processNode(
    node,
    { outputs: { N3: output, N44: output } },
    { simulation: true },
  );
}

async function main() {
  let flowMetaPayload = null;
  await automationsController.getFlowMeta({}, {
    json(payload) {
      flowMetaPayload = payload;
      return payload;
    },
  });
  const notificationType = flowMetaPayload?.data?.node_types?.find(
    (item) => item.type === 'action/send_system_notification',
  );
  assert.deepEqual(notificationType?.output_keys, ['on_success']);

  const source = await db.AutomationFlowTemplateV2.findOne({
    where: { public_id: migration.TARGET_PUBLIC_ID, is_active: true },
    raw: true,
  });
  assert.ok(source, 'active BS Capilar same-day flow is required');
  assert.equal(migration.validateSource(source), true);

  const nodes = humanRescheduleRace.applyHumanRescheduleContract(
    technicalNotificationCleanup.removeTechnicalNotificationNodes(
      simplification.applySameDayV10Simplification(
        uncertaintyFix.applyUncertainConfirmationContract(
          urgencyFix.applyUrgencyRoutingFix(migration.buildTargetNodes(source)),
        ),
      ),
    ),
  );
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const validation = await automationsController.validateFlowPayloadForInternalUse({
    entry_node_id: source.entry_node_id,
    trigger_type: source.trigger_type,
    trigger_config: source.trigger_config,
    nodes,
  });
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  const invalidNotificationNodes = JSON.parse(JSON.stringify(nodes));
  invalidNotificationNodes.find((node) => node.id === 'N52').config.message = '';
  const invalidNotificationValidation = await automationsController.validateFlowPayloadForInternalUse({
    entry_node_id: source.entry_node_id,
    trigger_type: source.trigger_type,
    trigger_config: source.trigger_config,
    nodes: invalidNotificationNodes,
  });
  assert.equal(invalidNotificationValidation.ok, false);
  assert.ok(invalidNotificationValidation.errors.some((error) => (
    error.code === 'node_config_required'
      && error.details?.node_id === 'N52'
      && error.details?.key === 'message'
  )));

  const ai = byId.get('N3');
  assert.ok(ai);
  assert.equal(ai.config.preset_key, 'classify_intent');
  assert.equal(ai.config.output_fields.some((field) => field.name === 'accion_inequivoca'), false);
  assert.equal(ai.config.output_fields.find((field) => field.name === 'intencion_principal').include_confidence, true);
  assert.match(ai.config.instruction, /todavia no puede confirmar/);
  assert.equal(ai.outputs.on_fail, null);
  assert.equal(ai.outputs.on_success, 'N10');
  assert.equal(ai.config.output_fields.some((field) => field.name === 'posible_urgencia'), false);
  assert.equal(
    ai.config.output_fields.some((field) => field.allowed_values?.includes('urgencia_posible')),
    false,
  );
  const simulatedAi = await flowEngine._processNode(ai, {
    conversation_today: '[03/09/2026, 23:00] Paciente: Tengo que cancelar la cita',
    last_response_context: {
      response_text: 'Tengo que cancelar la cita',
      response_lines: ['Tengo que cancelar la cita'],
    },
    appointment: { id: 74929, estado: 'pendiente' },
    trigger: { data: { appointment_id: 74929, appointment_candidate_count: 1 } },
  }, { simulation: true });
  assert.notEqual(simulatedAi.output._ai_provider, 'deterministic_rule');
  assert.equal(
    flowEngine._resolveAiAnalysisNextNode(ai, 'classify_intent', {
      _ai_provider: 'unavailable',
      _ai_error_code: 'bedrock_timeout',
    }),
    null,
  );

  assert.equal(byId.has('N29'), false);
  assert.equal(byId.has('N30'), false);

  const mainBranch = byId.get('N10');
  const base = {
    intencion_principal: 'otra',
    confianza_intencion_principal: 0.99,
    necesita_respuesta: false,
  };
  const scenarios = [
    [{ ...base, intencion_principal: 'confirmar_cita', necesita_respuesta: true }, 'N31'],
    [{ ...base, intencion_principal: 'confirmar_cita' }, 'N32'],
    [{ ...base, intencion_principal: 'cancelar_cita' }, 'N40'],
    [{ ...base, intencion_principal: 'solicitar_cambio_cita' }, 'N50'],
    [{ ...base, intencion_principal: 'pregunta', necesita_respuesta: true }, 'N60'],
    [{ ...base, intencion_principal: 'agradecimiento' }, 'N62'],
    [{ ...base, intencion_principal: 'confirmar_cita', confianza_intencion_principal: 0.85 }, 'N61'],
  ];
  for (const [output, expected] of scenarios) {
    const result = await route(mainBranch, output);
    assert.equal(result.next_node_id, expected, JSON.stringify(output));
  }

  assert.equal(byId.get('N31').config.new_status, 'recordatorio_confirmado');
  assert.equal(byId.get('N32').config.new_status, 'recordatorio_confirmado');
  assert.equal(byId.get('N40').config.new_status, 'cancelada');
  assert.equal(byId.get('N50').config.new_status, 'cambio_solicitado');
  assert.equal(byId.get('N51').config.message_text, humanRescheduleRace.CHANGE_REQUEST_REPLY);
  assert.equal(byId.get('N62').type, 'action/reply_message');
  assert.equal(byId.get('N62').config.message_text, 'Perfecto ¡hasta ahora!');
  assert.equal(byId.get('N62').config.suppress_if_human_replied, true);
  const acknowledgement = await flowEngine._processNode(byId.get('N62'), {
    trigger: { data: { latest_inbound_message_id: 103243 } },
  }, { simulation: true });
  assert.equal(acknowledgement.kind, 'success');
  assert.equal(acknowledgement.output.status, 'simulated');
  assert.equal(acknowledgement.output.message_preview, 'Perfecto ¡hasta ahora!');
  assert.equal(acknowledgement.output.source_message_id, 103243);
  assert.equal(acknowledgement.output.suppress_if_human_replied, true);
  assert.equal(acknowledgement.next_node_id, null);
  assert.equal(byId.get('N44').outputs.on_fail, null);
  assert.equal(byId.get('N31').outputs.on_fail, null);
  assert.equal(byId.get('N32').outputs.on_fail, null);
  assert.equal(byId.get('N40').outputs.on_fail, null);
  assert.equal(byId.get('N42').outputs.on_fail, null);
  assert.equal(byId.get('N50').outputs.on_fail, null);
  assert.equal(byId.get('N43').config.listens_to_node_id, 'N42');
  assert.equal(byId.get('N43').config.response_buffer_delay_seconds, 90);

  const followup = byId.get('N45');
  assert.equal((await route(followup, {
    quiere_nueva_cita: true,
    confianza_quiere_nueva_cita: 0.91,
  })).next_node_id, 'N46');
  assert.equal((await route(followup, {
    quiere_nueva_cita: false,
    confianza_quiere_nueva_cita: 0.91,
  })).next_node_id, 'N74');
  assert.equal((await route(followup, {
    quiere_nueva_cita: true,
    confianza_quiere_nueva_cita: 0.5,
  })).next_node_id, 'N47');
  assert.equal(
    nodes.some((item) => item.id !== 'N50' && item.type === 'action/change_status' && item.config?.new_status === 'cambio_solicitado'),
    false,
    'a cancelled appointment must not later become cambio_solicitado',
  );

  const declinedFollowup = byId.get('N74');
  assert.equal(declinedFollowup.type, 'action/reply_message');
  assert.equal(declinedFollowup.config.message_text, simplification.FOLLOWUP_DECLINED_REPLY);
  assert.equal(declinedFollowup.config.suppress_if_human_replied, true);
  assert.equal(declinedFollowup.outputs.on_fail, null);

  for (const id of ['N33', 'N41', 'N46', 'N47', 'N52', 'N60']) {
    assert.equal(byId.get(id).config.display_mode, 'persistent_alert', id);
  }
  assert.equal(byId.get('N61').config.display_mode, 'inbox');
  for (const node of nodes.filter((item) => item.type === 'action/send_system_notification')) {
    assert.equal(Object.hasOwn(node.outputs || {}, 'on_fail'), false, node.id);
  }
  for (const id of technicalNotificationCleanup.TECHNICAL_NOTIFICATION_NODE_IDS) {
    assert.equal(byId.has(id), false, id);
    assert.equal(nodes.some((node) => Object.values(node.outputs || {}).includes(id)), false, id);
  }

  const rollbackSnapshot = { inserted_template_id: 1472 };
  assert.equal(migration.shouldRestorePreviousVersion([
    { id: 1324, is_active: 0 },
    { id: 1472, is_active: 1 },
  ], rollbackSnapshot), true);
  assert.equal(migration.shouldRestorePreviousVersion([
    { id: 1324, is_active: 0 },
    { id: 1472, is_active: 0 },
    { id: 1500, is_active: 1 },
  ], rollbackSnapshot), false, 'a newer publication must not be overwritten');
  assert.equal(migration.findPreparedVersion([
    { id: 1324, nodes: [] },
    { id: 1472, nodes: [{ config: { migration_key: migration.SNAPSHOT_KEY } }] },
  ])?.id, 1472);

  console.log('bs_capilar_same_day_intent_routing.test.js OK');
}

main().then(async () => {
  await db.sequelize.close();
  process.exit(0);
}).catch(async (error) => {
  console.error(error);
  try { await db.sequelize.close(); } catch (_closeError) {}
  process.exit(1);
});
