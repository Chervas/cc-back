'use strict';

// Registration privacy is independent of treatment consents. Reading this
// service never prepares a package, starts care, sends a message or signs.
const CLINICS = Object.freeze([66, 72]);
const FINAL_PRIVACY_KEY = 'bs-final-20261015-e31760491bf0929ca25a4976f4f2c463cece9af7a41ecb6c0e84508aaddb741f';
const { createHash } = require('node:crypto');
const plain = row => row?.toJSON ? row.toJSON() : row;
const object = value => { if (typeof value === 'string') { try { return JSON.parse(value); } catch { return {}; } } return value || {}; };
const fail = (code, message) => { throw Object.assign(new Error(message), { code, statusCode: 409,
  details: { action: 'prepare_patient_privacy' } }); };

// Presentation-only replacements must not revoke an already valid signature.
// The exceptional family is pinned in server code, never accepted from a
// caller's equivalence flag. Every historical row remains immutable.
async function approvedPrivacyVersions({ db, template, version, transaction, publishedVersions = null }) {
  const registration = require('../lib/registration-privacy-template');
  if (registration.schema(version.body_json) || require('../lib/consent-document-blocks').versionBlocks(version, template)) {
    const approved = new Map([[Number(version.id), { version, registration: true }]]);
    const layoutOnly = require('../lib/consent-document-blocks').unchangedPrivacyLayout(version, template);
    // New channel choices never reinterpret old SMS answers. Existing verified
    // BS evidence remains equivalent only for the unchanged legal notice gate.
    if (template.catalog_key === FINAL_PRIVACY_KEY || layoutOnly) {
      const previous = publishedVersions || await db.ClinicConsentTemplateVersion.findAll({ where: {
        clinic_template_id: Number(template.id), status: 'published', locale: 'es' },
      order: [['version', 'DESC'], ['id', 'DESC']], limit: 101, transaction });
      if (previous.length > 100) fail('appointment_consent_privacy_configuration', 'Revisa las versiones de protección de datos.');
      for (const raw of previous) {
        const old = plain(raw), digital = require('../lib/bs-privacy-digital-template');
        if (Number(old.clinic_template_id) !== Number(template.id) || old.status !== 'published' || old.locale !== 'es') continue;
        if (Number(old.id) !== Number(version.id) && Number(old.version) < Number(version.version) && layoutOnly && registration.schema(old.body_json)
          && old.body_html === version.body_html
          && JSON.stringify(canonical(object(old.body_json).consent_form)) === JSON.stringify(canonical(object(version.body_json).consent_form))
          && (!object(old.body_json).document_blocks || require('../lib/consent-document-blocks').unchangedPrivacyLayout(old, template))) {
          approved.set(Number(old.id), { version: old, registration: true, layoutEquivalent: true });
          continue;
        }
        const isDigital = digital.isApprovedPrivacyPresentation({ bodyHtml: old.body_html, bodyJson: old.body_json });
        const legacy = createHash('sha256').update(String(old.body_html || '')).digest('hex') === digital.APPROVED_LEGACY_HTML_SHA256;
        if (isDigital || legacy) approved.set(Number(old.id), { version: old, digital: isDigital, legacy });
      }
    }
    return approved;
  }
  const digital = require('../lib/bs-privacy-digital-template');
  const currentDigital = digital.isApprovedPrivacyPresentation({ bodyHtml: version.body_html, bodyJson: version.body_json });
  const approved = new Map([[Number(version.id), { version, legacy: false, digital: currentDigital }]]);
  if (!currentDigital) return approved;
  const { Op } = db.Sequelize;
  const previous = publishedVersions || await db.ClinicConsentTemplateVersion.findAll({ where: {
    clinic_template_id: Number(template.id), status: 'published', locale: 'es', id: { [Op.ne]: Number(version.id) },
  }, order: [['version', 'DESC'], ['id', 'DESC']], limit: 101, transaction, lock: transaction.LOCK.SHARE });
  if (previous.length > 100) fail('appointment_consent_privacy_configuration', 'Revisa las versiones publicadas de protección de datos.');
  const choices = require('../lib/consent-document-choices');
  for (const raw of previous) {
    const old = plain(raw);
    if (!Number.isSafeInteger(Number(old?.id)) || Number(old.id) <= 0
      || Number(old.clinic_template_id) !== Number(template.id) || old.status !== 'published' || old.locale !== 'es') continue;
    const isDigital = digital.isApprovedPrivacyPresentation({ bodyHtml: old.body_html, bodyJson: old.body_json });
    const isLegacy = createHash('sha256').update(String(old.body_html || '')).digest('hex') === digital.APPROVED_LEGACY_HTML_SHA256;
    if (!isDigital && !isLegacy) continue;
    try {
      if (!choices.getConsentChoiceForm({ snapshot_json: { version: { body_json: old.body_json, variable_schema: old.variable_schema } } })) continue;
      approved.set(Number(old.id), { version: old, legacy: isLegacy, digital: isDigital });
    } catch { /* An invalid published form never grants eligibility. */ }
  }
  return approved;
}

