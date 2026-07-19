'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  intakeConfigForAttribution,
} = require('../../services/webLandingSubmission.service');
const {
  intakeConfigForPublication,
} = require('../../services/webPublicationDeployment.service');
const {
  resolveEffectivePublicIntakeRecords,
} = require('../../services/webEffectiveIntakeConfig.service');
const {
  pickMatchingIntakeConfig,
  authenticatePublicIntakeRequest,
} = require('../../lib/intakePublicAuthentication');
const crypto = require('node:crypto');
const {
  authenticationCandidatesForConfig,
  runtimeConfigPatch,
} = require('../../services/webIntakeRuntimeReconciliation.service');
const {
  encryptRuntimeSecret,
} = require('../../lib/webRuntimeSecretEnvelope');

const SOURCE_HMAC = 'source-group-hmac-0123456789abcdef';
const TARGET_HMAC = 'target-group-hmac-fedcba9876543210';
const TEST_ENV = {
  MARKETING_WEB_RUNTIME_ENVELOPE_KEY: Buffer.alloc(32, 23).toString('base64url'),
  MARKETING_WEB_RUNTIME_ENVELOPE_KEY_ID: 'effective-intake-test-v1',
};

function signedRequest(secret) {
  const rawBody = Buffer.from('{"clinic_id":66}', 'utf8');
  return {
    rawBody,
    headers: {
      'x-cc-signature': crypto.createHmac('sha256', secret).update(rawBody).digest('hex'),
    },
  };
}

function transitionRow({ source, target, status, expiresAt = null }) {
  const row = {
    id: '11111111-1111-4111-8111-111111111111',
    scopeType: 'group',
    scopeId: 7,
    generation: 2,
    status,
    sourceConfigPatch: runtimeConfigPatch(source),
    targetConfigPatch: runtimeConfigPatch(target),
    graceExpiresAt: expiresAt,
  };
  const context = (slot) => ({
    id: row.id,
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    generation: row.generation,
    slot,
  });
  row.sourceHmacEnvelope = encryptRuntimeSecret(source.hmac_key, context('source'), { env: TEST_ENV });
  row.targetHmacEnvelope = encryptRuntimeSecret(target.hmac_key, context('target'), { env: TEST_ENV });
  return row;
}

function fixture() {
  const direct = {
    assignment_scope: 'clinic', clinic_id: 66,
    hmac_key: 'materialized-old-hmac-0123456789',
    config: {
      runtime_inheritance: { schema_version: 1, scope_type: 'group', scope_id: 7 },
      features: { consent_mode_enabled: true, chat_enabled: false },
      campaigns: { mode: 'measure' },
    },
  };
  const group = {
    assignment_scope: 'group', group_id: 7,
    hmac_key: 'current-group-hmac-9876543210',
    config: {
      locations: [{ id: 66 }],
      features: { consent_mode_enabled: true, chat_enabled: true },
    },
  };
  const models = {
    IntakeConfig: {
      async findOne({ where }) {
        return where.assignment_scope === 'clinic' ? direct : group;
      },
    },
    Clinica: { async findByPk() { return { grupoClinicaId: 7 }; } },
  };
  return { direct, group, models };
}

async function resolveBoth(models) {
  return Promise.all([
    intakeConfigForAttribution({
      scope_type: 'clinic', clinic_id: 66, group_id: 7,
    }, { models }),
    intakeConfigForPublication({
      scopeType: 'clinic', clinicaId: 66, grupoClinicaId: null,
    }, { models }),
  ]);
}

test('formularios y deployments dereferencian la materialización al runtime actual del grupo', async () => {
  const { group, models } = fixture();
  let [submissionIntake, deploymentIntake] = await resolveBoth(models);
  assert.equal(submissionIntake, group);
  assert.equal(deploymentIntake, group);
  group.hmac_key = 'later-group-hmac-0123456789abcdef';
  [submissionIntake, deploymentIntake] = await resolveBoth(models);
  assert.equal(submissionIntake.hmac_key, group.hmac_key);
  assert.equal(deploymentIntake.hmac_key, group.hmac_key);
});

test('un marker heredado malformado o cruzado falla cerrado en ambos consumidores', async () => {
  const { direct, models } = fixture();
  direct.config.runtime_inheritance = {
    schema_version: 1, scope_type: 'group', scope_id: 7, unexpected: true,
  };
  assert.deepEqual(await resolveBoth(models), [null, null]);
  direct.config.runtime_inheritance = { schema_version: 1, scope_type: 'group', scope_id: 8 };
  assert.deepEqual(await resolveBoth(models), [null, null]);
});

test('un override clínico explícito sin marker sigue siendo directo', async () => {
  const { direct, models } = fixture();
  delete direct.config.runtime_inheritance;
  const [submissionIntake, deploymentIntake] = await resolveBoth(models);
  assert.equal(submissionIntake, direct);
  assert.equal(deploymentIntake, direct);
});

