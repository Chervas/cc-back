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
  'Cuestionar que se haya reservado una cita no solicita cancelarla: primero recepcion debe comprobar la reserva. Negar haberla pedido o acordado es consulta_gestion_previa, requiere_verificar_gestion_o_condicion=true, rechazo_asistencia_explicito=false y necesita_respuesta=true. No deduzcas una cancelacion de appointment ni de que exista un recordatorio.',
  'Antes de cerrar el analisis, revisa todo el lote en busca de actuaciones pendientes, incluso sin signos de pregunta: corregir un nombre o dato, avisar si queda un hueco, comprobar una gestion, o revisar una incidencia del contestador. Un acuse, agradecimiento o confirmacion no resuelve esas peticiones. Si la confirmacion es clara e independiente, conservala junto con necesita_respuesta=true; si la propia decision esta condicionada o es dudosa, no apliques un estado y deriva a recepcion.',
].join(' ');
const CLASSIFY_INTENT_REFERENCE_SYSTEM_INSTRUCTION = [
  'Para classify_intent, analiza primero el significado actual del lote nuevo. No atribuyas al paciente palabras de la clinica, ejemplos, decisiones historicas ni el estado almacenado de la cita.',
  'No toda respuesta al recordatorio confirma asistencia. Solo conocer la ubicacion es solo_indicaciones. Un compromiso espontaneo escrito de acudir es compromiso_asistencia, aunque tambien comente indicaciones. Un si/acuse solo es acuse_confirmacion_solicitada cuando responde a una pregunta de asistencia, recepcion de datos o telefono.',
  'Informar que antes hablo con recepcion, o preguntar por una fecha antes acordada, es consulta_gestion_previa sin decision nueva. Una solicitud nueva de cambiar fecha/hora es solicitud_nueva_cambio; explicar que no puede llegar no la convierte en cancelar. Una preferencia condicional que mantiene la cita original es ambigua y se revisa.',
  'Aceptar programar una primera visita no confirma una cita existente: otra y necesita_respuesta=true. Ante una interpretacion dudosa, ambigua y revision sin accion. No diagnostiques.',
  'Una reserva cuestionada requiere verificar lo ocurrido, no cancelar. Una disculpa por no contestar y una afirmacion condicionada no prueban asistencia. Una correccion de identidad, solicitud de aviso o queja que pide revision son asuntos pendientes aunque el paciente tambien confirme o agradezca.',
].join(' ');

