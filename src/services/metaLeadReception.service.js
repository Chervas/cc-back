'use strict';

const crypto = require('node:crypto');
const { Op, literal, where: sqlWhere } = require('sequelize');
const { normalizePhoneDigits } = require('../lib/phone');
const { campaignIncluded } = require('./campaignWorkspaceSettings.service');

const JOB_TYPE = 'campaign_meta_lead_receive';
const graphId = value => typeof value === 'string' && /^[0-9]{1,64}$/.test(value) ? value : null;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const hash = value => value ? crypto.createHash('sha256').update(value).digest('hex') : null;
const query = transaction => ({ raw: true, transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}) });
const MAPPING_FIELDS = ['id', 'metaAssetId', 'metaConnectionId', 'assignmentScope', 'clinicaId', 'grupoClinicaId'];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const sameEvent = (left, right) => ['lead_id', 'page_id', 'form_id', 'ad_id'].every(key => left[key] === right[key]);
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

async function brokerPairsForPage(models, pageId, reader, transaction = null) {
  const pages = await mappedAssets(models, 'facebook_page', [pageId], transaction);
  const pairs = [];
  for (const page of pages) {
    const pageBindings = await models.MetaMarketingBrokerBinding.findAll({ where: { mapping_id: page.id, state: 'active' },
      attributes: ['mapping_id', 'enrollment_id', 'scope_key', 'connection_ref'], ...query(transaction) });
    if (!pageBindings.length) continue;
    if (pageBindings.length !== 1 || !pageBindings[0].enrollment_id) fail('meta_lead_page_access_required');
    const bindings = await models.MetaMarketingBrokerBinding.findAll({ where: { enrollment_id: pageBindings[0].enrollment_id,
      scope_key: pageBindings[0].scope_key, connection_ref: pageBindings[0].connection_ref, state: 'active' },
    attributes: ['mapping_id', 'asset_ref'], ...query(transaction) });
    let accounts = bindings.filter(row => /^meta-ad_account:[1-9][0-9]{0,29}$/.test(row.asset_ref));
    if (typeof models.CampaignWorkspaceSetting?.findOne === 'function') {
      const [scope_type, scopeId] = pageBindings[0].scope_key.split(':');
      const setting = await models.CampaignWorkspaceSetting.findOne({ where: { scope_type, scope_id: Number(scopeId) },
        attributes: ['preferences'], ...query(transaction) });
      const registry = setting?.preferences?.meta_lead_routes;
      if (registry !== undefined) {
        const route = require('./metaLeadRoutes.service').routes(registry).find(row => row.pageAssetRef === 'meta-facebook_page:' + pageId);
        accounts = route ? accounts.filter(row => row.asset_ref === route.adAccountAssetRef) : [];
      }
    }
    if (accounts.length !== 1) fail('meta_lead_account_access_required');
    const pair = await reader.preparePair(Number(page.id), Number(accounts[0].mapping_id), { transaction });
    await reader.assertPair(pair, { transaction });
    pairs.push({ pageAssetId: Number(page.id), accountAssetId: Number(accounts[0].mapping_id), pair });
  }
  if (pairs.length > 1) fail('meta_lead_clinic_assignment_required');
  return pairs;
}

async function enqueueAcceptedMetaLeadJob({ models, enqueue, job }) {
  if (!models.MetaMarketingBusinessDrain) return enqueue(job);
  return models.sequelize.transaction(async transaction => {
    await require('./metaMarketingBusinessDrain.service').createDrain({ models }).assertAdmission(job.payload, { transaction });
    const completed = await models.JobRequest.findOne({ where: { type: JOB_TYPE, status: 'completed',
      [Op.and]: [sqlWhere(literal("JSON_UNQUOTE(JSON_EXTRACT(`payload`, '$.receipt_ref'))"), job.payload.receipt_ref)] },
      order: [['id', 'ASC']], raw: true, transaction, lock: transaction.LOCK.UPDATE, logging: false });
    if (completed) {
      const p = typeof completed.payload === 'string' ? JSON.parse(completed.payload) : completed.payload;
      if (!sameEvent(p, job.payload) || p.page_asset_id !== job.payload.page_asset_id || p.account_asset_id !== job.payload.account_asset_id)
        fail('meta_lead_receipt_review_required');
      return { job: completed, created: false };
    }
    return enqueue(job, { transaction, JobRequestModel: models.JobRequest, sequelizeInstance: models.sequelize });
  });
}

