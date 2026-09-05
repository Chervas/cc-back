'use strict';

const CLASSIFY_INTENT_PRESET_KEY = 'classify_intent';
const CONFIRM_APPOINTMENT_PRESET_KEY = 'confirm_appointment';
const CONFIRM_APPOINTMENT_PRESET_CONTRACT_VERSION = 2;
const CONFIRM_APPOINTMENT_DECISION_TEMPLATE_KEY = 'confirm_appointment_v2';
const AUTO_APPLY_CONFIDENCE_THRESHOLD = 0.85;
const RESPONSE_NEED_CONFIDENCE_THRESHOLD = 0.75;

const CONFIRM_APPOINTMENT_PRESET_CONFIG = Object.freeze({
  preset_contract_version: CONFIRM_APPOINTMENT_PRESET_CONTRACT_VERSION,
  instruction: 'Analiza exclusivamente patient_message_batch como la respuesta nueva del paciente a la petición de confirmación del último mensaje de la clínica sobre una cita. El propio patient_message_batch incluye el mensaje concreto de la clínica al que responde el paciente; usa appointment y trigger únicamente como contexto de esa cita. No uses mensajes anteriores de la conversación ni atribuyas al lote preguntas o comentarios previos. Primero identifica qué pidió confirmar la clínica. Si preguntó si el paciente asistirá, confirma_asistencia=true significa que acepta asistir. Si preguntó si recibió el mensaje o los datos de la cita enviados al agendarla, confirma_asistencia=true significa que confirma esa recepción, sin afirmar por ello que asistirá. Evalúa confirma_asistencia y requiere_respuesta de forma independiente recorriendo todo el lote: una pregunta o petición posterior nunca borra una confirmación explícita anterior, salvo que exista una contradicción posterior. Ejemplos obligatorios: "sí, lo he recibido, ¿tengo que llevar algo?" devuelve confirma_asistencia=true y requiere_respuesta=true; "¿tengo que llevar algo?" sin afirmación previa en el lote devuelve confirma_asistencia=false y requiere_respuesta=true; "gracias", "ok", "vale" o "recibido" como respuesta directa a una petición clara de confirmar recepción devuelve confirma_asistencia=true y requiere_respuesta=false. Una respuesta breve afirmativa, un agradecimiento, un acuse o una reacción positiva como 👍, ❤️, ✅, ok, vale, gracias o recibido confirma únicamente si responde directamente a cualquiera de esas peticiones y no existe una contradicción. Si patient_message_batch indica response_message_type=reaction y contiene una reacción positiva vinculada al mensaje de confirmación, devuelve confirma_asistencia=true y requiere_respuesta=false: la reacción es el acuse, no una pregunta ni una petición. Devuelve confirma_asistencia=false cuando no confirma lo que la clínica preguntó, lo rechaza, solicita cambiar la cita, expresa dudas, todavía no puede confirmar, solo hace una pregunta o responde sobre otro asunto. Evalúa por separado requiere_respuesta: devuelve true únicamente si el lote contiene una pregunta, petición concreta o comentario que exige una actuación o contestación de la clínica. Si dudas de que no haga falta contestar, devuelve requiere_respuesta=true para conservar la revisión humana. Devuelve requiere_respuesta=false para agradecimientos, saludos, confirmaciones, acuses de recibo o comentarios de cortesía sin pregunta ni petición, aunque una persona pudiera responder por educación. Un mensaje compuesto como "confirmo, ¿tengo que llevar algo?" sí requiere respuesta; "gracias", "ok gracias", "recibido" o una reacción positiva aislada no. La confianza de cada campo mide la certeza de que el valor concreto devuelto es correcto: si un booleano es false y estás seguro de ese false, su confianza debe ser alta. No uses la confianza como probabilidad de que el booleano sea true. No clasifiques el tipo de cancelación o cambio ni ejecutes acciones. Devuelve exactamente los campos solicitados, la confianza individual de cada campo y un motivo breve.',
  context_sources: [
    { key: 'patient_message_batch', path: '{{last_response_context}}' },
    { key: 'appointment', path: '{{appointment}}' },
    { key: 'trigger', path: '{{trigger.data}}' },
  ],
  output_fields: [
    {
      name: 'confirma_asistencia',
      type: 'boolean',
      description: 'Indica si el paciente confirma de forma clara lo que preguntó la clínica: asistencia cuando se pidió confirmar que acudirá, o recepción cuando se pidió confirmar los datos enviados. Una pregunta aislada sin afirmación en el lote devuelve false; conserva un true explícito aunque después añada una pregunta, salvo contradicción',
      include_confidence: true,
    },
    {
      name: 'requiere_respuesta',
      type: 'boolean',
      description: 'Devuelve true si el paciente formula una pregunta, petición concreta o comentario que exige actuación o respuesta, y también si existe duda sobre si hace falta contestar; devuelve false solo para gracias, saludos, confirmaciones, acuses o reacciones positivas aisladas sin ninguna petición pendiente',
      include_confidence: true,
    },
    {
      name: 'motivo',
      type: 'string',
      description: 'Explica brevemente qué parte de la respuesta justifica ambos resultados, sin datos clínicos innecesarios',
      include_confidence: true,
    },
  ],
});