function isValidSignedPrivacyDocument({ document, template, patientId, clinicId, approvedVersions, now }) {
  const doc = plain(document), snapshot = object(doc?.snapshot_json);
  const approved = approvedVersions.get(Number(doc?.clinic_template_version_id));
  if (!approved || Number(doc.paciente_id) !== Number(patientId) || Number(doc.clinica_id) !== Number(clinicId)
    || Number(doc.clinic_template_id) !== Number(template.id) || doc.purpose !== 'data_protection'
    || Number(snapshot?.template?.id) !== Number(template.id) || Number(snapshot?.template?.clinic_id) !== Number(clinicId)
    || Number(snapshot?.version?.id) !== Number(approved.version.id)
    || !require('./appointmentConsentEligibility.service').isCurrentSignedDocument(doc, template, now)) return false;
  const choices = require('../lib/consent-document-choices');
  const answers = choices.signedConsentChoiceAnswers(doc);
  const evidenceDate = new Date(snapshot?.signature_evidence?.signed_at).getTime();
  if (!answers || (approved.legacy || approved.digital)
    && (!Number.isFinite(evidenceDate) || evidenceDate > now.getTime())) return false;
  if (approved.registration) {
    if (approved.layoutEquivalent && (doc.required !== (template.blocking_policy === 'hard')
      || ['requires_patient_signature', 'requires_representative_when_minor', 'requires_professional_signature', 'blocking_policy', 'validity_mode']
        .some(key => snapshot.template[key] !== template[key]))) return false;
    if (!Number.isFinite(evidenceDate) || evidenceDate > now.getTime()
      || snapshot.version.body_html !== approved.version.body_html
      || JSON.stringify(canonical(object(object(snapshot.version).body_json))) !== JSON.stringify(canonical(object(approved.version.body_json)))) return false;
    const blockHtml = require('../lib/consent-document-blocks').renderVersion(approved.version, object(snapshot.context), {
      answers: snapshot.document_block_answers?.answers || {},
      choiceEvidence: { schema_version: choices.getConsentChoiceForm(doc).schema_version, answers },
    });
    if (blockHtml !== null) return doc.snapshot_html === blockHtml;
    const html = require('../lib/registration-privacy-template').render(approved.version, object(snapshot.context));
    return doc.snapshot_html === choices.appendSignedChoiceHtml(html, doc, { schema_version: choices.getConsentChoiceForm(doc).schema_version, answers });
  }
  // Old signed snapshots do not contain source HTML. Match their complete
  // rendered legal body and canonical choice receipt to the pinned old source,
  // not merely the database version id or a copied metadata marker.
  if (approved.legacy || approved.digital) {
    const digital = require('../lib/bs-privacy-digital-template');
    if (approved.digital && !digital.isApprovedPrivacyPresentation({ bodyHtml: approved.version.body_html,
      bodyJson: snapshot.version.body_json })) return false;
    const legalHtml = approved.legacy ? String(approved.version.body_html || '').trim()
      : digital.buildBsPrivacyDigitalHtml(object(snapshot.context)).html;
    const expected = choices.appendSignedChoiceHtml(legalHtml, doc,
      { schema_version: choices.CHOICE_SCHEMA_VERSION, answers });
    if (doc.snapshot_html !== expected) return false;
  }
  return true;
}

async function assessPrivacyBeforeStart({ db, appointment, transaction, now = new Date() }) {
  const cita = plain(appointment), clinic = Number(cita?.clinica_id), patientId = Number(cita?.paciente_id);
  const policy = await registrationPolicy({ db, clinicId: clinic, transaction });
  if (!policy.enabled || !policy.beforeFirstCare) return { required: false, allowed: true, reason: 'outside_registration_scope' };
  const scope = await firstCareRegistrationScope({ db, appointment: cita, transaction, now });
  if (!scope.required) return scope;
  const { Op } = db.Sequelize;
  const template = plain(await db.ClinicConsentTemplate.findOne({ where: registrationTemplateWhere(clinic, policy),
    transaction, lock: transaction.LOCK.SHARE }));
  if (!template) fail('appointment_consent_privacy_configuration', 'Falta publicar el nuevo modelo de protección de datos de esta clínica. No se puede iniciar el alta clínica.');
  const version = plain(await db.ClinicConsentTemplateVersion.findOne({ where: { clinic_template_id: template.id,
    status: 'published', locale: 'es' }, order: [['version', 'DESC'], ['id', 'DESC']], transaction, lock: transaction.LOCK.SHARE }));
  const choices = require('../lib/consent-document-choices');
  if (!version || !String(version.body_html || '').trim()
    || !choices.getConsentChoiceForm({ snapshot_json: { version: { body_json: version.body_json } } })) {
    fail('appointment_consent_privacy_configuration', 'Revisa la versión publicada del nuevo modelo de protección de datos.');
  }
  const approvedVersions = await approvedPrivacyVersions({ db, template, version, transaction });
  const documents = await db.PatientConsentDocument.findAll({ where: { paciente_id: patientId, clinica_id: clinic,
    clinic_template_id: template.id, clinic_template_version_id: approvedVersions.size === 1 ? version.id : { [Op.in]: [...approvedVersions.keys()] }, purpose: 'data_protection', status: 'signed' },
    order: [['id', 'DESC']], limit: 101, transaction, lock: transaction.LOCK.SHARE });
  if (documents.length > 100) fail('appointment_consent_privacy_configuration', 'Revisa la documentación de protección de datos del paciente.');
  const valid = documents.some(document => isValidSignedPrivacyDocument({ document, template, patientId,
    clinicId: clinic, approvedVersions, now }));
  if (!valid) {
    const paper = require('../lib/registration-privacy-paper');
    const evidence = await paper.findRegistrationPrivacyPaper({ db, patientId, clinicId: clinic, template,
      version, approvedVersions, transaction, now });
    if (evidence) return paper.paperAssessment(evidence);
  }
  return { required: true, allowed: valid, reason: valid ? 'current_privacy_signed' : 'current_privacy_pending' };
}

