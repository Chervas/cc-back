'use strict';

const CLASSIFY_INTENT_PRESET_KEY = 'classify_intent';
const CONFIRM_APPOINTMENT_PRESET_KEY = 'confirm_appointment';
const CONFIRM_APPOINTMENT_PRESET_CONTRACT_VERSION = 4;
const CONFIRM_APPOINTMENT_DECISION_TEMPLATE_KEY = 'confirm_appointment_v2';
const AUTO_APPLY_CONFIDENCE_THRESHOLD = 0.85;
const RESPONSE_NEED_CONFIDENCE_THRESHOLD = 0.75;
const CLASSIFY_INTENT_REFERENCE_INSTRUCTION = [
  'Antes de clasificar una respuesta breve, identifica exactamente que pregunta la clinica en listened_message_preview, reaction_target_message_preview o clinic_message_replied_to y a que asunto responde el paciente.',
  'Anunciar o recordar una cita no equivale a pedir que se confirme la asistencia. No sustituyas una pregunta sobre indicaciones, ubicacion, ayuda o datos de contacto por una pregunta sobre si acudira.',
  'Una respuesta negativa a necesitar indicaciones rechaza esa ayuda, no la cita. Por ejemplo, "No es necesario, ya he ido varias veces" no pide cancelar ni cambiar. Una respuesta afirmativa a saber llegar tampoco confirma de nuevo la asistencia.',
  'Si la unica pregunta es si necesita indicaciones y la respuesta las rechaza sin ninguna otra peticion, clasifica el acuse como otra o agradecimiento con necesita_respuesta=false. No inventes una duda sobre la asistencia. Saber llegar no es confirmar asistencia: confirmar_cita exige que lo afirmado sea acudir o recibir los datos solicitados, no conocer la ubicacion.',
  'Si el mensaje pregunta "Sabes llegar? Necesitas alguna indicacion?" y el lote solo dice "No", hay ambiguedad sobre la ayuda o la ubicacion, no una negativa explicita a acudir: conserva esa distincion y solicita revision cuando haga falta aclararla.',
  'Para devolver cancelar_cita debe existir evidencia de que el paciente cancela o rechaza asistir, no solo una negacion dirigida a otro asunto. Un rechazo a confirmar el telefono o la recepcion de datos tampoco es una cancelacion.',
  'Una peticion explicita de cancelar o una afirmacion como "No puedo ir" puede cancelar aunque el mensaje de referencia trate de indicaciones. Si pide otra fecha u hora, distingue la solicitud de cambio de una cancelacion sin nueva fecha.',
  'Los datos de appointment y trigger describen la cita, no lo que acaba de preguntar la clinica. Una cita ya confirmada no se revoca porque el paciente no necesite ayuda para llegar.',
  'Antes de elegir la intencion, completa asunto_preguntado y significado_de_respuesta. La intencion y necesita_respuesta deben ser coherentes con ese significado, no con el mero hecho de existir una cita.',
].join(' ');

const CLASSIFY_INTENT_REFERENCE_FIELDS = Object.freeze([
  {
    name: 'asunto_preguntado',
    type: 'string',
    description: 'Describe brevemente todas las preguntas reales del mensaje de referencia: asistencia, recepcion de datos, telefono, indicaciones, proponer una cita nueva u otro asunto. Si hay dos preguntas, conserva ambas; no elijas arbitrariamente una. Recordar una cita no convierte cualquier pregunta en confirmar asistencia',
  },
  {
    name: 'significado_de_respuesta',
    type: 'string',
    description: 'Explica brevemente que afirma, niega o solicita el paciente sobre ese asunto concreto y si queda algo por resolver. Un No a Sabes llegar? Necesitas indicaciones? es ambiguo y requiere aclarar la ayuda, no la asistencia. Negar necesitar indicaciones a una unica pregunta no exige respuesta ni cancela. Negar que el telefono sea correcto o recibir datos exige una respuesta para resolverlo, no cancelar. Aceptar programar una primera visita exige respuesta, no cambia una cita existente. Una peticion explicita de cancelar, no asistir o cambiar prevalece sobre el asunto preguntado',
  },
  {
    name: 'rechaza_asistir_o_pide_cancelar',
    type: 'boolean',
    description: 'true solo cuando el paciente pide cancelar o expresa que no asistira a la cita. Evalua respecto a todas las preguntas reales del mensaje de referencia. Negar necesitar indicaciones, recibir datos o validar un telefono devuelve false: esas negaciones no rechazan asistir',
    include_confidence: true,
  },
  {
    name: 'pide_modificar_cita_existente',
    type: 'boolean',
    description: 'true si el paciente solicita mover, cambiar o buscar otra fecha u hora para una cita existente. Aceptar que le programen una primera visita devuelve false: todavia no hay una cita que modificar',
    include_confidence: true,
  },
  {
    name: 'hay_asunto_por_resolver',
    type: 'boolean',
    description: 'true si hay una pregunta, duda, ayuda o asunto pendiente que exige respuesta de recepcion. Un No que puede responder a dos preguntas diferentes necesita aclaracion. Negar que el telefono sea correcto o recibir datos necesita ayuda. Pedir otra fecha exige respuesta. Rechazar indicaciones a una unica pregunta no deja nada pendiente. Confirmar o pedir cancelar de forma inequivoca sin ninguna otra pregunta o peticion devuelve false: ejecutar esa accion no es un asunto adicional pendiente',
    include_confidence: true,
  },
]);

