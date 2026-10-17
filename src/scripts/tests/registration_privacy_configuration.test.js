'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../../lib/registration-privacy-configuration');
const registration = require('../../lib/registration-privacy-template');
const choices = require('../../lib/consent-document-choices');
const digital = require('../../lib/bs-privacy-digital-template');
test('only configured registration is enabled outside legacy BS; medical questionnaire remains independent', () => {
  assert.equal(config.policy({ id_clinica: 66 }).legacy, true);
  assert.equal(config.policy({ id_clinica: 88 }).enabled, false);
  assert.equal(config.policy({ id_clinica: 88 }).beforeFirstCare, true, 'New configuration requests alta before first care by default');
  const clinic = { id_clinica: 88, configuracion: { patient_intake: { privacy_enabled: true,
    privacy_before_first_care: false, privacy_template_id: 19, medical_questionnaire_enabled: false } } };
  assert.deepEqual(config.policy(clinic), { enabled: true, beforeFirstCare: false, templateId: 19,
    legacy: false, catalogKey: null, medicalQuestionnaireEnabled: false });
  assert.equal(config.policy({ id_clinica: 66, configuracion: { patient_intake: { privacy_enabled: false } } }).enabled, false);
});
test('legal controller uses actual fiscal names, never the commercial brand; optional overrides merge and CAS is stable', () => {
  const clinic = { id_clinica: 88, nombre_clinica: 'Marca ficticia', datos_fiscales_clinica: {
    denominacion_social: 'Sociedad ficticia S.L.', cif_nif: 'QA-NO-REAL', direccion: 'Dirección fiscal' },
  configuracion: { patient_intake: { privacy_controller: { dpo_email: 'dpo@example.invalid' } } } };
  assert.equal(config.controller({ nombre_clinica: clinic.nombre_clinica }).legal_name, '');
  assert.equal(config.normalize(clinic).privacy_controller.legal_name, 'Sociedad ficticia S.L.');
  assert.equal(config.normalize(clinic).privacy_controller.tax_id, 'QA-NO-REAL');
  assert.equal(config.normalize(clinic).privacy_controller.dpo_email, 'dpo@example.invalid');
  assert.deepEqual(config.normalize(clinic).additional_documents, []);
  assert.equal(config.version(clinic), config.version(JSON.parse(JSON.stringify(clinic))));
  assert.notEqual(config.version(clinic), config.version({ ...clinic, datos_fiscales_clinica: { ...clinic.datos_fiscales_clinica, cif_nif: 'changed' } }));
});
test('settings reject foreign shape, implicit flags, duplicate extras and unsafe controller values', () => {
  for (const invalid of [{ privacy_enabled: 'true' }, { surprise: true }, { privacy_template_id: -1 },
    { privacy_controller: { legal_name: '<raw>\n' } }, { privacy_controller: { email: 'not-an-email' } },
    { additional_documents: [{ template_id: 3, required: 'yes', sort_order: 0 }] },
    { additional_documents: [{ template_id: 3, required: true, sort_order: 0 }, { template_id: 3, required: false, sort_order: 2 }] }]) {
    assert.throws(() => config.validate(invalid));
  }
  assert.deepEqual(config.validate({ additional_documents: [{ template_id: 3, required: false, sort_order: 1 }] }),
    { additional_documents: [{ template_id: 3, required: false, sort_order: 1 }] });
});
test('new choices have one explicit SMS/WhatsApp answer, never reinterpret legacy SMS or infer any Yes', () => {
  const current = registration.form(), doc = { id: 1, snapshot_json: { version: { body_json: { consent_form: current } } } };
  assert.deepEqual(current.fields.map(row => row.key), ['commercial', 'sms_whatsapp']);
  assert.deepEqual(choices.documentChoiceEvidence(doc, { document_choices: { 1: { schema_version: current.schema_version,
    answers: { commercial: 'no', sms_whatsapp: 'no' } } } }).answers, { commercial: 'no', sms_whatsapp: 'no' });
  for (const answers of [{ commercial: 'yes', sms: 'yes' }, { commercial: 'no' }, { commercial: true, sms_whatsapp: 'yes' }]) {
    assert.throws(() => choices.documentChoiceEvidence(doc, { document_choices: { 1: { schema_version: current.schema_version, answers } } }));
  }
  assert.equal(choices.validateForm(digital.buildBsPrivacyDigitalHtml().consent_form).schema_version, 'bs-lopd-choices/v1');
});
test('BS new version preserves the approved legal clauses after exact factual variable resolution', () => {
  const source = registration.bsDraft();
  const context = { responsable: { razon_social: 'INSTITUTO OBES ALICANTE S.L.', cif: 'B54847090',
    direccion: 'C/ ARQUITECTO MORELL 9 BAJO 03003 ALICANTE', telefono: '966283955', email: 'info@bsmedical.es', dpo_email: 'dpo@bsmedical.es' } };
  const expected = digital.buildBsPrivacyDigitalHtml().html.replace(/^<section\b[^>]*><h2>Protección de datos<\/h2>\n/, '').replace(/<\/section>$/, '');
  const rendered = registration.render(source, context);
  assert.equal(rendered, '<section class="registration-privacy" data-consent-presentation="cc-registration-privacy/v1">' + expected + '</section>');
  assert.deepEqual(source.body_json.consent_form.fields.slice(0, 3), digital.buildBsPrivacyDigitalHtml().consent_form.fields.slice(0, 3));
  assert.equal(source.body_json.consent_form.fields[3].key, 'sms_whatsapp');
  assert.equal(source.body_json.digital_presentation, undefined);
});
test('generic standard uses native identity and escapes both patient and clinic variables', () => {
  const source = registration.standardDraft();
  assert(registration.schema(source.body_json));
  const html = registration.render(source, { paciente: { nombre_completo: '<Ficticio>', email: 'qa@example.invalid' },
    responsable: { razon_social: '<Sociedad>', cif: 'QA', direccion: 'A&B', email: 'qa@example.invalid' } });
  assert(html.includes('consent-patient-identity'));
  assert(html.includes('&lt;Ficticio&gt;')); assert(html.includes('&lt;Sociedad&gt;')); assert(html.includes('A&amp;B'));
  assert(!html.includes('INSTITUTO OBES')); assert(!html.includes('{{'));
});
test('the new standard draft contains the complete pinned original, four explicit decisions and provenance; BS source is immutable', () => {
  const before = JSON.stringify(registration.bsDraft()), source = registration.standardDraft({ id_clinica: 88 });
  const bs = registration.bsDraft();
  assert.equal(source.title, bs.title); assert.equal(source.body_html, bs.body_html);
  assert.equal(source.body_json.registration_privacy.source, 'standard');
  assert.equal(source.body_json.registration_privacy.source_document_sha256, digital.SOURCE_DOCUMENT_SHA256);
  assert.equal(source.body_json.registration_privacy.previous_legal_body_sha256, digital.LEGAL_BODY_SHA256);
  assert.equal(source.body_json.registration_privacy.source_review_required, true);
  for (const id_clinica of [66, 72]) assert.equal(registration.standardDraft({ id_clinica }).body_json.registration_privacy.source_review_required, false);
  assert.deepEqual(source.body_json.consent_form, bs.body_json.consent_form);
  assert.deepEqual(source.body_json.consent_form.fields.map(row => row.key), ['health_nonmedical', 'commercial', 'financing', 'sms_whatsapp']);
  assert(source.body_html.includes('Ley 10/2014')); assert(source.body_html.includes('www.bsmedical.es'));
  assert(source.body_html.includes('¿A qué destinatarios se comunicarán sus datos personales?'));
  assert(!source.body_html.includes('Datos del paciente'), 'The engine renders identity once, independently from the legal text');
  assert.equal(JSON.stringify(registration.bsDraft()), before);
});
