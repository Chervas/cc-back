'use strict';

const crypto = require('node:crypto');
const { CRM_MILESTONE_SOURCE } = require('./campaignWorkspaceSignalPolicy.service');
const { nativeLifecycleContext, maybeUploadNativeGoogleLifecycleConversion } = require('./campaignWorkspaceGoogleNative.service');
const { normalizeGoogleConsent } = require('./googleAdsConversionUpload.service');

const JOB_TYPE = 'campaign_google_crm_signal';
const ORIGIN = 'campaign_crm_milestone';
const MAX_AGE_MS = 7 * 86400000;
const enabled = dependencies => (dependencies.env || process.env).CAMPAIGN_WORKSPACE_ACTIVATION_ENABLED === 'true';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const safeReason = error => /^(workspace_|google_lead_|google_crm_)[a-z0-9_]{1,90}$/.test(error?.code || '')
  ? error.code : 'google_crm_unavailable';
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const DELIVERY_REASONS = new Set(['no_permitted_identifiers', 'consent_not_granted', 'google_ads_disabled',
  'no_configured_destination', 'unsupported_conversion_event', 'duplicate_upload_in_progress', 'scoped_connection_unavailable']);
const positiveId = value => ['string', 'number'].includes(typeof value) && /^[1-9][0-9]*$/.test(String(value))
  && Number.isSafeInteger(Number(value));

function milestone(input, now) {
  const time = +new Date(input.occurredAt);
  if (!positiveId(input.leadId) || !positiveId(input.clinicId) || !Number.isFinite(time)
    || time > +now + 300000 || time < +now - MAX_AGE_MS) fail('google_crm_milestone_invalid');
  if (input.eventName === 'qualified_lead') {
    if (input.eventId !== `lead-${input.leadId}-qualified`) fail('google_crm_milestone_invalid');
  } else if (input.eventName === 'schedule') {
    if (!positiveId(/^appointment-([1-9][0-9]*)$/.exec(input.eventId || '')?.[1])) fail('google_crm_milestone_invalid');
  } else fail('google_crm_event_not_supported');
  return { leadId: Number(input.leadId), clinicId: Number(input.clinicId), eventName: input.eventName,
    eventId: input.eventId, occurredAt: new Date(Math.floor(time / 1000) * 1000).toISOString() };
}

async function enqueueGoogleLeadLifecycleSignal(input, dependencies = {}) {
  if (!enabled(dependencies)) return { queued: false, reason: 'workspace_activation_disabled' };
  if (input.crmEventSource !== CRM_MILESTONE_SOURCE) return { queued: false, reason: 'workspace_crm_milestone_required' };
  try {
    const event = milestone(input, (dependencies.now || (() => new Date()))());
    const context = await (dependencies.resolve || nativeLifecycleContext)(event, dependencies);
    if (normalizeGoogleConsent(context.consent) !== 'GRANTED') return { queued: false, reason: 'google_crm_consent_required' };
    const enqueue = dependencies.enqueue || require('./jobRequests.service').enqueueUniqueJobRequest;
    const result = await enqueue({ type: JOB_TYPE, origin: ORIGIN, priority: 'normal', maxAttempts: 8,
      payload: { schema_version: 1, ...event, source_fingerprint: context.sourceFingerprint },
      dedupeScope: `google_crm:${hash([event.clinicId, event.leadId, event.eventId])}` },
    dependencies.transaction ? { transaction: dependencies.transaction } : {});
    return { queued: true, created: result.created, jobId: result.job.id };
  } catch (error) {
    if (dependencies.transaction && safeReason(error) === 'google_crm_unavailable') fail('google_crm_outbox_persistence_failed');
    return { queued: false, reason: safeReason(error) };
  }
}

async function runGoogleLeadLifecycleSignalJob(payload, job, dependencies = {}) {
  const failed = (code, retryable = false) => ({ status: 'failed', retryable, error_message: code });
  if (!enabled(dependencies)) return failed('workspace_activation_disabled');
  if (job?.type !== JOB_TYPE || job?.origin !== ORIGIN || job?.requested_by != null) return failed('google_crm_internal_job_required');
  try {
    if (payload?.schema_version !== 1 || !/^[a-f0-9]{64}$/.test(payload.source_fingerprint || '')) fail('google_crm_job_invalid');
    const input = milestone(payload, (dependencies.now || (() => new Date()))());
    if (input.occurredAt !== payload.occurredAt) fail('google_crm_job_invalid');
    const context = await (dependencies.resolve || nativeLifecycleContext)(input, dependencies);
    if (context.sourceFingerprint !== payload.source_fingerprint) fail('google_crm_source_changed');
    if (normalizeGoogleConsent(context.consent) !== 'GRANTED') fail('google_crm_consent_required');
    const delivery = await (dependencies.send || maybeUploadNativeGoogleLifecycleConversion)({ ...input,
      expectedSourceFingerprint: payload.source_fingerprint, crmEventSource: CRM_MILESTONE_SOURCE }, dependencies);
    // Acceptance hands over to the existing Data Manager diagnostics job, not a new upload.
    if ((delivery.accepted && delivery.audit_id) || ['duplicate_already_succeeded', 'duplicate_already_accepted'].includes(delivery.reason)) {
      return { status: 'completed', audit_id: delivery.audit_id, delivery_status: delivery.reason };
    }
    const retryable = ['duplicate_upload_in_progress', 'scoped_connection_unavailable'].includes(delivery.reason);
    const code = DELIVERY_REASONS.has(delivery.reason) || safeReason({ code: delivery.reason }) !== 'google_crm_unavailable'
      ? delivery.reason : 'google_crm_delivery_not_sent';
    return failed(code, retryable);
  } catch (error) {
    const code = safeReason(error);
    const status = Number(error.response?.status || error.status);
    const providerFailure = error.isGoogleAdsProviderError === true;
    const retryable = code === 'google_crm_unavailable'
      && (!providerFailure || !status || status === 408 || status === 429 || status >= 500);
    return failed(providerFailure ? 'google_crm_provider_error' : code, retryable);
  }
}

module.exports = { JOB_TYPE, ORIGIN, MAX_AGE_MS, milestone, enqueueGoogleLeadLifecycleSignal, runGoogleLeadLifecycleSignalJob };
