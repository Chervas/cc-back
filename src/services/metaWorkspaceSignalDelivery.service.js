'use strict';

const crypto = require('node:crypto');
const { resolveWorkspaceSignalPolicy, CRM_MILESTONE_SOURCE } = require('./campaignWorkspaceSignalPolicy.service');

const LEASE_MS = 90000;
const RETRY_WINDOW_MS = 24 * 3600000;
const eventNames = { lead: 'Lead', contact: 'Contact', qualifiedlead: 'QualifiedLead', schedule: 'Schedule' };
const id = value => typeof value === 'string' && /^[0-9]{1,64}$/.test(value) ? value : null;
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };

function minimalEvent(input, now = new Date()) {
  const eventName = eventNames[String(input.eventName || '').replace(/[_\s-]/g, '').toLowerCase()];
  if (!eventName || !Number.isSafeInteger(input.eventTime) || input.eventTime * 1000 > +now + 300000
    || input.eventTime * 1000 < +now - 7 * 86400000 || typeof input.eventId !== 'string'
    || !/^[A-Za-z0-9:_-]{1,191}$/.test(input.eventId)) fail('workspace_meta_event_invalid');
  const crm = ['QualifiedLead', 'Schedule'].includes(eventName);
  if (crm && input.crmEventSource !== CRM_MILESTONE_SOURCE) fail('workspace_crm_milestone_required');
  const source = input.userData || {};
  const userData = {};
  for (const key of ['em', 'ph', 'external_id']) {
    const values = source[key];
    if (Array.isArray(values) && values.length && values.every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) userData[key] = [...new Set(values)].slice(0, 2);
  }
  // Native lead IDs must be supplied by a server-verified receiver, never copied from public form fields.
  if (crm && input.verifiedNativeLeadId && id(input.verifiedNativeLeadId)) {
    for (const key of Object.keys(userData)) delete userData[key];
    userData.lead_id = input.verifiedNativeLeadId;
  }
  if (!Object.keys(userData).length) fail('workspace_meta_matching_data_required');
  const event = { event_name: eventName, event_time: input.eventTime, event_id: input.eventId,
    action_source: crm ? 'system_generated' : 'website', user_data: userData };
  if (crm) event.custom_data = { event_source: 'crm', lead_event_source: 'ClinicaClick' };
  else {
    let url;
    try { url = new URL(input.eventSourceUrl); } catch { fail('workspace_meta_web_context_required'); }
    if (url.protocol !== 'https:' || url.username || url.password || typeof source.client_user_agent !== 'string'
      || !source.client_user_agent.trim() || source.client_user_agent.length > 1024) fail('workspace_meta_web_context_required');
    // No page path, query, treatment, clinic name, amount or arbitrary custom fields leave the new workspace.
    event.event_source_url = `${url.origin}/`;
    userData.client_user_agent = source.client_user_agent;
    for (const key of ['fbp', 'fbc']) if (typeof source[key] === 'string' && /^fb\.\d\.\d{10,16}\.[A-Za-z0-9_-]{1,256}$/.test(source[key])) userData[key] = source[key];
  }
  return event;
}

function receipt(response, datasetId) {
  const body = response?.data;
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.error
    || body.id !== undefined && body.id !== datasetId || !Number.isSafeInteger(body.events_received) || body.events_received < 0 || body.events_received > 1
    || body.messages !== undefined && (!Array.isArray(body.messages) || body.messages.some(message => typeof message !== 'string'))) {
    return { status: 'unknown', reason: 'meta_response_unconfirmed', events_received: null, warning_count: null, trace_id: null };
  }
  const count = body.events_received; const warnings = body.messages?.length || 0;
  return { status: count === 1 ? warnings ? 'warning' : 'accepted' : count === 0 ? 'failed' : 'unknown',
    reason: count !== 1 ? 'meta_event_not_confirmed' : warnings ? 'meta_event_warnings' : null,
    events_received: count, warning_count: warnings,
    trace_id: typeof body.fbtrace_id === 'string' && /^[A-Za-z0-9_-]{1,191}$/.test(body.fbtrace_id) ? body.fbtrace_id : null };
}

function failure(error) {
  const code = Number(error?.response?.data?.error?.code);
  const status = error?.response?.status;
  return { status: Number.isInteger(status) && status >= 400 && status < 500 ? 'failed' : 'unknown',
    reason: status === 429 || /^META_RATE_LIMIT/.test(error?.code || '') || [4, 17, 613].includes(code) ? 'meta_rate_limited'
      : [10, 190, 200].includes(code) || [401, 403].includes(status) ? 'meta_permissions_required' : 'meta_delivery_failed',
    events_received: null, warning_count: null, trace_id: null };
}

function references(authorization) {
  const refs = authorization.policyRefs;
  if (!Array.isArray(refs) || !refs.length || refs.some(ref => typeof ref.setting_id !== 'string' || !ref.setting_id
    || !['clinic', 'group'].includes(ref.scope_type) || !Number.isSafeInteger(ref.scope_id) || ref.scope_id < 1
    || !Number.isSafeInteger(ref.version) || ref.version < 1)) fail('workspace_meta_policy_required');
  return refs.map(ref => ({ setting_id: ref.setting_id, scope_type: ref.scope_type, scope_id: ref.scope_id, version: ref.version }))
    .sort((a, b) => a.setting_id.localeCompare(b.setting_id));
}

