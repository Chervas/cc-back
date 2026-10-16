'use strict';

// Reception status only: no answers, clinical notes, signed legal choices or
// public tablet tokens are returned. Reading never prepares/sends a package.
const plain = row => row?.toJSON ? row.toJSON() : row;
const { clinicMedicalQuestionnaireEnabled } = require('../lib/patient-intake-configuration');
const stamp = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : undefined;
const active = (pkg, now, patientId, clinicId) => pkg
  && Number(pkg.paciente_id) === patientId && Number(pkg.clinica_id) === clinicId
  && !['cancelled', 'expired'].includes(pkg.status)
  && (!pkg.expires_at || new Date(pkg.expires_at).getTime() > now.getTime());

async function appointmentTabletStatus({ db, appointment, transaction, now = new Date(),
  assessPrivacy = require('./appointmentPrivacyEligibility.service').assessPrivacyBeforeStart }) {
  const patientId = Number(appointment.paciente_id), clinicId = Number(appointment.clinica_id), { Op } = db.Sequelize;
  const intakeEnabled = await clinicMedicalQuestionnaireEnabled({ db, clinicId, transaction });
  const assessment = await assessPrivacy({ db, appointment, transaction, now });
  const result = { privacy: { state: 'not_sent' }, intake: { enabled: intakeEnabled, state: 'not_sent' } };
  if (assessment.reason === 'privacy_received_on_paper') result.privacy.state = 'paper';
  else if (assessment.reason === 'current_privacy_signed') result.privacy.state = 'completed';
  else {
    const templates = await db.ClinicConsentTemplate.findAll({ where: { clinic_id: clinicId,
      purpose: 'data_protection', status: 'active', is_default: true },
    transaction });
    let considered = 0, completed = 0, paperReceived = 0;
    for (const rawTemplate of templates) {
      const template = plain(rawTemplate);
      if (template.catalog_key === 'cc_base_formulario_medico_alta_v1') continue;
      considered++;
      const version = plain(await db.ClinicConsentTemplateVersion.findOne({ where: { clinic_template_id: template.id,
        status: 'published', locale: 'es' }, order: [['version', 'DESC'], ['id', 'DESC']], transaction }));
      if (!version) continue;
      const privacy = require('./appointmentPrivacyEligibility.service');
      const bsPrivacy = privacy.CLINICS.includes(clinicId) && template.catalog_key === privacy.FINAL_PRIVACY_KEY;
      const approvedVersions = bsPrivacy
        ? await privacy.approvedPrivacyVersions({ db, template, version, transaction })
        : new Map([[Number(version.id), { version }]]);
      const documents = await db.PatientConsentDocument.findAll({ where: { paciente_id: patientId, clinica_id: clinicId,
        clinic_template_id: template.id, clinic_template_version_id: { [Op.in]: [...approvedVersions.keys()] }, purpose: 'data_protection',
        status: { [Op.in]: ['pending', 'sent', 'viewed', 'signed'] }, revoked_at: null,
        [Op.or]: [{ expires_at: null }, { expires_at: { [Op.gt]: now } }] },
      order: [['id', 'DESC']], limit: 100, transaction });
      // Exemption from the new-patient gate does NOT mean "not sent". Imported
      // and returning patients can already hold a real signed notice or paper.
      const validSigned = documents.some(rawDocument => {
        const document = plain(rawDocument);
        if (document.status !== 'signed') return false;
        return bsPrivacy ? privacy.isValidSignedPrivacyDocument({ document, template, patientId, clinicId, approvedVersions, now })
          : Number(document.paciente_id) === patientId && Number(document.clinica_id) === clinicId
            && Number(document.clinic_template_id) === Number(template.id) && Number(document.clinic_template_version_id) === Number(version.id)
            && require('./appointmentConsentEligibility.service').isCurrentSignedDocument(document, template, now);
      });
      if (validSigned) { completed++; continue; }
      const paper = require('../lib/registration-privacy-paper');
      if (bsPrivacy && paper.isApprovedPaperFamilyVersion(version)
        && await paper.findRegistrationPrivacyPaper({ db, patientId, clinicId, template, version, approvedVersions, transaction, now })) {
        paperReceived++; continue;
      }
      for (const rawDocument of documents) {
        const document = plain(rawDocument);
        if (document.status === 'signed' || Number(document.clinic_template_version_id ?? version.id) !== Number(version.id)) continue;
        const pkg = plain(await db.ConsentSignaturePackage.findByPk(document.package_id, { transaction }));
        if (!active(pkg, now, patientId, clinicId)) continue;
        // Only independent LOPD hand-offs qualify for this button. Historical
        // combined packages remain untouched, not silently presented as LOPD-only.
        if (intakeEnabled && await db.PatientIntakeRequest.findOne({ where: { package_id: pkg.id }, attributes: ['id'], transaction })) continue;
        const event = plain(await db.ConsentDeliveryEvent.findOne({ where: { package_id: pkg.id,
          patient_consent_document_id: document.id, channel: 'tablet', status: { [Op.in]: ['queued', 'sent', 'viewed'] } },
        attributes: ['id', 'createdAt'], order: [['id', 'DESC']], transaction }));
        if (event) { result.privacy = { state: 'sent', package_id: pkg.id, sent_at: stamp(event.createdAt) }; break; }
      }
      if (result.privacy.state === 'sent') break;
    }
    if (considered > 0 && completed + paperReceived === considered) result.privacy = { state: paperReceived ? 'paper' : 'completed' };
  }
  const request = plain(await db.PatientIntakeRequest.findOne({ where: { patient_id: patientId, clinic_id: clinicId },
    attributes: ['id', 'package_id', 'status', 'created_at', 'submitted_at'], order: [['id', 'DESC']], transaction }));
  if (!request) return result;
  if (request.status === 'submitted' || request.status === 'reviewed') {
    result.intake = { enabled: intakeEnabled, state: request.status === 'reviewed' ? 'confirmed' : 'submitted',
      package_id: request.package_id, sent_at: stamp(request.created_at) };
  } else if (intakeEnabled && request.status === 'pending') {
    const pkg = plain(await db.ConsentSignaturePackage.findByPk(request.package_id, { transaction }));
    // A pending explicit questionnaire is already a visible kiosk item. No
    // signature package is created/reused to imply that the LOPD was also sent.
    if (active(pkg, now, patientId, clinicId)) result.intake = { enabled: intakeEnabled, state: 'sent', package_id: pkg.id, sent_at: stamp(request.created_at) };
  }
  return result;
}

module.exports = { appointmentTabletStatus };
