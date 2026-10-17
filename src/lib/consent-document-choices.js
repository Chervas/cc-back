'use strict';

// Bounded, versioned consent choices, not a form builder or a marketing grant.
// Read the patient's issued snapshot only, never the mutable live template.
const CHOICE_SCHEMA_VERSION = 'bs-lopd-choices/v1';
const CHOICE_HASH_ALGORITHM = 'sha256-canonical-json/v1';
const CHOICE_KEYS = Object.freeze(['health_nonmedical', 'commercial', 'financing', 'sms']);
const CHOICE_LABELS = Object.freeze({
  health_nonmedical: 'Consiento el tratamiento de los datos de salud necesarios para la prestación de los servicios no sanitarios.',
  commercial: 'Comunicados comerciales. Deseo recibir información promocional y comercial sobre los servicios, ofertas, promociones y actividades de bsmedical y bscapilar',
  financing: 'Tramitación de financiación de su tratamiento. Autorizo y consiento que mis datos sean cedidos a mediadores y empresas de financiación con la finalidad de tramitar la financiación que nos solicita de su tratamiento.',
  sms: 'Consiento el envío de SMS para confirmar la cita',
});
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const plain = value => value?.toJSON ? value.toJSON() : value;
const record = value => value && typeof value === 'object' && !Array.isArray(value);
function object(value) {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return {}; } }
  return record(value) ? value : {};
}
function failure(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode, details: { reason_code: code } });
}
const invalidSchema = () => failure('consent_document_choice_schema_invalid',
  'La configuración de las opciones del documento no es válida. Solicita una nueva revisión.', 409);
const invalidAnswers = () => failure('consent_document_choices_required',
  'Responde Sí o No a cada opción de protección de datos antes de firmar.');
const sameKeys = (value, expected) => record(value) && Object.keys(value).length === expected.length
  && expected.every(key => own(value, key));

function validateForm(raw) {
  if (raw?.schema_version === 'cc-registration-choices/v2') {
    const allowed = ['health_nonmedical', 'commercial', 'financing', 'sms_whatsapp'];
    if (!sameKeys(raw, ['schema_version', 'fields']) || !Array.isArray(raw.fields) || !raw.fields.length
      || raw.fields.length > allowed.length || new Set(raw.fields.map(field => field?.key)).size !== raw.fields.length) throw invalidSchema();
    return { schema_version: raw.schema_version, fields: raw.fields.map(field => {
      if (!sameKeys(field, ['key', 'type', 'required', 'label']) || !allowed.includes(field.key)
        || field.type !== 'yes_no' || field.required !== true || typeof field.label !== 'string'
        || !field.label.trim() || field.label.length > 1000 || /[\u0000-\u001f<>]/.test(field.label)) throw invalidSchema();
      return { ...field };
    }) };
  }
  if (!sameKeys(raw, ['schema_version', 'fields']) || raw.schema_version !== CHOICE_SCHEMA_VERSION
    || !Array.isArray(raw.fields) || raw.fields.length !== CHOICE_KEYS.length) throw invalidSchema();
  const fields = raw.fields.map((field, index) => {
    const key = CHOICE_KEYS[index];
    if (!sameKeys(field, ['key', 'type', 'required', 'label']) || field.key !== key
      || field.type !== 'yes_no' || field.required !== true || field.label !== CHOICE_LABELS[key]) throw invalidSchema();
    return { key, type: 'yes_no', required: true, label: field.label };
  });
  return { schema_version: CHOICE_SCHEMA_VERSION, fields };
}

function getConsentChoiceForm(document) {
  const snapshot = object(plain(document)?.snapshot_json), version = object(snapshot.version);
  const body = object(version.body_json), variables = object(version.variable_schema);
  const hasBody = own(body, 'consent_form'), hasVariables = own(variables, 'consent_form');
  if (!hasBody && !hasVariables) return null; // Historical documents are unchanged.
  if (own(snapshot, 'integrity') && (!sameKeys(snapshot.integrity, ['algorithm'])
    || snapshot.integrity.algorithm !== CHOICE_HASH_ALGORITHM)) throw invalidSchema();
  const form = validateForm(hasBody ? body.consent_form : variables.consent_form);
  if (hasBody && hasVariables && JSON.stringify(validateForm(variables.consent_form)) !== JSON.stringify(form)) throw invalidSchema();
  return form;
}

