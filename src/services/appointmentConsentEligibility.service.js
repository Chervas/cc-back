'use strict';

const plain = row => row?.toJSON ? row.toJSON() : row;
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const object = value => {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return {}; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
};
const templateKey = row => row.clinic_template_id ? `clinic:${Number(row.clinic_template_id)}`
  : row.catalog_template_id ? `catalog:${Number(row.catalog_template_id)}` : null;

function consentError(code, message, count = null) {
  const error = new Error(message);
  error.code = code; error.status = 409; error.statusCode = 409;
  error.details = { action: 'review_consents', ...(count == null ? {} : { blocking_count: count }) };
  return error;
}

function isCurrentSignedDocument(document, template, now) {
  const doc = plain(document);
  const signed = new Date(doc.signed_at).getTime();
  if (doc.status !== 'signed' || !doc.signed_at || !Number.isFinite(signed) || signed > now.getTime() || doc.revoked_at) return false;
  if (doc.expires_at && (!Number.isFinite(new Date(doc.expires_at).getTime()) || new Date(doc.expires_at) <= now)) return false;
  // The signed snapshot remains authoritative if a template changes later.
  const snapshotTemplate = object(doc.snapshot_json).template;
  const needsProfessional = snapshotTemplate && Object.hasOwn(snapshotTemplate, 'requires_professional_signature')
    ? snapshotTemplate.requires_professional_signature === true : template.requires_professional_signature === true;
  return !needsProfessional || (positive(doc.professional_signed_by) && !!doc.professional_signed_at
    && Number.isFinite(new Date(doc.professional_signed_at).getTime()) && new Date(doc.professional_signed_at) <= now);
}

/** Pure decision: configured clinical requirements only. Optional/marketing
 * documents never become a condition for receiving clinical care. No procedure
 * is classified as invasive from its name, and no signature is inferred from an
 * imported spreadsheet or an external-attestation checkbox.
 */
function assessClinicalConsentEvidence({ appointment, requirements, documents, now = new Date() }) {
  const cita = plain(appointment);
  let blocking = 0, required = 0;
  const seen = new Set();
  for (const raw of requirements) {
    const requirement = plain(raw);
    if (!requirement.required || requirement.blocking_policy !== 'hard') continue;
    const template = plain(requirement.clinicTemplate || requirement.catalogTemplate);
    // A dangling explicit hard requirement must not silently authorize care.
    if (!template) throw consentError('appointment_consent_configuration_required', 'Revisa la configuración de consentimientos de esta cita.');
    if (template.purpose !== 'clinical') continue;
    const key = `${Number(requirement.tratamiento_id)}:${templateKey(requirement)}`;
    if (seen.has(key)) continue;
    seen.add(key); required++;
    if (template.status !== 'active' || !templateKey(requirement)) {
      blocking++; continue;
    }
    const satisfied = documents.some(rawDoc => {
      const doc = plain(rawDoc);
      if (Number(doc.paciente_id) !== Number(cita.paciente_id) || Number(doc.clinica_id) !== Number(cita.clinica_id)
        || doc.purpose !== 'clinical' || templateKey(doc) !== templateKey(requirement)) return false;
      const sameAct = positive(cita.id_cita) && Number(doc.cita_id) === Number(cita.id_cita)
        && Number(doc.tratamiento_id) === Number(requirement.tratamiento_id);
      const reusable = template.validity_mode === 'manual';
      if (!sameAct && !reusable) return false;
      return isCurrentSignedDocument(doc, template, now);
    });
    if (!satisfied) blocking++;
  }
  return { allowed: blocking === 0, blocking_count: blocking, required_clinical_count: required };
}

/** Authoritative completion check, called under the appointment transaction.
 * Two bulk reads regardless of phase count; shared document locks serialize
 * against revocation/signature updates until the appointment write commits.
 * This service does not create documents, packages, jobs or provider deliveries.
 */
