'use strict';

const crypto = require('node:crypto');
const { Op } = require('sequelize');
const { CRM_MILESTONE_SOURCE, resolveWorkspaceSignalPolicy } = require('./campaignWorkspaceSignalPolicy.service');
const { resolveNativeMetaLeadIdentity } = require('./leadAdvertisingIdentity.service');
const { resolveMetaLeadClinic } = require('./metaLeadReception.service');
const { resolveMetaSignalContext } = require('./metaWorkspaceSignalContext.service');
const { resolveEffectiveTrackingConfig } = require('./effectiveMarketingAssets.service');
const { resolveLeadIntakeConfig } = require('./googleLeadLifecycleConversion.service');
const { normalizeGoogleConsent } = require('./googleAdsConversionUpload.service');
const { sendWorkspaceMetaSignal } = require('./metaWorkspaceSignalDelivery.service');

const JOB_TYPE = 'campaign_meta_crm_signal';
const ORIGIN = 'campaign_crm_milestone';
const MAX_AGE_MS = 7 * 86400000;
const positiveId = value => ['string', 'number'].includes(typeof value) && /^[1-9][0-9]*$/.test(String(value))
  && Number.isSafeInteger(Number(value)) ? Number(value) : null;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const enabled = dependencies => (dependencies.env || process.env).CAMPAIGN_WORKSPACE_ACTIVATION_ENABLED === 'true';
const reason = error => /^(workspace_|meta_lead_|meta_crm_)[a-z0-9_]{1,90}$/.test(error?.code || '')
  ? error.code : 'meta_crm_unavailable';

function milestone({ leadId, clinicId, eventName, eventId, occurredAt }, now) {
  const time = +new Date(occurredAt);
  if (!positiveId(leadId) || !positiveId(clinicId) || !Number.isFinite(time)
    || time > +now + 300000 || time < +now - MAX_AGE_MS) fail('meta_crm_milestone_invalid');
  let appointmentId = null;
  if (eventName === 'qualified_lead') {
    if (eventId !== `lead-${leadId}-qualified`) fail('meta_crm_milestone_invalid');
  } else if (eventName === 'schedule') {
    const match = /^appointment-([1-9][0-9]*)$/.exec(eventId || '');
    appointmentId = positiveId(match?.[1]);
    if (!appointmentId) fail('meta_crm_milestone_invalid');
  } else fail('meta_crm_event_not_supported');
  return { lead_id: Number(leadId), clinic_id: Number(clinicId), event_name: eventName,
    event_id: eventId, appointment_id: appointmentId, occurred_at: new Date(Math.floor(time / 1000) * 1000).toISOString() };
}

