'use strict';

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');
const { parseGoogleLead, receptionAccount, persistGoogleLead } = require('../../services/googleLeadReception.service');
const { resolveNativeGoogleLeadIdentity } = require('../../services/leadAdvertisingIdentity.service');
const { checkGooglePreparation } = require('../../services/campaignWorkspaceGooglePreparation.service');
const { buildClinicaclickManagedMapping } = require('../../services/googleAdsConversionPreparation.service');
const { loadSignalAuthorizationReview } = require('../../services/campaignWorkspaceSignalAuthorization.service');
const { activateWorkspaceMeasurement } = require('../../services/campaignWorkspaceActivation.service');
const { CRM_MILESTONE_SOURCE } = require('../../services/campaignWorkspaceSignalPolicy.service');
const { maybeUploadLeadLifecycleConversion } = require('../../services/googleLeadLifecycleConversion.service');
const { maybeUploadNativeGoogleLifecycleConversion } = require('../../services/campaignWorkspaceGoogleNative.service');
const { maybeUploadGoogleConversion } = require('../../services/googleAdsConversionUpload.service');
const { loadGoogleSignalEvidence } = require('../../services/campaignWorkspaceGoogleSignalEvidence.service');
const { maybeUploadQualifiedLeadStatusTransition, uploadScheduleForLinkedAppointment } = require('../../services/leadQualificationMilestone.service');
const { enqueueGoogleLeadLifecycleSignal, runGoogleLeadLifecycleSignalJob, JOB_TYPE, ORIGIN } = require('../../services/googleLeadLifecycleJob.service');

mock.method(require('../../../models').sequelize, 'query', async () => assert.fail('Native Google CRM tests must not access the real database'));

