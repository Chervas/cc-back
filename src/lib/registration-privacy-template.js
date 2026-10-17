'use strict';
const SCHEMA = 'cc-registration-privacy/v1';
const CHOICE_SCHEMA = 'cc-registration-choices/v2';
const IDENTITY_SCHEMA = 'cc-registration-identity/v2';
const CHOICE_LABELS = Object.freeze({
  health_nonmedical: 'Consiento el tratamiento de los datos de salud necesarios para la prestación de los servicios no sanitarios.',
  commercial: 'Deseo recibir comunicaciones comerciales sobre los servicios, ofertas y actividades de la clínica.',
  financing: 'Autorizo la cesión de mis datos para tramitar la financiación que solicite de mi tratamiento.',
  sms_whatsapp: 'Autorizo el contacto por SMS y WhatsApp para gestionar mis citas y mi atención. Esta opción no autoriza comunicaciones comerciales.',
});
const object = require('./registration-privacy-configuration').object;
function schema(body) { const registration = object(body).registration_privacy;
  return registration?.schema_version === SCHEMA && registration.identity_editable === true
    && ['standard', 'clinic'].includes(registration.source); }
const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
function render(version, context, renderHtml) {
  const source = version.body_html || object(version.body_json).html || '';
  const content = String(source).replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_match, key) => {
    const value = key.split('.').reduce((node, part) => node && Object.hasOwn(node, part) ? node[part] : '', context);
    return escape(value ?? '');
  });
  const identity = require('./bs-privacy-digital-template').buildBsPrivacyDigitalHtml(context).html
    .match(/<section class="consent-patient-identity">[\s\S]*?<\/section>/)?.[0] || '';
  return '<section class="registration-privacy" data-consent-presentation="' + SCHEMA + '">'
    + identity + content + '</section>';
}
function form(keys = ['commercial', 'sms_whatsapp']) {
  return { schema_version: CHOICE_SCHEMA, fields: keys.map(key => ({ key, type: 'yes_no', required: true, label: CHOICE_LABELS[key] })) };
}
function standardDraft() {
  // Existing system catalogue wording, with factual controller variables. This
  // is a reviewable draft, not an automatically published legal opinion.
  return { title: 'Información de protección de datos y asistencia sanitaria', body_html: [
    '<h2>Información de protección de datos y asistencia sanitaria</h2>',
    '<p><strong>Responsable:</strong> {{responsable.razon_social}} · {{responsable.cif}}</p>',
    '<p><strong>Dirección:</strong> {{responsable.direccion}} · <strong>Contacto:</strong> {{responsable.email}} · {{responsable.telefono}}</p>',
    '<p><strong>Delegado de protección de datos:</strong> {{responsable.dpo_nombre}} · {{responsable.dpo_email}}</p>',
    '<p>La clínica informa al paciente de que sus datos personales, incluidos datos de salud, serán tratados para prestarle asistencia sanitaria, gestionar su historia clínica, organizar citas, emitir presupuestos, cumplir obligaciones legales y mantener comunicaciones necesarias sobre su atención.</p>',
    '<p>El paciente declara haber recibido esta información de forma clara y comprensible, y entiende que puede solicitar información adicional sobre responsable del tratamiento, derechos de acceso, rectificación, supresión, oposición, limitación y portabilidad, así como sobre los canales habilitados para ejercerlos.</p>',
    '<p>Las comunicaciones comerciales, la cesión de datos no necesaria para la asistencia y el uso publicitario de imágenes requieren autorizaciones separadas y opcionales.</p>',
  ].join('\n'), body_json: { registration_privacy: { schema_version: SCHEMA, identity_editable: true, source: 'standard' }, consent_form: form() } };
}
function bsDraft() {
  const source = require('./bs-privacy-digital-template'), choices = require('./consent-document-choices');
  let html = source.buildBsPrivacyDigitalHtml().html.replace(/^<section\b[^>]*><h2>Protección de datos<\/h2>\n/, '').replace(/<\/section>$/, '');
  // Only verified factual controller values become variables. Resolving the
  // pinned BS values must recover the complete approved legal body byte exact.
  for (const [literal, token] of [
    ['INSTITUTO OBES ALICANTE S.L.', '{{responsable.razon_social}}'],
    ['B54847090', '{{responsable.cif}}'], ['C/ ARQUITECTO MORELL 9 BAJO 03003 ALICANTE', '{{responsable.direccion}}'],
    ['966283955', '{{responsable.telefono}}'], ['info@bsmedical.es', '{{responsable.email}}'],
    ['dpo@bsmedical.es', '{{responsable.dpo_email}}'],
  ]) html = html.split(literal).join(token);
  const fields = choices.CHOICE_KEYS.map(key => key === 'sms'
    ? { key: 'sms_whatsapp', type: 'yes_no', required: true, label: CHOICE_LABELS.sms_whatsapp }
    : { key, type: 'yes_no', required: true, label: choices.CHOICE_LABELS[key] });
  return { title: 'Protección de datos · Alta de pacientes', body_html: html,
    body_json: { registration_privacy: { schema_version: SCHEMA, identity_editable: true, source: 'clinic',
      source_document_sha256: source.SOURCE_DOCUMENT_SHA256, previous_legal_body_sha256: source.LEGAL_BODY_SHA256 },
    consent_form: { schema_version: CHOICE_SCHEMA, fields } } };
}
module.exports = { SCHEMA, CHOICE_SCHEMA, IDENTITY_SCHEMA, CHOICE_LABELS, schema, render, form, standardDraft, bsDraft, escape };
