'use strict';

const { normalizeContextPhone, positiveId, plain } = require('../lib/lead-patient-context');

const CAMPAIGN_WHATSAPP_SOURCES = new Set(['marketing_email_whatsapp', 'bulk_whatsapp_reply']);
const trim = value => typeof value === 'string' ? value.trim() : '';

async function fillExistingPatientNames(rows, { canSeePatientDetails, loadPatients }) {
  const candidates = rows.filter(lead => !lead.privacy_redacted && !trim(lead.nombre)
    && CAMPAIGN_WHATSAPP_SOURCES.has(lead.external_source)
    && lead.patient_context?.relationship === 'existing_patient' && lead.patient_context.same_clinic === true
    && positiveId(lead.patient_context.patient_id) && positiveId(lead.clinica_id)
    && positiveId(lead.clinica_id) === positiveId(lead.patient_context.clinic_id));
  if (!candidates.length) return rows;

  const clinics = [...new Set(candidates.map(lead => positiveId(lead.clinica_id)))];
  const clinicPermissions = await Promise.all(clinics.map(async clinic => [clinic, await canSeePatientDetails(clinic)]));
  const allowed = new Map(clinicPermissions);
  const eligible = new Set(candidates.filter(lead => allowed.get(positiveId(lead.clinica_id))));
  if (!eligible.size) return rows;

  const ids = [...new Set([...eligible].map(lead => positiveId(lead.patient_context.patient_id)))];
  const patients = new Map((await loadPatients(ids)).map(plain).map(patient => [positiveId(patient.id_paciente), patient]));
  return rows.map(lead => {
    if (!eligible.has(lead)) return lead;
    const patient = patients.get(positiveId(lead.patient_context.patient_id));
    const clinicId = positiveId(lead.clinica_id);
    if (!patient || (positiveId(patient.clinica_id) !== clinicId
      && !patient.clinicasVinculadas?.some(link => positiveId(link.clinica_id) === clinicId))) return lead;
    const phone = normalizeContextPhone(lead.telefono);
    if (!phone || phone !== normalizeContextPhone(patient.telefono_movil)) return lead;
    const name = [trim(patient.nombre), trim(patient.apellidos)].filter(Boolean).join(' ');
    return name ? { ...lead, nombre: name } : lead;
  });
}

module.exports = { fillExistingPatientNames };
