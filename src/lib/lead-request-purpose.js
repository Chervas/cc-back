'use strict';

// Internal CRM purpose only. Never copy patient relationship or this audit to Ads payloads.
async function isPatientCareRequest(lead, { models, transaction = null } = {}) {
  const db = models || require('../../models');
  if (!lead?.id || !db.LeadAttributionAudit) return false;
  const rows = await db.LeadAttributionAudit.findAll({ where: { lead_intake_id: Number(lead.id) },
    attributes: ['id', 'attribution_steps'], order: [['id', 'DESC']], transaction, raw: true });
  for (const row of rows) {
    const decision = row.attribution_steps?.lead_patient_attention_v1;
    if (row.attribution_steps?.type === 'lead_patient_attention_v1' && decision?.version === 1) return decision.request_kind === 'patient_care';
  }
  for (const row of rows) {
    const snapshot = row.attribution_steps?.lead_patient_context_v1;
    if (row.attribution_steps?.type === 'lead_patient_context_v1' && snapshot?.version === 1) return snapshot.request_kind === 'patient_care';
  }
  return false;
}

module.exports = { isPatientCareRequest };
