'use strict';

const { Op } = require('sequelize');
const { leadCampaign } = require('./campaignWorkspaceReport.service');

const id = value => /^\d+$/.test(String(value || '')) ? String(value) : null;
const time = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).getTime() : null;
const patientKey = (clinic, patient) => `${clinic}:${patient}`;

function budgetCampaignAttribution({ campaigns, budgets, appointments, leads, period }) {
  const clinics = new Set(campaigns.filter(row => row.assigned).map(row => Number(row.clinicId)));
  const byLead = new Map(leads.map(lead => [id(lead.id), lead]));
  const byPatient = new Map();
  for (const appointment of appointments) {
    if (!id(appointment.paciente_id) || !id(appointment.lead_intake_id) || appointment.es_provisional
      || ['cancelada', 'reprogramada'].includes(appointment.estado)) continue;
    const key = patientKey(appointment.clinica_id, appointment.paciente_id);
    if (!byPatient.has(key)) byPatient.set(key, []);
    byPatient.get(key).push(appointment);
  }
  const allocations = []; const seen = new Set();
  const coverage = { attributed: 0, unlinked: 0, ambiguous: 0, invalid: 0 };
  for (const budget of budgets) {
    const budgetId = id(budget.id); const acceptedAt = time(budget.responded_at);
    if (!budgetId || seen.has(budgetId) || !clinics.has(Number(budget.clinic_id))
      || !['accepted', 'partially_accepted'].includes(budget.status)
      || acceptedAt === null || acceptedAt < +period.from || acceptedAt >= +period.until) continue;
    seen.add(budgetId);
    const amount = Number(budget.accepted_amount);
    if (budget.accepted_amount === null || budget.accepted_amount === '' || !Number.isFinite(amount) || amount < 0
      || !Number.isSafeInteger(Math.round(amount * 100))) { coverage.invalid++; continue; }
    const links = (byPatient.get(patientKey(budget.clinic_id, budget.patient_id)) || [])
      .filter(row => time(row.created_at) !== null && time(row.created_at) <= acceptedAt);
    if (!links.length) { coverage.unlinked++; continue; }
    const candidates = new Set();
    for (const link of links) {
      const lead = byLead.get(id(link.lead_intake_id));
      const leadAt = time(lead?.created_at);
      const valid = lead && lead.source === 'google_ads' && id(lead.google_ads_customer_id) && id(lead.google_ads_campaign_id)
        && Number(lead.clinica_id) === Number(budget.clinic_id) && leadAt !== null && leadAt <= time(link.created_at);
      candidates.add(valid ? leadCampaign(lead, campaigns) : null);
    }
    // A second or unknown acquisition origin must not silently become last-touch attribution.
    if (candidates.size !== 1 || candidates.has(null)) { coverage.ambiguous++; continue; }
    allocations.push({ campaignId: [...candidates][0], acceptedAt: budget.responded_at, amountCents: Math.round(amount * 100) });
    coverage.attributed++;
  }
  return { currency: 'EUR', supportedProviders: ['google_ads'], method: 'accepted_budget_single_campaign_via_linked_appointment', allocations, coverage };
}

async function loadBudgetCampaignAttribution({ models, campaigns, period }) {
  const clinicIds = [...new Set(campaigns.filter(row => row.assigned).map(row => row.clinicId))];
  const budgets = clinicIds.length ? await models.EconomicBudget.findAll({ where: {
    clinic_id: { [Op.in]: clinicIds }, status: { [Op.in]: ['accepted', 'partially_accepted'] },
    responded_at: { [Op.gte]: period.from, [Op.lt]: period.until },
  }, attributes: ['id', 'clinic_id', 'patient_id', 'status', 'responded_at', 'accepted_amount'], raw: true }) : [];
  const patients = [...new Map(budgets.map(row => [patientKey(row.clinic_id, row.patient_id),
    { clinica_id: row.clinic_id, paciente_id: row.patient_id }])).values()];
  const appointments = patients.length ? await models.CitaPaciente.findAll({ where: { [Op.or]: patients,
    lead_intake_id: { [Op.ne]: null }, created_at: { [Op.lt]: period.until } },
  attributes: ['id_cita', 'clinica_id', 'paciente_id', 'lead_intake_id', 'created_at', 'estado', 'es_provisional'], raw: true }) : [];
  const leadIds = [...new Set(appointments.map(row => row.lead_intake_id))];
  const leads = leadIds.length ? await models.LeadIntake.findAll({ where: { id: { [Op.in]: leadIds }, clinica_id: { [Op.in]: clinicIds } },
    attributes: ['id', 'clinica_id', 'source', 'channel', 'utm_source', 'utm_campaign', 'source_detail',
      'google_ads_customer_id', 'google_ads_campaign_id', 'created_at'], raw: true }) : [];
  return budgetCampaignAttribution({ campaigns, budgets, appointments, leads, period });
}

module.exports = { budgetCampaignAttribution, loadBudgetCampaignAttribution };
