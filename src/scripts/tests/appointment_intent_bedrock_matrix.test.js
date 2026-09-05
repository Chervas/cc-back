#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
require('dotenv').config();

const db = require('../../../models');
const flowEngine = require('../../services/flowEngineV2.service');
const {
  CLASSIFY_INTENT_PRESET_CONFIG,
  cloneClassifyIntentPresetConfig,
} = require('../../lib/automation-intent-contract');

const allowedIntents = new Set(CLASSIFY_INTENT_PRESET_CONFIG.output_fields[0].allowed_values);

function buildContext({ text, clinicText, patch = {} }) {
  const responseText = text || null;
  return {
    appointment: {
      id: 990001,
      estado: 'recordatorio_enviado',
      inicio: '2026-09-10T10:00:00.000Z',
      timezone: 'Europe/Madrid',
    },
    conversation_today: [
      { direction: 'outbound', author: 'clinic', content: clinicText },
      { direction: 'inbound', author: 'patient', content: responseText },
    ],
    last_response: responseText,
    last_response_context: {
      response_text: responseText,
      response_lines: responseText ? responseText.split(/\r?\n/).filter(Boolean) : [],
      response_message_id: 990002,
      response_message_type: 'text',
      listened_message_preview: clinicText,
      responded_at: '2026-09-09T08:00:00.000Z',
      ...patch,
    },
    trigger: {
      data: {
        channel: 'whatsapp',
        latest_inbound_message_id: 990002,
        appointment_id: 990001,
      },
    },
  };
}

function assertContract(output, name) {
  assert(allowedIntents.has(output.intencion_principal), `${name}: invalid primary intent`);
  assert(output.intencion_secundaria === '' || allowedIntents.has(output.intencion_secundaria), `${name}: invalid secondary intent`);
  assert.equal(typeof output.posible_urgencia, 'boolean', `${name}: urgency type`);
  assert.equal(typeof output.necesita_respuesta, 'boolean', `${name}: response type`);
  for (const field of CLASSIFY_INTENT_PRESET_CONFIG.output_fields) {
    if (!field.include_confidence) continue;
    const confidence = output[`confianza_${field.name}`];
    assert.equal(typeof confidence, 'number', `${name}: confidence type for ${field.name}`);
    assert(confidence >= 0 && confidence <= 1, `${name}: confidence range for ${field.name}`);
  }
  assert.equal(output._ai_provider, 'bedrock', `${name}: provider`);
  assert.equal(output._ai_simulated, undefined, `${name}: must use the real provider`);
}

async function run() {
  const defaultQuestion = '¿Nos confirmas tu asistencia a la cita de mañana?';
  const cases = [
    { name: 'plain confirmation', text: 'Sí, confirmo.', expected: ['confirmar_cita'], needsResponse: false },
    { name: 'contextual ok', text: 'ok', expected: ['confirmar_cita'], needsResponse: false },
    { name: 'positive emoji', text: '👍🏽', expected: ['confirmar_cita'], needsResponse: false },
    { name: 'contextual thanks', text: 'Gracias', expected: ['confirmar_cita'], needsResponse: false },
    { name: 'confirmation and question', text: 'Confirmado. ¿Podéis darme la dirección?', expected: ['confirmar_cita'], secondary: 'pregunta', needsResponse: true },
    { name: 'clear cancellation', text: 'No puedo asistir, cancelad la cita por favor.', expected: ['cancelar_cita'] },
    { name: 'reschedule request', text: 'No puedo asistir, ¿podemos cambiarla al martes?', expected: ['solicitar_cambio_cita'], needsResponse: true },
    { name: 'question only', text: '¿Podéis darme la dirección?', expected: ['pregunta'], needsResponse: true },
    { name: 'possible urgency and cancellation', text: 'Tengo un sangrado intenso y quiero cancelar la cita.', expected: ['cancelar_cita'], possibleUrgency: true, needsResponse: true },
    { name: 'negated confirmation', text: 'Todavía no puedo confirmar.', expected: ['otra'], needsResponse: true },
    { name: 'questioned ok', text: 'ok?', expected: ['pregunta'], needsResponse: true },
    {
      name: 'access acknowledgement',
      text: 'Sí, sé llegar, gracias.',
      clinicText: '¿Sabes llegar a la clínica para tu cita de hoy?',
      expected: ['confirmar_cita', 'agradecimiento'],
      needsResponse: false,
    },
  ];
  const node = {
    id: 'N-bedrock-qa',
    type: 'condition/ai_analysis',
    config: cloneClassifyIntentPresetConfig({ mode: 'auto', max_tokens: 700 }),
    outputs: { on_success: null, on_fail: null },
  };
  const results = [];

  for (const scenario of cases) {
    const result = await flowEngine._processNode(
      node,
      buildContext({
        text: scenario.text,
        clinicText: scenario.clinicText || defaultQuestion,
        patch: scenario.patch,
      }),
      { simulation: false },
    );
    assert.equal(result.kind, 'success', `${scenario.name}: execution`);
    const output = result.output;
    assertContract(output, scenario.name);
    assert(scenario.expected.includes(output.intencion_principal), `${scenario.name}: ${output.intencion_principal}`);
    if (scenario.secondary) assert.equal(output.intencion_secundaria, scenario.secondary, `${scenario.name}: secondary intent`);
    if (scenario.possibleUrgency !== undefined) assert.equal(output.posible_urgencia, scenario.possibleUrgency, `${scenario.name}: urgency`);
    if (scenario.needsResponse !== undefined) assert.equal(output.necesita_respuesta, scenario.needsResponse, `${scenario.name}: response needed`);
    results.push({
      name: scenario.name,
      primary: output.intencion_principal,
      secondary: output.intencion_secundaria,
      urgency: output.posible_urgencia,
      needs_response: output.necesita_respuesta,
      confidence: output.confianza_intencion_principal,
      model: output._ai_model,
      latency_ms: output._ai_latency_ms,
    });
  }

  console.log(JSON.stringify({ cases: results.length, results }, null, 2));
}

run().then(async () => {
  try { await db.sequelize.close(); } catch (_error) {}
  process.exit(0);
}).catch(async (error) => {
  console.error(error);
  try { await db.sequelize.close(); } catch (_error) {}
  process.exit(1);
});
