'use strict';
const { createHash } = require('node:crypto');
const { formatDateLocal, resolveClinicTimezone } = require('./availability-calendar');
const { sameAppointmentTime } = require('./appointment-reschedule-reason');
const instant = value => {
  const raw = typeof value === 'string' && /^\d{4}-\d\d-\d\d \d/.test(value) ? value.replace(' ', 'T') + 'Z' : value;
  return new Date(raw);
};
const notice = name => /^(clinicaclick_confirmacion_datos_cita_|clinicaclick_cita_reprogramada_peticion_paciente|clinicaclick_recordatorio_(dia_antes|mismo_dia))/.test(name || '')
  && !/_sin_respuesta(?:_|$)/.test(name);

function assessment({ previous, values, actorId, messages, clinic, now = new Date(), decision }) {
  if (!previous?.id_cita || !previous.paciente_id || sameAppointmentTime(previous, values)
    || values.reschedule_reason === 'administrative_error') return null;
  const zone = resolveClinicTimezone(clinic), day = formatDateLocal(now, zone);
  const notices = messages.filter(message => notice(message.template_name || message.template_family_key)
    && Number.isFinite(instant(message.sent_at).getTime()) && formatDateLocal(instant(message.sent_at), zone) === day);
  if (!notices.length) return null;
  const start = instant(values.inicio).toISOString(), end = instant(values.fin).toISOString();
  const acknowledgement = createHash('sha256').update(JSON.stringify({ version: 1, actor: actorId,
    appointment: Number(previous.id_cita), patient: Number(previous.paciente_id), clinic: Number(previous.clinica_id),
    previous: [instant(previous.inicio).toISOString(), instant(previous.fin).toISOString()],
    target: [start, end], day, notices: notices.map(message => [Number(message.id), instant(message.sent_at).toISOString()]).sort((a,b) => a[0]-b[0]),
  })).digest('hex');
  const latest = [...notices].sort((a,b) => instant(b.sent_at) - instant(a.sent_at))[0];
  if (!decision || decision.acknowledgement !== acknowledgement || typeof decision.send !== 'boolean') {
    throw Object.assign(Error('Este paciente ya ha recibido hoy un aviso de cita en esta clínica.'), {
      code: 'appointment_notice_already_sent_today', statusCode: 409, status: 409,
      details: { acknowledgement, last_notice_at: instant(latest.sent_at).toISOString(), timezone: zone,
        appointment_id: Number(latest.appointment_id), notice_count: notices.length },
    });
  }
  return { version: 1, actor_id: actorId, checked_at: now.toISOString(), send: decision.send,
    appointment_id: Number(previous.id_cita), patient_id: Number(previous.paciente_id), clinic_id: Number(previous.clinica_id),
    start_at: start, end_at: end, acknowledgement, previous_message_ids: notices.map(message => Number(message.id)) };
}

async function checkRescheduleNotice({ db, previous, values, clinic, actorId, decision, transaction, now = new Date() }) {
  if (!previous?.id_cita || !previous.paciente_id || sameAppointmentTime(previous, values)
    || values.reschedule_reason === 'administrative_error') return null;
  const [messages] = await db.sequelize.query(`SELECT m.id, COALESCE(m.sent_at,m.createdAt) AS sent_at,
      JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.template_name')) AS template_name,
      JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.template_family_key')) AS template_family_key,
      e.trigger_entity_id AS appointment_id
    FROM Conversations c JOIN Messages m ON m.conversation_id=c.id
    JOIN FlowExecutionsV2 e ON e.id=CAST(JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.execution_id')) AS UNSIGNED)
    WHERE c.clinic_id=:clinic AND c.patient_id=:patient AND c.channel='whatsapp'
      AND e.clinic_id=c.clinic_id AND e.trigger_entity_type='appointment'
      AND e.trigger_type IN ('appointment_created','appointment_rescheduled','appointment_reminder_window')
      AND m.direction='outbound' AND m.message_type<>'event' AND m.status IN ('sent','delivered','read')
      AND COALESCE(m.sent_at,m.createdAt)>=:since
    ORDER BY m.id DESC LIMIT 100`, { replacements: { clinic: Number(previous.clinica_id), patient: Number(previous.paciente_id),
      since: new Date(now.getTime() - 48 * 3600000) }, transaction });
  return assessment({ previous, values, actorId, messages, clinic, now, decision });
}

function suppressRescheduleNotice(appointment) {
  const receipt = appointment.import_metadata?.reschedule_notice;
  return receipt?.version === 1 && receipt.send === false && Number(receipt.appointment_id) === Number(appointment.id_cita)
    && Number(receipt.patient_id) === Number(appointment.paciente_id) && Number(receipt.clinic_id) === Number(appointment.clinica_id)
    && instant(receipt.start_at).getTime() === instant(appointment.inicio).getTime()
    && instant(receipt.end_at).getTime() === instant(appointment.fin).getTime();
}

module.exports = { assessment, checkRescheduleNotice, suppressRescheduleNotice };
