'use strict';

const CLASSIFY_INTENT_PRESET_KEY = 'classify_intent';
const CONFIRM_APPOINTMENT_PRESET_KEY = 'confirm_appointment';
const CONFIRM_APPOINTMENT_PRESET_CONTRACT_VERSION = 4;
const CONFIRM_APPOINTMENT_DECISION_TEMPLATE_KEY = 'confirm_appointment_v2';
const AUTO_APPLY_CONFIDENCE_THRESHOLD = 0.85;
const RESPONSE_NEED_CONFIDENCE_THRESHOLD = 0.75;

const CONFIRM_APPOINTMENT_ANALYSIS_FIELDS = Object.freeze([
  {
    name: 'respuesta_afirmativa_a_la_clinica',
    type: 'boolean',
    description: 'Devuelve true solo si alguna parte del lote contiene una afirmación o acuse que responde a la petición concreta de confirmación de la clínica. Una pregunta o petición sin afirmación explícita devuelve false aunque presuponga la cita o sea compatible con asistir',
    include_confidence: true,
  },
  {
    name: 'negacion_explicita_de_la_confirmacion',
    type: 'boolean',
    description: 'Devuelve true solo si el lote contiene una negación explícita dirigida a esa misma confirmación, por ejemplo no lo he recibido o al final no puedo ir. Devuelve false ante pero, una pregunta, una queja o un asunto pendiente diferente sin una negación de la confirmación',
    include_confidence: true,
  },
  {
    name: 'requiere_respuesta',
    type: 'boolean',
    description: 'Devuelve true si el lote contiene una pregunta, petición, comentario que exige actuación o contenido no interpretable que recepción debe revisar',
    include_confidence: true,
  },
  {
    name: 'motivo',
    type: 'string',
    description: 'Explica brevemente la evidencia de cada señal sin convertir un asunto pendiente diferente en una contradicción de la confirmación',
    include_confidence: true,
  },
]);