// Shared alta/first-care classification. This checks provenance, not a caller's
// checkbox, and never requires or prepares a particular consent document.
async function firstCareRegistrationScope({ db, appointment, transaction, now = new Date() }) {
  const cita = plain(appointment), clinic = Number(cita?.clinica_id), patientId = Number(cita?.paciente_id);
  if (!transaction || !Number.isSafeInteger(patientId) || patientId <= 0) fail('appointment_consent_privacy_configuration', 'Revisa el paciente y la clínica antes de iniciar la cita.');
  const { Op } = db.Sequelize;
  const patient = plain(await db.Paciente.findByPk(patientId, { attributes: ['id_paciente', 'clinica_id'],
    transaction, lock: transaction.LOCK.SHARE }));
  if (!patient) fail('appointment_consent_privacy_configuration', 'No se pudo comprobar el alta del paciente.');
  // Imported provenance is server-held evidence, not caller-supplied fields or
  // fecha_alta/paciente_conocido. Existing imported patients are not a new alta.
  const imported = await db.PatientCustomField.findAll({ where: { paciente_id: patientId, source: 'cliniccloud',
    source_column: 'idContacto' }, attributes: ['value'],
    order: [['id', 'ASC']], limit: 20, transaction, lock: transaction.LOCK.SHARE });
  // Historical keys may include an explicit source-id suffix. source_column
  // identifies their meaning; never depend on the presentation field_key.
  if (imported.some(row => /^[1-9]\d*$/.test(String(plain(row)?.value || '').trim()))) return { required: false, allowed: true, reason: 'existing_imported_patient' };
  const priorCare = await db.CitaPaciente.findOne({ where: { paciente_id: patientId, clinica_id: clinic,
    id_cita: { [Op.ne]: Number(cita.id_cita) }, [Op.or]: [
      { care_started_at: { [Op.ne]: null, [Op.lte]: now } }, { care_legacy_attendance: true },
    ] }, attributes: ['id_cita'], transaction, lock: transaction.LOCK.SHARE });
  if (priorCare) return { required: false, allowed: true, reason: 'existing_clinical_patient' };
  return { required: true, allowed: false, reason: 'new_clinical_patient' };
}

async function assertPrivacyBeforeStart(options) {
  const result = await assessPrivacyBeforeStart(options);
  if (!result.allowed) fail('appointment_consent_privacy_required', 'Antes de iniciar la primera cita, el paciente debe revisar y firmar el nuevo modelo de protección de datos en la tablet. Responder «No» a una opción es válido.');
  return result;
}

module.exports = { CLINICS, FINAL_PRIVACY_KEY, approvedPrivacyVersions, isValidSignedPrivacyDocument,
  assessPrivacyBeforeStart, assertPrivacyBeforeStart, registrationPolicy, registrationTemplateWhere, firstCareRegistrationScope };

async function registrationPolicy({ db, clinicId, transaction }) {
  const clinic = db.Clinica?.findByPk ? plain(await db.Clinica.findByPk(clinicId, {
    attributes: ['id_clinica', 'configuracion'], transaction })) : { id_clinica: clinicId };
  return require('../lib/registration-privacy-configuration').policy({ id_clinica: clinicId, ...clinic });
}
function registrationTemplateWhere(clinicId, policy) {
  return { clinic_id: Number(clinicId), purpose: 'data_protection', status: 'active',
    ...(policy.templateId ? { id: policy.templateId } : { catalog_key: FINAL_PRIVACY_KEY, is_default: true, blocking_policy: 'hard' }) };
}
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
