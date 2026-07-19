'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  consumeLandingPublishedEvent,
  requestDestinationApply,
  runDestinationApplyJob,
  sha256,
} = require('../../services/campaignDestinationBindings.service');

const IDS = Object.freeze({
  project: '11111111-1111-4111-8111-111111111111',
  publication: '22222222-2222-4222-8222-222222222222',
  revision: '33333333-3333-4333-8333-333333333333',
  artifact: '44444444-4444-4444-8444-444444444444',
  deployment: '55555555-5555-4555-8555-555555555555',
  managedCampaign: '66666666-6666-4666-8666-666666666666',
});
const DESTINATION = 'https://landing.example.test/implantes/';
const GOOGLE_CAMPAIGN = Object.freeze({
  provider: 'google_ads',
  customer_id: '1851215478',
  campaign_id: '21313059516',
  channel_type: 'SEARCH',
});

function record(values) {
  return {
    ...values,
    get() { return { ...this }; },
    async update(patch) { Object.assign(this, patch); return this; },
  };
}

function harness(mode, options = {}) {
  const bindings = [];
  const accounts = [];
  const events = [];
  const jobs = [];
  const authorization = {
    version: 1,
    accepted: true,
    accepted_at: '2026-07-18T09:00:00.000Z',
    accepted_by_user_id: 7,
    scopes: ['landing_publish', 'campaign_destination', 'conversion_goal'],
  };
  const payload = {
    kind: 'marketing_strategy',
    mode_snapshot: mode,
    status: options.status || 'active',
    mode_contract: { authorization },
    promotion_type: 'generic',
    scope: { assignment_scope: 'clinic', clinic_id: 66 },
    external_targets: [{
      kind: 'generic',
      treatment_id: null,
      campaigns: options.campaigns || [{ ...GOOGLE_CAMPAIGN }],
    }],
  };
  const campaign = record({
    id: 91,
    clinica_id: 66,
    activa: options.campaignActive ?? true,
    gestionada: options.campaignManaged ?? mode === 'managed_service',
  });
  const campaignRequest = record({
    id: 1,
    campaign_id: 91,
    clinica_id: 66,
    estado: options.requestStatus || 'activa',
    solicitud: payload,
  });
  const managedCampaign = record({
    id: IDS.managedCampaign,
    strategy_campaign_id: 91,
    provider: 'google_ads',
    family: 'google_search',
    operation_mode: 'managed',
    status: 'active',
    approved_by_user_id: 7,
    platform_refs: {
      customer_id: GOOGLE_CAMPAIGN.customer_id,
      campaign_id: GOOGLE_CAMPAIGN.campaign_id,
    },
    target_config: {},
  });
  const models = {
    Campaign: { async findByPk(id) { return Number(id) === 91 ? campaign : null; } },
    CampaignRequest: { async findAll() { return [campaignRequest]; } },
    ManagedCampaign: {
      async findAll() { return mode === 'managed_service' ? [managedCampaign] : []; },
      async findByPk(id) { return id === IDS.managedCampaign ? managedCampaign : null; },
    },
    WebProject: { async findByPk(id) { return id === IDS.project ? record({ id, purpose: 'landing', status: 'active', scopeType: 'clinic', clinicaId: 66, grupoClinicaId: null }) : null; } },
    WebPublication: { async findByPk(id) { return id === IDS.publication ? record({
      id, projectId: IDS.project, scopeType: 'clinic', clinicaId: 66, grupoClinicaId: null,
      host: 'landing.example.test', path: '/implantes/', status: 'published',
      activeRevisionId: IDS.revision, activeArtifactId: IDS.artifact, lastGoodArtifactId: IDS.artifact,
      health: { status: 'healthy' }, lastHealthyAt: new Date('2026-07-18T09:05:00.000Z'),
    }) : null; } },
    WebRevision: { async findByPk(id) { return id === IDS.revision ? record({ id, projectId: IDS.project, status: 'approved' }) : null; } },
    WebArtifact: { async findByPk(id) { return id === IDS.artifact ? record({
      id, projectId: IDS.project, revisionId: IDS.revision, environment: 'production', status: 'ready',
      baseUrl: 'https://landing.example.test/implantes',
    }) : null; } },
    WebPublicationDeployment: { async findOne() { return record({ id: IDS.deployment, publicationId: IDS.publication, artifactId: IDS.artifact, status: 'verified' }); } },
    CampaignDestinationBinding: {
      async findOne({ where }) {
        return bindings.find((item) => item.strategyId === where.strategyId
          && item.targetKind === where.targetKind
          && item.treatmentIdentity === where.treatmentIdentity) || null;
      },
      async create(values) { const item = record(values); bindings.push(item); return item; },
      async findByPk(id) { return bindings.find((item) => item.id === id) || null; },
    },
    CampaignDestinationBindingAccount: {
      async findOne({ where }) {
        return accounts.find((item) => item.bindingId === where.bindingId
          && item.provider === where.provider
          && item.customerId === where.customerId
          && item.campaignId === where.campaignId) || null;
      },
      async findByPk(id) { return accounts.find((item) => item.id === id) || null; },
      async findAll({ where }) {
        return accounts.filter((item) => !where?.bindingId || item.bindingId === where.bindingId);
      },
      async create(values) { const item = record(values); accounts.push(item); return item; },
    },
    CampaignDestinationBindingEvent: {
      async findOne({ where }) { return events.find((item) => item.eventId === where.eventId) || null; },
      async create(values) { const item = record(values); events.push(item); return item; },
    },
    JobRequest: {},
  };
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  return {
    bindings,
    accounts,
    events,
    jobs,
    payload,
    campaign,
    managedCampaign,
    setMode(nextMode) {
      payload.mode_snapshot = nextMode;
    },
    setStatus(nextStatus) {
      payload.status = nextStatus;
      campaignRequest.estado = nextStatus;
    },
    setCampaigns(nextCampaigns) {
      payload.external_targets[0].campaigns = nextCampaigns.map((item) => ({ ...item }));
    },
    dependencies: {
      models,
      sequelize: { async transaction(callback) { return callback(transaction); } },
      stableHttpsDestination(raw) { return { valid: true, url: new URL(raw).toString() }; },
      jobRequestsService: {
        async enqueueUniqueJobRequest(input) {
          const job = record({ id: jobs.length + 1, ...input });
          jobs.push(job);
          return { job, created: true };
        },
      },
    },
  };
}

