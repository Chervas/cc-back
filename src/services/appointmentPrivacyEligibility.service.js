'use strict';

// Registration privacy is independent of treatment consents. Reading this
// service never prepares a package, starts care, sends a message or signs.
const CLINICS = Object.freeze([66, 72]);
const FINAL_PRIVACY_KEY = 'bs-final-20261015-e31760491bf0929ca25a4976f4f2c463cece9af7a41ecb6c0e84508aaddb741f';
const plain = row => row?.toJSON ? row.toJSON() : row;
const object = value => { if (typeof value === 'string') { try { return JSON.parse(value); } catch { return {}; } } return value || {}; };
const fail = (code, message) => { throw Object.assign(new Error(message), { code, statusCode: 409,
  details: { action: 'prepare_patient_privacy' } }); };

async function assessPrivacyBeforeStart({ db, appointment, transaction, now = new Date() }) {
  const cita = plain(appointment), clinic = Number(cita?.clinica_id), patientId = Number(cita?.paciente_id);
  if (!CLINICS.includes(clinic)) return { required: false, allowed: true, reason: 'outside_registration_scope' };
  if (!transaction || !Number.isSafeInteger(patientId) || patientId <= 0) fail('appointment_consent_privacy_configuration', 'Revisa el paciente y la clínica antes de iniciar la cita.');
  const { Op } = db.Sequelize;
  const patient = plain(await db.Paciente.findByPk(patientId, { attributes: ['id_paciente', 'clinica_id'],
    transaction, lock: transaction.LOCK.SHARE }));
  if (!patient) fail('appointment_consent_privacy_configuration', 'No se pudo comprobar el alta del paciente.');
  // Imported provenance is server-held evidence, not caller-supplied fields or
  // fecha_alta/paciente_conocido. Existing imported patients are not a new alta.
  const imported = await db.PatientCustomField.findAll({ where: { paciente_id: patientId, source: 'cliniccloud',
    clinica_id: { [Op.in]: CLINICS }, source_column: 'idContacto' }, attributes: ['value'],
    order: [['id', 'ASC']], limit: 20, transaction, lock: transaction.LOCK.SHARE });
  // Historical keys may include an explicit source-id suffix. source_column
  // identifies their meaning; never depend on the presentation field_key.
  if (imported.some(row => /^[1-9]\d*$/.test(String(plain(row)?.value || '').trim()))) return { required: false, allowed: true, reason: 'existing_imported_patient' };
  const priorCare = await db.CitaPaciente.findOne({ where: { paciente_id: patientId, clinica_id: clinic,
    id_cita: { [Op.ne]: Number(cita.id_cita) }, [Op.or]: [
      { care_started_at: { [Op.ne]: null, [Op.lte]: now } }, { care_legacy_attendance: true },
    ] }, attributes: ['id_cita'], transaction, lock: transaction.LOCK.SHARE });
  if (priorCare) return { required: false, allowed: true, reason: 'existing_clinical_patient' };
  const template = plain(await db.ClinicConsentTemplate.findOne({ where: { clinic_id: clinic,
    catalog_key: FINAL_PRIVACY_KEY, purpose: 'data_protection', status: 'active', is_default: true,
    blocking_policy: 'hard' }, transaction, lock: transaction.LOCK.SHARE }));
  if (!template) fail('appointment_consent_privacy_configuration', 'Falta publicar el nuevo modelo de protección de datos de esta clínica. No se puede iniciar el alta clínica.');
  const version = plain(await db.ClinicConsentTemplateVersion.findOne({ where: { clinic_template_id: template.id,
    status: 'published', locale: 'es' }, order: [['version', 'DESC'], ['id', 'DESC']], transaction, lock: transaction.LOCK.SHARE }));
  const choices = require('../lib/consent-document-choices');
  if (!version || !String(version.body_html || '').trim()
    || !choices.getConsentChoiceForm({ snapshot_json: { version: { body_json: version.body_json } } })) {
    fail('appointment_consent_privacy_configuration', 'Revisa la versión publicada del nuevo modelo de protección de datos.');
  }
  const documents = await db.PatientConsentDocument.findAll({ where: { paciente_id: patientId, clinica_id: clinic,
    clinic_template_id: template.id, clinic_template_version_id: version.id, purpose: 'data_protection', status: 'signed' },
    order: [['id', 'DESC']], limit: 101, transaction, lock: transaction.LOCK.SHARE });
  if (documents.length > 100) fail('appointment_consent_privacy_configuration', 'Revisa la documentación de protección de datos del paciente.');
  const valid = documents.some(raw => {
    const doc = plain(raw), snapshot = object(doc.snapshot_json);
    return Number(doc.paciente_id) === patientId && Number(doc.clinica_id) === clinic
      && Number(doc.clinic_template_id) === Number(template.id) && Number(doc.clinic_template_version_id) === Number(version.id)
      && doc.purpose === 'data_protection'
      && Number(snapshot?.template?.id) === Number(template.id) && Number(snapshot?.template?.clinic_id) === clinic
      && Number(snapshot?.version?.id) === Number(version.id)
      && require('./appointmentConsentEligibility.service').isCurrentSignedDocument(doc, template, now)
      && !!choices.signedConsentChoiceAnswers(doc);
  });
  return { required: true, allowed: valid, reason: valid ? 'current_privacy_signed' : 'current_privacy_pending' };
}

async function assertPrivacyBeforeStart(options) {
  const result = await assessPrivacyBeforeStart(options);
  if (!result.allowed) fail('appointment_consent_privacy_required', 'Antes de iniciar la primera cita, el paciente debe revisar y firmar el nuevo modelo de protección de datos en la tablet. Responder «No» a una opción es válido.');
  return result;
}

module.exports = { CLINICS, FINAL_PRIVACY_KEY, assessPrivacyBeforeStart, assertPrivacyBeforeStart };
