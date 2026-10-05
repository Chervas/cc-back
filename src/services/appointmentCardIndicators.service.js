'use strict';
// Bounded batch projection for the calendar, never N requests per card. This
// visual summary is not authorization to start/complete clinical care.
const { isCurrentSignedDocument } = require('./appointmentConsentEligibility.service');
const plain = row => row?.toJSON ? row.toJSON() : row;
function treatmentIds(a) {
  if (require('../lib/program-appointment-context').hasProgramAppointmentReference(a)) {
    return a.program_context?.status === 'linked' && Array.isArray(a.program_context.treatment_ids)
      ? a.program_context.treatment_ids : [];
  }
  return a.tratamiento_id ? [Number(a.tratamiento_id)] : [];
}
async function attach(db, rows) {
  const appointments = rows.map(plain).filter(a => a.paciente_id && a.clinica_id && treatmentIds(a).length);
  if (!appointments.length) return;
  const { Op } = db.Sequelize;
  const ids = key => [...new Set(appointments.map(a => Number(a[key])))];
  const requirements = await db.TreatmentConsentRequirement.findAll({ where: {
    tratamiento_id: { [Op.in]: [...new Set(appointments.flatMap(treatmentIds))] },
    [Op.or]: [{ clinica_id: { [Op.in]: ids('clinica_id') } }, { clinica_id: null }] },
    include: [{ model: db.ClinicConsentTemplate, as: 'clinicTemplate', required: false }, { model: db.ConsentTemplateCatalog, as: 'catalogTemplate', required: false }], limit: 5001 });
  if (requirements.length > 5000) return; // Unknown stays unknown, never green.
  const documents = await db.PatientConsentDocument.findAll({ where: { paciente_id: { [Op.in]: ids('paciente_id') }, clinica_id: { [Op.in]: ids('clinica_id') } },
    attributes: ['id', 'paciente_id', 'clinica_id', 'cita_id', 'tratamiento_id', 'clinic_template_id', 'catalog_template_id', 'status', 'signed_at', 'revoked_at', 'expires_at', 'professional_signed_by', 'professional_signed_at',
      [db.Sequelize.literal("JSON_EXTRACT(`snapshot_json`, '$.template.requires_professional_signature')"), 'requires_professional']], limit: 10001, raw: true });
  if (documents.length > 10000) return;
  const byTreatment = new Map(), byPatientClinic = new Map(), projected = new Map(), now = new Date();
  for (const row of requirements) { const r = plain(row); const key = Number(r.tratamiento_id); if (!byTreatment.has(key)) byTreatment.set(key, []); byTreatment.get(key).push(r); }
  for (const d of documents) {
    d.snapshot_json = d.requires_professional == null ? {} : { template: { requires_professional_signature: [true, 1, 'true', '1'].includes(d.requires_professional) } };
    const key = `${d.clinica_id}:${d.paciente_id}`; if (!byPatientClinic.has(key)) byPatientClinic.set(key, []); byPatientClinic.get(key).push(d);
  }
  for (const a of appointments) {
    const rs = treatmentIds(a).flatMap(id => byTreatment.get(Number(id)) || [])
      .filter(r => (!r.clinica_id || Number(r.clinica_id) === Number(a.clinica_id))
        && (r.clinicTemplate?.status || r.catalogTemplate?.status || 'active') === 'active');
    const docs = byPatientClinic.get(`${a.clinica_id}:${a.paciente_id}`) || [];
    let signed = 0, required = 0, optionalPending = 0;
    for (const r of rs) {
      const t = r.clinicTemplate || r.catalogTemplate;
      const isRequired = r.required !== false && r.required !== 0;
      if (isRequired) required++;
      const isSigned = !!t && docs.some(d => (r.clinic_template_id ? Number(d.clinic_template_id) === Number(r.clinic_template_id) : Number(d.catalog_template_id) === Number(r.catalog_template_id))
        && (t.validity_mode === 'manual' || Number(d.cita_id) === Number(a.id_cita) && Number(d.tratamiento_id) === Number(r.tratamiento_id))
        && isCurrentSignedDocument(d, t, now));
      if (isRequired && isSigned) signed++;
      if (!isRequired && !isSigned) optionalPending++;
    }
    projected.set(a.id_cita, { required_total: required, signed_required: signed,
      pending_required: required - signed, pending_optional: optionalPending,
      has_pending: required > signed || optionalPending > 0 });
  }
  for (const row of rows) { const summary = projected.get(row.id_cita); if (!summary) continue; if (row.setDataValue) row.setDataValue('consent_summary', summary); else row.consent_summary = summary; }
}
module.exports = { attach };
