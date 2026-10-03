#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const flowEngine = require('../../services/flowEngineV2.service');
const {
  CLASSIFY_INTENT_PRESET_CONFIG,
  CLASSIFY_INTENT_REFERENCE_FIELDS,
  CONFIRM_APPOINTMENT_ANALYSIS_FIELDS,
  CONFIRM_APPOINTMENT_PRESET_CONTRACT_VERSION,
  CONFIRM_APPOINTMENT_DECISION_TEMPLATE,
  CONFIRM_APPOINTMENT_PRESET_CONFIG,
  RESPONSE_NEED_CONFIDENCE_THRESHOLD,
  cloneConfirmAppointmentDecisionConfig,
  cloneClassifyIntentPresetConfig,
  cloneConfirmAppointmentPresetConfig,
} = require('../../lib/automation-intent-contract');

const fields = [
  {
    name: 'intencion',
    type: 'string',
    description: 'Clasifica la intención.',
    allowed_values: ['confirmar', 'cancelar', 'confirmar'],
    include_confidence: true,
  },
  {
    name: 'requiere_respuesta',
    type: 'boolean',
    description: 'Indica si recepción debe responder.',
    allowed_values: ['invalid-for-boolean'],
    include_confidence: false,
  },
];

const normalizedFields = flowEngine.normalizeOutputFieldEntries(fields);
assert.deepEqual(normalizedFields[0].allowed_values, ['confirmar', 'cancelar']);
assert.equal(normalizedFields[0].include_confidence, true);
assert.deepEqual(normalizedFields[1].allowed_values, []);

assert.deepEqual(flowEngine.normalizeOutputFieldsToFormat(fields), {
  intencion: { type: 'string' },
  requiere_respuesta: { type: 'boolean' },
  confianza_intencion: { type: 'number' },
});

const valid = flowEngine.normalizeConfiguredAiOutput({
  intencion: 'confirmar',
  requiere_respuesta: false,
  confianza_intencion: 1.4,
}, fields);
assert.equal(valid.intencion, 'confirmar');
assert.equal(valid.confianza_intencion, 1);
assert.equal(valid._ai_contract_invalid_fields, undefined);

const invalid = flowEngine.normalizeConfiguredAiOutput({
  intencion: 'inventado',
  confianza: 0.81,
}, fields);
assert.equal(invalid.intencion, '');
assert.equal(invalid.confianza_intencion, 0.81);
assert.deepEqual(invalid._ai_contract_invalid_fields, ['intencion']);

const prompt = flowEngine.buildAiSystemPrompt(
  { intencion: 'string', confianza_intencion: 'number' },
  normalizedFields,
);

assert.match(
  prompt,
  /Aceptar una propuesta para programar una cita nueva[\s\S]*intencion_principal=otra[\s\S]*nunca confirma, cancela ni solicita cambiar una cita existente/,
  'the shared AI contract must not turn a lead scheduling request into an appointment confirmation',
);
assert.match(prompt, /valores de respuesta exactos: confirmar, cancelar/);
assert.match(prompt, /confianza_intencion como número entre 0 y 1/);
assert.match(prompt, /no representa la probabilidad de true/);
assert.match(prompt, /no puede atribuir al paciente una pregunta, peticion, comentario o hecho que no aparezca en el lote actual/);
assert.match(prompt, /requiere_respuesta=true o necesita_respuesta=true[\s\S]*contenido real del lote/);

