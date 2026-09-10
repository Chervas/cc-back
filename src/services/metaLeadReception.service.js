'use strict';

const crypto = require('node:crypto');
const { Op } = require('sequelize');
const { normalizePhoneDigits } = require('../lib/phone');
const { campaignIncluded } = require('./campaignWorkspaceSettings.service');

const JOB_TYPE = 'campaign_meta_lead_receive';
const graphId = value => typeof value === 'string' && /^[0-9]{1,64}$/.test(value) ? value : null;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const hash = value => value ? crypto.createHash('sha256').update(value).digest('hex') : null;
const query = transaction => ({ raw: true, transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}) });
const scopeKey = row => row.assignmentScope === 'group' && row.grupoClinicaId ? `group:${row.grupoClinicaId}`
  : row.assignmentScope === 'clinic' && row.clinicaId ? `clinic:${row.clinicaId}` : null;

function receptionRuntimeNamespace(env = process.env) {
  if (env.RUNTIME_ROLE === 'gateway') return env.META_LEAD_JOB_RUNTIME_NAMESPACE
    || env.AUTOMATIONS_V2_FALLBACK_RUNTIME_NAMESPACE || 'staging';
  return env.JOB_RUNTIME_NAMESPACE || env.RUNTIME_NAMESPACE || null;
}

function webhookEvents(body) {
  if (body?.object !== 'page' || !Array.isArray(body.entry)) return [];
  const events = new Map();
  for (const entry of body.entry) for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
    if (change.field !== 'leadgen') continue;
    const value = change.value || {};
    const event = { lead_id: graphId(value.leadgen_id || value.lead_id), page_id: graphId(value.page_id || entry.id),
      form_id: graphId(value.form_id), ad_id: graphId(value.ad_id) };
    if (!event.lead_id || !event.page_id || !event.form_id || (value.ad_id && !event.ad_id)
      || (entry.id && graphId(entry.id) !== event.page_id)) fail('meta_lead_invalid_notification');
    const previous = events.get(event.lead_id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(event)) fail('meta_lead_conflicting_notification');
    events.set(event.lead_id, event);
  }
  return [...events.values()];
}

async function enqueueMetaLeadNotifications(body, overrides = {}) {
  const models = overrides.models || require('../../models');
  const enqueue = overrides.enqueue || require('./jobRequests.service').enqueueUniqueJobRequest;
  const namespace = receptionRuntimeNamespace(overrides.env || process.env);
  const events = webhookEvents(body);
  let queued = 0;
  for (const event of events) {
    const mapped = await models.ClinicMetaAsset.findOne({ where: { isActive: true, assetType: 'facebook_page',
      metaAssetId: event.page_id }, attributes: ['id'], raw: true });
    if (!mapped) continue;
    // Only signed provider identifiers enter the queue, never contact fields, tokens or arbitrary webhook JSON.
    await enqueue({ type: JOB_TYPE, payload: { ...event, ...(namespace ? { __runtime_namespace: namespace } : {}) }, priority: 'high', origin: 'meta_leadgen_webhook',
      dedupeScope: `meta_leadgen:${event.lead_id}`, maxAttempts: 8 });
    queued++;
  }
  return { queued };
}

async function activeAssets(models, type, ids, transaction = null) {
  const rows = await models.ClinicMetaAsset.findAll({ where: { isActive: true, assetType: type,
    metaAssetId: { [Op.in]: ids } }, ...query(transaction) });
  if (!rows.length) return [];
  const assignments = await models.MetaConnectionAssignment.findAll({ where: {
    scopeKey: { [Op.in]: [...new Set(rows.map(scopeKey).filter(Boolean))] }, status: 'active',
  }, ...query(transaction) });
  return rows.filter(row => assignments.some(assignment => assignment.scopeKey === scopeKey(row)
    && Number(assignment.metaConnectionId) === Number(row.metaConnectionId)));
}

function covers(asset, clinic) {
  return asset.assignmentScope === 'clinic' ? Number(asset.clinicaId) === Number(clinic.id_clinica)
    : asset.assignmentScope === 'group' && Number(asset.grupoClinicaId) === Number(clinic.grupoClinicaId);
}