function buildClassifyIntentInstruction(instruction) {
  const configured = String(instruction || '').trim();
  return configured.includes(CLASSIFY_INTENT_REFERENCE_INSTRUCTION)
    ? configured
    : [configured, CLASSIFY_INTENT_REFERENCE_INSTRUCTION].filter(Boolean).join(' ');
}

function projectClassifyIntentReferenceOutput(value = {}) {
  const output = { ...value };
  const replyConfidence = Number(output.confianza_hay_asunto_por_resolver) || 0;
  if (typeof output.hay_asunto_por_resolver === 'boolean' && replyConfidence >= AUTO_APPLY_CONFIDENCE_THRESHOLD) {
    output.necesita_respuesta = output.hay_asunto_por_resolver;
    if (Object.hasOwn(output, 'confianza_necesita_respuesta')) output.confianza_necesita_respuesta = replyConfidence;
  } else {
    output.necesita_respuesta = true;
    if (Object.hasOwn(output, 'confianza_necesita_respuesta')) output.confianza_necesita_respuesta = 0;
  }
  const actionSignals = {
    cancelar_cita: 'rechaza_asistir_o_pide_cancelar',
    solicitar_cambio_cita: 'pide_modificar_cita_existente',
  };
  const signal = actionSignals[output.intencion_principal];
  if (signal && (output[signal] !== true || Number(output[`confianza_${signal}`]) < AUTO_APPLY_CONFIDENCE_THRESHOLD
    || !Number.isFinite(Number(output[`confianza_${signal}`])))) {
    output.intencion_principal = 'otra';
    output.intencion_secundaria = '';
    output.confianza = 0;
    if (Object.hasOwn(output, 'confianza_intencion_principal')) output.confianza_intencion_principal = 0;
    output.accion_inequivoca = false;
    output.necesita_respuesta = true;
    if (Object.hasOwn(output, 'confianza_necesita_respuesta')) output.confianza_necesita_respuesta = 0;
    output._ai_reference_inconsistent = true;
    output.motivo = `${String(output.motivo || '').trim()} La accion propuesta no concuerda con la evidencia sobre la cita; requiere revision.`.trim();
  }
  return output;
}

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
  ].concat(CLASSIFY_INTENT_REFERENCE_INSTRUCTION).join(' '),
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
  CLASSIFY_INTENT_REFERENCE_INSTRUCTION,
  CLASSIFY_INTENT_REFERENCE_FIELDS,
  CONFIRM_APPOINTMENT_DECISION_TEMPLATE,
  CONFIRM_APPOINTMENT_DECISION_TEMPLATE_KEY,
  CONFIRM_APPOINTMENT_ANALYSIS_FIELDS,
  CONFIRM_APPOINTMENT_PRESET_CONFIG,
  CONFIRM_APPOINTMENT_PRESET_CONTRACT_VERSION,
  CONFIRM_APPOINTMENT_PRESET_KEY,
  RESPONSE_NEED_CONFIDENCE_THRESHOLD,
  buildClassifyIntentInstruction,
  projectClassifyIntentReferenceOutput,
  cloneClassifyIntentPresetConfig,
  cloneConfirmAppointmentDecisionConfig,
  cloneConfirmAppointmentPresetConfig,
};