function harness({ group = false } = {}) {
  const accountId = '5992356722';
  const scope = { clinicIds: [5], groupId: group ? 28 : null };
  const owner = { scope_type: group ? 'group' : 'clinic', scope_id: group ? 28 : 5 };
  const state = { now: new Date('2026-09-11T01:00:00Z'), clinic: { id_clinica: 5, grupoClinicaId: 28, estado_clinica: 1 },
    setting: { id: 'native-setting', ...owner, version: 1, accounts: [{ provider: 'google_ads', account_id: accountId, include_future: true, campaign_ids: [] }],
      preferences: { mode: 'measurement', signals: { enabled: true, events: ['qualified_lead', 'schedule'] } } },
    connection: { id: 20, accessToken: 'private-token', refreshToken: 'private-refresh', googleUserId: 'private-principal',
      scopes: 'https://www.googleapis.com/auth/adwords https://www.googleapis.com/auth/datamanager', expiresAt: '2027-01-01' },
    assignments: [{ id: 30, scopeKey: `${owner.scope_type}:${owner.scope_id}`, googleConnectionId: 20, status: 'active', connectedAt: '2026-09-01' }],
    accounts: [{ id: 10, customerId: accountId, assignmentScope: owner.scope_type, clinicaId: group ? 999 : 5,
      grupoClinicaId: group ? 28 : null, googleConnectionId: 20, isActive: true }],
    decisions: group ? [{ status: 'active', clinica_id: 5 }] : [],
    records: [], leads: [], attributions: [], events: [], attempts: [], uploads: [], appointments: [], webWrites: 0,
    env: { CAMPAIGN_WORKSPACE_ACTIVATION_ENABLED: 'true' } };
  state.setting.update = async patch => Object.assign(state.setting, patch);
  const models = {
    sequelize: { transaction: async fn => fn({ LOCK: { UPDATE: 'UPDATE' } }) },
    Clinica: { findByPk: async () => state.clinic, findAll: async () => [state.clinic] },
    GrupoClinica: { findByPk: async () => ({ id_grupo: 28 }) },
    CampaignWorkspaceSetting: { findByPk: async () => state.setting, findOne: async () => state.setting,
      findAll: async () => [state.setting, ...(state.otherSettings || [])] },
    CampaignWorkspaceEvent: { create: async row => state.events.push(row) },
    ClinicGoogleAdsAccount: { findAll: async () => state.accounts.filter(row => row.isActive) },
    GoogleConnectionAssignment: { findAll: async () => state.assignments.filter(row => row.status === 'active') },
    GoogleConnection: { findByPk: async () => state.connection },
    ExternalCampaignAssignment: { findAll: async () => state.decisions },
    IntakeConfig: { findAll: async () => state.records, findOne: async () => null,
      create: async () => { state.webWrites++; assert.fail('Native signals must not create a website'); } },
    CampaignOptimizationPolicy: { findAll: async () => [] },
    LeadIntake: {
      findByPk: async id => { const row = state.leads.find(lead => lead.id === Number(id)); return row ? structuredClone(row) : null; },
      findOne: async ({ where }) => state.leads.find(row => row.external_id === where.external_id),
      create: async row => { const lead = { ...row, id: state.leads.length + 1 }; state.leads.push(lead); return lead; },
    },
    LeadAttributionAudit: {
      create: async row => state.attributions.push(row),
      findAll: async ({ where }) => state.attributions.filter(row => row.lead_intake_id === where.lead_intake_id)
        .map(row => ({ identity: row.attribution_steps.advertising_identity, native_lead_id: row.raw_payload.lead_id })),
    },
    CitaPaciente: { findAll: async ({ where }) => state.appointments.filter(row => row.lead_intake_id === where.lead_intake_id
      && row.clinica_id === where.clinica_id && (!where.id_cita || row.id_cita === where.id_cita)
      && where.estado[Op.in].includes(row.estado) && row.es_provisional !== true) },
    GoogleAdsConversionUploadAttempt: {
      findAll: async () => state.attempts,
      findOne: async ({ where }) => state.attempts.find(row => row.dedupeKey === where.dedupeKey),
      create: async row => { const result = { ...row, id: state.attempts.length + 1, attemptedAt: state.now,
        update: async patch => Object.assign(result, patch) }; state.attempts.push(result); state.onReserve?.(); return result; },
    },
  };
  const campaign = { id: `google_ads:${accountId}:200`, provider: 'google_ads', account_id: accountId,
    campaign_id: '200', clinicId: 5, assigned: true, destination: 'native' };
  const googleActions = ['qualified_lead', 'schedule'].map((event, i) => ({ id: String(101 + i),
    name: event === 'schedule' ? 'Schedule - ClinicaClick' : 'Qualified Lead - ClinicaClick',
    resource_name: `customers/${accountId}/conversionActions/${101 + i}`, type: 'UPLOAD_CLICKS', status: 'ENABLED',
    category: event === 'schedule' ? 'BOOK_APPOINTMENT' : 'QUALIFIED_LEAD', counting_type: 'MANY_PER_CLICK', primary_for_goal: false }));
  const dependencies = { models, env: state.env, now: () => state.now,
    ensureToken: async () => { state.onToken?.(); return { accessToken: 'test-token' }; },
    uploadConversion: async row => { state.uploads.push(row); return { requestId: `receipt-${state.uploads.length}` }; } };
  const initialize = async () => {
    const row = { leadFormSubmissionData: { id: 'provider-lead', resourceName: `customers/${accountId}/leadFormSubmissionData/provider-lead`,
      asset: `customers/${accountId}/assets/300`, campaign: `customers/${accountId}/campaigns/200`,
      adGroup: `customers/${accountId}/adGroups/400`, adGroupAd: `customers/${accountId}/adGroupAds/400~500`,
      submissionDateTime: '2026-09-11 02:00:00+02:00', gclid: 'private-click',
      leadFormSubmissionFields: [{ fieldType: 'EMAIL', fieldValue: 'patient@example.test' }, { fieldType: 'PHONE_NUMBER', fieldValue: '+34600000000' }] } };
    const context = await receptionAccount({ models, settingId: state.setting.id, accountId, now: state.now });
    await persistGoogleLead({ models, context, parsed: parseGoogleLead(row, accountId, state.now), now: state.now });
    await checkGooglePreparation({ models, scope, actorId: 2, now: () => state.now, hasAccess: async () => true,
      input: { account_id: accountId, expected_version: state.setting.version }, ensureToken: dependencies.ensureToken,
      list: async () => ({ actions: googleActions, clinicaclick_mapping: buildClinicaclickManagedMapping(googleActions) }),
      upload: async value => { assert.equal(value.validateOnly, true); return {}; } });
    const review = await loadSignalAuthorizationReview({ models, scope, setting: state.setting, now: state.now });
    assert.equal(review.review.ready, true, JSON.stringify({ review: review.review, proof: state.setting.signal_preparation }));
    await activateWorkspaceMeasurement({ models, scope, actorId: 2, now: () => state.now, hasAccess: async () => true, deploymentReady: true,
      input: { expected_version: state.setting.version, preparation_revision: 'a'.repeat(64), confirmed: true, mode: 'measurement', signals: { enabled: true } },
      loadPreparation: async () => ({ revision: 'a'.repeat(64), selectionConfirmed: true, receptionReady: true, signals: review.review,
        campaigns: [{ campaign, ready: true, configurationScope: null }] }),
      loadInventory: async () => ({ campaigns: [campaign], google: [{ customerId: accountId }], meta: [], groups: group ? [28] : [] }) });
    // Explicit private CRM consent fixture. Native reception itself never populates this grant.
    state.leads[0].consentimiento_canal = { ad_user_data: 'granted', ad_personalization: 'denied' };
    state.leads[0].status_lead = 'cualificado';
  };
  const send = (extra = {}) => maybeUploadLeadLifecycleConversion({ lead: state.leads[0], eventName: 'qualified_lead', eventId: 'lead-1-qualified',
    occurredAt: state.now, dependencies, ...extra });
  const health = () => loadGoogleSignalEvidence({ models, campaigns: [campaign], selectedClinics: [state.clinic], now: state.now });
  return { models, dependencies, state, initialize, send, campaign, health };
}