async function assessAppointmentClinicalConsent({ db, appointment, transaction, now = new Date() }) {
  if (!transaction) throw Error('consent_completion_transaction_required');
  const cita = plain(appointment);
  if (!positive(cita?.paciente_id) || !positive(cita?.clinica_id)) throw consentError('appointment_consent_configuration_required', 'Falta el ámbito de paciente y clínica de la cita.');
  if (require('../lib/appointment-import-review').importTreatmentPending(cita)) {
    throw consentError('appointment_consent_import_review_required', 'Completa el tratamiento importado o confirma que es una visita sin tratamiento antes de marcarla como realizada.');
  }
  let treatmentIds = positive(cita.tratamiento_id) ? [Number(cita.tratamiento_id)] : [];
  if (cita.source_system === 'treatment_program' && cita.voucher_id) {
    const context = await require('../lib/program-appointment-context').programAppointmentContext(db, cita, transaction);
    treatmentIds = context.treatment_ids;
    if (!Array.isArray(treatmentIds) || !treatmentIds.length) throw consentError('appointment_consent_configuration_required', 'Falta la composición comprada del programa.');
  }
  if (!Array.isArray(treatmentIds) || treatmentIds.length > 250 || treatmentIds.some(id => !positive(id))) throw consentError('appointment_consent_configuration_required', 'Revisa los tratamientos de la cita.');
  treatmentIds = [...new Set(treatmentIds.map(Number))];
  if (!treatmentIds.length) return { allowed: true, blocking_count: 0, required_clinical_count: 0 };
  const { Op } = db.Sequelize;
  const attributes = ['id', 'purpose', 'status', 'validity_mode', 'requires_professional_signature'];
  const requirements = await db.TreatmentConsentRequirement.findAll({ where: {
    tratamiento_id: { [Op.in]: treatmentIds }, required: true, blocking_policy: 'hard',
    [Op.or]: [{ clinica_id: Number(cita.clinica_id) }, { clinica_id: null }],
  }, include: [
    { model: db.ClinicConsentTemplate, as: 'clinicTemplate', required: false, attributes },
    { model: db.ConsentTemplateCatalog, as: 'catalogTemplate', required: false, attributes },
  ], order: [['id', 'ASC']], limit: 501, transaction, lock: transaction.LOCK.SHARE });
  if (requirements.length > 500) throw consentError('appointment_consent_configuration_required', 'Hay demasiados requisitos. Revisa la configuración de la cita.');
  const clinical = requirements.filter(row => !plain(row).clinicTemplate && !plain(row).catalogTemplate
    || plain(plain(row).clinicTemplate || plain(row).catalogTemplate)?.purpose === 'clinical');
  if (!clinical.length) return { allowed: true, blocking_count: 0, required_clinical_count: 0 };
  const clinicTemplates = [...new Set(clinical.map(row => Number(plain(row).clinic_template_id)).filter(positive))];
  const catalogTemplates = [...new Set(clinical.map(row => Number(plain(row).catalog_template_id)).filter(positive))];
  if (!clinicTemplates.length && !catalogTemplates.length) throw consentError('appointment_consent_configuration_required', 'Falta una plantilla de consentimiento clínico.');
  const documents = await db.PatientConsentDocument.findAll({ where: {
    paciente_id: Number(cita.paciente_id), clinica_id: Number(cita.clinica_id), purpose: 'clinical',
    [Op.or]: [ ...(clinicTemplates.length ? [{ clinic_template_id: { [Op.in]: clinicTemplates } }] : []),
      ...(catalogTemplates.length ? [{ catalog_template_id: { [Op.in]: catalogTemplates } }] : []) ],
  }, attributes: ['id', 'paciente_id', 'clinica_id', 'cita_id', 'tratamiento_id', 'clinic_template_id', 'catalog_template_id',
    'purpose', 'status', 'signed_at', 'revoked_at', 'expires_at', 'professional_signed_by', 'professional_signed_at', 'snapshot_json'],
  order: [['id', 'ASC']], limit: 1001, transaction, lock: transaction.LOCK.SHARE });
  if (documents.length > 1000) throw consentError('appointment_consent_configuration_required', 'Revisa la documentación clínica antes de completar la cita.');
  return assessClinicalConsentEvidence({ appointment: cita, requirements: clinical, documents, now });
}

async function assertAppointmentClinicalConsent(options) {
  const result = await assessAppointmentClinicalConsent(options);
  if (!result.allowed) throw consentError('appointment_consent_required', 'Faltan consentimientos clínicos obligatorios con firma vigente. Revisa los consentimientos de la cita antes de marcarla como realizada.', result.blocking_count);
  return result;
}

async function assertClinicalCompletion({ previous = null, appointment, ...options }) {
  if (plain(appointment)?.estado !== 'completada' || plain(previous)?.estado === 'completada') return;
  return assertAppointmentClinicalConsent({ ...options, appointment });
}

module.exports = { assessClinicalConsentEvidence, assessAppointmentClinicalConsent, assertAppointmentClinicalConsent,
  assertClinicalCompletion, isCurrentSignedDocument };