async function enqueueMetaLeadNotifications(body, overrides = {}) {
  const models = overrides.models || require('../../models');
  const enqueue = overrides.enqueue || require('./jobRequests.service').enqueueUniqueJobRequest;
  const reader = overrides.reader || require('./metaMarketingLeadReader.service').forModels(models);
  const namespace = receptionRuntimeNamespace(overrides.env || process.env);
  const events = webhookEvents(body);
  const raw = overrides.raw;
  const signature = overrides.signature;
  if (!Buffer.isBuffer(raw) || raw.length < 1 || raw.length > 65536 || typeof signature !== 'string'
    || !/^sha256=[a-f0-9]{64}$/.test(signature)) fail('meta_lead_invalid_notification');
  const acceptedJobs = [];
  let failure = null, queued = 0;
  for (const pageId of [...new Set(events.map(event => event.page_id))]) {
    try {
      const pairs = await brokerPairsForPage(models, pageId, reader);
      if (!pairs.length) fail('meta_lead_page_access_required');
      for (const selected of pairs) {
        // Every eligible Page receives the same original signed bytes. Owner
        // receipts commit independently, so one unconfigured Page must not
        // prevent another eligible Page in this delivery from being accepted.
        const accepted = await reader.read(selected.pair, 'receiptAccept', { rawBase64: raw.toString('base64'), signature });
        if (accepted?.persisted !== true || !Array.isArray(accepted.receipts)) fail('meta_lead_identity_mismatch');
        const expected = new Map(events.filter(event => event.page_id === pageId).map(event => [event.lead_id, event]));
        const seen = new Set(), pageJobs = [];
        for (const receipt of accepted.receipts) {
          const event = expected.get(receipt.event?.lead_id);
          if (!event || !sameEvent(receipt.event, event) || !UUID.test(receipt.receiptRef) || seen.has(event.lead_id)) fail('meta_lead_identity_mismatch');
          seen.add(event.lead_id);
          pageJobs.push({ type: JOB_TYPE, payload: { ...event, receipt_ref: receipt.receiptRef,
            page_asset_id: selected.pageAssetId, account_asset_id: selected.accountAssetId,
            ...(namespace ? { __runtime_namespace: namespace } : {}) }, priority: 'high', origin: 'meta_leadgen_webhook',
          dedupeScope: `meta_leadgen:${event.lead_id}`, maxAttempts: 8 });
        }
        if (accepted.receipts.length !== expected.size) fail('meta_lead_identity_mismatch');
        acceptedJobs.push(...pageJobs);
      }
    } catch (error) {
      // A global HMAC failure must never create new jobs for this request,
      // including when another Page already committed an owner receipt.
      if (error?.code === 'invalid_signature') throw error;
      failure ||= error || new Error('meta_lead_receipt_unavailable');
    }
  }
  for (const job of acceptedJobs) {
    try { await enqueueAcceptedMetaLeadJob({ models, enqueue, job }); queued++; } catch (error) { failure ||= error || new Error('meta_lead_receipt_unavailable'); }
  }
  // Preserve successful receipts/jobs, but require redelivery for every Page
  // that was not accepted. Existing per-lead dedupe handles accepted repeats.
  if (failure) throw failure;
  return { queued };
}