const CONFIRM_APPOINTMENT_PRESET_CONFIG = Object.freeze({
  preset_contract_version: CONFIRM_APPOINTMENT_PRESET_CONTRACT_VERSION,
  instruction: [
    'Analiza exclusivamente patient_message_batch respecto al mensaje concreto de la clínica incluido como listened_message_preview o reaction_target_message_preview.',
    'Evalúa por separado: (1) si existe una respuesta afirmativa a lo que la clínica pidió confirmar, (2) si existe una negación explícita posterior de esa misma confirmación y (3) si queda una pregunta, petición o actuación pendiente.',
    'Un sí, confirmo, podré ir, allí estaré, ok, vale, recibido o agradecimiento breve cuenta como respuesta afirmativa cuando responde directamente a una petición clara de confirmación.',
    'Una reacción positiva vinculada al mensaje de confirmación también cuenta como respuesta afirmativa.',
    'No confundas contexto compatible con confirmación: una pregunta o petición aislada, como preguntar qué debe llevar, dónde acudir o a qué hora es la cita, no afirma lo preguntado y debe devolver respuesta_afirmativa_a_la_clinica=false.',
    'Solo una negación o revocación expresa de esa misma confirmación marca negacion_explicita_de_la_confirmacion=true y exige requiere_respuesta=true. Pero o además seguidos de otro asunto, pregunta, queja o petición deben dejar esa señal en false.',
    'Si existe una respuesta afirmativa y después otro asunto pendiente, conserva la señal afirmativa, marca negacion_explicita_de_la_confirmacion=false y requiere_respuesta=true.',
    'Si el paciente rechaza lo preguntado, pide cancelar o cambiar, todavía no puede confirmar o no aporta confirmación, no marques respuesta afirmativa.',
    'Marca requiere_respuesta=true solo por contenido real del lote que exija actuación o por un adjunto no interpretable; no lo marques para una confirmación, acuse, saludo o agradecimiento sin nada pendiente.',
    'No uses mensajes históricos, appointment, trigger ni ejemplos como palabras del paciente. Devuelve exactamente las señales solicitadas y un motivo breve basado en el lote actual.',
  ].join(' '),
  context_sources: [
    { key: 'patient_message_batch', path: '{{last_response_context}}' },
    { key: 'appointment', path: '{{appointment}}' },
    { key: 'trigger', path: '{{trigger.data}}' },
  ],
  output_fields: [
    {
      name: 'confirma_asistencia',
      type: 'boolean',
      description: 'Indica si el paciente confirma de forma clara lo que preguntó la clínica: asistencia cuando se pidió confirmar que acudirá, o recepción cuando se pidió confirmar los datos enviados. Una afirmación breve y contextual confirma; conserva un true explícito aunque después exista una pregunta real en el mismo lote, salvo contradicción',
      include_confidence: true,
    },
    {
      name: 'requiere_respuesta',
      type: 'boolean',
      description: 'Devuelve true solo si existe evidencia en el lote actual de una pregunta, petición, comentario que exige actuación o contenido no interpretable que recepción deba revisar. Devuelve false para gracias, saludos, confirmaciones, acuses o reacciones positivas sin ninguna petición real pendiente; no infieras preguntas ausentes',
      include_confidence: true,
    },
    {
      name: 'motivo',
      type: 'string',
      description: 'Explica brevemente qué evidencia del lote actual justifica ambos resultados. No menciones preguntas, peticiones o comentarios que no aparezcan en la respuesta recibida',
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
  instruction: [
    'Clasifica exclusivamente patient_message_batch como la nueva respuesta del paciente.',
    'conversation_today está limitado al mensaje de la clínica al que responde y al mismo lote actual; úsalo solo para entender qué pidió la clínica, nunca como contenido nuevo del paciente.',
    'No atribuyas al lote mensajes históricos, posteriores, ejemplos de estas instrucciones ni palabras de la clínica.',
    'El motivo solo puede mencionar una pregunta, petición, comentario o decisión si existe evidencia en response_text, response_lines, response_items o reaction_emoji del lote actual.',
    'Identifica la intención principal y, si existe, una intención secundaria. Para una cita distingue confirmar, cancelar, solicitar un cambio, hacer una pregunta o no existir una acción clara.',
    'Una respuesta afirmativa breve como "sí", "sí lo es", "confirmo", "sí podré ir", "puedo ir", "iré" o "allí estaré" en respuesta directa a una petición clara de confirmar la cita se clasifica como confirmar_cita y necesita_respuesta=false si el lote no contiene nada más que exija contestación.',
    'La expresión "sí podré ir" es una afirmación declarativa y no una pregunta.',
    'Un acuse como "ok", "vale", "recibido" o un agradecimiento confirma solo cuando responde de forma contextual a una petición clara de confirmación y no contiene una contradicción.',
    'Una respuesta afirmativa o un acuse escrito con entonación interrogativa o que expresa duda no es una confirmación clara: clasifícalo como pregunta y marca necesita_respuesta=true.',
    'Expresar incertidumbre, decir que todavía no puede confirmar o pedir tiempo para decidir no significa cancelar ni solicitar un cambio: clasifícalo como otra y marca necesita_respuesta=true.',
    'Usa solicitar_cambio_cita solo cuando el paciente pide explícitamente mover, reagendar o buscar otra fecha u hora. Usa cancelar_cita cuando pide cancelar o afirma de forma inequívoca que no asistirá sin pedir una nueva fecha.',
    'Una reacción positiva como 👍, ❤️ o ✅ vinculada al mensaje en el que la clínica pide confirmar la cita se clasifica como confirmar_cita y no necesita respuesta, aunque en el mismo lote exista un adjunto no interpretable; el adjunto no anula la reacción. Una reacción negativa o ambigua no equivale por sí sola a cancelar la cita.',
    'Si confirma y además formula realmente una pregunta o petición en el lote actual, conserva ambas intenciones.',
    'Marca necesita_respuesta=true solo cuando el lote actual contiene una pregunta, petición, incertidumbre o comentario que exige actuación, o contenido no interpretable que recepción deba revisar. Debes poder señalar esa evidencia; no inventes una necesidad de respuesta a partir del contexto o de estas instrucciones.',
    'Expresa cualquier duda sobre la clasificación mediante una confianza menor; no conviertas esa duda en una pregunta o petición inexistente.',
    'Antes de devolver el JSON, comprueba la coherencia entre intencion_principal y motivo: si el motivo afirma que el paciente confirma su asistencia o la cita en respuesta directa a la petición de la clínica, intencion_principal debe ser confirmar_cita y no otra.',
    'Evalúa posible_urgencia de forma independiente a la intención principal: una cancelación, un cambio o cualquier otra intención no elimina una situación actual que requiera atención inmediata.',
    'Marca posible_urgencia=true como señal operativa cuando recepción deba responder de inmediato a una situación actual: incluye incidencias de acceso o espera en la clínica y síntomas actuales descritos como intensos o potencialmente graves, como un sangrado intenso o dificultad para respirar; no exijas que el paciente escriba la palabra urgente.',
    'No marques urgencia solo por un contexto llamativo ajeno a una actuación inmediata de la clínica. No diagnostiques.',
    'Devuelve exactamente los campos solicitados, la confianza individual solicitada para cada campo y un motivo breve basado solo en la evidencia recibida.',
  ].join(' '),
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
      description: 'Indica si recepcion debe responder de inmediato a una situacion actual de la atencion, aunque el paciente no escriba la palabra urgente; por ejemplo, ya esta en la puerta y no puede entrar. No realiza diagnosticos',
      include_confidence: true,
    },
    {
      name: 'necesita_respuesta',
      type: 'boolean',
      description: 'Indica si el lote actual contiene evidencia de una pregunta, petición, incertidumbre, comentario que exige actuación o contenido no interpretable que recepción debe revisar. No infiere necesidades ausentes',
      include_confidence: true,
    },
    {
      name: 'motivo',
      type: 'string',
      description: 'Razón breve basada únicamente en la evidencia del lote actual, sin inventar preguntas, peticiones ni datos clínicos',
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
  CONFIRM_APPOINTMENT_ANALYSIS_FIELDS,
  CONFIRM_APPOINTMENT_PRESET_CONFIG,
  CONFIRM_APPOINTMENT_PRESET_CONTRACT_VERSION,
  CONFIRM_APPOINTMENT_PRESET_KEY,
  RESPONSE_NEED_CONFIDENCE_THRESHOLD,
  cloneClassifyIntentPresetConfig,
  cloneConfirmAppointmentDecisionConfig,
  cloneConfirmAppointmentPresetConfig,
};