test('native reception, actual prepared mandate and CRM qualification use Google without creating a website', async () => {
  for (const group of [false, true]) {
    const h = harness({ group }); await h.initialize(); const result = await h.send();
    assert.equal(result.sent, true); assert.equal(h.state.webWrites, 0); assert.equal(h.state.records.length, 0);
    assert.equal(h.state.uploads[0].gclid, 'private-click'); assert.equal(h.state.uploads[0].eventSource, 'OTHER');
    assert.equal(h.state.uploads[0].email, undefined); assert.equal(h.state.uploads[0].phone, undefined);
    assert.equal(h.state.attempts[0].intakeConfigId, null);
    assert.equal(h.state.attempts[0].requestMetadata.consent_mode_configured, false);
    assert.equal(h.state.attempts[0].requestMetadata.consent_source, 'google_ads_native_crm');
    assert.equal(h.state.attempts[0].requestMetadata.workspace_delivery.schema_version, 3);
    assert.doesNotMatch(JSON.stringify(h.state.attempts), /private-click|private-token|patient@example|34600000000/);
    assert.equal((await h.send()).reason, 'duplicate_already_accepted'); assert.equal(h.state.uploads.length, 1);
  }
});
test('the canonical appointment must belong to this lead/clinic and still be current', async () => {
  const h = harness(); await h.initialize();
  const options = { eventName: 'schedule', eventId: 'appointment-9' };
  assert.equal((await h.send(options)).reason, 'workspace_google_native_milestone_not_current');
  h.state.appointments = [{ id_cita: 9, lead_intake_id: 1, clinica_id: 5, estado: 'pendiente' }];
  assert.equal((await h.send(options)).sent, true);
  assert.equal(h.state.uploads[0].conversionAction, 'customers/5992356722/conversionActions/102');
});
test('existing qualification and linked-appointment hooks queue Google without a synchronous upload', async () => {
  const h = harness(); await h.initialize();
  const queue = nativeQueue(h);
  const dependencies = { lifecycleDependencies: { enqueueGoogle: queue.enqueue,
    google: () => assert.fail('No synchronous Google upload'), enqueueMeta: () => assert.fail('No native Meta enqueue') } };
  const qualified = await maybeUploadQualifiedLeadStatusTransition({ lead: h.state.leads[0], previousStatus: 'nuevo', nextStatus: 'cualificado',
    occurredAt: h.state.now, dependencies });
  assert.equal(qualified.queued, true); assert.equal(qualified.sent, false);
  const appointment = { id_cita: 9, lead_intake_id: 1, clinica_id: 5, estado: 'pendiente', created_at: h.state.now };
  h.state.appointments = [appointment];
  const scheduled = await uploadScheduleForLinkedAppointment({ lead: h.state.leads[0], appointment, dependencies });
  assert.equal(scheduled.queued, true); assert.equal(h.state.uploads.length, 0);
  for (const job of queue.jobs) assert.equal((await queue.run(job)).status, 'completed');
  assert.deepEqual(h.state.uploads.map(row => row.externalId), ['lead-1-qualified', 'appointment-9']);
});