async function mappedAssets(models, type, ids, transaction = null) {
  return models.ClinicMetaAsset.findAll({ where: { isActive: true, assetType: type,
    metaAssetId: { [Op.in]: ids } }, attributes: MAPPING_FIELDS, ...query(transaction) });
}
async function activeAssets(models, type, ids, transaction = null) {
  const rows = await mappedAssets(models, type, ids, transaction);
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

async function resolveMetaLeadClinic({ models, event, identity, pageAssetId, connectionId, accountAssetId, recipientClinicId = null, authority, transaction = null }) {
  // The legacy lifecycle/CAPI caller may only reuse local routing here; it
  // receives no provider credential or newly enabled transport. Native inbound
  // reception always supplies the live paired broker authority.
  const current = authority ? await authority.assert({ transaction }) : null;
  const load = current ? mappedAssets : activeAssets;
  const pages = await load(models, 'facebook_page', [event.page_id], transaction);
  const page = pages.find(row => Number(row.id) === Number(pageAssetId) && Number(row.metaConnectionId) === Number(connectionId));
  if (!page) fail('meta_lead_page_access_required');
  if (current && (current.page.mappingId !== Number(pageAssetId) || current.page.id !== event.page_id
    || current.page.connectionId !== Number(connectionId))) fail('meta_lead_page_access_required');
  if (!current) {
    const connection = await models.MetaConnection.findByPk(connectionId, { attributes: ['id', 'expiresAt'], ...query(transaction) });
    if (!connection || (connection.expiresAt && +new Date(connection.expiresAt) <= Date.now())) fail('meta_lead_page_access_required');
  }
  let candidates = [];
  if (identity) {
    let accounts = await load(models, 'ad_account', [identity.account_id, `act_${identity.account_id}`], transaction);
    if (current) accounts = accounts.filter(row => Number(row.id) === Number(accountAssetId)
      && Number(row.metaConnectionId) === current.account.connectionId && current.account.mappingId === Number(accountAssetId)
      && current.account.id === identity.account_id);
    if (!accounts.length) fail('meta_lead_account_access_required');
    const decisions = await models.ExternalCampaignAssignment.findAll({ where: { provider: 'meta_ads',
      customer_id: { [Op.in]: [identity.account_id, `act_${identity.account_id}`] }, campaign_id: identity.campaign_id }, ...query(transaction) });
    if (decisions.length) {
      if (decisions.length !== 1 || decisions[0].status !== 'active' || !decisions[0].clinica_id) fail('meta_lead_clinic_assignment_required');
      candidates = [Number(decisions[0].clinica_id)];
    } else {
      // A group mapping's representative clinicaId is not a routing decision.
      if (current && recipientClinicId !== null) candidates = [recipientClinicId];
      else {
        if (accounts.some(row => row.assignmentScope !== 'clinic')) fail('meta_lead_clinic_assignment_required');
        candidates = [...new Set(accounts.map(row => Number(row.clinicaId)))];
      }
    }
    if (candidates.length !== 1) fail('meta_lead_clinic_assignment_required');
    if (recipientClinicId !== null && candidates[0] !== recipientClinicId) fail('meta_lead_clinic_scope_mismatch');
    const clinic = await models.Clinica.findByPk(candidates[0], query(transaction));
    if (!clinic || ![true, 1, '1'].includes(clinic.estado_clinica) || !covers(page, clinic)
      || !accounts.some(row => covers(row, clinic)) || current && !current.page.clinicIds.includes(Number(clinic.id_clinica))) fail('meta_lead_clinic_scope_mismatch');
    const settings = await models.CampaignWorkspaceSetting.findAll({ where: { [Op.or]: [
      { scope_type: 'clinic', scope_id: clinic.id_clinica },
      ...(clinic.grupoClinicaId ? [{ scope_type: 'group', scope_id: clinic.grupoClinicaId }] : []),
    ] }, ...query(transaction) });
    const setting = settings.find(row => row.scope_type === 'clinic') || settings.find(row => row.scope_type === 'group');
    if (!campaignIncluded({ provider: 'meta_ads', ...identity }, setting)) fail('meta_lead_campaign_not_selected');
    return clinic;
  }
  if (recipientClinicId !== null && (!current || !Number.isSafeInteger(recipientClinicId) || recipientClinicId < 1
    || !current.page.clinicIds.includes(recipientClinicId))) fail('meta_lead_clinic_scope_mismatch');
  if (recipientClinicId === null && (pages.some(row => row.assignmentScope !== 'clinic')
    || new Set(pages.map(row => Number(row.clinicaId))).size !== 1)) fail('meta_lead_clinic_assignment_required');
  const clinic = await models.Clinica.findByPk(recipientClinicId || page.clinicaId, query(transaction));
  if (!clinic || ![true, 1, '1'].includes(clinic.estado_clinica) || !covers(page, clinic)) fail('meta_lead_clinic_scope_mismatch');
  return clinic;
}

async function retrieveMetaLead({ models, event, reader, receiptRef, pageAssetId, accountAssetId, responseVersion = 2 }) {
  if (!UUID.test(receiptRef || '')) fail('meta_lead_invalid_notification');
  if (![1, 2].includes(responseVersion)) fail('meta_lead_form_response_invalid');
  const pair = await reader.preparePair(pageAssetId, accountAssetId);
  const data = await reader.read(pair, 'receiptRead', { receiptRef, ...(responseVersion === 2 ? { responseVersion: 2 } : {}) });
  if (!sameEvent(event, data.event) || graphId(data.lead.id) !== event.lead_id
    || graphId(data.lead.form_id) !== event.form_id || event.ad_id && data.lead.ad_id !== event.ad_id
    || data.identity && (data.identity.ad_id !== data.lead.ad_id || data.lead.campaign_id !== data.identity.campaign_id)) fail('meta_lead_identity_mismatch');
  const formResponse = responseVersion === 2
    ? require('./metaLeadFormResponse.service').validatedResponse(data.form_response, event.form_id) : null;
  const current = await reader.assertPair(pair);
  const authority = { assert: options => reader.assertPair(pair, options) };
  const details = { identity: data.identity, pageAssetId: Number(pageAssetId), accountAssetId: Number(accountAssetId),
    connectionId: current.page.connectionId, recipientClinicId: data.recipientClinicId, authority };
  const clinic = await resolveMetaLeadClinic({ models, event, ...details });
  return { lead: data.lead, clinic, responseVersion, formResponse, ...details };
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

async function persistMetaLead({ models, event, retrieved, now = new Date(), recoveryProof = null, publishCreated = require('./leadCreatedRealtime.service').publishLeadCreated }) {
  const contact = contactFields(retrieved.lead);
  const result = await models.sequelize.transaction(async transaction => {
    const clinic = await resolveMetaLeadClinic({ models, event, ...retrieved, transaction });
    if (Number(clinic.id_clinica) !== Number(retrieved.clinic.id_clinica)) fail('meta_lead_clinic_scope_mismatch');
    const historicalRecovery = recoveryProof === null ? null
      : require('../lib/metaLeadHistoricalRecovery').forPersistence(recoveryProof, event, Number(clinic.id_clinica), retrieved.lead.created_time);
    const existing = await models.LeadIntake.findOne({ where: { external_source: 'meta_leadgen', external_id: event.lead_id },
      transaction, lock: transaction.LOCK.UPDATE });
    if (existing) {
      if (Number(existing.clinica_id) !== Number(clinic.id_clinica)) fail('meta_lead_existing_scope_mismatch');
      if (!existing.archived_at && retrieved.responseVersion === 2) await require('./metaLeadFormResponse.service').storeMetaLeadFormResponse({
        models, event, lead: existing, clinic, formResponse: retrieved.formResponse,
        providerCreatedAt: retrieved.lead.created_time, transaction,
      });
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
      ...(historicalRecovery ? { created_at: new Date(historicalRecovery.provider_created_at) } : {}),
    }, { transaction });
    // The audit is mandatory and commits with the lead. No custom form answers are copied into reporting metadata.
    await models.LeadAttributionAudit.create({ lead_intake_id: lead.id,
      raw_payload: { provider: 'meta_leadgen', lead_id: event.lead_id, form_id: event.form_id,
        provider_created_at: retrieved.lead.created_time || null },
      attribution_steps: { meta_page_id: event.page_id, meta_native_received_at: now.toISOString(),
        advertising_identity: identity, ...(historicalRecovery ? { meta_historical_recovery: historicalRecovery } : {}) },
    }, { transaction });
    if (retrieved.responseVersion === 2) await require('./metaLeadFormResponse.service').storeMetaLeadFormResponse({
      models, event, lead, clinic, formResponse: retrieved.formResponse,
      providerCreatedAt: retrieved.lead.created_time, transaction,
    });
    return { lead, duplicate: false };
  });
  publishCreated(result);
  return result;
}

async function runMetaLeadReceptionJob(payload, job = null, overrides = {}) {
  const models = overrides.models || require('../../models');
  const reader = overrides.reader || require('./metaMarketingLeadReader.service').forModels(models);
  const notify = overrides.notify || require('./leadAutoReply.service').enqueueForLead;
  const event = { lead_id: graphId(payload.lead_id), page_id: graphId(payload.page_id),
    form_id: graphId(payload.form_id), ad_id: graphId(payload.ad_id) };
  if (!event.lead_id || !event.page_id || !event.form_id || !UUID.test(payload.receipt_ref || '')
    || !Number.isSafeInteger(payload.page_asset_id) || payload.page_asset_id < 1
    || !Number.isSafeInteger(payload.account_asset_id) || payload.account_asset_id < 1) return { status: 'failed', retryable: false, error_message: 'meta_lead_invalid_notification' };
  try {
    const retrieved = await retrieveMetaLead({ models, event, reader, receiptRef: payload.receipt_ref,
      pageAssetId: payload.page_asset_id, accountAssetId: payload.account_asset_id });
    const result = await persistMetaLead({ models, event, retrieved });
    if (!result.lead.archived_at) await notify({ lead: result.lead, eventKind: 'write',
      eventAt: result.lead.created_at || result.lead.createdAt || new Date() });
    return { status: 'completed', lead_id: result.lead.id, duplicate: result.duplicate };
  } catch (error) {
    // Scope preparation checks persisted credential health before any Graph I/O.
    // Keep signed receipts pending until renewed access is confirmed; polling
    // local metadata must not exhaust the provider-work retry budget.
    if (['meta_credential_renewal_required', 'credential_revoked'].includes(error.code)) {
      return require('../lib/metaLeadBrokerCooldown').createCredentialRenewalWait(JOB_TYPE, Date.now(), error.code);
    }
    const waiting = require('./metaMarketingLeadReader.service').cooldownWait(error, JOB_TYPE);
    if (waiting) return waiting;
    const code = error.code?.startsWith('meta_lead_') ? error.code : 'meta_lead_reception_failed';
    return { status: 'failed', retryable: !['meta_lead_receipt_review_required', 'meta_lead_form_conflict',
      'meta_lead_form_identity_mismatch', 'meta_lead_form_response_invalid'].includes(error.code)
      && !['scope_denied', 'asset_revoked', 'credential_revoked', 'operation_denied', 'meta_leads_disabled'].includes(error.code), error_message: code };
  }
}

module.exports = { JOB_TYPE, webhookEvents, receptionRuntimeNamespace, enqueueMetaLeadNotifications, enqueueAcceptedMetaLeadJob, brokerPairsForPage, mappedAssets, resolveMetaLeadClinic,
  retrieveMetaLead, contactFields, persistMetaLead, runMetaLeadReceptionJob };
