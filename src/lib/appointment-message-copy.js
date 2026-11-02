'use strict';

const NEUTRAL_ACKNOWLEDGEMENTS = Object.freeze({
  es: 'Perfecto, {{paciente.nombre}}. Gracias.',
  ca: 'Perfecte, {{paciente.nombre}}. Gràcies.',
  en: 'Perfect, {{paciente.nombre}}. Thank you.',
});
const ACKNOWLEDGEMENT_ALIASES = {
  es: ['¡Gracias {{paciente.nombre}}! Hasta mañana', 'Perfecto, {{paciente.nombre}}. Hasta mañana.',
    '¡Muchas gracias {{paciente.nombre}}! Nos vemos ahora',
    '¡Muchas gracias {{paciente.nombre}}! Nos vemos mañana a las {{cita.hora}}',
    '¡Muchas gracias {{paciente.nombre}}! ¡Nos vemos!', '¡Hasta ahora!',
    'Gracias, queda confirmada. Te esperamos mañana a la hora prevista.'],
  ca: ['Gràcies, {{paciente.nombre}}! Fins demà', 'Perfecte, {{paciente.nombre}}. Fins demà.',
    'Moltes gràcies, {{paciente.nombre}}! Ens veiem ara',
    'Moltes gràcies, {{paciente.nombre}}! Ens veiem demà a les {{cita.hora}}',
    'Moltes gràcies, {{paciente.nombre}}! Fins aviat!', 'Fins ara!',
    'Gràcies, queda confirmada. T’esperem demà a l’hora prevista.'],
  en: ['Thank you, {{paciente.nombre}}! See you tomorrow', 'Perfect, {{paciente.nombre}}. See you tomorrow.',
    'Thank you very much, {{paciente.nombre}}! See you shortly',
    'Thank you very much, {{paciente.nombre}}! See you tomorrow at {{cita.hora}}',
    'Thank you very much, {{paciente.nombre}}! See you soon!', 'See you shortly!',
    'Thank you, it is confirmed. We look forward to seeing you tomorrow at the scheduled time.'],
};
const copyKey = text => String(text ?? '').normalize('NFC').trim().replace(/\s+/g, ' ');
const acknowledgementCopies = new Map(Object.entries(ACKNOWLEDGEMENT_ALIASES)
  .flatMap(([locale, texts]) => [...texts, NEUTRAL_ACKNOWLEDGEMENTS[locale]]
    .map(text => [copyKey(text), NEUTRAL_ACKNOWLEDGEMENTS[locale]])));

// Exact presentation aliases only: no intent classification or date inference.
function neutralAcknowledgementText(text) {
  return acknowledgementCopies.get(copyKey(text)) || text;
}
function acknowledgementForExecution(text, triggerType) {
  return ['appointment_created', 'appointment_rescheduled', 'appointment_reminder_window'].includes(triggerType)
    ? neutralAcknowledgementText(text) : text;
}
function normalizeAcknowledgementGraph(source) {
  const next = structuredClone(source);
  for (const node of next.nodes || []) {
    if (node.type !== 'action/send_whatsapp' || node.config?.message_mode !== 'manual') continue;
    if (node.config.manual_message_text !== undefined)
      node.config.manual_message_text = neutralAcknowledgementText(node.config.manual_message_text);
    for (const variant of Object.values(node.config.language_routing?.variants || {})) {
      if (variant && typeof variant === 'object' && variant.manual_message_text !== undefined)
        variant.manual_message_text = neutralAcknowledgementText(variant.manual_message_text);
    }
  }
  return next;
}

const RESPONSES = [
  {
    es: ['Gracias por avisarnos. Hemos cancelado tu cita. ¿Quieres que te ayudemos a concertar una nueva fecha?',
      'Gracias por avisarnos, {{paciente.nombre}}. Hemos anulado tu cita. ¿Te buscamos una nueva fecha?'],
    ca: ['Gràcies per avisar-nos. Hem cancel·lat la teva cita. Vols que t’ajudem a concertar una nova data?',
      'Gràcies per avisar-nos, {{paciente.nombre}}. Hem anul·lat la teva cita. Et busquem una nova data?'],
    en: ['Thank you for letting us know. We have cancelled your appointment. Would you like us to help you arrange a new date?',
      'Thank you for letting us know, {{paciente.nombre}}. We have cancelled your appointment. Shall we find a new date for you?'],
  },
  {
    es: ['De acuerdo. Si más adelante necesitas una nueva cita, estaremos encantados de ayudarte.',
      'Entendido. Cuando quieras retomarlo, escríbenos por aquí y te buscamos un hueco. Un saludo.'],
    ca: ['D’acord. Si més endavant necessites una nova cita, estarem encantats d’ajudar-te.',
      'Entesos. Quan vulguis reprendre-ho, escriu-nos per aquí i et busquem un lloc. Una salutació.'],
    en: ['Understood. If you need a new appointment later, we will be happy to help.',
      'Understood. Whenever you are ready, message us here and we will find an appointment for you. Best wishes.'],
  },
  {
    es: ['Gracias por avisarnos. Revisamos agenda y te decimos disponibilidad cuanto antes.',
      'Gracias por avisarnos, {{paciente.nombre}}. Revisamos la agenda y en breve te proponemos un nuevo horario.'],
    ca: ['Gràcies per avisar-nos. Revisem l’agenda i et diem disponibilitat al més aviat possible.',
      'Gràcies per avisar-nos, {{paciente.nombre}}. Revisem l’agenda i aviat et proposarem un nou horari.'],
    en: ['Thank you for letting us know. We will check the diary and send you our availability as soon as possible.',
      'Thank you for letting us know, {{paciente.nombre}}. We will check the diary and suggest a new time shortly.'],
  },
  {
    es: ['Gracias por avisarnos. Revisamos la agenda y te decimos la disponibilidad cuanto antes.',
      'Gracias por avisarnos, {{paciente.nombre}}. Revisamos la agenda y te escribimos en breve con alternativas.'],
  },
  {
    es: ['¡Gracias {{paciente.nombre}}! Hasta mañana',
      NEUTRAL_ACKNOWLEDGEMENTS.es],
    ca: ['Gràcies, {{paciente.nombre}}! Fins demà',
      NEUTRAL_ACKNOWLEDGEMENTS.ca],
    en: ['Thank you, {{paciente.nombre}}! See you tomorrow',
      NEUTRAL_ACKNOWLEDGEMENTS.en],
  },
];

