'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  CLASSIFY_INTENT_PRESET_CONFIG,
  CLASSIFY_INTENT_REFERENCE_INSTRUCTION,
  buildClassifyIntentInstruction,
  projectClassifyIntentReferenceOutput,
  cloneClassifyIntentPresetConfig,
} = require('../../lib/automation-intent-contract');

test('the current preset includes reference grounding without duplicating it at runtime', () => {
  const instruction = CLASSIFY_INTENT_PRESET_CONFIG.instruction;
  assert(instruction.includes(CLASSIFY_INTENT_REFERENCE_INSTRUCTION));
  assert.equal(buildClassifyIntentInstruction(instruction), instruction);
  assert.equal(buildClassifyIntentInstruction(buildClassifyIntentInstruction(instruction)), instruction);
});

test('a destructive classification without its AI evidence goes to review, regardless of confidence', () => {
  for (const [intent, signal] of [
    ['cancelar_cita', 'rechaza_asistir_o_pide_cancelar'],
    ['solicitar_cambio_cita', 'pide_modificar_cita_existente'],
  ]) {
    for (const [evidence, confidence] of [[false,0.99], [undefined,undefined], [true,undefined], [true,0.4]]) {
      const result = projectClassifyIntentReferenceOutput({
        intencion_principal: intent, [signal]: evidence, confianza: 0.99,
        [`confianza_${signal}`]: confidence,
        confianza_intencion_principal: 0.99, accion_inequivoca: true, necesita_respuesta: false,
      });
      assert.equal(result.intencion_principal, 'otra');
      assert.equal(result.confianza_intencion_principal, 0);
      assert.equal(result.accion_inequivoca, false);
      assert.equal(result.necesita_respuesta, true);
      assert.equal(result._ai_reference_inconsistent, true);
    }
    const explicit = { intencion_principal:intent, [signal]:true, [`confianza_${signal}`]:0.99,
      hay_asunto_por_resolver:false, confianza_hay_asunto_por_resolver:0.99,
      necesita_respuesta:false, confianza:0.99 };
    assert.deepEqual(projectClassifyIntentReferenceOutput(explicit), explicit);
  }
});

test('an independently identified unresolved matter preserves the native pending-response signal', () => {
  assert.equal(projectClassifyIntentReferenceOutput({
    intencion_principal:'otra', necesita_respuesta:false, hay_asunto_por_resolver:true, confianza_hay_asunto_por_resolver:0.99,
  }).necesita_respuesta, true);
  assert.equal(projectClassifyIntentReferenceOutput({
    intencion_principal:'otra', necesita_respuesta:true, hay_asunto_por_resolver:false, confianza_hay_asunto_por_resolver:0.99,
  }).necesita_respuesta, false);
  assert.equal(projectClassifyIntentReferenceOutput({
    intencion_principal:'otra', necesita_respuesta:false, hay_asunto_por_resolver:false, confianza_hay_asunto_por_resolver:0.1,
  }).necesita_respuesta, true);
});

test('old and customized preset instructions retain their text and receive the same grounding', () => {
  for (const instruction of ['Clasifica la intencion del paciente.', 'Analiza la respuesta con los parametros de esta clinica.']) {
    const result = buildClassifyIntentInstruction(instruction);
    assert(result.startsWith(instruction + ' '));
    assert(result.endsWith(CLASSIFY_INTENT_REFERENCE_INSTRUCTION));
    assert.equal(buildClassifyIntentInstruction(result), result);
  }
});

test('the real classification node adds grounding once and preserves legacy output columns', async () => {
  const engine = require('../../services/flowEngineV2.service');
  const ai = require('../../services/aiOrchestrator.service');
  const original = ai.analyzeStructured;
  const fields = [
    { name: 'intencion_principal', type: 'string' },
    { name: 'confianza', type: 'number' },
    { name: 'accion_inequivoca', type: 'boolean' },
    { name: 'necesita_respuesta', type: 'boolean' },
    { name: 'motivo', type: 'string' },
  ];
  const calls = [];
  ai.analyzeStructured = async request => {
    calls.push(request);
    return { intencion_principal: 'otra', confianza: 0.93, accion_inequivoca: false,
      necesita_respuesta: true, motivo: 'La negativa responde a la ayuda para llegar.',
      asunto_preguntado: 'Indicaciones', significado_de_respuesta: 'Necesita aclaracion sobre como llegar.',
      _ai_provider: 'bedrock_test' };
  };
  try {
    for (const config of [
      { preset_key: 'classify_intent', instruction: 'Clasifica la intencion del paciente.',
        context_sources: [{ key: 'patient_message_batch', path: '{{last_response_context}}' }], output_fields: fields },
      cloneClassifyIntentPresetConfig(),
    ]) {
      const result = await engine._processNode({ id: 'AI', type: 'condition/ai_analysis', config,
        outputs: { on_success: 'COMPARE', on_fail: 'REVIEW' } }, {
        last_response_context: { response_text: 'No', listened_message_preview: 'Sabes llegar? Necesitas alguna indicacion?' },
        appointment: { estado: 'recordatorio_confirmado', inicio: '2026-10-02T08:00:00Z',
          qa_internal_data: 'APPOINTMENT_CONTEXT_MUST_NOT_ENTER_THE_MODEL' },
        trigger: { data: { qa_internal_data: 'TRIGGER_CONTEXT_MUST_NOT_ENTER_THE_MODEL' } },
      }, { simulation: false });
      assert.equal(result.kind, 'success');
      assert.equal(result.next_node_id, 'COMPARE');
      assert.equal(result.output.intencion_principal, 'otra');
      assert.equal(result.output._ai_provider, 'bedrock_test');
      assert(!Object.hasOwn(result.output, 'asunto_preguntado'));
      assert(!Object.hasOwn(result.output, 'significado_de_respuesta'));
    }
    assert.equal(calls.length, 2);
    assert(calls[0].prompt.startsWith('Clasifica la intencion del paciente.'));
    for (const request of calls) {
      assert.equal(request.prompt.split(CLASSIFY_INTENT_REFERENCE_INSTRUCTION).length - 1, 1);
      assert.match(request.inputText, /Sabes llegar\? Necesitas alguna indicacion\?/);
      assert.match(request.inputText, /"response_text":"No"/);
      assert.doesNotMatch(request.inputText, /APPOINTMENT_CONTEXT_MUST_NOT_ENTER_THE_MODEL|TRIGGER_CONTEXT_MUST_NOT_ENTER_THE_MODEL/);
      assert.equal(request.inputText.split('patient_message_batch:').length - 1, 1);
      assert.deepEqual(Object.keys(request.outputFormat).slice(0, 2), ['asunto_preguntado', 'significado_de_respuesta']);
    }
    assert.equal(calls[0].outputFormat.accion_inequivoca, 'boolean');
    assert.equal(calls[0].outputFormat.confianza, 'number');
  } finally { ai.analyzeStructured = original; }
});

