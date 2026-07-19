'use strict';

process.env.MARKETING_WEB_RUNTIME_ENVELOPE_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.MARKETING_WEB_RUNTIME_ENVELOPE_KEY_ID = 'runtime-test-v1';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const reconciliation = require('../../services/webIntakeRuntimeReconciliation.service');
const {
  shouldUseExecutionTimeout,
} = require('../../lib/jobExecutionTimeoutPolicy');
const {
  decryptRuntimeSecret,
  encryptRuntimeSecret,
} = require('../../lib/webRuntimeSecretEnvelope');
const {
  authenticatePublicIntakeRequest,
  pickMatchingIntakeConfig,
} = require('../../lib/intakePublicAuthentication');
const {
  resolveEffectivePublicIntakeRecords,
} = require('../../services/webEffectiveIntakeConfig.service');

const OLD_KEY = 'old-runtime-hmac-key-1234567890';
const MID_KEY = 'middle-runtime-hmac-key-2468135790';
const NEW_KEY = 'new-runtime-hmac-key-0987654321';

function sealTestReconciliation(value) {
  const sealed = { ...value };
  for (const slot of ['source', 'target']) {
    const plainField = `${slot}HmacKey`;
    if (!Object.prototype.hasOwnProperty.call(sealed, plainField)) continue;
    sealed[`${slot}HmacEnvelope`] = encryptRuntimeSecret(sealed[plainField], {
      id: sealed.id,
      scopeType: sealed.scopeType,
      scopeId: sealed.scopeId,
      generation: sealed.generation,
      slot,
    });
    delete sealed[plainField];
  }
  return sealed;
}

function readTestSecret(value, slot) {
  return decryptRuntimeSecret(value[`${slot}HmacEnvelope`], {
    id: value.id,
    scopeType: value.scopeType,
    scopeId: value.scopeId,
    generation: value.generation,
    slot,
  });
}

function sign(key, body) {
  return crypto.createHmac('sha256', key).update(body).digest('hex');
}

function intake({
  id = 7,
  scope = 'clinic',
  scopeId = 55,
  hmac = OLD_KEY,
  chat = false,
  locations = undefined,
} = {}) {
  const config = {
    features: {
      consent_mode_enabled: true,
      consent_provider: 'clinicaclick',
      chat_enabled: chat,
      whatsapp_enabled: chat,
      tel_modal_enabled: false,
    },
  };
  if (locations !== undefined) config.locations = locations;
  return {
    id,
    assignment_scope: scope,
    clinic_id: scope === 'clinic' ? scopeId : null,
    group_id: scope === 'group' ? scopeId : null,
    config,
    hmac_key: hmac,
  };
}

function row(value) {
  return {
    ...value,
    get() { return { ...this }; },
    async update(patch) { Object.assign(this, patch); return this; },
  };
}

function sequelizeStub() {
  return {
    async transaction(callback) {
      return callback({ LOCK: { UPDATE: 'UPDATE' } });
    },
  };
}

function artifact({ id, projectId = 'project-1', revisionId = 'revision-1', runtimeHash, marker = 'a' }) {
  const artifactHash = marker.repeat(64);
  const artifactInputHash = marker === 'f' ? 'e'.repeat(64) : String.fromCharCode(marker.charCodeAt(0) + 1).repeat(64);
  return {
    id,
    projectId,
    revisionId,
    artifactHash,
    runtimeConfigHash: runtimeHash,
    environment: 'production',
    status: 'ready',
    manifest: {
      project_id: projectId,
      revision_id: revisionId,
      artifact_hash: artifactHash,
      artifact_input_hash: artifactInputHash,
      runtime_config_hash: runtimeHash,
    },
  };
}

async function testDualRuntimeAuthenticationUsesMatchingFeatures() {
  const source = intake({ chat: false });
  const target = intake({ hmac: NEW_KEY, chat: true });
  const record = sealTestReconciliation({
    id: '11111111-1111-4111-8111-111111111111',
    scopeType: 'clinic',
    scopeId: 55,
    generation: 1,
    status: 'deploying',
    targetHmacKey: NEW_KEY,
    sourceHmacKey: OLD_KEY,
    targetConfigPatch: reconciliation.runtimeConfigPatch(target),
    sourceConfigPatch: reconciliation.runtimeConfigPatch(source),
    graceExpiresAt: null,
  });
  const models = {
    WebIntakeRuntimeReconciliation: { findOne: async () => record },
  };
  const candidates = await reconciliation.authenticationCandidatesForConfig(source, { models });
  const wrapped = { ...source, runtime_transition_candidates: candidates };
  const rawBody = Buffer.from('{"lead":"test"}', 'utf8');
  const oldReq = { rawBody, headers: { 'x-cc-signature': sign(OLD_KEY, rawBody) } };
  const newReq = { rawBody, headers: { 'x-cc-signature': sign(NEW_KEY, rawBody) } };
  const oldMatch = pickMatchingIntakeConfig({ req: oldReq, clinicCfg: wrapped });
  const newMatch = pickMatchingIntakeConfig({ req: newReq, clinicCfg: wrapped });
  assert.equal(oldMatch.hmac_key, OLD_KEY);
  assert.equal(oldMatch.config.features.chat_enabled, false);
  assert.equal(newMatch.hmac_key, NEW_KEY);
  assert.equal(newMatch.config.features.chat_enabled, true);

  record.status = 'grace';
  record.graceExpiresAt = new Date(Date.now() + 60_000);
  const promoted = target;
  const graceCandidates = await reconciliation.authenticationCandidatesForConfig(promoted, { models });
  const graceWrapped = { ...promoted, runtime_transition_candidates: graceCandidates };
  assert.equal(
    pickMatchingIntakeConfig({ req: oldReq, clinicCfg: graceWrapped }).config.features.chat_enabled,
    false
  );
  assert.equal(
    pickMatchingIntakeConfig({ req: newReq, clinicCfg: graceWrapped }).config.features.chat_enabled,
    true
  );
}

async function testInheritedPublicAuthenticationBeforeDuringAndAfterGrace() {
  const sourceGroup = intake({
    scope: 'group', scopeId: 5, hmac: OLD_KEY, chat: false, locations: [{ id: 55 }],
  });
  const targetGroup = intake({
    scope: 'group', scopeId: 5, hmac: NEW_KEY, chat: true, locations: [{ id: 55 }],
  });
  const direct = intake({ scope: 'clinic', scopeId: 55, hmac: OLD_KEY, chat: false });
  direct.domains = ['clinic.example'];
  direct.config.campaigns = { mode: 'measure' };
  direct.config.runtime_inheritance = { schema_version: 1, scope_type: 'group', scope_id: 5 };
  let currentGroup = sourceGroup;
  let activeReconciliation = null;
  const models = {
    Clinica: { findByPk: async () => ({ grupoClinicaId: 5 }) },
    IntakeConfig: {
      findOne: async ({ where }) => (where.assignment_scope === 'group' ? currentGroup : direct),
    },
    WebIntakeRuntimeReconciliation: { findOne: async () => activeReconciliation },
  };
  const body = Buffer.from('{"lead":"natural"}', 'utf8');
  const authenticate = async (key) => {
    const resolved = await resolveEffectivePublicIntakeRecords({
      domainCfg: direct,
      models,
    });
    assert.deepEqual(resolved.clinicCfg.config.campaigns, { mode: 'measure' });
    const transitionCandidates = await reconciliation.authenticationCandidatesForConfig(
      resolved.clinicCfg,
      { models }
    );
    const owner = {
      ...resolved.clinicCfg,
      runtime_transition_candidates: transitionCandidates,
    };
    const req = { rawBody: body, headers: { 'x-cc-signature': sign(key, body) } };
    return authenticatePublicIntakeRequest({
      req,
      config: pickMatchingIntakeConfig({ req, clinicCfg: owner, groupCfg: resolved.groupCfg }),
    });
  };

  assert.equal((await authenticate(OLD_KEY)).ok, true);
  assert.equal((await authenticate(NEW_KEY)).ok, false);

  activeReconciliation = sealTestReconciliation({
    id: '33333333-3333-4333-8333-333333333333',
    scopeType: 'group', scopeId: 5, generation: 2, status: 'deploying',
    sourceHmacKey: OLD_KEY, targetHmacKey: NEW_KEY,
    sourceConfigPatch: reconciliation.runtimeConfigPatch(sourceGroup),
    targetConfigPatch: reconciliation.runtimeConfigPatch(targetGroup),
    graceExpiresAt: null,
  });
  assert.equal((await authenticate(OLD_KEY)).ok, true);
  assert.equal((await authenticate(NEW_KEY)).ok, true);

  currentGroup = targetGroup;
  activeReconciliation.status = 'grace';
  activeReconciliation.targetHmacEnvelope = null;
  activeReconciliation.graceExpiresAt = new Date(Date.now() + 60_000);
  assert.equal((await authenticate(OLD_KEY)).ok, true);
  assert.equal((await authenticate(NEW_KEY)).ok, true);

  activeReconciliation.graceExpiresAt = new Date(Date.now() - 1_000);
  assert.equal((await authenticate(OLD_KEY)).ok, false);
  assert.equal((await authenticate(NEW_KEY)).ok, true);
}

