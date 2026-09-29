'use strict';
// Bounded batch projection for the calendar, never N requests per card. This
// visual summary is not authorization to start/complete clinical care.
const { isCurrentSignedDocument } = require('./appointmentConsentEligibility.service');
const plain = row => row?.toJSON ? row.toJSON() : row;
async function attach(db, rows) {
  const appointments = rows.map(plain).filter(a => a.paciente_id && a.tratamiento_id && a.source_system !== 'treatment_program');
  if (!appointments.length) return;
  const { Op } = db.Sequelize;
  const ids = key => [...new Set(appointments.map(a => Number(a[key])))];
  const requirements = await db.TreatmentConsentRequirement.findAll({ where: { tratamiento_id: { [Op.in]: ids('tratamiento_id') }, required: true },
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
    const rs = (byTreatment.get(Number(a.tratamiento_id)) || []).filter(r => !r.clinica_id || Number(r.clinica_id) === Number(a.clinica_id));
    const docs = byPatientClinic.get(`${a.clinica_id}:${a.paciente_id}`) || [];
    let signed = 0;
    for (const r of rs) {
      const t = r.clinicTemplate || r.catalogTemplate;
      if (t?.status === 'active' && docs.some(d => (r.clinic_template_id ? Number(d.clinic_template_id) === Number(r.clinic_template_id) : Number(d.catalog_template_id) === Number(r.catalog_template_id))
        && (t.validity_mode === 'manual' || Number(d.cita_id) === Number(a.id_cita) && Number(d.tratamiento_id) === Number(r.tratamiento_id))
        && isCurrentSignedDocument(d, t, now))) signed++;
    }
    projected.set(a.id_cita, { required_total: rs.length, signed_required: signed, pending_required: rs.length - signed, has_pending: rs.length > signed });
  }
  for (const row of rows) { const summary = projected.get(row.id_cita); if (!summary) continue; if (row.setDataValue) row.setDataValue('consent_summary', summary); else row.consent_summary = summary; }
}
module.exports = { attach };