test('custom recipes do not receive appointment intent instructions', async () => {
  const engine = require('../../services/flowEngineV2.service');
  const ai = require('../../services/aiOrchestrator.service');
  const original = ai.analyzeStructured;
  let request;
  ai.analyzeStructured = async value => { request = value; return { resultado: 'correcto' }; };
  try {
    await engine._processNode({ id: 'CUSTOM', type: 'condition/ai_analysis', config: {
      preset_key: 'custom', instruction: 'Valora esta respuesta.',
      context_sources: [{ key: 'respuesta', path: '{{last_response}}' }],
      output_fields: [{ name: 'resultado', type: 'string' }],
    }, outputs: { on_success: null, on_fail: null } }, { last_response: 'Un texto de prueba.' }, { simulation: false });
    assert.equal(request.prompt, 'Valora esta respuesta.');
    assert(!request.prompt.includes(CLASSIFY_INTENT_REFERENCE_INSTRUCTION));
  } finally { ai.analyzeStructured = original; }
});

test('classification keeps the ordered batch and reaction reference without historical echoes', async () => {
  const engine = require('../../services/flowEngineV2.service');
  const ai = require('../../services/aiOrchestrator.service');
  const original = ai.analyzeStructured;
  let request;
  ai.analyzeStructured = async value => {
    request = value;
    return { intencion_principal: 'otra', necesita_respuesta: true };
  };
  try {
    await engine._processNode({ id: 'BATCH', type: 'condition/ai_analysis',
      config: cloneClassifyIntentPresetConfig(), outputs: { on_success: null } }, {
      last_prompt: 'OLDER_REFERENCE',
      conversation_today: '[02/10/2026, 08:10] Paciente: HISTORICAL_ECHO_MUST_NOT_ENTER_THE_MODEL',
      last_response_context: {
        response_message_id: 99001,
        response_text: 'No es necesario\nYa he ido varias veces',
        response_lines: ['No es necesario', 'Ya he ido varias veces'],
        response_items: [
          { content_type: 'text', text: 'No es necesario' },
          { content_type: 'text', text: 'Ya he ido varias veces' },
          { content_type: 'attachment', content_available: false, media_kind: 'sticker' },
        ],
        listened_message_preview: 'Necesitas indicaciones?',
        reaction_emoji: '\u{1f44d}',
        reaction_target_message_preview: 'Confirmas tu asistencia?',
      },
    }, { simulation: false });
    const batch = JSON.parse(request.inputText.split('patient_message_batch:')[1].trim());
    assert.deepEqual(batch.response_messages, [{ text: 'No es necesario' }, { text: 'Ya he ido varias veces' }]);
    assert.equal(batch.response_items.length, 1);
    assert.equal(batch.response_items[0].content_available, false);
    assert.equal(batch.reaction_emoji, '\u{1f44d}');
    assert(!Object.hasOwn(batch, 'reaction_target_message_preview'));
    assert(!Object.hasOwn(batch, 'listened_message_preview'));
    assert.equal(request.inputText.split('Confirmas tu asistencia?').length - 1, 1);
    assert.match(request.inputText, /^clinic_message_replied_to:/);
    assert.doesNotMatch(request.inputText, /HISTORICAL_ECHO|OLDER_REFERENCE/);
    assert.equal(request.inputText.split('No es necesario').length - 1, 1);
  } finally { ai.analyzeStructured = original; }
});

test('classification preserves a single text item even when response_text is absent', async () => {
  const engine = require('../../services/flowEngineV2.service');
  const ai = require('../../services/aiOrchestrator.service');
  const original = ai.analyzeStructured;
  let request;
  ai.analyzeStructured = async value => { request = value; return { intencion_principal: 'otra' }; };
  try {
    await engine._processNode({ id: 'SINGLE', type: 'condition/ai_analysis',
      config: cloneClassifyIntentPresetConfig(), outputs: { on_success: null } }, {
      last_response_context: {
        response_message_id: 99001,
        listened_message_preview: 'Necesitas indicaciones?',
        response_items: [{ content_type: 'text', text: 'No las necesito, gracias.' }],
      },
    }, { simulation: false });
    assert.match(request.inputText, /No las necesito, gracias/);
    assert.equal(request.inputText.split('No las necesito, gracias').length - 1, 1);
  } finally { ai.analyzeStructured = original; }
});