function event() {
  return {
    event_id: `landing:${crypto.randomUUID()}`,
    occurred_at: '2026-07-18T09:05:00.000Z',
    strategy_id: 91,
    target_kind: 'general',
    treatment_id: null,
    publication_id: IDS.publication,
    project_id: IDS.project,
    revision_id: IDS.revision,
    artifact_id: IDS.artifact,
    destination_url: DESTINATION,
    destination_digest: sha256(DESTINATION),
    requested_by_user_id: 7,
  };
}

test('Mide y entiende records the verified landing but never enables destination mutation', async () => {
  const state = harness('connect_only');
  const result = await consumeLandingPublishedEvent(event(), state.dependencies);
  assert.equal(result.binding.mode, 'connect_only');
  assert.equal(result.binding.publication_status, 'verified');
  assert.equal(result.binding.destination_status, 'blocked');
  assert.equal(result.binding.capability_status, 'blocked');
  assert.equal(state.bindings[0].authorization.destination_mutation_allowed, false);
  assert.match(state.bindings[0].authorization.strategy_snapshot_digest, /^[a-f0-9]{64}$/);
  assert.equal(state.bindings[0].lastErrorCode, 'measure_mode_never_changes_destinations');
});

test('Mejora accepts the landing only with its bounded authorization and leaves it ready for explicit apply', async () => {
  const state = harness('guided_improvement');
  const result = await consumeLandingPublishedEvent(event(), state.dependencies);
  assert.equal(result.binding.mode, 'guided_improvement');
  assert.equal(result.binding.destination_status, 'ready');
  assert.equal(result.binding.capability_status, 'ready');
  assert.deepEqual(state.bindings[0].authorization.strategy_authorization.scopes, [
    'landing_publish', 'campaign_destination',
  ]);
  assert.match(state.bindings[0].authorization.strategy_snapshot_digest, /^[a-f0-9]{64}$/);
  assert.equal(state.bindings[0].authorization.destination_mutation_allowed, true);
  assert.equal(state.jobs.length, 1);
});

test('Piloto automatico records a verified destination without weakening its managed gates', async () => {
  const state = harness('managed_service');
  const result = await consumeLandingPublishedEvent(event(), state.dependencies);
  assert.equal(result.binding.mode, 'managed_service');
  assert.equal(result.binding.destination_status, 'ready');
  assert.equal(result.binding.capability_status, 'ready');
  assert.equal(state.bindings[0].authorization.strategy_authorization, null);
  assert.equal(state.bindings[0].authorization.destination_mutation_allowed, true);
});

test('a completed or paused strategy cannot publish a new campaign landing', async (t) => {
  for (const scenario of [
    { status: 'completed', requestStatus: 'finalizada' },
    { status: 'paused', requestStatus: 'pausada' },
  ]) {
    await t.test(scenario.status, async () => {
      const state = harness('guided_improvement', scenario);
      await assert.rejects(
        consumeLandingPublishedEvent(event(), state.dependencies),
        (error) => error?.code === 'campaign_destination_strategy_not_active'
      );
      assert.equal(state.bindings.length, 0);
      assert.equal(state.accounts.length, 0);
      assert.equal(state.jobs.length, 0);
    });
  }
});

