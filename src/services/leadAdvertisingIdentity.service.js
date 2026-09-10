'use strict';

const { Op, json } = require('sequelize');
const id = value => typeof value === 'string' && /^[0-9]{1,64}$/.test(value) ? value : null;

function metaAdvertisingIdentity(value, clinicId) {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return null; } }
  if (!value || value.version !== 1 || value.verified_by !== 'meta_graph' || value.provider !== 'meta_ads'
    || Number(value.clinic_id) !== Number(clinicId) || !id(value.account_id) || !id(value.campaign_id)
    || !id(value.ad_id) || !id(value.page_id) || !id(value.form_id)) return null;
  return { provider: 'meta_ads', account_id: value.account_id, campaign_id: value.campaign_id,
    ad_id: value.ad_id, page_id: value.page_id, form_id: value.form_id };
}

function canonicalLeadAdvertisingIdentity(lead) {
  if (lead.source === 'google_ads' && id(lead.google_ads_customer_id) && id(lead.google_ads_campaign_id)) {
    return { provider: 'google_ads', account_id: lead.google_ads_customer_id, campaign_id: lead.google_ads_campaign_id };
  }
  return lead.source === 'meta_ads' ? metaAdvertisingIdentity(lead.advertising_identity, lead.clinica_id) : null;
}

async function attachLeadAdvertisingIdentities({ models, leads, transaction = null }) {
  const eligible = leads.filter(lead => lead.source === 'meta_ads');
  if (!eligible.length) return leads;
  const byId = new Map(eligible.map(lead => [String(lead.id), lead]));
  // Select only server-written attribution, never raw form data or patient contact fields.
  const rows = await models.LeadAttributionAudit.findAll({ where: { lead_intake_id: { [Op.in]: [...byId.keys()] } },
    attributes: ['lead_intake_id', [json('attribution_steps.advertising_identity'), 'identity']],
    raw: true, transaction });
  const identities = new Map();
  for (const row of rows) {
    const lead = byId.get(String(row.lead_intake_id));
    if (!lead) continue;
    const value = metaAdvertisingIdentity(row.identity, lead.clinica_id);
    if (!value) continue;
    if (!identities.has(String(lead.id))) identities.set(String(lead.id), new Map());
    identities.get(String(lead.id)).set(JSON.stringify(value), { version: 1, verified_by: 'meta_graph',
      clinic_id: Number(lead.clinica_id), ...value });
  }
  for (const lead of eligible) {
    const matches = identities.get(String(lead.id));
    lead.advertising_identity = matches?.size === 1 ? [...matches.values()][0] : null;
    lead.advertising_identity_conflict = (matches?.size || 0) > 1;
  }
  return leads;
}

async function resolveNativeMetaLeadIdentity({ models, lead, transaction = null }) {
  if (lead?.source !== 'meta_ads' || lead.external_source !== 'meta_leadgen' || !id(lead.external_id)) return null;
  const rows = await models.LeadAttributionAudit.findAll({ where: { lead_intake_id: lead.id },
    attributes: [[json('attribution_steps.advertising_identity'), 'identity'],
      [json('raw_payload.lead_id'), 'native_lead_id']], raw: true, ...(transaction ? { transaction } : {}) });
  const matches = new Map();
  for (const row of rows) {
    const identity = metaAdvertisingIdentity(row.identity, lead.clinica_id);
    if (!identity) continue;
    let nativeLeadId = row.native_lead_id;
    if (typeof nativeLeadId === 'string' && nativeLeadId.startsWith('"')) {
      try { nativeLeadId = JSON.parse(nativeLeadId); } catch { return null; }
    }
    if (nativeLeadId !== lead.external_id) return null;
    matches.set(JSON.stringify(identity), identity);
  }
  return matches.size === 1 ? { ...[...matches.values()][0], native_lead_id: lead.external_id } : null;
}

module.exports = { metaAdvertisingIdentity, canonicalLeadAdvertisingIdentity, attachLeadAdvertisingIdentities, resolveNativeMetaLeadIdentity };
