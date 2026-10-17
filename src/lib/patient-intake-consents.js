'use strict';
const { randomUUID } = require('node:crypto');
const { getConsentChoiceForm, signedConsentChoiceAnswers } = require('./consent-document-choices');
const { isCurrentSignedDocument } = require('../services/appointmentConsentEligibility.service');
const { medicalQuestionnaireEnabled } = require('./patient-intake-configuration');
const error = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const plain = value => value?.toJSON ? value.toJSON() : value;
const object = value => { if (typeof value === 'string') { try { return JSON.parse(value); } catch { return {}; } } return value || {}; };

function reusableChoiceDocument(document, template, version, form, now) {
  if (!form) return true; // Preserve the historical non-interactive contract.
  try {
    const row = plain(document), frozen = object(row.snapshot_json);
    if (Number(frozen.template?.id) !== Number(template.id)
      || Number(frozen.template?.clinic_id) !== Number(template.clinic_id)
      || Number(frozen.version?.id) !== Number(version.id)
      || JSON.stringify(getConsentChoiceForm(row)) !== JSON.stringify(form)) return false;
    return row.status !== 'signed'
      ? !row.revoked_at
      : isCurrentSignedDocument(row, template, now) && !!signedConsentChoiceAnswers(row);
  } catch { return false; }
}

