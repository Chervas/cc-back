'use strict';
const { createHash } = require('node:crypto');
const FAMILY = 'clinicaclick_reenvio_datos_proxima_cita';
const COPY = Object.freeze({
  es: 'Hola {{1}}.\n\nTe reenvío los datos de tu próxima cita:\n\n📅 {{2}} a las {{3}}\n🏥 {{4}}\n📍 {{5}}\n\nSi necesitas cambiarla, escríbenos por aquí.',
  ca: 'Hola {{1}}.\n\nEt reenvio les dades de la teva propera cita:\n\n📅 {{2}} a les {{3}}\n🏥 {{4}}\n📍 {{5}}\n\nSi necessites canviar-la, escriu-nos per aquí.',
  en: 'Hello {{1}}.\n\nHere are the details of your upcoming appointment again:\n\n📅 {{2}} at {{3}}\n🏥 {{4}}\n📍 {{5}}\n\nIf you need to reschedule, please reply here.',
});
const date = value => new Date(typeof value === 'string' && /^\d{4}-\d\d-\d\d /.test(value) ? value.replace(' ', 'T') + 'Z' : value);
const phone = value => require('./phone').normalizePhoneE164(value);
const fail = (code, message, status = 409) => { throw Object.assign(new Error(message || code), { code, statusCode: status }); };
function validateAppointment(a, now = new Date()) {
  require('./appointment-synthetic-guard').assertNoSyntheticDispatch(a);
  if (!a || !['pendiente','info_enviada','info_confirmada','recordatorio_enviado','recordatorio_confirmado','reprogramada'].includes(a.estado)
    || a.es_provisional || !(date(a.inicio) > now)) fail('manual_appointment_ineligible', 'Sólo puedes reenviar datos de una cita futura y vigente.');
  const m = a.import_metadata || {};
  if (require('./whatsappAppointmentEligibility').importHeld(m)
    || m.notification_suppression?.appointment_details || m.notification_suppression?.appointmentDetails)
    fail('whatsapp_appointment_import_held', 'Esta cita conserva un bloqueo de comunicaciones.');
}
function templateValid(template, locale) {
  const components = template?.components;
  return !!COPY[locale] && template?.status === 'APPROVED' && template.category === 'UTILITY' && template.is_active
    && require('./whatsapp-template-locale').normalizeWhatsappLocale(template.language) === locale
    && !template.retired_at && !template.superseded_by_template_id && Array.isArray(components)
    && components.length === 1 && String(components[0].type).toUpperCase() === 'BODY'
    && components[0].text === COPY[locale];
}
function parameters(a, patient, clinic) {
  const zone = require('./availability-calendar').resolveClinicTimezone(clinic);
  const start = date(a.inicio);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: zone, day:'2-digit',month:'2-digit',year:'numeric',
    hour:'2-digit',minute:'2-digit',hourCycle:'h23' }).formatToParts(start).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
  const raw = clinic.direccion;
  const address = typeof raw === 'string' ? raw.trim() : String(raw?.formatted_address || raw?.formattedAddress || raw?.address || '').trim();
  const values = [String(patient.nombre || '').trim(), `${parts.day}-${parts.month}-${parts.year}`, `${parts.hour}:${parts.minute}`,
    String(clinic.nombre_clinica || '').trim(), address];
  if (values.some(v=>!v)) fail('manual_appointment_details_missing', 'Completa el nombre, la clínica y su dirección antes de reenviar.');
  return Object.fromEntries(values.map((value,index)=>[String(index+1),value]));
}
const render = (locale, params) => COPY[locale].replace(/\{\{(\d+)\}\}/g,(_,index)=>params[index] || '');
const revision = snapshot => createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
const localLabel = (value, clinic) => value ? new Intl.DateTimeFormat('en-GB', {timeZone:require('./availability-calendar').resolveClinicTimezone(clinic),
  day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(date(value)).replaceAll('/','-').replace(',','') : null;
module.exports = { FAMILY, COPY, date, phone, fail, validateAppointment, templateValid, parameters, render, revision, localLabel };