async function testGroupEffectiveScopeAcrossInstallationsAndChannels() {
  const source = intake({
    scope: 'group', scopeId: 5, hmac: OLD_KEY, locations: [{ id: 55 }],
  });
  const target = intake({
    scope: 'group', scopeId: 5, hmac: NEW_KEY, chat: true, locations: [{ id: 55 }, { id: 56 }],
  });
  const publications = [
    { id: 'p-group', scopeType: 'group', grupoClinicaId: 5, channel: 'wordpress', wordpressInstallationId: 'wp-a' },
    { id: 'p-55', scopeType: 'clinic', clinicaId: 55, channel: 'wordpress', wordpressInstallationId: 'wp-a' },
    { id: 'p-56', scopeType: 'clinic', clinicaId: 56, channel: 'wordpress', wordpressInstallationId: 'wp-b' },
    { id: 'p-57', scopeType: 'clinic', clinicaId: 57, channel: 'clinicaclick_hosted' },
    { id: 'p-58', scopeType: 'clinic', clinicaId: 58, channel: 'custom' },
  ];
  const models = { IntakeConfig: { findAll: async () => [] } };
  const plans = await reconciliation.effectiveRuntimePlans({
    scope: { type: 'group', id: 5 },
    sourceRecord: source,
    targetRecord: target,
    publications,
    models,
  });
  const byId = new Map(plans.map((plan) => [plan.publication.id, plan]));
  assert.equal(byId.get('p-group').target_runtime.measurement.hmac_key, NEW_KEY);
  assert.equal(byId.get('p-55').target_runtime.measurement.hmac_key, NEW_KEY);
  assert.equal(byId.get('p-56').source_runtime.measurement.enabled, false);
  assert.equal(byId.get('p-56').target_runtime.measurement.hmac_key, NEW_KEY);
  assert.equal(byId.get('p-57').target_runtime.measurement.enabled, false);
  assert.equal(byId.get('p-58').target_runtime.measurement.enabled, false);
  assert.deepEqual(
    [...new Set(plans.filter((plan) => plan.target_runtime.measurement.enabled)
      .map((plan) => plan.publication.wordpressInstallationId).filter(Boolean))].sort(),
    ['wp-a', 'wp-b']
  );
}