test('explicit apply rejects a changed mode or campaign cohort without enqueueing provider work', async (t) => {
  for (const scenario of [
    {
      name: 'mode changed after publication',
      mutate(state) { state.setMode('connect_only'); },
    },
    {
      name: 'campaign cohort changed after publication',
      mutate(state) {
        state.setCampaigns([{ ...GOOGLE_CAMPAIGN, campaign_id: '99999999999' }]);
      },
    },
  ]) {
    await t.test(scenario.name, async () => {
      const state = harness('guided_improvement');
      const published = await consumeLandingPublishedEvent(event(), state.dependencies);
      const queuedBefore = state.jobs.length;
      scenario.mutate(state);
      await assert.rejects(
        requestDestinationApply({
          bindingId: published.binding.id,
          accounts: [{
            provider: GOOGLE_CAMPAIGN.provider,
            customer_id: GOOGLE_CAMPAIGN.customer_id,
            campaign_id: GOOGLE_CAMPAIGN.campaign_id,
          }],
          confirmation: {
            operation_id: `operation:${crypto.randomUUID()}`,
            destination_digest: sha256(DESTINATION),
            accepted: true,
            readback_required: true,
            confirm_destination_change: true,
            scopes: ['landing_publish', 'campaign_destination'],
          },
          actorUserId: 7,
        }, state.dependencies),
        (error) => error?.code === 'campaign_destination_strategy_changed'
      );
      assert.equal(state.jobs.length, queuedBefore);
      assert.equal(state.events.filter((item) => item.eventType === 'apply_requested').length, 0);
    });
  }
});

test('worker revalidates the strategy after dequeue and before any provider operation', async () => {
  const state = harness('guided_improvement');
  const published = await consumeLandingPublishedEvent(event(), state.dependencies);
  await requestDestinationApply({
    bindingId: published.binding.id,
    accounts: [{
      provider: GOOGLE_CAMPAIGN.provider,
      customer_id: GOOGLE_CAMPAIGN.customer_id,
      campaign_id: GOOGLE_CAMPAIGN.campaign_id,
    }],
    confirmation: {
      operation_id: `operation:${crypto.randomUUID()}`,
      destination_digest: sha256(DESTINATION),
      accepted: true,
      readback_required: true,
      confirm_destination_change: true,
      scopes: ['landing_publish', 'campaign_destination'],
    },
    actorUserId: 7,
  }, state.dependencies);

  const applyJob = state.jobs.find((item) => item.type === 'marketing_campaign.destination_apply.v1');
  assert.ok(applyJob);
  let adapterSelected = 0;
  let providerReads = 0;
  let providerWrites = 0;
  state.dependencies.adapterFor = () => {
    adapterSelected += 1;
    // Simulate a strategy completion in the narrow race after the worker's
    // first transactional preparation but before it touches Google Ads.
    state.setStatus('completed');
    return {
      async inspect() { providerReads += 1; return {}; },
      async mutate() { providerWrites += 1; return {}; },
      verifyState() { return { verified: true, observed: {} }; },
    };
  };

  const result = await runDestinationApplyJob(applyJob.payload, state.dependencies);
  assert.equal(result.status, 'completed');
  assert.equal(result.result.blocked, true);
  assert.equal(result.result.provider_mutation, false);
  assert.equal(result.result.error_code, 'campaign_destination_strategy_not_active');
  assert.equal(adapterSelected, 1);
  assert.equal(providerReads, 0);
  assert.equal(providerWrites, 0);
  assert.equal(state.accounts[0].state, 'blocked');
  assert.equal(state.bindings[0].destinationStatus, 'blocked');
});

