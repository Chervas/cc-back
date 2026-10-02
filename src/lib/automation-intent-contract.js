'use strict';

const CLASSIFY_INTENT_PRESET_KEY = 'classify_intent';
const CONFIRM_APPOINTMENT_PRESET_KEY = 'confirm_appointment';
const CONFIRM_APPOINTMENT_PRESET_CONTRACT_VERSION = 4;
const CONFIRM_APPOINTMENT_DECISION_TEMPLATE_KEY = 'confirm_appointment_v2';
const AUTO_APPLY_CONFIDENCE_THRESHOLD = 0.85;
const RESPONSE_NEED_CONFIDENCE_THRESHOLD = 0.75;
const CLASSIFY_INTENT_REFERENCE_INSTRUCTION = [
  'patient_message_batch contiene el lote nuevo completo en orden. clinic_message_replied_to y preceding_messages aportan referencia; appointment y trigger son datos de contexto, nunca decisiones nuevas del paciente.',
  'Antes de escoger la intencion, resume lo que el paciente acaba de expresar y selecciona lectura_respuesta. Distingue decisiones actuales de consultas sobre gestiones pasadas. Mantener la cita a falta de una alternativa no pide cambiarla. Una pregunta sobre una fecha ya acordada exige verificarla, no aplicar otro cambio.',
  'Ejemplos de lectura semantica (no son mensajes recibidos): "La recepcionista ya me atendio y explique el motivo" -> consulta_gestion_previa. "Habiamos quedado para el jueves, verdad?" -> consulta_gestion_previa. "Conozco el camino" -> solo_indicaciones. "Alli estare, se donde es" -> compromiso_asistencia. "Me la cambiais? No puedo llegar" -> solicitud_nueva_cambio. "No podre asistir" sin alternativa -> rechazo_asistencia.',
  'Un si/no/acuse escrito depende de la pregunta literal. "No" a "Sabes llegar? Necesitas ayuda?" -> ambigua, necesita_respuesta=true, sin cancelar. A una unica pregunta de ayuda, rechazarla no cancela. Una reaccion sin texto no aporta evidencia escrita para cambiar el estado: sin_decision. No transformes conocer la ubicacion en prometer asistencia.',
  'Copia evidencia_decision_actual solo del texto actual y no inventes la decision. Conserva todas las preguntas del lote, aun junto a una confirmacion. Una peticion de nueva fecha seguida de no poder acudir sigue siendo cambio, no cancelar. Si queda incertidumbre, devuelve ambigua y necesita_respuesta=true. Devuelve los valores exactos configurados.',
].join(' ');
const CLASSIFY_INTENT_REFERENCE_SYSTEM_INSTRUCTION = [
  'Para classify_intent, analiza primero el significado actual del lote nuevo. No atribuyas al paciente palabras de la clinica, ejemplos, decisiones historicas ni el estado almacenado de la cita.',
  'No toda respuesta al recordatorio confirma asistencia. Solo conocer la ubicacion es solo_indicaciones. Un compromiso espontaneo escrito de acudir es compromiso_asistencia, aunque tambien comente indicaciones. Un si/acuse solo es acuse_confirmacion_solicitada cuando responde a una pregunta de asistencia, recepcion de datos o telefono.',
  'Informar que antes hablo con recepcion, o preguntar por una fecha antes acordada, es consulta_gestion_previa sin decision nueva. Una solicitud nueva de cambiar fecha/hora es solicitud_nueva_cambio; explicar que no puede llegar no la convierte en cancelar. Una preferencia condicional que mantiene la cita original es ambigua y se revisa.',
  'Aceptar programar una primera visita no confirma una cita existente: otra y necesita_respuesta=true. Ante una interpretacion dudosa, ambigua y revision sin accion. No diagnostiques.',
].join(' ');