function validateChoiceEntry(form, entry) {
  if (!sameKeys(entry, ['schema_version', 'answers']) || entry.schema_version !== form.schema_version
    || !sameKeys(entry.answers, form.fields.map(field => field.key))) throw invalidAnswers();
  const answers = {};
  for (const field of form.fields) {
    const answer = entry.answers[field.key];
    if (answer !== 'yes' && answer !== 'no') throw invalidAnswers();
    answers[field.key] = answer;
  }
  return { schema_version: form.schema_version, answers };
}

function validateDocumentChoiceMap(payload, documents) {
  if (!own(payload, 'document_choices')) return;
  const map = payload.document_choices;
  if (!record(map) || Object.keys(map).length > 100) throw invalidAnswers();
  const ids = new Set(documents.map(row => String(plain(row)?.id)));
  if (Object.keys(map).some(id => !/^[1-9]\d*$/.test(id) || !ids.has(id))) {
    throw failure('consent_document_choices_scope_invalid', 'Las opciones no corresponden a los documentos seleccionados.');
  }
}

function documentChoiceEvidence(document, payload = {}) {
  const row = plain(document), form = getConsentChoiceForm(row), map = payload.document_choices;
  const supplied = record(map) && own(map, String(row.id));
  if (!form) {
    if (supplied) throw failure('consent_document_choices_unexpected', 'Este documento no incluye esas opciones de firma.');
    return null;
  }
  if (!supplied) throw invalidAnswers();
  return validateChoiceEntry(form, map[String(row.id)]);
}

function signedConsentChoiceAnswers(document) {
  const row = plain(document);
  if (row?.status !== 'signed' || !row.signed_at) return null;
  try {
    const form = getConsentChoiceForm(row);
    if (!form) return null;
    const snapshot = object(row.snapshot_json);
    if (!sameKeys(snapshot.integrity, ['algorithm']) || snapshot.integrity.algorithm !== CHOICE_HASH_ALGORITHM
      || !/^[a-f0-9]{64}$/.test(row.snapshot_hash || '')
      || row.snapshot_hash !== choiceSnapshotHash(snapshot, row.snapshot_html || '')) return null;
    const evidence = object(snapshot.signature_evidence);
    if (evidence.accepted_statement !== true || !evidence.signed_at) return null;
    return validateChoiceEntry(form, evidence.consent_choices).answers;
  } catch { return null; }
}

function payloadForDocument(document, payload = {}) {
  if (!own(payload, 'document_choices')) return payload;
  const id = String(plain(document)?.id), map = payload.document_choices;
  return { ...payload, document_choices: record(map) && own(map, id) ? { [id]: map[id] } : {} };
}

function publicDocumentChoices(document) {
  const form = getConsentChoiceForm(document);
  return form ? { choice_form: form, choice_answers: signedConsentChoiceAnswers(document) } : {};
}

function appendSignedChoiceHtml(original, document, evidence) {
  if (!evidence) return original;
  const form = getConsentChoiceForm(document), canonical = validateChoiceEntry(form, evidence);
  const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const fields = form.fields.map(field => `<li><p>${escape(field.label)}</p><p><strong>${canonical.answers[field.key] === 'yes' ? '☑ Sí · ☐ No' : '☐ Sí · ☑ No'}</strong></p></li>`).join('\n');
  return String(original || '') + '\n<section class="consent-choice-evidence" data-consent-choice-schema="' + form.schema_version
    + '"><h2>Opciones indicadas al firmar</h2><ul>' + fields + '</ul></section>';
}

// MySQL's native JSON storage reorders object keys. New interactive documents
// use an explicit, deterministic receipt; historical hashes are not rewritten.
function choiceSnapshotHash(snapshot, renderedHtml) {
  const normalize = value => Array.isArray(value) ? value.map(normalize)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])])) : value;
  const serialized = JSON.parse(JSON.stringify({ ...snapshot, rendered_html: renderedHtml }));
  return require('node:crypto').createHash('sha256').update(JSON.stringify(normalize(serialized))).digest('hex');
}

module.exports = { CHOICE_SCHEMA_VERSION, CHOICE_HASH_ALGORITHM, CHOICE_KEYS, CHOICE_LABELS, validateForm, getConsentChoiceForm,
  validateDocumentChoiceMap, documentChoiceEvidence, signedConsentChoiceAnswers,
  payloadForDocument, publicDocumentChoices, appendSignedChoiceHtml, choiceSnapshotHash };
