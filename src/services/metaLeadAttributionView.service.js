'use strict';

const { Op, json } = require('sequelize');
const { metaAdvertisingIdentity } = require('./leadAdvertisingIdentity.service');

const graphId = value => typeof value === 'string' && /^[1-9][0-9]{0,29}$/.test(value);
const accountId = value => String(value || '').replace(/^act_/, '');
const scalar = value => {
  if (typeof value !== 'string') return value;
  if (!/^(?:["\[{]|null$)/.test(value)) return value;
  try { return JSON.parse(value); } catch { return value; }
};
const name = value => typeof value === 'string' && value.trim() && value.length <= 255
  && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : null;

function nativeLead(lead) {
  return Number.isSafeInteger(Number(lead?.id)) && Number(lead.id) > 0
    && Number.isSafeInteger(Number(lead.clinica_id)) && Number(lead.clinica_id) > 0
    && lead.external_source === 'meta_leadgen' && graphId(lead.external_id)
    && ((lead.source === 'meta_ads' && lead.channel === 'paid')
      || (lead.source == null && lead.channel === 'organic'))
    && ![lead.gclid, lead.gbraid, lead.wbraid, lead.google_ads_customer_id,
      lead.google_ads_campaign_id, lead.ttclid].some(Boolean);
}

// These are historical, server-written receipts for an already authorized lead.
// Ignore unrelated patient-context audits, but never pick the first of two
// conflicting native receipts. No contact fields or form answers are selected.
function nativeMetaProof(lead, rows) {
  const matches = new Map();
  for (const row of rows) {
    const raw = scalar(row.identity);
    const provider = scalar(row.native_provider);
    if (provider !== 'meta_leadgen' && raw == null) continue;
    const leadId = scalar(row.native_lead_id), formId = scalar(row.native_form_id);
    const pageId = scalar(row.native_page_id);
    if (provider !== 'meta_leadgen' || leadId !== lead.external_id || !graphId(formId)
      || !graphId(pageId) || lead.source_detail !== `leadgen_form:${formId}`) return null;
    let identity = null;
    if (lead.channel === 'paid') {
      identity = metaAdvertisingIdentity(raw, lead.clinica_id);
      if (!identity || identity.page_id !== pageId || identity.form_id !== formId
        || !graphId(identity.account_id) || !graphId(identity.campaign_id)
        || !graphId(identity.ad_id) || raw.adset_id != null && !graphId(raw.adset_id)) return null;
      identity = { ...identity, adset_id: raw.adset_id ?? null };
    } else if (raw != null) return null;
    const proof = { identity, form: { provider: 'meta', page_id: pageId, form_id: formId,
      name: null, organic: lead.channel === 'organic' } };
    matches.set(JSON.stringify(proof), proof);
  }
  return matches.size === 1 ? [...matches.values()][0] : null;
}

function entityIndex(rows) {
  const index = new Map();
  for (const row of rows) {
    const key = `${accountId(row.ad_account_id)}:${row.level}:${row.entity_id}`;
    const value = { id: row.entity_id, parent_id: row.parent_id ?? null, name: name(row.name) };
    if (!index.has(key)) index.set(key, value);
    else if (JSON.stringify(index.get(key)) !== JSON.stringify(value)) index.set(key, null);
  }
  return index;
}

async function loadMetaLeadAttribution({ models, leads = [], transaction = null }) {
  const eligible = leads.filter(nativeLead);
  if (!eligible.length || !models.LeadAttributionAudit) return new Map();
  const byId = new Map(eligible.map(lead => [String(lead.id), lead]));
  const audits = await models.LeadAttributionAudit.findAll({
    where: { lead_intake_id: { [Op.in]: [...byId.keys()] } },
    attributes: ['lead_intake_id',
      [json('attribution_steps.advertising_identity'), 'identity'],
      [json('attribution_steps.meta_page_id'), 'native_page_id'],
      [json('raw_payload.provider'), 'native_provider'],
      [json('raw_payload.lead_id'), 'native_lead_id'],
      [json('raw_payload.form_id'), 'native_form_id']],
    raw: true, ...(transaction ? { transaction } : {}),
  });
  const grouped = new Map();
  for (const row of audits) {
    const key = String(row.lead_intake_id);
    if (!byId.has(key)) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  const proofs = new Map();
  for (const [id, lead] of byId) {
    const proof = nativeMetaProof(lead, grouped.get(id) || []);
    if (proof) proofs.set(id, proof);
  }
  const identities = [...proofs.values()].map(proof => proof.identity).filter(Boolean);
  const keys = [...new Map(identities.flatMap(identity => [
    { account: identity.account_id, level: 'campaign', id: identity.campaign_id },
    ...(identity.adset_id ? [{ account: identity.account_id, level: 'adset', id: identity.adset_id }] : []),
    { account: identity.account_id, level: 'ad', id: identity.ad_id },
  ]).map(key => [`${key.account}:${key.level}:${key.id}`, key])).values()];
  const rows = keys.length && models.SocialAdsEntity ? await models.SocialAdsEntity.findAll({
    where: { [Op.or]: keys.map(key => ({
      ad_account_id: { [Op.in]: [key.account, `act_${key.account}`] }, level: key.level, entity_id: key.id,
    })) },
    attributes: ['ad_account_id', 'level', 'entity_id', 'parent_id', 'name'], raw: true,
    ...(transaction ? { transaction } : {}),
  }) : [];
  const index = entityIndex(rows);
  const result = new Map();
  for (const [id, proof] of proofs) {
    const identity = proof.identity;
    if (!identity) { result.set(id, { meta_form: proof.form }); continue; }
    const get = (level, entityId) => index.get(`${identity.account_id}:${level}:${entityId}`);
    const campaign = get('campaign', identity.campaign_id);
    const adset = identity.adset_id ? get('adset', identity.adset_id) : null;
    const validAdset = adset?.parent_id === identity.campaign_id ? adset : null;
    const ad = get('ad', identity.ad_id);
    // A cached name is usable only for the same account and observed hierarchy.
    // Missing/stale inventory never removes the verified historical identifiers.
    const validAd = validAdset && ad?.parent_id === identity.adset_id ? ad : null;
    result.set(id, { provider: 'meta_ads', customer_id: identity.account_id,
      campaign_id: identity.campaign_id, campaign_name: campaign?.name || null,
      adset_id: identity.adset_id, adset_name: validAdset?.name || null,
      ad_id: identity.ad_id, ad_name: validAd?.name || null,
      page_id: identity.page_id, form_id: identity.form_id, meta_form: proof.form });
  }
  return result;
}

module.exports = { loadMetaLeadAttribution, nativeMetaProof };