function updateAppointmentMessages(source) {
  const next = structuredClone(source);
  for (const node of next.nodes || []) {
    if (node.type !== 'action/send_whatsapp' || node.config?.message_mode !== 'manual') continue;
    const copy = RESPONSES.find(item => item.es[0] === node.config.manual_message_text);
    if (copy) node.config.manual_message_text = copy.es[1];
    for (const locale of ['ca', 'en']) {
      const variant = node.config.language_routing?.variants?.[locale];
      // Customized translations are never silently replaced.
      if (variant && copy?.[locale] && variant.manual_message_text === copy[locale][0]) variant.manual_message_text = copy[locale][1];
    }
    if (node.config.manual_message_text !== undefined)
      node.config.manual_message_text = neutralAcknowledgementText(node.config.manual_message_text);
    for (const variant of Object.values(node.config.language_routing?.variants || {})) {
      if (variant && typeof variant === 'object' && variant.manual_message_text !== undefined)
        variant.manual_message_text = neutralAcknowledgementText(variant.manual_message_text);
    }
    if (copy === RESPONSES[2] || copy === RESPONSES[3]) {
      const alert = next.nodes.find(candidate => candidate.id === node.outputs?.on_success);
      if (alert?.type === 'action/send_system_notification' && alert.config?.display_mode === 'persistent_alert'
        && /cambio solicitado|quiere cambiar|nueva fecha/i.test(`${alert.config.title} ${alert.config.message}`)) {
        alert.config.title = 'Proponer un nuevo horario a {{paciente.nombre}}';
        alert.config.message = 'El paciente ha pedido cambiar la cita. Revisa la conversación y propón un nuevo horario. El aviso permanece pendiente hasta que el equipo lo atienda.';
        alert.config.human_response_followup_minutes = 30;
      }
    }
  }
  if (source.trigger_config?.program_booking_v1 && JSON.stringify(source.nodes) !== JSON.stringify(next.nodes)) {
    const program = require('./patient-program-appointment-flow');
    const { hash } = require('./patient-program-booking-confirmation');
    const previous = source.trigger_config.program_booking_v1;
    // Native publication separately revalidates the normal projection against
    // its pinned published source. Permit rebinding an old stale digest only
    // when all structural, scope and duplicate policy checks still hold.
    if (!program.EVENTS.includes(source.trigger_type) || !require('./appointment-single-notice-flow').scoped(source)
      || !program.branchValid(source)
      || hash(source.nodes.find(node => node.id === source.entry_node_id)?.config?.program_booking_v1) !== hash(previous)
      || hash(source.trigger_config) !== hash({ ...previous.normal_trigger_config, program_booking_v1: previous }))
      throw Error('appointment_copy_program_source_invalid');
    const policy = { ...next.trigger_config.program_booking_v1, normal_sha256: hash(program.normalProjection(next)) };
    next.trigger_config.program_booking_v1 = policy;
    next.nodes.find(node => node.id === next.entry_node_id).config.program_booking_v1 = structuredClone(policy);
    if (!program.graphValid(next)) throw Error('appointment_copy_program_candidate_invalid');
  }
  return next;
}

const REMINDER_APOLOGIES = {
  es: ' Perdona que te moleste hoy de nuevo.',
  ca: ' Perdona que et tornem a molestar avui.',
  en: ' Sorry to contact you again today.',
};
const APOLOGIES = {
  es: 'Disculpa las molestias que este cambio te haya podido causar. ',
  ca: 'Disculpa les molèsties que aquest canvi t’hagi pogut causar. ',
  en: 'We apologize for any inconvenience this change may have caused. ',
};

function updateAppointmentCatalog(catalog) {
  const next = structuredClone(catalog);
  const family = catalog.family_key || catalog.name.replace(/__(ca|en)$/, '');
  const locale = catalog.locale || 'es';
  if (family === 'clinicaclick_recordatorio_dia_antes' && REMINDER_APOLOGIES[locale]) {
    next.body_text = next.body_text.replace(REMINDER_APOLOGIES[locale], '');
  } else if (/^clinicaclick_confirmacion_datos_cita_reprogramada_(48|24|hoy)$/.test(family) && APOLOGIES[locale]) {
    next.body_text = next.body_text.replace(APOLOGIES[locale], '');
  } else return next;
  next.components = (next.components || []).map(component => component.type === 'BODY'
    ? { ...component, text: next.body_text, example: { body_text: [next.variables.map(variable => variable.example)] } } : component);
  return next;
}

module.exports = { RESPONSES, REMINDER_APOLOGIES, NEUTRAL_ACKNOWLEDGEMENTS, ACKNOWLEDGEMENT_ALIASES,
  neutralAcknowledgementText, acknowledgementForExecution, normalizeAcknowledgementGraph, updateAppointmentMessages, updateAppointmentCatalog };
