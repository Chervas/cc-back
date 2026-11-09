'use strict';

// Recovery of private form responses for EXISTING native leads only. It never
// runs the normal ingestion job, invokes notifications, or creates/updates a lead.
const { Op, literal, where: sqlWhere, json } = require('sequelize');
const { retrieveMetaLead, resolveMetaLeadClinic, JOB_TYPE } = require('./metaLeadReception.service');
const { storeMetaLeadFormResponse, nativeFormSource } = require('./metaLeadFormResponse.service');

const graphId = value => typeof value === 'string' && /^[1-9][0-9]{0,29}$/.test(value);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail = code => { throw Object.assign(Error(code), { code }); };
const plain = row => row?.get ? row.get({ plain: true }) : row;
const LEAD_FIELDS = ['id', 'clinica_id', 'grupo_clinica_id', 'external_source', 'external_id',
  'source', 'channel', 'source_detail', 'archived_at'];
const STOP = new Set(['rate_limited', 'credential_revoked', 'provider_unauthorized', 'scope_denied',
  'asset_revoked', 'connection_blocked', 'broker_configuration_invalid', 'meta_leads_disabled',
  // Closed classifications emitted by the reader. Further leads cannot repair
  // authorization or broker authority, so preserve the code and stop the batch.
  'meta_credential_renewal_required', 'meta_business_activation_uncertain', 'broker_cohort_disabled',
  'meta_broker_binding_invalid', 'meta_broker_scope_changed', 'meta_broker_not_active']);