function nativeQueue(h) {
  const jobs = [];
  const dependencies = { ...h.dependencies, enqueue: async (input, options) => {
    const jobModel = {
      findOne: async query => {
        if (options.transaction) assert.equal(query.transaction, options.transaction);
        return jobs.find(job => job.type === input.type && job.payload.__dedupe_scope === input.dedupeScope && job.status === 'pending');
      },
      create: async (row, query) => {
        if (options.transaction) assert.equal(query.transaction, options.transaction);
        if (h.state.queueUnavailable) throw new Error('SQL unavailable with private contact');
        const job = { ...row, id: jobs.length + 1 }; jobs.push(job); return job;
      },
    };
    return require('../../services/jobRequests.service').enqueueUniqueJobRequest(input, { ...options,
      JobRequestModel: jobModel, sequelizeInstance: { literal: require('sequelize').literal,
        transaction: async (opts, work) => work({ LOCK: { UPDATE: 'UPDATE' } }) } });
  } };
  return { jobs, dependencies, enqueue: (extra = {}, options = {}) => enqueueGoogleLeadLifecycleSignal({ leadId: 1, clinicId: 5,
    eventName: 'qualified_lead', eventId: 'lead-1-qualified', occurredAt: h.state.now,
    crmEventSource: CRM_MILESTONE_SOURCE, ...extra }, { ...dependencies, ...options }),
  run: (job = jobs[0], options = {}) => runGoogleLeadLifecycleSignalJob(structuredClone(job.payload), job, { ...dependencies, ...options }) };
}

test('native Google jobs survive process state loss and preserve minimal payloads and idempotent delivery', async () => {
  for (const group of [false, true]) {
    const h = harness({ group }); await h.initialize(); const queue = nativeQueue(h);
    assert.equal((await queue.enqueue()).queued, true); assert.equal((await queue.enqueue()).created, false);
    assert.equal(queue.jobs.length, 1); assert.equal(h.state.uploads.length, 0);
    const job = structuredClone(queue.jobs[0]);
    assert.equal(job.type, JOB_TYPE); assert.equal(job.origin, ORIGIN); assert.equal(job.requested_by, null);
    assert.ok(job.payload.__runtime_namespace); assert.equal(job.max_attempts, 8);
    assert.doesNotMatch(JSON.stringify(job), /private-click|private-token|private-refresh|patient@example|34600000000|consentimiento|leadFormSubmission/);
    assert.equal((await queue.run(job)).status, 'completed');
    assert.equal((await queue.run(job)).delivery_status, 'duplicate_already_accepted');
    assert.equal(h.state.uploads.length, 1); assert.equal(h.state.webWrites, 0);
    assert.equal((await h.health()).get(h.campaign.id).processing, 1);
  }
});

test('a transient Google failure retries the same event; acceptance is not uploaded again', async () => {
  const h = harness(); await h.initialize(); const queue = nativeQueue(h); await queue.enqueue();
  const failure = await queue.run(undefined, { uploadConversion: async () => {
    throw Object.assign(new Error('private provider payload'), { response: { status: 503 } });
  } });
  assert.equal(failure.retryable, true); assert.equal(failure.error_message, 'google_crm_provider_error');
  assert.doesNotMatch(JSON.stringify(failure), /private/);
  assert.equal((await queue.run()).status, 'completed'); assert.equal(h.state.uploads.length, 1);
  assert.equal(h.state.uploads[0].externalId, 'lead-1-qualified');
  assert.equal(h.state.attempts.length, 1); assert.equal(h.state.attempts[0].attemptCount, 2);
  assert.equal((await queue.run()).status, 'completed'); assert.equal(h.state.uploads.length, 1);
});

