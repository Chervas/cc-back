'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Op } = require('sequelize');
const { JOB_TYPE, ORIGIN, enqueueMetaLeadLifecycleSignal, runMetaLeadLifecycleSignalJob,
  resolveLifecycleSignal } = require('../../services/metaLeadLifecycleJob.service');
const { CRM_MILESTONE_SOURCE } = require('../../services/campaignWorkspaceSignalPolicy.service');
const { sendWorkspaceMetaSignal } = require('../../services/metaWorkspaceSignalDelivery.service');
const { maybeUploadLeadLifecycleConversion } = require('../../services/leadLifecycleConversion.service');
const { resolveNativeMetaLeadIdentity } = require('../../services/leadAdvertisingIdentity.service');

const copy = value => structuredClone(value);
function matches(row, where) {
  return Reflect.ownKeys(where || {}).every(key => {
    const value = where[key];
    if (key === Op.or) return value.some(branch => matches(row, branch));
    if (value && typeof value === 'object') {
      if (value[Op.in]) return value[Op.in].includes(row[key]);
      assert.fail(`Unhandled query for ${String(key)}`);
    }
    return row[key] === value;
  });
}

function harness() {
  const selection = { provider: 'meta_ads', account_id: '20', include_future: true, campaign_ids: [] };
  const state = { now: new Date('2026-09-10T19:00:00Z'), jobs: [], posts: [], deliveries: [], queries: [],
    env: { CAMPAIGN_WORKSPACE_ACTIVATION_ENABLED: 'true' },
    lead: { id: 123, clinica_id: 1, source: 'meta_ads', external_source: 'meta_leadgen', external_id: '777',
      status_lead: 'cualificado', archived_at: null, consentimiento_canal: { marketing: true } },
    clinic: { id_clinica: 1, grupoClinicaId: 8, estado_clinica: true },
    identity: { version: 1, verified_by: 'meta_graph', provider: 'meta_ads', clinic_id: 1,
      account_id: '20', campaign_id: '30', ad_id: '40', page_id: '60', form_id: '70' },
    appointments: [{ id_cita: 456, clinica_id: 1, lead_intake_id: 123, estado: 'pendiente', es_provisional: false }],
    assets: [{ id: 4, assetType: 'ad_account', metaAssetId: 'act_20', isActive: true,
      assignmentScope: 'clinic', clinicaId: 1, metaConnectionId: 7 },
    { id: 5, assetType: 'facebook_page', metaAssetId: '60', isActive: true,
      assignmentScope: 'clinic', clinicaId: 1, metaConnectionId: 7 }],
    assignments: [{ id: 3, scopeKey: 'clinic:1', assignmentScope: 'clinic', clinicaId: 1, metaConnectionId: 7,
      status: 'active', connectedAt: '2026-09-01T00:00:00Z' }],
    externalAssignments: [], connection: { id: 7, accessToken: 'secret-token', expiresAt: '2027-01-01' },
    clinicRecord: { id: 'web-1', assignment_scope: 'clinic', clinic_id: 1, config: {
      meta_ads: { enabled: true, connection_id: 7, ad_account_id: 'act_20', pixel_id: '50' },
      campaigns: { workspace_policy: { schema_version: 1, setting_id: 'setting', scope_type: 'clinic', scope_id: 1 } } } },
    groupRecord: null,
    setting: { id: 'setting', scope_type: 'clinic', scope_id: 1, version: 2, accounts: [selection], activation: {
      schema_version: 1, status: 'active', mode: 'measurement', signals: { enabled: true, events: ['qualified_lead', 'schedule'] },
      account_authorizations: [selection] } },
    response: { data: { events_received: 1 } },
  };
  const all = getter => async ({ where } = {}) => copy(getter().filter(row => matches(row, where)));
  const models = {
    LeadIntake: { findByPk: async (id, query) => { state.queries.push(query); return id === state.lead?.id ? copy(state.lead) : null; } },
    LeadAttributionAudit: { findAll: async () => copy(state.audits || [{ identity: state.identity, native_lead_id: '777' }]) },
    CitaPaciente: { findAll: all(() => state.appointments) },
    Clinica: { findByPk: async id => id === state.clinic.id_clinica ? copy(state.clinic) : null },
    ClinicMetaAsset: { findAll: all(() => state.assets) },
    MetaConnectionAssignment: { findAll: all(() => state.assignments),
      findOne: async ({ where }) => copy(state.assignments.find(row => matches(row, where)) || null) },
    ExternalCampaignAssignment: { findAll: all(() => state.externalAssignments) },
    MetaConnection: { findByPk: async id => id === state.connection?.id ? copy(state.connection) : null },
    CampaignWorkspaceSetting: { findAll: all(() => state.setting ? [state.setting] : []),
      findByPk: async id => state.setting?.id === id ? copy(state.setting) : null },
    IntakeConfig: { findOne: async ({ where }) => copy([state.clinicRecord, state.groupRecord].filter(Boolean).find(row => matches(row, where)) || null) },
    sequelize: { transaction: async fn => fn({ LOCK: { UPDATE: 'UPDATE' } }) },
    MetaSignalDelivery: {
      findOne: async ({ where }) => state.deliveries.find(row => matches(row, where)) || null,
      create: async values => {
        const row = { ...values, created_at: values.attempted_at, update: async patch => { Object.assign(row, patch); return row; } };
        state.deliveries.push(row); if (state.afterReserve) state.afterReserve(); return row;
      },
      update: async (patch, { where }) => { const row = state.deliveries.find(item => matches(item, where));
        if (!row) return [0]; Object.assign(row, patch); return [1]; },
    },
  };
  const input = { leadId: 123, clinicId: 1, eventName: 'qualified_lead', eventId: 'lead-123-qualified',
    occurredAt: state.now, crmEventSource: CRM_MILESTONE_SOURCE };
  const deps = { models, env: state.env, now: () => state.now,
    enqueue: async options => {
      const existing = state.jobs.find(job => job.dedupeScope === options.dedupeScope);
      if (existing) return { created: false, job: existing };
      const job = { id: state.jobs.length + 1, ...copy(options), requested_by: null };
      state.jobs.push(job); return { created: true, job };
    },
    send: (signal, options) => sendWorkspaceMetaSignal(signal, { ...options, models,
      send: async (...args) => { state.posts.push(args); if (state.providerError) throw state.providerError; return state.response; } }),
  };
  return { state, models, input, deps,
    enqueue: patch => enqueueMetaLeadLifecycleSignal({ ...input, ...patch }, deps),
    run: (patch = {}, overrides = {}) => runMetaLeadLifecycleSignalJob({ ...state.jobs[0]?.payload, ...patch }, state.jobs[0], { ...deps, ...overrides }),
  };
}

