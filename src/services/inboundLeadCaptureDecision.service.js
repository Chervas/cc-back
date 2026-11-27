'use strict';

const { campaignCopy, postTreatmentFollowUp, appointmentIntent } = require('../lib/inbound-commercial-language');
const { classifyInterest, explicitOptOut, asksForCommercialInformation } = require('./socialLeadInterestClassification.service');
const verdict = (kind, reason) => ({ kind, privateRequested: false, ...(reason ? { reason } : {}) });
const normalize = value => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\*/g, '').trim();
const greeting = /^(?:hola|buenos dias|buenas(?: tardes| noches)?|buen dia)\b[\s,.!¡]*/u;

function simpleDecision(entry, optedOut) {
  if (optedOut || explicitOptOut(entry.text)) return verdict('opt_out');
  if (campaignCopy(entry.text).quoted) return verdict('ignore', 'quoted_campaign');
  if (postTreatmentFollowUp(entry.text)) return verdict('ignore', 'post_treatment_follow_up');
  const appointment = appointmentIntent(entry.text);
  if (appointment) return verdict(appointment === 'appointment_management' ? 'ignore' : 'review', appointment);
  if (entry.channel === 'whatsapp' && asksForCommercialInformation(entry.text)) return verdict('interest');
  return null;
}

async function classifyDecision(entry, options, classify = classifyInterest) {
  const result = await classify(entry, options);
  if (!result || !['interest', 'ignore', 'review', 'opt_out'].includes(result.kind) || typeof result.privateRequested !== 'boolean')
    throw Object.assign(Error('inbound_capture_classifier_invalid'), {code:'inbound_capture_classifier_invalid'});
  return { kind: result.kind, privateRequested: result.privateRequested };
}

function optionName(text) {
  return text.trim().replace(/^(?:(?:el|la|los|las)\s+)?(?:de(?:l| la| los| las)?\s+)?/u, '').trim();
}

function selectsOfferedOption(reply, campaignText) {
  if (!reply || reply.length > 120 || !campaignText) return false;
  const body = normalize(reply).replace(/\s+/gu, ' ').replace(/^¡/u,'').replace(greeting, '')
    .replace(/^(?:si\b[,.! ]*|(?:me interesa|quiero|quisiera|prefiero)\s+)/u, '')
    .replace(/[,.! ]*(?:por favor|gracias)[.! ]*$/u, '').replace(/[.,!]+$/u, '').trim();
  const choice = optionName(body);
  if (!/^[\p{L}]+(?: [\p{L}]+){0,5}$/u.test(choice) ||
      /\b(?:no|ni|sin|hola|baja|stop|gracias|cita|consulta medica|dolor|sintomas?|ningun[oa]?|si|quizas|todo|nada)\b/u.test(choice)) return false;
  // Only the options in an invitation count. Mentions elsewhere in the campaign (including its footer) do not.
  const questions = normalize(campaignText.slice(0, 12000)).split(/[¿?!.\n]/u);
  return questions.some(sentence => {
    const listed = /^(?:(?:quieres|quiere|te gustaria) (?:ver|conocer|recibir) (?:nuestras? |las? |los? )?(?:promos?|promociones|ofertas?|descuentos?|bonos?|tratamientos?) (?:de|para|en)\s+|que (?:zona|tratamiento|promo|promocion|oferta) (?:te interesa|prefieres)\s*[:,]\s*|elige (?:entre|tu (?:zona|tratamiento|promo)\s*:)\s*)(.+)$/u.exec(sentence.trim());
    if (!listed) return false;
    const options = listed[1].split(/\s*[,/]\s*|\s+(?:y|o|e|u)\s+/u).map(optionName);
    return options.includes(choice);
  });
}

function contextPreserved(messages) {
  return messages.every(m => m.direction === 'inbound' && m.message_type === 'text' &&
    typeof m.content === 'string' && /^(?:¡?hola|buenos dias|buenas(?: tardes| noches)?|buen dia)[!. ]*$/u.test(normalize(m.content)));
}

function eligibleChoice(decision, text, offer) {
  return !decision.reason && ['review', 'ignore'].includes(decision.kind) && selectsOfferedOption(text, offer);
}

function selectedDecision() {
  return { kind: 'interest', privateRequested: false, campaignChoice: true };
}

async function simulate({ campaignText, message, history, optedOut }, scope) {
  const entry = { channel:'whatsapp', type:'dm', source:'new', echo:false, text:message };
  let decision = simpleDecision(entry, optedOut);
  if (!decision) decision = await classifyDecision(entry, scope);
  if (eligibleChoice(decision, message, campaignText) &&
      contextPreserved(history.map(content => ({ direction:'inbound', message_type:'text', content }))))
    decision = selectedDecision();
  const reasons = { interest:'commercial_information', review:'intent_ambiguous', ignore:'ignored',
    opt_out:optedOut ? 'prior_opt_out' : 'explicit_opt_out' };
  return { kind:decision.kind, reason:decision.reason || (decision.campaignChoice ? 'campaign_choice' : reasons[decision.kind]) };
}

module.exports = { simpleDecision, classifyDecision, eligibleChoice, selectedDecision, contextPreserved, simulate };