// Called only after the controller checks consents.manage for the patient's
// primary clinic. A patient row lock serialises double clicks across processes.
async function preparePatientIntake({ db, patientId, clinicId, actorId, snapshot, structuredQuestionnaire = false, privacyOnly = false, additionalTemplateId = null, allowLinkedClinic = false, now = new Date(), transaction = null }) {
  const { Op } = db.Sequelize;
  const execute = async transaction => {
    const clinic = await db.Clinica.findByPk(clinicId, { transaction, lock: transaction.LOCK.SHARE || transaction.LOCK.UPDATE });
    if (!clinic) throw error('clinic_not_found', 404);
    const questionnaireEnabled = medicalQuestionnaireEnabled(clinic.configuracion);
    const patient = await db.Paciente.findByPk(patientId, { transaction, lock: transaction.LOCK.UPDATE,
      include: db.PacienteRelacion ? [{ model: db.PacienteRelacion, as: 'relaciones', required: false }] : [],
    });
    if (!patient) throw error('patient_clinic_changed', 409);
    if (Number(patient.clinica_id) !== Number(clinicId)) {
      const linked = allowLinkedClinic && await db.PacienteClinica.findOne({ where: { paciente_id: patientId, clinica_id: clinicId }, transaction, lock: transaction.LOCK.SHARE });
      const primary = linked && await db.Clinica.findByPk(patient.clinica_id, { transaction });
      if (!linked || !primary?.grupoClinicaId || Number(primary.grupoClinicaId) !== Number(clinic.grupoClinicaId)) throw error('patient_clinic_changed', 409);
    }
    const registration = require('./registration-privacy-configuration').policy(plain(clinic));
    const configured = object(object(plain(clinic).configuracion).patient_intake).additional_documents || [];
    if (additionalTemplateId !== null && (!Number.isSafeInteger(additionalTemplateId) || additionalTemplateId <= 0 || privacyOnly)) throw error('registration_document_id_invalid');
    if (additionalTemplateId !== null && !configured.some(row => Number(row.template_id) === additionalTemplateId)) throw error('intake_additional_document_not_configured', 409);
    const additional = privacyOnly ? [] : additionalTemplateId === null ? configured : configured.filter(row => Number(row.template_id) === additionalTemplateId);
    const extraById = new Map(additional.map(row => [Number(row.template_id), row]));
    const primaryWhere = registration.enabled && registration.templateId
      ? { clinic_id: clinicId, id: registration.templateId, purpose: 'data_protection', status: 'active' }
      : { clinic_id: clinicId, purpose: 'data_protection', status: 'active', is_default: true };
    const templates = await db.ClinicConsentTemplate.findAll({
      where: additionalTemplateId !== null ? { clinic_id: clinicId, id: additionalTemplateId, status: 'active' }
        : extraById.size ? { [Op.or]: [primaryWhere,
        { clinic_id: clinicId, id: { [Op.in]: [...extraById.keys()] }, status: 'active' }] } : primaryWhere,
      order: [['id', 'ASC']], transaction,
    });
    if ([...extraById.keys()].some(id => !templates.some(row => Number(row.id) === id))) throw error('intake_additional_documents_invalid', 409);
    templates.sort((a, b) => (extraById.get(Number(a.id))?.sort_order ?? -1) - (extraById.get(Number(b.id))?.sort_order ?? -1));
    const prepared = [], reused = [], missing = [], currentPackageIds = [];
    let considered = 0, signed = 0, paperCount = 0;
    for (const template of templates) {
      // The editable questionnaire already captures these answers separately;
      // never ask the patient to sign the old unfilled medical questionnaire.
      if (!extraById.has(Number(template.id)) && (structuredQuestionnaire || privacyOnly || !questionnaireEnabled)
        && template.catalog_key === 'cc_base_formulario_medico_alta_v1') continue;
      considered++;
      const version = await db.ClinicConsentTemplateVersion.findOne({
        where: { clinic_template_id: template.id, status: 'published', locale: 'es' },
        order: [['version', 'DESC'], ['id', 'DESC']], transaction,
      });
      if (!version || !String(version.body_html || '').trim()) { missing.push(template.id); continue; }
      const form = getConsentChoiceForm({ snapshot_json: { version: plain(version) } });
      const privacy = require('../services/appointmentPrivacyEligibility.service');
      const paper = require('./registration-privacy-paper');
      if (registration.enabled && Number(template.id) === Number(registration.templateId || template.id)
        && paper.isApprovedPaperFamilyVersion(plain(version))) {
        const approvedVersions = await privacy.approvedPrivacyVersions({ db, template: plain(template), version: plain(version), transaction });
        const evidence = await paper.findRegistrationPrivacyPaper({ db, patientId, clinicId, template: plain(template),
          version: plain(version), approvedVersions, transaction, now });
        if (evidence) { paperCount++; continue; }
      }
      let document = await db.PatientConsentDocument.findOne({
        where: { paciente_id: patientId, clinica_id: clinicId, clinic_template_id: template.id,
          clinic_template_version_id: version.id, status: { [Op.in]: ['pending', 'sent', 'viewed', 'signed'] },
          [Op.or]: [{ expires_at: null }, { expires_at: { [Op.gt]: now } }] },
        order: [['id', 'DESC']], transaction,
      });
      let reusable = document && reusableChoiceDocument(document, template, version, form, now);
      const genericRegistration = !!require('./registration-privacy-template').schema(version.body_json);
      const bsDigital = genericRegistration || privacy.CLINICS.includes(Number(clinicId))
        && Number(template.clinic_id) === Number(clinicId) && template.catalog_key === privacy.FINAL_PRIVACY_KEY
        && require('./bs-privacy-digital-template').isApprovedPrivacyPresentation({ bodyHtml: version.body_html, bodyJson: version.body_json });
      if (bsDigital && reusable && document.status === 'signed') {
        reusable = privacy.isValidSignedPrivacyDocument({ document, template: plain(template), patientId, clinicId, now,
          approvedVersions: new Map([[Number(version.id), { version: plain(version), legacy: false, digital: !genericRegistration, registration: genericRegistration }]]) });
      }
      if (bsDigital && (!reusable || document.status !== 'signed')) {
        const approvedVersions = await privacy.approvedPrivacyVersions({ db, template: plain(template), version: plain(version), transaction });
        const oldIds = [...approvedVersions.keys()].filter(id => id !== Number(version.id));
        if (oldIds.length) {
          const signedCandidates = await db.PatientConsentDocument.findAll({ where: {
            paciente_id: patientId, clinica_id: clinicId, clinic_template_id: template.id,
            clinic_template_version_id: { [Op.in]: oldIds }, purpose: 'data_protection', status: 'signed',
          }, order: [['id', 'DESC']], limit: 101, transaction, lock: transaction.LOCK.SHARE });
          if (signedCandidates.length > 100) throw error('intake_privacy_documents_review_required', 409);
          const valid = signedCandidates.find(candidate => privacy.isValidSignedPrivacyDocument({ document: candidate,
            template: plain(template), patientId, clinicId, approvedVersions, now }));
          // Pending paper-layout documents deliberately do not qualify: the
          // patient must see the current digital presentation, not be sent back
          // to the retired paper layout. Existing signatures remain untouched.
          if (valid) { document = valid; reusable = true; }
        }
      }
      if (document && reusable) {
        const existingPackage = document.package_id
          ? await db.ConsentSignaturePackage.findByPk(document.package_id, { transaction }) : null;
        const hasQuestionnaire = questionnaireEnabled && privacyOnly && document.status !== 'signed' && existingPackage
          && await db.PatientIntakeRequest.findOne({ where: { package_id: existingPackage.id }, transaction });
        // A per-row reception action must never reopen a package containing
        // LOPD or other additional documents. Keep its selection independent.
        const packageDocuments = additionalTemplateId !== null && existingPackage && document.status !== 'signed'
          ? await db.PatientConsentDocument.findAll({ where: { package_id: existingPackage.id }, attributes: ['id'], transaction, limit: 2 }) : null;
        const independent = additionalTemplateId === null || document.status === 'signed'
          || packageDocuments?.length === 1 && Number(packageDocuments[0].id) === Number(document.id);
        const available = existingPackage && independent && !hasQuestionnaire && !['cancelled', 'expired'].includes(existingPackage.status)
          && (!existingPackage.expires_at || new Date(existingPackage.expires_at) > now);
        if (document.status === 'signed' || available) {
          reused.push(document.id);
          if (document.status === 'signed') signed++;
          if (available && (additionalTemplateId === null || document.status !== 'signed')) currentPackageIds.push(document.package_id);
          continue;
        }
      }
      const extra = extraById.get(Number(template.id));
      prepared.push({ template: extra ? { ...plain(template), blocking_policy: extra.required
        && !['commercial_communications', 'marketing_image'].includes(template.purpose) ? 'hard' : 'optional' } : template, version });
    }
    if (!templates.length || considered === 0 || missing.length) throw error('intake_published_templates_required', 409);
    if (!prepared.length) return { package_id: null, created_count: 0, existing_count: reused.length, current_package_ids: [...new Set(currentPackageIds)],
      privacy_signed: signed === considered, privacy_satisfied: signed + paperCount === considered,
      privacy_on_paper: paperCount > 0, paper_count: paperCount };
    // Enforce at actual issue as well as settings-save: a published default
    // can be prepared directly before registration has been configured. Never
    // emit blank controller variables or reinterpret existing signed/paper data.
    if (prepared.some(({ version }) => require('./registration-privacy-template').schema(version.body_json))) {
      require('./registration-privacy-configuration').assertLegalControllerForIssue(plain(clinic));
    }
    const expires = new Date(now.getTime() + 30 * 86400000);
    const pkg = await db.ConsentSignaturePackage.create({
      public_id: `cpkg_${randomUUID().replace(/-/g, '')}`, paciente_id: patientId, clinica_id: clinicId,
      cita_id: null, tratamiento_id: null, status: 'pending', trigger_source: 'patient_intake',
      created_by: actorId, expires_at: expires,
    }, { transaction });
    for (const { template, version } of prepared) {
      const frozen = snapshot({ template, version, patient, clinic });
      await db.PatientConsentDocument.create({
        public_id: `cdoc_${randomUUID().replace(/-/g, '')}`, package_id: pkg.id,
        paciente_id: patientId, clinica_id: clinicId, cita_id: null, tratamiento_id: null,
        clinic_template_id: template.id, clinic_template_version_id: version.id,
        purpose: template.purpose || 'data_protection', status: 'pending', required: template.blocking_policy === 'hard',
        blocking_policy: template.blocking_policy, locale: version.locale,
        // The signature session expires, not a signed data-protection notice.
        title: version.title || template.name, expires_at: null, ...frozen,
      }, { transaction });
    }
    await pkg.update({ required_count: prepared.filter(x => x.template.blocking_policy === 'hard').length,
      signed_count: 0 }, { transaction });
    return { package_id: pkg.id, created_count: prepared.length, existing_count: reused.length, current_package_ids: [...new Set([pkg.id, ...currentPackageIds])],
      privacy_signed: false, privacy_satisfied: false, privacy_on_paper: paperCount > 0, paper_count: paperCount };
  };
  // Only a server-owned caller supplies this transaction (e.g. the actual
  // appointment lock and ACL). Never commit a package outside that anchor.
  return transaction ? execute(transaction) : db.sequelize.transaction(execute);
}
module.exports = { preparePatientIntake, reusableChoiceDocument };