async function sendWorkspaceMetaSignal(input, dependencies = {}) {
  const models = dependencies.models || require('../../models');
  const now = dependencies.now || (() => new Date());
  const policy = dependencies.policy || resolveWorkspaceSignalPolicy;
  const context = dependencies.context || require('./metaWorkspaceSignalContext.service').resolveMetaSignalContext;
  const check = async () => {
    await dependencies.validateSource?.(input);
    const current = await context({ models, input, now: now() });
    const authorization = current.workspaceAuthorization || await policy({ records: [current.webPolicyRecord, current.signalPolicyRecord], provider: 'meta_ads',
      models, now: now(), clinicId: input.clinicId, destinationId: input.pixelId, connectionId: current.connectionId || 0,
      loadSetting: settingId => models.CampaignWorkspaceSetting.findByPk(settingId, { raw: true }),
      accountId: input.adAccountId, campaignId: input.campaignId, eventName: input.eventName, crmEventSource: input.crmEventSource });
    return { ...authorization, context: current };
  };
  if (input.advertisingConsent !== true) return { sent: false, reason: 'consent_not_granted' };
  let authorization;
  try { authorization = await check(); }
  catch (error) {
    if (/^workspace_/.test(error.code || '')) return { sent: false, reason: error.code };
    throw error;
  }
  if (!authorization.applicable || !authorization.allowed) return { sent: false, reason: authorization.reason };
  const accountId = id(String(input.adAccountId || '').replace(/^act_/, ''));
  const datasetId = id(input.pixelId);
  if (!accountId || !datasetId || !authorization.context.accessToken || !Number.isSafeInteger(input.clinicId) || input.clinicId < 1
    || input.campaignId && !id(input.campaignId)) return { sent: false, reason: 'workspace_meta_destination_required' };
  let event; let refs;
  try { event = minimalEvent(input, now()); refs = references(authorization); }
  catch (error) { return { sent: false, reason: error.code }; }
  const eventKey = hash(`${event.event_name}:${event.event_id}`);
  const dedupeKey = hash(JSON.stringify([input.clinicId, accountId, datasetId, eventKey]));
  const leaseId = crypto.randomUUID();
  let row;
  try {
    row = await models.sequelize.transaction(async transaction => {
      const existing = await models.MetaSignalDelivery.findOne({ where: { dedupe_key: dedupeKey }, transaction, lock: transaction.LOCK.UPDATE });
      if (existing && (existing.campaign_id !== (input.campaignId || null)
        || existing.destination_key !== authorization.context.destinationKey
        || +new Date(existing.occurred_at) !== event.event_time * 1000)) return { conflict: true };
      if (existing && (['accepted', 'warning'].includes(existing.status)
        || existing.status === 'pending' && +new Date(existing.attempted_at) + LEASE_MS > +now())) return { duplicate: true, value: existing };
      // An ambiguous receipt is not permission to replay indefinitely after a long outage or a manual retry.
      if (existing && (!existing.created_at || !Number.isFinite(+new Date(existing.created_at))
        || +new Date(existing.created_at) + RETRY_WINDOW_MS <= +now())) return { expired: true, value: existing };
      const values = { status: 'pending', lease_id: leaseId, attempted_at: now(), completed_at: null,
        attempt_count: Number(existing?.attempt_count || 0) + 1, policy_version: authorization.version,
        policy_refs: input.webIdentity ? { schema_version: 2, source: 'web', intake_config_id: input.webIdentity.intake_config_id,
          references: refs } : refs,
        reason: null, events_received: null, warning_count: null, trace_id: null };
      const value = existing ? await existing.update(values, { transaction }) : await models.MetaSignalDelivery.create({ ...values,
        id: crypto.randomUUID(), dedupe_key: dedupeKey, clinic_id: input.clinicId, account_id: accountId,
        campaign_id: input.campaignId || null, dataset_id: datasetId, event_name: event.event_name, event_key: eventKey,
        destination_key: authorization.context.destinationKey,
        occurred_at: new Date(event.event_time * 1000) }, { transaction });
      return { duplicate: false, value };
    });
  } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError') return { sent: false, reason: 'meta_event_in_progress' };
    throw error;
  }
  if (row.conflict) return { sent: false, reason: 'meta_event_identity_conflict' };
  if (row.expired) return { sent: false, reason: 'meta_delivery_retry_expired', deliveryId: row.value.id };
  if (row.duplicate) return { sent: false, reason: ['accepted', 'warning'].includes(row.value.status) ? 'meta_event_already_received' : 'meta_event_in_progress', deliveryId: row.value.id };
  let result;
  try {
    const fresh = await check();
    if (!fresh.applicable || !fresh.allowed || fresh.context.destinationKey !== authorization.context.destinationKey
      || JSON.stringify(references(fresh)) !== JSON.stringify(refs)) result = { status: 'skipped', reason: 'workspace_authorization_changed' };
    else result = receipt(await (dependencies.send || require('../lib/metaClient').metaSendConversion)(datasetId, { data: [event] }, {
      accessToken: fresh.context.accessToken, timeout: 8000, source: 'campaign_workspace', operation: 'crm_signal_delivery',
    }), datasetId);
  } catch (error) { result = /^workspace_/.test(error?.code || '')
    ? { status: 'skipped', reason: 'workspace_authorization_changed' } : failure(error); }
  const [updated] = await models.MetaSignalDelivery.update({ ...result, completed_at: now(), lease_id: null },
    { where: { id: row.value.id, lease_id: leaseId, status: 'pending' } });
  if (updated !== 1) return { sent: false, reason: 'meta_delivery_result_conflict', deliveryId: row.value.id };
  return { sent: ['accepted', 'warning'].includes(result.status), status: result.status, reason: result.reason,
    deliveryId: row.value.id, eventsReceived: result.events_received };
}

module.exports = { LEASE_MS, RETRY_WINDOW_MS, minimalEvent, receipt, failure, sendWorkspaceMetaSignal };
