#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
require('dotenv').config();

const db = require('../../../models');
const flowEngine = require('../../services/flowEngineV2.service');
const {
  cloneConfirmAppointmentPresetConfig,
} = require('../../lib/automation-intent-contract');

function buildContext({ text, clinicText, reactionEmoji = null }) {
  const isReaction = Boolean(reactionEmoji);
  return {
    appointment: {
      id: 990101,
      estado: 'info_enviada',
      inicio: '2026-09-11T18:00:00.000Z',
      timezone: 'Europe/Madrid',
    },
    conversation_today: [
      { direction: 'outbound', author: 'clinic', content: 'Mensaje de una prueba anterior.' },
      { direction: 'inbound', author: 'patient', content: 'Sí, lo he recibido, ¿tengo que llevar algo?' },
      { direction: 'outbound', author: 'clinic', content: clinicText },
      { direction: 'inbound', author: 'patient', content: text },
    ],
    last_response: isReaction ? null : text,
    last_response_context: {
      response_text: isReaction ? null : text,
      response_lines: isReaction ? [] : [text],
      response_message_id: 990102,
      response_message_type: isReaction ? 'reaction' : 'text',
      reaction_emoji: reactionEmoji,
      reaction_target_message_id: isReaction ? '990100' : null,
      reaction_target_message_type: isReaction ? 'template' : null,
      reaction_target_message_preview: isReaction ? clinicText : null,
      listened_message_preview: clinicText,
      responded_at: '2026-09-04T18:25:09.000Z',
    },
    trigger: {
      data: {
        channel: 'whatsapp',
        latest_inbound_message_id: 990102,
        appointment_id: 990101,
      },
    },
  };
}

async function run() {
  const clinicText = 'Hemos agendado tu cita para el 11/09/2026 a las 20:00. ¿Me confirmas que recibes este mensaje?';
  const cases = [
    { text: 'Sí, lo he recibido.', confirms: true, needsReply: false },
    { text: 'Sí lo he recibido, ¿tengo que llevar mi propio orinal?', confirms: true, needsReply: true },
    { text: 'No lo he recibido, ¿puedes enviármelo otra vez?', confirms: false, needsReply: true },
    { text: '¿Tengo que llevar algo?', confirms: false, needsReply: true },
    { text: 'Gracias', confirms: true, needsReply: false },
    { text: 'Reacción de WhatsApp', reactionEmoji: '❤️', confirms: true, needsReply: false },
  ];
  const node = {
    id: 'N-confirm-appointment-bedrock',
    type: 'condition/ai_analysis',
    config: cloneConfirmAppointmentPresetConfig({ mode: 'auto', max_tokens: 700 }),
    outputs: { on_success: null, on_fail: null },
  };
  const results = [];

  for (const scenario of cases) {
    const result = await flowEngine._processNode(
      node,
      buildContext({ text: scenario.text, clinicText, reactionEmoji: scenario.reactionEmoji }),
      { simulation: false },
    );
    assert.equal(result.kind, 'success', `${scenario.text}: execution`);
    assert.equal(result.output._ai_provider, 'bedrock', `${scenario.text}: provider`);
    assert.equal(result.output.confirma_asistencia, scenario.confirms, `${scenario.text}: confirmation`);
    assert.equal(result.output.requiere_respuesta, scenario.needsReply, `${scenario.text}: needs reply`);
    assert(result.output.confianza_confirma_asistencia > 0.85, `${scenario.text}: confirmation confidence`);
    assert(Number.isFinite(result.output.confianza_requiere_respuesta), `${scenario.text}: reply confidence type`);
    assert(result.output.confianza_requiere_respuesta >= 0 && result.output.confianza_requiere_respuesta <= 1, `${scenario.text}: reply confidence range`);
    if (scenario.needsReply) {
      assert(result.output.confianza_requiere_respuesta > 0.75, `${scenario.text}: actionable reply confidence`);
    }
    results.push({
      text: scenario.text,
      confirms: result.output.confirma_asistencia,
      needs_reply: result.output.requiere_respuesta,
      model: result.output._ai_model,
      latency_ms: result.output._ai_latency_ms,
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