assert.equal(CLASSIFY_INTENT_PRESET_CONFIG.output_fields.length, 5);
assert.equal(
  CLASSIFY_INTENT_PRESET_CONFIG.output_fields.some((field) => field.name === 'accion_inequivoca'),
  false,
);
assert.equal(
  CLASSIFY_INTENT_PRESET_CONFIG.output_fields.some((field) => field.name === 'confianza'),
  false,
);
assert.equal(
  CLASSIFY_INTENT_PRESET_CONFIG.output_fields.every((field) => field.include_confidence === true),
  true,
);
assert.match(CLASSIFY_INTENT_PRESET_CONFIG.instruction, /todavía no puede confirmar/);
assert.match(CLASSIFY_INTENT_PRESET_CONFIG.instruction, /solicitar_cambio_cita solo cuando/);
assert.match(CLASSIFY_INTENT_PRESET_CONFIG.instruction, /reacción positiva/);
assert.match(CLASSIFY_INTENT_PRESET_CONFIG.instruction, /"sí podré ir" es una afirmación declarativa y no una pregunta/i);
assert.match(CLASSIFY_INTENT_PRESET_CONFIG.instruction, /Debes poder señalar esa evidencia; no inventes una necesidad de respuesta/);
assert.match(CLASSIFY_INTENT_PRESET_CONFIG.instruction, /Evalúa posible_urgencia de forma independiente a la intención principal/);

assert.equal(CONFIRM_APPOINTMENT_PRESET_CONFIG.preset_contract_version, 4);
assert.equal(CONFIRM_APPOINTMENT_PRESET_CONFIG.preset_contract_version, CONFIRM_APPOINTMENT_PRESET_CONTRACT_VERSION);
assert.deepEqual(
  CONFIRM_APPOINTMENT_PRESET_CONFIG.output_fields.map((field) => field.name),
  ['confirma_asistencia', 'requiere_respuesta', 'motivo'],
);
assert.equal(
  CONFIRM_APPOINTMENT_PRESET_CONFIG.output_fields.every((field) => field.include_confidence === true),
  true,
);
assert.equal(CONFIRM_APPOINTMENT_PRESET_CONFIG.context_sources[0].key, 'patient_message_batch');
assert.deepEqual(
  CONFIRM_APPOINTMENT_PRESET_CONFIG.context_sources.map((source) => source.key),
  ['patient_message_batch', 'appointment', 'trigger'],
);
assert.doesNotMatch(CONFIRM_APPOINTMENT_PRESET_CONFIG.instruction, /Usa conversation_today/);
assert.doesNotMatch(CONFIRM_APPOINTMENT_PRESET_CONFIG.instruction, /tengo que llevar algo/i);
assert.match(CONFIRM_APPOINTMENT_PRESET_CONFIG.instruction, /No uses mensajes históricos/);
assert.match(CONFIRM_APPOINTMENT_PRESET_CONFIG.instruction, /conserva la señal afirmativa[\s\S]*requiere_respuesta=true/);
assert.match(CONFIRM_APPOINTMENT_PRESET_CONFIG.instruction, /lectura_confirmacion=decision_condicionada o incierta/);
assert.match(CONFIRM_APPOINTMENT_PRESET_CONFIG.instruction, /requiere_respuesta=false/);
assert.match(CONFIRM_APPOINTMENT_PRESET_CONFIG.instruction, /reacción positiva vinculada al mensaje de confirmación/);
assert.match(CONFIRM_APPOINTMENT_PRESET_CONFIG.instruction, /no la deduzcas de un agradecimiento final/);
const classifierPrompt = flowEngine.buildAiSystemPrompt({}, CLASSIFY_INTENT_REFERENCE_FIELDS, 'classify_intent');
assert.doesNotMatch(classifierPrompt, /Una reaccion sin texto se revisa/);
assert.match(classifierPrompt, /reaccion vinculada a una peticion clara de confirmacion/);
const confirmationPrompt = flowEngine.buildAiSystemPrompt({}, CONFIRM_APPOINTMENT_ANALYSIS_FIELDS, 'confirm_appointment');
assert.match(confirmationPrompt, /Saber llegar NO es asistencia ni recepcion de datos/);
assert.match(CONFIRM_APPOINTMENT_PRESET_CONFIG.instruction, /La frase final "Nos confirmas\?" no cambia el asunto/);
for (const field of CONFIRM_APPOINTMENT_ANALYSIS_FIELDS) {
  assert(CONFIRM_APPOINTMENT_PRESET_CONFIG.instruction.includes(field.name));
  if (field.include_confidence) assert(CONFIRM_APPOINTMENT_PRESET_CONFIG.instruction.includes(`confianza_${field.name}`));
}
assert.match(CONFIRM_APPOINTMENT_PRESET_CONFIG.instruction, /no lo marques para una confirmación, acuse, saludo o agradecimiento sin nada pendiente/);
assert.deepEqual(CLASSIFY_INTENT_REFERENCE_FIELDS.filter(field =>
  ['decision_pospuesta', 'id_confirmacion_por_reaccion'].includes(field.name)).map(field => field.name),
['decision_pospuesta', 'id_confirmacion_por_reaccion']);
assert.equal(CONFIRM_APPOINTMENT_ANALYSIS_FIELDS.some(field => field.name === 'lectura_confirmacion'), true);
assert.equal(CONFIRM_APPOINTMENT_ANALYSIS_FIELDS.some(field => field.name === 'evidencia_asunto_pendiente'), true);
assert.equal(RESPONSE_NEED_CONFIDENCE_THRESHOLD, 0.75);

