'use strict';

const CLASSIFY_INTENT_PRESET_KEY = 'classify_intent';
const AUTO_APPLY_CONFIDENCE_THRESHOLD = 0.85;

const CLASSIFY_INTENT_PRESET_CONFIG = Object.freeze({
  instruction: 'Clasifica exclusivamente el lote de mensajes de patient_message_batch como la nueva respuesta del paciente; usa conversation_today solo para entender a que pregunta o cita responde. No atribuyas al lote mensajes posteriores ni mensajes de la clinica. Identifica la intencion principal y, si existe, una intencion secundaria. Para una cita distingue confirmar, cancelar, solicitar un cambio, hacer una pregunta o no existir una accion inequivoca. Un agradecimiento confirma solo cuando responde de forma contextual a una peticion clara de confirmacion y no contiene una contradiccion. Si confirma y ademas pregunta, conserva ambas intenciones. Marca posible urgencia solo como senal operativa para revision humana; no diagnostiques. Devuelve exactamente los campos solicitados y un motivo breve.',
  context_sources: [
    { key: 'patient_message_batch', path: '{{last_response_context}}' },
    { key: 'conversation_today', path: '{{conversation_today}}' },
    { key: 'appointment', path: '{{appointment}}' },
    { key: 'trigger', path: '{{trigger.data}}' },
  ],
  output_fields: [
    { name: 'intencion_principal', type: 'string', description: 'confirmar_cita, cancelar_cita, solicitar_cambio_cita, pregunta, agradecimiento, urgencia_posible u otra' },
    { name: 'intencion_secundaria', type: 'string', description: 'Segunda intencion relevante o cadena vacia' },
    { name: 'confianza', type: 'number', description: 'Nivel de confianza de 0 a 1' },
    { name: 'accion_inequivoca', type: 'boolean', description: `true solo con confianza igual o superior a ${AUTO_APPLY_CONFIDENCE_THRESHOLD} y sin interpretacion adicional` },
    { name: 'posible_urgencia', type: 'boolean', description: 'true si recepcion debe revisar una posible urgencia' },
    { name: 'necesita_respuesta', type: 'boolean', description: 'true si queda una pregunta o respuesta pendiente de la clinica' },
    { name: 'motivo', type: 'string', description: 'Razon breve y operativa de la clasificacion' },
  ],
});

function cloneClassifyIntentPresetConfig(overrides = {}) {
  return {
    ...overrides,
    preset_key: CLASSIFY_INTENT_PRESET_KEY,
    instruction: CLASSIFY_INTENT_PRESET_CONFIG.instruction,
    context_sources: CLASSIFY_INTENT_PRESET_CONFIG.context_sources.map((source) => ({ ...source })),
    output_fields: CLASSIFY_INTENT_PRESET_CONFIG.output_fields.map((field) => ({ ...field })),
  };
}

module.exports = {
  AUTO_APPLY_CONFIDENCE_THRESHOLD,
  CLASSIFY_INTENT_PRESET_CONFIG,
  CLASSIFY_INTENT_PRESET_KEY,
  cloneClassifyIntentPresetConfig,
};
