'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  consumeLandingPublishedEvent,
  sha256,
} = require('../../services/campaignDestinationBindings.service');

const IDS = Object.freeze({
  project: '11111111-1111-4111-8111-111111111111',
  publication: '22222222-2222-4222-8222-222222222222',
  revision: '33333333-3333-4333-8333-333333333333',
  artifact: '44444444-4444-4444-8444-444444444444',
  deployment: '55555555-5555-4555-8555-555555555555',
});
const DESTINATION = 'https://landing.example.test/implantes/';

function record(values) {
  return {
    ...values,
    get() { return { ...this }; },
    async update(patch) { Object.assign(this, patch); return this; },
  };
}

function harness(mode) {
  const bindings = [];
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
    mode_contract: { authorization },
    promotion_type: 'generic',
    scope: { assignment_scope: 'clinic', clinic_id: 66 },
    external_targets: [{ kind: 'generic', treatment_id: null, campaigns: [] }],
  };
  const models = {
    Campaign: { async findByPk(id) { return Number(id) === 91 ? record({ id: 91, clinica_id: 66 }) : null; } },
    CampaignRequest: { async findAll() { return [record({ id: 1, clinica_id: 66, solicitud: payload })]; } },
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
    },
    CampaignDestinationBindingAccount: {
      async findOne() { return null; },
      async create(values) { return record(values); },
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
    events,
    jobs,
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