test('canonical native lead -> durable job -> minimal Meta event -> receipt, without a second receiver', async () => {
  const h = harness(); const queued = await h.enqueue();
  assert.equal(queued.queued, true); assert.equal(h.state.posts.length, 0);
  const result = await h.run(); assert.equal(result.status, 'completed'); assert.equal(result.delivery_status, 'accepted');
  assert.equal(h.state.deliveries.length, 1); assert.equal(h.state.posts.length, 1);
  const [dataset, payload, options] = h.state.posts[0];
  assert.equal(dataset, '50'); assert.equal(options.accessToken, 'secret-token');
  assert.deepEqual(payload.data[0], { event_name: 'QualifiedLead', event_id: 'lead-123-qualified',
    event_time: +h.state.now / 1000, action_source: 'system_generated', user_data: { lead_id: '777' },
    custom_data: { event_source: 'crm', lead_event_source: 'ClinicaClick' } });
  assert.doesNotMatch(JSON.stringify(h.state.jobs), /"777"|secret-token|marketing|email|telefono|treatment/);
  assert.deepEqual(Object.keys(h.state.jobs[0].payload).sort(), ['schema_version', 'lead_id', 'clinic_id',
    'event_name', 'event_id', 'appointment_id', 'occurred_at', 'authorization_key'].sort());
  for (const query of h.state.queries) assert.ok(!query.attributes.some(field => ['email', 'telefono', 'nombre', 'notas'].includes(field)));
  assert.equal(h.state.jobs[0].maxAttempts, 8);
});