async function resolveMetaLeadClinic({ models, event, identity, pageAssetId, connectionId, transaction = null }) {
  const pages = await activeAssets(models, 'facebook_page', [event.page_id], transaction);
  const page = pages.find(row => Number(row.id) === Number(pageAssetId) && Number(row.metaConnectionId) === Number(connectionId));
  if (!page) fail('meta_lead_page_access_required');
  const connection = await models.MetaConnection.findByPk(connectionId, query(transaction));
  if (!connection || (connection.expiresAt && +new Date(connection.expiresAt) <= Date.now())) fail('meta_lead_page_access_required');
  let candidates = [];
  if (identity) {
    const accounts = await activeAssets(models, 'ad_account', [identity.account_id, `act_${identity.account_id}`], transaction);
    if (!accounts.length) fail('meta_lead_account_access_required');
    const decisions = await models.ExternalCampaignAssignment.findAll({ where: { provider: 'meta_ads',
      customer_id: { [Op.in]: [identity.account_id, `act_${identity.account_id}`] }, campaign_id: identity.campaign_id }, ...query(transaction) });
    if (decisions.length) {
      if (decisions.length !== 1 || decisions[0].status !== 'active' || !decisions[0].clinica_id) fail('meta_lead_clinic_assignment_required');
      candidates = [Number(decisions[0].clinica_id)];
    } else {
      // A group mapping's representative clinicaId is not a routing decision.
      if (accounts.some(row => row.assignmentScope !== 'clinic')) fail('meta_lead_clinic_assignment_required');
      candidates = [...new Set(accounts.map(row => Number(row.clinicaId)))];
    }
    if (candidates.length !== 1) fail('meta_lead_clinic_assignment_required');
    const clinic = await models.Clinica.findByPk(candidates[0], query(transaction));
    if (!clinic || ![true, 1, '1'].includes(clinic.estado_clinica) || !covers(page, clinic)
      || !accounts.some(row => covers(row, clinic))) fail('meta_lead_clinic_scope_mismatch');
    const settings = await models.CampaignWorkspaceSetting.findAll({ where: { [Op.or]: [
      { scope_type: 'clinic', scope_id: clinic.id_clinica },
      ...(clinic.grupoClinicaId ? [{ scope_type: 'group', scope_id: clinic.grupoClinicaId }] : []),
    ] }, ...query(transaction) });
    const setting = settings.find(row => row.scope_type === 'clinic') || settings.find(row => row.scope_type === 'group');
    if (!campaignIncluded({ provider: 'meta_ads', ...identity }, setting)) fail('meta_lead_campaign_not_selected');
    return clinic;
  }
  if (pages.some(row => row.assignmentScope !== 'clinic')
    || new Set(pages.map(row => Number(row.clinicaId))).size !== 1) fail('meta_lead_clinic_assignment_required');
  const clinic = await models.Clinica.findByPk(page.clinicaId, query(transaction));
  if (!clinic || ![true, 1, '1'].includes(clinic.estado_clinica) || !covers(page, clinic)) fail('meta_lead_clinic_scope_mismatch');
  return clinic;
}

async function graphRead(id, fields, token, http) {
  if (!token) fail('meta_lead_page_access_required');
  const version = process.env.META_GRAPH_VERSION || 'v24.0';
  try {
    const { data } = await http.get(`https://graph.facebook.com/${version}/${id}`, {
      headers: { Authorization: `Bearer ${token}` }, params: { fields }, timeout: 15000, maxRedirects: 0,
    });
    if (!data || data.error) fail('meta_lead_provider_unavailable');
    return data;
  } catch (error) {
    const code = Number(error.response?.data?.error?.code);
    // Do not let Axios config/headers or provider messages containing personal data reach jobs or logs.
    fail([10, 190, 200].includes(code) ? 'meta_lead_page_access_required' : 'meta_lead_provider_unavailable');
  }
}

async function retrieveMetaLead({ models, event, http, now = new Date() }) {
  const pages = await activeAssets(models, 'facebook_page', [event.page_id]);
  if (!pages.length) fail('meta_lead_page_access_required');
  let lastError = 'meta_lead_page_access_required';
  for (const page of pages) {
    const connection = await models.MetaConnection.findByPk(page.metaConnectionId, { raw: true });
    if (!connection || (connection.expiresAt && +new Date(connection.expiresAt) <= +now)) continue;
    try {
      const lead = await graphRead(event.lead_id, 'id,field_data,ad_id,campaign_id,form_id,created_time,is_organic',
        page.pageAccessToken || connection.accessToken, http);
      if (graphId(lead.id) !== event.lead_id || graphId(lead.form_id) !== event.form_id
        || (event.ad_id && graphId(lead.ad_id) !== event.ad_id)) fail('meta_lead_identity_mismatch');
      const adId = graphId(lead.ad_id);
      let identity = null;
      if (adId) {
        const ad = await graphRead(adId, 'id,account_id,campaign_id,adset_id', connection.accessToken, http);
        if (graphId(ad.id) !== adId || !graphId(ad.account_id) || !graphId(ad.campaign_id)
          || (lead.campaign_id && lead.campaign_id !== ad.campaign_id)) fail('meta_lead_identity_mismatch');
        identity = { account_id: ad.account_id, campaign_id: ad.campaign_id, ad_id: adId, adset_id: graphId(ad.adset_id) };
      } else if (lead.is_organic !== true) fail('meta_lead_identity_unavailable');
      const clinic = await resolveMetaLeadClinic({ models, event, identity, pageAssetId: page.id, connectionId: connection.id });
      return { lead, identity, clinic, pageAssetId: page.id, connectionId: connection.id };
    } catch (error) {
      if (!error.code?.startsWith('meta_lead_')) throw error;
      lastError = error.code;
    }
  }
  fail(lastError);
}