test('loss of the acceptance receipt retries only after the reservation expires with the same Google transaction ID', async () => {
  const h = harness(); await h.initialize(); const queue = nativeQueue(h); await queue.enqueue();
  let failReceipt = true;
  h.state.onReserve = () => {
    const row = h.state.attempts[0]; const update = row.update;
    row.update = async patch => {
      if (failReceipt && patch.status === 'accepted') { failReceipt = false; throw new Error('receipt persistence failed'); }
      return update(patch);
    };
  };
  const failed = await queue.run(); assert.equal(failed.retryable, true); assert.equal(h.state.uploads.length, 1);
  const waiting = await queue.run(); assert.equal(waiting.error_message, 'duplicate_upload_in_progress');
  assert.equal(waiting.retryable, true); assert.equal(h.state.uploads.length, 1);
  h.state.attempts[0].attemptedAt = new Date(Date.now() - 6 * 60000);
  assert.equal((await queue.run()).status, 'completed'); assert.equal(h.state.uploads.length, 2);
  const { buildDataManagerEventRequest } = require('../../services/googleDataManagerConversion.service');
  const events = h.state.uploads.map(input => buildDataManagerEventRequest(input).events[0]);
  assert.equal(events[0].transactionId, 'lead-1-qualified');
  assert.equal(events[1].transactionId, events[0].transactionId);
  assert.equal(events[1].eventTimestamp, events[0].eventTimestamp);
  assert.equal((await queue.run()).status, 'completed'); assert.equal(h.state.uploads.length, 2);
});

test('without a permitted matching identifier Google stops without sending or an endless retry', async () => {
  const h = harness(); await h.initialize(); h.state.leads[0].gclid = null;
  const queue = nativeQueue(h); await queue.enqueue(); const result = await queue.run();
  assert.equal(result.error_message, 'no_permitted_identifiers'); assert.equal(result.retryable, false);
  assert.equal(h.state.uploads.length, 0);
});

test('Google permanent errors stop; rate limits and network errors retry without exposing payloads', async () => {
  for (const status of [400, 401, 403, 408, 429, 500, 0]) {
    const h = harness(); await h.initialize(); const queue = nativeQueue(h); await queue.enqueue();
    const result = await queue.run(undefined, { uploadConversion: async () => {
      throw Object.assign(new Error('token and contact must stay private'), { response: { status } });
    } });
    assert.equal(result.status, 'failed');
    assert.equal(result.retryable, [408, 429, 500, 0].includes(status));
    assert.doesNotMatch(JSON.stringify(result), /token|contact/);
  }
});

test('revoked permissions, consent, changed sources or scope stop a persisted Google job', async () => {
  for (const change of [h => h.state.assignments[0].status = 'revoked',
    h => h.state.leads[0].consentimiento_canal = null,
    h => h.state.leads[0].telefono = '34611111111',
    h => h.state.leads[0].gclid = 'different-click',
    h => h.state.leads[0].status_lead = 'descartado',
    h => h.state.decisions = [{ status: 'active', clinica_id: 6 }],
    h => h.state.setting.version++,
    h => h.state.setting.accounts[0].include_future = false,
    h => h.state.env.CAMPAIGN_WORKSPACE_ACTIVATION_ENABLED = 'false',
    h => h.state.now = new Date(+h.state.now + 8 * 86400000)]) {
    const h = harness(); await h.initialize(); const queue = nativeQueue(h); await queue.enqueue(); change(h);
    const result = await queue.run(); assert.equal(result.status, 'failed'); assert.equal(result.retryable, false);
    assert.equal(h.state.uploads.length, 0);
  }
});

test('a queued Google job rechecks its fingerprint after worker validation and after OAuth', async () => {
  const { nativeLifecycleContext } = require('../../services/campaignWorkspaceGoogleNative.service');
  for (const phase of ['worker', 'oauth', 'reservation']) {
    const h = harness(); await h.initialize(); const queue = nativeQueue(h); await queue.enqueue();
    const change = () => { h.state.leads[0].consentimiento_canal = null; };
    const options = {};
    if (phase === 'worker') options.resolve = async (input, dependencies) => {
      const context = await nativeLifecycleContext(input, dependencies); change(); return context;
    };
    if (phase === 'oauth') h.state.onToken = change;
    if (phase === 'reservation') h.state.onReserve = change;
    const result = await queue.run(undefined, options);
    assert.equal(result.status, 'failed'); assert.equal(result.retryable, false); assert.equal(h.state.uploads.length, 0);
  }
});

