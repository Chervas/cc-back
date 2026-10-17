'use strict';

// A bounded identity correction for the single approved BS privacy document.
// This is not the medical questionnaire, a template editor or a patient-profile
// write API. Corrections belong to the issued/signed document only.
const digital = require('./bs-privacy-digital-template');
const choices = require('./consent-document-choices');
const SCHEMA_VERSION = 'bs-lopd-identity/v1';
const PRIVACY_KEY = 'bs-final-20261015-' + digital.SOURCE_DOCUMENT_SHA256;
const FIELDS = Object.freeze([
  ['nombre', 'Nombre', 'text', true, 150], ['apellidos', 'Apellidos', 'text', true, 200],
  ['dni', 'DNI, NIE o pasaporte', 'text', false, 40],
  ['fecha_nacimiento', 'Fecha de nacimiento', 'date', false, 10],
  ['compania', 'Compañía', 'text', false, 150],
  ['direccion', 'Dirección', 'text', false, 250], ['codigo_postal', 'Código postal', 'text', false, 20],
  ['ciudad', 'Población', 'text', false, 120], ['provincia', 'Provincia', 'text', false, 120],
  ['telefono', 'Teléfono móvil', 'tel', false, 40], ['telefono2', 'Teléfono fijo u otro teléfono', 'tel', false, 40],
  ['email', 'Correo electrónico', 'email', false, 254],
].map(([key, label, type, required, max_length]) => Object.freeze({ key, label, type, required, max_length })));
const KEYS = FIELDS.map(field => field.key);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const object = value => { if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return {}; } } return record(value) ? value : {}; };
const plain = row => row?.toJSON ? row.toJSON() : row;
function failure(code, message, statusCode = 400, field = null) {
  return Object.assign(new Error(message), { code, statusCode,
    details: { reason_code: code, ...(field ? { field } : {}) } });
}
function isIdentityDocument(document) {
  const doc = plain(document), snapshot = object(doc?.snapshot_json), template = object(snapshot.template);
  if (doc?.purpose === 'data_protection' && require('./registration-privacy-template').schema(object(snapshot.version).body_json)) {
    return Number(template.id) === Number(doc.clinic_template_id) && Number(template.clinic_id) === Number(doc.clinica_id)
      && Number(snapshot.context?.paciente?.id) === Number(doc.paciente_id) && Number(snapshot.context?.clinica?.id) === Number(doc.clinica_id)
      && typeof snapshot.version.body_html === 'string' && !!snapshot.version.body_html.trim();
  }
  return [66, 72].includes(Number(doc?.clinica_id)) && doc.purpose === 'data_protection'
    && Number(template.id) === Number(doc.clinic_template_id)
    && Number(template.clinic_id) === Number(doc.clinica_id) && template.catalog_key === PRIVACY_KEY
    && Number(snapshot.context?.paciente?.id) === Number(doc.paciente_id)
    && Number(snapshot.context?.clinica?.id) === Number(doc.clinica_id)
    && digital.isApprovedPrivacyPresentation({ bodyHtml: digital.buildBsPrivacyDigitalHtml().html,
      bodyJson: object(snapshot.version).body_json });
}
function isoDate(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : '';
}
function contextValues(context) {
  const patient = object(object(context).paciente);
  return Object.fromEntries(FIELDS.map(({ key }) => [key, key === 'fecha_nacimiento' ? isoDate(patient[key])
    : typeof patient[key] === 'string' ? patient[key] : '']));
}
function validateValues(raw, now = new Date()) {
  if (!record(raw) || Object.keys(raw).length !== KEYS.length || KEYS.some(key => !own(raw, key))) {
    throw failure('consent_personal_data_invalid', 'Revisa los campos de datos personales del documento.');
  }
  const values = {};
  for (const field of FIELDS) {
    const value = raw[field.key];
    if (typeof value !== 'string' || value.length > field.max_length || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw failure('consent_personal_data_invalid', `Revisa el campo «${field.label}».`, 400, field.key);
    }
    values[field.key] = value.replace(/\s+/gu, ' ').trim();
    if (field.required && !values[field.key]) throw failure('consent_personal_data_required',
      `Completa el campo «${field.label}».`, 400, field.key);
  }
  if (values.fecha_nacimiento) {
    const date = new Date(values.fecha_nacimiento + 'T00:00:00Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(values.fecha_nacimiento) || !Number.isFinite(date.getTime())
      || date.toISOString().slice(0, 10) !== values.fecha_nacimiento || values.fecha_nacimiento < '1850-01-01'
      || values.fecha_nacimiento > now.toISOString().slice(0, 10)) {
      throw failure('consent_personal_data_invalid', 'Revisa la fecha de nacimiento.', 400, 'fecha_nacimiento');
    }
  }
  if (values.email && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(values.email)) {
    throw failure('consent_personal_data_invalid', 'Revisa el correo electrónico.', 400, 'email');
  }
  for (const phone of ['telefono', 'telefono2']) {
    if (values[phone] && !/^\+?[\d ()/.\-]{5,40}$/u.test(values[phone])) {
      throw failure('consent_personal_data_invalid', 'Revisa el teléfono.', 400, phone);
    }
  }
  return values;
}
function identityConfirmed(document) {
  const snapshot = object(plain(document)?.snapshot_json), evidence = object(snapshot.patient_identity);
  if (evidence.schema_version !== identitySchema(document) || evidence.confirmed !== true
    || !Number.isFinite(new Date(evidence.confirmed_at).getTime())) return false;
  try { return JSON.stringify(validateValues(evidence.values)) === JSON.stringify(contextValues(snapshot.context)); }
  catch { return false; }
}
function publicDocumentPersonalData(document) {
  const doc = plain(document);
  if (!isIdentityDocument(doc)) return {};
  return { personal_data_form: { schema_version: identitySchema(doc), fields: FIELDS.map(field => ({ ...field })),
    values: contextValues(object(doc.snapshot_json).context),
    editable: ['pending', 'sent', 'viewed'].includes(doc.status) && !doc.signed_at && !doc.revoked_at,
    confirmed: identityConfirmed(doc) } };
}
function assertRenderedIdentity(document) {
  const doc = plain(document), snapshot = object(doc.snapshot_json);
  if (doc.snapshot_html !== renderedIdentity(snapshot)
    || doc.snapshot_hash !== choices.choiceSnapshotHash(snapshot, doc.snapshot_html)) {
    throw failure('consent_personal_data_snapshot_invalid', 'El documento ha cambiado. Vuelve a abrirlo antes de continuar.', 409);
  }
}
function validateSnapshotMap(payload, documents) {
  if (!own(payload, 'document_snapshot_hashes')) return;
  const map = payload.document_snapshot_hashes, ids = new Set(documents.map(row => String(plain(row).id)));
  if (!record(map) || Object.keys(map).length > 100 || Object.keys(map).some(id => !ids.has(id)
    || !/^[1-9]\d*$/.test(id) || !/^[a-f0-9]{64}$/.test(map[id]))) {
    throw failure('consent_personal_data_scope_invalid', 'Los datos no corresponden a los documentos seleccionados.');
  }
}
function assertReadyToSign(document, payload) {
  const doc = plain(document);
  if (!isIdentityDocument(doc)) return;
  assertRenderedIdentity(doc);
  if (!identityConfirmed(doc)) throw failure('consent_personal_data_confirmation_required',
    'Revisa y confirma tus datos personales antes de firmar.', 409);
  if (payload?.document_snapshot_hashes?.[String(doc.id)] !== doc.snapshot_hash) {
    throw failure('consent_personal_data_changed', 'El documento ha cambiado. Revisa tus datos de nuevo antes de firmar.', 409);
  }
}
function payloadForDocument(document, payload) {
  if (!own(payload, 'document_snapshot_hashes')) return payload;
  const id = String(plain(document).id), map = payload.document_snapshot_hashes;
  return { ...payload, document_snapshot_hashes: record(map) && own(map, id) ? { [id]: map[id] } : {} };
}
function correctedSnapshot(document, payload, requestMeta = {}, now = new Date()) {
  const doc = plain(document), snapshot = object(doc.snapshot_json);
  if (!isIdentityDocument(doc)) throw failure('consent_personal_data_not_available',
    'Este documento no permite modificar los datos personales.', 409);
  if (!record(payload) || Object.keys(payload).some(key => !['schema_version', 'values', 'snapshot_hash'].includes(key))
    || payload.schema_version !== identitySchema(doc)) throw failure('consent_personal_data_schema_invalid',
    'Vuelve a abrir el documento para revisar los datos personales.');
  if (payload.snapshot_hash !== doc.snapshot_hash) throw failure('consent_personal_data_changed',
    'El documento ha cambiado. Vuelve a abrirlo antes de guardar los datos.', 409);
  assertRenderedIdentity(doc);
  const values = validateValues(payload.values, now), patient = { ...snapshot.context.paciente, ...values,
    nombre_completo: `${values.nombre} ${values.apellidos}`.trim(), documento: values.dni,
    fecha_nacimiento: values.fecha_nacimiento ? values.fecha_nacimiento.split('-').reverse().join('/') : '' };
  if (identitySchema(doc) === 'cc-registration-identity/v2') {
    patient.telefono_movil = values.telefono;
    patient.telefono_fijo = values.telefono2;
  }
  const next = { ...snapshot, context: { ...snapshot.context, paciente: patient },
    patient_flags: { ...snapshot.patient_flags,
      is_minor: snapshot.patient_flags?.is_minor === true || isMinorDate(values.fecha_nacimiento, now) },
    patient_identity: { schema_version: identitySchema(doc), confirmed: true, values,
      confirmed_at: now.toISOString(), previous_snapshot_hash: doc.snapshot_hash,
      source: 'public_document_identity', profile_updated: false,
      ip: typeof requestMeta.ip === 'string' ? requestMeta.ip.slice(0, 80) : null,
      user_agent: typeof requestMeta.userAgent === 'string' ? requestMeta.userAgent.slice(0, 500) : null } };
  const html = renderedIdentity(next);
  return { snapshot_json: next, snapshot_html: html, snapshot_hash: choices.choiceSnapshotHash(next, html) };
}
function identitySchema(document) {
  return require('./registration-privacy-template').schema(object(object(plain(document)?.snapshot_json).version).body_json)
    ? 'cc-registration-identity/v2' : SCHEMA_VERSION;
}
function renderedIdentity(snapshot) {
  return require('./registration-privacy-template').schema(object(snapshot.version).body_json)
    ? require('./registration-privacy-template').render(snapshot.version, snapshot.context)
    : digital.buildBsPrivacyDigitalHtml(snapshot.context).html;
}
function isMinorDate(date, now) {
  if (!date) return false;
  const [year, month, day] = date.split('-').map(Number);
  let age = now.getUTCFullYear() - year;
  if (now.getUTCMonth() + 1 < month || now.getUTCMonth() + 1 === month && now.getUTCDate() < day) age--;
  return age < 18;
}
module.exports = { SCHEMA_VERSION, FIELDS, isIdentityDocument, contextValues, validateValues,
  publicDocumentPersonalData, correctedSnapshot, validateSnapshotMap, assertReadyToSign, payloadForDocument };