test('Schedule uses the linked appointment and original booking time, not a future visit', async () => {
  const h = harness(); await h.enqueue({ eventName: 'schedule', eventId: 'appointment-456' });
  h.state.now = new Date(+h.state.now + 3600000);
  assert.equal((await h.run()).status, 'completed');
  const event = h.state.posts[0][1].data[0];
  assert.equal(event.event_name, 'Schedule'); assert.equal(event.event_time, +h.input.occurredAt / 1000);
  assert.equal(event.event_id, 'appointment-456');
});

test('closed deployment gate performs no lookup, queue write or send', async () => {
  const h = harness(); h.state.env.CAMPAIGN_WORKSPACE_ACTIVATION_ENABLED = 'false';
  h.models.LeadIntake.findByPk = () => assert.fail('no DB reads behind gate');
  assert.equal((await h.enqueue()).reason, 'workspace_activation_disabled');
  assert.equal((await h.run()).retryable, false); assert.equal(h.state.jobs.length, 0); assert.equal(h.state.posts.length, 0);
});

test('public JSON cannot claim an internal CRM milestone or create a manual signal job', async () => {
  const h = harness(); assert.equal((await h.enqueue({ crmEventSource: 'campaign_crm_milestone' })).queued, false);
  await h.enqueue();
  for (const patch of [{ requested_by: 1 }, { origin: 'manual' }, { type: 'unknown' }]) {
    const job = { ...h.state.jobs[0], ...patch };
    const result = await runMetaLeadLifecycleSignalJob(job.payload, job, h.deps);
    assert.equal(result.error_message, 'meta_crm_internal_job_required'); assert.equal(result.retryable, false);
  }
  assert.equal(h.state.posts.length, 0);
});

test('contact, analytics and implicit consent cannot authorize CRM advertising signals', async () => {
  for (const consent of [null, true, 'granted', { whatsapp: true }, { analytics: true }, { marketing: false },
    { marketing: true, ad_user_data: 'denied' }, { ad_user_data: 'granted', marketing: false }]) {
    const h = harness(); h.state.lead.consentimiento_canal = consent;
    assert.equal((await h.enqueue()).reason, 'meta_crm_consent_required'); assert.equal(h.state.jobs.length, 0);
  }
  const h = harness(); h.state.lead.consentimiento_canal = { ad_user_data: 'granted' };
  assert.equal((await h.enqueue()).queued, true);
});

test('native identity must come from matching server audit, not a form or a guessed Meta campaign', async () => {
  for (const change of [s => { s.lead.external_source = 'web'; }, s => { s.lead.external_id = '999'; },
    s => { s.identity.verified_by = 'form'; }, s => { s.identity.clinic_id = 2; },
    s => { s.audits = []; }, s => { s.identity = null; }]) {
    const h = harness(); change(h.state);
    assert.equal((await h.enqueue()).reason, 'meta_crm_verified_native_lead_required'); assert.equal(h.state.jobs.length, 0);
  }
  const h = harness();
  h.state.audits = [{ identity: h.state.identity, native_lead_id: '777' },
    { identity: { ...h.state.identity, campaign_id: '99' }, native_lead_id: '777' }];
  assert.equal(await resolveNativeMetaLeadIdentity({ models: h.models, lead: h.state.lead }), null);
  h.state.audits = [{ identity: JSON.stringify(h.state.identity), native_lead_id: '"777"' }];
  assert.equal((await h.enqueue()).queued, true);
});

