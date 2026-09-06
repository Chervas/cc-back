'use strict';

const assert = require('node:assert/strict');

process.env.JOBS_AUTO_START = 'false';

const db = require('../../../models');
const controller = require('../../controllers/automationsV2.controller');
const flowEngine = require('../../services/flowEngineV2.service');
const migration = require('../../../migrations/20260906193000-prepare-review-request-v4');

async function route(node, output) {
  const result = await flowEngine._processNode(node, { outputs: { N5: output } }, { simulation: true });
  return result.next_node_id;
}

async function main() {
  const source = await db.AutomationFlowTemplateV2.findOne({
    where: { public_id: migration._test.TARGET_PUBLIC_ID, version: migration._test.SOURCE_VERSION },
    raw: true,
  });
  assert(source, 'review v2 source is required');
  assert.equal(migration._test.validateSource(source), true);

  const nodes = migration._test.buildTargetNodes(source);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const validation = await controller.validateFlowPayloadForInternalUse({
    entry_node_id: source.entry_node_id,
    trigger_type: source.trigger_type,
    trigger_config: source.trigger_config,
    nodes,
  });
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));

  assert.equal(nodes.length, 22);
  assert.equal(byId.get('N5').type, 'condition/ai_analysis');
  assert.equal(byId.get('N5').config.preset_key, 'review_response_classifier');
  assert.deepEqual(
    byId.get('N5').config.output_fields.map((field) => field.name),
    ['response_intent', 'response_rating', 'confidence', 'reason'],
  );
  assert.equal(byId.get('N11').type, 'action/process_review_response_classification');
  assert.deepEqual(byId.get('N11').config.effect_intents, ['wrong_recipient']);
  assert.deepEqual(byId.get('N12').config.effect_intents, ['review_refusal']);
  const appliedSimulation = await flowEngine._processNode(byId.get('N11'), {
    outputs: {
      N5: { response_intent: 'rating', response_rating: 4, confidence: 0.97, reason: 'Valoración explícita.' },
    },
  }, { simulation: true });
  assert.deepEqual(appliedSimulation.output, {
    status: 'simulated',
    response_intent: 'rating',
    response_rating: 4,
    confidence: 0.97,
    reason: 'Valoración explícita.',
  });

  const decision = byId.get('N6');
  assert.equal(decision.config.mode, 'multi_branch');
  assert.deepEqual(
    decision.config.branch_rules.map((branch) => branch.label),
    [
      'Valoración 5/5',
      'Valoración de 1 a 4',
      'Solicita no recibir más mensajes',
      'Número equivocado',
      'No quiere dejar una reseña',
      'Respuesta no concluyente',
    ],
  );

  assert.equal(await route(decision, { response_intent: 'rating', response_rating: 5, confidence: 0.99 }), 'N8');
  assert.equal(await route(decision, { response_intent: 'rating', response_rating: 3, confidence: 0.99 }), 'N9');
  assert.equal(await route(decision, { response_intent: 'marketing_opt_out', confidence: 0.99 }), 'N10');
  assert.equal(await route(decision, { response_intent: 'wrong_recipient', confidence: 0.99 }), 'N11');
  assert.equal(await route(decision, { response_intent: 'review_refusal', confidence: 0.99 }), 'N12');
  assert.equal(await route(decision, { response_intent: 'ambiguous', confidence: 0.4 }), 'N13');
  assert.equal(await route(decision, { response_intent: 'rating', response_rating: 5, confidence: 0.5 }), 'N13');

  assert.equal(byId.get('N10').type, 'action/unsubscribe_communications');
  assert.equal(byId.get('N10').config.communication_scope, 'marketing');
  assert.equal(byId.get('N10').outputs.on_success, 'N14');
  const unsubscribeSimulation = await flowEngine._processNode(byId.get('N10'), {}, { simulation: true });
  assert.equal(unsubscribeSimulation.output.communication_scope, 'marketing');
  assert.equal(unsubscribeSimulation.next_node_id, 'N14');
  assert.equal(byId.get('N8').outputs.on_success, 'N15');
  assert.equal(byId.get('N9').outputs.on_success, 'N16');
  assert.equal(byId.get('N13').outputs.on_success, 'N17');
  ['N14', 'N15', 'N16', 'N17', 'N18', 'N19'].forEach((id) => assert.equal(byId.get(id).type, 'control/end'));

  assert.equal(byId.get('N4').outputs.on_timeout, 'N20');
  assert.equal(byId.get('N3').outputs.on_fail, 'N90');
  assert.equal(byId.get('N8').outputs.on_fail, 'N90');
  assert.equal(byId.get('N9').outputs.on_fail, 'N90');
  assert.equal(byId.get('N10').outputs.on_fail, 'N90');
  assert.equal(byId.get('N11').outputs.on_fail, 'N90');
  assert.equal(byId.get('N12').outputs.on_fail, 'N90');
  assert.equal(byId.get('N20').outputs.on_fail, 'N90');
  assert.equal(byId.get('N21').outputs.on_response, 'N5');
  assert.equal(byId.get('N21').outputs.on_timeout, 'N22');
  assert.equal(byId.get('N90').config.assignee_id, 'admin');
  assert.equal(
    nodes.filter((node) => node.type === 'action/send_system_notification')
      .every((node) => !Object.prototype.hasOwnProperty.call(node.outputs || {}, 'on_fail')),
    true,
  );

  console.log('review_request_v4.test.js OK');
}

main()
  .then(async () => {
    await db.sequelize.close();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error);
    try { await db.sequelize.close(); } catch (_closeError) {}
    process.exitCode = 1;
  });
