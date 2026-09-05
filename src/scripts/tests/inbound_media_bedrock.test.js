'use strict';
const assert = require('node:assert/strict');
process.env.JOBS_AUTO_START = 'false';
const db = require('../../../models');
const flow = require('../../services/flowEngineV2.service');
const { formatInboundAnalysisItem } = require('../../lib/automation-conversation-context');
const { cloneConfirmAppointmentPresetConfig } = require('../../lib/automation-intent-contract');

async function main() {
  const template = await db.AutomationFlowTemplateV2.findOne({ where: {
    public_id: 'flw_c2f0858ca7e4f0ae', version: 10,
  }, raw: true });
  assert(template);
  const ai = template.nodes.find(node => node.id === 'N3');
  const router = template.nodes.find(node => node.id === 'N16');
  const clinicText = 'Te recuerdo tu cita de manana a las 17:00. Me confirmas tu asistencia?';
  const cases = [
    ...['video', 'image', 'audio', 'document', 'sticker'].map(kind => ({ kind, expected: 'review' })),
    { kind: 'video', text: 'Si, confirmo mi asistencia manana', expected: 'confirm' },
    { kind: 'video', reaction: '\u{1f44d}', expected: 'confirm' },
    { kind: 'video', text: 'Cancela mi cita, no puedo ir', expected: 'cancel' },
    { reaction: '\u{1f44d}', expected: 'confirm' },
  ];
  for (const item of cases) {
    const messages = [item.kind ? { id: 900000001, content: item.text,
      metadata: { media: { kind: item.kind } } } : (item.text ? { id: 900000001, content: item.text } : null),
    item.reaction ? { id: 900000002, message_type: 'reaction', metadata: { reaction: {
      emoji: item.reaction, target_message_id: '900000000', target_message_preview: clinicText,
    } } } : null].filter(Boolean);
    const responseText = messages
      .filter(message => message.message_type !== 'reaction')
      .map(message => String(message.content || '').trim())
      .filter(Boolean)
      .join('\n') || null;
    const responseItems = messages.map(formatInboundAnalysisItem).filter(Boolean);
    const context = {
      appointment: { estado: 'recordatorio_enviado', inicio: '2026-09-06T15:00:00Z' },
      trigger: { type: 'appointment_reminder_window', data: { qa_case: 'non_text_media', appointment_candidate_count: 1 } },
      conversation_today: '[05/09/2026, 09:00] Paciente: Confirmo una cita anterior',
      last_response: responseText,
      last_response_context: { response_message_id: 900000001, response_text: responseText,
        response_lines: responseText ? responseText.split('\n') : [], response_items: responseItems,
        response_message_type: item.reaction ? 'reaction' : 'text',
        response_media_kind: item.reaction ? null : item.kind || null,
        reaction_emoji: item.reaction || null, reaction_target_message_id: item.reaction ? '900000000' : null,
        reaction_target_message_type: item.reaction ? 'template' : null,
        reaction_target_message_preview: item.reaction ? clinicText : null,
        listened_message_preview: clinicText },
    };
    const result = await flow._processNode(ai, context, { simulation: false });
    assert.equal(result.kind, 'success');
    assert.equal(result.output._ai_provider, 'bedrock');
    const route = await flow._processNode(router, { outputs: { N3: result.output } }, { simulation: true });
    if (item.expected === 'review') {
      assert(['N33', 'N6'].includes(route.next_node_id), JSON.stringify({ item, output: result.output, route }));
      assert.notEqual(result.output.intencion_principal, 'confirmar_cita');
      assert.equal(result.output.necesita_respuesta, true);
    } else if (item.expected === 'confirm') {
      assert(['N13', 'N17'].includes(route.next_node_id), JSON.stringify({ item, output: result.output, route }));
    } else {
      assert.equal(route.next_node_id, 'N20', JSON.stringify({ item, output: result.output, route }));
    }
    console.log(JSON.stringify({ case: item, intent: result.output.intencion_principal,
      needsReply: result.output.necesita_respuesta, confidence: result.output.confianza_intencion_principal,
      next: route.next_node_id, reason: result.output.motivo, provider: result.output._ai_provider }));
  }
  const receiptNode = { id: 'QA_RECEIPT', type: 'condition/ai_analysis',
    config: cloneConfirmAppointmentPresetConfig({ mode: 'auto', max_tokens: 700 }), outputs: {} };
  for (const kind of ['video', 'image']) {
    const responseItems = [formatInboundAnalysisItem({ id: 900000001, metadata: { media: { kind } } })];
    const result = await flow._processNode(receiptNode, {
      appointment: { estado: 'info_enviada', inicio: '2026-09-11T18:00:00Z' },
      trigger: { type: 'appointment_created', data: { qa_case: 'non_text_receipt' } },
      last_response: null,
      last_response_context: { response_message_id: 900000001, response_text: null,
        response_lines: [], response_items: responseItems, reaction_emoji: null, reaction_target_message_id: null,
        reaction_target_message_type: null, reaction_target_message_preview: null,
        response_message_type: 'text', response_media_kind: kind,
        listened_message_preview: 'Te enviamos los datos de tu cita para el 11 de septiembre. Me confirmas que recibes este mensaje?' },
    }, { simulation: false });
    assert.equal(result.kind, 'success');
    assert.equal(result.output._ai_provider, 'bedrock');
    assert.equal(result.output.confirma_asistencia, false, JSON.stringify(result.output));
    assert.equal(result.output.requiere_respuesta, true, JSON.stringify(result.output));
    console.log(JSON.stringify({ case: `receipt_${kind}`, confirms: result.output.confirma_asistencia,
      needsReply: result.output.requiere_respuesta, reason: result.output.motivo }));
  }
}
main().then(async () => { await db.sequelize.close(); process.exit(0); })
  .catch(async error => { console.error(error); await db.sequelize.close(); process.exit(1); });