async function resolveLifecycleSignal(input, dependencies = {}) {
  const models = dependencies.models || require('../../models');
  const transaction = dependencies.transaction || null;
  const query = transaction ? { transaction } : {};
  const now = (dependencies.now || (() => new Date()))();
  const lead = await models.LeadIntake.findByPk(input.lead_id, { raw: true, attributes: ['id', 'clinica_id',
    'source', 'external_source', 'external_id', 'consentimiento_canal', 'status_lead', 'archived_at'], ...query });
  if (!lead || Number(lead.clinica_id) !== input.clinic_id || lead.archived_at || lead.status_lead === 'descartado') fail('meta_crm_lead_unavailable');
  const consent = lead.consentimiento_canal;
  if (!consent || typeof consent !== 'object' || Array.isArray(consent)
    || normalizeGoogleConsent(consent) !== 'GRANTED') fail('meta_crm_consent_required');
  const identity = await resolveNativeMetaLeadIdentity({ models, lead, transaction });
  if (!identity) fail('meta_crm_verified_native_lead_required');
  const appointments = await models.CitaPaciente.findAll({ where: { lead_intake_id: input.lead_id, clinica_id: input.clinic_id,
    ...(input.appointment_id ? { id_cita: input.appointment_id } : {}),
    [Op.or]: [{ es_provisional: false }, { es_provisional: null }],
    estado: { [Op.in]: ['pendiente', 'info_enviada', 'info_confirmada', 'recordatorio_enviado',
      'recordatorio_confirmado', 'cambio_solicitado', 'reprogramada', 'completada'] } },
    attributes: ['id_cita'], limit: 1, raw: true, ...query });
  if (input.appointment_id ? !appointments.length : lead.status_lead !== 'cualificado' && !appointments.length) fail('meta_crm_milestone_not_current');
  const clinic = await models.Clinica.findByPk(input.clinic_id, { raw: true, ...query });
  if (!clinic || ![true, 1, '1'].includes(clinic.estado_clinica)) fail('meta_crm_clinic_unavailable');

  // Reuse native reception's current campaign/page/account routing, not a historical clinic label.
  const pages = await models.ClinicMetaAsset.findAll({ where: { assetType: 'facebook_page', isActive: true,
    metaAssetId: identity.page_id, [Op.or]: [{ assignmentScope: 'clinic', clinicaId: input.clinic_id },
      ...(clinic.grupoClinicaId ? [{ assignmentScope: 'group', grupoClinicaId: clinic.grupoClinicaId }] : [])] },
    attributes: ['id', 'metaConnectionId'], raw: true, ...query });
  let routed = false;
  for (const page of pages) {
    try {
      const current = await resolveMetaLeadClinic({ models, identity, event: { page_id: identity.page_id },
        pageAssetId: page.id, connectionId: page.metaConnectionId, transaction });
      if (Number(current.id_clinica) === input.clinic_id) routed = true;
    } catch (error) { if (!/^meta_lead_/.test(error.code || '')) throw error; }
  }
  if (!routed) fail('meta_crm_campaign_scope_changed');

  const configDependencies = { IntakeConfig: models.IntakeConfig, Clinica: models.Clinica, transaction };
  const { config: webPolicyRecord } = await resolveLeadIntakeConfig({ lead: { clinica_id: input.clinic_id,
    grupo_clinica_id: clinic.grupoClinicaId }, dependencies: configDependencies });
  if (!webPolicyRecord) fail('meta_crm_configuration_required');
  const clinicRecord = await models.IntakeConfig.findOne({ where: { assignment_scope: 'clinic', clinic_id: input.clinic_id }, raw: true, ...query });
  const groupRecord = clinic.grupoClinicaId ? await models.IntakeConfig.findOne({ where: {
    assignment_scope: 'group', group_id: clinic.grupoClinicaId }, raw: true, ...query }) : null;
  const tracking = resolveEffectiveTrackingConfig({ assignment_scope: webPolicyRecord.assignment_scope,
    clinic_id: input.clinic_id, group_id: clinic.grupoClinicaId }, { clinicRecord, groupRecord }).meta_ads;
  const signalPolicyRecord = tracking.config_source === 'group' ? groupRecord : clinicRecord;
  const signal = { eventName: input.event_name, eventId: input.event_id, eventTime: +new Date(input.occurred_at) / 1000,
    clinicId: input.clinic_id, campaignId: identity.campaign_id, adAccountId: identity.account_id,
    pixelId: tracking.pixel_id, webPolicyRecord, signalPolicyRecord, advertisingConsent: true,
    verifiedNativeLeadId: identity.native_lead_id, crmEventSource: CRM_MILESTONE_SOURCE };
  const context = await resolveMetaSignalContext({ models, input: signal, now, transaction });
  const policy = await resolveWorkspaceSignalPolicy({ records: [context.webPolicyRecord, context.signalPolicyRecord],
    models, transaction, now, clinicId: input.clinic_id, destinationId: signal.pixelId, connectionId: context.connectionId || 0,
    provider: 'meta_ads', accountId: signal.adAccountId, campaignId: signal.campaignId, eventName: signal.eventName,
    crmEventSource: CRM_MILESTONE_SOURCE, loadSetting: id => models.CampaignWorkspaceSetting.findByPk(id, { raw: true, ...query }) });
  if (!policy.applicable || !policy.allowed) fail(policy.applicable ? policy.reason : 'meta_crm_workspace_required');
  return { signal, authorizationKey: hash([identity, context.destinationKey, policy.policyRefs]) };
}