test('cancelled, provisional, unrelated or moved appointments cannot emit Schedule', async () => {
  for (const patch of [{ estado: 'cancelada' }, { es_provisional: true }, { lead_intake_id: 999 }, { clinica_id: 2 }]) {
    const h = harness(); Object.assign(h.state.appointments[0], patch);
    assert.equal((await h.enqueue({ eventName: 'schedule', eventId: 'appointment-456' })).reason, 'meta_crm_milestone_not_current');
  }
  const h = harness(); h.state.lead.status_lead = 'nuevo';
  assert.equal((await h.enqueue()).queued, true, 'a real linked booking also verifies qualification');
  h.state.appointments = [];
  assert.equal((await h.enqueue()).reason, 'meta_crm_milestone_not_current');
});

test('disconnected pages, revoked accounts and reassigned campaigns are rejected before enqueue', async () => {
  for (const change of [s => { s.assets = s.assets.filter(row => row.assetType !== 'facebook_page'); },
    s => { s.assignments[0].status = 'revoked'; }, s => { s.connection.expiresAt = '2020-01-01'; },
    s => { s.externalAssignments = [{ provider: 'meta_ads', customer_id: '20', campaign_id: '30', status: 'active', clinica_id: 2 }]; }]) {
    const h = harness(); change(h.state);
    assert.equal((await h.enqueue()).queued, false); assert.equal(h.state.jobs.length, 0);
  }
});

test('CRM reuses only an explicit current workspace policy, never a legacy or disabled signal setting', async () => {
  for (const change of [s => { delete s.clinicRecord.config.campaigns; },
    s => { s.setting.activation.signals.enabled = false; }, s => { s.setting.activation.status = 'inactive'; },
    s => { s.setting.activation.signals.events = ['lead']; }, s => { s.clinicRecord.config.meta_ads.pixel_id = null; }]) {
    const h = harness(); change(h.state);
    assert.equal((await h.enqueue()).queued, false); assert.equal(h.state.posts.length, 0);
  }
});

test('old jobs cannot adopt another destination or policy revision, even if the new one is authorized', async () => {
  for (const change of [s => { s.setting.version++; }, s => { s.clinicRecord.config.meta_ads.pixel_id = '99'; },
    s => { s.assignments[0].connectedAt = '2026-09-09T00:00:00Z'; }, s => { s.identity.campaign_id = '31'; }]) {
    const h = harness(); await h.enqueue(); change(h.state);
    const result = await h.run(); assert.equal(result.error_message, 'meta_crm_authorization_changed');
    assert.equal(result.retryable, false); assert.equal(h.state.posts.length, 0);
  }
});

test('revocation, archive, deletion or scope change before a retry cancels that job', async () => {
  for (const change of [s => { s.lead.consentimiento_canal = { marketing: false }; }, s => { s.lead.archived_at = s.now; },
    s => { s.lead = null; }, s => { s.lead.clinica_id = 2; }, s => { s.lead.status_lead = 'descartado'; },
    s => { s.clinic.estado_clinica = false; }]) {
    const h = harness(); await h.enqueue(); change(h.state);
    const result = await h.run(); assert.equal(result.status, 'failed'); assert.equal(result.retryable, false);
    assert.equal(h.state.posts.length, 0);
  }
});

test('source and deployment are rechecked after ledger reservation, just before network', async () => {
  for (const change of [s => { s.lead.consentimiento_canal = { marketing: false }; },
    s => { s.env.CAMPAIGN_WORKSPACE_ACTIVATION_ENABLED = 'false'; }, s => { s.lead.external_id = '999'; },
    s => { s.lead.status_lead = 'descartado'; }]) {
    const h = harness(); await h.enqueue(); h.state.afterReserve = () => change(h.state);
    const result = await h.run(); assert.equal(result.status, 'failed'); assert.equal(result.retryable, false);
    assert.equal(h.state.posts.length, 0); assert.equal(h.state.deliveries[0].status, 'skipped');
  }
});

