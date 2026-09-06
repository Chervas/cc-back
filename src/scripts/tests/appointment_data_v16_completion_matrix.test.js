'use strict';

const assert = require('node:assert/strict');

process.env.JOBS_AUTO_START = 'false';

const db = require('../../../models');
const flowEngine = require('../../services/flowEngineV2.service');
const aiOrchestrator = require('../../services/aiOrchestrator.service');

const PUBLIC_ID = 'flw_fc01d1d9647df069';
const VERSION = 16;

async function loadNodes() {
  const template = await db.AutomationFlowTemplateV2.findOne({
    where: { public_id: PUBLIC_ID, version: VERSION },
    raw: true,
  });
  assert(template, 'v16 draft is required');
  assert.equal(Number(template.is_active), 0);
  assert.equal(template.published_at, null);
  const nodes = typeof template.nodes === 'string' ? JSON.parse(template.nodes) : template.nodes;
  return new Map(nodes.map((node) => [node.id, node]));
}

async function verifyTemporalRoutes(nodes) {
  const n2 = nodes.get('N2');
  const cases = [
    {
      name: 'same day',
      createdAt: '2026-09-10T08:00:00.000Z',
      expectedWindow: 'same_day',
      expectedNode: 'N3',
    },
    {
      name: 'day before',
      createdAt: '2026-09-09T08:00:00.000Z',
      expectedWindow: 'day_before',
      expectedNode: 'N4',
    },
    {
      name: 'more than day before',
      createdAt: '2026-09-08T08:00:00.000Z',
      expectedWindow: 'more_than_day_before',
      expectedNode: 'N5',
    },
  ];
  for (const scenario of cases) {
    const result = await flowEngine._processNode(n2, {
      clinic: { timezone: 'Europe/Madrid' },
      appointment: {
        inicio: '2026-09-10T10:00:00.000Z',
        created_at: scenario.createdAt,
      },
      trigger: { type: 'appointment_created', data: {} },
    }, { simulation: true });
    assert.equal(result.output.matched_window, scenario.expectedWindow, scenario.name);
    assert.equal(result.next_node_id, scenario.expectedNode, scenario.name);
  }
}