const CLASSIFY_INTENT_REFERENCE_FIELDS = Object.freeze([
  {
    name: 'evidencia_asunto_pendiente',
    type: 'string',
    description: 'Antes de clasificar, copia literalmente del lote actual la frase que recepcion debe atender, corregir, comprobar o aclarar, aunque no sea pregunta: identidad incorrecta, aviso solicitado, reserva cuestionada o incidencia. Una confirmacion o agradecimiento no la borra. Vacio solo si no queda ninguna actuacion pendiente. No copies la pregunta de la clinica ni ejemplos',
    include_confidence: true,
  },
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
    description: 'true solo si el texto declara explicitamente una decision actual de no asistir a una cita acordada o pide cancelarla. false si cuestiona haberla reservado, niega haberla acordado o solo rechaza ayuda. No infieras una decision de cancelar de un conflicto con los datos almacenados. Esta señal no autoriza cancelar si tambien pide otra fecha',
    include_confidence: true,
  },
  {
    name: 'requiere_verificar_gestion_o_condicion',
    type: 'boolean',
    description: 'true si hay que verificar si la cita fue reservada o acordada, una gestion previa, una fecha anterior, o si la propia decision es condicionada, incierta o depende de una alternativa. No los conviertas en decision nueva. false cuando la decision actual es independiente y explicita, incluso seguida de otro asunto pendiente que no condiciona esa decision. Su confianza mide certeza del true O del false devuelto',
    include_confidence: true,
  },
  {
    name: 'hay_asunto_por_resolver',
    type: 'boolean',
    description: 'true si queda una pregunta, duda, peticion o actuacion para recepcion, incluso sin interrogacion: corregir nombre/datos, avisar si queda un hueco, verificar una reserva o gestion, o revisar una incidencia del contestador. Revisalo en todas las frases antes de responder false; confirmar, agradecer o acusar recibo no resuelve otro asunto. Rechazar indicaciones a una unica pregunta sin otra peticion no deja nada pendiente. La accion de confirmar o cancelar inequivocamente no es por si sola un asunto adicional',
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
  const pendingEvidence = normalizeEvidence(output.evidencia_asunto_pendiente);
  const hasPendingEvidence = !!pendingEvidence && text.includes(pendingEvidence);
  const replyConfidence = Number(output.confianza_hay_asunto_por_resolver) || 0;
  if (typeof output.hay_asunto_por_resolver === 'boolean' && replyConfidence >= AUTO_APPLY_CONFIDENCE_THRESHOLD) {
    output.necesita_respuesta = output.necesita_respuesta === true || output.hay_asunto_por_resolver;
    if (Object.hasOwn(output, 'confianza_necesita_respuesta')) output.confianza_necesita_respuesta = replyConfidence;
  } else {
    output.necesita_respuesta = true;
    if (Object.hasOwn(output, 'confianza_necesita_respuesta')) output.confianza_necesita_respuesta = 0;
  }
  if (hasPendingEvidence) {
    output.necesita_respuesta = true;
    if (Object.hasOwn(output, 'confianza_necesita_respuesta')) {
      output.confianza_necesita_respuesta = Math.max(
        Number(output.confianza_necesita_respuesta) || 0,
        Number(output.confianza_evidencia_asunto_pendiente) || 0,
      );
    }
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
  const independentConfirmationWithReply = output.intencion_principal === 'confirmar_cita'
    && ((output.hay_asunto_por_resolver === true && replyConfidence >= AUTO_APPLY_CONFIDENCE_THRESHOLD)
      || (hasPendingEvidence && Number(output.confianza_evidencia_asunto_pendiente) >= AUTO_APPLY_CONFIDENCE_THRESHOLD));
  if (readings && (!hasWrittenEvidence || !matches || incompatibleSecondary || unrelatedAcknowledgement
    || !['asistencia', 'datos_contacto'].includes(output.asunto_preguntado)
    || unsupportedCancellation || output.requiere_verificar_gestion_o_condicion !== false
    || !(Number(output.confianza_requiere_verificar_gestion_o_condicion) >= AUTO_APPLY_CONFIDENCE_THRESHOLD)
    || !(Number(output.confianza_lectura_respuesta) >= AUTO_APPLY_CONFIDENCE_THRESHOLD)
    || (output.necesita_respuesta === true && !independentConfirmationWithReply)
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
    name: 'evidencia_asunto_pendiente',
    type: 'string',
    description: 'Revisa primero TODAS las frases del lote actual. Copia literalmente la frase pendiente de corregir, comprobar, avisar o aclarar aunque tambien confirme: nombre/datos incorrectos, solicitud de aviso, reserva cuestionada, condicion o incidencia. Vacio solo si no queda ninguna actuacion pendiente. No copies la pregunta de la clinica ni ejemplos',
    include_confidence: true,
  },
  {
    name: 'lectura_confirmacion',
    type: 'string',
    description: 'Clasifica la propia decision: afirmacion_incondicional promete lo preguntado sin depender de otra opcion; acuse_recepcion solo confirma haber recibido los datos/contacto; decision_condicionada espera una alternativa o mantiene la cita solo si no hay otra opcion; sin_confirmacion no contesta afirmativamente; incierta admite lecturas distintas. Una pregunta independiente tras confirmar no condiciona la confirmacion',
    allowed_values: ['afirmacion_incondicional', 'acuse_recepcion', 'decision_condicionada', 'sin_confirmacion', 'incierta'],
    include_confidence: true,
  },
  {
    name: 'confirmacion_condicionada_o_incierta',
    type: 'boolean',
    description: 'true si la propia confirmacion depende de una posibilidad, alternativa, preferencia aun sin resolver o admite interpretaciones distintas. Una respuesta que no aclara si podra acudir no es compromiso. false si la confirmacion es incondicional, aunque tambien pida corregir un nombre o resolver otro asunto independiente',
    include_confidence: true,
  },
  {
    name: 'respuesta_afirmativa_a_la_clinica',
    type: 'boolean',
    description: 'Devuelve true solo ante una afirmacion clara, actual y no condicionada que responde a lo que la clinica pidio confirmar. Un acuse contextual puede confirmar recepcion, pero una disculpa por no contestar no confirma asistencia. Una pregunta, preferencia, condicion o peticion aislada devuelve false aunque presuponga la cita',
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
    description: 'Devuelve true si queda una duda, pregunta, peticion o actuacion para recepcion, aunque tambien haya confirmacion y no haya interrogacion. Incluye corregir nombre/datos, pedir avisos, cuestionar la reserva, revisar una incidencia o una decision condicionada. Un agradecimiento no resuelve las otras frases del lote. Tambien true ante contenido no interpretable',
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
    'Una respuesta condicionada, una preferencia pendiente o una disculpa por no haber respondido no es una confirmacion incondicional. Ante duda sobre la propia confirmacion devuelve respuesta_afirmativa_a_la_clinica=false y requiere_respuesta=true. Negar haber reservado exige revisar la reserva, no inferir asistencia ni cancelacion.',
    'Antes de devolver requiere_respuesta=false, comprueba todas las frases: una correccion de nombre o datos, pedir que le avisen de un hueco, o reclamar que revisen el contestador exige actuacion aunque tambien confirme o agradezca. Confirma solo la parte inequivoca y conserva esos asuntos pendientes para recepcion.',
    'Evalua primero evidencia_asunto_pendiente y lectura_confirmacion. No basta con que sea compatible con acudir: la propia decision debe ser clara e incondicional. Una opcion subsidiaria a conseguir otra fecha es decision_condicionada, no afirmacion_incondicional, aunque diga que acudira si no se consigue la alternativa. lectura_confirmacion=decision_condicionada o incierta exige confirmacion_condicionada_o_incierta=true y revision sin confirmar. Ejemplos ajenos a la conversacion: "Si es posible" -> decision_condicionada; "Preferiria otra tarde; si no puede ser, vengo hoy" -> decision_condicionada; "Si, este es mi telefono, pero mi nombre esta mal" -> acuse_recepcion y correccion pendiente.',
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
