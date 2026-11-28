'use strict';

const normalize = text => String(text || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
const instruction = /\b(?:respon(?:de|da|diendo)|respond(?:er|a)|contesta(?:r)?|conteste|escrib(?:e|a|ir)|envi(?:a|ar|e)|manda(?:r)?|pon(?:ga)?|reply(?:\s+with)?|respond(?:\s+with)?|text|type|respon(?:eu)?|escriu(?:re)?)\s+(?:(?:con|a|amb|with)\s+)?(?:(?:la (?:palabra|paraula)|el (?:texto|codigo)|the word)\s+)?[*_«“"'‘]*(?:baja|baixa|stop|unsubscribe|info(?:rmacion)?)(?![\p{L}\d_])[*_»”"'’]*/giu;
const standaloneQuote = /(?:^|\n)\s*>[^\n]*|[«“"]\s*(?:baja|baixa|stop|unsubscribe|no me (?:escribas|escribais|contactes|contacteis)(?: mas)?|dame de baja)\s*[»”"]/giu;

function campaignCopy(text) {
  const source = normalize(text);
  const rest = source.replace(instruction, ' ').replace(standaloneQuote, ' ');
  return {quoted:rest !== source, rest};
}

// These phrases refer to a medical leave or explicitly keeping a subscription.
function withdrawalText(text) {
  return campaignCopy(text).rest
    .replace(/\bbaja (?:laboral|medica|por (?:enfermedad|maternidad|paternidad|incapacidad))\b/g,' ')
    .replace(/\bno (?:quiero|deseo|solicito|pido) (?:la baja|(?:darme|darnos) de baja|que me (?:deis|den|des) de baja)\b/g,' ');
}

const appointment = /\b(?:mi|mis|nuestra|la|las|una|esta|esa|su)\s+citas?\b|\b(?:mi|la|una)\s+(?:reserva|visita|consulta|hora)\b|\b(?:tengo|tenia|tenemos)\s+(?:(?:una?|la)\s+)?cita\b/;
const change = /\b(?:cambi\w*|cancel\w*|anul\w*|reprogram\w*|reagend\w*|aplaz\w*|adelant\w*|confirm\w*|modific\w*|mover|movamos|pospon\w*|traslad\w*|record\w*|recuerd\w*)\b/;
const askTime = /\b(?:cuando|a que hora|que dia|donde)\b/;
const mixed = /\b(?:precio\w*|presupuesto\w*|tarifa\w*|cuanto (?:cuestan?|valen?|salen?)|oferta\w*|bono\w*|promocion\w*|descuento\w*)\b/;
function appointmentIntent(text) {
  const value = normalize(text);
  const existing = appointment.test(value) && (change.test(value) || (askTime.test(value) && /\b(?:mi|mis|tengo|tenia|tenemos|reservad\w*|programad\w*)\b/.test(value)));
  if (!existing) return null;
  return mixed.test(value) ? 'mixed_appointment_interest' : 'appointment_management';
}

function postTreatmentFollowUp(text) {
  const value = normalize(text);
  // First-person reports about a result that has already occurred. Prospective questions about efficacy stay eligible.
  return /\b(?:no|apenas)\s+me\s+(?:ha\s+hecho|hizo|hace)\s+(?:ningun\s+|mucho\s+|apenas\s+)?efecto\b/.test(value)
    || /\b(?:no he notado|no noto|no he visto|sigo sin (?:notar|ver))\s+(?:(?:ningun(?:a)?|el|los|la)\s+)?(?:efecto|resultados?|mejoria|cambios?)\b/.test(value)
    || /\b(?:despues de|tras|desde)\s+(?:mi |el |la |la ultima |mi ultima )(?:tratamiento|sesion|inyeccion|intervencion)\b.{0,90}\b(?:me duele|me ha salido|tengo dolor|sigo con|me ha quedado)\b/.test(value);
}

module.exports = {campaignCopy, appointmentIntent, withdrawalText, postTreatmentFollowUp};
