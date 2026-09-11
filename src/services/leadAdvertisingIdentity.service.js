'use strict';

const { Op, json } = require('sequelize');
const crypto = require('node:crypto');
const { metaWebAdvertisingIdentity, WEB_LEAD_SOURCES } = require('../lib/meta-web-attribution');
const id = value => typeof value === 'string' && /^[0-9]{1,64}$/.test(value) ? value : null;

function googleNativeAdvertisingIdentity(value, clinicId) {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return null; } }
  if (!value || value.version !== 1 || value.verified_by !== 'google_ads_api' || value.provider !== 'google_ads'
    || Number(value.clinic_id) !== Number(clinicId) || !id(value.account_id) || !id(value.campaign_id)
    || !id(value.form_id) || value.ad_id != null && !id(value.ad_id) || value.adgroup_id != null && !id(value.adgroup_id)) return null;
  return { provider: 'google_ads', account_id: value.account_id, campaign_id: value.campaign_id,
    form_id: value.form_id, ad_id: value.ad_id || null, adgroup_id: value.adgroup_id || null };
}

async function resolveNativeGoogleLeadIdentity({ models, lead, transaction = null }) {
  if (lead?.source !== 'google_ads' || lead.external_source !== 'google_lead_form'
    || !/^[a-f0-9]{64}$/.test(lead.external_id || '')) return null;
  const rows = await models.LeadAttributionAudit.findAll({ where: { lead_intake_id: lead.id },
    attributes: [[json('attribution_steps.advertising_identity'), 'identity'],
      [json('raw_payload.lead_id'), 'native_lead_id']], raw: true, transaction });
  const matches = new Map();
  for (const row of rows) {
    const identity = googleNativeAdvertisingIdentity(row.identity, lead.clinica_id);
    if (!identity) return null;
    let nativeId = row.native_lead_id;
    if (typeof nativeId === 'string' && nativeId.startsWith('"')) {
      try { nativeId = JSON.parse(nativeId); } catch { return null; }
    }
    if (typeof nativeId !== 'string' || !nativeId || nativeId.length > 1024
      || crypto.createHash('sha256').update(nativeId).digest('hex') !== lead.external_id
      || identity.account_id !== lead.google_ads_customer_id || identity.campaign_id !== lead.google_ads_campaign_id
      || lead.source_detail !== `leadgen_form:${identity.form_id}`) return null;
    matches.set(JSON.stringify(identity), identity);
  }
  return matches.size === 1 ? [...matches.values()][0] : null;
}

function metaAdvertisingIdentity(value, clinicId) {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return null; } }
  if (!value || value.version !== 1 || value.verified_by !== 'meta_graph' || value.provider !== 'meta_ads'
    || Number(value.clinic_id) !== Number(clinicId) || !id(value.account_id) || !id(value.campaign_id)
    || !id(value.ad_id) || !id(value.page_id) || !id(value.form_id)) return null;
  return { provider: 'meta_ads', account_id: value.account_id, campaign_id: value.campaign_id,
    ad_id: value.ad_id, page_id: value.page_id, form_id: value.form_id };
}

function canonicalLeadAdvertisingIdentity(lead) {
  const web = metaWebAdvertisingIdentity(lead.advertising_identity, lead.clinica_id);
  if (web && WEB_LEAD_SOURCES.includes(lead.source)) return web;
  if (lead.source === 'google_ads' && id(lead.google_ads_customer_id) && id(lead.google_ads_campaign_id)) {
    return { provider: 'google_ads', account_id: lead.google_ads_customer_id, campaign_id: lead.google_ads_campaign_id };
  }
  return lead.source === 'meta_ads' ? metaAdvertisingIdentity(lead.advertising_identity, lead.clinica_id) : null;
}

async function attachLeadAdvertisingIdentities({ models, leads, transaction = null }) {
  const eligible = leads.filter(lead => WEB_LEAD_SOURCES.includes(lead.source));
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
    const web = metaWebAdvertisingIdentity(row.identity, lead.clinica_id);
    const value = web || (lead.source === 'meta_ads' ? metaAdvertisingIdentity(row.identity, lead.clinica_id) : null);
    if (!value) continue;
    if (!identities.has(String(lead.id))) identities.set(String(lead.id), new Map());
    identities.get(String(lead.id)).set(JSON.stringify(value), web || { version: 1, verified_by: 'meta_graph',
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

async function resolveMetaWebLeadIdentity({ models, lead, transaction = null }) {
  if (!WEB_LEAD_SOURCES.includes(lead?.source) || lead.external_source === 'meta_leadgen') return null;
  const rows = await models.LeadAttributionAudit.findAll({ where: { lead_intake_id: lead.id },
    attributes: [[json('attribution_steps.advertising_identity'), 'identity']], raw: true, transaction });
  const identities = new Map();
  for (const row of rows) {
    const identity = metaWebAdvertisingIdentity(row.identity, lead.clinica_id);
    if (identity) identities.set(JSON.stringify(identity), identity);
  }
  return identities.size === 1 ? [...identities.values()][0] : null;
}

module.exports = { googleNativeAdvertisingIdentity, resolveNativeGoogleLeadIdentity,
  metaAdvertisingIdentity, canonicalLeadAdvertisingIdentity, attachLeadAdvertisingIdentities,
  resolveNativeMetaLeadIdentity, resolveMetaWebLeadIdentity };