test('native Google enqueue uses the CRM transaction for every source and authorization read', async () => {
  const h = harness({ group: true }); await h.initialize(); const queue = nativeQueue(h);
  const transaction = { LOCK: { UPDATE: 'UPDATE' } }; let reads = 0;
  for (const model of Object.values(h.models)) for (const method of ['findByPk', 'findAll', 'findOne']) {
    if (typeof model[method] !== 'function') continue;
    const original = model[method];
    model[method] = async (...args) => {
      const query = method === 'findByPk' ? args[1] : args[0];
      assert.equal(query?.transaction, transaction, method); reads++;
      return original(...args);
    };
  }
  assert.equal((await queue.enqueue({}, { transaction })).queued, true); assert.ok(reads >= 10);
  assert.equal(h.state.uploads.length, 0);
});

test('queue persistence failures fail the CRM transaction; absent consent does not fail a CRM save', async () => {
  const h = harness(); await h.initialize(); const queue = nativeQueue(h); h.state.queueUnavailable = true;
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  await assert.rejects(queue.enqueue({}, { transaction }), { code: 'google_crm_outbox_persistence_failed' });
  assert.equal(queue.jobs.length, 0);
  assert.equal((await queue.enqueue()).reason, 'google_crm_unavailable');
  h.state.leads[0].consentimiento_canal = null;
  assert.equal((await queue.enqueue({}, { transaction })).reason, 'google_crm_consent_required');
});

