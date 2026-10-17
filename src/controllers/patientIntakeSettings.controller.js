'use strict';
const db = require('../../models');
const { assertUserCanAccessFeature } = require('../lib/access-policy');
const config = require('../lib/registration-privacy-configuration');
const fail = (code, statusCode = 400) => Object.assign(new Error(code), { code, statusCode });
const plain = row => row?.toJSON ? row.toJSON() : row;
async function authorize(req, feature) {
  const actorId = Number(req.userData?.userId), clinicId = Number(req.params.id);
  if (!Number.isSafeInteger(actorId) || actorId <= 0) throw fail('auth_failed', 401);
  if (!Number.isSafeInteger(clinicId) || clinicId <= 0) throw fail('clinic_id_required');
  await assertUserCanAccessFeature({ actorId, clinicId, featureKey: feature });
  return { actorId, clinicId };
}
function reply(error, res, next) { const status = error.statusCode || error.status;
  if ([400, 401, 403, 404, 409].includes(status)) return res.status(status).json({ code: error.code || error.message, message: error.message });
  return next(error); }
async function read(clinicId, transaction) {
  const clinic = plain(await db.Clinica.findByPk(clinicId, { transaction }));
  if (!clinic) throw fail('clinic_not_found', 404);
  const templates = (await db.ClinicConsentTemplate.findAll({ where: { clinic_id: clinicId,
    status: { [db.Sequelize.Op.in]: ['draft', 'active'] } }, transaction, order: [['name', 'ASC']], limit: 201 })).map(plain);
  if (templates.length > 200) throw fail('patient_intake_templates_review_required', 409);
  const versions = templates.length ? (await db.ClinicConsentTemplateVersion.findAll({ where: {
    clinic_template_id: { [db.Sequelize.Op.in]: templates.map(row => row.id) }, locale: 'es' },
  transaction, order: [['version', 'DESC'], ['id', 'DESC']], limit: templates.length * 101 })).map(plain) : [];
  if (templates.some(template => versions.filter(row => Number(row.clinic_template_id) === Number(template.id)).length > 100)) {
    throw fail('patient_intake_templates_review_required', 409);
  }
  const settings = config.normalize(clinic);
  if (config.policy(clinic).legacy && !settings.privacy_template_id) settings.privacy_template_id =
    templates.find(row => row.catalog_key === config.BS_KEY && row.status === 'active' && row.is_default)?.id || null;
  return { clinic_id: clinicId, patient_intake: settings, version: config.version(clinic), standard_template_available: true,
    templates: templates.map(row => { const latest = versions.find(version => Number(version.clinic_template_id) === Number(row.id));
      return { id: row.id, name: row.name, title: latest?.title || row.name, status: row.status, purpose: row.purpose,
        version_status: latest?.status || null, published: versions.some(version => Number(version.clinic_template_id) === Number(row.id) && version.status === 'published') }; }) };
}
exports.get = async (req, res, next) => { try {
  const { clinicId } = await authorize(req, 'clinic.settings.view');
  return res.json(await db.sequelize.transaction({ readOnly: true, isolationLevel: 'REPEATABLE READ' }, transaction => read(clinicId, transaction)));
} catch (error) { return reply(error, res, next); } };
exports.put = async (req, res, next) => { try {
  const { clinicId, actorId } = await authorize(req, 'clinic.settings.edit');
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)
    || Object.keys(req.body).some(key => !['patient_intake', 'expected_version'].includes(key))) throw fail('patient_intake_settings_invalid');
  config.validate(req.body.patient_intake);
  const result = await db.sequelize.transaction(async transaction => {
    const row = await db.Clinica.findByPk(clinicId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!row) throw fail('clinic_not_found', 404);
    const clinic = plain(row);
    await assertUserCanAccessFeature({ actorId, clinicId, featureKey: 'clinic.settings.edit' });
    if (req.body.expected_version !== config.version(clinic)) throw fail('patient_intake_settings_changed', 409);
    const configured = require('../lib/clinic-configuration').mergeClinicConfiguration(clinic.configuracion, { patient_intake: req.body.patient_intake });
    const next = { ...clinic, configuracion: configured }, policy = config.policy(next);
    if (policy.enabled) {
      if (!policy.templateId) throw fail('patient_intake_privacy_template_required');
      const template = await db.ClinicConsentTemplate.findOne({ where: { id: policy.templateId, clinic_id: clinicId,
        purpose: 'data_protection', status: 'active' }, transaction, lock: transaction.LOCK.SHARE });
      const version = template && await db.ClinicConsentTemplateVersion.findOne({ where: { clinic_template_id: template.id,
        status: 'published', locale: 'es' }, order: [['version', 'DESC'], ['id', 'DESC']], transaction, lock: transaction.LOCK.SHARE });
      if (!version || !version.body_html || !require('../lib/consent-document-choices').getConsentChoiceForm({ snapshot_json: { version: plain(version) } })) {
        throw fail('patient_intake_privacy_template_unpublished');
      }
      if (!require('../lib/registration-privacy-template').schema(version.body_json)
        && !(template.catalog_key === config.BS_KEY && require('../lib/registration-privacy-paper').isApprovedPaperFamilyVersion(plain(version)))) {
        throw fail('patient_intake_privacy_template_identity_required');
      }
      const responsible = config.controller(next);
      if (!responsible.legal_name || !responsible.tax_id || !responsible.address || !responsible.email) throw fail('patient_intake_legal_controller_incomplete');
    }
    for (const extra of config.object(config.object(configured).patient_intake).additional_documents || []) {
      if (Number(extra.template_id) === policy.templateId) throw fail('patient_intake_additional_document_duplicate');
      const template = await db.ClinicConsentTemplate.findOne({ where: { id: extra.template_id, clinic_id: clinicId,
        status: 'active' }, transaction, lock: transaction.LOCK.SHARE });
      const version = template && await db.ClinicConsentTemplateVersion.findOne({ where: { clinic_template_id: template.id,
        status: 'published', locale: 'es' }, order: [['version', 'DESC'], ['id', 'DESC']], transaction, lock: transaction.LOCK.SHARE });
      if (!version || !String(version.body_html || '').trim() || template.purpose === 'data_protection') throw fail('patient_intake_additional_document_invalid');
    }
    await row.update({ configuracion: configured }, { transaction });
    if (db.PatientOperationalEvent) await db.PatientOperationalEvent.create({ patient_id: null, clinic_id: clinicId,
      actor_user_id: actorId, event_type: 'patient_intake.settings_changed', source: 'clinic_settings', channel: 'internal',
      metadata: { previous_version: config.version(clinic), next_version: config.version(next) } }, { transaction });
    return read(clinicId, transaction);
  });
  return res.json(result);
} catch (error) { return reply(error, res, next); } };
exports.standard = async (req, res, next) => { try {
  const { clinicId, actorId } = await authorize(req, 'clinic.settings.edit');
  await assertUserCanAccessFeature({ actorId, clinicId, featureKey: 'consents.manage' });
  if (Array.isArray(req.body) || req.body != null && typeof req.body !== 'object' || Object.keys(req.body || {}).length) throw fail('patient_intake_settings_invalid');
  const body = require('../lib/registration-privacy-template').standardDraft();
  const template = await require('../services/consentimientos.service').createClinicTemplate({ clinic_id: clinicId,
    name: body.title, purpose: 'data_protection', status: 'draft', version_status: 'draft', is_default: false,
    blocking_policy: 'hard', validity_mode: 'manual', ...body }, actorId);
  return res.status(201).json({ template_id: template.id, created: true });
} catch (error) { return reply(error, res, next); } };