test('temporary failures retry with the same event, and accepted receipts are never resent', async () => {
  const h = harness(); await h.enqueue(); h.state.providerError = new Error('private provider error');
  assert.equal((await h.run()).retryable, true);
  h.state.providerError = null; h.state.now = new Date(+h.state.now + 120000);
  assert.equal((await h.run()).status, 'completed');
  assert.deepEqual(h.state.posts[0][1], h.state.posts[1][1]);
  assert.equal(h.state.deliveries[0].attempt_count, 2);
  assert.equal((await h.run()).delivery_status, 'already_received'); assert.equal(h.state.posts.length, 2);
  assert.equal((await h.enqueue()).created, false); assert.equal(h.state.jobs.length, 1);
});

test('malformed responses and rate limits retry, permission failures do not', async () => {
  for (const response of [{ data: '' }, { data: { events_received: '1' } }]) {
    const h = harness(); await h.enqueue(); h.state.response = response;
    assert.equal((await h.run()).retryable, true);
  }
  const limited = harness(); await limited.enqueue(); limited.state.providerError = { code: 'META_RATE_LIMIT_PAUSED' };
  assert.equal((await limited.run()).retryable, true);
  const denied = harness(); await denied.enqueue(); denied.state.providerError = { response: { status: 403, data: { error: { code: 200 } } } };
  assert.equal((await denied.run()).retryable, false);
  const invalid = harness(); await invalid.enqueue(); invalid.state.providerError = { response: { status: 400, data: { error: { code: 100 } } } };
  assert.equal((await invalid.run()).retryable, false);
  const throttled = harness(); await throttled.enqueue(); throttled.state.providerError = { response: { status: 429 } };
  assert.equal((await throttled.run()).retryable, true);
});

test('shared account needs an explicit clinic assignment; group web scope and both policies remain enforced', async () => {
  const h = harness();
  h.state.assets.forEach(asset => Object.assign(asset, { assignmentScope: 'group', clinicaId: null, grupoClinicaId: 8 }));
  h.state.assignments[0] = { ...h.state.assignments[0], scopeKey: 'group:8', assignmentScope: 'group', clinicaId: null, grupoClinicaId: 8 };
  h.state.groupRecord = { ...copy(h.state.clinicRecord), id: 'group-config', assignment_scope: 'group', group_id: 8, clinic_id: null };
  h.state.groupRecord.config.locations = [{ id: 1 }];
  h.state.groupRecord.config.campaigns.workspace_policy = { schema_version: 1, setting_id: 'setting', scope_type: 'group', scope_id: 8 };
  h.state.setting.scope_type = 'group'; h.state.setting.scope_id = 8;
  assert.equal((await h.enqueue()).reason, 'meta_crm_campaign_scope_changed');
  h.state.externalAssignments = [{ provider: 'meta_ads', customer_id: '20', campaign_id: '30', status: 'active', clinica_id: 1 }];
  assert.equal((await h.enqueue()).queued, true);
  assert.equal((await h.run()).status, 'completed');
  h.state.groupRecord.config.locations = [{ id: 2 }];
  assert.equal((await h.run()).retryable, false);
  assert.equal(h.state.posts.length, 1);
});

test('future campaigns are imported only while both selection and explicit authorization include them', async () => {
  const h = harness(); h.state.identity.campaign_id = '99';
  assert.equal((await h.enqueue()).queued, true);
  h.state.setting.accounts[0] = { ...h.state.setting.accounts[0], include_future: false, campaign_ids: ['30'] };
  const result = await h.run(); assert.equal(result.retryable, false); assert.equal(h.state.posts.length, 0);
});

test('warnings are retained as received-with-warning without automatic duplicate sends', async () => {
  const h = harness(); await h.enqueue(); h.state.response.data.messages = ['private provider warning'];
  assert.equal((await h.run()).delivery_status, 'warning');
  assert.equal((await h.run()).status, 'completed'); assert.equal(h.state.posts.length, 1);
  assert.doesNotMatch(JSON.stringify(h.state.deliveries), /private provider warning/);
});

