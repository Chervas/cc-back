'use strict';

// This guard only checks tenant scope. Trigger eligibility, publication lifecycle,
// bindings and execution continue to be owned by their existing automation APIs.
function createTreatmentAutomationScope(db) {
  const id = value => ['string', 'number'].includes(typeof value)
    && /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
  const clean = value => value == null ? null : String(value).trim() || null;
  const failure = (status, code, message) => Object.assign(new Error(message), { status, statusCode: status, code });

  async function canUseTemplate(treatment, template) {
    if (!template) return false;
    if (template.is_system) return true;
    const groups = new Map();
    async function clinicGroup(clinicId) {
      if (!clinicId) return null;
      if (!groups.has(clinicId)) {
        const clinic = await db.Clinica.findOne({ where: { id_clinica: clinicId }, attributes: ['grupoClinicaId'], raw: true });
        groups.set(clinicId, id(clinic?.grupoClinicaId));
      }
      return groups.get(clinicId);
    }
    // Only the declared owner defines the scope. In particular, a clinic-owned
    // treatment's optional group field must not grant access to an unrelated group.
    const treatmentClinicId = treatment?.origen === 'clinica' ? id(treatment.clinica_id) : null;
    const treatmentGroupId = treatment?.origen === 'grupo'
      ? id(treatment.grupo_clinica_id)
      : treatmentClinicId ? await clinicGroup(treatmentClinicId) : null;
    const templateClinicId = id(template.clinic_id);
    const templateGroupId = id(template.group_id);
    if (treatmentClinicId && templateClinicId === treatmentClinicId) return true;
    if (treatmentGroupId && templateGroupId === treatmentGroupId) return true;
    return !!treatmentGroupId && await clinicGroup(templateClinicId) === treatmentGroupId;
  }

  async function assertReferenceScope(treatment) {
    const templateKey = clean(treatment?.appointment_automation_template_key);
    if (!templateKey) return;
    // Match the published version resolved by the existing GET; inactive
    // references remain readable without changing their lifecycle or defaults.
    const template = await db.AutomationFlowTemplateV2.findOne({
      where: { template_key: templateKey, published_at: { [db.Sequelize.Op.ne]: null } },
      order: [['version', 'DESC']], raw: true,
    });
    if (!template) throw failure(404, 'treatment_automation_template_not_found', 'Plantilla v2 publicada no encontrada para template_key');
    if (!await canUseTemplate(treatment, template)) {
      throw failure(403, 'treatment_automation_template_scope', 'La plantilla v2 no pertenece al mismo alcance (clínica/grupo) del tratamiento');
    }
  }

  return { canUseTemplate, assertReferenceScope };
}

module.exports = { createTreatmentAutomationScope };