function contactFields(lead) {
  const fields = Array.isArray(lead.field_data) ? lead.field_data : [];
  const field = name => {
    const value = fields.find(row => row.name === name)?.values?.[0];
    return typeof value === 'string' ? value.trim() : '';
  };
  const email = field('email').toLowerCase();
  const telefono = normalizePhoneDigits(field('phone_number'));
  const validEmail = email.length <= 255 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
  const validPhone = telefono && /^\d{9,15}$/.test(telefono) ? telefono : null;
  if (!validEmail && !validPhone) fail('meta_lead_contact_unavailable');
  return { nombre: (field('full_name') || [field('first_name'), field('last_name')].filter(Boolean).join(' ')).slice(0, 255) || null,
    email: validEmail, telefono: validPhone, email_hash: hash(validEmail), phone_hash: hash(validPhone) };
}

async function persistMetaLead({ models, event, retrieved, now = new Date() }) {
  const contact = contactFields(retrieved.lead);
  return models.sequelize.transaction(async transaction => {
    const clinic = await resolveMetaLeadClinic({ models, event, ...retrieved, transaction });
    if (Number(clinic.id_clinica) !== Number(retrieved.clinic.id_clinica)) fail('meta_lead_clinic_scope_mismatch');
    const existing = await models.LeadIntake.findOne({ where: { external_source: 'meta_leadgen', external_id: event.lead_id },
      transaction, lock: transaction.LOCK.UPDATE });
    if (existing) {
      if (Number(existing.clinica_id) !== Number(clinic.id_clinica)) fail('meta_lead_existing_scope_mismatch');
      return { lead: existing, duplicate: true };
    }
    const identity = retrieved.identity && { version: 1, verified_by: 'meta_graph', provider: 'meta_ads',
      clinic_id: Number(clinic.id_clinica), ...retrieved.identity, page_id: event.page_id, form_id: event.form_id };
    const lead = await models.LeadIntake.create({ clinica_id: clinic.id_clinica, grupo_clinica_id: clinic.grupoClinicaId || null,
      event_id: `meta_leadgen:${event.lead_id}`, external_source: 'meta_leadgen', external_id: event.lead_id,
      source: identity ? 'meta_ads' : null, channel: identity ? 'paid' : 'organic',
      source_detail: `leadgen_form:${event.form_id}`, utm_source: 'meta', utm_medium: 'leadgen',
      clinic_match_source: identity ? 'meta_campaign_assignment' : 'meta_page_id',
      clinic_match_value: identity ? `${identity.account_id}:${identity.campaign_id}` : event.page_id,
      status_lead: 'nuevo', ...contact,
    }, { transaction });
    // The audit is mandatory and commits with the lead. No custom form answers are copied into reporting metadata.
    await models.LeadAttributionAudit.create({ lead_intake_id: lead.id,
      raw_payload: { provider: 'meta_leadgen', lead_id: event.lead_id, form_id: event.form_id,
        provider_created_at: retrieved.lead.created_time || null },
      attribution_steps: { meta_page_id: event.page_id, meta_native_received_at: now.toISOString(),
        advertising_identity: identity },
    }, { transaction });
    return { lead, duplicate: false };
  });
}

async function runMetaLeadReceptionJob(payload, job = null, overrides = {}) {
  const models = overrides.models || require('../../models');
  const http = overrides.http || require('axios');
  const notify = overrides.notify || require('./leadAutoReply.service').enqueueForLead;
  const event = { lead_id: graphId(payload.lead_id), page_id: graphId(payload.page_id),
    form_id: graphId(payload.form_id), ad_id: graphId(payload.ad_id) };
  if (!event.lead_id || !event.page_id || !event.form_id) return { status: 'failed', retryable: false, error_message: 'meta_lead_invalid_notification' };
  try {
    const retrieved = await retrieveMetaLead({ models, event, http });
    const result = await persistMetaLead({ models, event, retrieved });
    if (!result.lead.archived_at) await notify({ lead: result.lead, eventKind: 'write',
      eventAt: result.lead.created_at || result.lead.createdAt || new Date() });
    return { status: 'completed', lead_id: result.lead.id, duplicate: result.duplicate };
  } catch (error) {
    const code = error.code?.startsWith('meta_lead_') ? error.code : 'meta_lead_reception_failed';
    return { status: 'failed', retryable: true, error_message: code };
  }
}

module.exports = { JOB_TYPE, webhookEvents, receptionRuntimeNamespace, enqueueMetaLeadNotifications, resolveMetaLeadClinic,
  retrieveMetaLead, contactFields, persistMetaLead, runMetaLeadReceptionJob };
