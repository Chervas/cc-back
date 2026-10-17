'use strict';

// Configured alta documents are independent of LOPD and treatment consents.
// Reads never issue packages or send; the care gate uses the same projection
// under the appointment transaction and fails closed only for effective hard
// requirements of this first care, never for marketing permission answers.
const config = require('../lib/registration-privacy-configuration');
const privacy = require('./appointmentPrivacyEligibility.service');
const { reusableChoiceDocument } = require('../lib/patient-intake-consents');
const { getConsentChoiceForm } = require('../lib/consent-document-choices');
const completion = require('../lib/consent-document-completion');
const plain = row => row?.toJSON ? row.toJSON() : row;
const fail = (code, message = code, statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
const optionalPurpose = purpose => ['commercial_communications', 'marketing_image'].includes(purpose);
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const activePackage = (pkg, now) => pkg && !['cancelled', 'expired'].includes(pkg.status)
  && (!pkg.expires_at || new Date(pkg.expires_at) > now);

async function registrationDocuments({ db, appointment, transaction, now = new Date(), lock = false, requiredOnly = false }) {
  if (!transaction) throw Error('registration_documents_transaction_required');
  const cita = plain(appointment), patientId = Number(cita.paciente_id), clinicId = Number(cita.clinica_id);
  if (!positive(patientId) || !positive(clinicId)) throw fail('appointment_not_found', 'appointment_not_found', 404);
  const shared = lock ? { lock: transaction.LOCK.SHARE } : {};
  const clinic = plain(await db.Clinica.findByPk(clinicId, { attributes: ['id_clinica', 'configuracion'], transaction, ...shared }));
  if (!clinic) throw fail('clinic_not_found', 'clinic_not_found', 404);
  const settings = config.object(config.object(clinic.configuracion).patient_intake);
  let additional = settings.additional_documents || [];
  try { config.validate({ additional_documents: additional }); }
  catch { throw fail('intake_additional_documents_review_required'); }
  const result = { appointment_id: Number(cita.id_cita), patient_id: patientId, clinic_id: clinicId,
    required_before_first_care: false, items: [] };
  if (requiredOnly) additional = additional.filter(row => row.required);
  if (!additional.length) return result;
  const firstCare = config.policy(clinic).beforeFirstCare
    ? await privacy.firstCareRegistrationScope({ db, appointment: cita, transaction, now }) : { required: false };
  result.required_before_first_care = firstCare.required;
  if (requiredOnly && !firstCare.required) return result;
  const { Op } = db.Sequelize;
  let ids = additional.map(row => Number(row.template_id));
  let templates = (await db.ClinicConsentTemplate.findAll({ where: { id: { [Op.in]: ids }, clinic_id: clinicId,
    ...(requiredOnly ? {} : { status: 'active' }) },
    transaction, ...shared, limit: 21 })).map(plain);
  if (templates.length !== ids.length || templates.some(row => row.purpose === 'data_protection')) throw fail('intake_additional_document_unavailable');
  if (requiredOnly) {
    templates = templates.filter(row => !optionalPurpose(row.purpose));
    if (templates.some(row => row.status !== 'active')) throw fail('intake_additional_document_unavailable');
    ids = templates.map(row => Number(row.id));
    additional = additional.filter(row => ids.includes(Number(row.template_id)));
    if (!ids.length) return result;
  }
  const versions = (await db.ClinicConsentTemplateVersion.findAll({ where: { clinic_template_id: { [Op.in]: ids }, status: 'published', locale: 'es' },
    order: [['version', 'DESC'], ['id', 'DESC']], transaction, ...shared, limit: ids.length * 101 })).map(plain);
  if (versions.length >= ids.length * 101 || ids.some(id => versions.filter(row => Number(row.clinic_template_id) === id).length > 100)) {
    throw fail('intake_additional_documents_review_required');
  }
  const documents = (await db.PatientConsentDocument.findAll({ where: { paciente_id: patientId, clinica_id: clinicId,
    clinic_template_id: { [Op.in]: ids }, revoked_at: null, status: { [Op.in]: ['pending', 'sent', 'viewed', 'signed', 'completed'] } },
    order: [['id', 'DESC']], transaction, ...shared, limit: ids.length * 101 })).map(plain);
  if (documents.length >= ids.length * 101 || ids.some(id => documents.filter(row => Number(row.clinic_template_id) === id).length > 100)) {
    throw fail('intake_additional_documents_review_required');
  }
  const packageIds = [...new Set(documents.map(row => Number(row.package_id)).filter(positive))];
  const packages = packageIds.length ? (await db.ConsentSignaturePackage.findAll({ where: { id: { [Op.in]: packageIds },
    paciente_id: patientId, clinica_id: clinicId }, transaction, ...shared, limit: packageIds.length + 1 })).map(plain) : [];
  const deliveries = packageIds.length && db.ConsentDeliveryEvent ? (await db.ConsentDeliveryEvent.findAll({ where: {
    package_id: { [Op.in]: packageIds }, patient_consent_document_id: { [Op.in]: documents.map(row => row.id) },
    status: { [Op.in]: ['queued', 'sent', 'viewed'] } }, transaction, ...shared, order: [['id', 'DESC']], limit: documents.length * 101 })).map(plain) : [];
  if (deliveries.length >= documents.length * 101 && documents.length) throw fail('intake_additional_documents_review_required');
  for (const entry of [...additional].sort((a, b) => a.sort_order - b.sort_order)) {
    const template = templates.find(row => Number(row.id) === Number(entry.template_id));
    const version = versions.find(row => Number(row.clinic_template_id) === Number(template.id));
    if (!version || !String(version.body_html || '').trim()) throw fail('intake_additional_document_unavailable');
    const completionPolicy = completion.policy(version, template);
    let form;
    try { form = getConsentChoiceForm({ snapshot_json: { version } }); }
    catch { throw fail('intake_additional_document_unavailable'); }
    const candidates = documents.filter(doc => Number(doc.clinic_template_id) === Number(template.id)
      && Number(doc.paciente_id) === patientId && Number(doc.clinica_id) === clinicId
      && Number(doc.clinic_template_version_id) === Number(version.id) && doc.purpose === template.purpose
      && (!doc.expires_at || new Date(doc.expires_at) > now)
      && (doc.status !== 'signed' || require('./appointmentConsentEligibility.service').isCurrentSignedDocument(doc, template, now))
      && reusableChoiceDocument(doc, template, version, form, now));
    const doc = candidates.find(row => row.status === 'signed' || completion.isCompleted(row, now))
      || candidates.find(row => ['pending', 'sent', 'viewed'].includes(row.status) && activePackage(packages.find(pkg => Number(pkg.id) === Number(row.package_id)), now));
    const item = { template_id: Number(template.id), title: version.title || template.name,
      required: entry.required && !optionalPurpose(template.purpose), state: 'not_requested',
      completion_mode: completionPolicy ? 'acknowledge' : 'signature',
      ...(optionalPurpose(template.purpose) ? { purpose: template.purpose } : {}) };
    if (doc) {
      const delivery = deliveries.find(row => Number(row.patient_consent_document_id) === Number(doc.id));
      item.state = doc.status === 'completed' ? 'completed' : doc.status === 'signed' ? 'signed' : doc.status === 'viewed' || delivery?.status === 'viewed' ? 'viewed'
        : doc.status === 'sent' || delivery ? 'sent' : 'pending';
      item.document_id = Number(doc.id); item.package_id = Number(doc.package_id) || null;
    }
    result.items.push(item);
  }
  return result;
}

async function assertRegistrationDocumentsBeforeStart(options) {
  const result = await registrationDocuments({ ...options, lock: true, requiredOnly: true });
  const missing = result.required_before_first_care && result.items.filter(row => row.required && !['signed', 'completed'].includes(row.state));
  if (missing?.length) {
    const error = fail('appointment_intake_documents_required', 'Antes de iniciar la primera cita, solicita desde recepción los documentos de alta obligatorios pendientes.');
    error.details = { action: 'prepare_registration_documents', template_ids: missing.map(row => row.template_id), blocking_count: missing.length };
    throw error;
  }
  return result;
}

module.exports = { registrationDocuments, assertRegistrationDocumentsBeforeStart };