test('worker never applies an obsolete destination if the binding changes during provider validation', async () => {
  const state = harness('guided_improvement');
  const published = await consumeLandingPublishedEvent(event(), state.dependencies);
  await requestDestinationApply({
    bindingId: published.binding.id,
    accounts: [{
      provider: GOOGLE_CAMPAIGN.provider,
      customer_id: GOOGLE_CAMPAIGN.customer_id,
      campaign_id: GOOGLE_CAMPAIGN.campaign_id,
    }],
    confirmation: {
      operation_id: `operation:${crypto.randomUUID()}`,
      destination_digest: sha256(DESTINATION),
      accepted: true,
      readback_required: true,
      confirm_destination_change: true,
      scopes: ['landing_publish', 'campaign_destination'],
    },
    actorUserId: 7,
  }, state.dependencies);

  const applyJob = state.jobs.find((item) => item.type === 'marketing_campaign.destination_apply.v1');
  assert.ok(applyJob);
  let validateOnlyWrites = 0;
  let realWrites = 0;
  state.dependencies.adapterFor = () => ({
    async inspect() { return { final_url: 'https://example.test/old/' }; },
    async mutate({ validateOnly }) {
      if (validateOnly) {
        validateOnlyWrites += 1;
        state.bindings[0].version += 1;
        state.bindings[0].destinationDigest = sha256('https://landing.example.test/nueva/');
        state.accounts[0].operationDigest = sha256('new-operation');
        state.accounts[0].applyEventId = crypto.randomUUID();
        state.accounts[0].state = 'apply_queued';
      } else {
        realWrites += 1;
      }
      return {};
    },
    verifyState() { return { verified: true, observed: {} }; },
  });

  const result = await runDestinationApplyJob(applyJob.payload, state.dependencies);
  assert.equal(result.status, 'completed');
  assert.equal(result.result.superseded, true);
  assert.equal(result.result.provider_mutation, false);
  assert.equal(result.result.error_code, 'campaign_destination_apply_superseded');
  assert.equal(validateOnlyWrites, 1);
  assert.equal(realWrites, 0);
  assert.equal(state.accounts[0].state, 'apply_queued');
});

test('two campaign workers sharing one binding complete without superseding each other', async () => {
  const secondCampaign = { ...GOOGLE_CAMPAIGN, campaign_id: '23904134805' };
  const state = harness('guided_improvement', { campaigns: [{ ...GOOGLE_CAMPAIGN }, secondCampaign] });
  const published = await consumeLandingPublishedEvent(event(), state.dependencies);
  await requestDestinationApply({
    bindingId: published.binding.id,
    accounts: [GOOGLE_CAMPAIGN, secondCampaign],
    confirmation: {
      operation_id: `operation:${crypto.randomUUID()}`,
      destination_digest: sha256(DESTINATION),
      accepted: true,
      readback_required: true,
      confirm_destination_change: true,
      scopes: ['landing_publish', 'campaign_destination'],
    },
    actorUserId: 7,
  }, state.dependencies);

  const providerState = new Map(state.accounts.map((account) => [
    account.campaignId,
    { final_url: `https://example.test/original-${account.campaignId}/` },
  ]));
  state.dependencies.adapterFor = (account) => ({
    async inspect() { return providerState.get(account.campaignId); },
    async mutate({ destinationUrl, validateOnly }) {
      if (!validateOnly) providerState.set(account.campaignId, { final_url: destinationUrl });
      return {};
    },
    verifyState({ state: observed, destinationUrl }) {
      return { verified: observed?.final_url === destinationUrl, observed };
    },
  });

  const jobs = state.jobs.filter((item) => item.type === 'marketing_campaign.destination_apply.v1');
  assert.equal(jobs.length, 2);
  for (const job of jobs) {
    const result = await runDestinationApplyJob(job.payload, state.dependencies);
    assert.equal(result.status, 'completed');
    assert.equal(result.result.readback_verified, true);
    assert.notEqual(result.result.superseded, true);
  }
  assert.deepEqual(state.accounts.map((account) => account.state), ['active', 'active']);
  assert.equal(state.bindings[0].destinationStatus, 'active');
  assert.equal(state.jobs.filter((item) => item.type === 'marketing_campaign.destination_rollback.v1').length, 0);
});

test('autopilot revocation during validateOnly blocks the real provider mutation', async () => {
  const state = harness('managed_service');
  const published = await consumeLandingPublishedEvent(event(), state.dependencies);
  await requestDestinationApply({
    bindingId: published.binding.id,
    accounts: [GOOGLE_CAMPAIGN],
    confirmation: {
      operation_id: `operation:${crypto.randomUUID()}`,
      destination_digest: sha256(DESTINATION),
    },
    actorUserId: 7,
  }, state.dependencies);

  const applyJob = state.jobs.find((item) => item.type === 'marketing_campaign.destination_apply.v1');
  assert.ok(applyJob);
  let validateOnlyWrites = 0;
  let realWrites = 0;
  state.dependencies.adapterFor = () => ({
    async inspect() { return { final_url: 'https://example.test/original/' }; },
    async mutate({ validateOnly }) {
      if (validateOnly) {
        validateOnlyWrites += 1;
        state.managedCampaign.status = 'completed';
        state.managedCampaign.approved_by_user_id = null;
      } else {
        realWrites += 1;
      }
      return {};
    },
    verifyState() { return { verified: true, observed: {} }; },
  });

  const result = await runDestinationApplyJob(applyJob.payload, state.dependencies);
  assert.equal(result.status, 'completed');
  assert.equal(result.result.blocked, true);
  assert.equal(result.result.provider_mutation, false);
  assert.equal(result.result.error_code, 'campaign_destination_autopilot_not_approved');
  assert.equal(validateOnlyWrites, 1);
  assert.equal(realWrites, 0);
});
