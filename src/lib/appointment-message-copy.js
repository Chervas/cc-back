'use strict';

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
      'Perfecto, {{paciente.nombre}}. Hasta mañana.'],
    ca: ['Gràcies, {{paciente.nombre}}! Fins demà',
      'Perfecte, {{paciente.nombre}}. Fins demà.'],
    en: ['Thank you, {{paciente.nombre}}! See you tomorrow',
      'Perfect, {{paciente.nombre}}. See you tomorrow.'],
  },
];

function updateAppointmentMessages(source) {
  const next = structuredClone(source);
  for (const node of next.nodes || []) {
    if (node.type !== 'action/send_whatsapp' || node.config?.message_mode !== 'manual') continue;
    const copy = RESPONSES.find(item => item.es[0] === node.config.manual_message_text);
    if (!copy) continue;
    node.config.manual_message_text = copy.es[1];
    for (const locale of ['ca', 'en']) {
      const variant = node.config.language_routing?.variants?.[locale];
      // Customized translations are never silently replaced.
      if (variant && copy[locale] && variant.manual_message_text === copy[locale][0]) variant.manual_message_text = copy[locale][1];
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

module.exports = { RESPONSES, REMINDER_APOLOGIES, updateAppointmentMessages, updateAppointmentCatalog };