function decoded(value) {
  if (typeof value !== 'string') return value;
  // JSON SQL projections differ between dialect adapters. Never turn an
  // already-unquoted Graph ID (especially a 64-bit ID) into a JS number.
  if (value === 'null') return null;
  if (!/^[\[{\"]/.test(value.trimStart())) return value;
  try { return JSON.parse(value); } catch { return value; }
}
function ids(value, max) {
  if (!Array.isArray(value) || !value.length || value.length > max
    || value.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(value).size !== value.length)
    fail('meta_lead_form_enrichment_invalid');
  return [...value];
}
function payloadOf(job, lead, runtime) {
  const p = decoded(plain(job).payload);
  if (!p || Object.getPrototypeOf(p) !== Object.prototype || p.lead_id !== lead.external_id
    || !graphId(p.page_id) || !graphId(p.form_id) || p.ad_id !== null && !graphId(p.ad_id)
    || !uuid.test(p.receipt_ref || '') || !Number.isSafeInteger(p.page_asset_id) || p.page_asset_id < 1
    || !Number.isSafeInteger(p.account_asset_id) || p.account_asset_id < 1
    || p.__runtime_namespace !== runtime) fail('meta_lead_form_receipt_unavailable');
  return { lead_id: p.lead_id, page_id: p.page_id, form_id: p.form_id, ad_id: p.ad_id,
    receipt_ref: p.receipt_ref, page_asset_id: p.page_asset_id, account_asset_id: p.account_asset_id };
}
const eventOf = payload => Object.fromEntries(['lead_id', 'page_id', 'form_id', 'ad_id'].map(key => [key, payload[key]]));

async function assertSavedProof(models, lead, event, fetchedIdentity, transaction = null) {
  if (lead.source_detail !== 'leadgen_form:' + event.form_id) fail('meta_lead_form_identity_mismatch');
  const rows = await models.LeadAttributionAudit.findAll({ where: { lead_intake_id: Number(lead.id) },
    attributes: [[json('raw_payload.provider'), 'native_provider'], [json('raw_payload.lead_id'), 'native_lead_id'],
      [json('raw_payload.form_id'), 'native_form_id'], [json('attribution_steps.meta_page_id'), 'native_page_id'],
      [json('attribution_steps.advertising_identity'), 'identity']],
    raw: true, transaction, logging: false });
  const proofs = new Map();
  for (const raw of rows) {
    const row = Object.fromEntries(Object.entries(plain(raw)).map(([key, value]) => [key, decoded(value)]));
    // Other audit purposes, including the patient-context snapshot, are separate.
    if (row.native_provider == null && row.identity == null) continue;
    if (row.native_provider !== 'meta_leadgen' || row.native_lead_id !== event.lead_id
      || row.native_form_id !== event.form_id || row.native_page_id !== event.page_id)
      fail('meta_lead_form_identity_mismatch');
    const identity = row.identity;
    if (lead.source === 'meta_ads' && lead.channel === 'paid') {
      if (!identity || identity.version !== 1 || identity.verified_by !== 'meta_graph'
        || identity.provider !== 'meta_ads' || Number(identity.clinic_id) !== Number(lead.clinica_id)
        || ['account_id', 'campaign_id', 'adset_id', 'ad_id', 'page_id', 'form_id'].some(key => !graphId(identity[key]))
        || identity.page_id !== event.page_id || identity.form_id !== event.form_id
        || event.ad_id !== null && identity.ad_id !== event.ad_id) fail('meta_lead_form_identity_mismatch');
      const proof = Object.fromEntries(['account_id', 'campaign_id', 'adset_id', 'ad_id', 'page_id', 'form_id'].map(key => [key, identity[key]]));
      proofs.set(JSON.stringify(proof), proof);
    } else if (lead.source === null && lead.channel === 'organic') {
      if (identity !== null || event.ad_id !== null) fail('meta_lead_form_identity_mismatch');
      proofs.set('organic', null);
    } else fail('meta_lead_form_identity_mismatch');
  }
  if (proofs.size !== 1) fail('meta_lead_form_identity_mismatch');
  const proof = [...proofs.values()][0];
  if (fetchedIdentity !== undefined) {
    if (proof === null ? fetchedIdentity !== null : !fetchedIdentity
      || ['account_id', 'campaign_id', 'adset_id', 'ad_id'].some(key => proof[key] !== fetchedIdentity[key]))
      fail('meta_lead_form_identity_mismatch');
  }
  return proof;
}

function createMetaLeadFormEnrichment({ models, reader, runtime }) {
  if (!models?.sequelize || !['dev', 'staging', 'prod'].includes(runtime)) fail('meta_lead_form_enrichment_invalid');
  async function capture(leadId, clinicIds) {
    const lead = plain(await models.LeadIntake.findByPk(leadId, { attributes: LEAD_FIELDS, raw: true, logging: false }));
    if (!lead || !clinicIds.includes(Number(lead.clinica_id)) || lead.external_source !== 'meta_leadgen'
      || !graphId(lead.external_id)) fail('meta_lead_form_identity_mismatch');
    if (lead.archived_at) fail('meta_lead_form_archived');
    const jobs = await models.JobRequest.findAll({ where: { type: JOB_TYPE, status: 'completed',
      [Op.and]: [sqlWhere(literal("JSON_UNQUOTE(JSON_EXTRACT(`payload`, '$.lead_id'))"), lead.external_id),
        sqlWhere(literal("JSON_UNQUOTE(JSON_EXTRACT(`payload`, '$.__runtime_namespace'))"), runtime)] },
      attributes: ['id', 'payload'], order: [['id', 'ASC']], limit: 21, raw: true, logging: false });
    if (!jobs.length || jobs.length > 20) fail('meta_lead_form_receipt_unavailable');
    const found = new Map(jobs.map(job => {
      const payload = payloadOf(job, lead, runtime);
      return [JSON.stringify(payload), payload];
    }));
    if (found.size !== 1) fail('meta_lead_form_receipt_unavailable');
    const payload = [...found.values()][0], event = eventOf(payload);
    await assertSavedProof(models, lead, event, undefined);
    const saved = await models.FormSubmissionEvent.findAll({ where: { lead_intake_id: Number(lead.id),
      source_detail: nativeFormSource(lead.external_id) }, attributes: ['id', 'clinic_id', 'form_id', 'fields_json', 'payload_json'],
      limit: 2, raw: true, logging: false });
    if (saved.length > 1) fail('meta_lead_form_conflict');
    if (saved.length) {
      const prior = plain(saved[0]), fields = decoded(prior.fields_json), metadata = decoded(prior.payload_json);
      if (Number(prior.clinic_id) !== Number(lead.clinica_id) || prior.form_id !== event.form_id
        || fields?.provider !== 'meta_leadgen' || fields.version !== 2 || !Array.isArray(fields.fields)
        || metadata?.provider !== 'meta_leadgen' || metadata.version !== 2 || metadata.lead_id !== event.lead_id
        || metadata.page_id !== event.page_id || metadata.form_id !== event.form_id
        || !/^[a-f0-9]{64}$/.test(metadata.response_digest || '')) fail('meta_lead_form_conflict');
    }
    return { lead, payload, event, alreadyStored: saved.length === 1 };
  }
  async function enrich(captured) {
    if (!reader) fail('meta_lead_form_enrichment_invalid');
    const { event, payload } = captured;
    // All provider I/O ends before taking authority and parent Lead locks.
    const retrieved = await retrieveMetaLead({ models, event, reader, receiptRef: payload.receipt_ref,
      pageAssetId: payload.page_asset_id, accountAssetId: payload.account_asset_id, responseVersion: 2 });
    if (Number(retrieved.clinic.id_clinica) !== Number(captured.lead.clinica_id)) fail('meta_lead_form_identity_mismatch');
    return models.sequelize.transaction(async transaction => {
      const clinic = await resolveMetaLeadClinic({ models, event, ...retrieved, transaction });
      const lead = plain(await models.LeadIntake.findByPk(captured.lead.id,
        { attributes: LEAD_FIELDS, transaction, lock: transaction.LOCK.UPDATE, raw: true, logging: false }));
      if (!lead || lead.external_source !== 'meta_leadgen' || lead.external_id !== event.lead_id
        || Number(lead.clinica_id) !== Number(captured.lead.clinica_id)
        || Number(clinic.id_clinica) !== Number(lead.clinica_id)) fail('meta_lead_form_identity_mismatch');
      if (lead.archived_at) fail('meta_lead_form_archived');
      await assertSavedProof(models, lead, event, retrieved.identity, transaction);
      return storeMetaLeadFormResponse({ models, event, lead, clinic, transaction,
        formResponse: retrieved.formResponse, providerCreatedAt: retrieved.lead.created_time });
    });
  }
  async function run({ leadIds, clinicIds, apply = false }) {
    leadIds = ids(leadIds, 20); clinicIds = ids(clinicIds, 20);
    if (typeof apply !== 'boolean') fail('meta_lead_form_enrichment_invalid');
    const results = []; let stopped = false;
    for (const leadId of leadIds) {
      if (stopped) { results.push({ leadId, status: 'not_attempted', code: 'meta_lead_form_batch_stopped' }); continue; }
      try {
        const captured = await capture(leadId, clinicIds);
        if (captured.alreadyStored) { results.push({ leadId, clinicId: Number(captured.lead.clinica_id), status: 'already_enriched' }); continue; }
        if (!apply) { results.push({ leadId, clinicId: Number(captured.lead.clinica_id), status: 'ready', providerRead: false }); continue; }
        const result = await enrich(captured);
        results.push({ leadId, clinicId: Number(captured.lead.clinica_id), status: result.stored ? 'enriched' : 'already_enriched',
          fieldCount: result.fieldCount });
      } catch (error) {
        const code = typeof error?.code === 'string' && (/^meta_lead_[a-z_]{1,80}$/.test(error.code) || STOP.has(error.code))
          ? error.code : 'meta_lead_form_enrichment_unavailable';
        results.push({ leadId, status: 'unavailable', code,
          ...(error?.code === 'rate_limited' && Number.isSafeInteger(error.retryAfterMs) ? { retryAfterMs: error.retryAfterMs } : {}) });
        if (STOP.has(error?.code)) stopped = true;
      }
    }
    return { version: 1, mode: apply ? 'apply' : 'dry-run', runtime, results };
  }
  return { run };
}

module.exports = { createMetaLeadFormEnrichment, assertSavedProof };