test('manual retries cannot replay an ambiguous delivery more than 24 hours after its first attempt', async () => {
  const h = harness(); await h.enqueue(); h.state.providerError = new Error('timeout');
  assert.equal((await h.run()).retryable, true);
  h.state.providerError = null; h.state.now = new Date(+h.state.now + 24 * 3600000);
  const result = await h.run(); assert.equal(result.error_message, 'meta_delivery_retry_expired');
  assert.equal(result.retryable, false); assert.equal(h.state.posts.length, 1);
  h.state.jobs = []; await h.enqueue();
  assert.equal((await h.run()).error_message, 'meta_delivery_retry_expired');
  assert.equal(h.state.posts.length, 1);
});

test('bad milestones, unsupported Purchase and expired events never reach Meta', async () => {
  for (const patch of [{ eventName: 'purchase' }, { eventId: 'lead-999-qualified' }, { clinicId: '1oops' }, { clinicId: true },
    { eventName: 'schedule', eventId: 'appointment-456oops' }, { occurredAt: 'invalid' },
    { occurredAt: '2025-01-01' }, { occurredAt: '2027-01-01' }]) {
    const h = harness(); assert.equal((await h.enqueue(patch)).queued, false); assert.equal(h.state.jobs.length, 0);
  }
  const h = harness(); await h.enqueue(); h.state.now = new Date(+h.state.now + 8 * 86400000);
  assert.equal((await h.run()).retryable, false); assert.equal(h.state.posts.length, 0);
});

test('malformed job references cannot replace the persisted event identity', async () => {
  const h = harness(); await h.enqueue();
  for (const patch of [{ schema_version: 2 }, { appointment_id: 456 }, { authorization_key: 'other' },
    { event_name: 'purchase' }, { occurred_at: '2026-09-10T19:00:00.001Z' }]) {
    assert.equal((await h.run(patch)).retryable, false);
  }
  assert.equal(h.state.posts.length, 0);
});

test('database failures are sanitized and retryable but do not call the provider', async () => {
  const h = harness(); await h.enqueue(); h.models.LeadIntake.findByPk = () => { throw new Error('patient@private.example SQL'); };
  const result = await h.run(); assert.equal(result.error_message, 'meta_crm_unavailable'); assert.equal(result.retryable, true);
  assert.equal(h.state.posts.length, 0);
});

test('dispatcher queues Meta independently and preserves the Google result and payload', async () => {
  const calls = []; const original = { lead: { id: 123, clinica_id: 1 }, eventName: 'schedule', eventId: 'appointment-456',
    occurredAt: new Date(), value: 999, dependencies: {
      enqueueMeta: async input => { calls.push(input); return { queued: true, jobId: 1 }; },
      google: async input => { assert.equal(input, original); assert.equal(calls.length, 1); return { sent: true, accepted: true }; },
    } };
  const result = await maybeUploadLeadLifecycleConversion(original);
  assert.equal(result.sent, true); assert.equal(result.meta.queued, true); assert.equal(result.accepted, true);
  assert.equal(calls[0].crmEventSource, CRM_MILESTONE_SOURCE); assert.equal(calls[0].value, undefined);
  original.dependencies.google = () => { throw new Error('Google failed'); };
  assert.equal((await maybeUploadLeadLifecycleConversion(original)).meta.queued, true);
  original.dependencies.enqueueMeta = () => { throw new Error('queue failed'); };
  original.dependencies.google = async () => ({ sent: true });
  assert.equal((await maybeUploadLeadLifecycleConversion(original)).sent, true);
});

test('canonical qualification and booking hooks use the dispatcher; Purchase and reception stay independent', () => {
  const service = name => fs.readFileSync(path.join(__dirname, '../../services', name), 'utf8');
  assert.match(service('leadQualificationMilestone.service.js'), /require\('\.\/leadLifecycleConversion\.service'\)/);
  assert.match(service('appointmentLeadMilestone.service.js'), /require\('\.\/googleLeadLifecycleConversion\.service'\)/);
  assert.match(service('jobExecutor.service.js'), /campaign_meta_crm_signal:[\s\S]*runMetaLeadLifecycleSignalJob\(payload, jobRequest\)/);
  assert.doesNotMatch(service('metaLeadReception.service.js'), /sendWorkspaceMetaSignal|enqueueMetaLeadLifecycleSignal/);
});
