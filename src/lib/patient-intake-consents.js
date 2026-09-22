'use strict';
const { randomUUID } = require('node:crypto');
const error = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

// Called only after the controller checks consents.manage for the patient's
// primary clinic. A patient row lock serialises double clicks across processes.
async function preparePatientIntake({ db, patientId, clinicId, actorId, snapshot, now = new Date() }) {
  const { Op } = db.Sequelize;
  return db.sequelize.transaction(async transaction => {
    const patient = await db.Paciente.findByPk(patientId, { transaction, lock: transaction.LOCK.UPDATE,
      include: db.PacienteRelacion ? [{ model: db.PacienteRelacion, as: 'relaciones', required: false }] : [],
    });
    if (!patient || Number(patient.clinica_id) !== Number(clinicId)) throw error('patient_clinic_changed', 409);
    const clinic = await db.Clinica.findByPk(clinicId, { transaction });
    if (!clinic) throw error('clinic_not_found', 404);
    const templates = await db.ClinicConsentTemplate.findAll({
      where: { clinic_id: clinicId, purpose: 'data_protection', status: 'active', is_default: true },
      order: [['id', 'ASC']], transaction,
    });
    const prepared = [], reused = [], missing = [];
    for (const template of templates) {
      const version = await db.ClinicConsentTemplateVersion.findOne({
        where: { clinic_template_id: template.id, status: 'published', locale: 'es' },
        order: [['version', 'DESC'], ['id', 'DESC']], transaction,
      });
      if (!version || !String(version.body_html || '').trim()) { missing.push(template.id); continue; }
      const document = await db.PatientConsentDocument.findOne({
        where: { paciente_id: patientId, clinica_id: clinicId, clinic_template_id: template.id,
          clinic_template_version_id: version.id, status: { [Op.in]: ['pending', 'sent', 'viewed', 'signed'] },
          [Op.or]: [{ expires_at: null }, { expires_at: { [Op.gt]: now } }] },
        order: [['id', 'DESC']], transaction,
      });
      if (document) {
        const existingPackage = document.package_id
          ? await db.ConsentSignaturePackage.findByPk(document.package_id, { transaction }) : null;
        const available = existingPackage && !['cancelled', 'expired'].includes(existingPackage.status)
          && (!existingPackage.expires_at || new Date(existingPackage.expires_at) > now);
        if (document.status === 'signed' || available) { reused.push(document.id); continue; }
      }
      prepared.push({ template, version });
    }
    if (!templates.length || missing.length) throw error('intake_published_templates_required', 409);
    if (!prepared.length) return { package_id: null, created_count: 0, existing_count: reused.length };
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
        purpose: 'data_protection', status: 'pending', required: template.blocking_policy === 'hard',
        blocking_policy: template.blocking_policy, locale: version.locale,
        // The signature session expires, not a signed data-protection notice.
        title: version.title || template.name, expires_at: null, ...frozen,
      }, { transaction });
    }
    await pkg.update({ required_count: prepared.filter(x => x.template.blocking_policy === 'hard').length,
      signed_count: 0 }, { transaction });
    return { package_id: pkg.id, created_count: prepared.length, existing_count: reused.length };
  });
}
module.exports = { preparePatientIntake };