test('domain-only promueve la clínica heredada y conserva sus campos locales', async () => {
  const { direct, group, models } = fixture();
  direct.domains = ['clinica.example'];
  const resolved = await resolveEffectivePublicIntakeRecords({
    domainCfg: direct,
    models,
  });
  assert.equal(resolved.clinicCfg.clinic_id, 66);
  assert.equal(resolved.clinicCfg.hmac_key, group.hmac_key);
  assert.deepEqual(resolved.clinicCfg.config.campaigns, { mode: 'measure' });
  assert.deepEqual(resolved.clinicCfg.domains, ['clinica.example']);
  assert.equal(resolved.domainCfg, resolved.clinicCfg);
  assert.equal(pickMatchingIntakeConfig({
    req: { rawBody: Buffer.from('{}'), headers: {} },
    clinicCfg: resolved.clinicCfg,
    groupCfg: resolved.groupCfg,
    domainCfg: resolved.domainCfg,
  }), resolved.clinicCfg);
});

test('todos los hints y records públicos deben pertenecer a una identidad única', async () => {
  const { direct, group, models } = fixture();
  const rejects409 = (promise) => assert.rejects(
    promise,
    (error) => error.code === 'web_intake_public_scope_mismatch' && error.status === 409
  );
  await rejects409(resolveEffectivePublicIntakeRecords({
    clinicCfg: direct,
    groupCfg: { ...group, group_id: 8 },
    clinicId: 66,
    groupId: 8,
    models,
  }));
  await rejects409(resolveEffectivePublicIntakeRecords({
    clinicCfg: direct,
    domainCfg: { ...direct, clinic_id: 67 },
    clinicId: 66,
    models,
  }));
  await rejects409(resolveEffectivePublicIntakeRecords({
    clinicCfg: direct,
    domainCfg: { ...group, group_id: 8 },
    clinicId: 66,
    models,
  }));
});

test('clínica A, grupo B y dominio C fallan con 409 antes de considerar firmas', async () => {
  const { direct, group, models } = fixture();
  await assert.rejects(
    resolveEffectivePublicIntakeRecords({
      clinicCfg: direct,
      groupCfg: { ...group, group_id: 8 },
      domainCfg: { ...direct, clinic_id: 67 },
      clinicId: 66,
      groupId: 8,
      models,
    }),
    (error) => error.code === 'web_intake_public_scope_mismatch' && error.status === 409
  );
});

test('la clínica heredada acepta A/B solo durante la transición del grupo y retira A tras grace', async () => {
  const { direct, group, models } = fixture();
  direct.hmac_key = SOURCE_HMAC;
  group.hmac_key = SOURCE_HMAC;
  const target = {
    ...group,
    hmac_key: TARGET_HMAC,
    config: {
      ...group.config,
      features: { ...group.config.features, chat_enabled: false },
    },
  };
  let reconciliation = null;
  models.WebIntakeRuntimeReconciliation = {
    async findOne({ where }) {
      assert.equal(where.scopeType, 'group');
      assert.equal(where.scopeId, 7);
      return reconciliation;
    },
  };

  const authenticate = async (secret, now) => {
    const resolved = await resolveEffectivePublicIntakeRecords({
      clinicCfg: direct,
      groupCfg: group,
      clinicId: 66,
      groupId: 7,
      models,
    });
    const transitionCandidates = await authenticationCandidatesForConfig(resolved.clinicCfg, {
      models,
      now,
      env: TEST_ENV,
    });
    const owner = {
      ...resolved.clinicCfg,
      runtime_transition_candidates: transitionCandidates,
    };
    const req = signedRequest(secret);
    const selected = pickMatchingIntakeConfig({ req, clinicCfg: owner, groupCfg: resolved.groupCfg });
    return authenticatePublicIntakeRequest({ req, config: selected });
  };

  // Pre-transition: only A is the effective credential.
  assert.equal((await authenticate(SOURCE_HMAC, new Date('2026-07-19T00:00:00Z'))).ok, true);
  assert.equal((await authenticate(TARGET_HMAC, new Date('2026-07-19T00:00:00Z'))).status, 401);

  // During deployment: the durable group reconciliation authorizes A and B.
  reconciliation = transitionRow({ source: group, target, status: 'deploying' });
  assert.equal((await authenticate(SOURCE_HMAC, new Date('2026-07-19T00:01:00Z'))).ok, true);
  assert.equal((await authenticate(TARGET_HMAC, new Date('2026-07-19T00:01:00Z'))).ok, true);

  // Promotion makes B current; A remains valid only until grace expires.
  group.hmac_key = TARGET_HMAC;
  group.config = target.config;
  reconciliation.status = 'grace';
  reconciliation.graceExpiresAt = new Date('2026-07-20T00:00:00Z');
  assert.equal((await authenticate(SOURCE_HMAC, new Date('2026-07-19T12:00:00Z'))).ok, true);
  assert.equal((await authenticate(TARGET_HMAC, new Date('2026-07-19T12:00:00Z'))).ok, true);
  assert.equal((await authenticate(SOURCE_HMAC, new Date('2026-07-20T00:00:01Z'))).status, 401);
  assert.equal((await authenticate(TARGET_HMAC, new Date('2026-07-20T00:00:01Z'))).ok, true);
});