async function verifyTimeouts(nodes) {
  const cases = [
    {
      name: 'same day',
      initial: 'N3',
      status: 'N6',
      first: 'N7',
      reminder: 'N9',
      second: 'N13',
      secondHours: 2,
      initialTemplate: 'clinicaclick_confirmacion_datos_cita_hoy_v7',
      reminderText: 'necesitamos saber que sabes llegar',
    },
    {
      name: 'day before',
      initial: 'N4',
      status: 'N22',
      first: 'N23',
      reminder: 'N27',
      second: 'N45',
      secondHours: 12,
      initialTemplate: 'clinicaclick_confirmacion_datos_cita_24_v4',
      reminderText: '¿Me confirmas tu asistencia mañana?',
    },
    {
      name: 'more than day before',
      initial: 'N5',
      status: 'N33',
      first: 'N34',
      reminder: 'N39',
      second: 'N44',
      secondHours: 12,
      initialTemplate: 'clinicaclick_confirmacion_datos_cita_48_v3',
      reminderText: 'confirmar que el teléfono de contacto es correcto',
    },
  ];

  for (const scenario of cases) {
    const visited = [];
    const context = {
      __simulation: true,
      paciente: { id_paciente: 990001, nombre: 'Paciente QA' },
      patient: { id_paciente: 990001, nombre: 'Paciente QA' },
      clinica: { id_clinica: 66, nombre: 'Clínica QA', direccion: 'Calle QA, 1' },
      clinic: { id_clinica: 66, nombre: 'Clínica QA', direccion: 'Calle QA, 1' },
      usuario: { id_usuario: 990001, nombre: 'Recepción QA' },
      appointment: {
        id: 990001,
        estado: 'pendiente',
        inicio: '2026-09-10T10:00:00.000Z',
      },
      outputs: {},
    };
    const applyResult = (nodeId, result) => {
      visited.push(nodeId);
      context.outputs[nodeId] = result.output;
      for (const [key, value] of Object.entries(result.context_patch || {})) {
        context[key] = value && typeof value === 'object' && !Array.isArray(value)
          ? { ...(context[key] || {}), ...value }
          : value;
      }
    };

    const initial = nodes.get(scenario.initial);
    const initialResult = await flowEngine._processNode(initial, context, { simulation: true });
    applyResult(scenario.initial, initialResult);
    assert.equal(initialResult.kind, 'success', `${scenario.name}: initial message`);
    assert.equal(initialResult.output.status, 'simulated', `${scenario.name}: initial simulated`);
    assert.equal(initial.config.template_name, scenario.initialTemplate, `${scenario.name}: initial template`);
    assert.equal(initialResult.next_node_id, scenario.status, `${scenario.name}: initial next`);

    const statusResult = await flowEngine._processNode(nodes.get(scenario.status), context, { simulation: true });
    applyResult(scenario.status, statusResult);
    assert.equal(statusResult.output.new_status, 'info_enviada', `${scenario.name}: sent status`);
    assert.equal(context.appointment.estado, 'info_enviada', `${scenario.name}: simulated appointment state`);
    assert.equal(statusResult.next_node_id, scenario.first, `${scenario.name}: status next`);

    const first = nodes.get(scenario.first);
    const firstResult = await flowEngine._processNode(first, context, { simulation: true });
    applyResult(scenario.first, firstResult);
    assert.equal(firstResult.kind, 'waiting', `${scenario.name}: first wait`);
    assert.equal(firstResult.waiting_meta.on_timeout, scenario.reminder, `${scenario.name}: first timeout route`);
    assert.equal(
      Math.round((firstResult.wait_until.getTime() - new Date(firstResult.output.wait_starts_at).getTime()) / 3600000),
      2,
      `${scenario.name}: first timeout duration`,
    );

    // Advance the simulated clock directly to the timeout branch.
    const reminder = nodes.get(firstResult.waiting_meta.on_timeout);
    const reminderResult = await flowEngine._processNode(reminder, context, { simulation: true });
    applyResult(scenario.reminder, reminderResult);
    assert.equal(reminder.type, 'action/send_whatsapp', `${scenario.name}: reminder node`);
    assert.equal(reminderResult.output.status, 'simulated', `${scenario.name}: reminder simulated`);
    assert.match(reminderResult.output.message_preview, new RegExp(scenario.reminderText, 'i'), `${scenario.name}: reminder text`);
    assert.equal(reminderResult.next_node_id, scenario.second, `${scenario.name}: reminder next`);

    const second = nodes.get(scenario.second);
    const secondResult = await flowEngine._processNode(second, context, { simulation: true });
    applyResult(scenario.second, secondResult);
    assert.equal(secondResult.kind, 'waiting', `${scenario.name}: second wait`);
    assert.equal(secondResult.waiting_meta.on_timeout, null, `${scenario.name}: final timeout ends flow`);
    assert.equal(
      Math.round((secondResult.wait_until.getTime() - new Date(secondResult.output.wait_starts_at).getTime()) / 3600000),
      scenario.secondHours,
      `${scenario.name}: second timeout duration`,
    );
    assert.equal(context.appointment.estado, 'info_enviada', `${scenario.name}: timeout does not confirm appointment`);
    assert.deepEqual(
      visited,
      [scenario.initial, scenario.status, scenario.first, scenario.reminder, scenario.second],
      `${scenario.name}: timeout path`,
    );
    assert.equal(
      visited.some((nodeId) => ['condition/ai_analysis', 'action/notify'].includes(nodes.get(nodeId)?.type)),
      false,
      `${scenario.name}: timeout path avoids AI and notifications`,
    );
  }
}