assert.deepEqual(
  CONFIRM_APPOINTMENT_DECISION_TEMPLATE.branches.map((branch) => branch.label),
  ['Confirma sin preguntas', 'Confirma y necesita respuesta', 'No confirma'],
);
const confirmationDecision = cloneConfirmAppointmentDecisionConfig('N18');
assert.equal(confirmationDecision.mode, 'multi_branch');
assert.equal(confirmationDecision.source_ai_node_id, 'N18');
assert.equal(confirmationDecision.fallback_label, 'Revisión necesaria');
assert.equal(
  confirmationDecision.branch_rules[1].comparison_rules[2].left_ref.path,
  'requiere_respuesta',
);
assert.equal(
  confirmationDecision.branch_rules[1].comparison_rules[2].right_value,
  true,
);
assert.equal(confirmationDecision.branch_rules[0].comparison_rules.length, 3);
assert.equal(
  confirmationDecision.branch_rules[0].comparison_rules.some((rule) => rule.left_ref.path === 'confianza_requiere_respuesta'),
  false,
);

const clonedPreset = cloneClassifyIntentPresetConfig();
clonedPreset.output_fields[0].allowed_values.push('valor_solo_en_copia');
assert.equal(
  CLASSIFY_INTENT_PRESET_CONFIG.output_fields[0].allowed_values.includes('valor_solo_en_copia'),
  false,
);

const clonedConfirmationPreset = cloneConfirmAppointmentPresetConfig();
clonedConfirmationPreset.output_fields[0].description = 'Solo en la copia';
assert.notEqual(
  CONFIRM_APPOINTMENT_PRESET_CONFIG.output_fields[0].description,
  clonedConfirmationPreset.output_fields[0].description,
);

const noSecondaryIntent = flowEngine.normalizeClassifyIntentOutput({
  intencion_principal: 'confirmar_cita',
  intencion_secundaria: 'ninguna',
  accion_inequivoca: true,
  posible_urgencia: false,
  necesita_respuesta: false,
  motivo: 'Confirmación directa.',
  confianza_intencion_principal: 0.94,
}, {});
const normalizedNoSecondaryIntent = flowEngine.normalizeConfiguredAiOutput(
  noSecondaryIntent,
  CLASSIFY_INTENT_PRESET_CONFIG.output_fields,
);
assert.equal(normalizedNoSecondaryIntent.intencion_secundaria, '');
assert.equal(normalizedNoSecondaryIntent._ai_contract_invalid_fields, undefined);
assert.equal(normalizedNoSecondaryIntent.confianza_intencion_principal, 0.94);

console.log('AI output contract: ok');
process.exit(0);