test('only internal, canonical, time-bounded CRM jobs can reach Google', async () => {
  const h = harness(); await h.initialize(); const queue = nativeQueue(h);
  assert.equal((await queue.enqueue({ crmEventSource: 'crm_milestone' })).reason, 'workspace_crm_milestone_required');
  for (const extra of [{ eventName: 'purchase' }, { leadId: true }, { eventId: 'lead-2-qualified' }, { occurredAt: 'invalid' }]) {
    assert.equal((await queue.enqueue(extra)).queued, false);
  }
  await queue.enqueue();
  for (const extra of [{ type: 'custom' }, { origin: 'manual' }, { requested_by: 5 }]) {
    assert.equal((await queue.run({ ...queue.jobs[0], ...extra })).error_message, 'google_crm_internal_job_required');
  }
  const job = structuredClone(queue.jobs[0]); job.payload.source_fingerprint = 'bad';
  assert.equal((await queue.run(job)).error_message, 'google_crm_job_invalid');
  assert.equal(h.state.uploads.length, 0);
});
test('reception, advertising consent and enhanced identifiers are separate permissions', async () => {
  for (const consent of [null, {}, { analytics: true }, { marketing: false }, { ad_user_data: 'denied' }]) {
    const h = harness(); await h.initialize(); h.state.leads[0].consentimiento_canal = consent;
    assert.equal((await h.send()).reason, 'consent_not_granted'); assert.equal(h.state.uploads.length, 0);
    assert.equal(h.state.leads.length, 1, 'missing advertising consent must not remove the received lead');
  }
});
test('caller data cannot forge native identity, a CRM capability or permitted contact data', async () => {
  const h = harness(); await h.initialize();
  assert.equal((await maybeUploadNativeGoogleLifecycleConversion({ leadId: 1, clinicId: 5, eventName: 'qualified_lead',
    eventId: 'lead-1-qualified', occurredAt: h.state.now, crmEventSource: 'campaign_crm_milestone' }, h.dependencies)).reason, 'workspace_crm_milestone_required');
  h.state.attributions[0].attribution_steps.advertising_identity.verified_by = 'browser';
  assert.equal(await resolveNativeGoogleLeadIdentity({ models: h.models, lead: h.state.leads[0] }), null);
  assert.equal((await h.send()).reason, 'workspace_google_native_identity_required'); assert.equal(h.state.uploads.length, 0);
});
test('conflicting audits, changed form/clinic and altered provider ID cannot reuse a receipt', async () => {
  for (const change of [h => h.state.attributions[0].raw_payload.lead_id = 'other-lead',
    h => h.state.leads[0].source_detail = 'leadgen_form:301',
    h => h.state.attributions[0].attribution_steps.advertising_identity.clinic_id = 6,
    h => h.state.attributions.push({ ...h.state.attributions[0], attribution_steps: { advertising_identity: {
      ...h.state.attributions[0].attribution_steps.advertising_identity, ad_id: '501' } } })]) {
    const h = harness(); await h.initialize(); change(h);
    assert.equal((await h.send()).reason, 'workspace_google_native_identity_required'); assert.equal(h.state.uploads.length, 0);
  }
});
test('revocation, CRM changes and consent changes after OAuth or reservation stop the transport', async () => {
  for (const hook of ['onToken', 'onReserve']) for (const change of [h => h.state.setting.activation.signals.enabled = false,
    h => h.state.leads[0].consentimiento_canal.ad_user_data = 'denied', h => h.state.assignments[0].status = 'revoked',
    h => h.state.decisions = [{ status: 'active', clinica_id: 6 }], h => h.state.leads[0].status_lead = 'descartado',
    h => h.state.leads[0].email = 'changed@example.test', h => h.state.env.CAMPAIGN_WORKSPACE_ACTIVATION_ENABLED = 'false']) {
    const h = harness(); await h.initialize(); h.state[hook] = () => change(h);
    assert.equal((await h.send()).sent, false); assert.equal(h.state.uploads.length, 0);
  }
});
test('disabled, unsupported, stale and cross-clinic native milestones never fall back to Web targets', async () => {
  const h = harness(); await h.initialize();
  h.state.env.CAMPAIGN_WORKSPACE_ACTIVATION_ENABLED = 'false'; assert.equal((await h.send()).reason, 'workspace_activation_disabled');
  h.state.env.CAMPAIGN_WORKSPACE_ACTIVATION_ENABLED = 'true';
  for (const extra of [{ eventName: 'purchase' }, { eventName: 'Lead' }, { eventId: 'lead-2-qualified' },
    { occurredAt: new Date('2020-01-01') }, { clinicId: 6 }]) {
    assert.equal((await h.send(extra)).sent, false);
  }
  assert.equal(h.state.uploads.length, 0);
});
test('a JSON native-consent flag cannot bypass the existing uploader CMP requirement', async () => {
  const h = harness(); await h.initialize();
  const result = await maybeUploadGoogleConversion({ cfgRecord: null, clinicId: 5, eventName: 'qualified_lead', eventId: 'lead-1-qualified',
    googleAdsConfig: { enabled: true, customer_id: '5992356722', events: { qualified_lead: { enabled: true, conversion_action_id: '101' } } },
    consent: { ad_user_data: 'granted' }, consentModeEnabled: true, crmEventSource: 'campaign_crm_milestone',
    customData: { gclid: 'private-click', consentSource: 'google_ads_native_crm', nativeConsent: true },
    dependencies: { auditModel: h.models.GoogleAdsConversionUploadAttempt } });
  assert.equal(result.reason, 'consent_not_granted');
});