const CLASSIFY_INTENT_REFERENCE_FIELDS = Object.freeze([
  {
    name: 'asunto_preguntado',
    type: 'string',
    description: 'Asunto de la pregunta literal de la clinica, no del recordatorio completo. Recordar una cita y preguntar como llegar es indicaciones, no asistencia. Usa varios si hay preguntas de asuntos distintos',
    allowed_values: ['asistencia', 'datos_contacto', 'indicaciones', 'proponer_cita', 'varios', 'otro'],
  },
  {
    name: 'significado_de_respuesta',
    type: 'string',
    description: 'Resume lo que el paciente afirma o pregunta ahora, antes de escoger una accion. Distingue acudir en el futuro, conocer el camino y haber avisado antes a recepcion; no son lo mismo',
  },
  {
    name: 'lectura_respuesta',
    type: 'string',
    description: 'Naturaleza del lote actual completo: compromiso_asistencia promete acudir; acuse_confirmacion_solicitada responde afirmativamente a una pregunta de asistencia/datos/telefono; solicitud_nueva_cambio pide mover una cita existente; rechazo_asistencia pide cancelar/no acudir sin alternativa; consulta_gestion_previa cuestiona un acuerdo previo o remite a recepcion sin explicar resultado; solo_indicaciones sabe llegar/rechaza ayuda; sin_decision no contiene decision escrita; ambigua es dudosa o condicionada. Una pregunta diferente junto a un compromiso claro no anula ese compromiso',
    allowed_values: ['compromiso_asistencia', 'acuse_confirmacion_solicitada', 'solicitud_nueva_cambio',
      'rechazo_asistencia', 'consulta_gestion_previa', 'solo_indicaciones', 'sin_decision', 'ambigua'],
    include_confidence: true,
  },
  {
    name: 'evidencia_decision_actual',
    type: 'string',
    description: 'Copia literalmente un fragmento continuo de response_text que aporta la decision actual de confirmar, cancelar o solicitar un cambio. No parafrasees, no tomes palabras de la clinica ni del historial. Vacio si no existe decision escrita; una reaccion no contiene texto escrito',
  },
  {
    name: 'rechazo_asistencia_explicito',
    type: 'boolean',
    description: 'true solo si el texto declara explicitamente que no asistira o pide cancelar. false para un No breve cuya interpretacion depende de la pregunta de la clinica; rechazar ayuda no es rechazar acudir. Esta señal no autoriza cancelar si tambien pide otra fecha',
    include_confidence: true,
  },
  {
    name: 'requiere_verificar_gestion_o_condicion',
    type: 'boolean',
    description: 'true si hay que verificar una gestion previa con recepcion, una fecha que antes se acordo, o una alternativa condicionada a mantener la cita original. No los conviertas en decision nueva. false cuando la decision actual es independiente y explicita, incluso seguida de una pregunta diferente. Su confianza mide certeza del true O del false devuelto',
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

function projectClassifyIntentReferenceOutput(value = {}, { patientText = '' } = {}) {
  const output = { ...value };
  const normalizeEvidence = (text) => String(text || '').normalize('NFC').replace(/\s+/g, ' ').trim();
  const text = normalizeEvidence(patientText);
  const evidence = normalizeEvidence(output.evidencia_decision_actual);
  // Verify provenance, not meaning: semantic interpretation stays with the model.
  const hasWrittenEvidence = !!evidence && text.includes(evidence);
  const replyConfidence = Number(output.confianza_hay_asunto_por_resolver) || 0;
  if (typeof output.hay_asunto_por_resolver === 'boolean' && replyConfidence >= AUTO_APPLY_CONFIDENCE_THRESHOLD) {
    output.necesita_respuesta = output.hay_asunto_por_resolver;
    if (Object.hasOwn(output, 'confianza_necesita_respuesta')) output.confianza_necesita_respuesta = replyConfidence;
  } else {
    output.necesita_respuesta = true;
    if (Object.hasOwn(output, 'confianza_necesita_respuesta')) output.confianza_necesita_respuesta = 0;
  }
  const actionReadings = {
    confirmar_cita: ['compromiso_asistencia', 'acuse_confirmacion_solicitada'],
    cancelar_cita: ['rechazo_asistencia'],
    solicitar_cambio_cita: ['solicitud_nueva_cambio'],
  };
  const readings = actionReadings[output.intencion_principal];
  const matches = readings?.includes(output.lectura_respuesta);
  const incompatibleSecondary = readings && Object.hasOwn(actionReadings, output.intencion_secundaria)
    && output.intencion_secundaria !== output.intencion_principal;
  const unrelatedAcknowledgement = output.lectura_respuesta === 'acuse_confirmacion_solicitada'
    && !['asistencia', 'datos_contacto'].includes(output.asunto_preguntado);
  const unsupportedCancellation = output.intencion_principal === 'cancelar_cita'
    && (output.rechazo_asistencia_explicito !== true
      || !(Number(output.confianza_rechazo_asistencia_explicito) >= AUTO_APPLY_CONFIDENCE_THRESHOLD));
  if (readings && (!hasWrittenEvidence || !matches || incompatibleSecondary || unrelatedAcknowledgement
    || !['asistencia', 'datos_contacto'].includes(output.asunto_preguntado)
    || unsupportedCancellation || output.requiere_verificar_gestion_o_condicion !== false
    || !(Number(output.confianza_requiere_verificar_gestion_o_condicion) >= AUTO_APPLY_CONFIDENCE_THRESHOLD)
    || !(Number(output.confianza_lectura_respuesta) >= AUTO_APPLY_CONFIDENCE_THRESHOLD)
    || output.necesita_respuesta === true
    || output.posible_urgencia === true)) {
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
    description: 'Devuelve true si alguna parte del lote contiene una afirmación o acuse contextual que responde a lo que la clínica pidió confirmar; un agradecimiento breve también acusa recibo cuando se pidió confirmar recepción. Una pregunta o petición aislada devuelve false aunque presuponga la cita o sea compatible con asistir',
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
    'Analiza exclusivamente patient_message_batch respecto al mensaje concreto de la clínica en clinic_message_replied_to, listened_message_preview o reaction_target_message_preview. El mensaje de la clinica es referencia separada, nunca evidencia de una respuesta afirmativa del paciente.',
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
  CLASSIFY_INTENT_REFERENCE_SYSTEM_INSTRUCTION,
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