const CONFIRM_APPOINTMENT_DECISION_TEMPLATE = Object.freeze({
  key: CONFIRM_APPOINTMENT_DECISION_TEMPLATE_KEY,
  label: 'Comparar resultado',
  fallback_label: 'Revisión necesaria',
  branches: [
    {
      id: 'branch_confirm_without_reply',
      label: 'Confirma sin preguntas',
      conditions: [
        { field: 'confirma_asistencia', value_type: 'boolean', operator: 'equals', right_value: true },
        { field: 'confianza_confirma_asistencia', value_type: 'number', operator: 'greater_than', right_value: AUTO_APPLY_CONFIDENCE_THRESHOLD },
        { field: 'requiere_respuesta', value_type: 'boolean', operator: 'equals', right_value: false },
      ],
    },
    {
      id: 'branch_confirm_needs_reply',
      label: 'Confirma y necesita respuesta',
      conditions: [
        { field: 'confirma_asistencia', value_type: 'boolean', operator: 'equals', right_value: true },
        { field: 'confianza_confirma_asistencia', value_type: 'number', operator: 'greater_than', right_value: AUTO_APPLY_CONFIDENCE_THRESHOLD },
        { field: 'requiere_respuesta', value_type: 'boolean', operator: 'equals', right_value: true },
        { field: 'confianza_requiere_respuesta', value_type: 'number', operator: 'greater_than', right_value: RESPONSE_NEED_CONFIDENCE_THRESHOLD },
      ],
    },
    {
      id: 'branch_not_confirmed',
      label: 'No confirma',
      conditions: [
        { field: 'confirma_asistencia', value_type: 'boolean', operator: 'equals', right_value: false },
        { field: 'confianza_confirma_asistencia', value_type: 'number', operator: 'greater_than', right_value: AUTO_APPLY_CONFIDENCE_THRESHOLD },
      ],
    },
  ],
});

function cloneConfirmAppointmentDecisionConfig(sourceNodeId, overrides = {}) {
  const normalizedSourceNodeId = String(sourceNodeId || '').trim();
  if (!normalizedSourceNodeId) {
    throw new Error('confirm_appointment_decision_source_required');
  }
  return {
    ...overrides,
    mode: 'multi_branch',
    ai_decision_template_key: CONFIRM_APPOINTMENT_DECISION_TEMPLATE.key,
    source_ai_node_id: normalizedSourceNodeId,
    display_label: `${CONFIRM_APPOINTMENT_DECISION_TEMPLATE.label} de ${normalizedSourceNodeId}`,
    fallback_label: CONFIRM_APPOINTMENT_DECISION_TEMPLATE.fallback_label,
    branch_rules: CONFIRM_APPOINTMENT_DECISION_TEMPLATE.branches.map((branch) => ({
      id: branch.id,
      label: branch.label,
      comparison_rules: branch.conditions.map((condition, index) => ({
        id: `rule_${index + 1}`,
        connector: index === 0 ? null : 'and',
        left_ref: {
          source: 'node_output',
          node_id: normalizedSourceNodeId,
          path: condition.field,
          value_type: condition.value_type,
          label: condition.field,
        },
        operator: condition.operator,
        right_value: condition.right_value,
      })),
    })),
  };
}