test('native Health verifies the current mandate without a web and distinguishes received from processed', async () => {
  for (const group of [false, true]) {
    const h = harness({ group }); await h.initialize(); await h.send();
    let evidence = (await h.health()).get(h.campaign.id);
    assert.equal(evidence.checked, true); assert.equal(evidence.processing, 1); assert.equal(evidence.ready, false);
    const row = h.state.attempts[0];
    Object.assign(row, { status: 'succeeded', completedAt: h.state.now, responseMetadata: { destinations: [{
      customer_id: h.campaign.account_id, conversion_action_id: '101', record_count: 1, status: 'SUCCESS', errors: [], warnings: [],
    }] } });
    evidence = (await h.health()).get(h.campaign.id);
    assert.equal(evidence.processed, 1); assert.equal(evidence.ready, true);
    h.state.setting.activation.signals.enabled = false;
    assert.equal((await h.health()).get(h.campaign.id).checked, false);
    assert.equal(h.state.records.length, 0);
  }
});
test('Health is read-only, does not load contacts and never caches native authorization across requests', async () => {
  const h = harness(); await h.initialize(); await h.send();
  h.models.LeadIntake.findByPk = async () => assert.fail('Health must not retrieve a patient contact');
  let settingsRead = 0;
  h.models.CampaignWorkspaceSetting.findByPk = async () => { settingsRead++; return h.state.setting; };
  const attempt = h.state.attempts[0];
  h.state.attempts.push({ ...attempt, id: 2, requestMetadata: structuredClone(attempt.requestMetadata) });
  const count = h.state.uploads.length;
  assert.equal((await h.health()).get(h.campaign.id).received, 2);
  assert.equal(settingsRead, 1);
  assert.equal(h.state.uploads.length, count);
  h.state.assignments[0].status = 'revoked';
  assert.equal((await h.health()).get(h.campaign.id).checked, false);
});
test('native Health rejects a swapped campaign/form, a web record and a mismatched clinic assignment', async () => {
  for (const change of [h => h.state.attempts[0].requestMetadata.workspace_delivery.native_identity.form_id = '301',
    h => h.state.attempts[0].requestMetadata.workspace_delivery.native_identity.account_id = '999',
    h => h.state.attempts[0].intakeConfigId = 1,
    h => h.state.decisions = [{ status: 'active', clinica_id: 6 }]]) {
    const h = harness(); await h.initialize(); await h.send(); change(h);
    assert.equal((await h.health()).get(h.campaign.id).checked, false);
  }
});

function enhancedPolicy() {
  return { user_data_enabled: true, enhanced_conversions: { enabled: true,
    policy_mode: 'documented_google_account_team_guidance_and_advertiser_authorization',
    allowlist: [{ enabled: true, customer_id: '5992356722', event_name: 'qualified_lead', authorization: {
      google_evidence_ref: 'test-google-guidance-ref', google_guidance_at: '2025-01-01T00:00:00Z',
      advertiser_authorization_ref: 'test-advertiser-authorization', advertiser_authorized_at: '2026-01-01T00:00:00Z',
      permitted_identifiers: ['email', 'phone'], policy_ambiguity_acknowledged: true, formal_policy_exception_claimed: false,
      measurement_only: true, customer_match_enabled: false, conversion_based_customer_lists_enabled: false,
      remarketing_enabled: false, ad_personalization_source: 'visitor_consent',
    } }],
  } };
}
test('existing documented enhanced authorization is reused without treating it as a website installation', async () => {
  const h = harness(); await h.initialize(); h.state.leads[0].gclid = null;
  h.state.records = [{ id: 1, assignment_scope: 'clinic', clinic_id: 5, config: { google_ads: enhancedPolicy() } }];
  assert.equal((await h.send()).sent, true);
  assert.equal(h.state.uploads[0].email, 'patient@example.test'); assert.equal(h.state.uploads[0].phone, '34600000000');
  assert.equal(h.state.uploads[0].adPersonalizationStatus, 'DENIED');
  assert.equal(h.state.attempts[0].requestMetadata.user_data_sent, true);
  assert.equal(h.state.attempts[0].intakeConfigId, null);
  assert.equal(h.state.webWrites, 0);
});
test('native sources cannot widen enhanced-conversion permissions or reuse changed authorization', async () => {
  for (const change of [h => h.state.records[0].config.google_ads.enhanced_conversions.enabled = false,
    h => h.state.records[0].config.google_ads.enhanced_conversions.allowlist[0].authorization.expires_at = '2020-01-01',
    h => h.state.leads[0].consentimiento_canal = { marketing: true },
    h => h.state.leads[0].consentimiento_canal = { ad_user_data: 'granted' }]) {
    const h = harness(); await h.initialize(); h.state.leads[0].gclid = null;
    h.state.records = [{ id: 1, assignment_scope: 'clinic', clinic_id: 5, config: { google_ads: enhancedPolicy() } }]; change(h);
    assert.equal((await h.send()).reason, 'no_permitted_identifiers'); assert.equal(h.state.uploads.length, 0);
  }
  const h = harness(); await h.initialize();
  h.state.records = [{ id: 1, assignment_scope: 'clinic', clinic_id: 5, config: { google_ads: enhancedPolicy() } }];
  h.state.onReserve = () => h.state.records[0].config.google_ads.enhanced_conversions.enabled = false;
  assert.equal((await h.send()).sent, false); assert.equal(h.state.uploads.length, 0);
});
