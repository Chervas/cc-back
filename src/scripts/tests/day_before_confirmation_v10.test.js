'use strict';

const assert = require('node:assert/strict');

process.env.JOBS_AUTO_START = 'false';

const db = require('../../../models');
const flowEngine = require('../../services/flowEngineV2.service');
const aiOrchestrator = require('../../services/aiOrchestrator.service');
const automationsController = require('../../controllers/automationsV2.controller');
const migration = require('../../../migrations/20260905113000-prepare-day-before-confirmation-v10');

async function evaluateRouter(router, output) {
  return flowEngine._processNode(
    router,
    { outputs: { N3: output } },
    { simulation: true },
  );
}

async function main() {
  const source = await db.AutomationFlowTemplateV2.findOne({
    where: {
      public_id: migration._test.TARGET_PUBLIC_ID,
      version: migration._test.SOURCE_VERSION,
    },
    raw: true,
  });
  assert(source, 'historical v5 source is required');
  assert.equal(migration._test.validateSource(source), true);

  const nodes = migration._test.buildTargetNodes(source);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  assert.equal(nodes.length, 29);
  assert.equal(byId.has('N9'), false, 'the duplicated AI node must be removed');
  assert.equal(byId.get('N5').outputs.on_response, 'N3');
  assert.equal(byId.get('N8').outputs.on_response, 'N3');
  assert.equal(byId.get('N5').config.response_buffer_delay_seconds, 90);
  assert.equal(byId.get('N8').config.response_buffer_delay_seconds, 90);

  const ai = byId.get('N3');
  assert.equal(ai.type, 'condition/ai_analysis');
  assert.equal(ai.config.preset_key, 'classify_intent');
  assert.equal(Object.prototype.hasOwnProperty.call(ai.config, 'ai_label'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(ai.config, 'ai_summary'), false);
  assert.deepEqual(
    ai.config.output_fields.map((field) => field.name),
    ['intencion_principal', 'intencion_secundaria', 'posible_urgencia', 'necesita_respuesta', 'motivo'],
  );
  assert.match(ai.config.instruction, /Marca posible urgencia/);
  assert.equal(JSON.stringify(ai.config).includes('posible_urgencia'), true);
  assert.equal(JSON.stringify(ai.config).includes('urgencia_posible'), true);

  const router = byId.get('N16');
  assert.equal(router.type, 'condition/field_check');
  assert.equal(router.config.mode, 'multi_branch');
  assert.deepEqual(
    router.config.branch_rules.map((branch) => branch.label),
    [
      'Confirma y necesita respuesta',
      'Confirma la cita',
      'Cancela la cita',
      'Solicita cambiar la cita',
      'Requiere respuesta de la clínica',
      'Acuse sin acción pendiente',
    ],
  );
  assert.equal(
    router.config.branch_rules.every((branch) => branch.comparison_rules.some((rule) => (
      rule.left_ref.path.startsWith('confianza_') && rule.operator === 'greater_than' && rule.right_value === 0.85
    ))),
    true,
  );
  assert.equal(
    router.config.branch_rules.some((branch) => branch.comparison_rules.some((rule) => (
      rule.left_ref.path === 'posible_urgencia'
    ))),
    false,
  );

  const common = {
    intencion_secundaria: 'ninguna',
    confianza_intencion_secundaria: 0.95,
    motivo: 'QA',
  };
  const cases = [
    {
      expected: 'N17',
      output: {
        ...common,
        intencion_principal: 'confirmar_cita',
        confianza_intencion_principal: 0.96,
        necesita_respuesta: true,
        confianza_necesita_respuesta: 0.94,
      },
    },
    {
      expected: 'N13',
      output: {
        ...common,
        intencion_principal: 'confirmar_cita',
        confianza_intencion_principal: 0.96,
        necesita_respuesta: false,
        confianza_necesita_respuesta: 0.94,
      },
    },
    {
      expected: 'N20',
      output: {
        ...common,
        intencion_principal: 'cancelar_cita',
        confianza_intencion_principal: 0.96,
        necesita_respuesta: false,
        confianza_necesita_respuesta: 0.94,
      },
    },
    {
      expected: 'N30',
      output: {
        ...common,
        intencion_principal: 'solicitar_cambio_cita',
        confianza_intencion_principal: 0.96,
        necesita_respuesta: true,
        confianza_necesita_respuesta: 0.94,
      },
    },
    {
      expected: 'N33',
      output: {
        ...common,
        intencion_principal: 'pregunta',
        confianza_intencion_principal: 0.96,
        necesita_respuesta: true,
        confianza_necesita_respuesta: 0.94,
      },
    },
  ];
  for (const item of cases) {
    const result = await evaluateRouter(router, item.output);
    assert.equal(result.next_node_id, item.expected);
  }

  const acknowledgement = await evaluateRouter(router, {
    ...common,
    intencion_principal: 'agradecimiento',
    confianza_intencion_principal: 0.96,
    necesita_respuesta: false,
    confianza_necesita_respuesta: 0.94,
  });
  assert.equal(acknowledgement.next_node_id, null);
  assert.equal(acknowledgement.output.matched_rule_id, 'branch_ack');

  const lowConfidence = await evaluateRouter(router, {
    ...common,
    intencion_principal: 'confirmar_cita',
    confianza_intencion_principal: 0.7,
    necesita_respuesta: false,
    confianza_necesita_respuesta: 0.95,
  });
  assert.equal(lowConfidence.next_node_id, 'N6');
  assert.equal(lowConfidence.output.matched_rule_id, null);
  assert.equal(byId.get('N6').config.display_mode, 'inbox');
  assert.match(byId.get('N6').config.message, /no se ha modificado la cita/i);

  const originalAnalyzeStructured = aiOrchestrator.analyzeStructured;
  aiOrchestrator.analyzeStructured = async () => {
    throw new Error('qa_day_before_provider_failure');
  };
  try {
    await assert.rejects(
      flowEngine._processNode(byId.get('N3'), {
        patient: { id: 121, nombre: 'Paciente QA' },
        appointment: { id: 75006, estado: 'recordatorio_enviado' },
        last_response_context: {
          response_text: 'Mensaje de prueba',
          response_items: [{ message_id: 990010, content_type: 'text', text: 'Mensaje de prueba' }],
          response_message_id: 990010,
          response_message_type: 'text',
        },
        conversation_today: [],
        trigger: { data: { appointment_id: 75006 } },
        outputs: {},
      }, { simulation: false }),
      /qa_day_before_provider_failure/,
    );
  } finally {
    aiOrchestrator.analyzeStructured = originalAnalyzeStructured;
  }
  assert.equal(byId.get('N3').outputs.on_fail, 'N35');
  assert.equal(byId.get('N35').config.display_mode, 'inbox');
  assert.equal(byId.get('N35').config.assignee_id, 'admin');
  assert.match(byId.get('N35').config.message, /cita no se ha modificado/i);

  assert.equal(byId.get('N13').config.new_status, 'recordatorio_confirmado');
  assert.equal(byId.get('N17').config.new_status, 'recordatorio_confirmado');
  assert.equal(byId.get('N20').config.new_status, 'cancelada');
  assert.equal(byId.get('N30').config.new_status, 'cambio_solicitado');
  assert.match(byId.get('N22').config.manual_message_text, /nueva fecha/);
  assert.equal(byId.get('N14').config.suppress_if_human_replied, true);
  assert.equal(byId.get('N22').config.suppress_if_human_replied, true);
  assert.equal(byId.get('N31').config.suppress_if_human_replied, true);

  const timeoutContext = {
    patient: { id: 121, nombre: 'Paciente QA' },
    appointment: { id: 75006, estado: 'recordatorio_enviado' },
    outputs: {
      N2: {
        message_id: 990001,
        at: '2026-09-05T08:00:00.000Z',
      },
      N7: {
        message_id: 990002,
        at: '2026-09-05T10:00:00.000Z',
      },
      N22: {
        message_id: 990003,
        at: '2026-09-05T12:00:00.000Z',
      },
    },
  };
  const firstWait = await flowEngine._processNode(byId.get('N5'), timeoutContext, { simulation: true });
  assert.equal(firstWait.kind, 'waiting');
  assert.equal(firstWait.waiting_meta.on_timeout, 'N7');
  assert.equal(
    new Date(firstWait.output.timeout_at).getTime() - new Date(firstWait.output.wait_starts_at).getTime(),
    2 * 60 * 60 * 1000,
  );
  const reminderWait = await flowEngine._processNode(byId.get('N8'), timeoutContext, { simulation: true });
  assert.equal(reminderWait.kind, 'waiting');
  assert.equal(reminderWait.waiting_meta.on_timeout, null);
  assert.equal(
    new Date(reminderWait.output.timeout_at).getTime() - new Date(reminderWait.output.wait_starts_at).getTime(),
    16 * 60 * 60 * 1000,
  );
  const rebookingWait = await flowEngine._processNode(byId.get('N23'), timeoutContext, { simulation: true });
  assert.equal(rebookingWait.kind, 'waiting');
  assert.equal(rebookingWait.waiting_meta.on_timeout, null);
  assert.equal(
    new Date(rebookingWait.output.timeout_at).getTime() - new Date(rebookingWait.output.wait_starts_at).getTime(),
    12 * 60 * 60 * 1000,
  );
  assert.equal(
    byId.get('N18').config.presentation_preference_key,
    'automation.appointment_data.confirmed_with_reply',
  );
  assert.equal(
    byId.get('N33').config.presentation_preference_key,
    'automation.appointment_data.response_needs_human',
  );
  assert.equal(byId.get('N26').config.replace_previous_persistent_alerts, true);
  assert.equal(byId.get('N28').config.replace_previous_persistent_alerts, true);
  assert.equal(
    nodes.filter((node) => node.type === 'action/send_system_notification')
      .every((node) => !Object.prototype.hasOwnProperty.call(node.outputs || {}, 'on_fail')),
    true,
  );

  const validation = await automationsController.validateFlowPayloadForInternalUse({
    entry_node_id: source.entry_node_id,
    trigger_type: source.trigger_type,
    trigger_config: source.trigger_config,
    nodes,
  });
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));

  console.log('day_before_confirmation_v10.test.js OK');
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