async function testDesiredWordpressRuntimeUsesPluginMeasurementContract() {
  const source = intake({ hmac: OLD_KEY, chat: false });
  const target = intake({ hmac: NEW_KEY, chat: true });
  const installationId = '77777777-7777-4777-8777-777777777777';
  const publication = {
    id: 'wordpress-runtime-publication',
    scopeType: 'clinic',
    clinicaId: 55,
    channel: 'wordpress',
    wordpressInstallationId: installationId,
  };
  const transition = sealTestReconciliation({
    id: '88888888-8888-4888-8888-888888888888',
    generation: 1,
    status: 'deploying',
    scopeType: 'clinic',
    scopeId: 55,
    sourceConfigPatch: reconciliation.runtimeConfigPatch(source),
    targetConfigPatch: reconciliation.runtimeConfigPatch(target),
    sourceHmacKey: OLD_KEY,
    targetHmacKey: NEW_KEY,
    expectedDeployments: {
      [publication.id]: {
        publication_id: publication.id,
        installation_id: installationId,
      },
    },
  });
  const models = {
    WebIntakeRuntimeReconciliation: { findAll: async () => [transition] },
    WebPublication: { findByPk: async () => publication },
    IntakeConfig: {
      findOne: async () => source,
      findAll: async () => [],
    },
  };
  const expectedKeys = [
    'enabled',
    'scope_type',
    'scope_id',
    'loader_path',
    'hmac_key',
    'consent_mode_enabled',
    'consent_provider',
    'chat_enabled',
    'whatsapp_enabled',
    'phone_enabled',
  ].sort();

  const deploying = await reconciliation.desiredRuntimeForInstallation({
    installation: { id: installationId },
    models,
  });
  assert.deepEqual(Object.keys(deploying.measurement).sort(), expectedKeys);
  assert.equal(deploying.measurement.loader_path, '/assets/loader.js');
  assert.equal(Object.prototype.hasOwnProperty.call(deploying.measurement, 'api_url'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(deploying.measurement, 'loader_url'), false);
  assert.equal(deploying.measurement.hmac_key === NEW_KEY, true);
  assert.equal(deploying.measurement.chat_enabled, true);
  assert.equal(deploying.runtime.runtime_config_hash, reconciliation.runtimeHashForRecord(target));

  transition.status = 'rolling_back';
  const rollingBack = await reconciliation.desiredRuntimeForInstallation({
    installation: { id: installationId },
    models,
  });
  assert.deepEqual(Object.keys(rollingBack.measurement).sort(), expectedKeys);
  assert.equal(rollingBack.measurement.loader_path, '/assets/loader.js');
  assert.equal(Object.prototype.hasOwnProperty.call(rollingBack.measurement, 'api_url'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(rollingBack.measurement, 'loader_url'), false);
  assert.equal(rollingBack.measurement.hmac_key === OLD_KEY, true);
  assert.equal(rollingBack.measurement.chat_enabled, false);
  assert.equal(rollingBack.runtime.runtime_config_hash, reconciliation.runtimeHashForRecord(source));
}

async function testMaterializedClinicFollowsSubsequentGroupRuntime() {
  const source = intake({
    scope: 'group', scopeId: 5, hmac: OLD_KEY, chat: false, locations: [{ id: 55 }],
  });
  const target = intake({
    scope: 'group', scopeId: 5, hmac: NEW_KEY, chat: true, locations: [{ id: 55 }],
  });
  const materialized = {
    ...intake({ scope: 'clinic', scopeId: 55, hmac: OLD_KEY, chat: false }),
    config: {
      ...source.config,
      campaigns: { google_ads: { connected: true } },
      runtime_inheritance: { schema_version: 1, scope_type: 'group', scope_id: 5 },
    },
  };
  const plans = await reconciliation.effectiveRuntimePlans({
    scope: { type: 'group', id: 5 },
    sourceRecord: source,
    targetRecord: target,
    publications: [{
      id: 'p-materialized', scopeType: 'clinic', clinicaId: 55,
      channel: 'clinicaclick_hosted',
    }],
    models: { IntakeConfig: { findAll: async () => [materialized] } },
  });
  assert.equal(plans[0].source_runtime.measurement.hmac_key, OLD_KEY);
  assert.equal(plans[0].target_runtime.measurement.hmac_key, NEW_KEY);
  assert.equal(plans[0].target_runtime.measurement.chat_enabled, true);
}

async function testHistoricalTransparentClinicRowFollowsGroupRotation() {
  const source = intake({
    scope: 'group', scopeId: 5, hmac: OLD_KEY, chat: false, locations: [{ id: 55 }],
  });
  const target = intake({
    scope: 'group', scopeId: 5, hmac: NEW_KEY, chat: true, locations: [{ id: 55 }],
  });
  const historical = {
    assignment_scope: 'clinic', clinic_id: 55, hmac_key: null,
    config: { campaigns: { mode: 'measure' }, meta: { connected: true }, chat: { greeting: 'Hola' } },
  };
  const [plan] = await reconciliation.effectiveRuntimePlans({
    scope: { type: 'group', id: 5 },
    sourceRecord: source,
    targetRecord: target,
    publications: [{
      id: 'p-historical', scopeType: 'clinic', clinicaId: 55,
      channel: 'clinicaclick_hosted',
    }],
    models: { IntakeConfig: { findAll: async () => [historical] } },
  });
  assert.equal(plan.source_effective, source);
  assert.equal(plan.target_effective, target);
  assert.equal(plan.source_runtime.measurement.hmac_key, OLD_KEY);
  assert.equal(plan.target_runtime.measurement.hmac_key, NEW_KEY);
}

async function testInheritedNonRuntimeCreateMaterializesRuntimeWithoutRollout() {
  const group = intake({
    scope: 'group', scopeId: 5, hmac: OLD_KEY, chat: true, locations: [{ id: 55 }],
  });
  const candidate = {
    assignment_scope: 'clinic',
    clinic_id: 55,
    group_id: null,
    config: { campaigns: { google_ads: { connected: true } } },
    hmac_key: null,
  };
  let publicationsRead = 0;
  let queued = 0;
  let persisted = null;
  const models = {
    Clinica: { findByPk: async () => ({ grupoClinicaId: 5 }) },
    IntakeConfig: { findOne: async () => group },
    WebPublication: { findAll: async () => { publicationsRead += 1; return []; } },
  };
  const result = await reconciliation.stageCandidateWrite({
    candidate,
    sourceRecord: null,
    models,
    options: { enqueueUniqueJobRequest: async () => { queued += 1; } },
    setCandidate: (value) => { persisted = value; },
  });
  assert.equal(result.gated, false);
  assert.equal(result.reason, 'inherited_runtime_materialized');
  assert.equal(publicationsRead, 0);
  assert.equal(queued, 0);
  assert.equal(persisted.assignment_scope, 'clinic');
  assert.equal(persisted.hmac_key, OLD_KEY);
  assert.equal(persisted.config.features.chat_enabled, true);
  assert.deepEqual(persisted.config.campaigns, candidate.config.campaigns);
  assert.deepEqual(persisted.config.runtime_inheritance, {
    schema_version: 1, scope_type: 'group', scope_id: 5,
  });
  assert.equal(
    reconciliation.runtimeHashForRecord(persisted),
    reconciliation.runtimeHashForRecord(group)
  );
}

async function testUnrelatedWriteDuringDeploymentDoesNotStartAnotherGeneration() {
  const source = intake();
  source.config.campaigns = { google_ads: { state: 'old' } };
  const candidate = JSON.parse(JSON.stringify(source));
  candidate.config.campaigns.google_ads.state = 'new';
  let persisted = null;
  const result = await reconciliation.stageCandidateWrite({
    candidate,
    sourceRecord: source,
    models: {
      WebPublication: { findAll: async () => { throw new Error('runtime gate must not run'); } },
    },
    setCandidate: (value) => { persisted = value; },
  });
  assert.equal(result.gated, false);
  assert.equal(result.reason, 'runtime_unchanged');
  assert.equal(persisted.config.campaigns.google_ads.state, 'new');
}

async function testFullMaterializedInstanceNonRuntimeWritePreservesInheritance() {
  const source = intake({ scope: 'clinic', scopeId: 55, hmac: OLD_KEY, chat: true });
  source.config.runtime_inheritance = { schema_version: 1, scope_type: 'group', scope_id: 5 };
  source.config.campaigns = { google_ads: { state: 'old' } };
  const currentGroup = intake({
    scope: 'group', scopeId: 5, hmac: OLD_KEY, chat: true, locations: [{ id: 55 }],
  });
  const candidate = JSON.parse(JSON.stringify(source));
  candidate.config.campaigns.google_ads.state = 'new';
  let persisted = null;
  const result = await reconciliation.stageCandidateWrite({
    candidate,
    sourceRecord: source,
    models: {
      Clinica: { findByPk: async () => ({ grupoClinicaId: 5 }) },
      IntakeConfig: { findOne: async () => currentGroup },
      WebPublication: { findAll: async () => { throw new Error('runtime gate must not run'); } },
    },
    setCandidate: (value) => { persisted = value; },
  });
  assert.equal(result.gated, false);
  assert.equal(result.reason, 'inherited_runtime_refreshed');
  assert.deepEqual(persisted.config.runtime_inheritance, source.config.runtime_inheritance);
  assert.equal(persisted.config.campaigns.google_ads.state, 'new');
}

async function testClinicOverrideAfterGroupRotationUsesCurrentGroupAsSource() {
  const staleA = intake({ scope: 'clinic', scopeId: 55, hmac: OLD_KEY, chat: false });
  staleA.config.campaigns = { mode: 'measure' };
  staleA.config.runtime_inheritance = { schema_version: 1, scope_type: 'group', scope_id: 5 };
  const currentB = intake({
    scope: 'group', scopeId: 5, hmac: MID_KEY, chat: true, locations: [{ id: 55 }],
  });
  const clinicC = JSON.parse(JSON.stringify(staleA));
  clinicC.hmac_key = NEW_KEY;
  clinicC.config.features.chat_enabled = false;
  clinicC.config.features.tel_modal_enabled = true;
  const publication = {
    id: 'publication-b', scopeType: 'clinic', clinicaId: 55,
    status: 'published', activeArtifactId: 'artifact-b', channel: 'clinicaclick_hosted',
  };
  const artifactB = artifact({
    id: 'artifact-b', runtimeHash: reconciliation.runtimeHashForRecord(currentB), marker: 'b',
  });
  let stored = null;
  let persistedCandidate = null;
  const models = {
    GrupoClinica: { findByPk: async () => ({ id_grupo: 5 }) },
    Clinica: {
      findByPk: async () => ({ grupoClinicaId: 5 }),
      findAll: async () => [{ id_clinica: 55 }],
    },
    IntakeConfig: {
      findOne: async ({ where }) => (where.assignment_scope === 'group' ? currentB : staleA),
      findAll: async () => [staleA],
    },
    WebPublication: { findAll: async () => [publication] },
    WebArtifact: { findAll: async () => [artifactB] },
    WebIntakeRuntimeReconciliation: {
      findOne: async ({ where }) => (where.status ? null : stored),
      create: async (values) => { stored = row(values); return stored; },
    },
    JobRequest: {},
  };
  const result = await reconciliation.stageCandidateWrite({
    candidate: clinicC,
    sourceRecord: staleA,
    models,
    sequelize: {},
    options: {
      transaction: { LOCK: { UPDATE: 'UPDATE' } },
      enqueueUniqueJobRequest: async () => ({ created: true }),
    },
    setCandidate: (value) => { persistedCandidate = value; },
  });
  assert.equal(result.gated, true);
  assert.equal(
    decryptRuntimeSecret(stored.sourceHmacEnvelope, {
      id: stored.id, scopeType: stored.scopeType, scopeId: stored.scopeId,
      generation: stored.generation, slot: 'source',
    }),
    MID_KEY,
    'el source durable debe ser B, no la materialización obsoleta A'
  );
  assert.equal(stored.sourceConfigPatch.features.chat_enabled.value, true);
  assert.equal(stored.targetConfigPatch.features.tel_modal_enabled.value, true);
  assert.equal(persistedCandidate.hmac_key, MID_KEY);
  assert.equal(persistedCandidate.config.campaigns.mode, 'measure');
  assert.equal(persistedCandidate.config.runtime_inheritance.scope_id, 5);
}

async function testGroupAndClinicRuntimeTransitionsCannotOverlap() {
  const source = intake({ scope: 'clinic', scopeId: 55, hmac: OLD_KEY, chat: false });
  const candidate = intake({ scope: 'clinic', scopeId: 55, hmac: NEW_KEY, chat: true });
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  await assert.rejects(
    reconciliation.stageCandidateWrite({
      candidate,
      sourceRecord: source,
      options: { transaction },
      models: {
        GrupoClinica: { findByPk: async () => ({ id_grupo: 5 }) },
        Clinica: {
          findByPk: async () => ({ grupoClinicaId: 5 }),
          findAll: async () => [{ id_clinica: 55 }, { id_clinica: 56 }],
        },
        WebIntakeRuntimeReconciliation: {
          findOne: async () => ({
            id: 'group-transition', scopeType: 'group', scopeId: 5, status: 'deploying',
          }),
        },
      },
      setCandidate: () => { throw new Error('overlap must fail before mutation'); },
    }),
    (error) => error.code === 'web_intake_runtime_overlapping_transition'
  );
}

async function testHistoricalTransparentDirectRowRepairsInheritedRuntime() {
  const group = intake({
    scope: 'group', scopeId: 5, hmac: OLD_KEY, chat: true, locations: [{ id: 55 }],
  });
  const direct = {
    id: 99, assignment_scope: 'clinic', clinic_id: 55, group_id: null,
    config: { meta_ads: { connected: true } }, hmac_key: null,
  };
  const candidate = JSON.parse(JSON.stringify(direct));
  candidate.config.meta_ads.last_sync = 'now';
  let persisted = null;
  const result = await reconciliation.stageCandidateWrite({
    candidate,
    sourceRecord: direct,
    models: {
      Clinica: { findByPk: async () => ({ grupoClinicaId: 5 }) },
      IntakeConfig: { findOne: async () => group },
    },
    setCandidate: (value) => { persisted = value; },
  });
  assert.equal(result.reason, 'inherited_runtime_materialized');
  assert.equal(persisted.hmac_key, OLD_KEY);
  assert.equal(persisted.config.features.chat_enabled, true);
  assert.equal(persisted.config.meta_ads.last_sync, 'now');
  assert.equal(persisted.config.runtime_inheritance.scope_id, 5);
}

async function testOutboxIsIdempotentAndContainsNoSecret() {
  const source = intake();
  const target = intake({ hmac: NEW_KEY, chat: true });
  let stored = null;
  const queued = [];
  const Model = {
    async findOne() { return stored; },
    async create(values) { stored = row(values); return stored; },
  };
  const models = {
    WebIntakeRuntimeReconciliation: Model,
    JobRequest: {},
  };
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const enqueueUniqueJobRequest = async (input) => {
    queued.push(input);
    return { job: { id: queued.length }, created: queued.length === 1 };
  };
  const first = await reconciliation.persistReconciliation({
    scope: { type: 'clinic', id: 55 }, sourceRecord: source, targetRecord: target,
    models, sequelize: {}, transaction, enqueueUniqueJobRequest,
  });
  const second = await reconciliation.persistReconciliation({
    scope: { type: 'clinic', id: 55 }, sourceRecord: source, targetRecord: target,
    models, sequelize: {}, transaction, enqueueUniqueJobRequest,
  });
  assert.equal(first.generation, 1);
  assert.equal(second.generation, 1);
  assert.equal(queued[0].dedupeScope, queued[1].dedupeScope);
  const persisted = JSON.stringify(stored);
  assert.equal(persisted.includes(OLD_KEY), false);
  assert.equal(persisted.includes(NEW_KEY), false);
  assert.equal(Object.prototype.hasOwnProperty.call(stored, 'sourceHmacEnvelope'), true);
  assert.equal(Object.prototype.hasOwnProperty.call(stored, 'targetHmacEnvelope'), true);
  assert.equal(Object.prototype.hasOwnProperty.call(stored, 'sourceHmacKey'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(stored, 'targetHmacKey'), false);
  for (const input of queued) {
    const serialized = JSON.stringify(input.payload);
    assert.equal(serialized.includes(OLD_KEY), false);
    assert.equal(serialized.includes(NEW_KEY), false);
    assert.equal(Object.prototype.hasOwnProperty.call(input.payload, 'config'), false);
  }
}

async function testOneOfNCompilationFailureDoesNotSwitchAnything() {
  const runtime = reconciliation.runtimeForRecord(intake({ hmac: NEW_KEY }));
  const plans = [1, 2].map((index) => ({
    publication: {
      id: `p-${index}`,
      projectId: `project-${index}`,
      activeRevisionId: `revision-${index}`,
      activeArtifactId: `old-${index}`,
      version: 1,
      status: 'published',
      channel: 'clinicaclick_hosted',
      host: `clinic-${index}.example`,
      path: '/',
      configuration: { clinic_id: 55 },
      scopeType: 'clinic',
      clinicaId: 55,
      updatedByUserId: 9,
    },
    target_runtime: runtime,
  }));
  const artifacts = new Map([1, 2].map((index) => [`old-${index}`, {
    id: `old-${index}`,
    revisionId: `revision-${index}`,
    runtimeConfigHash: '0'.repeat(64),
    createdByUserId: 9,
  }]));
  let compiles = 0;
  let switches = 0;
  const models = {
    sequelize: {},
    WebProject: { findByPk: async (id) => ({ id, createdByUserId: 9 }) },
    WebArtifact: {
      findByPk: async (id) => ({
        id,
        runtimeConfigHash: runtime.runtime_config_hash,
        status: 'ready',
      }),
    },
    WebPublication: { findAll: async () => [] },
    IntakeConfig: { update: async () => { switches += 1; } },
    WebPublicationDeployment: { create: async () => { switches += 1; } },
  };
  await assert.rejects(
    reconciliation.prepareArtifacts({
      reconciliation: { id: 'r-1' },
      generation: 1,
      plans,
      artifacts,
      models,
      compileRevisionFn: async ({ revisionId }) => {
        compiles += 1;
        if (revisionId === 'revision-2') throw new Error('compiler failed');
        return {
          id: 'new-1', artifact_hash: 'a'.repeat(64), runtime_config_hash: runtime.runtime_config_hash,
          manifest: {}, files: {},
        };
      },
      storeArtifactBundleFn: async () => ({}),
    }),
    /compiler failed/
  );
  assert.equal(compiles, 2);
  assert.equal(switches, 0);
}

async function testCommitUsesExactLockedPublicationInstanceAfterPlainPlanning() {
  const source = intake({ hmac: OLD_KEY, chat: false });
  const target = intake({ hmac: NEW_KEY, chat: true });
  const sourceRuntime = reconciliation.runtimeForRecord(source);
  const targetRuntime = reconciliation.runtimeForRecord(target);
  const sourceArtifact = artifact({
    id: 'locked-source', revisionId: 'revision-source', runtimeHash: sourceRuntime.runtime_config_hash, marker: 'a',
  });
  const targetArtifact = artifact({
    id: 'locked-target', revisionId: 'revision-target', runtimeHash: targetRuntime.runtime_config_hash, marker: 'c',
  });
  const transition = row(sealTestReconciliation({
    id: '99999999-9999-4999-8999-999999999999',
    generation: 1,
    status: 'preparing',
    scopeType: 'clinic',
    scopeId: 55,
    sourceRuntimeHash: sourceRuntime.runtime_config_hash,
    sourceRuntimeFingerprint: reconciliation.runtimeFingerprintForRecord(source),
    targetRuntimeHash: targetRuntime.runtime_config_hash,
    targetRuntimeFingerprint: reconciliation.runtimeFingerprintForRecord(target),
    sourceConfigPatch: reconciliation.runtimeConfigPatch(source),
    targetConfigPatch: reconciliation.runtimeConfigPatch(target),
    sourceHmacKey: OLD_KEY,
    targetHmacKey: NEW_KEY,
    expectedDeployments: {},
  }));
  const publicationState = {
    id: 'locked-publication',
    projectId: 'project-1',
    activeRevisionId: sourceArtifact.revisionId,
    activeArtifactId: sourceArtifact.id,
    status: 'published',
    version: 3,
    channel: 'clinicaclick_hosted',
    host: 'clinic.example',
    path: '/',
    configuration: { clinic_id: 55 },
    scopeType: 'clinic',
    clinicaId: 55,
    updatedByUserId: 9,
  };
  const publicationUpdates = [];
  const lockedPublication = {
    ...publicationState,
    get() {
      return Object.freeze({ ...publicationState });
    },
    async update(patch) {
      publicationUpdates.push(patch);
      Object.assign(publicationState, patch);
      Object.assign(this, patch);
      return this;
    },
  };
  let lockedPublicationReads = 0;
  let createdDeployment = null;
  const models = {
    WebIntakeRuntimeReconciliation: { findByPk: async () => transition },
    IntakeConfig: {
      findOne: async () => row(source),
      findAll: async () => [],
    },
    WebPublication: {
      findAll: async (query = {}) => {
        if (query.lock) lockedPublicationReads += 1;
        return [lockedPublication];
      },
    },
    WebArtifact: {
      findAll: async () => [sourceArtifact],
      findByPk: async (id) => (id === targetArtifact.id ? targetArtifact : null),
    },
    WebPublicationDeployment: {
      findOne: async () => null,
      create: async (values) => {
        createdDeployment = row(values);
        return createdDeployment;
      },
    },
    WebAuditEvent: { create: async () => ({}) },
    JobRequest: {},
  };
  const prepared = [{
    publication_id: publicationState.id,
    installation_id: null,
    project_id: publicationState.projectId,
    revision_id: targetArtifact.revisionId,
    previous_artifact_id: sourceArtifact.id,
    publication_version: publicationState.version,
    actor_id: 9,
    artifact_id: targetArtifact.id,
    artifact_hash: targetArtifact.artifactHash,
    runtime_config_hash: targetRuntime.runtime_config_hash,
    storage: {
      runtime_reconciliation: reconciliation.preparedRuntimeMarker(transition, 1),
    },
  }];

  const result = await reconciliation.commitPreparedRuntime({
    reconciliationId: transition.id,
    generation: 1,
    prepared,
    models,
    sequelize: sequelizeStub(),
    enqueueJobRequest: async () => ({ id: 'locked-publication-job' }),
  });

  assert.equal(result.deployments.length, 1);
  assert.equal(lockedPublicationReads, 1);
  assert.equal(publicationUpdates.length, 2);
  assert.equal(publicationUpdates[0].status, 'pending');
  assert.equal(publicationUpdates[0].version, 4);
  assert.equal(publicationUpdates[1].jobRequestId, 'locked-publication-job');
  assert.equal(createdDeployment.jobRequestId, 'locked-publication-job');
  assert.equal(transition.status, 'deploying');
}

async function testPromotionWaitsForEveryVerifiedDeployment() {
  const source = intake();
  const target = intake({ hmac: NEW_KEY, chat: true });
  const expected = {
    p1: { publication_id: 'p1', deployment_id: 'd1', artifact_id: 'a1' },
    p2: { publication_id: 'p2', deployment_id: 'd2', artifact_id: 'a2' },
  };
  const reconciliationRow = row(sealTestReconciliation({
    id: '11111111-1111-4111-8111-111111111111',
    generation: 1,
    status: 'deploying',
    scopeType: 'clinic',
    scopeId: 55,
    sourceRuntimeHash: reconciliation.runtimeHashForRecord(source),
    sourceRuntimeFingerprint: reconciliation.runtimeFingerprintForRecord(source),
    targetRuntimeHash: reconciliation.runtimeHashForRecord(target),
    targetRuntimeFingerprint: reconciliation.runtimeFingerprintForRecord(target),
    sourceConfigPatch: reconciliation.runtimeConfigPatch(source),
    targetConfigPatch: reconciliation.runtimeConfigPatch(target),
    sourceHmacKey: OLD_KEY,
    targetHmacKey: NEW_KEY,
    expectedDeployments: expected,
  }));
  const intakeRow = row(source);
  let secondStatus = 'running';
  const lockOrder = [];
  const models = {
    WebIntakeRuntimeReconciliation: {
      findByPk: async (_id, options = {}) => {
        lockOrder.push(options.lock ? 'reconciliation_lock' : 'reconciliation_probe');
        return reconciliationRow;
      },
    },
    WebPublicationDeployment: {
      findAll: async () => {
        lockOrder.push('deployment_lock');
        return [
          { id: 'd1', status: 'verified', artifactId: 'a1' },
          { id: 'd2', status: secondStatus, artifactId: 'a2' },
        ];
      },
    },
    WebPublication: {
      findAll: async (query = {}) => {
        lockOrder.push(query.lock ? 'publication_lock' : 'publication_probe');
        return [
          { id: 'p1', status: 'published', activeArtifactId: 'a1' },
          { id: 'p2', status: 'published', activeArtifactId: 'a2' },
        ];
      },
    },
    IntakeConfig: { findOne: async () => { lockOrder.push('intake_lock'); return intakeRow; } },
  };
  const waiting = await reconciliation.finalizeReconciliation({
    reconciliationId: reconciliationRow.id,
    generation: 1,
    models,
    sequelize: sequelizeStub(),
  });
  assert.equal(waiting.waiting, true);
  assert.deepEqual(lockOrder.slice(0, 3), [
    'reconciliation_probe', 'intake_lock', 'reconciliation_lock',
  ]);
  assert.ok(lockOrder.indexOf('publication_lock') < lockOrder.indexOf('deployment_lock'));
  assert.equal(intakeRow.hmac_key, OLD_KEY);
  secondStatus = 'verified';
  const promoted = await reconciliation.finalizeReconciliation({
    reconciliationId: reconciliationRow.id,
    generation: 1,
    models,
    sequelize: sequelizeStub(),
  });
  assert.equal(promoted.promoted, true);
  assert.equal(intakeRow.hmac_key, NEW_KEY);
  assert.equal(reconciliationRow.status, 'grace');
  assert.equal(readTestSecret(reconciliationRow, 'source'), OLD_KEY);
  assert.equal(reconciliationRow.targetHmacEnvelope, null);
}

async function testArtifactIdentitySelectsSameHmacFeatureRuntime() {
  const source = intake({ hmac: OLD_KEY, chat: false });
  const target = intake({ hmac: OLD_KEY, chat: true });
  const sourceRuntime = reconciliation.runtimeForRecord(source);
  const targetRuntime = reconciliation.runtimeForRecord(target);
  const sourceArtifact = artifact({ id: 'artifact-source', runtimeHash: sourceRuntime.runtime_config_hash, marker: 'a' });
  const targetArtifact = artifact({ id: 'artifact-target', runtimeHash: targetRuntime.runtime_config_hash, marker: 'c' });
  const publication = {
    id: 'publication-1', projectId: 'project-1', channel: 'clinicaclick_hosted',
    activeArtifactId: sourceArtifact.id, status: 'publishing',
  };
  let deploymentStatus = 'running';
  const transition = sealTestReconciliation({
    id: '11111111-1111-4111-8111-111111111111',
    scopeType: 'clinic', scopeId: 55, generation: 1, status: 'deploying',
    sourceHmacKey: OLD_KEY, targetHmacKey: OLD_KEY,
    sourceConfigPatch: reconciliation.runtimeConfigPatch(source),
    targetConfigPatch: reconciliation.runtimeConfigPatch(target),
    expectedDeployments: {
      [publication.id]: {
        publication_id: publication.id,
        deployment_id: 'deployment-1',
        artifact_id: targetArtifact.id,
        artifact_hash: targetArtifact.artifactHash,
      },
    },
  });
  const models = {
    WebIntakeRuntimeReconciliation: { findAll: async () => [transition] },
    WebPublicationDeployment: {
      findByPk: async () => ({
        id: 'deployment-1', artifactId: targetArtifact.id,
        previousArtifactId: sourceArtifact.id, status: deploymentStatus,
      }),
    },
  };
  const oldPage = await reconciliation.runtimeCandidateForPublicationArtifact({
    intake: source, publication, artifact: sourceArtifact, models,
  });
  assert.equal(oldPage.role, 'source');
  assert.equal(oldPage.intake.config.features.chat_enabled, false);
  const earlyTarget = await reconciliation.runtimeCandidateForPublicationArtifact({
    intake: source, publication, artifact: targetArtifact, models,
  });
  assert.equal(earlyTarget, null);

  deploymentStatus = 'verified';
  const liveTarget = await reconciliation.runtimeCandidateForPublicationArtifact({
    intake: source, publication, artifact: targetArtifact, models,
  });
  assert.equal(liveTarget.role, 'target');
  assert.equal(liveTarget.intake.hmac_key, OLD_KEY);
  assert.equal(liveTarget.intake.config.features.chat_enabled, true);

  publication.channel = 'custom';
  const customSource = await reconciliation.runtimeCandidateForPublicationArtifact({
    intake: source, publication, artifact: sourceArtifact, models,
  });
  const customTarget = await reconciliation.runtimeCandidateForPublicationArtifact({
    intake: source, publication, artifact: targetArtifact, models,
  });
  assert.equal(customSource.role, 'source');
  assert.equal(customTarget.role, 'target');

  transition.status = 'grace';
  transition.graceExpiresAt = new Date(Date.now() + 60_000);
  const inFlightOldPage = await reconciliation.runtimeCandidateForPublicationArtifact({
    intake: target, publication: { ...publication, activeArtifactId: targetArtifact.id },
    artifact: sourceArtifact, models,
  });
  assert.equal(inFlightOldPage.role, 'source');
  assert.equal(inFlightOldPage.intake.config.features.chat_enabled, false);
}

async function testContentOnlyDeploymentAcceptsOnlyExactHostedOrCustomArtifact() {
  const committed = intake({ hmac: OLD_KEY, chat: false });
  const runtimeHash = reconciliation.runtimeHashForRecord(committed);
  const sourceArtifact = artifact({ id: 'content-source', runtimeHash, marker: 'a' });
  const targetArtifact = artifact({ id: 'content-target', revisionId: 'revision-2', runtimeHash, marker: 'c' });
  const unrelatedArtifact = artifact({ id: 'content-unrelated', revisionId: 'revision-0', runtimeHash, marker: 'e' });
  const changedRuntimeArtifact = artifact({
    id: 'content-runtime-drift', revisionId: 'revision-2',
    runtimeHash: reconciliation.runtimeHashForRecord(intake({ hmac: NEW_KEY, chat: true })), marker: 'g',
  });
  const publication = {
    id: 'content-publication', projectId: 'project-1', channel: 'clinicaclick_hosted',
    activeArtifactId: sourceArtifact.id, desiredRevisionId: targetArtifact.revisionId,
    status: 'publishing',
  };
  let deployment = {
    id: 'content-deployment', publicationId: publication.id,
    revisionId: targetArtifact.revisionId, artifactId: targetArtifact.id,
    action: 'publish', status: 'running', sequence: 2,
  };
  const models = {
    WebIntakeRuntimeReconciliation: { findAll: async () => [] },
    WebPublicationDeployment: { findOne: async () => deployment },
  };

  const source = await reconciliation.runtimeCandidateForPublicationArtifact({
    intake: committed, publication, artifact: sourceArtifact, models,
  });
  assert.equal(source.role, 'current');
  const target = await reconciliation.runtimeCandidateForPublicationArtifact({
    intake: committed, publication, artifact: targetArtifact, models,
  });
  assert.equal(target.role, 'deployment_target');
  assert.equal(target.intake.hmac_key, OLD_KEY);
  assert.equal(await reconciliation.runtimeCandidateForPublicationArtifact({
    intake: committed, publication, artifact: unrelatedArtifact, models,
  }), null);

  deployment = { ...deployment, artifactId: changedRuntimeArtifact.id };
  assert.equal(await reconciliation.runtimeCandidateForPublicationArtifact({
    intake: committed, publication, artifact: changedRuntimeArtifact, models,
  }), null);

  deployment = { ...deployment, artifactId: targetArtifact.id };
  publication.channel = 'custom_domain';
  assert.equal((await reconciliation.runtimeCandidateForPublicationArtifact({
    intake: committed, publication, artifact: targetArtifact, models,
  })).role, 'deployment_target');
  publication.channel = 'wordpress';
  assert.equal(await reconciliation.runtimeCandidateForPublicationArtifact({
    intake: committed, publication, artifact: targetArtifact, models,
  }), null);
}

async function testWordpressTargetRequiresStableRouteAcknowledgement() {
  const source = intake({ hmac: OLD_KEY, chat: false });
  const target = intake({ hmac: OLD_KEY, chat: true });
  const sourceArtifact = artifact({
    id: 'wp-source', runtimeHash: reconciliation.runtimeHashForRecord(source), marker: 'a',
  });
  const targetArtifact = artifact({
    id: 'wp-target', runtimeHash: reconciliation.runtimeHashForRecord(target), marker: 'c',
  });
  const publication = {
    id: 'wp-publication', projectId: 'project-1', channel: 'wordpress', path: '/cita/',
    wordpressInstallationId: 'wp-1', activeArtifactId: sourceArtifact.id,
  };
  const transition = sealTestReconciliation({
    id: '22222222-2222-4222-8222-222222222222',
    scopeType: 'clinic', scopeId: 55, generation: 1, status: 'deploying',
    sourceHmacKey: OLD_KEY, targetHmacKey: OLD_KEY,
    sourceConfigPatch: reconciliation.runtimeConfigPatch(source),
    targetConfigPatch: reconciliation.runtimeConfigPatch(target),
    expectedDeployments: {
      [publication.id]: {
        publication_id: publication.id, deployment_id: 'wp-deployment',
        artifact_id: targetArtifact.id, artifact_hash: targetArtifact.artifactHash,
      },
    },
  });
  const installation = {
    id: 'wp-1', status: 'connected', pluginVersion: '2.0.0-alpha.8', desiredSequence: 9,
    capabilities: { multi_publication_v2: true },
    reportedState: {
      confirmed_routes: {
        [publication.id]: {
          status: 'active', route_prefix: '/cita/', registry_sequence: 8,
          artifact_hash: targetArtifact.artifactHash,
        },
      },
    },
  };
  const models = {
    WebIntakeRuntimeReconciliation: { findAll: async () => [transition] },
    WebPublicationDeployment: {
      findByPk: async () => ({
        id: 'wp-deployment', artifactId: targetArtifact.id,
        previousArtifactId: sourceArtifact.id, status: 'running',
      }),
    },
    WebWordpressInstallation: { findByPk: async () => installation },
  };
  assert.equal((await reconciliation.transitionContextForPublication({ publication, models })).target_confirmed, false);
  installation.reportedState.confirmed_routes[publication.id].registry_sequence = 9;
  assert.equal((await reconciliation.transitionContextForPublication({ publication, models })).target_confirmed, true);
}

async function testAlpha7SameHmacRuntimeChangeFailsClosed() {
  const source = intake({ hmac: OLD_KEY, chat: false });
  const target = intake({ hmac: OLD_KEY, chat: true });
  const targetRuntime = reconciliation.runtimeForRecord(target);
  const publication = {
    id: 'wp-alpha7', projectId: 'project-1', activeRevisionId: 'revision-1',
    activeArtifactId: 'source-alpha7', status: 'published', channel: 'wordpress',
    wordpressInstallationId: 'installation-alpha7', host: 'clinic.example', path: '/cita/',
    configuration: { clinic_id: 55 }, scopeType: 'clinic', clinicaId: 55,
    updatedByUserId: 9, version: 1,
  };
  await assert.rejects(
    reconciliation.prepareArtifacts({
      reconciliation: { id: 'reconciliation-alpha7' },
      generation: 1,
      plans: [{
        publication,
        source_effective: source,
        target_effective: target,
        target_runtime: targetRuntime,
      }],
      artifacts: new Map([['source-alpha7', {
        id: 'source-alpha7', revisionId: 'revision-1', runtimeConfigHash: reconciliation.runtimeHashForRecord(source),
      }]]),
      models: {
        WebWordpressInstallation: {
          findByPk: async () => ({
            id: 'installation-alpha7', pluginVersion: '2.0.0-alpha.7', capabilities: {},
          }),
        },
      },
    }),
    (error) => error.code === 'web_intake_runtime_exact_artifact_plugin_update_required'
  );
}

async function testSingleDeploymentPromotionSchedulesGraceCleanup() {
  const source = intake();
  const target = intake({ hmac: NEW_KEY, chat: true });
  const transition = row(sealTestReconciliation({
    id: '33333333-3333-4333-8333-333333333333',
    generation: 1, status: 'deploying', scopeType: 'clinic', scopeId: 55,
    sourceRuntimeHash: reconciliation.runtimeHashForRecord(source),
    sourceRuntimeFingerprint: reconciliation.runtimeFingerprintForRecord(source),
    targetRuntimeHash: reconciliation.runtimeHashForRecord(target),
    targetRuntimeFingerprint: reconciliation.runtimeFingerprintForRecord(target),
    sourceConfigPatch: reconciliation.runtimeConfigPatch(source),
    targetConfigPatch: reconciliation.runtimeConfigPatch(target),
    sourceHmacKey: OLD_KEY, targetHmacKey: NEW_KEY,
    expectedDeployments: {
      p1: { publication_id: 'p1', deployment_id: 'd1', artifact_id: 'a1' },
    },
  }));
  const intakeRow = row(source);
  const models = {
    WebIntakeRuntimeReconciliation: { findByPk: async () => transition },
    IntakeConfig: { findOne: async () => intakeRow },
    WebPublicationDeployment: {
      findAll: async () => [{ id: 'd1', status: 'verified', artifactId: 'a1' }],
    },
    WebPublication: {
      findAll: async () => [{ id: 'p1', status: 'published', activeArtifactId: 'a1' }],
    },
  };
  const result = await reconciliation.runIntakeRuntimeReconciliationJob({
    reconciliation_id: transition.id, generation: 1,
  }, null, { models, sequelize: sequelizeStub() });
  assert.equal(result.status, 'waiting');
  assert.equal(transition.status, 'grace');
  assert.ok(result.nextAllowedAt instanceof Date);
  assert.equal(intakeRow.hmac_key, NEW_KEY);
}

async function testSameHmacPromotionKeepsExactSourceArtifactGrace() {
  const source = intake({ hmac: OLD_KEY, chat: false });
  const target = intake({ hmac: OLD_KEY, chat: true });
  const sourceArtifact = artifact({
    id: 'same-key-source', runtimeHash: reconciliation.runtimeHashForRecord(source), marker: 'a',
  });
  const targetArtifact = artifact({
    id: 'same-key-target', runtimeHash: reconciliation.runtimeHashForRecord(target), marker: 'c',
  });
  const publication = {
    id: 'same-key-publication', projectId: 'project-1', channel: 'clinicaclick_hosted',
    status: 'published', activeArtifactId: targetArtifact.id,
  };
  const deployment = {
    id: 'same-key-deployment', status: 'verified', artifactId: targetArtifact.id,
    previousArtifactId: sourceArtifact.id,
  };
  const transition = row(sealTestReconciliation({
    id: '55555555-5555-4555-8555-555555555555',
    generation: 1, status: 'deploying', scopeType: 'clinic', scopeId: 55,
    sourceRuntimeHash: reconciliation.runtimeHashForRecord(source),
    sourceRuntimeFingerprint: reconciliation.runtimeFingerprintForRecord(source),
    targetRuntimeHash: reconciliation.runtimeHashForRecord(target),
    targetRuntimeFingerprint: reconciliation.runtimeFingerprintForRecord(target),
    sourceConfigPatch: reconciliation.runtimeConfigPatch(source),
    targetConfigPatch: reconciliation.runtimeConfigPatch(target),
    sourceHmacKey: OLD_KEY, targetHmacKey: OLD_KEY,
    expectedDeployments: {
      [publication.id]: {
        publication_id: publication.id,
        deployment_id: deployment.id,
        artifact_id: targetArtifact.id,
        artifact_hash: targetArtifact.artifactHash,
      },
    },
  }));
  const intakeRow = row(source);
  const models = {
    WebIntakeRuntimeReconciliation: {
      findByPk: async () => transition,
      findAll: async () => [transition],
    },
    IntakeConfig: { findOne: async () => intakeRow },
    WebPublicationDeployment: {
      findAll: async () => [deployment],
      findByPk: async () => deployment,
    },
    WebPublication: { findAll: async () => [publication] },
  };
  const promoted = await reconciliation.finalizeReconciliation({
    reconciliationId: transition.id,
    generation: 1,
    models,
    sequelize: sequelizeStub(),
  });
  assert.equal(promoted.promoted, true);
  assert.equal(transition.status, 'grace');
  assert.equal(readTestSecret(transition, 'source'), OLD_KEY);
  const oldTab = await reconciliation.runtimeCandidateForPublicationArtifact({
    intake: intakeRow,
    publication,
    artifact: sourceArtifact,
    models,
  });
  assert.equal(oldTab.role, 'source');
  assert.equal(oldTab.intake.config.features.chat_enabled, false);
}

async function testPartialTargetFailureRollsBackAndUnblocksScope() {
  const source = intake();
  const target = intake({ hmac: NEW_KEY, chat: true });
  const sourceArtifact = artifact({
    id: 'rollback-source', runtimeHash: reconciliation.runtimeHashForRecord(source), marker: 'a',
  });
  const targetArtifact = artifact({
    id: 'rollback-target', runtimeHash: reconciliation.runtimeHashForRecord(target), marker: 'c',
  });
  const transition = row(sealTestReconciliation({
    id: '44444444-4444-4444-8444-444444444444',
    generation: 1, status: 'deploying', scopeType: 'clinic', scopeId: 55,
    sourceRuntimeHash: reconciliation.runtimeHashForRecord(source),
    sourceRuntimeFingerprint: reconciliation.runtimeFingerprintForRecord(source),
    targetRuntimeHash: reconciliation.runtimeHashForRecord(target),
    targetRuntimeFingerprint: reconciliation.runtimeFingerprintForRecord(target),
    sourceConfigPatch: reconciliation.runtimeConfigPatch(source),
    targetConfigPatch: reconciliation.runtimeConfigPatch(target),
    sourceHmacKey: OLD_KEY, targetHmacKey: NEW_KEY,
    expectedDeployments: {
      p1: {
        publication_id: 'p1', deployment_id: 'target-deployment',
        artifact_id: targetArtifact.id, artifact_hash: targetArtifact.artifactHash,
      },
    },
  }));
  const intakeRow = row(source);
  const publication = row({
    id: 'p1', projectId: 'project-1', scopeType: 'clinic', clinicaId: 55,
    channel: 'clinicaclick_hosted', status: 'published', version: 2,
    activeArtifactId: targetArtifact.id, updatedByUserId: 9,
  });
  const targetDeployment = {
    id: 'target-deployment', publicationId: 'p1', status: 'failed', action: 'publish',
    artifactId: targetArtifact.id,
    projectId: 'project-1', revisionId: targetArtifact.revisionId,
    previousArtifactId: sourceArtifact.id, actorUserId: 9, sequence: 1,
    storage: { runtime_reconciliation: {
      reconciliation_id: transition.id, generation: 1,
    } },
    result: { runtime_reconciliation: {
      reconciliation_id: transition.id, generation: 1,
    } },
  };
  let rollbackDeployment = null;
  let rollbackJob = null;
  const models = {
    WebIntakeRuntimeReconciliation: { findByPk: async () => transition },
    IntakeConfig: {
      findOne: async () => intakeRow,
      findAll: async () => [source],
    },
    WebPublicationDeployment: {
      findAll: async () => (
        transition.status === 'deploying' ? [targetDeployment] : (rollbackDeployment ? [rollbackDeployment] : [])
      ),
      findOne: async () => targetDeployment,
      findByPk: async (id) => (String(id) === String(rollbackDeployment?.id) ? rollbackDeployment : null),
      create: async (values) => {
        rollbackDeployment = row(values);
        return rollbackDeployment;
      },
    },
    WebPublication: { findAll: async () => [publication] },
    WebArtifact: { findByPk: async (id) => (id === sourceArtifact.id ? sourceArtifact : targetArtifact) },
    JobRequest: {},
  };
  const rollingBack = await reconciliation.finalizeReconciliation({
    reconciliationId: transition.id,
    generation: 1,
    models,
    sequelize: sequelizeStub(),
    enqueueJobRequest: async () => {
      rollbackJob = { id: 'rollback-job', status: 'pending' };
      return rollbackJob;
    },
  });
  assert.equal(rollingBack.rolling_back, true);
  assert.equal(transition.status, 'rolling_back');
  assert.equal(rollbackDeployment.action, 'rollback');
  assert.equal(rollbackDeployment.artifactId, sourceArtifact.id);
  assert.equal(rollbackDeployment.storage.runtime_reconciliation.role, 'source_rollback');
  assert.equal(rollbackJob.id, 'rollback-job');
  assert.equal(intakeRow.hmac_key, OLD_KEY);

  rollbackDeployment.status = 'verified';
  publication.status = 'published';
  publication.activeArtifactId = sourceArtifact.id;
  const completed = await reconciliation.finalizeReconciliation({
    reconciliationId: transition.id,
    generation: 1,
    models,
    sequelize: sequelizeStub(),
  });
  assert.equal(completed.rolled_back, true);
  assert.equal(transition.status, 'completed');
  assert.equal(transition.sourceHmacEnvelope, null);
  assert.equal(transition.targetHmacEnvelope, null);
}

async function testIrrecoverableSourceDriftDoesNotRetryForever() {
  const source = intake({ hmac: OLD_KEY, chat: false });
  const target = intake({ hmac: NEW_KEY, chat: true });
  const current = intake({ hmac: 'third-runtime-hmac-key-123456789', chat: false });
  const transition = row(sealTestReconciliation({
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    generation: 1,
    status: 'pending',
    scopeType: 'clinic',
    scopeId: 55,
    sourceRuntimeHash: reconciliation.runtimeHashForRecord(source),
    sourceRuntimeFingerprint: reconciliation.runtimeFingerprintForRecord(source),
    targetRuntimeHash: reconciliation.runtimeHashForRecord(target),
    targetRuntimeFingerprint: reconciliation.runtimeFingerprintForRecord(target),
    sourceConfigPatch: reconciliation.runtimeConfigPatch(source),
    targetConfigPatch: reconciliation.runtimeConfigPatch(target),
    sourceHmacKey: OLD_KEY,
    targetHmacKey: NEW_KEY,
    expectedDeployments: {},
  }));
  const models = {
    WebIntakeRuntimeReconciliation: { findByPk: async () => transition },
    IntakeConfig: { findOne: async () => current },
  };
  const result = await reconciliation.runIntakeRuntimeReconciliationJob({
    reconciliation_id: transition.id,
    generation: 1,
  }, null, { models, sequelize: sequelizeStub() });
  assert.equal(result.status, 'failed');
  assert.equal(result.retryable, false);
  assert.equal(result.error.code, 'web_intake_runtime_source_changed');
  assert.equal(transition.status, 'completed');
  assert.equal(transition.sourceHmacEnvelope, null);
  assert.equal(transition.targetHmacEnvelope, null);
}

async function testFinalizeInvariantFailureIsPersistedAndDeadlockKeepsDeploying() {
  const intakeRow = row(intake());
  const invariant = row({
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    generation: 1,
    status: 'deploying',
    scopeType: 'clinic',
    scopeId: 55,
    expectedDeployments: {},
  });
  const invariantResult = await reconciliation.runIntakeRuntimeReconciliationJob({
    reconciliation_id: invariant.id,
    generation: 1,
  }, null, {
    models: {
      WebIntakeRuntimeReconciliation: { findByPk: async () => invariant },
      IntakeConfig: { findOne: async () => intakeRow },
    },
    sequelize: sequelizeStub(),
  });
  assert.equal(invariantResult.status, 'failed');
  assert.equal(invariantResult.retryable, false);
  assert.equal(invariant.status, 'failed');
  assert.equal(invariant.lastErrorCode, 'web_intake_runtime_expected_deployments_missing');

  const transient = row({
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    generation: 1,
    status: 'deploying',
    scopeType: 'clinic',
    scopeId: 55,
    expectedDeployments: {
      p1: { publication_id: 'p1', deployment_id: 'd1', artifact_id: 'a1' },
    },
  });
  const transientResult = await reconciliation.runIntakeRuntimeReconciliationJob({
    reconciliation_id: transient.id,
    generation: 1,
  }, null, {
    models: {
      WebIntakeRuntimeReconciliation: { findByPk: async () => transient },
      IntakeConfig: { findOne: async () => intakeRow },
      WebPublication: { findAll: async () => { throw new Error('ER_LOCK_DEADLOCK'); } },
    },
    sequelize: sequelizeStub(),
  });
  assert.equal(transientResult.status, 'failed');
  assert.equal(transientResult.retryable, true);
  assert.equal(transient.status, 'deploying');
}

async function testFailedGenerationIsNotReusedAndLongReconcileHasNoGlobalTimeout() {
  const source = intake();
  const target = intake({ hmac: NEW_KEY, chat: true });
  const failed = row(sealTestReconciliation({
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    generation: 3,
    status: 'failed',
    scopeType: 'clinic',
    scopeId: 55,
    targetRuntimeHash: reconciliation.runtimeHashForRecord(target),
    targetRuntimeFingerprint: reconciliation.runtimeFingerprintForRecord(target),
    targetConfigPatch: reconciliation.runtimeConfigPatch(target),
    targetHmacKey: NEW_KEY,
    expectedDeployments: { p1: { deployment_id: 'failed-deployment' } },
  }));
  await assert.rejects(
    reconciliation.persistReconciliation({
      scope: { type: 'clinic', id: 55 },
      sourceRecord: source,
      targetRecord: target,
      models: {
        WebIntakeRuntimeReconciliation: { findOne: async () => failed },
        JobRequest: {},
      },
      sequelize: {},
      transaction: { LOCK: { UPDATE: 'UPDATE' } },
      enqueueUniqueJobRequest: async () => { throw new Error('must not enqueue failed generation'); },
    }),
    (error) => error.code === 'web_intake_runtime_reconciliation_in_progress'
  );
  assert.equal(shouldUseExecutionTimeout('web_intake_runtime_reconcile'), false);
  assert.equal(shouldUseExecutionTimeout('web_publication_deploy'), true);
}

async function run() {
  const tests = [
    testDualRuntimeAuthenticationUsesMatchingFeatures,
    testInheritedPublicAuthenticationBeforeDuringAndAfterGrace,
    testGroupEffectiveScopeAcrossInstallationsAndChannels,
    testDesiredWordpressRuntimeUsesPluginMeasurementContract,
    testMaterializedClinicFollowsSubsequentGroupRuntime,
    testHistoricalTransparentClinicRowFollowsGroupRotation,
    testInheritedNonRuntimeCreateMaterializesRuntimeWithoutRollout,
    testHistoricalTransparentDirectRowRepairsInheritedRuntime,
    testUnrelatedWriteDuringDeploymentDoesNotStartAnotherGeneration,
    testFullMaterializedInstanceNonRuntimeWritePreservesInheritance,
    testClinicOverrideAfterGroupRotationUsesCurrentGroupAsSource,
    testGroupAndClinicRuntimeTransitionsCannotOverlap,
    testOutboxIsIdempotentAndContainsNoSecret,
    testOneOfNCompilationFailureDoesNotSwitchAnything,
    testCommitUsesExactLockedPublicationInstanceAfterPlainPlanning,
    testPromotionWaitsForEveryVerifiedDeployment,
    testArtifactIdentitySelectsSameHmacFeatureRuntime,
    testContentOnlyDeploymentAcceptsOnlyExactHostedOrCustomArtifact,
    testWordpressTargetRequiresStableRouteAcknowledgement,
    testAlpha7SameHmacRuntimeChangeFailsClosed,
    testSingleDeploymentPromotionSchedulesGraceCleanup,
    testSameHmacPromotionKeepsExactSourceArtifactGrace,
    testPartialTargetFailureRollsBackAndUnblocksScope,
    testIrrecoverableSourceDriftDoesNotRetryForever,
    testFinalizeInvariantFailureIsPersistedAndDeadlockKeepsDeploying,
    testFailedGenerationIsNotReusedAndLongReconcileHasNoGlobalTimeout,
  ];
  for (const test of tests) {
    await test();
    console.log(`✓ ${test.name}`);
  }
  console.log(`\n${tests.length} web intake runtime reconciliation tests passed`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