async function verifyLowConfidence(nodes) {
  for (const [decisionId, aiId, expectedFallback] of [
    ['N46', 'N18', 'N49'],
    ['N50', 'N14', 'N53'],
    ['N54', 'N28', 'N57'],
    ['N58', 'N24', 'N61'],
    ['N62', 'N40', 'N65'],
    ['N66', 'N35', 'N69'],
  ]) {
    const result = await flowEngine._processNode(nodes.get(decisionId), {
      outputs: {
        [aiId]: {
          confirma_asistencia: true,
          confianza_confirma_asistencia: 0.84,
          requiere_respuesta: false,
          confianza_requiere_respuesta: 0.99,
        },
      },
    }, { simulation: true });
    assert.equal(result.next_node_id, expectedFallback, decisionId);
    assert.equal(nodes.get(expectedFallback).config.display_mode, 'inbox', decisionId);
  }
}

async function verifyProviderFailure(nodes) {
  const originalAnalyzeStructured = aiOrchestrator.analyzeStructured;
  aiOrchestrator.analyzeStructured = async () => {
    throw new Error('qa_provider_failure');
  };
  try {
    await assert.rejects(
      flowEngine._processNode(nodes.get('N35'), {
        appointment: {
          id: 74974,
          estado: 'info_enviada',
          inicio: '2026-09-11T18:00:00.000Z',
        },
        last_response_context: {
          response_text: 'Sí, lo he recibido',
          response_lines: ['Sí, lo he recibido'],
          response_message_id: 990102,
          response_message_type: 'text',
        },
        trigger: {
          data: {
            appointment_id: 74974,
            latest_inbound_message_id: 990102,
          },
        },
      },
      { simulation: false }),
      /qa_provider_failure/,
    );
    assert.equal(nodes.get('N35').outputs.on_fail, null);
  } finally {
    aiOrchestrator.analyzeStructured = originalAnalyzeStructured;
  }
}

async function verifyHumanInterruption(nodes) {
  for (const id of ['N15', 'N19', 'N25', 'N29', 'N36', 'N41']) {
    assert.equal(nodes.get(id).config.suppress_if_human_replied, true, id);
  }

  const originalQuery = db.sequelize.query;
  db.sequelize.query = async (sql, options) => {
    assert.match(sql, /id > :responseMessageId/);
    assert.deepEqual(options.replacements, { conversationId: 2142, responseMessageId: 990102 });
    return [{ id: 990103 }];
  };
  try {
    const result = await flowEngine._processNode(nodes.get('N36'), {
      conversation: { id: 2142 },
      last_response_context: { response_message_id: 990102 },
      trigger: { data: { conversation_id: 2142, latest_inbound_message_id: 990102 } },
    }, {
      simulation: false,
      execution: { clinic_id: 66, trigger_entity_type: 'appointment', trigger_entity_id: 74974 },
    });
    assert.equal(result.output.status, 'suppressed_human_reply');
    assert.equal(result.output.human_message_id, 990103);
    assert.equal(result.next_node_id, 'N37');
  } finally {
    db.sequelize.query = originalQuery;
  }

  const status = await flowEngine._processNode(nodes.get('N37'), {
    appointment: { id: 74974, estado: 'info_enviada' },
  }, { simulation: true });
  assert.equal(status.context_patch.appointment.estado, 'info_confirmada');
}

async function run() {
  const nodes = await loadNodes();
  await verifyTemporalRoutes(nodes);
  await verifyTimeouts(nodes);
  await verifyLowConfidence(nodes);
  await verifyProviderFailure(nodes);
  await verifyHumanInterruption(nodes);
  console.log('appointment_data_v16_completion_matrix.test.js OK');
}

run().then(async () => {
  await db.sequelize.close();
  process.exit(0);
}).catch(async (error) => {
  console.error(error);
  try { await db.sequelize.close(); } catch {}
  process.exit(1);
});