const CLASSIFY_INTENT_PRESET_CONFIG = Object.freeze({
  instruction: 'Clasifica exclusivamente el lote de mensajes de patient_message_batch como la nueva respuesta del paciente. conversation_today esta limitado al mensaje de la clinica al que responde y al mismo lote actual; usalo solo para entender a que pregunta o cita responde. No atribuyas al lote mensajes historicos, posteriores ni mensajes de la clinica. Identifica la intencion principal y, si existe, una intencion secundaria. Para una cita distingue confirmar, cancelar, solicitar un cambio, hacer una pregunta o no existir una accion clara. Expresar incertidumbre, decir que todavia no puede confirmar o pedir tiempo para decidir no significa cancelar ni solicitar un cambio: clasificalo como otra y marca necesita_respuesta=true. Usa solicitar_cambio_cita solo cuando el paciente pide explicitamente mover, reagendar o buscar otra fecha u hora. Usa cancelar_cita cuando pide cancelar o afirma de forma inequivoca que no asistira sin pedir una nueva fecha. Un agradecimiento confirma solo cuando responde de forma contextual a una peticion clara de confirmacion y no contiene una contradiccion. Si confirma y ademas pregunta, conserva ambas intenciones. Marca posible urgencia solo como senal operativa para revision humana; no diagnostiques. Devuelve exactamente los campos solicitados, la confianza individual solicitada para cada campo y un motivo breve.',
  context_sources: [
    { key: 'patient_message_batch', path: '{{last_response_context}}' },
    { key: 'conversation_today', path: '{{conversation_today}}' },
    { key: 'appointment', path: '{{appointment}}' },
    { key: 'trigger', path: '{{trigger.data}}' },
  ],
  output_fields: [
    {
      name: 'intencion_principal',
      type: 'string',
      description: 'Clasifica la intencion principal usando uno de los valores de respuesta. Una duda o la imposibilidad temporal de confirmar es otra; solicitar_cambio_cita exige una peticion explicita de nueva fecha u hora',
      allowed_values: ['confirmar_cita', 'cancelar_cita', 'solicitar_cambio_cita', 'pregunta', 'agradecimiento', 'urgencia_posible', 'otra'],
      include_confidence: true,
    },
    {
      name: 'intencion_secundaria',
      type: 'string',
      description: 'Clasifica otra intencion relevante con los mismos valores; devuelve ninguna si no existe',
      allowed_values: ['confirmar_cita', 'cancelar_cita', 'solicitar_cambio_cita', 'pregunta', 'agradecimiento', 'urgencia_posible', 'otra', 'ninguna'],
      include_confidence: true,
    },
    {
      name: 'posible_urgencia',
      type: 'boolean',
      description: 'Indica si recepcion debe revisar una posible urgencia; no realiza diagnosticos',
      include_confidence: true,
    },
    {
      name: 'necesita_respuesta',
      type: 'boolean',
      description: 'Indica si queda una pregunta, peticion o comentario pendiente de la clinica',
      include_confidence: true,
    },
    {
      name: 'motivo',
      type: 'string',
      description: 'Razon breve y operativa de la clasificacion sin datos clinicos innecesarios',
      include_confidence: true,
    },
  ],
});

function cloneClassifyIntentPresetConfig(overrides = {}) {
  return {
    ...overrides,
    preset_key: CLASSIFY_INTENT_PRESET_KEY,
    instruction: CLASSIFY_INTENT_PRESET_CONFIG.instruction,
    context_sources: CLASSIFY_INTENT_PRESET_CONFIG.context_sources.map((source) => ({ ...source })),
    output_fields: CLASSIFY_INTENT_PRESET_CONFIG.output_fields.map((field) => ({
      ...field,
      ...(Array.isArray(field.allowed_values)
        ? { allowed_values: [...field.allowed_values] }
        : {}),
    })),
  };
}

function cloneConfirmAppointmentPresetConfig(overrides = {}) {
  return {
    ...overrides,
    preset_key: CONFIRM_APPOINTMENT_PRESET_KEY,
    preset_contract_version: CONFIRM_APPOINTMENT_PRESET_CONFIG.preset_contract_version,
    instruction: CONFIRM_APPOINTMENT_PRESET_CONFIG.instruction,
    context_sources: CONFIRM_APPOINTMENT_PRESET_CONFIG.context_sources.map((source) => ({ ...source })),
    output_fields: CONFIRM_APPOINTMENT_PRESET_CONFIG.output_fields.map((field) => ({
      ...field,
      ...(Array.isArray(field.allowed_values)
        ? { allowed_values: [...field.allowed_values] }
        : {}),
    })),
  };
}

module.exports = {
  AUTO_APPLY_CONFIDENCE_THRESHOLD,
  CLASSIFY_INTENT_PRESET_CONFIG,
  CLASSIFY_INTENT_PRESET_KEY,
  CONFIRM_APPOINTMENT_DECISION_TEMPLATE,
  CONFIRM_APPOINTMENT_DECISION_TEMPLATE_KEY,
  CONFIRM_APPOINTMENT_PRESET_CONFIG,
  CONFIRM_APPOINTMENT_PRESET_CONTRACT_VERSION,
  CONFIRM_APPOINTMENT_PRESET_KEY,
  RESPONSE_NEED_CONFIDENCE_THRESHOLD,
  cloneClassifyIntentPresetConfig,
  cloneConfirmAppointmentDecisionConfig,
  cloneConfirmAppointmentPresetConfig,
};
