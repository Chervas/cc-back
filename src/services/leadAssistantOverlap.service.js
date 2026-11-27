'use strict';

const { bookingProfileDurationMinutes } = require('../lib/booking-profile');
const { formatLocal } = require('../lib/availability-calendar');
const { LEAD_PATIENT_CONTEXT_TYPE } = require('../lib/lead-patient-context');

const firstVisits = ['primera_sin_trat', 'primera_con_trat'];
const activeStates = ['pendiente', 'info_enviada', 'info_confirmada', 'recordatorio_enviado',
  'recordatorio_confirmado', 'cambio_solicitado', 'reprogramada'];

// Only the clinic's published booking field is passed here. A lead's message,
// an advert or a model response cannot grant permission to share an appointment.
function allowsLeadPair(booking) {
  const sentences = String(booking || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .split(/[.!;\n]/);
  const operation = /\b(?:dobl|mont|solap|superpon)\w*|\b(?:dos|2)\s+leads?\s+(?:a la (?:vez|misma hora)|por (?:hora|hueco))\b/;
  const patientBooking = '(?:una? )?cita(?: (?:ya )?(?:agendada|reservada|programada))?'
    + '(?: a esa hora)? (?:de (?:un )?paciente|(?:que )?no (?:sea|es) (?:un )?lead|no lead)';
  const negativeAction = '(?:no|nunca) (?:se (?:puede |debe )?)?(?:mont|dobl|solap)\\w*';
  const protectPatients = new RegExp(negativeAction + ' (?:nunca )?(?:(?:a |dos )?pacientes|(?:sobre|con) (?:una? )?(?:cita de (?:un )?)?pacientes?)\\b', 'g');
  const patientClause = new RegExp('(?:' + negativeAction + ' )?(?:si|cuando) (?:ya )?hay (?:ya )?' + patientBooking
    + '(?:,? ' + negativeAction + ')?', 'g');
  const patientException = /\b(?:siempre y cuando|siempre que|salvo que|excepto si|si) no (?:hay|haya) (?:una? )?cita.{0,60}(?:no sea (?:un )?lead|de (?:un )?paciente)\b/;
  let enabled = false;
  for (const line of sentences) {
    if (!operation.test(line) || /[¿?]/.test(line)) continue;
    const rule = line.replace(patientClause, ' ').replace(protectPatients, ' ').split(patientException)[0].trim();
    if (!operation.test(rule)) continue;
    if (/\b(?:no|nunca|prohibid[oa]|evit\w*|sin)\b.{0,55}(?:dobl|mont|solap|superpon|dos leads|2 leads)/.test(rule)
      || /(?:dobl|mont|solap|superpon)\w*.{0,45}\b(?:prohibid[oa]|no permitid[oa])\b/.test(rule)) return false;
    if (!/\bleads?\b/.test(rule)) continue;
    // Qualifiers outside the supported rule cannot widen the permission.
    if (/\b(?:podria|quizas|consultar|preguntar|previa|siempre que|siempre y cuando|salvo|excepto|unicamente si|solo si|lunes|martes|miercoles|jueves|viernes|sabado|domingo|manana|tarde)\b|\d{1,2}:\d{2}/.test(rule)) continue;
    if (/\bsi\b/.test(rule) && !/\bsi (?:(?:ambos |los dos )?son leads|(?:ya )?hay (?:otro|un) lead)\b/.test(rule)) continue;
    if (/\b(?:pued[eo]n?|permite\w*|permitid[oa]s?|permitimos|autoriz\w+|citamos|agenda(?:mos|r)?|cita(?:r)?|debe[ns]?|podemos|admit\w*)\b.{0,95}(?:\b(?:dobl|mont|solap|superpon)\w*|\b(?:dos|2) leads? (?:a la (?:vez|misma hora)|por (?:hora|hueco))\b)/.test(rule)
      || /(?:^|[:,]\s*)\s*(?:doblar|montar|solapar|doblamos|montamos|solapamos)\b.{0,60}\bleads?\b/.test(rule)) enabled = true;
  }
  return enabled;
}

function simpleVisit(profile) {
  const [phase] = profile.phases;
  return profile.version <= 2 && profile.phases.length === 1 && phase.professionals.mode === 'any'
    && !phase.equipment_requirements?.length && !phase.staff_attention;
}

async function leadAppointments({ db, clinic, profile, start, end, doctorId, leadId, patientId, transaction, exactStart = false }) {
  const { Op } = db.Sequelize;
  const rows = await db.CitaPaciente.findAll({ where: {
    clinica_id: clinic.id_clinica, doctor_id: doctorId || { [Op.in]: profile.phases[0].professionals.ids },
    inicio: exactStart ? start : { [Op.gte]: start, [Op.lt]: end }, tipo_cita: { [Op.in]: firstVisits },
    estado: { [Op.in]: activeStates }, lead_intake_id: { [Op.ne]: null },
  }, attributes: ['id_cita', 'inicio', 'fin', 'doctor_id', 'instalacion_id', 'lead_intake_id', 'paciente_id', 'es_provisional'],
  raw: true, transaction });
  const candidates = rows.filter(r => r.lead_intake_id !== leadId && r.paciente_id !== patientId && !r.es_provisional);
  if (!candidates.length) return [];
  const ids = [...new Set(candidates.map(r => r.lead_intake_id))];
  const [leads, existing] = await Promise.all([
    db.LeadIntake.findAll({ where: { id: { [Op.in]: ids }, clinica_id: clinic.id_clinica, archived_at: null },
      attributes: ['id', 'call_outcome_appointment_id'], raw: true, transaction }),
    db.LeadAttributionAudit.findAll({ where: { lead_intake_id: { [Op.in]: ids },
      'attribution_steps.type': LEAD_PATIENT_CONTEXT_TYPE,
      [`attribution_steps.${LEAD_PATIENT_CONTEXT_TYPE}.relationship`]: { [Op.in]: ['existing_patient', 'possible_patient'] } },
    attributes: ['lead_intake_id'], raw: true, transaction }),
  ]);
  const linked = new Map(leads.map(r => [r.id, r.call_outcome_appointment_id]));
  const excluded = new Set(existing.map(r => r.lead_intake_id));
  return candidates.filter(r => linked.has(r.lead_intake_id) && !excluded.has(r.lead_intake_id)
    && (!linked.get(r.lead_intake_id) || linked.get(r.lead_intake_id) === r.id_cita));
}

// Drop exactly one proven first assessment from these two resources. The
// native solver still checks opening hours, clinic, doctor and room schedules.
function contextForPair(context, peer, start, end, roomId) {
  if (+new Date(peer.inicio) !== +start) return null;
  const revised = { ...context };
  for (const [key, id] of [['doctors', peer.doctor_id], ['installations', roomId]]) {
    const resource = context[key].get(id);
    if (!resource) return null;
    const intervals = resource.busy.filter(b => +new Date(b.start) < +end && +new Date(b.end) > +start);
    const sameRoom = context.installationKeys.get(roomId) === context.installationKeys.get(peer.instalacion_id);
    if (key === 'installations' && !sameRoom) {
      if (intervals.length) return null;
      continue;
    }
    if (!intervals.length || intervals.some(b => b.appointment_id !== peer.id_cita || b.can_share !== true
      || b.protected_attention_origin || +new Date(b.start) !== +new Date(peer.inicio) || +new Date(b.end) !== +new Date(peer.fin))) return null;
    revised[key] = new Map(context[key]);
    revised[key].set(id, { ...resource, busy: resource.busy.filter(b => b.appointment_id !== peer.id_cita) });
  }
  return revised;
}

async function pairedSlots(params, solve) {
  const { profile, context, now } = params;
  if (!simpleVisit(profile)) return [];
  const minutes = bookingProfileDurationMinutes(profile);
  const peers = await leadAppointments(params);
  return peers.flatMap(peer => {
    const start = new Date(peer.inicio);
    if (start < now) return [];
    const local = formatLocal(start, context.timeZone);
    const [phase] = profile.phases;
    const rooms = [...phase.installation_ids].sort((a, b) => Number(b === peer.instalacion_id) - Number(a === peer.instalacion_id));
    for (const roomId of rooms) {
      const modified = contextForPair(context, peer, start, new Date(+start + minutes * 60000), roomId);
      if (!modified) continue;
      const matches = solve({ profile, context: modified, date: local.slice(0, 10), now, stepMinutes: 1, exactStartLocal: local,
        limit: 1, selections: { [phase.key]: { doctor_id: peer.doctor_id, installation_id: roomId } } });
      const slot = matches.find(row => +new Date(row.start_at) === +start);
      if (slot) return [slot];
    }
    return [];
  });
}

// Called within the ordinary writer, after locking doctor, room and patient.
// A callback is deliberately a server-only capability, never a JSON input.
async function lockedPairContext({ db, clinic, profile, context, start, end, values, transaction }) {
  if (!simpleVisit(profile) || !firstVisits.includes(values.tipo_cita) || !values.lead_intake_id) return context;
  const peers = await leadAppointments({ db, clinic, profile, start, exactStart: true, doctorId: values.doctor_id,
    leadId: values.lead_intake_id, patientId: values.paciente_id, transaction });
  if (peers.length !== 1) return context;
  return contextForPair(context, peers[0], start, end, values.instalacion_id) || context;
}

module.exports = { allowsLeadPair, pairedSlots, lockedPairContext };
