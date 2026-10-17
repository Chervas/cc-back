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
function standardDraft(clinic = null) {
  // A new, reviewable draft only. Reuse the complete pinned patient-supplied
  // source rather than inventing a shorter notice. Regional/services/website
  // clauses remain explicit for review; this never rewrites published models
  // or signed snapshots and it does not claim legal applicability elsewhere.
  const draft = bsDraft();
  draft.body_json.registration_privacy.source = 'standard';
  draft.body_json.registration_privacy.source_review_required = ![66, 72].includes(Number(clinic?.id_clinica));
  return require('./registration-privacy-spelling').correctDraft(draft);
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