async function enqueueMetaLeadLifecycleSignal(input, dependencies = {}) {
  if (!enabled(dependencies)) return { queued: false, reason: 'workspace_activation_disabled' };
  if (input.crmEventSource !== CRM_MILESTONE_SOURCE) return { queued: false, reason: 'workspace_crm_milestone_required' };
  const now = (dependencies.now || (() => new Date()))();
  try {
    const payload = milestone(input, now);
    const resolved = await (dependencies.resolve || resolveLifecycleSignal)(payload, dependencies);
    const enqueue = dependencies.enqueue || require('./jobRequests.service').enqueueUniqueJobRequest;
    const result = await enqueue({ type: JOB_TYPE, origin: ORIGIN, priority: 'normal', maxAttempts: 8,
      payload: { schema_version: 1, ...payload, authorization_key: resolved.authorizationKey },
      dedupeScope: `meta_crm:${hash([payload.clinic_id, payload.lead_id, payload.event_id])}` },
    dependencies.transaction ? { transaction: dependencies.transaction } : {});
    return { queued: true, created: result.created, jobId: result.job.id };
  } catch (error) {
    if (dependencies.transaction && reason(error) === 'meta_crm_unavailable') {
      fail('meta_crm_outbox_persistence_failed');
    }
    return { queued: false, reason: reason(error) };
  }
}

async function runMetaLeadLifecycleSignalJob(payload, job, dependencies = {}) {
  const failed = (code, retryable = false) => ({ status: 'failed', retryable, error_message: code });
  if (!enabled(dependencies)) return failed('workspace_activation_disabled');
  if (job?.type !== JOB_TYPE || job?.origin !== ORIGIN || job?.requested_by != null) return failed('meta_crm_internal_job_required');
  const now = (dependencies.now || (() => new Date()))();
  try {
    if (payload?.schema_version !== 1 || !/^[a-f0-9]{64}$/.test(payload.authorization_key || '')) fail('meta_crm_job_invalid');
    const input = milestone({ leadId: payload.lead_id, clinicId: payload.clinic_id, eventName: payload.event_name,
      eventId: payload.event_id, occurredAt: payload.occurred_at }, now);
    if (input.appointment_id !== payload.appointment_id || input.occurred_at !== payload.occurred_at) fail('meta_crm_job_invalid');
    const resolve = dependencies.resolve || resolveLifecycleSignal;
    const resolved = await resolve(input, dependencies);
    if (resolved.authorizationKey !== payload.authorization_key) fail('meta_crm_authorization_changed');
    const send = dependencies.send || sendWorkspaceMetaSignal;
    const delivery = await send(resolved.signal, { models: dependencies.models, now: dependencies.now,
      validateSource: async () => {
        if (!enabled(dependencies)) fail('workspace_activation_disabled');
        let fresh;
        try { fresh = await resolve(input, dependencies); }
        catch (error) {
          if (reason(error) !== 'meta_crm_unavailable') fail('workspace_crm_source_changed');
          throw error;
        }
        if (fresh.authorizationKey !== payload.authorization_key) fail('workspace_crm_source_changed');
      } });
    if (delivery.sent || delivery.reason === 'meta_event_already_received') return { status: 'completed',
      delivery_id: delivery.deliveryId, delivery_status: delivery.status || 'already_received' };
    const retryable = ['meta_event_in_progress', 'meta_rate_limited', 'meta_delivery_result_conflict',
      'meta_response_unconfirmed'].includes(delivery.reason)
      || delivery.reason === 'meta_delivery_failed' && delivery.status !== 'failed';
    return failed(delivery.reason || 'meta_crm_delivery_unconfirmed', retryable);
  } catch (error) {
    const code = reason(error);
    return failed(code, code === 'meta_crm_unavailable');
  }
}

module.exports = { JOB_TYPE, ORIGIN, MAX_AGE_MS, milestone, resolveLifecycleSignal,
  enqueueMetaLeadLifecycleSignal, runMetaLeadLifecycleSignalJob };
